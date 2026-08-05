// Test-only 体验数据入口。组合根只在 COMBO_ENVIRONMENT=test 时注册。
import type { FastifyInstance } from 'fastify';
import { requireTrustedMutationOrigin } from '../../platform/http/browser-origin.js';
import { registerEndpoints, type EndpointDecl } from '../../platform/http/_helpers.js';
import { requireAuth } from '../../platform/middleware/auth.js';
import { seedComboMiniappHandler } from './handlers.js';

const browserMutationGuards = [requireTrustedMutationOrigin(), requireAuth()];

export const DEMO_ENDPOINTS: EndpointDecl[] = [
  {
    method: 'POST',
    url: '/test/demo-agents/combo-miniapp',
    preHandlers: browserMutationGuards,
    handler: seedComboMiniappHandler(),
  },
];

export async function registerDemoRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, DEMO_ENDPOINTS);
}
