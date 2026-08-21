import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const TRANSPORT_SQLITE_APPLICATION_ID = 0x43425452; // CBTR
export const TRANSPORT_SQLITE_SCHEMA_VERSION = 1;

type CatalogObject = Readonly<{
  type: 'index' | 'table';
  name: string;
  tableName: string;
  sql: string;
}>;
const objects: readonly CatalogObject[] = Object.freeze([
  table(
    'transport_meta',
    `CREATE TABLE transport_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), store_identity TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      schema_contract_digest TEXT NOT NULL, catalog_digest TEXT NOT NULL,
      max_pending_commands INTEGER NOT NULL CHECK (max_pending_commands BETWEEN 1 AND 10000),
      highest_owner_epoch INTEGER NOT NULL DEFAULT 0 CHECK (highest_owner_epoch >= 0),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
    ) STRICT`,
  ),
  table(
    'transport_owner',
    `CREATE TABLE transport_owner (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), token_digest TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL CHECK (owner_epoch >= 1),
      lease_expires_at_ms INTEGER NOT NULL CHECK (lease_expires_at_ms >= 0),
      acquired_at_ms INTEGER NOT NULL CHECK (acquired_at_ms >= 0),
      FOREIGN KEY (singleton) REFERENCES transport_meta(singleton) ON DELETE RESTRICT
    ) STRICT`,
  ),
  table(
    'transport_fences',
    `CREATE TABLE transport_fences (
      deployment_id TEXT PRIMARY KEY, installation_id TEXT NOT NULL,
      highest_fence INTEGER NOT NULL CHECK (highest_fence >= 0), worker_session_id TEXT NOT NULL,
      lease_id TEXT NOT NULL, lease_expires_at_ms INTEGER NOT NULL CHECK (lease_expires_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
    ) STRICT`,
  ),
  table(
    'transport_connections',
    `CREATE TABLE transport_connections (
      connection_id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, deployment_id TEXT NOT NULL,
      worker_session_id TEXT NOT NULL, lease_id TEXT NOT NULL, fence INTEGER NOT NULL CHECK (fence >= 0),
      activation_message_id TEXT NOT NULL, activation_semantic_fingerprint TEXT NOT NULL,
      activation_wire_fingerprint TEXT NOT NULL UNIQUE,
      activation_frame_json TEXT NOT NULL CHECK (json_valid(activation_frame_json) = 1),
      inbound_sequence INTEGER NOT NULL CHECK (inbound_sequence >= 0),
      next_outbound_sequence INTEGER NOT NULL CHECK (next_outbound_sequence >= 1),
      state TEXT NOT NULL CHECK (state IN ('ACTIVE','RELEASED')),
      owner_epoch INTEGER NOT NULL CHECK (owner_epoch >= 1),
      lease_expires_at_ms INTEGER NOT NULL CHECK (lease_expires_at_ms >= 0),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0), updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY (deployment_id) REFERENCES transport_fences(deployment_id) ON DELETE RESTRICT
    ) STRICT`,
  ),
  table(
    'transport_inbound_messages',
    `CREATE TABLE transport_inbound_messages (
      connection_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK (sequence >= 1),
      message_id TEXT NOT NULL, semantic_fingerprint TEXT NOT NULL, wire_fingerprint TEXT NOT NULL UNIQUE,
      frame_json TEXT NOT NULL CHECK (json_valid(frame_json) = 1), body_type TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      PRIMARY KEY (connection_id, sequence),
      FOREIGN KEY (connection_id) REFERENCES transport_connections(connection_id) ON DELETE RESTRICT
    ) STRICT`,
  ),
  table(
    'transport_inbound_deliveries',
    `CREATE TABLE transport_inbound_deliveries (
      delivery_sequence INTEGER PRIMARY KEY AUTOINCREMENT, order_fingerprint TEXT NOT NULL,
      delivery_message_id TEXT NOT NULL UNIQUE, source_id TEXT NOT NULL UNIQUE,
      source_fingerprint TEXT NOT NULL, command_type TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json) = 1), payload_fingerprint TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('PENDING','APPLIED')),
      connection_id TEXT NOT NULL, sequence INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
      applied_at_ms INTEGER,
      CHECK ((state = 'PENDING' AND applied_at_ms IS NULL)
        OR (state = 'APPLIED' AND applied_at_ms IS NOT NULL AND applied_at_ms >= 0)),
      FOREIGN KEY (connection_id, sequence) REFERENCES transport_inbound_messages(connection_id, sequence)
        ON DELETE RESTRICT
    ) STRICT`,
  ),
  table(
    'transport_logical_outbox',
    `CREATE TABLE transport_logical_outbox (
      logical_sequence INTEGER PRIMARY KEY AUTOINCREMENT, order_fingerprint TEXT NOT NULL,
      delivery_message_id TEXT NOT NULL UNIQUE,
      source_id TEXT NOT NULL UNIQUE,
      source_fingerprint TEXT NOT NULL, semantic_fingerprint TEXT NOT NULL,
      body_type TEXT NOT NULL CHECK (body_type IN ('worker.message','message.ack')),
      body_json TEXT NOT NULL CHECK (json_valid(body_json) = 1), local_terminal INTEGER NOT NULL CHECK (local_terminal IN (0,1)),
      state TEXT NOT NULL CHECK (state IN ('PENDING','ACKED')), created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    ) STRICT`,
  ),
  table(
    'transport_wire_outbox',
    `CREATE TABLE transport_wire_outbox (
      connection_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK (sequence >= 1),
      delivery_message_id TEXT NOT NULL, semantic_fingerprint TEXT NOT NULL,
      wire_fingerprint TEXT NOT NULL UNIQUE, frame_json TEXT NOT NULL CHECK (json_valid(frame_json) = 1),
      state TEXT NOT NULL CHECK (state IN ('PENDING','PREPARED','WRITTEN','ACKED','ABANDONED')),
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      written_at_ms INTEGER, terminal_at_ms INTEGER,
      CHECK ((state IN ('PENDING','PREPARED') AND written_at_ms IS NULL AND terminal_at_ms IS NULL)
        OR (state = 'WRITTEN' AND written_at_ms IS NOT NULL AND terminal_at_ms IS NULL)
        OR (state = 'ACKED' AND written_at_ms IS NOT NULL AND terminal_at_ms IS NOT NULL)
        OR (state = 'ABANDONED' AND terminal_at_ms IS NOT NULL)),
      PRIMARY KEY (connection_id, sequence),
      FOREIGN KEY (connection_id) REFERENCES transport_connections(connection_id) ON DELETE RESTRICT,
      FOREIGN KEY (delivery_message_id) REFERENCES transport_logical_outbox(delivery_message_id) ON DELETE RESTRICT
    ) STRICT`,
  ),
  index(
    'transport_one_active_connection',
    'transport_connections',
    `CREATE UNIQUE INDEX transport_one_active_connection ON transport_connections(state) WHERE state = 'ACTIVE'`,
  ),
  index(
    'transport_one_live_wire',
    'transport_wire_outbox',
    `CREATE UNIQUE INDEX transport_one_live_wire ON transport_wire_outbox(delivery_message_id)
      WHERE state IN ('PENDING','PREPARED','WRITTEN')`,
  ),
  index(
    'transport_pending_commands',
    'transport_inbound_deliveries',
    `CREATE INDEX transport_pending_commands ON transport_inbound_deliveries(state, delivery_sequence)`,
  ),
  index(
    'transport_pending_wire',
    'transport_wire_outbox',
    `CREATE INDEX transport_pending_wire ON transport_wire_outbox(connection_id, state, sequence)`,
  ),
]);

