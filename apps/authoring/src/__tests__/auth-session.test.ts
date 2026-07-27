import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { AUTH_SESSION_COOKIE_NAME, AUTH_SESSION_COOKIE_PRODUCTION_NAME } from '@cb/shared';
import { authSessionDigest, resolveAuthSession } from '../platform/infra/auth-session.js';
import { requireAuth, requireSseAuth } from '../platform/middleware/auth.js';
import type { Queryable } from '../platform/infra/db.js';

const SESSION = `s1.${Buffer.alloc(32, 3).toString('base64url')}`;

function dbWithRows(
  rows: Record<string, unknown>[],
): Queryable & { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }) };
}

function requestDouble(input: {
  db: Queryable;
  cookie?: string;
  cookies?: Record<string, string>;
  nodeEnv?: 'test' | 'production';
  sessionCookieSecure?: boolean;
  authorization?: string;
  query?: Record<string, unknown>;
}): FastifyRequest {
  return {
    id: 'trace-session-test',
    headers: input.authorization ? { authorization: input.authorization } : {},
    cookies: input.cookies ?? (input.cookie ? { [AUTH_SESSION_COOKIE_NAME]: input.cookie } : {}),
    query: input.query ?? {},
    server: {
      infra: {
        db: input.db,
        env: {
          NODE_ENV: input.nodeEnv ?? 'test',
          SESSION_COOKIE_SECURE: input.sessionCookieSecure ?? false,
        },
      },
    },
    log: { warn: vi.fn() },
  } as unknown as FastifyRequest;
}

function replyDouble(): FastifyReply & {
  code: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const reply = { code: vi.fn(), send: vi.fn() };
  reply.code.mockReturnValue(reply);
  reply.send.mockReturnValue(reply);
  return reply as unknown as ReturnType<typeof replyDouble>;
}

describe('PostgreSQL opaque session resolution', () => {
  it('rejects missing or malformed cookies before querying PostgreSQL', async () => {
    const db = dbWithRows([]);
    await expect(resolveAuthSession(db, undefined)).resolves.toEqual({ kind: 'invalid' });
    await expect(resolveAuthSession(db, 'Bearer old-token')).resolves.toEqual({ kind: 'invalid' });
    expect(db.query).not.toHaveBeenCalled();
    expect(authSessionDigest(SESSION)).toHaveLength(32);
  });

  it('returns the internal user context only for a live local session', async () => {
    const db = dbWithRows([
      {
        session_id: '01900000-0000-7000-8000-000000000010',
        user_id: '01900000-0000-7000-8000-000000000001',
        account: 'creator-aaaaaaaa',
        roles: ['creator'],
        disabled_at: null,
      },
    ]);

    await expect(resolveAuthSession(db, SESSION)).resolves.toEqual({
      kind: 'valid',
      sessionId: '01900000-0000-7000-8000-000000000010',
      context: {
        userId: '01900000-0000-7000-8000-000000000001',
        account: 'creator-aaaaaaaa',
        roles: ['creator'],
      },
    });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('s.revoked_at IS NULL'), [
      expect.any(Buffer),
    ]);
    expect(db.query.mock.calls[0]?.[0]).toContain('s.expires_at > now()');
    expect(JSON.stringify(db.query.mock.calls)).not.toContain(SESSION);
  });

  it('distinguishes a disabled account from an invalid session', async () => {
    const disabled = dbWithRows([
      {
        session_id: 'session-id',
        user_id: 'user-id',
        account: 'creator-aaaaaaaa',
        roles: ['creator'],
        disabled_at: new Date(),
      },
    ]);
    await expect(resolveAuthSession(disabled, SESSION)).resolves.toEqual({ kind: 'disabled' });
    await expect(resolveAuthSession(dbWithRows([]), SESSION)).resolves.toEqual({ kind: 'invalid' });
  });
});

