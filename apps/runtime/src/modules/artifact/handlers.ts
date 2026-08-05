// 产物域 HTTP handler：内容回读（owner 校验后从 MinIO 读回，带正确 Content-Type）。
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  ErrorCode,
  AgentResourceIdSchema,
  SaveAgentUiRevisionBodySchema,
  type Envelope,
  type SavedAgentUiRevision,
} from '@cb/shared';
import { sendError } from '../../platform/http/_helpers.js';
import { getSession } from '../session/repo.js';
import {
  ARTIFACT_BUCKET,
  DirectUiIdempotencyConflictError,
  DirectUiSessionBusyError,
  contentTypeFor,
  readArtifactForOwner,
  saveDirectStudioUiRevision,
} from './repo.js';
import { StudioArtifactValidationError } from './studio-contract.js';

// ───────────────────────────── GET /runtime/artifacts/:id/content ─────────────────────────────

export function artifactContentHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const { id } = req.params as { id: string };

    let row;
    try {
      row = await readArtifactForOwner(req.server.infra.db, id, userId);
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'read artifact failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
    if (!row) return sendError(req, reply, ErrorCode.NOT_FOUND);

    let content: string;
    try {
      content = await req.server.infra.objectStore.getObjectText(ARTIFACT_BUCKET, row.storageKey);
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'read artifact content from object store failed');
      return sendError(req, reply, ErrorCode.DEPENDENCY_UNAVAILABLE);
    }
    reply.code(200).type(contentTypeFor(row.kind)).send(content);
    return reply;
  };
}

// ───────────────────────────── POST /runtime/studio/sessions/:id/ui-revisions ─────────────────────────────

export function saveAgentUiRevisionHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const parsed = SaveAgentUiRevisionBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    const parsedSessionId = AgentResourceIdSchema.safeParse((req.params as { id?: string }).id);
    if (!parsedSessionId.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    const id = parsedSessionId.data;

    try {
      const session = await getSession(req.server.infra.db, id, userId);
      if (!session || session.mode !== 'studio') return sendError(req, reply, ErrorCode.NOT_FOUND);
      const saved = await saveDirectStudioUiRevision(
        req.server.infra.db,
        req.server.infra.objectStore,
        {
          sessionId: session.id,
          capabilityId: session.capabilityId,
          ownerUserId: userId,
          title: parsed.data.title,
          html: parsed.data.html,
          idempotencyKey: parsed.data.idempotencyKey,
        },
      );
      const data: SavedAgentUiRevision = {
        sessionId: session.id,
        capabilityId: session.capabilityId,
        artifact: saved.artifact,
        sha256: saved.sha256,
      };
      const body: Envelope<SavedAgentUiRevision> = { data, meta: { traceId: req.id } };
      reply.code(saved.created ? 201 : 200).send(body);
      return reply;
    } catch (err) {
      if (err instanceof StudioArtifactValidationError) {
        return sendError(req, reply, ErrorCode.VALIDATION_FAILED, {
          userMessage: 'Miniapp 没有通过 Agent UI 静态契约。',
          details: { issues: err.issues },
        });
      }
      if (err instanceof DirectUiSessionBusyError) {
        return sendError(req, reply, ErrorCode.SESSION_BUSY);
      }
      if (err instanceof DirectUiIdempotencyConflictError) {
        return sendError(req, reply, ErrorCode.IDEMPOTENCY_CONFLICT);
      }
      req.log.error({ err, traceId: req.id }, 'save direct Studio UI revision failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
  };
}
