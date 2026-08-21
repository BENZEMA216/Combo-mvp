import { TextDecoder } from 'node:util';

import {
  BROKER_TRANSPORT_MAX_FRAME_BYTES,
  parseBrokerTransportFrame,
} from '@cb/creator-agent-protocol/broker-transport';
import WebSocket, { type RawData } from 'ws';

import { unwrapWorkerTransportSendable } from './transport-authority.js';
import type {
  WorkerDurableTransportRepository,
  WorkerTransportConnectionCursor,
  WorkerTransportOwner,
} from './transport-types.js';

type ActiveDriverState = 'CONNECTING' | 'READY' | 'BACKING_OFF' | 'BLOCKED';
export type WorkerBrokerWebSocketDriverState = 'IDLE' | ActiveDriverState | 'STOPPING' | 'STOPPED';

type ConnectionDiagnostic = 'connection_attempted' | 'connection_lost' | 'reconnect_scheduled';
type CommitDiagnostic = 'lease_committed' | 'frame_committed' | 'outbound_written';
export type WorkerBrokerDriverDiagnostic =
  | ConnectionDiagnostic
  | CommitDiagnostic
  | 'security_block'
  | 'stopped';

export type WorkerBrokerWebSocketDriverOptions = Readonly<{
  url: string;
  owner: WorkerTransportOwner;
  repository: WorkerDurableTransportRepository;
  allowInsecureLoopbackForTests?: boolean;
  connectTimeoutMs?: number;
  firstLeaseTimeoutMs?: number;
  sendTimeoutMs?: number;
  reconnectInitialMs?: number;
  reconnectMaximumMs?: number;
  maxPendingInboundFrames?: number;
  maxOutboundBatch?: number;
  ownerLeaseMs?: number;
  ownerRenewIntervalMs?: number;
  stopTimeoutMs?: number;
  diagnosticSink?: (event: WorkerBrokerDriverDiagnostic) => void;
}>;

export interface WorkerBrokerWebSocketDriver {
  readonly status: WorkerBrokerWebSocketDriverState;
  start(): Promise<void>;
  flush(): Promise<'FLUSHED' | 'DEFERRED'>;
  stop(): Promise<void>;
}

type LiveConnection = {
  readonly socket: WebSocket;
  readonly closed: Promise<number>;
  chain: Promise<void>;
  pendingInbound: number;
  connection?: WorkerTransportConnectionCursor;
  firstLeaseTimer?: NodeJS.Timeout;
  leaseTimer?: NodeJS.Timeout;
  ownerTimer?: NodeJS.Timeout;
  flushPromise?: Promise<void>;
  closedLocally: boolean;
  permanent: boolean;
};

class DriverFailure extends Error {
  public constructor(
    public readonly code: string,
    public readonly permanent: boolean,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'WorkerBrokerWebSocketDriverError';
  }
}

export function createWorkerBrokerWebSocketDriver(
  options: WorkerBrokerWebSocketDriverOptions,
): WorkerBrokerWebSocketDriver {
  return new WebSocketDriver(options);
}

class WebSocketDriver implements WorkerBrokerWebSocketDriver {
  readonly #url: string;
  #owner: WorkerTransportOwner;
  readonly #repository: WorkerDurableTransportRepository;
  readonly #connectTimeoutMs: number;
  readonly #firstLeaseTimeoutMs: number;
  readonly #sendTimeoutMs: number;
  readonly #reconnectInitialMs: number;
  readonly #reconnectMaximumMs: number;
  readonly #maxPendingInboundFrames: number;
  readonly #maxOutboundBatch: number;
  readonly #ownerLeaseMs: number;
  readonly #ownerRenewIntervalMs: number;
  readonly #stopTimeoutMs: number;
  readonly #diagnosticSink?: (event: WorkerBrokerDriverDiagnostic) => void;
  readonly #lifecycle = new AbortController();
  readonly #firstReady = deferred<void>();

  #status: WorkerBrokerWebSocketDriverState = 'IDLE';
  #run?: Promise<void>;
  #live?: LiveConnection;
  #stopPromise?: Promise<void>;
  #unreleasedFailure?: DriverFailure;

