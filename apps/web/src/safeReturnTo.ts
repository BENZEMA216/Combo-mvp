const RETURN_TO_ORIGIN = 'https://combo.invalid';
const MAX_DECODE_PASSES = 5;
const UUID_PATH_SEGMENT = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const TASK_DETAIL_RETURN_PATH = new RegExp(`^/tasks/${UUID_PATH_SEGMENT}(?:\\?.*)?$`, 'i');

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function isUnsafeCandidate(value: string): boolean {
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    hasControlCharacter(value)
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

/**
 * 把外部输入收敛为同源 path + query。
 *
 * 校验会递归解码副本，避免 `%252F%252Fevil.example` 之类多重编码在下游再次解码后
 * 变成协议相对地址；返回值仍由 URL 规范化原始输入，避免改写合法 query 的值。
 */
export function sanitizeReturnTo(value: string | null | undefined): string | null {
  if (!value || isUnsafeCandidate(value)) return null;

  let decoded = value;
  let stabilized = false;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    if (isUnsafeCandidate(decoded)) return null;

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

  if (!stabilized || isUnsafeCandidate(decoded)) return null;

  try {
    const target = new URL(value, RETURN_TO_ORIGIN);
    const normalized = `${target.pathname}${target.search}`;
    return isUnsafeCandidate(normalized) ? null : normalized;
  } catch {
    return null;
  }
}

/** Creation 的试用边界只携带规范 Task 详情地址，不接受其他同源页面。 */
export function sanitizeTaskReturnTo(value: string | null | undefined): string | null {
  const safe = sanitizeReturnTo(value);
  return safe && TASK_DETAIL_RETURN_PATH.test(safe) ? safe : null;
}
