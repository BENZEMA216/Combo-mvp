import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import type { CreatorHost, HostStartTurnInput } from '@cb/creator-agent-protocol/host';
import {
  createFreshWorkerSqliteStore,
  openExistingWorkerSqliteStore,
  type WorkerSqliteOwner,
  type WorkerSqliteStore,
  type WorkerSqliteStoreOptions,
} from '@cb/creator-agent-broker-journal/sqlite-store';
import {
  createFreshWorkerDurableTransportRepository,
  openExistingWorkerDurableTransportRepository,
  type WorkerDurableTransportRepository,
  type WorkerTransportOwner,
  type WorkerTransportStoreOptions,
} from '@cb/creator-worker-broker-client/sqlite-repository';
import {
  createWorkerBrokerWebSocketDriver,
  type WorkerBrokerWebSocketDriver,
} from '@cb/creator-worker-broker-client/websocket-driver';

import { createWorkerSerialPump } from './worker-serial-pump.js';
import type { WorkerSerialPump, WorkerSerialPumpTickResult } from './pump-contract.js';
import {
  CreatorWorkerRuntimeError,
  type CreatorWorkerBrokerOptions,
  type CreatorWorkerRuntime,
  type CreatorWorkerRuntimeDiagnostic,
  type CreatorWorkerRuntimeOptions,
  type CreatorWorkerRuntimeStartResult,
  type CreatorWorkerRuntimeState,
  type CreatorWorkerRuntimeStorageMode,
} from './runtime-contract.js';

const DEFAULT_TICK_INTERVAL_MS = 100;
const DEFAULT_HOST_LIFECYCLE_TIMEOUT_MS = 30_000;
const JOURNAL_OWNER_HEARTBEAT_MS = 5_000;
const TEARDOWN_QUIESCE_GRACE_MS = 35_000;

type CheckedOptions<TEnvelope extends object> = Readonly<{
  storageMode: CreatorWorkerRuntimeStorageMode;
  journal: WorkerSqliteStoreOptions;
  transport: WorkerTransportStoreOptions;
  broker: CreatorWorkerBrokerOptions;
  host: CreatorHost;
  resolveStartInput: CreatorWorkerRuntimeOptions<TEnvelope>['resolveStartInput'];
  sealResult: CreatorWorkerRuntimeOptions<TEnvelope>['sealResult'];
  tickIntervalMs: number;
  readyTimeoutMs: number | undefined;
  hostLifecycleTimeoutMs: number;
  diagnosticSink: CreatorWorkerRuntimeOptions<TEnvelope>['diagnosticSink'];
}>;

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  readonly settled: boolean;
}>;

export function createCreatorWorkerRuntime<TEnvelope extends object>(
  options: CreatorWorkerRuntimeOptions<TEnvelope>,
): CreatorWorkerRuntime {
  return new Runtime(snapshotOptions(options));
}

class Runtime<TEnvelope extends object> implements CreatorWorkerRuntime {
  readonly #lifecycle = new AbortController();
  readonly #journalHeartbeat = new AbortController();
  readonly #firstTick = deferred<WorkerSerialPumpTickResult>();
  readonly #failureSignal = deferred<never>();

  #state: CreatorWorkerRuntimeState = 'IDLE';
  #failure: CreatorWorkerRuntimeError | null = null;
  #startTask?: Promise<CreatorWorkerRuntimeStartResult>;
  #stoppedStartTask?: Promise<CreatorWorkerRuntimeStartResult>;
  #blockedStartTask?: Promise<CreatorWorkerRuntimeStartResult>;
  #stopTask?: Promise<void>;
  #teardownTask?: Promise<void>;
  #schedulerTask?: Promise<void>;
  #heartbeatTask?: Promise<void>;
  #teardownOwnerLeaseMs?: number;
  #hostStartTask?: Promise<void>;
  #hostStartSettled = false;
  #journal?: WorkerSqliteStore;
  #journalOwner?: WorkerSqliteOwner;
  #transport?: WorkerDurableTransportRepository;
  #transportOwner?: WorkerTransportOwner;
  #driver?: WorkerBrokerWebSocketDriver;
  #pump?: WorkerSerialPump;

  public constructor(private readonly options: CheckedOptions<TEnvelope>) {
    void this.#failureSignal.promise.catch(() => undefined);
    void this.#firstTick.promise.catch(() => undefined);
  }

