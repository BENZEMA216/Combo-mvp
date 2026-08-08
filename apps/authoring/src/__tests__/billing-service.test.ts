import { describe, expect, it, vi } from 'vitest';
import type { BillingConfiguration } from '../platform/config/env.js';
import {
  LeshouyingPaymentGateway,
  signPaymentParameters,
  type CreatePaymentCommand,
  type PaymentGateway,
  type PaymentQueryResult,
  type PaymentSubmission,
  type VerifiedPaymentNotification,
} from '../platform/infra/leshouying/index.js';
import {
  createRechargeOrder,
  getRechargeOrderByIntentWithReconciliation,
  getRechargeOrderWithReconciliation,
  handlePaymentNotification,
  type BillingServiceClock,
} from '../modules/billing/service.js';
import {
  BillingIdempotencyConflictError,
  BillingValidationError,
  type BillingRepository,
  type LeasedRechargeOrder,
  type PrepareRechargeInput,
  type PrepareRechargeResult,
  type RechargeOrder,
  type WalletBalance,
} from '../modules/billing/types.js';

const OWNER_ID = '00000000-0000-4000-8000-000000000001';
const INTENT_ID = '00000000-0000-4000-8000-000000000002';
const ORDER_ID = '00000000-0000-4000-8000-000000000003';
const CLOCK: BillingServiceClock = {
  now: () => new Date('2026-07-28T04:00:00.000Z'),
  randomHex: () => '0123456789abcdef',
};
const CONFIGURATION: BillingConfiguration = {
  gatewayEnabled: true,
  submissionRecoveryMs: 10_000,
};

class MemoryBillingRepository implements BillingRepository {
  order: RechargeOrder | null = null;
  wallet: WalletBalance = { availableCents: 0n, reservedCents: 0n };
  rejectedCallbacks = 0;
  private readonly callbackFingerprints = new Map<string, 'processed' | 'rejected'>();

  async getWallet(): Promise<WalletBalance> {
    return this.wallet;
  }

  async findRechargeOrder(ownerUserId: string, orderId: string): Promise<RechargeOrder | null> {
    return this.order?.ownerUserId === ownerUserId && this.order.id === orderId ? this.order : null;
  }

  async findRechargeOrderByIntent(
    ownerUserId: string,
    clientIdempotencyKey: string,
  ): Promise<RechargeOrder | null> {
    return this.order?.ownerUserId === ownerUserId &&
      this.order.clientIdempotencyKey === clientIdempotencyKey
      ? this.order
      : null;
  }

  async prepareRecharge(input: PrepareRechargeInput): Promise<PrepareRechargeResult> {
    if (this.order) {
      if (
        this.order.clientIdempotencyKey !== input.clientIdempotencyKey ||
        this.order.requestFingerprint !== input.requestFingerprint
      ) {
        throw new BillingIdempotencyConflictError();
      }
      return { order: this.order, shouldSubmit: false, created: false };
    }
    const now = CLOCK.now();
    this.order = {
      id: ORDER_ID,
      orderNo: input.orderNo,
      ownerUserId: input.ownerUserId,
      clientIdempotencyKey: input.clientIdempotencyKey,
      packageId: input.packageId,
      amountCents: input.amountCents,
      paymentMethod: input.paymentMethod,
      gatewayEnvironment: input.gatewayEnvironment,
      institutionNo: input.institutionNo,
      merchantNo: input.merchantNo,
      payTraceNo: input.payTraceNo,
      payTime: input.payTime,
      paymentStatus: 'created',
      creditStatus: 'uncredited',
      attemptNo: 1,
      requestFingerprint: input.requestFingerprint,
      createdAt: now,
      updatedAt: now,
      reconciliationActive: true,
    };
    return { order: this.order, shouldSubmit: true, created: true };
  }

