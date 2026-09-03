import { z } from 'zod';
import { ErrorBodySchema } from '@cb/shared';

export const PAYMENT_PROTOCOL_VERSION = 1 as const;
export const PAYMENT_HOST_MESSAGE_TYPE = 'combo.payment_required' as const;
export const PAYMENT_COLLECTION_PATH = '/v1/payments' as const;
export const PAYMENT_BY_REQUEST_KEY_PATH = '/v1/payments/by-request-key/:requestKey' as const;
export const PAYMENT_BY_ID_PATH = '/v1/payments/:paymentRequestId' as const;

const ASCII_IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const PAYMENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const VISIBLE_ASCII_PATTERN = /^[\x21-\x7e]+$/;
const RFC3339_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

export const PAYMENT_AMOUNT_CENTS_MAX_DIGITS = 15 as const;
export const PAYMENT_AMOUNT_CENTS_PATTERN_SOURCE = String.raw`^[1-9]\d*$`;
export const PAYMENT_SAFE_MESSAGE_PATTERN_SOURCE = String.raw`^[^\u0000-\u001F\u007F-\u009F\u00AD\u0600-\u0605\u061C\u06DD\u070F\u0890-\u0891\u08E2\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u206F\uD800-\uDFFF\uFEFF\uFFF9-\uFFFB]+$`;
export const PAYMENT_ACTION_URL_PATTERN_SOURCE = String.raw`^https?://(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?(?::(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5]))?(?:/(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})*)*(?:\?(?:[A-Za-z0-9._~!$&'()*+,;=:@/?-]|%[0-9A-Fa-f]{2})*)?$`;

const PAYMENT_AMOUNT_CENTS_PATTERN = new RegExp(PAYMENT_AMOUNT_CENTS_PATTERN_SOURCE);
const PAYMENT_SAFE_MESSAGE_PATTERN = new RegExp(PAYMENT_SAFE_MESSAGE_PATTERN_SOURCE);
const PAYMENT_ACTION_URL_PATTERN = new RegExp(PAYMENT_ACTION_URL_PATTERN_SOURCE);

type PaymentTimestampParts = readonly [number, number, number, number, number, number, number];

function parseUtcTimestamp(value: string): PaymentTimestampParts | null {
  const match = RFC3339_UTC_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return null;
  }
  const nanoseconds = Number((match[7] ?? '').padEnd(9, '0'));
  return [year, month, day, hour, minute, second, nanoseconds];
}

function compareUtcTimestamps(left: string, right: string): -1 | 0 | 1 | null {
  const leftParts = parseUtcTimestamp(left);
  const rightParts = parseUtcTimestamp(right);
  if (!leftParts || !rightParts) return null;
  for (const [index, leftPart] of leftParts.entries()) {
    const rightPart = rightParts[index]!;
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return 0;
}

function isCanonicalPaymentActionUrl(value: string): boolean {
  if (!PAYMENT_ACTION_URL_PATTERN.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
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
  .refine((value) => parseUtcTimestamp(value) !== null, 'must be a real UTC RFC 3339 timestamp');
export type PaymentTimestamp = z.infer<typeof PaymentTimestampSchema>;

export const PaymentSafeMessageSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(PAYMENT_SAFE_MESSAGE_PATTERN, 'contains unsafe characters');

export const PaymentTraceIdSchema = z.string().min(1).max(256).regex(VISIBLE_ASCII_PATTERN);

export const PaymentMoneySchema = z
  .object({
    currency: z.literal('CNY'),
    amountCents: z
      .string()
      .min(1)
      .max(PAYMENT_AMOUNT_CENTS_MAX_DIGITS)
      .regex(PAYMENT_AMOUNT_CENTS_PATTERN),
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
      .refine(isCanonicalPaymentActionUrl, 'must be a canonical http(s) checkout URL'),
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
    const updatedComparedWithCreated = compareUtcTimestamps(payment.updatedAt, payment.createdAt);
    const expiresComparedWithCreated = compareUtcTimestamps(payment.expiresAt, payment.createdAt);
    const expiresComparedWithUpdated = compareUtcTimestamps(payment.expiresAt, payment.updatedAt);
    if (updatedComparedWithCreated !== null && updatedComparedWithCreated < 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['updatedAt'],
        message: 'updatedAt cannot precede createdAt',
      });
    }
    if (expiresComparedWithCreated !== null && expiresComparedWithCreated <= 0) {
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
      (compareUtcTimestamps(payment.completedAt, payment.createdAt) === -1 ||
        compareUtcTimestamps(payment.completedAt, payment.updatedAt) === 1)
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
      payment.status === 'waiting' &&
      expiresComparedWithUpdated !== null &&
      expiresComparedWithUpdated <= 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'expiresAt must follow updatedAt while status is waiting',
      });
    }
    const actionComparedWithUpdated = payment.action
      ? compareUtcTimestamps(payment.action.expiresAt, payment.updatedAt)
      : null;
    const actionComparedWithExpiry = payment.action
      ? compareUtcTimestamps(payment.action.expiresAt, payment.expiresAt)
      : null;
    if (
      payment.action !== undefined &&
      ((actionComparedWithUpdated !== null && actionComparedWithUpdated <= 0) ||
        (actionComparedWithExpiry !== null && actionComparedWithExpiry > 0))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['action', 'expiresAt'],
        message: 'action expiry must follow the update and not exceed payment expiry',
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
