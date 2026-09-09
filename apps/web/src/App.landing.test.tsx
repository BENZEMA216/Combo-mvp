import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { installFetchMock, type FetchMock } from './test/mockFetch.js';
import { App } from './App.js';

let fetchMock: FetchMock | undefined;

afterEach(() => {
  fetchMock?.restore();
  fetchMock = undefined;
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

function renderApp(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

describe('App landing route', () => {
  it('renders / as a public page without probing the protected session', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    window.history.replaceState({}, '', '/');

    renderApp();

    expect(
      screen.getByRole('heading', {
        name: /把对话，\s*变成 Agent。/u,
      }),
    ).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends an anonymous capabilities deep link straight to the login page', async () => {
    fetchMock = installFetchMock([
      { status: 401, json: {} },
      { status: 401, json: {} },
    ]);
    window.history.replaceState({}, '', '/capabilities?filter=draft');

    renderApp();

    expect(
      await screen.findByRole('heading', { level: 1, name: '使用邮箱登录' }),
    ).toBeInTheDocument();
    expect(window.location.pathname + window.location.search).toBe(
      `/login?returnTo=${encodeURIComponent('/capabilities?filter=draft')}`,
    );
    expect(screen.queryByText('继续创建你的能力')).toBeNull();
    await waitFor(() => expect(fetchMock?.calls).toHaveLength(2));
  });
});
