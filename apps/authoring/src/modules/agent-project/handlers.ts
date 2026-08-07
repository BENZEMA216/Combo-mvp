import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  CommitAgentRevisionBodySchema,
  CreateAgentProjectBodySchema,
  CreateAgentReleaseBodySchema,
  AgentResourceIdSchema,
  RecordAgentTestReviewBodySchema,
  DEFAULT_PAGE_LIMIT,
  ErrorCode,
  InvalidCursorError,
  MAX_PAGE_LIMIT,
  decodeIdCursor,
  encodeIdCursor,
  type AgentProjectView,
  type AgentRevisionView,
  type AgentTestReviewView,
  type Envelope,
  type Paginated,
} from '@cb/shared';
import { sendError } from '../../platform/http/_helpers.js';
import { asTxPool } from '../../platform/infra/db-tx.js';
import { AgentCompileDependencyError } from './compiler.js';
import { listAgentProjects } from './repo.js';
import {
  AgentRevisionIntegrityError,
  createAgentProject,
  publishAgentRevision,
  recordAgentTestReview,
  readAgentProjectDetail,
  readAgentRevisionDetail,
  saveAgentRevision,
} from './service.js';

export function createAgentProjectHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const parsed = CreateAgentProjectBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    try {
      const outcome = await createAgentProject(req.server.infra.db, userId, parsed.data);
      if (outcome.kind === 'source_task_not_found')
        return sendError(req, reply, ErrorCode.NOT_FOUND);
      if (outcome.kind === 'idempotency_conflict') {
        return sendError(req, reply, ErrorCode.IDEMPOTENCY_CONFLICT);
      }
      const body: Envelope<AgentProjectView> = {
        data: outcome.project,
        meta: { traceId: req.id },
      };
      reply.code(outcome.kind === 'created' ? 201 : 200).send(body);
      return reply;
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'create agent project failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
  };
}

export function listAgentProjectsHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const q = (req.query ?? {}) as { cursor?: string; limit?: string };
    const limit = q.limit === undefined ? DEFAULT_PAGE_LIMIT : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
      return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    }
    let cursorId: string | undefined;
    if (q.cursor !== undefined) {
      try {
        cursorId = decodeIdCursor(q.cursor);
        if (!AgentResourceIdSchema.safeParse(cursorId).success) throw new InvalidCursorError();
      } catch (err) {
        if (err instanceof InvalidCursorError) {
          return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
        }
        throw err;
      }
    }
    try {
      const page = await listAgentProjects(req.server.infra.db, {
        ownerUserId: userId,
        limit,
        ...(cursorId ? { cursorId } : {}),
      });
      const last = page.items.at(-1);
      const body: Paginated<AgentProjectView> = {
        data: page.items,
        meta: {
          traceId: req.id,
          page: {
            nextCursor: page.hasMore && last ? encodeIdCursor(last.id) : null,
            hasMore: page.hasMore,
            limit,
            order: 'desc',
          },
        },
      };
      reply.code(200).send(body);
      return reply;
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'list agent projects failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
  };
}

export function getAgentProjectHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const parsedProjectId = AgentResourceIdSchema.safeParse(
      (req.params as { projectId?: string }).projectId,
    );
    if (!parsedProjectId.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    const projectId = parsedProjectId.data;
    try {
      const detail = await readAgentProjectDetail(req.server.infra.db, {
        projectId,
        ownerUserId: userId,
      });
      if (!detail) return sendError(req, reply, ErrorCode.NOT_FOUND);
      reply.code(200).send({ data: detail, meta: { traceId: req.id } });
      return reply;
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'read agent project failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
  };
}

function compileFailureReply(
  req: FastifyRequest,
  reply: FastifyReply,
  kind: string,
  details?: Record<string, unknown>,
): FastifyReply {
  if (kind === 'capability_not_found' || kind === 'ui_not_found') {
    return sendError(req, reply, ErrorCode.NOT_FOUND, { details });
  }
  return sendError(req, reply, ErrorCode.VALIDATION_FAILED, {
    userMessage:
      kind === 'ui_invalid'
        ? 'Miniapp 没有通过 Agent UI 静态契约。'
        : kind === 'output_schema_invalid'
          ? '结构化输出的 JSON Schema 无法编译。'
          : 'Agent 定义无法编译。',
    details,
  });
}

