// 运行期环境变量加载与校验。生产进程缺少所需连接、密钥或不可变发布身份时直接拒绝启动；
// 开发和测试可以使用显式可见的默认值，但认证调用仍需配置真实端口依赖。
import {
  DEVELOPMENT_RELEASE_METADATA_ENV,
  RELEASE_METADATA_ENV_KEYS,
  releaseMetadataFromEnv,
} from '@cb/shared';
import { z } from 'zod';

export const OFFICIAL_RESEND_API_BASE_URL = 'https://api.resend.com';
export const PRODUCTION_RESEND_FROM_EMAIL = 'Combo <auth@buildwithcombo.com>';
export const MAX_PUBLIC_APP_ORIGINS = 8;

const emptyToUndefined = (value: unknown): unknown => (value === '' ? undefined : value);
const booleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PROCESS: z.enum(['api', 'worker']).default('api'),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),

  // 发布身份由 combo-release ConfigMap 注入。development 默认值只服务本地直跑。
  COMBO_ENVIRONMENT: z.string().default(DEVELOPMENT_RELEASE_METADATA_ENV.COMBO_ENVIRONMENT),
  COMBO_SOURCE_SHA: z.string().default(DEVELOPMENT_RELEASE_METADATA_ENV.COMBO_SOURCE_SHA),
  COMBO_RELEASE_ID: z.string().default(DEVELOPMENT_RELEASE_METADATA_ENV.COMBO_RELEASE_ID),
  COMBO_BUILT_AT: z.string().default(DEVELOPMENT_RELEASE_METADATA_ENV.COMBO_BUILT_AT),
  COMBO_RELEASE_MANIFEST_DIGEST: z
    .string()
    .default(DEVELOPMENT_RELEASE_METADATA_ENV.COMBO_RELEASE_MANIFEST_DIGEST),
  COMBO_WEB_ASSET_MANIFEST: z
    .string()
    .default(DEVELOPMENT_RELEASE_METADATA_ENV.COMBO_WEB_ASSET_MANIFEST),

  OTEL_SERVICE_NAME: z.string().default('cb-authoring'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(emptyToUndefined, z.string().optional()),
  OTEL_RESOURCE_ATTRIBUTES: z.string().default(''),
  OTEL_TRACES_SAMPLER: z.string().default(''),
  OTEL_TRACES_SAMPLER_ARG: z.string().default(''),
  OTEL_SDK_DISABLED: z.enum(['true', 'false']).default('false'),

  DATABASE_URL: z.string().default('postgres://combo:combo@localhost:5432/combo'),
  REDIS_QUEUE_URL: z.string().default('redis://localhost:6379/0'),
  REDIS_HOT_URL: z.string().default('redis://localhost:6380/0'),

  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_PUBLIC_ENDPOINT: z.preprocess(emptyToUndefined, z.string().optional()),
  S3_ACCESS_KEY: z.string().default('minioadmin'),
  S3_SECRET_KEY: z.string().default('minioadmin'),
  S3_REGION: z.string().default('us-east-1'),

  // 逗号分隔的严格 origin 列表。Cookie 是否 Secure 独立于 NODE_ENV 显式配置。
  PUBLIC_APP_ORIGINS: z.string().default('http://localhost'),
  SESSION_COOKIE_SECURE: booleanFromString,

  // 只有 API 进程消费认证密钥。Resend base URL 只允许 dev/test 覆盖到本地 mock。
  RESEND_API_KEY: z.string().default(''),
  RESEND_FROM_EMAIL: z.string().default(''),
  RESEND_API_BASE_URL: z.preprocess(
    emptyToUndefined,
    z.string().default(OFFICIAL_RESEND_API_BASE_URL),
  ),
  OTP_HMAC_SECRET: z.string().default(''),

  // 余额充值只由 API 进程使用。网关环境是固定枚举，正式网关另有显式二次开关。
  BILLING_RECHARGE_PACKAGES_JSON: z.string().default('[]'),
  LESHOUYING_ENABLED: booleanFromString,
  LESHOUYING_ENVIRONMENT: z.enum(['TEST', 'PRODUCTION']).default('TEST'),
  LESHOUYING_PRODUCTION_ENABLED: booleanFromString,
  LESHOUYING_INSTITUTION_NO: z.string().default(''),
  LESHOUYING_MERCHANT_NO: z.string().default(''),
  LESHOUYING_INSTITUTION_KEY: z.string().default(''),
  LESHOUYING_NOTIFY_URL: z.string().default(''),
  LESHOUYING_FRONT_URL: z.string().default(''),
  LESHOUYING_TIMEOUT_MS: z.coerce.number().int().min(500).max(15_000).default(5_000),
  BILLING_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(5_000).max(300_000).default(15_000),

  LLM_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['anthropic', 'openrouter']).optional()),
  ANTHROPIC_API_KEY: z.string().default(''),
  OPENROUTER_API_KEY: z.string().default(''),
  LLM_BASE_URL: z.preprocess(emptyToUndefined, z.string().default('https://openrouter.ai/api/v1')),
  LLM_MODEL: z.preprocess(emptyToUndefined, z.string().default('')),
});

