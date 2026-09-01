import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  AbandonPendingUsageRecoveryResultSchema,
  ErrorCode,
  PendingUsageRecoveryListQuerySchema,
  PendingUsageRecoveryUsageParamsSchema,
  type Envelope,
  type PendingUsageRecoveryView,
} from '@cb/shared';

import { sendError } from '../../platform/http/_helpers.js';
import {
  PendingUsageRecoveryBusyError,
  abandonOwnedUnadmittedPendingUsageRecovery,
  findPendingUsageRecovery,
  listActivePendingUsageRecoveries,
  toPendingUsageRecoveryView,
} from './pending-recovery.js';

export function listPendingUsageRecoveriesHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const ownerUserId = req.auth?.userId;
    if (!ownerUserId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const parsed = PendingUsageRecoveryListQuerySchema.safeParse(req.query);
    if (!parsed.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    try {
      const rows = await listActivePendingUsageRecoveries(
        req.server.infra.db,
        ownerUserId,
        parsed.data.sessionId,
      );
      const body: Envelope<{ recoveries: PendingUsageRecoveryView[] }> = {
        data: { recoveries: rows.map(toPendingUsageRecoveryView) },
        meta: { traceId: req.id },
      };
      reply.header('cache-control', 'private, no-store').code(200).send(body);
      return reply;
    } catch {
      req.log.error({ code: ErrorCode.INTERNAL, traceId: req.id }, 'list recovery failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
  };
}

export function getPendingUsageRecoveryHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const ownerUserId = req.auth?.userId;
    if (!ownerUserId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const parsed = PendingUsageRecoveryUsageParamsSchema.safeParse(req.params);
    if (!parsed.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    try {
      const recovery = await findPendingUsageRecovery(
        req.server.infra.db,
        ownerUserId,
        parsed.data.usageId,
      );
      if (
        !recovery ||
        recovery.recoveryStatus !== 'active' ||
        recovery.requestText === null ||
        !recovery.isUnexpired
      ) {
        return sendError(req, reply, ErrorCode.NOT_FOUND);
      }
      const body: Envelope<{ recovery: PendingUsageRecoveryView }> = {
        data: { recovery: toPendingUsageRecoveryView(recovery) },
        meta: { traceId: req.id },
      };
      reply.header('cache-control', 'private, no-store').code(200).send(body);
      return reply;
    } catch {
      req.log.error({ code: ErrorCode.INTERNAL, traceId: req.id }, 'read recovery failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
  };
}

export function abandonPendingUsageRecoveryHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const ownerUserId = req.auth?.userId;
    if (!ownerUserId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const parsed = PendingUsageRecoveryUsageParamsSchema.safeParse(req.params);
    if (!parsed.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    try {
      const outcome = await abandonOwnedUnadmittedPendingUsageRecovery(
        req.server.infra.db,
        ownerUserId,
        parsed.data.usageId,
      );
      if (outcome === 'not_found') return sendError(req, reply, ErrorCode.NOT_FOUND);
      if (outcome === 'terminal') return sendError(req, reply, ErrorCode.STATE_CONFLICT);
      const body: Envelope<{ abandoned: true }> = {
        data: AbandonPendingUsageRecoveryResultSchema.parse({ abandoned: true }),
        meta: { traceId: req.id },
      };
      reply.header('cache-control', 'private, no-store').code(200).send(body);
      return reply;
    } catch (err) {
      if (err instanceof PendingUsageRecoveryBusyError) {
        return sendError(req, reply, ErrorCode.STATE_CONFLICT);
      }
      req.log.error({ code: ErrorCode.INTERNAL, traceId: req.id }, 'abandon recovery failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
  };
}
