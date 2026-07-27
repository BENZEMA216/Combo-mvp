import { EventType } from '@ag-ui/core';
import type { CapabilityDefinition } from '@cb/shared';
import { describe, expect, it, vi } from 'vitest';
import { createTurnRunner, type TurnAgentFactory } from '../modules/agent/run-turn.js';
import { createTurn, finishTurnCas, TURN_ABANDON_AFTER_MS } from '../modules/agent/turn-repo.js';
import { appendTurnMessage, createSession, SessionBusyError } from '../modules/session/repo.js';
import { createSessionEventBus } from '../platform/infra/event-bus.js';
import { createInterruptBus, type InterruptBus } from '../platform/infra/redis-interrupt-bus.js';
import type { SandboxBackend } from '../platform/infra/sandbox-backend.js';
import {
  FakeDb,
  FakeObjectStore,
  FakeSessionEventLog,
  makeFakeAgentFactory,
  silentLog,
  waitFor,
} from './fakes.js';

const definition: CapabilityDefinition = {
  version: 1,
  name: '测试',
  summary: '测试',
  kind: 'writing',
  instructions: '测试',
  inputs: [],
  starterPrompts: [],
  meta: {},
};

async function setup(
  factory: TurnAgentFactory,
  interrupts: InterruptBus = createInterruptBus(),
  sweepIntervalMs?: number,
) {
  const db = new FakeDb();
  const cap = db.seedCapability({ owner_user_id: 'me' });
  const session = await createSession(db, { capabilityId: cap.id, ownerUserId: 'me' });
  const eventLog = new FakeSessionEventLog();
  const objectStore = new FakeObjectStore();
  const runner = createTurnRunner({
    db,
    objectStore,
    bus: createSessionEventBus(),
    eventLog,
    agentFactory: factory,
    idleTimeoutMs: 60_000,
    interrupts,
    sweepIntervalMs,
    log: silentLog,
  });
  return { db, session, eventLog, objectStore, runner };
}

const waitDone = (db: FakeDb) =>
  waitFor(() => [...db.turns.values()].every((turn) => turn.status !== 'running'));

function cleanupSandbox(): SandboxBackend {
  return {
    enabled: true,
    describe: async () => Promise.reject(new Error('not used')),
    read: async () => Promise.reject(new Error('not used')),
    write: async () => Promise.reject(new Error('not used')),
    edit: async () => Promise.reject(new Error('not used')),
    command: async () => Promise.reject(new Error('not used')),
    interruptSession: async () => undefined,
    releaseSession: async () => undefined,
    dispose: async () => undefined,
  };
}

