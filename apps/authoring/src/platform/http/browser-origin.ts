import { ErrorCode } from '@cb/shared';
import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import { parsePublicAppOrigins, type Env } from '../config/env.js';
import { sendAuthError } from './_helpers.js';

type BrowserOriginEnv = Pick<Env, 'PUBLIC_APP_ORIGINS'>;

/** 返回已经过配置层严格校验、去重且保持声明顺序的公开站点 origin。 */
export function canonicalBrowserOrigins(env: BrowserOriginEnv): readonly string[] {
  return parsePublicAppOrigins(env.PUBLIC_APP_ORIGINS);
}

/** CORS 只反射显式公开站点；无 Origin 的非浏览器读取请求不会得到 CORS 响应头。 */
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

/**
 * 浏览器认证与 Cookie 鉴权的写请求只接受精确公开 Origin。Fetch Metadata 若存在，只允许
 * same-origin；无 Origin 的 CLI、same-site 子域和任何跨站请求都不能改变浏览器状态。
 */
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
