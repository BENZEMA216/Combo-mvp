import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import {
  BrokerEnvelopeSchema,
  LeaseBindingSchema,
  UuidSchema,
  WorkerConversationReadyFactSchema,
  canonicalSha256,
  canonicalizeJson,
  workerConversationReadyFactDigest,
  type BrokerCommand,
  type BrokerEnvelope,
  type LeaseBinding,
} from '@cb/creator-agent-protocol';
import {
  consumeSequence,
  initialSequenceCursor,
  restoreSequenceCursor,
  serializeSequenceCursor,
} from '@cb/creator-agent-broker-journal';

import {
  WorkerBrokerClientError,
  WORKER_CONVERSATION_READY_REPLAY_BATCH,
  durablePortDeadline,
  type DurableBrokerConnection,
  type ConversationReadyReplayRefill,
  type LeaseGrantCommand,
  type WorkerBrokerDurableTransportPort,
} from './worker-broker-client.js';
import {
  WORKER_INVOCATION_SCHEMA_SQL,
  WORKER_INVOCATION_SCHEMA_V4_SQL,
  WORKER_INVOCATION_SCHEMA_V5_SQL,
  WORKER_INVOCATION_SCHEMA_VERSION,
  WORKER_CONVERSATION_READY_SCHEMA_SQL,
  WORKER_CONVERSATION_READY_SCHEMA_V4_SQL,
  WORKER_CONVERSATION_READY_SCHEMA_VERSION,
  WORKER_DEFENSIVE_INTEGRITY_SCHEMA_VERSION,
  WORKER_HOST_CONTROL_SCHEMA_VERSION,
  SqliteWorkerInvocationJournal,
  assertWorkerConversationReadyIntegrity,
  assertWorkerInvocationIntegrity,
  sqliteInvocationRowDigest,
  workerInvocationCommandSemanticDigest,
  workerInvocationAuthorityRows,
  workerInvocationTablesExist,
  workerConversationReadyTablesExist,
  type OpaqueInvocationCommandReference,
  type SqliteWorkerInvocationJournalOptions,
  type WorkerInvocationJournalHost,
} from './sqlite-invocation-journal.js';
import {
  decodeStoredBrokerEnvelope,
  materializeStoredBrokerEnvelope,
  type DecodedStoredBrokerEnvelope,
  type StoredBrokerConversationAuthority,
  type StoredBrokerTransportAuthority,
} from './stored-broker-envelope.js';

type NodeSqliteModule = Readonly<{ DatabaseSync: typeof DatabaseSync }>;

const loadNodeSqlite = (): NodeSqliteModule =>
  createRequire(import.meta.url)('node:sqlite') as NodeSqliteModule;

export const WORKER_TRANSPORT_APPLICATION_ID = 0x43425754;
export const WORKER_TRANSPORT_SCHEMA_VERSION = WORKER_HOST_CONTROL_SCHEMA_VERSION;
export const WORKER_TRANSPORT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const WORKER_TRANSPORT_SEQUENCE_RETENTION = 1_024;
export const WORKER_TRANSPORT_DEFAULT_MAX_INBOUND_ROWS = 512;
export const WORKER_TRANSPORT_DEFAULT_MAX_OUTBOX_ROWS = 512;
export const WORKER_TRANSPORT_DEFAULT_MAX_RETAINED_INBOUND_ROWS = 1_000_000;
export const WORKER_TRANSPORT_DEFAULT_MAX_RETAINED_OUTBOX_ROWS = 1_000_000;
export const WORKER_TRANSPORT_DEFAULT_MAX_DATABASE_BYTES = 256 * 1024 * 1024;
export const WORKER_TRANSPORT_DEFAULT_MAX_WAL_BYTES = 64 * 1024 * 1024;
export const WORKER_TRANSPORT_DEFAULT_MIN_FREE_BYTES = 64 * 1024 * 1024;
export const WORKER_TRANSPORT_RECOVERY_RESERVE_PAGES = 128;
export const WORKER_TRANSPORT_FILESYSTEM_RECOVERY_RESERVE_BYTES = 1024 * 1024;

const ACK_RANK = Object.freeze({ RECEIVED: 0, PERSISTED: 1, CLOUD_COMMITTED: 2 });
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const UUID_V7_VERSION_INDEX = 14;
const SQLITE_BUSY_WAIT = new Int32Array(new SharedArrayBuffer(4));
const ZERO_DIGEST = '0'.repeat(64);
const PRUNE_BATCH_SIZE = 128;
const LEGACY_WATERMARK_FORMAT_VERSION = 1;
const WATERMARK_FORMAT_VERSION = 2;
const WATERMARK_EVIDENCE_VERSION = 2;
const LEGACY_WATERMARK_DIGEST_DOMAIN = 'combo:vnext:worker-commit-watermark:v1\0';
const WATERMARK_DIGEST_DOMAIN = 'combo:vnext:worker-commit-watermark:v2\0';
const MIGRATION_RECOVERY_FORMAT_VERSION = 1;
const MIGRATION_RECOVERY_DIGEST_DOMAIN = 'combo:vnext:worker-migration-recovery-manifest:v1\0';
const MIGRATION_RECOVERY_CANDIDATE_DIGEST_DOMAIN =
  'combo:vnext:worker-migration-recovery-candidate:v1\0';
const WAL_ADMISSION_RECOVERY_HEADROOM_BYTES = 256 * 1024;
// A single bounded refill can atomically materialize 128 transport envelopes plus their local
// delivery rows and content evidence. Keep enough disposable pages above the protected recovery
// reserve for that maximum healthy batch; otherwise a large READY refill can roll back with
// CAPACITY_EXCEEDED despite ample max_page_count and free filesystem space.
const DATABASE_ADMISSION_HEADROOM_PAGES = 256;

const LEGACY_V3_COMMAND_MIGRATION_CLASS = Object.freeze({
  'lease.grant': 'TRANSPORT_CONTROL',
  'lease.revoke': 'TRANSPORT_CONTROL',
  'version.prepare': 'BUSINESS',
  'deployment.drain': 'BUSINESS',
  'conversation.open': 'BUSINESS',
  'conversation.close': 'BUSINESS',
  'invocation.prepare': 'BUSINESS',
  'invocation.start': 'BUSINESS',
  'invocation.cancel': 'BUSINESS',
  'invocation.reconcile': 'BUSINESS',
  ping: 'TRANSPORT_CONTROL',
} as const satisfies Record<BrokerCommand['type'], 'TRANSPORT_CONTROL' | 'BUSINESS'>);
const LEGACY_V3_TRANSPORT_CONTROL_SQL = Object.entries(LEGACY_V3_COMMAND_MIGRATION_CLASS)
  .filter(([, classification]) => classification === 'TRANSPORT_CONTROL')
  .map(([type]) => `'${type}'`)
  .join(', ');

export type SqliteWorkerTransportFaultPoint =
  | 'migration.before_commit'
  | 'migration.after_commit'
  | 'migration.v1_to_v2.before_watermark'
  | 'migration.v1_to_v2.after_watermark_fsync'
  | 'migration.v1_to_v2.after_commit'
  | 'migration.v2_to_v3.before_watermark'
  | 'migration.v2_to_v3.before_authority_digest'
  | 'migration.v2_to_v3.after_watermark_fsync'
  | 'migration.v2_to_v3.after_commit'
  | 'migration.v3_to_v4.before_watermark'
  | 'migration.v3_to_v4.after_watermark_fsync'
  | 'migration.v3_to_v4.after_commit'
  | 'migration.v3_to_v4.after_local_projection'
  | 'migration.v3_to_v4.before_authority_digest'
  | 'migration.v4_to_v5.before_watermark'
  | 'migration.v4_to_v5.after_watermark_fsync'
  | 'migration.v4_to_v5.after_commit'
  | 'migration.v4_to_v5.after_local_projection'
  | 'migration.v4_to_v5.before_authority_digest'
  | `${string}.before_commit`
  | `${string}.after_watermark_fsync`
  | `${string}.after_commit`;

export type SqliteWorkerTransportErrorCode =
  | 'JOURNAL_PATH_INVALID'
  | 'JOURNAL_MISSING'
  | 'JOURNAL_PARENT_UNSAFE'
  | 'JOURNAL_FILE_UNSAFE'
  | 'JOURNAL_CORRUPT'
  | 'JOURNAL_SCHEMA_UNSUPPORTED'
  | 'JOURNAL_PRAGMA_MISMATCH'
  | 'JOURNAL_BUSY'
  | 'JOURNAL_CAPACITY'
  | 'JOURNAL_RECONCILIATION_REQUIRED'
  | 'JOURNAL_ABORTED'
  | 'JOURNAL_CLOSED';

export class SqliteWorkerTransportError extends Error {
  constructor(readonly code: SqliteWorkerTransportErrorCode) {
    super(code);
    this.name = 'SqliteWorkerTransportError';
  }
}

class CommitWatermarkMismatchError extends Error {
  constructor() {
    super('commit-watermark-mismatch');
  }
}

export type SqliteWorkerTransportOptions = Readonly<{
  filename: string;
  newJournalAuthorization?: NewWorkerJournalAuthorization;
  busyTimeoutMs?: number;
  operationTimeoutMs?: number;
  ownerLeaseMs?: number;
  allowUnsafeShortOwnerLeaseForTests?: boolean;
  maxConnections?: number;
  maxInboundRows?: number;
  maxOutboxRows?: number;
  maxRetainedInboundRows?: number;
  maxRetainedOutboxRows?: number;
  maxSequenceGapRows?: number;
  maxDatabaseBytes?: number;
  maxWalBytes?: number;
  minFreeBytes?: number;
  /** Deterministic capacity probe used only by storage-pressure tests. */
  availableFilesystemBytesForTests?: () => number;
  now?: () => number;
  faultInjector?: (point: SqliteWorkerTransportFaultPoint) => void;
}>;

/**
 * Explicit one-generation authority for creating a missing journal. The caller must only retain
 * and retry this value while the corresponding Cloud reconciliation says this is a fresh
 * installation generation; normal reopen never needs it.
 */
export type NewWorkerJournalAuthorization = Readonly<{
  installationId: string;
  journalGeneration: string;
  authorizationDigest: string;
}>;

export type WorkerTransportPragmas = Readonly<{
  applicationId: number;
  userVersion: number;
  journalMode: string;
  synchronous: number;
  foreignKeys: number;
  secureDelete: number;
  busyTimeoutMs: number;
  pageSize: number;
  maxPageCount: number;
  journalSizeLimit: number;
  walAutocheckpoint: number;
  quickCheck: string;
}>;

type JournalCommitWatermarkBase = Readonly<{
  applicationId: number;
  schemaVersion: number;
  schemaDigest: string;
  authorityDigest: string;
  installationId: string;
  journalGeneration: string;
  authorizationDigest: string;
  commitEpoch: number;
  inboundEvidenceCount: number;
  inboundEvidenceXor: string;
  outboxEvidenceCount: number;
  outboxEvidenceXor: string;
  maxDatabaseBytes: number;
  maxWalBytes: number;
  minFreeBytes: number;
}>;

type LegacyJournalCommitWatermark = JournalCommitWatermarkBase &
  Readonly<{
    formatVersion: 1;
  }>;

type CurrentConnectionAuthority = Readonly<{
  installationId: string;
  connectionId: string;
  connectionDigest: string;
}>;

type JournalCommitWatermark = JournalCommitWatermarkBase &
  Readonly<{
    formatVersion: 2;
    evidenceVersion: 2;
    schemaVersion: 4 | 5;
    currentConnectionAuthority: CurrentConnectionAuthority | null;
  }>;

type AnyJournalCommitWatermark = LegacyJournalCommitWatermark | JournalCommitWatermark;

type MigrationRecoveryManifest = Readonly<{
  formatVersion: 1;
  nonce: string;
  legacySlot: Readonly<{
    schemaVersion: 3 | 4;
    commitEpoch: number;
    watermark: AnyJournalCommitWatermark;
  }>;
  candidateSlot: Readonly<{
    schemaVersion: 4 | 5;
    commitEpoch: number;
    watermark: JournalCommitWatermark;
  }> | null;
  finalizedSlot: Readonly<{
    schemaVersion: 4 | 5;
    commitEpoch: number;
    candidateDigest: string;
  }> | null;
}>;

export type DurableInboundCommandCandidate = Readonly<{
  connectionId: string;
  sequence: string;
  messageId: string;
  type: BrokerCommand['type'];
  canonicalDigest: string;
  effectState: 'PERSISTED';
}>;

type ConnectionRow = {
  installation_id: string;
  connection_id: string;
  owner_epoch: number;
  worker_session_id: string;
  deployment_id: string;
  lease_id: string;
  fence: string;
  lease_state: 'ACTIVE' | 'REVOKED';
  lease_granted_at: string;
  lease_expires_at: string;
  inbound_cursor: string;
  outbound_cursor: string;
  status: 'ACTIVE' | 'RELEASED';
  activation_message_id: string;
  activation_digest: string;
  connection_digest: string;
  created_at_ms: number;
  released_at_ms: number | null;
};

type StoredConnectionAuthorityRow = Pick<
  ConnectionRow,
  'installation_id' | 'connection_id' | 'deployment_id' | 'worker_session_id' | 'lease_id' | 'fence'
>;

type OutboxRow = {
  message_id: string;
  installation_id: string;
  connection_id: string | null;
  sequence: string | null;
  canonical_digest: string;
  envelope_json: string;
  envelope_type: string;
  response_to_message_id: string | null;
  state: 'UNBOUND' | 'PENDING' | 'WRITTEN' | 'ACKED' | 'SUPERSEDED';
  delivery_digest: string;
  ack_level: 'RECEIVED' | 'PERSISTED' | 'CLOUD_COMMITTED' | null;
};

type CountRow = { count: number };

type InboundEffectRow = {
  connection_id: string;
  sequence: string;
  message_id: string;
  canonical_digest: string;
  logical_digest: string;
  effect_state: 'PERSISTED' | 'APPLIED';
  effect_digest: string;
  replay_count: number;
  recorded_at_ms: number;
  applied_at_ms: number | null;
  retained_until_ms: number | null;
};

type InboundEffectEventRow = {
  event_id: number;
  connection_id: string;
  sequence: string;
  message_id: string;
  from_state: 'PERSISTED' | 'APPLIED' | null;
  to_state: 'PERSISTED' | 'APPLIED';
  reason: 'RECORDED' | 'DEDUPLICATED';
  occurred_at_ms: number;
  event_digest: string;
};

type OutboxDeliveryRow = OutboxRow & {
  delivery_digest: string;
  created_at_ms: number;
  updated_at_ms: number;
  acked_at_ms: number | null;
  retained_until_ms: number | null;
};

const SCHEMA_SQL = `
  CREATE TABLE transport_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_digest TEXT NOT NULL,
    authority_digest TEXT NOT NULL,
    installation_id TEXT NOT NULL REFERENCES transport_installations(installation_id),
    journal_generation TEXT NOT NULL,
    authorization_digest TEXT NOT NULL,
    inbound_evidence_count INTEGER NOT NULL CHECK (inbound_evidence_count >= 0),
    inbound_evidence_xor TEXT NOT NULL,
    outbox_evidence_count INTEGER NOT NULL CHECK (outbox_evidence_count >= 0),
    outbox_evidence_xor TEXT NOT NULL,
    max_database_bytes INTEGER NOT NULL CHECK (max_database_bytes >= 8388608),
    max_wal_bytes INTEGER NOT NULL CHECK (max_wal_bytes >= 1048576),
    min_free_bytes INTEGER NOT NULL CHECK (min_free_bytes >= 0),
    commit_epoch INTEGER NOT NULL CHECK (commit_epoch >= 1),
    created_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE transport_installations (
    installation_id TEXT PRIMARY KEY,
    highest_owner_epoch INTEGER NOT NULL DEFAULT 0 CHECK (highest_owner_epoch >= 0),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE transport_installation_owners (
    installation_id TEXT PRIMARY KEY REFERENCES transport_installations(installation_id),
    owner_token_digest TEXT NOT NULL,
    owner_epoch INTEGER NOT NULL CHECK (owner_epoch >= 1),
    lease_expires_at_ms INTEGER NOT NULL,
    acquired_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE transport_connections (
    connection_id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES transport_installations(installation_id),
    owner_epoch INTEGER NOT NULL,
    worker_session_id TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    lease_id TEXT NOT NULL,
    fence TEXT NOT NULL,
    lease_state TEXT NOT NULL CHECK (lease_state IN ('ACTIVE', 'REVOKED')),
    lease_granted_at TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    inbound_cursor TEXT NOT NULL,
    outbound_cursor TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RELEASED')),
    activation_message_id TEXT NOT NULL,
    activation_digest TEXT NOT NULL,
    connection_digest TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    released_at_ms INTEGER
  ) STRICT;

  CREATE UNIQUE INDEX transport_one_active_connection
    ON transport_connections(installation_id)
    WHERE status = 'ACTIVE';

  CREATE TABLE transport_deployment_fences (
    installation_id TEXT NOT NULL REFERENCES transport_installations(installation_id),
    deployment_id TEXT NOT NULL,
    highest_fence TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (installation_id, deployment_id)
  ) STRICT;

  CREATE TABLE transport_inbound_frames (
    connection_id TEXT NOT NULL REFERENCES transport_connections(connection_id),
    sequence TEXT NOT NULL,
    message_id TEXT NOT NULL,
    canonical_digest TEXT NOT NULL,
    logical_digest TEXT NOT NULL,
    envelope_json TEXT NOT NULL,
    envelope_kind TEXT NOT NULL CHECK (envelope_kind IN ('command', 'ack')),
    envelope_type TEXT NOT NULL,
    acknowledged_message_id TEXT,
    effect_state TEXT NOT NULL CHECK (effect_state IN ('PERSISTED', 'APPLIED')),
    effect_digest TEXT NOT NULL,
    replay_count INTEGER NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
    recorded_at_ms INTEGER NOT NULL,
    applied_at_ms INTEGER,
    retained_until_ms INTEGER,
    CHECK (
      (effect_state = 'PERSISTED' AND applied_at_ms IS NULL)
      OR (effect_state = 'APPLIED' AND applied_at_ms IS NOT NULL AND retained_until_ms IS NOT NULL)
    ),
    CHECK (
      (envelope_kind = 'ack' AND acknowledged_message_id IS NOT NULL)
      OR (envelope_kind = 'command' AND acknowledged_message_id IS NULL)
    ),
    PRIMARY KEY (connection_id, sequence)
  ) STRICT;

  CREATE INDEX transport_pending_inbound
    ON transport_inbound_frames(connection_id, effect_state, recorded_at_ms);

  CREATE INDEX transport_inbound_retention
    ON transport_inbound_frames(retained_until_ms, connection_id, sequence)
    WHERE effect_state = 'APPLIED' AND retained_until_ms IS NOT NULL;

  CREATE INDEX transport_inbound_message
    ON transport_inbound_frames(message_id, recorded_at_ms);

  CREATE INDEX transport_inbound_acknowledged_message
    ON transport_inbound_frames(acknowledged_message_id, recorded_at_ms)
    WHERE acknowledged_message_id IS NOT NULL;

  CREATE TABLE transport_inbound_effect_events (
    event_id INTEGER PRIMARY KEY,
    connection_id TEXT NOT NULL,
    sequence TEXT NOT NULL,
    message_id TEXT NOT NULL,
    from_state TEXT CHECK (from_state IS NULL OR from_state IN ('PERSISTED', 'APPLIED')),
    to_state TEXT NOT NULL CHECK (to_state IN ('PERSISTED', 'APPLIED')),
    reason TEXT NOT NULL CHECK (reason IN ('RECORDED', 'DEDUPLICATED')),
    occurred_at_ms INTEGER NOT NULL,
    event_digest TEXT NOT NULL,
    FOREIGN KEY (connection_id, sequence)
      REFERENCES transport_inbound_frames(connection_id, sequence) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX transport_inbound_effect_event_order
    ON transport_inbound_effect_events(connection_id, sequence, event_id);

  CREATE TABLE transport_outbox (
    message_id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES transport_installations(installation_id),
    connection_id TEXT REFERENCES transport_connections(connection_id),
    sequence TEXT,
    canonical_digest TEXT NOT NULL,
    envelope_json TEXT NOT NULL,
    envelope_type TEXT NOT NULL,
    response_to_message_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('UNBOUND', 'PENDING', 'WRITTEN', 'ACKED', 'SUPERSEDED')),
    delivery_digest TEXT NOT NULL,
    ack_level TEXT CHECK (ack_level IS NULL OR ack_level IN ('RECEIVED', 'PERSISTED', 'CLOUD_COMMITTED')),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    acked_at_ms INTEGER,
    retained_until_ms INTEGER,
    CHECK (
      (state = 'UNBOUND' AND connection_id IS NULL AND sequence IS NULL)
      OR (state <> 'UNBOUND' AND connection_id IS NOT NULL AND sequence IS NOT NULL)
    ),
    CHECK (
      (state = 'ACKED' AND ack_level = 'CLOUD_COMMITTED'
        AND acked_at_ms IS NOT NULL AND retained_until_ms IS NOT NULL)
      OR (state = 'SUPERSEDED' AND (ack_level IS NULL OR ack_level <> 'CLOUD_COMMITTED')
        AND acked_at_ms IS NULL AND retained_until_ms IS NOT NULL)
      OR (state NOT IN ('ACKED', 'SUPERSEDED')
        AND (ack_level IS NULL OR ack_level <> 'CLOUD_COMMITTED')
        AND acked_at_ms IS NULL AND retained_until_ms IS NULL)
    )
  ) STRICT;

  CREATE UNIQUE INDEX transport_outbox_connection_sequence
    ON transport_outbox(connection_id, sequence)
    WHERE connection_id IS NOT NULL;

  CREATE UNIQUE INDEX transport_outbox_persisted_response
    ON transport_outbox(response_to_message_id)
    WHERE response_to_message_id IS NOT NULL;

  CREATE INDEX transport_outbox_delivery
    ON transport_outbox(installation_id, connection_id, state, created_at_ms);

  CREATE INDEX transport_outbox_retention
    ON transport_outbox(retained_until_ms, message_id)
    WHERE state IN ('ACKED', 'SUPERSEDED') AND retained_until_ms IS NOT NULL;

  CREATE TABLE transport_sequence_gaps (
    id INTEGER PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES transport_installations(installation_id),
    connection_id TEXT NOT NULL REFERENCES transport_connections(connection_id),
    expected_sequence TEXT NOT NULL,
    received_sequence TEXT NOT NULL,
    occurrence_count INTEGER NOT NULL CHECK (occurrence_count >= 1),
    first_seen_at_ms INTEGER NOT NULL,
    last_seen_at_ms INTEGER NOT NULL,
    retained_until_ms INTEGER NOT NULL,
    UNIQUE (connection_id, expected_sequence, received_sequence)
  ) STRICT;

  CREATE INDEX transport_sequence_gap_retention
    ON transport_sequence_gaps(retained_until_ms, id);

  CREATE INDEX transport_connection_retention
    ON transport_connections(released_at_ms, connection_id)
    WHERE status = 'RELEASED' AND released_at_ms IS NOT NULL;
`;

/**
 * File-backed Worker Broker transport authority. It only persists protocol envelopes, whose
 * sensitive Prompt/delta/final fields are already protocol-mandated AEAD bytes. It never accepts
 * a plaintext Prompt/answer API and never emits row bodies to diagnostics.
 */
export class SqliteWorkerBrokerDurableTransport implements WorkerBrokerDurableTransportPort {
  readonly #filename: string;
  readonly #watermarkFilename: string;
  readonly #migrationRecoveryFilename: string;
  readonly #recoveryReserveFilename: string;
  readonly #database: DatabaseSync;
  readonly #newJournalAuthorization?: NewWorkerJournalAuthorization;
  readonly #busyTimeoutMs: number;
  readonly #ownerLeaseMs: number;
  readonly #operationTimeoutMs: number;
  readonly #maxConnections: number;
  readonly #maxInboundRows: number;
  readonly #maxOutboxRows: number;
  readonly #maxRetainedInboundRows: number;
  readonly #maxRetainedOutboxRows: number;
  readonly #maxSequenceGapRows: number;
  readonly #maxDatabaseBytes: number;
  readonly #maxWalBytes: number;
  readonly #minFreeBytes: number;
  readonly #availableFilesystemBytes: () => number;
  readonly #now: () => number;
  readonly #faultInjector?: (point: SqliteWorkerTransportFaultPoint) => void;
  #transactionDeadline = Number.POSITIVE_INFINITY;
  #walQuotaProtection = false;
  #recoveryReserveReleased = false;
  #sensitivePurgePending = false;
  #poisoned = false;
  #closed = false;

