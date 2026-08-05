import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../bootstrap/app.js';
import { loadEnv } from '../platform/config/env.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({
    httpRateLimitStore: 'memory',
    env: {
      ...loadEnv(),
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      PUBLIC_APP_ORIGINS: 'http://localhost',
      SESSION_COOKIE_SECURE: false,
      OTP_HMAC_SECRET: 'h'.repeat(32),
      RESEND_API_KEY: 'test-only-key',
      RESEND_FROM_EMAIL: 'login@example.test',
      RESEND_API_BASE_URL: 'http://127.0.0.1:9',
    },
  });
});

afterAll(async () => {
  await app.close();
});

describe('authentication HTTP boundary', () => {
  it('requires an exact Origin even when JSON is otherwise valid', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/challenges',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'Alice@example.com' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json() as { error: Record<string, unknown> };
    expect(body.error.traceId).toEqual(expect.any(String));
    expect(body.error).not.toHaveProperty('code');
  });

  it('preserves 415 with a safe no-store envelope', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/challenges',
      headers: {
        origin: 'http://localhost',
        'sec-fetch-site': 'same-origin',
        'content-type': 'text/plain',
      },
      payload: '{"email":"Alice@example.com"}',
    });
    expect(response.statusCode).toBe(415);
    expect(response.headers['cache-control']).toBe('no-store');
    expect((response.json() as { error: Record<string, unknown> }).error).not.toHaveProperty(
      'code',
    );
    expect(response.body).not.toContain('FST_ERR');
    expect(response.body).not.toContain('Alice@example.com');
  });

  it('preserves the route-level 413 without using upload-specific copy', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/verifications',
      headers: {
        origin: 'http://localhost',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ email: `${'a'.repeat(4_200)}@example.com`, code: '123456' }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.headers['cache-control']).toBe('no-store');
    expect((response.json() as { error: Record<string, unknown> }).error).not.toHaveProperty(
      'code',
    );
    expect(response.body).toContain('认证请求内容过大');
    expect(response.body).not.toContain('分片');
    expect(response.body).not.toContain('123456');
  });
});
