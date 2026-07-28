export type PaymentGatewayEnvironment = 'test' | 'production';
export type PaymentChannel = 'h5' | 'aggregate_qr';
export type H5PayType = 'wechat' | 'alipay';

export interface PaymentAction {
  kind: 'redirect_url' | 'code_url';
  value: string;
  expiresAt: Date;
}

export interface CreatePaymentCommand {
  orderNo: string;
  payTraceNo: string;
  payTime: string;
  amountCents: bigint;
  channel: PaymentChannel;
  payType?: H5PayType;
}

export interface PaymentSubmission {
  status: 'pending' | 'failed' | 'unknown';
  gatewayResultCode?: string;
  platformTradeNo?: string;
  action?: PaymentAction;
}

export interface QueryPaymentCommand {
  payTraceNo: string;
  payTime: string;
  amountCents: bigint;
  platformTradeNo?: string;
}

export interface PaymentQueryResult {
  status: 'succeeded' | 'pending' | 'failed' | 'unknown';
  gatewayResultCode?: string;
  platformTradeNo?: string;
  paidAt?: Date;
}

export interface VerifiedPaymentNotification {
  eventFingerprint: string;
  gatewayEnvironment: PaymentGatewayEnvironment;
  institutionNo: string;
  merchantNo: string;
  payTraceNo: string;
  payTime: string;
  amountCents: bigint;
  platformTradeNo: string;
  resultCode: string;
  returnCode: string;
  tradeType?: string;
  attach?: string;
  paidAt?: Date;
}

export interface PaymentGateway {
  readonly configured: boolean;
  readonly environment: PaymentGatewayEnvironment;
  readonly institutionNo: string;
  readonly merchantNo: string;
  createPayment(command: CreatePaymentCommand): Promise<PaymentSubmission>;
  queryPayment(command: QueryPaymentCommand): Promise<PaymentQueryResult>;
  verifyPaymentNotification(input: unknown): VerifiedPaymentNotification;
}

/** 固定错误文案不包含网关响应、URL、签名参数或密钥。 */
export class PaymentGatewayUnavailableError extends Error {
  constructor() {
    super('payment gateway is unavailable');
    this.name = 'PaymentGatewayUnavailableError';
  }
}

/** 下单结果不确定时只能查原订单，不允许上层盲目重下。 */
export class PaymentGatewayUncertainError extends Error {
  constructor() {
    super('payment gateway outcome is uncertain');
    this.name = 'PaymentGatewayUncertainError';
  }
}

export class InvalidPaymentNotificationError extends Error {
  constructor(
    readonly reason: 'invalid_signature' | 'invalid_payload' = 'invalid_payload',
    readonly signatureValid = false,
  ) {
    super('payment notification is invalid');
    this.name = 'InvalidPaymentNotificationError';
  }
}
