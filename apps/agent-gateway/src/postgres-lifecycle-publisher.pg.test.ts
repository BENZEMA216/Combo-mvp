import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';

import {
  BrokerEnvelopeSchema,
  BrokerHandshakeUnsignedSchema,
  BrokerSensitiveMessageSchema,
  brokerHandshakeSigningBytes,
  brokerSensitiveMessageAadDigest,
  brokerSensitiveMessageCipherDigest,
  canonicalSha256,
  canonicalizeJson,
  currentBrokerContractDigest,
  executionCapabilityDigest,
  workerInvocationFactDigest,
  type BrokerEnvelope,
  type BrokerHandshake,
  type BrokerSensitiveMessage,
  type WorkerInvocationPreparedFact,
} from '@cb/creator-agent-protocol';
import { PostgresCloudJournal, type JournalPool } from '@cb/creator-agent-persistence';
import { Client, Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AuthenticatedWorkerSession, GatewayDelivery } from './gateway.js';
import type { GatewayUserMessageSealer } from './lifecycle-outbound.js';
import {
  PostgresAgentGatewayAuthority,
  type GatewayCompatibilityPolicy,
  type GatewayConnection,
  type GatewayPool,
  type GatewayQueryResult,
} from './postgres-authority.js';
import { PostgresGatewayBusinessEventProjector } from './postgres-business-event-projector.js';
import { checkBrokerDatabaseReady } from './runtime.js';

const requested = process.env.CREATOR_AGENT_GATEWAY_LIFECYCLE_PG_TEST === '1';
const isolated = process.env.CREATOR_AGENT_GATEWAY_LIFECYCLE_PG_ISOLATED === '1';
const databaseUrl = process.env.CREATOR_AGENT_GATEWAY_LIFECYCLE_PG_URL;
if (requested && (!isolated || databaseUrl === undefined || databaseUrl.length === 0)) {
  throw new Error('CREATOR_AGENT_GATEWAY_LIFECYCLE_PG_TEST_REQUIRES_DEDICATED_ISOLATED_DATABASE');
}
const enabled = requested && isolated && databaseUrl !== undefined;
const pgDescribe = enabled ? describe.sequential : describe.skip;

const WORKER_VERSION = 'combo-worker-lifecycle-pg/1';
const RUNTIME_DIGEST = `sha256:${'a'.repeat(64)}`;
const PROTOCOL_DIGEST = `sha256:${'b'.repeat(64)}`;
const BROKER_CONTRACT_DIGEST = currentBrokerContractDigest();
const ISOLATED_CLUSTER_NAME = 'combo-vnext-r3-ephemeral';
const TEST_RUNTIME_POLICY = Object.freeze({
  schemaVersion: 1,
  isolation: 'conversation-vm-required',
  filesystem: {
    context: 'read-only-noexec',
    scratch: 'conversation-only',
    hostMounts: 'forbidden',
  },
  contextTools: ['read_context', 'list_context', 'search_context'],
  projectExecution: 'forbidden',
  network: 'model-proxy-only',
  externalTools: 'disabled',
  hostCredentials: 'forbidden',
  maxTurnSeconds: 120,
  maxConversationTurns: 20,
  maxVisibleHistoryBytes: 65_536,
  maxActiveTurns: 1,
  resolvedModel: 'gpt-5.6-sol',
  reasoningEffort: 'low',
} as const);

function randomUuidV7(): string {
  const value = randomUUID();
  return `${value.slice(0, 14)}7${value.slice(15)}`;
}

function digest(marker: string): string {
  return marker.repeat(64);
}

function creatorAccount(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return `creator-${[...randomBytes(8)].map((value) => alphabet[value % 32]).join('')}`;
}

function publicPoint(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new Error('P-256 public key did not expose affine coordinates');
  }
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  if (x.byteLength !== 32 || y.byteLength !== 32) throw new Error('invalid P-256 point');
  return Buffer.concat([Buffer.from([0x04]), x, y]);
}

