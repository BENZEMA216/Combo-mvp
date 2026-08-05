import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { getCreationResumeTasksHandler } from '../modules/task/handlers.js';
import { createTask } from '../modules/task/service.js';
import { FakeDb } from './fakes.js';

const OWNER = 'user-resume';

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

interface ReplyDouble extends FastifyReply {
  code: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

function replyDouble(): ReplyDouble {
  const reply = {
    code: vi.fn(),
    send: vi.fn(),
  };
  reply.code.mockReturnValue(reply);
  reply.send.mockReturnValue(reply);
  return reply as unknown as ReplyDouble;
}

describe('GET /tasks/resume handler', () => {
  it('只做有界读取、不触发过期对账，并把旧 expired 任务作为可恢复项返回', async () => {
    const db = new FakeDb();
    const expired = await createTask(db, db, {
      ownerUserId: OWNER,
      idempotencyKey: 'resume-expired-idempotency',
    });
    const completed = await createTask(db, db, {
      ownerUserId: OWNER,
      idempotencyKey: 'resume-completed-idempotency',
    });
    if (expired.kind !== 'ok' || completed.kind !== 'ok') throw new Error('seed failed');
    db.tasks.get(expired.taskId)!.status = 'failed';
    db.tasks.get(expired.taskId)!.last_error = null;
    db.uploads.get(expired.taskId)!.status = 'expired';
    db.tasks.get(completed.taskId)!.status = 'succeeded';
    db.tasks.get(completed.taskId)!.updated_at = new Date(Date.now() + 1_000).toISOString();

    const originalQuery = db.query.bind(db);
    let reconciliationQueries = 0;
    db.query = (async (sql: string, params?: unknown[]) => {
      if (sql.replace(/\s+/g, ' ').trim().startsWith('WITH candidates AS MATERIALIZED')) {
        reconciliationQueries += 1;
      }
      return originalQuery(sql, params);
    }) as typeof db.query;

    const req = {
      auth: { userId: OWNER },
      id: 'trace-resume-handler',
      server: { infra: { db } },
      log: { error: vi.fn() },
    } as unknown as FastifyRequest;
    const reply = replyDouble();

    await (getCreationResumeTasksHandler() as Handler)(req, reply);

    expect(reconciliationQueries).toBe(0);
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send.mock.calls[0]?.[0]).toMatchObject({
      data: [
        {
          id: expired.taskId,
          status: 'failed',
          upload: { status: 'expired' },
        },
      ],
      meta: { traceId: 'trace-resume-handler' },
    });
  });
});
