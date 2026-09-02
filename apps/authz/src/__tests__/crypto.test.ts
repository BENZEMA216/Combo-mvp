import { describe, expect, it } from 'vitest';
import {
  V2_SESSION_COOKIE_VALUE_PATTERN,
  codeDigestMatches,
  digestEmailCode,
  digestEmailTarget,
  digestSessionCookieValue,
  generateOtpCode,
  generateSessionCookieValue,
  normalizeEmail,
} from '../crypto.js';

const SECRET = 'x'.repeat(32);

describe('normalizeEmail', () => {
  it('trims, lowercases, and keeps a single-@ mailbox with an ASCII domain', () => {
    expect(normalizeEmail('user@example.com')).toBe('user@example.com');
    expect(normalizeEmail('  User@Example.COM ')).toBe('user@example.com');
    expect(normalizeEmail('first.last+tag@sub.example.co')).toBe('first.last+tag@sub.example.co');
  });

  it('rejects malformed input without guessing', () => {
    for (const input of [
      '',
      'a@',
      '@b.co',
      'a b@example.com',
      'user@@example.com',
      'user@example..com',
      'user@-example.com',
      'user@example-.com',
      'user@exa mple.com',
      'user.example.com',
      'user@' + 'a'.repeat(250) + '.com',
      '用户@example.com',
      'user\x01@example.com',
      'ab',
    ]) {
      expect(normalizeEmail(input), input).toBeNull();
    }
  });
});

describe('digests', () => {
  it('target digest is deterministic and secret-dependent', () => {
    const a = digestEmailTarget(SECRET, 'user@example.com');
    expect(a).toHaveLength(32);
    expect(a.equals(digestEmailTarget(SECRET, 'user@example.com'))).toBe(true);
    expect(a.equals(digestEmailTarget(SECRET, 'other@example.com'))).toBe(false);
    expect(a.equals(digestEmailTarget('y'.repeat(32), 'user@example.com'))).toBe(false);
  });

  it('code digest is domain-separated from the target and bound to it', () => {
    const target = digestEmailTarget(SECRET, 'user@example.com');
    const code = digestEmailCode(SECRET, target, '123456');
    expect(code).toHaveLength(32);
    expect(code.equals(target)).toBe(false);
    const otherTarget = digestEmailTarget(SECRET, 'other@example.com');
    expect(code.equals(digestEmailCode(SECRET, otherTarget, '123456'))).toBe(false);
  });

  it('codeDigestMatches compares in constant time semantics and rejects bad lengths', () => {
    const digest = digestEmailTarget(SECRET, 'user@example.com');
    expect(codeDigestMatches(digest, Buffer.from(digest))).toBe(true);
    expect(codeDigestMatches(digest, digestEmailTarget(SECRET, 'other@example.com'))).toBe(false);
    expect(codeDigestMatches(digest, Buffer.alloc(31))).toBe(false);
  });
});

describe('generateOtpCode', () => {
  it('always produces a six-digit code, left-padded with zeros', () => {
    for (const value of [0, 7, 999_999]) {
      const code = generateOtpCode(() => value);
      expect(code).toMatch(/^[0-9]{6}$/);
      expect(Number(code)).toBe(value);
    }
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
