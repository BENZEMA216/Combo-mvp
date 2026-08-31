import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MANAGED_KEYS = [
  'NODE_ENV',
  'DATABASE_URL',
  'REDIS_URL',
  'S3_ENDPOINT',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'PUBLIC_APP_ORIGINS',
  'SESSION_COOKIE_SECURE',
  'RUNTIME_BILLING_FREE_USES',
  'RUNTIME_BILLING_UNIT_PRICE_CENTS',
  'COMBO_ENVIRONMENT',
  'COMBO_SOURCE_SHA',
  'COMBO_RELEASE_ID',
  'COMBO_BUILT_AT',
  'COMBO_RELEASE_MANIFEST_DIGEST',
  'COMBO_WEB_ASSET_MANIFEST',
] as const;

const originalValues = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of MANAGED_KEYS) originalValues.set(key, process.env[key]);
});

afterEach(() => {
  for (const key of MANAGED_KEYS) {
    const value = originalValues.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalValues.clear();
  vi.resetModules();
});

function setProductionInfrastructure(): void {
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = 'postgres://runtime:runtime@database.invalid/runtime';
  process.env.REDIS_URL = 'redis://redis.invalid:6379';
  process.env.S3_ENDPOINT = 'https://objects.invalid';
  process.env.S3_ACCESS_KEY = 'test-placeholder';
  process.env.S3_SECRET_KEY = 'test-placeholder';
  process.env.PUBLIC_APP_ORIGINS = 'https://combo.example,https://review.combo.example';
  process.env.SESSION_COOKIE_SECURE = 'true';
  process.env.RUNTIME_BILLING_FREE_USES = '3';
  process.env.RUNTIME_BILLING_UNIT_PRICE_CENTS = '1';
  process.env.COMBO_ENVIRONMENT = 'production';
  process.env.COMBO_SOURCE_SHA = 'a'.repeat(40);
  process.env.COMBO_RELEASE_ID = `release-${'a'.repeat(40)}`;
  process.env.COMBO_BUILT_AT = '2026-07-28T00:00:00.000Z';
  process.env.COMBO_RELEASE_MANIFEST_DIGEST = `sha256:${'b'.repeat(64)}`;
  process.env.COMBO_WEB_ASSET_MANIFEST = `sha256:${'c'.repeat(64)}`;
}

describe('runtime authentication configuration', () => {
  it('uses the documented three-use and one-cent fallback outside production', async () => {
    for (const key of MANAGED_KEYS) delete process.env[key];
    process.env.NODE_ENV = 'test';
    vi.resetModules();

    const { loadEnv } = await import('../platform/config/env.js');
    const env = loadEnv();

    expect(env.RUNTIME_BILLING_FREE_USES).toBe(3);
    expect(env.RUNTIME_BILLING_UNIT_PRICE_CENTS).toBe(1);
  });

  it('does not expose remote identity-provider or local token-signing configuration', async () => {
    setProductionInfrastructure();
    vi.resetModules();

    const { loadEnv } = await import('../platform/config/env.js');
    const env = loadEnv() as unknown as Record<string, unknown>;

    expect(env.NODE_ENV).toBe('production');
    expect(Object.keys(env).join(' ')).not.toMatch(
      /issuer|jwks|audience|token.*secret|session.*secret/i,
    );
  });

  it('requires secure Cookies and HTTPS origins for every deployed environment', async () => {
    setProductionInfrastructure();
    process.env.PUBLIC_APP_ORIGINS = 'http://combo.example';
    process.env.SESSION_COOKIE_SECURE = 'false';
    vi.resetModules();

    const { loadEnv } = await import('../platform/config/env.js');
    expect(() => loadEnv()).toThrowError('SESSION_COOKIE_SECURE');
  });

  it('rejects a production-mode Test process with a non-secure Cookie', async () => {
    setProductionInfrastructure();
    process.env.COMBO_ENVIRONMENT = 'test';
    process.env.PUBLIC_APP_ORIGINS = 'http://combo-test.internal';
    process.env.SESSION_COOKIE_SECURE = 'false';
    vi.resetModules();

    const { loadEnv } = await import('../platform/config/env.js');
    expect(() => loadEnv()).toThrowError('SESSION_COOKIE_SECURE');
  });

  it('rejects malformed or ambiguously normalized origin lists', async () => {
    setProductionInfrastructure();
    process.env.PUBLIC_APP_ORIGINS = 'https://combo.example, https://review.combo.example';
    vi.resetModules();

    const { loadEnv } = await import('../platform/config/env.js');
    expect(() => loadEnv()).toThrowError('PUBLIC_APP_ORIGINS');
  });

  it('keeps PostgreSQL, runtime infrastructure and public origin as production startup requirements', async () => {
    process.env.NODE_ENV = 'production';
    for (const key of [
      'DATABASE_URL',
      'REDIS_URL',
      'S3_ENDPOINT',
      'S3_ACCESS_KEY',
      'S3_SECRET_KEY',
      'PUBLIC_APP_ORIGINS',
      'SESSION_COOKIE_SECURE',
      'RUNTIME_BILLING_FREE_USES',
      'RUNTIME_BILLING_UNIT_PRICE_CENTS',
    ] as const) {
      delete process.env[key];
    }
    vi.resetModules();

    const { loadEnv } = await import('../platform/config/env.js');
    let message = '';
    try {
      loadEnv();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('REDIS_URL');
    expect(message).toContain('S3_ENDPOINT');
    expect(message).toContain('PUBLIC_APP_ORIGINS');
    expect(message).toContain('SESSION_COOKIE_SECURE');
    expect(message).toContain('RUNTIME_BILLING_FREE_USES');
    expect(message).toContain('RUNTIME_BILLING_UNIT_PRICE_CENTS');
    expect(message).not.toMatch(/identity|issuer|jwks|audience|session.*secret/i);
  });

  it('does not allow production to inherit the one-cent fallback', async () => {
    setProductionInfrastructure();
    delete process.env.RUNTIME_BILLING_UNIT_PRICE_CENTS;
    vi.resetModules();

    const { loadEnv } = await import('../platform/config/env.js');
    expect(() => loadEnv()).toThrowError('RUNTIME_BILLING_UNIT_PRICE_CENTS');
  });

  it('validates configurable free uses and integer cent price', async () => {
    setProductionInfrastructure();
    process.env.RUNTIME_BILLING_FREE_USES = '-1';
    process.env.RUNTIME_BILLING_UNIT_PRICE_CENTS = '0';
    vi.resetModules();

    const { loadEnv } = await import('../platform/config/env.js');
    expect(() => loadEnv()).toThrowError(/RUNTIME_BILLING_FREE_USES/);
  });
});
