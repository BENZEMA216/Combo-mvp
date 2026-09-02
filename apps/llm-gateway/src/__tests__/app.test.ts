import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type GatewayAppDependencies } from '../app.js';
import { createFakeBillingClient, createFakeProviderClient, sseStreamFromChunks } from './fakes.js';

const TOKEN = 'gateway-token-0123456789';
const USER = randomUUID();
const PRICING = { default: { input: 1, output: 2 }, 'deepseek-chat': { input: 1, output: 2 } };

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function makeApp() {
  const billing = createFakeBillingClient();
  const provider = createFakeProviderClient();
  const deps: GatewayAppDependencies = {
    billing: billing.client,
    provider: provider.client,
    gatewayToken: TOKEN,
    pricing: PRICING,
    holdFixedCostCents: 1,
    defaultMaxTokens: 4096,
  };
  app = await buildApp(deps);
  return { app, billing: billing.state, provider: provider.state };
}

function chatBody(extra: Record<string, unknown> = {}) {
  return {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: '你好' }],
    x_combo: { user_id: USER, agent_id: 'agent-a', turn_id: 'turn-1' },
    ...extra,
  };
}

function call(instance: FastifyInstance, payload: unknown, token: string | null = TOKEN) {
  return instance.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    payload: payload as Record<string, unknown>,
  });
}

describe('gateway entry auth and validation', () => {
  it('rejects missing or wrong internal tokens with 401', async () => {
    const { app: instance } = await makeApp();
    expect((await call(instance, chatBody(), null)).statusCode).toBe(401);
    expect((await call(instance, chatBody(), 'wrong-token-aaaaaaa')).statusCode).toBe(401);
  });

  it('rejects bodies without a valid platform extension with 400', async () => {
    const { app: instance } = await makeApp();
    expect((await call(instance, { model: 'm', messages: [{}] })).statusCode).toBe(400);
  });
});

describe('non-stream chat completions', () => {
  it('holds, forwards, reports usage with hold_id, and settles the real amount', async () => {
    const { app: instance, billing, provider } = await makeApp();
    provider.jsonResponse = {
      status: 200,
      json: {
        id: 'chatcmpl-1',
        choices: [{ message: { role: 'assistant', content: '你好' } }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 },
      },
    };

    const response = await call(instance, chatBody({ max_tokens: 1_000_000 }));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'chatcmpl-1' });

    // 编排顺序：先 hold，再 provider，再 metering，最后 settle。
    expect(billing.holds).toHaveLength(1);
    expect(billing.holds[0]).toMatchObject({ estimatedAmount: 3 }); // 1e6 × 2/1e6 + 1
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({ max_tokens: 1_000_000 });
    expect(provider.requests[0]).not.toHaveProperty('x_combo');
    expect(billing.usageReports).toHaveLength(1);
    expect(billing.usageReports[0]![0]).toMatchObject({
      holdId: 'hold-1',
      dimension: 'llm_token_in',
      source: 'gateway',
    });
    expect(billing.settlements).toEqual([{ holdId: 'hold-1', actualAmount: 2 }]);
  });

  it('passes billing 402 through with the billing body', async () => {
    const { app: instance, billing, provider } = await makeApp();
    billing.rejectNextHold = {
      status: 402,
      body: { error: { code: 'payment_required' }, data: { reason: 'insufficient' } },
    };

    const response = await call(instance, chatBody());
    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({ data: { reason: 'insufficient' } });
    expect(provider.requests).toHaveLength(0);
  });

  it('passes billing idempotency conflicts through without invoking the provider', async () => {
    const { app: instance, billing, provider } = await makeApp();
    billing.rejectNextHold = {
      status: 409,
      body: { error: { code: 'conflict' }, data: { reason: 'idempotency_mismatch' } },
    };

    const response = await call(instance, chatBody());
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ data: { reason: 'idempotency_mismatch' } });
    expect(provider.requests).toHaveLength(0);
    expect(billing.usageReports).toHaveLength(0);
    expect(billing.settlements).toHaveLength(0);
  });

  it('fails closed when billing rejects an unknown user', async () => {
    const { app: instance, billing, provider } = await makeApp();
    billing.rejectNextHold = {
      status: 404,
      body: { error: { code: 'not_found' }, data: { reason: 'user_not_found' } },
    };

    const response = await call(instance, chatBody());
    expect(response.statusCode).toBe(404);
    expect(provider.requests).toHaveLength(0);
    expect(billing.usageReports).toHaveLength(0);
    expect(billing.settlements).toHaveLength(0);
  });

  it('fails closed on malformed billing success before invoking the provider', async () => {
    const { app: instance, billing, provider } = await makeApp();
    billing.protocolErrorNextHold = true;

    const response = await call(instance, chatBody());
    expect(response.statusCode).toBe(503);
    expect(provider.requests).toHaveLength(0);
    expect(billing.usageReports).toHaveLength(0);
    expect(billing.settlements).toHaveLength(0);
  });

  it('fails open when billing is unavailable: forwards, reports usage without hold, skips settle', async () => {
    const { app: instance, billing, provider } = await makeApp();
    billing.failNextHold = true;
    provider.jsonResponse = {
      status: 200,
      json: {
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      },
    };

    const response = await call(instance, chatBody());
    expect(response.statusCode).toBe(200);
    expect(provider.requests).toHaveLength(1);
    expect(billing.usageReports).toHaveLength(1);
    expect(billing.usageReports[0]![0]).not.toHaveProperty('holdId');
    expect(billing.settlements).toHaveLength(0);
  });

  it('passes provider errors through and releases the hold with a zero settle', async () => {
    const { app: instance, billing, provider } = await makeApp();
    provider.jsonResponse = { status: 429, json: { error: { message: 'rate limited' } } };

    const response = await call(instance, chatBody());
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ error: { message: 'rate limited' } });
    expect(billing.settlements).toEqual([{ holdId: 'hold-1', actualAmount: 0 }]);
    expect(billing.usageReports).toHaveLength(0);
  });

  it.each([
    null,
    {},
    { error: { message: 'failed' } },
    { choices: [] },
    { choices: [{ message: [] }] },
    { choices: [{ message: {} }] },
  ])(
    'releases the hold without charging for invalid provider success payload %j',
    async (payload) => {
      const { app: instance, billing, provider } = await makeApp();
      provider.jsonResponse = { status: 200, json: payload };

      const response = await call(instance, chatBody());
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({ error: { code: 'provider_unavailable' } });
      expect(billing.settlements).toEqual([{ holdId: 'hold-1', actualAmount: 0 }]);
      expect(billing.usageReports).toHaveLength(0);
    },
  );
});

