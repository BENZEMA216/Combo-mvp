import { workerStorageFingerprint } from './durable-codec.js';

export const WORKER_SQLITE_APPLICATION_ID = 0x4342494a;
export const WORKER_SQLITE_SCHEMA_VERSION = 1;

type CatalogObject = Readonly<{
  type: 'index' | 'table';
  name: string;
  tableName: string;
  sql: string;
}>;

const schemaObjects: readonly CatalogObject[] = Object.freeze([
  catalogTable(
    'worker_store_meta',
    `CREATE TABLE worker_store_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      store_identity TEXT NOT NULL CHECK (length(store_identity) BETWEEN 1 AND 256),
      schema_contract_digest TEXT NOT NULL CHECK (
        length(schema_contract_digest) = 71
        AND substr(schema_contract_digest, 1, 7) = 'sha256:'
        AND substr(schema_contract_digest, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      catalog_digest TEXT NOT NULL CHECK (
        length(catalog_digest) = 71
        AND substr(catalog_digest, 1, 7) = 'sha256:'
        AND substr(catalog_digest, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      highest_owner_epoch INTEGER NOT NULL DEFAULT 0 CHECK (highest_owner_epoch >= 0),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
    ) STRICT`,
  ),
  catalogTable(
    'worker_store_owner',
    `CREATE TABLE worker_store_owner (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      owner_token_digest TEXT NOT NULL CHECK (
        length(owner_token_digest) = 71
        AND substr(owner_token_digest, 1, 7) = 'sha256:'
        AND substr(owner_token_digest, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      owner_epoch INTEGER NOT NULL CHECK (owner_epoch >= 1),
      lease_expires_at_ms INTEGER NOT NULL CHECK (lease_expires_at_ms >= 0),
      acquired_at_ms INTEGER NOT NULL CHECK (acquired_at_ms >= 0),
      FOREIGN KEY (singleton) REFERENCES worker_store_meta(singleton) ON DELETE RESTRICT
    ) STRICT`,
  ),
  catalogTable(
    'worker_invocations',
    `CREATE TABLE worker_invocations (
      invocation_id TEXT PRIMARY KEY CHECK (length(invocation_id) BETWEEN 1 AND 256),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      phase TEXT NOT NULL CHECK (phase IN ('PREPARED', 'DISPATCHING', 'RUNNING', 'TERMINAL_READY')),
      state_json TEXT NOT NULL CHECK (json_valid(state_json) = 1),
      state_fingerprint TEXT NOT NULL CHECK (
        length(state_fingerprint) = 71
        AND substr(state_fingerprint, 1, 7) = 'sha256:'
        AND substr(state_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      recovery_json TEXT CHECK (recovery_json IS NULL OR json_valid(recovery_json) = 1),
      recovery_fingerprint TEXT CHECK (
        recovery_fingerprint IS NULL OR (
          length(recovery_fingerprint) = 71
          AND substr(recovery_fingerprint, 1, 7) = 'sha256:'
          AND substr(recovery_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
        )
      ),
      sealed_result_id TEXT,
      last_owner_epoch INTEGER NOT NULL CHECK (last_owner_epoch >= 1),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
      CHECK ((recovery_json IS NULL) = (recovery_fingerprint IS NULL)),
      CHECK (
        (phase IN ('DISPATCHING', 'RUNNING') AND recovery_json IS NOT NULL)
        OR (phase IN ('PREPARED', 'TERMINAL_READY') AND recovery_json IS NULL)
      ),
      CHECK (sealed_result_id IS NULL OR phase = 'TERMINAL_READY'),
      FOREIGN KEY (sealed_result_id, invocation_id)
        REFERENCES worker_sealed_results(sealed_result_id, invocation_id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    ) STRICT`,
  ),
  catalogTable(
    'worker_invocation_events',
    `CREATE TABLE worker_invocation_events (
      operation_id TEXT PRIMARY KEY CHECK (length(operation_id) BETWEEN 1 AND 256),
      invocation_id TEXT NOT NULL REFERENCES worker_invocations(invocation_id) ON DELETE RESTRICT,
      semantic_fingerprint TEXT NOT NULL CHECK (
        length(semantic_fingerprint) = 71
        AND substr(semantic_fingerprint, 1, 7) = 'sha256:'
        AND substr(semantic_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      event_type TEXT NOT NULL CHECK (event_type IN (
        'PREPARE_CREATED',
        'DISPATCH_INTENT_RECORDED',
        'CANCEL_PROVEN_NOT_DISPATCHED',
        'INTERRUPT_INTENT_RECORDED',
        'HOST_START_DISPOSITION_RECORDED',
        'HOST_INTERRUPT_DISPOSITION_RECORDED',
        'HOST_TERMINAL_CONFIRMED',
        'HOST_EVIDENCE_LOST',
        'PROCESS_RECOVERY_WITHOUT_HANDLE'
      )),
      event_json TEXT NOT NULL CHECK (json_valid(event_json) = 1),
      from_revision INTEGER NOT NULL CHECK (from_revision >= -1),
      to_revision INTEGER NOT NULL CHECK (to_revision = from_revision + 1),
      state_fingerprint TEXT NOT NULL CHECK (
        length(state_fingerprint) = 71
        AND substr(state_fingerprint, 1, 7) = 'sha256:'
        AND substr(state_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      committed_owner_epoch INTEGER NOT NULL CHECK (committed_owner_epoch >= 1),
      occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
      CHECK (
        (event_type = 'PREPARE_CREATED' AND from_revision = -1 AND to_revision = 0)
        OR (event_type <> 'PREPARE_CREATED' AND from_revision >= 0)
      ),
      UNIQUE (invocation_id, to_revision),
      UNIQUE (operation_id, invocation_id)
    ) STRICT`,
  ),
  catalogTable(
    'worker_invocation_outbox',
    `CREATE TABLE worker_invocation_outbox (
      outbox_sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK (outbox_sequence >= 1),
      fact_id TEXT NOT NULL UNIQUE CHECK (length(fact_id) BETWEEN 1 AND 256),
      invocation_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      fact_type TEXT NOT NULL CHECK (fact_type IN ('STARTED', 'TERMINAL')),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json) = 1),
      payload_fingerprint TEXT NOT NULL CHECK (
        length(payload_fingerprint) = 71
        AND substr(payload_fingerprint, 1, 7) = 'sha256:'
        AND substr(payload_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      sealed_result_id TEXT,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      CHECK (fact_type = 'TERMINAL' OR sealed_result_id IS NULL),
      UNIQUE (operation_id, fact_type),
      FOREIGN KEY (operation_id, invocation_id)
        REFERENCES worker_invocation_events(operation_id, invocation_id) ON DELETE RESTRICT,
      FOREIGN KEY (sealed_result_id, invocation_id)
        REFERENCES worker_sealed_results(sealed_result_id, invocation_id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    ) STRICT`,
  ),
  catalogTable(
    'worker_sealed_results',
    `CREATE TABLE worker_sealed_results (
      sealed_result_id TEXT PRIMARY KEY CHECK (length(sealed_result_id) BETWEEN 1 AND 256),
      invocation_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      result_fingerprint TEXT NOT NULL CHECK (
        length(result_fingerprint) = 71
        AND substr(result_fingerprint, 1, 7) = 'sha256:'
        AND substr(result_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      sealed_fingerprint TEXT NOT NULL CHECK (
        length(sealed_fingerprint) = 71
        AND substr(sealed_fingerprint, 1, 7) = 'sha256:'
        AND substr(sealed_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json) = 1),
      envelope_fingerprint TEXT NOT NULL CHECK (
        length(envelope_fingerprint) = 71
        AND substr(envelope_fingerprint, 1, 7) = 'sha256:'
        AND substr(envelope_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      envelope_bytes INTEGER NOT NULL CHECK (envelope_bytes >= 2),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      UNIQUE (invocation_id),
      UNIQUE (operation_id),
      UNIQUE (sealed_result_id, invocation_id),
      FOREIGN KEY (invocation_id) REFERENCES worker_invocations(invocation_id) ON DELETE RESTRICT,
      FOREIGN KEY (operation_id, invocation_id)
        REFERENCES worker_invocation_events(operation_id, invocation_id) ON DELETE RESTRICT
    ) STRICT`,
  ),
  catalogIndex(
    'worker_store_owner_lease',
    'worker_store_owner',
    `CREATE INDEX worker_store_owner_lease
      ON worker_store_owner(lease_expires_at_ms, owner_epoch)`,
  ),
  catalogIndex(
    'worker_invocations_phase_updated',
    'worker_invocations',
    `CREATE INDEX worker_invocations_phase_updated
      ON worker_invocations(phase, updated_at_ms, invocation_id)`,
  ),
  catalogIndex(
    'worker_invocation_events_order',
    'worker_invocation_events',
    `CREATE INDEX worker_invocation_events_order
      ON worker_invocation_events(invocation_id, to_revision)`,
  ),
  catalogIndex(
    'worker_invocation_events_semantic',
    'worker_invocation_events',
    `CREATE INDEX worker_invocation_events_semantic
      ON worker_invocation_events(invocation_id, semantic_fingerprint)`,
  ),
  catalogIndex(
    'worker_invocation_outbox_order',
    'worker_invocation_outbox',
    `CREATE INDEX worker_invocation_outbox_order
      ON worker_invocation_outbox(created_at_ms, fact_id)`,
  ),
  catalogIndex(
    'worker_invocation_outbox_invocation',
    'worker_invocation_outbox',
    `CREATE INDEX worker_invocation_outbox_invocation
      ON worker_invocation_outbox(invocation_id, operation_id)`,
  ),
]);

