import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PaymentApiErrorResponseSchema } from '@cb/payment-protocol';
import type { PaymentStore } from './payment-service.js';
import { PaymentAuthenticationError } from './payment-auth.js';
import { ChannelConflictError, channelCheckoutView } from './channel-service.js';
import { InvalidPaymentNotificationError } from './channel/index.js';
import type { PaymentChannelService } from './checkout-service.js';
import { checkoutPageHtml } from './checkout-page.js';

export interface CheckoutDependencies {
  payments: PaymentStore;
  channel: PaymentChannelService;
  authenticateUser(request: FastifyRequest): Promise<string | null>;
  testMode: boolean;
  renderQr?(value: string): Promise<string>;
}
const Params = z.object({ paymentId: z.string().uuid() }).strict();
const Create = z.object({ payType: z.enum(['wechat', 'alipay']) }).strict();
function inputFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number' &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  );
}
function fail(req: FastifyRequest, reply: FastifyReply, status: number) {
  const messages: Record<number, string> = {
    400: '请求格式不正确。',
    401: '请重新登录后查看支付。',
    403: '没有访问此支付的权限。',
    404: '未找到可访问的支付。',
    409: '本次支付已选择其他付款方式，请查询原支付。',
    503: '支付服务暂时不可用，请稍后刷新。',
  };
  return reply.code(status).send(
    PaymentApiErrorResponseSchema.parse({
      error: {
        userMessage: messages[status],
        retriable: status === 503,
        action: status === 503 ? 'retry' : 'none',
        traceId: req.id,
      },
    }),
  );
}

export function registerCheckoutRoutes(app: FastifyInstance, deps: CheckoutDependencies): void {
  app.register(async (scope) => {
    scope.addHook('onRequest', async (_req, reply) => {
      reply
        .header('cache-control', 'no-store')
        .header('referrer-policy', 'no-referrer')
        .header('x-content-type-options', 'nosniff');
    });
    scope.setErrorHandler((error, req, reply) => fail(req, reply, inputFailure(error) ? 400 : 503));
    async function user(
      req: FastifyRequest,
      reply: FastifyReply,
      page = false,
    ): Promise<string | null> {
      try {
        const id = await deps.authenticateUser(req);
        if (id && z.string().uuid().safeParse(id).success) return id;
        if (page) {
          const params = Params.parse(req.params);
          reply.redirect(
            '/authz/login?next=' + encodeURIComponent('/payments/' + params.paymentId),
            303,
          );
        } else fail(req, reply, 401);
      } catch (error) {
        fail(req, reply, error instanceof PaymentAuthenticationError ? error.status : 503);
      }
      return null;
    }
    async function payload(paymentId: string, userId: string) {
      const payment = await deps.payments.getPayment({ paymentRequestId: paymentId, userId });
      if (!payment) return null;
      const order = await deps.channel.get(paymentId, userId);
      if (!order) return { payment, checkout: null };
      const { qrContent, ...checkout } = channelCheckoutView(order);
      // Render the verified opaque QR content locally; never send it to an image service.
      const qrImage =
        payment.status === 'waiting' && qrContent
          ? await (
              deps.renderQr ??
              ((value) =>
                QRCode.toDataURL(value, { width: 280, margin: 2, errorCorrectionLevel: 'M' }))
            )(qrContent)
          : undefined;
      return { payment, checkout: { ...checkout, ...(qrImage ? { qrImage } : {}) } };
    }
    scope.get('/payments/:paymentId', async (req, reply) => {
      const params = Params.safeParse(req.params);
      if (!params.success) return fail(req, reply, 404);
      const id = await user(req, reply, true);
      if (!id) return;
      if (
        !(await deps.payments.getPayment({ userId: id, paymentRequestId: params.data.paymentId }))
      )
        return fail(req, reply, 404);
      const nonce = randomBytes(18).toString('base64');
      reply.header(
        'content-security-policy',
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
      );
      return reply
        .type('text/html; charset=utf-8')
        .send(checkoutPageHtml(params.data.paymentId, nonce, deps.testMode));
    });
    scope.get('/v1/payment-checkouts/:paymentId', async (req, reply) => {
      const params = Params.safeParse(req.params);
      if (!params.success) return fail(req, reply, 404);
      const id = await user(req, reply);
      if (!id) return;
      const data = await payload(params.data.paymentId, id);
      return data ? reply.send({ data, meta: { traceId: req.id } }) : fail(req, reply, 404);
    });
    scope.post('/v1/payment-checkouts/:paymentId', { bodyLimit: 1024 }, async (req, reply) => {
      const params = Params.safeParse(req.params);
      const body = Create.safeParse(req.body);
      if (!params.success || !body.success) return fail(req, reply, 400);
      const id = await user(req, reply);
      if (!id) return;
      try {
        const order = await deps.channel.create({
          paymentId: params.data.paymentId,
          userId: id,
          payType: body.data.payType,
        });
        if (!order) return fail(req, reply, 404);
        const data = await payload(params.data.paymentId, id);
        return data ? reply.send({ data, meta: { traceId: req.id } }) : fail(req, reply, 404);
      } catch (error) {
        return fail(req, reply, error instanceof ChannelConflictError ? 409 : 503);
      }
    });
  });
  app.register(async (scope) => {
    const counts = new Map<string, number>();
    let windowEnd = Date.now() + 60000;
    const acknowledgement = (reply: FastifyReply, status: number) =>
      reply
        .code(status)
        .header('cache-control', 'no-store')
        .send({
          return_code: status === 200 ? 'SUCCESS' : 'FAIL',
          return_msg: status === 200 ? '成功' : '处理失败',
        });
    scope.setErrorHandler((error, _req, reply) =>
      acknowledgement(reply, inputFailure(error) ? 400 : 503),
    );
    scope.post(
      '/billing/leshouying/payment-notify',
      {
        bodyLimit: 64 * 1024,
        onRequest: async (req, reply) => {
          if (Date.now() >= windowEnd) {
            counts.clear();
            windowEnd = Date.now() + 60000;
          }
          const peer = req.raw.socket.remoteAddress ?? 'unknown';
          const count = counts.get(peer) ?? 0;
          if (count >= 120 || (!counts.has(peer) && counts.size >= 512)) {
            reply.header('retry-after', '60');
            return acknowledgement(reply, 429);
          }
          counts.set(peer, count + 1);
        },
      },
      async (req, reply) => {
        try {
          await deps.channel.notify(req.body);
          return acknowledgement(reply, 200);
        } catch (error) {
          return acknowledgement(
            reply,
            error instanceof InvalidPaymentNotificationError ||
              error instanceof ChannelConflictError
              ? 400
              : 503,
          );
        }
      },
    );
  });
}
