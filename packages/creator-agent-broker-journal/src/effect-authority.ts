import type { HostInterruptReason } from '@cb/creator-agent-protocol/host';

import type { WorkerHostBinding } from './host-projection.js';

declare const workerInvocationAttemptIdBrand: unique symbol;
declare const workerInterruptAttemptBrand: unique symbol;
declare const workerStartHostEffectBrand: unique symbol;
declare const workerInterruptHostEffectBrand: unique symbol;
declare const workerObserveHostOutcomeEffectBrand: unique symbol;
declare const committedWorkerStartHostEffectBrand: unique symbol;
declare const committedWorkerInterruptHostEffectBrand: unique symbol;
declare const committedWorkerObserveHostOutcomeEffectBrand: unique symbol;

const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const trustedStartHostEffects = new WeakSet<object>();
const trustedInterruptHostEffects = new WeakSet<object>();
const trustedObserveHostOutcomeEffects = new WeakSet<object>();
const committedEffects = new WeakMap<object, CommittedEffectRecord>();
const rawEffectCommits = new WeakMap<object, CommittedEffectRecord>();

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

export type WorkerObserveHostOutcomeEffect = Readonly<{
  type: 'OBSERVE_HOST_OUTCOME';
  binding: WorkerHostBinding;
  readonly [workerObserveHostOutcomeEffectBrand]: never;
}>;

export type WorkerAfterCommitContext = Readonly<{
  invocationId: string;
  revision: number;
  ownerEpoch: number;
}>;

export type CommittedWorkerStartHostEffect = Readonly<{
  type: 'START_HOST';
  commit: WorkerAfterCommitContext;
  readonly [committedWorkerStartHostEffectBrand]: never;
}>;

export type CommittedWorkerInterruptHostEffect = Readonly<{
  type: 'INTERRUPT_HOST';
  commit: WorkerAfterCommitContext;
  readonly [committedWorkerInterruptHostEffectBrand]: never;
}>;

export type CommittedWorkerObserveHostOutcomeEffect = Readonly<{
  type: 'OBSERVE_HOST_OUTCOME';
  commit: WorkerAfterCommitContext;
  readonly [committedWorkerObserveHostOutcomeEffectBrand]: never;
}>;

export type WorkerRawAfterCommitEffect =
  | WorkerStartHostEffect
  | WorkerInterruptHostEffect
  | WorkerObserveHostOutcomeEffect;

export type WorkerCommittedAfterCommitEffect =
  | CommittedWorkerStartHostEffect
  | CommittedWorkerInterruptHostEffect
  | CommittedWorkerObserveHostOutcomeEffect;

