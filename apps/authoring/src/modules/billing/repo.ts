import type { QueryableDb, Tx, TxPool } from '../../platform/infra/db-tx.js';
import { withTransaction } from '../../platform/infra/db-tx.js';
import type {
  PaymentQueryResult,
  PaymentSubmission,
  VerifiedPaymentNotification,
} from '../../platform/infra/leshouying/index.js';
import {
  BillingIdempotencyConflictError,
  BillingNotFoundError,
  BillingRateLimitedError,
  type BillingRepository,
  type LeasedRechargeOrder,
  type PrepareRechargeInput,
  type PrepareRechargeResult,
  type RechargeOrder,
  type WalletBalance,
} from './types.js';

interface RechargeOrderRow {
  id: string;
  order_no: string;
  owner_user_id: string;
  client_idempotency_key: string;
  package_id: string;
  amount_cents: string | number | bigint;
  payment_method: RechargeOrder['paymentMethod'];
  gateway_environment: RechargeOrder['gatewayEnvironment'];
  institution_no: string;
  merchant_no: string;
  pay_trace_no: string;
  pay_time: string;
  payment_status: RechargeOrder['paymentStatus'];
  credit_status: RechargeOrder['creditStatus'];
  platform_trade_no: string | null;
  attempt_no: string | number;
  request_fingerprint: string;
  action_kind: 'redirect_url' | 'code_url' | null;
  action_value: string | null;
  action_expires_at: string | Date | null;
  paid_at: string | Date | null;
  credited_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
  query_lease_owner?: string | null;
  query_attempt_count: string | number;
  next_query_at: string | Date | null;
}

const MAX_ACTIVE_RECHARGE_ORDERS_PER_OWNER = 3;
const MAX_RECHARGE_ORDERS_PER_OWNER_PER_HOUR = 10;
const MAX_RECONCILIATION_ATTEMPTS = 120;
const MAX_RECONCILIATION_AGE_MS = 24 * 60 * 60 * 1_000;

const ORDER_SELECT = `
  SELECT ro.id, ro.order_no, ro.owner_user_id, ro.client_idempotency_key,
         ro.package_id, ro.amount_cents, ro.payment_method, ro.gateway_environment,
         ro.institution_no, ro.merchant_no, ro.pay_trace_no, ro.pay_time,
         ro.payment_status, ro.credit_status, ro.platform_trade_no,
         pa.attempt_no, pa.request_fingerprint, pa.action_kind, pa.action_value,
         pa.action_expires_at, ro.paid_at, ro.credited_at, ro.created_at, ro.updated_at,
         ro.query_lease_owner, ro.query_attempt_count, ro.next_query_at
    FROM recharge_orders ro
    JOIN LATERAL (
      SELECT attempt_no, request_fingerprint, action_kind, action_value, action_expires_at
        FROM payment_attempts
       WHERE recharge_order_id = ro.id
       ORDER BY attempt_no DESC
       LIMIT 1
    ) pa ON true`;

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function toRechargeOrder(row: RechargeOrderRow, now = new Date()): RechargeOrder {
  const actionExpiresAt = row.action_expires_at ? toDate(row.action_expires_at) : undefined;
  const actionIsCurrent = actionExpiresAt && actionExpiresAt.getTime() > now.getTime();
  return {
    id: row.id,
    orderNo: row.order_no,
    ownerUserId: row.owner_user_id,
    clientIdempotencyKey: row.client_idempotency_key,
    packageId: row.package_id,
    amountCents: BigInt(row.amount_cents),
    paymentMethod: row.payment_method,
    gatewayEnvironment: row.gateway_environment,
    institutionNo: row.institution_no,
    merchantNo: row.merchant_no,
    payTraceNo: row.pay_trace_no,
    payTime: row.pay_time,
    paymentStatus: row.payment_status,
    creditStatus: row.credit_status,
    ...(row.platform_trade_no ? { platformTradeNo: row.platform_trade_no } : {}),
    attemptNo: Number(row.attempt_no),
    requestFingerprint: row.request_fingerprint,
    ...(row.action_kind && row.action_value && actionExpiresAt && actionIsCurrent
      ? {
          action: {
            kind: row.action_kind,
            value: row.action_value,
            expiresAt: actionExpiresAt,
          },
        }
      : {}),
    ...(row.paid_at ? { paidAt: toDate(row.paid_at) } : {}),
    ...(row.credited_at ? { creditedAt: toDate(row.credited_at) } : {}),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    reconciliationActive:
      row.next_query_at !== null &&
      row.credit_status === 'uncredited' &&
      ['created', 'pending', 'unknown'].includes(row.payment_status),
  };
}

