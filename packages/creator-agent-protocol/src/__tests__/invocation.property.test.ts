import { describe, expect, it } from 'vitest';
import {
  InvalidInvocationTransitionError,
  InvocationStateSchema,
  isTerminalInvocationState,
  transitionInvocationState,
  type InvocationState,
  type InvocationTransitionEvidence,
} from '../invocation.js';
import {
  PROPERTY_RUNS,
  PROPERTY_SEED_BASE,
  PROPERTY_SEED_COUNT,
  propertySeedMatrix,
} from './property-matrix.js';

class XorShift32 {
  public constructor(private state: number) {
    if (state === 0) this.state = 0x6d2b79f5;
  }

  public next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }

  public pick<T>(values: readonly T[]): T {
    return values[this.next() % values.length]!;
  }
}

const randomEvidence = (random: XorShift32): InvocationTransitionEvidence => ({
  durableFinal: Boolean(random.next() & 1),
  terminalFailureConfirmed: Boolean(random.next() & 1),
  interruptConfirmed: Boolean(random.next() & 1),
  provedNotExecuted: Boolean(random.next() & 1),
  executionEvidenceLost: Boolean(random.next() & 1),
  reconciliationExhausted: Boolean(random.next() & 1),
  queueTtlExpiredBeforeDispatch: Boolean(random.next() & 1),
});

describe('Invocation state machine property model', () => {
  it(`${PROPERTY_SEED_COUNT} seeds from ${PROPERTY_SEED_BASE} generate ${PROPERTY_RUNS} random transitions with monotonic evidence invariants`, () => {
    let accepted = 0;
    let rejected = 0;

    for (const { seed, runs } of propertySeedMatrix()) {
      const random = new XorShift32(seed);
      let state: InvocationState = 'ACCEPTED';
      for (let run = 0; run < runs; run += 1) {
        if (isTerminalInvocationState(state)) state = 'ACCEPTED';
        const next = random.pick(InvocationStateSchema.options);
        const evidence = randomEvidence(random);
        try {
          const result = transitionInvocationState({ from: state, to: next, evidence });
          expect(result).toBe(next);
          if (result === 'SUCCEEDED') expect(evidence.durableFinal).toBe(true);
          if (result === 'FAILED') expect(evidence.terminalFailureConfirmed).toBe(true);
          if (result === 'CANCELLED') {
            expect(Boolean(evidence.interruptConfirmed || evidence.provedNotExecuted)).toBe(true);
          }
          if (result === 'RECONCILING') expect(evidence.executionEvidenceLost).toBe(true);
          if (result === 'UNCERTAIN') expect(evidence.reconciliationExhausted).toBe(true);
          if (result === 'EXPIRED') expect(evidence.queueTtlExpiredBeforeDispatch).toBe(true);
          state = result;
          accepted += 1;
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidInvocationTransitionError);
          rejected += 1;
        }
      }
    }

    expect(accepted).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
  });

  it('任一终态对任一后继都拒绝', () => {
    const terminals: InvocationState[] = [
      'SUCCEEDED',
      'FAILED',
      'CANCELLED',
      'UNCERTAIN',
      'EXPIRED',
    ];
    for (const terminal of terminals) {
      for (const next of InvocationStateSchema.options) {
        expect(() =>
          transitionInvocationState({
            from: terminal,
            to: next,
            evidence: randomEvidence(new XorShift32(PROPERTY_SEED_BASE)),
          }),
        ).toThrow(InvalidInvocationTransitionError);
      }
    }
  });
});
