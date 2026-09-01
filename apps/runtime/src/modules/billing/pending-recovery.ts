import {
  KnowledgeAgentBindingSchema,
  PendingUsageRecoveryViewSchema,
  PendingUsageRequestTextSchema,
  knowledgeBindingsEqual,
  type KnowledgeAgentBinding,
  type PendingUsageRecoveryView,
} from '@cb/shared';

import { withTransaction, type Queryable, type RuntimeDb } from '../../platform/infra/db.js';
import { lockUsageId } from './repo.js';

export type PendingUsageRecoveryStatus = 'active' | 'accepted' | 'abandoned';

interface PendingUsageRecoveryDbRow {
  owner_user_id: string;
  usage_id: string;
  session_id: string;
  capability_id: string;
  request_text: string | null;
  request_fingerprint: string;
  product_kind: string;
  capability_protocol: string;
  release_id: string;
  package_digest: string;
  release_scope: string;
  knowledge_resource_path: string;
  knowledge_resource_digest: string;
  billing_policy_version: string;
  validator_policy_version: string;
  unit_price_cents: string | number | bigint;
  free_limit_snapshot: number;
  active_recharge_intent_id: string;
  recovery_status: PendingUsageRecoveryStatus;
  terminal_turn_id: string | null;
  expires_at: string | Date;
  created_at: string | Date;
  updated_at: string | Date;
  is_unexpired: boolean;
}

export interface PendingUsageRecoveryRecord {
  ownerUserId: string;
  usageId: string;
  sessionId: string;
  capabilityId: string;
  requestText: string | null;
  requestFingerprint: string;
  binding: KnowledgeAgentBinding;
  billingPolicyVersion: string;
  validatorPolicyVersion: string;
  unitPriceCents: bigint;
  freeLimitSnapshot: number;
  activeRechargeIntentId: string;
  recoveryStatus: PendingUsageRecoveryStatus;
  terminalTurnId: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  /** Database statement-time result; avoids admitting with a drifting process clock. */
  isUnexpired: boolean;
}

export interface PendingUsageRecoveryExpected {
  ownerUserId: string;
  usageId: string;
  sessionId: string;
  capabilityId: string;
  requestText: string;
  requestFingerprint: string;
  binding: KnowledgeAgentBinding;
  billingPolicyVersion: string;
  validatorPolicyVersion: string;
  unitPriceCents: bigint;
  freeLimitSnapshot: number;
}

export class PendingUsageRecoveryConflictError extends Error {
  constructor() {
    super('pending usage recovery conflicts with the request');
    this.name = 'PendingUsageRecoveryConflictError';
  }
}

export class PendingUsageRecoveryExpiredError extends Error {
  constructor() {
    super('pending usage recovery expired');
    this.name = 'PendingUsageRecoveryExpiredError';
  }
}

export class PendingUsageRecoveryBusyError extends Error {
  constructor() {
    super('pending usage recovery is already admitted');
    this.name = 'PendingUsageRecoveryBusyError';
  }
}

const RECOVERY_COLUMNS = `
  owner_user_id, usage_id, session_id, capability_id, request_text,
  request_fingerprint, product_kind, capability_protocol, release_id,
  package_digest, release_scope, knowledge_resource_path,
  knowledge_resource_digest, billing_policy_version, validator_policy_version,
  unit_price_cents, free_limit_snapshot, active_recharge_intent_id,
  recovery_status, terminal_turn_id, expires_at, created_at, updated_at,
  expires_at > statement_timestamp() AS is_unexpired`;

function toDate(value: string | Date): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('pending recovery timestamp is invalid');
  return date;
}

