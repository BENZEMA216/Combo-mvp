import type { FastifyInstance, onRequestHookHandler } from 'fastify';
import { ErrorCode } from '@cb/shared';

import { registerEndpoints, sendError, type EndpointDecl } from '../../platform/http/_helpers.js';
import { requireTrustedMutationOrigin } from '../../platform/http/browser-origin.js';
import { requireAuth } from '../../platform/middleware/auth.js';
import {
  createAgentPackageDraftHandler,
  createAgentPackageShareHandler,
  prepareAgentPackageRunHandler,
  readAgentPackageShareHandler,
  renderAgentPackageDraftHandler,
} from './handlers.js';

const ownerMutation = [requireTrustedMutationOrigin(), requireAuth()];
const noStore: onRequestHookHandler = async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  reply.header('pragma', 'no-cache');
};
const publicByLinkPrivacy: onRequestHookHandler = async (_req, reply) => {
  reply.header('cache-control', 'private, no-store');
  reply.header('pragma', 'no-cache');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('x-robots-tag', 'noindex, nofollow');
  reply.header('x-content-type-options', 'nosniff');
};
const rejectQueryString: onRequestHookHandler = async (req, reply) => {
  const rawUrl = req.raw.url ?? '';
  if (rawUrl.includes('?') || rawUrl.includes('#')) {
    return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
  }
};
const rejectGetBody: onRequestHookHandler = async (req, reply) => {
  const contentLength = req.headers['content-length'];
  if (
    req.headers['transfer-encoding'] !== undefined ||
    (contentLength !== undefined && contentLength !== '0')
  ) {
    return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
  }
};

export const PROJECT_HISTORY_AGENT_ENDPOINTS: EndpointDecl[] = [
  {
    method: 'POST',
    url: '/agent-package-drafts',
    onRequest: [noStore, rejectQueryString],
    preHandlers: ownerMutation,
    bodyLimit: 64 * 1_024,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: createAgentPackageDraftHandler(),
  },
  {
    method: 'POST',
    url: '/agent-package-drafts/:draftId/render',
    onRequest: [noStore, rejectQueryString],
    preHandlers: ownerMutation,
    bodyLimit: 4 * 1_024,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: renderAgentPackageDraftHandler(),
  },
  {
    method: 'POST',
    url: '/agent-package-shares',
    onRequest: [noStore, rejectQueryString],
    preHandlers: ownerMutation,
    bodyLimit: 8 * 1_024,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: createAgentPackageShareHandler(),
  },
  {
    method: 'GET',
    url: '/agent-package-shares/:shareToken',
    onRequest: [publicByLinkPrivacy, rejectQueryString, rejectGetBody],
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    handler: readAgentPackageShareHandler(),
  },
  {
    method: 'POST',
    url: '/agent-package-runs/prepare',
    onRequest: [publicByLinkPrivacy, rejectQueryString],
    bodyLimit: 8 * 1_024,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: prepareAgentPackageRunHandler(),
  },
];

export async function registerProjectHistoryAgentRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, PROJECT_HISTORY_AGENT_ENDPOINTS);
}
