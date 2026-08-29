import { describe, expect, it } from 'vitest';

import {
  HostStartTurnInputSchema,
  HostThreadSchema,
  HostTurnEvidenceLostError,
  HostTurnNotStartedError,
  sameHostThread,
  verifyHostTurnHandle,
  verifyHostTurnStartRejection,
  type CreatorHost,
  type HostThreadId,
} from '../index.js';
import {
  HOST_INTERRUPT_WRITE_LINEARIZED,
  HostInterruptNotSentError,
  HostMessageIdSchema,
  HostThreadIdSchema,
  HostTurnIdSchema,
  createHostTurnAdapterController,
  createHostTurnNotStartedError,
  createHostTurnStartEvidenceLostError,
  type HostInterruptWriter,
  type HostInterruptWriteRequest,
  type HostTurnAdapterController,
} from '../host-adapter.js';
import { canonicalFingerprint } from '../canonical.js';

const thread = HostThreadSchema.parse({
  id: 'thread.alpha',
  generation: 7,
  workspaceRootsAcknowledged: true,
});
const turnId = HostTurnIdSchema.parse('turn.001');
const messageId = HostMessageIdSchema.parse('message.001');

function settledObservation(overrides: Record<string, unknown> = {}): unknown {
  return {
    thread,
    turnId,
    completedAt: 1_787_281_200_123,
    terminalStatus: 'completed',
    terminalError: 'NONE',
    outputState: 'USABLE',
    ...overrides,
  };
}

function interruptedObservation(overrides: Record<string, unknown> = {}): unknown {
  return {
    thread,
    turnId,
    completedAt: 1_787_281_200_456,
    terminalStatus: 'interrupted',
    terminalError: 'NONE',
    outputState: 'NOT_APPLICABLE',
    ...overrides,
  };
}

function createController(
  writer?: (request: HostInterruptWriteRequest) => typeof HOST_INTERRUPT_WRITE_LINEARIZED,
): Readonly<{
  controller: HostTurnAdapterController;
  writes: HostInterruptWriteRequest[];
}> {
  const writes: HostInterruptWriteRequest[] = [];
  const controller = createHostTurnAdapterController({
    thread,
    turnId,
    writeInterrupt: (request) => {
      writes.push(request);
      return writer?.(request) ?? HOST_INTERRUPT_WRITE_LINEARIZED;
    },
  });
  return { controller, writes };
}

async function expectProtocolLoss(
  action: (controller: HostTurnAdapterController) => void,
): Promise<void> {
  const { controller } = createController();
  const outcomeRejection = expect(controller.handle.outcome).rejects.toMatchObject({
    code: 'HOST_TURN_EVIDENCE_LOST',
    reason: 'HOST_PROTOCOL_ERROR',
  });
  expect(() => action(controller)).toThrow(HostTurnEvidenceLostError);
  await outcomeRejection;
}

describe('minimal canonical fingerprint', () => {
  it('is deterministic and rejects values JSON would erase or invoke', () => {
    expect(canonicalFingerprint('combo.test/1', { z: -0, a: [1e30, true, null] })).toBe(
      'sha256:c05a7279b50daa0ca05dd834b906e3cace74a14140fed959742446904c667743',
    );

    const sparse = Array.from({ length: 2 });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => 'must-not-run',
    });
    for (const value of [undefined, Number.NaN, { value: undefined }, sparse, cyclic, accessor]) {
      expect(() => canonicalFingerprint('combo.test/1', value)).toThrow(TypeError);
    }
    expect(() => canonicalFingerprint('combo.test/1', '\ud800')).toThrow(/lone surrogate/u);
    expect(() => canonicalFingerprint('UPPERCASE', {})).toThrow(/lowercase ASCII/u);
  });

  it('keeps canonical and adapter producer APIs out of the consumer root', async () => {
    const consumerSurface = await import('../index.js');
    expect(consumerSurface).not.toHaveProperty('canonicalFingerprint');
    expect(consumerSurface).not.toHaveProperty('createHostTurnAdapterController');
    expect(consumerSurface).not.toHaveProperty('verifyHostTurnTerminalEvidence');
    expect(consumerSurface).toHaveProperty('HostThreadSchema');
  });
});

