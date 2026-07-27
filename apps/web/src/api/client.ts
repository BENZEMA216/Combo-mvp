// Typed API client——消费 @cb/shared 的契约真源，全站 fetch 只走这一处。
//
// 两条硬规则在客户端层的落地：
//   1. 绝不裸露错误码：所有非 2xx → 白名单重建 ErrorEnvelope，UI 只读 userMessage + action（见 ApiError）。
//   2. 永不裸转圈：本层只负责取数与抛错；加载态/进度由组件层承担。
//
// 轻包络 { data, meta }（脊柱 §2）：成功默认解包 data；需要 meta（分页）时用 apiGetEnvelope。
import {
  API_PREFIX,
  CLIENT_FALLBACK_TRACE_ID,
  TRACE_ID_HEADER,
  TRACEPARENT_HEADER,
  type Envelope,
  type ErrorAction,
  type ErrorBody,
  type ErrorEnvelope,
  type Meta,
  sanitizeAuthReturnTo,
} from '@cb/shared';
import { clientTraceHeaders, reportClientEvent } from './telemetry.js';

/**
 * 统一前端错误：内部承载完整对外 ErrorEnvelope（不含 code）。
 * 渲染层只读 `userMessage` / `action` / `retriable`；`traceId` 仅作「反馈代码」展示（非错误码）。
 */
export class ApiError extends Error {
  readonly envelope: ErrorEnvelope;
  /** 只供请求控制流判断，不进入错误信封或用户文案。 */
  readonly httpStatus: number | null;

  constructor(envelope: ErrorEnvelope, httpStatus: number | null = null) {
    super(envelope.error.userMessage);
    this.name = 'ApiError';
    this.envelope = envelope;
    this.httpStatus = httpStatus;
    Object.defineProperty(this, 'httpStatus', { enumerable: false });
  }

  /** 唯一可对 UI 渲染的人话。 */
  get userMessage(): string {
    return this.envelope.error.userMessage;
  }

  /** 退路动作：retry | change_input | escalate | wait | none。 */
  get action(): ErrorBody['action'] {
    return this.envelope.error.action;
  }

  get retriable(): boolean {
    return this.envelope.error.retriable;
  }

  /** 关联日志用；可作「反馈代码」展示——但它不是错误码，永不当主文案。 */
  get traceId(): string {
    return this.envelope.error.traceId;
  }
}

let unauthorizedRedirectStarted = false;

/** 单一可替换的浏览器导航边界，单元测试只替换这个方法，不模拟会话刷新。 */
export const unauthorizedNavigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

/** 当前页面生命周期内只处理第一次业务 401；新登录完成后的整页加载会自然重置该门闩。 */
export function redirectAfterUnauthorized(): boolean {
  if (unauthorizedRedirectStarted || typeof window === 'undefined') return false;
  unauthorizedRedirectStarted = true;
  const returnTo = sanitizeAuthReturnTo(window.location.pathname + window.location.search);
  unauthorizedNavigation.assign(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  return true;
}

/** 只供隔离单元测试重置模块级页面生命周期。 */
export function resetUnauthorizedRedirectForTest(): void {
  unauthorizedRedirectStarted = false;
}

const VALID_ACTIONS: ReadonlySet<string> = new Set<ErrorAction>([
  'retry',
  'change_input',
  'escalate',
  'wait',
  'none',
]);

/** 兜底人话错误体（网络断 / 后端未按契约返回时仍给人话 + 退路）。 */
export function fallbackErrorBody(userMessage: string): ErrorBody {
  return {
    userMessage,
    retriable: true,
    action: 'retry',
    traceId: CLIENT_FALLBACK_TRACE_ID,
  };
}

/**
 * 从任意可疑输入白名单重建 ErrorBody：只摘 userMessage/retriable/action/traceId/failureId?/details?，
 * code/status/stack/原始 message 一律不进结果。不像 ErrorBody 的输入 → 兜底人话（绝不裸露错误码）。
 * HTTP 非 2xx body、SSE error 帧、done.error 三处共用。
 */
export function sanitizeErrorBody(input: unknown): ErrorBody {
  if (typeof input !== 'object' || input === null) {
    return fallbackErrorBody('服务开小差了，请稍后重试。');
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.userMessage !== 'string' || raw.userMessage.length === 0) {
    return fallbackErrorBody('服务开小差了，请稍后重试。');
  }
  const action =
    typeof raw.action === 'string' && VALID_ACTIONS.has(raw.action)
      ? (raw.action as ErrorAction)
      : 'retry';
  return {
    userMessage: raw.userMessage,
    retriable: typeof raw.retriable === 'boolean' ? raw.retriable : action === 'retry',
    action,
    traceId: typeof raw.traceId === 'string' ? raw.traceId : CLIENT_FALLBACK_TRACE_ID,
    ...(typeof raw.failureId === 'string' ? { failureId: raw.failureId } : {}),
    ...(typeof raw.details === 'object' && raw.details !== null
      ? { details: raw.details as Record<string, unknown> }
      : {}),
  };
}

/** 解包完整对外 ErrorEnvelope（`{ error: {...} }`）；容错裸 ErrorBody；都不像则兜底人话。 */
export function unwrapErrorBody(payload: unknown): ErrorBody {
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    return sanitizeErrorBody((payload as { error: unknown }).error);
  }
  return sanitizeErrorBody(payload);
}

