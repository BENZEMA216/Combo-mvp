import { createHash, randomBytes } from 'node:crypto';
import type { BillingConfiguration } from '../../platform/config/env.js';
import {
  InvalidPaymentNotificationError,
  PaymentGatewayUnavailableError,
  asSigningParameters,
  fingerprintPaymentParameters,
  type PayType,
  type PaymentChannel,
  type PaymentGateway,
} from '../../platform/infra/leshouying/index.js';
import {
  BillingNotFoundError,
  BillingUnavailableError,
  BillingValidationError,
  type BillingRepository,
  type LeasedRechargeOrder,
  type RechargeOrder,
  type WalletBalance,
} from './types.js';

export interface CreateRechargeOrderInput {
  ownerUserId: string;
  recoveryUsageId?: string;
  rechargeIntentId: string;
  amountCents: bigint;
  channel: PaymentChannel;
  payType: PayType;
}

export interface CreateRechargeOrderResult {
  order: RechargeOrder;
  created: boolean;
  submitted: boolean;
}

export interface BillingServiceClock {
  now(): Date;
  randomHex(bytes: number): string;
}

const SYSTEM_CLOCK: BillingServiceClock = {
  now: () => new Date(),
  randomHex: (bytes) => randomBytes(bytes).toString('hex'),
};

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

/** 乐收赢时间字段按中国标准时间格式化，不依赖容器本地时区。 */
export function formatLeshouyingTime(date: Date): string {
  const china = new Date(date.getTime() + 8 * 60 * 60 * 1_000);
  return [
    china.getUTCFullYear().toString().padStart(4, '0'),
    pad(china.getUTCMonth() + 1),
    pad(china.getUTCDate()),
    pad(china.getUTCHours()),
    pad(china.getUTCMinutes()),
    pad(china.getUTCSeconds()),
  ].join('');
}