async function selectOrderById(
  db: QueryableDb,
  orderId: string,
  ownerUserId?: string,
): Promise<RechargeOrder | null> {
  const result = await db.query<RechargeOrderRow>(
    `${ORDER_SELECT}
      WHERE ro.id = $1
        AND ($2::uuid IS NULL OR ro.owner_user_id = $2)`,
    [orderId, ownerUserId ?? null],
  );
  return result.rows[0] ? toRechargeOrder(result.rows[0]) : null;
}

async function selectOrderForUpdateByIntent(
  tx: Tx,
  ownerUserId: string,
  clientIdempotencyKey: string,
): Promise<RechargeOrder | null> {
  const result = await tx.query<RechargeOrderRow>(
    `${ORDER_SELECT}
      WHERE ro.owner_user_id = $1
        AND ro.client_idempotency_key = $2
      FOR UPDATE OF ro`,
    [ownerUserId, clientIdempotencyKey],
  );
  return result.rows[0] ? toRechargeOrder(result.rows[0]) : null;
}

async function selectOrderForUpdateById(tx: Tx, orderId: string): Promise<RechargeOrder | null> {
  const result = await tx.query<RechargeOrderRow>(
    `${ORDER_SELECT}
      WHERE ro.id = $1
      FOR UPDATE OF ro`,
    [orderId],
  );
  return result.rows[0] ? toRechargeOrder(result.rows[0]) : null;
}

async function selectOrderForUpdateByTrace(
  tx: Tx,
  payTraceNo: string,
  payTime: string,
): Promise<RechargeOrder | null> {
  const result = await tx.query<RechargeOrderRow>(
    `${ORDER_SELECT}
      WHERE ro.pay_trace_no = $1
        AND ro.pay_time = $2
      FOR UPDATE OF ro`,
    [payTraceNo, payTime],
  );
  return result.rows[0] ? toRechargeOrder(result.rows[0]) : null;
}

async function creditLockedOrder(
  tx: Tx,
  order: RechargeOrder,
  platformTradeNo: string,
  paidAt: Date | undefined,
): Promise<void> {
  if (order.platformTradeNo !== undefined && order.platformTradeNo !== platformTradeNo) {
    throw new BillingIdempotencyConflictError();
  }

  await tx.query(
    `UPDATE recharge_orders
        SET payment_status = 'succeeded',
            platform_trade_no = $2,
            paid_at = COALESCE(paid_at, $3, now()),
            next_query_at = NULL,
            query_lease_owner = NULL,
            query_lease_expires_at = NULL,
            updated_at = now()
      WHERE id = $1`,
    [order.id, platformTradeNo, paidAt ?? null],
  );
  await tx.query(
    `UPDATE payment_attempts
        SET status = 'succeeded',
            platform_trade_no = $2,
            completed_at = COALESCE(completed_at, now()),
            updated_at = now()
      WHERE recharge_order_id = $1
        AND attempt_no = $3`,
    [order.id, platformTradeNo, order.attemptNo],
  );

  if (order.creditStatus === 'credited') return;
  await tx.query(
    `INSERT INTO billing_accounts (owner_user_id, balance_cents, reserved_cents)
     VALUES ($1, $2, 0)
     ON CONFLICT (owner_user_id) DO UPDATE
       SET balance_cents = billing_accounts.balance_cents + EXCLUDED.balance_cents,
           updated_at = now()`,
    [order.ownerUserId, order.amountCents.toString()],
  );
  const ledger = await tx.query<{ id: string }>(
    `INSERT INTO wallet_ledger (
       owner_user_id, entry_type, amount_cents, recharge_order_id, usage_charge_id
     )
     VALUES ($1, 'recharge_credit', $2, $3, NULL)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [order.ownerUserId, order.amountCents.toString(), order.id],
  );
  if (ledger.rows.length !== 1) {
    throw new BillingIdempotencyConflictError();
  }
  await tx.query(
    `UPDATE recharge_orders
        SET credit_status = 'credited',
            credited_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [order.id],
  );
}

