// 产物域路由（requireAuth）。
//   GET  /runtime/artifacts/:id/content                  产物内容回读（画布 iframe/渲染源）
//   POST /runtime/studio/sessions/:id/ui-revisions       Codex 直接保存合规 Miniapp HTML
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../platform/middleware/auth.js';
import { registerEndpoints, type EndpointDecl } from '../../platform/http/_helpers.js';
import { requireTrustedMutationOrigin } from '../../platform/http/browser-origin.js';
import { artifactContentHandler, saveAgentUiRevisionHandler } from './handlers.js';

export const ARTIFACT_ENDPOINTS: EndpointDecl[] = [
  {
    method: 'GET',
    url: '/runtime/artifacts/:id/content',
    preHandlers: [requireAuth()],
    handler: artifactContentHandler(),
  },
  {
    method: 'POST',
    url: '/runtime/studio/sessions/:id/ui-revisions',
    preHandlers: [requireTrustedMutationOrigin(), requireAuth()],
    handler: saveAgentUiRevisionHandler(),
  },
];

export async function registerArtifactRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, ARTIFACT_ENDPOINTS);
}
