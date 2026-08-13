import { z } from 'zod';
import { parseJsonNoDuplicateKeys } from './canonical.js';
import {
  Base64UrlSchema,
  HmacSha256DigestSchema,
  IsoDateTimeSchema,
  Sha256DigestSchema,
  Sha256HexSchema,
  Uint63StringSchema,
  Utf8TextSchema,
  UuidSchema,
} from './primitives.js';

export const CREATOR_BROKER_PROTOCOL = 'combo.creator-broker/1' as const;
export const EXECUTION_CAPABILITY_PROTOCOL = 'combo.execution-capability/1' as const;
export const BROKER_MAX_FRAME_BYTES = 65_536;

export const BrokerCapacitySchema = z
  .object({
    maxActiveConversations: z.literal(1),
    maxActiveTurns: z.literal(1),
  })
  .strict();

export const BrokerHandshakeSchema = z
  .object({
    protocol: z.literal(CREATOR_BROKER_PROTOCOL),
    schemaVersion: z.literal(1),
    installationId: UuidSchema,
    workerVersion: Utf8TextSchema(128),
    supportedProtocolVersions: z.tuple([z.literal(1)]),
    codexRuntimeArtifacts: z.array(Sha256DigestSchema).min(1).max(8),
    codexProtocolSchemaDigests: z.array(Sha256DigestSchema).min(1).max(8),
    isolationModes: z
      .array(z.enum(['apple-container-v1', 'lima-vz-v1']))
      .min(1)
      .max(2),
    capacity: BrokerCapacitySchema,
    challengeId: UuidSchema,
    challengeSignature: Base64UrlSchema.min(32).max(256),
  })
  .strict();
export type BrokerHandshake = z.infer<typeof BrokerHandshakeSchema>;

export const LeaseBindingSchema = z
  .object({
    deploymentId: UuidSchema,
    leaseId: UuidSchema,
    fence: Uint63StringSchema,
  })
  .strict();
export type LeaseBinding = z.infer<typeof LeaseBindingSchema>;

export const ExecutionCapabilitySchema = z
  .object({
    protocol: z.literal(EXECUTION_CAPABILITY_PROTOCOL),
    schemaVersion: z.literal(1),
    capabilityId: UuidSchema,
    invocationId: UuidSchema,
    conversationId: UuidSchema,
    agentVersionId: UuidSchema,
    agentVersionDigest: Sha256HexSchema,
    workerInstallationId: UuidSchema,
    leaseId: UuidSchema,
    fence: Uint63StringSchema,
    providerRequestId: UuidSchema,
    requestDigest: HmacSha256DigestSchema,
    model: Utf8TextSchema(128),
    reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']),
    budget: z
      .object({
        maxInputTokens: z.number().int().min(1).max(200_000),
        maxOutputTokens: z.number().int().min(1).max(32_768),
        maxCostMicros: z.number().int().min(1).max(100_000_000),
      })
      .strict(),
    notBefore: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    nonce: Base64UrlSchema.min(22).max(128),
    signatureAlgorithm: z.literal('ES256'),
    signature: Base64UrlSchema.min(32).max(256),
  })
  .strict()
  .superRefine((capability, context) => {
    if (Date.parse(capability.expiresAt) <= Date.parse(capability.notBefore)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'Execution Capability expiry 必须晚于 notBefore',
      });
    }
  });
export type ExecutionCapability = z.infer<typeof ExecutionCapabilitySchema>;

const commonEnvelopeShape = {
  protocol: z.literal(CREATOR_BROKER_PROTOCOL),
  schemaVersion: z.literal(1),
  messageId: UuidSchema,
  correlationId: UuidSchema,
  connectionId: UuidSchema,
  sequence: Uint63StringSchema,
  sentAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
};

function command<const Type extends string, Schema extends z.ZodTypeAny>(type: Type, body: Schema) {
  return z
    .object({
      ...commonEnvelopeShape,
      kind: z.literal('command'),
      type: z.literal(type),
      lease: LeaseBindingSchema,
      body,
    })
    .strict();
}

function event<const Type extends string, Schema extends z.ZodTypeAny>(type: Type, body: Schema) {
  return z
    .object({
      ...commonEnvelopeShape,
      kind: z.literal('event'),
      type: z.literal(type),
      lease: LeaseBindingSchema,
      body,
    })
    .strict();
}

