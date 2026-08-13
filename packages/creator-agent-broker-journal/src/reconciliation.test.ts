import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  reconcileInvocation,
  type ReconciliationDecision,
  type ReconciliationEvidence,
} from './reconciliation.js';

interface GoldenRow extends ReconciliationEvidence {
  readonly id: string;
  readonly decision: ReconciliationDecision;
  readonly automaticInferenceAllowed: boolean;
  readonly replayCommand?: 'invocation.prepare' | 'invocation.start';
}

const GOLDEN_ROWS = JSON.parse(
  readFileSync(new URL('../test-fixtures/reconciliation-golden.json', import.meta.url), 'utf8'),
) as GoldenRow[];

describe('cross-journal reconciliation', () => {
  it('uses an independently authored, decision-complete and duplicate-free golden fixture', () => {
    expect(GOLDEN_ROWS).toHaveLength(20);
    expect(new Set(GOLDEN_ROWS.map((row) => row.id)).size).toBe(GOLDEN_ROWS.length);
    expect(new Set(GOLDEN_ROWS.map((row) => row.decision))).toEqual(
      new Set([
        'REPLAY_COMMAND',
        'RESUME_OBSERVATION',
        'SUBMIT_EXISTING_FINAL',
        'MARK_FAILED',
        'MARK_CANCELLED',
        'MARK_UNCERTAIN',
        'SECURITY_BLOCK',
        'NOOP_TERMINAL',
      ]),
    );
  });

  it.each(GOLDEN_ROWS)('$id returns $decision', (row) => {
    const { id: _id, decision, automaticInferenceAllowed, replayCommand, ...evidence } = row;
    expect(reconcileInvocation(evidence)).toMatchObject({
      decision,
      automaticInferenceAllowed,
      ...(replayCommand ? { replayCommand } : {}),
    });
  });

  it('never replays when Host has positive dispatch, running, completed or terminal evidence', () => {
    for (const hostEvidence of [
      'RUNNING_EXACT_TURN',
      'COMPLETED_EXACT_FINAL',
      'FAILED_CONFIRMED',
      'INTERRUPTED_CONFIRMED',
    ] as const) {
      for (const localState of [
        'MISSING',
        'RECEIVED',
        'PREPARED',
        'STARTING',
        'RUNNING',
        'FINAL_READY',
      ] as const) {
        const result = reconcileInvocation({
          cloudState: 'RUNNING',
          localState,
          hostEvidence,
          leaseState: 'CURRENT',
          executionCapability: 'VALID_FOR_INVOCATION',
          bindingDigestsMatch: true,
        });
        expect(result.automaticInferenceAllowed).toBe(false);
        expect(result.decision).not.toMatch(/^REPLAY_/);
      }
    }
  });

  it('treats RUNNING plus proven-not-dispatched as a contradiction, not a replay signal', () => {
    for (const localState of ['MISSING', 'PREPARED', 'STARTING', 'RUNNING'] as const) {
      expect(
        reconcileInvocation({
          cloudState: 'RUNNING',
          localState,
          hostEvidence: 'PROVEN_NOT_DISPATCHED',
          leaseState: 'CURRENT',
          executionCapability: 'VALID_FOR_INVOCATION',
          bindingDigestsMatch: true,
        }),
      ).toMatchObject({ decision: 'SECURITY_BLOCK', automaticInferenceAllowed: false });
    }
  });
});
