import { describe, expect, it } from 'vitest';

import { HostThreadSchema, type HostInterruptReason } from '@cb/creator-agent-protocol/host';
import {
  HOST_INTERRUPT_WRITE_LINEARIZED,
  HostInterruptNotSentError,
  HostTurnIdSchema,
  createHostTurnAdapterController,
  createHostTurnNotStartedError,
  createHostTurnStartEvidenceLostError,
  type HostInterruptWriter,
  type HostTurnAdapterController,
} from '@cb/creator-agent-protocol/host-adapter';

import {
  executeWorkerHostInterrupt,
  executeWorkerHostStart,
  sealAndFinalizeWorkerHostSuccess,
  verifyAndProjectHostOutcome,
} from '../host-projection.js';
import {
  workerInvocationAttemptId,
  workerInterruptAttempt,
  type WorkerInterruptHostEffect,
  type WorkerStartHostEffect,
} from '../effect-authority.js';
import { createWorkerResultSealAuthority } from '../result-seal.js';
import {
  createPreparedWorkerInvocation,
  reduceWorkerInvocation,
  type WorkerInvocationTransitionError,
  type WorkerInvocationEvent,
  type WorkerInvocationState,
} from '../worker-invocation.js';

const thread = HostThreadSchema.parse({
  id: 'thread.reducer',
  generation: 3,
  workspaceRootsAcknowledged: true,
});
const turnId = HostTurnIdSchema.parse('turn.reducer.001');
const startAttempt = workerInvocationAttemptId('start.attempt.001');
const staleStartAttempt = workerInvocationAttemptId('start.attempt.stale');
const interruptAttempt1 = workerInvocationAttemptId('interrupt.attempt.001');
const interruptAttempt2 = workerInvocationAttemptId('interrupt.attempt.002');
const interruptSequence1 = workerInterruptAttempt(1);
const interruptSequence2 = workerInterruptAttempt(2);
const sealedFingerprint = `sha256:${'b'.repeat(64)}`;

function createController(
  writeInterrupt: HostInterruptWriter = () => HOST_INTERRUPT_WRITE_LINEARIZED,
  generation = 3,
): HostTurnAdapterController {
  return createHostTurnAdapterController({
    thread: HostThreadSchema.parse({ ...thread, generation }),
    turnId,
    writeInterrupt,
  });
}

function settledObservation(
  controller: HostTurnAdapterController,
  outputState: 'USABLE' | 'UNUSABLE' = 'USABLE',
): unknown {
  return {
    thread: controller.handle.thread,
    turnId: controller.handle.turnId,
    completedAt: 1_787_281_400_000,
    terminalStatus: 'completed',
    terminalError: 'NONE',
    outputState,
  };
}

function interruptedObservation(controller: HostTurnAdapterController): unknown {
  return {
    thread: controller.handle.thread,
    turnId: controller.handle.turnId,
    completedAt: 1_787_281_400_001,
    terminalStatus: 'interrupted',
    terminalError: 'NONE',
    outputState: 'NOT_APPLICABLE',
  };
}

function dispatchPlan(attemptId = startAttempt) {
  return reduceWorkerInvocation(createPreparedWorkerInvocation(), {
    type: 'DISPATCH_INTENT_RECORDED',
    attemptId,
  });
}

function dispatchingState(): WorkerInvocationState {
  return dispatchPlan().next;
}

function startEffect(plan: ReturnType<typeof dispatchPlan>): WorkerStartHostEffect {
  const effect = plan.afterCommit[0];
  if (effect?.type !== 'START_HOST') throw new Error('expected START_HOST effect');
  return effect;
}

function interruptEffect(
  plan: ReturnType<typeof reduceWorkerInvocation>,
): WorkerInterruptHostEffect {
  const effect = plan.afterCommit[0];
  if (effect?.type !== 'INTERRUPT_HOST') throw new Error('expected INTERRUPT_HOST effect');
  return effect;
}

