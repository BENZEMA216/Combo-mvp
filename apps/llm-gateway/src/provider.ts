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

export function isProviderJsonSuccessPayload(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const first = choices[0];
  if (typeof first !== 'object' || first === null || Array.isArray(first)) return false;
  const message = (first as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return false;
  const candidate = message as { role?: unknown; content?: unknown };
  return candidate.role === 'assistant' && typeof candidate.content === 'string';
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
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        if (response.status >= 200 && response.status < 300) {
          throw new ProviderUnavailableError('provider returned malformed success JSON');
        }
        json = null;
      }
      if (response.status >= 200 && response.status < 300 && !isProviderJsonSuccessPayload(json)) {
        throw new ProviderUnavailableError('provider returned an invalid success payload');
      }
      return { status: response.status, json };
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
      const contentType = response.headers
        .get('content-type')
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase();
      if (contentType !== 'text/event-stream') {
        await response.body.cancel().catch(() => undefined);
        return { status: 502, stream: null, errorBody: 'provider stream invalid content type' };
      }
      return { status: response.status, stream: response.body };
    },
  };
}
