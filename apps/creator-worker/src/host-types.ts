import { createHash } from 'node:crypto';

export interface HostThread {
  id: string;
  generation: number;
  workspaceRootsAcknowledged: boolean;
}

export interface HostTurnResult {
  text: string;
}

export interface HostTurnHandle {
  readonly turnId: Promise<string>;
  readonly result: Promise<HostTurnResult>;
  interrupt(): Promise<HostInterruptedTerminalEvidence>;
}

export const HOST_INTERRUPT_TERMINAL_PROTOCOL =
  'combo.codex-app-server-interrupt-terminal/1' as const;

export interface HostInterruptedTerminalObservation {
  readonly threadId: string;
  readonly turnId: string;
  readonly status: 'interrupted';
  readonly error: null;
  readonly completedAt: number;
}

export interface HostInterruptedTerminalEvidence {
  readonly protocol: typeof HOST_INTERRUPT_TERMINAL_PROTOCOL;
  readonly threadId: string;
  readonly turnId: string;
  readonly outcome: 'INTERRUPTED';
  readonly hostTerminalDigest: `sha256:${string}`;
}

const HOST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const INTERRUPTED_TERMINAL_KEYS = ['completedAt', 'error', 'status', 'threadId', 'turnId'] as const;

/**
 * Normalizes one exact app-server terminal observation into low-sensitivity evidence.
 * The digest covers RFC-8785-compatible canonical bytes; fixed ASCII keys are emitted in
 * lexicographic order and JSON number serialization follows the required ECMAScript form.
 */
export function createHostInterruptedTerminalEvidence(
  input: HostInterruptedTerminalObservation,
): HostInterruptedTerminalEvidence {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).sort().join('\u0000') !== INTERRUPTED_TERMINAL_KEYS.join('\u0000') ||
    !HOST_ID_PATTERN.test(input.threadId) ||
    !HOST_ID_PATTERN.test(input.turnId) ||
    input.status !== 'interrupted' ||
    input.error !== null ||
    !Number.isFinite(input.completedAt) ||
    input.completedAt < 0
  ) {
    throw new TypeError('Invalid interrupted Host terminal observation.');
  }
  const canonicalBytes = Buffer.from(
    JSON.stringify({
      completedAt: input.completedAt,
      error: null,
      status: 'interrupted',
      threadId: input.threadId,
      turnId: input.turnId,
    }),
    'utf8',
  );
  return Object.freeze({
    protocol: HOST_INTERRUPT_TERMINAL_PROTOCOL,
    threadId: input.threadId,
    turnId: input.turnId,
    outcome: 'INTERRUPTED',
    hostTerminalDigest: `sha256:${createHash('sha256').update(canonicalBytes).digest('hex')}`,
  });
}

export interface CodexHost {
  start(): Promise<void>;
  stop(): Promise<void>;
  createThread(): Promise<HostThread>;
  startTurn(input: {
    thread: HostThread;
    messageId: string;
    text: string;
    timeoutMs: number;
  }): HostTurnHandle;
}

export type CodexHostErrorCode =
  | 'HOST_NOT_READY'
  | 'HOST_PROTOCOL_ERROR'
  | 'HOST_SESSION_LOST'
  | 'HOST_TIMEOUT'
  | 'HOST_INTERRUPTED'
  | 'HOST_TURN_FAILED'
  | 'HOST_OUTPUT_INVALID';

export class CodexHostError extends Error {
  constructor(
    readonly code: CodexHostErrorCode,
    message: string,
    readonly uncertain = false,
    readonly hostLost = false,
  ) {
    super(message);
    this.name = 'CodexHostError';
  }
}
