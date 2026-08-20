import { describe, expect, it } from 'vitest';

import {
  InvocationStateError,
  isTerminalInvocationState,
  transitionInvocation,
  type InvocationState,
} from './invocation.js';

describe('Invocation reducer', () => {
  it('runs the prepare/start/success path and keeps terminal state monotonic', () => {
    let state: InvocationState = 'ACCEPTED';
    state = transitionInvocation(state, { type: 'QUEUE' });
    state = transitionInvocation(state, { type: 'REQUEST_DISPATCH' });
    state = transitionInvocation(state, { type: 'WORKER_PERSISTED' });
    state = transitionInvocation(state, { type: 'REQUEST_START' });
    state = transitionInvocation(state, { type: 'HOST_STARTED' });
    state = transitionInvocation(state, { type: 'SUCCEED', finalDurable: true });

    expect(state).toBe('SUCCEEDED');
    expect(isTerminalInvocationState(state)).toBe(true);
    expect(transitionInvocation(state, { type: 'SUCCEED', finalDurable: true })).toBe('SUCCEEDED');
    expect(() => transitionInvocation(state, { type: 'REQUEST_CANCEL' })).toThrowError(
      expect.objectContaining({ code: 'TERMINAL_MONOTONIC' }),
    );
  });

  it('allows cancel/final race only when the final is already durable', () => {
    const cancelRequested = transitionInvocation('RUNNING', { type: 'REQUEST_CANCEL' });
    expect(cancelRequested).toBe('CANCEL_REQUESTED');
    expect(() =>
      transitionInvocation(cancelRequested, { type: 'SUCCEED', finalDurable: false }),
    ).toThrowError(expect.objectContaining({ code: 'FINAL_NOT_DURABLE' }));
    expect(transitionInvocation(cancelRequested, { type: 'SUCCEED', finalDurable: true })).toBe(
      'SUCCEEDED',
    );
  });

  it('requires confirmed interruption before CANCELLED', () => {
    expect(() =>
      transitionInvocation('RECONCILING', {
        type: 'RECONCILE_CANCELLED',
        interruptConfirmed: false,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INTERRUPT_NOT_CONFIRMED' }));
    expect(
      transitionInvocation('RECONCILING', {
        type: 'RECONCILE_CANCELLED',
        interruptConfirmed: true,
      }),
    ).toBe('CANCELLED');
  });

  it('routes lost post-dispatch evidence to UNCERTAIN', () => {
    let state: InvocationState = 'STARTING';
    state = transitionInvocation(state, { type: 'LOSE_EXECUTION_EVIDENCE' });
    state = transitionInvocation(state, { type: 'RECONCILE_UNCERTAIN' });
    expect(state).toBe('UNCERTAIN');
    expect(() => transitionInvocation(state, { type: 'REQUEST_START' })).toThrowError(
      InvocationStateError,
    );
  });

  it('expires only a queued invocation with proof that dispatch never happened', () => {
    expect(
      transitionInvocation('QUEUED', {
        type: 'EXPIRE_BEFORE_DISPATCH',
        dispatchProvenAbsent: true,
      }),
    ).toBe('EXPIRED');
    expect(() =>
      transitionInvocation('QUEUED', {
        type: 'EXPIRE_BEFORE_DISPATCH',
        dispatchProvenAbsent: false,
      }),
    ).toThrowError(expect.objectContaining({ code: 'DISPATCH_EVIDENCE_REQUIRED' }));
  });
});
