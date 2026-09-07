import {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type preHandlerHookHandler,
} from 'fastify';
import {
  CreatePaymentBodySchema,
  PaymentApiErrorResponseSchema,
  PaymentIdParamsSchema,
  PaymentRequestKeyParamsSchema,
  PaymentRequiredResponseSchema,
  PaymentSuccessResponseSchema,
} from '@cb/payment-protocol';
import { CallAdmissionInputSchema, type PaymentStore } from './payment-service.js';
import { PaymentAuthenticationError } from './payment-auth.js';

export interface PaymentRouteDependencies {
  trustedOrigins?: readonly string[];
  store: PaymentStore;
  /** Must verify the current request's platform session/scoped credential. No body identity. */
  authenticateUser(request: FastifyRequest): Promise<string | null>;
  /** Dedicated service identity gate, not an end-user/Agent token. */
  authenticateGateway(request: FastifyRequest): Promise<boolean>;
}

function fail(req: FastifyRequest, reply: FastifyReply, status: number) {
  reply.header('cache-control', 'no-store');
  const messages: Record<number, string> = {
    400: '请求格式不正确，请检查后重试。',
    401: '请先登录后再继续。',
    403: '没有访问此支付接口的权限。',
    404: '未找到可访问的支付记录。',
    409: '请求与已有记录冲突，请查询原记录。',
    503: '支付服务暂时不可用，请稍后重试。',
  };
  return reply.code(status).send(
    PaymentApiErrorResponseSchema.parse({
      error: {
        userMessage: messages[status],
        retriable: status === 503,
        action: status === 503 ? 'retry' : status === 400 ? 'change_input' : 'none',
        traceId: req.id,
      },
    }),
  );
}

/** Registered only when trusted user and Gateway authentication adapters have been supplied. */
export function registerPaymentRoutes(app: FastifyInstance, deps: PaymentRouteDependencies): void {
  app.register(async (app) => {
    app.addHook('onRequest', async (req, reply) => {
      const origin = req.headers.origin;
      if (origin && deps.trustedOrigins?.includes(origin))
        reply
          .header('access-control-allow-origin', origin)
          .header('access-control-allow-credentials', 'true')
          .header('vary', 'Origin');
    });
    const preflight = async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.headers.origin || !deps.trustedOrigins?.includes(req.headers.origin))
        return fail(req, reply, 403);
      return reply
        .header('access-control-allow-methods', 'GET, POST, OPTIONS')
        .header('access-control-allow-headers', 'content-type, cache-control')
        .code(204)
        .send();
    };
    app.options('/v1/payments', preflight);
    app.options('/v1/payments/*', preflight);
    app.setErrorHandler((error, req, reply) => {
      const status =
        typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        typeof error.statusCode === 'number'
          ? error.statusCode
          : 500;
      return fail(req, reply, status >= 400 && status < 500 ? 400 : 503);
    });
    const users = new WeakMap<FastifyRequest, string>();
    const userGate: preHandlerHookHandler = async (req, reply) => {
      reply.header('cache-control', 'no-store');
      try {
        const userId = await deps.authenticateUser(req);
        if (
          !userId ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)
        )
          return fail(req, reply, 401);
        users.set(req, userId);
      } catch (error) {
        return fail(req, reply, error instanceof PaymentAuthenticationError ? error.status : 503);
      }
    };
    const success = (reply: FastifyReply, req: FastifyRequest, data: unknown, status = 200) =>
      reply
        .code(status)
        .send(PaymentSuccessResponseSchema.parse({ data, meta: { traceId: req.id } }));

    app.post('/v1/payments', { preHandler: userGate }, async (req, reply) => {
      const parsed = CreatePaymentBodySchema.safeParse(req.body);
      if (!parsed.success) return fail(req, reply, 400);
      try {
        const result = await deps.store.createPayment({ userId: users.get(req)!, ...parsed.data });
        if (result.kind === 'not_found') return fail(req, reply, 404);
        if (result.kind === 'conflict') return fail(req, reply, 409);
        return success(reply, req, result.payment, result.replayed ? 200 : 201);
      } catch {
        req.log.warn({ traceId: req.id }, 'payment creation failed');
        return fail(req, reply, 503);
      }
    });
    app.get(
      '/v1/payments/by-request-key/:requestKey',
      { preHandler: userGate },
      async (req, reply) => {
        const parsed = PaymentRequestKeyParamsSchema.safeParse(req.params);
        if (!parsed.success) return fail(req, reply, 400);
        try {
          const result = await deps.store.findPayment({ userId: users.get(req)!, ...parsed.data });
          return result ? success(reply, req, result) : fail(req, reply, 404);
        } catch {
          return fail(req, reply, 503);
        }
      },
    );
    app.get('/v1/payments/:paymentRequestId', { preHandler: userGate }, async (req, reply) => {
      const parsed = PaymentIdParamsSchema.safeParse(req.params);
      if (!parsed.success) return fail(req, reply, 400);
      try {
        const result = await deps.store.getPayment({ userId: users.get(req)!, ...parsed.data });
        return result ? success(reply, req, result) : fail(req, reply, 404);
      } catch {
        return fail(req, reply, 503);
      }
    });
    app.post(
      '/billing/call-admissions',
      {
        preHandler: async (req, reply) => {
          try {
            if (!(await deps.authenticateGateway(req))) return fail(req, reply, 401);
          } catch {
            return fail(req, reply, 503);
          }
        },
      },
      async (req, reply) => {
        reply.header('cache-control', 'no-store');
        const parsed = CallAdmissionInputSchema.safeParse(req.body);
        if (!parsed.success) return fail(req, reply, 400);
        try {
          const result = await deps.store.admitCall(parsed.data);
          if (result.kind === 'not_found') return fail(req, reply, 404);
          if (result.kind === 'conflict') return fail(req, reply, 409);
          if (result.kind === 'payment_required')
            return reply.code(402).send(
              PaymentRequiredResponseSchema.parse({
                error: {
                  userMessage: '余额不足，请完成支付后继续。',
                  retriable: false,
                  action: 'wait',
                  traceId: req.id,
                  payment: result.requirement,
                },
              }),
            );
          return reply.code(result.replayed ? 200 : 201).send({
            data: { holdId: result.holdId, replayed: result.replayed },
            meta: { traceId: req.id },
          });
        } catch {
          req.log.warn({ traceId: req.id }, 'call admission failed');
          return fail(req, reply, 503);
        }
      },
    );
  });
}
