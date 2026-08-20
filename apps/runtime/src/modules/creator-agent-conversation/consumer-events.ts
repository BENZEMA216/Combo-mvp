import {
  ConsumerEventSchema,
  ConsumerEventStreamSchema,
  Uint63StringSchema,
  UuidSchema,
  canonicalizeJson,
  compareUint63,
  decideConsumerEventReplay,
} from '@cb/creator-agent-protocol';
import { z } from 'zod';
import { withTransaction, type RuntimeDb } from '../../platform/infra/db.js';

export const CONSUMER_EVENT_REPLAY_MAX_BATCH = 100;
export const CONSUMER_EVENT_POLL_MAX_ATTEMPTS = 20;
export const CONSUMER_EVENT_POLL_MAX_INTERVAL_MS = 1_000;

const ConsumerEventReplayInputSchema = z
  .object({
    consumerId: UuidSchema,
    conversationId: UuidSchema,
    lastEventId: Uint63StringSchema.optional().default('0'),
    limit: z.number().int().min(1).max(CONSUMER_EVENT_REPLAY_MAX_BATCH).default(50),
  })
  .strict();

export type ConsumerEventReplayInput = z.input<typeof ConsumerEventReplayInputSchema>;
export type RuntimeConsumerEvent = z.infer<typeof ConsumerEventSchema>;

export type ConsumerEventReplayErrorCode =
  | 'CONVERSATION_UNAVAILABLE'
  | 'SSE_CURSOR_EXPIRED'
  | 'PERSISTENCE_INVARIANT_FAILED';

/** Stable repository failure. It never exposes a PostgreSQL error or protocol parser details. */
export class ConsumerEventReplayError extends Error {
  public constructor(
    public readonly code: ConsumerEventReplayErrorCode,
    message: string,
    public readonly latestCursor?: string,
  ) {
    super(message);
    this.name = 'ConsumerEventReplayError';
  }
}

export interface ConsumerEventReplayPage {
  latestCursor: string;
  expiredThroughCursor: string;
  nextCursor: string;
  hasMore: boolean;
  events: RuntimeConsumerEvent[];
}

interface ConversationAuthorityRow {
  creator_id: unknown;
  created_at: unknown;
}

interface ConsumerEventStreamRow {
  owner_id: unknown;
  conversation_id: unknown;
  latest_cursor: unknown;
  expired_through_cursor: unknown;
  updated_at: unknown;
}

interface ConsumerEventRow {
  cursor: unknown;
  owner_id: unknown;
  conversation_id: unknown;
  invocation_id: unknown;
  event_type: unknown;
  payload: unknown;
}

export interface ConsumerEventReplayOptions {
  signal?: AbortSignal;
  /** Internal bounded-test seam; production uses the two-second database deadline. */
  transactionDeadlineMs?: number;
}

function invariant(message: string): ConsumerEventReplayError {
  return new ConsumerEventReplayError('PERSISTENCE_INVARIANT_FAILED', message);
}

function isoDate(value: unknown): string {
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (parsed === null || Number.isNaN(parsed.valueOf())) {
    throw invariant('Consumer Event durable timestamp is invalid');
  }
  return parsed.toISOString();
}

function parseUuid(value: unknown, field: string): string {
  const parsed = UuidSchema.safeParse(value);
  if (!parsed.success) throw invariant(`Consumer Event durable ${field} is invalid`);
  return parsed.data;
}

function parseCursor(value: unknown, field: string): string {
  const parsed = Uint63StringSchema.safeParse(value);
  if (!parsed.success) throw invariant(`Consumer Event durable ${field} is invalid`);
  return parsed.data;
}

function parseStream(
  row: ConsumerEventStreamRow | undefined,
  authority: { consumerId: string; conversationId: string; createdAt: string },
) {
  const candidate =
    row === undefined
      ? {
          ownerId: authority.consumerId,
          conversationId: authority.conversationId,
          latestCursor: '0',
          expiredThroughCursor: '0',
          updatedAt: authority.createdAt,
        }
      : {
          ownerId: parseUuid(row.owner_id, 'stream owner'),
          conversationId: parseUuid(row.conversation_id, 'stream conversation'),
          latestCursor: parseCursor(row.latest_cursor, 'latest cursor'),
          expiredThroughCursor: parseCursor(row.expired_through_cursor, 'expired cursor'),
          updatedAt: isoDate(row.updated_at),
        };
  const parsed = ConsumerEventStreamSchema.safeParse(candidate);
  if (!parsed.success) throw invariant('Consumer Event stream violates the frozen protocol');
  if (
    parsed.data.ownerId !== authority.consumerId ||
    parsed.data.conversationId !== authority.conversationId
  ) {
    throw invariant('Consumer Event stream is not bound to the requested tenant');
  }
  return parsed.data;
}

