import { realpathSync, statSync } from 'node:fs';
import { types as utilTypes } from 'node:util';

import type { CreatorHost, HostThread, HostTurnHandle } from '@cb/creator-agent-protocol/host';
import {
  HOST_INTERRUPT_WRITE_LINEARIZED,
  HostInterruptNotSentError,
  HostStartTurnInputSchema,
  HostThreadSchema,
  HostTurnEvidenceLostError,
  createHostTurnAdapterController,
  createHostTurnNotStartedError,
  createHostTurnStartEvidenceLostError,
  sameHostThread,
  type HostStartTurnInput,
  type HostTurnAdapterController,
} from '@cb/creator-agent-protocol/host-adapter';

import {
  CodexAppServerFatalError,
  CodexAppServerNotWrittenError,
  CodexAppServerProcess,
  SUPPORTED_BUNDLED_CODEX_VERSION,
  createCodexAppServerProcessDependencies,
  type CodexAppServerProcessDependencies,
  type CodexAppServerProcessFailure,
  type CodexAppServerPreflightFailure,
} from './codex-app-server-process.js';
import {
  normalizeCompletedAt,
  parseErrorNotification,
  parseInitializeResponse,
  parseItemCompletedNotification,
  parseThreadStartResponse,
  parseTurnCompletedNotification,
  parseTurnStartResponse,
  parseTurnStartedNotification,
  selectFinalAnswer,
  type CodexTurn,
} from './codex-app-server-protocol.js';

const MAX_THREADS_PER_GENERATION = 128;
const MAX_TURNS_PER_GENERATION = 1_024;
const MAX_AGENT_MESSAGES = 64;
const MAX_AGENT_MESSAGE_BYTES = 100_000;
const DEFAULT_RPC_TIMEOUT_MS = 15_000;
const DEFAULT_PROCESS_TERMINATION_GRACE_MS = 1_000;

export type BundledCodexHostDiagnostic =
  | 'process_started'
  | 'initialized'
  | 'thread_created'
  | 'turn_start_written'
  | 'turn_bound'
  | 'turn_completed'
  | 'turn_error'
  | 'server_request_rejected'
  | 'process_lost'
  | 'stopped';

export type BundledCodexHostErrorCode =
  | 'BUNDLED_CODEX_CONFIGURATION_INVALID'
  | 'BUNDLED_CODEX_UNAVAILABLE'
  | 'BUNDLED_CODEX_VERSION_UNSUPPORTED'
  | 'BUNDLED_CODEX_AUTH_UNAVAILABLE'
  | 'BUNDLED_CODEX_PROTOCOL_ERROR'
  | 'BUNDLED_CODEX_SESSION_LOST';

export class BundledCodexHostError extends Error {
  public constructor(
    public readonly code: BundledCodexHostErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'BundledCodexHostError';
  }
}

export type BundledCodexHostOptions = Readonly<{
  projectPath: string;
  developerInstructions: string;
  allowUnisolatedRead: true;
  allowLoopbackProxy?: boolean;
  rpcTimeoutMs?: number;
  processTerminationGraceMs?: number;
  diagnosticSink?: (event: BundledCodexHostDiagnostic) => void;
}>;

type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
type JsonObject = Readonly<{ [key: string]: JsonValue }>;

type HostState = 'IDLE' | 'STARTING' | 'READY' | 'STOPPING' | 'STOPPED' | 'FAILED';

type ActiveTurn = {
  readonly thread: HostThread;
  readonly messageId: string;
  readonly deadlineMs: number;
  readonly completedAgentMessages: Array<{
    phase: 'commentary' | 'final_answer' | null;
    text: string;
  }>;
  readonly completedAgentMessageIds: Set<string>;
  completedAgentMessageBytes: number;
  writeLinearized: boolean;
  responseConfirmed: boolean;
  turnId?: HostTurnHandle['turnId'];
  controller?: HostTurnAdapterController;
  terminal?: CodexTurn;
  startFailure?: HostTurnEvidenceLostError;
  watchdog?: NodeJS.Timeout;
  settled: boolean;
};

export function createBundledCodexHost(options: BundledCodexHostOptions): CreatorHost {
  return new BundledCodexHost(options, createCodexAppServerProcessDependencies());
}

