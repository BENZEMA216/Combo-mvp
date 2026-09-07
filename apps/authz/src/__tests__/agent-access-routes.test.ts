import Fastify from 'fastify';
import { generateKeyPairSync } from 'node:crypto';
import { ErrorEnvelopeSchema } from '@cb/shared';
import { describe, expect, it, vi } from 'vitest';
import { createAgentAccessRateLimiter, registerAgentAccessRoutes } from '../agent-access-routes.js';
import { buildApp } from '../app.js';
import { createAssertionSigner } from '../assertion.js';
import { createFakeStore, createFakeCache, createFakeOtpRateLimiter } from './fakes.js';

function setup() {
  const app = Fastify({ trustProxy: true });
  const issue = vi.fn().mockResolvedValue({
    accessToken: 'synthetic-access-token',
    tokenType: 'Bearer',
    expiresInSeconds: 300,
  });
  const allowRequest = vi.fn().mockResolvedValue(true);
  registerAgentAccessRoutes(app, { issuer: { issue }, allowRequest });
  return { app, issue, allowRequest };
}
describe('Agent access HTTP boundary', () => {
  it('registers through the actual Authz application only when explicitly configured', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const deps = {
      store: createFakeStore().store,
      cache: createFakeCache().cache,
      otpRateLimiter: createFakeOtpRateLimiter().limiter,
      hmacSecret: 'test-hmac-secret'.repeat(3),
      sessionCookieSecure: false,
      signer: createAssertionSigner({
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        kid: 'test-key',
        issuer: 'combo-authz',
      }),
    };
    const disabled = await buildApp(deps);
    const enabled = await buildApp({
      ...deps,
      agentAccess: {
        issuer: {
          issue: async () => ({
            accessToken: 'synthetic-access-token',
            tokenType: 'Bearer',
            expiresInSeconds: 300,
          }),
        },
        allowRequest: async () => true,
      },
    });
    try {
      expect(
        (await disabled.inject({ method: 'POST', url: '/authz/agent-tokens', payload: {} }))
          .statusCode,
      ).toBe(404);
      expect(
        (await enabled.inject({ method: 'POST', url: '/authz/agent-tokens', payload: {} }))
          .statusCode,
      ).toBe(200);
    } finally {
      await disabled.close();
      await enabled.close();
    }
  });
  it('accepts only empty requests and takes identity from the credential header', async () => {
    const { app, issue } = setup();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/authz/agent-tokens',
        headers: { authorization: 'Basic synthetic' },
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(issue).toHaveBeenCalledWith('Basic synthetic');
      for (const body of [
        { agentId: 'agent-b' },
        { scope: 'billing:admin' },
        { userId: 'another-user' },
        { expiresInSeconds: 86400 },
      ])
        expect(
          (await app.inject({ method: 'POST', url: '/authz/agent-tokens', payload: body }))
            .statusCode,
        ).toBe(400);
      expect(issue).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
  it('fails closed on invalid credentials, rate limits and limiter failures', async () => {
    const { app, issue, allowRequest } = setup();
    try {
      issue.mockResolvedValue(null);
      const rejected = await app.inject({
        method: 'POST',
        url: '/authz/agent-tokens',
        payload: {},
      });
      expect(rejected.statusCode).toBe(401);
      expect(ErrorEnvelopeSchema.safeParse(rejected.json()).success).toBe(true);
      allowRequest.mockResolvedValue(false);
      expect(
        (await app.inject({ method: 'POST', url: '/authz/agent-tokens', payload: {} })).statusCode,
      ).toBe(429);
      allowRequest.mockRejectedValue(new Error('private limiter details'));
      const unavailable = await app.inject({
        method: 'POST',
        url: '/authz/agent-tokens',
        payload: {},
      });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.body).not.toContain('private');
      expect(issue).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
  it('does not use caller-supplied proxy headers to bypass the token rate limit', async () => {
    const { app, allowRequest } = setup();
    try {
      await app.inject({
        method: 'POST',
        url: '/authz/agent-tokens',
        remoteAddress: '10.0.0.2',
        headers: { 'x-forwarded-for': '192.0.2.10' },
        payload: {},
      });
      expect(allowRequest).toHaveBeenCalledWith('10.0.0.2');
    } finally {
      await app.close();
    }
  });
  it('stores only a domain-separated digest in Redis and uses one atomic counter', async () => {
    const evalRedis = vi.fn().mockResolvedValue(1);
    const allow = createAgentAccessRateLimiter({ eval: evalRedis }, 'test-hmac-key'.repeat(4));
    expect(await allow('192.0.2.1')).toBe(true);
    const key = evalRedis.mock.calls[0]![2];
    expect(key).toMatch(/^authz:v2:agent-access:[0-9a-f]{64}$/);
    expect(key).not.toContain('192.0.2.1');
    evalRedis.mockResolvedValue(0);
    expect(await allow('192.0.2.1')).toBe(false);
  });
});
