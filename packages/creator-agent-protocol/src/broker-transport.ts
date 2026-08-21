import { z } from 'zod';

import { canonicalFingerprint, canonicalizeJson } from './canonical.js';
import { Sha256DigestSchema, containsLoneSurrogate, type Sha256Digest } from './primitives.js';

export const BROKER_TRANSPORT_PROTOCOL = 'combo.worker-broker-transport/1' as const;
export const BROKER_TRANSPORT_MAX_FRAME_BYTES = 65_536;
export const BROKER_TRANSPORT_SEMANTIC_FINGERPRINT_DOMAIN =
  'combo.worker-broker-transport.semantic/1' as const;
export const BROKER_TRANSPORT_WIRE_FINGERPRINT_DOMAIN =
  'combo.worker-broker-transport.wire/1' as const;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const PROTOTYPE_SENSITIVE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SafeNonnegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const BrokerTransportIdentifierSchema = z.string().regex(IDENTIFIER_PATTERN);
export const BrokerTransportDirectionSchema = z.enum(['CLOUD_TO_WORKER', 'WORKER_TO_CLOUD']);
export type BrokerTransportDirection = z.infer<typeof BrokerTransportDirectionSchema>;

export type BrokerTransportCanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly BrokerTransportCanonicalValue[]
  | BrokerTransportPayload;
export type BrokerTransportPayload = Readonly<{
  [key: string]: BrokerTransportCanonicalValue;
}>;

export function canonicalizeBrokerTransportJson(value: BrokerTransportCanonicalValue): string {
  return canonicalizeJson(value);
}

const BrokerTransportCanonicalValueSchema: z.ZodType<BrokerTransportCanonicalValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string().refine((value) => !containsLoneSurrogate(value), 'Malformed Unicode is forbidden'),
    z.array(BrokerTransportCanonicalValueSchema).readonly(),
    BrokerTransportPayloadSchema,
  ]),
);

const BrokerTransportPayloadKeySchema = z
  .string()
  .refine(
    (key) => !containsLoneSurrogate(key) && !PROTOTYPE_SENSITIVE_KEYS.has(key),
    'Payload key is malformed or prototype-sensitive',
  );

export const BrokerTransportPayloadSchema: z.ZodType<BrokerTransportPayload> = z
  .record(BrokerTransportPayloadKeySchema, BrokerTransportCanonicalValueSchema)
  .readonly();

const BrokerTransportLeaseGrantBodyObjectSchema = z
  .object({
    type: z.literal('lease.grant'),
    leaseExpiresAtMs: SafeNonnegativeIntegerSchema,
  })
  .strict();
export const BrokerTransportLeaseGrantBodySchema =
  BrokerTransportLeaseGrantBodyObjectSchema.readonly();
export type BrokerTransportLeaseGrantBody = z.infer<typeof BrokerTransportLeaseGrantBodySchema>;

const BrokerTransportCommandBodyObjectSchema = z
  .object({
    type: z.literal('command'),
    commandType: BrokerTransportIdentifierSchema,
    payload: BrokerTransportPayloadSchema,
  })
  .strict();
export const BrokerTransportCommandBodySchema = BrokerTransportCommandBodyObjectSchema.readonly();
export type BrokerTransportCommandBody = z.infer<typeof BrokerTransportCommandBodySchema>;

const BrokerTransportWorkerMessageBodyObjectSchema = z
  .object({
    type: z.literal('worker.message'),
    messageType: BrokerTransportIdentifierSchema,
    sourceId: BrokerTransportIdentifierSchema,
    sourceFingerprint: Sha256DigestSchema,
    payload: BrokerTransportPayloadSchema,
  })
  .strict();
export const BrokerTransportWorkerMessageBodySchema =
  BrokerTransportWorkerMessageBodyObjectSchema.readonly();
export type BrokerTransportWorkerMessageBody = z.infer<
  typeof BrokerTransportWorkerMessageBodySchema
>;

const BrokerTransportAckBodyObjectSchema = z
  .object({
    type: z.literal('message.ack'),
    acknowledgedMessageId: BrokerTransportIdentifierSchema,
    acknowledgedSemanticFingerprint: Sha256DigestSchema,
    acknowledgedWireFingerprint: Sha256DigestSchema,
    level: z.enum(['PERSISTED', 'CLOUD_COMMITTED']),
    decision: z.enum(['APPLIED', 'IDEMPOTENT_REPLAY']),
  })
  .strict();
export const BrokerTransportAckBodySchema = BrokerTransportAckBodyObjectSchema.readonly();
export type BrokerTransportAckBody = z.infer<typeof BrokerTransportAckBodySchema>;

export const BrokerTransportBodySchema = z
  .discriminatedUnion('type', [
    BrokerTransportLeaseGrantBodyObjectSchema,
    BrokerTransportCommandBodyObjectSchema,
    BrokerTransportWorkerMessageBodyObjectSchema,
    BrokerTransportAckBodyObjectSchema,
  ])
  .readonly();
export type BrokerTransportBody = z.infer<typeof BrokerTransportBodySchema>;

const frameInputShape = {
  direction: BrokerTransportDirectionSchema,
  connectionId: BrokerTransportIdentifierSchema,
  sequence: SafeNonnegativeIntegerSchema,
  installationId: BrokerTransportIdentifierSchema,
  deploymentId: BrokerTransportIdentifierSchema,
  workerSessionId: BrokerTransportIdentifierSchema,
  leaseId: BrokerTransportIdentifierSchema,
  fence: SafeNonnegativeIntegerSchema,
  messageId: BrokerTransportIdentifierSchema,
  body: BrokerTransportBodySchema,
} as const;

