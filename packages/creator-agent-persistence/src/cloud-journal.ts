import {
  BrokerSensitiveMessageSchema,
  CONSUMER_EVENT_OUTBOX_PROTOCOL,
  ConsumerEventOutboxRecordSchema,
  ConsumerTerminalEventPayloadSchema,
  ClientIdempotencyKeySchema,
  consumerEventDedupeKey,
  consumerEventPayloadDigest,
  HmacSha256DigestSchema,
  Sha256DigestSchema,
  Sha256HexSchema,
  Uint63StringSchema,
  UuidSchema,
  VnextErrorCodeSchema,
  WorkerInvocationCancelledFactSchema,
  WorkerInvocationFailedFactSchema,
  WorkerInvocationPreparedFactSchema,
  WorkerInvocationStartedFactSchema,
  WorkerInvocationSucceededFactSchema,
  workerInvocationFactDigest,
  type ConsumerEventOutboxRecord,
  type BrokerSensitiveMessage,
  type VnextErrorCode,
  type WorkerInvocationCancelledFact,
  type WorkerInvocationFailedFact,
  type WorkerInvocationPreparedFact,
  type WorkerInvocationStartedFact,
  type WorkerInvocationSucceededFact,
} from '@cb/creator-agent-protocol';
import { z } from 'zod';
import {
  EncryptedMessageSchema,
  type EncryptedMessage,
  type MessageAad,
} from './message-crypto.js';

export interface QueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number | null;
}

export interface InvocationProjectorTransaction {
  query<R = Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<QueryResult<R>>;
}

export interface JournalConnection extends InvocationProjectorTransaction {
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
  | 'CONVERSATION_CONTEXT_LIMIT'
  | 'USER_MESSAGE'
  | 'INVOCATION'
  | 'ACCEPTED_EVENT'
  | 'BROKER_OUTBOX'
  | 'CONVERSATION_BUSY'
  | 'INVOCATION_PERSISTED'
  | 'PREPARED_EVENT'
  | 'PREPARE_COMMAND_ACK'
  | 'START_COMMAND'
  | 'INVOCATION_STARTING'
  | 'INVOCATION_RUNNING'
  | 'STARTED_EVENT'
  | 'START_COMMAND_ACK'
  | 'ASSISTANT_MESSAGE'
  | 'SUCCESS_SEAL_PREFLIGHT'
  | 'INVOCATION_SUCCEEDED'
  | 'SUCCEEDED_EVENT'
  | 'SUCCESS_TERMINAL_RECEIPT'
  | 'SUCCESS_PREFLIGHT_CONSUMED'
  | 'INVOCATION_CANCELLED'
  | 'INVOCATION_FAILED'
  | 'CANCELLED_EVENT'
  | 'FAILED_EVENT'
  | 'CANCELLED_TERMINAL_RECEIPT'
  | 'FAILED_TERMINAL_RECEIPT'
  | 'INVOCATION_RECONCILING'
  | 'RECONCILING_EVENT'
  | 'RECONCILING_RESUMED_EVENT'
  | 'JOURNAL_INTEGRITY_ALERT'
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
      | 'CONVERSATION_CONTEXT_LIMIT'
      | 'CONVERSATION_UNAVAILABLE'
      | 'EXECUTION_AUTHORITY_MISMATCH'
      | 'WORKER_FACT_CONFLICT'
      | 'TERMINAL_CONFLICT'
      | 'JOURNAL_SECURITY_BLOCKED'
      | 'PERSISTENCE_INVARIANT_FAILED'
      | 'SSE_CURSOR_EXPIRED',
    message: string,
  ) {
    super(message);
    this.name = 'CloudJournalError';
  }
}

const TenantIdentitySchema = z.object({ creatorId: UuidSchema, consumerId: UuidSchema }).strict();
const CreatorIdentitySchema = z.object({ creatorId: UuidSchema }).strict();
const WorkerEventProjectorIdentitySchema = CreatorIdentitySchema.extend({
  installationId: UuidSchema,
}).strict();