export const TRANSPORT_SQLITE_SCHEMA_SQL = objects.map((item) => `${item.sql};`).join('\n');
export const TRANSPORT_SQLITE_SCHEMA_CONTRACT_DIGEST = digest({
  applicationId: TRANSPORT_SQLITE_APPLICATION_ID,
  version: TRANSPORT_SQLITE_SCHEMA_VERSION,
  objects,
});
export const TRANSPORT_SQLITE_EXPECTED_CATALOG_DIGEST = digest({
  applicationId: TRANSPORT_SQLITE_APPLICATION_ID,
  version: TRANSPORT_SQLITE_SCHEMA_VERSION,
  objects: [...objects].sort((left, right) =>
    left.type === right.type
      ? left.name < right.name
        ? -1
        : left.name > right.name
          ? 1
          : 0
      : left.type < right.type
        ? -1
        : 1,
  ),
});

export function transportSqliteCatalogDigest(database: DatabaseSync): string {
  const actual = (
    database
      .prepare(
        `SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema
       WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name`,
      )
      .all() as Record<string, unknown>[]
  ).map((row) => {
    if (
      typeof row.type !== 'string' ||
      typeof row.name !== 'string' ||
      typeof row.tableName !== 'string' ||
      typeof row.sql !== 'string'
    )
      throw new TypeError('Transport SQLite catalog is invalid.');
    return { type: row.type, name: row.name, tableName: row.tableName, sql: row.sql };
  });
  return digest({
    applicationId: pragma(database, 'application_id'),
    version: pragma(database, 'user_version'),
    objects: actual,
  });
}

function table(name: string, sql: string): CatalogObject {
  return Object.freeze({ type: 'table', name, tableName: name, sql });
}
function index(name: string, tableName: string, sql: string): CatalogObject {
  return Object.freeze({ type: 'index', name, tableName, sql });
}
function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
function pragma(database: DatabaseSync, name: string): number {
  const value = Object.values(database.prepare(`PRAGMA ${name}`).get() as object)[0];
  if (!Number.isSafeInteger(value)) throw new TypeError(`SQLite ${name} is invalid.`);
  return value as number;
}
