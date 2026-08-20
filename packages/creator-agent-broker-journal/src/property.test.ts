import { describe, expect, it } from 'vitest';

import {
  INVOCATION_STATES,
  isTerminalInvocationState,
  transitionInvocation,
  type InvocationEvent,
  type InvocationState,
} from './invocation.js';
import {
  reconcileInvocation,
  type HostEvidence,
  type LocalEvidenceState,
} from './reconciliation.js';
import {
  AGENT_VERSION_DIGEST,
  IDS,
  NOW_MS,
  REQUEST_DIGEST,
  createLeaseAuthority,
  createSignedCapabilityFixture,
} from './reference-fixture.js';
import { InMemoryWorkerJournal } from './worker-journal.js';

const PROPERTY_SEEDS = Array.from({ length: 256 }, (_, index) => 0x5f37_0000 + index);
const EVENTS_PER_SEED = 400;

const EVENT_FACTORIES: readonly (() => InvocationEvent)[] = [
  () => ({ type: 'QUEUE' }),
  () => ({ type: 'REQUEST_DISPATCH' }),
  () => ({ type: 'RELEASE_DISPATCH' }),
  () => ({ type: 'WORKER_PERSISTED' }),
  () => ({ type: 'REQUEST_START' }),
  () => ({ type: 'HOST_STARTED' }),
  () => ({ type: 'REQUEST_CANCEL' }),
  () => ({ type: 'SUCCEED', finalDurable: true }),
  () => ({ type: 'SUCCEED', finalDurable: false }),
  () => ({ type: 'FAIL_CONFIRMED' }),
  () => ({ type: 'INTERRUPT_CONFIRMED' }),
  () => ({ type: 'LOSE_EXECUTION_EVIDENCE' }),
  () => ({ type: 'RECONCILE_RUNNING' }),
  () => ({ type: 'RECONCILE_SUCCEEDED', finalDurable: true }),
  () => ({ type: 'RECONCILE_FAILED' }),
  () => ({ type: 'RECONCILE_CANCELLED', interruptConfirmed: true }),
  () => ({ type: 'RECONCILE_CANCELLED', interruptConfirmed: false }),
  () => ({ type: 'RECONCILE_UNCERTAIN' }),
  () => ({ type: 'EXPIRE_BEFORE_DISPATCH', dispatchProvenAbsent: true }),
  () => ({ type: 'EXPIRE_BEFORE_DISPATCH', dispatchProvenAbsent: false }),
];

describe('property model with reproducible seeds', () => {
  it(`preserves terminal monotonicity across ${PROPERTY_SEEDS.length} seeds and ${PROPERTY_SEEDS.length * EVENTS_PER_SEED} event attempts`, () => {
    for (const seed of PROPERTY_SEEDS) {
      const random = lcg(seed);
      let state: InvocationState = 'ACCEPTED';
      for (let step = 0; step < EVENTS_PER_SEED; step += 1) {
        const before: InvocationState = state;
        const wasTerminal = isTerminalInvocationState(before);
        const factory = EVENT_FACTORIES[Math.floor(random() * EVENT_FACTORIES.length)]!;
        try {
          state = transitionInvocation(state, factory());
          if (wasTerminal && state !== before) {
            throw new Error(`seed=${seed} step=${step}: terminal ${before} changed to ${state}`);
          }
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('seed=')) throw error;
          state = before;
        }
      }
    }
  });

  it('only allows automatic work when reconciliation proves pre-dispatch and current authority', () => {
    const localStates: readonly LocalEvidenceState[] = [
      'MISSING',
      'RECEIVED',
      'PREPARED',
      'STARTING',
      'RUNNING',
      'FINAL_READY',
      'CLOUD_COMMITTED',
      'FAILED',
      'CANCELLED',
      'UNCERTAIN',
    ];
    const hostEvidence: readonly HostEvidence[] = [
      'PROVEN_NOT_DISPATCHED',
      'RUNNING_EXACT_TURN',
      'COMPLETED_EXACT_FINAL',
      'FAILED_CONFIRMED',
      'INTERRUPTED_CONFIRMED',
      'UNAVAILABLE',
    ];
    for (const cloudState of INVOCATION_STATES) {
      for (const localState of localStates) {
        for (const host of hostEvidence) {
          for (const leaseState of ['CURRENT', 'STALE', 'REVOKED'] as const) {
            for (const executionCapability of ['VALID_FOR_INVOCATION', 'INVALID'] as const) {
              for (const bindingDigestsMatch of [true, false]) {
                const result = reconcileInvocation({
                  cloudState,
                  localState,
                  hostEvidence: host,
                  leaseState,
                  executionCapability,
                  bindingDigestsMatch,
                });
                if (result.automaticInferenceAllowed) {
                  expect(result.decision).toBe('REPLAY_COMMAND');
                  expect(['invocation.prepare', 'invocation.start']).toContain(
                    result.replayCommand,
                  );
                  expect(leaseState).toBe('CURRENT');
                  expect(executionCapability).toBe('VALID_FOR_INVOCATION');
                  expect(bindingDigestsMatch).toBe(true);
                  expect(isTerminalInvocationState(cloudState)).toBe(false);
                }
                if (
                  (localState === 'STARTING' || localState === 'RUNNING') &&
                  host === 'UNAVAILABLE'
                ) {
                  expect(result.automaticInferenceAllowed).toBe(false);
                }
              }
            }
          }
        }
      }
    }
  });

  it('coalesces 1-100 duplicate prepare deliveries for every fixed seed', () => {
    const signed = createSignedCapabilityFixture();
    const { lease } = createLeaseAuthority();
    for (const seed of PROPERTY_SEEDS) {
      const random = lcg(seed);
      const deliveries = 1 + Math.floor(random() * 100);
      const worker = new InMemoryWorkerJournal(signed.authority);
      for (let index = 0; index < deliveries; index += 1) {
        worker.prepare({
          invocationId: IDS.invocationA,
          conversationId: IDS.conversationA,
          clientMessageId: `client-${seed}`,
          requestDigest: REQUEST_DIGEST,
          agentVersionId: IDS.agentVersion,
          agentVersionDigest: AGENT_VERSION_DIGEST,
          providerRequestId: IDS.providerRequest,
          workerInstallationId: IDS.worker,
          lease,
          executionCapability: signed.capability,
          expectedExecutionCapability: signed.expected,
          nowMs: NOW_MS,
          commandId: `prepare-${seed}`,
          sourceEventId: `prepared-${seed}`,
        });
      }
      const snapshot = worker.snapshot();
      if (snapshot.invocations.size !== 1 || snapshot.outbox.length !== 1) {
        throw new Error(`seed=${seed}: ${deliveries} deliveries did not coalesce`);
      }
    }
  });
});

function lcg(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    return value / 0x1_0000_0000;
  };
}