/** Fresh-store DDL only; the store owns the outer transaction and all PRAGMA writes. */
export const WORKER_SQLITE_SCHEMA_SQL = schemaObjects.map(({ sql }) => `${sql};`).join('\n');

export const WORKER_SQLITE_SCHEMA_CONTRACT_DIGEST = catalogDigest(schemaObjects);

export interface WorkerSqliteCatalogDatabase {
  prepare(sql: string): Readonly<{ all(...parameters: unknown[]): readonly unknown[] }>;
}

/** Computes the live schema digest without trusting metadata stored inside the database. */
export function workerSqliteCatalogDigest(database: WorkerSqliteCatalogDatabase): string {
  const applicationId = readPragma(database, 'application_id');
  const schemaVersion = readPragma(database, 'user_version');
  const rows = database
    .prepare(
      `SELECT type, name, tbl_name AS table_name, sql
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
       ORDER BY type, name`,
    )
    .all();
  const objects = rows.map((value, index): CatalogObject => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError(`SQLite catalog row ${index} is invalid.`);
    }
    const row = value as Record<string, unknown>;
    if (
      (row.type !== 'table' && row.type !== 'index') ||
      typeof row.name !== 'string' ||
      typeof row.table_name !== 'string' ||
      typeof row.sql !== 'string'
    ) {
      throw new TypeError(`SQLite catalog row ${index} has invalid fields.`);
    }
    return Object.freeze({
      type: row.type,
      name: row.name,
      tableName: row.table_name,
      sql: normalizeSql(row.sql),
    });
  });
  return catalogDigest(objects, applicationId, schemaVersion);
}

