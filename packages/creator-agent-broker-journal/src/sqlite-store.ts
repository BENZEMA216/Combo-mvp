import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { commitWorkerAfterCommitEffects } from './effect-authority.js';
import {
  canonicalWorkerJson,
  parseCanonicalWorkerJson,
  snapshotWorkerInvocationEvent,
  snapshotWorkerInvocationState,
  utf8ByteLength,
  validateDurableWorkerEffect,
  workerStorageFingerprint,
} from './durable-codec.js';
import {
  readExactWorkerSealedResultEnvelope,
  type WorkerResultSealAuthority,
} from './result-seal.js';
import {
  MAX_DURABLE_SEALED_ENVELOPE_BYTES,
  type WorkerSqliteFaultPoint,
} from './sqlite-store-internal.js';
import {
  assertSafeWorkerSqliteSidecars,
  openWorkerSqliteDatabase,
  type CheckedWorkerSqliteStoreOptions,
} from './sqlite-store-platform.js';
import {
  ENVELOPE_FINGERPRINT_DOMAIN,
  EVENT_FINGERPRINT_DOMAIN,
  OUTBOX_FINGERPRINT_DOMAIN,
  RECOVERY_FINGERPRINT_DOMAIN,
  STATE_FINGERPRINT_DOMAIN,
  assertFingerprint,
  decodeInvocationRow,
  decodeOutboxReference,
  decodeStoredEvent,
  durableFactType,
  durableView,
  normalizeWorkerInvocationEvent,
  parseRecovery,
  recoverySnapshot,
  requiredRow,
  rowInteger,
  rowNullableInteger,
  rowString,
  terminalSuccess,
  validateWorkerSqliteDatabaseRows,
  workerFactIdentifier,
  type WorkerSqliteInvocationRow,
} from './sqlite-store-records.js';
import {
  WorkerSqliteStoreError,
  type WorkerDurableInvocationView,
  type WorkerInvocationCursor,
  type WorkerOutboxFact,
  type WorkerOutboxFactHandoff,
  type WorkerOutboxFactReference,
  type WorkerSqliteAcquireResult,
  type WorkerSqliteCommitResult,
  type WorkerSqliteOwner,
  type WorkerSqliteRecoveryRecord,
  type WorkerSqliteStore,
  type WorkerSqliteStoreErrorCode,
  type WorkerSqliteStoreOptions,
} from './sqlite-store-types.js';
import {
  createPreparedWorkerInvocation,
  reduceWorkerInvocation,
  type WorkerAfterCommitEffect,
  type WorkerDurableEffect,
  type WorkerInvocationEvent,
  type WorkerInvocationState,
} from './worker-invocation.js';

export { WorkerSqliteStoreError } from './sqlite-store-types.js';
export type {
  WorkerDurableInvocationView,
  WorkerInvocationCursor,
  WorkerOutboxFact,
  WorkerOutboxFactHandoff,
  WorkerOutboxFactReference,
  WorkerSqliteAcquireResult,
  WorkerSqliteCommitResult,
  WorkerSqliteOwner,
  WorkerSqliteRecoveryRecord,
  WorkerSqliteStore,
  WorkerSqliteStoreErrorCode,
  WorkerSqliteStoreOptions,
} from './sqlite-store-types.js';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const DEFAULT_OWNER_LEASE_MS = 30_000;
const MAX_OWNER_LEASE_MS = 300_000;
const DEFAULT_PENDING_FACT_LIMIT = 64;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

type OwnerRecord = {
  tokenDigest: string;
  epoch: number;
  leaseExpiresAtMs: number;
  active: boolean;
};

type CursorRecord = {
  owner: WorkerSqliteOwner;
  invocationId: string;
  revision: number;
  state: WorkerInvocationState;
  stateFingerprint: string;
  active: boolean;
};

type TransactionCommit = Readonly<{
  invocation: WorkerDurableInvocationView;
  state: WorkerInvocationState | null;
  outboxFacts: readonly WorkerOutboxFactReference[];
  rawAfterCommit: readonly WorkerAfterCommitEffect[];
  disposition: 'APPLIED' | 'EXACT_REPLAY';
}>;

export function createFreshWorkerSqliteStore(options: WorkerSqliteStoreOptions): WorkerSqliteStore {
  return openWorkerSqliteStore(options, 'CREATE_FRESH');
}

export function openExistingWorkerSqliteStore(
  options: WorkerSqliteStoreOptions,
): WorkerSqliteStore {
  return openWorkerSqliteStore(options, 'OPEN_EXISTING');
}

function openWorkerSqliteStore(
  options: WorkerSqliteStoreOptions,
  mode: 'CREATE_FRESH' | 'OPEN_EXISTING',
): WorkerSqliteStore {
  const opened = openWorkerSqliteDatabase(options, mode);
  try {
    return new SqliteStore(opened.database, opened.options);
  } catch (error) {
    try {
      opened.database.close();
    } catch {
      // The row-validation error is authoritative.
    }
    throw normalizeError(error);
  }
}

class SqliteStore implements WorkerSqliteStore {
  readonly #owners = new WeakMap<object, OwnerRecord>();
  readonly #cursors = new WeakMap<object, CursorRecord>();
  readonly #live = new Map<string, { cursor: WorkerInvocationCursor; record: CursorRecord }>();
  readonly #now: () => number;
  readonly #fault: ((point: WorkerSqliteFaultPoint) => void) | undefined;
  #activeOwner: WorkerSqliteOwner | null = null;
  #closed = false;
  #poisoned = false;

