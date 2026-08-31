import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  KnowledgeTurnResultSchema,
  type ArtifactView,
  type KnowledgeTurnResult,
  type MessageView,
  type SessionDetail,
} from '@cb/shared';
import { ChatPage } from './ChatPage.js';

const mocks = vi.hoisted(() => ({
  detail: undefined as SessionDetail | undefined,
  running: false,
  activeRunId: null as string | null,
  terminalRun: null as {
    runId: string;
    state: 'completed' | 'failed';
    message: string;
  } | null,
  errorMessage: null as string | null,
  streamingText: null as string | null,
  streamConnectionFailed: false,
  retryStreamConnection: vi.fn(),
  artifact: null as ArtifactView | null,
  artifactContent: '<!doctype html><html><body><button>运行</button></body></html>',
  send: vi.fn(),
  pendingRetryAvailable: false,
  retryPending: vi.fn(),
  rechargeRequired: null as {
    rechargeRequired: true;
    rechargeIntentId: string;
    balanceCents: string;
    requiredCents: string;
  } | null,
  activeRechargeIntentId: null as string | null,
  clearRechargeRequired: vi.fn(),
  resumeAfterRecharge: vi.fn(),
  setActiveRechargeIntent: vi.fn(),
  abandonRechargeUsage: vi.fn(),
  createTrial: vi.fn(),
  createTrialPending: false,
}));

vi.mock('../api/runtime.js', () => ({
  useSession: () => ({ data: mocks.detail, isPending: false, isError: false, refetch: vi.fn() }),
  useCreateSession: () => ({
    mutateAsync: mocks.createTrial,
    isPending: mocks.createTrialPending,
  }),
  useArtifactContent: () => ({
    data: mocks.artifactContent,
    isPending: false,
    isError: false,
  }),
}));

vi.mock('../api/useSessionStream.js', () => ({
  useSessionStream: () => {
    const artifactList = mocks.artifact ? [mocks.artifact] : (mocks.detail?.artifacts ?? []);
    const artifact = artifactList.at(-1) ?? null;
    const restoredTurn = mocks.detail?.activeTurn ?? null;
    return {
      activeArtifactId: artifact?.id ?? null,
      artifacts: Object.fromEntries(artifactList.map((item) => [item.id, item])),
      artifactList,
      streamingText: mocks.streamingText,
      streamConnectionFailed: mocks.streamConnectionFailed,
      retryStreamConnection: mocks.retryStreamConnection,
      running: mocks.running || restoredTurn !== null,
      activeRunId: mocks.activeRunId ?? restoredTurn?.id ?? null,
      terminalRun: mocks.terminalRun,
      errorMessage: mocks.errorMessage,
      pendingRetryAvailable: mocks.pendingRetryAvailable,
      retryPending: mocks.retryPending,
      rechargeRequired: mocks.rechargeRequired,
      activeRechargeIntentId: mocks.activeRechargeIntentId,
      clearRechargeRequired: mocks.clearRechargeRequired,
      resumeAfterRecharge: mocks.resumeAfterRecharge,
      setActiveRechargeIntent: mocks.setActiveRechargeIntent,
      abandonRechargeUsage: mocks.abandonRechargeUsage,
      send: mocks.send,
      interrupt: vi.fn(),
      selectArtifact: vi.fn(),
    };
  },
}));

vi.mock('../components/RechargeDialog.js', () => ({
  RechargeDialog: ({
    activeRechargeIntentId,
    onActiveRechargeIntentChange,
    onCredited,
  }: {
    activeRechargeIntentId: string;
    onActiveRechargeIntentChange: (rechargeIntentId: string) => void;
    onCredited: (creditedIntentId: string) => Promise<unknown>;
  }) => (
    <div data-testid="recharge-dialog" data-active-intent={activeRechargeIntentId}>
      <button
        type="button"
        onClick={() => void onCredited(activeRechargeIntentId).catch(() => undefined)}
      >
        模拟到账
      </button>
      <button
        type="button"
        onClick={() => onActiveRechargeIntentChange('99999999-9999-4999-8999-999999999999')}
      >
        模拟替换订单
      </button>
    </div>
  ),
}));

vi.mock('../components/SessionSidebar.js', () => ({
  SessionSidebar: ({ experience, returnTo }: { experience?: string; returnTo?: string | null }) => (
    <div
      data-testid="session-sidebar"
      data-experience={experience}
      data-return-to={returnTo ?? undefined}
    />
  ),
}));

