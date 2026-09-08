import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { applyMigrationFile, listMigrations, planMigrations } from '../scripts/migrate.js';

const directory = dirname(fileURLToPath(import.meta.url));
const runnerSource = readFileSync(resolve(directory, '..', 'scripts', 'migrate.ts'), 'utf8');

const V2_TAIL = [
  '0012_v2_end_user_identity.sql',
  '0013_v2_billing.sql',
  '0014_v2_email_login.sql',
  '0015_v2_billing_idempotency.sql',
  '0016_v2_payment_admission.sql',
  '0017_v2_payment_channel.sql',
  '0018_v2_call_attempts.sql',
] as const;

describe('isolated V2 migration runner contract', () => {
  it('reuses only the canonical 0000-0011 prefix before the V2 tail', () => {
    const canonical = listMigrations();
    const v2 = listMigrations('v2');

    expect(canonical.at(-1)).toBe('0019_pending_usage_recovery.sql');
    expect(v2).toEqual([...canonical.slice(0, 12), ...V2_TAIL]);
    expect(v2.at(-1)).toBe('0018_v2_call_attempts.sql');
    expect(v2).not.toContain('0012_agent_builder_v1.sql');
  });

  it('accepts the deployed V2 ledger and plans only its missing suffix', () => {
    const v2 = listMigrations('v2');
    const sharedPrefix = v2.slice(0, 12);
    const deployedThroughIdempotency = v2.filter((name) => Number(name.slice(0, 4)) <= 15);

    expect(planMigrations(v2, sharedPrefix, '0018_v2_call_attempts.sql').pending).toEqual(V2_TAIL);
    expect(
      planMigrations(v2, deployedThroughIdempotency, '0018_v2_call_attempts.sql').pending,
    ).toEqual([
      '0016_v2_payment_admission.sql',
      '0017_v2_payment_channel.sql',
      '0018_v2_call_attempts.sql',
    ]);
    expect(planMigrations(v2, v2.slice(0, -1), '0018_v2_call_attempts.sql').pending).toEqual([
      '0018_v2_call_attempts.sql',
    ]);
    expect(planMigrations(v2, v2, '0018_v2_call_attempts.sql').pending).toEqual([]);
  });

  it('snapshots cluster-global roles only after acquiring the database migration lock', () => {
    const lock = runnerSource.indexOf("await client.query('SELECT pg_advisory_lock($1)'");
    const snapshot = runnerSource.indexOf(
      'preexistingV2Roles = await v2RoleModule.snapshotExistingV2ApplicationRoles(client)',
    );
    expect(lock).toBeGreaterThan(0);
    expect(snapshot).toBeGreaterThan(lock);
  });

  it('restores role login inside the migration transaction and rolls back restoration failure', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    await applyMigrationFile(
      { query } as never,
      '0008_application_database_roles.sql',
      'ALTER ROLE combo_api NOLOGIN',
      async () => {
        await query('ALTER ROLE combo_api LOGIN');
      },
    );
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'ALTER ROLE combo_api NOLOGIN',
      'ALTER ROLE combo_api LOGIN',
      'INSERT INTO schema_migrations(filename) VALUES ($1)',
      'COMMIT',
    ]);

    query.mockClear();
    await expect(
      applyMigrationFile(
        { query } as never,
        '0008_application_database_roles.sql',
        'ALTER ROLE combo_api NOLOGIN',
        async () => {
          throw new Error('role restore failed');
        },
      ),
    ).rejects.toThrow(/migration 0008_application_database_roles\.sql failed/);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'ALTER ROLE combo_api NOLOGIN',
      'ROLLBACK',
    ]);
  });
});
