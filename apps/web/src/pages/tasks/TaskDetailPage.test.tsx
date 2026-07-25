// 任务详情测试：SSE 实时进度（快照点亮 + progress + item-appended + done 终态刷新）与失败重试。
import { describe, it, expect, afterEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installFetchMock, type FetchMock } from '../../test/mockFetch.js';
import { MockFetchEventSource } from '../../test/mockFetchEventSource.js';
import { __setFetchEventSourceForTests } from '../../api/index.js';
import { makeTask, makeCapability, envelopeBody } from '../../test/fixtures.js';
import { renderPage } from '../../test/renderWithProviders.js';
import { TaskDetailPage } from './TaskDetailPage.js';

let fm: FetchMock | undefined;
let restoreSse: (() => void) | undefined;
afterEach(() => {
  fm?.restore();
  fm = undefined;
  restoreSse?.();
  restoreSse = undefined;
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

    // item-appended：触发能力列表重拉，新能力项就地浮现（勾选行卡 + 试用入口，默认全选）。
    act(() => conn.emit('item-appended', { item: cap1 }, { id: '3-1' }));
    act(() => conn.emit('item-appended', { item: cap2 }, { id: '3-2' }));
    expect(await screen.findByText('周报整理')).toBeInTheDocument();
    expect(await screen.findByText('代码评审')).toBeInTheDocument();
    // 非规范测试 id 不跨 bundle 传播；生产 UUID 会由专门的 returnTo 契约覆盖。
    expect(screen.getAllByRole('link', { name: '试用 →' })[0]).toHaveAttribute('href', '/try/c/c1');
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getAllByRole('checkbox').every((el) => (el as HTMLInputElement).checked)).toBe(
      true,
    );

    // done 帧 → 重拉任务定格终态 → 整页切换成成果形态（大标题 + 挑选发布区）。
    act(() =>
      conn.emit('done', { status: 'succeeded', result: { capabilityCount: 2 } }, { id: '4-1' }),
    );
    expect(
      await screen.findByRole('heading', { name: '你的能力，挑选后一键发布' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/这次上传共提取出 2/)).toBeInTheDocument();
    expect(screen.getByText('周报整理')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '能力页' })).toHaveAttribute('href', '/capabilities');
    expect(screen.getByRole('button', { name: '一键发布到市集 · 2 项' })).toBeInTheDocument();
  });
});

describe('TaskDetailPage — 挑选与一键发布', () => {
  it('默认全选，一键发布逐项 POST，状态槽变已发布并显示分享令牌', async () => {
    restoreSse = __setFetchEventSourceForTests(MockFetchEventSource.impl);
    const succeeded = makeTask({ ...RUNNING, status: 'succeeded', capabilityCount: 2 });
    const cap1 = makeCapability({ id: 'c1', name: '周报整理' });
    const cap2 = makeCapability({ id: 'c2', name: '代码评审' });
    fm = installFetchMock([
      { status: 200, json: envelopeBody(succeeded) },
      { match: '/capabilities?', status: 200, json: envelopeBody([cap1, cap2]) },
      {
        match: '/capabilities/c1/publish',
        status: 200,
        json: envelopeBody({ id: 'c1', published: true, shareToken: 'tok-1' }),
      },
      {
        match: '/capabilities/c2/publish',
        status: 200,
        json: envelopeBody({ id: 'c2', published: true, shareToken: 'tok-2' }),
      },
    ]);
    renderDetail();

    // 成果形态：工具条默认全选。
    expect(
      await screen.findByRole('heading', { name: '你的能力，挑选后一键发布' }),
    ).toBeInTheDocument();
    expect(await screen.findAllByRole('checkbox')).toHaveLength(2);

    // 取消一项再选回来：计数跟着变。
    await userEvent.click(screen.getAllByRole('checkbox')[0]!);
    expect(screen.getByRole('button', { name: '一键发布到市集 · 1 项' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '全选' }));

    // 一键发布：逐项 POST，两张卡状态槽都变已发布 + 分享令牌。
    await userEvent.click(screen.getByRole('button', { name: '一键发布到市集 · 2 项' }));
    expect(await screen.findAllByText('已发布')).toHaveLength(2);
    // 状态槽展示的是完整试用链接（裸 shareToken 无路由可消费）。
    expect(screen.getByText(`${window.location.origin}/try/c/c1`)).toBeInTheDocument();
    expect(screen.getByText(`${window.location.origin}/try/c/c2`)).toBeInTheDocument();
    expect(screen.getByText(/已发布 2 \/ 2 个能力/)).toBeInTheDocument();

    const posts = fm.calls.filter((c) => c.method === 'POST').map((c) => c.url);
    expect(posts).toEqual(['/api/v1/capabilities/c1/publish', '/api/v1/capabilities/c2/publish']);
  });
});

describe('TaskDetailPage — 失败与重试', () => {
  it('失败任务显示 lastError 人话 + 重试按钮；重试 POST 后回到跑态', async () => {
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
    expect(screen.getByRole('link', { name: '重新上传' })).toHaveAttribute('href', '/tasks');
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    expect(fm.calls.every((call) => call.method === 'GET')).toBe(true);
  });
});
