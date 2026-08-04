import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFetchMock, type FetchMock } from '../test/mockFetch.js';
import {
  AUTH_LOGOUT_PATH,
  completeLogout,
  logoutDestination,
  logoutSession,
} from './sessionLogout.js';

let fetchMock: FetchMock | undefined;

afterEach(() => {
  fetchMock?.restore();
  fetchMock = undefined;
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe('logoutSession', () => {
  it('posts the strict empty JSON contract with the HttpOnly session cookie', async () => {
    sessionStorage.setItem('combo:task-pairing-receipts:v1', 'sensitive');
    sessionStorage.setItem('combo:creation-intake:v1', 'draft');
    fetchMock = installFetchMock({
      status: 200,
      json: {
        data: { loggedOut: true, futureHint: 'ignored' },
        meta: { traceId: 'logout-1', requestVersion: 2 },
      },
    });

    await expect(logoutSession()).resolves.toEqual({ loggedOut: true });
    expect(fetchMock.calls).toEqual([
      {
        url: AUTH_LOGOUT_PATH,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: {},
        credentials: 'include',
      },
    ]);
    expect(sessionStorage.length).toBe(0);
  });

  it.each([
    { name: 'HTTP 错误', response: { status: 503 } },
    { name: '网络错误', response: { networkError: true } },
    { name: '畸形响应', response: { status: 200, json: { data: { loggedOut: false } } } },
  ])('$name returns null so the menu can offer a manual retry', async ({ response }) => {
    sessionStorage.setItem('combo:task-pairing-receipts:v1', 'keep-until-real-logout');
    fetchMock = installFetchMock(response);
    await expect(logoutSession()).resolves.toBeNull();
    expect(sessionStorage.getItem('combo:task-pairing-receipts:v1')).toBe('keep-until-real-logout');
  });
});

describe('completeLogout', () => {
  it('always returns to the in-app login page after successful revocation', () => {
    const navigate = vi.fn<(url: string) => void>();
    completeLogout({ loggedOut: true }, navigate);
    expect(navigate).toHaveBeenCalledWith('/login');
  });
  it('Preview 登出回邮箱登录并保留安全任务上下文', () => {
    const navigate = vi.fn<(url: string) => void>();
    const returnTo = '/tasks/01982e62-6d6e-7f4d-8fe8-b55f62720b5b?tab=history';

    completeLogout({ loggedOut: true }, navigate, 'preview', returnTo);

    expect(navigate).toHaveBeenCalledWith(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  });

  it('Preview 登出丢弃多重编码外链 returnTo', () => {
    expect(logoutDestination({ loggedOut: true }, 'preview', '/%252f%252fevil.example/phish')).toBe(
      '/login',
    );
  });
});
