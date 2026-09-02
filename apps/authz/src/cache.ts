// 会话读路径的 Redis 缓存。缓存只保存会话主键、用户主键与到期时间，
// 所有方法吞错降级：Redis 抖动时调用方回源 PostgreSQL，缓存永远不当事实源。
import type { Redis } from 'ioredis';
import type { ResolvedSession, SessionCache } from './service.js';

const KEY_PREFIX = 'authz:v2:session:';

interface CacheLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

function cacheKey(tokenDigest: Buffer): string {
  return `${KEY_PREFIX}${tokenDigest.toString('hex')}`;
}

function encode(session: ResolvedSession): string {
  return JSON.stringify({
    sessionId: session.sessionId,
    userId: session.userId,
    expiresAt: session.expiresAt.getTime(),
  });
}

function decode(raw: string): ResolvedSession | null {
  try {
    const parsed = JSON.parse(raw) as {
      sessionId?: unknown;
      userId?: unknown;
      expiresAt?: unknown;
    };
    if (
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.userId !== 'string' ||
      typeof parsed.expiresAt !== 'number'
    ) {
      return null;
    }
    return {
      sessionId: parsed.sessionId,
      userId: parsed.userId,
      expiresAt: new Date(parsed.expiresAt),
    };
  } catch {
    return null;
  }
}

export function createRedisSessionCache(redis: Redis, log?: CacheLogger): SessionCache {
  const warn = (operation: string) =>
    log?.warn({ operation }, 'session cache unavailable; falling back to PostgreSQL');

  return {
    async get(tokenDigest) {
      try {
        const raw = await redis.get(cacheKey(tokenDigest));
        return raw === null ? null : decode(raw);
      } catch {
        warn('get');
        return null;
      }
    },
    async set(session, tokenDigest) {
      const ttlMillis = session.expiresAt.getTime() - Date.now();
      if (ttlMillis <= 0) return;
      try {
        await redis.set(cacheKey(tokenDigest), encode(session), 'PX', ttlMillis);
      } catch {
        warn('set');
      }
    },
    async del(tokenDigest) {
      try {
        await redis.del(cacheKey(tokenDigest));
      } catch {
        warn('del');
      }
    },
  };
}
