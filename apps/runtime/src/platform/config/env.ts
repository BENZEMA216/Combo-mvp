// 运行期 env 加载 + 校验（对齐 authoring 口径）：
//   生产缺关键连接串/密钥即启动失败；dev/test 回落默认 + warn。
//   LLM key 不进生产必填集——缺失只让对话轮次降级报错，不阻塞启动。
import {
  DEVELOPMENT_RELEASE_METADATA_ENV,
  RELEASE_METADATA_ENV_KEYS,
  releaseMetadataFromEnv,
} from '@cb/shared';
import { z } from 'zod';

/** 「留空即默认」：compose `X=${X:-}` 注入会把未设变量变成空串 ''，统一规整成 undefined 走 schema 语义。 */
const emptyToUndefined = (v: unknown): unknown => (v === '' ? undefined : v);
const booleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');
const immutableImagePattern = /@sha256:[a-f0-9]{64}$/;
const placeholderImagePattern = /@sha256:0{64}$/;
export const MAX_PUBLIC_APP_ORIGINS = 8;

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    // 试用端 api 进程默认 3100（避开 authoring 的 3000，两端可并行起）。
    PORT: z.coerce.number().int().default(3100),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    // 发布身份由无密钥 combo-release ConfigMap 注入。development 默认值只服务本地直跑；
    // Test、Preview 与 Production 的部署渲染必须提供真实的不可变发布元数据。
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

    // Observability（OpenTelemetry）。默认不启用导出；配置 OTLP endpoint 后才向 Collector 发 traces。
    OTEL_SERVICE_NAME: z.string().default('cb-runtime'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(emptyToUndefined, z.string().optional()),
    OTEL_RESOURCE_ATTRIBUTES: z.string().default(''),
    OTEL_SDK_DISABLED: z.enum(['true', 'false']).default('false'),

    // PostgreSQL：与创作端同一个库（capabilities 只读 + 试用层四表读写）。
    DATABASE_URL: z.string().default('postgres://combo:combo@localhost:5432/combo'),
    REDIS_URL: z.string().trim().min(1).default('redis://localhost:6379'),

    // ObjectStore（MinIO/S3）：按 capabilities.storage_key 读能力定义 + 读写产物内容。
    S3_ENDPOINT: z.string().default('http://localhost:9000'),
    S3_ACCESS_KEY: z.string().default('minioadmin'),
    S3_SECRET_KEY: z.string().default('minioadmin'),
    S3_REGION: z.string().default('us-east-1'),

    // 逗号分隔的严格 origin 列表。Cookie 是否 Secure 独立于 NODE_ENV 显式配置。
    // Runtime 只读取 authoring 写入的 PostgreSQL 不透明会话，不持有身份提供商配置。
    PUBLIC_APP_ORIGINS: z.string().default('http://localhost'),
    SESSION_COOKIE_SECURE: booleanFromString,

    // LLM（pi 执行层）。provider 留空按 key 自动判定；缺 key → 对话轮次报「未配置模型密钥」。
    RUNTIME_LLM_PROVIDER: z.preprocess(
      emptyToUndefined,
      z.enum(['anthropic', 'openrouter']).optional(),
    ),
    ANTHROPIC_API_KEY: z.string().default(''),
    OPENROUTER_API_KEY: z.string().default(''),
    // 显式模型 id 覆盖；空 → 按 provider 兜底（见 platform/infra/llm.ts）。
    RUNTIME_LLM_MODEL: z.preprocess(emptyToUndefined, z.string().default('')),
    // 轮次空闲看门狗：LLM 流两次活动间隔超过此值（毫秒）判连接夯死，abort 本轮并发送 RUN_ERROR。
    // 只判无输出的停滞，不限制轮次总时长（issue #51）。
    RUNTIME_TURN_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
    // 消费计费策略。dev/test 使用可控默认值；生产必须显式配置并写入每笔用量快照。
    RUNTIME_BILLING_FREE_USES: z.coerce.number().int().min(0).max(10_000).default(3),
    RUNTIME_BILLING_UNIT_PRICE_CENTS: z.coerce
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .default(100),
    // 从 Turn 中止到数据库、Kubernetes 与连接关闭共用同一个绝对截止时间。
    RUNTIME_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(15_000),

    // 模型工具沙箱默认关闭。只有显式开启时才加载 Kubernetes 集群配置和签名私钥。
    SANDBOX_TOOLS_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    SANDBOX_NAMESPACE: z.string().trim().min(1).default('combo-sandbox'),
    // 每次轮换镜像、公钥或安全规格时递增。滚动发布期间只允许较新修订替换较旧 Pod。
    SANDBOX_CONFIGURATION_REVISION: z.coerce
      .number()
      .int()
      .positive()
      .max(2_147_483_647)
      .default(1),
    SANDBOX_IMAGE: z.preprocess(emptyToUndefined, z.string().trim().default('')),
    SANDBOX_CAPABILITY_PRIVATE_KEY: z.preprocess(emptyToUndefined, z.string().trim().default('')),
    SANDBOX_CAPACITY: z.coerce
      .number()
      .int()
      .refine((value) => value === 4 || value === 5, {
        message: 'SANDBOX_CAPACITY must be exactly 4 or 5',
      })
      .default(4),
    SANDBOX_FIFTH_SLOT_VALIDATED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    SANDBOX_RUNTIME_CLASS: z.literal('gvisor').default('gvisor'),
    SANDBOX_COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().max(300_000).default(120_000),
    SANDBOX_STARTUP_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(30_000),
    SANDBOX_IDLE_TTL_MS: z.coerce.number().int().positive().default(900_000),
    SANDBOX_ABSOLUTE_TTL_MS: z.coerce.number().int().min(300_000).max(1_800_000).default(1_800_000),
    SANDBOX_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  })
  .superRefine((env, ctx) => {
    if (!env.SANDBOX_TOOLS_ENABLED) return;
    if (!env.SANDBOX_IMAGE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SANDBOX_IMAGE'],
        message: 'SANDBOX_IMAGE is required when sandbox tools are enabled',
      });
    }
    if (
      env.SANDBOX_IMAGE &&
      (!immutableImagePattern.test(env.SANDBOX_IMAGE) ||
        placeholderImagePattern.test(env.SANDBOX_IMAGE))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SANDBOX_IMAGE'],
        message: 'SANDBOX_IMAGE must use an immutable sha256 digest',
      });
    }
    if (!env.SANDBOX_CAPABILITY_PRIVATE_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SANDBOX_CAPABILITY_PRIVATE_KEY'],
        message: 'SANDBOX_CAPABILITY_PRIVATE_KEY is required when sandbox tools are enabled',
      });
    }
    if (env.SANDBOX_CAPACITY === 5 && !env.SANDBOX_FIFTH_SLOT_VALIDATED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SANDBOX_FIFTH_SLOT_VALIDATED'],
        message: 'the fifth sandbox slot requires recorded live validation',
      });
    }
    if (env.SANDBOX_ABSOLUTE_TTL_MS <= env.SANDBOX_IDLE_TTL_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SANDBOX_ABSOLUTE_TTL_MS'],
        message: 'SANDBOX_ABSOLUTE_TTL_MS must be greater than SANDBOX_IDLE_TTL_MS',
      });
    }
  });
