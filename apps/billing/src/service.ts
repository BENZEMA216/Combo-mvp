// 计费业务逻辑与持久层端口。记账纪律在这里和 repo 里共同执行：流水 append-only、
// 先赠后本、幂等重放返回原结果。金额一律整数分（number 安全整数范围内）。
// 依赖以端口注入：repo.ts 提供 PostgreSQL 实现，测试注入内存假实现。
import { createHash } from 'node:crypto';

/** hold TTL 固定五分钟（spec 八），与 0013 的 ck_v2_hold_ttl 约束一致。 */
export const HOLD_TTL_SECONDS = 5 * 60;

export interface WalletView {
  userId: string;
  principalBalance: number;
  bonusBalance: number;
  heldAmount: number;
}

export interface HoldView {
  id: string;
  userId: string;
  agentId: string;
  turnId: string;
  estimatedAmount: number;
  actualAmount: number | null;
  status: 'held' | 'settled' | 'released' | 'expired';
  expiresAt: Date;
}

export type HoldOutcome =
  | { kind: 'held'; hold: HoldView; wallet: WalletView; replayed: boolean }
  | { kind: 'conflict'; reason: 'idempotency_mismatch' | 'terminal_replay' }
  | { kind: 'invalid_user' }
  | { kind: 'insufficient'; wallet: WalletView }
  | { kind: 'overdraft_blocked'; wallet: WalletView };

export interface SettleDeductions {
  bonus: number;
  principal: number;
}

export type SettleOutcome =
  | {
      kind: 'settled';
      hold: HoldView;
      wallet: WalletView;
      deductions: SettleDeductions;
      estimatedUsageRecorded: boolean;
      replayed: boolean;
    }
  | { kind: 'not_found' }
  | { kind: 'conflict'; reason: 'idempotency_mismatch' | 'balance_range_exceeded' }
  | { kind: 'invalid_state'; hold: HoldView };

export type RechargeOutcome =
  | {
      kind: 'credited';
      wallet: WalletView;
      replayed: boolean;
    }
  | { kind: 'invalid_user' }
  | { kind: 'conflict'; reason: 'idempotency_mismatch' | 'balance_range_exceeded' };

export interface MeteringEventInput {
  agentId: string;
  userId: string;
  turnId: string;
  holdId?: string;
  dimension:
    | 'llm_token_in'
    | 'llm_token_out'
    | 'tts_char'
    | 'image_gen'
    | 'retrieval_call'
    | 'audio_second';
  quantity: number;
  model?: string;
  unitCost?: number;
  source: 'gateway' | 'agent_report';
  idempotencyKey: string;
}

export type MeteringOutcome =
  | { kind: 'recorded'; id: string; replayed: boolean }
  | {
      kind: 'conflict';
      reason: 'idempotency_mismatch' | 'hold_scope_mismatch' | 'hold_not_active';
    };

/** 计费持久层端口（PostgreSQL 事实源）。每个写方法内部是一个完整事务。 */
export interface BillingStore {
  /** 无钱包行返回 null（用户尚未发生任何计费动作）。 */
  readWallet(userId: string): Promise<WalletView | null>;
  /**
   * 同步事务创建预授权：turn_id 幂等（重复直接返回原 hold）；
   * 净余额低于负余额硬停阈值时拒绝；可用余额不足返回当前钱包。
   */
  createHold(input: {
    userId: string;
    agentId: string;
    turnId: string;
    estimatedAmount: number;
    overdraftHardLimitCents: number;
  }): Promise<HoldOutcome>;
  /**
   * 结算：hold_id 幂等（已 settled 返回原结果）；先赠后本扣减、解冻全部冻结额；
   * 该 turn 没有任何计量事件时补一条 source=estimated 的兜底行。
   */
  settleHold(input: { holdId: string; actualAmount: number }): Promise<SettleOutcome>;
  insertMeteringEvent(input: MeteringEventInput): Promise<MeteringOutcome>;
  /** 管理端手工充值：本金桶入账，idempotency_key 幂等。 */
  adminRecharge(input: {
    userId: string;
    amount: number;
    idempotencyKey: string;
    refId?: string;
  }): Promise<RechargeOutcome>;
  /** 把到期仍 held 的预授权置 expired 并解冻，返回处理笔数。 */
  sweepExpiredHolds(input: { limit: number }): Promise<number>;
}

export function availableBalance(wallet: WalletView): number {
  return wallet.principalBalance + wallet.bonusBalance - wallet.heldAmount;
}

/** 先赠后本：赠送桶优先扣减，不足部分扣本金桶。允许扣成负数（透支），硬停在 hold 入口。 */
export function splitDeduction(wallet: WalletView, actualAmount: number): SettleDeductions {
  if (!Number.isSafeInteger(actualAmount) || actualAmount < 0) {
    throw new TypeError('actual amount must be a non-negative integer');
  }
  const bonus = Math.min(Math.max(wallet.bonusBalance, 0), actualAmount);
  return { bonus, principal: actualAmount - bonus };
}

/** ledger 幂等键约定：同一动作重放永远得到同一键。 */
function scopedIdempotencyKey(scope: string, value: string): string {
  return `${scope}:v1:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export const ledgerIdempotencyKeys = {
  hold: (agentId: string, turnId: string) =>
    `hold:v1:${createHash('sha256')
      .update(JSON.stringify([agentId, turnId]))
      .digest('hex')}`,
  settle: (holdId: string, bucket: 'principal' | 'bonus') => `settle:${holdId}:${bucket}`,
  release: (holdId: string) => `release:${holdId}`,
  recharge: (callerKey: string) => scopedIdempotencyKey('recharge', callerKey),
};

/** 调用方 metering key 进入独立持久化域，不能预占 settle 生成的 estimated key。 */
export function persistedMeteringIdempotencyKey(callerKey: string): string {
  return scopedIdempotencyKey('meter-reported', callerKey);
}
