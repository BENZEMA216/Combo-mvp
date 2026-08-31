// 路由注册自检 + session 端点 owner 守卫（非本人与不存在同样 404，不暴露存在性）。
import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import type { SessionDetail } from '@cb/shared';
import {
  CREATOR_AGENT_PACKAGE_PROTOCOL,
  createCreatorAgentPackageManifest,
  digestCreatorAgentPackage,
  digestCreatorAgentPackageFile,
  serializeCreatorAgentPackageManifest,
} from '@cb/creator-agent-protocol/agent-package';
import {
  createCreatorAgentPackageCapability,
  serializeCreatorAgentPackageCapability,
} from '@cb/creator-agent-protocol/agent-package-capability';
import { createCreatorAgentPackageRelease } from '@cb/creator-agent-protocol/agent-package-release';
import {
  CREATOR_KNOWLEDGE_BUNDLE_PROTOCOL,
  CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH,
  CREATOR_KNOWLEDGE_SKILL_PATH,
  serializeCreatorKnowledgeBundle,
} from '@cb/creator-agent-protocol/knowledge-bundle';
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
import { createTurnRunner, type TurnRunner } from '../modules/agent/run-turn.js';
import {
  AGENT_PACKAGE_OBJECT_BUCKET,
  agentPackageObjectKey,
  knowledgeQuestionDigest,
  resolveKnowledgeAgentPackage,
} from '../modules/knowledge-agent/resolver.js';
import {
  knowledgeAgentTestGateFromEnv,
  type Env,
  type KnowledgeAgentTestGate,
} from '../platform/config/env.js';
import type { Queryable } from '../platform/infra/db.js';
import { createSessionEventBus } from '../platform/infra/event-bus.js';
import { createInterruptBus } from '../platform/infra/redis-interrupt-bus.js';
import type { SandboxBackend } from '../platform/infra/sandbox-backend.js';
import {
  FakeDb,
  FakeObjectStore,
  FakeSessionEventLog,
  makeFakeAgentFactory,
  silentLog,
  waitFor,
} from './fakes.js';

