import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { canonicalizeJson } from '../canonical.js';
import {
  HOST_INTERRUPT_TERMINAL_PROTOCOL,
  createHostInterruptedTerminalEvidence,
  isHostInterruptedTerminalEvidence,
} from '../host-interrupt-terminal.js';

const COMPLETED_AT = 1_752_000_000_123;

function observation(): {
  threadId: string;
  turnId: string;
  status: 'interrupted';
  error: null;
  completedAt: number;
};
function observation(overrides: Partial<Record<string, unknown>>): Record<string, unknown>;
function observation(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    threadId: 'thread-ready-001',
    turnId: 'turn-host-1',
    status: 'interrupted',
    error: null,
    completedAt: COMPLETED_AT,
    ...overrides,
  };
}

describe('Host interrupted-terminal contract', () => {
  it('freezes the protocol identity and produces a digest over exact canonical bytes', () => {
    const evidence = createHostInterruptedTerminalEvidence(observation());
    expect(evidence.protocol).toBe(HOST_INTERRUPT_TERMINAL_PROTOCOL);
    expect(evidence.protocol).toBe('combo.codex-app-server-interrupt-terminal/1');
    expect(evidence.outcome).toBe('INTERRUPTED');
    expect(evidence.threadId).toBe('thread-ready-001');
    expect(evidence.turnId).toBe('turn-host-1');
    // The digest covers the five observation fields as canonical RFC-8785 bytes.
    const canonicalBytes = Buffer.from(
      canonicalizeJson({
        completedAt: COMPLETED_AT,
        error: null,
        status: 'interrupted',
        threadId: 'thread-ready-001',
        turnId: 'turn-host-1',
      }),
      'utf8',
    );
    expect(evidence.hostTerminalDigest).toBe(
      `sha256:${createHash('sha256').update(canonicalBytes).digest('hex')}`,
    );
    expect(evidence.hostTerminalDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    // Same observation in a different property insertion order produces the same digest.
    const reordered = createHostInterruptedTerminalEvidence({
      turnId: 'turn-host-1',
      status: 'interrupted',
      error: null,
      completedAt: COMPLETED_AT,
      threadId: 'thread-ready-001',
    });
    expect(reordered.hostTerminalDigest).toBe(evidence.hostTerminalDigest);
    expect(Object.keys(evidence).sort()).toEqual([
      'hostTerminalDigest',
      'outcome',
      'protocol',
      'threadId',
      'turnId',
    ]);
  });

  it('rejects malformed observations instead of producing evidence', () => {
    for (const candidate of [
      null,
      [],
      'interrupted',
      42,
      observation({ extra: true }),
      { ...observation(), status: 'completed' },
      { ...observation(), error: 'boom' },
      { ...observation(), completedAt: -1 },
      { ...observation(), completedAt: Number.NaN },
      { ...observation(), completedAt: Number.POSITIVE_INFINITY },
      { ...observation(), threadId: '' },
      { ...observation(), threadId: 'a b' },
      { ...observation(), threadId: 'a/b' },
      { ...observation(), threadId: 'x'.repeat(257) },
      { ...observation(), turnId: 'x\u0000y' },
    ]) {
      expect(() => createHostInterruptedTerminalEvidence(candidate as never)).toThrow(
        /Invalid interrupted Host terminal observation\./u,
      );
    }
  });

  it('shape guard accepts only exact evidence with no extra or missing keys', () => {
    const evidence = createHostInterruptedTerminalEvidence(observation());
    expect(isHostInterruptedTerminalEvidence(evidence)).toBe(true);
    for (const candidate of [
      null,
      undefined,
      [],
      42,
      'string',
      { ...evidence, extra: true },
      { ...evidence, protocol: 'combo.other/1' },
      { ...evidence, outcome: 'CANCELLED' },
      { ...evidence, threadId: 'a b' },
      { ...evidence, turnId: '' },
      { ...evidence, hostTerminalDigest: 'deadbeef' },
      { ...evidence, hostTerminalDigest: 'sha256:xyz' },
      { ...evidence, hostTerminalDigest: `sha256:${'0'.repeat(63)}` },
      Object.fromEntries(Object.entries(evidence).filter(([key]) => key !== 'outcome')),
    ]) {
      expect(isHostInterruptedTerminalEvidence(candidate)).toBe(false);
    }
  });

  it('binds the digest to the exact thread/turn identity', () => {
    const base = createHostInterruptedTerminalEvidence(observation());
    const otherTurn = createHostInterruptedTerminalEvidence({
      ...observation(),
      turnId: 'turn-host-2',
    });
    const otherThread = createHostInterruptedTerminalEvidence({
      ...observation(),
      threadId: 'thread-ready-002',
    });
    const laterCompletedAt = createHostInterruptedTerminalEvidence({
      ...observation(),
      completedAt: COMPLETED_AT + 1,
    });
    expect(otherTurn.hostTerminalDigest).not.toBe(base.hostTerminalDigest);
    expect(otherThread.hostTerminalDigest).not.toBe(base.hostTerminalDigest);
    expect(laterCompletedAt.hostTerminalDigest).not.toBe(base.hostTerminalDigest);
    expect(otherTurn.threadId).toBe('thread-ready-001');
    expect(otherTurn.turnId).toBe('turn-host-2');
  });
});
