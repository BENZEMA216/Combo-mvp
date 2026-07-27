import type { MeView, NormalizedEmailAddress, Role } from '@cb/shared';
import { RoleSchema } from '@cb/shared';
import { toIso, type Queryable } from '../../platform/infra/db.js';
import { withTransaction, type Tx, type TxPool } from '../../platform/infra/db-tx.js';
import { advisoryLockKey, codeDigestMatches } from './auth-crypto.js';

const GLOBAL_EMAIL_BUDGET_LOCK = '-6424830917213652011';
const MAX_ACCOUNT_INSERT_ATTEMPTS = 16;

export interface ChallengeInsertInput {
  challengeId: string;
  targetDigest: Buffer;
  codeDigest: Buffer;
}

export type ChallengeInsertResult =
  | { kind: 'created' }
  | { kind: 'rate_limited'; retryAfterSeconds: number };

interface BudgetRow {
  cooldown_seconds: number | string;
  target_hour_count: number | string;
  target_hour_seconds: number | string;
  target_day_count: number | string;
  utc_day_seconds: number | string;
  global_day_count: number | string;
}

function finiteNonNegative(value: number | string): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.ceil(number)) : 0;
}

async function takeTargetLock(tx: Tx, targetDigest: Uint8Array): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [advisoryLockKey(targetDigest)]);
}

/**
 * challenge 第一段事务。锁序固定为全站预算锁、目标锁；所有硬预算都按已创建行计数，
 * 所以供应商失败也不能被用来绕过邮件轰炸上限。
 */
export async function insertPendingEmailChallenge(
  pool: TxPool,
  input: ChallengeInsertInput,
): Promise<ChallengeInsertResult> {
  return withTransaction(pool, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [GLOBAL_EMAIL_BUDGET_LOCK]);
    await takeTargetLock(tx, input.targetDigest);

    await tx.query(
      `UPDATE auth_otp_challenges
          SET invalidated_at = now()
        WHERE channel = 'email'
          AND purpose = 'login'
          AND target_digest = $1
          AND activated_at IS NOT NULL
          AND consumed_at IS NULL
          AND invalidated_at IS NULL
          AND expires_at <= now()`,
      [input.targetDigest],
    );

    const budget = await tx.query<BudgetRow>(
      `SELECT
         COALESCE((
           SELECT GREATEST(0, CEIL(EXTRACT(EPOCH FROM
             (MAX(created_at) + interval '60 seconds' - now()))))::int
             FROM auth_otp_challenges
            WHERE channel = 'email'
              AND purpose = 'login'
              AND target_digest = $1
              AND created_at > now() - interval '60 seconds'
         ), 0) AS cooldown_seconds,
         (SELECT count(*)::int
            FROM auth_otp_challenges
           WHERE channel = 'email'
             AND purpose = 'login'
             AND target_digest = $1
             AND created_at > now() - interval '1 hour') AS target_hour_count,
         COALESCE((
           SELECT GREATEST(0, CEIL(EXTRACT(EPOCH FROM
             (MIN(created_at) + interval '1 hour' - now()))))::int
             FROM auth_otp_challenges
            WHERE channel = 'email'
              AND purpose = 'login'
              AND target_digest = $1
              AND created_at > now() - interval '1 hour'
         ), 0) AS target_hour_seconds,
         (SELECT count(*)::int
            FROM auth_otp_challenges
           WHERE channel = 'email'
             AND purpose = 'login'
             AND target_digest = $1
             AND created_at >=
                 (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))
           AS target_day_count,
         GREATEST(1, CEIL(EXTRACT(EPOCH FROM
           (((date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day')
              AT TIME ZONE 'UTC') - now()))))::int AS utc_day_seconds,
         (SELECT count(*)::int
            FROM auth_otp_challenges
           WHERE channel = 'email'
             AND created_at >=
                 (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))
           AS global_day_count`,
      [input.targetDigest],
    );
    const row = budget.rows[0];
    if (!row) throw new Error('email challenge budget query returned no row');

    const retryAfter: number[] = [];
    const cooldown = finiteNonNegative(row.cooldown_seconds);
    const hourCount = finiteNonNegative(row.target_hour_count);
    const dayCount = finiteNonNegative(row.target_day_count);
    const globalCount = finiteNonNegative(row.global_day_count);
    if (cooldown > 0) retryAfter.push(cooldown);
    if (hourCount >= 5) retryAfter.push(Math.max(1, finiteNonNegative(row.target_hour_seconds)));
    if (dayCount >= 10 || globalCount >= 1_000) {
      retryAfter.push(Math.max(1, finiteNonNegative(row.utc_day_seconds)));
    }
    if (retryAfter.length > 0) {
      return { kind: 'rate_limited', retryAfterSeconds: Math.max(...retryAfter) };
    }

    await tx.query(
      `INSERT INTO auth_otp_challenges
         (id, channel, purpose, target_digest, code_digest, expires_at)
       VALUES ($1, 'email', 'login', $2, $3, now() + interval '5 minutes')`,
      [input.challengeId, input.targetDigest, input.codeDigest],
    );
    return { kind: 'created' };
  });
}

