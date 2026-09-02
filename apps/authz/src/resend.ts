// Resend HTTP 适配器：与 V1（apps/authoring/src/platform/infra/resend.ts）同一纪律——
// 只对白名单内的收件人错误读取有界错误摘要，不透明重试，也不把收件人、验证码、
// 密钥、供应商正文或原始异常交给日志与响应。
export const RESEND_REQUEST_TIMEOUT_MS = 5_000;
const MAX_PROVIDER_ERROR_BYTES = 4 * 1024;
const PERMANENT_RECIPIENT_ERROR_NAMES = new Set([
  'invalid_recipient',
  'invalid_to_address',
  'recipient_suppressed',
]);

export type OtpDeliveryResult =
  | 'accepted'
  | 'permanent_rejection'
  | 'transient_failure'
  | 'configuration_failure';

export interface LoginCodeMessage {
  /** 同时充当 Resend 幂等键，重试同一挑战不会产生第二封邮件。 */
  challengeId: string;
  to: string;
  code: string;
}

/** 发信端口：service 只感知投递结果分类，不感知供应商细节。 */
export interface OtpMailer {
  sendLoginCode(message: LoginCodeMessage): Promise<OtpDeliveryResult>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ResendEnv {
  RESEND_API_KEY: string;
  RESEND_FROM_EMAIL: string;
  RESEND_API_BASE_URL: string;
}

function emailsEndpoint(baseUrl: string): URL | null {
  try {
    const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const base = new URL(normalized);
    if (base.protocol !== 'https:' && base.protocol !== 'http:') return null;
    return new URL('emails', base);
  } catch {
    return null;
  }
}

interface ProviderErrorSummary {
  name: string;
  message: string;
}

async function readProviderErrorSummary(response: Response): Promise<ProviderErrorSummary | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;

  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_PROVIDER_ERROR_BYTES) return null;
      chunks.push(next.value);
    }
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const raw = parsed as Record<string, unknown>;
    if (
      typeof raw.name !== 'string' ||
      raw.name.length > 80 ||
      typeof raw.message !== 'string' ||
      raw.message.length > 1_000
    ) {
      return null;
    }
    return { name: raw.name, message: raw.message };
  } catch {
    return null;
  }
}

function isPermanentRecipientError(error: ProviderErrorSummary | null): boolean {
  if (!error) return false;
  if (PERMANENT_RECIPIENT_ERROR_NAMES.has(error.name)) return true;
  if (error.name !== 'validation_error' && error.name !== 'invalid_parameter') return false;
  return /(?:^|[\s`'"])(?:to|recipient)(?:[\s`'":]|$)/iu.test(error.message);
}

async function classifyResponse(response: Response): Promise<OtpDeliveryResult> {
  const { status } = response;
  if (status >= 200 && status < 300) {
    await response.body?.cancel().catch(() => undefined);
    return 'accepted';
  }
  if (status === 400) {
    await response.body?.cancel().catch(() => undefined);
    return 'configuration_failure';
  }
  if (status === 422) {
    const providerError = await readProviderErrorSummary(response);
    return isPermanentRecipientError(providerError)
      ? 'permanent_rejection'
      : 'configuration_failure';
  }
  await response.body?.cancel().catch(() => undefined);
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return 'transient_failure';
  }
  return 'configuration_failure';
}

/** 在全局 fetch 上的 Resend 发信实现；测试注入 fetch 桩断言请求形态与错误映射。 */
export function createResendMailer(
  env: ResendEnv,
  fetchImpl: FetchLike = globalThis.fetch,
  timeoutMs = RESEND_REQUEST_TIMEOUT_MS,
): OtpMailer {
  return {
    async sendLoginCode(message): Promise<OtpDeliveryResult> {
      const endpoint = emailsEndpoint(env.RESEND_API_BASE_URL);
      if (!endpoint) return 'configuration_failure';

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${env.RESEND_API_KEY}`,
            'content-type': 'application/json',
            'idempotency-key': message.challengeId,
          },
          body: JSON.stringify({
            from: env.RESEND_FROM_EMAIL,
            to: [message.to],
            subject: 'Combo 登录验证码',
            text: `您的 Combo 登录验证码是 ${message.code}。验证码将在 5 分钟后失效。`,
          }),
        });

        return await classifyResponse(response);
      } catch {
        return 'transient_failure';
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
