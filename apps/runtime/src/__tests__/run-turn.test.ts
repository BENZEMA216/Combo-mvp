// run-turn 编排（注入假 agent 工厂）：事件双写、终态消息落库、busy 闸、失败落 failed 消息、打断。
import { describe, expect, it, vi } from 'vitest';
import { EventType } from '@ag-ui/core';
import type { CapabilityDefinition } from '@cb/shared';
import {
  createTurnRunner,
  SessionInactiveError,
  TurnAgentUnavailableError,
} from '../modules/agent/run-turn.js';
import {
  archiveSession,
  createSession,
  getOrCreateStudioSession,
  type SessionRow,
} from '../modules/session/repo.js';
import { createSessionEventBus, type PublishedStreamEvent } from '../platform/infra/event-bus.js';
import {
  FakeDb,
  FakeSessionEventLog,
  FakeObjectStore,
  makeFakeAgentFactory,
  silentLog,
  waitFor,
  type FakeAgentScript,
} from './fakes.js';
import { createInterruptBus } from '../platform/infra/redis-interrupt-bus.js';
import { createArtifactTool } from '../modules/artifact/tool.js';
import { ARTIFACT_BUCKET, bindCapabilityUiArtifact } from '../modules/artifact/repo.js';
import { compareStreamIds } from '../modules/agent/event-log.js';
import { type SandboxBackend, SandboxBackendError } from '../platform/infra/sandbox-backend.js';

const ME = 'user-me';

const DEFINITION: CapabilityDefinition = {
  version: 1,
  name: '会议纪要生成',
  summary: '把速记变成结构化纪要',
  kind: 'writing',
  instructions: '你是一名会议纪要专家。',
  inputs: [],
  starterPrompts: [],
  meta: {},
};

function studioHtml(label: string): string {
  return `<!doctype html><html><head><style>button{color:red}</style></head><body>
  <input id="goal"><button data-combo-key="run-primary">${label}</button><script>
  const button = document.querySelector('[data-combo-key="run-primary"]');
  button.addEventListener('click', () => {
    const prompt = document.querySelector('#goal').value.trim();
    window.parent.postMessage({type:'combo:run',version:1,prompt}, '*');
  });
  </script></body></html>`;
}

function sandboxFixture(): SandboxBackend {
  return {
    enabled: true,
    describe: vi.fn(async () => Promise.reject(new Error('not invoked'))),
    read: vi.fn(async () => Promise.reject(new Error('not invoked'))),
    write: vi.fn(async () => Promise.reject(new Error('not invoked'))),
    edit: vi.fn(async () => Promise.reject(new Error('not invoked'))),
    command: vi.fn(async () => Promise.reject(new Error('not invoked'))),
    interruptSession: vi.fn(async () => undefined),
    releaseSession: async () => undefined,
    dispose: async () => undefined,
  };
}

async function setup(
  script: FakeAgentScript = {},
  idleTimeoutMs = 60_000,
  sandbox?: SandboxBackend,
  shutdownTimeoutMs?: number,
  observeAppend?: (event: Record<string, unknown>, db: FakeDb) => void,
  terminalEventTimeoutMs?: number,
) {
  const db = new FakeDb();
  const store = new FakeObjectStore();
  const bus = createSessionEventBus();
  const eventLog = new FakeSessionEventLog();
  if (observeAppend) {
    const append = eventLog.append.bind(eventLog);
    eventLog.append = async (sessionId, event) => {
      observeAppend(event, db);
      return append(sessionId, event);
    };
  }
  const handle = makeFakeAgentFactory(script);
  const runner = createTurnRunner({
    db,
    objectStore: store,
    bus,
    eventLog,
    agentFactory: handle.factory,
    idleTimeoutMs,
    interrupts: createInterruptBus(),
    sandbox,
    ...(shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs }),
    ...(terminalEventTimeoutMs === undefined ? {} : { terminalEventTimeoutMs }),
    log: silentLog,
  });
  const cap = db.seedCapability({ owner_user_id: ME });
  const session: SessionRow = await createSession(db, { capabilityId: cap.id, ownerUserId: ME });
  const published: PublishedStreamEvent[] = [];
  bus.subscribe(session.id, (e) => published.push(e));
  return { db, eventLog, store, bus, handle, runner, session, published };
}

