import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { once } from 'node:events';

import {
  BrokerAuthenticationError,
  BrokerEnvelopeSchema,
  BrokerHandshakeSchema,
  BrokerHandshakeUnsignedSchema,
  brokerHandshakeSigningBytes,
  canonicalSha256,
  canonicalizeJson,
  parseBrokerFrame,
  type BrokerEnvelope,
  type BrokerHandshake,
} from '@cb/creator-agent-protocol';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
  PostgresAgentGatewayAuthority,
  toGatewayPool,
  type GatewayCompatibilityPolicy,
  type GatewayConnection,
  type GatewayPool,
  type PostgresGatewayAuthorityError,
} from './postgres-authority.js';
import { AgentGateway, type AuthenticatedWorkerSession, type GatewayDelivery } from './gateway.js';

const databaseUrl = process.env.DATABASE_URL;
const apiPassword = process.env.POSTGRES_AGENT_API_PASSWORD;
const brokerPassword = process.env.POSTGRES_AGENT_BROKER_PASSWORD;
const enabled =
  process.env.CREATOR_AGENT_GATEWAY_PG_TEST === '1' &&
  Boolean(databaseUrl && apiPassword && brokerPassword);
const pgDescribe = enabled ? describe.sequential : describe.skip;

const WORKER_VERSION = 'combo-worker-gateway-pg/1';
const RUNTIME_DIGEST = `sha256:${'a'.repeat(64)}`;
const PROTOCOL_DIGEST = `sha256:${'b'.repeat(64)}`;
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

function digest(character: string): string {
  return character.repeat(64);
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

class CommitResponseLossPool implements GatewayPool {
  #loseNextCommit = false;

  constructor(readonly delegate: GatewayPool) {}

  arm(): void {
    if (this.#loseNextCommit) throw new Error('commit response loss already armed');
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
  overrides: Partial<{
    workerVersion: string;
    challengeSignature: string;
  }> = {},
): BrokerHandshake {
  const unsigned = BrokerHandshakeUnsignedSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    installationId,
    workerVersion: overrides.workerVersion ?? WORKER_VERSION,
    supportedProtocolVersions: [1],
    codexRuntimeArtifacts: [RUNTIME_DIGEST],
    codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
    isolationModes: ['apple-container-v1'],
    capacity: { maxActiveConversations: 1, maxActiveTurns: 1 },
    challengeId,
  });
  const challengeSignature =
    overrides.challengeSignature ??
    sign('sha256', brokerHandshakeSigningBytes(unsigned), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
  return BrokerHandshakeSchema.parse({ ...unsigned, challengeSignature });
}

function heartbeat(
  session: AuthenticatedWorkerSession,
  leaseGrant: Extract<BrokerEnvelope, { type: 'lease.grant' }>,
  sequence: bigint,
  messageId = randomUuidV7(),
): Extract<BrokerEnvelope, { type: 'heartbeat' }> {
  const sentAt = new Date().toISOString();
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'event',
    type: 'heartbeat',
    messageId,
    correlationId: leaseGrant.lease.deploymentId,
    connectionId: session.connectionId,
    sequence: sequence.toString(),
    sentAt,
    expiresAt: new Date(Date.parse(sentAt) + 30_000).toISOString(),
    lease: leaseGrant.lease,
    body: {
      workerSessionId: session.workerSessionId,
      runtimeReady: true,
      proxyReady: true,
      journalReady: true,
      activeInvocationId: null,
    },
  }) as Extract<BrokerEnvelope, { type: 'heartbeat' }>;
}

function leaseStatusEvent(
  type: 'lease.accepted' | 'lease.renewed',
  session: AuthenticatedWorkerSession,
  leaseGrant: Extract<BrokerEnvelope, { type: 'lease.grant' }>,
  sequence: bigint,
  leaseExpiresAt = leaseGrant.body.leaseExpiresAt,
): Extract<BrokerEnvelope, { type: 'lease.accepted' | 'lease.renewed' }> {
  const sentAt = new Date().toISOString();
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'event',
    type,
    messageId: randomUuidV7(),
    correlationId: leaseGrant.messageId,
    connectionId: session.connectionId,
    sequence: sequence.toString(),
    sentAt,
    expiresAt: new Date(Date.parse(sentAt) + 30_000).toISOString(),
    lease: leaseGrant.lease,
    body: { leaseExpiresAt },
  }) as Extract<BrokerEnvelope, { type: 'lease.accepted' | 'lease.renewed' }>;
}

function versionReady(
  session: AuthenticatedWorkerSession,
  leaseGrant: Extract<BrokerEnvelope, { type: 'lease.grant' }>,
  sequence: bigint,
): Extract<BrokerEnvelope, { type: 'version.ready' }> {
  const sentAt = new Date().toISOString();
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'event',
    type: 'version.ready',
    messageId: randomUuidV7(),
    correlationId: leaseGrant.lease.deploymentId,
    connectionId: session.connectionId,
    sequence: sequence.toString(),
    sentAt,
    expiresAt: new Date(Date.parse(sentAt) + 30_000).toISOString(),
    lease: leaseGrant.lease,
    body: {
      generation: leaseGrant.body.generation,
      agentVersionDigest: digest('7'),
      smokeAttestationDigest: `sha256:${'9'.repeat(64)}`,
    },
  }) as Extract<BrokerEnvelope, { type: 'version.ready' }>;
}

function delivery(envelope: BrokerEnvelope): GatewayDelivery {
  return Object.freeze({ envelope, canonicalDigest: canonicalSha256(envelope) });
}

