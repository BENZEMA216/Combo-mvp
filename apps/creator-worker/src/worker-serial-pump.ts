import { createHash } from 'node:crypto';

import {
  workerInterruptAttempt,
  workerInvocationAttemptId,
} from '@cb/creator-agent-broker-journal';
import {
  type WorkerCommittedAfterCommitEffect,
  type WorkerHostTerminalProjection,
  createWorkerResultSealAuthority,
  executeWorkerHostInterrupt,
  executeWorkerHostOutcomeObservation,
  executeWorkerHostStartTurn,
  type CommittedWorkerInterruptHostEffect,
  type CommittedWorkerObserveHostOutcomeEffect,
  type CommittedWorkerStartHostEffect,
  type WorkerResultSealAuthority,
  type WorkerHostStartTurnExecution,
} from '@cb/creator-agent-broker-journal/host-executor';
import type {
  WorkerInvocationCursor,
  WorkerSqliteCommitResult,
} from '@cb/creator-agent-broker-journal/sqlite-store';
import {
  BrokerTransportPayloadSchema,
  type BrokerTransportPayload,
} from '@cb/creator-agent-protocol/broker-transport';
import {
  HostStartTurnInputSchema,
  HostTurnEvidenceLostError,
  type HostStartTurnInput,
  type HostTurnHandle,
} from '@cb/creator-agent-protocol/host';
import type { WorkerTransportInboundCommandReference as WorkerTransportCommandReference } from '@cb/creator-worker-broker-client/sqlite-repository';

import {
  WorkerCancelCommandPayloadSchema,
  WorkerPrepareCommandPayloadSchema,
  WorkerSerialPumpError,
  WorkerStartCommandPayloadSchema,
  type WorkerCancelCommandPayload,
  type WorkerSerialPump,
  type WorkerSerialPumpDiagnostic,
  type WorkerSerialPumpOptions,
  type WorkerSerialPumpState,
  type WorkerSerialPumpTickResult,
  type WorkerStartCommandPayload,
} from './pump-contract.js';

type LiveInvocation = {
  cursor: WorkerInvocationCursor;
  phase: WorkerInvocationCursor['phase'];
  handle?: HostTurnHandle;
};

type TickMutationResult = Omit<WorkerSerialPumpTickResult, 'flush'> & {
  flushNeeded: boolean;
};

const DEFAULT_BATCH_LIMIT = 16;
const DEFAULT_START_INPUT_TIMEOUT_MS = 10_000;

export function createWorkerSerialPump<TEnvelope extends object>(
  options: WorkerSerialPumpOptions<TEnvelope>,
): WorkerSerialPump {
  return new SerialPump(options);
}

class SerialPump<TEnvelope extends object> implements WorkerSerialPump {
  readonly #journal: WorkerSerialPumpOptions<TEnvelope>['journal'];
  readonly #journalOwner: WorkerSerialPumpOptions<TEnvelope>['journalOwner'];
  readonly #transport: WorkerSerialPumpOptions<TEnvelope>['transport'];
  readonly #transportOwner: WorkerSerialPumpOptions<TEnvelope>['transportOwner'];
  readonly #host: WorkerSerialPumpOptions<TEnvelope>['host'];
  readonly #driver: WorkerSerialPumpOptions<TEnvelope>['driver'];
  readonly #resolveStartInput: WorkerSerialPumpOptions<TEnvelope>['resolveStartInput'];
  readonly #sealAuthority: WorkerResultSealAuthority<TEnvelope>;
  readonly #commandBatchLimit: number;
  readonly #factBatchLimit: number;
  readonly #startInputTimeoutMs: number;
  readonly #diagnosticSink?: (event: WorkerSerialPumpDiagnostic) => void;
  readonly #live = new Map<string, LiveInvocation>();
  readonly #lifecycle = new AbortController();

  #state: WorkerSerialPumpState = 'IDLE';
  #tail: Promise<void> = Promise.resolve();
  #tickTask?: Promise<WorkerSerialPumpTickResult>;
  #stopTask?: Promise<void>;
  #blocked?: WorkerSerialPumpError;
  #backgroundFailure?: unknown;