  public constructor(options: WorkerBrokerWebSocketDriverOptions) {
    this.#url = validateUrl(options.url, options.allowInsecureLoopbackForTests === true);
    this.#owner = options.owner;
    this.#repository = options.repository;
    this.#connectTimeoutMs = bounded(options.connectTimeoutMs ?? 5_000, 20, 30_000);
    this.#firstLeaseTimeoutMs = bounded(options.firstLeaseTimeoutMs ?? 5_000, 20, 30_000);
    this.#sendTimeoutMs = bounded(options.sendTimeoutMs ?? 5_000, 20, 30_000);
    this.#reconnectInitialMs = bounded(options.reconnectInitialMs ?? 250, 1, 30_000);
    this.#reconnectMaximumMs = bounded(options.reconnectMaximumMs ?? 10_000, 1, 30_000);
    if (this.#reconnectMaximumMs < this.#reconnectInitialMs) {
      throw new TypeError('Reconnect maximum must not be less than its initial delay.');
    }
    this.#maxPendingInboundFrames = bounded(options.maxPendingInboundFrames ?? 32, 1, 256);
    this.#maxOutboundBatch = bounded(options.maxOutboundBatch ?? 16, 1, 64);
    this.#ownerLeaseMs = bounded(options.ownerLeaseMs ?? 30_000, 1_000, 300_000);
    this.#ownerRenewIntervalMs = bounded(
      options.ownerRenewIntervalMs ?? Math.min(10_000, Math.floor(this.#ownerLeaseMs / 2)),
      20,
      Math.floor(this.#ownerLeaseMs / 2),
    );
    this.#stopTimeoutMs = bounded(options.stopTimeoutMs ?? 2_000, 20, 30_000);
    this.#diagnosticSink = options.diagnosticSink;
    void this.#firstReady.promise.catch(() => undefined);
  }
  public get status(): WorkerBrokerWebSocketDriverState {
    return this.#status;
  }
  public start(): Promise<void> {
    if (this.#status === 'STOPPING' || this.#status === 'STOPPED') {
      return Promise.reject(new DriverFailure('DRIVER_STOPPED', true));
    }
    if (this.#status === 'BLOCKED') {
      return Promise.reject(new DriverFailure('DRIVER_BLOCKED', true));
    }
    if (this.#run === undefined) {
      this.#run = this.#runReconnectLoop().catch((error: unknown) => {
        const failure = normalizeFailure(error);
        if (this.#status === 'STOPPING') throw failure;
        this.#block(failure);
      });
    }
    return this.#firstReady.promise;
  }
  public async flush(): Promise<'FLUSHED' | 'DEFERRED'> {
    const live = this.#live;
    if (live === undefined || live.connection === undefined || this.#status !== 'READY') {
      return 'DEFERRED';
    }
    const task = live.chain.then(() => this.#flushLive(live));
    live.chain = task.catch((error: unknown) => this.#failLive(live, normalizeFailure(error)));
    await task;
    return 'FLUSHED';
  }

  public stop(): Promise<void> {
    this.#stopPromise ??= this.#stopOnce();
    return this.#stopPromise;
  }
  async #stopOnce(): Promise<void> {
    if (this.#status === 'STOPPED') return;
    if (this.#unreleasedFailure !== undefined) {
      this.#status = 'BLOCKED';
      throw new DriverFailure('STOP_INCOMPLETE', true, { cause: this.#unreleasedFailure });
    }
    this.#status = 'STOPPING';
    await Promise.resolve();
    this.#lifecycle.abort();
    const live = this.#live;
    if (live !== undefined) this.#closeLive(live, 1001, 'STOPPING');
    if (this.#run !== undefined) {
      try {
        await settleWithin(this.#run, this.#stopTimeoutMs);
      } catch (error) {
        live?.socket.terminate();
        this.#status = 'BLOCKED';
        throw new DriverFailure('STOP_INCOMPLETE', true, { cause: error });
      }
    }
    this.#status = 'STOPPED';
    if (this.#run !== undefined) this.#firstReady.reject(new DriverFailure('DRIVER_STOPPED', true));
    this.#diagnostic('stopped');
  }
  async #runReconnectLoop(): Promise<void> {
    let attempt = 0;
    while (!this.#lifecycle.signal.aborted) {
      let everReady = false;
      try {
        const outcome = await this.#connectOnce();
        everReady = outcome.everReady;
        if (outcome.permanent) {
          this.#block(new DriverFailure('SECURITY_BLOCK', true));
          return;
        }
      } catch (error) {
        const failure = normalizeFailure(error);
        if (failure.permanent) {
          if (this.#status === 'STOPPING') throw failure;
          this.#block(failure);
          return;
        }
      }
      if (this.#lifecycle.signal.aborted) return;
      attempt = everReady ? 0 : attempt + 1;
      this.#status = 'BACKING_OFF';
      this.#diagnostic('connection_lost');
      this.#diagnostic('reconnect_scheduled');
      await abortableDelay(
        Math.min(
          this.#reconnectMaximumMs,
          this.#reconnectInitialMs * 2 ** Math.min(Math.max(0, attempt - 1), 20),
        ),
        this.#lifecycle.signal,
      ).catch(() => undefined);
    }
  }
  async #connectOnce(): Promise<Readonly<{ everReady: boolean; permanent: boolean }>> {
    this.#owner = await this.#repository.renewOwner(this.#owner, this.#ownerLeaseMs);
    this.#status = 'CONNECTING';
    this.#diagnostic('connection_attempted');
    if (this.#lifecycle.signal.aborted) throw new DriverFailure('DRIVER_STOPPED', false);
    const socket = createSocket(this.#url);
    const closed = socketClosed(socket);
    const live: LiveConnection = {
      socket,
      closed,
      chain: Promise.resolve(),
      pendingInbound: 0,
      closedLocally: false,
      permanent: false,
    };
    this.#live = live;
    this.#scheduleOwnerRenewal(live);
    socket.on('message', (data, isBinary) => this.#queueInbound(live, data, isBinary));
    socket.on('error', (error: Error & { code?: string }) => {
      const permanent =
        error.code === 'WS_ERR_INVALID_UTF8' || error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH';
      this.#failLive(live, new DriverFailure('SOCKET_ERROR', permanent, { cause: error }));
    });
    try {
      await waitForSocketOpen(socket, this.#connectTimeoutMs, this.#lifecycle.signal);
    } catch (error) {
      this.#closeLive(live, 1011, 'CONNECT_FAILED');
      if (this.#live === live) this.#live = undefined;
      throw error;
    }
    live.firstLeaseTimer = setTimeout(
      () => this.#failLive(live, new DriverFailure('LEASE_TIMEOUT', false)),
      this.#firstLeaseTimeoutMs,
    );
    live.firstLeaseTimer.unref();

    let closeCode = 1006;
    let closedRemotely = false;
    let completionFailure: unknown;
    try {
      closeCode = await closed;
      closedRemotely = !live.closedLocally;
      live.closedLocally = true;
      await settleWithin(live.chain, this.#stopTimeoutMs);
    } catch (error) {
      completionFailure = error;
    } finally {
      clearTimeout(live.firstLeaseTimer);
      clearTimeout(live.leaseTimer);
      clearTimeout(live.ownerTimer);
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      if (live.connection !== undefined) {
        try {
          await this.#repository.releaseConnection(this.#owner, live.connection);
        } catch (error) {
          live.permanent = true;
          this.#unreleasedFailure = new DriverFailure('RELEASE_FAILED', true, { cause: error });
          completionFailure = this.#unreleasedFailure;
        }
      }
      if (this.#live === live) this.#live = undefined;
    }
    if (completionFailure !== undefined) throw completionFailure;
    const remotePermanent = closedRemotely && remoteCloseIsPermanent(closeCode);
    return {
      everReady: live.connection !== undefined,
      permanent: live.permanent || remotePermanent,
    };
  }
  #queueInbound(live: LiveConnection, data: RawData, isBinary: boolean): void {
    if (live.closedLocally) return;
    if (isBinary || live.pendingInbound >= this.#maxPendingInboundFrames) {
      this.#failLive(live, new DriverFailure('INVALID_INBOUND', true));
      return;
    }
    const bytes = copyRawData(data);
    live.pendingInbound += 1;
    const task = live.chain.then(() => this.#handleInbound(live, bytes));
    live.chain = task
      .catch((error: unknown) => this.#failLive(live, normalizeFailure(error)))
      .finally(() => {
        live.pendingInbound -= 1;
      });
  }
  async #handleInbound(live: LiveConnection, bytes: Buffer): Promise<void> {
    if (live.closedLocally) return;
    if (bytes.byteLength > BROKER_TRANSPORT_MAX_FRAME_BYTES) {
      throw new DriverFailure('FRAME_TOO_LARGE', true);
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (error) {
      throw new DriverFailure('MALFORMED_UTF8', true, { cause: error });
    }
    let parsed: ReturnType<typeof parseBrokerTransportFrame>;
    try {
      parsed = parseBrokerTransportFrame(text);
    } catch (error) {
      throw new DriverFailure('MALFORMED_FRAME', true, { cause: error });
    }
    if (live.connection === undefined) {
      if (
        parsed.frame.direction !== 'CLOUD_TO_WORKER' ||
        parsed.frame.sequence !== 0 ||
        parsed.frame.body.type !== 'lease.grant'
      ) {
        throw new DriverFailure('FIRST_FRAME_NOT_LEASE', true);
      }
      live.connection = await this.#repository.activateLease(this.#owner, parsed);
      clearTimeout(live.firstLeaseTimer);
      this.#scheduleLeaseExpiry(live, parsed.frame.body.leaseExpiresAtMs);
      this.#status = 'READY';
      this.#firstReady.resolve();
      this.#diagnostic('lease_committed');
      await this.#flushLive(live);
      return;
    }
    await this.#repository.commitInbound(this.#owner, live.connection, parsed);
    this.#diagnostic('frame_committed');
    await this.#flushLive(live);
  }

  #scheduleLeaseExpiry(live: LiveConnection, expiresAtMs: number): void {
    clearTimeout(live.leaseTimer);
    const remaining = expiresAtMs - Date.now();
    if (remaining <= 0) {
      this.#failLive(live, new DriverFailure('LEASE_EXPIRED', false));
      return;
    }
    live.leaseTimer = setTimeout(
      () => this.#failLive(live, new DriverFailure('LEASE_EXPIRED', false)),
      Math.min(remaining, 2_147_483_647),
    );
    live.leaseTimer.unref();
  }

  #scheduleOwnerRenewal(live: LiveConnection): void {
    clearTimeout(live.ownerTimer);
    live.ownerTimer = setTimeout(() => {
      try {
        if (live.closedLocally) return;
        this.#owner = this.#repository.renewOwner(this.#owner, this.#ownerLeaseMs);
        if (!live.closedLocally) this.#scheduleOwnerRenewal(live);
      } catch (error) {
        this.#failLive(live, new DriverFailure('OWNER_RENEW_FAILED', true, { cause: error }));
      }
    }, this.#ownerRenewIntervalMs);
    live.ownerTimer.unref();
  }

  #flushLive(live: LiveConnection): Promise<void> {
    if (live.connection === undefined || live.closedLocally) return Promise.resolve();
    if (live.flushPromise !== undefined) return live.flushPromise;
    const flush = this.#drainOutbound(live).finally(() => {
      if (live.flushPromise === flush) live.flushPromise = undefined;
    });
    live.flushPromise = flush;
    return flush;
  }

  async #drainOutbound(live: LiveConnection): Promise<void> {
    while (true) {
      const connection = live.connection;
      if (connection === undefined || live.closedLocally) return;
      const attempts = await this.#repository.prepareSendable(
        this.#owner,
        connection,
        this.#maxOutboundBatch,
      );
      if (attempts.length === 0) return;
      if (attempts.length > this.#maxOutboundBatch) {
        throw new DriverFailure('REPOSITORY_CAPACITY_VIOLATION', true);
      }
      for (const attempt of attempts) {
        if (live.closedLocally) return;
        const unwrapped = unwrapWorkerTransportSendable(attempt);
        const canonicalText = unwrapped.frameText;
        const parsed = parseBrokerTransportFrame(canonicalText);
        if (
          parsed.frame.direction !== 'WORKER_TO_CLOUD' ||
          unwrapped.connectionId !== connection.connectionId ||
          parsed.frame.connectionId !== connection.connectionId ||
          parsed.wireFingerprint !== unwrapped.wireFingerprint
        ) {
          throw new DriverFailure('OUTBOUND_DIRECTION_INVALID', true);
        }
        const bytes = Buffer.byteLength(canonicalText, 'utf8');
        if (live.socket.bufferedAmount + bytes > BROKER_TRANSPORT_MAX_FRAME_BYTES * 2) {
          throw new DriverFailure('SOCKET_BACKPRESSURE', false);
        }
        await sendText(live.socket, canonicalText, this.#sendTimeoutMs);
        await this.#repository.markWireWritten(this.#owner, connection, attempt);
        this.#diagnostic('outbound_written');
      }
    }
  }

  #failLive(live: LiveConnection, failure: DriverFailure): void {
    if (failure.permanent) live.permanent = true;
    this.#closeLive(live, failure.permanent ? 4002 : 1011, failure.code);
  }

  #closeLive(live: LiveConnection, code: number, reason: string): void {
    if (live.closedLocally) return;
    live.closedLocally = true;
    clearTimeout(live.firstLeaseTimer);
    clearTimeout(live.leaseTimer);
    clearTimeout(live.ownerTimer);
    if (live.socket.readyState === WebSocket.OPEN) live.socket.close(code, reason.slice(0, 123));
    else if (live.socket.readyState === WebSocket.CONNECTING) live.socket.terminate();
    const timer = setTimeout(() => live.socket.terminate(), 200);
    timer.unref();
  }

  #block(failure: DriverFailure): void {
    if (this.#status === 'STOPPING' || this.#status === 'STOPPED') return;
    this.#status = 'BLOCKED';
    this.#firstReady.reject(failure);
    this.#diagnostic('security_block');
  }

  #diagnostic(event: WorkerBrokerDriverDiagnostic): void {
    try {
      this.#diagnosticSink?.(event);
    } catch {
      // Diagnostics are advisory and never become transport authority.
    }
  }
}

function validateUrl(input: string, allowLoopback: boolean): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError('Broker URL is invalid.');
  }
  const loopback = allowLoopback && url.protocol === 'ws:' && url.hostname === '127.0.0.1';
  if (
    (!loopback && url.protocol !== 'wss:') ||
    url.pathname !== '/v1/worker/connect' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError('Broker URL violates the transport boundary.');
  }
  return url.toString();
}

function normalizeFailure(error: unknown): DriverFailure {
  if (error instanceof DriverFailure) return error;
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : 'TRANSPORT_FAILED';
  if (code === 'SEQUENCE_GAP' || code === 'STORE_BUSY') {
    return new DriverFailure(code, false, { cause: error });
  }
  if (code === 'LEASE_EXPIRED') return new DriverFailure(code, false, { cause: error });
  const permanent =
    /CONFLICT|STALE|CORRUPT|COMMIT_UNKNOWN|CLOSED|INVALID|FENCE|OWNER_|EXPIRED|UNKNOWN/u.test(code);
  return new DriverFailure(code, permanent, { cause: error });
}

function remoteCloseIsPermanent(code: number): boolean {
  return code === 1008 || (code >= 4000 && code <= 4999 && code !== 4009);
}

function bounded(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError('Driver numeric option is outside its supported range.');
  }
  return value;
}

function copyRawData(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data.map((item) => Buffer.from(item)));
  return data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data);
}

function socketClosed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.once('close', (code) => resolve(code));
  });
}

