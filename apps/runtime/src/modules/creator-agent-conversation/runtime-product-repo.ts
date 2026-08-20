import {
  ConversationTranscriptSchema,
  ConversationViewSchema,
  ExecutionCapabilitySchema,
  HmacSha256DigestSchema,
  InvocationAcceptedResponseSchema,
  InvocationStateSchema,
  InvocationViewSchema,
  ModelIdSchema,
  SendConversationMessageRequestSchema,
  UuidSchema,
  VnextErrorCodeSchema,
  errorResponseFor,
  executionCapabilityDigest,
  type VnextErrorCode,
} from '@cb/creator-agent-protocol';
import { EncryptedMessageSchema, MessageAadSchema } from '@cb/creator-agent-persistence';
import { z } from 'zod';

import { withTransaction, type RuntimeDb } from '../../platform/infra/db.js';
import type { ConsumerMessageAuthority } from './consumer-message-authority.js';
import type { InvocationPrepareAuthority } from './invocation-prepare-authority.js';

const SendInputSchema = SendConversationMessageRequestSchema.extend({
  consumerId: z.string().uuid(),
  conversationId: UuidSchema,
}).strict();

const ReadConversationInputSchema = z
  .object({ consumerId: z.string().uuid(), conversationId: UuidSchema })
  .strict();
const ReadInvocationInputSchema = z
  .object({
    consumerId: z.string().uuid(),
    invocationId: UuidSchema,
    requestId: z.string().min(8).max(128),
  })
  .strict();

export interface ServerIdAuthority {
  issue(count: number, signal: AbortSignal): Promise<readonly string[]>;
}

export interface ConsumerRuntimeProductAuthorities {
  readonly message: ConsumerMessageAuthority;
  readonly invocationPrepare: InvocationPrepareAuthority;
  readonly serverIds: ServerIdAuthority;
}

export class ConsumerRuntimeProductError extends Error {
  public constructor(public readonly code: VnextErrorCode) {
    super(code);
    this.name = 'ConsumerRuntimeProductError';
  }
}

interface ConversationLocatorRow {
  id: string;
  agent_id: string;
  agent_version_id: string;
  creator_id: string;
  version_digest: string;
  state: string;
  created_at: Date | string;
  expires_at: Date | string;
}

interface PreflightRow {
  outcome: string;
  existing_invocation_id: string | null;
  existing_state: string | null;
  creator_id: string | null;
  deployment_id: string | null;
  agent_version_id: string | null;
  agent_version_digest: string | null;
  snapshot_digest: string | null;
  installation_id: string | null;
  lease_id: string | null;
  fence: string | number | bigint | null;
  capability_not_before: Date | string | null;
  deadline_at: Date | string | null;
  capability_expires_at: Date | string | null;
  resolved_model: string | null;
  reasoning_effort: string | null;
}

interface FinalizeRow {
  finalize_outcome: string;
  invocation_id: string | null;
  invocation_state: string | null;
}

interface MessageRow {
  id: string;
  invocation_id: string | null;
  turn_no: number;
  role: string;
  content_algorithm: string;
  content_key_id: string;
  content_nonce: Buffer;
  content_ciphertext: Buffer;
  content_auth_tag: Buffer;
  content_cipher_digest: string;
  content_digest: string;
  content_aad_version: number;
  created_at: Date | string;
}

interface InvocationRow {
  id: string;
  conversation_id: string;
  creator_id: string;
  state: string;
  result_digest: string | null;
  error_code: string | null;
  retry_of_invocation_id: string | null;
  created_at: Date | string;
  terminal_at: Date | string | null;
}

function isoDate(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error('invalid database timestamp');
  return parsed.toISOString();
}

function acceptedState(state: string | null) {
  return state === 'ACCEPTED' ? 'ACCEPTED' : 'QUEUED';
}

function unavailable(): ConsumerRuntimeProductError {
  return new ConsumerRuntimeProductError('AGENT_OFFLINE');
}

export function createPostgresServerIdAuthority(db: RuntimeDb): ServerIdAuthority {
  const authority: ServerIdAuthority = {
    async issue(count: number, signal: AbortSignal) {
      if (count !== 8) throw unavailable();
      const result = await db.query<{ ordinal: number; id: string }>(
        `SELECT ordinal, id
           FROM creator_agent_issue_runtime_product_ids_v2($1)
          ORDER BY ordinal`,
        [count],
        signal,
      );
      const ids = result.rows.map(({ id }) => UuidSchema.parse(id));
      if (
        ids.length !== count ||
        new Set(ids).size !== count ||
        result.rows.some((row, index) => row.ordinal !== index + 1)
      ) {
        throw unavailable();
      }
      return Object.freeze(ids);
    },
  };
  return Object.freeze(authority);
}

