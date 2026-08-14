import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
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
import type { DatabaseSync } from 'node:sqlite';

import {
  BrokerEnvelopeSchema,
  LeaseBindingSchema,
  UuidSchema,
  canonicalSha256,
  canonicalizeJson,
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
  durablePortDeadline,
  type DurableBrokerConnection,
  type LeaseGrantCommand,
  type WorkerBrokerDurableTransportPort,
} from './worker-broker-client.js';

type NodeSqliteModule = Readonly<{ DatabaseSync: typeof DatabaseSync }>;

const loadNodeSqlite = (): NodeSqliteModule =>
  createRequire(import.meta.url)('node:sqlite') as NodeSqliteModule;

export const WORKER_TRANSPORT_APPLICATION_ID = 0x43425754;
export const WORKER_TRANSPORT_SCHEMA_VERSION = 1;
export const WORKER_TRANSPORT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const WORKER_TRANSPORT_SEQUENCE_RETENTION = 1_024;
export const WORKER_TRANSPORT_DEFAULT_MAX_INBOUND_ROWS = 512;
export const WORKER_TRANSPORT_DEFAULT_MAX_OUTBOX_ROWS = 512;
export const WORKER_TRANSPORT_DEFAULT_MAX_RETAINED_INBOUND_ROWS = 1_000_000;
export const WORKER_TRANSPORT_DEFAULT_MAX_RETAINED_OUTBOX_ROWS = 1_000_000;
export const WORKER_TRANSPORT_DEFAULT_MAX_DATABASE_BYTES = 256 * 1024 * 1024;
export const WORKER_TRANSPORT_DEFAULT_MAX_WAL_BYTES = 64 * 1024 * 1024;
export const WORKER_TRANSPORT_DEFAULT_MIN_FREE_BYTES = 64 * 1024 * 1024;

const ACK_RANK = Object.freeze({ RECEIVED: 0, PERSISTED: 1, CLOUD_COMMITTED: 2 });
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const UUID_V7_VERSION_INDEX = 14;
const SQLITE_BUSY_WAIT = new Int32Array(new SharedArrayBuffer(4));
const ZERO_DIGEST = '0'.repeat(64);
const PRUNE_BATCH_SIZE = 128;
const WATERMARK_FORMAT_VERSION = 1;

export type SqliteWorkerTransportFaultPoint =
  | 'migration.before_commit'
  | 'migration.after_commit'
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
  busyTimeoutMs: number;
  pageSize: number;
  maxPageCount: number;
  journalSizeLimit: number;
  walAutocheckpoint: number;
  quickCheck: string;
}>;

