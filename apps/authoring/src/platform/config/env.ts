// 运行期 env 加载 + 校验。
//
// 两条铁律（Codex#13）：
//   1) 生产模式（NODE_ENV=production）禁止 DB/对象存储/Redis/Logto 等密钥与连接串用默认 fallback：
//      缺失即【启动失败】（throw），绝不带着 minioadmin/combo:combo 这类默认凭据上生产。
//   2) dev/test 可保留默认便于直跑/冒烟，但加守卫：用了默认值会显式 warn（看得见、可追责）。
//
// redis_hot 默认口径以 compose 独立服务为权威（redis_hot 是独立实例、db 索引 /0，
//   不是与 redis_queue 共实例靠 /1 隔离）；本地直跑映射到宿主 6380（见 .env.local.example / compose）。
import {
  DEVELOPMENT_RELEASE_METADATA_ENV,
  RELEASE_METADATA_ENV_KEYS,
  releaseMetadataFromEnv,
} from '@cb/shared';
import { z } from 'zod';

/**
 * 「留空即默认」预处理：compose 用 `LLM_X=${LLM_X:-}` 注入时，未设的变量会变成空字符串 ''，
 * 而非 undefined。空串对 .optional()/.default() 都不等价于「未设」——optional 的 enum 会因 '' 非法值
 * 解析失败（生产即启动失败），default 也不会回落（'' 是个合法 string，不触发 default）。
 * 这里把空串统一规整成 undefined，让其走 schema 的 .optional()/.default() 语义（留空 = 按 key 自动判定/默认值）。
 */