  public constructor(
    private readonly database: DatabaseSync,
    private readonly options: CheckedWorkerSqliteStoreOptions,
  ) {
    this.#now = options.hooks.now ?? Date.now;
    this.#fault = options.hooks.fault;
    try {
      this.database.exec('BEGIN');
      validateWorkerSqliteDatabaseRows(this.database);
      this.database.exec('COMMIT');
    } catch (error) {
      try {
        if (this.database.isTransaction) this.database.exec('ROLLBACK');
      } catch {
        // The validation failure is authoritative; the open boundary closes this database.
      }
      throw error;
    }
  }

  public acquireOwner(options: Readonly<{ leaseMs?: number }> = {}): WorkerSqliteAcquireResult {
    this.#assertOpen();
    if (this.#activeOwner !== null) throw storeError('OWNER_BUSY', 'Store already has an owner.');
    const leaseMs = validateLease(options.leaseMs ?? DEFAULT_OWNER_LEASE_MS);
    const tokenDigest = digestOwnerToken(randomBytes(32));
    const preparedStates: Array<{
      invocationId: string;
      revision: number;
      state: WorkerInvocationState;
    }> = [];

    const acquired = this.#transaction(() => {
      const now = checkedNow(this.#now());
      const current = this.database
        .prepare(
          `SELECT owner_token_digest, owner_epoch, lease_expires_at_ms
             FROM worker_store_owner WHERE singleton = 1`,
        )
        .get() as Record<string, unknown> | undefined;
      if (current !== undefined && rowInteger(current, 'lease_expires_at_ms') > now) {
        throw storeError('OWNER_BUSY', 'Another Worker owner lease is still active.');
      }
      const meta = requiredRow(
        this.database
          .prepare('SELECT highest_owner_epoch FROM worker_store_meta WHERE singleton = 1')
          .get(),
        'Store meta row is missing.',
      );
      const epoch = rowInteger(meta, 'highest_owner_epoch') + 1;
      const leaseExpiresAtMs = checkedLeaseExpiry(now, leaseMs);
      this.database
        .prepare('UPDATE worker_store_meta SET highest_owner_epoch = ? WHERE singleton = 1')
        .run(epoch);
      this.database
        .prepare(
          `INSERT INTO worker_store_owner
             (singleton, owner_token_digest, owner_epoch, lease_expires_at_ms, acquired_at_ms)
           VALUES (1, ?, ?, ?, ?)
           ON CONFLICT(singleton) DO UPDATE SET
             owner_token_digest = excluded.owner_token_digest,
             owner_epoch = excluded.owner_epoch,
             lease_expires_at_ms = excluded.lease_expires_at_ms,
             acquired_at_ms = excluded.acquired_at_ms`,
        )
        .run(tokenDigest, epoch, leaseExpiresAtMs, now);

      const recovered: WorkerSqliteRecoveryRecord[] = [];
      for (const row of this.#readAllInvocationRows()) {
        if (row.phase === 'PREPARED') {
          preparedStates.push({
            invocationId: row.invocationId,
            revision: row.revision,
            state: createPreparedWorkerInvocation(),
          });
          continue;
        }
        if (row.phase !== 'DISPATCHING' && row.phase !== 'RUNNING') continue;
        const recovery = parseRecovery(row);
        const operationId = recoveryOperationId(epoch, row.invocationId);
        const eventValue = Object.freeze({ type: 'PROCESS_RECOVERY_WITHOUT_HANDLE' });
        const eventJson = canonicalWorkerJson(eventValue);
        const semanticFingerprint = workerStorageFingerprint(EVENT_FINGERPRINT_DOMAIN, eventValue);
        const nextRevision = row.revision + 1;
        const nextJson = canonicalWorkerJson(recovery.next);
        const nextFingerprint = workerStorageFingerprint(STATE_FINGERPRINT_DOMAIN, recovery.next);
        this.database
          .prepare(
            `INSERT INTO worker_invocation_events
               (operation_id, invocation_id, semantic_fingerprint, event_type, event_json,
                from_revision, to_revision, state_fingerprint, committed_owner_epoch, occurred_at_ms)
             VALUES (?, ?, ?, 'PROCESS_RECOVERY_WITHOUT_HANDLE', ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            operationId,
            row.invocationId,
            semanticFingerprint,
            eventJson,
            row.revision,
            nextRevision,
            nextFingerprint,
            epoch,
            now,
          );
        const updated = this.database
          .prepare(
            `UPDATE worker_invocations SET
               revision = ?, phase = 'TERMINAL_READY', state_json = ?, state_fingerprint = ?,
               recovery_json = NULL, recovery_fingerprint = NULL, sealed_result_id = NULL,
               last_owner_epoch = ?, updated_at_ms = ?
             WHERE invocation_id = ? AND revision = ? AND state_fingerprint = ?`,
          )
          .run(
            nextRevision,
            nextJson,
            nextFingerprint,
            epoch,
            now,
            row.invocationId,
            row.revision,
            row.stateFingerprint,
          );
        if (Number(updated.changes) !== 1) {
          throw storeError('STORE_CORRUPT', 'Recovery lost its Invocation compare-and-swap.');
        }
        const terminalFact = this.#insertOutbox(
          row.invocationId,
          operationId,
          recovery.durable,
          null,
          now,
        );
        recovered.push({
          invocationId: row.invocationId,
          fromPhase: row.phase,
          toRevision: nextRevision,
          terminalFact,
        });
      }
      return { epoch, leaseExpiresAtMs, recovered };
    });

    const owner = Object.freeze({
      storeIdentity: this.options.storeIdentity,
      epoch: acquired.epoch,
    }) as WorkerSqliteOwner;
    const ownerRecord: OwnerRecord = {
      tokenDigest,
      epoch: acquired.epoch,
      leaseExpiresAtMs: acquired.leaseExpiresAtMs,
      active: true,
    };
    this.#owners.set(owner, ownerRecord);
    this.#activeOwner = owner;
    const prepared = preparedStates.map(({ invocationId, revision, state }) =>
      this.#mintCursor(owner, invocationId, revision, state),
    );
    return Object.freeze({
      owner,
      recovered: Object.freeze(acquired.recovered),
      prepared: Object.freeze(prepared),
    });
  }

  public renewOwner(owner: WorkerSqliteOwner, leaseMs = DEFAULT_OWNER_LEASE_MS): WorkerSqliteOwner {
    const record = this.#ownerRecord(owner);
    const checkedLeaseMs = validateLease(leaseMs);
    const leaseExpiresAtMs = this.#transaction(() => {
      const now = checkedNow(this.#now());
      const expiresAt = checkedLeaseExpiry(now, checkedLeaseMs);
      this.#assertOwnerInTransaction(record, now);
      const updated = this.database
        .prepare(
          `UPDATE worker_store_owner SET lease_expires_at_ms = ?
           WHERE singleton = 1 AND owner_token_digest = ? AND owner_epoch = ?`,
        )
        .run(expiresAt, record.tokenDigest, record.epoch);
      if (Number(updated.changes) !== 1) throw storeError('OWNER_STALE', 'Owner was fenced.');
      return expiresAt;
    });
    record.leaseExpiresAtMs = leaseExpiresAtMs;
    return owner;
  }

  public prepareInvocation(
    owner: WorkerSqliteOwner,
    input: Readonly<{ invocationId: string; operationId: string }>,
  ): WorkerSqliteCommitResult {
    const ownerRecord = this.#ownerRecord(owner);
    const invocationId = validateIdentifier(input.invocationId, 'Invocation ID');
    const operationId = validateIdentifier(input.operationId, 'Operation ID');
    const event = Object.freeze({ type: 'PREPARE_CREATED' });
    const eventJson = canonicalWorkerJson(event);
    const eventFingerprint = workerStorageFingerprint(EVENT_FINGERPRINT_DOMAIN, event);
    const prepared = createPreparedWorkerInvocation();
    const snapshot = snapshotWorkerInvocationState(prepared);
    const stateJson = canonicalWorkerJson(snapshot);
    const stateFingerprint = workerStorageFingerprint(STATE_FINGERPRINT_DOMAIN, snapshot);

    const transaction = this.#transaction((): TransactionCommit => {
      const now = checkedNow(this.#now());
      this.#assertOwnerInTransaction(ownerRecord, now);
      const replay = this.#operationReplay(operationId, invocationId, eventFingerprint);
      if (replay !== null) return replay;
      if (
        this.database
          .prepare('SELECT 1 AS present FROM worker_invocations WHERE invocation_id = ?')
          .get(invocationId) !== undefined
      ) {
        throw storeError('INVOCATION_CONFLICT', 'Invocation already exists.');
      }
      this.database
        .prepare(
          `INSERT INTO worker_invocations
             (invocation_id, revision, phase, state_json, state_fingerprint,
              recovery_json, recovery_fingerprint, sealed_result_id, last_owner_epoch,
              created_at_ms, updated_at_ms)
           VALUES (?, 0, 'PREPARED', ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
        )
        .run(invocationId, stateJson, stateFingerprint, ownerRecord.epoch, now, now);
      this.database
        .prepare(
          `INSERT INTO worker_invocation_events
             (operation_id, invocation_id, semantic_fingerprint, event_type, event_json,
              from_revision, to_revision, state_fingerprint, committed_owner_epoch, occurred_at_ms)
           VALUES (?, ?, ?, 'PREPARE_CREATED', ?, -1, 0, ?, ?, ?)`,
        )
        .run(
          operationId,
          invocationId,
          eventFingerprint,
          eventJson,
          stateFingerprint,
          ownerRecord.epoch,
          now,
        );
      this.#fault?.('AFTER_EVENT_INSERT');
      return {
        disposition: 'APPLIED',
        invocation: durableView({
          invocationId,
          revision: 0,
          phase: 'PREPARED',
          stateJson,
          stateFingerprint,
          recoveryJson: null,
          recoveryFingerprint: null,
          sealedResultId: null,
        }),
        state: prepared,
        outboxFacts: [],
        rawAfterCommit: [],
      };
    });
    return this.#finishCommit(owner, ownerRecord, transaction);
  }

  public commitInvocationEvent<TEnvelope extends object>(
    owner: WorkerSqliteOwner,
    cursor: WorkerInvocationCursor,
    input: Readonly<{
      operationId: string;
      event: WorkerInvocationEvent;
      resultSealAuthority?: WorkerResultSealAuthority<TEnvelope>;
    }>,
  ): WorkerSqliteCommitResult {
    const ownerRecord = this.#ownerRecord(owner);
    const cursorRecord = this.#cursorRecord(owner, cursor);
    const operationId = validateIdentifier(input.operationId, 'Operation ID');
    snapshotWorkerInvocationEvent(input.event);
    const event = normalizeWorkerInvocationEvent(input.event);
    const eventSnapshot = snapshotWorkerInvocationEvent(event);
    const eventJson = canonicalWorkerJson(eventSnapshot);
    const eventFingerprint = workerStorageFingerprint(EVENT_FINGERPRINT_DOMAIN, eventSnapshot);
    const resultSealAuthority = input.resultSealAuthority;

    const transaction = this.#transaction((): TransactionCommit => {
      const now = checkedNow(this.#now());
      this.#assertOwnerInTransaction(ownerRecord, now);
      const replay = this.#operationReplay(
        operationId,
        cursorRecord.invocationId,
        eventFingerprint,
      );
      if (replay !== null) return replay;
      if (!cursorRecord.active || this.#live.get(cursorRecord.invocationId)?.cursor !== cursor) {
        throw storeError('CURSOR_STALE', 'Invocation cursor is no longer current.');
      }
      const row = this.#readInvocationRow(cursorRecord.invocationId);
      if (
        row.revision !== cursorRecord.revision ||
        row.stateFingerprint !== cursorRecord.stateFingerprint
      ) {
        throw storeError('CURSOR_STALE', 'Durable Invocation revision moved.');
      }
      const reduction = reduceWorkerInvocation(cursorRecord.state, event);
      const nextSnapshot = snapshotWorkerInvocationState(reduction.next);
      const nextJson = canonicalWorkerJson(nextSnapshot);
      const nextFingerprint = workerStorageFingerprint(STATE_FINGERPRINT_DOMAIN, nextSnapshot);
      const nextRevision = cursorRecord.revision + 1;
      const recovery = recoverySnapshot(reduction.next, nextRevision, nextFingerprint);
      const recoveryJson = recovery === null ? null : canonicalWorkerJson(recovery);
      const recoveryFingerprint =
        recovery === null ? null : workerStorageFingerprint(RECOVERY_FINGERPRINT_DOMAIN, recovery);
      this.database
        .prepare(
          `INSERT INTO worker_invocation_events
             (operation_id, invocation_id, semantic_fingerprint, event_type, event_json,
              from_revision, to_revision, state_fingerprint, committed_owner_epoch, occurred_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          operationId,
          cursorRecord.invocationId,
          eventFingerprint,
          event.type,
          eventJson,
          cursorRecord.revision,
          nextRevision,
          nextFingerprint,
          ownerRecord.epoch,
          now,
        );
      this.#fault?.('AFTER_EVENT_INSERT');

      const success = terminalSuccess(reduction.durable);
      let sealedResultId: string | null = null;
      if (success !== null) {
        if (resultSealAuthority === undefined) {
          throw storeError(
            'SEALED_RESULT_REQUIRED',
            'SUCCEEDED requires its exact seal authority.',
          );
        }
        const receipt = success.terminal.host.sealedResult;
        const envelope = readExactWorkerSealedResultEnvelope(resultSealAuthority, receipt);
        const envelopeJson = canonicalWorkerJson(envelope);
        const envelopeBytes = utf8ByteLength(envelopeJson);
        if (envelopeBytes > MAX_DURABLE_SEALED_ENVELOPE_BYTES) {
          throw storeError('SEALED_RESULT_INVALID', 'Sealed result envelope exceeds 32 KiB.');
        }
        const envelopeFingerprint = workerStorageFingerprint(ENVELOPE_FINGERPRINT_DOMAIN, envelope);
        sealedResultId = receipt.sealedResultId;
        this.database
          .prepare(
            `INSERT INTO worker_sealed_results
               (sealed_result_id, invocation_id, operation_id, result_fingerprint,
                sealed_fingerprint, envelope_json, envelope_fingerprint, envelope_bytes,
                created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            sealedResultId,
            cursorRecord.invocationId,
            operationId,
            receipt.resultFingerprint,
            receipt.sealedFingerprint,
            envelopeJson,
            envelopeFingerprint,
            envelopeBytes,
            now,
          );
        this.#fault?.('AFTER_SEALED_RESULT_INSERT');
      } else if (resultSealAuthority !== undefined) {
        throw storeError(
          'SEALED_RESULT_INVALID',
          'A result seal authority is valid only for SUCCEEDED.',
        );
      }

      const updated = this.database
        .prepare(
          `UPDATE worker_invocations SET
             revision = ?, phase = ?, state_json = ?, state_fingerprint = ?,
             recovery_json = ?, recovery_fingerprint = ?, sealed_result_id = ?,
             last_owner_epoch = ?, updated_at_ms = ?
           WHERE invocation_id = ? AND revision = ? AND state_fingerprint = ?`,
        )
        .run(
          nextRevision,
          reduction.next.phase,
          nextJson,
          nextFingerprint,
          recoveryJson,
          recoveryFingerprint,
          sealedResultId,
          ownerRecord.epoch,
          now,
          cursorRecord.invocationId,
          cursorRecord.revision,
          cursorRecord.stateFingerprint,
        );
      if (Number(updated.changes) !== 1) {
        throw storeError('CURSOR_STALE', 'Invocation compare-and-swap failed.');
      }
      this.#fault?.('AFTER_INVOCATION_UPDATE');
      const outboxFacts = reduction.durable.map((effect) =>
        this.#insertOutbox(cursorRecord.invocationId, operationId, effect, sealedResultId, now),
      );
      return {
        disposition: 'APPLIED',
        invocation: durableView({
          invocationId: cursorRecord.invocationId,
          revision: nextRevision,
          phase: reduction.next.phase,
          stateJson: nextJson,
          stateFingerprint: nextFingerprint,
          recoveryJson,
          recoveryFingerprint,
          sealedResultId,
        }),
        state: reduction.next,
        outboxFacts,
        rawAfterCommit: reduction.afterCommit,
      };
    });
    return this.#finishCommit(owner, ownerRecord, transaction, cursorRecord);
  }

