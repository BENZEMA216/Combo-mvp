import { describe, expect, it } from 'vitest';
import type { TxConn, TxPool } from '../platform/infra/db-tx.js';
import { exchangeAuthorizationCode, rotateRefreshToken } from '../modules/external-mcp/repo.js';

const CLIENT_ID = `mcp_client_${'a'.repeat(43)}`;
const OWNER_ID = '00000000-0000-4000-8000-000000000001';
const FAMILY_ID = '00000000-0000-4000-8000-000000000002';
const RESOURCE = 'https://test.example/api/external-mcp/mcp';
const REDIRECT = 'http://127.0.0.1:49152/callback/codex-id';
const CHALLENGE = 'c'.repeat(43);

function transactionalPool(
  query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>,
): TxPool {
  return {
    async connect() {
      return {
        async query<R>(sql: string, params: unknown[] = []) {
          if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) {
            return { rows: [] as R[], rowCount: 0 };
          }
          const result = await query(sql, params);
          return { ...result, rows: result.rows as R[] };
        },
        release() {},
      } satisfies TxConn;
    },
  };
}

describe('external MCP one-time grants and token family rotation', () => {
  it('consumes an authorization code once under a row lock', async () => {
    let used = false;
    let accessInserts = 0;
    let refreshInserts = 0;
    const sqlSeen: string[] = [];
    const pool = transactionalPool(async (sql) => {
      sqlSeen.push(sql);
      if (sql.includes('FROM oauth_authorization_codes')) {
        return {
          rows: [
            {
              client_id: CLIENT_ID,
              owner_user_id: OWNER_ID,
              redirect_uri: REDIRECT,
              scope: 'combo.agent:read combo.agent:write',
              resource_uri: RESOURCE,
              code_challenge: CHALLENGE,
              expires_at: new Date(Date.now() + 60_000),
              used_at: used ? new Date() : null,
            },
          ],
        };
      }
      if (sql.includes('UPDATE oauth_authorization_codes SET used_at')) {
        used = true;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO oauth_access_tokens')) {
        accessInserts += 1;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO oauth_refresh_tokens')) {
        refreshInserts += 1;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const input = {
      codeDigest: Buffer.alloc(32, 1),
      expectedCodeChallenge: CHALLENGE,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      resourceUri: RESOURCE,
      accessTokenDigest: Buffer.alloc(32, 2),
      refreshTokenDigest: Buffer.alloc(32, 3),
      familyId: FAMILY_ID,
      accessTokenTtlSeconds: 3_600,
      refreshTokenTtlSeconds: 30 * 86_400,
    };

    await expect(exchangeAuthorizationCode(pool, input)).resolves.toEqual({
      kind: 'issued',
      scope: 'combo.agent:read combo.agent:write',
    });
    await expect(exchangeAuthorizationCode(pool, input)).resolves.toEqual({
      kind: 'invalid_grant',
    });
    expect(accessInserts).toBe(1);
    expect(refreshInserts).toBe(1);
    expect(sqlSeen.find((sql) => sql.includes('FROM oauth_authorization_codes'))).toContain(
      'FOR UPDATE',
    );
  });

  it('rotates refresh tokens and revokes the entire family on replay', async () => {
    let used = false;
    let childAccessInserts = 0;
    let childRefreshInserts = 0;
    const familyRevocations: string[] = [];
    const sqlSeen: string[] = [];
    const pool = transactionalPool(async (sql) => {
      sqlSeen.push(sql);
      if (sql.includes('pg_advisory_xact_lock')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM oauth_refresh_tokens')) {
        return {
          rows: [
            {
              client_id: CLIENT_ID,
              owner_user_id: OWNER_ID,
              family_id: FAMILY_ID,
              scope: 'combo.agent:read combo.agent:write',
              resource_uri: RESOURCE,
              expires_at: new Date(Date.now() + 60_000),
              used_at: used ? new Date() : null,
              revoked_at: null,
            },
          ],
        };
      }
      if (sql.includes('UPDATE oauth_refresh_tokens') && sql.includes('SET used_at')) {
        used = true;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE oauth_refresh_tokens') && sql.includes('SET revoked_at')) {
        familyRevocations.push('refresh');
        return { rows: [], rowCount: 2 };
      }
      if (sql.includes('UPDATE oauth_access_tokens') && sql.includes('SET revoked_at')) {
        familyRevocations.push('access');
        return { rows: [], rowCount: 2 };
      }
      if (sql.includes('INSERT INTO oauth_access_tokens')) {
        childAccessInserts += 1;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO oauth_refresh_tokens')) {
        childRefreshInserts += 1;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const input = {
      refreshTokenDigest: Buffer.alloc(32, 4),
      clientId: CLIENT_ID,
      resourceUri: RESOURCE,
      nextAccessTokenDigest: Buffer.alloc(32, 5),
      nextRefreshTokenDigest: Buffer.alloc(32, 6),
      accessTokenTtlSeconds: 3_600,
      refreshTokenTtlSeconds: 30 * 86_400,
    };

    await expect(rotateRefreshToken(pool, input)).resolves.toEqual({
      kind: 'issued',
      scope: 'combo.agent:read combo.agent:write',
    });
    await expect(rotateRefreshToken(pool, input)).resolves.toEqual({
      kind: 'replay_detected',
    });
    expect(childAccessInserts).toBe(1);
    expect(childRefreshInserts).toBe(1);
    expect(familyRevocations).toEqual(['refresh', 'access']);
    const refreshReads = sqlSeen.filter((sql) => sql.includes('FROM oauth_refresh_tokens'));
    expect(refreshReads).toHaveLength(4);
    expect(refreshReads[0]).not.toContain('FOR UPDATE');
    expect(refreshReads[1]).toContain('FOR UPDATE');
    const firstFamilyLock = sqlSeen.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
    const firstRowLock = sqlSeen.findIndex(
      (sql) => sql.includes('FROM oauth_refresh_tokens') && sql.includes('FOR UPDATE'),
    );
    expect(firstFamilyLock).toBeGreaterThan(-1);
    expect(firstFamilyLock).toBeLessThan(firstRowLock);
  });
});
