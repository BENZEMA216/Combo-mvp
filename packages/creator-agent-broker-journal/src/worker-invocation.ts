import {
  type HostInterruptReason,
  type HostTurnEvidenceLostReason,
} from '@cb/creator-agent-protocol/host';

import {
  createWorkerInterruptHostEffect,
  createWorkerObserveHostOutcomeEffect,
  createWorkerStartHostEffect,
  type WorkerInterruptAttempt,
  type WorkerInterruptHostEffect,
  type WorkerInvocationAttemptId,
  type WorkerObserveHostOutcomeEffect,
  type WorkerStartHostEffect,
} from './effect-authority.js';
import {
  assertTrustedWorkerHostInterruptDisposition,
  assertTrustedWorkerHostStartDisposition,
  assertTrustedWorkerHostTerminal,
  type WorkerHostBinding,
  type WorkerHostInterruptDispositionProjection,
  type WorkerHostInterruptRequestProjection,
  type WorkerHostStartDispositionProjection,
  type WorkerHostTerminalProjection,
} from './host-projection.js';

export type WorkerStartFailureReason = 'RUNTIME_START_FAILED';

export type WorkerUncertainReason =
  | 'START_DISPATCH_UNKNOWN'
  | 'HOST_OUTCOME_EVIDENCE_LOST'
  | 'INTERRUPT_OUTCOME_UNKNOWN'
  | 'HOST_TERMINAL_OBSERVED_BUT_UNCOMMITTED'
  | 'PROCESS_RESTART_WITH_DISPATCH_INTENT'
  | 'PROCESS_RESTART_WITH_LIVE_TURN'
  | 'PROCESS_RESTART_WITH_INTERRUPT'
  | 'PROCESS_RESTART_AFTER_TERMINAL_OBSERVED';

export type WorkerPendingInterrupt = Readonly<{
  attemptId: WorkerInvocationAttemptId;
  attempt: WorkerInterruptAttempt;
  reason: HostInterruptReason;
}>;

export type WorkerInterruptState =
  | Readonly<{ state: 'NONE' }>
  | Readonly<{
      state: 'REQUESTED';
      attemptId: WorkerInvocationAttemptId;
      attempt: WorkerInterruptAttempt;
      reason: HostInterruptReason;
    }>
  | Readonly<{
      state: 'NOT_SENT';
      attemptId: WorkerInvocationAttemptId;
      attempt: WorkerInterruptAttempt;
      request: WorkerHostInterruptRequestProjection;
    }>
  | Readonly<{
      state: 'SENT';
      attemptId: WorkerInvocationAttemptId;
      attempt: WorkerInterruptAttempt;
      request: WorkerHostInterruptRequestProjection;
    }>
  | Readonly<{
      state: 'TERMINAL_ALREADY_OBSERVED';
      attemptId: WorkerInvocationAttemptId;
      attempt: WorkerInterruptAttempt;
      reason: HostInterruptReason;
    }>;

export type WorkerInterruptAuditSnapshot =
  | WorkerInterruptState
  | Readonly<{
      state: 'PENDING_START';
      attemptId: WorkerInvocationAttemptId;
      attempt: WorkerInterruptAttempt;
      reason: HostInterruptReason;
    }>;

type WorkerHostTerminal =
  | Readonly<{
      outcome: 'SUCCEEDED';
      source: 'HOST';
      startAttemptId: WorkerInvocationAttemptId;
      interrupt: WorkerInterruptState;
      host: Extract<WorkerHostTerminalProjection, { outcome: 'SUCCEEDED' }>;
    }>
  | Readonly<{
      outcome: 'FAILED';
      source: 'HOST';
      startAttemptId: WorkerInvocationAttemptId;
      interrupt: WorkerInterruptState;
      host: Extract<WorkerHostTerminalProjection, { outcome: 'FAILED' }>;
    }>
  | Readonly<{
      outcome: 'CANCELLED';
      source: 'HOST';
      startAttemptId: WorkerInvocationAttemptId;
      interrupt: WorkerInterruptState;
      host: Extract<WorkerHostTerminalProjection, { outcome: 'CANCELLED' }>;
    }>;

