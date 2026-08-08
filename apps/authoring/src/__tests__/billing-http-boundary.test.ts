import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../bootstrap/app.js';
import { loadEnv } from '../platform/config/env.js';

let app: FastifyInstance;
const CALLBACK_URL = '/api/v1/billing/leshouying/payment-notify';
const FAIL_BODY = { return_code: 'FAIL', return_msg: '处理失败' };

beforeAll(async () => {
  app = await buildApp({
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
      LESHOUYING_ENABLED: false,
    },
  });
});

afterAll(async () => {
  await app.close();
});

describe('payment notification HTTP boundary', () => {
  it('does not require Cookie or Origin and fails closed when the gateway is disabled', async () => {
    const response = await app.inject({
      method: 'POST',
      url: CALLBACK_URL,
      headers: { 'content-type': 'application/json' },
      payload: { return_code: 'SUCCESS' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(FAIL_BODY);
  });

  it('uses the fixed provider response for wrong content type and malformed JSON', async () => {
    const wrongType = await app.inject({
      method: 'POST',
      url: CALLBACK_URL,
      headers: { 'content-type': 'text/plain' },
      payload: '{}',
    });
    expect(wrongType.statusCode).toBe(415);
    expect(wrongType.json()).toEqual(FAIL_BODY);

    const malformed = await app.inject({
      method: 'POST',
      url: CALLBACK_URL,
      headers: { 'content-type': 'application/json' },
      payload: '{"return_code":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual(FAIL_BODY);
    expect(malformed.body).not.toContain('FST_ERR');
  });

  it('preserves the body limit while keeping the provider response shape', async () => {
    const response = await app.inject({
      method: 'POST',
      url: CALLBACK_URL,
      headers: { 'content-type': 'application/json' },
      payload: { padding: 'x'.repeat(17 * 1_024) },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual(FAIL_BODY);
  });

  it('rate limits without switching to a browser ErrorEnvelope', async () => {
    let response;
    for (let index = 0; index < 601; index += 1) {
      response = await app.inject({
        method: 'POST',
        url: CALLBACK_URL,
        headers: { 'content-type': 'application/json' },
        payload: { sequence: index },
      });
    }
    expect(response?.statusCode).toBe(429);
    expect(response?.json()).toEqual(FAIL_BODY);
  });
});
