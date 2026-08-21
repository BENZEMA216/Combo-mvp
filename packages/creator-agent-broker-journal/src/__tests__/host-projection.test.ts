import { describe, expect, it, vi } from 'vitest';

import {
  HostThreadSchema,
  HostTurnEvidenceLostError,
  HostTurnNotStartedError,
} from '@cb/creator-agent-protocol/host';
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
  bindingForHostTurn,
  executeWorkerHostInterrupt,
  executeWorkerHostStart,
  sealAndFinalizeWorkerHostSuccess,
  verifyAndProjectHostOutcome,
} from '../host-projection.js';
import {
  createWorkerInterruptHostEffect,
  createWorkerStartHostEffect,
  workerInvocationAttemptId,
  workerInterruptAttempt,
} from '../effect-authority.js';
import { createWorkerResultSealAuthority } from '../result-seal.js';

const thread = HostThreadSchema.parse({
  id: 'thread.worker',
  generation: 11,
  workspaceRootsAcknowledged: true,
});
const turnId = HostTurnIdSchema.parse('turn.worker.001');
const startAttempt = workerInvocationAttemptId('start.worker.001');
const interruptAttempt = workerInvocationAttemptId('interrupt.worker.001');
const otherAttempt = workerInvocationAttemptId('interrupt.worker.002');
const interruptSequence = workerInterruptAttempt(1);
const sealedFingerprint = `sha256:${'a'.repeat(64)}`;

function createController(
  writeInterrupt: HostInterruptWriter = () => HOST_INTERRUPT_WRITE_LINEARIZED,
): HostTurnAdapterController {
  return createHostTurnAdapterController({ thread, turnId, writeInterrupt });
}

function settledObservation(
  terminalStatus: 'completed' | 'failed' = 'completed',
  outputState: 'USABLE' | 'UNUSABLE' | 'NOT_APPLICABLE' = 'USABLE',
): unknown {
  return {
    thread,
    turnId,
    completedAt: 1_787_281_300_000,
    terminalStatus,
    terminalError: terminalStatus === 'failed' ? 'PRESENT' : 'NONE',
    outputState,
  };
}

function interruptedObservation(): unknown {
  return {
    thread,
    turnId,
    completedAt: 1_787_281_300_001,
    terminalStatus: 'interrupted',
    terminalError: 'NONE',
    outputState: 'NOT_APPLICABLE',
  };
}

