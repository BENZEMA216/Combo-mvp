import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, describe, expect, it } from 'vitest';
import type { Queryable, QueryResultLike } from '../../platform/infra/db.js';
import { registerCodexAgentShareRoutes } from './routes.js';

const ORIGIN = 'https://test.43-160-242-46.sslip.io';
const SESSION = `s1.${'S'.repeat(43)}`;
const OWNER_ID = '00000000-0000-4000-8000-000000000001';

interface StoredRow {
  id: string;
  owner_user_id: string;
  share_token: string;
  manifest: Record<string, unknown>;
  manifest_sha256: string;
  idempotency_key: string;
  idempotency_sha256: string;
  created_at: string;
}

class RouteDb implements Queryable {
  row: StoredRow | undefined;
  inserts = 0;
  shareQueries = 0;

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    if (sql.includes('project_agent_shares')) this.shareQueries += 1;
    if (sql.includes('FROM auth_sessions')) {
      return {
        rows: [
          {
            session_id: '00000000-0000-4000-8000-000000000010',
            user_id: OWNER_ID,
            account: 'creator-aaaaaaaa',
            roles: ['creator'],
            disabled_at: null,
          } as R,
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('INSERT INTO project_agent_shares')) {
      this.inserts += 1;
      this.row = {
        id: '00000000-0000-4000-8000-000000000099',
        owner_user_id: String(params[0]),
        share_token: String(params[1]),
        manifest: JSON.parse(String(params[2])) as Record<string, unknown>,
        manifest_sha256: String(params[3]),
        idempotency_key: String(params[4]),
        idempotency_sha256: String(params[5]),
        created_at: String(params[6]),
      };
      return { rows: [this.row as R], rowCount: 1 };
    }
    if (sql.includes('WHERE share_token')) {
      const matched = this.row?.share_token === params[0] ? this.row : undefined;
      return { rows: matched ? [matched as R] : [], rowCount: matched ? 1 : 0 };
    }
    if (sql.includes('WHERE owner_user_id')) {
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`unexpected query: ${sql}`);
  }
}

async function buildRouteApp(comboEnvironment: string): Promise<{
  app: FastifyInstance;
  db: RouteDb;
}> {
  const app = Fastify({ logger: false });
  const db = new RouteDb();
  app.decorate('infra', {
    db,
    objectStore: {},
    env: {
      COMBO_ENVIRONMENT: comboEnvironment,
      EXTERNAL_MCP_PUBLIC_ORIGIN: ORIGIN,
      PUBLIC_APP_ORIGINS: ORIGIN,
      SESSION_COOKIE_SECURE: false,
    },
  } as never);
  await app.register(cookie);
  await app.register(registerCodexAgentShareRoutes, { prefix: '/api/v1' });
  return { app, db };
}

function headers(withSession = true): Record<string, string> {
  return {
    origin: ORIGIN,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    ...(withSession ? { cookie: `cb_session=${SESSION}` } : {}),
  };
}

function body(instructions: string, starterPrompts: string[]) {
  return {
    name: 'Multibyte reviewer',
    description: 'Exercise the complete bounded Codex Agent request.',
    repositoryUrl: 'https://github.com/openai/codex.git',
    sourceRef: 'refs/heads/main',
    commitSha: 'a'.repeat(40),
    treeSha: 'b'.repeat(40),
    agent: { instructions, starterPrompts },
    requirements: { commands: ['git'], plugins: [], environmentVariableNames: [] },
    idempotencyKey: '00000000-0000-4000-8000-000000000002',
  };
}

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('Codex Agent share HTTP route', () => {
  it('accepts the maximum multibyte schema payload above 32 KiB and still rejects 8001 chars', async () => {
    const { app, db } = await buildRouteApp('test');
    openApps.push(app);
    const instructions = '中'.repeat(8_000);
    const starterPrompts = Array.from({ length: 5 }, (_, index) => `${'🙂'.repeat(499)}中${index}`);
    const payload = body(instructions, starterPrompts);
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeGreaterThan(32 * 1_024);

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/codex-agent-shares',
      headers: headers(),
      payload,
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json()).toMatchObject({
      data: { manifest: { agent: { instructions, starterPrompts } } },
    });
    expect(db.inserts).toBe(1);

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/codex-agent-shares',
      headers: headers(),
      payload: {
        ...payload,
        agent: { ...payload.agent, instructions: '中'.repeat(8_001) },
        idempotencyKey: '00000000-0000-4000-8000-000000000003',
      },
    });
    expect(rejected.statusCode).toBe(400);
    expect(db.inserts).toBe(1);
  });

  it.each(['preview', 'production'])(
    'returns STATE_CONFLICT semantics with zero share writes in %s',
    async (comboEnvironment) => {
      const { app, db } = await buildRouteApp(comboEnvironment);
      openApps.push(app);
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/codex-agent-shares',
        headers: headers(),
        payload: body('Review.', ['Review this branch.']),
      });
      expect(response.statusCode).toBe(409);
      expect(response.body).toContain('当前环境只允许读取');
      expect(db.inserts).toBe(0);
    },
  );

  it('rejects NUL and malformed Unicode before any share query or insert', async () => {
    const { app, db } = await buildRouteApp('test');
    openApps.push(app);
    for (const invalidText of ['contains\u0000nul', 'lone-high-\ud800', 'lone-low-\udc00']) {
      for (const override of [
        { name: invalidText },
        { description: invalidText },
        { agent: { instructions: invalidText, starterPrompts: ['Review.'] } },
        { agent: { instructions: 'Review.', starterPrompts: [invalidText] } },
        { requirements: { codexVersion: invalidText } },
        { sourceRef: `refs/heads/${invalidText}` },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/codex-agent-shares',
          headers: headers(),
          payload: {
            ...body('Review.', ['Review this branch.']),
            ...override,
          },
        });
        expect(response.statusCode).toBe(400);
        const failure = response.json() as {
          error: {
            retriable: boolean;
            action: string;
            details: { issues: Array<{ message: string }> };
          };
        };
        expect(failure.error).toMatchObject({ retriable: false, action: 'change_input' });
        expect(
          failure.error.details.issues.some(
            (issue) => issue.message === '文本不能包含 NUL 或未配对的 Unicode surrogate',
          ),
        ).toBe(true);
        expect(db.shareQueries).toBe(0);
        expect(db.inserts).toBe(0);
      }
    }
  });

  it('rejects shell metacharacters in the V1 advertised source ref before storage', async () => {
    const { app, db } = await buildRouteApp('test');
    openApps.push(app);
    for (const sourceRef of [
      'refs/heads/$(id)',
      'refs/heads/`id`',
      'refs/heads/main;echo',
      'refs/heads/main&next',
      'refs/heads/"quoted"',
      "refs/heads/'quoted'",
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/codex-agent-shares',
        headers: headers(),
        payload: { ...body('Review.', ['Review this branch.']), sourceRef },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { retriable: false, action: 'change_input' },
      });
      expect(db.shareQueries).toBe(0);
      expect(db.inserts).toBe(0);
    }
  });

  it('keeps Origin before auth and lets an anonymous holder read, but fails closed on DB tamper', async () => {
    const { app, db } = await buildRouteApp('test');
    openApps.push(app);
    const noOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/codex-agent-shares',
      headers: { 'content-type': 'application/json' },
      payload: body('Review.', ['Review this branch.']),
    });
    expect(noOrigin.statusCode).toBe(403);
    const anonymousMutation = await app.inject({
      method: 'POST',
      url: '/api/v1/codex-agent-shares',
      headers: headers(false),
      payload: body('Review.', ['Review this branch.']),
    });
    expect(anonymousMutation.statusCode).toBe(401);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/codex-agent-shares',
      headers: headers(),
      payload: body('Review.', ['Review this branch.']),
    });
    const shareUrl = new URL((created.json() as { data: { shareUrl: string } }).data.shareUrl);
    const anonymousRead = await app.inject({
      method: 'GET',
      url: `/api/v1/codex-agent-shares/${shareUrl.pathname.split('/').at(-1)}`,
    });
    expect(anonymousRead.statusCode).toBe(200);
    expect(anonymousRead.headers['cache-control']).toBe('private, no-store');
    expect(anonymousRead.headers['referrer-policy']).toBe('no-referrer');

    if (!db.row) throw new Error('expected stored share row');
    db.row.manifest = { ...db.row.manifest, description: 'tampered without digest update' };
    const tamperedRead = await app.inject({
      method: 'GET',
      url: `/api/v1/codex-agent-shares/${shareUrl.pathname.split('/').at(-1)}`,
    });
    expect(tamperedRead.statusCode).toBe(500);
    expect(tamperedRead.body).not.toContain('tampered without digest update');
  });
});
