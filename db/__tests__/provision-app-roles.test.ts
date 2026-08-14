import type { Client } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { provisionApplicationRoleLogins } from '../scripts/provision-app-roles.js';

const PASSWORD_KEYS = [
  'POSTGRES_API_PASSWORD',
  'POSTGRES_WORKER_PASSWORD',
  'POSTGRES_RUNTIME_PASSWORD',
  'POSTGRES_AGENT_API_PASSWORD',
  'POSTGRES_AGENT_BROKER_PASSWORD',
  'POSTGRES_AGENT_RECONCILER_PASSWORD',
  'POSTGRES_AGENT_CONSUMER_API_PASSWORD',
] as const;

afterEach(() => {
  for (const key of PASSWORD_KEYS) delete process.env[key];
});

function clientDouble() {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('SELECT format(')) {
      const role = sql.match(/ALTER ROLE (combo_[a-z_]+)/)?.[1];
      return { rows: [{ statement: `ALTER ROLE ${role} LOGIN PASSWORD '<server-formatted>'` }] };
    }
    return { rows: [], rowCount: 0, values };
  });
  return { query } as unknown as Client & { query: typeof query };
}

describe('application database role login provisioning', () => {
  it('does nothing when no application role password is configured', async () => {
    const client = clientDouble();

    await expect(provisionApplicationRoleLogins(client)).resolves.toBe(false);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('rejects a partial role password set before issuing SQL', async () => {
    process.env.POSTGRES_API_PASSWORD = 'api-only-secret';
    const client = clientDouble();

    await expect(provisionApplicationRoleLogins(client)).rejects.toThrow(
      /POSTGRES_WORKER_PASSWORD, POSTGRES_RUNTIME_PASSWORD/,
    );
    expect(client.query).not.toHaveBeenCalled();
  });

  it('binds every password as a value and never interpolates it into SQL or errors', async () => {
    process.env.POSTGRES_API_PASSWORD = "api-'secret";
    process.env.POSTGRES_WORKER_PASSWORD = 'worker-secret';
    process.env.POSTGRES_RUNTIME_PASSWORD = 'runtime-secret';
    const client = clientDouble();

    await expect(provisionApplicationRoleLogins(client)).resolves.toBe(true);

    const formatCalls = client.query.mock.calls.filter(([sql]) =>
      String(sql).includes('SELECT format('),
    );
    expect(formatCalls).toHaveLength(3);
    expect(formatCalls.map(([, values]) => values)).toEqual([
      ["api-'secret"],
      ['worker-secret'],
      ['runtime-secret'],
    ]);
    const sqlText = client.query.mock.calls.map(([sql]) => String(sql)).join('\n');
    for (const key of PASSWORD_KEYS) expect(sqlText).not.toContain(process.env[key]);
    expect(client.query.mock.calls.at(0)?.[0]).toBe('BEGIN');
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  });

  it('provisions the three VNext services as a separate complete role group', async () => {
    process.env.POSTGRES_AGENT_API_PASSWORD = 'agent-api-secret';
    process.env.POSTGRES_AGENT_BROKER_PASSWORD = 'agent-broker-secret';
    process.env.POSTGRES_AGENT_RECONCILER_PASSWORD = 'agent-reconciler-secret';
    const client = clientDouble();

    await expect(provisionApplicationRoleLogins(client)).resolves.toBe(true);

    const formatCalls = client.query.mock.calls.filter(([sql]) =>
      String(sql).includes('SELECT format('),
    );
    expect(formatCalls).toHaveLength(3);
    expect(formatCalls.map(([, values]) => values)).toEqual([
      ['agent-api-secret'],
      ['agent-broker-secret'],
      ['agent-reconciler-secret'],
    ]);
    const executed = client.query.mock.calls.map(([sql]) => String(sql));
    for (const role of ['combo_agent_api', 'combo_agent_broker', 'combo_agent_reconciler']) {
      expect(executed).toContain(`ALTER ROLE ${role} LOGIN PASSWORD '<server-formatted>'`);
    }
  });

  it('rejects a partial VNext role group without requiring the legacy group', async () => {
    process.env.POSTGRES_AGENT_API_PASSWORD = 'agent-api-only';
    const client = clientDouble();

    await expect(provisionApplicationRoleLogins(client)).rejects.toThrow(
      /POSTGRES_AGENT_BROKER_PASSWORD, POSTGRES_AGENT_RECONCILER_PASSWORD/,
    );
    expect(client.query).not.toHaveBeenCalled();
  });

  it('provisions the Consumer-only login as an independent enablement boundary', async () => {
    process.env.POSTGRES_AGENT_CONSUMER_API_PASSWORD = 'consumer-api-secret';
    const client = clientDouble();

    await expect(provisionApplicationRoleLogins(client)).resolves.toBe(true);

    const formatCalls = client.query.mock.calls.filter(([sql]) =>
      String(sql).includes('SELECT format('),
    );
    expect(formatCalls).toHaveLength(1);
    expect(formatCalls[0]?.[1]).toEqual(['consumer-api-secret']);
    expect(client.query.mock.calls.map(([sql]) => String(sql))).toContain(
      "ALTER ROLE combo_agent_consumer_api LOGIN PASSWORD '<server-formatted>'",
    );
  });

  it('replaces PostgreSQL diagnostics with a stable error that cannot echo a password', async () => {
    process.env.POSTGRES_API_PASSWORD = 'api-never-echo';
    process.env.POSTGRES_WORKER_PASSWORD = 'worker-never-echo';
    process.env.POSTGRES_RUNTIME_PASSWORD = 'runtime-never-echo';
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT format(')) {
        throw new Error(`database rejected ${process.env.POSTGRES_API_PASSWORD}`);
      }
      return { rows: [], rowCount: 0 };
    });
    const client = { query } as unknown as Client;

    const failure = await provisionApplicationRoleLogins(client).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('[db-roles] 应用数据库角色配置失败');
    for (const key of PASSWORD_KEYS) {
      expect((failure as Error).message).not.toContain(process.env[key]);
    }
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
});