  constructor(options: SqliteWorkerTransportOptions) {
    this.#filename = validateJournalPath(options.filename);
    this.#watermarkFilename = `${this.#filename}.watermark`;
    this.#migrationRecoveryFilename = `${this.#filename}.migration-recovery`;
    this.#recoveryReserveFilename = `${this.#filename}.recovery-reserve`;
    this.#newJournalAuthorization = parseNewJournalAuthorization(options.newJournalAuthorization);
    this.#busyTimeoutMs = bounded(options.busyTimeoutMs ?? 1_000, 1, 5_000);
    this.#operationTimeoutMs = bounded(
      options.operationTimeoutMs ?? this.#busyTimeoutMs,
      1,
      30_000,
    );
    this.#ownerLeaseMs = bounded(
      options.ownerLeaseMs ?? 60_000,
      options.allowUnsafeShortOwnerLeaseForTests === true ? 100 : 60_000,
      300_000,
    );
    this.#maxConnections = bounded(options.maxConnections ?? 1_024, 2, 10_000);
    this.#maxInboundRows = bounded(
      options.maxInboundRows ?? WORKER_TRANSPORT_DEFAULT_MAX_INBOUND_ROWS,
      16,
      WORKER_TRANSPORT_SEQUENCE_RETENTION,
    );
    this.#maxOutboxRows = bounded(
      options.maxOutboxRows ?? WORKER_TRANSPORT_DEFAULT_MAX_OUTBOX_ROWS,
      8,
      WORKER_TRANSPORT_SEQUENCE_RETENTION,
    );
    this.#maxRetainedInboundRows = bounded(
      options.maxRetainedInboundRows ?? WORKER_TRANSPORT_DEFAULT_MAX_RETAINED_INBOUND_ROWS,
      this.#maxInboundRows,
      10_000_000,
    );
    this.#maxRetainedOutboxRows = bounded(
      options.maxRetainedOutboxRows ?? WORKER_TRANSPORT_DEFAULT_MAX_RETAINED_OUTBOX_ROWS,
      this.#maxOutboxRows,
      10_000_000,
    );
    this.#maxSequenceGapRows = bounded(options.maxSequenceGapRows ?? 1_024, 1, 10_000);
    this.#maxDatabaseBytes = bounded(
      options.maxDatabaseBytes ?? WORKER_TRANSPORT_DEFAULT_MAX_DATABASE_BYTES,
      8 * 1024 * 1024,
      4 * 1024 * 1024 * 1024,
    );
    this.#maxWalBytes = bounded(
      options.maxWalBytes ?? WORKER_TRANSPORT_DEFAULT_MAX_WAL_BYTES,
      1024 * 1024,
      WORKER_TRANSPORT_DEFAULT_MAX_WAL_BYTES,
    );
    this.#minFreeBytes = bounded(
      options.minFreeBytes ?? WORKER_TRANSPORT_DEFAULT_MIN_FREE_BYTES,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    this.#availableFilesystemBytes =
      options.availableFilesystemBytesForTests ??
      (() => availableFilesystemBytes(dirname(this.#filename)));
    this.#now = options.now ?? Date.now;
    this.#faultInjector = options.faultInjector;

    ensureSafeParent(dirname(this.#filename));
    cleanupSafeAtomicTemps(this.#migrationRecoveryFilename);
    let existed = journalEntryExists(this.#filename);
    if (!existed && journalEntryExists(this.#migrationRecoveryFilename)) {
      ensureSafeRegularFile(this.#migrationRecoveryFilename, 0o600, 'JOURNAL_FILE_UNSAFE');
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
    if (!existed && this.#newJournalAuthorization === undefined) {
      throw new SqliteWorkerTransportError('JOURNAL_MISSING');
    }
    if (!existed && safeRegularFileExists(this.#watermarkFilename, 0o600, 'JOURNAL_FILE_UNSAFE')) {
      // A watermark with no database proves loss and must never authorize recreation. Re-sample
      // the database once because a concurrent authorized first-open publishes the database before
      // its watermark; seeing both means this opener should join validation as an existing file.
      if (!safeRegularFileExists(this.#filename, 0o600, 'JOURNAL_FILE_UNSAFE')) {
        throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
      }
      existed = true;
    }
    assertSafeExistingAuxiliaryFiles(this.#filename, this.#busyTimeoutMs);
    if (!existed) {
      try {
        closeSync(openSync(this.#filename, 'wx', 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new SqliteWorkerTransportError('JOURNAL_FILE_UNSAFE');
        }
        existed = true;
      }
    }
    if (existed) {
      ensureSafeRegularFile(this.#filename, 0o600, 'JOURNAL_FILE_UNSAFE');
    }

    try {
      this.#database = new (loadNodeSqlite().DatabaseSync)(this.#filename);
    } catch {
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }

    try {
      this.#configureWithBusyRetry(existed);
      this.#validateOpenSnapshot();
      // Reserve provisioning has no durable logical rows: a fill/delete transaction leaves real
      // SQLite freelist pages, while the private sidecar occupies filesystem blocks that can be
      // released before a terminal/reconciliation transaction writes its WAL and watermark.
      // It runs only after the existing authority/watermark is validated, so a corrupt journal is
      // never modified in an attempt to manufacture reserve. Failure to replenish is not an open
      // failure; it switches this adapter to reconciliation-only admission until capacity returns.
      this.#ensureDatabaseRecoveryReserve();
      this.#ensureFilesystemRecoveryReserve();
      // A previous process can have committed a sensitive-row purge while a pinned reader kept
      // the deleted Broker session ciphertext in WAL pages. Snapshot validation proves the
      // logical state, but the adapter must not serve until those request-lifetime bytes are
      // physically truncated. A still-pinned reader therefore makes open fail closed.
      this.#forceSensitiveCheckpoint();
      this.#secureJournalFiles();
    } catch (error) {
      this.#database.close();
      throw normalizeOpenError(error);
    }
  }

  async acquireInstallation(input: {
    installationId: string;
    ownerToken: string;
    signal: AbortSignal;
  }): Promise<boolean> {
    const installationId = parseUuid(input.installationId);
    const ownerDigest = ownerTokenDigest(input.ownerToken);
    return this.#transaction('acquire_installation', input.signal, () => {
      const provisioned = this.#database
        .prepare('SELECT installation_id FROM transport_meta WHERE singleton = 1')
        .get() as { installation_id: string } | undefined;
      if (provisioned?.installation_id !== installationId) throw permanentPortFailure();
      const now = this.#clock();
      const existingInstallation = this.#database
        .prepare('SELECT installation_id FROM transport_installations LIMIT 1')
        .get() as { installation_id: string } | undefined;
      if (
        existingInstallation !== undefined &&
        existingInstallation.installation_id !== installationId
      ) {
        throw permanentPortFailure();
      }
      this.#database
        .prepare(
          `INSERT INTO transport_installations(
             installation_id, highest_owner_epoch, created_at_ms, updated_at_ms
           ) VALUES (?, 0, ?, ?)
           ON CONFLICT(installation_id) DO UPDATE SET updated_at_ms = excluded.updated_at_ms`,
        )
        .run(installationId, now, now);
      const existing = this.#database
        .prepare(
          `SELECT owner_token_digest, owner_epoch, lease_expires_at_ms
           FROM transport_installation_owners WHERE installation_id = ?`,
        )
        .get(installationId) as
        | { owner_token_digest: string; owner_epoch: number; lease_expires_at_ms: number }
        | undefined;
      if (
        existing !== undefined &&
        existing.lease_expires_at_ms > now &&
        !constantTimeTextEqual(existing.owner_token_digest, ownerDigest)
      ) {
        return false;
      }
      if (
        existing !== undefined &&
        constantTimeTextEqual(existing.owner_token_digest, ownerDigest)
      ) {
        this.#database
          .prepare(
            `UPDATE transport_installation_owners
             SET lease_expires_at_ms = ?, updated_at_ms = ?
             WHERE installation_id = ? AND owner_token_digest = ?`,
          )
          .run(safeDeadline(now, this.#ownerLeaseMs), now, installationId, ownerDigest);
        this.#refreshAuthorityDigest();
        return true;
      }
      const installation = this.#database
        .prepare(
          'SELECT highest_owner_epoch FROM transport_installations WHERE installation_id = ?',
        )
        .get(installationId) as { highest_owner_epoch: number } | undefined;
      if (installation === undefined) throw permanentPortFailure();
      const nextEpoch = installation.highest_owner_epoch + 1;
      this.#database
        .prepare(
          `UPDATE transport_installations SET highest_owner_epoch = ?, updated_at_ms = ?
           WHERE installation_id = ? AND highest_owner_epoch = ?`,
        )
        .run(nextEpoch, now, installationId, installation.highest_owner_epoch);
      this.#database
        .prepare(
          `INSERT INTO transport_installation_owners(
             installation_id, owner_token_digest, owner_epoch, lease_expires_at_ms,
             acquired_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(installation_id) DO UPDATE SET
             owner_token_digest = excluded.owner_token_digest,
             owner_epoch = excluded.owner_epoch,
             lease_expires_at_ms = excluded.lease_expires_at_ms,
             acquired_at_ms = excluded.acquired_at_ms,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(
          installationId,
          ownerDigest,
          nextEpoch,
          safeDeadline(now, this.#ownerLeaseMs),
          now,
          now,
        );
      this.#refreshAuthorityDigest();
      return true;
    });
  }

  async releaseInstallation(input: {
    installationId: string;
    ownerToken: string;
    signal: AbortSignal;
  }): Promise<void> {
    const installationId = parseUuid(input.installationId);
    const ownerDigest = ownerTokenDigest(input.ownerToken);
    this.#transaction('release_installation', input.signal, () => {
      const now = this.#clock();
      const result = this.#database
        .prepare(
          `DELETE FROM transport_installation_owners
           WHERE installation_id = ? AND owner_token_digest = ?`,
        )
        .run(installationId, ownerDigest);
      if (Number(result.changes) === 0) {
        const existing = this.#database
          .prepare(
            'SELECT 1 AS present FROM transport_installation_owners WHERE installation_id = ?',
          )
          .get(installationId);
        if (existing !== undefined) throw permanentPortFailure();
        const activeWithoutOwner = this.#database
          .prepare(
            `SELECT 1 AS present FROM transport_connections
             WHERE installation_id = ? AND status = 'ACTIVE' LIMIT 1`,
          )
          .get(installationId);
        if (activeWithoutOwner !== undefined) throw permanentPortFailure();
        return;
      }
      const active = this.#database
        .prepare(
          `SELECT connection_id FROM transport_connections
           WHERE installation_id = ? AND status = 'ACTIVE'`,
        )
        .all(installationId) as Array<{ connection_id: string }>;
      for (const row of active) this.#retireConnection(row.connection_id, now);
      this.#refreshAuthorityDigest();
    });
  }

  async activateConnection(input: {
    installationId: string;
    ownerToken: string;
    envelope: LeaseGrantCommand;
    canonicalDigest: string;
    inboundCursor: string;
    signal: AbortSignal;
  }): Promise<DurableBrokerConnection> {
    const installationId = parseUuid(input.installationId);
    const envelope = parseLeaseGrant(input.envelope);
    const digest = assertCanonicalDigest(envelope, input.canonicalDigest);
    assertActivationCursor(envelope, digest, input.inboundCursor);
    return this.#transaction('activate_connection', input.signal, () => {
      const { ownerEpoch, now } = this.#assertAndRefreshOwner(installationId, input.ownerToken);
      const prior = this.#connectionRow(envelope.connectionId);
      if (prior !== undefined) {
        if (
          prior.status === 'ACTIVE' &&
          prior.installation_id === installationId &&
          prior.owner_epoch === ownerEpoch &&
          prior.activation_message_id === envelope.messageId &&
          prior.activation_digest === digest &&
          prior.inbound_cursor === input.inboundCursor
        ) {
          return durableConnection(prior);
        }
        throw new WorkerBrokerClientError('STALE_CONNECTION', true);
      }
      this.#pruneExpiredRows(now);
      const active = this.#database
        .prepare(
          `SELECT connection_id FROM transport_connections
           WHERE installation_id = ? AND status = 'ACTIVE'`,
        )
        .get(installationId) as { connection_id: string } | undefined;
      if (active !== undefined) this.#retireConnection(active.connection_id, now);
      // Admission counts every retained connection. Retiring a clean active connection first lets
      // it disappear without consuming history capacity; any later failure rolls the retirement
      // back with this activation transaction.
      this.#assertCapacity('transport_connections', this.#maxConnections);
      const fenceWatermark = this.#database
        .prepare(
          `SELECT highest_fence FROM transport_deployment_fences
           WHERE installation_id = ? AND deployment_id = ?`,
        )
        .get(installationId, envelope.lease.deploymentId) as { highest_fence: string } | undefined;
      const nextFence = BigInt(envelope.lease.fence);
      if (
        fenceWatermark !== undefined &&
        nextFence <= BigInt(parseUint63(fenceWatermark.highest_fence))
      ) {
        throw new WorkerBrokerClientError('STALE_FENCE', true);
      }
      this.#database
        .prepare(
          `INSERT INTO transport_deployment_fences(
             installation_id, deployment_id, highest_fence, updated_at_ms
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT(installation_id, deployment_id) DO UPDATE SET
             highest_fence = excluded.highest_fence,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(installationId, envelope.lease.deploymentId, envelope.lease.fence, now);
      this.#refreshAuthorityDigest();

      const outboundCursor = serializeSequenceCursor(
        initialSequenceCursor(envelope.connectionId, WORKER_TRANSPORT_SEQUENCE_RETENTION),
      );
      const connectionDigest = connectionStateDigest({
        installationId,
        connectionId: envelope.connectionId,
        ownerEpoch,
        workerSessionId: envelope.lease.workerSessionId,
        deploymentId: envelope.lease.deploymentId,
        leaseId: envelope.lease.leaseId,
        fence: envelope.lease.fence,
        leaseState: 'ACTIVE',
        leaseGrantedAt: envelope.sentAt,
        leaseExpiresAt: envelope.body.leaseExpiresAt,
        inboundCursor: input.inboundCursor,
        outboundCursor,
        status: 'ACTIVE',
        activationMessageId: envelope.messageId,
        activationDigest: digest,
        createdAtMs: now,
        releasedAtMs: null,
      });
      this.#database
        .prepare(
          `INSERT INTO transport_connections(
             connection_id, installation_id, owner_epoch, worker_session_id, deployment_id,
             lease_id, fence, lease_state, lease_granted_at, lease_expires_at,
             inbound_cursor, outbound_cursor, status, activation_message_id,
             activation_digest, connection_digest, created_at_ms, released_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, NULL)`,
        )
        .run(
          envelope.connectionId,
          installationId,
          ownerEpoch,
          envelope.lease.workerSessionId,
          envelope.lease.deploymentId,
          envelope.lease.leaseId,
          envelope.lease.fence,
          envelope.sentAt,
          envelope.body.leaseExpiresAt,
          input.inboundCursor,
          outboundCursor,
          envelope.messageId,
          digest,
          connectionDigest,
          now,
        );
      this.#insertInbound(envelope, digest, 'APPLIED', now);
      this.#reframeUnacknowledged(installationId, envelope.connectionId, now);
      this.#enqueueLeaseEvent('lease.accepted', envelope.connectionId, envelope.messageId, now);
      return durableConnection(
        this.#requireActiveConnection(installationId, envelope.connectionId, ownerEpoch),
      );
    });
  }

  async loadConnection(input: {
    installationId: string;
    ownerToken: string;
    connectionId: string;
    signal: AbortSignal;
  }): Promise<DurableBrokerConnection | null> {
    const installationId = parseUuid(input.installationId);
    const connectionId = parseUuid(input.connectionId);
    return this.#transaction('load_connection', input.signal, () => {
      const { ownerEpoch } = this.#assertAndRefreshOwner(installationId, input.ownerToken);
      const row = this.#connectionRow(connectionId);
      if (row === undefined || row.status !== 'ACTIVE') return null;
      if (row.installation_id !== installationId || row.owner_epoch !== ownerEpoch) {
        throw permanentPortFailure();
      }
      return durableConnection(row);
    });
  }

  async loadOwnedActiveConnection(input: {
    installationId: string;
    ownerToken: string;
    signal: AbortSignal;
  }): Promise<DurableBrokerConnection | null> {
    const installationId = parseUuid(input.installationId);
    return this.#transaction('load_owned_active_connection', input.signal, () => {
      const { ownerEpoch } = this.#assertAndRefreshOwner(installationId, input.ownerToken);
      const rows = this.#database
        .prepare(
          `SELECT connection_id FROM transport_connections
           WHERE installation_id = ? AND owner_epoch = ? AND status = 'ACTIVE'
           ORDER BY connection_id LIMIT 2`,
        )
        .all(installationId, ownerEpoch) as Array<{ connection_id: string }>;
      if (rows.length > 1) throw permanentPortFailure();
      const connectionId = rows[0]?.connection_id;
      if (connectionId === undefined) return null;
      return durableConnection(
        this.#requireActiveConnection(installationId, connectionId, ownerEpoch),
      );
    });
  }

  async commitInbound(input: {
    installationId: string;
    ownerToken: string;
    connectionId: string;
    expectedInboundCursor: string;
    nextInboundCursor: string;
    envelope: BrokerEnvelope;
    canonicalDigest: string;
    signal: AbortSignal;
  }): Promise<DurableBrokerConnection> {
    const installationId = parseUuid(input.installationId);
    const connectionId = parseUuid(input.connectionId);
    const envelope = BrokerEnvelopeSchema.parse(input.envelope);
    if (envelope.kind === 'event' || envelope.connectionId !== connectionId) {
      throw permanentPortFailure();
    }
    const digest = assertCanonicalDigest(envelope, input.canonicalDigest);
    assertCursorAdvance(input.expectedInboundCursor, input.nextInboundCursor, envelope, digest);
    return this.#transaction(
      envelope.kind === 'ack' ? 'commit_inbound_reconciliation' : 'commit_inbound',
      input.signal,
      () => {
        const { now, ownerEpoch } = this.#assertAndRefreshOwner(installationId, input.ownerToken);
        const connection = this.#requireActiveConnection(installationId, connectionId, ownerEpoch);
        if (connection.inbound_cursor !== input.expectedInboundCursor) {
          throw new WorkerBrokerClientError('SEQUENCE_CONFLICT', true);
        }
        assertInboundLease(connection, envelope);
        const duplicateEffect = this.#insertInbound(
          envelope,
          digest,
          envelope.kind === 'ack' || isTransportControlCommand(envelope) ? 'APPLIED' : 'PERSISTED',
          now,
        );
        this.#database
          .prepare('UPDATE transport_connections SET inbound_cursor = ? WHERE connection_id = ?')
          .run(input.nextInboundCursor, connectionId);
        this.#refreshConnectionDigest(connectionId);
        const compactReadyAckReplay =
          duplicateEffect &&
          envelope.kind === 'ack' &&
          workerConversationReadyTablesExist(this.#database) &&
          this.#database
            .prepare(
              `SELECT 1 AS present FROM local_conversation_ready_terminal_tombstones
               WHERE ack_message_id = ?`,
            )
            .get(envelope.messageId) !== undefined;
        if (!duplicateEffect || compactReadyAckReplay) {
          this.#applyInboundEffect(envelope, connection, now);
        }
        if (duplicateEffect) {
          this.#reactivateReplayResponse(installationId, connectionId, envelope.messageId, now);
        }
        return durableConnection(
          this.#requireActiveConnection(installationId, connectionId, ownerEpoch),
        );
      },
    );
  }

  async replayInbound(input: {
    installationId: string;
    ownerToken: string;
    connectionId: string;
    envelope: BrokerEnvelope;
    canonicalDigest: string;
    signal: AbortSignal;
  }): Promise<'EXACT_REPLAY' | 'NOT_FOUND'> {
    const installationId = parseUuid(input.installationId);
    const connectionId = parseUuid(input.connectionId);
    const envelope = BrokerEnvelopeSchema.parse(input.envelope);
    if (envelope.kind === 'event' || envelope.connectionId !== connectionId) {
      throw permanentPortFailure();
    }
    const digest = assertCanonicalDigest(envelope, input.canonicalDigest);
    return this.#transaction(
      envelope.kind === 'ack' ? 'replay_inbound_reconciliation' : 'replay_inbound',
      input.signal,
      () => {
        const { now, ownerEpoch } = this.#assertAndRefreshOwner(installationId, input.ownerToken);
        const connection = this.#requireActiveConnection(installationId, connectionId, ownerEpoch);
        assertInboundLease(connection, envelope);
        const existing = this.#database
          .prepare(
            `SELECT message_id, canonical_digest, logical_digest, envelope_json
           FROM transport_inbound_frames WHERE connection_id = ? AND sequence = ?`,
          )
          .get(connectionId, envelope.sequence) as
          | {
              message_id: string;
              canonical_digest: string;
              logical_digest: string;
              envelope_json: string;
            }
          | undefined;
        if (existing === undefined) {
          const priorMessage = this.#database
            .prepare(
              `SELECT logical_digest FROM transport_inbound_frames
             WHERE message_id = ? ORDER BY recorded_at_ms LIMIT 1`,
            )
            .get(envelope.messageId) as { logical_digest: string } | undefined;
          if (
            priorMessage !== undefined &&
            priorMessage.logical_digest !== logicalEnvelopeDigest(envelope)
          ) {
            throw new WorkerBrokerClientError('SEQUENCE_CONFLICT', true);
          }
          return 'NOT_FOUND';
        }
        if (
          existing.message_id !== envelope.messageId ||
          existing.canonical_digest !== digest ||
          existing.logical_digest !== logicalEnvelopeDigest(envelope) ||
          existing.envelope_json !== canonicalizeJson(envelope)
        ) {
          throw new WorkerBrokerClientError('SEQUENCE_CONFLICT', true);
        }
        const previousEffect = this.#inboundEffectRow(connectionId, envelope.sequence);
        if (previousEffect === undefined) throw permanentPortFailure();
        this.#database
          .prepare(
            `UPDATE transport_inbound_frames
           SET replay_count = replay_count + 1, retained_until_ms = COALESCE(retained_until_ms, ?)
           WHERE connection_id = ? AND sequence = ?`,
          )
          .run(safeDeadline(now, WORKER_TRANSPORT_RETENTION_MS), connectionId, envelope.sequence);
        this.#refreshInboundEffectDigest(connectionId, envelope.sequence, previousEffect);
        this.#reactivateReplayResponse(installationId, connectionId, envelope.messageId, now);
        return 'EXACT_REPLAY';
      },
    );
  }

  async recordSequenceGap(input: {
    installationId: string;
    ownerToken: string;
    connectionId: string;
    expected: string;
    received: string;
    signal: AbortSignal;
  }): Promise<void> {
    const installationId = parseUuid(input.installationId);
    const connectionId = parseUuid(input.connectionId);
    const expected = parseUint63(input.expected);
    const received = parseUint63(input.received);
    this.#transaction('record_sequence_gap', input.signal, () => {
      const { now, ownerEpoch } = this.#assertAndRefreshOwner(installationId, input.ownerToken);
      this.#requireActiveConnection(installationId, connectionId, ownerEpoch);
      this.#pruneExpiredRows(now);
      const existing = this.#database
        .prepare(
          `SELECT id FROM transport_sequence_gaps
           WHERE connection_id = ? AND expected_sequence = ? AND received_sequence = ?`,
        )
        .get(connectionId, expected, received);
      if (existing === undefined) {
        this.#assertCapacity('transport_sequence_gaps', this.#maxSequenceGapRows);
      }
      this.#database
        .prepare(
          `INSERT INTO transport_sequence_gaps(
             installation_id, connection_id, expected_sequence, received_sequence,
             occurrence_count, first_seen_at_ms, last_seen_at_ms, retained_until_ms
           ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
           ON CONFLICT(connection_id, expected_sequence, received_sequence) DO UPDATE SET
             occurrence_count = occurrence_count + 1,
             last_seen_at_ms = excluded.last_seen_at_ms,
             retained_until_ms = excluded.retained_until_ms`,
        )
        .run(
          installationId,
          connectionId,
          expected,
          received,
          now,
          now,
          safeDeadline(now, WORKER_TRANSPORT_RETENTION_MS),
        );
    });
  }

  async enqueueHeartbeat(input: {
    installationId: string;
    ownerToken: string;
    connectionId: string;
    lease: LeaseBinding;
    cloudLeaseExpiresAt: string;
    signal: AbortSignal;
  }): Promise<void> {
    const installationId = parseUuid(input.installationId);
    const connectionId = parseUuid(input.connectionId);
    const lease = LeaseBindingSchema.parse(input.lease);
    this.#transaction('enqueue_heartbeat', input.signal, () => {
      const { now, ownerEpoch } = this.#assertAndRefreshOwner(installationId, input.ownerToken);
      const connection = this.#requireActiveConnection(installationId, connectionId, ownerEpoch);
      if (
        connection.lease_state !== 'ACTIVE' ||
        !sameLease(leaseFromRow(connection), lease) ||
        connection.lease_expires_at !== input.cloudLeaseExpiresAt
      ) {
        throw new WorkerBrokerClientError('STALE_LEASE', true);
      }
      const outstanding = this.#database
        .prepare(
          `SELECT 1 AS present FROM transport_outbox
           WHERE installation_id = ? AND envelope_type = 'heartbeat'
             AND state IN ('UNBOUND', 'PENDING', 'WRITTEN') LIMIT 1`,
        )
        .get(installationId);
      if (outstanding !== undefined) return;
      this.#enqueueEnvelope(
        connectionId,
        {
          kind: 'event',
          type: 'heartbeat',
          messageId: uuidV7(),
          correlationId: connectionId,
          body: {
            workerSessionId: connection.worker_session_id,
            runtimeReady: true,
            proxyReady: true,
            journalReady: true,
            activeInvocationId: null,
          },
        },
        now,
      );
    });
  }

  async readOutbound(input: {
    installationId: string;
    ownerToken: string;
    connectionId: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<readonly BrokerEnvelope[]> {
    const installationId = parseUuid(input.installationId);
    const connectionId = parseUuid(input.connectionId);
    const limit = bounded(input.limit, 1, 64);
    return this.#transaction('read_outbound', input.signal, () => {
      const { ownerEpoch } = this.#assertAndRefreshOwner(installationId, input.ownerToken);
      this.#requireActiveConnection(installationId, connectionId, ownerEpoch);
      const rows = this.#database
        .prepare(
          `SELECT message_id, sequence, canonical_digest, envelope_json, envelope_type
           FROM transport_outbox
           WHERE installation_id = ? AND connection_id = ? AND state = 'PENDING'
           ORDER BY length(sequence), sequence LIMIT ?`,
        )
        .all(installationId, connectionId, limit) as Array<{
        message_id: string;
        sequence: string;
        canonical_digest: string;
        envelope_json: string;
        envelope_type: string;
      }>;
      return rows.map((row) => {
        const envelope = parseStoredEnvelope(row.envelope_json, row.canonical_digest);
        if (
          envelope.messageId !== row.message_id ||
          envelope.connectionId !== connectionId ||
          envelope.sequence !== row.sequence ||
          envelope.type !== row.envelope_type ||
          envelope.kind === 'command'
        ) {
          throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
        }
        return envelope;
      });
    });
  }

  async markOutboundWritten(input: {
    installationId: string;
    ownerToken: string;
    connectionId: string;
    messageId: string;
    canonicalDigest: string;
    signal: AbortSignal;
  }): Promise<void> {
    const installationId = parseUuid(input.installationId);
    const connectionId = parseUuid(input.connectionId);
    const messageId = parseUuid(input.messageId);
    this.#transaction('mark_outbound_written', input.signal, () => {
      const { now, ownerEpoch } = this.#assertAndRefreshOwner(installationId, input.ownerToken);
      this.#requireActiveConnection(installationId, connectionId, ownerEpoch);
      const row = this.#outboxRow(messageId);
      if (
        row === undefined ||
        row.connection_id !== connectionId ||
        row.canonical_digest !== input.canonicalDigest ||
        (row.state !== 'PENDING' && row.state !== 'WRITTEN' && row.state !== 'ACKED')
      ) {
        throw permanentPortFailure();
      }
      if (row.state === 'PENDING') {
        this.#database
          .prepare(
            `UPDATE transport_outbox SET state = 'WRITTEN', updated_at_ms = ?
             WHERE message_id = ? AND state = 'PENDING'`,
          )
          .run(now, messageId);
        this.#refreshOutboxDeliveryDigest(messageId, row);
      }
    });
  }

  async releaseConnection(input: {
    installationId: string;
    ownerToken: string;
    connectionId: string;
    signal: AbortSignal;
  }): Promise<void> {
    const installationId = parseUuid(input.installationId);
    const connectionId = parseUuid(input.connectionId);
    this.#transaction('release_connection', input.signal, () => {
      const { now, ownerEpoch } = this.#assertAndRefreshOwner(installationId, input.ownerToken);
      const row = this.#connectionRow(connectionId);
      if (row === undefined) return;
      if (row.installation_id !== installationId || row.owner_epoch !== ownerEpoch) {
        throw permanentPortFailure();
      }
      if (row.status === 'RELEASED') return;
      this.#retireConnection(connectionId, now);
    });
  }

  /**
   * Returns opaque persisted-command references. It deliberately never returns an envelope/body:
   * this transport is not an Invocation/Host dispatch authority. A future Invocation Journal must
   * re-read and verify the exact prepare/start chain, Cloud capability and time authority inside
   * its own atomic authorization boundary before exposing any Host input.
   */
  async readPendingCommands(input: {
    installationId: string;
    ownerToken: string;
    connectionId: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<readonly DurableInboundCommandCandidate[]> {
    const installationId = parseUuid(input.installationId);
    const connectionId = parseUuid(input.connectionId);
    const limit = bounded(input.limit, 1, 64);
    return this.#transaction('read_pending_commands', input.signal, () => {
      const { ownerEpoch } = this.#assertAndRefreshOwner(installationId, input.ownerToken);
      const connection = this.#requireActiveConnection(installationId, connectionId, ownerEpoch);
      if (connection.lease_state !== 'ACTIVE') {
        throw new WorkerBrokerClientError('STALE_LEASE', true);
      }
      const rows = this.#database
        .prepare(
          `SELECT f.connection_id, f.sequence, f.message_id, f.canonical_digest,
                  f.logical_digest, f.envelope_json, f.effect_state,
                  lc.semantic_digest AS consumed_semantic_digest
           FROM transport_inbound_frames AS f
           JOIN transport_connections AS c ON c.connection_id = f.connection_id
           LEFT JOIN local_consumed_commands AS lc ON lc.command_id = f.message_id
           WHERE c.installation_id = ? AND f.envelope_kind = 'command'
             AND c.owner_epoch = ? AND f.connection_id = ? AND f.effect_state = 'PERSISTED'
             AND (
               lc.command_id IS NULL OR
               f.envelope_type IN (
                 'conversation.open', 'invocation.prepare', 'invocation.start', 'invocation.cancel'
               )
             )
           ORDER BY f.recorded_at_ms, length(f.sequence), f.sequence LIMIT ?`,
        )
        .all(installationId, ownerEpoch, connectionId, limit) as Array<{
        connection_id: string;
        sequence: string;
        message_id: string;
        canonical_digest: string;
        logical_digest: string;
        envelope_json: string;
        effect_state: 'PERSISTED';
        consumed_semantic_digest: string | null;
      }>;
      return rows.map((row) => {
        const stored = decodeStoredBrokerEnvelope(row.envelope_json, row.canonical_digest);
        const conversations =
          stored.envelope.type === 'conversation.open'
            ? (this.#database
                .prepare(
                  `SELECT * FROM local_conversations
                   WHERE conversation_id = ? OR open_command_id = ?
                   ORDER BY conversation_id`,
                )
                .all(stored.envelope.body.conversationId, stored.envelope.messageId) as Array<
                Record<string, unknown>
              >)
            : [];
        if (conversations.length > 1) {
          throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
        }
        const envelope = materializeStoredInboundEnvelope(
          stored,
          connection,
          conversations[0],
          row.consumed_semantic_digest ?? undefined,
        );
        if (
          envelope.kind !== 'command' ||
          envelope.connectionId !== row.connection_id ||
          envelope.sequence !== row.sequence ||
          envelope.messageId !== row.message_id ||
          stored.logicalDigest !== row.logical_digest
        ) {
          throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
        }
        return Object.freeze({
          connectionId: row.connection_id,
          sequence: row.sequence,
          messageId: row.message_id,
          type: envelope.type,
          canonicalDigest: row.canonical_digest,
          effectState: 'PERSISTED' as const,
        });
      });
    });
  }

  async pruneRetained(input: {
    installationId: string;
    ownerToken: string;
    signal: AbortSignal;
  }): Promise<number> {
    const installationId = parseUuid(input.installationId);
    return this.#transaction('prune_retained', input.signal, () => {
      const { now } = this.#assertAndRefreshOwner(installationId, input.ownerToken);
      return this.#pruneExpiredRows(now);
    });
  }

  /**
   * Creates the business-journal facade over this exact DatabaseSync connection. The facade is
   * intentionally unavailable without all signature, Cloud-time, Host-receipt and AEAD ports.
   */
  createInvocationJournal(
    options: SqliteWorkerInvocationJournalOptions,
  ): SqliteWorkerInvocationJournal {
    this.#assertOpen();
    const host: WorkerInvocationJournalHost = {
      transact: (input, operation) => {
        const installationId = parseUuid(input.installationId);
        return this.#transaction(input.name, input.signal, () => {
          const { ownerEpoch, now } = this.#assertAndRefreshOwner(installationId, input.ownerToken);
          return operation({
            database: this.#database,
            ownerEpoch,
            localNowMs: now,
            markTransportCommandApplied: (reference) =>
              this.#markInvocationCommandApplied(reference, now),
            enqueueInvocationEvent: (event) => {
              this.#enqueueEnvelope(
                event.connectionId,
                {
                  kind: 'event',
                  type: event.type,
                  messageId: event.messageId,
                  correlationId: event.correlationId,
                  body: event.body,
                },
                now,
              );
              const delivery = this.#outboxRow(event.messageId);
              const body = event.body as Record<string, unknown>;
              if (
                delivery === undefined ||
                delivery.connection_id === null ||
                delivery.sequence === null ||
                typeof body.sourceEventId !== 'string' ||
                typeof body.invocationId !== 'string' ||
                typeof body.factDigest !== 'string'
              ) {
                throw permanentPortFailure();
              }
              return Object.freeze({
                deliveryMessageId: event.messageId,
                sourceEventId: body.sourceEventId,
                invocationId: body.invocationId,
                eventType: event.type,
                connectionId: delivery.connection_id,
                sequence: delivery.sequence,
                canonicalDigest: delivery.canonical_digest,
                factDigest: body.factDigest,
              });
            },
            enqueueConversationReadyEvent: (event) => {
              const activeOutbox = this.#database
                .prepare(
                  `SELECT count(*) AS count FROM transport_outbox
                   WHERE state IN ('UNBOUND', 'PENDING', 'WRITTEN')`,
                )
                .get() as CountRow;
              if (activeOutbox.count >= this.#maxOutboxRows - 1) return undefined;
              this.#enqueueEnvelope(
                event.connectionId,
                {
                  kind: 'event',
                  type: 'conversation.ready',
                  messageId: event.messageId,
                  correlationId: event.correlationId,
                  body: event.body,
                },
                now,
              );
              const delivery = this.#outboxRow(event.messageId);
              const body = event.body as Record<string, unknown>;
              if (
                delivery === undefined ||
                delivery.connection_id === null ||
                delivery.sequence === null ||
                typeof body.sourceEventId !== 'string' ||
                typeof body.conversationId !== 'string' ||
                typeof body.factDigest !== 'string'
              ) {
                throw permanentPortFailure();
              }
              return Object.freeze({
                deliveryMessageId: event.messageId,
                sourceEventId: body.sourceEventId,
                conversationId: body.conversationId,
                connectionId: delivery.connection_id,
                sequence: delivery.sequence,
                canonicalDigest: delivery.canonical_digest,
                factDigest: body.factDigest,
              });
            },
            purgeInvocationPrepareTransportPayload: (commandId) =>
              this.#purgeInvocationPrepareTransportPayload(commandId),
            purgeInvocationCommandResponse: (commandId) =>
              this.#purgeInvocationCommandResponse(commandId),
            purgeInvocationDeliveryWire: (deliveryMessageId) =>
              this.#purgeInvocationDeliveryWire(deliveryMessageId),
          });
        });
      },
      inspect: (operation) => {
        this.#assertOpen();
        if (this.#database.isTransaction) {
          throw new SqliteWorkerTransportError('JOURNAL_BUSY');
        }
        this.#database.exec('BEGIN');
        let completed = false;
        try {
          const result = operation(this.#database);
          this.#database.exec('COMMIT');
          completed = true;
          return result;
        } finally {
          if (!completed) safeRollback(this.#database);
        }
      },
      checkpointSensitivePrune: () => this.#forceSensitiveCheckpoint(),
    };
    return new SqliteWorkerInvocationJournal(host, options);
  }

  async replayPendingConversationReady(input: {
    installationId: string;
    ownerToken: string;
    connectionId: string;
    signal: AbortSignal;
  }): Promise<ConversationReadyReplayRefill> {
    const installationId = parseUuid(input.installationId);
    const connectionId = parseUuid(input.connectionId);
    return this.#transaction('replay_pending_conversation_ready', input.signal, () => {
      const { ownerEpoch, now } = this.#assertAndRefreshOwner(installationId, input.ownerToken);
      const connection = this.#requireActiveConnection(installationId, connectionId, ownerEpoch);
      const activeOutbox = this.#database
        .prepare(
          `SELECT count(*) AS count FROM transport_outbox
           WHERE state IN ('UNBOUND', 'PENDING', 'WRITTEN')`,
        )
        .get() as CountRow;
      const availableCredit = Math.max(0, this.#maxOutboxRows - 1 - activeOutbox.count);
      const batchLimit = Math.min(WORKER_CONVERSATION_READY_REPLAY_BATCH, availableCredit);
      const rows = this.#database
        .prepare(
          `SELECT o.* FROM local_conversation_ready_outbox AS o
           JOIN local_conversations AS c ON c.conversation_id = o.conversation_id
           LEFT JOIN local_conversation_ready_outbox_receipts AS r
             ON r.source_event_id = o.source_event_id
           WHERE c.installation_id = ? AND r.source_event_id IS NULL
             AND c.deployment_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM local_conversation_ready_deliveries AS d
               JOIN transport_outbox AS t ON t.message_id = d.delivery_message_id
               WHERE d.source_event_id = o.source_event_id
                 AND t.state IN ('PENDING', 'WRITTEN', 'ACKED')
             )
           ORDER BY o.created_at_ms, o.source_event_id LIMIT ?`,
        )
        .all(installationId, connection.deployment_id, batchLimit) as Array<
        Record<string, unknown>
      >;
      for (const outbox of rows) {
        const fact = WorkerConversationReadyFactSchema.parse(JSON.parse(String(outbox.fact_json)));
        if (
          fact.installationId !== installationId ||
          fact.deploymentId !== connection.deployment_id ||
          fact.sourceEventId !== outbox.source_event_id ||
          fact.conversationId !== outbox.conversation_id ||
          workerConversationReadyFactDigest(fact) !== outbox.fact_digest
        ) {
          throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
        }
        this.#database
          .prepare(
            `DELETE FROM local_conversation_ready_deliveries
             WHERE source_event_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM transport_outbox AS t
                 WHERE t.message_id = local_conversation_ready_deliveries.delivery_message_id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM local_conversation_ready_outbox_receipts AS r
                 WHERE r.delivery_message_id = local_conversation_ready_deliveries.delivery_message_id
               )`,
          )
          .run(fact.sourceEventId);
        const deliveryMessageId = uuidV7();
        this.#enqueueEnvelope(
          connectionId,
          {
            kind: 'event',
            type: 'conversation.ready',
            messageId: deliveryMessageId,
            correlationId: fact.conversationId,
            body: { ...fact, factDigest: String(outbox.fact_digest) },
          },
          now,
        );
        const delivery = this.#outboxRow(deliveryMessageId);
        if (
          delivery === undefined ||
          delivery.connection_id !== connectionId ||
          delivery.sequence === null
        ) {
          throw permanentPortFailure();
        }
        const row = {
          delivery_message_id: deliveryMessageId,
          source_event_id: fact.sourceEventId,
          conversation_id: fact.conversationId,
          connection_id: connectionId,
          deployment_id: connection.deployment_id,
          worker_session_id: connection.worker_session_id,
          lease_id: connection.lease_id,
          fence: connection.fence,
          sequence: delivery.sequence,
          canonical_digest: delivery.canonical_digest,
          fact_digest: String(outbox.fact_digest),
          created_at_ms: now,
        };
        this.#database
          .prepare(
            `INSERT INTO local_conversation_ready_deliveries(
               delivery_message_id, source_event_id, conversation_id, connection_id,
               deployment_id, worker_session_id, lease_id, fence, sequence,
               canonical_digest, fact_digest, created_at_ms, row_digest
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ...Object.values(row),
            sqliteInvocationRowDigest('local_conversation_ready_deliveries', row),
          );
      }
      const remaining =
        this.#database
          .prepare(
            `SELECT 1 AS present FROM local_conversation_ready_outbox AS o
             JOIN local_conversations AS c ON c.conversation_id = o.conversation_id
             LEFT JOIN local_conversation_ready_outbox_receipts AS r
               ON r.source_event_id = o.source_event_id
             WHERE c.installation_id = ? AND r.source_event_id IS NULL
               AND c.deployment_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM local_conversation_ready_deliveries AS d
                 JOIN transport_outbox AS t ON t.message_id = d.delivery_message_id
                 WHERE d.source_event_id = o.source_event_id
                   AND t.state IN ('PENDING', 'WRITTEN', 'ACKED')
               ) LIMIT 1`,
          )
          .get(installationId, connection.deployment_id) !== undefined;
      return Object.freeze({ enqueued: rows.length, remaining });
    });
  }

  inspectPragmas(): WorkerTransportPragmas {
    this.#assertOpen();
    return Object.freeze({
      applicationId: pragmaNumber(this.#database, 'application_id'),
      userVersion: pragmaNumber(this.#database, 'user_version'),
      journalMode: pragmaText(this.#database, 'journal_mode'),
      synchronous: pragmaNumber(this.#database, 'synchronous'),
      foreignKeys: pragmaNumber(this.#database, 'foreign_keys'),
      secureDelete: pragmaNumber(this.#database, 'secure_delete'),
      busyTimeoutMs: pragmaNumber(this.#database, 'busy_timeout', 'timeout'),
      pageSize: pragmaNumber(this.#database, 'page_size'),
      maxPageCount: pragmaNumber(this.#database, 'max_page_count'),
      journalSizeLimit: pragmaNumber(this.#database, 'journal_size_limit'),
      walAutocheckpoint: pragmaNumber(this.#database, 'wal_autocheckpoint'),
      quickCheck: pragmaText(this.#database, 'quick_check'),
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #configureAndMigrate(existed: boolean): void {
    this.#database.exec(`PRAGMA busy_timeout = ${this.#busyTimeoutMs};`);
    this.#assertDatabaseIntegrity();
    const applicationId = pragmaNumber(this.#database, 'application_id');
    const userVersion = pragmaNumber(this.#database, 'user_version');
    if (
      (applicationId !== 0 && applicationId !== WORKER_TRANSPORT_APPLICATION_ID) ||
      userVersion > WORKER_TRANSPORT_SCHEMA_VERSION
    ) {
      throw new SqliteWorkerTransportError('JOURNAL_SCHEMA_UNSUPPORTED');
    }
    const tableCount = this.#database
      .prepare(
        `SELECT count(*) AS count FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .get() as CountRow;
    if (userVersion === 0 && tableCount.count > 0) {
      throw new SqliteWorkerTransportError('JOURNAL_SCHEMA_UNSUPPORTED');
    }
    if (userVersion === 0 && this.#newJournalAuthorization === undefined) {
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
    const existingJournalMode = pragmaText(this.#database, 'journal_mode').toLowerCase();
    if (existed && userVersion >= 1 && existingJournalMode !== 'wal') {
      throw new SqliteWorkerTransportError('JOURNAL_PRAGMA_MISMATCH');
    }
    const pageSize = pragmaNumber(this.#database, 'page_size');
    const maxPageCount = Math.floor(this.#maxDatabaseBytes / pageSize);
    this.#database.exec(`
      ${userVersion === 0 ? 'PRAGMA journal_mode = WAL;' : ''}
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA secure_delete = ON;
      PRAGMA busy_timeout = ${this.#busyTimeoutMs};
      PRAGMA trusted_schema = OFF;
      PRAGMA max_page_count = ${maxPageCount};
      PRAGMA journal_size_limit = ${this.#maxWalBytes};
      PRAGMA wal_autocheckpoint = 256;
    `);
    if (userVersion === WORKER_TRANSPORT_SCHEMA_VERSION) return;
    let migratedVersion = userVersion;
    if (userVersion === 1) {
      this.#validateLegacyV1Snapshot();
      this.#migrateLegacyV1ToV2();
      migratedVersion = WORKER_INVOCATION_SCHEMA_VERSION;
    }
    if (migratedVersion === WORKER_INVOCATION_SCHEMA_VERSION) {
      this.#validateLegacyV2Snapshot();
      this.#migrateLegacyV2ToV3();
      migratedVersion = WORKER_CONVERSATION_READY_SCHEMA_VERSION;
    }
    if (migratedVersion === WORKER_CONVERSATION_READY_SCHEMA_VERSION) {
      this.#validateLegacyV3Snapshot();
      // The v3 -> v4 defensive-integrity migration is installed below as one exclusive
      // transaction. Keep this branch explicit so the legacy format-1 watermark is always
      // validated before any v4 bytes are published.
      this.#migrateLegacyV3ToV4();
      migratedVersion = WORKER_DEFENSIVE_INTEGRITY_SCHEMA_VERSION;
    }
    if (migratedVersion === WORKER_DEFENSIVE_INTEGRITY_SCHEMA_VERSION) {
      this.#validateLegacyV4Snapshot();
      this.#migrateLegacyV4ToV5();
      return;
    }

    this.#database.exec('PRAGMA foreign_keys = OFF; BEGIN EXCLUSIVE');
    let committed = false;
    try {
      const lockedVersion = pragmaNumber(this.#database, 'user_version');
      if (lockedVersion === WORKER_TRANSPORT_SCHEMA_VERSION) {
        this.#database.exec('COMMIT');
        this.#database.exec('PRAGMA foreign_keys = ON;');
        committed = true;
        return;
      }
      if (lockedVersion !== 0) {
        throw new SqliteWorkerTransportError('JOURNAL_SCHEMA_UNSUPPORTED');
      }
      const lockedTableCount = this.#database
        .prepare(
          `SELECT count(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
        )
        .get() as CountRow;
      if (lockedTableCount.count > 0) {
        throw new SqliteWorkerTransportError('JOURNAL_SCHEMA_UNSUPPORTED');
      }
      this.#database.exec(SCHEMA_SQL);
      this.#database.exec(WORKER_INVOCATION_SCHEMA_V5_SQL);
      this.#rebuildLegacyConversationsWithoutTransportForeignKey(
        performance.now() + this.#operationTimeoutMs,
      );
      this.#database.exec(WORKER_CONVERSATION_READY_SCHEMA_V4_SQL);
      this.#database.exec(`
        PRAGMA application_id = ${WORKER_TRANSPORT_APPLICATION_ID};
        PRAGMA user_version = ${WORKER_TRANSPORT_SCHEMA_VERSION};
      `);
      const digest = this.#actualSchemaDigest();
      const authorization = this.#newJournalAuthorization;
      if (authorization === undefined) {
        throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
      }
      const createdAt = this.#clock();
      this.#database
        .prepare(
          `INSERT INTO transport_installations(
             installation_id, highest_owner_epoch, created_at_ms, updated_at_ms
           ) VALUES (?, 0, ?, ?)`,
        )
        .run(authorization.installationId, createdAt, createdAt);
      this.#database
        .prepare(
          `INSERT INTO transport_meta(
             singleton, schema_digest, authority_digest, installation_id, journal_generation,
             authorization_digest, inbound_evidence_count, inbound_evidence_xor,
             outbox_evidence_count, outbox_evidence_xor,
             max_database_bytes, max_wal_bytes, min_free_bytes, commit_epoch, created_at_ms
           ) VALUES (1, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?, 1, ?)`,
        )
        .run(
          digest,
          this.#actualAuthorityDigest(),
          authorization.installationId,
          authorization.journalGeneration,
          authorization.authorizationDigest,
          ZERO_DIGEST,
          ZERO_DIGEST,
          this.#maxDatabaseBytes,
          this.#maxWalBytes,
          this.#minFreeBytes,
          createdAt,
        );
      this.#faultInjector?.('migration.before_commit');
      this.#assertDatabaseIntegrity();
      this.#writeExternalWatermark(this.#readDatabaseWatermark());
      this.#database.exec('COMMIT');
      this.#database.exec('PRAGMA foreign_keys = ON;');
      committed = true;
      this.#secureJournalFiles();
      this.#faultInjector?.('migration.after_commit');
    } catch (error) {
      if (!committed) safeRollback(this.#database);
      this.#database.exec('PRAGMA foreign_keys = ON;');
      if (isSqliteCapacity(error)) throw new WorkerBrokerClientError('CAPACITY_EXCEEDED');
      throw error;
    }
  }

  /**
   * Version 1 must be proven against its own DB and external watermark before any local_* DDL is
   * attempted. Otherwise a corrupt/rolled-back v1 file could be blessed by the forward migration.
   */
  #validateLegacyV1Snapshot(): void {
    this.#database.exec('BEGIN');
    let completed = false;
    try {
      const pragmas = this.inspectPragmas();
      if (
        pragmas.applicationId !== WORKER_TRANSPORT_APPLICATION_ID ||
        pragmas.userVersion !== 1 ||
        pragmas.journalMode.toLowerCase() !== 'wal' ||
        pragmas.synchronous !== 2 ||
        pragmas.foreignKeys !== 1 ||
        pragmas.secureDelete !== 1 ||
        pragmas.busyTimeoutMs !== this.#busyTimeoutMs ||
        pragmas.maxPageCount !== Math.floor(this.#maxDatabaseBytes / pragmas.pageSize) ||
        pragmas.journalSizeLimit !== this.#maxWalBytes ||
        pragmas.walAutocheckpoint !== 256 ||
        pragmas.quickCheck.toLowerCase() !== 'ok'
      ) {
        throw new SqliteWorkerTransportError('JOURNAL_PRAGMA_MISMATCH');
      }
      this.#assertDatabaseIntegrity();
      this.#assertSchemaDigest();
      this.#assertStoredEnvelopeIntegrity();
      const watermark = this.#readDatabaseWatermark(1);
      this.#database.exec('COMMIT');
      completed = true;
      this.#assertExternalWatermark(watermark);
    } finally {
      if (!completed) safeRollback(this.#database);
    }
  }

  #migrateLegacyV1ToV2(): void {
    this.#database.exec('BEGIN EXCLUSIVE');
    let committed = false;
    let watermarkWriteStarted = false;
    let legacyWatermark: LegacyJournalCommitWatermark | undefined;
    try {
      if (pragmaNumber(this.#database, 'user_version') !== 1) {
        throw new SqliteWorkerTransportError('JOURNAL_SCHEMA_UNSUPPORTED');
      }
      this.#assertDatabaseIntegrity();
      this.#assertSchemaDigest();
      this.#assertStoredEnvelopeIntegrity();
      legacyWatermark = this.#readDatabaseWatermark(1);
      this.#assertExternalWatermark(legacyWatermark);

      this.#database.exec(WORKER_INVOCATION_SCHEMA_SQL);
      this.#database.exec(`PRAGMA user_version = ${WORKER_INVOCATION_SCHEMA_VERSION};`);
      const updated = this.#database
        .prepare(
          `UPDATE transport_meta
           SET schema_digest = ?, authority_digest = ?, commit_epoch = commit_epoch + 1
           WHERE singleton = 1`,
        )
        .run(this.#actualSchemaDigest(), this.#actualAuthorityDigest());
      if (Number(updated.changes) !== 1) throw permanentPortFailure();
      this.#assertDatabaseIntegrity();
      assertWorkerInvocationIntegrity(this.#database);
      this.#faultInjector?.('migration.v1_to_v2.before_watermark');
      watermarkWriteStarted = true;
      this.#writeExternalWatermark(this.#readDatabaseWatermark(WORKER_INVOCATION_SCHEMA_VERSION));
      this.#faultInjector?.('migration.v1_to_v2.after_watermark_fsync');
      this.#database.exec('COMMIT');
      committed = true;
      this.#secureJournalFiles();
      this.#faultInjector?.('migration.v1_to_v2.after_commit');
    } catch (error) {
      if (!committed) {
        if (watermarkWriteStarted && legacyWatermark !== undefined) {
          try {
            this.#writeExternalWatermark(legacyWatermark);
            this.#assertExternalWatermark(legacyWatermark);
          } catch {
            safeRollback(this.#database);
            throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
          }
        }
        safeRollback(this.#database);
      }
      if (isSqliteCapacity(error)) throw new WorkerBrokerClientError('CAPACITY_EXCEEDED');
      throw error;
    }
  }

  #validateLegacyV2Snapshot(): void {
    this.#database.exec('BEGIN');
    let completed = false;
    try {
      const pragmas = this.inspectPragmas();
      if (
        pragmas.applicationId !== WORKER_TRANSPORT_APPLICATION_ID ||
        pragmas.userVersion !== WORKER_INVOCATION_SCHEMA_VERSION ||
        pragmas.journalMode.toLowerCase() !== 'wal' ||
        pragmas.synchronous !== 2 ||
        pragmas.foreignKeys !== 1 ||
        pragmas.secureDelete !== 1 ||
        pragmas.busyTimeoutMs !== this.#busyTimeoutMs ||
        pragmas.maxPageCount !== Math.floor(this.#maxDatabaseBytes / pragmas.pageSize) ||
        pragmas.journalSizeLimit !== this.#maxWalBytes ||
        pragmas.walAutocheckpoint !== 256 ||
        pragmas.quickCheck.toLowerCase() !== 'ok'
      ) {
        throw new SqliteWorkerTransportError('JOURNAL_PRAGMA_MISMATCH');
      }
      this.#assertDatabaseIntegrity();
      this.#assertSchemaDigest();
      this.#assertStoredEnvelopeIntegrity();
      assertWorkerInvocationIntegrity(this.#database);
      const watermark = this.#readDatabaseWatermark(WORKER_INVOCATION_SCHEMA_VERSION);
      this.#database.exec('COMMIT');
      completed = true;
      this.#assertExternalWatermark(watermark);
    } finally {
      if (!completed) safeRollback(this.#database);
    }
  }

  #migrateLegacyV2ToV3(): void {
    const migrationDeadline = performance.now() + this.#operationTimeoutMs;
    const previousBusyTimeout = pragmaNumber(this.#database, 'busy_timeout', 'timeout');
    let began = false;
    let committed = false;
    let watermarkWriteStarted = false;
    let legacyWatermark: LegacyJournalCommitWatermark | undefined;
    try {
      this.#assertMigrationDeadline(migrationDeadline);
      this.#database.exec('PRAGMA foreign_keys = OFF;');
      const remaining = Math.max(1, Math.floor(migrationDeadline - performance.now()));
      const migrationBusyTimeout = Math.min(previousBusyTimeout, remaining);
      this.#database.exec(`PRAGMA busy_timeout = ${migrationBusyTimeout};`);
      try {
        this.#database.exec('BEGIN EXCLUSIVE');
        began = true;
      } catch {
        if (migrationBusyTimeout >= remaining) {
          throw new SqliteWorkerTransportError('JOURNAL_ABORTED');
        }
        throw new SqliteWorkerTransportError('JOURNAL_BUSY');
      }
      this.#database.exec(`PRAGMA busy_timeout = ${previousBusyTimeout};`);
      this.#assertMigrationDeadline(migrationDeadline);
      if (pragmaNumber(this.#database, 'user_version') !== WORKER_INVOCATION_SCHEMA_VERSION) {
        throw new SqliteWorkerTransportError('JOURNAL_SCHEMA_UNSUPPORTED');
      }
      this.#assertMigrationDeadline(migrationDeadline);
      this.#assertDatabaseIntegrity();
      this.#assertMigrationDeadline(migrationDeadline);
      this.#assertSchemaDigest();
      this.#assertMigrationDeadline(migrationDeadline);
      this.#assertStoredEnvelopeIntegrity();
      this.#assertMigrationDeadline(migrationDeadline);
      assertWorkerInvocationIntegrity(this.#database);
      this.#assertMigrationDeadline(migrationDeadline);
      legacyWatermark = this.#readDatabaseWatermark(WORKER_INVOCATION_SCHEMA_VERSION);
      this.#assertExternalWatermark(legacyWatermark);
      this.#assertMigrationDeadline(migrationDeadline);
      this.#assertConversationReadyMigrationCapacity(migrationDeadline);

      this.#rebuildLegacyConversationsWithoutTransportForeignKey(migrationDeadline);
      this.#assertMigrationDeadline(migrationDeadline);
      this.#database.exec(WORKER_CONVERSATION_READY_SCHEMA_SQL);
      this.#database.exec(`PRAGMA user_version = ${WORKER_CONVERSATION_READY_SCHEMA_VERSION};`);
      this.#assertMigrationDeadline(migrationDeadline);
      this.#backfillConversationReadyAuthority(migrationDeadline);
      this.#refreshMigratedConversationDigests(migrationDeadline);
      this.#faultInjector?.('migration.v2_to_v3.before_authority_digest');
      this.#assertMigrationDeadline(migrationDeadline);
      const schemaDigest = this.#actualSchemaDigest();
      this.#assertMigrationDeadline(migrationDeadline);
      const authorityDigest = this.#actualAuthorityDigest();
      this.#assertMigrationDeadline(migrationDeadline);
      const updated = this.#database
        .prepare(
          `UPDATE transport_meta
           SET schema_digest = ?, authority_digest = ?, commit_epoch = commit_epoch + 1
           WHERE singleton = 1`,
        )
        .run(schemaDigest, authorityDigest);
      if (Number(updated.changes) !== 1) throw permanentPortFailure();
      this.#assertMigrationDeadline(migrationDeadline);
      this.#assertDatabaseIntegrity();
      this.#assertMigrationDeadline(migrationDeadline);
      const foreignKeyViolations = this.#database.prepare('PRAGMA foreign_key_check').all();
      if (foreignKeyViolations.length !== 0) {
        throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
      }
      this.#assertMigrationDeadline(migrationDeadline);
      assertWorkerInvocationIntegrity(this.#database);
      this.#assertMigrationDeadline(migrationDeadline);
      assertWorkerConversationReadyIntegrity(this.#database);
      this.#assertMigrationDeadline(migrationDeadline);
      this.#faultInjector?.('migration.v2_to_v3.before_watermark');
      watermarkWriteStarted = true;
      this.#writeExternalWatermark(
        this.#readDatabaseWatermark(WORKER_CONVERSATION_READY_SCHEMA_VERSION),
      );
      this.#faultInjector?.('migration.v2_to_v3.after_watermark_fsync');
      this.#assertMigrationDeadline(migrationDeadline);
      this.#database.exec('COMMIT');
      committed = true;
      this.#database.exec('PRAGMA foreign_keys = ON;');
      this.#secureJournalFiles();
      this.#faultInjector?.('migration.v2_to_v3.after_commit');
    } catch (error) {
      if (!committed) {
        if (began) safeRollback(this.#database);
        if (watermarkWriteStarted && legacyWatermark !== undefined) {
          try {
            this.#writeExternalWatermark(legacyWatermark);
            this.#assertExternalWatermark(legacyWatermark);
          } catch {
            this.#database.exec('PRAGMA foreign_keys = ON;');
            this.#database.exec(`PRAGMA busy_timeout = ${previousBusyTimeout};`);
            throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
          }
        }
      }
      this.#database.exec('PRAGMA foreign_keys = ON;');
      this.#database.exec(`PRAGMA busy_timeout = ${previousBusyTimeout};`);
      if (isSqliteCapacity(error)) throw new WorkerBrokerClientError('CAPACITY_EXCEEDED');
      throw error;
    }
  }

  #validateLegacyV3Snapshot(): void {
    this.#database.exec('BEGIN');
    let completed = false;
    try {
      const pragmas = this.inspectPragmas();
      if (
        pragmas.applicationId !== WORKER_TRANSPORT_APPLICATION_ID ||
        pragmas.userVersion !== WORKER_CONVERSATION_READY_SCHEMA_VERSION ||
        pragmas.journalMode.toLowerCase() !== 'wal' ||
        pragmas.synchronous !== 2 ||
        pragmas.foreignKeys !== 1 ||
        pragmas.secureDelete !== 1 ||
        pragmas.busyTimeoutMs !== this.#busyTimeoutMs ||
        pragmas.maxPageCount !== Math.floor(this.#maxDatabaseBytes / pragmas.pageSize) ||
        pragmas.journalSizeLimit !== this.#maxWalBytes ||
        pragmas.walAutocheckpoint !== 256 ||
        pragmas.quickCheck.toLowerCase() !== 'ok'
      ) {
        throw new SqliteWorkerTransportError('JOURNAL_PRAGMA_MISMATCH');
      }
      this.#assertDatabaseIntegrity();
      this.#assertSchemaDigest();
      this.#assertStoredEnvelopeIntegrity();
      assertWorkerInvocationIntegrity(this.#database);
      assertWorkerConversationReadyIntegrity(this.#database);
      const watermark = this.#readDatabaseWatermark(WORKER_CONVERSATION_READY_SCHEMA_VERSION);
      this.#database.exec('COMMIT');
      completed = true;
      this.#recoverMigrationWatermarkIfNeeded(watermark);
      this.#assertExternalWatermark(watermark);
    } finally {
      if (!completed) safeRollback(this.#database);
    }
  }

  #migrateLegacyV3ToV4(): void {
    const migrationDeadline = performance.now() + this.#operationTimeoutMs;
    const previousBusyTimeout = pragmaNumber(this.#database, 'busy_timeout', 'timeout');
    let began = false;
    let committed = false;
    let legacyWatermark: LegacyJournalCommitWatermark | undefined;
    let recoveryManifest: MigrationRecoveryManifest | undefined;
    let candidateWatermark: JournalCommitWatermark | undefined;
    try {
      this.#assertMigrationDeadline(migrationDeadline);
      this.#database.exec('PRAGMA foreign_keys = OFF;');
      const remaining = Math.max(1, Math.floor(migrationDeadline - performance.now()));
      this.#database.exec(`PRAGMA busy_timeout = ${Math.min(previousBusyTimeout, remaining)};`);
      try {
        this.#database.exec('BEGIN EXCLUSIVE');
        began = true;
      } catch {
        this.#assertMigrationDeadline(migrationDeadline);
        throw new SqliteWorkerTransportError('JOURNAL_BUSY');
      }
      this.#database.exec(`PRAGMA busy_timeout = ${previousBusyTimeout};`);
      this.#assertMigrationDeadline(migrationDeadline);
      const lockedVersion = pragmaNumber(this.#database, 'user_version');
      if (lockedVersion === WORKER_DEFENSIVE_INTEGRITY_SCHEMA_VERSION) {
        this.#database.exec('COMMIT');
        committed = true;
        this.#database.exec('PRAGMA foreign_keys = ON;');
        return;
      }
      if (lockedVersion !== WORKER_CONVERSATION_READY_SCHEMA_VERSION) {
        throw new SqliteWorkerTransportError('JOURNAL_SCHEMA_UNSUPPORTED');
      }

      // The format-1 authority and all legacy local/transport relations are re-proven while the
      // exclusive lock is held. No migration write is allowed before the business classification
      // and ACK receipt projections below complete.
      this.#assertDatabaseIntegrity();
      this.#assertMigrationDeadline(migrationDeadline);
      this.#assertSchemaDigest();
      this.#assertMigrationDeadline(migrationDeadline);
      this.#assertStoredEnvelopeIntegrity();
      this.#assertMigrationDeadline(migrationDeadline);
      assertWorkerInvocationIntegrity(this.#database);
      this.#assertMigrationDeadline(migrationDeadline);
      assertWorkerConversationReadyIntegrity(this.#database);
      this.#assertMigrationDeadline(migrationDeadline);
      legacyWatermark = this.#readDatabaseWatermark(WORKER_CONVERSATION_READY_SCHEMA_VERSION);
      this.#assertExternalWatermark(legacyWatermark);
      this.#assertMigrationDeadline(migrationDeadline);

      this.#assertLegacyV3BusinessRowsReconciled();
      this.#assertLegacyInvocationReceipts(migrationDeadline);
      this.#assertLegacyConversationReadyReceipts(migrationDeadline);
      this.#assertLegacyV3MigrationCapacity();
      this.#assertMigrationDeadline(migrationDeadline);
      const transientSchema = this.#captureTransientTransportSchema();
      this.#assertMigrationDeadline(migrationDeadline);
      recoveryManifest = this.#prepareMigrationRecoveryManifest(legacyWatermark);
      this.#assertMigrationDeadline(migrationDeadline);

      this.#database.exec(
        migrationCreateTableSql(
          WORKER_INVOCATION_SCHEMA_V4_SQL,
          'local_invocations',
          'local_invocations_v4',
        ),
      );
      this.#database.exec(
        migrationCreateTableSql(
          WORKER_INVOCATION_SCHEMA_V4_SQL,
          'local_invocation_outbox_receipts',
          'local_invocation_outbox_receipts_v4',
        ),
      );
      this.#database.exec(
        migrationCreateTableSql(
          WORKER_CONVERSATION_READY_SCHEMA_V4_SQL,
          'local_conversation_ready_outbox_receipts',
          'local_conversation_ready_outbox_receipts_v4',
        ),
      );
      this.#assertMigrationDeadline(migrationDeadline);

      this.#copyLegacyInvocations(migrationDeadline);
      this.#copyLegacyInvocationReceipts(migrationDeadline);
      this.#copyLegacyConversationReadyReceipts(migrationDeadline);
      this.#faultInjector?.('migration.v3_to_v4.after_local_projection');
      this.#assertMigrationDeadline(migrationDeadline);
      this.#assertMigrationTableCount('local_invocations', 'local_invocations_v4');
      this.#assertMigrationTableCount(
        'local_invocation_outbox_receipts',
        'local_invocation_outbox_receipts_v4',
      );
      this.#assertMigrationTableCount(
        'local_conversation_ready_outbox_receipts',
        'local_conversation_ready_outbox_receipts_v4',
      );

      this.#database.exec(`
        DROP TABLE local_conversation_ready_outbox_receipts;
        DROP TABLE local_invocation_outbox_receipts;
        DROP TABLE local_invocations;
        ALTER TABLE local_invocations_v4 RENAME TO local_invocations;
        ALTER TABLE local_invocation_outbox_receipts_v4
          RENAME TO local_invocation_outbox_receipts;
        ALTER TABLE local_conversation_ready_outbox_receipts_v4
          RENAME TO local_conversation_ready_outbox_receipts;

        CREATE UNIQUE INDEX local_one_active_invocation
          ON local_invocations(installation_id)
          WHERE state IN ('PREPARED', 'STARTING', 'RUNNING', 'FINAL_READY');
        CREATE INDEX local_invocation_conversation_state
          ON local_invocations(conversation_id, state, created_at_ms);
        CREATE TRIGGER local_invocation_outbox_receipts_no_update
          BEFORE UPDATE ON local_invocation_outbox_receipts BEGIN
            SELECT RAISE(ABORT, 'local_invocation_outbox_receipts is append-only');
          END;
        CREATE TRIGGER local_conversation_ready_outbox_receipts_no_update
          BEFORE UPDATE ON local_conversation_ready_outbox_receipts BEGIN
            SELECT RAISE(ABORT, 'local_conversation_ready_outbox_receipts is append-only');
          END;
      `);
      this.#assertNoLocalTransportForeignKeys();
      this.#assertMigrationDeadline(migrationDeadline);

      this.#database.exec(`
        DROP TABLE transport_sequence_gaps;
        DROP TABLE transport_outbox;
        DROP TABLE transport_inbound_effect_events;
        DROP TABLE transport_inbound_frames;
        DROP TABLE transport_connections;
      `);
      for (const sql of transientSchema.tables) this.#database.exec(sql);
      for (const sql of transientSchema.indexes) this.#database.exec(sql);
      this.#assertMigrationDeadline(migrationDeadline);

      this.#database.exec(`PRAGMA user_version = ${WORKER_DEFENSIVE_INTEGRITY_SCHEMA_VERSION};`);
      this.#assertMigrationDeadline(migrationDeadline);
      const schemaDigest = this.#actualSchemaDigest();
      this.#assertMigrationDeadline(migrationDeadline);
      this.#faultInjector?.('migration.v3_to_v4.before_authority_digest');
      this.#assertMigrationDeadline(migrationDeadline);
      const authorityDigest = this.#actualAuthorityDigest();
      this.#assertMigrationDeadline(migrationDeadline);
      const updated = this.#database
        .prepare(
          `UPDATE transport_meta
           SET schema_digest = ?, authority_digest = ?,
               inbound_evidence_count = 0, inbound_evidence_xor = ?,
               outbox_evidence_count = 0, outbox_evidence_xor = ?,
               commit_epoch = commit_epoch + 1
           WHERE singleton = 1`,
        )
        .run(schemaDigest, authorityDigest, ZERO_DIGEST, ZERO_DIGEST);
      if (Number(updated.changes) !== 1) throw permanentPortFailure();
      this.#assertMigrationDeadline(migrationDeadline);
      this.#assertDatabaseIntegrity();
      this.#assertMigrationDeadline(migrationDeadline);
      assertWorkerInvocationIntegrity(this.#database);
      this.#assertMigrationDeadline(migrationDeadline);
      assertWorkerConversationReadyIntegrity(this.#database);
      this.#assertMigrationDeadline(migrationDeadline);
      this.#assertStoredEnvelopeIntegrity();
      this.#assertMigrationDeadline(migrationDeadline);

      candidateWatermark = this.#readDatabaseWatermark(WORKER_DEFENSIVE_INTEGRITY_SCHEMA_VERSION);
      recoveryManifest = this.#recordMigrationRecoveryCandidate(
        recoveryManifest,
        candidateWatermark,
      );
      this.#assertMigrationDeadline(migrationDeadline);
      this.#faultInjector?.('migration.v3_to_v4.before_watermark');
      this.#assertMigrationDeadline(migrationDeadline);
      this.#writeExternalWatermark(candidateWatermark);
      this.#faultInjector?.('migration.v3_to_v4.after_watermark_fsync');
      this.#assertMigrationDeadline(migrationDeadline);
      this.#database.exec('COMMIT');
      committed = true;
      this.#database.exec('PRAGMA foreign_keys = ON;');
      this.#faultInjector?.('migration.v3_to_v4.after_commit');
      this.#finalizeMigrationRecoveryManifest(recoveryManifest, candidateWatermark);
      this.#secureJournalFiles();
    } catch (error) {
      if (!committed) {
        if (began) safeRollback(this.#database);
        if (recoveryManifest !== undefined && legacyWatermark !== undefined) {
          try {
            this.#writeExternalWatermark(legacyWatermark);
            this.#assertExternalWatermark(legacyWatermark);
            this.#writeMigrationRecoveryManifest(
              Object.freeze({
                ...recoveryManifest,
                candidateSlot: null,
                finalizedSlot: null,
              }),
            );
          } catch {
            this.#database.exec('PRAGMA foreign_keys = ON;');
            this.#database.exec(`PRAGMA busy_timeout = ${previousBusyTimeout};`);
            throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
          }
        }
      }
      this.#database.exec('PRAGMA foreign_keys = ON;');
      this.#database.exec(`PRAGMA busy_timeout = ${previousBusyTimeout};`);
      if (isSqliteCapacity(error)) throw new WorkerBrokerClientError('CAPACITY_EXCEEDED');
      throw error;
    }
  }

  #validateLegacyV4Snapshot(): void {
    this.#database.exec('BEGIN');
    let completed = false;
    try {
      const pragmas = this.inspectPragmas();
      if (
        pragmas.applicationId !== WORKER_TRANSPORT_APPLICATION_ID ||
        pragmas.userVersion !== WORKER_DEFENSIVE_INTEGRITY_SCHEMA_VERSION ||
        pragmas.journalMode.toLowerCase() !== 'wal' ||
        pragmas.synchronous !== 2 ||
        pragmas.foreignKeys !== 1 ||
        pragmas.secureDelete !== 1 ||
        pragmas.quickCheck.toLowerCase() !== 'ok'
      ) {
        throw new SqliteWorkerTransportError('JOURNAL_PRAGMA_MISMATCH');
      }
      this.#assertDatabaseIntegrity();
      this.#assertSchemaDigest();
      this.#assertStoredEnvelopeIntegrity();
      assertWorkerConversationReadyIntegrity(this.#database);
      const legacyCancelled = this.#legacyV4HasCancelledAuthority();
      if (!legacyCancelled) assertWorkerInvocationIntegrity(this.#database);
      const watermark = this.#readDatabaseWatermark(WORKER_DEFENSIVE_INTEGRITY_SCHEMA_VERSION);
      this.#database.exec('COMMIT');
      completed = true;
      this.#recoverMigrationWatermarkIfNeeded(watermark);
      this.#assertExternalWatermark(watermark);
      if (legacyCancelled) {
        throw new SqliteWorkerTransportError('JOURNAL_RECONCILIATION_REQUIRED');
      }
    } finally {
      if (!completed) safeRollback(this.#database);
    }
  }

  #migrateLegacyV4ToV5(): void {
    const migrationDeadline = performance.now() + this.#operationTimeoutMs;
    const previousBusyTimeout = pragmaNumber(this.#database, 'busy_timeout', 'timeout');
    let began = false;
    let committed = false;
    let legacyWatermark: JournalCommitWatermark | undefined;
    let recoveryManifest: MigrationRecoveryManifest | undefined;
    let candidateWatermark: JournalCommitWatermark | undefined;
    try {
      this.#assertMigrationDeadline(migrationDeadline);
      this.#database.exec('PRAGMA foreign_keys = OFF;');
      const remaining = Math.max(1, Math.floor(migrationDeadline - performance.now()));
      this.#database.exec(`PRAGMA busy_timeout = ${Math.min(previousBusyTimeout, remaining)};`);
      this.#database.exec('BEGIN EXCLUSIVE');
      began = true;
      this.#database.exec(`PRAGMA busy_timeout = ${previousBusyTimeout};`);
      this.#assertMigrationDeadline(migrationDeadline);
      const lockedVersion = pragmaNumber(this.#database, 'user_version');
      if (lockedVersion === WORKER_HOST_CONTROL_SCHEMA_VERSION) {
        this.#database.exec('COMMIT');
        committed = true;
        this.#database.exec('PRAGMA foreign_keys = ON;');
        return;
      }
      if (lockedVersion !== WORKER_DEFENSIVE_INTEGRITY_SCHEMA_VERSION) {
        throw new SqliteWorkerTransportError('JOURNAL_SCHEMA_UNSUPPORTED');
      }
      this.#assertMigrationDeadline(migrationDeadline);
      this.#assertDatabaseIntegrity();
      this.#assertMigrationDeadline(migrationDeadline);
      this.#assertSchemaDigest();
      this.#assertMigrationDeadline(migrationDeadline);
      this.#assertStoredEnvelopeIntegrity();
      this.#assertMigrationDeadline(migrationDeadline);
      assertWorkerInvocationIntegrity(this.#database);
      this.#assertMigrationDeadline(migrationDeadline);
      assertWorkerConversationReadyIntegrity(this.#database);
      this.#assertMigrationDeadline(migrationDeadline);
      legacyWatermark = this.#readDatabaseWatermark(WORKER_DEFENSIVE_INTEGRITY_SCHEMA_VERSION);
      this.#assertExternalWatermark(legacyWatermark);
      this.#assertMigrationDeadline(migrationDeadline);
      recoveryManifest = this.#prepareMigrationRecoveryManifest(legacyWatermark);
      this.#assertMigrationDeadline(migrationDeadline);
      this.#database.exec(
        migrationCreateTableSql(
          WORKER_INVOCATION_SCHEMA_V5_SQL,
          'local_invocations',
          'local_invocations_v5',
        ),
      );
      this.#database.exec(
        migrationCreateTableSql(
          WORKER_INVOCATION_SCHEMA_V5_SQL,
          'local_invocation_events',
          'local_invocation_events_v5',
        ),
      );
      this.#assertMigrationDeadline(migrationDeadline);
      this.#copyLegacyV4Invocations(migrationDeadline);
      this.#database.exec(
        `INSERT INTO local_invocation_events_v5 SELECT * FROM local_invocation_events`,
      );
      this.#faultInjector?.('migration.v4_to_v5.after_local_projection');
      this.#assertMigrationDeadline(migrationDeadline);
      this.#database.exec(`
        DROP TABLE local_invocation_events;
        DROP TABLE local_invocations;
        ALTER TABLE local_invocations_v5 RENAME TO local_invocations;
        ALTER TABLE local_invocation_events_v5 RENAME TO local_invocation_events;
        CREATE UNIQUE INDEX local_one_active_invocation
          ON local_invocations(installation_id)
          WHERE state IN ('PREPARED', 'STARTING', 'RUNNING', 'CANCEL_REQUESTED', 'FINAL_READY');
        CREATE INDEX local_invocation_conversation_state
          ON local_invocations(conversation_id, state, created_at_ms);
        CREATE INDEX local_invocation_event_order
          ON local_invocation_events(invocation_id, event_id);
        CREATE TRIGGER local_invocation_events_no_update
          BEFORE UPDATE ON local_invocation_events BEGIN
            SELECT RAISE(ABORT, 'local_invocation_events is append-only');
          END;
      `);
      this.#assertMigrationDeadline(migrationDeadline);
      this.#database.exec(
        migrationCreateTableSql(
          WORKER_INVOCATION_SCHEMA_V5_SQL,
          'local_invocation_interrupt_receipts',
          'local_invocation_interrupt_receipts',
        ),
      );
      this.#database.exec(`
        CREATE TRIGGER local_invocation_interrupt_receipts_no_update
          BEFORE UPDATE ON local_invocation_interrupt_receipts BEGIN
            SELECT RAISE(ABORT, 'local_invocation_interrupt_receipts is append-only');
          END;
        PRAGMA user_version = ${WORKER_HOST_CONTROL_SCHEMA_VERSION};
      `);
      this.#assertMigrationDeadline(migrationDeadline);
      const schemaDigest = this.#actualSchemaDigest();
      this.#assertMigrationDeadline(migrationDeadline);
      this.#faultInjector?.('migration.v4_to_v5.before_authority_digest');
      this.#assertMigrationDeadline(migrationDeadline);
      const authorityDigest = this.#actualAuthorityDigest();
      this.#assertMigrationDeadline(migrationDeadline);
      const updated = this.#database
        .prepare(
          `UPDATE transport_meta SET schema_digest = ?, authority_digest = ?,
             commit_epoch = commit_epoch + 1 WHERE singleton = 1`,
        )
        .run(schemaDigest, authorityDigest);
      if (Number(updated.changes) !== 1) throw permanentPortFailure();
      this.#assertMigrationDeadline(migrationDeadline);
      this.#assertDatabaseIntegrity();
      this.#assertMigrationDeadline(migrationDeadline);
      assertWorkerInvocationIntegrity(this.#database);
      this.#assertMigrationDeadline(migrationDeadline);
      assertWorkerConversationReadyIntegrity(this.#database);
      this.#assertMigrationDeadline(migrationDeadline);
      this.#assertStoredEnvelopeIntegrity();
      this.#assertMigrationDeadline(migrationDeadline);
      candidateWatermark = this.#readDatabaseWatermark();
      recoveryManifest = this.#recordMigrationRecoveryCandidate(
        recoveryManifest,
        candidateWatermark,
      );
      this.#assertMigrationDeadline(migrationDeadline);
      this.#faultInjector?.('migration.v4_to_v5.before_watermark');
      this.#assertMigrationDeadline(migrationDeadline);
      this.#writeExternalWatermark(candidateWatermark);
      this.#faultInjector?.('migration.v4_to_v5.after_watermark_fsync');
      this.#assertMigrationDeadline(migrationDeadline);
      this.#database.exec('COMMIT');
      committed = true;
      this.#database.exec('PRAGMA foreign_keys = ON;');
      this.#faultInjector?.('migration.v4_to_v5.after_commit');
      this.#finalizeMigrationRecoveryManifest(recoveryManifest, candidateWatermark);
      this.#secureJournalFiles();
    } catch (error) {
      if (!committed) {
        if (began) safeRollback(this.#database);
        if (recoveryManifest !== undefined && legacyWatermark !== undefined) {
          try {
            this.#writeExternalWatermark(legacyWatermark);
            this.#assertExternalWatermark(legacyWatermark);
            this.#writeMigrationRecoveryManifest({
              ...recoveryManifest,
              candidateSlot: null,
              finalizedSlot: null,
            });
          } catch {
            this.#database.exec('PRAGMA foreign_keys = ON;');
            throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
          }
        }
      }
      this.#database.exec('PRAGMA foreign_keys = ON;');
      this.#database.exec(`PRAGMA busy_timeout = ${previousBusyTimeout};`);
      if (isSqliteCapacity(error)) throw new WorkerBrokerClientError('CAPACITY_EXCEEDED');
      throw error;
    }
  }

  #legacyV4HasCancelledAuthority(): boolean {
    return (
      this.#database
        .prepare(
          `SELECT 1 AS present FROM local_invocations WHERE state = 'CANCELLED'
           UNION ALL
           SELECT 1 FROM local_invocation_events WHERE event_type = 'invocation.cancelled'
           UNION ALL
           SELECT 1 FROM local_invocation_outbox WHERE event_type = 'invocation.cancelled'
           LIMIT 1`,
        )
        .get() !== undefined
    );
  }

  #copyLegacyV4Invocations(deadline: number): void {
    const rows = this.#database
      .prepare('SELECT * FROM local_invocations ORDER BY invocation_id')
      .iterate() as Iterable<Record<string, unknown>>;
    for (const row of rows) {
      this.#assertMigrationDeadline(deadline);
      const candidate = { ...row };
      const attemptCount = Number(candidate.host_prompt_release_count);
      delete candidate.host_prompt_release_count;
      delete candidate.row_digest;
      Object.assign(candidate, {
        host_dispatch_attempt_count: attemptCount,
        cancel_command_id: null,
        cancel_reason: null,
        interrupt_nonce: null,
        interrupt_intent_at_ms: null,
        interrupt_attempted_at_ms: null,
        interrupt_confirmed_at_ms: null,
        interrupt_receipt_digest: null,
        interrupt_intent_count: 0,
        interrupt_attempt_count: 0,
        interrupt_confirmed_count: 0,
      });
      const columns = Object.keys(candidate);
      this.#database
        .prepare(
          `INSERT INTO local_invocations_v5(${columns.join(', ')}, row_digest)
           VALUES (${columns.map(() => '?').join(', ')}, ?)`,
        )
        .run(
          ...(Object.values(candidate) as SQLInputValue[]),
          sqliteInvocationRowDigest('local_invocations', candidate),
        );
    }
  }

  #assertLegacyV3BusinessRowsReconciled(): void {
    const missingApplied = this.#database
      .prepare(
        `SELECT 1 AS present
         FROM transport_inbound_frames AS f
         WHERE f.envelope_kind = 'command'
           AND f.envelope_type NOT IN (${LEGACY_V3_TRANSPORT_CONTROL_SQL})
           AND f.effect_state = 'APPLIED'
           AND NOT EXISTS (
             SELECT 1 FROM local_consumed_commands AS c
             WHERE c.command_id = f.message_id AND c.command_type = f.envelope_type
           )
         LIMIT 1`,
      )
      .get();
    if (missingApplied !== undefined) {
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
    const unresolved = this.#database
      .prepare(
        `SELECT 1 AS present
         FROM transport_inbound_frames AS f
         WHERE f.envelope_kind = 'command'
           AND f.envelope_type NOT IN (${LEGACY_V3_TRANSPORT_CONTROL_SQL})
           AND f.effect_state = 'PERSISTED'
           AND NOT EXISTS (
             SELECT 1 FROM local_consumed_commands AS c
             WHERE c.command_id = f.message_id AND c.command_type = f.envelope_type
           )
         LIMIT 1`,
      )
      .get();
    if (unresolved !== undefined) {
      throw new SqliteWorkerTransportError('JOURNAL_RECONCILIATION_REQUIRED');
    }
  }

  #assertLegacyV3MigrationCapacity(): void {
    const counts = this.#database
      .prepare(
        `SELECT
           (SELECT count(*) FROM local_invocations) AS invocations,
           (SELECT count(*) FROM local_invocation_outbox_receipts) AS invocation_receipts,
           (SELECT count(*) FROM local_conversation_ready_outbox_receipts) AS ready_receipts`,
      )
      .get() as {
      invocations: number;
      invocation_receipts: number;
      ready_receipts: number;
    };
    const receiptLimit = Math.min(this.#maxRetainedInboundRows, this.#maxRetainedOutboxRows);
    if (
      counts.invocations > this.#maxRetainedInboundRows ||
      counts.invocation_receipts > receiptLimit ||
      counts.ready_receipts > receiptLimit
    ) {
      throw new WorkerBrokerClientError('CAPACITY_EXCEEDED');
    }

    const pageCount = pragmaNumber(this.#database, 'page_count');
    const freelistCount = pragmaNumber(this.#database, 'freelist_count');
    const maxPageCount = pragmaNumber(this.#database, 'max_page_count');
    const usedPages = pageCount - freelistCount;
    const availablePages = maxPageCount - usedPages;
    // Until the transient tables can be dropped, the migration must be able to duplicate the
    // three rebuilt local tables and their indexes. Treat every currently used page as possibly
    // owned by those tables, add fixed root/index overhead, and preserve the terminal reserve.
    // This deliberately conservative preflight happens before the first CREATE/INSERT write.
    const worstCaseCopyPages = usedPages + 32;
    const requiredPages = worstCaseCopyPages + WORKER_TRANSPORT_RECOVERY_RESERVE_PAGES;
    if (
      pageCount < 0 ||
      freelistCount < 0 ||
      freelistCount > pageCount ||
      maxPageCount < pageCount ||
      availablePages < requiredPages
    ) {
      throw new WorkerBrokerClientError('CAPACITY_EXCEEDED');
    }
  }

  #copyLegacyInvocations(migrationDeadline: number): void {
    let afterInvocationId = '';
    for (;;) {
      this.#assertMigrationDeadline(migrationDeadline);
      const keys = this.#database
        .prepare(
          `SELECT invocation_id FROM local_invocations
           WHERE invocation_id > ? ORDER BY invocation_id LIMIT 128`,
        )
        .all(afterInvocationId) as Array<{ invocation_id: string }>;
      this.#assertMigrationDeadline(migrationDeadline);
      if (keys.length === 0) return;
      const last = keys.at(-1)?.invocation_id;
      if (last === undefined || last <= afterInvocationId) {
        throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
      }
      this.#database
        .prepare(
          `INSERT INTO local_invocations_v4
           SELECT * FROM local_invocations
           WHERE invocation_id > ? AND invocation_id <= ?
           ORDER BY invocation_id`,
        )
        .run(afterInvocationId, last);
      this.#assertMigrationDeadline(migrationDeadline);
      afterInvocationId = last;
    }
  }

  #legacyInvocationReceiptRows(): Iterable<Record<string, unknown>> {
    return this.#database
      .prepare(
        `SELECT r.*, f.message_id AS frame_message_id,
                f.canonical_digest AS frame_canonical_digest,
                f.logical_digest AS frame_logical_digest,
                f.envelope_json AS frame_envelope_json,
                f.acknowledged_message_id AS frame_acknowledged_message_id,
                f.effect_state AS frame_effect_state
         FROM local_invocation_outbox_receipts AS r
         LEFT JOIN transport_inbound_frames AS f
           ON f.connection_id = r.ack_connection_id AND f.sequence = r.ack_sequence
         ORDER BY r.receipt_id`,
      )
      .iterate() as Iterable<Record<string, unknown>>;
  }

  #assertLegacyInvocationReceipts(deadline: number): void {
    for (const row of this.#legacyInvocationReceiptRows()) {
      this.#assertMigrationDeadline(deadline);
      this.#strictLegacyCloudAck(row, false);
    }
  }

  #copyLegacyInvocationReceipts(deadline: number): void {
    const insert = this.#database.prepare(
      `INSERT INTO local_invocation_outbox_receipts_v4(
         receipt_id, source_event_id, fact_digest, delivery_message_id, ack_message_id,
         ack_connection_id, ack_sequence, ack_canonical_digest, ack_decision,
         ack_logical_digest, cloud_evidence_digest, cloud_committed_at_ms, row_digest
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of this.#legacyInvocationReceiptRows()) {
      this.#assertMigrationDeadline(deadline);
      const ack = this.#strictLegacyCloudAck(row, false);
      const receipt = {
        source_event_id: String(row.source_event_id),
        fact_digest: String(row.fact_digest),
        delivery_message_id: String(row.delivery_message_id),
        ack_message_id: String(row.ack_message_id),
        ack_connection_id: String(row.ack_connection_id),
        ack_sequence: String(row.ack_sequence),
        ack_canonical_digest: String(row.ack_canonical_digest),
        ack_decision: ack.decision,
        ack_logical_digest: ack.logicalDigest,
        cloud_evidence_digest: String(row.cloud_evidence_digest),
        cloud_committed_at_ms: Number(row.cloud_committed_at_ms),
      };
      const migrated = {
        receipt_id: Number(row.receipt_id),
        ...receipt,
        row_digest: sqliteInvocationRowDigest('local_invocation_outbox_receipts', receipt),
      };
      insert.run(...(Object.values(migrated) as Array<string | number>));
    }
  }

  #legacyConversationReadyReceiptRows(): Iterable<Record<string, unknown>> {
    return this.#database
      .prepare(
        `SELECT r.*, f.message_id AS frame_message_id,
                f.canonical_digest AS frame_canonical_digest,
                f.logical_digest AS frame_logical_digest,
                f.envelope_json AS frame_envelope_json,
                f.acknowledged_message_id AS frame_acknowledged_message_id,
                f.effect_state AS frame_effect_state
         FROM local_conversation_ready_outbox_receipts AS r
         LEFT JOIN transport_inbound_frames AS f
           ON f.connection_id = r.ack_connection_id AND f.sequence = r.ack_sequence
         ORDER BY r.receipt_id`,
      )
      .iterate() as Iterable<Record<string, unknown>>;
  }

  #assertLegacyConversationReadyReceipts(deadline: number): void {
    for (const row of this.#legacyConversationReadyReceiptRows()) {
      this.#assertMigrationDeadline(deadline);
      const ack = this.#strictLegacyCloudAck(row, true);
      if (ack.decision !== row.decision) {
        throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
      }
    }
  }

  #copyLegacyConversationReadyReceipts(deadline: number): void {
    const insert = this.#database.prepare(
      `INSERT INTO local_conversation_ready_outbox_receipts_v4(
         receipt_id, source_event_id, conversation_id, fact_digest, delivery_message_id,
         ack_message_id, ack_connection_id, ack_sequence, ack_canonical_digest,
         ack_logical_digest, decision, cloud_decided_at_ms, row_digest
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of this.#legacyConversationReadyReceiptRows()) {
      this.#assertMigrationDeadline(deadline);
      const ack = this.#strictLegacyCloudAck(row, true);
      if (ack.decision !== row.decision) {
        throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
      }
      const receipt = {
        source_event_id: String(row.source_event_id),
        conversation_id: String(row.conversation_id),
        fact_digest: String(row.fact_digest),
        delivery_message_id: String(row.delivery_message_id),
        ack_message_id: String(row.ack_message_id),
        ack_connection_id: String(row.ack_connection_id),
        ack_sequence: String(row.ack_sequence),
        ack_canonical_digest: String(row.ack_canonical_digest),
        ack_logical_digest: ack.logicalDigest,
        decision: ack.decision,
        cloud_decided_at_ms: Number(row.cloud_decided_at_ms),
      };
      const migrated = {
        receipt_id: Number(row.receipt_id),
        ...receipt,
        row_digest: sqliteInvocationRowDigest('local_conversation_ready_outbox_receipts', receipt),
      };
      insert.run(...(Object.values(migrated) as Array<string | number>));
    }
  }

  #strictLegacyCloudAck(
    row: Record<string, unknown>,
    allowSecurityBlock: boolean,
  ): Readonly<{
    decision: 'APPLIED' | 'IDEMPOTENT_REPLAY' | 'SECURITY_BLOCK';
    logicalDigest: string;
  }> {
    try {
      const envelope = BrokerEnvelopeSchema.parse(JSON.parse(String(row.frame_envelope_json)));
      const decision = envelope.kind === 'ack' ? envelope.body.decision : undefined;
      if (
        row.frame_effect_state !== 'APPLIED' ||
        row.frame_message_id !== row.ack_message_id ||
        row.frame_canonical_digest !== row.ack_canonical_digest ||
        row.frame_acknowledged_message_id !== row.delivery_message_id ||
        canonicalizeJson(envelope) !== row.frame_envelope_json ||
        canonicalSha256(envelope) !== row.frame_canonical_digest ||
        envelope.kind !== 'ack' ||
        envelope.type !== 'message.ack' ||
        envelope.messageId !== row.ack_message_id ||
        envelope.connectionId !== row.ack_connection_id ||
        envelope.sequence !== row.ack_sequence ||
        envelope.body.acknowledgedMessageId !== row.delivery_message_id ||
        envelope.body.level !== 'CLOUD_COMMITTED' ||
        !(
          decision === 'APPLIED' ||
          decision === 'IDEMPOTENT_REPLAY' ||
          (allowSecurityBlock && decision === 'SECURITY_BLOCK')
        )
      ) {
        throw new Error('invalid-legacy-cloud-ack');
      }
      return Object.freeze({ decision, logicalDigest: logicalEnvelopeDigest(envelope) });
    } catch {
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
  }

  #assertMigrationTableCount(source: string, target: string): void {
    const sourceCount = this.#database
      .prepare(`SELECT count(*) AS count FROM ${source}`)
      .get() as CountRow;
    const targetCount = this.#database
      .prepare(`SELECT count(*) AS count FROM ${target}`)
      .get() as CountRow;
    if (sourceCount.count !== targetCount.count) {
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
  }

  #captureTransientTransportSchema(): Readonly<{
    tables: readonly string[];
    indexes: readonly string[];
  }> {
    const tableNames = [
      'transport_connections',
      'transport_inbound_frames',
      'transport_inbound_effect_events',
      'transport_outbox',
      'transport_sequence_gaps',
    ] as const;
    const indexNames = [
      'transport_one_active_connection',
      'transport_connection_retention',
      'transport_pending_inbound',
      'transport_inbound_retention',
      'transport_inbound_message',
      'transport_inbound_acknowledged_message',
      'transport_inbound_effect_event_order',
      'transport_outbox_connection_sequence',
      'transport_outbox_persisted_response',
      'transport_outbox_delivery',
      'transport_outbox_retention',
      'transport_sequence_gap_retention',
    ] as const;
    const load = (type: 'table' | 'index', name: string): string => {
      const row = this.#database
        .prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
        .get(type, name) as { sql: string | null } | undefined;
      if (row?.sql === null || row?.sql === undefined) {
        throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
      }
      return row.sql;
    };
    return Object.freeze({
      tables: Object.freeze(tableNames.map((name) => load('table', name))),
      indexes: Object.freeze(indexNames.map((name) => load('index', name))),
    });
  }

  #assertNoLocalTransportForeignKeys(): void {
    const transientTransportTables = new Set([
      'transport_connections',
      'transport_inbound_frames',
      'transport_inbound_effect_events',
      'transport_outbox',
      'transport_sequence_gaps',
    ]);
    const localTables = this.#database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'local_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    for (const table of localTables) {
      const foreignKeys = this.#database
        .prepare(`PRAGMA foreign_key_list(${table.name})`)
        .all() as Array<{ table: string }>;
      if (foreignKeys.some((foreignKey) => transientTransportTables.has(foreignKey.table))) {
        throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
      }
    }
  }

  #assertMigrationDeadline(deadline: number): void {
    if (performance.now() >= deadline) throw new SqliteWorkerTransportError('JOURNAL_ABORTED');
  }

  #rebuildLegacyConversationsWithoutTransportForeignKey(deadline: number): void {
    this.#assertMigrationDeadline(deadline);
    const foreignKeys = this.#database
      .prepare('PRAGMA foreign_key_list(local_conversations)')
      .all() as Array<{ table: string; from: string }>;
    if (
      !foreignKeys.some(
        (row) => row.table === 'transport_inbound_frames' && row.from === 'open_connection_id',
      )
    ) {
      return;
    }
    this.#database.exec(`
      DROP INDEX local_conversation_installation_state;
      CREATE TABLE local_conversations_v3 (
        conversation_id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL REFERENCES transport_installations(installation_id),
        deployment_id TEXT NOT NULL,
        agent_version_id TEXT NOT NULL,
        agent_version_digest TEXT NOT NULL,
        snapshot_digest TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        worker_session_id TEXT NOT NULL,
        fence TEXT NOT NULL,
        open_command_id TEXT NOT NULL UNIQUE,
        open_connection_id TEXT NOT NULL,
        open_sequence TEXT NOT NULL,
        sandbox_instance_id TEXT NOT NULL,
        runtime_thread_id TEXT,
        ready_evidence_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('READY', 'CLOSED', 'UNCERTAIN')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        row_digest TEXT NOT NULL
      ) STRICT;
      INSERT INTO local_conversations_v3 SELECT * FROM local_conversations;
      DROP TABLE local_conversations;
      ALTER TABLE local_conversations_v3 RENAME TO local_conversations;
      CREATE INDEX local_conversation_installation_state
        ON local_conversations(installation_id, state, created_at_ms);
    `);
    this.#assertMigrationDeadline(deadline);
  }

  #assertConversationReadyMigrationCapacity(deadline: number): void {
    if (performance.now() >= deadline) throw new SqliteWorkerTransportError('JOURNAL_ABORTED');
    const count = this.#database
      .prepare('SELECT count(*) AS count FROM local_conversations')
      .get() as CountRow | undefined;
    if (count === undefined || !Number.isSafeInteger(count.count) || count.count < 0) {
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
    if (count.count > this.#maxRetainedOutboxRows) {
      throw new WorkerBrokerClientError('CAPACITY_EXCEEDED');
    }
    const availablePages =
      pragmaNumber(this.#database, 'max_page_count') -
      pragmaNumber(this.#database, 'page_count') +
      pragmaNumber(this.#database, 'freelist_count') -
      WORKER_TRANSPORT_RECOVERY_RESERVE_PAGES;
    const minimumRequiredPages = count.count === 0 ? 8 : 8 + count.count * 2;
    if (availablePages < minimumRequiredPages) {
      throw new WorkerBrokerClientError('CAPACITY_EXCEEDED');
    }
  }

  #refreshMigratedConversationDigests(deadline: number): void {
    let afterConversationId = '';
    for (;;) {
      if (performance.now() >= deadline) throw new SqliteWorkerTransportError('JOURNAL_ABORTED');
      const rows = this.#database
        .prepare(
          `SELECT * FROM local_conversations WHERE conversation_id > ?
           ORDER BY conversation_id LIMIT 128`,
        )
        .all(afterConversationId) as Array<Record<string, unknown>>;
      if (rows.length === 0) return;
      for (const conversation of rows) {
        const payload = { ...conversation };
        delete payload.row_digest;
        this.#database
          .prepare('UPDATE local_conversations SET row_digest = ? WHERE conversation_id = ?')
          .run(
            sqliteInvocationRowDigest('local_conversations', payload),
            String(conversation.conversation_id),
          );
      }
      afterConversationId = String(rows.at(-1)?.conversation_id);
    }
  }

  #backfillConversationReadyAuthority(deadline: number): void {
    let afterConversationId = '';
    for (;;) {
      if (performance.now() >= deadline) throw new SqliteWorkerTransportError('JOURNAL_ABORTED');
      const conversations = this.#database
        .prepare(
          `SELECT * FROM local_conversations WHERE conversation_id > ?
           ORDER BY conversation_id LIMIT 128`,
        )
        .all(afterConversationId) as Array<Record<string, unknown>>;
      if (conversations.length === 0) return;
      for (const conversation of conversations) {
        const inbound = this.#database
          .prepare(
            `SELECT f.message_id, f.canonical_digest, f.envelope_json,
                    f.envelope_kind, f.envelope_type,
                    c.installation_id, c.connection_id, c.deployment_id,
                    c.worker_session_id, c.lease_id, c.fence,
                    consumed.semantic_digest AS open_semantic_digest
             FROM transport_inbound_frames AS f
             JOIN transport_connections AS c ON c.connection_id = f.connection_id
             JOIN local_consumed_commands AS consumed ON consumed.command_id = f.message_id
             WHERE f.connection_id = ? AND f.sequence = ?`,
          )
          .get(String(conversation.open_connection_id), String(conversation.open_sequence)) as
          | (StoredConnectionAuthorityRow & Record<string, unknown>)
          | undefined;
        if (inbound === undefined) throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
        const stored = decodeStoredBrokerEnvelope(
          String(inbound.envelope_json),
          String(inbound.canonical_digest),
        );
        const envelope = materializeStoredInboundEnvelope(
          stored,
          inbound,
          conversation,
          String(inbound.open_semantic_digest),
        );
        if (
          conversation.state !== 'READY' ||
          inbound.envelope_kind !== 'command' ||
          inbound.envelope_type !== 'conversation.open' ||
          envelope.kind !== 'command' ||
          envelope.type !== 'conversation.open' ||
          envelope.messageId !== inbound.message_id ||
          envelope.messageId !== conversation.open_command_id ||
          envelope.body.conversationId !== conversation.conversation_id ||
          envelope.body.agentVersionId !== conversation.agent_version_id ||
          envelope.body.agentVersionDigest !== conversation.agent_version_digest ||
          envelope.body.snapshotDigest !== conversation.snapshot_digest ||
          envelope.body.openAuthority.installationId !== conversation.installation_id ||
          envelope.body.openAuthority.deploymentId !== conversation.deployment_id ||
          envelope.body.openAuthority.workerSessionId !== conversation.worker_session_id ||
          envelope.body.openAuthority.leaseId !== conversation.lease_id ||
          envelope.body.openAuthority.fence !== conversation.fence
        ) {
          throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
        }
        let fact;
        try {
          fact = WorkerConversationReadyFactSchema.parse({
            protocol: 'combo.worker-conversation-ready-fact/1',
            schemaVersion: 1,
            type: 'conversation.ready',
            sourceEventId: envelope.messageId,
            conversationId: envelope.body.conversationId,
            openCommandId: envelope.messageId,
            deploymentId: envelope.body.openAuthority.deploymentId,
            agentVersionId: envelope.body.agentVersionId,
            agentVersionDigest: envelope.body.agentVersionDigest,
            snapshotDigest: envelope.body.snapshotDigest,
            installationId: envelope.body.openAuthority.installationId,
            workerSessionId: envelope.body.openAuthority.workerSessionId,
            leaseId: envelope.body.openAuthority.leaseId,
            fence: envelope.body.openAuthority.fence,
            sandboxInstanceId: conversation.sandbox_instance_id,
            runtimeThreadId: conversation.runtime_thread_id,
            readyEvidenceDigest: conversation.ready_evidence_digest,
          });
        } catch {
          throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
        }
        const factDigest = workerConversationReadyFactDigest(fact);
        const factJson = canonicalizeJson(fact);
        const factRow = {
          source_event_id: fact.sourceEventId,
          conversation_id: fact.conversationId,
          open_command_id: fact.openCommandId,
          fact_digest: factDigest,
          fact_json: factJson,
          original_connection_id: String(conversation.open_connection_id),
          original_sequence: String(conversation.open_sequence),
          original_canonical_digest: String(inbound.canonical_digest),
          created_at_ms: Number(conversation.created_at_ms),
        };
        this.#database
          .prepare(
            `INSERT INTO local_conversation_ready_facts(
             source_event_id, conversation_id, open_command_id, fact_digest, fact_json,
             original_connection_id, original_sequence, original_canonical_digest,
             created_at_ms, row_digest
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ...Object.values(factRow),
            sqliteInvocationRowDigest('local_conversation_ready_facts', factRow),
          );
        const outboxRow = {
          source_event_id: fact.sourceEventId,
          conversation_id: fact.conversationId,
          correlation_id: fact.conversationId,
          fact_digest: factDigest,
          fact_json: factJson,
          created_at_ms: Number(conversation.created_at_ms),
        };
        this.#database
          .prepare(
            `INSERT INTO local_conversation_ready_outbox(
             source_event_id, conversation_id, correlation_id, fact_digest, fact_json,
             created_at_ms, row_digest
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ...Object.values(outboxRow),
            sqliteInvocationRowDigest('local_conversation_ready_outbox', outboxRow),
          );
      }
      afterConversationId = String(conversations.at(-1)?.conversation_id);
    }
  }

  #configureWithBusyRetry(existed: boolean): void {
    const deadline = performance.now() + this.#busyTimeoutMs;
    for (;;) {
      try {
        this.#configureAndMigrate(existed);
        return;
      } catch (error) {
        if (!isSqliteBusy(error) || performance.now() >= deadline) throw error;
        Atomics.wait(
          SQLITE_BUSY_WAIT,
          0,
          0,
          Math.min(10, Math.max(1, deadline - performance.now())),
        );
      }
    }
  }

  #assertPragmas(): void {
    const pragmas = this.inspectPragmas();
    if (
      pragmas.applicationId !== WORKER_TRANSPORT_APPLICATION_ID ||
      pragmas.userVersion !== WORKER_TRANSPORT_SCHEMA_VERSION ||
      pragmas.journalMode.toLowerCase() !== 'wal' ||
      pragmas.synchronous !== 2 ||
      pragmas.foreignKeys !== 1 ||
      pragmas.secureDelete !== 1 ||
      pragmas.busyTimeoutMs !== this.#busyTimeoutMs ||
      pragmas.maxPageCount !== Math.floor(this.#maxDatabaseBytes / pragmas.pageSize) ||
      pragmas.journalSizeLimit !== this.#maxWalBytes ||
      pragmas.walAutocheckpoint !== 256 ||
      pragmas.quickCheck.toLowerCase() !== 'ok'
    ) {
      throw new SqliteWorkerTransportError('JOURNAL_PRAGMA_MISMATCH');
    }
  }

  #validateOpenSnapshot(): void {
    const deadline = performance.now() + this.#busyTimeoutMs;
    for (;;) {
      this.#database.exec('BEGIN');
      let completed = false;
      let databaseWatermark: JournalCommitWatermark;
      try {
        this.#assertPragmas();
        this.#assertDatabaseIntegrity();
        this.#assertSchemaDigest();
        this.#assertStoredEnvelopeIntegrity();
        try {
          assertWorkerInvocationIntegrity(this.#database);
          assertWorkerConversationReadyIntegrity(this.#database);
        } catch {
          throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
        }
        databaseWatermark = this.#readDatabaseWatermark();
        this.#database.exec('COMMIT');
        completed = true;
      } finally {
        if (!completed) safeRollback(this.#database);
      }
      try {
        this.#recoverMigrationWatermarkIfNeeded(databaseWatermark);
        this.#assertExternalWatermark(databaseWatermark);
        return;
      } catch (error) {
        if (!(error instanceof CommitWatermarkMismatchError) || performance.now() >= deadline) {
          throw error;
        }
        Atomics.wait(
          SQLITE_BUSY_WAIT,
          0,
          0,
          Math.min(10, Math.max(1, deadline - performance.now())),
        );
      }
    }
  }

  #readDatabaseWatermark(): JournalCommitWatermark;
  #readDatabaseWatermark(schemaVersion: 1 | 2 | 3): LegacyJournalCommitWatermark;
  #readDatabaseWatermark(schemaVersion: 4): JournalCommitWatermark;
  #readDatabaseWatermark(schemaVersion?: 1 | 2 | 3 | 4): AnyJournalCommitWatermark {
    const row = this.#database
      .prepare(
        `SELECT schema_digest, authority_digest, installation_id, journal_generation,
                authorization_digest, commit_epoch, inbound_evidence_count,
                inbound_evidence_xor, outbox_evidence_count, outbox_evidence_xor,
                max_database_bytes, max_wal_bytes, min_free_bytes
         FROM transport_meta WHERE singleton = 1`,
      )
      .get() as
      | {
          schema_digest: string;
          authority_digest: string;
          installation_id: string;
          journal_generation: string;
          authorization_digest: string;
          commit_epoch: number;
          inbound_evidence_count: number;
          inbound_evidence_xor: string;
          outbox_evidence_count: number;
          outbox_evidence_xor: string;
          max_database_bytes: number;
          max_wal_bytes: number;
          min_free_bytes: number;
        }
      | undefined;
    if (
      row === undefined ||
      !Number.isSafeInteger(row.commit_epoch) ||
      row.commit_epoch < 1 ||
      !Number.isSafeInteger(row.inbound_evidence_count) ||
      !Number.isSafeInteger(row.outbox_evidence_count) ||
      row.max_database_bytes !== this.#maxDatabaseBytes ||
      row.max_wal_bytes !== this.#maxWalBytes ||
      row.min_free_bytes !== this.#minFreeBytes ||
      !SHA256_HEX.test(row.schema_digest) ||
      !SHA256_HEX.test(row.authority_digest) ||
      !SHA256_HEX.test(row.authorization_digest) ||
      !SHA256_HEX.test(row.inbound_evidence_xor) ||
      !SHA256_HEX.test(row.outbox_evidence_xor)
    ) {
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
    const common = {
      applicationId: WORKER_TRANSPORT_APPLICATION_ID,
      schemaDigest: row.schema_digest,
      authorityDigest: row.authority_digest,
      installationId: row.installation_id,
      journalGeneration: row.journal_generation,
      authorizationDigest: row.authorization_digest,
      commitEpoch: row.commit_epoch,
      inboundEvidenceCount: row.inbound_evidence_count,
      inboundEvidenceXor: row.inbound_evidence_xor,
      outboxEvidenceCount: row.outbox_evidence_count,
      outboxEvidenceXor: row.outbox_evidence_xor,
      maxDatabaseBytes: row.max_database_bytes,
      maxWalBytes: row.max_wal_bytes,
      minFreeBytes: row.min_free_bytes,
    };
    if (schemaVersion !== undefined && schemaVersion <= 3) {
      return Object.freeze({
        ...common,
        formatVersion: LEGACY_WATERMARK_FORMAT_VERSION,
        schemaVersion,
      });
    }
    return Object.freeze({
      ...common,
      formatVersion: WATERMARK_FORMAT_VERSION,
      evidenceVersion: WATERMARK_EVIDENCE_VERSION,
      schemaVersion: (schemaVersion ?? WORKER_TRANSPORT_SCHEMA_VERSION) as 4 | 5,
      currentConnectionAuthority: this.#currentConnectionAuthority(row.installation_id),
    });
  }

  #currentConnectionAuthority(installationId: string): CurrentConnectionAuthority | null {
    const rows = this.#database
      .prepare(`SELECT * FROM transport_connections WHERE status = 'ACTIVE' LIMIT 2`)
      .all() as ConnectionRow[];
    if (rows.length === 0) return null;
    const connection = rows[0];
    if (
      rows.length !== 1 ||
      connection === undefined ||
      connection.installation_id !== installationId ||
      connectionStateDigestFromRow(connection) !== connection.connection_digest
    ) {
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
    return Object.freeze({
      installationId: connection.installation_id,
      connectionId: connection.connection_id,
      connectionDigest: connection.connection_digest,
    });
  }

  #writeExternalWatermark(watermark: AnyJournalCommitWatermark): void {
    const payload = canonicalizeJson(watermark);
    const domain =
      watermark.formatVersion === LEGACY_WATERMARK_FORMAT_VERSION
        ? LEGACY_WATERMARK_DIGEST_DOMAIN
        : WATERMARK_DIGEST_DOMAIN;
    const document = canonicalizeJson({
      payload: watermark,
      digest: createHash('sha256').update(domain, 'utf8').update(payload, 'utf8').digest('hex'),
    });
    if (journalEntryExists(this.#watermarkFilename)) {
      ensureSafeRegularFile(this.#watermarkFilename, 0o600, 'JOURNAL_FILE_UNSAFE');
    }
    atomicWritePrivateFile(this.#watermarkFilename, document);
  }

  #prepareMigrationRecoveryManifest(
    legacyWatermark: AnyJournalCommitWatermark,
  ): MigrationRecoveryManifest {
    if (
      (legacyWatermark.schemaVersion !== WORKER_CONVERSATION_READY_SCHEMA_VERSION &&
        legacyWatermark.schemaVersion !== WORKER_DEFENSIVE_INTEGRITY_SCHEMA_VERSION) ||
      (legacyWatermark.schemaVersion === WORKER_CONVERSATION_READY_SCHEMA_VERSION
        ? legacyWatermark.formatVersion !== LEGACY_WATERMARK_FORMAT_VERSION
        : legacyWatermark.formatVersion !== WATERMARK_FORMAT_VERSION)
    ) {
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
    const manifest = Object.freeze({
      formatVersion: MIGRATION_RECOVERY_FORMAT_VERSION,
      nonce: uuidV7(),
      legacySlot: Object.freeze({
        schemaVersion: legacyWatermark.schemaVersion,
        commitEpoch: legacyWatermark.commitEpoch,
        watermark: legacyWatermark,
      }),
      candidateSlot: null,
      finalizedSlot: null,
    }) satisfies MigrationRecoveryManifest;
    this.#writeMigrationRecoveryManifest(manifest);
    return manifest;
  }

  #recordMigrationRecoveryCandidate(
    manifest: MigrationRecoveryManifest,
    candidateWatermark: JournalCommitWatermark,
  ): MigrationRecoveryManifest {
    const candidateSchemaVersion = manifest.legacySlot.schemaVersion + 1;
    if (
      candidateWatermark.commitEpoch !== manifest.legacySlot.commitEpoch + 1 ||
      candidateWatermark.schemaVersion !== candidateSchemaVersion ||
      candidateWatermark.applicationId !== manifest.legacySlot.watermark.applicationId ||
      candidateWatermark.installationId !== manifest.legacySlot.watermark.installationId ||
      candidateWatermark.journalGeneration !== manifest.legacySlot.watermark.journalGeneration ||
      candidateWatermark.authorizationDigest !==
        manifest.legacySlot.watermark.authorizationDigest ||
      candidateWatermark.maxDatabaseBytes !== manifest.legacySlot.watermark.maxDatabaseBytes ||
      candidateWatermark.maxWalBytes !== manifest.legacySlot.watermark.maxWalBytes ||
      candidateWatermark.minFreeBytes !== manifest.legacySlot.watermark.minFreeBytes ||
      candidateWatermark.inboundEvidenceCount !==
        (manifest.legacySlot.schemaVersion === WORKER_CONVERSATION_READY_SCHEMA_VERSION
          ? 0
          : manifest.legacySlot.watermark.inboundEvidenceCount) ||
      candidateWatermark.inboundEvidenceXor !==
        (manifest.legacySlot.schemaVersion === WORKER_CONVERSATION_READY_SCHEMA_VERSION
          ? ZERO_DIGEST
          : manifest.legacySlot.watermark.inboundEvidenceXor) ||
      candidateWatermark.outboxEvidenceCount !==
        (manifest.legacySlot.schemaVersion === WORKER_CONVERSATION_READY_SCHEMA_VERSION
          ? 0
          : manifest.legacySlot.watermark.outboxEvidenceCount) ||
      candidateWatermark.outboxEvidenceXor !==
        (manifest.legacySlot.schemaVersion === WORKER_CONVERSATION_READY_SCHEMA_VERSION
          ? ZERO_DIGEST
          : manifest.legacySlot.watermark.outboxEvidenceXor) ||
      (manifest.legacySlot.watermark.formatVersion === WATERMARK_FORMAT_VERSION
        ? canonicalizeJson(candidateWatermark.currentConnectionAuthority) !==
          canonicalizeJson(manifest.legacySlot.watermark.currentConnectionAuthority)
        : candidateWatermark.currentConnectionAuthority !== null)
    ) {
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
    const candidate = Object.freeze({
      ...manifest,
      candidateSlot: Object.freeze({
        schemaVersion: candidateSchemaVersion as 4 | 5,
        commitEpoch: candidateWatermark.commitEpoch,
        watermark: candidateWatermark,
      }),
      finalizedSlot: null,
    });
    this.#writeMigrationRecoveryManifest(candidate);
    return candidate;
  }

  #finalizeMigrationRecoveryManifest(
    manifest: MigrationRecoveryManifest,
    candidateWatermark: JournalCommitWatermark,
  ): void {
    const candidateSchemaVersion = manifest.legacySlot.schemaVersion + 1;
    if (
      manifest.candidateSlot === null ||
      canonicalizeJson(manifest.candidateSlot.watermark) !== canonicalizeJson(candidateWatermark)
    ) {
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
    this.#writeMigrationRecoveryManifest(
      Object.freeze({
        ...manifest,
        candidateSlot: null,
        finalizedSlot: Object.freeze({
          schemaVersion: candidateSchemaVersion as 4 | 5,
          commitEpoch: candidateWatermark.commitEpoch,
          candidateDigest: migrationRecoveryCandidateDigest(candidateWatermark),
        }),
      }),
    );
  }

  #recoverMigrationWatermarkIfNeeded(expected: AnyJournalCommitWatermark): void {
    if (!journalEntryExists(this.#migrationRecoveryFilename)) return;
    const manifest = readMigrationRecoveryManifest(this.#migrationRecoveryFilename);
    const legacy = manifest.legacySlot;
    if (
      legacy.watermark.installationId !== expected.installationId ||
      legacy.watermark.journalGeneration !== expected.journalGeneration ||
      legacy.watermark.authorizationDigest !== expected.authorizationDigest ||
      legacy.watermark.maxDatabaseBytes !== expected.maxDatabaseBytes ||
      legacy.watermark.maxWalBytes !== expected.maxWalBytes ||
      legacy.watermark.minFreeBytes !== expected.minFreeBytes
    ) {
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
    if (expected.schemaVersion === legacy.schemaVersion) {
      if (
        expected.formatVersion !== legacy.watermark.formatVersion ||
        legacy.commitEpoch !== expected.commitEpoch ||
        canonicalizeJson(legacy.watermark) !== canonicalizeJson(expected) ||
        manifest.finalizedSlot !== null
      ) {
        throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
      }
      this.#writeExternalWatermark(expected);
      if (manifest.candidateSlot !== null) {
        this.#writeMigrationRecoveryManifest(
          Object.freeze({
            ...manifest,
            candidateSlot: null,
            finalizedSlot: null,
          }),
        );
      }
      return;
    }
    if (
      expected.formatVersion !== WATERMARK_FORMAT_VERSION ||
      expected.schemaVersion !== legacy.schemaVersion + 1
    ) {
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
    if (manifest.candidateSlot !== null) {
      if (
        manifest.finalizedSlot !== null ||
        manifest.candidateSlot.commitEpoch !== expected.commitEpoch ||
        canonicalizeJson(manifest.candidateSlot.watermark) !== canonicalizeJson(expected)
      ) {
        throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
      }
      this.#writeExternalWatermark(expected);
      this.#finalizeMigrationRecoveryManifest(manifest, expected);
      return;
    }
    const finalized = manifest.finalizedSlot;
    if (
      finalized === null ||
      expected.commitEpoch < finalized.commitEpoch ||
      (expected.commitEpoch === finalized.commitEpoch &&
        migrationRecoveryCandidateDigest(expected) !== finalized.candidateDigest)
    ) {
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
    // A finalized recovery point is audit-only. In particular, it never recreates a missing or
    // modified current watermark; the normal external-watermark assertion below remains the sole
    // authority for all post-migration commits.
  }

  #writeMigrationRecoveryManifest(manifest: MigrationRecoveryManifest): void {
    const payload = canonicalizeJson(manifest);
    const document = canonicalizeJson({
      payload: manifest,
      digest: createHash('sha256')
        .update(MIGRATION_RECOVERY_DIGEST_DOMAIN, 'utf8')
        .update(payload, 'utf8')
        .digest('hex'),
    });
    if (journalEntryExists(this.#migrationRecoveryFilename)) {
      ensureSafeRegularFile(this.#migrationRecoveryFilename, 0o600, 'JOURNAL_FILE_UNSAFE');
    }
    atomicWritePrivateFile(this.#migrationRecoveryFilename, document);
  }

  #assertExternalWatermark(expected: AnyJournalCommitWatermark): void {
    if (!journalEntryExists(this.#watermarkFilename)) {
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
    ensureSafeRegularFile(this.#watermarkFilename, 0o600, 'JOURNAL_FILE_UNSAFE');
    try {
      const raw = readFileSync(this.#watermarkFilename, 'utf8');
      const parsed = JSON.parse(raw) as { payload?: unknown; digest?: unknown };
      const payload = parsed.payload as AnyJournalCommitWatermark;
      const canonicalPayload = canonicalizeJson(payload);
      const domain =
        expected.formatVersion === LEGACY_WATERMARK_FORMAT_VERSION
          ? LEGACY_WATERMARK_DIGEST_DOMAIN
          : WATERMARK_DIGEST_DOMAIN;
      const expectedDigest = createHash('sha256')
        .update(domain, 'utf8')
        .update(canonicalPayload, 'utf8')
        .digest('hex');
      if (parsed.digest !== expectedDigest || canonicalizeJson(parsed) !== raw) {
        throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
      }
      if (canonicalPayload !== canonicalizeJson(expected)) throw new CommitWatermarkMismatchError();
    } catch (error) {
      if (
        error instanceof CommitWatermarkMismatchError ||
        error instanceof SqliteWorkerTransportError
      ) {
        throw error;
      }
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
  }

  #assertDatabaseIntegrity(): void {
    if (
      pragmaText(this.#database, 'integrity_check').toLowerCase() !== 'ok' ||
      this.#database.prepare('PRAGMA foreign_key_check').get() !== undefined
    ) {
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
  }

  #assertSchemaDigest(): void {
    const row = this.#database
      .prepare(
        `SELECT schema_digest, authority_digest, installation_id, journal_generation,
                authorization_digest, max_database_bytes, max_wal_bytes, min_free_bytes
         FROM transport_meta WHERE singleton = 1`,
      )
      .get() as
      | {
          schema_digest: string;
          authority_digest: string;
          installation_id: string;
          journal_generation: string;
          authorization_digest: string;
          max_database_bytes: number;
          max_wal_bytes: number;
          min_free_bytes: number;
        }
      | undefined;
    const authorization = this.#newJournalAuthorization;
    if (
      row === undefined ||
      row.schema_digest !== this.#actualSchemaDigest() ||
      row.authority_digest !== this.#actualAuthorityDigest() ||
      !UuidSchema.safeParse(row.installation_id).success ||
      !UuidSchema.safeParse(row.journal_generation).success ||
      !SHA256_HEX.test(row.authorization_digest) ||
      row.max_database_bytes !== this.#maxDatabaseBytes ||
      row.max_wal_bytes !== this.#maxWalBytes ||
      row.min_free_bytes !== this.#minFreeBytes ||
      (authorization !== undefined &&
        (authorization.installationId !== row.installation_id ||
          authorization.journalGeneration !== row.journal_generation ||
          authorization.authorizationDigest !== row.authorization_digest))
    ) {
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
  }

  #assertStoredEnvelopeIntegrity(): void {
    try {
      const defensiveIntegrityV4 =
        pragmaNumber(this.#database, 'user_version') >= WORKER_DEFENSIVE_INTEGRITY_SCHEMA_VERSION;
      const provisioned = this.#database
        .prepare(
          `SELECT installation_id, inbound_evidence_count, inbound_evidence_xor,
                  outbox_evidence_count, outbox_evidence_xor
           FROM transport_meta WHERE singleton = 1`,
        )
        .get() as
        | {
            installation_id: string;
            inbound_evidence_count: number;
            inbound_evidence_xor: string;
            outbox_evidence_count: number;
            outbox_evidence_xor: string;
          }
        | undefined;
      const installations = [
        ...(this.#database
          .prepare('SELECT installation_id, highest_owner_epoch FROM transport_installations')
          .iterate() as Iterable<{ installation_id: string; highest_owner_epoch: number }>),
      ];
      if (
        provisioned === undefined ||
        installations.length !== 1 ||
        installations[0]?.installation_id !== provisioned.installation_id
      ) {
        throw new Error('installation-provision-mismatch');
      }
      for (const installation of installations) {
        if (!Number.isSafeInteger(installation.highest_owner_epoch)) {
          throw new Error('invalid-owner-epoch');
        }
        const maximum = this.#database
          .prepare(
            `SELECT max(owner_epoch) AS maximum FROM (
               SELECT owner_epoch FROM transport_installation_owners WHERE installation_id = ?
               UNION ALL
               SELECT owner_epoch FROM transport_connections WHERE installation_id = ?
             )`,
          )
          .get(installation.installation_id, installation.installation_id) as {
          maximum: number | null;
        };
        if ((maximum.maximum ?? 0) > installation.highest_owner_epoch) {
          throw new Error('owner-epoch-rollback');
        }
      }

      const owners = this.#database
        .prepare(
          `SELECT o.installation_id, o.owner_token_digest, o.owner_epoch,
                  o.lease_expires_at_ms, o.acquired_at_ms, o.updated_at_ms,
                  i.highest_owner_epoch
           FROM transport_installation_owners AS o
           JOIN transport_installations AS i ON i.installation_id = o.installation_id`,
        )
        .iterate() as Iterable<{
        installation_id: string;
        owner_token_digest: string;
        owner_epoch: number;
        lease_expires_at_ms: number;
        acquired_at_ms: number;
        updated_at_ms: number;
        highest_owner_epoch: number;
      }>;
      for (const owner of owners) {
        if (
          !SHA256_HEX.test(owner.owner_token_digest) ||
          !Number.isSafeInteger(owner.owner_epoch) ||
          owner.owner_epoch < 1 ||
          owner.owner_epoch !== owner.highest_owner_epoch ||
          !Number.isSafeInteger(owner.lease_expires_at_ms) ||
          !Number.isSafeInteger(owner.acquired_at_ms) ||
          !Number.isSafeInteger(owner.updated_at_ms) ||
          owner.acquired_at_ms < 0 ||
          owner.updated_at_ms < owner.acquired_at_ms ||
          owner.lease_expires_at_ms <= owner.updated_at_ms
        ) {
          throw new Error('invalid-owner');
        }
      }

      const fenceWatermarks = this.#database
        .prepare(
          `SELECT installation_id, deployment_id, highest_fence
           FROM transport_deployment_fences`,
        )
        .iterate() as Iterable<{
        installation_id: string;
        deployment_id: string;
        highest_fence: string;
      }>;
      for (const watermark of fenceWatermarks) {
        const highestFence = BigInt(parseUint63(watermark.highest_fence));
        const maximum = this.#database
          .prepare(
            `SELECT fence FROM transport_connections
             WHERE installation_id = ? AND deployment_id = ?
             ORDER BY length(fence) DESC, fence DESC LIMIT 1`,
          )
          .get(watermark.installation_id, watermark.deployment_id) as { fence: string } | undefined;
        if (maximum !== undefined && BigInt(parseUint63(maximum.fence)) > highestFence) {
          throw new Error('fence-watermark-rollback');
        }
      }

      const connectionAuthorities = new Map<string, ConnectionRow>();
      const connections = this.#database
        .prepare(
          `SELECT installation_id, connection_id, owner_epoch, worker_session_id, deployment_id,
                  lease_id, fence, lease_state, lease_granted_at, lease_expires_at,
                  inbound_cursor, outbound_cursor, status, activation_message_id,
                  activation_digest, connection_digest, created_at_ms, released_at_ms
           FROM transport_connections`,
        )
        .iterate() as Iterable<ConnectionRow>;
      let totalConnectionCount = 0;
      for (const connection of connections) {
        totalConnectionCount += 1;
        connectionAuthorities.set(connection.connection_id, connection);
        if (
          !Number.isSafeInteger(connection.owner_epoch) ||
          connection.owner_epoch < 1 ||
          connectionStateDigestFromRow(connection) !== connection.connection_digest ||
          !Number.isFinite(Date.parse(connection.lease_granted_at)) ||
          Date.parse(connection.lease_expires_at) <= Date.parse(connection.lease_granted_at) ||
          !Number.isSafeInteger(connection.created_at_ms) ||
          connection.created_at_ms < 0 ||
          (connection.status === 'ACTIVE' && connection.released_at_ms !== null) ||
          (connection.status === 'RELEASED' &&
            (connection.released_at_ms === null ||
              !Number.isSafeInteger(connection.released_at_ms) ||
              connection.released_at_ms < connection.created_at_ms))
        ) {
          throw new Error('invalid-connection');
        }
        durableConnection(connection);
        const activation = this.#database
          .prepare(
            `SELECT canonical_digest, envelope_json, effect_state
             FROM transport_inbound_frames
             WHERE connection_id = ? AND message_id = ?`,
          )
          .get(connection.connection_id, connection.activation_message_id) as
          | { canonical_digest: string; envelope_json: string; effect_state: string }
          | undefined;
        if (
          activation === undefined ||
          activation.canonical_digest !== connection.activation_digest ||
          activation.effect_state !== 'APPLIED'
        ) {
          throw new Error('activation-proof-missing');
        }
        const activationEnvelope = parseStoredEnvelope(
          activation.envelope_json,
          activation.canonical_digest,
        );
        if (
          activationEnvelope.kind !== 'command' ||
          activationEnvelope.type !== 'lease.grant' ||
          activationEnvelope.connectionId !== connection.connection_id ||
          activationEnvelope.sequence !== '0'
        ) {
          throw new Error('activation-proof-invalid');
        }
      }
      if (totalConnectionCount > this.#maxConnections) throw new Error('connection-capacity-drift');

      const latestEffectEvents = new Map<string, InboundEffectEventRow>();
      const effectEvents = this.#database
        .prepare(
          `SELECT event_id, connection_id, sequence, message_id, from_state, to_state,
                  reason, occurred_at_ms, event_digest
           FROM transport_inbound_effect_events ORDER BY event_id`,
        )
        .iterate() as Iterable<InboundEffectEventRow>;
      for (const event of effectEvents) {
        const key = `${event.connection_id}\0${event.sequence}`;
        const previous = latestEffectEvents.get(key);
        if (
          inboundEffectEventDigestFromRow(event) !== event.event_digest ||
          (previous === undefined
            ? event.from_state !== null
            : event.from_state !== previous.to_state || event.message_id !== previous.message_id)
        ) {
          throw new Error('invalid-effect-event');
        }
        latestEffectEvents.set(key, event);
      }

      const acknowledgedLevels = new Map<string, number>();
      const inboundKeys = new Set<string>();
      const inboundMessageDigests = new Map<string, string>();
      const inboundCommandTypes = new Map<string, BrokerCommand['type']>();
      let inboundEvidenceXor = ZERO_DIGEST;
      let inboundEvidenceCount = 0;
      let pendingInboundCount = 0;
      const locallyConsumedCommands = workerInvocationTablesExist(this.#database)
        ? new Map(
            (
              this.#database
                .prepare(
                  'SELECT command_id, command_type, semantic_digest FROM local_consumed_commands',
                )
                .all() as Array<{
                command_id: string;
                command_type: BrokerCommand['type'];
                semantic_digest: string;
              }>
            ).map(
              (row) =>
                [
                  row.command_id,
                  { type: row.command_type, semanticDigest: row.semantic_digest },
                ] as const,
            ),
          )
        : new Map<string, Readonly<{ type: BrokerCommand['type']; semanticDigest: string }>>();
      const localConversationsByOpenCommand = workerInvocationTablesExist(this.#database)
        ? new Map(
            (
              this.#database.prepare('SELECT * FROM local_conversations').all() as Array<
                Record<string, unknown>
              >
            ).map((row) => [String(row.open_command_id), row] as const),
          )
        : new Map<string, Record<string, unknown>>();
      const inboundRows = this.#database
        .prepare(
          `SELECT connection_id, sequence, message_id, canonical_digest, logical_digest,
                  envelope_json, envelope_kind, envelope_type, acknowledged_message_id,
                  effect_state, effect_digest, replay_count, recorded_at_ms, applied_at_ms,
                  retained_until_ms
           FROM transport_inbound_frames`,
        )
        .iterate() as Iterable<
        InboundEffectRow & {
          connection_id: string;
          logical_digest: string;
          envelope_json: string;
          envelope_kind: 'command' | 'ack';
          envelope_type: string;
          acknowledged_message_id: string | null;
        }
      >;
      for (const row of inboundRows) {
        const inboundKey = `${row.connection_id}\0${row.sequence}`;
        inboundKeys.add(inboundKey);
        inboundEvidenceXor = xorDigest(
          inboundEvidenceXor,
          defensiveIntegrityV4
            ? inboundEvidenceDigestV2(inboundContentEvidenceFromRow(row))
            : inboundEvidenceDigest(row.connection_id, row.sequence, row.message_id),
        );
        inboundEvidenceCount += 1;
        if (
          row.effect_state === 'PERSISTED' &&
          (!locallyConsumedCommands.has(row.message_id) ||
            row.envelope_type === 'conversation.open' ||
            row.envelope_type === 'invocation.prepare' ||
            row.envelope_type === 'invocation.start' ||
            row.envelope_type === 'invocation.cancel')
        ) {
          pendingInboundCount += 1;
        }
        const latestEffect = latestEffectEvents.get(inboundKey);
        const connection = connectionAuthorities.get(row.connection_id);
        if (connection === undefined) throw new Error('missing-inbound-connection');
        const stored = decodeStoredBrokerEnvelope(row.envelope_json, row.canonical_digest);
        const envelope = materializeStoredInboundEnvelope(
          stored,
          connection,
          localConversationsByOpenCommand.get(row.message_id),
          locallyConsumedCommands.get(row.message_id)?.semanticDigest,
        );
        const priorLogicalDigest = inboundMessageDigests.get(envelope.messageId);
        if (
          envelope.kind === 'event' ||
          envelope.kind !== row.envelope_kind ||
          envelope.type !== row.envelope_type ||
          envelope.connectionId !== row.connection_id ||
          envelope.sequence !== row.sequence ||
          envelope.messageId !== row.message_id ||
          stored.logicalDigest !== row.logical_digest ||
          inboundEffectDigestFromRow(row) !== row.effect_digest ||
          latestEffect === undefined ||
          latestEffect.message_id !== row.message_id ||
          latestEffect.to_state !== row.effect_state ||
          (priorLogicalDigest !== undefined && priorLogicalDigest !== row.logical_digest) ||
          (envelope.kind === 'ack'
            ? envelope.body.acknowledgedMessageId !== row.acknowledged_message_id
            : row.acknowledged_message_id !== null)
        ) {
          throw new Error('invalid-inbound');
        }
        inboundMessageDigests.set(envelope.messageId, row.logical_digest);
        if (envelope.kind === 'ack') {
          const readySecurityReceipt =
            envelope.body.decision === 'SECURITY_BLOCK' &&
            workerConversationReadyTablesExist(this.#database)
              ? this.#database
                  .prepare(
                    `SELECT 1 AS present
                     FROM local_conversation_ready_outbox_receipts AS receipt
                     WHERE receipt.ack_connection_id = ? AND receipt.ack_sequence = ?
                       AND receipt.ack_message_id = ? AND receipt.ack_canonical_digest = ?
                       AND receipt.delivery_message_id = ? AND receipt.decision = 'SECURITY_BLOCK'`,
                  )
                  .get(
                    row.connection_id,
                    row.sequence,
                    row.message_id,
                    row.canonical_digest,
                    envelope.body.acknowledgedMessageId,
                  )
              : undefined;
          if (
            envelope.body.decision !== 'APPLIED' &&
            envelope.body.decision !== 'IDEMPOTENT_REPLAY' &&
            readySecurityReceipt === undefined
          ) {
            throw new Error('invalid-ack-decision');
          }
          if (envelope.body.decision === 'SECURITY_BLOCK') continue;
          const current = acknowledgedLevels.get(envelope.body.acknowledgedMessageId) ?? -1;
          acknowledgedLevels.set(
            envelope.body.acknowledgedMessageId,
            Math.max(current, ACK_RANK[envelope.body.level]),
          );
        } else {
          const priorCommandType = inboundCommandTypes.get(envelope.messageId);
          if (priorCommandType !== undefined && priorCommandType !== envelope.type) {
            throw new Error('conflicting-command-message');
          }
          inboundCommandTypes.set(envelope.messageId, envelope.type);
        }
      }
      if (latestEffectEvents.size !== inboundKeys.size) throw new Error('orphan-effect-event');
      if (
        inboundEvidenceCount !== provisioned.inbound_evidence_count ||
        inboundEvidenceXor !== provisioned.inbound_evidence_xor ||
        inboundEvidenceCount > this.#maxRetainedInboundRows ||
        pendingInboundCount > this.#maxInboundRows
      ) {
        throw new Error('inbound-evidence-mismatch');
      }

      let outboxEvidenceXor = ZERO_DIGEST;
      let outboxEvidenceCount = 0;
      let activeOutboxCount = 0;
      const outboxRows = this.#database
        .prepare(
          `SELECT message_id, installation_id, connection_id, sequence, canonical_digest,
                  envelope_json, envelope_type, response_to_message_id, state, delivery_digest,
                  ack_level, created_at_ms, updated_at_ms, acked_at_ms, retained_until_ms
           FROM transport_outbox`,
        )
        .iterate() as Iterable<
        OutboxDeliveryRow & {
          envelope_type: string;
          response_to_message_id: string | null;
        }
      >;
      for (const row of outboxRows) {
        outboxEvidenceXor = xorDigest(
          outboxEvidenceXor,
          defensiveIntegrityV4
            ? outboxEvidenceDigestV2(outboxContentEvidenceFromRow(row))
            : outboxEvidenceDigest(row.message_id),
        );
        outboxEvidenceCount += 1;
        if (row.state === 'UNBOUND' || row.state === 'PENDING' || row.state === 'WRITTEN') {
          activeOutboxCount += 1;
        }
        const envelope = parseStoredEnvelope(row.envelope_json, row.canonical_digest);
        const bound = row.state !== 'UNBOUND';
        const responseCommandType =
          row.response_to_message_id === null
            ? undefined
            : (inboundCommandTypes.get(row.response_to_message_id) ??
              locallyConsumedCommands.get(row.response_to_message_id)?.type);
        const responseBindingValid =
          envelope.kind === 'ack'
            ? envelope.body.acknowledgedMessageId === row.response_to_message_id &&
              responseCommandType !== undefined
            : envelope.type === 'lease.accepted' || envelope.type === 'lease.renewed'
              ? responseCommandType === 'lease.grant' &&
                envelope.correlationId === row.response_to_message_id
              : envelope.type === 'pong'
                ? responseCommandType === 'ping'
                : row.response_to_message_id === null;
        if (
          envelope.kind === 'command' ||
          envelope.messageId !== row.message_id ||
          envelope.type !== row.envelope_type ||
          (bound &&
            (envelope.connectionId !== row.connection_id || envelope.sequence !== row.sequence)) ||
          (!bound && (row.connection_id !== null || row.sequence !== null)) ||
          !responseBindingValid ||
          outboxDeliveryDigestFromRow(row) !== row.delivery_digest ||
          (row.ack_level !== null &&
            (acknowledgedLevels.get(row.message_id) ?? -1) < ACK_RANK[row.ack_level])
        ) {
          throw new Error('invalid-outbox');
        }
      }
      if (
        outboxEvidenceCount !== provisioned.outbox_evidence_count ||
        outboxEvidenceXor !== provisioned.outbox_evidence_xor ||
        outboxEvidenceCount > this.#maxRetainedOutboxRows ||
        activeOutboxCount > this.#maxOutboxRows
      ) {
        throw new Error('outbox-evidence-mismatch');
      }
    } catch {
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
  }

  #actualSchemaDigest(): string {
    const rows = this.#database
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
         WHERE (name LIKE 'transport_%' OR name LIKE 'local_%') AND sql IS NOT NULL
         ORDER BY type, name`,
      )
      .all() as Array<{ type: string; name: string; sql: string }>;
    return createHash('sha256').update(canonicalizeJson(rows)).digest('hex');
  }

  #actualAuthorityDigest(): string {
    const installation = this.#database
      .prepare(
        `SELECT installation_id, highest_owner_epoch FROM transport_installations
         ORDER BY installation_id`,
      )
      .all() as Array<{ installation_id: string; highest_owner_epoch: number }>;
    const owners = this.#database
      .prepare(
        `SELECT installation_id, owner_token_digest, owner_epoch, lease_expires_at_ms,
                acquired_at_ms, updated_at_ms
         FROM transport_installation_owners ORDER BY installation_id`,
      )
      .all() as Array<{
      installation_id: string;
      owner_token_digest: string;
      owner_epoch: number;
      lease_expires_at_ms: number;
      acquired_at_ms: number;
      updated_at_ms: number;
    }>;
    const fences = this.#database
      .prepare(
        `SELECT installation_id, deployment_id, highest_fence
         FROM transport_deployment_fences
         ORDER BY installation_id, deployment_id`,
      )
      .all() as Array<{
      installation_id: string;
      deployment_id: string;
      highest_fence: string;
    }>;
    const local = workerInvocationAuthorityRows(this.#database);
    const authority =
      local === undefined
        ? { installation, owners, fences }
        : { installation, owners, fences, local };
    return createHash('sha256')
      .update('combo:vnext:worker-authority:v1\0', 'utf8')
      .update(canonicalizeJson(authority), 'utf8')
      .digest('hex');
  }

  #refreshAuthorityDigest(): void {
    const result = this.#database
      .prepare('UPDATE transport_meta SET authority_digest = ? WHERE singleton = 1')
      .run(this.#actualAuthorityDigest());
    if (Number(result.changes) !== 1) throw permanentPortFailure();
  }

  #transaction<T>(name: string, signal: AbortSignal, operation: () => T): T {
    this.#assertOpen();
    const recoveryTransaction = isRecoveryTransaction(name);
    const callerDeadline = durablePortDeadline(signal);
    const localDeadline = performance.now() + this.#operationTimeoutMs;
    const deadline = Math.min(callerDeadline ?? Number.POSITIVE_INFINITY, localDeadline);
    const previousDeadline = this.#transactionDeadline;
    const previousRecoveryReserveReleased = this.#recoveryReserveReleased;
    const previousSensitivePurge = this.#sensitivePurgePending;
    this.#transactionDeadline = deadline;
    this.#recoveryReserveReleased = false;
    this.#sensitivePurgePending = false;
    let began = false;
    let committed = false;
    let previousWatermark: JournalCommitWatermark | undefined;
    let watermarkWriteStarted = false;
    try {
      assertNotAborted(signal, deadline);
      this.#assertStorageBudget(name, recoveryTransaction);
      assertNotAborted(signal, deadline);
      try {
        this.#database.exec('BEGIN IMMEDIATE');
        began = true;
      } catch {
        assertNotAborted(signal, deadline);
        throw new SqliteWorkerTransportError('JOURNAL_BUSY');
      }
      assertNotAborted(signal, deadline);
      previousWatermark = this.#readDatabaseWatermark();
      assertNotAborted(signal, deadline);
      const result = operation();
      if (!recoveryTransaction || !this.#recoveryReserveReleased) {
        this.#assertDatabaseRecoveryReserve();
      }
      // Invocation rows are part of the same journal authority. Refreshing unconditionally keeps
      // every transport and Invocation transaction on one watermark linearization boundary.
      this.#refreshAuthorityDigest();
      this.#faultInjector?.(`${name}.before_commit`);
      assertNotAborted(signal, deadline);
      const incremented = this.#database
        .prepare('UPDATE transport_meta SET commit_epoch = commit_epoch + 1 WHERE singleton = 1')
        .run();
      if (Number(incremented.changes) !== 1) throw permanentPortFailure();
      watermarkWriteStarted = true;
      this.#writeExternalWatermark(this.#readDatabaseWatermark());
      this.#faultInjector?.(`${name}.after_watermark_fsync`);
      // The watermark write contains two blocking fsync calls. A caller deadline can elapse while
      // JavaScript is blocked inside either one, so sampling only before the write permits a late
      // COMMIT. Recheck here and restore the prior durable watermark if rollback wins.
      assertNotAborted(signal, deadline);
      this.#database.exec('COMMIT');
      committed = true;
      // COMMIT is the logical linearization point. Ordinary WAL quota cleanup preserves committed
      // success semantics, while request-lifetime Prompt/result deletion deliberately fails closed
      // and poisons the live adapter until a reopen can prove physical WAL truncation.
      if (
        this.#sensitivePurgePending ||
        name === 'invocation_prepare' ||
        name === 'invocation_start' ||
        name === 'invocation_recover_unconfirmed_start' ||
        name === 'invocation_record_dispatch_unknown' ||
        name === 'invocation_reject_host_dispatch' ||
        name === 'invocation_confirm_host_dispatch' ||
        name === 'invocation_cancel' ||
        name === 'invocation_take_host_interrupt' ||
        name === 'invocation_confirm_host_interrupt' ||
        name === 'invocation_record_interrupt_unknown' ||
        name === 'invocation_recover_unconfirmed_interrupt' ||
        name === 'invocation_recover_host_actions' ||
        name === 'invocation_mark_cloud_committed' ||
        name === 'invocation_prune_committed_retention'
      ) {
        this.#forceSensitiveCheckpoint();
      } else {
        this.#checkpointWalIfNeeded();
      }
      this.#secureJournalFiles();
      if (recoveryTransaction) this.#replenishRecoveryReserveAfterCommit();
      this.#faultInjector?.(`${name}.after_commit`);
      return result;
    } catch (error) {
      if (began && !committed) {
        if (watermarkWriteStarted) {
          if (previousWatermark === undefined) {
            safeRollback(this.#database);
            this.#poisoned = true;
            throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
          }
          try {
            this.#writeExternalWatermark(previousWatermark);
            this.#assertExternalWatermark(previousWatermark);
          } catch {
            safeRollback(this.#database);
            this.#poisoned = true;
            // An unprovable compensation means the live adapter can no longer establish which
            // side of the commit boundary is authoritative. Reopen also rejects any mismatch.
            throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
          }
        }
        if (this.#database.isTransaction) {
          try {
            this.#database.exec('ROLLBACK');
          } catch {
            this.#poisoned = true;
            throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
          }
        }
      }
      if (isSqliteCapacity(error)) throw new WorkerBrokerClientError('CAPACITY_EXCEEDED');
      throw error;
    } finally {
      this.#transactionDeadline = previousDeadline;
      this.#recoveryReserveReleased = previousRecoveryReserveReleased;
      this.#sensitivePurgePending = previousSensitivePurge;
    }
  }

  #assertTransactionBudget(): void {
    if (performance.now() >= this.#transactionDeadline) {
      throw new SqliteWorkerTransportError('JOURNAL_ABORTED');
    }
  }

  #assertStorageBudget(operation: string, recoveryTransaction: boolean): void {
    this.#assertTransactionBudget();
    if (!recoveryTransaction) {
      const databaseReserveReady = this.#ensureDatabaseRecoveryReserve();
      const filesystemReserveReady = this.#ensureFilesystemRecoveryReserve();
      if (!databaseReserveReady || !filesystemReserveReady) {
        throw new WorkerBrokerClientError('CAPACITY_EXCEEDED');
      }
    }
    let databaseBytes: number;
    let walBytes: number;
    try {
      databaseBytes = statSync(this.#filename).size;
      walBytes = journalEntryExists(`${this.#filename}-wal`)
        ? statSync(`${this.#filename}-wal`).size
        : 0;
    } catch {
      throw new SqliteWorkerTransportError('JOURNAL_FILE_UNSAFE');
    }
    if (
      recoveryTransaction &&
      (this.#filesystemAvailableBytes() < this.#minFreeBytes ||
        walBytes > this.#maxWalBytes - WAL_ADMISSION_RECOVERY_HEADROOM_BYTES ||
        pragmaNumber(this.#database, 'freelist_count') < WORKER_TRANSPORT_RECOVERY_RESERVE_PAGES)
    ) {
      // Removing a physically allocated file, rather than merely bypassing an operation check,
      // makes its blocks available to SQLite WAL and the atomic watermark rewrite. Healthy
      // reconciliation retains the file, avoiding repeated allocation churn.
      this.#releaseFilesystemRecoveryReserve();
      this.#recoveryReserveReleased = true;
    }
    if (databaseBytes > this.#maxDatabaseBytes) {
      throw new WorkerBrokerClientError('CAPACITY_EXCEEDED');
    }
    const admissionWalLimit = Math.max(
      0,
      this.#maxWalBytes - WAL_ADMISSION_RECOVERY_HEADROOM_BYTES,
    );
    if (
      walBytes > (recoveryTransaction ? this.#maxWalBytes : admissionWalLimit) ||
      this.#walQuotaProtection
    ) {
      this.#tryCheckpointAndTruncateWal();
      this.#assertTransactionBudget();
      walBytes = journalEntryExists(`${this.#filename}-wal`)
        ? statSync(`${this.#filename}-wal`).size
        : 0;
      if (walBytes > (recoveryTransaction ? this.#maxWalBytes : admissionWalLimit)) {
        this.#walQuotaProtection = true;
        if (!recoveryTransaction) throw new WorkerBrokerClientError('CAPACITY_EXCEEDED');
      }
      if (walBytes <= this.#maxWalBytes) this.#walQuotaProtection = false;
    }
    if (!recoveryTransaction && this.#filesystemAvailableBytes() < this.#minFreeBytes) {
      throw new WorkerBrokerClientError('CAPACITY_EXCEEDED');
    }
  }

  #assertDatabaseRecoveryReserve(): void {
    if (pragmaNumber(this.#database, 'freelist_count') < WORKER_TRANSPORT_RECOVERY_RESERVE_PAGES) {
      // This check runs before COMMIT, so an admission that tried to consume the protected pages
      // rolls back and leaves them available to the already-started lifecycle.
      throw new WorkerBrokerClientError('CAPACITY_EXCEEDED');
    }
  }

  #ensureDatabaseRecoveryReserve(): boolean {
    const admissionTargetPages =
      WORKER_TRANSPORT_RECOVERY_RESERVE_PAGES + DATABASE_ADMISSION_HEADROOM_PAGES;
    if (pragmaNumber(this.#database, 'freelist_count') >= admissionTargetPages) {
      return true;
    }
    if (this.#database.isTransaction) return false;
    const deadline = performance.now() + this.#busyTimeoutMs;
    for (;;) {
      let began = false;
      try {
        this.#database.exec('BEGIN IMMEDIATE');
        began = true;
        const pageSize = pragmaNumber(this.#database, 'page_size');
        const current = pragmaNumber(this.#database, 'freelist_count');
        if (current < admissionTargetPages) {
          const insert = this.#database.prepare(
            'INSERT INTO local_recovery_reserve_pages(slot, payload) VALUES (?, zeroblob(?))',
          );
          const payloadBytes = Math.max(512, pageSize - 256);
          // SQLite consumes existing freelist pages before extending the file. Fill through the
          // whole current freelist *and* a new protected tranche, then delete the scratch rows;
          // otherwise replenishing 191→192 pages would simply cycle the same 191 pages forever.
          const rows = current + admissionTargetPages + 32;
          for (let slot = 1; slot <= rows; slot += 1) insert.run(slot, payloadBytes);
          this.#database.exec('DELETE FROM local_recovery_reserve_pages');
        }
        if (pragmaNumber(this.#database, 'freelist_count') < admissionTargetPages) {
          throw new WorkerBrokerClientError('CAPACITY_EXCEEDED');
        }
        this.#database.exec('COMMIT');
        return true;
      } catch (error) {
        if (began) safeRollback(this.#database);
        if (isSqliteCapacity(error) || isFilesystemCapacity(error)) return false;
        if (!isSqliteBusy(error) || performance.now() >= deadline) {
          if (error instanceof WorkerBrokerClientError) return false;
          throw error;
        }
        Atomics.wait(
          SQLITE_BUSY_WAIT,
          0,
          0,
          Math.min(10, Math.max(1, deadline - performance.now())),
        );
      }
    }
  }

  #ensureFilesystemRecoveryReserve(): boolean {
    if (journalEntryExists(this.#recoveryReserveFilename)) {
      ensureSafeRegularFile(this.#recoveryReserveFilename, 0o600, 'JOURNAL_FILE_UNSAFE');
      return recoveryReserveFileIsPhysical(this.#recoveryReserveFilename);
    }
    const parent = dirname(this.#recoveryReserveFilename);
    const temporary = join(
      parent,
      `.${basename(this.#recoveryReserveFilename)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      let remaining = WORKER_TRANSPORT_FILESYSTEM_RECOVERY_RESERVE_BYTES;
      while (remaining > 0) {
        const length = Math.min(64 * 1024, remaining);
        // Incompressible bytes prevent APFS/ext4 from representing the reserve as a sparse or
        // compressed logical file that would free no real blocks during ENOSPC recovery.
        const block = randomBytes(length);
        const written = writeSync(descriptor, block, 0, length);
        if (written !== length) throw new Error('recovery-reserve-short-write');
        remaining -= written;
      }
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.#recoveryReserveFilename);
      ensureSafeRegularFile(this.#recoveryReserveFilename, 0o600, 'JOURNAL_FILE_UNSAFE');
      if (!recoveryReserveFileIsPhysical(this.#recoveryReserveFilename)) {
        throw new Error('recovery-reserve-not-physical');
      }
      const parentDescriptor = openSync(parent, 'r');
      try {
        fsyncSync(parentDescriptor);
      } finally {
        closeSync(parentDescriptor);
      }
      return true;
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // Preserve the reserve-allocation failure.
        }
      }
      try {
        unlinkSync(temporary);
      } catch {
        // The temporary name may never have been created or was already renamed.
      }
      if (isFilesystemCapacity(error)) return false;
      if (
        journalEntryExists(this.#recoveryReserveFilename) &&
        recoveryReserveFileIsPhysical(this.#recoveryReserveFilename)
      ) {
        ensureSafeRegularFile(this.#recoveryReserveFilename, 0o600, 'JOURNAL_FILE_UNSAFE');
        return true;
      }
      throw new SqliteWorkerTransportError('JOURNAL_FILE_UNSAFE');
    }
  }

  #releaseFilesystemRecoveryReserve(): void {
    if (!journalEntryExists(this.#recoveryReserveFilename)) return;
    ensureSafeRegularFile(this.#recoveryReserveFilename, 0o600, 'JOURNAL_FILE_UNSAFE');
    try {
      unlinkSync(this.#recoveryReserveFilename);
      const parentDescriptor = openSync(dirname(this.#recoveryReserveFilename), 'r');
      try {
        fsyncSync(parentDescriptor);
      } finally {
        closeSync(parentDescriptor);
      }
    } catch {
      throw new SqliteWorkerTransportError('JOURNAL_FILE_UNSAFE');
    }
  }

  #filesystemAvailableBytes(): number {
    const available = this.#availableFilesystemBytes();
    if (!Number.isSafeInteger(available) || available < 0) {
      throw new SqliteWorkerTransportError('JOURNAL_FILE_UNSAFE');
    }
    return available;
  }

  #replenishRecoveryReserveAfterCommit(): void {
    try {
      const databaseReady = this.#ensureDatabaseRecoveryReserve();
      const filesystemReady = this.#ensureFilesystemRecoveryReserve();
      if (!databaseReady || !filesystemReady) this.#walQuotaProtection = true;
    } catch {
      // The lifecycle transaction is already durably committed. Preserve its success while
      // switching subsequent ordinary admission to fail-closed until a reopen/retry can restore
      // both reserves. Unsafe file topology is still revalidated on every open.
      this.#walQuotaProtection = true;
    }
  }

  #checkpointWalIfNeeded(): void {
    try {
      const wal = `${this.#filename}-wal`;
      if (!journalEntryExists(wal)) {
        this.#walQuotaProtection = false;
        return;
      }
      if (statSync(wal).size >= Math.floor(this.#maxWalBytes / 2)) {
        this.#tryCheckpointAndTruncateWal();
      }
      this.#walQuotaProtection = journalEntryExists(wal) && statSync(wal).size > this.#maxWalBytes;
    } catch {
      // The transaction is already committed. Preserve success semantics and block the next
      // operation, whose pre-BEGIN storage check will surface the stable failure.
      this.#walQuotaProtection = true;
    }
  }

  #tryCheckpointAndTruncateWal(): void {
    const result = this.#database.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as
      | { busy: number; log: number; checkpointed: number }
      | undefined;
    if (
      result !== undefined &&
      result.busy === 0 &&
      result.log === result.checkpointed &&
      result.log > 0
    ) {
      this.#database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    }
  }

  #forceSensitiveCheckpoint(): void {
    this.#assertOpen();
    if (this.#database.isTransaction) throw new SqliteWorkerTransportError('JOURNAL_BUSY');
    const deadline = performance.now() + this.#busyTimeoutMs;
    for (;;) {
      let result: { busy: number; log: number; checkpointed: number } | undefined;
      try {
        result = this.#database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as
          | { busy: number; log: number; checkpointed: number }
          | undefined;
      } catch (error) {
        if (!isSqliteBusy(error) || performance.now() >= deadline) {
          this.#walQuotaProtection = true;
          this.#poisoned = true;
          throw new SqliteWorkerTransportError('JOURNAL_BUSY');
        }
      }
      if (result !== undefined && result.busy === 0 && result.log === result.checkpointed) {
        this.#walQuotaProtection = false;
        this.#secureJournalFiles();
        return;
      }
      if (performance.now() >= deadline) {
        this.#walQuotaProtection = true;
        this.#poisoned = true;
        throw new SqliteWorkerTransportError('JOURNAL_BUSY');
      }
      // DatabaseSync is synchronous, so a bounded Atomics wait keeps the entire checkpoint/open
      // barrier serialized without yielding a Host/Broker-capable adapter in between attempts.
      Atomics.wait(SQLITE_BUSY_WAIT, 0, 0, Math.min(10, Math.max(1, deadline - performance.now())));
    }
  }

  #assertAndRefreshOwner(
    installationId: string,
    ownerToken: string,
  ): { ownerEpoch: number; now: number } {
    const ownerDigest = ownerTokenDigest(ownerToken);
    const now = this.#clock();
    const row = this.#database
      .prepare(
        `SELECT owner_token_digest, owner_epoch, lease_expires_at_ms
         FROM transport_installation_owners WHERE installation_id = ?`,
      )
      .get(installationId) as
      | { owner_token_digest: string; owner_epoch: number; lease_expires_at_ms: number }
      | undefined;
    if (
      row === undefined ||
      row.lease_expires_at_ms <= now ||
      !constantTimeTextEqual(row.owner_token_digest, ownerDigest)
    ) {
      throw permanentPortFailure();
    }
    this.#database
      .prepare(
        `UPDATE transport_installation_owners
         SET lease_expires_at_ms = ?, updated_at_ms = ?
         WHERE installation_id = ? AND owner_token_digest = ? AND owner_epoch = ?`,
      )
      .run(
        safeDeadline(now, this.#ownerLeaseMs),
        now,
        installationId,
        ownerDigest,
        row.owner_epoch,
      );
    this.#refreshAuthorityDigest();
    return { ownerEpoch: row.owner_epoch, now };
  }

  #insertInbound(
    envelope: BrokerEnvelope,
    canonicalDigest: string,
    effectState: 'PERSISTED' | 'APPLIED',
    now: number,
  ): boolean {
    this.#pruneExpiredRows(now);
    const logicalDigest = logicalEnvelopeDigest(envelope);
    const prior = this.#database
      .prepare(
        `SELECT connection_id, logical_digest, effect_state FROM transport_inbound_frames
         WHERE message_id = ? ORDER BY recorded_at_ms LIMIT 1`,
      )
      .get(envelope.messageId) as
      | {
          connection_id: string;
          logical_digest: string;
          effect_state: 'PERSISTED' | 'APPLIED';
        }
      | undefined;
    const consumed = workerInvocationTablesExist(this.#database)
      ? (this.#database
          .prepare(
            `SELECT semantic_digest AS logical_digest, command_type AS envelope_type
             FROM local_consumed_commands WHERE command_id = ?`,
          )
          .get(envelope.messageId) as { logical_digest: string; envelope_type: string } | undefined)
      : undefined;
    const terminalIdentities = workerConversationReadyTablesExist(this.#database)
      ? (this.#database
          .prepare(
            `SELECT 'command' AS envelope_kind, 'conversation.open' AS envelope_type,
                    open_semantic_digest AS logical_digest
             FROM local_conversation_ready_terminal_tombstones WHERE open_command_id = ?
             UNION ALL
             SELECT 'ack' AS envelope_kind, 'message.ack' AS envelope_type,
                    ack_logical_digest AS logical_digest
             FROM local_conversation_ready_terminal_tombstones WHERE ack_message_id = ?`,
          )
          .all(envelope.messageId, envelope.messageId) as Array<{
          envelope_kind: 'command' | 'ack';
          envelope_type: string;
          logical_digest: string;
        }>)
      : [];
    const durableOpenConversation =
      envelope.kind === 'command' &&
      envelope.type === 'conversation.open' &&
      workerInvocationTablesExist(this.#database)
        ? (this.#database
            .prepare('SELECT * FROM local_conversations WHERE open_command_id = ?')
            .get(envelope.messageId) as Record<string, unknown> | undefined)
        : undefined;
    const legacyOpenLogicalDigest =
      envelope.kind === 'command' && envelope.type === 'conversation.open'
        ? legacyConversationOpenLogicalDigest(envelope)
        : undefined;
    const legacyOpenAuthorityMatches =
      envelope.kind === 'command' &&
      envelope.type === 'conversation.open' &&
      durableOpenConversation !== undefined &&
      envelope.body.conversationId === durableOpenConversation.conversation_id &&
      envelope.body.agentVersionId === durableOpenConversation.agent_version_id &&
      envelope.body.agentVersionDigest === durableOpenConversation.agent_version_digest &&
      envelope.body.snapshotDigest === durableOpenConversation.snapshot_digest &&
      envelope.body.openAuthority.installationId === durableOpenConversation.installation_id &&
      envelope.body.openAuthority.deploymentId === durableOpenConversation.deployment_id &&
      envelope.body.openAuthority.workerSessionId === durableOpenConversation.worker_session_id &&
      envelope.body.openAuthority.leaseId === durableOpenConversation.lease_id &&
      envelope.body.openAuthority.fence === durableOpenConversation.fence;
    const permanentIdentities: Array<{
      envelope_kind: 'command' | 'ack';
      envelope_type: string;
      logical_digest: string;
    }> =
      consumed === undefined
        ? terminalIdentities
        : [
            {
              envelope_kind: 'command',
              envelope_type: consumed.envelope_type,
              logical_digest: consumed.logical_digest,
            },
            ...terminalIdentities,
          ];
    for (const identity of permanentIdentities) {
      if (
        envelope.kind !== identity.envelope_kind ||
        envelope.type !== identity.envelope_type ||
        (logicalDigest !== identity.logical_digest &&
          !(legacyOpenAuthorityMatches && legacyOpenLogicalDigest === identity.logical_digest))
      ) {
        throw new WorkerBrokerClientError('SEQUENCE_CONFLICT', true);
      }
    }
    if (prior !== undefined && prior.logical_digest !== logicalDigest) {
      throw new WorkerBrokerClientError('SEQUENCE_CONFLICT', true);
    }
    const duplicateEffect = prior !== undefined || permanentIdentities.length > 0;
    // An explicit cross-connection retry transfers a not-yet-consumed command to the current
    // connection. Ready-open/prepare/start/cancel re-envelopes remain PERSISTED until the journal
    // revalidates current transport authority and exact logical replay; other already-applied
    // commands do not need a second business effect.
    const invocationReplayNeedsBusinessValidation =
      consumed !== undefined &&
      envelope.kind === 'command' &&
      (envelope.type === 'conversation.open' ||
        envelope.type === 'invocation.prepare' ||
        envelope.type === 'invocation.start' ||
        envelope.type === 'invocation.cancel');
    const storedEffectState = invocationReplayNeedsBusinessValidation
      ? effectState
      : prior === undefined
        ? consumed === undefined
          ? effectState
          : 'APPLIED'
        : prior.connection_id === envelope.connectionId
          ? 'APPLIED'
          : prior.effect_state;
    if (storedEffectState === 'PERSISTED') {
      this.#assertCapacity('transport_inbound_frames', this.#maxInboundRows);
    }
    this.#assertTotalCapacity('transport_inbound_frames', this.#maxRetainedInboundRows);
    const appliedAt = storedEffectState === 'APPLIED' ? now : null;
    const retainedUntil =
      storedEffectState === 'APPLIED' ? safeDeadline(now, WORKER_TRANSPORT_RETENTION_MS) : null;
    const effectDigest = inboundEffectDigest({
      connectionId: envelope.connectionId,
      sequence: envelope.sequence,
      messageId: envelope.messageId,
      canonicalDigest,
      effectState: storedEffectState,
      replayCount: 0,
      recordedAtMs: now,
      appliedAtMs: appliedAt,
      retainedUntilMs: retainedUntil,
    });
    this.#database
      .prepare(
        `INSERT INTO transport_inbound_frames(
           connection_id, sequence, message_id, canonical_digest, logical_digest, envelope_json,
           envelope_kind, envelope_type, acknowledged_message_id, effect_state, effect_digest,
           replay_count, recorded_at_ms, applied_at_ms, retained_until_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        envelope.connectionId,
        envelope.sequence,
        envelope.messageId,
        canonicalDigest,
        logicalDigest,
        canonicalizeJson(envelope),
        envelope.kind,
        envelope.type,
        envelope.kind === 'ack' ? envelope.body.acknowledgedMessageId : null,
        storedEffectState,
        effectDigest,
        now,
        appliedAt,
        retainedUntil,
      );
    this.#adjustEvidenceAccumulator(
      'inbound',
      inboundEvidenceDigestV2({
        connectionId: envelope.connectionId,
        sequence: envelope.sequence,
        messageId: envelope.messageId,
        canonicalDigest,
        logicalDigest,
        effectDigest,
      }),
      1,
    );
    this.#appendInboundEffectEvent({
      connectionId: envelope.connectionId,
      sequence: envelope.sequence,
      messageId: envelope.messageId,
      fromState: null,
      toState: storedEffectState,
      reason: duplicateEffect ? 'DEDUPLICATED' : 'RECORDED',
      occurredAtMs: now,
    });
    return duplicateEffect;
  }

  #applyInboundEffect(envelope: BrokerEnvelope, connection: ConnectionRow, now: number): void {
    if (envelope.kind === 'ack') {
      const compactReady = this.#database
        .prepare(
          `SELECT t.delivery_message_id, t.ack_logical_digest, t.decision, c.deployment_id
           FROM local_conversation_ready_terminal_tombstones AS t
           JOIN local_conversations AS c ON c.conversation_id = t.conversation_id
           WHERE t.ack_message_id = ?`,
        )
        .get(envelope.messageId) as
        | {
            delivery_message_id: string;
            ack_logical_digest: string;
            decision: string;
            deployment_id: string;
          }
        | undefined;
      if (compactReady !== undefined) {
        if (
          connection.deployment_id !== compactReady.deployment_id ||
          envelope.lease.deploymentId !== compactReady.deployment_id ||
          envelope.type !== 'message.ack' ||
          envelope.body.level !== 'CLOUD_COMMITTED' ||
          envelope.body.acknowledgedMessageId !== compactReady.delivery_message_id ||
          envelope.body.decision !== compactReady.decision ||
          logicalEnvelopeDigest(envelope) !== compactReady.ack_logical_digest
        ) {
          throw new WorkerBrokerClientError('SEQUENCE_CONFLICT', true);
        }
        return;
      }
      const readyDelivery = this.#database
        .prepare(
          `SELECT 1 AS present FROM local_conversation_ready_deliveries
           WHERE delivery_message_id = ?`,
        )
        .get(envelope.body.acknowledgedMessageId);
      if (readyDelivery !== undefined) {
        if (
          envelope.body.level !== 'CLOUD_COMMITTED' ||
          !(
            envelope.body.decision === 'APPLIED' ||
            envelope.body.decision === 'IDEMPOTENT_REPLAY' ||
            envelope.body.decision === 'SECURITY_BLOCK'
          )
        ) {
          throw new WorkerBrokerClientError('PROTOCOL_ERROR', true);
        }
        if (envelope.body.decision !== 'SECURITY_BLOCK') {
          this.#applyAck(
            connection.installation_id,
            connection.connection_id,
            envelope.body.acknowledgedMessageId,
            envelope.body.level,
            now,
          );
        }
        this.#applyConversationReadyCloudAck(envelope, now);
        return;
      }
      if (envelope.body.decision !== 'APPLIED' && envelope.body.decision !== 'IDEMPOTENT_REPLAY') {
        throw new WorkerBrokerClientError('PROTOCOL_ERROR', true);
      }
      this.#applyAck(
        connection.installation_id,
        connection.connection_id,
        envelope.body.acknowledgedMessageId,
        envelope.body.level,
        now,
      );
      return;
    }
    if (envelope.kind !== 'command') throw permanentPortFailure();
    if (envelope.type === 'lease.grant') {
      const watermark = this.#database
        .prepare(
          `SELECT highest_fence FROM transport_deployment_fences
           WHERE installation_id = ? AND deployment_id = ?`,
        )
        .get(connection.installation_id, envelope.lease.deploymentId) as
        | { highest_fence: string }
        | undefined;
      if (
        watermark === undefined ||
        BigInt(envelope.lease.fence) < BigInt(parseUint63(watermark.highest_fence))
      ) {
        throw new WorkerBrokerClientError('STALE_FENCE', true);
      }
      if (BigInt(envelope.lease.fence) > BigInt(watermark.highest_fence)) {
        this.#database
          .prepare(
            `UPDATE transport_deployment_fences SET highest_fence = ?, updated_at_ms = ?
             WHERE installation_id = ? AND deployment_id = ? AND highest_fence = ?`,
          )
          .run(
            envelope.lease.fence,
            now,
            connection.installation_id,
            envelope.lease.deploymentId,
            watermark.highest_fence,
          );
        this.#refreshAuthorityDigest();
      }
      this.#database
        .prepare(
          `UPDATE transport_connections SET
             worker_session_id = ?, deployment_id = ?, lease_id = ?, fence = ?,
             lease_state = 'ACTIVE', lease_granted_at = ?, lease_expires_at = ?
           WHERE connection_id = ? AND status = 'ACTIVE'`,
        )
        .run(
          envelope.lease.workerSessionId,
          envelope.lease.deploymentId,
          envelope.lease.leaseId,
          envelope.lease.fence,
          envelope.sentAt,
          envelope.body.leaseExpiresAt,
          envelope.connectionId,
        );
      this.#refreshConnectionDigest(envelope.connectionId);
      this.#enqueueLeaseEvent('lease.renewed', envelope.connectionId, envelope.messageId, now);
      return;
    }
    if (envelope.type === 'lease.revoke') {
      this.#database
        .prepare(
          `UPDATE transport_connections SET lease_state = 'REVOKED'
           WHERE connection_id = ? AND status = 'ACTIVE'`,
        )
        .run(envelope.connectionId);
      this.#refreshConnectionDigest(envelope.connectionId);
      this.#enqueuePersistedAck(envelope, connection, now);
      return;
    }
    if (envelope.type === 'ping') {
      this.#enqueueEnvelope(
        connection.connection_id,
        {
          kind: 'event',
          type: 'pong',
          messageId: uuidV7(),
          correlationId: envelope.correlationId,
          body: { nonce: envelope.body.nonce },
          responseToMessageId: envelope.messageId,
        },
        now,
      );
      return;
    }
    this.#enqueuePersistedAck(envelope, connection, now);
  }

  #applyConversationReadyCloudAck(
    envelope: Extract<BrokerEnvelope, { type: 'message.ack' }>,
    now: number,
  ): void {
    const delivery = this.#database
      .prepare(
        `SELECT d.*, o.fact_json
         FROM local_conversation_ready_deliveries AS d
         JOIN local_conversation_ready_outbox AS o ON o.source_event_id = d.source_event_id
         WHERE d.delivery_message_id = ?`,
      )
      .get(envelope.body.acknowledgedMessageId) as Record<string, unknown> | undefined;
    const inbound = this.#database
      .prepare(
        `SELECT canonical_digest FROM transport_inbound_frames
         WHERE connection_id = ? AND sequence = ? AND message_id = ?
           AND effect_state = 'APPLIED'`,
      )
      .get(envelope.connectionId, envelope.sequence, envelope.messageId) as
      | { canonical_digest: string }
      | undefined;
    if (delivery === undefined || inbound === undefined) {
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
    const fact = WorkerConversationReadyFactSchema.parse(JSON.parse(String(delivery.fact_json)));
    const outbound = this.#outboxRow(envelope.body.acknowledgedMessageId);
    if (outbound === undefined) throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    const wire = parseStoredEnvelope(outbound.envelope_json, outbound.canonical_digest);
    if (
      wire.kind !== 'event' ||
      wire.type !== 'conversation.ready' ||
      wire.messageId !== delivery.delivery_message_id ||
      outbound.canonical_digest !== delivery.canonical_digest ||
      wire.connectionId !== delivery.connection_id ||
      wire.sequence !== delivery.sequence ||
      wire.correlationId !== delivery.conversation_id ||
      wire.lease.deploymentId !== delivery.deployment_id ||
      wire.lease.workerSessionId !== delivery.worker_session_id ||
      wire.lease.leaseId !== delivery.lease_id ||
      wire.lease.fence !== delivery.fence ||
      envelope.lease.deploymentId !== delivery.deployment_id ||
      fact.deploymentId !== delivery.deployment_id ||
      workerConversationReadyFactDigest(fact) !== delivery.fact_digest ||
      canonicalizeJson(wire.body) !==
        canonicalizeJson({ ...fact, factDigest: String(delivery.fact_digest) })
    ) {
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
    const receipt = {
      source_event_id: String(delivery.source_event_id),
      conversation_id: String(delivery.conversation_id),
      fact_digest: String(delivery.fact_digest),
      delivery_message_id: String(delivery.delivery_message_id),
      ack_message_id: envelope.messageId,
      ack_connection_id: envelope.connectionId,
      ack_sequence: envelope.sequence,
      ack_canonical_digest: inbound.canonical_digest,
      ack_logical_digest: logicalEnvelopeDigest(envelope),
      decision: envelope.body.decision,
      cloud_decided_at_ms: now,
    };
    const inserted = this.#database
      .prepare(
        `INSERT INTO local_conversation_ready_outbox_receipts(
           source_event_id, conversation_id, fact_digest, delivery_message_id,
           ack_message_id, ack_connection_id, ack_sequence, ack_canonical_digest,
           ack_logical_digest, decision, cloud_decided_at_ms, row_digest
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ...Object.values(receipt),
        sqliteInvocationRowDigest('local_conversation_ready_outbox_receipts', receipt),
      );
    if (Number(inserted.changes) !== 1) throw permanentPortFailure();
    const readyCloudState =
      envelope.body.decision === 'SECURITY_BLOCK' ? 'CLOUD_REJECTED' : 'CLOUD_COMMITTED';
    const updated = this.#database
      .prepare(
        `UPDATE local_conversations SET ready_cloud_state = ?, updated_at_ms = ?
         WHERE conversation_id = ? AND ready_cloud_state = 'PENDING'`,
      )
      .run(readyCloudState, now, String(delivery.conversation_id));
    if (Number(updated.changes) !== 1) throw permanentPortFailure();
    const conversation = this.#database
      .prepare('SELECT * FROM local_conversations WHERE conversation_id = ?')
      .get(String(delivery.conversation_id)) as Record<string, unknown> | undefined;
    if (conversation === undefined) throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    const conversationPayload = { ...conversation };
    delete conversationPayload.row_digest;
    this.#database
      .prepare('UPDATE local_conversations SET row_digest = ? WHERE conversation_id = ?')
      .run(
        sqliteInvocationRowDigest('local_conversations', conversationPayload),
        String(delivery.conversation_id),
      );
    const transportDelivery = this.#outboxRow(String(delivery.delivery_message_id));
    if (transportDelivery === undefined) throw permanentPortFailure();
    const removed = this.#database
      .prepare(
        `DELETE FROM transport_outbox WHERE message_id = ?
           AND state IN ('PENDING', 'WRITTEN', 'ACKED')`,
      )
      .run(String(delivery.delivery_message_id));
    if (Number(removed.changes) !== 1) throw permanentPortFailure();
    this.#adjustEvidenceAccumulator(
      'outbox',
      outboxEvidenceDigestV2(outboxContentEvidenceFromRow(transportDelivery)),
      -1,
    );
  }

  #enqueuePersistedAck(envelope: BrokerCommand, connection: ConnectionRow, now: number): void {
    const existing = this.#database
      .prepare('SELECT 1 AS present FROM transport_outbox WHERE response_to_message_id = ?')
      .get(envelope.messageId);
    if (existing !== undefined) return;
    this.#enqueueEnvelope(
      connection.connection_id,
      {
        kind: 'ack',
        type: 'message.ack',
        messageId: uuidV7(),
        correlationId: envelope.correlationId,
        body: {
          acknowledgedMessageId: envelope.messageId,
          level: 'PERSISTED',
          decision: 'APPLIED',
        },
        responseToMessageId: envelope.messageId,
      },
      now,
    );
  }

  #enqueueLeaseEvent(
    type: 'lease.accepted' | 'lease.renewed',
    connectionId: string,
    responseToMessageId: string,
    now: number,
  ): void {
    const connection = this.#connectionRow(connectionId);
    if (connection === undefined) throw permanentPortFailure();
    this.#enqueueEnvelope(
      connectionId,
      {
        kind: 'event',
        type,
        messageId: uuidV7(),
        correlationId: responseToMessageId,
        body: { leaseExpiresAt: connection.lease_expires_at },
        responseToMessageId,
      },
      now,
    );
  }

  /**
   * A socket write is not Cloud commit evidence. When Cloud exactly replays a command on the same
   * connection, only that command's exact durable response may move WRITTEN back to PENDING.
   * ACKED/CLOUD_COMMITTED and SUPERSEDED rows remain terminal and are never resurrected.
   */
  #reactivateReplayResponse(
    installationId: string,
    connectionId: string,
    responseToMessageId: string,
    now: number,
  ): void {
    const rows = this.#database
      .prepare(
        `SELECT message_id, state, ack_level FROM transport_outbox
         WHERE installation_id = ? AND connection_id = ? AND response_to_message_id = ?`,
      )
      .all(installationId, connectionId, responseToMessageId) as Array<{
      message_id: string;
      state: 'PENDING' | 'WRITTEN' | 'ACKED' | 'SUPERSEDED';
      ack_level: keyof typeof ACK_RANK | null;
    }>;
    if (rows.length > 1) throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    const row = rows[0];
    if (row === undefined || row.state !== 'WRITTEN' || row.ack_level === 'CLOUD_COMMITTED') {
      return;
    }
    const previous = this.#outboxRow(row.message_id);
    if (previous === undefined) throw permanentPortFailure();
    const changed = this.#database
      .prepare(
        `UPDATE transport_outbox SET state = 'PENDING', updated_at_ms = ?
         WHERE message_id = ? AND installation_id = ? AND connection_id = ?
           AND response_to_message_id = ? AND state = 'WRITTEN'
           AND (ack_level IS NULL OR ack_level <> 'CLOUD_COMMITTED')`,
      )
      .run(now, row.message_id, installationId, connectionId, responseToMessageId);
    if (Number(changed.changes) !== 1) throw permanentPortFailure();
    this.#refreshOutboxDeliveryDigest(row.message_id, previous);
  }

  #enqueueEnvelope(
    connectionId: string,
    logical: {
      kind: 'event' | 'ack';
      type: string;
      messageId: string;
      correlationId: string;
      body: unknown;
      responseToMessageId?: string;
    },
    now: number,
  ): void {
    this.#pruneExpiredRows(now);
    this.#assertCapacity('transport_outbox', this.#maxOutboxRows);
    if (logical.type === 'message.ack') {
      const acknowledgements = this.#database
        .prepare(
          `SELECT count(*) AS count FROM transport_outbox
           WHERE envelope_type = 'message.ack' AND state IN ('UNBOUND', 'PENDING', 'WRITTEN')`,
        )
        .get() as CountRow;
      if (acknowledgements.count >= this.#maxOutboxRows - 1) {
        throw new WorkerBrokerClientError('CAPACITY_EXCEEDED');
      }
    }
    this.#assertTotalCapacity('transport_outbox', this.#maxRetainedOutboxRows);
    const connection = this.#connectionRow(connectionId);
    if (connection === undefined || connection.status !== 'ACTIVE') {
      throw new WorkerBrokerClientError('STALE_CONNECTION', true);
    }
    const cursor = restoreSequenceCursor(connection.outbound_cursor);
    const frame = buildFrame(logical, connection, cursor.nextExpected.toString(10));
    const digest = canonicalSha256(frame);
    const decision = consumeSequence(cursor, frame, digest, Date.parse(frame.sentAt));
    if (decision.type !== 'ACCEPT') throw permanentPortFailure();
    const deliveryDigest = outboxDeliveryDigest({
      messageId: frame.messageId,
      installationId: connection.installation_id,
      connectionId,
      sequence: frame.sequence,
      canonicalDigest: digest,
      state: 'PENDING',
      ackLevel: null,
      createdAtMs: now,
      updatedAtMs: now,
      ackedAtMs: null,
      retainedUntilMs: null,
    });
    this.#database
      .prepare(
        `INSERT INTO transport_outbox(
           message_id, installation_id, connection_id, sequence, canonical_digest,
           envelope_json, envelope_type, response_to_message_id, state, delivery_digest, ack_level,
           created_at_ms, updated_at_ms, acked_at_ms, retained_until_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, NULL, ?, ?, NULL, NULL)`,
      )
      .run(
        frame.messageId,
        connection.installation_id,
        connectionId,
        frame.sequence,
        digest,
        canonicalizeJson(frame),
        frame.type,
        logical.responseToMessageId ?? null,
        deliveryDigest,
        now,
        now,
      );
    this.#adjustEvidenceAccumulator(
      'outbox',
      outboxEvidenceDigestV2({
        messageId: frame.messageId,
        canonicalDigest: digest,
        envelopeType: frame.type,
        responseToMessageId: logical.responseToMessageId ?? null,
        deliveryDigest,
      }),
      1,
    );
    this.#database
      .prepare('UPDATE transport_connections SET outbound_cursor = ? WHERE connection_id = ?')
      .run(serializeSequenceCursor(decision.cursor), connectionId);
    this.#refreshConnectionDigest(connectionId);
  }

  #applyAck(
    installationId: string,
    connectionId: string,
    messageId: string,
    level: keyof typeof ACK_RANK,
    now: number,
  ): void {
    const row = this.#outboxRow(messageId);
    if (
      row === undefined ||
      row.installation_id !== installationId ||
      row.connection_id !== connectionId ||
      row.state === 'UNBOUND'
    ) {
      throw permanentPortFailure();
    }
    const currentRank = row.ack_level === null ? -1 : ACK_RANK[row.ack_level];
    if (ACK_RANK[level] < currentRank) return;
    if (level === 'CLOUD_COMMITTED') {
      this.#database
        .prepare(
          `UPDATE transport_outbox SET
             state = 'ACKED', ack_level = 'CLOUD_COMMITTED', updated_at_ms = ?,
             acked_at_ms = COALESCE(acked_at_ms, ?), retained_until_ms = COALESCE(retained_until_ms, ?)
           WHERE message_id = ?`,
        )
        .run(now, now, safeDeadline(now, WORKER_TRANSPORT_RETENTION_MS), messageId);
      this.#refreshOutboxDeliveryDigest(messageId, row);
      return;
    }
    this.#database
      .prepare(`UPDATE transport_outbox SET ack_level = ?, updated_at_ms = ? WHERE message_id = ?`)
      .run(level, now, messageId);
    this.#refreshOutboxDeliveryDigest(messageId, row);
  }

  #reframeUnacknowledged(installationId: string, connectionId: string, now: number): void {
    const rows = this.#database
      .prepare(
        `SELECT message_id, canonical_digest, envelope_json FROM transport_outbox
         WHERE installation_id = ? AND state = 'UNBOUND'
         ORDER BY created_at_ms, message_id`,
      )
      .all(installationId) as Array<{
      message_id: string;
      canonical_digest: string;
      envelope_json: string;
    }>;
    const connection = this.#requireActiveConnection(installationId, connectionId);
    let cursor = restoreSequenceCursor(connection.outbound_cursor);
    for (const row of rows) {
      this.#assertTransactionBudget();
      const previousDelivery = this.#outboxRow(row.message_id);
      if (previousDelivery === undefined) throw permanentPortFailure();
      const previous = parseStoredEnvelope(row.envelope_json, row.canonical_digest);
      if (previous.kind === 'command') throw permanentPortFailure();
      const frame = reframe(previous, connection, cursor.nextExpected.toString(10));
      const digest = canonicalSha256(frame);
      const decision = consumeSequence(cursor, frame, digest, Date.parse(frame.sentAt));
      if (decision.type !== 'ACCEPT') throw permanentPortFailure();
      this.#database
        .prepare(
          `UPDATE transport_outbox SET
             connection_id = ?, sequence = ?, canonical_digest = ?, envelope_json = ?,
             state = 'PENDING', updated_at_ms = ?
           WHERE message_id = ? AND state = 'UNBOUND'`,
        )
        .run(connectionId, frame.sequence, digest, canonicalizeJson(frame), now, row.message_id);
      this.#refreshOutboxDeliveryDigest(row.message_id, previousDelivery);
      cursor = decision.cursor;
    }
    if (rows.length > 0) {
      this.#database
        .prepare('UPDATE transport_connections SET outbound_cursor = ? WHERE connection_id = ?')
        .run(serializeSequenceCursor(cursor), connectionId);
      this.#refreshConnectionDigest(connectionId);
    }
  }

  #retireConnection(connectionId: string, now: number): void {
    const rebound = this.#database
      .prepare(
        `SELECT message_id, envelope_type FROM transport_outbox
         WHERE connection_id = ? AND state IN ('PENDING', 'WRITTEN')`,
      )
      .all(connectionId) as Array<{ message_id: string; envelope_type: string }>;
    for (const row of rebound) {
      this.#assertTransactionBudget();
      const previous = this.#outboxRow(row.message_id);
      if (previous === undefined) throw permanentPortFailure();
      if (row.envelope_type === 'message.ack') {
        this.#database
          .prepare(
            `UPDATE transport_outbox SET
               connection_id = NULL, sequence = NULL, state = 'UNBOUND', updated_at_ms = ?
             WHERE message_id = ? AND state IN ('PENDING', 'WRITTEN')`,
          )
          .run(now, row.message_id);
      } else {
        this.#database
          .prepare(
            `UPDATE transport_outbox SET
               state = 'SUPERSEDED', updated_at_ms = ?, retained_until_ms = ?
             WHERE message_id = ? AND state IN ('PENDING', 'WRITTEN')`,
          )
          .run(now, safeDeadline(now, WORKER_TRANSPORT_RETENTION_MS), row.message_id);
      }
      const current = this.#refreshOutboxDeliveryDigest(row.message_id, previous);
      if (row.envelope_type !== 'message.ack') {
        const removed = this.#database
          .prepare(
            `DELETE FROM transport_outbox
             WHERE message_id = ? AND state = 'SUPERSEDED'`,
          )
          .run(row.message_id);
        if (Number(removed.changes) === 1) {
          if (row.envelope_type === 'invocation.succeeded') {
            this.#sensitivePurgePending = true;
          }
          this.#adjustEvidenceAccumulator(
            'outbox',
            outboxEvidenceDigestV2(outboxContentEvidenceFromRow(current)),
            -1,
          );
        }
      }
    }
    this.#database
      .prepare(
        `UPDATE transport_connections SET status = 'RELEASED', released_at_ms = COALESCE(released_at_ms, ?)
         WHERE connection_id = ? AND status = 'ACTIVE'`,
      )
      .run(now, connectionId);
    this.#refreshConnectionDigest(connectionId);
    this.#deleteReleasedConnectionIfEmpty(connectionId);
  }

  #deleteReleasedConnectionIfEmpty(connectionId: string): number {
    const connection = this.#connectionRow(connectionId);
    if (connection === undefined || connection.status !== 'RELEASED') return 0;
    const retainedFact = this.#database
      .prepare(
        `SELECT 1 AS present
         FROM transport_inbound_frames
         WHERE connection_id = ? AND message_id <> ?
         LIMIT 1`,
      )
      .get(connectionId, connection.activation_message_id);
    const retainedDelivery = this.#database
      .prepare('SELECT 1 AS present FROM transport_outbox WHERE connection_id = ? LIMIT 1')
      .get(connectionId);
    if (retainedFact !== undefined || retainedDelivery !== undefined) return 0;

    const activation = this.#database
      .prepare(
        `SELECT sequence, message_id FROM transport_inbound_frames
         WHERE connection_id = ? AND message_id = ? AND effect_state = 'APPLIED'`,
      )
      .get(connectionId, connection.activation_message_id) as
      | { sequence: string; message_id: string }
      | undefined;
    if (activation === undefined) throw permanentPortFailure();
    const activationEvidence = this.#inboundEffectRow(connectionId, activation.sequence);
    if (activationEvidence === undefined) throw permanentPortFailure();
    const deletedActivation = this.#database
      .prepare(
        `DELETE FROM transport_inbound_frames
         WHERE connection_id = ? AND sequence = ? AND message_id = ?`,
      )
      .run(connectionId, activation.sequence, activation.message_id);
    if (Number(deletedActivation.changes) !== 1) throw permanentPortFailure();
    this.#adjustEvidenceAccumulator(
      'inbound',
      inboundEvidenceDigestV2(inboundContentEvidenceFromRow(activationEvidence)),
      -1,
    );
    const deletedConnection = this.#database
      .prepare(`DELETE FROM transport_connections WHERE connection_id = ? AND status = 'RELEASED'`)
      .run(connectionId);
    if (Number(deletedConnection.changes) !== 1) throw permanentPortFailure();
    return 2;
  }

  #inboundEffectRow(connectionId: string, sequence: string): InboundEffectRow | undefined {
    return this.#database
      .prepare(
        `SELECT connection_id, sequence, message_id, canonical_digest, logical_digest,
                effect_state, effect_digest, replay_count, recorded_at_ms, applied_at_ms,
                retained_until_ms
         FROM transport_inbound_frames WHERE connection_id = ? AND sequence = ?`,
      )
      .get(connectionId, sequence) as InboundEffectRow | undefined;
  }

  #refreshInboundEffectDigest(
    connectionId: string,
    sequence: string,
    previous: InboundEffectRow,
  ): InboundEffectRow {
    const row = this.#database
      .prepare(
        `SELECT connection_id, sequence, message_id, canonical_digest, logical_digest,
                effect_state, effect_digest, replay_count, recorded_at_ms, applied_at_ms,
                retained_until_ms
         FROM transport_inbound_frames WHERE connection_id = ? AND sequence = ?`,
      )
      .get(connectionId, sequence) as InboundEffectRow | undefined;
    if (
      row === undefined ||
      previous.connection_id !== row.connection_id ||
      previous.sequence !== row.sequence ||
      previous.message_id !== row.message_id ||
      previous.canonical_digest !== row.canonical_digest ||
      previous.logical_digest !== row.logical_digest ||
      previous.effect_digest !== inboundEffectDigestFromRow(previous)
    ) {
      throw permanentPortFailure();
    }
    const effectDigest = inboundEffectDigestFromRow(row);
    const updated = this.#database
      .prepare(
        `UPDATE transport_inbound_frames SET effect_digest = ?
         WHERE connection_id = ? AND sequence = ?`,
      )
      .run(effectDigest, connectionId, sequence);
    if (Number(updated.changes) !== 1) throw permanentPortFailure();
    const current = { ...row, effect_digest: effectDigest };
    this.#replaceEvidenceAccumulator(
      'inbound',
      inboundEvidenceDigestV2(inboundContentEvidenceFromRow(previous)),
      inboundEvidenceDigestV2(inboundContentEvidenceFromRow(current)),
    );
    return current;
  }

  #markInvocationCommandApplied(reference: OpaqueInvocationCommandReference, now: number): void {
    const row = this.#database
      .prepare(
        `SELECT message_id, canonical_digest, logical_digest, envelope_kind, envelope_type,
                effect_state
         FROM transport_inbound_frames WHERE connection_id = ? AND sequence = ?`,
      )
      .get(reference.connectionId, reference.sequence) as
      | {
          message_id: string;
          canonical_digest: string;
          logical_digest: string;
          envelope_kind: string;
          envelope_type: string;
          effect_state: 'PERSISTED' | 'APPLIED';
        }
      | undefined;
    if (
      row === undefined ||
      row.message_id !== reference.messageId ||
      row.canonical_digest !== reference.canonicalDigest ||
      row.envelope_kind !== 'command' ||
      row.envelope_type !== reference.type
    ) {
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
    const pendingCopies = this.#database
      .prepare(
        `SELECT connection_id, sequence, logical_digest
         FROM transport_inbound_frames
         WHERE message_id = ? AND envelope_kind = 'command' AND envelope_type = ?
           AND effect_state = 'PERSISTED'
         ORDER BY recorded_at_ms, connection_id, sequence`,
      )
      .all(reference.messageId, reference.type) as Array<{
      connection_id: string;
      sequence: string;
      logical_digest: string;
    }>;
    for (const copy of pendingCopies) {
      if (copy.logical_digest !== row.logical_digest) {
        throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
      }
      const previous = this.#inboundEffectRow(copy.connection_id, copy.sequence);
      if (previous === undefined) throw permanentPortFailure();
      const updated = this.#database
        .prepare(
          `UPDATE transport_inbound_frames SET effect_state = 'APPLIED', applied_at_ms = ?,
             retained_until_ms = ? WHERE connection_id = ? AND sequence = ?
             AND effect_state = 'PERSISTED'`,
        )
        .run(
          now,
          safeDeadline(now, WORKER_TRANSPORT_RETENTION_MS),
          copy.connection_id,
          copy.sequence,
        );
      if (Number(updated.changes) !== 1) throw permanentPortFailure();
      this.#refreshInboundEffectDigest(copy.connection_id, copy.sequence, previous);
      this.#appendInboundEffectEvent({
        connectionId: copy.connection_id,
        sequence: copy.sequence,
        messageId: reference.messageId,
        fromState: 'PERSISTED',
        toState: 'APPLIED',
        reason:
          copy.connection_id === reference.connectionId && copy.sequence === reference.sequence
            ? 'RECORDED'
            : 'DEDUPLICATED',
        occurredAtMs: now,
      });
    }
  }

  #purgeInvocationPrepareTransportPayload(commandId: string): void {
    const consumed = this.#database
      .prepare(
        `SELECT semantic_digest FROM local_consumed_commands
         WHERE command_id = ? AND command_type = 'invocation.prepare'`,
      )
      .get(commandId) as { semantic_digest: string } | undefined;
    if (consumed === undefined) throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    const rows = this.#database
      .prepare(
        `SELECT connection_id, sequence, message_id, canonical_digest, envelope_json, effect_state
         FROM transport_inbound_frames WHERE message_id = ?`,
      )
      .all(commandId) as Array<{
      connection_id: string;
      sequence: string;
      message_id: string;
      canonical_digest: string;
      envelope_json: string;
      effect_state: 'PERSISTED' | 'APPLIED';
    }>;
    for (const row of rows) {
      const evidence = this.#inboundEffectRow(row.connection_id, row.sequence);
      if (evidence === undefined) throw permanentPortFailure();
      const envelope = parseStoredEnvelope(row.envelope_json, row.canonical_digest);
      if (
        envelope.kind !== 'command' ||
        envelope.type !== 'invocation.prepare' ||
        row.effect_state !== 'APPLIED' ||
        workerInvocationCommandSemanticDigest(envelope) !== consumed.semantic_digest
      ) {
        throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
      }
      this.#database
        .prepare(
          `DELETE FROM transport_inbound_effect_events
           WHERE connection_id = ? AND sequence = ?`,
        )
        .run(row.connection_id, row.sequence);
      const removed = this.#database
        .prepare(
          `DELETE FROM transport_inbound_frames
           WHERE connection_id = ? AND sequence = ? AND message_id = ?`,
        )
        .run(row.connection_id, row.sequence, row.message_id);
      if (Number(removed.changes) !== 1) throw permanentPortFailure();
      this.#sensitivePurgePending = true;
      this.#adjustEvidenceAccumulator(
        'inbound',
        inboundEvidenceDigestV2(inboundContentEvidenceFromRow(evidence)),
        -1,
      );
    }
  }

  #purgeInvocationCommandResponse(commandId: string): void {
    const rows = this.#database
      .prepare(
        `SELECT message_id, canonical_digest, envelope_json
         FROM transport_outbox WHERE response_to_message_id = ?`,
      )
      .all(commandId) as Array<{
      message_id: string;
      canonical_digest: string;
      envelope_json: string;
    }>;
    if (rows.length > 1) throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    for (const row of rows) {
      const evidence = this.#outboxRow(row.message_id);
      if (evidence === undefined) throw permanentPortFailure();
      const envelope = parseStoredEnvelope(row.envelope_json, row.canonical_digest);
      if (
        envelope.kind !== 'ack' ||
        envelope.type !== 'message.ack' ||
        envelope.body.acknowledgedMessageId !== commandId ||
        envelope.body.level !== 'PERSISTED'
      ) {
        throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
      }
      const removed = this.#database
        .prepare('DELETE FROM transport_outbox WHERE message_id = ? AND response_to_message_id = ?')
        .run(row.message_id, commandId);
      if (Number(removed.changes) !== 1) throw permanentPortFailure();
      this.#adjustEvidenceAccumulator(
        'outbox',
        outboxEvidenceDigestV2(outboxContentEvidenceFromRow(evidence)),
        -1,
      );
    }
  }

  #purgeInvocationDeliveryWire(deliveryMessageId: string): void {
    const delivery = this.#database
      .prepare(
        `SELECT source_event_id FROM local_invocation_deliveries
         WHERE delivery_message_id = ?`,
      )
      .get(deliveryMessageId) as { source_event_id: string } | undefined;
    if (delivery === undefined) throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    const row = this.#outboxRow(deliveryMessageId);
    if (row === undefined) return;
    const envelope = parseStoredEnvelope(row.envelope_json, row.canonical_digest);
    if (
      envelope.kind !== 'event' ||
      !envelope.type.startsWith('invocation.') ||
      row.state !== 'ACKED' ||
      row.ack_level !== 'CLOUD_COMMITTED'
    ) {
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
    const removed = this.#database
      .prepare(
        `DELETE FROM transport_outbox
         WHERE message_id = ? AND state = 'ACKED' AND ack_level = 'CLOUD_COMMITTED'`,
      )
      .run(deliveryMessageId);
    if (Number(removed.changes) !== 1) throw permanentPortFailure();
    if (envelope.type === 'invocation.succeeded') this.#sensitivePurgePending = true;
    this.#adjustEvidenceAccumulator(
      'outbox',
      outboxEvidenceDigestV2(outboxContentEvidenceFromRow(row)),
      -1,
    );
  }

  #appendInboundEffectEvent(input: {
    connectionId: string;
    sequence: string;
    messageId: string;
    fromState: 'PERSISTED' | 'APPLIED' | null;
    toState: 'PERSISTED' | 'APPLIED';
    reason: 'RECORDED' | 'DEDUPLICATED';
    occurredAtMs: number;
  }): void {
    const digest = inboundEffectEventDigest(input);
    this.#database
      .prepare(
        `INSERT INTO transport_inbound_effect_events(
           connection_id, sequence, message_id, from_state, to_state, reason,
           occurred_at_ms, event_digest
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.connectionId,
        input.sequence,
        input.messageId,
        input.fromState,
        input.toState,
        input.reason,
        input.occurredAtMs,
        digest,
      );
  }

  #refreshOutboxDeliveryDigest(messageId: string, previous: OutboxDeliveryRow): OutboxDeliveryRow {
    const row = this.#database
      .prepare(
        `SELECT message_id, installation_id, connection_id, sequence, canonical_digest,
                envelope_json, envelope_type, response_to_message_id, state, ack_level,
                delivery_digest, created_at_ms, updated_at_ms, acked_at_ms, retained_until_ms
         FROM transport_outbox WHERE message_id = ?`,
      )
      .get(messageId) as OutboxDeliveryRow | undefined;
    if (
      row === undefined ||
      previous.message_id !== row.message_id ||
      previous.delivery_digest !== outboxDeliveryDigestFromRow(previous)
    ) {
      throw permanentPortFailure();
    }
    const deliveryDigest = outboxDeliveryDigestFromRow(row);
    const updated = this.#database
      .prepare('UPDATE transport_outbox SET delivery_digest = ? WHERE message_id = ?')
      .run(deliveryDigest, messageId);
    if (Number(updated.changes) !== 1) throw permanentPortFailure();
    const current = { ...row, delivery_digest: deliveryDigest };
    this.#replaceEvidenceAccumulator(
      'outbox',
      outboxEvidenceDigestV2(outboxContentEvidenceFromRow(previous)),
      outboxEvidenceDigestV2(outboxContentEvidenceFromRow(current)),
    );
    return current;
  }

  #adjustEvidenceAccumulator(kind: 'inbound' | 'outbox', itemDigest: string, delta: -1 | 1): void {
    const countColumn = kind === 'inbound' ? 'inbound_evidence_count' : 'outbox_evidence_count';
    const xorColumn = kind === 'inbound' ? 'inbound_evidence_xor' : 'outbox_evidence_xor';
    const row = this.#database
      .prepare(`SELECT ${countColumn} AS count, ${xorColumn} AS digest FROM transport_meta`)
      .get() as { count: number; digest: string } | undefined;
    if (
      row === undefined ||
      !Number.isSafeInteger(row.count) ||
      row.count < (delta < 0 ? 1 : 0) ||
      !SHA256_HEX.test(row.digest)
    ) {
      throw permanentPortFailure();
    }
    const result = this.#database
      .prepare(`UPDATE transport_meta SET ${countColumn} = ?, ${xorColumn} = ? WHERE singleton = 1`)
      .run(row.count + delta, xorDigest(row.digest, itemDigest));
    if (Number(result.changes) !== 1) throw permanentPortFailure();
  }

  #replaceEvidenceAccumulator(
    kind: 'inbound' | 'outbox',
    previousItemDigest: string,
    currentItemDigest: string,
  ): void {
    const xorColumn = kind === 'inbound' ? 'inbound_evidence_xor' : 'outbox_evidence_xor';
    const row = this.#database
      .prepare(`SELECT ${xorColumn} AS digest FROM transport_meta WHERE singleton = 1`)
      .get() as { digest: string } | undefined;
    if (
      row === undefined ||
      !SHA256_HEX.test(row.digest) ||
      !SHA256_HEX.test(previousItemDigest) ||
      !SHA256_HEX.test(currentItemDigest)
    ) {
      throw permanentPortFailure();
    }
    const digest = xorDigest(xorDigest(row.digest, previousItemDigest), currentItemDigest);
    const result = this.#database
      .prepare(`UPDATE transport_meta SET ${xorColumn} = ? WHERE singleton = 1`)
      .run(digest);
    if (Number(result.changes) !== 1) throw permanentPortFailure();
  }

  #pruneExpiredRows(now: number): number {
    let pruned = 0;
    const expiredOutbox = this.#database
      .prepare(
        `SELECT message_id, envelope_type FROM transport_outbox
         WHERE state IN ('ACKED', 'SUPERSEDED')
           AND retained_until_ms IS NOT NULL AND retained_until_ms <= ?
           AND NOT EXISTS (
             SELECT 1 FROM local_conversation_ready_facts AS ready_fact
             WHERE ready_fact.open_command_id = transport_outbox.response_to_message_id
           )
         ORDER BY retained_until_ms, message_id LIMIT ?`,
      )
      .all(now, PRUNE_BATCH_SIZE) as Array<{ message_id: string; envelope_type: string }>;
    for (const row of expiredOutbox) {
      this.#assertTransactionBudget();
      const evidence = this.#outboxRow(row.message_id);
      if (evidence === undefined) throw permanentPortFailure();
      const result = this.#database
        .prepare(
          `DELETE FROM transport_outbox
           WHERE message_id = ? AND state IN ('ACKED', 'SUPERSEDED')
             AND retained_until_ms IS NOT NULL AND retained_until_ms <= ?`,
        )
        .run(row.message_id, now);
      if (Number(result.changes) === 1) {
        if (row.envelope_type === 'invocation.succeeded') {
          this.#sensitivePurgePending = true;
        }
        this.#adjustEvidenceAccumulator(
          'outbox',
          outboxEvidenceDigestV2(outboxContentEvidenceFromRow(evidence)),
          -1,
        );
        pruned += 1;
      }
    }

    if (workerConversationReadyTablesExist(this.#database)) {
      const readyTerminal = this.#database
        .prepare(
          `SELECT f.source_event_id, f.conversation_id, f.open_command_id,
                  f.fact_digest, consumed.semantic_digest AS open_semantic_digest,
                  d.delivery_message_id, d.canonical_digest AS delivery_canonical_digest,
                  r.ack_message_id, r.ack_canonical_digest, r.ack_logical_digest,
                  r.decision, r.cloud_decided_at_ms,
                  (SELECT count(*) FROM transport_outbox AS response_count
                    WHERE response_count.response_to_message_id = f.open_command_id
                  ) AS response_count,
                  response.message_id AS response_message_id,
                  response.canonical_digest AS response_canonical_digest,
                  response.envelope_json AS response_envelope_json
           FROM local_conversation_ready_facts AS f
           JOIN local_conversation_ready_outbox AS o ON o.source_event_id = f.source_event_id
           JOIN local_conversation_ready_outbox_receipts AS r
             ON r.source_event_id = f.source_event_id
           JOIN local_conversation_ready_deliveries AS d
             ON d.delivery_message_id = r.delivery_message_id
           JOIN local_consumed_commands AS consumed ON consumed.command_id = f.open_command_id
           LEFT JOIN transport_outbox AS response
             ON response.response_to_message_id = f.open_command_id
           WHERE r.cloud_decided_at_ms <= ? AND o.fact_digest = f.fact_digest
           ORDER BY r.cloud_decided_at_ms, f.source_event_id LIMIT ?`,
        )
        .all(now - WORKER_TRANSPORT_RETENTION_MS, PRUNE_BATCH_SIZE) as Array<
        Record<string, unknown>
      >;
      for (const ready of readyTerminal) {
        this.#assertTransactionBudget();
        const responsePresent = ready.response_message_id !== null;
        const response = responsePresent
          ? parseStoredEnvelope(
              String(ready.response_envelope_json),
              String(ready.response_canonical_digest),
            )
          : undefined;
        if (
          Number(ready.response_count) > 1 ||
          (!responsePresent &&
            (ready.response_canonical_digest !== null || ready.response_envelope_json !== null)) ||
          (response !== undefined &&
            (response.kind !== 'ack' ||
              response.type !== 'message.ack' ||
              response.messageId !== ready.response_message_id ||
              response.body.acknowledgedMessageId !== ready.open_command_id ||
              response.body.level !== 'PERSISTED' ||
              response.body.decision !== 'APPLIED'))
        ) {
          throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
        }
        const cloudState =
          ready.decision === 'SECURITY_BLOCK' ? 'CLOUD_REJECTED' : 'CLOUD_COMMITTED';
        const tombstone = {
          source_event_id: String(ready.source_event_id),
          conversation_id: String(ready.conversation_id),
          open_command_id: String(ready.open_command_id),
          open_semantic_digest: String(ready.open_semantic_digest),
          fact_digest: String(ready.fact_digest),
          delivery_message_id: String(ready.delivery_message_id),
          delivery_canonical_digest: String(ready.delivery_canonical_digest),
          ack_message_id: String(ready.ack_message_id),
          ack_canonical_digest: String(ready.ack_canonical_digest),
          ack_logical_digest: String(ready.ack_logical_digest),
          decision: String(ready.decision),
          cloud_state: cloudState,
          cloud_decided_at_ms: Number(ready.cloud_decided_at_ms),
          compacted_at_ms: now,
        };
        this.#database
          .prepare(
            `INSERT INTO local_conversation_ready_terminal_tombstones(
               source_event_id, conversation_id, open_command_id, open_semantic_digest,
               fact_digest, delivery_message_id, delivery_canonical_digest,
               ack_message_id, ack_canonical_digest, ack_logical_digest, decision,
               cloud_state, cloud_decided_at_ms, compacted_at_ms, row_digest
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ...Object.values(tombstone),
            sqliteInvocationRowDigest('local_conversation_ready_terminal_tombstones', tombstone),
          );
        if (response !== undefined) {
          const responseEvidence = this.#outboxRow(String(ready.response_message_id));
          if (responseEvidence === undefined) {
            throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
          }
          const removedResponse = this.#database
            .prepare(
              `DELETE FROM transport_outbox
               WHERE message_id = ? AND response_to_message_id = ?`,
            )
            .run(String(ready.response_message_id), String(ready.open_command_id));
          if (Number(removedResponse.changes) !== 1) {
            throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
          }
          this.#adjustEvidenceAccumulator(
            'outbox',
            outboxEvidenceDigestV2(outboxContentEvidenceFromRow(responseEvidence)),
            -1,
          );
        }
        const removedReceipt = this.#database
          .prepare('DELETE FROM local_conversation_ready_outbox_receipts WHERE source_event_id = ?')
          .run(String(ready.source_event_id));
        if (Number(removedReceipt.changes) !== 1) {
          throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
        }
        const deliveryCount = this.#database
          .prepare(
            `SELECT count(*) AS count FROM local_conversation_ready_deliveries
             WHERE source_event_id = ?`,
          )
          .get(String(ready.source_event_id)) as CountRow;
        const removedDeliveries = this.#database
          .prepare('DELETE FROM local_conversation_ready_deliveries WHERE source_event_id = ?')
          .run(String(ready.source_event_id));
        if (deliveryCount.count < 1 || Number(removedDeliveries.changes) !== deliveryCount.count) {
          throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
        }
        const removedOutbox = this.#database
          .prepare('DELETE FROM local_conversation_ready_outbox WHERE source_event_id = ?')
          .run(String(ready.source_event_id));
        if (Number(removedOutbox.changes) !== 1) {
          throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
        }
        const removedFact = this.#database
          .prepare('DELETE FROM local_conversation_ready_facts WHERE source_event_id = ?')
          .run(String(ready.source_event_id));
        if (Number(removedFact.changes) !== 1) {
          throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
        }
        pruned += 1;
      }
    }

    const expiredInbound = this.#database
      .prepare(
        `SELECT connection_id, sequence, message_id
         FROM transport_inbound_frames
         WHERE effect_state = 'APPLIED' AND retained_until_ms IS NOT NULL
           AND retained_until_ms <= ?
           AND NOT EXISTS (
             SELECT 1 FROM transport_connections AS c
             WHERE c.connection_id = transport_inbound_frames.connection_id
               AND c.activation_message_id = transport_inbound_frames.message_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM transport_outbox AS response
             WHERE response.response_to_message_id = transport_inbound_frames.message_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM local_consumed_commands AS consumed
             WHERE consumed.command_id = transport_inbound_frames.message_id
               AND NOT EXISTS (
                 SELECT 1 FROM local_conversation_ready_terminal_tombstones AS terminal
                 WHERE terminal.open_command_id = consumed.command_id
                   AND terminal.open_semantic_digest = consumed.semantic_digest
                   AND consumed.connection_id = transport_inbound_frames.connection_id
                   AND consumed.sequence = transport_inbound_frames.sequence
                   AND consumed.canonical_digest = transport_inbound_frames.canonical_digest
               )
           )
           AND NOT EXISTS (
             SELECT 1 FROM local_invocation_outbox_receipts AS receipt
             WHERE receipt.ack_connection_id = transport_inbound_frames.connection_id
               AND receipt.ack_sequence = transport_inbound_frames.sequence
               AND receipt.ack_message_id = transport_inbound_frames.message_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM local_conversation_ready_outbox_receipts AS ready_receipt
             LEFT JOIN local_conversation_ready_terminal_tombstones AS terminal
               ON terminal.source_event_id = ready_receipt.source_event_id
             WHERE ready_receipt.ack_connection_id = transport_inbound_frames.connection_id
               AND ready_receipt.ack_sequence = transport_inbound_frames.sequence
               AND ready_receipt.ack_message_id = transport_inbound_frames.message_id
               AND terminal.source_event_id IS NULL
           )
           AND (
             acknowledged_message_id IS NULL
             OR NOT EXISTS (
               SELECT 1 FROM transport_outbox AS o
               WHERE o.message_id = transport_inbound_frames.acknowledged_message_id
             )
           )
         ORDER BY retained_until_ms, connection_id, sequence LIMIT ?`,
      )
      .all(now, PRUNE_BATCH_SIZE) as Array<{
      connection_id: string;
      sequence: string;
      message_id: string;
    }>;
    for (const row of expiredInbound) {
      this.#assertTransactionBudget();
      const evidence = this.#inboundEffectRow(row.connection_id, row.sequence);
      if (evidence === undefined) throw permanentPortFailure();
      const result = this.#database
        .prepare(
          `DELETE FROM transport_inbound_frames
           WHERE connection_id = ? AND sequence = ? AND message_id = ?
             AND effect_state = 'APPLIED' AND retained_until_ms IS NOT NULL
             AND retained_until_ms <= ?`,
        )
        .run(row.connection_id, row.sequence, row.message_id, now);
      if (Number(result.changes) === 1) {
        this.#adjustEvidenceAccumulator(
          'inbound',
          inboundEvidenceDigestV2(inboundContentEvidenceFromRow(evidence)),
          -1,
        );
        pruned += 1;
      }
    }

    const expiredGaps = this.#database
      .prepare(
        `SELECT id FROM transport_sequence_gaps
         WHERE retained_until_ms <= ? ORDER BY retained_until_ms, id LIMIT ?`,
      )
      .all(now, PRUNE_BATCH_SIZE) as Array<{ id: number }>;
    for (const row of expiredGaps) {
      this.#assertTransactionBudget();
      pruned += Number(
        this.#database.prepare('DELETE FROM transport_sequence_gaps WHERE id = ?').run(row.id)
          .changes,
      );
    }
    const releasable = this.#database
      .prepare(
        `SELECT c.connection_id, c.activation_message_id
         FROM transport_connections AS c
         WHERE c.status = 'RELEASED' AND c.released_at_ms IS NOT NULL
           AND c.released_at_ms <= ?
           AND NOT EXISTS (
             SELECT 1 FROM transport_inbound_frames AS f
             WHERE f.connection_id = c.connection_id
               AND f.message_id <> c.activation_message_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM transport_outbox AS o WHERE o.connection_id = c.connection_id
           )
         ORDER BY c.released_at_ms, c.connection_id LIMIT ?`,
      )
      .all(now - WORKER_TRANSPORT_RETENTION_MS, PRUNE_BATCH_SIZE) as Array<{
      connection_id: string;
      activation_message_id: string;
    }>;
    for (const row of releasable) {
      this.#assertTransactionBudget();
      pruned += this.#deleteReleasedConnectionIfEmpty(row.connection_id);
    }
    return pruned;
  }

  #assertCapacity(table: string, maximum: number): void {
    const sql =
      table === 'transport_inbound_frames'
        ? `SELECT count(*) AS count FROM transport_inbound_frames
           WHERE effect_state = 'PERSISTED'
             ${workerInvocationTablesExist(this.#database) ? `AND (message_id NOT IN (SELECT command_id FROM local_consumed_commands) OR envelope_type IN ('conversation.open', 'invocation.prepare', 'invocation.start', 'invocation.cancel'))` : ''}`
        : table === 'transport_outbox'
          ? `SELECT count(*) AS count FROM transport_outbox
             WHERE state IN ('UNBOUND', 'PENDING', 'WRITTEN')`
          : table === 'transport_connections'
            ? `SELECT count(*) AS count FROM transport_connections`
            : table === 'transport_sequence_gaps'
              ? 'SELECT count(*) AS count FROM transport_sequence_gaps'
              : undefined;
    if (sql === undefined) throw permanentPortFailure();
    const row = this.#database.prepare(sql).get() as CountRow;
    if (row.count >= maximum) {
      throw new WorkerBrokerClientError('CAPACITY_EXCEEDED');
    }
  }

  #assertTotalCapacity(
    table: 'transport_inbound_frames' | 'transport_outbox',
    maximum: number,
  ): void {
    const column =
      table === 'transport_inbound_frames' ? 'inbound_evidence_count' : 'outbox_evidence_count';
    const row = this.#database
      .prepare(`SELECT ${column} AS count FROM transport_meta WHERE singleton = 1`)
      .get() as CountRow | undefined;
    if (row === undefined) throw permanentPortFailure();
    if (row.count >= maximum) {
      throw new WorkerBrokerClientError('CAPACITY_EXCEEDED');
    }
  }

  #requireActiveConnection(
    installationId: string,
    connectionId: string,
    ownerEpoch?: number,
  ): ConnectionRow {
    const row = this.#connectionRow(connectionId);
    if (
      row === undefined ||
      row.status !== 'ACTIVE' ||
      row.installation_id !== installationId ||
      (ownerEpoch !== undefined && row.owner_epoch !== ownerEpoch)
    ) {
      throw new WorkerBrokerClientError('STALE_CONNECTION', true);
    }
    return row;
  }

  #connectionRow(connectionId: string): ConnectionRow | undefined {
    return this.#database
      .prepare(
        `SELECT installation_id, connection_id, owner_epoch, worker_session_id, deployment_id, lease_id,
                fence, lease_state, lease_granted_at, lease_expires_at, inbound_cursor,
                outbound_cursor, status, activation_message_id, activation_digest,
                connection_digest, created_at_ms, released_at_ms
         FROM transport_connections WHERE connection_id = ?`,
      )
      .get(connectionId) as ConnectionRow | undefined;
  }

  #refreshConnectionDigest(connectionId: string): void {
    const row = this.#connectionRow(connectionId);
    if (row === undefined) throw permanentPortFailure();
    const result = this.#database
      .prepare('UPDATE transport_connections SET connection_digest = ? WHERE connection_id = ?')
      .run(connectionStateDigestFromRow(row), connectionId);
    if (Number(result.changes) !== 1) throw permanentPortFailure();
  }

  #outboxRow(messageId: string): OutboxDeliveryRow | undefined {
    return this.#database
      .prepare(
        `SELECT message_id, installation_id, connection_id, sequence, canonical_digest,
                envelope_json, envelope_type, response_to_message_id, state, delivery_digest,
                ack_level, created_at_ms, updated_at_ms, acked_at_ms, retained_until_ms
         FROM transport_outbox WHERE message_id = ?`,
      )
      .get(messageId) as OutboxDeliveryRow | undefined;
  }

  #secureJournalFiles(): void {
    ensureSafeParent(dirname(this.#filename));
    ensureSafeRegularFile(this.#filename, 0o600, 'JOURNAL_FILE_UNSAFE');
    if (journalEntryExists(`${this.#filename}-journal`)) {
      throw new SqliteWorkerTransportError('JOURNAL_FILE_UNSAFE');
    }
    for (const suffix of [
      '-wal',
      '-shm',
      '.watermark',
      '.recovery-reserve',
      '.migration-recovery',
    ]) {
      const path = `${this.#filename}${suffix}`;
      if (journalEntryExists(path)) {
        ensureSafeRegularFile(path, 0o600, 'JOURNAL_FILE_UNSAFE');
      }
    }
  }

  #clock(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
    return value;
  }

  #assertOpen(): void {
    if (this.#closed) throw new SqliteWorkerTransportError('JOURNAL_CLOSED');
    if (this.#poisoned) throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
  }
}

function buildFrame(
  logical: {
    kind: 'event' | 'ack';
    type: string;
    messageId: string;
    correlationId: string;
    body: unknown;
  },
  connection: ConnectionRow,
  sequence: string,
): BrokerEnvelope {
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: logical.kind,
    type: logical.type,
    messageId: logical.messageId,
    correlationId: logical.correlationId,
    connectionId: connection.connection_id,
    sequence,
    sentAt: connection.lease_granted_at,
    expiresAt: connection.lease_expires_at,
    lease: leaseFromRow(connection),
    body: logical.body,
  });
}