const emptyToUndefined = (v: unknown): unknown => (v === '' ? undefined : v);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // 一镜像两入口分叉（compose 注入；本地直跑默认 api）。决定生产必填密钥集（见 PRODUCTION_REQUIRED_BY_PROCESS）。
  PROCESS: z.enum(['api', 'worker']).default('api'),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // 关停兜底：收到 SIGTERM/SIGINT 后，即使 in-flight 请求 / 活动 job 未 drain，到点也强制退出。
  // 默认 8s（略低于容器默认 10s 停机宽限，确保先自行干净退出而非等 docker SIGKILL）。
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),

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
  OTEL_SERVICE_NAME: z.string().default('cb-authoring'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(emptyToUndefined, z.string().optional()),
  OTEL_RESOURCE_ATTRIBUTES: z.string().default(''),
  OTEL_TRACES_SAMPLER: z.string().default(''),
  OTEL_TRACES_SAMPLER_ARG: z.string().default(''),
  OTEL_SDK_DISABLED: z.enum(['true', 'false']).default('false'),

  // PostgreSQL
  DATABASE_URL: z.string().default('postgres://combo:combo@localhost:5432/combo'),

  // Redis 双实例（70 §8.1）。redis_hot 以 compose 独立服务为权威：本地直跑 6380/0（非共实例 /1）。
  REDIS_QUEUE_URL: z.string().default('redis://localhost:6379/0'),
  REDIS_HOT_URL: z.string().default('redis://localhost:6380/0'),

  // ObjectStore（70 §8.2）
  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  // 预签名直传专用「公网/浏览器可达」端点（BUG-013）：浏览器拿到的 presigned PUT/GET URL 用它，
  //   而 API/worker 内部走 S3_ENDPOINT。Docker 下 S3_ENDPOINT=http://minio:9000（容器内网名，浏览器
  //   不可解析），故 dev 须把本值设为宿主可达的 http://localhost:9000。缺省回退 S3_ENDPOINT（生产端点本就公网
  //   可达时无需单设；签名按本端点 host 计算，绝不签后改 host——那会让 V4 签名失配 SignatureDoesNotMatch）。
  S3_PUBLIC_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY: z.string().default('minioadmin'),
  S3_SECRET_KEY: z.string().default('minioadmin'),
  S3_REGION: z.string().default('us-east-1'),

  // Logto（10 §9）
  LOGTO_ENDPOINT: z.string().default('http://localhost:3001'),
  LOGTO_ISSUER: z.string().default('http://localhost:3001/oidc'),
  LOGTO_JWKS_URI: z.string().default('http://localhost:3001/oidc/jwks'),
  LOGTO_APP_ID: z.string().default(''),
  LOGTO_APP_SECRET: z.string().default(''),
  LOGTO_REDIRECT_URI: z.string().default('http://localhost/api/v1/auth/callback'),
  // JWT 受众（Logto API resource indicator，10-auth §4.1，Codex#2）。
  //   生产【必填】且【无条件】校 aud（见 PRODUCTION_REQUIRED_BY_PROCESS / verifyLogtoJwt）；
  //   dev/test 默认空 → 配了才校（dev 兜底，不强校）。
  LOGTO_AUDIENCE: z.string().default(''),

  // LLM Gateway（70 §8.3）
  //   provider 选择：显式 LLM_PROVIDER 优先；未设时按「哪个 key 在」自动判定
  //     （有 OPENROUTER_API_KEY 而无 ANTHROPIC_API_KEY → openrouter；否则 anthropic）。
  //   任何 LLM 配置都【不进生产必填集】——上游 degraded 不计 /ready，缺失只降级、不阻塞启动。
  //   compose 用 `LLM_PROVIDER=${LLM_PROVIDER:-}` 注入：未设 → 空串 ''。空串非合法 enum 值且非 undefined，
  //   不预处理会让 .optional() 解析失败（生产启动失败），违背「留空按 key 自动判定」。先把空串规整成 undefined。
  LLM_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['anthropic', 'openrouter']).optional()),
  // Anthropic 直连密钥（provider=anthropic 时用；空 → degraded）。
  ANTHROPIC_API_KEY: z.string().default(''),
  // OpenRouter（OpenAI 兼容）密钥 sk-or-...（provider=openrouter 时用；空 → degraded）。
  OPENROUTER_API_KEY: z.string().default(''),
  // OpenAI 兼容网关基址（默认 OpenRouter）。仅 openrouter provider 用。
  //   compose 留空（''）→ 规整成 undefined → 走 default（不让 '' 覆盖默认基址，否则 OpenRouter URL 拼空崩）。
  LLM_BASE_URL: z.preprocess(emptyToUndefined, z.string().default('https://openrouter.ai/api/v1')),
  // 显式模型覆盖；空 → 按 provider 各自默认（anthropic→claude-opus-4-8，
  //   openrouter→anthropic/claude-sonnet-4.6）。compose 留空（''）→ undefined → default('')，
  //   resolveLlmProvider 再据 provider 各自兜底（统一「留空即默认」口径）。
  LLM_MODEL: z.preprocess(emptyToUndefined, z.string().default('')),

  // —— 仅 dev/test 的种子登录（live 测试拿有效会话跑主链路，不依赖真实 Logto 浏览器登录）——
  //   双守卫（安全第一）：NODE_ENV !== 'production' 【且】DEV_LOGIN_ENABLED=true 时才生效；
  //   生产【无条件强制关闭】（loadEnv 内置守卫：production 下即便显式 true 也被忽略并 warn）。
  //   关闭/生产时：POST /api/v1/auth/dev-login 不注册（404）、requireAuth/SSE 的 dev 验证分支完全不走。
  DEV_LOGIN_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // dev 会话签名密钥（HS256，应用侧自签，与 Logto 无关）。无默认值：未配 = dev 登录不可用（即便开关开）。
  //   生产无效（dev 验证分支整体被双守卫关停，绝不参与生产鉴权）。
  DEV_SESSION_SECRET: z.string().default(''),
});

export type Env = z.infer<typeof EnvSchema>;

