import { randomBytes } from 'node:crypto';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';

import {
  BrokerEnvelopeSchema,
  BrokerHandshakeSchema,
  BrokerHandshakeUnsignedSchema,
  BROKER_WORKER_CONNECT_PATH,
  BROKER_MAX_FRAME_BYTES,
  BrokerCloseCode,
  BrokerCloseReason,
  brokerHandshakeSigningBytes,
  canonicalSha256,
  canonicalizeJson,
  classifyBrokerRemoteClose,
  compareUint63,
  parseBrokerFrame,
  type BrokerCommand,
  type BrokerEnvelope,
  type BrokerHandshake,
  type BrokerHandshakeUnsigned,
  type LeaseBinding,
} from '@cb/creator-agent-protocol';
import {
  BrokerProtocolError,
  consumeSequence,
  initialSequenceCursor,
  restoreSequenceCursor,
  serializeSequenceCursor,
} from '@cb/creator-agent-broker-journal';
import WebSocket, { type RawData } from 'ws';

export const WORKER_BROKER_CONNECT_PATH = BROKER_WORKER_CONNECT_PATH;

export type WorkerBrokerClientStatus =
  | 'IDLE'
  | 'ACQUIRING_INSTALLATION'
  | 'CONNECTING'
  | 'AUTHENTICATING'
  | 'READY'
  | 'BACKING_OFF'
  | 'BLOCKED'
  | 'STOPPING'
  | 'STOPPED';

export type WorkerBrokerDiagnosticEvent =
  | 'installation_acquired'
  | 'connection_attempted'
  | 'handshake_sent'
  | 'lease_activated'
  | 'lease_renewed'
  | 'lease_revoked'
  | 'heartbeat_enqueued'
  | 'frame_applied'
  | 'frame_replayed'
  | 'outbound_written'
  | 'sequence_gap'
  | 'security_block'
  | 'connection_lost'
  | 'reconnect_scheduled'
  | 'installation_revoked'
  | 'stopped';

export type WorkerBrokerClientErrorCode =
  | 'INVALID_OPTIONS'
  | 'INVALID_BROKER_URL'
  | 'INSTALLATION_ALREADY_ACTIVE'
  | 'CLIENT_ALREADY_STOPPED'
  | 'CHALLENGE_FAILED'
  | 'DEVICE_SIGN_FAILED'
  | 'HANDSHAKE_REJECTED'
  | 'TRANSPORT_FAILED'
  | 'PORT_FAILED'
  | 'PROTOCOL_ERROR'
  | 'SEQUENCE_GAP'
  | 'SEQUENCE_CONFLICT'
  | 'STALE_CONNECTION'
  | 'STALE_LEASE'
  | 'STALE_FENCE'
  | 'LEASE_GRANT_INVALID'
  | 'INSTALLATION_REVOKED'
  | 'CAPACITY_EXCEEDED'
  | 'STOP_TIMEOUT';

export class WorkerBrokerClientError extends Error {
  constructor(
    readonly code: WorkerBrokerClientErrorCode,
    readonly permanent = false,
  ) {
    super(code);
    this.name = 'WorkerBrokerClientError';
  }
}

export type BrokerChallenge = Readonly<{ challengeId: string }>;

/** OAuth/session exchange remains a cloud-facing port; transport never receives bearer tokens. */
export interface BrokerChallengePort {
  requestChallenge(input: {
    installationId: string;
    signal: AbortSignal;
  }): Promise<BrokerChallenge>;
}

/** Production implements this with the registered Secure Enclave key. This package has no key fallback. */
export interface DeviceSignerPort {
  signCanonicalHandshake(input: {
    installationId: string;
    canonicalBytes: Uint8Array;
    signal: AbortSignal;
  }): Promise<string>;
}

export type DurableBrokerConnection = Readonly<{
  installationId: string;
  connectionId: string;
  workerSessionId: string;
  lease: LeaseBinding;
  leaseState: 'ACTIVE' | 'REVOKED';
  leaseGrantedAt: string;
  leaseExpiresAt: string;
  inboundCursor: string;
  outboundCursor: string;
}>;

export type LeaseGrantCommand = Extract<BrokerCommand, { type: 'lease.grant' }>;

/**
 * SQLite-backed production adapter boundary. Cursor advancement and command/ACK effects must commit
 * in one transaction; outbound frames must already be durably sequenced before they are returned.
 * releaseConnection must be idempotent even when activateConnection committed but its response was
 * lost; it must restore written-but-unacknowledged outbox rows for the next durable reframe.
 * Every method must carry AbortSignal into the transaction and must not commit after abort wins.
 */