function reframe(
  previous: BrokerEnvelope,
  connection: ConnectionRow,
  sequence: string,
): BrokerEnvelope {
  if (previous.kind !== 'ack' || previous.type !== 'message.ack') throw permanentPortFailure();
  return buildFrame(
    {
      kind: previous.kind as 'event' | 'ack',
      type: previous.type,
      messageId: previous.messageId,
      correlationId: previous.correlationId,
      body: previous.body,
    },
    connection,
    sequence,
  );
}

function durableConnection(row: ConnectionRow): DurableBrokerConnection {
  const lease = LeaseBindingSchema.parse(leaseFromRow(row));
  const inbound = restoreSequenceCursor(row.inbound_cursor);
  const outbound = restoreSequenceCursor(row.outbound_cursor);
  if (inbound.connectionId !== row.connection_id || outbound.connectionId !== row.connection_id) {
    throw permanentPortFailure();
  }
  return Object.freeze({
    installationId: parseUuid(row.installation_id),
    connectionId: parseUuid(row.connection_id),
    workerSessionId: parseUuid(row.worker_session_id),
    lease: Object.freeze({ ...lease }),
    leaseState: row.lease_state,
    leaseGrantedAt: row.lease_granted_at,
    leaseExpiresAt: row.lease_expires_at,
    inboundCursor: row.inbound_cursor,
    outboundCursor: row.outbound_cursor,
  });
}

