import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  channelCheckoutView,
  ChannelConflictError,
  createPaymentChannelService,
  type ChannelOrder,
  type ChannelOrderStore,
} from '../channel-service.js';
import {
  InvalidPaymentNotificationError,
  type PaymentGateway,
  type VerifiedPaymentNotification,
} from '../channel/index.js';

function setup() {
  const order: ChannelOrder = {
    paymentId: randomUUID(),
    userId: randomUUID(),
    amountCents: 300,
    environment: 'test',
    institutionNo: 'inst',
    merchantNo: 'merchant',
    payTraceNo: 'trace',
    payTime: '20260907000000',
    payType: 'wechat',
    state: 'submitting',
    expiresAt: new Date(Date.now() + 900000),
    completed: false,
  };
  let prepared = false;
  const store: ChannelOrderStore = {
    prepare: vi.fn(async (input) => {
      if (input.userId !== order.userId) return null;
      const shouldSubmit = !prepared;
      prepared = true;
      return { order, shouldSubmit };
    }),
    get: vi.fn(async () => order),
    findNotification: vi.fn(async () => order),
    recordSubmission: vi.fn(async (_order, result) => {
      order.state = result.status;
      if (result.action) {
        order.qrContent = result.action.value;
        order.actionExpiresAt = result.action.expiresAt;
      }
    }),
    recordResult: vi.fn(async () => true),
    leaseQueries: vi.fn(async () => [order]),
  };
  const notification: VerifiedPaymentNotification = {
    eventFingerprint: 'a'.repeat(64),
    gatewayEnvironment: 'test',
    institutionNo: 'inst',
    merchantNo: 'merchant',
    payTraceNo: 'trace',
    payTime: order.payTime,
    amountCents: 300n,
    platformTradeNo: 'trade',
    returnCode: 'SUCCESS',
    resultCode: 'PAY_SUCCESS',
    attach: order.paymentId,
  };
  const gateway: PaymentGateway = {
    configured: true,
    environment: 'test',
    institutionNo: 'inst',
    merchantNo: 'merchant',
    createPayment: vi.fn<PaymentGateway['createPayment']>(async () => ({
      status: 'pending',
      action: { kind: 'code_url', value: 'private-qr', expiresAt: new Date(Date.now() + 800000) },
    })),
    queryPayment: vi.fn<PaymentGateway['queryPayment']>(async () => ({
      status: 'succeeded',
      platformTradeNo: 'trade',
    })),
    verifyPaymentNotification: vi.fn(() => notification),
  };
  const payments = {
    confirmPayment: vi.fn(async () => ({ kind: 'completed' as const, replayed: false })),
  };
  const service = createPaymentChannelService({ store, payments, gateway });
  const input = { paymentId: order.paymentId, userId: order.userId, payType: 'wechat' as const };
  return { order, store, gateway, payments, service, input, notification };
}
describe('payment channel orchestration', () => {
  it('uses one persisted order across concurrent or repeated checkout requests', async () => {
    const s = setup();
    await Promise.all([s.service.create(s.input), s.service.create(s.input)]);
    await s.service.create(s.input);
    expect(s.gateway.createPayment).toHaveBeenCalledTimes(1);
    expect(s.gateway.createPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 300n,
        orderNo: s.order.paymentId,
        payTraceNo: 'trace',
        payTime: s.order.payTime,
      }),
    );
    await expect(s.service.create({ ...s.input, payType: 'alipay' })).rejects.toBeInstanceOf(
      ChannelConflictError,
    );
    expect(await s.service.create({ ...s.input, userId: randomUUID() })).toBeNull();
  });
  it('never resubmits after a timeout or when saving the prepay response fails', async () => {
    for (const savingFails of [false, true]) {
      const s = setup();
      if (savingFails)
        vi.mocked(s.store.recordSubmission).mockRejectedValue(new Error('storage unavailable'));
      else vi.mocked(s.gateway.createPayment).mockRejectedValue(new Error('provider timeout'));
      await s.service.create(s.input).catch(() => undefined);
      await s.service.create(s.input);
      expect(s.gateway.createPayment).toHaveBeenCalledTimes(1);
      expect(s.payments.confirmPayment).not.toHaveBeenCalled();
      if (!savingFails) expect(s.order.state).toBe('unknown');
    }
  });
  it('only verified, correctly bound success invokes accounting, and late success remains acceptable', async () => {
    const s = setup();
    s.order.expiresAt = new Date(0);
    vi.mocked(s.gateway.verifyPaymentNotification).mockImplementationOnce(() => {
      throw new InvalidPaymentNotificationError();
    });
    await expect(s.service.notify({})).rejects.toBeInstanceOf(InvalidPaymentNotificationError);
    expect(s.store.findNotification).not.toHaveBeenCalled();
    for (const patch of [
      { amountCents: 301n },
      { merchantNo: 'other' },
      { attach: randomUUID() },
      { tradeType: '2' },
    ]) {
      vi.mocked(s.gateway.verifyPaymentNotification).mockReturnValueOnce({
        ...s.notification,
        ...patch,
      });
      await expect(s.service.notify({})).rejects.toBeInstanceOf(ChannelConflictError);
    }
    expect(s.payments.confirmPayment).not.toHaveBeenCalled();
    vi.mocked(s.gateway.verifyPaymentNotification).mockReturnValueOnce({
      ...s.notification,
      resultCode: 'PAY_IN_PROCESS',
    });
    expect(await s.service.notify({})).toBe('recorded');
    expect(s.payments.confirmPayment).not.toHaveBeenCalled();
    expect(await s.service.notify({})).toBe('completed');
    expect(s.payments.confirmPayment).toHaveBeenCalledWith({
      paymentRequestId: s.order.paymentId,
      amountCents: 300,
      channelTransactionId: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
  it('reconciles only leased orders and does not count channel success as accounting completion', async () => {
    const s = setup();
    vi.mocked(s.payments.confirmPayment).mockRejectedValue(new Error('database unavailable'));
    expect(await s.service.reconcile()).toEqual({ queried: 1, failed: 1 });
    expect(s.gateway.queryPayment).toHaveBeenCalledWith(
      expect.objectContaining({ payTraceNo: 'trace', amountCents: 300n }),
    );
    expect(s.store.leaseQueries).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 20,
        environment: 'test',
        institutionNo: 'inst',
        merchantNo: 'merchant',
      }),
    );
  });
  it('never exposes private channel identity and hides expired or completed QR actions', () => {
    const s = setup();
    s.order.state = 'pending';
    s.order.qrContent = 'private-qr';
    s.order.actionExpiresAt = new Date(Date.now() + 1000);
    expect(channelCheckoutView(s.order)).toHaveProperty('qrContent', 'private-qr');
    expect(channelCheckoutView(s.order)).not.toHaveProperty('payTraceNo');
    expect(channelCheckoutView(s.order, new Date(Date.now() + 2000))).not.toHaveProperty(
      'qrContent',
    );
    s.order.completed = true;
    expect(channelCheckoutView(s.order)).toMatchObject({ status: 'completed' });
    expect(channelCheckoutView(s.order)).not.toHaveProperty('qrContent');
  });
});
