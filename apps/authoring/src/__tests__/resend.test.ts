import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRODUCTION_RESEND_FROM_EMAIL, type Env } from '../platform/config/env.js';
import { createResendEmailSender } from '../platform/infra/resend.js';

const env = {
  RESEND_API_KEY: 'test-key-not-a-production-secret',
  RESEND_FROM_EMAIL: PRODUCTION_RESEND_FROM_EMAIL,
  RESEND_API_BASE_URL: 'http://127.0.0.1:45678',
} as Env;

const message = {
  challengeId: '01900000-0000-7000-8000-000000000001',
  to: 'Alice@example.com' as const,
  code: '042731',
};

afterEach(() => vi.useRealTimers());

describe('Resend HTTP adapter', () => {
  it('uses the HTTP contract, idempotency key and built-in JSON body without an SDK', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const sender = createResendEmailSender(env, fetchMock);

    await expect(sender.sendLoginCode(message)).resolves.toBe('accepted');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('http://127.0.0.1:45678/emails');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.headers).toEqual({
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
      'idempotency-key': message.challengeId,
    });
    expect(JSON.parse(String(init.body))).toEqual({
      from: 'Combo <auth@buildwithcombo.com>',
      to: ['Alice@example.com'],
      subject: 'Combo 登录验证码',
      text: expect.stringContaining('042731'),
    });
  });

  it.each([
    [200, 'accepted'],
    [299, 'accepted'],
    [408, 'transient_failure'],
    [425, 'transient_failure'],
    [429, 'transient_failure'],
    [500, 'transient_failure'],
    [503, 'transient_failure'],
    [301, 'configuration_failure'],
    [401, 'configuration_failure'],
    [403, 'configuration_failure'],
    [404, 'configuration_failure'],
    [409, 'configuration_failure'],
    [418, 'configuration_failure'],
  ] as const)('maps Resend HTTP %s to %s without retaining a body', async (status, expected) => {
    let bodyRead = false;
    const response = {
      status,
      body: { cancel: vi.fn().mockResolvedValue(undefined) },
      json: () => {
        bodyRead = true;
        throw new Error('must not parse provider body');
      },
      text: () => {
        bodyRead = true;
        throw new Error('must not parse provider body');
      },
    } as unknown as Response;
    const sender = createResendEmailSender(env, vi.fn().mockResolvedValue(response));

    await expect(sender.sendLoginCode(message)).resolves.toBe(expected);
    expect(bodyRead).toBe(false);
  });

  it.each([
    [
      400,
      { name: 'validation_error', message: 'The `from` field must be a valid email address.' },
      'configuration_failure',
    ],
    [
      422,
      { name: 'invalid_from_address', message: 'The sender domain is not configured.' },
      'configuration_failure',
    ],
    [
      422,
      { name: 'validation_error', message: 'The `to` field must be a valid recipient.' },
      'permanent_rejection',
    ],
  ] as const)(
    'uses only an allowlisted Resend error shape for HTTP %s and maps it to %s',
    async (status, providerBody, expected) => {
      const response = new Response(JSON.stringify(providerBody), {
        status,
        headers: { 'content-type': 'application/json' },
      });
      const sender = createResendEmailSender(env, vi.fn().mockResolvedValue(response));

      await expect(sender.sendLoginCode(message)).resolves.toBe(expected);
    },
  );

  it('treats an unknown 422 body as configuration failure instead of hiding it as accepted', async () => {
    const sender = createResendEmailSender(
      env,
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'sender-or-request-misconfigured' }), {
          status: 422,
        }),
      ),
    );
    await expect(sender.sendLoginCode(message)).resolves.toBe('configuration_failure');
  });

  it('returns a configuration failure without a network call when credentials are absent', async () => {
    const fetchMock = vi.fn();
    const sender = createResendEmailSender(
      { ...env, RESEND_API_KEY: '', RESEND_FROM_EMAIL: '' },
      fetchMock,
    );
    await expect(sender.sendLoginCode(message)).resolves.toBe('configuration_failure');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts once at five seconds and does not retry transparently', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    });
    const sender = createResendEmailSender(env, fetchMock);

    const pending = sender.sendLoginCode(message);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe('transient_failure');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps network rejection to a transient failure without exposing the raw exception', async () => {
    const sender = createResendEmailSender(
      env,
      vi.fn().mockRejectedValue(new Error('socket included sensitive request internals')),
    );
    await expect(sender.sendLoginCode(message)).resolves.toBe('transient_failure');
  });
});