function connectionStateDigest(input: {
  installationId: string;
  connectionId: string;
  ownerEpoch: number;
  workerSessionId: string;
  deploymentId: string;
  leaseId: string;
  fence: string;
  leaseState: ConnectionRow['lease_state'];
  leaseGrantedAt: string;
  leaseExpiresAt: string;
  inboundCursor: string;
  outboundCursor: string;
  status: ConnectionRow['status'];
  activationMessageId: string;
  activationDigest: string;
  createdAtMs: number;
  releasedAtMs: number | null;
}): string {
  return createHash('sha256')
    .update('combo:vnext:worker-connection-state:v1\0', 'utf8')
    .update(canonicalizeJson(input), 'utf8')
    .digest('hex');
}

function connectionStateDigestFromRow(row: ConnectionRow): string {
  return connectionStateDigest({
    installationId: row.installation_id,
    connectionId: row.connection_id,
    ownerEpoch: row.owner_epoch,
    workerSessionId: row.worker_session_id,
    deploymentId: row.deployment_id,
    leaseId: row.lease_id,
    fence: row.fence,
    leaseState: row.lease_state,
    leaseGrantedAt: row.lease_granted_at,
    leaseExpiresAt: row.lease_expires_at,
    inboundCursor: row.inbound_cursor,
    outboundCursor: row.outbound_cursor,
    status: row.status,
    activationMessageId: row.activation_message_id,
    activationDigest: row.activation_digest,
    createdAtMs: row.created_at_ms,
    releasedAtMs: row.released_at_ms,
  });
}