  public replayInvocationEvent(
    owner: WorkerSqliteOwner,
    input: Readonly<{
      invocationId: string;
      operationId: string;
      event: WorkerInvocationEvent;
    }>,
  ): WorkerSqliteCommitResult | null {
    const ownerRecord = this.#ownerRecord(owner);
    this.#assertOwnerReadable(ownerRecord);
    const invocationId = validateIdentifier(input.invocationId, 'Invocation ID');
    const operationId = validateIdentifier(input.operationId, 'Operation ID');
    const event = snapshotWorkerInvocationEvent(normalizeWorkerInvocationEvent(input.event));
    const replay = this.#operationReplay(
      operationId,
      invocationId,
      workerStorageFingerprint(EVENT_FINGERPRINT_DOMAIN, event),
    );
    return replay === null ? null : this.#finishCommit(owner, ownerRecord, replay);
  }

  public readInvocation(
    owner: WorkerSqliteOwner,
    invocationId: string,
  ): WorkerDurableInvocationView | null {
    const ownerRecord = this.#ownerRecord(owner);
    this.#assertOwnerReadable(ownerRecord);
    validateIdentifier(invocationId, 'Invocation ID');
    const raw = this.database
      .prepare('SELECT * FROM worker_invocations WHERE invocation_id = ?')
      .get(invocationId);
    return raw === undefined ? null : durableView(decodeInvocationRow(raw));
  }

  public readPendingFacts(
    owner: WorkerSqliteOwner,
    limit = DEFAULT_PENDING_FACT_LIMIT,
  ): readonly WorkerOutboxFactReference[] {
    const ownerRecord = this.#ownerRecord(owner);
    this.#assertOwnerReadable(ownerRecord);
    const checkedLimit = validatePendingFactLimit(limit);
    return Object.freeze(
      (
        this.database
          .prepare(
            `SELECT fact_id, invocation_id, operation_id, fact_type,
                    payload_fingerprint, sealed_result_id
               FROM worker_invocation_outbox
              WHERE transport_enqueued_at_ms IS NULL
              ORDER BY outbox_sequence LIMIT ?`,
          )
          .all(checkedLimit) as Record<string, unknown>[]
      ).map(decodeOutboxReference),
    );
  }

  public readOutboxFact<TEnvelope extends object = Record<string, unknown>>(
    owner: WorkerSqliteOwner,
    input: WorkerOutboxFactReference,
  ): WorkerOutboxFact<TEnvelope> {
    const ownerRecord = this.#ownerRecord(owner);
    const reference = snapshotOutboxReference(input);
    this.#assertOwnerReadable(ownerRecord);
    const row = this.#readExactOutboxRow(reference);
    const payloadValue = parseCanonicalWorkerJson(rowString(row, 'payload_json'));
    const payload = validateDurableWorkerEffect(payloadValue) as Readonly<Record<string, unknown>>;
    assertFingerprint(
      rowString(row, 'payload_fingerprint'),
      workerStorageFingerprint(OUTBOX_FINGERPRINT_DOMAIN, payload),
      'Outbox payload',
    );
    if (durableFactType(payload) !== reference.factType) {
      throw storeError('STORE_CORRUPT', 'Outbox fact type does not match its payload.');
    }
    const sealedEnvelope =
      reference.sealedResultId === null
        ? null
        : this.readSealedEnvelope<TEnvelope>(owner, reference.sealedResultId);
    return Object.freeze({
      reference,
      payload,
      sealedEnvelope,
      transportEnqueuedAtMs: rowNullableInteger(row, 'transport_enqueued_at_ms'),
    });
  }

  public markFactEnqueued(
    owner: WorkerSqliteOwner,
    input: WorkerOutboxFactReference,
  ): WorkerOutboxFactHandoff {
    const ownerRecord = this.#ownerRecord(owner);
    const reference = snapshotOutboxReference(input);
    return this.#transaction(() => {
      const now = checkedNow(this.#now());
      this.#assertOwnerInTransaction(ownerRecord, now);
      const row = this.#readExactOutboxRow(reference);
      const existing = rowNullableInteger(row, 'transport_enqueued_at_ms');
      if (existing !== null) {
        return Object.freeze({
          disposition: 'EXACT_REPLAY' as const,
          reference,
          transportEnqueuedAtMs: existing,
        });
      }
      const enqueuedAtMs = Math.max(now, rowInteger(row, 'created_at_ms'));
      const updated = this.database
        .prepare(
          `UPDATE worker_invocation_outbox SET transport_enqueued_at_ms = ?
            WHERE fact_id = ? AND transport_enqueued_at_ms IS NULL`,
        )
        .run(enqueuedAtMs, reference.factId);
      if (Number(updated.changes) !== 1) {
        throw storeError('OUTBOX_FACT_CONFLICT', 'Outbox transport handoff lost its exact row.');
      }
      return Object.freeze({
        disposition: 'APPLIED' as const,
        reference,
        transportEnqueuedAtMs: enqueuedAtMs,
      });
    });
  }

  public readSealedEnvelope<TEnvelope extends object>(
    owner: WorkerSqliteOwner,
    sealedResultId: string,
  ): Readonly<TEnvelope> {
    const ownerRecord = this.#ownerRecord(owner);
    this.#assertOwnerReadable(ownerRecord);
    validateIdentifier(sealedResultId, 'Sealed result ID');
    const row = requiredRow(
      this.database
        .prepare(
          'SELECT envelope_json, envelope_fingerprint FROM worker_sealed_results WHERE sealed_result_id = ?',
        )
        .get(sealedResultId),
      'Sealed result does not exist.',
    );
    const json = rowString(row, 'envelope_json');
    const envelope = parseCanonicalWorkerJson(json);
    assertFingerprint(
      rowString(row, 'envelope_fingerprint'),
      workerStorageFingerprint(ENVELOPE_FINGERPRINT_DOMAIN, envelope),
      'Sealed result envelope',
    );
    if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
      throw storeError('STORE_CORRUPT', 'Sealed result envelope is not an object.');
    }
    return envelope as Readonly<TEnvelope>;
  }

  public close(owner?: WorkerSqliteOwner): void {
    if (this.#closed) return;
    let closeFailure: unknown;
    if (this.#activeOwner !== null) {
      if (owner === undefined || owner !== this.#activeOwner) {
        throw storeError('OWNER_STALE', 'Exact owner is required to close an owned Store.');
      }
      const record = this.#owners.get(owner);
      if (record?.active === true && !this.#poisoned) {
        try {
          this.#transaction(() => {
            this.database
              .prepare(
                `DELETE FROM worker_store_owner
                 WHERE singleton = 1 AND owner_token_digest = ? AND owner_epoch = ?`,
              )
              .run(record.tokenDigest, record.epoch);
          });
        } catch (error) {
          closeFailure = error;
        }
      }
      if (record !== undefined) record.active = false;
    }
    this.#invalidateLiveCursors();
    try {
      if (this.database.isOpen) this.database.close();
    } catch (error) {
      closeFailure ??= error;
    } finally {
      this.#closed = true;
      try {
        assertSafeWorkerSqliteSidecars(this.options.filename);
      } catch (error) {
        closeFailure ??= error;
      }
    }
    if (closeFailure !== undefined) throw normalizeError(closeFailure);
  }

  #finishCommit(
    owner: WorkerSqliteOwner,
    ownerRecord: OwnerRecord,
    transaction: TransactionCommit,
    previous?: CursorRecord,
  ): WorkerSqliteCommitResult {
    if (transaction.disposition === 'EXACT_REPLAY') {
      const current = this.#live.get(transaction.invocation.invocationId)?.cursor ?? null;
      return Object.freeze({
        disposition: 'EXACT_REPLAY',
        invocation: transaction.invocation,
        cursor: current,
        outboxFacts: Object.freeze([...transaction.outboxFacts]),
        afterCommit: Object.freeze([]),
      });
    }
    if (previous !== undefined) previous.active = false;
    const cursor =
      transaction.state === null || transaction.state.phase === 'TERMINAL_READY'
        ? null
        : this.#mintCursor(
            owner,
            transaction.invocation.invocationId,
            transaction.invocation.revision,
            transaction.state,
          );
    if (cursor === null) this.#live.delete(transaction.invocation.invocationId);
    const afterCommit = commitWorkerAfterCommitEffects(
      transaction.rawAfterCommit,
      {
        invocationId: transaction.invocation.invocationId,
        revision: transaction.invocation.revision,
        ownerEpoch: ownerRecord.epoch,
      },
      () => this.#assertOwnerReadable(ownerRecord),
    );
    return Object.freeze({
      disposition: 'APPLIED',
      invocation: transaction.invocation,
      cursor,
      outboxFacts: Object.freeze([...transaction.outboxFacts]),
      afterCommit,
    });
  }

  #operationReplay(
    operationId: string,
    invocationId: string,
    semanticFingerprint: string,
  ): TransactionCommit | null {
    const raw = this.database
      .prepare(
        `SELECT invocation_id, semantic_fingerprint
           FROM worker_invocation_events WHERE operation_id = ?`,
      )
      .get(operationId);
    if (raw === undefined) return null;
    const existing = decodeStoredEvent(raw);
    if (
      existing.invocationId !== invocationId ||
      existing.semanticFingerprint !== semanticFingerprint
    ) {
      throw storeError('OPERATION_CONFLICT', 'Operation ID is bound to different semantics.');
    }
    const invocation = durableView(this.#readInvocationRow(invocationId));
    return {
      disposition: 'EXACT_REPLAY',
      invocation,
      state: null,
      outboxFacts: this.#outboxForOperation(operationId),
      rawAfterCommit: [],
    };
  }

  #insertOutbox(
    invocationId: string,
    operationId: string,
    effect: WorkerDurableEffect | unknown,
    sealedResultId: string | null,
    now: number,
  ): WorkerOutboxFactReference {
    const payload = validateDurableWorkerEffect(effect);
    const payloadJson = canonicalWorkerJson(payload);
    const payloadFingerprint = workerStorageFingerprint(OUTBOX_FINGERPRINT_DOMAIN, payload);
    const factType = durableFactType(payload);
    const factId = workerFactIdentifier(invocationId, factType);
    this.database
      .prepare(
        `INSERT INTO worker_invocation_outbox
           (fact_id, invocation_id, operation_id, fact_type, payload_json,
            payload_fingerprint, sealed_result_id, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        factId,
        invocationId,
        operationId,
        factType,
        payloadJson,
        payloadFingerprint,
        sealedResultId,
        now,
      );
    this.#fault?.('AFTER_OUTBOX_INSERT');
    return Object.freeze({
      factId,
      invocationId,
      operationId,
      factType,
      payloadFingerprint,
      sealedResultId,
    });
  }

  #outboxForOperation(operationId: string): readonly WorkerOutboxFactReference[] {
    return Object.freeze(
      (
        this.database
          .prepare(
            `SELECT fact_id, invocation_id, operation_id, fact_type,
                    payload_fingerprint, sealed_result_id
               FROM worker_invocation_outbox WHERE operation_id = ? ORDER BY outbox_sequence`,
          )
          .all(operationId) as Record<string, unknown>[]
      ).map(decodeOutboxReference),
    );
  }

  #readExactOutboxRow(reference: WorkerOutboxFactReference): Record<string, unknown> {
    const raw = this.database
      .prepare('SELECT * FROM worker_invocation_outbox WHERE fact_id = ?')
      .get(reference.factId);
    if (raw === undefined) {
      throw storeError('OUTBOX_FACT_UNKNOWN', 'Outbox fact does not exist.');
    }
    const row = requiredRow(raw, 'Outbox fact row is invalid.');
    const stored = decodeOutboxReference(row);
    if (canonicalWorkerJson(stored) !== canonicalWorkerJson(reference)) {
      throw storeError('OUTBOX_FACT_CONFLICT', 'Outbox fact reference changed.');
    }
    return row;
  }

  #mintCursor(
    owner: WorkerSqliteOwner,
    invocationId: string,
    revision: number,
    state: WorkerInvocationState,
  ): WorkerInvocationCursor {
    const stateFingerprint = workerStorageFingerprint(
      STATE_FINGERPRINT_DOMAIN,
      snapshotWorkerInvocationState(state),
    );
    const cursor = Object.freeze({
      invocationId,
      revision,
      phase: state.phase,
    }) as WorkerInvocationCursor;
    const record: CursorRecord = {
      owner,
      invocationId,
      revision,
      state,
      stateFingerprint,
      active: true,
    };
    this.#cursors.set(cursor, record);
    this.#live.set(invocationId, { cursor, record });
    return cursor;
  }

  #cursorRecord(owner: WorkerSqliteOwner, cursor: WorkerInvocationCursor): CursorRecord {
    const record = this.#cursors.get(cursor);
    if (record === undefined || record.owner !== owner) {
      throw storeError('CURSOR_STALE', 'Cursor did not originate from this owner.');
    }
    return record;
  }

  #ownerRecord(owner: WorkerSqliteOwner): OwnerRecord {
    this.#assertOpen();
    const record = this.#owners.get(owner);
    if (record === undefined || !record.active || this.#activeOwner !== owner) {
      throw storeError('OWNER_STALE', 'Owner did not originate from this active Store.');
    }
    return record;
  }

  #assertOwnerReadable(record: OwnerRecord): void {
    this.#assertOpen();
    const now = checkedNow(this.#now());
    const row = requiredRow(
      this.database
        .prepare(
          `SELECT owner_token_digest, owner_epoch, lease_expires_at_ms
             FROM worker_store_owner WHERE singleton = 1`,
        )
        .get(),
      'Owner row is missing.',
    );
    if (
      rowString(row, 'owner_token_digest') !== record.tokenDigest ||
      rowInteger(row, 'owner_epoch') !== record.epoch
    ) {
      throw storeError('OWNER_STALE', 'Owner was fenced by another process.');
    }
    if (rowInteger(row, 'lease_expires_at_ms') <= now) {
      throw storeError('OWNER_EXPIRED', 'Owner lease expired.');
    }
  }

  #assertOwnerInTransaction(record: OwnerRecord, now: number): void {
    this.#assertOpen();
    const row = requiredRow(
      this.database
        .prepare(
          `SELECT owner_token_digest, owner_epoch, lease_expires_at_ms
             FROM worker_store_owner WHERE singleton = 1`,
        )
        .get(),
      'Owner row is missing.',
    );
    if (
      rowString(row, 'owner_token_digest') !== record.tokenDigest ||
      rowInteger(row, 'owner_epoch') !== record.epoch
    ) {
      throw storeError('OWNER_STALE', 'Owner was fenced by another process.');
    }
    if (rowInteger(row, 'lease_expires_at_ms') <= now) {
      throw storeError('OWNER_EXPIRED', 'Owner lease expired.');
    }
  }

  #readInvocationRow(invocationId: string): WorkerSqliteInvocationRow {
    return decodeInvocationRow(
      requiredRow(
        this.database
          .prepare('SELECT * FROM worker_invocations WHERE invocation_id = ?')
          .get(invocationId),
        'Invocation row is missing.',
      ),
    );
  }

  #readAllInvocationRows(): WorkerSqliteInvocationRow[] {
    return (
      this.database
        .prepare('SELECT * FROM worker_invocations ORDER BY invocation_id')
        .all() as Record<string, unknown>[]
    ).map(decodeInvocationRow);
  }

  #transaction<T>(body: () => T): T {
    this.#assertOpen();
    try {
      this.database.exec('BEGIN IMMEDIATE');
    } catch (error) {
      throw normalizeError(error);
    }
    let committed = false;
    try {
      const value = body();
      this.#fault?.('BEFORE_SQL_COMMIT');
      try {
        this.database.exec('COMMIT');
        committed = true;
      } catch (error) {
        this.#poison();
        throw storeError(
          'STORE_COMMIT_UNKNOWN',
          'SQLite COMMIT result is unknown.',
          errorOptions(error),
        );
      }
      try {
        this.#fault?.('AFTER_SQL_COMMIT');
      } catch (error) {
        this.#poison();
        throw storeError(
          'STORE_COMMIT_UNKNOWN',
          'SQLite committed before the caller observed success.',
          errorOptions(error),
        );
      }
      return value;
    } catch (error) {
      if (!committed && !this.#poisoned) {
        try {
          if (this.database.isTransaction) this.database.exec('ROLLBACK');
        } catch (rollbackError) {
          this.#poison();
          throw storeError(
            'STORE_COMMIT_UNKNOWN',
            'SQLite rollback failed.',
            errorOptions(rollbackError),
          );
        }
      }
      throw normalizeError(error);
    }
  }

  #assertOpen(): void {
    if (this.#closed || this.#poisoned || !this.database.isOpen) {
      throw storeError('STORE_CLOSED', 'Worker SQLite Store is closed.');
    }
  }

  #invalidateLiveCursors(): void {
    for (const { record } of this.#live.values()) record.active = false;
    this.#live.clear();
  }

  #poison(): void {
    this.#poisoned = true;
    this.#invalidateLiveCursors();
    try {
      if (this.database.isOpen) this.database.close();
    } catch {
      // Poisoning is best effort; no further operation may use this instance.
    }
  }
}

function validateIdentifier(input: string, label: string): string {
  if (!isIdentifier(input)) {
    throw storeError('INVOCATION_CONFLICT', `${label} is invalid.`);
  }
  return input;
}

function isIdentifier(input: unknown): input is string {
  return typeof input === 'string' && IDENTIFIER_PATTERN.test(input);
}

function validatePendingFactLimit(input: number): number {
  if (!Number.isSafeInteger(input) || input < 1 || input > 100) {
    throw new TypeError('Pending fact limit must be 1..100.');
  }
  return input;
}

function snapshotOutboxReference(input: WorkerOutboxFactReference): WorkerOutboxFactReference {
  if (typeof input !== 'object' || input === null) {
    throw storeError('OUTBOX_FACT_CONFLICT', 'Outbox fact reference is invalid.');
  }
  const { factId, invocationId, operationId, factType, payloadFingerprint, sealedResultId } = input;
  if (
    !isIdentifier(factId) ||
    !isIdentifier(invocationId) ||
    !isIdentifier(operationId) ||
    (factType !== 'STARTED' && factType !== 'TERMINAL') ||
    typeof payloadFingerprint !== 'string' ||
    !SHA256_PATTERN.test(payloadFingerprint) ||
    (sealedResultId !== null && !isIdentifier(sealedResultId))
  ) {
    throw storeError('OUTBOX_FACT_CONFLICT', 'Outbox fact reference is invalid.');
  }
  return Object.freeze({
    factId,
    invocationId,
    operationId,
    factType,
    payloadFingerprint,
    sealedResultId,
  });
}

function validateLease(input: number): number {
  if (!Number.isSafeInteger(input) || input < 1_000 || input > MAX_OWNER_LEASE_MS) {
    throw storeError('OWNER_EXPIRED', 'Owner lease must be 1000..300000 ms.');
  }
  return input;
}

function checkedNow(input: number): number {
  if (!Number.isSafeInteger(input) || input < 0) throw storeError('STORE_IO', 'Clock is invalid.');
  return input;
}

function checkedLeaseExpiry(now: number, leaseMs: number): number {
  const expiresAt = now + leaseMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw storeError('STORE_IO', 'Owner lease expiry is outside the safe clock range.');
  }
  return expiresAt;
}

function digestOwnerToken(token: Uint8Array): string {
  return `sha256:${createHash('sha256')
    .update('combo.worker-sqlite.owner-token/1\0', 'utf8')
    .update(token)
    .digest('hex')}`;
}

function recoveryOperationId(epoch: number, invocationId: string): string {
  return `recovery.${epoch}.${createHash('sha256').update(invocationId).digest('hex').slice(0, 32)}`;
}

function storeError(
  code: WorkerSqliteStoreErrorCode,
  message: string,
  options?: ErrorOptions,
): WorkerSqliteStoreError {
  return new WorkerSqliteStoreError(code, message, options);
}

function normalizeError(error: unknown): Error {
  if (error instanceof WorkerSqliteStoreError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/busy|locked/iu.test(message)) return storeError('STORE_BUSY', 'Worker SQLite is busy.');
  return storeError('STORE_IO', 'Worker SQLite operation failed.', errorOptions(error));
}

function errorOptions(error: unknown): ErrorOptions | undefined {
  return error instanceof Error ? { cause: error } : undefined;
}