const ME = 'user-me';
const OTHER = 'user-other';
const USAGE_ID = '11111111-1111-4111-8111-111111111111';
const PACKAGE_DIGEST = `sha256:${'a'.repeat(64)}`;
const RELEASE_ID = `release.agent-package.${'1'.repeat(32)}`;
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

  it('所有端点都带鉴权守卫，所有写端点还在鉴权前带浏览器来源守卫', () => {
    for (const ep of ALL_ENDPOINTS) {
      const guards = (ep.preHandlers ?? []).length;
      expect(guards, `${String(ep.method)} ${ep.url} 缺守卫`).toBeGreaterThan(0);
      if (ep.method === 'POST' || ep.method === 'PATCH' || ep.method === 'DELETE') {
        expect(guards, `${String(ep.method)} ${ep.url} 缺浏览器来源守卫`).toBeGreaterThanOrEqual(2);
      }
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
  env?: Env;
  turns?: TurnRunner;
}): FastifyRequest {
  const turns =
    input.turns ??
    createTurnRunner({
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
    auth: { userId: input.userId, account: 'creator-testerxx', roles: ['creator'] },
    params: input.params ?? {},
    query: input.query ?? {},
    body: input.body,
    log: { ...silentLog, info: () => undefined, warn: () => undefined },
    server: {
      infra: {
        db: input.db,
        objectStore: input.objectStore ?? new FakeObjectStore(),
        ...(input.env ? { env: input.env } : {}),
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

function seedUnsupportedV2Definition(
  store: FakeObjectStore,
  cap: ReturnType<FakeDb['seedCapability']>,
) {
  store.seedText(
    CAPABILITY_BUCKET,
    cap.storage_key,
    JSON.stringify({
      version: 2,
      protocol: 'combo.agent-package-capability/2',
      release: {
        protocol: 'combo.agent-package-release/1',
        releaseId: RELEASE_ID,
        packageDigest: PACKAGE_DIGEST,
      },
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
  it('strict Agent Package Capability v2 在建会话前拒绝，不留任何 Session 或 Artifact', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const cap = db.seedCapability({ id: CAP_A, owner_user_id: ME });
    seedUnsupportedV2Definition(store, cap);

    const reply = await call(
      createSessionHandler(),
      makeReq({ db, objectStore: store, userId: ME, body: { capabilityId: cap.id } }),
    );

    expect(reply.statusCode).toBe(409);
    expect(reply.body).toMatchObject({
      error: {
        userMessage: '这个能力的格式比当前试用服务更新，暂时无法试用，请等待服务升级。',
        retriable: false,
        action: 'change_input',
      },
    });
    expect(db.sessions.size).toBe(0);
    expect(db.artifacts.size).toBe(0);
  });

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

    await finishTurnCas(db, {
      id: turnId,
      status: 'interrupted',
      lastError: {
        code: 'TURN_PROMPT_FAILED',
        message: 'provider-sensitive-sentinel-must-never-leave-the-database',
      },
    });
    const terminal = await call(
      getSessionDetailHandler(),
      makeReq({ db, userId: ME, params: { id: sessionId } }),
    );
    expect(
      (
        terminal.body as {
          data: {
            activeTurn: { id: string } | null;
            latestTerminalTurn: {
              id: string;
              status: string;
              errorCode: string;
            } | null;
          };
        }
      ).data.activeTurn,
    ).toBeNull();
    expect(
      (
        terminal.body as {
          data: {
            latestTerminalTurn: {
              id: string;
              status: string;
              errorCode: string;
            } | null;
          };
        }
      ).data.latestTerminalTurn,
    ).toEqual({ id: turnId, status: 'interrupted', errorCode: 'TURN_PROMPT_FAILED' });
    expect(JSON.stringify(terminal.body)).not.toContain('last_error');
    expect(JSON.stringify(terminal.body)).not.toContain(
      'provider-sensitive-sentinel-must-never-leave-the-database',
    );
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

    const createdConsumerReply = await call(
      createSessionHandler(),
      makeReq({ db, objectStore: store, userId: ME, body: { capabilityId: cap.id } }),
    );
    expect(createdConsumerReply.statusCode).toBe(201);
    const createdConsumerId = (createdConsumerReply.body as { data: { id: string } }).data.id;
    const createdConsumerDetailReply = await call(
      getSessionDetailHandler(),
      makeReq({ db, objectStore: store, userId: ME, params: { id: createdConsumerId } }),
    );
    const createdConsumerDetail = (
      createdConsumerDetailReply.body as {
        data: {
          session: { mode: string };
          artifacts: Array<{
            id: string;
            kind: string;
            sourceArtifactId?: string;
            sourceTurnId?: string;
          }>;
          currentUiArtifactId: string | null;
        };
      }
    ).data;
    const frozenSnapshot = createdConsumerDetail.artifacts.find(
      (artifact) => artifact.sourceArtifactId === revision.details!.artifactId,
    );
    expect(createdConsumerDetail.session.mode).toBe('consume');
    expect(frozenSnapshot).toMatchObject({
      kind: 'html',
      sourceArtifactId: revision.details!.artifactId,
    });
    expect(frozenSnapshot?.sourceTurnId).toBeUndefined();
    expect(createdConsumerDetail.currentUiArtifactId).toBe(frozenSnapshot?.id);

    const completedConsumeTurnId = '00000000-0000-4000-8000-000000000003';
    const completedConsumeArtifactId = '00000000-0000-4000-8000-000000000004';
    const newerTimestamp = new Date(Date.now() + 1_000).toISOString();
    db.turns.set(completedConsumeTurnId, {
      id: completedConsumeTurnId,
      session_id: createdConsumerId,
      status: 'completed',
      last_error: null,
      created_at: newerTimestamp,
      finished_at: newerTimestamp,
    });
    db.artifacts.set(completedConsumeArtifactId, {
      id: completedConsumeArtifactId,
      session_id: createdConsumerId,
      turn_id: completedConsumeTurnId,
      kind: 'html',
      title: '普通运行结果',
      storage_key: `artifacts/${createdConsumerId}/${completedConsumeArtifactId}`,
      meta: {},
      created_at: newerTimestamp,
      updated_at: newerTimestamp,
    });
    const afterConsumeTurnReply = await call(
      getSessionDetailHandler(),
      makeReq({ db, objectStore: store, userId: ME, params: { id: createdConsumerId } }),
    );
    expect(
      (afterConsumeTurnReply.body as { data: { currentUiArtifactId: string | null } }).data
        .currentUiArtifactId,
    ).toBe(frozenSnapshot?.id);

    const newerStudioArtifactId = '00000000-0000-4000-8000-000000000001';
    db.artifacts.set(newerStudioArtifactId, {
      id: newerStudioArtifactId,
      session_id: studio.id,
      turn_id: turnId,
      kind: 'html',
      title: '更新后的 Agent UI',
      storage_key: `artifacts/${studio.id}/${newerStudioArtifactId}`,
      meta: {},
      created_at: newerTimestamp,
      updated_at: newerTimestamp,
    });
    cap.ui_artifact_id = newerStudioArtifactId;
    const stableSnapshotReply = await call(
      getSessionDetailHandler(),
      makeReq({ db, objectStore: store, userId: ME, params: { id: createdConsumerId } }),
    );
    expect(
      (stableSnapshotReply.body as { data: { currentUiArtifactId: string | null } }).data
        .currentUiArtifactId,
    ).toBe(frozenSnapshot?.id);

    const duplicateSnapshotId = '00000000-0000-4000-8000-000000000002';
    db.artifacts.set(duplicateSnapshotId, {
      id: duplicateSnapshotId,
      session_id: createdConsumerId,
      turn_id: null,
      kind: 'html',
      title: '冲突的冻结快照',
      storage_key: `artifacts/${createdConsumerId}/${duplicateSnapshotId}`,
      meta: { sourceArtifactId: newerStudioArtifactId },
      created_at: newerTimestamp,
      updated_at: newerTimestamp,
    });
    const ambiguousSnapshotReply = await call(
      getSessionDetailHandler(),
      makeReq({ db, objectStore: store, userId: ME, params: { id: createdConsumerId } }),
    );
    expect(ambiguousSnapshotReply.statusCode).toBe(500);
    expect(ambiguousSnapshotReply.body).toMatchObject({
      error: { action: 'retry', retriable: true },
    });
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

  it('POST /runtime/sessions/:id/messages：strict Agent Package Capability v2 在 Turn 入场前拒绝', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const cap = db.seedCapability({ owner_user_id: ME });
    seedUnsupportedV2Definition(store, cap);
    const session = await createSession(db, { capabilityId: cap.id, ownerUserId: ME });

    const reply = await call(
      sendMessageHandler(),
      makeReq({
        db,
        objectStore: store,
        userId: ME,
        params: { id: session.id },
        body: { text: '不应执行', usageId: USAGE_ID },
      }),
    );

    expect(reply.statusCode).toBe(409);
    expect(reply.body).toMatchObject({
      error: {
        userMessage: '这个能力的格式比当前试用服务更新，暂时无法试用，请等待服务升级。',
        retriable: false,
        action: 'change_input',
      },
    });
    expect(db.turns.size).toBe(0);
    expect(db.messages).toHaveLength(0);
    expect(db.usageCharges.size).toBe(0);
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
        body: { text: '收紧页面间距', usageId: USAGE_ID },
      }),
    );

    expect(reply.statusCode).toBe(202);
    const first = (
      reply.body as {
        data: { message: { turnId?: string }; replayed: boolean };
      }
    ).data;
    expect(first.message.turnId).toBeTruthy();
    expect(first.replayed).toBe(false);

    const replay = await call(
      sendMessageHandler(),
      makeReq({
        db,
        objectStore: store,
        userId: ME,
        params: { id: session.id },
        body: { text: '收紧页面间距', usageId: USAGE_ID },
      }),
    );
    expect(replay.statusCode).toBe(202);
    expect(
      (
        replay.body as {
          data: { message: { turnId?: string }; replayed: boolean };
        }
      ).data,
    ).toMatchObject({
      message: { turnId: first.message.turnId },
      replayed: true,
    });
  });

  it('POST /runtime/sessions/:id/messages：免费额度耗尽且余额不足时返回安全 402 且不落 Turn', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const capability = db.seedCapability({ owner_user_id: OTHER, published: true });
    seedRunnableDefinition(store, capability);
    const session = await createSession(db, {
      capabilityId: capability.id,
      ownerUserId: ME,
    });
    db.seedBillingAccount(ME, 0n);
    db.seedFreeAllowance({
      ownerUserId: ME,
      capabilityId: capability.id,
      freeLimit: 3,
      freeUsed: 3,
    });

    const reply = await call(
      sendMessageHandler(),
      makeReq({
        db,
        objectStore: store,
        userId: ME,
        params: { id: session.id },
        body: { text: '第四次任务', usageId: USAGE_ID },
      }),
    );

    expect(reply.statusCode).toBe(402);
    expect(reply.body).toEqual({
      rechargeRequired: true,
      rechargeIntentId: USAGE_ID,
      balanceCents: '0',
      requiredCents: '1',
    });
    expect(db.turns.size).toBe(0);
    expect(db.messages).toHaveLength(0);
    expect(db.usageCharges.size).toBe(0);
  });

  it('POST /runtime/sessions/:id/messages：入场数据库锁超时返回可重试 503', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const capability = db.seedCapability({ owner_user_id: ME });
    seedRunnableDefinition(store, capability);
    const session = await createSession(db, {
      capabilityId: capability.id,
      ownerUserId: ME,
    });
    const originalQuery = db.query.bind(db);
    db.query = async function <R = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.includes("status = 'active' FOR UPDATE")) {
        throw Object.assign(new Error('redacted database statement timeout'), { code: '57014' });
      }
      return originalQuery<R>(sql, params);
    };

    const reply = await call(
      sendMessageHandler(),
      makeReq({
        db,
        objectStore: store,
        userId: ME,
        params: { id: session.id },
        body: { text: '等待入场事务', usageId: USAGE_ID },
      }),
    );

    expect(reply.statusCode).toBe(503);
    expect(reply.body).toMatchObject({
      error: {
        retriable: true,
        action: 'retry',
      },
    });
    expect(db.turns.size).toBe(0);
    expect(db.messages).toHaveLength(0);
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
        body: { text: '第二条', usageId: USAGE_ID },
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

describe('knowledge Agent handler closed loop', () => {
  const creator = '00000000-0000-4000-8000-000000000101';
  const consumer = '00000000-0000-4000-8000-000000000102';
  const capabilityId = '00000000-0000-4000-8000-000000000103';
  const usageId = '00000000-0000-4000-8000-000000000104';
  const sourceSha = '7'.repeat(40);
  const question = 'Combo 的免费额度是多少？';
  const answer = '前三次成功回答免费。';
  const chunkId = `chunk.knowledge.${'8'.repeat(32)}`;
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

  it('creates a frozen Session, answers once, then projects only verified detail', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const capability = db.seedCapability({
      id: capabilityId,
      owner_user_id: creator,
      published: true,
      kind: 'knowledge',
      name: '公开知识助手',
      summary: '只回答固定公开资料',
    });
    const agentMarkdown = encode('# Knowledge Agent\nAnswer only from retrieved evidence.');
    const skillMarkdown = encode('# Knowledge\nSearch before submitting an answer.');
    const content = 'Combo 的前三次成功回答使用免费额度。';
    const knowledge = {
      protocol: CREATOR_KNOWLEDGE_BUNDLE_PROTOCOL,
      chunks: [
        {
          id: chunkId,
          source: {
            sourceId: `source.knowledge.${'9'.repeat(32)}`,
            displayLabel: '公开计费手册',
          },
          content,
          contentDigest: digestCreatorAgentPackageFile(encode(content)),
        },
      ],
    } as const;
    const bundleBytes = encode(serializeCreatorKnowledgeBundle(knowledge));
    const manifest = createCreatorAgentPackageManifest({
      protocol: CREATOR_AGENT_PACKAGE_PROTOCOL,
      name: '公开知识助手',
      description: '只回答固定公开资料',
      instructions: 'AGENT.md',
      skills: [CREATOR_KNOWLEDGE_SKILL_PATH],
      files: [
        {
          path: 'AGENT.md',
          byteLength: agentMarkdown.byteLength,
          digest: digestCreatorAgentPackageFile(agentMarkdown),
        },
        {
          path: CREATOR_KNOWLEDGE_SKILL_PATH,
          byteLength: skillMarkdown.byteLength,
          digest: digestCreatorAgentPackageFile(skillMarkdown),
        },
        {
          path: CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH,
          byteLength: bundleBytes.byteLength,
          digest: digestCreatorAgentPackageFile(bundleBytes),
        },
      ],
    });
    const packageDigest = digestCreatorAgentPackage(manifest);
    const release = createCreatorAgentPackageRelease({
      protocol: 'combo.agent-package-release/1',
      releaseId: `release.agent-package.${'a'.repeat(32)}`,
      packageDigest,
    });
    const projection = createCreatorAgentPackageCapability({
      version: 2,
      protocol: 'combo.agent-package-capability/2',
      release,
    });
    const gate: KnowledgeAgentTestGate = {
      protocol: 'combo.knowledge-agent-runtime-test-gate/1',
      sourceSha,
      publisherUserId: creator,
      capabilityId,
      releaseId: release.releaseId,
      packageDigest,
      validatorPolicyVersion: 'knowledge-agent-test-validator-v1',
      cases: [
        {
          questionDigest: knowledgeQuestionDigest(question),
          answer,
          citationChunkIds: [chunkId],
        },
      ],
    };
    const env = {
      COMBO_ENVIRONMENT: 'test',
      COMBO_SOURCE_SHA: sourceSha,
      COMBO_RELEASE_ID: `release-${sourceSha}`,
      COMBO_BUILT_AT: '2026-08-30T00:00:00.000Z',
      COMBO_RELEASE_MANIFEST_DIGEST: `sha256:${'b'.repeat(64)}`,
      COMBO_WEB_ASSET_MANIFEST: `sha256:${'c'.repeat(64)}`,
      COMBO_KNOWLEDGE_AGENT_TEST_GATE: JSON.stringify(gate),
    } as Env;

    store.seedText(
      CAPABILITY_BUCKET,
      capability.storage_key,
      serializeCreatorAgentPackageCapability(projection),
    );
    db.seedAgentPackageRegistry({
      packageDigest,
      releaseId: release.releaseId,
      ownerUserId: creator,
    });
    for (const [path, bytes] of [
      ['agent.json', encode(serializeCreatorAgentPackageManifest(manifest))],
      ['AGENT.md', agentMarkdown],
      [CREATOR_KNOWLEDGE_SKILL_PATH, skillMarkdown],
      [CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH, bundleBytes],
    ] as const) {
      await store.putObject(
        AGENT_PACKAGE_OBJECT_BUCKET,
        agentPackageObjectKey(packageDigest, path),
        bytes,
      );
    }

    const agent = makeFakeAgentFactory({
      deltas: ['未验证候选文本'],
      invokeNamedTools: [
        { name: 'knowledge_search', params: { query: '免费额度' } },
        {
          name: 'submit_knowledge_answer',
          params: { status: 'answered', answer, citationChunkIds: [chunkId] },
        },
      ],
      finalMessages: [{ role: 'assistant', content: [{ type: 'text', text: '伪造 transcript' }] }],
    });
    const turns = createTurnRunner({
      db,
      objectStore: store,
      bus: createSessionEventBus(),
      eventLog: new FakeSessionEventLog(),
      agentFactory: agent.factory,
      idleTimeoutMs: 60_000,
      interrupts: createInterruptBus(),
      billingPolicy: { freeUses: 3, unitPriceCents: 1 },
      runtimeSourceSha: sourceSha,
      log: silentLog,
    });

    const created = await call(
      createSessionHandler(),
      makeReq({
        db,
        objectStore: store,
        env,
        turns,
        userId: consumer,
        body: { capabilityId },
      }),
    );
    expect(created.statusCode).toBe(201);
    const sessionId = (created.body as { data: { id: string } }).data.id;
    expect(db.sessions.get(sessionId)).toMatchObject({
      product_kind: 'knowledge_agent_test',
      release_id: release.releaseId,
      package_digest: packageDigest,
      knowledge_resource_path: CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH,
    });

    const sent = await call(
      sendMessageHandler(),
      makeReq({
        db,
        objectStore: store,
        env,
        turns,
        userId: consumer,
        params: { id: sessionId },
        body: { text: question, usageId },
      }),
    );
    expect(sent.statusCode).toBe(202);
    await waitFor(() => db.agentUsageReceipts.size === 1);

    const readDetail = () =>
      call(
        getSessionDetailHandler(),
        makeReq({
          db,
          objectStore: store,
          env,
          turns,
          userId: consumer,
          params: { id: sessionId },
        }),
      );
    const detail = await readDetail();
    expect(detail.statusCode).toBe(200);
    const data = (detail.body as { data: SessionDetail }).data;
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0]).toMatchObject({ role: 'user' });
    expect(JSON.stringify(data)).not.toContain('未验证候选文本');
    expect(JSON.stringify(data)).not.toContain('伪造 transcript');
    expect(data.artifacts).toEqual([]);
    expect(data.agentBinding).toMatchObject({
      productKind: 'knowledge_agent_test',
      release,
    });
    expect(data.knowledgeResults).toEqual([
      expect.objectContaining({
        outcome: 'answered',
        answer: expect.objectContaining({ text: answer }),
        citations: [expect.objectContaining({ displayLabel: '公开计费手册' })],
        billing: expect.objectContaining({ source: 'free', settledCents: '0' }),
      }),
    ]);
    const receipt = [...db.agentUsageReceipts.values()][0]!;
    const responseDigest = receipt.response_digest;
    receipt.response_digest = `sha256:${'0'.repeat(64)}`;
    expect((await readDetail()).statusCode).toBe(503);
    receipt.response_digest = responseDigest;
    const citationChunkIds = receipt.citation_chunk_ids;
    receipt.citation_chunk_ids = [`chunk.knowledge.${'0'.repeat(32)}`];
    expect((await readDetail()).statusCode).toBe(503);
    receipt.citation_chunk_ids = citationChunkIds;

    for (const [index, retryUsageId] of [
      '00000000-0000-4000-8000-000000000105',
      '00000000-0000-4000-8000-000000000106',
    ].entries()) {
      const free = await call(
        sendMessageHandler(),
        makeReq({
          db,
          objectStore: store,
          env,
          turns,
          userId: consumer,
          params: { id: sessionId },
          body: { text: question, usageId: retryUsageId },
        }),
      );
      expect(free.statusCode).toBe(202);
      await waitFor(() => db.agentUsageReceipts.size === index + 2);
    }
    const rechargeUsageId = '00000000-0000-4000-8000-000000000107';
    const recharge = await call(
      sendMessageHandler(),
      makeReq({
        db,
        objectStore: store,
        env,
        turns,
        userId: consumer,
        params: { id: sessionId },
        body: { text: question, usageId: rechargeUsageId },
      }),
    );
    expect(recharge).toMatchObject({
      statusCode: 402,
      body: {
        rechargeRequired: true,
        rechargeIntentId: rechargeUsageId,
        balanceCents: '0',
        requiredCents: '1',
      },
    });
    expect(agent.calls).toHaveLength(3);
    expect(db.agentUsageReceipts.size).toBe(3);
    await turns.dispose();
  });
});

