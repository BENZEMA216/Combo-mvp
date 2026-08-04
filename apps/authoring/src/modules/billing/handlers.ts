import type {
  FastifyReply,
  FastifyRequest,
  RouteHandlerMethod,
  preHandlerHookHandler,
} from 'fastify';
import { ErrorCode, errorBodyFor, type Envelope } from '@cb/shared';
import { z } from 'zod';
import { asTxPool } from '../../platform/infra/db-tx.js';
import { sendError } from '../../platform/http/_helpers.js';
import { PgBillingRepository } from './repo.js';
import {
  createRechargeOrder,
  getRechargeOrderByIntentWithReconciliation,
  getRechargeOrderWithReconciliation,
  getWallet,
  handlePaymentNotification,
} from './service.js';
import {
  BillingIdempotencyConflictError,
  BillingNotFoundError,
  BillingRateLimitedError,
  BillingUnavailableError,
  BillingValidationError,
  type RechargeOrder,
} from './types.js';

export const CreateRechargeOrderSchema = z
  .object({
    rechargeIntentId: z.string().uuid(),
    packageId: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u),
    channel: z.enum(['h5', 'qr']),
    payType: z.enum(['wechat', 'alipay']),
  })
  .strict();

const RechargeOrderParamsSchema = z.object({ orderId: z.string().uuid() }).strict();
const RechargeIntentParamsSchema = z.object({ rechargeIntentId: z.string().uuid() }).strict();

interface RechargeOrderView {
  id: string;
  rechargeIntentId: string;
  packageId: string;
  amountCents: string;
  channel: RechargeOrder['paymentMethod'];
  payType?: RechargeOrder['payType'];
  status: RechargeOrder['paymentStatus'] | 'credited';
  reconciliationActive: boolean;
  paymentAction?: {
    kind: 'redirect' | 'qr_code';
    url: string;
  };
  createdAt: string;
  updatedAt: string;
}

function toRechargeOrderView(order: RechargeOrder): RechargeOrderView {
  const status = order.creditStatus === 'credited' ? 'credited' : order.paymentStatus;
  const mayUseAction = status === 'created' || status === 'pending' || status === 'unknown';
  return {
    id: order.id,
    rechargeIntentId: order.clientIdempotencyKey,
    packageId: order.packageId,
    amountCents: order.amountCents.toString(),
    channel: order.paymentMethod,
    ...(order.payType ? { payType: order.payType } : {}),
    status,
    reconciliationActive: order.reconciliationActive,
    ...(mayUseAction && order.action
      ? {
          paymentAction: {
            kind: order.action.kind === 'redirect_url' ? 'redirect' : 'qr_code',
            url: order.action.value,
          },
        }
      : {}),
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

function billingRepository(req: FastifyRequest): PgBillingRepository {
  return new PgBillingRepository(asTxPool(req.server.infra.db), req.server.infra.db);
}

function sendBillingFailure(
  req: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof BillingValidationError) {
    return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
  }
  if (error instanceof BillingIdempotencyConflictError) {
    return sendError(req, reply, ErrorCode.IDEMPOTENCY_CONFLICT);
  }
  if (error instanceof BillingNotFoundError) {
    return sendError(req, reply, ErrorCode.NOT_FOUND);
  }
  if (error instanceof BillingUnavailableError) {
    return sendError(req, reply, ErrorCode.DEPENDENCY_UNAVAILABLE);
  }
  if (error instanceof BillingRateLimitedError) {
    reply.header('retry-after', error.retryAfterSeconds.toString());
    return sendError(req, reply, ErrorCode.RATE_LIMITED);
  }
  req.log.error({ code: ErrorCode.INTERNAL, traceId: req.id }, 'billing request failed');
  return sendError(req, reply, ErrorCode.INTERNAL);
}

export function billingNoStore(): preHandlerHookHandler {
  return async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  };
}

export function requireBillingJson(): preHandlerHookHandler {
  return async (req, reply) => {
    const contentType = req.headers['content-type'];
    const mediaType =
      typeof contentType === 'string' ? contentType.split(';', 1)[0]?.trim().toLowerCase() : '';
    if (mediaType === 'application/json') return;
    const { body } = errorBodyFor(ErrorCode.VALIDATION_FAILED, req.id, {
      userMessage: '请求必须使用 JSON 格式。',
    });
    reply.code(415).send({ error: body });
  };
}

export function requirePaymentCallbackJson(): preHandlerHookHandler {
  return async (req, reply) => {
    const contentType = req.headers['content-type'];
    const mediaType =
      typeof contentType === 'string' ? contentType.split(';', 1)[0]?.trim().toLowerCase() : '';
    if (mediaType === 'application/json') return;
    reply.code(415).send({ return_code: 'FAIL', return_msg: '处理失败' });
  };
}

