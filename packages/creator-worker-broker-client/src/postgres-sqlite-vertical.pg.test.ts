import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import {
  AgentGateway,
  PostgresAgentGatewayAuthority,
  toGatewayPool,
  type GatewayCompatibilityPolicy,
  type GatewayConnection,
  type GatewayDiagnosticEvent,
  type GatewayPool,
} from '@cb/agent-gateway';
import {
  BrokerEnvelopeSchema,
  canonicalSha256,
  parseBrokerFrame,
  type BrokerEnvelope,
} from '@cb/creator-agent-protocol';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer, type RawData } from 'ws';

import {
  SqliteWorkerBrokerDurableTransport,
  type NewWorkerJournalAuthorization,
} from './sqlite-durable-transport.js';
import { WorkerBrokerClient, type WorkerBrokerDiagnosticEvent } from './worker-broker-client.js';

const databaseUrl = process.env.DATABASE_URL;
const apiPassword = process.env.POSTGRES_AGENT_API_PASSWORD;
const brokerPassword = process.env.POSTGRES_AGENT_BROKER_PASSWORD;
const enabled = process.env.CREATOR_AGENT_VERTICAL_PG_SQLITE_TEST === '1';

if (enabled && !(databaseUrl && apiPassword && brokerPassword)) {
  throw new Error('VERTICAL_PG_SQLITE_TEST_CONFIGURATION_MISSING');
}

const pgDescribe = enabled ? describe.sequential : describe.skip;
const { DatabaseSync: SqliteDatabase } = createRequire(import.meta.url)('node:sqlite') as {
  readonly DatabaseSync: typeof DatabaseSync;
};
const WORKER_VERSION = 'combo-worker-vertical/1';
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

type FixtureIds = Readonly<{
  creatorId: string;
  snapshotId: string;
  agentId: string;
  versionId: string;
  deploymentId: string;
  installationId: string;
}>;

type PgLeaseFact = Readonly<{
  worker_session_id: string;
  connection_id: string;
  session_state: string;
  lease_id: string;
  fence: string;
  lease_state: string;
  lease_expires_at_ms: string;
  deployment_fence: string;
}>;

type PgOutboundFact = Readonly<{
  message_id: string;
  canonical_digest: string;
  envelope_type: string;
  grant_lease_id: string | null;
  grant_fence: string | null;
  grant_expires_at_ms: string | null;
  durable_ack_level: string | null;
  ack_decision: string | null;
}>;

type SqliteConnectionFact = Readonly<{
  connection_id: string;
  worker_session_id: string;
  deployment_id: string;
  lease_id: string;
  fence: string;
  lease_state: string;
  lease_expires_at: string;
  status: string;
}>;

type SqliteMetaFact = Readonly<{
  journal_generation: string;
  authorization_digest: string;
  schema_digest: string;
  commit_epoch: number;
}>;

type CommitLossFact = Readonly<{
  frame_receipts: string;
  frame_session_id: string;
  frame_sequence: string;
  frame_canonical_digest: string;
  envelope_type: string;
  response_frames: unknown;
  operation_receipts: string;
  operation_key: string;
  request_digest: string;
  result_digest: string;
  result_value: unknown;
}>;

type CommitLossTarget = Readonly<{
  creatorId: string;
  messageId: string;
  canonicalDigest: string;
  operationKey: string;
  connectionId: string;
  workerSessionId: string;
  sequence: string;
}>;

