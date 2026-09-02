// 内存版 BillingStore：忠实复刻 repo.ts 的事务语义（幂等、先赠后本、解冻、清扫），
// 供不依赖 PostgreSQL 的单元与路由测试注入。
import { randomUUID } from 'node:crypto';
import {
  HOLD_TTL_SECONDS,
  ledgerIdempotencyKeys,
  persistedMeteringIdempotencyKey,
  splitDeduction,
  type BillingStore,
  type HoldOutcome,
  type HoldView,
  type RechargeOutcome,
  type SettleOutcome,
  type WalletView,
} from '../service.js';

export interface FakeWallet {
  principalBalance: number;
  bonusBalance: number;
  heldAmount: number;
}

export interface FakeLedgerEntry {
  id: string;
  userId: string;
  kind: string;
  bucket: string | null;
  amount: number;
  refId: string | null;
  idempotencyKey: string;
}

export interface FakeMeteringEvent {
  id: string;
  agentId: string;
  userId: string;
  turnId: string;
  holdId?: string;
  dimension: string | null;
  quantity: number;
  model?: string;
  unitCost?: number;
  source: 'gateway' | 'agent_report' | 'estimated';
  idempotencyKey: string;
}

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

function walletStateIsSafe(principal: bigint, bonus: bigint, held: bigint): boolean {
  const net = principal + bonus;
  const available = net - held;
  return (
    principal >= -MAX_SAFE_INTEGER &&
    principal <= MAX_SAFE_INTEGER &&
    bonus >= -MAX_SAFE_INTEGER &&
    bonus <= MAX_SAFE_INTEGER &&
    held >= 0n &&
    held <= MAX_SAFE_INTEGER &&
    net >= -MAX_SAFE_INTEGER &&
    net <= MAX_SAFE_INTEGER &&
    available >= -MAX_SAFE_INTEGER &&
    available <= MAX_SAFE_INTEGER
  );
}

