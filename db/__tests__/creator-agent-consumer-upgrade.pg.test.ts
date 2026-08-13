import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.CREATOR_AGENT_UPGRADE_PG_TEST === '1' && Boolean(databaseUrl);
const pgDescribe = enabled ? describe : describe.skip;
const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

function digest(marker: string): string {
  return marker.repeat(64);
}

function databaseConnectionString(name: string): string {
  const url = new URL(databaseUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function applyMigration(client: Client, filename: string): Promise<void> {
  const sql = readFileSync(join(migrationsDirectory, filename), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(`INSERT INTO schema_migrations(filename) VALUES ($1)`, [filename]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

pgDescribe('0012 -> 0013 Creator Agent persistent upgrade', () => {
  it('backfills both active and terminal Conversations before restoring the immutable trigger', async () => {
    const admin = new Client({ connectionString: databaseUrl });
    const databaseName = `combo_vnext_upgrade_${randomUUID().replaceAll('-', '')}`;
    await admin.connect();
    let target: Client | undefined;
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      target = new Client({ connectionString: databaseConnectionString(databaseName) });
      await target.connect();
      await target.query(`
        CREATE TABLE schema_migrations (
          filename text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      const pre0013 = readdirSync(migrationsDirectory)
        .filter((filename) => /^\d{4}_.+\.sql$/u.test(filename) && filename < '0013_')
        .sort();
      expect(pre0013.at(-1)).toBe('0012_creator_hosted_agent_vnext.sql');
      for (const filename of pre0013) await applyMigration(target, filename);

      const ids = {
        creator: randomUUID(),
        consumer: randomUUID(),
        snapshot: randomUUID(),
        agent: randomUUID(),
        version: randomUUID(),
        deployment: randomUUID(),
        idle: randomUUID(),
        closed: randomUUID(),
      };
      await target.query(
        `INSERT INTO users (id, account)
         VALUES ($1, 'creator-aaaaaaab'), ($2, 'creator-aaaaaaac')`,
        [ids.creator, ids.consumer],
      );
      await target.query(
        `INSERT INTO context_snapshots (
           id, creator_id, snapshot_digest, archive_digest, cipher_digest,
           object_key, manifest_object_key, compressed_bytes, expanded_bytes,
           file_count, encryption_key_ref
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 128, 256, 1, $8)`,
        [
          ids.snapshot,
          ids.creator,
          digest('1'),
          digest('2'),
          digest('3'),
          `upgrade/${ids.snapshot}.archive.enc`,
          `upgrade/${ids.snapshot}.manifest.enc`,
          `kms://${ids.snapshot}`,
        ],
      );
      await target.query(
        `INSERT INTO agents (id, creator_id, public_slug, name)
         VALUES ($1, $2, 'upgrade-agent', 'Upgrade Agent')`,
        [ids.agent, ids.creator],
      );
      await target.query(
        `INSERT INTO agent_versions (
           id, agent_id, creator_id, ordinal, schema_version, version_digest, snapshot_id,
           behavior_contract, behavior_contract_digest, runtime_policy, runtime_policy_digest,
           io_contract, io_contract_digest, model_policy, model_policy_digest,
           codex_runtime_version, codex_runtime_artifact_digest, codex_protocol_schema_digest
         ) VALUES (
           $1, $2, $3, 1, 1, $4, $5,
           '{}'::jsonb, $6, '{}'::jsonb, $7, '{}'::jsonb, $8, '{}'::jsonb, $9,
           '0.147.0-alpha.6.5', $10, $11
         )`,
        [
          ids.version,
          ids.agent,
          ids.creator,
          digest('7'),
          ids.snapshot,
          digest('a'),
          digest('b'),
          digest('c'),
          digest('d'),
          `sha256:${digest('e')}`,
          `sha256:${digest('f')}`,
        ],
      );
      await target.query(
        `INSERT INTO deployments (id, agent_id, creator_id, environment, desired_version_id)
         VALUES ($1, $2, $3, 'TEST', $4)`,
        [ids.deployment, ids.agent, ids.creator, ids.version],
      );
      await target.query(
        `INSERT INTO agent_conversations (
           id, agent_id, deployment_id, agent_version_id, creator_id,
           consumer_subject_id, version_digest, state, expires_at, closed_at
         ) VALUES
           ($1, $3, $4, $5, $6, $7, $8, 'IDLE', now() + interval '1 day', NULL),
           ($2, $3, $4, $5, $6, $7, $8, 'CLOSED', now() + interval '1 day', now())`,
        [
          ids.idle,
          ids.closed,
          ids.agent,
          ids.deployment,
          ids.version,
          ids.creator,
          ids.consumer,
          digest('7'),
        ],
      );

      await applyMigration(target, '0013_creator_agent_consumer_create.sql');

      const rows = await target.query<{
        id: string;
        idempotency_key: string;
        request_digest: string;
        state: string;
      }>(
        `SELECT id, idempotency_key, request_digest, state
           FROM agent_conversations
          ORDER BY state`,
      );
      expect(rows.rows).toHaveLength(2);
      for (const row of rows.rows) {
        expect(row.idempotency_key).toBe(row.id);
        expect(row.request_digest).toMatch(/^[a-f0-9]{64}$/u);
      }
      await expect(
        target.query(`UPDATE agent_conversations SET request_digest = $2 WHERE id = $1`, [
          ids.closed,
          digest('9'),
        ]),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(
        target.query<{ enabled: string }>(
          `SELECT tgenabled AS enabled
             FROM pg_trigger
            WHERE tgrelid = 'agent_conversations'::regclass
              AND tgname = 'agent_conversations_transition'
              AND NOT tgisinternal`,
        ),
      ).resolves.toMatchObject({ rows: [{ enabled: 'O' }] });
    } finally {
      await target?.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.end();
    }
  }, 120_000);
});
