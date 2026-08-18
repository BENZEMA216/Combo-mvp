// 认证原语：手机号规范化、域分离摘要、不透明会话 Cookie。与 V1 相同的纪律：
// 数据库、Redis key 与日志只接触摘要，验证码与 Cookie 原文不出内存。
import { createHash, createHmac, randomBytes, timingSafeEqual, type BinaryLike } from 'node:crypto';

const PHONE_TARGET_DOMAIN = 'authz-phone-target:v1';
const PHONE_CODE_DOMAIN = 'authz-phone-code:v1';

export const V2_SESSION_COOKIE_NAME = 'cb_v2_session';
export const V2_SESSION_COOKIE_PREFIX = 'v2s1.';
export const V2_SESSION_TOKEN_BYTES = 32;
export const V2_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const V2_SESSION_COOKIE_VALUE_PATTERN = /^v2s1\.[A-Za-z0-9_-]{43}$/;

export const OTP_CODE_LENGTH = 6;
export const OTP_CODE_PATTERN = /^[0-9]{6}$/;
export const OTP_CHALLENGE_TTL_SECONDS = 5 * 60;
export const OTP_MAX_ATTEMPTS = 5;

export type RandomBytes = (size: number) => Buffer;

function hmacWithDomain(secret: BinaryLike, domain: string, chunks: readonly BinaryLike[]): Buffer {
  const hmac = createHmac('sha256', secret).update(domain, 'utf8');
  for (const chunk of chunks) hmac.update('\0', 'utf8').update(chunk);
  return hmac.digest();
}

/**
 * 手机号规范形：允许一个前导加号，入库前去掉，只保留 5 到 15 位、首位非零的数字。
 * 不做国家码推断；同一号码的带加号与不带加号写法收敛到同一标识。
 */
export function normalizePhone(input: string): string | null {
  if (typeof input !== 'string') return null;
  const digits = input.startsWith('+') ? input.slice(1) : input;
  if (!/^[1-9][0-9]{4,14}$/.test(digits)) return null;
  return digits;
}

/** 登录目标摘要。数据库与 Redis key 只使用该摘要。 */
export function digestPhoneTarget(secret: BinaryLike, phone: string): Buffer {
  return hmacWithDomain(secret, PHONE_TARGET_DOMAIN, [phone]);
}

/** 验证码摘要按域、32 字节目标摘要与六位码依次用 NUL 分隔，防止跨目标复用。 */
export function digestPhoneCode(
  secret: BinaryLike,
  targetDigest: Uint8Array,
  code: string,
): Buffer {
  if (targetDigest.byteLength !== 32 || !OTP_CODE_PATTERN.test(code)) {
    throw new TypeError('invalid OTP digest input');
  }
  return hmacWithDomain(secret, PHONE_CODE_DOMAIN, [targetDigest, code]);
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
