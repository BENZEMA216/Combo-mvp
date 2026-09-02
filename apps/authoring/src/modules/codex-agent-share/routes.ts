import type { FastifyInstance } from 'fastify';
import { registerEndpoints, type EndpointDecl } from '../../platform/http/_helpers.js';
import { requireTrustedMutationOrigin } from '../../platform/http/browser-origin.js';
import { requireAuth } from '../../platform/middleware/auth.js';
import { createCodexAgentShareHandler, getCodexAgentShareHandler } from './handlers.js';

export const CODEX_AGENT_SHARE_ENDPOINTS: EndpointDecl[] = [
  {
    method: 'POST',
    url: '/codex-agent-shares',
    bodyLimit: 128 * 1_024,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    preHandlers: [requireTrustedMutationOrigin(), requireAuth()],
    handler: createCodexAgentShareHandler(),
  },
  {
    method: 'GET',
    url: '/codex-agent-shares/:shareToken',
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    handler: getCodexAgentShareHandler(),
  },
];

export async function registerCodexAgentShareRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, CODEX_AGENT_SHARE_ENDPOINTS);
}
