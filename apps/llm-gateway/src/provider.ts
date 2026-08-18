// provider 客户端：OpenAI 兼容端点的非流式与流式调用。流式返回原始字节流，
// 网关逐 chunk 透传、不整段 buffer（spec 十六：流式透传无明显 buffer 延迟）。

export interface ProviderStreamResponse {
  status: number;
  /** 成功（2xx）时是 provider SSE 原始字节流；失败时为 null，读 errorBody。 */
  stream: ReadableStream<Uint8Array> | null;
  errorBody?: string;
}

export interface ProviderJsonResponse {
  status: number;
  json: unknown;
}

export interface ProviderClient {
  chatCompletion(body: unknown): Promise<ProviderJsonResponse>;
  chatCompletionStream(body: unknown): Promise<ProviderStreamResponse>;
}

export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

export function createFetchProviderClient(options: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchLike;
}): ProviderClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const url = `${options.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;

  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${options.apiKey}`,
  };

  return {
    async chatCompletion(body) {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      return { status: response.status, json: await response.json().catch(() => null) };
    },

    async chatCompletionStream(body) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { ...headers, accept: 'text/event-stream' },
          body: JSON.stringify(body),
        });
      } catch (error) {
        throw new ProviderUnavailableError((error as Error).message);
      }
      if (response.status < 200 || response.status >= 300) {
        return {
          status: response.status,
          stream: null,
          errorBody: await response.text().catch(() => ''),
        };
      }
      if (!response.body) {
        return { status: 502, stream: null, errorBody: 'provider stream missing body' };
      }
      return { status: response.status, stream: response.body };
    },
  };
}
