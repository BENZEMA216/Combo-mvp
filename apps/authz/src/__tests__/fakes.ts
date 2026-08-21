// 内存版 AuthzStore / SessionCache / OtpMailer：忠实复刻 repo.ts、cache.ts 与
// resend.ts 端口语义，供不依赖 PostgreSQL / Redis / Resend 的单元与路由测试注入。
import { OTP_MAX_ATTEMPTS } from '../crypto.js';
import type { LoginCodeMessage, OtpDeliveryResult, OtpMailer } from '../resend.js';
import type { AuthzStore, ResolvedSession, SessionCache } from '../service.js';

export interface FakeChallenge {
  targetDigest: Buffer;
  codeDigest: Buffer;
  expiresAt: Date;
  attempts: number;
  consumed: boolean;
  invalidated: boolean;
}

export function createFakeStore(now: () => number = () => Date.now()) {
  const state = {
    challenges: [] as FakeChallenge[],
    usersByEmail: new Map<string, string>(),
    sessions: new Map<string, ResolvedSession & { revoked: boolean }>(),
    resolveCalls: 0,
    revokeCalls: 0,
    nextUser: 0,
  };

  const store: AuthzStore = {
    async replaceChallenge({ targetDigest, codeDigest, expiresAt }) {
      for (const challenge of state.challenges) {
        if (
          challenge.targetDigest.equals(targetDigest) &&
          !challenge.consumed &&
          !challenge.invalidated
        ) {
          challenge.invalidated = true;
        }
      }
      state.challenges.push({
        targetDigest,
        codeDigest,
        expiresAt,
        attempts: 0,
        consumed: false,
        invalidated: false,
      });
    },
    async consumeChallenge({ targetDigest, candidateCodeDigest }) {
      const challenge = [...state.challenges]
        .reverse()
        .find(
          (candidate) =>
            candidate.targetDigest.equals(targetDigest) &&
            !candidate.consumed &&
            !candidate.invalidated &&
            candidate.expiresAt.getTime() > now(),
        );
      if (!challenge) return false;
      if (challenge.codeDigest.equals(candidateCodeDigest)) {
        challenge.consumed = true;
        return true;
      }
      challenge.attempts += 1;
      if (challenge.attempts >= OTP_MAX_ATTEMPTS) challenge.invalidated = true;
      return false;
    },
    async findOrCreateEmailUser(email) {
      const existing = state.usersByEmail.get(email);
      if (existing) return existing;
      const userId = `user-${(state.nextUser += 1)}`;
      state.usersByEmail.set(email, userId);
      return userId;
    },
    async insertSession({ userId, tokenDigest, expiresAt }) {
      const session = {
        sessionId: `session-${state.sessions.size + 1}`,
        userId,
        expiresAt,
        revoked: false,
      };
      state.sessions.set(tokenDigest.toString('hex'), session);
      return session;
    },
    async resolveSession(tokenDigest) {
      state.resolveCalls += 1;
      const session = state.sessions.get(tokenDigest.toString('hex'));
      if (!session || session.revoked || session.expiresAt.getTime() <= now()) return null;
      return session;
    },
    async revokeSession(tokenDigest) {
      state.revokeCalls += 1;
      const session = state.sessions.get(tokenDigest.toString('hex'));
      if (session) session.revoked = true;
    },
  };
  return { store, state };
}

export function createFakeCache() {
  const state = {
    entries: new Map<string, ResolvedSession>(),
    failReads: false,
    getCalls: 0,
    setCalls: 0,
    delCalls: 0,
  };
  const cache: SessionCache = {
    async get(tokenDigest) {
      state.getCalls += 1;
      if (state.failReads) throw new Error('redis down');
      return state.entries.get(tokenDigest.toString('hex')) ?? null;
    },
    async set(session, tokenDigest) {
      state.setCalls += 1;
      state.entries.set(tokenDigest.toString('hex'), session);
    },
    async del(tokenDigest) {
      state.delCalls += 1;
      state.entries.delete(tokenDigest.toString('hex'));
    },
  };
  return { cache, state };
}

/** 内存版发信端口：记录每次投递请求，可按收件人预设投递结果分类。 */
export function createFakeMailer() {
  const state = {
    messages: [] as LoginCodeMessage[],
    results: new Map<string, OtpDeliveryResult>(),
    defaultResult: 'accepted' as OtpDeliveryResult,
  };
  const mailer: OtpMailer = {
    async sendLoginCode(message) {
      state.messages.push(message);
      return state.results.get(message.to) ?? state.defaultResult;
    },
  };
  return { mailer, state };
}