function leaseFromRow(row: ConnectionRow): LeaseBinding {
  return {
    deploymentId: row.deployment_id,
    leaseId: row.lease_id,
    workerSessionId: row.worker_session_id,
    fence: row.fence,
  };
}

function isTransportControlCommand(envelope: BrokerCommand): boolean {
  return (
    envelope.type === 'lease.grant' || envelope.type === 'lease.revoke' || envelope.type === 'ping'
  );
}

function parseLeaseGrant(input: LeaseGrantCommand): LeaseGrantCommand {
  const parsed = BrokerEnvelopeSchema.parse(input);
  if (parsed.kind !== 'command' || parsed.type !== 'lease.grant') {
    throw permanentPortFailure();
  }
  return parsed;
}

function assertActivationCursor(
  envelope: LeaseGrantCommand,
  digest: string,
  serialized: string,
): void {
  const initial = initialSequenceCursor(envelope.connectionId);
  const decision = consumeSequence(initial, envelope, digest, Date.parse(envelope.sentAt));
  if (decision.type !== 'ACCEPT' || serializeSequenceCursor(decision.cursor) !== serialized) {
    throw permanentPortFailure();
  }
}

function assertCursorAdvance(
  beforeSerialized: string,
  afterSerialized: string,
  envelope: BrokerEnvelope,
  digest: string,
): void {
  const before = restoreSequenceCursor(beforeSerialized);
  const decision = consumeSequence(before, envelope, digest, Date.parse(envelope.sentAt));
  if (decision.type !== 'ACCEPT' || serializeSequenceCursor(decision.cursor) !== afterSerialized) {
    throw permanentPortFailure();
  }
}

