import { describe, expect, it } from 'vitest';
import {
  V2_SESSION_COOKIE_VALUE_PATTERN,
  codeDigestMatches,
  digestPhoneCode,
  digestPhoneTarget,
  digestSessionCookieValue,
  generateSessionCookieValue,
  normalizePhone,
} from '../crypto.js';

const SECRET = 'x'.repeat(32);

describe('normalizePhone', () => {
  it('accepts digits with an optional leading plus and strips the plus', () => {
    expect(normalizePhone('13800138000')).toBe('13800138000');
    expect(normalizePhone('+8613800138000')).toBe('8613800138000');
    expect(normalizePhone('12345')).toBe('12345');
  });

  it('rejects malformed input without guessing', () => {
    for (const input of [
      '',
      '0123',
      '1234',
      '1234567890123456',
      '138 0013 8000',
      '138-0013-8000',
      '+',
      '++8613800138000',
      '1380013800a',
      ' 13800138000',
    ]) {
      expect(normalizePhone(input), input).toBeNull();
    }
  });
});

describe('digests', () => {
  it('target digest is deterministic and secret-dependent', () => {
    const a = digestPhoneTarget(SECRET, '13800138000');
    expect(a).toHaveLength(32);
    expect(a.equals(digestPhoneTarget(SECRET, '13800138000'))).toBe(true);
    expect(a.equals(digestPhoneTarget(SECRET, '13800138001'))).toBe(false);
    expect(a.equals(digestPhoneTarget('y'.repeat(32), '13800138000'))).toBe(false);
  });

  it('code digest is domain-separated from the target and bound to it', () => {
    const target = digestPhoneTarget(SECRET, '13800138000');
    const code = digestPhoneCode(SECRET, target, '123456');
    expect(code).toHaveLength(32);
    expect(code.equals(target)).toBe(false);
    const otherTarget = digestPhoneTarget(SECRET, '13800138001');
    expect(code.equals(digestPhoneCode(SECRET, otherTarget, '123456'))).toBe(false);
  });

  it('codeDigestMatches compares in constant time semantics and rejects bad lengths', () => {
    const digest = digestPhoneTarget(SECRET, '13800138000');
    expect(codeDigestMatches(digest, Buffer.from(digest))).toBe(true);
    expect(codeDigestMatches(digest, digestPhoneTarget(SECRET, '13800138001'))).toBe(false);
    expect(codeDigestMatches(digest, Buffer.alloc(31))).toBe(false);
  });
});

describe('session cookie value', () => {
  it('generates prefixed base64url tokens accepted by the digest pattern', () => {
    const value = generateSessionCookieValue();
    expect(V2_SESSION_COOKIE_VALUE_PATTERN.test(value)).toBe(true);
    const digest = digestSessionCookieValue(value);
    expect(digest).toHaveLength(32);
    expect(digest!.equals(digestSessionCookieValue(value)!)).toBe(true);
  });

  it('rejects malformed or V1 cookie values before any lookup', () => {
    expect(digestSessionCookieValue(undefined)).toBeNull();
    expect(digestSessionCookieValue('')).toBeNull();
    expect(digestSessionCookieValue(`s1.${Buffer.alloc(32).toString('base64url')}`)).toBeNull();
    expect(digestSessionCookieValue('v2s1.short')).toBeNull();
  });

  it('honours the injected random source length contract', () => {
    expect(() => generateSessionCookieValue(() => Buffer.alloc(16))).toThrow(TypeError);
    const fixed = generateSessionCookieValue(() => Buffer.alloc(32, 7));
    expect(fixed).toBe(`v2s1.${Buffer.alloc(32, 7).toString('base64url')}`);
  });
});
