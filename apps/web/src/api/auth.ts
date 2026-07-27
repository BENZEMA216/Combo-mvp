import {
  API_PREFIX,
  EmailChallengeResponseSchema,
  EmailVerificationResponseSchema,
  ErrorEnvelopeSchema,
  MeResponseSchema,
  type EmailChallengeBody,
  type EmailChallengeResult,
  type EmailVerificationBody,
  type EmailVerificationResult,
  type MeView,
} from '@cb/shared';

export const EMAIL_CHALLENGE_PATH = `${API_PREFIX}/auth/email/challenges`;
export const EMAIL_VERIFICATION_PATH = `${API_PREFIX}/auth/email/verifications`;
export const AUTH_ME_PATH = `${API_PREFIX}/me`;
export const AUTH_REQUEST_TIMEOUT_MS = 10_000;

type AuthRequestFailureKind = 'http' | 'network' | 'protocol';

/**
 * 认证表单使用的低敏错误。状态码只参与页面状态机，不渲染；响应正文只保留安全错误信封中的人话。
 */
export class AuthRequestError extends Error {
  constructor(
    public readonly kind: AuthRequestFailureKind,
    public readonly status: number | null,
    userMessage: string,
    public readonly retryAfterSeconds?: number,
    /** 请求可能已被服务端提交，验证码验证遇到该状态时必须先查询 /me。 */
    public readonly outcomeUncertain = false,
  ) {
    super(userMessage);
    this.name = 'AuthRequestError';
  }
}

export type AuthSessionProbe =
  | { status: 'authed'; me: MeView }
  | { status: 'anon' }
  | { status: 'disabled'; error: AuthRequestError }
  | { status: 'error'; error: AuthRequestError };

function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function fallbackMessage(status: number): string {
  if (status === 400) return '输入有点问题，请检查后再试。';
  if (status === 401) return '验证码无效或已过期，请重新获取。';
  if (status === 403) return '当前请求无法完成，请联系支持。';
  if (status === 429) return '操作太频繁了，请稍后再试。';
  if (status === 503) return '登录服务暂时不可用，请稍后重试。';
  return '登录请求暂时没有完成，请稍后重试。';
}

async function errorFromResponse(
  response: Response,
  outcomeUncertain = false,
): Promise<AuthRequestError> {
  let userMessage = fallbackMessage(response.status);
  try {
    const parsed = ErrorEnvelopeSchema.safeParse((await response.json()) as unknown);
    if (parsed.success) userMessage = parsed.data.error.userMessage;
  } catch {
    // 非 JSON 错误体只使用固定人话，不把代理或供应商正文带到页面。
  }
  return new AuthRequestError(
    'http',
    response.status,
    userMessage,
    retryAfterSeconds(response),
    outcomeUncertain,
  );
}

interface AuthFetchOptions {
  method: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
  outcomeUncertain?: boolean;
}

async function authFetch(path: string, options: AuthFetchOptions): Promise<Response> {
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort();
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), AUTH_REQUEST_TIMEOUT_MS);

  try {
    return await fetch(path, {
      method: options.method,
      credentials: 'include',
      headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
  } catch {
    if (options.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    throw new AuthRequestError(
      'network',
      null,
      '网络好像不太稳，请检查连接后重试。',
      undefined,
      options.outcomeUncertain ?? false,
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export async function requestEmailChallenge(
  body: EmailChallengeBody,
): Promise<EmailChallengeResult> {
  const response = await authFetch(EMAIL_CHALLENGE_PATH, { method: 'POST', body });
  if (!response.ok) throw await errorFromResponse(response);

  try {
    return EmailChallengeResponseSchema.parse((await response.json()) as unknown).data;
  } catch {
    throw new AuthRequestError(
      'protocol',
      response.status,
      '登录服务暂时没有正确响应，请稍后重试。',
    );
  }
}

export async function verifyEmail(body: EmailVerificationBody): Promise<EmailVerificationResult> {
  const response = await authFetch(EMAIL_VERIFICATION_PATH, {
    method: 'POST',
    body,
    outcomeUncertain: true,
  });
  if (!response.ok) {
    // 代理或上游 5xx 可能发生在一次性验证码已经提交之后，必须先探测会话而不是重放。
    throw await errorFromResponse(response, response.status >= 500 && response.status <= 599);
  }

  try {
    return EmailVerificationResponseSchema.parse((await response.json()) as unknown).data;
  } catch {
    // 2xx 后解析失败时 Cookie 仍可能已经写入，调用方必须先查询一次 /me。
    throw new AuthRequestError(
      'protocol',
      response.status,
      '正在确认登录是否已经完成。',
      undefined,
      true,
    );
  }
}

/** 只用 HttpOnly Cookie 查询当前用户；401 是匿名，其他失败保持可重试错误。 */
export async function probeAuthSession(signal?: AbortSignal): Promise<AuthSessionProbe> {
  let response: Response;
  try {
    response = await authFetch(AUTH_ME_PATH, { method: 'GET', signal });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    return {
      status: 'error',
      error:
        cause instanceof AuthRequestError
          ? cause
          : new AuthRequestError('network', null, '网络好像不太稳，请检查连接后重试。'),
    };
  }

  if (response.status === 401) return { status: 'anon' };
  if (response.status === 403) {
    return { status: 'disabled', error: await errorFromResponse(response) };
  }
  if (!response.ok) return { status: 'error', error: await errorFromResponse(response) };

  try {
    const parsed = MeResponseSchema.parse((await response.json()) as unknown);
    return { status: 'authed', me: parsed.data };
  } catch {
    return {
      status: 'error',
      error: new AuthRequestError(
        'protocol',
        response.status,
        '登录服务暂时没有正确响应，请稍后重试。',
      ),
    };
  }
}
