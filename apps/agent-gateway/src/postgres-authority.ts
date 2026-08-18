import { createPublicKey, randomUUID } from 'node:crypto';

import {
  BrokerAckSchema,
  BrokerAuthenticationError,
  BrokerAuthenticationFailureCode,
  BrokerConversationOpenCommandSchema,
  BrokerEnvelopeSchema,
  BrokerHandshakeUnsignedSchema,
  BrokerRegistrationCapabilitiesSchema,
  IsoDateTimeSchema,
  RuntimePolicySchema,
  Sha256DigestSchema,
  UuidSchema,
  brokerHandshakeSigningBytes,
  canonicalSha256,
  verifyP256P1363Signature,
  type BrokerEnvelope,
  type BrokerEvent,
  type BrokerHandshake,
} from '@cb/creator-agent-protocol';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import type {
  AgentGatewayAuthorityPort,
  AuthenticatedWorkerSession,
  GatewayDelivery,
  GatewayDisconnectReason,
} from './gateway.js';

const MAX_UINT63 = 9_223_372_036_854_775_807n;
const P256_UNCOMPRESSED_SPKI_PREFIX = Buffer.from(
  '3059301306072a8648ce3d020106082a8648ce3d030107034200',
  'hex',
);

const RegisteredProtocolVersionsSchema = z.array(z.literal(1)).min(1).max(1);

const GatewayOperationKindSchema = z.enum([
  'ISSUE_CHALLENGE',
  'AUTHENTICATE',
  'AUDIT_CHALLENGE_REPLAY',
  'OPEN_SESSION',
  'ACCEPT_ENVELOPE',
  'SEQUENCE_GAP',
  'CLOSE_SESSION',
  'CLAIM_BROKER_COMMAND',
]);

const ChallengeResultSchema = z.object({ challengeId: UuidSchema }).strict();
const AuthenticatedWorkerSessionSchema = z
  .object({
    ownerId: UuidSchema,
    installationId: UuidSchema,
    connectionId: UuidSchema,
    workerSessionId: UuidSchema,
  })
  .strict();
const AuthenticateOutcomeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('AUTHENTICATED'),
      session: AuthenticatedWorkerSessionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('REJECTED'),
      code: z.literal(BrokerAuthenticationFailureCode.WORKER_INCOMPATIBLE),
    })
    .strict(),
]);
const ChallengeReplayAuditResultSchema = z.object({ recorded: z.literal(true) }).strict();
const OpenSessionResponseBatchSchema = z
  .array(BrokerEnvelopeSchema)
  .max(1)
  .refine(
    (frames) => frames.length === 0 || frames[0]?.type === 'lease.grant',
    'OPEN_SESSION may only return one lease.grant',
  );
const AcceptResponseBatchSchema = z
  .array(BrokerEnvelopeSchema)
  .max(2)
  .superRefine((frames, context) => {
    const types = frames.map((frame) => frame.type).join(',');
    if (
      types !== '' &&
      types !== 'message.ack' &&
      types !== 'lease.revoke' &&
      types !== 'lease.grant,message.ack' &&
      types !== 'message.ack,lease.revoke'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'invalid ACCEPT_ENVELOPE response order',
      });
    }
  });
const AcceptOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('RESPONSES'), responses: AcceptResponseBatchSchema }).strict(),
  z.object({ kind: z.literal('SEQUENCE_CONFLICT') }).strict(),
]);

const CompatibilityPolicySchema = z
  .object({
    acceptedWorkerVersions: z.array(z.string().min(1).max(128)).min(1).max(16),
    acceptedCodexRuntimeArtifacts: z
      .array(z.string().regex(/^sha256:[a-f0-9]{64}$/u))
      .min(1)
      .max(32),
    acceptedCodexProtocolSchemaDigests: z
      .array(z.string().regex(/^sha256:[a-f0-9]{64}$/u))
      .min(1)
      .max(32),
    acceptedIsolationModes: z
      .array(z.enum(['apple-container-v1', 'lima-vz-v1']))
      .min(1)
      .max(16),
    acceptedBrokerContractDigests: z.array(Sha256DigestSchema).min(1).max(32),
    /**
     * Optional rollout fence for the Test-only publisher. A deployment uniquely binds its
     * Creator and Agent, so a non-empty exact allowlist is the narrowest three-level rollout
     * control. Library callers may omit it while the publisher remains disabled; the executable
     * bootstrap requires it whenever publishing is enabled.
     */
    publisherDeploymentAllowlist: z.array(UuidSchema).min(1).max(32).optional(),
    sessionTtlMs: z
      .number()
      .int()
      .min(60_000)
      .max(30 * 60_000)
      .default(15 * 60_000),
    leaseTtlMs: z.number().int().min(10_000).max(60_000).default(30_000),
    responseTtlMs: z.number().int().min(5_000).max(60_000).default(30_000),
    transactionTimeoutMs: z.number().int().min(100).max(10_000).default(2_000),
  })
  .strict()
  .superRefine((policy, context) => {
    const profileCount = policy.acceptedWorkerVersions.length;
    for (const [field, values] of [
      ['acceptedCodexRuntimeArtifacts', policy.acceptedCodexRuntimeArtifacts],
      ['acceptedCodexProtocolSchemaDigests', policy.acceptedCodexProtocolSchemaDigests],
      ['acceptedIsolationModes', policy.acceptedIsolationModes],
    ] as const) {
      if (values.length !== profileCount) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: 'compatibility profile arrays must have equal length',
        });
      }
    }
    if (new Set(policy.acceptedWorkerVersions).size !== profileCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['acceptedWorkerVersions'],
        message: 'compatibility worker versions must be unique profile keys',
      });
    }
    if (
      policy.acceptedBrokerContractDigests.length !== 1 &&
      policy.acceptedBrokerContractDigests.length !== profileCount
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['acceptedBrokerContractDigests'],
        message: 'Broker contract digests must be shared singleton or profile-indexed',
      });
    }
  });

export type GatewayCompatibilityPolicy = z.input<typeof CompatibilityPolicySchema>;

export interface GatewayQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number | null;
}

export interface GatewayTransaction {
  query<Row = Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<GatewayQueryResult<Row>>;
}

export interface GatewayConnection extends GatewayTransaction {
  release(destroy?: boolean): void;
}

export interface GatewayPool {
  connect(): Promise<GatewayConnection>;
}

export interface PostgresGatewayAuthorityPools {
  /** Creator-authenticated challenge issuance only. */
  api: GatewayPool;
  /** Worker authentication, Session, Lease, receipt, and projection transactions. */
  broker: GatewayPool;
}

export type ProjectableWorkerEvent = Exclude<
  BrokerEvent,
  { type: 'heartbeat' | 'lease.accepted' | 'lease.renewed' | 'pong' }
>;

export type GatewayProjectionDecision =
  | 'APPLIED'
  | 'IDEMPOTENT_REPLAY'
  | 'NOOP_TERMINAL'
  | 'RECONCILE'
  | 'SECURITY_BLOCK';

/**
 * Authority for the connection carrying a business event. This is deliberately
 * separate from the original Invocation execution authority embedded in an
 * Invocation fact. A reconnect may replace every field below while the fact's
 * original Lease/Fence remains immutable.
 */
export interface GatewayCurrentTransportAuthority {
  creatorId: string;
  installationId: string;
  workerSessionId: string;
  connectionId: string;
  deploymentId: string;
  leaseId: string;
  fence: string;
}

/**
 * Business event projection is an explicit port. It executes inside the same PostgreSQL
 * transaction as sequence advancement and the CLOUD_COMMITTED ACK. A missing projector
 * rejects business events; the Gateway never stores raw frames or pretends an event committed.
 * The Gateway verifies `transport` and only routes an Invocation event when the durable
 * Invocation belongs to the same Creator, Deployment, and Installation. The projector must
 * still validate the event body's original Lease/Fence, capability, Version, Snapshot, and
 * fact digest against Cloud authority before it mutates a business projection.
 */
export interface GatewayBusinessEventProjector {
  project(input: {
    transaction: GatewayTransaction;
    session: AuthenticatedWorkerSession;
    transport: GatewayCurrentTransportAuthority;
    event: ProjectableWorkerEvent;
    signal: AbortSignal;
  }): Promise<GatewayProjectionDecision>;
}

export type GatewayAuthorityStep =
  | 'CHALLENGE_ISSUED'
  | 'CHALLENGE_LOCKED'
  | 'SIGNATURE_VERIFIED'
  | 'SESSION_INSERTED'
  | 'LEASE_INSERTED'
  | 'EVENT_PROJECTED'
  | 'BROKER_COMMAND_CLAIMED'
  | 'RECEIPT_INSERTED'
  | 'BEFORE_COMMIT';

export type GatewayAuthorityFailureInjector = (step: GatewayAuthorityStep) => void | Promise<void>;

export class PostgresGatewayAuthorityError extends Error {
  constructor(
    readonly code:
      | 'SESSION_UNAVAILABLE'
      | 'LEASE_UNAVAILABLE'
      | 'SEQUENCE_CONFLICT'
      | 'REPLAY_NOT_FOUND'
      | 'OUTBOUND_ACK_CONFLICT'
      | 'DIRECTION_INVALID'
      | 'MESSAGE_EXPIRED'
      | 'BUSINESS_PROJECTOR_UNAVAILABLE'
      | 'OPERATION_CONFLICT'
      | 'COMMIT_NOT_APPLIED'
      | 'COMMIT_OUTCOME_UNKNOWN'
      | 'PERSISTENCE_INVARIANT_FAILED',
    readonly operationKey?: string,
  ) {
    super(code);
    this.name = 'PostgresGatewayAuthorityError';
  }
}

class NoBrokerCommandAvailable extends Error {
  public constructor() {
    super('NO_BROKER_COMMAND_AVAILABLE');
    this.name = 'NoBrokerCommandAvailable';
  }
}

interface InstallationRegistrationRow {
  worker_version: string;
  protocol_versions: unknown;
  capabilities: unknown;
  revoked_at: Date | string | null;
}

interface ChallengeInstallationRow extends InstallationRegistrationRow {
  creator_id: string;
  device_public_key: Buffer;
  deployment_id: string;
  deployment_generation: string | number | bigint;
  desired_state: string;
  observed_state: string;
  observed_worker_id: string | null;
  desired_version_id: string;
  codex_runtime_artifact_digest: string;
  codex_protocol_schema_digest: string;
  runtime_policy: unknown;
}

interface SessionRow {
  id: string;
  creator_id: string;
  installation_id: string;
  challenge_id: string;
  connection_id: string;
  registration_digest: string;
  state: string;
  inbound_next_seq: string | number | bigint;
  outbound_next_seq: string | number | bigint;
  expires_at: Date | string;
  alive: boolean;
}

interface DeploymentRow extends InstallationRegistrationRow {
  id: string;
  generation: string | number | bigint;
  lease_fence: string | number | bigint;
}

interface LeaseRow {
  id: string;
  deployment_id: string;
  fence: string | number | bigint;
  expires_at: Date | string;
}

interface ReceiptRow {
  sequence: string | number | bigint;
  message_id: string;
  canonical_digest: string;
  response_frames: unknown;
}

interface OperationReceiptRow {
  operation_kind: string;
  request_digest: string;
  result_value: unknown;
  result_digest: string;
}

interface BrokerCommandCandidateRow {
  command_id: string;
  deployment_id: string;
}

interface BrokerPublisherCurrentAuthorityRow extends InstallationRegistrationRow {
  registration_digest: string;
  outbound_next_seq: string | number | bigint;
  session_expires_at: Date | string;
  lease_id: string;
  lease_fence: string | number | bigint;
  lease_expires_at: Date | string;
}

interface BrokerConversationOpenRow {
  command_id: string;
  conversation_id: string;
  agent_version_id: string;
  agent_version_digest: string;
  snapshot_digest: string;
  visible_transcript_digest: string;
  original_worker_session_id: string;
  assignment_lease_id: string;
  assignment_fence: string | number | bigint;
  wire_sent_at: Date | string;
  wire_expires_at: Date | string;
}

interface ExistingBrokerDeliveryRow {
  sequence: string | number | bigint;
  canonical_digest: string;
  durable_ack_level: string | null;
  wire_sent_at: Date | string;
  wire_expires_at: Date | string;
  wire_retryable: boolean;
}

interface BrokerPersistedAckReceiptRow {
  committed_at: Date | string;
}

type GatewayOperationKind = z.infer<typeof GatewayOperationKindSchema>;

interface GatewayOperation<T> {
  readonly operationKey: string;
  readonly kind: GatewayOperationKind;
  readonly requestDigest: string;
  readonly allowCommittedReplay: boolean;
  readonly encode: (value: T) => unknown;
  readonly decode: (value: unknown) => T;
}

interface SessionLeaseRow extends SessionRow, InstallationRegistrationRow {
  lease_id: string;
  deployment_id: string;
  lease_fence: string | number | bigint;
  lease_state: string;
  lease_alive: boolean;
  lease_expires_at: Date | string;
  deployment_fence: string | number | bigint;
  observed_worker_id: string | null;
  desired_state: string;
  desired_version_id: string;
  serving_version_id: string | null;
  deployment_generation: string | number | bigint;
  observed_generation: string | number | bigint | null;
  observed_state: string;
  desired_version_availability: string | null;
  desired_version_severity: string | null;
  desired_version_reason_code: string | null;
  serving_version_availability: string | null;
  serving_version_severity: string | null;
  serving_version_reason_code: string | null;
  pinned_invocation_id: string | null;
  pinned_version_availability: string | null;
  pinned_version_severity: string | null;
  pinned_version_reason_code: string | null;
  active_pinned_version_blocked: boolean;
}

type SessionLeaseDatabaseRow = Omit<SessionLeaseRow, 'active_pinned_version_blocked'>;

type LeaseRevokeReason =
  | 'SESSION_REPLACED'
  | 'DRAIN'
  | 'IMMEDIATE'
  | 'SECURITY'
  | 'INSTALLATION_REVOKED';

type ProjectionOutcome = Readonly<{
  decision: GatewayProjectionDecision;
  revokeReason?: LeaseRevokeReason;
  renewedLeaseExpiresAt?: string;
}>;

type AcceptOutcome =
  | Readonly<{ kind: 'RESPONSES'; responses: readonly BrokerEnvelope[] }>
  | Readonly<{ kind: 'SEQUENCE_CONFLICT' }>;

type AuthenticateOutcome =
  | Readonly<{ kind: 'AUTHENTICATED'; session: AuthenticatedWorkerSession }>
  | Readonly<{
      kind: 'REJECTED';
      code: typeof BrokerAuthenticationFailureCode.WORKER_INCOMPATIBLE;
    }>;

export type WorkerCompatibilityErrorCode =
  | 'WORKER_REGISTRATION_INCOMPATIBLE'
  | 'WORKER_VERSION_INCOMPATIBLE'
  | 'PROTOCOL_INCOMPATIBLE'
  | 'CODEX_RUNTIME_INCOMPATIBLE'
  | 'CODEX_PROTOCOL_INCOMPATIBLE'
  | 'ISOLATION_INCOMPATIBLE'
  | 'BROKER_CONTRACT_INCOMPATIBLE';

export type GatewayWorkerCompatibilityRegistration = {
  workerVersion: string;
  protocolVersions: unknown;
  capabilities: unknown;
  codexRuntimeArtifactDigest: string;
  codexProtocolSchemaDigest: string;
  runtimePolicy: unknown;
};

