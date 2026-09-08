import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';

const ID = '11111111-1111-4111-8111-111111111111';
const RELEASE = `release.agent-package.${'a'.repeat(32)}`;
const DIGEST = `sha256:${'b'.repeat(64)}`;
const fetcher = vi.fn<typeof fetch>();
function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data, meta: { traceId: 'trace-agent-test' } }), { status });
}
function mount(path: string): void {
  window.history.replaceState({}, '', path);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <App />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  fetcher.mockReset();
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('App Agent routes', () => {
  it('keeps anonymous sharing outside AuthProvider and requests only the public package view', async () => {
    fetcher.mockResolvedValue(
      response({
        protocol: 'combo.agent-publication/1',
        release: {
          protocol: 'combo.agent-package-release/1',
          releaseId: RELEASE,
          packageDigest: DIGEST,
        },
        publishedAt: '2026-09-08T08:00:00.000Z',
        name: 'public-agent',
        description: '共享方法',
        publisher: { account: 'creator-abcdefgh' },
        sourceVerification: 'not_verified',
        package: {
          manifestText: JSON.stringify({ protocol: 'combo.agent-package/1' }),
          packageDigest: DIGEST,
          files: [
            { path: 'AGENT.md', text: '# Agent' },
            { path: 'skills/method/SKILL.md', text: '# Skill' },
          ],
        },
        shareUrl: `${window.location.origin}/agents/${RELEASE}`,
        acquirePrompt: '请核对后使用。',
      }),
    );
    mount(`/agents/${RELEASE}`);
    expect(await screen.findByRole('heading', { name: 'public-agent' })).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/v1/agent-package-publications/${RELEASE}`);
    expect(fetcher.mock.calls[0]?.[1]?.credentials).toBe('omit');
    expect(screen.queryByRole('navigation', { name: '主导航' })).toBeNull();
  });
  it('preserves the exact transfer deep link through login without reading the transfer anonymously', async () => {
    fetcher.mockImplementation(async () => response({}, 401));
    mount(`/agent-transfers/${ID}`);
    expect(await screen.findByRole('heading', { name: '使用邮箱登录' })).toBeInTheDocument();
    expect(window.location.pathname + window.location.search).toBe(
      `/login?returnTo=${encodeURIComponent(`/agent-transfers/${ID}`)}`,
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls.every((call) => call[0] === '/api/v1/me')).toBe(true);
  });
  it('lets the authenticated owner reach the transfer confirmation without approving it', async () => {
    fetcher.mockImplementation(async (url) =>
      String(url).endsWith('/me')
        ? response({
            id: '11111111-1111-4111-8111-111111111111',
            account: 'creator-abcdefgh',
            email: 'synthetic@example.test',
            roles: ['creator'],
            createdAt: '2026-01-01T00:00:00.000Z',
            lastLoginAt: null,
          })
        : response({
            name: 'private-agent',
            draftFingerprint: DIGEST,
            packageDigest: DIGEST,
            transfer: {
              protocol: 'combo.agent-transfer/1',
              transferId: ID,
              phase: 'pending_approval',
              approvalUrl: `${window.location.origin}/agent-transfers/${ID}`,
              verificationCode: 'AB12CD34',
              expiresAt: '2030-09-08T08:00:00.000Z',
            },
          }),
    );
    mount(`/agent-transfers/${ID}`);
    expect(await screen.findByRole('heading', { name: '核对 Codex 配对码' })).toBeInTheDocument();
    expect(
      fetcher.mock.calls.some((call) => call[0] === `/api/v1/agent-package-transfers/${ID}`),
    ).toBe(true);
    expect(fetcher.mock.calls.every((call) => call[1]?.method !== 'POST')).toBe(true);
  });
});
