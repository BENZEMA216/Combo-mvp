import {
  HostThreadSchema,
  HostTurnNotStartedError,
  sameHostThread,
  verifyHostTurnHandle,
  verifyHostTurnStartRejection,
  type HostInterruptReason,
  type HostThread,
  type HostTurnEvidenceLostError,
  type HostTurnHandle,
  type HostTurnId,
  type HostTurnOutcome,
  type HostTurnResult,
} from '@cb/creator-agent-protocol/host';

import {
  assertTrustedWorkerInterruptHostEffect,
  assertTrustedWorkerStartHostEffect,
  type WorkerInterruptAttempt,
  type WorkerInterruptHostEffect,
  type WorkerInvocationAttemptId,
  type WorkerStartHostEffect,
} from './effect-authority.js';
import {
  sealExactWorkerResult,
  type WorkerResultSealAuthority,
  type WorkerSealedResultReceipt,
} from './result-seal.js';

declare const workerHostBindingBrand: unique symbol;
declare const workerHostStartDispositionBrand: unique symbol;
declare const workerHostInterruptDispositionBrand: unique symbol;
declare const workerHostSuccessCandidateBrand: unique symbol;
declare const workerHostTerminalBrand: unique symbol;

const trustedBindings = new WeakSet<object>();
const trustedStartDispositions = new WeakSet<object>();
const trustedInterruptDispositions = new WeakSet<object>();
const trustedSuccessCandidates = new WeakSet<object>();
const trustedTerminals = new WeakSet<object>();
const hostBindings = new WeakMap<object, WorkerHostBinding>();
const bindingHandles = new WeakMap<object, HostTurnHandle>();
const trustedVerifiedSuccesses = new WeakMap<
  object,
  Readonly<{ candidate: WorkerHostSuccessCandidate; outcome: HostSucceededOutcome }>
>();
const sealedSuccesses = new WeakMap<
  object,
  Readonly<{
    authority: object;
    task: Promise<Extract<WorkerHostTerminalProjection, { outcome: 'SUCCEEDED' }>>;
  }>
>();
const startEffectTasks = new WeakMap<object, Promise<WorkerHostStartDispositionProjection>>();
const interruptEffectTasks = new WeakMap<
  object,
  Promise<WorkerHostInterruptDispositionProjection>
>();
const interruptEffectHandles = new WeakMap<object, HostTurnHandle>();

type WorkerHostBindingValue = Readonly<{
  thread: HostThread;
  turnId: HostTurnId;
}>;

export type WorkerHostBinding = Readonly<
  WorkerHostBindingValue & {
    readonly [workerHostBindingBrand]: never;
  }
>;

type HostTerminalFingerprint = HostTurnOutcome['terminal']['terminalFingerprint'];
type HostResultFingerprint = NonNullable<HostTurnOutcome['terminal']['resultFingerprint']>;
type HostInterruptRequest = NonNullable<HostTurnOutcome['terminal']['interruptRequest']>;
type HostSucceededOutcome = Extract<HostTurnOutcome, { result: HostTurnResult }>;
type HostNonSucceededOutcome = Extract<HostTurnOutcome, { result: null }>;

export type WorkerHostStartDispositionProjection =
  | Readonly<{
      disposition: 'STARTED';
      attemptId: WorkerInvocationAttemptId;
      binding: WorkerHostBinding;
      readonly [workerHostStartDispositionBrand]: never;
    }>
  | Readonly<{
      disposition: 'NOT_STARTED';
      attemptId: WorkerInvocationAttemptId;
      reason: 'RUNTIME_START_FAILED';
      readonly [workerHostStartDispositionBrand]: never;
    }>
  | Readonly<{
      disposition: 'EVIDENCE_LOST';
      attemptId: WorkerInvocationAttemptId;
      hostReason: HostTurnEvidenceLostError['reason'];
      readonly [workerHostStartDispositionBrand]: never;
    }>;

export type WorkerHostInterruptRequestProjection = Readonly<{
  requestId: HostInterruptRequest['requestId'];
  reason: HostInterruptReason;
  binding: WorkerHostBinding;
}>;

