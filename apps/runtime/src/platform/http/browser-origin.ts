import { ErrorCode } from '@cb/shared';
import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Env } from '../config/env.js';
import { parsePublicAppOrigins } from '../config/env.js';
import { sendAuthError } from './_helpers.js';

type BrowserOriginEnv = Pick<Env, 'PUBLIC_APP_ORIGINS'>;

/** 返回经过配置层同一严格语法校验的公开站点 origin 列表。 */
export function canonicalBrowserOrigins(env: BrowserOriginEnv): readonly string[] {
  return parsePublicAppOrigins(env.PUBLIC_APP_ORIGINS);
}

/** 凭据型 CORS 只反射明确列入白名单的公开站点。 */
export function corsOriginPolicy(env: BrowserOriginEnv) {
  const allowed = new Set(canonicalBrowserOrigins(env));
  return (
    origin: string | undefined,
    callback: (error: Error | null, allow: boolean) => void,
  ): void => callback(null, origin !== undefined && allowed.has(origin));
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Cookie 鉴权的写请求必须来自明确公开 origin，且 Fetch Metadata 不得是同站子域。 */
export function isTrustedMutationRequest(req: FastifyRequest): boolean {
  const origin = singleHeader(req.headers.origin);
  if (!origin || !canonicalBrowserOrigins(req.server.infra.env).includes(origin)) return false;

  const rawFetchSite = req.headers['sec-fetch-site'];
  if (rawFetchSite === undefined) return true;
  return typeof rawFetchSite === 'string' && rawFetchSite.toLowerCase() === 'same-origin';
}

export function requireTrustedMutationOrigin(): preHandlerHookHandler {
  return async function (req, reply) {
    if (isTrustedMutationRequest(req)) return;

    req.log.warn(
      { code: ErrorCode.FORBIDDEN, traceId: req.id },
      'blocked untrusted browser mutation request',
    );
    return sendAuthError(req, reply, ErrorCode.FORBIDDEN);
  };
}
