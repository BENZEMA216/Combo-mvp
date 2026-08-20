import { canonicalizeJson } from '@cb/creator-agent-protocol';
import { describe, expect, it } from 'vitest';
import type { QueryResultLike, RuntimeDb, TxConn } from '../../platform/infra/db.js';
import type { ConsumerEventReplayError } from './consumer-events.js';
import {
  formatConsumerEventSse,
  pollConsumerEvents,
  replayConsumerEvents,
} from './consumer-events.js';

const CONSUMER = '01900000-0000-7000-8000-000000000001';
const OTHER_CONSUMER = '01900000-0000-7000-8000-000000000002';
const CREATOR = '01900000-0000-7000-8000-000000000003';
const CONVERSATION = '01900000-0000-7000-8000-000000000004';
const INVOCATION_A = '01900000-0000-7000-8000-000000000005';
const INVOCATION_B = '01900000-0000-7000-8000-000000000006';
const INVOCATION_C = '01900000-0000-7000-8000-000000000007';
const OCCURRED_AT = '2026-08-20T01:02:03.004Z';
const CREATED_AT = '2026-08-20T00:00:00.000Z';

interface FakeStream {
  owner_id?: unknown;
  conversation_id?: unknown;
  latest_cursor: unknown;
  expired_through_cursor: unknown;
  updated_at?: unknown;
}

interface FakeEventRow {
  cursor: unknown;
  owner_id: unknown;
  conversation_id: unknown;
  invocation_id: unknown;
  event_type: unknown;
  payload: unknown;
}

interface FakeOptions {
  conversationOwner?: string;
  creatorId?: unknown;
  stream?: FakeStream;
  streamReads?: Array<FakeStream | undefined>;
  events?: FakeEventRow[];
  eventReads?: FakeEventRow[][];
}

interface Statement {
  sql: string;
  parameters: unknown[];
}

function result<R>(rows: unknown[]): QueryResultLike<R> {
  return { rows: rows as R[], rowCount: rows.length };
}

class ConsumerEventsFakeDb implements RuntimeDb {
  readonly statements: Statement[] = [];
  released = 0;
  destroyed = 0;
  private streamReadCount = 0;
  private eventReadCount = 0;

  public constructor(private readonly options: FakeOptions = {}) {}

  async query<R = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<QueryResultLike<R>> {
    return this.respond<R>({ consumerId: undefined, creatorId: undefined }, sql, parameters ?? []);
  }

  async connect(): Promise<TxConn> {
    const context: { consumerId: unknown; creatorId: unknown } = {
      consumerId: undefined,
      creatorId: undefined,
    };
    return {
      query: <R>(sql: string, parameters?: unknown[]) =>
        this.respond<R>(context, sql, parameters ?? []),
      release: (destroy = false) => {
        this.released += 1;
        if (destroy) this.destroyed += 1;
      },
    };
  }

  private async respond<R>(
    context: { consumerId: unknown; creatorId: unknown },
    sql: string,
    parameters: unknown[],
  ): Promise<QueryResultLike<R>> {
    this.statements.push({ sql, parameters });
    if (sql.includes("set_config('app.consumer_id'")) {
      context.consumerId = parameters[0];
      return result<R>([]);
    }
    if (sql.includes("set_config('app.creator_id'")) {
      context.creatorId = parameters[0];
      return result<R>([]);
    }
    if (sql.includes('FROM agent_conversations')) {
      const owner = this.options.conversationOwner ?? CONSUMER;
      if (
        parameters[0] !== CONVERSATION ||
        parameters[1] !== owner ||
        context.consumerId !== owner
      ) {
        return result<R>([]);
      }
      return result<R>([
        {
          creator_id: this.options.creatorId ?? CREATOR,
          created_at: CREATED_AT,
        },
      ]);
    }
    if (sql.includes('FROM consumer_event_streams')) {
      if (context.consumerId !== CONSUMER || context.creatorId !== CREATOR) return result<R>([]);
      const sequence = this.options.streamReads;
      const stream = sequence
        ? sequence[Math.min(this.streamReadCount, sequence.length - 1)]
        : this.options.stream;
      this.streamReadCount += 1;
      if (!stream) return result<R>([]);
      return result<R>([
        {
          owner_id: stream.owner_id ?? CONSUMER,
          conversation_id: stream.conversation_id ?? CONVERSATION,
          latest_cursor: stream.latest_cursor,
          expired_through_cursor: stream.expired_through_cursor,
          updated_at: stream.updated_at ?? OCCURRED_AT,
        },
      ]);
    }
    if (sql.includes('FROM consumer_event_outbox')) {
      if (context.consumerId !== CONSUMER || context.creatorId !== CREATOR) return result<R>([]);
      const sequence = this.options.eventReads;
      const source = sequence
        ? (sequence[Math.min(this.eventReadCount, sequence.length - 1)] ?? [])
        : (this.options.events ?? []);
      this.eventReadCount += 1;
      const afterCursor = BigInt(parameters[2] as string);
      const limit = parameters[3] as number;
      return result<R>(
        source
          .filter((row) => typeof row.cursor !== 'string' || BigInt(row.cursor) > afterCursor)
          .slice(0, limit),
      );
    }
    return result<R>([]);
  }
}

