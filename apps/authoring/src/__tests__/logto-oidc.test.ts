import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../platform/config/env.js';
import {
  buildAuthorizeUrl,
  buildLogoutUrl,
  clearRefreshTokenExchangeCache,
  exchangeCodeForToken,
  refreshAccessToken,
  sanitizeReturnTo,
} from '../platform/infra/logto-oidc.js';

const env = {
  NODE_ENV: 'production',
  LOGTO_ISSUER: 'https://tenant.logto.app/oidc',
  LOGTO_APP_ID: 'app-id',
  LOGTO_APP_SECRET: 'app-secret',
  LOGTO_REDIRECT_URI: 'https://combo.example/api/v1/auth/callback',
  LOGTO_AUDIENCE: 'https://api.combo.example',
} as Env;

const discovery = {
  issuer: env.LOGTO_ISSUER,
  authorization_endpoint: 'https://tenant.logto.app/oidc/auth',
  token_endpoint: 'https://tenant.logto.app/oidc/token',
};

describe('OIDC returnTo normalization', () => {
  it('keeps a same-origin Task path and drops the fragment', () => {
    expect(sanitizeReturnTo('/tasks/01982e62-6d6e-7f4d-8fe8-b55f62720b5b?tab=history#token')).toBe(
      '/tasks/01982e62-6d6e-7f4d-8fe8-b55f62720b5b?tab=history',
    );
  });

  it.each([
    'https://evil.example/phish',
    '//evil.example/phish',
    '/\\evil.example/phish',
    '/%5cevil.example/phish',
    '/%2f%2fevil.example/phish',
    '/%252f%252fevil.example/phish',
    '/tasks/%0aLocation:https://evil.example',
    '/broken/%',
  ])('falls back for hostile or malformed returnTo %s', (returnTo) => {
    expect(sanitizeReturnTo(returnTo)).toBe('/tasks');
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Logto OIDC refresh-token flow', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearRefreshTokenExchangeCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    clearRefreshTokenExchangeCache();
    vi.unstubAllGlobals();
  });

  it('authorization URL always requests offline_access and consent', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(discovery));

    const raw = await buildAuthorizeUrl({
      env,
      state: 'state-1',
      nonce: 'nonce-1',
      codeChallenge: 'challenge-1',
      // none 不得取消 consent；合法的 login 仍应保留。
      prompt: 'none login login',
    });

    expect(raw).not.toBeNull();
    const url = new URL(raw!);
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([
      'openid',
      'profile',
      'email',
      'roles',
      'offline_access',
    ]);
    expect(url.searchParams.get('prompt')).toBe('login consent');
    expect(url.searchParams.get('resource')).toBe(env.LOGTO_AUDIENCE);
  });

  it('allows a 4.6s cold OIDC discovery response', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementationOnce(
        (_url: string | URL, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            const responseTimer = setTimeout(() => resolve(jsonResponse(discovery)), 4_600);
            init?.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(responseTimer);
                reject(new DOMException('aborted', 'AbortError'));
              },
              { once: true },
            );
          }),
      );

      const pending = buildAuthorizeUrl({
        env,
        state: 'state-cold',
        nonce: 'nonce-cold',
        codeChallenge: 'challenge-cold',
        prompt: 'login',
      });
      await vi.advanceTimersByTimeAsync(4_600);

      await expect(pending).resolves.toContain(discovery.authorization_endpoint);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('builds a trusted HTTPS logout URL with the client and canonical in-app return', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ...discovery,
        end_session_endpoint: 'https://tenant.logto.app/oidc/session/end?existing=kept',
      }),
    );

    const raw = await buildLogoutUrl(env);

    expect(raw).not.toBeNull();
    const url = new URL(raw!);
    expect(url.protocol).toBe('https:');
    expect(url.searchParams.get('existing')).toBe('kept');
    expect(url.searchParams.get('client_id')).toBe(env.LOGTO_APP_ID);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://combo.example/login');
  });

  it('allows same-origin HTTP discovery endpoints outside production', async () => {
    const testEnv = {
      ...env,
      NODE_ENV: 'test',
      LOGTO_ISSUER: 'http://logto.internal:3001/oidc',
    } as Env;
    const testDiscovery = {
      issuer: testEnv.LOGTO_ISSUER,
      authorization_endpoint: 'http://logto.internal:3001/oidc/auth',
      token_endpoint: 'http://logto.internal:3001/oidc/token',
      end_session_endpoint: 'http://logto.internal:3001/oidc/session/end',
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(testDiscovery))
      .mockResolvedValueOnce(jsonResponse(testDiscovery));

    const authorizeUrl = await buildAuthorizeUrl({
      env: testEnv,
      state: 'state-test',
      nonce: 'nonce-test',
      codeChallenge: 'challenge-test',
    });
    const logoutUrl = await buildLogoutUrl(testEnv);

    expect(authorizeUrl).toMatch(/^http:\/\/logto\.internal:3001\/oidc\/auth\?/);
    expect(logoutUrl).toMatch(/^http:\/\/logto\.internal:3001\/oidc\/session\/end\?/);
  });

  it('rejects a discovery issuer that differs from the configured issuer', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ...discovery,
        issuer: 'https://tenant.logto.app/a-different-issuer',
      }),
    );

    await expect(
      buildAuthorizeUrl({
        env,
        state: 'state-mismatch',
        nonce: 'nonce-mismatch',
        codeChallenge: 'challenge-mismatch',
      }),
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    'not a valid URL',
    'javascript:alert(document.domain)',
    'https://attacker.example/oidc/auth',
    'https://user:password@tenant.logto.app/oidc/auth',
    'http://tenant.logto.app/oidc/auth',
  ])('fails closed for an untrusted authorization endpoint %s', async (authorizationEndpoint) => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...discovery, authorization_endpoint: authorizationEndpoint }),
    );

    await expect(
      buildAuthorizeUrl({
        env,
        state: 'state-hostile',
        nonce: 'nonce-hostile',
        codeChallenge: 'challenge-hostile',
      }),
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not contact an HTTP issuer when process hardening is production', async () => {
    const insecureProductionEnv = {
      ...env,
      LOGTO_ISSUER: 'http://tenant.logto.app/oidc',
    } as Env;

    await expect(
      buildAuthorizeUrl({
        env: insecureProductionEnv,
        state: 'state-http',
        nonce: 'nonce-http',
        codeChallenge: 'challenge-http',
      }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'not a valid URL',
    'javascript:alert(document.domain)',
    'https://attacker.example/oidc/token',
    'https://user:password@tenant.logto.app/oidc/token',
    'http://tenant.logto.app/oidc/token',
  ])(
    'never posts an authorization code, refresh token, or client secret to %s',
    async (tokenEndpoint) => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(jsonResponse({ ...discovery, token_endpoint: tokenEndpoint })),
      );

      await expect(
        exchangeCodeForToken(env, 'sensitive-code', 'sensitive-verifier'),
      ).resolves.toEqual({ kind: 'upstream_unavailable' });
      await expect(refreshAccessToken(env, 'sensitive-refresh-token')).resolves.toEqual({
        kind: 'upstream_unavailable',
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const [url, init] of fetchMock.mock.calls as [string, RequestInit][]) {
        expect(url).toBe('https://tenant.logto.app/oidc/.well-known/openid-configuration');
        expect(init.method).toBeUndefined();
        expect(init.redirect).toBe('error');
        expect(init.body).toBeUndefined();
      }
    },
  );

  it.each([
    'javascript:alert(document.domain)',
    'data:text/html,logged-out',
    'ftp://tenant.logto.app/oidc/session/end',
    'https://attacker.example/oidc/session/end',
    'https://user:password@tenant.logto.app/oidc/session/end',
    'http://tenant.logto.app/oidc/session/end',
    'not a valid URL',
  ])('rejects unsafe or invalid logout endpoint %s', async (endSessionEndpoint) => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...discovery, end_session_endpoint: endSessionEndpoint }),
    );

    await expect(buildLogoutUrl(env)).resolves.toBeNull();
  });

  it('authorization-code exchange accepts and returns refresh_token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(discovery)).mockResolvedValueOnce(
      jsonResponse({
        access_token: 'access-1',
        id_token: 'id-1',
        refresh_token: 'refresh-1',
      }),
    );

    await expect(exchangeCodeForToken(env, 'code-1', 'verifier-1')).resolves.toEqual({
      kind: 'ok',
      accessToken: 'access-1',
      idToken: 'id-1',
      refreshToken: 'refresh-1',
    });

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = new URLSearchParams(String(init.body));
    expect(init.redirect).toBe('error');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('resource')).toBe(env.LOGTO_AUDIENCE);
  });

  it('refresh grant sends the HttpOnly-held token and returns the rotated token', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(discovery))
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'access-2', refresh_token: 'refresh-2' }),
      );

    await expect(refreshAccessToken(env, 'refresh-1')).resolves.toEqual({
      kind: 'ok',
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
    });

    const [tokenUrl, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = new URLSearchParams(String(init.body));
    expect(tokenUrl).toBe(discovery.token_endpoint);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-1');
    expect(body.get('client_id')).toBe(env.LOGTO_APP_ID);
    expect(body.get('client_secret')).toBe(env.LOGTO_APP_SECRET);
    expect(body.get('resource')).toBe(env.LOGTO_AUDIENCE);
  });

  it('marks absent rotation token as null so the handler can retain the previous token', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(discovery))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'access-2' }));

    await expect(refreshAccessToken(env, 'refresh-1')).resolves.toEqual({
      kind: 'ok',
      accessToken: 'access-2',
      refreshToken: null,
    });
  });

  it('single-flights concurrent refreshes and reuses the rotated result during the grace window', async () => {
    let resolveToken!: (response: Response) => void;
    const tokenReply = new Promise<Response>((resolve) => {
      resolveToken = resolve;
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(discovery)).mockReturnValueOnce(tokenReply);

    const first = refreshAccessToken(env, 'shared-old-token');
    const second = refreshAccessToken(env, 'shared-old-token');
    expect(first).toBe(second);
    resolveToken(jsonResponse({ access_token: 'access-shared', refresh_token: 'rotated-shared' }));

    const expected = {
      kind: 'ok',
      accessToken: 'access-shared',
      refreshToken: 'rotated-shared',
    } as const;
    await expect(first).resolves.toEqual(expected);
    await expect(second).resolves.toEqual(expected);
    await expect(refreshAccessToken(env, 'shared-old-token')).resolves.toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the default 12s token-endpoint timeout retryable', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(jsonResponse(discovery)).mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        }),
    );

    const pending = refreshAccessToken(env, 'timeout-token');
    await vi.advanceTimersByTimeAsync(11_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ kind: 'upstream_unavailable' });
    vi.useRealTimers();
  });

  it.each([400, 401])(
    'classifies OAuth invalid_grant HTTP %s as an invalid refresh credential',
    async (status) => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(discovery))
        .mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, status));

      await expect(refreshAccessToken(env, 'refresh-secret')).resolves.toEqual({
        kind: 'invalid_grant',
      });
    },
  );

  it.each([
    [400, 'invalid_client'],
    [401, 'invalid_scope'],
    [408, 'upstream_unavailable'],
    [429, 'upstream_unavailable'],
    [500, 'upstream_unavailable'],
    [503, 'upstream_unavailable'],
  ] as const)(
    'keeps token endpoint HTTP %s / %s retryable without exposing its body',
    async (status, error) => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(discovery))
        .mockResolvedValueOnce(jsonResponse({ error }, status));

      await expect(refreshAccessToken(env, 'refresh-secret')).resolves.toEqual({
        kind: 'upstream_unavailable',
      });
    },
  );
});