export type WorkerHostInterruptDispositionProjection =
  | Readonly<{
      disposition: 'SENT';
      attemptId: WorkerInvocationAttemptId;
      attempt: WorkerInterruptAttempt;
      request: WorkerHostInterruptRequestProjection;
      readonly [workerHostInterruptDispositionBrand]: never;
    }>
  | Readonly<{
      disposition: 'NOT_SENT';
      attemptId: WorkerInvocationAttemptId;
      attempt: WorkerInterruptAttempt;
      request: WorkerHostInterruptRequestProjection;
      readonly [workerHostInterruptDispositionBrand]: never;
    }>
  | Readonly<{
      disposition: 'TERMINAL_ALREADY_OBSERVED';
      attemptId: WorkerInvocationAttemptId;
      attempt: WorkerInterruptAttempt;
      binding: WorkerHostBinding;
      readonly [workerHostInterruptDispositionBrand]: never;
    }>;

export type WorkerHostSuccessCandidate = Readonly<{
  binding: WorkerHostBinding;
  terminalFingerprint: HostTerminalFingerprint;
  resultFingerprint: HostResultFingerprint;
  readonly [workerHostSuccessCandidateBrand]: never;
}>;

export type WorkerHostTerminalProjection =
  | Readonly<{
      outcome: 'SUCCEEDED';
      binding: WorkerHostBinding;
      terminalFingerprint: HostTerminalFingerprint;
      resultFingerprint: HostResultFingerprint;
      sealedResult: WorkerSealedResultReceipt;
      interruptRequest: null;
      readonly [workerHostTerminalBrand]: never;
    }>
  | Readonly<{
      outcome: 'FAILED';
      binding: WorkerHostBinding;
      terminalFingerprint: HostTerminalFingerprint;
      errorCode: 'TURN_FAILED';
      interruptRequest: null;
      readonly [workerHostTerminalBrand]: never;
    }>
  | Readonly<{
      outcome: 'FAILED';
      binding: WorkerHostBinding;
      terminalFingerprint: HostTerminalFingerprint;
      errorCode: 'TURN_TIMEOUT';
      interruptRequest: WorkerHostInterruptRequestProjection;
      readonly [workerHostTerminalBrand]: never;
    }>
  | Readonly<{
      outcome: 'CANCELLED';
      binding: WorkerHostBinding;
      terminalFingerprint: HostTerminalFingerprint;
      interruptRequest: WorkerHostInterruptRequestProjection;
      readonly [workerHostTerminalBrand]: never;
    }>;

export type VerifiedWorkerHostOutcome =
  | Readonly<{
      status: 'SUCCESS_REQUIRES_SEAL';
      /** Ephemeral plaintext. It must never enter reducer state, logs, or durable writes. */
      outcome: HostSucceededOutcome;
      candidate: WorkerHostSuccessCandidate;
    }>
  | Readonly<{
      status: 'TERMINAL_READY';
      outcome: HostNonSucceededOutcome;
      terminal: Exclude<WorkerHostTerminalProjection, { outcome: 'SUCCEEDED' }>;
    }>;

export function bindingForHostTurn(handle: HostTurnHandle): WorkerHostBinding {
  const trustedHandle = verifyHostTurnHandle(handle);
  const existing = hostBindings.get(trustedHandle);
  if (existing !== undefined) return existing;
  const binding = Object.freeze({
    thread: HostThreadSchema.parse(trustedHandle.thread),
    turnId: trustedHandle.turnId,
  }) as WorkerHostBinding;
  trustedBindings.add(binding);
  hostBindings.set(trustedHandle, binding);
  bindingHandles.set(binding, trustedHandle);
  return binding;
}