function stream(latestCursor: string, expiredThroughCursor = '0'): FakeStream {
  return {
    latest_cursor: latestCursor,
    expired_through_cursor: expiredThroughCursor,
  };
}

function terminalPayload(invocationId: string) {
  return {
    protocol: 'combo.consumer-event-outbox/1' as const,
    schemaVersion: 1 as const,
    type: 'invocation.terminal' as const,
    conversationId: CONVERSATION,
    invocationId,
    occurredAt: OCCURRED_AT,
    terminalState: 'CANCELLED' as const,
    assistantMessageId: null,
    resultDigest: null,
    errorCode: null,
  };
}

function terminalRow(
  cursor: string,
  invocationId: string,
  overrides: Partial<FakeEventRow> = {},
): FakeEventRow {
  return {
    cursor,
    owner_id: CONSUMER,
    conversation_id: CONVERSATION,
    invocation_id: invocationId,
    event_type: 'invocation.terminal',
    payload: terminalPayload(invocationId),
    ...overrides,
  };
}

function mutationStatements(db: ConsumerEventsFakeDb): string[] {
  return db.statements
    .map((entry) => entry.sql)
    .filter((sql) => /\b(?:INSERT|UPDATE|DELETE|FOR\s+UPDATE|SKIP\s+LOCKED)\b/iu.test(sql));
}

