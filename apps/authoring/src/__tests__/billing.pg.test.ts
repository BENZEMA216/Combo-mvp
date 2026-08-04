import { Pool } from 'pg';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgBillingRepository } from '../modules/billing/repo.js';
import { BillingRateLimitedError } from '../modules/billing/types.js';
import { asTxPool } from '../platform/infra/db-tx.js';
import type { VerifiedPaymentNotification } from '../platform/infra/leshouying/index.js';

const enabled =
  process.env.BILLING_PG_TEST === '1' &&
  Boolean(process.env.BILLING_TEST_DATABASE_URL && process.env.BILLING_AUTHORING_TEST_DATABASE_URL);
const pgDescribe = enabled ? describe : describe.skip;

pgDescribe('billing PostgreSQL concurrency invariants', () => {
  let pool: Pool;
  let apiPool: Pool;
  let repository: PgBillingRepository;
  let ownerId: string;
  let runId: string;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: process.env.BILLING_TEST_DATABASE_URL,
      max: 6,
    });
    apiPool = new Pool({
      connectionString: process.env.BILLING_AUTHORING_TEST_DATABASE_URL,
      max: 6,
    });
    const identity = await apiPool.query<{ current_user: string }>(
      'SELECT current_user::text AS current_user',
    );
    if (identity.rows[0]?.current_user !== 'combo_api') {
      throw new Error('billing authoring test connection must use combo_api');
    }
    const schema = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name IN (
            'billing_accounts',
            'recharge_orders',
            'payment_attempts',
            'payment_callback_events',
            'wallet_ledger'
          )`,
    );
    if (schema.rows.length !== 5) throw new Error('billing migration is not applied');
    repository = new PgBillingRepository(asTxPool(apiPool), apiPool);
  });

  afterAll(async () => {
    await Promise.all([pool?.end(), apiPool?.end()]);
  });

  beforeEach(async () => {
    ownerId = randomUUID();
    runId = randomBytes(12).toString('hex');
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    const accountSuffix = [...randomBytes(8)]
      .map((value) => alphabet[value % alphabet.length])
      .join('');
    await pool.query(
      `INSERT INTO users (id, account)
       VALUES ($1, $2)`,
      [ownerId, `creator-${accountSuffix}`],
    );
  });

  async function prepare(suffix: string) {
    const identity = `${runId}-${suffix}`;
    return repository.prepareRecharge({
      orderNo: `CBR-PG-${identity}`,
      ownerUserId: ownerId,
      clientIdempotencyKey: `intent-${suffix}`,
      packageId: 'starter',
      amountCents: 300n,
      paymentMethod: 'qr',
      payType: 'alipay',
      gatewayEnvironment: 'test',
      institutionNo: 'INST0001',
      merchantNo: 'MCH_TEST_001',
      payTraceNo: `TRACE-PG-${identity}`,
      payTime: '20260728120000',
      requestFingerprint: createHash('sha256').update(identity).digest('hex'),
      submissionRecoveryMs: 10_000,
    });
  }

  function notification(
    order: Awaited<ReturnType<typeof prepare>>['order'],
    fingerprint: string,
    tradeNo: string,
  ): VerifiedPaymentNotification {
    return {
      eventFingerprint: fingerprint,
      gatewayEnvironment: 'test',
      institutionNo: 'INST0001',
      merchantNo: 'MCH_TEST_001',
      payTraceNo: order.payTraceNo,
      payTime: order.payTime,
      amountCents: order.amountCents,
      platformTradeNo: tradeNo,
      resultCode: 'PAY_SUCCESS',
      returnCode: 'SUCCESS',
      tradeType: '1',
      attach: order.orderNo,
      paidAt: new Date(),
    };
  }

  it('keeps a fresh submitting order untouched, then recovers the stale trace by query lease', async () => {
    const prepared = await prepare('stale-submit');
    const repeated = await prepare('stale-submit');
    expect(prepared).toMatchObject({ shouldSubmit: true, created: true });
    expect(repeated).toMatchObject({ shouldSubmit: false, created: false });
    expect(repeated.order.paymentStatus).toBe('created');

    await expect(
      repository.leaseRechargeOrderForOwner({
        ownerUserId: ownerId,
        orderId: prepared.order.id,
        leaseOwner: 'fresh-submit-must-not-query',
        leaseMs: 30_000,
      }),
    ).resolves.toBeNull();

    await pool.query(`UPDATE recharge_orders SET next_query_at = now() WHERE id = $1`, [
      prepared.order.id,
    ]);
    const leased = await repository.leaseRechargeOrderForOwner({
      ownerUserId: ownerId,
      orderId: prepared.order.id,
      leaseOwner: 'stale-submit-query-original',
      leaseMs: 30_000,
    });
    expect(leased).toMatchObject({
      id: prepared.order.id,
      payTraceNo: prepared.order.payTraceNo,
      paymentStatus: 'unknown',
    });
    const attempt = await pool.query<{ status: string }>(
      `SELECT status
         FROM payment_attempts
        WHERE recharge_order_id = $1 AND attempt_no = 1`,
      [prepared.order.id],
    );
    expect(attempt.rows[0]?.status).toBe('unknown');
  });

  it('serializes concurrent idempotent preparation into exactly one gateway submission owner', async () => {
    const prepared = await Promise.all([prepare('prepare-race'), prepare('prepare-race')]);
    expect(prepared.filter((result) => result.shouldSubmit)).toHaveLength(1);
    expect(prepared.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(prepared.map((result) => result.order.id)).size).toBe(1);
    expect(new Set(prepared.map((result) => result.order.payTraceNo)).size).toBe(1);
  });

  it('admits only three active orders per owner while preserving same-intent replay', async () => {
    const first = await prepare('active-1');
    await prepare('active-2');
    await prepare('active-3');

    await expect(prepare('active-1')).resolves.toMatchObject({
      created: false,
      shouldSubmit: false,
      order: { id: first.order.id },
    });
    await expect(prepare('active-4')).rejects.toBeInstanceOf(BillingRateLimitedError);

    await pool.query(`UPDATE recharge_orders SET next_query_at = NULL WHERE id = $1`, [
      first.order.id,
    ]);
    await expect(prepare('active-4')).resolves.toMatchObject({
      created: true,
      shouldSubmit: true,
    });
  });

  it('bounds failed recharge-order creation per owner over a rolling hour', async () => {
    for (let index = 0; index < 10; index += 1) {
      const prepared = await prepare(`hourly-${index}`);
      await repository.recordSubmission(prepared.order.id, prepared.order.attemptNo, {
        status: 'failed',
        gatewayResultCode: 'PAY_FAIL',
      });
    }

    await expect(prepare('hourly-over-limit')).rejects.toMatchObject({
      name: 'BillingRateLimitedError',
      retryAfterSeconds: 3_600,
    });
  });

  it('retires exhausted query compensation but still credits a later trusted callback', async () => {
    const prepared = await prepare('query-cutoff');
    await pool.query(
      `UPDATE recharge_orders
          SET next_query_at = now(), query_attempt_count = 120
        WHERE id = $1`,
      [prepared.order.id],
    );

    await expect(repository.retireExpiredReconciliations({ limit: 1 })).resolves.toBe(1);
    await expect(repository.findRechargeOrder(ownerId, prepared.order.id)).resolves.toMatchObject({
      reconciliationActive: false,
      paymentStatus: 'created',
      creditStatus: 'uncredited',
    });

    await expect(
      repository.processNotification(
        notification(
          prepared.order,
          createHash('sha256').update(`${runId}:late-callback`).digest('hex'),
          `TRADE-PG-${runId}-LATE`,
        ),
      ),
    ).resolves.toBe('processed');
    await expect(repository.getWallet(ownerId)).resolves.toEqual({
      availableCents: 300n,
      reservedCents: 0n,
    });
  });

  it('keeps the first trusted platform order identity across late POST and query races', async () => {
    const callbackFirst = await prepare('pending-callback-first');
    await expect(
      repository.processNotification({
        ...notification(
          callbackFirst.order,
          createHash('sha256').update(`${runId}:pending-first`).digest('hex'),
          `TRADE-PG-${runId}-BOUND`,
        ),
        resultCode: 'PAY_IN_PROCESS',
      }),
    ).resolves.toBe('processed');
    await expect(
      repository.recordSubmission(callbackFirst.order.id, callbackFirst.order.attemptNo, {
        status: 'pending',
        platformTradeNo: `TRADE-PG-${runId}-LATE-POST`,
      }),
    ).resolves.toMatchObject({ platformTradeNo: `TRADE-PG-${runId}-BOUND` });
    await expect(
      repository.recordSubmission(callbackFirst.order.id, callbackFirst.order.attemptNo, {
        status: 'failed',
        gatewayResultCode: 'PAY_FAIL',
      }),
    ).resolves.toMatchObject({
      paymentStatus: 'pending',
      platformTradeNo: `TRADE-PG-${runId}-BOUND`,
      reconciliationActive: true,
    });
    const callbackFirstAttempt = await pool.query<{ status: string }>(
      `SELECT status
         FROM payment_attempts
        WHERE recharge_order_id = $1 AND attempt_no = 1`,
      [callbackFirst.order.id],
    );
    expect(callbackFirstAttempt.rows[0]?.status).toBe('pending');

    const queryRace = await prepare('query-identity-race');
    await pool.query(`UPDATE recharge_orders SET next_query_at = now() WHERE id = $1`, [
      queryRace.order.id,
    ]);
    const leased = await repository.leaseRechargeOrderForOwner({
      ownerUserId: ownerId,
      orderId: queryRace.order.id,
      leaseOwner: 'query-identity-race',
      leaseMs: 30_000,
    });
    expect(leased).not.toBeNull();
    if (!leased) return;
    await repository.recordSubmission(queryRace.order.id, queryRace.order.attemptNo, {
      status: 'pending',
      platformTradeNo: `TRADE-PG-${runId}-POST-WINS`,
    });
    await repository.applyQueryResult(leased, {
      status: 'failed',
      gatewayResultCode: 'PAY_FAIL',
    });

    const state = await pool.query<{
      order_trade_no: string;
      attempt_trade_no: string;
      payment_status: string;
      query_lease_owner: string | null;
    }>(
      `SELECT ro.platform_trade_no AS order_trade_no,
              pa.platform_trade_no AS attempt_trade_no,
              ro.payment_status,
              ro.query_lease_owner
         FROM recharge_orders ro
         JOIN payment_attempts pa ON pa.recharge_order_id = ro.id AND pa.attempt_no = 1
        WHERE ro.id = $1`,
      [queryRace.order.id],
    );
    expect(state.rows[0]).toEqual({
      order_trade_no: `TRADE-PG-${runId}-POST-WINS`,
      attempt_trade_no: `TRADE-PG-${runId}-POST-WINS`,
      payment_status: 'unknown',
      query_lease_owner: null,
    });
  });

  it('clears expired bearer payment actions in bounded batches', async () => {
    const prepared = await prepare('expired-action');
    await repository.recordSubmission(prepared.order.id, prepared.order.attemptNo, {
      status: 'pending',
      action: {
        kind: 'code_url',
        value: 'opaque-expired-action',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await pool.query(
      `UPDATE payment_attempts
          SET started_at = now() - interval '2 minutes',
              action_expires_at = now() - interval '1 minute'
        WHERE recharge_order_id = $1`,
      [prepared.order.id],
    );

    await expect(repository.clearExpiredPaymentActions({ limit: 1 })).resolves.toBe(1);
    const action = await pool.query<{
      action_kind: string | null;
      action_value: string | null;
      action_expires_at: Date | null;
    }>(
      `SELECT action_kind, action_value, action_expires_at
         FROM payment_attempts
        WHERE recharge_order_id = $1`,
      [prepared.order.id],
    );
    expect(action.rows[0]).toEqual({
      action_kind: null,
      action_value: null,
      action_expires_at: null,
    });
  });

  it('serializes callback and query credit into one balance increment and one ledger row', async () => {
    const prepared = await prepare('race-credit');
    await repository.recordSubmission(prepared.order.id, prepared.order.attemptNo, {
      status: 'pending',
      action: {
        kind: 'code_url',
        value: 'opaque-test-action',
        expiresAt: new Date(Date.now() + 15 * 60 * 1_000),
      },
    });
    await pool.query(`UPDATE recharge_orders SET next_query_at = now() WHERE id = $1`, [
      prepared.order.id,
    ]);
    const leased = await repository.leaseRechargeOrderForOwner({
      ownerUserId: ownerId,
      orderId: prepared.order.id,
      leaseOwner: 'pg-race-query',
      leaseMs: 30_000,
    });
    expect(leased).not.toBeNull();
    if (!leased) return;

    const callback = notification(
      prepared.order,
      createHash('sha256').update(`${runId}:callback-race`).digest('hex'),
      `TRADE-PG-${runId}-RACE`,
    );
    await Promise.all([
      repository.processNotification(callback),
      repository.applyQueryResult(leased, {
        status: 'succeeded',
        gatewayResultCode: 'PAY_SUCCESS',
        platformTradeNo: `TRADE-PG-${runId}-RACE`,
        paidAt: new Date(),
      }),
    ]);

    const state = await pool.query<{
      balance_cents: string;
      credit_status: string;
      payment_status: string;
      ledger_count: number;
    }>(
      `SELECT ba.balance_cents::text,
              ro.credit_status,
              ro.payment_status,
              (
                SELECT count(*)::int
                  FROM wallet_ledger wl
                 WHERE wl.recharge_order_id = ro.id
              ) AS ledger_count
         FROM recharge_orders ro
         JOIN billing_accounts ba ON ba.owner_user_id = ro.owner_user_id
        WHERE ro.id = $1`,
      [prepared.order.id],
    );
    expect(state.rows[0]).toEqual({
      balance_cents: '300',
      credit_status: 'credited',
      payment_status: 'succeeded',
      ledger_count: 1,
    });
  });

  it('keeps success terminal when callback commits before the pre-order response is saved', async () => {
    const prepared = await prepare('callback-first');
    await expect(
      repository.processNotification(
        notification(
          prepared.order,
          createHash('sha256').update(`${runId}:callback-first`).digest('hex'),
          `TRADE-PG-${runId}-FIRST`,
        ),
      ),
    ).resolves.toBe('processed');

    const late = await repository.recordSubmission(prepared.order.id, prepared.order.attemptNo, {
      status: 'pending',
      action: {
        kind: 'code_url',
        value: 'late-opaque-action',
        expiresAt: new Date(Date.now() + 15 * 60 * 1_000),
      },
    });
    expect(late).toMatchObject({
      paymentStatus: 'succeeded',
      creditStatus: 'credited',
      platformTradeNo: `TRADE-PG-${runId}-FIRST`,
    });
    const count = await pool.query<{ balance: string; ledger_count: number }>(
      `SELECT ba.balance_cents::text AS balance,
              count(wl.id)::int AS ledger_count
         FROM billing_accounts ba
         JOIN wallet_ledger wl ON wl.owner_user_id = ba.owner_user_id
        WHERE ba.owner_user_id = $1
        GROUP BY ba.balance_cents`,
      [ownerId],
    );
    expect(count.rows[0]).toEqual({ balance: '300', ledger_count: 1 });
  });

  it('0010 upgrade converts stored aggregate_qr rows and tightens the channel constraint', async () => {
    const client = await pool.connect();
    try {
      // 复刻 0010 的约束演进：旧 CHECK 只允许 h5/aggregate_qr → 迁移存量行 → 收紧为 h5/qr。
      await client.query(`
        CREATE TEMP TABLE recharge_orders_upgrade_test (
          id uuid PRIMARY KEY,
          payment_method text NOT NULL,
          CONSTRAINT ck_test_payment_method
            CHECK (payment_method IN ('h5', 'aggregate_qr'))
        )
      `);
      const legacyId = randomUUID();
      await client.query(
        `INSERT INTO recharge_orders_upgrade_test (id, payment_method)
         VALUES ($1, 'aggregate_qr')`,
        [legacyId],
      );
      await client.query(
        'ALTER TABLE recharge_orders_upgrade_test DROP CONSTRAINT ck_test_payment_method',
      );
      await client.query(
        `UPDATE recharge_orders_upgrade_test
            SET payment_method = 'qr'
          WHERE payment_method = 'aggregate_qr'`,
      );
      await client.query(
        `ALTER TABLE recharge_orders_upgrade_test
          ADD CONSTRAINT ck_test_payment_method CHECK (payment_method IN ('h5', 'qr'))`,
      );

      const converted = await client.query<{ payment_method: string }>(
        `SELECT payment_method FROM recharge_orders_upgrade_test WHERE id = $1`,
        [legacyId],
      );
      expect(converted.rows[0]?.payment_method).toBe('qr');

      await expect(
        client.query(
          `INSERT INTO recharge_orders_upgrade_test (id, payment_method) VALUES ($1, 'aggregate_qr')`,
          [randomUUID()],
        ),
      ).rejects.toThrow();
      await client.query(
        `INSERT INTO recharge_orders_upgrade_test (id, payment_method) VALUES ($1, 'qr')`,
        [randomUUID()],
      );
    } finally {
      client.release();
    }
  });
});
