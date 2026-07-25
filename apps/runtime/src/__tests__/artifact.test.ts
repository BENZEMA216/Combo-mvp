// 产物工具先写不可变暂存对象，再以 running Turn 行锁把对象键提交为可见 Artifact。
import { describe, expect, it } from 'vitest';
import type { ArtifactView, Bucket } from '@cb/shared';
import { createArtifactTool } from '../modules/artifact/tool.js';
import {
  ARTIFACT_BUCKET,
  artifactStorageKey,
  bindCapabilityUiArtifact,
  readCapabilityUiArtifact,
  seedCapabilityUiArtifact,
} from '../modules/artifact/repo.js';
import type { QueryResultLike } from '../platform/infra/db.js';
import { StudioArtifactValidationError } from '../modules/artifact/studio-contract.js';
import { createSession, getOrCreateStudioSession } from '../modules/session/repo.js';
import { FakeDb, FakeObjectStore } from './fakes.js';

const SESSION = 'sess-000001';
const TURN = 'turn-000001';

function addRunningTurn(db: FakeDb, sessionId: string, turnId: string): void {
  const now = new Date().toISOString();
  db.turns.set(turnId, {
    id: turnId,
    session_id: sessionId,
    status: 'running',
    last_error: null,
    created_at: now,
    finished_at: null,
  });
}

function setup(store: FakeObjectStore = new FakeObjectStore()) {
  const db = new FakeDb();
  const now = new Date().toISOString();
  db.sessions.set(SESSION, {
    id: SESSION,
    capability_id: 'cap-1',
    owner_user_id: 'owner-1',
    mode: 'consume',
    title: null,
    status: 'active',
    created_at: now,
    updated_at: now,
  });
  addRunningTurn(db, SESSION, TURN);
  const emitted: ArtifactView[] = [];
  const controller = new AbortController();
  const tool = createArtifactTool({
    db,
    objectStore: store,
    sessionId: SESSION,
    turnId: TURN,
    turnSignal: controller.signal,
    onArtifact: (artifact) => emitted.push(artifact),
  });
  return { db, store, emitted, controller, tool };
}

async function setupStudio() {
  const db = new FakeDb();
  const store = new FakeObjectStore();
  const cap = db.seedCapability({ owner_user_id: 'creator' });
  const studio = await getOrCreateStudioSession(db, {
    capabilityId: cap.id,
    ownerUserId: cap.owner_user_id,
  });
  const turnId = `turn-${studio.id}`;
  addRunningTurn(db, studio.id, turnId);
  const controller = new AbortController();
  const emitted: ArtifactView[] = [];
  const tool = createArtifactTool({
    db,
    objectStore: store,
    sessionId: studio.id,
    turnId,
    turnSignal: controller.signal,
    capabilityId: cap.id,
    mode: 'studio',
    onArtifact: (artifact) => emitted.push(artifact),
  });
  return { db, store, cap, studio, turnId, controller, emitted, tool };
}

