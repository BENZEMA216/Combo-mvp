import { RoleSchema, type McpOAuthScope } from '@cb/shared';
import type { Queryable } from '../../platform/infra/db.js';
import { withTransaction, type TxPool } from '../../platform/infra/db-tx.js';

export interface OAuthClientRecord {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: Array<'authorization_code' | 'refresh_token'>;
  responseTypes: ['code'];
  tokenEndpointAuthMethod: 'none';
  createdAt: Date;
}

interface OAuthClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: Array<'authorization_code' | 'refresh_token'>;
  response_types: ['code'];
  token_endpoint_auth_method: 'none';
  created_at: Date;
}

function toClient(row: OAuthClientRow): OAuthClientRecord {
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUris: row.redirect_uris,
    grantTypes: row.grant_types,
    responseTypes: row.response_types,
    tokenEndpointAuthMethod: row.token_endpoint_auth_method,
    createdAt: row.created_at,
  };
}

export type RegisterOAuthClientOutcome =
  | { kind: 'registered'; client: OAuthClientRecord }
  | { kind: 'capacity_exceeded' };

/**
 * 动态 client 的唯一写入口。数据库函数在全局事务 advisory lock 内完成 digest 复用、
 * 安全淘汰、硬容量检查与插入；API role 没有 oauth_clients 的直接 INSERT/DELETE 权限。
 */
