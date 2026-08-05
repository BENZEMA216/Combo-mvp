import type { preHandlerHookHandler } from 'fastify';
import { ErrorCode } from '@cb/shared';
import type { McpOAuthScope } from '@cb/shared';
import { sendAuthError } from '../http/_helpers.js';
import { resolveMcpAccessToken } from '../infra/mcp-access-token.js';

/** 集群内 MCP 委托路由只接受绑定 Combo MCP resource 的短期 Bearer Token。 */
export function requireMcpAuth(
  requiredScope: McpOAuthScope = 'combo.agent:read',
): preHandlerHookHandler {
  return async function (req, reply) {
    const authorization =
      typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
    try {
      const resolution = await resolveMcpAccessToken(
        req.server.infra.db,
        authorization,
        req.server.infra.env.EXTERNAL_MCP_PUBLIC_ORIGIN,
      );
      if (resolution.kind === 'valid') {
        if (!resolution.scopes.includes(requiredScope)) {
          return sendAuthError(req, reply, ErrorCode.FORBIDDEN);
        }
        req.auth = resolution.context;
        return;
      }
      return sendAuthError(
        req,
        reply,
        resolution.kind === 'disabled'
          ? ErrorCode.AUTH_ACCOUNT_DISABLED
          : ErrorCode.UNAUTHENTICATED,
      );
    } catch {
      req.log.warn({ traceId: req.id }, 'mcp access token store unavailable');
      return sendAuthError(req, reply, ErrorCode.DEPENDENCY_UNAVAILABLE);
    }
  };
}