const OWNER = '11111111-1111-4111-8111-111111111111';
const CAPABILITY_ID = '22222222-2222-4222-8222-222222222222';
const SOURCE_SHA = 'a'.repeat(40);

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function fixture() {
  const agentMarkdown = bytes('# Knowledge Agent\nAnswer only from retrieved evidence.');
  const skillMarkdown = bytes('# Knowledge\nSearch before submitting an answer.');
  const content = 'Combo 的受控 Test 知识内容。';
  const bundleText = serializeCreatorKnowledgeBundle({
    protocol: CREATOR_KNOWLEDGE_BUNDLE_PROTOCOL,
    chunks: [
      {
        id: `chunk.knowledge.${'1'.repeat(32)}`,
        source: {
          sourceId: `source.knowledge.${'2'.repeat(32)}`,
          displayLabel: '公开测试资料',
        },
        content,
        contentDigest: digestCreatorAgentPackageFile(bytes(content)),
      },
    ],
  });
  const bundleBytes = bytes(bundleText);
  const manifest = createCreatorAgentPackageManifest({
    protocol: CREATOR_AGENT_PACKAGE_PROTOCOL,
    name: '受控知识 Agent',
    description: '只回答固定公开测试资料。',
    instructions: 'AGENT.md',
    skills: [CREATOR_KNOWLEDGE_SKILL_PATH],
    files: [
      {
        path: 'AGENT.md',
        byteLength: agentMarkdown.byteLength,
        digest: digestCreatorAgentPackageFile(agentMarkdown),
      },
      {
        path: CREATOR_KNOWLEDGE_SKILL_PATH,
        byteLength: skillMarkdown.byteLength,
        digest: digestCreatorAgentPackageFile(skillMarkdown),
      },
      {
        path: CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH,
        byteLength: bundleBytes.byteLength,
        digest: digestCreatorAgentPackageFile(bundleBytes),
      },
    ],
  });
  const packageDigest = digestCreatorAgentPackage(manifest);
  const release = createCreatorAgentPackageRelease({
    protocol: 'combo.agent-package-release/1',
    releaseId: `release.agent-package.${'3'.repeat(32)}`,
    packageDigest,
  });
  const projection = createCreatorAgentPackageCapability({
    version: 2,
    protocol: 'combo.agent-package-capability/2',
    release,
  });
  const gate: KnowledgeAgentTestGate = {
    protocol: 'combo.knowledge-agent-runtime-test-gate/1',
    sourceSha: SOURCE_SHA,
    publisherUserId: OWNER,
    capabilityId: CAPABILITY_ID,
    releaseId: release.releaseId,
    packageDigest,
    validatorPolicyVersion: 'knowledge-agent-test-validator-v1',
    cases: [
      {
        questionDigest: `sha256:${'4'.repeat(64)}`,
        answer: '受控答案。',
        citationChunkIds: [`chunk.knowledge.${'1'.repeat(32)}`],
      },
    ],
  };
  return { agentMarkdown, skillMarkdown, bundleBytes, manifest, packageDigest, projection, gate };
}