pgDescribe('PostgreSQL Gateway to Worker SQLite vertical control chain', () => {
  it('renews beyond the initial Lease TTL, reconnects after Gateway restart, and reopens one journal', async () => {
    const owner = new Pool({ connectionString: databaseUrl, max: 4 });
    const apiPool = new Pool({
      connectionString: roleUrl('combo_agent_api', apiPassword ?? 'invalid'),
      max: 2,
    });
    const brokerPool = new Pool({
      connectionString: roleUrl('combo_agent_broker', brokerPassword ?? 'invalid'),
      max: 6,
    });
    const policy: GatewayCompatibilityPolicy = {
      acceptedWorkerVersions: [WORKER_VERSION],
      acceptedCodexRuntimeArtifacts: [RUNTIME_DIGEST],
      acceptedCodexProtocolSchemaDigests: [PROTOCOL_DIGEST],
      acceptedIsolationModes: ['apple-container-v1'],
      sessionTtlMs: 60_000,
      leaseTtlMs: 10_000,
      responseTtlMs: 5_000,
      transactionTimeoutMs: 2_000,
    };
    const commitLossPool = new PredicateCommitResponseLossPool(toGatewayPool(brokerPool));
    const authority = new PostgresAgentGatewayAuthority(
      { api: toGatewayPool(apiPool), broker: commitLossPool },
      policy,
    );
    const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const fixture = await seedFixture(owner, keyPair.publicKey);
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'combo-pg-sqlite-vertical-')));
    const filename = join(directory, 'journal.sqlite');
    const journalAuthorization = newJournalAuthorization(fixture.installationId);
    const diagnostics: WorkerBrokerDiagnosticEvent[] = [];
    const gatewayDiagnostics: GatewayDiagnosticEvent[] = [];
    let gateway: AgentGateway | undefined;
    let relay: RawWebSocketRelay | undefined;
    let firstClient: WorkerBrokerClient | undefined;
    let secondClient: WorkerBrokerClient | undefined;
    let firstAdapter: SqliteWorkerBrokerDurableTransport | undefined;
    let secondAdapter: SqliteWorkerBrokerDurableTransport | undefined;

    try {
      gateway = new AgentGateway({
        authority,
        authorityTimeoutMs: 3_000,
        stopTimeoutMs: 3_000,
        diagnosticSink: (event) => gatewayDiagnostics.push(event),
      });
      const firstAddress = await gateway.start();
      const upstreamUrl = `ws://${firstAddress.host}:${firstAddress.port}${firstAddress.path}`;
      relay = new RawWebSocketRelay(upstreamUrl, firstAddress.path, (frame, canonicalDigest) => {
        commitLossPool.arm({
          creatorId: fixture.creatorId,
          messageId: frame.messageId,
          canonicalDigest,
          operationKey: `${frame.messageId}:${canonicalDigest}`,
          connectionId: frame.connectionId,
          workerSessionId: frame.lease.workerSessionId,
          sequence: frame.sequence,
        });
      });
      const url = await relay.start();
      const ports = workerPorts(authority, owner, fixture, keyPair.privateKey);
      firstAdapter = new SqliteWorkerBrokerDurableTransport({
        filename,
        newJournalAuthorization: journalAuthorization,
      });
      firstClient = createWorkerClient(
        url,
        fixture.installationId,
        firstAdapter,
        ports,
        diagnostics,
      );
      await firstClient.start();
      await waitFor(() => firstClient?.status === 'READY', 8_000, 'INITIAL_READY_TIMEOUT');
      await waitFor(
        async () => (await persistedGrantCount(owner, fixture)) >= 1,
        8_000,
        'INITIAL_GRANT_ACK_TIMEOUT',
      );

      const initialLease = await activeLease(owner, fixture);
      const initialExpiryMs = Number(initialLease.lease_expires_at_ms);
      const initialGrant = await firstPersistedGrant(
        owner,
        fixture,
        initialLease.worker_session_id,
      );
      assertGrantBinding(initialGrant, initialLease);
      await waitFor(
        () => diagnostics.includes('frame_replayed'),
        3_000,
        'WORKER_DURABLE_REPLAY_NOT_OBSERVED',
      );
      expect(
        sqliteInboundReplayCount(filename, initialLease.connection_id, initialGrant.message_id),
      ).toBe(1);
      expect(
        sqliteOutboxResponseCount(filename, initialLease.connection_id, initialGrant.message_id),
      ).toBe(1);
      expect(sqliteConnection(filename, initialLease.connection_id)).toEqual(
        sqliteLeaseProjection(initialLease, fixture.deploymentId),
      );

      await waitFor(
        async () => {
          const current = await activeLease(owner, fixture);
          return (
            Date.now() > initialExpiryMs + 250 &&
            current.lease_id === initialLease.lease_id &&
            current.fence === initialLease.fence &&
            Number(current.lease_expires_at_ms) > initialExpiryMs
          );
        },
        20_000,
        'LEASE_DID_NOT_RENEW_BEYOND_INITIAL_TTL',
      );
      await waitFor(
        async () => (await persistedGrantCount(owner, fixture)) >= 2,
        8_000,
        'RENEWAL_GRANT_ACK_TIMEOUT',
      );
      await waitFor(
        () => gatewayDiagnostics.includes('frame_replayed'),
        5_000,
        'GATEWAY_DURABLE_REPLAY_NOT_OBSERVED',
      );
      expect(relay.duplicateCounts).toEqual({ cloudToWorker: 1, workerToCloud: 1 });
      expect(relay.duplicatePayloadHashes.cloudToWorker).toHaveLength(1);
      expect(relay.duplicatePayloadHashes.workerToCloud).toHaveLength(1);
      await waitFor(
        () => commitLossPool.lostTarget !== undefined,
        8_000,
        'TARGETED_COMMIT_RESPONSE_LOSS_NOT_OBSERVED',
      );
      const lostTarget = commitLossPool.lostTarget;
      if (lostTarget === undefined) throw new Error('TARGETED_COMMIT_RESPONSE_LOSS_MISSING');
      expect(commitLossPool.lossCount).toBe(1);
      expect(commitLossPool.lostOperationKind).toBe('ACCEPT_ENVELOPE');
      await waitFor(
        () => sqliteOutboxCloudCommitted(filename, lostTarget.messageId),
        8_000,
        'COMMIT_RESPONSE_LOSS_DID_NOT_CONVERGE_LOCALLY',
      );
      const lossFact = await commitLossFact(owner, fixture, lostTarget);
      const expectedRequestDigest = canonicalSha256({
        session: {
          ownerId: fixture.creatorId,
          installationId: fixture.installationId,
          connectionId: lostTarget.connectionId,
          workerSessionId: lostTarget.workerSessionId,
        },
        canonicalDigest: lostTarget.canonicalDigest,
      });
      expect(commitLossPool.requestDigest).toBe(expectedRequestDigest);
      expect(lossFact).toMatchObject({
        frame_receipts: '1',
        frame_session_id: lostTarget.workerSessionId,
        frame_sequence: lostTarget.sequence,
        frame_canonical_digest: lostTarget.canonicalDigest,
        envelope_type: 'heartbeat',
        operation_receipts: '1',
        operation_key: lostTarget.operationKey,
        request_digest: expectedRequestDigest,
      });
      expect(canonicalSha256(lossFact.result_value)).toBe(lossFact.result_digest);
      expect(lossFact.result_value).toMatchObject({ kind: 'RESPONSES' });
      const recoveredResponses = commitLossResponses(lossFact.result_value);
      const durableResponses = BrokerEnvelopeSchema.array().parse(lossFact.response_frames);
      expect(recoveredResponses).toEqual(durableResponses);
      expect(recoveredResponses.map(({ type }) => type)).toEqual(['lease.grant', 'message.ack']);
      expect(recoveredResponses[1]).toMatchObject({
        type: 'message.ack',
        body: {
          acknowledgedMessageId: lostTarget.messageId,
          level: 'CLOUD_COMMITTED',
          decision: 'APPLIED',
        },
      });
      await assertCommitLossOutbound(owner, fixture, lostTarget, recoveredResponses);
      assertCommitLossSqlite(filename, lostTarget, recoveredResponses);
      expect(firstClient.status).toBe('READY');
      expect(firstClient.connected).toBe(true);
      expect(diagnostics.filter((event) => event === 'connection_lost')).toHaveLength(0);

      const renewedLease = await activeLease(owner, fixture);
      expect(firstClient.status).toBe('READY');
      expect(firstClient.connected).toBe(true);
      expect(renewedLease.lease_id).toBe(initialLease.lease_id);
      expect(renewedLease.fence).toBe(initialLease.fence);
      expect(Number(renewedLease.lease_expires_at_ms)).toBeGreaterThan(initialExpiryMs);
      expect(sqliteConnection(filename, renewedLease.connection_id)).toEqual(
        sqliteLeaseProjection(renewedLease, fixture.deploymentId),
      );
      await assertTwoJournalBindings(owner, filename, fixture, renewedLease);

      const firstPort = firstAddress.port;
      await gateway.stop();
      gateway = new AgentGateway({
        authority,
        port: firstPort,
        authorityTimeoutMs: 3_000,
        stopTimeoutMs: 3_000,
        diagnosticSink: (event) => gatewayDiagnostics.push(event),
      });
      const restartedAddress = await gateway.start();
      expect(restartedAddress.port).toBe(firstPort);
      await waitFor(
        async () => {
          if (firstClient?.status !== 'READY') return false;
          const current = await activeLease(owner, fixture).catch(() => undefined);
          return (
            current !== undefined &&
            current.connection_id !== renewedLease.connection_id &&
            BigInt(current.fence) > BigInt(renewedLease.fence)
          );
        },
        12_000,
        'GATEWAY_RESTART_RECONNECT_TIMEOUT',
      );

      const reconnectedLease = await activeLease(owner, fixture);
      expect(BigInt(reconnectedLease.fence)).toBeGreaterThan(BigInt(renewedLease.fence));
      expect(await activeLeaseCount(owner, fixture)).toBe(1);
      expect(sqliteConnection(filename, reconnectedLease.connection_id)).toEqual(
        sqliteLeaseProjection(reconnectedLease, fixture.deploymentId),
      );
      expect(sqliteReleasedConnection(filename, renewedLease.connection_id)?.status).toBe(
        'RELEASED',
      );
      expect(diagnostics).toContain('connection_lost');
      expect(diagnostics).toContain('reconnect_scheduled');

      await firstClient.stop();
      firstClient = undefined;
      const metaBeforeReopen = sqliteMeta(filename);
      firstAdapter.close();
      firstAdapter = undefined;

      secondAdapter = new SqliteWorkerBrokerDurableTransport({ filename });
      expect(secondAdapter.inspectPragmas()).toMatchObject({
        journalMode: 'wal',
        synchronous: 2,
        foreignKeys: 1,
        quickCheck: 'ok',
      });
      secondClient = createWorkerClient(
        url,
        fixture.installationId,
        secondAdapter,
        ports,
        diagnostics,
      );
      await secondClient.start();
      await waitFor(
        async () => {
          if (secondClient?.status !== 'READY') return false;
          const current = await activeLease(owner, fixture).catch(() => undefined);
          return current !== undefined && BigInt(current.fence) > BigInt(reconnectedLease.fence);
        },
        10_000,
        'JOURNAL_REOPEN_RECONNECT_TIMEOUT',
      );

      const reopenedLease = await activeLease(owner, fixture);
      const metaAfterReopen = sqliteMeta(filename);
      expect(metaAfterReopen.journal_generation).toBe(metaBeforeReopen.journal_generation);
      expect(metaAfterReopen.authorization_digest).toBe(metaBeforeReopen.authorization_digest);
      expect(metaAfterReopen.schema_digest).toBe(metaBeforeReopen.schema_digest);
      expect(metaAfterReopen.commit_epoch).toBeGreaterThan(metaBeforeReopen.commit_epoch);
      expect(BigInt(reopenedLease.fence)).toBeGreaterThan(BigInt(reconnectedLease.fence));
      expect(sqliteActiveConnectionCount(filename)).toBe(1);
      expect(sqliteConnection(filename, reopenedLease.connection_id)).toEqual(
        sqliteLeaseProjection(reopenedLease, fixture.deploymentId),
      );
      expect(await activeLeaseCount(owner, fixture)).toBe(1);
      expect(await securityAndGapCounts(owner, fixture)).toEqual({
        security_events: '0',
        sequence_gaps: '0',
      });
    } finally {
      await secondClient?.stop().catch(() => undefined);
      await firstClient?.stop().catch(() => undefined);
      secondAdapter?.close();
      firstAdapter?.close();
      await relay?.stop().catch(() => undefined);
      await gateway?.stop().catch(() => undefined);
      await Promise.all([owner.end(), apiPool.end(), brokerPool.end()]);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 55_000);
});

