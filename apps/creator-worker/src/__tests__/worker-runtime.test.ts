import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createFreshWorkerSqliteStore,
  openExistingWorkerSqliteStore,
  type WorkerSqliteStoreOptions,
} from '@cb/creator-agent-broker-journal/sqlite-store';
import {
  createBrokerTransportFrame,
  parseBrokerTransportFrame,
  type BrokerTransportFrameMaterialization,
  type BrokerTransportPayload,
} from '@cb/creator-agent-protocol/broker-transport';
import {
  createFreshWorkerDurableTransportRepository,
  openExistingWorkerDurableTransportRepository,
  type WorkerTransportStoreOptions,
} from '@cb/creator-worker-broker-client/sqlite-repository';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer, type RawData } from 'ws';

import {
  createCreatorWorkerRuntime,
  type CreatorWorkerRuntime,
  type CreatorWorkerRuntimeOptions,
  type CreatorWorkerRuntimeStorageMode,
} from '../index.js';
import {
  FakeHost,
  PROMPT_CANARY,
  RESULT_CANARY,
  SEALED_FINGERPRINT,
  fingerprint,
} from './test-fixture.js';

const INSTALLATION = 'installation.r2e';
const INPUT_FINGERPRINT = fingerprint(PROMPT_CANARY);
const runtimes: CreatorWorkerRuntime[] = [];
const brokers: BrokerHarness[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    runtimes
      .splice(0)
      .reverse()
      .map((runtime) => runtime.stop()),
  );
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe('Creator Worker Runtime composition root', () => {
  it('runs the real two-SQLite and WebSocket vertical, then reopens without replaying Host', async () => {
    const root = temporaryRoot();
    const broker = await BrokerHarness.listen();
    const host = new FakeHost();
    let committedInbound = 0;
    const runtime = trackedRuntime(
      runtimeOptions(root, broker.url, host, 'CREATE_FRESH', () => {
        committedInbound += 1;
      }),
    );

    const firstStart = runtime.start();
    expect(runtime.start()).toBe(firstStart);
    await expect(firstStart).resolves.toEqual({ recoveredInvocations: 0, preparedInvocations: 0 });
    expect(runtime.status).toBe('READY');
    expect(host.startLifecycleCalls).toBe(1);

    broker.sendCommand('invocation.prepare', { invocationId: 'invocation.r2e' }, 'command.prepare');
    broker.sendCommand(
      'invocation.start',
      {
        invocationId: 'invocation.r2e',
        attemptId: 'attempt.r2e',
        inputRef: 'input.r2e',
        inputFingerprint: INPUT_FINGERPRINT,
      },
      'command.start',
    );
    await eventually(() => host.controllers.length === 1);
    expect(host.inputs[0]?.text).toBe(PROMPT_CANARY);
    settleHostSuccess(host);
    await eventually(() => broker.workerMessages.length === 2 && committedInbound >= 4);
    expect(broker.workerMessages.map(({ frame }) => frame.body)).toMatchObject([
      { type: 'worker.message', messageType: 'worker.started' },
      { type: 'worker.message', messageType: 'worker.terminal' },
    ]);

    const firstStop = runtime.stop();
    expect(runtime.stop()).toBe(firstStop);
    await firstStop;
    expect(runtime.status).toBe('STOPPED');
    expect(host.stopCalls).toBe(1);
    expect(runtime.start()).not.toBe(firstStart);
    await expect(runtime.start()).rejects.toMatchObject({ code: 'RUNTIME_STOPPED' });

    const reopenedHost = new FakeHost();
    const reopened = trackedRuntime(
      runtimeOptions(root, broker.url, reopenedHost, 'OPEN_EXISTING'),
    );
    await expect(reopened.start()).resolves.toEqual({
      recoveredInvocations: 0,
      preparedInvocations: 0,
    });
    await reopened.stop();
    expect(reopenedHost.startCalls).toBe(0);
    expect(reopenedHost.startLifecycleCalls).toBe(1);
    expect(reopenedHost.stopCalls).toBe(1);

    const journalOptions = journalOptionsFor(root);
    const journal = openExistingWorkerSqliteStore(journalOptions);
    const acquired = journal.acquireOwner();
    expect(journal.readInvocation(acquired.owner, 'invocation.r2e')).toMatchObject({
      phase: 'TERMINAL_READY',
      state: { terminal: { outcome: 'SUCCEEDED' } },
    });
    expect(journal.readPendingFacts(acquired.owner)).toEqual([]);
    journal.close(acquired.owner);

    const transport = openExistingWorkerDurableTransportRepository(transportOptionsFor(root));
    const transportOwner = transport.acquireOwner();
    for (const message of broker.workerMessages) {
      if (message.frame.body.type !== 'worker.message') continue;
      expect(transport.readDelivery(transportOwner, message.frame.body.sourceId)).toMatchObject({
        state: 'ACKED',
      });
    }
    transport.close(transportOwner);
  });

  it('keeps startup cancellable while the Broker has not granted a lease', async () => {
    const root = temporaryRoot();
    const broker = await BrokerHarness.listen({ grantLease: false });
    const host = new FakeHost();
    const runtimeReference: { current?: CreatorWorkerRuntime } = {};
    let reentrantStart: Promise<unknown> | undefined;
    let reentrantStop: Promise<void> | undefined;
    const runtime = trackedRuntime({
      ...runtimeOptions(root, broker.url, host, 'CREATE_FRESH'),
      diagnosticSink(event) {
        const current = runtimeReference.current;
        if (current === undefined) throw new Error('Runtime reference is unavailable.');
        if (event === 'starting') reentrantStart = current.start();
        if (event === 'stopping') reentrantStop = current.stop();
      },
    });
    runtimeReference.current = runtime;

    const starting = runtime.start();
    expect(reentrantStart).toBe(starting);
    void starting.catch(() => undefined);
    await eventually(() => host.startLifecycleCalls === 1 && broker.connections >= 1);
    const stopping = runtime.stop();
    expect(reentrantStop).toBe(stopping);
    expect(runtime.stop()).toBe(stopping);
    await expect(stopping).resolves.toBeUndefined();
    await expect(starting).rejects.toMatchObject({ code: 'RUNTIME_STOPPED' });
    expect(runtime.status).toBe('STOPPED');
    expect(host.stopCalls).toBe(1);
  });

  it('hands a stop-time UNCERTAIN terminal off on the next existing-store startup', async () => {
    const root = temporaryRoot();
    const broker = await BrokerHarness.listen();
    const firstHost = new FakeHost();
    const first = trackedRuntime(runtimeOptions(root, broker.url, firstHost, 'CREATE_FRESH'));
    await first.start();
    broker.sendCommand('invocation.prepare', { invocationId: 'invocation.r2e' }, 'command.prepare');
    broker.sendCommand(
      'invocation.start',
      {
        invocationId: 'invocation.r2e',
        attemptId: 'attempt.r2e',
        inputRef: 'input.r2e',
        inputFingerprint: INPUT_FINGERPRINT,
      },
      'command.start',
    );
    await eventually(
      () =>
        firstHost.controllers.length === 1 &&
        broker.workerMessages.some(
          ({ frame }) =>
            frame.body.type === 'worker.message' && frame.body.messageType === 'worker.started',
        ),
    );

    await first.stop();
    const messagesBeforeRestart = broker.workerMessages.length;
    const secondHost = new FakeHost();
    const second = trackedRuntime(runtimeOptions(root, broker.url, secondHost, 'OPEN_EXISTING'));
    await second.start();
    await eventually(() =>
      broker.workerMessages
        .slice(messagesBeforeRestart)
        .some(
          ({ frame }) =>
            frame.body.type === 'worker.message' && frame.body.messageType === 'worker.terminal',
        ),
    );
    expect(secondHost.startCalls).toBe(0);
    await second.stop();

    const journal = openExistingWorkerSqliteStore(journalOptionsFor(root));
    const owner = journal.acquireOwner().owner;
    expect(journal.readInvocation(owner, 'invocation.r2e')).toMatchObject({
      phase: 'TERMINAL_READY',
      state: { terminal: { outcome: 'UNCERTAIN' } },
    });
    expect(journal.readPendingFacts(owner)).toEqual([]);
    journal.close(owner);
  });

  it('automatically blocks and releases both stores after a durable unsupported command', async () => {
    const root = temporaryRoot();
    const broker = await BrokerHarness.listen();
    const host = new FakeHost();
    const runtime = trackedRuntime(runtimeOptions(root, broker.url, host, 'CREATE_FRESH'));
    await runtime.start();

    broker.sendCommand('invocation.unsupported', {}, 'command.unsupported');
    await eventually(() => runtime.status === 'BLOCKED' && host.stopCalls === 1);
    expect(runtime.failure).toMatchObject({ code: 'RUNTIME_BLOCKED' });
    await expect(runtime.start()).rejects.toMatchObject({ code: 'RUNTIME_BLOCKED' });
    await expect(runtime.stop()).rejects.toMatchObject({ code: 'RUNTIME_BLOCKED' });

    const journal = openExistingWorkerSqliteStore(journalOptionsFor(root));
    const journalOwner = journal.acquireOwner().owner;
    journal.close(journalOwner);
    const transport = openExistingWorkerDurableTransportRepository(transportOptionsFor(root));
    const transportOwner = transport.acquireOwner();
    expect(transport.readPendingCommands(transportOwner)).toMatchObject([
      { deliveryMessageId: 'command.unsupported', state: 'PENDING' },
    ]);
    transport.close(transportOwner);
  });

  it('reports a startup pump failure as BLOCKED instead of disguising it as a stop', async () => {
    const root = temporaryRoot();
    seedUnsupportedCommand(root);
    const broker = await BrokerHarness.listen({ grantLease: false });
    const host = new FakeHost();
    const runtime = trackedRuntime(runtimeOptions(root, broker.url, host, 'OPEN_EXISTING'));

    await expect(runtime.start()).rejects.toMatchObject({ code: 'RUNTIME_BLOCKED' });
    expect(runtime.status).toBe('BLOCKED');
    expect(runtime.failure).toMatchObject({ code: 'RUNTIME_BLOCKED' });
    await eventually(() => host.stopCalls === 1);
  });

  it('compensates a late Host start even when the first stop attempt fails', async () => {
    const root = temporaryRoot();
    const host = new LateStartingHost();
    const runtime = trackedRuntime({
      ...runtimeOptions(root, 'ws://127.0.0.1:1/v1/worker/connect', host, 'CREATE_FRESH'),
      hostLifecycleTimeoutMs: 20,
    });

    await expect(runtime.start()).rejects.toMatchObject({ code: 'RUNTIME_START_FAILED' });
    expect(runtime.status).toBe('BLOCKED');
    expect(host.stopCalls).toBe(1);
    expect(host.active).toBe(false);

    host.finishStart();
    await eventually(() => host.stopCalls === 2 && !host.active);
  });

  it('rejects a journal/transport sidecar alias before creating files or starting Host', () => {
    const root = temporaryRoot();
    const host = new FakeHost();
    const options = runtimeOptions(
      root,
      'ws://127.0.0.1:1/v1/worker/connect',
      host,
      'CREATE_FRESH',
    );
    expect(() =>
      createCreatorWorkerRuntime({
        ...options,
        transport: { ...options.transport, filename: `${options.journal.filename}-wal` },
      }),
    ).toThrow(expect.objectContaining({ code: 'RUNTIME_STORAGE_PATH_CONFLICT' }));
    expect(host.startLifecycleCalls).toBe(0);
  });
});