  public constructor(options: WorkerSerialPumpOptions<TEnvelope>) {
    this.#journal = options.journal;
    this.#journalOwner = options.journalOwner;
    this.#transport = options.transport;
    this.#transportOwner = options.transportOwner;
    this.#host = options.host;
    this.#driver = options.driver;
    this.#resolveStartInput = options.resolveStartInput;
    this.#sealAuthority = createWorkerResultSealAuthority(async (input) => {
      const output = await options.sealResult(input);
      BrokerTransportPayloadSchema.parse(output.envelope);
      return output;
    });
    this.#commandBatchLimit = batchLimit(options.commandBatchLimit);
    this.#factBatchLimit = batchLimit(options.factBatchLimit);
    this.#startInputTimeoutMs = startInputTimeout(options.startInputTimeoutMs);
    this.#diagnosticSink = options.diagnosticSink;
    for (const cursor of options.preparedInvocations ?? []) {
      if (cursor.phase !== 'PREPARED' || this.#live.has(cursor.invocationId)) {
        throw new TypeError('Initial PREPARED Invocation cursors are invalid.');
      }
      this.#live.set(cursor.invocationId, { cursor, phase: 'PREPARED' });
    }
  }

  public get status(): WorkerSerialPumpState {
    return this.#state;
  }

  public tick(): Promise<WorkerSerialPumpTickResult> {
    if (this.#tickTask !== undefined) return this.#tickTask;
    this.#assertTickable();
    this.#state = 'TICKING';
    const mutation = this.#serialize(() => this.#runTick());
    const tracked: Promise<WorkerSerialPumpTickResult> = mutation
      .then(async (result) => {
        this.#assertNoBackgroundFailure();
        this.#assertDriverHealthy();
        let flush: WorkerSerialPumpTickResult['flush'];
        try {
          flush = await this.#driver.flush();
        } catch (error) {
          if (this.#driver.status === 'BLOCKED') throw error;
          flush = 'DEFERRED';
        }
        this.#assertNoBackgroundFailure();
        this.#assertDriverHealthy();
        return Object.freeze({
          commandsApplied: result.commandsApplied,
          factsEnqueued: result.factsEnqueued,
          workMayRemain: result.workMayRemain || flush === 'DEFERRED',
          flush,
        });
      })
      .catch((error: unknown) => {
        throw this.#block(error);
      })
      .finally(() => {
        if (this.#tickTask === tracked) this.#tickTask = undefined;
        if (this.#state === 'TICKING') this.#state = 'IDLE';
      });
    this.#tickTask = tracked;
    return tracked;
  }

  public stop(): Promise<void> {
    if (this.#stopTask !== undefined) return this.#stopTask;
    if (this.#state === 'STOPPED') return Promise.resolve();
    this.#state = 'STOPPING';
    this.#lifecycle.abort();
    const activeTick = this.#tickTask;
    this.#stopTask = (
      activeTick === undefined ? Promise.resolve() : activeTick.catch(() => undefined)
    )
      .then(() => this.#serialize(() => this.#convergeForStop(), true))
      .then(() => {
        this.#state = 'STOPPED';
        this.#diagnostic('stopped');
      })
      .catch((error: unknown) => {
        const failure = pumpError('STOP_INCOMPLETE', 'Worker pump stop did not converge.', error);
        this.#blocked = failure;
        this.#state = 'BLOCKED';
        throw failure;
      });
    return this.#stopTask;
  }

  async #runTick(): Promise<TickMutationResult> {
    this.#assertDriverHealthy();
    this.#journal.renewOwner(this.#journalOwner);
    let factsEnqueued = this.#handoffFacts(this.#factBatchLimit);
    const commands = this.#transport.readPendingCommands(
      this.#transportOwner,
      this.#commandBatchLimit,
    );
    let commandsApplied = 0;
    for (const command of commands) {
      await this.#applyCommand(command);
      commandsApplied += 1;
    }
    const factCapacity = Math.max(0, this.#factBatchLimit - factsEnqueued);
    if (factCapacity > 0) factsEnqueued += this.#handoffFacts(factCapacity);
    return {
      commandsApplied,
      factsEnqueued,
      workMayRemain:
        commands.length === this.#commandBatchLimit || factsEnqueued === this.#factBatchLimit,
      flushNeeded: factsEnqueued > 0,
    };
  }

  #handoffFacts(limit: number): number {
    if (limit === 0) return 0;
    const references = this.#journal.readPendingFacts(this.#journalOwner, limit);
    for (const reference of references) {
      const fact = this.#journal.readOutboxFact<TEnvelope>(this.#journalOwner, reference);
      const payload = BrokerTransportPayloadSchema.parse({
        invocationId: reference.invocationId,
        fact: fact.payload,
        sealedEnvelope: fact.sealedEnvelope,
      });
      this.#transport.enqueueWorkerMessage(this.#transportOwner, {
        deliveryMessageId: reference.factId,
        messageType: reference.factType === 'STARTED' ? 'worker.started' : 'worker.terminal',
        sourceId: reference.factId,
        sourceFingerprint: reference.payloadFingerprint,
        payload,
      });
      this.#journal.markFactEnqueued(this.#journalOwner, reference);
      this.#diagnostic('fact_enqueued');
    }
    return references.length;
  }

  async #applyCommand(command: WorkerTransportCommandReference): Promise<void> {
    const payload = this.#transport.readCommandPayload(
      this.#transportOwner,
      command.deliveryMessageId,
    );
    switch (command.commandType) {
      case 'invocation.prepare':
        this.#applyPrepare(command, payload);
        break;
      case 'invocation.start':
        await this.#applyStart(command, payload);
        break;
      case 'invocation.cancel':
        this.#applyCancel(command, payload);
        break;
      default:
        throw pumpError('COMMAND_UNSUPPORTED', 'Broker command type is unsupported.');
    }
    this.#diagnostic('command_applied');
  }

  #applyPrepare(command: WorkerTransportCommandReference, raw: BrokerTransportPayload): void {
    const input = parseCommand(WorkerPrepareCommandPayloadSchema, raw);
    const operationId = commandOperation('prepare', command);
    const committed = this.#journal.prepareInvocation(this.#journalOwner, {
      invocationId: input.invocationId,
      operationId,
    });
    this.#recordCommit(input.invocationId, committed);
    this.#transport.markCommandApplied(this.#transportOwner, command.deliveryMessageId);
  }

  async #applyStart(
    command: WorkerTransportCommandReference,
    raw: BrokerTransportPayload,
  ): Promise<void> {
    const input = parseCommand(WorkerStartCommandPayloadSchema, raw);
    const live = this.#live.get(input.invocationId);
    if (live === undefined) {
      const replay = this.#journal.replayInvocationEvent(this.#journalOwner, {
        invocationId: input.invocationId,
        operationId: commandOperation('start', command),
        event: {
          type: 'DISPATCH_INTENT_RECORDED',
          attemptId: workerInvocationAttemptId(input.attemptId),
        },
      });
      if (replay === null || replay.invocation.phase !== 'TERMINAL_READY') {
        throw pumpError('INVOCATION_NOT_LIVE', 'Start targets no PREPARED Invocation.');
      }
      this.#transport.markCommandApplied(this.#transportOwner, command.deliveryMessageId);
      return;
    }
    if (live.phase !== 'PREPARED') {
      throw pumpError('INVOCATION_PHASE_INVALID', 'Invocation must be PREPARED.');
    }
    const hostInput = await this.#resolveHostInput(input);
    const committed = this.#journal.commitInvocationEvent(this.#journalOwner, live.cursor, {
      operationId: commandOperation('start', command),
      event: {
        type: 'DISPATCH_INTENT_RECORDED',
        attemptId: workerInvocationAttemptId(input.attemptId),
      },
    });
    this.#recordCommit(input.invocationId, committed);
    this.#transport.markCommandApplied(this.#transportOwner, command.deliveryMessageId);
    const effect = onlyEffect(committed.afterCommit, 'START_HOST');
    this.#launchStart(input.invocationId, effect, hostInput);
  }

  #applyCancel(command: WorkerTransportCommandReference, raw: BrokerTransportPayload): void {
    const input = parseCommand(WorkerCancelCommandPayloadSchema, raw);
    const live = this.#live.get(input.invocationId);
    if (live === undefined) {
      const durable = this.#journal.readInvocation(this.#journalOwner, input.invocationId);
      if (durable?.phase !== 'TERMINAL_READY') {
        throw pumpError('INVOCATION_NOT_LIVE', 'Cancel targets no live Invocation.');
      }
      this.#transport.markCommandApplied(this.#transportOwner, command.deliveryMessageId);
      return;
    }
    const event = cancelEvent(live, input);
    const committed = this.#journal.commitInvocationEvent(this.#journalOwner, live.cursor, {
      operationId: commandOperation('cancel', command),
      event,
    });
    this.#recordCommit(input.invocationId, committed);
    this.#transport.markCommandApplied(this.#transportOwner, command.deliveryMessageId);
    this.#launchFollowups(input.invocationId, committed.afterCommit, live.handle);
  }

  async #resolveHostInput(command: WorkerStartCommandPayload): Promise<HostStartTurnInput> {
    const resolution = await this.#resolveInput(command.inputRef);
    this.#assertTickableOrIdle();
    this.#assertNoBackgroundFailure();
    if (
      typeof resolution !== 'object' ||
      resolution === null ||
      resolution.inputFingerprint !== command.inputFingerprint
    ) {
      throw pumpError('START_INPUT_MISMATCH', 'Resolved Host input fingerprint changed.');
    }
    try {
      return HostStartTurnInputSchema.parse(resolution.input);
    } catch (error) {
      throw pumpError('START_INPUT_INVALID', 'Resolved Host input is invalid.', error);
    }
  }

  async #resolveInput(inputRef: string) {
    const signal = this.#lifecycle.signal;
    if (signal.aborted) throw pumpError('PUMP_STOPPED', 'Worker pump is stopping.');
    const resolverTask = Promise.resolve().then(() => this.#resolveStartInput(inputRef, signal));
    void resolverTask.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    let removeAbort = (): void => undefined;
    const timeoutTask = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(pumpError('START_INPUT_TIMEOUT', 'Start input resolver timed out.')),
        this.#startInputTimeoutMs,
      );
      timer.unref();
    });
    const abortTask = new Promise<never>((_resolve, reject) => {
      const aborted = () => reject(pumpError('PUMP_STOPPED', 'Worker pump is stopping.'));
      signal.addEventListener('abort', aborted, { once: true });
      removeAbort = () => signal.removeEventListener('abort', aborted);
    });
    try {
      return await Promise.race([resolverTask, timeoutTask, abortTask]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      removeAbort();
    }
  }

  #launchStart(
    invocationId: string,
    effect: CommittedWorkerStartHostEffect,
    input: HostStartTurnInput,
  ): void {
    this.#diagnostic('host_start_launched');
    const task = executeWorkerHostStartTurn(effect, () => this.#host.startTurn(input));
    void task.then(
      (execution) => this.#queueCompletion(() => this.#recordStart(invocationId, execution)),
      (error: unknown) => this.#backgroundFailed(error),
    );
  }

  #recordStart(invocationId: string, execution: WorkerHostStartTurnExecution): void {
    const live = this.#requiredLive(invocationId, 'DISPATCHING');
    const committed = this.#journal.commitInvocationEvent(this.#journalOwner, live.cursor, {
      operationId: internalOperation('host-start', invocationId, execution.disposition.attemptId),
      event: { type: 'HOST_START_DISPOSITION_RECORDED', disposition: execution.disposition },
    });
    this.#recordCommit(invocationId, committed, execution.handle ?? undefined);
    this.#diagnostic('host_event_committed');
    this.#launchFollowups(invocationId, committed.afterCommit, execution.handle ?? undefined);
  }

  #launchFollowups(
    invocationId: string,
    effects: readonly WorkerCommittedAfterCommitEffect[],
    handle: HostTurnHandle | undefined,
  ): void {
    for (const effect of effects) {
      if (effect.type === 'INTERRUPT_HOST') {
        if (handle === undefined)
          throw pumpError('HOST_EFFECT_INVALID', 'Interrupt has no handle.');
        this.#launchInterrupt(invocationId, effect, handle);
      } else if (effect.type === 'OBSERVE_HOST_OUTCOME') {
        if (handle === undefined) throw pumpError('HOST_EFFECT_INVALID', 'Observer has no handle.');
        this.#launchOutcome(invocationId, effect, handle);
      } else {
        throw pumpError('HOST_EFFECT_INVALID', 'Unexpected nested Host start effect.');
      }
    }
  }

  #launchInterrupt(
    invocationId: string,
    effect: CommittedWorkerInterruptHostEffect,
    handle: HostTurnHandle,
  ): void {
    this.#diagnostic('host_interrupt_launched');
    const task = executeWorkerHostInterrupt(effect, handle);
    void task.then(
      (disposition) =>
        this.#queueCompletion(() => {
          const live = this.#live.get(invocationId);
          if (live === undefined) return;
          const committed = this.#journal.commitInvocationEvent(this.#journalOwner, live.cursor, {
            operationId: internalOperation(
              'host-interrupt',
              invocationId,
              disposition.attemptId,
              disposition.attempt,
            ),
            event: { type: 'HOST_INTERRUPT_DISPOSITION_RECORDED', disposition },
          });
          this.#recordCommit(invocationId, committed, handle);
          this.#diagnostic('host_event_committed');
        }),
      (error: unknown) => this.#queueHostEvidenceLost(invocationId, error, 'host-interrupt'),
    );
  }

  #launchOutcome(
    invocationId: string,
    effect: CommittedWorkerObserveHostOutcomeEffect,
    handle: HostTurnHandle,
  ): void {
    this.#diagnostic('host_outcome_observation_launched');
    const task = executeWorkerHostOutcomeObservation(effect, handle, this.#sealAuthority);
    void task.then(
      (terminal) =>
        this.#queueCompletion(() => this.#recordTerminal(invocationId, terminal, handle)),
      (error: unknown) => this.#queueHostEvidenceLost(invocationId, error, 'host-outcome'),
    );
  }

  #recordTerminal(
    invocationId: string,
    terminal: WorkerHostTerminalProjection,
    handle: HostTurnHandle,
  ): void {
    const live = this.#live.get(invocationId);
    if (live === undefined || live.handle !== handle) return;
    const base = {
      operationId: internalOperation('host-terminal', invocationId, terminal.terminalFingerprint),
      event: { type: 'HOST_TERMINAL_CONFIRMED' as const, terminal },
    };
    let committed: WorkerSqliteCommitResult;
    if (terminal.outcome === 'SUCCEEDED') {
      BrokerTransportPayloadSchema.parse(this.#sealAuthority.read(terminal.sealedResult));
      committed = this.#journal.commitInvocationEvent(this.#journalOwner, live.cursor, {
        ...base,
        resultSealAuthority: this.#sealAuthority,
      });
    } else {
      committed = this.#journal.commitInvocationEvent(this.#journalOwner, live.cursor, base);
    }
    this.#recordCommit(invocationId, committed, handle);
    this.#diagnostic('host_event_committed');
  }

  #queueHostEvidenceLost(invocationId: string, error: unknown, source: string): void {
    if (!(error instanceof HostTurnEvidenceLostError)) {
      this.#backgroundFailed(error);
      return;
    }
    this.#queueCompletion(() => {
      const live = this.#live.get(invocationId);
      if (live === undefined) return;
      const committed = this.#journal.commitInvocationEvent(this.#journalOwner, live.cursor, {
        operationId: internalOperation(source, invocationId, 'evidence-lost', error.reason),
        event: { type: 'HOST_EVIDENCE_LOST', hostReason: error.reason },
      });
      this.#recordCommit(invocationId, committed, live.handle);
      this.#diagnostic('host_event_committed');
    });
  }

  #recordCommit(
    invocationId: string,
    committed: WorkerSqliteCommitResult,
    handle?: HostTurnHandle,
  ): void {
    if (committed.cursor === null) {
      this.#live.delete(invocationId);
      return;
    }
    const existing = this.#live.get(invocationId);
    this.#live.set(invocationId, {
      cursor: committed.cursor,
      phase: committed.cursor.phase,
      ...(handle === undefined && existing?.handle === undefined
        ? {}
        : { handle: handle ?? existing?.handle }),
    });
  }

  #requiredLive(invocationId: string, phase: LiveInvocation['phase']): LiveInvocation {
    const live = this.#live.get(invocationId);
    if (live === undefined) {
      throw pumpError('INVOCATION_NOT_LIVE', 'Command targets no live Invocation.');
    }
    if (live.phase !== phase) {
      throw pumpError('INVOCATION_PHASE_INVALID', `Invocation must be ${phase}.`);
    }
    return live;
  }

  #queueCompletion(completion: () => void): void {
    if (this.#state === 'STOPPING' || this.#state === 'STOPPED') return;
    void this.#serialize(completion).catch((error: unknown) => this.#backgroundFailed(error));
  }

  #backgroundFailed(error: unknown): void {
    if (this.#state === 'STOPPING' || this.#state === 'STOPPED') return;
    this.#backgroundFailure ??= error;
    void this.#serialize(() => {
      throw this.#block(this.#backgroundFailure);
    }).catch(() => undefined);
  }

  #convergeForStop(): void {
    for (const [invocationId, live] of [...this.#live]) {
      if (live.phase === 'PREPARED') continue;
      const event = { type: 'PROCESS_RECOVERY_WITHOUT_HANDLE' } as const;
      const committed = this.#journal.commitInvocationEvent(this.#journalOwner, live.cursor, {
        operationId: internalOperation('pump-stop', invocationId, live.cursor.revision, event.type),
        event,
      });
      this.#recordCommit(invocationId, committed);
    }
  }

  #serialize<T>(work: () => T | Promise<T>, allowStopping = false): Promise<T> {
    const run = this.#tail.then(async () => {
      if (!allowStopping) this.#assertTickableOrIdle();
      return work();
    });
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #assertTickable(): void {
    if (this.#state === 'BLOCKED')
      throw this.#blocked ?? pumpError('PUMP_BLOCKED', 'Pump blocked.');
    if (this.#state === 'STOPPING' || this.#state === 'STOPPED') {
      throw pumpError('PUMP_STOPPED', 'Pump is stopping or stopped.');
    }
  }

  #assertTickableOrIdle(): void {
    if (this.#state === 'BLOCKED')
      throw this.#blocked ?? pumpError('PUMP_BLOCKED', 'Pump blocked.');
    if (this.#state === 'STOPPING' || this.#state === 'STOPPED') {
      throw pumpError('PUMP_STOPPED', 'Pump is stopping or stopped.');
    }
  }

  #assertDriverHealthy(): void {
    if (this.#driver.status === 'BLOCKED') {
      throw pumpError('PUMP_BLOCKED', 'Broker transport driver is permanently blocked.');
    }
  }

  #assertNoBackgroundFailure(): void {
    if (this.#backgroundFailure !== undefined) throw this.#backgroundFailure;
  }

  #block(error: unknown): WorkerSerialPumpError {
    const failure =
      error instanceof WorkerSerialPumpError
        ? error
        : pumpError('PUMP_BLOCKED', 'Worker pump failed closed.', error);
    this.#blocked ??= failure;
    this.#state = 'BLOCKED';
    this.#diagnostic('blocked');
    return this.#blocked;
  }

  #diagnostic(event: WorkerSerialPumpDiagnostic): void {
    try {
      this.#diagnosticSink?.(event);
    } catch {
      // Diagnostics never become mutation authority.
    }
  }
}

