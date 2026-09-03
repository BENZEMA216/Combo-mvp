import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as addFormatsModule from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import {
  PAYMENT_BY_ID_PATH,
  PAYMENT_BY_REQUEST_KEY_PATH,
  PAYMENT_COLLECTION_PATH,
  PAYMENT_ACTION_URL_PATTERN_SOURCE,
  PAYMENT_AMOUNT_CENTS_MAX_DIGITS,
  PAYMENT_AMOUNT_CENTS_PATTERN_SOURCE,
  PAYMENT_SAFE_MESSAGE_PATTERN_SOURCE,
  PAYMENT_TIMESTAMP_PATTERN_SOURCE,
  PaymentActionSchema,
  PaymentApiErrorResponseSchema,
  PaymentHostMessageSchema,
  PaymentMoneySchema,
  PaymentRequiredResponseSchema,
  PaymentSafeMessageSchema,
  PaymentTimestampSchema,
  PaymentViewSchema,
} from '../index.js';

interface OpenApiSchema {
  additionalProperties?: boolean;
  maxLength?: number;
  oneOf?: unknown[];
  pattern?: string;
  properties?: Record<string, OpenApiSchema & { const?: unknown; enum?: unknown[] }>;
  required?: string[];
  [key: `x-${string}`]: unknown;
}

interface OpenApiOperation {
  responses: Record<string, unknown>;
}

interface OpenApiPath {
  get?: OpenApiOperation;
  post?: OpenApiOperation;
}

