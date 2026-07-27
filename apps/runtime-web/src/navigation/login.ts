/** 同站 React 登录页；authoring 在该页签发 authoring 与 runtime 共用的 HttpOnly Cookie。 */
export const AUTH_LOGIN_PATH = '/login';
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

/** 未登录时整页进入自定义登录页，并只携带经过递归审计的 runtime 深链。 */
export function loginUrl(returnTo?: string): string {
  const target = safeRuntimeAuthReturnTo(returnTo ?? currentRuntimeLocation());
  return `${AUTH_LOGIN_PATH}?returnTo=${encodeURIComponent(target)}`;
}

/** 单次请求收到 401 时整页进入自定义登录页，不重放原请求。 */
export function goToLogin(
  returnTo?: string,
  navigate: (url: string) => void = (url) => window.location.assign(url),
): void {
  navigate(loginUrl(returnTo));
}
