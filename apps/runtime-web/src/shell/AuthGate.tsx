// 登录闸门 + 会话身份上下文。试用端所有 runtime 接口都要登录，所以这里仍是硬闸门：
// 未登录/未知态不放行子树。放行后把 MeView 灌进 context，侧栏账号区经 useRuntimeMe 读真身。
// 视觉是 Combo 网格纸底 + 居中面板（rt-auth-gate__panel）。
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MeViewSchema, envelopeSchema, type MeView } from '@cb/shared';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { ComboMark, ComboWordmark } from '../components/ComboBrand.js';
import { authenticationUrl } from '../navigation/login.js';
import { refreshSession } from '../api/sessionRefresh.js';
import { useReleaseMetadata } from './releaseIdentity.js';

const MeEnvelopeSchema = envelopeSchema(MeViewSchema);
const DEV_LOGIN_PATH = '/api/v1/auth/dev-login';
const ME_PATH = '/api/v1/me';
const RUNTIME_ME_QUERY_KEY = ['runtime-web-me'] as const;
const LOCAL_DEV_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0']);
export const AUTH_PROBE_TIMEOUT_MS = 8_000;

const RuntimeMeContext = createContext<MeView | null>(null);

/** 当前登录身份（AuthGate 放行后必有值；组件树在闸门内时 null 只是理论兜底）。 */
export function useRuntimeMe(): MeView | null {
  return useContext(RuntimeMeContext);
}

export type RuntimeMeProbe =
  | { status: 'authed'; me: MeView }
  | { status: 'anon' }
  | { status: 'error' };

/** 已确认的 runtime 身份不被上游短暂故障撤销；只有明确 anon 才覆盖旧会话。 */
export function reconcileRuntimeMeProbe(
  previous: RuntimeMeProbe | undefined,
  next: RuntimeMeProbe,
): RuntimeMeProbe {
  if (next.status === 'error' && previous?.status === 'authed') return previous;
  return next;
}

async function requestMe(signal: AbortSignal): Promise<RuntimeMeProbe> {
  const res = await fetch(ME_PATH, {
    method: 'GET',
    credentials: 'include',
    signal,
  });

  if (res.status === 401) return { status: 'anon' };
  if (!res.ok) return { status: 'error' };
  const body = (await res.json()) as unknown;
  const parsed = MeEnvelopeSchema.safeParse(body);
  return parsed.success ? { status: 'authed', me: parsed.data.data } : { status: 'error' };
}

/**
 * /me 探针 UI 必须 8s 有界。refresh 一旦发出则不被这个短超时 abort：
 * Logto 可能已旋转 RT，必须允许后端 Set-Cookie 继续到达。UI 超时时先返 error，后台续期继续。
 * 仅首次明确 401 才尝试一次 refresh；成功后也只重试一次 /me，绝不循环。
 */
export async function fetchMe(
  signal?: AbortSignal,
  timeoutMs = AUTH_PROBE_TIMEOUT_MS,
): Promise<RuntimeMeProbe> {
  const requestController = new AbortController();
  let stopProbe!: (reason: 'timeout' | 'query-abort') => void;
  const stopped = new Promise<'timeout' | 'query-abort'>((resolve) => {
    stopProbe = resolve;
  });
  const abortFromQuery = () => {
    requestController.abort();
    stopProbe('query-abort');
  };
  if (signal?.aborted) abortFromQuery();
  else signal?.addEventListener('abort', abortFromQuery, { once: true });
  const timeout = setTimeout(() => {
    requestController.abort();
    stopProbe('timeout');
  }, timeoutMs);

  try {
    const initialProbe = await requestMe(requestController.signal);
    if (initialProbe.status !== 'anon') return initialProbe;

    const refreshOutcome = await Promise.race([refreshSession(), stopped]);
    if (refreshOutcome === 'query-abort') {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    if (refreshOutcome === 'timeout') return { status: 'error' };
    if (refreshOutcome === 'rejected') return { status: 'anon' };
    if (refreshOutcome === 'error') return { status: 'error' };

    return await requestMe(requestController.signal);
  } catch (cause) {
    // React Query 主动取消时继续透传；网络失败或我们自己的超时显示可重试错误态。
    if (signal?.aborted) throw cause;
    return { status: 'error' };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromQuery);
  }
}

