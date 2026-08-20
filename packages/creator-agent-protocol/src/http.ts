import { z } from 'zod';
import { AgentVersionManifestSchema } from './agent-version.js';
import {
  ProtocolRawInputError,
  canonicalizeJson,
  parseJsonNoDuplicateKeys,
  sha256Hex,
} from './canonical.js';
import { ConsumerTerminalEventPayloadSchema } from './consumer-events.js';
import { InvocationStateSchema, VnextErrorResponseSchema } from './invocation.js';
import {
  CanonicalSha256Base64Schema,
  ClientIdempotencyKeySchema,
  HmacSha256DigestSchema,
  IsoDateTimeSchema,
  Sha256HexSchema,
  StrictUnicodeCodePointStringSchema,
  StrictUtf8TextSchema,
  UINT63_DECIMAL_PATTERN_SOURCE,
  UNICODE_SCALAR_NO_CONTROL_PATTERN,
  Uint63StringSchema,
  Utf8TextSchema,
  UuidSchema,
} from './primitives.js';
import {
  SNAPSHOT_OBJECT_STORAGE_PROTOCOL,
  SNAPSHOT_MAX_COMPRESSED_BYTES,
  SNAPSHOT_MAX_EXPANDED_BYTES,
  SNAPSHOT_MAX_FILES,
  SNAPSHOT_MAX_MANIFEST_BYTES,
  SNAPSHOT_EXACT_PUBLICATION_COMMIT_MARKER_BYTES,
  SNAPSHOT_MAX_PUBLICATION_PREPARATION_MARKER_BYTES,
  SNAPSHOT_PUBLICATION_COMMIT_PROTOCOL,
  SNAPSHOT_PUBLICATION_PREPARATION_PROTOCOL,
  SnapshotArchiveEnvelopeSchema,
  SnapshotManifestEnvelopeSchema,
  snapshotPublicationPreparationObjectKey,
} from './snapshot.js';

export const CREATOR_AGENT_HTTP_PROTOCOL = 'combo.creator-agent-http/1' as const;
export const IdempotencyKeySchema = ClientIdempotencyKeySchema;

/** Send/retry HTTP handlers must bind the header and body alias byte-for-byte. */
export function hasExactClientIdempotencyBinding(
  headerValue: unknown,
  bodyClientMessageId: unknown,
): boolean {
  const header = IdempotencyKeySchema.safeParse(headerValue);
  const body = ClientIdempotencyKeySchema.safeParse(bodyClientMessageId);
  return header.success && body.success && header.data === body.data;
}
export const PublicAgentSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$/u);
export const LastEventIdSchema = Uint63StringSchema;
export const DeploymentGenerationEtagSchema = z
  .string()
  .min(14)
  .max(32)
  .regex(new RegExp(`^"generation-(?:${UINT63_DECIMAL_PATTERN_SOURCE})"$`, 'u'));

function checksumForHexDigest(digest: string): string {
  return Buffer.from(digest, 'hex').toString('base64');
}

const SnapshotArchiveUploadDescriptorSchema = z
  .object({
    envelope: SnapshotArchiveEnvelopeSchema,
    checksumSha256: CanonicalSha256Base64Schema,
  })
  .strict()
  .superRefine((descriptor, context) => {
    if (descriptor.checksumSha256 !== checksumForHexDigest(descriptor.envelope.cipherDigest)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checksumSha256'],
        message: 'checksumSha256 必须等于 archive cipherDigest 的 canonical base64',
      });
    }
  });

const SnapshotManifestUploadDescriptorSchema = z
  .object({
    envelope: SnapshotManifestEnvelopeSchema,
    checksumSha256: CanonicalSha256Base64Schema,
  })
  .strict()
  .superRefine((descriptor, context) => {
    if (descriptor.checksumSha256 !== checksumForHexDigest(descriptor.envelope.cipherDigest)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checksumSha256'],
        message: 'checksumSha256 必须等于 manifest cipherDigest 的 canonical base64',
      });
    }
  });

const SnapshotHttpsSignedPutUrlSchema = z
  .string()
  .regex(UNICODE_SCALAR_NO_CONTROL_PATTERN)
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== ''
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Signed PUT URL 必须是无 userinfo/fragment 的 HTTPS URL',
      });
    }
  });

