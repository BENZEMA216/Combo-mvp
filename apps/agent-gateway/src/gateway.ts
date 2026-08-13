import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  BROKER_MAX_FRAME_BYTES,
  BROKER_WORKER_CONNECT_PATH,
  BrokerAuthenticationError,
  BrokerAuthenticationFailureCode,
  BrokerCloseCode,
  BrokerCloseReason,
  BrokerEnvelopeSchema,
  UuidSchema,
  canonicalSha256,
  canonicalizeJson,
  parseBrokerFrame,
  parseBrokerHandshake,
  type BrokerEnvelope,
  type BrokerHandshake,
} from '@cb/creator-agent-protocol';
import {
  consumeSequence,
  initialSequenceCursor,
  type SequenceCursor,
} from '@cb/creator-agent-broker-journal';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

export const WORKER_CONNECT_PATH = BROKER_WORKER_CONNECT_PATH;

const MAX_BUFFERED_BYTES = 256 * 1024;
const MAX_PENDING_FRAMES_PER_SESSION = 8;
const MAX_OUTBOUND_BATCH = 1_000;

export type GatewayDisconnectReason =
  | 'CLIENT_CLOSED'
  | 'SESSION_REPLACED'
  | 'PROTOCOL_ERROR'
  | 'AUTH_FAILED'
  | 'REPLAY_REQUIRED'
  | 'CAPACITY'
  | 'SERVER_STOPPED'
  | 'INTERNAL_ERROR';

export type AuthenticatedWorkerSession = Readonly<{
  ownerId: string;
  installationId: string;
  connectionId: string;
  workerSessionId: string;
}>;

export type GatewayDelivery = Readonly<{
  envelope: BrokerEnvelope;
  canonicalDigest: string;
}>;

/**
 * The authority implementation owns every durable/security decision. In particular,
 * authenticate must verify and consume the registered device challenge exactly once;
 * expected rejection must throw BrokerAuthenticationError with a machine-readable code;
 * accept/replay must transact against PostgreSQL before returning durable ACK frames.
 */
export interface AgentGatewayAuthorityPort {
  authenticate(input: {
    handshake: BrokerHandshake;
    connectedAt: string;
    signal: AbortSignal;
  }): Promise<AuthenticatedWorkerSession>;
  openSession(
    session: AuthenticatedWorkerSession,
    signal: AbortSignal,
  ): Promise<readonly BrokerEnvelope[]>;
  acceptEnvelope(
    session: AuthenticatedWorkerSession,
    delivery: GatewayDelivery,
    signal: AbortSignal,
  ): Promise<readonly BrokerEnvelope[]>;
  replayEnvelope(
    session: AuthenticatedWorkerSession,
    delivery: GatewayDelivery,
    signal: AbortSignal,
  ): Promise<readonly BrokerEnvelope[]>;
  sequenceGap(
    session: AuthenticatedWorkerSession,
    input: { expected: string; received: string },
    signal: AbortSignal,
  ): Promise<void>;
  closeSession(session: AuthenticatedWorkerSession, reason: GatewayDisconnectReason): Promise<void>;
}

export type GatewayDiagnosticEvent =
  | 'listener_started'
  | 'handshake_accepted'
  | 'handshake_rejected'
  | 'frame_accepted'
  | 'frame_replayed'
  | 'sequence_gap'
  | 'session_replaced'
  | 'session_closed'
  | 'transport_error';

export type AgentGatewayOptions = Readonly<{
  authority: AgentGatewayAuthorityPort;
  host?: string;
  port?: number;
  maxConnections?: number;
  handshakeTimeoutMs?: number;
  authorityTimeoutMs?: number;
  sendTimeoutMs?: number;
  stopTimeoutMs?: number;
  now?: () => number;
  diagnosticSink?: (event: GatewayDiagnosticEvent) => void;
}>;

export type AgentGatewayAddress = Readonly<{
  host: string;
  port: number;
  path: typeof WORKER_CONNECT_PATH;
}>;

type Session = {
  readonly socket: WebSocket;
  readonly lifecycle: AbortController;
  chain: Promise<void>;
  readonly handshakeTimer: NodeJS.Timeout;
  context?: AuthenticatedWorkerSession;
  ready: boolean;
  handshakeReceived: boolean;
  inbound?: SequenceCursor;
  outbound?: SequenceCursor;
  closed: boolean;
  cleaned: boolean;
  disconnectReported: boolean;
  disconnectReason: GatewayDisconnectReason;
  pendingFrames: number;
};

