import { describe, expect, it } from 'vitest';
import { ApiError } from './client.js';
import { rechargeOrderRefetchInterval } from './billing.js';
import { readRechargeRequired } from './runtime.js';

const USAGE_ID = '11111111-1111-4111-8111-111111111111';

describe('runtime billing response contracts', () => {
  it('accepts a strict 402 only when it belongs to the submitted usageId', () => {
    const responseBody = {
      rechargeRequired: true,
      rechargeIntentId: USAGE_ID,
      balanceCents: '0',
      requiredCents: '100',
    };
    expect(
      readRechargeRequired(new ApiError('充值', 402, undefined, responseBody), USAGE_ID),
    ).toEqual(responseBody);
    expect(
      readRechargeRequired(
        new ApiError('充值', 402, undefined, {
          ...responseBody,
          rechargeIntentId: '22222222-2222-4222-8222-222222222222',
        }),
        USAGE_ID,
      ),
    ).toBeNull();
  });

  it('stops credited polling and keeps a low-frequency watch for late terminal success', () => {
    expect(rechargeOrderRefetchInterval('credited')).toBe(false);
    expect(rechargeOrderRefetchInterval('failed')).toBe(30_000);
    expect(rechargeOrderRefetchInterval('closed')).toBe(30_000);
    expect(rechargeOrderRefetchInterval('succeeded')).toBe(2_500);
    expect(rechargeOrderRefetchInterval('unknown')).toBe(2_500);
    expect(rechargeOrderRefetchInterval('unknown', false)).toBe(30_000);
  });
});
