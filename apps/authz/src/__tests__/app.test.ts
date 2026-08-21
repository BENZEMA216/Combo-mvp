import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalJWKSet, jwtVerify, type JWK } from 'jose';
import type { FastifyInstance } from 'fastify';
import { createAssertionSigner } from '../assertion.js';
import { ASSERTION_RESPONSE_HEADER, buildApp } from '../app.js';
import { V2_SESSION_COOKIE_NAME } from '../crypto.js';
import { createFakeCache, createFakeStore } from './fakes.js';

const SECRET = 's'.repeat(32);
const DEV_CODE = '246810';
const EMAIL = 'user@example.com';

function generatePrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function makeApp() {
  const { store, state: storeState } = createFakeStore();
  const { cache, state: cacheState } = createFakeCache();
  app = await buildApp({
    store,
    cache,
    signer: createAssertionSigner({
      privateKey: generatePrivateKeyPem(),
      kid: 'authz-ed25519-1',
      issuer: 'combo-authz',
      ttlSeconds: 300,
    }),
    hmacSecret: SECRET,
    devOtpCode: DEV_CODE,
    sessionCookieDomain: '.buildwithcombo.com',
    sessionCookieSecure: true,
  });
  return { app, storeState, cacheState };
}

function parseSetCookie(response: { headers: Record<string, unknown> }): {
  name: string;
  value: string;
  attributes: string;
} {
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? String(raw[0]) : String(raw);
  const [pair, ...rest] = header.split(';');
  const separator = pair!.indexOf('=');
  return {
    name: pair!.slice(0, separator),
    value: pair!.slice(separator + 1),
    attributes: rest.join(';'),
  };
}

async function injectLogin(instance: FastifyInstance) {
  const challenge = await instance.inject({
    method: 'POST',
    url: '/authz/otp/challenges',
    payload: { email: EMAIL },
  });
  expect(challenge.statusCode).toBe(202);

  const verification = await instance.inject({
    method: 'POST',
    url: '/authz/otp/verifications',
    payload: { email: EMAIL, code: DEV_CODE },
  });
  return verification;
}

