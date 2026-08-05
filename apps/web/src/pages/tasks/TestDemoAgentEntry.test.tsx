import type { ReleaseMetadata } from '@cb/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { ReleaseMetadataProvider } from '../../shell/releaseIdentity.js';
import { envelopeBody, makeTask, paginatedBody } from '../../test/fixtures.js';
import { installFetchMock, type FetchMock, type MockResponseSpec } from '../../test/mockFetch.js';
import { renderPage } from '../../test/renderWithProviders.js';
import { TaskDetailPage } from './TaskDetailPage.js';
import { TasksPage } from './TasksPage.js';
import { TestDemoAgentEntry } from './TestDemoAgentEntry.js';

const TEST_METADATA: ReleaseMetadata = {
  schemaVersion: 1,
  environment: 'test',
  sourceSha: 'a'.repeat(40),
  releaseId: `release-${'a'.repeat(40)}`,
  builtAt: '2026-08-05T00:00:00.000Z',
  releaseManifestDigest: `sha256:${'b'.repeat(64)}`,
  webAssetManifest: `sha256:${'c'.repeat(64)}`,
};

let fm: FetchMock | undefined;
afterEach(() => {
  fm?.restore();
  fm = undefined;
  vi.restoreAllMocks();
});

function TestRelease({ children }: { children: ReactNode }) {
  return <ReleaseMetadataProvider metadata={TEST_METADATA}>{children}</ReleaseMetadataProvider>;
}

function DemoEntryWithPath() {
  const location = useLocation();
  return (
    <TestRelease>
      <span data-testid="path">{location.pathname + location.search}</span>
      <TestDemoAgentEntry placement="tasks" />
    </TestRelease>
  );
}

