import type { ReleaseMetadata } from '@cb/shared';

export const AUTH_LOGIN_PATH = '/api/v1/auth/login';
export const PREVIEW_BOOTSTRAP_PATH = '/__review/bootstrap';
export const RUNTIME_AUTH_FALLBACK = '/try/';

const RETURN_TO_ORIGIN = 'https://combo.invalid';
const MAX_DECODE_PASSES = 5;

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isRuntimePath(pathname: string): boolean {
  return pathname === '/try' || pathname.startsWith('/try/');
}

function isUnsafeCandidate(value: string): boolean {
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    containsControlCharacter(value)
  ) {
    return true;
  }
  try {
    const target = new URL(value, RETURN_TO_ORIGIN);
    return (
      target.origin !== RETURN_TO_ORIGIN ||
      target.pathname.startsWith('//') ||
      !isRuntimePath(target.pathname)
    );
  } catch {
    return true;
  }
}

/** 认证回跳只允许规范化后的当前 /try 路径，且递归审计编码副本。 */
export function safeRuntimeAuthReturnTo(value: string | null | undefined): string {
  if (!value || isUnsafeCandidate(value)) return RUNTIME_AUTH_FALLBACK;

  let decoded = value;
  let stabilized = false;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    if (isUnsafeCandidate(decoded)) return RUNTIME_AUTH_FALLBACK;
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return RUNTIME_AUTH_FALLBACK;
    }
    if (next === decoded) {
      stabilized = true;
      break;
    }
    decoded = next;
  }
  if (!stabilized || isUnsafeCandidate(decoded)) return RUNTIME_AUTH_FALLBACK;

  try {
    const target = new URL(value, RETURN_TO_ORIGIN);
    const normalized = `${target.pathname}${target.search}`;
    return isUnsafeCandidate(normalized) ? RUNTIME_AUTH_FALLBACK : normalized;
  } catch {
    return RUNTIME_AUTH_FALLBACK;
  }
}

function currentRuntimeLocation(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/** 非 Preview 保持现有 OIDC 登录入口。 */
export function loginUrl(returnTo?: string): string {
  const target = safeRuntimeAuthReturnTo(returnTo ?? currentRuntimeLocation());
  return `${AUTH_LOGIN_PATH}?returnTo=${encodeURIComponent(target)}`;
}

/** Preview 使用受访问闸保护的种子会话恢复页，不进入正式 OIDC。 */
export function previewBootstrapUrl(returnTo?: string): string {
  const target = safeRuntimeAuthReturnTo(returnTo ?? currentRuntimeLocation());
  return `${PREVIEW_BOOTSTRAP_PATH}?returnTo=${encodeURIComponent(target)}`;
}

export function authenticationUrl(
  environment: ReleaseMetadata['environment'],
  returnTo?: string,
): string {
  return environment === 'preview' ? previewBootstrapUrl(returnTo) : loginUrl(returnTo);
}