function sessionDetail(mode?: 'consume' | 'studio'): SessionDetail {
  return {
    session: {
      id: '11111111-1111-4111-8111-111111111111',
      capabilityId: '22222222-2222-4222-8222-222222222222',
      title: '周报助手页面设计',
      status: 'active',
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
      ...(mode ? { mode } : {}),
    },
    capability: {
      id: '22222222-2222-4222-8222-222222222222',
      name: '周报助手',
      summary: '整理本周工作',
      kind: 'workflow',
      inputs: [
        {
          key: 'work',
          label: '本周工作',
          type: 'text',
          required: true,
        },
        {
          key: 'tone',
          label: '表达风格',
          type: 'enum',
          required: false,
          options: ['精炼', '详细'],
        },
      ],
      starterPrompts: ['整理成管理层周报'],
    },
    messages: [],
    artifacts: [],
    activeTurn: null,
  } as SessionDetail;
}

function knowledgeResult(): KnowledgeTurnResult {
  const sourceSha = 'd'.repeat(40);
  return KnowledgeTurnResultSchema.parse({
    protocol: 'combo.agent-usage-receipt/1',
    receiptId: '33333333-3333-4333-8333-333333333333',
    usageId: '44444444-4444-4444-8444-444444444444',
    turnId: '55555555-5555-4555-8555-555555555555',
    createdAt: '2026-08-30T01:00:02.000Z',
    binding: {
      productKind: 'knowledge_agent_test',
      capability: {
        id: '22222222-2222-4222-8222-222222222222',
        protocol: 'combo.agent-package-capability/2',
      },
      release: {
        protocol: 'combo.agent-package-release/1',
        releaseId: `release.agent-package.${'a'.repeat(32)}`,
        packageDigest: `sha256:${'b'.repeat(64)}`,
      },
      releaseScope: 'controlled_test',
      knowledge: {
        protocol: 'combo.knowledge-bundle/1',
        resourcePath: 'skills/knowledge/references/knowledge-bundle.json',
        resourceDigest: `sha256:${'c'.repeat(64)}`,
      },
    },
    outcome: 'answered',
    validation: { policyVersion: 'knowledge-test-v1', code: 'accepted' },
    answer: {
      messageId: '66666666-6666-4666-8666-666666666666',
      text: 'AUTHORITATIVE_KNOWLEDGE_ANSWER',
      responseDigest: `sha256:${'e'.repeat(64)}`,
    },
    citations: [
      {
        chunkId: `chunk.knowledge.${'1'.repeat(32)}`,
        sourceId: `source.knowledge.${'2'.repeat(32)}`,
        displayLabel: 'Combo 产品基线',
      },
    ],
    billing: {
      policyVersion: 'knowledge-test-v1',
      source: 'wallet',
      currency: 'CNY',
      unitPriceCents: '100',
      settledCents: '100',
      freeLimitSnapshot: 3,
    },
    runtime: {
      environment: 'test',
      releaseId: `release-${sourceSha}`,
      sourceSha,
    },
  });
}

function knowledgeSessionDetail(
  messages: MessageView[] = [],
  results: KnowledgeTurnResult[] = [],
): SessionDetail {
  const detail = sessionDetail('consume');
  return {
    ...detail,
    capability: {
      ...detail.capability,
      name: 'Combo 知识助手',
      kind: 'anything-hostile-tests-must-ignore',
    },
    messages,
    artifacts: [],
    agentBinding: knowledgeResult().binding,
    knowledgeResults: results,
  } as SessionDetail;
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-probe">{`${location.pathname}${location.search}`}</output>;
}

