import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  CreateCodexAgentShareBodySchema,
  ErrorCode,
  type CodexAgentShareResult,
  type Envelope,
} from '@cb/shared';
import { externalMcpPublicOrigin } from '../../platform/config/env.js';
import { sendError } from '../../platform/http/_helpers.js';
import { createCodexAgentShare, readCodexAgentShareWithToken } from './service.js';

function publicOrigin(req: FastifyRequest): string {
  return externalMcpPublicOrigin(req.server.infra.env);
}

function publicReadHeaders(reply: FastifyReply): void {
  reply.header('cache-control', 'private, no-store');
  reply.header('pragma', 'no-cache');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('x-robots-tag', 'noindex, nofollow');
  reply.header('x-content-type-options', 'nosniff');
}

export function createCodexAgentShareHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const parsed = CreateCodexAgentShareBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return sendError(req, reply, ErrorCode.VALIDATION_FAILED, {
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
        },
      });
    }
    try {
      const outcome = await createCodexAgentShare(req.server.infra.db, {
        ownerUserId: userId,
        body: parsed.data,
        publicOrigin: publicOrigin(req),
        comboEnvironment: req.server.infra.env.COMBO_ENVIRONMENT,
      });
      if (outcome.kind === 'environment_conflict') {
        return sendError(req, reply, ErrorCode.STATE_CONFLICT, {
          userMessage:
            'Codex Agent Share V1 的接收文案固定连接 Combo Test，当前环境只允许读取，不能创建新分享。',
        });
      }
      if (outcome.kind === 'idempotency_conflict') {
        return sendError(req, reply, ErrorCode.IDEMPOTENCY_CONFLICT);
      }
      const body: Envelope<CodexAgentShareResult> = {
        data: outcome.result,
        meta: { traceId: req.id },
      };
      reply.header('cache-control', 'private, no-store');
      reply.code(outcome.kind === 'created' ? 201 : 200).send(body);
      return reply;
    } catch {
      req.log.error({ traceId: req.id }, 'create codex agent share failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
  };
}

export function getCodexAgentShareHandler(): RouteHandlerMethod {
  return async function (req, reply) {
    publicReadHeaders(reply);
    const shareToken = (req.params as { shareToken?: string }).shareToken ?? '';
    try {
      const outcome = await readCodexAgentShareWithToken(req.server.infra.db, {
        publicOrigin: publicOrigin(req),
        shareToken,
      });
      if (outcome.kind === 'invalid_url') {
        return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
      }
      if (outcome.kind === 'not_found') return sendError(req, reply, ErrorCode.NOT_FOUND);
      const body: Envelope<CodexAgentShareResult> = {
        data: outcome.result,
        meta: { traceId: req.id },
      };
      reply.code(200).send(body);
      return reply;
    } catch {
      req.log.error({ traceId: req.id }, 'read codex agent share failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
  };
}