function registryDb(
  candidate = fixture(),
  overrides: Record<string, string> = {},
): Queryable & { query: ReturnType<typeof vi.fn> } {
  return {
    query: vi.fn(async () => ({
      rows: [
        {
          release_id: candidate.projection.release.releaseId,
          package_digest: candidate.packageDigest,
          owner_user_id: OWNER,
          release_protocol: 'combo.agent-package-release/1',
          release_scope: 'controlled_test',
          package_protocol: CREATOR_AGENT_PACKAGE_PROTOCOL,
          ...overrides,
        },
      ],
      rowCount: 1,
    })),
  } as Queryable & { query: ReturnType<typeof vi.fn> };
}

async function seedPackage(store: FakeObjectStore, candidate = fixture()): Promise<void> {
  const entries = [
    ['agent.json', bytes(serializeCreatorAgentPackageManifest(candidate.manifest))],
    ['AGENT.md', candidate.agentMarkdown],
    [CREATOR_KNOWLEDGE_SKILL_PATH, candidate.skillMarkdown],
    [CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH, candidate.bundleBytes],
  ] as const;
  for (const [path, body] of entries) {
    await store.putObject(
      AGENT_PACKAGE_OBJECT_BUCKET,
      agentPackageObjectKey(candidate.packageDigest, path),
      body,
    );
  }
}

