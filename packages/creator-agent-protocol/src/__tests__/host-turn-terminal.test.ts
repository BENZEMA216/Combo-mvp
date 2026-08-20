import { describe, expect, it } from 'vitest';

import {
  createHostTurnTerminalEvidence,
  isHostTurnTerminalEvidence,
  type HostTurnTerminalObservation,
} from '../host-turn-terminal.js';

function success(): HostTurnTerminalObservation {
  return {
    threadId: 'thread-1',
    turnId: 'turn-1',
    outcome: 'SUCCEEDED',
    errorCode: null,
    terminalStatus: 'completed',
    terminalError: 'NONE',
    outputState: 'USABLE',
    completedAt: 1_700_000_000_000,
  };
}

describe('Host turn terminal evidence', () => {
  it('creates deterministic low-sensitivity evidence for exact terminal outcomes', () => {
    const first = createHostTurnTerminalEvidence(success());
    const second = createHostTurnTerminalEvidence({ ...success() });
    expect(first).toEqual(second);
    expect(isHostTurnTerminalEvidence(first)).toBe(true);
    expect(first.hostTerminalDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);

    expect(
      createHostTurnTerminalEvidence({
        ...success(),
        outcome: 'FAILED',
        errorCode: 'TURN_FAILED',
        outputState: 'UNUSABLE',
      }),
    ).toMatchObject({ outcome: 'FAILED', errorCode: 'TURN_FAILED' });
    expect(
      createHostTurnTerminalEvidence({
        ...success(),
        outcome: 'FAILED',
        errorCode: 'TURN_TIMEOUT',
        terminalStatus: 'interrupted',
        outputState: 'NOT_APPLICABLE',
      }),
    ).toMatchObject({ outcome: 'FAILED', errorCode: 'TURN_TIMEOUT' });
    expect(
      createHostTurnTerminalEvidence({
        ...success(),
        outcome: 'FAILED',
        errorCode: 'TURN_FAILED',
        terminalStatus: 'failed',
        terminalError: 'PRESENT',
        outputState: 'NOT_APPLICABLE',
      }),
    ).toMatchObject({ outcome: 'FAILED', errorCode: 'TURN_FAILED' });
    expect(
      createHostTurnTerminalEvidence({
        ...success(),
        outcome: 'CANCELLED',
        terminalStatus: 'interrupted',
        outputState: 'NOT_APPLICABLE',
      }),
    ).toMatchObject({ outcome: 'CANCELLED', errorCode: null });
  });

  it('rejects semantic contradictions and malformed evidence', () => {
    for (const candidate of [
      { ...success(), outcome: 'FAILED', errorCode: null },
      { ...success(), outcome: 'SUCCEEDED', errorCode: 'TURN_FAILED' },
      { ...success(), outcome: 'CANCELLED', terminalStatus: 'completed' },
      {
        ...success(),
        outcome: 'FAILED',
        errorCode: 'TURN_FAILED',
        outputState: 'NOT_APPLICABLE',
      },
      {
        ...success(),
        outcome: 'FAILED',
        errorCode: 'TURN_FAILED',
        terminalStatus: 'other',
        outputState: 'NOT_APPLICABLE',
      },
      { ...success(), completedAt: Number.NaN },
      { ...success(), extra: true },
    ]) {
      expect(() => createHostTurnTerminalEvidence(candidate as never)).toThrow(TypeError);
    }
    expect(
      isHostTurnTerminalEvidence({ ...createHostTurnTerminalEvidence(success()), extra: 1 }),
    ).toBe(false);
  });
});
