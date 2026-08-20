import { z } from 'zod';
import { canonicalSha256 } from './canonical.js';
import {
  HmacSha256DigestSchema,
  IsoDateTimeSchema,
  Sha256HexSchema,
  Uint63StringSchema,
  UuidSchema,
  compareUint63,
} from './primitives.js';
import { VnextErrorCodeSchema } from './invocation.js';

export const CONSUMER_EVENT_OUTBOX_PROTOCOL = 'combo.consumer-event-outbox/1' as const;
export const CONSUMER_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

const ConsumerTerminalEventCommonShape = {
  protocol: z.literal(CONSUMER_EVENT_OUTBOX_PROTOCOL),
  schemaVersion: z.literal(1),
  type: z.literal('invocation.terminal'),
  conversationId: UuidSchema,
  invocationId: UuidSchema,
  occurredAt: IsoDateTimeSchema,
} as const;

/**
 * 这里故意使用可生成 oneOf 的 discriminated union，而不是 superRefine。
 * terminalState 与 message/digest/error 的关系因此同时存在于 runtime、JSON Schema 与 OpenAPI。
 */
export const ConsumerTerminalEventPayloadSchema = z.discriminatedUnion('terminalState', [
  z
    .object({
      ...ConsumerTerminalEventCommonShape,
      terminalState: z.literal('SUCCEEDED'),
      assistantMessageId: UuidSchema,
      resultDigest: HmacSha256DigestSchema,
      errorCode: z.null(),
    })
    .strict(),
  z
    .object({
      ...ConsumerTerminalEventCommonShape,
      terminalState: z.literal('FAILED'),
      assistantMessageId: z.null(),
      resultDigest: z.null(),
      errorCode: VnextErrorCodeSchema,
    })
    .strict(),
  z
    .object({
      ...ConsumerTerminalEventCommonShape,
      terminalState: z.literal('CANCELLED'),
      assistantMessageId: z.null(),
      resultDigest: z.null(),
      errorCode: z.null(),
    })
    .strict(),
  z
    .object({
      ...ConsumerTerminalEventCommonShape,
      terminalState: z.literal('UNCERTAIN'),
      assistantMessageId: z.null(),
      resultDigest: z.null(),
      errorCode: z.literal('EXECUTION_STATE_UNKNOWN'),
    })
    .strict(),
  z
    .object({
      ...ConsumerTerminalEventCommonShape,
      terminalState: z.literal('EXPIRED'),
      assistantMessageId: z.null(),
      resultDigest: z.null(),
      errorCode: z.literal('INVOCATION_EXPIRED'),
    })
    .strict(),
]);
export type ConsumerTerminalEventPayload = z.infer<typeof ConsumerTerminalEventPayloadSchema>;

export const ConsumerEventOutboxStateSchema = z.enum(['PENDING', 'PUBLISHED']);
export type ConsumerEventOutboxState = z.infer<typeof ConsumerEventOutboxStateSchema>;

const ConsumerEventOutboxRecordCommonShape = {
  protocol: z.literal(CONSUMER_EVENT_OUTBOX_PROTOCOL),
  schemaVersion: z.literal(1),
  cursor: Uint63StringSchema,
  ownerId: UuidSchema,
  conversationId: UuidSchema,
  invocationId: UuidSchema,
  sourceEventId: Uint63StringSchema,
  eventType: z.literal('invocation.terminal'),
  payload: ConsumerTerminalEventPayloadSchema,
  payloadDigest: Sha256HexSchema,
  dedupeKey: Sha256HexSchema,
  attemptCount: z.number().int().min(0).max(1_000_000),
  createdAt: IsoDateTimeSchema,
  retainedUntil: IsoDateTimeSchema,
} as const;

const ConsumerEventOutboxRecordObjectSchema = z.discriminatedUnion('state', [
  z
    .object({
      ...ConsumerEventOutboxRecordCommonShape,
      state: z.literal('PENDING'),
      nextAttemptAt: IsoDateTimeSchema,
      publishedAt: z.null(),
    })
    .strict(),
  z
    .object({
      ...ConsumerEventOutboxRecordCommonShape,
      state: z.literal('PUBLISHED'),
      nextAttemptAt: z.null(),
      publishedAt: IsoDateTimeSchema,
    })
    .strict(),
]);

export const ConsumerEventOutboxRecordSchema = ConsumerEventOutboxRecordObjectSchema.superRefine(
  (record, context) => {
    if (
      record.payload.conversationId !== record.conversationId ||
      record.payload.invocationId !== record.invocationId ||
      record.payload.type !== record.eventType
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload'],
        message: 'Consumer event payload 必须精确绑定 outbox conversation/invocation/type',
      });
    }
    if (record.payloadDigest !== consumerEventPayloadDigest(record.payload)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payloadDigest'],
        message: 'payloadDigest 与 canonical payload 不匹配',
      });
    }
    if (record.dedupeKey !== consumerEventDedupeKey(record)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dedupeKey'],
        message: 'dedupeKey 与 owner/source event/type 不匹配',
      });
    }
    if (
      Date.parse(record.retainedUntil) - Date.parse(record.createdAt) !==
      CONSUMER_EVENT_RETENTION_MS
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['retainedUntil'],
        message: 'durable Consumer event 必须精确保留 7 天',
      });
    }
  },
);
export type ConsumerEventOutboxRecord = z.infer<typeof ConsumerEventOutboxRecordSchema>;

export const ConsumerEventStreamSchema = z
  .object({
    ownerId: UuidSchema,
    conversationId: UuidSchema,
    latestCursor: Uint63StringSchema,
    expiredThroughCursor: Uint63StringSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .refine(
    (stream) => compareUint63(stream.expiredThroughCursor, stream.latestCursor) <= 0,
    'expiredThroughCursor 不得超过 latestCursor',
  );
export type ConsumerEventStream = z.infer<typeof ConsumerEventStreamSchema>;

export type ConsumerEventReplayDecision =
  | { decision: 'REPLAY'; afterCursor: string }
  | { decision: 'EXPIRED'; code: 'SSE_CURSOR_EXPIRED'; latestCursor: string };

export function consumerEventPayloadDigest(payload: ConsumerTerminalEventPayload): string {
  return canonicalSha256(ConsumerTerminalEventPayloadSchema.parse(payload));
}

export function consumerEventDedupeKey(
  record: Pick<ConsumerEventOutboxRecord, 'ownerId' | 'sourceEventId' | 'eventType'>,
): string {
  return canonicalSha256({
    protocol: CONSUMER_EVENT_OUTBOX_PROTOCOL,
    ownerId: record.ownerId,
    sourceEventId: record.sourceEventId,
    eventType: record.eventType,
  });
}

/**
 * Last-Event-ID=0 表示显式从当前流起点打开；已被 retention 水位淘汰的非零 cursor
 * 必须返回 410，绝不静默当成新连接。
 */
export function decideConsumerEventReplay(
  lastEventId: string,
  streamInput: ConsumerEventStream,
): ConsumerEventReplayDecision {
  const cursor = Uint63StringSchema.parse(lastEventId);
  const stream = ConsumerEventStreamSchema.parse(streamInput);
  if (cursor !== '0' && compareUint63(cursor, stream.expiredThroughCursor) <= 0) {
    return {
      decision: 'EXPIRED',
      code: 'SSE_CURSOR_EXPIRED',
      latestCursor: stream.latestCursor,
    };
  }
  return { decision: 'REPLAY', afterCursor: cursor };
}
