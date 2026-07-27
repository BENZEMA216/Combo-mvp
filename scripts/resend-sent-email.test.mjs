/* global Response */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptanceEmailAddress,
  takeAcceptanceResendApiKey,
  validateAcceptanceResendApiKey,
  waitForDeliveredAcceptanceOtp,
} from './resend-sent-email.mjs';

const key = `re_${'A'.repeat(32)}`;
const recipient = 'delivered+combo-t-0123456789ab-1njchr-1-primary@resend.dev';
const createdAt = '2026-07-28T08:00:01.000Z';
const id = '4ef9a417-02e9-4d39-ad75-9611e0fcc33c';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

test('builds two run-scoped Resend delivered aliases', () => {
  const revision = '0123456789abcdef0123456789abcdef01234567';
  assert.equal(acceptanceEmailAddress('test', revision, '99999999', '1', 'primary'), recipient);
  assert.equal(
    acceptanceEmailAddress('production', revision, '99999999', '2', 'secondary'),
    'delivered+combo-p-0123456789ab-1njchr-2-secondary@resend.dev',
  );
  assert.throws(() => acceptanceEmailAddress('preview', revision, '1', '1', 'other'));
});

test('takes the key once without preserving it in the environment', () => {
  const environment = { ACCEPTANCE_RESEND_API_KEY: key };
  assert.equal(takeAcceptanceResendApiKey(environment), key);
  assert.equal(environment.ACCEPTANCE_RESEND_API_KEY, undefined);
  assert.throws(() => takeAcceptanceResendApiKey(environment));
});

test('validates that the protected key can use the sent-email API', async () => {
  let authorization;
  await validateAcceptanceResendApiKey(key, async (_url, init) => {
    authorization = init.headers.authorization;
    return jsonResponse({ object: 'list', has_more: false, data: [] });
  });
  assert.equal(authorization, `Bearer ${key}`);
  await assert.rejects(() =>
    validateAcceptanceResendApiKey(key, async () =>
      jsonResponse({ name: 'restricted_api_key' }, 401),
    ),
  );
});

test('waits for the exact delivered alias and extracts one OTP from its sent body', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/emails?limit=100')) {
      return jsonResponse({
        object: 'list',
        has_more: false,
        data: [
          {
            id,
            to: [recipient],
            from: 'Combo <auth@buildwithcombo.com>',
            created_at: createdAt,
            subject: 'Combo 登录验证码',
            last_event: 'delivered',
          },
        ],
      });
    }
    return jsonResponse({
      object: 'email',
      id,
      to: [recipient],
      from: 'Combo <auth@buildwithcombo.com>',
      created_at: createdAt,
      subject: 'Combo 登录验证码',
      text: '您的 Combo 登录验证码是 004271。验证码将在 5 分钟后失效。',
      html: null,
      last_event: 'delivered',
    });
  };
  assert.equal(
    await waitForDeliveredAcceptanceOtp({
      apiKey: key,
      recipient,
      notBefore: new Date('2026-07-28T08:00:00.000Z'),
      fetchImpl,
      timeoutMs: 100,
      intervalMs: 1,
    }),
    '004271',
  );
  assert.deepEqual(calls, [
    'https://api.resend.com/emails?limit=100',
    `https://api.resend.com/emails/${id}`,
  ]);
});

test('rejects stale, non-delivered, wrong-recipient, ambiguous, and provider-error data', async () => {
  const cases = [
    {
      object: 'list',
      has_more: false,
      data: [{ id, to: [recipient], created_at: createdAt, subject: 'Combo 登录验证码' }],
    },
    {
      object: 'list',
      has_more: false,
      data: [
        {
          id,
          to: ['delivered+combo-t-0123456789ab-1njchr-1-secondary@resend.dev'],
          created_at: createdAt,
          subject: 'Combo 登录验证码',
          last_event: 'delivered',
        },
      ],
    },
    {
      object: 'list',
      has_more: false,
      data: [
        {
          id,
          to: [recipient],
          from: 'Combo <attacker@example.com>',
          created_at: createdAt,
          subject: 'Combo 登录验证码',
          last_event: 'delivered',
        },
      ],
    },
    { object: 'unexpected', has_more: false, data: [] },
  ];
  for (const payload of cases) {
    await assert.rejects(() =>
      waitForDeliveredAcceptanceOtp({
        apiKey: key,
        recipient,
        notBefore: new Date('2026-07-28T08:00:00.000Z'),
        fetchImpl: async () => jsonResponse(payload),
        timeoutMs: 1,
        intervalMs: 1,
      }),
    );
  }
});
