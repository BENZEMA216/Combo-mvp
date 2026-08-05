import type { FastifyInstance } from 'fastify';
import {
  authorizationGetHandler,
  authorizationPostHandler,
  authorizationServerMetadataHandler,
  codexPluginGuideHandler,
  dynamicClientRegistrationHandler,
  EXTERNAL_MCP_PUBLIC_PATHS,
  mcpGetHandler,
  mcpPostHandler,
  protectedResourceMetadataHandler,
  tokenHandler,
} from './handlers.js';

const OAUTH_BODY_LIMIT = 16 * 1_024;
const MCP_BODY_LIMIT = 2 * 1_024 * 1_024;

/** 注册根级 OAuth 发现、授权、远程 MCP 与公开安装页；这些路径不属于浏览器 `/api/v1`。 */
export async function registerExternalMcpRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scoped) => {
    scoped.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: OAUTH_BODY_LIMIT },
      (_req, body, done) => done(null, body),
    );

    scoped.get(EXTERNAL_MCP_PUBLIC_PATHS.protectedResource, protectedResourceMetadataHandler());
    scoped.get(
      EXTERNAL_MCP_PUBLIC_PATHS.protectedResourceForMcp,
      protectedResourceMetadataHandler(),
    );
    scoped.get(EXTERNAL_MCP_PUBLIC_PATHS.authorizationServer, authorizationServerMetadataHandler());
    scoped.post(EXTERNAL_MCP_PUBLIC_PATHS.registration, {
      bodyLimit: OAUTH_BODY_LIMIT,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      handler: dynamicClientRegistrationHandler(),
    });
    scoped.get(EXTERNAL_MCP_PUBLIC_PATHS.authorize, {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      handler: authorizationGetHandler(),
    });
    scoped.post(EXTERNAL_MCP_PUBLIC_PATHS.authorize, {
      bodyLimit: OAUTH_BODY_LIMIT,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      handler: authorizationPostHandler(),
    });
    scoped.post(EXTERNAL_MCP_PUBLIC_PATHS.token, {
      bodyLimit: OAUTH_BODY_LIMIT,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      handler: tokenHandler(),
    });
    scoped.get(EXTERNAL_MCP_PUBLIC_PATHS.mcp, {
      config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
      handler: mcpGetHandler(),
    });
    scoped.post(EXTERNAL_MCP_PUBLIC_PATHS.mcp, {
      bodyLimit: MCP_BODY_LIMIT,
      config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
      handler: mcpPostHandler(),
    });
    scoped.get(EXTERNAL_MCP_PUBLIC_PATHS.guide, codexPluginGuideHandler());
  });
}
