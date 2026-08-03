import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AccountMenu } from './AccountMenu.js';
import type { ShellAccount } from './account.js';

const ACCOUNT: ShellAccount = {
  avatarUrl: null,
  name: 'G',
  title: '创作者',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AccountMenu', () => {
  it('头像/账号整行是 44px 菜单触发器，点击后展示退出登录', async () => {
    render(<AccountMenu account={ACCOUNT} />);
    const trigger = screen.getByRole('button', { name: '打开账户菜单：G · 创作者' });

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('group', { name: '账户操作' })).toBeNull();

    await userEvent.click(trigger);

    expect(screen.getByRole('group', { name: '账户操作' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '退出登录' })).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('退出请求在途禁用动作且只提交一次，成功后整页跳转', async () => {
    let resolveLogout: ((value: { loggedOut: true }) => void) | undefined;
    const requestLogout = vi.fn(
      () =>
        new Promise<{ loggedOut: true }>((resolve) => {
          resolveLogout = resolve;
        }),
    );
    const navigateAfterLogout = vi.fn<(url: string) => void>();
    render(
      <AccountMenu
        account={ACCOUNT}
        requestLogout={requestLogout}
        navigateAfterLogout={navigateAfterLogout}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: '打开账户菜单：G · 创作者' }));
    await userEvent.click(screen.getByRole('button', { name: '退出登录' }));

    expect(screen.getByRole('button', { name: '正在退出…' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: '关闭账户菜单：G · 创作者' }));
    await userEvent.click(screen.getByRole('button', { name: '打开账户菜单：G · 创作者' }));
    const reopenedPending = screen.getByRole('button', { name: '正在退出…' });
    expect(reopenedPending).toBeDisabled();
    await userEvent.click(reopenedPending);
    expect(requestLogout).toHaveBeenCalledTimes(1);

    resolveLogout?.({ loggedOut: true });
    await waitFor(() => expect(navigateAfterLogout).toHaveBeenCalledWith('/login'));
  });

  it('退出失败留在菜单内显示人话错误，并允许重试', async () => {
    const requestLogout = vi
      .fn<() => Promise<{ loggedOut: true } | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ loggedOut: true });
    const navigateAfterLogout = vi.fn<(url: string) => void>();
    render(
      <AccountMenu
        account={ACCOUNT}
        requestLogout={requestLogout}
        navigateAfterLogout={navigateAfterLogout}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: '打开账户菜单：G · 创作者' }));
    await userEvent.click(screen.getByRole('button', { name: '退出登录' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法退出，请重试。');
    await userEvent.click(screen.getByRole('button', { name: '退出登录' }));
    await waitFor(() => expect(navigateAfterLogout).toHaveBeenCalledWith('/login'));
    expect(requestLogout).toHaveBeenCalledTimes(2);
  });

  it('Preview 退出后回到邮箱登录并保留任务上下文', async () => {
    window.history.replaceState({}, '', '/tasks/01982e62-6d6e-7f4d-8fe8-b55f62720b5b?tab=history');
    const requestLogout = vi.fn(async () => ({ loggedOut: true as const }));
    const navigateAfterLogout = vi.fn<(url: string) => void>();
    render(
      <AccountMenu
        account={ACCOUNT}
        environment="preview"
        requestLogout={requestLogout}
        navigateAfterLogout={navigateAfterLogout}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: '打开账户菜单：G · 创作者' }));
    await userEvent.click(screen.getByRole('button', { name: '退出登录' }));

    await waitFor(() =>
      expect(navigateAfterLogout).toHaveBeenCalledWith(
        `/login?returnTo=${encodeURIComponent(
          '/tasks/01982e62-6d6e-7f4d-8fe8-b55f62720b5b?tab=history',
        )}`,
      ),
    );
  });

  it('Escape 关闭菜单并把焦点交还触发器', async () => {
    render(<AccountMenu account={ACCOUNT} />);
    const trigger = screen.getByRole('button', { name: '打开账户菜单：G · 创作者' });
    await userEvent.click(trigger);

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('group', { name: '账户操作' })).toBeNull();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('点击账号区外关闭菜单', async () => {
    render(
      <div>
        <AccountMenu account={ACCOUNT} />
        <button type="button">页面内容</button>
      </div>,
    );
    await userEvent.click(screen.getByRole('button', { name: '打开账户菜单：G · 创作者' }));

    await userEvent.click(screen.getByRole('button', { name: '页面内容' }));

    expect(screen.queryByRole('group', { name: '账户操作' })).toBeNull();
  });

  it('键盘 Tab 离开账号区时关闭浮层', async () => {
    render(
      <div>
        <AccountMenu account={ACCOUNT} />
        <button type="button">页面内容</button>
      </div>,
    );
    await userEvent.click(screen.getByRole('button', { name: '打开账户菜单：G · 创作者' }));

    await userEvent.tab();
    expect(screen.getByRole('button', { name: '退出登录' })).toHaveFocus();
    await userEvent.tab();

    expect(screen.queryByRole('group', { name: '账户操作' })).toBeNull();
  });
});
