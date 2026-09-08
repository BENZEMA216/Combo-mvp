import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode, errorBodyFor } from '@cb/shared';
import { requireAuth } from '../../platform/middleware/auth.js';
import { requireTrustedMutationOrigin } from '../../platform/http/browser-origin.js';
import { registerEndpoints, sendError, type EndpointDecl } from '../../platform/http/_helpers.js';
import { asTxPool } from '../../platform/infra/db-tx.js';
import { createS3ImmutableObjectStore } from '../../platform/infra/object-store.js';
import { AgentDraftFailure, AgentDraftService, DraftId, PgDraftRepository } from './service.js';

function service(req: FastifyRequest) {
  return new AgentDraftService(
    new PgDraftRepository(asTxPool(req.server.infra.db), req.server.infra.db),
    createS3ImmutableObjectStore(req.server.infra.env),
  );
}
function failure(req: FastifyRequest, reply: FastifyReply, error: unknown) {
  const code =
    error instanceof AgentDraftFailure
      ? error.kind === 'validation'
        ? ErrorCode.VALIDATION_FAILED
        : error.kind === 'revision_conflict'
          ? ErrorCode.STATE_CONFLICT
          : error.kind === 'idempotency_conflict'
            ? ErrorCode.IDEMPOTENCY_CONFLICT
            : ErrorCode.DEPENDENCY_UNAVAILABLE
      : ErrorCode.DEPENDENCY_UNAVAILABLE;
  req.log.warn({ code, traceId: req.id }, 'Private Agent Draft request rejected');
  return sendError(req, reply, code);
}
async function noStore(_req: FastifyRequest, reply: FastifyReply) {
  reply.header('cache-control', 'no-store');
}
export const AGENT_DRAFT_ENDPOINTS: EndpointDecl[] = [
  {
    method: 'POST',
    url: '/agent-package-drafts',
    onRequest: [noStore, requireTrustedMutationOrigin(), requireAuth()],
    preHandlers: [
      async (req, reply) => {
        if (
          req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
        )
          return;
        const { body } = errorBodyFor(ErrorCode.VALIDATION_FAILED, req.id);
        return reply.code(415).send({ error: body });
      },
    ],
    bodyLimit: 1_048_576,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      if (!req.auth) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
      try {
        const result = await service(req).save(req.auth.userId, req.body);
        return reply
          .code(result.created ? 201 : 200)
          .send({ data: result.record, meta: { traceId: req.id } });
      } catch (error) {
        return failure(req, reply, error);
      }
    },
  },
  {
    method: 'GET',
    url: '/agent-package-drafts/:draftId/revisions/:revision',
    onRequest: [noStore, requireAuth()],
    handler: async (req, reply) => {
      if (!req.auth) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
      const params = req.params as { draftId: string; revision: string };
      if (
        !DraftId.safeParse(params.draftId).success ||
        !/^[1-9][0-9]{0,15}$/u.test(params.revision) ||
        !Number.isSafeInteger(Number(params.revision))
      )
        return sendError(req, reply, ErrorCode.NOT_FOUND);
      try {
        const record = await service(req).read(
          req.auth.userId,
          params.draftId,
          Number(params.revision),
        );
        return record
          ? reply.send({ data: record, meta: { traceId: req.id } })
          : sendError(req, reply, ErrorCode.NOT_FOUND);
      } catch (error) {
        return failure(req, reply, error);
      }
    },
  },
];

export async function registerAgentDraftRoutes(app: FastifyInstance) {
  await app.register(async (scope) => {
    scope.setErrorHandler((error, req, reply) => {
      const status = (error as { statusCode?: number }).statusCode;
      const code =
        status === 429
          ? ErrorCode.RATE_LIMITED
          : [400, 413, 415].includes(status ?? 0)
            ? ErrorCode.VALIDATION_FAILED
            : ErrorCode.INTERNAL;
      const { http, body } = errorBodyFor(code, req.id);
      reply
        .header('cache-control', 'no-store')
        .code(status === 413 || status === 415 ? status : http)
        .send({ error: body });
    });
    registerEndpoints(scope, AGENT_DRAFT_ENDPOINTS);
  });
}
