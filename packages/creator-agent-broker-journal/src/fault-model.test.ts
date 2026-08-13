import { describe, expect, it } from 'vitest';

import {
  FAULT_COVERAGE,
  FAULT_POINTS,
  RecordingFaultPort,
  SIMULATED_RECOVERY_FAULT_POINTS,
  runSimulatedRecoveryScenario,
} from './fault-model.js';

const MODEL_RUNS = Number.parseInt(process.env.VNEXT_FAULT_MODEL_RUNS ?? '100', 10);
const MODEL_SEED = Number.parseInt(process.env.VNEXT_FAULT_MODEL_SEED ?? '1597463007', 10) >>> 0;

describe('E1 fault-model registry', () => {
  it('classifies all twenty formal failpoints once without claiming Gate 4', () => {
    expect(FAULT_POINTS).toHaveLength(20);
    expect(new Set(FAULT_POINTS).size).toBe(20);
    expect(FAULT_COVERAGE.map((entry) => entry.point)).toEqual(FAULT_POINTS);
    expect(FAULT_COVERAGE).toHaveLength(20);
    expect(SIMULATED_RECOVERY_FAULT_POINTS).toHaveLength(9);
    expect(FAULT_COVERAGE.some((entry) => entry.evidence === 'BLOCKED_E2_E6')).toBe(true);
  });

  it.each(SIMULATED_RECOVERY_FAULT_POINTS)(
    '%s reconstructs serialized state with at-most-one external effects',
    (point) => {
      const result = runSimulatedRecoveryScenario(point);
      expect(result.evidence).toBe('SIMULATED_RECOVERY_E1');
      expect(result.reconstructionCount).toBeGreaterThanOrEqual(1);
      expect(result.cloudState).toBe('SUCCEEDED');
      expect(result.workerState).toBe('CLOUD_COMMITTED');
      expect(result.codexTurnStartCount).toBe(1);
      expect(result.providerUpstreamRequestCount).toBe(1);
      expect(result.consumerVisibleFinalCount).toBe(1);
      expect(result.cloudAssistantMessageCount).toBe(1);
      expect(result.automaticRetryAfterUnknown).toBe(false);
    },
  );

  it('keeps the independent recording port idempotent across reconstruction', () => {
    const recorder = new RecordingFaultPort();
    recorder.recordCodexTurnStart('invocation-a');
    recorder.recordProviderRequest('provider-a', 'digest-a');
    recorder.recordConsumerFinal('invocation-a', 'result-a');
    const restored = RecordingFaultPort.restore(recorder.serialize());
    restored.recordCodexTurnStart('invocation-a');
    restored.recordProviderRequest('provider-a', 'digest-a');
    restored.recordConsumerFinal('invocation-a', 'result-a');
    expect(restored.snapshot()).toEqual({
      codexTurnStartCount: 1,
      providerUpstreamRequestCount: 1,
      consumerVisibleFinalCount: 1,
    });
    expect(() => restored.recordProviderRequest('provider-a', 'changed')).toThrow(
      'PROVIDER_REPLAY_CONFLICT',
    );
  });

  it(`runs ${MODEL_RUNS} seeded E1 reconstruction-model sequences without duplicate effects`, () => {
    expect(Number.isSafeInteger(MODEL_RUNS) && MODEL_RUNS > 0).toBe(true);
    const random = xorshift32(MODEL_SEED);
    for (let run = 0; run < MODEL_RUNS; run += 1) {
      const point =
        SIMULATED_RECOVERY_FAULT_POINTS[random() % SIMULATED_RECOVERY_FAULT_POINTS.length]!;
      const result = runSimulatedRecoveryScenario(point);
      expect(result).toMatchObject({
        evidence: 'SIMULATED_RECOVERY_E1',
        codexTurnStartCount: 1,
        providerUpstreamRequestCount: 1,
        consumerVisibleFinalCount: 1,
        cloudAssistantMessageCount: 1,
        automaticRetryAfterUnknown: false,
      });
    }
  });
});

function xorshift32(seed: number): () => number {
  let state = seed === 0 ? 0x6d2b79f5 : seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}
