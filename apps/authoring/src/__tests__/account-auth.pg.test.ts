import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_SESSION_COOKIE_VALUE_PATTERN } from '@cb/shared';
import { asTxPool, type TxPool } from '../platform/infra/db-tx.js';
import { resolveAuthSession } from '../platform/infra/auth-session.js';
import type { AuthRateLimitPort } from '../platform/infra/auth-rate-limit.js';
import type {
  LoginCodeEmail,
  ResendDeliveryResult,
  ResendEmailPort,
} from '../platform/infra/resend.js';
import {
  requestEmailChallenge,
  verifyEmail,
  type AccountAuthDependencies,
} from '../modules/account/service.js';
import { revokeSession } from '../modules/account/repo.js';

const enabled = process.env.AUTH_PG_TEST === '1' && Boolean(process.env.DATABASE_URL);
const pgDescribe = enabled ? describe : describe.skip;
const HMAC_SECRET = 'pg-test-hmac-secret-that-is-never-production';

class CapturingMailer implements ResendEmailPort {
  messages: LoginCodeEmail[] = [];
  delivery: ResendDeliveryResult = 'accepted';
  async sendLoginCode(message: LoginCodeEmail): Promise<ResendDeliveryResult> {
    this.messages.push(message);
    return this.delivery;
  }
  latest(): LoginCodeEmail {
    const message = this.messages.at(-1);
    if (!message) throw new Error('expected a captured email');
    return message;
  }
}

const allowAll: AuthRateLimitPort = {
  async consumeChallenge() {
    return { allowed: true, retryAfterSeconds: 1 };
  },
  async consumeVerification() {
    return { allowed: true, retryAfterSeconds: 1 };
  },
};

const verificationRedisOutage: AuthRateLimitPort = {
  async consumeChallenge() {
    return { allowed: true, retryAfterSeconds: 1 };
  },
  async consumeVerification() {
    throw new Error('redis unavailable');
  },
};

