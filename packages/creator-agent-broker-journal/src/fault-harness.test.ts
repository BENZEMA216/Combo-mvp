import { describe, expect, it } from 'vitest';

import {
  FAULT_POINTS,
  FaultController,
  InjectedFault,
  runReferenceFaultScenario,
} from './fault-harness.js';

const UNCERTAIN_POINTS = new Set([
  'FLT-007_STARTING_COMMIT_BEFORE_HOST_CALL',
  'FLT-008_HOST_ACCEPTED_BEFORE_TURN_ID',
  'FLT-010_RUNNING_WORKER_CRASH',
  'FLT-014_CANCEL_BEFORE_INTERRUPT_ACK',
  'FLT-019_PROXY_RESPONSE_CONNECTION_DROP',
  'FLT-020_VM_CLEANUP_FAILURE',
]);

describe('fault controller', () => {
  it('injects each armed point exactly once', () => {
    const controller = new FaultController();
    controller.arm('FLT-003_OUTBOX_COMMIT_BEFORE_SEND', 'drop');
    expect(controller.reach('FLT-003_OUTBOX_COMMIT_BEFORE_SEND')).toMatchObject({
      mode: 'drop',
      drop: true,
      duplicateDeliveries: 1,
    });
    expect(controller.reach('FLT-003_OUTBOX_COMMIT_BEFORE_SEND')).toBeUndefined();
    expect(controller.reachCount('FLT-003_OUTBOX_COMMIT_BEFORE_SEND')).toBe(2);
  });

  it.each([
    ['delay', { delayMs: 1 }],
    ['duplicate', { duplicateDeliveries: 2 }],
    ['corrupt', { corrupt: true }],
  ] as const)('returns an executable %s directive', (mode, expected) => {
    const controller = new FaultController();
    controller.arm('FLT-018_GATEWAY_ROLLING_RESTART', mode);
    expect(controller.reach('FLT-018_GATEWAY_ROLLING_RESTART')).toMatchObject(expected);
  });

  it('keeps a typed injected failure', () => {
    const controller = new FaultController();
    controller.arm('FLT-001_API_BEFORE_TRANSACTION');
    expect(() => controller.reach('FLT-001_API_BEFORE_TRANSACTION')).toThrowError(InjectedFault);
  });
});

describe('twenty formal VNext failpoints', () => {
  it('keeps the registry complete and duplicate-free', () => {
    expect(FAULT_POINTS).toHaveLength(20);
    expect(new Set(FAULT_POINTS).size).toBe(20);
  });

  it.each(FAULT_POINTS)('%s converges without duplicate inference/final', (point) => {
    const result = runReferenceFaultScenario(point);
    expect(result.injected).toBe(true);
    expect(['SUCCEEDED', 'UNCERTAIN']).toContain(result.terminalState);
    expect(result.codexTurnStartCount).toBeLessThanOrEqual(1);
    expect(result.providerUpstreamRequestCount).toBeLessThanOrEqual(1);
    expect(result.consumerVisibleFinalCount).toBeLessThanOrEqual(1);
    expect(result.duplicateFinalCount).toBe(0);
    expect(result.automaticRetryAfterUnknown).toBe(false);
    if (UNCERTAIN_POINTS.has(point)) {
      expect(result.terminalState).toBe('UNCERTAIN');
      expect(result.consumerVisibleFinalCount).toBe(0);
    } else {
      expect(result.terminalState).toBe('SUCCEEDED');
      expect(result.consumerVisibleFinalCount).toBe(1);
    }
  });
});
