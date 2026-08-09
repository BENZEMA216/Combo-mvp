import { afterEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProjectAgentShareResult } from '@cb/shared';
import { installFetchMock, type FetchMock } from '../../test/mockFetch.js';
import { renderPage } from '../../test/renderWithProviders.js';
import { ProjectAgentSharePage } from './ProjectAgentSharePage.js';

const TOKEN = 'A'.repeat(43);
const SHARE_URL = new URL(`/project-agent/${TOKEN}`, window.location.origin).toString();
const START_PROMPT = '<script>window.projectAgentAttack = true</script> Review the repository.';

const result: ProjectAgentShareResult = {
  manifest: {
    schemaVersion: 'combo.project-agent-share/1',
    name: '<img src=x onerror=alert(1)> Repository reviewer',
    description: 'Review one untrusted Project safely.',
    source: {
      repositoryUrl: 'https://github.com/openai/codex.git',
      sourceRef: 'refs/heads/main',
      commitSha: 'a'.repeat(40),
      treeSha: 'b'.repeat(40),
    },
    startPrompt: START_PROMPT,
    requirements: {
      codexVersion: '>=0.147',
      commands: ['git'],
      plugins: ['combo@dangdang-tech-combo'],
      environmentVariableNames: ['DATABASE_URL'],
    },
    createdAt: '2026-08-10T00:00:00.000Z',
  },
  shareUrl: SHARE_URL,
  copyPrompt: `请读取并审查 ${SHARE_URL}，等待我确认。`,
};

let fetchMock: FetchMock | undefined;

afterEach(() => {
  fetchMock?.restore();
  fetchMock = undefined;
});

function renderShare(): void {
  renderPage(<ProjectAgentSharePage />, {
    route: `/project-agent/${TOKEN}`,
    path: '/project-agent/:shareToken',
  });
}

describe('ProjectAgentSharePage', () => {
  it('renders an anonymous, noindex, untrusted by-link manifest without interpreting text as HTML', async () => {
    fetchMock = installFetchMock({ status: 200, json: { data: result } });
    const rendered = renderPage(<ProjectAgentSharePage />, {
      route: `/project-agent/${TOKEN}`,
      path: '/project-agent/:shareToken',
    });

    expect(await screen.findByRole('heading', { name: result.manifest.name })).toBeInTheDocument();
    expect(screen.getByText(/任何拿到链接的人都可匿名读取/)).toBeInTheDocument();
    expect(screen.getByText(/V0 分享不会过期、也不能撤销/)).toBeInTheDocument();
    expect(screen.getByText(/Combo 只保存 manifest，不归档 Git 对象/)).toBeInTheDocument();
    expect(screen.getByText(/即使尚未安装 Combo/)).toBeInTheDocument();
    expect(screen.getByText(/Git tracked files/)).toBeInTheDocument();
    expect(screen.getByText('创建者声明的 ref')).toBeInTheDocument();
    expect(screen.getByText(/Combo 只记录这项声明，未独立验证/)).toBeInTheDocument();
    expect(screen.getByText(START_PROMPT)).toBeInTheDocument();
    expect(rendered.container.querySelector('script')).toBeNull();
    expect(rendered.container.querySelector('img')).toBeNull();
    expect(document.head.querySelector('meta[name="robots"]')).toHaveAttribute(
      'content',
      'noindex, nofollow',
    );

    const repositoryLink = screen.getByRole('link', { name: result.manifest.source.repositoryUrl });
    expect(repositoryLink).toHaveAttribute('rel', 'noreferrer');
    const copyPrompt = screen.getByLabelText('Project Agent 分享提示');
    expect(copyPrompt).toHaveValue(result.copyPrompt);
    expect((copyPrompt as HTMLTextAreaElement).value).not.toContain(START_PROMPT);
    expect(rendered.container.querySelector('a[href^="codex:"]')).toBeNull();

    expect(fetchMock.calls).toHaveLength(1);
    expect(fetchMock.calls[0]).toMatchObject({
      url: `/api/v1/project-agent-shares/${TOKEN}`,
      method: 'GET',
    });
    expect(fetchMock.calls.some(({ url }) => url.includes('/me'))).toBe(false);
  });

  it('fails closed on malformed public data and can retry safely', async () => {
    fetchMock = installFetchMock([
      { status: 200, json: { data: { ...result, manifest: { name: 'incomplete' } } } },
      { status: 200, json: { data: result } },
    ]);
    renderShare();

    expect(await screen.findByText('服务开小差了，请稍后重试。')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('heading', { name: result.manifest.name })).toBeInTheDocument();
    expect(fetchMock.calls).toHaveLength(2);
  });
});
