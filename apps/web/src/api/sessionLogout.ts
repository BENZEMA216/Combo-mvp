import {
  API_PREFIX,
  LogoutResponseSchema,
  type LogoutResult,
  type ReleaseMetadata,
} from '@cb/shared';
import { sanitizeReturnTo } from '../safeReturnTo.js';

/** 后端幂等登出入口：撤销可识别会话并清除同一枚 HttpOnly Cookie。 */
export const AUTH_LOGOUT_PATH = `${API_PREFIX}/auth/logout`;

/**
 * 清理当前浏览器会话。失败返回 null，调用方保留菜单并提供可重试的人话错误。
 * 端点要求严格 JSON `{}`，不经过业务请求重放逻辑。
 */
export async function logoutSession(): Promise<LogoutResult | null> {
  try {
    const response = await fetch(AUTH_LOGOUT_PATH, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) return null;
    return LogoutResponseSchema.parse((await response.json()) as unknown).data;
  } catch {
    return null;
  }
}

/** 登出后回到仓库内邮箱登录页；Preview 可保留安全的任务上下文。 */
export function logoutDestination(
  _result: LogoutResult,
  environment: ReleaseMetadata['environment'] = 'production',
  returnTo?: string,
): string {
  if (environment !== 'preview') return '/login';
  const safeReturnTo = sanitizeReturnTo(returnTo);
  return safeReturnTo ? `/login?returnTo=${encodeURIComponent(safeReturnTo)}` : '/login';
}

/** 登出成功后整页离开受保护应用，清掉当前前端内存中的身份与业务缓存。 */
export function completeLogout(
  result: LogoutResult,
  navigate: (url: string) => void = (url) => window.location.assign(url),
  environment: ReleaseMetadata['environment'] = 'production',
  returnTo?: string,
): void {
  navigate(logoutDestination(result, environment, returnTo));
}
