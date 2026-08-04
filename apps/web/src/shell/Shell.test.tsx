import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Shell } from './Shell.js';

describe('Shell navigation', () => {
  it('does not expose the capability market while it is closed', async () => {
    globalThis.localStorage.clear();
    render(
      <MemoryRouter initialEntries={['/tasks']}>
        <Routes>
          <Route element={<Shell />}>
            <Route path="/tasks" element={<p>任务页</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.queryByRole('link', { name: '能力市集' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '我的 Agent' })).toHaveAttribute(
      'href',
      '/capabilities',
    );
    expect(screen.getByRole('link', { name: '创建 Agent' })).toHaveAttribute(
      'href',
      '/tasks?create=1',
    );
    expect(screen.getByRole('link', { name: '创作进度' })).toHaveAttribute('href', '/tasks');

    await userEvent.click(screen.getByRole('button', { name: '收起侧栏' }));
    expect(screen.getByRole('link', { name: '我的 Agent' })).toHaveAttribute('title', '我的 Agent');
  });

  it('keeps the latest creation recoverable from every protected page', async () => {
    globalThis.localStorage.clear();
    render(
      <MemoryRouter initialEntries={['/tasks']}>
        <Routes>
          <Route
            element={
              <Shell
                creationResume={{
                  title: '旅行穿搭 Agent',
                  stage: '正在提取 Agent',
                  href: '/tasks/task-live',
                  total: 3,
                }}
              />
            }
          >
            <Route path="/tasks" element={<p>任务页</p>} />
            <Route path="/tasks/:taskId" element={<p>任务详情</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const resume = screen.getByRole('link', {
      name: '继续创作：旅行穿搭 Agent，正在提取 Agent',
    });
    expect(resume).toHaveAttribute('href', '/tasks/task-live');
    expect(screen.getByRole('link', { name: '另有 2 个创作' })).toHaveAttribute(
      'href',
      '/creation/tasks',
    );

    await userEvent.click(screen.getByRole('button', { name: '收起侧栏' }));
    expect(resume).toHaveAttribute('title', '旅行穿搭 Agent · 正在提取 Agent · 继续创作');
    await userEvent.click(resume);
    expect(screen.getByText('任务详情')).toBeInTheDocument();
  });
});
