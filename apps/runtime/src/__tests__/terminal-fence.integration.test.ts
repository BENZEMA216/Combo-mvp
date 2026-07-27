import { randomUUID } from 'node:crypto';
import { EventType } from '@ag-ui/core';
import type { CapabilityDefinition } from '@cb/shared';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { compareStreamIds, type SessionEventLog } from '../modules/agent/event-log.js';
import { createTurnRunner, type TurnAgentFactory } from '../modules/agent/run-turn.js';
import { createTurn, finishTurnCas, finishTurnWithMessage } from '../modules/agent/turn-repo.js';
import type { TurnLogger } from '../modules/agent/turn-emitter.js';
import { upsertArtifactForRunningTurn } from '../modules/artifact/repo.js';
import { createSession, type SessionRow } from '../modules/session/repo.js';
import { createSessionEventBus } from '../platform/infra/event-bus.js';
import {
  toRuntimeDb,
  type QueryResultLike,
  type RuntimeDb,
  type TxConn,
} from '../platform/infra/db.js';
import { createRedisSessionEventLogForClient } from '../platform/infra/redis-event-log.js';
import { createInterruptBus } from '../platform/infra/redis-interrupt-bus.js';
import type { SandboxBackend } from '../platform/infra/sandbox-backend.js';
import { FakeObjectStore, makeFakeAgentFactory, silentLog, waitFor } from './fakes.js';

const databaseUrl = process.env.RUNTIME_TERMINAL_FENCE_DATABASE_URL;
const redisUrl = process.env.RUNTIME_TERMINAL_FENCE_REDIS_URL;
const integrationEnabled = Boolean(databaseUrl && redisUrl);

const definition: CapabilityDefinition = {
  version: 1,
  name: '终态栅栏集成测试',
  summary: '验证 PostgreSQL 与 Redis 的真实交错',
  kind: 'writing',
  instructions: '测试',
  inputs: [],
  starterPrompts: [],
  meta: {},
};

interface SeededChain {
  userId: string;
  taskId: string;
  capabilityId: string;
  session: SessionRow;
}

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

function withRejectedTerminalCommits(db: RuntimeDb): RuntimeDb {
  return {
    query: <R>(sql: string, params?: unknown[], signal?: AbortSignal) =>
      db.query<R>(sql, params, signal),
    async connect(): Promise<TxConn> {
      const connection = await db.connect();
      let wroteTerminal = false;
      return {
        async query<R = Record<string, unknown>>(
          sql: string,
          params?: unknown[],
          signal?: AbortSignal,
        ): Promise<QueryResultLike<R>> {
          const normalized = sql.replace(/\s+/g, ' ').trim();
          if (normalized.startsWith('UPDATE turns SET status = $2')) wroteTerminal = true;
          if (normalized === 'COMMIT' && wroteTerminal) {
            throw new Error('injected failure before terminal COMMIT');
          }
          return connection.query<R>(sql, params, signal);
        },
        release: (destroy?: boolean) => connection.release(destroy),
      };
    },
  };
}

const integrationDescribe = integrationEnabled ? describe : describe.skip;

