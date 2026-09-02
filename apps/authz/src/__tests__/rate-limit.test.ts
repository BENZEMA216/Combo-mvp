import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { createRedisOtpRateLimiter, digestOtpRateLimitClient } from '../rate-limit.js';

describe('Redis OTP target limiter', () => {
  it('atomically limits challenge targets and clients without storing raw identifiers', async () => {
    const evalCommand = vi.fn().mockResolvedValueOnce([0, 0]).mockResolvedValueOnce([1, 47]);
    const limiter = createRedisOtpRateLimiter({ eval: evalCommand } as unknown as Redis);
    const targetDigest = Buffer.alloc(32, 0xab);
    const clientDigest = Buffer.alloc(32, 0xcd);

    await expect(limiter.consume('challenge', targetDigest, clientDigest)).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    await expect(limiter.consume('challenge', targetDigest, clientDigest)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 47,
    });
    expect(evalCommand).toHaveBeenCalledTimes(2);
    const [, keyCount, clientKey, cooldownKey, targetKey, ...limits] = evalCommand.mock.calls[0]!;
    expect(keyCount).toBe(3);
    expect(cooldownKey).toContain(targetDigest.toString('hex'));
    expect(targetKey).toContain(targetDigest.toString('hex'));
    expect(clientKey).toContain(clientDigest.toString('hex'));
    expect(limits).toEqual([3600, 20, 60, 1, 3600, 5]);
  });

  it('uses a separate HMAC domain and target/client budgets for verification', async () => {
    const evalCommand = vi.fn().mockResolvedValue([0, 0]);
    const limiter = createRedisOtpRateLimiter({ eval: evalCommand } as unknown as Redis);
    const clientDigest = digestOtpRateLimitClient('s'.repeat(32), '203.0.113.4');

    expect(clientDigest).toHaveLength(32);
    expect(clientDigest.toString('utf8')).not.toContain('203.0.113.4');
    await limiter.consume('verification', Buffer.alloc(32, 1), clientDigest);
    const [, keyCount, , , ...limits] = evalCommand.mock.calls[0]!;
    expect(keyCount).toBe(2);
    expect(limits).toEqual([600, 50, 600, 10]);
  });

  it('fails closed on an invalid Redis response', async () => {
    const limiter = createRedisOtpRateLimiter({
      eval: vi.fn().mockResolvedValue(0),
    } as unknown as Redis);
    await expect(
      limiter.consume('verification', Buffer.alloc(32), Buffer.alloc(32)),
    ).rejects.toThrow(/invalid OTP rate-limit response/);
  });
});
