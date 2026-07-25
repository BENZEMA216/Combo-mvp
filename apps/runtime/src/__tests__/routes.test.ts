// 路由注册自检 + session 端点 owner 守卫（非本人与不存在同样 404，不暴露存在性）。
import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { ALL_ENDPOINTS } from '../bootstrap/routes.js';
import {
  archiveSessionHandler,
  createSessionHandler,
  createStudioSessionHandler,
  getSessionDetailHandler,
  interruptHandler,
  listSessionsHandler,
  sendMessageHandler,
  updateSessionHandler,
} from '../modules/session/handlers.js';
import { CAPABILITY_BUCKET } from '../modules/capability/loader.js';
import { artifactContentHandler } from '../modules/artifact/handlers.js';
import { createArtifactTool } from '../modules/artifact/tool.js';
import {
  ARTIFACT_BUCKET,
  artifactStorageKey,
  bindCapabilityUiArtifact,
} from '../modules/artifact/repo.js';
import {
  archiveSession as archiveSessionRow,
  appendTurnMessage,
  createSession,
  getOrCreateStudioSession,
} from '../modules/session/repo.js';
import { createTurn, finishTurnCas } from '../modules/agent/turn-repo.js';
import { createTurnRunner } from '../modules/agent/run-turn.js';
import { createSessionEventBus } from '../platform/infra/event-bus.js';
import { createInterruptBus } from '../platform/infra/redis-interrupt-bus.js';
import type { SandboxBackend } from '../platform/infra/sandbox-backend.js';
import {
  FakeDb,
  FakeObjectStore,
  FakeSessionEventLog,
  makeFakeAgentFactory,
  silentLog,
} from './fakes.js';

const ME = 'user-me';
const OTHER = 'user-other';
let directArtifactTurnSequence = 0;

