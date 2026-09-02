import { createHash, randomUUID } from 'node:crypto';
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
  process.env.PENDING_USAGE_RECOVERY_PG_TEST === '1' &&
  Boolean(databaseUrl) &&
  Object.values(PASSWORD_KEYS).every((key) => Boolean(process.env[key]));
const pgDescribe = enabled ? describe : describe.skip;

interface PendingSeed {
  ownerUserId: string;
  usageId: string;
  requestText: string;
}

function roleConnectionString(role: ApplicationRole): string {
  const url = new URL(databaseUrl!);
  url.username = role;
  url.password = process.env[PASSWORD_KEYS[role]]!;
  return url.toString();
}

function digest(label: string): string {
  return `sha256:${createHash('sha256').update(`${label}:${randomUUID()}`).digest('hex')}`;
}

function creatorAccount(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return `creator-${randomUUID()
    .replaceAll('-', '')
    .slice(0, 8)
    .split('')
    .map((character) => alphabet[Number.parseInt(character, 16)]!)
    .join('')}`;
}

async function seedPending(owner: Client, pendingWriter: Client = owner): Promise<PendingSeed> {
  const publisherUserId = (
    await owner.query<{ id: string }>('INSERT INTO users (account) VALUES ($1) RETURNING id', [
      creatorAccount(),
    ])
  ).rows[0]!.id;
  const ownerUserId = (
    await owner.query<{ id: string }>('INSERT INTO users (account) VALUES ($1) RETURNING id', [
      creatorAccount(),
    ])
  ).rows[0]!.id;
  const taskId = (
    await owner.query<{ id: string }>(
      `INSERT INTO tasks (owner_user_id, idempotency_key)
       VALUES ($1, $2) RETURNING id`,
      [publisherUserId, `role-pending-${randomUUID()}`],
    )
  ).rows[0]!.id;
  const capabilityId = (
    await owner.query<{ id: string }>(
      `INSERT INTO capabilities (task_id, owner_user_id, name, kind, storage_key, published)
       VALUES ($1, $2, 'Role Recovery Knowledge', 'knowledge', $3, true)
       RETURNING id`,
      [taskId, publisherUserId, `role-pending/${randomUUID()}`],
    )
  ).rows[0]!.id;
  const packageDigest = digest('role-package');
  const resourceDigest = digest('role-resource');
  const releaseId = `release.agent-package.${randomUUID().replaceAll('-', '')}`;
  await owner.query(
    `INSERT INTO agent_packages (package_digest, protocol, owner_user_id)
     VALUES ($1, 'combo.agent-package/1', $2)`,
    [packageDigest, publisherUserId],
  );
  await owner.query(
    `INSERT INTO agent_package_releases (
       release_id, package_digest, owner_user_id, protocol, release_scope,
       idempotency_key, request_sha256
     ) VALUES ($1, $2, $3, 'combo.agent-package-release/1', 'controlled_test', $4, $5)`,
    [
      releaseId,
      packageDigest,
      publisherUserId,
      randomUUID(),
      createHash('sha256').update(randomUUID()).digest('hex'),
    ],
  );
  const sessionId = (
    await owner.query<{ id: string }>(
      `INSERT INTO sessions (
         capability_id, owner_user_id, mode, product_kind, capability_protocol,
         release_id, package_digest, release_scope,
         knowledge_resource_path, knowledge_resource_digest
       ) VALUES (
         $1, $2, 'consume', 'knowledge_agent_test', 'combo.agent-package-capability/2',
         $3, $4, 'controlled_test',
         'skills/knowledge/references/knowledge-bundle.json', $5
       ) RETURNING id`,
      [capabilityId, ownerUserId, releaseId, packageDigest, resourceDigest],
    )
  ).rows[0]!.id;
  const usageId = randomUUID();
  const requestText = '这个正文只允许 Runtime 读取。';
  await pendingWriter.query(
    `INSERT INTO pending_usage_recoveries (
       owner_user_id, usage_id, session_id, capability_id,
       request_text, request_fingerprint, product_kind, capability_protocol,
       release_id, package_digest, release_scope,
       knowledge_resource_path, knowledge_resource_digest,
       billing_policy_version, validator_policy_version,
       unit_price_cents, free_limit_snapshot, active_recharge_intent_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 'knowledge_agent_test',
       'combo.agent-package-capability/2', $7, $8, 'controlled_test',
       'skills/knowledge/references/knowledge-bundle.json', $9,
       'knowledge-billing-v1', 'knowledge-citations-v1', 1, 3, $2
     )`,
    [
      ownerUserId,
      usageId,
      sessionId,
      capabilityId,
      requestText,
      createHash('sha256').update(`role:${usageId}:${requestText}`).digest('hex'),
      releaseId,
      packageDigest,
      resourceDigest,
    ],
  );
  return { ownerUserId, usageId, requestText };
}

