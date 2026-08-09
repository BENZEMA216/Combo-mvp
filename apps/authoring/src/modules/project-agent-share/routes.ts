import type { FastifyInstance } from 'fastify';
import { registerEndpoints, type EndpointDecl } from '../../platform/http/_helpers.js';
import { requireTrustedMutationOrigin } from '../../platform/http/browser-origin.js';
import { requireAuth } from '../../platform/middleware/auth.js';
import { createProjectAgentShareHandler, getProjectAgentShareHandler } from './handlers.js';

export const PROJECT_AGENT_SHARE_ENDPOINTS: EndpointDecl[] = [
  {
    method: 'POST',
    url: '/project-agent-shares',
    bodyLimit: 32 * 1_024,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    preHandlers: [requireTrustedMutationOrigin(), requireAuth()],
    handler: createProjectAgentShareHandler(),
  },
  {
    method: 'GET',
    url: '/project-agent-shares/:shareToken',
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    handler: getProjectAgentShareHandler(),
  },
];

export async function registerProjectAgentShareRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, PROJECT_AGENT_SHARE_ENDPOINTS);
}