export type Env = z.infer<typeof EnvSchema>;

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** 与 authoring 使用同一严格语法；不接受空项、空白、重复项、路径或隐式规范化。 */
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
    // NODE_ENV describes process hardening, not the promotion stage: Test and Preview
    // may use either mode, while Development and Production remain strict boundaries.
    if (
      (metadata.environment === 'development' && env.NODE_ENV === 'production') ||
      (metadata.environment === 'production' && env.NODE_ENV !== 'production')
    ) {
      throw new Error('runtime and release environments disagree');
    }
  } catch {
    // 元数据是公开发布身份，但错误仍只报告固定字段组，避免把环境值拼进启动日志。
    throw new Error('[env] COMBO_* 发布元数据校验失败。');
  }
}

/** 生产必填。认证只依赖 PostgreSQL，不需要 JWT、OIDC 或本地签名密钥。 */
const PRODUCTION_REQUIRED = [
  'DATABASE_URL',
  'REDIS_URL',
  'S3_ENDPOINT',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'PUBLIC_APP_ORIGINS',
  'SESSION_COOKIE_SECURE',
  'RUNTIME_BILLING_FREE_USES',
  'RUNTIME_BILLING_UNIT_PRICE_CENTS',
  ...RELEASE_METADATA_ENV_KEYS,
] as const;

let cached: Env | undefined;

/** 解析进程 env（缓存）。生产缺必填时抛错，且错误只包含配置名。 */
export function loadEnv(): Env {
  if (cached) return cached;
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction) {
    const missing = PRODUCTION_REQUIRED.filter((key) => {
      const value = process.env[key];
      return value === undefined || value.trim() === '';
    });
    if (missing.length > 0) {
      throw new Error(
        `[env] 生产模式缺少必需配置（不允许默认 fallback）：${missing.join(', ')}。请显式设置后重启。`,
      );
    }
  }

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // 沙箱是显式安全边界；一旦请求开启，任何缺项都必须失败关闭，不能回落成宿主执行或静默禁用。
    const sandboxSetting = process.env.SANDBOX_TOOLS_ENABLED?.trim();
    const sandboxWasRequested =
      sandboxSetting !== undefined && sandboxSetting !== '' && sandboxSetting !== 'false';
    if (isProduction || sandboxWasRequested) {
      throw new Error(
        `[env] 环境变量校验失败：${Object.keys(parsed.error.flatten().fieldErrors).join(', ')}`,
      );
    }
    console.warn(
      '[env] 部分环境变量缺失或不合法，回落默认值（dev/test 守卫）：',
      parsed.error.flatten().fieldErrors,
    );
    cached = EnvSchema.parse({});
    assertReleaseMetadata(cached);
    return cached;
  }

  const env = parsed.data;
  cached = env;
  assertReleaseMetadata(env);

  let publicOrigins: readonly string[];
  try {
    publicOrigins = parsePublicAppOrigins(env.PUBLIC_APP_ORIGINS);
  } catch {
    throw new Error('[env] PUBLIC_APP_ORIGINS 配置不合法');
  }

  if (isProduction) {
    const invalidKeys: string[] = [];
    if (
      publicOrigins.some(
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
      throw new Error(`[env] 生产浏览器认证配置不合法：${[...new Set(invalidKeys)].join(', ')}`);
    }
  }

  if (!isProduction) {
    const usingDefaults = PRODUCTION_REQUIRED.filter((key) => {
      const value = process.env[key];
      return value === undefined || value.trim() === '';
    });
    if (usingDefaults.length > 0) {
      console.warn(`[env] dev/test 使用默认值（生产将拒绝启动）：${usingDefaults.join(', ')}`);
    }
  }

  return env;
}
