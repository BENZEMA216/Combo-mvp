// 任务详情测试：SSE 实时进度（快照点亮 + progress + item-appended + done 终态刷新）与失败重试。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { installFetchMock, type FetchMock } from '../../test/mockFetch.js';
import { MockFetchEventSource } from '../../test/mockFetchEventSource.js';
import { __setFetchEventSourceForTests } from '../../api/index.js';
import { makeTask, makeCapability, envelopeBody } from '../../test/fixtures.js';
import { renderPage } from '../../test/renderWithProviders.js';
import { TaskDetailPage } from './TaskDetailPage.js';
import { readTaskPairingReceipt, saveTaskPairingReceipt } from './taskPairingReceipt.js';

let fm: FetchMock | undefined;
let restoreSse: (() => void) | undefined;
afterEach(() => {
  fm?.restore();
  fm = undefined;
  restoreSse?.();
  restoreSse = undefined;
  vi.restoreAllMocks();
  sessionStorage.clear();
});

const RUNNING = makeTask({
  id: 't-1',
  description: '提取我的对话历史',
  currentStep: 'extract',
  status: 'running',
  upload: {
    status: 'processed',
    partsExpected: 5,
    partsLanded: 5,
    pairingExpiresAt: '2026-07-04T12:00:00.000Z',
  },
});

function renderDetail(): void {
  renderPage(<TaskDetailPage />, { route: '/tasks/t-1', path: '/tasks/:taskId' });
}