type ParsedGatewayCompatibilityPolicy = z.output<typeof CompatibilityPolicySchema>;

type ExactGatewayWorkerProfile = Readonly<{
  workerVersion: string;
  protocolVersion: 1;
  codexRuntimeArtifact: string;
  codexProtocolSchemaDigest: string;
  isolationMode: 'apple-container-v1' | 'lima-vz-v1';
  brokerContractDigest: string;
}>;

export type GatewayWorkerCompatibilityAdmission<T> =
  | Readonly<{ kind: 'ADMITTED'; value: T }>
  | Readonly<{ kind: 'BLOCKED'; reason: WorkerCompatibilityErrorCode }>;

/**
 * G0 exact-profile admission. The only callback is the compatible branch; there is deliberately
 * no Native/fallback callback. This does not assert Runtime, Snapshot, Host, or Deployment ready.
 */
export function admitGatewayWorkerCompatibility<T>(
  policy: GatewayCompatibilityPolicy,
  handshake: BrokerHandshake,
  registration: GatewayWorkerCompatibilityRegistration,
  onAdmitted: () => T,
): GatewayWorkerCompatibilityAdmission<T> {
  const reason = matchGatewayWorkerCompatibility(
    CompatibilityPolicySchema.parse(policy),
    handshake,
    registration,
  );
  return reason === undefined
    ? { kind: 'ADMITTED', value: onAdmitted() }
    : { kind: 'BLOCKED', reason };
}

export class PostgresAgentGatewayAuthority implements AgentGatewayAuthorityPort {
  readonly #policy: z.output<typeof CompatibilityPolicySchema>;

  constructor(
    readonly pools: PostgresGatewayAuthorityPools,
    policy: GatewayCompatibilityPolicy,
    readonly projector?: GatewayBusinessEventProjector,
    readonly failureInjector?: GatewayAuthorityFailureInjector,
  ) {
    this.#policy = CompatibilityPolicySchema.parse(policy);
  }

