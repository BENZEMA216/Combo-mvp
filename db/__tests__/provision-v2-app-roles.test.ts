import type { Client } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertV2ApplicationRolePasswords,
  provisionV2ApplicationRoleLogins,
  restoreV2RoleLoginsWithinMigration,
} from '../scripts/provision-v2-app-roles.js';

const PASSWORD_KEYS = [
  'POSTGRES_API_PASSWORD',
  'POSTGRES_WORKER_PASSWORD',
  'POSTGRES_RUNTIME_PASSWORD',
  'POSTGRES_AUTHZ_PASSWORD',
  'POSTGRES_BILLING_PASSWORD',
] as const;

afterEach(() => {
  for (const key of PASSWORD_KEYS) delete process.env[key];
});

function clientDouble() {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('SELECT format(')) {
      const role = sql.match(/ALTER ROLE (combo_[a-z]+)/)?.[1];
      return { rows: [{ statement: `ALTER ROLE ${role} LOGIN PASSWORD '<server-formatted>'` }] };
    }
    return { rows: [], rowCount: 0, values };
  });
  return { query } as unknown as Client & { query: typeof query };
}

describe('V2 application database role login provisioning', () => {
  it('rejects an empty five-role password set before issuing SQL', async () => {
    const client = clientDouble();
    expect(() => assertV2ApplicationRolePasswords()).toThrow(
      /POSTGRES_API_PASSWORD, POSTGRES_WORKER_PASSWORD, POSTGRES_RUNTIME_PASSWORD, POSTGRES_AUTHZ_PASSWORD, POSTGRES_BILLING_PASSWORD/,
    );
    await expect(provisionV2ApplicationRoleLogins(client)).rejects.toThrow(/配置不完整/);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('rejects a partial five-role password set before issuing SQL', async () => {
    process.env.POSTGRES_API_PASSWORD = 'api-only-secret';
    const client = clientDouble();
    await expect(provisionV2ApplicationRoleLogins(client)).rejects.toThrow(
      /POSTGRES_WORKER_PASSWORD, POSTGRES_RUNTIME_PASSWORD, POSTGRES_AUTHZ_PASSWORD, POSTGRES_BILLING_PASSWORD/,
    );
    expect(client.query).not.toHaveBeenCalled();
  });

  it('binds all five passwords without interpolating or logging them', async () => {
    process.env.POSTGRES_API_PASSWORD = "api-'secret";
    process.env.POSTGRES_WORKER_PASSWORD = 'worker-secret';
    process.env.POSTGRES_RUNTIME_PASSWORD = 'runtime-secret';
    process.env.POSTGRES_AUTHZ_PASSWORD = 'authz-secret';
    process.env.POSTGRES_BILLING_PASSWORD = 'billing-secret';
    const client = clientDouble();

    await expect(provisionV2ApplicationRoleLogins(client)).resolves.toBe(true);

    const formatCalls = client.query.mock.calls.filter(([sql]) =>
      String(sql).includes('SELECT format('),
    );
    expect(formatCalls.map(([, values]) => values)).toEqual([
      ["api-'secret"],
      ['worker-secret'],
      ['runtime-secret'],
      ['authz-secret'],
      ['billing-secret'],
    ]);
    const sqlText = client.query.mock.calls.map(([sql]) => String(sql)).join('\n');
    for (const key of PASSWORD_KEYS) expect(sqlText).not.toContain(process.env[key]);
    expect(client.query.mock.calls.at(0)?.[0]).toBe('BEGIN');
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  });

  it('preserves passwords for cluster-global roles that existed before the V2 run', async () => {
    process.env.POSTGRES_API_PASSWORD = 'wrong-api-value-must-not-be-applied';
    process.env.POSTGRES_WORKER_PASSWORD = 'wrong-worker-value-must-not-be-applied';
    process.env.POSTGRES_RUNTIME_PASSWORD = 'wrong-runtime-value-must-not-be-applied';
    process.env.POSTGRES_AUTHZ_PASSWORD = 'new-authz-secret';
    process.env.POSTGRES_BILLING_PASSWORD = 'new-billing-secret';
    const client = clientDouble();

    await provisionV2ApplicationRoleLogins(
      client,
      new Set(['combo_api', 'combo_worker', 'combo_runtime', 'combo_authz', 'combo_billing']),
    );

    const sql = client.query.mock.calls.map(([statement]) => String(statement));
    for (const role of ['combo_api', 'combo_worker', 'combo_runtime']) {
      expect(sql).toContain(
        `ALTER ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
      );
    }
    const passwordBindings = client.query.mock.calls
      .filter(([statement]) => String(statement).includes('SELECT format('))
      .map(([, values]) => values);
    expect(passwordBindings).toEqual([['new-authz-secret'], ['new-billing-secret']]);
  });

  it('restores each NOLOGIN migration inside its existing transaction', async () => {
    for (const [index, key] of PASSWORD_KEYS.entries()) process.env[key] = `secret-${index}`;
    const client = clientDouble();

    await restoreV2RoleLoginsWithinMigration(client, '0008_application_database_roles.sql');
    await restoreV2RoleLoginsWithinMigration(client, '0012_v2_end_user_identity.sql');
    await restoreV2RoleLoginsWithinMigration(client, '0013_v2_billing.sql');
    await restoreV2RoleLoginsWithinMigration(client, '0015_v2_billing_idempotency.sql');

    const roleSql = client.query.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.startsWith('ALTER ROLE combo_'));
    expect(roleSql).toEqual([
      "ALTER ROLE combo_api LOGIN PASSWORD '<server-formatted>'",
      "ALTER ROLE combo_worker LOGIN PASSWORD '<server-formatted>'",
      "ALTER ROLE combo_runtime LOGIN PASSWORD '<server-formatted>'",
      "ALTER ROLE combo_authz LOGIN PASSWORD '<server-formatted>'",
      "ALTER ROLE combo_billing LOGIN PASSWORD '<server-formatted>'",
    ]);
    expect(client.query.mock.calls.some(([sql]) => sql === 'BEGIN')).toBe(false);
    expect(client.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
  });

  it('replaces PostgreSQL diagnostics with a stable password-free error', async () => {
    for (const [index, key] of PASSWORD_KEYS.entries()) process.env[key] = `secret-${index}`;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT format(')) throw new Error('database rejected a secret');
      return { rows: [], rowCount: 0 };
    });
    const client = { query } as unknown as Client;

    const failure = await provisionV2ApplicationRoleLogins(client).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('[db-v2-roles] V2 应用数据库角色配置失败');
    for (const key of PASSWORD_KEYS) {
      expect((failure as Error).message).not.toContain(process.env[key]);
    }
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
});