describe('TaskDetailPage — SSE 实时进度', () => {
  it('等待上传时从当前标签页恢复连接命令，并明确可以离开后继续', async () => {
    const waiting = makeTask({
      id: 't-1',
      description: '等待上传的任务',
      currentStep: 'upload',
      status: 'running',
      upload: {
        status: 'pending',
        partsExpected: null,
        partsLanded: 0,
        pairingExpiresAt: '2099-08-05T12:00:00.000Z',
      },
    });
    saveTaskPairingReceipt({
      taskId: 't-1',
      pairingCode: 'PAIR-RESTORED',
      pairingExpiresAt: waiting.upload.pairingExpiresAt,
    });
    fm = installFetchMock({ status: 200, json: envelopeBody(waiting) });

    renderDetail();

    expect(
      await screen.findByRole('heading', { name: '任务已保存，等待开始上传' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/你可以离开此页/)).toBeInTheDocument();
    expect(screen.getByText(/connect\/script\?code=PAIR-RESTORED/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制命令' })).toBeInTheDocument();
  });

  it('没有本地连接命令时提供真实兜底，不让用户面对不可持续等待', async () => {
    const waiting = makeTask({
      id: 't-1',
      description: '等待上传的任务',
      upload: {
        status: 'pending',
        partsExpected: null,
        partsLanded: 0,
        pairingExpiresAt: '2099-08-05T12:00:00.000Z',
      },
    });
    fm = installFetchMock({ status: 200, json: envelopeBody(waiting) });

    renderDetail();

    expect(await screen.findByText('当前标签页没有保留这项任务的连接命令。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '选择创建方式' })).toHaveAttribute(
      'href',
      '/tasks?create=1',
    );
  });

  it('绝不把另一项任务的连接命令显示在当前任务', async () => {
    const waiting = makeTask({
      id: 't-1',
      upload: {
        status: 'pending',
        partsExpected: null,
        partsLanded: 0,
        pairingExpiresAt: '2099-08-05T12:00:00.000Z',
      },
    });
    saveTaskPairingReceipt({
      taskId: 'another-task',
      pairingCode: 'PAIR-WRONG-TASK',
      pairingExpiresAt: waiting.upload.pairingExpiresAt,
    });
    fm = installFetchMock({ status: 200, json: envelopeBody(waiting) });

    renderDetail();

    expect(await screen.findByText('当前标签页没有保留这项任务的连接命令。')).toBeInTheDocument();
    expect(screen.queryByText(/PAIR-WRONG-TASK/)).toBeNull();
  });

  it('上传收齐后由轮询自动切到提取加载态，不需要手动刷新', async () => {
    restoreSse = __setFetchEventSourceForTests(MockFetchEventSource.impl);
    const uploading = makeTask({
      id: 't-1',
      description: '正在上传的任务',
      currentStep: 'upload',
      status: 'running',
      upload: {
        status: 'pending',
        partsExpected: 5,
        partsLanded: 4,
        pairingExpiresAt: '2026-07-14T12:00:00.000Z',
      },
    });
    fm = installFetchMock([
      { match: /\/tasks\/t-1$/, status: 200, json: envelopeBody(uploading) },
      { match: /\/tasks\/t-1$/, status: 200, json: envelopeBody(RUNNING) },
      { match: '/capabilities', status: 200, json: envelopeBody([]) },
    ]);

    renderDetail();

    expect(await screen.findByText('本机助手正在上传 4 / 5 片')).toBeInTheDocument();
    // running 任务每 3 秒自动重拉；服务端进入 extract 后，同一路由自动挂提取 SSE 与骨架加载态。
    expect(
      await screen.findByRole('status', { name: '正在连接进度流' }, { timeout: 4_500 }),
    ).toBeInTheDocument();
    expect(MockFetchEventSource.last?.url).toBe('/api/v1/tasks/t-1/events');
  }, 6_000);

  it('state_snapshot 点亮子任务 → progress 更新 → item-appended 逐个显示 → done 终态刷新', async () => {
    restoreSse = __setFetchEventSourceForTests(MockFetchEventSource.impl);
    const succeeded = makeTask({ ...RUNNING, status: 'succeeded', capabilityCount: 2 });
    const cap1 = makeCapability({ id: 'c1', name: '周报整理' });
    const cap2 = makeCapability({ id: 'c2', name: '代码评审' });
    fm = installFetchMock([
      { status: 200, json: envelopeBody(RUNNING) },
      { status: 200, json: envelopeBody(succeeded) }, // done 后失效重拉
      // 能力项列表以库为真源：SSE item-appended 只触发重拉（先空，随后逐个出现）。
      { match: '/capabilities', status: 200, json: envelopeBody([]) },
      { match: '/capabilities', status: 200, json: envelopeBody([cap1, cap2]) },
    ]);
    renderDetail();

    await screen.findByText('提取我的对话历史');
    expect(screen.getByText('上传完成')).toBeInTheDocument();
    // SSE 首帧到达前也有结构化加载反馈，不出现空白等待区。
    expect(screen.getByRole('status', { name: '正在连接进度流' })).toBeInTheDocument();

    // 跑着的任务建了 SSE 流。
    const conn = MockFetchEventSource.last!;
    expect(conn.url).toBe('/api/v1/tasks/t-1/events');
    act(() => conn.open());

    // 首帧 state_snapshot：全量 progress + 子任务点亮。
    act(() =>
      conn.emit(
        'state_snapshot',
        {
          progress: {
            percent: 30,
            phrase: '正在切分会话段落…',
            subtasks: [
              { key: 'fetch', label: '读取上传内容', status: 'done' },
              { key: 'segment', label: '切分会话段落', status: 'running' },
            ],
          },
        },
        { id: '1-1' },
      ),
    );
    expect(screen.getByText('正在切分会话段落…')).toBeInTheDocument();
    expect(screen.getByText('读取上传内容')).toBeInTheDocument();

    // progress 增量帧：量化文案更新，子任务清单保留。
    act(() =>
      conn.emit('progress', { percent: 62, phrase: '已分析 6 / 10 段会话' }, { id: '2-1' }),
    );
    expect(screen.getByText('已分析 6 / 10 段会话')).toBeInTheDocument();
    expect(screen.getByText('切分会话段落')).toBeInTheDocument();

    // item-appended：触发能力列表重拉，新 Agent 就地浮现，可试用、调整 UI 或直接定价。
    act(() => conn.emit('item-appended', { item: cap1 }, { id: '3-1' }));
    act(() => conn.emit('item-appended', { item: cap2 }, { id: '3-2' }));
    expect(await screen.findByText('周报整理')).toBeInTheDocument();
    expect(await screen.findByText('代码评审')).toBeInTheDocument();
    // 非规范测试 id 不跨 bundle 传播；生产 UUID 会由专门的 returnTo 契约覆盖。
    expect(screen.getAllByRole('link', { name: '先试用' })[0]).toHaveAttribute('href', '/try/c/c1');
    expect(screen.getAllByRole('button', { name: /调整「.*」UI/ })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: /直接定价与发布/ })).toHaveLength(2);
    expect(screen.queryByRole('checkbox')).toBeNull();

    // done 帧 → 重拉任务定格终态 → 整页切换成成果形态（大标题 + 挑选发布区）。
    act(() =>
      conn.emit('done', { status: 'succeeded', result: { capabilityCount: 2 } }, { id: '4-1' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Agent 已准备好，先选一个真实试用' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/这次上传共提取出 2/)).toBeInTheDocument();
    expect(screen.getByText('周报整理')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '我的 Agent' })).toHaveAttribute(
      'href',
      '/capabilities',
    );
    expect(screen.getAllByRole('link', { name: /直接定价与发布/ })[0]).toHaveAttribute(
      'href',
      '/capabilities/c1/release/pricing',
    );
  });
});

describe('TaskDetailPage — 结果到发布链路', () => {
  it('按优先级展示 Agent，并且不会从结果页绕过验收直接发布', async () => {
    restoreSse = __setFetchEventSourceForTests(MockFetchEventSource.impl);
    const succeeded = makeTask({ ...RUNNING, status: 'succeeded', capabilityCount: 2 });
    const cap1 = makeCapability({ id: 'c1', name: '周报整理' });
    const cap2 = makeCapability({ id: 'c2', name: '代码评审' });
    fm = installFetchMock([
      { status: 200, json: envelopeBody(succeeded) },
      { match: '/capabilities?', status: 200, json: envelopeBody([cap1, cap2]) },
    ]);
    renderDetail();

    expect(
      await screen.findByRole('heading', { name: 'Agent 已准备好，先选一个真实试用' }),
    ).toBeInTheDocument();
    expect(await screen.findByLabelText('优先级 1')).toHaveTextContent('01');
    expect(screen.getByLabelText('优先级 2')).toHaveTextContent('02');
    expect(screen.getAllByRole('button', { name: /调整「.*」UI/ })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: /直接定价与发布/ })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /一键发布/ })).toBeNull();
    expect(fm.calls.every((call) => call.method === 'GET')).toBe(true);
  });
});