describe('R1 Host projection', () => {
  it('requires an exact seal receipt before granting SUCCEEDED reducer authority', async () => {
    const controller = createController();
    const verified = verifyAndProjectHostOutcome(
      controller.handle,
      controller.settle(settledObservation(), { text: 'secret answer' }),
    );
    expect(verified.status).toBe('SUCCESS_REQUIRES_SEAL');
    if (verified.status !== 'SUCCESS_REQUIRES_SEAL') throw new Error('expected success');

    const seal = vi.fn(async () => ({
      sealedResultId: 'sealed.result.001',
      sealedFingerprint,
      envelope: Object.freeze({ ciphertext: 'opaque' }),
    }));
    const authority = createWorkerResultSealAuthority(seal);
    expect(Object.keys(authority)).toEqual(['read']);
    expect('sealExact' in authority).toBe(false);
    const [terminal, replayed] = await Promise.all([
      sealAndFinalizeWorkerHostSuccess(verified, authority),
      sealAndFinalizeWorkerHostSuccess(verified, authority),
    ]);
    const receipt = terminal.sealedResult;

    expect(seal).toHaveBeenCalledOnce();
    expect(seal).toHaveBeenCalledWith({
      result: { text: 'secret answer' },
      resultFingerprint: verified.candidate.resultFingerprint,
    });
    expect(replayed).toBe(terminal);
    expect(terminal).toMatchObject({
      outcome: 'SUCCEEDED',
      binding: { thread, turnId },
      sealedResult: receipt,
      interruptRequest: null,
    });
    expect(authority.read(receipt)).toEqual({ ciphertext: 'opaque' });
    expect(JSON.stringify(terminal)).not.toContain('secret answer');
    expect(() => authority.read(JSON.parse(JSON.stringify(receipt)))).toThrow(/seal authority/u);

    const foreignSeal = vi.fn(async () => ({
      sealedResultId: 'sealed.result.foreign',
      sealedFingerprint,
      envelope: Object.freeze({ ciphertext: 'foreign' }),
    }));
    const foreignAuthority = createWorkerResultSealAuthority(foreignSeal);
    await expect(sealAndFinalizeWorkerHostSuccess(verified, foreignAuthority)).rejects.toThrow(
      /another seal authority/u,
    );
    expect(foreignSeal).not.toHaveBeenCalled();
  });

  it('binds sealing to the exact verified success and snapshots nested plain data', async () => {
    const controller = createController();
    const verified = verifyAndProjectHostOutcome(
      controller.handle,
      controller.settle(settledObservation(), { text: 'exact answer' }),
    );
    if (verified.status !== 'SUCCESS_REQUIRES_SEAL') throw new Error('expected success');
    const nested = { ciphertext: 'opaque' };
    const seal = vi.fn(async () => ({
      sealedResultId: 'sealed.result.snapshot',
      sealedFingerprint,
      envelope: { payload: nested },
    }));
    const authority = createWorkerResultSealAuthority(seal);
    const forged = Object.freeze({
      ...verified,
      outcome: Object.freeze({ ...verified.outcome, result: { text: 'substituted answer' } }),
    });

    await expect(
      sealAndFinalizeWorkerHostSuccess(forged as typeof verified, authority),
    ).rejects.toThrow(/did not originate/u);
    expect(seal).not.toHaveBeenCalled();

    const terminal = await sealAndFinalizeWorkerHostSuccess(verified, authority);
    nested.ciphertext = 'exact answer';
    const snapshot = authority.read(terminal.sealedResult);
    expect(snapshot).toEqual({ payload: { ciphertext: 'opaque' } });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.payload)).toBe(true);
  });

  it('projects failure and exact USER_CANCEL/TIMEOUT lineage without plaintext', async () => {
    const failedController = createController();
    const failed = verifyAndProjectHostOutcome(
      failedController.handle,
      failedController.settle(settledObservation('failed', 'NOT_APPLICABLE'), null),
    );
    expect(failed).toMatchObject({
      status: 'TERMINAL_READY',
      terminal: { outcome: 'FAILED', errorCode: 'TURN_FAILED', interruptRequest: null },
    });

    for (const [reason, outcome, errorCode] of [
      ['USER_CANCEL', 'CANCELLED', undefined],
      ['TIMEOUT', 'FAILED', 'TURN_TIMEOUT'],
    ] as const) {
      const controller = createController();
      const interrupt = await executeWorkerHostInterrupt(
        createWorkerInterruptHostEffect({
          attemptId: interruptAttempt,
          attempt: interruptSequence,
          binding: bindingForHostTurn(controller.handle),
          reason,
        }),
        controller.handle,
      );
      const verified = verifyAndProjectHostOutcome(
        controller.handle,
        controller.settleInterrupted(interruptedObservation()),
      );
      expect(verified.status).toBe('TERMINAL_READY');
      if (verified.status !== 'TERMINAL_READY') throw new Error('expected terminal');
      expect(interrupt).toMatchObject({
        disposition: 'SENT',
        attemptId: interruptAttempt,
        attempt: interruptSequence,
        request: { reason },
      });
      expect(verified.terminal).toMatchObject({
        outcome,
        ...(errorCode === undefined ? {} : { errorCode }),
      });
    }
  });

  it('projects STARTED, NOT_STARTED, and evidence loss against one exact attempt', async () => {
    const controller = createController();
    expect(
      await executeWorkerHostStart(createWorkerStartHostEffect(startAttempt), async () =>
        Promise.resolve(controller.handle),
      ),
    ).toMatchObject({
      disposition: 'STARTED',
      attemptId: startAttempt,
      binding: { thread, turnId },
    });
    expect(
      await executeWorkerHostStart(createWorkerStartHostEffect(otherAttempt), async () => {
        throw createHostTurnNotStartedError();
      }),
    ).toEqual({
      disposition: 'NOT_STARTED',
      attemptId: otherAttempt,
      reason: 'RUNTIME_START_FAILED',
    });
    const lostAttempt = workerInvocationAttemptId('start.worker.lost');
    expect(
      await executeWorkerHostStart(createWorkerStartHostEffect(lostAttempt), async () => {
        throw createHostTurnStartEvidenceLostError('HOST_SESSION_LOST');
      }),
    ).toEqual({
      disposition: 'EVIDENCE_LOST',
      attemptId: lostAttempt,
      hostReason: 'HOST_SESSION_LOST',
    });
    const fakeAttempt = workerInvocationAttemptId('start.worker.fake');
    await expect(
      executeWorkerHostStart(createWorkerStartHostEffect(fakeAttempt), async () => {
        throw new HostTurnNotStartedError();
      }),
    ).resolves.toEqual({
      disposition: 'EVIDENCE_LOST',
      attemptId: fakeAttempt,
      hostReason: 'HOST_PROTOCOL_ERROR',
    });
    const ambiguousAttempt = workerInvocationAttemptId('start.worker.ambiguous');
    await expect(
      executeWorkerHostStart(createWorkerStartHostEffect(ambiguousAttempt), async () => {
        throw new HostTurnEvidenceLostError('HOST_SESSION_LOST');
      }),
    ).resolves.toEqual({
      disposition: 'EVIDENCE_LOST',
      attemptId: ambiguousAttempt,
      hostReason: 'HOST_PROTOCOL_ERROR',
    });
    const sameEffect = createWorkerStartHostEffect(workerInvocationAttemptId('start.worker.once'));
    const startTurn = vi.fn(async () => controller.handle);
    const [first, replayed] = await Promise.all([
      executeWorkerHostStart(sameEffect, startTurn),
      executeWorkerHostStart(sameEffect, startTurn),
    ]);
    expect(first).toBe(replayed);
    expect(startTurn).toHaveBeenCalledOnce();
    expect(() =>
      executeWorkerHostStart(
        { type: 'START_HOST', attemptId: startAttempt } as never,
        async () => controller.handle,
      ),
    ).toThrow(/Worker START_HOST effect/u);
  });

  it('turns a writer NOT_SENT into a handle-verifiable disposition with request identity', async () => {
    const controller = createController(() => {
      throw new HostInterruptNotSentError();
    });
    const effect = createWorkerInterruptHostEffect({
      attemptId: interruptAttempt,
      attempt: interruptSequence,
      binding: bindingForHostTurn(controller.handle),
      reason: 'USER_CANCEL',
    });
    const projected = await executeWorkerHostInterrupt(effect, controller.handle);
    const replayed = await executeWorkerHostInterrupt(effect, controller.handle);
    expect(replayed).toBe(projected);
    expect(projected).toMatchObject({
      disposition: 'NOT_SENT',
      attemptId: interruptAttempt,
      attempt: interruptSequence,
      request: { reason: 'USER_CANCEL', binding: { thread, turnId } },
    });
    expect(() => executeWorkerHostInterrupt({ ...effect } as never, controller.handle)).toThrow(
      /Worker INTERRUPT_HOST effect/u,
    );
  });

  it('rejects serialized outcomes, foreign handles, and foreign dispositions', async () => {
    const first = createController();
    const second = createController();
    const outcome = first.settle(settledObservation(), { text: 'done' });
    expect(() =>
      verifyAndProjectHostOutcome(first.handle, JSON.parse(JSON.stringify(outcome))),
    ).toThrow(/this Host turn authority/u);
    expect(() => verifyAndProjectHostOutcome(second.handle, outcome)).toThrow(
      /this Host turn authority/u,
    );

    const effect = createWorkerInterruptHostEffect({
      attemptId: interruptAttempt,
      attempt: interruptSequence,
      binding: bindingForHostTurn(first.handle),
      reason: 'USER_CANCEL',
    });
    expect(() => executeWorkerHostInterrupt(effect, second.handle)).toThrow(/another Host handle/u);
  });

  it('rejects structural handles before they can mint projection authority', async () => {
    const fakeHandle = {
      thread,
      turnId,
      outcome: Promise.resolve(null),
      verifyOutcome: (input: unknown) => input,
      verifyInterruptDisposition: (input: unknown) => input,
      interrupt: async () => ({ disposition: 'TERMINAL_ALREADY_OBSERVED', thread, turnId }),
    };
    await expect(
      executeWorkerHostStart(createWorkerStartHostEffect(startAttempt), async () =>
        Promise.resolve(fakeHandle as never),
      ),
    ).resolves.toMatchObject({ disposition: 'EVIDENCE_LOST', hostReason: 'HOST_PROTOCOL_ERROR' });
    expect(() => verifyAndProjectHostOutcome(fakeHandle as never, {})).toThrow(/Host turn handle/u);
    const controller = createController();
    const effect = createWorkerInterruptHostEffect({
      attemptId: interruptAttempt,
      attempt: interruptSequence,
      binding: bindingForHostTurn(controller.handle),
      reason: 'TIMEOUT',
    });
    expect(() => executeWorkerHostInterrupt(effect, fakeHandle as never)).toThrow(
      /Host turn handle/u,
    );
  });
});
