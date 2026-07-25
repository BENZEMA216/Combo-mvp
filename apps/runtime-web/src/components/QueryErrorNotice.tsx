// 查询失败的统一提示：401 显示「请先登录」并给创作端登录入口，其余展示人话 + 重试。
import { ApiError, isUnauthenticated } from '../api/client.js';
import { authenticationUrl } from '../navigation/login.js';
import { useReleaseMetadata } from '../shell/releaseIdentity.js';

export function QueryErrorNotice({
  error,
  onRetry,
  navigateToAuth = (target) => window.location.assign(target),
}: {
  error: unknown;
  onRetry: () => void;
  navigateToAuth?: (target: string) => void;
}) {
  const releaseMetadata = useReleaseMetadata();
  if (isUnauthenticated(error)) {
    const preview = releaseMetadata.environment === 'preview';
    return (
      <div className="rt-empty rt-empty--error">
        {preview ? '预览会话已失效。' : '请先登录。'}{' '}
        <button
          type="button"
          className="rt-btn rt-btn--accent"
          onClick={() => navigateToAuth(authenticationUrl(releaseMetadata.environment))}
        >
          {preview ? '恢复预览会话' : '去登录'}
        </button>
      </div>
    );
  }
  const message = error instanceof ApiError ? error.userMessage : '加载失败，请稍后重试。';
  return (
    <div className="rt-empty rt-empty--error">
      {message}{' '}
      <button type="button" className="rt-btn" onClick={onRetry}>
        重试
      </button>
    </div>
  );
}