export function commitAgentRevisionHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const parsedProjectId = AgentResourceIdSchema.safeParse(
      (req.params as { projectId?: string }).projectId,
    );
    if (!parsedProjectId.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    const projectId = parsedProjectId.data;
    const parsed = CommitAgentRevisionBodySchema.safeParse(req.body ?? {});
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
      const outcome = await saveAgentRevision(
        asTxPool(req.server.infra.db),
        req.server.infra.db,
        req.server.infra.objectStore,
        { projectId, ownerUserId: userId, body: parsed.data },
      );
      if (outcome.kind === 'not_found') return sendError(req, reply, ErrorCode.NOT_FOUND);
      if (outcome.kind === 'idempotency_conflict') {
        return sendError(req, reply, ErrorCode.IDEMPOTENCY_CONFLICT);
      }
      if (outcome.kind === 'head_conflict') {
        return sendError(req, reply, ErrorCode.STATE_CONFLICT, {
          userMessage: 'Agent 已被其他修改更新，请读取最新 Head 后重新提交。',
          details: { currentHeadRevisionId: outcome.currentHeadRevisionId },
        });
      }
      if (outcome.kind === 'compile_failed') {
        return compileFailureReply(req, reply, outcome.error.kind, outcome.error.details);
      }
      const project = await readAgentProjectDetail(req.server.infra.db, {
        projectId,
        ownerUserId: userId,
      });
      if (!project) return sendError(req, reply, ErrorCode.INTERNAL);
      const revision: AgentRevisionView = {
        id: outcome.revision.id,
        projectId: outcome.revision.projectId,
        revisionNumber: outcome.revision.revisionNumber,
        parentRevisionId: outcome.revision.parentRevisionId,
        entryCapabilityId: outcome.revision.entryCapabilityId,
        definitionSha256: outcome.revision.definitionSha256,
        runtimeBundleSha256: outcome.revision.runtimeBundleSha256,
        uiArtifactId: outcome.revision.uiArtifactId,
        uiSha256: outcome.revision.uiSha256,
        compilerVersion: outcome.revision.compilerVersion,
        changeSummary: outcome.revision.changeSummary,
        createdAt: outcome.revision.createdAt,
      };
      reply
        .code(outcome.kind === 'created' ? 201 : 200)
        .send({ data: { project, revision }, meta: { traceId: req.id } });
      return reply;
    } catch (err) {
      if (err instanceof AgentCompileDependencyError) {
        req.log.error({ err, traceId: req.id }, 'Agent compiler dependency unavailable');
        return sendError(req, reply, ErrorCode.DEPENDENCY_UNAVAILABLE);
      }
      req.log.error({ err, traceId: req.id }, 'commit agent revision failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
  };
}

export function getAgentRevisionHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const params = req.params as { projectId?: string; revisionId?: string };
    const parsedProjectId = AgentResourceIdSchema.safeParse(params.projectId);
    const parsedRevisionId = AgentResourceIdSchema.safeParse(params.revisionId);
    if (!parsedProjectId.success || !parsedRevisionId.success) {
      return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    }
    const projectId = parsedProjectId.data;
    const revisionId = parsedRevisionId.data;
    try {
      const detail = await readAgentRevisionDetail(
        req.server.infra.db,
        req.server.infra.objectStore,
        { projectId, revisionId, ownerUserId: userId },
      );
      if (!detail) return sendError(req, reply, ErrorCode.NOT_FOUND);
      reply.code(200).send({ data: detail, meta: { traceId: req.id } });
      return reply;
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'read agent revision failed');
      return sendError(
        req,
        reply,
        err instanceof AgentRevisionIntegrityError
          ? ErrorCode.INTERNAL
          : ErrorCode.DEPENDENCY_UNAVAILABLE,
      );
    }
  };
}

