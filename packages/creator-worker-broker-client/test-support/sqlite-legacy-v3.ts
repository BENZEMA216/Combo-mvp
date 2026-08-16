import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

import { canonicalizeJson } from '@cb/creator-agent-protocol';

import { WORKER_TRANSPORT_APPLICATION_ID } from '../src/sqlite-durable-transport.js';
import {
  WORKER_CONVERSATION_READY_SCHEMA_SQL,
  WORKER_INVOCATION_SCHEMA_SQL,
  sqliteInvocationRowDigest,
  workerInvocationAuthorityRows,
} from '../src/sqlite-invocation-journal.js';

const { DatabaseSync: SqliteDatabase } = createRequire(import.meta.url)('node:sqlite') as {
  readonly DatabaseSync: typeof DatabaseSync;
};

/** Reconstructs the exact schema-3/format-1 storage shape used by migration fixtures. */
export function downgradeToLegacyV3(filename: string): void {
  const database = new SqliteDatabase(filename);
  database.exec('PRAGMA foreign_keys = OFF; BEGIN EXCLUSIVE;');
  try {
    database.exec(
      legacyCreateTableSql(
        WORKER_INVOCATION_SCHEMA_SQL,
        'local_invocations',
        'local_invocations_v3',
      ),
    );
    database.exec(
      legacyCreateTableSql(
        WORKER_INVOCATION_SCHEMA_SQL,
        'local_invocation_outbox_receipts',
        'local_invocation_outbox_receipts_v3',
      ),
    );
    database.exec(
      legacyCreateTableSql(
        WORKER_CONVERSATION_READY_SCHEMA_SQL,
        'local_conversation_ready_outbox_receipts',
        'local_conversation_ready_outbox_receipts_v3',
      ),
    );
    database.exec(`
      INSERT INTO local_invocations_v3 SELECT * FROM local_invocations;
      INSERT INTO local_invocation_outbox_receipts_v3(
        receipt_id, source_event_id, fact_digest, delivery_message_id, ack_message_id,
        ack_connection_id, ack_sequence, ack_canonical_digest, cloud_evidence_digest,
        cloud_committed_at_ms, row_digest
      )
      SELECT receipt_id, source_event_id, fact_digest, delivery_message_id, ack_message_id,
             ack_connection_id, ack_sequence, ack_canonical_digest, cloud_evidence_digest,
             cloud_committed_at_ms, ''
      FROM local_invocation_outbox_receipts;
      INSERT INTO local_conversation_ready_outbox_receipts_v3(
        receipt_id, source_event_id, conversation_id, fact_digest, delivery_message_id,
        ack_message_id, ack_connection_id, ack_sequence, ack_canonical_digest, decision,
        cloud_decided_at_ms, row_digest
      )
      SELECT receipt_id, source_event_id, conversation_id, fact_digest, delivery_message_id,
             ack_message_id, ack_connection_id, ack_sequence, ack_canonical_digest, decision,
             cloud_decided_at_ms, ''
      FROM local_conversation_ready_outbox_receipts;
    `);
    for (const table of [
      'local_invocation_outbox_receipts_v3',
      'local_conversation_ready_outbox_receipts_v3',
    ] as const) {
      const rows = database.prepare(`SELECT * FROM ${table}`).all() as Array<
        Record<string, unknown>
      >;
      for (const row of rows) {
        const payload = { ...row };
        delete payload.receipt_id;
        delete payload.row_digest;
        database
          .prepare(`UPDATE ${table} SET row_digest = ? WHERE receipt_id = ?`)
          .run(
            sqliteInvocationRowDigest(table.replace(/_v3$/u, ''), payload),
            Number(row.receipt_id),
          );
      }
    }
    database.exec(`
      DROP TABLE local_conversation_ready_outbox_receipts;
      DROP TABLE local_invocation_outbox_receipts;
      DROP TABLE local_invocations;
      ALTER TABLE local_invocations_v3 RENAME TO local_invocations;
      ALTER TABLE local_invocation_outbox_receipts_v3
        RENAME TO local_invocation_outbox_receipts;
      ALTER TABLE local_conversation_ready_outbox_receipts_v3
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
      PRAGMA user_version = 3;
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
    const local = workerInvocationAuthorityRows(database);
    const schemaDigest = createHash('sha256').update(canonicalizeJson(schemaRows)).digest('hex');
    const authorityDigest = createHash('sha256')
      .update('combo:vnext:worker-authority:v1\0', 'utf8')
      .update(canonicalizeJson({ installation, owners, fences, local }), 'utf8')
      .digest('hex');
    rewriteLegacyEvidenceAccumulators(database);
    database
      .prepare(
        'UPDATE transport_meta SET schema_digest = ?, authority_digest = ? WHERE singleton = 1',
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
  database.close();
  writeLegacyWatermark(filename, {
    formatVersion: 1,
    applicationId: WORKER_TRANSPORT_APPLICATION_ID,
    schemaVersion: 3,
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
  });
}

function legacyCreateTableSql(schemaSql: string, sourceName: string, targetName: string): string {
  const marker = `CREATE TABLE ${sourceName} (`;
  const start = schemaSql.indexOf(marker);
  const endMarker = '\n  ) STRICT;';
  const end = start < 0 ? -1 : schemaSql.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('MISSING_LEGACY_TABLE_SCHEMA');
  return schemaSql
    .slice(start, end + endMarker.length)
    .replace(marker, `CREATE TABLE ${targetName} (`);
}

function rewriteLegacyEvidenceAccumulators(database: DatabaseSync): void {
  let inboundXor = Buffer.alloc(32);
  const inboundRows = database
    .prepare(
      `SELECT connection_id, sequence, message_id
       FROM transport_inbound_frames ORDER BY connection_id, sequence`,
    )
    .all() as Array<{ connection_id: string; sequence: string; message_id: string }>;
  for (const row of inboundRows) {
    const digest = createHash('sha256')
      .update('combo:vnext:worker-inbound-row:v1\0', 'utf8')
      .update(
        canonicalizeJson({
          connectionId: row.connection_id,
          sequence: row.sequence,
          messageId: row.message_id,
        }),
        'utf8',
      )
      .digest();
    inboundXor = Buffer.from(inboundXor.map((byte, index) => byte ^ (digest[index] ?? 0)));
  }
  let outboxXor = Buffer.alloc(32);
  const outboxRows = database
    .prepare('SELECT message_id FROM transport_outbox ORDER BY message_id')
    .all() as Array<{ message_id: string }>;
  for (const row of outboxRows) {
    const digest = createHash('sha256')
      .update('combo:vnext:worker-outbox-row:v1\0', 'utf8')
      .update(row.message_id, 'utf8')
      .digest();
    outboxXor = Buffer.from(outboxXor.map((byte, index) => byte ^ (digest[index] ?? 0)));
  }
  database
    .prepare(
      `UPDATE transport_meta SET
         inbound_evidence_count = ?, inbound_evidence_xor = ?,
         outbox_evidence_count = ?, outbox_evidence_xor = ?
       WHERE singleton = 1`,
    )
    .run(
      inboundRows.length,
      inboundXor.toString('hex'),
      outboxRows.length,
      outboxXor.toString('hex'),
    );
}

function writeLegacyWatermark(filename: string, payload: Record<string, unknown>): void {
  const canonicalPayload = canonicalizeJson(payload);
  const document = canonicalizeJson({
    payload,
    digest: createHash('sha256')
      .update('combo:vnext:worker-commit-watermark:v1\0', 'utf8')
      .update(canonicalPayload, 'utf8')
      .digest('hex'),
  });
  writeFileSync(`${filename}.watermark`, document, { mode: 0o600 });
}
