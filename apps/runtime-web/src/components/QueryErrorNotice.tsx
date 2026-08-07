// 查询失败的统一提示：401 显示「请先登录」并进入同站自定义登录页，其余展示人话与重试。
import { ApiError, isUnauthenticated } from '../api/client.js';
import { loginUrl } from '../navigation/login.js';

export function QueryErrorNotice({
  error,
  onRetry,
  className = 'rt-empty rt-empty--error',
  navigateToAuth = (target) => window.location.assign(target),
}: {
  error: unknown;
  onRetry: () => void;
  className?: string;
  navigateToAuth?: (target: string) => void;
}) {
  if (isUnauthenticated(error)) {
    return (
      <div className={className} role="alert">
        请先登录。{' '}
        <button
          type="button"
          className="rt-btn rt-btn--accent"
          onClick={() => navigateToAuth(loginUrl())}
        >
          去登录
        </button>
      </div>
    );
  }
  const message = error instanceof ApiError ? error.userMessage : '加载失败，请稍后重试。';
  return (
    <div className={className} role="alert">
      {message}{' '}
      <button type="button" className="rt-btn" onClick={onRetry}>
        重试
      </button>
    </div>
  );
}
