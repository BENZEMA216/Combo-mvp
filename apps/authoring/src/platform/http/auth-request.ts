import { ErrorCode, errorBodyFor } from '@cb/shared';
import type { onRequestHookHandler, preHandlerHookHandler } from 'fastify';

export const AUTH_JSON_BODY_LIMIT = 4 * 1_024;

/** 在 body parser 之前设置，确保 400、413、415 也不会被共享缓存保存。 */
export function authNoStore(): onRequestHookHandler {
  return async function (_req, reply) {
    reply.header('cache-control', 'no-store');
  };
}

/** 认证 POST 只接受 application/json；具体字段继续由共享 Zod schema 严格校验。 */
export function requireAuthJson(): preHandlerHookHandler {
  return async function (req, reply) {
    const raw = req.headers['content-type'];
    if (
      typeof raw === 'string' &&
      raw.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
    ) {
      return;
    }
    // Fastify 对完全不支持的媒体类型通常会在本守卫前返回 415；该分支覆盖缺失和重复 header。
    const { body } = errorBodyFor(ErrorCode.VALIDATION_FAILED, req.id, {
      userMessage: '认证请求必须使用 JSON 格式。',
    });
    return reply.code(415).send({ error: body });
  };
}
