// 会话身份 / 登录守卫（B-08 接入）——接 GET /api/v1/me（requireAuth；匿名 401）。
//
// 四态收敛（永不裸转圈 / 绝不裸露错误码）：
//   loading → 「正在确认登录状态…」诚实加载文案（非工作台骨架、非 Wayne 外壳）。
//   anon    → 裸登录闸门（无创作者外壳/侧栏/账号）：人话 + 「去登录」（跳后端登录端点，带 returnTo）。
//   error   → 初次探针时登录服务暂时不可用（503/500/403/网络）：人话 + 「重试」，不伪装成 anon。
//   authed  → 放行 <Outlet/>，且把真实 MeView 喂给外壳账号区；后续短暂探针错误保留此态，只有 401 撤销。
//
// 401 与其它错误的区分只在内部按 HTTP status 判定：apiGet 抛的 ApiError 丢弃了 status，故这里用专用
// fetchMe()（fetch + credentials:'include' + 同 API_PREFIX）直接读 res.status，绝不把 status 漏到 UI。
//
// 登录是后端 302 重定向端点（非 SPA 路由）：用 window.location.assign 整页跳转，浏览器随重定向去 Logto。
import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import { Outlet } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  API_PREFIX,
  MeViewSchema,
  envelopeSchema,
  type MeView,
  type ReleaseMetadata,
} from '@cb/shared';
import { refreshSession } from '../api/sessionRefresh.js';
import { sanitizeReturnTo } from '../safeReturnTo.js';
import { ComboWordmark } from './brand.js';
import { useReleaseMetadata } from './releaseIdentity.js';

export {
  AUTH_REFRESH_PATH,
  refreshSession,
  type SessionRefreshResult,
} from '../api/sessionRefresh.js';

/** /me 200 包络 schema：与后端一致返回 Envelope<MeView>（{ data, meta? }），解析后读 .data。 */
const MeEnvelopeSchema = envelopeSchema(MeViewSchema);

/** 后端登录入口（302 跳 Logto）。非 SPA 路由：用 window.location.assign 整页跳转。 */
export const AUTH_LOGIN_PATH = '/api/v1/auth/login';
export const PREVIEW_BOOTSTRAP_PATH = '/__review/bootstrap';

/**
 * 拼后端登录 URL：给了 returnTo（站内相对路径）则带 ?returnTo=<encoded>，否则裸路径。
 * 后端对 returnTo 做开放重定向防护 / 站内白名单（缺省回 /tasks），前端只负责诚实携带当前访问上下文，
 * 让登录后回到原页（例如任务详情的 path + query 不丢）。
 */
export function loginUrl(returnTo?: string): string {
  const safeReturnTo = sanitizeReturnTo(returnTo);
  return safeReturnTo
    ? `${AUTH_LOGIN_PATH}?returnTo=${encodeURIComponent(safeReturnTo)}`
    : AUTH_LOGIN_PATH;
}

/** Preview 使用受访问闸保护的 dev-login bootstrap，不把身份恢复请求送往正式 OIDC。 */
export function previewBootstrapUrl(returnTo?: string): string {
  const safeReturnTo = sanitizeReturnTo(returnTo);
  return safeReturnTo
    ? `${PREVIEW_BOOTSTRAP_PATH}?returnTo=${encodeURIComponent(safeReturnTo)}`
    : PREVIEW_BOOTSTRAP_PATH;
}

export function authEntryUrl(
  environment: ReleaseMetadata['environment'],
  returnTo?: string,
): string {
  return environment === 'preview' ? previewBootstrapUrl(returnTo) : loginUrl(returnTo);
}

/** 跳转后端登录端点（整页重定向；非 react-router 导航）。可带 returnTo 站内回跳路径。 */
export function goToLogin(
  returnTo?: string,
  navigate: (url: string) => void = (url) => window.location.assign(url),
): void {
  navigate(loginUrl(returnTo));
}

export function goToAuthEntry(
  environment: ReleaseMetadata['environment'],
  returnTo?: string,
  navigate: (url: string) => void = (url) => window.location.assign(url),
): void {
  navigate(authEntryUrl(environment, returnTo));
}

/** 登录后回跳的「当前位置」：path + query（站内相对，后端再做开放重定向防护）。 */
function currentReturnTo(): string {
  return window.location.pathname + window.location.search;
}

/** /me 探针结果：按 HTTP status 收敛的四态之一（status 只在内部用，绝不渲染到 UI）。 */
export type MeProbe = { status: 'authed'; me: MeView } | { status: 'anon' } | { status: 'error' };

/**
 * /me 短暂失败不应撤销已经确认的会话。只有明确 401 才会以 anon 覆盖旧身份；
 * 5xx / 网络 / 异常响应保留上一次 authed 结果，让用户继续留在已登录界面。
 * 初次探针失败时没有可保留的身份，仍返回 error 显示可重试错误态。
 */
export function reconcileMeProbe(previous: MeProbe | undefined, next: MeProbe): MeProbe {
  if (next.status === 'error' && previous?.status === 'authed') return previous;
  return next;
}

/**
 * 专用 /me 探针：直接读 res.status 区分 401（anon）与其它错误（error），apiGet 的 ApiError 会丢 status 故不用。
 *   200 → authed（按 shared schema 解析 MeView；解析失败按 error 处理，不当成已登录）。
 *   401 → anon（真·未登录 / 会话过期，唯一该给「去登录」的情形）。
 *   其它（403 disabled / 500 / 503 登录服务不可用 / 网络）→ error（人话 + 重试，绝非「请先登录」）。
 * 与 client.ts 一致：同 API_PREFIX、credentials:'include'。status 只在本函数内消费，外部只见四态。
 */
