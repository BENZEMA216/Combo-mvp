import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiGet, apiPost } from './client.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('runtime API fixed session semantics', () => {
  it('surfaces the first 401 without refresh or request replay', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(401, {
        error: { userMessage: '请先登录。', traceId: 'trace-401' },
      }),
    );
    globalThis.fetch = fetchMock;

    const error = await apiGet('/runtime/sessions').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, userMessage: '请先登录。' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/v1/runtime/sessions']);
  });

  it('redirects a 401 mutation once with the current safe returnTo and never replays it', async () => {
    const navigate = vi.fn();
    vi.stubGlobal('window', {
      location: {
        pathname: '/try/c/11111111-1111-4111-8111-111111111111',
        search: '?from=market',
        assign: navigate,
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      json(401, {
        error: { userMessage: '请先登录。', traceId: 'trace-post-401' },
      }),
    );
    globalThis.fetch = fetchMock;
    const body = { text: 'hello' };

    await expect(apiPost('/runtime/sessions/s1/messages', body)).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(body));
    expect(navigate).toHaveBeenCalledWith(
      `/login?returnTo=${encodeURIComponent('/try/c/11111111-1111-4111-8111-111111111111?from=market')}`,
    );
  });

  it('keeps non-401 dependency failures distinct from unauthenticated', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(503, {
        error: { userMessage: '依赖服务暂时不可用。', traceId: 'trace-503' },
      }),
    );
    globalThis.fetch = fetchMock;

    const error = await apiGet('/runtime/sessions').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 503, userMessage: '依赖服务暂时不可用。' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
