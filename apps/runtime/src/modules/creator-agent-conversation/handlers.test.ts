import { describe, expect, it } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { QueryResultLike, RuntimeDb, TxConn } from '../../platform/infra/db.js';
import { createConversationRequestDigest } from './repo.js';
import { createConsumerConversationHandler } from './handlers.js';
import type { VisibleTranscriptDigester } from './visible-transcript-digester.js';

const CONSUMER = '01900000-0000-7000-8000-000000000001';
const CREATOR = '01900000-0000-7000-8000-000000000002';
const AGENT = '01900000-0000-7000-8000-000000000003';
const VERSION = '01900000-0000-7000-8000-000000000004';
const DEPLOYMENT = '01900000-0000-7000-8000-000000000005';
const WORKER = '01900000-0000-7000-8000-000000000006';
const CONVERSATION = '01900000-0000-7000-8000-000000000007';
const IDEMPOTENCY = '01900000-0000-7000-8000-000000000008';
const VERSION_DIGEST = 'a'.repeat(64);
const visibleTranscriptDigester: VisibleTranscriptDigester = async () => ({
  digest: `hmac-sha256:${'b'.repeat(64)}`,
  keyId: 'visible-key-a',
  keyVersion: 7n,
  keyRef: 'kms://combo/visible/creator/version/key-a@7',
});

interface HandlerDbOptions {
  existingDigest?: string;
  grant?: boolean;
  offline?: boolean;
  unavailableVersion?: boolean;
}

class HandlerDb implements RuntimeDb {
  queryCount = 0;

  public constructor(private readonly options: HandlerDbOptions = {}) {}

  async query<R = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<QueryResultLike<R>> {
    return this.respond<R>(sql, parameters);
  }

  async connect(): Promise<TxConn> {
    return {
      query: <R>(sql: string, parameters?: unknown[]) => this.respond<R>(sql, parameters),
      release: () => undefined,
    };
  }

  private async respond<R>(sql: string, _parameters?: unknown[]): Promise<QueryResultLike<R>> {
    this.queryCount += 1;
    if (sql.includes('FROM agent_conversations') && sql.includes('idempotency_key')) {
      if (this.options.existingDigest === undefined) return rows<R>([]);
      return rows<R>([
        {
          id: CONVERSATION,
          agent_id: AGENT,
          agent_version_id: VERSION,
          version_digest: VERSION_DIGEST,
          state: 'IDLE',
          created_at: new Date('2026-08-14T00:00:00.000Z'),
          expires_at: new Date('2026-08-15T00:00:00.000Z'),
          request_digest: this.options.existingDigest,
        },
      ]);
    }
    if (sql.includes('FROM agents AS agent')) {
      return this.options.grant === false
        ? rows<R>([])
        : rows<R>([{ agent_id: AGENT, creator_id: CREATOR }]);
    }
    if (sql.includes('FROM deployments AS deployment')) {
      return rows<R>([
        {
          deployment_id: DEPLOYMENT,
          desired_state: 'ONLINE',
          observed_state: this.options.offline ? 'OFFLINE' : 'ONLINE',
          generation: '4',
          observed_generation: '4',
          lease_fence: '9',
          serving_version_id: VERSION,
          observed_worker_id: WORKER,
          version_digest: VERSION_DIGEST,
        },
      ]);
    }
    if (sql.includes('FROM agent_version_controls')) {
      return this.options.unavailableVersion ? rows<R>([]) : rows<R>([{ availability: 'ACTIVE' }]);
    }
    if (sql.includes('creator_agent_create_opening_conversation')) {
      return rows<R>([
        {
          id: CONVERSATION,
          agent_id: AGENT,
          agent_version_id: VERSION,
          version_digest: VERSION_DIGEST,
          state: 'OPENING',
          created_at: new Date('2026-08-14T00:00:00.000Z'),
          expires_at: new Date('2026-08-15T00:00:00.000Z'),
        },
      ]);
    }
    return rows<R>([]);
  }
}

function rows<R>(values: unknown[]): QueryResultLike<R> {
  return { rows: values as R[], rowCount: values.length };
}