const AcceptInvocationInputSchema = TenantIdentitySchema.extend({
  conversationId: UuidSchema,
  agentVersionId: UuidSchema,
  agentVersionDigest: Sha256HexSchema,
  targetWorkerId: UuidSchema,
  userMessageId: UuidSchema,
  invocationId: UuidSchema,
  outboxCommandId: UuidSchema,
  sourceEventId: UuidSchema,
  clientMessageId: ClientIdempotencyKeySchema,
  requestDigest: HmacSha256DigestSchema,
  // Internal admission candidates can name the first rejected turn (21). Public Message and
  // durable Message schemas remain capped at 20; the database function never inserts turn 21.
  turnNo: z.number().int().min(1).max(21),
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

const CommitSuccessInputSchema = WorkerEventProjectorIdentitySchema.extend({
  fact: WorkerInvocationSucceededFactSchema,
  factDigest: Sha256HexSchema,
  resultCiphertext: BrokerSensitiveMessageSchema,
}).strict();

export interface CommitSuccessInput extends Omit<z.input<typeof CommitSuccessInputSchema>, 'fact'> {
  fact: WorkerInvocationSucceededFact;
}

/**
 * Trusted transport-key/KMS boundary used only for a fresh terminal commit.
 * The implementation must authenticate/decrypt the Worker-session ciphertext,
 * recompute the tenant-domain result digest from plaintext, then seal it with
 * the durable owner-message key and the exact Cloud-generated AAD below.
 */
export interface SealAssistantMessageInput {
  resultCiphertext: BrokerSensitiveMessage;
  aad: MessageAad;
  signal: AbortSignal;
}

export interface SealedAssistantMessage {
  encryptedMessage: EncryptedMessage;
  /** result-domain HMAC recomputed from the authenticated transport plaintext. */
  verifiedResultDigest: string;
}

export type AssistantMessageSealer = (
  input: SealAssistantMessageInput,
) => SealedAssistantMessage | Promise<SealedAssistantMessage>;

export interface CommittedSuccess {
  invocationId: string;
  assistantMessageId: string;
  resultDigest: string;
  /** Null only when the exact terminal delivery record has passed durable retention. */
  consumerEventCursor: string | null;
  replayed: boolean;
}

export type ProjectSuccessOutcome =
  | Readonly<{ kind: 'COMMITTED'; committed: CommittedSuccess }>
  | Readonly<{ kind: 'SECURITY_BLOCKED' }>;

const PROJECT_SUCCESS_SECURITY_BLOCKED = Object.freeze({
  kind: 'SECURITY_BLOCKED' as const,
});

const SuccessFactPreflightOutcomeSchema = z.enum([
  'SEAL_REQUIRED',
  'EXACT',
  'SECURITY_BLOCKED',
  'TERMINAL',
  'UNAVAILABLE',
  'AUTHORITY_REJECTED',
  'INVARIANT_FAILED',
]);

interface SuccessFactPreflightRow {
  outcome: string;
  seal_token: string | null;
  assistant_message_id: string | null;
  aad_schema_version: string | number | null;
  aad_owner_id: string | null;
  aad_conversation_id: string | null;
  aad_role: string | null;
  result_digest: string | null;
  consumer_event_cursor: string | number | bigint | null;
  alert_id: string | null;
  alert_replayed: boolean | null;
}

const SuccessFactFinalizeOutcomeSchema = z.enum([
  'ADMITTED',
  'SECURITY_BLOCKED',
  'AUTHORITY_REJECTED',
  'INVARIANT_FAILED',
]);

interface SuccessFactFinalizeRow {
  outcome: string;
  assistant_message_id: string | null;
  result_digest: string | null;
  terminal_at: Date | string | null;
  consumer_event_cursor: string | number | bigint | null;
  assistant_message_appended: boolean | null;
  invocation_succeeded: boolean | null;
  succeeded_event_appended: boolean | null;
  consumer_event_appended: boolean | null;
  consumer_stream_advanced: boolean | null;
  terminal_receipt_appended: boolean | null;
  conversation_idled: boolean | null;
  preflight_consumed: boolean | null;
  alert_id: string | null;
  alert_replayed: boolean | null;
}

interface SuccessExactProjectionRow {
  state: string;
  conversation_id: string;
  result_message_id: string | null;
  result_digest: string | null;
  conversation_state: string;
  message_role: string | null;
  message_aad_version: number | null;
  terminal_source_event_id: string | null;
  terminal_fact_digest: string | null;
}

const CommitFailedInputSchema = WorkerEventProjectorIdentitySchema.extend({
  fact: WorkerInvocationFailedFactSchema,
  factDigest: Sha256HexSchema,
}).strict();

export interface CommitFailedInput extends Omit<z.input<typeof CommitFailedInputSchema>, 'fact'> {
  fact: WorkerInvocationFailedFact;
}

export interface CommittedFailed {
  invocationId: string;
  state: 'FAILED';
  errorCode: VnextErrorCode;
  /** Null only when the exact terminal delivery record has passed durable retention. */
  consumerEventCursor: string | null;
  replayed: boolean;
}

export type ProjectFailedOutcome =
  | Readonly<{ kind: 'COMMITTED'; committed: CommittedFailed }>
  | Readonly<{ kind: 'SECURITY_BLOCKED' }>;

const PROJECT_FAILED_SECURITY_BLOCKED = Object.freeze({
  kind: 'SECURITY_BLOCKED' as const,
});

const FailedFactAdmissionOutcomeSchema = z.enum([
  'ADMITTED',
  'EXACT',
  'SECURITY_BLOCKED',
  'TERMINAL',
  'UNAVAILABLE',
  'AUTHORITY_REJECTED',
  'INVARIANT_FAILED',
]);

interface FailedFactAdmissionRow {
  outcome: string;
  error_code: string | null;
  terminal_at: Date | string | null;
  consumer_event_cursor: string | number | bigint | null;
  invocation_failed: boolean | null;
  failed_event_appended: boolean | null;
  consumer_event_appended: boolean | null;
  consumer_stream_advanced: boolean | null;
  terminal_receipt_appended: boolean | null;
  conversation_idled: boolean | null;
  alert_id: string | null;
  alert_replayed: boolean | null;
}

const CommitPreparedInputSchema = WorkerEventProjectorIdentitySchema.extend({
  fact: WorkerInvocationPreparedFactSchema,
  factDigest: Sha256HexSchema,
}).strict();

export interface CommitPreparedInput extends Omit<
  z.input<typeof CommitPreparedInputSchema>,
  'fact'
> {
  fact: WorkerInvocationPreparedFact;
}

export interface CommittedPrepared {
  invocationId: string;
  state: 'PERSISTED' | 'RECONCILING';
  prepareCommandId: string;
  startCommandId: string | null;
  factDigest: string;
  replayed: boolean;
}

export type ProjectPreparedOutcome =
  | Readonly<{ kind: 'COMMITTED'; committed: CommittedPrepared }>
  | Readonly<{ kind: 'SECURITY_BLOCKED' }>;

const PROJECT_PREPARED_SECURITY_BLOCKED = Object.freeze({
  kind: 'SECURITY_BLOCKED' as const,
});

const PreparedFactAdmissionOutcomeSchema = z.enum([
  'ADMITTED',
  'EXACT',
  'SECURITY_BLOCKED',
  'TERMINAL',
  'UNAVAILABLE',
  'AUTHORITY_REJECTED',
  'INVARIANT_FAILED',
]);

interface PreparedFactAdmissionRow {
  outcome: string;
  alert_id: string | null;
  alert_replayed: boolean | null;
}

const CommitStartedInputSchema = WorkerEventProjectorIdentitySchema.extend({
  fact: WorkerInvocationStartedFactSchema,
  factDigest: Sha256HexSchema,
}).strict();

export interface CommitStartedInput extends Omit<z.input<typeof CommitStartedInputSchema>, 'fact'> {
  fact: WorkerInvocationStartedFact;
}

export interface CommittedStarted {
  invocationId: string;
  state: 'RUNNING' | 'RECONCILING';
  startCommandId: string;
  factDigest: string;
  startedAt: string;
  replayed: boolean;
}

export type ProjectStartedOutcome =
  | Readonly<{ kind: 'COMMITTED'; committed: CommittedStarted }>
  | Readonly<{ kind: 'SECURITY_BLOCKED' }>;

const PROJECT_STARTED_SECURITY_BLOCKED = Object.freeze({
  kind: 'SECURITY_BLOCKED' as const,
});

const StartedFactAdmissionOutcomeSchema = z.enum([
  'ADMITTED',
  'EXACT',
  'SECURITY_BLOCKED',
  'TERMINAL',
  'UNAVAILABLE',
  'AUTHORITY_REJECTED',
  'INVARIANT_FAILED',
]);

interface StartedFactAdmissionRow {
  outcome: string;
  projected_state: string | null;
  started_at: Date | string | null;
  entered_starting: boolean | null;
  reconciliation_root_appended: boolean | null;
  start_command_acked: boolean | null;
  alert_id: string | null;
  alert_replayed: boolean | null;
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

const JOURNAL_SECURITY_BLOCKED_COMMIT_OUTCOME = Object.freeze({
  kind: 'SECURITY_BLOCKED' as const,
});
type BeginReconciliationCommitOutcome =
  | BeginReconciliationResult
  | typeof JOURNAL_SECURITY_BLOCKED_COMMIT_OUTCOME;

function isJournalSecurityBlockedOutcome(
  outcome: BeginReconciliationCommitOutcome,
): outcome is typeof JOURNAL_SECURITY_BLOCKED_COMMIT_OUTCOME {
  return 'kind' in outcome && outcome.kind === 'SECURITY_BLOCKED';
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
  context_limit_reached_at: Date | string | null;
  deadline_valid: boolean;
}

interface FailedAuthorityRow {
  state: string;
  consumer_subject_id: string;
  result_message_id: string | null;
  result_digest: string | null;
  error_code: string | null;
  agent_version_digest: string;
  snapshot_digest: string;
  assigned_worker_id: string | null;
  assignment_lease_id: string | null;
  assignment_fence: string | number | bigint | null;
  execution_capability_id: string | null;
  execution_capability_digest: string | null;
  execution_capability_valid: boolean;
  execution_capability_revoked_at: Date | string | null;
  conversation_state: string;
  lease_state: string;
  lease_valid: boolean;
  has_durable_started_evidence: boolean;
  consumer_event_cursor: string | null;
  consumer_event_source_event_id: string | null;
  consumer_event_type: string | null;
  consumer_event_payload: unknown;
  consumer_event_payload_digest: string | null;
  consumer_event_dedupe_key: string | null;
  terminal_source_event_id: string | null;
  terminal_source_fact_digest: string | null;
  terminal_event_id: string | null;
  terminal_event_payload: unknown;
  terminal_event_occurred_at: Date | string | null;
  terminal_at: Date | string | null;
}

interface CancelledAuthorityRow {
  state: string;
  consumer_subject_id: string;
  result_message_id: string | null;
  result_digest: string | null;
  error_code: string | null;
  agent_version_digest: string;
  snapshot_digest: string;
  assigned_worker_id: string | null;
  assignment_lease_id: string | null;
  assignment_fence: string | number | bigint | null;
  execution_capability_id: string | null;
  execution_capability_digest: string | null;
  execution_capability_valid: boolean;
  execution_capability_revoked_at: Date | string | null;
  conversation_state: string;
  lease_state: string;
  lease_valid: boolean;
  has_durable_started_evidence: boolean;
  consumer_event_cursor: string | null;
  consumer_event_source_event_id: string | null;
  consumer_event_type: string | null;
  consumer_event_payload: unknown;
  consumer_event_payload_digest: string | null;
  consumer_event_dedupe_key: string | null;
  terminal_source_event_id: string | null;
  terminal_source_fact_digest: string | null;
  terminal_event_id: string | null;
  terminal_event_payload: unknown;
  terminal_event_occurred_at: Date | string | null;
  terminal_at: Date | string | null;
}

const CancelledInvocationEventPayloadSchema = z
  .object({
    state: z.literal('CANCELLED'),
  })
  .strict();

const CommitCancelledInputSchema = WorkerEventProjectorIdentitySchema.extend({
  fact: WorkerInvocationCancelledFactSchema,
  factDigest: Sha256HexSchema,
}).strict();

export interface CommitCancelledInput extends Omit<
  z.input<typeof CommitCancelledInputSchema>,
  'fact'
> {
  fact: WorkerInvocationCancelledFact;
}

export interface CommittedCancelled {
  invocationId: string;
  state: 'CANCELLED';
  /** Null only when the exact terminal delivery record has passed durable retention. */
  consumerEventCursor: string | null;
  replayed: boolean;
}

export type ProjectCancelledOutcome =
  | Readonly<{ kind: 'COMMITTED'; committed: CommittedCancelled }>
  | Readonly<{ kind: 'SECURITY_BLOCKED' }>;

const PROJECT_CANCELLED_SECURITY_BLOCKED = Object.freeze({
  kind: 'SECURITY_BLOCKED' as const,
});

const CancelledFactAdmissionOutcomeSchema = z.enum([
  'ADMITTED',
  'EXACT',
  'SECURITY_BLOCKED',
  'TERMINAL',
  'UNAVAILABLE',
  'AUTHORITY_REJECTED',
  'INVARIANT_FAILED',
]);

interface CancelledFactAdmissionRow {
  outcome: string;
  interrupt_receipt_digest: string | null;
  terminal_at: Date | string | null;
  consumer_event_cursor: string | number | bigint | null;
  invocation_cancelled: boolean | null;
  cancelled_event_appended: boolean | null;
  consumer_event_appended: boolean | null;
  consumer_stream_advanced: boolean | null;
  terminal_receipt_appended: boolean | null;
  conversation_idled: boolean | null;
  alert_id: string | null;
  alert_replayed: boolean | null;
}

interface InvocationLifecycleAuthorityRow {
  state: string;
  request_digest: string;
  deadline_at: Date | string;
  deadline_valid: boolean;
  agent_version_id: string;
  agent_version_digest: string;
  snapshot_digest: string;
  assigned_worker_id: string | null;
  assignment_lease_id: string | null;
  assignment_fence: string | number | bigint | null;
  execution_capability_id: string | null;
  execution_capability_digest: string | null;
  execution_capability_expires_at: Date | string | null;
  execution_capability_revoked_at: Date | string | null;
  execution_capability_valid: boolean;
  runtime_thread_id: string | null;
  runtime_turn_id: string | null;
  reconciliation_reason: string | null;
  reconciliation_started_at: Date | string | null;
  deployment_id: string;
  conversation_state: string;
}

interface InvocationLeaseAuthorityRow {
  state: string;
  expires_at: Date | string;
  lease_valid: boolean;
  deployment_id: string;
  creator_id: string;
  worker_id: string;
  fence: string | number | bigint;
}

interface InvocationCommandAuthorityRow {
  command_id: string;
  creator_id: string;
  target_worker_id: string;
  invocation_id: string | null;
  consumer_subject_id: string | null;
  conversation_id: string | null;
  deployment_id: string | null;
  assignment_lease_id: string | null;
  assignment_fence: string | number | bigint | null;
  predecessor_command_id: string | null;
  execution_capability_id: string | null;
  execution_capability_digest: string | null;
  command_type: string;
  state: string;
  attempt_count: number;
  expires_at: Date | string;
  command_valid: boolean;
}

interface InvocationLifecycleEventRow {
  invocation_id: string;
  source_event_id: string;
  event_type: string;
  source_fact_digest: string | null;
  broker_command_id: string | null;
  payload: unknown;
  occurred_at: Date | string;
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
  terminal_event_id: string | null;
  terminal_event_payload: unknown;
  terminal_event_occurred_at: Date | string | null;
  reconciliation_source_event_id: string | null;
}

interface BeginReconciliationAuthorityRow extends ReconciliationAuthorityRow {
  reconciliation_event_payload: unknown;
  reconciliation_event_occurred_at: Date | string | null;
  reconciliation_journal_seq: string | number | bigint | null;
  latest_started_source_event_id: string | null;
  latest_started_journal_seq: string | number | bigint | null;
  reconciliation_resumed_source_event_id: string | null;
  reconciliation_resumed_event_payload: unknown;
  reconciliation_resumed_journal_seq: string | number | bigint | null;
}

const BeginReconciliationAdmissionOutcomeSchema = z.enum([
  'ADMITTED',
  'EXACT',
  'SOURCE_DIFFERENT',
  'TERMINAL',
  'UNAVAILABLE',
  'INVARIANT_FAILED',
  'SECURITY_BLOCKED',
]);

interface BeginReconciliationAdmissionRow {
  outcome: string;
  reconciliation_started_at: Date | string | null;
  alert_id: string | null;
  alert_replayed: boolean | null;
}

const ReconciliationInvocationEventPayloadSchema = z
  .object({
    state: z.literal('RECONCILING'),
    reason: InvocationUncertaintyReasonSchema,
  })
  .strict();

const UncertainInvocationEventPayloadSchema = z
  .object({
    state: z.literal('UNCERTAIN'),
    errorCode: z.literal('EXECUTION_STATE_UNKNOWN'),
  })
  .strict();

const CONFIRMED_WORKER_FAILURE_CODES = [
  'SNAPSHOT_DIGEST_MISMATCH',
  'PROTOCOL_INCOMPATIBLE',
  'MODEL_QUOTA_EXHAUSTED',
  'SANDBOX_ATTESTATION_FAILED',
  'RUNTIME_START_FAILED',
  'TURN_TIMEOUT',
  'TURN_FAILED',
] as const satisfies readonly VnextErrorCode[];

const ConfirmedWorkerFailureCodeSchema = z.enum(CONFIRMED_WORKER_FAILURE_CODES);

const FailedInvocationEventPayloadSchema = z
  .object({
    state: z.literal('FAILED'),
    errorCode: ConfirmedWorkerFailureCodeSchema,
  })
  .strict();

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

async function withCreatorTransaction<T>(
  pool: JournalPool,
  identity: { creatorId: string },
  operation: (connection: JournalConnection) => Promise<T>,
): Promise<T> {
  const parsedIdentity = CreatorIdentitySchema.parse({ creatorId: identity.creatorId });
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    try {
      await connection.query(`SELECT set_config('app.creator_id', $1, true)`, [
        parsedIdentity.creatorId,
      ]);
      // A pooled connection must not retain an earlier Consumer identity. Each
      // narrow database authority locks and derives the Creator-visible Invocation,
      // then installs the exact Consumer context before any tenant mutation.
      await connection.query(`SELECT set_config('app.consumer_id', '', true)`);
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

function bindInvocationProjectorSignal(
  transaction: InvocationProjectorTransaction,
  signal: AbortSignal,
): InvocationProjectorTransaction {
  return {
    async query<R = Record<string, unknown>>(
      sql: string,
      parameters?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      signal.throwIfAborted();
      return transaction.query<R>(sql, parameters, signal);
    },
  };
}

function adaptStandaloneJournalTransaction(
  connection: JournalConnection,
): InvocationProjectorTransaction {
  return {
    async query<R = Record<string, unknown>>(
      sql: string,
      parameters?: readonly unknown[],
      signal?: AbortSignal,
    ): Promise<QueryResult<R>> {
      signal?.throwIfAborted();
      const result = await connection.query<R>(sql, parameters);
      signal?.throwIfAborted();
      return result;
    },
  };
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

const SUCCESS_SEAL_HARD_TIMEOUT_MS = 10_000;

async function settleAssistantMessageSealer(
  sealer: AssistantMessageSealer,
  input: Omit<SealAssistantMessageInput, 'signal'>,
  callerSignal: AbortSignal,
): Promise<SealedAssistantMessage> {
  const hardDeadline = AbortSignal.timeout(SUCCESS_SEAL_HARD_TIMEOUT_MS);
  const signal = AbortSignal.any([callerSignal, hardDeadline]);
  signal.throwIfAborted();
  let rejectOnAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = (): void => {
    rejectOnAbort(signal.reason ?? new DOMException('Operation aborted', 'AbortError'));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  const pending = Promise.resolve().then(() =>
    sealer({
      ...input,
      signal,
    }),
  );
  try {
    const settled = await Promise.race([pending, aborted]);
    signal.throwIfAborted();
    return settled;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function assertCanonicalWorkerFact(
  fact:
    | WorkerInvocationPreparedFact
    | WorkerInvocationStartedFact
    | WorkerInvocationSucceededFact
    | WorkerInvocationFailedFact
    | WorkerInvocationCancelledFact,
  expectedDigest: string,
): void {
  if (workerInvocationFactDigest(fact) !== expectedDigest) {
    throw new CloudJournalError(
      'WORKER_FACT_CONFLICT',
      'Worker Invocation factDigest 与 canonical fact 不一致',
    );
  }
}

function bigintEquals(value: string | number | bigint | null, expected: string): boolean {
  return value !== null && BigInt(value) === BigInt(expected);
}

function successPreflightBusinessFieldsAreNull(row: SuccessFactPreflightRow): boolean {
  return (
    row.seal_token === null &&
    row.assistant_message_id === null &&
    row.aad_schema_version === null &&
    row.aad_owner_id === null &&
    row.aad_conversation_id === null &&
    row.aad_role === null &&
    row.result_digest === null &&
    row.consumer_event_cursor === null
  );
}

function successFinalizeBusinessFieldsAreNull(row: SuccessFactFinalizeRow): boolean {
  return (
    row.assistant_message_id === null &&
    row.result_digest === null &&
    row.terminal_at === null &&
    row.consumer_event_cursor === null &&
    row.assistant_message_appended === null &&
    row.invocation_succeeded === null &&
    row.succeeded_event_appended === null &&
    row.consumer_event_appended === null &&
    row.consumer_stream_advanced === null &&
    row.terminal_receipt_appended === null &&
    row.conversation_idled === null &&
    row.preflight_consumed === null
  );
}

function exactLifecycleEventMatches(input: {
  event: InvocationLifecycleEventRow;
  invocationId: string;
  sourceEventId: string;
  eventType: 'invocation.persisted' | 'invocation.started';
  factDigest: string;
  commandId: string;
  state: 'PERSISTED' | 'RUNNING' | 'RECONCILING';
}): boolean {
  const payload = z
    .object({ state: z.literal(input.state) })
    .strict()
    .safeParse(input.event.payload);
  return (
    input.event.invocation_id === input.invocationId &&
    input.event.source_event_id === input.sourceEventId &&
    input.event.event_type === input.eventType &&
    input.event.source_fact_digest === input.factDigest &&
    input.event.broker_command_id === input.commandId &&
    payload.success
  );
}

function committedPreparedOutcome(committed: CommittedPrepared): ProjectPreparedOutcome {
  return { kind: 'COMMITTED', committed };
}

function committedSuccessOutcome(committed: CommittedSuccess): ProjectSuccessOutcome {
  return { kind: 'COMMITTED', committed };
}

function isSuccessSecurityBlocked(
  outcome: ProjectSuccessOutcome,
): outcome is typeof PROJECT_SUCCESS_SECURITY_BLOCKED {
  return outcome.kind === 'SECURITY_BLOCKED';
}

function isPreparedSecurityBlocked(
  outcome: ProjectPreparedOutcome,
): outcome is typeof PROJECT_PREPARED_SECURITY_BLOCKED {
  return outcome.kind === 'SECURITY_BLOCKED';
}

function committedStartedOutcome(committed: CommittedStarted): ProjectStartedOutcome {
  return { kind: 'COMMITTED', committed };
}

function isStartedSecurityBlocked(
  outcome: ProjectStartedOutcome,
): outcome is typeof PROJECT_STARTED_SECURITY_BLOCKED {
  return outcome.kind === 'SECURITY_BLOCKED';
}

function committedFailedOutcome(committed: CommittedFailed): ProjectFailedOutcome {
  return { kind: 'COMMITTED', committed };
}

function isFailedSecurityBlocked(
  outcome: ProjectFailedOutcome,
): outcome is typeof PROJECT_FAILED_SECURITY_BLOCKED {
  return outcome.kind === 'SECURITY_BLOCKED';
}

function committedCancelledOutcome(committed: CommittedCancelled): ProjectCancelledOutcome {
  return { kind: 'COMMITTED', committed };
}

function exactReconciliationEventMatches(input: {
  event: InvocationLifecycleEventRow;
  invocationId: string;
  sourceEventId?: string;
  eventType: 'invocation.reconciling' | 'invocation.reconciling_resumed';
  reason: InvocationUncertaintyReason;
  occurredAt?: Date | string;
}): boolean {
  const payload = ReconciliationInvocationEventPayloadSchema.safeParse(input.event.payload);
  return (
    input.event.invocation_id === input.invocationId &&
    (input.sourceEventId === undefined || input.event.source_event_id === input.sourceEventId) &&
    input.event.event_type === input.eventType &&
    input.event.source_fact_digest === null &&
    input.event.broker_command_id === null &&
    payload.success &&
    payload.data.reason === input.reason &&
    (input.occurredAt === undefined ||
      isoDate(input.event.occurred_at) === isoDate(input.occurredAt))
  );
}

function reconciliationResumedSourceEventId(
  rootSourceEventId: string,
  latestStartedSourceEventId: string,
): string {
  const sourceEventId = `resume-reconciliation:${rootSourceEventId}:${latestStartedSourceEventId}`;
  if (sourceEventId.length > 256) {
    throw new CloudJournalError(
      'PERSISTENCE_INVARIANT_FAILED',
      'reconciliation resumed durable source identity 超出数据库上限',
    );
  }
  return sourceEventId;
}

function reconciliationRootAcceptsInput(
  rootSourceEventId: string | null,
  inputSourceEventId: string,
): boolean {
  return (
    rootSourceEventId === inputSourceEventId ||
    rootSourceEventId === `late-prepared:${inputSourceEventId}` ||
    rootSourceEventId === `late-started:${inputSourceEventId}`
  );
}

function positiveJournalSeq(value: string | number | bigint | null): bigint | null {
  try {
    const parsed = value === null ? 0n : BigInt(value);
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

export class PostgresCloudJournal {
  public constructor(
    private readonly pools: PostgresCloudJournalPools,
    private readonly failureInjector?: FailureInjector,
  ) {}

  public async acceptInvocation(rawInput: AcceptInvocationInput): Promise<AcceptedInvocation> {
    const input = AcceptInvocationInputSchema.parse(rawInput);
    const outcome = await withTenantTransaction<AcceptedInvocation | null>(
      this.pools.api,
      input,
      async (connection) => {
        await connection.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
          `${input.conversationId}:${input.clientMessageId}`,
        ]);
        const existing = await connection.query<ExistingInvocationRow>(
          `SELECT id, user_message_id, request_digest, state
           FROM agent_invocations
          WHERE conversation_id = $1 AND client_message_id = $2`,
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
          `SELECT conversation.agent_version_id, conversation.version_digest,
                conversation.state,
                conversation.assigned_worker_id, conversation.next_turn_no,
                conversation.context_limit_reached_at,
                ($4::timestamptz > now()
                 AND $4::timestamptz <= now() + interval '120 seconds') AS deadline_valid
           FROM agent_conversations AS conversation
          WHERE conversation.id = $1
            AND conversation.creator_id = $2
            AND conversation.consumer_subject_id = $3
          FOR UPDATE OF conversation`,
          [input.conversationId, input.creatorId, input.consumerId, input.deadlineAt],
        );
        const current = conversation.rows[0];
        if (!current) {
          throw new CloudJournalError(
            'CONVERSATION_UNAVAILABLE',
            'Conversation 不存在或租户/Version authority 不匹配',
          );
        }
        if (
          current.agent_version_id !== input.agentVersionId ||
          current.version_digest !== input.agentVersionDigest ||
          current.assigned_worker_id !== input.targetWorkerId ||
          Number(current.next_turn_no) !== input.turnNo
        ) {
          throw new CloudJournalError(
            'CONVERSATION_UNAVAILABLE',
            'Conversation 不是可接收本轮的精确 Version/Worker/turn 状态',
          );
        }
        if (current.context_limit_reached_at !== null) {
          if (current.state === 'SUSPENDED') return null;
          throw new CloudJournalError(
            'CONVERSATION_UNAVAILABLE',
            'Context-limit Conversation 已进入其他只读或终态',
          );
        }
        if (current.state !== 'IDLE' || current.deadline_valid !== true) {
          throw new CloudJournalError(
            'CONVERSATION_UNAVAILABLE',
            'Conversation 当前不可接收新轮次',
          );
        }
        const admission = await connection.query<{ admission_outcome: string }>(
          `SELECT admission_outcome
           FROM creator_agent_admit_user_message_v1(
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             $11, $12, $13, $14, $15, $16, $17, $18, $19
           )`,
          [
            input.userMessageId,
            input.conversationId,
            input.creatorId,
            input.consumerId,
            input.agentVersionId,
            input.agentVersionDigest,
            input.targetWorkerId,
            input.turnNo,
            input.deadlineAt,
            input.clientMessageId,
            ...encryptedParameters(input.encryptedUserMessage),
            input.invocationId,
          ],
        );
        if (admission.rows[0]?.admission_outcome === 'CONTEXT_LIMIT') {
          await inject(this.failureInjector, 'CONVERSATION_CONTEXT_LIMIT');
          return null;
        }
        if (admission.rowCount !== 1 || admission.rows[0]?.admission_outcome !== 'ADMITTED') {
          throw new CloudJournalError(
            'PERSISTENCE_INVARIANT_FAILED',
            'USER Message admission 未返回唯一稳定 outcome',
          );
        }
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

        const projection = await connection.query<{ state: string; next_turn_no: number }>(
          `SELECT state, next_turn_no
           FROM agent_conversations
          WHERE id = $1 AND creator_id = $2 AND consumer_subject_id = $3`,
          [input.conversationId, input.creatorId, input.consumerId],
        );
        if (
          projection.rowCount !== 1 ||
          projection.rows[0]?.state !== 'BUSY' ||
          Number(projection.rows[0].next_turn_no) !== input.turnNo + 1
        ) {
          throw new CloudJournalError(
            'PERSISTENCE_INVARIANT_FAILED',
            'Conversation admission function 未原子进入 BUSY',
          );
        }
        await inject(this.failureInjector, 'CONVERSATION_BUSY');

        return {
          invocationId: input.invocationId,
          userMessageId: input.userMessageId,
          state: 'ACCEPTED',
          replayed: false,
        };
      },
    );
    if (outcome === null) {
      // The marker must commit before the stable public error escapes this method. Throwing from
      // inside withTenantTransaction would roll the SUSPENDED authority back.
      throw new CloudJournalError(
        'CONVERSATION_CONTEXT_LIMIT',
        'Conversation 已达到 pinned RuntimePolicy 上下文上限',
      );
    }
    return outcome;
  }

  public async commitPrepared(
    rawInput: CommitPreparedInput,
    signal: AbortSignal = AbortSignal.timeout(10_000),
  ): Promise<CommittedPrepared> {
    const input = CommitPreparedInputSchema.parse(rawInput);
    const outcome = await withCreatorTransaction(this.pools.broker, input, (connection) =>
      this.projectPrepared(adaptStandaloneJournalTransaction(connection), input, signal),
    );
    if (isPreparedSecurityBlocked(outcome)) {
      throw new CloudJournalError('JOURNAL_SECURITY_BLOCKED', 'JOURNAL_SECURITY_BLOCKED');
    }
    return outcome.committed;
  }

  /** Project a strict Gateway invocation.prepared event inside the caller's transaction. */
  public async projectPrepared(
    rawConnection: InvocationProjectorTransaction,
    rawInput: CommitPreparedInput,
    signal: AbortSignal,
  ): Promise<ProjectPreparedOutcome> {
    const connection = bindInvocationProjectorSignal(rawConnection, signal);
    const input = CommitPreparedInputSchema.parse(rawInput);
    assertCanonicalWorkerFact(input.fact, input.factDigest);
    const admission = await connection.query<PreparedFactAdmissionRow>(
      `SELECT outcome, alert_id::text, alert_replayed
         FROM creator_agent_project_prepared_fact_v1(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
         )`,
      [
        input.creatorId,
        input.installationId,
        input.fact.protocol,
        input.fact.schemaVersion,
        input.fact.type,
        input.fact.sourceEventId,
        input.fact.invocationId,
        input.fact.agentVersionDigest,
        input.fact.snapshotDigest,
        input.fact.executionCapabilityDigest,
        input.fact.leaseId,
        input.fact.fence,
        input.fact.requestDigest,
        input.fact.prepareCommandId,
        input.factDigest,
      ],
    );
    const admissionRow = admission.rows[0];
    const admissionOutcome = PreparedFactAdmissionOutcomeSchema.safeParse(admissionRow?.outcome);
    if (admission.rowCount !== 1 || !admissionRow || !admissionOutcome.success) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'prepared fact admission 未返回唯一稳定 outcome',
      );
    }
    if (admissionOutcome.data === 'SECURITY_BLOCKED') {
      if (
        !UuidSchema.safeParse(admissionRow.alert_id).success ||
        typeof admissionRow.alert_replayed !== 'boolean'
      ) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'prepared fact security block 缺少 durable alert outcome',
        );
      }
      await inject(this.failureInjector, 'JOURNAL_INTEGRITY_ALERT');
      return PROJECT_PREPARED_SECURITY_BLOCKED;
    }
    if (admissionRow.alert_id !== null || admissionRow.alert_replayed !== null) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'prepared fact non-security outcome 携带了 alert metadata',
      );
    }
    switch (admissionOutcome.data) {
      case 'TERMINAL':
        throw new CloudJournalError('TERMINAL_CONFLICT', 'Invocation 已有终态');
      case 'UNAVAILABLE':
      case 'AUTHORITY_REJECTED':
        throw new CloudJournalError(
          'EXECUTION_AUTHORITY_MISMATCH',
          'prepared fact 与 durable execution authority 不一致',
        );
      case 'INVARIANT_FAILED':
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'prepared fact durable invariant 失败',
        );
      case 'ADMITTED':
      case 'EXACT':
        break;
    }
    const admitted = admissionOutcome.data === 'ADMITTED';
    if (admitted) {
      await inject(this.failureInjector, 'INVOCATION_PERSISTED');
      await inject(this.failureInjector, 'PREPARED_EVENT');
    }

    const tenant = await connection.query<{
      consumer_subject_id: string;
      conversation_id: string;
    }>(
      `SELECT consumer_subject_id::text, conversation_id::text
         FROM agent_invocations
        WHERE id = $1 AND creator_id = $2 AND assigned_worker_id = $3`,
      [input.fact.invocationId, input.creatorId, input.installationId],
    );
    const parsedConsumerId = UuidSchema.safeParse(tenant.rows[0]?.consumer_subject_id);
    const parsedConversationId = UuidSchema.safeParse(tenant.rows[0]?.conversation_id);
    if (tenant.rows.length !== 1 || !parsedConsumerId.success || !parsedConversationId.success) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'prepared fact admission 未保留 exact tenant projection',
      );
    }
    const consumerId = parsedConsumerId.data;
    const conversationId = parsedConversationId.data;

    const authority = await connection.query<InvocationLifecycleAuthorityRow>(
      `SELECT invocation.state, invocation.request_digest, invocation.deadline_at,
                invocation.deadline_at > now() AS deadline_valid,
                invocation.agent_version_id,
                version.version_digest AS agent_version_digest,
                snapshot.snapshot_digest,
                invocation.assigned_worker_id, invocation.assignment_lease_id,
                invocation.assignment_fence, invocation.execution_capability_id,
                invocation.execution_capability_digest,
                invocation.execution_capability_expires_at,
                invocation.execution_capability_revoked_at,
                (
                  invocation.execution_capability_expires_at > now()
                  AND invocation.execution_capability_revoked_at IS NULL
                ) AS execution_capability_valid,
                invocation.runtime_thread_id, invocation.runtime_turn_id,
                invocation.reconciliation_reason, invocation.reconciliation_started_at,
                conversation.deployment_id, conversation.state AS conversation_state
           FROM agent_invocations AS invocation
           JOIN agent_conversations AS conversation
             ON conversation.id = invocation.conversation_id
            AND conversation.creator_id = invocation.creator_id
            AND conversation.consumer_subject_id = invocation.consumer_subject_id
           JOIN agent_versions AS version
             ON version.id = invocation.agent_version_id
            AND version.creator_id = invocation.creator_id
           JOIN context_snapshots AS snapshot
             ON snapshot.id = version.snapshot_id
            AND snapshot.creator_id = version.creator_id
          WHERE invocation.id = $1
            AND invocation.conversation_id = $2
            AND invocation.creator_id = $3
            AND invocation.consumer_subject_id = $4
          FOR UPDATE OF invocation, conversation`,
      [input.fact.invocationId, conversationId, input.creatorId, consumerId],
    );
    const current = authority.rows[0];
    if (!current) {
      throw new CloudJournalError(
        'EXECUTION_AUTHORITY_MISMATCH',
        'prepared Invocation 不存在或租户不匹配',
      );
    }

    const lifecycleEvents = await connection.query<InvocationLifecycleEventRow>(
      `SELECT invocation_id, source_event_id, event_type, source_fact_digest,
                broker_command_id, payload, occurred_at
           FROM agent_invocation_events
          WHERE source = 'WORKER'
            AND (
              source_event_id = $1
              OR (invocation_id = $2 AND event_type = 'invocation.persisted')
            )`,
      [input.fact.sourceEventId, input.fact.invocationId],
    );
    const exactEvents = lifecycleEvents.rows.filter((event) =>
      exactLifecycleEventMatches({
        event,
        invocationId: input.fact.invocationId,
        sourceEventId: input.fact.sourceEventId,
        eventType: 'invocation.persisted',
        factDigest: input.factDigest,
        commandId: input.fact.prepareCommandId,
        state: 'PERSISTED',
      }),
    );
    if (lifecycleEvents.rows.length > 0 && exactEvents.length !== lifecycleEvents.rows.length) {
      throw new CloudJournalError(
        'WORKER_FACT_CONFLICT',
        'prepared sourceEventId 或 Invocation lifecycle fact 与 durable digest 冲突',
      );
    }
    if (exactEvents.length !== 1) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'prepared fact admission 未留下唯一 exact durable Event',
      );
    }

    if (
      current.agent_version_digest !== input.fact.agentVersionDigest ||
      current.snapshot_digest !== input.fact.snapshotDigest ||
      current.request_digest !== input.fact.requestDigest ||
      current.assigned_worker_id !== input.installationId ||
      current.assignment_lease_id !== input.fact.leaseId ||
      !bigintEquals(current.assignment_fence, input.fact.fence) ||
      current.execution_capability_id === null ||
      current.execution_capability_digest !== input.fact.executionCapabilityDigest
    ) {
      throw new CloudJournalError(
        'EXECUTION_AUTHORITY_MISMATCH',
        'prepared fact 与 durable Version/Snapshot/Worker/Lease/Fence/Capability 不一致',
      );
    }

    const lease = await connection.query<InvocationLeaseAuthorityRow>(
      `SELECT state, expires_at, expires_at > now() AS lease_valid,
                deployment_id, creator_id, worker_id, fence
           FROM worker_leases
          WHERE id = $1 AND deployment_id = $2 AND creator_id = $3
            AND worker_id = $4 AND fence = $5
          FOR UPDATE`,
      [
        input.fact.leaseId,
        current.deployment_id,
        input.creatorId,
        input.installationId,
        input.fact.fence,
      ],
    );
    const currentLease = lease.rows[0];
    if (!currentLease) {
      throw new CloudJournalError(
        'EXECUTION_AUTHORITY_MISMATCH',
        'prepared fact 缺少 exact Deployment Lease/Fence',
      );
    }

    const prepareCommand = await connection.query<InvocationCommandAuthorityRow>(
      `SELECT command_id, creator_id, target_worker_id, invocation_id,
                consumer_subject_id, conversation_id, deployment_id,
                assignment_lease_id, assignment_fence, predecessor_command_id,
                execution_capability_id, execution_capability_digest,
                command_type, state, attempt_count, expires_at,
                expires_at > now() AS command_valid
           FROM broker_outbox
          WHERE command_id = $1 AND creator_id = $2
          FOR UPDATE`,
      [input.fact.prepareCommandId, input.creatorId],
    );
    const command = prepareCommand.rows[0];
    if (
      !command ||
      command.command_type !== 'invocation.prepare' ||
      command.target_worker_id !== input.installationId ||
      command.invocation_id !== input.fact.invocationId ||
      command.consumer_subject_id !== consumerId ||
      command.conversation_id !== conversationId ||
      command.deployment_id !== current.deployment_id ||
      command.assignment_lease_id !== input.fact.leaseId ||
      !bigintEquals(command.assignment_fence, input.fact.fence) ||
      command.predecessor_command_id !== null ||
      command.execution_capability_id !== current.execution_capability_id ||
      command.execution_capability_digest !== input.fact.executionCapabilityDigest
    ) {
      throw new CloudJournalError(
        'EXECUTION_AUTHORITY_MISMATCH',
        'prepared fact 没有绑定 exact invocation.prepare Outbox command',
      );
    }
    if (admitted && command.state === 'ACKED') {
      await inject(this.failureInjector, 'PREPARE_COMMAND_ACK');
    }

    const startCommands = await connection.query<InvocationCommandAuthorityRow>(
      `SELECT command_id, creator_id, target_worker_id, invocation_id,
                consumer_subject_id, conversation_id, deployment_id,
                assignment_lease_id, assignment_fence, predecessor_command_id,
                execution_capability_id, execution_capability_digest,
                command_type, state, attempt_count, expires_at,
                expires_at > now() AS command_valid
           FROM broker_outbox
          WHERE invocation_id = $1 AND command_type = 'invocation.start'
          FOR UPDATE`,
      [input.fact.invocationId],
    );

    const lateReconciliationSourceEventId = `late-prepared:${input.fact.sourceEventId}`;
    const reconciliationEvents = await connection.query<InvocationLifecycleEventRow>(
      `SELECT invocation_id, source_event_id, event_type, source_fact_digest,
                broker_command_id, payload, occurred_at
           FROM agent_invocation_events
          WHERE invocation_id = $1 AND source = 'RECONCILER'
            AND event_type = 'invocation.reconciling'`,
      [input.fact.invocationId],
    );
    const exactLateReconciliation = reconciliationEvents.rows.filter((event) => {
      const payload = z
        .object({
          state: z.literal('RECONCILING'),
          reason: z.literal('START_DISPATCH_UNKNOWN'),
        })
        .strict()
        .safeParse(event.payload);
      return (
        event.invocation_id === input.fact.invocationId &&
        event.source_event_id === lateReconciliationSourceEventId &&
        event.event_type === 'invocation.reconciling' &&
        event.source_fact_digest === null &&
        event.broker_command_id === null &&
        payload.success
      );
    });

    if (!admitted) {
      const start = startCommands.rows[0];
      if (startCommands.rows.length === 1 && start) {
        if (
          ![
            'PERSISTED',
            'STARTING',
            'RUNNING',
            'CANCEL_REQUESTED',
            'RECONCILING',
            'SUCCEEDED',
            'FAILED',
            'CANCELLED',
            'UNCERTAIN',
          ].includes(current.state) ||
          command.state !== 'ACKED' ||
          start.predecessor_command_id !== input.fact.prepareCommandId ||
          start.target_worker_id !== input.installationId ||
          start.invocation_id !== input.fact.invocationId ||
          start.consumer_subject_id !== consumerId ||
          start.conversation_id !== conversationId ||
          start.deployment_id !== current.deployment_id ||
          start.assignment_lease_id !== input.fact.leaseId ||
          !bigintEquals(start.assignment_fence, input.fact.fence) ||
          start.execution_capability_id !== current.execution_capability_id ||
          start.execution_capability_digest !== input.fact.executionCapabilityDigest
        ) {
          throw new CloudJournalError(
            'PERSISTENCE_INVARIANT_FAILED',
            '已提交 prepared fact 缺少 exact durable start command',
          );
        }
        return committedPreparedOutcome({
          invocationId: input.fact.invocationId,
          state: 'PERSISTED',
          prepareCommandId: input.fact.prepareCommandId,
          startCommandId: start.command_id,
          factDigest: input.factDigest,
          replayed: true,
        });
      }
      if (
        startCommands.rows.length !== 0 ||
        !['RECONCILING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN'].includes(current.state) ||
        !['ACKED', 'EXPIRED'].includes(command.state) ||
        current.reconciliation_reason !== 'START_DISPATCH_UNKNOWN' ||
        current.reconciliation_started_at === null ||
        reconciliationEvents.rows.length !== 1 ||
        exactLateReconciliation.length !== 1
      ) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          '已提交 late prepared fact 缺少 exact durable reconciliation binding',
        );
      }
      return committedPreparedOutcome({
        invocationId: input.fact.invocationId,
        state: 'RECONCILING',
        prepareCommandId: input.fact.prepareCommandId,
        startCommandId: null,
        factDigest: input.factDigest,
        replayed: true,
      });
    }

    if (startCommands.rows.length > 0) {
      throw new CloudJournalError(
        'WORKER_FACT_CONFLICT',
        'fresh prepared fact 遇到已存在的 start command',
      );
    }
    if (
      current.state !== 'PERSISTED' ||
      current.conversation_state !== 'BUSY' ||
      !['ACKED', 'EXPIRED'].includes(command.state) ||
      command.attempt_count < 1
    ) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'admitted prepared fact 未留下 exact PERSISTED/Event/prepare ACK projection',
      );
    }

    // The prepared fact is durable even if authority expires while this
    // transaction is projecting it. Only the final start-command INSERT may
    // consume live authority, and every deadline is re-read from PostgreSQL
    // with clock_timestamp() in that same statement.
    const generatedStartCommand = await connection.query<{ command_id: string }>(
      `INSERT INTO broker_outbox (
         command_id, creator_id, target_worker_id, invocation_id, consumer_subject_id,
         conversation_id, deployment_id, assignment_lease_id, assignment_fence,
         predecessor_command_id, execution_capability_id, execution_capability_digest,
         command_type, dedupe_key, state, next_attempt_at, expires_at
       )
       SELECT gen_uuid_v7(), invocation.creator_id, invocation.assigned_worker_id,
              invocation.id, invocation.consumer_subject_id, invocation.conversation_id,
              conversation.deployment_id, invocation.assignment_lease_id,
              invocation.assignment_fence, prepare_command.command_id,
              invocation.execution_capability_id, invocation.execution_capability_digest,
              'invocation.start', 'invocation:' || invocation.id::text || ':start',
              'PENDING', clock_timestamp(), invocation.deadline_at
         FROM agent_invocations AS invocation
         JOIN agent_conversations AS conversation
           ON conversation.id = invocation.conversation_id
          AND conversation.creator_id = invocation.creator_id
          AND conversation.consumer_subject_id = invocation.consumer_subject_id
         JOIN worker_leases AS lease
           ON lease.id = invocation.assignment_lease_id
          AND lease.deployment_id = conversation.deployment_id
          AND lease.creator_id = invocation.creator_id
          AND lease.worker_id = invocation.assigned_worker_id
          AND lease.fence = invocation.assignment_fence
         JOIN broker_outbox AS prepare_command
           ON prepare_command.command_id = $11
          AND prepare_command.creator_id = invocation.creator_id
          AND prepare_command.target_worker_id = invocation.assigned_worker_id
          AND prepare_command.invocation_id = invocation.id
          AND prepare_command.consumer_subject_id = invocation.consumer_subject_id
          AND prepare_command.conversation_id = invocation.conversation_id
          AND prepare_command.deployment_id = conversation.deployment_id
          AND prepare_command.assignment_lease_id = invocation.assignment_lease_id
          AND prepare_command.assignment_fence = invocation.assignment_fence
          AND prepare_command.execution_capability_id = invocation.execution_capability_id
          AND prepare_command.execution_capability_digest =
                invocation.execution_capability_digest
        WHERE invocation.id = $1
          AND invocation.conversation_id = $2
          AND invocation.creator_id = $3
          AND invocation.consumer_subject_id = $4
          AND invocation.state = 'PERSISTED'
          AND invocation.assigned_worker_id = $5
          AND invocation.assignment_lease_id = $6
          AND invocation.assignment_fence = $7
          AND invocation.execution_capability_id = $8
          AND invocation.execution_capability_digest = $9
          AND conversation.deployment_id = $10
          AND conversation.state = 'BUSY'
          AND invocation.deadline_at > clock_timestamp()
          AND invocation.execution_capability_expires_at > clock_timestamp()
          AND invocation.execution_capability_revoked_at IS NULL
          AND lease.state = 'ACTIVE'
          AND lease.expires_at > clock_timestamp()
          AND prepare_command.command_type = 'invocation.prepare'
          AND prepare_command.state = 'ACKED'
          AND prepare_command.attempt_count > 0
          AND prepare_command.expires_at > clock_timestamp()
       RETURNING command_id::text AS command_id`,
      [
        input.fact.invocationId,
        conversationId,
        input.creatorId,
        consumerId,
        input.installationId,
        input.fact.leaseId,
        input.fact.fence,
        current.execution_capability_id,
        input.fact.executionCapabilityDigest,
        current.deployment_id,
        input.fact.prepareCommandId,
      ],
    );
    const startCommandId = generatedStartCommand.rows[0]?.command_id;
    if (startCommandId) {
      await inject(this.failureInjector, 'START_COMMAND');

      return committedPreparedOutcome({
        invocationId: input.fact.invocationId,
        state: 'PERSISTED',
        prepareCommandId: input.fact.prepareCommandId,
        startCommandId,
        factDigest: input.factDigest,
        replayed: false,
      });
    }

    const reconciliation = await connection.query<{ reconciliation_started_at: Date | string }>(
      `UPDATE agent_invocations
            SET state = 'RECONCILING', reconciliation_reason = 'START_DISPATCH_UNKNOWN',
                reconciliation_started_at = date_trunc('milliseconds', clock_timestamp())
          WHERE id = $1 AND conversation_id = $2 AND creator_id = $3
            AND consumer_subject_id = $4 AND state = 'PERSISTED'
            AND reconciliation_reason IS NULL AND reconciliation_started_at IS NULL
          RETURNING reconciliation_started_at`,
      [input.fact.invocationId, conversationId, input.creatorId, consumerId],
    );
    const reconciliationStartedAt = reconciliation.rows[0]?.reconciliation_started_at;
    if (!reconciliationStartedAt) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'late prepared fact 未原子进入 RECONCILING',
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
        input.fact.invocationId,
        input.creatorId,
        consumerId,
        lateReconciliationSourceEventId,
        JSON.stringify({ state: 'RECONCILING', reason: 'START_DISPATCH_UNKNOWN' }),
        isoDate(reconciliationStartedAt),
      ],
    );
    await inject(this.failureInjector, 'RECONCILING_EVENT');

    return committedPreparedOutcome({
      invocationId: input.fact.invocationId,
      state: 'RECONCILING',
      prepareCommandId: input.fact.prepareCommandId,
      startCommandId: null,
      factDigest: input.factDigest,
      replayed: false,
    });
  }

  public async commitStarted(
    rawInput: CommitStartedInput,
    signal: AbortSignal = AbortSignal.timeout(10_000),
  ): Promise<CommittedStarted> {
    const input = CommitStartedInputSchema.parse(rawInput);
    const outcome = await withCreatorTransaction(this.pools.broker, input, (connection) =>
      this.projectStarted(adaptStandaloneJournalTransaction(connection), input, signal),
    );
    if (isStartedSecurityBlocked(outcome)) {
      throw new CloudJournalError('JOURNAL_SECURITY_BLOCKED', 'JOURNAL_SECURITY_BLOCKED');
    }
    return outcome.committed;
  }

  /** Project a strict Gateway invocation.started event inside the caller's transaction. */
  public async projectStarted(
    rawConnection: InvocationProjectorTransaction,
    rawInput: CommitStartedInput,
    signal: AbortSignal,
  ): Promise<ProjectStartedOutcome> {
    const connection = bindInvocationProjectorSignal(rawConnection, signal);
    const input = CommitStartedInputSchema.parse(rawInput);
    assertCanonicalWorkerFact(input.fact, input.factDigest);
    const admission = await connection.query<StartedFactAdmissionRow>(
      `SELECT outcome, projected_state, started_at, entered_starting,
              reconciliation_root_appended, start_command_acked,
              alert_id::text, alert_replayed
         FROM creator_agent_project_started_fact_v1(
           $1, $2, $3, $4, $5, $6, $7, $8, $9,
           $10, $11, $12, $13, $14, $15, $16, $17, $18
         )`,
      [
        input.creatorId,
        input.installationId,
        input.fact.protocol,
        input.fact.schemaVersion,
        input.fact.type,
        input.fact.sourceEventId,
        input.fact.invocationId,
        input.fact.agentVersionDigest,
        input.fact.snapshotDigest,
        input.fact.executionCapabilityDigest,
        input.fact.leaseId,
        input.fact.fence,
        input.fact.startCommandId,
        input.fact.runtimeThreadId,
        input.fact.runtimeTurnId,
        input.fact.dispatchReceiptDigest,
        input.fact.sandboxAttestationDigest,
        input.factDigest,
      ],
    );
    const admissionRow = admission.rows[0];
    const admissionOutcome = StartedFactAdmissionOutcomeSchema.safeParse(admissionRow?.outcome);
    if (admission.rowCount !== 1 || !admissionRow || !admissionOutcome.success) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'started fact admission 未返回唯一稳定 outcome',
      );
    }
    if (admissionOutcome.data === 'SECURITY_BLOCKED') {
      if (
        admissionRow.projected_state !== null ||
        admissionRow.started_at !== null ||
        admissionRow.entered_starting !== null ||
        admissionRow.reconciliation_root_appended !== null ||
        admissionRow.start_command_acked !== null ||
        !UuidSchema.safeParse(admissionRow.alert_id).success ||
        typeof admissionRow.alert_replayed !== 'boolean'
      ) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'started fact security block 缺少 durable alert outcome',
        );
      }
      await inject(this.failureInjector, 'JOURNAL_INTEGRITY_ALERT');
      return PROJECT_STARTED_SECURITY_BLOCKED;
    }
    if (admissionRow.alert_id !== null || admissionRow.alert_replayed !== null) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'started fact non-security outcome 携带了 alert metadata',
      );
    }
    switch (admissionOutcome.data) {
      case 'TERMINAL':
        throw new CloudJournalError('TERMINAL_CONFLICT', 'Invocation 已有终态');
      case 'UNAVAILABLE':
      case 'AUTHORITY_REJECTED':
        throw new CloudJournalError(
          'EXECUTION_AUTHORITY_MISMATCH',
          'started fact 与 durable execution authority 不一致',
        );
      case 'INVARIANT_FAILED':
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'started fact durable invariant 失败',
        );
      case 'ADMITTED':
      case 'EXACT':
        break;
    }
    const projectedState = z
      .enum(['RUNNING', 'RECONCILING'])
      .safeParse(admissionRow.projected_state);
    if (!projectedState.success || admissionRow.started_at === null) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'started fact admission 缺少 exact state/time outcome',
      );
    }
    if (admissionOutcome.data === 'ADMITTED') {
      if (
        typeof admissionRow.entered_starting !== 'boolean' ||
        typeof admissionRow.reconciliation_root_appended !== 'boolean' ||
        typeof admissionRow.start_command_acked !== 'boolean' ||
        (projectedState.data === 'RUNNING' && admissionRow.reconciliation_root_appended)
      ) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'admitted started fact mutation flags 非 canonical',
        );
      }
      if (admissionRow.entered_starting) {
        await inject(this.failureInjector, 'INVOCATION_STARTING');
      }
      await inject(
        this.failureInjector,
        projectedState.data === 'RUNNING' ? 'INVOCATION_RUNNING' : 'INVOCATION_RECONCILING',
      );
      await inject(this.failureInjector, 'STARTED_EVENT');
      if (admissionRow.reconciliation_root_appended) {
        await inject(this.failureInjector, 'RECONCILING_EVENT');
      }
      if (admissionRow.start_command_acked) {
        await inject(this.failureInjector, 'START_COMMAND_ACK');
      }
      return committedStartedOutcome({
        invocationId: input.fact.invocationId,
        state: projectedState.data,
        startCommandId: input.fact.startCommandId,
        factDigest: input.factDigest,
        startedAt: isoDate(admissionRow.started_at),
        replayed: false,
      });
    }
    if (
      admissionRow.entered_starting !== false ||
      admissionRow.reconciliation_root_appended !== false ||
      admissionRow.start_command_acked !== false
    ) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'exact started fact outcome 声称发生 mutation',
      );
    }
    const exactProjectedState = projectedState.data;
    const exactStartedAt = admissionRow.started_at;

    const tenant = await connection.query<{
      consumer_subject_id: string;
      conversation_id: string;
    }>(
      `SELECT consumer_subject_id::text, conversation_id::text
         FROM agent_invocations
        WHERE id = $1 AND creator_id = $2 AND assigned_worker_id = $3`,
      [input.fact.invocationId, input.creatorId, input.installationId],
    );
    const parsedConsumerId = UuidSchema.safeParse(tenant.rows[0]?.consumer_subject_id);
    const parsedConversationId = UuidSchema.safeParse(tenant.rows[0]?.conversation_id);
    if (tenant.rows.length !== 1 || !parsedConsumerId.success || !parsedConversationId.success) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'started fact admission 未保留 exact tenant projection',
      );
    }
    const consumerId = parsedConsumerId.data;
    const conversationId = parsedConversationId.data;

    const authority = await connection.query<InvocationLifecycleAuthorityRow>(
      `SELECT invocation.state, invocation.request_digest, invocation.deadline_at,
                invocation.deadline_at > now() AS deadline_valid,
                invocation.agent_version_id,
                version.version_digest AS agent_version_digest,
                snapshot.snapshot_digest,
                invocation.assigned_worker_id, invocation.assignment_lease_id,
                invocation.assignment_fence, invocation.execution_capability_id,
                invocation.execution_capability_digest,
                invocation.execution_capability_expires_at,
                invocation.execution_capability_revoked_at,
                (
                  invocation.execution_capability_expires_at > now()
                  AND invocation.execution_capability_revoked_at IS NULL
                ) AS execution_capability_valid,
                invocation.runtime_thread_id, invocation.runtime_turn_id,
                invocation.reconciliation_reason, invocation.reconciliation_started_at,
                conversation.deployment_id, conversation.state AS conversation_state
           FROM agent_invocations AS invocation
           JOIN agent_conversations AS conversation
             ON conversation.id = invocation.conversation_id
            AND conversation.creator_id = invocation.creator_id
            AND conversation.consumer_subject_id = invocation.consumer_subject_id
           JOIN agent_versions AS version
             ON version.id = invocation.agent_version_id
            AND version.creator_id = invocation.creator_id
           JOIN context_snapshots AS snapshot
             ON snapshot.id = version.snapshot_id
            AND snapshot.creator_id = version.creator_id
          WHERE invocation.id = $1
            AND invocation.conversation_id = $2
            AND invocation.creator_id = $3
            AND invocation.consumer_subject_id = $4
          FOR UPDATE OF invocation, conversation`,
      [input.fact.invocationId, conversationId, input.creatorId, consumerId],
    );
    const current = authority.rows[0];
    if (!current) {
      throw new CloudJournalError(
        'EXECUTION_AUTHORITY_MISMATCH',
        'started Invocation 不存在或租户不匹配',
      );
    }

    const lifecycleEvents = await connection.query<InvocationLifecycleEventRow>(
      `SELECT invocation_id, source_event_id, event_type, source_fact_digest,
                broker_command_id, payload, occurred_at
           FROM agent_invocation_events
          WHERE source = 'WORKER'
            AND (
              source_event_id = $1
              OR (invocation_id = $2 AND event_type = 'invocation.started')
            )`,
      [input.fact.sourceEventId, input.fact.invocationId],
    );
    const exactRunningEvents = lifecycleEvents.rows.filter((event) =>
      exactLifecycleEventMatches({
        event,
        invocationId: input.fact.invocationId,
        sourceEventId: input.fact.sourceEventId,
        eventType: 'invocation.started',
        factDigest: input.factDigest,
        commandId: input.fact.startCommandId,
        state: 'RUNNING',
      }),
    );
    const exactReconcilingEvents = lifecycleEvents.rows.filter((event) =>
      exactLifecycleEventMatches({
        event,
        invocationId: input.fact.invocationId,
        sourceEventId: input.fact.sourceEventId,
        eventType: 'invocation.started',
        factDigest: input.factDigest,
        commandId: input.fact.startCommandId,
        state: 'RECONCILING',
      }),
    );
    const exactEvents = [...exactRunningEvents, ...exactReconcilingEvents];
    if (lifecycleEvents.rows.length > 0 && exactEvents.length !== lifecycleEvents.rows.length) {
      throw new CloudJournalError(
        'WORKER_FACT_CONFLICT',
        'started sourceEventId 或 Invocation lifecycle fact 与 durable digest 冲突',
      );
    }

    const reconciliationRoots = await connection.query<InvocationLifecycleEventRow>(
      `SELECT invocation_id, source_event_id, event_type, source_fact_digest,
              broker_command_id, payload, occurred_at
         FROM agent_invocation_events
        WHERE invocation_id = $1 AND source = 'RECONCILER'
          AND event_type = 'invocation.reconciling'`,
      [input.fact.invocationId],
    );
    const currentReconciliationReason = InvocationUncertaintyReasonSchema.safeParse(
      current.reconciliation_reason,
    );
    const hasCurrentReconciliationBinding = current.reconciliation_started_at !== null;
    if (
      hasCurrentReconciliationBinding
        ? !currentReconciliationReason.success ||
          reconciliationRoots.rows.length !== 1 ||
          !exactReconciliationEventMatches({
            event: reconciliationRoots.rows[0]!,
            invocationId: input.fact.invocationId,
            eventType: 'invocation.reconciling',
            reason: currentReconciliationReason.data,
            occurredAt: current.reconciliation_started_at!,
          })
        : current.reconciliation_reason !== null || reconciliationRoots.rows.length !== 0
    ) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'started projection 的 reconciliation binding 与 durable root Event 不一致',
      );
    }

    if (
      current.agent_version_digest !== input.fact.agentVersionDigest ||
      current.snapshot_digest !== input.fact.snapshotDigest ||
      current.assigned_worker_id !== input.installationId ||
      current.assignment_lease_id !== input.fact.leaseId ||
      !bigintEquals(current.assignment_fence, input.fact.fence) ||
      current.execution_capability_id === null ||
      current.execution_capability_digest !== input.fact.executionCapabilityDigest ||
      (current.runtime_thread_id !== null &&
        current.runtime_thread_id !== input.fact.runtimeThreadId) ||
      (current.runtime_turn_id !== null && current.runtime_turn_id !== input.fact.runtimeTurnId)
    ) {
      throw new CloudJournalError(
        'EXECUTION_AUTHORITY_MISMATCH',
        'started fact 与 durable Version/Snapshot/Worker/Lease/Fence/Capability 不一致',
      );
    }

    const lease = await connection.query<InvocationLeaseAuthorityRow>(
      `SELECT state, expires_at, expires_at > now() AS lease_valid,
                deployment_id, creator_id, worker_id, fence
           FROM worker_leases
          WHERE id = $1 AND deployment_id = $2 AND creator_id = $3
            AND worker_id = $4 AND fence = $5
          FOR UPDATE`,
      [
        input.fact.leaseId,
        current.deployment_id,
        input.creatorId,
        input.installationId,
        input.fact.fence,
      ],
    );
    const currentLease = lease.rows[0];
    if (!currentLease) {
      throw new CloudJournalError(
        'EXECUTION_AUTHORITY_MISMATCH',
        'started fact 缺少 exact Deployment Lease/Fence',
      );
    }

    const startCommand = await connection.query<InvocationCommandAuthorityRow>(
      `SELECT command_id, creator_id, target_worker_id, invocation_id,
                consumer_subject_id, conversation_id, deployment_id,
                assignment_lease_id, assignment_fence, predecessor_command_id,
                execution_capability_id, execution_capability_digest,
                command_type, state, attempt_count, expires_at,
                expires_at > now() AS command_valid
           FROM broker_outbox
          WHERE command_id = $1 AND creator_id = $2
          FOR UPDATE`,
      [input.fact.startCommandId, input.creatorId],
    );
    const command = startCommand.rows[0];
    if (
      !command ||
      command.command_type !== 'invocation.start' ||
      command.target_worker_id !== input.installationId ||
      command.invocation_id !== input.fact.invocationId ||
      command.consumer_subject_id !== consumerId ||
      command.conversation_id !== conversationId ||
      command.deployment_id !== current.deployment_id ||
      command.assignment_lease_id !== input.fact.leaseId ||
      !bigintEquals(command.assignment_fence, input.fact.fence) ||
      command.predecessor_command_id === null ||
      command.execution_capability_id !== current.execution_capability_id ||
      command.execution_capability_digest !== input.fact.executionCapabilityDigest
    ) {
      throw new CloudJournalError(
        'EXECUTION_AUTHORITY_MISMATCH',
        'started fact 没有绑定 exact invocation.start Outbox command',
      );
    }

    const persistedEvent = await connection.query<InvocationLifecycleEventRow>(
      `SELECT invocation_id, source_event_id, event_type, source_fact_digest,
                broker_command_id, payload, occurred_at
           FROM agent_invocation_events
          WHERE invocation_id = $1 AND source = 'WORKER'
            AND event_type = 'invocation.persisted'`,
      [input.fact.invocationId],
    );
    const durablePrepared = persistedEvent.rows[0];
    if (
      !durablePrepared ||
      durablePrepared.broker_command_id === null ||
      durablePrepared.broker_command_id !== command.predecessor_command_id ||
      durablePrepared.source_fact_digest === null
    ) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'start command 没有 exact durable prepared predecessor',
      );
    }

    if (exactEvents.length !== 1) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'exact started fact admission 未留下唯一 durable Event',
      );
    }
    {
      const replayedState = exactReconcilingEvents.length === 1 ? 'RECONCILING' : 'RUNNING';
      const hasExactReconciliationRoot =
        replayedState !== 'RECONCILING' ||
        (currentReconciliationReason.success &&
          current.reconciliation_started_at !== null &&
          reconciliationRoots.rows.length === 1 &&
          exactReconciliationEventMatches({
            event: reconciliationRoots.rows[0]!,
            invocationId: input.fact.invocationId,
            eventType: 'invocation.reconciling',
            reason: currentReconciliationReason.data,
            occurredAt: current.reconciliation_started_at,
          }));
      if (
        (replayedState === 'RUNNING'
          ? ![
              'RUNNING',
              'CANCEL_REQUESTED',
              'RECONCILING',
              'SUCCEEDED',
              'FAILED',
              'CANCELLED',
              'UNCERTAIN',
            ].includes(current.state)
          : !['RECONCILING', 'FAILED', 'CANCELLED', 'UNCERTAIN'].includes(current.state)) ||
        replayedState !== exactProjectedState ||
        isoDate(exactEvents[0]!.occurred_at) !== isoDate(exactStartedAt) ||
        !['ACKED', 'EXPIRED'].includes(command.state) ||
        current.runtime_thread_id !== input.fact.runtimeThreadId ||
        current.runtime_turn_id !== input.fact.runtimeTurnId ||
        !hasExactReconciliationRoot
      ) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          '已提交 started fact 与 durable projection/command 不一致',
        );
      }
      return committedStartedOutcome({
        invocationId: input.fact.invocationId,
        state: replayedState,
        startCommandId: input.fact.startCommandId,
        factDigest: input.factDigest,
        startedAt: isoDate(exactEvents[0]!.occurred_at),
        replayed: true,
      });
    }
  }

  public async commitSuccess(
    rawInput: CommitSuccessInput,
    sealAssistantMessage?: AssistantMessageSealer,
    signal: AbortSignal = AbortSignal.timeout(10_000),
  ): Promise<CommittedSuccess> {
    const input = CommitSuccessInputSchema.parse(rawInput);
    const outcome = await withCreatorTransaction(this.pools.broker, input, (connection) =>
      this.projectSuccess(
        adaptStandaloneJournalTransaction(connection),
        input,
        sealAssistantMessage,
        signal,
      ),
    );
    if (isSuccessSecurityBlocked(outcome)) {
      throw new CloudJournalError('JOURNAL_SECURITY_BLOCKED', 'JOURNAL_SECURITY_BLOCKED');
    }
    return outcome.committed;
  }

  /** Project a strict Gateway invocation.succeeded event inside the caller's transaction. */
  public async projectSuccess(
    rawConnection: InvocationProjectorTransaction,
    rawInput: CommitSuccessInput,
    sealAssistantMessage: AssistantMessageSealer | undefined,
    signal: AbortSignal,
  ): Promise<ProjectSuccessOutcome> {
    const connection = bindInvocationProjectorSignal(rawConnection, signal);
    const input = CommitSuccessInputSchema.parse(rawInput);
    assertCanonicalWorkerFact(input.fact, input.factDigest);
    if (
      input.fact.sourceEventId !== input.fact.invocationId ||
      input.resultCiphertext.aad.envelopeType !== 'invocation.succeeded' ||
      input.resultCiphertext.aad.invocationId !== input.fact.invocationId ||
      input.resultCiphertext.aad.role !== 'ASSISTANT'
    ) {
      throw new CloudJournalError(
        'WORKER_FACT_CONFLICT',
        'success event 与 canonical Worker terminal fact/transport AAD 不一致',
      );
    }
    const preflight = await connection.query<SuccessFactPreflightRow>(
      `SELECT outcome, seal_token::text, assistant_message_id::text,
              aad_schema_version, aad_owner_id::text, aad_conversation_id::text,
              aad_role, result_digest, consumer_event_cursor::text,
              alert_id::text, alert_replayed
         FROM creator_agent_preflight_success_fact_v1(
           $1, $2, $3, $4, $5, $6, $7, $8, $9,
           $10, $11, $12, $13, $14, $15, $16, $17, $18
         )`,
      [
        input.creatorId,
        input.installationId,
        input.fact.protocol,
        input.fact.schemaVersion,
        input.fact.type,
        input.fact.sourceEventId,
        input.fact.invocationId,
        input.fact.agentVersionDigest,
        input.fact.snapshotDigest,
        input.fact.executionCapabilityDigest,
        input.fact.leaseId,
        input.fact.fence,
        input.fact.runtimeThreadId,
        input.fact.runtimeTurnId,
        input.fact.startedFactDigest,
        input.fact.resultDigest,
        input.fact.localResultCipherDigest,
        input.factDigest,
      ],
    );
    const preflightRow = preflight.rows[0];
    const preflightOutcome = SuccessFactPreflightOutcomeSchema.safeParse(preflightRow?.outcome);
    if (preflight.rowCount !== 1 || !preflightRow || !preflightOutcome.success) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'success fact preflight 未返回唯一稳定 outcome',
      );
    }
    if (preflightOutcome.data === 'SECURITY_BLOCKED') {
      if (
        preflightRow.seal_token !== null ||
        preflightRow.assistant_message_id !== null ||
        preflightRow.aad_schema_version !== null ||
        preflightRow.aad_owner_id !== null ||
        preflightRow.aad_conversation_id !== null ||
        preflightRow.aad_role !== null ||
        preflightRow.result_digest !== null ||
        preflightRow.consumer_event_cursor !== null ||
        !UuidSchema.safeParse(preflightRow.alert_id).success ||
        typeof preflightRow.alert_replayed !== 'boolean'
      ) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'success fact security block 缺少 durable alert outcome',
        );
      }
      await inject(this.failureInjector, 'JOURNAL_INTEGRITY_ALERT');
      return PROJECT_SUCCESS_SECURITY_BLOCKED;
    }
    if (preflightRow.alert_id !== null || preflightRow.alert_replayed !== null) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'success fact non-security preflight 携带了 alert metadata',
      );
    }
    if (
      ['TERMINAL', 'UNAVAILABLE', 'AUTHORITY_REJECTED', 'INVARIANT_FAILED'].includes(
        preflightOutcome.data,
      ) &&
      !successPreflightBusinessFieldsAreNull(preflightRow)
    ) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'success fact rejection preflight 携带了 business metadata',
      );
    }
    switch (preflightOutcome.data) {
      case 'TERMINAL':
        throw new CloudJournalError('TERMINAL_CONFLICT', 'Invocation 已有其他终态');
      case 'UNAVAILABLE':
      case 'AUTHORITY_REJECTED':
        throw new CloudJournalError(
          'EXECUTION_AUTHORITY_MISMATCH',
          'success fact 与 durable execution authority 不一致',
        );
      case 'INVARIANT_FAILED':
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'success fact durable invariant 失败',
        );
      case 'EXACT':
      case 'SEAL_REQUIRED':
        break;
    }

    const parsedAssistantMessageId = UuidSchema.safeParse(preflightRow.assistant_message_id);
    const parsedResultDigest = HmacSha256DigestSchema.safeParse(preflightRow.result_digest);
    const parsedCursor =
      preflightRow.consumer_event_cursor === null
        ? null
        : Uint63StringSchema.safeParse(String(preflightRow.consumer_event_cursor));
    if (
      !parsedAssistantMessageId.success ||
      !parsedResultDigest.success ||
      parsedResultDigest.data !== input.fact.resultDigest ||
      (parsedCursor !== null && !parsedCursor.success)
    ) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'success fact preflight 缺少 exact message/result outcome',
      );
    }
    const assistantMessageId = parsedAssistantMessageId.data;
    const consumerEventCursor = parsedCursor === null ? null : parsedCursor.data;

    if (preflightOutcome.data === 'EXACT') {
      if (
        preflightRow.seal_token !== null ||
        preflightRow.aad_schema_version !== null ||
        preflightRow.aad_owner_id !== null ||
        preflightRow.aad_conversation_id !== null ||
        preflightRow.aad_role !== null
      ) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'exact success fact 不得携带 seal intent/AAD',
        );
      }
      const reverse = await connection.query<SuccessExactProjectionRow>(
        `SELECT invocation.state, invocation.conversation_id::text,
                invocation.result_message_id::text,
                invocation.result_digest, conversation.state AS conversation_state,
                message.role AS message_role,
                message.content_aad_version AS message_aad_version,
                terminal.source_event_id AS terminal_source_event_id,
                terminal.source_fact_digest AS terminal_fact_digest
           FROM agent_invocations AS invocation
           JOIN agent_conversations AS conversation
             ON conversation.id = invocation.conversation_id
            AND conversation.creator_id = invocation.creator_id
            AND conversation.consumer_subject_id = invocation.consumer_subject_id
           JOIN agent_messages AS message
             ON message.id = invocation.result_message_id
            AND message.invocation_id = invocation.id
            AND message.conversation_id = invocation.conversation_id
            AND message.creator_id = invocation.creator_id
            AND message.consumer_subject_id = invocation.consumer_subject_id
           JOIN agent_invocation_events AS terminal
             ON terminal.invocation_id = invocation.id
            AND terminal.creator_id = invocation.creator_id
            AND terminal.consumer_subject_id = invocation.consumer_subject_id
            AND terminal.source = 'WORKER'
            AND terminal.event_type = 'invocation.succeeded'
          WHERE invocation.id = $1 AND invocation.creator_id = $2`,
        [input.fact.invocationId, input.creatorId],
      );
      const durable = reverse.rows[0];
      if (
        reverse.rowCount !== 1 ||
        !durable ||
        durable.state !== 'SUCCEEDED' ||
        durable.conversation_id !== input.resultCiphertext.aad.conversationId ||
        durable.result_message_id !== assistantMessageId ||
        durable.result_digest !== input.fact.resultDigest ||
        durable.conversation_state !== 'IDLE' ||
        durable.message_role !== 'ASSISTANT' ||
        durable.message_aad_version !== 1 ||
        durable.terminal_source_event_id !== input.fact.sourceEventId ||
        durable.terminal_fact_digest !== input.factDigest
      ) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'exact success fact 未保留 durable terminal projection',
        );
      }
      return committedSuccessOutcome({
        invocationId: input.fact.invocationId,
        assistantMessageId,
        resultDigest: input.fact.resultDigest,
        consumerEventCursor,
        replayed: true,
      });
    }

    const parsedAadOwnerId = UuidSchema.safeParse(preflightRow.aad_owner_id);
    const parsedAadConversationId = UuidSchema.safeParse(preflightRow.aad_conversation_id);
    const parsedSealToken = UuidSchema.safeParse(preflightRow.seal_token);
    if (
      !parsedSealToken.success ||
      parsedSealToken.data === assistantMessageId ||
      consumerEventCursor !== null ||
      Number(preflightRow.aad_schema_version) !== 1 ||
      !parsedAadOwnerId.success ||
      parsedAadOwnerId.data !== input.creatorId ||
      !parsedAadConversationId.success ||
      preflightRow.aad_role !== 'ASSISTANT'
    ) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'fresh success fact preflight 缺少 exact seal intent/AAD',
      );
    }
    if (input.resultCiphertext.aad.conversationId !== parsedAadConversationId.data) {
      throw new CloudJournalError(
        'EXECUTION_AUTHORITY_MISMATCH',
        'Invocation 与 Worker terminal transport AAD conversationId 不一致',
      );
    }
    await inject(this.failureInjector, 'SUCCESS_SEAL_PREFLIGHT');
    if (!sealAssistantMessage) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'fresh terminal commit 缺少 transport decrypt/KMS durable message sealer',
      );
    }
    const aad = {
      schemaVersion: 1 as const,
      ownerId: parsedAadOwnerId.data,
      conversationId: parsedAadConversationId.data,
      messageId: assistantMessageId,
      role: 'ASSISTANT' as const,
    };
    const sealedAssistantMessage = await settleAssistantMessageSealer(
      sealAssistantMessage,
      { resultCiphertext: input.resultCiphertext, aad },
      signal,
    );
    signal.throwIfAborted();
    const encryptedAssistantMessage = EncryptedMessageSchema.parse(
      sealedAssistantMessage.encryptedMessage,
    );
    const verifiedResultDigest = HmacSha256DigestSchema.parse(
      sealedAssistantMessage.verifiedResultDigest,
    );

    const finalized = await connection.query<SuccessFactFinalizeRow>(
      `SELECT outcome, assistant_message_id::text, result_digest, terminal_at,
              consumer_event_cursor::text, assistant_message_appended,
              invocation_succeeded, succeeded_event_appended, consumer_event_appended,
              consumer_stream_advanced, terminal_receipt_appended, conversation_idled,
              preflight_consumed, alert_id::text, alert_replayed
         FROM creator_agent_finalize_success_fact_v1(
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10, $11, $12, $13, $14
         )`,
      [
        parsedSealToken.data,
        input.creatorId,
        input.fact.invocationId,
        input.factDigest,
        assistantMessageId,
        verifiedResultDigest,
        ...encryptedParameters(encryptedAssistantMessage),
      ],
    );
    const finalizedRow = finalized.rows[0];
    const finalizedOutcome = SuccessFactFinalizeOutcomeSchema.safeParse(finalizedRow?.outcome);
    if (finalized.rowCount !== 1 || !finalizedRow || !finalizedOutcome.success) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'success fact finalize 未返回唯一稳定 outcome',
      );
    }
    if (finalizedOutcome.data === 'SECURITY_BLOCKED') {
      if (
        finalizedRow.assistant_message_id !== null ||
        finalizedRow.result_digest !== null ||
        finalizedRow.terminal_at !== null ||
        finalizedRow.consumer_event_cursor !== null ||
        finalizedRow.assistant_message_appended !== null ||
        finalizedRow.invocation_succeeded !== null ||
        finalizedRow.succeeded_event_appended !== null ||
        finalizedRow.consumer_event_appended !== null ||
        finalizedRow.consumer_stream_advanced !== null ||
        finalizedRow.terminal_receipt_appended !== null ||
        finalizedRow.conversation_idled !== null ||
        finalizedRow.preflight_consumed !== null ||
        !UuidSchema.safeParse(finalizedRow.alert_id).success ||
        typeof finalizedRow.alert_replayed !== 'boolean'
      ) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'success finalize security block 缺少 durable alert outcome',
        );
      }
      await inject(this.failureInjector, 'JOURNAL_INTEGRITY_ALERT');
      return PROJECT_SUCCESS_SECURITY_BLOCKED;
    }
    if (finalizedRow.alert_id !== null || finalizedRow.alert_replayed !== null) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'success finalize non-security outcome 携带了 alert metadata',
      );
    }
    if (
      finalizedOutcome.data !== 'ADMITTED' &&
      !successFinalizeBusinessFieldsAreNull(finalizedRow)
    ) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'success finalize rejection 携带了 business metadata',
      );
    }
    switch (finalizedOutcome.data) {
      case 'AUTHORITY_REJECTED':
        throw new CloudJournalError(
          'EXECUTION_AUTHORITY_MISMATCH',
          'success finalize 越过 durable execution authority',
        );
      case 'INVARIANT_FAILED':
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'success finalize durable invariant 失败',
        );
      case 'ADMITTED':
        break;
    }
    const finalizedMessageId = UuidSchema.safeParse(finalizedRow.assistant_message_id);
    const finalizedResultDigest = HmacSha256DigestSchema.safeParse(finalizedRow.result_digest);
    const finalizedCursor =
      finalizedRow.consumer_event_cursor === null
        ? null
        : Uint63StringSchema.safeParse(String(finalizedRow.consumer_event_cursor));
    if (
      !finalizedMessageId.success ||
      finalizedMessageId.data !== assistantMessageId ||
      !finalizedResultDigest.success ||
      finalizedResultDigest.data !== input.fact.resultDigest ||
      finalizedRow.terminal_at === null ||
      finalizedCursor === null ||
      !finalizedCursor.success ||
      finalizedRow.assistant_message_appended !== true ||
      finalizedRow.invocation_succeeded !== true ||
      finalizedRow.succeeded_event_appended !== true ||
      finalizedRow.consumer_event_appended !== true ||
      finalizedRow.consumer_stream_advanced !== true ||
      finalizedRow.terminal_receipt_appended !== true ||
      finalizedRow.conversation_idled !== true ||
      finalizedRow.preflight_consumed !== true
    ) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'admitted success finalize mutation flags 非 canonical',
      );
    }
    isoDate(finalizedRow.terminal_at);
    await inject(this.failureInjector, 'ASSISTANT_MESSAGE');
    await inject(this.failureInjector, 'INVOCATION_SUCCEEDED');
    await inject(this.failureInjector, 'SUCCEEDED_EVENT');
    await inject(this.failureInjector, 'CONSUMER_EVENT_OUTBOX');
    await inject(this.failureInjector, 'CONSUMER_EVENT_STREAM');
    await inject(this.failureInjector, 'SUCCESS_TERMINAL_RECEIPT');
    await inject(this.failureInjector, 'CONVERSATION_IDLE');
    await inject(this.failureInjector, 'SUCCESS_PREFLIGHT_CONSUMED');
    return committedSuccessOutcome({
      invocationId: input.fact.invocationId,
      assistantMessageId,
      resultDigest: input.fact.resultDigest,
      consumerEventCursor: finalizedCursor.data,
      replayed: false,
    });
  }

  public async commitFailed(
    rawInput: CommitFailedInput,
    signal: AbortSignal = AbortSignal.timeout(10_000),
  ): Promise<CommittedFailed> {
    const input = CommitFailedInputSchema.parse(rawInput);
    const outcome = await withCreatorTransaction(this.pools.broker, input, (connection) =>
      this.projectFailed(adaptStandaloneJournalTransaction(connection), input, signal),
    );
    if (isFailedSecurityBlocked(outcome)) {
      throw new CloudJournalError('JOURNAL_SECURITY_BLOCKED', 'JOURNAL_SECURITY_BLOCKED');
    }
    return outcome.committed;
  }

  /** Project a confirmed Worker failure without creating an Assistant Message. */
  public async projectFailed(
    rawConnection: InvocationProjectorTransaction,
    rawInput: CommitFailedInput,
    signal: AbortSignal,
  ): Promise<ProjectFailedOutcome> {
    const input = CommitFailedInputSchema.parse(rawInput);
    return this.#projectConfirmedFailure(rawConnection, input, signal);
  }

  async #projectConfirmedFailure(
    rawConnection: InvocationProjectorTransaction,
    input: CommitFailedInput,
    signal: AbortSignal,
  ): Promise<ProjectFailedOutcome> {
    const connection = bindInvocationProjectorSignal(rawConnection, signal);
    assertCanonicalWorkerFact(input.fact, input.factDigest);
    if (input.fact.sourceEventId !== input.fact.invocationId) {
      throw new CloudJournalError(
        'WORKER_FACT_CONFLICT',
        'failed event 与 canonical Worker fact identity 不一致',
      );
    }
    const terminalState = 'FAILED' as const;
    const eventType = 'invocation.failed' as const;
    const confirmedErrorCode = ConfirmedWorkerFailureCodeSchema.safeParse(input.fact.errorCode);
    if (!confirmedErrorCode.success) {
      throw new CloudJournalError(
        'WORKER_FACT_CONFLICT',
        'failed fact errorCode 不属于 confirmed stable failure registry',
      );
    }
    const errorCode = confirmedErrorCode.data;
    const terminalEventPayload = FailedInvocationEventPayloadSchema.parse({
      state: terminalState,
      errorCode,
    });
    const admission = await connection.query<FailedFactAdmissionRow>(
      `SELECT outcome, error_code, terminal_at, consumer_event_cursor::text,
              invocation_failed, failed_event_appended, consumer_event_appended,
              consumer_stream_advanced, terminal_receipt_appended, conversation_idled,
              alert_id::text, alert_replayed
         FROM creator_agent_project_failed_fact_v2(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
         )`,
      [
        input.creatorId,
        input.installationId,
        input.fact.protocol,
        input.fact.schemaVersion,
        input.fact.type,
        input.fact.sourceEventId,
        input.fact.invocationId,
        input.fact.agentVersionDigest,
        input.fact.snapshotDigest,
        input.fact.executionCapabilityDigest,
        input.fact.leaseId,
        input.fact.fence,
        input.fact.errorCode,
        input.factDigest,
      ],
    );
    const admissionRow = admission.rows[0];
    const admissionOutcome = FailedFactAdmissionOutcomeSchema.safeParse(admissionRow?.outcome);
    if (admission.rowCount !== 1 || !admissionRow || !admissionOutcome.success) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'failed fact admission 未返回唯一稳定 outcome',
      );
    }
    if (admissionOutcome.data === 'SECURITY_BLOCKED') {
      if (
        admissionRow.error_code !== null ||
        admissionRow.terminal_at !== null ||
        admissionRow.consumer_event_cursor !== null ||
        admissionRow.invocation_failed !== null ||
        admissionRow.failed_event_appended !== null ||
        admissionRow.consumer_event_appended !== null ||
        admissionRow.consumer_stream_advanced !== null ||
        admissionRow.terminal_receipt_appended !== null ||
        admissionRow.conversation_idled !== null ||
        !UuidSchema.safeParse(admissionRow.alert_id).success ||
        typeof admissionRow.alert_replayed !== 'boolean'
      ) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'failed fact security block 缺少 durable alert outcome',
        );
      }
      await inject(this.failureInjector, 'JOURNAL_INTEGRITY_ALERT');
      return PROJECT_FAILED_SECURITY_BLOCKED;
    }
    if (admissionRow.alert_id !== null || admissionRow.alert_replayed !== null) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'failed fact non-security outcome 携带了 alert metadata',
      );
    }
    switch (admissionOutcome.data) {
      case 'TERMINAL':
        throw new CloudJournalError('TERMINAL_CONFLICT', 'Invocation 已有其他终态');
      case 'UNAVAILABLE':
      case 'AUTHORITY_REJECTED':
        throw new CloudJournalError(
          'EXECUTION_AUTHORITY_MISMATCH',
          'failed fact 与 durable execution authority 不一致',
        );
      case 'INVARIANT_FAILED':
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'failed fact durable invariant 失败',
        );
      case 'ADMITTED':
      case 'EXACT':
        break;
    }
    const admittedErrorCode = ConfirmedWorkerFailureCodeSchema.safeParse(admissionRow.error_code);
    if (
      !admittedErrorCode.success ||
      admittedErrorCode.data !== errorCode ||
      admissionRow.terminal_at === null
    ) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'failed fact admission 缺少 exact error/time outcome',
      );
    }
    const parsedCursor =
      admissionRow.consumer_event_cursor === null
        ? null
        : Uint63StringSchema.safeParse(String(admissionRow.consumer_event_cursor));
    if (parsedCursor !== null && !parsedCursor.success) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'failed fact admission 返回非法 Consumer cursor',
      );
    }
    const consumerEventCursor = parsedCursor === null ? null : parsedCursor.data;
    if (admissionOutcome.data === 'ADMITTED') {
      if (
        consumerEventCursor === null ||
        admissionRow.invocation_failed !== true ||
        admissionRow.failed_event_appended !== true ||
        admissionRow.consumer_event_appended !== true ||
        admissionRow.consumer_stream_advanced !== true ||
        admissionRow.terminal_receipt_appended !== true ||
        admissionRow.conversation_idled !== true
      ) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'admitted failed fact mutation flags 非 canonical',
        );
      }
      await inject(this.failureInjector, 'INVOCATION_FAILED');
      await inject(this.failureInjector, 'FAILED_EVENT');
      await inject(this.failureInjector, 'CONSUMER_EVENT_OUTBOX');
      await inject(this.failureInjector, 'CONSUMER_EVENT_STREAM');
      await inject(this.failureInjector, 'FAILED_TERMINAL_RECEIPT');
      await inject(this.failureInjector, 'CONVERSATION_IDLE');
      return committedFailedOutcome({
        invocationId: input.fact.invocationId,
        state: terminalState,
        errorCode,
        consumerEventCursor,
        replayed: false,
      });
    }
    if (
      admissionRow.invocation_failed !== false ||
      admissionRow.failed_event_appended !== false ||
      admissionRow.consumer_event_appended !== false ||
      admissionRow.consumer_stream_advanced !== false ||
      admissionRow.terminal_receipt_appended !== false ||
      admissionRow.conversation_idled !== false
    ) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'exact failed fact outcome 声称发生 mutation',
      );
    }

    const tenant = await connection.query<{
      consumer_subject_id: string;
      conversation_id: string;
    }>(
      `SELECT consumer_subject_id::text, conversation_id::text
         FROM agent_invocations
        WHERE id = $1 AND creator_id = $2 AND assigned_worker_id = $3`,
      [input.fact.invocationId, input.creatorId, input.installationId],
    );
    const parsedConsumerId = UuidSchema.safeParse(tenant.rows[0]?.consumer_subject_id);
    const parsedConversationId = UuidSchema.safeParse(tenant.rows[0]?.conversation_id);
    if (tenant.rows.length !== 1 || !parsedConsumerId.success || !parsedConversationId.success) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'failed fact admission 未保留 exact tenant projection',
      );
    }
    const consumerId = parsedConsumerId.data;
    const conversationId = parsedConversationId.data;
    const authority = await connection.query<FailedAuthorityRow>(
      `SELECT invocation.state, invocation.consumer_subject_id,
              invocation.result_message_id, invocation.result_digest, invocation.error_code,
              version.version_digest AS agent_version_digest, snapshot.snapshot_digest,
              invocation.assigned_worker_id, invocation.assignment_lease_id,
              invocation.assignment_fence, invocation.execution_capability_id,
              invocation.execution_capability_digest,
              (
                invocation.execution_capability_expires_at > now()
                AND invocation.execution_capability_revoked_at IS NULL
              ) AS execution_capability_valid,
              invocation.execution_capability_revoked_at,
              conversation.state AS conversation_state,
              lease.state AS lease_state, (lease.expires_at > now()) AS lease_valid,
              EXISTS (
                SELECT 1
                  FROM agent_invocation_events AS started_event
                  JOIN broker_outbox AS started_command
                    ON started_command.command_id = started_event.broker_command_id
                   AND started_command.creator_id = started_event.creator_id
                   AND started_command.invocation_id = started_event.invocation_id
                   AND started_command.consumer_subject_id = started_event.consumer_subject_id
                 WHERE started_event.invocation_id = invocation.id
                   AND started_event.source = 'WORKER'
                   AND started_event.event_type = 'invocation.started'
                   AND started_event.source_fact_digest IS NOT NULL
                   AND started_command.command_type = 'invocation.start'
                   AND started_command.state IN ('ACKED', 'EXPIRED')
                   AND started_command.target_worker_id = invocation.assigned_worker_id
                   AND started_command.assignment_lease_id = invocation.assignment_lease_id
                   AND started_command.assignment_fence = invocation.assignment_fence
                   AND started_command.execution_capability_id = invocation.execution_capability_id
                   AND started_command.execution_capability_digest =
                         invocation.execution_capability_digest
              ) AS has_durable_started_evidence,
              consumer_event.cursor::text AS consumer_event_cursor,
              consumer_event.source_event_id AS consumer_event_source_event_id,
              consumer_event.event_type AS consumer_event_type,
              consumer_event.payload AS consumer_event_payload,
              consumer_event.payload_digest AS consumer_event_payload_digest,
              consumer_event.dedupe_key AS consumer_event_dedupe_key,
              terminal_event.source_event_id AS terminal_source_event_id,
              terminal_event.source_fact_digest AS terminal_source_fact_digest,
              terminal_event.id::text AS terminal_event_id,
              terminal_event.payload AS terminal_event_payload,
              terminal_event.occurred_at AS terminal_event_occurred_at,
              invocation.terminal_at
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
         JOIN agent_versions AS version
           ON version.id = invocation.agent_version_id
          AND version.creator_id = invocation.creator_id
         JOIN context_snapshots AS snapshot
           ON snapshot.id = version.snapshot_id
          AND snapshot.creator_id = version.creator_id
         LEFT JOIN agent_invocation_events AS terminal_event
           ON terminal_event.invocation_id = invocation.id
          AND terminal_event.creator_id = invocation.creator_id
          AND terminal_event.consumer_subject_id = invocation.consumer_subject_id
          AND terminal_event.source = 'WORKER'
          AND terminal_event.event_type = $5
         LEFT JOIN consumer_event_outbox AS consumer_event
           ON consumer_event.invocation_id = invocation.id
          AND consumer_event.source_event_id = terminal_event.id
          AND consumer_event.event_type = 'invocation.terminal'
        WHERE invocation.id = $1
          AND invocation.conversation_id = $2
          AND invocation.creator_id = $3
          AND invocation.consumer_subject_id = $4
        FOR UPDATE OF invocation, conversation`,
      [input.fact.invocationId, conversationId, input.creatorId, consumerId, eventType],
    );
    const current = authority.rows[0];
    if (!current) {
      throw new CloudJournalError('EXECUTION_AUTHORITY_MISMATCH', 'Invocation 不存在或租户不匹配');
    }
    if (
      current.agent_version_digest !== input.fact.agentVersionDigest ||
      current.snapshot_digest !== input.fact.snapshotDigest ||
      current.consumer_subject_id !== consumerId ||
      current.assigned_worker_id !== input.installationId ||
      current.assignment_lease_id !== input.fact.leaseId ||
      !bigintEquals(current.assignment_fence, input.fact.fence) ||
      current.execution_capability_id === null ||
      current.execution_capability_digest !== input.fact.executionCapabilityDigest
    ) {
      throw new CloudJournalError(
        'EXECUTION_AUTHORITY_MISMATCH',
        'failed terminal 与 durable Version/Worker/Lease/Fence/Capability 不一致',
      );
    }

    if (current.state === terminalState) {
      const durableTerminalEvent = FailedInvocationEventPayloadSchema.safeParse(
        current.terminal_event_payload,
      );
      if (
        current.terminal_source_event_id !== input.fact.sourceEventId ||
        current.terminal_source_fact_digest !== input.factDigest ||
        !durableTerminalEvent.success ||
        durableTerminalEvent.data.state !== terminalEventPayload.state ||
        durableTerminalEvent.data.errorCode !== terminalEventPayload.errorCode ||
        current.result_message_id !== null ||
        current.result_digest !== null ||
        current.error_code !== errorCode ||
        current.terminal_at === null ||
        current.terminal_event_occurred_at === null ||
        isoDate(current.terminal_event_occurred_at) !== isoDate(current.terminal_at) ||
        isoDate(current.terminal_at) !== isoDate(admissionRow.terminal_at) ||
        current.consumer_event_cursor !== consumerEventCursor ||
        current.conversation_state !== 'IDLE'
      ) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          '已提交 failed terminal 与 durable Event/projection 不一致',
        );
      }
      if (current.consumer_event_cursor !== null) {
        const durablePayload = ConsumerTerminalEventPayloadSchema.safeParse(
          current.consumer_event_payload,
        );
        if (
          current.consumer_event_source_event_id === null ||
          current.consumer_event_type !== 'invocation.terminal' ||
          current.consumer_event_source_event_id !== current.terminal_event_id ||
          !durablePayload.success ||
          durablePayload.data.conversationId !== conversationId ||
          durablePayload.data.invocationId !== input.fact.invocationId ||
          durablePayload.data.terminalState !== terminalState ||
          durablePayload.data.assistantMessageId !== null ||
          durablePayload.data.resultDigest !== null ||
          durablePayload.data.errorCode !== errorCode ||
          current.consumer_event_payload_digest !==
            consumerEventPayloadDigest(durablePayload.data) ||
          current.consumer_event_dedupe_key !==
            consumerEventDedupeKey({
              ownerId: consumerId,
              sourceEventId: current.consumer_event_source_event_id,
              eventType: 'invocation.terminal',
            })
        ) {
          throw new CloudJournalError(
            'PERSISTENCE_INVARIANT_FAILED',
            '已提交 failed terminal 的 retained Consumer Event 不一致',
          );
        }
      }
      return committedFailedOutcome({
        invocationId: input.fact.invocationId,
        state: terminalState,
        errorCode,
        consumerEventCursor,
        replayed: true,
      });
    }

    throw new CloudJournalError(
      'PERSISTENCE_INVARIANT_FAILED',
      'exact failed fact admission 未匹配 durable FAILED projection',
    );
  }

  public async projectCancelled(
    rawConnection: InvocationProjectorTransaction,
    rawInput: CommitCancelledInput,
    signal: AbortSignal,
  ): Promise<ProjectCancelledOutcome> {
    const input = CommitCancelledInputSchema.parse(rawInput);
    return this.#projectConfirmedCancellation(rawConnection, input, signal);
  }

  async #projectConfirmedCancellation(
    rawConnection: InvocationProjectorTransaction,
    input: CommitCancelledInput,
    signal: AbortSignal,
  ): Promise<ProjectCancelledOutcome> {
    const connection = bindInvocationProjectorSignal(rawConnection, signal);
    assertCanonicalWorkerFact(input.fact, input.factDigest);
    if (input.fact.sourceEventId !== input.fact.invocationId) {
      throw new CloudJournalError(
        'WORKER_FACT_CONFLICT',
        'cancelled event 与 canonical Worker fact identity 不一致',
      );
    }
    if (!Sha256DigestSchema.safeParse(input.fact.interruptReceiptDigest).success) {
      throw new CloudJournalError(
        'WORKER_FACT_CONFLICT',
        'cancelled fact interruptReceiptDigest 非法',
      );
    }
    const terminalState = 'CANCELLED' as const;
    const eventType = 'invocation.cancelled' as const;
    const terminalEventPayload = CancelledInvocationEventPayloadSchema.parse({
      state: terminalState,
    });
    const admission = await connection.query<CancelledFactAdmissionRow>(
      `SELECT outcome, interrupt_receipt_digest::text, terminal_at,
              consumer_event_cursor::text,
              invocation_cancelled, cancelled_event_appended, consumer_event_appended,
              consumer_stream_advanced, terminal_receipt_appended, conversation_idled,
              alert_id::text, alert_replayed
         FROM creator_agent_project_cancelled_fact_v1(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
         )`,
      [
        input.creatorId,
        input.installationId,
        input.fact.protocol,
        input.fact.schemaVersion,
        input.fact.type,
        input.fact.sourceEventId,
        input.fact.invocationId,
        input.fact.agentVersionDigest,
        input.fact.snapshotDigest,
        input.fact.executionCapabilityDigest,
        input.fact.leaseId,
        input.fact.fence,
        input.fact.interruptReceiptDigest,
        input.factDigest,
      ],
    );
    const admissionRow = admission.rows[0];
    const admissionOutcome = CancelledFactAdmissionOutcomeSchema.safeParse(admissionRow?.outcome);
    if (admission.rowCount !== 1 || !admissionRow || !admissionOutcome.success) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'cancelled fact admission 未返回唯一稳定 outcome',
      );
    }
    if (admissionOutcome.data === 'SECURITY_BLOCKED') {
      if (
        admissionRow.interrupt_receipt_digest !== null ||
        admissionRow.terminal_at !== null ||
        admissionRow.consumer_event_cursor !== null ||
        admissionRow.invocation_cancelled !== null ||
        admissionRow.cancelled_event_appended !== null ||
        admissionRow.consumer_event_appended !== null ||
        admissionRow.consumer_stream_advanced !== null ||
        admissionRow.terminal_receipt_appended !== null ||
        admissionRow.conversation_idled !== null ||
        !UuidSchema.safeParse(admissionRow.alert_id).success ||
        typeof admissionRow.alert_replayed !== 'boolean'
      ) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'cancelled fact security block 缺少 durable alert outcome',
        );
      }
      await inject(this.failureInjector, 'JOURNAL_INTEGRITY_ALERT');
      return PROJECT_CANCELLED_SECURITY_BLOCKED;
    }
    if (admissionRow.alert_id !== null || admissionRow.alert_replayed !== null) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'cancelled fact non-security outcome 携带了 alert metadata',
      );
    }
    switch (admissionOutcome.data) {
      case 'TERMINAL':
        throw new CloudJournalError('TERMINAL_CONFLICT', 'Invocation 已有其他终态');
      case 'UNAVAILABLE':
      case 'AUTHORITY_REJECTED':
        throw new CloudJournalError(
          'EXECUTION_AUTHORITY_MISMATCH',
          'cancelled fact 与 durable execution authority 不一致',
        );
      case 'INVARIANT_FAILED':
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'cancelled fact durable invariant 失败',
        );
      case 'ADMITTED':
      case 'EXACT':
        break;
    }
    if (
      !Sha256DigestSchema.safeParse(admissionRow.interrupt_receipt_digest).success ||
      admissionRow.interrupt_receipt_digest !== input.fact.interruptReceiptDigest ||
      admissionRow.terminal_at === null
    ) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'cancelled fact admission 缺少 exact digest/time outcome',
      );
    }
    const parsedCursor =
      admissionRow.consumer_event_cursor === null
        ? null
        : Uint63StringSchema.safeParse(String(admissionRow.consumer_event_cursor));
    if (parsedCursor !== null && !parsedCursor.success) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'cancelled fact admission 返回非法 Consumer cursor',
      );
    }
    const consumerEventCursor = parsedCursor === null ? null : parsedCursor.data;
    if (admissionOutcome.data === 'ADMITTED') {
      if (
        consumerEventCursor === null ||
        admissionRow.invocation_cancelled !== true ||
        admissionRow.cancelled_event_appended !== true ||
        admissionRow.consumer_event_appended !== true ||
        admissionRow.consumer_stream_advanced !== true ||
        admissionRow.terminal_receipt_appended !== true ||
        admissionRow.conversation_idled !== true
      ) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          'admitted cancelled fact mutation flags 非 canonical',
        );
      }
      await inject(this.failureInjector, 'INVOCATION_CANCELLED');
      await inject(this.failureInjector, 'CANCELLED_EVENT');
      await inject(this.failureInjector, 'CONSUMER_EVENT_OUTBOX');
      await inject(this.failureInjector, 'CONSUMER_EVENT_STREAM');
      await inject(this.failureInjector, 'CANCELLED_TERMINAL_RECEIPT');
      await inject(this.failureInjector, 'CONVERSATION_IDLE');
      return committedCancelledOutcome({
        invocationId: input.fact.invocationId,
        state: terminalState,
        consumerEventCursor,
        replayed: false,
      });
    }
    if (
      admissionRow.invocation_cancelled !== false ||
      admissionRow.cancelled_event_appended !== false ||
      admissionRow.consumer_event_appended !== false ||
      admissionRow.consumer_stream_advanced !== false ||
      admissionRow.terminal_receipt_appended !== false ||
      admissionRow.conversation_idled !== false
    ) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'exact cancelled fact outcome 声称发生 mutation',
      );
    }

    const tenant = await connection.query<{
      consumer_subject_id: string;
      conversation_id: string;
    }>(
      `SELECT consumer_subject_id::text, conversation_id::text
         FROM agent_invocations
        WHERE id = $1 AND creator_id = $2 AND assigned_worker_id = $3`,
      [input.fact.invocationId, input.creatorId, input.installationId],
    );
    const parsedConsumerId = UuidSchema.safeParse(tenant.rows[0]?.consumer_subject_id);
    const parsedConversationId = UuidSchema.safeParse(tenant.rows[0]?.conversation_id);
    if (tenant.rows.length !== 1 || !parsedConsumerId.success || !parsedConversationId.success) {
      throw new CloudJournalError(
        'PERSISTENCE_INVARIANT_FAILED',
        'cancelled fact admission 未保留 exact tenant projection',
      );
    }
    const consumerId = parsedConsumerId.data;
    const conversationId = parsedConversationId.data;
    const authority = await connection.query<CancelledAuthorityRow>(
      `SELECT invocation.state, invocation.consumer_subject_id,
              invocation.result_message_id, invocation.result_digest, invocation.error_code,
              version.version_digest AS agent_version_digest, snapshot.snapshot_digest,
              invocation.assigned_worker_id, invocation.assignment_lease_id,
              invocation.assignment_fence, invocation.execution_capability_id,
              invocation.execution_capability_digest,
              (
                invocation.execution_capability_expires_at > now()
                AND invocation.execution_capability_revoked_at IS NULL
              ) AS execution_capability_valid,
              invocation.execution_capability_revoked_at,
              conversation.state AS conversation_state,
              lease.state AS lease_state, (lease.expires_at > now()) AS lease_valid,
              EXISTS (
                SELECT 1
                  FROM agent_invocation_events AS started_event
                  JOIN broker_outbox AS started_command
                    ON started_command.command_id = started_event.broker_command_id
                   AND started_command.creator_id = started_event.creator_id
                   AND started_command.invocation_id = started_event.invocation_id
                   AND started_command.consumer_subject_id = started_event.consumer_subject_id
                 WHERE started_event.invocation_id = invocation.id
                   AND started_event.source = 'WORKER'
                   AND started_event.event_type = 'invocation.started'
                   AND started_event.source_fact_digest IS NOT NULL
                   AND started_command.command_type = 'invocation.start'
                   AND started_command.state IN ('ACKED', 'EXPIRED')
                   AND started_command.target_worker_id = invocation.assigned_worker_id
                   AND started_command.assignment_lease_id = invocation.assignment_lease_id
                   AND started_command.assignment_fence = invocation.assignment_fence
                   AND started_command.execution_capability_id = invocation.execution_capability_id
                   AND started_command.execution_capability_digest =
                         invocation.execution_capability_digest
              ) AS has_durable_started_evidence,
              consumer_event.cursor::text AS consumer_event_cursor,
              consumer_event.source_event_id AS consumer_event_source_event_id,
              consumer_event.event_type AS consumer_event_type,
              consumer_event.payload AS consumer_event_payload,
              consumer_event.payload_digest AS consumer_event_payload_digest,
              consumer_event.dedupe_key AS consumer_event_dedupe_key,
              terminal_event.source_event_id AS terminal_source_event_id,
              terminal_event.source_fact_digest AS terminal_source_fact_digest,
              terminal_event.id::text AS terminal_event_id,
              terminal_event.payload AS terminal_event_payload,
              terminal_event.occurred_at AS terminal_event_occurred_at,
              invocation.terminal_at
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
         JOIN agent_versions AS version
           ON version.id = invocation.agent_version_id
          AND version.creator_id = invocation.creator_id
         JOIN context_snapshots AS snapshot
           ON snapshot.id = version.snapshot_id
          AND snapshot.creator_id = version.creator_id
         LEFT JOIN agent_invocation_events AS terminal_event
           ON terminal_event.invocation_id = invocation.id
          AND terminal_event.creator_id = invocation.creator_id
          AND terminal_event.consumer_subject_id = invocation.consumer_subject_id
          AND terminal_event.source = 'WORKER'
          AND terminal_event.event_type = $5
         LEFT JOIN consumer_event_outbox AS consumer_event
           ON consumer_event.invocation_id = invocation.id
          AND consumer_event.source_event_id = terminal_event.id
          AND consumer_event.event_type = 'invocation.terminal'
        WHERE invocation.id = $1
          AND invocation.conversation_id = $2
          AND invocation.creator_id = $3
          AND invocation.consumer_subject_id = $4
        FOR UPDATE OF invocation, conversation`,
      [input.fact.invocationId, conversationId, input.creatorId, consumerId, eventType],
    );
    const current = authority.rows[0];
    if (!current) {
      throw new CloudJournalError('EXECUTION_AUTHORITY_MISMATCH', 'Invocation 不存在或租户不匹配');
    }
    if (
      current.agent_version_digest !== input.fact.agentVersionDigest ||
      current.snapshot_digest !== input.fact.snapshotDigest ||
      current.consumer_subject_id !== consumerId ||
      current.assigned_worker_id !== input.installationId ||
      current.assignment_lease_id !== input.fact.leaseId ||
      !bigintEquals(current.assignment_fence, input.fact.fence) ||
      current.execution_capability_id === null ||
      current.execution_capability_digest !== input.fact.executionCapabilityDigest
    ) {
      throw new CloudJournalError(
        'EXECUTION_AUTHORITY_MISMATCH',
        'cancelled terminal 与 durable Version/Worker/Lease/Fence/Capability 不一致',
      );
    }

    if (current.state === terminalState) {
      const durableTerminalEvent = CancelledInvocationEventPayloadSchema.safeParse(
        current.terminal_event_payload,
      );
      if (
        current.terminal_source_event_id !== input.fact.sourceEventId ||
        current.terminal_source_fact_digest !== input.factDigest ||
        !durableTerminalEvent.success ||
        durableTerminalEvent.data.state !== terminalEventPayload.state ||
        current.result_message_id !== null ||
        current.result_digest !== null ||
        current.error_code !== null ||
        current.terminal_at === null ||
        current.terminal_event_occurred_at === null ||
        isoDate(current.terminal_event_occurred_at) !== isoDate(current.terminal_at) ||
        isoDate(current.terminal_at) !== isoDate(admissionRow.terminal_at) ||
        current.consumer_event_cursor !== consumerEventCursor ||
        current.conversation_state !== 'IDLE'
      ) {
        throw new CloudJournalError(
          'PERSISTENCE_INVARIANT_FAILED',
          '已提交 cancelled terminal 与 durable Event/projection 不一致',
        );
      }
      if (current.consumer_event_cursor !== null) {
        const durablePayload = ConsumerTerminalEventPayloadSchema.safeParse(
          current.consumer_event_payload,
        );
        if (
          current.consumer_event_source_event_id === null ||
          current.consumer_event_type !== 'invocation.terminal' ||
          current.consumer_event_source_event_id !== current.terminal_event_id ||
          !durablePayload.success ||
          durablePayload.data.conversationId !== conversationId ||
          durablePayload.data.invocationId !== input.fact.invocationId ||
          durablePayload.data.terminalState !== terminalState ||
          durablePayload.data.assistantMessageId !== null ||
          durablePayload.data.resultDigest !== null ||
          durablePayload.data.errorCode !== null ||
          current.consumer_event_payload_digest !==
            consumerEventPayloadDigest(durablePayload.data) ||
          current.consumer_event_dedupe_key !==
            consumerEventDedupeKey({
              ownerId: consumerId,
              sourceEventId: current.consumer_event_source_event_id,
              eventType: 'invocation.terminal',
            })
        ) {
          throw new CloudJournalError(
            'PERSISTENCE_INVARIANT_FAILED',
            '已提交 cancelled terminal 的 retained Consumer Event 不一致',
          );
        }
      }
      return committedCancelledOutcome({
        invocationId: input.fact.invocationId,
        state: terminalState,
        consumerEventCursor,
        replayed: true,
      });
    }

    throw new CloudJournalError(
      'PERSISTENCE_INVARIANT_FAILED',
      'exact cancelled fact admission 未匹配 durable CANCELLED projection',
    );
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
    const outcome = await withTenantTransaction<BeginReconciliationCommitOutcome>(
      pool,
      input,
      async (connection) => {
        const admission = await connection.query<BeginReconciliationAdmissionRow>(
          `SELECT outcome, reconciliation_started_at, alert_id::text, alert_replayed
             FROM creator_agent_begin_reconciliation_v2($1, $2, $3, $4, $5, $6)`,
          [
            input.creatorId,
            input.consumerId,
            input.conversationId,
            input.invocationId,
            input.sourceEventId,
            input.reason,
          ],
        );
        const admissionRow = admission.rows[0];
        const admissionOutcome = BeginReconciliationAdmissionOutcomeSchema.safeParse(
          admissionRow?.outcome,
        );
        if (admission.rowCount !== 1 || !admissionRow || !admissionOutcome.success) {
          throw new CloudJournalError(
            'PERSISTENCE_INVARIANT_FAILED',
            'reconciliation admission 未返回唯一稳定 outcome',
          );
        }
        switch (admissionOutcome.data) {
          case 'SECURITY_BLOCKED':
            if (
              admissionRow.reconciliation_started_at !== null ||
              !UuidSchema.safeParse(admissionRow.alert_id).success ||
              typeof admissionRow.alert_replayed !== 'boolean'
            ) {
              throw new CloudJournalError(
                'PERSISTENCE_INVARIANT_FAILED',
                'reconciliation security block 缺少 durable alert outcome',
              );
            }
            await inject(this.failureInjector, 'JOURNAL_INTEGRITY_ALERT');
            return JOURNAL_SECURITY_BLOCKED_COMMIT_OUTCOME;
          case 'ADMITTED':
            if (
              admissionRow.reconciliation_started_at === null ||
              admissionRow.alert_id !== null ||
              admissionRow.alert_replayed !== null
            ) {
              throw new CloudJournalError(
                'PERSISTENCE_INVARIANT_FAILED',
                'fresh reconciliation admission 缺少 Cloud-time outcome',
              );
            }
            await inject(this.failureInjector, 'INVOCATION_RECONCILING');
            await inject(this.failureInjector, 'RECONCILING_EVENT');
            return {
              invocationId: input.invocationId,
              state: 'RECONCILING',
              reason: input.reason,
              reconciliationStartedAt: isoDate(admissionRow.reconciliation_started_at),
              reconciliationDeadlineAt: reconciliationDeadline(
                admissionRow.reconciliation_started_at,
              ),
              replayed: false,
            };
          case 'SOURCE_DIFFERENT':
            if (
              admissionRow.reconciliation_started_at !== null ||
              admissionRow.alert_id !== null ||
              admissionRow.alert_replayed !== null
            ) {
              throw new CloudJournalError(
                'PERSISTENCE_INVARIANT_FAILED',
                'reconciliation source conflict outcome 非 canonical',
              );
            }
            throw new CloudJournalError(
              'TERMINAL_CONFLICT',
              'Reconciliation 重放与 durable source binding 不一致',
            );
          case 'TERMINAL':
            throw new CloudJournalError('TERMINAL_CONFLICT', 'Invocation 已有终态');
          case 'UNAVAILABLE':
            throw new CloudJournalError(
              'EXECUTION_AUTHORITY_MISMATCH',
              'Invocation 不存在或 reconciliation authority 不可用',
            );
          case 'INVARIANT_FAILED':
            throw new CloudJournalError(
              'PERSISTENCE_INVARIANT_FAILED',
              'reconciliation admission durable invariant 失败',
            );
          case 'EXACT':
            if (
              admissionRow.reconciliation_started_at === null ||
              admissionRow.alert_id !== null ||
              admissionRow.alert_replayed !== null
            ) {
              throw new CloudJournalError(
                'PERSISTENCE_INVARIANT_FAILED',
                'exact reconciliation admission outcome 非 canonical',
              );
            }
            break;
        }
        if (admissionOutcome.data !== 'EXACT' || admissionRow.reconciliation_started_at === null) {
          throw new CloudJournalError(
            'PERSISTENCE_INVARIANT_FAILED',
            'reconciliation admission outcome 未终止或进入 exact path',
          );
        }
        const exactAdmissionStartedAt = admissionRow.reconciliation_started_at;
        const authority = await connection.query<BeginReconciliationAuthorityRow>(
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
                reconciling_event.source_event_id AS reconciliation_source_event_id,
                reconciling_event.payload AS reconciliation_event_payload,
                reconciling_event.occurred_at AS reconciliation_event_occurred_at,
                reconciling_event.journal_seq AS reconciliation_journal_seq,
                latest_started_event.source_event_id AS latest_started_source_event_id,
                latest_started_event.journal_seq AS latest_started_journal_seq,
                resumed_event.source_event_id AS reconciliation_resumed_source_event_id,
                resumed_event.payload AS reconciliation_resumed_event_payload,
                resumed_event.journal_seq AS reconciliation_resumed_journal_seq
           FROM agent_invocations AS invocation
           JOIN agent_conversations AS conversation
             ON conversation.id = invocation.conversation_id
            AND conversation.creator_id = invocation.creator_id
            AND conversation.consumer_subject_id = invocation.consumer_subject_id
           LEFT JOIN agent_invocation_events AS reconciling_event
             ON reconciling_event.invocation_id = invocation.id
            AND reconciling_event.source = 'RECONCILER'
            AND reconciling_event.event_type = 'invocation.reconciling'
           LEFT JOIN LATERAL (
             SELECT started_event.source_event_id, started_event.journal_seq
               FROM agent_invocation_events AS started_event
              WHERE started_event.invocation_id = invocation.id
                AND started_event.source = 'WORKER'
                AND started_event.event_type = 'invocation.started'
                AND started_event.payload = '{"state":"RUNNING"}'::jsonb
              ORDER BY started_event.journal_seq DESC
              LIMIT 1
           ) AS latest_started_event ON true
           LEFT JOIN LATERAL (
             SELECT candidate.source_event_id, candidate.payload, candidate.journal_seq
               FROM agent_invocation_events AS candidate
              WHERE candidate.invocation_id = invocation.id
                AND candidate.source = 'RECONCILER'
                AND candidate.event_type = 'invocation.reconciling_resumed'
                AND candidate.source_event_id =
                      'resume-reconciliation:' || reconciling_event.source_event_id || ':' ||
                      latest_started_event.source_event_id
              ORDER BY candidate.journal_seq DESC
              LIMIT 1
           ) AS resumed_event ON true
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
        const durableReconciliationReason = InvocationUncertaintyReasonSchema.safeParse(
          current.reconciliation_reason,
        );
        const durableReconciliationPayload = ReconciliationInvocationEventPayloadSchema.safeParse(
          current.reconciliation_event_payload,
        );
        const durableReconciliationResumedPayload =
          ReconciliationInvocationEventPayloadSchema.safeParse(
            current.reconciliation_resumed_event_payload,
          );
        const reconciliationJournalSeq = positiveJournalSeq(current.reconciliation_journal_seq);
        const latestStartedJournalSeq = positiveJournalSeq(current.latest_started_journal_seq);
        const resumedJournalSeq = positiveJournalSeq(current.reconciliation_resumed_journal_seq);
        const hasExactStoredReconciliationRoot =
          durableReconciliationReason.success &&
          current.reconciliation_source_event_id !== null &&
          current.reconciliation_started_at !== null &&
          current.reconciliation_event_occurred_at !== null &&
          reconciliationJournalSeq !== null &&
          durableReconciliationPayload.success &&
          durableReconciliationPayload.data.reason === durableReconciliationReason.data &&
          isoDate(current.reconciliation_event_occurred_at) ===
            isoDate(current.reconciliation_started_at) &&
          isoDate(current.reconciliation_started_at) === isoDate(exactAdmissionStartedAt);
        const hasExactReconciliationRoot =
          hasExactStoredReconciliationRoot &&
          reconciliationRootAcceptsInput(
            current.reconciliation_source_event_id,
            input.sourceEventId,
          );
        const latestStartedIsAfterRoot =
          reconciliationJournalSeq !== null &&
          latestStartedJournalSeq !== null &&
          latestStartedJournalSeq > reconciliationJournalSeq;
        const hasExactCurrentResumedEvent =
          current.reconciliation_source_event_id !== null &&
          current.latest_started_source_event_id !== null &&
          current.reconciliation_resumed_source_event_id ===
            reconciliationResumedSourceEventId(
              current.reconciliation_source_event_id,
              current.latest_started_source_event_id,
            ) &&
          durableReconciliationResumedPayload.success &&
          durableReconciliationResumedPayload.data.reason === input.reason &&
          resumedJournalSeq !== null &&
          latestStartedJournalSeq !== null &&
          resumedJournalSeq > latestStartedJournalSeq;
        if (current.state === 'RECONCILING') {
          if (
            !hasExactReconciliationRoot ||
            current.reconciliation_started_at === null ||
            !durableReconciliationReason.success ||
            durableReconciliationReason.data !== input.reason
          ) {
            throw new CloudJournalError(
              'TERMINAL_CONFLICT',
              'Reconciliation 重放与 durable lost-evidence binding 不一致',
            );
          }
          if (
            latestStartedIsAfterRoot
              ? !hasExactCurrentResumedEvent
              : current.reconciliation_resumed_source_event_id !== null
          ) {
            throw new CloudJournalError(
              'PERSISTENCE_INVARIANT_FAILED',
              'reconciliation projection 与当前 durable resume episode 不一致',
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
            !hasExactReconciliationRoot ||
            !durableReconciliationReason.success ||
            durableReconciliationReason.data !== input.reason
          ) {
            throw new CloudJournalError(
              'TERMINAL_CONFLICT',
              '再次 reconciliation 与首个 durable lost-evidence binding 不一致',
            );
          }
          if (
            !latestStartedIsAfterRoot ||
            current.reconciliation_source_event_id === null ||
            current.latest_started_source_event_id === null ||
            current.reconciliation_resumed_source_event_id !== null
          ) {
            throw new CloudJournalError(
              'PERSISTENCE_INVARIANT_FAILED',
              'RUNNING reconciliation re-entry 缺少唯一 root→started episode',
            );
          }
          const resumedSourceEventId = reconciliationResumedSourceEventId(
            current.reconciliation_source_event_id,
            current.latest_started_source_event_id,
          );
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
          await inject(this.failureInjector, 'INVOCATION_RECONCILING');
          await connection.query(
            `INSERT INTO agent_invocation_events (
             invocation_id, creator_id, consumer_subject_id, journal_seq, source,
             source_event_id, event_type, payload, occurred_at
           )
           SELECT $1, $2, $3, COALESCE(max(journal_seq), 0) + 1,
                  'RECONCILER', $4, 'invocation.reconciling_resumed', $5::jsonb,
                  clock_timestamp()
             FROM agent_invocation_events
            WHERE invocation_id = $1`,
            [
              input.invocationId,
              input.creatorId,
              input.consumerId,
              resumedSourceEventId,
              JSON.stringify({ state: 'RECONCILING', reason: input.reason }),
            ],
          );
          await inject(this.failureInjector, 'RECONCILING_RESUMED_EVENT');
          return {
            invocationId: input.invocationId,
            state: 'RECONCILING',
            reason: input.reason,
            reconciliationStartedAt: isoDate(current.reconciliation_started_at),
            reconciliationDeadlineAt: reconciliationDeadline(current.reconciliation_started_at),
            replayed: false,
          };
        }
        if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN', 'EXPIRED'].includes(current.state)) {
          throw new CloudJournalError('TERMINAL_CONFLICT', 'Invocation 已有终态');
        }
        throw new CloudJournalError(
          'EXECUTION_AUTHORITY_MISMATCH',
          'Invocation 不在 exact reconciliation replay/re-entry 状态',
        );
      },
    );
    if (isJournalSecurityBlockedOutcome(outcome)) {
      throw new CloudJournalError('JOURNAL_SECURITY_BLOCKED', 'JOURNAL_SECURITY_BLOCKED');
    }
    return outcome;
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
                terminal_event.id::text AS terminal_event_id,
                terminal_event.payload AS terminal_event_payload,
                terminal_event.occurred_at AS terminal_event_occurred_at,
                reconciling_event.source_event_id AS reconciliation_source_event_id
           FROM agent_invocations AS invocation
           JOIN agent_conversations AS conversation
             ON conversation.id = invocation.conversation_id
            AND conversation.creator_id = invocation.creator_id
            AND conversation.consumer_subject_id = invocation.consumer_subject_id
           LEFT JOIN agent_invocation_events AS terminal_event
             ON terminal_event.invocation_id = invocation.id
            AND terminal_event.creator_id = invocation.creator_id
            AND terminal_event.consumer_subject_id = invocation.consumer_subject_id
            AND terminal_event.source = 'RECONCILER'
            AND terminal_event.event_type = 'invocation.uncertain'
           LEFT JOIN consumer_event_outbox AS consumer_event
             ON consumer_event.invocation_id = invocation.id
            AND consumer_event.source_event_id = terminal_event.id
            AND consumer_event.event_type = 'invocation.terminal'
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
        const durableTerminalEvent = UncertainInvocationEventPayloadSchema.safeParse(
          current.terminal_event_payload,
        );
        if (
          current.reconciliation_reason !== input.reason ||
          current.uncertainty_reason !== input.reason ||
          current.error_code !== 'EXECUTION_STATE_UNKNOWN' ||
          current.reconciliation_started_at === null ||
          current.reconciliation_source_event_id === null ||
          current.reconciliation_source_event_id === input.sourceEventId ||
          current.terminal_at === null ||
          current.terminal_source_event_id !== input.sourceEventId ||
          current.terminal_event_occurred_at === null ||
          isoDate(current.terminal_event_occurred_at) !== isoDate(current.terminal_at) ||
          !durableTerminalEvent.success
        ) {
          throw new CloudJournalError(
            'TERMINAL_CONFLICT',
            'UNCERTAIN 重放与 durable terminal binding 不一致',
          );
        }
        if (current.consumer_event_cursor !== null) {
          const durablePayload = ConsumerTerminalEventPayloadSchema.safeParse(
            current.consumer_event_payload,
          );
          if (
            current.consumer_event_source_event_id === null ||
            current.consumer_event_type !== 'invocation.terminal' ||
            current.consumer_event_source_event_id !== current.terminal_event_id ||
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
              'UNCERTAIN retained Consumer Event 不一致',
            );
          }
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
