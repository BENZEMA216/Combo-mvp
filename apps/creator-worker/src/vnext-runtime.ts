import { randomBytes } from 'node:crypto';

import {
  HostTurnRegistry,
  SqliteWorkerBrokerDurableTransport,
  WorkerBrokerClient,
  WorkerCommandPump,
  createHostDispatchPort,
  createHostDispatchReceiptAuthority,
  createHostInterruptPort,
  createHostInterruptReceiptAuthority,
  type CodexHostLike,
  type LocalResultAeadSealerPort,
  type SqliteWorkerInvocationJournalOptions,
  type SqliteWorkerTransportOptions,
  type WorkerBrokerClientOptions,
  type WorkerBrokerResultKeyPort,
  type WorkerCloudAckEvidencePort,
  type WorkerCommandPumpDiagnostic,
  type WorkerCommandPumpTickResult,
  type WorkerConversationRuntimePort,
  type WorkerProcessStartRecovery,
} from '@cb/creator-worker-broker-client';

import type { CodexHost } from './host-types.js';

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const DEFAULT_FINAL_DRAIN_ROUNDS = 8;

export type VnextCreatorWorkerRuntimeStatus =
  | 'IDLE'
  | 'STARTING'
  | 'RECONCILING'
  | 'READY'
  | 'DRAINING'
  | 'BLOCKED'
  | 'STOPPED';

export type VnextCreatorWorkerRuntimeDiagnostic =
  | Readonly<{ type: 'status'; status: VnextCreatorWorkerRuntimeStatus }>
  | Readonly<{ type: 'process_recovery'; recovery: WorkerProcessStartRecovery }>
  | Readonly<{ type: 'pump'; result: WorkerCommandPumpTickResult }>
  | Readonly<{ type: 'blocked'; phase: 'START' | 'PUMP' | 'DRAIN' | 'STOP' }>;

export type VnextCreatorWorkerRuntimeErrorCode =
  | 'ALREADY_STOPPED'
  | 'INSTALLATION_OWNERSHIP_REJECTED'
  | 'START_FAILED'
  | 'RUNTIME_BLOCKED'
  | 'DRAIN_TIMEOUT'
  | 'DRAIN_INCOMPLETE'
  | 'DRAIN_FAILED'
  | 'STOP_FAILED';

export class VnextCreatorWorkerRuntimeError extends Error {
  constructor(readonly code: VnextCreatorWorkerRuntimeErrorCode) {
    super(code);
    this.name = 'VnextCreatorWorkerRuntimeError';
  }
}

export interface VnextRuntimeTransportPort {
  acquireInstallation(input: {
    installationId: string;
    ownerToken: string;
    signal: AbortSignal;
  }): Promise<boolean>;
  releaseInstallation(input: {
    installationId: string;
    ownerToken: string;
    signal: AbortSignal;
  }): Promise<void>;
  close(): void;
}

export interface VnextRuntimeBrokerPort {
  readonly connected: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface VnextRuntimePumpPort {
  readonly activeTerminalObservers: number;
  recoverAfterProcessStart(signal: AbortSignal): Promise<WorkerProcessStartRecovery>;
  tick(signal: AbortSignal): Promise<WorkerCommandPumpTickResult>;
  drainEvidence(signal: AbortSignal): Promise<WorkerCommandPumpTickResult>;
  waitForTerminalObservers(): Promise<void>;
}

export type VnextCreatorWorkerRuntimeOptions = Readonly<{
  installationId: string;
  ownerToken: string;
  host: CodexHost;
  transport: VnextRuntimeTransportPort;
  broker: VnextRuntimeBrokerPort;
  pump: VnextRuntimePumpPort;
  registry: HostTurnRegistry;
  pollIntervalMs?: number;
  drainTimeoutMs?: number;
  finalDrainRounds?: number;
  diagnosticSink?: (event: VnextCreatorWorkerRuntimeDiagnostic) => void;
}>;

/**
 * Executable R2 lifecycle root. It owns exactly one process owner capability, runs process-start
 * recovery once before any Host/Broker command, and keeps reconnects inside the same pump/registry
 * generation. It does not contain Test crypto or production-secret fallbacks.
 */
export class VnextCreatorWorkerRuntime {
  readonly #installationId: string;
  readonly #ownerToken: string;
  readonly #host: CodexHost;
  readonly #transport: VnextRuntimeTransportPort;
  readonly #broker: VnextRuntimeBrokerPort;
  readonly #pump: VnextRuntimePumpPort;
  readonly #registry: HostTurnRegistry;
  readonly #pollIntervalMs: number;
  readonly #drainTimeoutMs: number;
  readonly #finalDrainRounds: number;
  readonly #diagnosticSink?: (event: VnextCreatorWorkerRuntimeDiagnostic) => void;
  readonly #lifecycle = new AbortController();
  readonly #wakeWaiters = new Set<() => void>();

