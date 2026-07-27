import { afterEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { installFetchMock, type FetchMock } from '../../test/mockFetch.js';
import { makeCapability, paginatedBody } from '../../test/fixtures.js';
import { renderPage } from '../../test/renderWithProviders.js';
import { CapabilitiesPage } from './CapabilitiesPage.js';

let fm: FetchMock | undefined;

afterEach(() => {
  fm?.restore();
  fm = undefined;
});

describe('CapabilitiesPage — 任务结果回流', () => {
  it('保留 taskId 数据范围，并明确标出本次提取且可返回全部 Agent', async () => {
    fm = installFetchMock({
      status: 200,
      json: paginatedBody([makeCapability({ id: 'cap-task-result', name: '任务产出的 Agent' })]),
    });
    renderPage(<CapabilitiesPage />, {
      route: '/capabilities?taskId=task-annotation-7',
    });

    expect(screen.getByRole('heading', { level: 2, name: '我的 Agent' })).toBeInTheDocument();
    expect(screen.getByText('本次提取')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看全部 Agent' })).toHaveAttribute(
      'href',
      '/capabilities',
    );
    expect(await screen.findByText('任务产出的 Agent')).toBeInTheDocument();
    expect(fm.calls[0]?.url).toContain('taskId=task-annotation-7');
  });

  it('全局列表请求不带 taskId', async () => {
    fm = installFetchMock({
      status: 200,
      json: paginatedBody([makeCapability({ id: 'cap-global', name: '全局 Agent' })]),
    });
    renderPage(<CapabilitiesPage />, { route: '/capabilities' });

    expect(await screen.findByRole('heading', { name: '我的 Agent' })).toBeInTheDocument();
    expect(screen.queryByText('本次提取')).toBeNull();
    expect(screen.queryByRole('link', { name: '查看全部 Agent' })).toBeNull();
    expect(fm.calls[0]?.url).not.toContain('taskId=');
  });
});
