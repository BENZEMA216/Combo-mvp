import { randomBytes } from 'node:crypto';
import {
  asSigningParameters,
  fingerprintPaymentParameters,
  signPaymentParameters,
  verifyPaymentSignature,
  type SigningParameters,
} from './signer.js';
import {
  InvalidPaymentNotificationError,
  PaymentGatewayUncertainError,
  PaymentGatewayUnavailableError,
  type CreatePaymentCommand,
  type PaymentGateway,
  type PaymentGatewayEnvironment,
  type PaymentQueryResult,
  type PaymentSubmission,
  type QueryPaymentCommand,
  type VerifiedPaymentNotification,
} from './types.js';

export const LESHOUYING_BASE_URLS = {
  TEST: 'https://test.gdyfsk.com/yfpay',
  PRODUCTION: 'https://open.gdyfsk.com/yfpay',
} as const;

const MAX_RESPONSE_BYTES = 64 * 1024;
const PAYMENT_ACTION_TTL_MS = 15 * 60 * 1_000;

export interface LeshouyingGatewayConfig {
  environment: 'TEST' | 'PRODUCTION';
  institutionNo: string;
  merchantNo: string;
  institutionKey: string;
  notifyUrl: string;
  timeoutMs: number;
}

type FetchPort = (input: string, init: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new PaymentGatewayUncertainError();
  }
  return String(value);
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new PaymentGatewayUncertainError();
  }
  return String(value);
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function callbackString(
  record: Record<string, unknown>,
  key: string,
  input: { min: number; max: number; pattern?: RegExp },
): string {
  const value = record[key];
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new InvalidPaymentNotificationError('invalid_payload', true);
  }
  const normalized = String(value);
  if (
    normalized.length < input.min ||
    normalized.length > input.max ||
    containsControlCharacter(normalized) ||
    (input.pattern && !input.pattern.test(normalized))
  ) {
    throw new InvalidPaymentNotificationError('invalid_payload', true);
  }
  return normalized;
}

function parseAmount(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,18})$/u.test(value)) throw new PaymentGatewayUncertainError();
  return BigInt(value);
}

function parseGatewayDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/u);
  const displayed = value.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/u,
  );
  const parts = compact ?? displayed;
  if (!parts) return undefined;
  const [, year, month, day, hour, minute, second, fraction] = parts;
  const millisecond = (fraction ?? '').padEnd(3, '0');
  const parsed = new Date(
    `${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond || '000'}+08:00`,
  );
  if (Number.isNaN(parsed.getTime())) return undefined;
  const china = new Date(parsed.getTime() + 8 * 60 * 60 * 1_000);
  if (
    china.getUTCFullYear() !== Number(year) ||
    china.getUTCMonth() + 1 !== Number(month) ||
    china.getUTCDate() !== Number(day) ||
    china.getUTCHours() !== Number(hour) ||
    china.getUTCMinutes() !== Number(minute) ||
    china.getUTCSeconds() !== Number(second)
  ) {
    return undefined;
  }
  return parsed;
}

function safeQrContent(value: string): string {
  if (value.length < 1 || value.length > 2_048 || containsControlCharacter(value)) {
    throw new PaymentGatewayUncertainError();
  }
  return value;
}

function gatewayPayType(payType: CreatePaymentCommand['payType']): string {
  if (payType === 'wechat') return '400';
  if (payType === 'alipay') return '300';
  throw new PaymentGatewayUncertainError();
}

function gatewayEnvironment(value: 'TEST' | 'PRODUCTION'): PaymentGatewayEnvironment {
  return value === 'TEST' ? 'test' : 'production';
}

async function readResponseText(response: Response, signal: AbortSignal): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new PaymentGatewayUncertainError();
  }

  const body = response.body;
  if (!body) throw new PaymentGatewayUncertainError();
  const reader = body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      if (signal.aborted) {
        abort();
        throw new PaymentGatewayUncertainError();
      }
      const { done, value } = await reader.read();
      if (signal.aborted) throw new PaymentGatewayUncertainError();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new PaymentGatewayUncertainError();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, receivedBytes));
}

export class LeshouyingPaymentGateway implements PaymentGateway {
  readonly configured = true;
  readonly environment: PaymentGatewayEnvironment;
  readonly institutionNo: string;
  readonly merchantNo: string;
  readonly #config: LeshouyingGatewayConfig;
  readonly #fetch: FetchPort;

  constructor(config: LeshouyingGatewayConfig, fetchPort: FetchPort = fetch) {
    try {
      const notify = new URL(config.notifyUrl);
      if (
        !['TEST', 'PRODUCTION'].includes(config.environment) ||
        !config.institutionNo ||
        config.institutionNo.length > 32 ||
        !config.merchantNo ||
        config.merchantNo.length > 64 ||
        config.institutionKey.length < 16 ||
        !Number.isSafeInteger(config.timeoutMs) ||
        config.timeoutMs < 100 ||
        config.timeoutMs > 5000 ||
        notify.protocol !== 'https:' ||
        notify.username ||
        notify.password ||
        notify.search ||
        notify.hash
      )
        throw new Error();
    } catch {
      throw new PaymentGatewayUnavailableError();
    }
    this.#config = config;
    this.#fetch = fetchPort;
    this.environment = gatewayEnvironment(config.environment);
    this.institutionNo = config.institutionNo;
    this.merchantNo = config.merchantNo;
  }

