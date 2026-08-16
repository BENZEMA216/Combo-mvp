import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';

import {
  BrokerEnvelopeSchema,
  BrokerHandshakeUnsignedSchema,
  brokerConversationOpenLogicalCommand,
  brokerConversationOpenLogicalDigest,
  brokerHandshakeSigningBytes,
  canonicalSha256,
  currentBrokerContractDigest,
  workerConversationReadyFactDigest,
  type BrokerEnvelope,
  type BrokerHandshake,
} from '@cb/creator-agent-protocol';
import {
  type AssistantMessageSealer,
  type PostgresCloudJournal,
} from '@cb/creator-agent-persistence';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresGatewayBusinessEventProjector } from './postgres-business-event-projector.js';
import {
  PostgresAgentGatewayAuthority,
  toGatewayPool,
  type GatewayCompatibilityPolicy,
  type GatewayConnection,
  type GatewayPool,
} from './postgres-authority.js';
import type { AuthenticatedWorkerSession, GatewayDelivery } from './gateway.js';

const databaseUrl = process.env.DATABASE_URL;
const apiPassword = process.env.POSTGRES_AGENT_API_PASSWORD;
const brokerPassword = process.env.POSTGRES_AGENT_BROKER_PASSWORD;
const enabled =
  process.env.CREATOR_AGENT_GATEWAY_PG_TEST === '1' &&
  Boolean(databaseUrl && apiPassword && brokerPassword);
const pgDescribe = enabled ? describe.sequential : describe.skip;

const WORKER_VERSION = 'combo-worker-publisher-pg/1';
const RUNTIME_DIGEST = `sha256:${'a'.repeat(64)}`;
const PROTOCOL_DIGEST = `sha256:${'b'.repeat(64)}`;
const BROKER_CONTRACT_DIGEST = currentBrokerContractDigest();
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

