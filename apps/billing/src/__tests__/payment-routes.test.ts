import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { PaymentApiErrorResponseSchema, PaymentRequiredResponseSchema } from '@cb/payment-protocol';
import { registerPaymentRoutes } from '../payment-routes.js';
import { createPaymentTokenCodec, type PaymentStore } from '../payment-service.js';

const userId = '00000000-0000-0000-0000-000000000001';
const tokens = createPaymentTokenCodec('fixture-payment-key-'.repeat(3));
const requirement = {
  id: 'payreq-1',
  paymentToken: tokens.issue('payreq-1'),
  amount: { currency: 'CNY', amountCents: '300' },
  expiresAt: '2099-01-01T00:05:00Z',
};
const call = {
  userId,
  agentId: 'agent-a',
  operationId: 'operation-1',
  callId: 'call-1',
  requestFingerprint: 'a'.repeat(64),
  pricingPolicyId: 'price-1',
  estimatedAmount: 300,
};
function setup() {
  const store: PaymentStore = {
    admitCall: vi.fn().mockResolvedValue({ kind: 'payment_required', requirement }),
    finishCall: vi.fn().mockResolvedValue('recorded'),
    createPayment: vi.fn().mockResolvedValue({ kind: 'not_found' }),
    getPayment: vi.fn().mockResolvedValue(null),
    findPayment: vi.fn().mockResolvedValue(null),
    confirmPayment: vi.fn(),
    releaseExpiredFunds: vi.fn(),
  };
  const app = Fastify();
  registerPaymentRoutes(app, {
    store,
    authenticateUser: async (req) =>
      req.headers.cookie === 'trusted-test-session' ? userId : null,
    authenticateGateway: async (req) => req.headers.authorization === 'Bearer trusted-gateway',
  });
  return { app, store };
}
describe('payment HTTP contract', () => {
  it('only lets the trusted Gateway record strict attempt outcomes', async () => {
    const { app, store } = setup();
    const payload = {
      holdId: '00000000-0000-4000-8000-000000000001',
      outcome: 'failed_no_charge',
      failureReason: 'invalid_response',
    };
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/billing/call-attempt-results',
            headers: { cookie: 'trusted-test-session' },
            payload,
          })
        ).statusCode,
      ).toBe(401);
      expect(store.finishCall).not.toHaveBeenCalled();
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/billing/call-attempt-results',
            headers: { authorization: 'Bearer trusted-gateway' },
            payload: { ...payload, userId },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/billing/call-attempt-results',
            headers: { authorization: 'Bearer trusted-gateway' },
            payload,
          })
        ).statusCode,
      ).toBe(200);
      expect(store.finishCall).toHaveBeenCalledWith(payload);
    } finally {
      await app.close();
    }
  });
  it('keeps JSON parser failures in the public error envelope', async () => {
    const { app } = setup();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/payments',
        headers: { 'content-type': 'application/json' },
        payload: '{"paymentToken":"private',
      });
      expect(response.statusCode).toBe(400);
      expect(PaymentApiErrorResponseSchema.safeParse(response.json()).success).toBe(true);
      expect(response.body).not.toContain('private');
    } finally {
      await app.close();
    }
  });
  it('returns the canonical 402 without private billing fields', async () => {
    const { app } = setup();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/billing/call-admissions',
        headers: { authorization: 'Bearer trusted-gateway' },
        payload: call,
      });
      expect(response.statusCode).toBe(402);
      expect(PaymentRequiredResponseSchema.safeParse(response.json()).success).toBe(true);
      expect(response.body).not.toContain('userId');
      expect(response.body).not.toContain('wallet');
    } finally {
      await app.close();
    }
  });
  it('takes user identity only from the authentication adapter and rejects body identities', async () => {
    const { app, store } = setup();
    try {
      const body = { paymentToken: requirement.paymentToken, requestKey: 'request-key-1' };
      expect(
        (await app.inject({ method: 'POST', url: '/v1/payments', payload: body })).statusCode,
      ).toBe(401);
      expect(store.createPayment).not.toHaveBeenCalled();
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/payments',
            headers: { cookie: 'trusted-test-session' },
            payload: { ...body, userId },
          })
        ).statusCode,
      ).toBe(400);
      const response = await app.inject({
        method: 'POST',
        url: '/v1/payments',
        headers: { cookie: 'trusted-test-session' },
        payload: body,
      });
      expect(response.statusCode).toBe(404);
      expect(store.createPayment).toHaveBeenCalledWith({ ...body, userId });
      expect(PaymentApiErrorResponseSchema.safeParse(response.json()).success).toBe(true);
    } finally {
      await app.close();
    }
  });
  it('fails closed on malformed store output without logging or returning the token', async () => {
    const { app, store } = setup();
    vi.mocked(store.admitCall).mockResolvedValue({
      kind: 'payment_required',
      requirement: { ...requirement, wallet: 'private' },
    } as never);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/billing/call-admissions',
        headers: { authorization: 'Bearer trusted-gateway' },
        payload: call,
      });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain(requirement.paymentToken);
      expect(response.body).not.toContain('private');
    } finally {
      await app.close();
    }
  });
});