  #status: VnextCreatorWorkerRuntimeStatus = 'IDLE';
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #runPromise: Promise<void> | undefined;
  #ownershipAcquired = false;
  #hostStarted = false;
  #brokerStarted = false;
  #processReattachBlocked = false;

  constructor(options: VnextCreatorWorkerRuntimeOptions) {
    this.#installationId = options.installationId;
    this.#ownerToken = options.ownerToken;
    this.#host = options.host;
    this.#transport = options.transport;
    this.#broker = options.broker;
    this.#pump = options.pump;
    this.#registry = options.registry;
    this.#diagnosticSink = options.diagnosticSink;
    this.#pollIntervalMs = bounded(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, 10, 10_000);
    this.#drainTimeoutMs = bounded(options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS, 50, 300_000);
    this.#finalDrainRounds = bounded(options.finalDrainRounds ?? DEFAULT_FINAL_DRAIN_ROUNDS, 1, 64);
  }

  get status(): VnextCreatorWorkerRuntimeStatus {
    return this.#status;
  }

  start(): Promise<void> {
    if (this.#status === 'STOPPED') {
      return Promise.reject(new VnextCreatorWorkerRuntimeError('ALREADY_STOPPED'));
    }
    if (this.#startPromise !== undefined) return this.#startPromise;
    if (this.#status !== 'IDLE') return Promise.resolve();
    const start = this.#startOnce();
    this.#startPromise = start;
    void start.then(
      () => undefined,
      () => undefined,
    );
    return start;
  }

  wake(): void {
    for (const resolve of this.#wakeWaiters) resolve();
    this.#wakeWaiters.clear();
  }

  async waitUntilReady(signal: AbortSignal): Promise<void> {
    while (this.#status !== 'READY') {
      signal.throwIfAborted();
      if (this.#status === 'BLOCKED' || this.#status === 'STOPPED') {
        throw new VnextCreatorWorkerRuntimeError('RUNTIME_BLOCKED');
      }
      await this.#waitForWake(signal, this.#pollIntervalMs);
    }
  }

  stop(): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    const stop = this.#stopOnce();
    this.#stopPromise = stop;
    void stop.catch(() => {
      if (this.#stopPromise === stop) this.#stopPromise = undefined;
    });
    return stop;
  }

  async #startOnce(): Promise<void> {
    this.#setStatus('STARTING');
    const signal = this.#lifecycle.signal;
    try {
      this.#ownershipAcquired = await this.#transport.acquireInstallation({
        installationId: this.#installationId,
        ownerToken: this.#ownerToken,
        signal,
      });
      if (!this.#ownershipAcquired) {
        throw new VnextCreatorWorkerRuntimeError('INSTALLATION_OWNERSHIP_REJECTED');
      }
      const recovery = await this.#pump.recoverAfterProcessStart(signal);
      this.#processReattachBlocked = recovery.readyConversationsNeedingReattach > 0;
      this.#diagnostic({ type: 'process_recovery', recovery });

      await this.#host.start();
      this.#hostStarted = true;
      await this.#broker.start();
      this.#brokerStarted = true;
      this.#setStatus(this.#processReattachBlocked ? 'BLOCKED' : 'RECONCILING');
      const run = this.#runLoop();
      this.#runPromise = run;
      void run.catch(() => undefined);
    } catch (error) {
      this.#setStatus('BLOCKED');
      this.#diagnostic({ type: 'blocked', phase: 'START' });
      await this.#cleanupAfterFailedStart();
      if (error instanceof VnextCreatorWorkerRuntimeError) throw error;
      throw new VnextCreatorWorkerRuntimeError('START_FAILED');
    }
  }

