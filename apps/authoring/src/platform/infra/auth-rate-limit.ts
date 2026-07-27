import type { Redis } from 'ioredis';

const CHALLENGE_WINDOW_MS = 60 * 60 * 1_000;
const CHALLENGE_CLIENT_MAX = 20;
const VERIFICATION_WINDOW_MS = 10 * 60 * 1_000;
const VERIFICATION_TARGET_MAX = 10;
const VERIFICATION_CLIENT_MAX = 50;

export interface AuthRateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface AuthRateLimitPort {
  /** 新邮件请求必须失败关闭；调用异常由业务服务映射为 503。 */
  consumeChallenge(clientDigest: Uint8Array): Promise<AuthRateLimitDecision>;
  /** 已有验证码仍由 PostgreSQL 五次上限保护；调用异常可由业务服务忽略。 */
  consumeVerification(
    targetDigest: Uint8Array,
    clientDigest: Uint8Array,
  ): Promise<AuthRateLimitDecision>;
}

const INCREMENT_ONE_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {count, redis.call('PTTL', KEYS[1])}
`;

const INCREMENT_TWO_LUA = `
local first = redis.call('INCR', KEYS[1])
if first == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local second = redis.call('INCR', KEYS[2])
if second == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[1]) end
return {first, redis.call('PTTL', KEYS[1]), second, redis.call('PTTL', KEYS[2])}
`;

function digestKey(digest: Uint8Array): string {
  if (digest.byteLength !== 32) throw new TypeError('auth rate-limit digest must be 32 bytes');
  return Buffer.from(digest).toString('hex');
}

function secondsFromTtl(ttlMs: number): number {
  if (!Number.isFinite(ttlMs)) return 1;
  return Math.max(1, Math.ceil(Math.max(0, ttlMs) / 1_000));
}

/** Redis 只接收 HMAC 摘要组成的低敏 key，不接收邮箱或客户端地址原文。 */
export function createRedisAuthRateLimiter(redis: Redis): AuthRateLimitPort {
  return {
    async consumeChallenge(clientDigest): Promise<AuthRateLimitDecision> {
      const clientKey = `auth:rate:v1:challenge-client:${digestKey(clientDigest)}`;
      const raw = (await redis.eval(
        INCREMENT_ONE_LUA,
        1,
        clientKey,
        String(CHALLENGE_WINDOW_MS),
      )) as [number | string, number | string];
      const clientCount = Number(raw[0]);
      const clientTtl = Number(raw[1]);
      const clientLimited = !Number.isFinite(clientCount) || clientCount > CHALLENGE_CLIENT_MAX;
      return {
        allowed: !clientLimited,
        retryAfterSeconds: clientLimited ? secondsFromTtl(clientTtl) : 1,
      };
    },

    async consumeVerification(targetDigest, clientDigest): Promise<AuthRateLimitDecision> {
      const targetKey = `auth:rate:v1:verification-target:${digestKey(targetDigest)}`;
      const clientKey = `auth:rate:v1:verification-client:${digestKey(clientDigest)}`;
      const raw = (await redis.eval(
        INCREMENT_TWO_LUA,
        2,
        targetKey,
        clientKey,
        String(VERIFICATION_WINDOW_MS),
      )) as [number | string, number | string, number | string, number | string];
      const targetCount = Number(raw[0]);
      const targetTtl = Number(raw[1]);
      const clientCount = Number(raw[2]);
      const clientTtl = Number(raw[3]);
      const targetLimited = !Number.isFinite(targetCount) || targetCount > VERIFICATION_TARGET_MAX;
      const clientLimited = !Number.isFinite(clientCount) || clientCount > VERIFICATION_CLIENT_MAX;
      return {
        allowed: !targetLimited && !clientLimited,
        retryAfterSeconds: Math.max(
          targetLimited ? secondsFromTtl(targetTtl) : 0,
          clientLimited ? secondsFromTtl(clientTtl) : 0,
          1,
        ),
      };
    },
  };
}
