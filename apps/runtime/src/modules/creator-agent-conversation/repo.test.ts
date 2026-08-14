import { describe, expect, it } from 'vitest';
import type { QueryResultLike, RuntimeDb, TxConn } from '../../platform/infra/db.js';
import type { ConsumerConversationError } from './repo.js';
import { createConsumerConversation, createConversationRequestDigest } from './repo.js';

const CONSUMER = '01900000-0000-7000-8000-000000000001';
const CREATOR = '01900000-0000-7000-8000-000000000002';
const AGENT = '01900000-0000-7000-8000-000000000003';
const VERSION = '01900000-0000-7000-8000-000000000004';
const DEPLOYMENT = '01900000-0000-7000-8000-000000000005';
const WORKER = '01900000-0000-7000-8000-000000000006';
const CONVERSATION = '01900000-0000-7000-8000-000000000007';
const IDEMPOTENCY = '01900000-0000-7000-8000-000000000008';
const VERSION_DIGEST = 'a'.repeat(64);
const CREATED_AT = new Date('2026-08-14T00:00:00.000Z');
const EXPIRES_AT = new Date('2026-08-15T00:00:00.000Z');

interface FakeOptions {
  existingDigest?: string;
  grant?: boolean;
  deployment?: Partial<{
    desired_state: string;
    observed_state: string;
    generation: string;
    observed_generation: string | null;
    lease_fence: string;
    serving_version_id: string | null;
    observed_worker_id: string | null;
    version_digest: string | null;
    version_availability: string | null;
  }>;
  lease?: boolean;
  failInsert?: boolean;
  insertDelayMs?: number;
}

class CreatorConversationFakeDb implements RuntimeDb {
  readonly statements: string[] = [];
  released = false;

  constructor(private readonly options: FakeOptions = {}) {}

  async query<R = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<QueryResultLike<R>> {
    return this.respond<R>(sql, parameters);
  }

  async connect(): Promise<TxConn> {
    return {
      query: <R>(sql: string, parameters?: unknown[]) => this.respond<R>(sql, parameters),
      release: () => {
        this.released = true;
      },
    };
  }

  private async respond<R>(sql: string, _parameters?: unknown[]): Promise<QueryResultLike<R>> {
    this.statements.push(sql);
    if (sql.includes('FROM agent_conversations') && sql.includes('idempotency_key')) {
      if (this.options.existingDigest === undefined) return result<R>([]);
      return result<R>([
        {
          id: CONVERSATION,
          agent_id: AGENT,
          agent_version_id: VERSION,
          version_digest: VERSION_DIGEST,
          state: 'IDLE',
          created_at: CREATED_AT,
          expires_at: EXPIRES_AT,
          request_digest: this.options.existingDigest,
        },
      ]);
    }
    if (sql.includes('FROM agents AS agent')) {
      return this.options.grant === false
        ? result<R>([])
        : result<R>([{ agent_id: AGENT, creator_id: CREATOR }]);
    }
    if (sql.includes('FROM deployments AS deployment')) {
      const overrides = this.options.deployment ?? {};
      return result<R>([
        {
          deployment_id: DEPLOYMENT,
          desired_state: 'ONLINE',
          observed_state: 'ONLINE',
          generation: '7',
          observed_generation: '7',
          lease_fence: '11',
          serving_version_id: VERSION,
          observed_worker_id: WORKER,
          version_digest: VERSION_DIGEST,
          version_availability: 'ACTIVE',
          ...overrides,
        },
      ]);
    }
    if (sql.includes('FROM agent_version_controls')) {
      return this.options.deployment?.version_availability === 'ACTIVE' ||
        this.options.deployment?.version_availability === undefined
        ? result<R>([{ availability: 'ACTIVE' }])
        : result<R>([]);
    }
    if (sql.includes('creator_agent_create_opening_conversation')) {
      if (this.options.lease === false) return result<R>([]);
      if (this.options.failInsert) throw new Error('insert unavailable');
      if (this.options.insertDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, this.options.insertDelayMs));
      }
      return result<R>([
        {
          id: CONVERSATION,
          agent_id: AGENT,
          agent_version_id: VERSION,
          version_digest: VERSION_DIGEST,
          state: 'OPENING',
          created_at: CREATED_AT,
          expires_at: EXPIRES_AT,
        },
      ]);
    }
    return result<R>([]);
  }
}

function result<R>(rows: unknown[]): QueryResultLike<R> {
  return { rows: rows as R[], rowCount: rows.length };
}

function input(publicSlug = 'research-agent') {
  return {
    consumerId: CONSUMER,
    publicSlug,
    idempotencyKey: IDEMPOTENCY,
    environment: 'TEST' as const,
  };
}