export function executeWorkerHostStart(
  effect: WorkerStartHostEffect,
  startTurn: () => Promise<HostTurnHandle>,
): Promise<WorkerHostStartDispositionProjection> {
  assertTrustedWorkerStartHostEffect(effect);
  if (typeof startTurn !== 'function')
    throw new TypeError('Host start executor must be a function.');
  const existing = startEffectTasks.get(effect);
  if (existing !== undefined) return existing;

  const task = (async (): Promise<WorkerHostStartDispositionProjection> => {
    try {
      const handle = await startTurn();
      return markTrustedStartDisposition({
        disposition: 'STARTED',
        attemptId: effect.attemptId,
        binding: bindingForHostTurn(handle),
      });
    } catch (error) {
      try {
        const rejection = verifyHostTurnStartRejection(error);
        if (rejection instanceof HostTurnNotStartedError) {
          return markTrustedStartDisposition({
            disposition: 'NOT_STARTED',
            attemptId: effect.attemptId,
            reason: 'RUNTIME_START_FAILED',
          });
        }
        return markTrustedStartDisposition({
          disposition: 'EVIDENCE_LOST',
          attemptId: effect.attemptId,
          hostReason: rejection.reason,
        });
      } catch {
        return markTrustedStartDisposition({
          disposition: 'EVIDENCE_LOST',
          attemptId: effect.attemptId,
          hostReason: 'HOST_PROTOCOL_ERROR',
        });
      }
    }
  })();
  startEffectTasks.set(effect, task);
  return task;
}

export function sameWorkerHostBinding(
  left: WorkerHostBindingValue,
  right: WorkerHostBindingValue,
): boolean {
  return sameHostThread(left.thread, right.thread) && left.turnId === right.turnId;
}

/**
 * The caller must pass the value obtained from this exact handle's outcome promise. The handle
 * performs the authority check; this function only copies low-sensitive durable facts.
 */
export function verifyAndProjectHostOutcome(
  handle: HostTurnHandle,
  input: unknown,
): VerifiedWorkerHostOutcome {
  const trustedHandle = verifyHostTurnHandle(handle);
  const outcome = trustedHandle.verifyOutcome(input);
  const binding = bindingForHostTurn(trustedHandle);
  assertTerminalBinding(outcome, binding);

  if (outcome.terminal.outcome === 'SUCCEEDED') {
    if (outcome.result === null || outcome.terminal.resultFingerprint === null) {
      throw new TypeError('SUCCEEDED Host outcome must carry one result and its fingerprint.');
    }
    const candidate = Object.freeze({
      binding,
      terminalFingerprint: outcome.terminal.terminalFingerprint,
      resultFingerprint: outcome.terminal.resultFingerprint,
    }) as WorkerHostSuccessCandidate;
    trustedSuccessCandidates.add(candidate);
    const verified = Object.freeze({
      status: 'SUCCESS_REQUIRES_SEAL',
      outcome: outcome as HostSucceededOutcome,
      candidate,
    });
    trustedVerifiedSuccesses.set(verified, {
      candidate,
      outcome: outcome as HostSucceededOutcome,
    });
    return verified;
  }

  let terminal: Exclude<WorkerHostTerminalProjection, { outcome: 'SUCCEEDED' }>;
  if (outcome.terminal.outcome === 'FAILED') {
    if (outcome.terminal.errorCode === 'TURN_TIMEOUT') {
      const interruptRequest = projectRequiredInterruptRequest(
        outcome.terminal.interruptRequest,
        binding,
        'TIMEOUT',
      );
      terminal = markTrustedTerminal({
        outcome: 'FAILED',
        binding,
        terminalFingerprint: outcome.terminal.terminalFingerprint,
        errorCode: 'TURN_TIMEOUT',
        interruptRequest,
      });
    } else {
      if (outcome.terminal.errorCode !== 'TURN_FAILED') {
        throw new TypeError('FAILED Host outcome has an unknown error code.');
      }
      if (outcome.terminal.interruptRequest !== null) {
        throw new TypeError('TURN_FAILED must not carry interrupt lineage.');
      }
      terminal = markTrustedTerminal({
        outcome: 'FAILED',
        binding,
        terminalFingerprint: outcome.terminal.terminalFingerprint,
        errorCode: 'TURN_FAILED',
        interruptRequest: null,
      });
    }
  } else {
    const interruptRequest = projectRequiredInterruptRequest(
      outcome.terminal.interruptRequest,
      binding,
      'USER_CANCEL',
    );
    terminal = markTrustedTerminal({
      outcome: 'CANCELLED',
      binding,
      terminalFingerprint: outcome.terminal.terminalFingerprint,
      interruptRequest,
    });
  }

  return Object.freeze({
    status: 'TERMINAL_READY',
    outcome: outcome as HostNonSucceededOutcome,
    terminal,
  });
}

