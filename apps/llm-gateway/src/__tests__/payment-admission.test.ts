import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PaymentRequiredResponseSchema } from '@cb/payment-protocol';
import { buildApp } from '../app.js';
import {
  createPaymentAdmissionClient,
  paymentRequestFingerprint,
  type PaymentAdmissionClient,
} from '../payment-admission.js';
import { createFakeBillingClient, createFakeProviderClient } from './fakes.js';

const userId = randomUUID();
const token = 'test-payment-token-value';
const required = {
  error: {
    userMessage: '请完成支付后继续。',
    retriable: false,
    action: 'wait',
    traceId: 'billing-private-trace',
    payment: {
      id: randomUUID(),
      paymentToken: token,
      amount: { currency: 'CNY', amountCents: '2' },
      expiresAt: '2099-01-01T00:05:00Z',
    },
  },
};
const body = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hi' }],
  x_combo: { user_id: userId, agent_id: 'agent-a', operation_id: 'operation-1', call_id: 'call-1' },
};
async function setup(admit: PaymentAdmissionClient['admit']) {
  const billing = createFakeBillingClient();
  const provider = createFakeProviderClient();
  provider.state.jsonResponse = {
    status: 200,
    json: {
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    },
  };
  const app = await buildApp({
    billing: billing.client,
    paymentAdmission: { admit },
    provider: provider.client,
    gatewayToken: 'test-gateway-token',
    pricing: { default: { input: 1, output: 2 } },
    holdFixedCostCents: 1,
    defaultMaxTokens: 4096,
  });
  return { app, billing: billing.state, provider: provider.state };
}
const request = (app: Awaited<ReturnType<typeof buildApp>>, payload: unknown) =>
  app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: 'Bearer test-gateway-token', 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });

