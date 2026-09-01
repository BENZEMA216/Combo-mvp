import { z } from 'zod';

import { IdSchema, IsoDateTimeSchema } from '../core/ids.js';
import { KnowledgeAgentBindingSchema, KnowledgeCentsSchema } from './knowledge.js';

const CanonicalUuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const PolicyVersionSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u);
const RequestFingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u);

function containsUnsafeText(value: string): boolean {
  if (/\p{Cf}/u.test(value)) return true;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (
      unit <= 0x08 ||
      (unit >= 0x0b && unit <= 0x1f) ||
      (unit >= 0x7f && unit <= 0x9f) ||
      unit === 0x2028 ||
      unit === 0x2029
    ) {
      return true;
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export const PendingUsageRequestTextSchema = z
  .string()
  .min(1)
  .max(20_000)
  .refine((value) => value.trim() === value, 'Pending request whitespace must be canonical')
  .refine((value) => value.normalize('NFC') === value, 'Pending request must use NFC')
  .refine((value) => !containsUnsafeText(value), 'Pending request contains unsafe text');
export type PendingUsageRequestText = z.infer<typeof PendingUsageRequestTextSchema>;

export const PendingUsageRecoveryViewSchema = z
  .object({
    usageId: CanonicalUuidSchema,
    sessionId: IdSchema,
    capabilityId: IdSchema,
    requestText: PendingUsageRequestTextSchema,
    requestFingerprint: RequestFingerprintSchema,
    binding: KnowledgeAgentBindingSchema,
    billing: z
      .object({
        currency: z.literal('CNY'),
        policyVersion: PolicyVersionSchema,
        validatorPolicyVersion: PolicyVersionSchema,
        unitPriceCents: KnowledgeCentsSchema.refine(
          (value) => BigInt(value) > 0n,
          'Recovery unit price must be positive',
        ),
        freeLimitSnapshot: z.number().int().nonnegative(),
      })
      .strict(),
    status: z.literal('active'),
    activeRechargeIntentId: CanonicalUuidSchema,
    expiresAt: IsoDateTimeSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type PendingUsageRecoveryView = z.infer<typeof PendingUsageRecoveryViewSchema>;

export const PendingUsageRecoveryListQuerySchema = z
  .object({ sessionId: CanonicalUuidSchema.optional() })
  .strict();
export type PendingUsageRecoveryListQuery = z.infer<typeof PendingUsageRecoveryListQuerySchema>;

export const PendingUsageRecoveryUsageParamsSchema = z
  .object({ usageId: CanonicalUuidSchema })
  .strict();
export type PendingUsageRecoveryUsageParams = z.infer<typeof PendingUsageRecoveryUsageParamsSchema>;

export const AbandonPendingUsageRecoveryResultSchema = z
  .object({ abandoned: z.literal(true) })
  .strict();
export type AbandonPendingUsageRecoveryResult = z.infer<
  typeof AbandonPendingUsageRecoveryResultSchema
>;

export const CreateRecoveryRechargeOrderBodySchema = z
  .object({
    recoveryUsageId: CanonicalUuidSchema,
    rechargeIntentId: CanonicalUuidSchema,
    amountCents: z.number().int().positive().max(99_999_999),
    channel: z.literal('qr'),
    payType: z.enum(['wechat', 'alipay']),
  })
  .strict();
export type CreateRecoveryRechargeOrderBody = z.infer<typeof CreateRecoveryRechargeOrderBodySchema>;

export const RecoveryRechargeOrderStatusSchema = z.enum([
  'created',
  'pending',
  'unknown',
  'succeeded',
  'failed',
  'closed',
  'credited',
]);
export type RecoveryRechargeOrderStatus = z.infer<typeof RecoveryRechargeOrderStatusSchema>;

export const RecoveryRechargeOrderViewSchema = z
  .object({
    id: IdSchema,
    recoveryUsageId: CanonicalUuidSchema,
    rechargeIntentId: CanonicalUuidSchema,
    amountCents: KnowledgeCentsSchema.refine(
      (value) => BigInt(value) > 0n,
      'Recharge amount must be positive',
    ),
    channel: z.literal('qr'),
    payType: z.enum(['wechat', 'alipay']).optional(),
    status: RecoveryRechargeOrderStatusSchema,
    reconciliationActive: z.boolean(),
    paymentAction: z
      .object({
        kind: z.enum(['redirect', 'qr_code']),
        url: z.string().min(1).max(4_096),
      })
      .strict()
      .optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type RecoveryRechargeOrderView = z.infer<typeof RecoveryRechargeOrderViewSchema>;
