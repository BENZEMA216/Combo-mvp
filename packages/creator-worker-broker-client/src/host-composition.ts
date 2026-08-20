import { createHash } from 'node:crypto';

import {
  HOST_INTERRUPT_TERMINAL_PROTOCOL,
  canonicalizeJson,
  isHostInterruptedTerminalEvidence,
  isHostTurnTerminalEvidence,
  type HostInterruptedTerminalEvidence,
  type HostTurnTerminalEvidence,
} from '@cb/creator-agent-protocol';

import type {
  HostDispatchExpectedBinding,
  HostDispatchReceiptAuthorityPort,
  HostInterruptExpectedBinding,
  HostInterruptReceiptAuthorityPort,
  HostTerminalFailureCode,
  LocalInvocationResultAad,
  LocalInvocationResultCiphertext,
  LocalResultAeadSealerPort,
  OpaqueHostDispatchPermit,
  OpaqueHostInterruptPermit,
  TrustedHostDispatchPort,
  TrustedHostInterruptPort,
  VerifiedHostDispatchReceipt,
  VerifiedHostInterruptReceipt,
} from './sqlite-invocation-journal.js';

export const HOST_DISPATCH_RECEIPT_PROTOCOL = 'combo.host-dispatch-receipt/1' as const;

export type HostCompositionErrorCode =
  | 'HOST_CONVERSATION_NOT_READY'
  | 'HOST_CONVERSATION_BINDING_CONFLICT'
  | 'HOST_THREAD_INVALID'
  | 'HOST_TURN_INVALID'
  | 'HOST_PROMPT_INVALID'
  | 'HOST_TURN_BINDING_CONFLICT'
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

export interface HostThreadLike {
  readonly id: string;
  readonly generation: number;
  readonly workspaceRootsAcknowledged: boolean;
}

export interface HostTurnResultLike {
  readonly text: string;
}

/** Exact structural contract implemented by `apps/creator-worker` without a package cycle. */
export interface HostTurnHandleLike {
  readonly turnId: Promise<string>;
  readonly result: Promise<HostTurnResultLike>;
  readonly terminal: Promise<HostTurnTerminalEvidence>;
  interrupt(): Promise<HostInterruptedTerminalEvidence>;
}

const REGISTRY_KEY_SEPARATOR = '\u0000';
const HOST_RUNTIME_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const HOST_PROMPT_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function registryKey(threadId: string, turnId: string): string {
  return `${threadId}${REGISTRY_KEY_SEPARATOR}${turnId}`;
}

/**
 * Process-generation-bound registry of live Host turns.
 *
 * Entries are created by the process that dispatched the turn and die with it: `clear()`
 * advances the generation and drops every binding. A permit recovered from a previous
 * generation (after restart) can therefore never resolve a handle, and the journal honestly
 * converges to `UNCERTAIN` instead of fabricating a cancellation receipt.
 */
export class HostTurnRegistry {
  readonly #entries = new Map<string, HostTurnBinding>();
  readonly #invocations = new Map<string, HostTurnBinding>();
  readonly #threads = new Map<string, HostThreadLike>();
  #activeHostGeneration: number | undefined;
  #generation = 0;

  /** Monotonic registry generation number; increases on every `clear()`. */
  get generation(): number {
    return this.#generation;
  }