async function runningState(controller: HostTurnAdapterController): Promise<WorkerInvocationState> {
  const dispatch = dispatchPlan();
  const disposition = await executeWorkerHostStart(startEffect(dispatch), async () =>
    Promise.resolve(controller.handle),
  );
  return reduceWorkerInvocation(dispatch.next, {
    type: 'HOST_START_DISPOSITION_RECORDED',
    disposition,
  }).next;
}

function expectTransitionError(
  action: () => unknown,
  code: WorkerInvocationTransitionError['code'],
): void {
  expect(action).toThrowError(expect.objectContaining({ code }));
}

function readyTerminal(controller: HostTurnAdapterController, outcome: unknown) {
  const verified = verifyAndProjectHostOutcome(controller.handle, outcome);
  if (verified.status !== 'TERMINAL_READY') throw new Error('expected ready terminal');
  return verified.terminal;
}

async function sealedSuccessTerminal(controller: HostTurnAdapterController, text: string) {
  const verified = verifyAndProjectHostOutcome(
    controller.handle,
    controller.settle(settledObservation(controller), { text }),
  );
  if (verified.status !== 'SUCCESS_REQUIRES_SEAL') throw new Error('expected success');
  const authority = createWorkerResultSealAuthority(async () => ({
    sealedResultId: 'sealed.reducer.001',
    sealedFingerprint,
    envelope: Object.freeze({ ciphertext: 'opaque-result' }),
  }));
  return sealAndFinalizeWorkerHostSuccess(verified, authority);
}

async function interruptState(
  state: WorkerInvocationState,
  controller: HostTurnAdapterController,
  attemptId: typeof interruptAttempt1,
  attempt: typeof interruptSequence1,
  reason: HostInterruptReason,
): Promise<WorkerInvocationState> {
  const requested = reduceWorkerInvocation(state, {
    type: 'INTERRUPT_INTENT_RECORDED',
    attemptId,
    attempt,
    reason,
  });
  const disposition = await executeWorkerHostInterrupt(
    interruptEffect(requested),
    controller.handle,
  );
  return reduceWorkerInvocation(requested.next, {
    type: 'HOST_INTERRUPT_DISPOSITION_RECORDED',
    disposition,
  }).next;
}