class BrokerHarness {
  public readonly workerMessages: BrokerTransportFrameMaterialization[] = [];
  public connections = 0;
  public failure?: Error;
  #session?: BrokerSession;

  private constructor(
    public readonly url: string,
    private readonly server: WebSocketServer,
    private readonly grantLease: boolean,
  ) {}

  public static async listen(
    options: Readonly<{ grantLease?: boolean }> = {},
  ): Promise<BrokerHarness> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
    await new Promise<void>((resolveListen) => server.once('listening', resolveListen));
    const address = server.address();
    if (typeof address === 'string' || address === null) throw new Error('Broker did not listen.');
    const broker = new BrokerHarness(
      `ws://127.0.0.1:${address.port}/v1/worker/connect`,
      server,
      options.grantLease ?? true,
    );
    server.on('connection', (socket) => broker.accept(socket));
    brokers.push(broker);
    return broker;
  }

  public sendCommand(
    commandType: string,
    payload: BrokerTransportPayload,
    messageId: string,
  ): void {
    const session = this.requiredSession();
    session.inboundSequence += 1;
    session.socket.send(
      createBrokerTransportFrame({
        ...session.authority,
        direction: 'CLOUD_TO_WORKER',
        sequence: session.inboundSequence,
        messageId,
        body: { type: 'command', commandType, payload },
      }).canonicalText,
    );
  }

  public async close(): Promise<void> {
    for (const client of this.server.clients) client.terminate();
    await new Promise<void>((resolveClose) => this.server.close(() => resolveClose()));
  }

  private accept(socket: WebSocket): void {
    const fence = ++this.connections;
    const authority = Object.freeze({
      connectionId: `connection.r2e.${fence}`,
      installationId: INSTALLATION,
      deploymentId: 'deployment.r2e',
      workerSessionId: `session.r2e.${fence}`,
      leaseId: `lease.r2e.${fence}`,
      fence,
    });
    const session: BrokerSession = { socket, authority, inboundSequence: 0 };
    this.#session = session;
    socket.on('message', (raw, isBinary) => this.receive(session, raw, isBinary));
    if (this.grantLease) {
      socket.send(
        createBrokerTransportFrame({
          ...authority,
          direction: 'CLOUD_TO_WORKER',
          sequence: 0,
          messageId: `grant.r2e.${fence}`,
          body: { type: 'lease.grant', leaseExpiresAtMs: Date.now() + 60_000 },
        }).canonicalText,
      );
    }
  }

  private receive(session: BrokerSession, raw: RawData, isBinary: boolean): void {
    try {
      if (isBinary) throw new Error('Worker sent a binary frame.');
      const message = parseBrokerTransportFrame(raw.toString());
      if (message.frame.body.type !== 'worker.message') return;
      this.workerMessages.push(message);
      session.inboundSequence += 1;
      session.socket.send(
        createBrokerTransportFrame({
          ...session.authority,
          direction: 'CLOUD_TO_WORKER',
          sequence: session.inboundSequence,
          messageId: `cloud-ack.r2e.${session.authority.fence}.${session.inboundSequence}`,
          body: {
            type: 'message.ack',
            acknowledgedMessageId: message.frame.messageId,
            acknowledgedSemanticFingerprint: message.frame.semanticFingerprint,
            acknowledgedWireFingerprint: message.wireFingerprint,
            level: 'CLOUD_COMMITTED',
            decision: 'APPLIED',
          },
        }).canonicalText,
      );
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error('Broker callback failed.');
      session.socket.terminate();
    }
  }

  private requiredSession(): BrokerSession {
    if (this.failure !== undefined) throw this.failure;
    if (this.#session === undefined || this.#session.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Broker session is unavailable.');
    }
    return this.#session;
  }
}

