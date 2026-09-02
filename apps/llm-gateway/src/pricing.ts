// 单价表与金额折算。价格单位是分 / 百万 token，按模型匹配、缺省回落 default。
// 预授权估算宁高勿低（spec 八）：只按输出上限估，加固定成本。

export interface ModelPrice {
  /** 输入单价，分 / 百万 token。 */
  input: number;
  /** 输出单价，分 / 百万 token。 */
  output: number;
}

export type PricingTable = Record<string, ModelPrice> & { default: ModelPrice };

function isPrice(value: unknown): value is ModelPrice {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(candidate.input) &&
    (candidate.input as number) >= 0 &&
    Number.isSafeInteger(candidate.output) &&
    (candidate.output as number) >= 0
  );
}

/** LLM_GATEWAY_PRICING_JSON：{"default":{...},"deepseek-chat":{...}}，必须有 default。 */
export function parsePricingTable(raw: string): PricingTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('LLM_GATEWAY_PRICING_JSON must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('LLM_GATEWAY_PRICING_JSON must be an object of model prices');
  }
  const table = parsed as Record<string, unknown>;
  if (!isPrice(table.default)) {
    throw new Error('LLM_GATEWAY_PRICING_JSON requires a default price entry');
  }
  for (const [model, price] of Object.entries(table)) {
    if (!isPrice(price)) throw new Error(`LLM_GATEWAY_PRICING_JSON entry ${model} is invalid`);
  }
  return table as PricingTable;
}

export function priceFor(pricing: PricingTable, model: string): ModelPrice {
  return pricing[model] ?? pricing.default;
}

const MILLION = 1_000_000n;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

function asSafeNonNegativeInteger(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return BigInt(value);
}

function safeCents(value: bigint): number {
  if (value > MAX_SAFE_INTEGER) throw new RangeError('billing amount exceeds safe integer range');
  return Number(value);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/** 预授权估算（分）：max_tokens × 输出单价 + 固定成本。 */
export function estimateHoldAmount(options: {
  price: ModelPrice;
  maxTokens: number;
  fixedCostCents: number;
}): number {
  const maxTokens = asSafeNonNegativeInteger(options.maxTokens, 'maxTokens');
  const outputPrice = asSafeNonNegativeInteger(options.price.output, 'output price');
  const fixedCost = asSafeNonNegativeInteger(options.fixedCostCents, 'fixed cost');
  return safeCents(ceilDiv(maxTokens * outputPrice, MILLION) + fixedCost);
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

/** 按真实用量折算（分）：输入输出分别计价后合并进位。 */
export function amountFromUsage(usage: TokenUsage, price: ModelPrice): number {
  const promptTokens = asSafeNonNegativeInteger(usage.promptTokens, 'prompt tokens');
  const completionTokens = asSafeNonNegativeInteger(usage.completionTokens, 'completion tokens');
  const inputPrice = asSafeNonNegativeInteger(price.input, 'input price');
  const outputPrice = asSafeNonNegativeInteger(price.output, 'output price');
  return safeCents(ceilDiv(promptTokens * inputPrice + completionTokens * outputPrice, MILLION));
}
