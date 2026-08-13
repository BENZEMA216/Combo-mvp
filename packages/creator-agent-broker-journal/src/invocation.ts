export const INVOCATION_STATES = [
  'ACCEPTED',
  'QUEUED',
  'DISPATCH_PENDING',
  'PERSISTED',
  'STARTING',
  'RUNNING',
  'CANCEL_REQUESTED',
  'RECONCILING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'UNCERTAIN',
  'EXPIRED',
] as const;

export type InvocationState = (typeof INVOCATION_STATES)[number];

export const TERMINAL_INVOCATION_STATES = [
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'UNCERTAIN',
  'EXPIRED',
] as const satisfies readonly InvocationState[];

const TERMINAL_STATES = new Set<InvocationState>(TERMINAL_INVOCATION_STATES);

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
  return TERMINAL_STATES.has(state);
}

export function transitionInvocation(
  state: InvocationState,
  event: InvocationEvent,
): InvocationState {
  if (isTerminalInvocationState(state)) {
    if (isIdempotentTerminalReplay(state, event)) return state;
    throw new InvocationStateError('TERMINAL_MONOTONIC', state, event.type);
  }

  switch (event.type) {
    case 'QUEUE':
      return requireState(state, event, ['ACCEPTED'], 'QUEUED');
    case 'REQUEST_DISPATCH':
      return requireState(state, event, ['QUEUED'], 'DISPATCH_PENDING');
    case 'RELEASE_DISPATCH':
      return requireState(state, event, ['DISPATCH_PENDING'], 'QUEUED');
    case 'WORKER_PERSISTED':
      return requireState(state, event, ['DISPATCH_PENDING'], 'PERSISTED');
    case 'REQUEST_START':
      return requireState(state, event, ['PERSISTED'], 'STARTING');
    case 'HOST_STARTED':
      return requireState(state, event, ['STARTING', 'RECONCILING'], 'RUNNING');
    case 'REQUEST_CANCEL':
      if (state === 'ACCEPTED' || state === 'QUEUED') return 'CANCELLED';
      return requireState(
        state,
        event,
        ['PERSISTED', 'STARTING', 'RUNNING', 'RECONCILING'],
        'CANCEL_REQUESTED',
      );
    case 'SUCCEED':
      if (!event.finalDurable) {
        throw new InvocationStateError('FINAL_NOT_DURABLE', state, event.type);
      }
      return requireState(
        state,
        event,
        ['RUNNING', 'CANCEL_REQUESTED', 'RECONCILING'],
        'SUCCEEDED',
      );
    case 'FAIL_CONFIRMED':
      return requireState(
        state,
        event,
        ['PERSISTED', 'STARTING', 'RUNNING', 'CANCEL_REQUESTED', 'RECONCILING'],
        'FAILED',
      );
    case 'INTERRUPT_CONFIRMED':
      return requireState(state, event, ['CANCEL_REQUESTED', 'RECONCILING'], 'CANCELLED');
    case 'LOSE_EXECUTION_EVIDENCE':
      return requireState(state, event, ['STARTING', 'RUNNING', 'CANCEL_REQUESTED'], 'RECONCILING');
    case 'RECONCILE_RUNNING':
      return requireState(state, event, ['RECONCILING'], 'RUNNING');
    case 'RECONCILE_SUCCEEDED':
      if (!event.finalDurable) {
        throw new InvocationStateError('FINAL_NOT_DURABLE', state, event.type);
      }
      return requireState(state, event, ['RECONCILING'], 'SUCCEEDED');
    case 'RECONCILE_FAILED':
      return requireState(state, event, ['RECONCILING'], 'FAILED');
    case 'RECONCILE_CANCELLED':
      if (!event.interruptConfirmed) {
        throw new InvocationStateError('INTERRUPT_NOT_CONFIRMED', state, event.type);
      }
      return requireState(state, event, ['RECONCILING'], 'CANCELLED');
    case 'RECONCILE_UNCERTAIN':
      return requireState(state, event, ['RECONCILING'], 'UNCERTAIN');
    case 'EXPIRE_BEFORE_DISPATCH':
      if (!event.dispatchProvenAbsent) {
        throw new InvocationStateError('DISPATCH_EVIDENCE_REQUIRED', state, event.type);
      }
      return requireState(state, event, ['QUEUED'], 'EXPIRED');
  }
}

function requireState(
  state: InvocationState,
  event: InvocationEvent,
  allowed: readonly InvocationState[],
  next: InvocationState,
): InvocationState {
  if (allowed.includes(state)) return next;
  throw new InvocationStateError('ILLEGAL_TRANSITION', state, event.type);
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