function mapTerminalEvents(input: {
  rows: ConsumerEventRow[];
  consumerId: string;
  conversationId: string;
  afterCursor: string;
  expiredThroughCursor: string;
  latestCursor: string;
}): RuntimeConsumerEvent[] {
  const events: RuntimeConsumerEvent[] = [];
  let previousCursor = input.afterCursor;

  for (const row of input.rows) {
    const cursor = parseCursor(row.cursor, 'outbox cursor');
    const ownerId = parseUuid(row.owner_id, 'outbox owner');
    const conversationId = parseUuid(row.conversation_id, 'outbox conversation');
    const invocationId = parseUuid(row.invocation_id, 'outbox invocation');
    if (ownerId !== input.consumerId || conversationId !== input.conversationId) {
      throw invariant('Consumer Event outbox row is not bound to the requested tenant');
    }
    if (row.event_type !== 'invocation.terminal') {
      throw invariant('Consumer Event outbox exposed a non-terminal event');
    }
    if (
      compareUint63(cursor, previousCursor) <= 0 ||
      compareUint63(cursor, input.expiredThroughCursor) <= 0 ||
      compareUint63(cursor, input.latestCursor) > 0
    ) {
      throw invariant('Consumer Event outbox cursor order is invalid');
    }

    const parsed = ConsumerEventSchema.safeParse({
      id: cursor,
      type: 'invocation.terminal',
      payload: row.payload,
    });
    if (!parsed.success || parsed.data.type !== 'invocation.terminal') {
      throw invariant('Consumer Event outbox payload violates the frozen HTTP protocol');
    }
    if (
      parsed.data.payload.conversationId !== input.conversationId ||
      parsed.data.payload.invocationId !== invocationId ||
      parsed.data.payload.type !== row.event_type
    ) {
      throw invariant('Consumer Event payload is not bound to its durable outbox row');
    }

    events.push(parsed.data);
    previousCursor = cursor;
  }
  return events;
}

/**
 * Direct, read-only PostgreSQL replay. The first lookup is authorized solely by the authenticated
 * Consumer policy added in migration 0013; only its durable creator_id is then installed into the
 * same transaction for the stream/outbox RLS policies. No client-supplied Creator identity exists.
 */
export async function replayConsumerEvents(
  db: RuntimeDb,
  rawInput: ConsumerEventReplayInput,
  options: ConsumerEventReplayOptions = {},
): Promise<ConsumerEventReplayPage> {
  const input = ConsumerEventReplayInputSchema.parse(rawInput);
  const transactionDeadlineMs = options.transactionDeadlineMs ?? 2_000;
  if (
    !Number.isSafeInteger(transactionDeadlineMs) ||
    transactionDeadlineMs <= 0 ||
    transactionDeadlineMs > 2_000
  ) {
    throw new TypeError('Consumer Event transaction deadline is invalid');
  }
  const localDeadline = AbortSignal.timeout(transactionDeadlineMs);
  const transactionSignal = options.signal
    ? AbortSignal.any([options.signal, localDeadline])
    : localDeadline;

  return withTransaction(
    db,
    async (tx) => {
      await tx.query(`SELECT set_config('app.consumer_id', $1, true)`, [input.consumerId]);
      const authorityResult = await tx.query<ConversationAuthorityRow>(
        `SELECT creator_id, created_at
           FROM agent_conversations
          WHERE id = $1 AND consumer_subject_id = $2`,
        [input.conversationId, input.consumerId],
      );
      if (authorityResult.rows.length === 0) {
        throw new ConsumerEventReplayError(
          'CONVERSATION_UNAVAILABLE',
          'Conversation does not exist or is not owned by this Consumer',
        );
      }
      if (authorityResult.rows.length !== 1) {
        throw invariant('Conversation authority lookup returned a non-unique row');
      }
      const authorityRow = authorityResult.rows[0]!;
      const creatorId = parseUuid(authorityRow.creator_id, 'conversation creator');
      const createdAt = isoDate(authorityRow.created_at);
      await tx.query(`SELECT set_config('app.creator_id', $1, true)`, [creatorId]);

      const streamResult = await tx.query<ConsumerEventStreamRow>(
        `SELECT owner_id, conversation_id, latest_cursor::text,
                expired_through_cursor::text, updated_at
           FROM consumer_event_streams
          WHERE owner_id = $1 AND conversation_id = $2`,
        [input.consumerId, input.conversationId],
      );
      if (streamResult.rows.length > 1) {
        throw invariant('Consumer Event stream lookup returned a non-unique row');
      }
      const stream = parseStream(streamResult.rows[0], {
        consumerId: input.consumerId,
        conversationId: input.conversationId,
        createdAt,
      });
      const decision = decideConsumerEventReplay(input.lastEventId, stream);
      if (decision.decision === 'EXPIRED') {
        throw new ConsumerEventReplayError(
          decision.code,
          'Consumer Event cursor expired',
          decision.latestCursor,
        );
      }

      // Fetch one sentinel row beyond the public batch. This proves hasMore without inferring from
      // the global bigint sequence or from Redis publication state.
      const eventResult = await tx.query<ConsumerEventRow>(
        `SELECT cursor::text, owner_id, conversation_id, invocation_id, event_type, payload
           FROM consumer_event_outbox
          WHERE owner_id = $1
            AND conversation_id = $2
            AND event_type = 'invocation.terminal'
            AND cursor > $3::bigint
          ORDER BY cursor ASC
          LIMIT $4`,
        [input.consumerId, input.conversationId, decision.afterCursor, input.limit + 1],
      );
      const mappedEvents = mapTerminalEvents({
        rows: eventResult.rows,
        consumerId: input.consumerId,
        conversationId: input.conversationId,
        afterCursor: decision.afterCursor,
        expiredThroughCursor: stream.expiredThroughCursor,
        latestCursor: stream.latestCursor,
      });
      const effectiveFloor =
        compareUint63(decision.afterCursor, stream.expiredThroughCursor) >= 0
          ? decision.afterCursor
          : stream.expiredThroughCursor;
      if (mappedEvents.length === 0 && compareUint63(stream.latestCursor, effectiveFloor) > 0) {
        throw invariant('Consumer Event stream points to a missing durable outbox row');
      }
      const hasMore = mappedEvents.length > input.limit;
      const events = hasMore ? mappedEvents.slice(0, input.limit) : mappedEvents;
      const nextCursor = events.at(-1)?.id ?? decision.afterCursor;
      return {
        latestCursor: stream.latestCursor,
        expiredThroughCursor: stream.expiredThroughCursor,
        nextCursor,
        hasMore,
        events,
      };
    },
    {
      readOnlySnapshot: true,
      timeoutMs: transactionDeadlineMs,
      signal: transactionSignal,
    },
  );
}

