import { describe, expect, it } from 'vitest';

import {
  CreatePaymentBodySchema,
  PAYMENT_HOST_MESSAGE_TYPE,
  PaymentApiErrorResponseSchema,
  PaymentHostMessageSchema,
  PaymentIdentifierSchema,
  PaymentRequiredResponseSchema,
  PaymentSuccessResponseSchema,
  PaymentTimestampSchema,
  PaymentViewSchema,
  paymentByIdPath,
  paymentByRequestKeyPath,
} from '../index.js';

const NOW = '2026-09-03T10:00:00.000Z';
const LATER = '2026-09-03T10:05:00.000Z';
const TOKEN = `opaque_${'payment'.repeat(2)}`;

function requirement() {
  return {
    id: 'payreq-1',
    paymentToken: TOKEN,
    amount: { currency: 'CNY', amountCents: '600' },
    expiresAt: LATER,
  } as const;
}

function payment(status: 'waiting' | 'processing' | 'completed' | 'closed' = 'waiting') {
  return {
    paymentRequestId: 'payreq-1',
    requestKey: 'request-key-1',
    status,
    amount: { currency: 'CNY', amountCents: '600' },
    expiresAt: LATER,
    createdAt: NOW,
    updatedAt: NOW,
    ...(status === 'completed' ? { completedAt: NOW } : {}),
    ...(status === 'waiting'
      ? { action: { kind: 'open_url', url: 'https://pay.combo.test/p/payreq-1', expiresAt: LATER } }
      : {}),
  };
}

describe('payment protocol', () => {
  it('parses the standard payment-required response', () => {
    expect(
      PaymentRequiredResponseSchema.parse({
        error: { code: 'payment_required', message: '余额不足' },
        data: { paymentRequirement: requirement() },
        meta: { traceId: 'trace-1' },
      }),
    ).toMatchObject({ data: { paymentRequirement: { id: 'payreq-1' } } });
  });

  it('keeps the Agent-to-Host message to exactly three safe fields', () => {
    const parsed = PaymentHostMessageSchema.parse({
      version: 1,
      type: PAYMENT_HOST_MESSAGE_TYPE,
      paymentToken: TOKEN,
    });
    expect(Object.keys(parsed)).toEqual(['version', 'type', 'paymentToken']);
    for (const extra of ['amount', 'url', 'qrCode', 'userId', 'agentId']) {
      expect(PaymentHostMessageSchema.safeParse({ ...parsed, [extra]: 'forbidden' }).success).toBe(
        false,
      );
    }
  });

  it('parses payment creation without accepting caller-owned amount or identity', () => {
    const valid = { paymentToken: TOKEN, requestKey: 'request-key-1' };
    expect(CreatePaymentBodySchema.parse(valid)).toEqual(valid);
    expect(CreatePaymentBodySchema.safeParse({ ...valid, amountCents: '1' }).success).toBe(false);
    expect(CreatePaymentBodySchema.safeParse({ ...valid, userId: 'user-1' }).success).toBe(false);
  });

  it.each(['waiting', 'processing', 'completed', 'closed'] as const)(
    'parses the %s payment state',
    (status) => {
      expect(PaymentViewSchema.parse(payment(status)).status).toBe(status);
    },
  );

  it('requires completedAt only after Combo has completed payment-side accounting', () => {
    expect(
      PaymentViewSchema.safeParse({ ...payment('completed'), completedAt: undefined }).success,
    ).toBe(false);
    expect(
      PaymentViewSchema.safeParse({ ...payment('processing'), completedAt: NOW }).success,
    ).toBe(false);
  });

  it('allows checkout actions only while waiting', () => {
    const action = payment('waiting').action;
    expect(PaymentViewSchema.safeParse({ ...payment('processing'), action }).success).toBe(false);
  });

  it('rejects unknown response fields at every public boundary', () => {
    const required = {
      error: { code: 'payment_required' },
      data: { paymentRequirement: requirement() },
      meta: { traceId: 'trace-1' },
    };
    const success = { data: payment(), meta: { traceId: 'trace-1' } };
    expect(
      PaymentRequiredResponseSchema.safeParse({ ...required, gatewaySecret: 'x' }).success,
    ).toBe(false);
    expect(
      PaymentRequiredResponseSchema.safeParse({
        ...required,
        data: { paymentRequirement: { ...requirement(), wallet: {} } },
      }).success,
    ).toBe(false);
    expect(PaymentSuccessResponseSchema.safeParse({ ...success, provider: {} }).success).toBe(
      false,
    );
    expect(PaymentViewSchema.safeParse({ ...payment(), channelOrder: 'secret' }).success).toBe(
      false,
    );
  });

  it.each(['..', '../pay', 'pay/1', 'pay\u202E1', 'pay\ud8001'])(
    'rejects unsafe identifiers: %s',
    (value) => {
      expect(PaymentIdentifierSchema.safeParse(value).success).toBe(false);
    },
  );

  it.each([
    '2026-02-30T10:00:00Z',
    '2026-13-01T10:00:00Z',
    '2026-01-01T24:00:00Z',
    '2026-01-01T10:00:60Z',
    '2026-01-01T10:00:00+08:00',
  ])('rejects invalid or non-UTC timestamps: %s', (value) => {
    expect(PaymentTimestampSchema.safeParse(value).success).toBe(false);
  });

  it('rejects log-control characters in server messages', () => {
    for (const message of ['bad\u0085message', 'bad\u202Emessage', 'bad\ud800message']) {
      expect(
        PaymentRequiredResponseSchema.safeParse({
          error: { code: 'payment_required', message },
          data: { paymentRequirement: requirement() },
          meta: { traceId: 'trace-1' },
        }).success,
      ).toBe(false);
    }
  });

  it('parses strict success and API error envelopes', () => {
    expect(
      PaymentSuccessResponseSchema.safeParse({ data: payment(), meta: { traceId: 'trace-1' } })
        .success,
    ).toBe(true);
    expect(
      PaymentApiErrorResponseSchema.safeParse({
        error: { code: 'rate_limited' },
        data: { retryAfterMs: 1_000 },
        meta: { traceId: 'trace-1' },
      }).success,
    ).toBe(true);
    expect(
      PaymentApiErrorResponseSchema.safeParse({
        error: { code: 'rate_limited' },
        data: { retryAfterMs: 1_000, internal: true },
        meta: { traceId: 'trace-1' },
      }).success,
    ).toBe(false);
  });

  it('builds only canonical encoded payment paths', () => {
    expect(paymentByIdPath('payreq-1')).toBe('/v1/payments/payreq-1');
    expect(paymentByRequestKeyPath('request-key-1')).toBe(
      '/v1/payments/by-request-key/request-key-1',
    );
    expect(() => paymentByIdPath('..')).toThrow();
  });
});
