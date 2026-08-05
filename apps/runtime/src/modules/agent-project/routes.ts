import type { FastifyInstance } from 'fastify';
import { requireTrustedMutationOrigin } from '../../platform/http/browser-origin.js';
import { registerEndpoints, type EndpointDecl } from '../../platform/http/_helpers.js';
import { requireAuth } from '../../platform/middleware/auth.js';
import {
  createReleasedAgentSessionHandler,
  getAgentTestHandler,
  listAgentProjectTestsHandler,
  startAgentTestHandler,
} from './handlers.js';

const browserMutationGuards = [requireTrustedMutationOrigin(), requireAuth()];

export const AGENT_PROJECT_RUNTIME_ENDPOINTS: EndpointDecl[] = [
  {
    method: 'POST',
    url: '/runtime/agent-revisions/:revisionId/tests',
    preHandlers: browserMutationGuards,
    handler: startAgentTestHandler(),
  },
  {
    method: 'GET',
    url: '/runtime/agent-tests/:testId',
    preHandlers: [requireAuth()],
    handler: getAgentTestHandler(),
  },
  {
    method: 'GET',
    url: '/runtime/agent-projects/:projectId/tests',
    preHandlers: [requireAuth()],
    handler: listAgentProjectTestsHandler(),
  },
  {
    method: 'POST',
    url: '/runtime/agents/:projectId/sessions',
    preHandlers: browserMutationGuards,
    handler: createReleasedAgentSessionHandler(),
  },
];

export async function registerAgentProjectRuntimeRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, AGENT_PROJECT_RUNTIME_ENDPOINTS);
}
