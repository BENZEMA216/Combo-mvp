import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  PAYMENT_BY_ID_PATH,
  PAYMENT_BY_REQUEST_KEY_PATH,
  PAYMENT_COLLECTION_PATH,
  PaymentApiErrorResponseSchema,
  PaymentHostMessageSchema,
  PaymentRequiredResponseSchema,
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
    expect(schemas.PaymentMoney?.properties?.amountCents?.maxLength).toBe(16);
    expect(schemas.PaymentMoney?.properties?.amountCents?.['x-maximum-integer']).toBe(
      '9007199254740991',
    );
    expect(schemas.PaymentAction?.properties?.url).toMatchObject({
      maxLength: 4_096,
      pattern: '^https?://[!-~]+$',
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
    expect(schema?.maxLength).toBe(512);
    expect(schema?.pattern).toContain('\\u2028');
    expect(schema?.['x-forbidden-unicode-categories']).toEqual(['Cc', 'Cs', 'Cf']);
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