function request(input: {
  db: RuntimeDb;
  userId?: string;
  slug?: string;
  body?: unknown;
  idempotencyKey?: string | string[];
  environment?: string;
}): FastifyRequest {
  return {
    id: 'trace-consumer-create-0001',
    auth: input.userId
      ? { userId: input.userId, account: 'consumer-test', roles: ['creator'] }
      : undefined,
    params: { slug: input.slug ?? 'research-agent' },
    body: input.body ?? {},
    headers: {
      ...(input.idempotencyKey === undefined ? {} : { 'idempotency-key': input.idempotencyKey }),
    },
    log: { error: () => undefined },
    server: {
      infra: {
        db: input.db,
        creatorAgentDb: input.db,
        env: { COMBO_ENVIRONMENT: input.environment ?? 'test' },
      },
    },
  } as unknown as FastifyRequest;
}

interface CapturedReply {
  statusCode: number;
  body: unknown;
  code(statusCode: number): CapturedReply;
  send(body: unknown): CapturedReply;
}

function reply(): CapturedReply {
  const value = {
    statusCode: 0,
    body: undefined as unknown,
    code(statusCode: number) {
      this.statusCode = statusCode;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return value;
}

async function call(input: Parameters<typeof request>[0], injectDigester = true) {
  const response = reply();
  await (
    createConsumerConversationHandler(
      injectDigester ? { visibleTranscriptDigester } : {},
    ) as unknown as (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>
  )(request(input), response as unknown as FastifyReply);
  return response;
}

describe('POST /v1/public/agents/:slug/conversations handler', () => {
  it('rejects an unauthenticated request before touching PostgreSQL', async () => {
    const db = new HandlerDb();
    const response = await call({ db, idempotencyKey: IDEMPOTENCY });

    expect(response.statusCode).toBe(401);
    expect(response.body).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(db.queryCount).toBe(0);
  });

  it.each([
    ['missing idempotency key', { idempotencyKey: undefined }],
    ['malformed idempotency key', { idempotencyKey: 'not-a-uuid' }],
    ['duplicate idempotency key', { idempotencyKey: [IDEMPOTENCY, IDEMPOTENCY] }],
    ['invalid slug', { idempotencyKey: IDEMPOTENCY, slug: '../private' }],
    ['unknown body field', { idempotencyKey: IDEMPOTENCY, body: { model: 'unsafe' } }],
    ['unknown environment', { idempotencyKey: IDEMPOTENCY, environment: 'mystery' }],
  ])('rejects %s before touching PostgreSQL', async (_name, overrides) => {
    const db = new HandlerDb();
    const response = await call({ db, userId: CONSUMER, ...overrides });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: 'INVALID_INPUT' });
    expect(db.queryCount).toBe(0);
  });

  it('creates once and returns the exact frozen Conversation view', async () => {
    const db = new HandlerDb();
    const response = await call({ db, userId: CONSUMER, idempotencyKey: IDEMPOTENCY });

    expect(response.statusCode).toBe(201);
    expect(response.body).toMatchObject({
      protocol: 'combo.creator-agent-http/1',
      conversationId: CONVERSATION,
      agentId: AGENT,
      agentVersionId: VERSION,
      versionDigest: VERSION_DIGEST,
      state: 'OPENING',
    });
  });

  it('returns the frozen 201 resource representation for an exact idempotent replay', async () => {
    const db = new HandlerDb({
      existingDigest: createConversationRequestDigest({
        publicSlug: 'research-agent',
        environment: 'TEST',
      }),
    });
    const response = await call({ db, userId: CONSUMER, idempotencyKey: IDEMPOTENCY });

    expect(response.statusCode).toBe(201);
    expect(response.body).toMatchObject({ conversationId: CONVERSATION });
  });

  it('fails closed when a fresh create has no injected KMS HMAC authority', async () => {
    const db = new HandlerDb();
    const response = await call({ db, userId: CONSUMER, idempotencyKey: IDEMPOTENCY }, false);

    expect(response.statusCode).toBe(503);
    expect(response.body).toMatchObject({ code: 'AGENT_OFFLINE' });
  });

  it.each([
    ['FORBIDDEN', { grant: false }, 403],
    ['AGENT_OFFLINE', { offline: true }, 503],
    ['VERSION_UNAVAILABLE', { unavailableVersion: true }, 409],
    ['IDEMPOTENCY_CONFLICT', { existingDigest: 'f'.repeat(64) }, 409],
  ] as const)('maps %s to the frozen public error envelope', async (code, options, status) => {
    const response = await call({
      db: new HandlerDb(options),
      userId: CONSUMER,
      idempotencyKey: IDEMPOTENCY,
    });

    expect(response.statusCode).toBe(status);
    expect(response.body).toMatchObject({ code, requestId: 'trace-consumer-create-0001' });
  });
});