async function fetchMeOnce(signal?: AbortSignal): Promise<MeProbe> {
  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}/me`, {
      method: 'GET',
      credentials: 'include',
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    // 网络层失败 / abort：abort 透传给 react-query（不当成 error 态），其余按 error 收敛。
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    return { status: 'error' };
  }
  if (res.status === 401) return { status: 'anon' };
  if (!res.ok) return { status: 'error' };
  try {
    // 后端 /me 返回轻包络 Envelope<MeView>（{ data, meta? }，见 auth-handlers.ts），先解包再校验，读 .data。
    const body = (await res.json()) as unknown;
    return { status: 'authed', me: MeEnvelopeSchema.parse(body).data };
  } catch {
    // 200 但 body 不是合法 Envelope<MeView>：不冒充已登录，按 error 收敛（给重试，不给去登录）。
    return { status: 'error' };
  }
}

/**
 * /me 完整探针：第一次 401 时最多尝试一次 refresh，成功后只再试一次 /me。
 * 第二次仍 401 或 refresh 失败直接 anon，不递归、不循环；非 401 仍按原四态收敛。
 */
export async function fetchMe(signal?: AbortSignal): Promise<MeProbe> {
  const first = await fetchMeOnce(signal);
  if (first.status !== 'anon') return first;
  // refresh 一旦发出不跟随页面 abort，避免 Logto 已旋转 RT 但 Set-Cookie 未到达。
  const refreshed = await refreshSession();
  if (refreshed === 'rejected') return { status: 'anon' };
  if (refreshed === 'error') return { status: 'error' };
  return fetchMeOnce(signal);
}

/**
 * /me 拉取：探针自身把 401/其它错误收敛成 MeProbe（不抛）；查询层再把已认证后的短暂 error
 * 与上一次 authed 结果合并。retry:false——单次尝试即收敛，绝不裸自旋；身份变更不频繁，缓存几分钟。
 */
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
    // 长页面 / SSE 打开期间也定期探针；access 过期后在业务请求前尽快续期。
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
  });
}

export type AuthStatus = 'loading' | 'authed' | 'anon' | 'error';

export interface AuthState {
  status: AuthStatus;
  me: MeView | null;
  /** 重拉 /me（error 态「重试」用；非去登录——它不是认证失败）。 */
  refetch: () => void;
}

const AuthContext = createContext<AuthState>({
  status: 'loading',
  me: null,
  refetch: () => {},
});

/** 全局会话身份 Provider：把 /me 探针四态收敛成 {status, me}，供守卫与外壳消费。 */
export function AuthProvider({ children }: { children: ReactNode }): ReactElement {
  const q = useMe();
  const refetch = (): void => {
    void q.refetch();
  };
  // 探针不抛错（abort 除外），故四态来自 isPending + probe.status；isError 极罕见（abort 等）按 error 兜底。
  const state: AuthState = q.isPending
    ? { status: 'loading', me: null, refetch }
    : q.isError || !q.data
      ? { status: 'error', me: null, refetch }
      : q.data.status === 'authed'
        ? { status: 'authed', me: q.data.me, refetch }
        : { status: q.data.status, me: null, refetch };
  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

/** 闸门裸页外壳：网格纸底 + 居中 Combo 面板，三态（加载/匿名/错误）共用。 */
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

/** 加载态：诚实文案（非工作台骨架、非 Wayne 外壳），有限态、不裸转圈。 */
function AuthLoading(): ReactElement {
  return (
    <GatePanel role="status">
      <p className="cb-auth-gate__msg">正在确认登录状态…</p>
    </GatePanel>
  );
}

/** 匿名闸门：裸页（无创作者外壳/侧栏/账号），人话 + 「去登录」（带 returnTo 回当前页）。 */
function AuthLoginGate(): ReactElement {
  const releaseMetadata = useReleaseMetadata();
  const preview = releaseMetadata.environment === 'preview';
  return (
    <GatePanel role="alert" variant="login" labelledBy="creator-login-title">
      <p className="cb-auth-gate__msg cb-auth-gate__msg--login">
        {preview ? '预览会话已失效，请恢复后继续。' : '请先登录后进入创作者中心。'}
      </p>
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
          onClick={() => goToAuthEntry(releaseMetadata.environment, currentReturnTo())}
        >
          {preview ? '恢复预览会话' : '去登录'}
        </button>
        <p className="cb-auth-gate__return-note">
          {preview ? '预览身份恢复后' : '登录完成后'}，将回到你刚才访问的页面。
        </p>
      </div>
    </GatePanel>
  );
}

/**
 * 错误闸门：登录状态暂时确认不了（登录服务不可用 / 后端异常 / 网络）——不是「请先登录」。
 * 人话 + 「重试」重拉 /me（非去登录 CTA），绝不裸露 HTTP/状态码（D1）。
 */
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

/**
 * 路由守卫元素：authed → <Outlet/>；loading → 诚实加载页；anon → 登录闸门；error → 错误闸门（重试，非去登录）。
 * 仅放行已登录用户进创作者外壳——一举堵住未登录看到 Wayne 外壳 / 仪表盘 401 裸转圈 / 受保护页直达 /
 * /create 未登录自动 POST 草稿（向导根本不挂载）。登录服务故障时不再被伪装成「请先登录」。
 */
export function RequireAuth(): ReactElement {
  const { status, refetch } = useAuth();
  if (status === 'loading') return <AuthLoading />;
  if (status === 'anon') return <AuthLoginGate />;
  if (status === 'error') return <AuthErrorGate onRetry={refetch} />;
  return <Outlet />;
}
