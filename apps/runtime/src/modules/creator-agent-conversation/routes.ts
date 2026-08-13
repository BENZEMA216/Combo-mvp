import type { FastifyInstance } from 'fastify';
import { registerEndpoints, type EndpointDecl } from '../../platform/http/_helpers.js';
import { createConsumerConversationHandler } from './handlers.js';
import { requireVnextAuth, requireVnextMutationOrigin, sendVnextError } from './http-boundary.js';

export const CREATOR_AGENT_CONVERSATION_ENDPOINTS: EndpointDecl[] = [
  {
    method: 'POST',
    url: '/v1/public/agents/:slug/conversations',
    preHandlers: [requireVnextMutationOrigin(), requireVnextAuth()],
    handler: createConsumerConversationHandler(),
  },
];

export async function registerCreatorAgentConversationRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scoped) => {
    scoped.setErrorHandler((error, req, reply) => {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 429) return sendVnextError(req, reply, 'RATE_LIMITED');
      if (
        (error as { validation?: unknown }).validation ||
        statusCode === 400 ||
        statusCode === 413 ||
        statusCode === 415
      ) {
        return sendVnextError(req, reply, 'INVALID_INPUT');
      }
      req.log.error({ err: error, traceId: req.id }, 'VNext request failed');
      return sendVnextError(req, reply, 'AGENT_OFFLINE');
    });
    registerEndpoints(scoped, CREATOR_AGENT_CONVERSATION_ENDPOINTS);
  });
}
