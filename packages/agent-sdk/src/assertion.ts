// 断言验签：JWT(EdDSA)，JWKS 公钥带缓存与 kid 轮换感知（未知 kid 强制刷新一次），
// 强制 audience 等于本 Agent 的 agent_id——跨 Agent 重放在这里被拒绝。
// 断言只带身份，本模块只返回 user_id，不推断任何权益。
import { createLocalJWKSet, decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import type { JWK, KeyLike } from 'jose';

export const ASSERTION_HEADER = 'x-combo-assertion';

export type AssertionErrorCode =
  | 'missing'
  | 'malformed'
  | 'unknown_key'
  | 'invalid_signature'
  | 'wrong_audience'
  | 'expired'
  | 'invalid_claim';

export class AssertionVerificationError extends Error {
  constructor(
    readonly code: AssertionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AssertionVerificationError';
  }
}

interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

export interface JwksResolverOptions {
  jwksUrl: string;
  fetchImpl?: FetchLike;
  /** 缓存毫秒数，与 authz JWKS 端点的 cache-control 对齐，默认五分钟。 */
  cacheTtlMs?: number;
  now?: () => number;
}

export type KeyResolver = (kid: string) => Promise<KeyLike>;

/**
 * JWKS 键解析器：缓存整份 JWKS；遇到未知 kid 时强制刷新一次（轮换姿态），
 * 刷新后仍不存在才报 unknown_key。
 */
export function createJwksResolver(options: JwksResolverOptions): KeyResolver {
  // 缺省走调用时的全局 fetch（惰性查找），长生命周期进程里测试桩与运行时装配都生效。
  const fetchImpl =
    options.fetchImpl ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000;
  const now = options.now ?? (() => Date.now());

  let cache: {
    keySet: ReturnType<typeof createLocalJWKSet>;
    kids: Set<string>;
    fetchedAt: number;
  } | null = null;

  async function fetchKeySet() {
    const response = await fetchImpl(options.jwksUrl);
    if (!response.ok) {
      throw new AssertionVerificationError('unknown_key', `jwks fetch failed: ${response.status}`);
    }
    const body = (await response.json()) as { keys?: JWK[] };
    if (!Array.isArray(body.keys)) {
      throw new AssertionVerificationError('unknown_key', 'jwks document is malformed');
    }
    // importJWK 逐个预校验，坏 key 直接让整份 JWKS 失效，避免半可用缓存。
    const kids = new Set<string>();
    for (const key of body.keys) {
      if (!key.kid) throw new AssertionVerificationError('unknown_key', 'jwks key missing kid');
      await importJWK(key, 'EdDSA');
      kids.add(key.kid);
    }
    cache = { keySet: createLocalJWKSet({ keys: body.keys }), kids, fetchedAt: now() };
    return cache;
  }

  return async (kid) => {
    const fresh = cache !== null && now() - cache.fetchedAt < cacheTtlMs;
    let current = fresh ? cache! : await fetchKeySet();
    if (!current.kids.has(kid)) {
      // 未知 kid：可能是轮换，强制刷新再判一次。
      current = await fetchKeySet();
      if (!current.kids.has(kid)) {
        throw new AssertionVerificationError('unknown_key', `unknown assertion key id ${kid}`);
      }
    }
    const resolved = await current.keySet({ kid, alg: 'EdDSA' });
    return resolved as KeyLike;
  };
}

export interface VerifiedAssertion {
  userId: string;
  expiresAt: Date;
}

export interface AssertionVerifierOptions extends JwksResolverOptions {
  agentId: string;
  issuer?: string;
  resolver?: KeyResolver;
}

export interface AssertionVerifier {
  verify(token: string | undefined): Promise<VerifiedAssertion>;
  /** 从 Next.js Request / 任何带 headers 的请求对象取 x-combo-assertion 并验签。 */
  verifyRequest(request: { headers: unknown }): Promise<VerifiedAssertion>;
}

/** 从 Headers 实例或普通 header 记录（大小写不敏感）提取断言。 */
export function extractAssertion(headers: unknown): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    return headers.get(ASSERTION_HEADER) ?? undefined;
  }
  if (typeof headers === 'object') {
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      if (name.toLowerCase() !== ASSERTION_HEADER) continue;
      if (typeof value === 'string') return value;
      if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    }
  }
  return undefined;
}

function mapJoseError(error: unknown): AssertionVerificationError {
  const code = (error as { code?: string }).code;
  switch (code) {
    case 'ERR_JWT_EXPIRED':
      return new AssertionVerificationError('expired', 'assertion expired');
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      return new AssertionVerificationError('invalid_signature', 'assertion signature invalid');
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED': {
      const claim = (error as { claim?: string }).claim;
      if (claim === 'aud') {
        return new AssertionVerificationError(
          'wrong_audience',
          'assertion audience does not match this agent',
        );
      }
      return new AssertionVerificationError(
        'invalid_claim',
        `assertion claim ${claim ?? 'unknown'} rejected`,
      );
    }
    default:
      return new AssertionVerificationError(
        'invalid_claim',
        `assertion verification failed: ${(error as Error).message}`,
      );
  }
}

export function createAssertionVerifier(options: AssertionVerifierOptions): AssertionVerifier {
  const resolver = options.resolver ?? createJwksResolver(options);

  async function verify(token: string | undefined): Promise<VerifiedAssertion> {
    if (!token) {
      throw new AssertionVerificationError('missing', 'assertion header is missing');
    }
    let kid: string;
    try {
      const header = decodeProtectedHeader(token);
      if (header.alg !== 'EdDSA' || !header.kid) throw new Error('bad header');
      kid = header.kid;
    } catch {
      throw new AssertionVerificationError('malformed', 'assertion is not an EdDSA JWT with kid');
    }

    const key = await resolver(kid);
    let payload;
    try {
      const verified = await jwtVerify(token, key, {
        audience: options.agentId,
        ...(options.issuer ? { issuer: options.issuer } : {}),
      });
      payload = verified.payload;
    } catch (error) {
      throw mapJoseError(error);
    }
    if (!payload.sub) {
      throw new AssertionVerificationError('invalid_claim', 'assertion subject is missing');
    }
    return { userId: payload.sub, expiresAt: new Date((payload.exp ?? 0) * 1000) };
  }

  return {
    verify,
    async verifyRequest(request) {
      return verify(extractAssertion(request.headers));
    },
  };
}