  async issueChallenge(input: {
    creatorId: string;
    installationId: string;
    deploymentId: string;
    deploymentGeneration: string;
    operationId: string;
    ttlSeconds?: number;
    signal: AbortSignal;
  }): Promise<{ challengeId: string }> {
    const creatorId = UuidSchema.parse(input.creatorId);
    const installationId = UuidSchema.parse(input.installationId);
    const deploymentId = UuidSchema.parse(input.deploymentId);
    const deploymentGeneration = parseUint63(input.deploymentGeneration);
    const operationId = UuidSchema.parse(input.operationId);
    const ttlSeconds = input.ttlSeconds ?? 60;
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 10 || ttlSeconds > 120) {
      throw new TypeError('INVALID_CHALLENGE_TTL');
    }
    const operation = gatewayOperation<{ challengeId: string }>(
      'ISSUE_CHALLENGE',
      { creatorId, installationId, deploymentId, deploymentGeneration, ttlSeconds },
      ChallengeResultSchema,
      operationId,
    );
    return withGatewayTransaction(
      this.pools.api,
      {
        creatorId,
        signal: input.signal,
        timeoutMs: this.#policy.transactionTimeoutMs,
        operation,
        beforeCommit: () => this.#inject('BEFORE_COMMIT'),
      },
      async (transaction) => {
        const issued = await transaction.query<{ challenge_id: string }>(
          `SELECT creator_agent_issue_worker_challenge(
             $1::uuid, $2::uuid, $3::bigint, $4::integer
           )::text AS challenge_id`,
          [installationId, deploymentId, deploymentGeneration, ttlSeconds],
          input.signal,
        );
        const challengeId = UuidSchema.parse(issued.rows[0]?.challenge_id);
        await this.#inject('CHALLENGE_ISSUED');
        return { challengeId };
      },
    );
  }

  async authenticate(input: {
    handshake: BrokerHandshake;
    connectedAt: string;
    signal: AbortSignal;
  }): Promise<AuthenticatedWorkerSession> {
    const handshake = input.handshake;
    IsoDateTimeSchema.parse(input.connectedAt);
    const operation = gatewayOperation<AuthenticateOutcome>(
      'AUTHENTICATE',
      { handshake, connectedAt: input.connectedAt },
      AuthenticateOutcomeSchema,
      handshake.challengeId,
      false,
    );
    let outcome: AuthenticateOutcome;
    try {
      outcome = await withGatewayTransaction(
        this.pools.broker,
        {
          signal: input.signal,
          timeoutMs: this.#policy.transactionTimeoutMs,
          operation,
          beforeCommit: () => this.#inject('BEFORE_COMMIT'),
        },
        async (transaction, setCreator) => {
          const locked = await transaction.query<{ creator_id: string | null }>(
            `SELECT creator_agent_lock_worker_challenge($1::uuid, $2::uuid)::text AS creator_id`,
            [handshake.challengeId, handshake.installationId],
            input.signal,
          );
          const rawCreatorId = locked.rows[0]?.creator_id;
          if (rawCreatorId == null) {
            throw new BrokerAuthenticationError(
              BrokerAuthenticationFailureCode.AUTHENTICATION_REJECTED,
            );
          }
          const creatorId = UuidSchema.parse(rawCreatorId);
          await setCreator(creatorId);
          await this.#inject('CHALLENGE_LOCKED');

          const installationResult = await transaction.query<ChallengeInstallationRow>(
            `SELECT installation.creator_id::text, installation.worker_version,
                    installation.protocol_versions, installation.capabilities,
                    installation.device_public_key, installation.revoked_at,
                    challenge.deployment_id::text, challenge.deployment_generation,
                    deployment.desired_state, deployment.observed_state,
                    deployment.observed_worker_id::text,
                    deployment.desired_version_id::text,
                    version.codex_runtime_artifact_digest,
                    version.codex_protocol_schema_digest, version.runtime_policy
               FROM worker_auth_challenges AS challenge
               JOIN worker_installations AS installation
                 ON installation.id = challenge.installation_id
                AND installation.creator_id = challenge.creator_id
               JOIN deployments AS deployment
                 ON deployment.id = challenge.deployment_id
                AND deployment.creator_id = challenge.creator_id
                AND deployment.generation = challenge.deployment_generation
               JOIN agent_versions AS version
                 ON version.id = deployment.desired_version_id
                AND version.creator_id = deployment.creator_id
              WHERE challenge.id = $1
                AND challenge.installation_id = $2
                AND challenge.creator_id = $3
                AND challenge.state = 'ISSUED'
                AND challenge.expires_at > statement_timestamp()
              FOR UPDATE OF challenge, installation, deployment`,
            [handshake.challengeId, handshake.installationId, creatorId],
            input.signal,
          );
          const installation = installationResult.rows[0];
          if (installation === undefined) {
            throw new BrokerAuthenticationError(
              BrokerAuthenticationFailureCode.AUTHENTICATION_REJECTED,
            );
          }
          if (installation.revoked_at !== null) {
            throw new BrokerAuthenticationError(
              BrokerAuthenticationFailureCode.INSTALLATION_REVOKED,
            );
          }

          // A remote peer must prove possession of the registered device key before
          // it can cause any durable compatibility/BLOCKED state transition.
          const publicKey = p256PublicKeyFromUncompressedPoint(installation.device_public_key);
          const { challengeSignature: _signature, ...unsignedInput } = handshake;
          const unsigned = BrokerHandshakeUnsignedSchema.parse(unsignedInput);
          if (
            !verifyP256P1363Signature(
              brokerHandshakeSigningBytes(unsigned),
              handshake.challengeSignature,
              publicKey,
            )
          ) {
            throw new BrokerAuthenticationError(
              BrokerAuthenticationFailureCode.AUTHENTICATION_REJECTED,
            );
          }
          await this.#inject('SIGNATURE_VERIFIED');

          const consumed = await transaction.query(
            `UPDATE worker_auth_challenges
                SET state = 'CONSUMED', consumed_at = statement_timestamp()
              WHERE id = $1 AND installation_id = $2 AND creator_id = $3
                AND deployment_id = $4 AND deployment_generation = $5
                AND state = 'ISSUED'`,
            [
              handshake.challengeId,
              handshake.installationId,
              creatorId,
              installation.deployment_id,
              parseUint63(installation.deployment_generation),
            ],
            input.signal,
          );
          if (consumed.rowCount !== 1) {
            throw new BrokerAuthenticationError(
              BrokerAuthenticationFailureCode.AUTHENTICATION_REJECTED,
            );
          }

          const compatibilityError = this.#compatibilityError(handshake, installation);
          if (compatibilityError !== undefined) {
            await this.#blockIncompatibleDeployment(
              transaction,
              creatorId,
              handshake,
              installation,
              compatibilityError,
              input.signal,
            );
            return {
              kind: 'REJECTED',
              code: BrokerAuthenticationFailureCode.WORKER_INCOMPATIBLE,
            };
          }

          const replaced = await transaction.query<{ connection_id: string }>(
            `UPDATE worker_gateway_sessions
                SET state = 'REPLACED', closed_at = statement_timestamp(),
                    disconnect_reason = 'SESSION_REPLACED'
              WHERE creator_id = $1 AND installation_id = $2 AND state = 'ACTIVE'
            RETURNING connection_id::text`,
            [creatorId, handshake.installationId],
            input.signal,
          );
          const replacedConnections = replaced.rows.map((row) =>
            UuidSchema.parse(row.connection_id),
          );
          if (replacedConnections.length > 0) {
            const replacement = await transaction.query<{
              revoked_count: string;
              degraded_count: string;
            }>(
              `WITH revoked AS (
                 UPDATE worker_leases
                    SET state = 'REVOKED'
                  WHERE creator_id = $1 AND worker_id = $2 AND state = 'ACTIVE'
                    AND connection_id = ANY($3::uuid[])
                RETURNING deployment_id, creator_id, worker_id, fence
               ), degraded AS (
               UPDATE deployments AS deployment
                  SET observed_state = 'DEGRADED',
                      last_error_code = 'SESSION_REPLACED',
                      updated_at = statement_timestamp()
                 FROM revoked
                WHERE deployment.id = revoked.deployment_id
                  AND deployment.creator_id = revoked.creator_id
                  AND deployment.observed_worker_id = revoked.worker_id
                  AND deployment.lease_fence = revoked.fence
                RETURNING deployment.id
               )
               SELECT (SELECT count(*)::text FROM revoked) AS revoked_count,
                      (SELECT count(*)::text FROM degraded) AS degraded_count`,
              [creatorId, handshake.installationId, replacedConnections],
              input.signal,
            );
            const counts = replacement.rows[0];
            if (
              counts === undefined ||
              parseUint63(counts.revoked_count) !== parseUint63(counts.degraded_count)
            ) {
              throw persistenceFailure();
            }
          }

          const inserted = await transaction.query<{
            id: string;
            connection_id: string;
          }>(
            `INSERT INTO worker_gateway_sessions (
               creator_id, installation_id, challenge_id, registration_digest, expires_at
             ) VALUES (
               $1, $2, $3, $4,
               statement_timestamp() + ($5::bigint * interval '1 millisecond')
             )
             RETURNING id::text, connection_id::text`,
            [
              creatorId,
              handshake.installationId,
              handshake.challengeId,
              registrationDigest(installation),
              this.#policy.sessionTtlMs,
            ],
            input.signal,
          );
          const session = inserted.rows[0];
          if (session === undefined) throw persistenceFailure();
          const context = Object.freeze({
            ownerId: creatorId,
            installationId: handshake.installationId,
            connectionId: UuidSchema.parse(session.connection_id),
            workerSessionId: UuidSchema.parse(session.id),
          });
          await this.#inject('SESSION_INSERTED');
          return { kind: 'AUTHENTICATED', session: context };
        },
      );
    } catch (error) {
      if (
        error instanceof BrokerAuthenticationError &&
        error.code === BrokerAuthenticationFailureCode.AUTHENTICATION_REJECTED
      ) {
        // A valid replay is a durable security fact. If its bounded audit
        // transaction cannot commit, surface that authority failure rather than
        // returning a false assurance that the replay was recorded.
        await this.#auditConsumedChallengeReplay(handshake);
      }
      throw error;
    }
    if (outcome.kind === 'REJECTED') {
      throw new BrokerAuthenticationError(outcome.code);
    }
    return outcome.session;
  }

  async openSession(
    session: AuthenticatedWorkerSession,
    signal: AbortSignal,
  ): Promise<readonly BrokerEnvelope[]> {
    const parsedSession = parseSession(session);
    const operation = gatewayOperation<readonly BrokerEnvelope[]>(
      'OPEN_SESSION',
      parsedSession,
      OpenSessionResponseBatchSchema,
      parsedSession.workerSessionId,
    );
    return withGatewayTransaction(
      this.pools.broker,
      {
        creatorId: parsedSession.ownerId,
        signal,
        timeoutMs: this.#policy.transactionTimeoutMs,
        operation,
        beforeCommit: () => this.#inject('BEFORE_COMMIT'),
      },
      async (transaction) => {
        // Resolve the immutable Session -> Challenge -> Deployment binding before
        // locking the Session. SECURITY version revocation acquires the same
        // per-Deployment advisory key before it fences Sessions and Leases. Taking
        // that key first avoids a session-row/advisory deadlock and prevents a
        // concurrent openSession from publishing a Lease after the revoker's
        // affected-Lease scan has already completed.
        const deploymentAuthority = await transaction.query<{ deployment_id: string }>(
          `SELECT challenge.deployment_id::text
             FROM worker_gateway_sessions AS gateway
             JOIN worker_auth_challenges AS challenge
               ON challenge.id = gateway.challenge_id
              AND challenge.creator_id = gateway.creator_id
              AND challenge.installation_id = gateway.installation_id
            WHERE gateway.id = $1 AND gateway.creator_id = $2
              AND gateway.installation_id = $3 AND gateway.connection_id = $4`,
          [
            parsedSession.workerSessionId,
            parsedSession.ownerId,
            parsedSession.installationId,
            parsedSession.connectionId,
          ],
          signal,
        );
        const deploymentId = deploymentAuthority.rows[0]?.deployment_id;
        if (deploymentId === undefined) {
          throw new PostgresGatewayAuthorityError('SESSION_UNAVAILABLE');
        }
        const parsedDeploymentId = UuidSchema.parse(deploymentId);
        await transaction.query(
          `SELECT pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text, 0))`,
          [`combo.gateway.deployment/v1:${parsedSession.ownerId}:${parsedDeploymentId}`],
          signal,
        );
        const current = await lockSession(transaction, parsedSession, signal);
        const deploymentResult = await transaction.query<DeploymentRow>(
          `SELECT deployment.id::text, deployment.generation, deployment.lease_fence,
                  installation.worker_version, installation.protocol_versions,
                  installation.capabilities, installation.revoked_at
             FROM worker_auth_challenges AS challenge
             JOIN deployments AS deployment
               ON deployment.id = challenge.deployment_id
              AND deployment.creator_id = challenge.creator_id
              AND deployment.generation = challenge.deployment_generation
             JOIN agent_versions AS version
               ON version.id = deployment.desired_version_id
              AND version.creator_id = deployment.creator_id
             JOIN agent_version_controls AS version_control
               ON version_control.version_id = version.id
              AND version_control.creator_id = version.creator_id
             JOIN worker_installations AS installation
               ON installation.id = $2
              AND installation.creator_id = deployment.creator_id
            WHERE challenge.id = $3 AND challenge.creator_id = $1
              AND challenge.installation_id = $2
              AND deployment.id = $4
              AND deployment.desired_state = 'ONLINE'
              AND deployment.observed_state <> 'BLOCKED'
              AND version_control.availability = 'ACTIVE'
              AND installation.revoked_at IS NULL
              AND NOT EXISTS (
                SELECT 1
                  FROM worker_leases AS active_lease
                 WHERE active_lease.deployment_id = deployment.id
                   AND active_lease.creator_id = deployment.creator_id
                   AND active_lease.state = 'ACTIVE'
                   AND active_lease.expires_at > statement_timestamp()
              )
            FOR UPDATE OF deployment, installation`,
          [
            parsedSession.ownerId,
            parsedSession.installationId,
            current.challenge_id,
            parsedDeploymentId,
          ],
          signal,
        );
        const deployment = deploymentResult.rows[0];
        if (deployment === undefined) {
          throw new PostgresGatewayAuthorityError('LEASE_UNAVAILABLE');
        }
        if (registrationDigest(deployment) !== current.registration_digest) {
          throw new PostgresGatewayAuthorityError('SESSION_UNAVAILABLE');
        }

        await transaction.query(
          `UPDATE worker_leases
              SET state = 'REVOKED'
            WHERE creator_id = $1 AND deployment_id = $2 AND state = 'ACTIVE'`,
          [parsedSession.ownerId, deployment.id],
          signal,
        );
        const advanced = await transaction.query<DeploymentRow>(
          `UPDATE deployments
              SET lease_fence = lease_fence + 1,
                  observed_state = 'PREPARING',
                  observed_worker_id = $3,
                  observed_generation = generation,
                  last_error_code = NULL,
                  updated_at = statement_timestamp()
            WHERE id = $1 AND creator_id = $2
              AND lease_fence < 9223372036854775807
          RETURNING id::text, generation, lease_fence`,
          [deployment.id, parsedSession.ownerId, parsedSession.installationId],
          signal,
        );
        const nextDeployment = advanced.rows[0];
        if (nextDeployment === undefined) throw persistenceFailure();
        const leaseResult = await transaction.query<LeaseRow>(
          `INSERT INTO worker_leases (
             deployment_id, creator_id, worker_id, connection_id, fence, expires_at
           ) VALUES (
             $1, $2, $3, $4, $5,
             statement_timestamp() + ($6::bigint * interval '1 millisecond')
           )
           RETURNING id::text, deployment_id::text, fence, expires_at`,
          [
            nextDeployment.id,
            parsedSession.ownerId,
            parsedSession.installationId,
            parsedSession.connectionId,
            parseUint63(nextDeployment.lease_fence),
            this.#policy.leaseTtlMs,
          ],
          signal,
        );
        const lease = leaseResult.rows[0];
        if (lease === undefined) throw persistenceFailure();
        await this.#inject('LEASE_INSERTED');

        const identity = await nextEnvelopeIdentity(transaction, signal);
        const envelope = BrokerEnvelopeSchema.parse({
          protocol: 'combo.creator-broker/1',
          schemaVersion: 1,
          kind: 'command',
          type: 'lease.grant',
          messageId: identity.messageId,
          correlationId: nextDeployment.id,
          connectionId: parsedSession.connectionId,
          sequence: parseUint63(current.outbound_next_seq),
          sentAt: identity.sentAt,
          expiresAt: isoDate(lease.expires_at),
          lease: {
            deploymentId: nextDeployment.id,
            leaseId: UuidSchema.parse(lease.id),
            workerSessionId: parsedSession.workerSessionId,
            fence: parseUint63(lease.fence),
          },
          body: {
            leaseExpiresAt: isoDate(lease.expires_at),
            workerSessionId: parsedSession.workerSessionId,
            generation: parseUint63(nextDeployment.generation),
          },
        });
        await persistOutbound(transaction, parsedSession, envelope, signal);
        await advanceOutbound(transaction, parsedSession, current.outbound_next_seq, signal);
        return [envelope];
      },
    );
  }

  async claimBrokerCommand(
    session: AuthenticatedWorkerSession,
    signal: AbortSignal,
  ): Promise<BrokerEnvelope | undefined> {
    const parsedSession = parseSession(session);
    const candidate = await findNextBrokerCommandCandidate(
      this.pools.broker,
      parsedSession,
      this.#policy.transactionTimeoutMs,
      signal,
    );
    if (candidate === undefined) return undefined;
    if (
      this.#policy.publisherDeploymentAllowlist !== undefined &&
      !this.#policy.publisherDeploymentAllowlist.includes(candidate.deployment_id)
    ) {
      return undefined;
    }

    const operation = gatewayOperation<BrokerEnvelope>(
      'CLAIM_BROKER_COMMAND',
      { session: parsedSession, candidate },
      BrokerConversationOpenCommandSchema,
      `${parsedSession.workerSessionId}:${candidate.command_id}:${randomUUID()}`,
    );
    try {
      return await withGatewayTransaction(
        this.pools.broker,
        {
          creatorId: parsedSession.ownerId,
          signal,
          timeoutMs: this.#policy.transactionTimeoutMs,
          operation,
          beforeCommit: () => this.#inject('BEFORE_COMMIT'),
        },
        async (transaction) => {
          // Reuse the durable per-Session serialization domain used by inbound accepts. This
          // keeps response frames and publisher frames on one outbound sequence without taking a
          // Session row before the Deployment security advisory.
          await transaction.query(
            `SELECT pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text, 0))`,
            [`combo.gateway.accept/v1:${parsedSession.workerSessionId}`],
            signal,
          );
          // Alpha permits one live Creator command across every Deployment/Installation. This
          // advisory serializes otherwise independent Deployment publishers before either takes
          // current authority or Outbox row locks.
          await transaction.query(
            `SELECT pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text, 0))`,
            [`combo.gateway.publisher-wip/v1:${parsedSession.ownerId}`],
            signal,
          );
          await transaction.query(
            `SELECT pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text, 0))`,
            [`combo.gateway.deployment/v1:${parsedSession.ownerId}:${candidate.deployment_id}`],
            signal,
          );
          const current = await lockPublisherCurrentAuthority(
            transaction,
            parsedSession,
            candidate.deployment_id,
            signal,
          );
          const command = await lockConversationOpenCommand(
            transaction,
            parsedSession,
            candidate,
            current,
            signal,
          );
          const existing = await lockExistingBrokerDelivery(
            transaction,
            parsedSession,
            command.command_id,
            signal,
          );
          if (
            existing?.durable_ack_level === 'PERSISTED' ||
            existing?.durable_ack_level === 'CLOUD_COMMITTED'
          ) {
            throw new NoBrokerCommandAvailable();
          }
          const persistedAck =
            existing === undefined
              ? await findCurrentBrokerPersistedAckReceipt(
                  transaction,
                  parsedSession,
                  command.command_id,
                  signal,
                )
              : undefined;

          const sequence =
            existing === undefined
              ? parseUint63(current.outbound_next_seq)
              : parseUint63(existing.sequence);
          const sentAt = isoDate(existing?.wire_sent_at ?? command.wire_sent_at);
          const expiresAt = isoDate(existing?.wire_expires_at ?? command.wire_expires_at);
          // PostgreSQL is the Lease/command clock authority. A retry may use only an exact wire
          // expiry that PostgreSQL still considers live; Gateway host clock skew cannot extend or
          // prematurely suppress a durable delivery.
          if (existing?.wire_retryable === false) throw new NoBrokerCommandAvailable();
          const envelope = materializeConversationOpenEnvelope({
            session: parsedSession,
            deploymentId: candidate.deployment_id,
            current,
            command,
            sequence,
            sentAt,
            expiresAt,
          });
          const canonicalDigest = canonicalSha256(envelope);
          if (existing !== undefined && existing.canonical_digest !== canonicalDigest) {
            throw persistenceFailure();
          }

          if (existing === undefined) {
            await persistBrokerConversationOpen(
              transaction,
              parsedSession,
              current,
              command,
              envelope,
              canonicalDigest,
              persistedAck,
              signal,
            );
            await advanceOutbound(transaction, parsedSession, current.outbound_next_seq, signal);
          }
          const attempted = await transaction.query(
            `UPDATE broker_outbox
                SET state = 'SENT', attempt_count = attempt_count + 1,
                    next_attempt_at = LEAST(
                      expires_at,
                      transaction_timestamp() + interval '1 second'
                    )
              WHERE command_id = $1 AND creator_id = $2
                AND state IN ('PENDING', 'SENT')
                AND attempt_count < 100
                AND next_attempt_at <= transaction_timestamp()
                AND expires_at > clock_timestamp()`,
            [command.command_id, parsedSession.ownerId],
            signal,
          );
          if (attempted.rowCount !== 1) throw new NoBrokerCommandAvailable();
          await this.#inject('BROKER_COMMAND_CLAIMED');
          return envelope;
        },
      );
    } catch (error) {
      if (error instanceof NoBrokerCommandAvailable) return undefined;
      throw error;
    }
  }

  async acceptEnvelope(
    session: AuthenticatedWorkerSession,
    delivery: GatewayDelivery,
    signal: AbortSignal,
  ): Promise<readonly BrokerEnvelope[]> {
    return this.#accept(session, delivery, signal, false);
  }

  async replayEnvelope(
    session: AuthenticatedWorkerSession,
    delivery: GatewayDelivery,
    signal: AbortSignal,
  ): Promise<readonly BrokerEnvelope[]> {
    return this.#accept(session, delivery, signal, true);
  }

  async sequenceGap(
    session: AuthenticatedWorkerSession,
    input: { expected: string; received: string },
    signal: AbortSignal,
  ): Promise<void> {
    const parsedSession = parseSession(session);
    const expected = parseUint63(input.expected);
    const received = parseUint63(input.received);
    const operation = voidGatewayOperation(
      'SEQUENCE_GAP',
      {
        session: parsedSession,
        expected,
        received,
      },
      `${parsedSession.workerSessionId}:${expected}:${received}`,
    );
    await withGatewayTransaction(
      this.pools.broker,
      {
        creatorId: parsedSession.ownerId,
        signal,
        timeoutMs: this.#policy.transactionTimeoutMs,
        operation,
        beforeCommit: () => this.#inject('BEFORE_COMMIT'),
      },
      async (transaction) => {
        await lockSession(transaction, parsedSession, signal);
        const inserted = await transaction.query(
          `INSERT INTO worker_gateway_sequence_gaps (
             session_id, creator_id, expected_seq, received_seq
           ) VALUES ($1, $2, $3, $4)`,
          [parsedSession.workerSessionId, parsedSession.ownerId, expected, received],
          signal,
        );
        if (inserted.rowCount !== 1) throw persistenceFailure();
      },
    );
  }

  async closeSession(
    session: AuthenticatedWorkerSession,
    reason: GatewayDisconnectReason,
  ): Promise<void> {
    const parsedSession = parseSession(session);
    const signal = AbortSignal.timeout(this.#policy.transactionTimeoutMs);
    const operation = voidGatewayOperation(
      'CLOSE_SESSION',
      { session: parsedSession, reason },
      `${parsedSession.workerSessionId}:${reason}`,
    );
    await withGatewayTransaction(
      this.pools.broker,
      {
        creatorId: parsedSession.ownerId,
        signal,
        timeoutMs: this.#policy.transactionTimeoutMs,
        operation,
        beforeCommit: () => this.#inject('BEFORE_COMMIT'),
      },
      async (transaction) => {
        const terminal = reason === 'SESSION_REPLACED' ? 'REPLACED' : 'CLOSED';
        await transaction.query(
          `UPDATE worker_gateway_sessions
              SET state = $5, closed_at = statement_timestamp(), disconnect_reason = $6
            WHERE id = $1 AND creator_id = $2 AND installation_id = $3
              AND connection_id = $4 AND state = 'ACTIVE'`,
          [
            parsedSession.workerSessionId,
            parsedSession.ownerId,
            parsedSession.installationId,
            parsedSession.connectionId,
            terminal,
            reason,
          ],
          signal,
        );
        const revoked = await transaction.query<{
          deployment_id: string;
          fence: string | number | bigint;
        }>(
          `UPDATE worker_leases
              SET state = 'REVOKED'
            WHERE creator_id = $1 AND worker_id = $2 AND connection_id = $3
              AND state = 'ACTIVE'
          RETURNING deployment_id::text, fence`,
          [parsedSession.ownerId, parsedSession.installationId, parsedSession.connectionId],
          signal,
        );
        for (const lease of revoked.rows) {
          const degraded = await transaction.query(
            `UPDATE deployments
                SET observed_state = 'DEGRADED', last_error_code = $4,
                    updated_at = statement_timestamp()
              WHERE id = $1 AND creator_id = $2 AND lease_fence = $3
                AND observed_worker_id = $5`,
            [
              lease.deployment_id,
              parsedSession.ownerId,
              parseUint63(lease.fence),
              reason,
              parsedSession.installationId,
            ],
            signal,
          );
          if (degraded.rowCount !== 1) throw persistenceFailure();
        }
      },
    );
  }

  async #accept(
    rawSession: AuthenticatedWorkerSession,
    rawDelivery: GatewayDelivery,
    signal: AbortSignal,
    replayOnly: boolean,
  ): Promise<readonly BrokerEnvelope[]> {
    const session = parseSession(rawSession);
    const envelope = BrokerEnvelopeSchema.parse(rawDelivery.envelope);
    if (envelope.kind === 'command') {
      throw new PostgresGatewayAuthorityError('DIRECTION_INVALID');
    }
    const digest = canonicalSha256(envelope);
    if (digest !== rawDelivery.canonicalDigest) {
      throw new PostgresGatewayAuthorityError('SEQUENCE_CONFLICT');
    }
    const operation = gatewayOperation<AcceptOutcome>(
      'ACCEPT_ENVELOPE',
      { session, canonicalDigest: digest },
      AcceptOutcomeSchema,
      `${envelope.messageId}:${digest}`,
    );
    const outcome = await withGatewayTransaction<AcceptOutcome>(
      this.pools.broker,
      {
        creatorId: session.ownerId,
        signal,
        timeoutMs: this.#policy.transactionTimeoutMs,
        operation,
        beforeCommit: () => this.#inject('BEFORE_COMMIT'),
      },
      async (transaction) => {
        const sequence = parseUint63(envelope.sequence);
        // Serialize every inbound decision for one durable Session independently
        // from the per-operation COMMIT-recovery key. This closes the window in
        // which two different digests can both observe a missing sequence receipt.
        await transaction.query(
          `SELECT pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text, 0))`,
          [`combo.gateway.accept/v1:${session.workerSessionId}`],
          signal,
        );
        const receipt = await transaction.query<ReceiptRow>(
          `SELECT sequence, message_id::text, canonical_digest, response_frames
             FROM worker_gateway_frame_receipts
            WHERE session_id = $1 AND creator_id = $2 AND sequence = $3`,
          [session.workerSessionId, session.ownerId, sequence],
          signal,
        );
        if (receipt.rows[0] !== undefined) {
          const existing = receipt.rows[0];
          if (existing.message_id !== envelope.messageId || existing.canonical_digest !== digest) {
            await recordSequenceConflict(
              transaction,
              session,
              sequence,
              existing,
              envelope.messageId,
              digest,
              signal,
            );
            return { kind: 'SEQUENCE_CONFLICT' };
          }
          return { kind: 'RESPONSES', responses: parseStoredResponses(existing.response_frames) };
        }
        const messageReceipt = await transaction.query<ReceiptRow>(
          `SELECT sequence, message_id::text, canonical_digest, response_frames
             FROM worker_gateway_frame_receipts
            WHERE session_id = $1 AND creator_id = $2 AND message_id = $3`,
          [session.workerSessionId, session.ownerId, envelope.messageId],
          signal,
        );
        if (messageReceipt.rows[0] !== undefined) {
          await recordSequenceConflict(
            transaction,
            session,
            sequence,
            messageReceipt.rows[0],
            envelope.messageId,
            digest,
            signal,
          );
          return { kind: 'SEQUENCE_CONFLICT' };
        }
        if (replayOnly) throw new PostgresGatewayAuthorityError('REPLAY_NOT_FOUND');

        await transaction.query(
          `SELECT pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text, 0))`,
          [`combo.gateway.deployment/v1:${session.ownerId}:${envelope.lease.deploymentId}`],
          signal,
        );
        const current = await lockSessionAndLease(transaction, session, envelope, signal);
        const freshness = await transaction.query<{ alive: boolean }>(
          `SELECT $1::timestamptz > statement_timestamp() AS alive`,
          [envelope.expiresAt],
          signal,
        );
        if (freshness.rows[0]?.alive !== true) {
          throw new PostgresGatewayAuthorityError('MESSAGE_EXPIRED');
        }
        if (sequence !== parseUint63(current.inbound_next_seq)) {
          throw new PostgresGatewayAuthorityError('SEQUENCE_CONFLICT');
        }

        const responses: BrokerEnvelope[] = [];
        let projection: ProjectionOutcome | undefined;
        if (envelope.type === 'message.ack') {
          await this.#acceptOutboundAck(transaction, session, envelope, current, signal);
          const blocked = leaseBlockDisposition(current);
          if (blocked !== undefined) {
            await revokeLeaseAuthority(transaction, session, current, blocked, signal);
            projection = { decision: 'SECURITY_BLOCK', revokeReason: blocked.revokeReason };
          }
        } else {
          projection = await this.#projectEvent(transaction, session, envelope, current, signal);
          if (projection.renewedLeaseExpiresAt !== undefined) {
            const grantIdentity = await nextEnvelopeIdentity(transaction, signal);
            const grantSequence = outboundSequenceAt(current.outbound_next_seq, responses.length);
            const grant = BrokerEnvelopeSchema.parse({
              protocol: 'combo.creator-broker/1',
              schemaVersion: 1,
              kind: 'command',
              type: 'lease.grant',
              messageId: grantIdentity.messageId,
              correlationId: current.deployment_id,
              connectionId: session.connectionId,
              sequence: grantSequence,
              sentAt: grantIdentity.sentAt,
              expiresAt: projection.renewedLeaseExpiresAt,
              lease: envelope.lease,
              body: {
                leaseExpiresAt: projection.renewedLeaseExpiresAt,
                workerSessionId: session.workerSessionId,
                generation: parseUint63(current.deployment_generation),
              },
            });
            await persistOutbound(transaction, session, grant, signal);
            await advanceOutbound(transaction, session, grantSequence, signal);
            responses.push(grant);
          }
          const identity = await nextEnvelopeIdentity(transaction, signal);
          const ackSequence = outboundSequenceAt(current.outbound_next_seq, responses.length);
          const response = BrokerAckSchema.parse({
            protocol: 'combo.creator-broker/1',
            schemaVersion: 1,
            kind: 'ack',
            type: 'message.ack',
            messageId: identity.messageId,
            correlationId: envelope.correlationId,
            connectionId: session.connectionId,
            sequence: ackSequence,
            sentAt: identity.sentAt,
            expiresAt: new Date(
              Date.parse(identity.sentAt) + this.#policy.responseTtlMs,
            ).toISOString(),
            lease: envelope.lease,
            body: {
              acknowledgedMessageId: envelope.messageId,
              level: 'CLOUD_COMMITTED',
              decision: projection.decision,
            },
          });
          await persistOutbound(transaction, session, response, signal);
          await advanceOutbound(transaction, session, ackSequence, signal);
          responses.push(response);
        }

        if (projection?.revokeReason !== undefined) {
          const revokeSequence = outboundSequenceAt(current.outbound_next_seq, responses.length);
          const revokeIdentity = await nextEnvelopeIdentity(transaction, signal);
          const revoke = BrokerEnvelopeSchema.parse({
            protocol: 'combo.creator-broker/1',
            schemaVersion: 1,
            kind: 'command',
            type: 'lease.revoke',
            messageId: revokeIdentity.messageId,
            correlationId: envelope.correlationId,
            connectionId: session.connectionId,
            sequence: revokeSequence,
            sentAt: revokeIdentity.sentAt,
            expiresAt: new Date(
              Date.parse(revokeIdentity.sentAt) + this.#policy.responseTtlMs,
            ).toISOString(),
            lease: envelope.lease,
            body: {
              reason: projection.revokeReason,
              effectiveAt: revokeIdentity.sentAt,
            },
          });
          await persistOutbound(transaction, session, revoke, signal);
          await advanceOutbound(transaction, session, revokeSequence, signal);
          responses.push(revoke);
        }

        await this.#inject('EVENT_PROJECTED');
        const insertedReceipt = await transaction.query(
          `INSERT INTO worker_gateway_frame_receipts (
             session_id, creator_id, sequence, message_id, canonical_digest,
             envelope_type, response_frames, broker_acknowledged_message_id,
             broker_ack_level, broker_ack_decision
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
          [
            session.workerSessionId,
            session.ownerId,
            sequence,
            envelope.messageId,
            digest,
            envelope.type,
            JSON.stringify(responses),
            envelope.type === 'message.ack' ? envelope.body.acknowledgedMessageId : null,
            envelope.type === 'message.ack' ? envelope.body.level : null,
            envelope.type === 'message.ack' ? envelope.body.decision : null,
          ],
          signal,
        );
        if (insertedReceipt.rowCount !== 1) throw persistenceFailure();
        const advanced = await transaction.query(
          `UPDATE worker_gateway_sessions
              SET inbound_next_seq = inbound_next_seq + 1
            WHERE id = $1 AND creator_id = $2 AND connection_id = $3
              AND inbound_next_seq = $4 AND inbound_next_seq < 9223372036854775807`,
          [session.workerSessionId, session.ownerId, session.connectionId, sequence],
          signal,
        );
        if (advanced.rowCount !== 1) throw persistenceFailure();
        if (projection?.revokeReason !== undefined) {
          const disconnectReason =
            projection.revokeReason === 'INSTALLATION_REVOKED'
              ? 'INSTALLATION_REVOKED'
              : projection.revokeReason === 'SECURITY'
                ? 'AUTH_FAILED'
                : 'REPLAY_REQUIRED';
          const closed = await transaction.query(
            `UPDATE worker_gateway_sessions
                SET state = 'REVOKED', closed_at = statement_timestamp(),
                    disconnect_reason = $5
              WHERE id = $1 AND creator_id = $2 AND installation_id = $3
                AND connection_id = $4 AND state = 'ACTIVE'`,
            [
              session.workerSessionId,
              session.ownerId,
              session.installationId,
              session.connectionId,
              disconnectReason,
            ],
            signal,
          );
          if (closed.rowCount !== 1) throw persistenceFailure();
        }
        await this.#inject('RECEIPT_INSERTED');
        return { kind: 'RESPONSES', responses };
      },
    );
    if (outcome.kind === 'SEQUENCE_CONFLICT') {
      throw new PostgresGatewayAuthorityError('SEQUENCE_CONFLICT');
    }
    return outcome.responses;
  }

  async #projectEvent(
    transaction: GatewayTransaction,
    session: AuthenticatedWorkerSession,
    envelope: Exclude<BrokerEnvelope, { kind: 'command' | 'ack' }>,
    lease: SessionLeaseRow,
    signal: AbortSignal,
  ): Promise<ProjectionOutcome> {
    const blocked = leaseBlockDisposition(lease);
    if (blocked !== undefined) {
      await revokeLeaseAuthority(transaction, session, lease, blocked, signal);
      return { decision: 'SECURITY_BLOCK', revokeReason: blocked.revokeReason };
    }
    if (envelope.type === 'heartbeat') {
      if (envelope.body.workerSessionId !== session.workerSessionId) {
        throw new PostgresGatewayAuthorityError('LEASE_UNAVAILABLE');
      }
      const renewedLeaseExpiresAt = await renewLease(
        transaction,
        session,
        lease,
        this.#policy.leaseTtlMs,
        signal,
      );
      const runtimeReady =
        envelope.body.runtimeReady && envelope.body.proxyReady && envelope.body.journalReady;
      const versionReady =
        rowVersionIsReady(lease) && lease.desired_version_availability !== 'REVOKED';
      const seen = await transaction.query(
        `UPDATE worker_installations
            SET last_seen_at = GREATEST(last_seen_at, statement_timestamp())
          WHERE id = $1 AND creator_id = $2 AND revoked_at IS NULL`,
        [session.installationId, session.ownerId],
        signal,
      );
      if (seen.rowCount !== 1) throw new PostgresGatewayAuthorityError('LEASE_UNAVAILABLE');
      const observed = await transaction.query(
        `UPDATE deployments
            SET observed_state = $4, last_error_code = $5,
                updated_at = statement_timestamp()
          WHERE id = $1 AND creator_id = $2 AND lease_fence = $3
            AND observed_worker_id = $6`,
        [
          lease.deployment_id,
          session.ownerId,
          parseUint63(lease.lease_fence),
          runtimeReady && versionReady ? 'ONLINE' : runtimeReady ? 'PREPARING' : 'DEGRADED',
          runtimeReady ? null : 'WORKER_CAPABILITY_NOT_READY',
          session.installationId,
        ],
        signal,
      );
      if (observed.rowCount !== 1) {
        throw new PostgresGatewayAuthorityError('LEASE_UNAVAILABLE');
      }
      return { decision: 'APPLIED', renewedLeaseExpiresAt };
    }
    if (envelope.type === 'lease.accepted' || envelope.type === 'lease.renewed') {
      if (envelope.body.leaseExpiresAt !== isoDate(lease.lease_expires_at)) {
        throw new PostgresGatewayAuthorityError('LEASE_UNAVAILABLE');
      }
      await acknowledgeLeaseGrant(
        transaction,
        session,
        lease,
        envelope.correlationId,
        envelope.body.leaseExpiresAt,
        signal,
      );
      return { decision: 'APPLIED' };
    }
    if (envelope.type === 'pong') return { decision: 'APPLIED' };
    if (this.projector === undefined) {
      throw new PostgresGatewayAuthorityError('BUSINESS_PROJECTOR_UNAVAILABLE');
    }
    const decision = await this.projector.project({
      transaction,
      session,
      transport: Object.freeze({
        creatorId: session.ownerId,
        installationId: session.installationId,
        workerSessionId: session.workerSessionId,
        connectionId: session.connectionId,
        deploymentId: lease.deployment_id,
        leaseId: lease.lease_id,
        fence: parseUint63(lease.lease_fence),
      }),
      event: envelope as ProjectableWorkerEvent,
      signal,
    });
    const securityIsolation = gatewayBusinessSecurityIsolation(decision);
    if (securityIsolation !== undefined) {
      await revokeLeaseAuthority(transaction, session, lease, securityIsolation, signal);
      return {
        decision,
        revokeReason: securityIsolation.revokeReason,
      };
    }
    return { decision };
  }

  async #acceptOutboundAck(
    transaction: GatewayTransaction,
    session: AuthenticatedWorkerSession,
    envelope: Extract<BrokerEnvelope, { type: 'message.ack' }>,
    currentLease: SessionLeaseRow,
    signal: AbortSignal,
  ): Promise<void> {
    const found = await transaction.query<{
      durable_ack_level: string | null;
      ack_decision: string | null;
    }>(
      `SELECT durable_ack_level, ack_decision
         FROM worker_gateway_outbound_frames
        WHERE message_id = $1 AND session_id = $2 AND creator_id = $3
        FOR UPDATE`,
      [envelope.body.acknowledgedMessageId, session.workerSessionId, session.ownerId],
      signal,
    );
    const current = found.rows[0];
    if (current === undefined) {
      // SQLite reframes a durable ACK before it asks Cloud to replay the business command on a
      // replacement transport. Accept only an exact prior PERSISTED/APPLIED v1 command binding as
      // a no-op. The current Session still has no delivery, so the publisher must re-envelope the
      // command; critically, this path never ACKs broker_outbox.
      if (envelope.body.level !== 'PERSISTED' || envelope.body.decision !== 'APPLIED') {
        throw new PostgresGatewayAuthorityError('OUTBOUND_ACK_CONFLICT');
      }
      const prior = await transaction.query<{ present: boolean }>(
        `SELECT true AS present
           FROM worker_gateway_outbound_frames AS delivery
           JOIN broker_outbox AS command
             ON command.command_id = delivery.broker_command_id
            AND command.creator_id = delivery.creator_id
          WHERE delivery.message_id = $1 AND delivery.creator_id = $2
            AND delivery.delivery_contract_version = 1
            AND delivery.envelope_type = 'conversation.open'
            AND delivery.durable_ack_level IN ('PERSISTED', 'CLOUD_COMMITTED')
            AND delivery.ack_decision = 'APPLIED'
            AND command.command_id = $1
            AND command.target_worker_id = $3
            AND command.deployment_id = $4
            AND command.state IN ('SENT', 'ACKED')
          ORDER BY delivery.created_at
          LIMIT 1
          FOR UPDATE OF command, delivery`,
        [
          envelope.body.acknowledgedMessageId,
          session.ownerId,
          session.installationId,
          currentLease.deployment_id,
        ],
        signal,
      );
      if (prior.rows[0]?.present !== true) {
        throw new PostgresGatewayAuthorityError('OUTBOUND_ACK_CONFLICT');
      }
      return;
    }
    if (current.ack_decision !== null && current.ack_decision !== envelope.body.decision) {
      throw new PostgresGatewayAuthorityError('OUTBOUND_ACK_CONFLICT');
    }
    if (ackRank(envelope.body.level) < ackRank(current.durable_ack_level)) {
      throw new PostgresGatewayAuthorityError('OUTBOUND_ACK_CONFLICT');
    }
    const updated = await transaction.query(
      `UPDATE worker_gateway_outbound_frames
          SET durable_ack_level = $4, ack_decision = $5,
              acked_at = COALESCE(acked_at, statement_timestamp())
        WHERE message_id = $1 AND session_id = $2 AND creator_id = $3`,
      [
        envelope.body.acknowledgedMessageId,
        session.workerSessionId,
        session.ownerId,
        envelope.body.level,
        envelope.body.decision,
      ],
      signal,
    );
    if (updated.rowCount !== 1) {
      throw new PostgresGatewayAuthorityError('OUTBOUND_ACK_CONFLICT');
    }
  }

  #compatibilityError(
    handshake: BrokerHandshake,
    installation: ChallengeInstallationRow,
  ): WorkerCompatibilityErrorCode | undefined {
    const admission = admitGatewayWorkerCompatibility(
      this.#policy,
      handshake,
      {
        workerVersion: installation.worker_version,
        protocolVersions: installation.protocol_versions,
        capabilities: installation.capabilities,
        codexRuntimeArtifactDigest: installation.codex_runtime_artifact_digest,
        codexProtocolSchemaDigest: installation.codex_protocol_schema_digest,
        runtimePolicy: installation.runtime_policy,
      },
      () => undefined,
    );
    return admission.kind === 'BLOCKED' ? admission.reason : undefined;
  }

  async #blockIncompatibleDeployment(
    transaction: GatewayTransaction,
    creatorId: string,
    handshake: BrokerHandshake,
    installation: ChallengeInstallationRow,
    reasonCode: WorkerCompatibilityErrorCode,
    signal: AbortSignal,
  ): Promise<void> {
    const active = await transaction.query<{ worker_id: string }>(
      `SELECT worker_id::text
         FROM worker_leases
        WHERE creator_id = $1 AND deployment_id = $2
          AND state = 'ACTIVE' AND expires_at > statement_timestamp()
        FOR UPDATE`,
      [creatorId, installation.deployment_id],
      signal,
    );
    const ownedByAnotherInstallation = active.rows.some(
      (row) => UuidSchema.parse(row.worker_id) !== handshake.installationId,
    );
    if (!ownedByAnotherInstallation) {
      await transaction.query(
        `UPDATE worker_leases
            SET state = 'REVOKED'
          WHERE creator_id = $1 AND deployment_id = $2 AND worker_id = $3
            AND state = 'ACTIVE'`,
        [creatorId, installation.deployment_id, handshake.installationId],
        signal,
      );
      const blocked = await transaction.query(
        `UPDATE deployments
            SET observed_state = 'BLOCKED', observed_worker_id = $3,
                observed_generation = generation, last_error_code = $5,
                lease_fence = lease_fence + 1, updated_at = statement_timestamp()
          WHERE id = $1 AND creator_id = $2 AND generation = $4
            AND desired_state = 'ONLINE'
            AND lease_fence < 9223372036854775807`,
        [
          installation.deployment_id,
          creatorId,
          handshake.installationId,
          parseUint63(installation.deployment_generation),
          reasonCode,
        ],
        signal,
      );
      if (blocked.rowCount !== 1) throw persistenceFailure();
    }
    const audited = await transaction.query(
      `INSERT INTO worker_auth_security_events (
         creator_id, installation_id, challenge_id, deployment_id,
         event_type, reason_code
       ) VALUES ($1, $2, $3, $4, 'WORKER_INCOMPATIBLE', $5)
       ON CONFLICT (challenge_id, event_type) DO NOTHING`,
      [
        creatorId,
        handshake.installationId,
        handshake.challengeId,
        installation.deployment_id,
        reasonCode,
      ],
      signal,
    );
    if (audited.rowCount !== 0 && audited.rowCount !== 1) throw persistenceFailure();
  }

  async #auditConsumedChallengeReplay(handshake: BrokerHandshake): Promise<void> {
    const signal = AbortSignal.timeout(this.#policy.transactionTimeoutMs);
    const creatorId = await resolveConsumedChallengeCreator(
      this.pools.broker,
      handshake.challengeId,
      handshake.installationId,
      signal,
    );
    if (creatorId === undefined) return;
    const operation = gatewayOperation<{ recorded: true }>(
      'AUDIT_CHALLENGE_REPLAY',
      { handshake },
      ChallengeReplayAuditResultSchema,
      handshake.challengeId,
    );
    await withGatewayTransaction(
      this.pools.broker,
      {
        creatorId,
        signal,
        timeoutMs: this.#policy.transactionTimeoutMs,
        operation,
        beforeCommit: () => this.#inject('BEFORE_COMMIT'),
      },
      async (transaction) => {
        const found = await transaction.query<{
          creator_id: string;
          device_public_key: Buffer;
          deployment_id: string;
          original_session_id: string | null;
        }>(
          `SELECT challenge.creator_id::text, installation.device_public_key,
                  challenge.deployment_id::text,
                  gateway.id::text AS original_session_id
             FROM worker_auth_challenges AS challenge
             JOIN worker_installations AS installation
               ON installation.id = challenge.installation_id
              AND installation.creator_id = challenge.creator_id
             LEFT JOIN worker_gateway_sessions AS gateway
               ON gateway.challenge_id = challenge.id
              AND gateway.creator_id = challenge.creator_id
            WHERE challenge.id = $1 AND challenge.installation_id = $2
              AND challenge.creator_id = $3 AND challenge.state = 'CONSUMED'
            FOR UPDATE OF challenge, installation`,
          [handshake.challengeId, handshake.installationId, creatorId],
          signal,
        );
        const replay = found.rows[0];
        if (replay === undefined) {
          throw new BrokerAuthenticationError(
            BrokerAuthenticationFailureCode.AUTHENTICATION_REJECTED,
          );
        }
        const publicKey = p256PublicKeyFromUncompressedPoint(replay.device_public_key);
        const { challengeSignature: _signature, ...unsignedInput } = handshake;
        const unsigned = BrokerHandshakeUnsignedSchema.parse(unsignedInput);
        if (
          !verifyP256P1363Signature(
            brokerHandshakeSigningBytes(unsigned),
            handshake.challengeSignature,
            publicKey,
          )
        ) {
          throw new BrokerAuthenticationError(
            BrokerAuthenticationFailureCode.AUTHENTICATION_REJECTED,
          );
        }
        const inserted = await transaction.query(
          `INSERT INTO worker_auth_security_events (
             creator_id, installation_id, challenge_id, deployment_id,
             original_session_id, event_type, reason_code
           ) VALUES (
             $1, $2, $3, $4, $5,
             'CHALLENGE_REPLAY', 'CHALLENGE_ALREADY_CONSUMED'
           )
           ON CONFLICT (challenge_id, event_type) DO NOTHING`,
          [
            creatorId,
            handshake.installationId,
            handshake.challengeId,
            replay.deployment_id,
            replay.original_session_id,
          ],
          signal,
        );
        if (inserted.rowCount !== 0 && inserted.rowCount !== 1) throw persistenceFailure();
        return { recorded: true as const };
      },
    );
  }

  async #inject(step: GatewayAuthorityStep): Promise<void> {
    await this.failureInjector?.(step);
  }
}

export function toGatewayPool(pool: Pool): GatewayPool {
  return {
    async connect(): Promise<GatewayConnection> {
      const client = await pool.connect();
      return wrapPgClient(client);
    },
  };
}

function wrapPgClient(client: PoolClient): GatewayConnection {
  return {
    query: <Row>(sql: string, parameters?: readonly unknown[], signal?: AbortSignal) =>
      queryWithSignal<Row>(client, sql, parameters, signal),
    release: (destroy = false) => client.release(destroy),
  };
}

async function queryWithSignal<Row>(
  client: PoolClient,
  sql: string,
  parameters?: readonly unknown[],
  signal?: AbortSignal,
): Promise<GatewayQueryResult<Row>> {
  if (signal?.aborted === true) throw aborted();
  const pending = client.query(sql, parameters as unknown[]) as unknown as Promise<
    GatewayQueryResult<Row>
  >;
  if (signal === undefined) return pending;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(aborted()));
    signal.addEventListener('abort', onAbort, { once: true });
    void pending.then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function gatewayOperation<T>(
  kind: GatewayOperationKind,
  requestBinding: unknown,
  schema: z.ZodTypeAny,
  operationKey: string,
  allowCommittedReplay = true,
): GatewayOperation<T> {
  return Object.freeze({
    operationKey: z.string().min(1).max(256).parse(operationKey),
    kind: GatewayOperationKindSchema.parse(kind),
    requestDigest: canonicalSha256(requestBinding),
    allowCommittedReplay,
    encode: (value: T): unknown => schema.parse(value),
    decode: (value: unknown): T => schema.parse(value) as T,
  });
}

function voidGatewayOperation(
  kind: Extract<GatewayOperationKind, 'SEQUENCE_GAP' | 'CLOSE_SESSION'>,
  requestBinding: unknown,
  operationKey: string,
): GatewayOperation<void> {
  return Object.freeze({
    operationKey: z.string().min(1).max(256).parse(operationKey),
    kind: GatewayOperationKindSchema.parse(kind),
    requestDigest: canonicalSha256(requestBinding),
    allowCommittedReplay: true,
    encode: (): null => null,
    decode: (value: unknown): void => {
      z.null().parse(value);
    },
  });
}

function operationAdvisoryKey(operation: {
  readonly kind: GatewayOperationKind;
  readonly operationKey: string;
}): string {
  return `combo.gateway.commit/v1:${operation.kind}:${operation.operationKey}`;
}

function decodeGatewayOperationReceipt<T>(
  operation: GatewayOperation<T>,
  receipt: OperationReceiptRow,
): T {
  if (receipt.operation_kind !== operation.kind) throw persistenceFailure();
  if (receipt.request_digest !== operation.requestDigest) {
    throw new PostgresGatewayAuthorityError('OPERATION_CONFLICT', operation.operationKey);
  }
  if (canonicalSha256(receipt.result_value) !== receipt.result_digest) {
    throw persistenceFailure();
  }
  return operation.decode(receipt.result_value);
}

async function withGatewayTransaction<T>(
  pool: GatewayPool,
  options: {
    creatorId?: string;
    signal: AbortSignal;
    timeoutMs: number;
    operation: GatewayOperation<T>;
    beforeCommit?: () => Promise<void>;
  },
  operation: (
    transaction: GatewayTransaction,
    setCreator: (creatorId: string) => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  const connection = await connectWithSignal(pool, options.signal);
  let released = false;
  let commitSubmitted = false;
  let resolvedCreatorId = options.creatorId;
  const release = (destroy = false): void => {
    if (released) return;
    released = true;
    connection.release(destroy);
  };
  const query = async <Row>(
    sql: string,
    parameters?: readonly unknown[],
    signal = options.signal,
  ): Promise<GatewayQueryResult<Row>> => {
    if (signal.aborted) throw aborted();
    const result = await connection.query<Row>(sql, parameters, signal);
    if (signal.aborted) throw aborted();
    return result;
  };
  const transaction: GatewayTransaction = { query };
  const setCreator = async (creatorId: string): Promise<void> => {
    resolvedCreatorId = UuidSchema.parse(creatorId);
    await query(`SELECT set_config('app.creator_id', $1, true)`, [resolvedCreatorId]);
  };
  try {
    await query('BEGIN');
    await query(
      `SELECT set_config('lock_timeout', $1, true),
              set_config('statement_timeout', $1, true)`,
      [`${options.timeoutMs}ms`],
    );
    if (options.creatorId !== undefined) await setCreator(options.creatorId);
    await query(`SELECT pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text, 0))`, [
      operationAdvisoryKey(options.operation),
    ]);
    if (resolvedCreatorId !== undefined && options.operation.allowCommittedReplay) {
      const committed = await query<OperationReceiptRow>(
        `SELECT operation_kind, request_digest, result_value, result_digest
           FROM worker_gateway_operation_receipts
          WHERE creator_id = $1 AND operation_kind = $2 AND operation_key = $3`,
        [resolvedCreatorId, options.operation.kind, options.operation.operationKey],
      );
      if (committed.rows[0] !== undefined) {
        const replay = decodeGatewayOperationReceipt(options.operation, committed.rows[0]);
        release(true);
        return replay;
      }
    }
    try {
      const result = await operation(transaction, setCreator);
      if (options.signal.aborted) throw aborted();
      if (resolvedCreatorId === undefined) throw persistenceFailure();
      const resultValue = options.operation.encode(result);
      // Decode before persistence so a programmer error can never create an
      // unreadable committed receipt that masks an otherwise valid operation.
      options.operation.decode(resultValue);
      const resultDigest = canonicalSha256(resultValue);
      const receipt = await query(
        `INSERT INTO worker_gateway_operation_receipts (
           creator_id, operation_kind, operation_key, request_digest,
           result_value, result_digest
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [
          resolvedCreatorId,
          options.operation.kind,
          options.operation.operationKey,
          options.operation.requestDigest,
          JSON.stringify(resultValue),
          resultDigest,
        ],
      );
      if (receipt.rowCount !== 1) throw persistenceFailure();
      await options.beforeCommit?.();
      if (options.signal.aborted) throw aborted();
      commitSubmitted = true;
      try {
        // Do not use the socket lifecycle signal after submission: a disconnect
        // cannot tell us whether PostgreSQL durably committed the transaction.
        await connection.query('COMMIT', undefined, AbortSignal.timeout(options.timeoutMs));
        return result;
      } catch (commitError) {
        // Never issue ROLLBACK after COMMIT was submitted. Destroy the uncertain
        // connection, then serialize behind the original transaction on a new
        // connection and read its exact same-transaction operation receipt.
        release(true);
        return await recoverGatewayOperation(
          pool,
          options.operation,
          resolvedCreatorId,
          options.timeoutMs,
          commitError,
        );
      }
    } catch (error) {
      if (commitSubmitted) {
        release(true);
      } else if (options.signal.aborted) {
        release(true);
      } else {
        const rollbackSignal = AbortSignal.timeout(Math.min(options.timeoutMs, 2_000));
        await connection.query('ROLLBACK', undefined, rollbackSignal).catch(() => release(true));
      }
      throw error;
    }
  } finally {
    release(options.signal.aborted);
  }
}

