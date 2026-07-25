// B-08 · Logto OIDC 授权码流（PKCE）辅助（10-auth §3.1/§3.2）。
//   登录流真实链路（discovery → authorize URL → code 换 token → 验 id_token）。
//   - discovery：从 {LOGTO_ISSUER}/.well-known/openid-configuration 取 authorization_endpoint / token_endpoint
//     （与 infra/logto.ts 的 ready 探针 / JWKS 取址同一文档源，铸 token 的 iss 必 == canonical LOGTO_ISSUER）。
//   - PKCE S256：code_verifier 随机串 → code_challenge = base64url(sha256(verifier))。
//   - state / nonce：CSRF 与 id_token 绑定随机串（落短时 auth_tx cookie，回调比对）。
//   - 换 token：authorization_code grant + code_verifier，client_id/secret（按 Logto app 类型，secret 可空）。
//   - 续期：offline_access + consent 换取 refresh_token；续期时使用 refresh_token grant，
//     并优先保存上游旋转后返回的最新 refresh_token。
//   - 验 id_token：复用 infra/logto.ts 的 verifyLogtoJwt（JWKS + iss + aud + exp），再在回调里比对 nonce。
//   失败一律收口为分类结果（绝不裸抛 OIDC/网络原始异常给上层，脊柱 §11.B）：上游不可达 vs 换 token 失败分开。
import { createHash, randomBytes } from 'node:crypto';
import type { Env } from '../config/env.js';

/** OIDC discovery 端点（authorize/token 取址；与 ready 探针同源文档）。 */
interface OidcEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

interface OidcDiscoveryDocument {
  issuer?: unknown;
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  end_session_endpoint?: unknown;
}

interface TrustedOidcDiscovery {
  document: OidcDiscoveryDocument;
  issuer: URL;
}

/**
 * Logto discovery 在容器网络内可能需要数秒；2s 会把仍在正常响应的上游误判为不可达。
 * 8s 仍有明确上限，同时覆盖当前 full-compose 实测约 4.6s 的冷请求。
 */
const OIDC_DISCOVERY_TIMEOUT_MS = 8_000;

function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, '');
}

