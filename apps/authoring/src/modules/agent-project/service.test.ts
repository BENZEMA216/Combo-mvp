import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, type AgentDefinition, type CapabilityDefinition } from '@cb/shared';
import type { Queryable } from '../../platform/infra/db.js';
import type { TxPool } from '../../platform/infra/db-tx.js';
import { FakeObjectStore } from '../../__tests__/fakes.js';

const repo = vi.hoisted(() => ({
  commitAgentRevision: vi.fn(),
  createAgentProject: vi.fn(),
  createAgentRelease: vi.fn(),
  isOwnedSourceTask: vi.fn(),
  recordAgentTestReview: vi.fn(),
  readAgentProject: vi.fn(),
  readAgentRelease: vi.fn(),
  readAgentRevisionRecord: vi.fn(),
  readRevisionByMutation: vi.fn(),
  toAgentRevisionView: vi.fn((record: Record<string, unknown>) => record),
}));

vi.mock('./repo.js', () => repo);

import { AGENT_ARTIFACT_BUCKET } from './compiler.js';
import { publishAgentRevision, saveAgentRevision } from './service.js';

const OWNER_ID = '00000000-0000-4000-8000-000000000001';
const PROJECT_ID = '00000000-0000-4000-8000-000000000002';
const REVISION_ID = '00000000-0000-4000-8000-000000000003';
const CAPABILITY_ID = '00000000-0000-4000-8000-000000000004';
const SUPPORT_ID = '00000000-0000-4000-8000-000000000005';
const UI_ARTIFACT_ID = '00000000-0000-4000-8000-000000000006';
const TEST_ID = '00000000-0000-4000-8000-000000000007';
const DEFINITION_KEY = 'agent-projects/test/definition.json';
const RUNTIME_KEY = 'agent-projects/test/runtime.json';
const UI_SHA = 'a'.repeat(64);
const NOW = '2026-08-08T00:00:00.000Z';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function capabilityDefinition(meta: Record<string, unknown> = {}): CapabilityDefinition {
  return {
    version: 1,
    name: 'Research',
    summary: 'Research with evidence.',
    kind: 'workflow',
    instructions: 'Inspect the evidence before answering.',
    inputs: [],
    starterPrompts: [],
    meta,
  };
}

function agentDefinition(capabilityIds = [CAPABILITY_ID]): AgentDefinition {
  return {
    schemaVersion: 'combo.agent/1',
    identity: { name: 'Research Agent', summary: '' },
    interface: { inputs: [], output: { type: 'text' }, starterPrompts: [] },
    behavior: {
      instructions: 'Use the frozen capabilities.',
      capabilities: capabilityIds.map((capabilityId, index) => ({
        capabilityId,
        role: index === 0 ? ('entry' as const) : ('support' as const),
      })),
    },
    ui: { kind: 'miniapp-html', artifactId: UI_ARTIFACT_ID, bridgeVersion: 1 },
    runtime: { mode: 'single-loop' },
  };
}

async function revisionFixture(input?: {
  snapshotMetas?: Record<string, unknown>[];
  dbMetas?: Record<string, unknown>[];
}) {
  const snapshotMetas = input?.snapshotMetas ?? [{}];
  const ids = snapshotMetas.map((_, index) => (index === 0 ? CAPABILITY_ID : SUPPORT_ID));
  const definition = agentDefinition(ids);
  const snapshots = ids.map((capabilityId, index) => {
    const frozen = capabilityDefinition(snapshotMetas[index]);
    return {
      capabilityId,
      role: index === 0 ? ('entry' as const) : ('support' as const),
      definitionSha256: sha256(canonicalJson(frozen)),
      definition: frozen,
    };
  });
  const documentText = canonicalJson({ definition, capabilitySnapshots: snapshots });
  const runtimeDefinition = capabilityDefinition({ agent: { projectId: PROJECT_ID } });
  const runtimeBundle = {
    version: 1 as const,
    compilerVersion: 'combo-agent-compiler/1' as const,
    projectId: PROJECT_ID,
    revisionId: REVISION_ID,
    entryCapabilityId: CAPABILITY_ID,
    definition: runtimeDefinition,
    capabilityHashes: snapshots.map((snapshot) => ({
      capabilityId: snapshot.capabilityId,
      role: snapshot.role,
      definitionSha256: snapshot.definitionSha256,
    })),
    ui: {
      artifactId: UI_ARTIFACT_ID,
      storageKey: 'agent-ui/index.html',
      sha256: UI_SHA,
      bridgeVersion: 1 as const,
    },
  };
  const runtimeText = canonicalJson(runtimeBundle);
  const mutationBody = {
    expectedHeadRevisionId: null,
    mutationId: 'replay-mutation',
    changeSummary: 'Initial',
    definition,
  };
  const mutationSha256 = sha256(
    canonicalJson({
      expectedHeadRevisionId: mutationBody.expectedHeadRevisionId,
      changeSummary: mutationBody.changeSummary,
      definition: mutationBody.definition,
    }),
  );
  const record = {
    id: REVISION_ID,
    projectId: PROJECT_ID,
    revisionNumber: 1,
    parentRevisionId: null,
    entryCapabilityId: CAPABILITY_ID,
    definitionStorageKey: DEFINITION_KEY,
    definitionSha256: sha256(documentText),
    runtimeBundleStorageKey: RUNTIME_KEY,
    runtimeBundleSha256: sha256(runtimeText),
    uiArtifactId: UI_ARTIFACT_ID,
    uiStorageKey: runtimeBundle.ui.storageKey,
    uiSha256: UI_SHA,
    compilerVersion: runtimeBundle.compilerVersion,
    changeSummary: mutationBody.changeSummary,
    mutationId: mutationBody.mutationId,
    mutationSha256,
    createdAt: NOW,
  };
  const store = new FakeObjectStore();
  await store.putObject(
    AGENT_ARTIFACT_BUCKET,
    DEFINITION_KEY,
    new TextEncoder().encode(documentText),
  );
  await store.putObject(AGENT_ARTIFACT_BUCKET, RUNTIME_KEY, new TextEncoder().encode(runtimeText));
  const dbMetas = input?.dbMetas ?? ids.map(() => ({}));
  const db = {
    query: vi.fn().mockResolvedValue({
      rows: ids.map((id, index) => ({ id, meta: dbMetas[index] })),
      rowCount: ids.length,
    }),
  } as unknown as Queryable;
  repo.readAgentRevisionRecord.mockResolvedValue(record);
  repo.readRevisionByMutation.mockResolvedValue(record);
  return { db, store, record, mutationBody };
}

