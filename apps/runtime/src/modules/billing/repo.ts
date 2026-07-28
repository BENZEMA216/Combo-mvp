import type { Queryable } from '../../platform/infra/db.js';

export type UsageChargeSource = 'owner' | 'free' | 'wallet';
export type UsageChargeStatus = 'reserved' | 'completed' | 'released';

interface UsageChargeDbRow {
  id: string;
  owner_user_id: string;
  usage_id: string;
  capability_id: string;
  session_id: string;
  turn_id: string;
  request_fingerprint: string;
  charge_source: UsageChargeSource;
  status: UsageChargeStatus;
  unit_price_cents: string | number | bigint;
  free_limit_snapshot: number;
  reserved_cents: string | number | bigint;
  settled_cents: string | number | bigint;
}

export interface UsageChargeRecord {
  id: string;
  ownerUserId: string;
  usageId: string;
  capabilityId: string;
  sessionId: string;
  turnId: string;
  requestFingerprint: string;
  chargeSource: UsageChargeSource;
  status: UsageChargeStatus;
  unitPriceCents: bigint;
  freeLimitSnapshot: number;
  reservedCents: bigint;
  settledCents: bigint;
}

export interface BillingAccountBalance {
  balanceCents: bigint;
  reservedCents: bigint;
}

export interface FreeAllowance {
  policyVersion: string;
  freeLimitSnapshot: number;
  freeUsedCount: number;
  freeReservedCount: number;
}

function toNonNegativeBigInt(value: string | number | bigint, field: string): bigint {
  let parsed: bigint;
  try {
    parsed = typeof value === 'bigint' ? value : BigInt(value);
  } catch {
    throw new Error(`invalid ${field}`);
  }
  if (parsed < 0n) throw new Error(`invalid ${field}`);
  return parsed;
}

function toUsageCharge(row: UsageChargeDbRow): UsageChargeRecord {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    usageId: row.usage_id,
    capabilityId: row.capability_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    requestFingerprint: row.request_fingerprint,
    chargeSource: row.charge_source,
    status: row.status,
    unitPriceCents: toNonNegativeBigInt(row.unit_price_cents, 'unit_price_cents'),
    freeLimitSnapshot: row.free_limit_snapshot,
    reservedCents: toNonNegativeBigInt(row.reserved_cents, 'reserved_cents'),
    settledCents: toNonNegativeBigInt(row.settled_cents, 'settled_cents'),
  };
}

/**
 * 同一用户的 usageId 在所有 Session 间共用事务级锁。它避免两个并发事务先后
 * 修改免费额度或钱包后才撞唯一约束，也让重试可以稳定读取首个 Turn。
 */
