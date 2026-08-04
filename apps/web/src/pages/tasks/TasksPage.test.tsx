// 任务页测试：列表状态渲染（步骤/状态/分片进度/能力项数/失败原因）+ 新建任务出配对码与连接命令。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, useLocation } from 'react-router-dom';
import { installFetchMock, type FetchMock, type MockResponseSpec } from '../../test/mockFetch.js';
import { makeTask, paginatedBody, envelopeBody } from '../../test/fixtures.js';
import { renderPage } from '../../test/renderWithProviders.js';
import { TasksPage } from './TasksPage.js';
import { CREATION_INTAKE_STORAGE_KEY, readLandingDraft } from '../landing/landingDraft.js';
import { readTaskPairingReceipt } from './taskPairingReceipt.js';

function TasksWithPathProbe() {
  const location = useLocation();
  return (
    <>
      <span data-testid="path">{location.pathname + location.search}</span>
      <TasksPage />
    </>
  );
}

function TasksWithCreateIntentProbe() {
  const location = useLocation();
  return (
    <>
      <Link to="/tasks?create=1">模拟全局创建入口</Link>
      <span data-testid="path">{location.pathname + location.search}</span>
      <TasksPage />
    </>
  );
}

let fm: FetchMock | undefined;
afterEach(() => {
  fm?.restore();
  fm = undefined;
  vi.restoreAllMocks();
  sessionStorage.clear();
});

const UPLOADING = makeTask({
  id: 'task-up',
  description: '导入 Claude 项目历史',
  currentStep: 'upload',
  status: 'running',
  upload: {
    status: 'pending',
    partsExpected: 10,
    partsLanded: 3,
    pairingExpiresAt: '2026-07-04T12:00:00.000Z',
  },
});

const EXTRACTING = makeTask({
  id: 'task-ex',
  description: '提取中的任务',
  currentStep: 'extract',
  status: 'running',
  upload: {
    status: 'processed',
    partsExpected: 10,
    partsLanded: 10,
    pairingExpiresAt: '2026-07-04T12:00:00.000Z',
  },
});

const FAILED = makeTask({
  id: 'task-fail',
  description: '失败的任务',
  currentStep: 'extract',
  status: 'failed',
  lastError: {
    userMessage: '模型服务暂时不可用，请稍后重试。',
    retriable: true,
    action: 'retry',
    traceId: 't-fail',
  },
});

const EXPIRED = makeTask({
  id: 'task-expired',
  description: '上传已超时的任务',
  currentStep: 'upload',
  status: 'failed',
  lastError: {
    userMessage: '上传等待已超时，请重新上传。',
    retriable: false,
    action: 'change_input',
    traceId: 't-expired',
  },
  upload: {
    status: 'expired',
    partsExpected: 505,
    partsLanded: 322,
    pairingExpiresAt: '2026-07-08T12:00:00.000Z',
  },
});

const SUCCEEDED = makeTask({
  id: 'task-ok',
  description: '完成的任务',
  currentStep: 'extract',
  status: 'succeeded',
  capabilityCount: 4,
});

