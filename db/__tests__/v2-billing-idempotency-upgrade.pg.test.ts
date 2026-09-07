import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrationFile, listMigrations } from '../scripts/migrate.js';
import {
  restoreV2RoleLoginsWithinMigration,
  snapshotExistingV2ApplicationRoles,
} from '../scripts/provision-v2-app-roles.js';

const adminUrl = process.env.DATABASE_URL;
const enabled = process.env.V2_BILLING_UPGRADE_PG_TEST === '1' && Boolean(adminUrl);
const pgDescribe = enabled ? describe : describe.skip;
const dbRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function databaseName(label: string): string {
  return `combo_v2_${label}_${randomBytes(5).toString('hex')}`;
}

function connectionString(database: string): string {
  const url = new URL(adminUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function migrationSource(file: string): string {
  const directory = file.includes('_v2_') ? 'v2-migrations' : 'migrations';
  return readFileSync(join(dbRoot, directory, file), 'utf8');
}

pgDescribe('0014 to 0015 V2 billing upgrade', () => {
  let control: Client;
  const databases: string[] = [];

  beforeAll(async () => {
    const url = new URL(adminUrl!);
    url.pathname = '/postgres';
    control = new Client({ connectionString: url.toString() });
    await control.connect();
  });

  afterAll(async () => {
    for (const database of databases) {
      await control.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    }
    await control?.end();
  });

  async function createLegacyDatabase(label: string): Promise<Client> {
    const database = databaseName(label);
    databases.push(database);
    await control.query(`CREATE DATABASE ${database}`);
    const client = new Client({ connectionString: connectionString(database) });
    await client.connect();
    const preexistingRoles = await snapshotExistingV2ApplicationRoles(client);
    await client.query(`
      CREATE TABLE schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // This fixture is permanently the 0014 database, even after new migration tails are added.
    const legacyFiles = listMigrations('v2').filter((file) => Number(file.slice(0, 4)) <= 14);
    expect(legacyFiles.at(-1)).toBe('0014_v2_email_login.sql');
    for (const file of legacyFiles) {
      await applyMigrationFile(client, file, migrationSource(file), () =>
        restoreV2RoleLoginsWithinMigration(client, file, preexistingRoles),
      );
    }
    return client;
  }

  async function insertLegacyEvent(client: Client, wrongScope: boolean) {
    const holdUser = randomUUID();
    const eventUser = wrongScope ? randomUUID() : holdUser;
    await client.query('INSERT INTO v2_users(id) VALUES ($1), ($2) ON CONFLICT DO NOTHING', [
      holdUser,
      eventUser,
    ]);
    const hold = await client.query<{ id: string }>(
      `INSERT INTO v2_holds (user_id, agent_id, turn_id, estimated_amount, expires_at)
       VALUES ($1, 'upgrade-agent', $2, 100, now() + interval '5 minutes') RETURNING id`,
      [holdUser, `turn-${randomUUID()}`],
    );
    const event = await client.query<{ id: string }>(
      `INSERT INTO v2_metering_events
         (agent_id, user_id, turn_id, hold_id, dimension, quantity, source)
       SELECT agent_id, $2, turn_id, id, 'llm_token_out', 10, 'gateway'
         FROM v2_holds WHERE id = $1
       RETURNING id`,
      [hold.rows[0]!.id, eventUser],
    );
    return event.rows[0]!.id;
  }

  it('backfills legacy rows, restores append-only protection, and records the new head', async () => {
    const client = await createLegacyDatabase('upgrade');
    try {
      const eventId = await insertLegacyEvent(client, false);
      const rechargeUserId = randomUUID();
      const legacyRechargeKey = `legacy-recharge-${randomUUID()}`;
      await client.query('INSERT INTO v2_users(id) VALUES ($1)', [rechargeUserId]);
      await client.query('INSERT INTO v2_wallets(user_id, principal_balance) VALUES ($1, 250)', [
        rechargeUserId,
      ]);
      await client.query(
        `INSERT INTO v2_ledger
           (user_id, kind, bucket, amount, ref_id, idempotency_key)
         VALUES ($1, 'recharge', 'principal', 250, 'legacy-ticket', $2)`,
        [rechargeUserId, legacyRechargeKey],
      );
      const file = '0015_v2_billing_idempotency.sql';
      await applyMigrationFile(client, file, migrationSource(file));

      const event = await client.query<{ idempotency_key: string }>(
        'SELECT idempotency_key FROM v2_metering_events WHERE id = $1',
        [eventId],
      );
      expect(event.rows[0]!.idempotency_key).toBe(`legacy:v0:${eventId}`);
      const expectedRechargeKey = `recharge:v1:${createHash('sha256')
        .update(legacyRechargeKey, 'utf8')
        .digest('hex')}`;
      const recharge = await client.query<{ count: string; balance: string }>(
        `SELECT
           (SELECT count(*) FROM v2_ledger
             WHERE user_id = $1 AND idempotency_key = $2) AS count,
           (SELECT principal_balance FROM v2_wallets WHERE user_id = $1)::text AS balance`,
        [rechargeUserId, expectedRechargeKey],
      );
      expect(recharge.rows[0]).toEqual({ count: '1', balance: '250' });

      // 0014 writer 的同 raw key 重试仍由 INSERT trigger 归一化并撞原唯一键；
      // 前面的余额 UPDATE 与碰撞处在同一事务，回滚后不能二次入账。
      await client.query('BEGIN');
      await client.query(
        'UPDATE v2_wallets SET principal_balance = principal_balance + 250 WHERE user_id = $1',
        [rechargeUserId],
      );
      await expect(
        client.query(
          `INSERT INTO v2_ledger
             (user_id, kind, bucket, amount, ref_id, idempotency_key)
           VALUES ($1, 'recharge', 'principal', 250, 'legacy-ticket', $2)`,
          [rechargeUserId, legacyRechargeKey],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await client.query('ROLLBACK');
      const rechargeAfterRetry = await client.query<{ count: string; balance: string }>(
        `SELECT
           (SELECT count(*) FROM v2_ledger WHERE user_id = $1) AS count,
           (SELECT principal_balance FROM v2_wallets WHERE user_id = $1)::text AS balance`,
        [rechargeUserId],
      );
      expect(rechargeAfterRetry.rows[0]).toEqual({ count: '1', balance: '250' });

      const legacyMeter = await client.query<{ idempotency_key: string }>(
        `INSERT INTO v2_metering_events
           (agent_id, user_id, turn_id, hold_id, dimension, quantity, source)
         SELECT agent_id, user_id, turn_id, hold_id, 'llm_token_in', 5, 'gateway'
           FROM v2_metering_events WHERE id = $1
         RETURNING idempotency_key`,
        [eventId],
      );
      expect(legacyMeter.rows[0]!.idempotency_key).toMatch(/^legacy:v0:[0-9a-f-]{36}$/);
      const legacyEstimated = await client.query<{
        hold_id: string;
        idempotency_key: string;
      }>(
        `INSERT INTO v2_metering_events
           (agent_id, user_id, turn_id, hold_id, quantity, source)
         SELECT agent_id, user_id, turn_id, hold_id, 5, 'estimated'
           FROM v2_metering_events WHERE id = $1
         RETURNING hold_id, idempotency_key`,
        [eventId],
      );
      expect(legacyEstimated.rows[0]!.idempotency_key).toBe(
        `meter:estimated:v1:${legacyEstimated.rows[0]!.hold_id}`,
      );
      await expect(
        client.query('UPDATE v2_metering_events SET quantity = quantity + 1 WHERE id = $1', [
          eventId,
        ]),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(
        client.query('UPDATE v2_ledger SET amount = amount + 1 WHERE user_id = $1', [
          rechargeUserId,
        ]),
      ).rejects.toMatchObject({ code: '55000' });
      const ledger = await client.query<{ count: string }>(
        'SELECT count(*) AS count FROM schema_migrations WHERE filename = $1',
        [file],
      );
      expect(ledger.rows[0]!.count).toBe('1');
    } finally {
      await client.end();
    }
  });

  it('rejects a legacy event attached to the wrong user without partial DDL', async () => {
    const client = await createLegacyDatabase('wrong_scope');
    try {
      await insertLegacyEvent(client, true);
      const file = '0015_v2_billing_idempotency.sql';
      await expect(applyMigrationFile(client, file, migrationSource(file))).rejects.toThrow(
        /foreign key constraint|fk_v2_metering_exact_hold/i,
      );
      const column = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'v2_metering_events'
              AND column_name = 'idempotency_key'
         ) AS exists`,
      );
      expect(column.rows[0]!.exists).toBe(false);
      const ledger = await client.query<{ count: string }>(
        'SELECT count(*) AS count FROM schema_migrations WHERE filename = $1',
        [file],
      );
      expect(ledger.rows[0]!.count).toBe('0');
    } finally {
      await client.end();
    }
  });

  it('rejects an existing unsafe wallet balance without partially upgrading', async () => {
    const client = await createLegacyDatabase('unsafe_wallet');
    try {
      const userId = randomUUID();
      await client.query('INSERT INTO v2_users(id) VALUES ($1)', [userId]);
      await client.query('INSERT INTO v2_wallets(user_id, principal_balance) VALUES ($1, $2)', [
        userId,
        '9007199254740992',
      ]);

      const file = '0015_v2_billing_idempotency.sql';
      await expect(applyMigrationFile(client, file, migrationSource(file))).rejects.toThrow(
        /ck_v2_wallet_safe_integer_range/i,
      );
      const column = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'v2_metering_events'
              AND column_name = 'idempotency_key'
         ) AS exists`,
      );
      expect(column.rows[0]!.exists).toBe(false);
      const ledger = await client.query<{ count: string }>(
        'SELECT count(*) AS count FROM schema_migrations WHERE filename = $1',
        [file],
      );
      expect(ledger.rows[0]!.count).toBe('0');
    } finally {
      await client.end();
    }
  });
});
