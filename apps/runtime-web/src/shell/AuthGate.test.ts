import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeView } from '@cb/shared';
import { fetchMe, reconcileRuntimeMeProbe } from './AuthGate.js';

const ME: MeView = {
  id: '11111111-1111-4111-8111-111111111111',
  account: 'creator-comboabc',
  email: 'combo@example.com',
  roles: ['creator'],
  createdAt: '2026-07-11T00:00:00.000Z',
  lastLoginAt: null,
};

const originalFetch = globalThis.fetch;

function response(status: number, body?: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('runtime AuthGate /me probe', () => {
  it('retains an authenticated identity across a temporary dependency outage', () => {
    const authed = { status: 'authed', me: ME } as const;
    expect(reconcileRuntimeMeProbe(authed, { status: 'error' })).toBe(authed);
  });

  it('lets an explicit anonymous result revoke the previous runtime identity', () => {
    const authed = { status: 'authed', me: ME } as const;
    expect(reconcileRuntimeMeProbe(authed, { status: 'anon' })).toEqual({ status: 'anon' });
  });

  it('lets a disabled-account result revoke the previous runtime identity', () => {
    const authed = { status: 'authed', me: ME } as const;
    expect(reconcileRuntimeMeProbe(authed, { status: 'disabled' })).toEqual({
      status: 'disabled',
    });
  });

  it('parses an authenticated user in one request and ignores additive response fields', async () => {
    const fetchMock = vi.fn(async () =>
      response(200, {
        data: { ...ME, avatarUrl: 'https://example.test/avatar' },
        meta: { traceId: 'trace-me', requestVersion: 2 },
        links: { self: '/api/v1/me' },
      }),
    );
    globalThis.fetch = fetchMock;

    await expect(fetchMe()).resolves.toEqual({ status: 'authed', me: ME });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/me',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('classifies 401 as anonymous without refresh or replay', async () => {
    const fetchMock = vi.fn(async () => response(401));
    globalThis.fetch = fetchMock;

    await expect(fetchMe()).resolves.toEqual({ status: 'anon' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/me', expect.any(Object));
  });

  it('classifies 403 as a terminal disabled-account state', async () => {
    const fetchMock = vi.fn(async () => response(403));
    globalThis.fetch = fetchMock;

    await expect(fetchMe()).resolves.toEqual({ status: 'disabled' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500, 503])('keeps HTTP %s as a dependency/protocol error', async (status) => {
    const fetchMock = vi.fn(async () => response(status));
    globalThis.fetch = fetchMock;

    await expect(fetchMe()).resolves.toEqual({ status: 'error' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a network failure as a retryable error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    globalThis.fetch = fetchMock;

    await expect(fetchMe()).resolves.toEqual({ status: 'error' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('times out a hanging probe instead of loading forever', async () => {
    globalThis.fetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted.', 'AbortError')),
            { once: true },
          );
        }),
    ) as typeof fetch;

    await expect(fetchMe(undefined, 5)).resolves.toEqual({ status: 'error' });
  });
});