type WorkerInterruptedHostTerminal =
  | Extract<WorkerHostTerminalProjection, { outcome: 'CANCELLED' }>
  | Extract<WorkerHostTerminalProjection, { outcome: 'FAILED'; errorCode: 'TURN_TIMEOUT' }>;

export type WorkerTerminal =
  | WorkerHostTerminal
  | Readonly<{
      outcome: 'FAILED';
      source: 'START_REJECTED';
      reason: WorkerStartFailureReason;
      startAttemptId: WorkerInvocationAttemptId;
    }>
  | Readonly<{
      outcome: 'CANCELLED';
      source: 'PROVED_NOT_DISPATCHED';
      proof: 'NO_DISPATCH_INTENT' | 'HOST_START_PROVED_NOT_SENT';
      startAttemptId: WorkerInvocationAttemptId | null;
    }>
  | Readonly<{
      outcome: 'UNCERTAIN';
      source: 'EVIDENCE_LOST';
      reason: WorkerUncertainReason;
      hostReason: HostTurnEvidenceLostReason | null;
      context: Readonly<{
        startAttemptId: WorkerInvocationAttemptId;
        binding: WorkerHostBinding | null;
        interrupt: WorkerInterruptAuditSnapshot;
        observedInterruptedTerminal: WorkerInterruptedHostTerminal | null;
      }>;
    }>;

export type WorkerInvocationState =
  | Readonly<{ phase: 'PREPARED' }>
  | Readonly<{
      phase: 'DISPATCHING';
      startAttemptId: WorkerInvocationAttemptId;
      pendingInterrupt: WorkerPendingInterrupt | null;
    }>
  | Readonly<{
      phase: 'RUNNING';
      startAttemptId: WorkerInvocationAttemptId;
      binding: WorkerHostBinding;
      interrupt: WorkerInterruptState;
      pendingInterruptedTerminal: WorkerInterruptedHostTerminal | null;
    }>
  | Readonly<{
      phase: 'TERMINAL_READY';
      terminal: WorkerTerminal;
    }>;

export type WorkerInvocationEvent =
  | Readonly<{
      type: 'DISPATCH_INTENT_RECORDED';
      attemptId: WorkerInvocationAttemptId;
    }>
  | Readonly<{ type: 'CANCEL_PROVEN_NOT_DISPATCHED' }>
  | Readonly<{
      type: 'INTERRUPT_INTENT_RECORDED';
      attemptId: WorkerInvocationAttemptId;
      attempt: WorkerInterruptAttempt;
      reason: HostInterruptReason;
    }>
  | Readonly<{
      type: 'HOST_START_DISPOSITION_RECORDED';
      disposition: WorkerHostStartDispositionProjection;
    }>
  | Readonly<{
      type: 'HOST_INTERRUPT_DISPOSITION_RECORDED';
      disposition: WorkerHostInterruptDispositionProjection;
    }>
  | Readonly<{
      type: 'HOST_TERMINAL_CONFIRMED';
      terminal: WorkerHostTerminalProjection;
    }>
  | Readonly<{
      type: 'HOST_EVIDENCE_LOST';
      hostReason: HostTurnEvidenceLostReason;
    }>
  | Readonly<{ type: 'PROCESS_RECOVERY_WITHOUT_HANDLE' }>;

export type WorkerDurableEffect =
  | Readonly<{
      type: 'ENQUEUE_STARTED_FACT';
      binding: WorkerHostBinding;
    }>
  | Readonly<{
      type: 'ENQUEUE_TERMINAL_FACT';
      terminal: WorkerTerminal;
    }>;

export type WorkerAfterCommitEffect =
  | WorkerStartHostEffect
  | WorkerObserveHostOutcomeEffect
  | WorkerInterruptHostEffect;

