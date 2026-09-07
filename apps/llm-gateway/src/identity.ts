import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

export interface VerifiedGatewayIdentity {
  userId: string;
  agentId: string;
}
export interface GatewayIdentityVerifier {
  verify(
    authorization: string | undefined,
    userAssertion: string | undefined,
  ): Promise<VerifiedGatewayIdentity>;
}
export class GatewayIdentityError extends Error {
  constructor(readonly status: 401 | 403 | 503) {
    super('gateway identity verification failed');
    this.name = 'GatewayIdentityError';
  }
}

function boundedLifetime(payload: JWTPayload, maximum: number): boolean {
  return (
    typeof payload.iat === 'number' &&
    Number.isSafeInteger(payload.iat) &&
    typeof payload.exp === 'number' &&
    Number.isSafeInteger(payload.exp) &&
    typeof payload.nbf === 'number' &&
    Number.isSafeInteger(payload.nbf) &&
    payload.exp > payload.iat &&
    payload.exp - payload.iat <= maximum &&
    typeof payload.jti === 'string' &&
    payload.jti.length > 0 &&
    payload.jti.length <= 128
  );
}

export function createGatewayIdentityVerifier(options: {
  issuer: string;
  jwksUrl?: string;
  key?: JWTVerifyGetKey;
  allowHttpForTest?: boolean;
}): GatewayIdentityVerifier {
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
      throw new Error('Gateway JWKS requires a trusted HTTPS URL');
    key = createRemoteJWKSet(url, { timeoutDuration: 2000 });
  }
  if (!options.issuer) throw new Error('Gateway assertion issuer is required');
  const resolver = key;
  return {
    async verify(authorization, userAssertion) {
      if (
        !authorization?.startsWith('Bearer ') ||
        authorization.length > 8200 ||
        !userAssertion ||
        userAssertion.length > 8192
      )
        throw new GatewayIdentityError(401);
      try {
        const agent = (
          await jwtVerify(authorization.slice(7), resolver, {
            issuer: options.issuer,
            audience: 'combo-llm-gateway',
            algorithms: ['EdDSA'],
            requiredClaims: ['sub', 'iat', 'nbf', 'exp', 'jti'],
            maxTokenAge: 300,
          })
        ).payload;
        if (
          agent.token_use !== 'agent_access' ||
          typeof agent.agent_id !== 'string' ||
          !/^[a-z0-9][a-z0-9-]{0,62}$/.test(agent.agent_id) ||
          agent.sub !== agent.agent_id ||
          agent.aud !== 'combo-llm-gateway' ||
          !boundedLifetime(agent, 300)
        )
          throw new GatewayIdentityError(401);
        if (agent.scope !== 'llm:invoke') throw new GatewayIdentityError(403);
        const user = (
          await jwtVerify(userAssertion, resolver, {
            issuer: options.issuer,
            audience: agent.agent_id,
            algorithms: ['EdDSA'],
            requiredClaims: ['sub', 'iat', 'nbf', 'exp', 'jti'],
            maxTokenAge: 900,
          })
        ).payload;
        if (
          user.token_use !== undefined ||
          user.aud !== agent.agent_id ||
          typeof user.sub !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.sub) ||
          !boundedLifetime(user, 900)
        )
          throw new GatewayIdentityError(401);
        return { userId: user.sub, agentId: agent.agent_id };
      } catch (error) {
        if (error instanceof GatewayIdentityError) throw error;
        const code =
          typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
        const invalid = [
          'ERR_JWT_EXPIRED',
          'ERR_JWT_INVALID',
          'ERR_JWT_CLAIM_VALIDATION_FAILED',
          'ERR_JWS_INVALID',
          'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
          'ERR_JOSE_ALG_NOT_ALLOWED',
          'ERR_JOSE_NOT_SUPPORTED',
          'ERR_JWKS_NO_MATCHING_KEY',
        ].includes(String(code));
        throw new GatewayIdentityError(invalid ? 401 : 503);
      }
    },
  };
}