function validateDirectionAndSequence(
  frame: Readonly<{
    direction: BrokerTransportDirection;
    sequence: number;
    body: BrokerTransportBody;
  }>,
  context: z.RefinementCtx,
): void {
  const { body, direction, sequence } = frame;
  const valid =
    body.type === 'lease.grant'
      ? direction === 'CLOUD_TO_WORKER' && sequence === 0
      : body.type === 'command'
        ? direction === 'CLOUD_TO_WORKER' && sequence >= 1
        : body.type === 'worker.message'
          ? direction === 'WORKER_TO_CLOUD' && sequence >= 1
          : body.level === 'PERSISTED'
            ? direction === 'WORKER_TO_CLOUD' && sequence >= 1
            : direction === 'CLOUD_TO_WORKER' && sequence >= 1;
  if (!valid) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['direction'],
      message: 'Direction and sequence do not match the Broker transport body',
    });
  }
}

export const BrokerTransportFrameInputSchema = z
  .object(frameInputShape)
  .strict()
  .superRefine(validateDirectionAndSequence)
  .readonly();
export type BrokerTransportFrameInput = z.input<typeof BrokerTransportFrameInputSchema>;

export const BrokerTransportFrameSchema = z
  .object({
    protocol: z.literal(BROKER_TRANSPORT_PROTOCOL),
    ...frameInputShape,
    semanticFingerprint: Sha256DigestSchema,
  })
  .strict()
  .superRefine((frame, context) => {
    validateDirectionAndSequence(frame, context);
    const expected = brokerTransportSemanticFingerprint(frame.messageId, frame.body);
    if (frame.semanticFingerprint !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['semanticFingerprint'],
        message: 'semanticFingerprint does not bind the exact messageId and body',
      });
    }
  })
  .readonly();
export type BrokerTransportFrame = z.infer<typeof BrokerTransportFrameSchema>;

export type BrokerTransportFrameMaterialization = Readonly<{
  frame: BrokerTransportFrame;
  canonicalText: string;
  wireFingerprint: Sha256Digest;
}>;

export function createBrokerTransportFrame(
  input: BrokerTransportFrameInput,
): BrokerTransportFrameMaterialization {
  const canonicalInput = canonicalizeJson(input);
  const parsed = BrokerTransportFrameInputSchema.parse(input);
  if (canonicalizeJson(parsed) !== canonicalInput) {
    throw new TypeError('Broker transport input changed during schema parsing');
  }
  const candidate = {
    protocol: BROKER_TRANSPORT_PROTOCOL,
    ...parsed,
    semanticFingerprint: brokerTransportSemanticFingerprint(parsed.messageId, parsed.body),
  };
  return materialize(candidate);
}

export function parseBrokerTransportFrame(text: string): BrokerTransportFrameMaterialization {
  if (typeof text !== 'string') throw new TypeError('Broker transport frame must be text');
  if (containsLoneSurrogate(text)) {
    throw new TypeError('Broker transport frame contains malformed Unicode');
  }
  if (Buffer.byteLength(text, 'utf8') > BROKER_TRANSPORT_MAX_FRAME_BYTES) {
    throw new RangeError('Broker transport frame exceeds 65536 UTF-8 bytes');
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError('Broker transport frame is not valid JSON');
  }
  let canonicalText: string;
  try {
    canonicalText = canonicalizeJson(value);
  } catch {
    throw new TypeError('Broker transport frame is not canonical JSON');
  }
  if (canonicalText !== text) {
    throw new TypeError('Broker transport frame is not exact canonical JSON');
  }
  return materialize(value, canonicalText);
}

function materialize(
  value: unknown,
  knownCanonicalText?: string,
): BrokerTransportFrameMaterialization {
  const frame = BrokerTransportFrameSchema.parse(value);
  const canonicalText = canonicalizeJson(frame);
  if (knownCanonicalText !== undefined && knownCanonicalText !== canonicalText) {
    throw new TypeError('Broker transport frame changed during schema parsing');
  }
  if (Buffer.byteLength(canonicalText, 'utf8') > BROKER_TRANSPORT_MAX_FRAME_BYTES) {
    throw new RangeError('Broker transport frame exceeds 65536 UTF-8 bytes');
  }
  deepFreeze(frame);
  return Object.freeze({
    frame,
    canonicalText,
    wireFingerprint: canonicalFingerprint(BROKER_TRANSPORT_WIRE_FINGERPRINT_DOMAIN, frame),
  });
}

export function brokerTransportSemanticFingerprint(
  messageId: string,
  body: BrokerTransportBody,
): Sha256Digest {
  const parsedMessageId = BrokerTransportIdentifierSchema.parse(messageId);
  const canonicalBody = canonicalizeJson(body);
  const parsedBody = BrokerTransportBodySchema.parse(body);
  if (canonicalizeJson(parsedBody) !== canonicalBody) {
    throw new TypeError('Broker transport body changed during schema parsing');
  }
  return canonicalFingerprint(BROKER_TRANSPORT_SEMANTIC_FINGERPRINT_DOMAIN, {
    messageId: parsedMessageId,
    body: parsedBody,
  });
}

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}
