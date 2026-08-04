export const CREATOR_CAPABILITIES_PATH = '/capabilities';

const RETURN_TO_STORAGE_PREFIX = 'combo.runtime.returnTo:';
const RETURN_TO_ORIGIN = 'https://combo.invalid';
const MAX_DECODE_PASSES = 5;
const UUID_PATH_SEGMENT = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const TASK_DETAIL_RETURN_PATH = new RegExp(`^/tasks/${UUID_PATH_SEGMENT}(?:[?#].*)?$`, 'i');
const CAPABILITY_RELEASE_RETURN_PATH = new RegExp(
  `^/capabilities/${UUID_PATH_SEGMENT}/release(?:/(?:pricing|identity|review|success))?(?:[?#].*)?$`,
  'i',
);
const STUDIO_SESSION_RETURN_PATH = new RegExp(
  `^/try/session/${UUID_PATH_SEGMENT}(?:[?#].*)?$`,
  'i',
);

export interface RuntimeReturnStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function sessionStorageSafe(): RuntimeReturnStorage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function storageKey(sessionId: string): string {
  return `${RETURN_TO_STORAGE_PREFIX}${sessionId}`;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isUnsafeReturnCandidate(value: string): boolean {
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /^\/[a-z][a-z0-9+.-]*:/i.test(value) ||
    containsControlCharacter(value)
  ) {
    return true;
  }
  try {
    const target = new URL(value, RETURN_TO_ORIGIN);
    return target.origin !== RETURN_TO_ORIGIN || target.pathname.startsWith('//');
  } catch {
    return true;
  }
}

export function safeRuntimeReturnTo(value: string | null | undefined): string | null {
  if (!value || isUnsafeReturnCandidate(value)) return null;

  let decoded = value;
  let stabilized = false;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    if (isUnsafeReturnCandidate(decoded)) return null;
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (next === decoded) {
      stabilized = true;
      break;
    }
    decoded = next;
  }
  if (!stabilized || isUnsafeReturnCandidate(decoded)) return null;

  try {
    const target = new URL(value, RETURN_TO_ORIGIN);
    const normalized = `${target.pathname}${target.search}${target.hash}`;
    return isUnsafeReturnCandidate(normalized) ? null : normalized;
  } catch {
    return null;
  }
}

export function safeTaskRuntimeReturnTo(value: string | null | undefined): string | null {
  const safe = safeRuntimeReturnTo(value);
  // Task ids are canonical UUIDs. Keeping the path segment strict also rejects dot-segment
  // normalization and encoded delimiter/control-character tricks before location.assign().
  return safe && TASK_DETAIL_RETURN_PATH.test(safe) ? safe : null;
}

export function safeCapabilityReleaseRuntimeReturnTo(
  value: string | null | undefined,
): string | null {
  const safe = safeRuntimeReturnTo(value);
  return safe && CAPABILITY_RELEASE_RETURN_PATH.test(safe) ? safe : null;
}

/** Creator-side return targets accepted when a trial deep link creates a Runtime session. */
export function safeCreatorRuntimeReturnTo(value: string | null | undefined): string | null {
  return safeTaskRuntimeReturnTo(value) ?? safeCapabilityReleaseRuntimeReturnTo(value);
}

export function rememberRuntimeReturnTo(
  sessionId: string | undefined,
  returnTo: string | null | undefined,
  storage: RuntimeReturnStorage | undefined = sessionStorageSafe(),
): void {
  const safe = safeRuntimeReturnTo(returnTo);
  if (!sessionId || !safe || !storage) return;
  try {
    storage.setItem(storageKey(sessionId), safe);
  } catch {
    // Storage may be unavailable in private browsing or blocked contexts.
  }
}

export function readRuntimeReturnTo(
  sessionId: string | undefined,
  storage: RuntimeReturnStorage | undefined = sessionStorageSafe(),
): string | null {
  if (!sessionId || !storage) return null;
  try {
    return safeRuntimeReturnTo(storage.getItem(storageKey(sessionId)));
  } catch {
    return null;
  }
}

export function appendRuntimeReturnTo(path: string, returnTo: string | null | undefined): string {
  const safe = safeRuntimeReturnTo(returnTo);
  if (!safe) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}returnTo=${encodeURIComponent(safe)}`;
}

export function runtimeBackLabel(returnTo: string | null | undefined): string {
  const safe = safeRuntimeReturnTo(returnTo);
  if (!safe) return '← 返回我的 Agent';
  if (STUDIO_SESSION_RETURN_PATH.test(safe)) return '← 返回 UI 设计';
  if (CAPABILITY_RELEASE_RETURN_PATH.test(safe)) return '← 返回定价与发布';
  if (TASK_DETAIL_RETURN_PATH.test(safe)) return '← 返回提取结果';
  if (safe === CREATOR_CAPABILITIES_PATH) return '← 返回我的 Agent';
  return '← 返回上一页';
}

export function runtimeBackTarget(returnTo: string | null | undefined): string {
  return safeRuntimeReturnTo(returnTo) ?? CREATOR_CAPABILITIES_PATH;
}