function catalogTable(name: string, sql: string): CatalogObject {
  return Object.freeze({ type: 'table', name, tableName: name, sql: normalizeSql(sql) });
}

function catalogIndex(name: string, tableName: string, sql: string): CatalogObject {
  return Object.freeze({ type: 'index', name, tableName, sql: normalizeSql(sql) });
}

function catalogDigest(
  objects: readonly CatalogObject[],
  applicationId = WORKER_SQLITE_APPLICATION_ID,
  schemaVersion = WORKER_SQLITE_SCHEMA_VERSION,
): string {
  return workerStorageFingerprint('combo.worker-sqlite-catalog/1', {
    applicationId,
    schemaVersion,
    objects: [...objects].sort(compareCatalogObjects),
  });
}

function compareCatalogObjects(left: CatalogObject, right: CatalogObject): number {
  if (left.type !== right.type) return left.type < right.type ? -1 : 1;
  if (left.name === right.name) return 0;
  return left.name < right.name ? -1 : 1;
}

function readPragma(database: WorkerSqliteCatalogDatabase, name: string): number {
  const rows = database.prepare(`PRAGMA ${name}`).all();
  if (rows.length !== 1 || typeof rows[0] !== 'object' || rows[0] === null) {
    throw new TypeError(`SQLite PRAGMA ${name} is unavailable.`);
  }
  const value = (rows[0] as Record<string, unknown>)[name];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`SQLite PRAGMA ${name} is invalid.`);
  }
  return value as number;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\r\n?/gu, '\n').trim();
}
