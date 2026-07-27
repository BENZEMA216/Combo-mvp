// 会话域路由（HTTP 端点 requireAuth；SSE 端点 requireSseAuth，仅同源 Cookie）。
//   POST /runtime/sessions                开会话
//   POST /runtime/studio/sessions         原子进入本人 Agent 的 Miniapp 设计空间
//   GET  /runtime/sessions                我的会话列表
//   GET  /runtime/sessions/:id            会话详情（消息 + 产物 + 能力摘要）
//   PATCH /runtime/sessions/:id           会话改名
//   DELETE /runtime/sessions/:id          软归档
//   POST /runtime/sessions/:id/messages   发消息（落 user 消息后异步生成，立即返回）
//   POST /runtime/sessions/:id/interrupt  打断当前轮
//   GET  /runtime/sessions/:id/stream     流式生成事件（SSE，Last-Event-ID 续传）
import type { FastifyInstance } from 'fastify';
import { requireAuth, requireSseAuth } from '../../platform/middleware/auth.js';
import { registerEndpoints, type EndpointDecl } from '../../platform/http/_helpers.js';
import { requireTrustedMutationOrigin } from '../../platform/http/browser-origin.js';
import { sessionStreamHandler } from '../agent/stream.js';
import {
  archiveSessionHandler,
  createSessionHandler,
  createStudioSessionHandler,
  getSessionDetailHandler,
  interruptHandler,
  listSessionsHandler,
  sendMessageHandler,
  updateSessionHandler,
} from './handlers.js';

const browserMutationGuards = [requireTrustedMutationOrigin(), requireAuth()];

export const SESSION_ENDPOINTS: EndpointDecl[] = [
  {
    method: 'POST',
    url: '/runtime/studio/sessions',
    preHandlers: browserMutationGuards,
    handler: createStudioSessionHandler(),
  },
  {
    method: 'POST',
    url: '/runtime/sessions',
    preHandlers: browserMutationGuards,
    handler: createSessionHandler(),
  },
  {
    method: 'GET',
    url: '/runtime/sessions',
    preHandlers: [requireAuth()],
    handler: listSessionsHandler(),
  },
  {
    method: 'GET',
    url: '/runtime/sessions/:id',
    preHandlers: [requireAuth()],
    handler: getSessionDetailHandler(),
  },
  {
    method: 'PATCH',
    url: '/runtime/sessions/:id',
    preHandlers: browserMutationGuards,
    handler: updateSessionHandler(),
  },
  {
    method: 'DELETE',
    url: '/runtime/sessions/:id',
    preHandlers: browserMutationGuards,
    handler: archiveSessionHandler(),
  },
  {
    method: 'POST',
    url: '/runtime/sessions/:id/messages',
    preHandlers: browserMutationGuards,
    handler: sendMessageHandler(),
  },
  {
    method: 'POST',
    url: '/runtime/sessions/:id/interrupt',
    preHandlers: browserMutationGuards,
    handler: interruptHandler(),
  },
  {
    method: 'GET',
    url: '/runtime/sessions/:id/stream',
    preHandlers: [requireSseAuth()],
    handler: sessionStreamHandler(),
  },
];

export async function registerSessionRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, SESSION_ENDPOINTS);
}