type BrokerSession = {
  readonly socket: WebSocket;
  readonly authority: Readonly<{
    connectionId: string;
    installationId: string;
    deploymentId: string;
    workerSessionId: string;
    leaseId: string;
    fence: number;
  }>;
  inboundSequence: number;
};

class LateStartingHost extends FakeHost {
  public active = false;
  #finishStart?: () => void;

  public override start(): Promise<void> {
    this.startLifecycleCalls += 1;
    return new Promise<void>((resolveStart) => {
      this.#finishStart = () => {
        this.active = true;
        resolveStart();
      };
    });
  }

  public override async stop(): Promise<void> {
    this.stopCalls += 1;
    if (this.stopCalls === 1) throw new Error('first Host stop failed');
    this.active = false;
  }

  public finishStart(): void {
    if (this.#finishStart === undefined) throw new Error('Host start is not pending.');
    this.#finishStart();
  }
}

function runtimeOptions(
  root: string,
  url: string,
  host: FakeHost,
  storageMode: CreatorWorkerRuntimeStorageMode,
  onFrameCommitted?: () => void,
): CreatorWorkerRuntimeOptions<{ ciphertext: string }> {
  return {
    storageMode,
    journal: journalOptionsFor(root),
    transport: transportOptionsFor(root),
    broker: {
      url,
      allowInsecureLoopbackForTests: true,
      connectTimeoutMs: 200,
      firstLeaseTimeoutMs: 1_000,
      reconnectInitialMs: 10,
      reconnectMaximumMs: 20,
      sendTimeoutMs: 200,
      stopTimeoutMs: 500,
      diagnosticSink(event) {
        if (event === 'frame_committed') onFrameCommitted?.();
      },
    },
    host,
    resolveStartInput: async (inputRef) => {
      if (inputRef !== 'input.r2e') throw new Error('Input reference is unavailable.');
      return {
        input: {
          thread: await host.createThread(),
          messageId: 'message.r2e',
          text: PROMPT_CANARY,
          timeoutMs: 10_000,
        },
        inputFingerprint: INPUT_FINGERPRINT,
      };
    },
    sealResult: async () => ({
      sealedResultId: 'sealed.r2e',
      sealedFingerprint: SEALED_FINGERPRINT,
      envelope: { ciphertext: 'opaque.r2e' },
    }),
    tickIntervalMs: 20,
    readyTimeoutMs: 2_000,
    hostLifecycleTimeoutMs: 500,
  };
}