function resolveInput(
  candidate = fixture(),
  store = new FakeObjectStore(),
  db = registryDb(candidate),
) {
  return {
    candidate,
    store,
    db,
    input: {
      db,
      objectStore: store,
      capability: {
        id: CAPABILITY_ID,
        name: '投影名称',
        summary: '投影摘要',
        kind: 'knowledge',
        published: true,
        ownerUserId: OWNER,
      },
      projection: candidate.projection,
      gate: candidate.gate,
    },
  };
}

describe('exact knowledge Agent Package resolver', () => {
  it('keeps a missing or mismatched Test gate closed before DB or object access', async () => {
    const context = resolveInput();
    for (const gate of [null, { ...context.candidate.gate, capabilityId: OWNER }]) {
      await expect(resolveKnowledgeAgentPackage({ ...context.input, gate })).rejects.toMatchObject({
        failure: 'closed',
      });
    }
    expect(context.db.query).not.toHaveBeenCalled();
    expect(context.store.objects.size).toBe(0);
  });

  it.each([
    ['owner', { owner_user_id: '33333333-3333-4333-8333-333333333333' }],
    ['release protocol', { release_protocol: 'legacy' }],
    ['scope', { release_scope: 'production' }],
    ['package protocol', { package_protocol: 'legacy' }],
  ])('fails closed on Registry %s drift', async (_label, overrides) => {
    const candidate = fixture();
    const context = resolveInput(
      candidate,
      new FakeObjectStore(),
      registryDb(candidate, overrides),
    );
    await expect(resolveKnowledgeAgentPackage(context.input)).rejects.toMatchObject({
      failure: 'invalid_registry',
    });
  });

  it('rejects a manifest whose recomputed digest differs from the Registry selector', async () => {
    const context = resolveInput();
    await seedPackage(context.store, context.candidate);
    const changed = createCreatorAgentPackageManifest({
      ...context.candidate.manifest,
      description: '另一份合法但 digest 不同的 Package。',
    });
    context.store.seedText(
      AGENT_PACKAGE_OBJECT_BUCKET,
      agentPackageObjectKey(context.candidate.packageDigest, 'agent.json'),
      serializeCreatorAgentPackageManifest(changed),
    );

    await expect(resolveKnowledgeAgentPackage(context.input)).rejects.toMatchObject({
      failure: 'invalid_package',
    });
  });

  it('rejects tampered file bytes and invalid UTF-8', async () => {
    for (const replacement of [bytes('# Knowledge Agenx'), new Uint8Array([0xff])]) {
      const context = resolveInput();
      await seedPackage(context.store, context.candidate);
      await context.store.putObject(
        AGENT_PACKAGE_OBJECT_BUCKET,
        agentPackageObjectKey(context.candidate.packageDigest, 'AGENT.md'),
        replacement,
      );
      await expect(resolveKnowledgeAgentPackage(context.input)).rejects.toMatchObject({
        failure: 'invalid_package',
      });
    }
  });

  it('propagates an abort as a stable category without provider details', async () => {
    const context = resolveInput();
    await seedPackage(context.store, context.candidate);
    const controller = new AbortController();
    controller.abort();

    await expect(
      resolveKnowledgeAgentPackage({ ...context.input, signal: controller.signal }),
    ).rejects.toMatchObject({ failure: 'aborted' });
  });
});

