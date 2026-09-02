import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createLocalJWKSet, jwtVerify } from 'jose';
import {
  ASSERTION_ALGORITHM,
  createAssertionSigner,
  parseAssertionPrivateKey,
} from '../assertion.js';

function generatePrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
}

const PRIVATE_KEY = generatePrivateKeyPem();

function makeSigner(now?: () => number) {
  return createAssertionSigner({
    privateKey: PRIVATE_KEY,
    kid: 'authz-ed25519-1',
    issuer: 'combo-authz',
    ttlSeconds: 300,
    ...(now ? { now } : {}),
  });
}

async function verifyWithJwks(token: string, signer: ReturnType<typeof makeSigner>, aud: string) {
  const jwks = createLocalJWKSet({ keys: [await signer.publicJwk()] });
  return jwtVerify(token, jwks, { audience: aud, issuer: 'combo-authz' });
}

describe('assertion signer', () => {
  it('signs an EdDSA JWT carrying only identity claims and verifies via JWKS', async () => {
    const signer = makeSigner();
    const token = await signer.sign({ userId: 'user-1', agentId: 'agent-a' });

    const { payload, protectedHeader } = await verifyWithJwks(token, signer, 'agent-a');
    expect(protectedHeader.alg).toBe(ASSERTION_ALGORITHM);
    expect(protectedHeader.kid).toBe('authz-ed25519-1');
    expect(payload.sub).toBe('user-1');
    expect(payload.aud).toBe('agent-a');
    expect(payload.iss).toBe('combo-authz');
    expect(payload.jti).toBeTruthy();
    expect(payload.exp! - payload.iat!).toBe(300);
    // 断言只带身份：不允许权益或敏感声明混入。
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'jti', 'nbf', 'sub']);
  });

  it('rejects verification for a different audience (cross-agent replay)', async () => {
    const signer = makeSigner();
    const token = await signer.sign({ userId: 'user-1', agentId: 'agent-a' });

    await expect(verifyWithJwks(token, signer, 'agent-b')).rejects.toThrow(/aud/);
  });

  it('rejects an expired assertion', async () => {
    const past = Date.now() - 10 * 60 * 1000;
    const signer = makeSigner(() => past);
    const token = await signer.sign({ userId: 'user-1', agentId: 'agent-a' });

    await expect(verifyWithJwks(token, signer, 'agent-a')).rejects.toThrow(/exp/);
  });

  it('rejects a token signed by a different key', async () => {
    const signer = makeSigner();
    const other = createAssertionSigner({
      privateKey: generatePrivateKeyPem(),
      kid: 'authz-ed25519-2',
      issuer: 'combo-authz',
      ttlSeconds: 300,
    });
    const token = await other.sign({ userId: 'user-1', agentId: 'agent-a' });

    await expect(verifyWithJwks(token, signer, 'agent-a')).rejects.toThrow();
  });

  it('exposes a single-kid JWKS document matching the signing key', async () => {
    const signer = makeSigner();
    const jwk = await signer.publicJwk();

    expect(jwk.kty).toBe('OKP');
    expect(jwk.crv).toBe('Ed25519');
    expect(jwk.kid).toBe('authz-ed25519-1');
    expect(jwk.alg).toBe('EdDSA');
    expect(jwk.use).toBe('sig');
    expect(jwk.x).toBeTruthy();
    expect(jwk.d).toBeUndefined();
    expect(await signer.publicJwk()).toBe(jwk);
  });
});

describe('parseAssertionPrivateKey', () => {
  it('accepts PEM PKCS#8 and base64 PKCS#8 DER Ed25519 keys', () => {
    const fromPem = parseAssertionPrivateKey(PRIVATE_KEY);
    expect(fromPem.asymmetricKeyType).toBe('ed25519');

    const der = fromPem.export({ format: 'der', type: 'pkcs8' });
    const fromBase64 = parseAssertionPrivateKey(Buffer.from(der).toString('base64'));
    expect(fromBase64.asymmetricKeyType).toBe('ed25519');
  });

  it('rejects missing, malformed, and non-Ed25519 keys', () => {
    expect(() => parseAssertionPrivateKey('')).toThrow(/missing/);
    expect(() => parseAssertionPrivateKey('not-a-key')).toThrow(/invalid/);
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    expect(() => parseAssertionPrivateKey(rsaPem)).toThrow(/Ed25519/);
  });

  it('rejects an out-of-range ttl at construction', () => {
    expect(() =>
      createAssertionSigner({
        privateKey: PRIVATE_KEY,
        kid: 'k',
        issuer: 'i',
        ttlSeconds: 0,
      }),
    ).toThrow(/ttl/);
    expect(() =>
      createAssertionSigner({
        privateKey: PRIVATE_KEY,
        kid: 'k',
        issuer: 'i',
        ttlSeconds: 901,
      }),
    ).toThrow(/ttl/);
  });
});
