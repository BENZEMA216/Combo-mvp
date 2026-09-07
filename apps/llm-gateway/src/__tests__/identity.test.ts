import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, SignJWT, type JWTPayload } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGatewayIdentityVerifier } from '../identity.js';
import { buildApp } from '../app.js';
import { loadEnv } from '../env.js';
import { createFakeBillingClient, createFakeProviderClient } from './fakes.js';

const keys = generateKeyPairSync('ed25519');
const userId = randomUUID();
const now = Math.floor(Date.now() / 1000);
async function token(
  payload: JWTPayload,
  subject: string,
  audience: string,
  ttl = 300,
  key = keys.privateKey,
) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'EdDSA', kid: 'key-1', typ: 'JWT' })
    .setIssuer('combo-authz')
    .setSubject(subject)
    .setAudience(audience)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + ttl)
    .setJti(randomUUID())
    .sign(key);
}
async function verifier() {
  return createGatewayIdentityVerifier({
    issuer: 'combo-authz',
    key: createLocalJWKSet({
      keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'key-1', alg: 'EdDSA' }],
    }),
  });
}
const agentPayload = { token_use: 'agent_access', agent_id: 'agent-a', scope: 'llm:invoke' };
afterEach(() => vi.unstubAllEnvs());

describe('Gateway independent identity verification', () => {
  it('derives both identities from valid, scoped signatures', async () => {
    const verify = await verifier();
    const agent = await token(agentPayload, 'agent-a', 'combo-llm-gateway');
    const user = await token({}, userId, 'agent-a');
    await expect(verify.verify(`Bearer ${agent}`, user)).resolves.toEqual({
      userId,
      agentId: 'agent-a',
    });
  });
  it('rejects cross-Agent assertions, expired and unscoped tokens, wrong keys and token-family substitution', async () => {
    const verify = await verifier();
    const agent = await token(agentPayload, 'agent-a', 'combo-llm-gateway');
    const user = await token({}, userId, 'agent-a');
    for (const [access, assertion] of [
      [agent, await token({}, userId, 'agent-b')],
      [await token(agentPayload, 'agent-a', 'combo-llm-gateway', -1), user],
      [await token(agentPayload, 'agent-a', 'combo-llm-gateway', 3600), user],
      [await token({}, userId, 'combo-llm-gateway'), user],
      [agent, agent],
      [
        await token(
          agentPayload,
          'agent-a',
          'combo-llm-gateway',
          300,
          generateKeyPairSync('ed25519').privateKey,
        ),
        user,
      ],
      [await token({ ...agentPayload, agent_id: 'agent-b' }, 'agent-a', 'combo-llm-gateway'), user],
    ])
      await expect(verify.verify(`Bearer ${access}`, assertion)).rejects.toMatchObject({
        status: 401,
      });
    await expect(
      verify.verify(
        `Bearer ${await token({ ...agentPayload, scope: 'billing:admin' }, 'agent-a', 'combo-llm-gateway')}`,
        user,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('never contacts Billing or the provider for invalid identity or self-reported body identity', async () => {
    const billing = createFakeBillingClient();
    const provider = createFakeProviderClient();
    const admit = vi
      .fn()
      .mockResolvedValue({ kind: 'admitted', holdId: randomUUID(), replayed: false });
    provider.state.jsonResponse = {
      status: 200,
      json: { choices: [{ message: { role: 'assistant', content: 'ok' } }] },
    };
    const app = await buildApp({
      identityVerifier: await verifier(),
      billing: billing.client,
      paymentAdmission: { admit },
      provider: provider.client,
      pricing: { default: { input: 1, output: 2 } },
      holdFixedCostCents: 1,
      defaultMaxTokens: 4096,
    });
    const agent = await token(agentPayload, 'agent-a', 'combo-llm-gateway');
    const user = await token({}, userId, 'agent-a');
    const body = {
      model: 'model-a',
      messages: [{ role: 'user', content: 'hi' }],
      x_combo: { operation_id: 'operation-1', call_id: 'call-1' },
    };
    try {
      expect(
        (await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: body }))
          .statusCode,
      ).toBe(401);
      const headers = { authorization: `Bearer ${agent}`, 'x-combo-assertion': user };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/chat/completions',
            headers,
            payload: {
              ...body,
              x_combo: { ...body.x_combo, user_id: userId, agent_id: 'agent-a' },
            },
          })
        ).statusCode,
      ).toBe(400);
      expect(admit).not.toHaveBeenCalled();
      expect(provider.state.requests).toHaveLength(0);
      expect(
        (await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: body }))
          .statusCode,
      ).toBe(200);
      expect(admit.mock.calls[0]?.[0]).toMatchObject({
        userId,
        agentId: 'agent-a',
        operationId: 'operation-1',
        callId: 'call-1',
      });
      expect(provider.state.requests[0]).not.toHaveProperty('x_combo');
    } finally {
      await app.close();
    }
  });
  it('refuses legacy identity in production and requires HTTPS for the trust root', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('LLM_GATEWAY_AUTH_MODE', 'legacy-test');
    expect(() => loadEnv()).toThrow('not allowed in production');
    expect(() =>
      createGatewayIdentityVerifier({
        issuer: 'combo-authz',
        jwksUrl: 'http://untrusted.invalid/jwks',
      }),
    ).toThrow('HTTPS');
  });
  it('fails closed with an unavailable status when the signing key service fails', async () => {
    const verify = createGatewayIdentityVerifier({
      issuer: 'combo-authz',
      key: async () => {
        throw new Error('key service offline');
      },
    });
    await expect(
      verify.verify(
        `Bearer ${await token(agentPayload, 'agent-a', 'combo-llm-gateway')}`,
        await token({}, userId, 'agent-a'),
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
});