async function applyTrustedNonSuccessNotification(
  tx: Tx,
  order: RechargeOrder,
  notification: VerifiedPaymentNotification,
): Promise<void> {
  if (order.creditStatus === 'credited' || order.paymentStatus === 'succeeded') return;
  const status = notification.resultCode === 'PAY_FAIL' ? 'failed' : 'pending';
  await tx.query(
    `UPDATE recharge_orders
        SET payment_status = $2,
            platform_trade_no = COALESCE(platform_trade_no, $3),
            next_query_at = CASE
              WHEN $2 = 'pending' THEN now() + interval '5 seconds'
              ELSE NULL
            END,
            query_lease_owner = NULL,
            query_lease_expires_at = NULL,
            updated_at = now()
      WHERE id = $1
        AND credit_status = 'uncredited'
        AND payment_status <> 'succeeded'
        AND ($2 = 'failed' OR payment_status IN ('created', 'pending', 'unknown'))`,
    [order.id, status, notification.platformTradeNo],
  );
  await tx.query(
    `UPDATE payment_attempts
        SET status = $3,
            gateway_result_code = $4,
            platform_trade_no = COALESCE(platform_trade_no, $5),
            completed_at = CASE WHEN $3 = 'failed' THEN now() ELSE NULL END,
            updated_at = now()
      WHERE recharge_order_id = $1
        AND attempt_no = $2
        AND status IN ('submitting', 'pending', 'unknown')`,
    [order.id, order.attemptNo, status, notification.resultCode, notification.platformTradeNo],
  );
}

export class PgBillingRepository implements BillingRepository {
  constructor(
    private readonly pool: TxPool,
    private readonly db: QueryableDb,
  ) {}

  async getWallet(ownerUserId: string): Promise<WalletBalance> {
    const result = await this.db.query<{
      balance_cents: string | number | bigint;
      reserved_cents: string | number | bigint;
    }>(
      `SELECT balance_cents, reserved_cents
         FROM billing_accounts
        WHERE owner_user_id = $1`,
      [ownerUserId],
    );
    const row = result.rows[0];
    return row
      ? {
          availableCents: BigInt(row.balance_cents),
          reservedCents: BigInt(row.reserved_cents),
        }
      : { availableCents: 0n, reservedCents: 0n };
  }

  findRechargeOrder(ownerUserId: string, orderId: string): Promise<RechargeOrder | null> {
    return selectOrderById(this.db, orderId, ownerUserId);
  }

  async findRechargeOrderByIntent(
    ownerUserId: string,
    clientIdempotencyKey: string,
  ): Promise<RechargeOrder | null> {
    const result = await this.db.query<RechargeOrderRow>(
      `${ORDER_SELECT}
        WHERE ro.owner_user_id = $1
          AND ro.client_idempotency_key = $2`,
      [ownerUserId, clientIdempotencyKey],
    );
    return result.rows[0] ? toRechargeOrder(result.rows[0]) : null;
  }