function signedPutObjectLocator(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

export const SnapshotSignedPutHeadersSchema = z
  .object({
    'cache-control': z.literal('no-store'),
    'content-length': z.string().regex(/^[1-9][0-9]{0,7}$/u),
    'content-type': z.literal('application/octet-stream'),
    'if-none-match': z.literal('*'),
    'x-amz-checksum-sha256': CanonicalSha256Base64Schema,
    'x-amz-meta-archive-digest': Sha256HexSchema,
    'x-amz-meta-cipher-bytes': z.string().regex(/^[1-9][0-9]{0,7}$/u),
    'x-amz-meta-cipher-digest': Sha256HexSchema,
    'x-amz-meta-object-kind': z.enum(['archive', 'manifest']),
    'x-amz-meta-object-state': z.literal('upload'),
    'x-amz-meta-protocol': z.literal(SNAPSHOT_OBJECT_STORAGE_PROTOCOL),
    'x-amz-meta-snapshot-digest': Sha256HexSchema,
  })
  .strict();

function createSnapshotSignedPutTargetSchema(
  kind: 'archive' | 'manifest',
  maximumCipherBytes: number,
) {
  return z
    .object({
      method: z.literal('PUT'),
      putUrl: SnapshotHttpsSignedPutUrlSchema,
      cipherBytes: z.number().int().min(37).max(maximumCipherBytes),
      cipherDigest: Sha256HexSchema,
      requiredHeaders: SnapshotSignedPutHeadersSchema.extend({
        'x-amz-meta-object-kind': z.literal(kind),
      }),
    })
    .strict()
    .superRefine((target, context) => {
      if (target.requiredHeaders['content-length'] !== String(target.cipherBytes)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requiredHeaders', 'content-length'],
          message: 'content-length 必须绑定 exact cipherBytes',
        });
      }
      if (target.requiredHeaders['x-amz-meta-cipher-bytes'] !== String(target.cipherBytes)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requiredHeaders', 'x-amz-meta-cipher-bytes'],
          message: 'metadata cipher bytes 必须绑定 exact cipherBytes',
        });
      }
      if (target.requiredHeaders['x-amz-meta-cipher-digest'] !== target.cipherDigest) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requiredHeaders', 'x-amz-meta-cipher-digest'],
          message: 'metadata cipher digest 必须绑定 exact cipherDigest',
        });
      }
      if (
        target.requiredHeaders['x-amz-checksum-sha256'] !==
        checksumForHexDigest(target.cipherDigest)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requiredHeaders', 'x-amz-checksum-sha256'],
          message: 'S3 checksum 必须绑定 exact cipherDigest',
        });
      }
    });
}

export const SnapshotArchiveSignedPutTargetSchema = createSnapshotSignedPutTargetSchema(
  'archive',
  SNAPSHOT_MAX_COMPRESSED_BYTES + 36,
);
export const SnapshotManifestSignedPutTargetSchema = createSnapshotSignedPutTargetSchema(
  'manifest',
  SNAPSHOT_MAX_MANIFEST_BYTES + 36,
);
export const SnapshotSignedPutTargetSchema = z.union([
  SnapshotArchiveSignedPutTargetSchema,
  SnapshotManifestSignedPutTargetSchema,
]);
export type SnapshotSignedPutTarget = z.infer<typeof SnapshotSignedPutTargetSchema>;

export const SnapshotUploadCreateRequestSchema = z
  .object({
    archive: SnapshotArchiveUploadDescriptorSchema,
    manifest: SnapshotManifestUploadDescriptorSchema,
    expandedBytes: z.number().int().min(1).max(SNAPSHOT_MAX_EXPANDED_BYTES),
    fileCount: z.number().int().min(1).max(SNAPSHOT_MAX_FILES),
  })
  .strict()
  .superRefine((request, context) => {
    const archive = request.archive.envelope;
    const manifest = request.manifest.envelope;
    for (const [path, same] of [
      [
        ['manifest', 'envelope', 'aad', 'creatorId'],
        archive.aad.creatorId === manifest.aad.creatorId,
      ],
      [
        ['manifest', 'envelope', 'aad', 'snapshotDigest'],
        archive.aad.snapshotDigest === manifest.aad.snapshotDigest,
      ],
      [['manifest', 'envelope', 'aad', 'keyId'], archive.aad.keyId === manifest.aad.keyId],
      [['manifest', 'envelope', 'wrappedDek'], archive.wrappedDek === manifest.wrappedDek],
    ] as const) {
      if (!same) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path],
          message: 'archive 与 manifest 的 Creator/Snapshot/DEK 绑定必须一致',
        });
      }
    }
    if (archive.nonce === manifest.nonce) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['manifest', 'envelope', 'nonce'],
        message: 'archive 与 manifest 必须使用独立 nonce',
      });
    }
  });
