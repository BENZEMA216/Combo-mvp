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
  process.env.AGENT_SESSION_RECEIPTS_UPGRADE_PG_TEST === '1' &&
  Boolean(databaseUrl) &&
  rolePasswordsConfigured;
const pgDescribe = enabled ? describe : describe.skip;

const directory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(directory, '..', 'migrations');
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => /^\d{4}_[a-z0-9_]+[.]sql$/.test(file))
  .sort();
const migration0017 = '0017_agent_session_usage_receipts.sql';

function connectionStringFor(databaseName: string): string {
  const url = new URL(databaseUrl!);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quotedDatabaseName(databaseName: string): string {
  if (!/^combo_receipts_upgrade_[0-9a-f]{32}$/.test(databaseName)) {
    throw new Error('unsafe generated upgrade database name');
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

pgDescribe('0016 to 0017 Agent Session receipt upgrade on PostgreSQL 16', () => {
  it('preserves committed legacy Session and charge rows while appending the new validated schema', async () => {
    const databaseName = `combo_receipts_upgrade_${randomUUID().replaceAll('-', '')}`;
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

      const prefix = migrationFiles.slice(0, migrationFiles.indexOf(migration0017));
      expect(prefix.at(-1)).toBe('0016_agent_package_registry.sql');
      for (const filename of prefix) await applyMigration(upgrade, filename);

      expect(
        (
          await upgrade.query<{ filename: string }>(
            'SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1',
          )
        ).rows[0]?.filename,
      ).toBe('0016_agent_package_registry.sql');
      expect(
        (
          await upgrade.query<{ exists: boolean }>(
            "SELECT to_regclass('public.agent_usage_receipts') IS NOT NULL AS exists",
          )
        ).rows[0]?.exists,
      ).toBe(false);

      const ownerUserId = (
        await upgrade.query<{ id: string }>(
          'INSERT INTO users (account) VALUES ($1) RETURNING id',
          [creatorAccount()],
        )
      ).rows[0]!.id;
      const taskId = (
        await upgrade.query<{ id: string }>(
          `INSERT INTO tasks (owner_user_id, idempotency_key)
             VALUES ($1, $2) RETURNING id`,
          [ownerUserId, `upgrade-task-${randomUUID()}`],
        )
      ).rows[0]!.id;
      const capabilityId = (
        await upgrade.query<{ id: string }>(
          `INSERT INTO capabilities (task_id, owner_user_id, name, storage_key)
             VALUES ($1, $2, 'legacy upgrade', $3) RETURNING id`,
          [taskId, ownerUserId, `legacy-upgrade/${randomUUID()}`],
        )
      ).rows[0]!.id;
      await upgrade.query('INSERT INTO billing_accounts (owner_user_id) VALUES ($1)', [
        ownerUserId,
      ]);

      const completedSessionId = (
        await upgrade.query<{ id: string }>(
          'INSERT INTO sessions (capability_id, owner_user_id) VALUES ($1, $2) RETURNING id',
          [capabilityId, ownerUserId],
        )
      ).rows[0]!.id;
      const completedTurnId = randomUUID();
      await upgrade.query(
        `INSERT INTO turns (id, session_id, status, finished_at)
           VALUES ($1, $2, 'completed', now())`,
        [completedTurnId, completedSessionId],
      );
      const completedChargeId = (
        await upgrade.query<{ id: string }>(
          `INSERT INTO usage_charges (
               owner_user_id, usage_id, capability_id, session_id, turn_id,
               request_fingerprint, charge_source, status, unit_price_cents,
               free_limit_snapshot, reserved_cents, settled_cents, finished_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6, 'owner', 'completed', 1, 3, 0, 0, now()
             ) RETURNING id`,
          [
            ownerUserId,
            randomUUID(),
            capabilityId,
            completedSessionId,
            completedTurnId,
            'a'.repeat(64),
          ],
        )
      ).rows[0]!.id;

      const reservedSessionId = (
        await upgrade.query<{ id: string }>(
          'INSERT INTO sessions (capability_id, owner_user_id) VALUES ($1, $2) RETURNING id',
          [capabilityId, ownerUserId],
        )
      ).rows[0]!.id;
      const reservedTurnId = randomUUID();
      await upgrade.query(`INSERT INTO turns (id, session_id, status) VALUES ($1, $2, 'running')`, [
        reservedTurnId,
        reservedSessionId,
      ]);
      const reservedChargeId = (
        await upgrade.query<{ id: string }>(
          `INSERT INTO usage_charges (
               owner_user_id, usage_id, capability_id, session_id, turn_id,
               request_fingerprint, charge_source, status, unit_price_cents,
               free_limit_snapshot, reserved_cents, settled_cents
             ) VALUES (
               $1, $2, $3, $4, $5, $6, 'owner', 'reserved', 1, 3, 0, 0
             ) RETURNING id`,
          [
            ownerUserId,
            randomUUID(),
            capabilityId,
            reservedSessionId,
            reservedTurnId,
            'b'.repeat(64),
          ],
        )
      ).rows[0]!.id;

      await applyMigration(upgrade, migration0017);

      const sessions = await upgrade.query<{
        id: string;
        product_kind: string;
        release_id: string | null;
        resource_digest: string | null;
      }>(
        `SELECT id, product_kind, release_id,
                  knowledge_resource_digest AS resource_digest
             FROM sessions
            WHERE id = ANY($1::uuid[])
            ORDER BY id`,
        [[completedSessionId, reservedSessionId]],
      );
      expect(sessions.rows).toHaveLength(2);
      for (const session of sessions.rows) {
        expect(session).toMatchObject({
          product_kind: 'legacy_capability',
          release_id: null,
          resource_digest: null,
        });
      }

      const charges = await upgrade.query<{
        id: string;
        status: string;
        product_kind: string;
        release_id: string | null;
        billing_policy_version: string | null;
        execution_outcome: string | null;
      }>(
        `SELECT id, status, product_kind, release_id,
                  billing_policy_version, execution_outcome
             FROM usage_charges
            WHERE id = ANY($1::uuid[])
            ORDER BY status`,
        [[completedChargeId, reservedChargeId]],
      );
      expect(charges.rows).toEqual([
        {
          id: completedChargeId,
          status: 'completed',
          product_kind: 'legacy_capability',
          release_id: null,
          billing_policy_version: null,
          execution_outcome: null,
        },
        {
          id: reservedChargeId,
          status: 'reserved',
          product_kind: 'legacy_capability',
          release_id: null,
          billing_policy_version: null,
          execution_outcome: null,
        },
      ]);
      expect(
        (await upgrade.query<{ count: string }>('SELECT count(*) FROM agent_usage_receipts'))
          .rows[0]?.count,
      ).toBe('0');

      const validations = await upgrade.query<{ name: string; validated: boolean }>(
        `SELECT conname AS name, convalidated AS validated
             FROM pg_constraint
            WHERE conname IN (
              'ck_sessions_agent_package_binding',
              'fk_sessions_agent_package_release',
              'ck_usage_charge_agent_package_binding',
              'fk_usage_charge_agent_package_release'
            )
            ORDER BY conname`,
      );
      expect(validations.rows).toHaveLength(4);
      expect(validations.rows.every(({ validated }) => validated)).toBe(true);

      const applied = (
        await upgrade.query<{ filename: string }>(
          'SELECT filename FROM schema_migrations ORDER BY filename',
        )
      ).rows.map(({ filename }) => filename);
      expect(planMigrations(migrationFiles, applied, migration0017).pending).toEqual([]);
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