const EmptyBodySchema = z.object({}).strict();
const GenerationSchema = Uint63StringSchema;

export const BrokerCommandSchema = z.discriminatedUnion('type', [
  command(
    'lease.grant',
    z
      .object({
        leaseExpiresAt: IsoDateTimeSchema,
        workerSessionId: UuidSchema,
        generation: GenerationSchema,
      })
      .strict(),
  ),
  command(
    'lease.revoke',
    z
      .object({
        reason: z.enum([
          'SESSION_REPLACED',
          'DRAIN',
          'IMMEDIATE',
          'SECURITY',
          'INSTALLATION_REVOKED',
        ]),
        effectiveAt: IsoDateTimeSchema,
      })
      .strict(),
  ),
  command(
    'version.prepare',
    z
      .object({
        agentVersionId: UuidSchema,
        agentVersionDigest: Sha256HexSchema,
        snapshotDigest: Sha256HexSchema,
        generation: GenerationSchema,
      })
      .strict(),
  ),
  command(
    'deployment.drain',
    z
      .object({
        mode: z.enum(['DRAIN', 'IMMEDIATE']),
        generation: GenerationSchema,
        deadlineAt: IsoDateTimeSchema,
      })
      .strict(),
  ),
  command(
    'conversation.open',
    z
      .object({
        conversationId: UuidSchema,
        agentVersionId: UuidSchema,
        agentVersionDigest: Sha256HexSchema,
        snapshotDigest: Sha256HexSchema,
        visibleTranscriptDigest: HmacSha256DigestSchema,
      })
      .strict(),
  ),
  command(
    'conversation.close',
    z
      .object({
        conversationId: UuidSchema,
        reason: z.enum(['USER', 'EXPIRED', 'DRAIN', 'SECURITY']),
      })
      .strict(),
  ),
  command(
    'invocation.prepare',
    z
      .object({
        invocationId: UuidSchema,
        conversationId: UuidSchema,
        clientMessageId: UuidSchema,
        requestDigest: HmacSha256DigestSchema,
        agentVersionId: UuidSchema,
        agentVersionDigest: Sha256HexSchema,
        snapshotDigest: Sha256HexSchema,
        deadlineAt: IsoDateTimeSchema,
        executionCapability: ExecutionCapabilitySchema,
      })
      .strict(),
  ),
  command(
    'invocation.start',
    z
      .object({
        invocationId: UuidSchema,
        prepareCommandId: UuidSchema,
        executionCapabilityId: UuidSchema,
      })
      .strict(),
  ),
  command(
    'invocation.cancel',
    z
      .object({
        invocationId: UuidSchema,
        reason: z.enum(['CONSUMER_REQUEST', 'DRAIN_DEADLINE', 'SECURITY_REVOKE', 'DEADLINE']),
      })
      .strict(),
  ),
  command(
    'invocation.reconcile',
    z
      .object({
        invocationId: UuidSchema,
        cloudState: z.enum([
          'ACCEPTED',
          'QUEUED',
          'DISPATCH_PENDING',
          'PERSISTED',
          'STARTING',
          'RUNNING',
          'CANCEL_REQUESTED',
          'RECONCILING',
        ]),
        reconciliationDeadlineAt: IsoDateTimeSchema,
      })
      .strict(),
  ),
  command('ping', z.object({ nonce: Base64UrlSchema.min(16).max(128) }).strict()),
]);
export type BrokerCommand = z.infer<typeof BrokerCommandSchema>;