describe('Agent revision fallback eligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repo.createAgentRelease.mockResolvedValue({
      kind: 'replayed',
      release: { id: 'existing-release' },
    });
  });

  it.each([
    { label: 'frozen definition', snapshotMetas: [{ origin: 'fallback' }], dbMetas: [{}] },
    { label: 'database index', snapshotMetas: [{}], dbMetas: [{ origin: 'fallback' }] },
  ])('does not let an old idempotent commit replay bypass $label eligibility', async (fixture) => {
    const { db, store, mutationBody } = await revisionFixture(fixture);

    const outcome = await saveAgentRevision({} as TxPool, db, store, {
      projectId: PROJECT_ID,
      ownerUserId: OWNER_ID,
      body: mutationBody,
    });

    expect(outcome).toMatchObject({
      kind: 'compile_failed',
      error: { kind: 'capability_ineligible' },
    });
    expect(repo.commitAgentRevision).not.toHaveBeenCalled();
  });

  it('keeps a normal degraded LLM revision replayable', async () => {
    const meta = { origin: 'llm', degraded: true };
    const { db, store, record, mutationBody } = await revisionFixture({
      snapshotMetas: [meta],
      dbMetas: [meta],
    });

    await expect(
      saveAgentRevision({} as TxPool, db, store, {
        projectId: PROJECT_ID,
        ownerUserId: OWNER_ID,
        body: mutationBody,
      }),
    ).resolves.toEqual({ kind: 'replayed', revision: record });
  });

  it('blocks release replay when any frozen support capability is fallback', async () => {
    const { db, store } = await revisionFixture({
      snapshotMetas: [{}, { origin: 'fallback' }],
      dbMetas: [{}, {}],
    });

    const outcome = await publishAgentRevision({} as TxPool, db, store, {
      projectId: PROJECT_ID,
      ownerUserId: OWNER_ID,
      body: {
        expectedHeadRevisionId: REVISION_ID,
        agentRevisionId: REVISION_ID,
        qualifyingTestId: TEST_ID,
        idempotencyKey: 'existing-release-key',
        notes: '',
      },
    });

    expect(outcome).toEqual({ kind: 'capability_ineligible' });
    expect(repo.createAgentRelease).not.toHaveBeenCalled();
  });

  it('blocks release replay when the database index marks the capability as fallback', async () => {
    const { db, store } = await revisionFixture({
      snapshotMetas: [{}],
      dbMetas: [{ origin: 'fallback' }],
    });

    const outcome = await publishAgentRevision({} as TxPool, db, store, {
      projectId: PROJECT_ID,
      ownerUserId: OWNER_ID,
      body: {
        expectedHeadRevisionId: REVISION_ID,
        agentRevisionId: REVISION_ID,
        qualifyingTestId: TEST_ID,
        idempotencyKey: 'existing-release-key',
        notes: '',
      },
    });

    expect(outcome).toEqual({ kind: 'capability_ineligible' });
    expect(repo.createAgentRelease).not.toHaveBeenCalled();
  });

  it('preserves release idempotency for a normal capability with missing origin metadata', async () => {
    const { db, store } = await revisionFixture();

    await expect(
      publishAgentRevision({} as TxPool, db, store, {
        projectId: PROJECT_ID,
        ownerUserId: OWNER_ID,
        body: {
          expectedHeadRevisionId: REVISION_ID,
          agentRevisionId: REVISION_ID,
          qualifyingTestId: TEST_ID,
          idempotencyKey: 'existing-release-key',
          notes: '',
        },
      }),
    ).resolves.toMatchObject({ kind: 'replayed' });
    expect(repo.createAgentRelease).toHaveBeenCalledTimes(1);
  });
});
