import { z } from 'zod';

import { canonicalSha256 } from './canonical.js';
import { HostRuntimeIdSchema } from './invocation-facts.js';
import {
  Sha256DigestSchema,
  Sha256HexSchema,
  Uint63StringSchema,
  UuidSchema,
} from './primitives.js';

export const WORKER_CONVERSATION_READY_FACT_PROTOCOL =
  'combo.worker-conversation-ready-fact/1' as const;

/**
 * Durable proof that one exact conversation.open command produced one ready Host conversation.
 * The installation/session/lease/fence fields are the original authority that performed the
 * open. They intentionally survive delivery on a later Broker connection and Lease.
 */
export const WorkerConversationReadyFactObjectSchema = z
  .object({
    protocol: z.literal(WORKER_CONVERSATION_READY_FACT_PROTOCOL),
    schemaVersion: z.literal(1),
    type: z.literal('conversation.ready'),
    sourceEventId: UuidSchema,
    conversationId: UuidSchema,
    openCommandId: UuidSchema,
    deploymentId: UuidSchema,
    agentVersionId: UuidSchema,
    agentVersionDigest: Sha256HexSchema,
    snapshotDigest: Sha256HexSchema,
    installationId: UuidSchema,
    workerSessionId: UuidSchema,
    leaseId: UuidSchema,
    fence: Uint63StringSchema,
    sandboxInstanceId: UuidSchema,
    runtimeThreadId: HostRuntimeIdSchema,
    readyEvidenceDigest: Sha256DigestSchema,
  })
  .strict();

export const WorkerConversationReadyFactSchema =
  WorkerConversationReadyFactObjectSchema.superRefine((fact, context) => {
    if (fact.sourceEventId !== fact.openCommandId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceEventId'],
        message: 'conversation.ready sourceEventId 必须等于 durable openCommandId',
      });
    }
  });
export type WorkerConversationReadyFact = z.infer<typeof WorkerConversationReadyFactSchema>;

/** Stable non-secret ready identity shared by Worker SQLite and PostgreSQL journals. */
export function workerConversationReadyFactDigest(input: WorkerConversationReadyFact): string {
  return canonicalSha256(WorkerConversationReadyFactSchema.parse(input));
}

export function assertWorkerConversationReadyFactDigest(
  input: WorkerConversationReadyFact,
  expectedDigest: string,
): WorkerConversationReadyFact {
  const fact = WorkerConversationReadyFactSchema.parse(input);
  if (Sha256HexSchema.parse(expectedDigest) !== workerConversationReadyFactDigest(fact)) {
    throw new TypeError('Worker Conversation Ready factDigest 与 canonical fact 不匹配');
  }
  return fact;
}

/**
 * Reconnection may replace every outer transport authority field. Only the exact immutable ready
 * fact may occupy the same conversation/open-command fact slot.
 */
export function assertWorkerConversationReadyFactReplay(
  priorInput: WorkerConversationReadyFact,
  candidateInput: WorkerConversationReadyFact,
): WorkerConversationReadyFact {
  const prior = WorkerConversationReadyFactSchema.parse(priorInput);
  const candidate = WorkerConversationReadyFactSchema.parse(candidateInput);
  if (
    prior.conversationId !== candidate.conversationId ||
    prior.openCommandId !== candidate.openCommandId ||
    prior.sourceEventId !== candidate.sourceEventId ||
    workerConversationReadyFactDigest(prior) !== workerConversationReadyFactDigest(candidate)
  ) {
    throw new TypeError(
      'Worker Conversation Ready replay 与 durable sourceEventId/factDigest 冲突',
    );
  }
  return candidate;
}
