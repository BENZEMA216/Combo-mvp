import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PASSWORD_KEYS = {
  combo_api: 'POSTGRES_API_PASSWORD',
  combo_worker: 'POSTGRES_WORKER_PASSWORD',
  combo_runtime: 'POSTGRES_RUNTIME_PASSWORD',
} as const;
type ApplicationRole = keyof typeof PASSWORD_KEYS;

const databaseUrl = process.env.DATABASE_URL;
const enabled =
  process.env.AGENT_SESSION_RECEIPTS_PG_TEST === '1' &&
  Boolean(databaseUrl) &&
  Object.values(PASSWORD_KEYS).every((key) => Boolean(process.env[key]));
const pgDescribe = enabled ? describe : describe.skip;

function roleConnectionString(role: ApplicationRole): string {
  const url = new URL(databaseUrl!);
  url.username = role;
  url.password = process.env[PASSWORD_KEYS[role]]!;
  return url.toString();
}

pgDescribe('Agent usage receipt PostgreSQL roles', () => {
  const owner = new Client({ connectionString: databaseUrl });
  const clients = new Map<ApplicationRole, Client>();

  beforeAll(async () => {
    await owner.connect();
    for (const role of Object.keys(PASSWORD_KEYS) as ApplicationRole[]) {
      const client = new Client({ connectionString: roleConnectionString(role) });
      await client.connect();
      clients.set(role, client);
    }
  });

  afterAll(async () => {
    await Promise.all([owner.end(), ...[...clients.values()].map((client) => client.end())]);
  });

  it('uses real least-privilege roles and keeps Registry writes with the trusted API only', async () => {
    const api = clients.get('combo_api')!;
    const worker = clients.get('combo_worker')!;
    const runtime = clients.get('combo_runtime')!;
    for (const [role, client] of clients) {
      expect((await client.query<{ current_user: string }>('SELECT current_user')).rows[0]).toEqual(
        {
          current_user: role,
        },
      );
    }

    for (const [role, expected] of [
      ['combo_api', { select: false, insert: false }],
      ['combo_worker', { select: false, insert: false }],
      ['combo_runtime', { select: true, insert: false }],
    ] as const) {
      const privileges = await owner.query<{ can_select: boolean; can_insert: boolean }>(
        `SELECT has_table_privilege($1, 'public.agent_usage_receipts', 'SELECT') AS can_select,
                has_table_privilege($1, 'public.agent_usage_receipts', 'INSERT') AS can_insert`,
        [role],
      );
      expect(privileges.rows[0]).toEqual({
        can_select: expected.select,
        can_insert: expected.insert,
      });
    }
    for (const [role, expected] of [
      ['combo_api', false],
      ['combo_worker', false],
      ['combo_runtime', true],
    ] as const) {
      const privilege = await owner.query<{ allowed: boolean }>(
        `SELECT has_column_privilege(
           $1, 'public.agent_usage_receipts', 'usage_charge_id', 'INSERT'
         ) AS allowed`,
        [role],
      );
      expect(privilege.rows[0]?.allowed, `${role} receipt column INSERT`).toBe(expected);
    }
    for (const protectedColumn of ['id', 'created_at']) {
      const privilege = await owner.query<{ allowed: boolean }>(
        `SELECT has_column_privilege(
           'combo_runtime', 'public.agent_usage_receipts', $1, 'INSERT'
         ) AS allowed`,
        [protectedColumn],
      );
      expect(privilege.rows[0]?.allowed, `Runtime INSERT ${protectedColumn}`).toBe(false);
    }
    expect(
      (
        await owner.query<{ allowed: boolean }>(
          `SELECT has_column_privilege(
             'combo_runtime', 'public.agent_usage_receipts', 'response_message_id', 'INSERT'
           ) AS allowed`,
        )
      ).rows[0]?.allowed,
    ).toBe(true);
    expect(
      (
        await owner.query<{ allowed: boolean }>(
          `SELECT has_column_privilege(
             'combo_runtime', 'public.usage_charges', 'execution_outcome', 'UPDATE'
           ) AS allowed`,
        )
      ).rows[0]?.allowed,
    ).toBe(true);
    expect(
      (
        await owner.query<{ allowed: boolean }>(
          `SELECT has_table_privilege(
             'combo_runtime', 'public.agent_package_releases', 'INSERT'
           ) AS allowed`,
        )
      ).rows[0]?.allowed,
    ).toBe(false);

    for (const functionName of [
      'reject_agent_session_binding_mutation()',
      'reject_knowledge_usage_binding_mutation()',
      'reject_receipted_response_message_mutation()',
      'guard_agent_usage_receipt_write()',
      'enforce_knowledge_usage_receipt_equation()',
    ]) {
      for (const role of Object.keys(PASSWORD_KEYS)) {
        const privilege = await owner.query<{ allowed: boolean }>(
          `SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed`,
          [role, `public.${functionName}`],
        );
        expect(privilege.rows[0]?.allowed, `${role} ${functionName}`).toBe(false);
      }
    }

    await expect(api.query('SELECT id FROM agent_usage_receipts LIMIT 1')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(worker.query('SELECT id FROM agent_usage_receipts LIMIT 1')).rejects.toMatchObject(
      { code: '42501' },
    );
    await expect(
      runtime.query('UPDATE agent_usage_receipts SET created_at = created_at WHERE false'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runtime.query('INSERT INTO agent_usage_receipts (id) VALUES ($1)', [randomUUID()]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runtime.query('INSERT INTO agent_usage_receipts (created_at) VALUES (now())'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runtime.query('SELECT id FROM agent_usage_receipts LIMIT 1'),
    ).resolves.toBeDefined();
  });
});
