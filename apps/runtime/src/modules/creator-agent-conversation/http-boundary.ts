import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import {
  VNEXT_ERROR_CLASSIFICATION,
  errorResponseFor,
  parsePublicHttpRequestRoot,
  type PublicHttpRequestRootName,
  type VnextErrorCode,
} from '@cb/creator-agent-protocol';
import { authSessionCookieName } from '@cb/shared';
import { canonicalBrowserOrigins } from '../../platform/http/browser-origin.js';
import { resolveAuthSession } from '../../platform/infra/auth-session.js';

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** VNext OpenAPI freezes a bare VnextErrorResponse, never the legacy `{error: ...}` envelope. */
export function sendVnextError(
  req: FastifyRequest,
  reply: FastifyReply,
  code: VnextErrorCode,
): FastifyReply {
  reply.code(VNEXT_ERROR_CLASSIFICATION[code].httpStatus).send(errorResponseFor(code, req.id));
  return reply;
}

export function requireVnextMutationOrigin(): preHandlerHookHandler {
  return async (req, reply) => {
    const origin = singleHeader(req.headers.origin);
    const fetchSite = singleHeader(req.headers['sec-fetch-site']);
    if (
      origin !== undefined &&
      canonicalBrowserOrigins(req.server.infra.env).includes(origin) &&
      (fetchSite === undefined || fetchSite.toLowerCase() === 'same-origin')
    ) {
      return;
    }
    req.log.warn({ code: 'FORBIDDEN', traceId: req.id }, 'blocked VNext mutation origin');
    return sendVnextError(req, reply, 'FORBIDDEN');
  };
}

export function requireVnextBodySchema(root: PublicHttpRequestRootName): preHandlerHookHandler {
  return async (req, reply) => {
    try {
      parsePublicHttpRequestRoot(root, req.body);
    } catch {
      return sendVnextError(req, reply, 'INVALID_INPUT');
    }
  };
}

function hasAlternateCredential(req: FastifyRequest): boolean {
  const query = req.query as { token?: unknown; access_token?: unknown } | undefined;
  return (
    req.headers.authorization !== undefined ||
    query?.token !== undefined ||
    query?.access_token !== undefined
  );
}

export function requireVnextAuth(): preHandlerHookHandler {
  return async (req, reply) => {
    if (hasAlternateCredential(req)) return sendVnextError(req, reply, 'UNAUTHORIZED');
    try {
      const cookieName = authSessionCookieName(req.server.infra.env.SESSION_COOKIE_SECURE);
      const resolution = await resolveAuthSession(req.server.infra.db, req.cookies?.[cookieName]);
      if (resolution.kind === 'valid') {
        req.auth = resolution.context;
        return;
      }
      return sendVnextError(
        req,
        reply,
        resolution.kind === 'disabled' ? 'FORBIDDEN' : 'UNAUTHORIZED',
      );
    } catch {
      // No generic dependency code exists in the frozen VNext registry. For this create-only
      // endpoint AGENT_OFFLINE is the retry-safe 503 response and preserves the same key.
      return sendVnextError(req, reply, 'AGENT_OFFLINE');
    }
  };
}
