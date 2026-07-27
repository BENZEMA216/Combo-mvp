import { afterEach, describe, expect, it } from 'vitest';
import { installFetchMock, type FetchMock } from '../test/mockFetch.js';
import {
  AUTH_ME_PATH,
  EMAIL_CHALLENGE_PATH,
  EMAIL_VERIFICATION_PATH,
  AuthRequestError,
  probeAuthSession,
  requestEmailChallenge,
  verifyEmail,
} from './auth.js';

let fetchMock: FetchMock | undefined;

afterEach(() => {
  fetchMock?.restore();
  fetchMock = undefined;
});

const ME = {
  id: 'user-1',
  account: 'creator-testabcd',
  email: 'Alice@example.com',
  roles: ['creator'] as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: '2026-01-01T00:01:00.000Z',
};

describe('first-party auth API', () => {
  it('posts a strict email challenge and parses the shared response contract', async () => {
    fetchMock = installFetchMock({
      status: 202,
      json: {
        data: {
          accepted: true,
          expiresInSeconds: 300,
          resendAfterSeconds: 60,
          deliveryHint: 'future-field',
        },
        meta: { traceId: 'trace-challenge', serverRegion: 'future-field' },
        links: { help: '/help' },
      },
    });

    await expect(requestEmailChallenge({ email: 'Alice@example.com' })).resolves.toEqual({
      accepted: true,
      expiresInSeconds: 300,
      resendAfterSeconds: 60,
    });
    expect(fetchMock.calls).toEqual([
      expect.objectContaining({
        url: EMAIL_CHALLENGE_PATH,
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: { email: 'Alice@example.com' },
      }),
    ]);
  });

  it('keeps Retry-After and the safe ErrorEnvelope message for rate limiting', async () => {
    fetchMock = installFetchMock({
      status: 429,
      headers: { 'retry-after': '37' },
      json: {
        error: {
          userMessage: '操作太频繁了，歇一会儿再试。',
          retriable: true,
          action: 'wait',
          traceId: 'trace-rate',
        },
      },
    });

    const error = await requestEmailChallenge({ email: 'Alice@example.com' }).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(AuthRequestError);
    expect(error).toMatchObject({ status: 429, retryAfterSeconds: 37 });
    expect((error as AuthRequestError).message).toBe('操作太频繁了，歇一会儿再试。');
  });

  it('never retries verification and marks a network result as uncertain', async () => {
    fetchMock = installFetchMock({ networkError: true });

    const error = await verifyEmail({
      email: 'Alice@example.com',
      code: '004271',
      returnTo: '/tasks',
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AuthRequestError);
    expect(error).toMatchObject({ kind: 'network', outcomeUncertain: true });
    expect(fetchMock.calls).toHaveLength(1);
    expect(fetchMock.calls[0]).toEqual(
      expect.objectContaining({
        url: EMAIL_VERIFICATION_PATH,
        body: { email: 'Alice@example.com', code: '004271', returnTo: '/tasks' },
      }),
    );
  });

  it('marks verification gateway and server errors as outcome-uncertain without replaying', async () => {
    fetchMock = installFetchMock({
      status: 504,
      json: {
        error: {
          userMessage: '网关暂时没有响应。',
          retriable: true,
          action: 'retry',
          traceId: 'trace-gateway',
        },
      },
    });

    const error = await verifyEmail({
      email: 'Alice@example.com',
      code: '004271',
      returnTo: '/tasks',
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AuthRequestError);
    expect(error).toMatchObject({ kind: 'http', status: 504, outcomeUncertain: true });
    expect(fetchMock.calls).toHaveLength(1);
  });

  it('keeps verification 4xx outcomes certain', async () => {
    fetchMock = installFetchMock({ status: 401, json: {} });
    const error = await verifyEmail({
      email: 'Alice@example.com',
      code: '004271',
      returnTo: '/tasks',
    }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status: 401, outcomeUncertain: false });
  });

  it('parses verification success without exposing the session token to JavaScript', async () => {
    fetchMock = installFetchMock({
      status: 200,
      json: {
        data: { user: { ...ME, avatarUrl: 'future-field' }, returnTo: '/tasks', onboarding: true },
        meta: { traceId: 'trace-verification', requestVersion: 2 },
      },
    });

    await expect(
      verifyEmail({ email: 'Alice@example.com', code: '004271', returnTo: '/tasks' }),
    ).resolves.toEqual({ user: ME, returnTo: '/tasks' });
    expect(JSON.stringify(fetchMock.calls)).not.toContain('cb_session');
  });
});

describe('probeAuthSession', () => {
  it('uses only /me and classifies 401 as anonymous', async () => {
    fetchMock = installFetchMock({ status: 401, json: {} });
    await expect(probeAuthSession()).resolves.toEqual({ status: 'anon' });
    expect(fetchMock.calls.map(({ url }) => url)).toEqual([AUTH_ME_PATH]);
  });

  it('returns the parsed identity on success and ignores additive fields', async () => {
    fetchMock = installFetchMock({
      status: 200,
      json: {
        data: { ...ME, avatarUrl: 'future-field' },
        meta: { traceId: 'trace-me', requestVersion: 2 },
        links: { self: AUTH_ME_PATH },
      },
    });
    await expect(probeAuthSession()).resolves.toEqual({ status: 'authed', me: ME });
  });

  it('classifies account-disabled 403 as a terminal state', async () => {
    fetchMock = installFetchMock({
      status: 403,
      json: {
        error: {
          userMessage: '当前账号已停用。',
          retriable: false,
          action: 'escalate',
          traceId: 'trace-disabled',
        },
      },
    });
    const probe = await probeAuthSession();
    expect(probe.status).toBe('disabled');
    expect(probe.status === 'disabled' && probe.error.status).toBe(403);
  });

  it('keeps a dependency outage distinct from anonymous', async () => {
    fetchMock = installFetchMock({
      status: 503,
      json: {
        error: {
          userMessage: '依赖服务暂时不可用，请稍后重试。',
          retriable: true,
          action: 'retry',
          traceId: 'trace-503',
        },
      },
    });
    const probe = await probeAuthSession();
    expect(probe.status).toBe('error');
    expect(probe.status === 'error' && probe.error.status).toBe(503);
    expect(probe.status === 'error' && probe.error.message).toBe(
      '依赖服务暂时不可用，请稍后重试。',
    );
  });
});