export type Env = z.infer<typeof EnvSchema>;

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** 每个条目必须已经是规范的绝对 HTTP(S) origin；不接受空项、路径、凭据或隐式改写。 */
export function parsePublicAppOrigins(value: string): readonly string[] {
  if (value.length === 0 || value.length > 2_048 || containsControlCharacter(value)) {
    throw new Error('[env] PUBLIC_APP_ORIGINS 配置不合法');
  }

  const candidates = value.split(',');
  if (candidates.length === 0 || candidates.length > MAX_PUBLIC_APP_ORIGINS) {
    throw new Error('[env] PUBLIC_APP_ORIGINS 配置不合法');
  }

  const origins: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || candidate !== candidate.trim()) {
      throw new Error('[env] PUBLIC_APP_ORIGINS 配置不合法');
    }
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new Error('[env] PUBLIC_APP_ORIGINS 配置不合法');
    }
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      candidate !== url.origin ||
      seen.has(url.origin)
    ) {
      throw new Error('[env] PUBLIC_APP_ORIGINS 配置不合法');
    }
    seen.add(url.origin);
    origins.push(url.origin);
  }
  return origins;
}

function assertReleaseMetadata(env: Env): void {
  try {
    const metadata = releaseMetadataFromEnv(env);
    if (
      (metadata.environment === 'development' && env.NODE_ENV === 'production') ||
      (metadata.environment === 'production' && env.NODE_ENV !== 'production')
    ) {
      throw new Error('runtime and release environments disagree');
    }
  } catch {
    throw new Error('[env] COMBO_* 发布元数据校验失败。');
  }
}

const COMMON_REQUIRED = ['DATABASE_URL', ...RELEASE_METADATA_ENV_KEYS] as const;
const S3_REQUIRED = ['S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'] as const;
const AUTH_API_REQUIRED = [
  'PUBLIC_APP_ORIGINS',
  'SESSION_COOKIE_SECURE',
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
  'OTP_HMAC_SECRET',
] as const;

const RechargePackageSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u),
    amountCents: z.union([
      z.number().int().positive().max(99_999_999),
      z.string().regex(/^[1-9][0-9]{0,7}$/u),
    ]),
    label: z.string().trim().min(1).max(40),
  })
  .strict();

export interface BillingRechargePackage {
  id: string;
  amountCents: bigint;
  label: string;
}

export interface BillingConfiguration {
  packages: readonly BillingRechargePackage[];
  gatewayEnabled: boolean;
  submissionRecoveryMs: number;
}

function parseHttpsEndpoint(value: string, expectedPath?: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (expectedPath !== undefined && (url.pathname !== expectedPath || url.search))
  ) {
    return null;
  }
  return url;
}