function assertCanonicalDigest(envelope: BrokerEnvelope, claimed: string): string {
  const actual = canonicalSha256(envelope);
  if (actual !== claimed) throw new WorkerBrokerClientError('SEQUENCE_CONFLICT', true);
  return actual;
}

function parseStoredEnvelope(serialized: string, expectedDigest: string): BrokerEnvelope {
  try {
    const envelope = BrokerEnvelopeSchema.parse(JSON.parse(serialized));
    if (canonicalSha256(envelope) !== expectedDigest || canonicalizeJson(envelope) !== serialized) {
      throw new Error('stored-envelope-mismatch');
    }
    return envelope;
  } catch {
    throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
  }
}

function storedTransportAuthority(
  connection: StoredConnectionAuthorityRow,
): StoredBrokerTransportAuthority {
  return Object.freeze({
    installationId: connection.installation_id,
    connectionId: connection.connection_id,
    deploymentId: connection.deployment_id,
    workerSessionId: connection.worker_session_id,
    leaseId: connection.lease_id,
    fence: connection.fence,
  });
}

function storedConversationAuthority(
  conversation: Record<string, unknown>,
): StoredBrokerConversationAuthority {
  return Object.freeze({
    conversationId: String(conversation.conversation_id),
    installationId: String(conversation.installation_id),
    deploymentId: String(conversation.deployment_id),
    workerSessionId: String(conversation.worker_session_id),
    leaseId: String(conversation.lease_id),
    fence: String(conversation.fence),
    agentVersionId: String(conversation.agent_version_id),
    agentVersionDigest: String(conversation.agent_version_digest),
    snapshotDigest: String(conversation.snapshot_digest),
    openCommandId: String(conversation.open_command_id),
    openConnectionId: String(conversation.open_connection_id),
    openSequence: String(conversation.open_sequence),
  });
}