export type WorkerInvocationReduction = Readonly<{
  next: WorkerInvocationState;
  durable: readonly WorkerDurableEffect[];
  afterCommit: readonly WorkerAfterCommitEffect[];
}>;

export type WorkerInvocationTransitionErrorCode =
  | 'ILLEGAL_TRANSITION'
  | 'TERMINAL_MONOTONIC'
  | 'ATTEMPT_MISMATCH'
  | 'HOST_BINDING_MISMATCH'
  | 'REQUIRED_EVIDENCE_MISSING';

export class WorkerInvocationTransitionError extends Error {
  public constructor(
    public readonly code: WorkerInvocationTransitionErrorCode,
    public readonly phase: WorkerInvocationState['phase'],
    public readonly event: WorkerInvocationEvent['type'],
  ) {
    super(`${code}: ${phase} cannot consume ${event}`);
    this.name = 'WorkerInvocationTransitionError';
  }
}

export function createPreparedWorkerInvocation(): WorkerInvocationState {
  return Object.freeze({ phase: 'PREPARED' });
}

/**
 * Pure semantic reducer. Its caller must commit `next` and every `durable` effect atomically,
 * then mark and execute `afterCommit` in order. Raw effects have no Host I/O authority until the
 * package-internal post-COMMIT marker signs them. This reducer never performs I/O or command
 * replay arbitration.
 */
export function reduceWorkerInvocation(
  state: WorkerInvocationState,
  event: WorkerInvocationEvent,
): WorkerInvocationReduction {
  if (state.phase === 'TERMINAL_READY') {
    throw transitionError('TERMINAL_MONOTONIC', state, event);
  }
  switch (state.phase) {
    case 'PREPARED':
      return reducePrepared(state, event);
    case 'DISPATCHING':
      return reduceDispatching(state, event);
    case 'RUNNING':
      return reduceRunning(state, event);
  }
}

function reducePrepared(
  state: Extract<WorkerInvocationState, { phase: 'PREPARED' }>,
  event: WorkerInvocationEvent,
): WorkerInvocationReduction {
  if (event.type === 'DISPATCH_INTENT_RECORDED') {
    return reduction(
      Object.freeze({
        phase: 'DISPATCHING',
        startAttemptId: event.attemptId,
        pendingInterrupt: null,
      }),
      [],
      [createWorkerStartHostEffect(event.attemptId)],
    );
  }
  if (event.type === 'CANCEL_PROVEN_NOT_DISPATCHED') {
    return terminalReduction(
      Object.freeze({
        outcome: 'CANCELLED',
        source: 'PROVED_NOT_DISPATCHED',
        proof: 'NO_DISPATCH_INTENT',
        startAttemptId: null,
      }),
    );
  }
  throw transitionError('ILLEGAL_TRANSITION', state, event);
}

function reduceDispatching(
  state: Extract<WorkerInvocationState, { phase: 'DISPATCHING' }>,
  event: WorkerInvocationEvent,
): WorkerInvocationReduction {
  if (event.type === 'INTERRUPT_INTENT_RECORDED') {
    if (state.pendingInterrupt !== null) throw transitionError('ILLEGAL_TRANSITION', state, event);
    assertNextInterruptAttempt(null, event.attempt, state, event);
    return reduction(
      Object.freeze({
        ...state,
        pendingInterrupt: Object.freeze({
          attemptId: event.attemptId,
          attempt: event.attempt,
          reason: event.reason,
        }),
      }),
    );
  }
  if (event.type === 'HOST_START_DISPOSITION_RECORDED') {
    assertTrustedWorkerHostStartDisposition(event.disposition);
    assertStartAttempt(state.startAttemptId, event.disposition.attemptId, state, event);
    switch (event.disposition.disposition) {
      case 'STARTED':
        return startConfirmed(state, event.disposition.binding);
      case 'NOT_STARTED':
        if (state.pendingInterrupt?.reason === 'USER_CANCEL') {
          return terminalReduction(
            Object.freeze({
              outcome: 'CANCELLED',
              source: 'PROVED_NOT_DISPATCHED',
              proof: 'HOST_START_PROVED_NOT_SENT',
              startAttemptId: state.startAttemptId,
            }),
          );
        }
        return terminalReduction(
          Object.freeze({
            outcome: 'FAILED',
            source: 'START_REJECTED',
            reason: event.disposition.reason,
            startAttemptId: state.startAttemptId,
          }),
        );
      case 'EVIDENCE_LOST':
        return uncertainReduction(
          'START_DISPATCH_UNKNOWN',
          event.disposition.hostReason,
          dispatchingContext(state),
        );
    }
  }
  if (event.type === 'PROCESS_RECOVERY_WITHOUT_HANDLE') {
    return uncertainReduction(
      'PROCESS_RESTART_WITH_DISPATCH_INTENT',
      null,
      dispatchingContext(state),
    );
  }
  throw transitionError('ILLEGAL_TRANSITION', state, event);
}