describe('generation-bound Host values', () => {
  it('parses a full acknowledged thread and a strict start-turn input', () => {
    const input = HostStartTurnInputSchema.parse({
      thread,
      messageId,
      text: 'Ship the smallest trustworthy slice.',
      timeoutMs: 1_000,
    });
    expect(input.thread).toEqual(thread);
    expect(input.messageId).toBe(messageId);
    expect(Object.isFrozen(input)).toBe(true);

    expect(HostThreadSchema.safeParse({ ...thread, generation: -1 }).success).toBe(false);
    expect(
      HostThreadSchema.safeParse({ ...thread, workspaceRootsAcknowledged: false }).success,
    ).toBe(false);
    expect(HostThreadSchema.safeParse({ ...thread, extra: true }).success).toBe(false);
    expect(HostThreadSchema.safeParse({ ...thread, id: 'bad/thread' }).success).toBe(false);
    expect(HostStartTurnInputSchema.safeParse({ ...input, text: '\ud800' }).success).toBe(false);
  });

  it('uses distinct nominal thread, turn, and message IDs', () => {
    const acceptThreadId = (_value: HostThreadId): void => undefined;
    acceptThreadId(HostThreadIdSchema.parse('thread.beta'));
    // @ts-expect-error a turn ID cannot be substituted for a thread ID
    acceptThreadId(turnId);
    // @ts-expect-error a message ID cannot be substituted for a thread ID
    acceptThreadId(messageId);
    // @ts-expect-error an unparsed string is not a branded thread ID
    acceptThreadId('thread.unparsed');
  });

  it('treats a generation change as a different Host thread', () => {
    const replacement = HostThreadSchema.parse({
      id: thread.id,
      generation: 8,
      workspaceRootsAcknowledged: true,
    });
    expect(sameHostThread(thread, thread)).toBe(true);
    expect(sameHostThread(thread, replacement)).toBe(false);
  });
});

describe('one handle-private atomic outcome', () => {
  it('binds a valid non-empty result to one SUCCEEDED terminal', async () => {
    const { controller } = createController();
    const outcome = controller.settle(settledObservation(), { text: 'done' });
    expect(await controller.handle.outcome).toBe(outcome);
    expect(outcome.terminal.outcome).toBe('SUCCEEDED');
    expect(outcome.result).toEqual({ text: 'done' });
    expect(outcome.terminal.resultFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(outcome.terminal.terminalFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.terminal)).toBe(true);
    expect(Object.isFrozen(outcome.result)).toBe(true);

    const verified = controller.handle.verifyOutcome(outcome);
    expect(verified).not.toBe(outcome);
    expect(verified).toEqual(outcome);
    expect(Object.isFrozen(verified)).toBe(true);
  });

  it.each([
    settledObservation({ outputState: 'UNUSABLE' }),
    settledObservation({
      terminalStatus: 'failed',
      terminalError: 'PRESENT',
      outputState: 'NOT_APPLICABLE',
    }),
  ])('resolves confirmed non-success terminals as FAILED without result text', (observation) => {
    const { controller } = createController();
    const outcome = controller.settle(observation, null);
    expect(outcome.terminal).toMatchObject({ outcome: 'FAILED', errorCode: 'TURN_FAILED' });
    expect(outcome.result).toBeNull();
    expect(controller.handle.verifyOutcome(outcome)).toEqual(outcome);
  });

  it('fails closed on invalid success text and result/terminal contradictions', async () => {
    await expectProtocolLoss((controller) =>
      controller.settle(settledObservation(), { text: '   ' }),
    );
    await expectProtocolLoss((controller) =>
      controller.settle(settledObservation(), { text: '汉'.repeat(7_000) }),
    );
    await expectProtocolLoss((controller) =>
      controller.settle(settledObservation({ outputState: 'UNUSABLE' }), {
        text: 'must not survive',
      }),
    );
    await expectProtocolLoss((controller) =>
      controller.settle(settledObservation({ extra: true }), { text: 'x' }),
    );
  });

  it('fails closed on thread generation and turn binding drift', async () => {
    const replacement = HostThreadSchema.parse({
      id: thread.id,
      generation: 8,
      workspaceRootsAcknowledged: true,
    });
    await expectProtocolLoss((controller) =>
      controller.settle(settledObservation({ thread: replacement }), { text: 'x' }),
    );
    await expectProtocolLoss((controller) =>
      controller.settle(settledObservation({ turnId: HostTurnIdSchema.parse('turn.002') }), {
        text: 'x',
      }),
    );
  });

  it('changes fingerprints when a trusted binding fact or result changes', () => {
    const baseline = createController().controller.settle(settledObservation(), { text: 'one' });
    const changedResult = createController().controller.settle(settledObservation(), {
      text: 'two',
    });
    const nextTurn = HostTurnIdSchema.parse('turn.002');
    const nextController = createHostTurnAdapterController({
      thread,
      turnId: nextTurn,
      writeInterrupt: () => HOST_INTERRUPT_WRITE_LINEARIZED,
    });
    const changedTurn = nextController.settle(settledObservation({ turnId: nextTurn }), {
      text: 'one',
    });
    expect(changedResult.terminal.resultFingerprint).not.toBe(baseline.terminal.resultFingerprint);
    expect(changedResult.terminal.terminalFingerprint).not.toBe(
      baseline.terminal.terminalFingerprint,
    );
    expect(changedTurn.terminal.terminalFingerprint).not.toBe(
      baseline.terminal.terminalFingerprint,
    );
  });

  it('rejects serialized, copied, and cross-handle outcomes', () => {
    const first = createController().controller;
    const second = createController().controller;
    const outcome = first.settle(settledObservation(), { text: 'done' });
    expect(() => first.handle.verifyOutcome(JSON.parse(JSON.stringify(outcome)))).toThrow(
      /this Host turn authority/u,
    );
    expect(() => first.handle.verifyOutcome({ ...outcome })).toThrow(/this Host turn authority/u);
    expect(() => second.handle.verifyOutcome(outcome)).toThrow(/this Host turn authority/u);
    expect(() => Object.assign(outcome.terminal, { outcome: 'FAILED' })).toThrow(TypeError);
  });

  it('latches exactly one terminal outcome for the handle', () => {
    const { controller } = createController();
    controller.settle(settledObservation(), { text: 'first' });
    expect(() =>
      controller.settle(
        settledObservation({ outputState: 'UNUSABLE', completedAt: 1_787_281_200_789 }),
        null,
      ),
    ).toThrow(/already settled/u);
    expect(() => controller.settleInterrupted(interruptedObservation())).toThrow(
      /already settled/u,
    );
  });
});

