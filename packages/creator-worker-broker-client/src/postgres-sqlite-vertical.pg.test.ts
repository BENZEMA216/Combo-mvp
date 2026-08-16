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
  PostgresGatewayBusinessEventProjector,
  toGatewayPool,
  type GatewayCompatibilityPolicy,
  type GatewayConnection,
  type GatewayDiagnosticEvent,
  type GatewayPool,
} from '@cb/agent-gateway';
import {
  BrokerEnvelopeSchema,
  brokerConversationOpenLogicalCommand,
  brokerConversationOpenLogicalDigest,
  canonicalSha256,
  currentBrokerContractDigest,
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
import type { SqliteWorkerInvocationJournalOptions } from './sqlite-invocation-journal.js';
import {
  WorkerBrokerClient,
  type WorkerBrokerDiagnosticEvent,
  type WorkerBrokerDurableTransportPort,
} from './worker-broker-client.js';

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
const BROKER_CONTRACT_DIGEST = currentBrokerContractDigest();
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
  consumerId: string;
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

type PgActiveGrantSnapshotRow = PgLeaseFact &
  Readonly<{
    message_id: string | null;
    canonical_digest: string | null;
    envelope_type: string | null;
    grant_lease_id: string | null;
    grant_fence: string | null;
    grant_expires_at_ms: string | null;
    durable_ack_level: string | null;
    ack_decision: string | null;
    persisted_grant_count: string;
  }>;

type PgActiveGrantSnapshot = Readonly<{
  lease: PgLeaseFact;
  grant: PgOutboundFact;
  persistedGrantCount: number;
}>;

type LeaseGrantEnvelope = Extract<BrokerEnvelope, { type: 'lease.grant' }>;

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

type PublisherDeliveryFact = Readonly<{
  state: string;
  attempt_count: number;
  session_id: string;
  connection_id: string;
  sequence: string;
  canonical_digest: string;
  durable_ack_level: string | null;
  wire_sent_at: Date | string;
  wire_expires_at: Date | string;
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
      acceptedBrokerContractDigests: [BROKER_CONTRACT_DIGEST],
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
      const initialGrant = await firstPersistedGrant(
        owner,
        fixture,
        initialLease.worker_session_id,
      );
      const duplicatedInitialGrant = relay.firstDuplicatedCloudLeaseGrant;
      if (duplicatedInitialGrant === undefined) {
        throw new Error('VERTICAL_DUPLICATED_INITIAL_GRANT_MISSING');
      }
      assertHistoricalGrantBinding(initialGrant, initialLease);
      assertGrantEnvelopeBinding(duplicatedInitialGrant, initialGrant, initialLease, fixture);
      const initialExpiryMs = Number(initialGrant.grant_expires_at_ms);
      await waitFor(
        () => diagnostics.includes('frame_replayed'),
        3_000,
        'WORKER_DURABLE_REPLAY_NOT_OBSERVED',
      );
      await waitForSqliteGrantBinding(
        filename,
        fixture,
        initialLease,
        initialGrant,
        duplicatedInitialGrant,
        1,
      );
      expect(
        sqliteOutboxResponseCount(filename, initialLease.connection_id, initialGrant.message_id),
      ).toBe(1);
      assertSqliteLeaseAtLeast(filename, fixture, initialLease, initialExpiryMs);

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

      const renewedLease = await assertTwoJournalBindings(
        owner,
        filename,
        fixture,
        initialExpiryMs,
      );
      expect(firstClient.status).toBe('READY');
      expect(firstClient.connected).toBe(true);
      expect(renewedLease.lease_id).toBe(initialLease.lease_id);
      expect(renewedLease.fence).toBe(initialLease.fence);
      expect(Number(renewedLease.lease_expires_at_ms)).toBeGreaterThan(initialExpiryMs);

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

      const reconnectedSnapshot = await waitForActivePersistedGrantSnapshot(
        owner,
        fixture,
        (snapshot) => BigInt(snapshot.lease.fence) > BigInt(renewedLease.fence),
        8_000,
        'GATEWAY_RESTART_PERSISTED_GRANT_TIMEOUT',
      );
      const reconnectedLease = reconnectedSnapshot.lease;
      assertGrantBinding(reconnectedSnapshot.grant, reconnectedLease);
      await waitForSqliteGrantBinding(
        filename,
        fixture,
        reconnectedLease,
        reconnectedSnapshot.grant,
      );
      assertSqliteLeaseAtLeast(
        filename,
        fixture,
        reconnectedLease,
        Number(reconnectedSnapshot.grant.grant_expires_at_ms),
      );
      expect(BigInt(reconnectedLease.fence)).toBeGreaterThan(BigInt(renewedLease.fence));
      expect(await activeLeaseCount(owner, fixture)).toBe(1);
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

      const reopenedSnapshot = await waitForActivePersistedGrantSnapshot(
        owner,
        fixture,
        (snapshot) => BigInt(snapshot.lease.fence) > BigInt(reconnectedLease.fence),
        8_000,
        'JOURNAL_REOPEN_PERSISTED_GRANT_TIMEOUT',
      );
      const reopenedLease = reopenedSnapshot.lease;
      assertGrantBinding(reopenedSnapshot.grant, reopenedLease);
      await waitForSqliteGrantBinding(filename, fixture, reopenedLease, reopenedSnapshot.grant);
      assertSqliteLeaseAtLeast(
        filename,
        fixture,
        reopenedLease,
        Number(reopenedSnapshot.grant.grant_expires_at_ms),
      );
      const metaAfterReopen = sqliteMeta(filename);
      expect(metaAfterReopen.journal_generation).toBe(metaBeforeReopen.journal_generation);
      expect(metaAfterReopen.authorization_digest).toBe(metaBeforeReopen.authorization_digest);
      expect(metaAfterReopen.schema_digest).toBe(metaBeforeReopen.schema_digest);
      expect(metaAfterReopen.commit_epoch).toBeGreaterThan(metaBeforeReopen.commit_epoch);
      expect(BigInt(reopenedLease.fence)).toBeGreaterThan(BigInt(reconnectedLease.fence));
      expect(sqliteActiveConnectionCount(filename)).toBe(1);
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

  it('publishes a real Consumer open through WSS and file SQLite, then recovers on replacement', async () => {
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
      acceptedBrokerContractDigests: [BROKER_CONTRACT_DIGEST],
      sessionTtlMs: 60_000,
      leaseTtlMs: 20_000,
      responseTtlMs: 5_000,
      transactionTimeoutMs: 2_000,
    };
    const projector = new PostgresGatewayBusinessEventProjector(
      {
        projectPrepared: async () => {
          throw new Error('publisher vertical must not project invocation.prepare');
        },
        projectStarted: async () => {
          throw new Error('publisher vertical must not project invocation.started');
        },
        projectSuccess: async () => {
          throw new Error('publisher vertical must not project invocation.succeeded');
        },
      },
      () => {
        throw new Error('publisher vertical must not seal an assistant message');
      },
    );
    const authority = new PostgresAgentGatewayAuthority(
      { api: toGatewayPool(apiPool), broker: toGatewayPool(brokerPool) },
      policy,
      projector,
    );
    const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const fixture = await seedFixture(owner, keyPair.publicKey);
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'combo-publisher-vertical-')));
    const filename = join(directory, 'journal.sqlite');
    const diagnostics: WorkerBrokerDiagnosticEvent[] = [];
    const observedOwnerToken: { value?: string } = {};
    let gateway: AgentGateway | undefined;
    let client: WorkerBrokerClient | undefined;
    let adapter: SqliteWorkerBrokerDurableTransport | undefined;

    try {
      gateway = new AgentGateway({
        authority,
        authorityTimeoutMs: 3_000,
        stopTimeoutMs: 3_000,
        publisherEnabled: true,
        publisherPollIntervalMs: 50,
      });
      const initialAddress = await gateway.start();
      const url = `ws://${initialAddress.host}:${initialAddress.port}${initialAddress.path}`;
      adapter = new SqliteWorkerBrokerDurableTransport({
        filename,
        newJournalAuthorization: newJournalAuthorization(fixture.installationId),
      });
      const ports = workerPorts(authority, owner, fixture, keyPair.privateKey);
      client = createWorkerClient(
        url,
        fixture.installationId,
        observeOwnerToken(adapter, observedOwnerToken),
        ports,
        diagnostics,
      );
      await client.start();
      await waitFor(() => client?.status === 'READY', 8_000, 'PUBLISHER_WORKER_READY_TIMEOUT');
      await waitFor(
        async () => (await persistedGrantCount(owner, fixture)) >= 1,
        8_000,
        'PUBLISHER_INITIAL_GRANT_TIMEOUT',
      );
      const originalLease = await activeLease(owner, fixture);
      await owner.query(
        `UPDATE deployments
            SET serving_version_id = desired_version_id,
                observed_state = 'ONLINE', observed_worker_id = $2,
                observed_generation = generation, updated_at = clock_timestamp()
          WHERE id = $1 AND creator_id = $3`,
        [fixture.deploymentId, fixture.installationId, fixture.creatorId],
      );

      const created = await createOpeningConversation(owner, fixture, originalLease);
      await waitFor(
        async () => {
          const deliveries = await publisherDeliveries(owner, fixture, created.commandId);
          return (
            deliveries.length === 1 &&
            deliveries[0]?.state === 'SENT' &&
            deliveries[0].durable_ack_level === 'PERSISTED' &&
            sqlitePublisherEnvelope(filename, created.commandId) !== undefined
          );
        },
        8_000,
        'PUBLISHER_FIRST_PERSISTED_TIMEOUT',
      );
      const firstDelivery = (await publisherDeliveries(owner, fixture, created.commandId))[0]!;
      const firstEnvelope = sqlitePublisherEnvelope(filename, created.commandId);
      if (firstEnvelope?.type !== 'conversation.open') {
        throw new Error('PUBLISHER_FIRST_SQLITE_OPEN_MISSING');
      }
      expect(firstDelivery).toMatchObject({
        state: 'SENT',
        attempt_count: 1,
        session_id: originalLease.worker_session_id,
        connection_id: originalLease.connection_id,
        durable_ack_level: 'PERSISTED',
      });
      expect(firstDelivery.canonical_digest).toBe(canonicalSha256(firstEnvelope));
      expect(new Date(firstDelivery.wire_expires_at).getTime()).toBeGreaterThan(
        new Date(firstDelivery.wire_sent_at).getTime(),
      );

      const firstPort = initialAddress.port;
      await gateway.stop();
      await waitFor(
        () => diagnostics.includes('connection_lost'),
        5_000,
        'PUBLISHER_DISCONNECT_NOT_OBSERVED',
      );
      gateway = new AgentGateway({
        authority,
        port: firstPort,
        authorityTimeoutMs: 3_000,
        stopTimeoutMs: 3_000,
        publisherEnabled: true,
        publisherPollIntervalMs: 50,
      });
      await gateway.start();
      await waitFor(
        async () => {
          const deliveries = await publisherDeliveries(owner, fixture, created.commandId);
          return (
            deliveries.length === 2 &&
            deliveries[1]?.durable_ack_level === 'PERSISTED' &&
            deliveries[1].session_id !== originalLease.worker_session_id
          );
        },
        12_000,
        'PUBLISHER_REPLACEMENT_PERSISTED_TIMEOUT',
      );
      const deliveries = await publisherDeliveries(owner, fixture, created.commandId);
      const replacementDelivery = deliveries[1]!;
      const replacementEnvelope = sqlitePublisherEnvelope(
        filename,
        created.commandId,
        replacementDelivery.connection_id,
      );
      if (replacementEnvelope?.type !== 'conversation.open') {
        throw new Error('PUBLISHER_REPLACEMENT_SQLITE_OPEN_MISSING');
      }
      expect(replacementDelivery.attempt_count).toBe(2);
      expect(replacementEnvelope.messageId).toBe(firstEnvelope.messageId);
      expect(replacementEnvelope.body).toEqual(firstEnvelope.body);
      expect(replacementEnvelope.connectionId).not.toBe(firstEnvelope.connectionId);
      expect(replacementEnvelope.lease.workerSessionId).not.toBe(
        firstEnvelope.lease.workerSessionId,
      );
      expect(
        brokerConversationOpenLogicalDigest(
          brokerConversationOpenLogicalCommand(replacementEnvelope),
        ),
      ).toBe(
        brokerConversationOpenLogicalDigest(brokerConversationOpenLogicalCommand(firstEnvelope)),
      );

      const ownerToken = observedOwnerToken.value;
      if (ownerToken === undefined) throw new Error('PUBLISHER_WORKER_OWNER_TOKEN_MISSING');
      const pending = await adapter.readPendingCommands({
        installationId: fixture.installationId,
        ownerToken,
        connectionId: replacementDelivery.connection_id,
        limit: 8,
        signal: AbortSignal.timeout(2_000),
      });
      const openReference = pending.find(
        (candidate) =>
          candidate.type === 'conversation.open' && candidate.messageId === created.commandId,
      );
      if (openReference === undefined) throw new Error('PUBLISHER_OPEN_REFERENCE_MISSING');
      expect(openReference).toMatchObject({
        connectionId: replacementDelivery.connection_id,
        canonicalDigest: replacementDelivery.canonical_digest,
        effectState: 'PERSISTED',
      });
      const readyAt = new Date(Math.max(Date.now(), Date.parse(replacementEnvelope.sentAt)));
      const readyWindow = sqliteMaybeOne<{
        status: string;
        lease_state: string;
        lease_expires_at: string;
      }>(
        filename,
        `SELECT status, lease_state, lease_expires_at
           FROM transport_connections WHERE connection_id = ?`,
        replacementDelivery.connection_id,
      );
      expect(readyWindow).toMatchObject({ status: 'ACTIVE', lease_state: 'ACTIVE' });
      expect(readyAt.getTime()).toBeLessThan(Date.parse(replacementEnvelope.expiresAt));
      expect(readyAt.getTime()).toBeLessThan(Date.parse(readyWindow!.lease_expires_at));
      const journal = adapter.createInvocationJournal(publisherReadyJournalOptions(readyAt));
      await journal.bindReadyConversation({
        installationId: fixture.installationId,
        ownerToken,
        command: openReference,
        evidence: { token: 'publisher-sandbox-ready' },
        signal: AbortSignal.timeout(2_000),
      });
      await waitFor(
        async () => {
          const cloud = await publisherTerminal(owner, fixture, created.commandId);
          return (
            cloud?.outbox_state === 'ACKED' &&
            cloud.conversation_state === 'IDLE' &&
            sqliteReadyCloudCommitted(filename, created.conversationId)
          );
        },
        10_000,
        'PUBLISHER_READY_DID_NOT_CONVERGE',
      );
      expect(await publisherTerminal(owner, fixture, created.commandId)).toEqual({
        outbox_state: 'ACKED',
        conversation_state: 'IDLE',
      });
    } finally {
      await client?.stop().catch(() => undefined);
      adapter?.close();
      await gateway?.stop().catch(() => undefined);
      await Promise.all([owner.end(), apiPool.end(), brokerPool.end()]);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 40_000);
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
    consumerId: '',
    snapshotId: randomUuidV7(),
    agentId: randomUuidV7(),
    versionId: randomUuidV7(),
    deploymentId: randomUuidV7(),
    installationId: randomUuidV7(),
  };
  const people = await owner.query<{ id: string }>(
    'INSERT INTO users (account) VALUES ($1), ($2) RETURNING id::text',
    [creatorAccount(), creatorAccount()],
  );
  const creatorId = people.rows[0]?.id;
  const consumerId = people.rows[1]?.id;
  if (creatorId === undefined) throw new Error('VERTICAL_FIXTURE_CREATOR_FAILED');
  if (consumerId === undefined) throw new Error('VERTICAL_FIXTURE_CONSUMER_FAILED');
  ids.creatorId = creatorId;
  ids.consumerId = consumerId;
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
    `INSERT INTO agent_access_grants (agent_id, creator_id, consumer_subject_id)
     VALUES ($1, $2, $3)`,
    [ids.agentId, ids.creatorId, ids.consumerId],
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
        brokerContractDigest: BROKER_CONTRACT_DIGEST,
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
  durablePort: WorkerBrokerDurableTransportPort,
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