  public get status(): CreatorWorkerRuntimeState {
    return this.#state;
  }

  public get failure(): CreatorWorkerRuntimeError | null {
    return this.#failure;
  }

  public start(): Promise<CreatorWorkerRuntimeStartResult> {
    if (this.#state === 'STOPPING' || this.#state === 'STOPPED') {
      this.#stoppedStartTask ??= rejectedStart(runtimeStopped());
      return this.#stoppedStartTask;
    }
    if (this.#state === 'BLOCKED') {
      this.#blockedStartTask ??= rejectedStart(this.#failure ?? runtimeBlocked());
      return this.#blockedStartTask;
    }
    if (this.#startTask !== undefined) return this.#startTask;
    const claimed = deferred<CreatorWorkerRuntimeStartResult>();
    this.#startTask = claimed.promise;
    this.#state = 'STARTING';
    this.#diagnostic('starting');
    void this.#startOnce().then(claimed.resolve, claimed.reject);
    void this.#startTask.catch(() => undefined);
    return this.#startTask;
  }

  public stop(): Promise<void> {
    if (this.#stopTask !== undefined) return this.#stopTask;
    if (this.#state === 'STOPPED') {
      this.#stopTask = Promise.resolve();
      return this.#stopTask;
    }
    const claimed = deferred<void>();
    this.#stopTask = claimed.promise;
    const alreadyBlocked = this.#state === 'BLOCKED';
    if (!alreadyBlocked) {
      this.#state = 'STOPPING';
      this.#diagnostic('stopping');
    }
    this.#lifecycle.abort();
    this.#firstTick.reject(runtimeStopped());
    this.#failureSignal.reject(runtimeStopped());
    void this.#ensureTeardown()
      .then(
        () => {
          if (alreadyBlocked || this.#failure !== null) {
            this.#state = 'BLOCKED';
            throw this.#failure ?? runtimeBlocked();
          }
          this.#state = 'STOPPED';
          this.#diagnostic('stopped');
        },
        (error: unknown) => {
          const failure = new CreatorWorkerRuntimeError(
            'RUNTIME_STOP_INCOMPLETE',
            'Creator Worker Runtime did not stop completely.',
            { cause: error },
          );
          this.#failure ??= failure;
          this.#state = 'BLOCKED';
          throw failure;
        },
      )
      .then(claimed.resolve, claimed.reject);
    void this.#stopTask.catch(() => undefined);
    return this.#stopTask;
  }

  async #startOnce(): Promise<CreatorWorkerRuntimeStartResult> {
    try {
      this.#assertStarting();
      this.#journal = openJournal(this.options.storageMode, this.options.journal);
      this.#transport = openTransport(this.options.storageMode, this.options.transport);

      this.#hostStartTask = Promise.resolve()
        .then(() => this.options.host.start())
        .finally(() => {
          this.#hostStartSettled = true;
        });
      void this.#hostStartTask.catch(() => undefined);
      await raceLifecycle(
        this.#hostStartTask,
        this.#lifecycle.signal,
        this.options.hostLifecycleTimeoutMs,
        () =>
          new CreatorWorkerRuntimeError(
            'RUNTIME_START_FAILED',
            'Creator Host lifecycle start timed out.',
          ),
      );
      this.#assertStarting();
      this.#diagnostic('host_started');
      this.#assertStarting();

      const acquired = this.#journal.acquireOwner();
      this.#journalOwner = acquired.owner;
      this.#heartbeatTask = this.#runJournalHeartbeat();
      void this.#heartbeatTask.catch(() => undefined);
      this.#transportOwner = this.#transport.acquireOwner();
      this.#driver = createWorkerBrokerWebSocketDriver({
        ...this.options.broker,
        owner: this.#transportOwner,
        repository: this.#transport,
      });
      this.#pump = createWorkerSerialPump({
        journal: this.#journal,
        journalOwner: this.#journalOwner,
        preparedInvocations: acquired.prepared,
        transport: this.#transport,
        transportOwner: this.#transportOwner,
        host: this.options.host,
        driver: this.#driver,
        resolveStartInput: this.options.resolveStartInput,
        sealResult: this.options.sealResult,
      });

      this.#schedulerTask = this.#runScheduler();
      void this.#schedulerTask.catch(() => undefined);
      this.#diagnostic('scheduler_started');
      this.#assertStarting();
      const driverReady = Promise.resolve()
        .then(() => this.#requiredDriver().start())
        .then(() => this.#diagnostic('broker_ready'));
      void driverReady.catch(() => undefined);
      await this.#waitUntilReady(driverReady);
      this.#assertStarting();
      if (
        this.#requiredDriver().status === 'BLOCKED' ||
        this.#requiredPump().status === 'BLOCKED'
      ) {
        throw runtimeBlocked();
      }
      this.#state = 'READY';
      this.#diagnostic('ready');
      if (this.#state !== 'READY') throw runtimeStopped();
      return Object.freeze({
        recoveredInvocations: acquired.recovered.length,
        preparedInvocations: acquired.prepared.length,
      });
    } catch (error) {
      if (this.#state === 'STOPPING' || this.#state === 'STOPPED') {
        await this.#ensureTeardown().catch(() => undefined);
        throw runtimeStopped();
      }
      if (this.#state === 'BLOCKED') {
        const failure = this.#failure ?? normalizeBlockedFailure(error);
        await this.#ensureTeardown().catch(() => undefined);
        throw failure;
      }
      const failure = normalizeStartFailure(error);
      this.#block(failure);
      await this.#ensureTeardown().catch(() => undefined);
      throw failure;
    }
  }

  async #waitUntilReady(driverReady: Promise<void>): Promise<void> {
    const ready = Promise.all([driverReady, this.#firstTick.promise]).then(() => undefined);
    const candidates: Promise<void>[] = [ready, this.#failureSignal.promise];
    let timer: NodeJS.Timeout | undefined;
    if (this.options.readyTimeoutMs !== undefined) {
      candidates.push(
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new CreatorWorkerRuntimeError(
                  'RUNTIME_READY_TIMEOUT',
                  'Creator Worker Runtime did not become ready in time.',
                ),
              ),
            this.options.readyTimeoutMs,
          );
        }),
      );
    }
    const aborted = abortRejection(this.#lifecycle.signal);
    candidates.push(aborted.promise);
    try {
      await Promise.race(candidates);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      aborted.dispose();
    }
  }

  async #runScheduler(): Promise<void> {
    let delayMs = 0;
    try {
      while (!this.#lifecycle.signal.aborted) {
        if (delayMs >= 0) await abortableDelay(delayMs, this.#lifecycle.signal);
        if (this.#lifecycle.signal.aborted) return;
        const result = await this.#requiredPump().tick();
        this.#firstTick.resolve(result);
        delayMs =
          result.workMayRemain && result.flush === 'FLUSHED' ? 0 : this.options.tickIntervalMs;
      }
    } catch (error) {
      if (this.#lifecycle.signal.aborted) {
        this.#firstTick.reject(runtimeStopped());
        return;
      }
      this.#firstTick.reject(error);
      this.#block(error);
    }
  }

  async #runJournalHeartbeat(): Promise<void> {
    try {
      while (!this.#journalHeartbeat.signal.aborted) {
        await abortableDelay(JOURNAL_OWNER_HEARTBEAT_MS, this.#journalHeartbeat.signal);
        if (this.#journalHeartbeat.signal.aborted) return;
        const owner = this.#requiredJournalOwner();
        if (this.#teardownOwnerLeaseMs === undefined) this.#journal?.renewOwner(owner);
        else this.#journal?.renewOwner(owner, this.#teardownOwnerLeaseMs);
      }
    } catch (error) {
      if (this.#journalHeartbeat.signal.aborted) return;
      this.#block(error);
      throw error;
    }
  }

  #block(error: unknown): void {
    if (this.#state === 'STOPPING' || this.#state === 'STOPPED') return;
    this.#failure ??= normalizeBlockedFailure(error);
    this.#state = 'BLOCKED';
    this.#lifecycle.abort();
    this.#firstTick.reject(this.#failure);
    this.#failureSignal.reject(this.#failure);
    this.#diagnostic('blocked');
    void Promise.resolve()
      .then(() => this.#ensureTeardown())
      .catch(() => undefined);
  }

  #ensureTeardown(): Promise<void> {
    this.#teardownTask ??= this.#teardownOnce();
    return this.#teardownTask;
  }

  async #teardownOnce(): Promise<void> {
    this.#lifecycle.abort();
    const failures: unknown[] = [];
    this.#teardownOwnerLeaseMs = Math.min(
      300_000,
      this.options.hostLifecycleTimeoutMs * 2 + TEARDOWN_QUIESCE_GRACE_MS,
    );
    renewOwner(this.#journal, this.#journalOwner, this.#teardownOwnerLeaseMs, failures);
    renewOwner(this.#transport, this.#transportOwner, this.#teardownOwnerLeaseMs, failures);
    const driverStop = callAsync(() => this.#driver?.stop());
    const pumpStop = callAsync(() => this.#pump?.stop());
    const stopped = await Promise.allSettled([driverStop, pumpStop]);
    for (const result of stopped) if (result.status === 'rejected') failures.push(result.reason);
    if (this.#schedulerTask !== undefined) {
      try {
        await this.#schedulerTask;
      } catch (error) {
        failures.push(error);
      }
    }
    renewOwner(this.#journal, this.#journalOwner, this.#teardownOwnerLeaseMs, failures);
    renewOwner(this.#transport, this.#transportOwner, this.#teardownOwnerLeaseMs, failures);
    try {
      await this.#stopHost();
    } catch (error) {
      failures.push(error);
    }
    this.#journalHeartbeat.abort();
    if (this.#heartbeatTask !== undefined) {
      try {
        await this.#heartbeatTask;
      } catch (error) {
        failures.push(error);
      }
    }
    closeResource(this.#transport, this.#transportOwner, failures);
    closeResource(this.#journal, this.#journalOwner, failures);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Creator Worker Runtime teardown failed.');
    }
  }

  async #stopHost(): Promise<void> {
    const startTask = this.#hostStartTask;
    if (startTask === undefined) return;
    const startWasPending = !this.#hostStartSettled;
    const firstStop = settleWithin(
      Promise.resolve().then(() => this.options.host.stop()),
      this.options.hostLifecycleTimeoutMs,
      'Creator Host lifecycle stop timed out.',
    );
    const lateCompensation = startWasPending
      ? startTask.then(
          async () => {
            await firstStop.catch(() => undefined);
            await settleWithin(
              Promise.resolve().then(() => this.options.host.stop()),
              this.options.hostLifecycleTimeoutMs,
              'Creator Host compensating stop timed out.',
            );
          },
          () => undefined,
        )
      : undefined;
    void lateCompensation?.catch(() => undefined);
    await firstStop;
    if (!startWasPending) return;
    if (lateCompensation === undefined) throw new TypeError('Host compensation is unavailable.');
    try {
      await settleWithin(
        lateCompensation,
        this.options.hostLifecycleTimeoutMs,
        'Creator Host lifecycle start did not settle after stop.',
      );
    } catch (error) {
      if (this.#hostStartSettled && lateCompensation !== undefined) await lateCompensation;
      else throw error;
    }
  }

  #requiredPump(): WorkerSerialPump {
    if (this.#pump === undefined) throw new TypeError('Worker pump is unavailable.');
    return this.#pump;
  }

  #requiredDriver(): WorkerBrokerWebSocketDriver {
    if (this.#driver === undefined) throw new TypeError('Broker driver is unavailable.');
    return this.#driver;
  }

  #requiredJournalOwner(): WorkerSqliteOwner {
    if (this.#journalOwner === undefined) throw new TypeError('Journal owner is unavailable.');
    return this.#journalOwner;
  }

  #assertStarting(): void {
    if (this.#state !== 'STARTING' || this.#lifecycle.signal.aborted) throw runtimeStopped();
  }

  #diagnostic(event: CreatorWorkerRuntimeDiagnostic): void {
    try {
      this.options.diagnosticSink?.(event);
    } catch {
      // Diagnostics never become lifecycle authority.
    }
  }
}

function snapshotOptions<TEnvelope extends object>(
  input: CreatorWorkerRuntimeOptions<TEnvelope>,
): CheckedOptions<TEnvelope> {
  if (typeof input !== 'object' || input === null) invalid('Runtime options are required.');
  const storageMode = input.storageMode;
  const journalInput = input.journal;
  const transportInput = input.transport;
  const brokerInput = input.broker;
  const hostInput = input.host;
  const resolverInput = input.resolveStartInput;
  const sealerInput = input.sealResult;
  const tickIntervalInput = input.tickIntervalMs;
  const readyTimeoutInput = input.readyTimeoutMs;
  const hostLifecycleTimeoutInput = input.hostLifecycleTimeoutMs;
  const diagnosticInput = input.diagnosticSink;
  if (storageMode !== 'CREATE_FRESH' && storageMode !== 'OPEN_EXISTING') {
    invalid('Storage mode must be CREATE_FRESH or OPEN_EXISTING.');
  }
  const journal = Object.freeze({ ...requiredObject(journalInput, 'Journal options') });
  const transport = Object.freeze({ ...requiredObject(transportInput, 'Transport options') });
  const broker = Object.freeze({ ...requiredObject(brokerInput, 'Broker options') });
  const host = snapshotHost(hostInput);
  const resolveStartInput = requiredFunction(resolverInput, 'Start input resolver');
  const sealResult = requiredFunction(sealerInput, 'Result sealer');
  const diagnosticSink = optionalFunction(diagnosticInput, 'Runtime diagnostic sink');
  assertDistinctStoragePaths(journal.filename, transport.filename);
  return Object.freeze({
    storageMode,
    journal,
    transport,
    broker,
    host,
    resolveStartInput,
    sealResult,
    tickIntervalMs: bounded(
      tickIntervalInput ?? DEFAULT_TICK_INTERVAL_MS,
      20,
      10_000,
      'Tick interval',
    ),
    readyTimeoutMs:
      readyTimeoutInput === undefined
        ? undefined
        : bounded(readyTimeoutInput, 20, 300_000, 'Ready timeout'),
    hostLifecycleTimeoutMs: bounded(
      hostLifecycleTimeoutInput ?? DEFAULT_HOST_LIFECYCLE_TIMEOUT_MS,
      20,
      60_000,
      'Host lifecycle timeout',
    ),
    diagnosticSink,
  });
}

function snapshotHost(input: CreatorHost): CreatorHost {
  const host = requiredObject(input, 'Creator Host') as unknown as CreatorHost;
  const start = requiredFunction(host.start, 'Creator Host start');
  const stop = requiredFunction(host.stop, 'Creator Host stop');
  const createThread = requiredFunction(host.createThread, 'Creator Host createThread');
  const startTurn = requiredFunction(host.startTurn, 'Creator Host startTurn');
  return Object.freeze({
    start: () => Reflect.apply(start, host, []),
    stop: () => Reflect.apply(stop, host, []),
    createThread: () => Reflect.apply(createThread, host, []),
    startTurn: (turnInput: HostStartTurnInput) => Reflect.apply(startTurn, host, [turnInput]),
  });
}

function openJournal(
  mode: CreatorWorkerRuntimeStorageMode,
  options: WorkerSqliteStoreOptions,
): WorkerSqliteStore {
  return mode === 'CREATE_FRESH'
    ? createFreshWorkerSqliteStore(options)
    : openExistingWorkerSqliteStore(options);
}

function openTransport(
  mode: CreatorWorkerRuntimeStorageMode,
  options: WorkerTransportStoreOptions,
): WorkerDurableTransportRepository {
  return mode === 'CREATE_FRESH'
    ? createFreshWorkerDurableTransportRepository(options)
    : openExistingWorkerDurableTransportRepository(options);
}

function assertDistinctStoragePaths(journal: unknown, transport: unknown): void {
  if (typeof journal !== 'string' || typeof transport !== 'string') {
    invalid('Both SQLite filenames must be strings.');
  }
  let journalBase: string;
  let transportBase: string;
  try {
    journalBase = canonicalStorageBase(journal);
    transportBase = canonicalStorageBase(transport);
  } catch (error) {
    throw new CreatorWorkerRuntimeError(
      'RUNTIME_CONFIGURATION_INVALID',
      'SQLite parent directories must already exist.',
      { cause: error },
    );
  }
  const journalPaths = storagePathSet(journalBase);
  const transportPaths = storagePathSet(transportBase);
  if ([...journalPaths].some((path) => transportPaths.has(path))) {
    throw new CreatorWorkerRuntimeError(
      'RUNTIME_STORAGE_PATH_CONFLICT',
      'Journal and transport SQLite files or sidecars overlap.',
    );
  }
}

function canonicalStorageBase(filename: string): string {
  const absolute = resolve(filename);
  const canonical = existsSync(absolute)
    ? realpathSync(absolute)
    : join(realpathSync(dirname(absolute)), basename(absolute));
  const normalized = canonical.normalize('NFC');
  return process.platform === 'darwin' || process.platform === 'win32'
    ? normalized.toLowerCase()
    : normalized;
}

function storagePathSet(base: string): ReadonlySet<string> {
  return new Set([base, `${base}-wal`, `${base}-shm`, `${base}-journal`]);
}

function requiredObject<T extends object>(input: T, label: string): T {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    invalid(`${label} are required.`);
  return input;
}

function requiredFunction<T extends (...args: never[]) => unknown>(input: T, label: string): T {
  if (typeof input !== 'function') invalid(`${label} must be a function.`);
  return input;
}

function optionalFunction<T extends (...args: never[]) => unknown>(
  input: T | undefined,
  label: string,
): T | undefined {
  if (input !== undefined && typeof input !== 'function') invalid(`${label} must be a function.`);
  return input;
}

function bounded(input: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(input) || input < minimum || input > maximum) {
    invalid(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return input;
}

function invalid(message: string): never {
  throw new CreatorWorkerRuntimeError('RUNTIME_CONFIGURATION_INVALID', message);
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
    reject(error) {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
    get settled() {
      return settled;
    },
  };
}

function abortRejection(
  signal: AbortSignal,
): Readonly<{ promise: Promise<never>; dispose(): void }> {
  let dispose = (): void => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    const aborted = () => reject(runtimeStopped());
    if (signal.aborted) aborted();
    else {
      signal.addEventListener('abort', aborted, { once: true });
      dispose = () => signal.removeEventListener('abort', aborted);
    }
  });
  void promise.catch(() => undefined);
  return { promise, dispose };
}

async function raceLifecycle<T>(
  task: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  timeoutError: () => Error,
): Promise<T> {
  const aborted = abortRejection(signal);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError()), timeoutMs);
  });
  try {
    return await Promise.race([task, aborted.promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    aborted.dispose();
  }
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw runtimeStopped();
  await new Promise<void>((resolveDelay, reject) => {
    const timer = setTimeout(done, ms);
    const aborted = () => done(runtimeStopped());
    signal.addEventListener('abort', aborted, { once: true });
    function done(error?: Error): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      if (error === undefined) resolveDelay();
      else reject(error);
    }
  });
}

async function settleWithin(
  task: Promise<void>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    await Promise.race([task, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function callAsync(work: () => void | Promise<void> | undefined): Promise<void> {
  try {
    return Promise.resolve(work()).then(() => undefined);
  } catch (error) {
    return Promise.reject(error);
  }
}

function renewOwner<
  TResource extends { renewOwner(owner: TOwner, leaseMs: number): TOwner },
  TOwner,
>(
  resource: TResource | undefined,
  owner: TOwner | undefined,
  leaseMs: number,
  failures: unknown[],
): void {
  if (resource === undefined || owner === undefined) return;
  try {
    resource.renewOwner(owner, leaseMs);
  } catch (error) {
    failures.push(error);
  }
}

function closeResource<TResource extends { close(owner?: TOwner): void }, TOwner>(
  resource: TResource | undefined,
  owner: TOwner | undefined,
  failures: unknown[],
): void {
  if (resource === undefined) return;
  try {
    if (owner === undefined) resource.close();
    else resource.close(owner);
  } catch (error) {
    failures.push(error);
  }
}

function normalizeStartFailure(error: unknown): CreatorWorkerRuntimeError {
  return error instanceof CreatorWorkerRuntimeError
    ? error
    : new CreatorWorkerRuntimeError(
        'RUNTIME_START_FAILED',
        'Creator Worker Runtime failed to start.',
        { cause: error },
      );
}

function normalizeBlockedFailure(error: unknown): CreatorWorkerRuntimeError {
  return error instanceof CreatorWorkerRuntimeError
    ? error
    : new CreatorWorkerRuntimeError('RUNTIME_BLOCKED', 'Creator Worker Runtime blocked.', {
        cause: error,
      });
}

function runtimeStopped(): CreatorWorkerRuntimeError {
  return new CreatorWorkerRuntimeError('RUNTIME_STOPPED', 'Creator Worker Runtime is stopping.');
}

function runtimeBlocked(): CreatorWorkerRuntimeError {
  return new CreatorWorkerRuntimeError('RUNTIME_BLOCKED', 'Creator Worker Runtime is blocked.');
}

function rejectedStart(error: CreatorWorkerRuntimeError): Promise<CreatorWorkerRuntimeStartResult> {
  const task = Promise.reject<CreatorWorkerRuntimeStartResult>(error);
  void task.catch(() => undefined);
  return task;
}