export async function sendConsumerMessage(
  db: RuntimeDb,
  rawInput: z.input<typeof SendInputSchema>,
  authorities: ConsumerRuntimeProductAuthorities,
) {
  const input = SendInputSchema.parse(rawInput);
  const operationSignal = AbortSignal.timeout(10_000);
  const creatorId = await withTransaction(
    db,
    async (tx) => {
      await tx.query(`SELECT set_config('app.consumer_id', $1, true)`, [input.consumerId]);
      const locator = await tx.query<Pick<ConversationLocatorRow, 'creator_id'>>(
        `SELECT creator_id
           FROM agent_conversations
          WHERE id = $1 AND consumer_subject_id = $2`,
        [input.conversationId, input.consumerId],
      );
      const resolved = locator.rows[0]?.creator_id;
      if (!resolved) throw new ConsumerRuntimeProductError('FORBIDDEN');
      return UuidSchema.parse(resolved);
    },
    { signal: AbortSignal.timeout(2_000), timeoutMs: 2_000, readOnlySnapshot: true },
  );

  // The request HMAC is the minimum cryptographic work required to distinguish a replay from a
  // same-key/different-body conflict. Sealing, IDs and signing remain strictly after preflight.
  const boundMessage = await authorities.message.bindUserMessage({
    creatorId,
    text: input.text,
    signal: operationSignal,
  });
  const requestDigest = HmacSha256DigestSchema.parse(boundMessage.requestDigest);
  const preflight = await withTransaction(
    db,
    async (tx) => {
      await tx.query(`SELECT set_config('app.consumer_id', $1, true)`, [input.consumerId]);
      await tx.query(`SELECT set_config('app.creator_id', $1, true)`, [creatorId]);
      const preflightResult = await tx.query<PreflightRow>(
        `SELECT * FROM creator_agent_preflight_consumer_message_v2($1, $2, $3, $4)`,
        [input.conversationId, input.consumerId, input.clientMessageId, requestDigest],
      );
      const row = preflightResult.rows[0];
      if (!row) throw unavailable();
      return row;
    },
    { signal: AbortSignal.timeout(2_000), timeoutMs: 2_000 },
  );
  if (preflight.outcome === 'CONFLICT') {
    throw new ConsumerRuntimeProductError('IDEMPOTENCY_CONFLICT');
  }
  if (preflight.outcome === 'REPLAY') {
    if (!preflight.existing_invocation_id) throw unavailable();
    return InvocationAcceptedResponseSchema.parse({
      protocol: 'combo.creator-agent-http/1',
      invocationId: preflight.existing_invocation_id,
      state: acceptedState(preflight.existing_state),
    });
  }
  if (preflight.outcome !== 'READY') throw unavailable();

  const authority = ReadyPreflightSchema.parse({
    creatorId: preflight.creator_id,
    deploymentId: preflight.deployment_id,
    agentVersionId: preflight.agent_version_id,
    agentVersionDigest: preflight.agent_version_digest,
    snapshotDigest: preflight.snapshot_digest,
    installationId: preflight.installation_id,
    leaseId: preflight.lease_id,
    fence: preflight.fence === null ? null : String(preflight.fence),
    notBefore: preflight.capability_not_before && isoDate(preflight.capability_not_before),
    deadlineAt: preflight.deadline_at && isoDate(preflight.deadline_at),
    capabilityExpiresAt:
      preflight.capability_expires_at && isoDate(preflight.capability_expires_at),
    model: preflight.resolved_model,
    reasoningEffort: preflight.reasoning_effort,
  });
  if (authority.creatorId !== creatorId) throw unavailable();

  const [
    messageId,
    invocationId,
    prepareCommandId,
    acceptedEventId,
    queuedEventId,
    leasedEventId,
    capabilityId,
    providerRequestId,
  ] = await authorities.serverIds.issue(8, operationSignal);
  if (
    !messageId ||
    !invocationId ||
    !prepareCommandId ||
    !acceptedEventId ||
    !queuedEventId ||
    !leasedEventId ||
    !capabilityId ||
    !providerRequestId
  ) {
    throw unavailable();
  }
  const encrypted = EncryptedMessageSchema.parse(
    await boundMessage.seal({
      conversationId: input.conversationId,
      messageId,
      signal: operationSignal,
    }),
  );
  const prepared = await authorities.invocationPrepare.prepare({
    capabilityId,
    providerRequestId,
    invocationId,
    conversationId: input.conversationId,
    deploymentId: authority.deploymentId,
    agentVersionId: authority.agentVersionId,
    agentVersionDigest: authority.agentVersionDigest,
    installationId: authority.installationId,
    leaseId: authority.leaseId,
    fence: authority.fence,
    requestDigest,
    model: authority.model,
    reasoningEffort: authority.reasoningEffort,
    notBefore: authority.notBefore,
    expiresAt: authority.capabilityExpiresAt,
    signal: operationSignal,
  });
  // Do not let an adapter-supplied digest become SQL authority. Parse and recompute it here.
  const capability = ExecutionCapabilitySchema.parse(prepared.capability);
  const capabilityDigest = executionCapabilityDigest(capability);
  if (capabilityDigest !== prepared.capabilityDigest) {
    throw new ConsumerRuntimeProductError('EXECUTION_CAPABILITY_INVALID');
  }

  const finalized = await withTransaction(
    db,
    async (tx) => {
      await tx.query(`SELECT set_config('app.consumer_id', $1, true)`, [input.consumerId]);
      await tx.query(`SELECT set_config('app.creator_id', $1, true)`, [creatorId]);
      const finalizedResult = await tx.query<FinalizeRow>(
        `SELECT * FROM creator_agent_finalize_consumer_message_v2(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
         )`,
        [
          input.conversationId,
          input.consumerId,
          messageId,
          invocationId,
          prepareCommandId,
          acceptedEventId,
          queuedEventId,
          leasedEventId,
          input.clientMessageId,
          requestDigest,
          encrypted.algorithm,
          encrypted.keyId,
          encrypted.nonce,
          encrypted.ciphertext,
          encrypted.authTag,
          encrypted.cipherDigest,
          encrypted.contentDigest,
          encrypted.aadVersion,
          capability,
          capabilityDigest,
        ],
      );
      const row = finalizedResult.rows[0];
      if (!row) throw unavailable();
      return row;
    },
    { signal: AbortSignal.timeout(2_000), timeoutMs: 2_000 },
  );
  if (finalized.finalize_outcome === 'CONFLICT') {
    throw new ConsumerRuntimeProductError('IDEMPOTENCY_CONFLICT');
  }
  if (finalized.finalize_outcome === 'CONTEXT_LIMIT') {
    throw new ConsumerRuntimeProductError('CONVERSATION_CONTEXT_LIMIT');
  }
  if (finalized.finalize_outcome === 'AUTHORITY_REJECTED') {
    throw new ConsumerRuntimeProductError('EXECUTION_CAPABILITY_INVALID');
  }
  if (!['ADMITTED', 'REPLAY'].includes(finalized.finalize_outcome) || !finalized.invocation_id) {
    throw unavailable();
  }
  return InvocationAcceptedResponseSchema.parse({
    protocol: 'combo.creator-agent-http/1',
    invocationId: finalized.invocation_id,
    state: acceptedState(finalized.invocation_state),
  });
}

