// Fastify 装配：路由、Cookie 与错误形态。buildApp 不监听端口，
// 进程入口（index.ts）与测试（app.inject）共用同一份装配。
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { z } from 'zod';
import type { AssertionSigner } from './assertion.js';
import {
  OTP_CHALLENGE_TTL_SECONDS,
  V2_SESSION_COOKIE_NAME,
  V2_SESSION_TTL_SECONDS,
} from './crypto.js';
import { loginPageHtml, sanitizeLoginNext } from './login-page.js';
import type { OtpMailer } from './resend.js';
import {
  logout,
  requestOtp,
  resolveSession,
  verifyOtp,
  type SessionCache,
  type AuthzStore,
} from './service.js';

export interface AuthzAppDependencies {
  store: AuthzStore;
  cache: SessionCache;
  signer: AssertionSigner;
  hmacSecret: string;
  /** 真实发信端口；未配置时挑战退化为万能码（仅验证期）。 */
  mailer?: OtpMailer;
  devOtpCode?: string;
  sessionCookieDomain?: string;
  sessionCookieSecure: boolean;
  /** /ready 探针：检查 PostgreSQL 与 Redis 可达性。 */
  readiness?: () => Promise<boolean>;
  logger?: boolean | object;
}

const ChallengeBodySchema = z.object({ email: z.string().min(3).max(254) }).strict();
const VerificationBodySchema = z
  .object({ email: z.string().min(3).max(254), code: z.string().regex(/^[0-9]{6}$/) })
  .strict();
const LogoutBodySchema = z.object({}).strict();
const AssertQuerySchema = z
  .object({ agent_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/) })
  .strict();

/** Traefik ForwardAuth 经 authResponseHeaders 把该响应头注入转发给 Agent 的请求。 */
export const ASSERTION_RESPONSE_HEADER = 'x-combo-assertion';

const NO_STORE = 'no-store';

type ErrorCode = 'invalid_request' | 'unauthenticated' | 'invalid_code' | 'unavailable';

function sendError(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
): FastifyReply {
  return reply.code(status).send({ error: { code }, meta: { traceId: req.id } });
}

function sessionCookieOptions(deps: AuthzAppDependencies, maxAge?: number) {
  return {
    httpOnly: true,
    secure: deps.sessionCookieSecure,
    sameSite: 'lax' as const,
    path: '/',
    ...(deps.sessionCookieDomain ? { domain: deps.sessionCookieDomain } : {}),
    ...(maxAge === undefined ? {} : { maxAge }),
  };
}

function requestSessionCookie(req: FastifyRequest): string | undefined {
  return req.cookies?.[V2_SESSION_COOKIE_NAME];
}

