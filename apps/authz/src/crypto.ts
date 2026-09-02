// 认证原语：邮箱规范化、域分离摘要、不透明会话 Cookie。与 V1 相同的纪律：
// 数据库、Redis key 与日志只接触摘要，验证码与 Cookie 原文不出内存。
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
  type BinaryLike,
} from 'node:crypto';
import { domainToASCII } from 'node:url';

const EMAIL_TARGET_DOMAIN = 'authz-email-target:v1';
const EMAIL_CODE_DOMAIN = 'authz-email-code:v1';

export const V2_SESSION_COOKIE_NAME = 'cb_v2_session';
export const V2_SESSION_COOKIE_PREFIX = 'v2s1.';
export const V2_SESSION_TOKEN_BYTES = 32;
export const V2_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const V2_SESSION_COOKIE_VALUE_PATTERN = /^v2s1\.[A-Za-z0-9_-]{43}$/;

export const OTP_CODE_PATTERN = /^[0-9]{6}$/;
export const OTP_CHALLENGE_TTL_SECONDS = 5 * 60;
export const OTP_MAX_ATTEMPTS = 5;

export type RandomBytes = (size: number) => Buffer;
export type RandomInteger = (min: number, max: number) => number;

const EMAIL_LOCAL_PART_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const ASCII_DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function containsAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function hmacWithDomain(secret: BinaryLike, domain: string, chunks: readonly BinaryLike[]): Buffer {
  const hmac = createHmac('sha256', secret).update(domain, 'utf8');
  for (const chunk of chunks) hmac.update('\0', 'utf8').update(chunk);
  return hmac.digest();
}

/**
 * 邮箱规范形：去掉首尾空白并整体小写，单个 @ 分隔非空 local-part 与 IDNA ASCII
 * 域名。返回 null 时调用方只能按普通字段校验失败处理，不能尝试投递。
 */
export function normalizeEmail(input: string): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim().toLowerCase();
  if (value.length < 3 || value.length > 254) return null;
  if (/\s/.test(value) || containsAsciiControlCharacter(value)) return null;

  const separator = value.indexOf('@');
  if (separator <= 0 || separator !== value.lastIndexOf('@') || separator === value.length - 1) {
    return null;
  }

  const localPart = value.slice(0, separator);
  if (!EMAIL_LOCAL_PART_PATTERN.test(localPart)) return null;

  let asciiDomain: string;
  try {
    asciiDomain = domainToASCII(value.slice(separator + 1));
  } catch {
    return null;
  }
  if (!asciiDomain || asciiDomain.length > 253) return null;
  if (!asciiDomain.split('.').every((label) => ASCII_DOMAIN_LABEL_PATTERN.test(label))) return null;

  const normalized = `${localPart}@${asciiDomain}`;
  return normalized.length <= 254 ? normalized : null;
}

/** 登录目标摘要。数据库与 Redis key 只使用该摘要。 */
export function digestEmailTarget(secret: BinaryLike, email: string): Buffer {
  return hmacWithDomain(secret, EMAIL_TARGET_DOMAIN, [email]);
}

/** 验证码摘要按域、32 字节目标摘要与六位码依次用 NUL 分隔，防止跨目标复用。 */
export function digestEmailCode(
  secret: BinaryLike,
  targetDigest: Uint8Array,
  code: string,
): Buffer {
  if (targetDigest.byteLength !== 32 || !OTP_CODE_PATTERN.test(code)) {
    throw new TypeError('invalid OTP digest input');
  }
  return hmacWithDomain(secret, EMAIL_CODE_DOMAIN, [targetDigest, code]);
}

/** 真实发信路径的六位验证码，不足位左侧补零。 */
export function generateOtpCode(nextInteger: RandomInteger = randomInt): string {
  return String(nextInteger(0, 1_000_000)).padStart(6, '0');
}

export function generateSessionCookieValue(nextBytes: RandomBytes = randomBytes): string {
  const token = nextBytes(V2_SESSION_TOKEN_BYTES);
  if (token.byteLength !== V2_SESSION_TOKEN_BYTES) {
    throw new TypeError('session random source returned an invalid length');
  }
  return `${V2_SESSION_COOKIE_PREFIX}${token.toString('base64url')}`;
}

/** 数据库与 Redis 只保存完整 Cookie 值的 SHA-256；格式不合法时不做查询。 */
export function digestSessionCookieValue(value: string | undefined): Buffer | null {
  if (!value || !V2_SESSION_COOKIE_VALUE_PATTERN.test(value)) return null;
  return createHash('sha256').update(value, 'ascii').digest();
}

export function codeDigestMatches(expected: Uint8Array, candidate: Uint8Array): boolean {
  if (expected.byteLength !== 32 || candidate.byteLength !== 32) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(candidate));
}
