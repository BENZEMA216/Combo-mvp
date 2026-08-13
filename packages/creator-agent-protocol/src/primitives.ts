import { z } from 'zod';

export const MAX_UINT63 = 9_223_372_036_854_775_807n;

export const UuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
export type Uuid = z.infer<typeof UuidSchema>;

export const IsoDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => !Number.isNaN(Date.parse(value)), '必须是可解析的 RFC 3339 时间');

export const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const HmacSha256DigestSchema = z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/);

export const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);

export const Uint63StringSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .refine(
    (value) => !/^(0|[1-9]\d*)$/u.test(value) || BigInt(value) <= MAX_UINT63,
    '必须在 uint63 范围内',
  );
export type Uint63String = z.infer<typeof Uint63StringSchema>;

export const Utf8TextSchema = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= maxBytes, {
      message: `UTF-8 内容不得超过 ${maxBytes} bytes`,
    })
    .refine((value) => !containsLoneSurrogate(value), '不接受未配对的 Unicode surrogate')
    .refine((value) => !/[\u0000]/u.test(value), '不接受 NUL');

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
