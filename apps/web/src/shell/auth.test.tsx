import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { MeView } from '@cb/shared';
import { installFetchMock, type FetchMock } from '../test/mockFetch.js';
import {
  AUTH_LOGIN_PATH,
  AuthProvider,
  RequireAuth,
  fetchMe,
  goToLogin,
  loginUrl,
  reconcileMeProbe,
  useAuth,
} from './auth.js';

let fetchMock: FetchMock | undefined;

afterEach(() => {
  fetchMock?.restore();
  fetchMock = undefined;
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

const ME: MeView = {
  id: '11111111-1111-4111-8111-111111111111',
  account: 'creator-testabcd',
  email: 'creator@example.com',
  roles: ['creator'],
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
};
const ME_ENVELOPE = { data: ME, meta: { traceId: 'trace-me-1' } };

describe('fetchMe', () => {
  it('parses the first-party /me envelope with the shared schema', async () => {
    fetchMock = installFetchMock({ status: 200, json: ME_ENVELOPE });

    await expect(fetchMe()).resolves.toEqual({ status: 'authed', me: ME });
    expect(fetchMock.calls).toEqual([
      expect.objectContaining({ url: '/api/v1/me', method: 'GET', credentials: 'include' }),
    ]);
  });

  it('treats 401 as anonymous without refresh or request replay', async () => {
    fetchMock = installFetchMock({
      status: 401,
      json: {
        error: {
          userMessage: '请先登录。',
          retriable: false,
          action: 'escalate',
          traceId: 'trace-401',
        },
      },
    });

    await expect(fetchMe()).resolves.toEqual({ status: 'anon' });
    expect(fetchMock.calls.map(({ url }) => url)).toEqual(['/api/v1/me']);
  });

  it('treats 403 as a terminal disabled-account state', async () => {
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

    await expect(fetchMe()).resolves.toEqual({ status: 'disabled' });
    expect(fetchMock.calls).toHaveLength(1);
  });

  it('keeps 503 as a retryable gate error', async () => {
    fetchMock = installFetchMock({ status: 503, json: {} });
    await expect(fetchMe()).resolves.toEqual({ status: 'error' });
    expect(fetchMock.calls).toHaveLength(1);
  });

  it('rejects malformed success bodies instead of inventing an identity', async () => {
    fetchMock = installFetchMock({ status: 200, json: { data: { account: 'missing-fields' } } });
    await expect(fetchMe()).resolves.toEqual({ status: 'error' });
  });
});

describe('first-party login navigation', () => {
  it('uses the in-app /login route and preserves allowed returnTo paths', () => {
    expect(loginUrl()).toBe(AUTH_LOGIN_PATH);
    expect(loginUrl('/tasks/task-42?tab=logs')).toBe(
      `/login?returnTo=${encodeURIComponent('/tasks/task-42?tab=logs')}`,
    );
    expect(loginUrl('/try/c/capability-1')).toBe(
      `/login?returnTo=${encodeURIComponent('/try/c/capability-1')}`,
    );
  });

  it('falls unsafe or unknown paths back to /tasks', () => {
    for (const value of [
      'https://evil.example/phish',
      '//evil.example/phish',
      '/tasks\\evil',
      '/settings/security',
      '/tasks/%2f%2fevil.example',
    ]) {
      expect(loginUrl(value)).toBe(`/login?returnTo=${encodeURIComponent('/tasks')}`);
    }
  });

  it('navigates straight to the custom page with the current protected deep link', () => {
    const navigate = vi.fn<(url: string) => void>();
    goToLogin('/capabilities?filter=published', navigate);
    expect(navigate).toHaveBeenCalledWith(
      `/login?returnTo=${encodeURIComponent('/capabilities?filter=published')}`,
    );
  });
});

describe('reconcileMeProbe', () => {
  const authed = { status: 'authed', me: ME } as const;

  it('retains an authenticated identity across a temporary dependency error', () => {
    expect(reconcileMeProbe(authed, { status: 'error' })).toBe(authed);
  });

  it('lets an explicit 401 revoke the previous identity', () => {
    expect(reconcileMeProbe(authed, { status: 'anon' })).toEqual({ status: 'anon' });
  });

  it('lets a 403 disabled result revoke the previous identity', () => {
    expect(reconcileMeProbe(authed, { status: 'disabled' })).toEqual({ status: 'disabled' });
  });
});

function ProtectedProbe(): ReactElement {
  const { status, me, refetch } = useAuth();
  return (
    <div>
      <p>受保护内容</p>
      <output data-testid="auth-session">{`${status}:${me?.account ?? 'none'}`}</output>
      <button type="button" onClick={refetch}>
        刷新登录态
      </button>
    </div>
  );
}

function renderGuard(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter initialEntries={['/tasks']}>
          <Routes>
            <Route element={<RequireAuth />}>
              <Route path="*" element={<ProtectedProbe />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

describe('RequireAuth', () => {
  it('shows the login gate only for an explicit 401', async () => {
    fetchMock = installFetchMock({ status: 401, json: {} });
    renderGuard();

    expect(await screen.findByText('请先登录后进入创作者中心。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去登录' })).toBeInTheDocument();
    expect(fetchMock.calls).toHaveLength(1);
  });

  it('shows a terminal disabled-account message without protected content or retry', async () => {
    fetchMock = installFetchMock({ status: 403, json: {} });
    renderGuard();

    expect(
      await screen.findByText('当前账号已停用，无法继续访问。请联系支持人员处理。'),
    ).toBeInTheDocument();
    expect(screen.queryByText('受保护内容')).toBeNull();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  });

  it('shows a manual retry for dependency failure, not a login redirect', async () => {
    fetchMock = installFetchMock([
      { status: 503, json: {} },
      { status: 200, json: ME_ENVELOPE },
    ]);
    renderGuard();

    expect(await screen.findByText('暂时无法确认登录状态，请稍后重试。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '去登录' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('受保护内容')).toBeInTheDocument();
  });

  it('retains confirmed content when a later /me probe has a temporary failure', async () => {
    fetchMock = installFetchMock([
      { status: 200, json: ME_ENVELOPE },
      { status: 503, json: {} },
    ]);
    const queryClient = renderGuard();
    expect(await screen.findByTestId('auth-session')).toHaveTextContent('authed:creator-testabcd');

    await userEvent.click(screen.getByRole('button', { name: '刷新登录态' }));
    await waitFor(() => expect(queryClient.getQueryState(['me'])?.fetchStatus).toBe('idle'));

    expect(screen.getByText('受保护内容')).toBeInTheDocument();
    expect(screen.getByTestId('auth-session')).toHaveTextContent('authed:creator-testabcd');
  });

  it('removes confirmed content when a later /me probe returns 403', async () => {
    fetchMock = installFetchMock([
      { status: 200, json: ME_ENVELOPE },
      { status: 403, json: {} },
    ]);
    const queryClient = renderGuard();
    expect(await screen.findByText('受保护内容')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '刷新登录态' }));
    await waitFor(() => expect(queryClient.getQueryState(['me'])?.fetchStatus).toBe('idle'));

    expect(
      await screen.findByText('当前账号已停用，无法继续访问。请联系支持人员处理。'),
    ).toBeInTheDocument();
    expect(screen.queryByText('受保护内容')).toBeNull();
  });
});
