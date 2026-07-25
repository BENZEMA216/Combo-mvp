import { describe, expect, it, vi } from 'vitest';
import { readSessionDetailDbSnapshot } from '../modules/session/detail.js';
import { createSession } from '../modules/session/repo.js';
import type { RuntimeDb, TxConn } from '../platform/infra/db.js';
import { FakeDb } from './fakes.js';

describe('Session 详情数据库快照', () => {
  it('只在一个 REPEATABLE READ READ ONLY 连接中重验 owner 并读取全部状态', async () => {
    const source = new FakeDb();
    const capability = source.seedCapability({ owner_user_id: 'owner-1' });
    const session = await createSession(source, {
      capabilityId: capability.id,
      ownerUserId: 'owner-1',
    });
    source.queries.length = 0;
    source.txLog.length = 0;

    const poolQuery = vi.fn(async () => {
      throw new Error('detail snapshot must not query through the pool');
    });
    const release = vi.fn();
    const db: RuntimeDb = {
      query: poolQuery,
      async connect(): Promise<TxConn> {
        return {
          query: <R>(sql: string, params?: unknown[]) => source.query<R>(sql, params),
          release,
        };
      },
    };

    const snapshot = await readSessionDetailDbSnapshot(db, {
      sessionId: session.id,
      ownerUserId: 'owner-1',
    });

    expect(snapshot?.session.id).toBe(session.id);
    expect(poolQuery).not.toHaveBeenCalled();
    expect(source.txLog).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT']);
    expect(source.queries[1]).toContain('FROM sessions WHERE id = $1 AND owner_user_id = $2');
    expect(release).toHaveBeenCalledOnce();
  });

  it('在同一快照内 owner 不匹配时返回 null，且不继续读消息或产物', async () => {
    const db = new FakeDb();
    const capability = db.seedCapability({ owner_user_id: 'owner-1' });
    const session = await createSession(db, {
      capabilityId: capability.id,
      ownerUserId: 'owner-1',
    });
    db.queries.length = 0;
    db.txLog.length = 0;

    await expect(
      readSessionDetailDbSnapshot(db, {
        sessionId: session.id,
        ownerUserId: 'owner-2',
      }),
    ).resolves.toBeNull();

    expect(db.txLog).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT']);
    expect(db.queries).toHaveLength(3);
    expect(db.queries[1]).toContain('owner_user_id = $2');
  });
});
