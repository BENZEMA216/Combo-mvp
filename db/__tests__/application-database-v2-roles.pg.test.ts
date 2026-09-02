import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PASSWORD_KEYS = {
  combo_api: 'POSTGRES_API_PASSWORD',
  combo_worker: 'POSTGRES_WORKER_PASSWORD',
  combo_runtime: 'POSTGRES_RUNTIME_PASSWORD',
  combo_authz: 'POSTGRES_AUTHZ_PASSWORD',
  combo_billing: 'POSTGRES_BILLING_PASSWORD',
} as const;

type ApplicationRole = keyof typeof PASSWORD_KEYS;

const databaseUrl = process.env.DATABASE_URL;
const enabled =
  process.env.APPLICATION_V2_ROLE_PG_TEST === '1' &&
  Boolean(databaseUrl) &&
  Object.values(PASSWORD_KEYS).every((key) => Boolean(process.env[key]));
const pgDescribe = enabled ? describe : describe.skip;

function roleConnectionString(role: ApplicationRole): string {
  const url = new URL(databaseUrl!);
  url.username = role;
  url.password = process.env[PASSWORD_KEYS[role]]!;
  return url.toString();
}

async function tablePrivilege(
  client: Client,
  relation: string,
  privilegeName: string,
): Promise<boolean> {
  const result = await client.query<{ allowed: boolean }>(
    'SELECT has_table_privilege(current_user, $1, $2) AS allowed',
    [relation, privilegeName],
  );
  return result.rows[0]?.allowed === true;
}

async function columnPrivilege(
  client: Client,
  relation: string,
  column: string,
  privilegeName: string,
): Promise<boolean> {
  const result = await client.query<{ allowed: boolean }>(
    'SELECT has_column_privilege(current_user, $1, $2, $3) AS allowed',
    [relation, column, privilegeName],
  );
  return result.rows[0]?.allowed === true;
}

pgDescribe('isolated V2 application roles on PostgreSQL', () => {
  const clients = new Map<ApplicationRole, Client>();

  beforeAll(async () => {
    for (const role of Object.keys(PASSWORD_KEYS) as ApplicationRole[]) {
      const client = new Client({
        connectionString: roleConnectionString(role),
        application_name: `combo-v2-role-contract-${role}`,
      });
      await client.connect();
      clients.set(role, client);
    }
  });

  afterAll(async () => {
    await Promise.all([...clients.values()].map((client) => client.end()));
  });

  it('allows all five constrained roles to log in under their exact identity', async () => {
    for (const [role, client] of clients) {
      const result = await client.query<{ current_user: string; can_login: boolean }>(
        `SELECT current_user, rolcanlogin AS can_login
           FROM pg_roles
          WHERE rolname = current_user`,
      );
      expect(result.rows[0]).toEqual({ current_user: role, can_login: true });
    }
  });

  it('gives authz least privilege and keeps canonical roles out of V2 identity tables', async () => {
    const authz = clients.get('combo_authz')!;
    for (const action of ['SELECT', 'INSERT']) {
      expect(await tablePrivilege(authz, 'public.v2_users', action)).toBe(true);
      expect(await tablePrivilege(authz, 'public.v2_identities', action)).toBe(true);
    }
    for (const table of ['v2_auth_challenges', 'v2_sessions']) {
      for (const action of ['SELECT', 'INSERT', 'UPDATE']) {
        expect(await tablePrivilege(authz, `public.${table}`, action), `${table} ${action}`).toBe(
          true,
        );
      }
    }
    for (const table of ['v2_users', 'v2_identities', 'v2_auth_challenges', 'v2_sessions']) {
      expect(await tablePrivilege(authz, `public.${table}`, 'DELETE')).toBe(false);
      for (const role of ['combo_api', 'combo_worker', 'combo_runtime'] as const) {
        expect(await tablePrivilege(clients.get(role)!, `public.${table}`, 'SELECT')).toBe(false);
      }
    }
  });

  it('keeps V2 ledger and metering append-only and hidden from other roles', async () => {
    const billing = clients.get('combo_billing')!;
    expect(await tablePrivilege(billing, 'public.v2_users', 'SELECT')).toBe(false);
    expect(await columnPrivilege(billing, 'public.v2_users', 'id', 'SELECT')).toBe(true);
    expect(await columnPrivilege(billing, 'public.v2_users', 'created_at', 'SELECT')).toBe(false);
    for (const table of ['v2_ledger', 'v2_metering_events']) {
      expect(await tablePrivilege(billing, `public.${table}`, 'SELECT')).toBe(true);
      expect(await tablePrivilege(billing, `public.${table}`, 'INSERT')).toBe(true);
      expect(await tablePrivilege(billing, `public.${table}`, 'UPDATE')).toBe(false);
      expect(await tablePrivilege(billing, `public.${table}`, 'DELETE')).toBe(false);
    }
    for (const table of ['v2_wallets', 'v2_orders', 'v2_packages']) {
      for (const action of ['SELECT', 'INSERT', 'UPDATE']) {
        expect(await tablePrivilege(billing, `public.${table}`, action)).toBe(true);
      }
      expect(await tablePrivilege(billing, `public.${table}`, 'DELETE')).toBe(false);
    }
    expect(await tablePrivilege(billing, 'public.v2_holds', 'SELECT')).toBe(true);
    expect(await tablePrivilege(billing, 'public.v2_holds', 'INSERT')).toBe(true);
    expect(await tablePrivilege(billing, 'public.v2_holds', 'UPDATE')).toBe(false);
    expect(await tablePrivilege(billing, 'public.v2_holds', 'DELETE')).toBe(false);
    for (const column of ['status', 'actual_amount', 'settled_at']) {
      expect(await columnPrivilege(billing, 'public.v2_holds', column, 'UPDATE')).toBe(true);
    }
    for (const column of ['user_id', 'agent_id', 'turn_id', 'estimated_amount', 'expires_at']) {
      expect(await columnPrivilege(billing, 'public.v2_holds', column, 'UPDATE')).toBe(false);
    }
    for (const role of ['combo_api', 'combo_worker', 'combo_runtime', 'combo_authz'] as const) {
      expect(await tablePrivilege(clients.get(role)!, 'public.v2_ledger', 'SELECT')).toBe(false);
    }
  });
});
