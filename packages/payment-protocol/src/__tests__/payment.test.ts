import { describe, expect, it } from 'vitest';

import {
  CreatePaymentBodySchema,
  PAYMENT_HOST_MESSAGE_TYPE,
  PaymentActionSchema,
  PaymentApiErrorResponseSchema,
  PaymentHostMessageSchema,
  PaymentIdentifierSchema,
  PaymentMoneySchema,
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
        error: {
          userMessage: '余额不足，请完成支付后继续。',
          retriable: false,
          action: 'wait',
          traceId: 'trace-1',
          payment: requirement(),
        },
      }),
    ).toMatchObject({ error: { payment: { id: 'payreq-1' } } });
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

  it('requires a usable checkout action while waiting', () => {
    const waiting = payment('waiting');
    expect(PaymentViewSchema.safeParse({ ...waiting, action: undefined }).success).toBe(false);
    expect(
      PaymentActionSchema.safeParse({
        ...waiting.action,
        url: 'https://pay.combo.test:443/path/to/pay?token=abc%2Fdef',
      }).success,
    ).toBe(true);
    for (const url of [
      'not-a-url',
      'http:example.com',
      'HTTPS://pay.combo.test/path',
      'https://user@pay.combo.test/path',
      'https://pay.combo.test/path#fragment',
      'https://pay.combo.test:65536/path',
      'https://pay.combo.test/path?token=%zz',
      'https://支付.example/path',
      'https://pay.combo.test/path\nnext',
    ]) {
      expect(() => PaymentActionSchema.safeParse({ ...waiting.action, url })).not.toThrow();
      expect(PaymentActionSchema.safeParse({ ...waiting.action, url }).success, url).toBe(false);
    }
  });

  it('allows checkout actions only while waiting', () => {
    const action = payment('waiting').action;
    expect(PaymentViewSchema.safeParse({ ...payment('processing'), action }).success).toBe(false);
  });

  it('rejects unknown response fields at every public boundary', () => {
    const required = {
      error: {
        userMessage: '余额不足，请完成支付后继续。',
        retriable: false,
        action: 'wait',
        traceId: 'trace-1',
        payment: requirement(),
      },
    };
    const success = { data: payment(), meta: { traceId: 'trace-1' } };
    expect(
      PaymentRequiredResponseSchema.safeParse({ ...required, gatewaySecret: 'x' }).success,
    ).toBe(false);
    expect(
      PaymentRequiredResponseSchema.safeParse({
        ...required,
        error: { ...required.error, payment: { ...requirement(), wallet: {} } },
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
          error: {
            userMessage: message,
            retriable: false,
            action: 'wait',
            traceId: 'trace-1',
            payment: requirement(),
          },
        }).success,
      ).toBe(false);
    }
  });

  it('keeps payment amounts within the public 15-digit accounting range without throwing', () => {
    expect(
      PaymentMoneySchema.safeParse({
        currency: 'CNY',
        amountCents: '999999999999999',
      }).success,
    ).toBe(true);
    expect(
      PaymentMoneySchema.safeParse({ currency: 'CNY', amountCents: '1000000000000000' }).success,
    ).toBe(false);
    for (const amountCents of ['abc', '1e3', '0', '-1']) {
      expect(() => PaymentMoneySchema.safeParse({ currency: 'CNY', amountCents })).not.toThrow();
      expect(
        PaymentMoneySchema.safeParse({ currency: 'CNY', amountCents }).success,
        amountCents,
      ).toBe(false);
    }
  });

  it('rejects impossible payment timestamp ordering', () => {
    expect(
      PaymentViewSchema.safeParse({
        ...payment('processing'),
        updatedAt: '2026-09-03T09:59:59Z',
      }).success,
    ).toBe(false);
    expect(
      PaymentViewSchema.safeParse({
        ...payment('completed'),
        completedAt: '2026-09-03T10:05:01Z',
      }).success,
    ).toBe(false);
    expect(
      PaymentViewSchema.safeParse({
        ...payment('processing'),
        createdAt: '2026-09-03T10:00:00.000000001Z',
        updatedAt: '2026-09-03T10:00:00.000000000Z',
      }).success,
    ).toBe(false);
    expect(
      PaymentViewSchema.safeParse({
        ...payment('completed'),
        createdAt: '2026-09-03T10:00:00.000000000Z',
        updatedAt: '2026-09-03T10:00:00.000000001Z',
        completedAt: '2026-09-03T10:00:00.000000002Z',
      }).success,
    ).toBe(false);
  });

  it('requires a waiting action and payment to remain usable after the latest update', () => {
    expect(
      PaymentViewSchema.safeParse({
        ...payment('waiting'),
        updatedAt: '2026-09-03T10:00:00.000000001Z',
        action: {
          ...payment('waiting').action,
          expiresAt: '2026-09-03T10:00:00.000000001Z',
        },
      }).success,
    ).toBe(false);
    expect(
      PaymentViewSchema.safeParse({
        ...payment('waiting'),
        updatedAt: LATER,
      }).success,
    ).toBe(false);
  });

  it('parses strict success and API error envelopes', () => {
    expect(
      PaymentSuccessResponseSchema.safeParse({ data: payment(), meta: { traceId: 'trace-1' } })
        .success,
    ).toBe(true);
    expect(
      PaymentApiErrorResponseSchema.safeParse({
        error: {
          userMessage: '操作太频繁了，稍后再试。',
          retriable: true,
          action: 'wait',
          traceId: 'trace-1',
        },
      }).success,
    ).toBe(true);
    expect(
      PaymentApiErrorResponseSchema.safeParse({
        error: {
          userMessage: '操作太频繁了，稍后再试。',
          retriable: true,
          action: 'wait',
          traceId: 'trace-1',
          internal: true,
        },
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
