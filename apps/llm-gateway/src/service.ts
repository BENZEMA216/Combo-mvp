// 编排核心：请求解析、check-and-hold、usage 折算与 metering/settle 收尾。
// 与 HTTP 层分离：app.ts 只负责 provider 字节搬运，编排全部在这里，可注桩单测。
import { z } from 'zod';
import { usageToMeteringEvents, type BillingClient, type CreateHoldResult } from './billing.js';
import {
  amountFromUsage,
  estimateHoldAmount,
  type ModelPrice,
  type TokenUsage,
} from './pricing.js';

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 平台扩展字段：Agent 经 SDK 携带，转发给 provider 前剥离。 */
const PlatformSchema = z
  .object({
    user_id: z.string().regex(UUID_PATTERN),
    agent_id: z.string().regex(AGENT_ID_PATTERN),
    turn_id: z.string().min(1).max(128),
  })
  .strict();

const ChatBodySchema = z
  .object({
    model: z.string().min(1).max(128),
    messages: z.array(z.unknown()).min(1),
    stream: z.boolean().optional(),
    max_tokens: z.number().int().positive().max(1_000_000).optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().optional(),
    x_combo: PlatformSchema,
  })
  .passthrough();

export interface PlatformContext {
  userId: string;
  agentId: string;
  turnId: string;
}

export interface ParsedChatRequest {
  platform: PlatformContext;
  model: string;
  stream: boolean;
  maxTokens: number;
  /** 剥离 x_combo、流式强制 include_usage 后的转发体。 */
  forwardBody: Record<string, unknown>;
}

export function parseChatRequest(
  body: unknown,
  defaultMaxTokens: number,
): ParsedChatRequest | null {
  const parsed = ChatBodySchema.safeParse(body);
  if (!parsed.success) return null;

  const {
    x_combo: platform,
    stream,
    max_tokens: maxTokens,
    stream_options: streamOptions,
    ...rest
  } = parsed.data;
  const isStream = stream === true;
  const forwardBody: Record<string, unknown> = {
    ...rest,
    model: parsed.data.model,
    messages: parsed.data.messages,
  };
  if (stream !== undefined) forwardBody.stream = stream;
  if (isStream) {
    forwardBody.stream_options = { ...(streamOptions ?? {}), include_usage: true };
  } else if (streamOptions !== undefined) {
    forwardBody.stream_options = streamOptions;
  }

  return {
    platform: {
      userId: platform.user_id,
      agentId: platform.agent_id,
      turnId: platform.turn_id,
    },
    model: parsed.data.model,
    stream: isStream,
    maxTokens: maxTokens ?? defaultMaxTokens,
    forwardBody,
  };
}

export type HoldOutcome =
  | { kind: 'held'; holdId: string; estimatedAmount: number }
  | { kind: 'rejected'; status: number; body: unknown }
  | { kind: 'fail_open'; estimatedAmount: number };

export interface GatewayLogger {
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/**
 * check-and-hold：402 明确拒绝原样透传；超时 / 5xx / 网络错误按维度降级——
 * 本期只有 chat 维度，fail-open 放行（billing 侧负五元硬停是兜底）。
 */
export async function checkAndHold(
  billing: BillingClient,
  input: {
    platform: PlatformContext;
    price: ModelPrice;
    maxTokens: number;
    fixedCostCents: number;
  },
  log: GatewayLogger,
): Promise<HoldOutcome> {
  const estimatedAmount = estimateHoldAmount({
    price: input.price,
    maxTokens: input.maxTokens,
    fixedCostCents: input.fixedCostCents,
  });

  let result: CreateHoldResult;
  try {
    result = await billing.createHold({
      userId: input.platform.userId,
      agentId: input.platform.agentId,
      turnId: input.platform.turnId,
      estimatedAmount,
    });
  } catch (error) {
    log.warn(
      {
        agent_id: input.platform.agentId,
        turn_id: input.platform.turnId,
        err: error,
        fail_open: true,
      },
      'billing hold unavailable; failing open for chat dimension',
    );
    return { kind: 'fail_open', estimatedAmount };
  }
  if (result.kind === 'rejected') {
    return { kind: 'rejected', status: result.status, body: result.body };
  }
  return { kind: 'held', holdId: result.holdId, estimatedAmount };
}

/**
 * 收尾：有真实 usage 先推两条计量事件（带 hold_id）再按实 settle；
 * usage 缺失按估算 settle（billing 自动补 estimated 计量行）；fail-open 只推计量不 settle。
 * 任何收尾失败只记 error 日志，留给清扫任务过期解冻，绝不影响已发出的响应。
 */
export async function finalizeTurn(
  billing: BillingClient,
  input: {
    hold: HoldOutcome;
    platform: PlatformContext;
    model: string;
    price: ModelPrice;
    usage: TokenUsage | null;
  },
  log: GatewayLogger,
): Promise<void> {
  const base = {
    agentId: input.platform.agentId,
    userId: input.platform.userId,
    turnId: input.platform.turnId,
    model: input.model,
  };
  const logFields = { agent_id: base.agentId, turn_id: base.turnId };

  if (input.usage) {
    try {
      await billing.reportUsage(
        usageToMeteringEvents({
          usage: input.usage,
          price: input.price,
          ...(input.hold.kind === 'held' ? { holdId: input.hold.holdId } : {}),
          ...base,
        }),
      );
    } catch (error) {
      log.error({ ...logFields, err: error }, 'usage report failed');
    }
  }

  if (input.hold.kind !== 'held') return;

  const actualAmount = input.usage
    ? amountFromUsage(input.usage, input.price)
    : input.hold.estimatedAmount;
  try {
    await billing.settle({ holdId: input.hold.holdId, actualAmount });
  } catch (error) {
    log.error(
      { ...logFields, err: error, hold_id: input.hold.holdId },
      'settle failed; hold left for the sweeper to expire',
    );
  }
}

/** provider 调用失败（非 2xx）时按零用量 settle，等价于释放全部冻结。 */
export async function releaseHold(
  billing: BillingClient,
  hold: HoldOutcome,
  log: GatewayLogger,
  logFields: Record<string, unknown>,
): Promise<void> {
  if (hold.kind !== 'held') return;
  try {
    await billing.settle({ holdId: hold.holdId, actualAmount: 0 });
  } catch (error) {
    log.error({ ...logFields, err: error, hold_id: hold.holdId }, 'hold release failed');
  }
}
