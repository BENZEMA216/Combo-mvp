// PostgreSQL 事实源实现：SQL 与 db/migrations/0012_v2_end_user_identity.sql 一一对应。
// 表与字段名改动必须先改迁移再改这里。
import { type Pool, type PoolClient } from 'pg';
import { codeDigestMatches } from './crypto.js';
import type { AuthzStore, ResolvedSession } from './service.js';

export interface QueryResultLike<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number | null;
}

/** 仅依赖 query 的最小 DB 句柄（pg 子集），事务内/池层通用。 */
export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResultLike<R>>;
}

async function withTransaction<T>(pool: Pool, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

function toSession(row: { id: string; user_id: string; expires_at: Date }): ResolvedSession {
  return { sessionId: row.id, userId: row.user_id, expiresAt: row.expires_at };
}

/** pg.Pool 上的 AuthzStore 实现。 */
export function createPgAuthzStore(pool: Pool): AuthzStore {
  return {
    async replaceChallenge({ targetDigest, codeDigest, expiresAt: _expiresAt }) {
      await withTransaction(pool, async (tx) => {
        await tx.query(
          `UPDATE v2_auth_challenges
              SET invalidated_at = now()
            WHERE channel = 'phone'
              AND purpose = 'login'
              AND target_digest = $1
              AND consumed_at IS NULL
              AND invalidated_at IS NULL`,
          [targetDigest],
        );
        // expires_at 用数据库时钟生成（ck_v2_challenge_ttl 以上限五分钟约束两列关系）；
        // 入参保留在端口签名里供假实现使用。
        await tx.query(
          `INSERT INTO v2_auth_challenges (channel, purpose, target_digest, code_digest, expires_at)
           VALUES ('phone', 'login', $1, $2, now() + interval '5 minutes')`,
          [targetDigest, codeDigest],
        );
      });
    },

    async consumeChallenge({ targetDigest, candidateCodeDigest }) {
      return withTransaction(pool, async (tx) => {
        const found = await tx.query<{
          id: string;
          code_digest: Buffer;
          attempt_count: number;
        }>(
          `SELECT id, code_digest, attempt_count
             FROM v2_auth_challenges
            WHERE channel = 'phone'
              AND purpose = 'login'
              AND target_digest = $1
              AND consumed_at IS NULL
              AND invalidated_at IS NULL
              AND expires_at > now()
            ORDER BY created_at DESC
            LIMIT 1
            FOR UPDATE`,
          [targetDigest],
        );
        const challenge = found.rows[0];
        if (!challenge) return false;

        if (codeDigestMatches(challenge.code_digest, candidateCodeDigest)) {
          await tx.query(`UPDATE v2_auth_challenges SET consumed_at = now() WHERE id = $1`, [
            challenge.id,
          ]);
          return true;
        }

        // 在库内原子累加并按 max_attempts 落定作废，避免把次数作为参数重复使用
        // （PG 对同一参数的多上下文类型推断会直接报错）。
        await tx.query(
          `UPDATE v2_auth_challenges
              SET attempt_count = attempt_count + 1,
                  invalidated_at = CASE
                    WHEN attempt_count + 1 >= max_attempts THEN now()
                    ELSE NULL
                  END
            WHERE id = $1`,
          [challenge.id],
        );
        return false;
      });
    },

    async findOrCreatePhoneUser(phone) {
      const existing = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM v2_identities WHERE type = 'phone' AND identifier = $1 LIMIT 1`,
        [phone],
      );
      if (existing.rows[0]) return existing.rows[0].user_id;

      try {
        return await withTransaction(pool, async (tx) => {
          const user = await tx.query<{ id: string }>(
            `INSERT INTO v2_users DEFAULT VALUES RETURNING id`,
          );
          const userId = user.rows[0]!.id;
          await tx.query(
            `INSERT INTO v2_identities (user_id, type, identifier) VALUES ($1, 'phone', $2)`,
            [userId, phone],
          );
          return userId;
        });
      } catch (error) {
        // 并发首登撞唯一约束时回落到查询，由胜出事务的行提供服务。
        if ((error as { code?: string }).code !== '23505') throw error;
        const raced = await pool.query<{ user_id: string }>(
          `SELECT user_id FROM v2_identities WHERE type = 'phone' AND identifier = $1 LIMIT 1`,
          [phone],
        );
        if (!raced.rows[0]) throw error;
        return raced.rows[0].user_id;
      }
    },

    async insertSession({ userId, tokenDigest, expiresAt: _expiresAt }) {
      // expires_at 由数据库按 created_at + 7 天生成（ck_v2_session_ttl 要求两列严格相等，
      // 应用时钟与数据库时钟的毫秒差会让约束失败）；入参保留在端口签名里供假实现使用。
      const inserted = await pool.query<{ id: string; user_id: string; expires_at: Date }>(
        `INSERT INTO v2_sessions (user_id, token_digest, auth_method, expires_at)
         VALUES ($1, $2, 'dev_phone_otp', now() + interval '7 days')
         RETURNING id, user_id, expires_at`,
        [userId, tokenDigest],
      );
      return toSession(inserted.rows[0]!);
    },

    async resolveSession(tokenDigest) {
      const found = await pool.query<{ id: string; user_id: string; expires_at: Date }>(
        `SELECT id, user_id, expires_at
           FROM v2_sessions
          WHERE token_digest = $1
            AND revoked_at IS NULL
            AND expires_at > now()
          LIMIT 1`,
        [tokenDigest],
      );
      const row = found.rows[0];
      return row ? toSession(row) : null;
    },

    async revokeSession(tokenDigest) {
      await pool.query(
        `UPDATE v2_sessions
            SET revoked_at = now()
          WHERE token_digest = $1
            AND revoked_at IS NULL`,
        [tokenDigest],
      );
    },
  };
}
