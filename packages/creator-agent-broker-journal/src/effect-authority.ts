import type { HostInterruptReason } from '@cb/creator-agent-protocol/host';

import type { WorkerHostBinding } from './host-projection.js';

declare const workerInvocationAttemptIdBrand: unique symbol;
declare const workerInterruptAttemptBrand: unique symbol;
declare const workerStartHostEffectBrand: unique symbol;
declare const workerInterruptHostEffectBrand: unique symbol;

const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const trustedStartHostEffects = new WeakSet<object>();
const trustedInterruptHostEffects = new WeakSet<object>();

export type WorkerInvocationAttemptId = string & {
  readonly [workerInvocationAttemptIdBrand]: never;
};

export type WorkerInterruptAttempt = number & {
  readonly [workerInterruptAttemptBrand]: never;
};

export type WorkerStartHostEffect = Readonly<{
  type: 'START_HOST';
  attemptId: WorkerInvocationAttemptId;
  readonly [workerStartHostEffectBrand]: never;
}>;

export type WorkerInterruptHostEffect = Readonly<{
  type: 'INTERRUPT_HOST';
  attemptId: WorkerInvocationAttemptId;
  attempt: WorkerInterruptAttempt;
  binding: WorkerHostBinding;
  reason: HostInterruptReason;
  readonly [workerInterruptHostEffectBrand]: never;
}>;

export function workerInvocationAttemptId(input: string): WorkerInvocationAttemptId {
  if (!ATTEMPT_ID_PATTERN.test(input)) {
    throw new TypeError('Worker Invocation attempt ID is invalid.');
  }
  return input as WorkerInvocationAttemptId;
}

export function workerInterruptAttempt(input: number): WorkerInterruptAttempt {
  if (!Number.isSafeInteger(input) || input < 1) {
    throw new TypeError('Worker interrupt attempt must be a positive safe integer.');
  }
  return input as WorkerInterruptAttempt;
}

export function createWorkerStartHostEffect(
  attemptId: WorkerInvocationAttemptId,
): WorkerStartHostEffect {
  const effect = Object.freeze({ type: 'START_HOST', attemptId }) as WorkerStartHostEffect;
  trustedStartHostEffects.add(effect);
  return effect;
}

export function createWorkerInterruptHostEffect(input: {
  attemptId: WorkerInvocationAttemptId;
  attempt: WorkerInterruptAttempt;
  binding: WorkerHostBinding;
  reason: HostInterruptReason;
}): WorkerInterruptHostEffect {
  const effect = Object.freeze({ type: 'INTERRUPT_HOST', ...input }) as WorkerInterruptHostEffect;
  trustedInterruptHostEffects.add(effect);
  return effect;
}

export function assertTrustedWorkerStartHostEffect(
  input: unknown,
): asserts input is WorkerStartHostEffect {
  assertTrusted(input, trustedStartHostEffects, 'Worker START_HOST effect');
}

export function assertTrustedWorkerInterruptHostEffect(
  input: unknown,
): asserts input is WorkerInterruptHostEffect {
  assertTrusted(input, trustedInterruptHostEffects, 'Worker INTERRUPT_HOST effect');
}

function assertTrusted(input: unknown, authority: WeakSet<object>, label: string): void {
  if (typeof input !== 'object' || input === null || !authority.has(input)) {
    throw new TypeError(`${label} did not originate from the Worker reducer.`);
  }
}
