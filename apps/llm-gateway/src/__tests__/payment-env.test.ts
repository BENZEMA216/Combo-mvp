import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../env.js';

afterEach(() => vi.unstubAllEnvs());
function env() {
  for (const [name, value] of Object.entries({
    LLM_GATEWAY_PRICING_JSON: '{"default":{"input":1,"output":2}}',
    LLM_GATEWAY_INTERNAL_TOKEN: 'test-agent-visible-credential',
    BILLING_INTERNAL_TOKEN: 'test-billing-legacy-credential',
    BILLING_BASE_URL: 'https://billing.combo.test',
    PROVIDER_BASE_URL: 'https://provider.invalid',
    PROVIDER_API_KEY: 'test-provider-credential',
  }))
    vi.stubEnv(name, value);
  vi.stubEnv('LLM_GATEWAY_PAYMENT_ADMISSION', undefined);
  vi.stubEnv('BILLING_PAYMENT_GATEWAY_TOKEN', undefined);
}
describe('payment admission activation', () => {
  it('keeps the new admission endpoint opt-in and requires a separate service credential', () => {
    env();
    expect(loadEnv().PAYMENT_ADMISSION_TOKEN).toBeUndefined();
    vi.stubEnv('LLM_GATEWAY_PAYMENT_ADMISSION', 'true');
    expect(() => loadEnv()).toThrow('BILLING_PAYMENT_GATEWAY_TOKEN');
    vi.stubEnv('BILLING_PAYMENT_GATEWAY_TOKEN', 'test-agent-visible-credential');
    expect(() => loadEnv()).toThrow('separate');
    vi.stubEnv('BILLING_PAYMENT_GATEWAY_TOKEN', 'test-dedicated-payment-credential');
    expect(loadEnv().PAYMENT_ADMISSION_TOKEN).toBe('test-dedicated-payment-credential');
    vi.stubEnv('LLM_GATEWAY_PAYMENT_ADMISSION', 'maybe');
    expect(() => loadEnv()).toThrow('must be true or false');
  });
});