function startConfirmed(
  state: Extract<WorkerInvocationState, { phase: 'DISPATCHING' }>,
  binding: WorkerHostBinding,
): WorkerInvocationReduction {
  const pending = state.pendingInterrupt;
  const interrupt: WorkerInterruptState =
    pending === null
      ? Object.freeze({ state: 'NONE' })
      : Object.freeze({
          state: 'REQUESTED',
          attemptId: pending.attemptId,
          attempt: pending.attempt,
          reason: pending.reason,
        });
  const afterCommit: WorkerAfterCommitEffect[] = [];
  if (pending !== null) {
    afterCommit.push(
      createWorkerInterruptHostEffect({
        attemptId: pending.attemptId,
        attempt: pending.attempt,
        binding,
        reason: pending.reason,
      }),
    );
  }
  afterCommit.push(createWorkerObserveHostOutcomeEffect(binding));
  return reduction(
    Object.freeze({
      phase: 'RUNNING',
      startAttemptId: state.startAttemptId,
      binding,
      interrupt,
      pendingInterruptedTerminal: null,
    }),
    [Object.freeze({ type: 'ENQUEUE_STARTED_FACT', binding })],
    afterCommit,
  );
}

function reduceRunning(
  state: Extract<WorkerInvocationState, { phase: 'RUNNING' }>,
  event: WorkerInvocationEvent,
): WorkerInvocationReduction {
  switch (event.type) {
    case 'INTERRUPT_INTENT_RECORDED': {
      if (state.interrupt.state !== 'NONE' && state.interrupt.state !== 'NOT_SENT') {
        throw transitionError('ILLEGAL_TRANSITION', state, event);
      }
      assertNextInterruptAttempt(state.interrupt, event.attempt, state, event);
      return reduction(
        Object.freeze({
          ...state,
          interrupt: Object.freeze({
            state: 'REQUESTED',
            attemptId: event.attemptId,
            attempt: event.attempt,
            reason: event.reason,
          }),
        }),
        [],
        [
          createWorkerInterruptHostEffect({
            attemptId: event.attemptId,
            attempt: event.attempt,
            binding: state.binding,
            reason: event.reason,
          }),
        ],
      );
    }
    case 'HOST_INTERRUPT_DISPOSITION_RECORDED':
      return recordInterruptDisposition(state, event);
    case 'HOST_TERMINAL_CONFIRMED':
      assertTrustedWorkerHostTerminal(event.terminal);
      if (state.pendingInterruptedTerminal !== null) {
        throw transitionError('REQUIRED_EVIDENCE_MISSING', state, event);
      }
      if (isInterruptedTerminal(event.terminal) && state.interrupt.state === 'REQUESTED') {
        assertPendingInterruptedTerminal(state, event);
        return reduction(Object.freeze({ ...state, pendingInterruptedTerminal: event.terminal }));
      }
      assertTerminalMayCommit(state, event);
      return terminalReduction(hostTerminal(state, event.terminal));
    case 'HOST_EVIDENCE_LOST':
      return uncertainReduction(evidenceLostReason(state), event.hostReason, runningContext(state));
    case 'PROCESS_RECOVERY_WITHOUT_HANDLE':
      return uncertainReduction(restartReason(state), null, runningContext(state));
    default:
      throw transitionError('ILLEGAL_TRANSITION', state, event);
  }
}