  async prepareRecharge(input: PrepareRechargeInput): Promise<PrepareRechargeResult> {
    return withTransaction(this.pool, async (tx) => {
      const existing = await selectOrderForUpdateByIntent(
        tx,
        input.ownerUserId,
        input.clientIdempotencyKey,
      );
      if (existing) {
        if (
          existing.packageId !== input.packageId ||
          existing.amountCents !== input.amountCents ||
          existing.gatewayEnvironment !== input.gatewayEnvironment ||
          existing.institutionNo !== input.institutionNo ||
          existing.merchantNo !== input.merchantNo
        ) {
          throw new BillingIdempotencyConflictError();
        }
        if (existing.requestFingerprint !== input.requestFingerprint) {
          throw new BillingIdempotencyConflictError();
        }
        // The original POST may still be in flight. A repeated client request
        // only observes the existing row; the due-order lease owns crash
        // recovery after the configured transport timeout plus a safety margin.
        return { order: existing, shouldSubmit: false, created: false };
      }

      // A transaction-scoped owner lock makes admission deterministic across API
      // replicas. Re-check the intent after acquiring it because another request
      // may have committed the same intent while this transaction was waiting.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text, 0))`, [
        input.ownerUserId,
      ]);
      const racedExisting = await selectOrderForUpdateByIntent(
        tx,
        input.ownerUserId,
        input.clientIdempotencyKey,
      );
      if (racedExisting) {
        if (
          racedExisting.packageId !== input.packageId ||
          racedExisting.amountCents !== input.amountCents ||
          racedExisting.gatewayEnvironment !== input.gatewayEnvironment ||
          racedExisting.institutionNo !== input.institutionNo ||
          racedExisting.merchantNo !== input.merchantNo ||
          racedExisting.requestFingerprint !== input.requestFingerprint
        ) {
          throw new BillingIdempotencyConflictError();
        }
        return { order: racedExisting, shouldSubmit: false, created: false };
      }

      const admission = await tx.query<{
        active_count: string | number;
        recent_count: string | number;
      }>(
        `SELECT count(*) FILTER (
                  WHERE payment_status IN ('created', 'pending', 'unknown')
                    AND credit_status = 'uncredited'
                    AND next_query_at IS NOT NULL
                )::int AS active_count,
                count(*) FILTER (
                  WHERE created_at >= now() - interval '1 hour'
                )::int AS recent_count
           FROM recharge_orders
          WHERE owner_user_id = $1`,
        [input.ownerUserId],
      );
      const counts = admission.rows[0];
      if (Number(counts?.active_count ?? 0) >= MAX_ACTIVE_RECHARGE_ORDERS_PER_OWNER) {
        throw new BillingRateLimitedError(60);
      }
      if (Number(counts?.recent_count ?? 0) >= MAX_RECHARGE_ORDERS_PER_OWNER_PER_HOUR) {
        throw new BillingRateLimitedError(60 * 60);
      }

      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO recharge_orders (
           order_no, owner_user_id, client_idempotency_key, package_id, amount_cents,
           payment_method, gateway_environment, institution_no, merchant_no,
           pay_trace_no, pay_time, payment_status, credit_status, next_query_at
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
           'created', 'uncredited', now() + ($12 * interval '1 millisecond')
         )
         ON CONFLICT (owner_user_id, client_idempotency_key) DO NOTHING
         RETURNING id`,
        [
          input.orderNo,
          input.ownerUserId,
          input.clientIdempotencyKey,
          input.packageId,
          input.amountCents.toString(),
          input.paymentMethod,
          input.gatewayEnvironment,
          input.institutionNo,
          input.merchantNo,
          input.payTraceNo,
          input.payTime,
          input.submissionRecoveryMs,
        ],
      );
      const row = inserted.rows[0];
      if (!row) {
        const raced = await selectOrderForUpdateByIntent(
          tx,
          input.ownerUserId,
          input.clientIdempotencyKey,
        );
        if (!raced || raced.requestFingerprint !== input.requestFingerprint) {
          throw new BillingIdempotencyConflictError();
        }
        return { order: raced, shouldSubmit: false, created: false };
      }
      await tx.query(
        `INSERT INTO payment_attempts (
           recharge_order_id, attempt_no, status, request_fingerprint
         )
         VALUES ($1, 1, 'submitting', $2)`,
        [row.id, input.requestFingerprint],
      );
      const order = await selectOrderById(tx, row.id);
      if (!order) throw new BillingNotFoundError();
      return { order, shouldSubmit: true, created: true };
    });
  }

  async recordSubmission(
    orderId: string,
    attemptNo: number,
    submission: PaymentSubmission,
  ): Promise<RechargeOrder> {
    return withTransaction(this.pool, async (tx) => {
      const order = await selectOrderForUpdateById(tx, orderId);
      if (!order) throw new BillingNotFoundError();
      if (order.attemptNo !== attemptNo) return order;
      // 回调或查单可能在网关 POST 返回前先完成入账；成功状态只能单调前进，绝不降级。
      if (order.creditStatus === 'credited' || order.paymentStatus === 'succeeded') {
        return order;
      }
      if (
        order.platformTradeNo !== undefined &&
        submission.platformTradeNo !== undefined &&
        order.platformTradeNo !== submission.platformTradeNo
      ) {
        // A trusted callback or original-trace query may bind the platform order
        // while the pre-order POST is still in flight. That identity is write-once;
        // a contradictory late response is ignored as uncertain.
        return order;
      }
      const attemptStatus =
        submission.status === 'pending'
          ? 'pending'
          : submission.status === 'failed'
            ? 'failed'
            : 'unknown';
      await tx.query(
        `UPDATE payment_attempts
            SET status = CASE WHEN status = 'submitting' THEN $3 ELSE status END,
                gateway_result_code = COALESCE(gateway_result_code, $4),
                platform_trade_no = COALESCE(platform_trade_no, $5),
                action_kind = $6,
                action_value = $7,
                action_expires_at = $8,
                completed_at = CASE
                  WHEN status = 'submitting' AND $3 = 'failed' THEN now()
                  ELSE completed_at
                END,
                updated_at = now()
          WHERE recharge_order_id = $1
            AND attempt_no = $2
            AND status IN ('submitting', 'pending', 'unknown')
            AND completed_at IS NULL`,
        [
          orderId,
          attemptNo,
          attemptStatus,
          submission.gatewayResultCode ?? null,
          submission.platformTradeNo ?? null,
          submission.action?.kind ?? null,
          submission.action?.value ?? null,
          submission.action?.expiresAt ?? null,
        ],
      );
      await tx.query(
        `UPDATE recharge_orders
            SET payment_status = CASE
                  WHEN payment_status = 'created' THEN $2
                  ELSE payment_status
                END,
                platform_trade_no = COALESCE(platform_trade_no, $3),
                next_query_at = CASE
                  WHEN payment_status <> 'created' THEN next_query_at
                  WHEN $2 IN ('pending', 'unknown') THEN now() + interval '5 seconds'
                  ELSE NULL
                END,
                updated_at = now()
          WHERE id = $1
            AND credit_status = 'uncredited'
            AND payment_status IN ('created', 'pending', 'unknown')`,
        [orderId, submission.status, submission.platformTradeNo ?? null],
      );
      const updated = await selectOrderById(tx, orderId);
      if (!updated) throw new BillingNotFoundError();
      return updated;
    });
  }

  async recordSignedRejectedCallback(input: {
    eventFingerprint: string;
    rejectionCode: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO payment_callback_events (
         event_fingerprint, recharge_order_id, signature_valid, platform_trade_no,
         amount_cents, trade_status, processing_status, rejection_code, processed_at
       )
       VALUES ($1, NULL, true, NULL, NULL, NULL, 'rejected', $2, now())
       ON CONFLICT (event_fingerprint) DO NOTHING`,
      [input.eventFingerprint, input.rejectionCode],
    );
  }

  async processNotification(
    notification: VerifiedPaymentNotification,
  ): Promise<'processed' | 'duplicate' | 'rejected'> {
    return withTransaction(this.pool, async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO payment_callback_events (
           event_fingerprint, recharge_order_id, signature_valid, platform_trade_no,
           amount_cents, trade_status, processing_status
         )
         VALUES ($1, NULL, true, $2, $3, $4, 'received')
         ON CONFLICT (event_fingerprint) DO NOTHING
         RETURNING id`,
        [
          notification.eventFingerprint,
          notification.platformTradeNo,
          notification.amountCents.toString(),
          notification.resultCode,
        ],
      );
      if (!inserted.rows[0]) {
        const previous = await tx.query<{
          processing_status: 'processed' | 'rejected' | 'received';
        }>(
          `SELECT processing_status
             FROM payment_callback_events
            WHERE event_fingerprint = $1`,
          [notification.eventFingerprint],
        );
        return previous.rows[0]?.processing_status === 'processed' ? 'duplicate' : 'rejected';
      }

      const order = await selectOrderForUpdateByTrace(
        tx,
        notification.payTraceNo,
        notification.payTime,
      );
      let rejectionCode: string | undefined;
      if (!order) {
        rejectionCode = 'order_not_found';
      } else if (
        order.gatewayEnvironment !== notification.gatewayEnvironment ||
        order.institutionNo !== notification.institutionNo ||
        order.merchantNo !== notification.merchantNo
      ) {
        rejectionCode = 'merchant_mismatch';
      } else if (order.amountCents !== notification.amountCents) {
        rejectionCode = 'amount_mismatch';
      } else if (notification.attach && notification.attach !== order.orderNo) {
        rejectionCode = 'order_mismatch';
      } else if (
        notification.returnCode !== 'SUCCESS' ||
        !['PAY_SUCCESS', 'PAY_FAIL', 'PAY_IN_PROCESS'].includes(notification.resultCode) ||
        (notification.tradeType !== undefined && notification.tradeType !== '1')
      ) {
        rejectionCode = 'trade_not_successful';
      } else if (
        order.platformTradeNo !== undefined &&
        order.platformTradeNo !== notification.platformTradeNo
      ) {
        rejectionCode = 'platform_order_mismatch';
      }

      if (!order || rejectionCode) {
        await tx.query(
          `UPDATE payment_callback_events
              SET recharge_order_id = $2,
                  processing_status = 'rejected',
                  rejection_code = $3,
                  processed_at = now()
            WHERE event_fingerprint = $1`,
          [notification.eventFingerprint, order?.id ?? null, rejectionCode ?? 'order_not_found'],
        );
        return 'rejected';
      }

      if (notification.resultCode === 'PAY_SUCCESS') {
        await creditLockedOrder(tx, order, notification.platformTradeNo, notification.paidAt);
      } else {
        await applyTrustedNonSuccessNotification(tx, order, notification);
      }
      await tx.query(
        `UPDATE payment_callback_events
            SET recharge_order_id = $2,
                processing_status = 'processed',
                processed_at = now()
          WHERE event_fingerprint = $1`,
        [notification.eventFingerprint, order.id],
      );
      return 'processed';
    });
  }

  async leaseDueRechargeOrders(input: {
    leaseOwner: string;
    limit: number;
    leaseMs: number;
    gatewayEnvironment: RechargeOrder['gatewayEnvironment'];
    institutionNo: string;
    merchantNo: string;
  }): Promise<LeasedRechargeOrder[]> {
    return withTransaction(this.pool, async (tx) => {
      const leased = await tx.query<{ id: string }>(
        `WITH candidates AS (
           SELECT id
             FROM recharge_orders
            WHERE payment_status IN ('created', 'pending', 'unknown')
              AND credit_status = 'uncredited'
              AND next_query_at <= now()
              AND query_attempt_count < $4
              AND created_at > now() - ($5 * interval '1 millisecond')
              AND gateway_environment = $6
              AND institution_no = $7
              AND merchant_no = $8
              AND (query_lease_expires_at IS NULL OR query_lease_expires_at <= now())
            ORDER BY next_query_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT $1
         )
         UPDATE recharge_orders ro
            SET payment_status = CASE
                  WHEN ro.payment_status = 'created' THEN 'unknown'
                  ELSE ro.payment_status
                END,
                query_lease_owner = $2,
                query_lease_expires_at = now() + ($3 * interval '1 millisecond'),
                query_attempt_count = query_attempt_count + 1,
                last_queried_at = now(),
                updated_at = now()
           FROM candidates
          WHERE ro.id = candidates.id
         RETURNING ro.id`,
        [
          input.limit,
          input.leaseOwner,
          input.leaseMs,
          MAX_RECONCILIATION_ATTEMPTS,
          MAX_RECONCILIATION_AGE_MS,
          input.gatewayEnvironment,
          input.institutionNo,
          input.merchantNo,
        ],
      );
      const leasedIds = leased.rows.map((row) => row.id);
      if (leasedIds.length > 0) {
        await tx.query(
          `UPDATE payment_attempts
              SET status = 'unknown',
                  updated_at = now()
            WHERE recharge_order_id = ANY($1::uuid[])
              AND status = 'submitting'`,
          [leasedIds],
        );
      }
      const orders: LeasedRechargeOrder[] = [];
      for (const row of leased.rows) {
        const order = await selectOrderById(tx, row.id);
        if (order) orders.push({ ...order, queryLeaseOwner: input.leaseOwner });
      }
      return orders;
    });
  }

  async leaseRechargeOrderForOwner(input: {
    ownerUserId: string;
    orderId: string;
    leaseOwner: string;
    leaseMs: number;
  }): Promise<LeasedRechargeOrder | null> {
    return withTransaction(this.pool, async (tx) => {
      await tx.query(
        `UPDATE recharge_orders
            SET next_query_at = NULL,
                query_lease_owner = NULL,
                query_lease_expires_at = NULL,
                updated_at = now()
          WHERE id = $1
            AND owner_user_id = $2
            AND payment_status IN ('created', 'pending', 'unknown')
            AND credit_status = 'uncredited'
            AND next_query_at IS NOT NULL
            AND (query_lease_expires_at IS NULL OR query_lease_expires_at <= now())
            AND (
              query_attempt_count >= $3
              OR created_at <= now() - ($4 * interval '1 millisecond')
            )`,
        [input.orderId, input.ownerUserId, MAX_RECONCILIATION_ATTEMPTS, MAX_RECONCILIATION_AGE_MS],
      );
      const leased = await tx.query<{ id: string }>(
        `UPDATE recharge_orders
            SET payment_status = CASE
                  WHEN payment_status = 'created' THEN 'unknown'
                  ELSE payment_status
                END,
                query_lease_owner = $3,
                query_lease_expires_at = now() + ($4 * interval '1 millisecond'),
                query_attempt_count = query_attempt_count + 1,
                last_queried_at = now(),
                updated_at = now()
          WHERE id = $1
            AND owner_user_id = $2
            AND payment_status IN ('created', 'pending', 'unknown')
            AND credit_status = 'uncredited'
            AND next_query_at <= now()
            AND query_attempt_count < $5
            AND created_at > now() - ($6 * interval '1 millisecond')
            AND (query_lease_expires_at IS NULL OR query_lease_expires_at <= now())
         RETURNING id`,
        [
          input.orderId,
          input.ownerUserId,
          input.leaseOwner,
          input.leaseMs,
          MAX_RECONCILIATION_ATTEMPTS,
          MAX_RECONCILIATION_AGE_MS,
        ],
      );
      if (!leased.rows[0]) return null;
      await tx.query(
        `UPDATE payment_attempts
            SET status = 'unknown',
                updated_at = now()
          WHERE recharge_order_id = $1
            AND status = 'submitting'`,
        [input.orderId],
      );
      const order = await selectOrderById(tx, input.orderId, input.ownerUserId);
      return order ? { ...order, queryLeaseOwner: input.leaseOwner } : null;
    });
  }

  async retireExpiredReconciliations(input: { limit: number }): Promise<number> {
    const result = await this.db.query<{ id: string }>(
      `WITH retired AS (
         SELECT id
           FROM recharge_orders
          WHERE payment_status IN ('created', 'pending', 'unknown')
            AND credit_status = 'uncredited'
            AND next_query_at IS NOT NULL
            AND (query_lease_expires_at IS NULL OR query_lease_expires_at <= now())
            AND (
              query_attempt_count >= $2
              OR created_at <= now() - ($3 * interval '1 millisecond')
            )
          ORDER BY created_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE recharge_orders ro
          SET next_query_at = NULL,
              query_lease_owner = NULL,
              query_lease_expires_at = NULL,
              updated_at = now()
         FROM retired
        WHERE ro.id = retired.id
       RETURNING ro.id`,
      [input.limit, MAX_RECONCILIATION_ATTEMPTS, MAX_RECONCILIATION_AGE_MS],
    );
    return result.rows.length;
  }

  async clearExpiredPaymentActions(input: { limit: number }): Promise<number> {
    const result = await this.db.query<{ id: string }>(
      `WITH expired AS (
         SELECT id
           FROM payment_attempts
          WHERE action_value IS NOT NULL
            AND action_expires_at <= now()
          ORDER BY action_expires_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE payment_attempts pa
          SET action_kind = NULL,
              action_value = NULL,
              action_expires_at = NULL,
              updated_at = now()
         FROM expired
        WHERE pa.id = expired.id
       RETURNING pa.id`,
      [input.limit],
    );
    return result.rows.length;
  }

  async applyQueryResult(
    leasedOrder: LeasedRechargeOrder,
    result: PaymentQueryResult,
  ): Promise<void> {
    await withTransaction(this.pool, async (tx) => {
      const lockedResult = await tx.query<RechargeOrderRow>(
        `${ORDER_SELECT}
          WHERE ro.id = $1
            AND ro.query_lease_owner = $2
            AND ro.query_lease_expires_at > now()
          FOR UPDATE OF ro`,
        [leasedOrder.id, leasedOrder.queryLeaseOwner],
      );
      const order = lockedResult.rows[0] ? toRechargeOrder(lockedResult.rows[0]) : null;
      if (!order || order.creditStatus === 'credited') return;

      const identityChangedDuringQuery = leasedOrder.platformTradeNo !== order.platformTradeNo;
      const resultContradictsBoundIdentity =
        order.platformTradeNo !== undefined &&
        result.platformTradeNo !== undefined &&
        order.platformTradeNo !== result.platformTradeNo;
      if (identityChangedDuringQuery || resultContradictsBoundIdentity) {
        // A late POST can bind the platform order after this query lease was
        // acquired. Even a result without a trade number is now stale; never let
        // an older in-flight query replace the identity or terminate compensation.
        await tx.query(
          `UPDATE recharge_orders
              SET query_lease_owner = NULL,
                  query_lease_expires_at = NULL,
                  next_query_at = COALESCE(next_query_at, now() + interval '5 seconds'),
                  updated_at = now()
            WHERE id = $1
              AND query_lease_owner = $2`,
          [order.id, leasedOrder.queryLeaseOwner],
        );
        return;
      }

      if (result.status === 'succeeded' && result.platformTradeNo) {
        await creditLockedOrder(tx, order, result.platformTradeNo, result.paidAt);
        return;
      }
      const effectiveStatus = result.status === 'succeeded' ? 'unknown' : result.status;
      const nextDelaySeconds =
        effectiveStatus === 'pending' ? 15 : effectiveStatus === 'unknown' ? 60 : null;
      await tx.query(
        `UPDATE recharge_orders
            SET payment_status = $3,
                platform_trade_no = COALESCE(platform_trade_no, $4),
                next_query_at = CASE
                  WHEN $5::int IS NULL THEN NULL
                  ELSE now() + ($5 * interval '1 second')
                END,
                query_lease_owner = NULL,
                query_lease_expires_at = NULL,
                updated_at = now()
          WHERE id = $1
            AND query_lease_owner = $2`,
        [
          order.id,
          leasedOrder.queryLeaseOwner,
          effectiveStatus,
          result.platformTradeNo ?? null,
          nextDelaySeconds,
        ],
      );
      await tx.query(
        `UPDATE payment_attempts
            SET status = $3,
                gateway_result_code = $4,
                platform_trade_no = COALESCE(platform_trade_no, $5),
                completed_at = CASE WHEN $3 = 'failed' THEN now() ELSE completed_at END,
                updated_at = now()
          WHERE recharge_order_id = $1
            AND attempt_no = $2`,
        [
          order.id,
          order.attemptNo,
          effectiveStatus === 'pending' ? 'pending' : effectiveStatus,
          result.gatewayResultCode ?? null,
          result.platformTradeNo ?? null,
        ],
      );
    });
  }
}
