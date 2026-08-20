import { EventEmitter } from 'node:events';

import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeDb } from '../../platform/infra/db.js';
import { ConsumerEventReplayError, formatConsumerEventSse } from './consumer-events.js';
import type { pollConsumerEvents } from './consumer-events.js';
import { getConsumerEventsHandler } from './handlers.js';

const CONSUMER_ID = '01900000-0000-7000-8000-000000000401';
const CONVERSATION_ID = '01900000-0000-7000-8000-000000000402';
const INVOCATION_ID = '01900000-0000-7000-8000-000000000403';
const ASSISTANT_MESSAGE_ID = '01900000-0000-7000-8000-000000000404';

const inertDb = {
  async query() {
    throw new Error('direct query was not expected');
  },
  async connect() {
    throw new Error('transaction was not expected');
  },
} as RuntimeDb;

function request(
  input: {
    userId?: string;
    conversationId?: unknown;
    lastEventId?: string | string[];
    db?: RuntimeDb | null;
    raw?: EventEmitter;
  } = {},
): FastifyRequest {
  return {
    id: 'consumer-events-handler-request-0001',
    auth: input.userId
      ? { userId: input.userId, account: 'consumer', roles: ['creator'] }
      : undefined,
    params: { conversationId: input.conversationId ?? CONVERSATION_ID },
    headers: input.lastEventId === undefined ? {} : { 'last-event-id': input.lastEventId },
    log: { error: vi.fn() },
    raw: input.raw ?? new EventEmitter(),
    server: { infra: { creatorAgentDb: input.db === undefined ? inertDb : input.db } },
  } as unknown as FastifyRequest;
}

interface CapturedReply {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  code(statusCode: number): CapturedReply;
  header(name: string, value: string): CapturedReply;
  type(value: string): CapturedReply;
  send(body: unknown): CapturedReply;
}

function reply(): CapturedReply {
  return {
    statusCode: 0,
    body: undefined,
    headers: {},
    code(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    header(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    type(value) {
      this.headers['content-type'] = value;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
}

async function call(
  requestInput: Parameters<typeof request>[0],
  poll: typeof pollConsumerEvents,
): Promise<CapturedReply> {
  const response = reply();
  await (
    getConsumerEventsHandler({ poll }) as unknown as (
      req: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<unknown>
  )(request(requestInput), response as unknown as FastifyReply);
  return response;
}

function terminalEvent() {
  return {
    id: '9',
    type: 'invocation.terminal' as const,
    payload: {
      protocol: 'combo.consumer-event-outbox/1' as const,
      schemaVersion: 1 as const,
      type: 'invocation.terminal' as const,
      conversationId: CONVERSATION_ID,
      invocationId: INVOCATION_ID,
      occurredAt: '2026-08-20T01:02:03.004Z',
      terminalState: 'SUCCEEDED' as const,
      assistantMessageId: ASSISTANT_MESSAGE_ID,
      resultDigest: `hmac-sha256:${'a'.repeat(64)}`,
      errorCode: null,
    },
  };
}

describe('GET /v1/conversations/:conversationId/events handler', () => {
  it('emits a terminal-only bounded SSE page and closes the response body', async () => {
    const event = terminalEvent();
    const poll = vi.fn(
      async (_db: RuntimeDb, _input: Parameters<typeof pollConsumerEvents>[1]) => ({
        latestCursor: '9',
        expiredThroughCursor: '0',
        nextCursor: '9',
        hasMore: false,
        events: [event],
        pollAttempts: 1,
      }),
    );
    const response = await call({ userId: CONSUMER_ID, lastEventId: '7' }, poll);

    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    });
    expect(response.body).toBe(formatConsumerEventSse(event));
    expect(poll).toHaveBeenCalledWith(
      inertDb,
      {
        consumerId: CONSUMER_ID,
        conversationId: CONVERSATION_ID,
        lastEventId: '7',
        limit: 50,
      },
      expect.objectContaining({ maxAttempts: 4, intervalMs: 250 }),
    );
  });

  it('defaults a missing cursor to zero and rejects malformed/duplicate cursors before polling', async () => {
    const poll = vi.fn(
      async (_db: RuntimeDb, _input: Parameters<typeof pollConsumerEvents>[1]) => ({
        latestCursor: '0',
        expiredThroughCursor: '0',
        nextCursor: '0',
        hasMore: false,
        events: [],
        pollAttempts: 1,
      }),
    );
    await call({ userId: CONSUMER_ID }, poll);
    expect(poll.mock.calls[0]?.[1]).toMatchObject({ lastEventId: '0' });

    const malformed = await call(
      {
        userId: CONSUMER_ID,
        lastEventId: '9223372036854775808',
      },
      poll,
    );
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).toMatchObject({ code: 'INVALID_INPUT' });

    const duplicate = await call({ userId: CONSUMER_ID, lastEventId: ['7', '7'] }, poll);
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.body).toMatchObject({ code: 'INVALID_INPUT' });
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['SSE_CURSOR_EXPIRED', 410, 'SSE_CURSOR_EXPIRED'],
    ['CONVERSATION_UNAVAILABLE', 403, 'FORBIDDEN'],
    ['PERSISTENCE_INVARIANT_FAILED', 503, 'AGENT_OFFLINE'],
  ] as const)(
    'maps repository %s without exposing its internal message',
    async (repositoryCode, statusCode, publicCode) => {
      const poll = vi.fn(async () => {
        throw new ConsumerEventReplayError(repositoryCode, 'sensitive internal detail', '9');
      });
      const response = await call({ userId: CONSUMER_ID, lastEventId: '7' }, poll);
      expect(response.statusCode).toBe(statusCode);
      expect(response.body).toMatchObject({ code: publicCode });
      expect(JSON.stringify(response.body)).not.toContain('sensitive internal detail');
    },
  );

  it('rejects unauthenticated or disabled product requests before polling', async () => {
    const poll = vi.fn();
    const unauthenticated = await call({}, poll);
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.body).toMatchObject({ code: 'UNAUTHORIZED' });
    const disabled = await call({ userId: CONSUMER_ID, db: null }, poll);
    expect(disabled.statusCode).toBe(503);
    expect(disabled.body).toMatchObject({ code: 'AGENT_OFFLINE' });
    expect(poll).not.toHaveBeenCalled();
  });

  it.each(['close', 'aborted'] as const)(
    'aborts the bounded poll and releases request listeners on %s',
    async (disconnectEvent) => {
      const raw = new EventEmitter();
      let pollSignal: AbortSignal | undefined;
      const poll = vi.fn(
        (
          _db: RuntimeDb,
          _input: Parameters<typeof pollConsumerEvents>[1],
          options?: NonNullable<Parameters<typeof pollConsumerEvents>[2]>,
        ): ReturnType<typeof pollConsumerEvents> => {
          const signal = options?.signal;
          if (!signal) throw new Error('poll signal missing');
          pollSignal = signal;
          return new Promise((_resolve, reject) => {
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          });
        },
      );

      const pending = call({ userId: CONSUMER_ID, lastEventId: '7', raw }, poll);
      await vi.waitFor(() => expect(pollSignal).toBeDefined());
      raw.emit(disconnectEvent);
      const response = await pending;

      expect(pollSignal?.aborted).toBe(true);
      expect(response.statusCode).toBe(0);
      expect(response.body).toBeUndefined();
      expect(raw.listenerCount('close')).toBe(0);
      expect(raw.listenerCount('aborted')).toBe(0);
    },
  );
});