describe('Creator-hosted Consumer Conversation repository', () => {
  it('atomically pins an ACTIVE grant, serving Version, ONLINE generation and live Worker Lease', async () => {
    const db = new CreatorConversationFakeDb();

    await expect(createConsumerConversation(db, input())).resolves.toEqual({
      replayed: false,
      conversation: {
        protocol: 'combo.creator-agent-http/1',
        conversationId: CONVERSATION,
        agentId: AGENT,
        agentVersionId: VERSION,
        versionDigest: VERSION_DIGEST,
        state: 'OPENING',
        createdAt: CREATED_AT.toISOString(),
        expiresAt: EXPIRES_AT.toISOString(),
      },
    });
    expect(db.statements[0]).toBe('BEGIN');
    expect(db.statements).toContain('COMMIT');
    expect(db.statements.some((sql) => sql.includes("set_config('app.consumer_id'"))).toBe(true);
    expect(db.statements.some((sql) => sql.includes("set_config('app.creator_id'"))).toBe(true);
    expect(
      db.statements.filter((sql) => sql.includes('creator_agent_create_opening_conversation')),
    ).toHaveLength(1);
    expect(db.released).toBe(true);
  });

  it('uses one absolute deadline through the final write and never commits a late transaction', async () => {
    const db = new CreatorConversationFakeDb({ insertDelayMs: 30 });

    await expect(
      createConsumerConversation(db, input(), { transactionDeadlineMs: 10 }),
    ).rejects.toThrow(/aborted/iu);
    expect(db.statements).not.toContain('COMMIT');
    expect(db.released).toBe(true);
  });

  it('replays the exact idempotent request without rechecking mutable deployment state', async () => {
    const digest = createConversationRequestDigest({
      publicSlug: 'research-agent',
      environment: 'TEST',
    });
    const db = new CreatorConversationFakeDb({
      existingDigest: digest,
      grant: false,
      lease: false,
    });

    const replay = await createConsumerConversation(db, input());

    expect(replay.replayed).toBe(true);
    expect(db.statements.some((sql) => sql.includes('FROM agents AS agent'))).toBe(false);
    expect(
      db.statements.some((sql) => sql.includes('creator_agent_create_opening_conversation')),
    ).toBe(false);
    expect(db.statements).toContain('COMMIT');
  });

  it('rejects the same key with a byte-distinct Agent binding and rolls back', async () => {
    const db = new CreatorConversationFakeDb({ existingDigest: 'f'.repeat(64) });

    await expect(createConsumerConversation(db, input())).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    } satisfies Partial<ConsumerConversationError>);
    expect(db.statements).toContain('ROLLBACK');
    expect(
      db.statements.some((sql) => sql.includes('creator_agent_create_opening_conversation')),
    ).toBe(false);
  });

  it('treats the public slug as a locator and creates nothing without an ACTIVE grant', async () => {
    const db = new CreatorConversationFakeDb({ grant: false });

    await expect(createConsumerConversation(db, input())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    } satisfies Partial<ConsumerConversationError>);
    expect(db.statements).toContain('ROLLBACK');
    expect(db.statements.some((sql) => sql.includes('FROM deployments AS deployment'))).toBe(false);
  });

  it.each([
    [{ observed_state: 'DEGRADED' }, 'AGENT_OFFLINE'],
    [{ observed_generation: '6' }, 'AGENT_OFFLINE'],
    [{ version_availability: 'REVOKED' }, 'VERSION_UNAVAILABLE'],
    [{ serving_version_id: null, version_digest: null }, 'VERSION_UNAVAILABLE'],
  ] as const)('fails closed for non-serving authority %#', async (deployment, code) => {
    const db = new CreatorConversationFakeDb({ deployment });

    await expect(createConsumerConversation(db, input())).rejects.toMatchObject({ code });
    expect(
      db.statements.some((sql) => sql.includes('creator_agent_create_opening_conversation')),
    ).toBe(false);
  });

  it('lets the atomic authority reject an expired/missing Worker Lease', async () => {
    const db = new CreatorConversationFakeDb({ lease: false });

    await expect(createConsumerConversation(db, input())).rejects.toMatchObject({
      code: 'AGENT_OFFLINE',
    });
    expect(
      db.statements.some((sql) => sql.includes('creator_agent_create_opening_conversation')),
    ).toBe(true);
    expect(db.statements).toContain('ROLLBACK');
    expect(db.statements).not.toContain('COMMIT');
  });

  it('rolls back and releases the connection when persistence fails', async () => {
    const db = new CreatorConversationFakeDb({ failInsert: true });

    await expect(createConsumerConversation(db, input())).rejects.toThrow('insert unavailable');
    expect(db.statements).toContain('ROLLBACK');
    expect(db.statements).not.toContain('COMMIT');
    expect(db.released).toBe(true);
  });
});
