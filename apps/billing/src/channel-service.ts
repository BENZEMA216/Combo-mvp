import { createHash, randomUUID } from 'node:crypto';
import type { PaymentStore } from './payment-service.js';
import type {
  PaymentGateway,
  PaymentGatewayEnvironment,
  PaymentQueryResult,
  PaymentSubmission,
  PayType,
  VerifiedPaymentNotification,
} from './channel/index.js';

export interface ChannelOrder {
  paymentId: string;
  userId: string;
  amountCents: number;
  environment: PaymentGatewayEnvironment;
  institutionNo: string;
  merchantNo: string;
  payTraceNo: string;
  payTime: string;
  payType: PayType;
  state: 'submitting' | 'pending' | 'unknown' | 'failed';
  platformTradeNo?: string;
  qrContent?: string;
  actionExpiresAt?: Date;
  expiresAt: Date;
  completed: boolean;
}
export interface ChannelOrderStore {
  prepare(input: {
    paymentId: string;
    userId: string;
    payType: PayType;
    environment: PaymentGatewayEnvironment;
    institutionNo: string;
    merchantNo: string;
  }): Promise<{ order: ChannelOrder; shouldSubmit: boolean } | null>;
  get(paymentId: string, userId: string): Promise<ChannelOrder | null>;
  findNotification(notification: VerifiedPaymentNotification): Promise<ChannelOrder | null>;
  recordSubmission(order: ChannelOrder, result: PaymentSubmission): Promise<void>;
  recordResult(
    order: ChannelOrder,
    result: PaymentQueryResult,
    eventFingerprint: string,
    source: 'callback' | 'query',
  ): Promise<boolean>;
  leaseQueries(input: {
    owner: string;
    limit: number;
    environment: PaymentGatewayEnvironment;
    institutionNo: string;
    merchantNo: string;
  }): Promise<ChannelOrder[]>;
}

export class ChannelConflictError extends Error {
  constructor() {
    super('payment channel order conflicts with its original request');
    this.name = 'ChannelConflictError';
  }
}
export class ChannelUnavailableError extends Error {
  constructor() {
    super('payment channel temporarily unavailable');
    this.name = 'ChannelUnavailableError';
  }
}

export function createPaymentChannelService(options: {
  store: ChannelOrderStore;
  payments: Pick<PaymentStore, 'confirmPayment'>;
  gateway: PaymentGateway;
}) {
  const { store, payments, gateway } = options;
  const scope = {
    environment: gateway.environment,
    institutionNo: gateway.institutionNo,
    merchantNo: gateway.merchantNo,
  };
  function matches(order: ChannelOrder) {
    return (
      order.environment === scope.environment &&
      order.institutionNo === scope.institutionNo &&
      order.merchantNo === scope.merchantNo
    );
  }
  async function confirm(
    order: ChannelOrder,
    result: PaymentQueryResult,
    event: string,
    source: 'callback' | 'query',
  ) {
    if (!matches(order) || !(await store.recordResult(order, result, event, source)))
      throw new ChannelConflictError();
    if (result.status !== 'succeeded') return;
    if (!result.platformTradeNo) throw new ChannelConflictError();
    // Channel transaction identity is namespaced before entering the single accounting transaction.
    const channelTransactionId = createHash('sha256')
      .update(
        JSON.stringify([
          scope.environment,
          scope.institutionNo,
          scope.merchantNo,
          result.platformTradeNo,
        ]),
      )
      .digest('hex');
    const confirmed = await payments.confirmPayment({
      paymentRequestId: order.paymentId,
      channelTransactionId,
      amountCents: order.amountCents,
    });
    if (confirmed.kind !== 'completed') throw new ChannelConflictError();
  }
  return {
    async create(input: { paymentId: string; userId: string; payType: PayType }) {
      if (!gateway.configured) throw new ChannelUnavailableError();
      const prepared = await store.prepare({ ...input, ...scope });
      if (!prepared) return null;
      const order = prepared.order;
      if (!matches(order) || order.payType !== input.payType) throw new ChannelConflictError();
      if (prepared.shouldSubmit) {
        let result: PaymentSubmission;
        try {
          result = await gateway.createPayment({
            orderNo: order.paymentId,
            payTraceNo: order.payTraceNo,
            payTime: order.payTime,
            amountCents: BigInt(order.amountCents),
            channel: 'qr',
            payType: order.payType,
          });
        } catch {
          result = { status: 'unknown' };
        }
        // Failure to save a response still leaves the original pre-dispatch row. No resubmission.
        await store.recordSubmission(order, result);
      }
      return store.get(order.paymentId, input.userId);
    },
    get: (paymentId: string, userId: string) => store.get(paymentId, userId),
    async notify(input: unknown): Promise<'completed' | 'recorded'> {
      const notification = gateway.verifyPaymentNotification(input);
      if (
        notification.institutionNo !== scope.institutionNo ||
        notification.merchantNo !== scope.merchantNo ||
        notification.gatewayEnvironment !== scope.environment ||
        (notification.tradeType !== undefined && notification.tradeType !== '1')
      )
        throw new ChannelConflictError();
      const order = await store.findNotification(notification);
      if (
        !order ||
        BigInt(order.amountCents) !== notification.amountCents ||
        (notification.attach && notification.attach !== order.paymentId)
      )
        throw new ChannelConflictError();
      const status =
        notification.returnCode === 'SUCCESS' && notification.resultCode === 'PAY_SUCCESS'
          ? 'succeeded'
          : notification.resultCode === 'PAY_FAIL'
            ? 'failed'
            : 'pending';
      await confirm(
        order,
        { status, platformTradeNo: notification.platformTradeNo },
        notification.eventFingerprint,
        'callback',
      );
      return status === 'succeeded' ? 'completed' : 'recorded';
    },
    async reconcile(limit = 20): Promise<{ queried: number; failed: number }> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
        throw new ChannelUnavailableError();
      if (!gateway.configured) return { queried: 0, failed: 0 };
      const rows = await store.leaseQueries({ owner: randomUUID(), limit, ...scope });
      let failed = 0;
      for (const order of rows) {
        try {
          const result = await gateway.queryPayment({
            payTraceNo: order.payTraceNo,
            payTime: order.payTime,
            amountCents: BigInt(order.amountCents),
            ...(order.platformTradeNo ? { platformTradeNo: order.platformTradeNo } : {}),
          });
          const event = createHash('sha256')
            .update(JSON.stringify([order.paymentId, randomUUID()]))
            .digest('hex');
          await confirm(order, result, event, 'query');
        } catch {
          failed++;
        }
      }
      return { queried: rows.length, failed };
    },
  };
}

/** Only the authenticated Combo checkout may see this view; Agent handoff remains three fields. */
export function channelCheckoutView(order: ChannelOrder, now = new Date()) {
  const status = order.completed ? 'completed' : order.expiresAt <= now ? 'closed' : order.state;
  return {
    paymentRequestId: order.paymentId,
    status,
    amount: { currency: 'CNY', amountCents: String(order.amountCents) },
    payType: order.payType,
    ...(status === 'pending' &&
    order.qrContent &&
    order.actionExpiresAt &&
    order.actionExpiresAt > now
      ? { qrContent: order.qrContent, expiresAt: order.actionExpiresAt.toISOString() }
      : {}),
  };
}