  async #runLoop(): Promise<void> {
    const signal = this.#lifecycle.signal;
    while (!signal.aborted) {
      let result: WorkerCommandPumpTickResult;
      try {
        result = await this.#pump.tick(signal);
      } catch {
        if (signal.aborted) return;
        this.#setStatus('BLOCKED');
        this.#diagnostic({ type: 'blocked', phase: 'PUMP' });
        await this.#waitForWake(signal, this.#pollIntervalMs).catch(() => undefined);
        continue;
      }
      this.#diagnostic({ type: 'pump', result });
      if (this.#processReattachBlocked || result.status === 'BLOCKED') {
        this.#setStatus('BLOCKED');
      } else if (this.#broker.connected && result.status === 'IDLE') {
        this.#setStatus('READY');
      } else {
        this.#setStatus('RECONCILING');
      }
      if (result.status !== 'PROGRESSED') {
        await this.#waitForWake(signal, this.#pollIntervalMs).catch(() => undefined);
      }
    }
  }

  async #stopOnce(): Promise<void> {
    if (this.#status === 'STOPPED') return;
    this.#setStatus('DRAINING');
    this.#lifecycle.abort(new VnextCreatorWorkerRuntimeError('ALREADY_STOPPED'));
    this.wake();
    await this.#runPromise?.catch(() => undefined);

    try {
      await withTimeout(this.#pump.waitForTerminalObservers(), this.#drainTimeoutMs);
      await this.#drainTerminalEvidence();
    } catch (error) {
      this.#setStatus('BLOCKED');
      this.#diagnostic({ type: 'blocked', phase: 'DRAIN' });
      if (
        error instanceof VnextCreatorWorkerRuntimeError &&
        (error.code === 'DRAIN_TIMEOUT' || error.code === 'DRAIN_INCOMPLETE')
      ) {
        throw error;
      }
      throw new VnextCreatorWorkerRuntimeError('DRAIN_FAILED');
    }

    try {
      if (this.#brokerStarted) {
        await this.#broker.stop();
        this.#brokerStarted = false;
        this.#ownershipAcquired = false;
      } else if (this.#ownershipAcquired) {
        await this.#transport.releaseInstallation({
          installationId: this.#installationId,
          ownerToken: this.#ownerToken,
          signal: new AbortController().signal,
        });
        this.#ownershipAcquired = false;
      }
      if (this.#hostStarted) {
        await this.#host.stop();
        this.#hostStarted = false;
      }
      this.#registry.clear();
      this.#transport.close();
      this.#setStatus('STOPPED');
    } catch {
      this.#setStatus('BLOCKED');
      this.#diagnostic({ type: 'blocked', phase: 'STOP' });
      throw new VnextCreatorWorkerRuntimeError('STOP_FAILED');
    }
  }

  async #drainTerminalEvidence(): Promise<void> {
    const signal = new AbortController().signal;
    for (let round = 0; round < this.#finalDrainRounds; round += 1) {
      const result = await this.#pump.drainEvidence(signal);
      if (result.status !== 'PROGRESSED') return;
    }
    throw new VnextCreatorWorkerRuntimeError('DRAIN_INCOMPLETE');
  }

  async #cleanupAfterFailedStart(): Promise<void> {
    if (this.#brokerStarted) {
      await this.#broker.stop().catch(() => undefined);
      this.#brokerStarted = false;
      this.#ownershipAcquired = false;
    } else if (this.#ownershipAcquired) {
      await this.#transport
        .releaseInstallation({
          installationId: this.#installationId,
          ownerToken: this.#ownerToken,
          signal: new AbortController().signal,
        })
        .catch(() => undefined);
      this.#ownershipAcquired = false;
    }
    if (this.#hostStarted) {
      await this.#host.stop().catch(() => undefined);
      this.#hostStarted = false;
    }
  }

  #setStatus(status: VnextCreatorWorkerRuntimeStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#diagnostic({ type: 'status', status });
    this.wake();
  }

  #diagnostic(event: VnextCreatorWorkerRuntimeDiagnostic): void {
    try {
      this.#diagnosticSink?.(Object.freeze(event));
    } catch {
      // Diagnostics cannot become a lifecycle authority.
    }
  }

  #waitForWake(signal: AbortSignal, timeoutMs: number): Promise<void> {
    signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', aborted);
        this.#wakeWaiters.delete(woken);
        if (error === undefined) resolve();
        else reject(error);
      };
      const woken = (): void => finish();
      const aborted = (): void => finish(signal.reason ?? new Error('aborted'));
      const timer = setTimeout(woken, timeoutMs);
      this.#wakeWaiters.add(woken);
      signal.addEventListener('abort', aborted, { once: true });
    });
  }
}

