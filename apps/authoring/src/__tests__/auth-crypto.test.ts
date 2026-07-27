import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  advisoryLockKey,
  codeDigestMatches,
  digestClientAddress,
  digestEmailCode,
  digestEmailTarget,
  digestSessionCookieValue,
  generateCreatorAccount,
  generateEmailOtp,
  generateSessionCookieValue,
  normalizeEmailAddress,
} from '../modules/account/auth-crypto.js';

const SECRET = 'test-hmac-secret-with-at-least-32-characters';

describe('email authentication crypto', () => {
  it.each([
    ['Alice@Example.COM', 'Alice@example.com'],
    ['User@例子.测试', 'User@xn--fsqu00a.xn--0zwm56d'],
    ['Mixed+tag@Sub.Example.com', 'Mixed+tag@sub.example.com'],
  ])('normalizes only the IDNA domain: %s', (input, expected) => {
    expect(normalizeEmailAddress(input)).toBe(expected);
  });

  it.each([
    ' Alice@example.com',
    'Alice@example.com ',
    'Alice @example.com',
    'Alice@@example.com',
    '@example.com',
    'Alice@example..com',
    'Alice@-example.com',
    'Alice@example.com.',
    `a@${'x'.repeat(64)}.com`,
    `a@${'x'.repeat(252)}.com`,
  ])('rejects unsafe or non-canonical email input: %s', (input) => {
    expect(normalizeEmailAddress(input)).toBeNull();
  });

  it('uses distinct HMAC domains and binds the code to its target', () => {
    const email = normalizeEmailAddress('Alice@example.com')!;
    const otherEmail = normalizeEmailAddress('Bob@example.com')!;
    const target = digestEmailTarget(SECRET, email);
    const otherTarget = digestEmailTarget(SECRET, otherEmail);
    const code = digestEmailCode(SECRET, target, '042731');

    const expectedCode = createHmac('sha256', SECRET)
      .update('auth-email-code:v1')
      .update('\0')
      .update(target)
      .update('\0')
      .update('042731')
      .digest();

    expect(target).toHaveLength(32);
    expect(code.equals(expectedCode)).toBe(true);
    expect(code).toHaveLength(32);
    expect(digestClientAddress(SECRET, '192.0.2.4')).toHaveLength(32);
    expect(code.equals(target)).toBe(false);
    expect(codeDigestMatches(code, digestEmailCode(SECRET, target, '042731'))).toBe(true);
    expect(codeDigestMatches(code, digestEmailCode(SECRET, target, '142731'))).toBe(false);
    expect(codeDigestMatches(code, digestEmailCode(SECRET, otherTarget, '042731'))).toBe(false);
    expect(advisoryLockKey(target)).not.toBe(advisoryLockKey(otherTarget));
  });

  it('keeps leading zeroes in deterministic six-digit OTP generation', () => {
    expect(generateEmailOtp(() => 0)).toBe('000000');
    expect(generateEmailOtp(() => 42)).toBe('000042');
    expect(generateEmailOtp(() => 999_999)).toBe('999999');
  });

  it('generates a fixed opaque session format and only digests valid values', () => {
    const session = generateSessionCookieValue(() => Buffer.alloc(32, 0xab));
    expect(session).toMatch(/^s1\.[A-Za-z0-9_-]{43}$/);
    expect(digestSessionCookieValue(session)).toHaveLength(32);
    expect(digestSessionCookieValue('s1.short')).toBeNull();
    expect(digestSessionCookieValue(undefined)).toBeNull();
  });

  it('generates an email-independent creator account in lowercase Base32', () => {
    expect(generateCreatorAccount(() => Buffer.from([0, 1, 2, 3, 4]))).toMatch(
      /^creator-[a-z2-7]{8}$/,
    );
  });
});
