// 任务域 HTTP handler：薄壳——校验入参、调 service/repo/pairing、包响应信封。
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  CreateTaskBodySchema,
  ConnectUploadBodySchema,
  ConnectPrepareBodySchema,
  DEFAULT_PAGE_LIMIT,
  ErrorCode,
  InvalidCursorError,
  MAX_PAGE_LIMIT,
  decodeIdCursor,
  encodeIdCursor,
  type CreateTaskResult,
  type Envelope,
  type Paginated,
  type TaskView,
} from '@cb/shared';
import { sendError } from '../../platform/http/_helpers.js';
import { asTxPool } from '../../platform/infra/db-tx.js';
import { createTask, reconcileExpiredUploadTasks, retryTask } from './service.js';
import { listCreationResumeTaskViews, listTaskViews, readTaskView } from './repo.js';
import { canFetchConnectScript, landPart, prepareUpload } from './pairing.js';
import { renderConnectScript, renderExpiredScript } from './connect-script.js';

/** 据请求头算对外 BASE（反代给 x-forwarded-proto/host；缺省回落请求自身）。 */
function resolveBase(req: FastifyRequest): string {
  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ||
    (req.protocol ?? 'https');
  const host =
    (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim() ||
    (req.headers.host as string | undefined) ||
    'localhost';
  return `${proto}://${host}`;
}

// ───────────────────────────── POST /tasks ─────────────────────────────

/** 建任务：返回 TaskView + 配对码（明文仅此一次）。幂等键重试回放同一任务（配对码轮换新发）。 */
export function createTaskHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);

    const parsed = CreateTaskBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);

    const db = req.server.infra.db;
    let outcome;
    try {
      outcome = await createTask(asTxPool(db), db, {
        ownerUserId: userId,
        idempotencyKey: parsed.data.idempotencyKey,
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      });
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'create task failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
    if (outcome.kind === 'conflict') return sendError(req, reply, ErrorCode.IDEMPOTENCY_CONFLICT);

    const view = await readTaskView(db, outcome.taskId, userId);
    if (!view) return sendError(req, reply, ErrorCode.INTERNAL);
    const result: CreateTaskResult = { task: view, pairingCode: outcome.pairingCode };
    const body: Envelope<CreateTaskResult> = { data: result, meta: { traceId: req.id } };
    reply.code(outcome.replayed ? 200 : 201).send(body);
    return reply;
  };
}

// ───────────────────────────── GET /tasks ─────────────────────────────

export function listTasksHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);

    const q = (req.query ?? {}) as { cursor?: string; limit?: string };
    const limitRaw = q.limit !== undefined ? Number(q.limit) : DEFAULT_PAGE_LIMIT;
    if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_PAGE_LIMIT) {
      return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
    }
    let cursorId: string | undefined;
    if (q.cursor !== undefined) {
      try {
        cursorId = decodeIdCursor(q.cursor);
      } catch (err) {
        if (err instanceof InvalidCursorError) {
          return sendError(req, reply, ErrorCode.VALIDATION_FAILED);
        }
        throw err;
      }
    }

    let page;
    try {
      // 读修复：旧 upload/running 若配对窗口已过，先持久化为 failed，再组装列表。
      // worker 也会周期对账；这里保证用户首次打开页面就拿到真实终态，不等下一轮后台巡查。
      await reconcileExpiredUploadTasks(req.server.infra.db, {
        ownerUserId: userId,
        traceId: req.id,
      });
      page = await listTaskViews(req.server.infra.db, {
        ownerUserId: userId,
        limit: limitRaw,
        ...(cursorId !== undefined ? { cursorId } : {}),
      });
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'list tasks failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }

    const last = page.items.at(-1);
    const body: Paginated<TaskView> = {
      data: page.items,
      meta: {
        traceId: req.id,
        page: {
          nextCursor: page.hasMore && last ? encodeIdCursor(last.id) : null,
          hasMore: page.hasMore,
          limit: limitRaw,
          order: 'desc',
        },
      },
    };
    reply.code(200).send(body);
    return reply;
  };
}

// ───────────────────────────── GET /tasks/resume ─────────────────────────────

/**
 * Shell 的恢复入口：一次有界只读查询，不翻页扫描用户的全部任务历史。
 * 有可操作任务时只返回这些任务；没有时返回最近一条，供异步结果验收。
 * 过期状态由 worker 的分钟级对账与任务列表/详情的读修复统一持久化，避免 Shell
 * 5 秒轮询同时触发全表状态修复。
 */
export function getCreationResumeTasksHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);

    let tasks: TaskView[];
    try {
      tasks = await listCreationResumeTaskViews(req.server.infra.db, {
        ownerUserId: userId,
        limit: 20,
      });
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'read creation resume tasks failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }

    const body: Envelope<TaskView[]> = { data: tasks, meta: { traceId: req.id } };
    reply.code(200).send(body);
    return reply;
  };
}

// ───────────────────────────── GET /tasks/:taskId ─────────────────────────────

