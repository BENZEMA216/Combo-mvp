import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installFetchMock, type FetchMock } from '../../test/mockFetch.js';
import { envelopeBody, makeCapability, paginatedBody } from '../../test/fixtures.js';
import { renderPage } from '../../test/renderWithProviders.js';
import { CapabilitiesPage } from './CapabilitiesPage.js';
import { emptyReleaseDraft, saveReleaseDraft } from '../release/releaseDraft.js';

let fm: FetchMock | undefined;
afterEach(() => {
  fm?.restore();
  fm = undefined;
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const DRAFT = makeCapability({
  id: 'cap-a',
  name: '周报整理',
  summary: '把一周的碎片记录整理成结构化周报。',
  published: false,
  createdAt: '2026-07-04T11:00:00.000Z',
});
const PUBLISHED = makeCapability({
  id: 'cap-b',
  name: 'Code Review',
  summary: '按团队规范给出评审意见。',
  published: true,
  publishedAt: '2026-07-21T00:00:00.000Z',
});

describe('CapabilitiesPage — Agent 项目列表', () => {
  it('呈现视觉身份、真实状态、创建日期与明确操作，不混入 analytics 假列', async () => {
    fm = installFetchMock({ status: 200, json: paginatedBody([DRAFT, PUBLISHED]) });
    renderPage(<CapabilitiesPage />, { route: '/capabilities' });

    expect(screen.getByRole('heading', { name: '我的 Agent' })).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Agent 项目列表' });
    expect(within(table).getByRole('columnheader', { name: 'Agent' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: '创建日期' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: '操作' })).toBeInTheDocument();
    expect(within(table).queryByRole('columnheader', { name: '本月调用' })).toBeNull();
    expect(within(table).queryByRole('columnheader', { name: '收益' })).toBeNull();
    expect(screen.queryByText('暂无数据 / 上线后填充')).toBeNull();

    const draftRow = screen.getByText('周报整理').closest('tr')!;
    expect(within(draftRow).getByText('周报')).toHaveClass('cb-agent-mark');
    expect(within(draftRow).getByText('草稿')).toBeInTheDocument();
    expect(within(draftRow).getByText('2026/07/04')).toBeInTheDocument();
    expect(
      within(draftRow).getByRole('button', { name: '编辑「周报整理」UI' }),
    ).toBeInTheDocument();
    expect(
      within(draftRow).getByRole('link', { name: '设置「周报整理」定价与发布' }),
    ).toHaveAttribute('href', '/capabilities/cap-a/release/pricing');
    expect(within(draftRow).getByRole('link', { name: '试用「周报整理」' })).toHaveAttribute(
      'href',
      '/try/c/cap-a',
    );

    const publishedRow = screen.getByText('Code Review').closest('tr')!;
    expect(within(publishedRow).getByText('CR')).toHaveClass('cb-agent-mark');
    expect(within(publishedRow).getByText('已上架')).toBeInTheDocument();
    expect(within(publishedRow).getByText('2026/07/04')).toBeInTheDocument();
    expect(
      within(publishedRow).getByRole('link', { name: '管理「Code Review」发布设置' }),
    ).toHaveAttribute('href', '/capabilities/cap-b/release/pricing');
    expect(
      within(publishedRow).getByRole('button', { name: '停止「Code Review」公开试用' }),
    ).toBeInTheDocument();
    expect(
      within(publishedRow).getByRole('button', { name: '复制「Code Review」试用链接' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('没有更多了')).toBeNull();
  });

  it('创建 Agent 入口位于列表顶部并直接进入既有创作链第一步', async () => {
    fm = installFetchMock({ status: 200, json: paginatedBody([DRAFT]) });
    renderPage(<CapabilitiesPage />, { route: '/capabilities' });
    await screen.findByText('周报整理');

    const create = screen.getByRole('link', { name: '创建 Agent' });
    expect(create).toHaveAttribute('href', '/tasks');
    expect(create.closest('.cb-capabilities__list-toolbar')).not.toBeNull();
  });

  it('筛选只提供可由当前契约判定的全部 / 已上架 / 草稿', async () => {
    fm = installFetchMock({ status: 200, json: paginatedBody([DRAFT, PUBLISHED]) });
    renderPage(<CapabilitiesPage />, { route: '/capabilities' });
    await screen.findByText('周报整理');

    await userEvent.click(screen.getByRole('button', { name: '已上架' }));
    expect(screen.queryByText('周报整理')).toBeNull();
    expect(screen.getByText('Code Review')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '草稿' }));
    expect(screen.getByText('周报整理')).toBeInTheDocument();
    expect(screen.queryByText('Code Review')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Alpha·审核中' })).toBeNull();
  });

  it('编辑 UI 创建 studio session 并整页进入会话，完成后继续定价发布', async () => {
    const navigateToStudio = vi.fn();
    fm = installFetchMock([
      { status: 200, json: paginatedBody([DRAFT]), match: '/capabilities' },
      {
        status: 201,
        json: envelopeBody({ session: { id: 'studio-session-1' } }),
        match: '/runtime/studio/sessions',
      },
    ]);
    renderPage(<CapabilitiesPage navigateToStudio={navigateToStudio} />, {
      route: '/capabilities',
    });

    await userEvent.click(await screen.findByRole('button', { name: '编辑「周报整理」UI' }));
    await waitFor(() => expect(navigateToStudio).toHaveBeenCalledTimes(1));

    const request = fm.calls.find((call) => call.url.includes('/runtime/studio/sessions'));
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('/api/v1/runtime/studio/sessions');
    expect(request?.body).toEqual({ capabilityId: 'cap-a' });
    expect(navigateToStudio).toHaveBeenCalledWith(
      '/try/session/studio-session-1?mode=studio&returnTo=%2Fcapabilities%2Fcap-a%2Frelease%2Fpricing',
    );
  });

  it('studio 创建失败时在对应 Agent 行提供人话错误', async () => {
    fm = installFetchMock([
      { status: 200, json: paginatedBody([DRAFT]), match: '/capabilities' },
      {
        status: 503,
        json: {
          error: {
            userMessage: '设计空间暂时没有准备好，请稍后重试。',
            retriable: true,
            action: 'retry',
            traceId: 'studio-down',
          },
        },
        match: '/runtime/studio/sessions',
      },
    ]);
    renderPage(<CapabilitiesPage navigateToStudio={vi.fn()} />, { route: '/capabilities' });

    await userEvent.click(await screen.findByRole('button', { name: '编辑「周报整理」UI' }));
    expect(
      await screen.findByText('编辑 UI 未打开：设计空间暂时没有准备好，请稍后重试。'),
    ).toBeInTheDocument();
  });

  it('列表不再绕过定价与命名直接调用发布接口', async () => {
    fm = installFetchMock({ status: 200, json: paginatedBody([DRAFT]) });
    renderPage(<CapabilitiesPage />, { route: '/capabilities' });
    const row = (await screen.findByText('周报整理')).closest('tr')!;

    expect(within(row).queryByRole('button', { name: '发布「周报整理」' })).toBeNull();
    expect(within(row).getByRole('link', { name: '设置「周报整理」定价与发布' })).toHaveAttribute(
      'href',
      '/capabilities/cap-a/release/pricing',
    );
    expect(fm.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('有本机发布草稿时从记录的步骤继续，不让用户从定价重来', async () => {
    saveReleaseDraft({
      ...emptyReleaseDraft(DRAFT.id, DRAFT.name),
      pricingModel: 'per-use',
      priceYuan: 19.9,
      handle: 'weekly-review',
      currentStep: 'review',
    });
    fm = installFetchMock({ status: 200, json: paginatedBody([DRAFT]) });
    renderPage(<CapabilitiesPage />, { route: '/capabilities' });

    const row = (await screen.findByText('周报整理')).closest('tr')!;
    expect(within(row).getByRole('link', { name: '继续「周报整理」发布设置' })).toHaveAttribute(
      'href',
      '/capabilities/cap-a/release/review',
    );
    expect(within(row).getByText('继续发布')).toBeInTheDocument();
  });

  it('已完成发布的 Agent 显示管理设置，不冒充未完成进度', async () => {
    saveReleaseDraft({
      ...emptyReleaseDraft(PUBLISHED.id, PUBLISHED.name),
      pricingModel: 'per-use',
      priceYuan: 19.9,
      handle: 'code-review',
      currentStep: 'success',
      confirmed: true,
    });
    fm = installFetchMock({ status: 200, json: paginatedBody([PUBLISHED]) });
    renderPage(<CapabilitiesPage />, { route: '/capabilities' });

    const row = (await screen.findByText('Code Review')).closest('tr')!;
    expect(within(row).getByRole('link', { name: '查看「Code Review」发布结果' })).toHaveAttribute(
      'href',
      '/capabilities/cap-b/release/success',
    );
    expect(within(row).getByText('查看发布结果')).toBeInTheDocument();
    expect(within(row).queryByText('继续发布')).toBeNull();
  });

  it('兼容没有 currentStep 的旧草稿：已定价进入命名，已命名进入确认', async () => {
    saveReleaseDraft({
      ...emptyReleaseDraft(DRAFT.id, DRAFT.name),
      pricingModel: 'time-pass',
      priceYuan: 29,
      durationDays: 30,
    });
    saveReleaseDraft({
      ...emptyReleaseDraft(PUBLISHED.id, PUBLISHED.name),
      handle: 'code-review',
    });
    fm = installFetchMock({ status: 200, json: paginatedBody([DRAFT, PUBLISHED]) });
    renderPage(<CapabilitiesPage />, { route: '/capabilities' });

    const draftRow = (await screen.findByText('周报整理')).closest('tr')!;
    expect(
      within(draftRow).getByRole('link', { name: '继续「周报整理」发布设置' }),
    ).toHaveAttribute('href', '/capabilities/cap-a/release/identity');

    const publishedRow = screen.getByText('Code Review').closest('tr')!;
    expect(
      within(publishedRow).getByRole('link', { name: '管理「Code Review」发布设置' }),
    ).toHaveAttribute('href', '/capabilities/cap-b/release/review');
    expect(within(publishedRow).getByText('发布设置')).toBeInTheDocument();
    expect(within(publishedRow).queryByText('继续发布')).toBeNull();
  });

  it('停止公开试用前明确确认，确认后调用现有下架端点并就地更新状态', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fm = installFetchMock([
      { status: 200, json: paginatedBody([PUBLISHED]), match: '/capabilities' },
      {
        status: 200,
        json: envelopeBody({ id: PUBLISHED.id, published: false }),
        match: `/capabilities/${PUBLISHED.id}/unpublish`,
      },
    ]);
    renderPage(<CapabilitiesPage />, { route: '/capabilities' });
    const row = (await screen.findByText('Code Review')).closest('tr')!;
    const stop = within(row).getByRole('button', { name: '停止「Code Review」公开试用' });

    await userEvent.click(stop);
    expect(confirm).toHaveBeenCalledWith(
      '停止「Code Review」的公开试用？定价和页面设置会保留，之后可以再次开放。',
    );
    expect(fm.calls.every((call) => call.method === 'GET')).toBe(true);

    confirm.mockReturnValue(true);
    await userEvent.click(stop);
    expect(await within(row).findByText('草稿')).toBeInTheDocument();
    expect(
      fm.calls.find((call) => call.url.endsWith(`/capabilities/${PUBLISHED.id}/unpublish`))?.method,
    ).toBe('POST');
    expect(within(row).queryByRole('button', { name: /停止.*公开试用/ })).toBeNull();
    expect(within(row).queryByRole('button', { name: /复制.*试用链接/ })).toBeNull();
  });

  it('停止公开试用失败时只在对应 Agent 行说明错误并保留当前公开状态', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fm = installFetchMock([
      { status: 200, json: paginatedBody([PUBLISHED]), match: '/capabilities' },
      {
        status: 503,
        json: {
          error: {
            userMessage: '公开状态暂时无法更新，请稍后重试。',
            retriable: true,
            action: 'retry',
            traceId: 'unpublish-down',
          },
        },
        match: `/capabilities/${PUBLISHED.id}/unpublish`,
      },
    ]);
    renderPage(<CapabilitiesPage />, { route: '/capabilities' });
    const row = (await screen.findByText('Code Review')).closest('tr')!;

    await userEvent.click(within(row).getByRole('button', { name: '停止「Code Review」公开试用' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent(
      '停止公开试用未完成：公开状态暂时无法更新，请稍后重试。',
    );
    expect(within(row).getByText('已上架')).toBeInTheDocument();
  });

  it('空列表只给创建 Agent，不渲染空表', async () => {
    fm = installFetchMock({ status: 200, json: paginatedBody([]) });
    renderPage(<CapabilitiesPage />, { route: '/capabilities' });
    expect(await screen.findByText('还没有 Agent')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '创建 Agent' })).toHaveAttribute('href', '/tasks');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('只有存在下一页时才显示加载更多，列表到底不追加结束文案', async () => {
    fm = installFetchMock({
      status: 200,
      json: paginatedBody([DRAFT], { hasMore: true, nextCursor: 'next-1' }),
    });
    renderPage(<CapabilitiesPage />, { route: '/capabilities' });
    expect(await screen.findByRole('button', { name: '加载更多' })).toBeInTheDocument();
    expect(screen.queryByText('没有更多了')).toBeNull();
  });

  it('状态筛选不会把当前页无匹配冒充成全量空状态', async () => {
    fm = installFetchMock([
      {
        status: 200,
        json: paginatedBody([DRAFT], { hasMore: true, nextCursor: 'next-1' }),
        match: '/capabilities',
      },
      {
        status: 200,
        json: paginatedBody([PUBLISHED]),
        match: '/capabilities',
      },
    ]);
    renderPage(<CapabilitiesPage />, { route: '/capabilities' });
    await screen.findByText('周报整理');

    await userEvent.click(screen.getByRole('button', { name: '已上架' }));
    expect(screen.queryByText('该状态下还没有 Agent')).toBeNull();
    expect(await screen.findByText('Code Review')).toBeInTheDocument();
    expect(fm.calls.some((call) => call.url.includes('cursor=next-1'))).toBe(true);
  });

  it('筛选续页失败时说明列表尚未加载完整并允许重试', async () => {
    fm = installFetchMock([
      {
        status: 200,
        json: paginatedBody([DRAFT], { hasMore: true, nextCursor: 'next-1' }),
        match: '/capabilities',
      },
      {
        status: 503,
        json: {
          error: {
            userMessage: '列表暂时加载失败，请稍后重试。',
            retriable: true,
            action: 'retry',
            traceId: 'caps-page-down',
          },
        },
        match: '/capabilities',
      },
    ]);
    renderPage(<CapabilitiesPage />, { route: '/capabilities' });
    await screen.findByText('周报整理');

    await userEvent.click(screen.getByRole('button', { name: '已上架' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('列表还没有加载完整');
    expect(screen.getByRole('button', { name: '继续加载' })).toBeInTheDocument();
    expect(screen.queryByText('该状态下还没有 Agent')).toBeNull();
  });
});
