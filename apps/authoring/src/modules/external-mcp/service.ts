import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  EXTERNAL_MCP_PATH,
  MCP_ACCESS_TOKEN_PATTERN,
  MCP_ACCESS_TOKEN_TTL_SECONDS,
  MCP_AUTHORIZATION_CODE_PATTERN,
  MCP_AUTHORIZATION_CODE_TTL_SECONDS,
  MCP_AUTHORIZATION_REQUEST_PATTERN,
  MCP_AUTHORIZATION_REQUEST_TTL_SECONDS,
  MCP_CLIENT_ID_PATTERN,
  MCP_OAUTH_DEFAULT_SCOPE,
  MCP_OAUTH_SCOPES,
  MCP_REFRESH_TOKEN_PATTERN,
  MCP_REFRESH_TOKEN_TTL_SECONDS,
  OAuthDynamicClientRegistrationRequestSchema,
  PKCE_S256_CHALLENGE_PATTERN,
  PKCE_VERIFIER_PATTERN,
  type McpOAuthScope,
  type OAuthDynamicClientRegistrationRequest,
  type OAuthDynamicClientRegistrationResponse,
  type OAuthTokenResponse,
} from '@cb/shared';
import type { Queryable } from '../../platform/infra/db.js';
import type { TxPool } from '../../platform/infra/db-tx.js';
import {
  cleanupExpiredOAuthArtifacts,
  completeAuthorizationRequest,
  exchangeAuthorizationCode,
  insertAuthorizationRequest,
  registerOAuthClient,
  readAuthorizationRequest,
  readOAuthClient,
  resolveAccessToken,
  rotateRefreshToken,
  type AccessTokenResolution,
  type AuthorizationRequestRecord,
  type McpPrincipal,
} from './repo.js';

const TOKEN_BYTES = 32;
const MAX_STATE_LENGTH = 1_024;
const OAUTH_CLEANUP_INTERVAL_MS = 60_000;
const OAUTH_CLEANUP_BATCH_SIZE = 100;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);

/**
 * 每个 API 进程至多每分钟触发一次 DB 侧有界清理。同步占领时间窗发生在 await 前，
 * 因而同进程并发 authorize 请求只会有一个调用清理函数。
 */
export function createOAuthCleanupScheduler(
  intervalMs = OAUTH_CLEANUP_INTERVAL_MS,
  batchSize = OAUTH_CLEANUP_BATCH_SIZE,
): (db: Queryable, nowMs?: number) => Promise<boolean> {
  let nextCleanupAt = 0;
  return async (db, nowMs = Date.now()) => {
    if (nowMs < nextCleanupAt) return false;
    nextCleanupAt = nowMs + intervalMs;
    await cleanupExpiredOAuthArtifacts(db, batchSize);
    return true;
  };
}

export function externalMcpResourceUri(publicOrigin: string): string {
  return `${publicOrigin}${EXTERNAL_MCP_PATH}`;
}

export function secretDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'ascii').digest();
}

