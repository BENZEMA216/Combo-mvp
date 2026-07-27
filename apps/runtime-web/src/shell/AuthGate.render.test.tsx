// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthGate } from './AuthGate.js';

const ME = {
  id: '11111111-1111-4111-8111-111111111111',
  account: 'creator-comboabc',
  email: 'combo@example.com',
  roles: ['creator'],
  createdAt: '2026-07-11T00:00:00.000Z',
  lastLoginAt: null,
};
const originalFetch = globalThis.fetch;

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderGate(queryClient: QueryClient): void {
  render(
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        <p>受保护的试用内容</p>
      </AuthGate>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('runtime AuthGate disabled-account rendering', () => {
  it('renders a first-load 403 as terminal escalation without retry or protected content', async () => {
    globalThis.fetch = vi.fn(async () => response(403));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderGate(queryClient);

    expect(
      await screen.findByText('当前账号已停用，无法继续访问。请联系支持人员处理。'),
    ).toBeTruthy();
    expect(screen.queryByText('受保护的试用内容')).toBeNull();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    queryClient.clear();
  });

  it('removes previously authenticated content after a later 403 probe', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, { data: ME, meta: { traceId: 'trace-me' } }))
      .mockResolvedValueOnce(response(403));
    globalThis.fetch = fetchMock;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderGate(queryClient);

    expect(await screen.findByText('受保护的试用内容')).toBeTruthy();
    await queryClient.refetchQueries({ queryKey: ['runtime-web-me'] });

    await waitFor(() => {
      expect(screen.getByText('当前账号已停用，无法继续访问。请联系支持人员处理。')).toBeTruthy();
    });
    expect(screen.queryByText('受保护的试用内容')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    queryClient.clear();
  });
});
