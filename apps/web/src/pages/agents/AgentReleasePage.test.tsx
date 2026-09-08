import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderPage } from '../../test/renderWithProviders.js';
import { AgentReleasePage } from './AgentReleasePage.js';

const RELEASE = `release.agent-package.${'a'.repeat(32)}`;
const DIGEST = `sha256:${'b'.repeat(64)}`;
const pkg = {
  manifestText: JSON.stringify({
    protocol: 'combo.agent-package/1',
    name: 'shared-agent',
    description: '可共享方法',
  }),
  packageDigest: DIGEST,
  files: [
    { path: 'AGENT.md', text: '# 原文 Agent\n<script>steal()</script>' },
    { path: 'skills/method/SKILL.md', text: '# 原文 Skill' },
  ],
};
const view = {
  protocol: 'combo.agent-publication/1',
  release: { protocol: 'combo.agent-package-release/1', releaseId: RELEASE, packageDigest: DIGEST },
  publishedAt: '2026-09-08T08:00:00.000Z',
  name: 'shared-agent',
  description: '可共享方法',
  publisher: { account: 'creator-abcdefgh' },
  sourceVerification: 'not_verified',
  package: pkg,
  shareUrl: `${window.location.origin}/agents/${RELEASE}`,
  acquirePrompt: '请核对这个 Agent 后，在当前任务中使用。',
};
const fetcher = vi.fn<typeof fetch>();
function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data, meta: {} }), { status });
}
function mount(id = RELEASE) {
  return renderPage(<AgentReleasePage />, { route: `/agents/${id}`, path: '/agents/:releaseId' });
}
beforeEach(() => {
  fetcher.mockReset();
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Public Agent release', () => {
  it('only reads public metadata, displays raw contents and does not install, download or run', async () => {
    fetcher.mockResolvedValue(response(view));
    mount();
    expect(await screen.findByRole('heading', { name: 'shared-agent' })).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', credentials: 'omit' });
    expect(screen.getByText(/<script>steal\(\)<\/script>/u)).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('尚未试运行')).toBeInTheDocument();
    expect(screen.getByText(DIGEST)).toBeInTheDocument();
    expect(document.title).toBe('shared-agent · Agent · Combo');
  });
  it('copies only on click and downloads exact Package JSON without Cookie on a separate click', async () => {
    fetcher
      .mockResolvedValueOnce(response(view))
      .mockResolvedValueOnce(new Response(JSON.stringify(pkg)));
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, 'writeText');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const createUrl = vi.fn(() => 'blob:test-package');
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() }),
    );
    mount();
    await screen.findByRole('heading', { name: 'shared-agent' });
    expect(copy).not.toHaveBeenCalled();
    expect(createUrl).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '在 Codex 中使用 · 复制指令' }));
    expect(copy).toHaveBeenCalledWith(view.acquirePrompt);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/复制指令不会自动打开或操作 Codex/u)).toBeInTheDocument();
    expect(screen.getByText(/当前支持轻量文本方法/u)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '下载包 JSON' }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      `/api/v1/agent-package-publications/${RELEASE}/package`,
    );
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'GET', credentials: 'omit' });
    expect(click.mock.instances[0]).toHaveProperty(
      'download',
      `agent-package-${'a'.repeat(32)}.json`,
    );
  });
  it('does not download a malformed or mismatched package', async () => {
    fetcher
      .mockResolvedValueOnce(response(view))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...pkg, packageDigest: `sha256:${'c'.repeat(64)}` })),
      );
    const user = userEvent.setup();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    mount();
    await screen.findByRole('heading', { name: 'shared-agent' });
    await user.click(screen.getByRole('button', { name: '下载包 JSON' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(click).not.toHaveBeenCalled();
  });
  it.each([404, 503])(
    'handles unavailable or revoked HTTP %s without private disclosure',
    async (status) => {
      fetcher.mockResolvedValue(response({ stack: 'private-details' }, status));
      mount();
      expect(await screen.findByRole('alert')).not.toHaveTextContent('private-details');
      expect(screen.queryByRole('button', { name: '下载包 JSON' })).toBeNull();
    },
  );
  it('rejects malformed release links without any session or package request', () => {
    mount('invalid');
    expect(screen.getByRole('heading', { name: '这个 Agent 链接不正确' })).toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
