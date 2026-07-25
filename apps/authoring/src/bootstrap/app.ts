// Fastify app 工厂。挂基础设施容器 + 全局插件 + 统一错误信封 + 健康检查 + 业务路由。
// 对外绝不裸露错误码/堆栈：所有非 2xx 只出 ErrorEnvelope，内部 code 只进结构化日志（经 traceId 关联）。
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import {
  API_PREFIX,
  ErrorCode,
  errorBodyFor,
  newTraceId,
  TRACE_ID_HEADER,
  TRACEPARENT_HEADER,
  traceIdFromHeaders,
  traceIdFromUrl,
  type ErrorCodeValue,
} from '@cb/shared';
import { loadEnv, type Env } from '../platform/config/env.js';
import { buildInfra } from '../platform/infra/index.js';
import { registerHealthRoutes } from '../platform/http/health.js';
import { registerVersionRoute } from '../platform/http/version.js';
import { registerBusinessRoutes } from './routes.js';
import { registerDevAccountRoutes } from '../modules/account/routes.js';
import { provisionUser } from '../modules/account/repo.js';
import type { ProvisionUserFn } from '../platform/middleware/auth.js';
import { devLoginAvailable } from '../platform/infra/dev-session.js';
import { corsOriginPolicy } from '../platform/http/browser-origin.js';
import {
  currentTraceId,
  currentTraceLogFields,
  currentTraceparent,
} from '../platform/observability/node.js';
// 副作用导入：注册 Fastify 类型增强（req.auth / app.infra）。
import '../platform/http/fastify.js';

/** 生成/继承请求 traceId。 */
function resolveRequestTraceId(
  headers: Record<string, string | string[] | undefined>,
  url?: string,
): string {
  return traceIdFromHeaders(headers) ?? traceIdFromUrl(url) ?? currentTraceId() ?? newTraceId();
}

export interface BuildAppOptions {
  /** 覆盖 env（测试用）。 */
  env?: Env;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = opts.env ?? loadEnv();
  const app = Fastify({
    // 请求体上限：助手分片上传是 JSON 体（单片 2MB 文本 + JSON 转义开销），8MB 足够且不失守。
    bodyLimit: 32 * 1024 * 1024, // 与 nginx client_max_body_size 32m 对齐；分片 2MB 文本 JSON 转义后仍有充分余量
    logger: {
      level: env.LOG_LEVEL,
      base: { service: env.OTEL_SERVICE_NAME, process: env.PROCESS },
      ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
      // 结构化日志按 traceId 串联。
      formatters: {
        log: (obj) => obj,
      },
    },
    genReqId: (req) => resolveRequestTraceId(req.headers, req.url),
    disableRequestLogging: false,
    // 反代后取真实 IP（限流/日志用）。
    trustProxy: true,
  });

  // —— 基础设施容器：注入 app.infra（db/redis/queue/objectStore/llm），handler 经 req.server.infra 取用 ——
  app.decorate('infra', buildInfra(env));
  // —— provision 接线（依赖反转）：platform 鉴权中间件领域无关，查/建 users 的实现由组合根注入 account 域 ——
  const provision: ProvisionUserFn = (input) => provisionUser(app.infra.db, input);
  app.decorate('provisionUser', provision);

  // —— 全局插件 ——
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    // 生产只允许 LOGTO_REDIRECT_URI 推导出的 canonical origin；dev/test 只额外允许固定 Vite origin。
    // 无 Origin 的服务端/CLI 请求不受影响。Cookie 变更端点另有服务端来源守卫，不能只依赖 CORS。
    origin: corsOriginPolicy(env),
    credentials: true,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false, // 默认不全局限流
    max: 100,
    timeWindow: '1 minute',
  });

  // 把每请求 traceId 暴露在 reply 头（前端「反馈代码」用）+ 进日志上下文。
  app.addHook('onRequest', async (req, reply) => {
    reply.header(TRACE_ID_HEADER, req.id);
    reply.header(TRACEPARENT_HEADER, currentTraceparent(req.id));
  });

  app.addHook('onResponse', async (req, reply) => {
    req.log.info(
      {
        ...currentTraceLogFields(req.id),
        method: req.method,
        url: req.url,
        route: req.routeOptions.url ?? req.url,
        statusCode: reply.statusCode,
      },
      'request completed',
    );
  });

  // —— 统一错误信封：对外只发 { error: ErrorBody }（无 code、无原始 message/stack/SQL）；
  //    内部 code + 原始 err 进结构化日志，经 traceId 关联。 ——
  app.setErrorHandler((err, req, reply) => {
    // 未知/内部异常一律映射为安全通用 code。限流 → RATE_LIMITED；校验/400 → VALIDATION_FAILED。
    let code: ErrorCodeValue = ErrorCode.INTERNAL;
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 429) {
      code = ErrorCode.RATE_LIMITED;
    } else if ((err as { validation?: unknown }).validation || statusCode === 400) {
      code = ErrorCode.VALIDATION_FAILED;
    } else if (statusCode === 413) {
      code = ErrorCode.VALIDATION_FAILED; // 载荷超限：人话直说，不落 INTERNAL 的「开小差」
    }
    const { http, body } = errorBodyFor(
      code,
      req.id,
      statusCode === 413
        ? { userMessage: '这一片内容太大，重跑助手命令即可（新版脚本会切成更小的分片）。' }
        : undefined,
    );
    req.log.error({ err, code, ...currentTraceLogFields(req.id) }, 'request failed');
    reply.code(statusCode === 413 ? 413 : http).send({ error: body });
  });

  // —— 404 也走信封（不裸露路由信息）——
  app.setNotFoundHandler((req, reply) => {
    const { http, body } = errorBodyFor(ErrorCode.NOT_FOUND, req.id);
    req.log.warn({ ...currentTraceLogFields(req.id) }, 'route not found');
    reply.code(http).send({ error: body });
  });

  // 健康检查（不在 /api/v1 前缀）。
  await registerHealthRoutes(app);

  // 公开发布身份（无密钥、no-store），供部署验收核对 API 与同一 release manifest。
  await registerVersionRoute(app, env);

  // 业务路由（account / task / capability）。
  await registerBusinessRoutes(app);

  // —— 仅 dev/test 种子登录（安全双守卫，绝不上生产）——
  //   仅当 devLoginAvailable 才注册 POST /api/v1/auth/dev-login；生产/开关关 → 端点根本不存在（404）。
  if (devLoginAvailable(env)) {
    await app.register(
      async (scoped) => {
        await registerDevAccountRoutes(scoped);
      },
      { prefix: API_PREFIX },
    );
    app.log.warn('[dev-login] 已启用种子登录端点 POST /api/v1/auth/dev-login（仅 dev/test）');
  }

  // 进程退出时关闭基础设施连接。
  app.addHook('onClose', async () => {
    const { closeDb, closeRedis, closeQueues, closeObjectStore } =
      await import('../platform/infra/index.js');
    await Promise.allSettled([closeDb(), closeRedis(), closeQueues()]);
    closeObjectStore();
  });

  return app;
}
