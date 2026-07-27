import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  AUTH_SESSION_COOKIE_HTTP_ONLY,
  AUTH_SESSION_COOKIE_MAX_AGE_SECONDS,
  AUTH_SESSION_COOKIE_PATH,
  AUTH_SESSION_COOKIE_SAME_SITE,
  authSessionCookieName,
  EMAIL_OTP_EXPIRES_IN_SECONDS,
  EMAIL_OTP_RESEND_AFTER_SECONDS,
  EmailChallengeBodySchema,
  EmailVerificationBodySchema,
  ErrorCode,
  LogoutBodySchema,
  type EmailChallengeResult,
  type EmailVerificationResult,
  type Envelope,
  type LogoutResult,
  type MeView,
} from '@cb/shared';
import { sendAuthError } from '../../platform/http/_helpers.js';
import { asTxPool } from '../../platform/infra/db-tx.js';
import { authSessionDigest } from '../../platform/infra/auth-session.js';
import { readMe, revokeSession } from './repo.js';
import { requestEmailChallenge, verifyEmail, type AccountAuthDependencies } from './service.js';

const NO_STORE = 'no-store';

function authDependencies(req: FastifyRequest): AccountAuthDependencies {
  return {
    db: asTxPool(req.server.infra.db),
    mailer: req.server.infra.resend,
    rateLimiter: req.server.infra.authRateLimiter,
    hmacSecret: req.server.infra.env.OTP_HMAC_SECRET,
  };
}

function noStore(reply: FastifyReply): void {
  reply.header('cache-control', NO_STORE);
}

function sessionCookieOptions(req: FastifyRequest, maxAge?: number) {
  return {
    httpOnly: AUTH_SESSION_COOKIE_HTTP_ONLY,
    secure: req.server.infra.env.SESSION_COOKIE_SECURE,
    sameSite: AUTH_SESSION_COOKIE_SAME_SITE,
    path: AUTH_SESSION_COOKIE_PATH,
    ...(maxAge === undefined ? {} : { maxAge }),
  };
}

function requestSessionCookieName(req: FastifyRequest): string {
  return authSessionCookieName(req.server.infra.env.SESSION_COOKIE_SECURE);
}

function requestSessionCookie(req: FastifyRequest): string | undefined {
  return req.cookies?.[requestSessionCookieName(req)];
}

function clearSessionCookie(req: FastifyRequest, reply: FastifyReply): void {
  reply.clearCookie(requestSessionCookieName(req), sessionCookieOptions(req));
}

function logDependencyFailure(req: FastifyRequest, operation: string): void {
  req.log.warn(
    { code: ErrorCode.DEPENDENCY_UNAVAILABLE, traceId: req.id, operation },
    'authentication dependency unavailable',
  );
}

export function emailChallengeHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    noStore(reply);
    const parsed = EmailChallengeBodySchema.safeParse(req.body);
    if (!parsed.success) return sendAuthError(req, reply, ErrorCode.VALIDATION_FAILED);

    const result = await requestEmailChallenge(authDependencies(req), {
      email: parsed.data.email,
      clientAddress: req.ip,
      traceId: req.id,
    });
    if (result.kind === 'invalid_input') {
      return sendAuthError(req, reply, ErrorCode.VALIDATION_FAILED);
    }
    if (result.kind === 'rate_limited') {
      reply.header('retry-after', String(result.retryAfterSeconds));
      return sendAuthError(req, reply, ErrorCode.RATE_LIMITED);
    }
    if (result.kind === 'dependency_unavailable') {
      logDependencyFailure(req, 'email_challenge');
      return sendAuthError(req, reply, ErrorCode.DEPENDENCY_UNAVAILABLE);
    }

    const data: EmailChallengeResult = {
      accepted: true,
      expiresInSeconds: EMAIL_OTP_EXPIRES_IN_SECONDS,
      resendAfterSeconds: EMAIL_OTP_RESEND_AFTER_SECONDS,
    };
    const body: Envelope<EmailChallengeResult> = { data, meta: { traceId: req.id } };
    return reply.code(202).send(body);
  };
}

export function emailVerificationHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    noStore(reply);
    const parsed = EmailVerificationBodySchema.safeParse(req.body);
    if (!parsed.success) return sendAuthError(req, reply, ErrorCode.VALIDATION_FAILED);

    const result = await verifyEmail(authDependencies(req), {
      ...parsed.data,
      clientAddress: req.ip,
      traceId: req.id,
      currentSessionCookie: requestSessionCookie(req),
    });
    if (result.kind === 'invalid_input') {
      return sendAuthError(req, reply, ErrorCode.VALIDATION_FAILED);
    }
    if (result.kind === 'invalid_code') {
      return sendAuthError(req, reply, ErrorCode.AUTH_OTP_INVALID);
    }
    if (result.kind === 'account_disabled') {
      return sendAuthError(req, reply, ErrorCode.AUTH_ACCOUNT_DISABLED);
    }
    if (result.kind === 'rate_limited') {
      reply.header('retry-after', String(result.retryAfterSeconds));
      return sendAuthError(req, reply, ErrorCode.RATE_LIMITED);
    }
    if (result.kind === 'dependency_unavailable') {
      logDependencyFailure(req, 'email_verification');
      return sendAuthError(req, reply, ErrorCode.DEPENDENCY_UNAVAILABLE);
    }

    reply.setCookie(
      requestSessionCookieName(req),
      result.sessionCookie,
      sessionCookieOptions(req, AUTH_SESSION_COOKIE_MAX_AGE_SECONDS),
    );
    const data: EmailVerificationResult = { user: result.user, returnTo: result.returnTo };
    const body: Envelope<EmailVerificationResult> = { data, meta: { traceId: req.id } };
    return reply.code(200).send(body);
  };
}

export function meHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    noStore(reply);
    const userId = req.auth?.userId;
    if (!userId) return sendAuthError(req, reply, ErrorCode.UNAUTHENTICATED);

    let row;
    try {
      row = await readMe(req.server.infra.db, userId);
    } catch {
      logDependencyFailure(req, 'read_me');
      return sendAuthError(req, reply, ErrorCode.DEPENDENCY_UNAVAILABLE);
    }
    if (!row) return sendAuthError(req, reply, ErrorCode.UNAUTHENTICATED);
    if (row.disabledAt) return sendAuthError(req, reply, ErrorCode.AUTH_ACCOUNT_DISABLED);

    const { disabledAt: _disabledAt, ...data } = row;
    const body: Envelope<MeView> = { data, meta: { traceId: req.id } };
    return reply.code(200).send(body);
  };
}

/** 无会话、畸形会话、未知会话与重复调用都成功；可识别 Cookie 的数据库故障返回 503。 */
export function logoutHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    noStore(reply);
    const parsed = LogoutBodySchema.safeParse(req.body);
    if (!parsed.success) return sendAuthError(req, reply, ErrorCode.VALIDATION_FAILED);

    const digest = authSessionDigest(requestSessionCookie(req));
    if (digest) {
      try {
        await revokeSession(req.server.infra.db, digest, req.id);
      } catch {
        logDependencyFailure(req, 'logout');
        return sendAuthError(req, reply, ErrorCode.DEPENDENCY_UNAVAILABLE);
      }
    }

    clearSessionCookie(req, reply);
    const data: LogoutResult = { loggedOut: true };
    const body: Envelope<LogoutResult> = { data, meta: { traceId: req.id } };
    return reply.code(200).send(body);
  };
}