describe('authz HTTP surface', () => {
  it('logs in with the dev code, plants a shared-domain cookie, and issues assertions', async () => {
    const { app: instance } = await makeApp();

    const verification = await injectLogin(instance);
    expect(verification.statusCode).toBe(200);
    const body = verification.json() as { data: { user: { id: string } } };
    expect(body.data.user.id).toBeTruthy();

    const cookie = parseSetCookie(verification);
    expect(cookie.name).toBe(V2_SESSION_COOKIE_NAME);
    expect(cookie.attributes).toContain('Domain=.buildwithcombo.com');
    expect(cookie.attributes).toContain('HttpOnly');
    expect(cookie.attributes).toContain('Secure');
    expect(cookie.attributes).toContain('SameSite=Lax');

    const assertionResponse = await instance.inject({
      method: 'GET',
      url: '/authz/assert?agent_id=agent-a',
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    expect(assertionResponse.statusCode).toBe(200);
    const assertionBody = assertionResponse.json() as {
      data: { assertion: string; tokenType: string; expiresInSeconds: number; kid: string };
    };
    expect(assertionBody.data.tokenType).toBe('Bearer');
    expect(assertionBody.data.expiresInSeconds).toBe(300);
    expect(assertionBody.data.kid).toBe('authz-ed25519-1');
    // ForwardAuth 注入头与响应体携带同一断言。
    expect(assertionResponse.headers[ASSERTION_RESPONSE_HEADER]).toBe(assertionBody.data.assertion);

    // 用 JWKS 端点暴露的公钥验签：sub 是用户主键，aud 是请求的 agent_id。
    const jwksResponse = await instance.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    expect(jwksResponse.statusCode).toBe(200);
    const jwks = jwksResponse.json() as { keys: JWK[] };
    expect(jwks.keys).toHaveLength(1);
    const jwk = jwks.keys[0]!;
    expect(jwk.kty).toBe('OKP');
    expect(jwk.crv).toBe('Ed25519');
    expect(jwk.kid).toBe('authz-ed25519-1');

    const verified = await jwtVerify(
      assertionBody.data.assertion,
      createLocalJWKSet({ keys: [jwk] }),
      { audience: 'agent-a', issuer: 'combo-authz' },
    );
    expect(verified.payload.sub).toBe(body.data.user.id);
    expect(verified.payload.aud).toBe('agent-a');
    // 跨 Agent 重放：aud 不匹配必须验签失败。
    await expect(
      jwtVerify(assertionBody.data.assertion, createLocalJWKSet({ keys: [jwk] }), {
        audience: 'agent-b',
        issuer: 'combo-authz',
      }),
    ).rejects.toThrow();
  });

  it('rejects assertion requests without a session or without agent_id', async () => {
    const { app: instance } = await makeApp();

    const anonymous = await instance.inject({ method: 'GET', url: '/authz/assert?agent_id=a' });
    expect(anonymous.statusCode).toBe(401);

    const missingAgent = await instance.inject({ method: 'GET', url: '/authz/assert' });
    expect(missingAgent.statusCode).toBe(400);

    const badAgent = await instance.inject({
      method: 'GET',
      url: '/authz/assert?agent_id=UPPER%20CASE',
    });
    expect(badAgent.statusCode).toBe(400);
  });

  it('rejects a wrong code with 401 and malformed input with 400', async () => {
    const { app: instance } = await makeApp();
    await instance.inject({
      method: 'POST',
      url: '/authz/otp/challenges',
      payload: { email: EMAIL },
    });

    const wrong = await instance.inject({
      method: 'POST',
      url: '/authz/otp/verifications',
      payload: { email: EMAIL, code: '000000' },
    });
    expect(wrong.statusCode).toBe(401);

    const malformed = await instance.inject({
      method: 'POST',
      url: '/authz/otp/verifications',
      payload: { email: EMAIL, code: '12' },
    });
    expect(malformed.statusCode).toBe(400);

    const badEmail = await instance.inject({
      method: 'POST',
      url: '/authz/otp/challenges',
      payload: { email: 'not an email at all' },
    });
    expect(badEmail.statusCode).toBe(400);
  });

  it('logout revokes the session and blocks further assertions', async () => {
    const { app: instance } = await makeApp();
    const verification = await injectLogin(instance);
    const cookie = parseSetCookie(verification);

    const logoutResponse = await instance.inject({
      method: 'POST',
      url: '/authz/logout',
      payload: {},
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    expect(logoutResponse.statusCode).toBe(200);

    const after = await instance.inject({
      method: 'GET',
      url: '/authz/assert?agent_id=agent-a',
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it('reports readiness through the injected probe and always answers health', async () => {
    const { app: instance } = await makeApp();
    const health = await instance.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);

    const ready = await instance.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
  });

  it('serves the self-contained login page with the sanitized next embedded', async () => {
    const { app: instance } = await makeApp();

    const page = await instance.inject({ method: 'GET', url: '/authz/login' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('/authz/otp/challenges');
    expect(page.body).toContain('/authz/otp/verifications');
    expect(page.body).toContain('var NEXT = "/"');

    const withNext = await instance.inject({
      method: 'GET',
      url: '/authz/login?next=/api/chat%3Fx%3D1',
    });
    expect(withNext.body).toContain('var NEXT = "/api/chat?x=1"');
  });

  it('collapses open-redirect next values back to /', async () => {
    const { app: instance } = await makeApp();

    for (const evil of [
      'https://evil.com',
      '//evil.com',
      '/%5C%5Cevil.com',
      '/%0aheader-injection',
      'javascript:alert(1)',
    ]) {
      const page = await instance.inject({
        method: 'GET',
        url: `/authz/login?next=${evil}`,
      });
      expect(page.statusCode, evil).toBe(200);
      expect(page.body, evil).toContain('var NEXT = "/"');
      expect(page.body, evil).not.toContain('evil.com');
    }
  });

  it('redirects signed-in users from the login page to next', async () => {
    const { app: instance } = await makeApp();
    const verification = await injectLogin(instance);
    const cookie = parseSetCookie(verification);

    const login = await instance.inject({
      method: 'GET',
      url: '/authz/login?next=/',
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    expect(login.statusCode).toBe(302);
    expect(login.headers.location).toBe('/');

    const loginWithNext = await instance.inject({
      method: 'GET',
      url: '/authz/login?next=/chat',
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    expect(loginWithNext.statusCode).toBe(302);
    expect(loginWithNext.headers.location).toBe('/chat');
  });

  it('returns 503 for login when the store fails', async () => {
    const { store } = createFakeStore();
    const { cache } = createFakeCache();
    store.replaceChallenge = async () => {
      throw new Error('pg down');
    };
    app = await buildApp({
      store,
      cache,
      signer: createAssertionSigner({
        privateKey: generatePrivateKeyPem(),
        kid: 'k',
        issuer: 'combo-authz',
        ttlSeconds: 300,
      }),
      hmacSecret: SECRET,
      devOtpCode: DEV_CODE,
      sessionCookieSecure: false,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/authz/otp/challenges',
      payload: { email: EMAIL },
    });
    expect(response.statusCode).toBe(503);
  });
});
