// 进程入口：加载配置、装配 billing 与 provider 客户端、启动 HTTP 监听。
// 编排与转发实现见 service.ts / app.ts；本文件只做接线。
import { buildApp } from './app.js';
import { createFetchBillingClient } from './billing.js';
import { loadEnv } from './env.js';
import { createFetchProviderClient } from './provider.js';
import { createPaymentAdmissionClient } from './payment-admission.js';

const env = loadEnv();

const app = await buildApp({
  ...(env.PAYMENT_ADMISSION_TOKEN
    ? {
        paymentAdmission: createPaymentAdmissionClient({
          baseUrl: env.BILLING_BASE_URL,
          token: env.PAYMENT_ADMISSION_TOKEN,
          timeoutMs: env.BILLING_TIMEOUT_MS,
        }),
      }
    : {}),
  billing: createFetchBillingClient({
    baseUrl: env.BILLING_BASE_URL,
    token: env.BILLING_INTERNAL_TOKEN,
    timeoutMs: env.BILLING_TIMEOUT_MS,
  }),
  provider: createFetchProviderClient({
    baseUrl: env.PROVIDER_BASE_URL,
    apiKey: env.PROVIDER_API_KEY,
  }),
  gatewayToken: env.GATEWAY_INTERNAL_TOKEN,
  pricing: env.PRICING,
  holdFixedCostCents: env.HOLD_FIXED_COST_CENTS,
  defaultMaxTokens: env.DEFAULT_MAX_TOKENS,
  logger: true,
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close().catch(() => undefined);
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
