import { z } from 'zod';
import { canonicalizeJson, canonicalSha256, parseJsonNoDuplicateKeys } from './canonical.js';
import {
  Base64UrlSchema,
  CanonicalBase64UrlBytesSchema,
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
export const BROKER_WORKER_CONNECT_PATH = '/v1/worker/connect' as const;

/** Worker and Gateway must consume this single wire authority; do not duplicate numeric codes. */
export const BrokerCloseCode = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  INTERNAL_ERROR: 1011,
  SESSION_REPLACED: 4001,
  PROTOCOL_ERROR: 4002,
  AUTH_FAILED: 4003,
  CAPACITY: 4004,
  REPLAY_REQUIRED: 4009,
} as const);

/** ASCII machine reasons stay below the WebSocket close-frame reason limit. */
export const BrokerCloseReason = Object.freeze({
  STOPPING: 'STOPPING',
  SERVER_STOPPED: 'SERVER_STOPPED',
  SESSION_REPLACED: 'SESSION_REPLACED',
  PROTOCOL_ERROR: 'PROTOCOL_ERROR',
  TRANSPORT_ERROR: 'TRANSPORT_ERROR',
  TRANSPORT_FAILED: 'TRANSPORT_FAILED',
  AUTHENTICATION_REJECTED: 'AUTHENTICATION_REJECTED',
  HANDSHAKE_TIMEOUT: 'HANDSHAKE_TIMEOUT',
  LEASE_GRANT_TIMEOUT: 'LEASE_GRANT_TIMEOUT',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  INSTALLATION_REVOKED: 'INSTALLATION_REVOKED',
  WORKER_INCOMPATIBLE: 'WORKER_INCOMPATIBLE',
  NOT_ACCEPTING: 'NOT_ACCEPTING',
  TRANSPORT_CAPACITY: 'TRANSPORT_CAPACITY',
  REPLAY_REQUIRED: 'REPLAY_REQUIRED',
  LEASE_EXPIRED: 'LEASE_EXPIRED',
  AUTHORITY_FAILED: 'AUTHORITY_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const);
export type BrokerCloseReason = (typeof BrokerCloseReason)[keyof typeof BrokerCloseReason];

export const BrokerAuthenticationFailureCode = Object.freeze({
  AUTHENTICATION_REJECTED: BrokerCloseReason.AUTHENTICATION_REJECTED,
  SESSION_EXPIRED: BrokerCloseReason.SESSION_EXPIRED,
  INSTALLATION_REVOKED: BrokerCloseReason.INSTALLATION_REVOKED,
  WORKER_INCOMPATIBLE: BrokerCloseReason.WORKER_INCOMPATIBLE,
} as const);
export type BrokerAuthenticationFailureCode =
  (typeof BrokerAuthenticationFailureCode)[keyof typeof BrokerAuthenticationFailureCode];

/** Durable auth adapters throw this exact type so Gateway can send a machine-readable close. */
export class BrokerAuthenticationError extends Error {
  constructor(readonly code: BrokerAuthenticationFailureCode) {
    if (!Object.values(BrokerAuthenticationFailureCode).includes(code)) {
      throw new TypeError('INVALID_BROKER_AUTHENTICATION_FAILURE_CODE');
    }
    super(code);
    this.name = 'BrokerAuthenticationError';
  }
}

export type BrokerCloseDisposition = 'RETRY' | 'BLOCK';

/** Remote close policy is shared protocol authority, never inferred from free-form logging text. */
export function classifyBrokerRemoteClose(code: number, reason: string): BrokerCloseDisposition {
  if (
    code === BrokerCloseCode.NORMAL ||
    code === BrokerCloseCode.GOING_AWAY ||
    code === BrokerCloseCode.INTERNAL_ERROR ||
    code === BrokerCloseCode.CAPACITY ||
    code === BrokerCloseCode.REPLAY_REQUIRED ||
    code === 1006
  ) {
    return 'RETRY';
  }
  if (code === BrokerCloseCode.AUTH_FAILED) {
    return reason === BrokerCloseReason.SESSION_EXPIRED ||
      reason === BrokerCloseReason.HANDSHAKE_TIMEOUT ||
      reason === BrokerCloseReason.LEASE_GRANT_TIMEOUT
      ? 'RETRY'
      : 'BLOCK';
  }
  if (code === BrokerCloseCode.SESSION_REPLACED || code === BrokerCloseCode.PROTOCOL_ERROR) {
    return 'BLOCK';
  }
  return code >= 4000 && code <= 4999 ? 'BLOCK' : 'RETRY';
}

export const BrokerCapacitySchema = z
  .object({
    maxActiveConversations: z.literal(1),
    maxActiveTurns: z.literal(1),
  })
  .strict();

const BrokerHandshakeUnsignedShape = {
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
};

export const BrokerHandshakeUnsignedSchema = z.object(BrokerHandshakeUnsignedShape).strict();
export type BrokerHandshakeUnsigned = z.infer<typeof BrokerHandshakeUnsignedSchema>;

export const BrokerHandshakeSchema = z
  .object({
    ...BrokerHandshakeUnsignedShape,
    challengeSignature: Base64UrlSchema.min(32).max(256),
  })
  .strict();
export type BrokerHandshake = z.infer<typeof BrokerHandshakeSchema>;

/** DeviceSigner 只签固定字段的 RFC 8785 canonical bytes，不接触 JSON 字符串拼装。 */
export function brokerHandshakeSigningBytes(handshake: BrokerHandshakeUnsigned): Buffer {
  return Buffer.from(canonicalizeJson(BrokerHandshakeUnsignedSchema.parse(handshake)), 'utf8');
}

export const LeaseBindingSchema = z
  .object({
    deploymentId: UuidSchema,
    leaseId: UuidSchema,
    workerSessionId: UuidSchema,
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
export const BrokerSensitiveMessageAadSchema = z
  .object({
    protocol: z.literal(CREATOR_BROKER_PROTOCOL),
    schemaVersion: z.literal(1),
    envelopeType: z.enum(['invocation.prepare', 'invocation.delta', 'invocation.succeeded']),
    messageId: UuidSchema,
    conversationId: UuidSchema,
    invocationId: UuidSchema,
    workerSessionId: UuidSchema,
    role: z.enum(['USER', 'ASSISTANT']),
    keyId: z.string().regex(/^[a-z0-9][a-z0-9._:-]{2,127}$/u),
  })
  .strict();
export type BrokerSensitiveMessageAad = z.infer<typeof BrokerSensitiveMessageAadSchema>;

export function brokerSensitiveMessageAadBytes(aad: BrokerSensitiveMessageAad): Buffer {
  return Buffer.from(canonicalizeJson(BrokerSensitiveMessageAadSchema.parse(aad)), 'utf8');
}

export function brokerSensitiveMessageAadDigest(aad: BrokerSensitiveMessageAad): string {
  return canonicalSha256(BrokerSensitiveMessageAadSchema.parse(aad));
}

export function brokerSensitiveMessageCipherDigest(
  nonce: string,
  ciphertext: string,
  authTag: string,
): string {
  const fields = [
    CanonicalBase64UrlBytesSchema(12, 12).parse(nonce),
    CanonicalBase64UrlBytesSchema(1, 49_152).parse(ciphertext),
    CanonicalBase64UrlBytesSchema(16, 16).parse(authTag),
  ];
  return canonicalSha256({
    protocol: CREATOR_BROKER_PROTOCOL,
    schemaVersion: 1,
    nonce: fields[0],
    ciphertext: fields[1],
    authTag: fields[2],
  });
}

/**
 * Broker 内的 Prompt/delta/final 不能使用明文 JSON 字段。Cloud 与 Worker Keychain
 * 共同持有按安装轮换的 session content key；TLS 仍是传输层，不替代此 AEAD。
 */
export const BrokerSensitiveMessageSchema = z
  .object({
    algorithm: z.literal('aes-256-gcm/v1'),
    keyScope: z.literal('worker-session'),
    keyId: z.string().regex(/^[a-z0-9][a-z0-9._:-]{2,127}$/u),
    nonce: CanonicalBase64UrlBytesSchema(12, 12),
    ciphertext: CanonicalBase64UrlBytesSchema(1, 49_152),
    authTag: CanonicalBase64UrlBytesSchema(16, 16),
    cipherDigest: Sha256HexSchema,
    aad: BrokerSensitiveMessageAadSchema,
    aadDigest: Sha256HexSchema,
    aadVersion: z.literal(1),
  })
  .strict()
  .superRefine((message, context) => {
    if (
      message.cipherDigest !==
      brokerSensitiveMessageCipherDigest(message.nonce, message.ciphertext, message.authTag)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cipherDigest'],
        message: 'cipherDigest 必须绑定 nonce/ciphertext/authTag canonical bytes',
      });
    }
    if (message.aadDigest !== brokerSensitiveMessageAadDigest(message.aad)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aadDigest'],
        message: 'aadDigest 必须绑定 exact Broker message context',
      });
    }
    if (message.keyId !== message.aad.keyId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aad', 'keyId'],
        message: 'AEAD keyId 必须与 AAD 一致',
      });
    }
  });
