import {
  CONSUMER_EVENT_OUTBOX_PROTOCOL,
  ConsumerEventOutboxRecordSchema,
  ConsumerTerminalEventPayloadSchema,
  consumerEventDedupeKey,
  consumerEventPayloadDigest,
  HmacSha256DigestSchema,
  Sha256HexSchema,
  Uint63StringSchema,
  UuidSchema,
  VnextErrorCodeSchema,
  type ConsumerEventOutboxRecord,
} from '@cb/creator-agent-protocol';
import { z } from 'zod';
import type { EncryptedMessage } from './message-crypto.js';

export interface QueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number | null;
}

export interface JournalConnection {
  query<R = Record<string, unknown>>(sql: string, parameters?: unknown[]): Promise<QueryResult<R>>;
  release(): void;
}

export interface JournalPool {
  connect(): Promise<JournalConnection>;
}

export interface PostgresCloudJournalPools {
  /** Consumer API role: accepts the user message and creates the durable command. */
  api: JournalPool;
  /** Broker/Reconciler role: commits an exact-authority terminal result. */
  broker: JournalPool;
  /** Reconciler role: bounded retention pruning and cursor advancement. */
  reconciler?: JournalPool;
}

export type CloudJournalStep =
  | 'USER_MESSAGE'
  | 'INVOCATION'
  | 'ACCEPTED_EVENT'
  | 'BROKER_OUTBOX'
  | 'CONVERSATION_BUSY'
  | 'ASSISTANT_MESSAGE'
  | 'INVOCATION_SUCCEEDED'
  | 'SUCCEEDED_EVENT'
  | 'INVOCATION_RECONCILING'
  | 'RECONCILING_EVENT'
  | 'INVOCATION_UNCERTAIN'
  | 'UNCERTAIN_EVENT'
  | 'CONSUMER_EVENT_OUTBOX'
  | 'CONSUMER_EVENT_STREAM'
  | 'CONVERSATION_IDLE';

export type FailureInjector = (step: CloudJournalStep) => void | Promise<void>;

export class CloudJournalError extends Error {
  public constructor(
    public readonly code:
      | 'IDEMPOTENCY_CONFLICT'
      | 'CONVERSATION_UNAVAILABLE'
      | 'EXECUTION_AUTHORITY_MISMATCH'
      | 'TERMINAL_CONFLICT'
      | 'PERSISTENCE_INVARIANT_FAILED'
      | 'SSE_CURSOR_EXPIRED',
    message: string,
  ) {
    super(message);
    this.name = 'CloudJournalError';
  }
}

const TenantIdentitySchema = z.object({ creatorId: UuidSchema, consumerId: UuidSchema }).strict();

const EncryptedMessageSchema = z
  .object({
    algorithm: z.literal('aes-256-gcm/v1'),
    keyId: z.string().regex(/^[-A-Za-z0-9_.:/]{1,256}$/u),
    nonce: z.instanceof(Buffer).refine((value) => value.byteLength === 12),
    ciphertext: z
      .instanceof(Buffer)
      .refine((value) => value.byteLength >= 1 && value.byteLength <= 65_536),
    authTag: z.instanceof(Buffer).refine((value) => value.byteLength === 16),
    cipherDigest: Sha256HexSchema,
    contentDigest: HmacSha256DigestSchema,
    aadVersion: z.literal(1),
  })
  .strict();

const AcceptInvocationInputSchema = TenantIdentitySchema.extend({
  conversationId: UuidSchema,
  agentVersionId: UuidSchema,
  agentVersionDigest: Sha256HexSchema,
  targetWorkerId: UuidSchema,
  userMessageId: UuidSchema,
  invocationId: UuidSchema,
  outboxCommandId: UuidSchema,
  sourceEventId: UuidSchema,
  clientMessageId: UuidSchema,
  requestDigest: HmacSha256DigestSchema,
  turnNo: z.number().int().min(1).max(20),
  deadlineAt: z.date(),
  encryptedUserMessage: EncryptedMessageSchema,
}).strict();

export interface AcceptInvocationInput extends Omit<
  z.input<typeof AcceptInvocationInputSchema>,
  'encryptedUserMessage'
> {
  encryptedUserMessage: EncryptedMessage;
}

export interface AcceptedInvocation {
  invocationId: string;
  userMessageId: string;
  state: string;
  replayed: boolean;
}

const CommitSuccessInputSchema = TenantIdentitySchema.extend({
  conversationId: UuidSchema,
  invocationId: UuidSchema,
  assistantMessageId: UuidSchema,
  sourceEventId: UuidSchema,
  agentVersionId: UuidSchema,
  workerId: UuidSchema,
  leaseId: UuidSchema,
  fence: z.bigint().min(1n).max(9_223_372_036_854_775_807n),
  executionCapabilityId: UuidSchema,
  turnNo: z.number().int().min(1).max(20),
  resultDigest: HmacSha256DigestSchema,
  encryptedAssistantMessage: EncryptedMessageSchema,
}).strict();

export interface CommitSuccessInput extends Omit<
  z.input<typeof CommitSuccessInputSchema>,
  'encryptedAssistantMessage'
> {
  encryptedAssistantMessage: EncryptedMessage;
}

export interface CommittedSuccess {
  invocationId: string;
  assistantMessageId: string;
  resultDigest: string;
  consumerEventCursor: string;
  replayed: boolean;
}

export const InvocationUncertaintyReasonSchema = z.enum([
  'START_DISPATCH_UNKNOWN',
  'HOST_EVIDENCE_LOST',
  'MODEL_ATTEMPT_UNKNOWN',
  'CANCEL_NOT_CONFIRMED',
  'JOURNAL_LOST',
]);
export type InvocationUncertaintyReason = z.infer<typeof InvocationUncertaintyReasonSchema>;

const BeginReconciliationInputSchema = TenantIdentitySchema.extend({
  conversationId: UuidSchema,
  invocationId: UuidSchema,
  sourceEventId: UuidSchema,
  reason: InvocationUncertaintyReasonSchema,
}).strict();

const MarkUncertainInputSchema = BeginReconciliationInputSchema;

export type BeginReconciliationInput = z.input<typeof BeginReconciliationInputSchema>;

export interface BeginReconciliationResult {
  invocationId: string;
  state: 'RECONCILING';
  reason: InvocationUncertaintyReason;
  reconciliationStartedAt: string;
  reconciliationDeadlineAt: string;
  replayed: boolean;
}

export type MarkUncertainInput = z.input<typeof MarkUncertainInputSchema>;

export interface MarkUncertainResult {
  invocationId: string;
  state: 'RECONCILING' | 'UNCERTAIN';
  reason: InvocationUncertaintyReason;
  reconciliationStartedAt: string;
  reconciliationDeadlineAt: string;
  consumerEventCursor: string | null;
  exhausted: boolean;
  replayed: boolean;
}

interface ExistingInvocationRow {
  id: string;
  user_message_id: string;
  request_digest: string;
  state: string;
}

interface ConversationRow {
  agent_version_id: string;
  version_digest: string;
  state: string;
  assigned_worker_id: string | null;
  next_turn_no: number;
  deadline_valid: boolean;
}

