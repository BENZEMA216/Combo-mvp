import { z } from 'zod';

import { canonicalSha256 } from './canonical.js';
import {
  HmacSha256DigestSchema,
  Sha256DigestSchema,
  Sha256HexSchema,
  Uint63StringSchema,
  UuidSchema,
} from './primitives.js';

export const WORKER_INVOCATION_FACT_PROTOCOL = 'combo.worker-invocation-fact/1' as const;

/** Opaque Codex Host identifiers are query handles, never Prompt/model input. */
export const HostRuntimeIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/u);

const WorkerInvocationFactCommonShape = {
  protocol: z.literal(WORKER_INVOCATION_FACT_PROTOCOL),
  schemaVersion: z.literal(1),
  sourceEventId: UuidSchema,
  invocationId: UuidSchema,
  agentVersionDigest: Sha256HexSchema,
  snapshotDigest: Sha256HexSchema,
  executionCapabilityDigest: Sha256HexSchema,
  /** Original execution authority. It intentionally survives transport re-enveloping. */
  leaseId: UuidSchema,
  fence: Uint63StringSchema,
};

function sourceIdentityIssue(context: z.RefinementCtx): void {
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['sourceEventId'],
    message: 'sourceEventId 必须是该 Invocation phase 的 deterministic durable identity',
  });
}

export const WorkerInvocationPreparedFactObjectSchema = z
  .object({
    ...WorkerInvocationFactCommonShape,
    type: z.literal('invocation.prepared'),
    requestDigest: HmacSha256DigestSchema,
    prepareCommandId: UuidSchema,
  })
  .strict();
export const WorkerInvocationPreparedFactSchema =
  WorkerInvocationPreparedFactObjectSchema.superRefine((fact, context) => {
    if (fact.sourceEventId !== fact.prepareCommandId) sourceIdentityIssue(context);
  });
export type WorkerInvocationPreparedFact = z.infer<typeof WorkerInvocationPreparedFactSchema>;

export const WorkerInvocationStartedFactObjectSchema = z
  .object({
    ...WorkerInvocationFactCommonShape,
    type: z.literal('invocation.started'),
    startCommandId: UuidSchema,
    runtimeThreadId: HostRuntimeIdSchema,
    runtimeTurnId: HostRuntimeIdSchema,
    dispatchReceiptDigest: Sha256DigestSchema,
    sandboxAttestationDigest: Sha256DigestSchema,
  })
  .strict();
export const WorkerInvocationStartedFactSchema =
  WorkerInvocationStartedFactObjectSchema.superRefine((fact, context) => {
    if (fact.sourceEventId !== fact.startCommandId) sourceIdentityIssue(context);
  });
export type WorkerInvocationStartedFact = z.infer<typeof WorkerInvocationStartedFactSchema>;

export const WorkerInvocationSucceededFactObjectSchema = z
  .object({
    ...WorkerInvocationFactCommonShape,
    type: z.literal('invocation.succeeded'),
    runtimeThreadId: HostRuntimeIdSchema,
    runtimeTurnId: HostRuntimeIdSchema,
    startedFactDigest: Sha256HexSchema,
    resultDigest: HmacSha256DigestSchema,
    localResultCipherDigest: Sha256HexSchema,
  })
  .strict();
export const WorkerInvocationSucceededFactSchema =
  WorkerInvocationSucceededFactObjectSchema.superRefine((fact, context) => {
    if (fact.sourceEventId !== fact.invocationId) sourceIdentityIssue(context);
  });
export type WorkerInvocationSucceededFact = z.infer<typeof WorkerInvocationSucceededFactSchema>;

export const WorkerInvocationFailedFactObjectSchema = z
  .object({
    ...WorkerInvocationFactCommonShape,
    type: z.literal('invocation.failed'),
    errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/u),
  })
  .strict();
