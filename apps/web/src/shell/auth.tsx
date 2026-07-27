// 会话身份与登录守卫。浏览器只携带 HttpOnly 会话 Cookie，身份事实始终来自 GET /api/v1/me。
import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import { Outlet } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { sanitizeAuthReturnTo, type MeView } from '@cb/shared';
import { probeAuthSession } from '../api/auth.js';
import { ComboWordmark } from './brand.js';

/** 仓库内完全自定义的登录路由。 */
export const AUTH_LOGIN_PATH = '/login';

/** 只把共享白名单允许的站内路径带到登录页。 */
export function loginUrl(returnTo?: string): string {
  if (!returnTo) return AUTH_LOGIN_PATH;
  const safeReturnTo = sanitizeAuthReturnTo(returnTo);
  return `${AUTH_LOGIN_PATH}?returnTo=${encodeURIComponent(safeReturnTo)}`;
}

/** 整页进入公开登录路由，避免跨前端 bundle 的深链被当前 Router 截获。 */
export function goToLogin(
  returnTo?: string,
  navigate: (url: string) => void = (url) => window.location.assign(url),
): void {
  navigate(loginUrl(returnTo));
}

function currentReturnTo(): string {
  return sanitizeAuthReturnTo(window.location.pathname + window.location.search);
}

export type MeProbe =
  | { status: 'authed'; me: MeView }
  | { status: 'anon' }
  | { status: 'disabled' }
  | { status: 'error' };

/** 只有短暂依赖故障保留上次身份；401 与账号停用都会立即撤销受保护界面。 */
export function reconcileMeProbe(previous: MeProbe | undefined, next: MeProbe): MeProbe {
  if (next.status === 'error' && previous?.status === 'authed') return previous;
  return next;
}

/** 单次 /me 探针，不续期、不重放，也不接受浏览器可读令牌。 */
export async function fetchMe(signal?: AbortSignal): Promise<MeProbe> {
  const probe = await probeAuthSession(signal);
  if (probe.status === 'authed') return probe;
  return { status: probe.status };
}

export function useMe(): ReturnType<typeof useQuery<MeProbe>> {
  const queryClient = useQueryClient();
  return useQuery<MeProbe>({
    queryKey: ['me'],
    queryFn: async ({ signal }) => {
      const next = await fetchMe(signal);
      return reconcileMeProbe(queryClient.getQueryData<MeProbe>(['me']), next);
    },
    retry: false,
    staleTime: 5 * 60_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
  });
}

export type AuthStatus = 'loading' | 'authed' | 'anon' | 'disabled' | 'error';

export interface AuthState {
  status: AuthStatus;
  me: MeView | null;
  refetch: () => void;
}

const AuthContext = createContext<AuthState>({
  status: 'loading',
  me: null,
  refetch: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }): ReactElement {
  const query = useMe();
  const refetch = (): void => {
    void query.refetch();
  };
  const state: AuthState = query.isPending
    ? { status: 'loading', me: null, refetch }
    : query.isError || !query.data
      ? { status: 'error', me: null, refetch }
      : query.data.status === 'authed'
        ? { status: 'authed', me: query.data.me, refetch }
        : { status: query.data.status, me: null, refetch };
  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

function GatePanel({
  role,
  variant = 'compact',
  labelledBy,
  children,
}: {
  role: 'status' | 'alert';
  variant?: 'compact' | 'login';
  labelledBy?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      className="cb-auth-gate"
      role={role}
      aria-live={role === 'status' ? 'polite' : undefined}
      aria-labelledby={labelledBy}
    >
      <div className={`cb-auth-gate__panel cb-auth-gate__panel--${variant}`}>
        <span className="cb-auth-gate__brand" aria-hidden="true">
          <ComboWordmark className="cb-auth-gate__brand-word" />
        </span>
        <p className="cb-auth-gate__eyebrow">CREATOR STUDIO</p>
        {children}
      </div>
    </div>
  );
}

function AuthLoading(): ReactElement {
  return (
    <GatePanel role="status">
      <p className="cb-auth-gate__msg">正在确认登录状态…</p>
    </GatePanel>
  );
}

function AuthLoginGate(): ReactElement {
  return (
    <GatePanel role="alert" variant="login" labelledBy="creator-login-title">
      <p className="cb-auth-gate__msg cb-auth-gate__msg--login">请先登录后进入创作者中心。</p>
      <h1 id="creator-login-title" className="cb-auth-gate__title">
        继续创建你的能力
      </h1>
      <p className="cb-auth-gate__intro">上传真实会话，提取可复用的能力项，并继续未完成的任务。</p>
      <ol className="cb-auth-gate__flow" aria-label="创作者中心流程">
        <li>上传会话</li>
        <li>提取能力</li>
        <li>确认发布</li>
      </ol>
      <p className="cb-auth-gate__trust">
        <strong>公开边界</strong>
        <span>只有你确认发布的能力会出现在试用页，原始会话不会进入试用页。</span>
      </p>
      <div className="cb-auth-gate__actions cb-auth-gate__actions--login">
        <button
          type="button"
          className="cb-auth-gate__action"
          onClick={() => goToLogin(currentReturnTo())}
        >
          去登录
        </button>
        <p className="cb-auth-gate__return-note">登录完成后，将回到你刚才访问的页面。</p>
      </div>
    </GatePanel>
  );
}

function AuthDisabledGate(): ReactElement {
  return (
    <GatePanel role="alert">
      <p className="cb-auth-gate__msg">当前账号已停用，无法继续访问。请联系支持人员处理。</p>
    </GatePanel>
  );
}

function AuthErrorGate({ onRetry }: { onRetry: () => void }): ReactElement {
  return (
    <GatePanel role="alert">
      <p className="cb-auth-gate__msg">暂时无法确认登录状态，请稍后重试。</p>
      <div className="cb-auth-gate__actions">
        <button type="button" className="cb-auth-gate__action" onClick={onRetry}>
          重试
        </button>
      </div>
    </GatePanel>
  );
}

export function RequireAuth(): ReactElement {
  const { status, refetch } = useAuth();
  if (status === 'loading') return <AuthLoading />;
  if (status === 'anon') return <AuthLoginGate />;
  if (status === 'disabled') return <AuthDisabledGate />;
  if (status === 'error') return <AuthErrorGate onRetry={refetch} />;
  return <Outlet />;
}
