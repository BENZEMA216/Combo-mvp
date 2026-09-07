// 进程入口：加载配置、装配 PostgreSQL 依赖与 hold 清扫任务、启动 HTTP 监听。
// 业务实现见 app.ts / repo.ts / service.ts；本文件只做接线。
import { Pool } from 'pg';
import type { FastifyRequest } from 'fastify';
import { buildApp } from './app.js';
import { loadEnv } from './env.js';
import { createPgBillingStore } from './repo.js';
import { startHoldSweeper } from './sweep.js';
import { createPgPaymentStore } from './payment-repo.js';
import { createPaymentTokenCodec } from './payment-service.js';
import { createPaymentUserAuthenticator, paymentGatewayAuthenticated } from './payment-auth.js';

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

const store = createPgBillingStore(pool);
const paymentConfig = env.PAYMENTS;
const paymentStore = paymentConfig
  ? createPgPaymentStore(pool, {
      tokens: createPaymentTokenCodec(paymentConfig.tokenKey),
      checkoutBaseUrl: paymentConfig.checkoutBaseUrl,
    })
  : undefined;
const sweeper = startHoldSweeper({
  store,
  paymentStore,
  intervalSeconds: env.SWEEP_INTERVAL_SECONDS,
  batchSize: env.SWEEP_BATCH_SIZE,
});

const app = await buildApp({
  store,
  ...(paymentConfig && paymentStore
    ? {
        payments: {
          store: paymentStore,
          trustedOrigins: paymentConfig.trustedOrigins,
          authenticateUser: createPaymentUserAuthenticator({
            authzBaseUrl: paymentConfig.authzBaseUrl,
            jwksUrl: paymentConfig.jwksUrl,
            issuer: paymentConfig.issuer,
            trustedOrigins: paymentConfig.trustedOrigins,
            allowHttpForTest: env.NODE_ENV !== 'production',
          }),
          authenticateGateway: async (request: FastifyRequest) =>
            paymentGatewayAuthenticated(request.headers.authorization, paymentConfig.gatewayToken),
        },
      }
    : {}),
  internalToken: env.INTERNAL_TOKEN,
  adminToken: env.ADMIN_TOKEN,
  overdraftHardLimitCents: env.OVERDRAFT_HARD_LIMIT_CENTS,
  readiness: async () => {
    try {
      await pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  },
  logger: true,
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  sweeper.stop();
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
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
