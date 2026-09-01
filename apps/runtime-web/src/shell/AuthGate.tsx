// Runtime 登录闸门。身份只来自共享的 PostgreSQL 会话 Cookie 与 GET /api/v1/me。
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MeResponseSchema, type MeView } from '@cb/shared';
import { createContext, useContext, type ReactNode } from 'react';
import { ComboMark, ComboWordmark } from '../components/ComboBrand.js';
import { loginUrl } from '../navigation/login.js';

const ME_PATH = '/api/v1/me';
const RUNTIME_ME_QUERY_KEY = ['runtime-web-me'] as const;
export const AUTH_PROBE_TIMEOUT_MS = 8_000;

const RuntimeMeContext = createContext<MeView | null>(null);

export function useRuntimeMe(): MeView | null {
  return useContext(RuntimeMeContext);
}

export type RuntimeMeProbe =
  | { status: 'authed'; me: MeView }
  | { status: 'anon' }
  | { status: 'disabled' }
  | { status: 'error' };

/** 只有短暂依赖故障保留上次身份；401 与账号停用都会立即撤销受保护界面。 */
export function reconcileRuntimeMeProbe(
  previous: RuntimeMeProbe | undefined,
  next: RuntimeMeProbe,
): RuntimeMeProbe {
  if (next.status === 'error' && previous?.status === 'authed') return previous;
  return next;
}

async function requestMe(signal: AbortSignal): Promise<RuntimeMeProbe> {
  const response = await fetch(ME_PATH, {
    method: 'GET',
    credentials: 'include',
    signal,
  });

  if (response.status === 401) return { status: 'anon' };
  if (response.status === 403) return { status: 'disabled' };
  if (!response.ok) return { status: 'error' };
  const parsed = MeResponseSchema.safeParse((await response.json()) as unknown);
  return parsed.success ? { status: 'authed', me: parsed.data.data } : { status: 'error' };
}

/** 单次、有界的 /me 探针；固定会话没有 refresh，也不自动重放。 */
export async function fetchMe(
  signal?: AbortSignal,
  timeoutMs = AUTH_PROBE_TIMEOUT_MS,
): Promise<RuntimeMeProbe> {
  const controller = new AbortController();
  const abortFromQuery = (): void => controller.abort();
  if (signal?.aborted) abortFromQuery();
  else signal?.addEventListener('abort', abortFromQuery, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await requestMe(controller.signal);
  } catch (cause) {
    if (signal?.aborted) throw cause;
    return { status: 'error' };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromQuery);
  }
}

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
  anonymous,
  returnTo,
  navigateToAuth = (target) => window.location.assign(target),
}: {
  children: ReactNode;
  anonymous?: ReactNode;
  returnTo?: string;
  navigateToAuth?: (target: string) => void;
}) {
  const queryClient = useQueryClient();
  const query = useQuery<RuntimeMeProbe>({
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

  if (query.isPending) {
    return (
      <GatePanel role="status">
        <p className="rt-auth-gate__msg">正在确认登录状态…</p>
      </GatePanel>
    );
  }

  if (query.isError || !query.data || query.data.status === 'error') {
    return (
      <GatePanel role="alert">
        <p className="rt-auth-gate__msg">暂时无法确认登录状态，请稍后重试。</p>
        <div className="rt-auth-gate__actions">
          <button
            type="button"
            className="rt-btn rt-btn--accent"
            onClick={() => void query.refetch()}
          >
            重试
          </button>
        </div>
      </GatePanel>
    );
  }

  if (query.data.status === 'disabled') {
    return (
      <GatePanel role="alert">
        <p className="rt-auth-gate__msg">当前账号已停用，无法继续访问。请联系支持人员处理。</p>
      </GatePanel>
    );
  }

  if (query.data.status === 'anon') {
    if (anonymous !== undefined) return anonymous;
    return (
      <GatePanel role="alert">
        <p className="rt-auth-gate__msg">请先登录后进入试用模式。</p>
        <div className="rt-auth-gate__actions">
          <button
            type="button"
            className="rt-btn rt-btn--accent"
            onClick={() => navigateToAuth(loginUrl(returnTo))}
          >
            去登录
          </button>
        </div>
      </GatePanel>
    );
  }

  return <RuntimeMeContext.Provider value={query.data.me}>{children}</RuntimeMeContext.Provider>;
}
