// Test 演示 HTTP handler：只接收 Capability id，身份、fixture 与环境都失败关闭。
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { CreateStudioSessionBodySchema, ErrorCode, type Envelope } from '@cb/shared';
import { sendError } from '../../platform/http/_helpers.js';
import { ownsComboMiniappDemoCapability } from './repo.js';
import { getOrCreateComboMiniappDemoStudio, type ComboMiniappDemoStudioResult } from './service.js';

export function createComboMiniappDemoStudioHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    // 路由注册已做环境门禁；handler 再守一次，避免未来被其他路由误挂到非 Test 环境。
    if (req.server.infra.env.COMBO_ENVIRONMENT !== 'test') {
      return sendError(req, reply, ErrorCode.NOT_FOUND);
    }
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const parsed = CreateStudioSessionBodySchema.safeParse(req.body);
    if (!parsed.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);

    const { db, objectStore } = req.server.infra;
    try {
      const ownedDemo = await ownsComboMiniappDemoCapability(db, parsed.data.capabilityId, userId);
      if (!ownedDemo) return sendError(req, reply, ErrorCode.NOT_FOUND);

      const data = await getOrCreateComboMiniappDemoStudio(db, objectStore, {
        capabilityId: parsed.data.capabilityId,
        ownerUserId: userId,
      });
      const body: Envelope<ComboMiniappDemoStudioResult> = {
        data,
        meta: { traceId: req.id },
      };
      reply.code(200).send(body);
      return reply;
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'create Combo Miniapp demo studio failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
  };
}
