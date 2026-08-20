import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import {
  AgentGateway,
  PostgresAgentGatewayAuthority,
  PostgresGatewayBusinessEventProjector,
  loadGatewayTestKeyring,
  type GatewayCompatibilityPolicy,
  type GatewayConnection,
  type GatewayPool,
  type GatewayQueryResult,
} from '../../apps/agent-gateway/src/index.js';
import type {
  CodexHost,
  HostInterruptedTerminalEvidence,
  HostThread,
  HostTurnHandle,
} from '../../apps/creator-worker/src/host-types.js';
import { createVnextCreatorWorkerRuntime } from '../../apps/creator-worker/src/vnext-runtime.js';
import { loadTestConsumerMessageAuthority } from '../../apps/runtime/src/modules/creator-agent-conversation/consumer-message-authority.js';
import { loadTestInvocationPrepareAuthority } from '../../apps/runtime/src/modules/creator-agent-conversation/invocation-prepare-authority.js';
import {
  createPostgresServerIdAuthority,
  readConsumerConversationTranscript,
  sendConsumerMessage,
} from '../../apps/runtime/src/modules/creator-agent-conversation/runtime-product-repo.js';
import {
  type QueryResultLike,
  type RuntimeDb,
  type TxConn,
} from '../../apps/runtime/src/platform/infra/db.js';
import {
  brokerSensitiveMessageAadBytes,
  brokerSensitiveMessageAadDigest,
  brokerSensitiveMessageCipherDigest,
  canonicalSha256,
  canonicalizeJson,
  createHostTurnTerminalEvidence,
  currentBrokerContractDigest,
  domainSeparatedHmacSha256,
  parseBrokerFrame,
  validateExecutionCapabilityBinding,
  type BrokerSensitiveMessage,
  type ExpectedExecutionCapabilityBinding,
} from '../../packages/creator-agent-protocol/src/index.js';
import {
  PostgresCloudJournal,
  type JournalPool,
} from '../../packages/creator-agent-persistence/src/index.js';
import {
  localInvocationPromptAadBytes,
  localInvocationPromptAadDigest,
  localInvocationPromptCipherDigest,
  localInvocationResultAadBytes,
  localInvocationResultAadDigest,
  localInvocationResultCipherDigest,
  type BrokerResultReencryptAuthorityPort,
  type CloudInvocationAckAuthorityPort,
  type LocalInvocationPromptAad,
  type LocalInvocationPromptCiphertext,
  type LocalInvocationResultAad,
  type LocalInvocationResultCiphertext,
  type LocalPromptAeadAuthorityPort,
  type LocalResultAeadAuthorityPort,
  type LocalResultAeadSealerPort,
  type NewWorkerJournalAuthorization,
  type OpaqueInvocationCloudAckReference,
  type ReadyConversationAuthorityPort,
  type WorkerInvocationCapabilityAuthorityPort,
} from '../../packages/creator-worker-broker-client/src/index.js';
import type { Pool as PgPool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type WebSocketType from 'ws';
import type { RawData, WebSocketServer as WebSocketServerType } from 'ws';

const requested = process.env.CREATOR_AGENT_R3_WORKER_HOST_PG_TEST === '1';
const isolated = process.env.CREATOR_AGENT_R3_PG_ISOLATED === '1';
const databaseUrl = process.env.CREATOR_AGENT_R3_WORKER_HOST_PG_URL;
const ISOLATED_CLUSTER_NAME = 'combo-vnext-r3-ephemeral';
if (requested && (!isolated || databaseUrl === undefined || databaseUrl.length === 0)) {
  throw new Error('CREATOR_AGENT_R3_WORKER_HOST_PG_TEST_REQUIRES_DEDICATED_DATABASE');
}
const pgDescribe =
  requested && isolated && databaseUrl !== undefined ? describe.sequential : describe.skip;

const { DatabaseSync: SqliteDatabase } = createRequire(import.meta.url)('node:sqlite') as {
  readonly DatabaseSync: typeof DatabaseSync;
};
const gatewayRequire = createRequire(
  new URL('../../apps/agent-gateway/package.json', import.meta.url),
);
const { Pool } = gatewayRequire('pg') as { Pool: typeof PgPool };
const WebSocket = gatewayRequire('ws') as typeof WebSocketType;
const { WebSocketServer } = gatewayRequire('ws') as {
  WebSocketServer: typeof WebSocketServerType;
};
const WORKER_VERSION = 'combo-worker-r3-worker-host/1';
const RUNTIME_DIGEST = `sha256:${'a'.repeat(64)}`;
const PROTOCOL_DIGEST = `sha256:${'b'.repeat(64)}`;
const BROKER_CONTRACT_DIGEST = currentBrokerContractDigest();
const OWNER_TOKEN = 'combo-r3-worker-host-owner-token-0123456789';
const USER_TEXT = 'R3 Runtime to deterministic Host user message';
const ASSISTANT_TEXT = 'R3 deterministic Host to Runtime assistant result';
const OWNER_KEY_ID = 'test.owner.active';
const SESSION_KEY_ID = 'test.worker.active';
const LOCAL_KEY_ID = 'worker-keychain-r3-active';
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

type ActiveLease = Readonly<{
  worker_session_id: string;
  connection_id: string;
  lease_id: string;
  fence: string;
}>;

class SessionAuthorizationPool implements GatewayPool, JournalPool {
  readonly #pool: PgPool;

  public constructor(
    connectionString: string,
    private readonly role: 'combo_agent_api' | 'combo_agent_broker',
  ) {
    this.#pool = new Pool({ connectionString, max: 8 });
  }

  public async connect(): Promise<GatewayConnection> {
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
      release: () => client.release(true),
    };
  }

  public async end(): Promise<void> {
    await this.#pool.end();
  }
}

class SessionAuthorizationRuntimeDb implements RuntimeDb {
  readonly #pool: PgPool;

  public constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 8 });
  }

  public async query<Row>(
    sql: string,
    parameters?: unknown[],
    signal?: AbortSignal,
  ): Promise<QueryResultLike<Row>> {
    const connection = await this.connect();
    try {
      return await connection.query<Row>(sql, parameters, signal);
    } finally {
      connection.release(true);
    }
  }

  public async connect(): Promise<TxConn> {
    const client = await this.#pool.connect();
    try {
      await client.query('SET SESSION AUTHORIZATION combo_agent_consumer_api');
    } catch (error) {
      client.release(true);
      throw error;
    }
    return {
      query: <Row>(sql: string, parameters?: unknown[], signal?: AbortSignal) =>
        queryWithSignal<Row>(client, sql, parameters, signal),
      release: () => client.release(true),
    };
  }

  public async end(): Promise<void> {
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
  const result = await client.query(sql, parameters as unknown[] | undefined);
  signal?.throwIfAborted();
  return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
}

