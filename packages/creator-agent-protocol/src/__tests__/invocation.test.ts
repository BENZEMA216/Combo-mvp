import { describe, expect, it } from 'vitest';
// VNext registry case: SCH-001
import {
  errorResponseFor,
  INVOCATION_TRANSITION_GUARDS,
  InvalidInvocationTransitionError,
  InvocationStateSchema,
  isTerminalInvocationState,
  listAllowedInvocationTransitions,
  TERMINAL_INVOCATION_STATES,
  transitionInvocationState,
  VNEXT_ERROR_CLASSIFICATION,
  VnextErrorCodeSchema,
  VnextErrorResponseSchema,
} from '../invocation.js';
import { readFixture } from './fixture-helpers.js';

describe('Invocation state machine 与错误/重试策略', () => {
  it('golden transition matrix and guards stay semantics-exact', async () => {
    const fixture = (await readFixture('invocation-state-machine.v1.json')) as {
      terminalStates: string[];
      transitions: Record<string, string[]>;
      guards: Record<string, string>;
    };
    expect(fixture.terminalStates).toEqual(TERMINAL_INVOCATION_STATES);
    expect(fixture.transitions).toEqual(listAllowedInvocationTransitions());
    expect(fixture.guards).toEqual(INVOCATION_TRANSITION_GUARDS);
    expect(Object.keys(fixture.transitions)).toEqual(InvocationStateSchema.options);
  });

  it('happy path 逐步前进且 durable final 才能成功', () => {
    let state = transitionInvocationState({ from: 'ACCEPTED', to: 'QUEUED', evidence: {} });
    state = transitionInvocationState({ from: state, to: 'DISPATCH_PENDING', evidence: {} });
    state = transitionInvocationState({ from: state, to: 'PERSISTED', evidence: {} });
    state = transitionInvocationState({ from: state, to: 'STARTING', evidence: {} });
    state = transitionInvocationState({ from: state, to: 'RUNNING', evidence: {} });
    expect(() => transitionInvocationState({ from: state, to: 'SUCCEEDED', evidence: {} })).toThrow(
      /durable final/u,
    );
    state = transitionInvocationState({
      from: state,
      to: 'SUCCEEDED',
      evidence: { durableFinal: true },
    });
    expect(state).toBe('SUCCEEDED');
  });

  it('terminal 不可离开且 CANCELLED/UNCERTAIN/EXPIRED 均需特定证据', () => {
    for (const terminal of TERMINAL_INVOCATION_STATES) {
      expect(isTerminalInvocationState(terminal)).toBe(true);
      for (const next of InvocationStateSchema.options) {
        expect(() => transitionInvocationState({ from: terminal, to: next, evidence: {} })).toThrow(
          InvalidInvocationTransitionError,
        );
      }
    }
    expect(() =>
      transitionInvocationState({ from: 'QUEUED', to: 'CANCELLED', evidence: {} }),
    ).toThrow(/interrupt/u);
    expect(() =>
      transitionInvocationState({ from: 'RECONCILING', to: 'UNCERTAIN', evidence: {} }),
    ).toThrow(/reconciliation/u);
    expect(() =>
      transitionInvocationState({ from: 'QUEUED', to: 'EXPIRED', evidence: {} }),
    ).toThrow(/queue TTL/u);
  });

  it('cancel/final race 允许 durable final 赢，不能靠请求取消伪造 CANCELLED', () => {
    expect(
      transitionInvocationState({
        from: 'CANCEL_REQUESTED',
        to: 'SUCCEEDED',
        evidence: { durableFinal: true },
      }),
    ).toBe('SUCCEEDED');
    expect(() =>
      transitionInvocationState({ from: 'CANCEL_REQUESTED', to: 'CANCELLED', evidence: {} }),
    ).toThrow(/interrupt/u);
    expect(
      transitionInvocationState({
        from: 'CANCEL_REQUESTED',
        to: 'CANCELLED',
        evidence: { interruptConfirmed: true },
      }),
    ).toBe('CANCELLED');
  });

  it('本地 Journal 永久丢失时允许 PERSISTED 进入有界 reconciliation，但不能跳过证据', () => {
    expect(() =>
      transitionInvocationState({ from: 'PERSISTED', to: 'RECONCILING', evidence: {} }),
    ).toThrow(/执行证据丢失/u);
    expect(
      transitionInvocationState({
        from: 'PERSISTED',
        to: 'RECONCILING',
        evidence: { executionEvidenceLost: true },
      }),
    ).toBe('RECONCILING');
    expect(
      transitionInvocationState({
        from: 'RECONCILING',
        to: 'UNCERTAIN',
        evidence: { reconciliationExhausted: true },
      }),
    ).toBe('UNCERTAIN');
  });

  it('每个稳定错误码都有唯一 retry policy 且 error response 不能漂移', () => {
    expect(Object.keys(VNEXT_ERROR_CLASSIFICATION)).toHaveLength(
      VnextErrorCodeSchema.options.length,
    );
    for (const code of VnextErrorCodeSchema.options) {
      const entry = VNEXT_ERROR_CLASSIFICATION[code];
      const response = errorResponseFor(code, 'public-request-0001');
      expect(VnextErrorResponseSchema.parse(response).retryPolicy).toBe(entry.retryPolicy);
      expect(response.message).not.toMatch(/[A-Z]{2,}_[A-Z]/u);
    }
    expect(VNEXT_ERROR_CLASSIFICATION.EXECUTION_STATE_UNKNOWN.retryPolicy).toBe(
      'DO_NOT_AUTO_RETRY',
    );
    expect(VNEXT_ERROR_CLASSIFICATION.CANCEL_NOT_CONFIRMED.retryPolicy).toBe('DO_NOT_AUTO_RETRY');
    expect(VNEXT_ERROR_CLASSIFICATION.INVOCATION_EXPIRED.retryPolicy).toBe(
      'NEW_INVOCATION_ALLOWED',
    );
  });
});
