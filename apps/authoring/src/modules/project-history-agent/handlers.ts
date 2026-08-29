import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { ErrorCode, type Envelope } from '@cb/shared';
import { ZodError } from 'zod';

import { asTxPool } from '../../platform/infra/db-tx.js';
import { externalMcpPublicOrigin } from '../../platform/config/env.js';
import { sendError } from '../../platform/http/_helpers.js';
import { PgProjectHistoryAgentRepository } from './repo.js';
import { RenderAgentPackageDraftBodySchema } from './contracts.js';
import {
  ProjectHistoryAgentCandidateValidationError,
  ProjectHistoryAgentServiceError,
  createProjectHistoryAgentService,
} from './service.js';

function serviceFor(req: FastifyRequest) {
  const publicOrigin = externalMcpPublicOrigin(req.server.infra.env);
  return createProjectHistoryAgentService({
    repository: new PgProjectHistoryAgentRepository(
      asTxPool(req.server.infra.db),
      req.server.infra.db,
    ),
    publicOrigin,
  });
}

function owner(req: FastifyRequest): string | null {
  return req.auth?.userId ?? null;
}

const SAFE_DATABASE_CONSTRAINTS = new Set([
  'project_history_agent_drafts_owner_idempotency_key_key',
  'project_history_agent_shares_owner_idempotency_key_key',
  'project_history_agent_confirmations_token_digest_key',
]);

export function projectHistoryErrorLogFields(traceId: string, error: unknown) {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const sqlState =
    typeof record.code === 'string' && /^[0-9A-Z]{5}$/u.test(record.code) ? record.code : undefined;
  const constraint =
    typeof record.constraint === 'string' && SAFE_DATABASE_CONSTRAINTS.has(record.constraint)
      ? record.constraint
      : undefined;
  return {
    category: 'project_history_agent_request_failed',
    traceId,
    ...(sqlState ? { sqlState } : {}),
    ...(constraint ? { constraint } : {}),
  } as const;
}

function sendServiceError(req: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ZodError || error instanceof ProjectHistoryAgentCandidateValidationError) {
    return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
  }
  if (error instanceof ProjectHistoryAgentServiceError) {
    if (error.code === 'draft_not_found' || error.code === 'share_not_found') {
      return sendError(req, reply, ErrorCode.NOT_FOUND);
    }
    if (error.code === 'idempotency_conflict') {
      return sendError(req, reply, ErrorCode.IDEMPOTENCY_CONFLICT);
    }
    return sendError(req, reply, ErrorCode.STATE_CONFLICT);
  }
  req.log.error(
    projectHistoryErrorLogFields(req.id, error),
    'project-history Agent request failed',
  );
  return sendError(req, reply, ErrorCode.INTERNAL);
}

function success(reply: FastifyReply, traceId: string, data: unknown, status = 200): FastifyReply {
  const body: Envelope<unknown> = { data, meta: { traceId } };
  reply.code(status).send(body);
  return reply;
}

export function createAgentPackageDraftHandler(): RouteHandlerMethod {
  return async (req, reply) => {
    const ownerUserId = owner(req);
    if (!ownerUserId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    try {
      const result = await serviceFor(req).createDraft(ownerUserId, req.body as never);
      return success(reply, req.id, result, result.created ? 201 : 200);
    } catch (error) {
      return sendServiceError(req, reply, error);
    }
  };
}

export function renderAgentPackageDraftHandler(): RouteHandlerMethod {
  return async (req, reply) => {
    const ownerUserId = owner(req);
    if (!ownerUserId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const { draftId } = req.params as { draftId: string };
    try {
      const body = RenderAgentPackageDraftBodySchema.parse(req.body ?? {});
      return success(
        reply,
        req.id,
        await serviceFor(req).renderDraft(ownerUserId, {
          draftId,
          draftFingerprint: body.draftFingerprint,
        }),
      );
    } catch (error) {
      return sendServiceError(req, reply, error);
    }
  };
}

export function createAgentPackageShareHandler(): RouteHandlerMethod {
  return async (req, reply) => {
    const ownerUserId = owner(req);
    if (!ownerUserId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    try {
      const result = await serviceFor(req).createShare(ownerUserId, req.body as never);
      return success(reply, req.id, result, result.created ? 201 : 200);
    } catch (error) {
      return sendServiceError(req, reply, error);
    }
  };
}

export function readAgentPackageShareHandler(): RouteHandlerMethod {
  return async (req, reply) => {
    const { shareToken } = req.params as { shareToken: string };
    const publicOrigin = externalMcpPublicOrigin(req.server.infra.env);
    try {
      const canonicalPath = `/api/v1/agent-package-shares/${shareToken}`;
      if (req.raw.url !== canonicalPath) {
        throw new ProjectHistoryAgentServiceError('share_not_found');
      }
      return success(
        reply,
        req.id,
        await serviceFor(req).readShare({
          shareUrl: new URL(canonicalPath, publicOrigin).toString(),
        }),
      );
    } catch (error) {
      return sendServiceError(req, reply, error);
    }
  };
}

export function prepareAgentPackageRunHandler(): RouteHandlerMethod {
  return async (req, reply) => {
    try {
      return success(reply, req.id, await serviceFor(req).prepareRun(req.body as never));
    } catch (error) {
      return sendServiceError(req, reply, error);
    }
  };
}