type CommittedEffectRecord = Readonly<{
  raw: WorkerRawAfterCommitEffect;
  context: WorkerAfterCommitContext;
  committed: WorkerCommittedAfterCommitEffect;
  assertCurrent: () => void;
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

export function createWorkerObserveHostOutcomeEffect(
  binding: WorkerHostBinding,
): WorkerObserveHostOutcomeEffect {
  const effect = Object.freeze({
    type: 'OBSERVE_HOST_OUTCOME',
    binding,
  }) as WorkerObserveHostOutcomeEffect;
  trustedObserveHostOutcomeEffects.add(effect);
  return effect;
}

/**
 * Package-internal transaction marker. The journal calls this only after the transaction that
 * persisted the reduction has committed. Replaying the exact raw effect under the same durable
 * context returns the same process-local capability; rebinding it to another commit is rejected.
 */
export function commitWorkerAfterCommitEffects(
  rawEffects: readonly WorkerRawAfterCommitEffect[],
  context: WorkerAfterCommitContext,
  assertCurrent: () => void,
): readonly WorkerCommittedAfterCommitEffect[] {
  if (!Array.isArray(rawEffects)) {
    throw new TypeError('Worker after-commit effects must be an array.');
  }
  if (typeof assertCurrent !== 'function') {
    throw new TypeError('Worker after-commit owner fence must be a function.');
  }
  const committedContext = snapshotCommitContext(context);
  const plans = rawEffects.map((raw) => {
    assertTrustedRawEffect(raw);
    const existing = rawEffectCommits.get(raw);
    if (
      existing !== undefined &&
      (!sameCommitContext(existing.context, committedContext) ||
        existing.assertCurrent !== assertCurrent)
    ) {
      throw new TypeError(
        'Worker after-commit effect is already bound to another commit authority.',
      );
    }
    return Object.freeze({ raw, existing });
  });

  const newlyCommitted = new Map<object, CommittedEffectRecord>();
  return Object.freeze(
    plans.map(({ raw, existing }) => {
      if (existing !== undefined) return existing.committed;
      const duplicate = newlyCommitted.get(raw);
      if (duplicate !== undefined) return duplicate.committed;
      const committed = Object.freeze({ type: raw.type, commit: committedContext }) as
        | CommittedWorkerStartHostEffect
        | CommittedWorkerInterruptHostEffect
        | CommittedWorkerObserveHostOutcomeEffect;
      const record = Object.freeze({ raw, context: committedContext, committed, assertCurrent });
      newlyCommitted.set(raw, record);
      rawEffectCommits.set(raw, record);
      committedEffects.set(committed, record);
      return committed;
    }),
  );
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

export function assertTrustedWorkerObserveHostOutcomeEffect(
  input: unknown,
): asserts input is WorkerObserveHostOutcomeEffect {
  assertTrusted(input, trustedObserveHostOutcomeEffects, 'Worker OBSERVE_HOST_OUTCOME effect');
}

export function unwrapCommittedWorkerStartHostEffect(input: unknown): WorkerStartHostEffect {
  return unwrapCommittedEffect(input, 'START_HOST') as WorkerStartHostEffect;
}

export function unwrapCommittedWorkerInterruptHostEffect(
  input: unknown,
): WorkerInterruptHostEffect {
  return unwrapCommittedEffect(input, 'INTERRUPT_HOST') as WorkerInterruptHostEffect;
}

export function unwrapCommittedWorkerObserveHostOutcomeEffect(
  input: unknown,
): WorkerObserveHostOutcomeEffect {
  return unwrapCommittedEffect(input, 'OBSERVE_HOST_OUTCOME') as WorkerObserveHostOutcomeEffect;
}

function assertTrustedRawEffect(input: unknown): asserts input is WorkerRawAfterCommitEffect {
  if (typeof input !== 'object' || input === null || !('type' in input)) {
    throw new TypeError('Worker after-commit effect did not originate from the Worker reducer.');
  }
  switch (input.type) {
    case 'START_HOST':
      assertTrustedWorkerStartHostEffect(input);
      return;
    case 'INTERRUPT_HOST':
      assertTrustedWorkerInterruptHostEffect(input);
      return;
    case 'OBSERVE_HOST_OUTCOME':
      assertTrustedWorkerObserveHostOutcomeEffect(input);
      return;
    default:
      throw new TypeError('Worker after-commit effect has an unknown type.');
  }
}

function unwrapCommittedEffect(
  input: unknown,
  expectedType: WorkerRawAfterCommitEffect['type'],
): WorkerRawAfterCommitEffect {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError(`Committed Worker ${expectedType} effect is required.`);
  }
  const record = committedEffects.get(input);
  if (record === undefined || record.committed !== input || record.raw.type !== expectedType) {
    throw new TypeError(`Committed Worker ${expectedType} effect is required.`);
  }
  record.assertCurrent();
  return record.raw;
}

function snapshotCommitContext(input: WorkerAfterCommitContext): WorkerAfterCommitContext {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('Worker after-commit context is required.');
  }
  const { invocationId, revision, ownerEpoch } = input;
  if (typeof invocationId !== 'string' || invocationId.length < 1 || invocationId.length > 256) {
    throw new TypeError('Worker invocation ID is invalid.');
  }
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError('Worker revision must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(ownerEpoch) || ownerEpoch < 0) {
    throw new TypeError('Worker owner epoch must be a non-negative safe integer.');
  }
  return Object.freeze({ invocationId, revision, ownerEpoch });
}

function sameCommitContext(
  left: WorkerAfterCommitContext,
  right: WorkerAfterCommitContext,
): boolean {
  return (
    left.invocationId === right.invocationId &&
    left.revision === right.revision &&
    left.ownerEpoch === right.ownerEpoch
  );
}

function assertTrusted(input: unknown, authority: WeakSet<object>, label: string): void {
  if (typeof input !== 'object' || input === null || !authority.has(input)) {
    throw new TypeError(`${label} did not originate from the Worker reducer.`);
  }
}
