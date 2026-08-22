import { randomUUID } from 'node:crypto';

import {
  BROKER_TRANSPORT_MAX_FRAME_BYTES,
  createBrokerTransportFrame,
  parseBrokerTransportFrame,
  type BrokerTransportBody,
  type BrokerTransportFrameMaterialization,
  type BrokerTransportPayload,
  type BrokerTransportWorkerMessageBody,
} from '@cb/creator-agent-protocol/broker-transport';
import WebSocket, { WebSocketServer, type RawData } from 'ws';

import {
  CreatorWorkerLocalAlphaError,
  LOCAL_ALPHA_RESULT_PROTOCOL,
  localAlphaResultEnvelopeFingerprint,
  type LocalAlphaResultEnvelope,
} from './local-alpha-contract.js';

const LEASE_MS = 10 * 60_000;

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  readonly settled: boolean;
}>;

type SessionAuthority = Readonly<{
  connectionId: string;
  installationId: string;
  deploymentId: string;
  workerSessionId: string;
  leaseId: string;
  fence: number;
}>;

type Session = {
  readonly socket: WebSocket;
  readonly authority: SessionAuthority;
  inboundSequence: number;
  expectedWorkerSequence: number;
  sendTail: Promise<void>;
};

type PendingCommand = {
  readonly messageId: string;
  readonly body: Extract<BrokerTransportBody, { type: 'command' }>;
  readonly acknowledged: Deferred<void>;
  materialized?: BrokerTransportFrameMaterialization;
  connectionId?: string;
};

export type LocalAlphaTerminal = Readonly<{
  deliveryMessageId: string;
  outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'UNCERTAIN';
  text: string | null;
  detail: string;
}>;

export interface LocalAlphaBroker {
  readonly url: string;
  sendCommand(
    commandType: string,
    payload: BrokerTransportPayload,
    messageId: string,
    timeoutMs?: number,
  ): Promise<void>;
  waitForTerminal(
    input: Readonly<{
      invocationId: string;
      startAttemptId: string;
      sealedResultId: string;
      answers: ReadonlyMap<
        string,
        Readonly<{ text: string; resultFingerprint: string; sealedFingerprint: string }>
      >;
      timeoutMs: number;
      signal?: AbortSignal;
    }>,
  ): Promise<LocalAlphaTerminal>;
  close(): Promise<void>;
}

export async function createLocalAlphaBroker(installationId: string): Promise<LocalAlphaBroker> {
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    perMessageDeflate: false,
    maxPayload: BROKER_TRANSPORT_MAX_FRAME_BYTES,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw brokerFailure('Local Broker did not bind a TCP port.');
  }
  const broker = new LocalBroker(server, installationId);
  server.on('connection', (socket, request) => broker.accept(socket, request.url));
  return broker;
}

/** Internal reconnect seam; intentionally absent from the package root export. */
export function disconnectLocalAlphaBrokerForTesting(broker: LocalAlphaBroker): void {
  if (!(broker instanceof LocalBroker)) throw new TypeError('Local Broker authority is invalid.');
  broker.disconnectForTesting();
}

class LocalBroker implements LocalAlphaBroker {
  readonly #deploymentId = `deployment.local.${randomUUID()}`;
  readonly #commands = new Map<string, PendingCommand>();
  readonly #terminalWaiters = new Map<
    string,
    Readonly<{
      project(
        body: BrokerTransportWorkerMessageBody,
        deliveryMessageId: string,
      ): LocalAlphaTerminal | undefined;
      resolve(terminal: LocalAlphaTerminal): void;
      reject(error: unknown): void;
    }>
  >();
  #session?: Session;
  #fence = 0;
  #closed = false;
  #failure?: Error;

  public constructor(
    private readonly server: WebSocketServer,
    private readonly installationId: string,
  ) {}

  public get url(): string {
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw brokerFailure('Broker is closed.');
    return `ws://127.0.0.1:${address.port}/v1/worker/connect`;
  }

  public disconnectForTesting(): void {
    const session = this.#session;
    if (session === undefined) throw brokerFailure('Local Broker has no active Worker session.');
    session.socket.terminate();
  }