function materializeStoredInboundEnvelope(
  stored: DecodedStoredBrokerEnvelope,
  connection: StoredConnectionAuthorityRow,
  conversation?: Record<string, unknown>,
  expectedLegacyLogicalDigest?: string,
): BrokerEnvelope {
  return materializeStoredBrokerEnvelope(
    stored,
    storedTransportAuthority(connection),
    conversation === undefined ? undefined : storedConversationAuthority(conversation),
    expectedLegacyLogicalDigest,
  );
}

function logicalEnvelopeDigest(envelope: BrokerEnvelope): string {
  if (envelope.kind === 'command') return workerInvocationCommandSemanticDigest(envelope);
  return canonicalSha256({
    protocol: envelope.protocol,
    schemaVersion: envelope.schemaVersion,
    kind: envelope.kind,
    type: envelope.type,
    messageId: envelope.messageId,
    correlationId: envelope.correlationId,
    body: envelope.body,
  });
}

function legacyConversationOpenLogicalDigest(
  envelope: Extract<BrokerCommand, { type: 'conversation.open' }>,
): string {
  const { openAuthority: _currentAuthority, ...legacyBody } = envelope.body;
  return canonicalSha256({
    protocol: envelope.protocol,
    schemaVersion: envelope.schemaVersion,
    kind: envelope.kind,
    type: envelope.type,
    messageId: envelope.messageId,
    correlationId: envelope.correlationId,
    body: legacyBody,
  });
}