async function recoverGatewayOperation<T>(
  pool: GatewayPool,
  operation: GatewayOperation<T>,
  creatorId: string,
  timeoutMs: number,
  commitError: unknown,
): Promise<T> {
  const recoverySignal = AbortSignal.timeout(timeoutMs + 1_000);
  let connection: GatewayConnection | undefined;
  try {
    connection = await connectWithSignal(pool, recoverySignal);
    const query = async <Row>(
      sql: string,
      parameters?: readonly unknown[],
    ): Promise<GatewayQueryResult<Row>> => {
      if (recoverySignal.aborted) throw aborted();
      return connection!.query<Row>(sql, parameters, recoverySignal);
    };
    await query('BEGIN');
    await query(
      `SELECT set_config('lock_timeout', $1, true),
              set_config('statement_timeout', $1, true),
              set_config('app.creator_id', $2, true)`,
      [`${timeoutMs}ms`, creatorId],
    );
    // Acquiring the same transaction-scoped lock proves the original transaction
    // has finished before we inspect the receipt.
    await query(`SELECT pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text, 0))`, [
      operationAdvisoryKey(operation),
    ]);
    const found = await query<OperationReceiptRow>(
      `SELECT operation_kind, request_digest, result_value, result_digest
         FROM worker_gateway_operation_receipts
        WHERE creator_id = $1 AND operation_kind = $2 AND operation_key = $3`,
      [creatorId, operation.kind, operation.operationKey],
    );
    const receipt = found.rows[0];
    if (receipt === undefined) {
      throw new PostgresGatewayAuthorityError('COMMIT_NOT_APPLIED', operation.operationKey);
    }
    return decodeGatewayOperationReceipt(operation, receipt);
  } catch (error) {
    if (error instanceof PostgresGatewayAuthorityError) throw error;
    const unknown = new PostgresGatewayAuthorityError(
      'COMMIT_OUTCOME_UNKNOWN',
      operation.operationKey,
    );
    Object.defineProperty(unknown, 'cause', {
      configurable: true,
      enumerable: false,
      value: error ?? commitError,
      writable: false,
    });
    throw unknown;
  } finally {
    // This recovery transaction is read-only. Destroying the connection releases
    // its advisory lock without introducing a second COMMIT ambiguity.
    connection?.release(true);
  }
}