interface SuccessAuthorityRow {
  state: string;
  result_message_id: string | null;
  result_digest: string | null;
  agent_version_id: string;
  assigned_worker_id: string | null;
  assignment_lease_id: string | null;
  assignment_fence: string | number | bigint | null;
  execution_capability_id: string | null;
  conversation_state: string;
  lease_state: string;
  lease_valid: boolean;
  consumer_event_cursor: string | null;
  consumer_event_source_event_id: string | null;
  consumer_event_type: string | null;
  consumer_event_payload: unknown;
  consumer_event_payload_digest: string | null;
  consumer_event_dedupe_key: string | null;
  terminal_source_event_id: string | null;
}

interface ReconciliationAuthorityRow {
  state: string;
  conversation_state: string;
  reconciliation_reason: string | null;
  reconciliation_started_at: Date | string | null;
  uncertainty_reason: string | null;
  error_code: string | null;
  terminal_at: Date | string | null;
  reconciliation_exhausted: boolean;
  consumer_event_cursor: string | null;
  consumer_event_source_event_id: string | null;
  consumer_event_type: string | null;
  consumer_event_payload: unknown;
  consumer_event_payload_digest: string | null;
  consumer_event_dedupe_key: string | null;
  terminal_source_event_id: string | null;
  reconciliation_source_event_id: string | null;
}

const ConsumerEventIdentitySchema = TenantIdentitySchema.extend({
  conversationId: UuidSchema,
}).strict();

const ConsumerEventPageInputSchema = ConsumerEventIdentitySchema.extend({
  afterCursor: Uint63StringSchema,
  limit: z.number().int().min(1).max(100),
}).strict();

const ClaimConsumerEventsInputSchema = TenantIdentitySchema.extend({
  limit: z.number().int().min(1).max(100),
}).strict();

const PublishConsumerEventInputSchema = ConsumerEventIdentitySchema.extend({
  cursor: Uint63StringSchema,
  payloadDigest: Sha256HexSchema,
}).strict();

interface ConsumerEventRow {
  cursor: string;
  owner_id: string;
  conversation_id: string;
  invocation_id: string;
  source_event_id: string;
  event_type: string;
  payload: unknown;
  payload_digest: string;
  dedupe_key: string;
  state: string;
  attempt_count: number;
  next_attempt_at: Date | string | null;
  created_at: Date | string;
  published_at: Date | string | null;
  retained_until: Date | string;
}

export type DurableConsumerEvent = ConsumerEventOutboxRecord;

export interface ConsumerEventPage {
  latestCursor: string;
  expiredThroughCursor: string;
  events: DurableConsumerEvent[];
}

function isoDate(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new CloudJournalError('PERSISTENCE_INVARIANT_FAILED', 'Consumer Event 时间字段不合法');
  }
  return parsed.toISOString();
}

function reconciliationDeadline(value: Date | string): string {
  const startedAt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(startedAt.valueOf())) {
    throw new CloudJournalError(
      'PERSISTENCE_INVARIANT_FAILED',
      'Reconciliation durable timestamp 不合法',
    );
  }
  return new Date(startedAt.valueOf() + 300_000).toISOString();
}

function parseConsumerEventRow(row: ConsumerEventRow): DurableConsumerEvent {
  const candidate = {
    protocol: CONSUMER_EVENT_OUTBOX_PROTOCOL,
    schemaVersion: 1,
    cursor: Uint63StringSchema.parse(row.cursor),
    ownerId: UuidSchema.parse(row.owner_id),
    conversationId: UuidSchema.parse(row.conversation_id),
    invocationId: UuidSchema.parse(row.invocation_id),
    sourceEventId: Uint63StringSchema.parse(row.source_event_id),
    eventType: row.event_type,
    payload: row.payload,
    payloadDigest: Sha256HexSchema.parse(row.payload_digest),
    dedupeKey: Sha256HexSchema.parse(row.dedupe_key),
    state: row.state,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at === null ? null : isoDate(row.next_attempt_at),
    createdAt: isoDate(row.created_at),
    publishedAt: row.published_at === null ? null : isoDate(row.published_at),
    retainedUntil: isoDate(row.retained_until),
  };
  const parsed = ConsumerEventOutboxRecordSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new CloudJournalError(
      'PERSISTENCE_INVARIANT_FAILED',
      'Consumer Event durable record 与权威协议不一致',
    );
  }
  return parsed.data;
}

