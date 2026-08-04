import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
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
  const owner = new Client({ connectionString: databaseUrl });

  beforeAll(async () => {
    await owner.connect();
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
    await Promise.all([owner.end(), ...[...clients.values()].map((client) => client.end())]);
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
        'updated_at',
      ),
    ).toBe(false);
    expect(
      await privilege(
        runtime,
        'has_column_privilege',
        'public.capabilities',
        'UPDATE',
        'storage_key',
      ),
    ).toBe(false);

    await expect(
      runtime.query(
        `UPDATE capabilities
            SET ui_artifact_id = ui_artifact_id
          WHERE false`,
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(
      runtime.query(
        `UPDATE capabilities
            SET updated_at = now()
          WHERE false`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('separates recharge handling from Runtime usage charging', async () => {
    const api = clients.get('combo_api')!;
    const worker = clients.get('combo_worker')!;
    const runtime = clients.get('combo_runtime')!;

    for (const action of ['SELECT', 'INSERT']) {
      expect(await privilege(api, 'has_table_privilege', 'public.recharge_orders', action)).toBe(
        true,
      );
    }
    expect(
      await privilege(
        api,
        'has_column_privilege',
        'public.recharge_orders',
        'UPDATE',
        'payment_status',
      ),
    ).toBe(true);
    for (const immutableColumn of ['payment_method', 'pay_trace_no', 'pay_time', 'amount_cents']) {
      expect(
        await privilege(
          api,
          'has_column_privilege',
          'public.recharge_orders',
          'UPDATE',
          immutableColumn,
        ),
        `recharge_orders.${immutableColumn} API UPDATE`,
      ).toBe(false);
    }
    expect(
      await privilege(runtime, 'has_table_privilege', 'public.recharge_orders', 'SELECT'),
    ).toBe(false);

    for (const table of [
      'billing_accounts',
      'billing_free_allowances',
      'usage_charges',
      'wallet_ledger',
    ]) {
      expect(
        await privilege(worker, 'has_table_privilege', `public.${table}`, 'SELECT'),
        `${table} worker SELECT`,
      ).toBe(false);
    }

    expect(
      await privilege(
        runtime,
        'has_column_privilege',
        'public.billing_accounts',
        'UPDATE',
        'reserved_cents',
      ),
    ).toBe(true);
    expect(
      await privilege(
        api,
        'has_column_privilege',
        'public.billing_accounts',
        'UPDATE',
        'reserved_cents',
      ),
    ).toBe(false);
    expect(
      await privilege(
        runtime,
        'has_column_privilege',
        'public.billing_free_allowances',
        'UPDATE',
        'free_used_count',
      ),
    ).toBe(true);
    expect(
      await privilege(api, 'has_table_privilege', 'public.billing_free_allowances', 'UPDATE'),
    ).toBe(false);
    expect(
      await privilege(runtime, 'has_column_privilege', 'public.usage_charges', 'UPDATE', 'status'),
    ).toBe(true);
    expect(await privilege(api, 'has_table_privilege', 'public.usage_charges', 'UPDATE')).toBe(
      false,
    );
  });

  it('allows only appends to the wallet ledger', async () => {
    const api = clients.get('combo_api')!;
    const worker = clients.get('combo_worker')!;
    const runtime = clients.get('combo_runtime')!;

    for (const client of [api, runtime]) {
      expect(await privilege(client, 'has_table_privilege', 'public.wallet_ledger', 'SELECT')).toBe(
        true,
      );
      expect(await privilege(client, 'has_table_privilege', 'public.wallet_ledger', 'INSERT')).toBe(
        true,
      );
      expect(await privilege(client, 'has_table_privilege', 'public.wallet_ledger', 'UPDATE')).toBe(
        false,
      );
      expect(await privilege(client, 'has_table_privilege', 'public.wallet_ledger', 'DELETE')).toBe(
        false,
      );
    }
    expect(await privilege(worker, 'has_table_privilege', 'public.wallet_ledger', 'INSERT')).toBe(
      false,
    );
  });

  it('enforces balanced, source-bound recharge and usage transitions under real app roles', async () => {
    const api = clients.get('combo_api')!;
    const runtime = clients.get('combo_runtime')!;
    const suffix = randomUUID()
      .replaceAll('-', '')
      .replaceAll('0', 'a')
      .replaceAll('1', 'b')
      .replaceAll('8', 'c')
      .replaceAll('9', 'd')
      .slice(0, 8);
    const seeded = await owner.query<{
      user_id: string;
      capability_id: string;
      session_id: string;
      turn_id: string;
    }>(
      `WITH seeded_user AS (
         INSERT INTO users (account)
         VALUES ($1)
         RETURNING id
       ), seeded_task AS (
         INSERT INTO tasks (owner_user_id, idempotency_key)
         SELECT id, $2 FROM seeded_user
         RETURNING id, owner_user_id
       ), seeded_capability AS (
         INSERT INTO capabilities (task_id, owner_user_id, name, storage_key)
         SELECT id, owner_user_id, 'billing role contract', $3 FROM seeded_task
         RETURNING id, owner_user_id
       ), seeded_session AS (
         INSERT INTO sessions (capability_id, owner_user_id)
         SELECT id, owner_user_id FROM seeded_capability
         RETURNING id, capability_id, owner_user_id
       ), seeded_turn AS (
         INSERT INTO turns (id, session_id, status)
         SELECT $4, id, 'running' FROM seeded_session
         RETURNING id, session_id
       )
       SELECT
         seeded_session.owner_user_id AS user_id,
         seeded_session.capability_id,
         seeded_session.id AS session_id,
         seeded_turn.id AS turn_id
       FROM seeded_session
       JOIN seeded_turn ON seeded_turn.session_id = seeded_session.id`,
      [`creator-${suffix}`, `billing-role-${suffix}`, `billing-role/${suffix}`, randomUUID()],
    );
    const chain = seeded.rows[0]!;

    const recharge = await api.query<{ id: string; created_at: Date }>(
      `INSERT INTO recharge_orders (
         order_no, owner_user_id, client_idempotency_key, package_id, amount_cents,
         payment_method, gateway_environment, institution_no, merchant_no,
         pay_trace_no, pay_time
       )
       VALUES ($1, $2, $3, 'test-100', 100, 'h5', 'test', 'inst-a', 'merchant-a', $4,
               '20260801120000')
       RETURNING id, created_at`,
      [`recharge-${suffix}`, chain.user_id, `recharge-intent-${suffix}`, `trace-${suffix}`],
    );
    const order = recharge.rows[0]!;

    await api.query('BEGIN');
    try {
      await api.query(
        `UPDATE recharge_orders
            SET payment_status = 'succeeded', platform_trade_no = $2,
                paid_at = $3::timestamptz - interval '1 second', updated_at = now()
          WHERE id = $1`,
        [order.id, `trade-${suffix}`, order.created_at],
      );
      await api.query(
        `INSERT INTO billing_accounts (owner_user_id, balance_cents)
         VALUES ($1, 100)`,
        [chain.user_id],
      );
      await api.query(
        `INSERT INTO wallet_ledger
           (owner_user_id, entry_type, amount_cents, recharge_order_id, usage_charge_id)
         VALUES ($1, 'recharge_credit', 100, $2, NULL)`,
        [chain.user_id, order.id],
      );
      await api.query(
        `UPDATE recharge_orders
            SET credit_status = 'credited', credited_at = now(), updated_at = now()
          WHERE id = $1`,
        [order.id],
      );
      await api.query('COMMIT');
    } catch (error) {
      await api.query('ROLLBACK');
      throw error;
    }

    const usageId = randomUUID();
    let usageChargeId: string | undefined;
    await runtime.query('BEGIN');
    try {
      await runtime.query(
        `UPDATE billing_accounts
            SET balance_cents = balance_cents - 100,
                reserved_cents = reserved_cents + 100,
                updated_at = now()
          WHERE owner_user_id = $1`,
        [chain.user_id],
      );
      const charge = await runtime.query<{ id: string }>(
        `INSERT INTO usage_charges (
           owner_user_id, usage_id, capability_id, session_id, turn_id,
           request_fingerprint, charge_source, status, unit_price_cents,
           free_limit_snapshot, reserved_cents, settled_cents
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'wallet', 'reserved', 100, 3, 100, 0)
         RETURNING id`,
        [
          chain.user_id,
          usageId,
          chain.capability_id,
          chain.session_id,
          chain.turn_id,
          'a'.repeat(64),
        ],
      );
      usageChargeId = charge.rows[0]!.id;
      await runtime.query('COMMIT');
    } catch (error) {
      await runtime.query('ROLLBACK');
      throw error;
    }

    await runtime.query('BEGIN');
    try {
      await runtime.query(
        `UPDATE billing_accounts
            SET reserved_cents = reserved_cents - 100, updated_at = now()
          WHERE owner_user_id = $1`,
        [chain.user_id],
      );
      await runtime.query(
        `INSERT INTO wallet_ledger
           (owner_user_id, entry_type, amount_cents, recharge_order_id, usage_charge_id)
         VALUES ($1, 'usage_debit', -100, NULL, $2)`,
        [chain.user_id, usageChargeId],
      );
      await runtime.query(
        `UPDATE usage_charges
            SET status = 'completed', settled_cents = 100,
                finished_at = now(), updated_at = now()
          WHERE id = $1`,
        [usageChargeId],
      );
      await runtime.query('COMMIT');
    } catch (error) {
      await runtime.query('ROLLBACK');
      throw error;
    }

    const balanced = await owner.query<{
      balance_cents: string;
      reserved_cents: string;
      ledger_total: string;
      entries: string;
    }>(
      `SELECT a.balance_cents::text, a.reserved_cents::text,
              COALESCE(sum(l.amount_cents), 0)::text AS ledger_total,
              count(l.id)::text AS entries
         FROM billing_accounts a
         LEFT JOIN wallet_ledger l ON l.owner_user_id = a.owner_user_id
        WHERE a.owner_user_id = $1
        GROUP BY a.owner_user_id`,
      [chain.user_id],
    );
    expect(balanced.rows[0]).toEqual({
      balance_cents: '0',
      reserved_cents: '0',
      ledger_total: '0',
      entries: '2',
    });

    const uncredited = await api.query<{ id: string }>(
      `INSERT INTO recharge_orders (
         order_no, owner_user_id, client_idempotency_key, package_id, amount_cents,
         payment_method, gateway_environment, institution_no, merchant_no,
         pay_trace_no, pay_time
       )
       VALUES ($1, $2, $3, 'test-100', 100, 'h5', 'test', 'inst-a', 'merchant-a', $4,
               '20260801120001')
       RETURNING id`,
      [
        `uncredited-${suffix}`,
        chain.user_id,
        `uncredited-intent-${suffix}`,
        `uncredited-trace-${suffix}`,
      ],
    );
    const uncreditedOrderId = uncredited.rows[0]!.id;

    await api.query('BEGIN');
    await api.query(
      `UPDATE recharge_orders
          SET payment_status = 'succeeded', credit_status = 'credited',
              platform_trade_no = $2, paid_at = now(), credited_at = now(), updated_at = now()
        WHERE id = $1`,
      [uncreditedOrderId, `uncredited-trade-${suffix}`],
    );
    await expect(api.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toMatchObject({
      code: '23514',
    });
    await api.query('ROLLBACK');

    await api.query('BEGIN');
    await api.query(
      `UPDATE billing_accounts
          SET balance_cents = balance_cents + 100, updated_at = now()
        WHERE owner_user_id = $1`,
      [chain.user_id],
    );
    await api.query(
      `INSERT INTO wallet_ledger
         (owner_user_id, entry_type, amount_cents, recharge_order_id, usage_charge_id)
       VALUES ($1, 'recharge_credit', 100, $2, NULL)`,
      [chain.user_id, uncreditedOrderId],
    );
    await expect(api.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toMatchObject({
      code: '23514',
    });
    await api.query('ROLLBACK');

    await expect(
      api.query(
        `UPDATE billing_accounts
            SET balance_cents = balance_cents + 1, updated_at = now()
          WHERE owner_user_id = $1`,
        [chain.user_id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      api.query(
        `INSERT INTO wallet_ledger
           (owner_user_id, entry_type, amount_cents, recharge_order_id, usage_charge_id)
         VALUES ($1, 'recharge_refund', -100, $2, NULL)`,
        [chain.user_id, order.id],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runtime.query(
        `INSERT INTO wallet_ledger
           (owner_user_id, entry_type, amount_cents, recharge_order_id, usage_charge_id)
         VALUES ($1, 'usage_compensation', 100, NULL, $2)`,
        [chain.user_id, usageChargeId],
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      owner.query(`UPDATE wallet_ledger SET amount_cents = amount_cents WHERE owner_user_id = $1`, [
        chain.user_id,
      ]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      owner.query(`DELETE FROM wallet_ledger WHERE owner_user_id = $1`, [chain.user_id]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(owner.query('TRUNCATE wallet_ledger')).rejects.toMatchObject({ code: '55000' });
  });

  it('scopes platform trade uniqueness to one environment, institution, and merchant', async () => {
    const api = clients.get('combo_api')!;
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const user = await owner.query<{ id: string }>(
      `INSERT INTO users (account)
       VALUES ($1)
       RETURNING id`,
      [
        `creator-${suffix
          .replaceAll('0', 'a')
          .replaceAll('1', 'b')
          .replaceAll('8', 'c')
          .replaceAll('9', 'd')
          .slice(0, 8)}`,
      ],
    );
    const ownerUserId = user.rows[0]!.id;
    const insertOrder = (merchant: string, trace: string) =>
      api.query(
        `INSERT INTO recharge_orders (
           order_no, owner_user_id, client_idempotency_key, package_id, amount_cents,
           payment_method, gateway_environment, institution_no, merchant_no,
           pay_trace_no, pay_time, platform_trade_no
         )
         VALUES ($1, $2, $3, 'test-100', 100, 'qr', 'test', 'inst-a', $4,
                 $5, '20260801120000', $6)`,
        [`order-${trace}`, ownerUserId, `intent-${trace}`, merchant, trace, `shared-${suffix}`],
      );

    await expect(insertOrder('merchant-a', `trace-a-${suffix}`)).resolves.toMatchObject({
      rowCount: 1,
    });
    await expect(insertOrder('merchant-b', `trace-b-${suffix}`)).resolves.toMatchObject({
      rowCount: 1,
    });
    await expect(insertOrder('merchant-a', `trace-c-${suffix}`)).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('lets a free completion commit while another free reservation holds the account lock', async () => {
    const runtime = clients.get('combo_runtime')!;
    const runtimePeer = new Client({ connectionString: roleConnectionString('combo_runtime') });
    await runtimePeer.connect();
    const rawSuffix = randomUUID().replaceAll('-', '');
    const accountSuffix = rawSuffix
      .replaceAll('0', 'a')
      .replaceAll('1', 'b')
      .replaceAll('8', 'c')
      .replaceAll('9', 'd')
      .slice(0, 8);
    const seeded = await owner.query<{
      owner_user_id: string;
      capability_id: string;
      charge_id: string;
    }>(
      `WITH seeded_user AS (
           INSERT INTO users (account)
           VALUES ($1)
           RETURNING id
         ), seeded_task AS (
           INSERT INTO tasks (owner_user_id, idempotency_key)
           SELECT id, $2 FROM seeded_user
           RETURNING id, owner_user_id
         ), seeded_capability AS (
           INSERT INTO capabilities (task_id, owner_user_id, name, storage_key)
           SELECT id, owner_user_id, 'free concurrency contract', $3 FROM seeded_task
           RETURNING id, owner_user_id
         ), seeded_session AS (
           INSERT INTO sessions (capability_id, owner_user_id)
           SELECT id, owner_user_id FROM seeded_capability
           RETURNING id, capability_id, owner_user_id
         ), seeded_turn AS (
           INSERT INTO turns (id, session_id, status)
           SELECT $4, id, 'running' FROM seeded_session
           RETURNING id, session_id
         ), seeded_account AS (
           INSERT INTO billing_accounts (owner_user_id)
           SELECT owner_user_id FROM seeded_session
           RETURNING owner_user_id
         ), seeded_allowance AS (
           INSERT INTO billing_free_allowances (
             owner_user_id, capability_id, policy_version, free_limit_snapshot,
             free_used_count, free_reserved_count
           )
           SELECT seeded_account.owner_user_id, seeded_session.capability_id,
                  'fixed-v1', 3, 0, 1
             FROM seeded_account
             JOIN seeded_session
               ON seeded_session.owner_user_id = seeded_account.owner_user_id
           RETURNING owner_user_id, capability_id
         ), seeded_charge AS (
           INSERT INTO usage_charges (
             owner_user_id, usage_id, capability_id, session_id, turn_id,
             request_fingerprint, charge_source, status, unit_price_cents,
             free_limit_snapshot, reserved_cents, settled_cents
           )
           SELECT seeded_allowance.owner_user_id, $5, seeded_allowance.capability_id,
                  seeded_session.id, seeded_turn.id, $6, 'free', 'reserved', 100, 3, 0, 0
             FROM seeded_allowance
             JOIN seeded_session
               ON seeded_session.owner_user_id = seeded_allowance.owner_user_id
              AND seeded_session.capability_id = seeded_allowance.capability_id
             JOIN seeded_turn ON seeded_turn.session_id = seeded_session.id
           RETURNING id, owner_user_id, capability_id
         )
         SELECT owner_user_id, capability_id, id AS charge_id FROM seeded_charge`,
      [
        `creator-${accountSuffix}`,
        `free-concurrency-${rawSuffix}`,
        `free-concurrency/${rawSuffix}`,
        randomUUID(),
        randomUUID(),
        'b'.repeat(64),
      ],
    );
    const chain = seeded.rows[0]!;
    let runtimeInTransaction = false;
    let peerInTransaction = false;

    try {
      const runtimePid = await runtime.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await runtime.query('BEGIN');
      runtimeInTransaction = true;
      await runtime.query(`SELECT 1 FROM billing_accounts WHERE owner_user_id = $1 FOR UPDATE`, [
        chain.owner_user_id,
      ]);

      await runtimePeer.query('BEGIN');
      peerInTransaction = true;
      await runtimePeer.query(`SELECT 1 FROM usage_charges WHERE id = $1 FOR UPDATE`, [
        chain.charge_id,
      ]);
      await runtimePeer.query(
        `UPDATE billing_free_allowances
              SET free_reserved_count = free_reserved_count - 1,
                  free_used_count = free_used_count + 1,
                  updated_at = now()
            WHERE owner_user_id = $1 AND capability_id = $2`,
        [chain.owner_user_id, chain.capability_id],
      );
      await runtimePeer.query(
        `UPDATE usage_charges
              SET status = 'completed', finished_at = now(), updated_at = now()
            WHERE id = $1`,
        [chain.charge_id],
      );

      const waitingAllowanceUpdate = runtime.query(
        `UPDATE billing_free_allowances
              SET free_reserved_count = free_reserved_count + 1, updated_at = now()
            WHERE owner_user_id = $1 AND capability_id = $2`,
        [chain.owner_user_id, chain.capability_id],
      );
      let observedLockWait = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const activity = await owner.query<{ waiting: boolean }>(
          `SELECT wait_event_type = 'Lock' AS waiting
               FROM pg_stat_activity
              WHERE pid = $1`,
          [runtimePid.rows[0]!.pid],
        );
        if (activity.rows[0]?.waiting === true) {
          observedLockWait = true;
          break;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      expect(observedLockWait).toBe(true);

      await Promise.all([runtimePeer.query('COMMIT'), waitingAllowanceUpdate]);
      peerInTransaction = false;
      await runtime.query('ROLLBACK');
      runtimeInTransaction = false;

      const finalState = await owner.query<{
        free_used_count: number;
        free_reserved_count: number;
        status: string;
      }>(
        `SELECT a.free_used_count, a.free_reserved_count, c.status
             FROM billing_free_allowances a
             JOIN usage_charges c
               ON c.owner_user_id = a.owner_user_id
              AND c.capability_id = a.capability_id
            WHERE c.id = $1`,
        [chain.charge_id],
      );
      expect(finalState.rows[0]).toEqual({
        free_used_count: 1,
        free_reserved_count: 0,
        status: 'completed',
      });

      await owner.query('BEGIN');
      await owner.query(`UPDATE usage_charges SET charge_source = 'owner' WHERE id = $1`, [
        chain.charge_id,
      ]);
      await expect(owner.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toMatchObject({
        code: '23514',
      });
      await owner.query('ROLLBACK');
    } finally {
      if (runtimeInTransaction) await runtime.query('ROLLBACK');
      if (peerInTransaction) await runtimePeer.query('ROLLBACK');
      await runtimePeer.end();
    }
  }, 10_000);
});