export async function lockUsageId(
  db: Queryable,
  ownerUserId: string,
  usageId: string,
): Promise<void> {
  await db.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended($1 || ':' || $2::uuid::text, 0)
     )`,
    [ownerUserId, usageId],
  );
}

export async function findUsageCharge(
  db: Queryable,
  ownerUserId: string,
  usageId: string,
): Promise<UsageChargeRecord | null> {
  const result = await db.query<UsageChargeDbRow>(
    `SELECT id, owner_user_id, usage_id, capability_id, session_id, turn_id,
            request_fingerprint, charge_source, status, unit_price_cents,
            free_limit_snapshot, reserved_cents, settled_cents
       FROM usage_charges
      WHERE owner_user_id = $1 AND usage_id = $2
      FOR UPDATE`,
    [ownerUserId, usageId],
  );
  const row = result.rows[0];
  return row ? toUsageCharge(row) : null;
}

/** 每个使用者都拥有一条全局钱包行；零余额账户也为免费额度提供稳定外键与锁。 */
export async function ensureAndLockBillingAccount(
  db: Queryable,
  ownerUserId: string,
): Promise<BillingAccountBalance> {
  await db.query(
    `INSERT INTO billing_accounts (owner_user_id)
     VALUES ($1)
     ON CONFLICT (owner_user_id) DO NOTHING`,
    [ownerUserId],
  );
  const result = await db.query<{
    balance_cents: string | number | bigint;
    reserved_cents: string | number | bigint;
  }>(
    `SELECT balance_cents, reserved_cents
       FROM billing_accounts
      WHERE owner_user_id = $1
      FOR UPDATE`,
    [ownerUserId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('billing account disappeared');
  return {
    balanceCents: toNonNegativeBigInt(row.balance_cents, 'balance_cents'),
    reservedCents: toNonNegativeBigInt(row.reserved_cents, 'reserved_cents'),
  };
}

export async function ensureAndLockFreeAllowance(
  db: Queryable,
  input: {
    ownerUserId: string;
    capabilityId: string;
    policyVersion: string;
    freeLimit: number;
  },
): Promise<FreeAllowance> {
  await db.query(
    `INSERT INTO billing_free_allowances
       (owner_user_id, capability_id, policy_version, free_limit_snapshot)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (owner_user_id, capability_id) DO NOTHING`,
    [input.ownerUserId, input.capabilityId, input.policyVersion, input.freeLimit],
  );
  const result = await db.query<{
    policy_version: string;
    free_limit_snapshot: number;
    free_used_count: number;
    free_reserved_count: number;
  }>(
    `SELECT policy_version, free_limit_snapshot, free_used_count, free_reserved_count
       FROM billing_free_allowances
      WHERE owner_user_id = $1 AND capability_id = $2
      FOR UPDATE`,
    [input.ownerUserId, input.capabilityId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('free allowance disappeared');
  return {
    policyVersion: row.policy_version,
    freeLimitSnapshot: row.free_limit_snapshot,
    freeUsedCount: row.free_used_count,
    freeReservedCount: row.free_reserved_count,
  };
}

export async function insertReservedUsageCharge(
  db: Queryable,
  input: {
    ownerUserId: string;
    usageId: string;
    capabilityId: string;
    sessionId: string;
    turnId: string;
    requestFingerprint: string;
    chargeSource: UsageChargeSource;
    unitPriceCents: bigint;
    freeLimitSnapshot: number;
    reservedCents: bigint;
  },
): Promise<string> {
  if (input.chargeSource === 'free') {
    const allowance = await db.query(
      `UPDATE billing_free_allowances
          SET free_reserved_count = free_reserved_count + 1, updated_at = now()
        WHERE owner_user_id = $1 AND capability_id = $2
          AND free_used_count + free_reserved_count < free_limit_snapshot`,
      [input.ownerUserId, input.capabilityId],
    );
    if (allowance.rowCount !== 1) throw new Error('free allowance reservation was lost');
  } else if (input.chargeSource === 'wallet') {
    const account = await db.query(
      `UPDATE billing_accounts
          SET balance_cents = balance_cents - $2::bigint,
              reserved_cents = reserved_cents + $2::bigint,
              updated_at = now()
        WHERE owner_user_id = $1 AND balance_cents >= $2::bigint`,
      [input.ownerUserId, input.reservedCents.toString()],
    );
    if (account.rowCount !== 1) throw new Error('wallet reservation was lost');
  }

  const result = await db.query<{ id: string }>(
    `INSERT INTO usage_charges
       (owner_user_id, usage_id, capability_id, session_id, turn_id,
        request_fingerprint, charge_source, status, unit_price_cents,
        free_limit_snapshot, reserved_cents, settled_cents)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved', $8::bigint, $9, $10::bigint, 0)
     RETURNING id`,
    [
      input.ownerUserId,
      input.usageId,
      input.capabilityId,
      input.sessionId,
      input.turnId,
      input.requestFingerprint,
      input.chargeSource,
      input.unitPriceCents.toString(),
      input.freeLimitSnapshot,
      input.reservedCents.toString(),
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('usage charge insert returned no row');
  return id;
}

export async function findUsageChargeByTurn(
  db: Queryable,
  turnId: string,
): Promise<UsageChargeRecord | null> {
  const result = await db.query<UsageChargeDbRow>(
    `SELECT id, owner_user_id, usage_id, capability_id, session_id, turn_id,
            request_fingerprint, charge_source, status, unit_price_cents,
            free_limit_snapshot, reserved_cents, settled_cents
       FROM usage_charges
      WHERE turn_id = $1
      FOR UPDATE`,
    [turnId],
  );
  const row = result.rows[0];
  return row ? toUsageCharge(row) : null;
}

export async function completeUsageCharge(db: Queryable, charge: UsageChargeRecord): Promise<void> {
  const settledCents = charge.chargeSource === 'wallet' ? charge.reservedCents : 0n;
  if (charge.chargeSource === 'free') {
    const allowance = await db.query(
      `UPDATE billing_free_allowances
          SET free_reserved_count = free_reserved_count - 1,
              free_used_count = free_used_count + 1,
              updated_at = now()
        WHERE owner_user_id = $1 AND capability_id = $2 AND free_reserved_count > 0`,
      [charge.ownerUserId, charge.capabilityId],
    );
    if (allowance.rowCount !== 1) throw new Error('free allowance settlement invariant failed');
  } else if (charge.chargeSource === 'wallet') {
    const account = await db.query(
      `UPDATE billing_accounts
          SET reserved_cents = reserved_cents - $2::bigint, updated_at = now()
        WHERE owner_user_id = $1 AND reserved_cents >= $2::bigint`,
      [charge.ownerUserId, charge.reservedCents.toString()],
    );
    if (account.rowCount !== 1) throw new Error('wallet settlement invariant failed');
    const ledger = await db.query<{ id: string }>(
      `INSERT INTO wallet_ledger
         (owner_user_id, entry_type, amount_cents, recharge_order_id, usage_charge_id)
       VALUES ($1, 'usage_debit', $2::bigint, NULL, $3)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [charge.ownerUserId, (-charge.reservedCents).toString(), charge.id],
    );
    if (!ledger.rows[0]) throw new Error('usage debit ledger invariant failed');
  }
  const updated = await db.query(
    `UPDATE usage_charges
        SET status = 'completed', settled_cents = $2::bigint,
            finished_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'reserved'`,
    [charge.id, settledCents.toString()],
  );
  if (updated.rowCount !== 1) throw new Error('usage completion invariant failed');
}

export async function releaseUsageCharge(db: Queryable, charge: UsageChargeRecord): Promise<void> {
  if (charge.chargeSource === 'free') {
    const allowance = await db.query(
      `UPDATE billing_free_allowances
          SET free_reserved_count = free_reserved_count - 1, updated_at = now()
        WHERE owner_user_id = $1 AND capability_id = $2 AND free_reserved_count > 0`,
      [charge.ownerUserId, charge.capabilityId],
    );
    if (allowance.rowCount !== 1) throw new Error('free allowance release invariant failed');
  } else if (charge.chargeSource === 'wallet') {
    const account = await db.query(
      `UPDATE billing_accounts
          SET reserved_cents = reserved_cents - $2::bigint,
              balance_cents = balance_cents + $2::bigint,
              updated_at = now()
        WHERE owner_user_id = $1 AND reserved_cents >= $2::bigint`,
      [charge.ownerUserId, charge.reservedCents.toString()],
    );
    if (account.rowCount !== 1) throw new Error('wallet release invariant failed');
  }
  const updated = await db.query(
    `UPDATE usage_charges
        SET status = 'released', settled_cents = 0,
            finished_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'reserved'`,
    [charge.id],
  );
  if (updated.rowCount !== 1) throw new Error('usage release invariant failed');
}