  async recordSubmission(
    _orderId: string,
    _attemptNo: number,
    submission: PaymentSubmission,
  ): Promise<RechargeOrder> {
    if (!this.order) throw new Error('missing order');
    // 模拟 PG 的单调终态 fence：先到的回调不得被迟到的预下单结果降级。
    if (this.order.creditStatus === 'credited') return this.order;
    if (
      this.order.platformTradeNo !== undefined &&
      submission.platformTradeNo !== undefined &&
      this.order.platformTradeNo !== submission.platformTradeNo
    ) {
      return this.order;
    }
    const acceptsSubmissionState = this.order.paymentStatus === 'created';
    this.order = {
      ...this.order,
      paymentStatus: acceptsSubmissionState ? submission.status : this.order.paymentStatus,
      reconciliationActive: acceptsSubmissionState
        ? submission.status === 'pending' || submission.status === 'unknown'
        : this.order.reconciliationActive,
      ...(submission.platformTradeNo ? { platformTradeNo: submission.platformTradeNo } : {}),
      ...(submission.action ? { action: submission.action } : {}),
      updatedAt: CLOCK.now(),
    };
    return this.order;
  }

  async recordSignedRejectedCallback(): Promise<void> {
    this.rejectedCallbacks += 1;
  }

  async clearExpiredPaymentActions(): Promise<number> {
    return 0;
  }

  async retireExpiredReconciliations(): Promise<number> {
    return 0;
  }

  async processNotification(
    notification: VerifiedPaymentNotification,
  ): Promise<'processed' | 'duplicate' | 'rejected'> {
    const previous = this.callbackFingerprints.get(notification.eventFingerprint);
    if (previous) return previous === 'processed' ? 'duplicate' : 'rejected';
    const order = this.order;
    const valid =
      order !== null &&
      order.payTraceNo === notification.payTraceNo &&
      order.payTime === notification.payTime &&
      order.gatewayEnvironment === notification.gatewayEnvironment &&
      order.institutionNo === notification.institutionNo &&
      order.merchantNo === notification.merchantNo &&
      order.amountCents === notification.amountCents &&
      (!notification.attach || notification.attach === order.orderNo) &&
      notification.returnCode === 'SUCCESS' &&
      ['PAY_SUCCESS', 'PAY_FAIL', 'PAY_IN_PROCESS'].includes(notification.resultCode) &&
      (!notification.tradeType || notification.tradeType === '1');
    if (!valid || !order) {
      this.callbackFingerprints.set(notification.eventFingerprint, 'rejected');
      return 'rejected';
    }
    if (notification.resultCode !== 'PAY_SUCCESS') {
      this.order = {
        ...order,
        paymentStatus: notification.resultCode === 'PAY_FAIL' ? 'failed' : 'pending',
        reconciliationActive: notification.resultCode !== 'PAY_FAIL',
        platformTradeNo: notification.platformTradeNo,
        updatedAt: CLOCK.now(),
      };
      this.callbackFingerprints.set(notification.eventFingerprint, 'processed');
      return 'processed';
    }
    if (order.creditStatus !== 'credited') {
      this.wallet = {
        ...this.wallet,
        availableCents: this.wallet.availableCents + order.amountCents,
      };
    }
    this.order = {
      ...order,
      paymentStatus: 'succeeded',
      creditStatus: 'credited',
      platformTradeNo: notification.platformTradeNo,
      paidAt: notification.paidAt ?? CLOCK.now(),
      creditedAt: CLOCK.now(),
      updatedAt: CLOCK.now(),
      reconciliationActive: false,
    };
    this.callbackFingerprints.set(notification.eventFingerprint, 'processed');
    return 'processed';
  }

  async leaseDueRechargeOrders(input: { leaseOwner: string }): Promise<LeasedRechargeOrder[]> {
    return this.order &&
      (this.order.paymentStatus === 'pending' || this.order.paymentStatus === 'unknown')
      ? [{ ...this.order, queryLeaseOwner: input.leaseOwner }]
      : [];
  }

  async leaseRechargeOrderForOwner(input: {
    ownerUserId: string;
    orderId: string;
    leaseOwner: string;
  }): Promise<LeasedRechargeOrder | null> {
    return this.order &&
      this.order.ownerUserId === input.ownerUserId &&
      this.order.id === input.orderId &&
      (this.order.paymentStatus === 'pending' || this.order.paymentStatus === 'unknown')
      ? { ...this.order, queryLeaseOwner: input.leaseOwner }
      : null;
  }

