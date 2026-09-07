import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { buildApp } from '../app.js';
import { createFakeBillingStore } from './fakes.js';
import { checkoutPageHtml } from '../checkout-page.js';
import {
  startChannelReconciler,
  withChannelPaymentState,
  type PaymentChannelService,
} from '../checkout-service.js';
import { PaymentAuthenticationError } from '../payment-auth.js';
import {
  ChannelConflictError,
  type ChannelOrder,
  type ChannelOrderStore,
} from '../channel-service.js';
import { InvalidPaymentNotificationError } from '../channel/index.js';
import type { PaymentStore } from '../payment-service.js';
const userId = randomUUID();
const paymentId = randomUUID();
const origin = 'https://pay.test';
const payment = {
  paymentRequestId: paymentId,
  status: 'waiting' as const,
  amount: { currency: 'CNY' as const, amountCents: '300' },
  createdAt: '2026-09-07T00:00:00Z',
  updatedAt: '2026-09-07T00:00:00Z',
  expiresAt: '2099-09-07T00:00:00Z',
  action: {
    kind: 'open_url' as const,
    url: `${origin}/payments/${paymentId}`,
    expiresAt: '2099-09-07T00:00:00Z',
  },
};
const channelOrder: ChannelOrder = {
  paymentId,
  userId,
  amountCents: 300,
  environment: 'test',
  institutionNo: 'inst',
  merchantNo: 'merchant',
  payTraceNo: 'trace',
  payTime: '20260907000000',
  payType: 'wechat',
  state: 'pending',
  qrContent: 'private-provider-code',
  actionExpiresAt: new Date('2099-09-07'),
  expiresAt: new Date('2099-09-07'),
  completed: false,
};
async function setup() {
  const payments: PaymentStore = {
    admitCall: vi.fn(),
    createPayment: vi.fn(),
    getPayment: vi.fn(async () => payment),
    findPayment: vi.fn(),
    confirmPayment: vi.fn(),
    releaseExpiredFunds: vi.fn(),
  };
  const channel: PaymentChannelService = {
    create: vi.fn(async () => channelOrder),
    get: vi.fn(async () => channelOrder),
    notify: vi.fn(async () => 'completed' as const),
    reconcile: vi.fn(async () => ({ queried: 0, failed: 0 })),
  };
  const authenticateUser = vi.fn(async (req: FastifyRequest) => {
    if (req.method === 'POST' && req.headers.origin !== origin)
      throw new PaymentAuthenticationError(403);
    return req.headers.cookie === 'test-session' ? userId : null;
  });
  const renderQr = vi.fn(async () => 'data:image/png;base64,dGVzdA==');
  const app = await buildApp({
    store: createFakeBillingStore().store,
    internalToken: 'test-platform-internal',
    adminToken: 'test-platform-admin',
    overdraftHardLimitCents: 500,
    checkout: { payments, channel, authenticateUser, testMode: true, renderQr },
  });
  return { app, payments, channel, authenticateUser, renderQr };
}
describe('authenticated Combo checkout', () => {
  it('requires current login and redirects only to the fixed same-origin login', async () => {
    const s = await setup();
    try {
      const page = await s.app.inject({ url: `/payments/${paymentId}` });
      expect(page.statusCode).toBe(303);
      expect(page.headers.location).toBe(
        '/authz/login?next=' + encodeURIComponent('/payments/' + paymentId),
      );
      expect((await s.app.inject({ url: `/v1/payment-checkouts/${paymentId}` })).statusCode).toBe(
        401,
      );
      expect(s.payments.getPayment).not.toHaveBeenCalled();
      expect(s.channel.get).not.toHaveBeenCalled();
    } finally {
      await s.app.close();
    }
  });
  it('serves a no-store page with a fresh CSP nonce and locally rendered QR image', async () => {
    const s = await setup();
    try {
      const page = await s.app.inject({
        url: `/payments/${paymentId}`,
        headers: { cookie: 'test-session' },
      });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('Combo 收银台');
      expect(page.body).toContain('测试支付环境');
      expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(page.headers['content-security-policy']).not.toContain('unsafe-inline');
      expect(page.headers['referrer-policy']).toBe('no-referrer');
      expect(page.headers['cache-control']).toBe('no-store');
      const response = await s.app.inject({
        url: `/v1/payment-checkouts/${paymentId}`,
        headers: { cookie: 'test-session' },
      });
      expect(response.json().data.checkout.qrImage).toMatch(/^data:image\/png/);
      expect(response.body).not.toContain(channelOrder.qrContent);
      expect(response.body).not.toContain('merchant');
      expect(s.renderQr).toHaveBeenCalledWith(channelOrder.qrContent);
    } finally {
      await s.app.close();
    }
  });
  it('takes owner only from current authentication and rejects injected price or identity', async () => {
    const s = await setup();
    try {
      const path = `/v1/payment-checkouts/${paymentId}`;
      for (const payload of [
        { payType: 'wechat', amount: 1 },
        { payType: 'wechat', userId },
        { payType: 'h5' },
      ])
        expect(
          (
            await s.app.inject({
              method: 'POST',
              url: path,
              headers: { cookie: 'test-session', origin },
              payload,
            })
          ).statusCode,
        ).toBe(400);
      expect(s.channel.create).not.toHaveBeenCalled();
      expect(
        (
          await s.app.inject({
            method: 'POST',
            url: path,
            headers: { cookie: 'test-session' },
            payload: { payType: 'wechat' },
          })
        ).statusCode,
      ).toBe(403);
      expect(s.channel.create).not.toHaveBeenCalled();
      expect(
        (
          await s.app.inject({
            method: 'POST',
            url: path,
            headers: { cookie: 'test-session', origin },
            payload: { payType: 'wechat' },
          })
        ).statusCode,
      ).toBe(200);
      expect(s.channel.create).toHaveBeenCalledWith({ paymentId, userId, payType: 'wechat' });
      vi.mocked(s.channel.create).mockRejectedValue(new ChannelConflictError());
      expect(
        (
          await s.app.inject({
            method: 'POST',
            url: path,
            headers: { cookie: 'test-session', origin },
            payload: { payType: 'alipay' },
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await s.app.close();
    }
  });
  it('does not expose a QR image for inaccessible or completed payments', async () => {
    const s = await setup();
    try {
      vi.mocked(s.payments.getPayment).mockResolvedValueOnce(null);
      expect(
        (
          await s.app.inject({
            url: `/v1/payment-checkouts/${paymentId}`,
            headers: { cookie: 'test-session' },
          })
        ).statusCode,
      ).toBe(404);
      const { action: _action, ...base } = payment;
      vi.mocked(s.payments.getPayment).mockResolvedValue({
        ...base,
        status: 'completed',
        completedAt: base.createdAt,
      });
      const reply = await s.app.inject({
        url: `/v1/payment-checkouts/${paymentId}`,
        headers: { cookie: 'test-session' },
      });
      expect(reply.json().data.checkout).not.toHaveProperty('qrImage');
      expect(s.renderQr).not.toHaveBeenCalled();
    } finally {
      await s.app.close();
    }
  });
  it('escapes page data and rejects unsafe nonce values', () => {
    const html = checkoutPageHtml('</script><img src=x onerror=evil()>', 'a'.repeat(24), false);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).not.toContain('<img src=x');
    expect(() => checkoutPageHtml(paymentId, 'bad"nonce', false)).toThrow();
  });
});
describe('payment notification boundary', () => {
  it('uses channel signatures, not browser sessions, and never accepts malformed or unconfirmed results', async () => {
    const s = await setup();
    try {
      const url = '/billing/leshouying/payment-notify';
      expect((await s.app.inject({ method: 'POST', url, payload: {} })).json()).toEqual({
        return_code: 'SUCCESS',
        return_msg: '成功',
      });
      expect(s.authenticateUser).not.toHaveBeenCalled();
      vi.mocked(s.channel.notify)
        .mockRejectedValueOnce(new InvalidPaymentNotificationError())
        .mockRejectedValueOnce(new Error('sensitive database details'));
      expect((await s.app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(400);
      const failure = await s.app.inject({ method: 'POST', url, payload: {} });
      expect(failure.statusCode).toBe(503);
      expect(failure.body).not.toContain('sensitive');
      const malformed = await s.app.inject({
        method: 'POST',
        url,
        payload: '{"sign":"private',
        headers: { 'content-type': 'application/json' },
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json().return_code).toBe('FAIL');
    } finally {
      await s.app.close();
    }
  });
  it('limits the actual peer independently of spoofed forwarding headers', async () => {
    const s = await setup();
    try {
      for (let i = 0; i < 120; i++)
        expect(
          (
            await s.app.inject({
              method: 'POST',
              url: '/billing/leshouying/payment-notify',
              payload: {},
              headers: { 'x-forwarded-for': `192.0.2.${i}` },
            })
          ).statusCode,
        ).toBe(200);
      expect(
        (
          await s.app.inject({
            method: 'POST',
            url: '/billing/leshouying/payment-notify',
            payload: {},
          })
        ).statusCode,
      ).toBe(429);
      expect(s.channel.notify).toHaveBeenCalledTimes(120);
    } finally {
      await s.app.close();
    }
  });
});
describe('channel state and lifecycle', () => {
  it('projects definitive channel failure as closed without overriding authoritative completed', async () => {
    const s = await setup();
    try {
      const channels = {
        get: vi.fn(async () => ({ ...channelOrder, state: 'failed', completed: false })),
      } as unknown as ChannelOrderStore;
      const wrapped = withChannelPaymentState(s.payments, channels);
      const result = await wrapped.getPayment({ paymentRequestId: paymentId, userId });
      expect(result?.status).toBe('closed');
      expect(result).not.toHaveProperty('action');
      const { action: _action, ...base } = payment;
      vi.mocked(s.payments.getPayment).mockResolvedValue({
        ...base,
        status: 'completed',
        completedAt: base.createdAt,
      });
      expect((await wrapped.getPayment({ paymentRequestId: paymentId, userId }))?.status).toBe(
        'completed',
      );
    } finally {
      await s.app.close();
    }
  });
  it('does not overlap reconciliation and waits for it before shutdown', async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const reconcile = vi.fn(async () => {
      await pending;
      return { queried: 1, failed: 0 };
    });
    const purge = vi.fn(async () => 0);
    const worker = startChannelReconciler({ channel: { reconcile }, intervalMs: 1000, purge });
    try {
      await vi.advanceTimersByTimeAsync(3000);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(purge).toHaveBeenCalledTimes(1);
      let stopped = false;
      const stopping = worker.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      resolve();
      await stopping;
      await vi.advanceTimersByTimeAsync(1000);
      expect(reconcile).toHaveBeenCalledTimes(1);
    } finally {
      resolve();
      await worker.stop();
      vi.useRealTimers();
    }
  });
});