type JournalCommitWatermark = Readonly<{
  formatVersion: 1;
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

type OutboxRow = {
  message_id: string;
  installation_id: string;
  connection_id: string | null;
  sequence: string | null;
  canonical_digest: string;
  envelope_json: string;
  state: 'UNBOUND' | 'PENDING' | 'WRITTEN' | 'ACKED' | 'SUPERSEDED';
  ack_level: 'RECEIVED' | 'PERSISTED' | 'CLOUD_COMMITTED' | null;
};

type CountRow = { count: number };

type InboundEffectRow = {
  connection_id: string;
  sequence: string;
  message_id: string;
  canonical_digest: string;
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
  readonly #now: () => number;
  readonly #faultInjector?: (point: SqliteWorkerTransportFaultPoint) => void;
  #transactionDeadline = Number.POSITIVE_INFINITY;
  #walQuotaProtection = false;
  #poisoned = false;
  #closed = false;

  constructor(options: SqliteWorkerTransportOptions) {
    this.#filename = validateJournalPath(options.filename);
    this.#watermarkFilename = `${this.#filename}.watermark`;
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
    this.#now = options.now ?? Date.now;
    this.#faultInjector = options.faultInjector;

    let existed = journalEntryExists(this.#filename);
    if (!existed && this.#newJournalAuthorization === undefined) {
      throw new SqliteWorkerTransportError('JOURNAL_MISSING');
    }
    ensureSafeParent(dirname(this.#filename));
    assertSafeExistingAuxiliaryFiles(this.#filename);
    if (!existed && journalEntryExists(this.#watermarkFilename)) {
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
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
    return this.#transaction('commit_inbound', input.signal, () => {
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
      if (duplicateEffect) {
        this.#reactivateReplayResponse(installationId, connectionId, envelope.messageId, now);
      } else {
        this.#applyInboundEffect(envelope, connection, now);
      }
      return durableConnection(
        this.#requireActiveConnection(installationId, connectionId, ownerEpoch),
      );
    });
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
    return this.#transaction('replay_inbound', input.signal, () => {
      const { now, ownerEpoch } = this.#assertAndRefreshOwner(installationId, input.ownerToken);
      this.#requireActiveConnection(installationId, connectionId, ownerEpoch);
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
      this.#database
        .prepare(
          `UPDATE transport_inbound_frames
           SET replay_count = replay_count + 1, retained_until_ms = COALESCE(retained_until_ms, ?)
           WHERE connection_id = ? AND sequence = ?`,
        )
        .run(safeDeadline(now, WORKER_TRANSPORT_RETENTION_MS), connectionId, envelope.sequence);
      this.#refreshInboundEffectDigest(connectionId, envelope.sequence);
      this.#reactivateReplayResponse(installationId, connectionId, envelope.messageId, now);
      return 'EXACT_REPLAY';
    });
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
        this.#refreshOutboxDeliveryDigest(messageId);
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
                  f.logical_digest, f.envelope_json, f.effect_state
           FROM transport_inbound_frames AS f
           JOIN transport_connections AS c ON c.connection_id = f.connection_id
           WHERE c.installation_id = ? AND f.envelope_kind = 'command'
             AND c.owner_epoch = ? AND f.connection_id = ? AND f.effect_state = 'PERSISTED'
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
      }>;
      return rows.map((row) => {
        const envelope = parseStoredEnvelope(row.envelope_json, row.canonical_digest);
        if (
          envelope.kind !== 'command' ||
          envelope.connectionId !== row.connection_id ||
          envelope.sequence !== row.sequence ||
          envelope.messageId !== row.message_id ||
          logicalEnvelopeDigest(envelope) !== row.logical_digest
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

  inspectPragmas(): WorkerTransportPragmas {
    this.#assertOpen();
    return Object.freeze({
      applicationId: pragmaNumber(this.#database, 'application_id'),
      userVersion: pragmaNumber(this.#database, 'user_version'),
      journalMode: pragmaText(this.#database, 'journal_mode'),
      synchronous: pragmaNumber(this.#database, 'synchronous'),
      foreignKeys: pragmaNumber(this.#database, 'foreign_keys'),
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
    let userVersion = pragmaNumber(this.#database, 'user_version');
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
      userVersion = pragmaNumber(this.#database, 'user_version');
      if (userVersion !== WORKER_TRANSPORT_SCHEMA_VERSION) {
        throw new SqliteWorkerTransportError('JOURNAL_SCHEMA_UNSUPPORTED');
      }
    }
    if (userVersion === 0 && this.#newJournalAuthorization === undefined) {
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
    const existingJournalMode = pragmaText(this.#database, 'journal_mode').toLowerCase();
    if (
      existed &&
      userVersion === WORKER_TRANSPORT_SCHEMA_VERSION &&
      existingJournalMode !== 'wal'
    ) {
      throw new SqliteWorkerTransportError('JOURNAL_PRAGMA_MISMATCH');
    }
    const pageSize = pragmaNumber(this.#database, 'page_size');
    const maxPageCount = Math.floor(this.#maxDatabaseBytes / pageSize);
    this.#database.exec(`
      ${userVersion === 0 ? 'PRAGMA journal_mode = WAL;' : ''}
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = ${this.#busyTimeoutMs};
      PRAGMA trusted_schema = OFF;
      PRAGMA max_page_count = ${maxPageCount};
      PRAGMA journal_size_limit = ${this.#maxWalBytes};
      PRAGMA wal_autocheckpoint = 256;
    `);
    if (userVersion === WORKER_TRANSPORT_SCHEMA_VERSION) return;

    this.#database.exec('BEGIN EXCLUSIVE');
    let committed = false;
    try {
      const lockedVersion = pragmaNumber(this.#database, 'user_version');
      if (lockedVersion === WORKER_TRANSPORT_SCHEMA_VERSION) {
        this.#database.exec('COMMIT');
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
      committed = true;
      this.#secureJournalFiles();
      this.#faultInjector?.('migration.after_commit');
    } catch (error) {
      if (!committed) safeRollback(this.#database);
      if (isSqliteCapacity(error)) throw new WorkerBrokerClientError('CAPACITY_EXCEEDED');
      throw error;
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
        databaseWatermark = this.#readDatabaseWatermark();
        this.#database.exec('COMMIT');
        completed = true;
      } finally {
        if (!completed) safeRollback(this.#database);
      }
      try {
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

  #readDatabaseWatermark(): JournalCommitWatermark {
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
    return Object.freeze({
      formatVersion: WATERMARK_FORMAT_VERSION,
      applicationId: WORKER_TRANSPORT_APPLICATION_ID,
      schemaVersion: WORKER_TRANSPORT_SCHEMA_VERSION,
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
    });
  }

  #writeExternalWatermark(watermark: JournalCommitWatermark): void {
    const payload = canonicalizeJson(watermark);
    const document = canonicalizeJson({
      payload: watermark,
      digest: createHash('sha256')
        .update('combo:vnext:worker-commit-watermark:v1\0', 'utf8')
        .update(payload, 'utf8')
        .digest('hex'),
    });
    if (journalEntryExists(this.#watermarkFilename)) {
      ensureSafeRegularFile(this.#watermarkFilename, 0o600, 'JOURNAL_FILE_UNSAFE');
    }
    atomicWritePrivateFile(this.#watermarkFilename, document);
  }

  #assertExternalWatermark(expected: JournalCommitWatermark): void {
    if (!journalEntryExists(this.#watermarkFilename)) {
      throw new SqliteWorkerTransportError('JOURNAL_CORRUPT');
    }
    ensureSafeRegularFile(this.#watermarkFilename, 0o600, 'JOURNAL_FILE_UNSAFE');
    try {
      const raw = readFileSync(this.#watermarkFilename, 'utf8');
      const parsed = JSON.parse(raw) as { payload?: unknown; digest?: unknown };
      const payload = parsed.payload as JournalCommitWatermark;
      const canonicalPayload = canonicalizeJson(payload);
      const expectedDigest = createHash('sha256')
        .update('combo:vnext:worker-commit-watermark:v1\0', 'utf8')
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
            : event.from_state !== previous.to_state || event.message_id !== previous.message_id) ||
          event.from_state !== null
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
          inboundEvidenceDigest(row.connection_id, row.sequence, row.message_id),
        );
        inboundEvidenceCount += 1;
        if (row.effect_state === 'PERSISTED') pendingInboundCount += 1;
        const latestEffect = latestEffectEvents.get(inboundKey);
        const envelope = parseStoredEnvelope(row.envelope_json, row.canonical_digest);
        const priorLogicalDigest = inboundMessageDigests.get(envelope.messageId);
        if (
          envelope.kind === 'event' ||
          envelope.kind !== row.envelope_kind ||
          envelope.type !== row.envelope_type ||
          envelope.connectionId !== row.connection_id ||
          envelope.sequence !== row.sequence ||
          envelope.messageId !== row.message_id ||
          logicalEnvelopeDigest(envelope) !== row.logical_digest ||
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
          if (
            envelope.body.decision !== 'APPLIED' &&
            envelope.body.decision !== 'IDEMPOTENT_REPLAY'
          ) {
            throw new Error('invalid-ack-decision');
          }
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
        outboxEvidenceXor = xorDigest(outboxEvidenceXor, outboxEvidenceDigest(row.message_id));
        outboxEvidenceCount += 1;
        if (row.state === 'UNBOUND' || row.state === 'PENDING' || row.state === 'WRITTEN') {
          activeOutboxCount += 1;
        }
        const envelope = parseStoredEnvelope(row.envelope_json, row.canonical_digest);
        const bound = row.state !== 'UNBOUND';
        const responseCommandType =
          row.response_to_message_id === null
            ? undefined
            : inboundCommandTypes.get(row.response_to_message_id);
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
         WHERE name LIKE 'transport_%' AND sql IS NOT NULL
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
    return createHash('sha256')
      .update('combo:vnext:worker-authority:v1\0', 'utf8')
      .update(canonicalizeJson({ installation, owners, fences }), 'utf8')
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
    const callerDeadline = durablePortDeadline(signal);
    const localDeadline = performance.now() + this.#operationTimeoutMs;
    const deadline = Math.min(callerDeadline ?? Number.POSITIVE_INFINITY, localDeadline);
    const previousDeadline = this.#transactionDeadline;
    this.#transactionDeadline = deadline;
    let began = false;
    let committed = false;
    let previousWatermark: JournalCommitWatermark | undefined;
    let watermarkWriteStarted = false;
    try {
      assertNotAborted(signal, deadline);
      this.#assertStorageBudget(name);
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
      // COMMIT is the operation's linearization point. A reader can pin WAL pages and make a
      // post-COMMIT checkpoint unable to shrink the file; that must never turn a committed call
      // into an apparent failure. Enter protection and reject the *next* mutation before BEGIN.
      this.#checkpointWalIfNeeded();
      this.#secureJournalFiles();
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
    }
  }

  #assertTransactionBudget(): void {
    if (performance.now() >= this.#transactionDeadline) {
      throw new SqliteWorkerTransportError('JOURNAL_ABORTED');
    }
  }

  #assertStorageBudget(operation: string): void {
    this.#assertTransactionBudget();
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
    if (databaseBytes > this.#maxDatabaseBytes) {
      throw new WorkerBrokerClientError('CAPACITY_EXCEEDED');
    }
    if (walBytes > this.#maxWalBytes || this.#walQuotaProtection) {
      this.#tryCheckpointAndTruncateWal();
      this.#assertTransactionBudget();
      walBytes = journalEntryExists(`${this.#filename}-wal`)
        ? statSync(`${this.#filename}-wal`).size
        : 0;
      if (walBytes > this.#maxWalBytes) {
        this.#walQuotaProtection = true;
        throw new WorkerBrokerClientError('CAPACITY_EXCEEDED');
      }
      this.#walQuotaProtection = false;
    }
    const emergencyOperation =
      operation === 'release_connection' ||
      operation === 'release_installation' ||
      operation === 'prune_retained';
    if (
      !emergencyOperation &&
      availableFilesystemBytes(dirname(this.#filename)) < this.#minFreeBytes
    ) {
      throw new WorkerBrokerClientError('CAPACITY_EXCEEDED');
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
        `SELECT logical_digest, effect_state FROM transport_inbound_frames
         WHERE message_id = ? ORDER BY recorded_at_ms LIMIT 1`,
      )
      .get(envelope.messageId) as
      | { logical_digest: string; effect_state: 'PERSISTED' | 'APPLIED' }
      | undefined;
    if (prior !== undefined && prior.logical_digest !== logicalDigest) {
      throw new WorkerBrokerClientError('SEQUENCE_CONFLICT', true);
    }
    const duplicateEffect = prior !== undefined;
    const storedEffectState = duplicateEffect ? 'APPLIED' : effectState;
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
      inboundEvidenceDigest(envelope.connectionId, envelope.sequence, envelope.messageId),
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
    const changed = this.#database
      .prepare(
        `UPDATE transport_outbox SET state = 'PENDING', updated_at_ms = ?
         WHERE message_id = ? AND installation_id = ? AND connection_id = ?
           AND response_to_message_id = ? AND state = 'WRITTEN'
           AND (ack_level IS NULL OR ack_level <> 'CLOUD_COMMITTED')`,
      )
      .run(now, row.message_id, installationId, connectionId, responseToMessageId);
    if (Number(changed.changes) !== 1) throw permanentPortFailure();
    this.#refreshOutboxDeliveryDigest(row.message_id);
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
    this.#adjustEvidenceAccumulator('outbox', outboxEvidenceDigest(frame.messageId), 1);
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
      this.#refreshOutboxDeliveryDigest(messageId);
      return;
    }
    this.#database
      .prepare(`UPDATE transport_outbox SET ack_level = ?, updated_at_ms = ? WHERE message_id = ?`)
      .run(level, now, messageId);
    this.#refreshOutboxDeliveryDigest(messageId);
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
      this.#refreshOutboxDeliveryDigest(row.message_id);
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
      this.#refreshOutboxDeliveryDigest(row.message_id);
      if (row.envelope_type !== 'message.ack') {
        const removed = this.#database
          .prepare(
            `DELETE FROM transport_outbox
             WHERE message_id = ? AND state = 'SUPERSEDED'`,
          )
          .run(row.message_id);
        if (Number(removed.changes) === 1) {
          this.#adjustEvidenceAccumulator('outbox', outboxEvidenceDigest(row.message_id), -1);
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
    const deletedActivation = this.#database
      .prepare(
        `DELETE FROM transport_inbound_frames
         WHERE connection_id = ? AND sequence = ? AND message_id = ?`,
      )
      .run(connectionId, activation.sequence, activation.message_id);
    if (Number(deletedActivation.changes) !== 1) throw permanentPortFailure();
    this.#adjustEvidenceAccumulator(
      'inbound',
      inboundEvidenceDigest(connectionId, activation.sequence, activation.message_id),
      -1,
    );
    const deletedConnection = this.#database
      .prepare(`DELETE FROM transport_connections WHERE connection_id = ? AND status = 'RELEASED'`)
      .run(connectionId);
    if (Number(deletedConnection.changes) !== 1) throw permanentPortFailure();
    return 2;
  }

  #refreshInboundEffectDigest(connectionId: string, sequence: string): void {
    const row = this.#database
      .prepare(
        `SELECT connection_id, sequence, message_id, canonical_digest, effect_state,
                effect_digest, replay_count, recorded_at_ms, applied_at_ms, retained_until_ms
         FROM transport_inbound_frames WHERE connection_id = ? AND sequence = ?`,
      )
      .get(connectionId, sequence) as InboundEffectRow | undefined;
    if (row === undefined) throw permanentPortFailure();
    this.#database
      .prepare(
        `UPDATE transport_inbound_frames SET effect_digest = ?
         WHERE connection_id = ? AND sequence = ?`,
      )
      .run(inboundEffectDigestFromRow(row), connectionId, sequence);
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

  #refreshOutboxDeliveryDigest(messageId: string): void {
    const row = this.#database
      .prepare(
        `SELECT message_id, installation_id, connection_id, sequence, canonical_digest,
                envelope_json, state, ack_level, delivery_digest, created_at_ms, updated_at_ms,
                acked_at_ms, retained_until_ms
         FROM transport_outbox WHERE message_id = ?`,
      )
      .get(messageId) as OutboxDeliveryRow | undefined;
    if (row === undefined) throw permanentPortFailure();
    this.#database
      .prepare('UPDATE transport_outbox SET delivery_digest = ? WHERE message_id = ?')
      .run(outboxDeliveryDigestFromRow(row), messageId);
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

  #pruneExpiredRows(now: number): number {
    let pruned = 0;
    const expiredOutbox = this.#database
      .prepare(
        `SELECT message_id FROM transport_outbox
         WHERE state IN ('ACKED', 'SUPERSEDED')
           AND retained_until_ms IS NOT NULL AND retained_until_ms <= ?
         ORDER BY retained_until_ms, message_id LIMIT ?`,
      )
      .all(now, PRUNE_BATCH_SIZE) as Array<{ message_id: string }>;
    for (const row of expiredOutbox) {
      this.#assertTransactionBudget();
      const result = this.#database
        .prepare(
          `DELETE FROM transport_outbox
           WHERE message_id = ? AND state IN ('ACKED', 'SUPERSEDED')
             AND retained_until_ms IS NOT NULL AND retained_until_ms <= ?`,
        )
        .run(row.message_id, now);
      if (Number(result.changes) === 1) {
        this.#adjustEvidenceAccumulator('outbox', outboxEvidenceDigest(row.message_id), -1);
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
          inboundEvidenceDigest(row.connection_id, row.sequence, row.message_id),
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
           WHERE effect_state = 'PERSISTED'`
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

  #outboxRow(messageId: string): OutboxRow | undefined {
    return this.#database
      .prepare(
        `SELECT message_id, installation_id, connection_id, sequence, canonical_digest,
                envelope_json, state, ack_level
         FROM transport_outbox WHERE message_id = ?`,
      )
      .get(messageId) as OutboxRow | undefined;
  }

  #secureJournalFiles(): void {
    ensureSafeParent(dirname(this.#filename));
    ensureSafeRegularFile(this.#filename, 0o600, 'JOURNAL_FILE_UNSAFE');
    if (journalEntryExists(`${this.#filename}-journal`)) {
      throw new SqliteWorkerTransportError('JOURNAL_FILE_UNSAFE');
    }
    for (const suffix of ['-wal', '-shm', '.watermark']) {
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

function logicalEnvelopeDigest(envelope: BrokerEnvelope): string {
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

function outboxEvidenceDigest(messageId: string): string {
  return createHash('sha256')
    .update('combo:vnext:worker-outbox-row:v1\0', 'utf8')
    .update(messageId, 'utf8')
    .digest('hex');
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

function assertSafeExistingAuxiliaryFiles(filename: string): void {
  if (journalEntryExists(`${filename}-journal`)) {
    throw new SqliteWorkerTransportError('JOURNAL_FILE_UNSAFE');
  }
  for (const suffix of ['-wal', '-shm', '.watermark']) {
    const path = `${filename}${suffix}`;
    if (journalEntryExists(path)) {
      ensureSafeRegularFile(path, 0o600, 'JOURNAL_FILE_UNSAFE');
    }
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

function normalizeOpenError(error: unknown): Error {
  if (error instanceof SqliteWorkerTransportError || error instanceof WorkerBrokerClientError) {
    return error;
  }
  return new SqliteWorkerTransportError('JOURNAL_CORRUPT');
}

function permanentPortFailure(): WorkerBrokerClientError {
  return new WorkerBrokerClientError('PORT_FAILED', true);
}