export type BrokerSensitiveMessage = z.infer<typeof BrokerSensitiveMessageSchema>;

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
        userMessageCiphertext: BrokerSensitiveMessageSchema,
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
        conversationId: UuidSchema,
        deltaSequence: Uint63StringSchema,
        deltaCiphertext: BrokerSensitiveMessageSchema,
      })
      .strict(),
  ),
  event(
    'invocation.succeeded',
    z
      .object({
        invocationId: UuidSchema,
        conversationId: UuidSchema,
        resultDigest: HmacSha256DigestSchema,
        resultCiphertext: BrokerSensitiveMessageSchema,
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
    let sensitive: BrokerSensitiveMessage | undefined;
    let conversationId: string | undefined;
    let invocationId: string | undefined;
    let expectedRole: 'USER' | 'ASSISTANT' | undefined;
    if (envelope.type === 'invocation.prepare') {
      sensitive = envelope.body.userMessageCiphertext;
      conversationId = envelope.body.conversationId;
      invocationId = envelope.body.invocationId;
      expectedRole = 'USER';
    } else if (envelope.type === 'invocation.delta') {
      sensitive = envelope.body.deltaCiphertext;
      invocationId = envelope.body.invocationId;
      conversationId = envelope.body.conversationId;
      expectedRole = 'ASSISTANT';
    } else if (envelope.type === 'invocation.succeeded') {
      sensitive = envelope.body.resultCiphertext;
      invocationId = envelope.body.invocationId;
      conversationId = envelope.body.conversationId;
      expectedRole = 'ASSISTANT';
    }
    if (
      sensitive !== undefined &&
      (sensitive.aad.envelopeType !== envelope.type ||
        sensitive.aad.messageId !== envelope.messageId ||
        sensitive.aad.conversationId !== conversationId ||
        sensitive.aad.invocationId !== invocationId ||
        sensitive.aad.workerSessionId !== envelope.lease.workerSessionId ||
        sensitive.aad.role !== expectedRole)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['body'],
        message: '敏感 Broker payload 的 AEAD AAD 必须绑定 exact envelope/message/context/role',
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
