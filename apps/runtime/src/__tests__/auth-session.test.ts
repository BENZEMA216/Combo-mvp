import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { AUTH_SESSION_COOKIE_NAME, AUTH_SESSION_COOKIE_PRODUCTION_NAME } from '@cb/shared';
import { authSessionDigest, resolveAuthSession } from '../platform/infra/auth-session.js';
import { requireAuth, requireSseAuth } from '../platform/middleware/auth.js';
import type { Queryable } from '../platform/infra/db.js';

const SESSION = `s1.${Buffer.alloc(32, 7).toString('base64url')}`;
const USER_ROW = {
  session_id: '01900000-0000-7000-8000-000000000010',
  user_id: '01900000-0000-7000-8000-000000000001',
  account: 'creator-aaaaaaaa',
  roles: ['creator'],
  disabled_at: null,
};

function dbWithRows(
  rows: Record<string, unknown>[],
): Queryable & { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }) };
}

function requestDouble(input: {
  db: Queryable;
  cookie?: string;
  cookies?: Record<string, string>;
  sessionCookieSecure?: boolean;
  authorization?: string;
  query?: Record<string, unknown>;
}): FastifyRequest {
  return {
    id: 'trace-runtime-auth-test',
    headers: input.authorization === undefined ? {} : { authorization: input.authorization },
    cookies: input.cookies ?? (input.cookie ? { [AUTH_SESSION_COOKIE_NAME]: input.cookie } : {}),
    query: input.query ?? {},
    server: {
      infra: {
        db: input.db,
        env: { SESSION_COOKIE_SECURE: input.sessionCookieSecure ?? false },
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

function expectSafeError(reply: ReturnType<typeof replyDouble>, status: number): void {
  expect(reply.code).toHaveBeenCalledWith(status);
  const payload = reply.send.mock.calls[0]?.[0] as { error?: Record<string, unknown> };
  expect(payload.error?.userMessage).toEqual(expect.any(String));
  expect(payload.error).not.toHaveProperty('code');
}

describe('runtime PostgreSQL opaque session resolution', () => {
  it('rejects missing and malformed cookies before querying PostgreSQL', async () => {
    const db = dbWithRows([]);

    await expect(resolveAuthSession(db, undefined)).resolves.toEqual({ kind: 'invalid' });
    await expect(resolveAuthSession(db, 'legacy.jwt.value')).resolves.toEqual({ kind: 'invalid' });

    expect(db.query).not.toHaveBeenCalled();
    expect(authSessionDigest(SESSION)).toHaveLength(32);
  });

  it('returns AuthContext only for a live local session and never queries with the raw cookie', async () => {
    const db = dbWithRows([USER_ROW]);

    await expect(resolveAuthSession(db, SESSION)).resolves.toEqual({
      kind: 'valid',
      sessionId: USER_ROW.session_id,
      context: {
        userId: USER_ROW.user_id,
        account: USER_ROW.account,
        roles: ['creator'],
      },
    });

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('FROM auth_sessions s'), [
      expect.any(Buffer),
    ]);
    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain('JOIN users u ON u.id = s.user_id');
    expect(sql).toContain('s.revoked_at IS NULL');
    expect(sql).toContain('s.expires_at > now()');
    expect(JSON.stringify(db.query.mock.calls)).not.toContain(SESSION);
  });

  it('distinguishes disabled accounts from invalid sessions', async () => {
    const disabledDb = dbWithRows([{ ...USER_ROW, disabled_at: new Date() }]);

    await expect(resolveAuthSession(disabledDb, SESSION)).resolves.toEqual({ kind: 'disabled' });
    await expect(resolveAuthSession(dbWithRows([]), SESSION)).resolves.toEqual({ kind: 'invalid' });
  });

  it('fails closed when the stored role set violates the MVP role contract', async () => {
    const db = dbWithRows([{ ...USER_ROW, roles: ['creator', 'unknown'] }]);
    await expect(resolveAuthSession(db, SESSION)).rejects.toThrow(
      'invalid roles in authenticated user row',
    );
  });
});

describe('runtime HTTP auth middleware', () => {
  it.each(['Bearer legacy-token', 'Basic legacy-credential'])(
    'rejects Authorization (%s) instead of falling back to a valid cookie',
    async (authorization) => {
      const db = dbWithRows([USER_ROW]);
      const req = requestDouble({ db, cookie: SESSION, authorization });
      const reply = replyDouble();

      await requireAuth().call(req.server, req, reply, vi.fn());

      expectSafeError(reply, 401);
      expect(db.query).not.toHaveBeenCalled();
      expect(req.auth).toBeUndefined();
      expect(JSON.stringify((req.log.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
        authorization,
      );
    },
  );

  it('rejects a query-string credential instead of accepting it alongside a valid Cookie', async () => {
    const db = dbWithRows([USER_ROW]);
    const req = requestDouble({ db, cookie: SESSION, query: { access_token: 'legacy-token' } });
    const reply = replyDouble();

    await requireAuth().call(req.server, req, reply, vi.fn());

    expectSafeError(reply, 401);
    expect(db.query).not.toHaveBeenCalled();
    expect(JSON.stringify(reply.send.mock.calls)).not.toContain('legacy-token');
    expect(JSON.stringify((req.log.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      'legacy-token',
    );
  });

  it('uses only the secure __Host- cookie when an unprefixed sibling-domain cookie is also present', async () => {
    const attacker = `s1.${Buffer.alloc(32, 8).toString('base64url')}`;
    const db = dbWithRows([USER_ROW]);
    const req = requestDouble({
      db,
      sessionCookieSecure: true,
      cookies: {
        [AUTH_SESSION_COOKIE_NAME]: attacker,
        [AUTH_SESSION_COOKIE_PRODUCTION_NAME]: SESSION,
      },
    });
    const reply = replyDouble();

    await requireAuth().call(req.server, req, reply, vi.fn());

    expect(req.auth?.userId).toBe(USER_ROW.user_id);
    expect(db.query.mock.calls[0]?.[1]).toEqual([authSessionDigest(SESSION)]);
    expect(JSON.stringify(db.query.mock.calls)).not.toContain(attacker);
  });

  it('maps a missing or malformed Cookie to 401 without querying PostgreSQL', async () => {
    for (const cookie of [undefined, 'legacy.jwt.value']) {
      const db = dbWithRows([]);
      const req = requestDouble({ db, ...(cookie ? { cookie } : {}) });
      const reply = replyDouble();

      await requireAuth().call(req.server, req, reply, vi.fn());

      expect(reply.code).toHaveBeenCalledWith(401);
      expect(db.query).not.toHaveBeenCalled();
    }
  });

  it('attaches the shared AuthContext for a valid Cookie-only request', async () => {
    const db = dbWithRows([USER_ROW]);
    const req = requestDouble({ db, cookie: SESSION });
    const reply = replyDouble();

    await requireAuth().call(req.server, req, reply, vi.fn());

    expect(req.auth).toEqual({
      userId: USER_ROW.user_id,
      account: USER_ROW.account,
      roles: ['creator'],
    });
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('maps an unknown session to 401 and a disabled account to 403', async () => {
    const unknownReq = requestDouble({ db: dbWithRows([]), cookie: SESSION });
    const disabledReq = requestDouble({
      db: dbWithRows([{ ...USER_ROW, disabled_at: new Date() }]),
      cookie: SESSION,
    });
    const unknownReply = replyDouble();
    const disabledReply = replyDouble();

    await requireAuth().call(unknownReq.server, unknownReq, unknownReply, vi.fn());
    await requireAuth().call(disabledReq.server, disabledReq, disabledReply, vi.fn());

    expectSafeError(unknownReply, 401);
    expectSafeError(disabledReply, 403);
  });

  it('maps PostgreSQL failure to 503 without exposing the database error', async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error('database unavailable')) };
    const req = requestDouble({ db, cookie: SESSION });
    const reply = replyDouble();

    await requireAuth().call(req.server, req, reply, vi.fn());

    expectSafeError(reply, 503);
    const payload = JSON.stringify(reply.send.mock.calls);
    expect(payload).not.toContain('database unavailable');
    expect(payload).not.toContain(SESSION);
  });
});

describe('runtime SSE auth middleware', () => {
  it.each([{ token: '' }, { access_token: 'legacy-token' }])(
    'rejects query credentials before opening a stream: %o',
    async (query) => {
      const db = dbWithRows([USER_ROW]);
      const req = requestDouble({ db, cookie: SESSION, query });
      const reply = replyDouble();

      await requireSseAuth().call(req.server, req, reply, vi.fn());

      expectSafeError(reply, 401);
      expect(db.query).not.toHaveBeenCalled();
      expect(req.auth).toBeUndefined();
      expect(JSON.stringify(reply.send.mock.calls)).not.toContain('legacy-token');
      expect(JSON.stringify((req.log.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
        'legacy-token',
      );
    },
  );

  it('rejects an Authorization header before opening a stream', async () => {
    const db = dbWithRows([USER_ROW]);
    const req = requestDouble({
      db,
      cookie: SESSION,
      authorization: 'Bearer legacy-token',
    });
    const reply = replyDouble();

    await requireSseAuth().call(req.server, req, reply, vi.fn());

    expect(reply.code).toHaveBeenCalledWith(401);
    expect(db.query).not.toHaveBeenCalled();
    expect(req.auth).toBeUndefined();
    expect(JSON.stringify((req.log.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      'legacy-token',
    );
  });

  it('uses the same PostgreSQL Cookie session for a new SSE connection', async () => {
    const db = dbWithRows([USER_ROW]);
    const req = requestDouble({ db, cookie: SESSION });
    const reply = replyDouble();

    await requireSseAuth().call(req.server, req, reply, vi.fn());

    expect(req.auth?.userId).toBe(USER_ROW.user_id);
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('preserves the 403 and 503 distinctions before creating an SSE response', async () => {
    const disabledReq = requestDouble({
      db: dbWithRows([{ ...USER_ROW, disabled_at: new Date() }]),
      cookie: SESSION,
    });
    const failedReq = requestDouble({
      db: { query: vi.fn().mockRejectedValue(new Error('database unavailable')) },
      cookie: SESSION,
    });
    const disabledReply = replyDouble();
    const failedReply = replyDouble();

    await requireSseAuth().call(disabledReq.server, disabledReq, disabledReply, vi.fn());
    await requireSseAuth().call(failedReq.server, failedReq, failedReply, vi.fn());

    expectSafeError(disabledReply, 403);
    expectSafeError(failedReply, 503);
  });
});
