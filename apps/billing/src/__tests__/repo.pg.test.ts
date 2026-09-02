import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgBillingStore } from '../repo.js';
import { ledgerIdempotencyKeys, type BillingStore } from '../service.js';

const databaseUrl = process.env.BILLING_V2_TEST_DATABASE_URL;
const billingPassword = process.env.POSTGRES_BILLING_PASSWORD;
const enabled =
  process.env.BILLING_V2_REPO_PG_TEST === '1' && Boolean(databaseUrl) && Boolean(billingPassword);
const pgDescribe = enabled ? describe : describe.skip;

function billingUrl(): string {
  const url = new URL(databaseUrl!);
  url.username = 'combo_billing';
  url.password = billingPassword!;
  return url.toString();
}

pgDescribe('V2 PostgreSQL billing idempotency', () => {
  let admin: Client;
  let pool: Pool;
  let store: BillingStore;

  beforeAll(async () => {
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    pool = new Pool({
      connectionString: billingUrl(),
      max: 6,
      application_name: 'combo-v2-billing-repo-pg-test',
    });
    store = createPgBillingStore(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  async function createUser(): Promise<string> {
    const id = randomUUID();
    await admin.query('INSERT INTO v2_users(id) VALUES ($1)', [id]);
    return id;
  }

  async function seed(userId: string, amount = 10_000): Promise<void> {
    const result = await store.adminRecharge({
      userId,
      amount,
      idempotencyKey: `seed:${randomUUID()}`,
      refId: 'pg-test',
    });
    if (result.kind !== 'credited') throw new Error('seed recharge failed');
  }

  async function waitForNewStoreToBlock(): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const waiting = await admin.query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
            WHERE application_name = 'combo-v2-billing-repo-pg-test'
              AND state = 'active'
              AND wait_event IS NOT NULL
         ) AS waiting`,
      );
      if (waiting.rows[0]?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('new billing writer did not reach the legacy transaction lock');
  }

  it('serializes concurrent holds and rejects changed payload or terminal replay', async () => {
    const missingUserId = randomUUID();
    await expect(
      store.createHold({
        userId: missingUserId,
        agentId: 'pg-agent-missing-user',
        turnId: `turn-${randomUUID()}`,
        estimatedAmount: 1,
        overdraftHardLimitCents: 500,
      }),
    ).resolves.toEqual({ kind: 'invalid_user' });
    await expect(
      store.adminRecharge({
        userId: missingUserId,
        amount: 1,
        idempotencyKey: `missing:${randomUUID()}`,
      }),
    ).resolves.toEqual({ kind: 'invalid_user' });

    const userId = await createUser();
    const otherUserId = await createUser();
    await seed(userId);
    await seed(otherUserId);
    const input = {
      userId,
      agentId: 'pg-agent-hold',
      turnId: `turn-${randomUUID()}`,
      estimatedAmount: 300,
      overdraftHardLimitCents: 500,
    };

    const outcomes = await Promise.all([store.createHold(input), store.createHold(input)]);
    expect(outcomes.filter((outcome) => outcome.kind === 'held' && !outcome.replayed)).toHaveLength(
      1,
    );
    expect(outcomes.filter((outcome) => outcome.kind === 'held' && outcome.replayed)).toHaveLength(
      1,
    );
    const created = outcomes.find((outcome) => outcome.kind === 'held');
    if (!created || created.kind !== 'held') throw new Error('hold missing');
    await expect(store.createHold({ ...input, userId: otherUserId })).resolves.toEqual({
      kind: 'conflict',
      reason: 'idempotency_mismatch',
    });
    await expect(store.createHold({ ...input, estimatedAmount: 301 })).resolves.toEqual({
      kind: 'conflict',
      reason: 'idempotency_mismatch',
    });

    const settlements = await Promise.all([
      store.settleHold({ holdId: created.hold.id, actualAmount: 200 }),
      store.settleHold({ holdId: created.hold.id, actualAmount: 200 }),
    ]);
    expect(
      settlements.filter((outcome) => outcome.kind === 'settled' && !outcome.replayed),
    ).toHaveLength(1);
    expect(
      settlements.filter((outcome) => outcome.kind === 'settled' && outcome.replayed),
    ).toHaveLength(1);
    await expect(store.settleHold({ holdId: created.hold.id, actualAmount: 201 })).resolves.toEqual(
      {
        kind: 'conflict',
        reason: 'idempotency_mismatch',
      },
    );
    await expect(store.createHold(input)).resolves.toEqual({
      kind: 'conflict',
      reason: 'terminal_replay',
    });
    await expect(
      pool.query('UPDATE v2_holds SET actual_amount = 999 WHERE id = $1', [created.hold.id]),
    ).rejects.toMatchObject({ code: '55000' });

    const counts = await admin.query<{
      holds: string;
      hold_ledger: string;
      consume_ledger: string;
      actual_amount: string;
    }>(
      `SELECT
         (SELECT count(*) FROM v2_holds WHERE agent_id = $1 AND turn_id = $2) AS holds,
         (SELECT count(*) FROM v2_ledger WHERE kind = 'hold' AND ref_id = $3) AS hold_ledger,
         (SELECT count(*) FROM v2_ledger WHERE kind = 'consume' AND ref_id = $3) AS consume_ledger,
         (SELECT actual_amount FROM v2_holds WHERE id = $3::uuid)::text AS actual_amount`,
      [input.agentId, input.turnId, created.hold.id],
    );
    expect(counts.rows[0]).toEqual({
      holds: '1',
      hold_ledger: '1',
      consume_ledger: '1',
      actual_amount: '200',
    });
  });

  it('binds recharge and metering replays to their complete original payload', async () => {
    const userId = await createUser();
    const otherUserId = await createUser();
    const recharge = {
      userId,
      amount: 1000,
      idempotencyKey: `recharge:${randomUUID()}`,
      refId: 'ticket-a',
    };
    const rechargeOutcomes = await Promise.all([
      store.adminRecharge(recharge),
      store.adminRecharge(recharge),
    ]);
    expect(
      rechargeOutcomes.filter((outcome) => outcome.kind === 'credited' && !outcome.replayed),
    ).toHaveLength(1);
    expect(
      rechargeOutcomes.filter((outcome) => outcome.kind === 'credited' && outcome.replayed),
    ).toHaveLength(1);
    await expect(store.adminRecharge({ ...recharge, amount: 1001 })).resolves.toEqual({
      kind: 'conflict',
      reason: 'idempotency_mismatch',
    });
    await expect(store.adminRecharge({ ...recharge, userId: otherUserId })).resolves.toEqual({
      kind: 'conflict',
      reason: 'idempotency_mismatch',
    });
    await expect(store.adminRecharge({ ...recharge, refId: 'ticket-b' })).resolves.toEqual({
      kind: 'conflict',
      reason: 'idempotency_mismatch',
    });

    const rangeUserId = await createUser();
    await expect(
      store.adminRecharge({
        userId: rangeUserId,
        amount: Number.MAX_SAFE_INTEGER,
        idempotencyKey: `range:${randomUUID()}`,
      }),
    ).resolves.toMatchObject({ kind: 'credited' });
    await expect(
      store.adminRecharge({
        userId: rangeUserId,
        amount: 1,
        idempotencyKey: `range:${randomUUID()}`,
      }),
    ).resolves.toEqual({ kind: 'conflict', reason: 'balance_range_exceeded' });

    const hold = await store.createHold({
      userId,
      agentId: 'pg-agent-meter',
      turnId: `turn-${randomUUID()}`,
      estimatedAmount: 100,
      overdraftHardLimitCents: 500,
    });
    if (hold.kind !== 'held') throw new Error('hold failed');
    const event = {
      agentId: hold.hold.agentId,
      userId,
      turnId: hold.hold.turnId,
      holdId: hold.hold.id,
      dimension: 'llm_token_out' as const,
      quantity: 42,
      model: 'model-a',
      unitCost: 2,
      source: 'gateway' as const,
      idempotencyKey: `meter:${randomUUID()}`,
    };
    const meterOutcomes = await Promise.all([
      store.insertMeteringEvent(event),
      store.insertMeteringEvent(event),
    ]);
    expect(
      meterOutcomes.filter((outcome) => outcome.kind === 'recorded' && !outcome.replayed),
    ).toHaveLength(1);
    expect(
      meterOutcomes.filter((outcome) => outcome.kind === 'recorded' && outcome.replayed),
    ).toHaveLength(1);
    await expect(store.insertMeteringEvent({ ...event, quantity: 43 })).resolves.toEqual({
      kind: 'conflict',
      reason: 'idempotency_mismatch',
    });
    await expect(
      store.insertMeteringEvent({
        ...event,
        userId: otherUserId,
        idempotencyKey: `meter:${randomUUID()}`,
      }),
    ).resolves.toEqual({ kind: 'conflict', reason: 'hold_scope_mismatch' });

    const settled = await store.settleHold({ holdId: hold.hold.id, actualAmount: 10 });
    expect(settled.kind).toBe('settled');
    await expect(
      store.insertMeteringEvent({ ...event, idempotencyKey: `meter:${randomUUID()}` }),
    ).resolves.toEqual({ kind: 'conflict', reason: 'hold_not_active' });
    const meterCount = await admin.query<{ count: string }>(
      'SELECT count(*) AS count FROM v2_metering_events WHERE hold_id = $1',
      [hold.hold.id],
    );
    expect(meterCount.rows[0]!.count).toBe('1');
  });

  it('records one estimated event when settlement wins the hold lock', async () => {
    const userId = await createUser();
    await seed(userId);
    const agentId = 'pg-agent-settle-first';
    const turnId = `turn-${randomUUID()}`;
    const rawHoldKey = ledgerIdempotencyKeys.hold(agentId, turnId);
    await expect(
      store.adminRecharge({
        userId,
        amount: 1,
        idempotencyKey: rawHoldKey,
        refId: 'system-key-collision-probe',
      }),
    ).resolves.toMatchObject({ kind: 'credited' });
    const hold = await store.createHold({
      userId,
      agentId,
      turnId,
      estimatedAmount: 100,
      overdraftHardLimitCents: 500,
    });
    if (hold.kind !== 'held') throw new Error('hold failed');

    const rawSettleKey = ledgerIdempotencyKeys.settle(hold.hold.id, 'principal');
    await expect(
      store.adminRecharge({
        userId,
        amount: 1,
        idempotencyKey: rawSettleKey,
        refId: 'system-key-collision-probe',
      }),
    ).resolves.toMatchObject({ kind: 'credited' });
    await expect(
      store.insertMeteringEvent({
        agentId,
        userId,
        turnId,
        dimension: 'llm_token_out',
        quantity: 1,
        source: 'agent_report',
        idempotencyKey: `meter:estimated:v1:${hold.hold.id}`,
      }),
    ).resolves.toMatchObject({ kind: 'recorded' });

    const settled = await store.settleHold({ holdId: hold.hold.id, actualAmount: 75 });
    expect(settled.kind).toBe('settled');
    if (settled.kind !== 'settled') throw new Error('settlement failed');
    expect(settled.estimatedUsageRecorded).toBe(true);
    await expect(
      store.settleHold({ holdId: hold.hold.id, actualAmount: 75 }),
    ).resolves.toMatchObject({
      kind: 'settled',
      estimatedUsageRecorded: true,
      replayed: true,
    });

    await expect(
      store.insertMeteringEvent({
        agentId: hold.hold.agentId,
        userId,
        turnId: hold.hold.turnId,
        holdId: hold.hold.id,
        dimension: 'llm_token_out',
        quantity: 75,
        model: 'model-a',
        unitCost: 1,
        source: 'gateway',
        idempotencyKey: `meter:${randomUUID()}`,
      }),
    ).resolves.toEqual({ kind: 'conflict', reason: 'hold_not_active' });

    const events = await admin.query<{ source: string; count: string }>(
      `SELECT source, count(*) AS count
         FROM v2_metering_events
        WHERE hold_id = $1
        GROUP BY source`,
      [hold.hold.id],
    );
    expect(events.rows).toEqual([{ source: 'estimated', count: '1' }]);
  });

  it('treats a concurrent 0014 writer as a safe replay instead of availability failure', async () => {
    const userId = await createUser();
    await seed(userId);
    const input = {
      userId,
      agentId: 'pg-agent-legacy-writer',
      turnId: `turn-${randomUUID()}`,
      estimatedAmount: 100,
      overdraftHardLimitCents: 500,
    };
    const legacy = new Client({
      connectionString: billingUrl(),
      application_name: 'combo-v2-legacy-billing-writer',
    });
    await legacy.connect();
    let open = false;
    try {
      await legacy.query('BEGIN');
      open = true;
      const hold = await legacy.query<{ id: string }>(
        `INSERT INTO v2_holds (user_id, agent_id, turn_id, estimated_amount, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '5 minutes') RETURNING id`,
        [userId, input.agentId, input.turnId, input.estimatedAmount],
      );
      await legacy.query(
        'UPDATE v2_wallets SET held_amount = held_amount + $2 WHERE user_id = $1',
        [userId, input.estimatedAmount],
      );
      await legacy.query(
        `INSERT INTO v2_ledger (user_id, kind, bucket, amount, ref_id, idempotency_key)
         VALUES ($1, 'hold', NULL, $2, $3, $4)`,
        [
          userId,
          input.estimatedAmount,
          hold.rows[0]!.id,
          ledgerIdempotencyKeys.hold(input.agentId, input.turnId),
        ],
      );

      const currentWriter = store.createHold(input);
      await waitForNewStoreToBlock();
      await legacy.query('COMMIT');
      open = false;

      await expect(currentWriter).resolves.toMatchObject({
        kind: 'held',
        replayed: true,
        hold: { id: hold.rows[0]!.id },
      });
      const counts = await admin.query<{ holds: string; held_amount: string; ledgers: string }>(
        `SELECT
           (SELECT count(*) FROM v2_holds WHERE agent_id = $1 AND turn_id = $2) AS holds,
           (SELECT held_amount FROM v2_wallets WHERE user_id = $3)::text AS held_amount,
           (SELECT count(*) FROM v2_ledger WHERE kind = 'hold' AND ref_id = $4) AS ledgers`,
        [input.agentId, input.turnId, userId, hold.rows[0]!.id],
      );
      expect(counts.rows[0]).toEqual({ holds: '1', held_amount: '100', ledgers: '1' });
    } finally {
      if (open) await legacy.query('ROLLBACK').catch(() => undefined);
      await legacy.end();
    }
  });

  it('starts the five-minute hold TTL only after a contended wallet lock is acquired', async () => {
    const userId = await createUser();
    await seed(userId);
    const locker = new Client({ connectionString: databaseUrl });
    await locker.connect();
    let open = false;
    try {
      await locker.query('BEGIN');
      open = true;
      await locker.query('SELECT 1 FROM v2_wallets WHERE user_id = $1 FOR UPDATE', [userId]);

      const pending = store.createHold({
        userId,
        agentId: 'pg-agent-contended-ttl',
        turnId: `turn-${randomUUID()}`,
        estimatedAmount: 100,
        overdraftHardLimitCents: 500,
      });
      await waitForNewStoreToBlock();
      const lowerBound = await admin.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      await locker.query('COMMIT');
      open = false;

      const outcome = await pending;
      if (outcome.kind !== 'held') throw new Error('hold failed');
      const stored = await admin.query<{ created_at: Date; exact_ttl: boolean }>(
        `SELECT created_at,
                expires_at - created_at = interval '5 minutes' AS exact_ttl
           FROM v2_holds WHERE id = $1`,
        [outcome.hold.id],
      );
      expect(stored.rows[0]!.created_at.getTime()).toBeGreaterThanOrEqual(
        lowerBound.rows[0]!.now.getTime(),
      );
      expect(stored.rows[0]!.exact_ttl).toBe(true);
    } finally {
      if (open) await locker.query('ROLLBACK').catch(() => undefined);
      await locker.end();
    }
  });
});