export const WorkerInvocationFailedFactSchema = WorkerInvocationFailedFactObjectSchema.superRefine(
  (fact, context) => {
    if (fact.sourceEventId !== fact.invocationId) sourceIdentityIssue(context);
  },
);
export type WorkerInvocationFailedFact = z.infer<typeof WorkerInvocationFailedFactSchema>;

export const WorkerInvocationCancelledFactObjectSchema = z
  .object({
    ...WorkerInvocationFactCommonShape,
    type: z.literal('invocation.cancelled'),
    interruptReceiptDigest: Sha256DigestSchema,
  })
  .strict();
export const WorkerInvocationCancelledFactSchema =
  WorkerInvocationCancelledFactObjectSchema.superRefine((fact, context) => {
    if (fact.sourceEventId !== fact.invocationId) sourceIdentityIssue(context);
  });
export type WorkerInvocationCancelledFact = z.infer<typeof WorkerInvocationCancelledFactSchema>;

export const WORKER_INVOCATION_UNCERTAIN_REASONS = [
  'START_DISPATCH_UNKNOWN',
  'HOST_EVIDENCE_LOST',
  'MODEL_ATTEMPT_UNKNOWN',
  'CANCEL_NOT_CONFIRMED',
  'JOURNAL_LOST',
] as const;

export const WorkerInvocationUncertainFactObjectSchema = z
  .object({
    ...WorkerInvocationFactCommonShape,
    type: z.literal('invocation.uncertain'),
    reason: z.enum(WORKER_INVOCATION_UNCERTAIN_REASONS),
  })
  .strict();
export const WorkerInvocationUncertainFactSchema =
  WorkerInvocationUncertainFactObjectSchema.superRefine((fact, context) => {
    if (fact.sourceEventId !== fact.invocationId) sourceIdentityIssue(context);
  });
export type WorkerInvocationUncertainFact = z.infer<typeof WorkerInvocationUncertainFactSchema>;

export const WorkerInvocationFactSchema = z.union([
  WorkerInvocationPreparedFactSchema,
  WorkerInvocationStartedFactSchema,
  WorkerInvocationSucceededFactSchema,
  WorkerInvocationFailedFactSchema,
  WorkerInvocationCancelledFactSchema,
  WorkerInvocationUncertainFactSchema,
]);
export type WorkerInvocationFact = z.infer<typeof WorkerInvocationFactSchema>;

/** Stable non-secret identity shared by Worker SQLite and PostgreSQL journals. */
export function workerInvocationFactDigest(input: WorkerInvocationFact): string {
  return canonicalSha256(WorkerInvocationFactSchema.parse(input));
}

export function assertWorkerInvocationFactDigest(
  input: WorkerInvocationFact,
  expectedDigest: string,
): WorkerInvocationFact {
  const fact = WorkerInvocationFactSchema.parse(input);
  if (Sha256HexSchema.parse(expectedDigest) !== workerInvocationFactDigest(fact)) {
    throw new TypeError('Worker Invocation factDigest 与 canonical fact 不匹配');
  }
  return fact;
}

/**
 * A reconnect may change Broker message/session/sequence and re-encrypt payload bytes, but the
 * durable fact itself is immutable. Consumers use this helper before treating a second frame as
 * a replay of an existing local/Cloud fact slot.
 */
export function assertWorkerInvocationFactReplay(
  priorInput: WorkerInvocationFact,
  candidateInput: WorkerInvocationFact,
): WorkerInvocationFact {
  const prior = WorkerInvocationFactSchema.parse(priorInput);
  const candidate = WorkerInvocationFactSchema.parse(candidateInput);
  if (
    prior.invocationId !== candidate.invocationId ||
    prior.type !== candidate.type ||
    prior.sourceEventId !== candidate.sourceEventId ||
    workerInvocationFactDigest(prior) !== workerInvocationFactDigest(candidate)
  ) {
    throw new TypeError('Worker Invocation replay 与 durable sourceEventId/factDigest 冲突');
  }
  return candidate;
}