  register(
    input: Readonly<{
      permit: OpaqueHostDispatchPermit;
      thread: HostThreadLike;
      turnId: string;
      handle: HostTurnHandleLike;
    }>,
  ): HostTurnBinding {
    if (!HOST_RUNTIME_ID_PATTERN.test(input.turnId)) {
      throw new HostCompositionError('HOST_TURN_INVALID', 'Host turn ID is malformed.');
    }
    const thread = this.#threads.get(input.permit.conversationId);
    if (
      thread === undefined ||
      !sameHostThread(thread, input.thread) ||
      input.permit.runtimeThreadId !== thread.id
    ) {
      throw new HostCompositionError(
        'HOST_CONVERSATION_BINDING_CONFLICT',
        'The turn does not bind the ready Host thread for this conversation.',
      );
    }
    const binding = Object.freeze({
      invocationId: input.permit.invocationId,
      conversationId: input.permit.conversationId,
      permit: input.permit,
      thread,
      turnId: input.turnId,
      handle: input.handle,
    });
    const key = registryKey(thread.id, input.turnId);
    const byTurn = this.#entries.get(key);
    const byInvocation = this.#invocations.get(input.permit.invocationId);
    if (byTurn !== undefined || byInvocation !== undefined) {
      if (byTurn !== undefined && byTurn === byInvocation && sameTurnBinding(byTurn, binding)) {
        return byTurn;
      }
      throw new HostCompositionError(
        'HOST_TURN_BINDING_CONFLICT',
        'A Host turn or Invocation is already bound in this process generation.',
      );
    }
    this.#entries.set(key, binding);
    this.#invocations.set(input.permit.invocationId, binding);
    return binding;
  }

  unregister(binding: HostTurnBinding): boolean {
    const key = registryKey(binding.thread.id, binding.turnId);
    if (
      this.#entries.get(key) !== binding ||
      this.#invocations.get(binding.invocationId) !== binding
    ) {
      return false;
    }
    this.#entries.delete(key);
    this.#invocations.delete(binding.invocationId);
    return true;
  }

  lookup(threadId: string, turnId: string): HostTurnHandleLike | undefined {
    return this.#entries.get(registryKey(threadId, turnId))?.handle;
  }

  bindingForInvocation(invocationId: string): HostTurnBinding | undefined {
    return this.#invocations.get(invocationId);
  }

  /** Resolves a replayed durable start command only inside the current Host generation. */
  bindingForStartCommand(startCommandId: string): HostTurnBinding | undefined {
    for (const binding of this.#invocations.values()) {
      if (binding.permit.startCommandId === startCommandId) return binding;
    }
    return undefined;
  }

  /** Binds one ready conversation to its Host thread for this process generation. */
  bindThread(conversationId: string, input: HostThreadLike): HostThreadLike {
    const thread = freezeHostThread(input);
    if (!thread.workspaceRootsAcknowledged) {
      throw new HostCompositionError(
        'HOST_THREAD_INVALID',
        'VNext requires an acknowledged isolated workspace root.',
      );
    }
    if (
      this.#activeHostGeneration !== undefined &&
      this.#activeHostGeneration !== thread.generation
    ) {
      throw new HostCompositionError(
        'HOST_CONVERSATION_BINDING_CONFLICT',
        'A different Host generation requires clearing the process registry first.',
      );
    }
    const existing = this.#threads.get(conversationId);
    if (existing !== undefined) {
      if (sameHostThread(existing, thread)) return existing;
      throw new HostCompositionError(
        'HOST_CONVERSATION_BINDING_CONFLICT',
        'The conversation is already bound to a different Host thread.',
      );
    }
    for (const [boundConversationId, boundThread] of this.#threads) {
      if (
        boundConversationId !== conversationId &&
        boundThread.id === thread.id &&
        boundThread.generation === thread.generation
      ) {
        throw new HostCompositionError(
          'HOST_CONVERSATION_BINDING_CONFLICT',
          'The Host thread is already bound to another conversation.',
        );
      }
    }
    this.#activeHostGeneration = thread.generation;
    this.#threads.set(conversationId, thread);
    return thread;
  }

  threadFor(conversationId: string): HostThreadLike | undefined {
    return this.#threads.get(conversationId);
  }