export class AgentGateway {
  readonly #authority: AgentGatewayAuthorityPort;
  readonly #host: string;
  readonly #requestedPort: number;
  readonly #maxConnections: number;
  readonly #handshakeTimeoutMs: number;
  readonly #authorityTimeoutMs: number;
  readonly #sendTimeoutMs: number;
  readonly #stopTimeoutMs: number;
  readonly #now: () => number;
  readonly #diagnosticSink?: (event: GatewayDiagnosticEvent) => void;
  readonly #webSockets: WebSocketServer;
  readonly #sessions = new Set<Session>();
  readonly #byConnection = new Map<string, Session>();
  readonly #byInstallation = new Map<string, Session>();
  readonly #byWorkerSession = new Map<string, Session>();
  readonly #cleanup = new Set<Promise<void>>();

  #server?: HttpServer;
  #address?: AgentGatewayAddress;
  #starting?: Promise<AgentGatewayAddress>;
  #stopping?: Promise<void>;
  #accepting = false;

  constructor(options: AgentGatewayOptions) {
    this.#authority = options.authority;
    this.#host = options.host ?? '127.0.0.1';
    this.#requestedPort = boundedInteger(options.port ?? 0, 0, 65_535, 'port');
    this.#maxConnections = boundedInteger(options.maxConnections ?? 10, 1, 10, 'maxConnections');
    this.#handshakeTimeoutMs = boundedInteger(
      options.handshakeTimeoutMs ?? 5_000,
      10,
      30_000,
      'handshakeTimeoutMs',
    );
    this.#authorityTimeoutMs = boundedInteger(
      options.authorityTimeoutMs ?? 5_000,
      10,
      30_000,
      'authorityTimeoutMs',
    );
    this.#sendTimeoutMs = boundedInteger(
      options.sendTimeoutMs ?? 5_000,
      10,
      30_000,
      'sendTimeoutMs',
    );
    this.#stopTimeoutMs = boundedInteger(
      options.stopTimeoutMs ?? 2_000,
      10,
      30_000,
      'stopTimeoutMs',
    );
    this.#now = options.now ?? Date.now;
    this.#diagnosticSink = options.diagnosticSink;
    this.#webSockets = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      maxPayload: BROKER_MAX_FRAME_BYTES,
      perMessageDeflate: false,
    });
    this.#webSockets.on('error', () => {
      this.#diagnostic('transport_error');
      void this.stop().catch(() => undefined);
    });
  }

  get address(): AgentGatewayAddress | undefined {
    return this.#address;
  }

  get activeConnections(): number {
    let active = 0;
    for (const session of this.#byConnection.values()) {
      if (session.ready && !session.closed) active += 1;
    }
    return active;
  }

  async start(): Promise<AgentGatewayAddress> {
    if (this.#stopping !== undefined) throw new Error('AGENT_GATEWAY_STOPPING');
    if (this.#address !== undefined) return this.#address;
    if (this.#starting !== undefined) return this.#starting;

    this.#starting = this.#startOnce();
    try {
      return await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async stop(): Promise<void> {
    if (this.#stopping !== undefined) return this.#stopping;
    const starting = this.#starting;
    this.#stopping = (async () => {
      await starting?.catch(() => undefined);
      await this.#stopOnce();
    })();
    return this.#stopping;
  }

  async dispatch(connectionId: string, envelopes: readonly BrokerEnvelope[]): Promise<boolean> {
    const parsedConnection = UuidSchema.safeParse(connectionId);
    if (!parsedConnection.success) return false;
    const session = this.#byConnection.get(parsedConnection.data);
    if (
      session === undefined ||
      session.closed ||
      !session.ready ||
      session.context === undefined
    ) {
      return false;
    }
    const task = session.chain.then(() => this.#sendOutbound(session, envelopes));
    session.chain = task.catch(() => {
      this.#failSession(
        session,
        'INTERNAL_ERROR',
        BrokerCloseCode.INTERNAL_ERROR,
        BrokerCloseReason.INTERNAL_ERROR,
      );
    });
    await task;
    return true;
  }

  async #startOnce(): Promise<AgentGatewayAddress> {
    const server = createServer((request, response) => {
      response.writeHead(404, securityHeaders());
      response.end();
    });
    this.#server = server;
    server.headersTimeout = 5_000;
    server.requestTimeout = 5_000;
    server.keepAliveTimeout = 1_000;
    server.on('upgrade', (request, socket, head) => this.#upgrade(request, socket, head));
    server.on('clientError', (_error, socket) => socket.destroy());
    server.on('error', () => {
      if (this.#server === server && this.#address !== undefined) {
        this.#diagnostic('transport_error');
        void this.stop().catch(() => undefined);
      }
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(this.#requestedPort, this.#host);
      });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('INVALID_LISTENER');
      if (this.#stopping !== undefined) throw new Error('AGENT_GATEWAY_STOPPING');
      this.#accepting = true;
      this.#address = Object.freeze({
        host: this.#host,
        port: address.port,
        path: WORKER_CONNECT_PATH,
      });
      this.#diagnostic('listener_started');
      return this.#address;
    } catch (error) {
      this.#accepting = false;
      this.#address = undefined;
      this.#server = undefined;
      server.close();
      throw error;
    }
  }

  async #stopOnce(): Promise<void> {
    this.#accepting = false;
    const server = this.#server;
    this.#server = undefined;
    this.#address = undefined;

    const sessions = [...this.#sessions];
    const socketClosures = sessions.map((session) => waitForSocketClose(session.socket));
    for (const session of sessions) {
      this.#failSession(
        session,
        'SERVER_STOPPED',
        BrokerCloseCode.GOING_AWAY,
        BrokerCloseReason.SERVER_STOPPED,
      );
    }

    const closeServer =
      server === undefined
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeIdleConnections();
          });
    await Promise.race([
      Promise.all([closeServer, Promise.allSettled(socketClosures)]).then(() => undefined),
      delay(this.#stopTimeoutMs),
    ]);
    for (const session of this.#sessions) session.socket.terminate();
    server?.closeAllConnections();
    await Promise.race([
      Promise.allSettled(socketClosures).then(() => undefined),
      delay(Math.min(this.#stopTimeoutMs, 250)),
    ]);
    for (const session of [...this.#sessions]) this.#cleanupSession(session);
    await Promise.allSettled([...this.#cleanup]);
  }

  #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.#accepting || this.#sessions.size >= this.#maxConnections) {
      rejectUpgrade(socket, 503);
      return;
    }
    if (
      request.method !== 'GET' ||
      request.url !== WORKER_CONNECT_PATH ||
      request.headers.origin !== undefined ||
      request.headers.cookie !== undefined ||
      request.headers.authorization !== undefined
    ) {
      rejectUpgrade(socket, 403);
      return;
    }
    try {
      this.#webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        if (!this.#accepting) {
          webSocket.close(BrokerCloseCode.CAPACITY, BrokerCloseReason.NOT_ACCEPTING);
          return;
        }
        this.#attach(webSocket);
      });
    } catch {
      socket.destroy();
    }
  }

  #attach(socket: WebSocket): void {
    const session: Session = {
      socket,
      lifecycle: new AbortController(),
      chain: Promise.resolve(),
      handshakeTimer: setTimeout(() => {
        this.#diagnostic('handshake_rejected');
        this.#failSession(
          session,
          'AUTH_FAILED',
          BrokerCloseCode.AUTH_FAILED,
          BrokerCloseReason.HANDSHAKE_TIMEOUT,
        );
      }, this.#handshakeTimeoutMs),
      closed: false,
      cleaned: false,
      ready: false,
      handshakeReceived: false,
      disconnectReported: false,
      disconnectReason: 'CLIENT_CLOSED',
      pendingFrames: 0,
    };
    session.handshakeTimer.unref();
    this.#sessions.add(session);

    socket.on('message', (data, isBinary) => {
      if (session.closed) return;
      if (session.context === undefined) {
        if (session.handshakeReceived) {
          this.#failSession(
            session,
            'PROTOCOL_ERROR',
            BrokerCloseCode.PROTOCOL_ERROR,
            BrokerCloseReason.PROTOCOL_ERROR,
          );
          return;
        }
        session.handshakeReceived = true;
      }
      if (session.pendingFrames >= MAX_PENDING_FRAMES_PER_SESSION) {
        this.#failSession(
          session,
          'CAPACITY',
          BrokerCloseCode.CAPACITY,
          BrokerCloseReason.TRANSPORT_CAPACITY,
        );
        return;
      }
      session.pendingFrames += 1;
      const task = session.chain.then(() => this.#handleMessage(session, data, isBinary));
      session.chain = task
        .catch(() => {
          this.#failSession(
            session,
            'PROTOCOL_ERROR',
            BrokerCloseCode.PROTOCOL_ERROR,
            BrokerCloseReason.PROTOCOL_ERROR,
          );
        })
        .finally(() => {
          session.pendingFrames -= 1;
        });
    });
    socket.on('error', () => {
      this.#diagnostic('transport_error');
      this.#failSession(
        session,
        'INTERNAL_ERROR',
        BrokerCloseCode.INTERNAL_ERROR,
        BrokerCloseReason.TRANSPORT_ERROR,
      );
    });
    socket.on('close', () => this.#cleanupSession(session));
  }

  async #handleMessage(session: Session, data: RawData, isBinary: boolean): Promise<void> {
    if (session.closed || isBinary) throw new Error('BINARY_FRAME_REJECTED');
    const bytes = rawDataBytes(data);
    if (bytes.byteLength > BROKER_MAX_FRAME_BYTES) throw new Error('FRAME_TOO_LARGE');

    if (session.context === undefined) {
      await this.#acceptHandshake(session, bytes);
      return;
    }
    await this.#acceptEnvelope(session, bytes);
  }

  async #acceptHandshake(session: Session, bytes: Buffer): Promise<void> {
    let handshake: BrokerHandshake;
    try {
      handshake = parseBrokerHandshake(bytes);
    } catch {
      this.#diagnostic('handshake_rejected');
      this.#failSession(
        session,
        'AUTH_FAILED',
        BrokerCloseCode.AUTH_FAILED,
        BrokerCloseReason.AUTHENTICATION_REJECTED,
      );
      return;
    }

    let context: AuthenticatedWorkerSession;
    try {
      context = validateSessionContext(
        await withAbortableTimeout(
          (signal) =>
            this.#authority.authenticate({
              handshake,
              connectedAt: isoNow(this.#now()),
              signal,
            }),
          this.#authorityTimeoutMs,
          'AUTHORITY_TIMEOUT',
          session.lifecycle.signal,
        ),
        handshake.installationId,
      );
    } catch (error) {
      this.#diagnostic('handshake_rejected');
      if (error instanceof BrokerAuthenticationError) {
        this.#failSession(session, 'AUTH_FAILED', BrokerCloseCode.AUTH_FAILED, error.code);
      } else {
        this.#failSession(
          session,
          'INTERNAL_ERROR',
          BrokerCloseCode.INTERNAL_ERROR,
          BrokerCloseReason.AUTHORITY_FAILED,
        );
      }
      return;
    }
    if (session.closed || session.socket.readyState !== WebSocket.OPEN || !this.#accepting) {
      this.#abandonAuthenticatedSession(session, context);
      return;
    }

    const connectionOwner = this.#byConnection.get(context.connectionId);
    const workerSessionOwner = this.#byWorkerSession.get(context.workerSessionId);
    if (
      (connectionOwner !== undefined && connectionOwner !== session) ||
      (workerSessionOwner !== undefined && workerSessionOwner !== session)
    ) {
      this.#diagnostic('handshake_rejected');
      this.#failSession(
        session,
        'AUTH_FAILED',
        BrokerCloseCode.AUTH_FAILED,
        BrokerAuthenticationFailureCode.AUTHENTICATION_REJECTED,
      );
      return;
    }

    const previous = this.#byInstallation.get(context.installationId);
    if (previous !== undefined && previous !== session) {
      this.#diagnostic('session_replaced');
      this.#failSession(
        previous,
        'SESSION_REPLACED',
        BrokerCloseCode.SESSION_REPLACED,
        BrokerCloseReason.SESSION_REPLACED,
      );
    }

    clearTimeout(session.handshakeTimer);
    session.context = context;
    session.inbound = initialSequenceCursor(context.connectionId);
    session.outbound = initialSequenceCursor(context.connectionId);
    this.#byConnection.set(context.connectionId, session);
    this.#byInstallation.set(context.installationId, session);
    this.#byWorkerSession.set(context.workerSessionId, session);
    try {
      const initial = await withAbortableTimeout(
        (signal) => this.#authority.openSession(context, signal),
        this.#authorityTimeoutMs,
        'AUTHORITY_TIMEOUT',
        session.lifecycle.signal,
      );
      await this.#sendOutbound(session, initial);
    } catch {
      this.#failSession(
        session,
        'INTERNAL_ERROR',
        BrokerCloseCode.INTERNAL_ERROR,
        BrokerCloseReason.AUTHORITY_FAILED,
      );
      return;
    }
    if (
      session.closed ||
      session.socket.readyState !== WebSocket.OPEN ||
      this.#byConnection.get(context.connectionId) !== session ||
      this.#byInstallation.get(context.installationId) !== session ||
      this.#byWorkerSession.get(context.workerSessionId) !== session
    ) {
      this.#abandonAuthenticatedSession(session, context);
      return;
    }
    session.ready = true;
    this.#diagnostic('handshake_accepted');
  }

  async #acceptEnvelope(session: Session, bytes: Buffer): Promise<void> {
    const context = session.context;
    const cursor = session.inbound;
    if (!session.ready || context === undefined || cursor === undefined) {
      throw new Error('SESSION_NOT_READY');
    }

    const envelope = parseBrokerFrame(bytes);
    if (
      envelope.kind === 'command' ||
      envelope.connectionId !== context.connectionId ||
      envelope.lease.workerSessionId !== context.workerSessionId
    ) {
      throw new Error('DIRECTION_OR_SESSION_MISMATCH');
    }
    const canonicalDigest = canonicalSha256(envelope);
    const decision = consumeSequence(cursor, envelope, canonicalDigest, this.#now());
    if (decision.type === 'REQUEST_REPLAY') {
      this.#diagnostic('sequence_gap');
      try {
        await withAbortableTimeout(
          (signal) =>
            this.#authority.sequenceGap(
              context,
              {
                expected: decision.expected,
                received: decision.received,
              },
              signal,
            ),
          this.#authorityTimeoutMs,
          'AUTHORITY_TIMEOUT',
          session.lifecycle.signal,
        );
      } catch {
        this.#failSession(
          session,
          'INTERNAL_ERROR',
          BrokerCloseCode.INTERNAL_ERROR,
          BrokerCloseReason.AUTHORITY_FAILED,
        );
        return;
      }
      this.#failSession(
        session,
        'REPLAY_REQUIRED',
        BrokerCloseCode.REPLAY_REQUIRED,
        BrokerCloseReason.REPLAY_REQUIRED,
      );
      return;
    }
    session.inbound = decision.cursor;
    const delivery = Object.freeze({ envelope, canonicalDigest });
    let responses: readonly BrokerEnvelope[];
    try {
      responses =
        decision.type === 'REPLAY'
          ? await withAbortableTimeout(
              (signal) => this.#authority.replayEnvelope(context, delivery, signal),
              this.#authorityTimeoutMs,
              'AUTHORITY_TIMEOUT',
              session.lifecycle.signal,
            )
          : await withAbortableTimeout(
              (signal) => this.#authority.acceptEnvelope(context, delivery, signal),
              this.#authorityTimeoutMs,
              'AUTHORITY_TIMEOUT',
              session.lifecycle.signal,
            );
      await this.#sendOutbound(session, responses);
    } catch {
      this.#failSession(
        session,
        'INTERNAL_ERROR',
        BrokerCloseCode.INTERNAL_ERROR,
        BrokerCloseReason.AUTHORITY_FAILED,
      );
      return;
    }
    this.#diagnostic(decision.type === 'REPLAY' ? 'frame_replayed' : 'frame_accepted');
  }

  async #sendOutbound(session: Session, inputs: readonly BrokerEnvelope[]): Promise<void> {
    if (inputs.length > MAX_OUTBOUND_BATCH) throw new Error('OUTBOUND_BATCH_CAPACITY');
    const context = session.context;
    let cursor = session.outbound;
    if (context === undefined || cursor === undefined) {
      if (inputs.length === 0) return;
      throw new Error('SESSION_NOT_READY');
    }
    for (const input of inputs) {
      const envelope = BrokerEnvelopeSchema.parse(input);
      if (
        envelope.kind === 'event' ||
        envelope.connectionId !== context.connectionId ||
        envelope.lease.workerSessionId !== context.workerSessionId
      ) {
        throw new Error('OUTBOUND_DIRECTION_OR_SESSION_MISMATCH');
      }
      const digest = canonicalSha256(envelope);
      const decision = consumeSequence(cursor, envelope, digest, this.#now());
      if (decision.type === 'REQUEST_REPLAY') throw new Error('OUTBOUND_SEQUENCE_GAP');
      if (decision.type === 'REPLAY') {
        await this.#write(session, canonicalizeJson(envelope));
        continue;
      }
      cursor = decision.cursor;
      await this.#write(session, canonicalizeJson(envelope));
    }
    session.outbound = cursor;
  }

  async #write(session: Session, payload: string): Promise<void> {
    if (session.closed || session.socket.readyState !== WebSocket.OPEN) {
      throw new Error('SOCKET_NOT_OPEN');
    }
    if (
      Buffer.byteLength(payload) > BROKER_MAX_FRAME_BYTES ||
      session.socket.bufferedAmount > MAX_BUFFERED_BYTES
    ) {
      throw new Error('TRANSPORT_CAPACITY');
    }
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        session.socket.send(payload, { binary: false, compress: false }, (error) => {
          if (error == null) resolve();
          else reject(error);
        });
      }),
      this.#sendTimeoutMs,
      'SEND_TIMEOUT',
    );
  }

  #failSession(
    session: Session,
    reason: GatewayDisconnectReason,
    closeCode: number,
    closeReason: string,
  ): void {
    if (session.closed) return;
    session.closed = true;
    session.disconnectReason = reason;
    session.lifecycle.abort(new Error(reason));
    clearTimeout(session.handshakeTimer);
    if (session.socket.readyState === WebSocket.OPEN) {
      session.socket.close(closeCode, closeReason);
    } else if (session.socket.readyState === WebSocket.CONNECTING) {
      session.socket.terminate();
    }
    const termination = setTimeout(() => session.socket.terminate(), 200);
    termination.unref();
  }

  #cleanupSession(session: Session): void {
    if (session.cleaned) return;
    session.cleaned = true;
    if (!session.closed) {
      session.closed = true;
      session.disconnectReason = 'CLIENT_CLOSED';
    }
    session.lifecycle.abort(new Error(session.disconnectReason));
    clearTimeout(session.handshakeTimer);
    this.#sessions.delete(session);
    const context = session.context;
    if (context !== undefined) {
      if (this.#byConnection.get(context.connectionId) === session) {
        this.#byConnection.delete(context.connectionId);
      }
      if (this.#byInstallation.get(context.installationId) === session) {
        this.#byInstallation.delete(context.installationId);
      }
      if (this.#byWorkerSession.get(context.workerSessionId) === session) {
        this.#byWorkerSession.delete(context.workerSessionId);
      }
      this.#scheduleDisconnect(session);
    }
    this.#diagnostic('session_closed');
  }

  #scheduleDisconnect(session: Session): void {
    const context = session.context;
    if (context === undefined || session.disconnectReported) return;
    session.disconnectReported = true;
    const cleanup = session.chain
      .catch(() => undefined)
      .then(() =>
        withTimeout(
          this.#authority.closeSession(context, session.disconnectReason),
          this.#authorityTimeoutMs,
          'AUTHORITY_TIMEOUT',
        ),
      )
      .catch(() => undefined)
      .finally(() => this.#cleanup.delete(cleanup));
    this.#cleanup.add(cleanup);
  }

  #abandonAuthenticatedSession(session: Session, context: AuthenticatedWorkerSession): void {
    session.context = context;
    if (!session.closed) {
      session.closed = true;
      session.disconnectReason = this.#accepting ? 'CLIENT_CLOSED' : 'SERVER_STOPPED';
    }
    if (session.cleaned) this.#scheduleDisconnect(session);
    else this.#cleanupSession(session);
  }

  #diagnostic(event: GatewayDiagnosticEvent): void {
    try {
      this.#diagnosticSink?.(event);
    } catch {
      // Diagnostics are non-authoritative and must never change lifecycle behavior.
    }
  }
}

