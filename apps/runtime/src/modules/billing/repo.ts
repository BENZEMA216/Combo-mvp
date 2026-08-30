import type { Queryable } from '../../platform/infra/db.js';
import { KnowledgeAgentBindingSchema, type KnowledgeAgentBinding } from '@cb/shared';

export type UsageChargeSource = 'owner' | 'free' | 'wallet';
export type UsageChargeStatus = 'reserved' | 'completed' | 'released';
export type KnowledgeExecutionOutcome =
  | 'answered'
  | 'insufficient_evidence'
  | 'failed'
  | 'interrupted';

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
  product_kind?: 'legacy_capability' | 'knowledge_agent_test';
  capability_protocol?: string | null;
  release_id?: string | null;
  package_digest?: string | null;
  release_scope?: string | null;
  knowledge_resource_path?: string | null;
  knowledge_resource_digest?: string | null;
  billing_policy_version?: string | null;
  validator_policy_version?: string | null;
  execution_outcome?: KnowledgeExecutionOutcome | null;
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
  productKind: 'legacy_capability' | 'knowledge_agent_test';
  knowledgeBinding: KnowledgeAgentBinding | null;
  billingPolicyVersion: string | null;
  validatorPolicyVersion: string | null;
  executionOutcome: KnowledgeExecutionOutcome | null;
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
  const productKind = row.product_kind ?? 'legacy_capability';
  const knowledgeBinding =
    productKind === 'knowledge_agent_test'
      ? KnowledgeAgentBindingSchema.parse({
          productKind,
          capability: {
            id: row.capability_id,
            protocol: row.capability_protocol,
          },
          release: {
            protocol: 'combo.agent-package-release/1',
            releaseId: row.release_id,
            packageDigest: row.package_digest,
          },
          releaseScope: row.release_scope,
          knowledge: {
            protocol: 'combo.knowledge-bundle/1',
            resourcePath: row.knowledge_resource_path,
            resourceDigest: row.knowledge_resource_digest,
          },
        })
      : null;
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
    productKind,
    knowledgeBinding,
    billingPolicyVersion: row.billing_policy_version ?? null,
    validatorPolicyVersion: row.validator_policy_version ?? null,
    executionOutcome: row.execution_outcome ?? null,
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
            free_limit_snapshot, reserved_cents, settled_cents,
            product_kind, capability_protocol, release_id, package_digest, release_scope,
            knowledge_resource_path, knowledge_resource_digest,
            billing_policy_version, validator_policy_version, execution_outcome
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
    knowledge?: {
      binding: KnowledgeAgentBinding;
      billingPolicyVersion: string;
      validatorPolicyVersion: string;
    };
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

  const result = input.knowledge
    ? await db.query<{ id: string }>(
        `INSERT INTO usage_charges
       (owner_user_id, usage_id, capability_id, session_id, turn_id,
        request_fingerprint, charge_source, status, unit_price_cents,
        free_limit_snapshot, reserved_cents, settled_cents,
        product_kind, capability_protocol, release_id, package_digest, release_scope,
        knowledge_resource_path, knowledge_resource_digest,
        billing_policy_version, validator_policy_version, execution_outcome)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved', $8::bigint, $9, $10::bigint, 0,
             'knowledge_agent_test', $11, $12, $13, $14, $15, $16, $17, $18, NULL)
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
          input.knowledge.binding.capability.protocol,
          input.knowledge.binding.release.releaseId,
          input.knowledge.binding.release.packageDigest,
          input.knowledge.binding.releaseScope,
          input.knowledge.binding.knowledge.resourcePath,
          input.knowledge.binding.knowledge.resourceDigest,
          input.knowledge.billingPolicyVersion,
          input.knowledge.validatorPolicyVersion,
        ],
      )
    : await db.query<{ id: string }>(
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
            free_limit_snapshot, reserved_cents, settled_cents,
            product_kind, capability_protocol, release_id, package_digest, release_scope,
            knowledge_resource_path, knowledge_resource_digest,
            billing_policy_version, validator_policy_version, execution_outcome
       FROM usage_charges
      WHERE turn_id = $1
      FOR UPDATE`,
    [turnId],
  );
  const row = result.rows[0];
  return row ? toUsageCharge(row) : null;
}

/** Immutable discriminator used before choosing a legacy or knowledge terminal transaction. */
export async function readUsageChargeProductKindByTurn(
  db: Queryable,
  turnId: string,
  signal?: AbortSignal,
): Promise<'legacy_capability' | 'knowledge_agent_test' | null> {
  const result = await db.query<{ product_kind: 'legacy_capability' | 'knowledge_agent_test' }>(
    `SELECT product_kind FROM usage_charges WHERE turn_id = $1`,
    [turnId],
    signal,
  );
  return result.rows[0]?.product_kind ?? null;
}

export async function completeUsageCharge(
  db: Queryable,
  charge: UsageChargeRecord,
  outcome?: 'answered',
): Promise<void> {
  if (charge.productKind === 'knowledge_agent_test' && outcome !== 'answered') {
    throw new Error('knowledge usage completion requires answered outcome');
  }
  if (charge.productKind === 'legacy_capability' && outcome !== undefined) {
    throw new Error('legacy usage cannot store a knowledge outcome');
  }
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
  const updated =
    charge.productKind === 'knowledge_agent_test'
      ? await db.query(
          `UPDATE usage_charges
        SET status = 'completed', settled_cents = $2::bigint,
            execution_outcome = 'answered', finished_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'reserved' AND execution_outcome IS NULL`,
          [charge.id, settledCents.toString()],
        )
      : await db.query(
          `UPDATE usage_charges
        SET status = 'completed', settled_cents = $2::bigint,
            finished_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'reserved'`,
          [charge.id, settledCents.toString()],
        );
  if (updated.rowCount !== 1) throw new Error('usage completion invariant failed');
}

export async function releaseUsageCharge(
  db: Queryable,
  charge: UsageChargeRecord,
  outcome?: Exclude<KnowledgeExecutionOutcome, 'answered'>,
): Promise<void> {
  if (charge.productKind === 'knowledge_agent_test' && outcome === undefined) {
    throw new Error('knowledge usage release requires an execution outcome');
  }
  if (charge.productKind === 'legacy_capability' && outcome !== undefined) {
    throw new Error('legacy usage cannot store a knowledge outcome');
  }
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
  const updated =
    charge.productKind === 'knowledge_agent_test'
      ? await db.query(
          `UPDATE usage_charges
        SET status = 'released', settled_cents = 0, execution_outcome = $2,
            finished_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'reserved' AND execution_outcome IS NULL`,
          [charge.id, outcome],
        )
      : await db.query(
          `UPDATE usage_charges
        SET status = 'released', settled_cents = 0,
            finished_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'reserved'`,
          [charge.id],
        );
  if (updated.rowCount !== 1) throw new Error('usage release invariant failed');
}
