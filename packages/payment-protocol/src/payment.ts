import { z } from 'zod';
import { ErrorBodySchema } from '@cb/shared';

export const PAYMENT_PROTOCOL_VERSION = 1 as const;
export const PAYMENT_HOST_MESSAGE_TYPE = 'combo.payment_required' as const;
export const PAYMENT_COLLECTION_PATH = '/v1/payments' as const;
export const PAYMENT_BY_REQUEST_KEY_PATH = '/v1/payments/by-request-key/:requestKey' as const;
export const PAYMENT_BY_ID_PATH = '/v1/payments/:paymentRequestId' as const;

const ASCII_IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const PAYMENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;
const VISIBLE_ASCII_PATTERN = /^[\x21-\x7e]+$/;
const FORBIDDEN_MESSAGE_CHAR_PATTERN = /[\p{Cc}\p{Cs}\p{Cf}\u2028\u2029]/u;
const RFC3339_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

function isRealUtcTimestamp(value: string): boolean {
  const match = RFC3339_UTC_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

export const PaymentIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(ASCII_IDENTIFIER_PATTERN, 'must use the canonical ASCII identifier format');
export type PaymentIdentifier = z.infer<typeof PaymentIdentifierSchema>;

export const PaymentRequestKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(ASCII_IDENTIFIER_PATTERN, 'must use the canonical ASCII identifier format');
export type PaymentRequestKey = z.infer<typeof PaymentRequestKeySchema>;

export const PaymentTokenSchema = z
  .string()
  .min(16)
  .max(8_192)
  .regex(PAYMENT_TOKEN_PATTERN, 'must use base64url-compatible characters');
export type PaymentToken = z.infer<typeof PaymentTokenSchema>;

export const PaymentTimestampSchema = z
  .string()
  .max(64)
  .refine(isRealUtcTimestamp, 'must be a real UTC RFC 3339 timestamp');
export type PaymentTimestamp = z.infer<typeof PaymentTimestampSchema>;

export const PaymentSafeMessageSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !FORBIDDEN_MESSAGE_CHAR_PATTERN.test(value), 'contains unsafe characters');

export const PaymentTraceIdSchema = z.string().min(1).max(256).regex(VISIBLE_ASCII_PATTERN);

export const PaymentMoneySchema = z
  .object({
    currency: z.literal('CNY'),
    amountCents: z
      .string()
      .min(1)
      .max(16)
      .regex(POSITIVE_INTEGER_PATTERN)
      .refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER), 'exceeds safe range'),
  })
  .strict();
export type PaymentMoney = z.infer<typeof PaymentMoneySchema>;

export const PaymentRequirementSchema = z
  .object({
    id: PaymentIdentifierSchema,
    paymentToken: PaymentTokenSchema,
    amount: PaymentMoneySchema,
    expiresAt: PaymentTimestampSchema,
  })
  .strict();
export type PaymentRequirement = z.infer<typeof PaymentRequirementSchema>;

export const PaymentMetaSchema = z.object({ traceId: PaymentTraceIdSchema }).strict();
export type PaymentMeta = z.infer<typeof PaymentMetaSchema>;

const PaymentErrorBaseSchema = ErrorBodySchema.pick({
  userMessage: true,
  retriable: true,
  action: true,
  traceId: true,
});

export const PaymentRequiredResponseSchema = z
  .object({
    error: PaymentErrorBaseSchema.extend({
      userMessage: PaymentSafeMessageSchema,
      retriable: z.literal(false),
      action: z.literal('wait'),
      traceId: PaymentTraceIdSchema,
      payment: PaymentRequirementSchema,
    }).strict(),
  })
  .strict();
export type PaymentRequiredResponse = z.infer<typeof PaymentRequiredResponseSchema>;

export const PaymentHostMessageSchema = z
  .object({
    version: z.literal(PAYMENT_PROTOCOL_VERSION),
    type: z.literal(PAYMENT_HOST_MESSAGE_TYPE),
    paymentToken: PaymentTokenSchema,
  })
  .strict();
export type PaymentHostMessage = z.infer<typeof PaymentHostMessageSchema>;

export const CreatePaymentBodySchema = z
  .object({
    paymentToken: PaymentTokenSchema,
    requestKey: PaymentRequestKeySchema,
  })
  .strict();
