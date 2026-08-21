import { describe, expect, it } from 'vitest';
import {
  OTP_MAX_ATTEMPTS,
  V2_SESSION_COOKIE_VALUE_PATTERN,
  digestEmailCode,
  digestEmailTarget,
  digestSessionCookieValue,
} from '../crypto.js';
import {
  logout,
  requestOtp,
  resolveSession,
  verifyOtp,
  type AuthzServiceDependencies,
  type ResolvedSession,
} from '../service.js';
import { createFakeCache, createFakeMailer, createFakeStore } from './fakes.js';

const SECRET = 's'.repeat(32);
const DEV_CODE = '246810';
const EMAIL = 'user@example.com';

function makeDeps(overrides: Partial<AuthzServiceDependencies> = {}) {
  const now = () => overrides.now?.() ?? Date.now();
  const { store, state: storeState } = createFakeStore(now);
  const { cache, state: cacheState } = createFakeCache();
  const deps: AuthzServiceDependencies = {
    store,
    cache,
    hmacSecret: SECRET,
    devOtpCode: DEV_CODE,
    ...overrides,
  };
  return { deps, storeState, cacheState };
}

async function login(deps: AuthzServiceDependencies, email = EMAIL) {
  await requestOtp(deps, { email });
  return verifyOtp(deps, { email, code: DEV_CODE });
}

describe('dev OTP login（未配发信通道，挑战写万能码）', () => {
  it('creates the user and email identity on first login and reuses them later', async () => {
    const { deps, storeState } = makeDeps();

    const first = await login(deps);
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    expect(V2_SESSION_COOKIE_VALUE_PATTERN.test(first.sessionCookie)).toBe(true);
    expect(storeState.usersByEmail.get(EMAIL)).toBe(first.userId);

    const second = await login(deps);
    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok') return;
    expect(second.userId).toBe(first.userId);
    expect(second.sessionCookie).not.toBe(first.sessionCookie);
    expect(storeState.usersByEmail.size).toBe(1);
    expect(storeState.sessions.size).toBe(2);
  });

  it('normalizes the email before digesting and storing the identity', async () => {
    const { deps, storeState } = makeDeps();
    const result = await requestOtp(deps, { email: '  User@Example.COM ' });
    expect(result.kind).toBe('accepted');

    const challenge = storeState.challenges[0]!;
    const targetDigest = digestEmailTarget(SECRET, EMAIL);
    expect(challenge.targetDigest.equals(targetDigest)).toBe(true);
    expect(challenge.codeDigest.equals(digestEmailCode(SECRET, targetDigest, DEV_CODE))).toBe(true);

    const verified = await verifyOtp(deps, { email: 'USER@example.com', code: DEV_CODE });
    expect(verified.kind).toBe('ok');
    if (verified.kind !== 'ok') return;
    expect(storeState.usersByEmail.get(EMAIL)).toBe(verified.userId);
  });

  it('stores only digests for the challenge, never the plaintext code', async () => {
    const { deps, storeState } = makeDeps();

    const result = await requestOtp(deps, { email: EMAIL });
    expect(result.kind).toBe('accepted');

    const challenge = storeState.challenges[0]!;
    const targetDigest = digestEmailTarget(SECRET, EMAIL);
    expect(challenge.targetDigest.equals(targetDigest)).toBe(true);
    expect(challenge.codeDigest.equals(digestEmailCode(SECRET, targetDigest, DEV_CODE))).toBe(true);
  });

  it('rejects a wrong code and locks the challenge after five attempts', async () => {
    const { deps, storeState } = makeDeps();
    await requestOtp(deps, { email: EMAIL });

    for (let attempt = 1; attempt <= OTP_MAX_ATTEMPTS; attempt += 1) {
      const result = await verifyOtp(deps, { email: EMAIL, code: '000000' });
      expect(result.kind).toBe('invalid_code');
    }
    expect(storeState.challenges[0]!.invalidated).toBe(true);

    const afterLock = await verifyOtp(deps, { email: EMAIL, code: DEV_CODE });
    expect(afterLock.kind).toBe('invalid_code');
  });

  it('rejects an expired challenge', async () => {
    let clock = 1_000_000;
    const { deps } = makeDeps({ now: () => clock });
    await requestOtp(deps, { email: EMAIL });

    clock += 6 * 60 * 1000;
    const result = await verifyOtp(deps, { email: EMAIL, code: DEV_CODE });
    expect(result.kind).toBe('invalid_code');
  });

  it('a fresh challenge invalidates the previous unfinished one', async () => {
    const { deps, storeState } = makeDeps();
    await requestOtp(deps, { email: EMAIL });
    await requestOtp(deps, { email: EMAIL });

    expect(storeState.challenges).toHaveLength(2);
    expect(storeState.challenges[0]!.invalidated).toBe(true);
    const result = await verifyOtp(deps, { email: EMAIL, code: DEV_CODE });
    expect(result.kind).toBe('ok');
  });

  it('is unavailable without a dev code when no mailer is configured', async () => {
    const noCode = makeDeps({ devOtpCode: undefined });
    expect((await requestOtp(noCode.deps, { email: EMAIL })).kind).toBe('unavailable');

    const weakSecret = makeDeps({ hmacSecret: 'short' });
    expect((await requestOtp(weakSecret.deps, { email: EMAIL })).kind).toBe('unavailable');
    expect((await verifyOtp(weakSecret.deps, { email: EMAIL, code: DEV_CODE })).kind).toBe(
      'unavailable',
    );
  });

  it('rejects malformed email or code without touching the store', async () => {
    const { deps, storeState } = makeDeps();
    expect((await requestOtp(deps, { email: 'not-an-email' })).kind).toBe('invalid_input');
    expect((await verifyOtp(deps, { email: EMAIL, code: '12' })).kind).toBe('invalid_input');
    expect((await verifyOtp(deps, { email: 'a@', code: DEV_CODE })).kind).toBe('invalid_input');
    expect(storeState.challenges).toHaveLength(0);
  });
});

