import { describe, expect, it, vi } from 'vitest';
import {
  CreateRechargeOrderSchema,
  getRechargeOrderByIntentHandler,
  getRechargeOrderByRecoveryHandler,
} from '../modules/billing/handlers.js';

describe('CreateRechargeOrderSchema boundary', () => {
  const base = {
    recoveryUsageId: '00000000-0000-4000-8000-000000000001',
    rechargeIntentId: '00000000-0000-4000-8000-000000000002',
    amountCents: 100,
  };

  it('rejects the legacy aggregate_qr channel', () => {
    const parsed = CreateRechargeOrderSchema.safeParse({
      ...base,
      channel: 'aggregate_qr',
      payType: 'wechat',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects the removed H5 channel', () => {
    const parsed = CreateRechargeOrderSchema.safeParse({
      ...base,
      channel: 'h5',
      payType: 'wechat',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a QR order without a payment brand', () => {
    const parsed = CreateRechargeOrderSchema.safeParse({
      ...base,
      channel: 'qr',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an order without an explicit amount', () => {
    const parsed = CreateRechargeOrderSchema.safeParse({
      recoveryUsageId: base.recoveryUsageId,
      rechargeIntentId: base.rechargeIntentId,
      channel: 'qr',
      payType: 'wechat',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts the existing UI order shape without a recovery usage', () => {
    expect(
      CreateRechargeOrderSchema.parse({
        rechargeIntentId: base.rechargeIntentId,
        amountCents: base.amountCents,
        channel: 'qr',
        payType: 'alipay',
      }),
    ).toEqual({
      rechargeIntentId: base.rechargeIntentId,
      amountCents: base.amountCents,
      channel: 'qr',
      payType: 'alipay',
    });
  });

  it('rejects an amount outside the allowed range', () => {
    const parsed = CreateRechargeOrderSchema.safeParse({
      ...base,
      amountCents: 100_000_000,
      channel: 'qr',
      payType: 'wechat',
    });
    expect(parsed.success).toBe(false);
  });

  it.each(['wechat', 'alipay'] as const)('accepts a QR order with payType %s', (payType) => {
    const parsed = CreateRechargeOrderSchema.safeParse({
      ...base,
      channel: 'qr',
      payType,
    });
    expect(parsed.success).toBe(true);
  });
});

describe('billing HTTP handlers', () => {
  it('returns null without cross-owner leakage when no order is linked to the recovery', async () => {
    const ownerUserId = '00000000-0000-4000-8000-000000000001';
    const recoveryUsageId = '00000000-0000-4000-8000-000000000004';
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const reply = {
      statusCode: 200,
      body: undefined as unknown,
      code(statusCode: number) {
        this.statusCode = statusCode;
        return this;
      },
      send(body: unknown) {
        this.body = body;
        return this;
      },
    };
    const request = {
      id: 'trace-billing-recovery-missing',
      auth: { userId: ownerUserId },
      params: { recoveryUsageId },
      log: { error: vi.fn() },
      server: {
        infra: {
          db: { query, connect: vi.fn() },
          paymentGateway: { configured: false },
        },
      },
    };

    await getRechargeOrderByRecoveryHandler().call({} as never, request as never, reply as never);

    expect(reply.body).toEqual({ data: null, meta: { traceId: 'trace-billing-recovery-missing' } });
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/ro[.]recovery_usage_id = \$2[\s\S]*pending_usage_recoveries/u),
      [ownerUserId, recoveryUsageId],
    );
  });

  it('returns an ordinary null result when an owner has no order for the recharge intent', async () => {
    const ownerUserId = '00000000-0000-4000-8000-000000000001';
    const rechargeIntentId = '00000000-0000-4000-8000-000000000002';
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const reply = {
      statusCode: 200,
      body: undefined as unknown,
      code(statusCode: number) {
        this.statusCode = statusCode;
        return this;
      },
      send(body: unknown) {
        this.body = body;
        return this;
      },
    };
    const request = {
      id: 'trace-billing-intent-missing',
      auth: { userId: ownerUserId },
      params: { rechargeIntentId },
      log: { error: vi.fn() },
      server: {
        infra: {
          db: { query, connect: vi.fn() },
          paymentGateway: { configured: false },
        },
      },
    };

    await getRechargeOrderByIntentHandler().call({} as never, request as never, reply as never);

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({
      data: null,
      meta: {
        traceId: 'trace-billing-intent-missing',
      },
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ro.owner_user_id = $1'), [
      ownerUserId,
      rechargeIntentId,
    ]);
  });
});