function roleUrl(role: 'combo_agent_api' | 'combo_agent_broker', password: string): string {
  const url = new URL(databaseUrl ?? 'postgresql://invalid:invalid@127.0.0.1:1/invalid');
  url.username = role;
  url.password = password;
  return url.toString();
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

class CommitResponseLossPool implements GatewayPool {
  #loseNextCommit = false;

  public constructor(private readonly delegate: GatewayPool) {}

  public arm(): void {
    this.#loseNextCommit = true;
  }

  public async connect(): Promise<GatewayConnection> {
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

pgDescribe('Postgres Broker Outbox publisher', () => {
  const owner = new Client({ connectionString: databaseUrl });
  const apiPool = new Pool({
    connectionString: roleUrl('combo_agent_api', apiPassword ?? 'invalid'),
    max: 2,
  });
  const brokerPool = new Pool({
    connectionString: roleUrl('combo_agent_broker', brokerPassword ?? 'invalid'),
    max: 4,
  });
  const apiGatewayPool = toGatewayPool(apiPool);
  const brokerGatewayPool = toGatewayPool(brokerPool);
  const lossyBrokerPool = new CommitResponseLossPool(brokerGatewayPool);
  const policy: GatewayCompatibilityPolicy = {
    acceptedWorkerVersions: [WORKER_VERSION],
    acceptedCodexRuntimeArtifacts: [RUNTIME_DIGEST],
    acceptedCodexProtocolSchemaDigests: [PROTOCOL_DIGEST],
    acceptedIsolationModes: ['apple-container-v1'],
    acceptedBrokerContractDigests: [BROKER_CONTRACT_DIGEST],
    sessionTtlMs: 15 * 60_000,
    leaseTtlMs: 60_000,
    responseTtlMs: 30_000,
    transactionTimeoutMs: 2_000,
  };
  const lifecycle = {
    projectPrepared: async () => {
      throw new Error('invocation projector must not run in publisher phase A');
    },
    projectStarted: async () => {
      throw new Error('invocation projector must not run in publisher phase A');
    },
    projectSuccess: async () => {
      throw new Error('invocation projector must not run in publisher phase A');
    },
    projectFailed: async () => {
      throw new Error('invocation projector must not run in publisher phase A');
    },
  } satisfies Pick<
    PostgresCloudJournal,
    'projectPrepared' | 'projectStarted' | 'projectSuccess' | 'projectFailed'
  >;
  const unavailableSealer: AssistantMessageSealer = () => {
    throw new Error('terminal sealer must not run in publisher phase A');
  };
  const projector = new PostgresGatewayBusinessEventProjector(lifecycle, unavailableSealer);
  const authority = new PostgresAgentGatewayAuthority(
    { api: apiGatewayPool, broker: brokerGatewayPool },
    policy,
    projector,
  );
  const lossyAuthority = new PostgresAgentGatewayAuthority(
    { api: apiGatewayPool, broker: lossyBrokerPool },
    policy,
    projector,
  );
  const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const secondaryKeyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ids = {
    creator: '',
    consumer: '',
    snapshot: randomUuidV7(),
    agent: randomUuidV7(),
    version: randomUuidV7(),
    secondaryAgent: randomUuidV7(),
    secondaryVersion: randomUuidV7(),
    deployment: randomUuidV7(),
    installation: randomUuidV7(),
    secondaryDeployment: randomUuidV7(),
    secondaryInstallation: randomUuidV7(),
    sandbox: randomUuidV7(),
  };
  let originalSession: AuthenticatedWorkerSession;
  let originalLease: Extract<BrokerEnvelope, { type: 'lease.grant' }>;
  let replacementSession: AuthenticatedWorkerSession;
  let replacementLease: Extract<BrokerEnvelope, { type: 'lease.grant' }>;
  let secondarySession: AuthenticatedWorkerSession;
  let secondaryLease: Extract<BrokerEnvelope, { type: 'lease.grant' }>;
  let conversationId: string;
  let commandId: string;

  async function connectWorker(target?: {
    deploymentId: string;
    installationId: string;
    privateKey: KeyObject;
  }): Promise<{
    session: AuthenticatedWorkerSession;
    lease: Extract<BrokerEnvelope, { type: 'lease.grant' }>;
  }> {
    const deploymentId = target?.deploymentId ?? ids.deployment;
    const installationId = target?.installationId ?? ids.installation;
    const privateKey = target?.privateKey ?? keyPair.privateKey;
    const generation = await owner.query<{ generation: string }>(
      `SELECT generation::text FROM deployments WHERE id = $1`,
      [deploymentId],
    );
    const challenge = await authority.issueChallenge({
      creatorId: ids.creator,
      installationId,
      deploymentId,
      deploymentGeneration: generation.rows[0]!.generation,
      operationId: randomUuidV7(),
      signal: AbortSignal.timeout(5_000),
    });
    const session = await authority.authenticate({
      handshake: signedHandshake(privateKey, installationId, challenge.challengeId),
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
      [deploymentId, installationId, ids.creator],
    );
    return { session, lease };
  }

  function persistedAck(
    session: AuthenticatedWorkerSession,
    lease: Extract<BrokerEnvelope, { type: 'lease.grant' }>,
    acknowledgedMessageId: string,
  ): Extract<BrokerEnvelope, { type: 'message.ack' }> {
    const sentAt = new Date().toISOString();
    return BrokerEnvelopeSchema.parse({
      protocol: 'combo.creator-broker/1',
      schemaVersion: 1,
      kind: 'ack',
      type: 'message.ack',
      messageId: randomUuidV7(),
      correlationId: conversationId,
      connectionId: session.connectionId,
      sequence: '0',
      sentAt,
      expiresAt: new Date(Date.parse(sentAt) + 30_000).toISOString(),
      lease: lease.lease,
      body: { acknowledgedMessageId, level: 'PERSISTED', decision: 'APPLIED' },
    }) as Extract<BrokerEnvelope, { type: 'message.ack' }>;
  }

  function readyEnvelope(
    target: Readonly<{
      commandId: string;
      conversationId: string;
      sequence: string;
      sandboxInstanceId: string;
      runtimeThreadId: string;
    }> = {
      commandId,
      conversationId,
      sequence: '1',
      sandboxInstanceId: ids.sandbox,
      runtimeThreadId: 'publisher-phase-a-thread',
    },
  ): Extract<BrokerEnvelope, { type: 'conversation.ready' }> {
    const fact = Object.freeze({
      protocol: 'combo.worker-conversation-ready-fact/1',
      schemaVersion: 1,
      type: 'conversation.ready',
      sourceEventId: target.commandId,
      conversationId: target.conversationId,
      openCommandId: target.commandId,
      deploymentId: ids.deployment,
      agentVersionId: ids.version,
      agentVersionDigest: digest('7'),
      snapshotDigest: digest('1'),
      installationId: ids.installation,
      workerSessionId: originalSession.workerSessionId,
      leaseId: originalLease.lease.leaseId,
      fence: originalLease.lease.fence,
      sandboxInstanceId: target.sandboxInstanceId,
      runtimeThreadId: target.runtimeThreadId,
      readyEvidenceDigest: `sha256:${digest('e')}`,
    } as const);
    const sentAt = new Date().toISOString();
    return BrokerEnvelopeSchema.parse({
      protocol: 'combo.creator-broker/1',
      schemaVersion: 1,
      kind: 'event',
      type: 'conversation.ready',
      messageId: randomUuidV7(),
      correlationId: target.conversationId,
      connectionId: replacementSession.connectionId,
      sequence: target.sequence,
      sentAt,
      expiresAt: new Date(Date.parse(sentAt) + 30_000).toISOString(),
      lease: replacementLease.lease,
      body: { ...fact, factDigest: workerConversationReadyFactDigest(fact) },
    }) as Extract<BrokerEnvelope, { type: 'conversation.ready' }>;
  }

  beforeAll(async () => {
    await owner.connect();
    const people = await owner.query<{ id: string }>(
      `INSERT INTO users (account) VALUES ($1), ($2) RETURNING id::text`,
      [creatorAccount(), creatorAccount()],
    );
    ids.creator = people.rows[0]!.id;
    ids.consumer = people.rows[1]!.id;
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
        `publisher/${ids.snapshot}.archive.enc`,
        `publisher/${ids.snapshot}.manifest.enc`,
        `kms://${ids.snapshot}`,
      ],
    );
    await owner.query(
      `INSERT INTO agents (id, creator_id, public_slug, name)
       VALUES
         ($1, $3, $4, 'Publisher Phase A Agent'),
         ($2, $3, $5, 'Publisher Phase A Secondary Agent')`,
      [
        ids.agent,
        ids.secondaryAgent,
        ids.creator,
        `publisher-${ids.agent.slice(0, 8)}`,
        `publisher-${ids.secondaryAgent.slice(0, 8)}`,
      ],
    );
    await owner.query(
      `INSERT INTO agent_access_grants (agent_id, creator_id, consumer_subject_id)
       VALUES ($1, $3, $4), ($2, $3, $4)`,
      [ids.agent, ids.secondaryAgent, ids.creator, ids.consumer],
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
         '0.147.0-publisher-phase-a', $11, $12
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
      `INSERT INTO agent_versions (
         id, agent_id, creator_id, ordinal, schema_version, version_digest, snapshot_id,
         behavior_contract, behavior_contract_digest, runtime_policy, runtime_policy_digest,
         io_contract, io_contract_digest, model_policy, model_policy_digest,
         codex_runtime_version, codex_runtime_artifact_digest, codex_protocol_schema_digest
       ) VALUES (
         $1, $2, $3, 1, 1, $4, $5,
         '{}'::jsonb, $6, $7::jsonb, $8, '{}'::jsonb, $9, '{}'::jsonb, $10,
         '0.147.0-publisher-phase-a', $11, $12
       )`,
      [
        ids.secondaryVersion,
        ids.secondaryAgent,
        ids.creator,
        digest('f'),
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
      `INSERT INTO agent_version_controls (version_id, creator_id) VALUES ($1, $2)`,
      [ids.secondaryVersion, ids.creator],
    );
    await owner.query(
      `INSERT INTO deployments (
         id, agent_id, creator_id, environment, desired_state, desired_version_id, generation
       ) VALUES
         ($1, $3, $5, 'TEST', 'ONLINE', $6, 1),
         ($2, $4, $5, 'TEST', 'ONLINE', $7, 1)`,
      [
        ids.deployment,
        ids.secondaryDeployment,
        ids.agent,
        ids.secondaryAgent,
        ids.creator,
        ids.version,
        ids.secondaryVersion,
      ],
    );
    await owner.query(
      `INSERT INTO worker_installations (
         id, creator_id, installation_key_id, device_public_key,
         worker_version, protocol_versions, capabilities
       ) VALUES
         ($1, $3, $4, $5, $6, '[1]'::jsonb, $8::jsonb),
         ($2, $3, $7, $9, $6, '[1]'::jsonb, $8::jsonb)`,
      [
        ids.installation,
        ids.secondaryInstallation,
        ids.creator,
        `publisher-key-${ids.installation}`,
        publicPoint(keyPair.publicKey),
        WORKER_VERSION,
        `publisher-key-${ids.secondaryInstallation}`,
        JSON.stringify({
          codexRuntimeArtifacts: [RUNTIME_DIGEST],
          codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
          isolationModes: ['apple-container-v1'],
          brokerContractDigest: BROKER_CONTRACT_DIGEST,
        }),
        publicPoint(secondaryKeyPair.publicKey),
      ],
    );
    ({ session: originalSession, lease: originalLease } = await connectWorker());

    await owner.query('BEGIN');
    try {
      await owner.query('SET LOCAL ROLE combo_agent_consumer_api');
      await owner.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creator]);
      await owner.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumer]);
      const created = await owner.query<{ conversation_id: string; open_command_id: string }>(
        `SELECT conversation_id::text, open_command_id::text
           FROM creator_agent_create_opening_conversation_v2(
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 3600,
             $11, $12, 7, $13
           )`,
        [
          ids.agent,
          ids.deployment,
          ids.version,
          ids.creator,
          ids.consumer,
          randomUuidV7(),
          digest('9'),
          digest('7'),
          ids.installation,
          originalLease.lease.fence,
          `hmac-sha256:${digest('a')}`,
          'publisher-visible-key',
          'kms://publisher/visible-key@7',
        ],
      );
      conversationId = created.rows[0]!.conversation_id;
      commandId = created.rows[0]!.open_command_id;
      await owner.query('COMMIT');
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }
  }, 30_000);

  afterAll(async () => {
    for (const session of [originalSession, replacementSession, secondarySession]) {
      if (session !== undefined) {
        await authority.closeSession(session, 'SERVER_STOPPED').catch(() => undefined);
      }
    }
    await Promise.all([owner.end(), apiPool.end(), brokerPool.end()]);
  });

  it('recovers claim COMMIT loss, retries exact, re-envelopes replacement, and ACKs only on ready', async () => {
    const roleBoundary = await owner.query<{
      broker_receipt_select: boolean;
      broker_receipt_insert: boolean;
      api_receipt_select: boolean;
      api_receipt_insert: boolean;
      rls_forced: boolean;
    }>(
      `SELECT
         has_table_privilege(
           'combo_agent_broker', 'public.worker_gateway_frame_receipts', 'SELECT'
         ) AS broker_receipt_select,
         has_table_privilege(
           'combo_agent_broker', 'public.worker_gateway_frame_receipts', 'INSERT'
         ) AS broker_receipt_insert,
         has_table_privilege(
           'combo_agent_api', 'public.worker_gateway_frame_receipts', 'SELECT'
         ) AS api_receipt_select,
         has_table_privilege(
           'combo_agent_api', 'public.worker_gateway_frame_receipts', 'INSERT'
         ) AS api_receipt_insert,
         bool_and(relation.relrowsecurity AND relation.relforcerowsecurity) AS rls_forced
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname IN (
           'broker_outbox', 'worker_gateway_frame_receipts',
           'worker_gateway_outbound_frames'
         )`,
    );
    expect(roleBoundary.rows).toEqual([
      {
        broker_receipt_select: true,
        broker_receipt_insert: true,
        api_receipt_select: false,
        api_receipt_insert: false,
        rls_forced: true,
      },
    ]);
    const legacyAckMessageId = randomUuidV7();
    const legacyBroker = await brokerPool.connect();
    try {
      await legacyBroker.query('BEGIN');
      await legacyBroker.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creator]);
      await legacyBroker.query(
        `INSERT INTO worker_gateway_frame_receipts (
           session_id, creator_id, sequence, message_id, canonical_digest,
           envelope_type, response_frames
         ) VALUES ($1, $2, 9223372036854775806, $3, $4, 'message.ack', '[]'::jsonb)`,
        [originalSession.workerSessionId, ids.creator, legacyAckMessageId, digest('f')],
      );
      await legacyBroker.query('COMMIT');
    } catch (error) {
      await legacyBroker.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      legacyBroker.release();
    }
    await expect(
      owner.query<{
        broker_acknowledged_message_id: string | null;
        broker_ack_level: string | null;
        broker_ack_decision: string | null;
      }>(
        `SELECT broker_acknowledged_message_id::text, broker_ack_level, broker_ack_decision
           FROM worker_gateway_frame_receipts
          WHERE session_id = $1 AND message_id = $2`,
        [originalSession.workerSessionId, legacyAckMessageId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          broker_acknowledged_message_id: null,
          broker_ack_level: null,
          broker_ack_decision: null,
        },
      ],
    });

    lossyBrokerPool.arm();
    const first = await lossyAuthority.claimBrokerCommand(
      originalSession,
      AbortSignal.timeout(5_000),
    );
    expect(first).toMatchObject({
      type: 'conversation.open',
      messageId: commandId,
      correlationId: conversationId,
      connectionId: originalSession.connectionId,
      lease: originalLease.lease,
      body: {
        conversationId,
        visibleTranscriptDigest: `hmac-sha256:${digest('a')}`,
        openAuthority: {
          deploymentId: ids.deployment,
          installationId: ids.installation,
          workerSessionId: originalSession.workerSessionId,
          leaseId: originalLease.lease.leaseId,
          fence: originalLease.lease.fence,
        },
      },
    });
    if (first?.type !== 'conversation.open') throw new Error('expected conversation.open');
    const firstFacts = await owner.query<{
      state: string;
      attempts: number;
      deliveries: string;
      operations: string;
      wire_sent_at: Date | string;
      wire_expires_at: Date | string;
      next_attempt_at: Date | string;
      cloud_now: Date | string;
    }>(
      `SELECT command.state, command.attempt_count AS attempts,
              count(delivery.*)::text AS deliveries,
              (SELECT count(*)::text FROM worker_gateway_operation_receipts AS receipt
                WHERE receipt.creator_id = $2
                  AND receipt.operation_kind = 'CLAIM_BROKER_COMMAND') AS operations,
              min(delivery.wire_sent_at) AS wire_sent_at,
              min(delivery.wire_expires_at) AS wire_expires_at,
              command.next_attempt_at,
              statement_timestamp() AS cloud_now
         FROM broker_outbox AS command
         JOIN worker_gateway_outbound_frames AS delivery
           ON delivery.broker_command_id = command.command_id
        WHERE command.command_id = $1
        GROUP BY command.state, command.attempt_count, command.next_attempt_at`,
      [commandId, ids.creator],
    );
    expect(firstFacts.rows[0]).toMatchObject({
      state: 'SENT',
      attempts: 1,
      deliveries: '1',
      operations: '1',
    });
    expect(new Date(firstFacts.rows[0]!.wire_expires_at).getTime()).toBeGreaterThan(
      new Date(firstFacts.rows[0]!.wire_sent_at).getTime(),
    );
    const retryDelayMs =
      new Date(firstFacts.rows[0]!.next_attempt_at).getTime() -
      new Date(firstFacts.rows[0]!.cloud_now).getTime();
    expect(retryDelayMs).toBeGreaterThan(500);
    expect(retryDelayMs).toBeLessThanOrEqual(1_000);

    await waitForRetryDue(owner, commandId);
    const sameSessionRetry = await authority.claimBrokerCommand(
      originalSession,
      AbortSignal.timeout(5_000),
    );
    expect(sameSessionRetry).toEqual(first);

    const ack = persistedAck(originalSession, originalLease, commandId);
    await expect(
      authority.acceptEnvelope(originalSession, delivery(ack), AbortSignal.timeout(5_000)),
    ).resolves.toEqual([]);
    await waitForRetryDue(owner, commandId);
    await expect(
      authority.claimBrokerCommand(originalSession, AbortSignal.timeout(5_000)),
    ).resolves.toBeUndefined();
    const persisted = await owner.query<{ outbox_state: string; ack_level: string }>(
      `SELECT command.state AS outbox_state, delivery.durable_ack_level AS ack_level
         FROM broker_outbox AS command
         JOIN worker_gateway_outbound_frames AS delivery
           ON delivery.broker_command_id = command.command_id
          AND delivery.session_id = $2
        WHERE command.command_id = $1`,
      [commandId, originalSession.workerSessionId],
    );
    expect(persisted.rows).toEqual([{ outbox_state: 'SENT', ack_level: 'PERSISTED' }]);

    ({ session: secondarySession, lease: secondaryLease } = await connectWorker({
      deploymentId: ids.secondaryDeployment,
      installationId: ids.secondaryInstallation,
      privateKey: secondaryKeyPair.privateKey,
    }));
    const lateOlderConsumer = new Client({ connectionString: databaseUrl });
    await lateOlderConsumer.connect();
    let lateOlderTransactionOpen = false;
    try {
      await lateOlderConsumer.query('BEGIN');
      lateOlderTransactionOpen = true;
      await lateOlderConsumer.query('SET LOCAL ROLE combo_agent_consumer_api');
      await lateOlderConsumer.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creator]);
      await lateOlderConsumer.query(`SELECT set_config('app.consumer_id', $1, true)`, [
        ids.consumer,
      ]);
      const secondary = await lateOlderConsumer.query<{ open_command_id: string }>(
        `SELECT open_command_id::text
           FROM creator_agent_create_opening_conversation_v2(
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 3600,
             $11, $12, 9, $13
           )`,
        [
          ids.secondaryAgent,
          ids.secondaryDeployment,
          ids.secondaryVersion,
          ids.creator,
          ids.consumer,
          randomUuidV7(),
          digest('d'),
          digest('f'),
          ids.secondaryInstallation,
          secondaryLease.lease.fence,
          `hmac-sha256:${digest('e')}`,
          'publisher-visible-key-secondary',
          'kms://publisher/visible-key@9',
        ],
      );
      const secondaryCommandId = secondary.rows[0]!.open_command_id;

      let queuedCommandId: string;
      let queuedConversationId: string;
      await owner.query('BEGIN');
      try {
        await owner.query('SET LOCAL ROLE combo_agent_consumer_api');
        await owner.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creator]);
        await owner.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumer]);
        const queued = await owner.query<{
          conversation_id: string;
          open_command_id: string;
        }>(
          `SELECT conversation_id::text, open_command_id::text
             FROM creator_agent_create_opening_conversation_v2(
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 3600,
               $11, $12, 8, $13
             )`,
          [
            ids.agent,
            ids.deployment,
            ids.version,
            ids.creator,
            ids.consumer,
            randomUuidV7(),
            digest('b'),
            digest('7'),
            ids.installation,
            originalLease.lease.fence,
            `hmac-sha256:${digest('c')}`,
            'publisher-visible-key-queued',
            'kms://publisher/visible-key@8',
          ],
        );
        queuedCommandId = queued.rows[0]!.open_command_id;
        queuedConversationId = queued.rows[0]!.conversation_id;
        await owner.query('COMMIT');
      } catch (error) {
        await owner.query('ROLLBACK');
        throw error;
      }
      await expect(
        authority.claimBrokerCommand(originalSession, AbortSignal.timeout(5_000)),
      ).resolves.toBeUndefined();
      const wipBlocked = await owner.query<{ state: string; deliveries: string }>(
        `SELECT command.state, count(delivery.*)::text AS deliveries
         FROM broker_outbox AS command
         LEFT JOIN worker_gateway_outbound_frames AS delivery
           ON delivery.broker_command_id = command.command_id
        WHERE command.command_id = $1
        GROUP BY command.state`,
        [queuedCommandId],
      );
      expect(wipBlocked.rows).toEqual([{ state: 'PENDING', deliveries: '0' }]);

      ({ session: replacementSession, lease: replacementLease } = await connectWorker());
      const replacementEarlyAck = persistedAck(replacementSession, replacementLease, commandId);
      await expect(
        authority.acceptEnvelope(
          replacementSession,
          delivery(replacementEarlyAck),
          AbortSignal.timeout(5_000),
        ),
      ).resolves.toEqual([]);
      const replacement = await authority.claimBrokerCommand(
        replacementSession,
        AbortSignal.timeout(5_000),
      );
      if (replacement?.type !== 'conversation.open') {
        throw new Error('expected replacement conversation.open');
      }
      expect(replacement.messageId).toBe(first.messageId);
      expect(replacement.body).toEqual(first.body);
      expect(replacement.connectionId).toBe(replacementSession.connectionId);
      expect(replacement.lease.workerSessionId).toBe(replacementSession.workerSessionId);
      expect(replacement.lease.leaseId).toBe(replacementLease.lease.leaseId);
      expect(replacement.lease.fence).toBe(replacementLease.lease.fence);
      expect(
        brokerConversationOpenLogicalDigest(brokerConversationOpenLogicalCommand(replacement)),
      ).toBe(brokerConversationOpenLogicalDigest(brokerConversationOpenLogicalCommand(first)));
      const replacementPersisted = await owner.query<{
        outbox_state: string;
        ack_level: string;
        receipt_level: string;
        receipt_decision: string;
      }>(
        `SELECT command.state AS outbox_state,
              delivery.durable_ack_level AS ack_level,
              receipt.broker_ack_level AS receipt_level,
              receipt.broker_ack_decision AS receipt_decision
         FROM broker_outbox AS command
         JOIN worker_gateway_outbound_frames AS delivery
           ON delivery.broker_command_id = command.command_id
          AND delivery.session_id = $2
         JOIN worker_gateway_frame_receipts AS receipt
           ON receipt.session_id = delivery.session_id
          AND receipt.creator_id = delivery.creator_id
          AND receipt.broker_acknowledged_message_id = delivery.broker_command_id
        WHERE command.command_id = $1`,
        [commandId, replacementSession.workerSessionId],
      );
      expect(replacementPersisted.rows).toEqual([
        {
          outbox_state: 'SENT',
          ack_level: 'PERSISTED',
          receipt_level: 'PERSISTED',
          receipt_decision: 'APPLIED',
        },
      ]);

      const ready = readyEnvelope();
      const readyResponses = await authority.acceptEnvelope(
        replacementSession,
        delivery(ready),
        AbortSignal.timeout(5_000),
      );
      expect(readyResponses[0]).toMatchObject({
        type: 'message.ack',
        body: {
          acknowledgedMessageId: ready.messageId,
          level: 'CLOUD_COMMITTED',
          decision: 'APPLIED',
        },
      });
      const terminal = await owner.query<{ outbox_state: string; conversation_state: string }>(
        `SELECT command.state AS outbox_state, conversation.state AS conversation_state
         FROM broker_outbox AS command
         JOIN agent_conversations AS conversation ON conversation.id = command.conversation_id
        WHERE command.command_id = $1`,
        [commandId],
      );
      expect(terminal.rows).toEqual([{ outbox_state: 'ACKED', conversation_state: 'IDLE' }]);
      await expect(
        owner.query<{ state: string }>(`SELECT state FROM broker_outbox WHERE command_id = $1`, [
          queuedCommandId,
        ]),
      ).resolves.toMatchObject({ rows: [{ state: 'PENDING' }] });

      await expect(
        owner.query<{ count: string }>(
          `SELECT count(*)::text FROM broker_outbox WHERE command_id = $1`,
          [secondaryCommandId],
        ),
      ).resolves.toMatchObject({ rows: [{ count: '0' }] });
      const primaryWipClaim = await authority.claimBrokerCommand(
        replacementSession,
        AbortSignal.timeout(5_000),
      );
      expect(primaryWipClaim).toMatchObject({
        type: 'conversation.open',
        messageId: queuedCommandId,
        connectionId: replacementSession.connectionId,
      });

      await lateOlderConsumer.query('COMMIT');
      lateOlderTransactionOpen = false;
      const secondaryWipClaim = await authority.claimBrokerCommand(
        secondarySession,
        AbortSignal.timeout(5_000),
      );
      expect(secondaryWipClaim).toBeUndefined();
      const globalWipBlocked = await owner.query<{
        state: string;
        deliveries: string;
        committed_older: boolean;
      }>(
        `SELECT command.state, count(delivery.*)::text AS deliveries,
                command.created_at < claimed.created_at AS committed_older
         FROM broker_outbox AS command
         JOIN broker_outbox AS claimed ON claimed.command_id = $2
         LEFT JOIN worker_gateway_outbound_frames AS delivery
           ON delivery.broker_command_id = command.command_id
        WHERE command.command_id = $1
        GROUP BY command.state, command.created_at, claimed.created_at`,
        [secondaryCommandId, queuedCommandId],
      );
      expect(globalWipBlocked.rows).toEqual([
        { state: 'PENDING', deliveries: '0', committed_older: true },
      ]);

      await waitForRetryDue(owner, queuedCommandId);
      await expect(
        authority.claimBrokerCommand(replacementSession, AbortSignal.timeout(5_000)),
      ).resolves.toEqual(primaryWipClaim);
      const queuedReady = readyEnvelope({
        commandId: queuedCommandId,
        conversationId: queuedConversationId,
        sequence: '2',
        sandboxInstanceId: randomUuidV7(),
        runtimeThreadId: 'publisher-phase-a-late-commit-race',
      });
      await expect(
        authority.acceptEnvelope(
          replacementSession,
          delivery(queuedReady),
          AbortSignal.timeout(5_000),
        ),
      ).resolves.toMatchObject([
        {
          type: 'message.ack',
          body: {
            acknowledgedMessageId: queuedReady.messageId,
            level: 'CLOUD_COMMITTED',
            decision: 'APPLIED',
          },
        },
      ]);
      const secondaryAfterReady = await authority.claimBrokerCommand(
        secondarySession,
        AbortSignal.timeout(5_000),
      );
      expect(secondaryAfterReady).toMatchObject({
        type: 'conversation.open',
        messageId: secondaryCommandId,
        connectionId: secondarySession.connectionId,
      });
      await expect(
        owner.query<{ state: string; deliveries: string }>(
          `SELECT command.state, count(delivery.*)::text AS deliveries
             FROM broker_outbox AS command
             JOIN worker_gateway_outbound_frames AS delivery
               ON delivery.broker_command_id = command.command_id
            WHERE command.command_id = $1
            GROUP BY command.state`,
          [secondaryCommandId],
        ),
      ).resolves.toMatchObject({ rows: [{ state: 'SENT', deliveries: '1' }] });
    } finally {
      if (lateOlderTransactionOpen) {
        await lateOlderConsumer.query('ROLLBACK').catch(() => undefined);
      }
      await lateOlderConsumer.end();
    }
  }, 30_000);
});

async function waitForRetryDue(owner: Client, commandId: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const due = await owner.query<{ due: boolean }>(
      `SELECT next_attempt_at <= clock_timestamp() AS due
         FROM broker_outbox WHERE command_id = $1`,
      [commandId],
    );
    if (due.rows[0]?.due === true) return;
    if (Date.now() >= deadline) throw new Error('PUBLISHER_NATURAL_RETRY_TIMEOUT');
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}
