import { describe, expect, it, vi } from 'vitest';
import { getRechargeOrderByIntentHandler } from '../modules/billing/handlers.js';

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
