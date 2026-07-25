import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const oidcMocks = vi.hoisted(() => ({
  buildLogoutUrl: vi.fn(),
  exchangeCodeForToken: vi.fn(),
  readNonceFromIdToken: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

const logtoMocks = vi.hoisted(() => ({
  verifyLogtoIdToken: vi.fn(),
  verifyLogtoJwt: vi.fn(),
}));

const repoMocks = vi.hoisted(() => ({
  provisionUser: vi.fn(),
  readMe: vi.fn(),
}));

vi.mock('../platform/infra/logto-oidc.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ...oidcMocks };
});

vi.mock('../platform/infra/logto.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ...logtoMocks };
});

vi.mock('../modules/account/repo.js', () => repoMocks);

import {
  AUTH_TX_COOKIE,
  callbackHandler,
  logoutHandler,
  REFRESH_COOKIE,
  refreshHandler,
} from '../modules/account/handlers.js';
import { SESSION_COOKIE } from '../platform/middleware/auth.js';

type TestHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function requestDouble(
  input: {
    cookies?: Record<string, string>;
    query?: Record<string, string>;
    nodeEnv?: 'development' | 'test' | 'production';
    comboEnvironment?: string;
  } = {},
): FastifyRequest {
  return {
    id: 'trace-auth-test',
    cookies: input.cookies ?? {},
    query: input.query ?? {},
    server: {
      infra: {
        env: {
          NODE_ENV: input.nodeEnv ?? 'production',
          COMBO_ENVIRONMENT:
            input.comboEnvironment ?? (input.nodeEnv === 'test' ? 'test' : 'production'),
        },
        db: {},
      },
    },
    log: {
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as FastifyRequest;
}

function replyDouble(): FastifyReply & {
  setCookie: ReturnType<typeof vi.fn>;
  clearCookie: ReturnType<typeof vi.fn>;
  code: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  redirect: ReturnType<typeof vi.fn>;
} {
  const reply = {
    setCookie: vi.fn(),
    clearCookie: vi.fn(),
    code: vi.fn(),
    send: vi.fn(),
    redirect: vi.fn(),
  };
  for (const method of Object.values(reply)) method.mockReturnValue(reply);
  return reply as unknown as ReturnType<typeof replyDouble>;
}

async function run(
  handler: ReturnType<typeof refreshHandler>,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await (handler as unknown as TestHandler)(req, reply);
}

describe('account refresh-token handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    oidcMocks.buildLogoutUrl.mockResolvedValue(null);
    oidcMocks.readNonceFromIdToken.mockReturnValue('nonce-1');
    logtoMocks.verifyLogtoIdToken.mockResolvedValue({ kind: 'ok', token: { sub: 'user-1' } });
    logtoMocks.verifyLogtoJwt.mockResolvedValue({
      kind: 'ok',
      token: {
        sub: 'user-1',
        account: 'creator',
        email: 'creator@example.com',
        roles: ['creator'],
      },
    });
    repoMocks.provisionUser.mockResolvedValue({ id: 'user-db-1' });
  });

  it('callback stores refresh_token in a separate narrowed secure cookie', async () => {
    oidcMocks.exchangeCodeForToken.mockResolvedValue({
      kind: 'ok',
      accessToken: 'access-1',
      idToken: 'id-1',
      refreshToken: 'refresh-1',
    });
    const req = requestDouble({
      cookies: {
        [AUTH_TX_COOKIE]: JSON.stringify({
          state: 'state-1',
          nonce: 'nonce-1',
          codeVerifier: 'verifier-1',
          returnTo: '/tasks',
        }),
      },
      query: { code: 'code-1', state: 'state-1' },
    });
    const reply = replyDouble();

    await (callbackHandler() as unknown as TestHandler)(req, reply);

    expect(reply.setCookie).toHaveBeenCalledWith(
      SESSION_COOKIE,
      'access-1',
      expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' }),
    );
    expect(reply.setCookie).toHaveBeenCalledWith(
      REFRESH_COOKIE,
      'refresh-1',
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/api/v1/auth',
      }),
    );
    expect(reply.redirect).toHaveBeenCalledWith('/tasks', 302);
  });

  it('keeps Preview cookies Secure when its API process uses development mode', async () => {
    oidcMocks.exchangeCodeForToken.mockResolvedValue({
      kind: 'ok',
      accessToken: 'access-preview',
      refreshToken: 'refresh-preview',
    });
    const req = requestDouble({
      nodeEnv: 'development',
      comboEnvironment: 'preview',
      cookies: {
        [AUTH_TX_COOKIE]: JSON.stringify({
          state: 'state-1',
          nonce: 'nonce-1',
          codeVerifier: 'verifier-1',
          returnTo: '/tasks',
        }),
      },
      query: { code: 'code-1', state: 'state-1' },
    });
    const reply = replyDouble();

    await (callbackHandler() as unknown as TestHandler)(req, reply);

    expect(reply.setCookie).toHaveBeenCalledWith(
      SESSION_COOKIE,
      'access-preview',
      expect.objectContaining({ secure: true }),
    );
    expect(reply.setCookie).toHaveBeenCalledWith(
      REFRESH_COOKIE,
      'refresh-preview',
      expect.objectContaining({ secure: true }),
    );
  });

  it('revalidates a forged auth transaction returnTo before callback redirect', async () => {
    oidcMocks.exchangeCodeForToken.mockResolvedValue({
      kind: 'ok',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
    });
    const req = requestDouble({
      cookies: {
        [AUTH_TX_COOKIE]: JSON.stringify({
          state: 'state-1',
          nonce: 'nonce-1',
          codeVerifier: 'verifier-1',
          returnTo: '/%252f%252fevil.example/phish',
        }),
      },
      query: { code: 'code-1', state: 'state-1' },
    });
    const reply = replyDouble();

    await (callbackHandler() as unknown as TestHandler)(req, reply);

    expect(reply.redirect).toHaveBeenCalledWith('/tasks', 302);
  });

  it('returns 401 without a clearing Set-Cookie when the refresh cookie is missing', async () => {
    const req = requestDouble();
    const reply = replyDouble();

    await run(refreshHandler(), req, reply);

    expect(oidcMocks.refreshAccessToken).not.toHaveBeenCalled();
    expect(reply.clearCookie).not.toHaveBeenCalled();
    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it('does not clear cookies when the token endpoint rejects an old refresh token', async () => {
    oidcMocks.refreshAccessToken.mockResolvedValue({ kind: 'invalid_grant' });
    const req = requestDouble({ cookies: { [REFRESH_COOKIE]: 'refresh-secret' } });
    const reply = replyDouble();

    await run(refreshHandler(), req, reply);

    expect(reply.clearCookie).not.toHaveBeenCalled();
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(JSON.stringify(reply.send.mock.calls)).not.toContain('refresh-secret');
  });

  it('preserves both cookies when the token endpoint is temporarily unavailable', async () => {
    oidcMocks.refreshAccessToken.mockResolvedValue({ kind: 'upstream_unavailable' });
    const req = requestDouble({ cookies: { [REFRESH_COOKIE]: 'refresh-secret' } });
    const reply = replyDouble();

    await run(refreshHandler(), req, reply);

    expect(reply.clearCookie).not.toHaveBeenCalled();
    expect(reply.setCookie).not.toHaveBeenCalled();
    expect(reply.code).toHaveBeenCalledWith(503);
    expect(JSON.stringify(reply.send.mock.calls)).not.toContain('refresh-secret');
  });

  it('keeps a rotated refresh token when JWKS is unavailable without writing unverified access', async () => {
    oidcMocks.refreshAccessToken.mockResolvedValue({
      kind: 'ok',
      accessToken: 'unverified-access',
      refreshToken: 'refresh-rotated',
    });
    logtoMocks.verifyLogtoJwt.mockResolvedValue({ kind: 'upstream_unavailable' });
    const req = requestDouble({ cookies: { [REFRESH_COOKIE]: 'refresh-old' } });
    const reply = replyDouble();

    await run(refreshHandler(), req, reply);

    expect(reply.setCookie).toHaveBeenCalledTimes(1);
    expect(reply.setCookie).toHaveBeenCalledWith(
      REFRESH_COOKIE,
      'refresh-rotated',
      expect.objectContaining({ path: '/api/v1/auth', secure: true, httpOnly: true }),
    );
    expect(reply.setCookie).not.toHaveBeenCalledWith(
      SESSION_COOKIE,
      expect.anything(),
      expect.anything(),
    );
    expect(reply.clearCookie).not.toHaveBeenCalled();
    expect(reply.code).toHaveBeenCalledWith(503);
    expect(JSON.stringify(reply.send.mock.calls)).not.toContain('unverified-access');
    expect(JSON.stringify(reply.send.mock.calls)).not.toContain('refresh-rotated');
  });

  it.each([
    ['refresh-2', 'refresh-2'],
    [null, 'refresh-1'],
  ])(
    'verifies access token, rotates safely, and returns 204 (new=%s)',
    async (rotated, expected) => {
      oidcMocks.refreshAccessToken.mockResolvedValue({
        kind: 'ok',
        accessToken: 'access-2',
        refreshToken: rotated,
      });
      const req = requestDouble({ cookies: { [REFRESH_COOKIE]: 'refresh-1' } });
      const reply = replyDouble();

      await run(refreshHandler(), req, reply);

      expect(logtoMocks.verifyLogtoJwt).toHaveBeenCalledWith('access-2', req.server.infra.env);
      expect(reply.setCookie).toHaveBeenCalledWith(
        SESSION_COOKIE,
        'access-2',
        expect.objectContaining({ path: '/', secure: true, httpOnly: true, sameSite: 'lax' }),
      );
      expect(reply.setCookie).toHaveBeenCalledWith(
        REFRESH_COOKIE,
        expected,
        expect.objectContaining({
          path: '/api/v1/auth',
          secure: true,
          httpOnly: true,
          sameSite: 'lax',
        }),
      );
      expect(reply.code).toHaveBeenCalledWith(204);
      expect(reply.send).toHaveBeenCalledWith();
    },
  );

  it('keeps a rotated token and returns 503 when new access verification is temporarily invalid', async () => {
    oidcMocks.refreshAccessToken.mockResolvedValue({
      kind: 'ok',
      accessToken: 'invalid-access',
      refreshToken: 'rotated-secret',
    });
    logtoMocks.verifyLogtoJwt.mockResolvedValue({ kind: 'invalid' });
    const req = requestDouble({ cookies: { [REFRESH_COOKIE]: 'refresh-secret' } });
    const reply = replyDouble();

    await run(refreshHandler(), req, reply);

    expect(reply.setCookie).toHaveBeenCalledWith(
      REFRESH_COOKIE,
      'rotated-secret',
      expect.objectContaining({ path: '/api/v1/auth', secure: true, httpOnly: true }),
    );
    expect(reply.setCookie).not.toHaveBeenCalledWith(
      SESSION_COOKIE,
      expect.anything(),
      expect.anything(),
    );
    expect(reply.clearCookie).not.toHaveBeenCalled();
    expect(reply.code).toHaveBeenCalledWith(503);
    expect(JSON.stringify(reply.send.mock.calls)).not.toContain('rotated-secret');
  });

  it('logout clears both access and refresh cookies with their matching paths', async () => {
    const req = requestDouble();
    const reply = replyDouble();

    await (logoutHandler() as unknown as TestHandler)(req, reply);

    expect(reply.clearCookie).toHaveBeenCalledWith(
      SESSION_COOKIE,
      expect.objectContaining({ path: '/' }),
    );
    expect(reply.clearCookie).toHaveBeenCalledWith(
      REFRESH_COOKIE,
      expect.objectContaining({ path: '/api/v1/auth' }),
    );
    expect(oidcMocks.buildLogoutUrl).toHaveBeenCalledWith(req.server.infra.env);
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({
      data: { loggedOut: true },
      meta: { traceId: 'trace-auth-test' },
    });
  });

  it('logout returns the upstream end-session URL in the success envelope when available', async () => {
    const logoutUrl =
      'https://tenant.logto.app/oidc/session/end?client_id=app-id&post_logout_redirect_uri=https%3A%2F%2Fcombo.example%2Flogin';
    oidcMocks.buildLogoutUrl.mockResolvedValue(logoutUrl);
    const req = requestDouble();
    const reply = replyDouble();

    await (logoutHandler() as unknown as TestHandler)(req, reply);

    expect(oidcMocks.buildLogoutUrl).toHaveBeenCalledWith(req.server.infra.env);
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({
      data: { loggedOut: true, logoutUrl },
      meta: { traceId: 'trace-auth-test' },
    });
  });
});