function eventTypes(eventLog: FakeSessionEventLog, sessionId: string): unknown[] {
  return eventLog.entries(sessionId).map((e) => e.event.type);
}

async function runToIdle(
  runner: ReturnType<typeof createTurnRunner>,
  db: FakeDb,
  session: SessionRow,
  text = '帮我整理这份速记',
) {
  const result = await runner.startTurn({ session, definition: DEFINITION, text, log: silentLog });
  await waitFor(() =>
    [...db.turns.values()].every(
      (turn) => turn.session_id !== session.id || turn.status !== 'running',
    ),
  );
  return result;
}

describe('run-turn 成功路径', () => {
  it('uses a caller-fixed Turn id and runs the transactional hook before execution', async () => {
    const { db, runner, session, handle } = await setup({
      finalMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
    });
    const beforeCommit = vi.fn(async () => undefined);
    const turnId = '11111111-1111-4111-8111-111111111111';

    await runner.startTurn({
      session,
      definition: DEFINITION,
      text: 'test fixed identity',
      log: silentLog,
      turnId,
      beforeCommit,
    });
    await waitFor(() => db.turns.get(turnId)?.status !== 'running');

    expect(beforeCommit).toHaveBeenCalledWith(expect.anything(), turnId);
    expect(db.turns.get(turnId)).toBeDefined();
    expect(handle.calls).toHaveLength(1);
  });

  it('事件双写（表+总线同 id 同序）、整轮消息落 completed', async () => {
    const { db, eventLog, runner, session, published, handle } = await setup({
      deltas: ['我来', '整理'],
      invokeTool: { title: '纪要', content: '<!doctype html><html>纪要</html>' },
      finalMessages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '我来整理' },
            { type: 'toolCall', id: 'tc-1', name: 'upsert_artifact', arguments: {} },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'tc-1',
          toolName: 'upsert_artifact',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        },
        { role: 'assistant', content: [{ type: 'text', text: '整理好了' }] },
      ],
    });

    const result = await runToIdle(runner, db, session);
    expect(result.status).toBe('started');
    if (result.status === 'started') {
      expect(result.userMessage.seq).toBe(1);
      expect(result.userMessage.role).toBe('user');
    }

    // 事件顺序：RUN_STARTED → 文本开闭之间夹产物 STATE_DELTA → RUN_FINISHED。
    expect(eventTypes(eventLog, session.id)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.STATE_DELTA,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    // 双写：总线收到同一批（id = 表自增 id，同序）。
    expect(published.map((e) => e.id)).toEqual(eventLog.entries(session.id).map((e) => e.id));
    expect(published.map((e) => e.event.type)).toEqual(eventTypes(eventLog, session.id));

    // 整轮定稿：user + assistant + tool + assistant，全 completed。
    const rows = db.messages.filter((m) => m.session_id === session.id);
    expect(rows.map((m) => [m.idx, m.role, m.status])).toEqual([
      [0, 'user', 'completed'],
      [1, 'assistant', 'completed'],
      [2, 'tool', 'completed'],
      [3, 'assistant', 'completed'],
    ]);
    // 产物工具真实走通（表 + MinIO 在 artifact.test 覆盖，这里验接线）。
    expect(db.artifacts.size).toBe(1);

    // agent 工厂拿到 definition 与空历史（首轮）。
    expect(handle.calls[0]?.definition).toEqual(DEFINITION);
    expect(handle.calls[0]?.mode).toBe('consume');
    expect(handle.calls[0]?.history).toHaveLength(0);
    expect(handle.calls[0]?.tools.map((tool) => tool.name)).toEqual(['upsert_artifact']);
  });

  it('功能开启时保持 upsert_artifact 在前，再追加四个远程沙箱工具', async () => {
    const sandbox = sandboxFixture();
    const { db, runner, session, handle } = await setup(
      { finalMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] },
      60_000,
      sandbox,
    );
    await runToIdle(runner, db, session);
    expect(handle.calls[0]?.tools.map((tool) => tool.name)).toEqual([
      'upsert_artifact',
      'read',
      'write',
      'edit',
      'bash',
    ]);
  });

  it('Pi 执行四个已注册工具时全部穿过注入的 SandboxBackend', async () => {
    const sandbox = sandboxFixture();
    vi.mocked(sandbox.read).mockResolvedValue({
      content: 'alpha',
      sizeBytes: 5,
      offset: 0,
      truncated: false,
    });
    vi.mocked(sandbox.write).mockResolvedValue({ writtenBytes: 5 });
    vi.mocked(sandbox.edit).mockResolvedValue({ replacements: 1 });
    vi.mocked(sandbox.command).mockImplementation(async (_context, _input, onFrame) => {
      onFrame({ type: 'start', commandId: 'command-1' });
      onFrame({ type: 'output', commandId: 'command-1', stream: 'stdout', data: 'ok' });
      onFrame({ type: 'exit', commandId: 'command-1', exitCode: 0 });
      return {
        commandId: 'command-1',
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        truncated: false,
        durationMs: 1,
      };
    });
    const { db, runner, session } = await setup(
      {
        invokeNamedTools: [
          { name: 'write', params: { path: 'note.txt', content: 'alpha' } },
          { name: 'read', params: { path: 'note.txt' } },
          {
            name: 'edit',
            params: { path: 'note.txt', oldText: 'alpha', newText: 'beta' },
          },
          { name: 'bash', params: { command: 'printf ok' } },
        ],
        finalMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
      },
      60_000,
      sandbox,
    );
    await runToIdle(runner, db, session);
    expect(sandbox.write).toHaveBeenCalledOnce();
    expect(sandbox.read).toHaveBeenCalledOnce();
    expect(sandbox.edit).toHaveBeenCalledOnce();
    expect(sandbox.command).toHaveBeenCalledOnce();
  });

  it('Pi 工具无法确认命令清理时会中止本轮并在清理确认后落 interrupted', async () => {
    const sandbox = sandboxFixture();
    vi.mocked(sandbox.command).mockRejectedValue(
      new SandboxBackendError('cleanup_unconfirmed', 'control plane details'),
    );
    const { db, runner, session } = await setup(
      {
        invokeNamedTools: [{ name: 'bash', params: { command: 'sleep 30' } }],
      },
      60_000,
      sandbox,
    );
    await runToIdle(runner, db, session);
    expect(sandbox.interruptSession).toHaveBeenCalledWith(session.id);
    expect([...db.turns.values()][0]?.status).toBe('interrupted');
  });

  it('PostgreSQL 终态与消息提交后才追加终态 Redis 事件', async () => {
    const terminalSnapshots: Array<{
      status: string | undefined;
      queries: string[];
      txLog: string[];
    }> = [];
    const { db, runner, session } = await setup(
      { finalMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] },
      60_000,
      undefined,
      undefined,
      (event, currentDb) => {
        if (event.type !== EventType.RUN_FINISHED) return;
        terminalSnapshots.push({
          status: [...currentDb.turns.values()][0]?.status,
          queries: [...currentDb.queries],
          txLog: [...currentDb.txLog],
        });
      },
    );
    await runToIdle(runner, db, session);
    expect(terminalSnapshots).toHaveLength(1);
    expect(terminalSnapshots[0]?.status).toBe('completed');
    expect(terminalSnapshots[0]?.txLog.at(-1)).toBe('COMMIT');
    expect(terminalSnapshots[0]?.queries).toEqual(
      expect.arrayContaining([
        'SELECT id FROM sessions WHERE id = $1 FOR UPDATE',
        "SELECT id FROM turns WHERE id = $1 AND session_id = $2 AND status = 'running' FOR UPDATE",
      ]),
    );
    expect(
      terminalSnapshots[0]?.queries.some((query) =>
        query.startsWith('UPDATE turns SET status = $2'),
      ),
    ).toBe(true);
  });

  it('Studio 会话把设计模式传给 agent 工厂，未生成 revision 时以失败终态收口', async () => {
    const { db, eventLog, runner, session, handle } = await setup({
      finalMessages: [{ role: 'assistant', content: [{ type: 'text', text: '已更新页面' }] }],
    });
    const studio = await getOrCreateStudioSession(db, {
      capabilityId: session.capabilityId,
      ownerUserId: session.ownerUserId,
    });

    await runToIdle(runner, db, studio, '把主要按钮改成绿色');
    expect(handle.calls[0]?.mode).toBe('studio');
    expect([...db.turns.values()].at(-1)?.status).toBe('failed');
    expect(eventTypes(eventLog, studio.id)).toContain(EventType.RUN_ERROR);
    expect(eventTypes(eventLog, studio.id)).not.toContain(EventType.RUN_FINISHED);
  });

  it('Studio 原有 current UI 时，无 revision 的完成回复也不能误报保存成功', async () => {
    const { db, store, eventLog, runner, session } = await setup({
      finalMessages: [{ role: 'assistant', content: [{ type: 'text', text: '已经改好了' }] }],
    });
    const studio = await getOrCreateStudioSession(db, {
      capabilityId: session.capabilityId,
      ownerUserId: session.ownerUserId,
    });
    const seedTurnId = 'studio-current-ui-turn';
    const seedController = new AbortController();
    const now = new Date().toISOString();
    db.turns.set(seedTurnId, {
      id: seedTurnId,
      session_id: studio.id,
      status: 'running',
      last_error: null,
      created_at: now,
      finished_at: null,
    });
    const current = await createArtifactTool({
      db,
      objectStore: store,
      sessionId: studio.id,
      turnId: seedTurnId,
      turnSignal: seedController.signal,
      capabilityId: session.capabilityId,
      mode: 'studio',
      onArtifact: () => undefined,
    }).execute('current-ui', {
      kind: 'html',
      title: '当前 UI',
      content: studioHtml('当前版本'),
    });
    db.turns.get(seedTurnId)!.status = 'completed';
    await bindCapabilityUiArtifact(db, {
      capabilityId: session.capabilityId,
      artifactId: current.details!.artifactId,
      studioSessionId: studio.id,
      turnId: seedTurnId,
    });

    await runToIdle(runner, db, studio, '把按钮改成绿色');

    expect(db.capabilities.get(session.capabilityId)?.ui_artifact_id).toBe(
      current.details!.artifactId,
    );
    expect([...db.turns.values()].at(-1)?.status).toBe('failed');
    expect(eventTypes(eventLog, studio.id).at(-1)).toBe(EventType.RUN_ERROR);
  });

  it('Studio 只有整轮成功后才在同一终态事务提升最后一个 revision', async () => {
    const { db, runner, session } = await setup({
      invokeTool: { title: 'Agent UI', content: studioHtml('新版本') },
      finalMessages: [{ role: 'assistant', content: [{ type: 'text', text: '已更新页面' }] }],
    });
    const studio = await getOrCreateStudioSession(db, {
      capabilityId: session.capabilityId,
      ownerUserId: session.ownerUserId,
    });

    await runToIdle(runner, db, studio, '更新页面');
    const currentId = db.capabilities.get(session.capabilityId)?.ui_artifact_id;
    expect(currentId).toBeTruthy();
    expect(db.artifacts.get(currentId!)?.session_id).toBe(studio.id);
    expect(db.txLog.slice(-2)).toEqual(['BEGIN', 'COMMIT']);
  });

  it('Studio 在 tool 后整轮失败时保留旧 current UI 与旧对象', async () => {
    const { db, store, session } = await setup();
    const studio = await getOrCreateStudioSession(db, {
      capabilityId: session.capabilityId,
      ownerUserId: session.ownerUserId,
    });
    const seedTurnId = 'studio-seed-turn';
    const now = new Date().toISOString();
    db.turns.set(seedTurnId, {
      id: seedTurnId,
      session_id: studio.id,
      status: 'running',
      last_error: null,
      created_at: now,
      finished_at: null,
    });
    const seedController = new AbortController();
    const oldRevision = await createArtifactTool({
      db,
      objectStore: store,
      sessionId: studio.id,
      turnId: seedTurnId,
      turnSignal: seedController.signal,
      capabilityId: session.capabilityId,
      mode: 'studio',
      onArtifact: () => undefined,
    }).execute('old', { kind: 'html', title: '旧 UI', content: studioHtml('旧版本') });
    db.turns.get(seedTurnId)!.status = 'completed';
    await bindCapabilityUiArtifact(db, {
      capabilityId: session.capabilityId,
      artifactId: oldRevision.details!.artifactId,
      studioSessionId: studio.id,
      turnId: seedTurnId,
    });
    const failingAgent = makeFakeAgentFactory({
      invokeTool: { title: '失败 revision', content: studioHtml('不应生效') },
      promptError: new Error('model failed after tool'),
    });
    const runner = createTurnRunner({
      db,
      objectStore: store,
      bus: createSessionEventBus(),
      eventLog: new FakeSessionEventLog(),
      agentFactory: failingAgent.factory,
      idleTimeoutMs: 60_000,
      interrupts: createInterruptBus(),
      log: silentLog,
    });

    await runToIdle(runner, db, studio, '失败的修改');
    expect(db.capabilities.get(session.capabilityId)?.ui_artifact_id).toBe(
      oldRevision.details!.artifactId,
    );
    expect(
      await store.getObjectText(
        ARTIFACT_BUCKET as never,
        db.artifacts.get(oldRevision.details!.artifactId)!.storage_key,
      ),
    ).toContain('旧版本');
    expect(db.artifacts.size).toBe(2);
  });

  it('第二轮把上一轮定稿作为历史喂给 agent（failed 消息除外）', async () => {
    const { db, runner, session, handle } = await setup({
      finalMessages: [{ role: 'assistant', content: [{ type: 'text', text: '好的' }] }],
    });
    await runToIdle(runner, db, session, '第一轮');
    await runToIdle(runner, db, session, '第二轮');

    const secondHistory = handle.calls[1]?.history ?? [];
    // 历史 = 第一轮的 user + assistant（不含第二轮自己的 user 消息）。
    expect(secondHistory.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});

describe('run-turn 与归档串行化', () => {
  it('归档先拿到会话锁后，持有旧 SessionRow 的发送请求也不能再创建轮次', async () => {
    const { db, runner, session } = await setup();
    await archiveSession(db, session.id, session.ownerUserId);

    await expect(
      runner.startTurn({ session, definition: DEFINITION, text: '迟到的消息', log: silentLog }),
    ).rejects.toBeInstanceOf(SessionInactiveError);
    expect(db.turns.size).toBe(0);
    expect(
      db.queries.filter((query) => query.includes("status = 'active' FOR UPDATE")),
    ).toHaveLength(2);
  });
});

describe('run-turn 打断', () => {
  it('本地执行句柄被打断后落 interrupted 终态', async () => {
    const { db, eventLog, runner, session } = await setup({
      deltas: ['部分'],
      hangUntilAbort: true,
    });

    const first = await runner.startTurn({
      session,
      definition: DEFINITION,
      text: '第一条',
      log: silentLog,
    });
    expect(first.status).toBe('started');
    expect(await runner.interrupt(session.id)).toBe(true);
    await waitFor(() => [...db.turns.values()].every((turn) => turn.status !== 'running'));

    // 打断落 failed 消息（已生成的部分文本保留），事件以 RUN_ERROR 收尾、无 RUN_FINISHED。
    const failed = db.messages.find((m) => m.role === 'assistant');
    expect(failed?.status).toBe('failed');
    expect(failed?.content).toEqual([{ type: 'text', text: '部分' }]);
    const types = eventTypes(eventLog, session.id);
    expect(types).toContain(EventType.RUN_ERROR);
    expect(types).not.toContain(EventType.RUN_FINISHED);

    expect(await runner.interrupt(session.id)).toBe(false);
  });

  it('Artifact 上传忽略 abort 时仍可安全收尾，迟到返回后不提交产物或状态事件', async () => {
    let markUploadStarted!: () => void;
    const uploadStarted = new Promise<void>((resolve) => {
      markUploadStarted = resolve;
    });
    let releaseUpload!: () => void;
    const uploadReleased = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const { db, eventLog, store, runner, session } = await setup(
      { invokeTool: { title: '迟到产物', content: 'secret' } },
      60_000,
      undefined,
      20,
    );
    const putObject = store.putObject.bind(store);
    store.putObject = async (bucket, key, body) => {
      markUploadStarted();
      await uploadReleased;
      return putObject(bucket, key, body);
    };

    await runner.startTurn({
      session,
      definition: DEFINITION,
      text: '生成一个产物',
      log: silentLog,
    });
    await uploadStarted;
    expect(await runner.interrupt(session.id)).toBe(true);
    await waitFor(() => [...db.turns.values()].every((turn) => turn.status !== 'running'));
    expect([...db.turns.values()][0]?.status).toBe('interrupted');
    expect(db.artifacts.size).toBe(0);

    releaseUpload();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect([...db.turns.values()][0]?.status).toBe('interrupted');
    expect(db.artifacts.size).toBe(0);
    const types = eventTypes(eventLog, session.id);
    expect(types).not.toContain(EventType.STATE_DELTA);
    expect(types.at(-1)).toBe(EventType.RUN_ERROR);
  });
});

describe('run-turn 空闲看门狗（issue #51：流中途停滞永无终态）', () => {
  it('LLM 流停滞超过阈值 → 同时停止 Pi 与远程命令，再落 RUN_ERROR', async () => {
    const sandbox = sandboxFixture();
    const { db, eventLog, runner, session } = await setup(
      { deltas: ['部分'], hangUntilAbort: true },
      30,
      sandbox,
    );

    const result = await runner.startTurn({
      session,
      definition: DEFINITION,
      text: '会停滞的一轮',
      log: silentLog,
    });
    expect(result.status).toBe('started');
    // 不做人工 interrupt：看门狗自己判死并收尾。
    await waitFor(() => [...db.turns.values()].every((turn) => turn.status !== 'running'));

    const failed = db.messages.find((m) => m.role === 'assistant');
    expect(failed?.status).toBe('failed');
    expect(failed?.content).toEqual([{ type: 'text', text: '部分' }]);

    const last = eventLog.entries(session.id).at(-1)?.event as { type: unknown; message?: string };
    expect(last.type).toBe(EventType.RUN_ERROR);
    expect(last.message).toContain('停滞');
    expect(eventTypes(eventLog, session.id)).not.toContain(EventType.RUN_FINISHED);
    expect(sandbox.interruptSession).toHaveBeenCalledWith(session.id);
  });

  it('Runtime 关闭会等待模型 abort 后的终态事务完成', async () => {
    const { db, handle, runner, session } = await setup({
      hangUntilAbort: true,
      abortDelayMs: 40,
    });
    await runner.startTurn({
      session,
      definition: DEFINITION,
      text: '关闭中的慢取消轮次',
      log: silentLog,
    });
    await waitFor(() => handle.calls.length === 1);
    let disposed = false;
    const disposing = runner.dispose().then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(disposed).toBe(false);
    expect([...db.turns.values()].some((turn) => turn.status === 'running')).toBe(true);
    await disposing;
    expect([...db.turns.values()].every((turn) => turn.status !== 'running')).toBe(true);
  });

  it('Runtime 关闭会中止 Pi 并等待远程命令取消请求完成', async () => {
    const sandbox = sandboxFixture();
    let releaseCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    vi.mocked(sandbox.interruptSession).mockImplementation(async () => cancellation);
    const { db, handle, runner, session } = await setup({ hangUntilAbort: true }, 60_000, sandbox);
    await runner.startTurn({
      session,
      definition: DEFINITION,
      text: '关闭中的一轮',
      log: silentLog,
    });
    await waitFor(() => handle.calls.length === 1);
    let disposed = false;
    const disposing = runner.dispose().then(() => {
      disposed = true;
    });
    await waitFor(() => vi.mocked(sandbox.interruptSession).mock.calls.length === 1);
    expect(disposed).toBe(false);
    expect([...db.turns.values()].some((turn) => turn.status === 'running')).toBe(true);
    releaseCancellation();
    await disposing;
    expect(sandbox.interruptSession).toHaveBeenCalledWith(session.id);
    expect([...db.turns.values()].every((turn) => turn.status !== 'running')).toBe(true);
  });

  it('远程清理失联时按关闭时限返回，但保留 running 守卫且不冒充清理成功', async () => {
    const sandbox = sandboxFixture();
    vi.mocked(sandbox.interruptSession).mockImplementation(
      async () => new Promise<void>(() => undefined),
    );
    const { db, handle, runner, session } = await setup(
      { hangUntilAbort: true },
      60_000,
      sandbox,
      25,
    );
    await runner.startTurn({
      session,
      definition: DEFINITION,
      text: '远程取消失联的一轮',
      log: silentLog,
    });
    await waitFor(() => handle.calls.length === 1);
    const started = Date.now();
    await runner.dispose();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect([...db.turns.values()].some((turn) => turn.status === 'running')).toBe(true);
    const queryCountAtClose = db.queries.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(db.queries).toHaveLength(queryCountAtClose);
  });

  it('终态数据库连接黑洞也受同一个关闭截止时间约束并保留 running', async () => {
    const { db, handle, runner, session } = await setup(
      { hangUntilAbort: true },
      60_000,
      undefined,
      20,
    );
    await runner.startTurn({
      session,
      definition: DEFINITION,
      text: '关闭时数据库连接失联的一轮',
      log: silentLog,
    });
    await waitFor(() => handle.calls.length === 1);
    db.connect = async () => new Promise<never>(() => undefined);

    const started = Date.now();
    await runner.dispose();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect([...db.turns.values()].some((turn) => turn.status === 'running')).toBe(true);
    const queriesAtClose = db.queries.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(db.queries).toHaveLength(queriesAtClose);
  });

  it('模型 SDK 迟到结束时不会在 Runtime dispose 返回后再次访问数据库', async () => {
    const { db, handle, runner, session } = await setup(
      { hangUntilAbort: true, abortDelayMs: 100 },
      60_000,
      undefined,
      25,
    );
    await runner.startTurn({
      session,
      definition: DEFINITION,
      text: '忽略取消片刻的一轮',
      log: silentLog,
    });
    await waitFor(() => handle.calls.length === 1);
    await runner.dispose();
    expect([...db.turns.values()].every((turn) => turn.status !== 'running')).toBe(true);
    const queryCountAtClose = db.queries.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(db.queries).toHaveLength(queryCountAtClose);
  });
});

describe('run-turn 失败路径（失败落 failed 消息 + RUN_ERROR）', () => {
  it('终态 Redis 超时不回滚 DB，下一轮先修复旧终态且迟到完成保持幂等', async () => {
    const { db, eventLog, runner, session } = await setup(
      { finalMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] },
      60_000,
      undefined,
      undefined,
      undefined,
      20,
    );
    const appendTerminal = eventLog.appendTerminal.bind(eventLog);
    const repairTerminal = eventLog.repairTerminal.bind(eventLog);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let terminalCalls = 0;
    const statusAtAppend: Array<string | undefined> = [];
    const appendObserved = async (
      mode: 'strict' | 'repair',
      sessionId: string,
      runId: string,
      event: Record<string, unknown>,
    ): Promise<string> => {
      terminalCalls += 1;
      statusAtAppend.push(db.turns.get(runId)?.status);
      if (terminalCalls === 1) await blocked;
      return mode === 'repair'
        ? repairTerminal(sessionId, runId, event)
        : appendTerminal(sessionId, runId, event);
    };
    eventLog.appendTerminal = (sessionId, runId, event) =>
      appendObserved('strict', sessionId, runId, event);
    eventLog.repairTerminal = (sessionId, runId, event) =>
      appendObserved('repair', sessionId, runId, event);

    await runner.startTurn({
      session,
      definition: DEFINITION,
      text: '终态事件会超时的一轮',
      log: silentLog,
    });
    await waitFor(() => [...db.turns.values()][0]?.status === 'completed');
    const firstRunId = [...db.turns.values()][0]!.id;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(eventLog.entries(session.id).map((entry) => entry.event.type)).toEqual([
      EventType.RUN_STARTED,
    ]);

    await runner.startTurn({
      session,
      definition: DEFINITION,
      text: '紧接着的新一轮',
      log: silentLog,
    });
    await waitFor(() => [...db.turns.values()].every((turn) => turn.status !== 'running'));
    const secondRunId = [...db.turns.values()].find((turn) => turn.id !== firstRunId)!.id;

    release();
    await waitFor(() => terminalCalls >= 3);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const entries = eventLog.entries(session.id);
    const firstTerminals = entries.filter(
      (entry) => entry.event.runId === firstRunId && entry.event.type === EventType.RUN_FINISHED,
    );
    const secondStarted = entries.find(
      (entry) => entry.event.runId === secondRunId && entry.event.type === EventType.RUN_STARTED,
    );
    expect(statusAtAppend.every((status) => status === 'completed')).toBe(true);
    expect(firstTerminals).toHaveLength(1);
    expect(secondStarted).toBeTruthy();
    expect(compareStreamIds(firstTerminals[0]!.id, secondStarted!.id)).toBeLessThan(0);
    expect(entries.filter((entry) => entry.event.type === EventType.RUN_ERROR)).toHaveLength(0);
    await runner.dispose();
  });

  it('completed 的数据库提交失败时只由已提交的 failed 终态追加 RUN_ERROR', async () => {
    const { db, eventLog, runner, session } = await setup({
      finalMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
    });
    const query = db.query.bind(db);
    db.query = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('UPDATE turns SET status = $2') && params[1] === 'completed') {
        throw new Error('database write failed before terminal commit');
      }
      return query<R>(sql, params);
    };

    await runner.startTurn({
      session,
      definition: DEFINITION,
      text: '数据库提交前失败的一轮',
      log: silentLog,
    });
    await waitFor(() => [...db.turns.values()][0]?.status === 'failed');
    const terminals = eventLog
      .entries(session.id)
      .filter((entry) =>
        [EventType.RUN_FINISHED, EventType.RUN_ERROR].includes(entry.event.type as never),
      );
    expect(terminals.map((entry) => entry.event.type)).toEqual([EventType.RUN_ERROR]);
    expect([...db.turns.values()][0]?.status).toBe('failed');
    await runner.dispose();
  });

  it('所有终态数据库提交都失败时保留 running 且不提前创建 Redis 终态', async () => {
    const { db, eventLog, runner, session } = await setup({
      finalMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
    });
    const query = db.query.bind(db);
    db.query = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('UPDATE turns SET status = $2')) {
        throw new Error('database terminal commit unavailable');
      }
      return query<R>(sql, params);
    };

    await runner.startTurn({
      session,
      definition: DEFINITION,
      text: '数据库始终失败的一轮',
      log: silentLog,
    });
    await waitFor(() => db.txLog.filter((entry) => entry === 'ROLLBACK').length >= 2);
    expect([...db.turns.values()][0]?.status).toBe('running');
    expect(
      eventLog
        .entries(session.id)
        .filter((entry) =>
          [EventType.RUN_FINISHED, EventType.RUN_ERROR].includes(entry.event.type as never),
        ),
    ).toHaveLength(0);
    await runner.dispose();
  });

  it('agent.prompt 抛错', async () => {
    const { db, eventLog, runner, session } = await setup({ promptError: new Error('llm down') });
    await runToIdle(runner, db, session);

    const failed = db.messages.find((m) => m.role === 'assistant');
    expect(failed?.status).toBe('failed');
    expect(failed?.content).toEqual([{ type: 'text', text: '对话生成失败，请重试。' }]);
    expect(eventTypes(eventLog, session.id).at(-1)).toBe(EventType.RUN_ERROR);
  });

  it('pi 把失败编码进消息（runtimeError）', async () => {
    const { db, runner, session } = await setup({ runtimeError: 'credit exhausted' });
    await runToIdle(runner, db, session);

    const failed = db.messages.find((m) => m.role === 'assistant');
    expect(failed?.status).toBe('failed');
    expect(failed?.content).toEqual([
      { type: 'text', text: '模型调用失败（额度/网络/服务波动），请重试。' },
    ]);
  });

  it('agent 工厂不可用（未配置模型密钥）→ 人话进 failed 消息', async () => {
    const db = new FakeDb();
    const cap = db.seedCapability({ owner_user_id: ME });
    const session = await createSession(db, { capabilityId: cap.id, ownerUserId: ME });
    const runner = createTurnRunner({
      db,
      objectStore: new FakeObjectStore(),
      bus: createSessionEventBus(),
      eventLog: new FakeSessionEventLog(),
      agentFactory: () => {
        throw new TurnAgentUnavailableError('试用服务未配置模型密钥，暂时无法对话。');
      },
      idleTimeoutMs: 60_000,
      interrupts: createInterruptBus(),
      log: silentLog,
    });
    const result = await runner.startTurn({
      session,
      definition: DEFINITION,
      text: 'hi',
      log: silentLog,
    });
    expect(result.status).toBe('started');
    await waitFor(() => [...db.turns.values()].every((turn) => turn.status !== 'running'));

    const failed = db.messages.find((m) => m.role === 'assistant');
    expect(failed?.status).toBe('failed');
    expect(failed?.content).toEqual([
      { type: 'text', text: '试用服务未配置模型密钥，暂时无法对话。' },
    ]);
  });
});
