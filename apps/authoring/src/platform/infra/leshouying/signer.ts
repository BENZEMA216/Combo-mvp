import { createHash, timingSafeEqual } from 'node:crypto';

export type SigningValue = string | number | boolean | null;
export type SigningParameters = Readonly<Record<string, SigningValue>>;

function assertSigningKey(key: string): void {
  if (key.length === 0 || !/^[\x21-\x7e]+$/u.test(key) || key.includes('&') || key.includes('=')) {
    throw new Error('invalid payment signing parameter name');
  }
}

/**
 * 乐收赢通用签名串：排除 sign 与 null，保留空字符串，ASCII 键升序，值不编码也不 trim。
 * 当前接入不允许数组或对象进入签名面。
 */
export function canonicalizePaymentParameters(parameters: SigningParameters): string {
  const pairs: string[] = [];
  for (const key of Object.keys(parameters).sort()) {
    assertSigningKey(key);
    if (key === 'sign') continue;
    const value = parameters[key];
    if (value === null) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new Error('invalid payment signing parameter value');
    }
    pairs.push(`${key}=${String(value)}`);
  }
  return pairs.join('&');
}

export function signPaymentParameters(
  parameters: SigningParameters,
  institutionKey: string,
): string {
  if (institutionKey.length === 0) throw new Error('payment signing key is unavailable');
  const canonical = canonicalizePaymentParameters(parameters);
  const payload = `${canonical.length > 0 ? `${canonical}&` : ''}key=${institutionKey}`;
  return createHash('md5').update(payload, 'utf8').digest('hex');
}

export function verifyPaymentSignature(
  parameters: SigningParameters,
  institutionKey: string,
): boolean {
  const provided = parameters.sign;
  if (typeof provided !== 'string' || !/^[0-9a-f]{32}$/u.test(provided)) return false;
  const expected = signPaymentParameters(parameters, institutionKey);
  return timingSafeEqual(Buffer.from(provided, 'ascii'), Buffer.from(expected, 'ascii'));
}

/** 只用于回调去重和审计关联；不包含机构密钥。 */
export function fingerprintPaymentParameters(parameters: SigningParameters): string {
  const canonical = canonicalizePaymentParameters(parameters);
  const sign = typeof parameters.sign === 'string' ? parameters.sign : '';
  return createHash('sha256').update(`${canonical}&sign=${sign}`, 'utf8').digest('hex');
}

/** 把未知 JSON 对象收窄到签名器接受的标量对象；非法形状直接拒绝。 */
export function asSigningParameters(input: unknown): SigningParameters {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid payment parameter object');
  }
  const result: Record<string, SigningValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      throw new Error('invalid payment parameter value');
    }
    result[key] = value;
  }
  return result;
}