function toRecord(row: PendingUsageRecoveryDbRow): PendingUsageRecoveryRecord {
  const binding = KnowledgeAgentBindingSchema.parse({
    productKind: row.product_kind,
    capability: { id: row.capability_id, protocol: row.capability_protocol },
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
  });
  return {
    ownerUserId: row.owner_user_id,
    usageId: row.usage_id,
    sessionId: row.session_id,
    capabilityId: row.capability_id,
    requestText: row.request_text,
    requestFingerprint: row.request_fingerprint,
    binding,
    billingPolicyVersion: row.billing_policy_version,
    validatorPolicyVersion: row.validator_policy_version,
    unitPriceCents: BigInt(row.unit_price_cents),
    freeLimitSnapshot: row.free_limit_snapshot,
    activeRechargeIntentId: row.active_recharge_intent_id,
    recoveryStatus: row.recovery_status,
    terminalTurnId: row.terminal_turn_id,
    expiresAt: toDate(row.expires_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    isUnexpired: row.is_unexpired,
  };
}

function bindingsAndSnapshotsMatch(
  recovery: PendingUsageRecoveryRecord,
  expected: PendingUsageRecoveryExpected,
): boolean {
  return (
    recovery.ownerUserId === expected.ownerUserId &&
    recovery.usageId === expected.usageId &&
    recovery.sessionId === expected.sessionId &&
    recovery.capabilityId === expected.capabilityId &&
    (recovery.requestText === null || recovery.requestText === expected.requestText) &&
    recovery.requestFingerprint === expected.requestFingerprint &&
    knowledgeBindingsEqual(recovery.binding, expected.binding)
  );
}

export function assertPendingUsageRecoveryBindingMatches(
  recovery: PendingUsageRecoveryRecord,
  expected: PendingUsageRecoveryExpected,
): void {
  if (!bindingsAndSnapshotsMatch(recovery, expected)) {
    throw new PendingUsageRecoveryConflictError();
  }
}

export function assertPendingUsageRecoveryMatches(
  recovery: PendingUsageRecoveryRecord,
  expected: PendingUsageRecoveryExpected,
  now?: Date,
): void {
  assertPendingUsageRecoveryBindingMatches(recovery, expected);
  if (recovery.recoveryStatus !== 'active' || recovery.requestText === null) {
    throw new PendingUsageRecoveryConflictError();
  }
  if (now ? recovery.expiresAt.getTime() <= now.getTime() : !recovery.isUnexpired) {
    throw new PendingUsageRecoveryExpiredError();
  }
}

export function toPendingUsageRecoveryView(
  recovery: PendingUsageRecoveryRecord,
): PendingUsageRecoveryView {
  if (recovery.recoveryStatus !== 'active' || recovery.requestText === null) {
    throw new PendingUsageRecoveryConflictError();
  }
  return PendingUsageRecoveryViewSchema.parse({
    usageId: recovery.usageId,
    sessionId: recovery.sessionId,
    capabilityId: recovery.capabilityId,
    requestText: recovery.requestText,
    requestFingerprint: recovery.requestFingerprint,
    binding: recovery.binding,
    billing: {
      currency: 'CNY',
      policyVersion: recovery.billingPolicyVersion,
      validatorPolicyVersion: recovery.validatorPolicyVersion,
      unitPriceCents: recovery.unitPriceCents.toString(),
      freeLimitSnapshot: recovery.freeLimitSnapshot,
    },
    status: 'active',
    activeRechargeIntentId: recovery.activeRechargeIntentId,
    expiresAt: recovery.expiresAt.toISOString(),
    createdAt: recovery.createdAt.toISOString(),
    updatedAt: recovery.updatedAt.toISOString(),
  });
}

export async function findPendingUsageRecovery(
  db: Queryable,
  ownerUserId: string,
  usageId: string,
  lock = false,
): Promise<PendingUsageRecoveryRecord | null> {
  const result = await db.query<PendingUsageRecoveryDbRow>(
    `SELECT ${RECOVERY_COLUMNS}
       FROM pending_usage_recoveries
      WHERE owner_user_id = $1 AND usage_id = $2
      ${lock ? 'FOR UPDATE' : ''}`,
    [ownerUserId, usageId],
  );
  return result.rows[0] ? toRecord(result.rows[0]) : null;
}

export async function findActivePendingUsageRecoveryForSession(
  db: Queryable,
  ownerUserId: string,
  sessionId: string,
  lock = false,
): Promise<PendingUsageRecoveryRecord | null> {
  const result = await db.query<PendingUsageRecoveryDbRow>(
    `SELECT ${RECOVERY_COLUMNS}
       FROM pending_usage_recoveries
      WHERE owner_user_id = $1 AND session_id = $2
        AND recovery_status = 'active'
      LIMIT 1
      ${lock ? 'FOR UPDATE' : ''}`,
    [ownerUserId, sessionId],
  );
  return result.rows[0] ? toRecord(result.rows[0]) : null;
}

export async function listActivePendingUsageRecoveries(
  db: Queryable,
  ownerUserId: string,
  sessionId?: string,
): Promise<PendingUsageRecoveryRecord[]> {
  const result = await db.query<PendingUsageRecoveryDbRow>(
    `SELECT ${RECOVERY_COLUMNS}
       FROM pending_usage_recoveries
      WHERE owner_user_id = $1
        AND recovery_status = 'active'
        AND expires_at > statement_timestamp()
        AND ($2::uuid IS NULL OR session_id = $2)
      ORDER BY updated_at DESC, usage_id
      LIMIT 100`,
    [ownerUserId, sessionId ?? null],
  );
  return result.rows.map(toRecord);
}

export async function insertOrFindPendingUsageRecovery(
  db: Queryable,
  expected: PendingUsageRecoveryExpected,
): Promise<{ recovery: PendingUsageRecoveryRecord; reusedDifferentUsage: boolean }> {
  const requestText = PendingUsageRequestTextSchema.parse(expected.requestText);
  const inserted = await db.query<PendingUsageRecoveryDbRow>(
    `INSERT INTO pending_usage_recoveries (
       owner_user_id, usage_id, session_id, capability_id, request_text,
       request_fingerprint, product_kind, capability_protocol, release_id,
       package_digest, release_scope, knowledge_resource_path,
       knowledge_resource_digest, billing_policy_version, validator_policy_version,
       unit_price_cents, free_limit_snapshot, active_recharge_intent_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 'knowledge_agent_test', $7, $8, $9,
       $10, $11, $12, $13, $14, $15::bigint, $16, $2
     )
     ON CONFLICT DO NOTHING
     RETURNING ${RECOVERY_COLUMNS}`,
    [
      expected.ownerUserId,
      expected.usageId,
      expected.sessionId,
      expected.capabilityId,
      requestText,
      expected.requestFingerprint,
      expected.binding.capability.protocol,
      expected.binding.release.releaseId,
      expected.binding.release.packageDigest,
      expected.binding.releaseScope,
      expected.binding.knowledge.resourcePath,
      expected.binding.knowledge.resourceDigest,
      expected.billingPolicyVersion,
      expected.validatorPolicyVersion,
      expected.unitPriceCents.toString(),
      expected.freeLimitSnapshot,
    ],
  );
  if (inserted.rows[0]) {
    return { recovery: toRecord(inserted.rows[0]), reusedDifferentUsage: false };
  }

  const sameUsage = await findPendingUsageRecovery(
    db,
    expected.ownerUserId,
    expected.usageId,
    true,
  );
  if (sameUsage) {
    assertPendingUsageRecoveryMatches(sameUsage, expected);
    return { recovery: sameUsage, reusedDifferentUsage: false };
  }

  const candidate = await findActivePendingUsageRecoveryForSession(
    db,
    expected.ownerUserId,
    expected.sessionId,
  );
  if (!candidate) throw new PendingUsageRecoveryConflictError();
  await lockUsageId(db, expected.ownerUserId, candidate.usageId);
  const active = await findPendingUsageRecovery(db, expected.ownerUserId, candidate.usageId, true);
  if (!active || active.recoveryStatus !== 'active') {
    throw new PendingUsageRecoveryConflictError();
  }
  if (!active.isUnexpired) throw new PendingUsageRecoveryExpiredError();
  return { recovery: active, reusedDifferentUsage: true };
}

async function hasUsageCharge(
  db: Queryable,
  ownerUserId: string,
  usageId: string,
): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM usage_charges WHERE owner_user_id = $1 AND usage_id = $2
     ) AS exists`,
    [ownerUserId, usageId],
  );
  return result.rows[0]?.exists === true;
}

export async function abandonPendingUsageRecovery(
  db: Queryable,
  recovery: PendingUsageRecoveryRecord,
  terminalTurnId: string | null = null,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE pending_usage_recoveries
        SET request_text = NULL,
            recovery_status = 'abandoned',
            terminal_turn_id = $3,
            abandoned_at = statement_timestamp(),
            updated_at = statement_timestamp()
      WHERE owner_user_id = $1 AND usage_id = $2
        AND recovery_status = 'active'`,
    [recovery.ownerUserId, recovery.usageId, terminalTurnId],
  );
  return result.rowCount === 1;
}