export type SnapshotUploadCreateRequest = z.infer<typeof SnapshotUploadCreateRequestSchema>;

export const SnapshotPublicationPreparationMarkerSchema = z
  .object({
    protocol: z.literal(SNAPSHOT_PUBLICATION_PREPARATION_PROTOCOL),
    schemaVersion: z.literal(1),
    creatorId: UuidSchema,
    snapshotDigest: Sha256HexSchema,
    selectedUploadId: UuidSchema,
    request: SnapshotUploadCreateRequestSchema,
  })
  .strict()
  .superRefine((marker, context) => {
    const archiveAad = marker.request.archive.envelope.aad;
    if (marker.creatorId !== archiveAad.creatorId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['creatorId'],
        message: 'preparation creatorId 必须绑定所选双 Envelope',
      });
    }
    if (marker.snapshotDigest !== archiveAad.snapshotDigest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['snapshotDigest'],
        message: 'preparation snapshotDigest 必须绑定所选双 Envelope',
      });
    }
  });
export type SnapshotPublicationPreparationMarker = z.infer<
  typeof SnapshotPublicationPreparationMarkerSchema
>;

export const SnapshotPublicationCommitMarkerSchema = z
  .object({
    protocol: z.literal(SNAPSHOT_PUBLICATION_COMMIT_PROTOCOL),
    schemaVersion: z.literal(1),
    creatorId: UuidSchema,
    snapshotDigest: Sha256HexSchema,
    preparationKey: StrictUnicodeCodePointStringSchema(1, 512),
    preparationDigest: Sha256HexSchema,
  })
  .strict()
  .superRefine((marker, context) => {
    if (
      marker.preparationKey !==
      snapshotPublicationPreparationObjectKey(marker.creatorId, marker.snapshotDigest)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['preparationKey'],
        message: 'commit preparationKey 必须由 creatorId 和 snapshotDigest 精确派生',
      });
    }
  });
export type SnapshotPublicationCommitMarker = z.infer<typeof SnapshotPublicationCommitMarkerSchema>;

function canonicalPreparationMarkerBytes(value: unknown): Buffer {
  const bytes = Buffer.from(canonicalizeJson(value), 'utf8');
  if (bytes.byteLength > SNAPSHOT_MAX_PUBLICATION_PREPARATION_MARKER_BYTES) {
    throw new TypeError('Snapshot publication preparation marker 超过冻结上限');
  }
  return bytes;
}

function canonicalCommitMarkerBytes(value: unknown): Buffer {
  const bytes = Buffer.from(canonicalizeJson(value), 'utf8');
  if (bytes.byteLength !== SNAPSHOT_EXACT_PUBLICATION_COMMIT_MARKER_BYTES) {
    throw new TypeError('Snapshot publication commit marker 长度不符合冻结值');
  }
  return bytes;
}

function parseCanonicalPublicationMarkerJson(
  bytesInput: Uint8Array,
  kind: 'preparation' | 'commit',
): unknown {
  const hasValidLength =
    bytesInput instanceof Uint8Array &&
    bytesInput.byteLength > 0 &&
    (kind === 'preparation'
      ? bytesInput.byteLength <= SNAPSHOT_MAX_PUBLICATION_PREPARATION_MARKER_BYTES
      : bytesInput.byteLength === SNAPSHOT_EXACT_PUBLICATION_COMMIT_MARKER_BYTES);
  if (!hasValidLength) {
    throw new TypeError('Snapshot publication marker bytes 无效');
  }
  const bytes = Buffer.from(bytesInput);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parsed = parseJsonNoDuplicateKeys(text);
  const canonical = Buffer.from(canonicalizeJson(parsed), 'utf8');
  if (!canonical.equals(bytes)) {
    throw new TypeError('Snapshot publication marker 必须是 exact canonical JCS bytes');
  }
  return parsed;
}