function roleUrl(role: 'combo_agent_api' | 'combo_agent_broker', password: string): string {
  const url = new URL(databaseUrl ?? 'postgresql://invalid:invalid@127.0.0.1:1/invalid');
  url.username = role;
  url.password = password;
  return url.toString();
}

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

function publicPoint(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new Error('INVALID_TEST_P256_PUBLIC_KEY');
  }
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  if (x.byteLength !== 32 || y.byteLength !== 32) throw new Error('INVALID_TEST_P256_POINT');
  return Buffer.concat([Buffer.from([0x04]), x, y]);
}

async function seedFixture(owner: Pool, publicKey: KeyObject): Promise<FixtureIds> {
  const ids = {
    creatorId: '',
    snapshotId: randomUuidV7(),
    agentId: randomUuidV7(),
    versionId: randomUuidV7(),
    deploymentId: randomUuidV7(),
    installationId: randomUuidV7(),
  };
  const creator = await owner.query<{ id: string }>(
    'INSERT INTO users (account) VALUES ($1) RETURNING id::text',
    [creatorAccount()],
  );
  const creatorId = creator.rows[0]?.id;
  if (creatorId === undefined) throw new Error('VERTICAL_FIXTURE_CREATOR_FAILED');
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
     VALUES ($1, $2, $3, 'PG SQLite Vertical Agent')`,
    [ids.agentId, ids.creatorId, `vertical-${ids.agentId.slice(0, 8)}`],
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
       id, agent_id, creator_id, environment, desired_state, desired_version_id, generation
     ) VALUES ($1, $2, $3, 'TEST', 'ONLINE', $4, 1)`,
    [ids.deploymentId, ids.agentId, ids.creatorId, ids.versionId],
  );
  await owner.query('INSERT INTO agent_version_controls (version_id, creator_id) VALUES ($1, $2)', [
    ids.versionId,
    ids.creatorId,
  ]);
  await owner.query(
    `INSERT INTO worker_installations (
       id, creator_id, installation_key_id, device_public_key,
       worker_version, protocol_versions, capabilities
     ) VALUES ($1, $2, $3, $4, $5, '[1]'::jsonb, $6::jsonb)`,
    [
      ids.installationId,
      ids.creatorId,
      `vertical-key-${ids.installationId}`,
      publicPoint(publicKey),
      WORKER_VERSION,
      JSON.stringify({
        codexRuntimeArtifacts: [RUNTIME_DIGEST],
        codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
        isolationModes: ['apple-container-v1'],
      }),
    ],
  );
  return Object.freeze(ids);
}

