import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useCreateReleasedAgentSession } from '../api/runtime.js';
import { runtimeBackLabel, safeCreatorRuntimeReturnTo } from '../navigation/runtimeReturn.js';
import { runCapabilityDeepLink, type CapabilityDeepLinkFailure } from './CapabilityDeepLink.js';

function externalNavigate(to: string): void {
  window.location.replace(to);
}

/** `/try/a/:projectId` 只解析一次当前 Release，成功后进入固定 Revision 的普通会话。 */
export function AgentProjectDeepLink() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const createSession = useCreateReleasedAgentSession();
  const fired = useRef(false);
  const returnTo = safeCreatorRuntimeReturnTo(searchParams.get('returnTo'));
  const [failure, setFailure] = useState<CapabilityDeepLinkFailure | null>(null);

  const start = useCallback((): void => {
    void runCapabilityDeepLink({
      capabilityId: projectId,
      guard: fired,
      createSession: (id) => createSession.mutateAsync(id),
      navigate,
      returnTo,
      onFailure: setFailure,
    });
  }, [createSession, navigate, projectId, returnTo]);

  useEffect(() => start(), [start]);

  if (failure) {
    return (
      <section className="rt-loading rt-error" aria-labelledby="rt-agent-release-error-title">
        <div>
          <h1 id="rt-agent-release-error-title">Agent 暂时没有打开</h1>
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
  return <p className="rt-deeplink">正在打开固定版本的 Agent…</p>;
}