function recordInterruptDisposition(
  state: Extract<WorkerInvocationState, { phase: 'RUNNING' }>,
  event: Extract<WorkerInvocationEvent, { type: 'HOST_INTERRUPT_DISPOSITION_RECORDED' }>,
): WorkerInvocationReduction {
  assertTrustedWorkerHostInterruptDisposition(event.disposition);
  if (state.interrupt.state !== 'REQUESTED') {
    throw transitionError('REQUIRED_EVIDENCE_MISSING', state, event);
  }
  const disposition = event.disposition;
  assertAttempt(
    state.interrupt.attemptId,
    state.interrupt.attempt,
    disposition.attemptId,
    disposition.attempt,
    state,
    event,
  );
  if (disposition.disposition === 'TERMINAL_ALREADY_OBSERVED') {
    assertBinding(state, event, disposition.binding);
    return completeInterruptDisposition(
      state,
      Object.freeze({
        ...state,
        interrupt: Object.freeze({
          state: 'TERMINAL_ALREADY_OBSERVED',
          attemptId: disposition.attemptId,
          attempt: disposition.attempt,
          reason: state.interrupt.reason,
        }),
      }),
      event,
    );
  }

  assertBinding(state, event, disposition.request.binding);
  if (disposition.request.reason !== state.interrupt.reason) {
    throw transitionError('REQUIRED_EVIDENCE_MISSING', state, event);
  }
  return completeInterruptDisposition(
    state,
    Object.freeze({
      ...state,
      interrupt: Object.freeze({
        state: disposition.disposition,
        attemptId: disposition.attemptId,
        attempt: disposition.attempt,
        request: disposition.request,
      }),
    }),
    event,
  );
}

function completeInterruptDisposition(
  previous: Extract<WorkerInvocationState, { phase: 'RUNNING' }>,
  next: Extract<WorkerInvocationState, { phase: 'RUNNING' }>,
  event: Extract<WorkerInvocationEvent, { type: 'HOST_INTERRUPT_DISPOSITION_RECORDED' }>,
): WorkerInvocationReduction {
  const pending = previous.pendingInterruptedTerminal;
  if (pending === null) return reduction(next);
  if (next.interrupt.state !== 'SENT') {
    return uncertainReduction(
      'INTERRUPT_OUTCOME_UNKNOWN',
      'HOST_PROTOCOL_ERROR',
      runningContext(next),
    );
  }
  assertInterruptRequestMatches(next.interrupt.request, pending.interruptRequest, previous, event);
  return terminalReduction(hostTerminal(next, pending));
}

function assertTerminalMayCommit(
  state: Extract<WorkerInvocationState, { phase: 'RUNNING' }>,
  event: Extract<WorkerInvocationEvent, { type: 'HOST_TERMINAL_CONFIRMED' }>,
): void {
  assertBinding(state, event, event.terminal.binding);
  if (
    event.terminal.outcome === 'CANCELLED' ||
    (event.terminal.outcome === 'FAILED' && event.terminal.errorCode === 'TURN_TIMEOUT')
  ) {
    if (state.interrupt.state !== 'SENT') {
      throw transitionError('REQUIRED_EVIDENCE_MISSING', state, event);
    }
    const expected = state.interrupt.request;
    const actual = event.terminal.interruptRequest;
    if (
      expected.requestId !== actual.requestId ||
      expected.reason !== actual.reason ||
      expected.binding !== actual.binding
    ) {
      throw transitionError('REQUIRED_EVIDENCE_MISSING', state, event);
    }
  }
}

