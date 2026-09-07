import { createHmac } from 'node:crypto';
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ErrorEnvelopeSchema } from '@cb/shared';
import { z } from 'zod';
import type { AgentAccessIssuer } from './agent-access.js';

export interface AgentAccessRoutes {
  issuer: AgentAccessIssuer;
  allowRequest(clientAddress: string): Promise<boolean>;
}
const EmptyBody = z.object({}).strict();
const LIMIT_SCRIPT = `local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], 60) end
return count <= 60 and 1 or 0`;

export function createAgentAccessRateLimiter(
  redis: { eval(script: string, keys: number, ...args: string[]): Promise<unknown> },
  hmacSecret: string,
) {
  return async (clientAddress: string): Promise<boolean> => {
    const key =
      'authz:v2:agent-access:' +
      createHmac('sha256', hmacSecret).update(clientAddress).digest('hex');
    return (await redis.eval(LIMIT_SCRIPT, 1, key)) === 1;
  };
}

function fail(req: FastifyRequest, reply: FastifyReply, status: number) {
  const message =
    status === 401
      ? 'Agent 身份验证失败。'
      : status === 400
        ? '请求格式不正确。'
        : status === 429
          ? '请求过于频繁，请稍后重试。'
          : '身份服务暂时不可用，请稍后重试。';
  reply.header('cache-control', 'no-store');
  if (status === 429) reply.header('retry-after', '60');
  return reply.code(status).send(
    ErrorEnvelopeSchema.parse({
      error: {
        userMessage: message,
        retriable: status >= 500 || status === 429,
        action: status === 400 ? 'change_input' : status === 401 ? 'none' : 'retry',
        traceId: req.id,
      },
    }),
  );
}

export function registerAgentAccessRoutes(app: FastifyInstance, deps: AgentAccessRoutes) {
  app.register(async (scope) => {
    scope.setErrorHandler((error, req, reply) => {
      const status =
        typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        typeof error.statusCode === 'number'
          ? error.statusCode
          : 500;
      return fail(req, reply, status >= 400 && status < 500 ? 400 : 503);
    });
    scope.post(
      '/authz/agent-tokens',
      {
        bodyLimit: 1024,
        onRequest: async (req, reply) => {
          reply.header('cache-control', 'no-store');
          try {
            if (!(await deps.allowRequest(req.raw.socket.remoteAddress ?? req.ip)))
              return fail(req, reply, 429);
          } catch {
            return fail(req, reply, 503);
          }
        },
      },
      async (req, reply) => {
        if (!EmptyBody.safeParse(req.body).success || !EmptyBody.safeParse(req.query).success)
          return fail(req, reply, 400);
        try {
          const result = await deps.issuer.issue(req.headers.authorization);
          if (!result) return fail(req, reply, 401);
          return reply.send({ data: result, meta: { traceId: req.id } });
        } catch {
          req.log.warn({ traceId: req.id }, 'agent token issuance failed');
          return fail(req, reply, 503);
        }
      },
    );
  });
}