export function snapshotPublicationPreparationMarkerBytes(
  input: SnapshotPublicationPreparationMarker,
): Buffer {
  return canonicalPreparationMarkerBytes(SnapshotPublicationPreparationMarkerSchema.parse(input));
}

export function snapshotPublicationPreparationDigest(
  input: SnapshotPublicationPreparationMarker,
): string {
  return sha256Hex(snapshotPublicationPreparationMarkerBytes(input));
}

export function parseSnapshotPublicationPreparationMarker(
  bytes: Uint8Array,
): SnapshotPublicationPreparationMarker {
  try {
    return SnapshotPublicationPreparationMarkerSchema.parse(
      parseCanonicalPublicationMarkerJson(bytes, 'preparation'),
    );
  } catch {
    throw new ProtocolRawInputError('SNAPSHOT_PREPARATION_MARKER_INVALID');
  }
}

export function snapshotPublicationCommitMarkerBytes(
  input: SnapshotPublicationCommitMarker,
): Buffer {
  return canonicalCommitMarkerBytes(SnapshotPublicationCommitMarkerSchema.parse(input));
}

export function parseSnapshotPublicationCommitMarker(
  bytes: Uint8Array,
): SnapshotPublicationCommitMarker {
  try {
    return SnapshotPublicationCommitMarkerSchema.parse(
      parseCanonicalPublicationMarkerJson(bytes, 'commit'),
    );
  } catch {
    throw new ProtocolRawInputError('SNAPSHOT_COMMIT_MARKER_INVALID');
  }
}

export const SnapshotUploadCreateResponseSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_HTTP_PROTOCOL),
    uploadId: UuidSchema,
    state: z.literal('CREATED'),
    uploads: z
      .object({
        archive: SnapshotArchiveSignedPutTargetSchema,
        manifest: SnapshotManifestSignedPutTargetSchema,
      })
      .strict(),
    expiresAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((response, context) => {
    const archiveHeaders = response.uploads.archive.requiredHeaders;
    const manifestHeaders = response.uploads.manifest.requiredHeaders;
    for (const header of ['x-amz-meta-archive-digest', 'x-amz-meta-snapshot-digest'] as const) {
      if (archiveHeaders[header] !== manifestHeaders[header]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['uploads', 'manifest', 'requiredHeaders', header],
          message: `${header} 必须在两个 Signed PUT target 中一致`,
        });
      }
    }
    if (
      signedPutObjectLocator(response.uploads.archive.putUrl) ===
      signedPutObjectLocator(response.uploads.manifest.putUrl)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['uploads', 'manifest', 'putUrl'],
        message: 'archive 与 manifest 必须使用不同 temp object locator',
      });
    }
  });
export type SnapshotUploadCreateResponse = z.infer<typeof SnapshotUploadCreateResponseSchema>;

export const SnapshotUploadCompleteRequestSchema = z.object({}).strict();

export const SnapshotUploadStateSchema = z.enum([
  'CREATED',
  'UPLOADED',
  'VERIFYING',
  'VERIFIED',
  'REJECTED',
  'EXPIRED',
]);

export const SnapshotUploadViewSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_HTTP_PROTOCOL),
    uploadId: UuidSchema,
    state: SnapshotUploadStateSchema,
    snapshotId: UuidSchema.nullable(),
    snapshotDigest: Sha256HexSchema,
    errorCode: StrictUnicodeCodePointStringSchema(0, 128).nullable(),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const CreateAgentRequestSchema = z
  .object({ name: StrictUtf8TextSchema(120), description: Utf8TextSchema(1_024) })
  .strict();