async function casAndCreateOrder(
  api: Client,
  seed: PendingSeed,
  previousIntentId: string,
  nextIntentId: string,
): Promise<{ won: boolean; orderId?: string }> {
  await api.query('BEGIN');
  try {
    await api.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended($1 || ':' || $2::uuid::text, 0)
       )`,
      [seed.ownerUserId, seed.usageId],
    );
    const locked = await api.query<{ usage_id: string }>(
      `SELECT usage_id
         FROM pending_usage_recoveries
        WHERE owner_user_id = $1
          AND usage_id = $2
          AND recovery_status = 'active'
          AND expires_at > statement_timestamp()
        FOR UPDATE`,
      [seed.ownerUserId, seed.usageId],
    );
    if (locked.rowCount !== 1) {
      await api.query('ROLLBACK');
      return { won: false };
    }
    const cas = await api.query<{ usage_id: string }>(
      `UPDATE pending_usage_recoveries
          SET active_recharge_intent_id = $4, updated_at = statement_timestamp()
        WHERE owner_user_id = $1
          AND usage_id = $2
          AND recovery_status = 'active'
          AND active_recharge_intent_id = $3
          AND expires_at > statement_timestamp()
        RETURNING usage_id`,
      [seed.ownerUserId, seed.usageId, previousIntentId, nextIntentId],
    );
    if (cas.rowCount !== 1) {
      await api.query('ROLLBACK');
      return { won: false };
    }
    const orderId = (
      await api.query<{ id: string }>(
        `INSERT INTO recharge_orders (
           order_no, owner_user_id, client_idempotency_key, package_id, amount_cents,
           payment_method, pay_type, gateway_environment, institution_no, merchant_no,
           pay_trace_no, pay_time, recovery_usage_id
         ) VALUES (
           $1, $2, $3, 'manual', 1, 'qr', 'alipay', 'test', 'institution', 'merchant',
           $4, '20260901120000', $5
         ) RETURNING id`,
        [
          `CBR${randomUUID().replaceAll('-', '')}`,
          seed.ownerUserId,
          nextIntentId,
          `CB${randomUUID().replaceAll('-', '')}`,
          seed.usageId,
        ],
      )
    ).rows[0]!.id;
    await api.query('COMMIT');
    return { won: true, orderId };
  } catch (error) {
    await api.query('ROLLBACK');
    throw error;
  }
}

pgDescribe('pending usage recovery PostgreSQL roles', () => {
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

  it('keeps request text Runtime-only and exposes only narrow API CAS columns', async () => {
    const api = clients.get('combo_api')!;
    const worker = clients.get('combo_worker')!;
    const runtime = clients.get('combo_runtime')!;
    const seed = await seedPending(owner, runtime);

    for (const [role, client] of clients) {
      expect((await client.query<{ current_user: string }>('SELECT current_user')).rows[0]).toEqual(
        { current_user: role },
      );
    }
    for (const [role, expected] of [
      ['combo_api', { table_select: false, text_select: false, intent_update: true }],
      ['combo_worker', { table_select: false, text_select: false, intent_update: false }],
      ['combo_runtime', { table_select: true, text_select: true, intent_update: false }],
    ] as const) {
      const privileges = await owner.query<{
        table_select: boolean;
        text_select: boolean;
        intent_update: boolean;
      }>(
        `SELECT
           has_table_privilege($1, 'public.pending_usage_recoveries', 'SELECT') AS table_select,
           has_column_privilege(
             $1, 'public.pending_usage_recoveries', 'request_text', 'SELECT'
           ) AS text_select,
           has_column_privilege(
             $1, 'public.pending_usage_recoveries', 'active_recharge_intent_id', 'UPDATE'
           ) AS intent_update`,
        [role],
      );
      expect(privileges.rows[0], role).toEqual(expected);
    }
    expect(
      (
        await owner.query<{ allowed: boolean }>(
          `SELECT has_column_privilege(
             'combo_api', 'public.pending_usage_recoveries', 'recovery_status', 'UPDATE'
           ) AS allowed`,
        )
      ).rows[0]?.allowed,
    ).toBe(false);
    expect(
      (
        await owner.query<{ allowed: boolean }>(
          `SELECT has_table_privilege(
             'combo_runtime', 'public.recharge_orders', 'SELECT'
           ) AS allowed`,
        )
      ).rows[0]?.allowed,
    ).toBe(false);
    for (const functionName of [
      'guard_pending_usage_recovery_write()',
      'enforce_pending_usage_recovery_terminal()',
      'guard_recharge_order_recovery_binding()',
    ]) {
      for (const role of Object.keys(PASSWORD_KEYS)) {
        expect(
          (
            await owner.query<{ allowed: boolean }>(
              `SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed`,
              [role, `public.${functionName}`],
            )
          ).rows[0]?.allowed,
          `${role} ${functionName}`,
        ).toBe(false);
      }
    }
    const publicAcl = await owner.query<{
      pending_access: boolean;
      trigger_execute: boolean;
    }>(
      `SELECT
         EXISTS (
           SELECT 1
             FROM pg_class AS relation
             CROSS JOIN LATERAL aclexplode(
               COALESCE(relation.relacl, acldefault('r', relation.relowner))
             ) AS privilege
            WHERE relation.oid = 'public.pending_usage_recoveries'::regclass
              AND privilege.grantee = 0
         ) AS pending_access,
         EXISTS (
           SELECT 1
             FROM pg_proc AS routine
             CROSS JOIN LATERAL aclexplode(
               COALESCE(routine.proacl, acldefault('f', routine.proowner))
             ) AS privilege
            WHERE routine.proname IN (
              'guard_pending_usage_recovery_write',
              'enforce_pending_usage_recovery_terminal',
              'guard_recharge_order_recovery_binding'
            )
              AND privilege.grantee = 0
         ) AS trigger_execute`,
    );
    expect(publicAcl.rows[0]).toEqual({ pending_access: false, trigger_execute: false });

    await expect(
      api.query(
        `SELECT owner_user_id, usage_id, recovery_status, active_recharge_intent_id,
                unit_price_cents, expires_at, updated_at
           FROM pending_usage_recoveries
          WHERE owner_user_id = $1 AND usage_id = $2`,
        [seed.ownerUserId, seed.usageId],
      ),
    ).resolves.toBeDefined();
    await expect(
      api.query(
        `SELECT request_text FROM pending_usage_recoveries
          WHERE owner_user_id = $1 AND usage_id = $2`,
        [seed.ownerUserId, seed.usageId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      api.query(
        `UPDATE pending_usage_recoveries
            SET request_text = NULL
          WHERE owner_user_id = $1 AND usage_id = $2`,
        [seed.ownerUserId, seed.usageId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect(
      (
        await runtime.query<{ request_text: string }>(
          `SELECT request_text FROM pending_usage_recoveries
            WHERE owner_user_id = $1 AND usage_id = $2`,
          [seed.ownerUserId, seed.usageId],
        )
      ).rows[0]?.request_text,
    ).toBe(seed.requestText);
    await expect(runtime.query('SELECT id FROM recharge_orders LIMIT 1')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      worker.query('SELECT usage_id FROM pending_usage_recoveries LIMIT 1'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      worker.query(
        `UPDATE pending_usage_recoveries
            SET updated_at = statement_timestamp()
          WHERE owner_user_id = $1 AND usage_id = $2`,
        [seed.ownerUserId, seed.usageId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('serializes concurrent API intent CAS and lets only the winner create a linked order', async () => {
    const api = clients.get('combo_api')!;
    const runtime = clients.get('combo_runtime')!;
    const seed = await seedPending(owner, runtime);
    const apiPeer = new Client({ connectionString: roleConnectionString('combo_api') });
    await apiPeer.connect();
    try {
      const firstIntent = randomUUID();
      const secondIntent = randomUUID();
      const results = await Promise.all([
        casAndCreateOrder(api, seed, seed.usageId, firstIntent),
        casAndCreateOrder(apiPeer, seed, seed.usageId, secondIntent),
      ]);
      expect(results.filter(({ won }) => won)).toHaveLength(1);
      expect(results.filter(({ won }) => !won)).toHaveLength(1);
      const winner = results.find(({ won }) => won)!;
      const pending = (
        await owner.query<{ active_recharge_intent_id: string }>(
          `SELECT active_recharge_intent_id
             FROM pending_usage_recoveries
            WHERE owner_user_id = $1 AND usage_id = $2`,
          [seed.ownerUserId, seed.usageId],
        )
      ).rows[0]!;
      const orders = await owner.query<{
        id: string;
        client_idempotency_key: string;
        recovery_usage_id: string;
      }>(
        `SELECT id, client_idempotency_key, recovery_usage_id
           FROM recharge_orders
          WHERE owner_user_id = $1 AND recovery_usage_id = $2`,
        [seed.ownerUserId, seed.usageId],
      );
      expect(orders.rows).toHaveLength(1);
      expect(orders.rows[0]).toEqual({
        id: winner.orderId,
        client_idempotency_key: pending.active_recharge_intent_id,
        recovery_usage_id: seed.usageId,
      });

      await runtime.query(
        `UPDATE pending_usage_recoveries
            SET recovery_status = 'abandoned', request_text = NULL,
                abandoned_at = statement_timestamp(), updated_at = statement_timestamp()
          WHERE owner_user_id = $1 AND usage_id = $2 AND recovery_status = 'active'`,
        [seed.ownerUserId, seed.usageId],
      );
      expect(
        (
          await owner.query<{ request_text: string | null; recovery_status: string }>(
            `SELECT request_text, recovery_status
               FROM pending_usage_recoveries
              WHERE owner_user_id = $1 AND usage_id = $2`,
            [seed.ownerUserId, seed.usageId],
          )
        ).rows[0],
      ).toEqual({ request_text: null, recovery_status: 'abandoned' });
      await expect(
        runtime.query(
          `UPDATE pending_usage_recoveries
              SET recovery_status = 'active', request_text = $3,
                  abandoned_at = NULL, updated_at = statement_timestamp()
            WHERE owner_user_id = $1 AND usage_id = $2`,
          [seed.ownerUserId, seed.usageId, seed.requestText],
        ),
      ).rejects.toMatchObject({ code: '55000' });
    } finally {
      await apiPeer.end();
    }
  });
});
