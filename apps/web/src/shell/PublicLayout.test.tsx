import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PublicLayout } from './PublicLayout.js';

function renderAt(pathname: string): void {
  render(
    <MemoryRouter initialEntries={[pathname]}>
      <Routes>
        <Route element={<PublicLayout />}>
          <Route path="*" element={<p>公开页面</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('PublicLayout', () => {
  it('公开页面提供返回 Agent 工作区的唯一入口', () => {
    renderAt('/');

    expect(screen.getByRole('link', { name: 'Combo 首页' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: '查看我的 Agent' })).toHaveAttribute(
      'href',
      '/capabilities',
    );
    expect(screen.queryByRole('navigation', { name: '公开导航' })).toBeNull();
    expect(screen.queryByRole('link', { name: '开始创建' })).toBeNull();
  });

  it('登录页隐藏返回入口，避免重复登录路径', () => {
    renderAt('/login');

    expect(screen.queryByRole('link', { name: '查看我的 Agent' })).toBeNull();
  });
});
