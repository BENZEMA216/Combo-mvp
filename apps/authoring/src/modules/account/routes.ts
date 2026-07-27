import type { FastifyInstance } from 'fastify';
import { registerEndpoints, type EndpointDecl } from '../../platform/http/_helpers.js';
import {
  AUTH_JSON_BODY_LIMIT,
  authNoStore,
  requireAuthJson,
} from '../../platform/http/auth-request.js';
import { requireTrustedMutationOrigin } from '../../platform/http/browser-origin.js';
import { requireAuth } from '../../platform/middleware/auth.js';
import {
  emailChallengeHandler,
  emailVerificationHandler,
  logoutHandler,
  meHandler,
} from './handlers.js';

const mutationGuards = [requireTrustedMutationOrigin(), requireAuthJson()];

/** 第一方邮箱认证的完整公开面；不保留外部托管登录、续期或测试绕过端点。 */
export const ACCOUNT_ENDPOINTS: EndpointDecl[] = [
  {
    method: 'POST',
    url: '/auth/email/challenges',
    onRequest: [authNoStore()],
    preHandlers: mutationGuards,
    bodyLimit: AUTH_JSON_BODY_LIMIT,
    handler: emailChallengeHandler(),
  },
  {
    method: 'POST',
    url: '/auth/email/verifications',
    onRequest: [authNoStore()],
    preHandlers: mutationGuards,
    bodyLimit: AUTH_JSON_BODY_LIMIT,
    handler: emailVerificationHandler(),
  },
  {
    method: 'GET',
    url: '/me',
    onRequest: [authNoStore()],
    preHandlers: [requireAuth()],
    handler: meHandler(),
  },
  {
    method: 'POST',
    url: '/auth/logout',
    onRequest: [authNoStore()],
    preHandlers: mutationGuards,
    bodyLimit: AUTH_JSON_BODY_LIMIT,
    handler: logoutHandler(),
  },
];

export async function registerAccountRoutes(scoped: FastifyInstance): Promise<void> {
  registerEndpoints(scoped, ACCOUNT_ENDPOINTS);
}
