import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../platform/http/fastify.js';
import {
  AUTH_SESSION_COOKIE_NAME,
  AUTH_SESSION_COOKIE_PRODUCTION_NAME,
  AUTH_SESSION_COOKIE_VALUE_PATTERN,
  type MeView,
} from '@cb/shared';

const serviceMocks = vi.hoisted(() => ({
  requestEmailChallenge: vi.fn(),
  verifyEmail: vi.fn(),
}));
const repoMocks = vi.hoisted(() => ({
  readMe: vi.fn(),
  revokeSession: vi.fn(),
}));

vi.mock('../modules/account/service.js', () => serviceMocks);
vi.mock('../modules/account/repo.js', () => repoMocks);

import {
  emailChallengeHandler,
  emailVerificationHandler,
  logoutHandler,
  meHandler,
} from '../modules/account/handlers.js';

const USER: MeView = {
  id: '01900000-0000-7000-8000-000000000001',
  account: 'creator-aaaaaaaa',
  email: 'Alice@example.com',
  roles: ['creator'],
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: '2026-01-01T01:00:00.000Z',
};
const SESSION = `s1.${Buffer.alloc(32, 7).toString('base64url')}`;

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function requestDouble(input: {
  body?: unknown;
  cookies?: Record<string, string>;
  auth?: FastifyRequest['auth'];
  nodeEnv?: 'test' | 'production';
  sessionCookieSecure?: boolean;
}): FastifyRequest {
  return {
    id: 'trace-account-test',
    ip: '192.0.2.10',
    body: input.body,
    cookies: input.cookies ?? {},
    auth: input.auth,
    server: {
      infra: {
        env: {
          NODE_ENV: input.nodeEnv ?? 'test',
          SESSION_COOKIE_SECURE: input.sessionCookieSecure ?? false,
          OTP_HMAC_SECRET: 'x'.repeat(32),
        },
        db: { query: vi.fn(), connect: vi.fn() },
        resend: {},
        authRateLimiter: {},
      },
    },
    log: { warn: vi.fn(), error: vi.fn() },
  } as unknown as FastifyRequest;
}

interface TestReply extends FastifyReply {
  header: ReturnType<typeof vi.fn>;
  code: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  setCookie: ReturnType<typeof vi.fn>;
  clearCookie: ReturnType<typeof vi.fn>;
}

function replyDouble(): TestReply {
  const reply = {
    header: vi.fn(),
    code: vi.fn(),
    send: vi.fn(),
    setCookie: vi.fn(),
    clearCookie: vi.fn(),
  };
  for (const method of Object.values(reply)) method.mockReturnValue(reply);
  return reply as unknown as TestReply;
}

async function run(
  factory: () => unknown,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await (factory() as Handler)(req, reply);
}