export function walletHandler(): RouteHandlerMethod {
  return async (req, reply) => {
    const ownerUserId = req.auth?.userId;
    if (!ownerUserId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    try {
      const wallet = await getWallet(billingRepository(req), ownerUserId);
      const body: Envelope<{
        availableCents: string;
        reservedCents: string;
        currency: 'CNY';
      }> = {
        data: {
          availableCents: wallet.availableCents.toString(),
          reservedCents: wallet.reservedCents.toString(),
          currency: 'CNY',
        },
        meta: { traceId: req.id },
      };
      return reply.code(200).send(body);
    } catch (error) {
      return sendBillingFailure(req, reply, error);
    }
  };
}

export function rechargePackagesHandler(): RouteHandlerMethod {
  return async (req, reply) => {
    if (!req.auth?.userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const body: Envelope<
      Array<{ id: string; amountCents: string; label: string; currency: 'CNY' }>
    > = {
      data: req.server.infra.billing.packages.map((item) => ({
        id: item.id,
        amountCents: item.amountCents.toString(),
        label: item.label,
        currency: 'CNY',
      })),
      meta: { traceId: req.id },
    };
    return reply.code(200).send(body);
  };
}

export function createRechargeOrderHandler(): RouteHandlerMethod {
  return async (req, reply) => {
    const ownerUserId = req.auth?.userId;
    if (!ownerUserId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const parsed = CreateRechargeOrderSchema.safeParse(req.body);
    if (!parsed.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    try {
      const result = await createRechargeOrder(
        billingRepository(req),
        req.server.infra.paymentGateway,
        req.server.infra.billing,
        { ownerUserId, ...parsed.data },
      );
      const body: Envelope<RechargeOrderView> = {
        data: toRechargeOrderView(result.order),
        meta: { traceId: req.id },
      };
      const status =
        result.order.paymentStatus === 'unknown'
          ? 202
          : result.created || result.submitted
            ? 201
            : 200;
      return reply.code(status).send(body);
    } catch (error) {
      return sendBillingFailure(req, reply, error);
    }
  };
}

export function getRechargeOrderHandler(): RouteHandlerMethod {
  return async (req, reply) => {
    const ownerUserId = req.auth?.userId;
    if (!ownerUserId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const parsed = RechargeOrderParamsSchema.safeParse(req.params);
    if (!parsed.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    try {
      const order = await getRechargeOrderWithReconciliation(
        billingRepository(req),
        req.server.infra.paymentGateway,
        {
          ownerUserId,
          orderId: parsed.data.orderId,
          leaseOwner: `http:${req.id}`,
        },
      );
      const body: Envelope<RechargeOrderView> = {
        data: toRechargeOrderView(order),
        meta: { traceId: req.id },
      };
      return reply.code(200).send(body);
    } catch (error) {
      return sendBillingFailure(req, reply, error);
    }
  };
}

export function getRechargeOrderByIntentHandler(): RouteHandlerMethod {
  return async (req, reply) => {
    const ownerUserId = req.auth?.userId;
    if (!ownerUserId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const parsed = RechargeIntentParamsSchema.safeParse(req.params);
    if (!parsed.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    try {
      const order = await getRechargeOrderByIntentWithReconciliation(
        billingRepository(req),
        req.server.infra.paymentGateway,
        {
          ownerUserId,
          rechargeIntentId: parsed.data.rechargeIntentId,
          leaseOwner: `http:${req.id}`,
        },
      );
      const body: Envelope<RechargeOrderView | null> = {
        data: order ? toRechargeOrderView(order) : null,
        meta: { traceId: req.id },
      };
      return reply.code(200).send(body);
    } catch (error) {
      return sendBillingFailure(req, reply, error);
    }
  };
}

function callbackReply(reply: FastifyReply, accepted: boolean): FastifyReply {
  return reply.code(accepted ? 200 : 400).send({
    return_code: accepted ? 'SUCCESS' : 'FAIL',
    return_msg: accepted ? '成功' : '处理失败',
  });
}

export function paymentNotificationHandler(): RouteHandlerMethod {
  return async (req, reply) => {
    try {
      const result = await handlePaymentNotification(
        billingRepository(req),
        req.server.infra.paymentGateway,
        req.body,
      );
      return callbackReply(reply, result === 'processed' || result === 'duplicate');
    } catch (error) {
      if (error instanceof BillingUnavailableError) {
        req.log.warn(
          { code: ErrorCode.DEPENDENCY_UNAVAILABLE, traceId: req.id },
          'payment notification unavailable',
        );
        return reply.code(503).send({ return_code: 'FAIL', return_msg: '处理失败' });
      }
      req.log.error(
        { code: ErrorCode.INTERNAL, traceId: req.id },
        'payment notification processing failed',
      );
      return reply.code(500).send({ return_code: 'FAIL', return_msg: '处理失败' });
    }
  };
}
