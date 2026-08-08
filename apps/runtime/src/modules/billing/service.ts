import { createHash } from 'node:crypto';
import { withTransaction, type Queryable, type RuntimeDb } from '../../platform/infra/db.js';
import {
  completeUsageCharge,
  ensureAndLockBillingAccount,
  ensureAndLockFreeAllowance,
  findUsageCharge,
  findUsageChargeByTurn,
  insertReservedUsageCharge,
  lockUsageId,
  releaseUsageCharge,
  type UsageChargeSource,
} from './repo.js';

export const DEFAULT_USAGE_BILLING_POLICY = {
  freeUses: 3,
  unitPriceCents: 100,
  version: 'runtime-usage-v1',
} as const;

export interface UsageBillingPolicy {
  freeUses: number;
  unitPriceCents: number;
  version?: string;
}

export interface UsageRequest {
  ownerUserId: string;
  capabilityOwnerUserId: string;
  capabilityId: string;
  sessionId: string;
  usageId: string;
  text: string;
}

export type UsagePreparation =
  | { kind: 'new'; source: UsageChargeSource; balanceCents: bigint; freeLimitSnapshot: number }
  | { kind: 'replay'; turnId: string }
  | { kind: 'insufficient'; balanceCents: bigint; requiredCents: bigint };

export class UsageRequestConflictError extends Error {
  constructor() {
    super('usageId was already used for another request');
    this.name = 'UsageRequestConflictError';
  }
}

export interface UsageBillingService {
  prepareUsage(db: Queryable, input: UsageRequest): Promise<UsagePreparation>;
  reservePreparedUsage(
    db: Queryable,
    input: UsageRequest & {
      turnId: string;
      preparation: Extract<UsagePreparation, { kind: 'new' }>;
    },
  ): Promise<void>;
  settleUsage(db: Queryable, turnId: string): Promise<void>;
  releaseUsage(db: Queryable, turnId: string): Promise<void>;
  reconcileTerminalReservations(db: RuntimeDb): Promise<number>;
}

export function usageRequestFingerprint(input: UsageRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'combo-runtime-usage-v1',
        input.ownerUserId,
        input.capabilityId,
        input.sessionId,
        input.text,
      ]),
      'utf8',
    )
    .digest('hex');
}

function validatePolicy(policy: UsageBillingPolicy): Required<UsageBillingPolicy> {
  if (!Number.isSafeInteger(policy.freeUses) || policy.freeUses < 0) {
    throw new Error('billing free uses must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(policy.unitPriceCents) || policy.unitPriceCents <= 0) {
    throw new Error('billing unit price must be a positive safe integer');
  }
  const version = policy.version ?? DEFAULT_USAGE_BILLING_POLICY.version;
  if (!version || version.length > 100) throw new Error('billing policy version is invalid');
  return { ...policy, version };
}

export function createUsageBillingService(policyInput: UsageBillingPolicy): UsageBillingService {
  const policy = validatePolicy(policyInput);
  const requiredCents = BigInt(policy.unitPriceCents);

  return {
    async prepareUsage(db, input) {
      await lockUsageId(db, input.ownerUserId, input.usageId);
      const fingerprint = usageRequestFingerprint(input);
      const existing = await findUsageCharge(db, input.ownerUserId, input.usageId);
      if (existing) {
        if (
          existing.requestFingerprint !== fingerprint ||
          existing.capabilityId !== input.capabilityId ||
          existing.sessionId !== input.sessionId
        ) {
          throw new UsageRequestConflictError();
        }
        return { kind: 'replay', turnId: existing.turnId };
      }

      const account = await ensureAndLockBillingAccount(db, input.ownerUserId);
      if (input.ownerUserId === input.capabilityOwnerUserId) {
        return {
          kind: 'new',
          source: 'owner',
          balanceCents: account.balanceCents,
          freeLimitSnapshot: policy.freeUses,
        };
      }

      const allowance = await ensureAndLockFreeAllowance(db, {
        ownerUserId: input.ownerUserId,
        capabilityId: input.capabilityId,
        policyVersion: policy.version,
        freeLimit: policy.freeUses,
      });
      if (allowance.freeUsedCount + allowance.freeReservedCount < allowance.freeLimitSnapshot) {
        return {
          kind: 'new',
          source: 'free',
          balanceCents: account.balanceCents,
          freeLimitSnapshot: allowance.freeLimitSnapshot,
        };
      }
      if (account.balanceCents < requiredCents) {
        return {
          kind: 'insufficient',
          balanceCents: account.balanceCents,
          requiredCents,
        };
      }
      return {
        kind: 'new',
        source: 'wallet',
        balanceCents: account.balanceCents,
        freeLimitSnapshot: allowance.freeLimitSnapshot,
      };
    },

    async reservePreparedUsage(db, input) {
      const reservedCents = input.preparation.source === 'wallet' ? requiredCents : 0n;
      await insertReservedUsageCharge(db, {
        ownerUserId: input.ownerUserId,
        usageId: input.usageId,
        capabilityId: input.capabilityId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        requestFingerprint: usageRequestFingerprint(input),
        chargeSource: input.preparation.source,
        unitPriceCents: requiredCents,
        freeLimitSnapshot: input.preparation.freeLimitSnapshot,
        reservedCents,
      });
    },

    async settleUsage(db, turnId) {
      const charge = await findUsageChargeByTurn(db, turnId);
      if (!charge || charge.status !== 'reserved') return;
      await completeUsageCharge(db, charge);
    },

    async releaseUsage(db, turnId) {
      const charge = await findUsageChargeByTurn(db, turnId);
      if (!charge || charge.status !== 'reserved') return;
      await releaseUsageCharge(db, charge);
    },

    async reconcileTerminalReservations(db) {
      const candidates = await db.query<{
        turn_id: string;
        session_id: string;
        turn_status: 'completed' | 'failed' | 'interrupted';
      }>(
        `SELECT uc.turn_id, t.session_id, t.status AS turn_status
           FROM usage_charges uc
           JOIN turns t ON t.id = uc.turn_id
          WHERE uc.status = 'reserved'
            AND t.status IN ('completed', 'failed', 'interrupted')
          ORDER BY t.finished_at, uc.id
          LIMIT 100`,
      );
      let reconciled = 0;
      for (const candidate of candidates.rows) {
        const won = await withTransaction(db, async (transaction) => {
          const session = await transaction.query<{ id: string }>(
            `SELECT id FROM sessions WHERE id = $1 FOR UPDATE`,
            [candidate.session_id],
          );
          if (!session.rows[0]) return false;
          const turn = await transaction.query<{
            status: 'running' | 'completed' | 'failed' | 'interrupted';
          }>(
            `SELECT status FROM turns
              WHERE id = $1 AND session_id = $2
              FOR UPDATE`,
            [candidate.turn_id, candidate.session_id],
          );
          const status = turn.rows[0]?.status;
          if (status === 'completed') {
            await this.settleUsage(transaction, candidate.turn_id);
            return true;
          }
          if (status === 'failed' || status === 'interrupted') {
            await this.releaseUsage(transaction, candidate.turn_id);
            return true;
          }
          return false;
        });
        if (won) reconciled += 1;
      }
      return reconciled;
    },
  };
}