describe('first-party account handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.requestEmailChallenge.mockResolvedValue({ kind: 'accepted' });
    serviceMocks.verifyEmail.mockResolvedValue({
      kind: 'ok',
      user: USER,
      sessionCookie: SESSION,
      returnTo: '/tasks',
    });
    repoMocks.revokeSession.mockResolvedValue(undefined);
    repoMocks.readMe.mockResolvedValue({ ...USER, disabledAt: null });
  });

  it('returns the uniform 202 challenge envelope without reflecting the email', async () => {
    const req = requestDouble({ body: { email: 'Alice@example.com' } });
    const reply = replyDouble();

    await run(emailChallengeHandler, req, reply);

    expect(serviceMocks.requestEmailChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ hmacSecret: 'x'.repeat(32) }),
      expect.objectContaining({ email: 'Alice@example.com', clientAddress: '192.0.2.10' }),
    );
    expect(reply.code).toHaveBeenCalledWith(202);
    expect(reply.send).toHaveBeenCalledWith({
      data: { accepted: true, expiresInSeconds: 300, resendAfterSeconds: 60 },
      meta: { traceId: 'trace-account-test' },
    });
    expect(JSON.stringify(reply.send.mock.calls)).not.toContain('Alice@example.com');
    expect(reply.header).toHaveBeenCalledWith('cache-control', 'no-store');
  });

  it('logs only the safe dependency stage when challenge creation returns 503', async () => {
    serviceMocks.requestEmailChallenge.mockResolvedValue({
      kind: 'dependency_unavailable',
      dependencyStage: 'resend_delivery',
    });
    const req = requestDouble({ body: { email: 'Alice@example.com' } });
    const reply = replyDouble();

    await run(emailChallengeHandler, req, reply);

    expect(req.log.warn).toHaveBeenCalledWith(
      {
        code: 'DEPENDENCY_UNAVAILABLE',
        traceId: 'trace-account-test',
        operation: 'email_challenge',
        dependencyStage: 'resend_delivery',
      },
      'authentication dependency unavailable',
    );
    expect(reply.code).toHaveBeenCalledWith(503);
    const payload = (reply.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      error?: Record<string, unknown>;
    };
    expect(payload.error).not.toHaveProperty('dependencyStage');
    expect(JSON.stringify((req.log.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      'Alice@example.com',
    );
  });

  it('preserves a leading-zero code and sets the explicit HTTPS session cookie', async () => {
    const req = requestDouble({
      body: { email: 'Alice@example.com', code: '004271', returnTo: '/tasks' },
      nodeEnv: 'test',
      sessionCookieSecure: true,
    });
    const reply = replyDouble();

    await run(emailVerificationHandler, req, reply);

    expect(serviceMocks.verifyEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: '004271', returnTo: '/tasks' }),
    );
    expect(SESSION).toMatch(AUTH_SESSION_COOKIE_VALUE_PATTERN);
    expect(reply.setCookie).toHaveBeenCalledTimes(1);
    expect(reply.setCookie).toHaveBeenCalledWith(AUTH_SESSION_COOKIE_PRODUCTION_NAME, SESSION, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 604800,
    });
    expect(reply.setCookie.mock.calls[0]?.[2]).not.toHaveProperty('domain');
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({
      data: { user: USER, returnTo: '/tasks' },
      meta: { traceId: 'trace-account-test' },
    });
  });

  it('uses the local HTTP cookie when a production Test process explicitly disables Secure', async () => {
    const req = requestDouble({
      body: { email: 'Alice@example.com', code: '004271', returnTo: '/tasks' },
      nodeEnv: 'production',
      sessionCookieSecure: false,
    });
    const reply = replyDouble();

    await run(emailVerificationHandler, req, reply);

    expect(reply.setCookie).toHaveBeenCalledWith(
      AUTH_SESSION_COOKIE_NAME,
      SESSION,
      expect.objectContaining({ secure: false, path: '/' }),
    );
    expect(reply.setCookie).not.toHaveBeenCalledWith(
      AUTH_SESSION_COOKIE_PRODUCTION_NAME,
      expect.anything(),
      expect.anything(),
    );
  });

  it.each([
    ['invalid_code', 401],
    ['account_disabled', 403],
    ['dependency_unavailable', 503],
  ])('maps verification %s safely to HTTP %s without a cookie', async (kind, status) => {
    serviceMocks.verifyEmail.mockResolvedValue({ kind });
    const req = requestDouble({ body: { email: 'Alice@example.com', code: '111111' } });
    const reply = replyDouble();

    await run(emailVerificationHandler, req, reply);

    expect(reply.code).toHaveBeenCalledWith(status);
    const payload = (reply.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      error?: Record<string, unknown>;
    };
    expect(payload.error?.userMessage).toEqual(expect.any(String));
    expect(payload.error).not.toHaveProperty('code');
    expect(reply.setCookie).not.toHaveBeenCalled();
    expect(JSON.stringify(reply.send.mock.calls)).not.toContain('111111');
    expect(JSON.stringify(reply.send.mock.calls)).not.toContain('Alice@example.com');
    expect(JSON.stringify((req.log.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      '111111',
    );
    expect(JSON.stringify((req.log.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      'Alice@example.com',
    );
  });

  it('returns /me from the verified email identity and maps DB failure to 503', async () => {
    const req = requestDouble({
      auth: { userId: USER.id, account: USER.account, roles: ['creator'] },
    });
    const reply = replyDouble();
    await run(meHandler, req, reply);
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({
      data: USER,
      meta: { traceId: 'trace-account-test' },
    });

    repoMocks.readMe.mockRejectedValueOnce(new Error('database unavailable'));
    const failedReply = replyDouble();
    await run(meHandler, req, failedReply);
    expect(failedReply.code).toHaveBeenCalledWith(503);
    const failedPayload = (failedReply.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      error?: Record<string, unknown>;
    };
    expect(failedPayload.error?.userMessage).toEqual(expect.any(String));
    expect(failedPayload.error).not.toHaveProperty('code');
  });

  it('logs out idempotently, revokes a formatted cookie, then clears matching attributes', async () => {
    const req = requestDouble({
      body: {},
      cookies: { [AUTH_SESSION_COOKIE_PRODUCTION_NAME]: SESSION },
      sessionCookieSecure: true,
    });
    const reply = replyDouble();

    await run(logoutHandler, req, reply);

    expect(repoMocks.revokeSession).toHaveBeenCalledWith(
      req.server.infra.db,
      expect.any(Buffer),
      'trace-account-test',
    );
    expect(reply.clearCookie).toHaveBeenCalledWith(AUTH_SESSION_COOKIE_PRODUCTION_NAME, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    });
    expect(reply.clearCookie.mock.calls[0]?.[1]).not.toHaveProperty('domain');
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({
      data: { loggedOut: true },
      meta: { traceId: 'trace-account-test' },
    });
  });

  it('does not claim logout success or clear the cookie when PostgreSQL fails', async () => {
    repoMocks.revokeSession.mockRejectedValueOnce(new Error('database unavailable'));
    const req = requestDouble({ body: {}, cookies: { [AUTH_SESSION_COOKIE_NAME]: SESSION } });
    const reply = replyDouble();

    await run(logoutHandler, req, reply);

    expect(reply.code).toHaveBeenCalledWith(503);
    const payload = (reply.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      error?: Record<string, unknown>;
    };
    expect(payload.error?.userMessage).toEqual(expect.any(String));
    expect(payload.error).not.toHaveProperty('code');
    expect(reply.clearCookie).not.toHaveBeenCalled();
    expect(JSON.stringify(reply.send.mock.calls)).not.toContain(SESSION);
    expect(JSON.stringify((req.log.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      SESSION,
    );
  });

  it('clears a malformed or absent cookie without querying PostgreSQL', async () => {
    const req = requestDouble({
      body: {},
      cookies: { [AUTH_SESSION_COOKIE_NAME]: 'not-a-session' },
    });
    const reply = replyDouble();

    await run(logoutHandler, req, reply);

    expect(repoMocks.revokeSession).not.toHaveBeenCalled();
    expect(reply.clearCookie).toHaveBeenCalledTimes(1);
    expect(reply.code).toHaveBeenCalledWith(200);
  });
});
