import type { FastifyInstance } from 'fastify';

import { registerEndpoints, type EndpointDecl } from '../../platform/http/_helpers.js';
import { requireTrustedMutationOrigin } from '../../platform/http/browser-origin.js';
import { requireAuth } from '../../platform/middleware/auth.js';
import {
  abandonPendingUsageRecoveryHandler,
  getPendingUsageRecoveryHandler,
  listPendingUsageRecoveriesHandler,
} from './pending-recovery-handlers.js';

export const PENDING_RECOVERY_ENDPOINTS: EndpointDecl[] = [
  {
    method: 'GET',
    url: '/runtime/pending-usage-recoveries',
    preHandlers: [requireAuth()],
    handler: listPendingUsageRecoveriesHandler(),
  },
  {
    method: 'GET',
    url: '/runtime/pending-usage-recoveries/:usageId',
    preHandlers: [requireAuth()],
    handler: getPendingUsageRecoveryHandler(),
  },
  {
    method: 'POST',
    url: '/runtime/pending-usage-recoveries/:usageId/abandon',
    preHandlers: [requireTrustedMutationOrigin(), requireAuth()],
    handler: abandonPendingUsageRecoveryHandler(),
  },
];

export async function registerPendingRecoveryRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, PENDING_RECOVERY_ENDPOINTS);
}