export const AgentViewSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_HTTP_PROTOCOL),
    agentId: UuidSchema,
    publicSlug: PublicAgentSlugSchema,
    name: StrictUtf8TextSchema(120),
    description: Utf8TextSchema(1_024),
    lifecycle: z.enum(['ACTIVE', 'ARCHIVED']),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export const CreateAgentVersionRequestSchema = z
  .object({
    verifiedSnapshotId: UuidSchema,
    manifest: AgentVersionManifestSchema,
  })
  .strict();

export const AgentVersionViewSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_HTTP_PROTOCOL),
    agentVersionId: UuidSchema,
    agentId: UuidSchema,
    ordinal: z.number().int().min(1),
    versionDigest: Sha256HexSchema,
    snapshotDigest: Sha256HexSchema,
    availability: z.enum(['ACTIVE', 'DEPRECATED', 'REVOKED']),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export const DeploymentMutationSchema = z.discriminatedUnion('desiredState', [
  z
    .object({
      desiredState: z.literal('ONLINE'),
      desiredVersionId: UuidSchema,
    })
    .strict(),
  z
    .object({
      desiredState: z.literal('OFFLINE'),
      mode: z.enum(['DRAIN', 'IMMEDIATE']),
    })
    .strict(),
]);

export const DeploymentViewSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_HTTP_PROTOCOL),
    agentId: UuidSchema,
    desiredState: z.enum(['ONLINE', 'OFFLINE']),
    desiredVersionId: UuidSchema.nullable(),
    servingVersionId: UuidSchema.nullable(),
    observedState: z.enum([
      'OFFLINE',
      'PREPARING',
      'ONLINE',
      'UPDATING',
      'DRAINING',
      'DEGRADED',
      'BLOCKED',
    ]),
    generation: Uint63StringSchema,
    lastErrorCode: StrictUnicodeCodePointStringSchema(0, 128).nullable(),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const CreateConversationRequestSchema = z.object({}).strict();

export const ConversationStateSchema = z.enum([
  'OPENING',
  'IDLE',
  'BUSY',
  'SUSPENDED',
  'CLOSING',
  'CLOSED',
  'FAILED',
  'EXPIRED',
]);

export const ConversationViewSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_HTTP_PROTOCOL),
    conversationId: UuidSchema,
    agentId: UuidSchema,
    agentVersionId: UuidSchema,
    versionDigest: Sha256HexSchema,
    state: ConversationStateSchema,
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
  })
  .strict();

export const SendConversationMessageRequestSchema = z
  .object({
    clientMessageId: ClientIdempotencyKeySchema,
    text: Utf8TextSchema(16_384),
  })
  .strict();

export const InvocationAcceptedResponseSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_HTTP_PROTOCOL),
    invocationId: UuidSchema,
    state: z.enum(['ACCEPTED', 'QUEUED']),
  })
  .strict();

export const InvocationViewSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_HTTP_PROTOCOL),
    invocationId: UuidSchema,
    conversationId: UuidSchema,
    state: InvocationStateSchema,
    resultDigest: HmacSha256DigestSchema.nullable(),
    error: VnextErrorResponseSchema.nullable(),
    retryOfInvocationId: UuidSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    terminalAt: IsoDateTimeSchema.nullable(),
  })
  .strict();

export const CancelInvocationRequestSchema = z.object({}).strict();
export const RetryInvocationRequestSchema = z
  .object({ clientMessageId: ClientIdempotencyKeySchema })
  .strict();

export const PublicHttpRequestRootNameSchema = z.enum([
  'SnapshotUploadCreateRequest',
  'SnapshotUploadCompleteRequest',
  'CreateAgentRequest',
  'CreateAgentVersionRequest',
  'DeploymentMutation',
  'CreateConversationRequest',
  'SendConversationMessageRequest',
  'CancelInvocationRequest',
  'RetryInvocationRequest',
]);
export type PublicHttpRequestRootName = z.infer<typeof PublicHttpRequestRootNameSchema>;

const PublicHttpRequestRootSchemas = {
  SnapshotUploadCreateRequest: SnapshotUploadCreateRequestSchema,
  SnapshotUploadCompleteRequest: SnapshotUploadCompleteRequestSchema,
  CreateAgentRequest: CreateAgentRequestSchema,
  CreateAgentVersionRequest: CreateAgentVersionRequestSchema,
  DeploymentMutation: DeploymentMutationSchema,
  CreateConversationRequest: CreateConversationRequestSchema,
  SendConversationMessageRequest: SendConversationMessageRequestSchema,
  CancelInvocationRequest: CancelInvocationRequestSchema,
  RetryInvocationRequest: RetryInvocationRequestSchema,
} as const satisfies Record<PublicHttpRequestRootName, z.ZodTypeAny>;

