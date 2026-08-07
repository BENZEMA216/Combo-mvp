import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionView } from '@cb/shared';
import {
  archivedSessionTarget,
  isRuntimeNavigationTarget,
  SessionSidebar,
  SessionListItem,
} from './SessionSidebar.js';

const originalFetch = globalThis.fetch;

const CURRENT: SessionView = {
  id: 'session-current',
  capabilityId: 'capability-1',
  title: '项目复盘',
  status: 'active',
  createdAt: '2026-07-20T08:00:00.000Z',
  updatedAt: '2026-07-20T08:10:00.000Z',
};

const OTHER: SessionView = {
  ...CURRENT,
  id: 'session-other',
  title: '另一个会话',
};

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ data, meta: { traceId: 'trace-sidebar' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fail(status: number, userMessage: string): Response {
  return new Response(JSON.stringify({ error: { userMessage, traceId: 'trace-sidebar-error' } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('SessionSidebar 会话操作', () => {
  it('会话链接与改名/归档按钮是并列元素，没有 Link 内嵌 button', () => {
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(SessionListItem, {
          session: CURRENT,
          active: true,
          onRename: async () => undefined,
          onArchive: async () => undefined,
        }),
      ),
    );

    const linkMarkup = markup.match(/<a[\s\S]*?<\/a>/)?.[0];
    expect(linkMarkup).toBeTruthy();
    expect(linkMarkup).not.toContain('<button');
    expect(linkMarkup).toContain('aria-current="page"');
    expect(markup).toContain('aria-label="重命名“项目复盘”"');
    expect(markup).toContain('aria-label="归档“项目复盘”"');
  });

  it('归档当前会话时保留创作者返回链路，无剩余会话时直接返回创作端', () => {
    const returnTo = '/tasks/018f47ea-bc32-7a3d-8f6e-2f90c7b01d43?from=trial';
    expect(archivedSessionTarget(CURRENT.id, CURRENT.id, [CURRENT, OTHER], returnTo)).toBe(
      '/session/session-other?returnTo=%2Ftasks%2F018f47ea-bc32-7a3d-8f6e-2f90c7b01d43%3Ffrom%3Dtrial',
    );
    expect(archivedSessionTarget(CURRENT.id, CURRENT.id, [CURRENT], returnTo)).toBe(returnTo);
    expect(archivedSessionTarget(CURRENT.id, CURRENT.id, [CURRENT])).toBe('/capabilities');
    expect(archivedSessionTarget(OTHER.id, CURRENT.id, [CURRENT, OTHER])).toBeNull();
    expect(isRuntimeNavigationTarget('/session/session-other')).toBe(true);
    expect(isRuntimeNavigationTarget('/capabilities')).toBe(false);
    expect(isRuntimeNavigationTarget(returnTo)).toBe(false);
  });

  it('正在生成的会话在所有侧栏实例中都禁用归档', () => {
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(SessionListItem, {
          session: CURRENT,
          active: true,
          archiveDisabled: true,
          inputIdPrefix: 'mobile',
          onRename: async () => undefined,
          onArchive: async () => undefined,
        }),
      ),
    );

    expect(markup).toContain('aria-label="“项目复盘”正在生成，暂时不能归档"');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>⌑<\/button>/);
  });

  it('Studio 设计上下文不显示通用归档入口', () => {
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(SessionListItem, {
          session: CURRENT,
          active: true,
          allowArchive: false,
          onRename: async () => undefined,
          onArchive: async () => undefined,
        }),
      ),
    );

    expect(markup).toContain('aria-label="重命名“项目复盘”"');
    expect(markup).not.toContain('归档“项目复盘”');
  });

  it('Released Agent 从同一个 Project Release 新建会话，不退化为 Capability 会话', async () => {
    const projectId = '33333333-3333-4333-8333-333333333333';
    const releasedSession: SessionView = {
      ...CURRENT,
      id: '44444444-4444-4444-8444-444444444444',
      agentProjectId: projectId,
      agentRevisionId: '55555555-5555-4555-8555-555555555555',
      agentReleaseId: '66666666-6666-4666-8666-666666666666',
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'GET' && url.startsWith('/api/v1/runtime/sessions?')) return ok([]);
      if (init?.method === 'POST' && url === `/api/v1/runtime/agents/${projectId}/sessions`) {
        return ok(releasedSession);
      }
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
    });
    globalThis.fetch = fetchMock;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          MemoryRouter,
          { initialEntries: ['/session/session-current'] },
          createElement(SessionSidebar, {
            activeSessionId: CURRENT.id,
            capabilityId: CURRENT.capabilityId,
            agentProjectId: projectId,
            agentReleaseId: releasedSession.agentReleaseId,
            capabilityName: '发布态 Agent',
          }),
        ),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: /新会话/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/v1/runtime/agents/${projectId}/sessions`,
        expect.objectContaining({ method: 'POST', credentials: 'include', body: '{}' }),
      );
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/runtime/sessions?agentProjectId=${projectId}&mode=consume`,
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url) === '/api/v1/runtime/sessions' &&
          (init as RequestInit | undefined)?.method === 'POST',
      ),
    ).toBe(false);
    queryClient.clear();
  });

  it('固定 Revision 的 Agent Test 不冒充已发布 Agent 会话', async () => {
    const testSession: SessionView = {
      ...CURRENT,
      agentProjectId: '33333333-3333-4333-8333-333333333333',
      agentRevisionId: '55555555-5555-4555-8555-555555555555',
    };
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          MemoryRouter,
          { initialEntries: ['/session/session-current'] },
          createElement(SessionSidebar, {
            activeSessionId: CURRENT.id,
            capabilityId: CURRENT.capabilityId,
            agentProjectId: testSession.agentProjectId,
            capabilityName: '测试态 Agent',
          }),
        ),
      ),
    );

    expect(screen.queryByRole('button', { name: /新会话/ })).not.toBeInTheDocument();
    expect(screen.queryByText('从当前发布版本再开一次')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        '这是固定 Revision 的测试会话，不进入正式会话列表。请返回 Agent 项目继续测试或发布。',
      ),
    ).toBeInTheDocument();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it('区分首次加载、加载失败与成功空列表，并允许用户原地重试', async () => {
    let resolveInitial!: (response: Response) => void;
    const initialResponse = new Promise<Response>((resolve) => {
      resolveInitial = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => initialResponse)
      .mockResolvedValueOnce(ok([CURRENT]));
    globalThis.fetch = fetchMock;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          MemoryRouter,
          null,
          createElement(SessionSidebar, {
            activeSessionId: CURRENT.id,
            capabilityId: CURRENT.capabilityId,
          }),
        ),
      ),
    );

    expect(screen.getByRole('status')).toHaveTextContent('正在加载历史会话…');
    expect(screen.queryByText('这个能力下还没有会话')).not.toBeInTheDocument();
    act(() => resolveInitial(fail(503, '历史会话暂时不可用。')));
    expect(await screen.findByRole('alert')).toHaveTextContent('历史会话暂时不可用。');
    expect(screen.queryByText('这个能力下还没有会话')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('项目复盘')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    queryClient.clear();
  });

  it('刷新失败时保留已加载的会话，并提供不会清空列表的重试入口', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok([CURRENT]))
      .mockResolvedValueOnce(fail(503, '历史会话刷新失败。'))
      .mockResolvedValueOnce(ok([CURRENT]));
    globalThis.fetch = fetchMock;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          MemoryRouter,
          null,
          createElement(SessionSidebar, {
            activeSessionId: CURRENT.id,
            capabilityId: CURRENT.capabilityId,
          }),
        ),
      ),
    );

    expect(await screen.findByText('项目复盘')).toBeInTheDocument();
    await queryClient.refetchQueries({
      queryKey: ['sessions', CURRENT.capabilityId, 'consume', null],
    });

    expect(screen.getByText('项目复盘')).toBeInTheDocument();
    expect(await screen.findByText('历史会话刷新失败，已保留上次结果。')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('历史会话刷新失败。');

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByText('项目复盘')).toBeInTheDocument();
    queryClient.clear();
  });
});
