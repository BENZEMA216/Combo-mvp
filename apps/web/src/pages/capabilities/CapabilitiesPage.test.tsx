import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installFetchMock, type FetchMock } from '../../test/mockFetch.js';
import { envelopeBody, makeCapability, paginatedBody } from '../../test/fixtures.js';
import { renderPage } from '../../test/renderWithProviders.js';
import { CapabilitiesPage } from './CapabilitiesPage.js';

let fm: FetchMock | undefined;
afterEach(() => {
  fm?.restore();
  fm = undefined;
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
    expect(within(draftRow).getByRole('button', { name: '发布「周报整理」' })).toBeInTheDocument();
    expect(within(draftRow).getByRole('link', { name: '试用「周报整理」' })).toHaveAttribute(
      'href',
      '/try/c/cap-a',
    );

    const publishedRow = screen.getByText('Code Review').closest('tr')!;
    expect(within(publishedRow).getByText('CR')).toHaveClass('cb-agent-mark');
    expect(within(publishedRow).getByText('已上架')).toBeInTheDocument();
    expect(within(publishedRow).getByText('2026/07/04')).toBeInTheDocument();
    expect(
      within(publishedRow).getByRole('button', { name: '下架「Code Review」' }),
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

  it('编辑 UI 创建 studio session 并整页进入会话，保留返回我的 Agent', async () => {
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
      '/try/session/studio-session-1?mode=studio&returnTo=%2Fcapabilities',
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

  it('发布与下架使用真实端点并就地合并状态', async () => {
    fm = installFetchMock([
      { status: 200, json: paginatedBody([DRAFT]), match: '/capabilities' },
      {
        status: 200,
        json: envelopeBody({
          id: 'cap-a',
          published: true,
          publishedAt: '2026-07-23T08:00:00.000Z',
          shareToken: 'share-cap-a',
        }),
        match: '/capabilities/cap-a/publish',
      },
      {
        status: 200,
        json: envelopeBody({ id: 'cap-a', published: false, shareToken: 'share-cap-a' }),
        match: '/capabilities/cap-a/unpublish',
      },
    ]);
    renderPage(<CapabilitiesPage />, { route: '/capabilities' });
    const row = (await screen.findByText('周报整理')).closest('tr')!;

    await userEvent.click(within(row).getByRole('button', { name: '发布「周报整理」' }));
    expect(await within(row).findByText('已上架')).toBeInTheDocument();
    expect(fm.calls.find((call) => call.url.endsWith('/capabilities/cap-a/publish'))?.method).toBe(
      'POST',
    );
    expect(
      within(row).getByRole('button', { name: '复制「周报整理」试用链接' }),
    ).toBeInTheDocument();

    await userEvent.click(within(row).getByRole('button', { name: '下架「周报整理」' }));
    expect(await within(row).findByText('草稿')).toBeInTheDocument();
    expect(
      fm.calls.find((call) => call.url.endsWith('/capabilities/cap-a/unpublish'))?.method,
    ).toBe('POST');
    expect(within(row).queryByRole('button', { name: /复制.*试用链接/ })).toBeNull();
  });

  it('发布失败只在对应 Agent 行给出可理解错误', async () => {
    fm = installFetchMock([
      { status: 200, json: paginatedBody([DRAFT]), match: '/capabilities' },
      {
        status: 503,
        json: {
          error: {
            userMessage: '发布服务暂时繁忙，请稍后重试。',
            retriable: true,
            action: 'retry',
            traceId: 'publish-busy',
          },
        },
        match: '/capabilities/cap-a/publish',
      },
    ]);
    renderPage(<CapabilitiesPage />, { route: '/capabilities' });
    const row = (await screen.findByText('周报整理')).closest('tr')!;

    await userEvent.click(within(row).getByRole('button', { name: '发布「周报整理」' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent(
      '发布未完成：发布服务暂时繁忙，请稍后重试。',
    );
    expect(screen.queryByText(/503|publish-busy/)).toBeNull();
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
