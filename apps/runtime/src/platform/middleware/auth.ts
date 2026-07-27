// 鉴权中间件：只接受 authoring 按环境签发的主机 Cookie，并只读同库 auth_sessions/users。
// 缺失、畸形、未知、过期或已撤销会话返回 401；停用账号返回 403；数据库故障返回 503。
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { authSessionCookieName, ErrorCode } from '@cb/shared';
import { sendAuthError } from '../http/_helpers.js';
import { resolveAuthSession, type AuthSessionResolution } from '../infra/auth-session.js';

function rejectsNonCookieCredential(req: FastifyRequest): boolean {
  const query = req.query as { token?: unknown; access_token?: unknown } | undefined;
  return (
    req.headers.authorization !== undefined ||
    query?.token !== undefined ||
    query?.access_token !== undefined
  );
}

async function resolveRequestSession(req: FastifyRequest): Promise<AuthSessionResolution | null> {
  if (rejectsNonCookieCredential(req)) return { kind: 'invalid' };
  try {
    const cookieName = authSessionCookieName(req.server.infra.env.SESSION_COOKIE_SECURE);
    return await resolveAuthSession(req.server.infra.db, req.cookies?.[cookieName]);
  } catch {
    return null;
  }
}

function replyForResolution(
  req: FastifyRequest,
  reply: FastifyReply,
  resolution: AuthSessionResolution | null,
): FastifyReply {
  if (resolution === null) {
    req.log.warn(
      { code: ErrorCode.DEPENDENCY_UNAVAILABLE, traceId: req.id },
      'authentication session store unavailable',
    );
    return sendAuthError(req, reply, ErrorCode.DEPENDENCY_UNAVAILABLE);
  }
  if (resolution.kind === 'disabled') {
    return sendAuthError(req, reply, ErrorCode.AUTH_ACCOUNT_DISABLED);
  }
  return sendAuthError(req, reply, ErrorCode.UNAUTHENTICATED);
}

/** 普通业务接口只接受当前环境选定的主机 Cookie，并显式拒绝替代凭据。 */
export function requireAuth(): preHandlerHookHandler {
  return async (req, reply) => {
    const resolution = await resolveRequestSession(req);
    if (!resolution || resolution.kind !== 'valid') {
      return replyForResolution(req, reply, resolution);
    }
    req.auth = resolution.context;
  };
}

/** SSE 在建流前额外拒绝 query token；新连接仍只读同一枚 PostgreSQL 会话 Cookie。 */
export function requireSseAuth(): preHandlerHookHandler {
  return async (req, reply) => {
    if (rejectsNonCookieCredential(req)) {
      return sendAuthError(req, reply, ErrorCode.UNAUTHENTICATED);
    }

    const resolution = await resolveRequestSession(req);
    if (!resolution || resolution.kind !== 'valid') {
      return replyForResolution(req, reply, resolution);
    }
    req.auth = resolution.context;
  };
}
