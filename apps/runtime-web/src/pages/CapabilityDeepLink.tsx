// 深链承接页：创作端「去试用」跳 /try/c/:capabilityId，进来即为该能力建会话并转入对话页。
// 建会话失败（未发布且非本人 / 已删除）→ 展示错误并提供创作来源回跳；市集当前不开放。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useCreateSession } from '../api/runtime.js';
import {
  appendRuntimeReturnTo,
  runtimeBackLabel,
  safeCreatorRuntimeReturnTo,
} from '../navigation/runtimeReturn.js';

export interface CapabilityDeepLinkGuard {
  current: boolean;
}

export interface CapabilityDeepLinkFailure {
  message: string;
  returnTo: string;
}

export interface CapabilityDeepLinkProps {
  /** 测试注入点；生产失败回跳必须离开 runtime-web 的 /try basename。 */
  externalNavigate?: (to: string) => void;
}

function defaultExternalNavigate(to: string): void {
  window.location.replace(to);
}

/**
 * 深链副作用的可测收口：同步占 guard 后只 POST 一次；成功 replace 到会话；失败把
 * 经白名单校验的创作端回跳目标交给页面展示，不能在 runtime basename 内静默 navigate。
 * React StrictMode 重跑 effect 时复用同一 ref，第二次会在发请求前退出。
 */
export async function runCapabilityDeepLink(input: {
  capabilityId: string | undefined;
  guard: CapabilityDeepLinkGuard;
  createSession: (capabilityId: string) => Promise<{ id: string }>;
  navigate: (to: string, options: { replace: true }) => void;
  returnTo?: string | null;
  onFailure?: (failure: CapabilityDeepLinkFailure) => void;
}): Promise<void> {
  if (!input.capabilityId || input.guard.current) return;
  input.guard.current = true;
  try {
    const session = await input.createSession(input.capabilityId);
    input.navigate(
      appendRuntimeReturnTo(`/session/${session.id}`, safeCreatorRuntimeReturnTo(input.returnTo)),
      { replace: true },
    );
  } catch (error) {
    input.onFailure?.({
      message:
        error instanceof Error && error.message
          ? error.message
          : '试用会话没有创建成功，请稍后重试。',
      returnTo: safeCreatorRuntimeReturnTo(input.returnTo) ?? '/capabilities',
    });
  }
}

export function CapabilityDeepLink({
  externalNavigate = defaultExternalNavigate,
}: CapabilityDeepLinkProps = {}) {
  const { capabilityId } = useParams<{ capabilityId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const createSession = useCreateSession();
  const fired = useRef(false);
  const returnTo = safeCreatorRuntimeReturnTo(searchParams.get('returnTo'));
  const [failure, setFailure] = useState<CapabilityDeepLinkFailure | null>(null);

  const start = useCallback((): void => {
    void runCapabilityDeepLink({
      capabilityId,
      guard: fired,
      createSession: (id) => createSession.mutateAsync(id),
      navigate,
      returnTo,
      onFailure: setFailure,
    });
  }, [capabilityId, createSession, navigate, returnTo]);

  // 挂载即建会话并转入对话页。跳转走 mutateAsync 的 promise，而不是 mutate 的 per-call
  // 回调 / 组件读 mutation 状态——StrictMode 双挂载会销毁旧 observer 重建新 observer，
  // 挂载即触发的 mutate 回调会被孤立、其结果也不落到当前 observer 上，导致会话已建（201）
  // 却永不跳转。mutateAsync 的 promise 不依赖组件挂载态，dev/prod 都可靠。
  // fired ref 防重复建会话；不用 cancelled 标志（否则首跑 cleanup 会把唯一一次跳转也吞掉）。
  useEffect(() => {
    start();
  }, [start]);

  if (failure) {
    return (
      <section className="rt-loading rt-error" aria-labelledby="rt-deeplink-error-title">
        <div>
          <h1 id="rt-deeplink-error-title">试用暂时没有打开</h1>
          <p role="alert">{failure.message}</p>
          <button
            type="button"
            className="rt-btn rt-btn--accent"
            onClick={() => {
              fired.current = false;
              setFailure(null);
              start();
            }}
          >
            重试
          </button>
          <button
            type="button"
            className="rt-btn"
            onClick={() => externalNavigate(failure.returnTo)}
          >
            {runtimeBackLabel(failure.returnTo).replace(/^←\s*/, '')}
          </button>
        </div>
      </section>
    );
  }

  return <p className="rt-deeplink">正在为你打开试用会话…</p>;
}
