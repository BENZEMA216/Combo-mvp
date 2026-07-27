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
  process.env.APPLICATION_ROLE_PG_TEST === '1' &&
  Boolean(databaseUrl) &&
  Object.values(PASSWORD_KEYS).every((key) => Boolean(process.env[key]));
const pgDescribe = enabled ? describe : describe.skip;

function roleConnectionString(role: ApplicationRole): string {
  const url = new URL(databaseUrl!);
  url.username = role;
  url.password = process.env[PASSWORD_KEYS[role]]!;
  return url.toString();
}

async function privilege(
  client: Client,
  functionName: 'has_table_privilege' | 'has_column_privilege',
  relation: string,
  privilegeName: string,
  column?: string,
): Promise<boolean> {
  const query =
    functionName === 'has_table_privilege'
      ? `SELECT has_table_privilege(current_user, $1, $2) AS allowed`
      : `SELECT has_column_privilege(current_user, $1, $2, $3) AS allowed`;
  const values = column ? [relation, column, privilegeName] : [relation, privilegeName];
  const result = await client.query<{ allowed: boolean }>(query, values);
  return result.rows[0]?.allowed === true;
}

pgDescribe('application database roles on PostgreSQL', () => {
  const clients = new Map<ApplicationRole, Client>();

  beforeAll(async () => {
    for (const role of Object.keys(PASSWORD_KEYS) as ApplicationRole[]) {
      const client = new Client({
        connectionString: roleConnectionString(role),
        application_name: `combo-role-contract-${role}`,
      });
      await client.connect();
      clients.set(role, client);
    }
  });

  afterAll(async () => {
    await Promise.all([...clients.values()].map((client) => client.end()));
  });

  it('allows all three constrained roles to log in under their exact identity', async () => {
    for (const [role, client] of clients) {
      const result = await client.query<{ current_user: string; can_login: boolean }>(
        `SELECT current_user, rolcanlogin AS can_login
           FROM pg_roles
          WHERE rolname = current_user`,
      );
      expect(result.rows[0]).toEqual({ current_user: role, can_login: true });
    }
  });

  it('keeps authentication writes in the API role and away from worker and Runtime', async () => {
    const api = clients.get('combo_api')!;
    const worker = clients.get('combo_worker')!;
    const runtime = clients.get('combo_runtime')!;

    expect(await privilege(api, 'has_table_privilege', 'public.auth_sessions', 'INSERT')).toBe(
      true,
    );
    expect(await privilege(worker, 'has_table_privilege', 'public.auth_sessions', 'SELECT')).toBe(
      false,
    );
    expect(await privilege(runtime, 'has_table_privilege', 'public.auth_sessions', 'SELECT')).toBe(
      true,
    );
    expect(await privilege(runtime, 'has_table_privilege', 'public.auth_sessions', 'INSERT')).toBe(
      false,
    );
  });

  it('gives Runtime its Session model and only the current UI Capability update', async () => {
    const runtime = clients.get('combo_runtime')!;

    for (const table of ['sessions', 'turns', 'messages', 'artifacts']) {
      for (const action of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect(
          await privilege(runtime, 'has_table_privilege', `public.${table}`, action),
          `${table} ${action}`,
        ).toBe(true);
      }
    }
    expect(await privilege(runtime, 'has_table_privilege', 'public.capabilities', 'SELECT')).toBe(
      true,
    );
    expect(await privilege(runtime, 'has_table_privilege', 'public.capabilities', 'UPDATE')).toBe(
      false,
    );
    expect(
      await privilege(
        runtime,
        'has_column_privilege',
        'public.capabilities',
        'UPDATE',
        'ui_artifact_id',
      ),
    ).toBe(true);
    expect(
      await privilege(
        runtime,
        'has_column_privilege',
        'public.capabilities',
        'UPDATE',
        'storage_key',
      ),
    ).toBe(false);
  });
});