function createSocket(url: string): WebSocket {
  return new WebSocket(url, {
    followRedirects: false,
    maxPayload: BROKER_TRANSPORT_MAX_FRAME_BYTES,
    perMessageDeflate: false,
  });
}

function waitForSocketOpen(
  socket: WebSocket,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      socket.removeListener('open', opened);
      socket.removeListener('error', failed);
      if (error === undefined) resolve();
      else reject(error);
    };
    const opened = () => finish();
    const failed = (error: Error) =>
      finish(new DriverFailure('CONNECT_FAILED', false, { cause: error }));
    const aborted = () => finish(new DriverFailure('DRIVER_STOPPED', false));
    const timer = setTimeout(() => finish(new DriverFailure('CONNECT_TIMEOUT', false)), timeoutMs);
    timer.unref();
    socket.once('open', opened);
    socket.once('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

function sendText(socket: WebSocket, text: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new DriverFailure('SEND_TIMEOUT', false)), timeoutMs);
    timer.unref();
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolve();
      else reject(error);
    };
    socket.send(text, (error) => finish(error ?? undefined));
  });
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DriverFailure('DRIVER_STOPPED', false));
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      reject(new DriverFailure('DRIVER_STOPPED', false));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted);
      resolve();
    }, ms);
    timer.unref();
    signal.addEventListener('abort', aborted, { once: true });
  });
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new DriverFailure('TIMEOUT', true)), timeoutMs);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}