export function getTaskHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const { taskId } = req.params as { taskId: string };

    let view: TaskView | null;
    try {
      await reconcileExpiredUploadTasks(req.server.infra.db, {
        ownerUserId: userId,
        taskId,
        traceId: req.id,
        limit: 1,
      });
      view = await readTaskView(req.server.infra.db, taskId, userId);
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'read task failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
    if (!view) return sendError(req, reply, ErrorCode.NOT_FOUND);
    const body: Envelope<TaskView> = { data: view, meta: { traceId: req.id } };
    reply.code(200).send(body);
    return reply;
  };
}

// ───────────────────────────── POST /tasks/:taskId/retry ─────────────────────────────

export function retryTaskHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const userId = req.auth?.userId;
    if (!userId) return sendError(req, reply, ErrorCode.UNAUTHENTICATED);
    const { taskId } = req.params as { taskId: string };

    let outcome;
    try {
      outcome = await retryTask(req.server.infra.db, req.server.infra.queue, {
        taskId,
        ownerUserId: userId,
        traceId: req.id,
      });
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'retry task failed');
      return sendError(req, reply, ErrorCode.INTERNAL);
    }
    if (outcome.kind === 'not_found') return sendError(req, reply, ErrorCode.NOT_FOUND);
    if (outcome.kind === 'not_retriable') {
      return sendError(req, reply, ErrorCode.STATE_CONFLICT, {
        userMessage: '只有失败的任务可以重试，刷新看看最新状态。',
      });
    }
    const body: Envelope<TaskView> = { data: outcome.view, meta: { traceId: req.id } };
    reply.code(200).send(body);
    return reply;
  };
}

// ───────────────────────────── GET /connect/script ─────────────────────────────

/**
 * 下发助手脚本（配对码 query 鉴权，无登录态）。码无效/过期 → 仍返回可读 stderr 文案的
 * 可执行脚本（`| sh` 通道不裸 JSON 错误体），HTTP 404。
 */
export function connectScriptHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const code = (req.query as { code?: string } | undefined)?.code;

    const sendExpired = (): FastifyReply => {
      reply
        .code(404)
        .header('content-type', 'text/x-shellscript; charset=utf-8')
        .send(renderExpiredScript());
      return reply;
    };

    if (typeof code !== 'string' || code.length === 0) return sendExpired();

    try {
      if (!(await canFetchConnectScript(req.server.infra.db, code))) return sendExpired();
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'connect script verify failed');
      // DB 异常也走脚本通道的人话 stderr（不裸 500 体）。
      return sendExpired();
    }

    reply
      .code(200)
      .header('content-type', 'text/x-shellscript; charset=utf-8')
      .send(renderConnectScript({ base: resolveBase(req), pairingCode: code }));
    return reply;
  };
}

// ───────────────────────────── POST /connect/upload ─────────────────────────────

export function connectPrepareHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const parsed = ConnectPrepareBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);

    let outcome;
    try {
      outcome = await prepareUpload(req.server.infra.db, parsed.data);
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'connect prepare failed');
      return sendError(req, reply, ErrorCode.DEPENDENCY_UNAVAILABLE, {
        userMessage: '系统暂时不可用，稍候重跑命令续传。',
      });
    }
    if (outcome.kind === 'invalid_code')
      return sendError(req, reply, ErrorCode.PAIRING_CODE_INVALID);
    if (outcome.kind === 'expired') return sendError(req, reply, ErrorCode.PAIRING_EXPIRED);
    if (outcome.kind === 'manifest_conflict') {
      return sendError(req, reply, ErrorCode.STATE_CONFLICT, {
        userMessage: '另一份上传快照正在续传，请关闭其它上传命令后重试。',
      });
    }
    const body: Envelope<typeof outcome.result> = {
      data: outcome.result,
      meta: { traceId: req.id },
    };
    reply.code(200).send(body);
    return reply;
  };
}

/** 助手分片上传（凭配对码鉴权，无登录态）。收齐自动流转提取（landPart 内完成）。 */
export function connectUploadHandler(): RouteHandlerMethod {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const parsed = ConnectUploadBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(req, reply, ErrorCode.VALIDATION_FAILED);

    const { db, objectStore, queue } = req.server.infra;
    let outcome;
    try {
      outcome = await landPart({ db, objectStore, queue }, { ...parsed.data, traceId: req.id });
    } catch (err) {
      req.log.error({ err, traceId: req.id }, 'connect upload failed');
      // 分片落桶/入队等基础设施异常：助手重跑命令即可续传。
      return sendError(req, reply, ErrorCode.DEPENDENCY_UNAVAILABLE, {
        userMessage: '系统暂时不可用，稍候重跑命令续传。',
      });
    }
    switch (outcome.kind) {
      case 'invalid_code':
        return sendError(req, reply, ErrorCode.PAIRING_CODE_INVALID);
      case 'expired':
        return sendError(req, reply, ErrorCode.PAIRING_EXPIRED);
      case 'bad_part':
        return sendError(req, reply, ErrorCode.VALIDATION_FAILED, {
          userMessage: '分片序号和总数对不上，重跑命令重新上传。',
        });
      default: {
        const body: Envelope<typeof outcome.result> = {
          data: outcome.result,
          meta: { traceId: req.id },
        };
        reply.code(200).send(body);
        return reply;
      }
    }
  };
}