export interface WorkerBrokerDurableTransportPort {
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
  activateConnection(input: {
    installationId: string;
    ownerToken: string;
    envelope: LeaseGrantCommand;
    canonicalDigest: string;
    inboundCursor: string;
    signal: AbortSignal;
  }): Promise<DurableBrokerConnection>;
  loadConnection(input: {
    installationId: string;
    ownerToken: string;
    connectionId: string;
    signal: AbortSignal;
  }): Promise<DurableBrokerConnection | null>;
  commitInbound(input: {
    installationId: string;
    ownerToken: string;
    connectionId: string;
    expectedInboundCursor: string;
    nextInboundCursor: string;
    envelope: BrokerEnvelope;
    canonicalDigest: string;
    signal: AbortSignal;
  }): Promise<DurableBrokerConnection>;
  replayInbound(input: {
    installationId: string;
    ownerToken: string;
    connectionId: string;
    envelope: BrokerEnvelope;
    canonicalDigest: string;
    signal: AbortSignal;
  }): Promise<void>;
  recordSequenceGap(input: {
    installationId: string;
    ownerToken: string;
    connectionId: string;
    expected: string;
    received: string;
    signal: AbortSignal;
  }): Promise<void>;
  enqueueHeartbeat(input: {
    installationId: string;
    ownerToken: string;
    connectionId: string;
    lease: LeaseBinding;
    cloudLeaseExpiresAt: string;
    signal: AbortSignal;
  }): Promise<void>;
  readOutbound(input: {
    installationId: string;
    ownerToken: string;
    connectionId: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<readonly BrokerEnvelope[]>;
  markOutboundWritten(input: {
    installationId: string;
    ownerToken: string;
    connectionId: string;
    messageId: string;
    canonicalDigest: string;
    signal: AbortSignal;
  }): Promise<void>;
  releaseConnection(input: {
    installationId: string;
    ownerToken: string;
    connectionId: string;
    signal: AbortSignal;
  }): Promise<void>;
}

export type WorkerBrokerClientOptions = Readonly<{
  url: string;
  installationId: string;
  workerVersion: string;
  codexRuntimeArtifacts: readonly string[];
  codexProtocolSchemaDigests: readonly string[];
  isolationModes: readonly ('apple-container-v1' | 'lima-vz-v1')[];
  challengePort: BrokerChallengePort;
  deviceSigner: DeviceSignerPort;
  durablePort: WorkerBrokerDurableTransportPort;
  allowInsecureLoopbackForTests?: boolean;
  handshakeTimeoutMs?: number;
  portTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  maximumLeaseGrantMs?: number;
  reconnectInitialMs?: number;
  reconnectMaximumMs?: number;
  maxPendingInboundFrames?: number;
  maxOutboundBatch?: number;
  maxOutboundBatchesPerFlush?: number;
  maxBufferedBytes?: number;
  stopTimeoutMs?: number;
  monotonicNow?: () => number;
  diagnosticSink?: (event: WorkerBrokerDiagnosticEvent) => void;
}>;

type LeaseWindow = Readonly<{
  lease: LeaseBinding;
  cloudSentAtMs: number;
  cloudExpiresAt: string;
  deadlineMonotonicMs: number;
}>;

type LiveConnection = {
  readonly socket: WebSocket;
  readonly lifecycle: AbortController;
  chain: Promise<void>;
  pendingInbound: number;
  ready: boolean;
  everReady: boolean;
  closed: boolean;
  permanent: boolean;
  localCloseInitiated: boolean;
  durableConnectionId?: string;
  connection?: DurableBrokerConnection;
  leaseWindow?: LeaseWindow;
  heartbeatTimer?: NodeJS.Timeout;
  grantTimer?: NodeJS.Timeout;
  flushPromise?: Promise<void>;
};

export class WorkerBrokerClient {
  readonly #url: string;
  readonly #installationId: string;
  readonly #workerVersion: string;
  readonly #codexRuntimeArtifacts: readonly string[];
  readonly #codexProtocolSchemaDigests: readonly string[];
  readonly #isolationModes: readonly ('apple-container-v1' | 'lima-vz-v1')[];
  readonly #challengePort: BrokerChallengePort;
  readonly #deviceSigner: DeviceSignerPort;
  readonly #durablePort: WorkerBrokerDurableTransportPort;
  readonly #handshakeTimeoutMs: number;
  readonly #portTimeoutMs: number;
  readonly #heartbeatIntervalMs: number;
  readonly #maximumLeaseGrantMs: number;
  readonly #reconnectInitialMs: number;
  readonly #reconnectMaximumMs: number;
  readonly #maxPendingInboundFrames: number;
  readonly #maxOutboundBatch: number;
  readonly #maxOutboundBatchesPerFlush: number;
  readonly #maxBufferedBytes: number;
  readonly #stopTimeoutMs: number;
  readonly #monotonicNow: () => number;
  readonly #diagnosticSink?: (event: WorkerBrokerDiagnosticEvent) => void;
  readonly #ownerToken = randomBytes(24).toString('base64url');
  readonly #lifecycle = new AbortController();

  #status: WorkerBrokerClientStatus = 'IDLE';
  #startPromise?: Promise<void>;
  #run?: Promise<void>;
  #live?: LiveConnection;
  #installationAcquired = false;
  #durableConnectionReleaseBlocked = false;
  #stopPromise?: Promise<void>;

  constructor(options: WorkerBrokerClientOptions) {
    this.#url = validateBrokerUrl(options.url, options.allowInsecureLoopbackForTests === true);
    const unsigned = BrokerHandshakeUnsignedSchema.parse({
      protocol: 'combo.creator-broker/1',
      schemaVersion: 1,
      installationId: options.installationId,
      workerVersion: options.workerVersion,
      supportedProtocolVersions: [1],
      codexRuntimeArtifacts: options.codexRuntimeArtifacts,
      codexProtocolSchemaDigests: options.codexProtocolSchemaDigests,
      isolationModes: options.isolationModes,
      capacity: { maxActiveConversations: 1, maxActiveTurns: 1 },
      challengeId: '00000000-0000-7000-8000-000000000000',
    });
    this.#installationId = unsigned.installationId;
    this.#workerVersion = unsigned.workerVersion;
    this.#codexRuntimeArtifacts = Object.freeze([...unsigned.codexRuntimeArtifacts]);
    this.#codexProtocolSchemaDigests = Object.freeze([...unsigned.codexProtocolSchemaDigests]);
    this.#isolationModes = Object.freeze([...unsigned.isolationModes]);
    this.#challengePort = options.challengePort;
    this.#deviceSigner = options.deviceSigner;
    this.#durablePort = options.durablePort;
    this.#handshakeTimeoutMs = bounded(options.handshakeTimeoutMs ?? 5_000, 50, 30_000);
    this.#portTimeoutMs = bounded(options.portTimeoutMs ?? 5_000, 50, 30_000);
    this.#heartbeatIntervalMs = bounded(options.heartbeatIntervalMs ?? 10_000, 10, 30_000);
    this.#maximumLeaseGrantMs = bounded(options.maximumLeaseGrantMs ?? 60_000, 1_000, 120_000);
    this.#reconnectInitialMs = bounded(options.reconnectInitialMs ?? 250, 10, 30_000);
    this.#reconnectMaximumMs = bounded(options.reconnectMaximumMs ?? 10_000, 10, 60_000);
    if (this.#reconnectMaximumMs < this.#reconnectInitialMs) {
      throw new WorkerBrokerClientError('INVALID_OPTIONS', true);
    }
    this.#maxPendingInboundFrames = bounded(options.maxPendingInboundFrames ?? 32, 1, 256);
    this.#maxOutboundBatch = bounded(options.maxOutboundBatch ?? 16, 1, 64);
    this.#maxOutboundBatchesPerFlush = bounded(options.maxOutboundBatchesPerFlush ?? 4, 1, 16);
    this.#maxBufferedBytes = bounded(
      options.maxBufferedBytes ?? BROKER_MAX_FRAME_BYTES,
      BROKER_MAX_FRAME_BYTES,
      BROKER_MAX_FRAME_BYTES * 4,
    );
    this.#stopTimeoutMs = bounded(options.stopTimeoutMs ?? 2_000, 50, 30_000);
    this.#monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
    this.#diagnosticSink = options.diagnosticSink;
  }

  get status(): WorkerBrokerClientStatus {
    return this.#status;
  }

  get connected(): boolean {
    return this.#live?.ready === true && this.#live.closed === false;
  }

  async start(): Promise<void> {
    if (this.#status === 'STOPPED' || this.#status === 'STOPPING') {
      throw new WorkerBrokerClientError('CLIENT_ALREADY_STOPPED', true);
    }
    if (this.#run !== undefined) return;
    if (this.#startPromise !== undefined) return this.#startPromise;
    const attempt = this.#startOnce();
    this.#startPromise = attempt;
    try {
      await attempt;
    } catch (error) {
      if (this.#startPromise === attempt) this.#startPromise = undefined;
      throw error;
    }
  }

  async #startOnce(): Promise<void> {
    this.#status = 'ACQUIRING_INSTALLATION';
    const acquired = await this.#callPort((signal) =>
      this.#durablePort.acquireInstallation({
        installationId: this.#installationId,
        ownerToken: this.#ownerToken,
        signal,
      }),
    );
    if (!acquired) {
      this.#status = 'BLOCKED';
      throw new WorkerBrokerClientError('INSTALLATION_ALREADY_ACTIVE', true);
    }
    this.#installationAcquired = true;
    if (this.#lifecycle.signal.aborted) {
      throw new WorkerBrokerClientError('CLIENT_ALREADY_STOPPED', true);
    }
    this.#diagnostic('installation_acquired');
    this.#run = this.#runReconnectLoop();
  }