/** 解析配置化充值套餐；金额在进程内始终使用 bigint，HTTP 边界再转十进制字符串。 */
export function billingConfigurationFromEnv(env: Env): BillingConfiguration {
  let rawPackages: unknown;
  try {
    rawPackages = JSON.parse(env.BILLING_RECHARGE_PACKAGES_JSON);
  } catch {
    throw new Error('[env] BILLING_RECHARGE_PACKAGES_JSON 配置不合法');
  }
  const parsedPackages = z.array(RechargePackageSchema).max(20).safeParse(rawPackages);
  if (!parsedPackages.success) {
    throw new Error('[env] BILLING_RECHARGE_PACKAGES_JSON 配置不合法');
  }
  const seen = new Set<string>();
  const packages = parsedPackages.data.map((item) => {
    if (seen.has(item.id)) {
      throw new Error('[env] BILLING_RECHARGE_PACKAGES_JSON 配置不合法');
    }
    seen.add(item.id);
    return {
      id: item.id,
      amountCents: BigInt(item.amountCents),
      label: item.label,
    };
  });

  if (!env.LESHOUYING_ENABLED) {
    return {
      packages,
      gatewayEnabled: false,
      submissionRecoveryMs: env.LESHOUYING_TIMEOUT_MS + 5_000,
    };
  }

  const invalidKeys: string[] = [];
  if (packages.length === 0) invalidKeys.push('BILLING_RECHARGE_PACKAGES_JSON');
  if (
    !/^[\x21-\x7e]{1,32}$/u.test(env.LESHOUYING_INSTITUTION_NO) ||
    env.LESHOUYING_INSTITUTION_NO.includes('&') ||
    env.LESHOUYING_INSTITUTION_NO.includes('=')
  ) {
    invalidKeys.push('LESHOUYING_INSTITUTION_NO');
  }
  if (
    !/^[\x21-\x7e]{1,64}$/u.test(env.LESHOUYING_MERCHANT_NO) ||
    env.LESHOUYING_MERCHANT_NO.includes('&') ||
    env.LESHOUYING_MERCHANT_NO.includes('=')
  ) {
    invalidKeys.push('LESHOUYING_MERCHANT_NO');
  }
  if (
    env.LESHOUYING_INSTITUTION_KEY.length === 0 ||
    env.LESHOUYING_INSTITUTION_KEY.length > 512 ||
    containsControlCharacter(env.LESHOUYING_INSTITUTION_KEY)
  ) {
    invalidKeys.push('LESHOUYING_INSTITUTION_KEY');
  }
  if (!parseHttpsEndpoint(env.LESHOUYING_NOTIFY_URL, '/api/v1/billing/leshouying/payment-notify')) {
    invalidKeys.push('LESHOUYING_NOTIFY_URL');
  }
  if (env.LESHOUYING_FRONT_URL && !parseHttpsEndpoint(env.LESHOUYING_FRONT_URL)) {
    invalidKeys.push('LESHOUYING_FRONT_URL');
  }
  if (
    env.LESHOUYING_ENVIRONMENT === 'PRODUCTION' &&
    (!env.LESHOUYING_PRODUCTION_ENABLED ||
      env.NODE_ENV !== 'production' ||
      releaseMetadataFromEnv(env).environment !== 'production')
  ) {
    invalidKeys.push('LESHOUYING_PRODUCTION_ENABLED', 'LESHOUYING_ENVIRONMENT');
  }
  if (invalidKeys.length > 0) {
    throw new Error(`[env] 支付配置不合法：${[...new Set(invalidKeys)].join(', ')}`);
  }
  return {
    packages,
    gatewayEnabled: true,
    submissionRecoveryMs: env.LESHOUYING_TIMEOUT_MS + 5_000,
  };
}

const PRODUCTION_REQUIRED_BY_PROCESS: Record<Env['PROCESS'], readonly string[]> = {
  api: [
    ...COMMON_REQUIRED,
    'REDIS_QUEUE_URL',
    'REDIS_HOT_URL',
    ...S3_REQUIRED,
    ...AUTH_API_REQUIRED,
  ],
  worker: [...COMMON_REQUIRED, 'REDIS_QUEUE_URL', 'REDIS_HOT_URL', ...S3_REQUIRED],
};

let cached: Env | undefined;

const RESEND_MAILBOX_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/;
const RESEND_DOMAIN_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** dev/test Resend mock 接受裸邮箱或 `显示名 <邮箱>`；生产另行要求精确官方身份。 */
export function isValidResendFromAddress(value: string): boolean {
  if (value.length === 0 || value.length > 320 || value !== value.trim() || /[\r\n]/u.test(value)) {
    return false;
  }

  const displayAddress = value.match(/^([^<>]{1,128})<([^<>]+)>$/u);
  if (value.includes('<') || value.includes('>')) {
    if (!displayAddress || displayAddress[1]?.trim().length === 0) return false;
  }
  const mailbox = (displayAddress?.[2] ?? value).trim();
  if (!RESEND_MAILBOX_PATTERN.test(mailbox)) return false;
  const separator = mailbox.lastIndexOf('@');
  const localPart = mailbox.slice(0, separator);
  const domain = mailbox.slice(separator + 1);
  return (
    localPart.length > 0 &&
    localPart.length <= 64 &&
    !localPart.startsWith('.') &&
    !localPart.endsWith('.') &&
    !localPart.includes('..') &&
    domain.length > 0 &&
    domain.length <= 253 &&
    domain.split('.').every((label) => RESEND_DOMAIN_LABEL_PATTERN.test(label))
  );
}

