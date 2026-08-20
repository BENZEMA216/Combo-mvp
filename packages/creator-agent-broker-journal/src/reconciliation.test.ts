import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { INVOCATION_STATES } from './invocation.js';
import {
  reconcileInvocation,
  type HostEvidence,
  type LocalEvidenceState,
  type ReconciliationDecision,
  type ReconciliationEvidence,
} from './reconciliation.js';
import { LOCAL_INVOCATION_STATES } from './worker-journal.js';

interface GoldenRow extends ReconciliationEvidence {
  readonly id: string;
  readonly decision: ReconciliationDecision;
  readonly automaticInferenceAllowed: boolean;
  readonly replayCommand?: 'invocation.prepare' | 'invocation.start';
}

const GOLDEN_BYTES = readFileSync(
  new URL('../test-fixtures/reconciliation-golden.json', import.meta.url),
  'utf8',
);
const GOLDEN_ROWS = JSON.parse(GOLDEN_BYTES) as GoldenRow[];
const LOCAL_EVIDENCE_STATES = [
  'MISSING',
  ...LOCAL_INVOCATION_STATES,
] as const satisfies readonly LocalEvidenceState[];
const HOST_EVIDENCE = [
  'PROVEN_NOT_DISPATCHED',
  'RUNNING_EXACT_TURN',
  'COMPLETED_EXACT_FINAL',
  'FAILED_CONFIRMED',
  'INTERRUPTED_CONFIRMED',
  'UNAVAILABLE',
] as const satisfies readonly HostEvidence[];
const LEASE_STATES = ['CURRENT', 'STALE', 'REVOKED'] as const;
const EXECUTION_CAPABILITY_STATES = ['VALID_FOR_INVOCATION', 'INVALID'] as const;
const BINDING_DIGEST_STATES = [true, false] as const;
const EXPECTED_CARTESIAN_ROWS =
  INVOCATION_STATES.length *
  LOCAL_EVIDENCE_STATES.length *
  HOST_EVIDENCE.length *
  LEASE_STATES.length *
  EXECUTION_CAPABILITY_STATES.length *
  BINDING_DIGEST_STATES.length;

describe('cross-journal reconciliation', () => {
  it('pins the independently generated full Cartesian golden fixture', () => {
    expect(
      execFileSync(
        process.execPath,
        [
          fileURLToPath(new URL('../scripts/generate-reconciliation-golden.mjs', import.meta.url)),
          '--check',
        ],
        { encoding: 'utf8' },
      ),
    ).toContain(
      '9360 rows sha256=844cc8f916a6b63c0b8558ee7ec865c3045c0e5ec1607987a8f54a44550e663c',
    );
    expect(EXPECTED_CARTESIAN_ROWS).toBe(9_360);
    expect(GOLDEN_ROWS).toHaveLength(EXPECTED_CARTESIAN_ROWS);
    expect(createHash('sha256').update(GOLDEN_BYTES).digest('hex')).toBe(
      '844cc8f916a6b63c0b8558ee7ec865c3045c0e5ec1607987a8f54a44550e663c',
    );
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

    const keys = new Set(GOLDEN_ROWS.map(goldenKey));
    for (const cloudState of INVOCATION_STATES) {
      for (const localState of LOCAL_EVIDENCE_STATES) {
        for (const hostEvidence of HOST_EVIDENCE) {
          for (const leaseState of LEASE_STATES) {
            for (const executionCapability of EXECUTION_CAPABILITY_STATES) {
              for (const bindingDigestsMatch of BINDING_DIGEST_STATES) {
                expect(
                  keys.has(
                    goldenKey({
                      cloudState,
                      localState,
                      hostEvidence,
                      leaseState,
                      executionCapability,
                      bindingDigestsMatch,
                    }),
                  ),
                  `missing ${cloudState}/${localState}/${hostEvidence}/${leaseState}/${executionCapability}/${bindingDigestsMatch}`,
                ).toBe(true);
              }
            }
          }
        }
      }
    }
  });

  it('matches every independent Cloud x Local x Host x Lease golden row', () => {
    for (const row of GOLDEN_ROWS) {
      const { id, decision, automaticInferenceAllowed, replayCommand, ...evidence } = row;
      expect(reconcileInvocation(evidence), id).toMatchObject({
        decision,
        automaticInferenceAllowed,
        ...(replayCommand ? { replayCommand } : {}),
      });
    }
  });

  it('allows exactly one start replay tuple in the complete valid-binding matrix', () => {
    const startReplayRows = GOLDEN_ROWS.filter(
      (row) => row.decision === 'REPLAY_COMMAND' && row.replayCommand === 'invocation.start',
    );
    expect(startReplayRows).toEqual([
      expect.objectContaining({
        cloudState: 'STARTING',
        localState: 'STARTING',
        hostEvidence: 'PROVEN_NOT_DISPATCHED',
        leaseState: 'CURRENT',
      }),
    ]);
    for (const cloudState of [
      'QUEUED',
      'DISPATCH_PENDING',
      'PERSISTED',
      'CANCEL_REQUESTED',
      'RECONCILING',
    ] as const) {
      expect(
        reconcileInvocation({
          cloudState,
          localState: 'STARTING',
          hostEvidence: 'PROVEN_NOT_DISPATCHED',
          leaseState: 'CURRENT',
          executionCapability: 'VALID_FOR_INVOCATION',
          bindingDigestsMatch: true,
        }),
      ).toMatchObject({ decision: 'SECURITY_BLOCK', automaticInferenceAllowed: false });
    }
  });

  it('marks PERSISTED plus a lost local journal and unavailable Host evidence uncertain', () => {
    for (const leaseState of LEASE_STATES) {
      expect(
        reconcileInvocation({
          cloudState: 'PERSISTED',
          localState: 'MISSING',
          hostEvidence: 'UNAVAILABLE',
          leaseState,
          executionCapability: 'VALID_FOR_INVOCATION',
          bindingDigestsMatch: true,
        }),
      ).toMatchObject({ decision: 'MARK_UNCERTAIN', automaticInferenceAllowed: false });
    }
  });

  it('blocks invalid capability or binding before any replay, including terminal input', () => {
    for (const mutation of [
      { executionCapability: 'INVALID' as const, bindingDigestsMatch: true },
      { executionCapability: 'VALID_FOR_INVOCATION' as const, bindingDigestsMatch: false },
    ]) {
      expect(
        reconcileInvocation({
          cloudState: 'SUCCEEDED',
          localState: 'CLOUD_COMMITTED',
          hostEvidence: 'COMPLETED_EXACT_FINAL',
          leaseState: 'REVOKED',
          ...mutation,
        }),
      ).toMatchObject({ decision: 'SECURITY_BLOCK', automaticInferenceAllowed: false });
    }
  });
});

function goldenKey(
  row: Pick<
    GoldenRow,
    | 'cloudState'
    | 'localState'
    | 'hostEvidence'
    | 'leaseState'
    | 'executionCapability'
    | 'bindingDigestsMatch'
  >,
): string {
  return `${row.cloudState}\0${row.localState}\0${row.hostEvidence}\0${row.leaseState}\0${row.executionCapability}\0${row.bindingDigestsMatch}`;
}