export async function abandonUnadmittedPendingUsageRecovery(
  db: Queryable,
  recovery: PendingUsageRecoveryRecord,
): Promise<boolean> {
  if (await hasUsageCharge(db, recovery.ownerUserId, recovery.usageId)) {
    throw new PendingUsageRecoveryBusyError();
  }
  return abandonPendingUsageRecovery(db, recovery);
}

export async function closePendingUsageRecoveryForTerminal(
  db: Queryable,
  input: {
    ownerUserId: string;
    usageId: string;
    turnId: string;
    outcome: 'answered' | 'insufficient_evidence' | 'failed' | 'interrupted';
  },
): Promise<void> {
  const accepted = input.outcome === 'answered';
  await db.query(
    `UPDATE pending_usage_recoveries
        SET request_text = NULL,
            recovery_status = $3,
            terminal_turn_id = $4,
            accepted_at = CASE WHEN $3 = 'accepted' THEN statement_timestamp() ELSE NULL END,
            abandoned_at = CASE WHEN $3 = 'abandoned' THEN statement_timestamp() ELSE NULL END,
            updated_at = statement_timestamp()
      WHERE owner_user_id = $1 AND usage_id = $2
        AND recovery_status = 'active'`,
    [input.ownerUserId, input.usageId, accepted ? 'accepted' : 'abandoned', input.turnId],
  );
}