function assertPendingInterruptedTerminal(
  state: Extract<WorkerInvocationState, { phase: 'RUNNING' }>,
  event: Extract<WorkerInvocationEvent, { type: 'HOST_TERMINAL_CONFIRMED' }>,
): void {
  const terminal = event.terminal;
  if (!isInterruptedTerminal(terminal) || state.interrupt.state !== 'REQUESTED') {
    throw transitionError('REQUIRED_EVIDENCE_MISSING', state, event);
  }
  assertBinding(state, event, terminal.binding);
  if (terminal.interruptRequest.reason !== state.interrupt.reason) {
    throw transitionError('REQUIRED_EVIDENCE_MISSING', state, event);
  }
}

function assertInterruptRequestMatches(
  expected: WorkerHostInterruptRequestProjection,
  actual: WorkerHostInterruptRequestProjection,
  state: WorkerInvocationState,
  event: WorkerInvocationEvent,
): void {
  if (
    expected.requestId !== actual.requestId ||
    expected.reason !== actual.reason ||
    expected.binding !== actual.binding
  ) {
    throw transitionError('REQUIRED_EVIDENCE_MISSING', state, event);
  }
}

function isInterruptedTerminal(
  terminal: WorkerHostTerminalProjection,
): terminal is WorkerInterruptedHostTerminal {
  return (
    terminal.outcome === 'CANCELLED' ||
    (terminal.outcome === 'FAILED' && terminal.errorCode === 'TURN_TIMEOUT')
  );
}

function hostTerminal(
  state: Extract<WorkerInvocationState, { phase: 'RUNNING' }>,
  terminal: WorkerHostTerminalProjection,
): WorkerHostTerminal {
  const common = {
    source: 'HOST' as const,
    startAttemptId: state.startAttemptId,
    interrupt: state.interrupt,
  };
  switch (terminal.outcome) {
    case 'SUCCEEDED':
      return Object.freeze({ outcome: 'SUCCEEDED', ...common, host: terminal });
    case 'FAILED':
      return Object.freeze({ outcome: 'FAILED', ...common, host: terminal });
    case 'CANCELLED':
      return Object.freeze({ outcome: 'CANCELLED', ...common, host: terminal });
  }
}

function dispatchingContext(
  state: Extract<WorkerInvocationState, { phase: 'DISPATCHING' }>,
): Extract<WorkerTerminal, { outcome: 'UNCERTAIN' }>['context'] {
  const interrupt: WorkerInterruptAuditSnapshot =
    state.pendingInterrupt === null
      ? Object.freeze({ state: 'NONE' })
      : Object.freeze({ state: 'PENDING_START', ...state.pendingInterrupt });
  return Object.freeze({
    startAttemptId: state.startAttemptId,
    binding: null,
    interrupt,
    observedInterruptedTerminal: null,
  });
}

function runningContext(
  state: Extract<WorkerInvocationState, { phase: 'RUNNING' }>,
): Extract<WorkerTerminal, { outcome: 'UNCERTAIN' }>['context'] {
  return Object.freeze({
    startAttemptId: state.startAttemptId,
    binding: state.binding,
    interrupt: state.interrupt,
    observedInterruptedTerminal: state.pendingInterruptedTerminal,
  });
}

function evidenceLostReason(
  state: Extract<WorkerInvocationState, { phase: 'RUNNING' }>,
): WorkerUncertainReason {
  if (state.pendingInterruptedTerminal !== null) {
    return 'HOST_TERMINAL_OBSERVED_BUT_UNCOMMITTED';
  }
  const { interrupt } = state;
  if (interrupt.state === 'TERMINAL_ALREADY_OBSERVED') {
    return 'HOST_TERMINAL_OBSERVED_BUT_UNCOMMITTED';
  }
  if (interrupt.state === 'REQUESTED' || interrupt.state === 'SENT') {
    return 'INTERRUPT_OUTCOME_UNKNOWN';
  }
  return 'HOST_OUTCOME_EVIDENCE_LOST';
}

