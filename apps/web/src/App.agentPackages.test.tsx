import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';

const ID = '11111111-1111-4111-8111-111111111111';
const RELEASE = `release.agent-package.${'a'.repeat(32)}`;
const DIGEST = `sha256:${'b'.repeat(64)}`;
const fetcher = vi.fn<typeof fetch>();
function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data, meta: { traceId: 'trace-agent-test' } }), { status });
}
function mount(path: string): QueryClient {
  window.history.replaceState({}, '', path);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
  return client;
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
  it('immediately hides the previous owner content and approval state on /me account switch', async () => {
    const ownerA = ID;
    const ownerB = '22222222-2222-4222-8222-222222222222';
    let owner = ownerA;
    let denyB: (value: Response) => void = () => {};
    fetcher.mockImplementation(async (url) => {
      if (String(url).endsWith('/me'))
        return response({
          id: owner,
          account: owner === ownerA ? 'creator-abcdefgh' : 'creator-bcdefghi',
          email: 'synthetic@example.test',
          roles: ['creator'],
          createdAt: '2026-01-01T00:00:00.000Z',
          lastLoginAt: null,
        });
      if (owner === ownerB)
        return new Promise((resolve) => {
          denyB = resolve;
        });
      return response({
        name: 'owner-a-private-agent',
        draftFingerprint: DIGEST,
        packageDigest: DIGEST,
        transfer: {
          protocol: 'combo.agent-transfer/1',
          transferId: ID,
          phase: 'uploaded',
          approvalUrl: `${window.location.origin}/agent-transfers/${ID}`,
          verificationCode: 'AB12CD34',
          expiresAt: '2030-09-08T08:00:00.000Z',
          saved: {
            draftId: 'draft-a',
            revision: 1,
            draftFingerprint: DIGEST,
            packageDigest: DIGEST,
          },
        },
        review: {
          manifestText: JSON.stringify({ protocol: 'combo.agent-package/1' }),
          packageDigest: DIGEST,
          files: [
            { path: 'AGENT.md', text: 'Owner A private method only' },
            { path: 'skills/method/SKILL.md', text: '# Private Skill' },
          ],
        },
      });
    });
    const user = userEvent.setup();
    const client = mount(`/agent-transfers/${ID}`);
    await user.click(await screen.findByRole('checkbox'));
    expect(screen.getByRole('button', { name: '确认公开发布' })).toBeEnabled();
    owner = ownerB;
    await act(() => client.invalidateQueries({ queryKey: ['me'] }));
    await waitFor(() => expect(screen.queryByText('Owner A private method only')).toBeNull());
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'owner-a-private-agent' })).toBeNull();
    await waitFor(() =>
      expect(client.getQueryData(['agent-transfer', ownerA, ID])).toBeUndefined(),
    );
    await act(async () => denyB(response({}, 404)));
    expect(await screen.findByRole('alert')).toHaveTextContent('不属于当前账号');
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0);
  });
  it('does not refill old private cache when a publication response arrives after account switch', async () => {
    const ownerA = ID;
    const ownerB = '22222222-2222-4222-8222-222222222222';
    let owner = ownerA;
    let finishPublication: (value: Response) => void = () => {};
    const transfer = {
      protocol: 'combo.agent-transfer/1',
      transferId: ID,
      phase: 'uploaded',
      approvalUrl: `${window.location.origin}/agent-transfers/${ID}`,
      verificationCode: 'AB12CD34',
      expiresAt: '2030-09-08T08:00:00.000Z',
      saved: { draftId: 'draft-a', revision: 1, draftFingerprint: DIGEST, packageDigest: DIGEST },
    };
    fetcher.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/me'))
        return response({
          id: owner,
          account: owner === ownerA ? 'creator-abcdefgh' : 'creator-bcdefghi',
          email: 'synthetic@example.test',
          roles: ['creator'],
          createdAt: '2026-01-01T00:00:00.000Z',
          lastLoginAt: null,
        });
      if (init?.method === 'POST')
        return new Promise((resolve) => {
          finishPublication = resolve;
        });
      if (owner === ownerB) return response({}, 404);
      return response({
        name: 'owner-a-private-agent',
        draftFingerprint: DIGEST,
        packageDigest: DIGEST,
        transfer,
        review: {
          manifestText: JSON.stringify({ protocol: 'combo.agent-package/1' }),
          packageDigest: DIGEST,
          files: [
            { path: 'AGENT.md', text: 'Owner A private method only' },
            { path: 'skills/method/SKILL.md', text: '# Private Skill' },
          ],
        },
      });
    });
    const user = userEvent.setup();
    const client = mount(`/agent-transfers/${ID}`);
    await user.click(await screen.findByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: '确认公开发布' }));
    owner = ownerB;
    await act(() => client.invalidateQueries({ queryKey: ['me'] }));
    expect(await screen.findByRole('alert')).toHaveTextContent('不属于当前账号');
    await act(async () =>
      finishPublication(
        response({
          ...transfer,
          phase: 'published',
          release: {
            releaseId: RELEASE,
            packageDigest: DIGEST,
            shareUrl: `${window.location.origin}/agents/${RELEASE}`,
            acquirePrompt: '请核对后使用。',
          },
        }),
      ),
    );
    expect(screen.queryByText('Owner A private method only')).toBeNull();
    expect(screen.queryByRole('heading', { name: '已按链接公开' })).toBeNull();
    await waitFor(() =>
      expect(client.getQueryData(['agent-transfer', ownerA, ID])).toBeUndefined(),
    );
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
  });
});
