// 启动配置：所有环境变量在这里解析与校验，进程其余部分只读结构化结果。

export interface BillingEnv {
  NODE_ENV: string;
  PORT: number;
  HOST: string;
  DATABASE_URL: string;
  /** 平台内部 token：模型网关与 Agent SDK 调 holds/settlements/metering/wallets 用。 */
  INTERNAL_TOKEN: string;
  /** 管理 token：验证期手工充值入账用。 */
  ADMIN_TOKEN: string;
  /** 负余额硬停阈值（分）：净余额低于 -OVERDRAFT_HARD_LIMIT_CENTS 时拒绝新 hold。 */
  OVERDRAFT_HARD_LIMIT_CENTS: number;
  SWEEP_INTERVAL_SECONDS: number;
  SWEEP_BATCH_SIZE: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function requiredToken(name: string): string {
  const value = required(name);
  if (value.length < 16) throw new Error(`${name} must be at least 16 characters`);
  return value;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? 4102);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new Error('PORT must be an integer within 1..65535');
  }
  return port;
}

function parsePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = Number(raw ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadEnv(): BillingEnv {
  return {
    NODE_ENV: process.env.NODE_ENV ?? 'development',
    PORT: parsePort(process.env.PORT),
    HOST: process.env.HOST ?? '0.0.0.0',
    DATABASE_URL: required('DATABASE_URL'),
    INTERNAL_TOKEN: requiredToken('BILLING_INTERNAL_TOKEN'),
    ADMIN_TOKEN: requiredToken('BILLING_ADMIN_TOKEN'),
    OVERDRAFT_HARD_LIMIT_CENTS: parsePositiveInt('BILLING_OVERDRAFT_HARD_LIMIT_CENTS', 500),
    SWEEP_INTERVAL_SECONDS: parsePositiveInt('BILLING_SWEEP_INTERVAL_SECONDS', 60),
    SWEEP_BATCH_SIZE: parsePositiveInt('BILLING_SWEEP_BATCH_SIZE', 100),
  };
}