  async flush(): Promise<void> {
    const live = this.#live;
    if (live === undefined || live.closed || !live.ready) return;
    await this.#queueFlush(live);
  }

  async stop(): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    this.#stopPromise = this.#stopOnce();
    return this.#stopPromise;
  }

  async #stopOnce(): Promise<void> {
    if (this.#status === 'STOPPED') return;
    this.#status = 'STOPPING';
    this.#lifecycle.abort(new WorkerBrokerClientError('TRANSPORT_FAILED'));
    const starting = this.#startPromise;
    if (starting !== undefined && !(await settleWithin(starting, this.#stopTimeoutMs))) {
      this.#status = 'BLOCKED';
      throw new WorkerBrokerClientError('STOP_TIMEOUT');
    }
    const live = this.#live;
    if (live !== undefined) {
      this.#closeLive(live, BrokerCloseCode.GOING_AWAY, BrokerCloseReason.STOPPING);
    }

    const run = this.#run;
    if (run !== undefined && !(await settleWithin(run, this.#stopTimeoutMs))) {
      live?.socket.terminate();
      this.#status = 'BLOCKED';
      throw new WorkerBrokerClientError('STOP_TIMEOUT');
    }
    if (this.#durableConnectionReleaseBlocked) {
      this.#status = 'BLOCKED';
      throw new WorkerBrokerClientError('STOP_TIMEOUT');
    }
    live?.socket.terminate();

    if (this.#installationAcquired) {
      try {
        await withAbortableTimeout(
          (signal) =>
            this.#durablePort.releaseInstallation({
              installationId: this.#installationId,
              ownerToken: this.#ownerToken,
              signal,
            }),
          this.#portTimeoutMs,
        );
        this.#installationAcquired = false;
      } catch {
        this.#status = 'BLOCKED';
        throw new WorkerBrokerClientError('STOP_TIMEOUT');
      }
    }
    this.#status = 'STOPPED';
    this.#diagnostic('stopped');
  }

  async #runReconnectLoop(): Promise<void> {
    let attempt = 0;
    while (!this.#lifecycle.signal.aborted) {
      this.#status = 'CONNECTING';
      this.#diagnostic('connection_attempted');
      try {
        const outcome = await this.#connectOnce();
        if (outcome.permanent) {
          this.#status = 'BLOCKED';
          return;
        }
        attempt = outcome.everReady ? 0 : attempt + 1;
      } catch (error) {
        const failure = normalizeClientError(error);
        if (failure.permanent) {
          this.#status = 'BLOCKED';
          if (failure.code === 'INSTALLATION_REVOKED') {
            this.#diagnostic('installation_revoked');
          } else {
            this.#diagnostic('security_block');
          }
          return;
        }
        attempt += 1;
      }
      if (this.#lifecycle.signal.aborted) return;
      this.#diagnostic('connection_lost');
      this.#status = 'BACKING_OFF';
      this.#diagnostic('reconnect_scheduled');
      const delayMs = boundedBackoff(attempt, this.#reconnectInitialMs, this.#reconnectMaximumMs);
      await abortableDelay(delayMs, this.#lifecycle.signal).catch(() => undefined);
    }
  }

  async #connectOnce(): Promise<{ everReady: boolean; permanent: boolean }> {
    const handshake = await this.#createHandshake();
    const socket = await openSocket(this.#url, this.#handshakeTimeoutMs, this.#lifecycle.signal);
    const live: LiveConnection = {
      socket,
      lifecycle: new AbortController(),
      chain: Promise.resolve(),
      pendingInbound: 0,
      ready: false,
      everReady: false,
      closed: false,
      permanent: false,
      localCloseInitiated: false,
    };
    this.#live = live;
    const parentAbort = () =>
      this.#closeLive(live, BrokerCloseCode.GOING_AWAY, BrokerCloseReason.STOPPING);
    this.#lifecycle.signal.addEventListener('abort', parentAbort, { once: true });

    const closed = new Promise<void>((resolve) => {
      socket.once('close', (code, reasonBytes) => {
        if (
          !live.localCloseInitiated &&
          classifyBrokerRemoteClose(code, reasonBytes.toString()) === 'BLOCK'
        ) {
          live.permanent = true;
          if (
            code === BrokerCloseCode.AUTH_FAILED &&
            reasonBytes.toString() === BrokerCloseReason.INSTALLATION_REVOKED
          ) {
            this.#diagnostic('installation_revoked');
          } else {
            this.#diagnostic('security_block');
          }
        }
        live.closed = true;
        live.ready = false;
        clearTimeout(live.grantTimer);
        clearTimeout(live.heartbeatTimer);
        live.lifecycle.abort(new WorkerBrokerClientError('TRANSPORT_FAILED'));
        resolve();
      });
    });
    socket.on('error', () =>
      this.#closeLive(live, BrokerCloseCode.INTERNAL_ERROR, BrokerCloseReason.TRANSPORT_ERROR),
    );
    socket.on('message', (data, isBinary) => this.#queueInbound(live, data, isBinary));

    live.grantTimer = setTimeout(() => {
      this.#closeLive(live, BrokerCloseCode.AUTH_FAILED, BrokerCloseReason.LEASE_GRANT_TIMEOUT);
    }, this.#handshakeTimeoutMs);
    live.grantTimer.unref();

    let connectionFailed = false;
    let connectionFailure: unknown;
    let releaseFailure: WorkerBrokerClientError | undefined;
    try {
      this.#status = 'AUTHENTICATING';
      await sendText(socket, canonicalizeJson(handshake), this.#handshakeTimeoutMs);
      this.#diagnostic('handshake_sent');
      await closed;
      await settleWithin(live.chain, Math.min(this.#stopTimeoutMs, 1_000));
    } catch (error) {
      connectionFailed = true;
      connectionFailure = error;
    } finally {
      this.#lifecycle.signal.removeEventListener('abort', parentAbort);
      if (!live.closed) {
        this.#closeLive(live, BrokerCloseCode.INTERNAL_ERROR, BrokerCloseReason.TRANSPORT_FAILED);
      }
      await settleWithin(closed, Math.min(this.#stopTimeoutMs, 250));
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      clearTimeout(live.grantTimer);
      clearTimeout(live.heartbeatTimer);
      live.lifecycle.abort(new WorkerBrokerClientError('TRANSPORT_FAILED'));
      if (this.#live === live) this.#live = undefined;
      const connectionId = live.durableConnectionId;
      if (connectionId !== undefined) {
        try {
          await this.#callPort(
            (signal) =>
              this.#durablePort.releaseConnection({
                installationId: this.#installationId,
                ownerToken: this.#ownerToken,
                connectionId,
                signal,
              }),
            true,
          );
        } catch {
          this.#durableConnectionReleaseBlocked = true;
          releaseFailure = new WorkerBrokerClientError('PORT_FAILED', true);
        }
      }
    }
    if (releaseFailure !== undefined) throw releaseFailure;
    if (connectionFailed) throw connectionFailure;
    return { everReady: live.everReady, permanent: live.permanent };
  }

  async #createHandshake(): Promise<BrokerHandshake> {
    let challenge: BrokerChallenge;
    try {
      challenge = await withAbortableTimeout(
        (signal) =>
          this.#challengePort.requestChallenge({
            installationId: this.#installationId,
            signal,
          }),
        this.#portTimeoutMs,
        this.#lifecycle.signal,
      );
    } catch {
      throw new WorkerBrokerClientError('CHALLENGE_FAILED');
    }
    let unsigned: BrokerHandshakeUnsigned;
    try {
      unsigned = BrokerHandshakeUnsignedSchema.parse({
        protocol: 'combo.creator-broker/1',
        schemaVersion: 1,
        installationId: this.#installationId,
        workerVersion: this.#workerVersion,
        supportedProtocolVersions: [1],
        codexRuntimeArtifacts: this.#codexRuntimeArtifacts,
        codexProtocolSchemaDigests: this.#codexProtocolSchemaDigests,
        isolationModes: this.#isolationModes,
        capacity: { maxActiveConversations: 1, maxActiveTurns: 1 },
        challengeId: challenge.challengeId,
      });
    } catch {
      throw new WorkerBrokerClientError('CHALLENGE_FAILED');
    }
    let signature: string;
    try {
      signature = await withAbortableTimeout(
        (signal) =>
          this.#deviceSigner.signCanonicalHandshake({
            installationId: this.#installationId,
            canonicalBytes: brokerHandshakeSigningBytes(unsigned),
            signal,
          }),
        this.#portTimeoutMs,
        this.#lifecycle.signal,
      );
      return BrokerHandshakeSchema.parse({ ...unsigned, challengeSignature: signature });
    } catch {
      throw new WorkerBrokerClientError('DEVICE_SIGN_FAILED');
    }
  }

  #queueInbound(live: LiveConnection, data: RawData, isBinary: boolean): void {
    if (live.closed) return;
    if (live.pendingInbound >= this.#maxPendingInboundFrames) {
      this.#failLive(live, new WorkerBrokerClientError('CAPACITY_EXCEEDED'));
      return;
    }
    live.pendingInbound += 1;
    const task = live.chain.then(() => this.#handleInbound(live, data, isBinary));
    live.chain = task
      .catch((error) => this.#failLive(live, normalizeClientError(error)))
      .finally(() => {
        live.pendingInbound -= 1;
      });
  }

  async #handleInbound(live: LiveConnection, data: RawData, isBinary: boolean): Promise<void> {
    if (live.closed) return;
    if (isBinary) throw new WorkerBrokerClientError('PROTOCOL_ERROR', true);
    const bytes = rawDataBytes(data);
    if (bytes.byteLength > BROKER_MAX_FRAME_BYTES) {
      throw new WorkerBrokerClientError('CAPACITY_EXCEEDED');
    }
    let envelope: BrokerEnvelope;
    try {
      envelope = parseBrokerFrame(bytes);
    } catch {
      throw new WorkerBrokerClientError('PROTOCOL_ERROR', true);
    }
    if (envelope.kind === 'event') throw new WorkerBrokerClientError('PROTOCOL_ERROR', true);
    if (live.connection === undefined) {
      await this.#activateFirstLease(live, envelope);
      return;
    }
    await this.#acceptEstablishedFrame(live, envelope);
  }

  async #activateFirstLease(live: LiveConnection, envelope: BrokerEnvelope): Promise<void> {
    if (
      envelope.kind !== 'command' ||
      envelope.type !== 'lease.grant' ||
      envelope.sequence !== '0'
    ) {
      throw new WorkerBrokerClientError('HANDSHAKE_REJECTED', true);
    }
    validateLeaseGrant(envelope, this.#maximumLeaseGrantMs);
    const initial = initialSequenceCursor(envelope.connectionId);
    const digest = canonicalSha256(envelope);
    const decision = consumeSequence(initial, envelope, digest, Date.parse(envelope.sentAt));
    if (decision.type !== 'ACCEPT') {
      throw new WorkerBrokerClientError('HANDSHAKE_REJECTED', true);
    }
    const inboundCursor = serializeSequenceCursor(decision.cursor);
    live.durableConnectionId = envelope.connectionId;
    const state = await this.#callLivePort(live, (signal) =>
      this.#durablePort.activateConnection({
        installationId: this.#installationId,
        ownerToken: this.#ownerToken,
        envelope,
        canonicalDigest: digest,
        inboundCursor,
        signal,
      }),
    );
    validateConnectionState(state, this.#installationId, envelope.connectionId);
    if (state.inboundCursor !== inboundCursor) throw new WorkerBrokerClientError('PORT_FAILED');
    if (
      !sameLease(state.lease, envelope.lease) ||
      state.leaseState !== 'ACTIVE' ||
      state.leaseGrantedAt !== envelope.sentAt ||
      state.leaseExpiresAt !== envelope.body.leaseExpiresAt
    ) {
      throw new WorkerBrokerClientError('STALE_LEASE', true);
    }
    live.connection = state;
    live.leaseWindow = leaseWindowFor(envelope, this.#monotonicNow());
    live.ready = true;
    live.everReady = true;
    clearTimeout(live.grantTimer);
    this.#status = 'READY';
    this.#diagnostic('lease_activated');
    this.#scheduleHeartbeat(live);
    await this.#queueFlush(live);
  }

  async #acceptEstablishedFrame(live: LiveConnection, envelope: BrokerEnvelope): Promise<void> {
    const current = live.connection!;
    if (
      envelope.connectionId !== current.connectionId ||
      envelope.lease.workerSessionId !== current.workerSessionId
    ) {
      throw new WorkerBrokerClientError('STALE_CONNECTION', true);
    }
    const durable = await this.#loadConnection(live, current.connectionId);
    validateConnectionState(durable, this.#installationId, current.connectionId);
    const cursor = restoreSequenceCursor(durable.inboundCursor);
    const digest = canonicalSha256(envelope);
    let decision: ReturnType<typeof consumeSequence>;
    try {
      decision = consumeSequence(cursor, envelope, digest, this.#estimatedCloudNow(live, envelope));
    } catch (error) {
      if (error instanceof BrokerProtocolError && error.code === 'SEQUENCE_CONFLICT') {
        throw new WorkerBrokerClientError('SEQUENCE_CONFLICT', true);
      }
      throw new WorkerBrokerClientError('PROTOCOL_ERROR', true);
    }
    if (decision.type === 'REQUEST_REPLAY') {
      this.#diagnostic('sequence_gap');
      await this.#callLivePort(live, (signal) =>
        this.#durablePort.recordSequenceGap({
          installationId: this.#installationId,
          ownerToken: this.#ownerToken,
          connectionId: current.connectionId,
          expected: decision.expected,
          received: decision.received,
          signal,
        }),
      );
      throw new WorkerBrokerClientError('SEQUENCE_GAP');
    }
    if (decision.type === 'REPLAY') {
      await this.#callLivePort(live, (signal) =>
        this.#durablePort.replayInbound({
          installationId: this.#installationId,
          ownerToken: this.#ownerToken,
          connectionId: current.connectionId,
          envelope,
          canonicalDigest: digest,
          signal,
        }),
      );
      this.#diagnostic('frame_replayed');
      await this.#queueFlush(live);
      return;
    }

    if (envelope.kind === 'command' && envelope.type === 'lease.grant') {
      validateLeaseGrant(envelope, this.#maximumLeaseGrantMs);
    }
    validateInboundLeaseAuthority(durable, envelope, live, this.#monotonicNow());
    const nextCursor = serializeSequenceCursor(decision.cursor);
    const next = await this.#callLivePort(live, (signal) =>
      this.#durablePort.commitInbound({
        installationId: this.#installationId,
        ownerToken: this.#ownerToken,
        connectionId: current.connectionId,
        expectedInboundCursor: durable.inboundCursor,
        nextInboundCursor: nextCursor,
        envelope,
        canonicalDigest: digest,
        signal,
      }),
    );
    validateConnectionState(next, this.#installationId, current.connectionId);
    if (next.inboundCursor !== nextCursor) throw new WorkerBrokerClientError('PORT_FAILED');
    validateCommittedConnection(durable, envelope, next);
    live.connection = next;
    this.#applyLeaseTransition(live, envelope, next);
    this.#diagnostic('frame_applied');
    await this.#queueFlush(live);

    if (
      envelope.kind === 'command' &&
      envelope.type === 'lease.revoke' &&
      (envelope.body.reason === 'INSTALLATION_REVOKED' || envelope.body.reason === 'SECURITY')
    ) {
      live.permanent = true;
      throw new WorkerBrokerClientError('INSTALLATION_REVOKED', true);
    }
    if (
      envelope.kind === 'command' &&
      envelope.type === 'lease.revoke' &&
      envelope.body.reason === 'SESSION_REPLACED'
    ) {
      throw new WorkerBrokerClientError('STALE_CONNECTION');
    }
  }

  #applyLeaseTransition(
    live: LiveConnection,
    envelope: BrokerEnvelope,
    next: DurableBrokerConnection,
  ): void {
    if (envelope.kind !== 'command') return;
    if (envelope.type === 'lease.grant') {
      validateLeaseGrant(envelope, this.#maximumLeaseGrantMs);
      live.leaseWindow = leaseWindowFor(envelope, this.#monotonicNow());
      this.#diagnostic('lease_renewed');
      this.#scheduleHeartbeat(live);
      return;
    }
    if (envelope.type === 'lease.revoke') {
      clearTimeout(live.heartbeatTimer);
      live.heartbeatTimer = undefined;
      live.leaseWindow = undefined;
      live.connection = next;
      this.#diagnostic('lease_revoked');
    }
  }

  #scheduleHeartbeat(live: LiveConnection): void {
    clearTimeout(live.heartbeatTimer);
    const window = live.leaseWindow;
    if (window === undefined || live.closed) return;
    const remaining = window.deadlineMonotonicMs - this.#monotonicNow();
    if (remaining <= 0) {
      this.#closeLive(live, BrokerCloseCode.REPLAY_REQUIRED, BrokerCloseReason.LEASE_EXPIRED);
      return;
    }
    const delayMs = Math.max(1, Math.min(this.#heartbeatIntervalMs, Math.ceil(remaining)));
    live.heartbeatTimer = setTimeout(() => {
      const task = live.chain.then(() => this.#heartbeat(live));
      live.chain = task.catch((error) => this.#failLive(live, normalizeClientError(error)));
    }, delayMs);
    live.heartbeatTimer.unref();
  }

  async #heartbeat(live: LiveConnection): Promise<void> {
    if (
      live.closed ||
      !live.ready ||
      live.connection === undefined ||
      live.leaseWindow === undefined
    ) {
      return;
    }
    if (this.#monotonicNow() >= live.leaseWindow.deadlineMonotonicMs) {
      throw new WorkerBrokerClientError('STALE_LEASE');
    }
    const durable = await this.#loadConnection(live, live.connection.connectionId);
    if (
      durable.leaseState !== 'ACTIVE' ||
      !sameLease(durable.lease, live.leaseWindow.lease) ||
      durable.leaseExpiresAt !== live.leaseWindow.cloudExpiresAt
    ) {
      throw new WorkerBrokerClientError('STALE_LEASE');
    }
    await this.#callLivePort(live, (signal) =>
      this.#durablePort.enqueueHeartbeat({
        installationId: this.#installationId,
        ownerToken: this.#ownerToken,
        connectionId: durable.connectionId,
        lease: durable.lease,
        cloudLeaseExpiresAt: durable.leaseExpiresAt,
        signal,
      }),
    );
    this.#diagnostic('heartbeat_enqueued');
    await this.#queueFlush(live);
    this.#scheduleHeartbeat(live);
  }

  #queueFlush(live: LiveConnection): Promise<void> {
    if (live.closed || !live.ready) return Promise.resolve();
    if (live.flushPromise !== undefined) return live.flushPromise;
    const flush = this.#drainOutbound(live)
      .catch((error) => {
        const failure = normalizeClientError(error);
        this.#failLive(live, failure);
        throw failure;
      })
      .finally(() => {
        if (live.flushPromise === flush) live.flushPromise = undefined;
      });
    live.flushPromise = flush;
    return flush;
  }

  async #drainOutbound(live: LiveConnection): Promise<void> {
    for (let batchIndex = 0; batchIndex < this.#maxOutboundBatchesPerFlush; batchIndex += 1) {
      if (live.closed || live.connection === undefined) return;
      const state = await this.#loadConnection(live, live.connection.connectionId);
      const frames = await this.#callLivePort(live, (signal) =>
        this.#durablePort.readOutbound({
          installationId: this.#installationId,
          ownerToken: this.#ownerToken,
          connectionId: state.connectionId,
          limit: this.#maxOutboundBatch,
          signal,
        }),
      );
      if (frames.length === 0) return;
      if (frames.length > this.#maxOutboundBatch) {
        throw new WorkerBrokerClientError('CAPACITY_EXCEEDED', true);
      }
      const outboundCursor = restoreSequenceCursor(state.outboundCursor);
      let previousSequence: string | undefined;
      for (const input of frames) {
        let frame: BrokerEnvelope;
        try {
          frame = BrokerEnvelopeSchema.parse(input);
        } catch {
          throw new WorkerBrokerClientError('PORT_FAILED', true);
        }
        if (
          frame.kind === 'command' ||
          frame.connectionId !== state.connectionId ||
          frame.lease.workerSessionId !== state.workerSessionId
        ) {
          throw new WorkerBrokerClientError('PORT_FAILED', true);
        }
        if (
          previousSequence !== undefined &&
          compareUint63(frame.sequence, previousSequence) <= 0
        ) {
          throw new WorkerBrokerClientError('PORT_FAILED', true);
        }
        previousSequence = frame.sequence;
        const digest = canonicalSha256(frame);
        let decision: ReturnType<typeof consumeSequence>;
        try {
          decision = consumeSequence(
            outboundCursor,
            frame,
            digest,
            this.#estimatedCloudNow(live, frame),
          );
        } catch {
          throw new WorkerBrokerClientError('PORT_FAILED', true);
        }
        if (decision.type !== 'REPLAY') {
          throw new WorkerBrokerClientError('PORT_FAILED', true);
        }
        const payload = canonicalizeJson(frame);
        if (
          Buffer.byteLength(payload) > BROKER_MAX_FRAME_BYTES ||
          live.socket.bufferedAmount + Buffer.byteLength(payload) > this.#maxBufferedBytes
        ) {
          throw new WorkerBrokerClientError('CAPACITY_EXCEEDED');
        }
        await sendText(live.socket, payload, this.#portTimeoutMs);
        await this.#callLivePort(live, (signal) =>
          this.#durablePort.markOutboundWritten({
            installationId: this.#installationId,
            ownerToken: this.#ownerToken,
            connectionId: state.connectionId,
            messageId: frame.messageId,
            canonicalDigest: digest,
            signal,
          }),
        );
        this.#diagnostic('outbound_written');
      }
    }
  }

  async #loadConnection(
    live: LiveConnection,
    connectionId: string,
  ): Promise<DurableBrokerConnection> {
    const state = await this.#callLivePort(live, (signal) =>
      this.#durablePort.loadConnection({
        installationId: this.#installationId,
        ownerToken: this.#ownerToken,
        connectionId,
        signal,
      }),
    );
    if (state === null) throw new WorkerBrokerClientError('STALE_CONNECTION', true);
    validateConnectionState(state, this.#installationId, connectionId);
    return state;
  }

  #estimatedCloudNow(live: LiveConnection, envelope: BrokerEnvelope): number {
    const window = live.leaseWindow;
    if (window === undefined) return Date.parse(envelope.sentAt);
    const elapsed = Math.max(
      0,
      this.#monotonicNow() -
        (window.deadlineMonotonicMs - (Date.parse(window.cloudExpiresAt) - window.cloudSentAtMs)),
    );
    return window.cloudSentAtMs + elapsed;
  }

  #failLive(live: LiveConnection, failure: WorkerBrokerClientError): void {
    if (live.closed) return;
    if (failure.code === 'INSTALLATION_REVOKED') {
      live.permanent = true;
      this.#diagnostic('installation_revoked');
    } else if (failure.permanent || failure.code === 'SEQUENCE_CONFLICT') {
      live.permanent = true;
      this.#diagnostic('security_block');
    }
    const code =
      failure.code === 'SEQUENCE_GAP'
        ? BrokerCloseCode.REPLAY_REQUIRED
        : failure.code === 'INSTALLATION_REVOKED'
          ? BrokerCloseCode.AUTH_FAILED
          : failure.code === 'CAPACITY_EXCEEDED'
            ? BrokerCloseCode.CAPACITY
            : BrokerCloseCode.PROTOCOL_ERROR;
    const reason =
      failure.code === 'SEQUENCE_GAP'
        ? BrokerCloseReason.REPLAY_REQUIRED
        : failure.code === 'INSTALLATION_REVOKED'
          ? BrokerCloseReason.INSTALLATION_REVOKED
          : failure.code === 'CAPACITY_EXCEEDED'
            ? BrokerCloseReason.TRANSPORT_CAPACITY
            : BrokerCloseReason.PROTOCOL_ERROR;
    this.#closeLive(live, code, reason);
  }

  #closeLive(live: LiveConnection, code: number, reason: string): void {
    if (live.closed) return;
    live.localCloseInitiated = true;
    live.closed = true;
    live.ready = false;
    clearTimeout(live.grantTimer);
    clearTimeout(live.heartbeatTimer);
    live.lifecycle.abort(new WorkerBrokerClientError('TRANSPORT_FAILED'));
    if (live.socket.readyState === WebSocket.OPEN) live.socket.close(code, reason);
    else if (live.socket.readyState === WebSocket.CONNECTING) live.socket.terminate();
    const termination = setTimeout(() => live.socket.terminate(), 200);
    termination.unref();
  }

  async #callPort<T>(
    factory: (signal: AbortSignal) => Promise<T>,
    ignoreLifecycle = false,
  ): Promise<T> {
    try {
      return await withAbortableTimeout(
        factory,
        this.#portTimeoutMs,
        ignoreLifecycle ? undefined : this.#lifecycle.signal,
      );
    } catch (error) {
      if (error instanceof WorkerBrokerClientError) throw error;
      throw new WorkerBrokerClientError('PORT_FAILED');
    }
  }

  async #callLivePort<T>(
    live: LiveConnection,
    factory: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    try {
      return await withAbortableTimeout(factory, this.#portTimeoutMs, live.lifecycle.signal);
    } catch (error) {
      if (error instanceof WorkerBrokerClientError) throw error;
      throw new WorkerBrokerClientError('PORT_FAILED');
    }
  }

  #diagnostic(event: WorkerBrokerDiagnosticEvent): void {
    try {
      this.#diagnosticSink?.(event);
    } catch {
      // Diagnostics are advisory and must never become transport or lease authority.
    }
  }
}

