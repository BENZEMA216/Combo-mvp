import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { createRedisAuthRateLimiter } from '../platform/infra/auth-rate-limit.js';

const TARGET = Buffer.alloc(32, 1);
const CLIENT = Buffer.alloc(32, 2);

describe('Redis authentication soft limits', () => {
  it('limits challenge requests only by the digest of the client address', async () => {
    const evalMock = vi.fn().mockResolvedValue([21, 59_001]);
    const limiter = createRedisAuthRateLimiter({ eval: evalMock } as unknown as Redis);

    await expect(limiter.consumeChallenge(CLIENT)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
    expect(evalMock).toHaveBeenCalledWith(
      expect.any(String),
      1,
      `auth:rate:v1:challenge-client:${CLIENT.toString('hex')}`,
      String(60 * 60 * 1_000),
    );
    const serialized = JSON.stringify(evalMock.mock.calls);
    expect(serialized).not.toContain('challenge-target');
    expect(serialized).not.toContain(TARGET.toString('hex'));
    expect(serialized).not.toContain('192.0.2.1');
    expect(serialized).not.toContain('@');
  });

  it('does not turn six PostgreSQL cooldown retries into a target-wide Redis lockout', async () => {
    let count = 0;
    const evalMock = vi.fn().mockImplementation(async () => {
      count += 1;
      return [count, 3_600_000];
    });
    const limiter = createRedisAuthRateLimiter({ eval: evalMock } as unknown as Redis);

    for (let retry = 0; retry < 6; retry += 1) {
      await expect(limiter.consumeChallenge(CLIENT)).resolves.toEqual({
        allowed: true,
        retryAfterSeconds: 1,
      });
    }
    expect(evalMock).toHaveBeenCalledTimes(6);
    expect(JSON.stringify(evalMock.mock.calls)).not.toContain('challenge-target');
  });

  it('atomically checks target and client verification windows', async () => {
    const evalMock = vi.fn().mockResolvedValue([11, 120_001, 2, 500_000]);
    const limiter = createRedisAuthRateLimiter({ eval: evalMock } as unknown as Redis);

    await expect(limiter.consumeVerification(TARGET, CLIENT)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 121,
    });
    expect(evalMock).toHaveBeenCalledWith(
      expect.any(String),
      2,
      `auth:rate:v1:verification-target:${TARGET.toString('hex')}`,
      `auth:rate:v1:verification-client:${CLIENT.toString('hex')}`,
      String(10 * 60 * 1_000),
    );
  });
});