const ReadyPreflightSchema = z
  .object({
    creatorId: UuidSchema,
    deploymentId: UuidSchema,
    agentVersionId: UuidSchema,
    agentVersionDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    installationId: UuidSchema,
    leaseId: UuidSchema,
    fence: z.string().regex(/^(?:[1-9][0-9]{0,18})$/u),
    notBefore: z.string().datetime({ offset: true }),
    deadlineAt: z.string().datetime({ offset: true }),
    capabilityExpiresAt: z.string().datetime({ offset: true }),
    model: ModelIdSchema,
    reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']),
  })
  .strict();

export async function readConsumerConversationTranscript(
  db: RuntimeDb,
  rawInput: z.input<typeof ReadConversationInputSchema>,
  messageAuthority: ConsumerMessageAuthority,
) {
  const input = ReadConversationInputSchema.parse(rawInput);
  const snapshot = await withTransaction(
    db,
    async (tx) => {
      await tx.query(`SELECT set_config('app.consumer_id', $1, true)`, [input.consumerId]);
      const located = await tx.query<ConversationLocatorRow>(
        `SELECT id, agent_id, agent_version_id, creator_id, version_digest,
                state, created_at, expires_at
           FROM agent_conversations
          WHERE id = $1 AND consumer_subject_id = $2`,
        [input.conversationId, input.consumerId],
      );
      const conversation = located.rows[0];
      if (!conversation) throw new ConsumerRuntimeProductError('FORBIDDEN');
      await tx.query(`SELECT set_config('app.creator_id', $1, true)`, [conversation.creator_id]);
      const [messagesResult, streamResult] = await Promise.all([
        tx.query<MessageRow>(
          `SELECT id, invocation_id, turn_no, role, content_algorithm, content_key_id,
                  content_nonce, content_ciphertext, content_auth_tag,
                  content_cipher_digest, content_digest, content_aad_version, created_at
             FROM agent_messages
            WHERE conversation_id = $1 AND consumer_subject_id = $2
            ORDER BY turn_no ASC, CASE role WHEN 'USER' THEN 0 ELSE 1 END ASC
            LIMIT 41`,
          [input.conversationId, input.consumerId],
        ),
        tx.query<{ latest_cursor: string | number | bigint }>(
          `SELECT latest_cursor
             FROM consumer_event_streams
            WHERE conversation_id = $1 AND owner_id = $2`,
          [input.conversationId, input.consumerId],
        ),
      ]);
      if (messagesResult.rows.length > 40) {
        throw unavailable();
      }
      return {
        conversation,
        messageRows: messagesResult.rows,
        latestEventId: String(streamResult.rows[0]?.latest_cursor ?? 0),
      };
    },
    { signal: AbortSignal.timeout(2_000), timeoutMs: 2_000, readOnlySnapshot: true },
  );

  // Release the PostgreSQL snapshot before any KMS operation. Sequential open is the bounded
  // concurrency policy for the frozen maximum of 40 transcript rows.
  const openSignal = AbortSignal.timeout(10_000);
  const messages = [];
  for (const row of snapshot.messageRows) {
    const role = z.enum(['USER', 'ASSISTANT']).parse(row.role);
    const aad = MessageAadSchema.parse({
      schemaVersion: row.content_aad_version,
      ownerId: snapshot.conversation.creator_id,
      conversationId: input.conversationId,
      messageId: row.id,
      role,
    });
    const text = await messageAuthority.openMessage({
      encrypted: EncryptedMessageSchema.parse({
        algorithm: row.content_algorithm,
        keyId: row.content_key_id,
        nonce: row.content_nonce,
        ciphertext: row.content_ciphertext,
        authTag: row.content_auth_tag,
        cipherDigest: row.content_cipher_digest,
        contentDigest: row.content_digest,
        aadVersion: row.content_aad_version,
      }),
      aad,
      signal: openSignal,
    });
    messages.push({
      messageId: row.id,
      invocationId: row.invocation_id,
      turnNo: row.turn_no,
      role,
      text,
      createdAt: isoDate(row.created_at),
    });
  }
  return ConversationTranscriptSchema.parse({
    protocol: 'combo.creator-agent-http/1',
    conversation: ConversationViewSchema.parse({
      protocol: 'combo.creator-agent-http/1',
      conversationId: snapshot.conversation.id,
      agentId: snapshot.conversation.agent_id,
      agentVersionId: snapshot.conversation.agent_version_id,
      versionDigest: snapshot.conversation.version_digest,
      state: snapshot.conversation.state,
      createdAt: isoDate(snapshot.conversation.created_at),
      expiresAt: isoDate(snapshot.conversation.expires_at),
    }),
    messages,
    latestEventId: snapshot.latestEventId,
  });
}

