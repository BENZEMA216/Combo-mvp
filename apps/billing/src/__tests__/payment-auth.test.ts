import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, SignJWT } from 'jose';
import Fastify, { type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPaymentUserAuthenticator, paymentGatewayAuthenticated } from '../payment-auth.js';
import { registerPaymentRoutes } from '../payment-routes.js';
import type { PaymentStore } from '../payment-service.js';
import { loadEnv } from '../env.js';
import { buildApp } from '../app.js';
import { createFakeBillingStore } from './fakes.js';
import { startHoldSweeper } from '../sweep.js';

const keys = generateKeyPairSync('ed25519');
const userId = randomUUID();
const origin = 'https://host.combo.test';
const cookie = `cb_v2_session=v2s1.${'a'.repeat(43)}`;
afterEach(() => vi.unstubAllEnvs());
async function assertion(audience = 'combo-payment-host') {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'EdDSA', kid: 'key-1' })
    .setIssuer('combo-authz')
    .setSubject(userId)
    .setAudience(audience)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 300)
    .setJti(randomUUID())
    .sign(keys.privateKey);
}
function req(headers: Record<string, string>, method = 'POST'): FastifyRequest {
  return { headers, method } as FastifyRequest;
}
async function setup() {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { headers: { 'x-combo-assertion': await assertion() } }));
  const auth = createPaymentUserAuthenticator({
    authzBaseUrl: 'https://authz.combo.test',
    issuer: 'combo-authz',
    trustedOrigins: [origin],
    key: createLocalJWKSet({ keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'key-1' }] }),
    fetchImpl,
  });
  return { auth, fetchImpl };
}
describe('payment current-user authentication', () => {
  it('revalidates the live session through Authz and forwards only its own cookie', async () => {
    const { auth, fetchImpl } = await setup();
    expect(await auth(req({ origin, cookie: `irrelevant=private; ${cookie}` }))).toBe(userId);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ headers: { cookie }, redirect: 'error' });
    fetchImpl.mockResolvedValue(new Response(null, { status: 401 }));
    expect(await auth(req({ origin, cookie }))).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('rejects CSRF, ambiguous credentials, duplicate cookies and wrong assertion audience', async () => {
    const { auth, fetchImpl } = await setup();
    await expect(auth(req({ cookie }))).rejects.toMatchObject({ status: 403 });
    await expect(auth(req({ origin: 'https://attacker.invalid', cookie }))).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      auth(req({ origin, cookie, authorization: 'Bearer agent-access-token' })),
    ).rejects.toMatchObject({ status: 401 });
    expect(await auth(req({ origin, cookie: `${cookie}; ${cookie}` }))).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    fetchImpl.mockResolvedValue(
      new Response(null, { headers: { 'x-combo-assertion': await assertion('agent-a') } }),
    );
    await expect(auth(req({ origin, cookie }))).rejects.toMatchObject({ status: 401 });
  });
  it('keeps the dedicated Gateway credential separate from Agent/user credentials', () => {
    expect(paymentGatewayAuthenticated('Bearer service-test-key', 'service-test-key')).toBe(true);
    expect(paymentGatewayAuthenticated('Bearer agent-test-key', 'service-test-key')).toBe(false);
    expect(paymentGatewayAuthenticated(undefined, 'service-test-key')).toBe(false);
  });
  it('rejects missing, insecure or shared payment configuration before startup', () => {
    for (const [name, value] of Object.entries({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://unused.invalid/test',
      BILLING_INTERNAL_TOKEN: 'test-internal-credential',
      BILLING_ADMIN_TOKEN: 'test-admin-credential',
      BILLING_PAYMENTS_ENABLED: 'false',
    }))
      vi.stubEnv(name, value);
    expect(loadEnv().PAYMENTS).toBeUndefined();
    vi.stubEnv('BILLING_PAYMENTS_ENABLED', 'true');
    vi.stubEnv('BILLING_PAYMENT_TOKEN_KEY', '');
    expect(() => loadEnv()).toThrow('BILLING_PAYMENT_TOKEN_KEY');
    for (const [name, value] of Object.entries({
      BILLING_PAYMENT_TOKEN_KEY: 'test-payment-signing-key-not-for-production',
      BILLING_PAYMENT_GATEWAY_TOKEN: 'test-payment-gateway-credential',
      BILLING_PAYMENT_CHECKOUT_BASE_URL: 'https://pay.combo.test',
      BILLING_AUTHZ_BASE_URL: 'https://authz.combo.test',
      BILLING_AUTHZ_JWKS_URL: 'https://authz.combo.test/.well-known/jwks.json',
      AUTHZ_ASSERTION_ISSUER: 'combo-authz',
      BILLING_PAYMENT_HOST_ORIGINS: origin,
      BILLING_LESHOUYING_ENVIRONMENT: 'TEST',
      BILLING_LESHOUYING_INSTITUTION_NO: 'TEST_INST',
      BILLING_LESHOUYING_MERCHANT_NO: 'TEST_MERCHANT',
      BILLING_LESHOUYING_INSTITUTION_KEY: 'test-only-channel-credential',
    }))
      vi.stubEnv(name, value);
    expect(loadEnv().PAYMENTS?.trustedOrigins).toEqual([origin]);
    vi.stubEnv('BILLING_PAYMENT_GATEWAY_TOKEN', 'test-internal-credential');
    expect(() => loadEnv()).toThrow('must be separate');
    vi.stubEnv('BILLING_PAYMENT_GATEWAY_TOKEN', 'test-payment-gateway-credential');
    vi.stubEnv('BILLING_AUTHZ_BASE_URL', 'http://authz.combo.test');
    expect(() => loadEnv()).toThrow('trusted HTTPS');
    vi.stubEnv('BILLING_AUTHZ_BASE_URL', 'https://authz.combo.test');
    vi.stubEnv('BILLING_PAYMENT_HOST_ORIGINS', '*');
    expect(() => loadEnv()).toThrow('exact trusted origins');
  });
  it('fails closed without leaking upstream failures through the production app wiring', async () => {
    const { auth, fetchImpl } = await setup();
    const payments: PaymentStore = {
      admitCall: vi.fn(),
      createPayment: vi.fn(),
      getPayment: vi.fn(),
      findPayment: vi.fn(),
      confirmPayment: vi.fn(),
      releaseExpiredFunds: vi.fn(),
    };
    const app = await buildApp({
      store: createFakeBillingStore().store,
      internalToken: 'test-internal-credential',
      adminToken: 'test-admin-credential',
      overdraftHardLimitCents: 500,
      payments: {
        store: payments,
        trustedOrigins: [origin],
        authenticateUser: auth,
        authenticateGateway: async () => false,
      },
    });
    try {
      for (const status of [401, 503]) {
        fetchImpl.mockResolvedValue(new Response('sensitive upstream detail', { status }));
        const response = await app.inject({
          method: 'GET',
          url: '/v1/payments/payreq_example',
          headers: { cookie, origin },
        });
        expect(response.statusCode).toBe(status);
        expect(response.body).not.toContain('sensitive');
        expect(response.json()).toHaveProperty('error.userMessage');
        expect(payments.getPayment).not.toHaveBeenCalled();
      }
    } finally {
      await app.close();
    }
  });
  it('allows credentialed preflight only for configured Host origins', async () => {
    const app = Fastify();
    const store: PaymentStore = {
      admitCall: vi.fn(),
      createPayment: vi.fn(),
      getPayment: vi.fn(),
      findPayment: vi.fn(),
      confirmPayment: vi.fn(),
      releaseExpiredFunds: vi.fn(),
    };
    registerPaymentRoutes(app, {
      store,
      trustedOrigins: [origin],
      authenticateUser: async () => userId,
      authenticateGateway: async () => false,
    });
    try {
      const allowed = await app.inject({
        method: 'OPTIONS',
        url: '/v1/payments',
        headers: { origin },
      });
      expect(allowed.statusCode).toBe(204);
      expect(allowed.headers['access-control-allow-origin']).toBe(origin);
      expect(allowed.headers['access-control-allow-credentials']).toBe('true');
      expect(
        (
          await app.inject({
            method: 'OPTIONS',
            url: '/v1/payments',
            headers: { origin: 'https://attacker.invalid' },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await app.close();
    }
  });
  it('wires expired payment reservations into the periodic sweeper', async () => {
    vi.useFakeTimers();
    const releaseExpiredFunds = vi.fn().mockResolvedValue(2);
    const log = { info: vi.fn(), warn: vi.fn() };
    const sweeper = startHoldSweeper({
      store: createFakeBillingStore().store,
      paymentStore: { releaseExpiredFunds },
      intervalSeconds: 60,
      batchSize: 10,
      log,
    });
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(releaseExpiredFunds).toHaveBeenCalledWith(10);
      expect(log.info).toHaveBeenCalledWith({ releasedPaymentReservations: 2 }, expect.any(String));
      releaseExpiredFunds.mockRejectedValue(new Error('sensitive database failure'));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(log.warn).toHaveBeenCalledWith({}, 'hold or payment reservation sweep failed');
      sweeper.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(releaseExpiredFunds).toHaveBeenCalledTimes(2);
    } finally {
      sweeper.stop();
      vi.useRealTimers();
    }
  });
});