export async function abandonOwnedUnadmittedPendingUsageRecovery(
  db: RuntimeDb,
  ownerUserId: string,
  usageId: string,
): Promise<'abandoned' | 'not_found' | 'terminal'> {
  return withTransaction(db, async (transaction) => {
    const candidate = await findPendingUsageRecovery(transaction, ownerUserId, usageId);
    if (!candidate) return 'not_found';
    await transaction.query(`SELECT id FROM sessions WHERE id = $1 FOR UPDATE`, [
      candidate.sessionId,
    ]);
    await lockUsageId(transaction, ownerUserId, usageId);
    const locked = await findPendingUsageRecovery(transaction, ownerUserId, usageId, true);
    if (!locked) return 'not_found';
    if (locked.recoveryStatus !== 'active') return 'terminal';
    await abandonUnadmittedPendingUsageRecovery(transaction, locked);
    return 'abandoned';
  });
}

export async function abandonActiveRecoveryForLockedSession(
  db: Queryable,
  ownerUserId: string,
  sessionId: string,
): Promise<boolean> {
  const candidate = await findActivePendingUsageRecoveryForSession(db, ownerUserId, sessionId);
  if (!candidate) return false;
  await lockUsageId(db, ownerUserId, candidate.usageId);
  const locked = await findPendingUsageRecovery(db, ownerUserId, candidate.usageId, true);
  if (!locked || locked.recoveryStatus !== 'active') return false;
  return abandonUnadmittedPendingUsageRecovery(db, locked);
}

export async function sweepExpiredPendingUsageRecoveries(
  db: RuntimeDb,
  limit = 100,
): Promise<number> {
  const candidates = await db.query<{
    owner_user_id: string;
    usage_id: string;
    session_id: string;
  }>(
    `SELECT owner_user_id, usage_id, session_id
       FROM pending_usage_recoveries
      WHERE recovery_status = 'active' AND expires_at <= statement_timestamp()
      ORDER BY expires_at, owner_user_id, usage_id
      LIMIT $1`,
    [limit],
  );
  let abandoned = 0;
  for (const candidate of candidates.rows) {
    const changed = await withTransaction(db, async (transaction) => {
      await transaction.query(`SELECT id FROM sessions WHERE id = $1 FOR UPDATE`, [
        candidate.session_id,
      ]);
      await lockUsageId(transaction, candidate.owner_user_id, candidate.usage_id);
      const recovery = await findPendingUsageRecovery(
        transaction,
        candidate.owner_user_id,
        candidate.usage_id,
        true,
      );
      if (
        !recovery ||
        recovery.recoveryStatus !== 'active' ||
        recovery.isUnexpired ||
        (await hasUsageCharge(transaction, candidate.owner_user_id, candidate.usage_id))
      ) {
        return false;
      }
      return abandonPendingUsageRecovery(transaction, recovery);
    });
    if (changed) abandoned += 1;
  }
  return abandoned;
}

export async function readUsageIdentityByTurn(
  db: Queryable,
  turnId: string,
): Promise<{ ownerUserId: string; usageId: string; sessionId: string } | null> {
  const result = await db.query<{
    owner_user_id: string;
    usage_id: string;
    session_id: string;
  }>(
    `SELECT owner_user_id, usage_id, session_id
       FROM usage_charges
      WHERE turn_id = $1 AND product_kind = 'knowledge_agent_test'`,
    [turnId],
  );
  const row = result.rows[0];
  return row
    ? { ownerUserId: row.owner_user_id, usageId: row.usage_id, sessionId: row.session_id }
    : null;
}