/** Internal structured-output profile; intentionally absent from the package root export. */
export function createBundledCodexStructuredHost(
  options: BundledCodexHostOptions,
  outputSchema: unknown,
): CreatorHost {
  return new BundledCodexHost(
    options,
    createCodexAppServerProcessDependencies(),
    snapshotOutputSchema(outputSchema),
  );
}

/** Internal test seam. It is intentionally absent from the package root export. */
export function createBundledCodexHostForTesting(
  options: BundledCodexHostOptions,
  dependencies: CodexAppServerProcessDependencies,
): CreatorHost {
  return new BundledCodexHost(options, dependencies);
}

/** Internal structured-output test seam; intentionally absent from the package root export. */
export function createBundledCodexStructuredHostForTesting(
  options: BundledCodexHostOptions,
  outputSchema: unknown,
  dependencies: CodexAppServerProcessDependencies,
): CreatorHost {
  return new BundledCodexHost(options, dependencies, snapshotOutputSchema(outputSchema));
}

class BundledCodexHost implements CreatorHost {
  readonly #projectPath: string;
  readonly #developerInstructions: string;
  readonly #allowLoopbackProxy: boolean;
  readonly #rpcTimeoutMs: number;
  readonly #processTerminationGraceMs: number;
  readonly #diagnosticSink?: (event: BundledCodexHostDiagnostic) => void;
  readonly #dependencies: CodexAppServerProcessDependencies;
  readonly #outputSchema?: JsonObject;

  #state: HostState = 'IDLE';
  #generation = 0;
  #connection?: CodexAppServerProcess;
  #startTask?: Promise<void>;
  #stopTask?: Promise<void>;
  #threads = new Map<string, HostThread>();
  #activeByThread = new Map<string, ActiveTurn>();
  #issuedTurnIds = new Set<string>();

  public constructor(
    rawOptions: BundledCodexHostOptions,
    dependencies: CodexAppServerProcessDependencies,
    outputSchema?: JsonObject,
  ) {
    const options = snapshotOptions(rawOptions);
    this.#projectPath = options.projectPath;
    this.#developerInstructions = options.developerInstructions;
    this.#allowLoopbackProxy = options.allowLoopbackProxy;
    this.#rpcTimeoutMs = options.rpcTimeoutMs;
    this.#processTerminationGraceMs = options.processTerminationGraceMs;
    this.#diagnosticSink = options.diagnosticSink;
    this.#dependencies = dependencies;
    this.#outputSchema = outputSchema;
  }

