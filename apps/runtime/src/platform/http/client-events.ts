// 浏览器侧错误事件上报。日志只保留事件类型、traceId 与固定路由桶，永远返回 204。
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizeTraceId } from '@cb/shared';
import { currentTraceLogFields } from '../observability/node.js';

const ClientEventSchema = z.object({
  kind: z.enum(['api_error', 'sse_error', 'window_error', 'unhandled_rejection']),
  traceId: z.string().optional(),
  message: z.string().max(1000).optional(),
  stack: z.string().max(4000).optional(),
  url: z.string().max(1000).optional(),
  route: z.string().max(300).optional(),
  source: z.string().max(80).optional(),
});

export type ClientRouteBucket =
  | 'auth'
  | 'tasks'
  | 'capabilities'
  | 'runtime'
  | 'login'
  | 'public'
  | 'unknown';

function isPathWithin(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** 客户端路径只参与固定低基数分类，任何原始 pathname 与动态段都不会进入日志。 */
export function clientRouteBucket(raw: string | undefined): ClientRouteBucket {
  if (!raw) return 'unknown';
  try {
    const pathname = new URL(raw, 'https://client-event.invalid').pathname;
    if (isPathWithin(pathname, '/api/v1/auth') || pathname === '/api/v1/me') return 'auth';
    if (isPathWithin(pathname, '/api/v1/tasks') || isPathWithin(pathname, '/tasks')) return 'tasks';
    if (
      isPathWithin(pathname, '/api/v1/capabilities') ||
      isPathWithin(pathname, '/capabilities') ||
      isPathWithin(pathname, '/a')
    ) {
      return 'capabilities';
    }
    if (isPathWithin(pathname, '/api/v1/runtime') || isPathWithin(pathname, '/try')) {
      return 'runtime';
    }
    if (pathname === '/login') return 'login';
    if (pathname === '/' || isPathWithin(pathname, '/c')) return 'public';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function registerClientEventRoutes(app: FastifyInstance): Promise<void> {
  app.post('/client-events', async (req, reply) => {
    const parsed = ClientEventSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      req.log.warn(
        { ...currentTraceLogFields(req.id), reason: 'invalid_client_event' },
        'client observability event rejected',
      );
      return reply.code(204).send();
    }

    const eventTraceId = normalizeTraceId(parsed.data.traceId) ?? req.id;
    req.log.warn(
      {
        ...currentTraceLogFields(eventTraceId),
        clientEvent: {
          kind: parsed.data.kind,
          routeBucket: clientRouteBucket(parsed.data.url ?? parsed.data.route),
        },
      },
      'client observability event',
    );
    return reply.code(204).send();
  });
}