export function recordAgentTestReviewHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const params = req.params as { projectId?: string; testId?: string };
    const parsedProjectId = AgentResourceIdSchema.safeParse(params.projectId);
    const parsedTestId = AgentResourceIdSchema.safeParse(params.testId);
    if (!parsedProjectId.success || !parsedTestId.success) {
      return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    }
    const parsed = RecordAgentTestReviewBodySchema.safeParse(req.body ?? {});
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
      const outcome = await recordAgentTestReview(asTxPool(req.server.infra.db), {
        projectId: parsedProjectId.data,
        testId: parsedTestId.data,
        ownerUserId: userId,
        body: parsed.data,
      });
      if (outcome.kind === 'not_found') return sendError(req, reply, ErrorCode.NOT_FOUND);
      if (outcome.kind === 'idempotency_conflict') {
        return sendError(req, reply, ErrorCode.IDEMPOTENCY_CONFLICT);
      }
      if (outcome.kind === 'test_not_passed') {
        return sendError(req, reply, ErrorCode.STATE_CONFLICT, {
          userMessage: '只有技术执行已经通过的 Agent Test 才能记录质量复核。',
        });
      }
      if (outcome.kind === 'review_exists') {
        return sendError(req, reply, ErrorCode.STATE_CONFLICT, {
          userMessage: '这个 Agent Test 已有不可变质量复核；需要改变结论时请重新运行 Test。',
        });
      }
      const body: Envelope<AgentTestReviewView> = {
        data: outcome.review,
        meta: { traceId: req.id },
      };
      reply.code(outcome.kind === 'created' ? 201 : 200).send(body);
      return reply;
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'record agent test review failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
  };
}

export function createAgentReleaseHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const parsedProjectId = AgentResourceIdSchema.safeParse(
      (req.params as { projectId?: string }).projectId,
    );
    if (!parsedProjectId.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    const projectId = parsedProjectId.data;
    const parsed = CreateAgentReleaseBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    try {
      const outcome = await publishAgentRevision(
        asTxPool(req.server.infra.db),
        req.server.infra.db,
        req.server.infra.objectStore,
        {
          projectId,
          ownerUserId: userId,
          body: parsed.data,
        },
      );
      if (outcome.kind === 'not_found') return sendError(req, reply, ErrorCode.NOT_FOUND);
      if (outcome.kind === 'idempotency_conflict') {
        return sendError(req, reply, ErrorCode.IDEMPOTENCY_CONFLICT);
      }
      if (outcome.kind === 'head_conflict') {
        return sendError(req, reply, ErrorCode.STATE_CONFLICT, {
          userMessage: '只能发布当前 Agent Head，请读取最新版本后重新测试。',
          details: { currentHeadRevisionId: outcome.currentHeadRevisionId },
        });
      }
      if (outcome.kind === 'test_not_passed') {
        return sendError(req, reply, ErrorCode.STATE_CONFLICT, {
          userMessage: '发布要求同一个 Agent Revision 的真实测试已经通过。',
        });
      }
      if (outcome.kind === 'review_not_publishable') {
        return sendError(req, reply, ErrorCode.STATE_CONFLICT, {
          userMessage: '发布要求该 Test 已有通过或已接受例外的不可变质量复核。',
        });
      }
      if (outcome.kind === 'capability_ineligible') {
        return sendError(req, reply, ErrorCode.STATE_CONFLICT, {
          userMessage: '占位能力不可用于 Agent。',
        });
      }
      const project = await readAgentProjectDetail(req.server.infra.db, {
        projectId,
        ownerUserId: userId,
      });
      if (!project) return sendError(req, reply, ErrorCode.INTERNAL);
      reply
        .code(outcome.kind === 'created' ? 201 : 200)
        .send({ data: { project, release: outcome.release }, meta: { traceId: req.id } });
      return reply;
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'create agent release failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
  };
}