it.each([false, true])(
  'rejects a replayed %s stream flag before any provider or accounting side effect',
  async (stream) => {
    const { app: instance, billing, provider } = await makeApp();
    billing.replayNextHold = true;

    const response = await call(instance, chatBody({ stream }));

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ data: { reason: 'turn_already_admitted' } });
    expect(provider.requests).toHaveLength(0);
    expect(billing.usageReports).toHaveLength(0);
    expect(billing.settlements).toHaveLength(0);
  },
);

describe('stream chat completions', () => {
  it('passes provider SSE bytes through verbatim and settles from the usage frame', async () => {
    const { app: instance, billing, provider } = await makeApp();
    const chunks = [
      'data: {"id":"c1","choices":[{"delta":{"content":"你',
      '好"}}]}\n\ndata: {"id":"c1","choices":[],"usage":{"prompt_tokens":1_000_000,"completion_tokens":500_000}}\n\ndata: [DONE]\n\n'.replace(
        /(\d)_(\d)/g,
        '$1$2',
      ),
    ];
    provider.streamResponse = { status: 200, stream: sseStreamFromChunks(chunks) };

    const response = await call(instance, chatBody({ stream: true }));
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toBe(chunks.join(''));
    expect(response.body).toContain('[DONE]');

    // 转发体强制了 include_usage；x_combo 被剥离。
    expect(provider.requests[0]).toMatchObject({
      stream: true,
      max_tokens: 4096,
      stream_options: { include_usage: true },
    });
    expect(provider.requests[0]).not.toHaveProperty('x_combo');

    expect(billing.usageReports).toHaveLength(1);
    expect(billing.settlements).toEqual([{ holdId: 'hold-1', actualAmount: 2 }]);
  });

  it('settles the estimate when the stream carries no usage frame', async () => {
    const { app: instance, billing, provider } = await makeApp();
    provider.streamResponse = {
      status: 200,
      stream: sseStreamFromChunks(['data: {"id":"c1"}\n\ndata: [DONE]\n\n']),
    };

    const response = await call(instance, chatBody({ stream: true, max_tokens: 1_000_000 }));
    expect(response.statusCode).toBe(200);
    expect(billing.usageReports).toHaveLength(0);
    // 无 usage → 按估算 settle，billing 会自动补 estimated 计量行。
    expect(billing.settlements).toEqual([{ holdId: 'hold-1', actualAmount: 3 }]);
  });

  it('a failed settle does not break an already-streamed response', async () => {
    const { app: instance, billing, provider } = await makeApp();
    provider.streamResponse = {
      status: 200,
      stream: sseStreamFromChunks(['data: [DONE]\n\n']),
    };
    billing.failNextSettle = true;

    const response = await call(instance, chatBody({ stream: true }));
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('[DONE]');
    expect(billing.settlements).toHaveLength(0);
  });

  it('passes provider stream errors through and releases the hold', async () => {
    const { app: instance, billing, provider } = await makeApp();
    provider.streamResponse = { status: 500, stream: null, errorBody: '{"error":"upstream"}' };

    const response = await call(instance, chatBody({ stream: true }));
    expect(response.statusCode).toBe(500);
    expect(response.body).toBe('{"error":"upstream"}');
    expect(billing.settlements).toEqual([{ holdId: 'hold-1', actualAmount: 0 }]);
  });
});