export const BrokerEventSchema = z.discriminatedUnion('type', [
  event('lease.accepted', z.object({ leaseExpiresAt: IsoDateTimeSchema }).strict()),
  event('lease.renewed', z.object({ leaseExpiresAt: IsoDateTimeSchema }).strict()),
  event(
    'version.ready',
    z
      .object({
        generation: GenerationSchema,
        agentVersionDigest: Sha256HexSchema,
        smokeAttestationDigest: Sha256DigestSchema,
      })
      .strict(),
  ),
  event(
    'version.rejected',
    z.object({ generation: GenerationSchema, errorCode: Utf8TextSchema(128) }).strict(),
  ),
  event(
    'conversation.ready',
    z.object({ conversationId: UuidSchema, sandboxInstanceId: UuidSchema }).strict(),
  ),
  event(
    'invocation.prepared',
    z
      .object({
        invocationId: UuidSchema,
        requestDigest: HmacSha256DigestSchema,
        prepareCommandId: UuidSchema,
      })
      .strict(),
  ),
  event(
    'invocation.started',
    z
      .object({
        invocationId: UuidSchema,
        dispatchReceiptDigest: Sha256DigestSchema,
        sandboxAttestationDigest: Sha256DigestSchema,
      })
      .strict(),
  ),
  event(
    'invocation.delta',
    z
      .object({
        invocationId: UuidSchema,
        deltaSequence: Uint63StringSchema,
        text: Utf8TextSchema(8_192),
      })
      .strict(),
  ),
  event(
    'invocation.succeeded',
    z
      .object({
        invocationId: UuidSchema,
        resultDigest: HmacSha256DigestSchema,
        resultText: Utf8TextSchema(32_768),
        sourceEventId: UuidSchema,
      })
      .strict(),
  ),
  event(
    'invocation.failed',
    z
      .object({
        invocationId: UuidSchema,
        errorCode: Utf8TextSchema(128),
        sourceEventId: UuidSchema,
      })
      .strict(),
  ),
  event(
    'invocation.cancelled',
    z
      .object({
        invocationId: UuidSchema,
        interruptReceiptDigest: Sha256DigestSchema,
        sourceEventId: UuidSchema,
      })
      .strict(),
  ),
  event(
    'invocation.uncertain',
    z
      .object({
        invocationId: UuidSchema,
        reason: z.enum([
          'START_DISPATCH_UNKNOWN',
          'HOST_EVIDENCE_LOST',
          'MODEL_ATTEMPT_UNKNOWN',
          'CANCEL_NOT_CONFIRMED',
          'JOURNAL_LOST',
        ]),
        sourceEventId: UuidSchema,
      })
      .strict(),
  ),
  event(
    'heartbeat',
    z
      .object({
        workerSessionId: UuidSchema,
        runtimeReady: z.boolean(),
        proxyReady: z.boolean(),
        journalReady: z.boolean(),
        activeInvocationId: UuidSchema.nullable(),
      })
      .strict(),
  ),
  event('pong', z.object({ nonce: Base64UrlSchema.min(16).max(128) }).strict()),
]);
export type BrokerEvent = z.infer<typeof BrokerEventSchema>;

export const BrokerAckSchema = z
  .object({
    ...commonEnvelopeShape,
    kind: z.literal('ack'),
    type: z.literal('message.ack'),
    lease: LeaseBindingSchema,
    body: z
      .object({
        acknowledgedMessageId: UuidSchema,
        level: z.enum(['RECEIVED', 'PERSISTED', 'CLOUD_COMMITTED']),
        decision: z.enum([
          'APPLIED',
          'IDEMPOTENT_REPLAY',
          'NOOP_TERMINAL',
          'RECONCILE',
          'SECURITY_BLOCK',
        ]),
      })
      .strict(),
  })
  .strict();
export type BrokerAck = z.infer<typeof BrokerAckSchema>;

export const BrokerEnvelopeSchema = z
  .union([BrokerCommandSchema, BrokerEventSchema, BrokerAckSchema])
  .superRefine((envelope, context) => {
    if (Date.parse(envelope.expiresAt) <= Date.parse(envelope.sentAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'expiresAt 必须晚于 sentAt',
      });
    }
  });
export type BrokerEnvelope = z.infer<typeof BrokerEnvelopeSchema>;

export function parseBrokerFrame(frame: string | Uint8Array): BrokerEnvelope {
  const bytes = typeof frame === 'string' ? Buffer.from(frame, 'utf8') : Buffer.from(frame);
  if (bytes.byteLength > BROKER_MAX_FRAME_BYTES)
    throw new RangeError('Broker frame 超过 65536 bytes');
  const json = bytes.toString('utf8');
  return BrokerEnvelopeSchema.parse(parseJsonNoDuplicateKeys(json));
}

export function parseBrokerHandshake(frame: string | Uint8Array): BrokerHandshake {
  const bytes = typeof frame === 'string' ? Buffer.from(frame, 'utf8') : Buffer.from(frame);
  if (bytes.byteLength > BROKER_MAX_FRAME_BYTES) throw new RangeError('Broker handshake 超过上限');
  return BrokerHandshakeSchema.parse(parseJsonNoDuplicateKeys(bytes.toString('utf8')));
}

export const BrokerEmptyBodySchema = EmptyBodySchema;