integrationDescribe('真实 PostgreSQL/Redis 终态栅栏', () => {
  let pool: Pool;
  let db: RuntimeDb;
  let redis: Redis;
  let eventLog: SessionEventLog;
  const seeded: SeededChain[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl!, max: 10 });
    db = toRuntimeDb(pool);
    redis = new Redis(redisUrl!, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
    });
    await redis.connect();
    await db.query('SELECT 1');
    eventLog = createRedisSessionEventLogForClient(redis);
  });

  afterAll(async () => {
    for (const chain of seeded.reverse()) {
      await db
        .query('DELETE FROM sessions WHERE id = $1', [chain.session.id])
        .catch(() => undefined);
      await db
        .query('DELETE FROM capabilities WHERE id = $1', [chain.capabilityId])
        .catch(() => undefined);
      await db.query('DELETE FROM tasks WHERE id = $1', [chain.taskId]).catch(() => undefined);
      await db.query('DELETE FROM users WHERE id = $1', [chain.userId]).catch(() => undefined);
    }
    await redis.quit().catch(() => undefined);
    await pool.end().catch(() => undefined);
  });

  async function seedSession(): Promise<SeededChain> {
    const suffix = randomUUID();
    const account = `creator-${suffix
      .replaceAll('-', '')
      .slice(0, 8)
      .replace(/[0189]/g, 'a')}`;
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (account)
       VALUES ($1) RETURNING id`,
      [account],
    );
    const userId = user.rows[0]!.id;
    const task = await db.query<{ id: string }>(
      `INSERT INTO tasks (owner_user_id, idempotency_key)
       VALUES ($1, $2) RETURNING id`,
      [userId, `terminal-fence-${suffix}`],
    );
    const taskId = task.rows[0]!.id;
    const capability = await db.query<{ id: string }>(
      `INSERT INTO capabilities (task_id, owner_user_id, name, storage_key)
       VALUES ($1, $2, 'terminal fence', $3) RETURNING id`,
      [taskId, userId, `terminal-fence/${suffix}.json`],
    );
    const capabilityId = capability.rows[0]!.id;
    const session = await createSession(db, { capabilityId, ownerUserId: userId });
    const chain = { userId, taskId, capabilityId, session };
    seeded.push(chain);
    return chain;
  }

  async function turnRows(sessionId: string): Promise<
    Array<{
      id: string;
      status: 'running' | 'completed' | 'failed' | 'interrupted';
    }>
  > {
    const result = await db.query<{
      id: string;
      status: 'running' | 'completed' | 'failed' | 'interrupted';
    }>(
      `SELECT id, status FROM turns
        WHERE session_id = $1
        ORDER BY created_at, id`,
      [sessionId],
    );
    return result.rows;
  }

  it('两副本丢失打断广播后，已提交终态栅栏迟到 Artifact 与旧 Pi 文本', async () => {
    const { session } = await seedSession();
    const store = new FakeObjectStore();
    const putObject = store.putObject.bind(store);
    let markUploadStarted!: () => void;
    const uploadStarted = new Promise<void>((resolve) => {
      markUploadStarted = resolve;
    });
    let releaseUpload!: () => void;
    const uploadReleased = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    store.putObject = async (bucket, key, body, options) => {
      markUploadStarted();
      await uploadReleased;
      return putObject(bucket, key, body, options);
    };

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
          // DB 终态应把迟到索引提交转换为 AbortError。
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
    const owner = createTurnRunner({
      db,
      objectStore: store,
      bus: createSessionEventBus(),
      eventLog,
      agentFactory: ownerFactory,
      idleTimeoutMs: 60_000,
      // 与 peer 分离，真实模拟 Pub/Sub 通知丢失。
      interrupts: createInterruptBus(),
      log: silentLog,
    });
    await owner.startTurn({ session, definition, text: 'go', log: silentLog });
    await uploadStarted;
    await waitFor(async () =>
      (await eventLog.rangeAfter(session.id, '0-0', 10)).some(
        (entry) => entry.event.type === EventType.RUN_STARTED,
      ),
    );

    const peer = createTurnRunner({
      db,
      objectStore: new FakeObjectStore(),
      bus: createSessionEventBus(),
      eventLog,
      agentFactory: makeFakeAgentFactory().factory,
      idleTimeoutMs: 60_000,
      interrupts: createInterruptBus(),
      sandbox: cleanupSandbox(),
      log: silentLog,
    });
    expect(await peer.interrupt(session.id)).toBe(true);
    expect((await turnRows(session.id))[0]?.status).toBe('interrupted');

    releaseUpload();
    await promptFinished;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const artifacts = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM artifacts WHERE session_id = $1',
      [session.id],
    );
    expect(artifacts.rows[0]?.count).toBe('0');
    const entries = await eventLog.rangeAfter(session.id, '0-0', 100);
    expect(entries.map((entry) => entry.event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_ERROR,
    ]);

    await peer.dispose();
    await owner.dispose();
  });

  it('终态 COMMIT 前数据库失败会真实回滚，且 Redis 不出现提前终态', async () => {
    const { session } = await seedSession();
    let terminalCalls = 0;
    const observedLog: SessionEventLog = {
      append: (sessionId, event) => eventLog.append(sessionId, event),
      appendTerminal: (sessionId, runId, event) => {
        terminalCalls += 1;
        return eventLog.appendTerminal(sessionId, runId, event);
      },
      repairTerminal: (sessionId, runId, event) => eventLog.repairTerminal(sessionId, runId, event),
      rangeAfter: (sessionId, afterId, count) => eventLog.rangeAfter(sessionId, afterId, count),
    };
    const error = vi.fn<TurnLogger['error']>();
    const runner = createTurnRunner({
      db: withRejectedTerminalCommits(db),
      objectStore: new FakeObjectStore(),
      bus: createSessionEventBus(),
      eventLog: observedLog,
      agentFactory: makeFakeAgentFactory({
        finalMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
      }).factory,
      idleTimeoutMs: 60_000,
      interrupts: createInterruptBus(),
      log: { error },
    });
    await runner.startTurn({ session, definition, text: 'go', log: { error } });
    await waitFor(() =>
      error.mock.calls.some((call) => call[1] === 'persist failed terminal state failed'),
    );

    expect((await turnRows(session.id))[0]?.status).toBe('running');
    expect(terminalCalls).toBe(0);
    expect(
      (await eventLog.rangeAfter(session.id, '0-0', 100)).map((row) => row.event.type),
    ).toEqual([EventType.RUN_STARTED]);
    await runner.dispose();
  });

  it('Redis 终态超时发生在 DB COMMIT 后，下一轮修复顺序且迟到 EVAL 幂等', async () => {
    const { session } = await seedSession();
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let terminalCalls = 0;
    const statusAtAppend: string[] = [];
    const appendObserved = async (
      mode: 'strict' | 'repair',
      sessionId: string,
      runId: string,
      event: Record<string, unknown>,
    ): Promise<string> => {
      terminalCalls += 1;
      const status = await db.query<{ status: string }>('SELECT status FROM turns WHERE id = $1', [
        runId,
      ]);
      statusAtAppend.push(status.rows[0]!.status);
      if (terminalCalls === 1) await firstReleased;
      return mode === 'repair'
        ? eventLog.repairTerminal(sessionId, runId, event)
        : eventLog.appendTerminal(sessionId, runId, event);
    };
    const delayedLog: SessionEventLog = {
      append: (sessionId, event) => eventLog.append(sessionId, event),
      appendTerminal: (sessionId, runId, event) =>
        appendObserved('strict', sessionId, runId, event),
      repairTerminal: (sessionId, runId, event) =>
        appendObserved('repair', sessionId, runId, event),
      rangeAfter: (sessionId, afterId, count) => eventLog.rangeAfter(sessionId, afterId, count),
    };
    const completed = makeFakeAgentFactory({
      finalMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
    });
    const hanging = makeFakeAgentFactory({ hangUntilAbort: true });
    let agentCalls = 0;
    const factory: TurnAgentFactory = (input) =>
      (agentCalls++ === 0 ? completed.factory : hanging.factory)(input);
    const runner = createTurnRunner({
      db,
      objectStore: new FakeObjectStore(),
      bus: createSessionEventBus(),
      eventLog: delayedLog,
      agentFactory: factory,
      idleTimeoutMs: 60_000,
      interrupts: createInterruptBus(),
      terminalEventTimeoutMs: 25,
      log: silentLog,
    });

    await runner.startTurn({ session, definition, text: 'first', log: silentLog });
    await waitFor(async () => (await turnRows(session.id))[0]?.status === 'completed');
    const firstRunId = (await turnRows(session.id))[0]!.id;
    await new Promise((resolve) => setTimeout(resolve, 35));

    await runner.startTurn({ session, definition, text: 'second', log: silentLog });
    await waitFor(async () =>
      (await turnRows(session.id)).some((turn) => turn.status === 'running'),
    );
    const secondRunId = (await turnRows(session.id)).find((turn) => turn.id !== firstRunId)!.id;
    await waitFor(async () =>
      (await eventLog.rangeAfter(session.id, '0-0', 100)).some(
        (entry) => entry.event.runId === secondRunId && entry.event.type === EventType.RUN_STARTED,
      ),
    );

    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const entries = await eventLog.rangeAfter(session.id, '0-0', 100);
    const oldTerminals = entries.filter(
      (entry) => entry.event.runId === firstRunId && entry.event.type === EventType.RUN_FINISHED,
    );
    const nextStarted = entries.find(
      (entry) => entry.event.runId === secondRunId && entry.event.type === EventType.RUN_STARTED,
    );
    expect(statusAtAppend.slice(0, 2)).toEqual(['completed', 'completed']);
    expect(oldTerminals).toHaveLength(1);
    expect(nextStarted).toBeTruthy();
    expect(compareStreamIds(oldTerminals[0]!.id, nextStarted!.id)).toBeLessThan(0);

    expect(await runner.interrupt(session.id)).toBe(true);
    await waitFor(async () =>
      (await turnRows(session.id)).every((turn) => turn.status !== 'running'),
    );
    await runner.dispose();
  });

  it('marker 已匹配但终态后有同 Turn 迟到事件时，下一轮前把权威终态重放到 Stream 尾部', async () => {
    const { session } = await seedSession();
    const legacyRunId = randomUUID();
    const streamKey = `rt:sess:evt:${session.id}`;
    const markerKey = `rt:sess:terminal:${session.id}:${legacyRunId}`;
    const terminalEvent = {
      type: EventType.RUN_ERROR,
      threadId: session.id,
      runId: legacyRunId,
      message: '本轮生成已打断。',
    };

    await createTurn(db, { id: legacyRunId, sessionId: session.id });
    await eventLog.append(session.id, {
      type: EventType.RUN_STARTED,
      threadId: session.id,
      runId: legacyRunId,
    });
    const staleTerminalId = await eventLog.appendTerminal(session.id, legacyRunId, terminalEvent);

    // 模拟旧副本在终态事务回滚后完成已经进入窗口的 Artifact 提交，再绕过
    // 新脚本写入迟到事件。marker 仍精确指向旧终态，这是上一轮评审复现出的组合。
    const artifactId = randomUUID();
    expect(
      await upsertArtifactForRunningTurn(db, {
        id: artifactId,
        sessionId: session.id,
        turnId: legacyRunId,
        kind: 'markdown',
        title: '迟到产物',
        storageKey: `artifacts/${session.id}/${artifactId}/revision.md`,
        meta: {},
      }),
    ).toMatchObject({ id: artifactId });
    const lateStateId = await redis.xadd(
      streamKey,
      '*',
      'event',
      JSON.stringify({
        type: EventType.STATE_DELTA,
        threadId: session.id,
        runId: legacyRunId,
        delta: [{ op: 'add', path: `/artifacts/${artifactId}`, value: { id: artifactId } }],
      }),
    );
    const lateTextId = await redis.xadd(
      streamKey,
      '*',
      'event',
      JSON.stringify({
        type: EventType.TEXT_MESSAGE_CONTENT,
        threadId: session.id,
        runId: legacyRunId,
        messageId: 'late-message',
        delta: 'late',
      }),
    );
    if (!lateStateId || !lateTextId) throw new Error('legacy XADD did not return Stream ids');
    expect(await redis.get(markerKey)).toMatch(new RegExp(`^${staleTerminalId}\\|`));
    expect(compareStreamIds(lateStateId, staleTerminalId)).toBeGreaterThan(0);
    expect(compareStreamIds(lateTextId, lateStateId)).toBeGreaterThan(0);

    expect(
      await finishTurnWithMessage(db, {
        id: legacyRunId,
        sessionId: session.id,
        idx: 1,
        status: 'interrupted',
        content: [{ type: 'text', text: '本轮生成已打断。' }],
        lastError: { code: 'TURN_INTERRUPTED', message: '本轮生成已打断。' },
      }),
    ).toBe(true);
    const durableState = await db.query<{ artifact_count: string; message_count: string }>(
      `SELECT
         (SELECT count(*)::text FROM artifacts WHERE session_id = $1) AS artifact_count,
         (SELECT count(*)::text FROM messages WHERE turn_id = $2) AS message_count`,
      [session.id, legacyRunId],
    );
    expect(durableState.rows[0]).toEqual({ artifact_count: '1', message_count: '1' });

    const runner = createTurnRunner({
      db,
      objectStore: new FakeObjectStore(),
      bus: createSessionEventBus(),
      eventLog,
      agentFactory: makeFakeAgentFactory({ hangUntilAbort: true }).factory,
      idleTimeoutMs: 60_000,
      interrupts: createInterruptBus(),
      log: silentLog,
    });
    await runner.startTurn({ session, definition, text: 'next', log: silentLog });
    await waitFor(async () =>
      (await eventLog.rangeAfter(session.id, '0-0', 100)).some(
        (entry) => entry.event.runId !== legacyRunId && entry.event.type === EventType.RUN_STARTED,
      ),
    );

    const entries = await eventLog.rangeAfter(session.id, '0-0', 100);
    const legacyEntries = entries.filter((entry) => entry.event.runId === legacyRunId);
    expect(legacyEntries.map((entry) => entry.event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.STATE_DELTA,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.RUN_ERROR,
    ]);
    const repairedTerminal = legacyEntries.at(-1)!;
    const nextStarted = entries.find(
      (entry) => entry.event.runId !== legacyRunId && entry.event.type === EventType.RUN_STARTED,
    );
    expect(repairedTerminal.id).not.toBe(staleTerminalId);
    expect(compareStreamIds(repairedTerminal.id, lateTextId)).toBeGreaterThan(0);
    expect(nextStarted).toBeTruthy();
    expect(compareStreamIds(repairedTerminal.id, nextStarted!.id)).toBeLessThan(0);

    await expect(
      eventLog.append(session.id, {
        type: EventType.TEXT_MESSAGE_CONTENT,
        threadId: session.id,
        runId: legacyRunId,
        delta: 'later',
      }),
    ).rejects.toThrow('TERMINAL_ALREADY_APPENDED');
    expect(await runner.interrupt(session.id)).toBe(true);
    await waitFor(async () =>
      (await turnRows(session.id)).every((turn) => turn.status !== 'running'),
    );
    await runner.dispose();
  });

  it('下一轮以 PostgreSQL 终态替换升级前冲突 marker，且不公开内部错误消息', async () => {
    const { session } = await seedSession();
    const legacyRunId = randomUUID();
    await createTurn(db, { id: legacyRunId, sessionId: session.id });
    const wrongTerminalId = await eventLog.appendTerminal(session.id, legacyRunId, {
      type: EventType.RUN_FINISHED,
      threadId: session.id,
      runId: legacyRunId,
    });
    const internalMessage = 'duplicate key value violates private_constraint_name';
    await finishTurnCas(db, {
      id: legacyRunId,
      status: 'failed',
      lastError: { code: 'SUBMIT_FAILED', message: internalMessage },
    });

    const runner = createTurnRunner({
      db,
      objectStore: new FakeObjectStore(),
      bus: createSessionEventBus(),
      eventLog,
      agentFactory: makeFakeAgentFactory({ hangUntilAbort: true }).factory,
      idleTimeoutMs: 60_000,
      interrupts: createInterruptBus(),
      log: silentLog,
    });
    await runner.startTurn({ session, definition, text: 'next', log: silentLog });
    await waitFor(async () =>
      (await eventLog.rangeAfter(session.id, '0-0', 100)).some(
        (entry) => entry.event.runId !== legacyRunId && entry.event.type === EventType.RUN_STARTED,
      ),
    );

    const entries = await eventLog.rangeAfter(session.id, '0-0', 100);
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
    expect(compareStreamIds(repaired[0]!.id, nextStarted!.id)).toBeLessThan(0);

    expect(await runner.interrupt(session.id)).toBe(true);
    await waitFor(async () =>
      (await turnRows(session.id)).every((turn) => turn.status !== 'running'),
    );
    await runner.dispose();
  });

  it('终态 marker 缺失或为旧 OPEN 时扫描保留 Stream，并保持终态逐字幂等', async () => {
    const ttlMs = 1_000;
    const ttlLog = createRedisSessionEventLogForClient(redis, { ttlMs, maxlen: 100 });
    const sessionId = randomUUID();
    const runId = randomUUID();
    const markerKey = `rt:sess:terminal:${sessionId}:${runId}`;
    const event = {
      type: EventType.RUN_FINISHED,
      threadId: sessionId,
      runId,
    };
    const firstId = await ttlLog.appendTerminal(sessionId, runId, event);
    await redis.pexpire(markerKey, 1);
    await ttlLog.append(sessionId, {
      type: EventType.RUN_STARTED,
      threadId: sessionId,
      runId: randomUUID(),
    });
    await waitFor(async () => (await redis.exists(markerKey)) === 0);

    // The old run marker is gone while a newer run has refreshed the Session
    // Stream. The first late ordinary append itself must discover the terminal.
    await expect(
      ttlLog.append(sessionId, {
        type: EventType.TEXT_MESSAGE_CONTENT,
        threadId: sessionId,
        runId,
        delta: 'late-after-missing-marker',
      }),
    ).rejects.toThrow('TERMINAL_ALREADY_APPENDED');
    expect(await ttlLog.appendTerminal(sessionId, runId, event)).toBe(firstId);

    // A pre-fix late append could have replaced an expired terminal marker with
    // the ambiguous literal OPEN. It receives the same retained-history check.
    await redis.set(markerKey, 'OPEN', 'PX', ttlMs);
    await expect(
      ttlLog.append(sessionId, {
        type: EventType.STATE_DELTA,
        threadId: sessionId,
        runId,
        delta: [],
      }),
    ).rejects.toThrow('TERMINAL_ALREADY_APPENDED');
    expect(await ttlLog.appendTerminal(sessionId, runId, event)).toBe(firstId);
    await expect(
      ttlLog.appendTerminal(sessionId, runId, {
        type: EventType.RUN_ERROR,
        threadId: sessionId,
        runId,
        message: '不能成为第二终态',
      }),
    ).rejects.toThrow('TERMINAL_EVENT_CONFLICT');
    expect(
      (await ttlLog.rangeAfter(sessionId, '0-0', 100)).filter(
        (entry) => entry.event.runId === runId,
      ),
    ).toHaveLength(1);

    // 核心字段相同但携带额外字段的终态也不是 PostgreSQL 权威事件。
    // strict 必须拒绝竞争写，repair 必须删除污染条目并重放逐字一致的事件。
    const pollutedSessionId = randomUUID();
    const pollutedRunId = randomUUID();
    const cleanEvent = {
      type: EventType.RUN_ERROR,
      threadId: pollutedSessionId,
      runId: pollutedRunId,
      message: '服务异常中断,本轮已终止,请重试。',
    };
    const pollutedId = await ttlLog.appendTerminal(pollutedSessionId, pollutedRunId, {
      ...cleanEvent,
      internalDiagnostic: '不能保留到 SSE',
    });
    await expect(
      ttlLog.appendTerminal(pollutedSessionId, pollutedRunId, cleanEvent),
    ).rejects.toThrow('TERMINAL_EVENT_CONFLICT');
    const cleanId = await ttlLog.repairTerminal(pollutedSessionId, pollutedRunId, cleanEvent);
    expect(cleanId).not.toBe(pollutedId);
    expect(await ttlLog.rangeAfter(pollutedSessionId, '0-0', 10)).toEqual([
      { id: cleanId, event: cleanEvent },
    ]);

    const expirationLog = createRedisSessionEventLogForClient(redis, {
      ttlMs: 50,
      maxlen: 100,
    });
    const expiredSessionId = randomUUID();
    const expiredRunId = randomUUID();
    const expiredEvent = {
      type: EventType.RUN_FINISHED,
      threadId: expiredSessionId,
      runId: expiredRunId,
    };
    const expiredFirstId = await expirationLog.appendTerminal(
      expiredSessionId,
      expiredRunId,
      expiredEvent,
    );
    await waitFor(
      async () => (await expirationLog.rangeAfter(expiredSessionId, '0-0', 10)).length === 0,
      2_000,
    );
    const repairedId = await expirationLog.appendTerminal(
      expiredSessionId,
      expiredRunId,
      expiredEvent,
    );
    expect(repairedId).not.toBe(expiredFirstId);
    expect(await expirationLog.rangeAfter(expiredSessionId, '0-0', 10)).toHaveLength(1);
  });
});
