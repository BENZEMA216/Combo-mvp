import { createHash, randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  CreateReleasedAgentSessionBodySchema,
  AgentResourceIdSchema,
  canonicalJson,
  ErrorCode,
  ListAgentProjectTestsQuerySchema,
  StartAgentTestBodySchema,
  type AgentTestDetail,
  type AgentTestList,
  type Envelope,
  type RechargeRequiredBody,
  type SessionView,
} from '@cb/shared';
import { sendError } from '../../platform/http/_helpers.js';
import { TurnAdmissionUnavailableError } from '../agent/run-turn.js';
import {
  loadCurrentAgentRelease,
  loadOwnedAgentRevision,
  type LoadedAgentRevision,
} from '../agent/revision-loader.js';
import { UsageRequestConflictError } from '../billing/service.js';
import {
  SessionBusyError,
  archiveSession,
  createSession,
  getOrCreateAgentTestSession,
  toSessionView,
} from '../session/repo.js';
import { seedAgentRevisionUiArtifact } from '../artifact/repo.js';
import {
  activateAgentTest,
  discardAgentTestReservation,
  listAgentProjectTests,
  readAndFinalizeAgentTest,
  reserveAgentTest,
} from './repo.js';

async function createPinnedSession(
  req: FastifyRequest,
  ownerUserId: string,
  revision: LoadedAgentRevision,
  testSessionId?: string,
  onSessionCreated?: (session: SessionView) => void,
): Promise<SessionView> {
  const session = testSessionId
    ? await getOrCreateAgentTestSession(req.server.infra.db, {
        sessionId: testSessionId,
        capabilityId: revision.entryCapabilityId,
        ownerUserId,
        agentProjectId: revision.projectId,
        agentRevisionId: revision.revisionId,
      })
    : await createSession(req.server.infra.db, {
        capabilityId: revision.entryCapabilityId,
        ownerUserId,
        agentProjectId: revision.projectId,
        agentRevisionId: revision.revisionId,
        ...(revision.releaseId ? { agentReleaseId: revision.releaseId } : {}),
      });
  const sessionView = toSessionView(session);
  onSessionCreated?.(sessionView);
  try {
    await seedAgentRevisionUiArtifact(req.server.infra.db, req.server.infra.objectStore, {
      revisionId: revision.revisionId,
      sourceArtifactId: revision.uiArtifactId,
      sourceStorageKey: revision.uiStorageKey,
      sourceUiSha256: revision.uiSha256,
      capabilityId: revision.entryCapabilityId,
      targetSessionId: session.id,
      targetOwnerUserId: ownerUserId,
    });
  } catch (error) {
    if (!onSessionCreated) {
      await archiveSession(req.server.infra.db, session.id, ownerUserId).catch(() => null);
    }
    throw error;
  }
  return sessionView;
}