export interface RequestOptions {
  /** 查询参数（自动 URL 编码，undefined 值跳过）。 */
  query?: Record<string, string | number | undefined>;
  /** AbortSignal（组件卸载/取消请求）。 */
  signal?: AbortSignal;
}

interface RawRequestOptions extends RequestOptions {
  method: 'GET' | 'POST';
  body?: unknown;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const base = `${API_PREFIX}${path}`;
  if (!query) return base;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/** 底层请求：解包 { data, meta }；非 2xx 统一抛 ApiError（永远带人话 + 退路）。 */
async function request<T>(path: string, opts: RawRequestOptions): Promise<Envelope<T>> {
  const trace = clientTraceHeaders();
  const headers: Record<string, string> = {
    [TRACE_ID_HEADER]: trace.traceId,
    [TRACEPARENT_HEADER]: trace.headers[TRACEPARENT_HEADER]!,
  };
  const hasBody = opts.body !== undefined;
  if (hasBody) headers['Content-Type'] = 'application/json';

  const url = buildUrl(path, opts.query);
  const fetchOnce = async (): Promise<Response> => {
    try {
      return await fetch(url, {
        method: opts.method,
        credentials: 'include',
        headers,
        ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (cause) {
      // 网络层失败：abort 透传给调用方（react-query 不当错误处理），其余包成人话信封。
      if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
      reportClientEvent('api_error', {
        traceId: trace.traceId,
        message: cause instanceof Error ? cause.message : 'network error',
        url,
      });
      throw new ApiError({ error: fallbackErrorBody('网络好像不太稳，检查连接后重试。') });
    }
  };

  const res = await fetchOnce();
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    if (!res.ok) {
      reportClientEvent('api_error', {
        traceId: trace.traceId,
        message: 'non-json error response',
        url,
      });
      if (res.status === 401) redirectAfterUnauthorized();
      throw new ApiError(
        { error: fallbackErrorBody('服务暂时没有正确响应，请稍后重试。') },
        res.status,
      );
    }
    return { data: undefined as T };
  }

  if (!res.ok) {
    // 白名单重建：只摘安全字段，code/状态码/堆栈绝不进 envelope；缺人话则兜底人话。
    const error = unwrapErrorBody(body);
    reportClientEvent('api_error', { traceId: error.traceId, message: error.userMessage, url });
    if (res.status === 401) redirectAfterUnauthorized();
    throw new ApiError({ error }, res.status);
  }

  return body as Envelope<T>;
}

export async function apiGet<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  return (await request<T>(path, { ...opts, method: 'GET' })).data;
}

/** 需要 meta（分页）时用这个版本。 */
export async function apiGetEnvelope<T>(
  path: string,
  opts: RequestOptions = {},
): Promise<{ data: T; meta?: Meta }> {
  return request<T>(path, { ...opts, method: 'GET' });
}

export async function apiPost<T>(
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  const raw: RawRequestOptions = { ...opts, method: 'POST' };
  if (body !== undefined) raw.body = body;
  return (await request<T>(path, raw)).data;
}