function validateSessionContext(
  input: AuthenticatedWorkerSession,
  expectedInstallationId: string,
): AuthenticatedWorkerSession {
  const ownerId = UuidSchema.parse(input.ownerId);
  const installationId = UuidSchema.parse(input.installationId);
  const connectionId = UuidSchema.parse(input.connectionId);
  const workerSessionId = UuidSchema.parse(input.workerSessionId);
  if (installationId !== expectedInstallationId) throw new Error('INSTALLATION_MISMATCH');
  return Object.freeze({ ownerId, installationId, connectionId, workerSessionId });
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`INVALID_${label.toUpperCase()}`);
  }
  return value;
}

function rawDataBytes(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data.map((chunk) => Buffer.from(chunk)));
  if (Buffer.isBuffer(data)) return Buffer.from(data);
  return Buffer.from(new Uint8Array(data));
}

function isoNow(nowMs: number): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('INVALID_CLOCK');
  return new Date(nowMs).toISOString();
}

function rejectUpgrade(socket: Duplex, status: 403 | 503): void {
  const reason = status === 403 ? 'Forbidden' : 'Service Unavailable';
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`,
  );
}

function securityHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

function waitForSocketClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => socket.once('close', () => resolve()));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label)), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function withAbortableTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted === true) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  try {
    return await withTimeout(operation(controller.signal), timeoutMs, label);
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}