describe('Creator Agent durable Consumer Event replay', () => {
  it('treats a missing Last-Event-ID as 0 and replays terminal rows in cursor order', async () => {
    const db = new ConsumerEventsFakeDb({
      stream: stream('9'),
      events: [terminalRow('7', INVOCATION_A), terminalRow('9', INVOCATION_B)],
    });

    await expect(
      replayConsumerEvents(db, { consumerId: CONSUMER, conversationId: CONVERSATION, limit: 2 }),
    ).resolves.toEqual({
      latestCursor: '9',
      expiredThroughCursor: '0',
      nextCursor: '9',
      hasMore: false,
      events: [
        {
          id: '7',
          type: 'invocation.terminal',
          payload: terminalRow('7', INVOCATION_A).payload,
        },
        {
          id: '9',
          type: 'invocation.terminal',
          payload: terminalRow('9', INVOCATION_B).payload,
        },
      ],
    });

    const statements = db.statements.map((entry) => entry.sql);
    const consumerContext = statements.findIndex((sql) => sql.includes('app.consumer_id'));
    const conversationLookup = statements.findIndex((sql) => sql.includes('agent_conversations'));
    const creatorContext = statements.findIndex((sql) => sql.includes('app.creator_id'));
    const streamLookup = statements.findIndex((sql) => sql.includes('consumer_event_streams'));
    expect(statements[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(consumerContext).toBeLessThan(conversationLookup);
    expect(conversationLookup).toBeLessThan(creatorContext);
    expect(creatorContext).toBeLessThan(streamLookup);
    expect(statements).toContain('COMMIT');
    expect(
      db.statements.find((entry) => entry.sql.includes('consumer_event_outbox'))?.parameters,
    ).toEqual([CONSUMER, CONVERSATION, '0', 3]);
    expect(mutationStatements(db)).toEqual([]);
    expect(db.released).toBe(1);
  });

  it('uses a sentinel row for bounded pages and reconnects strictly after Last-Event-ID', async () => {
    const rows = [
      terminalRow('7', INVOCATION_A),
      terminalRow('9', INVOCATION_B),
      terminalRow('11', INVOCATION_C),
    ];
    const db = new ConsumerEventsFakeDb({ stream: stream('11'), events: rows });

    const first = await replayConsumerEvents(db, {
      consumerId: CONSUMER,
      conversationId: CONVERSATION,
      limit: 2,
    });
    expect(first.events.map((event) => event.id)).toEqual(['7', '9']);
    expect(first).toMatchObject({ nextCursor: '9', hasMore: true });

    const reconnect = await replayConsumerEvents(db, {
      consumerId: CONSUMER,
      conversationId: CONVERSATION,
      lastEventId: first.nextCursor,
      limit: 2,
    });
    expect(reconnect.events.map((event) => event.id)).toEqual(['11']);
    expect(reconnect).toMatchObject({ nextCursor: '11', hasMore: false });
    expect(new Set([...first.events, ...reconnect.events].map((event) => event.id)).size).toBe(3);
    expect(mutationStatements(db)).toEqual([]);
  });

  it('returns a normal empty page without claiming, leasing, or incrementing the outbox', async () => {
    const db = new ConsumerEventsFakeDb();

    await expect(
      replayConsumerEvents(db, { consumerId: CONSUMER, conversationId: CONVERSATION }),
    ).resolves.toEqual({
      latestCursor: '0',
      expiredThroughCursor: '0',
      nextCursor: '0',
      hasMore: false,
      events: [],
    });
    expect(mutationStatements(db)).toEqual([]);
    expect(db.statements.some((entry) => /claim|attempt_count|lease/iu.test(entry.sql))).toBe(
      false,
    );
  });

  it('fails closed with the typed 410 contract when the frozen replay decision expires a cursor', async () => {
    const db = new ConsumerEventsFakeDb({
      stream: stream('11', '7'),
      events: [terminalRow('9', INVOCATION_B), terminalRow('11', INVOCATION_C)],
    });

    await expect(
      replayConsumerEvents(db, {
        consumerId: CONSUMER,
        conversationId: CONVERSATION,
        lastEventId: '7',
      }),
    ).rejects.toMatchObject({
      name: 'ConsumerEventReplayError',
      code: 'SSE_CURSOR_EXPIRED',
      latestCursor: '11',
    } satisfies Partial<ConsumerEventReplayError>);
    expect(db.statements.some((entry) => entry.sql.includes('consumer_event_outbox'))).toBe(false);
    expect(db.statements.map((entry) => entry.sql)).toContain('ROLLBACK');
  });

  it('does not resolve a Creator or stream for a cross-Consumer conversation', async () => {
    const db = new ConsumerEventsFakeDb({ conversationOwner: OTHER_CONSUMER });

    await expect(
      replayConsumerEvents(db, { consumerId: CONSUMER, conversationId: CONVERSATION }),
    ).rejects.toMatchObject({
      name: 'ConsumerEventReplayError',
      code: 'CONVERSATION_UNAVAILABLE',
    } satisfies Partial<ConsumerEventReplayError>);
    expect(db.statements.some((entry) => entry.sql.includes('app.creator_id'))).toBe(false);
    expect(db.statements.some((entry) => entry.sql.includes('consumer_event_streams'))).toBe(false);
    expect(db.statements.map((entry) => entry.sql)).toContain('ROLLBACK');
  });

  it('uses frozen Uint63 validation before opening a database transaction', async () => {
    const db = new ConsumerEventsFakeDb();

    await expect(
      replayConsumerEvents(db, {
        consumerId: CONSUMER,
        conversationId: CONVERSATION,
        lastEventId: '9223372036854775808',
      }),
    ).rejects.toThrow();
    expect(db.statements).toEqual([]);
  });

  it.each([
    {
      name: 'payload binding mismatch',
      stream: stream('7'),
      events: [
        terminalRow('7', INVOCATION_A, {
          payload: {
            ...terminalPayload(INVOCATION_A),
            conversationId: '01900000-0000-7000-8000-000000000099',
          },
        }),
      ],
    },
    {
      name: 'duplicate cursor',
      stream: stream('7'),
      events: [terminalRow('7', INVOCATION_A), terminalRow('7', INVOCATION_B)],
    },
    {
      name: 'stream points at a missing row',
      stream: stream('7'),
      events: [],
    },
  ])('rejects durable invariant corruption: $name', async ({ stream: fakeStream, events }) => {
    const db = new ConsumerEventsFakeDb({ stream: fakeStream, events });

    await expect(
      replayConsumerEvents(db, { consumerId: CONSUMER, conversationId: CONVERSATION }),
    ).rejects.toMatchObject({
      name: 'ConsumerEventReplayError',
      code: 'PERSISTENCE_INVARIANT_FAILED',
    } satisfies Partial<ConsumerEventReplayError>);
    expect(db.statements.map((entry) => entry.sql)).toContain('ROLLBACK');
  });

  it('offers a bounded, read-only poll that observes a later durable terminal commit', async () => {
    const db = new ConsumerEventsFakeDb({
      streamReads: [stream('0'), stream('7')],
      eventReads: [[], [terminalRow('7', INVOCATION_A)]],
    });
    const waits: number[] = [];

    const polled = await pollConsumerEvents(
      db,
      { consumerId: CONSUMER, conversationId: CONVERSATION },
      {
        maxAttempts: 3,
        intervalMs: 25,
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
      },
    );

    expect(polled.events.map((event) => event.id)).toEqual(['7']);
    expect(polled.pollAttempts).toBe(2);
    expect(waits).toEqual([25]);
    expect(mutationStatements(db)).toEqual([]);
  });
});

describe('canonical Consumer Event SSE formatter', () => {
  it('emits exactly id, event, canonical data and the terminating blank line', () => {
    const event = {
      id: '7',
      type: 'invocation.terminal' as const,
      payload: terminalRow('7', INVOCATION_A).payload,
    };

    expect(formatConsumerEventSse(event)).toBe(
      `id: 7\nevent: invocation.terminal\ndata: ${canonicalizeJson(event)}\n\n`,
    );
  });

  it('rejects line injection and non-durable delta event formatting', () => {
    const delta = {
      id: '8',
      type: 'invocation.delta' as const,
      invocationId: INVOCATION_A,
      text: 'first\nevent: forged\r\nid: 99',
      occurredAt: OCCURRED_AT,
    };
    const terminal = {
      id: '8',
      type: 'invocation.terminal' as const,
      payload: terminalPayload(INVOCATION_A),
    };

    expect(() => formatConsumerEventSse(delta)).toThrow(/non-terminal durable/iu);
    expect(() => formatConsumerEventSse({ ...terminal, id: '8\nevent: forged' })).toThrow(
      /non-terminal durable/iu,
    );
  });
});
