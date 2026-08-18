// 进程入口：加载配置、装配 PostgreSQL 与 Redis 依赖、启动 HTTP 监听。
// 业务实现见 app.ts / service.ts；本文件只做接线。
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { createAssertionSigner } from './assertion.js';
import { buildApp } from './app.js';
import { createRedisSessionCache } from './cache.js';
import { loadEnv } from './env.js';
import { createPgAuthzStore } from './repo.js';

const env = loadEnv();

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
});
pool.on('error', () => {
  /* 空闲连接错误在调用点处理 */
});

const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });

const app = await buildApp({
  store: createPgAuthzStore(pool),
  cache: createRedisSessionCache(redis),
  signer: createAssertionSigner({
    privateKey: env.ASSERTION_PRIVATE_KEY,
    kid: env.ASSERTION_KEY_ID,
    issuer: env.ASSERTION_ISSUER,
    ttlSeconds: env.ASSERTION_TTL_SECONDS,
  }),
  hmacSecret: env.HMAC_SECRET,
  devOtpCode: env.DEV_OTP_CODE,
  sessionCookieDomain: env.SESSION_COOKIE_DOMAIN,
  sessionCookieSecure: env.SESSION_COOKIE_SECURE,
  readiness: async () => {
    try {
      await Promise.all([pool.query('SELECT 1'), redis.ping()]);
      return true;
    } catch {
      return false;
    }
  },
  logger: true,
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close().catch(() => undefined);
  await Promise.allSettled([pool.end(), redis.quit()]);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: env.PORT, host: env.HOST });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