/** Canonical one-event SSE frame. Validated enum/id fields cannot inject additional SSE lines. */
export function formatConsumerEventSse(rawEvent: unknown): string {
  const parsed = ConsumerEventSchema.safeParse(rawEvent);
  if (!parsed.success || parsed.data.type !== 'invocation.terminal') {
    throw invariant('Cannot format a non-terminal durable Consumer Event');
  }
  const id = parsed.data.id;
  const event = parsed.data.type;
  const data = canonicalizeJson(parsed.data);
  if (/\r|\n/u.test(id) || /\r|\n/u.test(event) || /\r|\n/u.test(data)) {
    throw invariant('Consumer Event SSE field contains a raw line break');
  }
  return `id: ${id}\nevent: ${event}\ndata: ${data}\n\n`;
}

export interface ConsumerEventPollOptions extends ConsumerEventReplayOptions {
  maxAttempts?: number;
  intervalMs?: number;
  /** Deterministic test seam; production uses an abort-aware timer. */
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface ConsumerEventPollResult extends ConsumerEventReplayPage {
  pollAttempts: number;
}

function abortError(): DOMException {
  return new DOMException('Consumer Event poll aborted', 'AbortError');
}

async function waitForPoll(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Handler-facing bounded long poll. It performs at most 20 immutable replay snapshots and never
 * claims/updates the outbox. Token/delta streaming is intentionally absent because no such durable
 * Consumer event exists yet.
 */
export async function pollConsumerEvents(
  db: RuntimeDb,
  input: ConsumerEventReplayInput,
  options: ConsumerEventPollOptions = {},
): Promise<ConsumerEventPollResult> {
  const maxAttempts = options.maxAttempts ?? 1;
  const intervalMs = options.intervalMs ?? 250;
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > CONSUMER_EVENT_POLL_MAX_ATTEMPTS
  ) {
    throw new TypeError('Consumer Event poll attempt bound is invalid');
  }
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 0 ||
    intervalMs > CONSUMER_EVENT_POLL_MAX_INTERVAL_MS
  ) {
    throw new TypeError('Consumer Event poll interval is invalid');
  }

  const wait = options.wait ?? waitForPoll;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const page = await replayConsumerEvents(db, input, options);
    if (page.events.length > 0 || attempt === maxAttempts) {
      return { ...page, pollAttempts: attempt };
    }
    await wait(intervalMs, options.signal);
  }
  throw invariant('Consumer Event bounded poll exhausted without a result');
}