function canUseLocalDevLogin(): boolean {
  return LOCAL_DEV_HOSTS.has(window.location.hostname);
}

/** 闸门裸页外壳：网格纸底 + 居中 Combo 面板，三态（加载/错误/未登录）共用。 */
function GatePanel({ role, children }: { role: 'status' | 'alert'; children: ReactNode }) {
  return (
    <div className="rt-auth-gate" role={role} aria-live={role === 'status' ? 'polite' : undefined}>
      <div className="rt-auth-gate__panel">
        <span className="rt-auth-gate__brand">
          <ComboMark className="rt-auth-gate__brand-mark" />
          <ComboWordmark className="rt-auth-gate__brand-word" />
        </span>
        <p className="rt-auth-gate__eyebrow">CAPABILITY RUNTIME</p>
        {children}
      </div>
    </div>
  );
}

export function AuthGate({
  children,
  navigateToAuth = (target) => window.location.assign(target),
}: {
  children: ReactNode;
  navigateToAuth?: (target: string) => void;
}) {
  const [devLoginError, setDevLoginError] = useState<string | null>(null);
  const [devLoginPending, setDevLoginPending] = useState(false);
  const queryClient = useQueryClient();
  const releaseMetadata = useReleaseMetadata();
  const q = useQuery<RuntimeMeProbe>({
    queryKey: RUNTIME_ME_QUERY_KEY,
    queryFn: async ({ signal }) => {
      const next = await fetchMe(signal);
      return reconcileRuntimeMeProbe(
        queryClient.getQueryData<RuntimeMeProbe>(RUNTIME_ME_QUERY_KEY),
        next,
      );
    },
    retry: false,
    staleTime: 5 * 60_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
  });

  async function runDevLogin() {
    setDevLoginPending(true);
    setDevLoginError(null);
    try {
      const res = await fetch(DEV_LOGIN_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: '{}',
      });
      if (!res.ok) throw new Error('dev-login failed');
      await q.refetch();
    } catch {
      setDevLoginError('本地开发登录不可用，请检查 Docker 是否叠加 dev-test override。');
    } finally {
      setDevLoginPending(false);
    }
  }

  if (q.isPending) {
    return (
      <GatePanel role="status">
        <p className="rt-auth-gate__msg">正在确认登录状态…</p>
      </GatePanel>
    );
  }

  if (q.isError || !q.data || q.data.status === 'error') {
    return (
      <GatePanel role="alert">
        <p className="rt-auth-gate__msg">暂时无法确认登录状态，请稍后重试。</p>
        <div className="rt-auth-gate__actions">
          <button type="button" className="rt-btn rt-btn--accent" onClick={() => void q.refetch()}>
            重试
          </button>
        </div>
      </GatePanel>
    );
  }

  if (q.data.status === 'anon') {
    const preview = releaseMetadata.environment === 'preview';
    const showDevLogin = releaseMetadata.environment === 'development' && canUseLocalDevLogin();
    return (
      <GatePanel role="alert">
        <p className="rt-auth-gate__msg">
          {preview ? '预览会话已失效，请恢复后继续。' : '请先登录后进入试用模式。'}
        </p>
        <div className="rt-auth-gate__actions">
          <button
            type="button"
            className="rt-btn rt-btn--accent"
            onClick={() => navigateToAuth(authenticationUrl(releaseMetadata.environment))}
          >
            {preview ? '恢复预览会话' : '去登录'}
          </button>
          {showDevLogin ? (
            <button
              type="button"
              className="rt-btn"
              disabled={devLoginPending}
              onClick={() => void runDevLogin()}
            >
              {devLoginPending ? '登录中…' : '本地开发登录'}
            </button>
          ) : null}
          {devLoginError ? <p className="rt-auth-gate__error">{devLoginError}</p> : null}
        </div>
      </GatePanel>
    );
  }

  return <RuntimeMeContext.Provider value={q.data.me}>{children}</RuntimeMeContext.Provider>;
}
