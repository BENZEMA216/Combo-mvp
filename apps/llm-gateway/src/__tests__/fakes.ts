// 内存版 BillingClient / ProviderClient：记录调用参数、可控失败，
// 供不依赖 billing 进程与 provider 的单元与路由测试注入。
import {
  BillingProtocolError,
  BillingUnavailableError,
  type BillingClient,
  type CreateHoldResult,
  type MeteringEvent,
} from '../billing.js';
import type { ProviderClient, ProviderJsonResponse, ProviderStreamResponse } from '../provider.js';

export function createFakeBillingClient() {
  const state = {
    holds: [] as Array<{
      userId: string;
      agentId: string;
      turnId: string;
      estimatedAmount: number;
    }>,
    settlements: [] as Array<{ holdId: string; actualAmount: number }>,
    usageReports: [] as MeteringEvent[][],
    /** 设定后 createHold 返回 402 拒绝。 */
    rejectNextHold: null as { status: number; body: unknown } | null,
    /** 设定后 createHold 抛 BillingUnavailableError（超时 / 5xx 等价物）。 */
    failNextHold: false,
    protocolErrorNextHold: false,
    replayNextHold: false,
    failNextSettle: false,
    failNextUsageReport: false,
    nextHoldId: 0,
  };

  const client: BillingClient = {
    async createHold(input): Promise<CreateHoldResult> {
      if (state.failNextHold) {
        state.failNextHold = false;
        throw new BillingUnavailableError('billing timeout', 503);
      }
      if (state.protocolErrorNextHold) {
        state.protocolErrorNextHold = false;
        throw new BillingProtocolError('invalid hold response');
      }
      if (state.rejectNextHold) {
        const rejection = state.rejectNextHold;
        state.rejectNextHold = null;
        return { kind: 'rejected', status: rejection.status, body: rejection.body };
      }
      state.holds.push(input);
      state.nextHoldId += 1;
      const replayed = state.replayNextHold;
      state.replayNextHold = false;
      return { kind: 'held', holdId: `hold-${state.nextHoldId}`, replayed };
    },
    async settle(input) {
      if (state.failNextSettle) {
        state.failNextSettle = false;
        throw new BillingUnavailableError('settle failed', 500);
      }
      state.settlements.push(input);
    },
    async reportUsage(events) {
      if (state.failNextUsageReport) {
        state.failNextUsageReport = false;
        throw new BillingUnavailableError('usage report failed', 500);
      }
      state.usageReports.push(events);
    },
  };
  return { client, state };
}

export function sseStreamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

export function createFakeProviderClient() {
  const state = {
    requests: [] as unknown[],
    /** 非流式响应。 */
    jsonResponse: { status: 200, json: null as unknown } as ProviderJsonResponse,
    /** 流式响应。 */
    streamResponse: null as ProviderStreamResponse | null,
    failNextStream: false,
  };

  const client: ProviderClient = {
    async chatCompletion(body) {
      state.requests.push(body);
      return state.jsonResponse;
    },
    async chatCompletionStream(body) {
      state.requests.push(body);
      if (state.failNextStream) {
        state.failNextStream = false;
        throw new Error('provider connect reset');
      }
      return (
        state.streamResponse ?? {
          status: 200,
          stream: sseStreamFromChunks(['data: [DONE]\n\n']),
        }
      );
    },
  };
  return { client, state };
}

export function createRecordingLog() {
  const records = {
    warnings: [] as Array<Record<string, unknown>>,
    errors: [] as Array<Record<string, unknown>>,
  };
  return {
    records,
    log: {
      warn(fields: Record<string, unknown>, _message: string) {
        records.warnings.push(fields);
      },
      error(fields: Record<string, unknown>, _message: string) {
        records.errors.push(fields);
      },
    },
  };
}