function pageElement(url: string) {
  return (
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route
          path="/session/:sessionId"
          element={
            <>
              <ChatPage />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

function renderPage(url: string): ReturnType<typeof render> {
  return render(pageElement(url));
}

beforeEach(() => {
  window.sessionStorage.clear();
  mocks.send.mockResolvedValue({
    id: '44444444-4444-4444-8444-444444444444',
    seq: 1,
    turnId: '55555555-5555-4555-8555-555555555555',
    role: 'user',
    content: [{ type: 'text', text: '已接受' }],
    status: 'completed',
    createdAt: '2026-07-23T01:01:00.000Z',
  });
  mocks.createTrial.mockResolvedValue({
    id: '88888888-8888-4888-8888-888888888888',
    capabilityId: '22222222-2222-4222-8222-222222222222',
    mode: 'consume',
    status: 'active',
    createdAt: '2026-07-23T01:02:00.000Z',
    updatedAt: '2026-07-23T01:02:00.000Z',
  });
  mocks.createTrialPending = false;
  mocks.pendingRetryAvailable = false;
  mocks.retryPending.mockResolvedValue(undefined);
  mocks.rechargeRequired = null;
  mocks.activeRechargeIntentId = null;
  mocks.resumeAfterRecharge.mockResolvedValue(undefined);
  mocks.streamingText = null;
  mocks.streamConnectionFailed = false;
});

describe('ChatPage studio experience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detail = sessionDetail('studio');
    mocks.running = false;
    mocks.activeRunId = null;
    mocks.terminalRun = null;
    mocks.errorMessage = null;
    mocks.artifact = null;
  });

  it('shows an honest UI-design first screen and returns to My Agent', () => {
    renderPage('/session/11111111-1111-4111-8111-111111111111?returnTo=%2Fcreate%2Fcapabilities');

    expect(screen.getByRole('heading', { level: 1, name: '周报助手 UI' })).toBeInTheDocument();
    expect(screen.getByText('UI 设计')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: '保存状态：尚未生成' })).toHaveAttribute(
      'aria-describedby',
      'rt-studio-save-help',
    );
    expect(
      screen.getByText('每次生成成功后会自动设为 Agent 当前 UI，无需手动保存。'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '返回我的 Agent' })).toHaveAttribute(
      'href',
      '/capabilities',
    );
    expect(screen.getByRole('complementary', { name: 'UI 设计对话' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '描述第一版 UI' })).toHaveAttribute(
      'placeholder',
      '描述你想要的页面结构、交互和视觉…',
    );
    expect(screen.getByRole('button', { name: '生成第一版 UI' })).toBeDisabled();
    expect(screen.getByRole('region', { name: '当前系统默认页面' })).toHaveTextContent(
      '这个 Agent 还没有专属 UI',
    );
    expect(screen.getByRole('region', { name: '系统默认页面预览' })).toBeInTheDocument();
    expect(screen.getByText('仅预览 · 消费者默认页')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /本周工作/ })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: '表达风格' })).toBeDisabled();
    expect(screen.getByRole('option', { name: '精炼' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '补充要求' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '整理成管理层周报' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '开始生成 →' })).toBeDisabled();
    expect(screen.queryByRole('region', { name: '本次试用输入' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('session-sidebar')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '会话管理' })).not.toBeInTheDocument();
    expect(screen.queryByText('返回定价与发布')).not.toBeInTheDocument();
  });

  it('keeps the Studio revision loop connected to Agent pricing and publishing', () => {
    const release = '/capabilities/22222222-2222-4222-8222-222222222222/release/pricing';
    renderPage(
      `/session/11111111-1111-4111-8111-111111111111?returnTo=${encodeURIComponent(release)}`,
    );

    expect(screen.getByRole('button', { name: '下一步：定价与发布' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '返回我的 Agent' })).toHaveAttribute(
      'href',
      '/capabilities',
    );
  });

  it('does not show the pricing CTA for a non-release return target', () => {
    const task = '/tasks/018f47ea-bc32-7a3d-8f6e-2f90c7b01d43?from=trial';
    renderPage(
      `/session/11111111-1111-4111-8111-111111111111?returnTo=${encodeURIComponent(task)}`,
    );

    expect(screen.queryByRole('button', { name: '下一步：定价与发布' })).toBeNull();
  });

  it('keeps the first-generation state truthful and studio-specific', () => {
    mocks.running = true;
    renderPage('/session/11111111-1111-4111-8111-111111111111');

    expect(
      screen.getAllByRole('status').some((node) => node.textContent?.includes('正在生成第一版 UI')),
    ).toBe(true);
    expect(
      screen.queryByText(/理解页面与修改要求|整理页面版本|保留 Agent 能力/),
    ).not.toBeInTheDocument();
  });

  it('accepts mode=studio during mixed-version rollout', () => {
    mocks.detail = sessionDetail();
    renderPage('/session/11111111-1111-4111-8111-111111111111?mode=studio');

    expect(screen.getByRole('complementary', { name: 'UI 设计对话' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '当前系统默认页面' })).toBeInTheDocument();
  });

  it('keeps the default consumer preview after a failed turn produced no UI', () => {
    mocks.detail = {
      ...mocks.detail!,
      messages: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          seq: 1,
          turnId: '77777777-7777-4777-8777-777777777777',
          role: 'assistant',
          content: [{ type: 'text', text: '这轮没有生成页面。' }],
          status: 'completed',
          createdAt: '2026-07-23T00:30:00.000Z',
        },
      ],
    };
    mocks.terminalRun = {
      runId: '77777777-7777-4777-8777-777777777777',
      state: 'failed',
      message: '生成失败',
    };
    mocks.errorMessage = '生成失败';

    renderPage('/session/11111111-1111-4111-8111-111111111111');

    expect(screen.getByRole('region', { name: '当前系统默认页面' })).toBeInTheDocument();
    expect(screen.queryByText('还没有可预览的 UI')).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: '保存状态：本轮未保存' })).toBeInTheDocument();
  });

  it('does not send a business run into the Studio design conversation', () => {
    const seededArtifact: ArtifactView = {
      id: '33333333-3333-4333-8333-333333333333',
      kind: 'html',
      title: '周报助手页面',
      createdAt: '2026-07-23T01:00:00.000Z',
      updatedAt: '2026-07-23T01:00:00.000Z',
    };
    mocks.detail = {
      ...mocks.detail!,
      artifacts: [seededArtifact],
      currentUiArtifactId: seededArtifact.id,
    };
    renderPage('/session/11111111-1111-4111-8111-111111111111');
    const frame = screen.getByTitle('周报助手页面') as HTMLIFrameElement;
    const download = screen.getByRole('button', { name: '导出 HTML' });
    expect(download).toHaveAttribute(
      'title',
      '导出当前 UI 的静态 HTML 文件，不包含 Agent 运行能力',
    );
    expect(download).toHaveAttribute(
      'aria-describedby',
      `rt-artifact-download-help-${seededArtifact.id}`,
    );
    expect(screen.getByRole('status', { name: '保存状态：已自动保存' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '当前系统默认页面' })).not.toBeInTheDocument();

    fireEvent(
      window,
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: { type: 'combo:run', version: 1, prompt: '生成本周周报' },
      }),
    );

    expect(mocks.send).not.toHaveBeenCalled();
    expect(
      screen.getByText('当前是 UI 设计预览。请返回「我的 Agent」，从真实试用运行 Agent。'),
    ).toBeInTheDocument();
  });

  it('does not present an old current UI as newly saved after a transport error', () => {
    const currentArtifact: ArtifactView = {
      id: '33333333-3333-4333-8333-333333333333',
      kind: 'html',
      title: '周报助手页面',
      createdAt: '2026-07-23T01:00:00.000Z',
      updatedAt: '2026-07-23T01:00:00.000Z',
    };
    mocks.detail = {
      ...mocks.detail!,
      artifacts: [currentArtifact],
      currentUiArtifactId: currentArtifact.id,
    };
    mocks.errorMessage = '发送失败，请重试。';

    renderPage('/session/11111111-1111-4111-8111-111111111111');

    expect(screen.getByRole('status', { name: '保存状态：保存状态待确认' })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: '保存状态：已自动保存' })).not.toBeInTheDocument();
  });

  it('restores an active Studio turn after reload', () => {
    mocks.detail = {
      ...mocks.detail!,
      activeTurn: {
        id: '77777777-7777-4777-8777-777777777777',
        createdAt: '2026-07-23T00:30:00.000Z',
      },
    };

    renderPage('/session/11111111-1111-4111-8111-111111111111');

    expect(screen.getByRole('status', { name: '保存状态：正在生成并保存…' })).toBeInTheDocument();
    expect(
      screen
        .getAllByRole('status')
        .some((status) => status.textContent?.includes('正在生成第一版 UI')),
    ).toBe(true);
  });

  it('shows ordered revisions, marks current UI, and creates a consume trial', async () => {
    const releaseReturnTo = '/capabilities/018f47ea-bc32-7a3d-8f6e-2f90c7b01d43/release/review';
    const first: ArtifactView = {
      id: '33333333-3333-4333-8333-333333333333',
      kind: 'html',
      title: '第一版',
      sourceTurnId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt: '2026-07-23T01:00:00.000Z',
      updatedAt: '2026-07-23T01:00:00.000Z',
    };
    const current: ArtifactView = {
      id: '44444444-4444-4444-8444-444444444444',
      kind: 'html',
      title: '第二版',
      sourceTurnId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      createdAt: '2026-07-23T02:00:00.000Z',
      updatedAt: '2026-07-23T02:00:00.000Z',
    };
    mocks.detail = {
      ...mocks.detail!,
      artifacts: [first, current],
      currentUiArtifactId: current.id,
    };

    renderPage(
      `/session/11111111-1111-4111-8111-111111111111?returnTo=${encodeURIComponent(releaseReturnTo)}`,
    );

    expect(screen.getByLabelText('UI 版本历史')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /版本 1/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /版本 2.*当前 UI/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '试用当前 UI' }));
    await waitFor(() =>
      expect(mocks.createTrial).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222'),
    );
    const studioReturnTo = `/try/session/11111111-1111-4111-8111-111111111111?mode=studio&returnTo=${encodeURIComponent(releaseReturnTo)}`;
    await waitFor(() =>
      expect(screen.getByTestId('location-probe')).toHaveTextContent(
        `/session/88888888-8888-4888-8888-888888888888?returnTo=${encodeURIComponent(studioReturnTo)}`,
      ),
    );
  });

  it('selects a bounded iframe element and scopes the next accepted edit to it', async () => {
    const current: ArtifactView = {
      id: '33333333-3333-4333-8333-333333333333',
      kind: 'html',
      title: '周报助手页面',
      createdAt: '2026-07-23T01:00:00.000Z',
      updatedAt: '2026-07-23T01:00:00.000Z',
    };
    mocks.detail = {
      ...mocks.detail!,
      artifacts: [current],
      currentUiArtifactId: current.id,
    };
    renderPage('/session/11111111-1111-4111-8111-111111111111');
    const frame = screen.getByTitle('周报助手页面') as HTMLIFrameElement;
    fireEvent.click(screen.getByRole('button', { name: '选择页面元素' }));
    expect(screen.getByRole('button', { name: '取消选择元素' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent(
      window,
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: {
          type: 'combo:element-select',
          version: 1,
          element: {
            key: 'result-main',
            label: '主要结果',
            role: 'region',
            text: '三项工作',
            tagName: 'section',
            path: 'body > main:nth-of-type(1) > section:nth-of-type(1)',
            stableKey: true,
          },
        },
      }),
    );
    expect(screen.getByText(/已选「主要结果」/)).toBeInTheDocument();

    const composer = screen.getByRole('textbox', { name: '描述页面修改' });
    fireEvent.change(composer, { target: { value: '把这里改得更清楚' } });
    fireEvent.click(screen.getByRole('button', { name: '发送修改' }));

    await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    expect(mocks.send.mock.calls[0]?.[0]).toContain('data-combo-key="result-main"');
    expect(mocks.send.mock.calls[0]?.[0]).toContain('把这里改得更清楚');
    await waitFor(() => expect(screen.queryByText(/已选「主要结果」/)).not.toBeInTheDocument());
  });

  it('routes a design operation through the current Studio conversation', async () => {
    const current: ArtifactView = {
      id: '33333333-3333-4333-8333-333333333333',
      kind: 'html',
      title: '周报助手页面',
      createdAt: '2026-07-23T01:00:00.000Z',
      updatedAt: '2026-07-23T01:00:00.000Z',
    };
    mocks.detail = {
      ...mocks.detail!,
      artifacts: [current],
      currentUiArtifactId: current.id,
    };
    renderPage('/session/11111111-1111-4111-8111-111111111111');

    fireEvent.click(screen.getByRole('button', { name: '检查并修好' }));

    await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    expect(mocks.send.mock.calls[0]?.[0]).toContain('[COMBO_DESIGN_OPERATION:critique]');
  });
});

