// 路由公共工具：端点声明、注册与统一 ErrorEnvelope 回复。
// 普通业务和认证边界都不暴露内部 code、状态细节或堆栈。
import type {
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
  RouteHandlerMethod,
  preHandlerHookHandler,
  RouteOptions,
} from 'fastify';
import { errorBodyFor, type ErrorBody, type ErrorCodeValue } from '@cb/shared';

/**
 * 按内部 code 回一个对外 ErrorEnvelope（HTTP 状态取分类表；traceId = req.id）。
 * overrides 可换更具体的人话 userMessage / details。
 */
export function sendError(
  req: FastifyRequest,
  reply: FastifyReply,
  code: ErrorCodeValue,
  overrides?: Partial<Pick<ErrorBody, 'userMessage' | 'details' | 'failureId'>>,
): FastifyReply {
  const { http, body } = errorBodyFor(code, req.id, overrides);
  reply.code(http).send({ error: body });
  return reply;
}

/** 认证边界使用同一个无 code 错误信封；独立函数名只用于标明调用边界。 */
export function sendAuthError(
  req: FastifyRequest,
  reply: FastifyReply,
  code: ErrorCodeValue,
  overrides?: Partial<Pick<ErrorBody, 'userMessage' | 'details' | 'failureId'>>,
): FastifyReply {
  const { http, body } = errorBodyFor(code, req.id, overrides);
  reply.code(http).send({ error: body });
  return reply;
}

/** 端点声明：方法、路径、可选请求期钩子与路由级请求体上限，以及最终 handler。 */
export interface EndpointDecl {
  method: RouteOptions['method'];
  url: string;
  onRequest?: onRequestHookHandler[];
  preHandlers?: preHandlerHookHandler[];
  bodyLimit?: number;
  handler: RouteHandlerMethod;
}

/** 把一组端点声明注册到 scoped 实例。 */
export function registerEndpoints(
  scoped: { route: (opts: RouteOptions) => void },
  endpoints: EndpointDecl[],
): void {
  for (const ep of endpoints) {
    scoped.route({
      method: ep.method,
      url: ep.url,
      ...(ep.onRequest && ep.onRequest.length > 0 ? { onRequest: ep.onRequest } : {}),
      ...(ep.preHandlers && ep.preHandlers.length > 0 ? { preHandler: ep.preHandlers } : {}),
      ...(ep.bodyLimit === undefined ? {} : { bodyLimit: ep.bodyLimit }),
      handler: ep.handler,
    });
  }
}
