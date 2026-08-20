import { z } from 'zod';

import { canonicalSha256 } from './canonical.js';
import { HostRuntimeIdSchema } from './invocation-facts.js';
import {
  Sha256DigestSchema,
  Sha256HexSchema,
  Uint63StringSchema,
  UuidSchema,
} from './primitives.js';

export const WORKER_INTERRUPT_RECEIPT_PROTOCOL = 'combo.worker-interrupt-receipt/1' as const;

export const WorkerCancelReasonSchema = z.enum([
  'CONSUMER_REQUEST',
  'DRAIN_DEADLINE',
  'SECURITY_REVOKE',
  'DEADLINE',
]);
export type WorkerCancelReason = z.infer<typeof WorkerCancelReasonSchema>;

const WorkerInterruptReceiptCommonShape = {
  protocol: z.literal(WORKER_INTERRUPT_RECEIPT_PROTOCOL),
  schemaVersion: z.literal(1),
  installationId: UuidSchema,
  invocationId: UuidSchema,
  conversationId: UuidSchema,
  agentVersionId: UuidSchema,
  agentVersionDigest: Sha256HexSchema,
  snapshotDigest: Sha256HexSchema,
  leaseId: UuidSchema,
  fence: Uint63StringSchema,
  executionCapabilityDigest: Sha256HexSchema,
  cancelCommandId: UuidSchema,
  cancelReason: WorkerCancelReasonSchema,
  interruptNonce: UuidSchema,
} as const;

const WorkerNotExecutedInterruptReceiptShape = {
  ...WorkerInterruptReceiptCommonShape,
  outcome: z.literal('PROVED_NOT_EXECUTED'),
  evidenceAuthority: z.literal('LOCAL_DISPATCH_COUNTER'),
  dispatchAttemptCount: z.literal(0),
  runtimeThreadId: z.null(),
  runtimeTurnId: z.null(),
  dispatchReceiptDigest: z.null(),
  sandboxInstanceId: z.null(),
  sandboxAttestationDigest: z.null(),
  hostTerminalDigest: z.null(),
} as const;

export const WorkerNotExecutedPreparedReceiptSchema = z
  .object({
    ...WorkerNotExecutedInterruptReceiptShape,
    startCommandId: z.null(),
    dispatchNonce: z.null(),
  })
  .strict();

export const WorkerNotExecutedStartingReceiptSchema = z
  .object({
    ...WorkerNotExecutedInterruptReceiptShape,
    startCommandId: UuidSchema,
    dispatchNonce: UuidSchema,
  })
  .strict();

export const WorkerNotExecutedInterruptReceiptSchema = z.union([
  WorkerNotExecutedPreparedReceiptSchema,
  WorkerNotExecutedStartingReceiptSchema,
]);

export const WorkerInterruptedHostReceiptSchema = z
  .object({
    ...WorkerInterruptReceiptCommonShape,
    outcome: z.literal('INTERRUPTED'),
    evidenceAuthority: z.literal('HOST'),
    dispatchAttemptCount: z.literal(1),
    startCommandId: UuidSchema,
    dispatchNonce: UuidSchema,
    runtimeThreadId: HostRuntimeIdSchema,
    runtimeTurnId: HostRuntimeIdSchema,
    dispatchReceiptDigest: Sha256DigestSchema,
    sandboxInstanceId: UuidSchema,
    sandboxAttestationDigest: Sha256DigestSchema,
    hostTerminalDigest: Sha256DigestSchema,
  })
  .strict();

export const WorkerInterruptReceiptSchema = z.union([
  WorkerNotExecutedPreparedReceiptSchema,
  WorkerNotExecutedStartingReceiptSchema,
  WorkerInterruptedHostReceiptSchema,
]);
export type WorkerInterruptReceipt = z.infer<typeof WorkerInterruptReceiptSchema>;

/** Canonical non-secret evidence identity. It is not a Prompt/content HMAC. */
export function workerInterruptReceiptDigest(receipt: WorkerInterruptReceipt): `sha256:${string}` {
  return `sha256:${canonicalSha256(WorkerInterruptReceiptSchema.parse(receipt))}`;
}