function requestFingerprint(input: CreateRechargeOrderInput, amountCents: bigint): string {
  const canonical = JSON.stringify({
    ownerUserId: input.ownerUserId,
    ...(input.recoveryUsageId ? { recoveryUsageId: input.recoveryUsageId } : {}),
    rechargeIntentId: input.rechargeIntentId,
    amountCents: amountCents.toString(),
    channel: input.channel,
    payType: input.payType,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function untrustedEventFingerprint(input: unknown): string {
  try {
    return fingerprintPaymentParameters(asSigningParameters(input));
  } catch {
    let serialized = '';
    try {
      serialized = JSON.stringify(input) ?? '';
    } catch {
      serialized = '';
    }
    return createHash('sha256').update(serialized, 'utf8').digest('hex');
  }
}

function validatePaymentSelection(input: CreateRechargeOrderInput): void {
  if (input.payType !== 'wechat' && input.payType !== 'alipay') {
    throw new BillingValidationError();
  }
}

export async function createRechargeOrder(
  repository: BillingRepository,
  gateway: PaymentGateway,
  configuration: BillingConfiguration,
  input: CreateRechargeOrderInput,
  clock: BillingServiceClock = SYSTEM_CLOCK,
): Promise<CreateRechargeOrderResult> {
  const normalizedInput: CreateRechargeOrderInput = {
    ...input,
    ...(input.recoveryUsageId ? { recoveryUsageId: input.recoveryUsageId.toLowerCase() } : {}),
    rechargeIntentId: input.rechargeIntentId.toLowerCase(),
  };
  validatePaymentSelection(normalizedInput);
  if (!gateway.configured || !configuration.gatewayEnabled) {
    throw new BillingUnavailableError();
  }
  const amountCents = normalizedInput.amountCents;
  if (amountCents <= 0n || amountCents > 99_999_999n) throw new BillingValidationError();

  const now = clock.now();
  const payTime = formatLeshouyingTime(now);
  const prepared = await repository.prepareRecharge({
    orderNo: `CBR${payTime}${clock.randomHex(8)}`,
    ownerUserId: input.ownerUserId,
    ...(normalizedInput.recoveryUsageId
      ? { recoveryUsageId: normalizedInput.recoveryUsageId }
      : {}),
    clientIdempotencyKey: normalizedInput.rechargeIntentId,
    // 套餐体系已移除：package_id 保留为哨兵，金额由调用方直接提交。
    packageId: 'manual',
    amountCents,
    paymentMethod: normalizedInput.channel,
    payType: normalizedInput.payType,
    gatewayEnvironment: gateway.environment,
    institutionNo: gateway.institutionNo,
    merchantNo: gateway.merchantNo,
    payTraceNo: `CB${payTime}${clock.randomHex(8)}`,
    payTime,
    requestFingerprint: requestFingerprint(normalizedInput, amountCents),
    submissionRecoveryMs: configuration.submissionRecoveryMs,
  });
  if (!prepared.shouldSubmit) {
    return { order: prepared.order, created: false, submitted: false };
  }

  let submission;
  try {
    submission = await gateway.createPayment({
      orderNo: prepared.order.orderNo,
      payTraceNo: prepared.order.payTraceNo,
      payTime: prepared.order.payTime,
      amountCents: prepared.order.amountCents,
      channel: prepared.order.paymentMethod,
      payType: normalizedInput.payType,
    });
  } catch {
    submission = { status: 'unknown' as const };
  }
  const order = await repository.recordSubmission(
    prepared.order.id,
    prepared.order.attemptNo,
    submission,
  );
  return {
    order,
    created: prepared.created,
    submitted: true,
  };
}

export async function getWallet(
  repository: BillingRepository,
  ownerUserId: string,
): Promise<WalletBalance> {
  return repository.getWallet(ownerUserId);
}

export async function getRechargeOrder(
  repository: BillingRepository,
  ownerUserId: string,
  orderId: string,
): Promise<RechargeOrder> {
  const order = await repository.findRechargeOrder(ownerUserId, orderId);
  if (!order) throw new BillingNotFoundError();
  return order;
}

async function queryLeasedOrder(
  repository: BillingRepository,
  gateway: PaymentGateway,
  order: LeasedRechargeOrder,
): Promise<'succeeded' | 'pending' | 'failed' | 'unknown'> {
  let queryResult;
  if (
    !gateway.configured ||
    order.gatewayEnvironment !== gateway.environment ||
    order.institutionNo !== gateway.institutionNo ||
    order.merchantNo !== gateway.merchantNo
  ) {
    queryResult = { status: 'unknown' as const };
  } else {
    try {
      queryResult = await gateway.queryPayment({
        payTraceNo: order.payTraceNo,
        payTime: order.payTime,
        amountCents: order.amountCents,
        ...(order.platformTradeNo ? { platformTradeNo: order.platformTradeNo } : {}),
      });
    } catch {
      queryResult = { status: 'unknown' as const };
    }
  }
  await repository.applyQueryResult(order, queryResult);
  return queryResult.status;
}

/** 用户轮询内部订单时，只在原订单已到查单时间且成功领取短租约后做一次权威补偿查询。 */
export async function getRechargeOrderWithReconciliation(
  repository: BillingRepository,
  gateway: PaymentGateway,
  input: { ownerUserId: string; orderId: string; leaseOwner: string },
): Promise<RechargeOrder> {
  const current = await getRechargeOrder(repository, input.ownerUserId, input.orderId);
  if (
    current.creditStatus === 'credited' ||
    !current.reconciliationActive ||
    !gateway.configured ||
    current.gatewayEnvironment !== gateway.environment ||
    current.institutionNo !== gateway.institutionNo ||
    current.merchantNo !== gateway.merchantNo
  ) {
    return current;
  }
  const leased = await repository.leaseRechargeOrderForOwner({
    ownerUserId: input.ownerUserId,
    orderId: input.orderId,
    leaseOwner: input.leaseOwner,
    leaseMs: 30_000,
  });
  if (!leased) return current;
  await queryLeasedOrder(repository, gateway, leased);
  return getRechargeOrder(repository, input.ownerUserId, input.orderId);
}

export async function getRechargeOrderByIntentWithReconciliation(
  repository: BillingRepository,
  gateway: PaymentGateway,
  input: { ownerUserId: string; rechargeIntentId: string; leaseOwner: string },
): Promise<RechargeOrder | null> {
  const order = await repository.findRechargeOrderByIntent(
    input.ownerUserId,
    input.rechargeIntentId.toLowerCase(),
  );
  if (!order) return null;
  return getRechargeOrderWithReconciliation(repository, gateway, {
    ownerUserId: input.ownerUserId,
    orderId: order.id,
    leaseOwner: input.leaseOwner,
  });
}

export async function getRechargeOrderByRecoveryWithReconciliation(
  repository: BillingRepository,
  gateway: PaymentGateway,
  input: { ownerUserId: string; recoveryUsageId: string; leaseOwner: string },
): Promise<RechargeOrder | null> {
  const order = await repository.findRechargeOrderByRecovery(
    input.ownerUserId,
    input.recoveryUsageId.toLowerCase(),
  );
  if (!order) return null;
  return getRechargeOrderWithReconciliation(repository, gateway, {
    ownerUserId: input.ownerUserId,
    orderId: order.id,
    leaseOwner: input.leaseOwner,
  });
}

export async function handlePaymentNotification(
  repository: BillingRepository,
  gateway: PaymentGateway,
  input: unknown,
): Promise<'processed' | 'duplicate' | 'rejected'> {
  let notification;
  try {
    notification = gateway.verifyPaymentNotification(input);
  } catch (error) {
    if (error instanceof PaymentGatewayUnavailableError) {
      throw new BillingUnavailableError();
    }
    if (error instanceof InvalidPaymentNotificationError) {
      // An unauthenticated caller must not be able to grow the callback audit
      // table. Only payloads whose provider signature was already verified may
      // create a rejected audit event.
      if (error.signatureValid) {
        await repository.recordSignedRejectedCallback({
          eventFingerprint: untrustedEventFingerprint(input),
          rejectionCode: error.reason,
        });
      }
      return 'rejected';
    }
    throw error;
  }
  return repository.processNotification(notification);
}

export interface ReconcileResult {
  leased: number;
  succeeded: number;
  pending: number;
  failed: number;
  unknown: number;
}

/**
 * 领取并查验到期订单。由 API 后台调度或用户轮询触发；authoring worker 不参与。
 * 查询请求复用原支付身份，任何异常只会把订单留在 unknown 并延后再查。
 */
export async function reconcileDueRechargeOrders(
  repository: BillingRepository,
  gateway: PaymentGateway,
  input: { leaseOwner: string; limit?: number; leaseMs?: number },
): Promise<ReconcileResult> {
  if (!gateway.configured) throw new BillingUnavailableError();
  const leased = await repository.leaseDueRechargeOrders({
    leaseOwner: input.leaseOwner,
    limit: input.limit ?? 10,
    leaseMs: input.leaseMs ?? 30_000,
    gatewayEnvironment: gateway.environment,
    institutionNo: gateway.institutionNo,
    merchantNo: gateway.merchantNo,
  });
  const result: ReconcileResult = {
    leased: leased.length,
    succeeded: 0,
    pending: 0,
    failed: 0,
    unknown: 0,
  };
  for (const order of leased) {
    const status = await queryLeasedOrder(repository, gateway, order);
    result[status] += 1;
  }
  return result;
}