  async #post(path: '/v3/prepay' | '/v3/queryorder', body: SigningParameters) {
    const signed = {
      ...body,
      sign: signPaymentParameters(body, this.#config.institutionKey),
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#config.timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.#fetch(
        `${LESHOUYING_BASE_URLS[this.#config.environment]}${path}`,
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json;charset=utf-8',
          },
          body: JSON.stringify(signed),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new PaymentGatewayUncertainError();
      }
      const responseType = response.headers.get('content-type');
      if (responseType && !responseType.toLowerCase().startsWith('application/json')) {
        void response.body?.cancel().catch(() => undefined);
        throw new PaymentGatewayUncertainError();
      }
      const text = await readResponseText(response, controller.signal);
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)) throw new PaymentGatewayUncertainError();
      const signingParameters = asSigningParameters(parsed);
      if (!verifyPaymentSignature(signingParameters, this.#config.institutionKey)) {
        throw new PaymentGatewayUncertainError();
      }
      return parsed;
    } catch {
      throw new PaymentGatewayUncertainError();
    } finally {
      clearTimeout(timeout);
    }
  }

  async createPayment(command: CreatePaymentCommand): Promise<PaymentSubmission> {
    // 只保留 C扫B 二维码（/v3/prepay）：H5 收银台已移除。prepay 契约没有
    // front_url 字段，请求体只带公共参数 + pay_type + time_expire。
    const common: Record<string, string> = {
      inst_no: this.institutionNo,
      mch_no: this.merchantNo,
      pay_trace_no: command.payTraceNo,
      pay_time: command.payTime,
      total_amount: command.amountCents.toString(),
      order_body: 'Combo余额充值',
      attach: command.orderNo,
      notify_url: this.#config.notifyUrl,
    };
    const request = { ...common, pay_type: gatewayPayType(command.payType), time_expire: '15' };
    const response = await this.#post('/v3/prepay', request);
    this.#assertResponseOwnership(response, command);
    if (requiredString(response, 'pay_type') !== gatewayPayType(command.payType)) {
      throw new PaymentGatewayUncertainError();
    }
    const returnCode = requiredString(response, 'return_code');
    const resultCode = optionalString(response, 'result_code');
    if (returnCode !== 'SUCCESS' || resultCode === 'PAY_FAIL') {
      return { status: 'failed', ...(resultCode ? { gatewayResultCode: resultCode } : {}) };
    }
    if (resultCode !== 'PAY_SUCCESS') {
      return { status: 'unknown', ...(resultCode ? { gatewayResultCode: resultCode } : {}) };
    }
    const codeUrl = safeQrContent(requiredString(response, 'qrcode'));
    const tradeNo = optionalString(response, 'trade_no');
    return {
      status: 'pending',
      gatewayResultCode: resultCode,
      ...(tradeNo ? { platformTradeNo: tradeNo } : {}),
      action: {
        kind: 'code_url',
        value: codeUrl,
        // The gateway action is bearer-like, short-lived. Combo stops returning it
        // after this bound even if the provider keeps the code valid.
        expiresAt: new Date(Date.now() + PAYMENT_ACTION_TTL_MS),
      },
    };
  }

  async queryPayment(command: QueryPaymentCommand): Promise<PaymentQueryResult> {
    const queryTraceNo = randomBytes(16).toString('hex');
    const request: Record<string, string> = {
      inst_no: this.institutionNo,
      mch_no: this.merchantNo,
      query_trace_no: queryTraceNo,
      ...(command.platformTradeNo
        ? { trade_no: command.platformTradeNo }
        : { pay_trace_no: command.payTraceNo, pay_time: command.payTime }),
    };
    const response = await this.#post('/v3/queryorder', request);
    const merchantNo = requiredString(response, 'mch_no');
    const responseQueryTraceNo = requiredString(response, 'query_trace_no');
    const payTraceNo = requiredString(response, 'pay_trace_no');
    const payTime = requiredString(response, 'pay_time');
    const amount = parseAmount(requiredString(response, 'total_amount'));
    if (
      merchantNo !== this.merchantNo ||
      responseQueryTraceNo !== queryTraceNo ||
      payTraceNo !== command.payTraceNo ||
      payTime !== command.payTime ||
      amount !== command.amountCents
    ) {
      throw new PaymentGatewayUncertainError();
    }
    const returnCode = requiredString(response, 'return_code');
    const resultCode = optionalString(response, 'result_code');
    const platformTradeNo = optionalString(response, 'trade_no');
    if (command.platformTradeNo !== undefined && platformTradeNo !== command.platformTradeNo) {
      throw new PaymentGatewayUncertainError();
    }
    if (returnCode !== 'SUCCESS') {
      return { status: 'unknown', ...(resultCode ? { gatewayResultCode: resultCode } : {}) };
    }
    if (resultCode === 'PAY_SUCCESS') {
      if (!platformTradeNo) throw new PaymentGatewayUncertainError();
      return {
        status: 'succeeded',
        gatewayResultCode: resultCode,
        platformTradeNo,
        ...(parseGatewayDate(optionalString(response, 'end_time'))
          ? { paidAt: parseGatewayDate(optionalString(response, 'end_time')) }
          : {}),
      };
    }
    if (resultCode === 'PAY_IN_PROCESS') {
      return {
        status: 'pending',
        gatewayResultCode: resultCode,
        ...(platformTradeNo ? { platformTradeNo } : {}),
      };
    }
    if (resultCode === 'PAY_FAIL') {
      return {
        status: 'failed',
        gatewayResultCode: resultCode,
        ...(platformTradeNo ? { platformTradeNo } : {}),
      };
    }
    return { status: 'unknown', ...(resultCode ? { gatewayResultCode: resultCode } : {}) };
  }

  verifyPaymentNotification(input: unknown): VerifiedPaymentNotification {
    let parameters: SigningParameters;
    let signatureValid: boolean;
    try {
      parameters = asSigningParameters(input);
      signatureValid = verifyPaymentSignature(parameters, this.#config.institutionKey);
    } catch {
      throw new InvalidPaymentNotificationError('invalid_payload', false);
    }
    if (!signatureValid) {
      throw new InvalidPaymentNotificationError('invalid_signature', false);
    }
    try {
      const record = input as Record<string, unknown>;
      const institutionNo = callbackString(record, 'inst_no', { min: 1, max: 32 });
      const merchantNo = callbackString(record, 'mch_no', { min: 1, max: 64 });
      const payTraceNo = callbackString(record, 'pay_trace_no', { min: 1, max: 64 });
      const payTime = callbackString(record, 'pay_time', {
        min: 14,
        max: 14,
        pattern: /^[0-9]{14}$/u,
      });
      const amountCents = parseAmount(
        callbackString(record, 'total_amount', {
          min: 1,
          max: 18,
          pattern: /^[0-9]+$/u,
        }),
      );
      const platformTradeNo = callbackString(record, 'trade_no', { min: 1, max: 64 });
      if (amountCents <= 0n) {
        throw new InvalidPaymentNotificationError('invalid_payload', true);
      }
      const resultCode = callbackString(record, 'result_code', { min: 1, max: 32 });
      const returnCode = callbackString(record, 'return_code', { min: 1, max: 32 });
      const tradeType = optionalString(record, 'trade_type');
      if (
        tradeType !== undefined &&
        (tradeType.length > 2 || containsControlCharacter(tradeType))
      ) {
        throw new InvalidPaymentNotificationError('invalid_payload', true);
      }
      const attach = optionalString(record, 'attach');
      if (attach !== undefined && (attach.length > 128 || containsControlCharacter(attach))) {
        throw new InvalidPaymentNotificationError('invalid_payload', true);
      }
      const rawPaidAt = optionalString(record, 'end_time');
      if (
        rawPaidAt !== undefined &&
        (rawPaidAt.length > 32 || containsControlCharacter(rawPaidAt))
      ) {
        throw new InvalidPaymentNotificationError('invalid_payload', true);
      }
      const paidAt = parseGatewayDate(rawPaidAt);
      return {
        eventFingerprint: fingerprintPaymentParameters(parameters),
        gatewayEnvironment: this.environment,
        institutionNo,
        merchantNo,
        payTraceNo,
        payTime,
        amountCents,
        platformTradeNo,
        resultCode,
        returnCode,
        ...(tradeType ? { tradeType } : {}),
        ...(attach ? { attach } : {}),
        ...(paidAt ? { paidAt } : {}),
      };
    } catch (error) {
      if (error instanceof InvalidPaymentNotificationError) throw error;
      throw new InvalidPaymentNotificationError('invalid_payload', true);
    }
  }

  #assertResponseOwnership(response: Record<string, unknown>, command: CreatePaymentCommand): void {
    if (
      requiredString(response, 'mch_no') !== this.merchantNo ||
      requiredString(response, 'pay_trace_no') !== command.payTraceNo ||
      requiredString(response, 'pay_time') !== command.payTime ||
      parseAmount(requiredString(response, 'total_amount')) !== command.amountCents
    ) {
      throw new PaymentGatewayUncertainError();
    }
  }
}

export class DisabledPaymentGateway implements PaymentGateway {
  readonly configured = false;
  readonly environment: PaymentGatewayEnvironment = 'test';
  readonly institutionNo = '';
  readonly merchantNo = '';

  async createPayment(): Promise<never> {
    throw new PaymentGatewayUnavailableError();
  }

  async queryPayment(): Promise<never> {
    throw new PaymentGatewayUnavailableError();
  }

  verifyPaymentNotification(): never {
    throw new PaymentGatewayUnavailableError();
  }
}
