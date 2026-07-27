import { describe, expect, it } from 'vitest';
import {
  appendTurnMessage,
  archiveSession,
  createSession,
  getOrCreateStudioSession,
  getMessages,
  getSession,
  listSessions,
  SessionBusyError,
  updateSessionTitle,
} from '../modules/session/repo.js';
import { createTurn, finishTurnCas } from '../modules/agent/turn-repo.js';
import { FakeDb } from './fakes.js';

async function setup() {
  const db = new FakeDb();
  const cap = db.seedCapability({ owner_user_id: 'me' });
  const session = await createSession(db, { capabilityId: cap.id, ownerUserId: 'me' });
  return { db, session };
}

describe('按轮消息仓库', () => {
  it('按轮内位置写入并派生连续对外序号', async () => {
    const { db, session } = await setup();
    await createTurn(db, { id: 'turn-1', sessionId: session.id });
    await appendTurnMessage(db, {
      sessionId: session.id,
      turnId: 'turn-1',
      idx: 0,
      role: 'user',
      content: [{ type: 'text', text: '问题' }],
    });
    await appendTurnMessage(db, {
      sessionId: session.id,
      turnId: 'turn-1',
      idx: 1,
      role: 'assistant',
      content: [{ type: 'text', text: '回答' }],
    });
    await finishTurnCas(db, { id: 'turn-1', status: 'completed' });
    const messages = await getMessages(db, session.id);
    expect(messages.map((message) => [message.seq, message.turnId, message.turnStatus])).toEqual([
      [1, 'turn-1', 'completed'],
      [2, 'turn-1', 'completed'],
    ]);
  });

  it('拒绝不符合角色内容协议的消息', async () => {
    const { db, session } = await setup();
    await createTurn(db, { id: 'turn-1', sessionId: session.id });
    await expect(
      appendTurnMessage(db, {
        sessionId: session.id,
        turnId: 'turn-1',
        idx: 0,
        role: 'user',
        content: [{ type: 'bogus' }],
      }),
    ).rejects.toThrow();
  });

  it('首条用户消息派生标题', async () => {
    const { db, session } = await setup();
    await createTurn(db, { id: 'turn-1', sessionId: session.id });
    await appendTurnMessage(db, {
      sessionId: session.id,
      turnId: 'turn-1',
      idx: 0,
      role: 'user',
      content: [{ type: 'text', text: '这是会话标题' }],
    });
    expect(db.sessions.get(session.id)?.title).toBe('这是会话标题');
  });
});

describe('会话管理仓库', () => {
  it('普通运行与 Studio 分流；同一 owner + capability 原子复用 active Studio 会话', async () => {
    const { db, session: consume } = await setup();
    expect(consume.mode).toBe('consume');

    const studioA = await getOrCreateStudioSession(db, {
      capabilityId: consume.capabilityId,
      ownerUserId: 'me',
    });
    const studioB = await getOrCreateStudioSession(db, {
      capabilityId: consume.capabilityId,
      ownerUserId: 'me',
    });
    expect(studioA.mode).toBe('studio');
    expect(studioB.id).toBe(studioA.id);
    expect(db.sessions.size).toBe(2);

    expect((await listSessions(db, 'me', consume.capabilityId)).map((row) => row.id)).toEqual([
      consume.id,
    ]);
    expect(
      (await listSessions(db, 'me', consume.capabilityId, 'studio')).map((row) => row.id),
    ).toEqual([studioA.id]);
  });

  it('Studio 会话归档后可以为同一 Agent 建立新的 active 会话', async () => {
    const { db, session } = await setup();
    const first = await getOrCreateStudioSession(db, {
      capabilityId: session.capabilityId,
      ownerUserId: 'me',
    });
    await archiveSession(db, first.id, 'me');
    const next = await getOrCreateStudioSession(db, {
      capabilityId: session.capabilityId,
      ownerUserId: 'me',
    });
    expect(next.id).not.toBe(first.id);
    expect(next.mode).toBe('studio');
  });

  it('改名和归档都按 owner 隔离', async () => {
    const { db, session } = await setup();

    await expect(updateSessionTitle(db, session.id, 'other', '别人的名字')).resolves.toBeNull();
    await expect(archiveSession(db, session.id, 'other')).resolves.toBeNull();
    expect(db.sessions.get(session.id)?.title).toBeNull();
    expect(db.sessions.get(session.id)?.status).toBe('active');

    const renamed = await updateSessionTitle(db, session.id, 'me', '我的方案');
    expect(renamed?.title).toBe('我的方案');

    const archived = await archiveSession(db, session.id, 'me');
    expect(archived?.status).toBe('closed');
  });

  it('默认列表不返回已归档会话', async () => {
    const { db, session } = await setup();
    const second = await createSession(db, {
      capabilityId: session.capabilityId,
      ownerUserId: 'me',
    });
    await archiveSession(db, session.id, 'me');

    const listed = await listSessions(db, 'me', session.capabilityId);
    expect(listed.map((item) => item.id)).toEqual([second.id]);
  });

  it('运行中会话不能归档，轮次结束后才能原子转为 closed', async () => {
    const { db, session } = await setup();
    await createTurn(db, { id: 'turn-running', sessionId: session.id });

    await expect(archiveSession(db, session.id, 'me')).rejects.toBeInstanceOf(SessionBusyError);
    expect(db.sessions.get(session.id)?.status).toBe('active');

    await finishTurnCas(db, { id: 'turn-running', status: 'completed' });
    await expect(archiveSession(db, session.id, 'me')).resolves.toMatchObject({ status: 'closed' });
    expect(db.queries.some((query) => query.includes("status = 'active' FOR UPDATE"))).toBe(true);
  });

  it('已归档会话不能再次改名、归档或进入运行入口', async () => {
    const { db, session } = await setup();
    await archiveSession(db, session.id, 'me');

    await expect(getSession(db, session.id, 'me')).resolves.toBeNull();
    await expect(updateSessionTitle(db, session.id, 'me', '复活')).resolves.toBeNull();
    await expect(archiveSession(db, session.id, 'me')).resolves.toBeNull();
  });
});
