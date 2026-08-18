import { createHash } from 'node:crypto';

import {
  HOST_INTERRUPT_TERMINAL_PROTOCOL,
  canonicalizeJson,
  isHostInterruptedTerminalEvidence,
  type HostInterruptedTerminalEvidence,
} from '@cb/creator-agent-protocol';

import type {
  HostDispatchExpectedBinding,
  HostDispatchReceiptAuthorityPort,
  HostInterruptExpectedBinding,
  HostInterruptReceiptAuthorityPort,
  OpaqueHostDispatchPermit,
  OpaqueHostInterruptPermit,
  TrustedHostDispatchPort,
  TrustedHostInterruptPort,
  VerifiedHostDispatchReceipt,
  VerifiedHostInterruptReceipt,
} from './sqlite-invocation-journal.js';

export type HostCompositionErrorCode =
  | 'HOST_CONVERSATION_NOT_READY'
  | 'HOST_TURN_NOT_IN_GENERATION'
  | 'HOST_INTERRUPT_EVIDENCE_INVALID'
  | 'HOST_INTERRUPT_BINDING_MISMATCH'
  | 'HOST_DISPATCH_RECEIPT_INVALID'
  | 'HOST_DISPATCH_BINDING_MISMATCH';

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
 * Structural stand-in for the app-side `HostTurnHandle`. The composition only needs the turn
 * identity and the `interrupt()` capability; the real `apps/creator-worker` handle is
 * structurally compatible.
 */
export interface HostTurnHandleLike {
  readonly turnId: Promise<string>;
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
  readonly #threads = new Map<string, string>();
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

  /** Binds one ready conversation to its Host thread for this process generation. */
  bindThread(conversationId: string, threadId: string): void {
    this.#threads.set(conversationId, threadId);
  }

  threadIdFor(conversationId: string): string | undefined {
    return this.#threads.get(conversationId);
  }

  clear(): void {
    this.#entries.clear();
    this.#threads.clear();
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

/**
 * Structural stand-in for the app-side `CodexHost`. The composition needs thread creation and
 * turn starting; the real `apps/creator-worker` CodexHost is structurally compatible.
 */
export interface CodexHostLike {
  createThread(): Promise<Readonly<{ id: string }>>;
  startTurn(input: {
    thread: Readonly<{ id: string }>;
    messageId: string;
    text: string;
    timeoutMs: number;
  }): HostTurnHandleLike;
}

/**
 * Composes a real `CodexHost.startTurn()` dispatch into the journal's trusted dispatch port.
 * The conversation must already have a ready Host thread bound in the current process
 * generation; the port starts exactly one turn with the authenticated prompt bytes, registers
 * the live handle under the resolved thread/turn, and returns a low-sensitivity receipt. It
 * never persists or logs the prompt plaintext.
 */
export function createHostDispatchPort(input: {
  registry: HostTurnRegistry;
  host: CodexHostLike;
  turnTimeoutMs?: number;
}): TrustedHostDispatchPort {
  const turnTimeoutMs = input.turnTimeoutMs ?? 120_000;
  return Object.freeze({
    async dispatchOnce(
      dispatchInput: Readonly<{ permit: OpaqueHostDispatchPermit; userMessage: Uint8Array }>,
      signal: AbortSignal,
    ): Promise<unknown> {
      signal.throwIfAborted();
      const threadId = input.registry.threadIdFor(dispatchInput.permit.conversationId);
      if (threadId === undefined) {
        throw new HostCompositionError(
          'HOST_CONVERSATION_NOT_READY',
          'The conversation has no ready Host thread in this process generation.',
        );
      }
      const handle = input.host.startTurn({
        thread: { id: threadId },
        messageId: dispatchInput.permit.startCommandId,
        text: Buffer.from(dispatchInput.userMessage).toString('utf8'),
        timeoutMs: turnTimeoutMs,
      });
      const runtimeTurnId = await handle.turnId;
      signal.throwIfAborted();
      input.registry.register(threadId, runtimeTurnId, handle);
      return Object.freeze({
        token: 'host-receipt',
        runtimeThreadId: threadId,
        runtimeTurnId,
      });
    },
  });
}

/**
 * Verifies Host dispatch receipts against the durable expected binding. The receipt must bind
 * the exact ready thread; the dispatch digest is recomputed over canonical binding bytes. The
 * sandbox attestation digest is delegated to the injected provider (real deployments wire the
 * Isolation Supervisor attestation here; the composition never invents one).
 */
export function createHostDispatchReceiptAuthority(input: {
  sandboxAttestationDigest: (threadId: string, turnId: string) => string;
}): HostDispatchReceiptAuthorityPort {
  return Object.freeze({
    verify(
      rawInput: unknown,
      expected: HostDispatchExpectedBinding,
      _cloudNow: Date,
    ): VerifiedHostDispatchReceipt {
      if (
        !isPlainObject(rawInput) ||
        rawInput.token !== 'host-receipt' ||
        typeof rawInput.runtimeThreadId !== 'string' ||
        typeof rawInput.runtimeTurnId !== 'string'
      ) {
        throw new HostCompositionError(
          'HOST_DISPATCH_RECEIPT_INVALID',
          'Host dispatch receipt does not match the frozen receipt shape.',
        );
      }
      if (rawInput.runtimeThreadId !== expected.runtimeThreadId) {
        throw new HostCompositionError(
          'HOST_DISPATCH_BINDING_MISMATCH',
          'Host dispatch receipt does not bind the ready thread.',
        );
      }
      const dispatchReceiptDigest = `sha256:${createHash('sha256')
        .update(
          canonicalizeJson({
            runtimeThreadId: rawInput.runtimeThreadId,
            runtimeTurnId: rawInput.runtimeTurnId,
          }),
          'utf8',
        )
        .digest('hex')}`;
      return Object.freeze({
        runtimeTurnId: rawInput.runtimeTurnId,
        dispatchReceiptDigest,
        sandboxAttestationDigest: input.sandboxAttestationDigest(
          rawInput.runtimeThreadId,
          rawInput.runtimeTurnId,
        ),
      });
    },
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type { HostInterruptedTerminalEvidence };
export { HOST_INTERRUPT_TERMINAL_PROTOCOL };