  public start(): Promise<void> {
    if (this.#state === 'READY') return Promise.resolve();
    if (this.#startTask !== undefined) return this.#startTask;
    if (this.#state === 'STOPPING' || this.#state === 'FAILED') {
      return Promise.reject(hostError('BUNDLED_CODEX_SESSION_LOST'));
    }
    const task = this.#startOnce();
    this.#startTask = task;
    void task.then(
      () => {
        if (this.#startTask === task) this.#startTask = undefined;
      },
      () => {
        if (this.#startTask === task) this.#startTask = undefined;
      },
    );
    return task;
  }

  async #startOnce(): Promise<void> {
    if (this.#stopTask !== undefined) await this.#stopTask;
    this.#state = 'STARTING';
    this.#threads.clear();
    this.#activeByThread.clear();
    this.#issuedTurnIds.clear();
    const connection = new CodexAppServerProcess(
      {
        projectPath: this.#projectPath,
        allowLoopbackProxy: this.#allowLoopbackProxy,
        rpcTimeoutMs: this.#rpcTimeoutMs,
        processTerminationGraceMs: this.#processTerminationGraceMs,
      },
      {
        onNotification: (method, params) => this.#notification(connection, method, params),
        onFailure: (failure) => this.#processFailed(connection, failure),
        onServerRequest: () => this.#diagnostic('server_request_rejected'),
      },
      this.#dependencies,
    );
    this.#connection = connection;
    try {
      const initialized = parseInitializeResponse(await connection.start());
      this.#diagnostic('process_started');
      if (
        !initialized.userAgent.startsWith(
          `combo-creator-worker/${SUPPORTED_BUNDLED_CODEX_VERSION} `,
        ) ||
        initialized.codexHome !== connection.codexHome
      ) {
        throw hostError('BUNDLED_CODEX_VERSION_UNSUPPORTED');
      }
      if (this.#connection !== connection || this.#state !== 'STARTING') {
        throw hostError('BUNDLED_CODEX_SESSION_LOST');
      }
      this.#generation += 1;
      this.#state = 'READY';
      this.#diagnostic('initialized');
      if (this.#connection !== connection || this.#state !== 'READY') {
        throw hostError('BUNDLED_CODEX_SESSION_LOST');
      }
    } catch (error) {
      if (this.#connection === connection) this.#state = 'FAILED';
      try {
        await connection.stop();
      } catch (stopError) {
        if (this.#connection === connection) this.#state = 'FAILED';
        throw normalizeLifecycleError(stopError);
      }
      if (this.#connection === connection) this.#connection = undefined;
      throw normalizeLifecycleError(error);
    }
  }

  public stop(): Promise<void> {
    if (this.#stopTask !== undefined) return this.#stopTask;
    const task = this.#stopOnce();
    this.#stopTask = task;
    void task.then(
      () => {
        if (this.#stopTask === task) this.#stopTask = undefined;
      },
      () => {
        if (this.#stopTask === task) this.#stopTask = undefined;
      },
    );
    return task;
  }

  async #stopOnce(): Promise<void> {
    if (this.#state === 'STOPPED' && this.#connection === undefined) return;
    this.#state = 'STOPPING';
    const connection = this.#connection;
    this.#loseActiveTurns('HOST_SESSION_LOST');
    if (connection !== undefined) {
      try {
        await connection.stop();
      } catch (error) {
        throw normalizeLifecycleError(error);
      }
    }
    if (this.#connection === connection) this.#connection = undefined;
    this.#threads.clear();
    this.#issuedTurnIds.clear();
    this.#state = 'STOPPED';
    this.#diagnostic('stopped');
  }

  public async createThread(): Promise<HostThread> {
    await this.start();
    const connection = this.#readyConnection();
    let raw: unknown;
    try {
      raw = await connection.sendRequestLinearized('thread/start', {
        cwd: this.#projectPath,
        runtimeWorkspaceRoots: [this.#projectPath],
        approvalPolicy: 'never',
        permissions: ':read-only',
        ephemeral: true,
        dynamicTools: [],
        developerInstructions: this.#developerInstructions,
        experimentalRawEvents: false,
      }).response;
    } catch (error) {
      connection.poison('SESSION');
      throw normalizeLifecycleError(error);
    }
    let thread: HostThread;
    try {
      const response = parseThreadStartResponse(raw);
      if (
        response.cwd !== this.#projectPath ||
        response.thread.cwd !== this.#projectPath ||
        response.thread.cliVersion !== SUPPORTED_BUNDLED_CODEX_VERSION ||
        response.runtimeWorkspaceRoots.length !== 1 ||
        response.runtimeWorkspaceRoots[0] !== this.#projectPath ||
        response.instructionSources.length !== 0 ||
        this.#threads.has(response.thread.id) ||
        this.#threads.size >= MAX_THREADS_PER_GENERATION
      ) {
        throw new TypeError('Codex thread boundary mismatch.');
      }
      thread = HostThreadSchema.parse({
        id: response.thread.id,
        generation: this.#generation,
        workspaceRootsAcknowledged: true,
      });
      this.#threads.set(thread.id, thread);
    } catch (error) {
      connection.poison('PROTOCOL');
      throw hostError('BUNDLED_CODEX_PROTOCOL_ERROR', error);
    }
    this.#diagnostic('thread_created');
    if (
      this.#state !== 'READY' ||
      this.#connection !== connection ||
      this.#threads.get(thread.id) !== thread
    ) {
      if (this.#threads.get(thread.id) === thread) this.#threads.delete(thread.id);
      throw hostError('BUNDLED_CODEX_SESSION_LOST');
    }
    return thread;
  }

  public async startTurn(rawInput: HostStartTurnInput): Promise<HostTurnHandle> {
    let input: HostStartTurnInput;
    try {
      input = HostStartTurnInputSchema.parse(rawInput);
    } catch {
      throw createHostTurnNotStartedError();
    }
    const connection = this.#connection;
    const knownThread = this.#threads.get(input.thread.id);
    if (
      this.#state !== 'READY' ||
      connection === undefined ||
      knownThread === undefined ||
      !sameHostThread(knownThread, input.thread) ||
      input.thread.generation !== this.#generation ||
      this.#activeByThread.has(input.thread.id)
    ) {
      throw createHostTurnNotStartedError();
    }
    const invocation: ActiveTurn = {
      thread: input.thread,
      messageId: input.messageId,
      deadlineMs: Date.now() + input.timeoutMs,
      completedAgentMessages: [],
      completedAgentMessageIds: new Set(),
      completedAgentMessageBytes: 0,
      writeLinearized: false,
      responseConfirmed: false,
      settled: false,
    };
    this.#activeByThread.set(input.thread.id, invocation);
    let response: Promise<unknown>;
    try {
      response = connection.sendRequestLinearized('turn/start', {
        threadId: input.thread.id,
        clientUserMessageId: input.messageId,
        input: [{ type: 'text', text: input.text, text_elements: [] }],
        cwd: this.#projectPath,
        runtimeWorkspaceRoots: [this.#projectPath],
        approvalPolicy: 'never',
        permissions: ':read-only',
        ...(this.#outputSchema === undefined ? {} : { outputSchema: this.#outputSchema }),
      }).response;
      invocation.writeLinearized = true;
      this.#armWatchdog(connection, invocation, input.timeoutMs);
      this.#diagnostic('turn_start_written');
    } catch (error) {
      this.#removeInvocation(invocation);
      if (error instanceof CodexAppServerNotWrittenError) throw createHostTurnNotStartedError();
      throw createHostTurnStartEvidenceLostError(failureReason(error));
    }

    let rawResponse: unknown;
    try {
      rawResponse = await response;
    } catch (error) {
      const failure =
        invocation.startFailure ?? createHostTurnStartEvidenceLostError(failureReason(error));
      this.#removeInvocation(invocation);
      throw failure;
    }
    if (invocation.startFailure !== undefined || this.#connection !== connection) {
      this.#removeInvocation(invocation);
      throw invocation.startFailure ?? createHostTurnStartEvidenceLostError('HOST_SESSION_LOST');
    }
    try {
      const turn = parseTurnStartResponse(rawResponse);
      assertInProgressTurn(turn);
      this.#bindTurn(invocation, turn.id);
      invocation.responseConfirmed = true;
      const controller = createHostTurnAdapterController({
        thread: invocation.thread,
        turnId: turn.id,
        writeInterrupt: () => this.#writeInterrupt(connection, invocation),
      });
      invocation.controller = controller;
      this.#diagnostic('turn_bound');
      this.#finishTerminal(connection, invocation);
      return controller.handle;
    } catch {
      const failure = createHostTurnStartEvidenceLostError('HOST_PROTOCOL_ERROR');
      invocation.startFailure = failure;
      connection.poison('PROTOCOL');
      this.#removeInvocation(invocation);
      throw failure;
    }
  }

  #writeInterrupt(
    connection: CodexAppServerProcess,
    invocation: ActiveTurn,
  ): typeof HOST_INTERRUPT_WRITE_LINEARIZED {
    if (
      this.#state !== 'READY' ||
      this.#connection !== connection ||
      invocation.turnId === undefined ||
      invocation.settled ||
      this.#activeByThread.get(invocation.thread.id) !== invocation
    ) {
      throw new HostInterruptNotSentError();
    }
    try {
      const pending = connection.sendRequestLinearized('turn/interrupt', {
        threadId: invocation.thread.id,
        turnId: invocation.turnId,
      });
      void pending.response.then(
        (acknowledgement) => {
          if (!isEmptyObject(acknowledgement)) this.#interruptFailed(connection, invocation);
        },
        () => this.#interruptFailed(connection, invocation),
      );
      return HOST_INTERRUPT_WRITE_LINEARIZED;
    } catch (error) {
      if (error instanceof CodexAppServerNotWrittenError) throw new HostInterruptNotSentError();
      throw new HostTurnEvidenceLostError(failureReason(error));
    }
  }

  #interruptFailed(connection: CodexAppServerProcess, invocation: ActiveTurn): void {
    if (this.#connection !== connection) return;
    if (!invocation.settled) {
      invocation.controller?.markEvidenceLost('HOST_PROTOCOL_ERROR');
    }
    connection.poison('PROTOCOL');
  }

  #notification(connection: CodexAppServerProcess, method: string, rawParams: unknown): void {
    if (this.#connection !== connection) return;
    try {
      if (method === 'turn/started') {
        const notification = parseTurnStartedNotification(rawParams);
        const invocation = this.#requiredInvocation(notification.threadId);
        assertInProgressTurn(notification.turn);
        if (invocation.terminal !== undefined) {
          throw new TypeError('Codex start arrived after the turn terminal.');
        }
        this.#bindTurn(invocation, notification.turn.id);
        return;
      }
      if (method === 'item/completed') {
        const notification = parseItemCompletedNotification(rawParams);
        const invocation = this.#requiredInvocation(notification.threadId);
        this.#bindTurn(invocation, notification.turnId);
        if (invocation.terminal !== undefined) {
          throw new TypeError('Codex item arrived after the turn terminal.');
        }
        if (notification.item.kind === 'agent_message') {
          if (invocation.completedAgentMessageIds.has(notification.item.id)) {
            throw new TypeError('Codex agent-message ID was reused.');
          }
          const bytes = Buffer.byteLength(notification.item.text, 'utf8');
          if (
            invocation.completedAgentMessages.length >= MAX_AGENT_MESSAGES ||
            invocation.completedAgentMessageBytes + bytes > MAX_AGENT_MESSAGE_BYTES
          ) {
            throw new TypeError('Codex answer aggregation exceeded its bound.');
          }
          invocation.completedAgentMessageIds.add(notification.item.id);
          invocation.completedAgentMessageBytes += bytes;
          invocation.completedAgentMessages.push(notification.item);
        }
        return;
      }
      if (method === 'turn/completed') {
        const notification = parseTurnCompletedNotification(rawParams);
        const invocation = this.#requiredInvocation(notification.threadId);
        this.#bindTurn(invocation, notification.turn.id);
        if (notification.turn.status === 'inProgress' || notification.turn.completedAt === null) {
          throw new TypeError('Codex terminal notification was not terminal.');
        }
        if (invocation.terminal !== undefined) throw new TypeError('Duplicate Codex terminal.');
        invocation.terminal = notification.turn;
        this.#finishTerminal(connection, invocation);
        return;
      }
      if (method === 'error') {
        const notification = parseErrorNotification(rawParams);
        const invocation = this.#requiredInvocation(notification.threadId);
        this.#bindTurn(invocation, notification.turnId);
        if (!notification.willRetry && invocation.controller !== undefined) {
          // The terminal notification remains the sole authority. The watchdog closes a missing one.
          this.#diagnostic('turn_error');
        }
      }
      // Exact binary pin permits additive, non-critical notifications such as remote-control status.
    } catch {
      connection.poison('PROTOCOL');
    }
  }

  #finishTerminal(connection: CodexAppServerProcess, invocation: ActiveTurn): void {
    const turn = invocation.terminal;
    const controller = invocation.controller;
    if (
      turn === undefined ||
      controller === undefined ||
      !invocation.responseConfirmed ||
      invocation.settled
    ) {
      return;
    }
    if (turn.completedAt === null || turn.status === 'inProgress') {
      connection.poison('PROTOCOL');
      return;
    }
    const completedAt = normalizeCompletedAt(turn.completedAt);
    try {
      if (turn.status === 'interrupted') {
        if (turn.error !== null) {
          throw new TypeError('Interrupted Codex turn carried an error.');
        }
        controller.settleInterrupted({
          thread: invocation.thread,
          turnId: controller.handle.turnId,
          completedAt,
          terminalStatus: 'interrupted',
          terminalError: 'NONE',
          outputState: 'NOT_APPLICABLE',
        });
      } else if (turn.status === 'failed') {
        if (turn.error === null) throw new TypeError('Failed Codex turn omitted its error marker.');
        controller.settle(
          {
            thread: invocation.thread,
            turnId: controller.handle.turnId,
            completedAt,
            terminalStatus: 'failed',
            terminalError: 'PRESENT',
            outputState: 'NOT_APPLICABLE',
          },
          null,
        );
      } else {
        if (turn.error !== null) throw new TypeError('Completed Codex turn carried an error.');
        const text = selectFinalAnswer(invocation.completedAgentMessages);
        controller.settle(
          {
            thread: invocation.thread,
            turnId: controller.handle.turnId,
            completedAt,
            terminalStatus: 'completed',
            terminalError: 'NONE',
            outputState: text === null ? 'UNUSABLE' : 'USABLE',
          },
          text === null ? null : { text },
        );
      }
      invocation.settled = true;
      this.#diagnostic('turn_completed');
      this.#removeInvocation(invocation);
    } catch {
      controller.markEvidenceLost('HOST_PROTOCOL_ERROR');
      connection.poison('PROTOCOL');
    }
  }

  #bindTurn(invocation: ActiveTurn, turnId: HostTurnHandle['turnId']): void {
    if (invocation.turnId !== undefined && invocation.turnId !== turnId) {
      throw new TypeError('Codex turn binding changed.');
    }
    if (invocation.turnId === undefined) {
      if (this.#issuedTurnIds.has(turnId) || this.#issuedTurnIds.size >= MAX_TURNS_PER_GENERATION) {
        throw new TypeError('Codex turn ID was reused.');
      }
      this.#issuedTurnIds.add(turnId);
      invocation.turnId = turnId;
    }
  }

  #requiredInvocation(threadId: string): ActiveTurn {
    const invocation = this.#activeByThread.get(threadId);
    if (invocation === undefined) throw new TypeError('Codex notification has no active turn.');
    return invocation;
  }

  #armWatchdog(connection: CodexAppServerProcess, invocation: ActiveTurn, timeoutMs: number): void {
    const expire = (): void => {
      if (invocation.settled || this.#connection !== connection) return;
      const remaining = invocation.deadlineMs - Date.now();
      if (remaining > 0) {
        invocation.watchdog = setTimeout(expire, Math.min(remaining, 2_147_483_647));
        invocation.watchdog.unref();
        return;
      }
      if (invocation.controller !== undefined) {
        invocation.controller.markEvidenceLost('HOST_TERMINAL_MISSING');
      } else {
        invocation.startFailure = createHostTurnStartEvidenceLostError('HOST_TERMINAL_MISSING');
      }
      connection.poison('SESSION');
    };
    invocation.watchdog = setTimeout(expire, Math.min(timeoutMs, 2_147_483_647));
    invocation.watchdog.unref();
  }

  #processFailed(connection: CodexAppServerProcess, failure: CodexAppServerProcessFailure): void {
    if (this.#connection !== connection) return;
    this.#state = this.#state === 'STOPPING' ? 'STOPPING' : 'FAILED';
    this.#loseActiveTurns(failure === 'PROTOCOL' ? 'HOST_PROTOCOL_ERROR' : 'HOST_SESSION_LOST');
    this.#diagnostic('process_lost');
  }

  #loseActiveTurns(reason: 'HOST_PROTOCOL_ERROR' | 'HOST_SESSION_LOST'): void {
    for (const invocation of this.#activeByThread.values()) {
      if (invocation.controller !== undefined) invocation.controller.markEvidenceLost(reason);
      else if (invocation.writeLinearized) {
        invocation.startFailure = createHostTurnStartEvidenceLostError(reason);
      }
      this.#removeInvocation(invocation);
    }
  }

  #removeInvocation(invocation: ActiveTurn): void {
    if (invocation.watchdog !== undefined) clearTimeout(invocation.watchdog);
    if (this.#activeByThread.get(invocation.thread.id) === invocation) {
      this.#activeByThread.delete(invocation.thread.id);
    }
  }

  #readyConnection(): CodexAppServerProcess {
    const connection = this.#connection;
    if (this.#state !== 'READY' || connection === undefined) {
      throw hostError('BUNDLED_CODEX_SESSION_LOST');
    }
    return connection;
  }

  #diagnostic(event: BundledCodexHostDiagnostic): void {
    try {
      this.#diagnosticSink?.(event);
    } catch {
      // Diagnostics are observational and must never change Host authority.
    }
  }
}

function snapshotOutputSchema(input: unknown): JsonObject {
  const budget = { nodes: 0 };
  const value = snapshotJsonValue(input, 0, budget);
  if (Array.isArray(value) || value === null || typeof value !== 'object') {
    throw hostError('BUNDLED_CODEX_CONFIGURATION_INVALID');
  }
  return value as JsonObject;
}

function snapshotJsonValue(input: unknown, depth: number, budget: { nodes: number }): JsonValue {
  budget.nodes += 1;
  if (budget.nodes > 512 || depth > 16) {
    throw hostError('BUNDLED_CODEX_CONFIGURATION_INVALID');
  }
  if (
    input === null ||
    typeof input === 'boolean' ||
    (typeof input === 'number' && Number.isFinite(input))
  ) {
    return input;
  }
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > 8_192 || input.includes('\0')) {
      throw hostError('BUNDLED_CODEX_CONFIGURATION_INVALID');
    }
    return input;
  }
  if (typeof input !== 'object' || utilTypes.isProxy(input)) {
    throw hostError('BUNDLED_CODEX_CONFIGURATION_INVALID');
  }
  if (Array.isArray(input)) {
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Object.keys(descriptors).filter((key) => key !== 'length');
    if (keys.length !== input.length || keys.some((key, index) => key !== String(index))) {
      throw hostError('BUNDLED_CODEX_CONFIGURATION_INVALID');
    }
    return Object.freeze(
      keys.map((key) => {
        const descriptor = descriptors[key];
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          throw hostError('BUNDLED_CODEX_CONFIGURATION_INVALID');
        }
        return snapshotJsonValue(descriptor.value, depth + 1, budget);
      }),
    );
  }
  if (Object.getPrototypeOf(input) !== Object.prototype) {
    throw hostError('BUNDLED_CODEX_CONFIGURATION_INVALID');
  }
  const output: Record<string, JsonValue> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
    if (
      !descriptor.enumerable ||
      !('value' in descriptor) ||
      key === '__proto__' ||
      key === 'prototype' ||
      key === 'constructor'
    ) {
      throw hostError('BUNDLED_CODEX_CONFIGURATION_INVALID');
    }
    output[key] = snapshotJsonValue(descriptor.value, depth + 1, budget);
  }
  return Object.freeze(output);
}

function snapshotOptions(options: BundledCodexHostOptions): Required<
  Omit<BundledCodexHostOptions, 'diagnosticSink'>
> & {
  diagnosticSink?: (event: BundledCodexHostDiagnostic) => void;
} {
  let raw: {
    projectPath: unknown;
    developerInstructions: unknown;
    allowUnisolatedRead: unknown;
    allowLoopbackProxy: unknown;
    rpcTimeoutMs: unknown;
    processTerminationGraceMs: unknown;
    diagnosticSink: unknown;
  };
  try {
    raw = {
      projectPath: options.projectPath,
      developerInstructions: options.developerInstructions,
      allowUnisolatedRead: options.allowUnisolatedRead,
      allowLoopbackProxy: options.allowLoopbackProxy,
      rpcTimeoutMs: options.rpcTimeoutMs,
      processTerminationGraceMs: options.processTerminationGraceMs,
      diagnosticSink: options.diagnosticSink,
    };
  } catch (error) {
    throw hostError('BUNDLED_CODEX_CONFIGURATION_INVALID', error);
  }
  if (
    typeof raw.projectPath !== 'string' ||
    typeof raw.developerInstructions !== 'string' ||
    raw.allowUnisolatedRead !== true ||
    (raw.allowLoopbackProxy !== undefined && typeof raw.allowLoopbackProxy !== 'boolean') ||
    (raw.rpcTimeoutMs !== undefined && typeof raw.rpcTimeoutMs !== 'number') ||
    (raw.processTerminationGraceMs !== undefined &&
      typeof raw.processTerminationGraceMs !== 'number') ||
    (raw.diagnosticSink !== undefined && typeof raw.diagnosticSink !== 'function')
  ) {
    throw hostError('BUNDLED_CODEX_CONFIGURATION_INVALID');
  }
  let projectPath: string;
  try {
    projectPath = realpathSync(raw.projectPath);
    if (!statSync(projectPath).isDirectory()) {
      throw new TypeError('Creator Project path is not a directory.');
    }
  } catch (error) {
    throw hostError('BUNDLED_CODEX_CONFIGURATION_INVALID', error);
  }
  if (
    projectPath.length > 2_048 ||
    !raw.developerInstructions ||
    raw.developerInstructions.length > 20_000 ||
    /[\0\r]/u.test(raw.developerInstructions)
  ) {
    throw hostError('BUNDLED_CODEX_CONFIGURATION_INVALID');
  }
  const rpcTimeoutMs = bounded(raw.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS, 100, 60_000);
  const processTerminationGraceMs = bounded(
    raw.processTerminationGraceMs ?? DEFAULT_PROCESS_TERMINATION_GRACE_MS,
    10,
    30_000,
  );
  const diagnosticSink = raw.diagnosticSink as
    | ((event: BundledCodexHostDiagnostic) => void)
    | undefined;
  return Object.freeze({
    projectPath,
    developerInstructions: raw.developerInstructions,
    allowUnisolatedRead: true,
    allowLoopbackProxy: raw.allowLoopbackProxy ?? false,
    rpcTimeoutMs,
    processTerminationGraceMs,
    diagnosticSink,
  });
}

function bounded(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw hostError('BUNDLED_CODEX_CONFIGURATION_INVALID');
  }
  return value;
}

function failureReason(error: unknown): 'HOST_PROTOCOL_ERROR' | 'HOST_SESSION_LOST' {
  return error instanceof CodexAppServerFatalError && error.failure === 'PROTOCOL'
    ? 'HOST_PROTOCOL_ERROR'
    : 'HOST_SESSION_LOST';
}

function assertInProgressTurn(turn: CodexTurn): void {
  if (turn.status !== 'inProgress' || turn.completedAt !== null || turn.error !== null) {
    throw new TypeError('Codex turn did not report a coherent in-progress state.');
  }
}

function normalizeLifecycleError(error: unknown): BundledCodexHostError {
  if (error instanceof BundledCodexHostError) return error;
  if (error instanceof CodexAppServerFatalError) {
    if (error.preflightFailure !== undefined) {
      return hostError(preflightHostErrorCode(error.preflightFailure), error);
    }
    return hostError(
      error.failure === 'PROTOCOL' ? 'BUNDLED_CODEX_PROTOCOL_ERROR' : 'BUNDLED_CODEX_SESSION_LOST',
      error,
    );
  }
  return hostError('BUNDLED_CODEX_UNAVAILABLE', error);
}

function preflightHostErrorCode(
  failure: CodexAppServerPreflightFailure,
): BundledCodexHostErrorCode {
  const codes: Record<CodexAppServerPreflightFailure, BundledCodexHostErrorCode> = {
    UNAVAILABLE: 'BUNDLED_CODEX_UNAVAILABLE',
    VERSION_UNSUPPORTED: 'BUNDLED_CODEX_VERSION_UNSUPPORTED',
    AUTH_UNAVAILABLE: 'BUNDLED_CODEX_AUTH_UNAVAILABLE',
  };
  return codes[failure];
}

function hostError(code: BundledCodexHostErrorCode, cause?: unknown): BundledCodexHostError {
  const messages: Record<BundledCodexHostErrorCode, string> = {
    BUNDLED_CODEX_CONFIGURATION_INVALID: 'Bundled Codex Host configuration is invalid.',
    BUNDLED_CODEX_UNAVAILABLE: 'The reviewed bundled Codex executable is unavailable.',
    BUNDLED_CODEX_VERSION_UNSUPPORTED: 'The bundled Codex version is not reviewed.',
    BUNDLED_CODEX_AUTH_UNAVAILABLE: 'Bundled Codex authentication is unavailable.',
    BUNDLED_CODEX_PROTOCOL_ERROR: 'Bundled Codex violated the reviewed app-server protocol.',
    BUNDLED_CODEX_SESSION_LOST: 'The bundled Codex Host session was lost.',
  };
  return new BundledCodexHostError(code, messages[code], { cause });
}

function isEmptyObject(input: unknown): boolean {
  return (
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    Object.keys(input).length === 0
  );
}
