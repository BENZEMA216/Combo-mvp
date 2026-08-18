import {
  HOST_INTERRUPT_TERMINAL_PROTOCOL,
  isHostInterruptedTerminalEvidence,
  type HostInterruptedTerminalEvidence,
} from '@cb/creator-agent-protocol';

import type {
  HostInterruptExpectedBinding,
  HostInterruptReceiptAuthorityPort,
  OpaqueHostInterruptPermit,
  TrustedHostInterruptPort,
  VerifiedHostInterruptReceipt,
} from './sqlite-invocation-journal.js';

export type HostCompositionErrorCode =
  | 'HOST_TURN_NOT_IN_GENERATION'
  | 'HOST_INTERRUPT_EVIDENCE_INVALID'
  | 'HOST_INTERRUPT_BINDING_MISMATCH';

export class HostCompositionError extends Error {
  constructor(
    readonly code: HostCompositionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HostCompositionError';
  }
}

/**
 * Structural stand-in for the app-side `HostTurnHandle`. The composition only needs the
 * `interrupt()` capability; the real `apps/creator-worker` handle is structurally compatible.
 */
export interface HostTurnHandleLike {
  interrupt(): Promise<HostInterruptedTerminalEvidence>;
}

const REGISTRY_KEY_SEPARATOR = '\u0000';

function registryKey(threadId: string, turnId: string): string {
  return `${threadId}${REGISTRY_KEY_SEPARATOR}${turnId}`;
}

/**
 * Process-generation-bound registry of live Host turns.
 *
 * Entries are created by the process that dispatched the turn and die with it: `reset()`
 * advances the generation and drops every binding. A permit recovered from a previous
 * generation (after restart) can therefore never resolve a handle, and the journal honestly
 * converges to `UNCERTAIN` instead of fabricating a cancellation receipt.
 */
export class HostTurnRegistry {
  readonly #entries = new Map<string, HostTurnHandleLike>();
  #generation = 0;

  /** Monotonic generation number; increases on every `reset()`. */
  get generation(): number {
    return this.#generation;
  }

  register(threadId: string, turnId: string, handle: HostTurnHandleLike): void {
    this.#entries.set(registryKey(threadId, turnId), handle);
  }

  unregister(threadId: string, turnId: string): void {
    this.#entries.delete(registryKey(threadId, turnId));
  }

  lookup(threadId: string, turnId: string): HostTurnHandleLike | undefined {
    return this.#entries.get(registryKey(threadId, turnId));
  }

  clear(): void {
    this.#entries.clear();
    this.#generation += 1;
  }
}

/**
 * Composes a real `HostTurnHandle.interrupt()` evidence producer into the journal's trusted
 * interrupt port. The permit carries the exact accepted thread/turn; only a live handle in the
 * current process generation may be interrupted, and it must never dispatch a new turn.
 */
export function createHostInterruptPort(registry: HostTurnRegistry): TrustedHostInterruptPort {
  return Object.freeze({
    async interruptOnce(
      input: Readonly<{ permit: OpaqueHostInterruptPermit }>,
      signal: AbortSignal,
    ): Promise<unknown> {
      signal.throwIfAborted();
      const handle = registry.lookup(input.permit.runtimeThreadId, input.permit.runtimeTurnId);
      if (handle === undefined) {
        throw new HostCompositionError(
          'HOST_TURN_NOT_IN_GENERATION',
          'The accepted Host turn is not alive in this process generation.',
        );
      }
      return handle.interrupt();
    },
  });
}

/**
 * Verifies Host interrupt evidence against the durable expected binding. Only evidence that
 * (a) has the exact frozen shape, (b) binds the exact accepted thread/turn and (c) carries a
 * well-formed terminal digest is accepted. The digest itself is produced by the trusted Host
 * layer under the strict `turn/completed(status=interrupted)` observation rule; it is never
 * recomputed from low-sensitivity evidence because the raw observation stays inside the Host.
 */
export function createHostInterruptReceiptAuthority(): HostInterruptReceiptAuthorityPort {
  return Object.freeze({
    verify(
      input: unknown,
      expected: HostInterruptExpectedBinding,
      _cloudNow: Date,
    ): VerifiedHostInterruptReceipt {
      if (!isHostInterruptedTerminalEvidence(input)) {
        throw new HostCompositionError(
          'HOST_INTERRUPT_EVIDENCE_INVALID',
          'Host interrupt evidence does not match the frozen interrupted-terminal shape.',
        );
      }
      if (input.threadId !== expected.runtimeThreadId || input.turnId !== expected.runtimeTurnId) {
        throw new HostCompositionError(
          'HOST_INTERRUPT_BINDING_MISMATCH',
          'Host interrupt evidence does not bind the accepted thread/turn.',
        );
      }
      return Object.freeze({ hostTerminalDigest: input.hostTerminalDigest });
    },
  });
}

/** Re-exported for callers that want to type the evidence without importing the protocol package. */
export type { HostInterruptedTerminalEvidence };
export { HOST_INTERRUPT_TERMINAL_PROTOCOL };
