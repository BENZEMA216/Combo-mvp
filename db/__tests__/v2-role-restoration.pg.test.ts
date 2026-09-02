import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrationFile } from '../scripts/migrate.js';
import {
  restoreV2RoleLoginsWithinMigration,
  snapshotExistingV2ApplicationRoles,
} from '../scripts/provision-v2-app-roles.js';

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.APPLICATION_V2_ROLE_PG_TEST === '1' && Boolean(databaseUrl);
const pgDescribe = enabled ? describe : describe.skip;

pgDescribe('V2 migration role restoration transaction', () => {
  let migrationClient: Client;
  let observer: Client;
  let preexistingRoles: Set<string>;

  beforeAll(async () => {
    migrationClient = new Client({ connectionString: databaseUrl });
    observer = new Client({ connectionString: databaseUrl });
    await Promise.all([migrationClient.connect(), observer.connect()]);
    preexistingRoles = await snapshotExistingV2ApplicationRoles(migrationClient);
  });

  afterAll(async () => {
    await Promise.all([migrationClient?.end(), observer?.end()]);
  });

  async function canLogin(role: string): Promise<boolean> {
    const result = await observer.query<{ rolcanlogin: boolean }>(
      'SELECT rolcanlogin FROM pg_roles WHERE rolname = $1',
      [role],
    );
    return result.rows[0]?.rolcanlogin === true;
  }

  async function passwordHash(role: string): Promise<string | null> {
    const result = await observer.query<{ rolpassword: string | null }>(
      'SELECT rolpassword FROM pg_authid WHERE rolname = $1',
      [role],
    );
    return result.rows[0]?.rolpassword ?? null;
  }

  it('never exposes NOLOGIN and rolls it back when restoration fails', async () => {
    expect(await canLogin('combo_api')).toBe(true);
    const passwordBefore = await passwordHash('combo_api');
    await expect(
      applyMigrationFile(
        migrationClient,
        'fault_injection.sql',
        'ALTER ROLE combo_api NOLOGIN',
        async () => {
          expect(await canLogin('combo_api')).toBe(true);
          throw new Error('injected failure after NOLOGIN');
        },
      ),
    ).rejects.toThrow(/injected failure after NOLOGIN/);
    expect(await canLogin('combo_api')).toBe(true);
    expect(await passwordHash('combo_api')).toBe(passwordBefore);
  });

  it('restores a pre-existing role LOGIN without changing its password hash', async () => {
    const passwordBefore = await passwordHash('combo_api');
    await migrationClient.query('BEGIN');
    try {
      await migrationClient.query('ALTER ROLE combo_api NOLOGIN');
      expect(await canLogin('combo_api')).toBe(true);
      await restoreV2RoleLoginsWithinMigration(
        migrationClient,
        '0008_application_database_roles.sql',
        preexistingRoles,
      );
      await migrationClient.query('COMMIT');
    } catch (error) {
      await migrationClient.query('ROLLBACK');
      throw error;
    }
    expect(await canLogin('combo_api')).toBe(true);
    expect(await passwordHash('combo_api')).toBe(passwordBefore);
  });
});
