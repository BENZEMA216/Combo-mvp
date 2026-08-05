// Fastify app 工厂（试用端）。挂基础设施容器、轮次编排器、全局插件、统一错误信封、健康检查与业务路由。
// 对外不暴露内部错误码或堆栈。
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
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
import { buildInfra, createRedisInterruptBus } from '../platform/infra/index.js';
import { registerHealthRoutes } from '../platform/http/health.js';
import { corsOriginPolicy } from '../platform/http/browser-origin.js';
import { registerVersionRoute } from '../platform/http/version.js';
import {
  currentTraceId,
  currentTraceLogFields,
  currentTraceparent,
} from '../platform/observability/node.js';
import { createTurnRunner } from '../modules/agent/run-turn.js';
import { TURN_SWEEP_INTERVAL_MS } from '../modules/agent/turn-repo.js';
import { createPiTurnAgentFactory } from '../modules/agent/build-agent.js';
import { registerBusinessRoutes } from './routes.js';
import { registerInternalMcpRuntimeRoutes } from './internal-mcp-routes.js';
// 副作用导入：注册 Fastify 类型增强（req.auth / app.infra / app.turns）。
import '../platform/http/fastify.js';

/** 生成/继承请求 traceId。 */
function resolveRequestTraceId(
  headers: Record<string, string | string[] | undefined>,
  url?: string,
): string {
  return traceIdFromHeaders(headers) ?? traceIdFromUrl(url) ?? currentTraceId() ?? newTraceId();
}

async function settleBeforeShutdownDeadline(
  promise: Promise<unknown>,
  signal: AbortSignal,
): Promise<void> {
  void promise.catch(() => undefined);
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', finish);
      resolve();
    };
    signal.addEventListener('abort', finish, { once: true });
    void promise.finally(finish).catch(() => undefined);
  });
}

export interface BuildAppOptions {
  /** 覆盖 env（测试用）。 */
  env?: Env;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = opts.env ?? loadEnv();
  const app = Fastify({
    bodyLimit: 4 * 1024 * 1024,
    logger: {
      level: env.LOG_LEVEL,
      base: { service: env.OTEL_SERVICE_NAME, process: 'runtime-api' },
      ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
      formatters: { log: (obj) => obj },
    },
    genReqId: (req) => resolveRequestTraceId(req.headers, req.url),
    // 关闭 Fastify 默认的原始 URL 请求日志，避免查询参数进入日志。
    disableRequestLogging: true,
    trustProxy: ['loopback', 'linklocal', 'uniquelocal'],
  });

  // —— 基础设施容器 + 轮次编排器 ——
  const infra = await buildInfra(env, app.log);
  app.decorate('infra', infra);
  app.decorate(
    'turns',
    createTurnRunner({
      db: infra.db,
      objectStore: infra.objectStore,
      bus: infra.bus,
      eventLog: infra.eventLog,
      agentFactory: createPiTurnAgentFactory(env),
      idleTimeoutMs: env.RUNTIME_TURN_IDLE_TIMEOUT_MS,
      interrupts: createRedisInterruptBus(env),
      sandbox: infra.sandbox,
      billingPolicy: {
        freeUses: env.RUNTIME_BILLING_FREE_USES,
        unitPriceCents: env.RUNTIME_BILLING_UNIT_PRICE_CENTS,
      },
      sweepIntervalMs: TURN_SWEEP_INTERVAL_MS,
      shutdownTimeoutMs: env.RUNTIME_SHUTDOWN_TIMEOUT_MS,
      log: app.log,
    }),
  );

  // —— 全局插件（同源 Cookie 会话需 credentials）——
  await app.register(cors, {
    origin: corsOriginPolicy(env),
    credentials: true,
  });
  await app.register(cookie);

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

  // —— 统一错误信封：对外只发 { error: ErrorBody }；内部 code + 原始 err 进结构化日志。——
  app.setErrorHandler((err, req, reply) => {
    let code: ErrorCodeValue = ErrorCode.INTERNAL;
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 429) {
      code = ErrorCode.RATE_LIMITED;
    } else if ((err as { validation?: unknown }).validation || statusCode === 400) {
      code = ErrorCode.VALIDATION_FAILED;
    }
    const { http, body } = errorBodyFor(code, req.id);
    req.log.error({ err, code, ...currentTraceLogFields(req.id) }, 'request failed');
    reply.code(http).send({ error: body });
  });

  // —— 404 也走信封 ——
  app.setNotFoundHandler((req, reply) => {
    const { http, body } = errorBodyFor(ErrorCode.NOT_FOUND, req.id);
    req.log.warn({ ...currentTraceLogFields(req.id) }, 'route not found');
    reply.code(http).send({ error: body });
  });

  // 健康检查（不在 /api/v1 前缀）。
  await registerHealthRoutes(app);

  // 公开发布身份（无密钥、no-store），供部署验收核对 Runtime 与同一 release manifest。
  await registerVersionRoute(app, env);

  // 业务路由（capability / session / artifact）。
  await registerBusinessRoutes(app);

  // 集群内 MCP 委托路由不挂公开 API 前缀；公网 Nginx 不转发 `/internal/`。
  await registerInternalMcpRuntimeRoutes(app);

  // 进程退出时关闭基础设施连接。
  app.addHook('onClose', async () => {
    const deadline = AbortSignal.timeout(env.RUNTIME_SHUTDOWN_TIMEOUT_MS);
    await settleBeforeShutdownDeadline(app.turns.dispose(deadline), deadline);
    await settleBeforeShutdownDeadline(infra.sandbox.dispose(deadline), deadline);
    const { closeDb, closeObjectStore, closeRedis } = await import('../platform/infra/index.js');
    closeObjectStore();
    await settleBeforeShutdownDeadline(closeDb(), deadline);
    await settleBeforeShutdownDeadline(closeRedis(), deadline);
  });

  return app;
}