function validateProductionAuthConfig(env: Env): void {
  const invalidKeys: string[] = [];
  if (env.OTP_HMAC_SECRET.length < 32) invalidKeys.push('OTP_HMAC_SECRET');
  if (env.RESEND_API_BASE_URL !== OFFICIAL_RESEND_API_BASE_URL) {
    invalidKeys.push('RESEND_API_BASE_URL');
  }
  if (env.RESEND_FROM_EMAIL !== PRODUCTION_RESEND_FROM_EMAIL) {
    invalidKeys.push('RESEND_FROM_EMAIL');
  }

  let origins: readonly string[] = [];
  try {
    origins = parsePublicAppOrigins(env.PUBLIC_APP_ORIGINS);
  } catch {
    invalidKeys.push('PUBLIC_APP_ORIGINS');
  }
  if (
    origins.some(
      (origin) => new URL(origin).protocol !== (env.SESSION_COOKIE_SECURE ? 'https:' : 'http:'),
    )
  ) {
    invalidKeys.push('PUBLIC_APP_ORIGINS', 'SESSION_COOKIE_SECURE');
  }

  const releaseEnvironment = releaseMetadataFromEnv(env).environment;
  if (
    ['test', 'preview', 'production'].includes(releaseEnvironment) &&
    !env.SESSION_COOKIE_SECURE
  ) {
    invalidKeys.push('SESSION_COOKIE_SECURE');
  }

  if (invalidKeys.length > 0) {
    throw new Error(`[env] 生产认证配置不合法：${[...new Set(invalidKeys)].join(', ')}`);
  }
}

/** 生产缺配置即失败且只打印 key 名；dev/test 可用默认基础设施。 */
export function loadEnv(): Env {
  if (cached) return cached;

  const isProduction = process.env.NODE_ENV === 'production';
  const processType: Env['PROCESS'] = process.env.PROCESS === 'worker' ? 'worker' : 'api';
  const required = PRODUCTION_REQUIRED_BY_PROCESS[processType];

  if (isProduction) {
    const missing = required.filter((key) => {
      const value = process.env[key];
      return value === undefined || value.trim() === '';
    });
    if (missing.length > 0) {
      throw new Error(
        `[env] 生产模式（PROCESS=${processType}）缺少必需配置：${missing.join(', ')}`,
      );
    }
  }

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const keys = Object.keys(parsed.error.flatten().fieldErrors);
    if (isProduction) throw new Error(`[env] 生产模式环境变量校验失败：${keys.join(', ')}`);
    console.warn(`[env] dev/test 环境变量校验失败，使用默认配置：${keys.join(', ')}`);
    cached = EnvSchema.parse({ NODE_ENV: process.env.NODE_ENV, PROCESS: processType });
    assertReleaseMetadata(cached);
    return cached;
  }

  cached = parsed.data;
  assertReleaseMetadata(cached);

  if (cached.PROCESS === 'api') {
    try {
      parsePublicAppOrigins(cached.PUBLIC_APP_ORIGINS);
    } catch {
      throw new Error('[env] PUBLIC_APP_ORIGINS 配置不合法');
    }
    if (
      cached.RESEND_FROM_EMAIL.length > 0 &&
      !isValidResendFromAddress(cached.RESEND_FROM_EMAIL)
    ) {
      throw new Error('[env] 邮件发件配置不合法：RESEND_FROM_EMAIL');
    }
    billingConfigurationFromEnv(cached);
    if (isProduction) validateProductionAuthConfig(cached);
  }

  if (!isProduction) {
    const usingDefaults = required.filter((key) => {
      const value = process.env[key];
      return value === undefined || value.trim() === '';
    });
    if (usingDefaults.length > 0) {
      console.warn(
        `[env] dev/test（PROCESS=${processType}）使用默认或空配置（生产将拒绝）：${usingDefaults.join(', ')}`,
      );
    }
  }

  return cached;
}
