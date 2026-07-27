import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiGet } from './api/client.js';
import { createRuntimeQueryClient } from './queryClient.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('runtime React Query retry policy', () => {
  it('runs a protected query exactly once when the server returns 401', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { userMessage: '请先登录。', traceId: 'trace-query-401' } }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    );
    globalThis.fetch = fetchMock;
    const queryClient = createRuntimeQueryClient();

    await expect(
      queryClient.fetchQuery({
        queryKey: ['protected-query-retry-test'],
        queryFn: () => apiGet('/runtime/capabilities'),
      }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    queryClient.clear();
  });
});