function validateInboundLeaseAuthority(
  durable: DurableBrokerConnection,
  envelope: BrokerEnvelope,
  live: LiveConnection,
  monotonicNow: number,
): void {
  if (envelope.kind === 'ack') {
    if (!sameLease(envelope.lease, durable.lease)) {
      const staleFence = BigInt(envelope.lease.fence) !== BigInt(durable.lease.fence);
      throw new WorkerBrokerClientError(staleFence ? 'STALE_FENCE' : 'STALE_LEASE', true);
    }
    return;
  }
  if (envelope.type === 'lease.grant') {
    if (envelope.lease.deploymentId !== durable.lease.deploymentId) {
      throw new WorkerBrokerClientError('STALE_LEASE', true);
    }
    const nextFence = BigInt(envelope.lease.fence);
    const currentFence = BigInt(durable.lease.fence);
    if (nextFence < currentFence) throw new WorkerBrokerClientError('STALE_FENCE', true);
    if (
      nextFence === currentFence &&
      (!sameLease(envelope.lease, durable.lease) ||
        Date.parse(envelope.body.leaseExpiresAt) < Date.parse(durable.leaseExpiresAt))
    ) {
      throw new WorkerBrokerClientError('STALE_LEASE', true);
    }
    return;
  }
  if (!sameLease(envelope.lease, durable.lease)) {
    const staleFence = BigInt(envelope.lease.fence) !== BigInt(durable.lease.fence);
    throw new WorkerBrokerClientError(staleFence ? 'STALE_FENCE' : 'STALE_LEASE', true);
  }
  if (envelope.type === 'lease.revoke') return;
  if (
    durable.leaseState === 'REVOKED' &&
    envelope.type !== 'invocation.reconcile' &&
    envelope.type !== 'invocation.cancel'
  ) {
    throw new WorkerBrokerClientError('STALE_LEASE', true);
  }
  if (live.leaseWindow === undefined || monotonicNow >= live.leaseWindow.deadlineMonotonicMs) {
    throw new WorkerBrokerClientError('STALE_LEASE');
  }
}

