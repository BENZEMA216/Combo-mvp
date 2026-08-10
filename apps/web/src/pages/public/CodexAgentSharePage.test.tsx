import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { screen } from '@testing-library/react';
import { canonicalJson, type CodexAgentShareResult } from '@cb/shared';
import { installFetchMock, type FetchMock } from '../../test/mockFetch.js';
import { renderPage } from '../../test/renderWithProviders.js';
import { CodexAgentSharePage } from './CodexAgentSharePage.js';

const TOKEN = 'A'.repeat(43);
const SHARE_URL = new URL(`/agent/${TOKEN}`, window.location.origin).toString();
const INSTRUCTIONS = '<script>window.agentAttack = true</script> Review repository changes.';

const manifest: CodexAgentShareResult['manifest'] = {
  schemaVersion: 'combo.codex-agent-share/1',
  name: '<img src=x onerror=alert(1)> Reviewer',
  description: 'Review a fixed Project with a task-derived Agent.',
  source: {
    repositoryUrl: 'https://github.com/openai/codex.git',
    sourceRef: 'refs/heads/main',
    commitSha: 'a'.repeat(40),
    treeSha: 'b'.repeat(40),
  },
  agent: { instructions: INSTRUCTIONS, starterPrompts: ['Review the current branch.'] },
  authoringSource: { kind: 'codex_current_task', rawStored: false },
  requirements: {
    codexVersion: '>=0.147',
    commands: ['git'],
    plugins: ['combo@dangdang-tech-combo'],
    environmentVariableNames: [],
  },
  createdAt: '2026-08-10T00:00:00.000Z',
};
const manifestSha256 = createHash('sha256').update(canonicalJson(manifest)).digest('hex');
const result: CodexAgentShareResult = {
  manifest,
  manifestSha256,
  shareUrl: SHARE_URL,
  copyPrompt: `请读取 ${SHARE_URL}，核对 digest，等待确认。`,
};

let fetchMock: FetchMock | undefined;

afterEach(() => {
  fetchMock?.restore();
  fetchMock = undefined;
});

describe('CodexAgentSharePage', () => {
  it('renders the public derived definition, digest and raw-not-stored boundary as text', async () => {
    fetchMock = installFetchMock({ status: 200, json: { data: result } });
    const rendered = renderPage(<CodexAgentSharePage />, {
      route: `/agent/${TOKEN}`,
      path: '/agent/:shareToken',
    });

    expect(await screen.findByRole('heading', { name: result.manifest.name })).toBeInTheDocument();
    expect(screen.getByText(/派生 Agent 指令是公开内容/)).toBeInTheDocument();
    expect(screen.getByText(/没有独立的 raw task/)).toBeInTheDocument();
    expect(screen.getByText(/服务端不能证明其已脱敏/)).toBeInTheDocument();
    expect(screen.getByText(INSTRUCTIONS)).toBeInTheDocument();
    expect(screen.getByText('Review the current branch.')).toBeInTheDocument();
    expect(screen.getByText(result.manifestSha256)).toBeInTheDocument();
    expect(screen.getByText(/V1 不支持撤销或过期/)).toBeInTheDocument();
    expect(screen.getByText(/它不是账户授权或 OAuth token/)).toBeInTheDocument();
    expect(screen.getByText(/持有即匿名可读/)).toBeInTheDocument();
    expect(screen.getByText('$HOME/Developer/Combo-shared-projects')).toBeInTheDocument();
    expect(
      screen.getByText('"/Applications/ChatGPT.app/Contents/Resources/codex" app .'),
    ).toBeInTheDocument();
    expect(screen.getByText(/路径不得插入 command string/)).toBeInTheDocument();
    expect(screen.getByText(/canonical exact path 唯一匹配/)).toBeInTheDocument();
    expect(screen.getByText(/target:type=projectless/)).toBeInTheDocument();
    expect(screen.getByText(/combo.receiver-bootstrap-handoff\/1/)).toBeInTheDocument();
    expect(screen.getByText(/COMBO_RECEIVER_HANDOFF_READY/)).toBeInTheDocument();
    expect(screen.getByText(/任何 create_thread 前/)).toHaveTextContent('Codex-managed OAuth');
    expect(screen.getByText(/续跑任务不再登录或重建任务/)).toBeInTheDocument();
    expect(screen.getAllByText('prepare_codex_agent_run')).toHaveLength(2);
    expect(screen.getByText(/preflight 或 Agent 文本执行前恰好调用一次/)).toBeInTheDocument();
    expect(screen.getByText(/Raw run envelope 是显式 advanced launch 命令/)).toBeInTheDocument();
    expect(screen.getByText(/shell-safe 的完整 ASCII/)).toBeInTheDocument();
    expect(screen.getByText(/COMBO_CODEX_AGENT_RUN\/1/)).toBeInTheDocument();
    expect(screen.getByText(/expectedSourceRef/)).toBeInTheDocument();
    expect(screen.getByText(/不默认第一条/)).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`COMBO_CODEX_AGENT_STARTED:${manifestSha256}`, 'u')),
    ).toBeInTheDocument();
    expect(screen.getByText(/不默认重启/)).toBeInTheDocument();
    expect(rendered.container.querySelector('script')).toBeNull();
    expect(rendered.container.querySelector('img')).toBeNull();
    expect(document.head.querySelector('meta[name="robots"]')).toHaveAttribute(
      'content',
      'noindex, nofollow',
    );

    const prompt = screen.getByLabelText('Codex Agent 分享提示') as HTMLTextAreaElement;
    expect(prompt.value).toBe(result.copyPrompt);
    expect(prompt.value).not.toContain(INSTRUCTIONS);
    expect(fetchMock.calls).toHaveLength(1);
    expect(fetchMock.calls[0]).toMatchObject({
      url: `/api/v1/codex-agent-shares/${TOKEN}`,
      method: 'GET',
    });
    expect(fetchMock.calls.some(({ url }) => url.includes('/me'))).toBe(false);
  });
});