function signedHandshake(
  privateKey: KeyObject,
  installationId: string,
  challengeId: string,
): BrokerHandshake {
  const unsigned = BrokerHandshakeUnsignedSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    installationId,
    workerVersion: WORKER_VERSION,
    supportedProtocolVersions: [1],
    codexRuntimeArtifacts: [RUNTIME_DIGEST],
    codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
    isolationModes: ['apple-container-v1'],
    brokerContractDigest: BROKER_CONTRACT_DIGEST,
    capacity: { maxActiveConversations: 1, maxActiveTurns: 1 },
    challengeId,
  });
  return {
    ...unsigned,
    challengeSignature: sign('sha256', brokerHandshakeSigningBytes(unsigned), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url'),
  };
}

function delivery(envelope: BrokerEnvelope): GatewayDelivery {
  return Object.freeze({ envelope, canonicalDigest: canonicalSha256(envelope) });
}

class SessionAuthorizationPool implements GatewayPool, JournalPool {
  readonly #pool: Pool;

  constructor(
    connectionString: string,
    readonly role: 'combo_agent_api' | 'combo_agent_broker',
  ) {
    this.#pool = new Pool({ connectionString, max: 8 });
  }

  async connect(): Promise<GatewayConnection> {
    const client = await this.#pool.connect();
    try {
      await client.query(`SET SESSION AUTHORIZATION ${this.role}`);
    } catch (error) {
      client.release(true);
      throw error;
    }
    return {
      query: <Row>(sql: string, parameters?: readonly unknown[], signal?: AbortSignal) =>
        queryWithSignal<Row>(client, sql, parameters, signal),
      // Destroying the physical owner connection avoids ever returning a role-switched socket to
      // the pool. No cluster-global role LOGIN/password mutation is needed for this gate.
      release: () => client.release(true),
    };
  }

  async end(): Promise<void> {
    await this.#pool.end();
  }
}

async function queryWithSignal<Row>(
  client: PoolClient,
  sql: string,
  parameters?: readonly unknown[],
  signal?: AbortSignal,
): Promise<GatewayQueryResult<Row>> {
  signal?.throwIfAborted();
  const result = await client.query(sql, parameters as unknown[]);
  signal?.throwIfAborted();
  return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
}

class CommitResponseLossPool implements GatewayPool {
  #loseNextCommit = false;

  constructor(private readonly delegate: GatewayPool) {}

  arm(): void {
    this.#loseNextCommit = true;
  }

  async connect(): Promise<GatewayConnection> {
    const connection = await this.delegate.connect();
    let released = false;
    return {
      query: async <Row>(sql: string, parameters?: readonly unknown[], signal?: AbortSignal) => {
        if (sql !== 'COMMIT' || !this.#loseNextCommit) {
          return connection.query<Row>(sql, parameters, signal);
        }
        this.#loseNextCommit = false;
        await connection.query<Row>(sql, parameters, signal);
        connection.release(true);
        released = true;
        throw new Error('simulated socket loss after PostgreSQL COMMIT');
      },
      release: (destroy = false): void => {
        if (released) return;
        released = true;
        connection.release(destroy);
      },
    };
  }
}

function createTransportSealer() {
  let seals = 0;
  return vi.fn<GatewayUserMessageSealer>(async (input): Promise<BrokerSensitiveMessage> => {
    seals += 1;
    const nonce = Buffer.alloc(12, seals).toString('base64url');
    const ciphertext = Buffer.from(`pg-sealed-${seals}`, 'utf8').toString('base64url');
    const authTag = Buffer.alloc(16, seals + 8).toString('base64url');
    const aad = {
      protocol: 'combo.creator-broker/1' as const,
      schemaVersion: 1 as const,
      envelopeType: 'invocation.prepare' as const,
      messageId: input.command.messageId,
      conversationId: input.command.conversationId,
      invocationId: input.command.invocationId,
      workerSessionId: input.command.workerSessionId,
      role: 'USER' as const,
      keyId: 'worker-session-pg-1',
    };
    return BrokerSensitiveMessageSchema.parse({
      algorithm: 'aes-256-gcm/v1',
      keyScope: 'worker-session',
      keyId: aad.keyId,
      nonce,
      ciphertext,
      authTag,
      cipherDigest: brokerSensitiveMessageCipherDigest(nonce, ciphertext, authTag),
      aad,
      aadDigest: brokerSensitiveMessageAadDigest(aad),
      aadVersion: 1,
    });
  });
}

