import { z } from 'zod';
import { AgentVersionManifestSchema } from './agent-version.js';
import { InvocationStateSchema, VnextErrorResponseSchema } from './invocation.js';
import {
  HmacSha256DigestSchema,
  IsoDateTimeSchema,
  Sha256HexSchema,
  Uint63StringSchema,
  Utf8TextSchema,
  UuidSchema,
} from './primitives.js';
import {
  SNAPSHOT_MAX_COMPRESSED_BYTES,
  SNAPSHOT_MAX_EXPANDED_BYTES,
  SNAPSHOT_MAX_FILES,
} from './snapshot.js';

export const CREATOR_AGENT_HTTP_PROTOCOL = 'combo.creator-agent-http/1' as const;
export const IdempotencyKeySchema = UuidSchema;

export const SnapshotUploadCreateRequestSchema = z
  .object({
    snapshotDigest: Sha256HexSchema,
    archiveDigest: Sha256HexSchema,
    compressedBytes: z.number().int().min(1).max(SNAPSHOT_MAX_COMPRESSED_BYTES),
    expandedBytes: z.number().int().min(1).max(SNAPSHOT_MAX_EXPANDED_BYTES),
    fileCount: z.number().int().min(1).max(SNAPSHOT_MAX_FILES),
  })
  .strict();

export const SnapshotUploadCreateResponseSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_HTTP_PROTOCOL),
    uploadId: UuidSchema,
    state: z.literal('CREATED'),
    putUrl: z
      .string()
      .url()
      .refine((value) => value.startsWith('https://'), '只允许 HTTPS Signed URL'),
    requiredHeaders: z
      .object({
        contentLength: z
          .number()
          .int()
          .min(1)
          .max(SNAPSHOT_MAX_COMPRESSED_BYTES + 1_048_576),
        checksumSha256: Sha256HexSchema,
      })
      .strict(),
    expiresAt: IsoDateTimeSchema,
  })
  .strict();

export const SnapshotUploadCompleteRequestSchema = z
  .object({
    cipherDigest: Sha256HexSchema,
    encryptedBytes: z
      .number()
      .int()
      .min(1)
      .max(SNAPSHOT_MAX_COMPRESSED_BYTES + 1_048_576),
  })
  .strict();

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
    errorCode: z.string().max(128).nullable(),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const CreateAgentRequestSchema = z
  .object({ name: Utf8TextSchema(120), description: Utf8TextSchema(1_024) })
  .strict();

export const AgentViewSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_HTTP_PROTOCOL),
    agentId: UuidSchema,
    publicSlug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$/u),
    name: Utf8TextSchema(120),
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
    lastErrorCode: z.string().max(128).nullable(),
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
    clientMessageId: UuidSchema,
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
export const RetryInvocationRequestSchema = z.object({ clientMessageId: UuidSchema }).strict();

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
