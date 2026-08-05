// Test-only Combo Miniapp seed：验证环境门禁、owner/marker 隔离、幂等 Session 与可运行 HTML。
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { describe, expect, it } from 'vitest';
import { ARTIFACT_BUCKET, artifactStorageKey } from '../modules/artifact/repo.js';
import { validateStudioHtml } from '../modules/artifact/studio-contract.js';
import { COMBO_MINIAPP_DEMO_HTML, COMBO_MINIAPP_FIXTURE } from '../modules/demo/fixture.js';
import { createComboMiniappDemoStudioHandler } from '../modules/demo/handlers.js';
import { FakeDb, FakeObjectStore, silentLog } from './fakes.js';

const CAPABILITY_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = 'user-owner';

interface CapturedReply {
  statusCode: number;
  body: unknown;
}

function makeReply(): FastifyReply {
  const reply = {
    statusCode: 0,
    body: undefined as unknown,
    code(statusCode: number) {
      this.statusCode = statusCode;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return reply as unknown as FastifyReply;
}

function makeRequest(input: {
  db: FakeDb;
  objectStore: FakeObjectStore;
  userId?: string;
  environment?: string;
  body?: unknown;
}): FastifyRequest {
  return {
    id: 'trace-demo-test',
    ...(input.userId
      ? { auth: { userId: input.userId, account: 'creator-demo', roles: ['creator'] } }
      : {}),
    body: input.body,
    log: silentLog,
    server: {
      infra: {
        env: { COMBO_ENVIRONMENT: input.environment ?? 'test' },
        db: input.db,
        objectStore: input.objectStore,
      },
    },
  } as unknown as FastifyRequest;
}

async function call(handler: RouteHandlerMethod, req: FastifyRequest): Promise<CapturedReply> {
  const reply = makeReply();
  await (handler as unknown as (request: FastifyRequest, reply: FastifyReply) => Promise<void>)(
    req,
    reply,
  );
  return reply as unknown as CapturedReply;
}

describe('POST /runtime/test/demo-agents/combo-miniapp', () => {
  it('固定 Miniapp 是完整、自包含且接入真实 combo:run 的 Studio HTML', () => {
    expect(validateStudioHtml(COMBO_MINIAPP_DEMO_HTML)).toEqual({ ok: true, errors: [] });
    expect(COMBO_MINIAPP_DEMO_HTML).toContain('Combo Miniapp 设计助手');
  });

  it('只在 Test 环境响应，即使 handler 被误挂也会失败关闭', async () => {
    const db = new FakeDb();
    const objectStore = new FakeObjectStore();
    db.seedCapability({
      id: CAPABILITY_ID,
      owner_user_id: OWNER_ID,
      meta: { ...COMBO_MINIAPP_FIXTURE },
    });

    const response = await call(
      createComboMiniappDemoStudioHandler(),
      makeRequest({
        db,
        objectStore,
        userId: OWNER_ID,
        environment: 'preview',
        body: { capabilityId: CAPABILITY_ID },
      }),
    );

    expect(response.statusCode).toBe(404);
    expect(db.sessions.size).toBe(0);
    expect(db.artifacts.size).toBe(0);
  });

  it.each([
    ['其他 owner', 'user-other', { ...COMBO_MINIAPP_FIXTURE }],
    ['只有部分 marker', OWNER_ID, { source: COMBO_MINIAPP_FIXTURE.source }],
    ['错误 fixture 版本', OWNER_ID, { ...COMBO_MINIAPP_FIXTURE, fixtureVersion: 2 }],
  ])('拒绝%s的 Capability，且不泄漏存在性', async (_case, userId, meta) => {
    const db = new FakeDb();
    const objectStore = new FakeObjectStore();
    db.seedCapability({ id: CAPABILITY_ID, owner_user_id: OWNER_ID, meta });

    const response = await call(
      createComboMiniappDemoStudioHandler(),
      makeRequest({
        db,
        objectStore,
        userId,
        body: { capabilityId: CAPABILITY_ID },
      }),
    );

    expect(response.statusCode).toBe(404);
    expect(db.sessions.size).toBe(0);
    expect(db.artifacts.size).toBe(0);
  });

  it('首次创建后重复请求复用同一 Studio 与 Artifact，并返回统一 Envelope', async () => {
    const db = new FakeDb();
    const objectStore = new FakeObjectStore();
    const capability = db.seedCapability({
      id: CAPABILITY_ID,
      owner_user_id: OWNER_ID,
      meta: { ...COMBO_MINIAPP_FIXTURE, requestedFrom: 'web' },
    });
    const handler = createComboMiniappDemoStudioHandler();
    const request = () =>
      makeRequest({
        db,
        objectStore,
        userId: OWNER_ID,
        body: { capabilityId: CAPABILITY_ID },
      });

    const first = await call(handler, request());
    const firstData = (
      first.body as {
        data: { studioSessionId: string; reused: boolean };
        meta: { traceId: string };
      }
    ).data;
    expect(first.statusCode).toBe(200);
    expect(first.body).toMatchObject({
      data: { reused: false },
      meta: { traceId: 'trace-demo-test' },
    });
    expect([...db.sessions.values()]).toHaveLength(1);
    expect([...db.sessions.values()][0]).toMatchObject({
      id: firstData.studioSessionId,
      capability_id: CAPABILITY_ID,
      owner_user_id: OWNER_ID,
      mode: 'studio',
      status: 'active',
    });
    expect(db.artifacts.size).toBe(1);
    const artifact = [...db.artifacts.values()][0]!;
    expect(capability.ui_artifact_id).toBe(artifact.id);
    expect(artifact).toMatchObject({
      session_id: firstData.studioSessionId,
      turn_id: null,
      kind: 'html',
      meta: { ...COMBO_MINIAPP_FIXTURE, seed: true },
    });
    expect(
      await objectStore.getObjectText(
        ARTIFACT_BUCKET,
        artifactStorageKey(firstData.studioSessionId, artifact.id),
      ),
    ).toBe(COMBO_MINIAPP_DEMO_HTML);

    const second = await call(handler, request());
    expect(second.statusCode).toBe(200);
    expect(second.body).toMatchObject({
      data: { studioSessionId: firstData.studioSessionId, reused: true },
      meta: { traceId: 'trace-demo-test' },
    });
    expect(db.sessions.size).toBe(1);
    expect(db.artifacts.size).toBe(1);
    expect(capability.ui_artifact_id).toBe(artifact.id);
  });
});