function workerPorts(
  authority: PostgresAgentGatewayAuthority,
  owner: Pool,
  fixture: FixtureIds,
  privateKey: KeyObject,
) {
  return Object.freeze({
    challengePort: {
      async requestChallenge(input: { installationId: string; signal: AbortSignal }) {
        if (input.installationId !== fixture.installationId) {
          throw new Error('VERTICAL_INSTALLATION_MISMATCH');
        }
        const challenge = await authority.issueChallenge({
          creatorId: fixture.creatorId,
          installationId: fixture.installationId,
          deploymentId: fixture.deploymentId,
          deploymentGeneration: '1',
          operationId: randomUuidV7(),
          ttlSeconds: 30,
          signal: input.signal,
        });
        const cloud = await owner.query<{ cloud_time: Date }>(
          'SELECT clock_timestamp() AS cloud_time',
        );
        const cloudTime = cloud.rows[0]?.cloud_time;
        if (!(cloudTime instanceof Date)) throw new Error('VERTICAL_CLOUD_TIME_MISSING');
        return { challengeId: challenge.challengeId, cloudTime: cloudTime.toISOString() };
      },
    },
    deviceSigner: {
      async signCanonicalHandshake(input: {
        installationId: string;
        canonicalBytes: Uint8Array;
        signal: AbortSignal;
      }) {
        if (input.signal.aborted) throw input.signal.reason;
        if (input.installationId !== fixture.installationId) {
          throw new Error('VERTICAL_INSTALLATION_MISMATCH');
        }
        return sign('sha256', input.canonicalBytes, {
          key: privateKey,
          dsaEncoding: 'ieee-p1363',
        }).toString('base64url');
      },
    },
  });
}

function createWorkerClient(
  url: string,
  installationId: string,
  durablePort: SqliteWorkerBrokerDurableTransport,
  ports: ReturnType<typeof workerPorts>,
  diagnostics: WorkerBrokerDiagnosticEvent[],
): WorkerBrokerClient {
  return new WorkerBrokerClient({
    url,
    installationId,
    workerVersion: WORKER_VERSION,
    codexRuntimeArtifacts: [RUNTIME_DIGEST],
    codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
    isolationModes: ['apple-container-v1'],
    challengePort: ports.challengePort,
    deviceSigner: ports.deviceSigner,
    durablePort,
    allowInsecureLoopbackForTests: true,
    handshakeTimeoutMs: 5_000,
    portTimeoutMs: 2_000,
    heartbeatIntervalMs: 1_500,
    maximumLeaseGrantMs: 20_000,
    reconnectInitialMs: 50,
    reconnectMaximumMs: 250,
    stopTimeoutMs: 4_000,
    diagnosticSink: (event) => diagnostics.push(event),
  });
}

function newJournalAuthorization(installationId: string): NewWorkerJournalAuthorization {
  return Object.freeze({
    installationId,
    journalGeneration: randomUuidV7(),
    authorizationDigest: createHash('sha256')
      .update(`vertical-new-worker-journal:${installationId}`, 'utf8')
      .digest('hex'),
  });
}

async function activeLease(owner: Pool, fixture: FixtureIds): Promise<PgLeaseFact> {
  const result = await owner.query<PgLeaseFact>(
    `SELECT gateway.id::text AS worker_session_id,
            gateway.connection_id::text,
            gateway.state AS session_state,
            lease.id::text AS lease_id,
            lease.fence::text,
            lease.state AS lease_state,
            floor(extract(epoch FROM lease.expires_at) * 1000)::bigint::text
              AS lease_expires_at_ms,
            deployment.lease_fence::text AS deployment_fence
       FROM worker_gateway_sessions AS gateway
       JOIN worker_leases AS lease
         ON lease.connection_id = gateway.connection_id
        AND lease.worker_id = gateway.installation_id
        AND lease.creator_id = gateway.creator_id
       JOIN deployments AS deployment
         ON deployment.id = lease.deployment_id
        AND deployment.creator_id = lease.creator_id
      WHERE gateway.creator_id = $1 AND gateway.installation_id = $2
        AND gateway.state = 'ACTIVE' AND lease.state = 'ACTIVE'
      ORDER BY gateway.connected_at DESC`,
    [fixture.creatorId, fixture.installationId],
  );
  if (result.rows.length !== 1 || result.rows[0] === undefined) {
    throw new Error(`VERTICAL_ACTIVE_LEASE_COUNT_${result.rows.length}`);
  }
  return result.rows[0];
}

