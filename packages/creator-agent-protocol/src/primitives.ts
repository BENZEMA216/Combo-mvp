import { z } from 'zod';

export const MAX_UINT63 = 9_223_372_036_854_775_807n;

function exactUnsignedDecimalPattern(maximum: bigint): RegExp {
  const maximumDigits = maximum.toString(10);
  const alternatives = ['0'];
  if (maximumDigits.length > 1) {
    alternatives.push(`[1-9]\\d{0,${maximumDigits.length - 2}}`);
  }
  let exactPrefix = '';
  for (let index = 0; index < maximumDigits.length; index += 1) {
    const digit = Number(maximumDigits[index]);
    const minimum = index === 0 ? 1 : 0;
    if (digit > minimum) {
      const lower = digit - 1;
      const digitPattern = minimum === lower ? `${minimum}` : `[${minimum}-${lower}]`;
      const remaining = maximumDigits.length - index - 1;
      alternatives.push(
        `${exactPrefix}${digitPattern}${remaining === 0 ? '' : `\\d{${remaining}}`}`,
      );
    }
    exactPrefix += maximumDigits[index];
  }
  alternatives.push(maximumDigits);
  return new RegExp(`^(?:${alternatives.join('|')})$`, 'u');
}

/** Enforceable in both Zod and generated standard JSON Schema, not a refine-only hint. */
export const UINT63_DECIMAL_PATTERN = exactUnsignedDecimalPattern(MAX_UINT63);

export const UuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
  .uuid();
export type Uuid = z.infer<typeof UuidSchema>;

export const IsoDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .datetime({ offset: false, precision: 3 })
  .refine((value) => !Number.isNaN(Date.parse(value)), '必须是 UTC RFC 3339 毫秒时间');

export const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const HmacSha256DigestSchema = z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/);

export const CanonicalSha256Base64Schema = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/u)
  .refine((value) => {
    const bytes = Buffer.from(value, 'base64');
    return bytes.byteLength === 32 && bytes.toString('base64') === value;
  }, 'SHA-256 checksum 必须是 32 bytes canonical base64');

export const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);

export const UTF8_TEXT_SCHEMA_DESCRIPTION_PREFIX = 'combo:utf8-bytes:' as const;

export const CanonicalBase64UrlBytesSchema = (minimumBytes: number, maximumBytes: number) => {
  if (
    !Number.isSafeInteger(minimumBytes) ||
    !Number.isSafeInteger(maximumBytes) ||
    minimumBytes < 0 ||
    maximumBytes < minimumBytes
  ) {
    throw new TypeError('canonical base64url byte boundary 无效');
  }
  return Base64UrlSchema.min(Math.ceil((minimumBytes * 4) / 3))
    .max(Math.ceil((maximumBytes * 4) / 3))
    .refine((value) => {
      const bytes = Buffer.from(value, 'base64url');
      return (
        bytes.byteLength >= minimumBytes &&
        bytes.byteLength <= maximumBytes &&
        bytes.toString('base64url') === value
      );
    }, `必须是 ${minimumBytes}..${maximumBytes} bytes canonical base64url`);
};

export const P256P1363SignatureSchema = Base64UrlSchema.refine((value) => {
  const bytes = Buffer.from(value, 'base64url');
  return bytes.byteLength === 64 && bytes.toString('base64url') === value;
}, 'P-256 IEEE-P1363 signature 必须是 64 bytes');

export const Uint63StringSchema = z
  .string()
  .regex(UINT63_DECIMAL_PATTERN)
  .refine(
    (value) => !UINT63_DECIMAL_PATTERN.test(value) || BigInt(value) <= MAX_UINT63,
    '必须在 uint63 范围内',
  );
export type Uint63String = z.infer<typeof Uint63StringSchema>;

export const Utf8TextSchema = (maxBytes: number) =>
  z
    .string()
    .min(1)
    // Every Unicode scalar requires at least one UTF-8 byte, so this is a safe structural
    // upper bound for standard JSON Schema validators. The exact byte authority remains
    // the refine below and is published as x-combo-maxUtf8Bytes in checked artifacts.
    .max(maxBytes)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= maxBytes, {
      message: `UTF-8 内容不得超过 ${maxBytes} bytes`,
    })
    .refine((value) => !containsLoneSurrogate(value), '不接受未配对的 Unicode surrogate')
    .refine(
      (value) => !containsForbiddenControl(value, true),
      '除 TAB、LF、CR 外不接受 C0/C1 控制字符',
    )
    .describe(`${UTF8_TEXT_SCHEMA_DESCRIPTION_PREFIX}${maxBytes}`);

/**
 * C0/C1 都是协议文字里的非法控制字符；普通多行文字仅允许 TAB/LF/CR，
 * 路径等结构性文字一律不允许。
 */
export function containsForbiddenControl(value: string, allowTabLfCr = false): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f) {
      if (allowTabLfCr && (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d)) {
        continue;
      }
      return true;
    }
    if (codePoint >= 0x7f && codePoint <= 0x9f) return true;
  }
  return false;
}

export function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function compareUint63(left: Uint63String, right: Uint63String): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}