export function startAgentTestHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const parsed = StartAgentTestBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    const parsedRevisionId = AgentResourceIdSchema.safeParse(
      (req.params as { revisionId?: string }).revisionId,
    );
    if (!parsedRevisionId.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    const revisionId = parsedRevisionId.data;
    const loaded = await loadOwnedAgentRevision(req.server.infra.db, req.server.infra.objectStore, {
      revisionId,
      ownerUserId: userId,
    });
    if (loaded.kind === 'not_found') return sendError(req, reply, ErrorCode.NOT_FOUND);
    if (loaded.kind === 'invalid_bundle') return sendError(req, reply, ErrorCode.INTERNAL);

    const requestSha256 = createHash('sha256')
      .update(canonicalJson({ revisionId, text: parsed.data.text }))
      .digest('hex');
    let session: SessionView | undefined;
    let reservation: { testId: string; leaseToken: string } | undefined;
    const discardReservation = async (): Promise<void> => {
      if (!reservation) return;
      const claimedReservation = reservation;
      reservation = undefined;
      // claim 删除与固定 Session 关闭在同一事务；丢 lease 或 Test 已激活时两者都不动。
      await discardAgentTestReservation(req.server.infra.db, {
        ...claimedReservation,
        ownerUserId: userId,
      }).catch(() => false);
    };
    try {
      const reservationResult = await reserveAgentTest(req.server.infra.db, {
        revision: loaded.revision,
        requestKey: parsed.data.idempotencyKey,
        requestSha256,
      });
      if (reservationResult.kind === 'idempotency_conflict') {
        return sendError(req, reply, ErrorCode.IDEMPOTENCY_CONFLICT);
      }
      if (reservationResult.kind === 'starting') {
        return sendError(req, reply, ErrorCode.RESOURCE_LOCKED, {
          userMessage: '同一个 Agent Test 正在启动，请稍后用相同幂等键重试。',
          details: { retryAfterSeconds: 1 },
        });
      }
      if (reservationResult.kind === 'replayed') {
        const data = await readAndFinalizeAgentTest(
          req.server.infra.db,
          reservationResult.test.id,
          userId,
        );
        if (!data) return sendError(req, reply, ErrorCode.INTERNAL);
        const body: Envelope<AgentTestDetail> = { data, meta: { traceId: req.id } };
        reply.code(data.test.status === 'running' ? 202 : 200).send(body);
        return reply;
      }
      reservation = {
        testId: reservationResult.testId,
        leaseToken: reservationResult.leaseToken,
      };

      session = await createPinnedSession(
        req,
        userId,
        loaded.revision,
        reservation.testId,
        (created) => {
          session = created;
        },
      );
      const sessionRow = {
        id: session.id,
        capabilityId: session.capabilityId,
        ownerUserId: userId,
        agentProjectId: session.agentProjectId ?? null,
        agentRevisionId: session.agentRevisionId ?? null,
        agentReleaseId: session.agentReleaseId ?? null,
        mode: 'consume' as const,
        title: session.title ?? null,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      };
      let test: AgentTestDetail['test'] | null = null;
      const turnId = randomUUID();
      const result = await req.server.turns.startTurn({
        session: sessionRow,
        definition: loaded.revision.bundle.definition,
        text: parsed.data.text,
        usageId: reservation.testId,
        capabilityOwnerUserId: loaded.revision.capabilityOwnerUserId,
        log: req.log,
        turnId,
        beforeCommit: async (transaction, persistedTurnId) => {
          test = await activateAgentTest(transaction, {
            testId: reservation!.testId,
            leaseToken: reservation!.leaseToken,
            sessionId: session!.id,
            turnId: persistedTurnId,
          });
          if (!test) throw new Error('Agent Test reservation could not be activated');
        },
      });
      if (result.status === 'recharge_required') {
        const rechargeIntentId = reservation.testId;
        await discardReservation();
        const body: RechargeRequiredBody = {
          rechargeRequired: true,
          rechargeIntentId,
          balanceCents: result.balanceCents.toString(),
          requiredCents: result.requiredCents.toString(),
        };
        reply.code(402).send(body);
        return reply;
      }
      if (result.status === 'replayed') {
        throw new Error('Agent Test usage replayed before its reservation was activated');
      }
      if (!test) throw new Error('Agent Test reservation could not be activated');
      reservation = undefined;
      const data: AgentTestDetail = { test, outputText: null, review: null };
      const body: Envelope<AgentTestDetail> = { data, meta: { traceId: req.id } };
      reply.code(202).send(body);
      return reply;
    } catch (err) {
      await discardReservation();
      if (err instanceof SessionBusyError) return sendError(req, reply, ErrorCode.SESSION_BUSY);
      if (err instanceof UsageRequestConflictError) {
        return sendError(req, reply, ErrorCode.IDEMPOTENCY_CONFLICT);
      }
      if (err instanceof TurnAdmissionUnavailableError) {
        req.log.warn(
          {
            traceId: req.id,
            admissionStage: err.stage,
            admissionReason: err.reason,
            ...(err.databaseCode ? { databaseCode: err.databaseCode } : {}),
          },
          'Agent Test turn admission temporarily unavailable',
        );
        return sendError(req, reply, ErrorCode.DEPENDENCY_UNAVAILABLE);
      }
      req.log.error({ err, traceId: req.id }, 'start Agent Revision test failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
  };
}

export function getAgentTestHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const parsedTestId = AgentResourceIdSchema.safeParse(
      (req.params as { testId?: string }).testId,
    );
    if (!parsedTestId.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    const testId = parsedTestId.data;
    try {
      const data = await readAndFinalizeAgentTest(req.server.infra.db, testId, userId);
      if (!data) return sendError(req, reply, ErrorCode.NOT_FOUND);
      const body: Envelope<AgentTestDetail> = { data, meta: { traceId: req.id } };
      reply.code(200).send(body);
      return reply;
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'read Agent test failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
  };
}

export function listAgentProjectTestsHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const parsedProjectId = AgentResourceIdSchema.safeParse(
      (req.params as { projectId?: string }).projectId,
    );
    if (!parsedProjectId.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    const parsedQuery = ListAgentProjectTestsQuerySchema.safeParse(req.query ?? {});
    if (!parsedQuery.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);

    try {
      const data = await listAgentProjectTests(req.server.infra.db, {
        projectId: parsedProjectId.data,
        ownerUserId: userId,
        limit: parsedQuery.data.limit,
      });
      if (!data) return sendError(req, reply, ErrorCode.NOT_FOUND);
      const body: Envelope<AgentTestList> = { data, meta: { traceId: req.id } };
      reply.code(200).send(body);
      return reply;
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'list Agent Project tests failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
  };
}

export function createReleasedAgentSessionHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const parsed = CreateReleasedAgentSessionBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    const parsedProjectId = AgentResourceIdSchema.safeParse(
      (req.params as { projectId?: string }).projectId,
    );
    if (!parsedProjectId.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    const projectId = parsedProjectId.data;
    const loaded = await loadCurrentAgentRelease(
      req.server.infra.db,
      req.server.infra.objectStore,
      projectId,
    );
    if (loaded.kind === 'not_found') return sendError(req, reply, ErrorCode.NOT_FOUND);
    if (loaded.kind === 'invalid_bundle') return sendError(req, reply, ErrorCode.INTERNAL);
    try {
      const data = await createPinnedSession(req, userId, loaded.revision);
      const body: Envelope<SessionView> = { data, meta: { traceId: req.id } };
      reply.code(201).send(body);
      return reply;
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'create released Agent session failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
  };
}
