import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  PAYMENT_BY_ID_PATH,
  PAYMENT_BY_REQUEST_KEY_PATH,
  PAYMENT_COLLECTION_PATH,
  PaymentHostMessageSchema,
  PaymentRequiredResponseSchema,
  PaymentViewSchema,
} from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
interface OpenApiSchema {
  additionalProperties?: boolean;
  oneOf?: unknown[];
  properties?: Record<string, { const?: unknown }>;
}

interface PaymentOpenApiDocument {
  paths: Record<string, unknown>;
  components: { schemas: Record<string, OpenApiSchema> };
}

const document = JSON.parse(
  readFileSync(resolve(here, '../../openapi/payment-v1.openapi.json'), 'utf8'),
) as PaymentOpenApiDocument;

describe('payment OpenAPI', () => {
  it('publishes only the three first-version payment endpoints', () => {
    expect(Object.keys(document.paths).sort()).toEqual(
      [
        PAYMENT_COLLECTION_PATH,
        PAYMENT_BY_REQUEST_KEY_PATH.replace(':requestKey', '{requestKey}'),
        PAYMENT_BY_ID_PATH.replace(':paymentRequestId', '{paymentRequestId}'),
      ].sort(),
    );
  });

  it('locks the public status and Host message constants', () => {
    const schemas = document.components.schemas;
    expect(schemas.PaymentView?.oneOf).toHaveLength(4);
    expect([
      schemas.WaitingPayment?.properties?.status?.const,
      schemas.ProcessingPayment?.properties?.status?.const,
      schemas.CompletedPayment?.properties?.status?.const,
      schemas.ClosedPayment?.properties?.status?.const,
    ]).toEqual(['waiting', 'processing', 'completed', 'closed']);
    expect(schemas.PaymentHostMessage?.properties?.version?.const).toBe(1);
    expect(schemas.PaymentHostMessage?.properties?.type?.const).toBe('combo.payment_required');
  });

  it('marks every object schema in the public graph as closed', () => {
    const schemas = document.components.schemas as Record<string, Record<string, unknown>>;
    for (const name of [
      'PaymentMoney',
      'PaymentRequirement',
      'PaymentMeta',
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

  it('keeps executable fixtures valid under the runtime schemas', () => {
    const paymentToken = `opaque_${'payment'.repeat(2)}`;
    expect(
      PaymentHostMessageSchema.safeParse({
        version: 1,
        type: 'combo.payment_required',
        paymentToken,
      }).success,
    ).toBe(true);
    expect(
      PaymentRequiredResponseSchema.safeParse({
        error: { code: 'payment_required' },
        data: {
          paymentRequirement: {
            id: 'payreq-1',
            paymentToken,
            amount: { currency: 'CNY', amountCents: '600' },
            expiresAt: '2026-09-03T10:05:00Z',
          },
        },
        meta: { traceId: 'trace-1' },
      }).success,
    ).toBe(true);
    expect(
      PaymentViewSchema.safeParse({
        paymentRequestId: 'payreq-1',
        requestKey: 'request-key-1',
        status: 'completed',
        amount: { currency: 'CNY', amountCents: '600' },
        expiresAt: '2026-09-03T10:05:00Z',
        createdAt: '2026-09-03T10:00:00Z',
        updatedAt: '2026-09-03T10:04:00Z',
        completedAt: '2026-09-03T10:04:00Z',
      }).success,
    ).toBe(true);
  });
});
