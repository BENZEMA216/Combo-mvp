import { describe, expect, it } from 'vitest';
import { createResendMailer, type FetchLike } from '../resend.js';

const ENV = {
  RESEND_API_KEY: 're_test_key',
  RESEND_FROM_EMAIL: 'Combo <auth@buildwithcombo.com>',
  RESEND_API_BASE_URL: 'https://api.resend.com',
};

const MESSAGE = { challengeId: 'challenge-1', to: 'user@example.com', code: '123456' };

interface CapturedRequest {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(handler: (request: CapturedRequest) => Response | Promise<Response>): {
  fetchImpl: FetchLike;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key] = value;
    }
    const request: CapturedRequest = {
      url: String(input),
      method: init?.method,
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    };
    requests.push(request);
    return handler(request);
  };
  return { fetchImpl, requests };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createResendMailer', () => {
  it('posts the login code to the Resend emails endpoint with bearer auth and idempotency key', async () => {
    const { fetchImpl, requests } = stubFetch(() => jsonResponse(200, { id: 'email-1' }));
    const mailer = createResendMailer(ENV, fetchImpl);

    const result = await mailer.sendLoginCode(MESSAGE);
    expect(result).toBe('accepted');

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe('https://api.resend.com/emails');
    expect(request.method).toBe('POST');
    expect(request.headers.authorization).toBe(`Bearer ${ENV.RESEND_API_KEY}`);
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers['idempotency-key']).toBe('challenge-1');
    expect(request.body).toEqual({
      from: ENV.RESEND_FROM_EMAIL,
      to: ['user@example.com'],
      subject: 'Combo 登录验证码',
      text: '您的 Combo 登录验证码是 123456。验证码将在 5 分钟后失效。',
    });
  });

  it('treats 2xx as accepted', async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(200, { id: 'x' }));
    expect(await createResendMailer(ENV, fetchImpl).sendLoginCode(MESSAGE)).toBe('accepted');
  });

  it('maps recipient-side 422 provider errors to permanent_rejection', async () => {
    const cases = [
      { name: 'invalid_recipient', message: 'recipient is invalid' },
      { name: 'validation_error', message: 'The `to` field is invalid' },
    ];
    for (const error of cases) {
      const { fetchImpl } = stubFetch(() => jsonResponse(422, error));
      expect(await createResendMailer(ENV, fetchImpl).sendLoginCode(MESSAGE)).toBe(
        'permanent_rejection',
      );
    }
  });

  it('maps non-recipient 422 and 400 to configuration_failure', async () => {
    const cases = [
      jsonResponse(422, { name: 'validation_error', message: 'The `subject` field is invalid' }),
      jsonResponse(400, { name: 'invalid_api_key', message: 'API key is invalid' }),
    ];
    for (const response of cases) {
      const { fetchImpl } = stubFetch(() => response);
      expect(await createResendMailer(ENV, fetchImpl).sendLoginCode(MESSAGE)).toBe(
        'configuration_failure',
      );
    }
  });

  it('maps rate limiting and server errors to transient_failure', async () => {
    for (const status of [429, 500, 503]) {
      const { fetchImpl } = stubFetch(() => jsonResponse(status, {}));
      expect(await createResendMailer(ENV, fetchImpl).sendLoginCode(MESSAGE)).toBe(
        'transient_failure',
      );
    }
  });

  it('maps network exceptions to transient_failure without leaking them', async () => {
    const { fetchImpl } = stubFetch(() => {
      throw new Error('socket hangup');
    });
    expect(await createResendMailer(ENV, fetchImpl).sendLoginCode(MESSAGE)).toBe(
      'transient_failure',
    );
  });

  it('rejects a non-http base URL as configuration_failure without any request', async () => {
    const { fetchImpl, requests } = stubFetch(() => jsonResponse(200, {}));
    const mailer = createResendMailer(
      { ...ENV, RESEND_API_BASE_URL: 'ftp://example.com' },
      fetchImpl,
    );
    expect(await mailer.sendLoginCode(MESSAGE)).toBe('configuration_failure');
    expect(requests).toHaveLength(0);
  });
});