function migrationCreateTableSql(
  schemaSql: string,
  sourceName: string,
  targetName: string,
): string {
  const marker = `CREATE TABLE ${sourceName} (`;
  const start = schemaSql.indexOf(marker);
  const endMarker = '\n  ) STRICT;';
  const end = start < 0 ? -1 : schemaSql.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
  }
  return `${schemaSql
    .slice(start, end + endMarker.length)
    .replace(marker, `CREATE TABLE ${targetName} (`)}`;
}

function inboundEffectDigest(input: {
  connectionId: string;
  sequence: string;
  messageId: string;
  canonicalDigest: string;
  effectState: 'PERSISTED' | 'APPLIED';
  replayCount: number;
  recordedAtMs: number;
  appliedAtMs: number | null;
  retainedUntilMs: number | null;
}): string {
  return createHash('sha256')
    .update('combo:vnext:worker-inbound-effect:v1\0', 'utf8')
    .update(canonicalizeJson(input), 'utf8')
    .digest('hex');
}

function inboundEffectDigestFromRow(row: InboundEffectRow): string {
  return inboundEffectDigest({
    connectionId: row.connection_id,
    sequence: row.sequence,
    messageId: row.message_id,
    canonicalDigest: row.canonical_digest,
    effectState: row.effect_state,
    replayCount: row.replay_count,
    recordedAtMs: row.recorded_at_ms,
    appliedAtMs: row.applied_at_ms,
    retainedUntilMs: row.retained_until_ms,
  });
}

function inboundEffectEventDigest(input: {
  connectionId: string;
  sequence: string;
  messageId: string;
  fromState: 'PERSISTED' | 'APPLIED' | null;
  toState: 'PERSISTED' | 'APPLIED';
  reason: 'RECORDED' | 'DEDUPLICATED';
  occurredAtMs: number;
}): string {
  return createHash('sha256')
    .update('combo:vnext:worker-inbound-effect-event:v1\0', 'utf8')
    .update(canonicalizeJson(input), 'utf8')
    .digest('hex');
}

function inboundEffectEventDigestFromRow(row: InboundEffectEventRow): string {
  return inboundEffectEventDigest({
    connectionId: row.connection_id,
    sequence: row.sequence,
    messageId: row.message_id,
    fromState: row.from_state,
    toState: row.to_state,
    reason: row.reason,
    occurredAtMs: row.occurred_at_ms,
  });
}

function outboxDeliveryDigest(input: {
  messageId: string;
  installationId: string;
  connectionId: string | null;
  sequence: string | null;
  canonicalDigest: string;
  state: OutboxRow['state'];
  ackLevel: OutboxRow['ack_level'];
  createdAtMs: number;
  updatedAtMs: number;
  ackedAtMs: number | null;
  retainedUntilMs: number | null;
}): string {
  return createHash('sha256')
    .update('combo:vnext:worker-outbox-delivery:v1\0', 'utf8')
    .update(canonicalizeJson(input), 'utf8')
    .digest('hex');
}

function outboxDeliveryDigestFromRow(row: OutboxDeliveryRow): string {
  return outboxDeliveryDigest({
    messageId: row.message_id,
    installationId: row.installation_id,
    connectionId: row.connection_id,
    sequence: row.sequence,
    canonicalDigest: row.canonical_digest,
    state: row.state,
    ackLevel: row.ack_level,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    ackedAtMs: row.acked_at_ms,
    retainedUntilMs: row.retained_until_ms,
  });
}

function inboundEvidenceDigest(connectionId: string, sequence: string, messageId: string): string {
  return createHash('sha256')
    .update('combo:vnext:worker-inbound-row:v1\0', 'utf8')
    .update(canonicalizeJson({ connectionId, sequence, messageId }), 'utf8')
    .digest('hex');
}

type InboundContentEvidence = Readonly<{
  connectionId: string;
  sequence: string;
  messageId: string;
  canonicalDigest: string;
  logicalDigest: string;
  effectDigest: string;
}>;

function inboundEvidenceDigestV2(input: InboundContentEvidence): string {
  return createHash('sha256')
    .update('combo:vnext:worker-inbound-row:v2\0', 'utf8')
    .update(canonicalizeJson(input), 'utf8')
    .digest('hex');
}

function inboundContentEvidenceFromRow(
  row: Pick<
    InboundEffectRow,
    | 'connection_id'
    | 'sequence'
    | 'message_id'
    | 'canonical_digest'
    | 'logical_digest'
    | 'effect_digest'
  >,
): InboundContentEvidence {
  return Object.freeze({
    connectionId: row.connection_id,
    sequence: row.sequence,
    messageId: row.message_id,
    canonicalDigest: row.canonical_digest,
    logicalDigest: row.logical_digest,
    effectDigest: row.effect_digest,
  });
}

function outboxEvidenceDigest(messageId: string): string {
  return createHash('sha256')
    .update('combo:vnext:worker-outbox-row:v1\0', 'utf8')
    .update(messageId, 'utf8')
    .digest('hex');
}

type OutboxContentEvidence = Readonly<{
  messageId: string;
  canonicalDigest: string;
  envelopeType: string;
  responseToMessageId: string | null;
  deliveryDigest: string;
}>;

function outboxEvidenceDigestV2(input: OutboxContentEvidence): string {
  return createHash('sha256')
    .update('combo:vnext:worker-outbox-row:v2\0', 'utf8')
    .update(canonicalizeJson(input), 'utf8')
    .digest('hex');
}

function outboxContentEvidenceFromRow(
  row: Pick<
    OutboxDeliveryRow,
    | 'message_id'
    | 'canonical_digest'
    | 'envelope_type'
    | 'response_to_message_id'
    | 'delivery_digest'
  >,
): OutboxContentEvidence {
  return Object.freeze({
    messageId: row.message_id,
    canonicalDigest: row.canonical_digest,
    envelopeType: row.envelope_type,
    responseToMessageId: row.response_to_message_id,
    deliveryDigest: row.delivery_digest,
  });
}

function xorDigest(left: string, right: string): string {
  if (!SHA256_HEX.test(left) || !SHA256_HEX.test(right)) throw permanentPortFailure();
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    leftBytes[index] = (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return leftBytes.toString('hex');
}

function validateJournalPath(input: string): string {
  if (
    typeof input !== 'string' ||
    input.length === 0 ||
    input === ':memory:' ||
    !isAbsolute(input) ||
    input.includes('\0')
  ) {
    throw new SqliteWorkerTransportError('JOURNAL_PATH_INVALID');
  }
  const normalized = resolve(input);
  if (normalized !== input) throw new SqliteWorkerTransportError('JOURNAL_PATH_INVALID');
  return normalized;
}

function ensureSafeParent(parent: string): void {
  const missing: string[] = [];
  let cursor = parent;
  for (;;) {
    let stats: Stats;
    try {
      stats = lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new SqliteWorkerTransportError('JOURNAL_PARENT_UNSAFE');
      }
      missing.push(cursor);
      const ancestor = dirname(cursor);
      if (ancestor === cursor) throw new SqliteWorkerTransportError('JOURNAL_PARENT_UNSAFE');
      cursor = ancestor;
      continue;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new SqliteWorkerTransportError('JOURNAL_PARENT_UNSAFE');
    }
    try {
      if (resolve(realpathSync(cursor)) !== cursor) {
        throw new SqliteWorkerTransportError('JOURNAL_PARENT_UNSAFE');
      }
    } catch {
      throw new SqliteWorkerTransportError('JOURNAL_PARENT_UNSAFE');
    }
    break;
  }

  for (const directory of missing.reverse()) {
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch {
      throw new SqliteWorkerTransportError('JOURNAL_PARENT_UNSAFE');
    }
    ensurePrivateDirectory(directory);
  }
  ensurePrivateDirectory(parent);
}

function ensurePrivateDirectory(parent: string): void {
  let stats: Stats;
  try {
    stats = lstatSync(parent);
  } catch {
    throw new SqliteWorkerTransportError('JOURNAL_PARENT_UNSAFE');
  }
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== 0o700 ||
    !ownedByCurrentUser(stats)
  ) {
    throw new SqliteWorkerTransportError('JOURNAL_PARENT_UNSAFE');
  }
}

function assertSafeExistingAuxiliaryFiles(filename: string, busyTimeoutMs: number): void {
  const rollbackJournal = `${filename}-journal`;
  const rollbackDeadline = performance.now() + busyTimeoutMs;
  while (safeRegularFileExists(rollbackJournal, 0o600, 'JOURNAL_FILE_UNSAFE')) {
    // A concurrent authorized first-open briefly uses SQLite's rollback journal while it installs
    // the schema and switches the file to WAL. Treat only that private, single-link topology as a
    // bounded serialization barrier; unsafe topology still fails immediately, and a persistent
    // rollback journal fails closed when busy_timeout expires.
    if (performance.now() >= rollbackDeadline) {
      throw new SqliteWorkerTransportError('JOURNAL_FILE_UNSAFE');
    }
    Atomics.wait(
      SQLITE_BUSY_WAIT,
      0,
      0,
      Math.min(10, Math.max(1, rollbackDeadline - performance.now())),
    );
  }
  cleanupSafeAtomicTemps(`${filename}.migration-recovery`);
  for (const suffix of ['-wal', '-shm', '.watermark', '.recovery-reserve', '.migration-recovery']) {
    const path = `${filename}${suffix}`;
    safeRegularFileExists(path, 0o600, 'JOURNAL_FILE_UNSAFE');
  }
}

function migrationRecoveryCandidateDigest(watermark: JournalCommitWatermark): string {
  return createHash('sha256')
    .update(MIGRATION_RECOVERY_CANDIDATE_DIGEST_DOMAIN, 'utf8')
    .update(canonicalizeJson(watermark), 'utf8')
    .digest('hex');
}

function readMigrationRecoveryManifest(filename: string): MigrationRecoveryManifest {
  ensureSafeRegularFile(filename, 0o600, 'JOURNAL_FILE_UNSAFE');
  try {
    const raw = readFileSync(filename, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) {
      throw new Error('migration-recovery-size');
    }
    const document = JSON.parse(raw) as unknown;
    const outer = exactRecord(document, ['digest', 'payload']);
    if (canonicalizeJson(outer) !== raw || typeof outer.digest !== 'string') {
      throw new Error('migration-recovery-document');
    }
    const payload = exactRecord(outer.payload, [
      'candidateSlot',
      'finalizedSlot',
      'formatVersion',
      'legacySlot',
      'nonce',
    ]);
    const canonicalPayload = canonicalizeJson(payload);
    const digest = createHash('sha256')
      .update(MIGRATION_RECOVERY_DIGEST_DOMAIN, 'utf8')
      .update(canonicalPayload, 'utf8')
      .digest('hex');
    if (outer.digest !== digest || payload.formatVersion !== MIGRATION_RECOVERY_FORMAT_VERSION) {
      throw new Error('migration-recovery-digest');
    }
    const nonce = UuidSchema.safeParse(payload.nonce);
    if (!nonce.success) throw new Error('migration-recovery-nonce');
    const legacySlot = exactRecord(payload.legacySlot, [
      'commitEpoch',
      'schemaVersion',
      'watermark',
    ]);
    if (
      legacySlot.schemaVersion !== WORKER_CONVERSATION_READY_SCHEMA_VERSION &&
      legacySlot.schemaVersion !== WORKER_DEFENSIVE_INTEGRITY_SCHEMA_VERSION
    ) {
      throw new Error('migration-recovery-legacy-version');
    }
    const legacySchemaVersion = legacySlot.schemaVersion as 3 | 4;
    const legacyWatermark = parseRecoveryWatermark(legacySlot.watermark, legacySchemaVersion);
    if (legacySlot.commitEpoch !== legacyWatermark.commitEpoch) {
      throw new Error('migration-recovery-legacy');
    }
    let candidateSlot: MigrationRecoveryManifest['candidateSlot'] = null;
    if (payload.candidateSlot !== null) {
      const candidate = exactRecord(payload.candidateSlot, [
        'commitEpoch',
        'schemaVersion',
        'watermark',
      ]);
      const candidateSchemaVersion = (legacySchemaVersion + 1) as 4 | 5;
      const watermark = parseRecoveryWatermark(candidate.watermark, candidateSchemaVersion);
      if (
        candidate.schemaVersion !== candidateSchemaVersion ||
        candidate.commitEpoch !== watermark.commitEpoch ||
        candidate.commitEpoch !== legacyWatermark.commitEpoch + 1 ||
        watermark.applicationId !== legacyWatermark.applicationId ||
        watermark.installationId !== legacyWatermark.installationId ||
        watermark.journalGeneration !== legacyWatermark.journalGeneration ||
        watermark.authorizationDigest !== legacyWatermark.authorizationDigest ||
        watermark.maxDatabaseBytes !== legacyWatermark.maxDatabaseBytes ||
        watermark.maxWalBytes !== legacyWatermark.maxWalBytes ||
        watermark.minFreeBytes !== legacyWatermark.minFreeBytes ||
        watermark.inboundEvidenceCount !==
          (legacySchemaVersion === WORKER_CONVERSATION_READY_SCHEMA_VERSION
            ? 0
            : legacyWatermark.inboundEvidenceCount) ||
        watermark.inboundEvidenceXor !==
          (legacySchemaVersion === WORKER_CONVERSATION_READY_SCHEMA_VERSION
            ? ZERO_DIGEST
            : legacyWatermark.inboundEvidenceXor) ||
        watermark.outboxEvidenceCount !==
          (legacySchemaVersion === WORKER_CONVERSATION_READY_SCHEMA_VERSION
            ? 0
            : legacyWatermark.outboxEvidenceCount) ||
        watermark.outboxEvidenceXor !==
          (legacySchemaVersion === WORKER_CONVERSATION_READY_SCHEMA_VERSION
            ? ZERO_DIGEST
            : legacyWatermark.outboxEvidenceXor) ||
        (legacyWatermark.formatVersion === WATERMARK_FORMAT_VERSION
          ? canonicalizeJson(watermark.currentConnectionAuthority) !==
            canonicalizeJson(legacyWatermark.currentConnectionAuthority)
          : watermark.currentConnectionAuthority !== null)
      ) {
        throw new Error('migration-recovery-candidate');
      }
      candidateSlot = Object.freeze({
        schemaVersion: candidateSchemaVersion,
        commitEpoch: watermark.commitEpoch,
        watermark,
      });
    }
    let finalizedSlot: MigrationRecoveryManifest['finalizedSlot'] = null;
    if (payload.finalizedSlot !== null) {
      const finalized = exactRecord(payload.finalizedSlot, [
        'candidateDigest',
        'commitEpoch',
        'schemaVersion',
      ]);
      if (
        finalized.schemaVersion !== legacySchemaVersion + 1 ||
        !Number.isSafeInteger(finalized.commitEpoch) ||
        Number(finalized.commitEpoch) !== legacyWatermark.commitEpoch + 1 ||
        typeof finalized.candidateDigest !== 'string' ||
        !SHA256_HEX.test(finalized.candidateDigest)
      ) {
        throw new Error('migration-recovery-finalized');
      }
      finalizedSlot = Object.freeze({
        schemaVersion: (legacySchemaVersion + 1) as 4 | 5,
        commitEpoch: Number(finalized.commitEpoch),
        candidateDigest: finalized.candidateDigest,
      });
    }
    if (candidateSlot !== null && finalizedSlot !== null) {
      throw new Error('migration-recovery-double-candidate');
    }
    return Object.freeze({
      formatVersion: MIGRATION_RECOVERY_FORMAT_VERSION,
      nonce: nonce.data,
      legacySlot: Object.freeze({
        schemaVersion: legacySchemaVersion,
        commitEpoch: legacyWatermark.commitEpoch,
        watermark: legacyWatermark,
      }),
      candidateSlot,
      finalizedSlot,
    });
  } catch (error) {
    if (error instanceof SqliteWorkerTransportError) throw error;
    throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
  }
}

function parseRecoveryWatermark(input: unknown, schemaVersion: 3): LegacyJournalCommitWatermark;
function parseRecoveryWatermark(input: unknown, schemaVersion: 4 | 5): JournalCommitWatermark;
function parseRecoveryWatermark(
  input: unknown,
  schemaVersion: 3 | 4 | 5,
): AnyJournalCommitWatermark;
function parseRecoveryWatermark(
  input: unknown,
  schemaVersion: 3 | 4 | 5,
): AnyJournalCommitWatermark {
  const baseKeys = [
    'applicationId',
    'authorityDigest',
    'authorizationDigest',
    'commitEpoch',
    'formatVersion',
    'inboundEvidenceCount',
    'inboundEvidenceXor',
    'installationId',
    'journalGeneration',
    'maxDatabaseBytes',
    'maxWalBytes',
    'minFreeBytes',
    'outboxEvidenceCount',
    'outboxEvidenceXor',
    'schemaDigest',
    'schemaVersion',
  ];
  const row = exactRecord(
    input,
    schemaVersion === 3 ? baseKeys : [...baseKeys, 'currentConnectionAuthority', 'evidenceVersion'],
  );
  const installation = UuidSchema.safeParse(row.installationId);
  const generation = UuidSchema.safeParse(row.journalGeneration);
  if (
    !installation.success ||
    !generation.success ||
    row.applicationId !== WORKER_TRANSPORT_APPLICATION_ID ||
    row.schemaVersion !== schemaVersion ||
    !Number.isSafeInteger(row.commitEpoch) ||
    Number(row.commitEpoch) < 1 ||
    !Number.isSafeInteger(row.inboundEvidenceCount) ||
    Number(row.inboundEvidenceCount) < 0 ||
    !Number.isSafeInteger(row.outboxEvidenceCount) ||
    Number(row.outboxEvidenceCount) < 0 ||
    !Number.isSafeInteger(row.maxDatabaseBytes) ||
    Number(row.maxDatabaseBytes) < 8 * 1024 * 1024 ||
    !Number.isSafeInteger(row.maxWalBytes) ||
    Number(row.maxWalBytes) < 1024 * 1024 ||
    !Number.isSafeInteger(row.minFreeBytes) ||
    Number(row.minFreeBytes) < 0 ||
    typeof row.schemaDigest !== 'string' ||
    !SHA256_HEX.test(row.schemaDigest) ||
    typeof row.authorityDigest !== 'string' ||
    !SHA256_HEX.test(row.authorityDigest) ||
    typeof row.authorizationDigest !== 'string' ||
    !SHA256_HEX.test(row.authorizationDigest) ||
    typeof row.inboundEvidenceXor !== 'string' ||
    !SHA256_HEX.test(row.inboundEvidenceXor) ||
    typeof row.outboxEvidenceXor !== 'string' ||
    !SHA256_HEX.test(row.outboxEvidenceXor)
  ) {
    throw new Error('migration-recovery-watermark');
  }
  const common: JournalCommitWatermarkBase = Object.freeze({
    applicationId: WORKER_TRANSPORT_APPLICATION_ID,
    schemaVersion,
    schemaDigest: row.schemaDigest,
    authorityDigest: row.authorityDigest,
    installationId: installation.data,
    journalGeneration: generation.data,
    authorizationDigest: row.authorizationDigest,
    commitEpoch: Number(row.commitEpoch),
    inboundEvidenceCount: Number(row.inboundEvidenceCount),
    inboundEvidenceXor: row.inboundEvidenceXor,
    outboxEvidenceCount: Number(row.outboxEvidenceCount),
    outboxEvidenceXor: row.outboxEvidenceXor,
    maxDatabaseBytes: Number(row.maxDatabaseBytes),
    maxWalBytes: Number(row.maxWalBytes),
    minFreeBytes: Number(row.minFreeBytes),
  });
  if (schemaVersion === 3) {
    if (row.formatVersion !== LEGACY_WATERMARK_FORMAT_VERSION) {
      throw new Error('migration-recovery-legacy-format');
    }
    return Object.freeze({ ...common, formatVersion: LEGACY_WATERMARK_FORMAT_VERSION });
  }
  if (
    row.formatVersion !== WATERMARK_FORMAT_VERSION ||
    row.evidenceVersion !== WATERMARK_EVIDENCE_VERSION
  ) {
    throw new Error('migration-recovery-current-format');
  }
  let currentConnectionAuthority: CurrentConnectionAuthority | null = null;
  if (row.currentConnectionAuthority !== null) {
    const authority = exactRecord(row.currentConnectionAuthority, [
      'connectionDigest',
      'connectionId',
      'installationId',
    ]);
    const authorityInstallation = UuidSchema.safeParse(authority.installationId);
    const authorityConnection = UuidSchema.safeParse(authority.connectionId);
    if (
      !authorityInstallation.success ||
      !authorityConnection.success ||
      authorityInstallation.data !== installation.data ||
      typeof authority.connectionDigest !== 'string' ||
      !SHA256_HEX.test(authority.connectionDigest)
    ) {
      throw new Error('migration-recovery-current-authority');
    }
    currentConnectionAuthority = Object.freeze({
      installationId: authorityInstallation.data,
      connectionId: authorityConnection.data,
      connectionDigest: authority.connectionDigest,
    });
  }
  return Object.freeze({
    ...common,
    formatVersion: WATERMARK_FORMAT_VERSION,
    evidenceVersion: WATERMARK_EVIDENCE_VERSION,
    schemaVersion,
    currentConnectionAuthority,
  });
}

function exactRecord(input: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('migration-recovery-record');
  }
  const row = input as Record<string, unknown>;
  const actualKeys = Object.keys(row).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error('migration-recovery-keys');
  }
  return row;
}

function cleanupSafeAtomicTemps(filename: string): void {
  const parent = dirname(filename);
  const prefix = `.${basename(filename)}.`;
  let removed = false;
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    if (
      !/^\.[^.]+(?:\.[^.]+)*\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u.test(
        name,
      )
    ) {
      throw new SqliteWorkerTransportError('JOURNAL_FILE_UNSAFE');
    }
    const path = join(parent, name);
    ensureSafeRegularFile(path, 0o600, 'JOURNAL_FILE_UNSAFE');
    unlinkSync(path);
    removed = true;
  }
  if (!removed) return;
  const parentDescriptor = openSync(parent, 'r');
  try {
    fsyncSync(parentDescriptor);
  } finally {
    closeSync(parentDescriptor);
  }
}

function atomicWritePrivateFile(filename: string, contents: string): void {
  const parent = dirname(filename);
  const temporary = join(parent, `.${basename(filename)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    const bytes = Buffer.from(contents, 'utf8');
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
      if (written <= 0) throw new Error('watermark-short-write');
      offset += written;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, filename);
    ensureSafeRegularFile(filename, 0o600, 'JOURNAL_FILE_UNSAFE');
    const parentDescriptor = openSync(parent, 'r');
    try {
      fsyncSync(parentDescriptor);
    } finally {
      closeSync(parentDescriptor);
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original durable-write failure.
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      // The temp name was never created or was already atomically renamed.
    }
    if (error instanceof SqliteWorkerTransportError) throw error;
    throw new SqliteWorkerTransportError('JOURNAL_FILE_UNSAFE');
  }
}

function availableFilesystemBytes(path: string): number {
  try {
    const stats = statfsSync(path, { bigint: true });
    const available = stats.bavail * stats.bsize;
    return available > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : Number(available);
  } catch {
    throw new SqliteWorkerTransportError('JOURNAL_FILE_UNSAFE');
  }
}

function recoveryReserveFileIsPhysical(path: string): boolean {
  const stats = statSync(path);
  return (
    stats.size === WORKER_TRANSPORT_FILESYSTEM_RECOVERY_RESERVE_BYTES &&
    typeof stats.blocks === 'number' &&
    stats.blocks * 512 >= WORKER_TRANSPORT_FILESYSTEM_RECOVERY_RESERVE_BYTES
  );
}

function journalEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new SqliteWorkerTransportError('JOURNAL_FILE_UNSAFE');
  }
}

function ensureSafeRegularFile(
  path: string,
  expectedMode: number,
  code: 'JOURNAL_FILE_UNSAFE',
): void {
  let stats: Stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new SqliteWorkerTransportError(code);
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== expectedMode ||
    !ownedByCurrentUser(stats)
  ) {
    throw new SqliteWorkerTransportError(code);
  }
}

function safeRegularFileExists(
  path: string,
  expectedMode: number,
  code: 'JOURNAL_FILE_UNSAFE',
): boolean {
  let stats: Stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new SqliteWorkerTransportError(code);
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== expectedMode ||
    !ownedByCurrentUser(stats)
  ) {
    throw new SqliteWorkerTransportError(code);
  }
  return true;
}

function ownedByCurrentUser(stats: Stats): boolean {
  const uid = process.getuid?.();
  return uid === undefined || stats.uid === uid;
}

function ownerTokenDigest(token: string): string {
  if (typeof token !== 'string' || token.length < 16 || token.length > 1_024) {
    throw permanentPortFailure();
  }
  return createHash('sha256')
    .update('combo:vnext:worker-owner:v1\0', 'utf8')
    .update(token, 'utf8')
    .digest('hex');
}

function parseNewJournalAuthorization(
  input: NewWorkerJournalAuthorization | undefined,
): NewWorkerJournalAuthorization | undefined {
  if (input === undefined) return undefined;
  const installation = UuidSchema.safeParse(input.installationId);
  const generation = UuidSchema.safeParse(input.journalGeneration);
  if (!installation.success || !generation.success || !SHA256_HEX.test(input.authorizationDigest)) {
    throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
  }
  return Object.freeze({
    installationId: installation.data,
    journalGeneration: generation.data,
    authorizationDigest: input.authorizationDigest,
  });
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function parseUuid(input: string): string {
  const result = UuidSchema.safeParse(input);
  if (!result.success) throw permanentPortFailure();
  return result.data;
}

function parseUint63(input: string): string {
  if (!/^(0|[1-9]\d*)$/u.test(input)) throw permanentPortFailure();
  const value = BigInt(input);
  if (value > 9_223_372_036_854_775_807n) throw permanentPortFailure();
  return value.toString(10);
}

function sameLease(left: LeaseBinding, right: LeaseBinding): boolean {
  return (
    left.deploymentId === right.deploymentId &&
    left.leaseId === right.leaseId &&
    left.workerSessionId === right.workerSessionId &&
    left.fence === right.fence
  );
}

function assertInboundLease(connection: ConnectionRow, envelope: BrokerEnvelope): void {
  const current = leaseFromRow(connection);
  if (envelope.kind === 'command' && envelope.type === 'lease.grant') {
    if (envelope.lease.deploymentId !== current.deploymentId) {
      throw new WorkerBrokerClientError('STALE_LEASE', true);
    }
    const nextFence = BigInt(envelope.lease.fence);
    const currentFence = BigInt(current.fence);
    if (nextFence < currentFence) throw new WorkerBrokerClientError('STALE_FENCE', true);
    if (nextFence === currentFence && !sameLease(envelope.lease, current)) {
      throw new WorkerBrokerClientError('STALE_LEASE', true);
    }
    return;
  }
  if (!sameLease(envelope.lease, current)) {
    throw new WorkerBrokerClientError(
      BigInt(envelope.lease.fence) === BigInt(current.fence) ? 'STALE_LEASE' : 'STALE_FENCE',
      true,
    );
  }
}

function uuidV7(): string {
  const value = randomUUID().toLowerCase();
  return `${value.slice(0, UUID_V7_VERSION_INDEX)}7${value.slice(UUID_V7_VERSION_INDEX + 1)}`;
}

function bounded(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SqliteWorkerTransportError('JOURNAL_CAPACITY');
  }
  return value;
}

function safeDeadline(now: number, duration: number): number {
  const deadline = now + duration;
  if (!Number.isSafeInteger(deadline)) throw permanentPortFailure();
  return deadline;
}

function assertNotAborted(signal: AbortSignal, deadline = Number.POSITIVE_INFINITY): void {
  if (signal.aborted || performance.now() >= deadline) {
    throw new SqliteWorkerTransportError('JOURNAL_ABORTED');
  }
}

function pragmaNumber(database: DatabaseSync, name: string, column = name): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = row?.[column];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new SqliteWorkerTransportError('JOURNAL_PRAGMA_MISMATCH');
  }
  return value;
}

function pragmaText(database: DatabaseSync, name: string): string {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = row?.[name];
  if (typeof value !== 'string') {
    throw new SqliteWorkerTransportError('JOURNAL_PRAGMA_MISMATCH');
  }
  return value;
}

function safeRollback(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK');
  } catch {
    // The original failure is the authority; rollback is best effort only when SQLite closed it.
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; errcode?: unknown; message?: unknown };
  return (
    candidate.code === 'ERR_SQLITE_ERROR' &&
    (candidate.errcode === 5 ||
      candidate.errcode === 6 ||
      candidate.message === 'database is locked' ||
      candidate.message === 'database table is locked')
  );
}

function isSqliteCapacity(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; errcode?: unknown; message?: unknown };
  return (
    candidate.code === 'ERR_SQLITE_ERROR' &&
    (candidate.errcode === 13 ||
      candidate.errcode === 18 ||
      candidate.message === 'database or disk is full' ||
      candidate.message === 'string or blob too big')
  );
}

function isFilesystemCapacity(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ENOSPC' || code === 'EDQUOT' || code === 'EFBIG';
}

function isRecoveryTransaction(operation: string): boolean {
  return (
    operation === 'release_connection' ||
    operation === 'release_installation' ||
    operation === 'prune_retained' ||
    operation === 'invocation_reject_start_permanently' ||
    operation === 'invocation_take_host_prompt' ||
    operation === 'invocation_reject_host_dispatch' ||
    operation === 'invocation_record_dispatch_unknown' ||
    operation === 'invocation_recover_unconfirmed_start' ||
    operation === 'invocation_confirm_host_dispatch' ||
    operation === 'invocation_cancel' ||
    operation === 'invocation_take_host_interrupt' ||
    operation === 'invocation_confirm_host_interrupt' ||
    operation === 'invocation_record_interrupt_unknown' ||
    operation === 'invocation_recover_unconfirmed_interrupt' ||
    operation === 'invocation_recover_host_actions' ||
    operation === 'invocation_write_succeeded' ||
    operation === 'invocation_write_failed' ||
    operation === 'invocation_mark_host_evidence_lost' ||
    operation === 'invocation_mark_cloud_committed' ||
    operation === 'invocation_prune_committed_retention'
  );
}

function normalizeOpenError(error: unknown): Error {
  if (error instanceof SqliteWorkerTransportError || error instanceof WorkerBrokerClientError) {
    return error;
  }
  return new SqliteWorkerTransportError('JOURNAL_CORRUPT');
}

function permanentPortFailure(): WorkerBrokerClientError {
  return new WorkerBrokerClientError('PORT_FAILED', true);
}
