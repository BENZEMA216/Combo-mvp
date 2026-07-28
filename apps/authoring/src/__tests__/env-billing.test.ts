import { afterEach, describe, expect, it, vi } from 'vitest';

const COMMON = {
  NODE_ENV: 'test',
  PROCESS: 'api',
  COMBO_ENVIRONMENT: 'test',
  COMBO_SOURCE_SHA: 'a'.repeat(40),
  COMBO_RELEASE_ID: `release-${'a'.repeat(40)}`,
  COMBO_BUILT_AT: '2026-07-28T00:00:00.000Z',
  COMBO_RELEASE_MANIFEST_DIGEST: `sha256:${'b'.repeat(64)}`,
  COMBO_WEB_ASSET_MANIFEST: `sha256:${'c'.repeat(64)}`,
  PUBLIC_APP_ORIGINS: 'http://localhost',
  SESSION_COOKIE_SECURE: 'false',
  RESEND_API_KEY: 'test-resend-key',
  RESEND_FROM_EMAIL: 'login@example.test',
  OTP_HMAC_SECRET: 'h'.repeat(32),
};

function stub(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
}

async function freshConfig() {
  vi.resetModules();
  return import('../platform/config/env.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('billing environment boundary', () => {
  it('keeps payments disabled by default without materializing credentials', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stub(COMMON);
    const { billingConfigurationFromEnv, loadEnv } = await freshConfig();
    const env = loadEnv();
    expect(billingConfigurationFromEnv(env)).toEqual({
      packages: [],
      gatewayEnabled: false,
      submissionRecoveryMs: 10_000,
    });
    expect(env.LESHOUYING_INSTITUTION_KEY).toBe('');
    expect(env.LESHOUYING_ENVIRONMENT).toBe('TEST');
  });

  it('accepts explicit test packages and a fixed HTTPS callback', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stub({
      ...COMMON,
      LESHOUYING_ENABLED: 'true',
      BILLING_RECHARGE_PACKAGES_JSON: JSON.stringify([
        { id: 'starter', amountCents: '300', label: '体验充值' },
      ]),
      LESHOUYING_INSTITUTION_NO: 'INST0001',
      LESHOUYING_MERCHANT_NO: 'MCH_TEST_001',
      LESHOUYING_INSTITUTION_KEY: 'test-only-private-value',
      LESHOUYING_NOTIFY_URL: 'https://api.example.test/api/v1/billing/leshouying/payment-notify',
    });
    const { billingConfigurationFromEnv, loadEnv } = await freshConfig();
    expect(billingConfigurationFromEnv(loadEnv())).toEqual({
      packages: [{ id: 'starter', amountCents: 300n, label: '体验充值' }],
      gatewayEnabled: true,
      submissionRecoveryMs: 10_000,
    });
  });

  it('fails closed on partial configuration without printing the secret value', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const privateValue = 'must-not-appear-in-errors';
    stub({
      ...COMMON,
      LESHOUYING_ENABLED: 'true',
      BILLING_RECHARGE_PACKAGES_JSON: '[]',
      LESHOUYING_INSTITUTION_KEY: privateValue,
      LESHOUYING_NOTIFY_URL: 'http://unsafe.example.test/callback',
    });
    const { loadEnv } = await freshConfig();
    expect(loadEnv).toThrowError(/BILLING_RECHARGE_PACKAGES_JSON/);
    try {
      loadEnv();
    } catch (error) {
      expect(String(error)).not.toContain(privateValue);
      expect(String(error)).not.toContain('unsafe.example.test');
    }
  });

  it('does not allow the production gateway without the explicit production gate', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stub({
      ...COMMON,
      LESHOUYING_ENABLED: 'true',
      LESHOUYING_ENVIRONMENT: 'PRODUCTION',
      LESHOUYING_PRODUCTION_ENABLED: 'false',
      BILLING_RECHARGE_PACKAGES_JSON: JSON.stringify([
        { id: 'starter', amountCents: 300, label: '体验充值' },
      ]),
      LESHOUYING_INSTITUTION_NO: 'INST0001',
      LESHOUYING_MERCHANT_NO: 'MCH_TEST_001',
      LESHOUYING_INSTITUTION_KEY: 'test-only-private-value',
      LESHOUYING_NOTIFY_URL: 'https://api.example.test/api/v1/billing/leshouying/payment-notify',
    });
    const { loadEnv } = await freshConfig();
    expect(loadEnv).toThrowError(/LESHOUYING_PRODUCTION_ENABLED/);
  });
});