describe('ChatPage controlled knowledge experience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detail = knowledgeSessionDetail();
    mocks.running = false;
    mocks.activeRunId = null;
    mocks.terminalRun = null;
    mocks.errorMessage = null;
    mocks.streamingText = null;
    mocks.artifact = null;
  });

  it('recognizes an empty bound Session and mounts one full-height knowledge conversation', () => {
    mocks.artifact = {
      id: '77777777-7777-4777-8777-777777777777',
      kind: 'html',
      title: 'FORGED_ARTIFACT_TITLE',
      createdAt: '2026-08-30T01:00:00.000Z',
      updatedAt: '2026-08-30T01:00:00.000Z',
    };

    const page = renderPage('/session/11111111-1111-4111-8111-111111111111');

    expect(screen.getByRole('heading', { level: 1, name: 'Combo 知识助手' })).toBeInTheDocument();
    expect(screen.getByText('已发布知识 · 权威使用收据')).toBeInTheDocument();
    expect(screen.getByTestId('session-sidebar')).toHaveAttribute('data-experience', 'knowledge');
    expect(screen.getByRole('region', { name: '知识问答' })).toBeInTheDocument();
    expect(screen.getByText('从一个问题开始').closest('[role="status"]')).toBeInTheDocument();
    expect(page.container.querySelector('.rt-knowledge-layout')).toBeInTheDocument();
    expect(page.container.querySelector('.rt-genui__canvas')).not.toBeInTheDocument();
    expect(screen.queryByText('FORGED_ARTIFACT_TITLE')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '开始生成 →' })).not.toBeInTheDocument();
  });

  it('restores only the authoritative result and hides forged Message, SSE, error, and artifact data', () => {
    const user: MessageView = {
      id: '77777777-7777-4777-8777-777777777777',
      seq: 1,
      turnId: '55555555-5555-4555-8555-555555555555',
      role: 'user',
      content: [{ type: 'text', text: '用户刷新前的问题' }],
      status: 'completed',
      createdAt: '2026-08-30T01:00:00.000Z',
    };
    const forgedAssistant: MessageView = {
      id: '88888888-8888-4888-8888-888888888888',
      seq: 2,
      turnId: '55555555-5555-4555-8555-555555555555',
      role: 'assistant',
      content: [
        { type: 'text', text: 'FORGED_ASSISTANT_CANDIDATE' },
        { type: 'toolResult', text: 'FORGED_TOOL_CANDIDATE' },
      ],
      status: 'completed',
      createdAt: '2026-08-30T01:00:01.000Z',
    };
    mocks.detail = knowledgeSessionDetail([user, forgedAssistant], [knowledgeResult()]);
    mocks.streamingText = 'FORGED_SSE_CANDIDATE';
    mocks.errorMessage = 'FORGED_SSE_ERROR';
    mocks.artifact = {
      id: '99999999-9999-4999-8999-999999999999',
      kind: 'html',
      title: 'FORGED_ARTIFACT_TITLE',
      createdAt: '2026-08-30T01:00:00.000Z',
      updatedAt: '2026-08-30T01:00:00.000Z',
    };

    renderPage('/session/11111111-1111-4111-8111-111111111111');

    expect(screen.getByText('用户刷新前的问题')).toBeInTheDocument();
    expect(screen.getByText('AUTHORITATIVE_KNOWLEDGE_ANSWER')).toBeInTheDocument();
    expect(screen.getByText('Combo 产品基线')).toBeInTheDocument();
    expect(screen.getByText('使用收据 · 钱包 · 实际结算 ¥1.00')).toBeInTheDocument();
    expect(screen.queryByText('FORGED_ASSISTANT_CANDIDATE')).not.toBeInTheDocument();
    expect(screen.queryByText('FORGED_TOOL_CANDIDATE')).not.toBeInTheDocument();
    expect(screen.queryByText('FORGED_SSE_CANDIDATE')).not.toBeInTheDocument();
    expect(screen.queryByText('FORGED_SSE_ERROR')).not.toBeInTheDocument();
    expect(screen.queryByText('FORGED_ARTIFACT_TITLE')).not.toBeInTheDocument();
  });

  it('fails closed when a bound knowledge detail omits its authoritative result collection', () => {
    const missingResults = knowledgeSessionDetail();
    delete missingResults.knowledgeResults;
    mocks.detail = missingResults;

    renderPage('/session/11111111-1111-4111-8111-111111111111');

    expect(screen.getByRole('alert')).toHaveTextContent('缺少权威知识结果');
    expect(screen.getByRole('textbox', { name: '输入知识问题' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '开始生成 →' })).not.toBeInTheDocument();
  });

  it('keeps credited recharge resume bound to the persisted replacement intent', async () => {
    mocks.rechargeRequired = {
      rechargeRequired: true,
      rechargeIntentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      balanceCents: '0',
      requiredCents: '100',
    };
    mocks.activeRechargeIntentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    renderPage('/session/11111111-1111-4111-8111-111111111111');

    expect(screen.getByTestId('recharge-dialog')).toHaveAttribute(
      'data-active-intent',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    );
    fireEvent.click(screen.getByRole('button', { name: '模拟到账' }));
    await waitFor(() =>
      expect(mocks.resumeAfterRecharge).toHaveBeenCalledWith(
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      ),
    );
    expect(mocks.abandonRechargeUsage).not.toHaveBeenCalled();
  });

  it('clears a 402 draft only after the same credited usage resumes successfully', async () => {
    mocks.send.mockRejectedValueOnce(new Error('免费次数已用完，充值后可继续使用。'));
    const url = '/session/11111111-1111-4111-8111-111111111111';
    const page = renderPage(url);

    const textbox = screen.getByRole('textbox', { name: '输入知识问题' });
    fireEvent.change(textbox, { target: { value: '必须只结算一次的问题' } });
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('免费次数已用完'));
    expect(textbox).toHaveValue('必须只结算一次的问题');

    mocks.rechargeRequired = {
      rechargeRequired: true,
      rechargeIntentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      balanceCents: '0',
      requiredCents: '100',
    };
    mocks.activeRechargeIntentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    page.rerender(pageElement(url));
    fireEvent.click(screen.getByRole('button', { name: '模拟到账' }));
    await waitFor(() => expect(mocks.resumeAfterRecharge).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(page.container.querySelector('textarea[aria-label="输入知识问题"]')).toHaveValue(''),
    );
    expect(page.container.querySelector('.rt-knowledge-alert')).not.toBeInTheDocument();
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('preserves the 402 draft when credited resume remains uncertain', async () => {
    mocks.send.mockRejectedValueOnce(new Error('免费次数已用完，充值后可继续使用。'));
    mocks.resumeAfterRecharge.mockRejectedValueOnce(new Error('原 usageId 仍在确认。'));
    const url = '/session/11111111-1111-4111-8111-111111111111';
    const page = renderPage(url);

    const textbox = screen.getByRole('textbox', { name: '输入知识问题' });
    fireEvent.change(textbox, { target: { value: '失败后仍要保留的问题' } });
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('免费次数已用完'));

    mocks.rechargeRequired = {
      rechargeRequired: true,
      rechargeIntentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      balanceCents: '0',
      requiredCents: '100',
    };
    mocks.activeRechargeIntentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    page.rerender(pageElement(url));
    fireEvent.click(screen.getByRole('button', { name: '模拟到账' }));
    await waitFor(() => expect(mocks.resumeAfterRecharge).toHaveBeenCalledOnce());
    expect(page.container.querySelector('textarea[aria-label="输入知识问题"]')).toHaveValue(
      '失败后仍要保留的问题',
    );
    expect(page.container.querySelector('.rt-knowledge-alert')).toHaveTextContent('免费次数已用完');
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('shows a fixed reconnect action without exposing a stream-provided error string', () => {
    mocks.streamConnectionFailed = true;
    mocks.errorMessage = 'FORGED_SSE_ERROR';
    const user: MessageView = {
      id: '77777777-7777-4777-8777-777777777777',
      seq: 1,
      turnId: '55555555-5555-4555-8555-555555555555',
      role: 'user',
      content: [{ type: 'text', text: '等待权威结果的问题' }],
      status: 'completed',
      createdAt: '2026-08-30T01:00:00.000Z',
    };
    mocks.detail = knowledgeSessionDetail([user]);
    renderPage('/session/11111111-1111-4111-8111-111111111111');

    expect(screen.getByRole('alert')).toHaveTextContent('实时连接已中断');
    expect(screen.queryByText('FORGED_SSE_ERROR')).not.toBeInTheDocument();
    expect(screen.queryByText('正在确认权威结果')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }));
    expect(mocks.retryStreamConnection).toHaveBeenCalledOnce();
  });
});