async function connectWithSignal(
  pool: GatewayPool,
  signal: AbortSignal,
): Promise<GatewayConnection> {
  if (signal.aborted) throw aborted();
  const pending = pool.connect();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(aborted()));
    signal.addEventListener('abort', onAbort, { once: true });
    void pending.then(
      (connection) => {
        if (settled) {
          connection.release(true);
          return;
        }
        finish(() => resolve(connection));
      },
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function resolveConsumedChallengeCreator(
  pool: GatewayPool,
  challengeId: string,
  installationId: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const connection = await connectWithSignal(pool, signal);
  try {
    const resolved = await connection.query<{ creator_id: string | null }>(
      `SELECT creator_agent_lock_consumed_worker_challenge(
         $1::uuid, $2::uuid
       )::text AS creator_id`,
      [challengeId, installationId],
      signal,
    );
    const creatorId = resolved.rows[0]?.creator_id;
    return creatorId == null ? undefined : UuidSchema.parse(creatorId);
  } finally {
    connection.release(signal.aborted);
  }
}

async function findNextBrokerCommandCandidate(
  pool: GatewayPool,
  session: AuthenticatedWorkerSession,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<BrokerCommandCandidateRow | undefined> {
  const connection = await connectWithSignal(pool, signal);
  let transactionOpen = false;
  let destroy = false;
  try {
    await connection.query('BEGIN', undefined, signal);
    transactionOpen = true;
    await connection.query(
      `SELECT set_config('lock_timeout', $1, true),
              set_config('statement_timeout', $1, true),
              set_config('app.creator_id', $2, true)`,
      [`${timeoutMs}ms`, session.ownerId],
      signal,
    );
    // This is deliberately a non-authoritative pre-read. The exact candidate is rechecked only
    // after the per-Deployment advisory and current Session/Lease locks in the claim transaction.
    const result = await connection.query<BrokerCommandCandidateRow>(
      `SELECT command.command_id::text, command.deployment_id::text
         FROM worker_gateway_sessions AS gateway
         JOIN worker_auth_challenges AS challenge
           ON challenge.id = gateway.challenge_id
          AND challenge.creator_id = gateway.creator_id
          AND challenge.installation_id = gateway.installation_id
         JOIN broker_outbox AS command
           ON command.creator_id = gateway.creator_id
          AND command.target_worker_id = gateway.installation_id
          AND command.deployment_id = challenge.deployment_id
         JOIN deployments AS deployment
           ON deployment.id = command.deployment_id
          AND deployment.creator_id = command.creator_id
         JOIN worker_leases AS lease
           ON lease.deployment_id = deployment.id
          AND lease.creator_id = deployment.creator_id
          AND lease.worker_id = gateway.installation_id
          AND lease.connection_id = gateway.connection_id
        WHERE gateway.id = $1 AND gateway.creator_id = $2
          AND gateway.installation_id = $3 AND gateway.connection_id = $4
          AND gateway.state = 'ACTIVE'
          AND gateway.expires_at > clock_timestamp() + interval '3 seconds'
          AND challenge.state = 'CONSUMED'
          AND deployment.environment = 'TEST'
          AND deployment.desired_state = 'ONLINE'
          AND deployment.observed_state = 'ONLINE'
          AND deployment.observed_worker_id = gateway.installation_id
          AND deployment.observed_generation = deployment.generation
          AND deployment.lease_fence = lease.fence
          AND lease.state = 'ACTIVE'
          AND lease.expires_at > clock_timestamp() + interval '3 seconds'
          AND command.payload_contract_version = 1
          AND command.command_type = 'conversation.open'
          AND command.state IN ('PENDING', 'SENT')
          AND command.attempt_count < 100
          AND command.next_attempt_at <= transaction_timestamp()
          AND command.expires_at > clock_timestamp() + interval '3 seconds'
          AND NOT EXISTS (
            SELECT 1
              FROM broker_outbox AS competing_command
              JOIN agent_conversations AS competing_conversation
                ON competing_conversation.id = competing_command.conversation_id
               AND competing_conversation.creator_id = competing_command.creator_id
               AND competing_conversation.consumer_subject_id = competing_command.consumer_subject_id
             WHERE competing_command.creator_id = command.creator_id
               AND competing_command.command_id <> command.command_id
               AND competing_command.payload_contract_version = 1
               AND competing_command.command_type = 'conversation.open'
               AND competing_command.state IN ('PENDING', 'SENT')
               AND competing_command.expires_at > clock_timestamp()
               AND competing_conversation.state = 'OPENING'
               AND (
                 competing_command.state = 'SENT'
                 OR EXISTS (
                   SELECT 1
                     FROM worker_gateway_outbound_frames AS competing_delivery
                    WHERE competing_delivery.creator_id = competing_command.creator_id
                      AND competing_delivery.broker_command_id = competing_command.command_id
                      AND competing_delivery.delivery_contract_version = 1
                      AND competing_delivery.durable_ack_level IS DISTINCT FROM 'CLOUD_COMMITTED'
                 )
                 OR (
                   command.state = 'PENDING'
                   AND competing_command.state = 'PENDING'
                   AND (competing_command.created_at, competing_command.command_id)
                       < (command.created_at, command.command_id)
                 )
               )
          )
          AND NOT EXISTS (
            SELECT 1
              FROM worker_gateway_outbound_frames AS delivery
             WHERE delivery.session_id = gateway.id
               AND delivery.creator_id = gateway.creator_id
               AND delivery.broker_command_id = command.command_id
               AND delivery.delivery_contract_version = 1
               AND delivery.durable_ack_level IN ('PERSISTED', 'CLOUD_COMMITTED')
          )
        ORDER BY command.next_attempt_at, command.command_id
        LIMIT 1`,
      [session.workerSessionId, session.ownerId, session.installationId, session.connectionId],
      signal,
    );
    await connection.query('ROLLBACK', undefined, AbortSignal.timeout(Math.min(timeoutMs, 2_000)));
    transactionOpen = false;
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      command_id: UuidSchema.parse(row.command_id),
      deployment_id: UuidSchema.parse(row.deployment_id),
    };
  } catch (error) {
    destroy = true;
    throw error;
  } finally {
    if (transactionOpen && !destroy) {
      await connection
        .query('ROLLBACK', undefined, AbortSignal.timeout(Math.min(timeoutMs, 2_000)))
        .catch(() => {
          destroy = true;
        });
    }
    connection.release(destroy || signal.aborted);
  }
}

async function lockPublisherCurrentAuthority(
  transaction: GatewayTransaction,
  session: AuthenticatedWorkerSession,
  deploymentId: string,
  signal: AbortSignal,
): Promise<BrokerPublisherCurrentAuthorityRow> {
  const found = await transaction.query<BrokerPublisherCurrentAuthorityRow>(
    `SELECT gateway.registration_digest, gateway.outbound_next_seq,
            gateway.expires_at AS session_expires_at,
            lease.id::text AS lease_id, lease.fence AS lease_fence,
            lease.expires_at AS lease_expires_at,
            installation.worker_version, installation.protocol_versions,
            installation.capabilities, installation.revoked_at
       FROM worker_gateway_sessions AS gateway
       JOIN worker_auth_challenges AS challenge
         ON challenge.id = gateway.challenge_id
        AND challenge.creator_id = gateway.creator_id
        AND challenge.installation_id = gateway.installation_id
        AND challenge.deployment_id = $5
       JOIN deployments AS deployment
         ON deployment.id = challenge.deployment_id
        AND deployment.creator_id = challenge.creator_id
       JOIN worker_leases AS lease
         ON lease.deployment_id = deployment.id
        AND lease.creator_id = deployment.creator_id
        AND lease.worker_id = gateway.installation_id
        AND lease.connection_id = gateway.connection_id
       JOIN worker_installations AS installation
         ON installation.id = gateway.installation_id
        AND installation.creator_id = gateway.creator_id
      WHERE gateway.id = $1 AND gateway.creator_id = $2
        AND gateway.installation_id = $3 AND gateway.connection_id = $4
        AND gateway.state = 'ACTIVE'
        AND gateway.expires_at > clock_timestamp() + interval '3 seconds'
        AND challenge.state = 'CONSUMED'
        AND deployment.environment = 'TEST'
        AND deployment.desired_state = 'ONLINE'
        AND deployment.observed_state = 'ONLINE'
        AND deployment.observed_worker_id = gateway.installation_id
        AND deployment.observed_generation = deployment.generation
        AND deployment.lease_fence = lease.fence
        AND lease.state = 'ACTIVE'
        AND lease.expires_at > clock_timestamp() + interval '3 seconds'
        AND installation.revoked_at IS NULL
      FOR UPDATE OF gateway, lease, deployment, installation`,
    [
      session.workerSessionId,
      session.ownerId,
      session.installationId,
      session.connectionId,
      deploymentId,
    ],
    signal,
  );
  const row = found.rows[0];
  if (row === undefined || registrationDigest(row) !== row.registration_digest) {
    throw new PostgresGatewayAuthorityError('LEASE_UNAVAILABLE');
  }
  return row;
}

async function lockConversationOpenCommand(
  transaction: GatewayTransaction,
  session: AuthenticatedWorkerSession,
  candidate: BrokerCommandCandidateRow,
  current: BrokerPublisherCurrentAuthorityRow,
  signal: AbortSignal,
): Promise<BrokerConversationOpenRow> {
  const found = await transaction.query<BrokerConversationOpenRow>(
    `SELECT command.command_id::text, conversation.id::text AS conversation_id,
            conversation.agent_version_id::text,
            conversation.version_digest AS agent_version_digest,
            snapshot.snapshot_digest,
            command.visible_transcript_digest,
            command.original_worker_session_id::text,
            command.assignment_lease_id::text,
            command.assignment_fence,
            date_trunc('milliseconds', transaction_timestamp()) AS wire_sent_at,
            date_trunc(
              'milliseconds',
              LEAST(
                command.expires_at,
                $5::timestamptz,
                $6::timestamptz
              )
            ) AS wire_expires_at
       FROM broker_outbox AS command
       JOIN agent_conversations AS conversation
         ON conversation.id = command.conversation_id
        AND conversation.creator_id = command.creator_id
        AND conversation.consumer_subject_id = command.consumer_subject_id
        AND conversation.deployment_id = command.deployment_id
        AND conversation.assigned_worker_id = command.target_worker_id
       JOIN agent_versions AS version
         ON version.id = conversation.agent_version_id
        AND version.creator_id = conversation.creator_id
        AND version.version_digest = conversation.version_digest
       JOIN context_snapshots AS snapshot
         ON snapshot.id = version.snapshot_id
        AND snapshot.creator_id = version.creator_id
       JOIN worker_gateway_sessions AS original_session
         ON original_session.id = command.original_worker_session_id
        AND original_session.creator_id = command.creator_id
        AND original_session.installation_id = command.target_worker_id
        AND original_session.connection_id = command.original_connection_id
       JOIN worker_leases AS original_lease
         ON original_lease.id = command.assignment_lease_id
        AND original_lease.deployment_id = command.deployment_id
        AND original_lease.creator_id = command.creator_id
        AND original_lease.worker_id = command.target_worker_id
        AND original_lease.connection_id = command.original_connection_id
        AND original_lease.fence = command.assignment_fence
      WHERE command.command_id = $1 AND command.creator_id = $2
        AND command.target_worker_id = $3 AND command.deployment_id = $4
        AND command.payload_contract_version = 1
        AND command.command_type = 'conversation.open'
        AND command.state IN ('PENDING', 'SENT')
        AND command.attempt_count < 100
        AND command.next_attempt_at <= transaction_timestamp()
        AND command.expires_at > clock_timestamp()
        AND LEAST(command.expires_at, $5::timestamptz, $6::timestamptz)
            > clock_timestamp() + interval '3 seconds'
        AND conversation.state = 'OPENING'
        AND NOT EXISTS (
          SELECT 1
            FROM broker_outbox AS competing_command
            JOIN agent_conversations AS competing_conversation
              ON competing_conversation.id = competing_command.conversation_id
             AND competing_conversation.creator_id = competing_command.creator_id
             AND competing_conversation.consumer_subject_id = competing_command.consumer_subject_id
           WHERE competing_command.creator_id = command.creator_id
             AND competing_command.command_id <> command.command_id
             AND competing_command.payload_contract_version = 1
             AND competing_command.command_type = 'conversation.open'
             AND competing_command.state IN ('PENDING', 'SENT')
             AND competing_command.expires_at > clock_timestamp()
             AND competing_conversation.state = 'OPENING'
             AND (
               competing_command.state = 'SENT'
               OR EXISTS (
                 SELECT 1
                   FROM worker_gateway_outbound_frames AS competing_delivery
                  WHERE competing_delivery.creator_id = competing_command.creator_id
                    AND competing_delivery.broker_command_id = competing_command.command_id
                    AND competing_delivery.delivery_contract_version = 1
                    AND competing_delivery.durable_ack_level IS DISTINCT FROM 'CLOUD_COMMITTED'
               )
               OR (
                 command.state = 'PENDING'
                 AND competing_command.state = 'PENDING'
                 AND (competing_command.created_at, competing_command.command_id)
                     < (command.created_at, command.command_id)
               )
             )
        )
      FOR UPDATE OF command`,
    [
      candidate.command_id,
      session.ownerId,
      session.installationId,
      candidate.deployment_id,
      isoDate(current.session_expires_at),
      isoDate(current.lease_expires_at),
    ],
    signal,
  );
  const row = found.rows[0];
  if (row === undefined) throw new NoBrokerCommandAvailable();
  return row;
}

async function lockExistingBrokerDelivery(
  transaction: GatewayTransaction,
  session: AuthenticatedWorkerSession,
  commandId: string,
  signal: AbortSignal,
): Promise<ExistingBrokerDeliveryRow | undefined> {
  const found = await transaction.query<ExistingBrokerDeliveryRow>(
    `SELECT sequence, canonical_digest, durable_ack_level, wire_sent_at, wire_expires_at,
            wire_expires_at > clock_timestamp() + interval '1 second' AS wire_retryable
       FROM worker_gateway_outbound_frames
      WHERE session_id = $1 AND creator_id = $2 AND broker_command_id = $3
        AND delivery_contract_version = 1
      FOR UPDATE`,
    [session.workerSessionId, session.ownerId, commandId],
    signal,
  );
  return found.rows[0];
}

async function findCurrentBrokerPersistedAckReceipt(
  transaction: GatewayTransaction,
  session: AuthenticatedWorkerSession,
  commandId: string,
  signal: AbortSignal,
): Promise<BrokerPersistedAckReceiptRow | undefined> {
  const found = await transaction.query<BrokerPersistedAckReceiptRow>(
    `SELECT committed_at
       FROM worker_gateway_frame_receipts
      WHERE session_id = $1 AND creator_id = $2
        AND broker_acknowledged_message_id = $3
        AND envelope_type = 'message.ack'
        AND broker_ack_level = 'PERSISTED'
        AND broker_ack_decision = 'APPLIED'
      ORDER BY committed_at
      LIMIT 1`,
    [session.workerSessionId, session.ownerId, commandId],
    signal,
  );
  return found.rows[0];
}

function materializeConversationOpenEnvelope(input: {
  session: AuthenticatedWorkerSession;
  deploymentId: string;
  current: BrokerPublisherCurrentAuthorityRow;
  command: BrokerConversationOpenRow;
  sequence: string;
  sentAt: string;
  expiresAt: string;
}): BrokerEnvelope {
  return BrokerConversationOpenCommandSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'command',
    type: 'conversation.open',
    messageId: input.command.command_id,
    correlationId: input.command.conversation_id,
    connectionId: input.session.connectionId,
    sequence: input.sequence,
    sentAt: input.sentAt,
    expiresAt: input.expiresAt,
    lease: {
      deploymentId: input.deploymentId,
      leaseId: input.current.lease_id,
      workerSessionId: input.session.workerSessionId,
      fence: parseUint63(input.current.lease_fence),
    },
    body: {
      conversationId: input.command.conversation_id,
      agentVersionId: input.command.agent_version_id,
      agentVersionDigest: input.command.agent_version_digest,
      snapshotDigest: input.command.snapshot_digest,
      visibleTranscriptDigest: input.command.visible_transcript_digest,
      openAuthority: {
        deploymentId: input.deploymentId,
        installationId: input.session.installationId,
        workerSessionId: input.command.original_worker_session_id,
        leaseId: input.command.assignment_lease_id,
        fence: parseUint63(input.command.assignment_fence),
      },
    },
  });
}

