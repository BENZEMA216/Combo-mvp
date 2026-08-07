import type { FastifyInstance } from 'fastify';
import { requireTrustedMutationOrigin } from '../../platform/http/browser-origin.js';
import { registerEndpoints, type EndpointDecl } from '../../platform/http/_helpers.js';
import { requireAuth } from '../../platform/middleware/auth.js';
import {
  commitAgentRevisionHandler,
  createAgentProjectHandler,
  createAgentReleaseHandler,
  getAgentProjectHandler,
  getAgentRevisionHandler,
  listAgentProjectsHandler,
  recordAgentTestReviewHandler,
} from './handlers.js';

const browserMutationGuards = [requireTrustedMutationOrigin(), requireAuth()];

export const AGENT_PROJECT_ENDPOINTS: EndpointDecl[] = [
  {
    method: 'POST',
    url: '/agent-projects',
    preHandlers: browserMutationGuards,
    handler: createAgentProjectHandler(),
  },
  {
    method: 'GET',
    url: '/agent-projects',
    preHandlers: [requireAuth()],
    handler: listAgentProjectsHandler(),
  },
  {
    method: 'GET',
    url: '/agent-projects/:projectId',
    preHandlers: [requireAuth()],
    handler: getAgentProjectHandler(),
  },
  {
    method: 'POST',
    url: '/agent-projects/:projectId/revisions',
    preHandlers: browserMutationGuards,
    handler: commitAgentRevisionHandler(),
  },
  {
    method: 'GET',
    url: '/agent-projects/:projectId/revisions/:revisionId',
    preHandlers: [requireAuth()],
    handler: getAgentRevisionHandler(),
  },
  {
    method: 'POST',
    url: '/agent-projects/:projectId/tests/:testId/reviews',
    preHandlers: browserMutationGuards,
    handler: recordAgentTestReviewHandler(),
  },
  {
    method: 'POST',
    url: '/agent-projects/:projectId/releases',
    preHandlers: browserMutationGuards,
    handler: createAgentReleaseHandler(),
  },
];

export async function registerAgentProjectRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, AGENT_PROJECT_ENDPOINTS);
}
