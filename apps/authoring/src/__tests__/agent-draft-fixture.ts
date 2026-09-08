import { randomUUID } from 'node:crypto';
import {
  createCreatorAgentPackageDraftSnapshotV2,
  serializeCreatorAgentPackageDraftSnapshotV2,
} from '@cb/creator-agent-protocol/agent-package-draft';
import { compileCreatorAgentPackageDraftV2 } from '@cb/creator-worker/agent-package-compiler';
import {
  AgentDraftFailure,
  type DraftRepository,
  type DraftRow,
} from '../modules/agent-draft/service.js';
import type { ImmutableObjectStore } from '../platform/infra/object-store.js';

export function draftFixture(id = randomUUID().replaceAll('-', '')) {
  return createCreatorAgentPackageDraftSnapshotV2({
    protocol: 'combo.agent-package-draft/2',
    draftId: `draft.agent-package.${id}`,
    revision: 1,
    parentDraftFingerprint: null,
    creatorRequest: {
      protocol: 'combo.agent-package-creator-request/2',
      intent: 'create_agent_package_from_current_conversation',
      request: '把刚才的方法做成 Agent。',
    },
    source: {
      kind: 'current_conversation',
      sourceBoundary: 'desktop_attested_active_current_task',
      snapshotBoundary: 'before_direct_creator_item',
      visibility: 'user_visible_items_only',
      snapshotCompleteness: 'complete',
      rawStored: false,
      snapshotCommitmentScheme: 'host_hmac_sha256_per_run/1',
      snapshotCommitment: `sha256:${'a'.repeat(64)}`,
      selectedVisibleItemCount: 2,
      coverageSummary: '测试样例，不是真实 Desktop 来源。',
    },
    content: {
      name: '证据检查助手',
      description: '核对证据再形成结论。',
      instructions: '先检查来源，再列出缺口，最后给出结论。',
      starterPrompts: ['检查这份结论。'],
      outputDescription: '结论与证据缺口。',
    },
  });
}
export function uploadFixture(draft = draftFixture(), requestId: string = randomUUID()) {
  const draftText = serializeCreatorAgentPackageDraftSnapshotV2(draft);
  const compiled = compileCreatorAgentPackageDraftV2(draftText);
  return {
    protocol: 'combo.agent-draft-upload/1' as const,
    requestId,
    draftText,
    candidate: {
      manifestText: compiled.manifestText,
      packageDigest: compiled.packageDigest,
      compilationReceiptText: compiled.compilationReceiptText,
      files: compiled.files.map((file) => ({ ...file })),
    },
  };
}
export function assertDisposableDraftDatabase(connectionString: string, githubActions = false) {
  const url = new URL(connectionString);
  const queryKeys = [...url.searchParams.keys()];
  if (new Set(queryKeys).size !== queryKeys.length)
    throw new Error('duplicate connection parameters');
  const socket = url.searchParams.get('host');
  const temporarySocket = socket !== null && /^\/tmp\/combo-draft-pg\.[a-zA-Z0-9]+$/u.test(socket);
  const localTcp = socket === null && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const safeName =
    /^\/combo_draft_test_[a-z0-9]{6,32}$/u.test(url.pathname) ||
    (temporarySocket && url.pathname === '/combo_draft_test') ||
    (githubActions && localTcp && url.pathname === '/agora');
  if (
    (!temporarySocket && !localTcp) ||
    !safeName ||
    [...url.searchParams.keys()].some((key) => !['host', 'port'].includes(key))
  )
    throw new Error('private draft tests require an explicitly named local disposable database');
}
export class TestObjects implements ImmutableObjectStore {
  values = new Map<string, Uint8Array>();
  writes = 0;
  fail = false;
  async commit(input: Parameters<ImmutableObjectStore['commit']>[0]) {
    this.writes++;
    if (this.fail) throw new Error('private-storage-error-do-not-expose');
    const old = this.values.get(input.key);
    if (old && !Buffer.from(old).equals(Buffer.from(input.bytes))) throw new Error('conflict');
    this.values.set(input.key, Uint8Array.from(input.bytes));
    return {
      outcome: old ? ('already_committed' as const) : ('created' as const),
      size: input.bytes.length,
    };
  }
  async read(input: Parameters<ImmutableObjectStore['read']>[0]) {
    const value = this.values.get(input.key);
    if (!value) throw new Error('missing');
    return Uint8Array.from(value);
  }
}
export class TestDraftRepository implements DraftRepository {
  rows: DraftRow[] = [];
  private tail = Promise.resolve();
  async save(
    input: Parameters<DraftRepository['save']>[0],
    commit: (previous: DraftRow | null) => Promise<void>,
  ) {
    const before = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await before;
    try {
      const existing = this.rows.find(
        (row) => row.owner_user_id === input.owner_user_id && row.request_id === input.request_id,
      );
      if (existing) {
        if (existing.snapshot_digest !== input.snapshot_digest)
          throw new AgentDraftFailure('idempotency_conflict');
        return { row: existing, created: false };
      }
      const latest = this.rows
        .filter(
          (row) => row.owner_user_id === input.owner_user_id && row.draft_id === input.draft_id,
        )
        .at(-1);
      if (
        input.revision !== (latest?.revision ?? 0) + 1 ||
        input.parent_fingerprint !== (latest?.draft_fingerprint ?? null)
      )
        throw new AgentDraftFailure('revision_conflict');
      await commit(latest ?? null);
      const row = {
        ...input,
        view_id: latest?.view_id ?? randomUUID(),
        created_at: new Date().toISOString(),
      };
      this.rows.push(row);
      return { row, created: true };
    } finally {
      release();
    }
  }
  async read(owner: string, id: string, revision: number) {
    return (
      this.rows.find(
        (row) => row.owner_user_id === owner && row.draft_id === id && row.revision === revision,
      ) ?? null
    );
  }
}