export async function readConsumerInvocation(
  db: RuntimeDb,
  rawInput: z.input<typeof ReadInvocationInputSchema>,
) {
  const input = ReadInvocationInputSchema.parse(rawInput);
  const signal = AbortSignal.timeout(2_000);
  return withTransaction(
    db,
    async (tx) => {
      await tx.query(`SELECT set_config('app.consumer_id', $1, true)`, [input.consumerId]);
      const located = await tx.query<Pick<InvocationRow, 'creator_id' | 'conversation_id'>>(
        `SELECT creator_id, conversation_id
           FROM agent_invocations
          WHERE id = $1 AND consumer_subject_id = $2`,
        [input.invocationId, input.consumerId],
      );
      const locator = located.rows[0];
      if (!locator) throw new ConsumerRuntimeProductError('FORBIDDEN');
      await tx.query(`SELECT set_config('app.creator_id', $1, true)`, [locator.creator_id]);
      const result = await tx.query<InvocationRow>(
        `SELECT id, conversation_id, creator_id, state, result_digest, error_code,
                retry_of_invocation_id, created_at, terminal_at
           FROM agent_invocations
          WHERE id = $1 AND conversation_id = $2 AND consumer_subject_id = $3`,
        [input.invocationId, locator.conversation_id, input.consumerId],
      );
      const invocation = result.rows[0];
      if (!invocation || invocation.creator_id !== locator.creator_id) throw unavailable();
      const errorCode =
        invocation.error_code === null ? null : VnextErrorCodeSchema.parse(invocation.error_code);
      return InvocationViewSchema.parse({
        protocol: 'combo.creator-agent-http/1',
        invocationId: invocation.id,
        conversationId: invocation.conversation_id,
        state: InvocationStateSchema.parse(invocation.state),
        resultDigest: invocation.result_digest,
        error: errorCode === null ? null : errorResponseFor(errorCode, input.requestId),
        retryOfInvocationId: invocation.retry_of_invocation_id,
        createdAt: isoDate(invocation.created_at),
        terminalAt: invocation.terminal_at === null ? null : isoDate(invocation.terminal_at),
      });
    },
    { signal, timeoutMs: 2_000, readOnlySnapshot: true },
  );
}