describe('单会话单运行轮次控制', () => {
  it('同会话并发提交只有一轮 started，另一轮精确映射为 SessionBusyError', async () => {
    const handle = makeFakeAgentFactory({ hangUntilAbort: true });
    const { db, session, runner } = await setup(handle.factory);
    const results = await Promise.allSettled([
      runner.startTurn({ session, definition, text: 'a', log: silentLog }),
      runner.startTurn({ session, definition, text: 'b', log: silentLog }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' ? rejected.reason : undefined).toBeInstanceOf(
      SessionBusyError,
    );
    expect(db.turns.size).toBe(1);
    expect(await runner.interrupt(session.id)).toBe(true);
    await waitDone(db);
    await runner.dispose();
  });

  it('打断会等待开轮提交，并在等待后重新读取刚发布的本地句柄', async () => {
    const handle = makeFakeAgentFactory({ hangUntilAbort: true });
    const { db, session, runner } = await setup(handle.factory);
    const originalConnect = db.connect.bind(db);
    let connectionSequence = 0;
    let lockOwner: number | undefined;
    let releaseRowLock: (() => void) | undefined;
    let rowLockReleased = Promise.resolve();
    let markTurnInsertReached!: () => void;
    const turnInsertReached = new Promise<void>((resolve) => {
      markTurnInsertReached = resolve;
    });
    let releaseTurnInsert!: () => void;
    const turnInsertReleased = new Promise<void>((resolve) => {
      releaseTurnInsert = resolve;
    });
    db.connect = async () => {
      const connection = await originalConnect();
      const id = ++connectionSequence;
      let ownsRowLock = false;
      const releaseOwnedRowLock = (): void => {
        if (!ownsRowLock) return;
        lockOwner = undefined;
        ownsRowLock = false;
        releaseRowLock?.();
      };
      return {
        query: async <R = Record<string, unknown>>(
          sql: string,
          params?: unknown[],
          signal?: AbortSignal,
        ) => {
          const normalized = sql.replace(/\s+/g, ' ').trim();
          if (normalized.includes('FROM sessions') && normalized.endsWith('FOR UPDATE')) {
            while (lockOwner !== undefined && lockOwner !== id) await rowLockReleased;
            if (lockOwner === undefined) {
              lockOwner = id;
              ownsRowLock = true;
              rowLockReleased = new Promise<void>((resolve) => {
                releaseRowLock = resolve;
              });
            }
          }
          if (normalized.startsWith('INSERT INTO turns') && id === 1) {
            // startTurn already owns the Session row but has not reached active.set.
            // interrupt must not retain an undefined handle captured at this point.
            markTurnInsertReached();
            await turnInsertReleased;
          }
          const result = await connection.query<R>(sql, params, signal);
          if (normalized === 'COMMIT' || normalized === 'ROLLBACK') releaseOwnedRowLock();
          return result;
        },
        release: (destroy?: boolean) => {
          // Destroying an aborted PostgreSQL connection releases its row locks even
          // though no explicit ROLLBACK can safely be sent on that transport.
          releaseOwnedRowLock();
          connection.release(destroy);
        },
      };
    };

    const starting = runner.startTurn({ session, definition, text: 'go', log: silentLog });
    await turnInsertReached;
    let interruptSettled = false;
    const interrupting = runner.interrupt(session.id).then((value) => {
      interruptSettled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(interruptSettled).toBe(false);

    releaseTurnInsert();
    await starting;
    expect(await interrupting).toBe(true);
    await waitDone(db);
    await runner.dispose();
  });

  it('关闭会栅栏已过入口但尚未发布 active 句柄的开轮事务', async () => {
    const handle = makeFakeAgentFactory({ hangUntilAbort: true });
    const { db, session, eventLog, runner } = await setup(handle.factory);
    const originalConnect = db.connect.bind(db);
    let markTurnInsertReached!: () => void;
    const turnInsertReached = new Promise<void>((resolve) => {
      markTurnInsertReached = resolve;
    });
    let releaseTurnInsert!: () => void;
    const turnInsertReleased = new Promise<void>((resolve) => {
      releaseTurnInsert = resolve;
    });
    let blocked = false;
    db.connect = async () => {
      const connection = await originalConnect();
      return {
        query: async <R = Record<string, unknown>>(
          sql: string,
          params?: unknown[],
          signal?: AbortSignal,
        ) => {
          const normalized = sql.replace(/\s+/g, ' ').trim();
          if (!blocked && normalized.startsWith('INSERT INTO turns')) {
            blocked = true;
            markTurnInsertReached();
            await turnInsertReleased;
          }
          return connection.query<R>(sql, params, signal);
        },
        release: (destroy?: boolean) => connection.release(destroy),
      };
    };

    const starting = runner.startTurn({ session, definition, text: 'go', log: silentLog });
    await turnInsertReached;
    let disposed = false;
    const disposing = runner.dispose().then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(disposed).toBe(false);

    releaseTurnInsert();
    const [startResult] = await Promise.allSettled([starting]);
    await disposing;
    expect(startResult?.status).toBe('rejected');
    expect(startResult?.status === 'rejected' ? String(startResult.reason) : undefined).toContain(
      'turn runner is shutting down',
    );
    expect(handle.calls).toHaveLength(0);
    expect([...db.turns.values()].every((turn) => turn.status !== 'running')).toBe(true);
    expect(
      eventLog.entries(session.id).some((entry) => entry.event.type === EventType.RUN_STARTED),
    ).toBe(false);
  });

  it('关闭会接管已经提交但尚未返回的开轮，并且不会启动 Pi', async () => {
    const handle = makeFakeAgentFactory({ hangUntilAbort: true });
    const { db, session, eventLog, runner } = await setup(handle.factory);
    const originalConnect = db.connect.bind(db);
    let markCommitApplied!: () => void;
    const commitApplied = new Promise<void>((resolve) => {
      markCommitApplied = resolve;
    });
    let releaseCommitResponse!: () => void;
    const commitResponseReleased = new Promise<void>((resolve) => {
      releaseCommitResponse = resolve;
    });
    let blocked = false;
    db.connect = async () => {
      const connection = await originalConnect();
      return {
        query: async <R = Record<string, unknown>>(
          sql: string,
          params?: unknown[],
          signal?: AbortSignal,
        ) => {
          const normalized = sql.replace(/\s+/g, ' ').trim();
          const result = await connection.query<R>(sql, params, signal);
          if (!blocked && normalized === 'COMMIT') {
            blocked = true;
            markCommitApplied();
            await commitResponseReleased;
          }
          return result;
        },
        release: (destroy?: boolean) => connection.release(destroy),
      };
    };

    const starting = runner.startTurn({ session, definition, text: 'go', log: silentLog });
    await commitApplied;
    const disposing = runner.dispose();
    releaseCommitResponse();
    const [startResult] = await Promise.allSettled([starting]);
    await disposing;

    expect(startResult?.status).toBe('rejected');
    expect(handle.calls).toHaveLength(0);
    expect([...db.turns.values()].map((turn) => turn.status)).toEqual(['interrupted']);
    expect(
      eventLog.entries(session.id).some((entry) => entry.event.type === EventType.RUN_STARTED),
    ).toBe(false);
    expect(eventLog.entries(session.id).at(-1)?.event.type).toBe(EventType.RUN_ERROR);
  });

  it('成功收尾写 completed、连续 idx 与 RUN_FINISHED', async () => {
    const handle = makeFakeAgentFactory({
      finalMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
    });
    const { db, session, eventLog, runner } = await setup(handle.factory);
    await runner.startTurn({ session, definition, text: 'go', log: silentLog });
    await waitDone(db);
    expect([...db.turns.values()][0]?.status).toBe('completed');
    expect(db.messages.map((message) => message.idx)).toEqual([0, 1]);
    expect(eventLog.entries(session.id).at(-1)?.event.type).toBe(EventType.RUN_FINISHED);
    await runner.dispose();
  });

  it('下一轮会用持久错误码幂等确认历史清扫终态后再写 RUN_STARTED', async () => {
    const handle = makeFakeAgentFactory({
      finalMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
    });
    const { db, session, eventLog, runner } = await setup(handle.factory);
    await createTurn(db, { id: 'swept-before-upgrade', sessionId: session.id });
    await finishTurnCas(db, {
      id: 'swept-before-upgrade',
      status: 'failed',
      lastError: { code: 'TURN_ABANDONED', message: '轮次运行超时，已由清扫器终止。' },
    });
    const oldTerminalId = await eventLog.appendTerminal(session.id, 'swept-before-upgrade', {
      type: EventType.RUN_ERROR,
      threadId: session.id,
      runId: 'swept-before-upgrade',
      message: '服务异常中断,本轮已终止,请重试。',
    });

    await runner.startTurn({ session, definition, text: 'next', log: silentLog });
    await waitDone(db);
    const entries = eventLog.entries(session.id);
    expect(entries.filter((entry) => entry.event.runId === 'swept-before-upgrade')).toHaveLength(1);
    const nextStarted = entries.find(
      (entry) =>
        entry.event.runId !== 'swept-before-upgrade' && entry.event.type === EventType.RUN_STARTED,
    );
    expect(nextStarted).toBeTruthy();
    expect(entries.findIndex((entry) => entry.id === oldTerminalId)).toBeLessThan(
      entries.findIndex((entry) => entry.id === nextStarted!.id),
    );
    await runner.dispose();
  });

  it('下一轮以数据库终态修正遗留冲突标记，未知错误码不会泄露内部消息', async () => {
    const handle = makeFakeAgentFactory({
      finalMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
    });
    const { db, session, eventLog, runner } = await setup(handle.factory);
    const legacyRunId = 'legacy-conflicting-terminal';
    await createTurn(db, { id: legacyRunId, sessionId: session.id });
    const wrongTerminalId = await eventLog.appendTerminal(session.id, legacyRunId, {
      type: EventType.RUN_FINISHED,
      threadId: session.id,
      runId: legacyRunId,
    });
    const internalMessage = 'duplicate key value violates secret_internal_index';
    await finishTurnCas(db, {
      id: legacyRunId,
      status: 'failed',
      lastError: { code: 'SUBMIT_FAILED', message: internalMessage },
    });

    await runner.startTurn({ session, definition, text: 'next', log: silentLog });
    await waitDone(db);
    const entries = eventLog.entries(session.id);
    const repaired = entries.filter((entry) => entry.event.runId === legacyRunId);
    expect(repaired).toHaveLength(1);
    expect(repaired[0]?.id).not.toBe(wrongTerminalId);
    expect(repaired[0]?.event).toMatchObject({
      type: EventType.RUN_ERROR,
      threadId: session.id,
      runId: legacyRunId,
      message: '服务异常中断,本轮已终止,请重试。',
    });
    expect(JSON.stringify(repaired)).not.toContain(internalMessage);
    await expect(
      eventLog.appendTerminal(session.id, legacyRunId, {
        type: EventType.RUN_FINISHED,
        threadId: session.id,
        runId: legacyRunId,
      }),
    ).rejects.toThrow('TERMINAL_EVENT_CONFLICT');
    const nextStarted = entries.find(
      (entry) => entry.event.runId !== legacyRunId && entry.event.type === EventType.RUN_STARTED,
    );
    expect(nextStarted).toBeTruthy();
    expect(entries.findIndex((entry) => entry.id === repaired[0]!.id)).toBeLessThan(
      entries.findIndex((entry) => entry.id === nextStarted!.id),
    );
    await runner.dispose();
  });

  it('本地打断走执行句柄快路径，不发布广播', async () => {
    const inner = createInterruptBus();
    const publish = vi.fn((sessionId: string) => inner.publish(sessionId));
    const interrupts: InterruptBus = { publish, subscribe: (cb) => inner.subscribe(cb) };
    const handle = makeFakeAgentFactory({ hangUntilAbort: true });
    const { db, session, runner } = await setup(handle.factory, interrupts);
    await runner.startTurn({ session, definition, text: 'go', log: silentLog });
    expect(await runner.interrupt(session.id)).toBe(true);
    await waitDone(db);
    expect(publish).not.toHaveBeenCalled();
    await runner.dispose();
  });

  it('跨实例广播打断真正执行轮次', async () => {
    const interrupts = createInterruptBus();
    const handle = makeFakeAgentFactory({ deltas: ['部分'], hangUntilAbort: true });
    const a = await setup(handle.factory, interrupts);
    const b = createTurnRunner({
      db: a.db,
      objectStore: new FakeObjectStore(),
      bus: createSessionEventBus(),
      eventLog: a.eventLog,
      agentFactory: makeFakeAgentFactory().factory,
      idleTimeoutMs: 60_000,
      interrupts,
      sandbox: cleanupSandbox(),
      log: silentLog,
    });
    await a.runner.startTurn({ session: a.session, definition, text: 'go', log: silentLog });
    await waitFor(() => handle.calls.length === 1);
    expect(await b.interrupt(a.session.id)).toBe(true);
    await waitDone(a.db);
    expect([...a.db.turns.values()][0]?.status).toBe('interrupted');
    expect(a.db.messages.find((message) => message.role === 'assistant')?.status).toBe('failed');
    await a.runner.dispose();
    await b.dispose();
  });

  it('跨副本终态提交后，丢失广播的旧 Pi 不能再追加文本事件', async () => {
    let release!: () => void;
    const continuePrompt = new Promise<void>((resolve) => {
      release = resolve;
    });
    const listeners = new Set<(delta: string) => void>();
    const ownerFactory: TurnAgentFactory = () => ({
      subscribeTextDelta(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      async prompt() {
        await continuePrompt;
        for (const listener of listeners) listener('不应出现');
      },
      abort: () => undefined,
      transcript: () => [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [{ type: 'text', text: '不应出现' }] },
      ],
      runtimeError: () => undefined,
    });
    const owner = await setup(ownerFactory, createInterruptBus());
    await owner.runner.startTurn({
      session: owner.session,
      definition,
      text: 'go',
      log: silentLog,
    });
    await waitFor(() =>
      owner.eventLog
        .entries(owner.session.id)
        .some((entry) => entry.event.type === EventType.RUN_STARTED),
    );

    const peer = createTurnRunner({
      db: owner.db,
      objectStore: new FakeObjectStore(),
      bus: createSessionEventBus(),
      eventLog: owner.eventLog,
      agentFactory: makeFakeAgentFactory().factory,
      idleTimeoutMs: 60_000,
      interrupts: createInterruptBus(),
      sandbox: cleanupSandbox(),
      log: silentLog,
    });
    expect(await peer.interrupt(owner.session.id)).toBe(true);
    expect([...owner.db.turns.values()][0]?.status).toBe('interrupted');
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const types = owner.eventLog.entries(owner.session.id).map((entry) => entry.event.type);
    expect(types).toContain(EventType.RUN_ERROR);
    expect(types).not.toContain(EventType.TEXT_MESSAGE_START);
    expect(types).not.toContain(EventType.TEXT_MESSAGE_CONTENT);
    await peer.dispose();
    await owner.runner.dispose();
  });

  it('跨副本终态后，丢失广播的迟到 Artifact 与文本都不能提交', async () => {
    let markUploadStarted!: () => void;
    const uploadStarted = new Promise<void>((resolve) => {
      markUploadStarted = resolve;
    });
    let releaseUpload!: () => void;
    const uploadReleased = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    let markPromptFinished!: () => void;
    const promptFinished = new Promise<void>((resolve) => {
      markPromptFinished = resolve;
    });
    const listeners = new Set<(delta: string) => void>();
    const ownerFactory: TurnAgentFactory = (input) => ({
      subscribeTextDelta(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      async prompt() {
        const artifact = input.tools.find((tool) => tool.name === 'upsert_artifact') as unknown as {
          execute(callId: string, params: Record<string, unknown>): Promise<unknown>;
        };
        try {
          await artifact.execute('late-artifact', {
            kind: 'markdown',
            title: '迟到产物',
            content: 'secret',
          });
        } catch {
          // 终态守卫应把迟到工具收口成 AbortError；继续模拟旧 Pi 的迟到文本。
        }
        for (const listener of listeners) listener('不应出现');
        markPromptFinished();
      },
      abort: () => undefined,
      transcript: () => [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [{ type: 'text', text: '不应出现' }] },
      ],
      runtimeError: () => undefined,
    });
    const owner = await setup(ownerFactory, createInterruptBus());
    const putObject = owner.objectStore.putObject.bind(owner.objectStore);
    owner.objectStore.putObject = async (bucket, key, body, options) => {
      markUploadStarted();
      await uploadReleased;
      return putObject(bucket, key, body, options);
    };
    await owner.runner.startTurn({
      session: owner.session,
      definition,
      text: 'go',
      log: silentLog,
    });
    await uploadStarted;

    const peer = createTurnRunner({
      db: owner.db,
      objectStore: new FakeObjectStore(),
      bus: createSessionEventBus(),
      eventLog: owner.eventLog,
      agentFactory: makeFakeAgentFactory().factory,
      idleTimeoutMs: 60_000,
      // 独立总线故意丢掉对 owner 的中断广播。
      interrupts: createInterruptBus(),
      sandbox: cleanupSandbox(),
      log: silentLog,
    });
    expect(await peer.interrupt(owner.session.id)).toBe(true);
    expect([...owner.db.turns.values()][0]?.status).toBe('interrupted');

    releaseUpload();
    await promptFinished;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(owner.db.artifacts.size).toBe(0);
    const types = owner.eventLog.entries(owner.session.id).map((entry) => entry.event.type);
    expect(types.at(-1)).toBe(EventType.RUN_ERROR);
    expect(types).not.toContain(EventType.STATE_DELTA);
    expect(types).not.toContain(EventType.TEXT_MESSAGE_START);
    expect(types).not.toContain(EventType.TEXT_MESSAGE_CONTENT);

    await peer.dispose();
    await owner.runner.dispose();
  });

  it('功能关闭的副本在广播丢失时不能替外部 owner 释放 running Turn', async () => {
    const ownerHandle = makeFakeAgentFactory({ hangUntilAbort: true });
    const owner = await setup(ownerHandle.factory, createInterruptBus());
    await owner.runner.startTurn({
      session: owner.session,
      definition,
      text: 'go',
      log: silentLog,
    });
    await waitFor(() => ownerHandle.calls.length === 1);

    const disabledPeer = createTurnRunner({
      db: owner.db,
      objectStore: new FakeObjectStore(),
      bus: createSessionEventBus(),
      eventLog: owner.eventLog,
      agentFactory: makeFakeAgentFactory().factory,
      idleTimeoutMs: 60_000,
      // 独立内存总线模拟 Redis 通知丢失。
      interrupts: createInterruptBus(),
      log: silentLog,
    });
    await expect(disabledPeer.interrupt(owner.session.id)).rejects.toMatchObject({
      code: 'cleanup_unconfirmed',
    });
    expect([...owner.db.turns.values()][0]?.status).toBe('running');

    await disabledPeer.dispose();
    expect(await owner.runner.interrupt(owner.session.id)).toBe(true);
    await waitDone(owner.db);
    await owner.runner.dispose();
  });

  it('跨实例远程清理黑洞会按硬超时回滚并保留 running Turn', async () => {
    const handle = makeFakeAgentFactory({ hangUntilAbort: true });
    const a = await setup(handle.factory);
    await a.runner.startTurn({ session: a.session, definition, text: 'go', log: silentLog });
    await waitFor(() => handle.calls.length === 1);

    const sandbox: SandboxBackend = {
      enabled: true,
      describe: async () => Promise.reject(new Error('not used')),
      read: async () => Promise.reject(new Error('not used')),
      write: async () => Promise.reject(new Error('not used')),
      edit: async () => Promise.reject(new Error('not used')),
      command: async () => Promise.reject(new Error('not used')),
      interruptSession: async () => new Promise<void>(() => undefined),
      releaseSession: async () => undefined,
      dispose: async () => undefined,
    };
    const b = createTurnRunner({
      db: a.db,
      objectStore: new FakeObjectStore(),
      bus: createSessionEventBus(),
      eventLog: a.eventLog,
      agentFactory: makeFakeAgentFactory().factory,
      idleTimeoutMs: 60_000,
      interrupts: createInterruptBus(),
      sandbox,
      sandboxCleanupTimeoutMs: 20,
      log: silentLog,
    });
    const started = Date.now();
    await expect(b.interrupt(a.session.id)).rejects.toThrow('cleanup timed out');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect([...a.db.turns.values()][0]?.status).toBe('running');
    expect(a.db.txLog).toContain('ROLLBACK');

    await b.dispose();
    expect(await a.runner.interrupt(a.session.id)).toBe(true);
    await waitDone(a.db);
    await a.runner.dispose();
  });

  it('清扫抢先后正常收尾静默，不重复终态帧', async () => {
    let release!: () => void;
    const prompt = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory: TurnAgentFactory = () => ({
      subscribeTextDelta: () => () => undefined,
      prompt: () => prompt,
      abort: () => undefined,
      transcript: () => [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      ],
      runtimeError: () => undefined,
    });
    const { db, session, eventLog, runner } = await setup(factory);
    await runner.startTurn({ session, definition, text: 'go', log: silentLog });
    const turn = [...db.turns.values()][0];
    expect(turn).toBeTruthy();
    await finishTurnCas(db, { id: turn!.id, status: 'failed' });
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(db.messages.filter((message) => message.role === 'assistant')).toHaveLength(0);
    const terminal = eventLog
      .entries(session.id)
      .filter(
        (entry) =>
          entry.event.type === EventType.RUN_FINISHED || entry.event.type === EventType.RUN_ERROR,
      );
    expect(terminal).toHaveLength(0);
    await runner.dispose();
  });

  it('清扫循环写失败消息与 RUN_ERROR，dispose 后停止', async () => {
    const handle = makeFakeAgentFactory({ hangUntilAbort: true });
    const { db, session, eventLog, runner } = await setup(handle.factory, createInterruptBus(), 5);
    await runner.startTurn({ session, definition, text: 'go', log: silentLog });
    const turn = [...db.turns.values()][0]!;
    turn.created_at = new Date(Date.now() - TURN_ABANDON_AFTER_MS - 1).toISOString();
    await waitFor(() => turn.status === 'failed');
    expect(
      db.messages.some((message) => message.turn_id === turn.id && message.status === 'failed'),
    ).toBe(true);
    expect(
      eventLog.entries(session.id).some((entry) => entry.event.type === EventType.RUN_ERROR),
    ).toBe(true);
    await runner.dispose();
    const count = eventLog.entries(session.id).length;
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(eventLog.entries(session.id)).toHaveLength(count);
  });

  it('历史只包含 legacy completed 与 completed 轮消息，失败轮不回放', async () => {
    const handle = makeFakeAgentFactory();
    const { db, session, runner } = await setup(handle.factory);
    db.messages.push({
      id: 'legacy',
      session_id: session.id,
      turn_id: null,
      idx: null,
      seq: 1,
      role: 'user',
      content: [{ type: 'text', text: 'legacy' }],
      status: 'completed',
      created_at: new Date(0).toISOString(),
    });
    for (const [id, status] of [
      ['done', 'completed'],
      ['failed', 'failed'],
    ] as const) {
      await createTurn(db, { id, sessionId: session.id });
      await appendTurnMessage(db, {
        sessionId: session.id,
        turnId: id,
        idx: 0,
        role: 'user',
        content: [{ type: 'text', text: id }],
      });
      await finishTurnCas(db, { id, status });
    }
    await runner.startTurn({ session, definition, text: 'new', log: silentLog });
    await waitFor(() => handle.calls.length === 1);
    expect(
      handle.calls[0]?.history.map((message) => (message.content[0] as { text: string }).text),
    ).toEqual(['legacy', 'done']);
    await runner.dispose();
  });
});