function assertReleaseMetadata(env: Env): void {
  try {
    const metadata = releaseMetadataFromEnv(env);
    // NODE_ENV describes process hardening, not the promotion stage: Test and Preview
    // intentionally mix dev-login API/Runtime processes with a production-mode Worker.
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

/**
 * 生产模式必须显式配置的密钥/连接串（不允许默认 fallback），【按进程】区分（Codex#13）。
 * 缺失（未设或为空字符串）即在生产启动时 throw，避免带默认凭据上生产。
 *
 * 必填集与 compose 各进程实际注入的 env 一一对齐——只要进程会用到的密钥，缺了就崩；
 * 不强求 worker 持有它不消费的 Logto OIDC 凭据。
 * 注：LLM key（ANTHROPIC_API_KEY）任何进程都不在必填列——上游 degraded 不计 /ready，缺失只降级、不阻塞启动。
 */
const COMMON_REQUIRED = ['DATABASE_URL', ...RELEASE_METADATA_ENV_KEYS] as const;
const LOGTO_REQUIRED = [
  'LOGTO_ENDPOINT',
  'LOGTO_ISSUER',
  'LOGTO_JWKS_URI',
  'LOGTO_APP_ID',
  'LOGTO_APP_SECRET',
  'LOGTO_REDIRECT_URI',
  // 受众必填（Codex#2）：生产无条件校 aud，缺则验签拒所有 token（防「生产可不验 aud」）。
  'LOGTO_AUDIENCE',
] as const;
const S3_REQUIRED = ['S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'] as const;

const PRODUCTION_REQUIRED_BY_PROCESS: Record<Env['PROCESS'], readonly string[]> = {
  // api：HTTP+SSE，做 OIDC 校验 + 入队 + 对象存储 → 全套。
  api: [...COMMON_REQUIRED, 'REDIS_QUEUE_URL', 'REDIS_HOT_URL', ...S3_REQUIRED, ...LOGTO_REQUIRED],
  // worker：消费队列 + 写对象存储 + 推热态事件；不做 OIDC。
  worker: [...COMMON_REQUIRED, 'REDIS_QUEUE_URL', 'REDIS_HOT_URL', ...S3_REQUIRED],
};

let cached: Env | undefined;

/**
 * 解析进程 env（缓存）。
 *   - production：PRODUCTION_REQUIRED 任一缺失/为空 → throw（启动即失败，绝不用默认凭据）。
 *   - dev/test：缺失回落默认 + warn（用了默认值看得见）。
 */
export function loadEnv(): Env {
  if (cached) return cached;

  const isProduction = process.env.NODE_ENV === 'production';
  // PROCESS 决定必填集；非法/缺失回落 api（最严格的必填集，宁可多要不可少要）。
  const rawProcess = process.env.PROCESS;
  const proc: Env['PROCESS'] = rawProcess === 'worker' ? rawProcess : 'api';
  const required = PRODUCTION_REQUIRED_BY_PROCESS[proc];

  if (isProduction) {
    const missing = required.filter((k) => {
      const v = process.env[k];
      return v === undefined || v.trim() === '';
    });
    if (missing.length > 0) {
      // 绝不打印值，只打印缺失的 key 名（避免泄密）。生产缺密钥即崩，让编排在启动期就暴露。
      throw new Error(
        `[env] 生产模式（PROCESS=${proc}）缺少必需配置（不允许默认 fallback）：${missing.join(', ')}。` +
          `请在部署环境显式设置后重启。`,
      );
    }
  }

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    if (isProduction) {
      // 生产模式校验失败直接 throw（不回落默认）；只暴露字段名，不暴露值。
      throw new Error(
        `[env] 生产模式环境变量校验失败：${Object.keys(parsed.error.flatten().fieldErrors).join(', ')}`,
      );
    }
    console.warn(
      '[env] 部分环境变量缺失/不合法，回落默认值（dev/test 守卫）：',
      parsed.error.flatten().fieldErrors,
    );
    cached = EnvSchema.parse({});
    assertReleaseMetadata(cached);
    return cached;
  }

  cached = parsed.data;
  assertReleaseMetadata(cached);

  // —— dev 登录双守卫之「生产无条件强制关闭」（安全第一，Codex 反向破坏可测）——
  //   生产模式即便误配 DEV_LOGIN_ENABLED=true，也强制改回 false 并 warn——绝不让种子登录上生产。
  //   去掉这段（反向破坏）会让生产可被 dev 登录，对应单测应转红。
  if (isProduction && cached.DEV_LOGIN_ENABLED) {
    console.warn(
      '[env] 生产模式禁止 DEV_LOGIN_ENABLED=true（种子登录仅限 dev/test）：已强制关闭。',
    );
    cached = { ...cached, DEV_LOGIN_ENABLED: false };
  }

  // dev/test 守卫：用到默认凭据/连接串时显式 warn（生产已在上面拦截，不会走到这）。
  if (!isProduction) {
    const usingDefaults = required.filter((k) => {
      const v = process.env[k];
      return v === undefined || v.trim() === '';
    });
    if (usingDefaults.length > 0) {
      console.warn(
        `[env] dev/test（PROCESS=${proc}）使用默认值（生产将拒绝启动）：${usingDefaults.join(', ')}`,
      );
    }
  }

  return cached;
}
