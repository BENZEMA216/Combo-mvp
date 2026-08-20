import {
  InvocationStateSchema,
  TERMINAL_INVOCATION_STATES,
  isTerminalInvocationState as isAuthoritativeTerminalInvocationState,
  transitionInvocationState,
  type InvocationState as AuthoritativeInvocationState,
  type InvocationTransitionEvidence,
} from '@cb/creator-agent-protocol';

export const INVOCATION_STATES = InvocationStateSchema.options;
export type InvocationState = AuthoritativeInvocationState;
export { TERMINAL_INVOCATION_STATES };

export type InvocationEvent =
  | { type: 'QUEUE' }
  | { type: 'REQUEST_DISPATCH' }
  | { type: 'RELEASE_DISPATCH' }
  | { type: 'WORKER_PERSISTED' }
  | { type: 'REQUEST_START' }
  | { type: 'HOST_STARTED' }
  | { type: 'REQUEST_CANCEL' }
  | { type: 'SUCCEED'; finalDurable: boolean }
  | { type: 'FAIL_CONFIRMED' }
  | { type: 'INTERRUPT_CONFIRMED' }
  | { type: 'LOSE_EXECUTION_EVIDENCE' }
  | { type: 'RECONCILE_RUNNING' }
  | { type: 'RECONCILE_SUCCEEDED'; finalDurable: boolean }
  | { type: 'RECONCILE_FAILED' }
  | { type: 'RECONCILE_CANCELLED'; interruptConfirmed: boolean }
  | { type: 'RECONCILE_UNCERTAIN' }
  | { type: 'EXPIRE_BEFORE_DISPATCH'; dispatchProvenAbsent: boolean };

export type InvocationStateErrorCode =
  | 'ILLEGAL_TRANSITION'
  | 'TERMINAL_MONOTONIC'
  | 'FINAL_NOT_DURABLE'
  | 'INTERRUPT_NOT_CONFIRMED'
  | 'DISPATCH_EVIDENCE_REQUIRED';

export class InvocationStateError extends Error {
  constructor(
    readonly code: InvocationStateErrorCode,
    readonly state: InvocationState,
    readonly event: InvocationEvent['type'],
  ) {
    super(`${code}: ${state} cannot consume ${event}`);
    this.name = 'InvocationStateError';
  }
}

export function isTerminalInvocationState(state: InvocationState): boolean {
  return isAuthoritativeTerminalInvocationState(state);
}

/**
 * Thin event-name adapter over the authoritative shared transition reducer.
 * It may preserve exact terminal idempotent replay, but it never owns an
 * independent transition graph.
 */
export function transitionInvocation(
  state: InvocationState,
  event: InvocationEvent,
): InvocationState {
  if (isTerminalInvocationState(state)) {
    if (isIdempotentTerminalReplay(state, event)) return state;
    throw new InvocationStateError('TERMINAL_MONOTONIC', state, event.type);
  }

  const { to, evidence } = targetForEvent(state, event);
  try {
    return transitionInvocationState({ from: state, to, evidence });
  } catch {
    throw new InvocationStateError(errorCodeForEvent(event), state, event.type);
  }
}

function targetForEvent(
  state: InvocationState,
  event: InvocationEvent,
): { readonly to: InvocationState; readonly evidence: InvocationTransitionEvidence } {
  switch (event.type) {
    case 'QUEUE':
      return { to: 'QUEUED', evidence: {} };
    case 'REQUEST_DISPATCH':
      return { to: 'DISPATCH_PENDING', evidence: {} };
    case 'RELEASE_DISPATCH':
      return { to: 'QUEUED', evidence: {} };
    case 'WORKER_PERSISTED':
      return { to: 'PERSISTED', evidence: {} };
    case 'REQUEST_START':
      return { to: 'STARTING', evidence: {} };
    case 'HOST_STARTED':
    case 'RECONCILE_RUNNING':
      return { to: 'RUNNING', evidence: {} };
    case 'REQUEST_CANCEL':
      return state === 'ACCEPTED' || state === 'QUEUED'
        ? { to: 'CANCELLED', evidence: { provedNotExecuted: true } }
        : { to: 'CANCEL_REQUESTED', evidence: {} };
    case 'SUCCEED':
    case 'RECONCILE_SUCCEEDED':
      return { to: 'SUCCEEDED', evidence: { durableFinal: event.finalDurable } };
    case 'FAIL_CONFIRMED':
    case 'RECONCILE_FAILED':
      return { to: 'FAILED', evidence: { terminalFailureConfirmed: true } };
    case 'INTERRUPT_CONFIRMED':
      return { to: 'CANCELLED', evidence: { interruptConfirmed: true } };
    case 'LOSE_EXECUTION_EVIDENCE':
      return { to: 'RECONCILING', evidence: { executionEvidenceLost: true } };
    case 'RECONCILE_CANCELLED':
      return { to: 'CANCELLED', evidence: { interruptConfirmed: event.interruptConfirmed } };
    case 'RECONCILE_UNCERTAIN':
      return { to: 'UNCERTAIN', evidence: { reconciliationExhausted: true } };
    case 'EXPIRE_BEFORE_DISPATCH':
      return {
        to: 'EXPIRED',
        evidence: { queueTtlExpiredBeforeDispatch: event.dispatchProvenAbsent },
      };
  }
}

function errorCodeForEvent(event: InvocationEvent): InvocationStateErrorCode {
  if ((event.type === 'SUCCEED' || event.type === 'RECONCILE_SUCCEEDED') && !event.finalDurable) {
    return 'FINAL_NOT_DURABLE';
  }
  if (event.type === 'RECONCILE_CANCELLED' && !event.interruptConfirmed) {
    return 'INTERRUPT_NOT_CONFIRMED';
  }
  if (event.type === 'EXPIRE_BEFORE_DISPATCH' && !event.dispatchProvenAbsent) {
    return 'DISPATCH_EVIDENCE_REQUIRED';
  }
  return 'ILLEGAL_TRANSITION';
}

function isIdempotentTerminalReplay(state: InvocationState, event: InvocationEvent): boolean {
  switch (state) {
    case 'SUCCEEDED':
      return (
        (event.type === 'SUCCEED' && event.finalDurable) ||
        (event.type === 'RECONCILE_SUCCEEDED' && event.finalDurable)
      );
    case 'FAILED':
      return event.type === 'FAIL_CONFIRMED' || event.type === 'RECONCILE_FAILED';
    case 'CANCELLED':
      return (
        event.type === 'INTERRUPT_CONFIRMED' ||
        (event.type === 'RECONCILE_CANCELLED' && event.interruptConfirmed)
      );
    case 'UNCERTAIN':
      return event.type === 'RECONCILE_UNCERTAIN';
    case 'EXPIRED':
      return event.type === 'EXPIRE_BEFORE_DISPATCH' && event.dispatchProvenAbsent;
    default:
      return false;
  }
}
