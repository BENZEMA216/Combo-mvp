import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';

export const SANDBOX_CAPABILITY_ISSUER = 'combo-runtime';
export const SANDBOX_CAPABILITY_AUDIENCE = 'combo-sandboxd';
export const SANDBOX_CAPABILITY_TTL_SECONDS = 30;

export type SandboxOperation = 'describe' | 'read' | 'write' | 'edit' | 'command' | 'cancel';

export interface SandboxCapabilityInput {
  sessionId: string;
  podUid: string;
  operation: SandboxOperation;
  requestId: string;
  body: Uint8Array;
  target?: string;
}

export interface SandboxCapabilitySigner {
  sign(input: SandboxCapabilityInput): Promise<string>;
  /** SubjectPublicKeyInfo DER, standard base64. It is safe to mount in sandbox Pods. */
  publicKeyBase64(): string;
}

export function sandboxBodySha256(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Runtime accepts either a PEM PKCS#8 Ed25519 private key or standard-base64 PKCS#8 DER.
 * Parsing stays in Runtime; only the derived public key is sent to sandboxd.
 */
export function parseSandboxPrivateKey(value: string): KeyObject {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('sandbox capability private key is missing');
  let key: KeyObject;
  try {
    key = trimmed.startsWith('-----BEGIN PRIVATE KEY-----')
      ? createPrivateKey(trimmed)
      : createPrivateKey({ key: Buffer.from(trimmed, 'base64'), format: 'der', type: 'pkcs8' });
  } catch {
    throw new Error('sandbox capability private key is invalid');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('sandbox capability private key must be Ed25519');
  }
  return key;
}

export function createSandboxCapabilitySigner(
  privateKeyValue: string,
  options: {
    issuer?: string;
    audience?: string;
    now?: () => number;
  } = {},
): SandboxCapabilitySigner {
  const privateKey = parseSandboxPrivateKey(privateKeyValue);
  const publicKey = createPublicKey(privateKey);
  const issuer = options.issuer ?? SANDBOX_CAPABILITY_ISSUER;
  const audience = options.audience ?? SANDBOX_CAPABILITY_AUDIENCE;
  const now = options.now ?? (() => Date.now());

  return {
    async sign(input) {
      const issuedAt = Math.floor(now() / 1000);
      return new SignJWT({
        sid: input.sessionId,
        puid: input.podUid,
        op: input.operation,
        rid: input.requestId,
        bodySha256: sandboxBodySha256(input.body),
        ...(input.target ? { target: input.target } : {}),
      })
        .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt(issuedAt)
        .setNotBefore(issuedAt - 2)
        .setExpirationTime(issuedAt + SANDBOX_CAPABILITY_TTL_SECONDS)
        .sign(privateKey);
    },
    publicKeyBase64() {
      return publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    },
  };
}