async function persistBrokerConversationOpen(
  transaction: GatewayTransaction,
  session: AuthenticatedWorkerSession,
  current: BrokerPublisherCurrentAuthorityRow,
  command: BrokerConversationOpenRow,
  envelope: BrokerEnvelope,
  canonicalDigest: string,
  persistedAck: BrokerPersistedAckReceiptRow | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (envelope.type !== 'conversation.open') throw persistenceFailure();
  const inserted = await transaction.query(
    `INSERT INTO worker_gateway_outbound_frames (
       session_id, creator_id, sequence, message_id, canonical_digest, envelope_type,
       delivery_contract_version, broker_command_id, broker_target_worker_id,
       broker_deployment_id, claim_session_id, claim_connection_id,
       current_delivery_lease_id, current_delivery_fence, wire_sent_at, wire_expires_at,
       durable_ack_level, ack_decision, acked_at
     ) VALUES (
       $1, $2, $3, $4, $5, 'conversation.open',
       1, $4, $6, $7, $1, $8, $9, $10, $11::timestamptz, $12::timestamptz,
       $13, $14, $15::timestamptz
     )`,
    [
      session.workerSessionId,
      session.ownerId,
      parseUint63(envelope.sequence),
      command.command_id,
      canonicalDigest,
      session.installationId,
      envelope.lease.deploymentId,
      session.connectionId,
      current.lease_id,
      parseUint63(current.lease_fence),
      envelope.sentAt,
      envelope.expiresAt,
      persistedAck === undefined ? null : 'PERSISTED',
      persistedAck === undefined ? null : 'APPLIED',
      persistedAck === undefined ? null : isoDate(persistedAck.committed_at),
    ],
    signal,
  );
  if (inserted.rowCount !== 1) throw persistenceFailure();
}