function validateLeaseGrant(envelope: LeaseGrantCommand, maximumLeaseGrantMs: number): void {
  if (envelope.body.workerSessionId !== envelope.lease.workerSessionId) {
    throw new WorkerBrokerClientError('LEASE_GRANT_INVALID', true);
  }
  const sentAt = Date.parse(envelope.sentAt);
  const expiresAt = Date.parse(envelope.body.leaseExpiresAt);
  const duration = expiresAt - sentAt;
  if (!Number.isSafeInteger(duration) || duration <= 0 || duration > maximumLeaseGrantMs) {
    throw new WorkerBrokerClientError('LEASE_GRANT_INVALID', true);
  }
}

function leaseWindowFor(envelope: LeaseGrantCommand, monotonicNow: number): LeaseWindow {
  const cloudSentAtMs = Date.parse(envelope.sentAt);
  return Object.freeze({
    lease: Object.freeze({ ...envelope.lease }),
    cloudSentAtMs,
    cloudExpiresAt: envelope.body.leaseExpiresAt,
    deadlineMonotonicMs: monotonicNow + (Date.parse(envelope.body.leaseExpiresAt) - cloudSentAtMs),
  });
}

function validateConnectionState(
  state: DurableBrokerConnection,
  installationId: string,
  connectionId: string,
): void {
  if (
    state.installationId !== installationId ||
    state.connectionId !== connectionId ||
    state.workerSessionId !== state.lease.workerSessionId ||
    (state.leaseState !== 'ACTIVE' && state.leaseState !== 'REVOKED') ||
    !Number.isFinite(Date.parse(state.leaseGrantedAt)) ||
    !Number.isFinite(Date.parse(state.leaseExpiresAt))
  ) {
    throw new WorkerBrokerClientError('PORT_FAILED', true);
  }
  let inbound: ReturnType<typeof restoreSequenceCursor>;
  let outbound: ReturnType<typeof restoreSequenceCursor>;
  try {
    inbound = restoreSequenceCursor(state.inboundCursor);
    outbound = restoreSequenceCursor(state.outboundCursor);
  } catch {
    throw new WorkerBrokerClientError('PORT_FAILED', true);
  }
  if (inbound.connectionId !== connectionId || outbound.connectionId !== connectionId) {
    throw new WorkerBrokerClientError('PORT_FAILED', true);
  }
}

