import type { FastifyInstance } from 'fastify';
import {
  artifactContentHandler,
  saveAgentUiRevisionHandler,
} from '../modules/artifact/handlers.js';
import {
  getAgentTestHandler,
  listAgentProjectTestsHandler,
  startAgentTestHandler,
} from '../modules/agent-project/handlers.js';
import { createStudioSessionHandler } from '../modules/session/handlers.js';
import { requireMcpAuth } from '../platform/middleware/mcp-auth.js';

/** 仅供 Authoring 集群服务调用；公网 Nginx 不转发 `/internal/`。 */
export async function registerInternalMcpRuntimeRoutes(app: FastifyInstance): Promise<void> {
  const readAuth = requireMcpAuth('combo.agent:read');
  const writeAuth = requireMcpAuth('combo.agent:write');
  app.post(
    '/internal/mcp/studio/sessions',
    { preHandler: writeAuth },
    createStudioSessionHandler(),
  );
  app.post(
    '/internal/mcp/studio/sessions/:id/ui-revisions',
    { preHandler: writeAuth, bodyLimit: 2 * 1_024 * 1_024 },
    saveAgentUiRevisionHandler(),
  );
  app.get(
    '/internal/mcp/artifacts/:id/content',
    { preHandler: readAuth },
    artifactContentHandler(),
  );
  app.post(
    '/internal/mcp/agent-revisions/:revisionId/tests',
    { preHandler: writeAuth },
    startAgentTestHandler(),
  );
  app.get(
    '/internal/mcp/agent-projects/:projectId/tests',
    { preHandler: readAuth },
    listAgentProjectTestsHandler(),
  );
  app.get('/internal/mcp/agent-tests/:testId', { preHandler: readAuth }, getAgentTestHandler());
}
