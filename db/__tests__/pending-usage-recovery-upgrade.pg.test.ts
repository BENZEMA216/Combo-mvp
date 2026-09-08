import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { planMigrations } from '../scripts/migrate.ts';
import { provisionApplicationRoleLogins } from '../scripts/provision-app-roles.ts';

const databaseUrl = process.env.DATABASE_URL;
const rolePasswordsConfigured = [
  'POSTGRES_API_PASSWORD',
  'POSTGRES_WORKER_PASSWORD',
  'POSTGRES_RUNTIME_PASSWORD',
].every((key) => Boolean(process.env[key]));
const enabled =
  process.env.PENDING_USAGE_RECOVERY_UPGRADE_PG_TEST === '1' &&
  Boolean(databaseUrl) &&
  rolePasswordsConfigured;
const pgDescribe = enabled ? describe : describe.skip;

const directory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(directory, '..', 'migrations');
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => /^\d{4}_[a-z0-9_]+[.]sql$/.test(file))
  .sort();
const migration0019 = '0019_pending_usage_recovery.sql';

function connectionStringFor(databaseName: string): string {
  const url = new URL(databaseUrl!);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quotedDatabaseName(databaseName: string): string {
  if (!/^combo_pending_upgrade_[0-9a-f]{32}$/.test(databaseName)) {
    throw new Error('unsafe generated pending-recovery upgrade database name');
  }
  return `"${databaseName}"`;
}

function creatorAccount(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return `creator-${randomUUID()
    .replaceAll('-', '')
    .slice(0, 8)
    .split('')
    .map((character) => alphabet[Number.parseInt(character, 16)]!)
    .join('')}`;
}

async function applyMigration(client: Client, filename: string): Promise<void> {
  const sql = readFileSync(join(migrationsDirectory, filename), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

pgDescribe('receipts 0018 to pending recovery 0019 upgrade on PostgreSQL 16', () => {
  it('preserves legacy recharge orders as NULL while appending a validated empty recovery schema', async () => {
    const databaseName = `combo_pending_upgrade_${randomUUID().replaceAll('-', '')}`;
    const admin = new Client({ connectionString: connectionStringFor('postgres') });
    let upgrade: Client | undefined;
    let databaseCreated = false;

    await admin.connect();
    try {
      const version = await admin.query<{ version: string }>(
        "SELECT current_setting('server_version') AS version",
      );
      expect(version.rows[0]?.version).toMatch(/^16[.]/);
      await admin.query(`CREATE DATABASE ${quotedDatabaseName(databaseName)}`);
      databaseCreated = true;

      upgrade = new Client({ connectionString: connectionStringFor(databaseName) });
      await upgrade.connect();
      await upgrade.query(`
        CREATE TABLE schema_migrations (
          filename text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      const prefix = migrationFiles.slice(0, migrationFiles.indexOf(migration0019));
      expect(prefix.at(-1)).toBe('0018_agent_session_usage_receipts.sql');
      for (const filename of prefix) await applyMigration(upgrade, filename);

      expect(
        (
          await upgrade.query<{ filename: string }>(
            'SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1',
          )
        ).rows[0]?.filename,
      ).toBe('0018_agent_session_usage_receipts.sql');
      expect(
        (
          await upgrade.query<{ exists: boolean }>(
            "SELECT to_regclass('public.pending_usage_recoveries') IS NOT NULL AS exists",
          )
        ).rows[0]?.exists,
      ).toBe(false);

      const ownerUserId = (
        await upgrade.query<{ id: string }>(
          'INSERT INTO users (account) VALUES ($1) RETURNING id',
          [creatorAccount()],
        )
      ).rows[0]!.id;
      const legacyOrderId = (
        await upgrade.query<{ id: string }>(
          `INSERT INTO recharge_orders (
             order_no, owner_user_id, client_idempotency_key, package_id, amount_cents,
             payment_method, pay_type, gateway_environment, institution_no, merchant_no,
             pay_trace_no, pay_time
           ) VALUES (
             $1, $2, $3, 'manual', 1, 'qr', 'alipay', 'test', 'institution', 'merchant',
             $4, '20260901120000'
           ) RETURNING id`,
          [
            `CBR${randomUUID().replaceAll('-', '')}`,
            ownerUserId,
            randomUUID(),
            `CB${randomUUID().replaceAll('-', '')}`,
          ],
        )
      ).rows[0]!.id;

      await applyMigration(upgrade, migration0019);

      expect(
        (
          await upgrade.query<{ recovery_usage_id: string | null }>(
            'SELECT recovery_usage_id FROM recharge_orders WHERE id = $1',
            [legacyOrderId],
          )
        ).rows[0],
      ).toEqual({ recovery_usage_id: null });
      expect(
        (await upgrade.query<{ count: string }>('SELECT count(*) FROM pending_usage_recoveries'))
          .rows[0]?.count,
      ).toBe('0');
      await expect(
        upgrade.query(
          `UPDATE recharge_orders
              SET query_attempt_count = query_attempt_count + 1, updated_at = now()
            WHERE id = $1`,
          [legacyOrderId],
        ),
      ).resolves.toBeDefined();

      const constraints = await upgrade.query<{ name: string; validated: boolean }>(
        `SELECT conname AS name, convalidated AS validated
           FROM pg_constraint
          WHERE conname IN (
            'fk_pending_usage_recovery_session_scope',
            'fk_pending_usage_recovery_release',
            'fk_pending_usage_recovery_terminal_turn',
            'fk_recharge_order_pending_usage_recovery'
          )
          ORDER BY conname`,
      );
      expect(constraints.rows).toHaveLength(4);
      expect(constraints.rows.every(({ validated }) => validated)).toBe(true);

      const applied = (
        await upgrade.query<{ filename: string }>(
          'SELECT filename FROM schema_migrations ORDER BY filename',
        )
      ).rows.map(({ filename }) => filename);
      const historicalSource = migrationFiles.slice(0, migrationFiles.indexOf(migration0019) + 1);
      expect(planMigrations(historicalSource, applied, migration0019).pending).toEqual([]);
    } finally {
      if (upgrade) await upgrade.end().catch(() => undefined);
      if (databaseCreated) {
        await admin
          .query(`DROP DATABASE ${quotedDatabaseName(databaseName)} WITH (FORCE)`)
          .catch(() => undefined);
      }
      await provisionApplicationRoleLogins(admin);
      await admin.end();
    }
  }, 120_000);
});
