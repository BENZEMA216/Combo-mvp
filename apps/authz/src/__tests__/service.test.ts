import { describe, expect, it } from 'vitest';
import {
  OTP_MAX_ATTEMPTS,
  V2_SESSION_COOKIE_VALUE_PATTERN,
  digestPhoneCode,
  digestPhoneTarget,
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
import { createFakeCache, createFakeStore } from './fakes.js';

const SECRET = 's'.repeat(32);
const DEV_CODE = '246810';
const PHONE = '13800138000';

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

async function login(deps: AuthzServiceDependencies, phone = PHONE) {
  await requestOtp(deps, { phone });
  return verifyOtp(deps, { phone, code: DEV_CODE });
}

describe('dev OTP login', () => {
  it('creates the user and phone identity on first login and reuses them later', async () => {
    const { deps, storeState } = makeDeps();

    const first = await login(deps);
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    expect(V2_SESSION_COOKIE_VALUE_PATTERN.test(first.sessionCookie)).toBe(true);
    expect(storeState.usersByPhone.get(PHONE)).toBe(first.userId);

    const second = await login(deps);
    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok') return;
    expect(second.userId).toBe(first.userId);
    expect(second.sessionCookie).not.toBe(first.sessionCookie);
    expect(storeState.usersByPhone.size).toBe(1);
    expect(storeState.sessions.size).toBe(2);
  });

  it('stores only digests for the challenge, never the plaintext code', async () => {
    const { deps, storeState } = makeDeps();

    const result = await requestOtp(deps, { phone: PHONE });
    expect(result.kind).toBe('accepted');

    const challenge = storeState.challenges[0]!;
    const targetDigest = digestPhoneTarget(SECRET, PHONE);
    expect(challenge.targetDigest.equals(targetDigest)).toBe(true);
    expect(challenge.codeDigest.equals(digestPhoneCode(SECRET, targetDigest, DEV_CODE))).toBe(true);
  });

  it('rejects a wrong code and locks the challenge after five attempts', async () => {
    const { deps, storeState } = makeDeps();
    await requestOtp(deps, { phone: PHONE });

    for (let attempt = 1; attempt <= OTP_MAX_ATTEMPTS; attempt += 1) {
      const result = await verifyOtp(deps, { phone: PHONE, code: '000000' });
      expect(result.kind).toBe('invalid_code');
    }
    expect(storeState.challenges[0]!.invalidated).toBe(true);

    const afterLock = await verifyOtp(deps, { phone: PHONE, code: DEV_CODE });
    expect(afterLock.kind).toBe('invalid_code');
  });

  it('rejects an expired challenge', async () => {
    let clock = 1_000_000;
    const { deps } = makeDeps({ now: () => clock });
    await requestOtp(deps, { phone: PHONE });

    clock += 6 * 60 * 1000;
    const result = await verifyOtp(deps, { phone: PHONE, code: DEV_CODE });
    expect(result.kind).toBe('invalid_code');
  });

  it('a fresh challenge invalidates the previous unfinished one', async () => {
    const { deps, storeState } = makeDeps();
    await requestOtp(deps, { phone: PHONE });
    await requestOtp(deps, { phone: PHONE });

    expect(storeState.challenges).toHaveLength(2);
    expect(storeState.challenges[0]!.invalidated).toBe(true);
    const result = await verifyOtp(deps, { phone: PHONE, code: DEV_CODE });
    expect(result.kind).toBe('ok');
  });

  it('is unavailable without a configured dev code or a strong hmac secret', async () => {
    const noCode = makeDeps({ devOtpCode: undefined });
    expect((await requestOtp(noCode.deps, { phone: PHONE })).kind).toBe('unavailable');

    const weakSecret = makeDeps({ hmacSecret: 'short' });
    expect((await requestOtp(weakSecret.deps, { phone: PHONE })).kind).toBe('unavailable');
    expect((await verifyOtp(weakSecret.deps, { phone: PHONE, code: DEV_CODE })).kind).toBe(
      'unavailable',
    );
  });

  it('rejects malformed phone or code without touching the store', async () => {
    const { deps, storeState } = makeDeps();
    expect((await requestOtp(deps, { phone: 'not-a-phone' })).kind).toBe('invalid_input');
    expect((await verifyOtp(deps, { phone: PHONE, code: '12' })).kind).toBe('invalid_input');
    expect((await verifyOtp(deps, { phone: '0123', code: DEV_CODE })).kind).toBe('invalid_input');
    expect(storeState.challenges).toHaveLength(0);
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