describe('first-sent interrupt lineage', () => {
  it('verifies dispositions only against the exact handle that issued them', async () => {
    const first = createController().controller;
    const second = createController().controller;
    const disposition = await first.handle.interrupt('USER_CANCEL');

    expect(first.handle.verifyInterruptDisposition(disposition)).toBe(disposition);
    expect(() =>
      first.handle.verifyInterruptDisposition(JSON.parse(JSON.stringify(disposition))),
    ).toThrow(/this Host turn authority/u);
    expect(() => second.handle.verifyInterruptDisposition(disposition)).toThrow(
      /this Host turn authority/u,
    );
  });

  it.each([
    ['USER_CANCEL', 'TIMEOUT', 'CANCELLED', null],
    ['TIMEOUT', 'USER_CANCEL', 'FAILED', 'TURN_TIMEOUT'],
  ] as const)(
    'latches %s before %s and writes exactly once',
    async (firstReason, secondReason, expectedOutcome, expectedErrorCode) => {
      const { controller, writes } = createController();
      const firstReceipt = await controller.handle.interrupt(firstReason);
      const secondReceipt = await controller.handle.interrupt(secondReason);
      expect(firstReceipt.disposition).toBe('SENT');
      expect(secondReceipt).toBe(firstReceipt);
      expect(writes).toHaveLength(1);
      expect(writes[0]?.reason).toBe(firstReason);

      const outcome = controller.settleInterrupted(interruptedObservation());
      expect(outcome.terminal.outcome).toBe(expectedOutcome);
      expect(outcome.terminal.errorCode).toBe(expectedErrorCode);
      expect(controller.handle.verifyOutcome(outcome)).toEqual(outcome);
    },
  );

  it('allows a new reason only after the writer proves the first attempt was not sent', async () => {
    let rejectFirst = true;
    const { controller, writes } = createController(() => {
      if (rejectFirst) {
        rejectFirst = false;
        throw new HostInterruptNotSentError();
      }
      return HOST_INTERRUPT_WRITE_LINEARIZED;
    });
    const notSent = await controller.handle.interrupt('USER_CANCEL');
    expect(notSent).toMatchObject({ disposition: 'NOT_SENT', reason: 'USER_CANCEL' });
    expect(controller.handle.verifyInterruptDisposition(notSent)).toBe(notSent);
    const receipt = await controller.handle.interrupt('TIMEOUT');
    expect(receipt).toMatchObject({ disposition: 'SENT', reason: 'TIMEOUT' });
    expect(writes.map((request) => request.reason)).toEqual(['USER_CANCEL', 'TIMEOUT']);
    expect(controller.settleInterrupted(interruptedObservation()).terminal).toMatchObject({
      outcome: 'FAILED',
      errorCode: 'TURN_TIMEOUT',
    });
  });

  it('captures the exact writer capability when the controller is created', async () => {
    let originalWrites = 0;
    let replacementWrites = 0;
    const config: {
      thread: typeof thread;
      turnId: typeof turnId;
      writeInterrupt: HostInterruptWriter;
    } = {
      thread,
      turnId,
      writeInterrupt: () => {
        originalWrites += 1;
        return HOST_INTERRUPT_WRITE_LINEARIZED;
      },
    };
    const controller = createHostTurnAdapterController(config);
    config.writeInterrupt = () => {
      replacementWrites += 1;
      return HOST_INTERRUPT_WRITE_LINEARIZED;
    };

    await controller.handle.interrupt('USER_CANCEL');
    expect(originalWrites).toBe(1);
    expect(replacementWrites).toBe(0);
  });

  it('returns TERMINAL_ALREADY_OBSERVED without writing when terminal wins first', async () => {
    const { controller, writes } = createController();
    const outcome = controller.settle(settledObservation(), { text: 'final won' });
    expect(await controller.handle.interrupt('USER_CANCEL')).toEqual({
      disposition: 'TERMINAL_ALREADY_OBSERVED',
      thread,
      turnId,
    });
    expect(writes).toHaveLength(0);
    expect(await controller.handle.outcome).toBe(outcome);
  });

  it('allows an exact final terminal to win after an interrupt was sent', async () => {
    const { controller, writes } = createController();
    const receipt = await controller.handle.interrupt('USER_CANCEL');
    const outcome = controller.settle(settledObservation(), { text: 'Host completed first' });
    expect(await controller.handle.interrupt('TIMEOUT')).toBe(receipt);
    expect(writes).toHaveLength(1);
    expect(outcome.terminal.outcome).toBe('SUCCEEDED');
    expect(await controller.handle.outcome).toBe(outcome);
  });

  it('fails closed when an interrupted observation has no sent lineage', async () => {
    await expectProtocolLoss((controller) =>
      controller.settleInterrupted(interruptedObservation()),
    );
  });

  it('fails closed when the writer cannot prove its linearization result', async () => {
    const controller = createHostTurnAdapterController({
      thread,
      turnId,
      writeInterrupt: (() => 'WRONG') as never,
    });
    const outcomeRejection = expect(controller.handle.outcome).rejects.toMatchObject({
      code: 'HOST_TURN_EVIDENCE_LOST',
      reason: 'HOST_PROTOCOL_ERROR',
    });
    await expect(controller.handle.interrupt('TIMEOUT')).rejects.toMatchObject({
      code: 'HOST_TURN_EVIDENCE_LOST',
      reason: 'HOST_PROTOCOL_ERROR',
    });
    await outcomeRejection;
    expect(() => controller.settle(settledObservation(), { text: 'late' })).toThrow(
      HostTurnEvidenceLostError,
    );
  });

  it('fails closed instead of allowing a re-entrant second interrupt write', async () => {
    const controllerCell: { controller?: HostTurnAdapterController } = {};
    let nestedInterrupt!: ReturnType<HostTurnAdapterController['handle']['interrupt']>;
    let writeCount = 0;
    const controller = createHostTurnAdapterController({
      thread,
      turnId,
      writeInterrupt: () => {
        writeCount += 1;
        nestedInterrupt = controllerCell.controller!.handle.interrupt('TIMEOUT');
        void nestedInterrupt.catch(() => undefined);
        return HOST_INTERRUPT_WRITE_LINEARIZED;
      },
    });
    controllerCell.controller = controller;
    const outcomeRejection = expect(controller.handle.outcome).rejects.toMatchObject({
      code: 'HOST_TURN_EVIDENCE_LOST',
      reason: 'HOST_PROTOCOL_ERROR',
    });
    await expect(controller.handle.interrupt('USER_CANCEL')).rejects.toMatchObject({
      code: 'HOST_TURN_EVIDENCE_LOST',
      reason: 'HOST_PROTOCOL_ERROR',
    });
    await expect(nestedInterrupt).rejects.toMatchObject({
      code: 'HOST_TURN_EVIDENCE_LOST',
      reason: 'HOST_PROTOCOL_ERROR',
    });
    await outcomeRejection;
    expect(writeCount).toBe(1);
  });

  it('does not downgrade re-entrant evidence loss to a retryable not-sent error', async () => {
    const controllerCell: { controller?: HostTurnAdapterController } = {};
    let nestedInterrupt!: ReturnType<HostTurnAdapterController['handle']['interrupt']>;
    const controller = createHostTurnAdapterController({
      thread,
      turnId,
      writeInterrupt: () => {
        nestedInterrupt = controllerCell.controller!.handle.interrupt('TIMEOUT');
        void nestedInterrupt.catch(() => undefined);
        throw new HostInterruptNotSentError();
      },
    });
    controllerCell.controller = controller;

    await expect(controller.handle.interrupt('USER_CANCEL')).rejects.toMatchObject({
      code: 'HOST_TURN_EVIDENCE_LOST',
      reason: 'HOST_PROTOCOL_ERROR',
    });
    await expect(nestedInterrupt).rejects.toMatchObject({
      code: 'HOST_TURN_EVIDENCE_LOST',
      reason: 'HOST_PROTOCOL_ERROR',
    });
    await expect(controller.handle.outcome).rejects.toMatchObject({
      code: 'HOST_TURN_EVIDENCE_LOST',
      reason: 'HOST_PROTOCOL_ERROR',
    });
  });
});

