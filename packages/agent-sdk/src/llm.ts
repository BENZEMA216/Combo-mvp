// llm client：指向平台模型网关的 OpenAI 兼容子集封装。自动注入 x_combo 平台扩展
// （user_id / agent_id / turn_id），turn_id 可传可自动生成；流式返回原始字节流，
// 可直接交给 Next.js 路由处理器透传。

export class LlmGatewayError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `llm gateway returned ${status}`);
    this.name = 'LlmGatewayError';
  }
}

export interface ChatMessage {
  role: string;
  content: unknown;
}

export interface ChatCompletionInput {
  /** 来自验签后的断言。 */
  userId: string;
  messages: ChatMessage[];
  model?: string;
  stream?: boolean;
  maxTokens?: number;
  /** 缺省自动生成；一次对话的一轮调用应复用同一 turn_id 以对齐计量。 */
  turnId?: string;
  /** 其余 OpenAI 兼容字段（temperature 等）原样透传。 */
  [extra: string]: unknown;
}

export interface LlmClient {
  /** 非流式：返回 provider 的完整 JSON。非 2xx 抛 LlmGatewayError（402 带钱包信息）。 */
  chatCompletion(input: ChatCompletionInput): Promise<unknown>;
  /** 流式：返回 provider SSE 原始字节流，Next.js 可直接 new Response(stream) 透传。 */
  chatCompletionStream(input: ChatCompletionInput): Promise<ReadableStream<Uint8Array>>;
}

interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

export interface LlmClientOptions {
  gatewayUrl: string;
  internalToken: string;
  agentId: string;
  fetchImpl?: FetchLike;
  /** 缺省模型，请求未指定时使用。 */
  defaultModel?: string;
  randomId?: () => string;
}

function buildGatewayBody(
  input: ChatCompletionInput,
  options: LlmClientOptions,
): Record<string, unknown> {
  const { userId, turnId, maxTokens, stream, messages, model, ...rest } = input;
  const body: Record<string, unknown> = {
    ...rest,
    model: model ?? options.defaultModel,
    messages,
    x_combo: {
      user_id: userId,
      agent_id: options.agentId,
      turn_id: turnId ?? (options.randomId ?? (() => globalThis.crypto.randomUUID()))(),
    },
  };
  if (!body.model) throw new LlmGatewayError(0, null, 'model is required (no default configured)');
  if (stream !== undefined) body.stream = stream;
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  return body;
}

export function createLlmClient(options: LlmClientOptions): LlmClient {
  // 缺省走调用时的全局 fetch（惰性查找），长生命周期进程里测试桩与运行时装配都生效。
  const fetchImpl =
    options.fetchImpl ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const url = `${options.gatewayUrl}/v1/chat/completions`;

  async function post(body: Record<string, unknown>, acceptStream: boolean): Promise<Response> {
    return fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.internalToken}`,
        ...(acceptStream ? { accept: 'text/event-stream' } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  return {
    async chatCompletion(input) {
      const response = await post(buildGatewayBody(input, options), false);
      const json = await response.json().catch(() => null);
      if (response.status < 200 || response.status >= 300) {
        throw new LlmGatewayError(response.status, json);
      }
      return json;
    },

    async chatCompletionStream(input) {
      const response = await post({ ...buildGatewayBody(input, options), stream: true }, true);
      if (response.status < 200 || response.status >= 300 || !response.body) {
        const body = await response.text().catch(() => '');
        throw new LlmGatewayError(response.status, body || null);
      }
      return response.body;
    },
  };
}
