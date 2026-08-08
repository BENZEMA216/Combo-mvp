// Fastify app 工厂。挂基础设施容器、全局插件、统一错误信封、健康检查与业务路由。
// 对外不暴露内部错误码、供应商细节或堆栈。
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import {
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
import { asTxPool } from '../platform/infra/db-tx.js';
import { registerHealthRoutes } from '../platform/http/health.js';
import { registerVersionRoute } from '../platform/http/version.js';
import { registerBusinessRoutes } from './routes.js';
import { corsOriginPolicy } from '../platform/http/browser-origin.js';
import {
  currentTraceId,
  currentTraceLogFields,
  currentTraceparent,
} from '../platform/observability/node.js';
// 副作用导入：注册 Fastify 类型增强（req.auth / app.infra）。
import '../platform/http/fastify.js';
import { PgBillingRepository } from '../modules/billing/repo.js';
import { startBillingReconciler } from '../modules/billing/reconcile.js';

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
    // 关闭 Fastify 默认的原始 URL 请求日志；完成日志只记录路由模板与低敏元数据。
    disableRequestLogging: true,
    // 只信任回环、链路本地和私网代理；公网直连不能伪造转发链覆盖客户端地址。
    trustProxy: ['loopback', 'linklocal', 'uniquelocal'],
  });

  // 基础设施容器还包含 Resend HTTP 适配器与 Redis 认证软限流器；认证事实仍只写 PostgreSQL。
  const infra = buildInfra(env);
  app.decorate('infra', infra);

  // —— 全局插件 ——
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    // 只反射 PUBLIC_APP_ORIGINS 白名单。认证 POST 另有强制 Origin 与 Fetch Metadata 守卫。
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
        route: req.routeOptions.url ?? 'unmatched',
        statusCode: reply.statusCode,
      },
      'request completed',
    );
  });

  // —— 统一错误信封不发送内部 code、原始 message、stack 或 SQL。 ——
  app.setErrorHandler((err, req, reply) => {
    // 未知/内部异常一律映射为安全通用 code。限流 → RATE_LIMITED；校验/400 → VALIDATION_FAILED。
    let code: ErrorCodeValue = ErrorCode.INTERNAL;
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 429) {
      code = ErrorCode.RATE_LIMITED;
    } else if (
      (err as { validation?: unknown }).validation ||
      statusCode === 400 ||
      statusCode === 413 ||
      statusCode === 415
    ) {
      code = ErrorCode.VALIDATION_FAILED;
    }
    const route = req.routeOptions.url ?? '';
    const authRoute =
      route.endsWith('/auth/email/challenges') ||
      route.endsWith('/auth/email/verifications') ||
      route.endsWith('/auth/logout') ||
      route.endsWith('/me');
    const oversizedMessage = authRoute
      ? '认证请求内容过大，请检查后重试。'
      : '这一片内容太大，重跑助手命令即可（新版脚本会切成更小的分片）。';
    const unsupportedMessage = authRoute ? '认证请求必须使用 JSON 格式。' : undefined;
    const overrides =
      statusCode === 413
        ? { userMessage: oversizedMessage }
        : statusCode === 415 && unsupportedMessage
          ? { userMessage: unsupportedMessage }
          : undefined;
    const { http, body } = errorBodyFor(code, req.id, overrides);
    // 认证错误不附带原始异常，避免 parser 或供应商实现把请求内容带入日志。
    req.log.error(
      {
        ...(authRoute ? {} : { err }),
        code,
        ...currentTraceLogFields(req.id),
      },
      'request failed',
    );
    const preservedStatus = statusCode === 413 || statusCode === 415 ? statusCode : http;
    reply.code(preservedStatus).send({ error: body });
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

  // 业务路由（account / task / capability / billing）。
  await registerBusinessRoutes(app);

  const billingReconciler = startBillingReconciler({
    repository: new PgBillingRepository(asTxPool(infra.db), infra.db),
    gateway: infra.paymentGateway,
    enabled: env.NODE_ENV !== 'test',
    gatewayReconciliationEnabled: infra.billing.gatewayEnabled && infra.paymentGateway.configured,
    intervalMs: env.BILLING_RECONCILE_INTERVAL_MS,
    leaseMs: Math.max(30_000, env.LESHOUYING_TIMEOUT_MS * 10 + 15_000),
    log: app.log,
  });

  // 进程退出时关闭基础设施连接。
  app.addHook('onClose', async () => {
    await billingReconciler.stop();
    const { closeDb, closeRedis, closeQueues, closeObjectStore } =
      await import('../platform/infra/index.js');
    await Promise.allSettled([closeDb(), closeRedis(), closeQueues()]);
    closeObjectStore();
  });

  return app;
}