function cancelEvent(live: LiveInvocation, input: WorkerCancelCommandPayload) {
  if (live.phase === 'PREPARED') {
    if (input.reason !== 'USER_CANCEL') {
      throw pumpError('INVOCATION_PHASE_INVALID', 'A PREPARED Invocation cannot time out.');
    }
    return { type: 'CANCEL_PROVEN_NOT_DISPATCHED' as const };
  }
  if (live.phase !== 'DISPATCHING' && live.phase !== 'RUNNING') {
    throw pumpError('INVOCATION_PHASE_INVALID', 'Cancel targets a terminal Invocation.');
  }
  return {
    type: 'INTERRUPT_INTENT_RECORDED' as const,
    attemptId: workerInvocationAttemptId(input.attemptId),
    attempt: workerInterruptAttempt(input.attempt),
    reason: input.reason,
  };
}

function parseCommand<T>(schema: { parse(input: unknown): T }, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (error) {
    throw pumpError('COMMAND_INVALID', 'Broker command payload is invalid.', error);
  }
}

function onlyEffect<TType extends WorkerCommittedAfterCommitEffect['type']>(
  effects: readonly WorkerCommittedAfterCommitEffect[],
  type: TType,
): Extract<WorkerCommittedAfterCommitEffect, { type: TType }> {
  const effect = effects.length === 1 ? effects[0] : undefined;
  if (effect?.type !== type) throw pumpError('HOST_EFFECT_INVALID', `Expected ${type} effect.`);
  return effect as Extract<WorkerCommittedAfterCommitEffect, { type: TType }>;
}

function commandOperation(kind: string, command: WorkerTransportCommandReference): string {
  return internalOperation(kind, command.deliveryMessageId, command.sourceFingerprint);
}

function internalOperation(kind: string, ...parts: readonly (string | number)[]): string {
  const hash = createHash('sha256');
  hash.update('combo.creator-worker-r2d-operation/1\0');
  hash.update(kind);
  for (const part of parts) hash.update(`\0${String(part)}`);
  return `r2d.${kind}.${hash.digest('hex')}`;
}

function batchLimit(input: number | undefined): number {
  const value = input ?? DEFAULT_BATCH_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new TypeError('Worker pump batch limit must be 1..100.');
  }
  return value;
}

function startInputTimeout(input: number | undefined): number {
  const value = input ?? DEFAULT_START_INPUT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new TypeError('Start input timeout must be 1..60000 ms.');
  }
  return value;
}

function pumpError(
  code: ConstructorParameters<typeof WorkerSerialPumpError>[0],
  message: string,
  cause?: unknown,
): WorkerSerialPumpError {
  return new WorkerSerialPumpError(code, message, cause === undefined ? undefined : { cause });
}