async function createDirectArtifactTool(input: {
  db: FakeDb;
  store: FakeObjectStore;
  sessionId: string;
  capabilityId?: string;
  mode?: 'consume' | 'studio';
}) {
  directArtifactTurnSequence += 1;
  const turnId = `route-artifact-turn-${directArtifactTurnSequence}`;
  await createTurn(input.db, { id: turnId, sessionId: input.sessionId });
  const controller = new AbortController();
  return {
    turnId,
    tool: createArtifactTool({
      db: input.db,
      objectStore: input.store,
      sessionId: input.sessionId,
      turnId,
      turnSignal: controller.signal,
      ...(input.capabilityId ? { capabilityId: input.capabilityId } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      onArtifact: () => undefined,
    }),
    finish: () => finishTurnCas(input.db, { id: turnId, status: 'completed' }),
  };
}

describe('route registry self-check', () => {
  it('registers exactly 11 endpoints (capability 1 + session 9 + artifact 1)', () => {
    expect(ALL_ENDPOINTS).toHaveLength(11);
  });

  it('no duplicate (method,url) pairs', () => {
    const seen = new Set<string>();
    for (const ep of ALL_ENDPOINTS) {
      const key = `${String(ep.method)} ${ep.url}`;
      expect(seen.has(key), `duplicate route: ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('所有端点都带鉴权守卫（runtime 无匿名路径）', () => {
    for (const ep of ALL_ENDPOINTS) {
      expect(
        (ep.preHandlers ?? []).length,
        `${String(ep.method)} ${ep.url} 缺守卫`,
      ).toBeGreaterThan(0);
    }
  });
});

// ───────────────────────────── handler 级 owner 守卫 ─────────────────────────────

interface Captured {
  statusCode: number;
  body: unknown;
}

function makeReply(): FastifyReply {
  const reply = {
    statusCode: 0,
    body: undefined as unknown,
    code(n: number) {
      this.statusCode = n;
      return this;
    },
    send(b: unknown) {
      this.body = b;
      return this;
    },
    type() {
      return this;
    },
  };
  return reply as unknown as FastifyReply;
}

function makeReq(input: {
  db: FakeDb;
  objectStore?: FakeObjectStore;
  userId: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  sandbox?: SandboxBackend;
}): FastifyRequest {
  const turns = createTurnRunner({
    db: input.db,
    objectStore: input.objectStore ?? new FakeObjectStore(),
    bus: createSessionEventBus(),
    eventLog: new FakeSessionEventLog(),
    agentFactory: makeFakeAgentFactory().factory,
    idleTimeoutMs: 60_000,
    interrupts: createInterruptBus(),
    log: silentLog,
  });
  return {
    id: 'trace-test',
    auth: { userId: input.userId, account: 'tester', roles: ['creator'] },
    params: input.params ?? {},
    query: input.query ?? {},
    body: input.body,
    log: { ...silentLog, info: () => undefined, warn: () => undefined },
    server: {
      infra: {
        db: input.db,
        objectStore: input.objectStore ?? new FakeObjectStore(),
        ...(input.sandbox ? { sandbox: input.sandbox } : {}),
      },
      turns,
    },
  } as unknown as FastifyRequest;
}

async function call(handler: RouteHandlerMethod, req: FastifyRequest): Promise<Captured> {
  const reply = makeReply();
  await (handler as unknown as (rq: FastifyRequest, rp: FastifyReply) => Promise<unknown>)(
    req,
    reply,
  );
  return reply as unknown as Captured;
}

async function seedOwnedSession(db: FakeDb, owner: string): Promise<string> {
  const cap = db.seedCapability({ owner_user_id: owner });
  const session = await createSession(db, { capabilityId: cap.id, ownerUserId: owner });
  return session.id;
}

function seedRunnableDefinition(store: FakeObjectStore, cap: ReturnType<FakeDb['seedCapability']>) {
  store.seedText(
    CAPABILITY_BUCKET,
    cap.storage_key,
    JSON.stringify({
      version: 1,
      name: cap.name,
      summary: cap.summary,
      kind: cap.kind,
      instructions: '执行任务',
      inputs: [],
      starterPrompts: [],
    }),
  );
}

describe('POST /runtime/studio/sessions', () => {
  it('同一创作者与 Agent 重试时复用同一 active Studio 会话', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const cap = db.seedCapability({ id: CAP_A, owner_user_id: ME });
    seedRunnableDefinition(store, cap);

    const first = await call(
      createStudioSessionHandler(),
      makeReq({ db, objectStore: store, userId: ME, body: { capabilityId: cap.id } }),
    );
    const second = await call(
      createStudioSessionHandler(),
      makeReq({ db, objectStore: store, userId: ME, body: { capabilityId: cap.id } }),
    );

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstSession = (
      first.body as { data: { session: { id: string; capabilityId: string; mode: string } } }
    ).data.session;
    const secondSession = (
      second.body as { data: { session: { id: string; capabilityId: string; mode: string } } }
    ).data.session;
    expect(firstSession).toMatchObject({ capabilityId: cap.id, mode: 'studio' });
    expect(secondSession.id).toBe(firstSession.id);
    expect([...db.sessions.values()].filter((row) => row.mode === 'studio')).toHaveLength(1);
  });

  it('已发布 Agent 也只有创作者本人能进入 Studio', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const cap = db.seedCapability({ id: CAP_A, owner_user_id: OTHER, published: true });
    seedRunnableDefinition(store, cap);

    const reply = await call(
      createStudioSessionHandler(),
      makeReq({ db, objectStore: store, userId: ME, body: { capabilityId: cap.id } }),
    );

    expect(reply.statusCode).toBe(404);
    expect(db.sessions.size).toBe(0);
  });

  it('旧 Studio 归档后重新进入，会从 capability 当前 UI 恢复到新 Studio', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const cap = db.seedCapability({ id: CAP_A, owner_user_id: ME });
    seedRunnableDefinition(store, cap);
    const first = await getOrCreateStudioSession(db, {
      capabilityId: cap.id,
      ownerUserId: ME,
    });
    const direct = await createDirectArtifactTool({
      db,
      store,
      sessionId: first.id,
      capabilityId: cap.id,
      mode: 'studio',
    });
    const html = `<!doctype html><html><head><style>button{color:red}</style></head><body>
      <button data-combo-key="run-primary">运行</button><script>
      const prompt = '真实任务'; parent.postMessage({type:'combo:run',version:1,prompt}, '*');
      </script></body></html>`;
    const firstRevision = await direct.tool.execute('tc-studio', {
      kind: 'html',
      title: 'Agent UI',
      content: html,
    });
    await direct.finish();
    await bindCapabilityUiArtifact(db, {
      capabilityId: cap.id,
      artifactId: firstRevision.details!.artifactId,
      studioSessionId: first.id,
      turnId: direct.turnId,
    });
    await archiveSessionRow(db, first.id, ME);

    const reply = await call(
      createStudioSessionHandler(),
      makeReq({ db, objectStore: store, userId: ME, body: { capabilityId: cap.id } }),
    );
    expect(reply.statusCode).toBe(200);
    const restored = (reply.body as { data: { session: { id: string; mode: string } } }).data
      .session;
    expect(restored).toMatchObject({ mode: 'studio' });
    expect(restored.id).not.toBe(first.id);
    const restoredArtifact = [...db.artifacts.values()].find(
      (artifact) => artifact.session_id === restored.id,
    );
    expect(restoredArtifact).toBeTruthy();
    expect(
      await store.getObjectText(
        ARTIFACT_BUCKET as never,
        artifactStorageKey(restored.id, restoredArtifact!.id),
      ),
    ).toBe(html);

    const detailReply = await call(
      getSessionDetailHandler(),
      makeReq({ db, objectStore: store, userId: ME, params: { id: restored.id } }),
    );
    const detail = (
      detailReply.body as {
        data: {
          currentUiArtifactId: string | null;
          artifacts: Array<{ id: string; sourceArtifactId?: string }>;
        };
      }
    ).data;
    expect(detail.currentUiArtifactId).toBe(restoredArtifact!.id);
    expect(detail.artifacts[0]).toMatchObject({
      id: restoredArtifact!.id,
      sourceArtifactId: firstRevision.details!.artifactId,
    });
  });

  it('首次进入只迁移同 Agent、同 owner 且通过运行契约的旧 consume HTML', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const cap = db.seedCapability({ id: CAP_A, owner_user_id: ME });
    seedRunnableDefinition(store, cap);
    const legacy = await createSession(db, { capabilityId: cap.id, ownerUserId: ME });
    const validHtml = `<!doctype html><html><head><style>body{margin:0}</style></head><body>
      <input id="goal"><button data-combo-key="run-primary">运行</button><script>
      const prompt = document.querySelector('#goal').value;
      window.parent.postMessage({type:'combo:run',version:1,prompt}, '*');
      </script></body></html>`;
    const legacyTool = await createDirectArtifactTool({
      db,
      store,
      sessionId: legacy.id,
      mode: 'consume',
    });
    const valid = await legacyTool.tool.execute('legacy-valid', {
      kind: 'html',
      title: '旧版 Agent UI',
      content: validHtml,
    });
    const invalid = await legacyTool.tool.execute('legacy-invalid', {
      kind: 'html',
      title: '普通 HTML 报告',
      content: '<!doctype html><html><body>普通报告</body></html>',
    });
    await legacyTool.finish();
    db.artifacts.get(valid.details!.artifactId)!.created_at = '2026-07-20T00:00:00.000Z';
    db.artifacts.get(valid.details!.artifactId)!.updated_at = '2026-07-20T00:00:00.000Z';
    db.artifacts.get(invalid.details!.artifactId)!.created_at = '2026-07-21T00:00:00.000Z';
    db.artifacts.get(invalid.details!.artifactId)!.updated_at = '2026-07-21T00:00:00.000Z';

    const reply = await call(
      createStudioSessionHandler(),
      makeReq({ db, objectStore: store, userId: ME, body: { capabilityId: cap.id } }),
    );
    expect(reply.statusCode).toBe(200);
    const studioId = (reply.body as { data: { session: { id: string } } }).data.session.id;
    const adoptedId = db.capabilities.get(cap.id)?.ui_artifact_id;
    expect(adoptedId).toBeTruthy();
    const adopted = db.artifacts.get(adoptedId!);
    expect(adopted).toMatchObject({
      session_id: studioId,
      meta: expect.objectContaining({
        adoption: 'existing-owner-consume-html',
        sourceArtifactId: valid.details!.artifactId,
      }),
    });
    expect(await store.getObjectText(ARTIFACT_BUCKET as never, adopted!.storage_key)).toBe(
      validHtml,
    );
  });

  it('Studio seed 瞬时失败时保留复用会话为 active，供下次幂等重试', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const cap = db.seedCapability({ id: CAP_A, owner_user_id: ME });
    seedRunnableDefinition(store, cap);
    const studio = await getOrCreateStudioSession(db, {
      capabilityId: cap.id,
      ownerUserId: ME,
    });
    const query = db.query.bind(db);
    let failed = false;
    db.query = (async (sql: string, params?: unknown[]) => {
      if (!failed && sql.includes('FROM artifacts') && sql.includes("kind = 'html'")) {
        failed = true;
        throw new Error('transient db read failure');
      }
      return query(sql, params);
    }) as typeof db.query;

    const reply = await call(
      createStudioSessionHandler(),
      makeReq({ db, objectStore: store, userId: ME, body: { capabilityId: cap.id } }),
    );
    expect(reply.statusCode).toBe(500);
    expect(db.sessions.get(studio.id)?.status).toBe('active');
  });
});

describe('POST /runtime/sessions capability UI 快照', () => {
  it('有当前 UI 时新 consume 自动复制；无当前 UI 时仍正常创建空会话', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const withUi = db.seedCapability({ id: CAP_A, owner_user_id: ME, published: true });
    const withoutUi = db.seedCapability({ id: CAP_B, owner_user_id: ME });
    seedRunnableDefinition(store, withUi);
    seedRunnableDefinition(store, withoutUi);
    const studio = await getOrCreateStudioSession(db, {
      capabilityId: withUi.id,
      ownerUserId: ME,
    });
    const html = `<!doctype html><html><head><style>body{margin:0}</style></head><body>
      <button data-combo-key="run-primary">运行</button><script>
      const prompt = '真实任务'; window.parent.postMessage({type:'combo:run',version:1,prompt}, '*');
      </script></body></html>`;
    const currentTool = await createDirectArtifactTool({
      db,
      store,
      sessionId: studio.id,
      capabilityId: withUi.id,
      mode: 'studio',
    });
    const currentRevision = await currentTool.tool.execute('tc-studio', {
      kind: 'html',
      title: 'Agent UI',
      content: html,
    });
    await currentTool.finish();
    await bindCapabilityUiArtifact(db, {
      capabilityId: withUi.id,
      artifactId: currentRevision.details!.artifactId,
      studioSessionId: studio.id,
      turnId: currentTool.turnId,
    });

    const seeded = await call(
      createSessionHandler(),
      makeReq({ db, objectStore: store, userId: OTHER, body: { capabilityId: withUi.id } }),
    );
    expect(seeded.statusCode).toBe(201);
    const seededSessionId = (seeded.body as { data: { id: string } }).data.id;
    const snapshot = [...db.artifacts.values()].find(
      (artifact) => artifact.session_id === seededSessionId,
    );
    expect(snapshot).toBeTruthy();
    expect(
      await store.getObjectText(
        ARTIFACT_BUCKET as never,
        artifactStorageKey(seededSessionId, snapshot!.id),
      ),
    ).toBe(html);

    const compatible = await call(
      createSessionHandler(),
      makeReq({ db, objectStore: store, userId: ME, body: { capabilityId: withoutUi.id } }),
    );
    expect(compatible.statusCode).toBe(201);
    const compatibleId = (compatible.body as { data: { id: string } }).data.id;
    expect(
      [...db.artifacts.values()].filter((artifact) => artifact.session_id === compatibleId),
    ).toHaveLength(0);
  });
});

describe('session 端点 owner 守卫', () => {
  it('GET /runtime/sessions/:id：本人 200，非本人 404', async () => {
    const db = new FakeDb();
    const sessionId = await seedOwnedSession(db, ME);

    const mine = await call(
      getSessionDetailHandler(),
      makeReq({ db, userId: ME, params: { id: sessionId } }),
    );
    expect(mine.statusCode).toBe(200);

    const theirs = await call(
      getSessionDetailHandler(),
      makeReq({ db, userId: OTHER, params: { id: sessionId } }),
    );
    expect(theirs.statusCode).toBe(404);
    // 404 也是完整 ErrorEnvelope（无 code 字段）。
    const body = theirs.body as { error?: Record<string, unknown> };
    expect(body.error?.userMessage).toBeTruthy();
    expect(body.error && 'code' in body.error).toBe(false);
  });

  it('GET /runtime/sessions/:id：透出消息 turnId 供前端按轮展示', async () => {
    const db = new FakeDb();
    const sessionId = await seedOwnedSession(db, ME);
    const turnId = '11111111-1111-4111-8111-111111111111';
    await createTurn(db, { id: turnId, sessionId });
    await appendTurnMessage(db, {
      sessionId,
      turnId,
      idx: 0,
      role: 'user',
      content: [{ type: 'text', text: '收紧页面间距' }],
    });
    await finishTurnCas(db, { id: turnId, status: 'completed' });

    const reply = await call(
      getSessionDetailHandler(),
      makeReq({ db, userId: ME, params: { id: sessionId } }),
    );

    expect(reply.statusCode).toBe(200);
    expect(
      (reply.body as { data: { messages: Array<{ turnId?: string }> } }).data.messages[0],
    ).toMatchObject({ turnId });
  });

  it('GET /runtime/sessions/:id：从 PostgreSQL 返回 active Turn，终态后清空', async () => {
    const db = new FakeDb();
    const sessionId = await seedOwnedSession(db, ME);
    const turnId = '22222222-2222-4222-8222-222222222222';
    const turn = await createTurn(db, { id: turnId, sessionId });

    const running = await call(
      getSessionDetailHandler(),
      makeReq({ db, userId: ME, params: { id: sessionId } }),
    );
    expect(
      (running.body as { data: { activeTurn: { id: string; createdAt: string } | null } }).data
        .activeTurn,
    ).toEqual({ id: turnId, createdAt: turn.createdAt });

    await finishTurnCas(db, { id: turnId, status: 'interrupted' });
    const terminal = await call(
      getSessionDetailHandler(),
      makeReq({ db, userId: ME, params: { id: sessionId } }),
    );
    expect(
      (terminal.body as { data: { activeTurn: { id: string } | null } }).data.activeTurn,
    ).toBeNull();
  });

  it('Studio 详情只保留种子、completed 最终 revision 和 active 最新候选', async () => {
    const db = new FakeDb();
    const cap = db.seedCapability({ owner_user_id: ME });
    const studio = await getOrCreateStudioSession(db, {
      capabilityId: cap.id,
      ownerUserId: ME,
    });
    const baseTime = Date.parse('2026-07-25T00:00:00.000Z');
    const addTurn = (
      id: string,
      status: 'running' | 'completed' | 'failed' | 'interrupted',
      offset: number,
    ) => {
      db.turns.set(id, {
        id,
        session_id: studio.id,
        status,
        last_error: null,
        created_at: new Date(baseTime + offset).toISOString(),
        finished_at: status === 'running' ? null : new Date(baseTime + offset + 1).toISOString(),
      });
    };
    addTurn('turn-completed', 'completed', 100);
    addTurn('turn-failed', 'failed', 200);
    addTurn('turn-running', 'running', 300);
    const addArtifact = (id: string, turnId: string | null, offset: number) => {
      const timestamp = new Date(baseTime + offset).toISOString();
      db.artifacts.set(id, {
        id,
        session_id: studio.id,
        turn_id: turnId,
        kind: 'html',
        title: id,
        storage_key: `artifacts/${studio.id}/${id}`,
        meta: {},
        created_at: timestamp,
        updated_at: timestamp,
      });
    };
    addArtifact('seed', null, 10);
    addArtifact('completed-early', 'turn-completed', 110);
    addArtifact('completed-final', 'turn-completed', 120);
    addArtifact('failed-final', 'turn-failed', 210);
    addArtifact('running-early', 'turn-running', 310);
    addArtifact('running-latest', 'turn-running', 320);
    cap.ui_artifact_id = 'completed-final';

    const reply = await call(
      getSessionDetailHandler(),
      makeReq({ db, userId: ME, params: { id: studio.id } }),
    );
    const detail = (
      reply.body as {
        data: {
          artifacts: Array<{
            id: string;
            sourceTurnId?: string;
            createdAt: string;
          }>;
          activeTurn: { id: string } | null;
          currentUiArtifactId: string | null;
        };
      }
    ).data;

    expect(detail.artifacts.map((artifact) => artifact.id)).toEqual([
      'seed',
      'completed-final',
      'running-latest',
    ]);
    expect(detail.artifacts[1]).toMatchObject({
      sourceTurnId: 'turn-completed',
      createdAt: new Date(baseTime + 120).toISOString(),
    });
    expect(detail.activeTurn).toMatchObject({ id: 'turn-running' });
    expect(detail.currentUiArtifactId).toBe('completed-final');
  });

  it('GET /runtime/sessions/:id：透出 Agent 当前 UI 指针，区分落库 revision 与已保存 UI', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const cap = db.seedCapability({ owner_user_id: ME });
    seedRunnableDefinition(store, cap);
    const studio = await getOrCreateStudioSession(db, {
      capabilityId: cap.id,
      ownerUserId: ME,
    });
    const turnId = 'detail-ui-pointer-turn';
    const turnController = new AbortController();
    const now = new Date().toISOString();
    db.turns.set(turnId, {
      id: turnId,
      session_id: studio.id,
      status: 'running',
      last_error: null,
      created_at: now,
      finished_at: null,
    });
    const revision = await createArtifactTool({
      db,
      objectStore: store,
      sessionId: studio.id,
      turnId,
      turnSignal: turnController.signal,
      capabilityId: cap.id,
      mode: 'studio',
      onArtifact: () => undefined,
    }).execute('detail-ui-pointer', {
      kind: 'html',
      title: 'Agent 当前 UI',
      content: `<!doctype html><html><head><style>button{color:red}</style></head><body>
        <input id="goal"><button data-combo-key="run-primary">运行</button>
        <script>
          document.querySelector('[data-combo-key="run-primary"]').addEventListener('click', () => {
            const prompt = document.querySelector('#goal').value.trim();
            parent.postMessage({type:'combo:run',version:1,prompt}, '*');
          });
        </script>
      </body></html>`,
    });
    db.turns.get(turnId)!.status = 'completed';
    await bindCapabilityUiArtifact(db, {
      capabilityId: cap.id,
      artifactId: revision.details!.artifactId,
      studioSessionId: studio.id,
      turnId,
    });

    const reply = await call(
      getSessionDetailHandler(),
      makeReq({ db, objectStore: store, userId: ME, params: { id: studio.id } }),
    );

    expect(reply.statusCode).toBe(200);
    expect(
      (reply.body as { data: { currentUiArtifactId: string | null } }).data.currentUiArtifactId,
    ).toBe(revision.details!.artifactId);

    const consumer = await createSession(db, {
      capabilityId: cap.id,
      ownerUserId: OTHER,
    });
    const consumerReply = await call(
      getSessionDetailHandler(),
      makeReq({ db, objectStore: store, userId: OTHER, params: { id: consumer.id } }),
    );
    expect(
      (consumerReply.body as { data: { currentUiArtifactId: string | null } }).data
        .currentUiArtifactId,
    ).toBeNull();
  });

  it('POST /runtime/sessions/:id/messages：非本人 404，且不落 user 消息', async () => {
    const db = new FakeDb();
    const sessionId = await seedOwnedSession(db, ME);
    const reply = await call(
      sendMessageHandler(),
      makeReq({ db, userId: OTHER, params: { id: sessionId }, body: { text: '你好' } }),
    );
    expect(reply.statusCode).toBe(404);
    expect(db.messages).toHaveLength(0);
  });

  it('POST /runtime/sessions/:id/messages：202 user 消息同步透出 turnId', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const cap = db.seedCapability({ owner_user_id: ME });
    store.seedText(
      CAPABILITY_BUCKET,
      cap.storage_key,
      JSON.stringify({
        version: 1,
        name: cap.name,
        summary: cap.summary,
        kind: cap.kind,
        instructions: '执行任务',
        inputs: [],
        starterPrompts: [],
      }),
    );
    const session = await createSession(db, { capabilityId: cap.id, ownerUserId: ME });

    const reply = await call(
      sendMessageHandler(),
      makeReq({
        db,
        objectStore: store,
        userId: ME,
        params: { id: session.id },
        body: { text: '收紧页面间距' },
      }),
    );

    expect(reply.statusCode).toBe(202);
    expect(
      (reply.body as { data: { message: { turnId?: string } } }).data.message.turnId,
    ).toBeTruthy();
  });

  it('POST /runtime/sessions/:id/messages：已有 running Turn 时返回现有 SESSION_BUSY 409', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const sessionId = await seedOwnedSession(db, ME);
    const session = db.sessions.get(sessionId)!;
    const capability = db.capabilities.get(session.capability_id)!;
    store.seedText(
      CAPABILITY_BUCKET,
      capability.storage_key,
      JSON.stringify({
        version: 1,
        name: '测试能力',
        summary: '测试',
        kind: 'writing',
        instructions: '测试',
        inputs: [],
        starterPrompts: [],
        meta: {},
      }),
    );
    await createTurn(db, { id: 'turn-running', sessionId });

    const reply = await call(
      sendMessageHandler(),
      makeReq({
        db,
        objectStore: store,
        userId: ME,
        params: { id: sessionId },
        body: { text: '第二条' },
      }),
    );
    expect(reply.statusCode).toBe(409);
    expect((reply.body as { error: { userMessage: string } }).error.userMessage).toContain(
      '等待完成后再发送',
    );
    expect(db.turns.size).toBe(1);
  });

  it('POST /runtime/sessions/:id/interrupt：非本人 404', async () => {
    const db = new FakeDb();
    const sessionId = await seedOwnedSession(db, ME);
    const reply = await call(
      interruptHandler(),
      makeReq({ db, userId: OTHER, params: { id: sessionId } }),
    );
    expect(reply.statusCode).toBe(404);
  });

  it('PATCH /runtime/sessions/:id：本人可改名，非本人 404', async () => {
    const db = new FakeDb();
    const sessionId = await seedOwnedSession(db, ME);

    const mine = await call(
      updateSessionHandler(),
      makeReq({ db, userId: ME, params: { id: sessionId }, body: { title: '  项目复盘  ' } }),
    );
    expect(mine.statusCode).toBe(200);
    expect((mine.body as { data: { title: string } }).data.title).toBe('项目复盘');

    const theirs = await call(
      updateSessionHandler(),
      makeReq({ db, userId: OTHER, params: { id: sessionId }, body: { title: '篡改' } }),
    );
    expect(theirs.statusCode).toBe(404);
    expect(db.sessions.get(sessionId)?.title).toBe('项目复盘');
  });

  it('PATCH /runtime/sessions/:id：拒绝空标题和超长标题', async () => {
    const db = new FakeDb();
    const sessionId = await seedOwnedSession(db, ME);
    for (const title of ['   ', 'a'.repeat(61)]) {
      const reply = await call(
        updateSessionHandler(),
        makeReq({ db, userId: ME, params: { id: sessionId }, body: { title } }),
      );
      expect(reply.statusCode).toBe(400);
    }
    expect(db.sessions.get(sessionId)?.title).toBeNull();
  });

  it('DELETE /runtime/sessions/:id：本人软归档，非本人 404', async () => {
    const db = new FakeDb();
    const sessionId = await seedOwnedSession(db, ME);

    const theirs = await call(
      archiveSessionHandler(),
      makeReq({ db, userId: OTHER, params: { id: sessionId } }),
    );
    expect(theirs.statusCode).toBe(404);
    expect(db.sessions.get(sessionId)?.status).toBe('active');

    const mine = await call(
      archiveSessionHandler(),
      makeReq({ db, userId: ME, params: { id: sessionId } }),
    );
    expect(mine.statusCode).toBe(200);
    expect((mine.body as { data: { status: string } }).data.status).toBe('closed');
    expect(db.sessions.get(sessionId)?.status).toBe('closed');
  });

  it('DELETE /runtime/sessions/:id：归档成功不等待卡住的沙箱回收', async () => {
    const db = new FakeDb();
    const sessionId = await seedOwnedSession(db, ME);
    const releaseSession = vi.fn(() => new Promise<void>(() => undefined));
    const sandbox = { enabled: true, releaseSession } as unknown as SandboxBackend;

    const result = await Promise.race([
      call(
        archiveSessionHandler(),
        makeReq({ db, userId: ME, params: { id: sessionId }, sandbox }),
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
    ]);

    expect(result?.statusCode).toBe(200);
    expect(releaseSession).toHaveBeenCalledWith(sessionId);
    expect(db.sessions.get(sessionId)?.status).toBe('closed');
  });

  it('DELETE /runtime/sessions/:id：功能关闭时不触发任何沙箱回收调用', async () => {
    const db = new FakeDb();
    const sessionId = await seedOwnedSession(db, ME);
    const releaseSession = vi.fn(async () => undefined);
    const sandbox = { enabled: false, releaseSession } as unknown as SandboxBackend;

    const result = await call(
      archiveSessionHandler(),
      makeReq({ db, userId: ME, params: { id: sessionId }, sandbox }),
    );

    expect(result.statusCode).toBe(200);
    expect(releaseSession).not.toHaveBeenCalled();
  });

  it('DELETE /runtime/sessions/:id：运行中返回 SESSION_BUSY 对应的 409 且保持 active', async () => {
    const db = new FakeDb();
    const sessionId = await seedOwnedSession(db, ME);
    await createTurn(db, { id: 'turn-running', sessionId });

    const reply = await call(
      archiveSessionHandler(),
      makeReq({ db, userId: ME, params: { id: sessionId } }),
    );

    expect(reply.statusCode).toBe(409);
    expect((reply.body as { error: { userMessage: string } }).error.userMessage).toContain(
      '等待完成后再归档',
    );
    expect(db.sessions.get(sessionId)?.status).toBe('active');
  });

  it('GET /runtime/artifacts/:id/content：非本人 404', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const sessionId = await seedOwnedSession(db, ME);
    db.artifacts.set('art-1', {
      id: 'art-1',
      session_id: sessionId,
      kind: 'html',
      title: 'demo',
      storage_key: `artifacts/${sessionId}/art-1`,
      meta: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    store.seedText('combo-artifacts', `artifacts/${sessionId}/art-1`, '<!doctype html>');

    const theirs = await call(
      artifactContentHandler(),
      makeReq({ db, objectStore: store, userId: OTHER, params: { id: 'art-1' } }),
    );
    expect(theirs.statusCode).toBe(404);

    const mine = await call(
      artifactContentHandler(),
      makeReq({ db, objectStore: store, userId: ME, params: { id: 'art-1' } }),
    );
    expect(mine.statusCode).toBe(200);
    expect(mine.body).toBe('<!doctype html>');
  });
});

// ───────────────────────────── 会话列表能力过滤 + 详情表单字段 ─────────────────────────────

const CAP_A = '11111111-1111-4111-8111-111111111111';
const CAP_B = '22222222-2222-4222-8222-222222222222';

describe('GET /runtime/sessions 按能力过滤', () => {
  it('带 capabilityId 只回该能力下的会话；不带回全部', async () => {
    const db = new FakeDb();
    db.seedCapability({ id: CAP_A, owner_user_id: ME });
    db.seedCapability({ id: CAP_B, owner_user_id: ME });
    await createSession(db, { capabilityId: CAP_A, ownerUserId: ME });
    await createSession(db, { capabilityId: CAP_A, ownerUserId: ME });
    await createSession(db, { capabilityId: CAP_B, ownerUserId: ME });
    const studio = await getOrCreateStudioSession(db, { capabilityId: CAP_A, ownerUserId: ME });

    const all = await call(listSessionsHandler(), makeReq({ db, userId: ME }));
    expect(all.statusCode).toBe(200);
    expect((all.body as { data: unknown[] }).data).toHaveLength(3);

    const onlyA = await call(
      listSessionsHandler(),
      makeReq({ db, userId: ME, query: { capabilityId: CAP_A } }),
    );
    expect(onlyA.statusCode).toBe(200);
    const items = (onlyA.body as { data: { capabilityId: string }[] }).data;
    expect(items).toHaveLength(2);
    expect(items.every((s) => s.capabilityId === CAP_A)).toBe(true);

    const studioOnly = await call(
      listSessionsHandler(),
      makeReq({ db, userId: ME, query: { capabilityId: CAP_A, mode: 'studio' } }),
    );
    expect(studioOnly.statusCode).toBe(200);
    expect((studioOnly.body as { data: { id: string; mode: string }[] }).data).toEqual([
      expect.objectContaining({ id: studio.id, mode: 'studio' }),
    ]);
  });

  it('默认只回 active 会话', async () => {
    const db = new FakeDb();
    db.seedCapability({ id: CAP_A, owner_user_id: ME });
    const active = await createSession(db, { capabilityId: CAP_A, ownerUserId: ME });
    const archived = await createSession(db, { capabilityId: CAP_A, ownerUserId: ME });
    db.sessions.get(archived.id)!.status = 'closed';

    const reply = await call(listSessionsHandler(), makeReq({ db, userId: ME }));
    expect(reply.statusCode).toBe(200);
    expect((reply.body as { data: { id: string }[] }).data.map((item) => item.id)).toEqual([
      active.id,
    ]);
  });

  it('capabilityId 非 UUID → 400（防 SQL uuid cast 报 500）', async () => {
    const db = new FakeDb();
    const reply = await call(
      listSessionsHandler(),
      makeReq({ db, userId: ME, query: { capabilityId: 'not-a-uuid' } }),
    );
    expect(reply.statusCode).toBe(400);
  });

  it('未知 mode → 400', async () => {
    const db = new FakeDb();
    const reply = await call(
      listSessionsHandler(),
      makeReq({ db, userId: ME, query: { mode: 'mystery' } }),
    );
    expect(reply.statusCode).toBe(400);
  });
});

describe('GET /runtime/sessions/:id 透出开场表单字段', () => {
  it('定义可读：inputs/starterPrompts 原样透出', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const cap = db.seedCapability({ owner_user_id: ME });
    store.seedText(
      CAPABILITY_BUCKET,
      cap.storage_key,
      JSON.stringify({
        version: 1,
        name: cap.name,
        summary: cap.summary,
        kind: cap.kind,
        instructions: '干活步骤',
        inputs: [{ key: 'topic', label: '主题', type: 'string', required: true }],
        starterPrompts: ['帮我写一版初稿。'],
      }),
    );
    const session = await createSession(db, { capabilityId: cap.id, ownerUserId: ME });

    const reply = await call(
      getSessionDetailHandler(),
      makeReq({ db, objectStore: store, userId: ME, params: { id: session.id } }),
    );
    expect(reply.statusCode).toBe(200);
    const capability = (
      reply.body as {
        data: { capability: { inputs: unknown[]; starterPrompts: string[] } };
      }
    ).data.capability;
    expect(capability.inputs).toEqual([
      { key: 'topic', label: '主题', type: 'string', required: true },
    ]);
    expect(capability.starterPrompts).toEqual(['帮我写一版初稿。']);
  });

  it('定义读不出：详情仍 200，两字段退化为空数组', async () => {
    const db = new FakeDb();
    const sessionId = await seedOwnedSession(db, ME); // objectStore 里没有定义对象
    const reply = await call(
      getSessionDetailHandler(),
      makeReq({ db, userId: ME, params: { id: sessionId } }),
    );
    expect(reply.statusCode).toBe(200);
    const capability = (
      reply.body as {
        data: { capability: { inputs: unknown[]; starterPrompts: string[] } };
      }
    ).data.capability;
    expect(capability.inputs).toEqual([]);
    expect(capability.starterPrompts).toEqual([]);
  });
});