export async function buildApp(deps: AuthzAppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false });
  await app.register(fastifyCookie);

  const serviceDeps = {
    store: deps.store,
    cache: deps.cache,
    hmacSecret: deps.hmacSecret,
    mailer: deps.mailer,
    devOtpCode: deps.devOtpCode,
  };

  app.get('/health', async () => ({ status: 'ok' as const }));

  app.get('/ready', async (_req, reply) => {
    const ready = deps.readiness ? await deps.readiness() : true;
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ok' : 'unavailable', ready });
  });

  // 最简登录页。已登录用户直接跳 next（收敛后的站内路径，缺省 /）。
  app.get('/authz/login', async (req, reply) => {
    const query = req.query as { next?: unknown } | undefined;
    const next = sanitizeLoginNext(query?.next);

    let session;
    try {
      session = await resolveSession(serviceDeps, requestSessionCookie(req));
    } catch (error) {
      req.log.warn({ err: error }, 'session store failed');
      return sendError(req, reply, 503, 'unavailable');
    }
    if (session) return reply.code(302).header('location', next).send();

    return reply.type('text/html; charset=utf-8').send(loginPageHtml(next));
  });

  app.post('/authz/otp/challenges', async (req, reply) => {
    reply.header('cache-control', NO_STORE);
    const parsed = ChallengeBodySchema.safeParse(req.body);
    if (!parsed.success) return sendError(req, reply, 400, 'invalid_request');

    try {
      const result = await requestOtp(serviceDeps, { email: parsed.data.email });
      if (result.kind === 'invalid_input') return sendError(req, reply, 400, 'invalid_request');
      if (result.kind === 'unavailable') return sendError(req, reply, 503, 'unavailable');
      return reply.code(202).send({
        data: { accepted: true as const, expiresInSeconds: OTP_CHALLENGE_TTL_SECONDS },
        meta: { traceId: req.id },
      });
    } catch (error) {
      req.log.warn({ err: error }, 'otp challenge store failed');
      return sendError(req, reply, 503, 'unavailable');
    }
  });

  app.post('/authz/otp/verifications', async (req, reply) => {
    reply.header('cache-control', NO_STORE);
    const parsed = VerificationBodySchema.safeParse(req.body);
    if (!parsed.success) return sendError(req, reply, 400, 'invalid_request');

    try {
      const result = await verifyOtp(serviceDeps, parsed.data);
      if (result.kind === 'invalid_input') return sendError(req, reply, 400, 'invalid_request');
      if (result.kind === 'invalid_code') return sendError(req, reply, 401, 'invalid_code');
      if (result.kind === 'unavailable') return sendError(req, reply, 503, 'unavailable');

      reply.setCookie(
        V2_SESSION_COOKIE_NAME,
        result.sessionCookie,
        sessionCookieOptions(deps, V2_SESSION_TTL_SECONDS),
      );
      return reply.code(200).send({
        data: { user: { id: result.userId }, expiresInSeconds: result.expiresInSeconds },
        meta: { traceId: req.id },
      });
    } catch (error) {
      req.log.warn({ err: error }, 'otp verification store failed');
      return sendError(req, reply, 503, 'unavailable');
    }
  });

  app.post('/authz/logout', async (req, reply) => {
    reply.header('cache-control', NO_STORE);
    const parsed = LogoutBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(req, reply, 400, 'invalid_request');

    try {
      await logout(serviceDeps, requestSessionCookie(req));
    } catch (error) {
      req.log.warn({ err: error }, 'logout store failed');
      return sendError(req, reply, 503, 'unavailable');
    }
    reply.clearCookie(V2_SESSION_COOKIE_NAME, sessionCookieOptions(deps));
    return reply.code(200).send({ data: { loggedOut: true as const }, meta: { traceId: req.id } });
  });

  // 浏览器直连与 Traefik ForwardAuth 共用此端点：响应头携带断言供 ForwardAuth 注入，
  // 响应体携带同一断言供浏览器或 SDK 自取。
  app.get('/authz/assert', async (req, reply) => {
    reply.header('cache-control', NO_STORE);
    const parsed = AssertQuerySchema.safeParse(req.query);
    if (!parsed.success) return sendError(req, reply, 400, 'invalid_request');

    let session;
    try {
      session = await resolveSession(serviceDeps, requestSessionCookie(req));
    } catch (error) {
      req.log.warn({ err: error }, 'session store failed');
      return sendError(req, reply, 503, 'unavailable');
    }
    if (!session) return sendError(req, reply, 401, 'unauthenticated');

    const assertion = await deps.signer.sign({
      userId: session.userId,
      agentId: parsed.data.agent_id,
    });
    reply.header(ASSERTION_RESPONSE_HEADER, assertion);
    return reply.code(200).send({
      data: {
        assertion,
        tokenType: 'Bearer' as const,
        expiresInSeconds: deps.signer.ttlSeconds,
        kid: deps.signer.kid,
      },
      meta: { traceId: req.id },
    });
  });

  app.get('/.well-known/jwks.json', async (_req, reply) => {
    const jwk = await deps.signer.publicJwk();
    return reply
      .header('cache-control', 'public, max-age=300')
      .code(200)
      .send({ keys: [jwk] });
  });

  return app;
}
