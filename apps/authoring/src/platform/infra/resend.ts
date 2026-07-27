import type { NormalizedEmailAddress } from '@cb/shared';
import type { Env } from '../config/env.js';

export const RESEND_REQUEST_TIMEOUT_MS = 5_000;
const MAX_PROVIDER_ERROR_BYTES = 4 * 1024;
const PERMANENT_RECIPIENT_ERROR_NAMES = new Set([
  'invalid_recipient',
  'invalid_to_address',
  'recipient_suppressed',
]);

export type ResendDeliveryResult =
  | 'accepted'
  | 'permanent_rejection'
  | 'transient_failure'
  | 'configuration_failure';

export interface LoginCodeEmail {
  challengeId: string;
  to: NormalizedEmailAddress;
  code: string;
}

export interface ResendEmailPort {
  sendLoginCode(message: LoginCodeEmail): Promise<ResendDeliveryResult>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type ResendEnv = Pick<Env, 'RESEND_API_KEY' | 'RESEND_FROM_EMAIL' | 'RESEND_API_BASE_URL'>;

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

async function classifyResponse(response: Response): Promise<ResendDeliveryResult> {
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

/**
 * Resend HTTP 适配器。它只对白名单内的收件人错误读取有界错误摘要，不透明重试，也不把
 * 收件人、验证码、密钥、供应商正文或原始异常交给日志与响应。
 */
export function createResendEmailSender(
  env: ResendEnv,
  fetchImpl: FetchLike = globalThis.fetch,
  timeoutMs = RESEND_REQUEST_TIMEOUT_MS,
): ResendEmailPort {
  return {
    async sendLoginCode(message): Promise<ResendDeliveryResult> {
      if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) return 'configuration_failure';
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