export async function sealAndFinalizeWorkerHostSuccess<TEnvelope extends object>(
  verified: Extract<VerifiedWorkerHostOutcome, { status: 'SUCCESS_REQUIRES_SEAL' }>,
  authority: WorkerResultSealAuthority<TEnvelope>,
): Promise<Extract<WorkerHostTerminalProjection, { outcome: 'SUCCEEDED' }>> {
  const exact = trustedVerifiedSuccesses.get(verified);
  if (exact === undefined || exact.candidate !== verified.candidate) {
    throw new TypeError('Verified Worker Host success did not originate from this projection.');
  }
  assertTrusted(verified.candidate, trustedSuccessCandidates, 'Worker Host success candidate');
  const existing = sealedSuccesses.get(verified.candidate);
  if (existing !== undefined) {
    if (existing.authority !== authority) {
      throw new TypeError(
        'Verified Worker Host success is already bound to another seal authority.',
      );
    }
    return existing.task;
  }
  const task: Promise<Extract<WorkerHostTerminalProjection, { outcome: 'SUCCEEDED' }>> =
    sealExactWorkerResult(authority, {
      result: exact.outcome.result,
      resultFingerprint: verified.candidate.resultFingerprint,
    }).then((sealedResult) =>
      markTrustedTerminal({
        outcome: 'SUCCEEDED' as const,
        binding: verified.candidate.binding,
        terminalFingerprint: verified.candidate.terminalFingerprint,
        resultFingerprint: verified.candidate.resultFingerprint,
        sealedResult,
        interruptRequest: null,
      }),
    );
  sealedSuccesses.set(verified.candidate, Object.freeze({ authority, task }));
  void task.catch(() => {
    if (sealedSuccesses.get(verified.candidate)?.task === task) {
      sealedSuccesses.delete(verified.candidate);
    }
  });
  return task;
}

/** Calls interrupt and binds its exact disposition to one reducer-issued after-commit effect. */
export function executeWorkerHostInterrupt(
  effect: WorkerInterruptHostEffect,
  handle: HostTurnHandle,
): Promise<WorkerHostInterruptDispositionProjection> {
  assertTrustedWorkerInterruptHostEffect(effect);
  const trustedHandle = verifyHostTurnHandle(handle);
  const binding = bindingForHostTurn(trustedHandle);
  if (bindingHandles.get(effect.binding) !== trustedHandle) {
    throw new TypeError('Worker interrupt effect belongs to another Host handle.');
  }
  assertBinding(effect.binding, binding, 'Worker interrupt effect');
  const existingHandle = interruptEffectHandles.get(effect);
  if (existingHandle !== undefined && existingHandle !== trustedHandle) {
    throw new TypeError('Worker interrupt effect was already bound to another Host handle.');
  }
  interruptEffectHandles.set(effect, trustedHandle);
  const existing = interruptEffectTasks.get(effect);
  if (existing !== undefined) return existing;

  const task = trustedHandle.interrupt(effect.reason).then((input) => {
    const disposition = trustedHandle.verifyInterruptDisposition(input);
    if (disposition.disposition === 'TERMINAL_ALREADY_OBSERVED') {
      assertBinding(
        { thread: disposition.thread, turnId: disposition.turnId },
        binding,
        'Host terminal-observed disposition',
      );
      return markTrustedInterruptDisposition({
        disposition: 'TERMINAL_ALREADY_OBSERVED',
        attemptId: effect.attemptId,
        attempt: effect.attempt,
        binding,
      });
    }

    assertBinding(
      { thread: disposition.thread, turnId: disposition.turnId },
      binding,
      'Host interrupt receipt',
    );
    if (disposition.reason !== effect.reason) {
      throw new TypeError('Host interrupt disposition changed the reducer-issued reason.');
    }
    return markTrustedInterruptDisposition({
      disposition: disposition.disposition,
      attemptId: effect.attemptId,
      attempt: effect.attempt,
      request: Object.freeze({
        requestId: disposition.requestId,
        reason: disposition.reason,
        binding,
      }),
    });
  });
  interruptEffectTasks.set(effect, task);
  return task;
}

/** Package-internal runtime authority checks used by the pure reducer. */
export function assertTrustedWorkerHostBinding(input: unknown): asserts input is WorkerHostBinding {
  assertTrusted(input, trustedBindings, 'Worker Host binding');
}