describe('controlled knowledge Agent Test gate configuration', () => {
  it('accepts only canonical exact-SHA Test material and fails closed elsewhere', () => {
    const candidate = fixture();
    const env = {
      COMBO_ENVIRONMENT: 'test',
      COMBO_SOURCE_SHA: SOURCE_SHA,
      COMBO_RELEASE_ID: `release-${SOURCE_SHA}`,
      COMBO_BUILT_AT: '2026-07-28T00:00:00.000Z',
      COMBO_RELEASE_MANIFEST_DIGEST: `sha256:${'b'.repeat(64)}`,
      COMBO_WEB_ASSET_MANIFEST: `sha256:${'c'.repeat(64)}`,
      COMBO_KNOWLEDGE_AGENT_TEST_GATE: JSON.stringify(candidate.gate),
    } as Env;
    expect(knowledgeAgentTestGateFromEnv(env)).toEqual(candidate.gate);
    const driftSha = 'f'.repeat(40);
    expect(
      knowledgeAgentTestGateFromEnv({
        ...env,
        COMBO_SOURCE_SHA: driftSha,
        COMBO_RELEASE_ID: `release-${driftSha}`,
      }),
    ).toBeNull();
    expect(() => knowledgeAgentTestGateFromEnv({ ...env, COMBO_ENVIRONMENT: 'preview' })).toThrow(
      /COMBO_KNOWLEDGE_AGENT_TEST_GATE/u,
    );
    expect(() =>
      knowledgeAgentTestGateFromEnv({
        ...env,
        COMBO_KNOWLEDGE_AGENT_TEST_GATE: JSON.stringify({
          ...candidate.gate,
          privateMarker: 'must-not-appear',
        }),
      }),
    ).toThrow(/COMBO_KNOWLEDGE_AGENT_TEST_GATE/u);
  });
});
