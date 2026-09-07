// 启动配置：所有环境变量在这里解析与校验，进程其余部分只读结构化结果。
import { estimateHoldAmount, parsePricingTable, type PricingTable } from './pricing.js';

export interface GatewayEnv {
  NODE_ENV: string;
  PORT: number;
  HOST: string;
  /** 平台内部 token：Agent 调网关入口的 Bearer 凭据。 */
  GATEWAY_INTERNAL_TOKEN: string;
  BILLING_BASE_URL: string;
  /** 网关调 billing 三个接口的 Bearer 凭据。 */
  BILLING_INTERNAL_TOKEN: string;
  /** New payment admission is enabled only with a dedicated Gateway-to-Billing credential. */
  PAYMENT_ADMISSION_TOKEN?: string;
  /** 计费调用超时（毫秒）；超时和 5xx 均停止模型调用。 */
  BILLING_TIMEOUT_MS: number;
  PROVIDER_BASE_URL: string;
  /** provider key 的唯一存放点，只在本进程内存中使用。 */
  PROVIDER_API_KEY: string;
  PRICING: PricingTable;
  /** 预授权在预估 token 成本外额外冻结的固定成本（分）。 */
  HOLD_FIXED_COST_CENTS: number;
  /** 请求未给 max_tokens 时的估算上限，宁高勿低。 */
  DEFAULT_MAX_TOKENS: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function requiredToken(name: string): string {
  const value = required(name);
  if (value.length < 16) throw new Error(`${name} must be at least 16 characters`);
  return value;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? 4103);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new Error('PORT must be an integer within 1..65535');
  }
  return port;
}

function parsePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = Number(raw ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = Number(raw ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

export function loadEnv(): GatewayEnv {
  const paymentMode = process.env.LLM_GATEWAY_PAYMENT_ADMISSION ?? 'false';
  if (paymentMode !== 'true' && paymentMode !== 'false')
    throw new Error('LLM_GATEWAY_PAYMENT_ADMISSION must be true or false');
  const paymentToken =
    paymentMode === 'true' ? requiredToken('BILLING_PAYMENT_GATEWAY_TOKEN') : undefined;
  if (paymentToken && paymentToken === process.env.LLM_GATEWAY_INTERNAL_TOKEN)
    throw new Error('payment admission requires a separate Gateway-to-Billing credential');
  const pricing = parsePricingTable(required('LLM_GATEWAY_PRICING_JSON'));
  const fixedCostCents = parseNonNegativeInt('LLM_GATEWAY_HOLD_FIXED_COST_CENTS', 1);
  for (const price of Object.values(pricing)) {
    try {
      estimateHoldAmount({ price, maxTokens: 1_000_000, fixedCostCents });
    } catch {
      throw new Error('LLM gateway pricing exceeds the safe accounting range');
    }
  }
  return {
    NODE_ENV: process.env.NODE_ENV ?? 'development',
    PORT: parsePort(process.env.PORT),
    HOST: process.env.HOST ?? '0.0.0.0',
    GATEWAY_INTERNAL_TOKEN: requiredToken('LLM_GATEWAY_INTERNAL_TOKEN'),
    BILLING_BASE_URL: required('BILLING_BASE_URL'),
    BILLING_INTERNAL_TOKEN: requiredToken('BILLING_INTERNAL_TOKEN'),
    ...(paymentToken ? { PAYMENT_ADMISSION_TOKEN: paymentToken } : {}),
    BILLING_TIMEOUT_MS: parsePositiveInt('BILLING_TIMEOUT_MS', 2_000),
    PROVIDER_BASE_URL: required('PROVIDER_BASE_URL'),
    PROVIDER_API_KEY: required('PROVIDER_API_KEY'),
    PRICING: pricing,
    HOLD_FIXED_COST_CENTS: fixedCostCents,
    DEFAULT_MAX_TOKENS: parsePositiveInt('LLM_GATEWAY_DEFAULT_MAX_TOKENS', 4_096),
  };
}
