// billing 服务客户端：hold / settle / usage 推账。端口 + fetch 实现分离，
// 测试注入内存假客户端，不依赖真实 billing 进程。
import type { TokenUsage } from './pricing.js';

export type CreateHoldResult =
  | { kind: 'held'; holdId: string }
  /** billing 明确拒绝（402）：余额不足或透支阻断，body 原样透传给调用方。 */
  | { kind: 'rejected'; status: number; body: unknown };

/** hold 超时、网络错误或 5xx：触发按维度 fail-open / fail-closed 判定。 */
export class BillingUnavailableError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'BillingUnavailableError';
  }
}

export interface MeteringEvent {
  agentId: string;
  userId: string;
  turnId: string;
  holdId?: string;
  dimension: 'llm_token_in' | 'llm_token_out';
  quantity: number;
  model?: string;
  unitCost?: number;
  source: 'gateway';
}

export interface BillingClient {
  createHold(input: {
    userId: string;
    agentId: string;
    turnId: string;
    estimatedAmount: number;
  }): Promise<CreateHoldResult>;
  settle(input: { holdId: string; actualAmount: number }): Promise<void>;
  reportUsage(events: MeteringEvent[]): Promise<void>;
}

/** 按真实用量生成两条计量事件（输入 / 输出分开，unit_cost 是分 / 百万 token）。 */
export function usageToMeteringEvents(options: {
  usage: TokenUsage;
  price: { input: number; output: number };
  model: string;
  agentId: string;
  userId: string;
  turnId: string;
  holdId?: string;
}): MeteringEvent[] {
  const base = {
    agentId: options.agentId,
    userId: options.userId,
    turnId: options.turnId,
    model: options.model,
    source: 'gateway' as const,
    ...(options.holdId ? { holdId: options.holdId } : {}),
  };
  return [
    {
      ...base,
      dimension: 'llm_token_in',
      quantity: options.usage.promptTokens,
      unitCost: options.price.input,
    },
    {
      ...base,
      dimension: 'llm_token_out',
      quantity: options.usage.completionTokens,
      unitCost: options.price.output,
    },
  ];
}

interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  token: string,
  body: unknown,
  timeoutMs: number,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new BillingUnavailableError(`billing request failed: ${(error as Error).message}`);
  }
  return response;
}

export function createFetchBillingClient(options: {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}): BillingClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, '');

  return {
    async createHold(input) {
      const response = await postJson(
        fetchImpl,
        `${baseUrl}/billing/holds`,
        options.token,
        {
          user_id: input.userId,
          agent_id: input.agentId,
          turn_id: input.turnId,
          estimated_amount: input.estimatedAmount,
        },
        options.timeoutMs,
      );
      if (response.status === 402) {
        return { kind: 'rejected', status: 402, body: await response.json().catch(() => null) };
      }
      if (response.status === 200 || response.status === 201) {
        const body = (await response.json()) as { data?: { hold_id?: string } };
        const holdId = body.data?.hold_id;
        if (!holdId) throw new BillingUnavailableError('billing hold response missing hold_id');
        return { kind: 'held', holdId };
      }
      throw new BillingUnavailableError('billing hold returned an error', response.status);
    },

    async settle(input) {
      const response = await postJson(
        fetchImpl,
        `${baseUrl}/billing/settlements`,
        options.token,
        { hold_id: input.holdId, actual_amount: input.actualAmount },
        options.timeoutMs,
      );
      if (response.status !== 200) {
        throw new BillingUnavailableError('billing settle returned an error', response.status);
      }
    },

    async reportUsage(events) {
      for (const event of events) {
        const response = await postJson(
          fetchImpl,
          `${baseUrl}/metering/events`,
          options.token,
          {
            agent_id: event.agentId,
            user_id: event.userId,
            turn_id: event.turnId,
            hold_id: event.holdId,
            dimension: event.dimension,
            quantity: event.quantity,
            model: event.model,
            unit_cost: event.unitCost,
            source: event.source,
          },
          options.timeoutMs,
        );
        if (response.status !== 201) {
          throw new BillingUnavailableError('billing metering returned an error', response.status);
        }
      }
    },
  };
}
