// PostgreSQL 事实源实现：SQL 与 db/v2-migrations/0013_v2_billing.sql 一一对应。
// 每个写方法内部一个事务；钱包行锁（FOR UPDATE）把同一用户的并发计费串行化。
// bigint 列经 Number() 收窄为安全整数，入参在应用层已校验范围。
import { type Pool, type PoolClient } from 'pg';
import {
  ledgerIdempotencyKeys,
  splitDeduction,
  type BillingStore,
  type HoldOutcome,
  type HoldView,
  type MeteringEventInput,
  type RechargeOutcome,
  type SettleOutcome,
  type WalletView,
} from './service.js';

export interface QueryResultLike<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number | null;
}

/** 仅依赖 query 的最小 DB 句柄（pg 子集），事务内/池层通用。 */
export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResultLike<R>>;
}

async function withTransaction<T>(pool: Pool, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

interface WalletRow {
  user_id: string;
  principal_balance: string;
  bonus_balance: string;
  held_amount: string;
}

interface HoldRow {
  id: string;
  user_id: string;
  agent_id: string;
  turn_id: string;
  estimated_amount: string;
  actual_amount: string | null;
  status: HoldView['status'];
  expires_at: Date;
}

function toWallet(row: WalletRow): WalletView {
  return {
    userId: row.user_id,
    principalBalance: Number(row.principal_balance),
    bonusBalance: Number(row.bonus_balance),
    heldAmount: Number(row.held_amount),
  };
}

function toHold(row: HoldRow): HoldView {
  return {
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id,
    turnId: row.turn_id,
    estimatedAmount: Number(row.estimated_amount),
    actualAmount: row.actual_amount === null ? null : Number(row.actual_amount),
    status: row.status,
    expiresAt: row.expires_at,
  };
}

async function lockWallet(tx: Queryable, userId: string): Promise<WalletView> {
  // 首次计费动作时建行；ON CONFLICT 并发安全，随后行锁串行化本用户的钱包变更。
  await tx.query(`INSERT INTO v2_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [
    userId,
  ]);
  const found = await tx.query<WalletRow>(
    `SELECT user_id, principal_balance, bonus_balance, held_amount
       FROM v2_wallets WHERE user_id = $1 FOR UPDATE`,
    [userId],
  );
  const row = found.rows[0];
  if (!row) throw new Error('wallet row missing after upsert');
  return toWallet(row);
}

async function readWalletIn(tx: Queryable, userId: string): Promise<WalletView | null> {
  const found = await tx.query<WalletRow>(
    `SELECT user_id, principal_balance, bonus_balance, held_amount
       FROM v2_wallets WHERE user_id = $1`,
    [userId],
  );
  return found.rows[0] ? toWallet(found.rows[0]) : null;
}

async function findHoldByTurn(tx: Queryable, agentId: string, turnId: string) {
  const found = await tx.query<HoldRow>(
    `SELECT id, user_id, agent_id, turn_id, estimated_amount, actual_amount, status, expires_at
       FROM v2_holds WHERE agent_id = $1 AND turn_id = $2 LIMIT 1`,
    [agentId, turnId],
  );
  return found.rows[0] ? toHold(found.rows[0]) : null;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === '23505';
}

export function createPgBillingStore(pool: Pool): BillingStore {
  return {
    async readWallet(userId) {
      return readWalletIn(pool, userId);
    },

    async createHold({ userId, agentId, turnId, estimatedAmount, overdraftHardLimitCents }) {
      try {
        return await withTransaction(pool, async (tx): Promise<HoldOutcome> => {
          const existing = await findHoldByTurn(tx, agentId, turnId);
          if (existing) {
            const wallet = await readWalletIn(tx, userId);
            if (!wallet) throw new Error('hold references a missing wallet');
            return { kind: 'held', hold: existing, wallet, replayed: true };
          }

          const wallet = await lockWallet(tx, userId);
          const net = wallet.principalBalance + wallet.bonusBalance;
          if (net < -overdraftHardLimitCents) {
            return { kind: 'overdraft_blocked', wallet };
          }
          const available = net - wallet.heldAmount;
          if (available < estimatedAmount) {
            return { kind: 'insufficient', wallet };
          }

          const inserted = await tx.query<HoldRow>(
            `INSERT INTO v2_holds (user_id, agent_id, turn_id, estimated_amount, expires_at)
             VALUES ($1, $2, $3, $4, now() + interval '5 minutes')
             RETURNING id, user_id, agent_id, turn_id, estimated_amount, actual_amount, status, expires_at`,
            [userId, agentId, turnId, estimatedAmount],
          );
          const hold = toHold(inserted.rows[0]!);

          const updated = await tx.query<WalletRow>(
            `UPDATE v2_wallets
                SET held_amount = held_amount + $2, updated_at = now()
              WHERE user_id = $1
              RETURNING user_id, principal_balance, bonus_balance, held_amount`,
            [userId, estimatedAmount],
          );
          await tx.query(
            `INSERT INTO v2_ledger (user_id, kind, bucket, amount, ref_id, idempotency_key)
             VALUES ($1, 'hold', NULL, $2, $3, $4)`,
            [userId, estimatedAmount, hold.id, ledgerIdempotencyKeys.hold(agentId, turnId)],
          );
          return { kind: 'held', hold, wallet: toWallet(updated.rows[0]!), replayed: false };
        });
      } catch (error) {
        // 并发同 turn 撞唯一约束：胜出事务的行就是幂等答案。
        if (!isUniqueViolation(error)) throw error;
        const hold = await findHoldByTurn(pool, agentId, turnId);
        const wallet = await readWalletIn(pool, userId);
        if (!hold || !wallet) throw error;
        return { kind: 'held', hold, wallet, replayed: true };
      }
    },

    async settleHold({ holdId, actualAmount }) {
      return withTransaction(pool, async (tx): Promise<SettleOutcome> => {
        const found = await tx.query<HoldRow>(
          `SELECT id, user_id, agent_id, turn_id, estimated_amount, actual_amount, status, expires_at
             FROM v2_holds WHERE id = $1 FOR UPDATE`,
          [holdId],
        );
        const row = found.rows[0];
        if (!row) return { kind: 'not_found' };
        const hold = toHold(row);

        if (hold.status === 'settled') {
          const wallet = await readWalletIn(tx, hold.userId);
          if (!wallet) throw new Error('hold references a missing wallet');
          // 重放返回原扣减明细，保证重复 settle 的响应与首次一致。
          const ledger = await tx.query<{ bucket: string; total: string }>(
            `SELECT bucket, sum(-amount) AS total FROM v2_ledger
              WHERE ref_id = $1 AND kind = 'consume' GROUP BY bucket`,
            [hold.id],
          );
          const deductions = { bonus: 0, principal: 0 };
          for (const entry of ledger.rows) {
            if (entry.bucket === 'bonus') deductions.bonus = Number(entry.total);
            if (entry.bucket === 'principal') deductions.principal = Number(entry.total);
          }
          return {
            kind: 'settled',
            hold,
            wallet,
            deductions,
            estimatedUsageRecorded: false,
            replayed: true,
          };
        }
        if (hold.status !== 'held') return { kind: 'invalid_state', hold };

        const wallet = await lockWallet(tx, hold.userId);
        const deductions = splitDeduction(wallet, actualAmount);
        const updated = await tx.query<WalletRow>(
          `UPDATE v2_wallets
              SET principal_balance = principal_balance - $2,
                  bonus_balance = bonus_balance - $3,
                  held_amount = held_amount - $4,
                  updated_at = now()
            WHERE user_id = $1
            RETURNING user_id, principal_balance, bonus_balance, held_amount`,
          [hold.userId, deductions.principal, deductions.bonus, hold.estimatedAmount],
        );

        // 先赠后本各落一条扣减流水；解冻差额不另落账（hold 行终态即凭证）。
        if (deductions.bonus > 0) {
          await tx.query(
            `INSERT INTO v2_ledger (user_id, kind, bucket, amount, ref_id, idempotency_key)
             VALUES ($1, 'consume', 'bonus', $2, $3, $4)`,
            [
              hold.userId,
              -deductions.bonus,
              hold.id,
              ledgerIdempotencyKeys.settle(hold.id, 'bonus'),
            ],
          );
        }
        if (deductions.principal > 0) {
          await tx.query(
            `INSERT INTO v2_ledger (user_id, kind, bucket, amount, ref_id, idempotency_key)
             VALUES ($1, 'consume', 'principal', $2, $3, $4)`,
            [
              hold.userId,
              -deductions.principal,
              hold.id,
              ledgerIdempotencyKeys.settle(hold.id, 'principal'),
            ],
          );
        }

        // usage 缺失时按估算扣并补一条 source=estimated 的计量兜底行。
        const usage = await tx.query<{ count: string }>(
          `SELECT count(*) AS count FROM v2_metering_events
            WHERE agent_id = $1 AND turn_id = $2`,
          [hold.agentId, hold.turnId],
        );
        const estimatedUsageRecorded = Number(usage.rows[0]!.count) === 0 && actualAmount > 0;
        if (estimatedUsageRecorded) {
          await tx.query(
            `INSERT INTO v2_metering_events (agent_id, user_id, turn_id, hold_id, quantity, source)
             VALUES ($1, $2, $3, $4, $5, 'estimated')`,
            [hold.agentId, hold.userId, hold.turnId, hold.id, actualAmount],
          );
        }

        const settled = await tx.query<HoldRow>(
          `UPDATE v2_holds
              SET status = 'settled', actual_amount = $2, settled_at = now()
            WHERE id = $1
            RETURNING id, user_id, agent_id, turn_id, estimated_amount, actual_amount, status, expires_at`,
          [holdId, actualAmount],
        );
        return {
          kind: 'settled',
          hold: toHold(settled.rows[0]!),
          wallet: toWallet(updated.rows[0]!),
          deductions,
          estimatedUsageRecorded,
          replayed: false,
        };
      });
    },

    async insertMeteringEvent(input: MeteringEventInput) {
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO v2_metering_events
           (agent_id, user_id, turn_id, hold_id, dimension, quantity, model, unit_cost, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          input.agentId,
          input.userId,
          input.turnId,
          input.holdId ?? null,
          input.dimension,
          input.quantity,
          input.model ?? null,
          input.unitCost ?? null,
          input.source,
        ],
      );
      return { id: inserted.rows[0]!.id };
    },

    async adminRecharge({ userId, amount, idempotencyKey, refId }) {
      try {
        return await withTransaction(pool, async (tx): Promise<RechargeOutcome> => {
          await lockWallet(tx, userId);
          const updated = await tx.query<WalletRow>(
            `UPDATE v2_wallets
                SET principal_balance = principal_balance + $2, updated_at = now()
              WHERE user_id = $1
              RETURNING user_id, principal_balance, bonus_balance, held_amount`,
            [userId, amount],
          );
          await tx.query(
            `INSERT INTO v2_ledger (user_id, kind, bucket, amount, ref_id, idempotency_key)
             VALUES ($1, 'recharge', 'principal', $2, $3, $4)`,
            [userId, amount, refId ?? null, idempotencyKey],
          );
          return { kind: 'credited', wallet: toWallet(updated.rows[0]!), replayed: false };
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const wallet = await readWalletIn(pool, userId);
        if (!wallet) throw error;
        return { kind: 'credited', wallet, replayed: true };
      }
    },

    async sweepExpiredHolds({ limit }) {
      return withTransaction(pool, async (tx) => {
        const expired = await tx.query<HoldRow>(
          `SELECT id, user_id, agent_id, turn_id, estimated_amount, actual_amount, status, expires_at
             FROM v2_holds
            WHERE status = 'held' AND expires_at <= now()
            ORDER BY expires_at
            LIMIT $1
            FOR UPDATE SKIP LOCKED`,
          [limit],
        );
        for (const row of expired.rows) {
          const hold = toHold(row);
          await tx.query(`UPDATE v2_holds SET status = 'expired' WHERE id = $1`, [hold.id]);
          await tx.query(
            `UPDATE v2_wallets
                SET held_amount = held_amount - $2, updated_at = now()
              WHERE user_id = $1`,
            [hold.userId, hold.estimatedAmount],
          );
          await tx.query(
            `INSERT INTO v2_ledger (user_id, kind, bucket, amount, ref_id, idempotency_key)
             VALUES ($1, 'release', NULL, $2, $3, $4)`,
            [hold.userId, hold.estimatedAmount, hold.id, ledgerIdempotencyKeys.release(hold.id)],
          );
        }
        return expired.rows.length;
      });
    },
  };
}