describe('email delivery login（配置发信通道）', () => {
  it('delivers a random code by email and verifies it, never the dev code in the message', async () => {
    const { deps, storeState } = makeDeps();
    const { mailer, state: mailerState } = createFakeMailer();
    deps.mailer = mailer;

    const requested = await requestOtp(deps, { email: EMAIL });
    expect(requested.kind).toBe('accepted');
    expect(mailerState.messages).toHaveLength(1);
    const sent = mailerState.messages[0]!;
    expect(sent.to).toBe(EMAIL);
    expect(sent.code).toMatch(/^[0-9]{6}$/);
    expect(sent.challengeId).toBeTruthy();
    // 邮件里是随机码，不是万能码；挑战落库的是随机码摘要。
    expect(sent.code).not.toBe(DEV_CODE);
    const targetDigest = digestEmailTarget(SECRET, EMAIL);
    expect(
      storeState.challenges[0]!.codeDigest.equals(digestEmailCode(SECRET, targetDigest, sent.code)),
    ).toBe(true);

    const verified = await verifyOtp(deps, { email: EMAIL, code: sent.code });
    expect(verified.kind).toBe('ok');
  });

  it('keeps the dev code usable even when the mailer is configured（万能码旁路）', async () => {
    const { deps } = makeDeps();
    const { mailer, state: mailerState } = createFakeMailer();
    deps.mailer = mailer;

    await requestOtp(deps, { email: EMAIL });
    expect(mailerState.messages[0]!.code).not.toBe(DEV_CODE);

    const verified = await verifyOtp(deps, { email: EMAIL, code: DEV_CODE });
    expect(verified.kind).toBe('ok');
  });

  it('maps transient and configuration delivery failures to unavailable', async () => {
    const { deps, storeState } = makeDeps();
    const { mailer, state: mailerState } = createFakeMailer();
    deps.mailer = mailer;

    mailerState.defaultResult = 'transient_failure';
    expect((await requestOtp(deps, { email: EMAIL })).kind).toBe('unavailable');

    mailerState.defaultResult = 'configuration_failure';
    expect((await requestOtp(deps, { email: EMAIL })).kind).toBe('unavailable');
    // 失败不落库挑战，也不回退明文码。
    expect(storeState.challenges).toHaveLength(0);
  });

  it('returns a uniform acceptance for permanent rejections without storing a challenge', async () => {
    const { deps, storeState } = makeDeps();
    const { mailer, state: mailerState } = createFakeMailer();
    deps.mailer = mailer;
    mailerState.results.set(EMAIL, 'permanent_rejection');

    const result = await requestOtp(deps, { email: EMAIL });
    expect(result.kind).toBe('accepted');
    expect(storeState.challenges).toHaveLength(0);
    // 没有挑战可消费，真实验证码不能登录该邮箱（万能码旁路不受此限，见旁路用例）。
    expect((await verifyOtp(deps, { email: EMAIL, code: '000000' })).kind).toBe('invalid_code');
  });
});

