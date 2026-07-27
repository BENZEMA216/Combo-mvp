import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { LogoutResult, ReleaseMetadata } from '@cb/shared';
import { completeLogout, logoutSession } from '../api/sessionLogout.js';
import { avatarInitial, type ShellAccount } from './account.js';
import { IconChevronDown, IconLogout } from './icons.js';

type LogoutState = 'idle' | 'pending' | 'error';

export interface AccountMenuProps {
  account: ShellAccount;
  /** 测试注入点；生产默认调用真实 logout endpoint。 */
  requestLogout?: () => Promise<LogoutResult | null>;
  /** 测试注入点；生产默认整页跳转。 */
  navigateAfterLogout?: (url: string) => void;
  /** 运行时发布环境；Preview 登出后返回外层访问闸。 */
  environment?: ReleaseMetadata['environment'];
}

/** 侧边栏账号入口：展开态整行、收起态头像都能打开同一个可访问菜单。 */
export function AccountMenu({
  account,
  requestLogout = logoutSession,
  navigateAfterLogout,
  environment = 'development',
}: AccountMenuProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [logoutState, setLogoutState] = useState<LogoutState>('idle');
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const logoutInFlightRef = useRef(false);
  const menuId = 'creator-account-menu';
  const accountLabel = `${account.name} · ${account.title}`;

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const toggleMenu = (): void => {
    if (!open && logoutState !== 'pending') setLogoutState('idle');
    setOpen(!open);
  };

  const handleLogout = async (): Promise<void> => {
    if (logoutInFlightRef.current) return;
    logoutInFlightRef.current = true;
    setLogoutState('pending');
    let result: LogoutResult | null = null;
    try {
      result = await requestLogout();
    } catch {
      result = null;
    }
    if (!result) {
      logoutInFlightRef.current = false;
      setLogoutState('error');
      return;
    }
    completeLogout(
      result,
      navigateAfterLogout,
      environment,
      window.location.pathname + window.location.search,
    );
  };

  return (
    <div
      className="cb-shell__account"
      ref={rootRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="cb-shell__account-trigger"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`${open ? '关闭' : '打开'}账户菜单：${accountLabel}`}
        title={`账户：${accountLabel}`}
        onClick={toggleMenu}
      >
        <AccountAvatar account={account} className="cb-shell__account-avatar" />
        <span className="cb-shell__account-meta" aria-hidden="true">
          <span className="cb-shell__account-name">{account.name}</span>
          <span className="cb-shell__account-title">{account.title}</span>
        </span>
        <IconChevronDown className="cb-shell__account-chevron" />
      </button>

      {open ? (
        <div id={menuId} className="cb-shell__account-menu" role="group" aria-label="账户操作">
          <p className="cb-shell__account-menu-label" title={account.name}>
            {account.name}
          </p>
          <button
            type="button"
            className="cb-shell__logout"
            disabled={logoutState === 'pending'}
            onClick={() => void handleLogout()}
          >
            <IconLogout className="cb-shell__logout-icon" />
            <span>{logoutState === 'pending' ? '正在退出…' : '退出登录'}</span>
          </button>
          {logoutState === 'error' ? (
            <p className="cb-shell__logout-error" role="alert">
              暂时无法退出，请重试。
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 账号头像：有 URL 用图，缺省走首字母兜底（非破图）。 */
function AccountAvatar({
  account,
  className,
}: {
  account: ShellAccount;
  className?: string;
}): ReactElement {
  const cls = className ? `cb-avatar ${className}` : 'cb-avatar';
  const alt = `${account.name} · ${account.title}`;
  if (account.avatarUrl) {
    return <img className={cls} src={account.avatarUrl} alt={alt} />;
  }
  return (
    <span className={cls} role="img" aria-label={alt}>
      {avatarInitial(account.name)}
    </span>
  );
}