  async applyQueryResult(_leased: LeasedRechargeOrder, result: PaymentQueryResult): Promise<void> {
    if (!this.order) return;
    if (result.status === 'succeeded' && result.platformTradeNo) {
      if (this.order.creditStatus !== 'credited') {
        this.wallet = {
          ...this.wallet,
          availableCents: this.wallet.availableCents + this.order.amountCents,
        };
      }
      this.order = {
        ...this.order,
        paymentStatus: 'succeeded',
        creditStatus: 'credited',
        platformTradeNo: result.platformTradeNo,
        paidAt: result.paidAt ?? CLOCK.now(),
        creditedAt: CLOCK.now(),
        reconciliationActive: false,
      };
      return;
    }
    this.order = {
      ...this.order,
      paymentStatus: result.status === 'succeeded' ? 'unknown' : result.status,
      reconciliationActive: result.status !== 'failed',
    };
  }
}

function fakeGateway(input?: {
  create?: PaymentSubmission | Error;
  query?: PaymentQueryResult | Error;
}): PaymentGateway {
  const createPayment = vi.fn(
    async (_command: CreatePaymentCommand): Promise<PaymentSubmission> => {
      if (input?.create instanceof Error) throw input.create;
      if (input?.create) return input.create;
      return {
        status: 'pending',
        action: {
          kind: 'code_url',
          value: 'weixin://wxpay/opaque',
          expiresAt: new Date(CLOCK.now().getTime() + 15 * 60 * 1_000),
        },
      };
    },
  );
  const queryPayment = vi.fn(async (): Promise<PaymentQueryResult> => {
    if (input?.query instanceof Error) throw input.query;
    return input?.query ?? { status: 'pending' };
  });
  return {
    configured: true,
    environment: 'test',
    institutionNo: 'INST0001',
    merchantNo: 'MCH_TEST_001',
    createPayment,
    queryPayment,
    verifyPaymentNotification: vi.fn(),
  };
}