pgDescribe('Postgres lifecycle payload-v2 vertical', () => {
  const owner = new Client({ connectionString: databaseUrl });
  const apiRole = new SessionAuthorizationPool(databaseUrl ?? '', 'combo_agent_api');
  const brokerRole = new SessionAuthorizationPool(databaseUrl ?? '', 'combo_agent_broker');
  const lossyBrokerRole = new CommitResponseLossPool(brokerRole);
  const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ids = {
    creator: '',
    snapshot: randomUuidV7(),
    agent: randomUuidV7(),
    version: randomUuidV7(),
    deployment: randomUuidV7(),
    installation: randomUuidV7(),
    conversation: randomUuidV7(),
  };
  const policy: GatewayCompatibilityPolicy = {
    acceptedWorkerVersions: [WORKER_VERSION],
    acceptedCodexRuntimeArtifacts: [RUNTIME_DIGEST],
    acceptedCodexProtocolSchemaDigests: [PROTOCOL_DIGEST],
    acceptedIsolationModes: ['apple-container-v1'],
    acceptedBrokerContractDigests: [BROKER_CONTRACT_DIGEST],
    publisherDeploymentAllowlist: [ids.deployment],
    sessionTtlMs: 15 * 60_000,
    leaseTtlMs: 60_000,
    responseTtlMs: 30_000,
    transactionTimeoutMs: 5_000,
  };
  const sealUserMessage = createTransportSealer();
  const journal = new PostgresCloudJournal({
    api: apiRole,
    broker: brokerRole,
  });
  const projector = new PostgresGatewayBusinessEventProjector(journal);
  const authority = new PostgresAgentGatewayAuthority(
    { api: apiRole, broker: brokerRole },
    policy,
    projector,
    undefined,
    sealUserMessage,
  );
  const lossyAuthority = new PostgresAgentGatewayAuthority(
    { api: apiRole, broker: lossyBrokerRole },
    policy,
    projector,
    undefined,
    sealUserMessage,
  );
  let originalSession: AuthenticatedWorkerSession;
  let originalLease: Extract<BrokerEnvelope, { type: 'lease.grant' }>;

  async function connectWorker(): Promise<{
    session: AuthenticatedWorkerSession;
    lease: Extract<BrokerEnvelope, { type: 'lease.grant' }>;
  }> {
    const generation = await owner.query<{ generation: string }>(
      `SELECT generation::text FROM deployments WHERE id = $1`,
      [ids.deployment],
    );
    const challenge = await authority.issueChallenge({
      creatorId: ids.creator,
      installationId: ids.installation,
      deploymentId: ids.deployment,
      deploymentGeneration: generation.rows[0]!.generation,
      operationId: randomUuidV7(),
      signal: AbortSignal.timeout(5_000),
    });
    const session = await authority.authenticate({
      handshake: signedHandshake(keyPair.privateKey, ids.installation, challenge.challengeId),
      connectedAt: new Date().toISOString(),
      signal: AbortSignal.timeout(5_000),
    });
    const opened = await authority.openSession(session, AbortSignal.timeout(5_000));
    const lease = opened[0];
    if (lease?.type !== 'lease.grant') throw new Error('expected lease.grant');
    await owner.query(
      `UPDATE deployments
          SET serving_version_id = desired_version_id,
              observed_state = 'ONLINE', observed_worker_id = $2,
              observed_generation = generation, updated_at = clock_timestamp()
        WHERE id = $1 AND creator_id = $3`,
      [ids.deployment, ids.installation, ids.creator],
    );
    return { session, lease };
  }

  beforeAll(async () => {
    await owner.connect();
    const cluster = await owner.query<{ cluster_name: string }>(`SHOW cluster_name`);
    if (cluster.rows[0]?.cluster_name !== ISOLATED_CLUSTER_NAME) {
      throw new Error('CREATOR_AGENT_GATEWAY_LIFECYCLE_PG_CLUSTER_NOT_ISOLATED');
    }
    ids.creator = (
      await owner.query<{ id: string }>(
        `INSERT INTO users (account) VALUES ($1) RETURNING id::text`,
        [creatorAccount()],
      )
    ).rows[0]!.id;
    await owner.query(
      `INSERT INTO context_snapshots (
         id, creator_id, snapshot_digest, archive_digest, cipher_digest,
         object_key, manifest_object_key, compressed_bytes, expanded_bytes,
         file_count, encryption_key_ref
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 128, 256, 1, $8)`,
      [
        ids.snapshot,
        ids.creator,
        digest('1'),
        digest('2'),
        digest('3'),
        `lifecycle/${ids.snapshot}.archive.enc`,
        `lifecycle/${ids.snapshot}.manifest.enc`,
        `kms://${ids.snapshot}`,
      ],
    );
    await owner.query(
      `INSERT INTO agents (id, creator_id, public_slug, name)
       VALUES ($1, $2, $3, 'Lifecycle PG Agent')`,
      [ids.agent, ids.creator, `lifecycle-${ids.agent.slice(0, 8)}`],
    );
    await owner.query(
      `INSERT INTO agent_versions (
         id, agent_id, creator_id, ordinal, schema_version, version_digest, snapshot_id,
         behavior_contract, behavior_contract_digest, runtime_policy, runtime_policy_digest,
         io_contract, io_contract_digest, model_policy, model_policy_digest,
         codex_runtime_version, codex_runtime_artifact_digest, codex_protocol_schema_digest
       ) VALUES (
         $1, $2, $3, 1, 1, $4, $5,
         '{}'::jsonb, $6, $7::jsonb, $8, '{}'::jsonb, $9, '{}'::jsonb, $10,
         '0.147.0-lifecycle-pg', $11, $12
       )`,
      [
        ids.version,
        ids.agent,
        ids.creator,
        digest('7'),
        ids.snapshot,
        digest('4'),
        JSON.stringify(TEST_RUNTIME_POLICY),
        digest('5'),
        digest('6'),
        digest('8'),
        RUNTIME_DIGEST,
        PROTOCOL_DIGEST,
      ],
    );
    await owner.query(
      `INSERT INTO agent_version_controls (version_id, creator_id) VALUES ($1, $2)`,
      [ids.version, ids.creator],
    );
    await owner.query(
      `INSERT INTO deployments (
         id, agent_id, creator_id, environment, desired_state, desired_version_id, generation
       ) VALUES ($1, $2, $3, 'TEST', 'ONLINE', $4, 1)`,
      [ids.deployment, ids.agent, ids.creator, ids.version],
    );
    await owner.query(
      `INSERT INTO worker_installations (
         id, creator_id, installation_key_id, device_public_key,
         worker_version, protocol_versions, capabilities
       ) VALUES ($1, $2, $3, $4, $5, '[1]'::jsonb, $6::jsonb)`,
      [
        ids.installation,
        ids.creator,
        `lifecycle-key-${ids.installation}`,
        publicPoint(keyPair.publicKey),
        WORKER_VERSION,
        JSON.stringify({
          codexRuntimeArtifacts: [RUNTIME_DIGEST],
          codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
          isolationModes: ['apple-container-v1'],
          brokerContractDigest: BROKER_CONTRACT_DIGEST,
        }),
      ],
    );
    ({ session: originalSession, lease: originalLease } = await connectWorker());
    await owner.query(
      `INSERT INTO agent_conversations (
         id, agent_id, deployment_id, agent_version_id, creator_id,
         consumer_subject_id, version_digest, state, assigned_worker_id,
         next_turn_no, expires_at, idempotency_key, request_digest
       ) VALUES ($1, $2, $3, $4, $5, $5, $6, 'IDLE', $7, 1,
                 statement_timestamp() + interval '1 hour', $8, $9)`,
      [
        ids.conversation,
        ids.agent,
        ids.deployment,
        ids.version,
        ids.creator,
        digest('7'),
        ids.installation,
        randomUuidV7(),
        randomBytes(32).toString('hex'),
      ],
    );
  }, 30_000);

  afterAll(async () => {
    if (originalSession !== undefined) {
      await authority.closeSession(originalSession, 'SERVER_STOPPED').catch(() => undefined);
    }
    await Promise.all([owner.end(), apiRole.end(), brokerRole.end()]);
  });

  it('passes the executable readiness probe as the isolated Broker role without ledger access', async () => {
    await expect(
      checkBrokerDatabaseReady(
        brokerRole as unknown as Parameters<typeof checkBrokerDatabaseReady>[0],
        AbortSignal.timeout(5_000),
      ),
    ).resolves.toBeUndefined();

    const broker = await brokerRole.connect();
    try {
      const identity = await broker.query<{ session_user: string; current_user: string }>(
        `SELECT session_user, current_user`,
      );
      expect(identity.rows).toEqual([
        { session_user: 'combo_agent_broker', current_user: 'combo_agent_broker' },
      ]);
      await expect(broker.query(`SELECT 1 FROM schema_migrations LIMIT 1`)).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      broker.release(true);
    }
  });

  it('claims prepare/start with exact replay, replacement re-seal, RLS ref read, and tamper gates', async () => {
    const clientMessageId = randomUUID();
    const requestDigest = `hmac-sha256:${digest('d')}`;
    const consumer = new Client({ connectionString: databaseUrl });
    await consumer.connect();
    let invocationId = '';
    let prepareCommandId = '';
    let capability: ReturnType<typeof buildCapability>;
    try {
      await consumer.query(`SET SESSION AUTHORIZATION combo_agent_consumer_api`);
      await consumer.query('BEGIN');
      await consumer.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.creator]);
      const preflight = await consumer.query<{
        outcome: string;
        deployment_id: string;
        agent_version_id: string;
        agent_version_digest: string;
        installation_id: string;
        lease_id: string;
        fence: string;
        capability_not_before: Date;
        capability_expires_at: Date;
        resolved_model: string;
        reasoning_effort: string;
      }>(`SELECT * FROM creator_agent_preflight_consumer_message_v2($1, $2, $3, $4)`, [
        ids.conversation,
        ids.creator,
        clientMessageId,
        requestDigest,
      ]);
      expect(preflight.rows[0]?.outcome).toBe('READY');
      const authorityRow = preflight.rows[0]!;
      invocationId = randomUuidV7();
      prepareCommandId = randomUuidV7();
      capability = buildCapability({
        capabilityId: randomUuidV7(),
        invocationId,
        conversationId: ids.conversation,
        deploymentId: authorityRow.deployment_id,
        agentVersionId: authorityRow.agent_version_id,
        agentVersionDigest: authorityRow.agent_version_digest,
        installationId: authorityRow.installation_id,
        leaseId: authorityRow.lease_id,
        fence: String(authorityRow.fence),
        requestDigest,
        model: authorityRow.resolved_model,
        reasoningEffort: authorityRow.reasoning_effort,
        notBefore: authorityRow.capability_not_before.toISOString(),
        expiresAt: authorityRow.capability_expires_at.toISOString(),
      });
      const nonce = randomBytes(12);
      const ciphertext = Buffer.from('durable local pg user message', 'utf8');
      const authTag = randomBytes(16);
      const cipherDigest = createHash('sha256')
        .update(nonce)
        .update(ciphertext)
        .update(authTag)
        .digest('hex');
      const finalized = await consumer.query<{ finalize_outcome: string }>(
        `SELECT * FROM creator_agent_finalize_consumer_message_v2(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20
         )`,
        [
          ids.conversation,
          ids.creator,
          randomUuidV7(),
          invocationId,
          prepareCommandId,
          randomUuidV7(),
          randomUuidV7(),
          randomUuidV7(),
          clientMessageId,
          requestDigest,
          'aes-256-gcm/v1',
          'owner-message-pg-1',
          nonce,
          ciphertext,
          authTag,
          cipherDigest,
          `hmac-sha256:${digest('e')}`,
          1,
          JSON.stringify(capability),
          executionCapabilityDigest(capability),
        ],
      );
      expect(finalized.rows).toEqual([
        expect.objectContaining({
          finalize_outcome: 'ADMITTED',
          invocation_id: invocationId,
          outbox_command_id: prepareCommandId,
        }),
      ]);
      await consumer.query('COMMIT');
    } catch (error) {
      await consumer.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await consumer.end();
    }

    lossyBrokerRole.arm();
    const first = await lossyAuthority.claimBrokerCommand(
      originalSession,
      AbortSignal.timeout(10_000),
    );
    if (first?.type !== 'invocation.prepare') throw new Error('expected prepare');
    expect(sealUserMessage).toHaveBeenCalledTimes(1);
    const firstCanonicalText = canonicalizeJson(first);

    const rls = await brokerRole.connect();
    try {
      const unset = await rls.query(
        `SELECT 1 FROM worker_gateway_outbound_frames
          WHERE session_id = $1 AND broker_command_id = $2`,
        [originalSession.workerSessionId, prepareCommandId],
      );
      expect(unset.rowCount).toBe(0);
      await rls.query('BEGIN READ ONLY');
      await rls.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creator]);
      const exact = await rls.query(
        `SELECT 1 FROM worker_gateway_outbound_frames
          WHERE session_id = $1 AND broker_command_id = $2`,
        [originalSession.workerSessionId, prepareCommandId],
      );
      expect(exact.rowCount).toBe(1);
      await rls.query('ROLLBACK');
    } finally {
      rls.release(true);
    }

    await waitForRetryDue(owner, prepareCommandId);
    const replay = await authority.claimBrokerCommand(originalSession, AbortSignal.timeout(10_000));
    expect(replay).toEqual(first);
    expect(canonicalizeJson(replay)).toBe(firstCanonicalText);
    expect(sealUserMessage).toHaveBeenCalledTimes(1);

    const originalAck = persistedAck(
      originalSession,
      originalLease,
      prepareCommandId,
      invocationId,
      '0',
    );
    await expect(
      authority.acceptEnvelope(originalSession, delivery(originalAck), AbortSignal.timeout(10_000)),
    ).resolves.toEqual([]);

    const replacement = await connectWorker();
    const earlyAck = persistedAck(
      replacement.session,
      replacement.lease,
      prepareCommandId,
      invocationId,
      '0',
    );
    await expect(
      authority.acceptEnvelope(
        replacement.session,
        delivery(earlyAck),
        AbortSignal.timeout(10_000),
      ),
    ).resolves.toEqual([]);
    await waitForRetryDue(owner, prepareCommandId);
    const reframed = await authority.claimBrokerCommand(
      replacement.session,
      AbortSignal.timeout(10_000),
    );
    if (reframed?.type !== 'invocation.prepare') throw new Error('expected replacement prepare');
    expect(sealUserMessage).toHaveBeenCalledTimes(2);
    expect(reframed.body.executionCapability).toEqual(first.body.executionCapability);
    expect(reframed.body.userMessageCiphertext).not.toEqual(first.body.userMessageCiphertext);
    expect(reframed.body.userMessageCiphertext.aad.workerSessionId).toBe(
      replacement.session.workerSessionId,
    );

    const preparedFact = {
      protocol: 'combo.worker-invocation-fact/1',
      schemaVersion: 1,
      type: 'invocation.prepared',
      sourceEventId: prepareCommandId,
      invocationId,
      agentVersionDigest: digest('7'),
      snapshotDigest: digest('1'),
      executionCapabilityDigest: executionCapabilityDigest(capability!),
      leaseId: originalLease.lease.leaseId,
      fence: originalLease.lease.fence,
      requestDigest,
      prepareCommandId,
    } as const satisfies WorkerInvocationPreparedFact;
    const prepared = invocationPrepared(replacement.session, replacement.lease, '1', preparedFact);
    await expect(
      authority.acceptEnvelope(
        replacement.session,
        delivery(prepared),
        AbortSignal.timeout(10_000),
      ),
    ).resolves.toHaveLength(1);

    const startRow = await owner.query<{
      command_id: string;
      execution_capability_wire: unknown;
      execution_capability_digest: string;
    }>(
      `SELECT command_id::text, execution_capability_wire, execution_capability_digest
         FROM broker_outbox
        WHERE invocation_id = $1 AND command_type = 'invocation.start'`,
      [invocationId],
    );
    if (startRow.rows.length !== 1) {
      const evidence = await owner.query<{
        invocation_state: string;
        reconciliation_reason: string | null;
        assignment_lease_id: string;
        assignment_lease_state: string;
        replacement_lease_id: string;
        replacement_lease_state: string;
        capability_revoked: boolean;
      }>(
        `SELECT invocation.state AS invocation_state,
                invocation.reconciliation_reason,
                invocation.assignment_lease_id::text,
                assignment_lease.state AS assignment_lease_state,
                replacement_lease.id::text AS replacement_lease_id,
                replacement_lease.state AS replacement_lease_state,
                invocation.execution_capability_revoked_at IS NOT NULL AS capability_revoked
           FROM agent_invocations AS invocation
           JOIN worker_leases AS assignment_lease
             ON assignment_lease.id = invocation.assignment_lease_id
           JOIN worker_leases AS replacement_lease
             ON replacement_lease.id = $2
          WHERE invocation.id = $1`,
        [invocationId, replacement.lease.lease.leaseId],
      );
      throw new Error(
        `LIFECYCLE_REPLACEMENT_START_NOT_DURABLE:${JSON.stringify(evidence.rows[0] ?? null)}`,
      );
    }
    expect(startRow.rows).toHaveLength(1);
    expect(startRow.rows[0]?.execution_capability_wire).toEqual(capability!);
    expect(startRow.rows[0]?.execution_capability_digest).toBe(
      executionCapabilityDigest(capability!),
    );
    const start = await authority.claimBrokerCommand(
      replacement.session,
      AbortSignal.timeout(10_000),
    );
    expect(start).toMatchObject({
      type: 'invocation.start',
      messageId: startRow.rows[0]!.command_id,
      body: {
        invocationId,
        prepareCommandId,
        executionCapabilityId: capability!.capabilityId,
      },
    });
    expect(sealUserMessage).toHaveBeenCalledTimes(2);

    const durableDeliveries = await owner.query<{
      command_id: string;
      session_id: string;
      sequence: string;
      wire_canonical_text: string;
      canonical_digest: string;
      digest_matches: boolean;
    }>(
      `SELECT delivery.broker_command_id::text AS command_id,
              delivery.session_id::text,
              delivery.sequence::text,
              delivery.wire_canonical_text,
              delivery.canonical_digest,
              encode(digest(convert_to(delivery.wire_canonical_text, 'UTF8'), 'sha256'), 'hex') =
                delivery.canonical_digest AS digest_matches
         FROM worker_gateway_outbound_frames AS delivery
        WHERE delivery.broker_command_id IN ($1, $2)
          AND delivery.delivery_contract_version = 2
        ORDER BY delivery.created_at, delivery.session_id`,
      [prepareCommandId, startRow.rows[0]!.command_id],
    );
    expect(durableDeliveries.rows).toHaveLength(3);
    expect(durableDeliveries.rows.every((row) => row.digest_matches)).toBe(true);
    expect(
      new Set(durableDeliveries.rows.map((row) => `${row.session_id}:${row.command_id}`)).size,
    ).toBe(3);

    const claimReceipts = await owner.query<{ receipt: unknown }>(
      `SELECT result_value AS receipt
         FROM worker_gateway_operation_receipts
        WHERE creator_id = $1
          AND operation_kind = 'CLAIM_BROKER_COMMAND'
          AND result_value->>'commandId' IN ($2, $3)
        ORDER BY committed_at, operation_key`,
      [ids.creator, prepareCommandId, startRow.rows[0]!.command_id],
    );
    expect(claimReceipts.rows).toHaveLength(4);
    for (const row of claimReceipts.rows) {
      if (row.receipt === null || typeof row.receipt !== 'object' || Array.isArray(row.receipt)) {
        throw new TypeError('expected lifecycle claim ref');
      }
      const reference = row.receipt as Record<string, unknown>;
      expect(Object.keys(reference).sort()).toEqual([
        'canonicalDigest',
        'commandId',
        'sequence',
        'sessionId',
      ]);
      expect(JSON.stringify(reference)).not.toMatch(/cipher|body|envelope|prompt/iu);
      expect(
        durableDeliveries.rows.some(
          (deliveryRow) =>
            deliveryRow.session_id === reference.sessionId &&
            deliveryRow.command_id === reference.commandId &&
            deliveryRow.sequence === reference.sequence &&
            deliveryRow.canonical_digest === reference.canonicalDigest,
        ),
      ).toBe(true);
    }
    for (const deliveryRow of durableDeliveries.rows) {
      expect(
        claimReceipts.rows.some((receiptRow) => {
          if (
            receiptRow.receipt === null ||
            typeof receiptRow.receipt !== 'object' ||
            Array.isArray(receiptRow.receipt)
          ) {
            return false;
          }
          const reference = receiptRow.receipt as Record<string, unknown>;
          return (
            reference.sessionId === deliveryRow.session_id &&
            reference.commandId === deliveryRow.command_id &&
            reference.sequence === deliveryRow.sequence &&
            reference.canonicalDigest === deliveryRow.canonical_digest
          );
        }),
      ).toBe(true);
    }
    expect(
      durableDeliveries.rows.find((row) => row.session_id === originalSession.workerSessionId)
        ?.wire_canonical_text,
    ).toBe(firstCanonicalText);

    await expect(
      owner.query(
        `UPDATE worker_gateway_outbound_frames
            SET wire_canonical_text = NULL
          WHERE session_id = $1 AND broker_command_id = $2`,
        [originalSession.workerSessionId, prepareCommandId],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      owner.query(
        `UPDATE worker_gateway_outbound_frames
            SET wire_envelope = jsonb_set(wire_envelope, '{lease,fence}', '"999"'::jsonb)
          WHERE session_id = $1 AND broker_command_id = $2`,
        [replacement.session.workerSessionId, prepareCommandId],
      ),
    ).rejects.toMatchObject({ code: '55000' });

    await authority.closeSession(replacement.session, 'SERVER_STOPPED');
  }, 60_000);
});

