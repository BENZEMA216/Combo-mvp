import { describe, expect, it } from 'vitest';
import { createSession, SessionBusyError } from '../modules/session/repo.js';
import {
  createTurn,
  finishTurnCas,
  getLatestTerminalTurn,
  hasRunningTurn,
  sweepExpiredTurns,
} from '../modules/agent/turn-repo.js';
import { FakeDb } from './fakes.js';

async function seedSession(db: FakeDb): Promise<string> {
  const cap = db.seedCapability({ owner_user_id: 'me' });
  return (await createSession(db, { capabilityId: cap.id, ownerUserId: 'me' })).id;
}

describe('turn repo', () => {
  it('裸插 running 轮并查询运行态', async () => {
    const db = new FakeDb();
    const sessionId = await seedSession(db);
    const turn = await createTurn(db, { id: 'turn-1', sessionId });
    expect(turn).toMatchObject({ id: 'turn-1', sessionId, status: 'running', finishedAt: null });
    expect(await hasRunningTurn(db, sessionId)).toBe(true);
    expect(db.queries.find((q) => q.startsWith('INSERT INTO turns'))).not.toContain('SELECT');
  });

  it('只把目标部分唯一索引冲突映射成 SessionBusyError', async () => {
    const targetDb = {
      query: async () =>
        Promise.reject(
          Object.assign(new Error('duplicate'), {
            code: '23505',
            constraint: 'uq_turns_session_running',
          }),
        ),
    };
    await expect(
      createTurn(targetDb, { id: 'turn-1', sessionId: 'session-1' }),
    ).rejects.toBeInstanceOf(SessionBusyError);

    const otherError = Object.assign(new Error('other duplicate'), {
      code: '23505',
      constraint: 'another_unique_constraint',
    });
    const otherDb = { query: async () => Promise.reject(otherError) };
    await expect(createTurn(otherDb, { id: 'turn-2', sessionId: 'session-1' })).rejects.toBe(
      otherError,
    );
  });

  it('收尾 CAS 只有第一次成功', async () => {
    const db = new FakeDb();
    const sessionId = await seedSession(db);
    await createTurn(db, { id: 'turn-1', sessionId });
    expect(await finishTurnCas(db, { id: 'turn-1', status: 'completed' })).toBe(true);
    expect(await finishTurnCas(db, { id: 'turn-1', status: 'failed' })).toBe(false);
    expect(await hasRunningTurn(db, sessionId)).toBe(false);
    expect(db.turns.get('turn-1')?.status).toBe('completed');
  });

  it('清扫只处理 cutoff 前的 running 轮并写一条 failed 消息', async () => {
    const db = new FakeDb();
    const sessionId = await seedSession(db);
    const freshSessionId = await seedSession(db);
    const doneSessionId = await seedSession(db);
    await createTurn(db, { id: 'old', sessionId });
    await createTurn(db, { id: 'fresh', sessionId: freshSessionId });
    await createTurn(db, { id: 'done', sessionId: doneSessionId });
    db.turns.get('old')!.created_at = '2026-01-01T00:00:00.000Z';
    db.turns.get('fresh')!.created_at = '2026-01-03T00:00:00.000Z';
    db.turns.get('done')!.created_at = '2026-01-01T00:00:00.000Z';
    await finishTurnCas(db, { id: 'done', status: 'completed' });
    db.messages.push({
      id: 'partial',
      session_id: sessionId,
      turn_id: 'old',
      idx: 4,
      seq: null,
      role: 'assistant',
      content: [{ type: 'text', text: 'partial' }],
      status: 'completed',
      created_at: '2026-01-01T00:01:00.000Z',
    });
    let statusBeforeFinish: string | undefined;
    let queriesBeforeFinish: string[] = [];
    const swept = await sweepExpiredTurns(db, new Date('2026-01-02T00:00:00.000Z'), {
      beforeFinish: async () => {
        statusBeforeFinish = db.turns.get('old')?.status;
        queriesBeforeFinish = [...db.queries];
      },
    });
    expect(swept).toEqual([
      {
        id: 'old',
        sessionId,
        status: 'failed',
        lastError: {
          code: 'TURN_ABANDONED',
          message: '轮次运行超时，已由清扫器终止。',
        },
      },
    ]);
    expect(statusBeforeFinish).toBe('running');
    expect(queriesBeforeFinish).toEqual(
      expect.arrayContaining([
        'SELECT id FROM sessions WHERE id = $1 FOR UPDATE',
        "SELECT id FROM turns WHERE id = $1 AND session_id = $2 AND status = 'running' FOR UPDATE",
      ]),
    );
    expect(
      queriesBeforeFinish.some((query) => query.startsWith("UPDATE turns SET status = 'failed'")),
    ).toBe(false);
    expect(db.turns.get('old')).toMatchObject({
      status: 'failed',
      last_error: { code: 'TURN_ABANDONED' },
    });
    expect(db.turns.get('fresh')?.status).toBe('running');
    expect(db.turns.get('done')?.status).toBe('completed');
    expect(db.messages.filter((m) => m.turn_id === 'old' && m.status === 'failed')).toMatchObject([
      { idx: 5 },
    ]);
    const sessionLock = db.queries.lastIndexOf('SELECT id FROM sessions WHERE id = $1 FOR UPDATE');
    const terminalUpdate = db.queries.findIndex((query, index) =>
      index > sessionLock ? query.startsWith("UPDATE turns SET status = 'failed'") : false,
    );
    expect(sessionLock).toBeGreaterThan(-1);
    expect(terminalUpdate).toBeGreaterThan(sessionLock);
  });

  it('Session 锁内可读取最近已提交终态及其持久错误', async () => {
    const db = new FakeDb();
    const sessionId = await seedSession(db);
    await createTurn(db, { id: 'turn-1', sessionId });
    await finishTurnCas(db, {
      id: 'turn-1',
      status: 'interrupted',
      lastError: { code: 'TURN_FAILED', message: '本轮生成已打断。' },
    });
    expect(await getLatestTerminalTurn(db, sessionId)).toEqual({
      id: 'turn-1',
      sessionId,
      status: 'interrupted',
      lastError: { code: 'TURN_FAILED', message: '本轮生成已打断。' },
    });
  });

  it('迟到收尾与清扫交错时只有 CAS 胜者生效且消息不重复', async () => {
    const db = new FakeDb();
    const sessionId = await seedSession(db);
    await createTurn(db, { id: 'turn-1', sessionId });
    db.turns.get('turn-1')!.created_at = '2026-01-01T00:00:00.000Z';
    const [finished, swept] = await Promise.all([
      finishTurnCas(db, { id: 'turn-1', status: 'completed' }),
      sweepExpiredTurns(db, new Date('2026-01-02T00:00:00.000Z')),
    ]);
    expect(Number(finished) + swept.length).toBe(1);
    expect(
      db.messages.filter((m) => m.turn_id === 'turn-1' && m.status === 'failed').length,
    ).toBeLessThanOrEqual(1);
  });
});