async function acknowledgeLeaseGrant(
  transaction: GatewayTransaction,
  session: AuthenticatedWorkerSession,
  lease: SessionLeaseRow,
  grantMessageId: string,
  grantExpiresAt: string,
  signal: AbortSignal,
): Promise<void> {
  const acknowledged = await transaction.query(
    `UPDATE worker_gateway_outbound_frames
        SET durable_ack_level = 'PERSISTED', ack_decision = 'APPLIED',
            acked_at = statement_timestamp()
      WHERE session_id = $1 AND creator_id = $2 AND message_id = $3
        AND envelope_type = 'lease.grant'
        AND grant_lease_id = $4 AND grant_fence = $5
        AND grant_expires_at = $6::timestamptz
        AND durable_ack_level IS NULL AND ack_decision IS NULL AND acked_at IS NULL`,
    [
      session.workerSessionId,
      session.ownerId,
      UuidSchema.parse(grantMessageId),
      lease.lease_id,
      parseUint63(lease.lease_fence),
      IsoDateTimeSchema.parse(grantExpiresAt),
    ],
    signal,
  );
  if (acknowledged.rowCount !== 1) {
    throw new PostgresGatewayAuthorityError('OUTBOUND_ACK_CONFLICT');
  }
}

async function lockSession(
  transaction: GatewayTransaction,
  session: AuthenticatedWorkerSession,
  signal: AbortSignal,
): Promise<SessionRow> {
  const found = await transaction.query<SessionRow>(
    `SELECT id::text, creator_id::text, installation_id::text, challenge_id::text,
            connection_id::text,
            registration_digest, state, inbound_next_seq, outbound_next_seq, expires_at,
            (state = 'ACTIVE' AND expires_at > statement_timestamp()) AS alive
       FROM worker_gateway_sessions
      WHERE id = $1 AND creator_id = $2 AND installation_id = $3 AND connection_id = $4
      FOR UPDATE`,
    [session.workerSessionId, session.ownerId, session.installationId, session.connectionId],
    signal,
  );
  const row = found.rows[0];
  if (row === undefined || row.state !== 'ACTIVE' || row.alive !== true) {
    throw new PostgresGatewayAuthorityError('SESSION_UNAVAILABLE');
  }
  return row;
}

async function lockSessionAndLease(
  transaction: GatewayTransaction,
  session: AuthenticatedWorkerSession,
  envelope: BrokerEnvelope,
  signal: AbortSignal,
): Promise<SessionLeaseRow> {
  const invocationRoute = envelopeInvocationRoute(envelope);
  const invocationId = invocationRoute?.invocationId;
  const found = await transaction.query<SessionLeaseDatabaseRow>(
    `SELECT gateway.id::text, gateway.creator_id::text, gateway.installation_id::text,
            gateway.challenge_id::text,
            gateway.connection_id::text, gateway.registration_digest, gateway.state,
            gateway.inbound_next_seq,
            gateway.outbound_next_seq, gateway.expires_at,
            (gateway.state = 'ACTIVE' AND gateway.expires_at > statement_timestamp()) AS alive,
            lease.id::text AS lease_id, lease.deployment_id::text, lease.fence AS lease_fence,
            lease.state AS lease_state, lease.expires_at AS lease_expires_at,
            (lease.expires_at > statement_timestamp()) AS lease_alive,
            deployment.lease_fence AS deployment_fence,
            deployment.observed_worker_id::text,
            deployment.desired_state,
            deployment.desired_version_id::text,
            deployment.serving_version_id::text,
            deployment.generation AS deployment_generation,
            deployment.observed_generation,
            deployment.observed_state,
            installation.worker_version, installation.protocol_versions,
            installation.capabilities, installation.revoked_at,
            desired_control.availability AS desired_version_availability,
            desired_control.severity AS desired_version_severity,
            desired_control.reason_code AS desired_version_reason_code,
            serving_control.availability AS serving_version_availability,
            serving_control.severity AS serving_version_severity,
            serving_control.reason_code AS serving_version_reason_code,
            invocation.id::text AS pinned_invocation_id,
            pinned_control.availability AS pinned_version_availability,
            pinned_control.severity AS pinned_version_severity,
            pinned_control.reason_code AS pinned_version_reason_code
       FROM worker_gateway_sessions AS gateway
       JOIN worker_leases AS lease
         ON lease.creator_id = gateway.creator_id
        AND lease.worker_id = gateway.installation_id
        AND lease.connection_id = gateway.connection_id
       JOIN deployments AS deployment
         ON deployment.id = lease.deployment_id
        AND deployment.creator_id = lease.creator_id
       JOIN worker_installations AS installation
         ON installation.id = gateway.installation_id
        AND installation.creator_id = gateway.creator_id
       LEFT JOIN agent_version_controls AS desired_control
         ON desired_control.version_id = deployment.desired_version_id
        AND desired_control.creator_id = deployment.creator_id
       LEFT JOIN agent_version_controls AS serving_control
         ON serving_control.version_id = deployment.serving_version_id
        AND serving_control.creator_id = deployment.creator_id
       LEFT JOIN agent_invocations AS invocation
         ON invocation.id = $8
        AND invocation.creator_id = deployment.creator_id
        AND invocation.assigned_worker_id = gateway.installation_id
        AND EXISTS (
          SELECT 1
            FROM agent_conversations AS invocation_conversation
           WHERE invocation_conversation.id = invocation.conversation_id
             AND invocation_conversation.creator_id = invocation.creator_id
             AND invocation_conversation.consumer_subject_id = invocation.consumer_subject_id
             AND invocation_conversation.deployment_id = deployment.id
        )
        AND (
          NOT $9::boolean
          OR (
            invocation.assignment_lease_id = lease.id
            AND invocation.assignment_fence = lease.fence
          )
        )
       LEFT JOIN agent_version_controls AS pinned_control
         ON pinned_control.version_id = invocation.agent_version_id
        AND pinned_control.creator_id = invocation.creator_id
      WHERE gateway.id = $1 AND gateway.creator_id = $2
        AND gateway.installation_id = $3 AND gateway.connection_id = $4
        AND lease.id = $5 AND lease.deployment_id = $6 AND lease.fence = $7
      FOR UPDATE OF gateway, lease, deployment, installation`,
    [
      session.workerSessionId,
      session.ownerId,
      session.installationId,
      session.connectionId,
      envelope.lease.leaseId,
      envelope.lease.deploymentId,
      parseUint63(envelope.lease.fence),
      invocationId ?? null,
      invocationRoute?.requiresCurrentAssignment ?? false,
    ],
    signal,
  );
  const row = found.rows[0];
  if (
    row === undefined ||
    row.alive !== true ||
    row.lease_state !== 'ACTIVE' ||
    row.lease_alive !== true ||
    parseUint63(row.lease_fence) !== parseUint63(row.deployment_fence) ||
    row.observed_worker_id !== session.installationId ||
    registrationDigest(row) !== row.registration_digest ||
    (invocationId !== undefined && row.pinned_invocation_id !== invocationId)
  ) {
    throw new PostgresGatewayAuthorityError('LEASE_UNAVAILABLE');
  }
  const activePinned = await transaction.query<{ blocked: boolean }>(
    `WITH locked_invocations AS MATERIALIZED (
       SELECT invocation.id, invocation.agent_version_id
         FROM agent_invocations AS invocation
        WHERE invocation.creator_id = $1
          AND invocation.assignment_lease_id = $2
          AND invocation.assigned_worker_id = $3
          AND invocation.assignment_fence = $4
          AND invocation.state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN', 'EXPIRED')
        ORDER BY invocation.id
     )
     SELECT EXISTS (
       SELECT 1
         FROM locked_invocations AS invocation
         LEFT JOIN agent_version_controls AS control
           ON control.version_id = invocation.agent_version_id
          AND control.creator_id = $1
        WHERE control.version_id IS NULL
           OR control.availability = 'REVOKED'
           OR control.severity = 'SECURITY'
     ) AS blocked`,
    [session.ownerId, row.lease_id, session.installationId, parseUint63(row.lease_fence)],
    signal,
  );
  const activePinnedVersionBlocked = activePinned.rows[0]?.blocked;
  if (activePinnedVersionBlocked === undefined) throw persistenceFailure();
  return { ...row, active_pinned_version_blocked: activePinnedVersionBlocked };
}

type EnvelopeInvocationRoute = Readonly<{
  invocationId: string;
  requiresCurrentAssignment: boolean;
}>;

function envelopeInvocationRoute(envelope: BrokerEnvelope): EnvelopeInvocationRoute | undefined {
  if (envelope.type === 'heartbeat') {
    return envelope.body.activeInvocationId === null
      ? undefined
      : {
          invocationId: envelope.body.activeInvocationId,
          requiresCurrentAssignment: true,
        };
  }
  if (envelope.kind === 'event' && envelope.type.startsWith('invocation.')) {
    const body = envelope.body as { invocationId?: unknown };
    return body.invocationId === undefined
      ? undefined
      : {
          invocationId: UuidSchema.parse(body.invocationId),
          requiresCurrentAssignment: false,
        };
  }
  return undefined;
}

type LeaseBlockDisposition = Readonly<{
  revokeReason: LeaseRevokeReason;
  observedState: 'OFFLINE' | 'BLOCKED';
  errorCode:
    | 'DEPLOYMENT_OFFLINE'
    | 'INSTALLATION_REVOKED'
    | 'VERSION_SECURITY_REVOKED'
    | 'WORKER_FACT_CONFLICT';
}>;

const WORKER_FACT_CONFLICT_SECURITY_DISPOSITION = Object.freeze({
  revokeReason: 'SECURITY',
  observedState: 'BLOCKED',
  errorCode: 'WORKER_FACT_CONFLICT',
} as const satisfies LeaseBlockDisposition);

/**
 * A committed business security decision has one fail-closed Gateway disposition. Transport
 * sequence conflicts never enter this mapper and retain their distinct receipt/audit outcome.
 */
export function gatewayBusinessSecurityIsolation(decision: GatewayProjectionDecision):
  | Readonly<{
      revokeReason: 'SECURITY';
      observedState: 'BLOCKED';
      errorCode: 'WORKER_FACT_CONFLICT';
    }>
  | undefined {
  return decision === 'SECURITY_BLOCK' ? WORKER_FACT_CONFLICT_SECURITY_DISPOSITION : undefined;
}

function leaseBlockDisposition(lease: SessionLeaseRow): LeaseBlockDisposition | undefined {
  if (lease.revoked_at !== null) {
    return {
      revokeReason: 'INSTALLATION_REVOKED',
      observedState: 'BLOCKED',
      errorCode: 'INSTALLATION_REVOKED',
    };
  }
  if (
    lease.observed_state === 'BLOCKED' ||
    lease.desired_version_availability === null ||
    lease.desired_version_availability === 'REVOKED' ||
    lease.desired_version_severity === 'SECURITY' ||
    (lease.serving_version_id !== null &&
      (lease.serving_version_availability === null ||
        lease.serving_version_availability === 'REVOKED' ||
        lease.serving_version_severity === 'SECURITY')) ||
    (lease.pinned_invocation_id !== null &&
      (lease.pinned_version_availability === null ||
        lease.pinned_version_availability === 'REVOKED' ||
        lease.pinned_version_severity === 'SECURITY')) ||
    lease.active_pinned_version_blocked
  ) {
    return {
      revokeReason: 'SECURITY',
      observedState: 'BLOCKED',
      errorCode: 'VERSION_SECURITY_REVOKED',
    };
  }
  if (lease.desired_state !== 'ONLINE') {
    // The current schema has no persisted DRAIN/IMMEDIATE mode. Fail closed as
    // IMMEDIATE; a later append-only migration may add an explicit drain deadline.
    return {
      revokeReason: 'IMMEDIATE',
      observedState: 'OFFLINE',
      errorCode: 'DEPLOYMENT_OFFLINE',
    };
  }
  return undefined;
}

