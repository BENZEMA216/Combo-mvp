import { describe, expect, it } from 'vitest';
import { AgentSdkConfigError, loadAgentSdkConfig } from '../config.js';
import { EntitlementError, createEntitlementClient } from '../entitlement.js';
import { LlmGatewayError, createLlmClient } from '../llm.js';

const ENV = {
  COMBO_AGENT_ID: 'agent-a',
  COMBO_PLATFORM_INTERNAL_TOKEN: 'internal-token-0123456789',
  COMBO_LLM_GATEWAY_URL: 'http://gateway:4103/',
  COMBO_BILLING_URL: 'http://billing:4102',
  COMBO_JWKS_URL: 'http://authz:4101/.well-known/jwks.json',
};

describe('loadAgentSdkConfig', () => {
  it('parses a complete environment and strips trailing slashes', () => {
    const config = loadAgentSdkConfig(ENV);
    expect(config.agentId).toBe('agent-a');
    expect(config.llmGatewayUrl).toBe('http://gateway:4103');
    expect(config.assertionIssuer).toBeUndefined();
  });

  it('reports every missing variable at once', () => {
    const failure = catchSync(() => loadAgentSdkConfig({}));
    expect(failure).toBeInstanceOf(AgentSdkConfigError);
    expect((failure as AgentSdkConfigError).missing).toEqual([
      'COMBO_AGENT_ID',
      'COMBO_PLATFORM_INTERNAL_TOKEN',
      'COMBO_LLM_GATEWAY_URL',
      'COMBO_BILLING_URL',
      'COMBO_JWKS_URL',
    ]);
  });

  it('rejects malformed agent ids, weak tokens, and non-http urls', () => {
    expect(() => loadAgentSdkConfig({ ...ENV, COMBO_AGENT_ID: 'UPPER' })).toThrow(/COMBO_AGENT_ID/);
    expect(() => loadAgentSdkConfig({ ...ENV, COMBO_PLATFORM_INTERNAL_TOKEN: 'short' })).toThrow(
      /INTERNAL_TOKEN/,
    );
    expect(() => loadAgentSdkConfig({ ...ENV, COMBO_BILLING_URL: 'billing:4102' })).toThrow(
      /COMBO_BILLING_URL/,
    );
  });
});

function catchSync(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

function captureFetch(response: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit; body?: unknown }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      init,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return response();
  };
  return { fetchImpl, calls };
}

describe('llm client', () => {
  const options = {
    gatewayUrl: 'http://gateway:4103',
    internalToken: 'internal-token-0123456789',
    agentId: 'agent-a',
    defaultModel: 'deepseek-chat',
    randomId: () => 'generated-turn-id',
  };

  it('injects x_combo with an auto turn id and maps maxTokens to max_tokens', async () => {
    const { fetchImpl, calls } = captureFetch(
      () => new Response('{"id":"chatcmpl-1"}', { status: 200 }),
    );
    const client = createLlmClient({ ...options, fetchImpl });

    const result = await client.chatCompletion({
      userId: 'user-1',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 512,
      temperature: 0.5,
    });
    expect(result).toMatchObject({ id: 'chatcmpl-1' });

    const request = calls[0]!;
    expect(request.url).toBe('http://gateway:4103/v1/chat/completions');
    expect(request.init?.headers).toMatchObject({
      authorization: 'Bearer internal-token-0123456789',
    });
    expect(request.body).toEqual({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
      max_tokens: 512,
      x_combo: { user_id: 'user-1', agent_id: 'agent-a', turn_id: 'generated-turn-id' },
    });
  });

  it('honours a caller-provided turn id', async () => {
    const { fetchImpl, calls } = captureFetch(() => new Response('{}', { status: 200 }));
    const client = createLlmClient({ ...options, fetchImpl });

    await client.chatCompletion({
      userId: 'user-1',
      turnId: 'my-turn',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect((calls[0]!.body as { x_combo: { turn_id: string } }).x_combo.turn_id).toBe('my-turn');
  });

  it('throws LlmGatewayError with status and body on 402', async () => {
    const { fetchImpl } = captureFetch(
      () => new Response(JSON.stringify({ error: { code: 'payment_required' } }), { status: 402 }),
    );
    const client = createLlmClient({ ...options, fetchImpl });

    const failure = await client
      .chatCompletion({ userId: 'user-1', messages: [{ role: 'user', content: 'hi' }] })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LlmGatewayError);
    expect((failure as LlmGatewayError).status).toBe(402);
    expect((failure as LlmGatewayError).body).toMatchObject({
      error: { code: 'payment_required' },
    });
  });

  it('throws LlmGatewayError when the stream request fails', async () => {
    const { fetchImpl } = captureFetch(() => new Response('upstream down', { status: 500 }));
    const client = createLlmClient({ ...options, fetchImpl });

    const failure = await client
      .chatCompletionStream({ userId: 'user-1', messages: [{ role: 'user', content: 'hi' }] })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LlmGatewayError);
    expect((failure as LlmGatewayError).status).toBe(500);
  });
});

describe('entitlement client', () => {
  it('reads the wallet view with the internal token', async () => {
    const { fetchImpl, calls } = captureFetch(
      () =>
        new Response(
          JSON.stringify({
            data: {
              userId: 'user-1',
              principalBalance: 900,
              bonusBalance: 100,
              heldAmount: 50,
              availableBalance: 950,
            },
          }),
          { status: 200 },
        ),
    );
    const client = createEntitlementClient({
      billingUrl: 'http://billing:4102',
      internalToken: 'internal-token-0123456789',
      fetchImpl,
    });

    const wallet = await client.check('user-1');
    expect(wallet).toEqual({
      userId: 'user-1',
      principalBalance: 900,
      bonusBalance: 100,
      heldAmount: 50,
      availableBalance: 950,
    });
    expect(calls[0]!.url).toBe('http://billing:4102/billing/wallets/user-1');
    expect(calls[0]!.init?.headers).toMatchObject({
      authorization: 'Bearer internal-token-0123456789',
    });
  });

  it('throws EntitlementError on non-200 responses', async () => {
    const { fetchImpl } = captureFetch(() => new Response('down', { status: 503 }));
    const client = createEntitlementClient({
      billingUrl: 'http://billing:4102',
      internalToken: 'internal-token-0123456789',
      fetchImpl,
    });
    await expect(client.check('user-1')).rejects.toBeInstanceOf(EntitlementError);
  });
});
