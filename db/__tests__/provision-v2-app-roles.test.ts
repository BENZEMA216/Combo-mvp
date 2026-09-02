import type { Client } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { provisionV2ApplicationRoleLogins } from '../scripts/provision-v2-app-roles.js';

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
  it('does nothing when no V2 role password is configured', async () => {
    const client = clientDouble();
    await expect(provisionV2ApplicationRoleLogins(client)).resolves.toBe(false);
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
