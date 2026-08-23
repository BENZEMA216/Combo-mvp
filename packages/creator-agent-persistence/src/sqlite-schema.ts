import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const CREATOR_AGENT_CATALOG_APPLICATION_ID = 0x43424143;
export const CREATOR_AGENT_CATALOG_SCHEMA_VERSION = 1;

const TABLES = Object.freeze([
  Object.freeze({
    name: 'agent_catalog_meta',
    sql: `CREATE TABLE agent_catalog_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      catalog_identity TEXT NOT NULL,
      schema_contract_digest TEXT NOT NULL,
      catalog_digest TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
    ) STRICT`,
  }),
  Object.freeze({
    name: 'agent_catalog_agents',
    sql: `CREATE TABLE agent_catalog_agents (
      agent_id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL UNIQUE,
      latest_draft_revision INTEGER NOT NULL CHECK (latest_draft_revision >= 1),
      latest_version_number INTEGER NOT NULL CHECK (latest_version_number >= 0),
      latest_version_id TEXT,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      CHECK ((latest_version_number = 0) = (latest_version_id IS NULL))
    ) STRICT`,
  }),
  Object.freeze({
    name: 'agent_catalog_drafts',
    sql: `CREATE TABLE agent_catalog_drafts (
      agent_id TEXT NOT NULL,
      draft_id TEXT NOT NULL,
      draft_revision INTEGER NOT NULL CHECK (draft_revision >= 1),
      base_version_id TEXT,
      definition_fingerprint TEXT NOT NULL,
      draft_fingerprint TEXT NOT NULL UNIQUE,
      handoff_json TEXT NOT NULL,
      draft_json TEXT NOT NULL,
      imported_at_ms INTEGER NOT NULL CHECK (imported_at_ms >= 0),
      PRIMARY KEY (agent_id, draft_id, draft_revision),
      UNIQUE (agent_id, draft_id, draft_revision, draft_fingerprint),
      FOREIGN KEY (agent_id) REFERENCES agent_catalog_agents(agent_id)
    ) STRICT`,
  }),
  Object.freeze({
    name: 'agent_catalog_versions',
    sql: `CREATE TABLE agent_catalog_versions (
      agent_id TEXT NOT NULL,
      version_id TEXT NOT NULL UNIQUE,
      version_number INTEGER NOT NULL CHECK (version_number >= 1),
      source_draft_id TEXT NOT NULL,
      source_draft_revision INTEGER NOT NULL CHECK (source_draft_revision >= 1),
      source_draft_fingerprint TEXT NOT NULL,
      definition_fingerprint TEXT NOT NULL,
      version_fingerprint TEXT NOT NULL UNIQUE,
      version_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      PRIMARY KEY (agent_id, version_id),
      UNIQUE (agent_id, version_number),
      UNIQUE (agent_id, source_draft_id, source_draft_revision),
      FOREIGN KEY (agent_id) REFERENCES agent_catalog_agents(agent_id),
      FOREIGN KEY (agent_id, source_draft_id, source_draft_revision, source_draft_fingerprint)
        REFERENCES agent_catalog_drafts(agent_id, draft_id, draft_revision, draft_fingerprint)
    ) STRICT`,
  }),
]);

export const CREATOR_AGENT_CATALOG_SCHEMA_SQL = TABLES.map((table) => table.sql).join(';\n');
export const CREATOR_AGENT_CATALOG_SCHEMA_CONTRACT_DIGEST = digest(
  `application_id=${CREATOR_AGENT_CATALOG_APPLICATION_ID}\nuser_version=${CREATOR_AGENT_CATALOG_SCHEMA_VERSION}\n${CREATOR_AGENT_CATALOG_SCHEMA_SQL}`,
);
export const CREATOR_AGENT_CATALOG_EXPECTED_DIGEST = digest(
  [...TABLES]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((table) => `table\0${table.name}\0${table.sql}`)
    .join('\n'),
);

export function creatorAgentCatalogDigest(database: DatabaseSync): string {
  const rows = database
    .prepare(
      `SELECT type, name, sql
         FROM sqlite_schema
        WHERE name NOT GLOB 'sqlite_*'
        ORDER BY type, name`,
    )
    .all() as Array<Record<string, unknown>>;
  const value = rows
    .map((row) => {
      if (
        typeof row.type !== 'string' ||
        typeof row.name !== 'string' ||
        typeof row.sql !== 'string'
      ) {
        throw new TypeError('Creator Agent catalog contains an unexpected schema object');
      }
      return `${row.type}\0${row.name}\0${row.sql}`;
    })
    .join('\n');
  return digest(value);
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