describe('Gateway payment admission', () => {
  it.each([false, true])(
    'returns the same strict 402 before model invocation (stream=%s)',
    async (stream) => {
      const admit = vi
        .fn<PaymentAdmissionClient['admit']>()
        .mockResolvedValue({ kind: 'rejected', status: 402, body: required });
      const { app, provider, billing } = await setup(admit);
      try {
        const response = await request(app, { ...body, stream });
        expect(response.statusCode).toBe(402);
        expect(PaymentRequiredResponseSchema.safeParse(response.json()).success).toBe(true);
        expect(response.json().error.traceId).not.toBe(required.error.traceId);
        expect(provider.requests).toHaveLength(0);
        expect(billing.holds).toHaveLength(0);
        expect(admit.mock.calls[0]?.[0]).toMatchObject({
          userId,
          agentId: 'agent-a',
          operationId: 'operation-1',
          callId: 'call-1',
          estimatedAmount: 2,
        });
        expect(admit.mock.calls[0]?.[0]).not.toHaveProperty('messages');
      } finally {
        await app.close();
      }
    },
  );

  it('does not invoke the model on unavailable, malformed or replayed admissions', async () => {
    const cases: PaymentAdmissionClient['admit'][] = [
      async () => {
        throw new Error('private upstream detail');
      },
      async () => ({ kind: 'rejected', status: 402, body: { ...required, wallet: 'private' } }),
      async () => ({ kind: 'admitted', holdId: randomUUID(), replayed: true }),
      async () => ({ kind: 'admitted', holdId: 'bad hold', replayed: false }),
    ];
    for (const admit of cases) {
      const { app, provider } = await setup(admit);
      try {
        const response = await request(app, body);
        expect([409, 503]).toContain(response.statusCode);
        expect(provider.requests).toHaveLength(0);
        expect(response.body).not.toContain('private');
        expect(response.body).not.toContain(token);
      } finally {
        await app.close();
      }
    }
  });

  it('uses a paid hold exactly once and never forwards business identity fields', async () => {
    const holdId = randomUUID();
    const admit = vi
      .fn<PaymentAdmissionClient['admit']>()
      .mockResolvedValueOnce({ kind: 'admitted', holdId, replayed: false })
      .mockResolvedValue({ kind: 'admitted', holdId, replayed: true });
    const { app, provider, billing } = await setup(admit);
    try {
      expect((await request(app, body)).statusCode).toBe(200);
      expect((await request(app, body)).statusCode).toBe(409);
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]).not.toHaveProperty('x_combo');
      expect(billing.settlements).toEqual([{ holdId, actualAmount: 1 }]);
      expect(billing.holds).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('preserves legacy turn IDs while rejecting mixed identities and extra payment fields', async () => {
    const admit = vi
      .fn<PaymentAdmissionClient['admit']>()
      .mockResolvedValue({ kind: 'rejected', status: 402, body: required });
    const { app } = await setup(admit);
    try {
      const legacy = {
        ...body,
        x_combo: { user_id: userId, agent_id: 'agent-a', turn_id: 'call-1' },
      };
      await request(app, legacy);
      await request(app, legacy);
      expect(admit.mock.calls[0]?.[0].operationId).toBe(admit.mock.calls[1]?.[0].operationId);
      expect(admit.mock.calls[0]?.[0].callId).toBe('call-1');
      expect(
        (await request(app, { ...body, x_combo: { ...body.x_combo, turn_id: 'call-1' } }))
          .statusCode,
      ).toBe(400);
      expect((await request(app, { ...body, paymentToken: token })).statusCode).toBe(400);
      expect(admit).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it('does not accept a provider-originated payment requirement', async () => {
    const { app, provider } = await setup(async () => ({
      kind: 'admitted',
      holdId: randomUUID(),
      replayed: false,
    }));
    provider.jsonResponse = { status: 402, json: required };
    try {
      const response = await request(app, body);
      expect(response.statusCode).toBe(502);
      expect(response.body).not.toContain(token);
    } finally {
      await app.close();
    }
  });

  it('canonicalizes JSON property order but retains every request value', () => {
    expect(paymentRequestFingerprint({ a: 1, b: { d: 2, c: 3 } })).toBe(
      paymentRequestFingerprint({ b: { c: 3, d: 2 }, a: 1 }),
    );
    expect(paymentRequestFingerprint({ messages: ['a'] })).not.toBe(
      paymentRequestFingerprint({ messages: ['b'] }),
    );
  });
});

describe('admission HTTP client', () => {
  it('bounds and cancels a stalled response body', async () => {
    let cancelled = false;
    const client = createPaymentAdmissionClient({
      baseUrl: 'https://billing.combo.test',
      token: 'test-dedicated-credential',
      timeoutMs: 10,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    });
    await expect(
      client.admit({
        userId,
        agentId: 'agent-a',
        operationId: 'operation-1',
        callId: 'call-1',
        requestFingerprint: 'a'.repeat(64),
        pricingPolicyId: 'price-v1',
        estimatedAmount: 2,
      }),
    ).rejects.toThrow('could not be confirmed');
    expect(cancelled).toBe(true);
  });
  it('posts only the admission record with redirect protection', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { data: { holdId: randomUUID(), replayed: false }, meta: { traceId: 'trace-1' } },
          { status: 201 },
        ),
      );
    const client = createPaymentAdmissionClient({
      baseUrl: 'https://billing.combo.test',
      token: 'test-dedicated-credential',
      timeoutMs: 100,
      fetchImpl,
    });
    const input = {
      userId,
      agentId: 'agent-a',
      operationId: 'operation-1',
      callId: 'call-1',
      requestFingerprint: 'a'.repeat(64),
      pricingPolicyId: 'price-v1',
      estimatedAmount: 2,
    };
    expect(await client.admit(input)).toMatchObject({ kind: 'admitted', replayed: false });
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'error',
      method: 'POST',
      body: JSON.stringify(input),
    });
  });

  it('rejects body spoofing, unknown fields, wrong content type and excessive bodies', async () => {
    const responses = [
      Response.json({ ...required, private: true }, { status: 402 }),
      Response.json(
        { data: { holdId: randomUUID(), replayed: true }, meta: { traceId: 'trace-1' } },
        { status: 201 },
      ),
      new Response('{}', { status: 200 }),
      new Response(' '.repeat(65537), { headers: { 'content-type': 'application/json' } }),
      Response.json(required, { status: 503 }),
    ];
    for (const response of responses) {
      const client = createPaymentAdmissionClient({
        baseUrl: 'https://billing.combo.test',
        token: 'test-dedicated-credential',
        timeoutMs: 100,
        fetchImpl: async () => response,
      });
      await expect(
        client.admit({
          userId,
          agentId: 'agent-a',
          operationId: 'operation-1',
          callId: 'call-1',
          requestFingerprint: 'a'.repeat(64),
          pricingPolicyId: 'price-v1',
          estimatedAmount: 2,
        }),
      ).rejects.toThrow('could not be confirmed');
    }
  });
});