function validateCommittedConnection(
  before: DurableBrokerConnection,
  envelope: BrokerEnvelope,
  after: DurableBrokerConnection,
): void {
  if (envelope.kind === 'command' && envelope.type === 'lease.grant') {
    if (
      after.leaseState !== 'ACTIVE' ||
      !sameLease(after.lease, envelope.lease) ||
      after.leaseGrantedAt !== envelope.sentAt ||
      after.leaseExpiresAt !== envelope.body.leaseExpiresAt
    ) {
      throw new WorkerBrokerClientError('PORT_FAILED', true);
    }
    return;
  }
  if (envelope.kind === 'command' && envelope.type === 'lease.revoke') {
    if (after.leaseState !== 'REVOKED' || !sameLease(after.lease, before.lease)) {
      throw new WorkerBrokerClientError('PORT_FAILED', true);
    }
    return;
  }
  if (
    after.leaseState !== before.leaseState ||
    !sameLease(after.lease, before.lease) ||
    after.leaseGrantedAt !== before.leaseGrantedAt ||
    after.leaseExpiresAt !== before.leaseExpiresAt
  ) {
    throw new WorkerBrokerClientError('PORT_FAILED', true);
  }
}

function sameLease(left: LeaseBinding, right: LeaseBinding): boolean {
  return (
    left.deploymentId === right.deploymentId &&
    left.leaseId === right.leaseId &&
    left.workerSessionId === right.workerSessionId &&
    left.fence === right.fence
  );
}

