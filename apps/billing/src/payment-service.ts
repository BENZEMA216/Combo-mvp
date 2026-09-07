import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import {
  PaymentIdentifierSchema,
  PaymentRequirementSchema,
  PaymentViewSchema,
  type PaymentRequirement,
  type PaymentView,
} from '@cb/payment-protocol';

export const CallAdmissionInputSchema = z
  .object({
    userId: z.string().uuid(),
    agentId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    operationId: PaymentIdentifierSchema,
    callId: PaymentIdentifierSchema,
    requestFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    pricingPolicyId: PaymentIdentifierSchema,
    estimatedAmount: z.number().int().min(1).max(999_999_999_999_999),
  })
  .strict();
export type CallAdmissionInput = z.infer<typeof CallAdmissionInputSchema>;
export type CallAdmissionOutcome =
  | { kind: 'admitted'; holdId: string; replayed: boolean }
  | { kind: 'payment_required'; requirement: PaymentRequirement }
  | { kind: 'not_found' }
  | { kind: 'conflict' };

export interface PaymentStore {
  admitCall(input: CallAdmissionInput): Promise<CallAdmissionOutcome>;
  createPayment(input: {
    userId: string;
    paymentToken: string;
    requestKey: string;
  }): Promise<
    | { kind: 'payment'; payment: PaymentView; replayed: boolean }
    | { kind: 'not_found' }
    | { kind: 'conflict' }
  >;
  getPayment(input: { userId: string; paymentRequestId: string }): Promise<PaymentView | null>;
  findPayment(input: { userId: string; requestKey: string }): Promise<PaymentView | null>;
  /** Only a trusted, verified channel adapter may invoke accounting confirmation. */
  confirmPayment(input: {
    paymentRequestId: string;
    channelTransactionId: string;
    amountCents: number;
  }): Promise<
    { kind: 'completed'; replayed: boolean } | { kind: 'not_found' } | { kind: 'conflict' }
  >;
  releaseExpiredFunds(limit: number): Promise<number>;
}

export interface PaymentTokenCodec {
  issue(paymentRequestId: string): string;
  digest(token: string): string;
}

export function createPaymentTokenCodec(secret: string): PaymentTokenCodec {
  if (Buffer.byteLength(secret, 'utf8') < 32)
    throw new Error('payment token key must contain at least 32 bytes');
  return {
    issue: (id) =>
      createHmac('sha256', secret).update(`combo-payment-token:v1:${id}`).digest('base64url'),
    digest: (token) => createHash('sha256').update(token).digest('hex'),
  };
}

export interface PaymentRecord {
  id: string;
  userId: string;
  amount: number;
  state: 'required' | 'waiting' | 'completed';
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  completedAt: Date | null;
}

export function paymentRequirement(
  row: PaymentRecord,
  tokens: PaymentTokenCodec,
): PaymentRequirement {
  return PaymentRequirementSchema.parse({
    id: row.id,
    paymentToken: tokens.issue(row.id),
    amount: { currency: 'CNY', amountCents: String(row.amount) },
    expiresAt: row.expiresAt.toISOString(),
  });
}

export function paymentView(row: PaymentRecord, checkoutBaseUrl: string, now: Date): PaymentView {
  if (row.state === 'required') throw new Error('payment has not been created by its user');
  const status =
    row.state === 'completed' ? 'completed' : row.expiresAt <= now ? 'closed' : 'waiting';
  return PaymentViewSchema.parse({
    paymentRequestId: row.id,
    status,
    amount: { currency: 'CNY', amountCents: String(row.amount) },
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(status === 'completed' ? { completedAt: row.completedAt?.toISOString() } : {}),
    ...(status === 'waiting'
      ? {
          action: {
            kind: 'open_url',
            url: `${checkoutBaseUrl}/payments/${encodeURIComponent(row.id)}`,
            expiresAt: row.expiresAt.toISOString(),
          },
        }
      : {}),
  });
}
