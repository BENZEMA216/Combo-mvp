import { createHash, generateKeyPairSync } from 'node:crypto';
import { decodeProtectedHeader, exportSPKI, importSPKI, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  createSandboxCapabilitySigner,
  parseSandboxPrivateKey,
  sandboxBodySha256,
} from '../platform/infra/sandbox-capability.js';

function keyFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateDer: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey,
  };
}

describe('sandbox capability signer', () => {
  it('signs short-lived EdDSA claims bound to body, operation, request and Pod identity', async () => {
    const fixture = keyFixture();
    const now = 1_800_000_000_000;
    const signer = createSandboxCapabilitySigner(fixture.privateDer, { now: () => now });
    const body = new TextEncoder().encode('{"path":"src/a.ts"}');
    const token = await signer.sign({
      sessionId: 'session-1',
      podUid: 'pod-uid-1',
      operation: 'read',
      requestId: 'request-1',
      body,
    });
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'EdDSA', typ: 'JWT' });
    const publicKey = await importSPKI(await exportSPKI(fixture.publicKey), 'EdDSA');
    const verified = await jwtVerify(token, publicKey, {
      issuer: 'combo-runtime',
      audience: 'combo-sandboxd',
      currentDate: new Date(now),
    });
    expect(verified.payload).toMatchObject({
      sid: 'session-1',
      puid: 'pod-uid-1',
      op: 'read',
      rid: 'request-1',
      bodySha256: createHash('sha256').update(body).digest('hex'),
      iat: 1_800_000_000,
      nbf: 1_799_999_998,
      exp: 1_800_000_030,
    });
  });

  it('binds cancellation to a target command id and exports only the public key', async () => {
    const fixture = keyFixture();
    const signer = createSandboxCapabilitySigner(fixture.privatePem, {
      now: () => 1_800_000_000_000,
    });
    const body = new TextEncoder().encode('{"commandId":"command-1"}');
    const token = await signer.sign({
      sessionId: 'session-1',
      podUid: 'pod-1',
      operation: 'cancel',
      requestId: 'request-2',
      target: 'command-1',
      body,
    });
    const publicKey = await importSPKI(await exportSPKI(fixture.publicKey), 'EdDSA');
    const verified = await jwtVerify(token, publicKey, {
      issuer: 'combo-runtime',
      audience: 'combo-sandboxd',
      currentDate: new Date(1_800_000_000_000),
    });
    expect(verified.payload.target).toBe('command-1');
    expect(Buffer.from(signer.publicKeyBase64(), 'base64')).toEqual(
      fixture.publicKey.export({ format: 'der', type: 'spki' }),
    );
  });

  it('rejects missing, malformed and non-Ed25519 private keys without echoing values', () => {
    expect(() => parseSandboxPrivateKey('')).toThrow('missing');
    expect(() => parseSandboxPrivateKey('not-a-key')).toThrow('invalid');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      format: 'der',
      type: 'pkcs8',
    });
    expect(() => parseSandboxPrivateKey(rsa.toString('base64'))).toThrow('must be Ed25519');
  });

  it('hashes exact request bytes', () => {
    expect(sandboxBodySha256(new TextEncoder().encode('{}'))).not.toBe(
      sandboxBodySha256(new TextEncoder().encode('{ }')),
    );
  });
});
