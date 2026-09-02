import type {
  PayType,
  PaymentChannel,
  PaymentGatewayEnvironment,
  PaymentQueryResult,
  PaymentSubmission,
  VerifiedPaymentNotification,
} from '../../platform/infra/leshouying/index.js';

export type RechargePaymentStatus =
  | 'created'
  | 'pending'
  | 'unknown'
  | 'succeeded'
  | 'failed'
  | 'closed';
export type RechargeCreditStatus = 'uncredited' | 'credited';

export interface WalletBalance {
  availableCents: bigint;
  reservedCents: bigint;
}

export interface RechargeOrder {
  id: string;
  orderNo: string;
  ownerUserId: string;
  clientIdempotencyKey: string;
  /** Original Runtime usage whose server-authoritative request this order may recover. */
  recoveryUsageId?: string;
  packageId: string;
  amountCents: bigint;
  paymentMethod: PaymentChannel;
  /** 充值支付品牌（微信/支付宝）；历史订单可能没有该列，恢复视图可据此提示扫码应用。 */
  payType?: PayType;
  gatewayEnvironment: PaymentGatewayEnvironment;
  institutionNo: string;
  merchantNo: string;
  payTraceNo: string;
  payTime: string;
  paymentStatus: RechargePaymentStatus;
  creditStatus: RechargeCreditStatus;
  platformTradeNo?: string;
  attemptNo: number;
  requestFingerprint: string;
  action?: {
    kind: 'redirect_url' | 'code_url';
    value: string;
    expiresAt: Date;
  };
  paidAt?: Date;
  creditedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  /** Whether Combo may still issue authoritative queryorder compensation for this order. */
  reconciliationActive: boolean;
}

export interface PrepareRechargeInput {
  orderNo: string;
  ownerUserId: string;
  recoveryUsageId?: string;
  clientIdempotencyKey: string;
  packageId: string;
  amountCents: bigint;
  paymentMethod: PaymentChannel;
  payType: PayType;
  gatewayEnvironment: PaymentGatewayEnvironment;
  institutionNo: string;
  merchantNo: string;
  payTraceNo: string;
  payTime: string;
  requestFingerprint: string;
  submissionRecoveryMs: number;
}

export interface PrepareRechargeResult {
  order: RechargeOrder;
  shouldSubmit: boolean;
  created: boolean;
}

export interface LeasedRechargeOrder extends RechargeOrder {
  queryLeaseOwner: string;
}

export interface BillingRepository {
  getWallet(ownerUserId: string): Promise<WalletBalance>;
  findRechargeOrder(ownerUserId: string, orderId: string): Promise<RechargeOrder | null>;
  findRechargeOrderByIntent(
    ownerUserId: string,
    clientIdempotencyKey: string,
  ): Promise<RechargeOrder | null>;
  findRechargeOrderByRecovery(
    ownerUserId: string,
    recoveryUsageId: string,
  ): Promise<RechargeOrder | null>;
  prepareRecharge(input: PrepareRechargeInput): Promise<PrepareRechargeResult>;
  recordSubmission(
    orderId: string,
    attemptNo: number,
    submission: PaymentSubmission,
  ): Promise<RechargeOrder>;
  recordSignedRejectedCallback(input: {
    eventFingerprint: string;
    rejectionCode: string;
  }): Promise<void>;
  processNotification(
    notification: VerifiedPaymentNotification,
  ): Promise<'processed' | 'duplicate' | 'rejected'>;
  leaseDueRechargeOrders(input: {
    leaseOwner: string;
    limit: number;
    leaseMs: number;
    gatewayEnvironment: PaymentGatewayEnvironment;
    institutionNo: string;
    merchantNo: string;
  }): Promise<LeasedRechargeOrder[]>;
  leaseRechargeOrderForOwner(input: {
    ownerUserId: string;
    orderId: string;
    leaseOwner: string;
    leaseMs: number;
  }): Promise<LeasedRechargeOrder | null>;
  retireExpiredReconciliations(input: { limit: number }): Promise<number>;
  clearExpiredPaymentActions(input: { limit: number }): Promise<number>;
  applyQueryResult(order: LeasedRechargeOrder, result: PaymentQueryResult): Promise<void>;
}

export class BillingValidationError extends Error {
  constructor() {
    super('billing input is invalid');
    this.name = 'BillingValidationError';
  }
}

export class BillingIdempotencyConflictError extends Error {
  constructor() {
    super('billing idempotency conflict');
    this.name = 'BillingIdempotencyConflictError';
  }
}

export class BillingNotFoundError extends Error {
  constructor() {
    super('billing resource not found');
    this.name = 'BillingNotFoundError';
  }
}

export class BillingUnavailableError extends Error {
  constructor() {
    super('billing is unavailable');
    this.name = 'BillingUnavailableError';
  }
}

export class BillingRecoveryUnavailableError extends Error {
  constructor() {
    super('pending usage recovery is unavailable');
    this.name = 'BillingRecoveryUnavailableError';
  }
}

export class BillingRateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('billing admission limit exceeded');
    this.name = 'BillingRateLimitedError';
  }
}
