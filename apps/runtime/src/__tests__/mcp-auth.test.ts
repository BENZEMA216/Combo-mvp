import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InfraContext } from '../platform/infra/index.js';
import type { Queryable } from '../platform/infra/db.js';
import { resolveMcpAccessToken } from '../platform/infra/mcp-access-token.js';
import { requireMcpAuth } from '../platform/middleware/mcp-auth.js';
import { registerInternalMcpRuntimeRoutes } from '../bootstrap/internal-mcp-routes.js';

const ORIGIN = 'https://test.example';
const TOKEN = `mat1.${'a'.repeat(43)}`;
const AUTHORIZATION = `Bearer ${TOKEN}`;
const USER_ROW = {
  owner_user_id: '00000000-0000-4000-8000-000000000001',
  account: 'creator-aaaaaaaa',
  roles: ['creator'],
  disabled_at: null,
  scope: 'combo.agent:read combo.agent:write',
};

function dbWithToken(scope = USER_ROW.scope): Queryable & { query: ReturnType<typeof vi.fn> } {
  return {
    query: vi.fn(async (sql: string) => ({
      rows: sql.includes('FROM oauth_access_tokens') ? [{ ...USER_ROW, scope }] : [],
      rowCount: sql.includes('FROM oauth_access_tokens') ? 1 : 0,
    })),
  } as unknown as Queryable & { query: ReturnType<typeof vi.fn> };
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('Runtime MCP access-token boundary', () => {
  it('validates digest, exact resource, expiry query and returns typed scopes', async () => {
    const db = dbWithToken();
    await expect(resolveMcpAccessToken(db, AUTHORIZATION, ORIGIN)).resolves.toEqual({
      kind: 'valid',
      context: {
        userId: USER_ROW.owner_user_id,
        account: USER_ROW.account,
        roles: ['creator'],
      },
      scopes: ['combo.agent:read', 'combo.agent:write'],
    });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringMatching(
        /resource_uri = \$2[\s\S]+revoked_at IS NULL[\s\S]+expires_at > now\(\)/,
      ),
      [createHash('sha256').update(TOKEN, 'ascii').digest(), `${ORIGIN}/api/external-mcp/mcp`],
    );
    expect(JSON.stringify(db.query.mock.calls)).not.toContain(TOKEN);
  });

  it('rejects malformed tokens before PostgreSQL and fails closed on invalid stored scopes', async () => {
    const db = dbWithToken();
    await expect(resolveMcpAccessToken(db, 'Bearer legacy-token', ORIGIN)).resolves.toEqual({
      kind: 'invalid',
    });
    expect(db.query).not.toHaveBeenCalled();
    await expect(
      resolveMcpAccessToken(dbWithToken('combo.agent:admin'), AUTHORIZATION, ORIGIN),
    ).resolves.toEqual({ kind: 'invalid' });
  });

  it('enforces read and write scopes independently in middleware', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    app.decorate('infra', {
      db: dbWithToken('combo.agent:read'),
      env: { EXTERNAL_MCP_PUBLIC_ORIGIN: ORIGIN },
    } as unknown as InfraContext);
    app.get('/read', { preHandler: requireMcpAuth('combo.agent:read') }, async () => ({
      ok: true,
    }));
    app.post('/write', { preHandler: requireMcpAuth('combo.agent:write') }, async () => ({
      ok: true,
    }));

    const read = await app.inject({
      method: 'GET',
      url: '/read',
      headers: { authorization: AUTHORIZATION },
    });
    expect(read.statusCode).toBe(200);
    const write = await app.inject({
      method: 'POST',
      url: '/write',
      headers: { authorization: AUTHORIZATION },
    });
    expect(write.statusCode).toBe(403);
    expect((write.json() as { error: Record<string, unknown> }).error).not.toHaveProperty('code');
  });

  it('binds actual internal mutation routes to write scope and reads to read scope', async () => {
    let scope = 'combo.agent:read';
    const db = {
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes('FROM oauth_access_tokens') ? [{ ...USER_ROW, scope }] : [],
        rowCount: sql.includes('FROM oauth_access_tokens') ? 1 : 0,
      })),
    };
    const app = Fastify({ logger: false });
    apps.push(app);
    app.decorate('infra', {
      db,
      env: { EXTERNAL_MCP_PUBLIC_ORIGIN: ORIGIN },
      objectStore: {},
    } as unknown as InfraContext);
    await registerInternalMcpRuntimeRoutes(app);

    const deniedMutation = await app.inject({
      method: 'POST',
      url: '/internal/mcp/studio/sessions',
      headers: { authorization: AUTHORIZATION },
      payload: { capabilityId: '00000000-0000-4000-8000-000000000010' },
    });
    expect(deniedMutation.statusCode).toBe(403);

    const allowedRead = await app.inject({
      method: 'GET',
      url: '/internal/mcp/artifacts/00000000-0000-4000-8000-000000000011/content',
      headers: { authorization: AUTHORIZATION },
    });
    expect(allowedRead.statusCode).toBe(404);

    scope = 'combo.agent:read combo.agent:write';
    const admittedMutation = await app.inject({
      method: 'POST',
      url: '/internal/mcp/studio/sessions',
      headers: { authorization: AUTHORIZATION },
      payload: { capabilityId: '00000000-0000-4000-8000-000000000010' },
    });
    expect(admittedMutation.statusCode).not.toBe(403);
  });
});
