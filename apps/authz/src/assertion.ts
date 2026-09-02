// 身份断言：JWT(EdDSA) 签发与 JWKS 公钥导出。断言只带身份（sub/aud/iss/exp），不带权益；
// SDK 验签强制 audience=agent_id，跨 Agent 重放无效。
import { createPrivateKey, createPublicKey, randomUUID, type KeyObject } from 'node:crypto';
import { exportJWK, SignJWT, type JWK } from 'jose';

export const ASSERTION_ALGORITHM = 'EdDSA';
export const ASSERTION_DEFAULT_TTL_SECONDS = 300;
export const ASSERTION_MAX_TTL_SECONDS = 900;

export interface AssertionSigner {
  readonly kid: string;
  readonly issuer: string;
  readonly ttlSeconds: number;
  sign(input: { userId: string; agentId: string }): Promise<string>;
  /** 当前公钥的 JWK 形态，直接构成 JWKS 端点内容。 */
  publicJwk(): Promise<JWK>;
}

/** 接受 PEM PKCS#8 或标准 base64 PKCS#8 DER 的 Ed25519 私钥。 */
export function parseAssertionPrivateKey(value: string): KeyObject {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('assertion private key is missing');
  let key: KeyObject;
  try {
    key = trimmed.startsWith('-----BEGIN PRIVATE KEY-----')
      ? createPrivateKey(trimmed)
      : createPrivateKey({ key: Buffer.from(trimmed, 'base64'), format: 'der', type: 'pkcs8' });
  } catch {
    throw new Error('assertion private key is invalid');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('assertion private key must be Ed25519');
  }
  return key;
}

export function createAssertionSigner(options: {
  privateKey: string;
  kid: string;
  issuer: string;
  ttlSeconds?: number;
  now?: () => number;
  randomId?: () => string;
}): AssertionSigner {
  const privateKey = parseAssertionPrivateKey(options.privateKey);
  const publicKey = createPublicKey(privateKey);
  const ttlSeconds = options.ttlSeconds ?? ASSERTION_DEFAULT_TTL_SECONDS;
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > ASSERTION_MAX_TTL_SECONDS
  ) {
    throw new Error(`assertion ttl must be an integer within 1..${ASSERTION_MAX_TTL_SECONDS}`);
  }
  if (!options.kid) throw new Error('assertion key id is required');
  if (!options.issuer) throw new Error('assertion issuer is required');
  const now = options.now ?? (() => Date.now());
  const randomId = options.randomId ?? randomUUID;

  let cachedJwk: JWK | undefined;

  return {
    kid: options.kid,
    issuer: options.issuer,
    ttlSeconds,
    async sign({ userId, agentId }) {
      const issuedAt = Math.floor(now() / 1000);
      return new SignJWT({})
        .setProtectedHeader({ alg: ASSERTION_ALGORITHM, typ: 'JWT', kid: options.kid })
        .setSubject(userId)
        .setAudience(agentId)
        .setIssuer(options.issuer)
        .setIssuedAt(issuedAt)
        .setNotBefore(issuedAt - 2)
        .setExpirationTime(issuedAt + ttlSeconds)
        .setJti(randomId())
        .sign(privateKey);
    },
    async publicJwk() {
      if (!cachedJwk) {
        cachedJwk = {
          ...(await exportJWK(publicKey)),
          kid: options.kid,
          alg: ASSERTION_ALGORITHM,
          use: 'sig',
        };
      }
      return cachedJwk;
    },
  };
}