class ExactLifecycleReplayRelay {
  readonly #server: WebSocketServerType;
  readonly #sockets = new Set<WebSocketType>();
  readonly duplicates = new Map<string, number>();

  public constructor(private readonly upstreamUrl: string) {
    this.#server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      path: '/v1/worker/connect',
      perMessageDeflate: false,
      clientTracking: false,
    });
    this.#server.on('connection', (socket) => this.#attach(socket));
  }

  public async start(): Promise<string> {
    if (this.#server.address() === null) await once(this.#server, 'listening');
    const address = this.#server.address();
    if (address === null || typeof address === 'string') throw new Error('R3_RELAY_NOT_LISTENING');
    return `ws://127.0.0.1:${address.port}/v1/worker/connect`;
  }

  public async stop(): Promise<void> {
    for (const socket of this.#sockets) socket.terminate();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #attach(downstream: WebSocketType): void {
    const upstream = new WebSocket(this.upstreamUrl, {
      perMessageDeflate: false,
      handshakeTimeout: 3_000,
    });
    const pending: Array<{ bytes: Buffer; binary: boolean }> = [];
    this.#sockets.add(downstream);
    this.#sockets.add(upstream);
    downstream.on('message', (data, binary) => {
      const bytes = rawDataBytes(data);
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(bytes, { binary, compress: false });
      } else {
        pending.push({ bytes, binary });
      }
    });
    upstream.on('open', () => {
      for (const frame of pending.splice(0)) {
        upstream.send(frame.bytes, { binary: frame.binary, compress: false });
      }
    });
    upstream.on('message', (data, binary) => {
      if (downstream.readyState !== WebSocket.OPEN) return;
      const bytes = rawDataBytes(data);
      downstream.send(bytes, { binary, compress: false });
      if (binary) return;
      const frame = brokerFrame(bytes);
      if (
        frame !== undefined &&
        (frame.type === 'invocation.prepare' || frame.type === 'invocation.start') &&
        !this.duplicates.has(frame.type)
      ) {
        this.duplicates.set(frame.type, 1);
        downstream.send(Buffer.from(bytes), { binary: false, compress: false });
      }
    });
    const closePeer = (peer: WebSocketType): void => {
      if (peer.readyState === WebSocket.OPEN || peer.readyState === WebSocket.CONNECTING) {
        peer.terminate();
      }
    };
    downstream.on('close', () => closePeer(upstream));
    upstream.on('close', () => closePeer(downstream));
    downstream.on('error', () => closePeer(upstream));
    upstream.on('error', () => closePeer(downstream));
  }
}

class DeterministicCodexHost implements CodexHost {
  public dispatchCount = 0;
  public createThreadCount = 0;
  public readonly dispatchedTexts: string[] = [];
  #started = false;

  public async start(): Promise<void> {
    this.#started = true;
  }

  public async stop(): Promise<void> {
    this.#started = false;
  }