/** Stable post-JSON public boundary: never exposes Zod issues, input, or a nested cause. */
export class PublicHttpRequestValidationError extends Error {
  override readonly name = 'PublicHttpRequestValidationError';
  readonly code = 'PUBLIC_HTTP_REQUEST_INVALID' as const;

  constructor() {
    super('PUBLIC_HTTP_REQUEST_INVALID');
  }
}

export function parsePublicHttpRequestRoot(
  root: PublicHttpRequestRootName,
  input: unknown,
): unknown {
  try {
    const parsed = PublicHttpRequestRootSchemas[root].safeParse(input);
    if (!parsed.success) throw new PublicHttpRequestValidationError();
    return parsed.data;
  } catch {
    throw new PublicHttpRequestValidationError();
  }
}

export const ConsumerMessageSchema = z
  .object({
    messageId: UuidSchema,
    invocationId: UuidSchema.nullable(),
    turnNo: z.number().int().min(1).max(20),
    role: z.enum(['USER', 'ASSISTANT']),
    text: Utf8TextSchema(32_768),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export const ConversationTranscriptSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_HTTP_PROTOCOL),
    conversation: ConversationViewSchema,
    messages: z.array(ConsumerMessageSchema).max(40),
    latestEventId: Uint63StringSchema,
  })
  .strict();

export const ConsumerEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      id: Uint63StringSchema,
      type: z.literal('invocation.state'),
      invocationId: UuidSchema,
      state: InvocationStateSchema,
      occurredAt: IsoDateTimeSchema,
    })
    .strict(),
  z
    .object({
      id: Uint63StringSchema,
      type: z.literal('invocation.delta'),
      invocationId: UuidSchema,
      text: Utf8TextSchema(8_192),
      occurredAt: IsoDateTimeSchema,
    })
    .strict(),
  z
    .object({
      id: Uint63StringSchema,
      type: z.literal('conversation.message'),
      message: ConsumerMessageSchema,
      occurredAt: IsoDateTimeSchema,
    })
    .strict(),
  z
    .object({
      id: Uint63StringSchema,
      type: z.literal('conversation.presence'),
      status: z.enum(['ONLINE', 'BUSY', 'OFFLINE']),
      occurredAt: IsoDateTimeSchema,
    })
    .strict(),
  z
    .object({
      id: Uint63StringSchema,
      type: z.literal('invocation.terminal'),
      payload: ConsumerTerminalEventPayloadSchema,
    })
    .strict(),
]);

export const HttpContractSchemas = {
  SnapshotUploadCreateRequest: SnapshotUploadCreateRequestSchema,
  SnapshotUploadCreateResponse: SnapshotUploadCreateResponseSchema,
  SnapshotUploadCompleteRequest: SnapshotUploadCompleteRequestSchema,
  SnapshotUploadView: SnapshotUploadViewSchema,
  CreateAgentRequest: CreateAgentRequestSchema,
  AgentView: AgentViewSchema,
  CreateAgentVersionRequest: CreateAgentVersionRequestSchema,
  AgentVersionView: AgentVersionViewSchema,
  DeploymentMutation: DeploymentMutationSchema,
  DeploymentView: DeploymentViewSchema,
  CreateConversationRequest: CreateConversationRequestSchema,
  ConversationView: ConversationViewSchema,
  SendConversationMessageRequest: SendConversationMessageRequestSchema,
  InvocationAcceptedResponse: InvocationAcceptedResponseSchema,
  InvocationView: InvocationViewSchema,
  CancelInvocationRequest: CancelInvocationRequestSchema,
  RetryInvocationRequest: RetryInvocationRequestSchema,
  ConversationTranscript: ConversationTranscriptSchema,
  ConsumerEvent: ConsumerEventSchema,
  VnextErrorResponse: VnextErrorResponseSchema,
} as const;