  public accept(socket: WebSocket, requestUrl: string | undefined): void {
    if (this.#closed || requestUrl !== '/v1/worker/connect') {
      socket.close(1008, 'INVALID_PATH');
      return;
    }
    this.#session?.socket.terminate();
    const fence = ++this.#fence;
    const authority = Object.freeze({
      connectionId: `connection.local.${randomUUID()}`,
      installationId: this.installationId,
      deploymentId: this.#deploymentId,
      workerSessionId: `session.local.${randomUUID()}`,
      leaseId: `lease.local.${randomUUID()}`,
      fence,
    });
    const session: Session = {
      socket,
      authority,
      inboundSequence: 0,
      expectedWorkerSequence: 1,
      sendTail: Promise.resolve(),
    };
    this.#session = session;
    socket.on('message', (raw, isBinary) => this.#receive(session, raw, isBinary));
    socket.on('close', () => {
      for (const command of this.#commands.values()) {
        if (command.connectionId === authority.connectionId) {
          command.connectionId = undefined;
          command.materialized = undefined;
        }
      }
      if (this.#session === session) this.#session = undefined;
      else if (this.#session !== undefined) this.#flushCommands(this.#session);
    });
    socket.on('error', () => socket.terminate());
    this.#queueCloudFrame(session, `lease.local.${fence}`, {
      type: 'lease.grant',
      leaseExpiresAtMs: Date.now() + LEASE_MS,
    });
    this.#flushCommands(session);
  }

  public async sendCommand(
    commandType: string,
    payload: BrokerTransportPayload,
    messageId: string,
    timeoutMs = 10_000,
  ): Promise<void> {
    this.#assertOpen();
    if (this.#commands.has(messageId)) throw brokerFailure('Command message ID is already active.');
    const acknowledged = deferred<void>();
    const command: PendingCommand = {
      messageId,
      body: { type: 'command', commandType, payload },
      acknowledged,
    };
    this.#commands.set(messageId, command);
    const session = this.#session;
    if (session !== undefined) this.#flushCommands(session);
    try {
      await withTimeout(
        acknowledged.promise,
        timeoutMs,
        new CreatorWorkerLocalAlphaError(
          'LOCAL_ALPHA_COMMAND_ACK_TIMEOUT',
          'Local Broker did not receive the durable command acknowledgement in time.',
        ),
      );
    } finally {
      this.#commands.delete(messageId);
    }
  }

  public waitForTerminal(
    input: Readonly<{
      invocationId: string;
      startAttemptId: string;
      sealedResultId: string;
      answers: ReadonlyMap<
        string,
        Readonly<{ text: string; resultFingerprint: string; sealedFingerprint: string }>
      >;
      timeoutMs: number;
      signal?: AbortSignal;
    }>,
  ): Promise<LocalAlphaTerminal> {
    this.#assertOpen();
    if (this.#terminalWaiters.has(input.invocationId)) {
      return Promise.reject(brokerFailure('Invocation already has a terminal waiter.'));
    }
    const terminal = deferred<LocalAlphaTerminal>();
    const project = (body: BrokerTransportWorkerMessageBody, deliveryMessageId: string) =>
      projectLocalAlphaTerminalForTesting(body, deliveryMessageId, input);
    this.#terminalWaiters.set(input.invocationId, {
      project,
      resolve: terminal.resolve,
      reject: terminal.reject,
    });
    const aborted = () => terminal.reject(abortFailure());
    if (input.signal?.aborted) aborted();
    else input.signal?.addEventListener('abort', aborted, { once: true });
    return withTimeout(
      terminal.promise,
      input.timeoutMs,
      new CreatorWorkerLocalAlphaError(
        'LOCAL_ALPHA_TURN_TIMEOUT',
        'The local Creator turn did not reach a durable terminal state in time.',
      ),
    ).finally(() => {
      input.signal?.removeEventListener('abort', aborted);
      this.#terminalWaiters.delete(input.invocationId);
    });
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const failure = brokerFailure('Local Broker stopped before the operation completed.');
    for (const command of this.#commands.values()) command.acknowledged.reject(failure);
    this.#commands.clear();
    for (const waiter of this.#terminalWaiters.values()) waiter.reject(failure);
    this.#terminalWaiters.clear();
    for (const client of this.server.clients) client.terminate();
    await closeServer(this.server);
  }

  #receive(session: Session, raw: RawData, isBinary: boolean): void {
    if (this.#closed || this.#session !== session) return;
    try {
      if (isBinary) throw brokerFailure('Worker sent a binary Broker frame.');
      const materialized = parseBrokerTransportFrame(decodeText(raw));
      const { frame } = materialized;
      if (
        frame.direction !== 'WORKER_TO_CLOUD' ||
        !sameAuthority(frame, session.authority) ||
        frame.sequence !== session.expectedWorkerSequence
      ) {
        throw brokerFailure('Worker Broker authority or sequence did not match the active lease.');
      }
      session.expectedWorkerSequence += 1;
      if (frame.body.type === 'message.ack' && frame.body.level === 'PERSISTED') {
        const command = this.#commands.get(frame.body.acknowledgedMessageId);
        if (
          command === undefined ||
          command.materialized === undefined ||
          command.connectionId !== session.authority.connectionId ||
          frame.body.acknowledgedSemanticFingerprint !==
            command.materialized.frame.semanticFingerprint ||
          frame.body.acknowledgedWireFingerprint !== command.materialized.wireFingerprint
        ) {
          throw brokerFailure('Command acknowledgement did not bind the exact command frame.');
        }
        command.acknowledged.resolve();
        return;
      }
      if (frame.body.type !== 'worker.message') {
        throw brokerFailure('Worker emitted an unsupported Broker frame.');
      }
      const workerMessage = frame.body;
      const invocationId = workerMessage.payload.invocationId;
      const waiter =
        typeof invocationId === 'string' ? this.#terminalWaiters.get(invocationId) : undefined;
      const projected = waiter?.project(workerMessage, frame.messageId);
      this.#queueCloudFrame(
        session,
        `ack.local.${randomUUID()}`,
        {
          type: 'message.ack',
          acknowledgedMessageId: frame.messageId,
          acknowledgedSemanticFingerprint: frame.semanticFingerprint,
          acknowledgedWireFingerprint: materialized.wireFingerprint,
          level: 'CLOUD_COMMITTED',
          decision: 'APPLIED',
        },
        () => {
          if (projected !== undefined) waiter?.resolve(projected);
        },
      );
    } catch (error) {
      this.#fail(error);
      session.socket.close(1008, 'BROKER_PROTOCOL_ERROR');
    }
  }

  #flushCommands(session: Session): void {
    for (const command of this.#commands.values()) {
      if (command.connectionId !== undefined) continue;
      session.inboundSequence += 1;
      const materialized = createBrokerTransportFrame({
        ...session.authority,
        direction: 'CLOUD_TO_WORKER',
        sequence: session.inboundSequence,
        messageId: command.messageId,
        body: command.body,
      });
      command.connectionId = session.authority.connectionId;
      command.materialized = materialized;
      this.#queueText(session, materialized.canonicalText);
    }
  }