describe('ChatPage consume Miniapp bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detail = sessionDetail('consume');
    mocks.running = false;
    mocks.activeRunId = null;
    mocks.terminalRun = null;
    mocks.errorMessage = null;
    mocks.artifact = {
      id: '33333333-3333-4333-8333-333333333333',
      kind: 'html',
      title: '周报助手页面',
      createdAt: '2026-07-23T01:00:00.000Z',
      updatedAt: '2026-07-23T01:00:00.000Z',
    };
  });

  it('keeps a task-detail return target across a session-page reload', () => {
    const sessionPath = '/session/11111111-1111-4111-8111-111111111111';
    const taskReturnTo = '/tasks/018f47ea-bc32-7a3d-8f6e-2f90c7b01d43';
    const first = renderPage(`${sessionPath}?returnTo=${encodeURIComponent(taskReturnTo)}`);

    expect(screen.getByTestId('session-sidebar')).toHaveAttribute('data-return-to', taskReturnTo);
    expect(screen.getByRole('button', { name: '返回提取结果' })).toBeInTheDocument();

    first.unmount();
    renderPage(sessionPath);

    expect(screen.getByTestId('session-sidebar')).toHaveAttribute('data-return-to', taskReturnTo);
    expect(screen.getByRole('button', { name: '返回提取结果' })).toBeInTheDocument();
  });

  it('labels a trial return to its originating Studio session', () => {
    const releaseReturn = '/capabilities/018f47ea-bc32-7a3d-8f6e-2f90c7b01d43/release/review';
    const studioReturn = `/try/session/11111111-1111-4111-8111-111111111111?mode=studio&returnTo=${encodeURIComponent(releaseReturn)}`;
    renderPage(
      `/session/99999999-9999-4999-8999-999999999999?returnTo=${encodeURIComponent(studioReturn)}`,
    );

    expect(screen.getByRole('button', { name: '返回 UI 设计' })).toBeInTheDocument();
    expect(screen.getByTestId('session-sidebar')).toHaveAttribute('data-return-to', studioReturn);
  });

  it('forwards a host-confirmed Miniapp request to the real session stream', async () => {
    mocks.send.mockResolvedValue({
      id: '44444444-4444-4444-8444-444444444444',
      seq: 1,
      turnId: '55555555-5555-4555-8555-555555555555',
      role: 'user',
      content: [{ type: 'text', text: '生成本周周报' }],
      status: 'completed',
      createdAt: '2026-07-23T01:01:00.000Z',
    });
    renderPage('/session/11111111-1111-4111-8111-111111111111');
    const frame = screen.getByTitle('周报助手页面') as HTMLIFrameElement;
    expect(screen.getByTestId('session-sidebar')).toHaveAttribute('data-experience', 'consume');
    expect(screen.getByRole('button', { name: '会话管理' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载 HTML' })).toBeInTheDocument();
    expect(screen.queryByText('仅预览 · 消费者默认页')).not.toBeInTheDocument();
    expect(screen.queryByText('UI 设计')).not.toBeInTheDocument();

    fireEvent(
      window,
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: { type: 'combo:run', version: 1, prompt: '  生成本周周报  ' },
      }),
    );

    expect(mocks.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认运行' }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    expect(mocks.send).toHaveBeenCalledWith('生成本周周报');
  });
});