function journalOptionsFor(root: string): WorkerSqliteStoreOptions {
  return { filename: join(root, 'journal.sqlite'), storeIdentity: 'journal.r2e' };
}

function transportOptionsFor(root: string): WorkerTransportStoreOptions {
  return {
    filename: join(root, 'transport.sqlite'),
    storeIdentity: 'transport.r2e',
    installationId: INSTALLATION,
  };
}

function seedUnsupportedCommand(root: string): void {
  const journal = createFreshWorkerSqliteStore(journalOptionsFor(root));
  journal.close();
  const transport = createFreshWorkerDurableTransportRepository(transportOptionsFor(root));
  const owner = transport.acquireOwner();
  const authority = {
    connectionId: 'connection.seed',
    installationId: INSTALLATION,
    deploymentId: 'deployment.r2e',
    workerSessionId: 'session.seed',
    leaseId: 'lease.seed',
    fence: 1,
  } as const;
  const connection = transport.activateLease(
    owner,
    createBrokerTransportFrame({
      ...authority,
      direction: 'CLOUD_TO_WORKER',
      sequence: 0,
      messageId: 'grant.seed',
      body: { type: 'lease.grant', leaseExpiresAtMs: Date.now() + 60_000 },
    }),
  );
  transport.commitInbound(
    owner,
    connection,
    createBrokerTransportFrame({
      ...authority,
      direction: 'CLOUD_TO_WORKER',
      sequence: 1,
      messageId: 'command.seed.unsupported',
      body: { type: 'command', commandType: 'invocation.unsupported', payload: {} },
    }),
  );
  transport.close(owner);
}

function trackedRuntime(options: CreatorWorkerRuntimeOptions<{ ciphertext: string }>) {
  const runtime = createCreatorWorkerRuntime(options);
  runtimes.push(runtime);
  return runtime;
}

function settleHostSuccess(host: FakeHost): void {
  const controller = host.controllers[0];
  if (controller === undefined) throw new Error('Host controller is unavailable.');
  controller.settle(
    {
      thread: controller.handle.thread,
      turnId: controller.handle.turnId,
      completedAt: Date.now(),
      terminalStatus: 'completed',
      terminalError: 'NONE',
      outputState: 'USABLE',
    },
    { text: RESULT_CANARY },
  );
}

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'combo-r2e-runtime-')));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

async function eventually(assertion: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!assertion()) {
    for (const broker of brokers) if (broker.failure !== undefined) throw broker.failure;
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Runtime state.');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
}