export function assertTrustedWorkerHostStartDisposition(
  input: unknown,
): asserts input is WorkerHostStartDispositionProjection {
  assertTrusted(input, trustedStartDispositions, 'Worker Host start disposition');
}

export function assertTrustedWorkerHostInterruptDisposition(
  input: unknown,
): asserts input is WorkerHostInterruptDispositionProjection {
  assertTrusted(input, trustedInterruptDispositions, 'Worker Host interrupt disposition');
}

export function assertTrustedWorkerHostTerminal(
  input: unknown,
): asserts input is WorkerHostTerminalProjection {
  assertTrusted(input, trustedTerminals, 'Worker Host terminal');
}

function assertTerminalBinding(outcome: HostTurnOutcome, expected: WorkerHostBinding): void {
  assertBinding(
    { thread: outcome.terminal.thread, turnId: outcome.terminal.turnId },
    expected,
    'Host terminal outcome',
  );
}

function projectRequiredInterruptRequest(
  request: HostTurnOutcome['terminal']['interruptRequest'],
  expected: WorkerHostBinding,
  expectedReason: HostInterruptReason,
): WorkerHostInterruptRequestProjection {
  if (request === null) {
    throw new TypeError(`${expectedReason} Host terminal is missing interrupt lineage.`);
  }
  assertBinding(
    { thread: request.thread, turnId: request.turnId },
    expected,
    'Host terminal interrupt lineage',
  );
  if (request.reason !== expectedReason) {
    throw new TypeError(`Host terminal interrupt reason must be ${expectedReason}.`);
  }
  return Object.freeze({ requestId: request.requestId, reason: request.reason, binding: expected });
}

function assertBinding(
  actual: WorkerHostBindingValue,
  expected: WorkerHostBindingValue,
  label: string,
): void {
  if (!sameWorkerHostBinding(actual, expected)) {
    throw new TypeError(`${label} does not bind the expected Host turn.`);
  }
}

function markTrustedInterruptDisposition(
  input:
    | Readonly<{
        disposition: 'SENT';
        attemptId: WorkerInvocationAttemptId;
        attempt: WorkerInterruptAttempt;
        request: WorkerHostInterruptRequestProjection;
      }>
    | Readonly<{
        disposition: 'NOT_SENT';
        attemptId: WorkerInvocationAttemptId;
        attempt: WorkerInterruptAttempt;
        request: WorkerHostInterruptRequestProjection;
      }>
    | Readonly<{
        disposition: 'TERMINAL_ALREADY_OBSERVED';
        attemptId: WorkerInvocationAttemptId;
        attempt: WorkerInterruptAttempt;
        binding: WorkerHostBinding;
      }>,
): WorkerHostInterruptDispositionProjection {
  const disposition = Object.freeze(input) as WorkerHostInterruptDispositionProjection;
  trustedInterruptDispositions.add(disposition);
  return disposition;
}

function markTrustedStartDisposition(
  input:
    | Readonly<{
        disposition: 'STARTED';
        attemptId: WorkerInvocationAttemptId;
        binding: WorkerHostBinding;
      }>
    | Readonly<{
        disposition: 'NOT_STARTED';
        attemptId: WorkerInvocationAttemptId;
        reason: 'RUNTIME_START_FAILED';
      }>
    | Readonly<{
        disposition: 'EVIDENCE_LOST';
        attemptId: WorkerInvocationAttemptId;
        hostReason: HostTurnEvidenceLostError['reason'];
      }>,
): WorkerHostStartDispositionProjection {
  const disposition = Object.freeze(input) as WorkerHostStartDispositionProjection;
  trustedStartDispositions.add(disposition);
  return disposition;
}

function markTrustedTerminal<T extends object>(
  input: T,
): Readonly<T & { readonly [workerHostTerminalBrand]: never }> {
  const terminal = Object.freeze(input) as Readonly<
    T & { readonly [workerHostTerminalBrand]: never }
  >;
  trustedTerminals.add(terminal);
  return terminal;
}

function assertTrusted(input: unknown, authority: WeakSet<object>, label: string): void {
  if (typeof input !== 'object' || input === null || !authority.has(input)) {
    throw new TypeError(`${label} did not originate from the R1 Host projection authority.`);
  }
}