describe('billing recharge service', () => {
  it('creates QR actions from the submitted amount only', async () => {
    const repository = new MemoryBillingRepository();
    const gateway = fakeGateway();
    const result = await createRechargeOrder(
      repository,
      gateway,
      CONFIGURATION,
      {
        ownerUserId: OWNER_ID,
        rechargeIntentId: INTENT_ID,
        amountCents: 300n,
        channel: 'qr',
        payType: 'alipay',
      },
      CLOCK,
    );
    expect(result.order).toMatchObject({
      packageId: 'manual',
      amountCents: 300n,
      paymentMethod: 'qr',
      action: { kind: 'code_url' },
    });
    expect(gateway.createPayment).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 300n, channel: 'qr', payType: 'alipay' }),
    );
  });

  it('rejects a QR order without a payment brand', async () => {
    const repository = new MemoryBillingRepository();
    const gateway = fakeGateway();
    const missingPayType = {
      ownerUserId: OWNER_ID,
      rechargeIntentId: INTENT_ID,
      amountCents: 100n,
      channel: 'qr' as const,
      // 运行时校验必须拦截缺 payType 的输入（类型层强制，这里显式绕过编译期检查）。
    } as unknown as Parameters<typeof createRechargeOrder>[3];
    await expect(
      createRechargeOrder(repository, gateway, CONFIGURATION, missingPayType, CLOCK),
    ).rejects.toBeInstanceOf(BillingValidationError);
    expect(gateway.createPayment).not.toHaveBeenCalled();
  });

  it('never repeats a gateway POST for the same non-terminal intent', async () => {
    const repository = new MemoryBillingRepository();
    const gateway = fakeGateway();
    const input = {
      ownerUserId: OWNER_ID,
      rechargeIntentId: INTENT_ID,
      amountCents: 100n,
      channel: 'qr' as const,
      payType: 'alipay' as const,
    };
    await createRechargeOrder(repository, gateway, CONFIGURATION, input, CLOCK);
    await createRechargeOrder(repository, gateway, CONFIGURATION, input, CLOCK);
    expect(gateway.createPayment).toHaveBeenCalledTimes(1);
  });

  it('does not query or re-POST while the original gateway POST is still in flight', async () => {
    const repository = new MemoryBillingRepository();
    const gateway = fakeGateway();
    let releasePost!: () => void;
    const postMayFinish = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    vi.mocked(gateway.createPayment).mockImplementationOnce(async () => {
      await postMayFinish;
      return {
        status: 'pending',
        action: {
          kind: 'code_url',
          value: 'weixin://wxpay/slow-original-post',
          expiresAt: new Date(CLOCK.now().getTime() + 15 * 60 * 1_000),
        },
      };
    });
    const input = {
      ownerUserId: OWNER_ID,
      rechargeIntentId: INTENT_ID,
      amountCents: 100n,
      channel: 'qr' as const,
      payType: 'alipay' as const,
    };

    const first = createRechargeOrder(repository, gateway, CONFIGURATION, input, CLOCK);
    await vi.waitFor(() => expect(gateway.createPayment).toHaveBeenCalledTimes(1));
    const repeated = await createRechargeOrder(repository, gateway, CONFIGURATION, input, CLOCK);

    expect(repeated).toMatchObject({ created: false, submitted: false });
    expect(repeated.order.paymentStatus).toBe('created');
    expect(gateway.createPayment).toHaveBeenCalledTimes(1);
    expect(gateway.queryPayment).not.toHaveBeenCalled();

    releasePost();
    await expect(first).resolves.toMatchObject({ submitted: true });
  });

  it('recovers an existing order by owner-scoped recharge intent', async () => {
    const repository = new MemoryBillingRepository();
    const gateway = fakeGateway();
    const created = await createRechargeOrder(
      repository,
      gateway,
      CONFIGURATION,
      {
        ownerUserId: OWNER_ID,
        rechargeIntentId: INTENT_ID,
        amountCents: 100n,
        channel: 'qr',
        payType: 'alipay',
      },
      CLOCK,
    );
    await expect(
      getRechargeOrderByIntentWithReconciliation(repository, gateway, {
        ownerUserId: OWNER_ID,
        rechargeIntentId: INTENT_ID,
        leaseOwner: 'intent-recovery',
      }),
    ).resolves.toMatchObject({ id: created.order.id });
    await expect(
      getRechargeOrderByIntentWithReconciliation(repository, gateway, {
        ownerUserId: '00000000-0000-4000-8000-000000000099',
        rechargeIntentId: INTENT_ID,
        leaseOwner: 'wrong-owner',
      }),
    ).resolves.toBeNull();
  });

  it('turns a gateway timeout into unknown and queries the original trace during polling', async () => {
    const repository = new MemoryBillingRepository();
    const gateway = fakeGateway({
      create: new Error('test timeout'),
      query: {
        status: 'succeeded',
        gatewayResultCode: 'PAY_SUCCESS',
        platformTradeNo: 'TRADE-QUERY-1',
      },
    });
    const created = await createRechargeOrder(
      repository,
      gateway,
      CONFIGURATION,
      {
        ownerUserId: OWNER_ID,
        rechargeIntentId: INTENT_ID,
        amountCents: 300n,
        channel: 'qr',
        payType: 'alipay',
      },
      CLOCK,
    );
    expect(created.order.paymentStatus).toBe('unknown');

    const reconciled = await getRechargeOrderWithReconciliation(repository, gateway, {
      ownerUserId: OWNER_ID,
      orderId: ORDER_ID,
      leaseOwner: 'test-query',
    });
    expect(gateway.createPayment).toHaveBeenCalledTimes(1);
    expect(gateway.queryPayment).toHaveBeenCalledWith({
      payTraceNo: created.order.payTraceNo,
      payTime: created.order.payTime,
      amountCents: 300n,
    });
    expect(reconciled.creditStatus).toBe('credited');
    expect(repository.wallet.availableCents).toBe(300n);
  });

  it('does not consume query leases while the configured gateway is unavailable', async () => {
    const repository = new MemoryBillingRepository();
    const gateway = fakeGateway({ create: new Error('test timeout') });
    const created = await createRechargeOrder(
      repository,
      gateway,
      CONFIGURATION,
      {
        ownerUserId: OWNER_ID,
        rechargeIntentId: INTENT_ID,
        amountCents: 100n,
        channel: 'qr',
        payType: 'alipay',
      },
      CLOCK,
    );
    const lease = vi.spyOn(repository, 'leaseRechargeOrderForOwner');
    const disabled = { ...gateway, configured: false } as PaymentGateway;

    await expect(
      getRechargeOrderWithReconciliation(repository, disabled, {
        ownerUserId: OWNER_ID,
        orderId: created.order.id,
        leaseOwner: 'disabled-gateway',
      }),
    ).resolves.toMatchObject({ id: created.order.id, paymentStatus: 'unknown' });
    expect(lease).not.toHaveBeenCalled();
    expect(gateway.queryPayment).not.toHaveBeenCalled();
  });

  it('credits once and rejects signed ownership/amount mismatches or invalid signatures', async () => {
    const repository = new MemoryBillingRepository();
    const submissionGateway = fakeGateway();
    const created = await createRechargeOrder(
      repository,
      submissionGateway,
      CONFIGURATION,
      {
        ownerUserId: OWNER_ID,
        rechargeIntentId: INTENT_ID,
        amountCents: 300n,
        channel: 'qr',
        payType: 'alipay',
      },
      CLOCK,
    );
    const key = 'test-only-institution-key';
    const callbackGateway = new LeshouyingPaymentGateway(
      {
        environment: 'TEST',
        institutionNo: 'INST0001',
        merchantNo: 'MCH_TEST_001',
        institutionKey: key,
        notifyUrl: 'https://api.example.test/api/v1/billing/leshouying/payment-notify',
        timeoutMs: 1_000,
      },
      vi.fn(),
    );
    const fields = {
      return_code: 'SUCCESS',
      result_code: 'PAY_SUCCESS',
      inst_no: 'INST0001',
      mch_no: 'MCH_TEST_001',
      pay_trace_no: created.order.payTraceNo,
      pay_time: created.order.payTime,
      total_amount: '300',
      trade_no: 'TRADE-CALLBACK-1',
      trade_type: '1',
      attach: created.order.orderNo,
    };
    const callback = { ...fields, sign: signPaymentParameters(fields, key) };
    await expect(handlePaymentNotification(repository, callbackGateway, callback)).resolves.toBe(
      'processed',
    );
    await expect(handlePaymentNotification(repository, callbackGateway, callback)).resolves.toBe(
      'duplicate',
    );
    expect(repository.wallet.availableCents).toBe(300n);

    const wrongAmountFields = {
      ...fields,
      total_amount: '301',
      trade_no: 'TRADE-CALLBACK-2',
    };
    await expect(
      handlePaymentNotification(repository, callbackGateway, {
        ...wrongAmountFields,
        sign: signPaymentParameters(wrongAmountFields, key),
      }),
    ).resolves.toBe('rejected');
    expect(repository.wallet.availableCents).toBe(300n);

    const ownershipMismatchFields = [
      {
        ...fields,
        mch_no: 'OTHER_MERCHANT',
        trade_no: 'TRADE-CALLBACK-3',
      },
      {
        ...fields,
        inst_no: 'OTHER_INSTITUTION',
        trade_no: 'TRADE-CALLBACK-4',
      },
    ];
    for (const mismatchedFields of ownershipMismatchFields) {
      await expect(
        handlePaymentNotification(repository, callbackGateway, {
          ...mismatchedFields,
          sign: signPaymentParameters(mismatchedFields, key),
        }),
      ).resolves.toBe('rejected');
      expect(repository.wallet.availableCents).toBe(300n);
    }

    await expect(
      handlePaymentNotification(repository, callbackGateway, {
        ...fields,
        sign: '00000000000000000000000000000000',
      }),
    ).resolves.toBe('rejected');
    expect(repository.rejectedCallbacks).toBe(0);

    const signedInvalidPayload = { ...fields, trade_no: '' };
    await expect(
      handlePaymentNotification(repository, callbackGateway, {
        ...signedInvalidPayload,
        sign: signPaymentParameters(signedInvalidPayload, key),
      }),
    ).resolves.toBe('rejected');
    expect(repository.rejectedCallbacks).toBe(1);
  });

  it('does not let a late pre-order response downgrade a callback-confirmed order', async () => {
    const repository = new MemoryBillingRepository();
    const gateway = fakeGateway();
    const prepared = await repository.prepareRecharge({
      orderNo: 'CBR-RACE',
      ownerUserId: OWNER_ID,
      clientIdempotencyKey: INTENT_ID,
      packageId: 'manual',
      amountCents: 300n,
      paymentMethod: 'qr',
      payType: 'alipay',
      gatewayEnvironment: 'test',
      institutionNo: gateway.institutionNo,
      merchantNo: gateway.merchantNo,
      payTraceNo: 'TRACE-RACE',
      payTime: '20260728120000',
      requestFingerprint: 'a'.repeat(64),
      submissionRecoveryMs: 10_000,
    });
    await repository.processNotification({
      eventFingerprint: 'b'.repeat(64),
      gatewayEnvironment: 'test',
      institutionNo: gateway.institutionNo,
      merchantNo: gateway.merchantNo,
      payTraceNo: 'TRACE-RACE',
      payTime: '20260728120000',
      amountCents: 300n,
      platformTradeNo: 'TRADE-RACE',
      resultCode: 'PAY_SUCCESS',
      returnCode: 'SUCCESS',
      attach: 'CBR-RACE',
    });
    const final = await repository.recordSubmission(prepared.order.id, 1, {
      status: 'pending',
      action: {
        kind: 'code_url',
        value: 'opaque-action',
        expiresAt: new Date(CLOCK.now().getTime() + 15 * 60 * 1_000),
      },
    });
    expect(final).toMatchObject({
      paymentStatus: 'succeeded',
      creditStatus: 'credited',
      platformTradeNo: 'TRADE-RACE',
    });
    expect(repository.wallet.availableCents).toBe(300n);
  });

  it('does not let a late PAY_FAIL pre-order response stop a callback-confirmed pending order', async () => {
    const repository = new MemoryBillingRepository();
    const gateway = fakeGateway();
    const prepared = await repository.prepareRecharge({
      orderNo: 'CBR-PENDING-PRECEDENCE',
      ownerUserId: OWNER_ID,
      clientIdempotencyKey: INTENT_ID,
      packageId: 'manual',
      amountCents: 300n,
      paymentMethod: 'qr',
      payType: 'alipay',
      gatewayEnvironment: 'test',
      institutionNo: gateway.institutionNo,
      merchantNo: gateway.merchantNo,
      payTraceNo: 'TRACE-PENDING-PRECEDENCE',
      payTime: '20260728120000',
      requestFingerprint: 'c'.repeat(64),
      submissionRecoveryMs: 10_000,
    });
    await repository.processNotification({
      eventFingerprint: 'd'.repeat(64),
      gatewayEnvironment: 'test',
      institutionNo: gateway.institutionNo,
      merchantNo: gateway.merchantNo,
      payTraceNo: prepared.order.payTraceNo,
      payTime: prepared.order.payTime,
      amountCents: 300n,
      platformTradeNo: 'TRADE-PENDING-PRECEDENCE',
      resultCode: 'PAY_IN_PROCESS',
      returnCode: 'SUCCESS',
      attach: prepared.order.orderNo,
    });

    await expect(
      repository.recordSubmission(prepared.order.id, 1, {
        status: 'failed',
        gatewayResultCode: 'PAY_FAIL',
      }),
    ).resolves.toMatchObject({
      paymentStatus: 'pending',
      reconciliationActive: true,
      platformTradeNo: 'TRADE-PENDING-PRECEDENCE',
    });
  });

  it('acknowledges a trusted PAY_FAIL callback without crediting the wallet', async () => {
    const repository = new MemoryBillingRepository();
    const gateway = fakeGateway();
    const created = await createRechargeOrder(
      repository,
      gateway,
      CONFIGURATION,
      {
        ownerUserId: OWNER_ID,
        rechargeIntentId: INTENT_ID,
        amountCents: 300n,
        channel: 'qr',
        payType: 'alipay',
      },
      CLOCK,
    );
    gateway.verifyPaymentNotification = vi.fn(
      (): VerifiedPaymentNotification => ({
        eventFingerprint: 'd'.repeat(64),
        gatewayEnvironment: 'test',
        institutionNo: 'INST0001',
        merchantNo: 'MCH_TEST_001',
        payTraceNo: created.order.payTraceNo,
        payTime: created.order.payTime,
        amountCents: 300n,
        platformTradeNo: 'TRADE-FAILED',
        resultCode: 'PAY_FAIL',
        returnCode: 'SUCCESS',
        tradeType: '1',
        attach: created.order.orderNo,
      }),
    );

    await expect(
      handlePaymentNotification(repository, gateway, { signed: 'fixture' }),
    ).resolves.toBe('processed');
    expect(repository.order?.paymentStatus).toBe('failed');
    expect(repository.wallet.availableCents).toBe(0n);
  });
});