export function createFakeBillingStore(now: () => number = () => Date.now()) {
  const state = {
    wallets: new Map<string, FakeWallet>(),
    holds: new Map<string, HoldView>(),
    holdsByTurn: new Map<string, string>(),
    ledger: [] as FakeLedgerEntry[],
    metering: [] as FakeMeteringEvent[],
  };

  const walletOf = (userId: string): FakeWallet => {
    let wallet = state.wallets.get(userId);
    if (!wallet) {
      wallet = { principalBalance: 0, bonusBalance: 0, heldAmount: 0 };
      state.wallets.set(userId, wallet);
    }
    return wallet;
  };

  const walletView = (userId: string): WalletView => ({ userId, ...walletOf(userId) });

  const appendLedger = (entry: Omit<FakeLedgerEntry, 'id'>): void => {
    if (state.ledger.some((row) => row.idempotencyKey === entry.idempotencyKey)) {
      throw Object.assign(new Error('duplicate idempotency key'), { code: '23505' });
    }
    state.ledger.push({ id: randomUUID(), ...entry });
  };

  const store: BillingStore = {
    async readWallet(userId) {
      const wallet = state.wallets.get(userId);
      return wallet ? { userId, ...wallet } : null;
    },

    async createHold({
      userId,
      agentId,
      turnId,
      estimatedAmount,
      overdraftHardLimitCents,
    }): Promise<HoldOutcome> {
      const existingId = state.holdsByTurn.get(`${agentId}:${turnId}`);
      if (existingId) {
        const hold = state.holds.get(existingId)!;
        if (hold.userId !== userId || hold.estimatedAmount !== estimatedAmount) {
          return { kind: 'conflict', reason: 'idempotency_mismatch' };
        }
        if (hold.status !== 'held') return { kind: 'conflict', reason: 'terminal_replay' };
        return {
          kind: 'held',
          hold,
          wallet: walletView(hold.userId),
          replayed: true,
        };
      }

      const wallet = walletOf(userId);
      const net = wallet.principalBalance + wallet.bonusBalance;
      if (net < -overdraftHardLimitCents) {
        return { kind: 'overdraft_blocked', wallet: walletView(userId) };
      }
      if (net - wallet.heldAmount < estimatedAmount) {
        return { kind: 'insufficient', wallet: walletView(userId) };
      }

      const hold: HoldView = {
        id: randomUUID(),
        userId,
        agentId,
        turnId,
        estimatedAmount,
        actualAmount: null,
        status: 'held',
        expiresAt: new Date(now() + HOLD_TTL_SECONDS * 1000),
      };
      state.holds.set(hold.id, hold);
      state.holdsByTurn.set(`${agentId}:${turnId}`, hold.id);
      wallet.heldAmount += estimatedAmount;
      appendLedger({
        userId,
        kind: 'hold',
        bucket: null,
        amount: estimatedAmount,
        refId: hold.id,
        idempotencyKey: ledgerIdempotencyKeys.hold(agentId, turnId),
      });
      return { kind: 'held', hold, wallet: walletView(userId), replayed: false };
    },

    async settleHold({ holdId, actualAmount }): Promise<SettleOutcome> {
      const hold = state.holds.get(holdId);
      if (!hold) return { kind: 'not_found' };

      if (hold.status === 'settled') {
        if (hold.actualAmount !== actualAmount) {
          return { kind: 'conflict', reason: 'idempotency_mismatch' };
        }
        const deductions = { bonus: 0, principal: 0 };
        for (const entry of state.ledger) {
          if (entry.refId === hold.id && entry.kind === 'consume') {
            if (entry.bucket === 'bonus') deductions.bonus += -entry.amount;
            if (entry.bucket === 'principal') deductions.principal += -entry.amount;
          }
        }
        return {
          kind: 'settled',
          hold,
          wallet: walletView(hold.userId),
          deductions,
          estimatedUsageRecorded: state.metering.some(
            (event) => event.holdId === hold.id && event.source === 'estimated',
          ),
          replayed: true,
        };
      }
      if (hold.status !== 'held') return { kind: 'invalid_state', hold };

      const wallet = walletOf(hold.userId);
      const deductions = splitDeduction(walletView(hold.userId), actualAmount);
      if (
        !walletStateIsSafe(
          BigInt(wallet.principalBalance) - BigInt(deductions.principal),
          BigInt(wallet.bonusBalance) - BigInt(deductions.bonus),
          BigInt(wallet.heldAmount) - BigInt(hold.estimatedAmount),
        )
      ) {
        return { kind: 'conflict', reason: 'balance_range_exceeded' };
      }
      wallet.bonusBalance -= deductions.bonus;
      wallet.principalBalance -= deductions.principal;
      wallet.heldAmount -= hold.estimatedAmount;
      if (deductions.bonus > 0) {
        appendLedger({
          userId: hold.userId,
          kind: 'consume',
          bucket: 'bonus',
          amount: -deductions.bonus,
          refId: hold.id,
          idempotencyKey: `settle:${hold.id}:bonus`,
        });
      }
      if (deductions.principal > 0) {
        appendLedger({
          userId: hold.userId,
          kind: 'consume',
          bucket: 'principal',
          amount: -deductions.principal,
          refId: hold.id,
          idempotencyKey: `settle:${hold.id}:principal`,
        });
      }

      const hasUsage = state.metering.some(
        (event) =>
          event.holdId === hold.id &&
          (event.source === 'gateway' || event.source === 'agent_report'),
      );
      const estimatedUsageRecorded = !hasUsage && actualAmount > 0;
      if (estimatedUsageRecorded) {
        state.metering.push({
          id: randomUUID(),
          agentId: hold.agentId,
          userId: hold.userId,
          turnId: hold.turnId,
          holdId: hold.id,
          dimension: null,
          quantity: actualAmount,
          source: 'estimated',
          idempotencyKey: `meter:estimated:v1:${hold.id}`,
        });
      }

      hold.status = 'settled';
      hold.actualAmount = actualAmount;
      return {
        kind: 'settled',
        hold,
        wallet: walletView(hold.userId),
        deductions,
        estimatedUsageRecorded,
        replayed: false,
      };
    },

    async insertMeteringEvent(input) {
      const persistentKey = persistedMeteringIdempotencyKey(input.idempotencyKey);
      const existing = state.metering.find((event) => event.idempotencyKey === persistentKey);
      if (existing) {
        const matches =
          existing.agentId === input.agentId &&
          existing.userId === input.userId &&
          existing.turnId === input.turnId &&
          existing.holdId === input.holdId &&
          existing.dimension === input.dimension &&
          existing.quantity === input.quantity &&
          existing.model === input.model &&
          existing.unitCost === input.unitCost &&
          existing.source === input.source;
        return matches
          ? { kind: 'recorded', id: existing.id, replayed: true }
          : { kind: 'conflict', reason: 'idempotency_mismatch' };
      }
      if (input.holdId) {
        const hold = state.holds.get(input.holdId);
        if (
          !hold ||
          hold.userId !== input.userId ||
          hold.agentId !== input.agentId ||
          hold.turnId !== input.turnId
        ) {
          return { kind: 'conflict', reason: 'hold_scope_mismatch' };
        }
        if (hold.status !== 'held') {
          return { kind: 'conflict', reason: 'hold_not_active' };
        }
      }
      const event = { id: randomUUID(), ...input, idempotencyKey: persistentKey };
      state.metering.push(event);
      return { kind: 'recorded', id: event.id, replayed: false };
    },

    async adminRecharge({ userId, amount, idempotencyKey, refId }): Promise<RechargeOutcome> {
      const persistentKey = ledgerIdempotencyKeys.recharge(idempotencyKey);
      const existing = state.ledger.find((row) => row.idempotencyKey === persistentKey);
      if (existing) {
        if (
          existing.kind !== 'recharge' ||
          existing.bucket !== 'principal' ||
          existing.userId !== userId ||
          existing.amount !== amount ||
          existing.refId !== (refId ?? null)
        ) {
          return { kind: 'conflict', reason: 'idempotency_mismatch' };
        }
        return { kind: 'credited', wallet: walletView(existing.userId), replayed: true };
      }
      const wallet = walletOf(userId);
      if (
        !walletStateIsSafe(
          BigInt(wallet.principalBalance) + BigInt(amount),
          BigInt(wallet.bonusBalance),
          BigInt(wallet.heldAmount),
        )
      ) {
        return { kind: 'conflict', reason: 'balance_range_exceeded' };
      }
      wallet.principalBalance += amount;
      appendLedger({
        userId,
        kind: 'recharge',
        bucket: 'principal',
        amount,
        refId: refId ?? null,
        idempotencyKey: persistentKey,
      });
      return { kind: 'credited', wallet: walletView(userId), replayed: false };
    },

    async sweepExpiredHolds({ limit }) {
      const expired = [...state.holds.values()]
        .filter((hold) => hold.status === 'held' && hold.expiresAt.getTime() <= now())
        .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
        .slice(0, limit);
      for (const hold of expired) {
        hold.status = 'expired';
        walletOf(hold.userId).heldAmount -= hold.estimatedAmount;
        appendLedger({
          userId: hold.userId,
          kind: 'release',
          bucket: null,
          amount: hold.estimatedAmount,
          refId: hold.id,
          idempotencyKey: `release:${hold.id}`,
        });
      }
      return expired.length;
    },
  };

  return { store, state };
}