function randomSecret(prefix: string): string {
  return `${prefix}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

function canonicalLoopbackRedirectUri(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'http:' ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    return null;
  }
  return url.toString();
}

function loopbackRedirectRegistrationIdentity(value: string): string | null {
  const canonical = canonicalLoopbackRedirectUri(value);
  if (!canonical) return null;
  const url = new URL(canonical);
  // RFC 8252 允许授权时端口变化；DCR identity 也必须忽略临时监听端口。
  url.port = '';
  return url.toString();
}

export function dynamicClientRegistrationDigest(input: {
  clientName: string;
  redirectUris: readonly string[];
  grantTypes: readonly string[];
  responseTypes: readonly string[];
  tokenEndpointAuthMethod: string;
}): Buffer {
  const redirectIdentities = input.redirectUris.map(loopbackRedirectRegistrationIdentity);
  if (redirectIdentities.some((identity) => identity === null)) {
    throw new Error('registration digest received an invalid redirect URI');
  }
  const canonical = JSON.stringify({
    clientName: input.clientName,
    redirectUris: (redirectIdentities as string[]).toSorted(),
    grantTypes: [...input.grantTypes].toSorted(),
    responseTypes: [...input.responseTypes].toSorted(),
    tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
  });
  return createHash('sha256').update(canonical, 'utf8').digest();
}

/** RFC 8252 loopback redirect 只允许端口在注册与授权间变化。 */
export function matchesRegisteredLoopbackRedirect(
  candidate: string,
  registeredUris: readonly string[],
): boolean {
  const canonicalCandidate = canonicalLoopbackRedirectUri(candidate);
  if (!canonicalCandidate) return false;
  const actual = new URL(canonicalCandidate);
  return registeredUris.some((registered) => {
    const canonicalRegistered = canonicalLoopbackRedirectUri(registered);
    if (!canonicalRegistered) return false;
    const expected = new URL(canonicalRegistered);
    return (
      actual.protocol === expected.protocol &&
      actual.hostname === expected.hostname &&
      actual.pathname === expected.pathname &&
      actual.search === expected.search
    );
  });
}

function normalizeRequestedScope(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return MCP_OAUTH_DEFAULT_SCOPE;
  const values = value.split(' ').filter(Boolean);
  if (values.length === 0 || new Set(values).size !== values.length) return null;
  if (!values.includes('combo.agent:read')) return null;
  if (values.some((scope) => !MCP_OAUTH_SCOPES.includes(scope as McpOAuthScope))) return null;
  return MCP_OAUTH_SCOPES.filter((scope) => values.includes(scope)).join(' ');
}

export type RegisterClientOutcome =
  | { kind: 'registered'; response: OAuthDynamicClientRegistrationResponse }
  | { kind: 'invalid_request' }
  | { kind: 'capacity_exceeded' };

export async function registerDynamicClient(
  db: Queryable,
  raw: unknown,
): Promise<RegisterClientOutcome> {
  const parsed = OAuthDynamicClientRegistrationRequestSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'invalid_request' };
  const request: OAuthDynamicClientRegistrationRequest = parsed.data;
  const redirectUris = request.redirect_uris.map(canonicalLoopbackRedirectUri);
  const redirectIdentities = request.redirect_uris.map(loopbackRedirectRegistrationIdentity);
  if (
    redirectUris.some((uri) => uri === null) ||
    redirectIdentities.some((identity) => identity === null) ||
    new Set(redirectIdentities).size !== redirectIdentities.length
  ) {
    return { kind: 'invalid_request' };
  }
  const requestedGrantTypes = request.grant_types ?? ['authorization_code', 'refresh_token'];
  if (
    requestedGrantTypes.length !== 2 ||
    new Set(requestedGrantTypes).size !== 2 ||
    !requestedGrantTypes.includes('authorization_code') ||
    !requestedGrantTypes.includes('refresh_token')
  ) {
    return { kind: 'invalid_request' };
  }
  const grantTypes: Array<'authorization_code' | 'refresh_token'> = [
    'authorization_code',
    'refresh_token',
  ];
  const clientName = request.client_name ?? 'Codex';
  const responseTypes: ['code'] = ['code'];
  const tokenEndpointAuthMethod = 'none' as const;
  const clientId = randomSecret('mcp_client_');
  const registered = await registerOAuthClient(db, {
    clientId,
    registrationDigest: dynamicClientRegistrationDigest({
      clientName,
      redirectUris: redirectUris as string[],
      grantTypes,
      responseTypes,
      tokenEndpointAuthMethod,
    }),
    clientName,
    redirectUris: redirectUris as string[],
    grantTypes,
    responseTypes,
    tokenEndpointAuthMethod,
  });
  if (registered.kind === 'capacity_exceeded') return registered;
  const client = registered.client;
  return {
    kind: 'registered',
    response: {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1_000),
      redirect_uris: client.redirectUris,
      client_name: client.clientName,
      grant_types: client.grantTypes,
      response_types: client.responseTypes,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    },
  };
}

export interface BeginAuthorizationInput {
  responseType?: string;
  clientId?: string;
  redirectUri?: string;
  scope?: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  resource?: string;
}

export type BeginAuthorizationOutcome =
  | { kind: 'created'; requestToken: string }
  | { kind: 'invalid_request' }
  | { kind: 'invalid_client' }
  | { kind: 'invalid_scope' };

export async function beginAuthorization(
  db: Queryable,
  input: BeginAuthorizationInput,
  expectedResourceUri: string,
): Promise<BeginAuthorizationOutcome> {
  if (!input.clientId || !MCP_CLIENT_ID_PATTERN.test(input.clientId)) {
    return { kind: 'invalid_client' };
  }
  const client = await readOAuthClient(db, input.clientId);
  if (!client) return { kind: 'invalid_client' };
  if (
    input.responseType !== 'code' ||
    !input.redirectUri ||
    !matchesRegisteredLoopbackRedirect(input.redirectUri, client.redirectUris) ||
    !input.state ||
    input.state.length > MAX_STATE_LENGTH ||
    input.resource !== expectedResourceUri ||
    input.codeChallengeMethod !== 'S256' ||
    !input.codeChallenge ||
    !PKCE_S256_CHALLENGE_PATTERN.test(input.codeChallenge)
  ) {
    return { kind: 'invalid_request' };
  }
  const scope = normalizeRequestedScope(input.scope);
  if (!scope) return { kind: 'invalid_scope' };

  const requestToken = randomSecret('mar1.');
  await insertAuthorizationRequest(db, {
    requestDigest: secretDigest(requestToken),
    clientId: client.clientId,
    redirectUri: input.redirectUri,
    state: input.state,
    scope,
    resourceUri: expectedResourceUri,
    codeChallenge: input.codeChallenge,
    ttlSeconds: MCP_AUTHORIZATION_REQUEST_TTL_SECONDS,
  });
  return { kind: 'created', requestToken };
}

export async function getPendingAuthorization(
  db: Queryable,
  requestToken: string | undefined,
): Promise<AuthorizationRequestRecord | null> {
  if (!requestToken || !MCP_AUTHORIZATION_REQUEST_PATTERN.test(requestToken)) return null;
  const request = await readAuthorizationRequest(db, secretDigest(requestToken));
  if (!request || request.consumedAt !== null || request.expiresAt.getTime() <= Date.now()) {
    return null;
  }
  return request;
}

export type DecideAuthorizationOutcome =
  | { kind: 'approved'; redirectUrl: string }
  | { kind: 'denied'; redirectUrl: string }
  | { kind: 'invalid' };

function appendAuthorizationResponse(redirectUri: string, values: Record<string, string>): string {
  const redirect = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) redirect.searchParams.set(key, value);
  return redirect.toString();
}

export async function decideAuthorization(
  pool: TxPool,
  input: { requestToken: string; decision: 'approve' | 'deny'; ownerUserId: string },
): Promise<DecideAuthorizationOutcome> {
  if (!MCP_AUTHORIZATION_REQUEST_PATTERN.test(input.requestToken)) return { kind: 'invalid' };
  const code = input.decision === 'approve' ? randomSecret('mac1.') : undefined;
  const completed = await completeAuthorizationRequest(pool, {
    requestDigest: secretDigest(input.requestToken),
    decision: input.decision,
    ownerUserId: input.ownerUserId,
    ...(code ? { codeDigest: secretDigest(code) } : {}),
    codeTtlSeconds: MCP_AUTHORIZATION_CODE_TTL_SECONDS,
  });
  if (completed.kind === 'invalid') return completed;
  if (completed.kind === 'denied') {
    return {
      kind: 'denied',
      redirectUrl: appendAuthorizationResponse(completed.redirectUri, {
        error: 'access_denied',
        state: completed.state,
      }),
    };
  }
  if (!code) throw new Error('approved authorization lost code');
  return {
    kind: 'approved',
    redirectUrl: appendAuthorizationResponse(completed.redirectUri, {
      code,
      state: completed.state,
    }),
  };
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function tokenPair(scope: string): {
  accessToken: string;
  refreshToken: string;
  response: OAuthTokenResponse;
} {
  const accessToken = randomSecret('mat1.');
  const refreshToken = randomSecret('mrt1.');
  return {
    accessToken,
    refreshToken,
    response: {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: MCP_ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope,
    },
  };
}

export type TokenOutcome =
  | { kind: 'issued'; response: OAuthTokenResponse }
  | {
      kind: 'invalid_request' | 'invalid_client' | 'invalid_grant' | 'unsupported_grant_type';
    };

export async function issueTokens(
  pool: TxPool,
  form: URLSearchParams,
  expectedResourceUri: string,
): Promise<TokenOutcome> {
  for (const parameter of [
    'grant_type',
    'client_id',
    'code',
    'redirect_uri',
    'code_verifier',
    'refresh_token',
    'scope',
  ]) {
    if (form.getAll(parameter).length > 1) return { kind: 'invalid_request' };
  }
  if (form.has('client_secret')) return { kind: 'invalid_client' };
  const grantType = form.get('grant_type');
  const clientId = form.get('client_id');
  const resources = form.getAll('resource');
  if (!clientId || !MCP_CLIENT_ID_PATTERN.test(clientId)) return { kind: 'invalid_client' };
  if (resources.length === 0 || resources.some((resource) => resource !== expectedResourceUri)) {
    return { kind: 'invalid_request' };
  }

  if (grantType === 'authorization_code') {
    const code = form.get('code');
    const redirectUri = form.get('redirect_uri');
    const verifier = form.get('code_verifier');
    if (
      !code ||
      !MCP_AUTHORIZATION_CODE_PATTERN.test(code) ||
      !redirectUri ||
      !verifier ||
      !PKCE_VERIFIER_PATTERN.test(verifier)
    ) {
      return { kind: 'invalid_request' };
    }
    const pair = tokenPair(MCP_OAUTH_DEFAULT_SCOPE);
    const exchanged = await exchangeAuthorizationCode(pool, {
      codeDigest: secretDigest(code),
      expectedCodeChallenge: pkceChallenge(verifier),
      clientId,
      redirectUri,
      resourceUri: expectedResourceUri,
      accessTokenDigest: secretDigest(pair.accessToken),
      refreshTokenDigest: secretDigest(pair.refreshToken),
      familyId: randomUUID(),
      accessTokenTtlSeconds: MCP_ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlSeconds: MCP_REFRESH_TOKEN_TTL_SECONDS,
    });
    if (exchanged.kind !== 'issued') return { kind: 'invalid_grant' };
    pair.response.scope = exchanged.scope;
    return { kind: 'issued', response: pair.response };
  }

  if (grantType === 'refresh_token') {
    const refreshToken = form.get('refresh_token');
    if (!refreshToken || !MCP_REFRESH_TOKEN_PATTERN.test(refreshToken)) {
      return { kind: 'invalid_request' };
    }
    const pair = tokenPair(MCP_OAUTH_DEFAULT_SCOPE);
    const rotated = await rotateRefreshToken(pool, {
      refreshTokenDigest: secretDigest(refreshToken),
      clientId,
      resourceUri: expectedResourceUri,
      nextAccessTokenDigest: secretDigest(pair.accessToken),
      nextRefreshTokenDigest: secretDigest(pair.refreshToken),
      accessTokenTtlSeconds: MCP_ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlSeconds: MCP_REFRESH_TOKEN_TTL_SECONDS,
    });
    if (rotated.kind !== 'issued') return { kind: 'invalid_grant' };
    pair.response.scope = rotated.scope;
    return { kind: 'issued', response: pair.response };
  }

  return grantType ? { kind: 'unsupported_grant_type' } : { kind: 'invalid_request' };
}

export async function resolveMcpBearer(
  db: Queryable,
  authorizationHeader: string | undefined,
  expectedResourceUri: string,
): Promise<AccessTokenResolution> {
  if (!authorizationHeader) return { kind: 'invalid' };
  const match = authorizationHeader.match(/^Bearer ([^\s]+)$/iu);
  const token = match?.[1];
  if (!token || !MCP_ACCESS_TOKEN_PATTERN.test(token)) return { kind: 'invalid' };
  return resolveAccessToken(db, {
    tokenDigest: secretDigest(token),
    resourceUri: expectedResourceUri,
  });
}

export function hasMcpScope(principal: McpPrincipal, scope: McpOAuthScope): boolean {
  return principal.scopes.includes(scope);
}
