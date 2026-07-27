import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AuthGate } from './AuthGate.js';

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/try/');
});

describe('AuthGate first-party recovery', () => {
  it('sends an anonymous Preview browser to the same in-app email login as every environment', async () => {
    window.history.replaceState(
      {},
      '',
      '/try/session/11111111-1111-4111-8111-111111111111?mode=studio',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    const navigateToAuth = vi.fn<(target: string) => void>();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <AuthGate navigateToAuth={navigateToAuth}>
          <p>受保护试用内容</p>
        </AuthGate>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('请先登录后进入试用模式。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '去登录' }));
    expect(navigateToAuth).toHaveBeenCalledWith(
      `/login?returnTo=${encodeURIComponent(
        '/try/session/11111111-1111-4111-8111-111111111111?mode=studio',
      )}`,
    );
  });
});