function parseOidcUrl(raw: unknown, production: boolean): URL | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (production && url.protocol !== 'https:') return null;
    if (url.username || url.password || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

function canonicalIssuer(url: URL): string | null {
  if (url.search) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function parseTrustedEndpoint(raw: unknown, issuer: URL, production: boolean): string | null {
  const endpoint = parseOidcUrl(raw, production);
  if (!endpoint || endpoint.origin !== issuer.origin) return null;
  return endpoint.toString();
}

/**
 * 拉取并校验 discovery 信任根：
 *   - 文档 issuer 必须与配置的 LOGTO_ISSUER 精确对应（仅忽略尾随斜杠）；
 *   - URL 只允许无凭据的 HTTP(S)，生产模式必须 HTTPS。
 */
async function fetchTrustedOidcDiscovery(
  env: Env,
  timeoutMs: number,
): Promise<TrustedOidcDiscovery | null> {
  const production = env.NODE_ENV === 'production';
  const configuredIssuer = parseOidcUrl(env.LOGTO_ISSUER, production);
  const expectedIssuer = configuredIssuer ? canonicalIssuer(configuredIssuer) : null;
  if (!configuredIssuer || !expectedIssuer) return null;

  const discoveryUrl = `${expectedIssuer}/.well-known/openid-configuration`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(discoveryUrl, { signal: ctrl.signal, redirect: 'error' });
    if (!res.ok) return null;
    const document = (await res.json()) as OidcDiscoveryDocument;
    if (!document || typeof document !== 'object' || Array.isArray(document)) return null;

    const advertisedIssuer = parseOidcUrl(document.issuer, production);
    if (!advertisedIssuer || canonicalIssuer(advertisedIssuer) !== expectedIssuer) return null;
    return { document, issuer: configuredIssuer };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉 discovery 取 authorize/token 端点（带超时，依赖宕机快速失败、不裸挂）。
 *   - null：上游不可达 / 超时 / 非 2xx / issuer 或端点不可信 / 缺关键字段。
 */
async function fetchOidcEndpoints(
  env: Env,
  timeoutMs = OIDC_DISCOVERY_TIMEOUT_MS,
): Promise<OidcEndpoints | null> {
  const discovery = await fetchTrustedOidcDiscovery(env, timeoutMs);
  if (!discovery) return null;

  const production = env.NODE_ENV === 'production';
  const authorizationEndpoint = parseTrustedEndpoint(
    discovery.document.authorization_endpoint,
    discovery.issuer,
    production,
  );
  const tokenEndpoint = parseTrustedEndpoint(
    discovery.document.token_endpoint,
    discovery.issuer,
    production,
  );
  if (!authorizationEndpoint || !tokenEndpoint) return null;
  return { authorizationEndpoint, tokenEndpoint };
}

/** base64url 编码（无填充，PKCE / 随机串用）。 */
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 生成密码学随机 base64url 串（state / nonce / code_verifier 用）。 */
export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

/** PKCE：code_verifier → code_challenge（S256）。 */
export function pkceChallengeS256(codeVerifier: string): string {
  return base64url(createHash('sha256').update(codeVerifier).digest());
}

/** 登录短时事务（落 auth_tx cookie，回调比对 state / nonce / 用 code_verifier 换 token）。 */
export interface AuthTx {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** 回跳站内路径（白名单校验后存；缺省 /tasks）。 */
  returnTo: string;
}

const RETURN_TO_ORIGIN = 'https://combo.invalid';
const MAX_RETURN_TO_DECODE_PASSES = 5;

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function unsafeReturnToCandidate(value: string): boolean {
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    hasControlCharacter(value)
  ) {
    return true;
  }
  try {
    const target = new URL(value, RETURN_TO_ORIGIN);
    return target.origin !== RETURN_TO_ORIGIN || target.pathname.startsWith('//');
  } catch {
    return true;
  }
}

/**
 * returnTo 白名单：只返回规范化的同源 path + query。递归检查解码副本，避免下游再次
 * 解码时把协议相对地址、反斜杠或控制字符还原出来；fragment 不进入登录事务 Cookie。
 */
export function sanitizeReturnTo(raw: string | undefined): string {
  const fallback = '/tasks'; // 当前创作端首页；不把认证回跳依赖在兼容别名上。
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return fallback;
  if (unsafeReturnToCandidate(raw)) return fallback;

  let decoded = raw;
  let stabilized = false;
  for (let pass = 0; pass < MAX_RETURN_TO_DECODE_PASSES; pass += 1) {
    if (unsafeReturnToCandidate(decoded)) return fallback;
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return fallback;
    }
    if (next === decoded) {
      stabilized = true;
      break;
    }
    decoded = next;
  }
  if (!stabilized || unsafeReturnToCandidate(decoded)) return fallback;

  try {
    const target = new URL(raw, RETURN_TO_ORIGIN);
    const normalized = `${target.pathname}${target.search}`;
    return normalized.length <= 512 && !unsafeReturnToCandidate(normalized) ? normalized : fallback;
  } catch {
    return fallback;
  }
}

/** 构建授权 URL 的入参。 */
export interface BuildAuthorizeUrlInput {
  env: Env;
  state: string;
  nonce: string;
  codeChallenge: string;
  /** 透传给 Logto 的首选登录方式提示（可选）。 */
  prompt?: string;
}

/**
 * Logto 默认只在明确 consent 时为 offline_access 签发 refresh token
 * （除非租户开启 Always issue refresh token）。调用方可追加 login 等 prompt，
 * 但不能用 none 取消 consent，否则刷新链路会随租户配置而失效。
 */
function promptWithConsent(raw: string | undefined): string {
  const prompts = (raw ?? '')
    .split(/\s+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value !== 'none');
  if (!prompts.includes('consent')) prompts.push('consent');
  return [...new Set(prompts)].join(' ');
}

/**
 * 构建 Logto 授权 URL（10-auth §3.1）。
 *   - 取 discovery 的 authorization_endpoint；scope = openid profile email roles offline_access。
 *   - prompt 必含 consent，确保 Logto 在未开启 Always issue refresh token 时也签发 refresh token。
 *   - client_id = LOGTO_APP_ID、redirect_uri = LOGTO_REDIRECT_URI、PKCE S256。
 * 返回 null = 上游不可达（discovery 拉不到）；调用方据此 503/escalate（不在 login 暴露内部错）。
 */
export async function buildAuthorizeUrl(input: BuildAuthorizeUrlInput): Promise<string | null> {
  const { env, state, nonce, codeChallenge } = input;
  const endpoints = await fetchOidcEndpoints(env);
  if (!endpoints) return null;
  try {
    const url = new URL(endpoints.authorizationEndpoint);
    const params = url.searchParams;
    params.set('client_id', env.LOGTO_APP_ID);
    params.set('redirect_uri', env.LOGTO_REDIRECT_URI);
    params.set('response_type', 'code');
    // openid profile email = 基础身份；roles = 角色 claim；offline_access = 可续期会话。
    params.set('scope', 'openid profile email roles offline_access');
    // API resource indicator（配了才带）：使铸出的 access_token aud 含本服务，供 §4.1 校 aud。
    if (env.LOGTO_AUDIENCE) params.set('resource', env.LOGTO_AUDIENCE);
    params.set('state', state);
    params.set('nonce', nonce);
    params.set('code_challenge', codeChallenge);
    params.set('code_challenge_method', 'S256');
    params.set('prompt', promptWithConsent(input.prompt));
    return url.toString();
  } catch {
    return null;
  }
}

/** code 换 token 的分类结果（绝不裸抛 OIDC/网络原始异常，脊柱 §11.B）。 */
export type TokenExchangeResult =
  | { kind: 'ok'; accessToken: string; idToken: string | null; refreshToken: string | null }
  | { kind: 'failed' } // code 无效 / 换 token 被拒（4xx）→ AUTH_CALLBACK_FAILED
  | { kind: 'upstream_unavailable' }; // token 端点不可达 / 超时 / 5xx → AUTH_UPSTREAM_UNAVAILABLE

/**
 * 用授权码 + code_verifier 向 Logto token 端点换 token（10-auth §3.2 步 2）。
 *   - grant_type=authorization_code，带 client_id（+ 可选 client_secret）、redirect_uri、code_verifier。
 *   - 区分「换 token 失败（code 无效 / 客户端凭据不符）」与「上游不可达（网络 / 5xx）」（Codex#3 同口径）。
 */
export async function exchangeCodeForToken(
  env: Env,
  code: string,
  codeVerifier: string,
  timeoutMs = 4_000,
): Promise<TokenExchangeResult> {
  const endpoints = await fetchOidcEndpoints(env);
  if (!endpoints) return { kind: 'upstream_unavailable' };

  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', code);
  body.set('redirect_uri', env.LOGTO_REDIRECT_URI);
  body.set('client_id', env.LOGTO_APP_ID);
  body.set('code_verifier', codeVerifier);
  if (env.LOGTO_AUDIENCE) body.set('resource', env.LOGTO_AUDIENCE);
  // 机密客户端：带 client_secret（公共客户端 secret 为空则不带，靠 PKCE）。
  if (env.LOGTO_APP_SECRET) body.set('client_secret', env.LOGTO_APP_SECRET);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoints.tokenEndpoint, {
      method: 'POST',
      // Never replay authorization material to a redirect target, even if a trusted-origin token
      // endpoint is misconfigured to emit a 307/308 response.
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: ctrl.signal,
    });
    if (res.status >= 500 || res.status === 408 || res.status === 429) {
      return { kind: 'upstream_unavailable' };
    }
    if (!res.ok) return { kind: 'failed' }; // 4xx：code 无效 / 凭据不符 → 换 token 失败
    const json = (await res.json()) as {
      access_token?: unknown;
      id_token?: unknown;
      refresh_token?: unknown;
    };
    if (typeof json.access_token !== 'string' || !json.access_token) return { kind: 'failed' };
    return {
      kind: 'ok',
      accessToken: json.access_token,
      idToken: typeof json.id_token === 'string' ? json.id_token : null,
      refreshToken:
        typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : null,
    };
  } catch {
    // 网络异常 / 超时 / abort → 上游不可达（区分 token 无效，Codex#3）。
    return { kind: 'upstream_unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

/** refresh_token grant 的分类结果；不保留、不返回上游错误体。 */
export type RefreshTokenResult =
  | { kind: 'ok'; accessToken: string; refreshToken: string | null }
  | { kind: 'invalid_grant' }
  | { kind: 'upstream_unavailable' };

const REFRESH_RESULT_TTL_MS = 10_000;
const REFRESH_RESULT_CACHE_MAX = 256;
type RefreshCacheEntry = { expiresAt: number; promise: Promise<RefreshTokenResult> };
const refreshResultCache = new Map<string, RefreshCacheEntry>();

function refreshCacheKey(env: Env, refreshToken: string): string {
  return createHash('sha256')
    .update(normalizeIssuer(env.LOGTO_ISSUER))
    .update('\0')
    .update(env.LOGTO_APP_ID)
    .update('\0')
    .update(env.LOGTO_AUDIENCE ?? '')
    .update('\0')
    .update(env.LOGTO_APP_SECRET ?? '')
    .update('\0')
    .update(refreshToken)
    .digest('hex');
}

/** 测试隔离；生产请求不调用。 */
export function clearRefreshTokenExchangeCache(): void {
  refreshResultCache.clear();
}

/**
 * 用 HttpOnly Cookie 中的 refresh token 向 Logto 换新 access token。
 *
 * Logto 会旋转 refresh token，因此上游若返新值必须由调用方覆盖旧值；
 * 若未返新值，返 null 让调用方继续保留已验证可用的旧 refresh token。
 */
async function performRefreshAccessToken(
  env: Env,
  refreshToken: string,
  timeoutMs = 12_000,
): Promise<RefreshTokenResult> {
  const endpoints = await fetchOidcEndpoints(env);
  if (!endpoints) return { kind: 'upstream_unavailable' };

  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', refreshToken);
  body.set('client_id', env.LOGTO_APP_ID);
  if (env.LOGTO_AUDIENCE) body.set('resource', env.LOGTO_AUDIENCE);
  if (env.LOGTO_APP_SECRET) body.set('client_secret', env.LOGTO_APP_SECRET);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoints.tokenEndpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: ctrl.signal,
    });
    if (res.status >= 500 || res.status === 408 || res.status === 429) {
      return { kind: 'upstream_unavailable' };
    }
    if (!res.ok) {
      // OAuth 只有 invalid_grant 能证明 refresh token 本身失效。
      // invalid_client / invalid_scope / invalid_request 等属配置或上游错误，不得踢用户。
      let oauthError: unknown;
      try {
        oauthError = ((await res.json()) as { error?: unknown }).error;
      } catch {
        oauthError = undefined;
      }
      return oauthError === 'invalid_grant'
        ? { kind: 'invalid_grant' }
        : { kind: 'upstream_unavailable' };
    }

    const json = (await res.json()) as { access_token?: unknown; refresh_token?: unknown };
    if (typeof json.access_token !== 'string' || !json.access_token) {
      return { kind: 'upstream_unavailable' };
    }
    return {
      kind: 'ok',
      accessToken: json.access_token,
      refreshToken:
        typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : null,
    };
  } catch {
    return { kind: 'upstream_unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 同一实例内对同一个 refresh token 做 single-flight，并短暂复用结果。
 * 这覆盖多标签页几乎同时提交旧旋转 token 的常见窗口；token 只以 SHA-256 摘要作 key。
 */
export function refreshAccessToken(
  env: Env,
  refreshToken: string,
  timeoutMs = 12_000,
): Promise<RefreshTokenResult> {
  const now = Date.now();
  for (const [key, entry] of refreshResultCache) {
    if (entry.expiresAt <= now) refreshResultCache.delete(key);
  }

  const key = refreshCacheKey(env, refreshToken);
  const existing = refreshResultCache.get(key);
  if (existing && existing.expiresAt > now) return existing.promise;

  const entry: RefreshCacheEntry = { expiresAt: Number.POSITIVE_INFINITY, promise: undefined! };
  entry.promise = performRefreshAccessToken(env, refreshToken, timeoutMs).finally(() => {
    entry.expiresAt = Date.now() + REFRESH_RESULT_TTL_MS;
  });
  refreshResultCache.set(key, entry);

  if (refreshResultCache.size > REFRESH_RESULT_CACHE_MAX) {
    const oldest = refreshResultCache.keys().next().value as string | undefined;
    if (oldest && oldest !== key) refreshResultCache.delete(oldest);
  }
  return entry.promise;
}

/**
 * RP-Initiated Logout URL（10-auth §3.3，可选）：取 discovery 的 end_session_endpoint，
 * 拼 client_id + post_logout_redirect_uri（回站内 /login）。拉不到则返 null（仅清本地会话，不强求跳 Logto）。
 */
export async function buildLogoutUrl(env: Env, timeoutMs = 1_500): Promise<string | null> {
  const discovery = await fetchTrustedOidcDiscovery(env, timeoutMs);
  if (!discovery) return null;
  const endpoint = parseTrustedEndpoint(
    discovery.document.end_session_endpoint,
    discovery.issuer,
    env.NODE_ENV === 'production',
  );
  if (!endpoint) return null;

  try {
    const url = new URL(endpoint);
    const postLogoutRedirect = new URL('/login', env.LOGTO_REDIRECT_URI);
    url.searchParams.set('client_id', env.LOGTO_APP_ID);
    url.searchParams.set('post_logout_redirect_uri', postLogoutRedirect.toString());
    return url.toString();
  } catch {
    return null;
  }
}

/** 从 id_token JWT 取 nonce claim（不验签，仅取值供回调比对；验签走 verifyLogtoJwt）。 */
export function readNonceFromIdToken(idToken: string): string | null {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const payloadPart = parts[1];
    if (!payloadPart) return null;
    const json = Buffer.from(payloadPart, 'base64url').toString('utf8');
    const payload = JSON.parse(json) as { nonce?: unknown };
    return typeof payload.nonce === 'string' ? payload.nonce : null;
  } catch {
    return null;
  }
}