export type CreatePaymentBody = z.infer<typeof CreatePaymentBodySchema>;

export const PaymentStatusSchema = z.enum(['waiting', 'processing', 'completed', 'closed']);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

export const PaymentActionSchema = z
  .object({
    kind: z.literal('open_url'),
    url: z
      .string()
      .min(1)
      .max(4_096)
      .regex(VISIBLE_ASCII_PATTERN, 'must contain visible ASCII only')
      .url()
      .refine((value) => {
        const protocol = new URL(value).protocol;
        return protocol === 'http:' || protocol === 'https:';
      }, 'must be an http(s) URL'),
    expiresAt: PaymentTimestampSchema,
  })
  .strict();
export type PaymentAction = z.infer<typeof PaymentActionSchema>;

export const PaymentViewSchema = z
  .object({
    paymentRequestId: PaymentIdentifierSchema,
    status: PaymentStatusSchema,
    amount: PaymentMoneySchema,
    expiresAt: PaymentTimestampSchema,
    createdAt: PaymentTimestampSchema,
    updatedAt: PaymentTimestampSchema,
    completedAt: PaymentTimestampSchema.optional(),
    action: PaymentActionSchema.optional(),
  })
  .strict()
  .superRefine((payment, context) => {
    const createdAt = Date.parse(payment.createdAt);
    const updatedAt = Date.parse(payment.updatedAt);
    const expiresAt = Date.parse(payment.expiresAt);
    if (updatedAt < createdAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['updatedAt'],
        message: 'updatedAt cannot precede createdAt',
      });
    }
    if (expiresAt <= createdAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'expiresAt must follow createdAt',
      });
    }
    if (payment.status === 'completed' && payment.completedAt === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completedAt'],
        message: 'completedAt is required when status is completed',
      });
    }
    if (payment.status !== 'completed' && payment.completedAt !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completedAt'],
        message: 'completedAt is only valid when status is completed',
      });
    }
    if (
      payment.completedAt !== undefined &&
      (Date.parse(payment.completedAt) < createdAt || Date.parse(payment.completedAt) > updatedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completedAt'],
        message: 'completedAt must fall between createdAt and updatedAt',
      });
    }
    if (payment.status === 'waiting' && payment.action === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['action'],
        message: 'action is required while status is waiting',
      });
    }
    if (payment.status !== 'waiting' && payment.action !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['action'],
        message: 'action is only valid while status is waiting',
      });
    }
    if (
      payment.action !== undefined &&
      (Date.parse(payment.action.expiresAt) <= createdAt ||
        Date.parse(payment.action.expiresAt) > expiresAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['action', 'expiresAt'],
        message: 'action expiry must follow creation and not exceed payment expiry',
      });
    }
  });
export type PaymentView = z.infer<typeof PaymentViewSchema>;

export const PaymentSuccessResponseSchema = z
  .object({ data: PaymentViewSchema, meta: PaymentMetaSchema })
  .strict();
export type PaymentSuccessResponse = z.infer<typeof PaymentSuccessResponseSchema>;

export const PaymentApiErrorResponseSchema = z
  .object({
    error: PaymentErrorBaseSchema.extend({
      userMessage: PaymentSafeMessageSchema,
      traceId: PaymentTraceIdSchema,
    }).strict(),
  })
  .strict();
export type PaymentApiErrorResponse = z.infer<typeof PaymentApiErrorResponseSchema>;

export const PaymentIdParamsSchema = z
  .object({ paymentRequestId: PaymentIdentifierSchema })
  .strict();
export const PaymentRequestKeyParamsSchema = z
  .object({ requestKey: PaymentRequestKeySchema })
  .strict();

export function paymentByIdPath(paymentRequestId: PaymentIdentifier): string {
  return `${PAYMENT_COLLECTION_PATH}/${encodeURIComponent(PaymentIdentifierSchema.parse(paymentRequestId))}`;
}

export function paymentByRequestKeyPath(requestKey: PaymentRequestKey): string {
  return `${PAYMENT_COLLECTION_PATH}/by-request-key/${encodeURIComponent(PaymentRequestKeySchema.parse(requestKey))}`;
}
