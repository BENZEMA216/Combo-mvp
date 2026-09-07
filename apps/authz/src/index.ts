// 进程入口：加载配置、装配 PostgreSQL 与 Redis 依赖、启动 HTTP 监听。
// 业务实现见 app.ts / service.ts；本文件只做接线。
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { createAssertionSigner } from './assertion.js';
import { buildApp } from './app.js';
import { createRedisSessionCache } from './cache.js';
import { loadEnv } from './env.js';
import { createRedisOtpRateLimiter } from './rate-limit.js';
import { createPgAuthzStore } from './repo.js';
import { createResendMailer } from './resend.js';
import { createAgentAccessIssuer } from './agent-access.js';
import { createAgentAccessRateLimiter } from './agent-access-routes.js';

const env = loadEnv();

// 配置了 Resend 两键时验证码经邮件真实投递；非 production 缺省时挑战使用固定开发码，
// 但仍经过正常挑战、次数和 TTL 校验，不存在无挑战旁路。
const mailer =
  env.RESEND_API_KEY && env.RESEND_FROM_EMAIL
    ? createResendMailer({
        RESEND_API_KEY: env.RESEND_API_KEY,
        RESEND_FROM_EMAIL: env.RESEND_FROM_EMAIL,
        RESEND_API_BASE_URL: env.RESEND_API_BASE_URL,
      })
    : undefined;

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
  ...(env.AGENT_CREDENTIALS.length
    ? {
        agentAccess: {
          issuer: createAgentAccessIssuer({
            credentials: env.AGENT_CREDENTIALS,
            privateKey: env.ASSERTION_PRIVATE_KEY,
            kid: env.ASSERTION_KEY_ID,
            issuer: env.ASSERTION_ISSUER,
          }),
          allowRequest: createAgentAccessRateLimiter(redis, env.HMAC_SECRET),
        },
      }
    : {}),
  store: createPgAuthzStore(pool),
  cache: createRedisSessionCache(redis),
  signer: createAssertionSigner({
    privateKey: env.ASSERTION_PRIVATE_KEY,
    kid: env.ASSERTION_KEY_ID,
    issuer: env.ASSERTION_ISSUER,
    ttlSeconds: env.ASSERTION_TTL_SECONDS,
  }),
  hmacSecret: env.HMAC_SECRET,
  mailer,
  devOtpCode: env.DEV_OTP_CODE,
  otpRateLimiter: createRedisOtpRateLimiter(redis),
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

if (mailer) {
  app.log.info('resend mailer enabled: OTP codes are delivered by email');
} else {
  app.log.warn('resend not configured: challenges use the bounded development OTP');
}

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
