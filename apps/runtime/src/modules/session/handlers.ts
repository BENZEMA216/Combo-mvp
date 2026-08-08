// 会话域 HTTP handler：薄壳——校验入参、owner 校验、调 repo/runner、包响应信封。
// 非本人与不存在同样 404（不暴露存在性）。
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { z } from 'zod';
import {
  CreateSessionBodySchema,
  CreateStudioSessionBodySchema,
  ErrorCode,
  SessionModeSchema,
  SendMessageBodySchema,
  UpdateSessionBodySchema,
  type CapabilityInputField,
  type Envelope,
  type MessageView,
  type RechargeRequiredBody,
  type SessionDetail,
  type SessionMode,
  type SessionView,
  type StudioSessionEntry,
  type StudioSessionView,
} from '@cb/shared';
import { sendError } from '../../platform/http/_helpers.js';
import { loadCapability } from '../capability/loader.js';
import { sendLoadFailure } from '../capability/handlers.js';
import { SessionInactiveError, TurnAdmissionUnavailableError } from '../agent/run-turn.js';
import { UsageRequestConflictError } from '../billing/service.js';
import { adoptExistingConsumeUiArtifact, seedCapabilityUiArtifact } from '../artifact/repo.js';
import {
  archiveSession,
  createSession,
  getOrCreateStudioSession,
  getSession,
  listSessions,
  SessionBusyError,
  toSessionView,
  type SessionRow,
  updateSessionTitle,
} from './repo.js';
import { readSessionDetailDbSnapshot } from './detail.js';

