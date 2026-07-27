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

    await userEvent.click(screen.getByRole('button', { name: '收起侧栏' }));
    expect(screen.getByRole('link', { name: '我的 Agent' })).toHaveAttribute('title', '我的 Agent');
  });
});