  /**
   * Rolls back a provisioned thread only while no turn has crossed the Host boundary. Identity
   * matching prevents a failed open attempt from deleting a newer binding.
   */
  unbindThread(conversationId: string, expectedThread: HostThreadLike): boolean {
    const current = this.#threads.get(conversationId);
    if (current === undefined || !sameHostThread(current, expectedThread)) return false;
    for (const binding of this.#invocations.values()) {
      if (binding.conversationId === conversationId) return false;
    }
    this.#threads.delete(conversationId);
    if (this.#threads.size === 0) this.#activeHostGeneration = undefined;
    return true;
  }

  threadIdFor(conversationId: string): string | undefined {
    return this.#threads.get(conversationId)?.id;
  }

  clear(): void {
    this.#entries.clear();
    this.#invocations.clear();
    this.#threads.clear();
    this.#activeHostGeneration = undefined;
    this.#generation += 1;
  }
}

export type HostTurnBinding = Readonly<{
  invocationId: string;
  conversationId: string;
  permit: OpaqueHostDispatchPermit;
  thread: HostThreadLike;
  turnId: string;
  handle: HostTurnHandleLike;
}>;

export type HostTerminalObservation =
  | Readonly<{
      outcome: 'SUCCEEDED';
      binding: HostTurnBinding;
      result: HostTurnResultLike;
    }>
  | Readonly<{
      outcome: 'FAILED';
      binding: HostTurnBinding;
      errorCode: HostTerminalFailureCode;
    }>
  | Readonly<{
      outcome: 'UNCERTAIN';
      binding?: HostTurnBinding;
      reason: 'HOST_EVIDENCE_LOST';
    }>
  | Readonly<{
      outcome: 'CANCELLED';
      binding: HostTurnBinding;
      hostTerminalDigest: string;
    }>;

/**
 * Observes an already-dispatched Host turn without mutating durable state. Stable outcomes require
 * exact terminal evidence from the Host adapter; a rejected/misbound evidence promise is
 * UNCERTAIN. The registry entry is retained until the caller durably commits the observation.
 */
export async function observeHostTerminal(
  registry: HostTurnRegistry,
  invocationId: string,
): Promise<HostTerminalObservation> {
  const binding = registry.bindingForInvocation(invocationId);
  if (binding === undefined) {
    return Object.freeze({ outcome: 'UNCERTAIN', reason: 'HOST_EVIDENCE_LOST' });
  }
  try {
    const terminal = await binding.handle.terminal;
    if (
      !isHostTurnTerminalEvidence(terminal) ||
      terminal.threadId !== binding.thread.id ||
      terminal.turnId !== binding.turnId
    ) {
      return Object.freeze({ outcome: 'UNCERTAIN', binding, reason: 'HOST_EVIDENCE_LOST' });
    }
    if (terminal.outcome === 'FAILED' && terminal.errorCode !== null) {
      return Object.freeze({ outcome: 'FAILED', binding, errorCode: terminal.errorCode });
    }
    if (terminal.outcome === 'CANCELLED') {
      return Object.freeze({
        outcome: 'CANCELLED',
        binding,
        hostTerminalDigest: terminal.hostTerminalDigest,
      });
    }
    const result = await binding.handle.result;
    if (
      !isPlainObject(result) ||
      Object.keys(result).length !== 1 ||
      typeof result.text !== 'string' ||
      result.text.trim().length === 0
    ) {
      return Object.freeze({ outcome: 'UNCERTAIN', binding, reason: 'HOST_EVIDENCE_LOST' });
    }
    return Object.freeze({
      outcome: 'SUCCEEDED',
      binding,
      result: Object.freeze({ text: result.text }),
    });
  } catch {
    return Object.freeze({ outcome: 'UNCERTAIN', binding, reason: 'HOST_EVIDENCE_LOST' });
  }
}

/** Seals a successful Host result with exact Invocation AAD and zeroes the transient byte copy. */
export function sealHostTerminalResult(
  observation: Extract<HostTerminalObservation, { outcome: 'SUCCEEDED' }>,
  sealer: LocalResultAeadSealerPort,
): LocalInvocationResultCiphertext {
  const plaintext = Buffer.from(observation.result.text, 'utf8');
  try {
    return sealer.seal(plaintext, {
      schemaVersion: 1,
      installationId: observation.binding.permit.installationId,
      invocationId: observation.binding.permit.invocationId,
      conversationId: observation.binding.permit.conversationId,
      agentVersionDigest: observation.binding.permit.agentVersionDigest,
      role: 'ASSISTANT',
    } satisfies LocalInvocationResultAad);
  } finally {
    plaintext.fill(0);
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
      const binding = registry.bindingForInvocation(input.permit.invocationId);
      if (
        binding === undefined ||
        binding.conversationId !== input.permit.conversationId ||
        binding.thread.id !== input.permit.runtimeThreadId ||
        binding.turnId !== input.permit.runtimeTurnId
      ) {
        throw new HostCompositionError(
          'HOST_TURN_NOT_IN_GENERATION',
          'The accepted Host turn is not alive in this process generation.',
        );
      }
      return binding.handle.interrupt();
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
  createThread(): Promise<HostThreadLike>;
  startTurn(input: {
    thread: HostThreadLike;
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
      const thread = input.registry.threadFor(dispatchInput.permit.conversationId);
      if (
        thread === undefined ||
        thread.id !== dispatchInput.permit.runtimeThreadId ||
        !thread.workspaceRootsAcknowledged
      ) {
        throw new HostCompositionError(
          'HOST_CONVERSATION_NOT_READY',
          'The conversation has no ready Host thread in this process generation.',
        );
      }
      let text: string;
      try {
        text = HOST_PROMPT_DECODER.decode(dispatchInput.userMessage);
      } catch {
        throw new HostCompositionError(
          'HOST_PROMPT_INVALID',
          'The authenticated Host prompt is not strict UTF-8.',
        );
      }
      const handle = input.host.startTurn({
        thread,
        messageId: dispatchInput.permit.startCommandId,
        text,
        timeoutMs: turnTimeoutMs,
      });
      void handle.result.catch(() => undefined);
      void handle.terminal.catch(() => undefined);
      const runtimeTurnId = await handle.turnId;
      const binding = input.registry.register({
        permit: dispatchInput.permit,
        thread,
        turnId: runtimeTurnId,
        handle,
      });
      return Object.freeze({
        protocol: HOST_DISPATCH_RECEIPT_PROTOCOL,
        schemaVersion: 1,
        installationId: dispatchInput.permit.installationId,
        deploymentId: dispatchInput.permit.deploymentId,
        leaseId: dispatchInput.permit.leaseId,
        workerSessionId: dispatchInput.permit.workerSessionId,
        fence: dispatchInput.permit.fence,
        invocationId: dispatchInput.permit.invocationId,
        conversationId: dispatchInput.permit.conversationId,
        startCommandId: dispatchInput.permit.startCommandId,
        dispatchNonce: dispatchInput.permit.dispatchNonce,
        agentVersionId: dispatchInput.permit.agentVersionId,
        agentVersionDigest: dispatchInput.permit.agentVersionDigest,
        snapshotDigest: dispatchInput.permit.snapshotDigest,
        requestDigest: dispatchInput.permit.requestDigest,
        executionCapabilityDigest: dispatchInput.permit.executionCapabilityDigest,
        deadlineAt: dispatchInput.permit.deadlineAt,
        sandboxInstanceId: dispatchInput.permit.sandboxInstanceId,
        runtimeThreadId: binding.thread.id,
        runtimeTurnId,
        hostGeneration: binding.thread.generation,
        workspaceRootsAcknowledged: binding.thread.workspaceRootsAcknowledged,
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
  registry: HostTurnRegistry;
  sandboxAttestationDigest: (
    input: Readonly<{
      sandboxInstanceId: string;
      runtimeThreadId: string;
      runtimeTurnId: string;
      hostGeneration: number;
    }>,
  ) => string;
}): HostDispatchReceiptAuthorityPort {
  return Object.freeze({
    verify(
      rawInput: unknown,
      expected: HostDispatchExpectedBinding,
      _cloudNow: Date,
    ): VerifiedHostDispatchReceipt {
      if (!isHostDispatchReceipt(rawInput)) {
        throw new HostCompositionError(
          'HOST_DISPATCH_RECEIPT_INVALID',
          'Host dispatch receipt does not match the frozen receipt shape.',
        );
      }
      const binding = input.registry.bindingForInvocation(expected.invocationId);
      if (
        !hostDispatchReceiptMatchesExpected(rawInput, expected) ||
        binding === undefined ||
        !hostDispatchPermitMatchesReceipt(binding.permit, rawInput) ||
        binding.conversationId !== expected.conversationId ||
        binding.turnId !== rawInput.runtimeTurnId ||
        binding.thread.id !== rawInput.runtimeThreadId ||
        binding.thread.generation !== rawInput.hostGeneration ||
        binding.thread.workspaceRootsAcknowledged !== rawInput.workspaceRootsAcknowledged
      ) {
        throw new HostCompositionError(
          'HOST_DISPATCH_BINDING_MISMATCH',
          'Host dispatch receipt does not bind the ready thread.',
        );
      }
      const sandboxAttestationDigest = input.sandboxAttestationDigest({
        sandboxInstanceId: rawInput.sandboxInstanceId,
        runtimeThreadId: rawInput.runtimeThreadId,
        runtimeTurnId: rawInput.runtimeTurnId,
        hostGeneration: rawInput.hostGeneration,
      });
      const dispatchReceiptDigest = `sha256:${createHash('sha256')
        .update(canonicalizeJson({ receipt: rawInput, sandboxAttestationDigest }), 'utf8')
        .digest('hex')}`;
      return Object.freeze({
        runtimeTurnId: rawInput.runtimeTurnId,
        dispatchReceiptDigest,
        sandboxAttestationDigest,
      });
    },
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const HOST_THREAD_KEYS = ['generation', 'id', 'workspaceRootsAcknowledged'] as const;

function freezeHostThread(input: HostThreadLike): HostThreadLike {
  if (
    !isPlainObject(input) ||
    Object.keys(input).sort().join('\u0000') !== [...HOST_THREAD_KEYS].sort().join('\u0000') ||
    typeof input.id !== 'string' ||
    !HOST_RUNTIME_ID_PATTERN.test(input.id) ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 0 ||
    typeof input.workspaceRootsAcknowledged !== 'boolean'
  ) {
    throw new HostCompositionError('HOST_THREAD_INVALID', 'Host thread binding is malformed.');
  }
  return Object.freeze({
    id: input.id,
    generation: input.generation,
    workspaceRootsAcknowledged: input.workspaceRootsAcknowledged,
  });
}

function sameHostThread(left: HostThreadLike, right: HostThreadLike): boolean {
  return (
    left.id === right.id &&
    left.generation === right.generation &&
    left.workspaceRootsAcknowledged === right.workspaceRootsAcknowledged
  );
}

function sameTurnBinding(left: HostTurnBinding, right: HostTurnBinding): boolean {
  return (
    left.invocationId === right.invocationId &&
    left.conversationId === right.conversationId &&
    left.turnId === right.turnId &&
    left.handle === right.handle &&
    canonicalizeJson(left.permit) === canonicalizeJson(right.permit) &&
    sameHostThread(left.thread, right.thread)
  );
}

const HOST_DISPATCH_RECEIPT_KEYS = [
  'protocol',
  'schemaVersion',
  'installationId',
  'deploymentId',
  'leaseId',
  'workerSessionId',
  'fence',
  'invocationId',
  'conversationId',
  'startCommandId',
  'dispatchNonce',
  'agentVersionId',
  'agentVersionDigest',
  'snapshotDigest',
  'requestDigest',
  'executionCapabilityDigest',
  'deadlineAt',
  'sandboxInstanceId',
  'runtimeThreadId',
  'runtimeTurnId',
  'hostGeneration',
  'workspaceRootsAcknowledged',
] as const;

type HostDispatchReceipt = Readonly<{
  protocol: typeof HOST_DISPATCH_RECEIPT_PROTOCOL;
  schemaVersion: 1;
  installationId: string;
  deploymentId: string;
  leaseId: string;
  workerSessionId: string;
  fence: string;
  invocationId: string;
  conversationId: string;
  startCommandId: string;
  dispatchNonce: string;
  agentVersionId: string;
  agentVersionDigest: string;
  snapshotDigest: string;
  requestDigest: string;
  executionCapabilityDigest: string;
  deadlineAt: string;
  sandboxInstanceId: string;
  runtimeThreadId: string;
  runtimeTurnId: string;
  hostGeneration: number;
  workspaceRootsAcknowledged: true;
}>;

function isHostDispatchReceipt(input: unknown): input is HostDispatchReceipt {
  if (
    !isPlainObject(input) ||
    Object.keys(input).sort().join('\u0000') !==
      [...HOST_DISPATCH_RECEIPT_KEYS].sort().join('\u0000') ||
    input.protocol !== HOST_DISPATCH_RECEIPT_PROTOCOL ||
    input.schemaVersion !== 1 ||
    !Number.isSafeInteger(input.hostGeneration) ||
    Number(input.hostGeneration) < 0 ||
    input.workspaceRootsAcknowledged !== true
  ) {
    return false;
  }
  return HOST_DISPATCH_RECEIPT_KEYS.every((key) => {
    if (
      key === 'protocol' ||
      key === 'schemaVersion' ||
      key === 'hostGeneration' ||
      key === 'workspaceRootsAcknowledged'
    ) {
      return true;
    }
    return typeof input[key] === 'string' && input[key].length > 0;
  });
}

function hostDispatchReceiptMatchesExpected(
  receipt: HostDispatchReceipt,
  expected: HostDispatchExpectedBinding,
): boolean {
  return (
    receipt.installationId === expected.installationId &&
    receipt.deploymentId === expected.deploymentId &&
    receipt.leaseId === expected.leaseId &&
    receipt.workerSessionId === expected.workerSessionId &&
    receipt.fence === expected.fence &&
    receipt.invocationId === expected.invocationId &&
    receipt.conversationId === expected.conversationId &&
    receipt.startCommandId === expected.startCommandId &&
    receipt.dispatchNonce === expected.dispatchNonce &&
    receipt.agentVersionId === expected.agentVersionId &&
    receipt.agentVersionDigest === expected.agentVersionDigest &&
    receipt.snapshotDigest === expected.snapshotDigest &&
    receipt.requestDigest === expected.requestDigest &&
    receipt.executionCapabilityDigest === expected.executionCapabilityDigest &&
    receipt.deadlineAt === expected.deadlineAt &&
    receipt.sandboxInstanceId === expected.sandboxInstanceId &&
    receipt.runtimeThreadId === expected.runtimeThreadId
  );
}

function hostDispatchPermitMatchesReceipt(
  permit: OpaqueHostDispatchPermit,
  receipt: HostDispatchReceipt,
): boolean {
  return (
    canonicalizeJson(permit) ===
    canonicalizeJson({
      installationId: receipt.installationId,
      deploymentId: receipt.deploymentId,
      leaseId: receipt.leaseId,
      workerSessionId: receipt.workerSessionId,
      fence: receipt.fence,
      invocationId: receipt.invocationId,
      conversationId: receipt.conversationId,
      startCommandId: receipt.startCommandId,
      dispatchNonce: receipt.dispatchNonce,
      agentVersionId: receipt.agentVersionId,
      agentVersionDigest: receipt.agentVersionDigest,
      snapshotDigest: receipt.snapshotDigest,
      requestDigest: receipt.requestDigest,
      executionCapabilityDigest: receipt.executionCapabilityDigest,
      deadlineAt: receipt.deadlineAt,
      sandboxInstanceId: receipt.sandboxInstanceId,
      runtimeThreadId: receipt.runtimeThreadId,
    })
  );
}

export type { HostInterruptedTerminalEvidence };
export { HOST_INTERRUPT_TERMINAL_PROTOCOL };
