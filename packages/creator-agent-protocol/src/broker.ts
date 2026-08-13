import { z } from 'zod';
import { canonicalizeJson, canonicalSha256, parseJsonNoDuplicateKeys } from './canonical.js';
import {
  Base64UrlSchema,
  HmacSha256DigestSchema,
  IsoDateTimeSchema,
  P256P1363SignatureSchema,
  Sha256DigestSchema,
  Sha256HexSchema,
  Uint63StringSchema,
  Utf8TextSchema,
  UuidSchema,
} from './primitives.js';
import { verifyP256P1363Signature, type P256PublicKeyInput } from './signatures.js';

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

const ExecutionCapabilityUnsignedShape = {
  protocol: z.literal(EXECUTION_CAPABILITY_PROTOCOL),
  schemaVersion: z.literal(1),
  capabilityId: UuidSchema,
  invocationId: UuidSchema,
  conversationId: UuidSchema,
  deploymentId: UuidSchema,
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
  signatureEncoding: z.literal('ieee-p1363'),
};

function refineExecutionCapabilityWindow(
  capability: { notBefore: string; expiresAt: string },
  context: z.RefinementCtx,
): void {
  if (Date.parse(capability.expiresAt) <= Date.parse(capability.notBefore)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'Execution Capability expiry 必须晚于 notBefore',
    });
  }
}

const ExecutionCapabilityUnsignedObjectSchema = z.object(ExecutionCapabilityUnsignedShape).strict();

export const ExecutionCapabilityUnsignedSchema =
  ExecutionCapabilityUnsignedObjectSchema.superRefine(refineExecutionCapabilityWindow);
export type ExecutionCapabilityUnsigned = z.infer<typeof ExecutionCapabilityUnsignedSchema>;

export const ExecutionCapabilitySchema = z
  .object({
    ...ExecutionCapabilityUnsignedShape,
    signature: P256P1363SignatureSchema,
  })
  .strict()
  .superRefine(refineExecutionCapabilityWindow);
export type ExecutionCapability = z.infer<typeof ExecutionCapabilitySchema>;

export function executionCapabilitySigningBytes(
  capability: ExecutionCapability | ExecutionCapabilityUnsigned,
): Buffer {
  const { signature: _signature, ...unsigned } = capability as ExecutionCapability;
  return Buffer.from(canonicalizeJson(ExecutionCapabilityUnsignedSchema.parse(unsigned)), 'utf8');
}

/** 完整 wire capability（含签名）的稳定 journal/audit digest。 */
export function executionCapabilityDigest(capability: ExecutionCapability): string {
  return canonicalSha256(ExecutionCapabilitySchema.parse(capability));
}

const EXECUTION_CAPABILITY_BOUND_FIELDS = [
  'capabilityId',
  'invocationId',
  'conversationId',
  'deploymentId',
  'agentVersionId',
  'agentVersionDigest',
  'workerInstallationId',
  'leaseId',
  'fence',
  'providerRequestId',
  'requestDigest',
  'model',
  'reasoningEffort',
  'budget',
  'notBefore',
  'expiresAt',
  'nonce',
] as const satisfies readonly (keyof ExecutionCapability)[];

export type ExpectedExecutionCapabilityBinding = Pick<
  ExecutionCapability,
  (typeof EXECUTION_CAPABILITY_BOUND_FIELDS)[number]
>;

const ExpectedExecutionCapabilityBindingSchema = ExecutionCapabilityUnsignedObjectSchema.pick(
  Object.fromEntries(EXECUTION_CAPABILITY_BOUND_FIELDS.map((key) => [key, true])) as Record<
    (typeof EXECUTION_CAPABILITY_BOUND_FIELDS)[number],
    true
  >,
);

export function executionCapabilityBindingFrom(
  capability: ExecutionCapability,
): ExpectedExecutionCapabilityBinding {
  return Object.fromEntries(
    EXECUTION_CAPABILITY_BOUND_FIELDS.map((key) => [key, capability[key]]),
  ) as ExpectedExecutionCapabilityBinding;
}

export type ExecutionCapabilityBindingResult =
  | { ok: true; capability: ExecutionCapability; capabilityDigest: string }
  | { ok: false; code: 'EXECUTION_CAPABILITY_INVALID'; reasons: string[] };

export function validateExecutionCapabilityBinding(
  input: unknown,
  expected: ExpectedExecutionCapabilityBinding,
  now: Date,
  revokedCapabilityIds: ReadonlySet<string>,
  registeredCloudPublicKey: P256PublicKeyInput,
): ExecutionCapabilityBindingResult {
  const expectedBinding = ExpectedExecutionCapabilityBindingSchema.safeParse(expected);
  if (!expectedBinding.success) {
    return { ok: false, code: 'EXECUTION_CAPABILITY_INVALID', reasons: ['expected-binding'] };
  }
  const parsed = ExecutionCapabilitySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: 'EXECUTION_CAPABILITY_INVALID', reasons: ['schema'] };
  }
  if (
    !verifyP256P1363Signature(
      executionCapabilitySigningBytes(parsed.data),
      parsed.data.signature,
      registeredCloudPublicKey,
    )
  ) {
    return { ok: false, code: 'EXECUTION_CAPABILITY_INVALID', reasons: ['signature'] };
  }

  const reasons: string[] = [];
  for (const key of EXECUTION_CAPABILITY_BOUND_FIELDS) {
    if (canonicalizeJson(parsed.data[key]) !== canonicalizeJson(expectedBinding.data[key])) {
      reasons.push(`binding:${key}`);
    }
  }
  if (revokedCapabilityIds.has(parsed.data.capabilityId)) reasons.push('revoked');
  if (Date.parse(parsed.data.notBefore) > now.getTime()) reasons.push('not-yet-valid');
  if (Date.parse(parsed.data.expiresAt) <= now.getTime()) reasons.push('expired');

  return reasons.length === 0
    ? {
        ok: true,
        capability: parsed.data,
        capabilityDigest: executionCapabilityDigest(parsed.data),
      }
    : { ok: false, code: 'EXECUTION_CAPABILITY_INVALID', reasons };
}