pgDescribe('first-party auth PostgreSQL invariants', () => {
  let pool: Pool;
  let mailer: CapturingMailer;
  let randomByte = 1;
  let nextOtp = 100_000;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    const schema = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name IN ('auth_identities', 'auth_otp_challenges', 'auth_sessions')`,
    );
    if (schema.rows.length !== 3) throw new Error('first-party auth migration is not applied');
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE auth_audit_events, auth_sessions, auth_otp_challenges, auth_identities, users CASCADE',
    );
    mailer = new CapturingMailer();
    randomByte = 1;
    nextOtp = 100_000;
  });

  function dependencies(rateLimiter: AuthRateLimitPort = allowAll): AccountAuthDependencies {
    return {
      db: asTxPool(pool),
      mailer,
      rateLimiter,
      hmacSecret: HMAC_SECRET,
      randomBytes: (size: number) => Buffer.alloc(size, randomByte++),
      randomInteger: () => nextOtp++,
    };
  }

  async function challenge(email = 'Alice@example.com') {
    const result = await requestEmailChallenge(dependencies(), {
      email,
      clientAddress: '192.0.2.10',
      traceId: 'trace-pg-challenge',
    });
    expect(result.kind).toBe('accepted');
    return mailer.latest();
  }

  async function ageChallenges(seconds = 61): Promise<void> {
    await pool.query(
      `UPDATE auth_otp_challenges
          SET created_at = created_at - ($1::text || ' seconds')::interval,
              activated_at = activated_at - ($1::text || ' seconds')::interval,
              expires_at = expires_at - ($1::text || ' seconds')::interval
        WHERE consumed_at IS NOT NULL OR invalidated_at IS NULL`,
      [seconds],
    );
  }

  async function verify(
    code: string,
    email = 'Alice@example.com',
    rateLimiter: AuthRateLimitPort = allowAll,
  ) {
    return verifyEmail(dependencies(rateLimiter), {
      email,
      code,
      returnTo: '/tasks',
      clientAddress: '192.0.2.10',
      traceId: 'trace-pg-verify',
    });
  }

  it('creates the first account and stores only code/session digests', async () => {
    const email = await challenge();
    const result = await verify(email.code);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    expect(result.sessionCookie).toMatch(AUTH_SESSION_COOKIE_VALUE_PATTERN);
    expect(result.user.email).toBe('Alice@example.com');
    expect(result.user.account).toMatch(/^creator-[a-z2-7]{8}$/);

    const state = await pool.query<{
      users: number;
      identities: number;
      consumed: number;
      code_digest_bytes: number;
      session_digest_bytes: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM users) AS users,
         (SELECT count(*)::int FROM auth_identities) AS identities,
         (SELECT count(*)::int FROM auth_otp_challenges WHERE consumed_at IS NOT NULL) AS consumed,
         (SELECT octet_length(code_digest) FROM auth_otp_challenges LIMIT 1) AS code_digest_bytes,
         (SELECT octet_length(token_digest) FROM auth_sessions LIMIT 1) AS session_digest_bytes`,
    );
    expect(state.rows[0]).toEqual({
      users: 1,
      identities: 1,
      consumed: 1,
      code_digest_bytes: 32,
      session_digest_bytes: 32,
    });
    const serialized = JSON.stringify(state.rows);
    expect(serialized).not.toContain(email.code);
    expect(serialized).not.toContain(result.sessionCookie);
  });

  it('enforces cooldown before another provider call', async () => {
    await challenge();
    const second = await requestEmailChallenge(dependencies(), {
      email: 'Alice@example.com',
      clientAddress: '192.0.2.10',
      traceId: 'trace-pg-cooldown',
    });
    expect(second.kind).toBe('rate_limited');
    if (second.kind === 'rate_limited') expect(second.retryAfterSeconds).toBeGreaterThan(0);
    expect(mailer.messages).toHaveLength(1);
  });

  it('invalidates the old code only after a successful resend', async () => {
    const first = await challenge();
    await ageChallenges();
    const second = await challenge();
    expect(second.code).not.toBe(first.code);

    await expect(verify(first.code)).resolves.toEqual({ kind: 'invalid_code' });
    const valid = await verify(second.code);
    expect(valid.kind).toBe('ok');
  });

  it('keeps a newer accepted resend active when the older delivery finalizes last', async () => {
    const messages: LoginCodeEmail[] = [];
    let releaseOlder!: () => void;
    let signalOlderStarted!: () => void;
    const olderBlocked = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    const olderStarted = new Promise<void>((resolve) => {
      signalOlderStarted = resolve;
    });
    const delayedMailer: ResendEmailPort = {
      async sendLoginCode(message) {
        messages.push(message);
        if (messages.length === 1) {
          signalOlderStarted();
          await olderBlocked;
        }
        return 'accepted';
      },
    };
    const deps = dependencies();
    deps.mailer = delayedMailer;

    const olderRequest = requestEmailChallenge(deps, {
      email: 'Alice@example.com',
      clientAddress: '192.0.2.10',
      traceId: 'trace-pg-older-delivery',
    });
    await olderStarted;
    const older = messages[0];
    expect(older).toBeDefined();
    await pool.query(
      `UPDATE auth_otp_challenges
          SET created_at = created_at - interval '61 seconds',
              expires_at = expires_at - interval '61 seconds'
        WHERE id = $1`,
      [older!.challengeId],
    );

    const newerResult = await requestEmailChallenge(deps, {
      email: 'Alice@example.com',
      clientAddress: '192.0.2.10',
      traceId: 'trace-pg-newer-delivery',
    });
    expect(newerResult.kind).toBe('accepted');
    const newer = messages[1];
    expect(newer).toBeDefined();

    releaseOlder();
    await expect(olderRequest).resolves.toEqual({ kind: 'accepted' });

    const rows = await pool.query<{
      id: string;
      activated: boolean;
      invalidated: boolean;
    }>(
      `SELECT id,
              activated_at IS NOT NULL AS activated,
              invalidated_at IS NOT NULL AS invalidated
         FROM auth_otp_challenges
        ORDER BY created_at ASC`,
    );
    expect(rows.rows).toEqual([
      { id: older!.challengeId, activated: false, invalidated: true },
      { id: newer!.challengeId, activated: true, invalidated: false },
    ]);

    await expect(verify(older!.code)).resolves.toEqual({ kind: 'invalid_code' });
    await expect(verify(newer!.code)).resolves.toMatchObject({ kind: 'ok' });
  });

  it.each([
    ['permanent_rejection', 'accepted'],
    ['transient_failure', 'dependency_unavailable'],
    ['configuration_failure', 'dependency_unavailable'],
  ] as const)(
    'keeps the old active code when a new provider call returns %s',
    async (delivery, outwardKind) => {
      const first = await challenge();
      await ageChallenges();
      mailer.delivery = delivery;
      const failed = await requestEmailChallenge(dependencies(), {
        email: 'Alice@example.com',
        clientAddress: '192.0.2.10',
        traceId: `trace-pg-provider-${delivery}`,
      });
      expect(failed.kind).toBe(outwardKind);

      const rows = await pool.query<{
        activated: boolean;
        invalidated: boolean;
      }>(
        `SELECT activated_at IS NOT NULL AS activated,
                invalidated_at IS NOT NULL AS invalidated
           FROM auth_otp_challenges
          ORDER BY created_at ASC`,
      );
      expect(rows.rows).toEqual([
        { activated: true, invalidated: false },
        { activated: false, invalidated: true },
      ]);

      mailer.delivery = 'accepted';
      const valid = await verify(first.code);
      expect(valid.kind).toBe('ok');
    },
  );

  it('rolls back old-code invalidation when accepted delivery activation fails', async () => {
    const first = await challenge();
    await ageChallenges();
    const failingActivationPool: TxPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query<_R = Record<string, unknown>>(sql: string, params?: unknown[]) {
            if (sql.includes('SET activated_at = now()')) {
              throw new Error('injected activation failure');
            }
            return client.query(sql, params) as never;
          },
          release: () => client.release(),
        };
      },
    };
    const deps = dependencies();
    deps.db = failingActivationPool;

    await expect(
      requestEmailChallenge(deps, {
        email: 'Alice@example.com',
        clientAddress: '192.0.2.10',
        traceId: 'trace-pg-activation-rollback',
      }),
    ).resolves.toEqual({ kind: 'dependency_unavailable' });
    const deliveredButInactive = mailer.latest();

    const rows = await pool.query<{
      activated: boolean;
      invalidated: boolean;
    }>(
      `SELECT activated_at IS NOT NULL AS activated,
              invalidated_at IS NOT NULL AS invalidated
         FROM auth_otp_challenges
        ORDER BY created_at ASC`,
    );
    expect(rows.rows).toEqual([
      { activated: true, invalidated: false },
      { activated: false, invalidated: false },
    ]);

    await expect(verify(first.code)).resolves.toMatchObject({ kind: 'ok' });
    await expect(verify(deliveredButInactive.code)).resolves.toEqual({ kind: 'invalid_code' });
  });

  it('invalidates a challenge on the fifth wrong attempt', async () => {
    const email = await challenge();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(verify('999999')).resolves.toEqual({ kind: 'invalid_code' });
    }
    await expect(verify(email.code)).resolves.toEqual({ kind: 'invalid_code' });
    const row = await pool.query<{ attempt_count: number; invalidated: boolean }>(
      `SELECT attempt_count, invalidated_at IS NOT NULL AS invalidated
         FROM auth_otp_challenges`,
    );
    expect(row.rows[0]).toEqual({ attempt_count: 5, invalidated: true });
  });

  it('returns the same invalid result after a challenge expires', async () => {
    const email = await challenge();
    await pool.query(
      `UPDATE auth_otp_challenges
          SET created_at = now() - interval '6 minutes',
              activated_at = now() - interval '6 minutes',
              expires_at = now() - interval '1 minute'`,
    );
    await expect(verify(email.code)).resolves.toEqual({ kind: 'invalid_code' });
    const row = await pool.query<{ invalidated: boolean }>(
      'SELECT invalidated_at IS NOT NULL AS invalidated FROM auth_otp_challenges',
    );
    expect(row.rows[0]?.invalidated).toBe(true);
  });

  it('keeps an active challenge usable during a Redis outage without unmatched audit growth', async () => {
    const active = await challenge('active@example.com');
    const expired = await challenge('expired@example.com');
    const invalidated = await challenge('invalidated@example.com');
    await pool.query(
      `UPDATE auth_otp_challenges
          SET created_at = now() - interval '6 minutes',
              activated_at = now() - interval '6 minutes',
              expires_at = now() - interval '1 minute'
        WHERE id = $1`,
      [expired.challengeId],
    );
    await pool.query(
      `UPDATE auth_otp_challenges
          SET invalidated_at = now()
        WHERE id = $1`,
      [invalidated.challengeId],
    );

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(
        verify('999999', 'absent@example.com', verificationRedisOutage),
      ).resolves.toEqual({ kind: 'invalid_code' });
      await expect(
        verify(expired.code, 'expired@example.com', verificationRedisOutage),
      ).resolves.toEqual({ kind: 'invalid_code' });
      await expect(
        verify(invalidated.code, 'invalidated@example.com', verificationRedisOutage),
      ).resolves.toEqual({ kind: 'invalid_code' });
    }

    const beforeSuccess = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM auth_audit_events
        WHERE event_type = 'login_failed'`,
    );
    expect(beforeSuccess.rows[0]?.count).toBe(0);

    await expect(
      verify(active.code, 'active@example.com', verificationRedisOutage),
    ).resolves.toMatchObject({ kind: 'ok' });
    const audit = await pool.query<{ failed: number; succeeded: number }>(
      `SELECT
         count(*) FILTER (WHERE event_type = 'login_failed')::int AS failed,
         count(*) FILTER (WHERE event_type = 'login_succeeded')::int AS succeeded
       FROM auth_audit_events`,
    );
    expect(audit.rows[0]).toEqual({ failed: 0, succeeded: 1 });
  });

  it('allows exactly one concurrent verification to consume a code', async () => {
    const email = await challenge();
    const results = await Promise.all([verify(email.code), verify(email.code)]);
    expect(results.filter((result) => result.kind === 'ok')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'invalid_code')).toHaveLength(1);
    const sessions = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM auth_sessions',
    );
    expect(sessions.rows[0]?.count).toBe(1);
  });

  it('reuses the same user on a later email login and revokes logout idempotently', async () => {
    const first = await challenge();
    const firstLogin = await verify(first.code);
    expect(firstLogin.kind).toBe('ok');
    if (firstLogin.kind !== 'ok') return;

    await ageChallenges();
    const second = await challenge();
    const secondLogin = await verify(second.code);
    expect(secondLogin.kind).toBe('ok');
    if (secondLogin.kind !== 'ok') return;
    expect(secondLogin.user.id).toBe(firstLogin.user.id);

    const before = await resolveAuthSession(pool, secondLogin.sessionCookie);
    expect(before.kind).toBe('valid');
    const digest = Buffer.from(
      await import('node:crypto').then(({ createHash }) => {
        return createHash('sha256').update(secondLogin.sessionCookie, 'ascii').digest();
      }),
    );
    await revokeSession(pool, digest, 'trace-pg-logout');
    await revokeSession(pool, digest, 'trace-pg-logout-repeat');
    await expect(resolveAuthSession(pool, secondLogin.sessionCookie)).resolves.toEqual({
      kind: 'invalid',
    });
    const audit = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM auth_audit_events WHERE event_type = 'logout'`,
    );
    expect(audit.rows[0]?.count).toBe(1);
  });

  it('consumes a valid code but refuses to sign a session for a disabled account', async () => {
    const first = await challenge();
    const login = await verify(first.code);
    expect(login.kind).toBe('ok');
    if (login.kind !== 'ok') return;

    await ageChallenges();
    const next = await challenge();
    await pool.query('UPDATE users SET disabled_at = now() WHERE id = $1', [login.user.id]);
    await expect(verify(next.code)).resolves.toEqual({ kind: 'account_disabled' });

    const state = await pool.query<{ sessions: number; consumed: number }>(
      `SELECT
         (SELECT count(*)::int FROM auth_sessions) AS sessions,
         (SELECT count(*)::int FROM auth_otp_challenges WHERE consumed_at IS NOT NULL) AS consumed`,
    );
    expect(state.rows[0]).toEqual({ sessions: 1, consumed: 2 });
    await expect(resolveAuthSession(pool, login.sessionCookie)).resolves.toEqual({
      kind: 'disabled',
    });
  });
});