/** owner-scoped 取会话，失败即回信封；成功返回行。 */
async function requireOwnedSession(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionRow | null> {
  const userId = req.auth?.userId;
  if (!userId) {
    sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    return null;
  }
  const { id } = req.params as { id: string };
  let session: SessionRow | null;
  try {
    session = await getSession(req.server.infra.db, id, userId);
  } catch (err) {
    req.log.error({ err, traceId: req.id }, 'read session failed');
    sendError(req, reply, ErrorCode.INTERNAL);
    return null;
  }
  if (!session) {
    sendError(req, reply, ErrorCode.NOT_FOUND);
    return null;
  }
  return session;
}

// ───────────────────────────── POST /runtime/studio/sessions ─────────────────────────────

/**
 * 原子进入一个 Agent 的设计空间：仅创作者本人可用，并复用同一条 active Studio 会话。
 */
export function createStudioSessionHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const parsed = CreateStudioSessionBodySchema.safeParse(req.body);
    if (!parsed.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);

    const { db, objectStore } = req.server.infra;
    let loaded;
    try {
      loaded = await loadCapability(db, objectStore, parsed.data.capabilityId, userId, 'owner');
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'load studio capability failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
    if (loaded.kind !== 'ok') return sendLoadFailure(req, reply, loaded);

    let session: SessionRow | undefined;
    try {
      session = await getOrCreateStudioSession(db, {
        capabilityId: loaded.capability.id,
        ownerUserId: userId,
      });
      // Studio 被归档后重新进入时，从 capability 当前 UI 恢复一份可继续修改的会话内副本。
      // 已有 active Studio 产物时 seed 幂等返回，不制造重复页面。
      const seeded = await seedCapabilityUiArtifact(db, objectStore, {
        capabilityId: loaded.capability.id,
        targetSessionId: session.id,
        targetOwnerUserId: userId,
        targetMode: 'studio',
      });
      if (!seeded) {
        await adoptExistingConsumeUiArtifact(db, objectStore, {
          capabilityId: loaded.capability.id,
          ownerUserId: userId,
          targetStudioSessionId: session.id,
        });
      }
    } catch (err) {
      // getOrCreate 可能返回已有 Studio；seed 的瞬时失败绝不能误归档用户的设计历史。
      // 会话保持 active，下一次进入会幂等重试恢复/迁移。
      req.log.error({ err, traceId: req.id }, 'get or create studio session failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
    const data: StudioSessionView = { ...toSessionView(session), mode: 'studio' };
    const body: Envelope<StudioSessionEntry> = {
      data: { session: data },
      meta: { traceId: req.id },
    };
    reply.code(200).send(body);
    return reply;
  };
}

// ───────────────────────────── POST /runtime/sessions ─────────────────────────────

export function createSessionHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const parsed = CreateSessionBodySchema.safeParse(req.body);
    if (!parsed.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);

    const { db, objectStore } = req.server.infra;
    // 开会话前 loader 全链校验（权限闸 + 定义可解析），坏能力不留下空会话。
    let loaded;
    try {
      loaded = await loadCapability(db, objectStore, parsed.data.capabilityId, userId);
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'load capability failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
    if (loaded.kind !== 'ok') return sendLoadFailure(req, reply, loaded);

    let session: SessionRow | undefined;
    try {
      session = await createSession(db, {
        capabilityId: loaded.capability.id,
        ownerUserId: userId,
      });
      // 每个真实运行会话拿一份创建时的 UI 快照；之后 Studio 再修改不会让旧任务中途漂移。
      await seedCapabilityUiArtifact(db, objectStore, {
        capabilityId: loaded.capability.id,
        targetSessionId: session.id,
        targetOwnerUserId: userId,
        targetMode: 'consume',
      });
    } catch (err) {
      if (session) {
        // 对象存储/复制失败时不把半成品会话留在用户列表里。
        await archiveSession(db, session.id, userId).catch(() => null);
      }
      req.log.error({ err, traceId: req.id }, 'create session failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
    const body: Envelope<SessionView> = { data: toSessionView(session), meta: { traceId: req.id } };
    reply.code(201).send(body);
    return reply;
  };
}

// ───────────────────────────── GET /runtime/sessions ─────────────────────────────

export function listSessionsHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    // 可选按能力过滤（侧栏只列当前能力下的会话）；非 UUID 直接拒（防 SQL uuid cast 报 500）。
    const { capabilityId, mode: rawMode } = req.query as {
      capabilityId?: string;
      mode?: string;
    };
    if (capabilityId !== undefined && !z.string().uuid().safeParse(capabilityId).success) {
      return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    }
    let mode: SessionMode = 'consume';
    if (rawMode !== undefined) {
      const parsedMode = SessionModeSchema.safeParse(rawMode);
      if (!parsedMode.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
      mode = parsedMode.data;
    }

    let sessions: SessionRow[];
    try {
      sessions = await listSessions(req.server.infra.db, userId, capabilityId, mode);
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'list sessions failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
    const body: Envelope<SessionView[]> = {
      data: sessions.map(toSessionView),
      meta: { traceId: req.id },
    };
    reply.code(200).send(body);
    return reply;
  };
}

// ───────────────────────────── GET /runtime/sessions/:id ─────────────────────────────

export function updateSessionHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const session = await requireOwnedSession(req, reply);
    if (!session) return reply;
    const parsed = UpdateSessionBodySchema.safeParse(req.body);
    if (!parsed.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);

    try {
      const updated = await updateSessionTitle(
        req.server.infra.db,
        session.id,
        session.ownerUserId,
        parsed.data.title,
      );
      if (!updated) return sendError(req, reply, ErrorCode.NOT_FOUND);
      const body: Envelope<SessionView> = {
        data: toSessionView(updated),
        meta: { traceId: req.id },
      };
      reply.code(200).send(body);
      return reply;
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'update session failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
  };
}

export function archiveSessionHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const session = await requireOwnedSession(req, reply);
    if (!session) return reply;

    try {
      const archived = await archiveSession(req.server.infra.db, session.id, session.ownerUserId);
      if (!archived) return sendError(req, reply, ErrorCode.NOT_FOUND);
      if (req.server.infra.sandbox?.enabled) {
        // Archival is already committed. Pod cleanup is best effort and must not
        // delay or suppress the successful HTTP response if the control plane stalls.
        void req.server.infra.sandbox.releaseSession(session.id).catch((err) => {
          req.log.warn({ err, traceId: req.id }, 'release archived session sandbox failed');
        });
      }
      const body: Envelope<SessionView> = {
        data: toSessionView(archived),
        meta: { traceId: req.id },
      };
      reply.code(200).send(body);
      return reply;
    } catch (err) {
      if (err instanceof SessionBusyError) {
        return sendError(req, reply, ErrorCode.SESSION_BUSY, {
          userMessage: '这条会话仍在生成，停止或等待完成后再归档。',
        });
      }
      req.log.error({ err, traceId: req.id }, 'archive session failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
  };
}

export function getSessionDetailHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const { id } = req.params as { id: string };
    const { db, objectStore } = req.server.infra;

    try {
      const snapshot = await readSessionDetailDbSnapshot(db, {
        sessionId: id,
        ownerUserId: userId,
      });
      if (!snapshot) return sendError(req, reply, ErrorCode.NOT_FOUND);
      const {
        session,
        capability,
        messages,
        artifacts,
        currentUiArtifact,
        activeTurn,
        latestTerminalTurn,
      } = snapshot;
      // 能力行被删属于数据异常（会话仍指着它），按 500 收口而不是装作没会话。
      if (!capability) {
        req.log.error(
          { traceId: req.id, capabilityId: session.capabilityId },
          'capability row missing',
        );
        return sendError(req, reply, ErrorCode.INTERNAL);
      }
      const consumeUiSnapshots = artifacts.filter(
        (artifact) =>
          artifact.kind === 'html' &&
          z.string().uuid().safeParse(artifact.sourceArtifactId).success &&
          artifact.sourceTurnId === undefined,
      );
      if (session.mode === 'consume' && consumeUiSnapshots.length > 1) {
        req.log.error(
          { traceId: req.id, snapshotCount: consumeUiSnapshots.length },
          'consume UI snapshot invariant violated',
        );
        return sendError(req, reply, ErrorCode.INTERNAL);
      }
      const sessionCurrentUiArtifactId =
        session.mode === 'consume'
          ? consumeUiSnapshots.length === 1
            ? consumeUiSnapshots[0]!.id
            : null
          : currentUiArtifact === null
            ? null
            : (artifacts.find(
                (artifact) =>
                  artifact.id === currentUiArtifact.id ||
                  artifact.sourceArtifactId === currentUiArtifact.id,
              )?.id ?? null);
      // 开场表单字段与提示语在 MinIO 定义里；定义读不出不阻塞详情（退化为空数组，自由输入仍可用）。
      let inputs: CapabilityInputField[] = [];
      let starterPrompts: string[] = [];
      try {
        const loaded = await loadCapability(
          db,
          objectStore,
          session.capabilityId,
          session.ownerUserId,
        );
        if (loaded.kind === 'ok') {
          inputs = loaded.definition.inputs;
          starterPrompts = loaded.definition.starterPrompts;
        }
      } catch (err) {
        req.log.warn({ err, traceId: req.id }, 'load definition for detail failed, degrading');
      }
      const detail: SessionDetail = {
        session: toSessionView(session),
        capability: { ...capability, inputs, starterPrompts },
        messages: messages.map((m) => ({
          id: m.id,
          seq: m.seq,
          ...(m.turnId ? { turnId: m.turnId } : {}),
          role: m.role,
          content: m.content,
          status: m.status,
          createdAt: m.createdAt,
        })),
        artifacts,
        activeTurn,
        latestTerminalTurn,
        currentUiArtifactId: sessionCurrentUiArtifactId,
      };
      const body: Envelope<SessionDetail> = { data: detail, meta: { traceId: req.id } };
      reply.code(200).send(body);
      return reply;
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'read session detail failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
  };
}

// ───────────────────────────── POST /runtime/sessions/:id/messages ─────────────────────────────

export function sendMessageHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const session = await requireOwnedSession(req, reply);
    if (!session) return reply;
    const parsed = SendMessageBodySchema.safeParse(req.body);
    if (!parsed.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);

    const { db, objectStore } = req.server.infra;
    // 每轮重新加载定义（发布态/定义可能已变；owner 校验对会话主人重新走一遍权限闸）。
    let loaded;
    try {
      loaded = await loadCapability(db, objectStore, session.capabilityId, session.ownerUserId);
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'load capability failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
    if (loaded.kind !== 'ok') return sendLoadFailure(req, reply, loaded);

    let result;
    try {
      result = await req.server.turns.startTurn({
        session,
        definition: loaded.definition,
        text: parsed.data.text,
        usageId: parsed.data.usageId,
        capabilityOwnerUserId: loaded.capability.ownerUserId,
        log: req.log,
      });
    } catch (err) {
      if (err instanceof SessionInactiveError) {
        return sendError(req, reply, ErrorCode.STATE_CONFLICT, {
          userMessage: '这条会话已经归档，请新建会话后再发送。',
        });
      }
      if (err instanceof SessionBusyError) {
        return sendError(req, reply, ErrorCode.SESSION_BUSY, {
          userMessage: '这条会话仍在生成，请停止或等待完成后再发送。',
        });
      }
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
          'turn admission temporarily unavailable',
        );
        return sendError(req, reply, ErrorCode.DEPENDENCY_UNAVAILABLE);
      }
      req.log.error({ err, traceId: req.id }, 'start turn failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
    if (result.status === 'recharge_required') {
      const body: RechargeRequiredBody = {
        rechargeRequired: true,
        rechargeIntentId: parsed.data.usageId,
        balanceCents: result.balanceCents.toString(),
        requiredCents: result.requiredCents.toString(),
      };
      reply.code(402).send(body);
      return reply;
    }
    // 202：user 消息已落库，生成在进程内异步跑；进展经 /stream 订阅。
    const message: MessageView = {
      id: result.userMessage.id,
      seq: result.userMessage.seq,
      ...(result.userMessage.turnId ? { turnId: result.userMessage.turnId } : {}),
      role: result.userMessage.role,
      content: result.userMessage.content,
      status: result.userMessage.status,
      createdAt: result.userMessage.createdAt,
    };
    const body: Envelope<{ message: MessageView; replayed: boolean }> = {
      data: { message, replayed: result.status === 'replayed' },
      meta: { traceId: req.id },
    };
    reply.code(202).send(body);
    return reply;
  };
}

// ───────────────────────────── POST /runtime/sessions/:id/interrupt ─────────────────────────────

export function interruptHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const session = await requireOwnedSession(req, reply);
    if (!session) return reply;

    // 无进行中的轮 → interrupted=false（幂等，不当错误）。
    const interrupted = await req.server.turns.interrupt(session.id);
    const body: Envelope<{ interrupted: boolean }> = {
      data: { interrupted },
      meta: { traceId: req.id },
    };
    reply.code(200).send(body);
    return reply;
  };
}