async function activeLeaseCount(owner: Pool, fixture: FixtureIds): Promise<number> {
  const result = await owner.query<{ count: string }>(
    `SELECT count(*)::text
       FROM worker_leases
      WHERE creator_id = $1 AND worker_id = $2 AND state = 'ACTIVE'`,
    [fixture.creatorId, fixture.installationId],
  );
  return Number(result.rows[0]?.count ?? '-1');
}

async function persistedGrantCount(owner: Pool, fixture: FixtureIds): Promise<number> {
  const result = await owner.query<{ count: string }>(
    `SELECT count(*)::text
       FROM worker_gateway_outbound_frames AS outbound
       JOIN worker_gateway_sessions AS gateway ON gateway.id = outbound.session_id
      WHERE gateway.creator_id = $1 AND gateway.installation_id = $2
        AND outbound.envelope_type = 'lease.grant'
        AND outbound.durable_ack_level = 'PERSISTED'
        AND outbound.ack_decision = 'APPLIED'`,
    [fixture.creatorId, fixture.installationId],
  );
  return Number(result.rows[0]?.count ?? '-1');
}

async function commitLossFact(
  owner: Pool,
  fixture: FixtureIds,
  target: CommitLossTarget,
): Promise<CommitLossFact> {
  const result = await owner.query<CommitLossFact>(
    `SELECT
       (SELECT count(*)::text
          FROM worker_gateway_frame_receipts
         WHERE creator_id = $1 AND message_id = $2) AS frame_receipts,
       frame.session_id::text AS frame_session_id,
       frame.sequence::text AS frame_sequence,
       frame.canonical_digest AS frame_canonical_digest,
       frame.envelope_type,
       frame.response_frames,
       (SELECT count(*)::text
          FROM worker_gateway_operation_receipts
         WHERE creator_id = $1 AND operation_kind = 'ACCEPT_ENVELOPE'
           AND operation_key = $3) AS operation_receipts,
       operation.operation_key,
       operation.request_digest,
       operation.result_digest,
       operation.result_value
      FROM worker_gateway_frame_receipts AS frame
      JOIN worker_gateway_operation_receipts AS operation
        ON operation.creator_id = frame.creator_id
       AND operation.operation_kind = 'ACCEPT_ENVELOPE'
       AND operation.operation_key = $3
     WHERE frame.creator_id = $1 AND frame.message_id = $2`,
    [fixture.creatorId, target.messageId, target.operationKey],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('VERTICAL_COMMIT_LOSS_FACT_MISSING');
  return row;
}

function commitLossResponses(value: unknown): readonly BrokerEnvelope[] {
  if (typeof value !== 'object' || value === null || !('responses' in value)) {
    throw new Error('VERTICAL_COMMIT_LOSS_RESPONSES_MISSING');
  }
  return BrokerEnvelopeSchema.array().parse(value.responses);
}

async function assertCommitLossOutbound(
  owner: Pool,
  fixture: FixtureIds,
  target: CommitLossTarget,
  responses: readonly BrokerEnvelope[],
): Promise<void> {
  const result = await owner.query<{
    message_id: string;
    canonical_digest: string;
  }>(
    `SELECT message_id::text, canonical_digest
       FROM worker_gateway_outbound_frames
      WHERE creator_id = $1 AND session_id = $2
        AND message_id = ANY($3::uuid[])
      ORDER BY sequence`,
    [fixture.creatorId, target.workerSessionId, responses.map(({ messageId }) => messageId)],
  );
  expect(result.rows).toEqual(
    responses.map((response) => ({
      message_id: response.messageId,
      canonical_digest: canonicalSha256(response),
    })),
  );
}

function assertCommitLossSqlite(
  filename: string,
  target: CommitLossTarget,
  responses: readonly BrokerEnvelope[],
): void {
  expect(
    sqliteOne<{
      message_id: string;
      connection_id: string;
      sequence: string;
      canonical_digest: string;
      state: string;
      ack_level: string | null;
    }>(
      filename,
      `SELECT message_id, connection_id, sequence, canonical_digest, state, ack_level
         FROM transport_outbox WHERE message_id = ?`,
      target.messageId,
    ),
  ).toEqual({
    message_id: target.messageId,
    connection_id: target.connectionId,
    sequence: target.sequence,
    canonical_digest: target.canonicalDigest,
    state: 'ACKED',
    ack_level: 'CLOUD_COMMITTED',
  });
  const inbound = sqliteAll<{
    message_id: string;
    canonical_digest: string;
    effect_state: string;
    replay_count: number;
  }>(
    filename,
    `SELECT message_id, canonical_digest, effect_state, replay_count
       FROM transport_inbound_frames
      WHERE connection_id = ? AND message_id IN (?, ?)
      ORDER BY CAST(sequence AS INTEGER)`,
    target.connectionId,
    responses[0]?.messageId ?? '',
    responses[1]?.messageId ?? '',
  );
  expect(inbound).toEqual(
    responses.map((response) => ({
      message_id: response.messageId,
      canonical_digest: canonicalSha256(response),
      effect_state: 'APPLIED',
      replay_count: 0,
    })),
  );
}

async function firstPersistedGrant(
  owner: Pool,
  fixture: FixtureIds,
  workerSessionId: string,
): Promise<PgOutboundFact> {
  const result = await owner.query<PgOutboundFact>(
    `SELECT message_id::text, canonical_digest, envelope_type,
            grant_lease_id::text, grant_fence::text,
            floor(extract(epoch FROM grant_expires_at) * 1000)::bigint::text
              AS grant_expires_at_ms,
            durable_ack_level, ack_decision
       FROM worker_gateway_outbound_frames
      WHERE creator_id = $1 AND session_id = $2 AND envelope_type = 'lease.grant'
        AND durable_ack_level = 'PERSISTED' AND ack_decision = 'APPLIED'
      ORDER BY sequence LIMIT 1`,
    [fixture.creatorId, workerSessionId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('VERTICAL_PERSISTED_GRANT_MISSING');
  return row;
}

function assertGrantBinding(grant: PgOutboundFact, lease: PgLeaseFact): void {
  expect(grant.grant_lease_id).toBe(lease.lease_id);
  expect(grant.grant_fence).toBe(lease.fence);
  expect(grant.grant_expires_at_ms).toBe(lease.lease_expires_at_ms);
  expect(grant.durable_ack_level).toBe('PERSISTED');
  expect(grant.ack_decision).toBe('APPLIED');
}

async function assertTwoJournalBindings(
  owner: Pool,
  filename: string,
  fixture: FixtureIds,
  lease: PgLeaseFact,
): Promise<void> {
  const grants = await owner.query<PgOutboundFact>(
    `SELECT message_id::text, canonical_digest, envelope_type,
            grant_lease_id::text, grant_fence::text,
            floor(extract(epoch FROM grant_expires_at) * 1000)::bigint::text
              AS grant_expires_at_ms,
            durable_ack_level, ack_decision
       FROM worker_gateway_outbound_frames
      WHERE creator_id = $1 AND session_id = $2 AND envelope_type = 'lease.grant'
        AND durable_ack_level = 'PERSISTED' AND ack_decision = 'APPLIED'
      ORDER BY sequence`,
    [fixture.creatorId, lease.worker_session_id],
  );
  expect(grants.rows.length).toBeGreaterThanOrEqual(2);
  const renewal = grants.rows.at(-1);
  if (renewal === undefined) throw new Error('VERTICAL_RENEWAL_GRANT_MISSING');
  assertGrantBinding(renewal, lease);
  const localGrant = sqliteOne<{ message_id: string; canonical_digest: string }>(
    filename,
    `SELECT message_id, canonical_digest
       FROM transport_inbound_frames
      WHERE connection_id = ? AND message_id = ? AND envelope_type = 'lease.grant'`,
    lease.connection_id,
    renewal.message_id,
  );
  expect(localGrant).toEqual({
    message_id: renewal.message_id,
    canonical_digest: renewal.canonical_digest,
  });

  const renewed = sqliteOne<{
    message_id: string;
    canonical_digest: string;
    response_to_message_id: string;
  }>(
    filename,
    `SELECT message_id, canonical_digest, response_to_message_id
       FROM transport_outbox
      WHERE connection_id = ? AND envelope_type = 'lease.renewed'
        AND response_to_message_id = ?`,
    lease.connection_id,
    renewal.message_id,
  );
  expect(renewed.response_to_message_id).toBe(renewal.message_id);
  const renewedCloud = await owner.query<{
    message_id: string;
    canonical_digest: string;
    envelope_type: string;
  }>(
    `SELECT message_id::text, canonical_digest, envelope_type
       FROM worker_gateway_frame_receipts
      WHERE creator_id = $1 AND session_id = $2 AND message_id = $3`,
    [fixture.creatorId, lease.worker_session_id, renewed.message_id],
  );
  expect(renewedCloud.rows).toEqual([
    {
      message_id: renewed.message_id,
      canonical_digest: renewed.canonical_digest,
      envelope_type: 'lease.renewed',
    },
  ]);

  const heartbeat = sqliteOne<{ message_id: string; canonical_digest: string }>(
    filename,
    `SELECT message_id, canonical_digest
       FROM transport_outbox
      WHERE connection_id = ? AND envelope_type = 'heartbeat'
      ORDER BY created_at_ms LIMIT 1`,
    lease.connection_id,
  );
  const heartbeatCloud = await owner.query<{
    message_id: string;
    canonical_digest: string;
    envelope_type: string;
  }>(
    `SELECT message_id::text, canonical_digest, envelope_type
       FROM worker_gateway_frame_receipts
      WHERE creator_id = $1 AND session_id = $2 AND message_id = $3`,
    [fixture.creatorId, lease.worker_session_id, heartbeat.message_id],
  );
  expect(heartbeatCloud.rows).toEqual([
    {
      message_id: heartbeat.message_id,
      canonical_digest: heartbeat.canonical_digest,
      envelope_type: 'heartbeat',
    },
  ]);
}

function sqliteConnection(filename: string, connectionId: string): SqliteConnectionFact {
  return sqliteOne<SqliteConnectionFact>(
    filename,
    `SELECT connection_id, worker_session_id, deployment_id, lease_id, fence,
            lease_state, lease_expires_at, status
       FROM transport_connections WHERE connection_id = ?`,
    connectionId,
  );
}

function sqliteReleasedConnection(
  filename: string,
  connectionId: string,
): SqliteConnectionFact | undefined {
  return sqliteMaybeOne<SqliteConnectionFact>(
    filename,
    `SELECT connection_id, worker_session_id, deployment_id, lease_id, fence,
            lease_state, lease_expires_at, status
       FROM transport_connections WHERE connection_id = ?`,
    connectionId,
  );
}

function sqliteLeaseProjection(lease: PgLeaseFact, deploymentId: string): SqliteConnectionFact {
  return {
    connection_id: lease.connection_id,
    worker_session_id: lease.worker_session_id,
    deployment_id: deploymentId,
    lease_id: lease.lease_id,
    fence: lease.fence,
    lease_state: 'ACTIVE',
    lease_expires_at: new Date(Number(lease.lease_expires_at_ms)).toISOString(),
    status: 'ACTIVE',
  };
}

function sqliteMeta(filename: string): SqliteMetaFact {
  return sqliteOne<SqliteMetaFact>(
    filename,
    `SELECT journal_generation, authorization_digest, schema_digest, commit_epoch
       FROM transport_meta WHERE singleton = 1`,
  );
}

function sqliteActiveConnectionCount(filename: string): number {
  return sqliteOne<{ count: number }>(
    filename,
    `SELECT count(*) AS count FROM transport_connections WHERE status = 'ACTIVE'`,
  ).count;
}

function sqliteInboundReplayCount(
  filename: string,
  connectionId: string,
  messageId: string,
): number {
  return sqliteOne<{ replay_count: number }>(
    filename,
    `SELECT replay_count FROM transport_inbound_frames
      WHERE connection_id = ? AND message_id = ?`,
    connectionId,
    messageId,
  ).replay_count;
}

function sqliteOutboxResponseCount(
  filename: string,
  connectionId: string,
  responseToMessageId: string,
): number {
  return sqliteOne<{ count: number }>(
    filename,
    `SELECT count(*) AS count FROM transport_outbox
      WHERE connection_id = ? AND response_to_message_id = ?`,
    connectionId,
    responseToMessageId,
  ).count;
}

function sqliteOutboxCloudCommitted(filename: string, messageId: string): boolean {
  const row = sqliteMaybeOne<{ state: string; ack_level: string | null }>(
    filename,
    `SELECT state, ack_level FROM transport_outbox WHERE message_id = ?`,
    messageId,
  );
  return row?.state === 'ACKED' && row.ack_level === 'CLOUD_COMMITTED';
}

function sqliteOne<Row>(filename: string, sql: string, ...parameters: SQLInputValue[]): Row {
  const row = sqliteMaybeOne<Row>(filename, sql, ...parameters);
  if (row === undefined) throw new Error('VERTICAL_SQLITE_ROW_MISSING');
  return row;
}

function sqliteMaybeOne<Row>(
  filename: string,
  sql: string,
  ...parameters: SQLInputValue[]
): Row | undefined {
  const database = new SqliteDatabase(filename, { readOnly: true });
  try {
    return database.prepare(sql).get(...parameters) as Row | undefined;
  } finally {
    database.close();
  }
}

function sqliteAll<Row>(filename: string, sql: string, ...parameters: SQLInputValue[]): Row[] {
  const database = new SqliteDatabase(filename, { readOnly: true });
  try {
    return database.prepare(sql).all(...parameters) as Row[];
  } finally {
    database.close();
  }
}

async function securityAndGapCounts(owner: Pool, fixture: FixtureIds) {
  const result = await owner.query<{ security_events: string; sequence_gaps: string }>(
    `SELECT
       (SELECT count(*)::text FROM worker_gateway_security_events
         WHERE creator_id = $1) AS security_events,
       (SELECT count(*)::text FROM worker_gateway_sequence_gaps
         WHERE creator_id = $1) AS sequence_gaps`,
    [fixture.creatorId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('VERTICAL_AUDIT_COUNTS_MISSING');
  return row;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  code: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(code);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

class PredicateCommitResponseLossPool implements GatewayPool {
  readonly #delegate: GatewayPool;
  #lostOperationKind: string | undefined;
  #lostTarget: CommitLossTarget | undefined;
  #lossCount = 0;
  #requestDigest: string | undefined;
  #target: CommitLossTarget | undefined;

  constructor(delegate: GatewayPool) {
    this.#delegate = delegate;
  }

  get lostTarget(): CommitLossTarget | undefined {
    return this.#lostTarget;
  }

  get lostOperationKind(): string | undefined {
    return this.#lostOperationKind;
  }

  get lossCount(): number {
    return this.#lossCount;
  }

  get requestDigest(): string | undefined {
    return this.#requestDigest;
  }

  arm(target: CommitLossTarget): void {
    if (this.#target !== undefined || this.#lostTarget !== undefined) {
      throw new Error('COMMIT_RESPONSE_LOSS_ALREADY_ARMED');
    }
    this.#target = target;
  }

  async connect(): Promise<GatewayConnection> {
    const connection = await this.#delegate.connect();
    let released = false;
    let targetMessageId: string | undefined;
    return {
      query: async <Row>(sql: string, parameters?: readonly unknown[], signal?: AbortSignal) => {
        const armedTarget = this.#target;
        if (
          armedTarget !== undefined &&
          sql.includes('INSERT INTO worker_gateway_operation_receipts') &&
          parameters?.[0] === armedTarget.creatorId &&
          parameters?.[1] === 'ACCEPT_ENVELOPE' &&
          parameters[2] === armedTarget.operationKey
        ) {
          targetMessageId = armedTarget.messageId;
          if (typeof parameters[3] !== 'string') {
            throw new Error('TARGET_OPERATION_REQUEST_DIGEST_MISSING');
          }
          this.#requestDigest = parameters[3];
        }
        if (sql !== 'COMMIT' || targetMessageId === undefined) {
          return connection.query<Row>(sql, parameters, signal);
        }
        await connection.query<Row>(sql, parameters, signal);
        connection.release(true);
        released = true;
        const lostTarget = this.#target;
        if (lostTarget === undefined || lostTarget.messageId !== targetMessageId) {
          throw new Error('TARGET_COMMIT_IDENTITY_LOST');
        }
        this.#target = undefined;
        this.#lostTarget = lostTarget;
        this.#lostOperationKind = 'ACCEPT_ENVELOPE';
        this.#lossCount += 1;
        throw new Error('SIMULATED_SOCKET_LOSS_AFTER_TARGET_COMMIT');
      },
      release: (destroy = false): void => {
        if (released) return;
        released = true;
        connection.release(destroy);
      },
    };
  }
}

class RawWebSocketRelay {
  readonly #clients = new Set<WebSocket>();
  readonly #onSecondWorkerHeartbeat: (
    frame: ReturnType<typeof parseBrokerFrame>,
    canonicalDigest: string,
  ) => void;
  readonly #server: WebSocketServer;
  readonly #upstreamUrl: string;
  #duplicateCloudLeaseGrant = true;
  #duplicateWorkerHeartbeat = true;
  #workerHeartbeatCount = 0;
  #cloudDuplicates = 0;
  #workerDuplicates = 0;
  readonly #cloudPayloadHashes: string[] = [];
  readonly #workerPayloadHashes: string[] = [];

  constructor(
    upstreamUrl: string,
    path: string,
    onSecondWorkerHeartbeat: (
      frame: ReturnType<typeof parseBrokerFrame>,
      canonicalDigest: string,
    ) => void,
  ) {
    this.#upstreamUrl = upstreamUrl;
    this.#onSecondWorkerHeartbeat = onSecondWorkerHeartbeat;
    this.#server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      path,
      perMessageDeflate: false,
      clientTracking: false,
    });
    this.#server.on('connection', (downstream) => this.#attach(downstream));
  }

  get duplicateCounts(): Readonly<{ cloudToWorker: number; workerToCloud: number }> {
    return { cloudToWorker: this.#cloudDuplicates, workerToCloud: this.#workerDuplicates };
  }

  get duplicatePayloadHashes(): Readonly<{
    cloudToWorker: readonly string[];
    workerToCloud: readonly string[];
  }> {
    return {
      cloudToWorker: [...this.#cloudPayloadHashes],
      workerToCloud: [...this.#workerPayloadHashes],
    };
  }

  async start(): Promise<string> {
    if (this.#server.address() === null) await once(this.#server, 'listening');
    const address = this.#server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('VERTICAL_RELAY_LISTENER_INVALID');
    }
    return `ws://127.0.0.1:${address.port}/v1/worker/connect`;
  }

  async stop(): Promise<void> {
    for (const socket of this.#clients) socket.terminate();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #attach(downstream: WebSocket): void {
    const upstream = new WebSocket(this.#upstreamUrl, {
      perMessageDeflate: false,
      handshakeTimeout: 3_000,
    });
    const pending: Array<{ bytes: Buffer; binary: boolean }> = [];
    this.#clients.add(downstream);
    this.#clients.add(upstream);

    downstream.on('message', (data, binary) => {
      const bytes = rawDataBytes(data);
      if (upstream.readyState === WebSocket.OPEN) {
        this.#forwardWorkerFrame(upstream, bytes, binary);
        return;
      }
      if (pending.length >= 8) {
        downstream.terminate();
        upstream.terminate();
        return;
      }
      pending.push({ bytes, binary });
    });
    upstream.on('open', () => {
      for (const frame of pending.splice(0)) {
        this.#forwardWorkerFrame(upstream, frame.bytes, frame.binary);
      }
    });
    upstream.on('message', (data, binary) => {
      if (downstream.readyState !== WebSocket.OPEN) return;
      const bytes = rawDataBytes(data);
      downstream.send(bytes, { binary, compress: false });
      if (!binary && this.#duplicateCloudLeaseGrant && brokerFrameType(bytes) === 'lease.grant') {
        this.#duplicateCloudLeaseGrant = false;
        this.#cloudDuplicates += 1;
        this.#cloudPayloadHashes.push(createHash('sha256').update(bytes).digest('hex'));
        downstream.send(Buffer.from(bytes), { binary: false, compress: false });
      }
    });
    const closePeer = (peer: WebSocket) => {
      if (peer.readyState === WebSocket.OPEN || peer.readyState === WebSocket.CONNECTING) {
        peer.terminate();
      }
    };
    downstream.on('close', () => closePeer(upstream));
    upstream.on('close', () => closePeer(downstream));
    downstream.on('error', () => closePeer(upstream));
    upstream.on('error', () => closePeer(downstream));
    const forget = () => {
      this.#clients.delete(downstream);
      this.#clients.delete(upstream);
    };
    downstream.on('close', forget);
    upstream.on('close', forget);
  }

  #forwardWorkerFrame(upstream: WebSocket, bytes: Buffer, binary: boolean): void {
    const frame = binary ? undefined : brokerFrame(bytes);
    if (frame?.type === 'heartbeat') {
      this.#workerHeartbeatCount += 1;
      if (this.#workerHeartbeatCount === 2) {
        this.#onSecondWorkerHeartbeat(frame, canonicalSha256(frame));
      }
    }
    upstream.send(bytes, { binary, compress: false });
    if (this.#duplicateWorkerHeartbeat && frame?.type === 'heartbeat') {
      this.#duplicateWorkerHeartbeat = false;
      this.#workerDuplicates += 1;
      this.#workerPayloadHashes.push(createHash('sha256').update(bytes).digest('hex'));
      upstream.send(Buffer.from(bytes), { binary: false, compress: false });
    }
  }
}

function brokerFrame(bytes: Buffer): ReturnType<typeof parseBrokerFrame> | undefined {
  try {
    return parseBrokerFrame(bytes);
  } catch {
    return undefined;
  }
}

function brokerFrameType(bytes: Buffer): string | undefined {
  return brokerFrame(bytes)?.type;
}

function rawDataBytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  throw new TypeError('UNSUPPORTED_WEBSOCKET_RAW_DATA');
}
