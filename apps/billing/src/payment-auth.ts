import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { FastifyRequest } from 'fastify';

export class PaymentAuthenticationError extends Error {
  constructor(readonly status: 401 | 403) {
    super('payment authentication failed');
    this.name = 'PaymentAuthenticationError';
  }
}

export function paymentGatewayAuthenticated(
  authorization: string | undefined,
  expected: string,
): boolean {
  if (!authorization?.startsWith('Bearer ') || authorization.length > 8200) return false;
  const candidate = createHash('sha256').update(authorization.slice(7)).digest();
  return timingSafeEqual(candidate, createHash('sha256').update(expected).digest());
}

export function createPaymentUserAuthenticator(options: {
  authzBaseUrl: string;
  jwksUrl?: string;
  issuer: string;
  trustedOrigins: readonly string[];
  allowHttpForTest?: boolean;
  key?: JWTVerifyGetKey;
  fetchImpl?: typeof fetch;
}) {
  const authz = new URL(options.authzBaseUrl);
  if (
    (authz.protocol !== 'https:' && !(options.allowHttpForTest && authz.protocol === 'http:')) ||
    authz.username ||
    authz.password ||
    authz.search ||
    authz.hash
  )
    throw new Error('payment Authz must use trusted HTTPS');
  let key = options.key;
  if (!key) {
    const url = new URL(options.jwksUrl ?? '');
    if (
      (url.protocol !== 'https:' && !(options.allowHttpForTest && url.protocol === 'http:')) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('payment JWKS must use trusted HTTPS');
    key = createRemoteJWKSet(url, { timeoutDuration: 2000 });
  }
  if (!options.issuer) throw new Error('payment assertion issuer is required');
  const resolver = key;
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.authzBaseUrl.replace(/\/+$/, '')}/authz/assert?agent_id=combo-payment-host`;
  return async (request: FastifyRequest): Promise<string | null> => {
    const origin = request.headers.origin;
    if (
      (origin && !options.trustedOrigins.includes(origin)) ||
      (request.method === 'POST' && !origin)
    )
      throw new PaymentAuthenticationError(403);
    if (request.headers.authorization) throw new PaymentAuthenticationError(401);
    const raw = request.headers.cookie;
    if (!raw || raw.length > 16384) return null;
    const cookies = raw
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v.startsWith('cb_v2_session='));
    if (cookies.length !== 1 || !/^cb_v2_session=v2s1\.[A-Za-z0-9_-]{43}$/.test(cookies[0]!))
      return null;
    const response = await fetchImpl(url, {
      headers: { cookie: cookies[0]! },
      redirect: 'error',
      signal: AbortSignal.timeout(2000),
    });
    void response.body?.cancel().catch(() => undefined);
    if (response.status === 401) return null;
    if (response.status !== 200) throw new Error('payment session could not be confirmed');
    const assertion = response.headers.get('x-combo-assertion');
    if (!assertion || assertion.length > 8192) throw new Error('payment user assertion missing');
    try {
      const { payload } = await jwtVerify(assertion, resolver, {
        issuer: options.issuer,
        audience: 'combo-payment-host',
        algorithms: ['EdDSA'],
        requiredClaims: ['sub', 'iat', 'nbf', 'exp', 'jti'],
        maxTokenAge: 900,
      });
      if (
        payload.token_use !== undefined ||
        payload.aud !== 'combo-payment-host' ||
        typeof payload.sub !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.sub) ||
        typeof payload.iat !== 'number' ||
        !Number.isSafeInteger(payload.iat) ||
        typeof payload.exp !== 'number' ||
        !Number.isSafeInteger(payload.exp) ||
        !Number.isSafeInteger(payload.nbf) ||
        typeof payload.jti !== 'string' ||
        !payload.jti ||
        payload.jti.length > 128 ||
        payload.exp - payload.iat > 900 ||
        payload.exp <= payload.iat
      )
        throw new PaymentAuthenticationError(401);
      return payload.sub;
    } catch (error) {
      if (error instanceof PaymentAuthenticationError) throw error;
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      if (
        code !== undefined &&
        ![
          'ERR_JWT_EXPIRED',
          'ERR_JWT_INVALID',
          'ERR_JWT_CLAIM_VALIDATION_FAILED',
          'ERR_JWS_INVALID',
          'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
          'ERR_JOSE_ALG_NOT_ALLOWED',
          'ERR_JOSE_NOT_SUPPORTED',
          'ERR_JWKS_NO_MATCHING_KEY',
        ].includes(String(code))
      )
        throw new Error('payment signing keys unavailable');
      if (code === undefined) throw new Error('payment signing keys unavailable');
      throw new PaymentAuthenticationError(401);
    }
  };
}
