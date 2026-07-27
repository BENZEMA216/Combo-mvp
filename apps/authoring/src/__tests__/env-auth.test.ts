import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRODUCTION_RESEND_FROM_EMAIL } from '../platform/config/env.js';

const COMMON = {
  DATABASE_URL: 'postgres://test.invalid/test',
  REDIS_QUEUE_URL: 'redis://test.invalid/0',
  REDIS_HOT_URL: 'redis://test.invalid/0',
  S3_ENDPOINT: 'https://objects.example.test',
  S3_ACCESS_KEY: 'test-access-value',
  S3_SECRET_KEY: 'test-secret-value',
  COMBO_ENVIRONMENT: 'test',
  COMBO_SOURCE_SHA: 'a'.repeat(40),
  COMBO_RELEASE_ID: `release-${'a'.repeat(40)}`,
  COMBO_BUILT_AT: '2026-07-28T00:00:00.000Z',
  COMBO_RELEASE_MANIFEST_DIGEST: `sha256:${'b'.repeat(64)}`,
  COMBO_WEB_ASSET_MANIFEST: `sha256:${'c'.repeat(64)}`,
};

async function freshLoadEnv() {
  vi.resetModules();
  return (await import('../platform/config/env.js')).loadEnv;
}

function stub(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('authoring authentication environment boundary', () => {
  it('fails production API startup on missing auth keys without printing values', async () => {
    stub({
      ...COMMON,
      NODE_ENV: 'production',
      PROCESS: 'api',
      PUBLIC_APP_ORIGINS: 'https://combo.example',
      SESSION_COOKIE_SECURE: 'true',
      RESEND_API_KEY: '',
      RESEND_FROM_EMAIL: '',
      OTP_HMAC_SECRET: '',
    });
    const loadEnv = await freshLoadEnv();

    expect(loadEnv).toThrowError(/RESEND_API_KEY/);
    try {
      loadEnv();
    } catch (error) {
      expect(String(error)).not.toContain('test-secret-value');
      expect(String(error)).not.toContain('postgres://test.invalid/test');
    }
  });

  it('pins production to the official Resend HTTPS base and a secure public origin', async () => {
    stub({
      ...COMMON,
      NODE_ENV: 'production',
      PROCESS: 'api',
      PUBLIC_APP_ORIGINS: 'https://combo.example',
      SESSION_COOKIE_SECURE: 'true',
      RESEND_API_KEY: 'test-resend-key-value',
      RESEND_FROM_EMAIL: PRODUCTION_RESEND_FROM_EMAIL,
      OTP_HMAC_SECRET: 'h'.repeat(32),
      RESEND_API_BASE_URL: 'http://127.0.0.1:45678',
    });
    const loadEnv = await freshLoadEnv();

    expect(loadEnv).toThrowError(/RESEND_API_BASE_URL/);
    try {
      loadEnv();
    } catch (error) {
      expect(String(error)).not.toContain('test-resend-key-value');
      expect(String(error)).not.toContain('127.0.0.1');
    }
  });

  it('rejects a malformed production sender at startup without printing the address', async () => {
    const invalidSender = 'not-a-resend-sender';
    stub({
      ...COMMON,
      NODE_ENV: 'production',
      PROCESS: 'api',
      PUBLIC_APP_ORIGINS: 'https://combo.example',
      SESSION_COOKIE_SECURE: 'true',
      RESEND_API_KEY: 'test-resend-key-value',
      RESEND_FROM_EMAIL: invalidSender,
      OTP_HMAC_SECRET: 'h'.repeat(32),
    });
    const loadEnv = await freshLoadEnv();

    expect(loadEnv).toThrowError(/RESEND_FROM_EMAIL/);
    try {
      loadEnv();
    } catch (error) {
      expect(String(error)).not.toContain(invalidSender);
      expect(String(error)).not.toContain('test-resend-key-value');
    }
  });

  it('rejects a syntactically valid but unofficial production sender without printing it', async () => {
    const unofficialSender = 'Combo Login <login@example.test>';
    stub({
      ...COMMON,
      NODE_ENV: 'production',
      PROCESS: 'api',
      PUBLIC_APP_ORIGINS: 'https://combo.example,https://try.combo.example',
      SESSION_COOKIE_SECURE: 'true',
      RESEND_API_KEY: 'test-resend-key-value',
      RESEND_FROM_EMAIL: unofficialSender,
      OTP_HMAC_SECRET: 'h'.repeat(32),
    });
    const loadEnv = await freshLoadEnv();

    expect(PRODUCTION_RESEND_FROM_EMAIL).toBe('Combo <auth@buildwithcombo.com>');
    expect(loadEnv).toThrowError(/RESEND_FROM_EMAIL/);
    try {
      loadEnv();
    } catch (error) {
      expect(String(error)).not.toContain(unofficialSender);
    }
  });

  it('does not require or materialize production auth secrets for the worker process', async () => {
    stub({
      ...COMMON,
      NODE_ENV: 'production',
      PROCESS: 'worker',
      RESEND_API_KEY: '',
      RESEND_FROM_EMAIL: '',
      OTP_HMAC_SECRET: '',
    });
    const loadEnv = await freshLoadEnv();

    const env = loadEnv();
    expect(env.PROCESS).toBe('worker');
    expect(env.RESEND_API_KEY).toBe('');
    expect(env.RESEND_FROM_EMAIL).toBe('');
    expect(env.OTP_HMAC_SECRET).toBe('');
  });

  it('allows a local Resend mock base only in test', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stub({
      ...COMMON,
      NODE_ENV: 'test',
      PROCESS: 'api',
      PUBLIC_APP_ORIGINS: 'http://localhost',
      SESSION_COOKIE_SECURE: 'false',
      RESEND_API_KEY: 'test-resend-key-value',
      RESEND_FROM_EMAIL: 'Combo Login <login@example.test>',
      OTP_HMAC_SECRET: 'h'.repeat(32),
      RESEND_API_BASE_URL: 'http://127.0.0.1:45678',
    });
    const loadEnv = await freshLoadEnv();

    expect(loadEnv().RESEND_API_BASE_URL).toBe('http://127.0.0.1:45678');
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('test-resend-key-value'));
  });

  it('allows a production-built Test process to use an explicit loopback HTTP cookie', async () => {
    stub({
      ...COMMON,
      NODE_ENV: 'production',
      PROCESS: 'api',
      PUBLIC_APP_ORIGINS: 'http://127.0.0.1:18080',
      SESSION_COOKIE_SECURE: 'false',
      RESEND_API_KEY: 'test-resend-key-value',
      RESEND_FROM_EMAIL: PRODUCTION_RESEND_FROM_EMAIL,
      OTP_HMAC_SECRET: 'h'.repeat(32),
    });
    const loadEnv = await freshLoadEnv();

    expect(loadEnv()).toMatchObject({
      NODE_ENV: 'production',
      COMBO_ENVIRONMENT: 'test',
      SESSION_COOKIE_SECURE: false,
    });
  });

  it('requires Preview and Production to use an HTTPS host cookie', async () => {
    stub({
      ...COMMON,
      COMBO_ENVIRONMENT: 'preview',
      NODE_ENV: 'production',
      PROCESS: 'api',
      PUBLIC_APP_ORIGINS: 'http://127.0.0.1:18080',
      SESSION_COOKIE_SECURE: 'false',
      RESEND_API_KEY: 'test-resend-key-value',
      RESEND_FROM_EMAIL: PRODUCTION_RESEND_FROM_EMAIL,
      OTP_HMAC_SECRET: 'h'.repeat(32),
    });
    const loadEnv = await freshLoadEnv();

    expect(loadEnv).toThrowError(/SESSION_COOKIE_SECURE/);
  });

  it.each([
    'https://combo.example/',
    ' https://combo.example',
    'https://combo.example,https://combo.example',
    'https://combo.example/path',
    'javascript:alert(1)',
  ])('rejects non-canonical PUBLIC_APP_ORIGINS entry %s', async (origins) => {
    stub({
      ...COMMON,
      NODE_ENV: 'production',
      PROCESS: 'api',
      PUBLIC_APP_ORIGINS: origins,
      SESSION_COOKIE_SECURE: 'true',
      RESEND_API_KEY: 'test-resend-key-value',
      RESEND_FROM_EMAIL: PRODUCTION_RESEND_FROM_EMAIL,
      OTP_HMAC_SECRET: 'h'.repeat(32),
    });
    const loadEnv = await freshLoadEnv();

    expect(loadEnv).toThrowError(/PUBLIC_APP_ORIGINS/);
  });
});