describe('CreatorHost structural port and stable rejection classes', () => {
  it('returns a handle only after an exact turn binding exists', async () => {
    const input = HostStartTurnInputSchema.parse({
      thread,
      messageId,
      text: 'hello',
      timeoutMs: 1_000,
    });
    const { controller } = createController();
    const host: CreatorHost = {
      start: async () => undefined,
      stop: async () => undefined,
      createThread: async () => thread,
      startTurn: async () => controller.handle,
    };
    expect(await host.createThread()).toBe(thread);
    expect(verifyHostTurnHandle(await host.startTurn(input))).toBe(controller.handle);
    expect(() => verifyHostTurnHandle({ ...controller.handle })).toThrow(/Host turn handle/u);
  });

  it('provides stable errors for proved-zero and evidence-lost boundaries', async () => {
    const lost = new HostTurnEvidenceLostError('HOST_SESSION_LOST');
    expect(lost).toMatchObject({
      name: 'HostTurnEvidenceLostError',
      code: 'HOST_TURN_EVIDENCE_LOST',
      reason: 'HOST_SESSION_LOST',
    });
    expect(new HostTurnNotStartedError()).toMatchObject({ code: 'HOST_TURN_NOT_STARTED' });
    expect(new HostInterruptNotSentError()).toMatchObject({ code: 'HOST_INTERRUPT_NOT_SENT' });
    expect(() => new HostTurnEvidenceLostError('OTHER' as never)).toThrow();
    expect(() => verifyHostTurnStartRejection(new HostTurnNotStartedError())).toThrow(
      /start rejection/u,
    );
    expect(verifyHostTurnStartRejection(createHostTurnNotStartedError())).toBeInstanceOf(
      HostTurnNotStartedError,
    );
    expect(
      verifyHostTurnStartRejection(createHostTurnStartEvidenceLostError('HOST_SESSION_LOST')),
    ).toMatchObject({ reason: 'HOST_SESSION_LOST' });

    const { controller } = createController();
    const outcomeRejection = expect(controller.handle.outcome).rejects.toBeInstanceOf(
      HostTurnEvidenceLostError,
    );
    controller.markEvidenceLost('HOST_SESSION_LOST');
    await outcomeRejection;
    await expect(controller.handle.interrupt('TIMEOUT')).rejects.toMatchObject({
      code: 'HOST_TURN_EVIDENCE_LOST',
      reason: 'HOST_SESSION_LOST',
    });
  });

  it('keeps a rejected outcome safe before a consumer attaches its handler', async () => {
    const { controller } = createController();
    controller.markEvidenceLost('HOST_SESSION_LOST');
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(controller.handle.outcome).rejects.toMatchObject({
      code: 'HOST_TURN_EVIDENCE_LOST',
      reason: 'HOST_SESSION_LOST',
    });
  });
});
