import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digestEmailTarget } from '../crypto.js';
import { createRedisOtpRateLimiter, digestOtpRateLimitClient } from '../rate-limit.js';

const redisUrl = process.env.AUTHZ_RATE_LIMIT_REDIS_URL;
const enabled = process.env.AUTHZ_RATE_LIMIT_REDIS_TEST === '1' && Boolean(redisUrl);
const redisDescribe = enabled ? describe : describe.skip;

redisDescribe('Redis-backed OTP rate limits', () => {
  let redis: Redis;
  const hmacSecret = randomBytes(32).toString('hex');

  beforeAll(async () => {
    redis = new Redis(redisUrl!, { maxRetriesPerRequest: 1 });
    await redis.ping();
  });

  afterAll(async () => {
    await redis?.quit();
  });

  it('enforces the challenge cooldown without exposing raw email or IP keys', async () => {
    const limiter = createRedisOtpRateLimiter(redis);
    const email = `target-${randomBytes(6).toString('hex')}@example.com`;
    const address = `198.51.100.${randomBytes(1)[0]}`;
    const targetDigest = digestEmailTarget(hmacSecret, email);
    const clientDigest = digestOtpRateLimitClient(hmacSecret, address);

    await expect(limiter.consume('challenge', targetDigest, clientDigest)).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    const second = await limiter.consume('challenge', targetDigest, clientDigest);
    expect(second.allowed).toBe(false);
    expect(second.retryAfterSeconds).toBeGreaterThan(0);
    expect(second.retryAfterSeconds).toBeLessThanOrEqual(60);

    const keys = await redis.keys('authz:v2:otp-rate:challenge:*');
    expect(keys).toHaveLength(3);
    for (const key of keys) {
      expect(key).not.toContain(email);
      expect(key).not.toContain(address);
    }
  });

  it('enforces the independent per-client challenge budget', async () => {
    const limiter = createRedisOtpRateLimiter(redis);
    const clientDigest = digestOtpRateLimitClient(hmacSecret, `203.0.113.${randomBytes(1)[0]}`);
    for (let index = 0; index < 20; index += 1) {
      const targetDigest = digestEmailTarget(
        hmacSecret,
        `client-budget-${index}-${randomBytes(5).toString('hex')}@example.com`,
      );
      await expect(limiter.consume('challenge', targetDigest, clientDigest)).resolves.toEqual({
        allowed: true,
        retryAfterSeconds: 0,
      });
    }

    const targetKeysBefore = await redis.keys('authz:v2:otp-rate:challenge:target-*');
    for (let index = 0; index < 50; index += 1) {
      const blocked = await limiter.consume(
        'challenge',
        digestEmailTarget(
          hmacSecret,
          `blocked-${index}-${randomBytes(5).toString('hex')}@example.com`,
        ),
        clientDigest,
      );
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
      expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(3600);
    }
    const targetKeysAfter = await redis.keys('authz:v2:otp-rate:challenge:target-*');
    expect(targetKeysAfter).toHaveLength(targetKeysBefore.length);
  });

  it('enforces the verification target budget at the eleventh attempt', async () => {
    const limiter = createRedisOtpRateLimiter(redis);
    const targetDigest = digestEmailTarget(
      hmacSecret,
      `verification-${randomBytes(6).toString('hex')}@example.com`,
    );
    const clientDigest = digestOtpRateLimitClient(hmacSecret, `192.0.2.${randomBytes(1)[0]}`);
    for (let index = 0; index < 10; index += 1) {
      await expect(limiter.consume('verification', targetDigest, clientDigest)).resolves.toEqual({
        allowed: true,
        retryAfterSeconds: 0,
      });
    }

    const blocked = await limiter.consume('verification', targetDigest, clientDigest);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(600);
  });
});
