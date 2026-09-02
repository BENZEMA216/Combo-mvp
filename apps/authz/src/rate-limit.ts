// OTP 目标与客户端双维限流。所有 Redis key 只使用域分离 HMAC 摘要，
// 不保存原始邮箱或客户端地址；Redis 故障向上抛出，认证入口 fail-closed。
import { createHmac } from 'node:crypto';
import type { Redis } from 'ioredis';

export type OtpRateLimitOperation = 'challenge' | 'verification';

export interface OtpRateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface OtpRateLimiter {
  consume(
    operation: OtpRateLimitOperation,
    targetDigest: Buffer,
    clientDigest: Buffer,
  ): Promise<OtpRateLimitResult>;
}

interface LimitRule {
  name: string;
  digest: Buffer;
  limit: number;
  windowSeconds: number;
}

const LIMITS = Object.freeze({
  challenge: Object.freeze({ cooldownSeconds: 60, targetPerHour: 5, clientPerHour: 20 }),
  verification: Object.freeze({ targetPerWindow: 10, clientPerWindow: 50, windowSeconds: 600 }),
});

const CONSUME_SCRIPT = `
local client_window = tonumber(ARGV[1])
local client_limit = tonumber(ARGV[2])
local client_current = redis.call('INCR', KEYS[1])
if client_current == 1 or redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], client_window)
end
if client_current > client_limit then
  return { 1, redis.call('TTL', KEYS[1]) }
end

local limited = 0
local retry_after = 0
for index = 2, #KEYS do
  local offset = (index - 1) * 2
  local window = tonumber(ARGV[offset + 1])
  local limit = tonumber(ARGV[offset + 2])
  local current = redis.call('INCR', KEYS[index])
  if current == 1 or redis.call('TTL', KEYS[index]) < 0 then
    redis.call('EXPIRE', KEYS[index], window)
  end
  if current > limit then
    limited = 1
    local ttl = redis.call('TTL', KEYS[index])
    if ttl > retry_after then retry_after = ttl end
  end
end
return { limited, retry_after }
`;

export function digestOtpRateLimitClient(hmacSecret: string, clientAddress: string): Buffer {
  return createHmac('sha256', hmacSecret)
    .update('combo:authz:otp-rate-client:v1\0', 'utf8')
    .update(clientAddress, 'utf8')
    .digest();
}

function rulesFor(
  operation: OtpRateLimitOperation,
  targetDigest: Buffer,
  clientDigest: Buffer,
): LimitRule[] {
  if (operation === 'challenge') {
    return [
      {
        name: 'client-hour',
        digest: clientDigest,
        limit: LIMITS.challenge.clientPerHour,
        windowSeconds: 3600,
      },
      {
        name: 'target-cooldown',
        digest: targetDigest,
        limit: 1,
        windowSeconds: LIMITS.challenge.cooldownSeconds,
      },
      {
        name: 'target-hour',
        digest: targetDigest,
        limit: LIMITS.challenge.targetPerHour,
        windowSeconds: 3600,
      },
    ];
  }
  return [
    {
      name: 'client-window',
      digest: clientDigest,
      limit: LIMITS.verification.clientPerWindow,
      windowSeconds: LIMITS.verification.windowSeconds,
    },
    {
      name: 'target-window',
      digest: targetDigest,
      limit: LIMITS.verification.targetPerWindow,
      windowSeconds: LIMITS.verification.windowSeconds,
    },
  ];
}

export function createRedisOtpRateLimiter(redis: Redis): OtpRateLimiter {
  return {
    async consume(operation, targetDigest, clientDigest) {
      const rules = rulesFor(operation, targetDigest, clientDigest);
      const keys = rules.map(
        (rule) => `authz:v2:otp-rate:${operation}:${rule.name}:${rule.digest.toString('hex')}`,
      );
      const args = rules.flatMap((rule) => [rule.windowSeconds, rule.limit]);
      const raw = await redis.eval(CONSUME_SCRIPT, keys.length, ...keys, ...args);
      if (
        !Array.isArray(raw) ||
        raw.length !== 2 ||
        !raw.every((value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0)
      ) {
        throw new Error('invalid OTP rate-limit response');
      }
      const limited = Number(raw[0]) === 1;
      const retryAfterSeconds = Number(raw[1]);
      if ((limited && retryAfterSeconds <= 0) || (!limited && retryAfterSeconds !== 0)) {
        throw new Error('invalid OTP rate-limit response');
      }
      return { allowed: !limited, retryAfterSeconds };
    },
  };
}
