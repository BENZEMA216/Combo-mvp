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
    (releaseEnvironment === 'preview' || releaseEnvironment === 'production') &&
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