function restartReason(
  state: Extract<WorkerInvocationState, { phase: 'RUNNING' }>,
): WorkerUncertainReason {
  if (state.pendingInterruptedTerminal !== null) {
    return 'PROCESS_RESTART_AFTER_TERMINAL_OBSERVED';
  }
  const { interrupt } = state;
  if (interrupt.state === 'TERMINAL_ALREADY_OBSERVED') {
    return 'PROCESS_RESTART_AFTER_TERMINAL_OBSERVED';
  }
  if (interrupt.state === 'REQUESTED' || interrupt.state === 'SENT') {
    return 'PROCESS_RESTART_WITH_INTERRUPT';
  }
  return 'PROCESS_RESTART_WITH_LIVE_TURN';
}

function assertAttempt(
  expectedId: WorkerInvocationAttemptId,
  expectedAttempt: WorkerInterruptAttempt,
  actualId: WorkerInvocationAttemptId,
  actualAttempt: WorkerInterruptAttempt,
  state: WorkerInvocationState,
  event: WorkerInvocationEvent,
): void {
  if (expectedId !== actualId || expectedAttempt !== actualAttempt) {
    throw transitionError('ATTEMPT_MISMATCH', state, event);
  }
}

function assertStartAttempt(
  expected: WorkerInvocationAttemptId,
  actual: WorkerInvocationAttemptId,
  state: WorkerInvocationState,
  event: WorkerInvocationEvent,
): void {
  if (expected !== actual) throw transitionError('ATTEMPT_MISMATCH', state, event);
}

function assertNextInterruptAttempt(
  previous: WorkerInterruptState | null,
  actual: WorkerInterruptAttempt,
  state: WorkerInvocationState,
  event: WorkerInvocationEvent,
): void {
  const expected = previous?.state === 'NOT_SENT' ? previous.attempt + 1 : 1;
  if (actual !== expected) throw transitionError('ATTEMPT_MISMATCH', state, event);
  if (
    previous?.state === 'NOT_SENT' &&
    event.type === 'INTERRUPT_INTENT_RECORDED' &&
    previous.attemptId === event.attemptId
  ) {
    throw transitionError('ATTEMPT_MISMATCH', state, event);
  }
}

function assertBinding(
  state: Extract<WorkerInvocationState, { phase: 'RUNNING' }>,
  event: WorkerInvocationEvent,
  actual: WorkerHostBinding,
): void {
  if (state.binding !== actual) {
    throw transitionError('HOST_BINDING_MISMATCH', state, event);
  }
}

function terminalReduction(terminal: WorkerTerminal): WorkerInvocationReduction {
  const next = Object.freeze({ phase: 'TERMINAL_READY', terminal }) as WorkerInvocationState;
  return reduction(next, [Object.freeze({ type: 'ENQUEUE_TERMINAL_FACT', terminal })]);
}

function uncertainReduction(
  reason: WorkerUncertainReason,
  hostReason: HostTurnEvidenceLostReason | null,
  context: Extract<WorkerTerminal, { outcome: 'UNCERTAIN' }>['context'],
): WorkerInvocationReduction {
  return terminalReduction(
    Object.freeze({ outcome: 'UNCERTAIN', source: 'EVIDENCE_LOST', reason, hostReason, context }),
  );
}

function reduction(
  next: WorkerInvocationState,
  durable: readonly WorkerDurableEffect[] = [],
  afterCommit: readonly WorkerAfterCommitEffect[] = [],
): WorkerInvocationReduction {
  return Object.freeze({
    next,
    durable: Object.freeze([...durable]),
    afterCommit: Object.freeze([...afterCommit]),
  });
}

function transitionError(
  code: WorkerInvocationTransitionErrorCode,
  state: WorkerInvocationState,
  event: WorkerInvocationEvent,
): WorkerInvocationTransitionError {
  return new WorkerInvocationTransitionError(code, state.phase, event.type);
}
