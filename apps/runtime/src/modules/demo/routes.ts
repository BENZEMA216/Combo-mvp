// Test 专属演示端点；生产、Preview 与本地 development 均不注册。
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../platform/middleware/auth.js';
import { requireTrustedMutationOrigin } from '../../platform/http/browser-origin.js';
import { registerEndpoints, type EndpointDecl } from '../../platform/http/_helpers.js';
import { createComboMiniappDemoStudioHandler } from './handlers.js';

const browserMutationGuards = [requireTrustedMutationOrigin(), requireAuth()];

export const TEST_DEMO_ENDPOINTS: EndpointDecl[] = [
  {
    method: 'POST',
    url: '/runtime/test/demo-agents/combo-miniapp',
    preHandlers: browserMutationGuards,
    handler: createComboMiniappDemoStudioHandler(),
  },
];

export function demoEndpointsForEnvironment(environment: string): EndpointDecl[] {
  return environment === 'test' ? TEST_DEMO_ENDPOINTS : [];
}

export async function registerDemoRoutes(
  scoped: FastifyInstance,
  environment: string,
): Promise<void> {
  registerEndpoints(scoped, demoEndpointsForEnvironment(environment));
}