function studioHtml(label: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>button{color:red}</style></head>
<body><input id="goal"><button data-combo-key="run-primary">${label}</button>
<script>
document.querySelector('[data-combo-key="run-primary"]').addEventListener('click', () => {
  const prompt = document.querySelector('#goal').value.trim();
  window.parent.postMessage({ type: 'combo:run', version: 1, prompt }, '*');
});
</script></body></html>`;
}

class SeedInterleavingFakeDb extends FakeDb {
  targetSessionId: string | undefined;
  injectedArtifactId = 'interleaved-seed';
  private injected = false;

  override async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (
      !this.injected &&
      this.targetSessionId !== undefined &&
      params[0] === this.targetSessionId &&
      normalized.startsWith('SELECT id FROM sessions WHERE id = $1 AND capability_id = $2') &&
      normalized.endsWith('FOR UPDATE')
    ) {
      this.injected = true;
      const timestamp = new Date().toISOString();
      this.artifacts.set(this.injectedArtifactId, {
        id: this.injectedArtifactId,
        session_id: this.targetSessionId,
        turn_id: null,
        kind: 'html',
        title: '并发请求已提交的 UI',
        storage_key: `artifacts/${this.targetSessionId}/${this.injectedArtifactId}`,
        meta: {},
        created_at: timestamp,
        updated_at: timestamp,
      });
    }
    return super.query<R>(sql, params);
  }
}

describe('upsert_artifact 工具', () => {
  it('新建：暂存对象后在 running Turn 下插表并回调产物视图', async () => {
    const { db, store, emitted, tool } = setup();
    const result = await tool.execute('tc-1', {
      kind: 'html',
      title: '周报页面',
      content: '<!doctype html><html>v1</html>',
    });

    const id = result.details!.artifactId;
    const row = db.artifacts.get(id);
    expect(row?.storage_key).toMatch(new RegExp(`^${artifactStorageKey(SESSION, id)}/versions/`));
    expect(await store.getObjectText(ARTIFACT_BUCKET as never, row!.storage_key)).toContain('v1');
    expect(row?.kind).toBe('html');
    expect(row?.title).toBe('周报页面');
    expect(row?.turn_id).toBe(TURN);
    expect(emitted).toEqual([
      expect.objectContaining({
        id,
        sourceTurnId: TURN,
        createdAt: expect.any(String),
      }),
    ]);
  });

  it('更新：同 artifactId 原地更新索引，但正文切换到新的不可变对象键', async () => {
    const { db, store, tool } = setup();
    const first = await tool.execute('tc-1', {
      kind: 'html',
      title: '周报页面',
      content: '<!doctype html><html>v1</html>',
    });
    const id = first.details!.artifactId;
    const firstKey = db.artifacts.get(id)!.storage_key;

    const second = await tool.execute('tc-2', {
      artifactId: id,
      kind: 'html',
      title: '周报页面（改）',
      content: '<!doctype html><html>v2</html>',
    });
    const secondKey = db.artifacts.get(id)!.storage_key;
    expect(second.details!.artifactId).toBe(id);
    expect(db.artifacts.size).toBe(1);
    expect(db.artifacts.get(id)?.title).toBe('周报页面（改）');
    expect(secondKey).not.toBe(firstKey);
    expect(await store.getObjectText(ARTIFACT_BUCKET as never, secondKey)).toContain('v2');
  });

  it('幻觉或跨会话 artifactId 按新建处理', async () => {
    const { db, tool } = setup();
    const result = await tool.execute('tc-1', {
      artifactId: 'made-up-id',
      kind: 'markdown',
      title: '笔记',
      content: '# hi',
    });
    expect(result.details!.artifactId).not.toBe('made-up-id');
    expect(db.artifacts.has('made-up-id')).toBe(false);
    expect(db.artifacts.size).toBe(1);
  });

  it('上传在打断后才返回时不提交 Artifact，也不发送 STATE_DELTA 回调', async () => {
    let releaseUpload!: () => void;
    const uploadReleased = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    class BlockingStore extends FakeObjectStore {
      override async putObject(
        bucket: Bucket,
        key: string,
        body: Uint8Array,
        _opts?: { abortSignal?: AbortSignal },
      ): Promise<{ key: string }> {
        await uploadReleased;
        return super.putObject(bucket, key, body, { abortSignal: undefined });
      }
    }
    const { db, emitted, controller, tool } = setup(new BlockingStore());
    const pending = tool.execute('tc-1', {
      kind: 'markdown',
      title: '迟到产物',
      content: 'secret',
    });
    controller.abort();
    releaseUpload();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(db.artifacts.size).toBe(0);
    expect(emitted).toHaveLength(0);
  });

  it('Studio 每次写不可变 revision，tool 本身不提前提升 capability 当前 UI', async () => {
    const { db, store, cap, emitted, tool } = await setupStudio();

    const first = await tool.execute('studio-1', {
      kind: 'html',
      title: 'Agent UI',
      content: studioHtml('运行 v1'),
    });
    const firstId = first.details!.artifactId;
    expect(db.capabilities.get(cap.id)?.ui_artifact_id).toBeNull();

    const second = await tool.execute('studio-2', {
      artifactId: firstId,
      kind: 'html',
      title: 'Agent UI v2',
      content: studioHtml('运行 v2'),
    });
    const secondId = second.details!.artifactId;
    expect(secondId).not.toBe(firstId);
    expect(db.artifacts.size).toBe(2);
    expect(db.capabilities.get(cap.id)?.ui_artifact_id).toBeNull();
    expect(emitted).toHaveLength(2);
    expect(
      await store.getObjectText(ARTIFACT_BUCKET as never, db.artifacts.get(firstId)!.storage_key),
    ).toContain('运行 v1');
    expect(
      await store.getObjectText(ARTIFACT_BUCKET as never, db.artifacts.get(secondId)!.storage_key),
    ).toContain('运行 v2');
  });

  it('Studio 拒绝不完整、缺 bridge 或伪造运行的 HTML，且不写 DB/ObjectStore', async () => {
    const { db, store, cap, tool } = await setupStudio();

    await expect(
      tool.execute('studio-not-html', {
        kind: 'markdown',
        title: '不是页面',
        content: '# 说明',
      }),
    ).rejects.toBeInstanceOf(StudioArtifactValidationError);

    for (const content of [
      '<html><body>只是片段</body></html>',
      studioHtml('运行').replace("type: 'combo:run'", "type: 'local:run'"),
      studioHtml('运行').replace(
        "window.parent.postMessage({ type: 'combo:run', version: 1, prompt }, '*');",
        "setTimeout(() => window.parent.postMessage({ type: 'combo:run', version: 1, prompt }, '*'), 500);",
      ),
      studioHtml('运行').replace(
        "const prompt = document.querySelector('#goal').value.trim();",
        "const mockResult = '完成'; const prompt = document.querySelector('#goal').value.trim();",
      ),
    ]) {
      await expect(
        tool.execute('studio-invalid', { kind: 'html', title: '坏页面', content }),
      ).rejects.toBeInstanceOf(StudioArtifactValidationError);
    }
    expect(db.artifacts.size).toBe(0);
    expect(db.capabilities.get(cap.id)?.ui_artifact_id).toBeNull();
    expect(store.objects.size).toBe(0);
  });
});

describe('capability 当前 UI 会话快照', () => {
  it('新 consume 拿创建时 UI；Studio 更新后新会话拿新版，旧会话保持不变', async () => {
    const { db, store, cap, studio, turnId, tool } = await setupStudio();
    cap.published = true;
    const first = await tool.execute('studio-v1', {
      kind: 'html',
      title: 'Agent UI',
      content: studioHtml('版本一'),
    });
    db.turns.get(turnId)!.status = 'completed';
    await expect(
      bindCapabilityUiArtifact(db, {
        capabilityId: cap.id,
        artifactId: first.details!.artifactId,
        studioSessionId: studio.id,
        turnId: 'another-turn',
      }),
    ).resolves.toBe(false);
    expect(cap.ui_artifact_id).toBeNull();
    await bindCapabilityUiArtifact(db, {
      capabilityId: cap.id,
      artifactId: first.details!.artifactId,
      studioSessionId: studio.id,
      turnId,
    });

    const oldSession = await createSession(db, {
      capabilityId: cap.id,
      ownerUserId: 'consumer-a',
    });
    const oldView = await seedCapabilityUiArtifact(db, store, {
      capabilityId: cap.id,
      targetSessionId: oldSession.id,
      targetOwnerUserId: 'consumer-a',
      targetMode: 'consume',
    });
    const oldKey = artifactStorageKey(oldSession.id, oldView!.id);
    expect(await store.getObjectText(ARTIFACT_BUCKET as never, oldKey)).toContain('版本一');

    const secondTurnId = `${turnId}-next`;
    addRunningTurn(db, studio.id, secondTurnId);
    const secondTool = createArtifactTool({
      db,
      objectStore: store,
      sessionId: studio.id,
      turnId: secondTurnId,
      turnSignal: new AbortController().signal,
      capabilityId: cap.id,
      mode: 'studio',
      onArtifact: () => undefined,
    });
    const second = await secondTool.execute('studio-v2', {
      kind: 'html',
      title: 'Agent UI',
      content: studioHtml('版本二'),
    });
    db.turns.get(secondTurnId)!.status = 'completed';
    await bindCapabilityUiArtifact(db, {
      capabilityId: cap.id,
      artifactId: second.details!.artifactId,
      studioSessionId: studio.id,
      turnId: secondTurnId,
    });
    const newSession = await createSession(db, {
      capabilityId: cap.id,
      ownerUserId: 'consumer-b',
    });
    const newView = await seedCapabilityUiArtifact(db, store, {
      capabilityId: cap.id,
      targetSessionId: newSession.id,
      targetOwnerUserId: 'consumer-b',
      targetMode: 'consume',
    });
    const newKey = artifactStorageKey(newSession.id, newView!.id);

    expect(await store.getObjectText(ARTIFACT_BUCKET as never, newKey)).toContain('版本二');
    expect(await store.getObjectText(ARTIFACT_BUCKET as never, oldKey)).toContain('版本一');
  });

  it('capability 尚无 UI 时保持旧兼容路径，不创建空 artifact', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const cap = db.seedCapability({ owner_user_id: 'creator' });
    const session = await createSession(db, {
      capabilityId: cap.id,
      ownerUserId: 'creator',
    });

    await expect(
      seedCapabilityUiArtifact(db, store, {
        capabilityId: cap.id,
        targetSessionId: session.id,
        targetOwnerUserId: 'creator',
        targetMode: 'consume',
      }),
    ).resolves.toBeNull();
    expect(db.artifacts.size).toBe(0);
  });

  it('目标 Session 行锁内复查，发现并发请求已 seed 后直接返回且不重复插入', async () => {
    const db = new SeedInterleavingFakeDb();
    const store = new FakeObjectStore();
    const cap = db.seedCapability({ owner_user_id: 'creator' });
    const studio = await getOrCreateStudioSession(db, {
      capabilityId: cap.id,
      ownerUserId: 'creator',
    });
    const sourceId = 'source-ui';
    const sourceKey = artifactStorageKey(studio.id, sourceId);
    const timestamp = new Date().toISOString();
    db.artifacts.set(sourceId, {
      id: sourceId,
      session_id: studio.id,
      turn_id: null,
      kind: 'html',
      title: 'source',
      storage_key: sourceKey,
      meta: {},
      created_at: timestamp,
      updated_at: timestamp,
    });
    cap.ui_artifact_id = sourceId;
    store.seedText(ARTIFACT_BUCKET, sourceKey, studioHtml('运行'));
    const target = await createSession(db, {
      capabilityId: cap.id,
      ownerUserId: 'consumer',
    });
    db.targetSessionId = target.id;
    db.queries.length = 0;
    db.txLog.length = 0;

    const seeded = await seedCapabilityUiArtifact(db, store, {
      capabilityId: cap.id,
      targetSessionId: target.id,
      targetOwnerUserId: 'consumer',
      targetMode: 'consume',
    });

    expect(seeded?.id).toBe(db.injectedArtifactId);
    expect(
      [...db.artifacts.values()].filter((artifact) => artifact.session_id === target.id),
    ).toHaveLength(1);
    expect(db.txLog).toEqual(['BEGIN', 'COMMIT']);
    const lockIndex = db.queries.findIndex(
      (query) =>
        query.startsWith('SELECT id FROM sessions WHERE id = $1 AND capability_id = $2') &&
        query.endsWith('FOR UPDATE'),
    );
    const lockedRecheckIndex = db.queries.findIndex(
      (query, index) =>
        index > lockIndex &&
        query.includes('FROM artifacts a LEFT JOIN turns t ON t.id = a.turn_id'),
    );
    expect(lockIndex).toBeGreaterThan(-1);
    expect(lockedRecheckIndex).toBeGreaterThan(lockIndex);
  });

  it('seed 在锁内拒绝 capability/owner/mode 不匹配的目标 Session', async () => {
    const { db, store, cap, studio, turnId, tool } = await setupStudio();
    const source = await tool.execute('seed-guard-source', {
      kind: 'html',
      title: 'source',
      content: studioHtml('运行'),
    });
    db.turns.get(turnId)!.status = 'completed';
    await bindCapabilityUiArtifact(db, {
      capabilityId: cap.id,
      artifactId: source.details!.artifactId,
      studioSessionId: studio.id,
      turnId,
    });
    const target = await createSession(db, {
      capabilityId: cap.id,
      ownerUserId: 'consumer',
    });
    const otherCapability = db.seedCapability({ owner_user_id: 'creator' });

    for (const input of [
      {
        capabilityId: otherCapability.id,
        targetOwnerUserId: 'consumer',
        targetMode: 'consume' as const,
      },
      {
        capabilityId: cap.id,
        targetOwnerUserId: 'attacker',
        targetMode: 'consume' as const,
      },
      {
        capabilityId: cap.id,
        targetOwnerUserId: 'consumer',
        targetMode: 'studio' as const,
      },
    ]) {
      await expect(
        seedCapabilityUiArtifact(db, store, {
          ...input,
          targetSessionId: target.id,
        }),
      ).rejects.toThrow('target session identity mismatch');
    }
    expect(
      [...db.artifacts.values()].filter((artifact) => artifact.session_id === target.id),
    ).toHaveLength(0);
    expect(db.txLog.at(-1)).toBe('ROLLBACK');
  });

  it('当前 UI 读写都拒绝 owner 与 Capability 创作者不一致的 Studio', async () => {
    const db = new FakeDb();
    const cap = db.seedCapability({ owner_user_id: 'creator' });
    const foreignStudio = await getOrCreateStudioSession(db, {
      capabilityId: cap.id,
      ownerUserId: 'attacker',
    });
    const turnId = 'foreign-studio-turn';
    addRunningTurn(db, foreignStudio.id, turnId);
    const artifactId = 'foreign-studio-artifact';
    const timestamp = new Date().toISOString();
    db.artifacts.set(artifactId, {
      id: artifactId,
      session_id: foreignStudio.id,
      turn_id: turnId,
      kind: 'html',
      title: 'foreign',
      storage_key: artifactStorageKey(foreignStudio.id, artifactId),
      meta: {},
      created_at: timestamp,
      updated_at: timestamp,
    });
    db.turns.get(turnId)!.status = 'completed';
    cap.ui_artifact_id = artifactId;

    await expect(readCapabilityUiArtifact(db, cap.id)).resolves.toBeNull();
    cap.ui_artifact_id = null;
    await expect(
      bindCapabilityUiArtifact(db, {
        capabilityId: cap.id,
        artifactId,
        studioSessionId: foreignStudio.id,
        turnId,
      }),
    ).resolves.toBe(false);
  });
});
