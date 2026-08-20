import { createHash } from 'node:crypto';

import { canonicalizeJson } from './canonical.js';

export const HOST_TURN_TERMINAL_PROTOCOL = 'combo.codex-app-server-turn-terminal/1' as const;

export type HostTurnTerminalErrorCode = 'TURN_TIMEOUT' | 'TURN_FAILED';

export type HostTurnTerminalObservation = Readonly<{
  threadId: string;
  turnId: string;
  outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  errorCode: HostTurnTerminalErrorCode | null;
  terminalStatus: 'completed' | 'interrupted' | 'failed';
  terminalError: 'NONE' | 'PRESENT';
  outputState: 'USABLE' | 'UNUSABLE' | 'NOT_APPLICABLE';
  completedAt: number;
}>;

export type HostTurnTerminalEvidence = Readonly<{
  protocol: typeof HOST_TURN_TERMINAL_PROTOCOL;
  threadId: string;
  turnId: string;
  outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  errorCode: HostTurnTerminalErrorCode | null;
  hostTerminalDigest: `sha256:${string}`;
}>;

const HOST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const OBSERVATION_KEYS = [
  'completedAt',
  'errorCode',
  'outcome',
  'outputState',
  'terminalError',
  'terminalStatus',
  'threadId',
  'turnId',
] as const;
const EVIDENCE_KEYS = [
  'errorCode',
  'hostTerminalDigest',
  'outcome',
  'protocol',
  'threadId',
  'turnId',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validObservationSemantics(input: HostTurnTerminalObservation): boolean {
  if (input.outcome === 'SUCCEEDED') {
    return (
      input.errorCode === null &&
      input.terminalStatus === 'completed' &&
      input.terminalError === 'NONE' &&
      input.outputState === 'USABLE'
    );
  }
  if (input.outcome === 'CANCELLED') {
    return (
      input.errorCode === null &&
      input.terminalStatus === 'interrupted' &&
      input.terminalError === 'NONE' &&
      input.outputState === 'NOT_APPLICABLE'
    );
  }
  if (input.errorCode === 'TURN_TIMEOUT') {
    return (
      input.terminalStatus === 'interrupted' &&
      input.terminalError === 'NONE' &&
      input.outputState === 'NOT_APPLICABLE'
    );
  }
  if (input.errorCode !== 'TURN_FAILED') return false;
  if (input.outputState === 'UNUSABLE') {
    return input.terminalStatus === 'completed' && input.terminalError === 'NONE';
  }
  if (input.outputState !== 'NOT_APPLICABLE') return false;
  return (
    input.terminalStatus === 'failed' ||
    (input.terminalStatus === 'interrupted' && input.terminalError === 'NONE') ||
    (input.terminalStatus === 'completed' && input.terminalError === 'PRESENT')
  );
}

export function createHostTurnTerminalEvidence(
  input: HostTurnTerminalObservation,
): HostTurnTerminalEvidence {
  if (
    !isPlainObject(input) ||
    Object.keys(input).sort().join('\u0000') !== OBSERVATION_KEYS.join('\u0000') ||
    !HOST_ID_PATTERN.test(input.threadId) ||
    !HOST_ID_PATTERN.test(input.turnId) ||
    !Number.isFinite(input.completedAt) ||
    input.completedAt < 0 ||
    !validObservationSemantics(input)
  ) {
    throw new TypeError('Invalid Host turn terminal observation.');
  }
  const hostTerminalDigest = `sha256:${createHash('sha256')
    .update(canonicalizeJson(input), 'utf8')
    .digest('hex')}` as const;
  return Object.freeze({
    protocol: HOST_TURN_TERMINAL_PROTOCOL,
    threadId: input.threadId,
    turnId: input.turnId,
    outcome: input.outcome,
    errorCode: input.errorCode,
    hostTerminalDigest,
  });
}

export function isHostTurnTerminalEvidence(input: unknown): input is HostTurnTerminalEvidence {
  if (
    !isPlainObject(input) ||
    Object.keys(input).sort().join('\u0000') !== EVIDENCE_KEYS.join('\u0000') ||
    input.protocol !== HOST_TURN_TERMINAL_PROTOCOL ||
    !HOST_ID_PATTERN.test(String(input.threadId)) ||
    !HOST_ID_PATTERN.test(String(input.turnId)) ||
    typeof input.hostTerminalDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.hostTerminalDigest)
  ) {
    return false;
  }
  if (input.outcome === 'SUCCEEDED' || input.outcome === 'CANCELLED') {
    return input.errorCode === null;
  }
  return (
    input.outcome === 'FAILED' &&
    (input.errorCode === 'TURN_TIMEOUT' || input.errorCode === 'TURN_FAILED')
  );
}
