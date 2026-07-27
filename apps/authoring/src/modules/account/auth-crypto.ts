import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
  type BinaryLike,
} from 'node:crypto';
import { domainToASCII } from 'node:url';
import {
  AUTH_SESSION_COOKIE_PREFIX,
  AUTH_SESSION_COOKIE_VALUE_PATTERN,
  AUTH_SESSION_TOKEN_BYTES,
  EMAIL_OTP_CODE_LENGTH,
  type NormalizedEmailAddress,
} from '@cb/shared';

const EMAIL_TARGET_DOMAIN = 'auth-email-target:v1';
const EMAIL_CODE_DOMAIN = 'auth-email-code:v1';
const CLIENT_ADDRESS_DOMAIN = 'auth-client-ip:v1';
const ASCII_DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const OTP_PATTERN = new RegExp(`^[0-9]{${EMAIL_OTP_CODE_LENGTH}}$`);
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export type RandomBytes = (size: number) => Buffer;
export type RandomInteger = (min: number, max: number) => number;

function hmacWithDomain(secret: BinaryLike, domain: string, chunks: readonly BinaryLike[]): Buffer {
  const hmac = createHmac('sha256', secret).update(domain, 'utf8');
  for (const chunk of chunks) hmac.update('\0', 'utf8').update(chunk);
  return hmac.digest();
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * 保守规范化邮箱：不裁剪输入、不折叠 local-part，只把合法 IDNA 域名转成小写 ASCII。
 * 返回 null 时，调用方只能按普通字段校验失败处理，不能尝试投递。
 */
export function normalizeEmailAddress(input: string): NormalizedEmailAddress | null {
  if (
    input.length < 3 ||
    input.length > 254 ||
    input.trim() !== input ||
    /\s/u.test(input) ||
    containsControlCharacter(input)
  ) {
    return null;
  }

  const separator = input.indexOf('@');
  if (separator <= 0 || separator !== input.lastIndexOf('@') || separator === input.length - 1) {
    return null;
  }

  const localPart = input.slice(0, separator);
  const rawDomain = input.slice(separator + 1);
  let asciiDomain: string;
  try {
    asciiDomain = domainToASCII(rawDomain);
  } catch {
    return null;
  }
  if (!asciiDomain || asciiDomain.length > 253) return null;

  const domain = asciiDomain.toLowerCase();
  if (!domain.split('.').every((label) => ASCII_DOMAIN_LABEL.test(label))) return null;

  const normalized = `${localPart}@${domain}`;
  if (normalized.length > 254) return null;
  return normalized as NormalizedEmailAddress;
}

/** 未验证目标摘要。数据库、Redis key 和审计都只使用该摘要。 */
export function digestEmailTarget(secret: BinaryLike, email: NormalizedEmailAddress): Buffer {
  return hmacWithDomain(secret, EMAIL_TARGET_DOMAIN, [email]);
}

/** 验证码摘要按域、32 字节目标摘要与六位码依次用 NUL 分隔，防止跨目标复用。 */
export function digestEmailCode(
  secret: BinaryLike,
  targetDigest: Uint8Array,
  code: string,
): Buffer {
  if (targetDigest.byteLength !== 32 || !OTP_PATTERN.test(code)) {
    throw new TypeError('invalid OTP digest input');
  }
  return hmacWithDomain(secret, EMAIL_CODE_DOMAIN, [targetDigest, code]);
}

/** 客户端地址只在内存中参与域分离 HMAC，原文不进入 key、指标或审计。 */
export function digestClientAddress(secret: BinaryLike, address: string): Buffer {
  if (!address) throw new TypeError('client address is required');
  return hmacWithDomain(secret, CLIENT_ADDRESS_DOMAIN, [address]);
}

export function generateEmailOtp(nextInteger: RandomInteger = randomInt): string {
  return String(nextInteger(0, 1_000_000)).padStart(EMAIL_OTP_CODE_LENGTH, '0');
}

export function generateSessionCookieValue(nextBytes: RandomBytes = randomBytes): string {
  const token = nextBytes(AUTH_SESSION_TOKEN_BYTES);
  if (token.byteLength !== AUTH_SESSION_TOKEN_BYTES) {
    throw new TypeError('session random source returned an invalid length');
  }
  return `${AUTH_SESSION_COOKIE_PREFIX}${token.toString('base64url')}`;
}

/** 数据库只保存完整 Cookie 值的 SHA-256；格式不合法时不做数据库查询。 */
export function digestSessionCookieValue(value: string | undefined): Buffer | null {
  if (!value || !AUTH_SESSION_COOKIE_VALUE_PATTERN.test(value)) return null;
  return createHash('sha256').update(value, 'ascii').digest();
}

/** 随机 account 不含邮箱信息。五个随机字节编码成固定八位小写 Base32。 */
export function generateCreatorAccount(nextBytes: RandomBytes = randomBytes): string {
  const bytes = nextBytes(5);
  if (bytes.byteLength !== 5)
    throw new TypeError('account random source returned an invalid length');

  let accumulator = 0;
  let bits = 0;
  let suffix = '';
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      suffix += BASE32_ALPHABET[(accumulator >>> bits) & 31];
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits > 0) suffix += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31];
  return `creator-${suffix}`;
}

export function codeDigestMatches(expected: Uint8Array, candidate: Uint8Array): boolean {
  if (expected.byteLength !== 32 || candidate.byteLength !== 32) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(candidate));
}

/** PostgreSQL advisory lock 使用目标摘要前八字节的有符号 bigint。 */
export function advisoryLockKey(targetDigest: Uint8Array): string {
  if (targetDigest.byteLength !== 32) throw new TypeError('target digest must be 32 bytes');
  return Buffer.from(targetDigest).readBigInt64BE(0).toString();
}