async function revokeLeaseAuthority(
  transaction: GatewayTransaction,
  session: AuthenticatedWorkerSession,
  lease: SessionLeaseRow,
  disposition: LeaseBlockDisposition,
  signal: AbortSignal,
): Promise<void> {
  const revoked = await transaction.query(
    `UPDATE worker_leases
        SET state = 'REVOKED'
      WHERE id = $1 AND creator_id = $2 AND worker_id = $3
        AND connection_id = $4 AND fence = $5 AND state = 'ACTIVE'
        AND expires_at > statement_timestamp()`,
    [
      lease.lease_id,
      session.ownerId,
      session.installationId,
      session.connectionId,
      parseUint63(lease.lease_fence),
    ],
    signal,
  );
  if (revoked.rowCount !== 1) throw new PostgresGatewayAuthorityError('LEASE_UNAVAILABLE');
  // The migration-owned definer holds the same Deployment advisory lock as
  // capability issuance and performs one cross-Consumer UPDATE. Do not rebuild
  // that authority with application-side Consumer enumeration.
  const capabilityRevocation = await transaction.query<{
    revoked_count: string | number | bigint;
  }>(
    `SELECT public.creator_agent_security_revoke_deployment_capabilities(
       $1::uuid, $2::uuid
     ) AS revoked_count`,
    [session.ownerId, lease.deployment_id],
    signal,
  );
  const revokedCapabilities = capabilityRevocation.rows[0]?.revoked_count;
  if (revokedCapabilities === undefined) throw persistenceFailure();
  parseUint63(revokedCapabilities);
  const observed = await transaction.query(
    `UPDATE deployments
        SET observed_state = $4, observed_generation = generation,
            last_error_code = $5, updated_at = statement_timestamp()
      WHERE id = $1 AND creator_id = $2 AND lease_fence = $3
        AND observed_worker_id = $6`,
    [
      lease.deployment_id,
      session.ownerId,
      parseUint63(lease.lease_fence),
      disposition.observedState,
      disposition.errorCode,
      session.installationId,
    ],
    signal,
  );
  if (observed.rowCount !== 1) throw persistenceFailure();
}

async function renewLease(
  transaction: GatewayTransaction,
  session: AuthenticatedWorkerSession,
  lease: SessionLeaseRow,
  leaseTtlMs: number,
  signal: AbortSignal,
): Promise<string> {
  const renewed = await transaction.query<{ expires_at: Date | string }>(
    `UPDATE worker_leases AS lease
        SET renewed_at = statement_timestamp(),
            expires_at = GREATEST(
              lease.expires_at,
              statement_timestamp() + ($6::bigint * interval '1 millisecond')
            )
      WHERE lease.id = $1 AND lease.creator_id = $2 AND lease.worker_id = $3
        AND lease.connection_id = $4 AND lease.fence = $5 AND lease.state = 'ACTIVE'
        AND lease.expires_at > statement_timestamp()
        AND EXISTS (
          SELECT 1
            FROM deployments AS deployment
            JOIN agent_version_controls AS desired_control
              ON desired_control.version_id = deployment.desired_version_id
             AND desired_control.creator_id = deployment.creator_id
            LEFT JOIN agent_version_controls AS serving_control
              ON serving_control.version_id = deployment.serving_version_id
             AND serving_control.creator_id = deployment.creator_id
           WHERE deployment.id = lease.deployment_id
             AND deployment.creator_id = lease.creator_id
             AND deployment.lease_fence = lease.fence
             AND deployment.observed_worker_id = lease.worker_id
             AND desired_control.availability <> 'REVOKED'
             AND desired_control.severity <> 'SECURITY'
             AND (
               deployment.serving_version_id IS NULL
               OR (
                 serving_control.version_id IS NOT NULL
                 AND serving_control.availability <> 'REVOKED'
                 AND serving_control.severity <> 'SECURITY'
               )
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM agent_invocations AS invocation
                 LEFT JOIN agent_version_controls AS pinned_control
                   ON pinned_control.version_id = invocation.agent_version_id
                  AND pinned_control.creator_id = invocation.creator_id
                WHERE invocation.creator_id = lease.creator_id
                  AND invocation.assignment_lease_id = lease.id
                  AND invocation.assigned_worker_id = lease.worker_id
                  AND invocation.assignment_fence = lease.fence
                  AND invocation.state NOT IN (
                    'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN', 'EXPIRED'
                  )
                  AND (
                    pinned_control.version_id IS NULL
                    OR pinned_control.availability = 'REVOKED'
                    OR pinned_control.severity = 'SECURITY'
                  )
             )
        )
      RETURNING lease.expires_at`,
    [
      lease.lease_id,
      session.ownerId,
      session.installationId,
      session.connectionId,
      parseUint63(lease.lease_fence),
      leaseTtlMs,
    ],
    signal,
  );
  const row = renewed.rows[0];
  if (renewed.rowCount !== 1 || row === undefined) {
    throw new PostgresGatewayAuthorityError('LEASE_UNAVAILABLE');
  }
  return isoDate(row.expires_at);
}

async function nextEnvelopeIdentity(
  transaction: GatewayTransaction,
  signal: AbortSignal,
): Promise<{ messageId: string; sentAt: string }> {
  const result = await transaction.query<{ message_id: string; sent_at: Date | string }>(
    `SELECT gen_uuid_v7()::text AS message_id, statement_timestamp() AS sent_at`,
    undefined,
    signal,
  );
  const row = result.rows[0];
  if (row === undefined) throw persistenceFailure();
  return { messageId: UuidSchema.parse(row.message_id), sentAt: isoDate(row.sent_at) };
}

function outboundSequenceAt(base: string | number | bigint, offset: number): string {
  const sequence = BigInt(parseUint63(base)) + BigInt(offset);
  if (sequence > MAX_UINT63) throw persistenceFailure();
  return sequence.toString();
}

async function persistOutbound(
  transaction: GatewayTransaction,
  session: AuthenticatedWorkerSession,
  envelope: BrokerEnvelope,
  signal: AbortSignal,
): Promise<void> {
  const inserted = await transaction.query(
    `INSERT INTO worker_gateway_outbound_frames (
       session_id, creator_id, sequence, message_id, canonical_digest, envelope_type,
       grant_lease_id, grant_fence, grant_expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
    [
      session.workerSessionId,
      session.ownerId,
      parseUint63(envelope.sequence),
      envelope.messageId,
      canonicalSha256(envelope),
      envelope.type,
      envelope.type === 'lease.grant' ? envelope.lease.leaseId : null,
      envelope.type === 'lease.grant' ? parseUint63(envelope.lease.fence) : null,
      envelope.type === 'lease.grant' ? envelope.body.leaseExpiresAt : null,
    ],
    signal,
  );
  if (inserted.rowCount !== 1) throw persistenceFailure();
}

async function advanceOutbound(
  transaction: GatewayTransaction,
  session: AuthenticatedWorkerSession,
  expected: string | number | bigint,
  signal: AbortSignal,
): Promise<void> {
  const result = await transaction.query(
    `UPDATE worker_gateway_sessions
        SET outbound_next_seq = outbound_next_seq + 1
      WHERE id = $1 AND creator_id = $2 AND connection_id = $3
        AND outbound_next_seq = $4 AND outbound_next_seq < 9223372036854775807`,
    [session.workerSessionId, session.ownerId, session.connectionId, parseUint63(expected)],
    signal,
  );
  if (result.rowCount !== 1) throw persistenceFailure();
}

async function recordSequenceConflict(
  transaction: GatewayTransaction,
  session: AuthenticatedWorkerSession,
  sequence: string,
  existing: ReceiptRow,
  receivedMessageId: string,
  receivedDigest: string,
  signal: AbortSignal,
): Promise<void> {
  const inserted = await transaction.query(
    `INSERT INTO worker_gateway_security_events (
       session_id, creator_id, existing_sequence, sequence, event_type,
       existing_message_id, received_message_id,
       existing_canonical_digest, received_canonical_digest
     ) VALUES ($1, $2, $3, $4, 'SEQUENCE_CONFLICT', $5, $6, $7, $8)
     ON CONFLICT DO NOTHING`,
    [
      session.workerSessionId,
      session.ownerId,
      parseUint63(existing.sequence),
      parseUint63(sequence),
      existing.message_id,
      UuidSchema.parse(receivedMessageId),
      existing.canonical_digest,
      z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .parse(receivedDigest),
    ],
    signal,
  );
  if (inserted.rowCount !== 0 && inserted.rowCount !== 1) throw persistenceFailure();
}

function parseStoredResponses(value: unknown): readonly BrokerEnvelope[] {
  const parsed = AcceptResponseBatchSchema.safeParse(value);
  if (!parsed.success) throw persistenceFailure();
  return parsed.data;
}

function parseSession(session: AuthenticatedWorkerSession): AuthenticatedWorkerSession {
  return Object.freeze({
    ownerId: UuidSchema.parse(session.ownerId),
    installationId: UuidSchema.parse(session.installationId),
    connectionId: UuidSchema.parse(session.connectionId),
    workerSessionId: UuidSchema.parse(session.workerSessionId),
  });
}

function matchGatewayWorkerCompatibility(
  policy: ParsedGatewayCompatibilityPolicy,
  handshake: BrokerHandshake,
  registration: GatewayWorkerCompatibilityRegistration,
): WorkerCompatibilityErrorCode | undefined {
  const registeredProtocols = RegisteredProtocolVersionsSchema.safeParse(
    registration.protocolVersions,
  );
  const registeredCapabilities = BrokerRegistrationCapabilitiesSchema.safeParse(
    registration.capabilities,
  );
  const runtimePolicy = RuntimePolicySchema.safeParse(registration.runtimePolicy);
  if (!registeredProtocols.success) return 'WORKER_REGISTRATION_INCOMPATIBLE';
  if (!registeredCapabilities.success) {
    return hasInvalidOrMissingBrokerContractDigest(registration.capabilities)
      ? 'BROKER_CONTRACT_INCOMPATIBLE'
      : 'WORKER_REGISTRATION_INCOMPATIBLE';
  }
  if (handshake.brokerContractDigest !== registeredCapabilities.data.brokerContractDigest) {
    return 'BROKER_CONTRACT_INCOMPATIBLE';
  }
  if (handshake.workerVersion !== registration.workerVersion) {
    return 'WORKER_VERSION_INCOMPATIBLE';
  }
  if (
    canonicalSha256(handshake.supportedProtocolVersions) !==
    canonicalSha256(registeredProtocols.data)
  ) {
    return 'PROTOCOL_INCOMPATIBLE';
  }
  if (
    !exactStringSet(
      handshake.codexRuntimeArtifacts,
      registeredCapabilities.data.codexRuntimeArtifacts,
    )
  ) {
    return 'CODEX_RUNTIME_INCOMPATIBLE';
  }
  if (
    !exactStringSet(
      handshake.codexProtocolSchemaDigests,
      registeredCapabilities.data.codexProtocolSchemaDigests,
    )
  ) {
    return 'CODEX_PROTOCOL_INCOMPATIBLE';
  }
  if (!exactStringSet(handshake.isolationModes, registeredCapabilities.data.isolationModes)) {
    return 'ISOLATION_INCOMPATIBLE';
  }

  const profile = exactGatewayWorkerProfiles(policy).find(
    ({ workerVersion }) => workerVersion === handshake.workerVersion,
  );
  if (profile === undefined) return 'WORKER_VERSION_INCOMPATIBLE';
  if (handshake.brokerContractDigest !== profile.brokerContractDigest) {
    return 'BROKER_CONTRACT_INCOMPATIBLE';
  }
  if (
    handshake.supportedProtocolVersions.length !== 1 ||
    handshake.supportedProtocolVersions[0] !== profile.protocolVersion
  ) {
    return 'PROTOCOL_INCOMPATIBLE';
  }
  if (
    !exactStringSet(handshake.codexRuntimeArtifacts, [profile.codexRuntimeArtifact]) ||
    registration.codexRuntimeArtifactDigest !== profile.codexRuntimeArtifact
  ) {
    return 'CODEX_RUNTIME_INCOMPATIBLE';
  }
  if (
    !exactStringSet(handshake.codexProtocolSchemaDigests, [profile.codexProtocolSchemaDigest]) ||
    registration.codexProtocolSchemaDigest !== profile.codexProtocolSchemaDigest
  ) {
    return 'CODEX_PROTOCOL_INCOMPATIBLE';
  }
  if (
    !runtimePolicy.success ||
    !exactStringSet(handshake.isolationModes, [profile.isolationMode])
  ) {
    return 'ISOLATION_INCOMPATIBLE';
  }
  return undefined;
}

function exactGatewayWorkerProfiles(
  policy: ParsedGatewayCompatibilityPolicy,
): readonly ExactGatewayWorkerProfile[] {
  const sharedBrokerContract = policy.acceptedBrokerContractDigests.length === 1;
  return policy.acceptedWorkerVersions.map((workerVersion, index) => ({
    workerVersion,
    protocolVersion: 1,
    codexRuntimeArtifact: policy.acceptedCodexRuntimeArtifacts[index]!,
    codexProtocolSchemaDigest: policy.acceptedCodexProtocolSchemaDigests[index]!,
    isolationMode: policy.acceptedIsolationModes[index]!,
    brokerContractDigest: policy.acceptedBrokerContractDigests[sharedBrokerContract ? 0 : index]!,
  }));
}

function rowVersionIsReady(row: SessionLeaseRow): boolean {
  return (
    row.serving_version_id === row.desired_version_id &&
    row.observed_generation !== null &&
    parseUint63(row.observed_generation) === parseUint63(row.deployment_generation)
  );
}

function registrationDigest(row: InstallationRegistrationRow): string {
  const protocolVersions = RegisteredProtocolVersionsSchema.parse(row.protocol_versions);
  const capabilities = BrokerRegistrationCapabilitiesSchema.parse(row.capabilities);
  return canonicalSha256({
    workerVersion: z.string().min(1).max(128).parse(row.worker_version),
    protocolVersions,
    capabilities,
  });
}

function hasInvalidOrMissingBrokerContractDigest(capabilities: unknown): boolean {
  return (
    typeof capabilities !== 'object' ||
    capabilities === null ||
    !Sha256DigestSchema.safeParse(Reflect.get(capabilities, 'brokerContractDigest')).success
  );
}

function p256PublicKeyFromUncompressedPoint(point: Buffer) {
  if (point.byteLength !== 65 || point[0] !== 4) {
    throw new BrokerAuthenticationError(BrokerAuthenticationFailureCode.AUTHENTICATION_REJECTED);
  }
  try {
    return createPublicKey({
      key: Buffer.concat([P256_UNCOMPRESSED_SPKI_PREFIX, point]),
      format: 'der',
      type: 'spki',
    });
  } catch {
    throw new BrokerAuthenticationError(BrokerAuthenticationFailureCode.AUTHENTICATION_REJECTED);
  }
}

function exactStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const orderedLeft = [...left].sort();
  const orderedRight = [...right].sort();
  return orderedLeft.every((value, index) => value === orderedRight[index]);
}

function isoDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw persistenceFailure();
  return date.toISOString();
}

function parseUint63(value: string | number | bigint): string {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw persistenceFailure();
  }
  if (parsed < 0n || parsed > MAX_UINT63) throw persistenceFailure();
  return parsed.toString(10);
}

function ackRank(value: string | null): number {
  switch (value) {
    case null:
      return 0;
    case 'RECEIVED':
      return 1;
    case 'PERSISTED':
      return 2;
    case 'CLOUD_COMMITTED':
      return 3;
    default:
      throw persistenceFailure();
  }
}

function persistenceFailure(): PostgresGatewayAuthorityError {
  return new PostgresGatewayAuthorityError('PERSISTENCE_INVARIANT_FAILED');
}

function aborted(): DOMException {
  return new DOMException('gateway database operation aborted', 'AbortError');
}
