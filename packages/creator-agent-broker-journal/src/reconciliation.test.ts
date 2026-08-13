import { describe, expect, it } from 'vitest';

import {
  reconcileInvocation,
  type ReconciliationEvidence,
  type ReconciliationDecision,
} from './reconciliation.js';

const BASE: ReconciliationEvidence = {
  cloudState: 'RUNNING',
  localState: 'RUNNING',
  hostEvidence: 'UNAVAILABLE',
  leaseState: 'CURRENT',
  executionCapability: 'VALID_FOR_INVOCATION',
  bindingDigestsMatch: true,
};

describe('cross-journal reconciliation', () => {
  it.each<{
    name: string;
    input: Partial<ReconciliationEvidence>;
    expected: ReconciliationDecision;
    automatic: boolean;
  }>([
    {
      name: 'cloud terminal wins',
      input: { cloudState: 'SUCCEEDED', localState: 'STARTING' },
      expected: 'NOOP_TERMINAL',
      automatic: false,
    },
    {
      name: 'digest conflict security blocks',
      input: { bindingDigestsMatch: false },
      expected: 'SECURITY_BLOCK',
      automatic: false,
    },
    {
      name: 'digest conflict security blocks even after cloud terminal',
      input: { cloudState: 'SUCCEEDED', bindingDigestsMatch: false },
      expected: 'SECURITY_BLOCK',
      automatic: false,
    },
    {
      name: 'queued and missing safely replays',
      input: { cloudState: 'QUEUED', localState: 'MISSING' },
      expected: 'REPLAY_COMMAND',
      automatic: true,
    },
    {
      name: 'prepared safely replays start',
      input: { cloudState: 'PERSISTED', localState: 'PREPARED' },
      expected: 'REPLAY_COMMAND',
      automatic: true,
    },
    {
      name: 'missing local journal after cloud persisted becomes uncertain',
      input: { cloudState: 'PERSISTED', localState: 'MISSING' },
      expected: 'MARK_UNCERTAIN',
      automatic: false,
    },
    {
      name: 'queryable exact turn resumes observation',
      input: { localState: 'RUNNING', hostEvidence: 'RUNNING_EXACT_TURN' },
      expected: 'RESUME_OBSERVATION',
      automatic: false,
    },
    {
      name: 'durable local final submits existing final',
      input: { localState: 'FINAL_READY', leaseState: 'STALE' },
      expected: 'SUBMIT_EXISTING_FINAL',
      automatic: false,
    },
    {
      name: 'exact host completed final can be imported',
      input: { localState: 'STARTING', hostEvidence: 'COMPLETED_EXACT_FINAL' },
      expected: 'SUBMIT_EXISTING_FINAL',
      automatic: false,
    },
    {
      name: 'confirmed failure marks failed',
      input: { hostEvidence: 'FAILED_CONFIRMED' },
      expected: 'MARK_FAILED',
      automatic: false,
    },
    {
      name: 'confirmed interrupt marks cancelled',
      input: { hostEvidence: 'INTERRUPTED_CONFIRMED' },
      expected: 'MARK_CANCELLED',
      automatic: false,
    },
    {
      name: 'starting and unavailable becomes uncertain',
      input: { localState: 'STARTING', hostEvidence: 'UNAVAILABLE' },
      expected: 'MARK_UNCERTAIN',
      automatic: false,
    },
    {
      name: 'independent no-dispatch proof can replay',
      input: { localState: 'STARTING', hostEvidence: 'PROVEN_NOT_DISPATCHED' },
      expected: 'REPLAY_COMMAND',
      automatic: true,
    },
    {
      name: 'stale worker cannot cross dispatch boundary',
      input: {
        localState: 'STARTING',
        hostEvidence: 'PROVEN_NOT_DISPATCHED',
        leaseState: 'STALE',
      },
      expected: 'SECURITY_BLOCK',
      automatic: false,
    },
  ])('$name', ({ input, expected, automatic }) => {
    expect(reconcileInvocation({ ...BASE, ...input })).toMatchObject({
      decision: expected,
      automaticInferenceAllowed: automatic,
    });
  });

  it('never allows automatic inference when execution evidence is unavailable', () => {
    for (const localState of ['STARTING', 'RUNNING'] as const) {
      const result = reconcileInvocation({
        ...BASE,
        localState,
        hostEvidence: 'UNAVAILABLE',
      });
      expect(result).toMatchObject({
        decision: 'MARK_UNCERTAIN',
        automaticInferenceAllowed: false,
      });
    }
  });
});