describe('TaskDetailPage — 失败与重试', () => {
  it('提取失败时不把已完成的上传误说成正在接收', async () => {
    const failed = makeTask({
      id: 't-1',
      currentStep: 'extract',
      status: 'failed',
      upload: {
        status: 'processed',
        partsExpected: 4,
        partsLanded: 4,
        pairingExpiresAt: '2099-08-05T12:00:00.000Z',
      },
      lastError: {
        userMessage: '提取暂时失败，请稍后重试。',
        retriable: true,
        action: 'retry',
        traceId: 'trace-extract-failed',
      },
    });
    saveTaskPairingReceipt({
      taskId: 't-1',
      pairingCode: 'PAIR-MUST-BE-CLEARED',
      pairingExpiresAt: failed.upload.pairingExpiresAt,
    });
    fm = installFetchMock({ status: 200, json: envelopeBody(failed) });

    renderDetail();

    expect(await screen.findByRole('heading', { name: 'Context 已上传' })).toBeInTheDocument();
    expect(screen.queryByText('正在接收对话历史')).toBeNull();
    expect(screen.getByText('提取暂时失败，请稍后重试。')).toBeInTheDocument();
    await waitFor(() => expect(readTaskPairingReceipt('t-1')).toBeNull());
  });

  it('失败任务显示 lastError 人话 + 重试按钮；重试 POST 后回到跑态', async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    restoreSse = __setFetchEventSourceForTests(MockFetchEventSource.impl);
    const failed = makeTask({
      ...RUNNING,
      status: 'failed',
      retryCount: 1,
      lastError: {
        userMessage: '这次处理超时了，点重试再来一次。',
        retriable: true,
        action: 'retry',
        traceId: 't-timeout',
      },
    });
    fm = installFetchMock([
      { status: 200, json: envelopeBody(failed) },
      { status: 200, json: envelopeBody(RUNNING) }, // POST retry 响应
      { match: '/capabilities', status: 200, json: envelopeBody([]) }, // 回跑态后的能力列表
    ]);
    renderDetail();

    expect(await screen.findByText('这次处理超时了，点重试再来一次。')).toBeInTheDocument();
    expect(screen.getByText('已重试 1 次。')).toBeInTheDocument();
    // 终态任务不建 SSE 流。
    expect(MockFetchEventSource.connections).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    const post = fm.calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('/api/v1/tasks/t-1/retry');

    // 重试成功 → 任务回 running（badge 变提取中），重新建流。
    expect(await screen.findByText('提取中')).toBeInTheDocument();
    expect(MockFetchEventSource.connections.length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['tasks'],
      }),
    );
  });

  it('过期上传任务显示失败原因与重新上传出口，不把旧配对码原地重试回 running', async () => {
    const expiredUpload = makeTask({
      id: 't-1',
      currentStep: 'upload',
      status: 'failed',
      lastError: {
        userMessage: '上传等待已超时，请重新上传。',
        retriable: false,
        action: 'change_input',
        traceId: 't-upload-expired',
      },
      upload: {
        status: 'expired',
        partsExpected: 505,
        partsLanded: 322,
        pairingExpiresAt: '2026-07-08T12:00:00.000Z',
      },
    });
    fm = installFetchMock({ status: 200, json: envelopeBody(expiredUpload) });

    renderDetail();

    expect(await screen.findByText('上传等待已超时，请重新上传。')).toBeInTheDocument();
    expect(screen.getByText('上传已超时；已接收 322 / 505 片，任务已停止')).toBeInTheDocument();
    expect(screen.getByLabelText('上传状态：上传已超时，任务已停止')).toBeInTheDocument();
    expect(screen.queryByText(/本机助手正在上传/)).toBeNull();
    expect(screen.getByText('失败')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '重新上传' })).toHaveAttribute(
      'href',
      '/tasks?create=1',
    );
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    expect(fm.calls.every((call) => call.method === 'GET')).toBe(true);
  });
});