describe('authoring auth middleware', () => {
  it('rejects any Authorization header instead of falling back to a valid cookie', async () => {
    const db = dbWithRows([
      {
        session_id: 'session-id',
        user_id: 'user-id',
        account: 'creator-aaaaaaaa',
        roles: ['creator'],
        disabled_at: null,
      },
    ]);
    const req = requestDouble({ db, cookie: SESSION, authorization: 'Bearer legacy-token' });
    const reply = replyDouble();

    await requireAuth().call(req.server, req, reply, vi.fn());

    expect(reply.code).toHaveBeenCalledWith(401);
    expect(db.query).not.toHaveBeenCalled();
    expect(req.auth).toBeUndefined();
    expect(JSON.stringify((req.log.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      'legacy-token',
    );
  });

  it('rejects query-string credentials on ordinary protected requests', async () => {
    const db = dbWithRows([
      {
        session_id: 'session-id',
        user_id: 'user-id',
        account: 'creator-aaaaaaaa',
        roles: ['creator'],
        disabled_at: null,
      },
    ]);
    const req = requestDouble({ db, cookie: SESSION, query: { token: 'legacy-token' } });
    const reply = replyDouble();

    await requireAuth().call(req.server, req, reply, vi.fn());

    expect(reply.code).toHaveBeenCalledWith(401);
    expect(db.query).not.toHaveBeenCalled();
    expect(JSON.stringify(reply.send.mock.calls)).not.toContain('legacy-token');
    expect(JSON.stringify((req.log.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      'legacy-token',
    );
  });

  it('ignores a tossable legacy/domain cookie and uses only the __Host- cookie in production', async () => {
    const attacker = `s1.${Buffer.alloc(32, 9).toString('base64url')}`;
    const db = dbWithRows([
      {
        session_id: 'session-id',
        user_id: 'user-id',
        account: 'creator-aaaaaaaa',
        roles: ['creator'],
        disabled_at: null,
      },
    ]);
    const req = requestDouble({
      db,
      nodeEnv: 'production',
      sessionCookieSecure: true,
      cookies: {
        [AUTH_SESSION_COOKIE_NAME]: attacker,
        [AUTH_SESSION_COOKIE_PRODUCTION_NAME]: SESSION,
      },
    });
    const reply = replyDouble();

    await requireAuth().call(req.server, req, reply, vi.fn());

    expect(req.auth?.userId).toBe('user-id');
    expect(db.query.mock.calls[0]?.[1]).toEqual([authSessionDigest(SESSION)]);
    expect(JSON.stringify(db.query.mock.calls)).not.toContain(attacker);

    const legacyOnlyDb = dbWithRows([]);
    const legacyOnly = requestDouble({
      db: legacyOnlyDb,
      nodeEnv: 'production',
      sessionCookieSecure: true,
      cookies: { [AUTH_SESSION_COOKIE_NAME]: attacker },
    });
    await requireAuth().call(legacyOnly.server, legacyOnly, replyDouble(), vi.fn());
    expect(legacyOnlyDb.query).not.toHaveBeenCalled();
  });

  it('maps PostgreSQL failure to 503 rather than pretending the session is invalid', async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error('database unavailable')) };
    const req = requestDouble({ db, cookie: SESSION });
    const reply = replyDouble();

    await requireAuth().call(req.server, req, reply, vi.fn());

    expect(reply.code).toHaveBeenCalledWith(503);
  });

  it('rejects SSE query credentials before opening a stream', async () => {
    const db = dbWithRows([]);
    const req = requestDouble({ db, cookie: SESSION, query: { access_token: 'legacy-token' } });
    const reply = replyDouble();

    await requireSseAuth().call(req.server, req, reply, vi.fn());

    expect(reply.code).toHaveBeenCalledWith(401);
    expect(db.query).not.toHaveBeenCalled();
    expect(JSON.stringify(reply.send.mock.calls)).not.toContain('legacy-token');
    expect(JSON.stringify((req.log.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      'legacy-token',
    );
  });
});