export type CreateVnextCreatorWorkerRuntimeOptions = Readonly<{
  installationId: string;
  host: CodexHost;
  transport: SqliteWorkerTransportOptions;
  broker: Omit<
    WorkerBrokerClientOptions,
    'installationId' | 'ownerToken' | 'durablePort' | 'diagnosticSink'
  > &
    Readonly<{
      diagnosticSink?: WorkerBrokerClientOptions['diagnosticSink'];
    }>;
  journal: Omit<
    SqliteWorkerInvocationJournalOptions,
    | 'hostDispatchPort'
    | 'hostDispatchReceiptAuthority'
    | 'hostInterruptPort'
    | 'hostInterruptReceiptAuthority'
  >;
  conversationRuntime: WorkerConversationRuntimePort;
  resultSealer: LocalResultAeadSealerPort;
  resultKey: WorkerBrokerResultKeyPort;
  cloudAckEvidence: WorkerCloudAckEvidencePort;
  sandboxAttestationDigest(
    input: Readonly<{
      sandboxInstanceId: string;
      runtimeThreadId: string;
      runtimeTurnId: string;
      hostGeneration: number;
    }>,
  ): string;
  ownerTokenFactory?: () => string;
  pollIntervalMs?: number;
  drainTimeoutMs?: number;
  finalDrainRounds?: number;
  pumpDiagnosticSink?: (event: WorkerCommandPumpDiagnostic) => void;
  diagnosticSink?: (event: VnextCreatorWorkerRuntimeDiagnostic) => void;
}>;

/** Builds the real SQLite + Broker + Host R2 graph while keeping all crypto authorities explicit. */
export function createVnextCreatorWorkerRuntime(
  options: CreateVnextCreatorWorkerRuntimeOptions,
): VnextCreatorWorkerRuntime {
  const ownerToken = (options.ownerTokenFactory ?? defaultOwnerToken)();
  const transport = new SqliteWorkerBrokerDurableTransport(options.transport);
  const registry = new HostTurnRegistry();
  const hostContract: CodexHostLike = options.host;
  const journal = transport.createInvocationJournal({
    ...options.journal,
    hostDispatchPort: createHostDispatchPort({ registry, host: hostContract }),
    hostDispatchReceiptAuthority: createHostDispatchReceiptAuthority({
      registry,
      sandboxAttestationDigest: options.sandboxAttestationDigest,
    }),
    hostInterruptPort: createHostInterruptPort(registry),
    hostInterruptReceiptAuthority: createHostInterruptReceiptAuthority(),
  });
  const broker = new WorkerBrokerClient({
    ...options.broker,
    installationId: options.installationId,
    ownerToken,
    durablePort: transport,
  });
  const runtimeReference: { current?: VnextCreatorWorkerRuntime } = {};
  const pump = new WorkerCommandPump({
    installationId: options.installationId,
    ownerToken,
    transport,
    journal,
    broker,
    registry,
    conversationRuntime: options.conversationRuntime,
    resultSealer: options.resultSealer,
    resultKey: options.resultKey,
    cloudAckEvidence: options.cloudAckEvidence,
    diagnosticSink: options.pumpDiagnosticSink,
    terminalWake: () => runtimeReference.current?.wake(),
  });
  const runtime = new VnextCreatorWorkerRuntime({
    installationId: options.installationId,
    ownerToken,
    host: options.host,
    transport,
    broker,
    pump,
    registry,
    pollIntervalMs: options.pollIntervalMs,
    drainTimeoutMs: options.drainTimeoutMs,
    finalDrainRounds: options.finalDrainRounds,
    diagnosticSink: options.diagnosticSink,
  });
  runtimeReference.current = runtime;
  return runtime;
}

function defaultOwnerToken(): string {
  return randomBytes(32).toString('base64url');
}

function bounded(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError('VNext Creator Worker runtime option is invalid.');
  }
  return value;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new VnextCreatorWorkerRuntimeError('DRAIN_TIMEOUT')),
      timeoutMs,
    );
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
