import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, CLOSED_MARKET_TARGET, ClosedMarketRedirect } from './App.js';

vi.mock('./shell/releaseIdentity.js', () => ({ ReleaseIdentityBadge: () => null }));

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/try/');
});

describe('closed market route', () => {
  it('leaves the runtime bundle without rendering market data', async () => {
    const replace = vi.fn();

    render(<ClosedMarketRedirect replace={replace} />);

    expect(screen.getByText('正在返回我的 Agent…')).toBeInTheDocument();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/capabilities'));
    expect(CLOSED_MARKET_TARGET).toBe('/capabilities');
  });
});

describe('fixed hosted Agent route', () => {
  it('keeps anonymous visitors on a static shell with only /me and the exact login returnTo', async () => {
    window.history.replaceState({}, '', '/try/agent/combo-knowledge');
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => ({ status: 401, ok: false }) as Response,
    );
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Combo 知识助手')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '登录后开始体验' })).toHaveAttribute(
      'href',
      '/login?returnTo=%2Ftry%2Fagent%2Fcombo-knowledge',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/me',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/runtime/'))).toBe(false);
  });
});
