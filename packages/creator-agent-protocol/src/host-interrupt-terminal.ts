import { createHash } from 'node:crypto';

import { canonicalizeJson } from './canonical.js';

/**
 * Frozen Host interrupted-terminal contract.
 *
 * The Creator Worker's Codex Host Adapter only returns cancellation evidence after it has
 * written the interrupt request and then observed the exact same thread/turn reach a strict
 * `turn/completed(status=interrupted, error=null, completedAt)` terminal. That observation is
 * normalized into a low-sensitivity evidence object whose digest is computed over canonical
 * bytes. The raw observation (including `completedAt`) never crosses the Host boundary; the
 * digest is the durable proof.
 */

export const HOST_INTERRUPT_TERMINAL_PROTOCOL =
  'combo.codex-app-server-interrupt-terminal/1' as const;

export const HOST_INTERRUPT_TERMINAL_KEYS = [
  'completedAt',
  'error',
  'status',
  'threadId',
  'turnId',
] as const;

const HOST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when `value` has the exact evidence shape. The digest is not recomputed here; it is
 * produced by the trusted Host layer under the strict observation rule. Verifiers still
 * re-check shape, binding and digest format before accepting it as cancellation proof.
 */
const HOST_INTERRUPT_TERMINAL_EVIDENCE_KEYS = [
  'hostTerminalDigest',
  'outcome',
  'protocol',
  'threadId',
  'turnId',
] as const;

/**
 * True when `value` has the exact evidence shape (no extra, no missing keys). The digest is not
 * recomputed here; it is produced by the trusted Host layer under the strict observation rule.
 * Verifiers still re-check shape, binding and digest format before accepting it as cancellation
 * proof.
 */
export function isHostInterruptedTerminalEvidence(
  value: unknown,
): value is HostInterruptedTerminalEvidence {
  if (!isPlainObject(value)) return false;
  if (
    Object.keys(value).sort().join('\x00') != HOST_INTERRUPT_TERMINAL_EVIDENCE_KEYS.join('\x00')
  ) {
    return false;
  }
  if (value.protocol !== HOST_INTERRUPT_TERMINAL_PROTOCOL) return false;
  if (value.outcome !== 'INTERRUPTED') return false;
  if (typeof value.threadId !== 'string' || !HOST_ID_PATTERN.test(value.threadId)) return false;
  if (typeof value.turnId !== 'string' || !HOST_ID_PATTERN.test(value.turnId)) return false;
  return (
    typeof value.hostTerminalDigest === 'string' &&
    /^sha256:[a-f0-9]{64}$/u.test(value.hostTerminalDigest)
  );
}

/**
 * Normalizes one exact app-server terminal observation into low-sensitivity evidence.
 * The digest covers canonical bytes; fixed ASCII keys are emitted in lexicographic order
 * and JSON number serialization follows the required ECMAScript form.
 */
export function createHostInterruptedTerminalEvidence(
  input: HostInterruptedTerminalObservation,
): HostInterruptedTerminalEvidence {
  if (
    !isPlainObject(input) ||
    Object.keys(input).sort().join('\u0000') !== HOST_INTERRUPT_TERMINAL_KEYS.join('\u0000') ||
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
    canonicalizeJson({
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