describe('TestDemoAgentEntry — 环境边界与串行种子', () => {
  it('只在 Test 发布中出现，Preview 和 Production 都不展示', () => {
    for (const environment of ['preview', 'production'] as const) {
      const { unmount } = renderPage(
        <ReleaseMetadataProvider metadata={{ ...TEST_METADATA, environment }}>
          <TestDemoAgentEntry placement="tasks" />
        </ReleaseMetadataProvider>,
      );
      expect(screen.queryByLabelText('Test 演示 Agent')).toBeNull();
      unmount();
    }

    renderPage(
      <TestRelease>
        <TestDemoAgentEntry placement="tasks" />
      </TestRelease>,
    );
    expect(screen.getByLabelText('Test 演示 Agent')).toHaveTextContent('Test 演示数据');
    expect(screen.getByLabelText('Test 演示 Agent')).toHaveTextContent('不影响当前上传');
  });

  it('先准备 Authoring 数据，再用 capabilityId 准备 Runtime，并进入演示任务详情', async () => {
    fm = installFetchMock([
      {
        match: '/test/demo-agents/combo-miniapp',
        status: 201,
        json: envelopeBody({ taskId: 'task-demo', capabilityId: 'cap-demo', reused: false }),
      },
      {
        match: '/runtime/test/demo-agents/combo-miniapp',
        status: 201,
        json: envelopeBody({ studioSessionId: 'studio-demo', reused: false }),
      },
    ]);

    renderPage(<DemoEntryWithPath />, { route: '/tasks' });
    await userEvent.click(screen.getByRole('button', { name: '载入演示 Agent' }));

    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/tasks/task-demo'));
    const posts = fm.calls.filter((call) => call.method === 'POST');
    expect(posts.map((call) => call.url)).toEqual([
      '/api/v1/test/demo-agents/combo-miniapp',
      '/api/v1/runtime/test/demo-agents/combo-miniapp',
    ]);
    expect(posts[0]?.body).toEqual({});
    expect(posts[1]?.body).toEqual({ capabilityId: 'cap-demo' });
  });

  it('准备中给明确反馈；失败后可从同一位置重试', async () => {
    let resolveAuthoring!: (response: MockResponseSpec) => void;
    const pendingAuthoring = new Promise<MockResponseSpec>((resolve) => {
      resolveAuthoring = resolve;
    });
    fm = installFetchMock([
      { match: '/test/demo-agents/combo-miniapp', deferred: pendingAuthoring },
      {
        match: '/runtime/test/demo-agents/combo-miniapp',
        status: 503,
        json: {
          error: {
            userMessage: '演示 Agent 暂时没准备好，请重试。',
            retriable: true,
            action: 'retry',
            traceId: 'trace-demo',
          },
        },
      },
      {
        match: '/test/demo-agents/combo-miniapp',
        status: 200,
        json: envelopeBody({ taskId: 'task-demo', capabilityId: 'cap-demo', reused: true }),
      },
      {
        match: '/runtime/test/demo-agents/combo-miniapp',
        status: 200,
        json: envelopeBody({ studioSessionId: 'studio-demo', reused: true }),
      },
    ]);

    renderPage(<DemoEntryWithPath />, { route: '/tasks' });
    await userEvent.click(screen.getByRole('button', { name: '载入演示 Agent' }));
    expect(screen.getByRole('button', { name: '正在准备演示 Agent…' })).toBeDisabled();

    resolveAuthoring({
      status: 200,
      json: envelopeBody({ taskId: 'task-demo', capabilityId: 'cap-demo', reused: false }),
    });
    expect(await screen.findByText('演示 Agent 暂时没准备好，请重试。')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/tasks/task-demo'));
    expect(fm.calls.filter((call) => call.method === 'POST')).toHaveLength(4);
  });
});

describe('TestDemoAgentEntry — 页面入口', () => {
  it('任务列表把演示入口放在正式创建方式之外', async () => {
    fm = installFetchMock({ status: 200, json: paginatedBody([]) });
    renderPage(
      <TestRelease>
        <TasksPage />
      </TestRelease>,
      { route: '/tasks' },
    );

    expect(await screen.findByRole('heading', { name: '用哪种方式创建 Agent？' })).toBeVisible();
    expect(screen.getByLabelText('Test 演示 Agent')).toHaveTextContent('直接体验后续链路');
    expect(screen.getAllByText('Test 演示数据')).toHaveLength(1);
  });

  it('等待上传的任务详情提供同一演示入口，并声明不会替换当前任务', async () => {
    const waiting = makeTask({
      id: 'task-waiting',
      currentStep: 'upload',
      status: 'running',
      upload: {
        status: 'pending',
        partsExpected: null,
        partsLanded: 0,
        pairingExpiresAt: '2099-08-05T12:00:00.000Z',
      },
    });
    fm = installFetchMock({ status: 200, json: envelopeBody(waiting) });
    renderPage(
      <TestRelease>
        <TaskDetailPage />
      </TestRelease>,
      { route: '/tasks/task-waiting', path: '/tasks/:taskId' },
    );

    expect(await screen.findByText('先体验完整的 Agent 链路')).toBeInTheDocument();
    expect(screen.getByLabelText('Test 演示 Agent')).toHaveTextContent('不影响当前上传');
    expect(screen.getByRole('button', { name: '载入演示 Agent' })).toBeEnabled();
  });

  it('已经进入提取阶段的任务详情不再显示上传阻塞捷径', async () => {
    const failedExtraction = makeTask({
      id: 'task-extract-failed',
      currentStep: 'extract',
      status: 'failed',
      upload: {
        status: 'processed',
        partsExpected: 12,
        partsLanded: 12,
        pairingExpiresAt: '2099-08-05T12:00:00.000Z',
      },
      lastError: {
        userMessage: '提取暂时失败，请重试。',
        retriable: true,
        action: 'retry',
        traceId: 'trace-extract',
      },
    });
    fm = installFetchMock({ status: 200, json: envelopeBody(failedExtraction) });
    renderPage(
      <TestRelease>
        <TaskDetailPage />
      </TestRelease>,
      { route: '/tasks/task-extract-failed', path: '/tasks/:taskId' },
    );

    expect(await screen.findByText('提取暂时失败，请重试。')).toBeInTheDocument();
    expect(screen.queryByLabelText('Test 演示 Agent')).toBeNull();
  });
});