  public async createThread(): Promise<HostThread> {
    if (!this.#started) throw new Error('R3_HOST_NOT_STARTED');
    this.createThreadCount += 1;
    return {
      id: 'thread-r3-worker-host',
      generation: 1,
      workspaceRootsAcknowledged: true,
    };
  }

  public startTurn(input: {
    thread: HostThread;
    messageId: string;
    text: string;
    timeoutMs: number;
  }): HostTurnHandle {
    if (!this.#started) throw new Error('R3_HOST_NOT_STARTED');
    this.dispatchCount += 1;
    this.dispatchedTexts.push(input.text);
    const turnId = `turn-r3-worker-host-${this.dispatchCount}`;
    return Object.freeze({
      turnId: Promise.resolve(turnId),
      result: Promise.resolve({ text: ASSISTANT_TEXT }),
      terminal: Promise.resolve(
        createHostTurnTerminalEvidence({
          threadId: input.thread.id,
          turnId,
          outcome: 'SUCCEEDED',
          errorCode: null,
          terminalStatus: 'completed',
          terminalError: 'NONE',
          outputState: 'USABLE',
          completedAt: Date.now(),
        }),
      ),
      interrupt: async (): Promise<HostInterruptedTerminalEvidence> => {
        throw new Error('R3_CANCEL_OUT_OF_SCOPE');
      },
    });
  }
}

pgDescribe('R3 Runtime, Gateway, Worker and Host local PostgreSQL vertical', () => {
  it('runs send through Host success and transcript with exact wire and product replay', async () => {
    const owner = new Pool({ connectionString: databaseUrl, max: 8 });
    const apiRole = new SessionAuthorizationPool(databaseUrl ?? '', 'combo_agent_api');
    const brokerRole = new SessionAuthorizationPool(databaseUrl ?? '', 'combo_agent_broker');
    const consumerDb = new SessionAuthorizationRuntimeDb(databaseUrl ?? '');
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'combo-r3-worker-host-')));
    const sqliteFilename = join(directory, 'journal-v1.sqlite');
    const deviceKeyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const capabilityKeyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const host = new DeterministicCodexHost();
    const gatewayDiagnostics: string[] = [];
    const workerDiagnostics: string[] = [];
    const pumpDiagnostics: unknown[] = [];
    const runtimeDiagnostics: unknown[] = [];
    let gateway: AgentGateway | undefined;
    let relay: ExactLifecycleReplayRelay | undefined;
    let runtime: ReturnType<typeof createVnextCreatorWorkerRuntime> | undefined;
    let primarySucceeded = false;
    let teardownFailure: AggregateError | undefined;

    try {
      const cluster = await owner.query<{ cluster_name: string }>('SHOW cluster_name');
      if (cluster.rows[0]?.cluster_name !== ISOLATED_CLUSTER_NAME) {
        throw new Error('CREATOR_AGENT_R3_WORKER_HOST_PG_CLUSTER_NOT_ISOLATED');
      }
      const fixture = await seedFixture(owner, deviceKeyPair.publicKey);
      const keys = writeMountedAuthorities(directory, fixture, capabilityKeyPair.privateKey);
      const gatewayKeys = loadGatewayTestKeyring(keys.keyringPath);
      const messageAuthority = loadTestConsumerMessageAuthority(keys.keyringPath);
      const invocationPrepare = loadTestInvocationPrepareAuthority(keys.executionAuthorityPath);
      const journal = new PostgresCloudJournal({ api: apiRole, broker: brokerRole });
      const projector = new PostgresGatewayBusinessEventProjector(
        journal,
        gatewayKeys.sealAssistantMessage,
      );
      const policy: GatewayCompatibilityPolicy = {
        acceptedWorkerVersions: [WORKER_VERSION],
        acceptedCodexRuntimeArtifacts: [RUNTIME_DIGEST],
        acceptedCodexProtocolSchemaDigests: [PROTOCOL_DIGEST],
        acceptedIsolationModes: ['apple-container-v1'],
        acceptedBrokerContractDigests: [BROKER_CONTRACT_DIGEST],
        publisherDeploymentAllowlist: [fixture.deploymentId],
        sessionTtlMs: 15 * 60_000,
        leaseTtlMs: 60_000,
        responseTtlMs: 30_000,
        transactionTimeoutMs: 5_000,
      };
      const authority = new PostgresAgentGatewayAuthority(
        { api: apiRole, broker: brokerRole },
        policy,
        projector,
        undefined,
        gatewayKeys.sealUserMessage,
      );
      gateway = new AgentGateway({
        authority,
        publisherEnabled: true,
        publisherPollIntervalMs: 25,
        authorityTimeoutMs: 8_000,
        stopTimeoutMs: 5_000,
        diagnosticSink: (event) => gatewayDiagnostics.push(event),
      });
      const address = await gateway.start();
      relay = new ExactLifecycleReplayRelay(`ws://${address.host}:${address.port}${address.path}`);
      const workerUrl = await relay.start();
      const workerAuthorities = createWorkerAuthorities({
        capabilityPublicKey: capabilityKeyPair.publicKey,
        sessionKey: keys.sessionKey,
        digestKey: keys.digestKey,
        localKey: keys.localKey,
        sandboxInstanceId: randomUuidV7(),
      });
      runtime = createVnextCreatorWorkerRuntime({
        installationId: fixture.installationId,
        ownerTokenFactory: () => OWNER_TOKEN,
        host,
        transport: {
          filename: sqliteFilename,
          newJournalAuthorization: newJournalAuthorization(fixture.installationId),
        },
        broker: {
          url: workerUrl,
          workerVersion: WORKER_VERSION,
          codexRuntimeArtifacts: [RUNTIME_DIGEST],
          codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
          isolationModes: ['apple-container-v1'],
          challengePort: workerPorts(authority, owner, fixture, deviceKeyPair.privateKey)
            .challengePort,
          deviceSigner: workerPorts(authority, owner, fixture, deviceKeyPair.privateKey)
            .deviceSigner,
          allowInsecureLoopbackForTests: true,
          handshakeTimeoutMs: 5_000,
          portTimeoutMs: 5_000,
          heartbeatIntervalMs: 1_500,
          maximumLeaseGrantMs: 60_000,
          reconnectInitialMs: 50,
          reconnectMaximumMs: 250,
          stopTimeoutMs: 5_000,
          diagnosticSink: (event) => workerDiagnostics.push(event),
        },
        journal: workerAuthorities.journal,
        conversationRuntime: workerAuthorities.conversationRuntime(host),
        resultSealer: workerAuthorities.resultSealer,
        resultKey: {
          currentResultKey: async () => ({ keyId: SESSION_KEY_ID }),
        },
        cloudAckEvidence: workerAuthorities.cloudAckEvidence,
        sandboxAttestationDigest: () => `sha256:${digest('9')}`,
        pollIntervalMs: 10,
        drainTimeoutMs: 10_000,
        finalDrainRounds: 16,
        pumpDiagnosticSink: (event) => pumpDiagnostics.push(event),
        diagnosticSink: (event) => runtimeDiagnostics.push(event),
      });
      await runtime.start();
      await runtime.waitUntilReady(AbortSignal.timeout(10_000));
      await waitFor(
        async () => (await persistedGrantCount(owner, fixture)) >= 1,
        10_000,
        'R3_INITIAL_LEASE_ACK_TIMEOUT',
      );
      const lease = await activeLease(owner, fixture);
      await owner.query(
        `UPDATE deployments
            SET serving_version_id = desired_version_id,
                observed_state = 'ONLINE', observed_worker_id = $2,
                observed_generation = generation, updated_at = clock_timestamp()
          WHERE id = $1 AND creator_id = $3`,
        [fixture.deploymentId, fixture.installationId, fixture.creatorId],
      );
      const opened = await createOpeningConversation(owner, fixture, lease);
      await waitFor(
        async () => {
          const result = await owner.query<{ state: string; outbox_state: string }>(
            `SELECT conversation.state, command.state AS outbox_state
               FROM agent_conversations AS conversation
               JOIN broker_outbox AS command ON command.command_id = $2
              WHERE conversation.id = $1`,
            [opened.conversationId, opened.commandId],
          );
          return result.rows[0]?.state === 'IDLE' && result.rows[0]?.outbox_state === 'ACKED';
        },
        15_000,
        'R3_CONVERSATION_READY_TIMEOUT',
      );

      const runtimeAuthorities = {
        message: messageAuthority,
        invocationPrepare,
        serverIds: createPostgresServerIdAuthority(consumerDb),
      } as const;
      const clientMessageId = randomUUID();
      const accepted = await sendConsumerMessage(
        consumerDb,
        {
          consumerId: fixture.consumerId,
          conversationId: opened.conversationId,
          clientMessageId,
          text: USER_TEXT,
        },
        runtimeAuthorities,
      );
      try {
        await waitFor(
          async () => (await invocationState(owner, accepted.invocationId)) === 'SUCCEEDED',
          25_000,
          'R3_INVOCATION_SUCCESS_TIMEOUT',
        );
      } catch (error) {
        const diagnostic = await verticalDiagnosticSnapshot(
          owner,
          sqliteFilename,
          accepted.invocationId,
        );
        throw new Error(
          `R3_INVOCATION_SUCCESS_TIMEOUT:${JSON.stringify({
            diagnostic,
            runtimeStatus: runtime.status,
            hostDispatchCount: host.dispatchCount,
            relayDuplicates: Object.fromEntries(relay.duplicates),
            gatewayDiagnostics: gatewayDiagnostics.slice(-16),
            workerDiagnostics: workerDiagnostics.slice(-16),
            pumpDiagnostics: pumpDiagnostics.slice(-16),
            runtimeDiagnostics: runtimeDiagnostics.slice(-16),
            workerAuthorityDiagnostics: workerAuthorities.diagnostics.slice(-16),
          })}`,
          { cause: error },
        );
      }
      await waitFor(
        () => sqliteInvocationCloudCommitted(sqliteFilename, accepted.invocationId),
        10_000,
        'R3_WORKER_CLOUD_ACK_TIMEOUT',
      );

      const transcript = await readConsumerConversationTranscript(
        consumerDb,
        { consumerId: fixture.consumerId, conversationId: opened.conversationId },
        messageAuthority,
      );
      expect(transcript.messages.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: 'USER', text: USER_TEXT },
        { role: 'ASSISTANT', text: ASSISTANT_TEXT },
      ]);
      expect(host.dispatchCount).toBe(1);
      expect(host.dispatchedTexts).toEqual([USER_TEXT]);
      expect(relay.duplicates).toEqual(
        new Map([
          ['invocation.prepare', 1],
          ['invocation.start', 1],
        ]),
      );

      const replay = await sendConsumerMessage(
        consumerDb,
        {
          consumerId: fixture.consumerId,
          conversationId: opened.conversationId,
          clientMessageId,
          text: USER_TEXT,
        },
        runtimeAuthorities,
      );
      expect(replay.invocationId).toBe(accepted.invocationId);
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      runtime.wake();
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      expect(host.dispatchCount).toBe(1);
      await assertDurableExactlyOnce(owner, sqliteFilename, accepted.invocationId);
      primarySucceeded = true;
    } finally {
      const teardownFailures: Error[] = [];
      const stopSteps = [
        { name: 'runtime.stop', run: () => runtime?.stop() },
        { name: 'relay.stop', run: () => relay?.stop() },
        { name: 'gateway.stop', run: () => gateway?.stop() },
      ] as const;
      for (const step of stopSteps) {
        const [result] = await Promise.allSettled([Promise.resolve().then(step.run)]);
        if (result?.status === 'rejected') {
          teardownFailures.push(
            new Error(`R3_TEARDOWN_FAILED:${step.name}`, { cause: result.reason }),
          );
        }
      }
      const poolSteps = [
        { name: 'owner.end', run: () => owner.end() },
        { name: 'apiRole.end', run: () => apiRole.end() },
        { name: 'brokerRole.end', run: () => brokerRole.end() },
        { name: 'consumerDb.end', run: () => consumerDb.end() },
      ] as const;
      const poolResults = await Promise.allSettled(
        poolSteps.map((step) => Promise.resolve().then(step.run)),
      );
      for (const [index, result] of poolResults.entries()) {
        if (result.status === 'rejected') {
          teardownFailures.push(
            new Error(`R3_TEARDOWN_FAILED:${poolSteps[index]?.name ?? 'unknown-pool'}`, {
              cause: result.reason,
            }),
          );
        }
      }
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        teardownFailures.push(new Error('R3_TEARDOWN_FAILED:temp.remove', { cause: error }));
      }
      if (primarySucceeded && teardownFailures.length > 0) {
        teardownFailure = new AggregateError(teardownFailures, 'R3_TEARDOWN_FAILED');
      }
    }
    if (teardownFailure !== undefined) throw teardownFailure;
  }, 90_000);
});

function rawDataBytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  throw new TypeError('R3_UNSUPPORTED_WEBSOCKET_DATA');
}

function brokerFrame(bytes: Buffer): ReturnType<typeof parseBrokerFrame> | undefined {
  try {
    return parseBrokerFrame(bytes);
  } catch {
    return undefined;
  }
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
    throw new Error('R3_INVALID_DEVICE_PUBLIC_KEY');
  }
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  if (x.byteLength !== 32 || y.byteLength !== 32) throw new Error('R3_INVALID_DEVICE_POINT');
  return Buffer.concat([Buffer.from([0x04]), x, y]);
}

async function seedFixture(owner: PgPool, devicePublicKey: KeyObject): Promise<FixtureIds> {
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
  if (creatorId === undefined || consumerId === undefined) throw new Error('R3_USER_SEED_FAILED');
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
      `r3/${ids.snapshotId}.archive.enc`,
      `r3/${ids.snapshotId}.manifest.enc`,
      `kms://${ids.snapshotId}`,
    ],
  );
  await owner.query(
    `INSERT INTO agents (id, creator_id, public_slug, name)
     VALUES ($1, $2, $3, 'R3 Worker Host Agent')`,
    [ids.agentId, ids.creatorId, `r3-${ids.agentId.slice(0, 8)}`],
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
       '0.147.0-r3-worker-host', $11, $12
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
  await owner.query('INSERT INTO agent_version_controls (version_id, creator_id) VALUES ($1, $2)', [
    ids.versionId,
    ids.creatorId,
  ]);
  await owner.query(
    `INSERT INTO deployments (
       id, agent_id, creator_id, environment, desired_state, desired_version_id, generation
     ) VALUES ($1, $2, $3, 'TEST', 'ONLINE', $4, 1)`,
    [ids.deploymentId, ids.agentId, ids.creatorId, ids.versionId],
  );
  await owner.query(
    `INSERT INTO worker_installations (
       id, creator_id, installation_key_id, device_public_key,
       worker_version, protocol_versions, capabilities
     ) VALUES ($1, $2, $3, $4, $5, '[1]'::jsonb, $6::jsonb)`,
    [
      ids.installationId,
      ids.creatorId,
      `r3-device-${ids.installationId}`,
      publicPoint(devicePublicKey),
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

function writeMountedAuthorities(
  directory: string,
  fixture: FixtureIds,
  capabilityPrivateKey: KeyObject,
) {
  const ownerKey = randomBytes(32);
  const digestKey = randomBytes(32);
  const sessionKey = randomBytes(32);
  const localKey = randomBytes(32);
  const keyringPath = join(directory, 'test-keyring.json');
  const executionAuthorityPath = join(directory, 'execution-authority.json');
  writeFileSync(
    keyringPath,
    JSON.stringify({
      protocol: 'combo.gateway-test-keyring/1',
      schemaVersion: 1,
      owners: [
        {
          ownerId: fixture.creatorId,
          digestKey: digestKey.toString('base64url'),
          messageKeys: [
            {
              keyId: OWNER_KEY_ID,
              status: 'ACTIVE',
              encryptionKey: ownerKey.toString('base64url'),
            },
          ],
        },
      ],
      workerInstallations: [
        {
          installationId: fixture.installationId,
          sessionKeys: [
            {
              keyId: SESSION_KEY_ID,
              status: 'ACTIVE',
              encryptionKey: sessionKey.toString('base64url'),
            },
          ],
        },
      ],
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
  writeFileSync(
    executionAuthorityPath,
    JSON.stringify({
      protocol: 'combo.runtime-test-execution-authority/1',
      schemaVersion: 1,
      privateKeyPkcs8Pem: capabilityPrivateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      budget: { maxInputTokens: 64_000, maxOutputTokens: 8_192, maxCostMicros: 5_000_000 },
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
  return Object.freeze({
    keyringPath,
    executionAuthorityPath,
    digestKey,
    sessionKey,
    localKey,
  });
}

function newJournalAuthorization(installationId: string): NewWorkerJournalAuthorization {
  return Object.freeze({
    installationId,
    journalGeneration: randomUuidV7(),
    authorizationDigest: createHash('sha256')
      .update(`r3-worker-journal:${installationId}`, 'utf8')
      .digest('hex'),
  });
}

function workerPorts(
  authority: PostgresAgentGatewayAuthority,
  owner: PgPool,
  fixture: FixtureIds,
  privateKey: KeyObject,
) {
  return Object.freeze({
    challengePort: {
      async requestChallenge(input: { installationId: string; signal: AbortSignal }) {
        if (input.installationId !== fixture.installationId) {
          throw new Error('R3_INSTALLATION_MISMATCH');
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
        if (!(cloudTime instanceof Date)) throw new Error('R3_CLOUD_TIME_MISSING');
        return { challengeId: challenge.challengeId, cloudTime: cloudTime.toISOString() };
      },
    },
    deviceSigner: {
      async signCanonicalHandshake(input: {
        installationId: string;
        canonicalBytes: Uint8Array;
        signal: AbortSignal;
      }) {
        input.signal.throwIfAborted();
        if (input.installationId !== fixture.installationId) {
          throw new Error('R3_INSTALLATION_MISMATCH');
        }
        return sign('sha256', input.canonicalBytes, {
          key: privateKey,
          dsaEncoding: 'ieee-p1363',
        }).toString('base64url');
      },
    },
  });
}

function createWorkerAuthorities(input: {
  capabilityPublicKey: KeyObject;
  sessionKey: Buffer;
  digestKey: Buffer;
  localKey: Buffer;
  sandboxInstanceId: string;
}) {
  const diagnostics: string[] = [];
  const capabilityAuthority: WorkerInvocationCapabilityAuthorityPort = {
    verify(rawCapability, expected, now) {
      try {
        const verified = verifyCapability(rawCapability, expected, now, input.capabilityPublicKey);
        diagnostics.push('capability_verified');
        return verified;
      } catch (error) {
        diagnostics.push(
          error instanceof Error ? `capability_rejected:${error.message}` : 'capability_rejected',
        );
        throw error;
      }
    },
    verifyPreviouslyCommitted(rawCapability, expected, committedDigest, committedAt) {
      const verified = verifyCapability(
        rawCapability,
        expected,
        committedAt,
        input.capabilityPublicKey,
      );
      if (verified.capabilityDigest !== committedDigest) throw new Error('R3_CAPABILITY_CONFLICT');
      return verified;
    },
  };
  const readyConversationAuthority: ReadyConversationAuthorityPort = {
    verify(rawEvidence, expected) {
      const evidence = rawEvidence as Record<string, unknown>;
      if (
        evidence.protocol !== 'combo.r3-ready-evidence/1' ||
        evidence.conversationId !== expected.conversationId ||
        evidence.runtimeThreadId !== 'thread-r3-worker-host' ||
        evidence.sandboxInstanceId !== input.sandboxInstanceId
      ) {
        throw new Error('R3_READY_EVIDENCE_INVALID');
      }
      return Object.freeze({
        sandboxInstanceId: input.sandboxInstanceId,
        runtimeThreadId: 'thread-r3-worker-host',
        evidenceDigest: `sha256:${canonicalSha256(evidence)}`,
        readyAt: new Date(),
      });
    },
  };
  const localPromptAeadAuthority: LocalPromptAeadAuthorityPort = {
    rewrap({ brokerCiphertext, brokerAad, localAad, expectedRequestDigest }) {
      if (
        brokerCiphertext.keyId !== SESSION_KEY_ID ||
        canonicalizeJson(brokerCiphertext.aad) !== canonicalizeJson(brokerAad)
      ) {
        throw new Error('R3_BROKER_PROMPT_BINDING_INVALID');
      }
      const plaintext = openBrokerMessage(brokerCiphertext, input.sessionKey);
      const requestDigest = requestDigestFor(plaintext, input.digestKey);
      if (requestDigest !== expectedRequestDigest) throw new Error('R3_REQUEST_DIGEST_INVALID');
      diagnostics.push('prompt_rewrap_verified');
      return {
        ciphertext: sealLocalPrompt(plaintext, input.localKey, input.digestKey, localAad),
        requestDigest,
      };
    },
    open({ ciphertext, expectedAad, expectedRequestDigest }) {
      const plaintext = openLocalPrompt(ciphertext, input.localKey, expectedAad);
      const requestDigest = requestDigestFor(plaintext, input.digestKey);
      if (requestDigest !== expectedRequestDigest) throw new Error('R3_REQUEST_DIGEST_INVALID');
      return { plaintext, requestDigest };
    },
  };
  const localResultAeadAuthority: LocalResultAeadAuthorityPort = {
    verify(ciphertext, expectedAad) {
      const plaintext = openLocalResult(ciphertext, input.localKey, expectedAad);
      return { resultDigest: resultDigestFor(plaintext, input.digestKey) };
    },
  };
  const brokerResultReencryptAuthority: BrokerResultReencryptAuthorityPort = {
    reencrypt({ localCiphertext, localAad, brokerAad }) {
      const plaintext = openLocalResult(localCiphertext, input.localKey, localAad);
      return {
        ciphertext: sealBrokerMessage(plaintext, input.sessionKey, brokerAad),
        resultDigest: resultDigestFor(plaintext, input.digestKey),
      };
    },
  };
  const cloudAckAuthority: CloudInvocationAckAuthorityPort = {
    verify(rawEvidence, expected) {
      const evidence = rawEvidence as Record<string, unknown>;
      if (
        evidence.protocol !== 'combo.r3-cloud-ack-evidence/1' ||
        evidence.messageId !== expected.ackMessageId ||
        evidence.canonicalDigest !== expected.ackCanonicalDigest ||
        evidence.acknowledgedDeliveryMessageId !== expected.deliveryMessageId
      ) {
        throw new Error('R3_CLOUD_ACK_EVIDENCE_INVALID');
      }
      return { evidenceDigest: `sha256:${canonicalSha256(expected)}` };
    },
  };
  const resultSealer: LocalResultAeadSealerPort = {
    seal(plaintext, expectedAad) {
      return sealLocalResult(plaintext, input.localKey, input.digestKey, expectedAad);
    },
  };
  return Object.freeze({
    diagnostics,
    journal: {
      capabilityAuthority,
      readyConversationAuthority,
      localPromptAeadAuthority,
      localResultAeadAuthority,
      brokerResultReencryptAuthority,
      cloudAckAuthority,
      cloudClock: { now: () => new Date() },
    },
    resultSealer,
    conversationRuntime(host: DeterministicCodexHost) {
      return Object.freeze({
        async provision(expected: { conversationId: string }, signal: AbortSignal) {
          signal.throwIfAborted();
          const thread = await host.createThread();
          return {
            thread,
            sandboxInstanceId: input.sandboxInstanceId,
            readyEvidence: {
              protocol: 'combo.r3-ready-evidence/1',
              conversationId: expected.conversationId,
              runtimeThreadId: thread.id,
              sandboxInstanceId: input.sandboxInstanceId,
            },
          };
        },
        async verifyReady(conversation: { conversationId: string }, thread: HostThread) {
          if (
            conversation.conversationId.length === 0 ||
            thread.id !== 'thread-r3-worker-host' ||
            !thread.workspaceRootsAcknowledged
          ) {
            throw new Error('R3_READY_BINDING_INVALID');
          }
        },
        async resumeProvision(
          expected: { conversationId: string },
          thread: HostThread,
          signal: AbortSignal,
        ) {
          signal.throwIfAborted();
          return {
            thread,
            sandboxInstanceId: input.sandboxInstanceId,
            readyEvidence: {
              protocol: 'combo.r3-ready-evidence/1',
              conversationId: expected.conversationId,
              runtimeThreadId: thread.id,
              sandboxInstanceId: input.sandboxInstanceId,
            },
          };
        },
        async releaseProvision(): Promise<void> {
          return undefined;
        },
      });
    },
    cloudAckEvidence: {
      async evidenceFor(ack: OpaqueInvocationCloudAckReference, signal: AbortSignal) {
        signal.throwIfAborted();
        return {
          protocol: 'combo.r3-cloud-ack-evidence/1',
          messageId: ack.messageId,
          canonicalDigest: ack.canonicalDigest,
          acknowledgedDeliveryMessageId: ack.acknowledgedDeliveryMessageId,
        };
      },
    },
  });
}

function verifyCapability(
  rawCapability: unknown,
  expected: ExpectedExecutionCapabilityBinding,
  now: Date,
  publicKey: KeyObject,
) {
  const result = validateExecutionCapabilityBinding(
    rawCapability,
    expected,
    now,
    new Set<string>(),
    publicKey,
  );
  if (!result.ok) throw new Error(`R3_CAPABILITY_INVALID:${result.reasons.join(',')}`);
  return result;
}

function requestDigestFor(plaintext: Uint8Array, key: Buffer): string {
  return `hmac-sha256:${createHmac('sha256', key)
    .update('combo:vnext:request:v1\0', 'utf8')
    .update(plaintext)
    .digest('hex')}`;
}

function resultDigestFor(plaintext: Uint8Array, key: Buffer): string {
  return domainSeparatedHmacSha256('combo:vnext:result:v1', key, {
    text: Buffer.from(plaintext).toString('utf8'),
  });
}

function openBrokerMessage(message: BrokerSensitiveMessage, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(message.nonce, 'base64url'));
  decipher.setAAD(brokerSensitiveMessageAadBytes(message.aad));
  decipher.setAuthTag(Buffer.from(message.authTag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(message.ciphertext, 'base64url')),
    decipher.final(),
  ]);
}

function sealBrokerMessage(
  plaintext: Uint8Array,
  key: Buffer,
  aad: BrokerSensitiveMessage['aad'],
): BrokerSensitiveMessage {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(brokerSensitiveMessageAadBytes(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const nonceText = nonce.toString('base64url');
  const ciphertextText = ciphertext.toString('base64url');
  const authTagText = authTag.toString('base64url');
  return {
    algorithm: 'aes-256-gcm/v1',
    keyScope: 'worker-session',
    keyId: aad.keyId,
    nonce: nonceText,
    ciphertext: ciphertextText,
    authTag: authTagText,
    cipherDigest: brokerSensitiveMessageCipherDigest(nonceText, ciphertextText, authTagText),
    aad,
    aadDigest: brokerSensitiveMessageAadDigest(aad),
    aadVersion: 1,
  };
}

function sealLocalPrompt(
  plaintext: Uint8Array,
  key: Buffer,
  digestKey: Buffer,
  aad: LocalInvocationPromptAad,
): LocalInvocationPromptCiphertext {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(localInvocationPromptAadBytes(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const nonceText = nonce.toString('base64url');
  const ciphertextText = ciphertext.toString('base64url');
  const authTagText = authTag.toString('base64url');
  return {
    algorithm: 'aes-256-gcm/v1',
    keyScope: 'worker-keychain',
    keyId: LOCAL_KEY_ID,
    nonce: nonceText,
    ciphertext: ciphertextText,
    authTag: authTagText,
    cipherDigest: localInvocationPromptCipherDigest(nonceText, ciphertextText, authTagText),
    requestDigest: requestDigestFor(plaintext, digestKey),
    aad,
    aadDigest: localInvocationPromptAadDigest(aad),
    aadVersion: 1,
  };
}

function openLocalPrompt(
  ciphertext: LocalInvocationPromptCiphertext,
  key: Buffer,
  expectedAad: LocalInvocationPromptAad,
): Buffer {
  if (
    ciphertext.keyId !== LOCAL_KEY_ID ||
    canonicalizeJson(ciphertext.aad) !== canonicalizeJson(expectedAad)
  ) {
    throw new Error('R3_LOCAL_PROMPT_BINDING_INVALID');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ciphertext.nonce, 'base64url'));
  decipher.setAAD(localInvocationPromptAadBytes(expectedAad));
  decipher.setAuthTag(Buffer.from(ciphertext.authTag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext.ciphertext, 'base64url')),
    decipher.final(),
  ]);
}

function sealLocalResult(
  plaintext: Uint8Array,
  key: Buffer,
  digestKey: Buffer,
  aad: LocalInvocationResultAad,
): LocalInvocationResultCiphertext {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(localInvocationResultAadBytes(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const nonceText = nonce.toString('base64url');
  const ciphertextText = ciphertext.toString('base64url');
  const authTagText = authTag.toString('base64url');
  return {
    algorithm: 'aes-256-gcm/v1',
    keyScope: 'worker-keychain',
    keyId: LOCAL_KEY_ID,
    nonce: nonceText,
    ciphertext: ciphertextText,
    authTag: authTagText,
    cipherDigest: localInvocationResultCipherDigest(nonceText, ciphertextText, authTagText),
    resultDigest: resultDigestFor(plaintext, digestKey),
    aad,
    aadDigest: localInvocationResultAadDigest(aad),
    aadVersion: 1,
  };
}

function openLocalResult(
  ciphertext: LocalInvocationResultCiphertext,
  key: Buffer,
  expectedAad: LocalInvocationResultAad,
): Buffer {
  if (
    ciphertext.keyId !== LOCAL_KEY_ID ||
    canonicalizeJson(ciphertext.aad) !== canonicalizeJson(expectedAad)
  ) {
    throw new Error('R3_LOCAL_RESULT_BINDING_INVALID');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ciphertext.nonce, 'base64url'));
  decipher.setAAD(localInvocationResultAadBytes(expectedAad));
  decipher.setAuthTag(Buffer.from(ciphertext.authTag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext.ciphertext, 'base64url')),
    decipher.final(),
  ]);
}

async function activeLease(owner: PgPool, fixture: FixtureIds): Promise<ActiveLease> {
  const result = await owner.query<ActiveLease>(
    `SELECT gateway.id::text AS worker_session_id,
            gateway.connection_id::text,
            lease.id::text AS lease_id,
            lease.fence::text
       FROM worker_gateway_sessions AS gateway
       JOIN worker_leases AS lease
         ON lease.connection_id = gateway.connection_id
        AND lease.worker_id = gateway.installation_id
        AND lease.creator_id = gateway.creator_id
      WHERE gateway.creator_id = $1 AND gateway.installation_id = $2
        AND gateway.state = 'ACTIVE' AND lease.state = 'ACTIVE'`,
    [fixture.creatorId, fixture.installationId],
  );
  if (result.rows.length !== 1 || result.rows[0] === undefined) {
    throw new Error(`R3_ACTIVE_LEASE_COUNT_${result.rows.length}`);
  }
  return result.rows[0];
}

async function persistedGrantCount(owner: PgPool, fixture: FixtureIds): Promise<number> {
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

async function createOpeningConversation(
  owner: PgPool,
  fixture: FixtureIds,
  lease: ActiveLease,
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
        'r3-visible-transcript-key',
        'kms://r3/visible-transcript-key@7',
      ],
    );
    const row = created.rows[0];
    if (row === undefined) throw new Error('R3_OPEN_CONVERSATION_FAILED');
    await connection.query('COMMIT');
    return { conversationId: row.conversation_id, commandId: row.open_command_id };
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

async function invocationState(owner: PgPool, invocationId: string): Promise<string | undefined> {
  const result = await owner.query<{ state: string }>(
    'SELECT state FROM agent_invocations WHERE id = $1',
    [invocationId],
  );
  return result.rows[0]?.state;
}

async function verticalDiagnosticSnapshot(
  owner: PgPool,
  sqliteFilename: string,
  invocationId: string,
): Promise<unknown> {
  const [invocation, commands, events, gatewaySecurity] = await Promise.all([
    owner.query(
      `SELECT invocation.state, invocation.reconciliation_reason, invocation.error_code,
              invocation.runtime_thread_id IS NOT NULL AS has_runtime_thread,
              invocation.runtime_turn_id IS NOT NULL AS has_runtime_turn,
              invocation.result_digest IS NOT NULL AS has_result,
              invocation.terminal_at IS NOT NULL AS terminal,
              invocation.deadline_at > assignment.expires_at AS deadline_after_assignment_lease,
              invocation.execution_capability_expires_at > assignment.expires_at
                AS capability_after_assignment_lease
         FROM agent_invocations AS invocation
         JOIN worker_leases AS assignment ON assignment.id = invocation.assignment_lease_id
        WHERE invocation.id = $1`,
      [invocationId],
    ),
    owner.query(
      `SELECT command_type, state, attempt_count,
              EXISTS (
                SELECT 1 FROM worker_gateway_outbound_frames AS delivery
                 WHERE delivery.broker_command_id = command.command_id
              ) AS has_delivery,
              COALESCE((
                SELECT max(delivery.durable_ack_level)
                  FROM worker_gateway_outbound_frames AS delivery
                 WHERE delivery.broker_command_id = command.command_id
              ), 'NONE') AS durable_ack_level
         FROM broker_outbox AS command
        WHERE invocation_id = $1 ORDER BY command_type`,
      [invocationId],
    ),
    owner.query(
      `SELECT event_type, count(*)::text AS count
         FROM agent_invocation_events WHERE invocation_id = $1
        GROUP BY event_type ORDER BY event_type`,
      [invocationId],
    ),
    owner.query(
      `SELECT
         (SELECT count(*)::text FROM worker_gateway_security_events) AS security_events,
         (SELECT count(*)::text FROM worker_gateway_sequence_gaps) AS sequence_gaps`,
    ),
  ]);
  let sqlite: unknown;
  try {
    const database = new SqliteDatabase(sqliteFilename, { readOnly: true });
    try {
      sqlite = {
        invocation: database
          .prepare(
            `SELECT state, host_dispatch_intent_count, host_dispatch_attempt_count,
                    host_dispatch_confirmed_count,
                    runtime_turn_id IS NOT NULL AS has_runtime_turn,
                    result_digest IS NOT NULL AS has_result
               FROM local_invocations WHERE invocation_id = ?`,
          )
          .get(invocationId),
        consumedCommands: database
          .prepare(
            `SELECT command_type, disposition, count(*) AS count
               FROM local_consumed_commands
              WHERE invocation_id = ?
              GROUP BY command_type, disposition ORDER BY command_type, disposition`,
          )
          .all(invocationId),
        localOutbox: database
          .prepare(
            `SELECT event_type, count(*) AS count
               FROM local_invocation_outbox
              WHERE invocation_id = ? GROUP BY event_type ORDER BY event_type`,
          )
          .all(invocationId),
        deliveries: database
          .prepare(
            `SELECT event_type, count(*) AS count
               FROM local_invocation_deliveries
              WHERE invocation_id = ? GROUP BY event_type ORDER BY event_type`,
          )
          .all(invocationId),
        receipts: database
          .prepare(
            `SELECT outbox.event_type, count(*) AS count
               FROM local_invocation_outbox_receipts AS receipt
               JOIN local_invocation_outbox AS outbox
                 ON outbox.source_event_id = receipt.source_event_id
              WHERE outbox.invocation_id = ?
              GROUP BY outbox.event_type ORDER BY outbox.event_type`,
          )
          .all(invocationId),
        inbound: database
          .prepare(
            `SELECT envelope_type, effect_state, max(replay_count) AS replay_count,
                    count(*) AS count
               FROM transport_inbound_frames
              WHERE envelope_type LIKE 'invocation.%'
                 OR envelope_type = 'message.ack'
              GROUP BY envelope_type, effect_state ORDER BY envelope_type, effect_state`,
          )
          .all(),
        transportOutbox: database
          .prepare(
            `SELECT envelope_type, state, COALESCE(ack_level, 'NONE') AS ack_level,
                    count(*) AS count
               FROM transport_outbox
              WHERE envelope_type LIKE 'invocation.%'
                 OR envelope_type = 'message.ack'
              GROUP BY envelope_type, state, ack_level
              ORDER BY envelope_type, state, ack_level`,
          )
          .all(),
      };
    } finally {
      database.close();
    }
  } catch (error) {
    sqlite = { unavailable: error instanceof Error ? error.message : 'unknown' };
  }
  return {
    postgres: {
      invocation: invocation.rows,
      commands: commands.rows,
      events: events.rows,
      gatewaySecurity: gatewaySecurity.rows,
    },
    sqlite,
  };
}

function sqliteInvocationCloudCommitted(filename: string, invocationId: string): boolean {
  try {
    const database = new SqliteDatabase(filename, { readOnly: true });
    try {
      const row = database
        .prepare('SELECT state FROM local_invocations WHERE invocation_id = ?')
        .get(invocationId) as { state: string } | undefined;
      return row?.state === 'CLOUD_COMMITTED';
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}

async function assertDurableExactlyOnce(
  owner: PgPool,
  sqliteFilename: string,
  invocationId: string,
): Promise<void> {
  const commands = await owner.query<{
    command_type: string;
    command_id: string;
    state: string;
    count: string;
  }>(
    `SELECT command_type, min(command_id::text) AS command_id, min(state::text) AS state,
            count(*)::text
       FROM broker_outbox
      WHERE invocation_id = $1 AND command_type IN ('invocation.prepare', 'invocation.start')
      GROUP BY command_type
      ORDER BY command_type`,
    [invocationId],
  );
  expect(commands.rows).toEqual([
    expect.objectContaining({ command_type: 'invocation.prepare', state: 'ACKED', count: '1' }),
    expect.objectContaining({ command_type: 'invocation.start', state: 'ACKED', count: '1' }),
  ]);
  const events = await owner.query<{ event_type: string; count: string }>(
    `SELECT event_type, count(*)::text
       FROM agent_invocation_events
      WHERE invocation_id = $1
        AND event_type IN ('invocation.persisted', 'invocation.started', 'invocation.succeeded')
      GROUP BY event_type
      ORDER BY event_type`,
    [invocationId],
  );
  expect(events.rows).toEqual([
    { event_type: 'invocation.persisted', count: '1' },
    { event_type: 'invocation.started', count: '1' },
    { event_type: 'invocation.succeeded', count: '1' },
  ]);
  const messages = await owner.query<{ role: string; count: string }>(
    `SELECT role, count(*)::text
       FROM agent_messages
      WHERE invocation_id = $1
      GROUP BY role
      ORDER BY role`,
    [invocationId],
  );
  expect(messages.rows).toEqual([
    { role: 'ASSISTANT', count: '1' },
    { role: 'USER', count: '1' },
  ]);

  const commandIds = new Map(commands.rows.map((row) => [row.command_type, row.command_id]));
  const database = new SqliteDatabase(sqliteFilename, { readOnly: true });
  try {
    const invocation = database
      .prepare(
        `SELECT state, host_dispatch_intent_count, host_dispatch_attempt_count,
                host_dispatch_confirmed_count,
                prepare_command_id, prepare_connection_id, prepare_sequence,
                prepare_canonical_digest,
                start_command_id, start_connection_id, start_sequence,
                start_canonical_digest
           FROM local_invocations WHERE invocation_id = ?`,
      )
      .get(invocationId) as
      | {
          state: string;
          host_dispatch_intent_count: number;
          host_dispatch_attempt_count: number;
          host_dispatch_confirmed_count: number;
          prepare_command_id: string;
          prepare_connection_id: string;
          prepare_sequence: string;
          prepare_canonical_digest: string;
          start_command_id: string;
          start_connection_id: string;
          start_sequence: string;
          start_canonical_digest: string;
        }
      | undefined;
    expect(invocation).toMatchObject({
      state: 'CLOUD_COMMITTED',
      host_dispatch_intent_count: 1,
      host_dispatch_attempt_count: 1,
      host_dispatch_confirmed_count: 1,
    });
    if (invocation === undefined) throw new Error('R3_LOCAL_INVOCATION_MISSING');
    expect(invocation.prepare_command_id).toBe(commandIds.get('invocation.prepare'));
    expect(invocation.start_command_id).toBe(commandIds.get('invocation.start'));
    const consumed = database
      .prepare(
        `SELECT command_id, connection_id, sequence, canonical_digest,
                command_type, disposition
           FROM local_consumed_commands
          WHERE invocation_id = ?
            AND command_type IN ('invocation.prepare', 'invocation.start')
          ORDER BY command_type`,
      )
      .all(invocationId);
    expect(consumed).toEqual([
      {
        command_id: invocation.prepare_command_id,
        connection_id: invocation.prepare_connection_id,
        sequence: invocation.prepare_sequence,
        canonical_digest: invocation.prepare_canonical_digest,
        command_type: 'invocation.prepare',
        disposition: 'APPLIED',
      },
      {
        command_id: invocation.start_command_id,
        connection_id: invocation.start_connection_id,
        sequence: invocation.start_sequence,
        canonical_digest: invocation.start_canonical_digest,
        command_type: 'invocation.start',
        disposition: 'APPLIED',
      },
    ]);
    const prepare = database
      .prepare(
        `SELECT effect_state, replay_count FROM transport_inbound_frames
          WHERE message_id = ? AND envelope_type = 'invocation.prepare'`,
      )
      .get(invocation.prepare_command_id) as
      | { effect_state: string; replay_count: number }
      | undefined;
    const start = database
      .prepare(
        `SELECT effect_state, replay_count FROM transport_inbound_frames
          WHERE message_id = ? AND envelope_type = 'invocation.start'`,
      )
      .get(invocation.start_command_id) as
      | { effect_state: string; replay_count: number }
      | undefined;
    expect(prepare).toBeUndefined();
    expect(start).toMatchObject({ effect_state: 'APPLIED' });
    expect(start?.replay_count).toBeGreaterThanOrEqual(1);
  } finally {
    database.close();
  }
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