describe('ChatPage consume intake regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detail = sessionDetail('consume');
    mocks.running = false;
    mocks.activeRunId = null;
    mocks.terminalRun = null;
    mocks.errorMessage = null;
    mocks.artifact = null;
    mocks.send.mockResolvedValue({
      id: '44444444-4444-4444-8444-444444444444',
      seq: 1,
      turnId: '55555555-5555-4555-8555-555555555555',
      role: 'user',
      content: [{ type: 'text', text: '生成周报' }],
      status: 'completed',
      createdAt: '2026-07-23T01:01:00.000Z',
    });
  });

  it('binds credited and replacement actions to the persisted active intent, not abandon', async () => {
    mocks.rechargeRequired = {
      rechargeRequired: true,
      rechargeIntentId: '77777777-7777-4777-8777-777777777777',
      balanceCents: '25',
      requiredCents: '100',
    };
    mocks.activeRechargeIntentId = '88888888-8888-4888-8888-888888888888';
    renderPage('/session/11111111-1111-4111-8111-111111111111');

    expect(screen.getByTestId('recharge-dialog')).toHaveAttribute(
      'data-active-intent',
      '88888888-8888-4888-8888-888888888888',
    );
    fireEvent.click(screen.getByRole('button', { name: '模拟到账' }));
    await waitFor(() =>
      expect(mocks.resumeAfterRecharge).toHaveBeenCalledWith(
        '88888888-8888-4888-8888-888888888888',
      ),
    );
    expect(mocks.abandonRechargeUsage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '模拟替换订单' }));
    expect(mocks.setActiveRechargeIntent).toHaveBeenCalledWith(
      '99999999-9999-4999-8999-999999999999',
    );
  });

  it('offers a safe retry entry even before the first consumer conversation exists', async () => {
    mocks.pendingRetryAvailable = true;
    renderPage('/session/11111111-1111-4111-8111-111111111111');

    const originalDraft = screen.getByRole('textbox', { name: /本周工作/ });
    fireEvent.change(originalDraft, { target: { value: '不会再次发送的旧草稿' } });
    expect(screen.getByText(/上一次发送结果仍待确认/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试原任务' }));
    await waitFor(() => expect(mocks.retryPending).toHaveBeenCalledOnce());
    expect(screen.getByRole('textbox', { name: /本周工作/ })).toHaveValue('');
  });

  it('keeps the consumer form interactive and sends its structured prompt', async () => {
    renderPage('/session/11111111-1111-4111-8111-111111111111');

    expect(screen.getByTestId('session-sidebar')).toHaveAttribute('data-experience', 'consume');
    expect(screen.getByRole('button', { name: '会话管理' })).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: '开始生成 →' });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByRole('textbox', { name: /本周工作/ }), {
      target: { value: '完成 Studio 体验修复' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: '表达风格' }), {
      target: { value: '精炼' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '补充要求' }), {
      target: { value: '突出风险与验收结果' },
    });

    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    expect(mocks.send).toHaveBeenCalledWith(
      '请基于这些输入生成第一版产物。\n\n本周工作：完成 Studio 体验修复\n表达风格：精炼\n补充要求：突出风险与验收结果',
    );
  });
});