describe('TasksPage — 列表状态渲染', () => {
  it('每行显示步骤/状态、分片进度、能力项数、失败原因', async () => {
    fm = installFetchMock({
      status: 200,
      json: paginatedBody([UPLOADING, EXTRACTING, FAILED, EXPIRED, SUCCEEDED]),
    });
    renderPage(<TasksPage />);

    const rowUp = (await screen.findByText('导入 Claude 项目历史')).closest('tr')!;
    expect(within(rowUp).getByText('上传中')).toBeInTheDocument();
    expect(within(rowUp).getByText('已收 3 / 10 片')).toBeInTheDocument();

    const rowEx = screen.getByText('提取中的任务').closest('tr')!;
    expect(within(rowEx).getByText('提取中')).toBeInTheDocument();
    expect(within(rowEx).getByText('上传完成')).toBeInTheDocument();

    const rowFail = screen.getByText('失败的任务').closest('tr')!;
    expect(within(rowFail).getByText('失败')).toBeInTheDocument();
    expect(within(rowFail).getByText('模型服务暂时不可用，请稍后重试。')).toBeInTheDocument();

    const rowExpired = screen.getByText('上传已超时的任务').closest('tr')!;
    expect(within(rowExpired).getByText('已超时 · 322 / 505 片')).toBeInTheDocument();
    expect(within(rowExpired).getByText('上传等待已超时，请重新上传。')).toBeInTheDocument();

    const rowOk = screen.getByText('完成的任务').closest('tr')!;
    expect(within(rowOk).getByText('提取完成')).toBeInTheDocument();
    expect(within(rowOk).getByText('4 个')).toBeInTheDocument();
    expect(within(rowOk).getByRole('link', { name: '查看并试用能力' })).toHaveAttribute(
      'href',
      '/capabilities?taskId=task-ok',
    );
  });

  it('空列表 → 空态引导（不裸空表）', async () => {
    fm = installFetchMock({ status: 200, json: paginatedBody([]) });
    renderPage(<TasksPage />);
    expect(await screen.findByRole('heading', { level: 2, name: '创作进度' })).toBeInTheDocument();
    expect(await screen.findByText('还没有创作记录')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '用哪种方式创建 Agent？' })).toBeInTheDocument();
  });

  it('列表加载失败 → 人话错误 + 重试（绝不裸露状态码）', async () => {
    fm = installFetchMock([
      {
        status: 500,
        json: {
          error: {
            userMessage: '服务开小差了，请重试。',
            retriable: true,
            action: 'retry',
            traceId: 't1',
          },
        },
      },
      { status: 200, json: paginatedBody([SUCCEEDED]) },
    ]);
    renderPage(<TasksPage />);
    expect(await screen.findByText('服务开小差了，请重试。')).toBeInTheDocument();
    expect(screen.queryByText(/500/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('完成的任务')).toBeInTheDocument();
  });

  it('hasMore → 「加载更多」按 nextCursor 翻页', async () => {
    fm = installFetchMock([
      { status: 200, json: paginatedBody([UPLOADING], { nextCursor: 'cur-2', hasMore: true }) },
      { status: 200, json: paginatedBody([SUCCEEDED]) },
    ]);
    renderPage(<TasksPage />);
    await screen.findByText('导入 Claude 项目历史');
    await userEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect(await screen.findByText('完成的任务')).toBeInTheDocument();
    expect(fm.calls[1]?.url).toContain('cursor=cur-2');
    expect(screen.getByText('没有更多了')).toBeInTheDocument();
  });
});