describe('session resolution', () => {
  it('serves cached sessions without touching PostgreSQL', async () => {
    const { deps, cacheState, storeState } = makeDeps();
    const loginResult = await login(deps);
    if (loginResult.kind !== 'ok') throw new Error('login failed');
    storeState.resolveCalls = 0;

    const resolved = await resolveSession(deps, loginResult.sessionCookie);
    expect(resolved?.userId).toBe(loginResult.userId);
    expect(storeState.resolveCalls).toBe(0);
    expect(cacheState.getCalls).toBe(1);
  });

  it('falls back to PostgreSQL on a cache miss and backfills the cache', async () => {
    const { deps, cacheState, storeState } = makeDeps();
    const loginResult = await login(deps);
    if (loginResult.kind !== 'ok') throw new Error('login failed');
    cacheState.entries.clear();
    cacheState.setCalls = 0;

    const resolved = await resolveSession(deps, loginResult.sessionCookie);
    expect(resolved?.userId).toBe(loginResult.userId);
    expect(storeState.resolveCalls).toBe(1);
    expect(cacheState.setCalls).toBe(1);
    expect(
      cacheState.entries.has(digestSessionCookieValue(loginResult.sessionCookie)!.toString('hex')),
    ).toBe(true);
  });

  it('treats Redis read failures as a cache miss (Redis 抖动回源 PostgreSQL)', async () => {
    const { deps, cacheState } = makeDeps();
    const loginResult = await login(deps);
    if (loginResult.kind !== 'ok') throw new Error('login failed');
    cacheState.failReads = true;

    const resolved = await resolveSession(deps, loginResult.sessionCookie);
    expect(resolved?.userId).toBe(loginResult.userId);
  });

  it('returns null for unknown, malformed, or revoked sessions', async () => {
    const { deps, storeState } = makeDeps();
    expect(await resolveSession(deps, undefined)).toBeNull();
    expect(await resolveSession(deps, 'garbage')).toBeNull();

    const loginResult = await login(deps);
    if (loginResult.kind !== 'ok') throw new Error('login failed');
    await logout(deps, loginResult.sessionCookie);

    expect(storeState.revokeCalls).toBe(1);
    expect(await resolveSession(deps, loginResult.sessionCookie)).toBeNull();
  });

  it('drops an expired cached entry and falls back to the store', async () => {
    const { deps, cacheState } = makeDeps();
    const loginResult = await login(deps);
    if (loginResult.kind !== 'ok') throw new Error('login failed');
    const digest = digestSessionCookieValue(loginResult.sessionCookie)!;
    const stale: ResolvedSession = {
      sessionId: 'session-stale',
      userId: loginResult.userId,
      expiresAt: new Date(Date.now() - 1000),
    };
    cacheState.entries.set(digest.toString('hex'), stale);

    const resolved = await resolveSession(deps, loginResult.sessionCookie);
    expect(resolved?.userId).toBe(loginResult.userId);
    expect(resolved?.sessionId).not.toBe('session-stale');
    expect(cacheState.delCalls).toBe(1);
  });

  it('logout is idempotent for missing or malformed cookies', async () => {
    const { deps, storeState } = makeDeps();
    await logout(deps, undefined);
    await logout(deps, 'garbage');
    expect(storeState.revokeCalls).toBe(0);
  });
});