function validateBrokerUrl(input: string, allowInsecureLoopback: boolean): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new WorkerBrokerClientError('INVALID_BROKER_URL', true);
  }
  const insecureLoopback =
    allowInsecureLoopback &&
    url.protocol === 'ws:' &&
    (url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1');
  if (
    (url.protocol !== 'wss:' && !insecureLoopback) ||
    url.pathname !== WORKER_BROKER_CONNECT_PATH ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new WorkerBrokerClientError('INVALID_BROKER_URL', true);
  }
  return url.toString();
}

function bounded(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new WorkerBrokerClientError('INVALID_OPTIONS', true);
  }
  return value;
}

export function boundedBackoff(attempt: number, initialMs: number, maximumMs: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new WorkerBrokerClientError('INVALID_OPTIONS', true);
  }
  return Math.min(maximumMs, initialMs * 2 ** Math.min(Math.max(0, attempt - 1), 30));
}

function normalizeClientError(error: unknown): WorkerBrokerClientError {
  return error instanceof WorkerBrokerClientError
    ? error
    : new WorkerBrokerClientError('TRANSPORT_FAILED');
}

function rawDataBytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  throw new WorkerBrokerClientError('PROTOCOL_ERROR');
}

async function openSocket(url: string, timeoutMs: number, signal: AbortSignal): Promise<WebSocket> {
  if (signal.aborted) throw new WorkerBrokerClientError('TRANSPORT_FAILED');
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, {
      perMessageDeflate: false,
      maxPayload: BROKER_MAX_FRAME_BYTES,
      handshakeTimeout: timeoutMs,
    });
    let settled = false;
    const timer = setTimeout(() => fail(), timeoutMs);
    timer.unref();
    const abort = () => fail();
    const opened = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.once('error', () => undefined);
      socket.terminate();
      reject(new WorkerBrokerClientError('TRANSPORT_FAILED'));
    };
    const unexpected = (_request: ClientRequest, response: IncomingMessage) => {
      response.resume();
      fail();
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      socket.off('open', opened);
      socket.off('error', fail);
      socket.off('unexpected-response', unexpected);
    };
    signal.addEventListener('abort', abort, { once: true });
    socket.once('open', opened);
    socket.once('error', fail);
    socket.once('unexpected-response', unexpected);
  });
}

async function sendText(socket: WebSocket, payload: string, timeoutMs: number): Promise<void> {
  if (socket.readyState !== WebSocket.OPEN) {
    throw new WorkerBrokerClientError('TRANSPORT_FAILED');
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new WorkerBrokerClientError('TRANSPORT_FAILED')),
      timeoutMs,
    );
    timer.unref();
    socket.send(payload, { binary: false, compress: false }, (error) => {
      clearTimeout(timer);
      if (error == null) resolve();
      else reject(new WorkerBrokerClientError('TRANSPORT_FAILED'));
    });
  });
}

async function withAbortableTimeout<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('TIMEOUT')), timeoutMs);
  timer.unref();
  try {
    return await Promise.race([
      factory(controller.signal),
      new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(new Error('ABORTED'));
        if (controller.signal.aborted) onAbort();
        else controller.signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
  }
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('ABORTED');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    timer.unref();
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('ABORTED'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
    }),
  ]);
}