export type ChallengeDeliveryResult =
  | 'accepted'
  | 'permanent_rejection'
  | 'transient_failure'
  | 'configuration_failure';

/** challenge 第二段事务。只有供应商受理时才替换旧活动码。 */
export async function finalizeEmailChallenge(
  pool: TxPool,
  input: {
    challengeId: string;
    targetDigest: Buffer;
    delivery: ChallengeDeliveryResult;
    traceId: string;
  },
): Promise<void> {
  await withTransaction(pool, async (tx) => {
    await takeTargetLock(tx, input.targetDigest);

    if (input.delivery === 'accepted') {
      const newerWinner = await tx.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM auth_otp_challenges winner
             JOIN auth_otp_challenges candidate ON candidate.id = $2
            WHERE winner.channel = 'email'
              AND winner.purpose = 'login'
              AND winner.target_digest = $1
              AND winner.activated_at IS NOT NULL
              AND winner.consumed_at IS NULL
              AND winner.invalidated_at IS NULL
              AND (winner.created_at, winner.id) > (candidate.created_at, candidate.id)
         ) AS exists`,
        [input.targetDigest, input.challengeId],
      );

      if (newerWinner.rows[0]?.exists) {
        // 迟到的旧供应商响应不能替换已经获胜的新验证码；把旧 pending 收口为不可验证。
        await tx.query(
          `UPDATE auth_otp_challenges
              SET invalidated_at = now()
            WHERE id = $1
              AND target_digest = $2
              AND activated_at IS NULL
              AND consumed_at IS NULL
              AND invalidated_at IS NULL`,
          [input.challengeId, input.targetDigest],
        );
      } else {
        await tx.query(
          `UPDATE auth_otp_challenges
              SET invalidated_at = now()
            WHERE channel = 'email'
              AND purpose = 'login'
              AND target_digest = $1
              AND id <> $2
              AND activated_at IS NOT NULL
              AND consumed_at IS NULL
              AND invalidated_at IS NULL`,
          [input.targetDigest, input.challengeId],
        );
        const activated = await tx.query<{ id: string }>(
          `UPDATE auth_otp_challenges
              SET activated_at = now()
            WHERE id = $1
              AND target_digest = $2
              AND activated_at IS NULL
              AND consumed_at IS NULL
              AND invalidated_at IS NULL
              AND expires_at > now()
          RETURNING id`,
          [input.challengeId, input.targetDigest],
        );
        if (!activated.rows[0]) throw new Error('pending email challenge could not be activated');
      }
    } else {
      await tx.query(
        `UPDATE auth_otp_challenges
            SET invalidated_at = now()
          WHERE id = $1
            AND target_digest = $2
            AND activated_at IS NULL
            AND consumed_at IS NULL
            AND invalidated_at IS NULL`,
        [input.challengeId, input.targetDigest],
      );
    }

    await tx.query(
      `INSERT INTO auth_audit_events
         (event_type, outcome, auth_method, target_digest, trace_id, details)
       VALUES ('otp_requested', $1, 'email_otp', $2, $3, jsonb_build_object('result', $4::text))`,
      [
        input.delivery === 'accepted' ? 'success' : 'failure',
        input.targetDigest,
        input.traceId,
        input.delivery,
      ],
    );
  });
}

interface UserRow {
  id: string;
  account: string;
  roles: string[];
  created_at: string | Date;
  last_login_at: string | Date | null;
  disabled_at: string | Date | null;
}

interface ChallengeRow {
  id: string;
  code_digest: Buffer;
  attempt_count: number;
  max_attempts: number;
}

function parseRoles(raw: string[]): Role[] {
  const roles: Role[] = [];
  for (const value of raw) {
    const parsed = RoleSchema.safeParse(value);
    if (parsed.success && !roles.includes(parsed.data)) roles.push(parsed.data);
  }
  if (roles.length !== 1 || roles[0] !== 'creator') {
    throw new Error('authenticated user has invalid roles');
  }
  return roles;
}

function userView(row: UserRow, email: NormalizedEmailAddress): MeView {
  return {
    id: row.id,
    account: row.account,
    email,
    roles: parseRoles(row.roles),
    createdAt: toIso(row.created_at),
    lastLoginAt: row.last_login_at == null ? null : toIso(row.last_login_at),
  };
}

async function auditLoginFailure(
  tx: Tx,
  targetDigest: Buffer,
  traceId: string,
  result: 'invalid_or_expired' | 'attempts_exhausted' | 'account_disabled',
  userId?: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO auth_audit_events
       (user_id, event_type, outcome, auth_method, target_digest, trace_id, details)
     VALUES ($1, 'login_failed', 'failure', 'email_otp', $2, $3,
             jsonb_build_object('result', $4::text))`,
    [userId ?? null, targetDigest, traceId, result],
  );
}

async function findUserByEmail(tx: Tx, email: NormalizedEmailAddress): Promise<UserRow | null> {
  const result = await tx.query<UserRow>(
    `SELECT u.id, u.account, u.roles, u.created_at, u.last_login_at, u.disabled_at
       FROM auth_identities i
       JOIN users u ON u.id = i.user_id
      WHERE i.provider = 'email'
        AND i.issuer = 'local'
        AND i.subject = $1
      LIMIT 1`,
    [email],
  );
  return result.rows[0] ?? null;
}

async function createUserWithEmail(
  tx: Tx,
  email: NormalizedEmailAddress,
  accountCandidate: () => string,
): Promise<UserRow> {
  for (let attempt = 0; attempt < MAX_ACCOUNT_INSERT_ATTEMPTS; attempt += 1) {
    const inserted = await tx.query<UserRow>(
      `INSERT INTO users (account, roles, last_login_at)
       VALUES ($1, ARRAY['creator']::text[], now())
       ON CONFLICT DO NOTHING
       RETURNING id, account, roles, created_at, last_login_at, disabled_at`,
      [accountCandidate()],
    );
    const user = inserted.rows[0];
    if (!user) continue;

    const identity = await tx.query<{ id: string }>(
      `INSERT INTO auth_identities (user_id, provider, issuer, subject)
       VALUES ($1, 'email', 'local', $2)
       ON CONFLICT (provider, issuer, subject) DO NOTHING
       RETURNING id`,
      [user.id, email],
    );
    if (identity.rows[0]) return user;

    // 防御性并发收口：唯一身份已被另一事务创建时不留下孤立新用户。
    await tx.query('DELETE FROM users WHERE id = $1', [user.id]);
    const existing = await findUserByEmail(tx, email);
    if (existing) return existing;
  }
  throw new Error('creator account allocation exhausted');
}

export type VerifyEmailResult =
  | { kind: 'invalid' }
  | { kind: 'disabled' }
  | { kind: 'ok'; user: MeView };

/**
 * 验证单事务：锁定目标和活动 challenge，原子增加失败次数或消费正确码；随后查建身份、
 * 更新登录时间、签发固定会话并写审计。只有锁定的活动 challenge 才能产生失败审计；
 * 不存在、已过期、已失效或已消费的目标只返回统一失败，避免 Redis 故障时写放大。
 * 事务提交前调用方不能设置 Cookie。
 */
export async function verifyEmailChallenge(
  pool: TxPool,
  input: {
    email: NormalizedEmailAddress;
    targetDigest: Buffer;
    candidateCodeDigest: Buffer;
    sessionDigest: Buffer;
    currentSessionDigest: Buffer | null;
    traceId: string;
    accountCandidate: () => string;
  },
): Promise<VerifyEmailResult> {
  return withTransaction(pool, async (tx) => {
    await takeTargetLock(tx, input.targetDigest);

    await tx.query(
      `UPDATE auth_otp_challenges
          SET invalidated_at = now()
        WHERE channel = 'email'
          AND purpose = 'login'
          AND target_digest = $1
          AND activated_at IS NOT NULL
          AND consumed_at IS NULL
          AND invalidated_at IS NULL
          AND expires_at <= now()`,
      [input.targetDigest],
    );

    const selected = await tx.query<ChallengeRow>(
      `SELECT id, code_digest, attempt_count, max_attempts
         FROM auth_otp_challenges
        WHERE channel = 'email'
          AND purpose = 'login'
          AND target_digest = $1
          AND activated_at IS NOT NULL
          AND consumed_at IS NULL
          AND invalidated_at IS NULL
          AND expires_at > now()
          AND attempt_count < max_attempts
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [input.targetDigest],
    );
    const challenge = selected.rows[0];
    if (!challenge) {
      return { kind: 'invalid' };
    }

    if (!codeDigestMatches(challenge.code_digest, input.candidateCodeDigest)) {
      const exhausted = Number(challenge.attempt_count) + 1 >= Number(challenge.max_attempts);
      await tx.query(
        `UPDATE auth_otp_challenges
            SET attempt_count = attempt_count + 1,
                invalidated_at = CASE
                  WHEN attempt_count + 1 >= max_attempts THEN now()
                  ELSE invalidated_at
                END
          WHERE id = $1`,
        [challenge.id],
      );
      await auditLoginFailure(
        tx,
        input.targetDigest,
        input.traceId,
        exhausted ? 'attempts_exhausted' : 'invalid_or_expired',
      );
      return { kind: 'invalid' };
    }

    const consumed = await tx.query<{ id: string }>(
      `UPDATE auth_otp_challenges
          SET consumed_at = now()
        WHERE id = $1
          AND consumed_at IS NULL
          AND invalidated_at IS NULL
          AND expires_at > now()
      RETURNING id`,
      [challenge.id],
    );
    if (!consumed.rows[0]) {
      return { kind: 'invalid' };
    }

    let user = await findUserByEmail(tx, input.email);
    if (!user) user = await createUserWithEmail(tx, input.email, input.accountCandidate);

    const updated = await tx.query<UserRow>(
      `UPDATE users
          SET last_login_at = now()
        WHERE id = $1
          AND disabled_at IS NULL
      RETURNING id, account, roles, created_at, last_login_at, disabled_at`,
      [user.id],
    );
    const enabledUser = updated.rows[0];
    if (!enabledUser) {
      await auditLoginFailure(tx, input.targetDigest, input.traceId, 'account_disabled', user.id);
      return { kind: 'disabled' };
    }
    user = enabledUser;

    if (input.currentSessionDigest) {
      await tx.query(
        `UPDATE auth_sessions
            SET revoked_at = now()
          WHERE token_digest = $1
            AND revoked_at IS NULL`,
        [input.currentSessionDigest],
      );
    }

    const session = await tx.query<{ id: string }>(
      `INSERT INTO auth_sessions
         (user_id, token_digest, auth_method, expires_at)
       VALUES ($1, $2, 'email_otp', now() + interval '7 days')
       RETURNING id`,
      [user.id, input.sessionDigest],
    );
    const sessionId = session.rows[0]?.id;
    if (!sessionId) throw new Error('email verification session insert returned no row');

    await tx.query(
      `INSERT INTO auth_audit_events
         (user_id, event_type, outcome, auth_method, target_digest, session_id, trace_id, details)
       VALUES ($1, 'login_succeeded', 'success', 'email_otp', $2, $3, $4, '{}'::jsonb)`,
      [user.id, input.targetDigest, sessionId, input.traceId],
    );

    return { kind: 'ok', user: userView(user, input.email) };
  });
}

export interface MeRow extends MeView {
  disabledAt: string | null;
}

/** /me 每次从已验证邮箱身份读取规范邮箱，并再次检查停用状态。 */
export async function readMe(db: Queryable, userId: string): Promise<MeRow | null> {
  const result = await db.query<UserRow & { email: NormalizedEmailAddress }>(
    `SELECT u.id, u.account, u.roles, u.created_at, u.last_login_at, u.disabled_at,
            i.subject AS email
       FROM users u
       JOIN auth_identities i
         ON i.user_id = u.id
        AND i.provider = 'email'
        AND i.issuer = 'local'
      WHERE u.id = $1
      LIMIT 1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    ...userView(row, row.email),
    disabledAt: row.disabled_at == null ? null : toIso(row.disabled_at),
  };
}

/** 格式合法 Cookie 的幂等撤销与 logout 审计使用一条 PostgreSQL 语句原子完成。 */
export async function revokeSession(
  db: Queryable,
  tokenDigest: Buffer,
  traceId: string,
): Promise<void> {
  await db.query(
    `WITH revoked AS (
       UPDATE auth_sessions
          SET revoked_at = COALESCE(revoked_at, now())
        WHERE token_digest = $1
          AND revoked_at IS NULL
       RETURNING id, user_id
     )
     INSERT INTO auth_audit_events
       (user_id, event_type, outcome, auth_method, session_id, trace_id, details)
     SELECT user_id, 'logout', 'success', 'email_otp', id, $2, '{}'::jsonb
       FROM revoked`,
    [tokenDigest, traceId],
  );
}
