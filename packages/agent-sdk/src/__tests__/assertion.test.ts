import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { exportJWK, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  AssertionVerificationError,
  createAssertionVerifier,
  createJwksResolver,
  extractAssertion,
} from '../assertion.js';

const AGENT = 'agent-a';
const ISSUER = 'combo-authz';

interface KeyPair {
  kid: string;
  privateKey: KeyObject;
  publicJwk: Record<string, unknown>;
}

async function makeKeyPair(kid: string): Promise<KeyPair> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = await exportJWK(publicKey);
  return { kid, privateKey, publicJwk: { ...jwk, kid, alg: 'EdDSA', use: 'sig' } };
}

async function sign(
  key: KeyPair,
  claims: { sub?: string; aud?: string; iss?: string; expOffsetSeconds?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: key.kid })
    .setSubject(claims.sub ?? 'user-1')
    .setAudience(claims.aud ?? AGENT)
    .setIssuer(claims.iss ?? ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + (claims.expOffsetSeconds ?? 300))
    .sign(key.privateKey);
}

/** 内存 JWKS 服务：记录抓取次数，可切换当前键集以模拟轮换。 */
function createJwksFetch(initialKeys: KeyPair[]) {
  const state = { fetchCount: 0, keys: initialKeys };
  const fetchImpl = async (_url: string) => {
    state.fetchCount += 1;
    return new Response(JSON.stringify({ keys: state.keys.map((key) => key.publicJwk) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, state };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  const failure = await promise.catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AssertionVerificationError);
  expect((failure as AssertionVerificationError).code).toBe(code);
}

describe('assertion verification', () => {
  it('verifies a valid assertion and returns the user id', async () => {
    const key = await makeKeyPair('kid-1');
    const { fetchImpl, state } = createJwksFetch([key]);
    const verifier = createAssertionVerifier({
      jwksUrl: 'https://authz.example/.well-known/jwks.json',
      agentId: AGENT,
      issuer: ISSUER,
      fetchImpl,
    });

    const verified = await verifier.verify(await sign(key));
    expect(verified.userId).toBe('user-1');
    expect(state.fetchCount).toBe(1);

    // 第二次命中缓存，不再抓 JWKS。
    await verifier.verify(await sign(key));
    expect(state.fetchCount).toBe(1);
  });

  it('rejects a foreign audience (cross-agent replay), expiry, and bad signatures', async () => {
    const key = await makeKeyPair('kid-1');
    const otherKey = await makeKeyPair('kid-1-other');
    const { fetchImpl, state } = createJwksFetch([key]);
    const verifier = createAssertionVerifier({
      jwksUrl: 'https://authz.example/.well-known/jwks.json',
      agentId: AGENT,
      fetchImpl,
    });

    await expectCode(verifier.verify(await sign(key, { aud: 'agent-b' })), 'wrong_audience');
    await expectCode(verifier.verify(await sign(key, { expOffsetSeconds: -10 })), 'expired');

    // 异 key 签名：JWKS 刷新后仍无此 kid。
    await expectCode(verifier.verify(await sign(otherKey)), 'unknown_key');
    expect(state.fetchCount).toBeGreaterThanOrEqual(2);

    // 篡改签名：合法 kid 但签名无效。
    const genuine = await sign(key);
    const tampered = `${genuine.slice(0, -4)}AAAA`;
    await expectCode(verifier.verify(tampered), 'invalid_signature');
  });

  it('rejects missing, malformed, and wrong-issuer assertions', async () => {
    const key = await makeKeyPair('kid-1');
    const { fetchImpl } = createJwksFetch([key]);
    const verifier = createAssertionVerifier({
      jwksUrl: 'https://authz.example/.well-known/jwks.json',
      agentId: AGENT,
      issuer: ISSUER,
      fetchImpl,
    });

    await expectCode(verifier.verify(undefined), 'missing');
    await expectCode(verifier.verify('not-a-jwt'), 'malformed');
    await expectCode(verifier.verify(await sign(key, { iss: 'someone-else' })), 'invalid_claim');
  });

  it('refreshes the JWKS once on an unknown kid and verifies after rotation', async () => {
    const oldKey = await makeKeyPair('kid-old');
    const newKey = await makeKeyPair('kid-new');
    const { fetchImpl, state } = createJwksFetch([oldKey]);
    const verifier = createAssertionVerifier({
      jwksUrl: 'https://authz.example/.well-known/jwks.json',
      agentId: AGENT,
      fetchImpl,
    });

    await verifier.verify(await sign(oldKey));
    const fetchesBefore = state.fetchCount;

    // 轮换：JWKS 只含新 key；未知 kid 触发一次强制刷新后验签通过。
    state.keys = [newKey];
    const verified = await verifier.verify(await sign(newKey));
    expect(verified.userId).toBe('user-1');
    expect(state.fetchCount).toBe(fetchesBefore + 1);
  });

  it('extracts assertions from Headers instances and plain header records', async () => {
    const key = await makeKeyPair('kid-1');
    const { fetchImpl } = createJwksFetch([key]);
    const verifier = createAssertionVerifier({
      jwksUrl: 'https://authz.example/.well-known/jwks.json',
      agentId: AGENT,
      fetchImpl,
    });
    const token = await sign(key);

    const viaHeaders = await verifier.verifyRequest({
      headers: new Headers({ 'x-combo-assertion': token }),
    });
    expect(viaHeaders.userId).toBe('user-1');

    const viaRecord = await verifier.verifyRequest({
      headers: { 'X-Combo-Assertion': token },
    });
    expect(viaRecord.userId).toBe('user-1');

    expect(extractAssertion({ 'content-type': 'application/json' })).toBeUndefined();
    expect(extractAssertion(undefined)).toBeUndefined();
    await expectCode(verifier.verifyRequest({ headers: {} }), 'missing');
  });
});

describe('jwks resolver robustness', () => {
  it('fails unknown_key when the JWKS endpoint errors or is malformed', async () => {
    const resolver = createJwksResolver({
      jwksUrl: 'https://authz.example/.well-known/jwks.json',
      fetchImpl: async () => new Response('oops', { status: 500 }),
    });
    await expectCode(resolver('kid-1'), 'unknown_key');

    const malformed = createJwksResolver({
      jwksUrl: 'https://authz.example/.well-known/jwks.json',
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    await expectCode(malformed('kid-1'), 'unknown_key');
  });
});
