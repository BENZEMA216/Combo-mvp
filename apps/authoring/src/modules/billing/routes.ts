import type { FastifyInstance } from 'fastify';
import { requireTrustedMutationOrigin } from '../../platform/http/browser-origin.js';
import { registerEndpoints, type EndpointDecl } from '../../platform/http/_helpers.js';
import { requireAuth } from '../../platform/middleware/auth.js';
import {
  billingNoStore,
  createRechargeOrderHandler,
  getRechargeOrderByIntentHandler,
  getRechargeOrderHandler,
  paymentNotificationHandler,
  rechargePackagesHandler,
  requireBillingJson,
  requirePaymentCallbackJson,
  walletHandler,
} from './handlers.js';

export const BILLING_NOTIFICATION_PATH = '/billing/leshouying/payment-notify';
export const BILLING_JSON_BODY_LIMIT = 4_096;
export const BILLING_CALLBACK_BODY_LIMIT = 16 * 1_024;

const browserMutationGuards = [
  billingNoStore(),
  requireTrustedMutationOrigin(),
  requireAuth(),
  requireBillingJson(),
];

export const BILLING_ENDPOINTS: EndpointDecl[] = [
  {
    method: 'GET',
    url: '/billing/wallet',
    preHandlers: [billingNoStore(), requireAuth()],
    handler: walletHandler(),
  },
  {
    method: 'GET',
    url: '/billing/recharge-packages',
    preHandlers: [billingNoStore(), requireAuth()],
    handler: rechargePackagesHandler(),
  },
  {
    method: 'POST',
    url: '/billing/recharge-orders',
    preHandlers: browserMutationGuards,
    bodyLimit: BILLING_JSON_BODY_LIMIT,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: createRechargeOrderHandler(),
  },
  {
    method: 'GET',
    url: '/billing/recharge-orders/by-intent/:rechargeIntentId',
    preHandlers: [billingNoStore(), requireAuth()],
    handler: getRechargeOrderByIntentHandler(),
  },
  {
    method: 'GET',
    url: '/billing/recharge-orders/:orderId',
    preHandlers: [billingNoStore(), requireAuth()],
    handler: getRechargeOrderHandler(),
  },
  {
    method: 'POST',
    url: BILLING_NOTIFICATION_PATH,
    preHandlers: [requirePaymentCallbackJson()],
    bodyLimit: BILLING_CALLBACK_BODY_LIMIT,
    // Provider callbacks can legitimately share a small egress-IP pool. Keep a
    // bounded abuse guard without imposing a one-request-per-second production
    // ceiling on an entire provider address.
    config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
    handler: paymentNotificationHandler(),
  },
];

export async function registerBillingRoutes(scoped: FastifyInstance): Promise<void> {
  const browserEndpoints = BILLING_ENDPOINTS.filter(
    (endpoint) => endpoint.url !== BILLING_NOTIFICATION_PATH,
  );
  registerEndpoints(scoped, browserEndpoints);
  await scoped.register(async (callbackScope) => {
    // Parser、限流等在 handler 之前失败时仍返回网关能识别的固定 ACK 形状。
    callbackScope.setErrorHandler((error, req, reply) => {
      req.log.warn({ traceId: req.id }, 'payment notification rejected at HTTP boundary');
      const statusCode = (error as { statusCode?: number }).statusCode;
      const preserved = statusCode === 413 || statusCode === 429 ? statusCode : 400;
      reply.code(preserved).send({ return_code: 'FAIL', return_msg: '处理失败' });
    });
    registerEndpoints(
      callbackScope,
      BILLING_ENDPOINTS.filter((endpoint) => endpoint.url === BILLING_NOTIFICATION_PATH),
    );
  });
}