async function withTenantTransaction<T>(
  pool: JournalPool,
  identity: { creatorId: string; consumerId: string },
  operation: (connection: JournalConnection) => Promise<T>,
): Promise<T> {
  const parsedIdentity = TenantIdentitySchema.parse({
    creatorId: identity.creatorId,
    consumerId: identity.consumerId,
  });
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    try {
      await connection.query(`SELECT set_config('app.creator_id', $1, true)`, [
        parsedIdentity.creatorId,
      ]);
      await connection.query(`SELECT set_config('app.consumer_id', $1, true)`, [
        parsedIdentity.consumerId,
      ]);
      const result = await operation(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    connection.release();
  }
}

function encryptedParameters(encrypted: EncryptedMessage): readonly unknown[] {
  return [
    encrypted.algorithm,
    encrypted.keyId,
    encrypted.nonce,
    encrypted.ciphertext,
    encrypted.authTag,
    encrypted.cipherDigest,
    encrypted.contentDigest,
    encrypted.aadVersion,
  ];
}

async function inject(
  injector: FailureInjector | undefined,
  step: CloudJournalStep,
): Promise<void> {
  await injector?.(step);
}

export class PostgresCloudJournal {
  public constructor(
    private readonly pools: PostgresCloudJournalPools,
    private readonly failureInjector?: FailureInjector,
  ) {}

  public async acceptInvocation(rawInput: AcceptInvocationInput): Promise<AcceptedInvocation> {
    const input = AcceptInvocationInputSchema.parse(rawInput);
    return withTenantTransaction(this.pools.api, input, async (connection) => {
      await connection.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `${input.conversationId}:${input.clientMessageId}`,
      ]);
      const existing = await connection.query<ExistingInvocationRow>(
        `SELECT id, user_message_id, request_digest, state
           FROM agent_invocations
          WHERE conversation_id = $1 AND client_message_id = $2
          FOR UPDATE`,
        [input.conversationId, input.clientMessageId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_digest !== input.requestDigest) {
          throw new CloudJournalError(
            'IDEMPOTENCY_CONFLICT',
            '同一 clientMessageId 绑定了不同 requestDigest',
          );
        }
        return {
          invocationId: existing.rows[0].id,
          userMessageId: existing.rows[0].user_message_id,
          state: existing.rows[0].state,
          replayed: true,
        };
      }

      const conversation = await connection.query<ConversationRow>(
        `SELECT agent_version_id, version_digest, state, assigned_worker_id, next_turn_no,
                ($4::timestamptz > now()
                 AND $4::timestamptz <= now() + interval '120 seconds') AS deadline_valid
           FROM agent_conversations
          WHERE id = $1 AND creator_id = $2 AND consumer_subject_id = $3
          FOR UPDATE`,
        [input.conversationId, input.creatorId, input.consumerId, input.deadlineAt],
      );
      const current = conversation.rows[0];
      if (
        !current ||
        current.state !== 'IDLE' ||
        current.agent_version_id !== input.agentVersionId ||
        current.version_digest !== input.agentVersionDigest ||
        current.assigned_worker_id !== input.targetWorkerId ||
        Number(current.next_turn_no) !== input.turnNo ||
        current.deadline_valid !== true
      ) {
        throw new CloudJournalError(
          'CONVERSATION_UNAVAILABLE',
          'Conversation 不是可接收本轮的精确 Version/Worker/turn 状态',
        );
      }
      await connection.query(
        `INSERT INTO agent_messages (
           id, conversation_id, creator_id, consumer_subject_id, turn_no, role,
           client_message_id, content_algorithm, content_key_id, content_nonce,
           content_ciphertext, content_auth_tag, content_cipher_digest, content_digest,
           content_aad_version, invocation_id
         ) VALUES (
           $1, $2, $3, $4, $5, 'USER', $6,
           $7, $8, $9, $10, $11, $12, $13, $14, $15
         )`,
        [
          input.userMessageId,
          input.conversationId,
          input.creatorId,
          input.consumerId,
          input.turnNo,
          input.clientMessageId,
          ...encryptedParameters(input.encryptedUserMessage),
          input.invocationId,
        ],
      );
      await inject(this.failureInjector, 'USER_MESSAGE');

      await connection.query(
        `INSERT INTO agent_invocations (
           id, conversation_id, creator_id, consumer_subject_id, agent_version_id,
           user_message_id, client_message_id, request_digest, state, deadline_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACCEPTED', $9)`,
        [
          input.invocationId,
          input.conversationId,
          input.creatorId,
          input.consumerId,
          input.agentVersionId,
          input.userMessageId,
          input.clientMessageId,
          input.requestDigest,
          input.deadlineAt,
        ],
      );
      await inject(this.failureInjector, 'INVOCATION');

      await connection.query(
        `INSERT INTO agent_invocation_events (
           invocation_id, creator_id, consumer_subject_id, journal_seq, source,
           source_event_id, event_type, payload, occurred_at
         ) VALUES ($1, $2, $3, 1, 'API', $4, 'invocation.accepted', $5::jsonb, now())`,
        [
          input.invocationId,
          input.creatorId,
          input.consumerId,
          input.sourceEventId,
          JSON.stringify({ state: 'ACCEPTED' }),
        ],
      );
      await inject(this.failureInjector, 'ACCEPTED_EVENT');

      await connection.query(
        `INSERT INTO broker_outbox (
           command_id, creator_id, target_worker_id, invocation_id, consumer_subject_id,
           command_type, dedupe_key, state, next_attempt_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5, 'invocation.prepare', $6, 'PENDING', now(), $7)`,
        [
          input.outboxCommandId,
          input.creatorId,
          input.targetWorkerId,
          input.invocationId,
          input.consumerId,
          `invocation:${input.invocationId}:prepare`,
          input.deadlineAt,
        ],
      );
      await inject(this.failureInjector, 'BROKER_OUTBOX');

      const projection = await connection.query(
        `UPDATE agent_conversations
            SET state = 'BUSY', next_turn_no = next_turn_no + 1, last_activity_at = now()
          WHERE id = $1 AND creator_id = $2 AND consumer_subject_id = $3
            AND state = 'IDLE' AND next_turn_no = $4`,
        [input.conversationId, input.creatorId, input.consumerId, input.turnNo],
      );
      if (projection.rowCount !== 1) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'Conversation projection 未原子进入 BUSY',
        );
      }
      await inject(this.failureInjector, 'CONVERSATION_BUSY');

      return {
        invocationId: input.invocationId,
        userMessageId: input.userMessageId,
        state: 'ACCEPTED',
        replayed: false,
      };
    });
  }

  public async commitSuccess(rawInput: CommitSuccessInput): Promise<CommittedSuccess> {
    const input = CommitSuccessInputSchema.parse(rawInput);
    return withTenantTransaction(this.pools.broker, input, async (connection) => {
      await connection.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        input.invocationId,
      ]);
      const authority = await connection.query<SuccessAuthorityRow>(
        `SELECT invocation.state, invocation.result_message_id, invocation.result_digest,
                invocation.agent_version_id, invocation.assigned_worker_id,
                invocation.assignment_lease_id, invocation.assignment_fence,
                invocation.execution_capability_id, conversation.state AS conversation_state,
                lease.state AS lease_state, (lease.expires_at > now()) AS lease_valid,
                consumer_event.cursor::text AS consumer_event_cursor,
                consumer_event.source_event_id AS consumer_event_source_event_id,
                consumer_event.event_type AS consumer_event_type,
                consumer_event.payload AS consumer_event_payload,
                consumer_event.payload_digest AS consumer_event_payload_digest,
                consumer_event.dedupe_key AS consumer_event_dedupe_key,
                terminal_event.source_event_id AS terminal_source_event_id
           FROM agent_invocations AS invocation
           JOIN agent_conversations AS conversation
             ON conversation.id = invocation.conversation_id
            AND conversation.creator_id = invocation.creator_id
            AND conversation.consumer_subject_id = invocation.consumer_subject_id
           JOIN worker_leases AS lease
             ON lease.id = invocation.assignment_lease_id
            AND lease.creator_id = invocation.creator_id
            AND lease.worker_id = invocation.assigned_worker_id
            AND lease.fence = invocation.assignment_fence
           LEFT JOIN consumer_event_outbox AS consumer_event
             ON consumer_event.invocation_id = invocation.id
            AND consumer_event.event_type = 'invocation.terminal'
           LEFT JOIN agent_invocation_events AS terminal_event
             ON terminal_event.id = consumer_event.source_event_id
            AND terminal_event.invocation_id = invocation.id
          WHERE invocation.id = $1
            AND invocation.conversation_id = $2
            AND invocation.creator_id = $3
            AND invocation.consumer_subject_id = $4
          FOR UPDATE OF invocation, conversation`,
        [input.invocationId, input.conversationId, input.creatorId, input.consumerId],
      );
      const current = authority.rows[0];
      if (!current) {
        throw new CloudJournalError(
          'EXECUTION_AUTHORITY_MISMATCH',
          'Invocation 不存在或租户不匹配',
        );
      }
      if (
        current.agent_version_id !== input.agentVersionId ||
        current.assigned_worker_id !== input.workerId ||
        current.assignment_lease_id !== input.leaseId ||
        BigInt(current.assignment_fence ?? 0) !== input.fence ||
        current.execution_capability_id !== input.executionCapabilityId
      ) {
        throw new CloudJournalError(
          'EXECUTION_AUTHORITY_MISMATCH',
          'final 与 durable Version/Worker/Lease/Fence/Capability 不一致',
        );
      }
      if (current.state === 'SUCCEEDED') {
        if (
          current.result_digest !== input.resultDigest ||
          current.result_message_id !== input.assistantMessageId
        ) {
          throw new CloudJournalError('TERMINAL_CONFLICT', '终态重放与 durable result 不一致');
        }
        if (
          current.consumer_event_cursor === null ||
          current.consumer_event_source_event_id === null
        ) {
          throw new CloudJournalError(
            'PERSISTENCE_INVARIANT_FAILED',
            '已成功 Invocation 缺少 durable Consumer Event',
          );
        }
        if (
          current.terminal_source_event_id !== input.sourceEventId ||
          current.consumer_event_type !== 'invocation.terminal'
        ) {
          throw new CloudJournalError(
            'TERMINAL_CONFLICT',
            '终态重放与 durable Consumer Event identity 不一致',
          );
        }
        const durablePayload = ConsumerTerminalEventPayloadSchema.safeParse(
          current.consumer_event_payload,
        );
        if (
          !durablePayload.success ||
          durablePayload.data.conversationId !== input.conversationId ||
          durablePayload.data.invocationId !== input.invocationId ||
          durablePayload.data.terminalState !== 'SUCCEEDED' ||
          durablePayload.data.assistantMessageId !== input.assistantMessageId ||
          durablePayload.data.resultDigest !== input.resultDigest ||
          durablePayload.data.errorCode !== null ||
          current.consumer_event_payload_digest !==
            consumerEventPayloadDigest(durablePayload.data) ||
          current.consumer_event_dedupe_key !==
            consumerEventDedupeKey({
              ownerId: input.consumerId,
              sourceEventId: current.consumer_event_source_event_id,
              eventType: 'invocation.terminal',
            })
        ) {
          throw new CloudJournalError(
            'PERSISTENCE_INVARIANT_FAILED',
            '已成功 Invocation 的 durable Consumer Event 不一致',
          );
        }
        return {
          invocationId: input.invocationId,
          assistantMessageId: input.assistantMessageId,
          resultDigest: input.resultDigest,
          consumerEventCursor: current.consumer_event_cursor,
          replayed: true,
        };
      }
      const terminalStates = new Set(['FAILED', 'CANCELLED', 'UNCERTAIN', 'EXPIRED']);
      if (terminalStates.has(current.state)) {
        throw new CloudJournalError('TERMINAL_CONFLICT', 'Invocation 已有其他终态');
      }
      if (current.lease_state !== 'ACTIVE' || current.lease_valid !== true) {
        throw new CloudJournalError(
          'EXECUTION_AUTHORITY_MISMATCH',
          '新的 final 需要仍有效的 exact Worker Lease',
        );
      }
      if (
        !['RUNNING', 'CANCEL_REQUESTED', 'RECONCILING'].includes(current.state) ||
        current.conversation_state !== 'BUSY'
      ) {
        throw new CloudJournalError(
          'EXECUTION_AUTHORITY_MISMATCH',
          'final 与 durable Version/Worker/Lease/Fence/Capability 不一致',
        );
      }

      await connection.query(
        `INSERT INTO agent_messages (
           id, conversation_id, creator_id, consumer_subject_id, turn_no, role,
           client_message_id, content_algorithm, content_key_id, content_nonce,
           content_ciphertext, content_auth_tag, content_cipher_digest, content_digest,
           content_aad_version, invocation_id
         ) VALUES (
           $1, $2, $3, $4, $5, 'ASSISTANT', NULL,
           $6, $7, $8, $9, $10, $11, $12, $13, $14
         )`,
        [
          input.assistantMessageId,
          input.conversationId,
          input.creatorId,
          input.consumerId,
          input.turnNo,
          ...encryptedParameters(input.encryptedAssistantMessage),
          input.invocationId,
        ],
      );
      await inject(this.failureInjector, 'ASSISTANT_MESSAGE');

      const terminal = await connection.query<{ terminal_at: Date | string }>(
        `UPDATE agent_invocations
            SET state = 'SUCCEEDED', result_message_id = $5, result_digest = $6,
                error_code = NULL, uncertainty_reason = NULL, terminal_at = now()
          WHERE id = $1 AND conversation_id = $2 AND creator_id = $3 AND consumer_subject_id = $4
            AND state IN ('RUNNING', 'CANCEL_REQUESTED', 'RECONCILING')
            AND agent_version_id = $7 AND assigned_worker_id = $8
            AND assignment_lease_id = $9 AND assignment_fence = $10
            AND execution_capability_id = $11
          RETURNING terminal_at`,
        [
          input.invocationId,
          input.conversationId,
          input.creatorId,
          input.consumerId,
          input.assistantMessageId,
          input.resultDigest,
          input.agentVersionId,
          input.workerId,
          input.leaseId,
          input.fence.toString(),
          input.executionCapabilityId,
        ],
      );
      if (terminal.rowCount !== 1) {
        throw new CloudJournalError(
          'EXECUTION_AUTHORITY_MISMATCH',
          '终态 compare-and-set 未匹配 exact authority',
        );
      }
      const terminalAt = terminal.rows[0]?.terminal_at;
      if (!terminalAt) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'Invocation terminal 缺少 Cloud 时间',
        );
      }
      const terminalOccurredAt = isoDate(terminalAt);
      await inject(this.failureInjector, 'INVOCATION_SUCCEEDED');

      const terminalEvent = await connection.query<{ id: string }>(
        `INSERT INTO agent_invocation_events (
           invocation_id, creator_id, consumer_subject_id, journal_seq, source,
           source_event_id, event_type, payload, occurred_at
         )
         SELECT $1, $2, $3, COALESCE(max(journal_seq), 0) + 1,
                'BROKER', $4, 'invocation.succeeded', $5::jsonb, $6
           FROM agent_invocation_events
          WHERE invocation_id = $1
         RETURNING id::text AS id`,
        [
          input.invocationId,
          input.creatorId,
          input.consumerId,
          input.sourceEventId,
          JSON.stringify({
            state: 'SUCCEEDED',
            messageId: input.assistantMessageId,
            resultDigest: input.resultDigest,
          }),
          terminalOccurredAt,
        ],
      );
      const terminalEventId = terminalEvent.rows[0]?.id;
      if (!terminalEventId) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'Invocation terminal Event 未返回 durable identity',
        );
      }
      await inject(this.failureInjector, 'SUCCEEDED_EVENT');

      const terminalPayload = ConsumerTerminalEventPayloadSchema.parse({
        protocol: CONSUMER_EVENT_OUTBOX_PROTOCOL,
        schemaVersion: 1,
        type: 'invocation.terminal',
        conversationId: input.conversationId,
        invocationId: input.invocationId,
        terminalState: 'SUCCEEDED',
        assistantMessageId: input.assistantMessageId,
        resultDigest: input.resultDigest,
        errorCode: null,
        occurredAt: terminalOccurredAt,
      });
      const terminalPayloadDigest = consumerEventPayloadDigest(terminalPayload);
      const terminalDedupeKey = consumerEventDedupeKey({
        ownerId: input.consumerId,
        sourceEventId: terminalEventId,
        eventType: 'invocation.terminal',
      });

      const consumerEvent = await connection.query<{ cursor: string }>(
        `INSERT INTO consumer_event_outbox (
           owner_id, conversation_id, invocation_id, source_event_id,
           event_type, payload, payload_digest, dedupe_key
         ) VALUES ($1, $2, $3, $4, 'invocation.terminal', $5::jsonb, $6, $7)
         RETURNING cursor::text AS cursor`,
        [
          input.consumerId,
          input.conversationId,
          input.invocationId,
          terminalEventId,
          JSON.stringify(terminalPayload),
          terminalPayloadDigest,
          terminalDedupeKey,
        ],
      );
      const consumerEventCursor = consumerEvent.rows[0]?.cursor;
      if (consumerEventCursor === undefined) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'Consumer Event Outbox 未返回 cursor',
        );
      }
      await inject(this.failureInjector, 'CONSUMER_EVENT_OUTBOX');

      await connection.query(
        `INSERT INTO consumer_event_streams (
           owner_id, conversation_id, latest_cursor, expired_through_cursor, updated_at
         ) VALUES ($1, $2, $3, 0, now())
         ON CONFLICT (owner_id, conversation_id) DO UPDATE
           SET latest_cursor = GREATEST(
                 consumer_event_streams.latest_cursor,
                 EXCLUDED.latest_cursor
               ),
               updated_at = now()`,
        [input.consumerId, input.conversationId, consumerEventCursor],
      );
      await inject(this.failureInjector, 'CONSUMER_EVENT_STREAM');

      const conversation = await connection.query(
        `UPDATE agent_conversations
            SET state = 'IDLE', last_activity_at = now()
          WHERE id = $1 AND creator_id = $2 AND consumer_subject_id = $3 AND state = 'BUSY'`,
        [input.conversationId, input.creatorId, input.consumerId],
      );
      if (conversation.rowCount !== 1) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'Conversation projection 未原子回到 IDLE',
        );
      }
      await inject(this.failureInjector, 'CONVERSATION_IDLE');

      return {
        invocationId: input.invocationId,
        assistantMessageId: input.assistantMessageId,
        resultDigest: input.resultDigest,
        consumerEventCursor,
        replayed: false,
      };
    });
  }

  public async beginReconciliation(
    rawInput: BeginReconciliationInput,
  ): Promise<BeginReconciliationResult> {
    const input = BeginReconciliationInputSchema.parse(rawInput);
    const pool = this.pools.reconciler;
    if (!pool) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'Invocation reconciliation 需要独立 Reconciler pool',
      );
    }
    return withTenantTransaction(pool, input, async (connection) => {
      await connection.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        input.invocationId,
      ]);
      const authority = await connection.query<ReconciliationAuthorityRow>(
        `SELECT invocation.state, conversation.state AS conversation_state,
                invocation.reconciliation_reason, invocation.reconciliation_started_at,
                invocation.uncertainty_reason, invocation.error_code, invocation.terminal_at,
                false AS reconciliation_exhausted,
                NULL::text AS consumer_event_cursor,
                NULL::text AS consumer_event_source_event_id,
                NULL::text AS consumer_event_type,
                NULL::jsonb AS consumer_event_payload,
                NULL::text AS consumer_event_payload_digest,
                NULL::text AS consumer_event_dedupe_key,
                NULL::text AS terminal_source_event_id,
                reconciling_event.source_event_id AS reconciliation_source_event_id
           FROM agent_invocations AS invocation
           JOIN agent_conversations AS conversation
             ON conversation.id = invocation.conversation_id
            AND conversation.creator_id = invocation.creator_id
            AND conversation.consumer_subject_id = invocation.consumer_subject_id
           LEFT JOIN agent_invocation_events AS reconciling_event
             ON reconciling_event.invocation_id = invocation.id
            AND reconciling_event.event_type = 'invocation.reconciling'
          WHERE invocation.id = $1
            AND invocation.conversation_id = $2
            AND invocation.creator_id = $3
            AND invocation.consumer_subject_id = $4
          FOR UPDATE OF invocation, conversation`,
        [input.invocationId, input.conversationId, input.creatorId, input.consumerId],
      );
      const current = authority.rows[0];
      if (!current) {
        throw new CloudJournalError(
          'EXECUTION_AUTHORITY_MISMATCH',
          'Invocation 不存在或 reconciliation 租户不匹配',
        );
      }
      if (current.state === 'RECONCILING') {
        if (
          current.reconciliation_reason !== input.reason ||
          current.reconciliation_started_at === null ||
          current.reconciliation_source_event_id !== input.sourceEventId
        ) {
          throw new CloudJournalError(
            'TERMINAL_CONFLICT',
            'Reconciliation 重放与 durable lost-evidence binding 不一致',
          );
        }
        return {
          invocationId: input.invocationId,
          state: 'RECONCILING',
          reason: input.reason,
          reconciliationStartedAt: isoDate(current.reconciliation_started_at),
          reconciliationDeadlineAt: reconciliationDeadline(current.reconciliation_started_at),
          replayed: true,
        };
      }
      if (
        current.state === 'RUNNING' &&
        current.conversation_state === 'BUSY' &&
        current.reconciliation_started_at !== null &&
        current.reconciliation_reason !== null
      ) {
        if (
          current.reconciliation_reason !== input.reason ||
          current.reconciliation_source_event_id !== input.sourceEventId
        ) {
          throw new CloudJournalError(
            'TERMINAL_CONFLICT',
            '再次 reconciliation 与首个 durable lost-evidence binding 不一致',
          );
        }
        const resumed = await connection.query(
          `UPDATE agent_invocations
              SET state = 'RECONCILING'
            WHERE id = $1 AND conversation_id = $2 AND creator_id = $3
              AND consumer_subject_id = $4 AND state = 'RUNNING'
              AND reconciliation_reason = $5
              AND reconciliation_started_at IS NOT NULL`,
          [
            input.invocationId,
            input.conversationId,
            input.creatorId,
            input.consumerId,
            input.reason,
          ],
        );
        if (resumed.rowCount !== 1) {
          throw new CloudJournalError(
            'PERSISTENCE_INVARIANT_FAILED',
            'Invocation 未按首个 durable binding 重新进入 RECONCILING',
          );
        }
        return {
          invocationId: input.invocationId,
          state: 'RECONCILING',
          reason: input.reason,
          reconciliationStartedAt: isoDate(current.reconciliation_started_at),
          reconciliationDeadlineAt: reconciliationDeadline(current.reconciliation_started_at),
          replayed: true,
        };
      }
      if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN', 'EXPIRED'].includes(current.state)) {
        throw new CloudJournalError('TERMINAL_CONFLICT', 'Invocation 已有终态');
      }
      if (
        !['PERSISTED', 'STARTING', 'RUNNING', 'CANCEL_REQUESTED'].includes(current.state) ||
        current.conversation_state !== 'BUSY' ||
        current.reconciliation_started_at !== null ||
        current.reconciliation_reason !== null
      ) {
        throw new CloudJournalError(
          'EXECUTION_AUTHORITY_MISMATCH',
          'Invocation 不在可进入 reconciliation 的 durable 状态',
        );
      }

      const projection = await connection.query<{
        reconciliation_started_at: Date | string;
      }>(
        `UPDATE agent_invocations
            SET state = 'RECONCILING', reconciliation_reason = $5,
                reconciliation_started_at = now()
          WHERE id = $1 AND conversation_id = $2 AND creator_id = $3
            AND consumer_subject_id = $4
            AND state IN ('PERSISTED', 'STARTING', 'RUNNING', 'CANCEL_REQUESTED')
            AND reconciliation_reason IS NULL AND reconciliation_started_at IS NULL
          RETURNING reconciliation_started_at`,
        [input.invocationId, input.conversationId, input.creatorId, input.consumerId, input.reason],
      );
      const startedAt = projection.rows[0]?.reconciliation_started_at;
      if (!startedAt) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'Invocation projection 未原子进入 RECONCILING',
        );
      }
      await inject(this.failureInjector, 'INVOCATION_RECONCILING');

      await connection.query(
        `INSERT INTO agent_invocation_events (
           invocation_id, creator_id, consumer_subject_id, journal_seq, source,
           source_event_id, event_type, payload, occurred_at
         )
         SELECT $1, $2, $3, COALESCE(max(journal_seq), 0) + 1,
                'RECONCILER', $4, 'invocation.reconciling', $5::jsonb, $6
           FROM agent_invocation_events
          WHERE invocation_id = $1`,
        [
          input.invocationId,
          input.creatorId,
          input.consumerId,
          input.sourceEventId,
          JSON.stringify({ state: 'RECONCILING', reason: input.reason }),
          isoDate(startedAt),
        ],
      );
      await inject(this.failureInjector, 'RECONCILING_EVENT');

      return {
        invocationId: input.invocationId,
        state: 'RECONCILING',
        reason: input.reason,
        reconciliationStartedAt: isoDate(startedAt),
        reconciliationDeadlineAt: reconciliationDeadline(startedAt),
        replayed: false,
      };
    });
  }

  public async markUncertain(rawInput: MarkUncertainInput): Promise<MarkUncertainResult> {
    const input = MarkUncertainInputSchema.parse(rawInput);
    const pool = this.pools.reconciler;
    if (!pool) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'Invocation reconciliation 需要独立 Reconciler pool',
      );
    }
    return withTenantTransaction(pool, input, async (connection) => {
      await connection.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        input.invocationId,
      ]);
      const authority = await connection.query<ReconciliationAuthorityRow>(
        `SELECT invocation.state, conversation.state AS conversation_state,
                invocation.reconciliation_reason, invocation.reconciliation_started_at,
                invocation.uncertainty_reason, invocation.error_code, invocation.terminal_at,
                CASE WHEN invocation.reconciliation_started_at IS NULL THEN false
                     ELSE creator_agent_reconciliation_is_exhausted(
                       invocation.reconciliation_started_at, now()
                     ) END AS reconciliation_exhausted,
                consumer_event.cursor::text AS consumer_event_cursor,
                consumer_event.source_event_id::text AS consumer_event_source_event_id,
                consumer_event.event_type AS consumer_event_type,
                consumer_event.payload AS consumer_event_payload,
                consumer_event.payload_digest AS consumer_event_payload_digest,
                consumer_event.dedupe_key AS consumer_event_dedupe_key,
                terminal_event.source_event_id AS terminal_source_event_id,
                reconciling_event.source_event_id AS reconciliation_source_event_id
           FROM agent_invocations AS invocation
           JOIN agent_conversations AS conversation
             ON conversation.id = invocation.conversation_id
            AND conversation.creator_id = invocation.creator_id
            AND conversation.consumer_subject_id = invocation.consumer_subject_id
           LEFT JOIN consumer_event_outbox AS consumer_event
             ON consumer_event.invocation_id = invocation.id
            AND consumer_event.event_type = 'invocation.terminal'
           LEFT JOIN agent_invocation_events AS terminal_event
             ON terminal_event.id = consumer_event.source_event_id
            AND terminal_event.invocation_id = invocation.id
           LEFT JOIN agent_invocation_events AS reconciling_event
             ON reconciling_event.invocation_id = invocation.id
            AND reconciling_event.event_type = 'invocation.reconciling'
          WHERE invocation.id = $1
            AND invocation.conversation_id = $2
            AND invocation.creator_id = $3
            AND invocation.consumer_subject_id = $4
          FOR UPDATE OF invocation, conversation`,
        [input.invocationId, input.conversationId, input.creatorId, input.consumerId],
      );
      const current = authority.rows[0];
      if (!current) {
        throw new CloudJournalError(
          'EXECUTION_AUTHORITY_MISMATCH',
          'Invocation 不存在或 reconciliation 租户不匹配',
        );
      }
      if (current.state === 'UNCERTAIN') {
        if (
          current.reconciliation_reason !== input.reason ||
          current.uncertainty_reason !== input.reason ||
          current.error_code !== 'EXECUTION_STATE_UNKNOWN' ||
          current.reconciliation_started_at === null ||
          current.reconciliation_source_event_id === null ||
          current.reconciliation_source_event_id === input.sourceEventId ||
          current.terminal_at === null ||
          current.terminal_source_event_id !== input.sourceEventId ||
          current.consumer_event_cursor === null ||
          current.consumer_event_source_event_id === null ||
          current.consumer_event_type !== 'invocation.terminal'
        ) {
          throw new CloudJournalError(
            'TERMINAL_CONFLICT',
            'UNCERTAIN 重放与 durable terminal binding 不一致',
          );
        }
        const durablePayload = ConsumerTerminalEventPayloadSchema.safeParse(
          current.consumer_event_payload,
        );
        if (
          !durablePayload.success ||
          durablePayload.data.conversationId !== input.conversationId ||
          durablePayload.data.invocationId !== input.invocationId ||
          durablePayload.data.terminalState !== 'UNCERTAIN' ||
          durablePayload.data.assistantMessageId !== null ||
          durablePayload.data.resultDigest !== null ||
          durablePayload.data.errorCode !== 'EXECUTION_STATE_UNKNOWN' ||
          current.consumer_event_payload_digest !==
            consumerEventPayloadDigest(durablePayload.data) ||
          current.consumer_event_dedupe_key !==
            consumerEventDedupeKey({
              ownerId: input.consumerId,
              sourceEventId: current.consumer_event_source_event_id,
              eventType: 'invocation.terminal',
            })
        ) {
          throw new CloudJournalError(
            'PERSISTENCE_INVARIANT_FAILED',
            'UNCERTAIN durable Consumer Event 不一致',
          );
        }
        return {
          invocationId: input.invocationId,
          state: 'UNCERTAIN',
          reason: input.reason,
          reconciliationStartedAt: isoDate(current.reconciliation_started_at),
          reconciliationDeadlineAt: reconciliationDeadline(current.reconciliation_started_at),
          consumerEventCursor: current.consumer_event_cursor,
          exhausted: true,
          replayed: true,
        };
      }
      if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(current.state)) {
        throw new CloudJournalError('TERMINAL_CONFLICT', 'Invocation 已有其他终态');
      }
      if (
        current.state !== 'RECONCILING' ||
        current.conversation_state !== 'BUSY' ||
        current.reconciliation_reason !== input.reason ||
        current.reconciliation_started_at === null ||
        current.reconciliation_source_event_id === null ||
        current.reconciliation_source_event_id === input.sourceEventId ||
        current.uncertainty_reason !== null
      ) {
        throw new CloudJournalError(
          'EXECUTION_AUTHORITY_MISMATCH',
          'Invocation 没有匹配的 durable reconciliation binding',
        );
      }
      if (current.reconciliation_exhausted !== true) {
        return {
          invocationId: input.invocationId,
          state: 'RECONCILING',
          reason: input.reason,
          reconciliationStartedAt: isoDate(current.reconciliation_started_at),
          reconciliationDeadlineAt: reconciliationDeadline(current.reconciliation_started_at),
          consumerEventCursor: null,
          exhausted: false,
          replayed: true,
        };
      }

      const terminal = await connection.query<{ terminal_at: Date | string }>(
        `UPDATE agent_invocations
            SET state = 'UNCERTAIN', uncertainty_reason = $5,
                error_code = 'EXECUTION_STATE_UNKNOWN', terminal_at = now()
          WHERE id = $1 AND conversation_id = $2 AND creator_id = $3
            AND consumer_subject_id = $4 AND state = 'RECONCILING'
            AND reconciliation_reason = $5
            AND creator_agent_reconciliation_is_exhausted(reconciliation_started_at, now())
          RETURNING terminal_at`,
        [input.invocationId, input.conversationId, input.creatorId, input.consumerId, input.reason],
      );
      const terminalAt = terminal.rows[0]?.terminal_at;
      if (!terminalAt) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'UNCERTAIN compare-and-set 未匹配 exhausted reconciliation',
        );
      }
      const terminalOccurredAt = isoDate(terminalAt);
      await inject(this.failureInjector, 'INVOCATION_UNCERTAIN');

      const terminalEvent = await connection.query<{ id: string }>(
        `INSERT INTO agent_invocation_events (
           invocation_id, creator_id, consumer_subject_id, journal_seq, source,
           source_event_id, event_type, payload, occurred_at
         )
         SELECT $1, $2, $3, COALESCE(max(journal_seq), 0) + 1,
                'RECONCILER', $4, 'invocation.uncertain', $5::jsonb, $6
           FROM agent_invocation_events
          WHERE invocation_id = $1
         RETURNING id::text AS id`,
        [
          input.invocationId,
          input.creatorId,
          input.consumerId,
          input.sourceEventId,
          JSON.stringify({ state: 'UNCERTAIN', errorCode: 'EXECUTION_STATE_UNKNOWN' }),
          terminalOccurredAt,
        ],
      );
      const terminalEventId = terminalEvent.rows[0]?.id;
      if (!terminalEventId) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'UNCERTAIN terminal Event 未返回 durable identity',
        );
      }
      await inject(this.failureInjector, 'UNCERTAIN_EVENT');

      const terminalPayload = ConsumerTerminalEventPayloadSchema.parse({
        protocol: CONSUMER_EVENT_OUTBOX_PROTOCOL,
        schemaVersion: 1,
        type: 'invocation.terminal',
        conversationId: input.conversationId,
        invocationId: input.invocationId,
        terminalState: 'UNCERTAIN',
        assistantMessageId: null,
        resultDigest: null,
        errorCode: 'EXECUTION_STATE_UNKNOWN',
        occurredAt: terminalOccurredAt,
      });
      const terminalPayloadDigest = consumerEventPayloadDigest(terminalPayload);
      const terminalDedupeKey = consumerEventDedupeKey({
        ownerId: input.consumerId,
        sourceEventId: terminalEventId,
        eventType: 'invocation.terminal',
      });
      const consumerEvent = await connection.query<{ cursor: string }>(
        `INSERT INTO consumer_event_outbox (
           owner_id, conversation_id, invocation_id, source_event_id,
           event_type, payload, payload_digest, dedupe_key
         ) VALUES ($1, $2, $3, $4, 'invocation.terminal', $5::jsonb, $6, $7)
         RETURNING cursor::text AS cursor`,
        [
          input.consumerId,
          input.conversationId,
          input.invocationId,
          terminalEventId,
          JSON.stringify(terminalPayload),
          terminalPayloadDigest,
          terminalDedupeKey,
        ],
      );
      const consumerEventCursor = consumerEvent.rows[0]?.cursor;
      if (!consumerEventCursor) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'UNCERTAIN Consumer Event Outbox 未返回 cursor',
        );
      }
      await inject(this.failureInjector, 'CONSUMER_EVENT_OUTBOX');

      await connection.query(
        `INSERT INTO consumer_event_streams (
           owner_id, conversation_id, latest_cursor, expired_through_cursor, updated_at
         ) VALUES ($1, $2, $3, 0, now())
         ON CONFLICT (owner_id, conversation_id) DO UPDATE
           SET latest_cursor = GREATEST(
                 consumer_event_streams.latest_cursor,
                 EXCLUDED.latest_cursor
               ),
               updated_at = now()`,
        [input.consumerId, input.conversationId, consumerEventCursor],
      );
      await inject(this.failureInjector, 'CONSUMER_EVENT_STREAM');

      const conversation = await connection.query(
        `UPDATE agent_conversations
            SET state = 'IDLE', last_activity_at = now()
          WHERE id = $1 AND creator_id = $2 AND consumer_subject_id = $3 AND state = 'BUSY'`,
        [input.conversationId, input.creatorId, input.consumerId],
      );
      if (conversation.rowCount !== 1) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'UNCERTAIN terminal 未原子释放 Conversation',
        );
      }
      await inject(this.failureInjector, 'CONVERSATION_IDLE');

      return {
        invocationId: input.invocationId,
        state: 'UNCERTAIN',
        reason: input.reason,
        reconciliationStartedAt: isoDate(current.reconciliation_started_at),
        reconciliationDeadlineAt: reconciliationDeadline(current.reconciliation_started_at),
        consumerEventCursor,
        exhausted: true,
        replayed: false,
      };
    });
  }

  /**
   * Claims a bounded batch for an at-least-once publisher. The lease is encoded by
   * next_attempt_at; publication itself happens only after this transaction commits.
   * A publisher crash can therefore duplicate delivery, but cannot lose the PG fact.
   */
  public async claimConsumerEvents(rawInput: {
    creatorId: string;
    consumerId: string;
    limit: number;
  }): Promise<DurableConsumerEvent[]> {
    const input = ClaimConsumerEventsInputSchema.parse(rawInput);
    return withTenantTransaction(this.pools.broker, input, async (connection) => {
      const result = await connection.query<ConsumerEventRow>(
        `WITH candidates AS (
           SELECT cursor
             FROM consumer_event_outbox
            WHERE owner_id = $1
              AND state = 'PENDING'
              AND attempt_count < 100
              AND next_attempt_at <= now()
              AND retained_until > now()
            ORDER BY cursor
            FOR UPDATE SKIP LOCKED
            LIMIT $2
         )
         UPDATE consumer_event_outbox AS event
            SET attempt_count = event.attempt_count + 1,
                next_attempt_at = now() + interval '30 seconds'
           FROM candidates
          WHERE event.cursor = candidates.cursor
          RETURNING event.cursor::text, event.owner_id, event.conversation_id,
                    event.invocation_id,
                    event.source_event_id, event.event_type, event.payload,
                    event.payload_digest, event.dedupe_key, event.state,
                    event.attempt_count, event.next_attempt_at, event.created_at,
                    event.published_at, event.retained_until`,
        [input.consumerId, input.limit],
      );
      return result.rows
        .map(parseConsumerEventRow)
        .sort((left, right) => (BigInt(left.cursor) < BigInt(right.cursor) ? -1 : 1));
    });
  }

  public async markConsumerEventPublished(rawInput: {
    creatorId: string;
    consumerId: string;
    conversationId: string;
    cursor: string;
    payloadDigest: string;
  }): Promise<{ cursor: string; replayed: boolean }> {
    const input = PublishConsumerEventInputSchema.parse(rawInput);
    return withTenantTransaction(this.pools.broker, input, async (connection) => {
      const current = await connection.query<{
        cursor: string;
        payload: unknown;
        payload_digest: string;
        state: string;
      }>(
        `SELECT cursor::text, payload, payload_digest, state
           FROM consumer_event_outbox
          WHERE owner_id = $1 AND conversation_id = $2 AND cursor = $3
          FOR UPDATE`,
        [input.consumerId, input.conversationId, input.cursor],
      );
      const row = current.rows[0];
      if (!row) {
        throw new CloudJournalError(
          'CONVERSATION_UNAVAILABLE',
          'Consumer Event 不存在或租户不匹配',
        );
      }
      if (row.payload_digest !== input.payloadDigest) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'Consumer Event 发布确认的 payload digest 不匹配',
        );
      }
      const payload = ConsumerTerminalEventPayloadSchema.safeParse(row.payload);
      if (!payload.success || consumerEventPayloadDigest(payload.data) !== row.payload_digest) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'Consumer Event 发布前 payload 完整性校验失败',
        );
      }
      if (row.state === 'PUBLISHED') {
        return { cursor: Uint63StringSchema.parse(row.cursor), replayed: true };
      }
      const updated = await connection.query<{ cursor: string }>(
        `UPDATE consumer_event_outbox
            SET state = 'PUBLISHED', published_at = now(), next_attempt_at = NULL
          WHERE owner_id = $1 AND conversation_id = $2 AND cursor = $3
            AND state = 'PENDING' AND payload_digest = $4
          RETURNING cursor::text`,
        [input.consumerId, input.conversationId, input.cursor, input.payloadDigest],
      );
      const cursor = updated.rows[0]?.cursor;
      if (!cursor) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'Consumer Event 发布 compare-and-set 失败',
        );
      }
      return { cursor: Uint63StringSchema.parse(cursor), replayed: false };
    });
  }

  public async replayConsumerEvents(rawInput: {
    creatorId: string;
    consumerId: string;
    conversationId: string;
    afterCursor: string;
    limit: number;
  }): Promise<ConsumerEventPage> {
    const input = ConsumerEventPageInputSchema.parse(rawInput);
    return withTenantTransaction(this.pools.api, input, async (connection) => {
      const conversation = await connection.query(
        `SELECT 1
           FROM agent_conversations
          WHERE id = $1 AND creator_id = $2 AND consumer_subject_id = $3`,
        [input.conversationId, input.creatorId, input.consumerId],
      );
      if (conversation.rowCount !== 1) {
        throw new CloudJournalError('CONVERSATION_UNAVAILABLE', 'Conversation 不存在或租户不匹配');
      }
      const stream = await connection.query<{
        latest_cursor: string;
        expired_through_cursor: string;
      }>(
        `SELECT latest_cursor::text, expired_through_cursor::text
           FROM consumer_event_streams
          WHERE owner_id = $1 AND conversation_id = $2`,
        [input.consumerId, input.conversationId],
      );
      const latestCursor = Uint63StringSchema.parse(stream.rows[0]?.latest_cursor ?? '0');
      const expiredThroughCursor = Uint63StringSchema.parse(
        stream.rows[0]?.expired_through_cursor ?? '0',
      );
      if (input.afterCursor !== '0' && BigInt(input.afterCursor) <= BigInt(expiredThroughCursor)) {
        throw new CloudJournalError('SSE_CURSOR_EXPIRED', '事件游标已过期，请重新加载完整对话');
      }
      const result = await connection.query<ConsumerEventRow>(
        `SELECT cursor::text, owner_id, conversation_id, invocation_id, source_event_id,
                event_type, payload, payload_digest, dedupe_key, state,
                attempt_count, next_attempt_at, created_at, published_at, retained_until
           FROM consumer_event_outbox
          WHERE owner_id = $1 AND conversation_id = $2 AND cursor > $3
          ORDER BY cursor
          LIMIT $4`,
        [input.consumerId, input.conversationId, input.afterCursor, input.limit],
      );
      return {
        latestCursor,
        expiredThroughCursor,
        events: result.rows.map(parseConsumerEventRow),
      };
    });
  }

  public async pruneExpiredConsumerEvents(rawInput: {
    creatorId: string;
    consumerId: string;
    conversationId: string;
  }): Promise<{ deleted: number; expiredThroughCursor: string }> {
    const input = ConsumerEventIdentitySchema.parse(rawInput);
    const pool = this.pools.reconciler;
    if (!pool) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'Consumer Event retention 需要独立 Reconciler pool',
      );
    }
    return withTenantTransaction(pool, input, async (connection) => {
      const stream = await connection.query<{ expired_through_cursor: string }>(
        `SELECT expired_through_cursor::text
           FROM consumer_event_streams
          WHERE owner_id = $1 AND conversation_id = $2
          FOR UPDATE`,
        [input.consumerId, input.conversationId],
      );
      if (!stream.rows[0]) {
        return { deleted: 0, expiredThroughCursor: '0' };
      }
      const removed = await connection.query<{ cursor: string }>(
        `WITH ordered AS (
           SELECT cursor,
                  bool_and(retained_until <= now()) OVER (
                    ORDER BY cursor
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                  ) AS expired_prefix
             FROM consumer_event_outbox
            WHERE owner_id = $1 AND conversation_id = $2
         ),
         prefix AS (
           SELECT cursor FROM ordered WHERE expired_prefix
         )
         DELETE FROM consumer_event_outbox AS event
          USING prefix
          WHERE event.owner_id = $1
            AND event.conversation_id = $2
            AND event.cursor = prefix.cursor
          RETURNING event.cursor::text`,
        [input.consumerId, input.conversationId],
      );
      const maxRemoved = removed.rows.reduce<bigint | null>((maximum, row) => {
        const cursor = BigInt(Uint63StringSchema.parse(row.cursor));
        return maximum === null || cursor > maximum ? cursor : maximum;
      }, null);
      if (maxRemoved === null) {
        return {
          deleted: 0,
          expiredThroughCursor: Uint63StringSchema.parse(stream.rows[0].expired_through_cursor),
        };
      }
      const updated = await connection.query<{ expired_through_cursor: string }>(
        `UPDATE consumer_event_streams
            SET expired_through_cursor = GREATEST(expired_through_cursor, $3),
                updated_at = now()
          WHERE owner_id = $1 AND conversation_id = $2
          RETURNING expired_through_cursor::text`,
        [input.consumerId, input.conversationId, maxRemoved.toString()],
      );
      const expiredThroughCursor = updated.rows[0]?.expired_through_cursor;
      if (!expiredThroughCursor) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'Consumer Event retention cursor 未原子推进',
        );
      }
      return {
        deleted: removed.rows.length,
        expiredThroughCursor: Uint63StringSchema.parse(expiredThroughCursor),
      };
    });
  }
}

// Keep protocol errors imported by dependants without accepting arbitrary strings here.
export const CloudJournalProtocolErrorCodeSchema = VnextErrorCodeSchema;