function observeOwnerToken(
  port: WorkerBrokerDurableTransportPort,
  observed: { value?: string },
): WorkerBrokerDurableTransportPort {
  return new Proxy(port, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      return (input: unknown) => {
        if (
          typeof input === 'object' &&
          input !== null &&
          'ownerToken' in input &&
          typeof input.ownerToken === 'string'
        ) {
          if (observed.value !== undefined && observed.value !== input.ownerToken) {
            throw new Error('PUBLISHER_WORKER_OWNER_TOKEN_CHANGED');
          }
          observed.value = input.ownerToken;
        }
        return Reflect.apply(value, target, [input]);
      };
    },
  });
}

async function createOpeningConversation(
  owner: Pool,
  fixture: FixtureIds,
  lease: PgLeaseFact,
): Promise<{ conversationId: string; commandId: string }> {
  const connection = await owner.connect();
  try {
    await connection.query('BEGIN');
    await connection.query('SET LOCAL ROLE combo_agent_consumer_api');
    await connection.query(`SELECT set_config('app.creator_id', $1, true)`, [fixture.creatorId]);
    await connection.query(`SELECT set_config('app.consumer_id', $1, true)`, [fixture.consumerId]);
    const created = await connection.query<{
      conversation_id: string;
      open_command_id: string;
    }>(
      `SELECT conversation_id::text, open_command_id::text
         FROM creator_agent_create_opening_conversation_v2(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 3600,
           $11, $12, 7, $13
         )`,
      [
        fixture.agentId,
        fixture.deploymentId,
        fixture.versionId,
        fixture.creatorId,
        fixture.consumerId,
        randomUuidV7(),
        digest('9'),
        digest('7'),
        fixture.installationId,
        lease.fence,
        `hmac-sha256:${digest('a')}`,
        'publisher-vertical-visible-key',
        'kms://publisher-vertical/visible-key@7',
      ],
    );
    const row = created.rows[0];
    if (row === undefined) throw new Error('PUBLISHER_CONSUMER_CREATE_FAILED');
    await connection.query('COMMIT');
    return { conversationId: row.conversation_id, commandId: row.open_command_id };
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

async function publisherDeliveries(
  owner: Pool,
  fixture: FixtureIds,
  commandId: string,
): Promise<PublisherDeliveryFact[]> {
  const result = await owner.query<PublisherDeliveryFact>(
    `SELECT command.state, command.attempt_count,
            delivery.session_id::text, delivery.claim_connection_id::text AS connection_id,
            delivery.sequence::text, delivery.canonical_digest,
            delivery.durable_ack_level, delivery.wire_sent_at, delivery.wire_expires_at
       FROM broker_outbox AS command
       JOIN worker_gateway_outbound_frames AS delivery
         ON delivery.broker_command_id = command.command_id
        AND delivery.creator_id = command.creator_id
      WHERE command.command_id = $1 AND command.creator_id = $2
      ORDER BY delivery.created_at, delivery.session_id`,
    [commandId, fixture.creatorId],
  );
  return result.rows;
}

function sqlitePublisherEnvelope(
  filename: string,
  commandId: string,
  connectionId?: string,
): BrokerEnvelope | undefined {
  const parameters: SQLInputValue[] = [commandId];
  let connectionClause = '';
  if (connectionId !== undefined) {
    parameters.push(connectionId);
    connectionClause = 'AND connection_id = ?';
  }
  const row = sqliteMaybeOne<{ envelope_json: string }>(
    filename,
    `SELECT envelope_json FROM transport_inbound_frames
      WHERE message_id = ? AND envelope_type = 'conversation.open' ${connectionClause}
      ORDER BY recorded_at_ms DESC LIMIT 1`,
    ...parameters,
  );
  return row === undefined ? undefined : BrokerEnvelopeSchema.parse(JSON.parse(row.envelope_json));
}

function publisherReadyJournalOptions(readyAt: Date): SqliteWorkerInvocationJournalOptions {
  const unsupported = (): never => {
    throw new Error('PUBLISHER_READY_ONLY_AUTHORITY');
  };
  return {
    capabilityAuthority: {
      verify: unsupported,
      verifyPreviouslyCommitted: unsupported,
    },
    readyConversationAuthority: {
      verify(input) {
        if ((input as { token?: unknown }).token !== 'publisher-sandbox-ready') {
          throw new Error('PUBLISHER_READY_EVIDENCE_INVALID');
        }
        return {
          sandboxInstanceId: randomUuidV7(),
          runtimeThreadId: 'publisher-vertical-thread',
          evidenceDigest: `sha256:${digest('e')}`,
          readyAt,
        };
      },
    },
    hostDispatchPort: { dispatchOnce: unsupported },
    hostDispatchReceiptAuthority: { verify: unsupported },
    localPromptAeadAuthority: { rewrap: unsupported, open: unsupported },
    localResultAeadAuthority: { verify: unsupported },
    brokerResultReencryptAuthority: { reencrypt: unsupported },
    cloudAckAuthority: { verify: unsupported },
    cloudClock: { now: () => new Date() },
  };
}

async function publisherTerminal(
  owner: Pool,
  fixture: FixtureIds,
  commandId: string,
): Promise<{ outbox_state: string; conversation_state: string } | undefined> {
  const result = await owner.query<{ outbox_state: string; conversation_state: string }>(
    `SELECT command.state AS outbox_state, conversation.state AS conversation_state
       FROM broker_outbox AS command
       JOIN agent_conversations AS conversation
         ON conversation.id = command.conversation_id
        AND conversation.creator_id = command.creator_id
      WHERE command.command_id = $1 AND command.creator_id = $2`,
    [commandId, fixture.creatorId],
  );
  return result.rows[0];
}

function sqliteReadyCloudCommitted(filename: string, conversationId: string): boolean {
  const row = sqliteMaybeOne<{ state: string; ready_cloud_state: string }>(
    filename,
    `SELECT state, ready_cloud_state FROM local_conversations WHERE conversation_id = ?`,
    conversationId,
  );
  return row?.state === 'READY' && row.ready_cloud_state === 'CLOUD_COMMITTED';
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

async function activePersistedGrantSnapshot(
  owner: Pool,
  fixture: FixtureIds,
): Promise<PgActiveGrantSnapshot | undefined> {
  const result = await owner.query<PgActiveGrantSnapshotRow>(
    `WITH active AS (
       SELECT gateway.id::text AS worker_session_id,
              gateway.connection_id::text,
              gateway.state AS session_state,
              lease.id::text AS lease_id,
              lease.fence::text,
              lease.state AS lease_state,
              lease.expires_at AS lease_expires_at,
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
     )
     SELECT active.worker_session_id, active.connection_id, active.session_state,
            active.lease_id, active.fence, active.lease_state,
            active.lease_expires_at_ms, active.deployment_fence,
            matched.message_id::text, matched.canonical_digest, matched.envelope_type,
            matched.grant_lease_id::text, matched.grant_fence::text,
            floor(extract(epoch FROM matched.grant_expires_at) * 1000)::bigint::text
              AS grant_expires_at_ms,
            matched.durable_ack_level, matched.ack_decision,
            grant_count.persisted_grant_count
       FROM active
       LEFT JOIN LATERAL (
         SELECT outbound.*
           FROM worker_gateway_outbound_frames AS outbound
          WHERE outbound.creator_id = $1
            AND outbound.session_id = active.worker_session_id::uuid
            AND outbound.envelope_type = 'lease.grant'
            AND outbound.grant_lease_id = active.lease_id::uuid
            AND outbound.grant_fence = active.fence::bigint
            AND floor(extract(epoch FROM outbound.grant_expires_at) * 1000)::bigint =
                floor(extract(epoch FROM active.lease_expires_at) * 1000)::bigint
            AND outbound.durable_ack_level = 'PERSISTED'
            AND outbound.ack_decision = 'APPLIED'
          ORDER BY outbound.sequence DESC
          LIMIT 1
       ) AS matched ON TRUE
       CROSS JOIN LATERAL (
         SELECT count(*)::text AS persisted_grant_count
           FROM worker_gateway_outbound_frames AS outbound
          WHERE outbound.creator_id = $1
            AND outbound.session_id = active.worker_session_id::uuid
            AND outbound.envelope_type = 'lease.grant'
            AND outbound.durable_ack_level = 'PERSISTED'
            AND outbound.ack_decision = 'APPLIED'
       ) AS grant_count`,
    [fixture.creatorId, fixture.installationId],
  );
  if (result.rows.length === 0) return undefined;
  if (result.rows.length !== 1 || result.rows[0] === undefined) {
    throw new Error(`VERTICAL_ACTIVE_LEASE_COUNT_${result.rows.length}`);
  }
  const row = result.rows[0];
  if (row.message_id === null || row.canonical_digest === null || row.envelope_type === null) {
    return undefined;
  }
  return Object.freeze({
    lease: Object.freeze({
      worker_session_id: row.worker_session_id,
      connection_id: row.connection_id,
      session_state: row.session_state,
      lease_id: row.lease_id,
      fence: row.fence,
      lease_state: row.lease_state,
      lease_expires_at_ms: row.lease_expires_at_ms,
      deployment_fence: row.deployment_fence,
    }),
    grant: Object.freeze({
      message_id: row.message_id,
      canonical_digest: row.canonical_digest,
      envelope_type: row.envelope_type,
      grant_lease_id: row.grant_lease_id,
      grant_fence: row.grant_fence,
      grant_expires_at_ms: row.grant_expires_at_ms,
      durable_ack_level: row.durable_ack_level,
      ack_decision: row.ack_decision,
    }),
    persistedGrantCount: Number(row.persisted_grant_count),
  });
}

async function waitForActivePersistedGrantSnapshot(
  owner: Pool,
  fixture: FixtureIds,
  predicate: (snapshot: PgActiveGrantSnapshot) => boolean,
  timeoutMs: number,
  code: string,
): Promise<PgActiveGrantSnapshot> {
  let accepted: PgActiveGrantSnapshot | undefined;
  await waitFor(
    async () => {
      const snapshot = await activePersistedGrantSnapshot(owner, fixture);
      if (snapshot === undefined || !predicate(snapshot)) return false;
      accepted = snapshot;
      return true;
    },
    timeoutMs,
    code,
  );
  if (accepted === undefined) throw new Error(`${code}_RESULT_MISSING`);
  return accepted;
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
  expect(grant.envelope_type).toBe('lease.grant');
  expect(grant.grant_lease_id).toBe(lease.lease_id);
  expect(grant.grant_fence).toBe(lease.fence);
  expect(grant.grant_expires_at_ms).toBe(lease.lease_expires_at_ms);
  expect(grant.durable_ack_level).toBe('PERSISTED');
  expect(grant.ack_decision).toBe('APPLIED');
}

function assertHistoricalGrantBinding(grant: PgOutboundFact, lease: PgLeaseFact): void {
  expect(grant.envelope_type).toBe('lease.grant');
  expect(grant.grant_lease_id).toBe(lease.lease_id);
  expect(grant.grant_fence).toBe(lease.fence);
  expect(Number(lease.lease_expires_at_ms)).toBeGreaterThanOrEqual(grantExpiryMs(grant));
  expect(grant.durable_ack_level).toBe('PERSISTED');
  expect(grant.ack_decision).toBe('APPLIED');
}

function assertGrantEnvelopeBinding(
  envelope: LeaseGrantEnvelope,
  grant: PgOutboundFact,
  lease: PgLeaseFact,
  fixture: FixtureIds,
): void {
  expect(envelope.messageId).toBe(grant.message_id);
  expect(canonicalSha256(envelope)).toBe(grant.canonical_digest);
  expect(envelope.connectionId).toBe(lease.connection_id);
  expect(envelope.lease).toEqual({
    deploymentId: fixture.deploymentId,
    leaseId: grant.grant_lease_id,
    workerSessionId: lease.worker_session_id,
    fence: grant.grant_fence,
  });
  expect(envelope.body).toEqual({
    leaseExpiresAt: new Date(grantExpiryMs(grant)).toISOString(),
    workerSessionId: lease.worker_session_id,
    generation: '1',
  });
}

function grantExpiryMs(grant: PgOutboundFact): number {
  if (grant.grant_expires_at_ms === null) throw new Error('VERTICAL_GRANT_EXPIRY_MISSING');
  const expiry = Number(grant.grant_expires_at_ms);
  if (!Number.isSafeInteger(expiry)) throw new Error('VERTICAL_GRANT_EXPIRY_INVALID');
  return expiry;
}

async function waitForSqliteGrantBinding(
  filename: string,
  fixture: FixtureIds,
  lease: PgLeaseFact,
  grant: PgOutboundFact,
  expectedEnvelope?: LeaseGrantEnvelope,
  expectedReplayCount?: number,
): Promise<void> {
  await waitFor(
    () => {
      const row = sqliteMaybeOne<{
        message_id: string;
        canonical_digest: string;
        envelope_json: string;
        effect_state: string;
        replay_count: number;
      }>(
        filename,
        `SELECT message_id, canonical_digest, envelope_json, effect_state, replay_count
           FROM transport_inbound_frames
          WHERE connection_id = ? AND message_id = ? AND envelope_type = 'lease.grant'`,
        lease.connection_id,
        grant.message_id,
      );
      if (row === undefined) return false;
      expect(row.message_id).toBe(grant.message_id);
      expect(row.canonical_digest).toBe(grant.canonical_digest);
      const parsed = BrokerEnvelopeSchema.parse(JSON.parse(row.envelope_json));
      if (parsed.type !== 'lease.grant') throw new Error('VERTICAL_SQLITE_GRANT_TYPE_INVALID');
      assertGrantEnvelopeBinding(parsed, grant, lease, fixture);
      if (expectedEnvelope !== undefined) expect(parsed).toEqual(expectedEnvelope);
      if (row.effect_state !== 'APPLIED') return false;
      if (expectedReplayCount !== undefined && row.replay_count < expectedReplayCount) return false;
      expect(row.effect_state).toBe('APPLIED');
      if (expectedReplayCount !== undefined) expect(row.replay_count).toBe(expectedReplayCount);
      return true;
    },
    5_000,
    'VERTICAL_SQLITE_GRANT_BINDING_TIMEOUT',
  );
}

function assertSqliteLeaseAtLeast(
  filename: string,
  fixture: FixtureIds,
  lease: PgLeaseFact,
  targetExpiryMs: number,
): void {
  const local = sqliteConnection(filename, lease.connection_id);
  expect(local).toMatchObject({
    connection_id: lease.connection_id,
    worker_session_id: lease.worker_session_id,
    deployment_id: fixture.deploymentId,
    lease_id: lease.lease_id,
    fence: lease.fence,
    lease_state: 'ACTIVE',
    status: 'ACTIVE',
  });
  expect(Date.parse(local.lease_expires_at)).toBeGreaterThanOrEqual(targetExpiryMs);
}

async function assertTwoJournalBindings(
  owner: Pool,
  filename: string,
  fixture: FixtureIds,
  initialExpiryMs: number,
): Promise<PgLeaseFact> {
  const snapshot = await waitForActivePersistedGrantSnapshot(
    owner,
    fixture,
    (candidate) =>
      candidate.persistedGrantCount >= 2 &&
      grantExpiryMs(candidate.grant) > initialExpiryMs &&
      candidate.lease.lease_expires_at_ms === candidate.grant.grant_expires_at_ms,
    8_000,
    'VERTICAL_CURRENT_PERSISTED_GRANT_TIMEOUT',
  );
  const { lease, grant: renewal } = snapshot;
  expect(snapshot.persistedGrantCount).toBeGreaterThanOrEqual(2);
  assertGrantBinding(renewal, lease);
  await waitForSqliteGrantBinding(filename, fixture, lease, renewal);
  assertSqliteLeaseAtLeast(filename, fixture, lease, grantExpiryMs(renewal));

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
  return lease;
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
  #firstDuplicatedCloudLeaseGrant: LeaseGrantEnvelope | undefined;
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

  get firstDuplicatedCloudLeaseGrant(): LeaseGrantEnvelope | undefined {
    return this.#firstDuplicatedCloudLeaseGrant;
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
      const frame = binary ? undefined : brokerFrame(bytes);
      if (!binary && this.#duplicateCloudLeaseGrant && frame?.type === 'lease.grant') {
        this.#duplicateCloudLeaseGrant = false;
        this.#firstDuplicatedCloudLeaseGrant = frame;
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

function rawDataBytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  throw new TypeError('UNSUPPORTED_WEBSOCKET_RAW_DATA');
}
