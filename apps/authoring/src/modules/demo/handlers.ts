import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { ErrorCode, type Envelope } from '@cb/shared';
import { sendError } from '../../platform/http/_helpers.js';
import { asTxPool } from '../../platform/infra/db-tx.js';
import { seedComboMiniapp } from './service.js';

export interface DemoAgentSeedResult {
  taskId: string;
  capabilityId: string;
  reused: boolean;
}

export function seedComboMiniappHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const ownerUserId = req.auth?.userId;
    if (!ownerUserId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);

    let result: DemoAgentSeedResult;
    try {
      result = await seedComboMiniapp(
        asTxPool(req.server.infra.db),
        req.server.infra.objectStore,
        ownerUserId,
      );
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'seed test demo agent failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }

    const body: Envelope<DemoAgentSeedResult> = { data: result, meta: { traceId: req.id } };
    reply.code(result.reused ? 200 : 201).send(body);
    return reply;
  };
}