function buildCapability(input: {
  capabilityId: string;
  invocationId: string;
  conversationId: string;
  deploymentId: string;
  agentVersionId: string;
  agentVersionDigest: string;
  installationId: string;
  leaseId: string;
  fence: string;
  requestDigest: string;
  model: string;
  reasoningEffort: string;
  notBefore: string;
  expiresAt: string;
}) {
  return {
    protocol: 'combo.execution-capability/1' as const,
    schemaVersion: 1 as const,
    capabilityId: input.capabilityId,
    invocationId: input.invocationId,
    conversationId: input.conversationId,
    deploymentId: input.deploymentId,
    agentVersionId: input.agentVersionId,
    agentVersionDigest: input.agentVersionDigest,
    workerInstallationId: input.installationId,
    leaseId: input.leaseId,
    fence: input.fence,
    providerRequestId: randomUuidV7(),
    requestDigest: input.requestDigest,
    model: input.model,
    reasoningEffort: input.reasoningEffort as 'low' | 'medium' | 'high' | 'xhigh',
    budget: { maxInputTokens: 64_000, maxOutputTokens: 8_192, maxCostMicros: 5_000_000 },
    notBefore: input.notBefore,
    expiresAt: input.expiresAt,
    nonce: randomBytes(32).toString('base64url'),
    signatureAlgorithm: 'ES256' as const,
    signatureEncoding: 'ieee-p1363' as const,
    signature: Buffer.alloc(64).toString('base64url'),
  };
}

