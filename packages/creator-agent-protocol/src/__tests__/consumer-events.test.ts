import { describe, expect, it } from 'vitest';
// VNext registry case: SCH-001
import {
  ConsumerEventOutboxRecordSchema,
  ConsumerEventStreamSchema,
  ConsumerTerminalEventPayloadSchema,
  consumerEventDedupeKey,
  consumerEventPayloadDigest,
  decideConsumerEventReplay,
} from '../consumer-events.js';
import { readFixture } from './fixture-helpers.js';

describe('durable Consumer terminal event/outbox', () => {
  it('parses the golden row and recomputes canonical payload/dedupe bindings', async () => {
    const record = ConsumerEventOutboxRecordSchema.parse(
      await readFixture('consumer-terminal-event-outbox.v1.json'),
    );
    expect(consumerEventPayloadDigest(record.payload)).toBe(record.payloadDigest);
    expect(consumerEventDedupeKey(record)).toBe(record.dedupeKey);
    expect(record.retainedUntil).toBe('2026-08-20T08:00:10.000Z');
  });

  it('rejects cross-conversation/source mutations and unknown sensitive payload fields', async () => {
    const record = ConsumerEventOutboxRecordSchema.parse(
      await readFixture('consumer-terminal-event-outbox.v1.json'),
    );
    expect(
      ConsumerEventOutboxRecordSchema.safeParse({
        ...record,
        conversationId: '0198f00d-6000-7000-8000-000000000099',
      }).success,
    ).toBe(false);
    expect(
      ConsumerEventOutboxRecordSchema.safeParse({ ...record, sourceEventId: '189' }).success,
    ).toBe(false);
    expect(
      ConsumerTerminalEventPayloadSchema.safeParse({
        ...record.payload,
        text: '正文不属于 durable outbox payload',
      }).success,
    ).toBe(false);
  });

  it('binds success to durable message/result and enforces state plus seven-day retention', async () => {
    const record = ConsumerEventOutboxRecordSchema.parse(
      await readFixture('consumer-terminal-event-outbox.v1.json'),
    );
    expect(
      ConsumerTerminalEventPayloadSchema.safeParse({
        ...record.payload,
        assistantMessageId: null,
      }).success,
    ).toBe(false);
    expect(
      ConsumerEventOutboxRecordSchema.safeParse({ ...record, nextAttemptAt: null }).success,
    ).toBe(false);
    expect(
      ConsumerEventOutboxRecordSchema.safeParse({
        ...record,
        retainedUntil: '2026-08-20T08:00:09.999Z',
      }).success,
    ).toBe(false);
    expect(
      ConsumerEventOutboxRecordSchema.safeParse({
        ...record,
        state: 'PUBLISHED',
        nextAttemptAt: null,
        publishedAt: '2026-08-13T08:00:11.000Z',
      }).success,
    ).toBe(true);
  });

  it('freezes public terminal error semantics without leaking result fields', async () => {
    const record = ConsumerEventOutboxRecordSchema.parse(
      await readFixture('consumer-terminal-event-outbox.v1.json'),
    );
    const terminal = (terminalState: string, errorCode: string | null) => ({
      ...record.payload,
      terminalState,
      assistantMessageId: null,
      resultDigest: null,
      errorCode,
    });

    expect(ConsumerTerminalEventPayloadSchema.safeParse(terminal('CANCELLED', null)).success).toBe(
      true,
    );
    expect(
      ConsumerTerminalEventPayloadSchema.safeParse(terminal('UNCERTAIN', 'EXECUTION_STATE_UNKNOWN'))
        .success,
    ).toBe(true);
    expect(
      ConsumerTerminalEventPayloadSchema.safeParse(terminal('EXPIRED', 'INVOCATION_EXPIRED'))
        .success,
    ).toBe(true);
    expect(
      ConsumerTerminalEventPayloadSchema.safeParse(terminal('FAILED', 'TURN_FAILED')).success,
    ).toBe(true);
    expect(ConsumerTerminalEventPayloadSchema.safeParse(terminal('RUNNING', null)).success).toBe(
      false,
    );
    expect(ConsumerTerminalEventPayloadSchema.safeParse(terminal('UNCERTAIN', null)).success).toBe(
      false,
    );
    expect(
      ConsumerTerminalEventPayloadSchema.safeParse(terminal('EXPIRED', 'TURN_TIMEOUT')).success,
    ).toBe(false);
    expect(ConsumerTerminalEventPayloadSchema.safeParse(terminal('FAILED', null)).success).toBe(
      false,
    );
    expect(
      ConsumerTerminalEventPayloadSchema.safeParse(terminal('CANCELLED', 'CANCEL_NOT_CONFIRMED'))
        .success,
    ).toBe(false);
  });

  it('returns 410 only for a nonzero cursor at/below the durable expiry watermark', () => {
    const stream = ConsumerEventStreamSchema.parse({
      ownerId: '0198f00d-6000-7000-8000-000000000004',
      conversationId: '0198f00d-6000-7000-8000-000000000001',
      latestCursor: '901',
      expiredThroughCursor: '800',
      updatedAt: '2026-08-20T08:00:10.000Z',
    });
    expect(decideConsumerEventReplay('800', stream)).toEqual({
      decision: 'EXPIRED',
      code: 'SSE_CURSOR_EXPIRED',
      latestCursor: '901',
    });
    expect(decideConsumerEventReplay('799', stream)).toMatchObject({ decision: 'EXPIRED' });
    expect(decideConsumerEventReplay('801', stream)).toEqual({
      decision: 'REPLAY',
      afterCursor: '801',
    });
    expect(decideConsumerEventReplay('0', stream)).toEqual({
      decision: 'REPLAY',
      afterCursor: '0',
    });
  });
});
