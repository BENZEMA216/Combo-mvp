import { createHash } from 'node:crypto';
import {
  EXTERNAL_MCP_PATH,
  MCP_ACCESS_TOKEN_PATTERN,
  McpOAuthScopeSchema,
  RoleSchema,
  type AuthContext,
  type McpOAuthScope,
} from '@cb/shared';
import type { Queryable } from './db.js';

export type McpAccessTokenResolution =
  | { kind: 'valid'; context: AuthContext; scopes: McpOAuthScope[] }
  | { kind: 'disabled' }
  | { kind: 'invalid' };

function bearerToken(value: string | undefined): string | null {
  const match = value?.match(/^Bearer ([^\s]+)$/iu);
  const token = match?.[1];
  return token && MCP_ACCESS_TOKEN_PATTERN.test(token) ? token : null;
}

/** Runtime 只接收 Authoring 经集群内 HTTP 转发的 access token，并按精确 MCP resource 验证摘要。 */
export async function resolveMcpAccessToken(
  db: Queryable,
  authorization: string | undefined,
  externalMcpPublicOrigin: string,
): Promise<McpAccessTokenResolution> {
  const token = bearerToken(authorization);
  if (!token) return { kind: 'invalid' };
  const digest = createHash('sha256').update(token, 'ascii').digest();
  const resourceUri = `${externalMcpPublicOrigin}${EXTERNAL_MCP_PATH}`;
  const result = await db.query<{
    owner_user_id: string;
    account: string;
    roles: string[];
    disabled_at: Date | string | null;
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
    [digest, resourceUri],
  );
  const row = result.rows[0];
  if (!row) return { kind: 'invalid' };
  if (row.disabled_at !== null) return { kind: 'disabled' };
  const scopes: McpOAuthScope[] = [];
  for (const rawScope of row.scope.split(' ')) {
    const parsedScope = McpOAuthScopeSchema.safeParse(rawScope);
    if (!parsedScope.success) return { kind: 'invalid' };
    scopes.push(parsedScope.data);
  }
  if (scopes.length === 0) return { kind: 'invalid' };
  const roles = row.roles.map((role) => RoleSchema.safeParse(role));
  if (roles.length !== 1 || !roles[0]?.success || roles[0].data !== 'creator') {
    throw new Error('invalid roles in mcp access token principal');
  }
  return {
    kind: 'valid',
    context: { userId: row.owner_user_id, account: row.account, roles: ['creator'] },
    scopes,
  };
}
