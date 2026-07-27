import { createHash } from 'node:crypto';
import {
  AUTH_SESSION_COOKIE_VALUE_PATTERN,
  RoleSchema,
  type AuthContext,
  type Role,
} from '@cb/shared';
import type { Queryable } from './db.js';

export type AuthSessionResolution =
  | { kind: 'valid'; context: AuthContext; sessionId: string }
  | { kind: 'disabled' }
  | { kind: 'invalid' };

/** 格式校验先于摘要和查询；数据库只看到完整 Cookie 值的 SHA-256。 */
export function authSessionDigest(value: string | undefined): Buffer | null {
  if (!value || !AUTH_SESSION_COOKIE_VALUE_PATTERN.test(value)) return null;
  return createHash('sha256').update(value, 'ascii').digest();
}

function parseRoles(raw: string[]): Role[] | null {
  const roles: Role[] = [];
  for (const value of raw) {
    const parsed = RoleSchema.safeParse(value);
    if (!parsed.success) return null;
    roles.push(parsed.data);
  }
  return roles.length === 1 && roles[0] === 'creator' ? roles : null;
}

/**
 * runtime 只读 PostgreSQL 会话事实源。未知、过期和已撤销会话统一 invalid；
 * 停用用户单独返回 disabled；数据库异常向上抛给中间件映射 503。
 */
export async function resolveAuthSession(
  db: Queryable,
  cookieValue: string | undefined,
): Promise<AuthSessionResolution> {
  const digest = authSessionDigest(cookieValue);
  if (!digest) return { kind: 'invalid' };

  const result = await db.query<{
    session_id: string;
    user_id: string;
    account: string;
    roles: string[];
    disabled_at: string | Date | null;
  }>(
    `SELECT s.id AS session_id,
            u.id AS user_id,
            u.account,
            u.roles,
            u.disabled_at
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_digest = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
      LIMIT 1`,
    [digest],
  );

  const row = result.rows[0];
  if (!row) return { kind: 'invalid' };
  if (row.disabled_at != null) return { kind: 'disabled' };

  const roles = parseRoles(row.roles);
  if (!roles) throw new Error('invalid roles in authenticated user row');
  return {
    kind: 'valid',
    sessionId: row.session_id,
    context: { userId: row.user_id, account: row.account, roles },
  };
}
