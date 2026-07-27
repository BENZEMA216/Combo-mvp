// 类型化 fetch 封装（API 面唯一入口）。同源 Cookie（cb_session，与创作端共享）鉴权。
//   成功响应统一轻包络 { data, meta } → 此处解包直接返回 data；
//   失败响应统一 ErrorEnvelope → 只读 userMessage（绝不暴露内部 code/状态码给用户）。
import { goToLogin } from '../navigation/login.js';
import { clientTraceHeaders, reportClientEvent } from './telemetry.js';

const API_PREFIX = '/api/v1';

export class ApiError extends Error {
  constructor(
    public readonly userMessage: string,
    public readonly status: number,
    public readonly traceId?: string,
  ) {
    super(userMessage);
    this.name = 'ApiError';
  }
}

/** 401 = 登录态失效：调用方据此跳创作端登录。 */
export function isUnauthenticated(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

function buildUrl(path: string): string {
  if (path.startsWith('/api/')) return path;
  return `${API_PREFIX}${path}`;
}

/** 发请求 + 错误收口：非 2xx 解 ErrorEnvelope 后抛 ApiError；网络失败也归一成 ApiError。 */
async function doFetch(method: string, path: string, body?: unknown): Promise<Response> {
  const trace = clientTraceHeaders();
  const url = buildUrl(path);
  const fetchOnce = async (): Promise<Response> => {
    try {
      return await fetch(url, {
        method,
        credentials: 'include',
        headers:
          body === undefined
            ? trace.headers
            : { 'content-type': 'application/json', ...trace.headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      reportClientEvent('api_error', {
        traceId: trace.traceId,
        message: cause instanceof Error ? cause.message : 'network error',
        stack: cause instanceof Error ? cause.stack : undefined,
        url,
      });
      throw new ApiError('网络好像不太稳，检查连接后重试。', 0, trace.traceId);
    }
  };

  const res = await fetchOnce();
  if (!res.ok) {
    let userMessage = res.status === 401 ? '请先登录。' : '请求失败，请稍后重试。';
    let traceId: string | undefined;
    try {
      const env = (await res.json()) as { error?: { userMessage?: string; traceId?: string } };
      if (env.error?.userMessage) userMessage = env.error.userMessage;
      traceId = env.error?.traceId;
    } catch {
      /* 非 JSON 错误体：用兜底文案 */
    }
    reportClientEvent('api_error', {
      traceId: traceId ?? trace.traceId,
      message: userMessage,
      url,
    });
    if (res.status === 401 && method !== 'GET') {
      // 导航后仍抛错让当前调用链终止；绝不自动重放已经失败的写请求。
      goToLogin();
    }
    throw new ApiError(userMessage, res.status, traceId);
  }
  return res;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await doFetch(method, path, body);
  if (res.status === 204) return undefined as T;
  // 全部业务端点都是 { data, meta } 轻包络：解包只回 data。
  return ((await res.json()) as { data: T }).data;
}

export const apiGet = <T>(path: string): Promise<T> => request<T>('GET', path);
export const apiPost = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>('POST', path, body);
export const apiPatch = <T>(path: string, body: unknown): Promise<T> =>
  request<T>('PATCH', path, body);
export const apiDelete = <T>(path: string): Promise<T> => request<T>('DELETE', path);

/** 非包络的原文回读（产物内容端点：带 Content-Type 的裸文本）。 */
export const apiGetText = async (path: string): Promise<string> =>
  (await doFetch('GET', path)).text();
