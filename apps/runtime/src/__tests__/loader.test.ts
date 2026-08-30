// loader 权限闸与定义校验：本人未发布可试 / 他人未发布拒 / published 放行 / 坏 version 拒。
import { describe, expect, it } from 'vitest';
import { serializeCreatorAgentPackageCapability } from '@cb/creator-agent-protocol/agent-package-capability';
import {
  CAPABILITY_BUCKET,
  listTrialCapabilities,
  loadCapability,
} from '../modules/capability/loader.js';
import { FakeDb, FakeObjectStore } from './fakes.js';

const ME = 'user-me';
const OTHER = 'user-other';
const PACKAGE_DIGEST = `sha256:${'a'.repeat(64)}`;
const RELEASE_ID = `release.agent-package.${'1'.repeat(32)}`;

function seedDefinition(
  store: FakeObjectStore,
  storageKey: string,
  overrides: Record<string, unknown> = {},
): void {
  store.seedText(
    CAPABILITY_BUCKET,
    storageKey,
    JSON.stringify({
      version: 1,
      name: '会议纪要生成',
      summary: '把速记变成结构化纪要',
      kind: 'writing',
      instructions: '你是一名会议纪要专家。',
      meta: {},
      ...overrides,
    }),
  );
}

describe('loadCapability 权限闸', () => {
  it('本人的未发布能力可加载', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const cap = db.seedCapability({ owner_user_id: ME, published: false });
    seedDefinition(store, cap.storage_key);

    const result = await loadCapability(db, store, cap.id, ME);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.definition.version).toBe(1);
      if (result.definition.version !== 1) return;
      expect(result.capability.id).toBe(cap.id);
      expect(result.definition.instructions).toContain('会议纪要');
    }
  });

  it('他人的未发布能力 → not_found（不暴露存在性）', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const cap = db.seedCapability({ owner_user_id: OTHER, published: false });
    seedDefinition(store, cap.storage_key);

    const result = await loadCapability(db, store, cap.id, ME);
    expect(result.kind).toBe('not_found');
  });

  it('他人的已发布能力放行', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const cap = db.seedCapability({ owner_user_id: OTHER, published: true });
    seedDefinition(store, cap.storage_key);

    const result = await loadCapability(db, store, cap.id, ME);
    expect(result.kind).toBe('ok');
  });

  it('不存在的能力 → not_found', async () => {
    const db = new FakeDb();
    const result = await loadCapability(db, new FakeObjectStore(), 'cap-nope', ME);
    expect(result.kind).toBe('not_found');
  });

  it('loads only the exact canonical Agent Package Capability v2 projection', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const cap = db.seedCapability({ owner_user_id: ME });
    store.seedText(
      CAPABILITY_BUCKET,
      cap.storage_key,
      serializeCreatorAgentPackageCapability({
        version: 2,
        protocol: 'combo.agent-package-capability/2',
        release: {
          protocol: 'combo.agent-package-release/1',
          releaseId: RELEASE_ID,
          packageDigest: PACKAGE_DIGEST,
        },
      }),
    );

    const result = await loadCapability(db, store, cap.id, ME);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.definition).toMatchObject({
        version: 2,
        protocol: 'combo.agent-package-capability/2',
        release: { releaseId: RELEASE_ID, packageDigest: PACKAGE_DIGEST },
      });
    }
  });

  it('rejects a semantically valid but non-canonical v2 projection', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const cap = db.seedCapability({ owner_user_id: ME });
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

    await expect(loadCapability(db, store, cap.id, ME)).resolves.toEqual({
      kind: 'invalid_definition',
    });
  });

  it.each([
    ['protocol only', { protocol: 'combo.agent-package-capability/2' }],
    [
      'release only',
      {
        release: {
          protocol: 'combo.agent-package-release/1',
          releaseId: RELEASE_ID,
          packageDigest: PACKAGE_DIGEST,
        },
      },
    ],
    [
      'protocol and release',
      {
        protocol: 'combo.agent-package-capability/2',
        release: {
          protocol: 'combo.agent-package-release/1',
          releaseId: RELEASE_ID,
          packageDigest: PACKAGE_DIGEST,
        },
      },
    ],
  ])(
    'version 1 混入 Agent Package reserved field（%s）→ invalid_definition，不执行 legacy 提示词',
    async (_caseName, reservedFields) => {
      const db = new FakeDb();
      const store = new FakeObjectStore();
      const cap = db.seedCapability({ owner_user_id: ME });
      seedDefinition(store, cap.storage_key, reservedFields);

      const result = await loadCapability(db, store, cap.id, ME);
      expect(result.kind).toBe('invalid_definition');
    },
  );

  it('定义结构坏了（version 对但缺 instructions）→ invalid_definition', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const cap = db.seedCapability({ owner_user_id: ME });
    seedDefinition(store, cap.storage_key, { instructions: '' });

    const result = await loadCapability(db, store, cap.id, ME);
    expect(result.kind).toBe('invalid_definition');
  });

  it('MinIO 里不是合法 JSON → invalid_definition', async () => {
    const db = new FakeDb();
    const store = new FakeObjectStore();
    const cap = db.seedCapability({ owner_user_id: ME });
    store.seedText(CAPABILITY_BUCKET, cap.storage_key, 'not-json');

    const result = await loadCapability(db, store, cap.id, ME);
    expect(result.kind).toBe('invalid_definition');
  });
});

describe('listTrialCapabilities（试用入口）', () => {
  it('返回我的全部 + 他人已发布的；他人未发布的不可见', async () => {
    const db = new FakeDb();
    const mineUnpublished = db.seedCapability({ owner_user_id: ME, published: false });
    const minePublished = db.seedCapability({ owner_user_id: ME, published: true });
    const otherPublished = db.seedCapability({ owner_user_id: OTHER, published: true });
    db.seedCapability({ owner_user_id: OTHER, published: false }); // 不可见

    const items = await listTrialCapabilities(db, ME);
    const ids = items.map((i) => i.id);
    expect(ids).toHaveLength(3);
    expect(ids).toEqual(
      expect.arrayContaining([mineUnpublished.id, minePublished.id, otherPublished.id]),
    );
    expect(items.find((i) => i.id === otherPublished.id)?.owned).toBe(false);
    expect(items.find((i) => i.id === mineUnpublished.id)?.owned).toBe(true);
  });
});
