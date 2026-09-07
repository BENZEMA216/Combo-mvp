// billing 服务客户端：hold / settle / usage 推账。端口 + fetch 实现分离，
// 测试注入内存假客户端，不依赖真实 billing 进程。
import { createHash } from 'node:crypto';
import type { TokenUsage } from './pricing.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CreateHoldResult =
  | { kind: 'held'; holdId: string; replayed: boolean }
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

/** 可信 billing 返回畸形成功响应时必须 fail-closed，不能按网络故障放行 provider。 */
export class BillingProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingProtocolError';
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
  idempotencyKey: string;
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
  const events: MeteringEvent[] = [
    {
      ...base,
      dimension: 'llm_token_in',
      quantity: options.usage.promptTokens,
      unitCost: options.price.input,
      idempotencyKey: meteringIdempotencyKey({
        ...base,
        dimension: 'llm_token_in',
      }),
    },
    {
      ...base,
      dimension: 'llm_token_out',
      quantity: options.usage.completionTokens,
      unitCost: options.price.output,
      idempotencyKey: meteringIdempotencyKey({
        ...base,
        dimension: 'llm_token_out',
      }),
    },
  ];
  return events.filter((event) => event.quantity > 0);
}

export function meteringIdempotencyKey(input: {
  source: 'gateway';
  holdId?: string;
  userId: string;
  agentId: string;
  turnId: string;
  dimension: 'llm_token_in' | 'llm_token_out';
}): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        input.source,
        input.holdId ?? null,
        input.userId,
        input.agentId,
        input.turnId,
        input.dimension,
      ]),
    )
    .digest('hex');
  return `meter:v1:${digest}`;
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
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new BillingUnavailableError('billing request failed');
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
      if (response.status >= 400 && response.status < 500) {
        return {
          kind: 'rejected',
          status: response.status,
          body: await response.json().catch(() => null),
        };
      }
      if (response.status === 200 || response.status === 201) {
        let decoded: unknown;
        try {
          decoded = await response.json();
        } catch {
          throw new BillingProtocolError('billing hold returned malformed JSON');
        }
        if (typeof decoded !== 'object' || decoded === null) {
          throw new BillingProtocolError('billing hold returned an invalid success response');
        }
        const data = (decoded as { data?: unknown }).data;
        if (typeof data !== 'object' || data === null) {
          throw new BillingProtocolError('billing hold returned an invalid success response');
        }
        const success = data as { hold_id?: unknown; status?: unknown; replayed?: unknown };
        const holdId = success.hold_id;
        const replayed = success.replayed;
        if (
          typeof holdId !== 'string' ||
          !UUID_PATTERN.test(holdId) ||
          success.status !== 'held' ||
          typeof replayed !== 'boolean' ||
          (response.status === 201 && replayed) ||
          (response.status === 200 && !replayed)
        ) {
          throw new BillingProtocolError('billing hold returned an invalid success response');
        }
        return { kind: 'held', holdId, replayed };
      }
      if (response.status >= 500) {
        throw new BillingUnavailableError('billing hold returned an error', response.status);
      }
      throw new BillingProtocolError(`billing hold returned unexpected status ${response.status}`);
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
            idempotency_key: event.idempotencyKey,
          },
          options.timeoutMs,
        );
        if (response.status !== 200 && response.status !== 201) {
          throw new BillingUnavailableError('billing metering returned an error', response.status);
        }
      }
    },
  };
}
