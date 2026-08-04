import { describe, expect, it, vi } from 'vitest';
import {
  CreateRechargeOrderSchema,
  getRechargeOrderByIntentHandler,
} from '../modules/billing/handlers.js';

describe('CreateRechargeOrderSchema boundary', () => {
  const base = {
    rechargeIntentId: '00000000-0000-4000-8000-000000000002',
    packageId: 'starter',
  };

  it('rejects the legacy aggregate_qr channel', () => {
    const parsed = CreateRechargeOrderSchema.safeParse({
      ...base,
      channel: 'aggregate_qr',
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

  it.each(['wechat', 'alipay'] as const)('accepts a QR order with payType %s', (payType) => {
    const parsed = CreateRechargeOrderSchema.safeParse({
      ...base,
      channel: 'qr',
      payType,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an H5 order with a payment brand', () => {
    const parsed = CreateRechargeOrderSchema.safeParse({
      ...base,
      channel: 'h5',
      payType: 'alipay',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('billing HTTP handlers', () => {
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
