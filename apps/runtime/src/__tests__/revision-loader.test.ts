import { createHash } from 'node:crypto';
import type { AgentRuntimeBundle } from '@cb/shared';
import { describe, expect, it } from 'vitest';
import {
  loadCurrentAgentRelease,
  loadOwnedAgentRevision,
  loadPinnedSessionAgentRevision,
} from '../modules/agent/revision-loader.js';
import { ARTIFACT_BUCKET } from '../modules/artifact/repo.js';
import type { Queryable, QueryResultLike } from '../platform/infra/db.js';
import { FakeObjectStore } from './fakes.js';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const REVISION_ID = '00000000-0000-4000-8000-000000000002';
const ENTRY_CAPABILITY_ID = '00000000-0000-4000-8000-000000000003';
const SUPPORT_CAPABILITY_ID = '00000000-0000-4000-8000-000000000004';
const UI_ARTIFACT_ID = '00000000-0000-4000-8000-000000000005';
const RELEASE_ID = '00000000-0000-4000-8000-000000000006';
const OWNER_ID = '00000000-0000-4000-8000-000000000007';
const SHA = 'a'.repeat(64);
const UI_SHA = 'b'.repeat(64);
const RUNTIME_KEY = 'agent-revisions/runtime.json';

interface EligibilityRow {
  id: string;
  meta?: unknown;
}

class RevisionLoaderDb implements Queryable {
  eligibilityIds: string[] = [];

  constructor(
    private readonly revisionRow: Record<string, unknown>,
    private readonly capabilities: EligibilityRow[],
  ) {}

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('SELECT id, meta FROM capabilities')) {
      this.eligibilityIds = [...((params[0] as string[] | undefined) ?? [])];
      const allowed = new Set(this.eligibilityIds);
      const rows = this.capabilities.filter((row) => allowed.has(row.id));
      return { rows: rows as R[], rowCount: rows.length };
    }
    if (normalized.includes('FROM agent_')) {
      return { rows: [this.revisionRow] as R[], rowCount: 1 };
    }
    throw new Error(`RevisionLoaderDb: unhandled SQL: ${normalized}`);
  }
}

function makeBundle(): AgentRuntimeBundle {
  return {
    version: 1,
    compilerVersion: 'combo-agent-compiler/1',
    projectId: PROJECT_ID,
    revisionId: REVISION_ID,
    entryCapabilityId: ENTRY_CAPABILITY_ID,
    definition: {
      version: 1,
      name: '测试 Agent',
      summary: '验证 Runtime Capability 资格闸',
      kind: 'writing',
      instructions: '完成用户交付。',
      inputs: [],
      starterPrompts: [],
      meta: {},
    },
    capabilityHashes: [
      { capabilityId: ENTRY_CAPABILITY_ID, role: 'entry', definitionSha256: SHA },
      { capabilityId: SUPPORT_CAPABILITY_ID, role: 'support', definitionSha256: SHA },
    ],
    ui: {
      artifactId: UI_ARTIFACT_ID,
      storageKey: 'agent-revisions/ui.html',
      sha256: UI_SHA,
      bridgeVersion: 1,
    },
  };
}

function setup(capabilities: EligibilityRow[]): {
  db: RevisionLoaderDb;
  store: FakeObjectStore;
} {
  const bundle = makeBundle();
  const text = JSON.stringify(bundle);
  const db = new RevisionLoaderDb(
    {
      id: REVISION_ID,
      project_id: PROJECT_ID,
      entry_capability_id: ENTRY_CAPABILITY_ID,
      capability_owner_user_id: OWNER_ID,
      runtime_bundle_storage_key: RUNTIME_KEY,
      runtime_bundle_sha256: createHash('sha256').update(text).digest('hex'),
      ui_artifact_id: UI_ARTIFACT_ID,
      ui_storage_key: bundle.ui.storageKey,
      ui_sha256: UI_SHA,
      release_id: RELEASE_ID,
    },
    capabilities,
  );
  const store = new FakeObjectStore();
  store.seedText(ARTIFACT_BUCKET, RUNTIME_KEY, text);
  return { db, store };
}

const eligibleCapabilities: EligibilityRow[] = [
  { id: ENTRY_CAPABILITY_ID },
  { id: SUPPORT_CAPABILITY_ID, meta: { origin: 'llm' } },
];

describe('Agent Revision Runtime Capability 资格闸', () => {
  it.each([
    [
      'owned Test loader',
      (db: Queryable, store: FakeObjectStore) =>
        loadOwnedAgentRevision(db, store, { revisionId: REVISION_ID, ownerUserId: OWNER_ID }),
    ],
    [
      'current Release loader',
      (db: Queryable, store: FakeObjectStore) => loadCurrentAgentRelease(db, store, PROJECT_ID),
    ],
    [
      'pinned Session loader',
      (db: Queryable, store: FakeObjectStore) =>
        loadPinnedSessionAgentRevision(db, store, {
          revisionId: REVISION_ID,
          releaseId: RELEASE_ID,
          sessionOwnerUserId: OWNER_ID,
        }),
    ],
  ])('%s 会批查 entry 与全部 support，正常 llm/缺失 origin 可运行', async (_name, load) => {
    const { db, store } = setup(eligibleCapabilities);

    const result = await load(db, store);

    expect(result.kind).toBe('ok');
    expect(db.eligibilityIds).toEqual(
      expect.arrayContaining([ENTRY_CAPABILITY_ID, SUPPORT_CAPABILITY_ID]),
    );
    expect(db.eligibilityIds).toHaveLength(2);
  });

  it('任一 support Capability 标记 fallback 时 fail closed', async () => {
    const { db, store } = setup([
      { id: ENTRY_CAPABILITY_ID, meta: { origin: 'llm' } },
      { id: SUPPORT_CAPABILITY_ID, meta: { origin: 'fallback' } },
    ]);

    const result = await loadOwnedAgentRevision(db, store, {
      revisionId: REVISION_ID,
      ownerUserId: OWNER_ID,
    });

    expect(result.kind).toBe('not_found');
  });

  it('Bundle 引用的任一 Capability 已缺失时 fail closed', async () => {
    const { db, store } = setup([{ id: ENTRY_CAPABILITY_ID, meta: { origin: 'llm' } }]);

    const result = await loadCurrentAgentRelease(db, store, PROJECT_ID);

    expect(result.kind).toBe('not_found');
  });

  it('entry Capability 标记 fallback 时固定 Session 也 fail closed', async () => {
    const { db, store } = setup([
      { id: ENTRY_CAPABILITY_ID, meta: { origin: 'fallback' } },
      { id: SUPPORT_CAPABILITY_ID, meta: { origin: 'llm' } },
    ]);

    const result = await loadPinnedSessionAgentRevision(db, store, {
      revisionId: REVISION_ID,
      releaseId: RELEASE_ID,
      sessionOwnerUserId: OWNER_ID,
    });

    expect(result.kind).toBe('not_found');
  });
});
