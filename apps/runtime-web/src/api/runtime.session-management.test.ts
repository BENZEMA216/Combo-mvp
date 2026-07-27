import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  archiveSession,
  invalidateSessionMutation,
  sessionsPath,
  updateSessionTitle,
} from './runtime.js';

const originalFetch = globalThis.fetch;

function session(status: 'active' | 'closed' = 'active') {
  return {
    id: 'session-1',
    capabilityId: 'capability-1',
    title: '项目复盘',
    status,
    createdAt: '2026-07-20T08:00:00.000Z',
    updatedAt: '2026-07-20T08:10:00.000Z',
  };
}

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ data, meta: { traceId: 'trace-test' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('runtime 会话管理 API', () => {
  it('Studio 会话列表与普通试用分开查询', () => {
    expect(sessionsPath('capability-1', 'studio')).toBe(
      '/runtime/sessions?capabilityId=capability-1&mode=studio',
    );
    expect(sessionsPath('capability-1', 'consume')).toBe(
      '/runtime/sessions?capabilityId=capability-1&mode=consume',
    );
    expect(sessionsPath()).toBe('/runtime/sessions');
  });

  it('改名使用 PATCH 并只提交 title', async () => {
    const fetchMock = vi.fn(async () => ok(session()));
    globalThis.fetch = fetchMock;

    await expect(
      updateSessionTitle({ sessionId: 'session-1', title: '项目复盘' }),
    ).resolves.toEqual(session());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/runtime/sessions/session-1',
      expect.objectContaining({
        method: 'PATCH',
        credentials: 'include',
        body: JSON.stringify({ title: '项目复盘' }),
      }),
    );
  });

  it('归档使用 DELETE，不发送请求体', async () => {
    const fetchMock = vi.fn(async () => ok(session('closed')));
    globalThis.fetch = fetchMock;

    await expect(archiveSession('session-1')).resolves.toEqual(session('closed'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/runtime/sessions/session-1',
      expect.objectContaining({
        method: 'DELETE',
        credentials: 'include',
        body: undefined,
      }),
    );
  });

  it('改名/归档成功后同时失效列表和详情缓存', () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();

    invalidateSessionMutation(queryClient, 'session-1');

    expect(invalidate).toHaveBeenNthCalledWith(1, { queryKey: ['sessions'] });
    expect(invalidate).toHaveBeenNthCalledWith(2, { queryKey: ['session', 'session-1'] });
    queryClient.clear();
  });
});