interface PaymentOpenApiDocument {
  security: Array<Record<string, unknown>>;
  paths: Record<string, OpenApiPath>;
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, OpenApiSchema>;
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const document = JSON.parse(
  readFileSync(resolve(here, '../../openapi/payment-v1.openapi.json'), 'utf8'),
) as PaymentOpenApiDocument;

const paymentToken = `opaque_${'payment'.repeat(2)}`;
const ajv = new Ajv2020({ strict: false, unicodeRegExp: true });
const addFormats = addFormatsModule.default as unknown as FormatsPlugin;
addFormats(ajv);

describe('payment OpenAPI', () => {
  it('publishes only the three first-version payment endpoints', () => {
    expect(Object.keys(document.paths).sort()).toEqual(
      [
        PAYMENT_COLLECTION_PATH,
        PAYMENT_BY_REQUEST_KEY_PATH.replace(':requestKey', '{requestKey}'),
        PAYMENT_BY_ID_PATH.replace(':paymentRequestId', '{paymentRequestId}'),
      ].sort(),
    );
    expect(Object.keys(document.paths[PAYMENT_COLLECTION_PATH] ?? {})).toEqual(['post']);
  });

  it('covers uncertain create failures and a default fail-closed response', () => {
    const responses = document.paths[PAYMENT_COLLECTION_PATH]?.post?.responses;
    expect(responses).toBeDefined();
    for (const status of [
      '200',
      '201',
      '400',
      '401',
      '403',
      '408',
      '409',
      '429',
      '500',
      '502',
      '503',
      '504',
      'default',
    ]) {
      expect(responses?.[status], status).toBeDefined();
    }
  });

  it('requires current-user or scoped-bearer authentication', () => {
    expect(Object.keys(document.components.securitySchemes).sort()).toEqual([
      'cookieAuth',
      'scopedBearer',
    ]);
    expect(document.security).toEqual([{ cookieAuth: [] }, { scopedBearer: [] }]);
    expect(document.components.securitySchemes.cookieAuth).toMatchObject({
      type: 'apiKey',
      in: 'cookie',
      name: 'cb_v2_session',
    });
  });

  it('locks public states, safe Host fields, amount range and checkout action', () => {
    const schemas = document.components.schemas;
    expect(schemas.PaymentView?.oneOf).toHaveLength(4);
    expect([
      schemas.WaitingPayment?.properties?.status?.const,
      schemas.ProcessingPayment?.properties?.status?.const,
      schemas.CompletedPayment?.properties?.status?.const,
      schemas.ClosedPayment?.properties?.status?.const,
    ]).toEqual(['waiting', 'processing', 'completed', 'closed']);
    expect(schemas.WaitingPayment?.required).toContain('action');
    expect(schemas.PaymentHostMessage?.properties?.version?.const).toBe(1);
    expect(schemas.PaymentHostMessage?.properties?.type?.const).toBe('combo.payment_required');
    expect(schemas.PaymentMoney?.properties?.amountCents?.maxLength).toBe(
      PAYMENT_AMOUNT_CENTS_MAX_DIGITS,
    );
    expect(schemas.PaymentMoney?.properties?.amountCents?.pattern).toBe(
      PAYMENT_AMOUNT_CENTS_PATTERN_SOURCE,
    );
    expect(schemas.PaymentAction?.properties?.url).toMatchObject({
      maxLength: 4_096,
      pattern: PAYMENT_ACTION_URL_PATTERN_SOURCE,
    });
  });

  it('marks every object schema in the public graph as closed', () => {
    const schemas = document.components.schemas;
    for (const name of [
      'PaymentMoney',
      'PaymentRequirement',
      'PaymentRequiredResponse',
      'PaymentHostMessage',
      'CreatePaymentBody',
      'PaymentAction',
      'WaitingPayment',
      'ProcessingPayment',
      'CompletedPayment',
      'ClosedPayment',
      'PaymentSuccessResponse',
      'PaymentApiErrorResponse',
    ]) {
      expect(schemas[name]?.additionalProperties, name).toBe(false);
    }
  });

  it('describes the same safe message boundary as runtime parsing', () => {
    const schema = document.components.schemas.PaymentSafeMessage;
    expect(schema).toBeDefined();
    expect(schema?.maxLength).toBe(512);
    expect(schema?.pattern).toBe(PAYMENT_SAFE_MESSAGE_PATTERN_SOURCE);
    const validateOpenApiMessage = ajv.compile(schema!);
    for (const value of [
      '余额不足，请完成支付后继续。',
      'Payment required.',
      '合法 emoji 😀 与扩展汉字 𠀀',
    ]) {
      expect(validateOpenApiMessage(value), value).toBe(true);
      expect(PaymentSafeMessageSchema.safeParse(value).success, value).toBe(true);
    }
    for (const value of [
      'bad\u0000message',
      'bad\u0085message',
      'bad\u00admessage',
      'bad\u061cmessage',
      'bad\u2028message',
      'bad\u202emessage',
      'bad\ud800message',
      'bad\u{e0001}message',
    ]) {
      expect(validateOpenApiMessage(value), value).toBe(false);
      expect(PaymentSafeMessageSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it('validates the same real UTC timestamp boundary with a standard OpenAPI validator', () => {
    const schema = document.components.schemas.PaymentTimestamp;
    expect(schema).toBeDefined();
    expect(schema?.pattern).toBe(PAYMENT_TIMESTAMP_PATTERN_SOURCE);
    const validateOpenApiTimestamp = ajv.compile(schema!);
    for (const value of ['2024-02-29T23:59:59Z', '2026-09-03T10:00:00.000000001Z']) {
      expect(validateOpenApiTimestamp(value), value).toBe(true);
      expect(PaymentTimestampSchema.safeParse(value).success, value).toBe(true);
    }
    for (const value of [
      '0000-01-01T00:00:00Z',
      '2024-02-29T23:59:60Z',
      '2026-02-30T10:00:00Z',
      '2026-13-01T10:00:00Z',
      '2026-01-01T24:00:00Z',
      '2026-01-01T10:00:00+08:00',
    ]) {
      expect(validateOpenApiTimestamp(value), value).toBe(false);
      expect(PaymentTimestampSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it('makes amount and checkout constraints executable in OpenAPI and runtime', () => {
    const moneySchema = document.components.schemas.PaymentMoney;
    expect(moneySchema).toBeDefined();
    const validateOpenApiMoney = ajv.compile(moneySchema!);
    for (const value of ['1', '999999999999999']) {
      expect(validateOpenApiMoney({ currency: 'CNY', amountCents: value }), value).toBe(true);
      expect(PaymentMoneySchema.safeParse({ currency: 'CNY', amountCents: value }).success).toBe(
        true,
      );
    }
    for (const value of ['0', 'abc', '1e3', '1000000000000000']) {
      expect(validateOpenApiMoney({ currency: 'CNY', amountCents: value }), value).toBe(false);
      expect(PaymentMoneySchema.safeParse({ currency: 'CNY', amountCents: value }).success).toBe(
        false,
      );
    }

    const actionUrlSchema = document.components.schemas.PaymentAction?.properties?.url;
    expect(actionUrlSchema).toBeDefined();
    const validateOpenApiActionUrl = ajv.compile(actionUrlSchema!);
    const action = (url: string) => ({
      kind: 'open_url',
      url,
      expiresAt: '2026-09-03T10:05:00Z',
    });
    for (const url of [
      'https://pay.combo.test/p/payreq-1',
      'http://localhost:3000/pay?token=abc%2Fdef',
    ]) {
      expect(validateOpenApiActionUrl(url), url).toBe(true);
      expect(PaymentActionSchema.safeParse(action(url)).success, url).toBe(true);
    }
    for (const url of [
      'not-a-url',
      'http:example.com',
      'HTTPS://pay.combo.test/path',
      'https://user@pay.combo.test/path',
      'https://pay.combo.test/path#fragment',
      'https://pay.combo.test:65536/path',
      'https://pay.combo.test/path?token=%zz',
      'https://支付.example/path',
    ]) {
      expect(validateOpenApiActionUrl(url), url).toBe(false);
      expect(PaymentActionSchema.safeParse(action(url)).success, url).toBe(false);
    }
  });

  it('keeps executable fixtures valid under the runtime schemas', () => {
    expect(
      PaymentHostMessageSchema.safeParse({
        version: 1,
        type: 'combo.payment_required',
        paymentToken,
      }).success,
    ).toBe(true);
    expect(
      PaymentRequiredResponseSchema.safeParse({
        error: {
          userMessage: '余额不足，请完成支付后继续。',
          retriable: false,
          action: 'wait',
          traceId: 'trace-1',
          payment: {
            id: 'payreq-1',
            paymentToken,
            amount: { currency: 'CNY', amountCents: '600' },
            expiresAt: '2026-09-03T10:05:00Z',
          },
        },
      }).success,
    ).toBe(true);
    expect(
      PaymentViewSchema.safeParse({
        paymentRequestId: 'payreq-1',
        status: 'completed',
        amount: { currency: 'CNY', amountCents: '600' },
        expiresAt: '2026-09-03T10:05:00Z',
        createdAt: '2026-09-03T10:00:00Z',
        updatedAt: '2026-09-03T10:04:00Z',
        completedAt: '2026-09-03T10:04:00Z',
      }).success,
    ).toBe(true);
    expect(
      PaymentApiErrorResponseSchema.safeParse({
        error: {
          userMessage: '服务暂时不可用，请稍后重试。',
          retriable: true,
          action: 'retry',
          traceId: 'trace-1',
        },
      }).success,
    ).toBe(true);
  });
});
