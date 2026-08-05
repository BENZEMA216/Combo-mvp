import { describe, expect, it } from 'vitest';
import { buildApp, sharedHttpRateLimitOptions } from '../bootstrap/app.js';
import { loadEnv } from '../platform/config/env.js';

describe('HTTP rate-limit store policy', () => {
  it('uses an environment-isolated shared Redis namespace and fails closed', () => {
    const redis = {} as never;
    expect(sharedHttpRateLimitOptions({ COMBO_ENVIRONMENT: 'preview' }, redis)).toMatchObject({
      redis,
      nameSpace: 'combo:preview:http-rate-limit:',
      skipOnError: false,
      global: false,
    });
  });

  it('allows the in-memory store only when a test explicitly requests it', async () => {
    await expect(
      buildApp({
        env: { ...loadEnv(), NODE_ENV: 'production' },
        httpRateLimitStore: 'memory',
      }),
    ).rejects.toThrow('in-memory HTTP rate limiting is only allowed in NODE_ENV=test');
  });
});