  #queueCloudFrame(
    session: Session,
    messageId: string,
    body: Exclude<BrokerTransportBody, { type: 'command' | 'worker.message' }>,
    afterSent?: () => void,
  ): void {
    const sequence = body.type === 'lease.grant' ? 0 : ++session.inboundSequence;
    const frame = createBrokerTransportFrame({
      ...session.authority,
      direction: 'CLOUD_TO_WORKER',
      sequence,
      messageId,
      body,
    });
    this.#queueText(session, frame.canonicalText, afterSent);
  }

  #queueText(session: Session, text: string, afterSent?: () => void): void {
    const task = session.sendTail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (session.socket.readyState !== WebSocket.OPEN) {
            reject(brokerFailure('Local Broker session is not open.'));
            return;
          }
          session.socket.send(text, (error) => {
            if (error == null) {
              afterSent?.();
              resolve();
            } else reject(error);
          });
        }),
    );
    session.sendTail = task.catch(() => session.socket.terminate());
  }

  #fail(error: unknown): void {
    this.#failure ??= error instanceof Error ? error : brokerFailure('Local Broker failed.');
    for (const command of this.#commands.values()) command.acknowledged.reject(this.#failure);
    for (const waiter of this.#terminalWaiters.values()) waiter.reject(this.#failure);
  }

  #assertOpen(): void {
    if (this.#closed) throw brokerFailure('Local Broker is closed.');
    if (this.#failure !== undefined) throw this.#failure;
  }
}

/** Internal strict projection seam; intentionally absent from the package root export. */
export function projectLocalAlphaTerminalForTesting(
  body: BrokerTransportWorkerMessageBody,
  deliveryMessageId: string,
  expected: Readonly<{
    invocationId: string;
    startAttemptId: string;
    sealedResultId: string;
    answers: ReadonlyMap<
      string,
      Readonly<{ text: string; resultFingerprint: string; sealedFingerprint: string }>
    >;
  }>,
): LocalAlphaTerminal | undefined {
  const payload = body.payload;
  if (payload.invocationId !== expected.invocationId) return undefined;
  const fact = object(payload.fact);
  if (fact?.type !== 'ENQUEUE_TERMINAL_FACT') return undefined;
  if (body.messageType !== 'worker.terminal' || body.sourceId !== deliveryMessageId) {
    throw brokerFailure('Terminal fact did not use its exact logical delivery identity.');
  }
  const terminal = object(fact.terminal);
  if (terminal === undefined) throw brokerFailure('Terminal fact payload is malformed.');
  const outcome = terminal.outcome;
  if (!isOutcome(outcome) || terminalStartAttempt(terminal) !== expected.startAttemptId) {
    throw brokerFailure('Terminal fact did not bind the expected local invocation attempt.');
  }
  if (outcome !== 'SUCCEEDED') {
    assertNonSuccessTerminal(outcome, terminal);
    return Object.freeze({
      deliveryMessageId,
      outcome,
      text: null,
      detail: terminalDetail(terminal),
    });
  }
  const envelope = object(payload.sealedEnvelope);
  const host = object(terminal.host);
  const receipt = object(host?.sealedResult);
  const answer = expected.answers.get(expected.sealedResultId);
  if (
    terminal.source !== 'HOST' ||
    host?.outcome !== 'SUCCEEDED' ||
    host.interruptRequest !== null ||
    !exactKeys(envelope, ['protocol', 'resultFingerprint', 'sealedResultId']) ||
    !exactKeys(receipt, ['resultFingerprint', 'sealedFingerprint', 'sealedResultId']) ||
    envelope.protocol !== LOCAL_ALPHA_RESULT_PROTOCOL ||
    envelope.sealedResultId !== expected.sealedResultId ||
    receipt.sealedResultId !== expected.sealedResultId ||
    typeof envelope.resultFingerprint !== 'string' ||
    envelope.resultFingerprint !== receipt.resultFingerprint ||
    envelope.resultFingerprint !== host.resultFingerprint ||
    answer === undefined ||
    answer.resultFingerprint !== envelope.resultFingerprint ||
    answer.sealedFingerprint !== receipt.sealedFingerprint ||
    receipt.sealedFingerprint !==
      localAlphaResultEnvelopeFingerprint(envelope as LocalAlphaResultEnvelope)
  ) {
    throw brokerFailure('Successful terminal did not bind the exact in-memory result.');
  }
  return Object.freeze({
    deliveryMessageId,
    outcome,
    text: answer.text,
    detail: 'SUCCEEDED',
  });
}

function assertNonSuccessTerminal(
  outcome: Exclude<LocalAlphaTerminal['outcome'], 'SUCCEEDED'>,
  terminal: Record<string, unknown>,
): void {
  const source = terminal.source;
  const host = object(terminal.host);
  const coherent =
    outcome === 'FAILED'
      ? (source === 'HOST' && host?.outcome === 'FAILED') ||
        (source === 'START_REJECTED' && host === undefined)
      : outcome === 'CANCELLED'
        ? (source === 'HOST' && host?.outcome === 'CANCELLED') ||
          (source === 'PROVED_NOT_DISPATCHED' && host === undefined)
        : source === 'EVIDENCE_LOST' && host === undefined;
  if (!coherent) throw brokerFailure('Terminal outcome and authority source were incoherent.');
}

function terminalStartAttempt(terminal: Record<string, unknown>): unknown {
  if (terminal.outcome === 'UNCERTAIN') return object(terminal.context)?.startAttemptId;
  return terminal.startAttemptId;
}

function terminalDetail(terminal: Record<string, unknown>): string {
  const host = object(terminal.host);
  const detail = terminal.reason ?? host?.errorCode ?? terminal.source ?? terminal.outcome;
  return typeof detail === 'string' ? detail : 'UNKNOWN';
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactKeys(
  value: Record<string, unknown> | undefined,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (value === undefined) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isOutcome(value: unknown): value is LocalAlphaTerminal['outcome'] {
  return (
    value === 'SUCCEEDED' || value === 'FAILED' || value === 'CANCELLED' || value === 'UNCERTAIN'
  );
}

function sameAuthority(
  frame: BrokerTransportFrameMaterialization['frame'],
  authority: SessionAuthority,
): boolean {
  return (
    frame.connectionId === authority.connectionId &&
    frame.installationId === authority.installationId &&
    frame.deploymentId === authority.deploymentId &&
    frame.workerSessionId === authority.workerSessionId &&
    frame.leaseId === authority.leaseId &&
    frame.fence === authority.fence
  );
}

function decodeText(raw: RawData): string {
  const bytes = Array.isArray(raw)
    ? Buffer.concat(raw)
    : raw instanceof ArrayBuffer
      ? Buffer.from(raw)
      : Buffer.from(raw);
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, error: Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(error), timeoutMs);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

function closeServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function deferred<T>(): Deferred<T> {
  let settled = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return Object.freeze({
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
  });
}

function brokerFailure(message: string, cause?: unknown): CreatorWorkerLocalAlphaError {
  return new CreatorWorkerLocalAlphaError('LOCAL_ALPHA_BROKER_FAILED', message, { cause });
}

function abortFailure(): CreatorWorkerLocalAlphaError {
  return new CreatorWorkerLocalAlphaError(
    'LOCAL_ALPHA_TURN_CANCELLED',
    'The local Creator turn was interrupted.',
  );
}