export const ExecutionCapabilityUseStateSchema = z.enum([
  'UNUSED',
  'DISPATCHED',
  'DURABLE_RESULT',
  'REVOKED',
]);
export type ExecutionCapabilityUseState = z.infer<typeof ExecutionCapabilityUseStateSchema>;

export const ExecutionCapabilityUseRecordSchema = z
  .object({
    capabilityId: UuidSchema,
    capabilityDigest: Sha256HexSchema,
    providerRequestId: UuidSchema,
    requestDigest: HmacSha256DigestSchema,
    state: ExecutionCapabilityUseStateSchema,
    providerUpstreamRequestCount: z.number().int().min(0).max(1),
    resultDigest: HmacSha256DigestSchema.nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.state === 'UNUSED' && record.providerUpstreamRequestCount !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['providerUpstreamRequestCount'],
        message: 'UNUSED capability 不得有 upstream attempt',
      });
    }
    if (
      (record.state === 'DISPATCHED' || record.state === 'DURABLE_RESULT') &&
      record.providerUpstreamRequestCount !== 1
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['providerUpstreamRequestCount'],
        message: '已 dispatch capability 必须且只能有一个 upstream attempt',
      });
    }
    if (record.state === 'DURABLE_RESULT' && record.resultDigest === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resultDigest'],
        message: 'DURABLE_RESULT 必须绑定 resultDigest',
      });
    }
    if (record.state !== 'DURABLE_RESULT' && record.resultDigest !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resultDigest'],
        message: '只有 DURABLE_RESULT 可携带 resultDigest',
      });
    }
  });
export type ExecutionCapabilityUseRecord = z.infer<typeof ExecutionCapabilityUseRecordSchema>;

export type ExecutionCapabilityUseDecision =
  | { action: 'DISPATCH_ONCE'; nextRecord: ExecutionCapabilityUseRecord }
  | { action: 'RETURN_IN_PROGRESS'; record: ExecutionCapabilityUseRecord }
  | {
      action: 'RETURN_DURABLE_RESULT';
      record: ExecutionCapabilityUseRecord & { state: 'DURABLE_RESULT'; resultDigest: string };
    }
  | {
      action: 'SECURITY_BLOCK';
      code: 'CAPABILITY_REVOKED' | 'CAPABILITY_REUSE_CONFLICT' | 'CAPABILITY_LEDGER_INVALID';
    };

/**
 * 纯决策函数。调用方必须以 durable unique key/CAS 原子落下 nextRecord 后，
 * 才允许发起上游请求；exact replay 只能观察旧 attempt，永不二次 dispatch。
 */
export function decideExecutionCapabilityUse(
  capability: ExecutionCapability,
  existing: ExecutionCapabilityUseRecord | null,
): ExecutionCapabilityUseDecision {
  const parsedCapability = ExecutionCapabilitySchema.parse(capability);
  const parsedRecord = ExecutionCapabilityUseRecordSchema.safeParse(existing);
  if (existing !== null && !parsedRecord.success) {
    return { action: 'SECURITY_BLOCK', code: 'CAPABILITY_LEDGER_INVALID' };
  }

  const capabilityDigest = executionCapabilityDigest(parsedCapability);
  if (existing === null) {
    return {
      action: 'DISPATCH_ONCE',
      nextRecord: {
        capabilityId: parsedCapability.capabilityId,
        capabilityDigest,
        providerRequestId: parsedCapability.providerRequestId,
        requestDigest: parsedCapability.requestDigest,
        state: 'DISPATCHED',
        providerUpstreamRequestCount: 1,
        resultDigest: null,
      },
    };
  }

  const record = parsedRecord.data!;
  if (record.state === 'REVOKED') {
    return { action: 'SECURITY_BLOCK', code: 'CAPABILITY_REVOKED' };
  }
  if (
    record.capabilityId !== parsedCapability.capabilityId ||
    record.capabilityDigest !== capabilityDigest ||
    record.providerRequestId !== parsedCapability.providerRequestId ||
    record.requestDigest !== parsedCapability.requestDigest
  ) {
    return { action: 'SECURITY_BLOCK', code: 'CAPABILITY_REUSE_CONFLICT' };
  }
  if (record.state === 'UNUSED') {
    return {
      action: 'DISPATCH_ONCE',
      nextRecord: {
        ...record,
        state: 'DISPATCHED',
        providerUpstreamRequestCount: 1,
      },
    };
  }
  if (record.state === 'DURABLE_RESULT') {
    return {
      action: 'RETURN_DURABLE_RESULT',
      record: record as ExecutionCapabilityUseRecord & {
        state: 'DURABLE_RESULT';
        resultDigest: string;
      },
    };
  }
  if (record.state === 'DISPATCHED') {
    return { action: 'RETURN_IN_PROGRESS', record };
  }
  return { action: 'SECURITY_BLOCK', code: 'CAPABILITY_LEDGER_INVALID' };
}

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
