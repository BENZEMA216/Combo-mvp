import { describe, expect, it } from 'vitest';
import { PgBillingRepository } from '../modules/billing/repo.js';
import type { QueryableDb, TxConn, TxPool } from '../platform/infra/db-tx.js';

describe('billing PostgreSQL repository fences', () => {
  it('locks the explicit recovery, never locks an order, and inserts only the linked active intent', async () => {
    const statements: string[] = [];
    const ownerUserId = '00000000-0000-4000-8000-000000000041';
    const recoveryUsageId = '00000000-0000-4000-8000-000000000042';
    const rechargeIntentId = recoveryUsageId;
    const orderId = '00000000-0000-4000-8000-000000000043';
    const conn: TxConn = {
      async query<R>(sql: string) {
        statements.push(sql);
        if (sql.includes('FROM pending_usage_recoveries') && sql.includes('FOR UPDATE')) {
          return {
            rows: [
              {
                owner_user_id: ownerUserId,
                usage_id: recoveryUsageId,
                recovery_status: 'active',
                active_recharge_intent_id: rechargeIntentId,
                unit_price_cents: '1',
                expires_at: new Date('2026-09-08T00:00:00.000Z'),
                updated_at: new Date('2026-09-01T00:00:00.000Z'),
                is_unexpired: true,
              },
            ] as R[],
            rowCount: 1,
          };
        }
        if (sql.includes('FOR UPDATE OF ro')) return { rows: [] as R[], rowCount: 0 };
        if (sql.includes('count(*) FILTER')) {
          return { rows: [{ active_count: 0, recent_count: 0 }] as R[], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO recharge_orders')) {
          return { rows: [{ id: orderId }] as R[], rowCount: 1 };
        }
        if (sql.includes('WHERE ro.id = $1')) {
          return {
            rows: [
              {
                id: orderId,
                order_no: 'CBR-RECOVERY',
                owner_user_id: ownerUserId,
                client_idempotency_key: rechargeIntentId,
                recovery_usage_id: recoveryUsageId,
                package_id: 'manual',
                amount_cents: '1',
                payment_method: 'qr',
                pay_type: 'alipay',
                gateway_environment: 'test',
                institution_no: 'INST0001',
                merchant_no: 'MCH_TEST_001',
                pay_trace_no: 'TRACE-RECOVERY',
                pay_time: '20260901120000',
                payment_status: 'created',
                credit_status: 'uncredited',
                platform_trade_no: null,
                attempt_no: 1,
                request_fingerprint: 'a'.repeat(64),
                action_kind: null,
                action_value: null,
                action_expires_at: null,
                paid_at: null,
                credited_at: null,
                created_at: new Date('2026-09-01T00:00:00.000Z'),
                updated_at: new Date('2026-09-01T00:00:00.000Z'),
                query_lease_owner: null,
                query_attempt_count: 0,
                next_query_at: new Date('2026-09-01T00:00:10.000Z'),
              },
            ] as R[],
            rowCount: 1,
          };
        }
        return { rows: [] as R[], rowCount: null };
      },
      release() {},
    };
    const repository = new PgBillingRepository({ connect: async () => conn }, conn as QueryableDb);

    await repository.prepareRecharge({
      orderNo: 'CBR-RECOVERY',
      ownerUserId,
      recoveryUsageId,
      clientIdempotencyKey: rechargeIntentId,
      packageId: 'manual',
      amountCents: 1n,
      paymentMethod: 'qr',
      payType: 'alipay',
      gatewayEnvironment: 'test',
      institutionNo: 'INST0001',
      merchantNo: 'MCH_TEST_001',
      payTraceNo: 'TRACE-RECOVERY',
      payTime: '20260901120000',
      requestFingerprint: 'a'.repeat(64),
      submissionRecoveryMs: 10_000,
    } as never);

    const recoveryLock = statements.findIndex((sql) =>
      sql.includes("$1::uuid::text || ':' || $2::uuid::text"),
    );
    const pendingLock = statements.findIndex(
      (sql) => sql.includes('FROM pending_usage_recoveries') && sql.includes('FOR UPDATE'),
    );
    expect(recoveryLock).toBeGreaterThan(statements.indexOf('BEGIN'));
    expect(pendingLock).toBeGreaterThan(recoveryLock);
    expect(statements.some((sql) => sql.includes('FOR UPDATE OF ro'))).toBe(false);
    expect(statements.find((sql) => sql.includes('INSERT INTO recharge_orders'))).toContain(
      'recovery_usage_id',
    );
  });

  it('locks the order first and never downgrades a callback-confirmed payment', async () => {
    const statements: string[] = [];
    const conn: TxConn = {
      async query<R>(sql: string) {
        statements.push(sql);
        if (sql.includes('FOR UPDATE OF ro')) {
          return {
            rows: [
              {
                id: '00000000-0000-4000-8000-000000000001',
                order_no: 'CBR-RACE',
                owner_user_id: '00000000-0000-4000-8000-000000000002',
                client_idempotency_key: '00000000-0000-4000-8000-000000000003',
                package_id: 'manual',
                amount_cents: '300',
                payment_method: 'qr',
                gateway_environment: 'test',
                institution_no: 'INST0001',
                merchant_no: 'MCH_TEST_001',
                pay_trace_no: 'TRACE-RACE',
                pay_time: '20260728120000',
                payment_status: 'succeeded',
                credit_status: 'credited',
                platform_trade_no: 'TRADE-RACE',
                attempt_no: 1,
                request_fingerprint: 'a'.repeat(64),
                action_kind: null,
                action_value: null,
                action_expires_at: null,
                paid_at: new Date('2026-07-28T04:01:00.000Z'),
                credited_at: new Date('2026-07-28T04:01:00.000Z'),
                created_at: new Date('2026-07-28T04:00:00.000Z'),
                updated_at: new Date('2026-07-28T04:01:00.000Z'),
                query_lease_owner: null,
                query_attempt_count: 1,
                next_query_at: null,
              },
            ] as R[],
            rowCount: 1,
          };
        }
        return { rows: [] as R[], rowCount: null };
      },
      release() {},
    };
    const pool: TxPool = { connect: async () => conn };
    const repository = new PgBillingRepository(pool, conn as QueryableDb);

    const result = await repository.recordSubmission('00000000-0000-4000-8000-000000000001', 1, {
      status: 'pending',
      action: {
        kind: 'code_url',
        value: 'opaque-action',
        expiresAt: new Date('2026-07-28T04:15:00.000Z'),
      },
    });

    expect(result).toMatchObject({
      paymentStatus: 'succeeded',
      creditStatus: 'credited',
      platformTradeNo: 'TRADE-RACE',
    });
    const lockIndex = statements.findIndex((sql) => sql.includes('FOR UPDATE OF ro'));
    expect(lockIndex).toBeGreaterThan(statements.findIndex((sql) => sql === 'BEGIN'));
    expect(statements.some((sql) => sql.includes('UPDATE payment_attempts'))).toBe(false);
    expect(statements.some((sql) => sql.includes('UPDATE recharge_orders'))).toBe(false);
  });

  it('ignores a late pre-order response that contradicts an already bound platform order', async () => {
    const statements: string[] = [];
    const conn: TxConn = {
      async query<R>(sql: string) {
        statements.push(sql);
        if (sql.includes('FOR UPDATE OF ro')) {
          return {
            rows: [
              {
                id: '00000000-0000-4000-8000-000000000011',
                order_no: 'CBR-PENDING-RACE',
                owner_user_id: '00000000-0000-4000-8000-000000000012',
                client_idempotency_key: '00000000-0000-4000-8000-000000000013',
                package_id: 'manual',
                amount_cents: '300',
                payment_method: 'qr',
                gateway_environment: 'test',
                institution_no: 'INST0001',
                merchant_no: 'MCH_TEST_001',
                pay_trace_no: 'TRACE-PENDING-RACE',
                pay_time: '20260728120000',
                payment_status: 'pending',
                credit_status: 'uncredited',
                platform_trade_no: 'TRADE-BOUND-FIRST',
                attempt_no: 1,
                request_fingerprint: 'b'.repeat(64),
                action_kind: null,
                action_value: null,
                action_expires_at: null,
                paid_at: null,
                credited_at: null,
                created_at: new Date('2026-07-28T04:00:00.000Z'),
                updated_at: new Date('2026-07-28T04:01:00.000Z'),
                query_lease_owner: null,
                query_attempt_count: 1,
                next_query_at: new Date('2026-07-28T04:02:00.000Z'),
              },
            ] as R[],
            rowCount: 1,
          };
        }
        return { rows: [] as R[], rowCount: null };
      },
      release() {},
    };
    const repository = new PgBillingRepository({ connect: async () => conn }, conn as QueryableDb);

    await expect(
      repository.recordSubmission('00000000-0000-4000-8000-000000000011', 1, {
        status: 'pending',
        platformTradeNo: 'TRADE-CONTRADICTORY-LATE',
      }),
    ).resolves.toMatchObject({ platformTradeNo: 'TRADE-BOUND-FIRST' });
    expect(statements.some((sql) => sql.includes('UPDATE payment_attempts'))).toBe(false);
    expect(statements.some((sql) => sql.includes('UPDATE recharge_orders'))).toBe(false);
  });

  it('discards a query result when the platform identity changed after the lease snapshot', async () => {
    const statements: string[] = [];
    const conn: TxConn = {
      async query<R>(sql: string) {
        statements.push(sql);
        if (sql.includes('ro.query_lease_owner = $2')) {
          return {
            rows: [
              {
                id: '00000000-0000-4000-8000-000000000021',
                order_no: 'CBR-QUERY-RACE',
                owner_user_id: '00000000-0000-4000-8000-000000000022',
                client_idempotency_key: '00000000-0000-4000-8000-000000000023',
                package_id: 'manual',
                amount_cents: '300',
                payment_method: 'qr',
                gateway_environment: 'test',
                institution_no: 'INST0001',
                merchant_no: 'MCH_TEST_001',
                pay_trace_no: 'TRACE-QUERY-RACE',
                pay_time: '20260728120000',
                payment_status: 'pending',
                credit_status: 'uncredited',
                platform_trade_no: 'TRADE-BOUND-AFTER-LEASE',
                attempt_no: 1,
                request_fingerprint: 'c'.repeat(64),
                action_kind: null,
                action_value: null,
                action_expires_at: null,
                paid_at: null,
                credited_at: null,
                created_at: new Date('2026-07-28T04:00:00.000Z'),
                updated_at: new Date('2026-07-28T04:01:00.000Z'),
                query_lease_owner: 'query-race-owner',
                query_attempt_count: 1,
                next_query_at: new Date('2026-07-28T04:02:00.000Z'),
              },
            ] as R[],
            rowCount: 1,
          };
        }
        return { rows: [] as R[], rowCount: null };
      },
      release() {},
    };
    const repository = new PgBillingRepository({ connect: async () => conn }, conn as QueryableDb);

    await repository.applyQueryResult(
      {
        id: '00000000-0000-4000-8000-000000000021',
        orderNo: 'CBR-QUERY-RACE',
        ownerUserId: '00000000-0000-4000-8000-000000000022',
        clientIdempotencyKey: '00000000-0000-4000-8000-000000000023',
        packageId: 'manual',
        amountCents: 300n,
        paymentMethod: 'qr',
        gatewayEnvironment: 'test',
        institutionNo: 'INST0001',
        merchantNo: 'MCH_TEST_001',
        payTraceNo: 'TRACE-QUERY-RACE',
        payTime: '20260728120000',
        paymentStatus: 'unknown',
        creditStatus: 'uncredited',
        attemptNo: 1,
        requestFingerprint: 'c'.repeat(64),
        createdAt: new Date('2026-07-28T04:00:00.000Z'),
        updatedAt: new Date('2026-07-28T04:00:00.000Z'),
        reconciliationActive: true,
        queryLeaseOwner: 'query-race-owner',
      },
      { status: 'failed', gatewayResultCode: 'PAY_FAIL' },
    );

    expect(statements.some((sql) => sql.includes('SET query_lease_owner = NULL'))).toBe(true);
    expect(statements.some((sql) => sql.includes('SET payment_status = $3'))).toBe(false);
    expect(statements.some((sql) => sql.includes('UPDATE payment_attempts'))).toBe(false);
  });
});