function persistedAck(
  session: AuthenticatedWorkerSession,
  lease: Extract<BrokerEnvelope, { type: 'lease.grant' }>,
  commandId: string,
  invocationId: string,
  sequence: string,
): Extract<BrokerEnvelope, { type: 'message.ack' }> {
  const sentAt = new Date().toISOString();
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'ack',
    type: 'message.ack',
    messageId: randomUuidV7(),
    correlationId: invocationId,
    connectionId: session.connectionId,
    sequence,
    sentAt,
    expiresAt: new Date(Date.parse(sentAt) + 30_000).toISOString(),
    lease: lease.lease,
    body: { acknowledgedMessageId: commandId, level: 'PERSISTED', decision: 'APPLIED' },
  }) as Extract<BrokerEnvelope, { type: 'message.ack' }>;
}

function invocationPrepared(
  session: AuthenticatedWorkerSession,
  lease: Extract<BrokerEnvelope, { type: 'lease.grant' }>,
  sequence: string,
  fact: WorkerInvocationPreparedFact,
): Extract<BrokerEnvelope, { type: 'invocation.prepared' }> {
  const sentAt = new Date().toISOString();
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'event',
    type: 'invocation.prepared',
    messageId: randomUuidV7(),
    correlationId: fact.prepareCommandId,
    connectionId: session.connectionId,
    sequence,
    sentAt,
    expiresAt: new Date(Date.parse(sentAt) + 30_000).toISOString(),
    lease: lease.lease,
    body: { ...fact, factDigest: workerInvocationFactDigest(fact) },
  }) as Extract<BrokerEnvelope, { type: 'invocation.prepared' }>;
}

async function waitForRetryDue(owner: Client, commandId: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const due = await owner.query<{ due: boolean }>(
      `SELECT next_attempt_at <= clock_timestamp() AS due
         FROM broker_outbox WHERE command_id = $1`,
      [commandId],
    );
    if (due.rows[0]?.due === true) return;
    if (Date.now() >= deadline) throw new Error('LIFECYCLE_PUBLISHER_RETRY_TIMEOUT');
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}