export async function registerOAuthClient(
  db: Queryable,
  input: Omit<OAuthClientRecord, 'createdAt'> & { registrationDigest: Buffer },
): Promise<RegisterOAuthClientOutcome> {
  const result = await db.query<OAuthClientRow & { registration_status: string }>(
    `SELECT registration_status, client_id, client_name, redirect_uris, grant_types,
            response_types, token_endpoint_auth_method, created_at
       FROM register_oauth_client($1, $2, $3, $4::text[], $5::text[], $6::text[], $7)`,
    [
      input.clientId,
      input.registrationDigest,
      input.clientName,
      input.redirectUris,
      input.grantTypes,
      input.responseTypes,
      input.tokenEndpointAuthMethod,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('oauth client registration returned no row');
  if (row.registration_status === 'capacity_exceeded') return { kind: 'capacity_exceeded' };
  if (row.registration_status !== 'registered' || !row.client_id) {
    throw new Error('oauth client registration returned an invalid result');
  }
  return { kind: 'registered', client: toClient(row) };
}

export async function readOAuthClient(
  db: Queryable,
  clientId: string,
): Promise<OAuthClientRecord | null> {
  const result = await db.query<OAuthClientRow>(
    `UPDATE oauth_clients
        SET last_used_at = now()
      WHERE client_id = $1
      RETURNING client_id, client_name, redirect_uris, grant_types, response_types,
                token_endpoint_auth_method, created_at`,
    [clientId],
  );
  const row = result.rows[0];
  return row ? toClient(row) : null;
}

export interface AuthorizationRequestRecord {
  requestDigest: Buffer;
  clientId: string;
  clientName: string;
  redirectUri: string;
  state: string;
  scope: string;
  resourceUri: string;
  codeChallenge: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

interface AuthorizationRequestRow {
  request_digest: Buffer;
  client_id: string;
  client_name: string;
  redirect_uri: string;
  state: string;
  scope: string;
  resource_uri: string;
  code_challenge: string;
  expires_at: Date;
  consumed_at: Date | null;
}

function toAuthorizationRequest(row: AuthorizationRequestRow): AuthorizationRequestRecord {
  return {
    requestDigest: row.request_digest,
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUri: row.redirect_uri,
    state: row.state,
    scope: row.scope,
    resourceUri: row.resource_uri,
    codeChallenge: row.code_challenge,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

export async function insertAuthorizationRequest(
  db: Queryable,
  input: {
    requestDigest: Buffer;
    clientId: string;
    redirectUri: string;
    state: string;
    scope: string;
    resourceUri: string;
    codeChallenge: string;
    ttlSeconds: number;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO oauth_authorization_requests
       (request_digest, client_id, redirect_uri, state, scope, resource_uri,
        code_challenge, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + $8 * interval '1 second')`,
    [
      input.requestDigest,
      input.clientId,
      input.redirectUri,
      input.state,
      input.scope,
      input.resourceUri,
      input.codeChallenge,
      input.ttlSeconds,
    ],
  );
}

export async function readAuthorizationRequest(
  db: Queryable,
  requestDigest: Buffer,
): Promise<AuthorizationRequestRecord | null> {
  const result = await db.query<AuthorizationRequestRow>(
    `SELECT r.request_digest, r.client_id, c.client_name, r.redirect_uri, r.state,
            r.scope, r.resource_uri, r.code_challenge, r.expires_at, r.consumed_at
       FROM oauth_authorization_requests r
       JOIN oauth_clients c ON c.client_id = r.client_id
      WHERE r.request_digest = $1`,
    [requestDigest],
  );
  const row = result.rows[0];
  return row ? toAuthorizationRequest(row) : null;
}

export type CompleteAuthorizationOutcome =
  | { kind: 'approved'; redirectUri: string; state: string }
  | { kind: 'denied'; redirectUri: string; state: string }
  | { kind: 'invalid' };

export async function completeAuthorizationRequest(
  pool: TxPool,
  input: {
    requestDigest: Buffer;
    decision: 'approve' | 'deny';
    ownerUserId: string;
    codeDigest?: Buffer;
    codeTtlSeconds: number;
  },
): Promise<CompleteAuthorizationOutcome> {
  return withTransaction(pool, async (tx) => {
    const selected = await tx.query<AuthorizationRequestRow>(
      `SELECT r.request_digest, r.client_id, c.client_name, r.redirect_uri, r.state,
              r.scope, r.resource_uri, r.code_challenge, r.expires_at, r.consumed_at
         FROM oauth_authorization_requests r
         JOIN oauth_clients c ON c.client_id = r.client_id
        WHERE r.request_digest = $1
        FOR UPDATE OF r`,
      [input.requestDigest],
    );
    const row = selected.rows[0];
    if (!row || row.consumed_at !== null || new Date(row.expires_at).getTime() <= Date.now()) {
      return { kind: 'invalid' };
    }

    await tx.query(
      `UPDATE oauth_authorization_requests
          SET consumed_at = now()
        WHERE request_digest = $1`,
      [input.requestDigest],
    );
    if (input.decision === 'deny') {
      return { kind: 'denied', redirectUri: row.redirect_uri, state: row.state };
    }
    if (!input.codeDigest) throw new Error('approved authorization requires a code digest');

    await tx.query(
      `INSERT INTO oauth_authorization_codes
         (code_digest, client_id, owner_user_id, redirect_uri, scope, resource_uri,
          code_challenge, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + $8 * interval '1 second')`,
      [
        input.codeDigest,
        row.client_id,
        input.ownerUserId,
        row.redirect_uri,
        row.scope,
        row.resource_uri,
        row.code_challenge,
        input.codeTtlSeconds,
      ],
    );
    return { kind: 'approved', redirectUri: row.redirect_uri, state: row.state };
  });
}

interface AuthorizationCodeRow {
  client_id: string;
  owner_user_id: string;
  redirect_uri: string;
  scope: string;
  resource_uri: string;
  code_challenge: string;
  expires_at: Date;
  used_at: Date | null;
}

export type ExchangeCodeOutcome = { kind: 'issued'; scope: string } | { kind: 'invalid_grant' };

export async function exchangeAuthorizationCode(
  pool: TxPool,
  input: {
    codeDigest: Buffer;
    expectedCodeChallenge: string;
    clientId: string;
    redirectUri: string;
    resourceUri: string;
    accessTokenDigest: Buffer;
    refreshTokenDigest: Buffer;
    familyId: string;
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
  },
): Promise<ExchangeCodeOutcome> {
  return withTransaction(pool, async (tx) => {
    const selected = await tx.query<AuthorizationCodeRow>(
      `SELECT client_id, owner_user_id, redirect_uri, scope, resource_uri,
              code_challenge, expires_at, used_at
         FROM oauth_authorization_codes
        WHERE code_digest = $1
        FOR UPDATE`,
      [input.codeDigest],
    );
    const row = selected.rows[0];
    if (
      !row ||
      row.used_at !== null ||
      new Date(row.expires_at).getTime() <= Date.now() ||
      row.client_id !== input.clientId ||
      row.redirect_uri !== input.redirectUri ||
      row.resource_uri !== input.resourceUri ||
      row.code_challenge !== input.expectedCodeChallenge
    ) {
      return { kind: 'invalid_grant' };
    }

    await tx.query(`UPDATE oauth_authorization_codes SET used_at = now() WHERE code_digest = $1`, [
      input.codeDigest,
    ]);
    await tx.query(
      `INSERT INTO oauth_access_tokens
         (token_digest, client_id, owner_user_id, family_id, scope, resource_uri, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + $7 * interval '1 second')`,
      [
        input.accessTokenDigest,
        row.client_id,
        row.owner_user_id,
        input.familyId,
        row.scope,
        row.resource_uri,
        input.accessTokenTtlSeconds,
      ],
    );
    await tx.query(
      `INSERT INTO oauth_refresh_tokens
         (token_digest, client_id, owner_user_id, family_id, parent_digest, scope,
          resource_uri, expires_at)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, now() + $7 * interval '1 second')`,
      [
        input.refreshTokenDigest,
        row.client_id,
        row.owner_user_id,
        input.familyId,
        row.scope,
        row.resource_uri,
        input.refreshTokenTtlSeconds,
      ],
    );
    return { kind: 'issued', scope: row.scope };
  });
}

interface RefreshTokenRow {
  client_id: string;
  owner_user_id: string;
  family_id: string;
  scope: string;
  resource_uri: string;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
}

export type RotateRefreshOutcome =
  | { kind: 'issued'; scope: string }
  | { kind: 'invalid_grant' }
  | { kind: 'replay_detected' };

export async function rotateRefreshToken(
  pool: TxPool,
  input: {
    refreshTokenDigest: Buffer;
    clientId: string;
    resourceUri: string;
    nextAccessTokenDigest: Buffer;
    nextRefreshTokenDigest: Buffer;
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
  },
): Promise<RotateRefreshOutcome> {
  return withTransaction(pool, async (tx) => {
    const family = await tx.query<{ family_id: string }>(
      `SELECT family_id
         FROM oauth_refresh_tokens
        WHERE token_digest = $1`,
      [input.refreshTokenDigest],
    );
    const familyId = family.rows[0]?.family_id;
    if (!familyId) return { kind: 'invalid_grant' };

    // 先锁稳定 family，再锁具体 generation。所有 refresh 路径保持相同锁顺序，
    // 让父 token replay 与子 token rotate 串行，且不形成不同 row-lock → family-lock 死锁。
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [familyId]);
    const selected = await tx.query<RefreshTokenRow>(
      `SELECT client_id, owner_user_id, family_id, scope, resource_uri, expires_at,
              used_at, revoked_at
         FROM oauth_refresh_tokens
        WHERE token_digest = $1
        FOR UPDATE`,
      [input.refreshTokenDigest],
    );
    const row = selected.rows[0];
    if (
      !row ||
      row.family_id !== familyId ||
      row.client_id !== input.clientId ||
      row.resource_uri !== input.resourceUri
    ) {
      return { kind: 'invalid_grant' };
    }
    if (row.used_at !== null || row.revoked_at !== null) {
      await tx.query(
        `UPDATE oauth_refresh_tokens
            SET revoked_at = COALESCE(revoked_at, now())
          WHERE family_id = $1 AND revoked_at IS NULL`,
        [row.family_id],
      );
      await tx.query(
        `UPDATE oauth_access_tokens
            SET revoked_at = COALESCE(revoked_at, now())
          WHERE family_id = $1 AND revoked_at IS NULL`,
        [row.family_id],
      );
      return { kind: 'replay_detected' };
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) return { kind: 'invalid_grant' };

    await tx.query(`UPDATE oauth_refresh_tokens SET used_at = now() WHERE token_digest = $1`, [
      input.refreshTokenDigest,
    ]);
    await tx.query(
      `INSERT INTO oauth_access_tokens
         (token_digest, client_id, owner_user_id, family_id, scope, resource_uri, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + $7 * interval '1 second')`,
      [
        input.nextAccessTokenDigest,
        row.client_id,
        row.owner_user_id,
        row.family_id,
        row.scope,
        row.resource_uri,
        input.accessTokenTtlSeconds,
      ],
    );
    await tx.query(
      `INSERT INTO oauth_refresh_tokens
         (token_digest, client_id, owner_user_id, family_id, parent_digest, scope,
          resource_uri, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + $8 * interval '1 second')`,
      [
        input.nextRefreshTokenDigest,
        row.client_id,
        row.owner_user_id,
        row.family_id,
        input.refreshTokenDigest,
        row.scope,
        row.resource_uri,
        input.refreshTokenTtlSeconds,
      ],
    );
    return { kind: 'issued', scope: row.scope };
  });
}

export interface OAuthArtifactCleanupResult {
  authorizationRequestsDeleted: number;
  authorizationCodesDeleted: number;
  accessTokensDeleted: number;
  refreshTokensDeleted: number;
  clientsDeleted: number;
}

/** 通过迁移定义的 SECURITY DEFINER 函数做有界清理；API role 本身没有表 DELETE。 */
export async function cleanupExpiredOAuthArtifacts(
  db: Queryable,
  batchSize: number,
): Promise<OAuthArtifactCleanupResult> {
  const boundedBatchSize = Math.max(1, Math.min(Math.trunc(batchSize), 100));
  const result = await db.query<{
    authorization_requests_deleted: number;
    authorization_codes_deleted: number;
    access_tokens_deleted: number;
    refresh_tokens_deleted: number;
    clients_deleted: number;
  }>(
    `SELECT authorization_requests_deleted, authorization_codes_deleted,
            access_tokens_deleted, refresh_tokens_deleted, clients_deleted
       FROM cleanup_expired_oauth_artifacts($1)`,
    [boundedBatchSize],
  );
  const row = result.rows[0];
  if (!row) throw new Error('OAuth cleanup returned no result');
  return {
    authorizationRequestsDeleted: Number(row.authorization_requests_deleted),
    authorizationCodesDeleted: Number(row.authorization_codes_deleted),
    accessTokensDeleted: Number(row.access_tokens_deleted),
    refreshTokensDeleted: Number(row.refresh_tokens_deleted),
    clientsDeleted: Number(row.clients_deleted),
  };
}

export interface McpPrincipal {
  userId: string;
  account: string;
  scopes: McpOAuthScope[];
}

export type AccessTokenResolution =
  | { kind: 'valid'; principal: McpPrincipal }
  | { kind: 'disabled' }
  | { kind: 'invalid' };

export async function resolveAccessToken(
  db: Queryable,
  input: { tokenDigest: Buffer; resourceUri: string },
): Promise<AccessTokenResolution> {
  const result = await db.query<{
    owner_user_id: string;
    account: string;
    roles: string[];
    disabled_at: Date | null;
    scope: string;
  }>(
    `SELECT t.owner_user_id, u.account, u.roles, u.disabled_at, t.scope
       FROM oauth_access_tokens t
       JOIN users u ON u.id = t.owner_user_id
      WHERE t.token_digest = $1
        AND t.resource_uri = $2
        AND t.revoked_at IS NULL
        AND t.expires_at > now()
      LIMIT 1`,
    [input.tokenDigest, input.resourceUri],
  );
  const row = result.rows[0];
  if (!row) return { kind: 'invalid' };
  if (row.disabled_at !== null) return { kind: 'disabled' };
  const roles = row.roles.map((role) => RoleSchema.safeParse(role));
  if (roles.length !== 1 || !roles[0]?.success || roles[0].data !== 'creator') {
    throw new Error('invalid roles in oauth principal');
  }
  const scopes: McpOAuthScope[] = [];
  for (const scope of row.scope.split(' ')) {
    if (scope === 'combo.agent:read' || scope === 'combo.agent:write') scopes.push(scope);
    else throw new Error('invalid scope in oauth access token');
  }
  return { kind: 'valid', principal: { userId: row.owner_user_id, account: row.account, scopes } };
}
