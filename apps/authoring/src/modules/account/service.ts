import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { MeView, ParsedEmailVerificationBody } from '@cb/shared';
import type { TxPool } from '../../platform/infra/db-tx.js';
import type { AuthRateLimitPort } from '../../platform/infra/auth-rate-limit.js';
import type { ResendDeliveryResult, ResendEmailPort } from '../../platform/infra/resend.js';
import {
  digestClientAddress,
  digestEmailCode,
  digestEmailTarget,
  digestSessionCookieValue,
  generateCreatorAccount,
  generateEmailOtp,
  generateSessionCookieValue,
  normalizeEmailAddress,
  type RandomBytes,
  type RandomInteger,
} from './auth-crypto.js';
import {
  finalizeEmailChallenge,
  insertPendingEmailChallenge,
  verifyEmailChallenge,
} from './repo.js';

export interface AccountAuthDependencies {
  db: TxPool;
  mailer: ResendEmailPort;
  rateLimiter: AuthRateLimitPort;
  hmacSecret: string;
  randomBytes?: RandomBytes;
  randomInteger?: RandomInteger;
  randomId?: () => string;
}

export type ChallengeServiceResult =
  | { kind: 'accepted' }
  | { kind: 'invalid_input' }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'dependency_unavailable' };

function dependenciesReady(deps: AccountAuthDependencies): boolean {
  return deps.hmacSecret.length >= 32;
}

/** 创建 pending challenge、事务外投递，再按投递分类完成第二段事务。 */
export async function requestEmailChallenge(
  deps: AccountAuthDependencies,
  input: { email: string; clientAddress: string; traceId: string },
): Promise<ChallengeServiceResult> {
  const email = normalizeEmailAddress(input.email);
  if (!email) return { kind: 'invalid_input' };
  if (!dependenciesReady(deps)) return { kind: 'dependency_unavailable' };

  const targetDigest = digestEmailTarget(deps.hmacSecret, email);
  const clientDigest = digestClientAddress(deps.hmacSecret, input.clientAddress);

  try {
    const softLimit = await deps.rateLimiter.consumeChallenge(clientDigest);
    if (!softLimit.allowed) {
      return {
        kind: 'rate_limited',
        retryAfterSeconds: Math.max(1, Math.ceil(softLimit.retryAfterSeconds)),
      };
    }
  } catch {
    // 新 challenge 在 Redis 软窗口不可用时失败关闭，避免按轮换目标绕过客户端限流。
    return { kind: 'dependency_unavailable' };
  }

  const code = generateEmailOtp(deps.randomInteger ?? randomInt);
  const codeDigest = digestEmailCode(deps.hmacSecret, targetDigest, code);
  const challengeId = (deps.randomId ?? randomUUID)();

  try {
    const inserted = await insertPendingEmailChallenge(deps.db, {
      challengeId,
      targetDigest,
      codeDigest,
    });
    if (inserted.kind === 'rate_limited') return inserted;
  } catch {
    return { kind: 'dependency_unavailable' };
  }

  let delivery: ResendDeliveryResult;
  try {
    delivery = await deps.mailer.sendLoginCode({ challengeId, to: email, code });
  } catch {
    delivery = 'transient_failure';
  }
  try {
    await finalizeEmailChallenge(deps.db, {
      challengeId,
      targetDigest,
      delivery,
      traceId: input.traceId,
    });
  } catch {
    return { kind: 'dependency_unavailable' };
  }

  if (delivery === 'accepted' || delivery === 'permanent_rejection') {
    return { kind: 'accepted' };
  }
  return { kind: 'dependency_unavailable' };
}

export type VerificationServiceResult =
  | { kind: 'ok'; user: MeView; sessionCookie: string; returnTo: string }
  | { kind: 'invalid_input' }
  | { kind: 'invalid_code' }
  | { kind: 'account_disabled' }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'dependency_unavailable' };

/** 已有 challenge 的验证码验证不因 Redis 故障中断；PostgreSQL 五次硬上限始终生效。 */
export async function verifyEmail(
  deps: AccountAuthDependencies,
  input: ParsedEmailVerificationBody & {
    clientAddress: string;
    traceId: string;
    currentSessionCookie?: string;
  },
): Promise<VerificationServiceResult> {
  const email = normalizeEmailAddress(input.email);
  if (!email || !/^[0-9]{6}$/.test(input.code)) return { kind: 'invalid_input' };
  if (!dependenciesReady(deps)) return { kind: 'dependency_unavailable' };

  const targetDigest = digestEmailTarget(deps.hmacSecret, email);
  const clientDigest = digestClientAddress(deps.hmacSecret, input.clientAddress);
  try {
    const limit = await deps.rateLimiter.consumeVerification(targetDigest, clientDigest);
    if (!limit.allowed) {
      return {
        kind: 'rate_limited',
        retryAfterSeconds: Math.max(1, Math.ceil(limit.retryAfterSeconds)),
      };
    }
  } catch {
    // 验证仍由 challenge 行锁、一次消费和五次失败上限保护，Redis 只提供附加软窗口。
  }

  const candidateCodeDigest = digestEmailCode(deps.hmacSecret, targetDigest, input.code);
  const sessionCookie = generateSessionCookieValue(deps.randomBytes ?? randomBytes);
  const sessionDigest = digestSessionCookieValue(sessionCookie);
  if (!sessionDigest) return { kind: 'dependency_unavailable' };
  const currentSessionDigest = digestSessionCookieValue(input.currentSessionCookie);

  let verified;
  try {
    verified = await verifyEmailChallenge(deps.db, {
      email,
      targetDigest,
      candidateCodeDigest,
      sessionDigest,
      currentSessionDigest,
      traceId: input.traceId,
      accountCandidate: () => generateCreatorAccount(deps.randomBytes ?? randomBytes),
    });
  } catch {
    return { kind: 'dependency_unavailable' };
  }

  if (verified.kind === 'invalid') return { kind: 'invalid_code' };
  if (verified.kind === 'disabled') return { kind: 'account_disabled' };
  return {
    kind: 'ok',
    user: verified.user,
    sessionCookie,
    returnTo: input.returnTo,
  };
}
