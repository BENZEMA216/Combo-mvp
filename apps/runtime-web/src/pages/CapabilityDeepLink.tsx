// 深链承接页：创作端「去试用」跳 /try/c/:capabilityId，进来即为该能力建会话并转入对话页。
// 建会话失败（未发布且非本人 / 已删除）→ 回「我的 Agent」；市集当前不开放。
import { useEffect, useRef } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useCreateSession } from '../api/runtime.js';
import { appendRuntimeReturnTo, safeTaskRuntimeReturnTo } from '../navigation/runtimeReturn.js';

export interface CapabilityDeepLinkGuard {
  current: boolean;
}

/**
 * 深链副作用的可测收口：同步占 guard 后只 POST 一次；成功 replace 到会话，失败回 Agent 列表。
 * React StrictMode 重跑 effect 时复用同一 ref，第二次会在发请求前退出。
 */
export async function runCapabilityDeepLink(input: {
  capabilityId: string | undefined;
  guard: CapabilityDeepLinkGuard;
  createSession: (capabilityId: string) => Promise<{ id: string }>;
  navigate: (to: string, options: { replace: true }) => void;
  returnTo?: string | null;
}): Promise<void> {
  if (!input.capabilityId || input.guard.current) return;
  input.guard.current = true;
  try {
    const session = await input.createSession(input.capabilityId);
    input.navigate(
      appendRuntimeReturnTo(`/session/${session.id}`, safeTaskRuntimeReturnTo(input.returnTo)),
      { replace: true },
    );
  } catch {
    input.navigate('/capabilities', { replace: true });
  }
}

export function CapabilityDeepLink() {
  const { capabilityId } = useParams<{ capabilityId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const createSession = useCreateSession();
  const fired = useRef(false);
  const returnTo = safeTaskRuntimeReturnTo(searchParams.get('returnTo'));

  // 挂载即建会话并转入对话页。跳转走 mutateAsync 的 promise，而不是 mutate 的 per-call
  // 回调 / 组件读 mutation 状态——StrictMode 双挂载会销毁旧 observer 重建新 observer，
  // 挂载即触发的 mutate 回调会被孤立、其结果也不落到当前 observer 上，导致会话已建（201）
  // 却永不跳转。mutateAsync 的 promise 不依赖组件挂载态，dev/prod 都可靠。
  // fired ref 防重复建会话；不用 cancelled 标志（否则首跑 cleanup 会把唯一一次跳转也吞掉）。
  useEffect(() => {
    void runCapabilityDeepLink({
      capabilityId,
      guard: fired,
      createSession: (id) => createSession.mutateAsync(id),
      navigate,
      returnTo,
    });
  }, [capabilityId, createSession, navigate, returnTo]);

  return <p className="rt-deeplink">正在为你打开试用会话…</p>;
}