pgDescribe('PostgresAgentGatewayAuthority real transactions', () => {
  const owner = new Client({ connectionString: databaseUrl });
  const apiPool = new Pool({
    connectionString: roleUrl('combo_agent_api', apiPassword ?? 'invalid'),
    max: 4,
  });
  const brokerPool = new Pool({
    connectionString: roleUrl('combo_agent_broker', brokerPassword ?? 'invalid'),
    max: 8,
  });
  const apiGatewayPool = toGatewayPool(apiPool);
  const brokerGatewayPool = toGatewayPool(brokerPool);
  const pools = { api: apiGatewayPool, broker: brokerGatewayPool };
  const lossyApiPool = new CommitResponseLossPool(apiGatewayPool);
  const lossyBrokerPool = new CommitResponseLossPool(brokerGatewayPool);
  const policy: GatewayCompatibilityPolicy = {
    acceptedWorkerVersions: [WORKER_VERSION],
    acceptedCodexRuntimeArtifacts: [RUNTIME_DIGEST],
    acceptedCodexProtocolSchemaDigests: [PROTOCOL_DIGEST],
    acceptedIsolationModes: ['apple-container-v1'],
    sessionTtlMs: 15 * 60_000,
    leaseTtlMs: 30_000,
    responseTtlMs: 30_000,
    transactionTimeoutMs: 2_000,
  };
  const authority = new PostgresAgentGatewayAuthority(pools, policy);
  const lossyAuthority = new PostgresAgentGatewayAuthority(
    { api: lossyApiPool, broker: lossyBrokerPool },
    policy,
  );
  const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ids = {
    creatorId: '',
    snapshotId: randomUuidV7(),
    agentId: randomUuidV7(),
    versionId: randomUuidV7(),
    deploymentId: randomUuidV7(),
    installationId: randomUuidV7(),
  };
  const challengeTarget = {
    deploymentId: ids.deploymentId,
    deploymentGeneration: '1',
  } as const;
  let firstHandshake: BrokerHandshake;
  let firstSession: AuthenticatedWorkerSession;
  let firstLease: Extract<BrokerEnvelope, { type: 'lease.grant' }>;
  let firstRenewal: Extract<BrokerEnvelope, { type: 'lease.grant' }>;
  let latestSession: AuthenticatedWorkerSession | undefined;

  beforeAll(async () => {
    await owner.connect();
    const account = creatorAccount();
    const creator = await owner.query<{ id: string }>(
      `INSERT INTO users (account) VALUES ($1) RETURNING id::text`,
      [account],
    );
    const creatorId = creator.rows[0]?.id;
    if (creatorId === undefined) throw new Error('failed to seed Gateway creator');
    ids.creatorId = creatorId;
    await owner.query(
      `INSERT INTO context_snapshots (
         id, creator_id, snapshot_digest, archive_digest, cipher_digest,
         object_key, manifest_object_key, compressed_bytes, expanded_bytes,
         file_count, encryption_key_ref
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 128, 256, 1, $8)`,
      [
        ids.snapshotId,
        ids.creatorId,
        digest('1'),
        digest('2'),
        digest('3'),
        `vnext/${ids.snapshotId}.archive.enc`,
        `vnext/${ids.snapshotId}.manifest.enc`,
        `kms://${ids.snapshotId}`,
      ],
    );
    await owner.query(
      `INSERT INTO agents (id, creator_id, public_slug, name)
       VALUES ($1, $2, $3, 'Gateway PG Agent')`,
      [ids.agentId, ids.creatorId, `gateway-${ids.agentId.slice(0, 8)}`],
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
         '0.147.0-alpha.6.5', $11, $12
       )`,
      [
        ids.versionId,
        ids.agentId,
        ids.creatorId,
        digest('7'),
        ids.snapshotId,
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
      `INSERT INTO deployments (
         id, agent_id, creator_id, environment, desired_state,
         desired_version_id, generation
       ) VALUES ($1, $2, $3, 'TEST', 'ONLINE', $4, 1)`,
      [ids.deploymentId, ids.agentId, ids.creatorId, ids.versionId],
    );
    await owner.query(
      `INSERT INTO agent_version_controls (version_id, creator_id)
       VALUES ($1, $2)`,
      [ids.versionId, ids.creatorId],
    );
    await owner.query(
      `INSERT INTO worker_installations (
         id, creator_id, installation_key_id, device_public_key,
         worker_version, protocol_versions, capabilities
       ) VALUES ($1, $2, $3, $4, $5, '[1]'::jsonb, $6::jsonb)`,
      [
        ids.installationId,
        ids.creatorId,
        `gateway-key-${ids.installationId}`,
        publicPoint(keyPair.publicKey),
        WORKER_VERSION,
        JSON.stringify({
          codexRuntimeArtifacts: [RUNTIME_DIGEST],
          codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
          isolationModes: ['apple-container-v1'],
        }),
      ],
    );
  });

  afterAll(async () => {
    if (latestSession !== undefined) {
      await authority.closeSession(latestSession, 'SERVER_STOPPED').catch(() => undefined);
    }
    await Promise.all([owner.end(), apiPool.end(), brokerPool.end()]);
  });

  it('consumes a real P-256 challenge and commits one connection-bound Lease', async () => {
    const challengeOperationId = randomUuidV7();
    lossyApiPool.arm();
    const challenge = await lossyAuthority.issueChallenge({
      creatorId: ids.creatorId,
      installationId: ids.installationId,
      ...challengeTarget,
      operationId: challengeOperationId,
      signal: AbortSignal.timeout(5_000),
    });
    await expect(
      authority.issueChallenge({
        creatorId: ids.creatorId,
        installationId: ids.installationId,
        ...challengeTarget,
        operationId: challengeOperationId,
        signal: AbortSignal.timeout(5_000),
      }),
    ).resolves.toEqual(challenge);
    await expect(
      authority.issueChallenge({
        creatorId: ids.creatorId,
        installationId: randomUuidV7(),
        ...challengeTarget,
        operationId: challengeOperationId,
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toMatchObject({
      code: 'OPERATION_CONFLICT',
      operationKey: challengeOperationId,
    } satisfies Partial<PostgresGatewayAuthorityError>);
    const issuedOnce = await owner.query<{ challenges: string; operations: string }>(
      `SELECT
         (SELECT count(*)::text FROM worker_auth_challenges
           WHERE creator_id = $1 AND installation_id = $2) AS challenges,
         (SELECT count(*)::text FROM worker_gateway_operation_receipts
           WHERE creator_id = $1 AND operation_kind = 'ISSUE_CHALLENGE'
             AND operation_key = $3) AS operations`,
      [ids.creatorId, ids.installationId, challengeOperationId],
    );
    expect(issuedOnce.rows).toEqual([{ challenges: '1', operations: '1' }]);
    firstHandshake = signedHandshake(keyPair.privateKey, ids.installationId, challenge.challengeId);
    lossyBrokerPool.arm();
    firstSession = await lossyAuthority.authenticate({
      handshake: firstHandshake,
      connectedAt: new Date().toISOString(),
      signal: AbortSignal.timeout(5_000),
    });
    latestSession = firstSession;
    lossyBrokerPool.arm();
    const opened = await lossyAuthority.openSession(firstSession, AbortSignal.timeout(5_000));
    expect(opened).toHaveLength(1);
    await expect(authority.openSession(firstSession, AbortSignal.timeout(5_000))).resolves.toEqual(
      opened,
    );
    const leaseGrant = opened[0];
    if (leaseGrant?.type !== 'lease.grant') throw new Error('expected lease.grant');
    firstLease = leaseGrant;
    expect(firstLease.lease.workerSessionId).toBe(firstSession.workerSessionId);
    expect(firstLease.lease.fence).toBe('1');

    const facts = await owner.query<{
      challenge_state: string;
      session_state: string;
      lease_state: string;
      lease_fence: string;
      deployment_fence: string;
    }>(
      `SELECT challenge.state AS challenge_state,
              gateway.state AS session_state,
              lease.state AS lease_state,
              lease.fence::text AS lease_fence,
              deployment.lease_fence::text AS deployment_fence
         FROM worker_gateway_sessions AS gateway
         JOIN worker_auth_challenges AS challenge ON challenge.id = gateway.challenge_id
         JOIN worker_leases AS lease ON lease.connection_id = gateway.connection_id
         JOIN deployments AS deployment ON deployment.id = lease.deployment_id
        WHERE gateway.id = $1`,
      [firstSession.workerSessionId],
    );
    expect(facts.rows).toEqual([
      {
        challenge_state: 'CONSUMED',
        session_state: 'ACTIVE',
        lease_state: 'ACTIVE',
        lease_fence: '1',
        deployment_fence: '1',
      },
    ]);

    const replayAttempts = await Promise.allSettled([
      authority.authenticate({
        handshake: firstHandshake,
        connectedAt: new Date().toISOString(),
        signal: AbortSignal.timeout(5_000),
      }),
      authority.authenticate({
        handshake: firstHandshake,
        connectedAt: new Date().toISOString(),
        signal: AbortSignal.timeout(5_000),
      }),
    ]);
    expect(replayAttempts).toHaveLength(2);
    for (const attempt of replayAttempts) {
      expect(attempt.status).toBe('rejected');
      if (attempt.status === 'rejected') {
        expect(attempt.reason).toBeInstanceOf(BrokerAuthenticationError);
      }
    }
    const replayAudit = await owner.query<{
      events: string;
      operations: string;
      reason_code: string;
    }>(
      `SELECT
         count(*)::text AS events,
         min(reason_code) AS reason_code,
         (SELECT count(*)::text FROM worker_gateway_operation_receipts
           WHERE creator_id = $1 AND operation_kind = 'AUDIT_CHALLENGE_REPLAY'
             AND operation_key = $2::text) AS operations
       FROM worker_auth_security_events
       WHERE creator_id = $1 AND challenge_id = $2::uuid
         AND event_type = 'CHALLENGE_REPLAY'`,
      [ids.creatorId, firstHandshake.challengeId],
    );
    expect(replayAudit.rows).toEqual([
      { events: '1', operations: '1', reason_code: 'CHALLENGE_ALREADY_CONSUMED' },
    ]);
    const direct = await brokerPool.query(`SELECT id FROM worker_auth_challenges`);
    expect(direct.rows).toEqual([]);
  });

  it('atomically commits heartbeat, monotonic sequence, durable ACK, and exact replay', async () => {
    await owner.query(`SELECT pg_sleep(0.01)`);
    const input = heartbeat(firstSession, firstLease, 0n);
    lossyBrokerPool.arm();
    const first = await lossyAuthority.acceptEnvelope(
      firstSession,
      delivery(input),
      AbortSignal.timeout(5_000),
    );
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({
      type: 'lease.grant',
      lease: firstLease.lease,
      body: {
        workerSessionId: firstSession.workerSessionId,
        generation: firstLease.body.generation,
      },
    });
    firstRenewal = first[0] as Extract<BrokerEnvelope, { type: 'lease.grant' }>;
    expect(Date.parse(firstRenewal.body.leaseExpiresAt)).toBeGreaterThan(
      Date.parse(firstLease.body.leaseExpiresAt),
    );
    expect(first[1]).toMatchObject({
      type: 'message.ack',
      body: {
        acknowledgedMessageId: input.messageId,
        level: 'CLOUD_COMMITTED',
        decision: 'APPLIED',
      },
    });
    const replay = await authority.replayEnvelope(
      firstSession,
      delivery(input),
      AbortSignal.timeout(5_000),
    );
    expect(replay).toEqual(first);

    const counts = await owner.query<{
      receipts: string;
      outbound: string;
      inbound_next_seq: string;
      observed_state: string;
      lease_expires_at: Date | string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM worker_gateway_frame_receipts WHERE session_id = $1) AS receipts,
         (SELECT count(*)::text FROM worker_gateway_outbound_frames WHERE session_id = $1) AS outbound,
         gateway.inbound_next_seq::text,
         deployment.observed_state,
         lease.expires_at AS lease_expires_at
       FROM worker_gateway_sessions AS gateway
       JOIN worker_leases AS lease ON lease.connection_id = gateway.connection_id
       JOIN deployments AS deployment ON deployment.id = lease.deployment_id
       WHERE gateway.id = $1`,
      [firstSession.workerSessionId],
    );
    expect(counts.rows).toHaveLength(1);
    expect(counts.rows[0]).toMatchObject({
      receipts: '1',
      outbound: '3',
      inbound_next_seq: '1',
      observed_state: 'PREPARING',
    });
    expect(new Date(counts.rows[0]?.lease_expires_at ?? 0).toISOString()).toBe(
      firstRenewal.body.leaseExpiresAt,
    );

    const conflict = BrokerEnvelopeSchema.parse({
      ...input,
      body: { ...input.body, runtimeReady: false },
    });
    await expect(
      authority.replayEnvelope(firstSession, delivery(conflict), AbortSignal.timeout(5_000)),
    ).rejects.toMatchObject({
      code: 'SEQUENCE_CONFLICT',
    } satisfies Partial<PostgresGatewayAuthorityError>);
    const conflictFacts = await owner.query<{
      security_events: string;
      inbound_next_seq: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM worker_gateway_security_events
           WHERE session_id = $1 AND sequence = 0) AS security_events,
         inbound_next_seq::text
       FROM worker_gateway_sessions
       WHERE id = $1`,
      [firstSession.workerSessionId],
    );
    expect(conflictFacts.rows).toEqual([{ security_events: '1', inbound_next_seq: '1' }]);

    const reusedMessage = BrokerEnvelopeSchema.parse({
      ...input,
      sequence: '1',
      body: { ...input.body, proxyReady: false },
    });
    await expect(
      authority.acceptEnvelope(firstSession, delivery(reusedMessage), AbortSignal.timeout(5_000)),
    ).rejects.toMatchObject({
      code: 'SEQUENCE_CONFLICT',
    } satisfies Partial<PostgresGatewayAuthorityError>);
    const messageConflictFacts = await owner.query<{
      security_events: string;
      inbound_next_seq: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM worker_gateway_security_events
           WHERE session_id = $1 AND existing_sequence = 0
             AND received_message_id = $2) AS security_events,
         inbound_next_seq::text
       FROM worker_gateway_sessions
       WHERE id = $1`,
      [firstSession.workerSessionId, input.messageId],
    );
    expect(messageConflictFacts.rows).toEqual([{ security_events: '2', inbound_next_seq: '1' }]);
  });

  it('rejects a bounded jsonb receipt that tries to add a Prompt-like field', async () => {
    const grantValidation = await owner.query<{
      valid: boolean;
      wrong_worker: boolean;
      wrong_expiry: boolean;
    }>(
      `SELECT
         creator_agent_gateway_control_frame_is_safe($1::jsonb) AS valid,
         creator_agent_gateway_control_frame_is_safe($2::jsonb) AS wrong_worker,
         creator_agent_gateway_control_frame_is_safe($3::jsonb) AS wrong_expiry`,
      [
        JSON.stringify(firstLease),
        JSON.stringify({
          ...firstLease,
          body: { ...firstLease.body, workerSessionId: randomUuidV7() },
        }),
        JSON.stringify({
          ...firstLease,
          body: {
            ...firstLease.body,
            leaseExpiresAt: new Date(
              Date.parse(firstLease.body.leaseExpiresAt) + 1_000,
            ).toISOString(),
          },
        }),
      ],
    );
    expect(grantValidation.rows).toEqual([
      { valid: true, wrong_worker: false, wrong_expiry: false },
    ]);
    const client = await apiPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await expect(
        client.query(
          `INSERT INTO worker_gateway_operation_receipts (
             creator_id, operation_kind, operation_key, request_digest,
             result_value, result_digest
           ) VALUES ($1, 'ISSUE_CHALLENGE', $2, $3, $4::jsonb, $5)`,
          [
            ids.creatorId,
            randomUuidV7(),
            digest('a'),
            JSON.stringify({ challengeId: randomUuidV7(), prompt: 'must-not-persist' }),
            digest('b'),
          ],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK');
    } finally {
      client.release(true);
    }
  });

  it('uses Cloud time to reject a newly expired frame without advancing durable sequence', async () => {
    const sentAt = new Date(Date.now() - 60_000).toISOString();
    const expired = BrokerEnvelopeSchema.parse({
      ...heartbeat(firstSession, firstLease, 1n),
      messageId: randomUuidV7(),
      sentAt,
      expiresAt: new Date(Date.parse(sentAt) + 1_000).toISOString(),
    });
    await expect(
      authority.acceptEnvelope(firstSession, delivery(expired), AbortSignal.timeout(5_000)),
    ).rejects.toMatchObject({
      code: 'MESSAGE_EXPIRED',
    } satisfies Partial<PostgresGatewayAuthorityError>);
    const facts = await owner.query<{ inbound_next_seq: string; receipts: string }>(
      `SELECT inbound_next_seq::text,
              (SELECT count(*)::text FROM worker_gateway_frame_receipts
                WHERE session_id = gateway.id) AS receipts
         FROM worker_gateway_sessions AS gateway
        WHERE id = $1`,
      [firstSession.workerSessionId],
    );
    expect(facts.rows).toEqual([{ inbound_next_seq: '1', receipts: '1' }]);
  });

  it('keeps a healthy heartbeat PREPARING until an attestation-aware projector commits readiness', async () => {
    const beforeReady = await owner.query<{ state: string; serving: string | null }>(
      `SELECT observed_state AS state, serving_version_id::text AS serving
         FROM deployments WHERE id = $1`,
      [ids.deploymentId],
    );
    expect(beforeReady.rows).toEqual([{ state: 'PREPARING', serving: null }]);
    const claimedReady = versionReady(firstSession, firstLease, 1n);
    await expect(
      authority.acceptEnvelope(firstSession, delivery(claimedReady), AbortSignal.timeout(5_000)),
    ).rejects.toMatchObject({
      code: 'BUSINESS_PROJECTOR_UNAVAILABLE',
    } satisfies Partial<PostgresGatewayAuthorityError>);
    const afterClaim = await owner.query<{
      state: string;
      serving: string | null;
      next_sequence: string;
    }>(
      `SELECT deployment.observed_state AS state,
              deployment.serving_version_id::text AS serving,
              gateway.inbound_next_seq::text AS next_sequence
         FROM deployments AS deployment
         JOIN worker_leases AS lease ON lease.deployment_id = deployment.id
         JOIN worker_gateway_sessions AS gateway ON gateway.connection_id = lease.connection_id
        WHERE deployment.id = $1 AND gateway.id = $2`,
      [ids.deploymentId, firstSession.workerSessionId],
    );
    expect(afterClaim.rows).toEqual([{ state: 'PREPARING', serving: null, next_sequence: '1' }]);
  });

  it('ACKs an exact lease renewal without extending it again or creating a grant loop', async () => {
    const before = await owner.query<{ expires_at: Date | string }>(
      `SELECT expires_at FROM worker_leases WHERE id = $1`,
      [firstRenewal.lease.leaseId],
    );
    const renewalEvent = leaseStatusEvent('lease.renewed', firstSession, firstRenewal, 1n);
    const accepted = await authority.acceptEnvelope(
      firstSession,
      delivery(renewalEvent),
      AbortSignal.timeout(5_000),
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      type: 'message.ack',
      body: {
        acknowledgedMessageId: renewalEvent.messageId,
        level: 'CLOUD_COMMITTED',
        decision: 'APPLIED',
      },
    });
    await expect(
      authority.replayEnvelope(firstSession, delivery(renewalEvent), AbortSignal.timeout(5_000)),
    ).resolves.toEqual(accepted);
    const after = await owner.query<{ expires_at: Date | string }>(
      `SELECT expires_at FROM worker_leases WHERE id = $1`,
      [firstRenewal.lease.leaseId],
    );
    expect(new Date(after.rows[0]?.expires_at ?? 0).toISOString()).toBe(
      new Date(before.rows[0]?.expires_at ?? 0).toISOString(),
    );
    const confirmedGrant = await owner.query<{
      durable_ack_level: string | null;
      ack_decision: string | null;
    }>(
      `SELECT durable_ack_level, ack_decision
         FROM worker_gateway_outbound_frames
        WHERE session_id = $1 AND message_id = $2`,
      [firstSession.workerSessionId, firstRenewal.messageId],
    );
    expect(confirmedGrant.rows).toEqual([
      { durable_ack_level: 'PERSISTED', ack_decision: 'APPLIED' },
    ]);

    const oldGrantWithCurrentExpiry = BrokerEnvelopeSchema.parse({
      ...leaseStatusEvent('lease.renewed', firstSession, firstRenewal, 2n),
      correlationId: firstLease.messageId,
    });
    await expect(
      authority.acceptEnvelope(
        firstSession,
        delivery(oldGrantWithCurrentExpiry),
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toMatchObject({ code: 'OUTBOUND_ACK_CONFLICT' });

    const unrelatedGrant = BrokerEnvelopeSchema.parse({
      ...leaseStatusEvent('lease.renewed', firstSession, firstRenewal, 2n),
      correlationId: randomUuidV7(),
    });
    await expect(
      authority.acceptEnvelope(firstSession, delivery(unrelatedGrant), AbortSignal.timeout(5_000)),
    ).rejects.toMatchObject({ code: 'OUTBOUND_ACK_CONFLICT' });

    const staleAccepted = leaseStatusEvent(
      'lease.accepted',
      firstSession,
      firstRenewal,
      2n,
      firstLease.body.leaseExpiresAt,
    );
    await expect(
      authority.acceptEnvelope(firstSession, delivery(staleAccepted), AbortSignal.timeout(5_000)),
    ).rejects.toMatchObject({ code: 'LEASE_UNAVAILABLE' });
    const rejectedFacts = await owner.query<{ inbound_next_seq: string; receipts: string }>(
      `SELECT inbound_next_seq::text,
              (SELECT count(*)::text FROM worker_gateway_frame_receipts
                WHERE session_id = gateway.id) AS receipts
         FROM worker_gateway_sessions AS gateway
        WHERE id = $1`,
      [firstSession.workerSessionId],
    );
    expect(rejectedFacts.rows).toEqual([{ inbound_next_seq: '2', receipts: '2' }]);
  });

  it('rolls back a bad signature and an abort at the exact pre-COMMIT fence', async () => {
    const challenge = await authority.issueChallenge({
      creatorId: ids.creatorId,
      installationId: ids.installationId,
      ...challengeTarget,
      operationId: randomUuidV7(),
      signal: AbortSignal.timeout(5_000),
    });
    const valid = signedHandshake(keyPair.privateKey, ids.installationId, challenge.challengeId);
    const invalid = signedHandshake(keyPair.privateKey, ids.installationId, challenge.challengeId, {
      challengeSignature: Buffer.alloc(64, 0x55).toString('base64url'),
    });
    await expect(
      authority.authenticate({
        handshake: invalid,
        connectedAt: new Date().toISOString(),
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toBeInstanceOf(BrokerAuthenticationError);
    const invalidFacts = await owner.query<{
      challenge_state: string;
      deployment_state: string;
      security_events: string;
    }>(
      `SELECT challenge.state AS challenge_state,
              deployment.observed_state AS deployment_state,
              (SELECT count(*)::text FROM worker_auth_security_events
                WHERE challenge_id = challenge.id) AS security_events
         FROM worker_auth_challenges AS challenge
         JOIN deployments AS deployment ON deployment.id = challenge.deployment_id
        WHERE challenge.id = $1`,
      [challenge.challengeId],
    );
    expect(invalidFacts.rows).toEqual([
      { challenge_state: 'ISSUED', deployment_state: 'PREPARING', security_events: '0' },
    ]);

    let entered!: () => void;
    let release!: () => void;
    const atCommit = new Promise<void>((resolve) => (entered = resolve));
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const abortingAuthority = new PostgresAgentGatewayAuthority(
      pools,
      policy,
      undefined,
      async (step) => {
        if (step !== 'BEFORE_COMMIT') return;
        entered();
        await barrier;
      },
    );
    const controller = new AbortController();
    const pending = abortingAuthority.authenticate({
      handshake: valid,
      connectedAt: new Date().toISOString(),
      signal: controller.signal,
    });
    await atCommit;
    controller.abort(new Error('test transport closed'));
    release();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    const rolledBack = await owner.query<{ challenge_state: string; sessions: string }>(
      `SELECT challenge.state AS challenge_state,
              (SELECT count(*)::text FROM worker_gateway_sessions WHERE challenge_id = challenge.id) AS sessions
         FROM worker_auth_challenges AS challenge
        WHERE challenge.id = $1`,
      [challenge.challengeId],
    );
    expect(rolledBack.rows).toEqual([{ challenge_state: 'ISSUED', sessions: '0' }]);
  });

  it('rejects both creator A to installation B and device key A to challenge B', async () => {
    const otherKeyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const otherInstallationId = randomUuidV7();
    const otherCreator = await owner.query<{ id: string }>(
      `INSERT INTO users (account) VALUES ($1) RETURNING id::text`,
      [creatorAccount()],
    );
    const otherCreatorId = otherCreator.rows[0]?.id;
    if (otherCreatorId === undefined) throw new Error('failed to seed second creator');
    await owner.query(
      `INSERT INTO worker_installations (
         id, creator_id, installation_key_id, device_public_key,
         worker_version, protocol_versions, capabilities
       ) VALUES ($1, $2, $3, $4, $5, '[1]'::jsonb, $6::jsonb)`,
      [
        otherInstallationId,
        otherCreatorId,
        `gateway-key-${otherInstallationId}`,
        publicPoint(otherKeyPair.publicKey),
        WORKER_VERSION,
        JSON.stringify({
          codexRuntimeArtifacts: [RUNTIME_DIGEST],
          codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
          isolationModes: ['apple-container-v1'],
        }),
      ],
    );

    await expect(
      authority.issueChallenge({
        creatorId: ids.creatorId,
        installationId: otherInstallationId,
        ...challengeTarget,
        operationId: randomUuidV7(),
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toBeDefined();
    const otherChallenge = await authority.issueChallenge({
      creatorId: ids.creatorId,
      installationId: ids.installationId,
      ...challengeTarget,
      operationId: randomUuidV7(),
      signal: AbortSignal.timeout(5_000),
    });
    await expect(
      authority.authenticate({
        handshake: signedHandshake(
          keyPair.privateKey,
          otherInstallationId,
          otherChallenge.challengeId,
        ),
        connectedAt: new Date().toISOString(),
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toBeInstanceOf(BrokerAuthenticationError);
    const isolation = await owner.query<{ state: string; sessions: string }>(
      `SELECT state,
              (SELECT count(*)::text FROM worker_gateway_sessions
                WHERE installation_id = $2) AS sessions
         FROM worker_auth_challenges
        WHERE id = $1`,
      [otherChallenge.challengeId, otherInstallationId],
    );
    expect(isolation.rows).toEqual([{ state: 'ISSUED', sessions: '0' }]);
  });

  it('replaces the prior session, advances Fence, and rejects the old connection forever', async () => {
    const challenge = await authority.issueChallenge({
      creatorId: ids.creatorId,
      installationId: ids.installationId,
      ...challengeTarget,
      operationId: randomUuidV7(),
      signal: AbortSignal.timeout(5_000),
    });
    const nextHandshake = signedHandshake(
      keyPair.privateKey,
      ids.installationId,
      challenge.challengeId,
    );
    const nextSession = await authority.authenticate({
      handshake: nextHandshake,
      connectedAt: new Date().toISOString(),
      signal: AbortSignal.timeout(5_000),
    });
    latestSession = nextSession;
    const nextOpened = await authority.openSession(nextSession, AbortSignal.timeout(5_000));
    const nextLease = nextOpened[0];
    if (nextLease?.type !== 'lease.grant') throw new Error('expected replacement lease.grant');
    expect(nextLease.lease.fence).toBe('2');

    await expect(
      authority.acceptEnvelope(
        firstSession,
        delivery(heartbeat(firstSession, firstLease, 2n)),
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toMatchObject({
      code: 'LEASE_UNAVAILABLE',
    } satisfies Partial<PostgresGatewayAuthorityError>);
    await authority.closeSession(firstSession, 'CLIENT_CLOSED');

    const replacementHeartbeat = heartbeat(nextSession, nextLease, 0n);
    await expect(
      authority.acceptEnvelope(
        nextSession,
        delivery(replacementHeartbeat),
        AbortSignal.timeout(5_000),
      ),
    ).resolves.toHaveLength(2);
    const states = await owner.query<{
      state: string;
      lease_state: string | null;
      fence: string | null;
    }>(
      `SELECT gateway.state, lease.state AS lease_state, lease.fence::text
         FROM worker_gateway_sessions AS gateway
         LEFT JOIN worker_leases AS lease ON lease.connection_id = gateway.connection_id
        WHERE gateway.installation_id = $1
        ORDER BY gateway.connected_at, gateway.id`,
      [ids.installationId],
    );
    expect(states.rows).toEqual([
      { state: 'REPLACED', lease_state: 'REVOKED', fence: '1' },
      { state: 'ACTIVE', lease_state: 'ACTIVE', fence: '2' },
    ]);
  });

  it('runs the real WebSocket Gateway through signed auth, PG Lease, ACK, and replay', async () => {
    const challenge = await authority.issueChallenge({
      creatorId: ids.creatorId,
      installationId: ids.installationId,
      ...challengeTarget,
      operationId: randomUuidV7(),
      signal: AbortSignal.timeout(5_000),
    });
    const gateway = new AgentGateway({
      authority,
      host: '127.0.0.1',
      port: 0,
      authorityTimeoutMs: 5_000,
    });
    const address = await gateway.start();
    const socket = new WebSocket(`ws://${address.host}:${address.port}${address.path}`, {
      perMessageDeflate: false,
    });
    try {
      await once(socket, 'open');
      socket.send(
        canonicalizeJson(
          signedHandshake(keyPair.privateKey, ids.installationId, challenge.challengeId),
        ),
      );
      const leaseFrame = parseBrokerFrame(await nextTextFrame(socket));
      if (leaseFrame.type !== 'lease.grant') throw new Error('expected real lease.grant');
      const session = Object.freeze({
        ownerId: ids.creatorId,
        installationId: ids.installationId,
        connectionId: leaseFrame.connectionId,
        workerSessionId: leaseFrame.lease.workerSessionId,
      });
      latestSession = session;
      const event = heartbeat(session, leaseFrame, 0n);
      const renewalFrames = nextTextFrames(socket, 2);
      socket.send(canonicalizeJson(event));
      const [renewalGrantRaw, firstAckRaw] = await renewalFrames;
      const renewalGrant = parseBrokerFrame(renewalGrantRaw ?? '');
      expect(renewalGrant).toMatchObject({
        type: 'lease.grant',
        lease: leaseFrame.lease,
      });
      const firstAck = parseBrokerFrame(firstAckRaw ?? '');
      expect(firstAck).toMatchObject({
        type: 'message.ack',
        body: { acknowledgedMessageId: event.messageId, level: 'CLOUD_COMMITTED' },
      });

      const replayFrames = nextTextFrames(socket, 2);
      socket.send(canonicalizeJson(event));
      const [replayGrantRaw, replayAckRaw] = await replayFrames;
      const replayGrant = parseBrokerFrame(replayGrantRaw ?? '');
      const replayAck = parseBrokerFrame(replayAckRaw ?? '');
      expect(replayGrant).toEqual(renewalGrant);
      expect(replayAck).toEqual(firstAck);
      expect(gateway.activeConnections).toBe(1);
    } finally {
      const closed = once(socket, 'close');
      socket.close();
      await closed.catch(() => undefined);
      await gateway.stop();
    }
    const active = await owner.query<{ sessions: string; leases: string }>(
      `SELECT
         (SELECT count(*)::text FROM worker_gateway_sessions
           WHERE installation_id = $1 AND state = 'ACTIVE') AS sessions,
         (SELECT count(*)::text FROM worker_leases
           WHERE worker_id = $1 AND state = 'ACTIVE') AS leases`,
      [ids.installationId],
    );
    expect(active.rows).toEqual([{ sessions: '0', leases: '0' }]);
  });

  it('durably blocks a signed incompatible challenge without granting Session or Lease', async () => {
    const incompatibleKeyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const incompatibleInstallationId = randomUuidV7();
    await owner.query(
      `INSERT INTO worker_installations (
         id, creator_id, installation_key_id, device_public_key,
         worker_version, protocol_versions, capabilities
       ) VALUES ($1, $2, $3, $4, $5, '[1]'::jsonb, $6::jsonb)`,
      [
        incompatibleInstallationId,
        ids.creatorId,
        `gateway-key-${incompatibleInstallationId}`,
        publicPoint(incompatibleKeyPair.publicKey),
        WORKER_VERSION,
        JSON.stringify({
          codexRuntimeArtifacts: [RUNTIME_DIGEST],
          codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
          isolationModes: ['lima-vz-v1'],
        }),
      ],
    );
    const challenge = await authority.issueChallenge({
      creatorId: ids.creatorId,
      installationId: incompatibleInstallationId,
      ...challengeTarget,
      operationId: randomUuidV7(),
      signal: AbortSignal.timeout(5_000),
    });
    const handshake = signedHandshake(
      incompatibleKeyPair.privateKey,
      incompatibleInstallationId,
      challenge.challengeId,
    );
    await expect(
      authority.authenticate({
        handshake,
        connectedAt: new Date().toISOString(),
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toMatchObject({ code: 'WORKER_INCOMPATIBLE' });

    const incompatibleFacts = await owner.query<{
      challenge_state: string;
      deployment_state: string;
      last_error_code: string | null;
      sessions: string;
      leases: string;
      incompatible_events: string;
    }>(
      `SELECT challenge.state AS challenge_state,
              deployment.observed_state AS deployment_state,
              deployment.last_error_code,
              (SELECT count(*)::text FROM worker_gateway_sessions
                WHERE challenge_id = challenge.id) AS sessions,
              (SELECT count(*)::text FROM worker_leases
                WHERE deployment_id = challenge.deployment_id AND state = 'ACTIVE') AS leases,
              (SELECT count(*)::text FROM worker_auth_security_events
                WHERE challenge_id = challenge.id
                  AND event_type = 'WORKER_INCOMPATIBLE') AS incompatible_events
         FROM worker_auth_challenges AS challenge
         JOIN deployments AS deployment ON deployment.id = challenge.deployment_id
        WHERE challenge.id = $1`,
      [challenge.challengeId],
    );
    expect(incompatibleFacts.rows).toEqual([
      {
        challenge_state: 'CONSUMED',
        deployment_state: 'BLOCKED',
        last_error_code: 'ISOLATION_INCOMPATIBLE',
        sessions: '0',
        leases: '0',
        incompatible_events: '1',
      },
    ]);

    await expect(
      authority.authenticate({
        handshake,
        connectedAt: new Date().toISOString(),
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_REJECTED' });
    const replayAudit = await owner.query<{ replays: string; incompatibles: string }>(
      `SELECT
         count(*) FILTER (WHERE event_type = 'CHALLENGE_REPLAY')::text AS replays,
         count(*) FILTER (WHERE event_type = 'WORKER_INCOMPATIBLE')::text AS incompatibles
       FROM worker_auth_security_events WHERE challenge_id = $1`,
      [challenge.challengeId],
    );
    expect(replayAudit.rows).toEqual([{ replays: '1', incompatibles: '1' }]);

    await owner.query(
      `UPDATE deployments
          SET observed_state = 'OFFLINE', observed_worker_id = NULL,
              last_error_code = NULL, updated_at = statement_timestamp()
        WHERE id = $1`,
      [ids.deploymentId],
    );
  });

  it('refuses incompatible, concurrently leased, offline, and revoked deployment authority', async () => {
    const matchingCapabilities = JSON.stringify({
      codexRuntimeArtifacts: [RUNTIME_DIGEST],
      codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
      isolationModes: ['apple-container-v1'],
    });
    let primarySession: AuthenticatedWorkerSession | undefined;
    let competingSession: AuthenticatedWorkerSession | undefined;
    try {
      const challenge = await authority.issueChallenge({
        creatorId: ids.creatorId,
        installationId: ids.installationId,
        ...challengeTarget,
        operationId: randomUuidV7(),
        signal: AbortSignal.timeout(5_000),
      });
      primarySession = await authority.authenticate({
        handshake: signedHandshake(keyPair.privateKey, ids.installationId, challenge.challengeId),
        connectedAt: new Date().toISOString(),
        signal: AbortSignal.timeout(5_000),
      });
      await owner.query(
        `UPDATE worker_installations
            SET capabilities = jsonb_set(
              capabilities,
              '{codexRuntimeArtifacts}',
              to_jsonb(ARRAY[$2::text])
            )
          WHERE id = $1`,
        [ids.installationId, `sha256:${'f'.repeat(64)}`],
      );
      await expect(
        authority.openSession(primarySession, AbortSignal.timeout(5_000)),
      ).rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' });
      await owner.query(`UPDATE worker_installations SET capabilities = $2::jsonb WHERE id = $1`, [
        ids.installationId,
        JSON.stringify({
          codexRuntimeArtifacts: [RUNTIME_DIGEST],
          codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
          isolationModes: ['lima-vz-v1'],
        }),
      ]);
      await expect(
        authority.openSession(primarySession, AbortSignal.timeout(5_000)),
      ).rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' });
      await owner.query(`UPDATE worker_installations SET capabilities = $2::jsonb WHERE id = $1`, [
        ids.installationId,
        matchingCapabilities,
      ]);

      const eligibleChallenge = await authority.issueChallenge({
        creatorId: ids.creatorId,
        installationId: ids.installationId,
        ...challengeTarget,
        operationId: randomUuidV7(),
        signal: AbortSignal.timeout(5_000),
      });
      primarySession = await authority.authenticate({
        handshake: signedHandshake(
          keyPair.privateKey,
          ids.installationId,
          eligibleChallenge.challengeId,
        ),
        connectedAt: new Date().toISOString(),
        signal: AbortSignal.timeout(5_000),
      });

      const opened = await authority.openSession(primarySession, AbortSignal.timeout(5_000));
      const lease = opened[0];
      if (lease?.type !== 'lease.grant') throw new Error('expected eligible lease.grant');
      const concurrentA = heartbeat(primarySession, lease, 0n);
      const concurrentB = BrokerEnvelopeSchema.parse({
        ...concurrentA,
        body: { ...concurrentA.body, journalReady: false },
      }) as Extract<BrokerEnvelope, { type: 'heartbeat' }>;
      const concurrentResults = await Promise.allSettled([
        authority.acceptEnvelope(primarySession, delivery(concurrentA), AbortSignal.timeout(5_000)),
        authority.acceptEnvelope(primarySession, delivery(concurrentB), AbortSignal.timeout(5_000)),
      ]);
      expect(concurrentResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejectedConflict = concurrentResults.find((result) => result.status === 'rejected');
      expect(rejectedConflict).toMatchObject({
        status: 'rejected',
        reason: { code: 'SEQUENCE_CONFLICT' },
      });
      const winningInput = concurrentResults[0]?.status === 'fulfilled' ? concurrentA : concurrentB;
      const winningResult = concurrentResults.find((result) => result.status === 'fulfilled');
      if (winningResult?.status !== 'fulfilled') throw new Error('missing winning frame');
      await expect(
        authority.replayEnvelope(
          primarySession,
          delivery(winningInput),
          AbortSignal.timeout(5_000),
        ),
      ).resolves.toEqual(winningResult.value);

      const nextSequenceConflict = BrokerEnvelopeSchema.parse({
        ...winningInput,
        sequence: '1',
        body: { ...winningInput.body, proxyReady: !winningInput.body.proxyReady },
      });
      await expect(
        authority.acceptEnvelope(
          primarySession,
          delivery(nextSequenceConflict),
          AbortSignal.timeout(5_000),
        ),
      ).rejects.toMatchObject({ code: 'SEQUENCE_CONFLICT' });
      const concurrentFacts = await owner.query<{
        receipts: string;
        conflicts: string;
        inbound_next_seq: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM worker_gateway_frame_receipts
             WHERE session_id = $1) AS receipts,
           (SELECT count(*)::text FROM worker_gateway_security_events
             WHERE session_id = $1) AS conflicts,
           inbound_next_seq::text
         FROM worker_gateway_sessions WHERE id = $1`,
        [primarySession.workerSessionId],
      );
      expect(concurrentFacts.rows).toEqual([
        { receipts: '1', conflicts: '2', inbound_next_seq: '1' },
      ]);
      const beforeBlock = await owner.query<{ expires_at: Date | string }>(
        `SELECT expires_at FROM worker_leases WHERE id = $1`,
        [lease.lease.leaseId],
      );
      const originalExpiry = new Date(beforeBlock.rows[0]?.expires_at ?? 0).getTime();

      await owner.query(`UPDATE worker_installations SET capabilities = $2::jsonb WHERE id = $1`, [
        ids.installationId,
        JSON.stringify({
          codexRuntimeArtifacts: [RUNTIME_DIGEST],
          codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
          isolationModes: ['lima-vz-v1'],
        }),
      ]);
      await expect(
        authority.acceptEnvelope(
          primarySession,
          delivery(heartbeat(primarySession, lease, 1n)),
          AbortSignal.timeout(5_000),
        ),
      ).rejects.toMatchObject({
        code: 'LEASE_UNAVAILABLE',
      } satisfies Partial<PostgresGatewayAuthorityError>);
      await owner.query(`UPDATE worker_installations SET capabilities = $2::jsonb WHERE id = $1`, [
        ids.installationId,
        matchingCapabilities,
      ]);

      const competingKeyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const competingInstallationId = randomUuidV7();
      await owner.query(
        `INSERT INTO worker_installations (
           id, creator_id, installation_key_id, device_public_key,
           worker_version, protocol_versions, capabilities
         ) VALUES ($1, $2, $3, $4, $5, '[1]'::jsonb, $6::jsonb)`,
        [
          competingInstallationId,
          ids.creatorId,
          `gateway-key-${competingInstallationId}`,
          publicPoint(competingKeyPair.publicKey),
          WORKER_VERSION,
          matchingCapabilities,
        ],
      );
      const competingChallenge = await authority.issueChallenge({
        creatorId: ids.creatorId,
        installationId: competingInstallationId,
        ...challengeTarget,
        operationId: randomUuidV7(),
        signal: AbortSignal.timeout(5_000),
      });
      competingSession = await authority.authenticate({
        handshake: signedHandshake(
          competingKeyPair.privateKey,
          competingInstallationId,
          competingChallenge.challengeId,
        ),
        connectedAt: new Date().toISOString(),
        signal: AbortSignal.timeout(5_000),
      });
      await expect(
        authority.openSession(competingSession, AbortSignal.timeout(5_000)),
      ).rejects.toMatchObject({ code: 'LEASE_UNAVAILABLE' });

      await owner.query(
        `UPDATE deployments
            SET desired_state = 'OFFLINE', generation = generation + 1,
                updated_at = statement_timestamp()
          WHERE id = $1`,
        [ids.deploymentId],
      );
      const blockedHeartbeat = heartbeat(primarySession, lease, 1n);
      const blockedAck = await authority.acceptEnvelope(
        primarySession,
        delivery(blockedHeartbeat),
        AbortSignal.timeout(5_000),
      );
      expect(blockedAck).toHaveLength(2);
      expect(blockedAck[0]).toMatchObject({
        type: 'message.ack',
        body: { decision: 'SECURITY_BLOCK', level: 'CLOUD_COMMITTED' },
      });
      expect(blockedAck[1]).toMatchObject({
        type: 'lease.revoke',
        body: { reason: 'IMMEDIATE' },
      });
      await expect(
        authority.replayEnvelope(
          primarySession,
          delivery(blockedHeartbeat),
          AbortSignal.timeout(5_000),
        ),
      ).resolves.toEqual(blockedAck);
      const afterBlock = await owner.query<{
        expires_at: Date | string;
        observed_state: string;
        lease_state: string;
      }>(
        `SELECT lease.expires_at, lease.state AS lease_state, deployment.observed_state
           FROM worker_leases AS lease
           JOIN deployments AS deployment ON deployment.id = lease.deployment_id
          WHERE lease.id = $1`,
        [lease.lease.leaseId],
      );
      expect(new Date(afterBlock.rows[0]?.expires_at ?? 0).getTime()).toBe(originalExpiry);
      expect(afterBlock.rows[0]).toMatchObject({
        lease_state: 'REVOKED',
        observed_state: 'OFFLINE',
      });
      await authority.closeSession(primarySession, 'SERVER_STOPPED');
      primarySession = undefined;

      const installationGeneration = await owner.query<{ generation: string }>(
        `UPDATE deployments
            SET desired_state = 'ONLINE', generation = generation + 1,
                updated_at = statement_timestamp()
          WHERE id = $1
        RETURNING generation::text`,
        [ids.deploymentId],
      );
      const installationTarget = {
        deploymentId: ids.deploymentId,
        deploymentGeneration: installationGeneration.rows[0]?.generation ?? '',
      };
      const installationChallenge = await authority.issueChallenge({
        creatorId: ids.creatorId,
        installationId: ids.installationId,
        ...installationTarget,
        operationId: randomUuidV7(),
        signal: AbortSignal.timeout(5_000),
      });
      primarySession = await authority.authenticate({
        handshake: signedHandshake(
          keyPair.privateKey,
          ids.installationId,
          installationChallenge.challengeId,
        ),
        connectedAt: new Date().toISOString(),
        signal: AbortSignal.timeout(5_000),
      });
      const installationOpened = await authority.openSession(
        primarySession,
        AbortSignal.timeout(5_000),
      );
      const installationLease = installationOpened[0];
      if (installationLease?.type !== 'lease.grant') {
        throw new Error('expected installation revoke test lease.grant');
      }
      await owner.query(
        `UPDATE worker_installations
            SET revoked_at = statement_timestamp(), last_seen_at = statement_timestamp()
          WHERE id = $1`,
        [ids.installationId],
      );
      const installationHeartbeat = heartbeat(primarySession, installationLease, 0n);
      const installationBlocked = await authority.acceptEnvelope(
        primarySession,
        delivery(installationHeartbeat),
        AbortSignal.timeout(5_000),
      );
      expect(installationBlocked).toHaveLength(2);
      expect(installationBlocked[1]).toMatchObject({
        type: 'lease.revoke',
        body: { reason: 'INSTALLATION_REVOKED' },
      });
      const installationFacts = await owner.query<{
        lease_state: string;
        observed_state: string;
      }>(
        `SELECT lease.state AS lease_state, deployment.observed_state
           FROM worker_leases AS lease
           JOIN deployments AS deployment ON deployment.id = lease.deployment_id
          WHERE lease.id = $1`,
        [installationLease.lease.leaseId],
      );
      expect(installationFacts.rows).toEqual([
        { lease_state: 'REVOKED', observed_state: 'BLOCKED' },
      ]);
      await authority.closeSession(primarySession, 'SERVER_STOPPED');
      primarySession = undefined;
      const securityDesiredVersionId = randomUuidV7();
      await owner.query(
        `INSERT INTO agent_versions (
           id, agent_id, creator_id, ordinal, schema_version, version_digest, snapshot_id,
           behavior_contract, behavior_contract_digest, runtime_policy, runtime_policy_digest,
           io_contract, io_contract_digest, model_policy, model_policy_digest,
           codex_runtime_version, codex_runtime_artifact_digest, codex_protocol_schema_digest
         ) VALUES (
           $1, $2, $3, 2, 1, $4, $5,
           '{}'::jsonb, $6, $7::jsonb, $8, '{}'::jsonb, $9, '{}'::jsonb, $10,
           '0.147.0-alpha.6.5', $11, $12
         )`,
        [
          securityDesiredVersionId,
          ids.agentId,
          ids.creatorId,
          digest('e'),
          ids.snapshotId,
          digest('a'),
          JSON.stringify(TEST_RUNTIME_POLICY),
          digest('b'),
          digest('c'),
          digest('d'),
          RUNTIME_DIGEST,
          PROTOCOL_DIGEST,
        ],
      );
      await owner.query(
        `INSERT INTO agent_version_controls (version_id, creator_id) VALUES ($1, $2)`,
        [securityDesiredVersionId, ids.creatorId],
      );
      const securityGeneration = await owner.query<{ generation: string }>(
        `UPDATE deployments
            SET desired_state = 'ONLINE', desired_version_id = $2,
                serving_version_id = $3, observed_state = 'OFFLINE',
                generation = generation + 1, observed_generation = generation + 1,
                observed_worker_id = NULL, last_error_code = NULL,
                updated_at = statement_timestamp()
          WHERE id = $1
        RETURNING generation::text`,
        [ids.deploymentId, securityDesiredVersionId, ids.versionId],
      );
      const securityTarget = {
        deploymentId: ids.deploymentId,
        deploymentGeneration: securityGeneration.rows[0]?.generation ?? '',
      };
      const securityChallenge = await authority.issueChallenge({
        creatorId: ids.creatorId,
        installationId: competingInstallationId,
        ...securityTarget,
        operationId: randomUuidV7(),
        signal: AbortSignal.timeout(5_000),
      });
      competingSession = await authority.authenticate({
        handshake: signedHandshake(
          competingKeyPair.privateKey,
          competingInstallationId,
          securityChallenge.challengeId,
        ),
        connectedAt: new Date().toISOString(),
        signal: AbortSignal.timeout(5_000),
      });
      const securityOpened = await authority.openSession(
        competingSession,
        AbortSignal.timeout(5_000),
      );
      const securityLease = securityOpened[0];
      if (securityLease?.type !== 'lease.grant') {
        throw new Error('expected security test lease.grant');
      }
      const beforeSecurity = await owner.query<{ expires_at: Date | string }>(
        `SELECT expires_at FROM worker_leases WHERE id = $1`,
        [securityLease.lease.leaseId],
      );
      const securityExpiry = new Date(beforeSecurity.rows[0]?.expires_at ?? 0).getTime();
      const pinnedConversationId = randomUuidV7();
      const pinnedMessageId = randomUuidV7();
      const pinnedInvocationId = randomUuidV7();
      await owner.query(
        `UPDATE deployments
            SET serving_version_id = $2, observed_state = 'ONLINE',
                updated_at = statement_timestamp()
          WHERE id = $1`,
        [ids.deploymentId, securityDesiredVersionId],
      );
      await owner.query(
        `INSERT INTO agent_conversations (
           id, agent_id, deployment_id, agent_version_id, creator_id,
           consumer_subject_id, version_digest, state, assigned_worker_id, expires_at,
           idempotency_key, request_digest
         ) VALUES ($1, $2, $3, $4, $5, $5, $6, 'BUSY', $7,
                   statement_timestamp() + interval '30 days', $8, $9)`,
        [
          pinnedConversationId,
          ids.agentId,
          ids.deploymentId,
          ids.versionId,
          ids.creatorId,
          digest('7'),
          competingInstallationId,
          randomUuidV7(),
          digest('c'),
        ],
      );
      await owner.query(
        `INSERT INTO agent_messages (
           id, conversation_id, creator_id, consumer_subject_id, turn_no, role,
           client_message_id, content_algorithm, content_key_id, content_nonce,
           content_ciphertext, content_auth_tag, content_cipher_digest,
           content_digest, content_aad_version
         ) VALUES (
           $1, $2, $3, $3, 1, 'USER', $4, 'aes-256-gcm/v1', $5, $6, $7, $8,
           $9, $10, 1
         )`,
        [
          pinnedMessageId,
          pinnedConversationId,
          ids.creatorId,
          `gateway-pinned-${pinnedMessageId}`,
          `gateway-key-${pinnedMessageId}`,
          randomBytes(12),
          randomBytes(32),
          randomBytes(16),
          digest('f'),
          `hmac-sha256:${digest('e')}`,
        ],
      );
      await owner.query(
        `INSERT INTO agent_invocations (
           id, conversation_id, creator_id, consumer_subject_id, agent_version_id,
           user_message_id, client_message_id, request_digest, state,
           assigned_worker_id, assignment_lease_id, assignment_fence,
           deadline_at, started_at
         ) VALUES (
           $1, $2, $3, $3, $4, $5, $6, $7, 'RUNNING', $8, $9, $10,
           statement_timestamp() + interval '2 minutes', statement_timestamp()
         )`,
        [
          pinnedInvocationId,
          pinnedConversationId,
          ids.creatorId,
          ids.versionId,
          pinnedMessageId,
          `gateway-pinned-${pinnedInvocationId}`,
          `hmac-sha256:${digest('d')}`,
          competingInstallationId,
          securityLease.lease.leaseId,
          securityLease.lease.fence,
        ],
      );
      const brokerProbe = new Client({
        connectionString: roleUrl('combo_agent_broker', brokerPassword ?? ''),
      });
      await brokerProbe.connect();
      try {
        await brokerProbe.query('BEGIN');
        await brokerProbe.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
        const crossConsumerUpdate = await brokerProbe.query(
          `UPDATE agent_invocations
              SET state = state
            WHERE id = $1
          RETURNING id`,
          [pinnedInvocationId],
        );
        expect(crossConsumerUpdate.rowCount).toBe(0);
        await brokerProbe.query('ROLLBACK');
      } finally {
        await brokerProbe.end();
      }
      const revokedHeartbeat = heartbeat(competingSession, securityLease, 0n);
      expect(revokedHeartbeat.body.activeInvocationId).toBeNull();
      let projected!: () => void;
      let releaseProjection!: () => void;
      const projectedPromise = new Promise<void>((resolve) => (projected = resolve));
      const projectionBarrier = new Promise<void>((resolve) => (releaseProjection = resolve));
      let projectionPaused = false;
      const racingAuthority = new PostgresAgentGatewayAuthority(
        pools,
        policy,
        undefined,
        async (step) => {
          if (step !== 'EVENT_PROJECTED' || projectionPaused) return;
          projectionPaused = true;
          projected();
          await projectionBarrier;
        },
      );
      const pendingHeartbeat = racingAuthority.acceptEnvelope(
        competingSession,
        delivery(revokedHeartbeat),
        AbortSignal.timeout(5_000),
      );
      await projectedPromise;

      const revokerName = `gateway-security-revoke-${randomUuidV7()}`;
      const revokerUrl = new URL(databaseUrl ?? 'postgresql://invalid');
      revokerUrl.searchParams.set('application_name', revokerName);
      const revoker = new Client({ connectionString: revokerUrl.toString() });
      await revoker.connect();
      let committedRenewalExpiry: string | undefined;
      const pendingRevocation = revoker.query(
        `UPDATE agent_version_controls
            SET availability = 'REVOKED', severity = 'SECURITY',
                reason_code = 'GATEWAY_TEST_REVOKED', updated_at = statement_timestamp()
          WHERE version_id = $1`,
        [ids.versionId],
      );
      try {
        await waitForPgWaitEvent(owner, revokerName, 'advisory');
        releaseProjection();
        const [renewed] = await Promise.all([pendingHeartbeat, pendingRevocation]);
        expect(renewed.map((frame) => frame.type)).toEqual(['lease.grant', 'message.ack']);
        const renewedGrant = renewed[0];
        if (renewedGrant?.type !== 'lease.grant') throw new Error('expected renewed lease grant');
        committedRenewalExpiry = renewedGrant.body.leaseExpiresAt;
        await expect(
          racingAuthority.replayEnvelope(
            competingSession,
            delivery(revokedHeartbeat),
            AbortSignal.timeout(5_000),
          ),
        ).resolves.toEqual(renewed);
      } finally {
        releaseProjection();
        await revoker.end();
      }
      await expect(
        authority.acceptEnvelope(
          competingSession,
          delivery(heartbeat(competingSession, securityLease, 1n)),
          AbortSignal.timeout(5_000),
        ),
      ).rejects.toMatchObject({ code: 'LEASE_UNAVAILABLE' });
      const afterRevocation = await owner.query<{
        expires_at: Date | string;
        lease_state: string;
        observed_state: string;
        session_state: string;
      }>(
        `SELECT lease.expires_at, lease.state AS lease_state, deployment.observed_state,
                gateway.state AS session_state
           FROM worker_leases AS lease
           JOIN deployments AS deployment ON deployment.id = lease.deployment_id
           JOIN worker_gateway_sessions AS gateway ON gateway.connection_id = lease.connection_id
          WHERE lease.id = $1`,
        [securityLease.lease.leaseId],
      );
      expect(new Date(afterRevocation.rows[0]?.expires_at ?? 0).getTime()).toBe(
        Date.parse(committedRenewalExpiry ?? ''),
      );
      expect(Date.parse(committedRenewalExpiry ?? '')).toBeGreaterThanOrEqual(securityExpiry);
      expect(afterRevocation.rows[0]).toMatchObject({
        lease_state: 'REVOKED',
        observed_state: 'BLOCKED',
        session_state: 'REVOKED',
      });

      competingSession = undefined;
      await expect(
        authority.issueChallenge({
          creatorId: ids.creatorId,
          installationId: ids.installationId,
          ...securityTarget,
          operationId: randomUuidV7(),
          signal: AbortSignal.timeout(5_000),
        }),
      ).rejects.toBeDefined();
    } finally {
      await Promise.all([
        primarySession === undefined
          ? Promise.resolve()
          : authority.closeSession(primarySession, 'SERVER_STOPPED').catch(() => undefined),
        competingSession === undefined
          ? Promise.resolve()
          : authority.closeSession(competingSession, 'SERVER_STOPPED').catch(() => undefined),
      ]);
    }
  });

  it('serializes a first Lease grant with concurrent SECURITY revocation', async () => {
    const raceAgentId = randomUuidV7();
    const raceVersionId = randomUuidV7();
    const raceDeploymentId = randomUuidV7();
    const raceInstallationId = randomUuidV7();
    const raceKeyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const matchingCapabilities = JSON.stringify({
      codexRuntimeArtifacts: [RUNTIME_DIGEST],
      codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
      isolationModes: ['apple-container-v1'],
    });
    await owner.query(
      `INSERT INTO agents (id, creator_id, public_slug, name)
       VALUES ($1, $2, $3, 'Gateway open/revoke race')`,
      [raceAgentId, ids.creatorId, `gateway-race-${raceAgentId.slice(0, 8)}`],
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
         '0.147.0-alpha.6.5', $11, $12
       )`,
      [
        raceVersionId,
        raceAgentId,
        ids.creatorId,
        randomBytes(32).toString('hex'),
        ids.snapshotId,
        randomBytes(32).toString('hex'),
        JSON.stringify(TEST_RUNTIME_POLICY),
        randomBytes(32).toString('hex'),
        randomBytes(32).toString('hex'),
        randomBytes(32).toString('hex'),
        RUNTIME_DIGEST,
        PROTOCOL_DIGEST,
      ],
    );
    await owner.query(
      `INSERT INTO agent_version_controls (version_id, creator_id) VALUES ($1, $2)`,
      [raceVersionId, ids.creatorId],
    );
    await owner.query(
      `INSERT INTO deployments (
         id, agent_id, creator_id, environment, desired_state,
         desired_version_id, generation
       ) VALUES ($1, $2, $3, 'TEST', 'ONLINE', $4, 1)`,
      [raceDeploymentId, raceAgentId, ids.creatorId, raceVersionId],
    );
    await owner.query(
      `INSERT INTO worker_installations (
         id, creator_id, installation_key_id, device_public_key,
         worker_version, protocol_versions, capabilities
       ) VALUES ($1, $2, $3, $4, $5, '[1]'::jsonb, $6::jsonb)`,
      [
        raceInstallationId,
        ids.creatorId,
        `gateway-key-${raceInstallationId}`,
        publicPoint(raceKeyPair.publicKey),
        WORKER_VERSION,
        matchingCapabilities,
      ],
    );
    const challenge = await authority.issueChallenge({
      creatorId: ids.creatorId,
      installationId: raceInstallationId,
      deploymentId: raceDeploymentId,
      deploymentGeneration: '1',
      operationId: randomUuidV7(),
      signal: AbortSignal.timeout(5_000),
    });
    const session = await authority.authenticate({
      handshake: signedHandshake(raceKeyPair.privateKey, raceInstallationId, challenge.challengeId),
      connectedAt: new Date().toISOString(),
      signal: AbortSignal.timeout(5_000),
    });

    let leaseInserted!: () => void;
    let releaseLease!: () => void;
    const leaseInsertedPromise = new Promise<void>((resolve) => (leaseInserted = resolve));
    const leaseBarrier = new Promise<void>((resolve) => (releaseLease = resolve));
    let paused = false;
    const racingAuthority = new PostgresAgentGatewayAuthority(
      pools,
      policy,
      undefined,
      async (step) => {
        if (step !== 'LEASE_INSERTED' || paused) return;
        paused = true;
        leaseInserted();
        await leaseBarrier;
      },
    );
    const pendingOpen = racingAuthority.openSession(session, AbortSignal.timeout(5_000));
    await leaseInsertedPromise;

    // PostgreSQL truncates application_name at NAMEDATALEN; keep the deterministic
    // wait probe safely below that boundary.
    const revokerName = `gw-open-revoke-${randomUuidV7()}`;
    const revokerUrl = new URL(databaseUrl ?? 'postgresql://invalid');
    revokerUrl.searchParams.set('application_name', revokerName);
    const revoker = new Client({ connectionString: revokerUrl.toString() });
    await revoker.connect();
    const pendingRevocation = revoker.query(
      `UPDATE agent_version_controls
          SET availability = 'REVOKED', severity = 'SECURITY',
              reason_code = 'OPEN_SESSION_RACE_REVOKED', updated_at = statement_timestamp()
        WHERE version_id = $1`,
      [raceVersionId],
    );
    try {
      await waitForPgWaitEvent(owner, revokerName, 'advisory');
      releaseLease();
      const [opened] = await Promise.all([pendingOpen, pendingRevocation]);
      expect(opened.map((frame) => frame.type)).toEqual(['lease.grant']);
    } finally {
      releaseLease();
      await revoker.end();
    }

    const fenced = await owner.query<{
      lease_state: string;
      session_state: string;
      observed_state: string;
      active_leases: string;
    }>(
      `SELECT lease.state AS lease_state, gateway.state AS session_state,
              deployment.observed_state,
              (SELECT count(*)::text FROM worker_leases AS active
                WHERE active.creator_id = deployment.creator_id
                  AND active.deployment_id = deployment.id
                  AND active.state = 'ACTIVE') AS active_leases
         FROM worker_gateway_sessions AS gateway
         JOIN worker_leases AS lease ON lease.connection_id = gateway.connection_id
         JOIN deployments AS deployment ON deployment.id = lease.deployment_id
        WHERE gateway.id = $1`,
      [session.workerSessionId],
    );
    expect(fenced.rows).toEqual([
      {
        lease_state: 'REVOKED',
        session_state: 'REVOKED',
        observed_state: 'BLOCKED',
        active_leases: '0',
      },
    ]);
  });
});

function nextTextFrame(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
      cleanup();
      if (isBinary) reject(new Error('unexpected binary Gateway frame'));
      else resolve(Buffer.from(data as Buffer).toString('utf8'));
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('Gateway socket closed before a frame arrived'));
    };
    const cleanup = (): void => {
      socket.off('message', onMessage);
      socket.off('close', onClose);
    };
    socket.on('message', onMessage);
    socket.on('close', onClose);
  });
}

async function waitForPgWaitEvent(
  pool: Client,
  applicationName: string,
  expectedWaitEvent: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const observed = await pool.query<{ wait_event: string | null }>(
      `SELECT wait_event
         FROM pg_stat_activity
        WHERE application_name = $1 AND state = 'active'`,
      [applicationName],
    );
    if (observed.rows.some((row) => row.wait_event === expectedWaitEvent)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`PostgreSQL did not enter ${expectedWaitEvent} wait`);
}

function nextTextFrames(socket: WebSocket, count: number): Promise<readonly string[]> {
  return new Promise((resolve, reject) => {
    const frames: string[] = [];
    const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
      if (isBinary) {
        cleanup();
        reject(new Error('unexpected binary Gateway frame'));
        return;
      }
      frames.push(Buffer.from(data as Buffer).toString('utf8'));
      if (frames.length === count) {
        cleanup();
        resolve(frames);
      }
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('Gateway socket closed before all frames arrived'));
    };
    const cleanup = (): void => {
      socket.off('message', onMessage);
      socket.off('close', onClose);
    };
    socket.on('message', onMessage);
    socket.on('close', onClose);
  });
}
