import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createResendMockServer } from './server.mjs';

const apiKey = 'unit-test-mock-key';
let baseUrl;
let server;

function request(path, init = {}) {
  return globalThis.fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
}

before(async () => {
  server = createResendMockServer({ apiKey, maxMessages: 2, timeoutDelayMs: 50 });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('exposes a public health endpoint and protects test controls', async () => {
  assert.equal((await globalThis.fetch(`${baseUrl}/health`)).status, 200);
  assert.equal(
    (await globalThis.fetch(`${baseUrl}/__test/inbox/latest`, { method: 'POST' })).status,
    401,
  );
});

test('accepts the Resend request shape, exposes only id/code, and deduplicates', async () => {
  const payload = JSON.stringify({
    from: 'login@example.test',
    to: ['person@example.test'],
    subject: 'Login code',
    text: 'Your login code is 004271.',
  });
  const headers = { 'idempotency-key': 'challenge-1' };

  const first = await request('/emails', { method: 'POST', headers, body: payload });
  const second = await request('/emails', { method: 'POST', headers, body: payload });
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.deepEqual(await second.json(), await first.json());

  const latest = await request('/__test/inbox/latest', {
    method: 'POST',
    body: JSON.stringify({ to: 'person@example.test' }),
  });
  assert.equal(latest.status, 200);
  const body = await latest.json();
  assert.deepEqual(Object.keys(body).sort(), ['code', 'id']);
  assert.equal(body.code, '004271');
});

test('supports recipient rejection, sender/request errors, rate limiting, server errors, and timeouts', async () => {
  const expected = {
    permanent: 422,
    invalid_from: 422,
    invalid_request: 400,
    rate_limited: 429,
    server_error: 503,
  };

  for (const [mode, status] of Object.entries(expected)) {
    const configured = await request('/__test/mode', {
      method: 'PUT',
      body: JSON.stringify({ mode }),
    });
    assert.equal(configured.status, 200);
    const delivered = await request('/emails', {
      method: 'POST',
      headers: { 'idempotency-key': `challenge-${mode}` },
      body: JSON.stringify({
        from: 'login@example.test',
        to: [`${mode}@example.test`],
        subject: 'Login code',
        text: 'Your login code is 123456.',
      }),
    });
    assert.equal(delivered.status, status);
  }

  await request('/__test/mode', {
    method: 'PUT',
    body: JSON.stringify({ mode: 'timeout' }),
  });
  const timedOut = await request('/emails', {
    method: 'POST',
    headers: { 'idempotency-key': 'challenge-timeout' },
    body: JSON.stringify({
      from: 'login@example.test',
      to: ['timeout@example.test'],
      subject: 'Login code',
      text: 'Your login code is 123456.',
    }),
  });
  assert.equal(timedOut.status, 504);
});

test('clears inbox state without exposing stored messages', async () => {
  const cleared = await request('/__test/inbox', { method: 'DELETE' });
  assert.equal(cleared.status, 204);
  const latest = await request('/__test/inbox/latest', {
    method: 'POST',
    body: JSON.stringify({ to: 'person@example.test' }),
  });
  assert.equal(latest.status, 404);
});