describe('Worker invocation execution reducer', () => {
  it('plans commit-before-start and requires seal-before-SUCCEEDED durability', async () => {
    const dispatch = reduceWorkerInvocation(createPreparedWorkerInvocation(), {
      type: 'DISPATCH_INTENT_RECORDED',
      attemptId: startAttempt,
    });
    expect(dispatch).toEqual({
      next: { phase: 'DISPATCHING', startAttemptId: startAttempt, pendingInterrupt: null },
      durable: [],
      afterCommit: [{ type: 'START_HOST', attemptId: startAttempt }],
    });

    const controller = createController();
    const startDisposition = await executeWorkerHostStart(startEffect(dispatch), async () =>
      Promise.resolve(controller.handle),
    );
    const started = reduceWorkerInvocation(dispatch.next, {
      type: 'HOST_START_DISPOSITION_RECORDED',
      disposition: startDisposition,
    });
    expect(started.next).toMatchObject({ phase: 'RUNNING', interrupt: { state: 'NONE' } });
    expect(started.durable).toMatchObject([{ type: 'ENQUEUE_STARTED_FACT' }]);

    const terminal = await sealedSuccessTerminal(controller, 'do not persist me');
    const completed = reduceWorkerInvocation(started.next, {
      type: 'HOST_TERMINAL_CONFIRMED',
      terminal,
    });
    expect(completed.next).toMatchObject({
      phase: 'TERMINAL_READY',
      terminal: {
        outcome: 'SUCCEEDED',
        host: { sealedResult: { sealedResultId: 'sealed.reducer.001' } },
      },
    });
    expect(JSON.stringify(completed)).not.toContain('do not persist me');
  });

  it('cancels PREPARED only from its own zero-dispatch state', () => {
    const cancelled = reduceWorkerInvocation(createPreparedWorkerInvocation(), {
      type: 'CANCEL_PROVEN_NOT_DISPATCHED',
    });
    expect(cancelled.next).toEqual({
      phase: 'TERMINAL_READY',
      terminal: {
        outcome: 'CANCELLED',
        source: 'PROVED_NOT_DISPATCHED',
        proof: 'NO_DISPATCH_INTENT',
        startAttemptId: null,
      },
    });
  });

  it('binds a NOT_STARTED proof to the exact start attempt', async () => {
    const dispatch = dispatchPlan();
    const pending = reduceWorkerInvocation(dispatch.next, {
      type: 'INTERRUPT_INTENT_RECORDED',
      attemptId: interruptAttempt1,
      attempt: interruptSequence1,
      reason: 'USER_CANCEL',
    }).next;
    const staleDispatch = dispatchPlan(staleStartAttempt);
    const stale = await executeWorkerHostStart(startEffect(staleDispatch), async () => {
      throw createHostTurnNotStartedError();
    });
    expectTransitionError(
      () =>
        reduceWorkerInvocation(pending, {
          type: 'HOST_START_DISPOSITION_RECORDED',
          disposition: stale,
        }),
      'ATTEMPT_MISMATCH',
    );

    const exactDisposition = await executeWorkerHostStart(startEffect(dispatch), async () => {
      throw createHostTurnNotStartedError();
    });
    const exact = reduceWorkerInvocation(pending, {
      type: 'HOST_START_DISPOSITION_RECORDED',
      disposition: exactDisposition,
    });
    expect(exact.next).toMatchObject({
      phase: 'TERMINAL_READY',
      terminal: {
        outcome: 'CANCELLED',
        proof: 'HOST_START_PROVED_NOT_SENT',
        startAttemptId: startAttempt,
      },
    });
  });

  it('sends a pending interrupt before observing outcome after start commit', async () => {
    const controller = createController();
    const dispatch = dispatchPlan();
    const pending = reduceWorkerInvocation(dispatch.next, {
      type: 'INTERRUPT_INTENT_RECORDED',
      attemptId: interruptAttempt1,
      attempt: interruptSequence1,
      reason: 'USER_CANCEL',
    }).next;
    const startDisposition = await executeWorkerHostStart(startEffect(dispatch), async () =>
      Promise.resolve(controller.handle),
    );
    if (startDisposition.disposition !== 'STARTED') throw new Error('expected started');
    const started = reduceWorkerInvocation(pending, {
      type: 'HOST_START_DISPOSITION_RECORDED',
      disposition: startDisposition,
    });
    expect(started.afterCommit).toEqual([
      {
        type: 'INTERRUPT_HOST',
        attemptId: interruptAttempt1,
        attempt: interruptSequence1,
        binding: startDisposition.binding,
        reason: 'USER_CANCEL',
      },
      {
        type: 'OBSERVE_HOST_OUTCOME',
        binding: startDisposition.binding,
      },
    ]);
  });

  it('preserves start and pending-interrupt lineage in every DISPATCHING uncertainty', async () => {
    const dispatch = dispatchPlan();
    const pending = reduceWorkerInvocation(dispatch.next, {
      type: 'INTERRUPT_INTENT_RECORDED',
      attemptId: interruptAttempt1,
      attempt: interruptSequence1,
      reason: 'TIMEOUT',
    }).next;
    const lostDisposition = await executeWorkerHostStart(startEffect(dispatch), async () => {
      throw createHostTurnStartEvidenceLostError('HOST_SESSION_LOST');
    });
    const lost = reduceWorkerInvocation(pending, {
      type: 'HOST_START_DISPOSITION_RECORDED',
      disposition: lostDisposition,
    });
    expect(lost.next).toMatchObject({
      phase: 'TERMINAL_READY',
      terminal: {
        outcome: 'UNCERTAIN',
        reason: 'START_DISPATCH_UNKNOWN',
        context: {
          startAttemptId: startAttempt,
          binding: null,
          interrupt: {
            state: 'PENDING_START',
            attemptId: interruptAttempt1,
            attempt: interruptSequence1,
            reason: 'TIMEOUT',
          },
        },
      },
    });
    expect(
      reduceWorkerInvocation(pending, { type: 'PROCESS_RECOVERY_WITHOUT_HANDLE' }).next,
    ).toMatchObject({
      terminal: { context: { interrupt: { attemptId: interruptAttempt1, reason: 'TIMEOUT' } } },
    });
  });

  it.each([
    ['USER_CANCEL', 'CANCELLED', undefined],
    ['TIMEOUT', 'FAILED', 'TURN_TIMEOUT'],
  ] as const)(
    'requires exact SENT %s lineage for its Host terminal',
    async (reason, outcome, code) => {
      const controller = createController();
      const state = await interruptState(
        await runningState(controller),
        controller,
        interruptAttempt1,
        interruptSequence1,
        reason,
      );
      const terminal = readyTerminal(
        controller,
        controller.settleInterrupted(interruptedObservation(controller)),
      );
      expect(
        reduceWorkerInvocation(state, { type: 'HOST_TERMINAL_CONFIRMED', terminal }).next,
      ).toMatchObject({
        phase: 'TERMINAL_READY',
        terminal: { outcome, ...(code === undefined ? {} : { host: { errorCode: code } }) },
      });
    },
  );

  it.each([
    ['USER_CANCEL', 'CANCELLED'],
    ['TIMEOUT', 'FAILED'],
  ] as const)(
    'buffers a one-shot %s terminal until its exact interrupt disposition commits',
    async (reason, outcome) => {
      const controller = createController();
      const running = await runningState(controller);
      const requested = reduceWorkerInvocation(running, {
        type: 'INTERRUPT_INTENT_RECORDED',
        attemptId: interruptAttempt1,
        attempt: interruptSequence1,
        reason,
      });
      const dispositionTask = executeWorkerHostInterrupt(
        interruptEffect(requested),
        controller.handle,
      );
      const terminal = readyTerminal(
        controller,
        controller.settleInterrupted(interruptedObservation(controller)),
      );
      const buffered = reduceWorkerInvocation(requested.next, {
        type: 'HOST_TERMINAL_CONFIRMED',
        terminal,
      });
      expect(buffered).toMatchObject({
        next: { phase: 'RUNNING', pendingInterruptedTerminal: { outcome } },
        durable: [],
      });
      expect(
        reduceWorkerInvocation(buffered.next, { type: 'PROCESS_RECOVERY_WITHOUT_HANDLE' }).next,
      ).toMatchObject({
        terminal: {
          reason: 'PROCESS_RESTART_AFTER_TERMINAL_OBSERVED',
          context: { observedInterruptedTerminal: { outcome } },
        },
      });

      const completed = reduceWorkerInvocation(buffered.next, {
        type: 'HOST_INTERRUPT_DISPOSITION_RECORDED',
        disposition: await dispositionTask,
      });
      expect(completed.next).toMatchObject({
        phase: 'TERMINAL_READY',
        terminal: {
          outcome,
          startAttemptId: startAttempt,
          interrupt: {
            state: 'SENT',
            attemptId: interruptAttempt1,
            request: { reason },
          },
        },
      });
      expect(completed.durable).toMatchObject([{ type: 'ENQUEUE_TERMINAL_FACT' }]);
    },
  );

  it('rejects stale NOT_SENT from an earlier interrupt attempt', async () => {
    let first = true;
    const controller = createController(() => {
      if (first) {
        first = false;
        throw new HostInterruptNotSentError();
      }
      return HOST_INTERRUPT_WRITE_LINEARIZED;
    });
    let state = await runningState(controller);
    const firstRequest = reduceWorkerInvocation(state, {
      type: 'INTERRUPT_INTENT_RECORDED',
      attemptId: interruptAttempt1,
      attempt: interruptSequence1,
      reason: 'USER_CANCEL',
    });
    const oldDisposition = await executeWorkerHostInterrupt(
      interruptEffect(firstRequest),
      controller.handle,
    );
    state = reduceWorkerInvocation(firstRequest.next, {
      type: 'HOST_INTERRUPT_DISPOSITION_RECORDED',
      disposition: oldDisposition,
    }).next;
    expect(state).toMatchObject({ phase: 'RUNNING', interrupt: { state: 'NOT_SENT' } });

    const secondRequest = reduceWorkerInvocation(state, {
      type: 'INTERRUPT_INTENT_RECORDED',
      attemptId: interruptAttempt2,
      attempt: interruptSequence2,
      reason: 'TIMEOUT',
    });
    state = secondRequest.next;
    expectTransitionError(
      () =>
        reduceWorkerInvocation(state, {
          type: 'HOST_INTERRUPT_DISPOSITION_RECORDED',
          disposition: oldDisposition,
        }),
      'ATTEMPT_MISMATCH',
    );
    const sent = await executeWorkerHostInterrupt(
      interruptEffect(secondRequest),
      controller.handle,
    );
    state = reduceWorkerInvocation(state, {
      type: 'HOST_INTERRUPT_DISPOSITION_RECORDED',
      disposition: sent,
    }).next;
    expect(state).toMatchObject({
      phase: 'RUNNING',
      interrupt: { state: 'SENT', attemptId: interruptAttempt2, request: { reason: 'TIMEOUT' } },
    });
  });

  it('allows success or TURN_FAILED to win after interrupt SENT', async () => {
    for (const outputState of ['USABLE', 'UNUSABLE'] as const) {
      const controller = createController();
      const state = await interruptState(
        await runningState(controller),
        controller,
        interruptAttempt1,
        interruptSequence1,
        'USER_CANCEL',
      );
      const terminal =
        outputState === 'USABLE'
          ? await sealedSuccessTerminal(controller, 'final won')
          : readyTerminal(
              controller,
              controller.settle(settledObservation(controller, 'UNUSABLE'), null),
            );
      expect(
        reduceWorkerInvocation(state, { type: 'HOST_TERMINAL_CONFIRMED', terminal }).next,
      ).toMatchObject({
        phase: 'TERMINAL_READY',
        terminal: { outcome: outputState === 'USABLE' ? 'SUCCEEDED' : 'FAILED' },
      });
    }
  });

  it('keeps TERMINAL_ALREADY_OBSERVED distinct in evidence loss and restart audit', async () => {
    const controller = createController();
    let state = await runningState(controller);
    const requested = reduceWorkerInvocation(state, {
      type: 'INTERRUPT_INTENT_RECORDED',
      attemptId: interruptAttempt1,
      attempt: interruptSequence1,
      reason: 'USER_CANCEL',
    });
    state = requested.next;
    controller.settle(settledObservation(controller), { text: 'terminal won' });
    const disposition = await executeWorkerHostInterrupt(
      interruptEffect(requested),
      controller.handle,
    );
    state = reduceWorkerInvocation(state, {
      type: 'HOST_INTERRUPT_DISPOSITION_RECORDED',
      disposition,
    }).next;
    expect(
      reduceWorkerInvocation(state, {
        type: 'HOST_EVIDENCE_LOST',
        hostReason: 'HOST_TERMINAL_MISSING',
      }).next,
    ).toMatchObject({
      terminal: {
        reason: 'HOST_TERMINAL_OBSERVED_BUT_UNCOMMITTED',
        context: { interrupt: { attemptId: interruptAttempt1, reason: 'USER_CANCEL' } },
      },
    });
    expect(
      reduceWorkerInvocation(state, { type: 'PROCESS_RECOVERY_WITHOUT_HANDLE' }).next,
    ).toMatchObject({ terminal: { reason: 'PROCESS_RESTART_AFTER_TERMINAL_OBSERVED' } });
  });

  it('preserves exact SENT request lineage when recovery becomes UNCERTAIN', async () => {
    const controller = createController();
    const state = await interruptState(
      await runningState(controller),
      controller,
      interruptAttempt1,
      interruptSequence1,
      'USER_CANCEL',
    );
    const recovered = reduceWorkerInvocation(state, { type: 'PROCESS_RECOVERY_WITHOUT_HANDLE' });
    expect(recovered.next).toMatchObject({
      terminal: {
        outcome: 'UNCERTAIN',
        reason: 'PROCESS_RESTART_WITH_INTERRUPT',
        context: {
          interrupt: {
            state: 'SENT',
            attemptId: interruptAttempt1,
            request: { reason: 'USER_CANCEL' },
          },
        },
      },
    });
  });

  it('rejects plain, serialized, cross-generation, and reused attempt capabilities', async () => {
    const forgedStart = {
      type: 'HOST_START_DISPOSITION_RECORDED',
      disposition: {
        disposition: 'STARTED',
        attemptId: startAttempt,
        binding: { thread: JSON.parse(JSON.stringify(thread)), turnId },
      },
    } as unknown as WorkerInvocationEvent;
    expect(() => reduceWorkerInvocation(dispatchingState(), forgedStart)).toThrow(
      /R1 Host projection authority/u,
    );

    const first = createController(undefined, 3);
    const second = createController(undefined, 4);
    const state = await runningState(first);
    if (state.phase !== 'RUNNING') throw new Error('expected running');
    const foreign = readyTerminal(
      second,
      second.settle(settledObservation(second, 'UNUSABLE'), null),
    );
    expectTransitionError(
      () => reduceWorkerInvocation(state, { type: 'HOST_TERMINAL_CONFIRMED', terminal: foreign }),
      'HOST_BINDING_MISMATCH',
    );

    const sameBindingForeign = createController(undefined, 3);
    const sameBindingTerminal = readyTerminal(
      sameBindingForeign,
      sameBindingForeign.settle(settledObservation(sameBindingForeign, 'UNUSABLE'), null),
    );
    expectTransitionError(
      () =>
        reduceWorkerInvocation(state, {
          type: 'HOST_TERMINAL_CONFIRMED',
          terminal: sameBindingTerminal,
        }),
      'HOST_BINDING_MISMATCH',
    );

    const requested = reduceWorkerInvocation(state, {
      type: 'INTERRUPT_INTENT_RECORDED',
      attemptId: interruptAttempt1,
      attempt: interruptSequence1,
      reason: 'USER_CANCEL',
    });
    const serialized = JSON.parse(
      JSON.stringify(await executeWorkerHostInterrupt(interruptEffect(requested), first.handle)),
    );
    expect(() =>
      reduceWorkerInvocation(requested.next, {
        type: 'HOST_INTERRUPT_DISPOSITION_RECORDED',
        disposition: serialized,
      } as unknown as WorkerInvocationEvent),
    ).toThrow(/R1 Host projection authority/u);

    const notSentState = {
      ...state,
      interrupt: {
        state: 'NOT_SENT',
        attemptId: interruptAttempt1,
        attempt: interruptSequence1,
        request: { requestId: 'fake', reason: 'USER_CANCEL', binding: state.binding },
      },
    } as unknown as WorkerInvocationState;
    expectTransitionError(
      () =>
        reduceWorkerInvocation(notSentState, {
          type: 'INTERRUPT_INTENT_RECORDED',
          attemptId: interruptAttempt1,
          attempt: interruptSequence1,
          reason: 'TIMEOUT',
        }),
      'ATTEMPT_MISMATCH',
    );
  });

  it('keeps terminal execution monotonic and has no Cloud ACK phase', () => {
    const terminal = reduceWorkerInvocation(createPreparedWorkerInvocation(), {
      type: 'CANCEL_PROVEN_NOT_DISPATCHED',
    }).next;
    expectTransitionError(
      () =>
        reduceWorkerInvocation(terminal, {
          type: 'DISPATCH_INTENT_RECORDED',
          attemptId: startAttempt,
        }),
      'TERMINAL_MONOTONIC',
    );
    expect(JSON.stringify(terminal)).not.toContain('CLOUD_COMMITTED');
  });
});