describe('TasksPage — 新建上传任务', () => {
  it('直接刷新 /tasks?create=1 也只打开创建方式，不自动 POST', async () => {
    fm = installFetchMock({ status: 200, json: paginatedBody([UPLOADING]) });

    renderPage(<TasksWithPathProbe />, { route: '/tasks?create=1' });

    expect(
      await screen.findByRole('heading', { name: '用哪种方式创建 Agent？' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('path')).toHaveTextContent('/tasks');
    expect(fm.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('消费 Shell 的一次性 create intent，只打开创建方式；确认真实导入后才创建任务', async () => {
    const created = makeTask({
      id: 'task-intent',
      upload: {
        status: 'pending',
        partsExpected: null,
        partsLanded: 0,
        pairingExpiresAt: '2099-08-05T12:00:00.000Z',
      },
    });
    fm = installFetchMock([
      { status: 200, json: paginatedBody([]) },
      { status: 201, json: envelopeBody({ task: created, pairingCode: 'PAIR-INTENT-1' }) },
      { status: 200, json: paginatedBody([created]) },
      { match: '/tasks/task-intent', status: 200, json: envelopeBody(created) },
    ]);

    renderPage(<TasksWithCreateIntentProbe />, { route: '/tasks' });
    await screen.findByText('还没有创作记录');
    await userEvent.click(screen.getByRole('link', { name: '模拟全局创建入口' }));

    expect(
      await screen.findByRole('heading', { name: '用哪种方式创建 Agent？' }),
    ).toBeInTheDocument();
    expect(screen.getByText('导入本机会话')).toBeInTheDocument();
    expect(screen.getByText('提交公开主页')).toBeInTheDocument();
    expect(screen.getByTestId('path')).toHaveTextContent('/tasks');
    expect(screen.getByTestId('path')).not.toHaveTextContent('create=1');
    expect(fm.calls.filter((call) => call.method === 'POST')).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: '创建连接任务' }));
    expect(await screen.findByText('PAIR-INTENT-1')).toBeInTheDocument();
    expect(fm.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('真实导入动作在首个请求完成前被重复点击也只创建一个任务', async () => {
    const created = makeTask({
      id: 'task-single-flight',
      upload: {
        status: 'pending',
        partsExpected: null,
        partsLanded: 0,
        pairingExpiresAt: '2099-08-05T12:00:00.000Z',
      },
    });
    let resolveCreate!: (value: MockResponseSpec) => void;
    const pendingCreate = new Promise<MockResponseSpec>((resolve) => {
      resolveCreate = resolve;
    });
    fm = installFetchMock([
      { status: 200, json: paginatedBody([]) },
      { deferred: pendingCreate },
      { status: 200, json: paginatedBody([created]) },
      { match: '/tasks/task-single-flight', status: 200, json: envelopeBody(created) },
    ]);

    renderPage(<TasksWithCreateIntentProbe />, { route: '/tasks' });
    await screen.findByText('还没有创作记录');
    await userEvent.click(screen.getByRole('link', { name: '模拟全局创建入口' }));
    const realCreate = screen.getByRole('button', { name: '创建连接任务' });

    await userEvent.click(realCreate);
    await waitFor(() => expect(fm!.calls.filter((call) => call.method === 'POST')).toHaveLength(1));
    await userEvent.click(realCreate);
    expect(fm.calls.filter((call) => call.method === 'POST')).toHaveLength(1);

    resolveCreate({
      status: 201,
      json: envelopeBody({ task: created, pairingCode: 'PAIR-SINGLE-FLIGHT' }),
    });
    expect(await screen.findByText('PAIR-SINGLE-FLIGHT')).toBeInTheDocument();
    expect(fm.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('POST /tasks 带幂等键；配对码明文 + 连接命令展示（仅此一次提示）', async () => {
    const created = makeTask({
      id: 'task-new',
      upload: {
        status: 'pending',
        partsExpected: null,
        partsLanded: 0,
        pairingExpiresAt: '2099-08-05T12:00:00.000Z',
      },
    });
    fm = installFetchMock([
      { status: 200, json: paginatedBody([]) }, // 初始列表
      { status: 201, json: envelopeBody({ task: created, pairingCode: 'PAIR-CODE-XYZ' }) },
      { status: 200, json: paginatedBody([created]) }, // 建后失效重拉
      { match: '/tasks/task-new', status: 200, json: envelopeBody(created) }, // 配对等待 watcher
    ]);
    renderPage(<TasksPage />);
    await screen.findByText('还没有创作记录');

    await userEvent.click(screen.getByRole('button', { name: '创建连接任务' }));

    // 请求形态：POST /api/v1/tasks，body 带前端生成的幂等键（≥8 字符）。
    const post = fm.calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('/api/v1/tasks');
    const body = post?.body as { idempotencyKey?: string };
    expect(typeof body.idempotencyKey).toBe('string');
    expect(body.idempotencyKey!.length).toBeGreaterThanOrEqual(8);

    // 云端仅下发一次；当前标签页临时保留，并给出完整连接命令。
    expect(await screen.findByText('PAIR-CODE-XYZ')).toBeInTheDocument();
    expect(screen.getByText(/云端仅下发一次/)).toBeInTheDocument();
    const cmd = screen.getByText(/connect\/script\?code=PAIR-CODE-XYZ/);
    expect(cmd.textContent).toContain('curl -fsSL');
    expect(cmd.textContent).toContain('| sh');
    expect(screen.getByText('等待本机助手连接，上传开始后会自动打开进度页。')).toBeInTheDocument();
    expect(
      screen.getByText('当前标签页已临时保存这条命令；刷新后可从任务详情继续。'),
    ).toBeInTheDocument();
    expect(readTaskPairingReceipt('task-new')).toMatchObject({
      taskId: 'task-new',
      pairingCode: 'PAIR-CODE-XYZ',
    });

    // 「已保存命令，收起」收起引导卡。
    await userEvent.click(screen.getByRole('button', { name: '已保存命令，收起' }));
    expect(screen.queryByText('PAIR-CODE-XYZ')).toBeNull();
  });

  it('第一片上传落地后自动进入任务详情，不需要刷新或手动点查看进度', async () => {
    const created = makeTask({
      id: 'task-auto',
      upload: {
        status: 'pending',
        partsExpected: null,
        partsLanded: 0,
        pairingExpiresAt: '2099-08-05T12:00:00.000Z',
      },
    });
    const started = makeTask({
      ...created,
      upload: {
        ...created.upload,
        partsExpected: 8,
        partsLanded: 1,
      },
    });
    fm = installFetchMock([
      { status: 200, json: paginatedBody([]) },
      { status: 201, json: envelopeBody({ task: created, pairingCode: 'PAIR-AUTO-1' }) },
      { status: 200, json: paginatedBody([started]) },
      { match: '/tasks/task-auto', status: 200, json: envelopeBody(started) },
    ]);
    renderPage(<TasksWithPathProbe />, { route: '/tasks' });
    await screen.findByText('还没有创作记录');

    await userEvent.click(screen.getByRole('button', { name: '创建连接任务' }));

    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/tasks/task-auto'));
    expect(fm.calls.some((call) => call.url === '/api/v1/tasks/task-auto')).toBe(true);
  });

  it('公开主页方式明确是 Mock，只保存当前标签页草稿且不创建后端任务', async () => {
    fm = installFetchMock({ status: 200, json: paginatedBody([]) });
    renderPage(<TasksPage />);
    await screen.findByText('还没有创作记录');

    const callsBeforeManagedSubmit = fm.calls.length;
    await userEvent.click(screen.getByRole('button', { name: '填写资料' }));
    await userEvent.type(
      screen.getByRole('textbox', { name: '公开主页链接' }),
      'https://example.com/creator',
    );
    await userEvent.type(screen.getByRole('textbox', { name: '联系邮箱' }), 'creator@example.com');
    await userEvent.click(screen.getByRole('checkbox', { name: /我确认这些内容是公开资料/ }));
    await userEvent.click(screen.getByRole('button', { name: '保存体验草稿' }));

    expect(
      await screen.findByText('体验草稿已保存在当前标签页；关闭标签页后不会作为真实任务保留。'),
    ).toBeInTheDocument();
    expect(screen.getByText(/尚未提交到 Combo，不会开始抓取或生成 Agent/)).toBeInTheDocument();
    expect(fm.calls).toHaveLength(callsBeforeManagedSubmit);
    expect(readLandingDraft()?.contactEmail).toBe('creator@example.com');
  });

  it('Landing 旧草稿缺少联系邮箱时，不误报为完整托管资料已保存', async () => {
    sessionStorage.setItem(
      CREATION_INTAKE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        mode: 'kol_profile',
        profileUrl: 'https://example.com/creator',
        consent: true,
        preparedAt: new Date().toISOString(),
      }),
    );
    fm = installFetchMock({ status: 200, json: paginatedBody([]) });
    renderPage(<TasksPage />);
    await screen.findByText('还没有创作记录');

    await userEvent.click(screen.getByRole('button', { name: '填写资料' }));
    expect(screen.getByRole('textbox', { name: '公开主页链接' })).toHaveValue(
      'https://example.com/creator',
    );
    expect(screen.getByRole('textbox', { name: '联系邮箱' })).toHaveValue('');
    expect(screen.queryByText(/体验草稿已保存在当前标签页/)).toBeNull();
  });

  it('浏览器无法暂存连接命令时，收起动作要求用户明确确认已复制', async () => {
    const created = makeTask({
      id: 'task-storage-blocked',
      upload: {
        status: 'pending',
        partsExpected: null,
        partsLanded: 0,
        pairingExpiresAt: '2099-08-05T12:00:00.000Z',
      },
    });
    fm = installFetchMock([
      { status: 200, json: paginatedBody([]) },
      {
        status: 201,
        json: envelopeBody({ task: created, pairingCode: 'PAIR-STORAGE-BLOCKED' }),
      },
      { status: 200, json: paginatedBody([created]) },
      { match: '/tasks/task-storage-blocked', status: 200, json: envelopeBody(created) },
    ]);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    renderPage(<TasksPage />);
    await screen.findByText('还没有创作记录');
    await userEvent.click(screen.getByRole('button', { name: '创建连接任务' }));

    expect(await screen.findByText('PAIR-STORAGE-BLOCKED')).toBeInTheDocument();
    expect(
      screen.getByText('当前浏览器未能临时保存命令，请先运行或安全保存。'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认已复制，收起' })).toBeInTheDocument();
  });
});
