// 能力项域路由（全部 requireAuth；发布是能力项上的标记动作，不在任务状态轴上）。
//   GET  /capabilities?taskId=                能力项列表（可按任务过滤）
//   GET  /capabilities/:capabilityId          能力项详情
//   POST /capabilities/:capabilityId/publish   打发布标记（首次发布生成 share_token）
//   POST /capabilities/:capabilityId/unpublish 取消发布（share_token 保留）
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../platform/middleware/auth.js';
import { registerEndpoints, type EndpointDecl } from '../../platform/http/_helpers.js';
import { requireTrustedMutationOrigin } from '../../platform/http/browser-origin.js';
import {
  getCapabilityHandler,
  listCapabilitiesHandler,
  publishHandler,
  unpublishHandler,
} from './handlers.js';

const browserMutationGuards = [requireTrustedMutationOrigin(), requireAuth()];

export const CAPABILITY_ENDPOINTS: EndpointDecl[] = [
  {
    method: 'GET',
    url: '/capabilities',
    preHandlers: [requireAuth()],
    handler: listCapabilitiesHandler(),
  },
  {
    method: 'GET',
    url: '/capabilities/:capabilityId',
    preHandlers: [requireAuth()],
    handler: getCapabilityHandler(),
  },
  {
    method: 'POST',
    url: '/capabilities/:capabilityId/publish',
    preHandlers: browserMutationGuards,
    handler: publishHandler(),
  },
  {
    method: 'POST',
    url: '/capabilities/:capabilityId/unpublish',
    preHandlers: browserMutationGuards,
    handler: unpublishHandler(),
  },
];

export async function registerCapabilityRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, CAPABILITY_ENDPOINTS);
}
