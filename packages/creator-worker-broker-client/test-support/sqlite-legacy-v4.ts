import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

import { canonicalizeJson } from '@cb/creator-agent-protocol';

import { WORKER_TRANSPORT_APPLICATION_ID } from '../src/sqlite-durable-transport.js';
import {
  WORKER_INVOCATION_SCHEMA_V4_SQL,
  sqliteInvocationRowDigest,
  workerInvocationAuthorityRows,
} from '../src/sqlite-invocation-journal.js';

const { DatabaseSync: SqliteDatabase } = createRequire(import.meta.url)('node:sqlite') as {
  readonly DatabaseSync: typeof DatabaseSync;
};

/** Reconstructs the exact schema-4/format-2 shape used by v4 -> v5 migration tests. */
export function downgradeToLegacyV4(
  filename: string,
  options: { allowCancelledForMigrationTest?: boolean } = {},
): void {
  const database = new SqliteDatabase(filename);
  database.exec('PRAGMA foreign_keys = OFF; BEGIN EXCLUSIVE;');
  try {
    const cancelled = database
      .prepare(
        `SELECT 1 FROM local_invocations WHERE state = 'CANCELLED'
         UNION ALL SELECT 1 FROM local_invocation_events
          WHERE event_type IN ('invocation.cancelled', 'local.invocation.cancel_requested')
         LIMIT 1`,
      )
      .get();
    if (cancelled !== undefined && options.allowCancelledForMigrationTest !== true) {
      throw new Error('V4_FIXTURE_CANNOT_ERASE_CANCELLED_AUTHORITY');
    }
    database.exec(
      createTableSql(WORKER_INVOCATION_SCHEMA_V4_SQL, 'local_invocations', 'local_invocations_v4'),
    );
    database.exec(
      createTableSql(
        WORKER_INVOCATION_SCHEMA_V4_SQL,
        'local_invocation_events',
        'local_invocation_events_v4',
      ),
    );
    const columns = (
      database.prepare(`PRAGMA table_info(local_invocations_v4)`).all() as Array<{ name: string }>
    ).map(({ name }) => name);
    const projection = columns
      .map((name) =>
        name === 'host_prompt_release_count'
          ? 'host_dispatch_attempt_count AS host_prompt_release_count'
          : name,
      )
      .join(', ');
    database.exec(`
      INSERT INTO local_invocations_v4(${columns.join(', ')})
      SELECT ${projection} FROM local_invocations;
      INSERT INTO local_invocation_events_v4 SELECT * FROM local_invocation_events;
    `);
    for (const row of database.prepare(`SELECT * FROM local_invocations_v4`).all() as Array<
      Record<string, unknown>
    >) {
      const payload = { ...row };
      delete payload.row_digest;
      database
        .prepare(`UPDATE local_invocations_v4 SET row_digest = ? WHERE invocation_id = ?`)
        .run(sqliteInvocationRowDigest('local_invocations', payload), String(row.invocation_id));
    }
    database.exec(`
      DROP TABLE local_invocation_interrupt_receipts;
      DROP TABLE local_invocation_events;
      DROP TABLE local_invocations;
      ALTER TABLE local_invocations_v4 RENAME TO local_invocations;
      ALTER TABLE local_invocation_events_v4 RENAME TO local_invocation_events;
      CREATE UNIQUE INDEX local_one_active_invocation
        ON local_invocations(installation_id)
        WHERE state IN ('PREPARED', 'STARTING', 'RUNNING', 'FINAL_READY');
      CREATE INDEX local_invocation_conversation_state
        ON local_invocations(conversation_id, state, created_at_ms);
      CREATE INDEX local_invocation_event_order
        ON local_invocation_events(invocation_id, event_id);
      CREATE TRIGGER local_invocation_events_no_update
        BEFORE UPDATE ON local_invocation_events BEGIN
          SELECT RAISE(ABORT, 'local_invocation_events is append-only');
        END;
      PRAGMA user_version = 4;
    `);
    const schemaRows = database
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
         WHERE (name LIKE 'transport_%' OR name LIKE 'local_%') AND sql IS NOT NULL
         ORDER BY type, name`,
      )
      .all();
    const installation = database
      .prepare(
        `SELECT installation_id, highest_owner_epoch FROM transport_installations
         ORDER BY installation_id`,
      )
      .all();
    const owners = database
      .prepare(
        `SELECT installation_id, owner_token_digest, owner_epoch, lease_expires_at_ms,
                acquired_at_ms, updated_at_ms
         FROM transport_installation_owners ORDER BY installation_id`,
      )
      .all();
    const fences = database
      .prepare(
        `SELECT installation_id, deployment_id, highest_fence
         FROM transport_deployment_fences ORDER BY installation_id, deployment_id`,
      )
      .all();
    const schemaDigest = createHash('sha256').update(canonicalizeJson(schemaRows)).digest('hex');
    const authorityDigest = createHash('sha256')
      .update('combo:vnext:worker-authority:v1\0', 'utf8')
      .update(
        canonicalizeJson({
          installation,
          owners,
          fences,
          local: workerInvocationAuthorityRows(database),
        }),
        'utf8',
      )
      .digest('hex');
    database
      .prepare(
        `UPDATE transport_meta SET schema_digest = ?, authority_digest = ? WHERE singleton = 1`,
      )
      .run(schemaDigest, authorityDigest);
    database.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);');
  } catch (error) {
    database.exec('ROLLBACK');
    database.close();
    throw error;
  }
  const meta = database
    .prepare(
      `SELECT schema_digest, authority_digest, installation_id, journal_generation,
              authorization_digest, commit_epoch, inbound_evidence_count,
              inbound_evidence_xor, outbox_evidence_count, outbox_evidence_xor,
              max_database_bytes, max_wal_bytes, min_free_bytes
       FROM transport_meta WHERE singleton = 1`,
    )
    .get() as Record<string, string | number>;
  const active = database
    .prepare(
      `SELECT installation_id, connection_id, connection_digest
       FROM transport_connections WHERE status = 'ACTIVE' LIMIT 2`,
    )
    .all() as Array<{
    installation_id: string;
    connection_id: string;
    connection_digest: string;
  }>;
  database.close();
  const currentConnectionAuthority =
    active.length === 0
      ? null
      : {
          installationId: active[0]!.installation_id,
          connectionId: active[0]!.connection_id,
          connectionDigest: active[0]!.connection_digest,
        };
  const payload = {
    formatVersion: 2,
    evidenceVersion: 2,
    applicationId: WORKER_TRANSPORT_APPLICATION_ID,
    schemaVersion: 4,
    schemaDigest: meta.schema_digest,
    authorityDigest: meta.authority_digest,
    installationId: meta.installation_id,
    journalGeneration: meta.journal_generation,
    authorizationDigest: meta.authorization_digest,
    commitEpoch: meta.commit_epoch,
    inboundEvidenceCount: meta.inbound_evidence_count,
    inboundEvidenceXor: meta.inbound_evidence_xor,
    outboxEvidenceCount: meta.outbox_evidence_count,
    outboxEvidenceXor: meta.outbox_evidence_xor,
    maxDatabaseBytes: meta.max_database_bytes,
    maxWalBytes: meta.max_wal_bytes,
    minFreeBytes: meta.min_free_bytes,
    currentConnectionAuthority,
  };
  const canonical = canonicalizeJson(payload);
  writeFileSync(
    `${filename}.watermark`,
    canonicalizeJson({
      payload,
      digest: createHash('sha256')
        .update('combo:vnext:worker-commit-watermark:v2\0', 'utf8')
        .update(canonical, 'utf8')
        .digest('hex'),
    }),
    { mode: 0o600 },
  );
}

function createTableSql(schema: string, source: string, target: string): string {
  const marker = `CREATE TABLE ${source} (`;
  const start = schema.indexOf(marker);
  const endMarker = '\n  ) STRICT;';
  const end = start < 0 ? -1 : schema.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('MISSING_V4_SCHEMA');
  return schema.slice(start, end + endMarker.length).replace(marker, `CREATE TABLE ${target} (`);
}
