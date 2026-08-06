import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeIdCursor, type ObjectStorePort } from '@cb/shared';
import type { Queryable } from '../platform/infra/db.js';
import type { TxPool } from '../platform/infra/db-tx.js';

const mocks = vi.hoisted(() => ({
  listAgentProjects: vi.fn(),
  saveAgentRevision: vi.fn(),
  readAgentProjectDetail: vi.fn(),
  readAgentRevisionDetail: vi.fn(),
  publishAgentRevision: vi.fn(),
}));

vi.mock('../modules/agent-project/index.js', async () => {
  const actual = (await vi.importActual('../modules/agent-project/index.js')) as Record<
    string,
    unknown
  >;
  return {
    ...actual,
    listAgentProjects: mocks.listAgentProjects,
    saveAgentRevision: mocks.saveAgentRevision,
    readAgentProjectDetail: mocks.readAgentProjectDetail,
    readAgentRevisionDetail: mocks.readAgentRevisionDetail,
    publishAgentRevision: mocks.publishAgentRevision,
  };
});

import { executeExternalMcpTool } from '../modules/external-mcp/tools.js';
import type { McpRuntimeClient } from '../modules/external-mcp/runtime-client.js';

const OWNER_ID = '00000000-0000-4000-8000-000000000001';
const PROJECT_ID = '00000000-0000-4000-8000-000000000002';
const REVISION_ID = '00000000-0000-4000-8000-000000000003';
const CAPABILITY_ID = '00000000-0000-4000-8000-000000000004';
const ARTIFACT_ID = '00000000-0000-4000-8000-000000000005';
const TEST_ID = '00000000-0000-4000-8000-000000000006';
const SESSION_ID = '00000000-0000-4000-8000-000000000007';
const SHA = 'a'.repeat(64);
const NOW = '2026-08-06T00:00:00.000Z';

const revisionRecord = {
  id: REVISION_ID,
  projectId: PROJECT_ID,
  revisionNumber: 1,
  parentRevisionId: null,
  entryCapabilityId: CAPABILITY_ID,
  definitionStorageKey: 'private/definition.json',
  definitionSha256: SHA,
  runtimeBundleStorageKey: 'private/runtime.json',
  runtimeBundleSha256: SHA,
  uiArtifactId: ARTIFACT_ID,
  uiStorageKey: 'private/ui.html',
  uiSha256: SHA,
  compilerVersion: 'combo-agent-compiler/1',
  changeSummary: 'Initial',
  mutationId: 'private-mutation-id',
  mutationSha256: 'b'.repeat(64),
  createdAt: NOW,
};

const projectDetail = {
  project: {
    id: PROJECT_ID,
    name: 'Agent',
    summary: '',
    sourceTaskId: null,
    status: 'active' as const,
    headRevisionId: REVISION_ID,
    currentReleaseId: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
  headRevision: {
    id: REVISION_ID,
    projectId: PROJECT_ID,
    revisionNumber: 1,
    parentRevisionId: null,
    entryCapabilityId: CAPABILITY_ID,
    definitionSha256: SHA,
    runtimeBundleSha256: SHA,
    uiArtifactId: ARTIFACT_ID,
    uiSha256: SHA,
    compilerVersion: 'combo-agent-compiler/1',
    changeSummary: 'Initial',
    createdAt: NOW,
  },
  currentRelease: null,
};

const definition = {
  schemaVersion: 'combo.agent/1' as const,
  identity: { name: 'Agent', summary: '' },
  interface: { inputs: [], output: { type: 'text' as const }, starterPrompts: [] },
  behavior: {
    instructions: 'Help the user.',
    capabilities: [{ capabilityId: CAPABILITY_ID, role: 'entry' as const }],
  },
  ui: { kind: 'miniapp-html' as const, artifactId: ARTIFACT_ID, bridgeVersion: 1 as const },
  runtime: { mode: 'single-loop' as const },
};
const capabilityDefinition = {
  version: 1 as const,
  name: 'Entry capability',
  summary: '',
  kind: 'knowledge',
  instructions: 'Answer with evidence.',
  inputs: [],
  starterPrompts: [],
  meta: {},
};

function context(runtime: Partial<McpRuntimeClient> = {}) {
  return {
    db: { query: vi.fn() } as unknown as Queryable,
    txPool: { connect: vi.fn() } as unknown as TxPool,
    objectStore: {} as ObjectStorePort,
    principal: {
      userId: OWNER_ID,
      account: 'creator-aaaaaaaa',
      scopes: ['combo.agent:read', 'combo.agent:write'] as Array<
        'combo.agent:read' | 'combo.agent:write'
      >,
    },
    publicOrigin: 'https://test.example',
    runtime: runtime as McpRuntimeClient,
    traceId: 'trace-tools-test',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readAgentProjectDetail.mockResolvedValue(projectDetail);
});

describe('external MCP public tool results', () => {
  it('returns a non-empty list_capabilities page as matching text and structured content', async () => {
    const secondCapabilityId = '00000000-0000-4000-8000-000000000003';
    const firstRow = {
      id: CAPABILITY_ID,
      task_id: '00000000-0000-4000-8000-000000000010',
      name: 'Entry capability',
      summary: 'A reusable workflow.',
      kind: 'knowledge',
      published: false,
      published_at: null,
      share_token: null,
      created_at: NOW,
    };
    const secondRow = {
      id: secondCapabilityId,
      task_id: '00000000-0000-4000-8000-000000000011',
      name: 'Second capability',
      summary: '',
      kind: 'workflow',
      published: true,
      published_at: NOW,
      share_token: 'share-token',
      created_at: NOW,
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [firstRow, secondRow], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [secondRow], rowCount: 1 });
    const testContext = context();
    testContext.db = { query } as unknown as Queryable;

    const first = await executeExternalMcpTool(testContext, 'list_capabilities', { limit: 1 });

    const expected = {
      items: [
        {
          id: CAPABILITY_ID,
          taskId: '00000000-0000-4000-8000-000000000010',
          name: 'Entry capability',
          summary: 'A reusable workflow.',
          kind: 'knowledge',
          published: false,
          createdAt: NOW,
        },
      ],
      page: {
        nextCursor: encodeIdCursor(CAPABILITY_ID),
        hasMore: true,
        limit: 1,
      },
      nextAction: null,
    };
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('FROM capabilities'), [
      OWNER_ID,
      null,
      null,
      2,
    ]);
    expect(first.isError).toBeUndefined();
    expect(first.structuredContent).toEqual(expected);
    expect(JSON.parse(first.content[0]!.text)).toEqual(expected);

    const second = await executeExternalMcpTool(testContext, 'list_capabilities', {
      cursor: encodeIdCursor(CAPABILITY_ID),
      limit: 1,
    });
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('FROM capabilities'), [
      OWNER_ID,
      null,
      CAPABILITY_ID,
      2,
    ]);
    expect(second.isError).toBeUndefined();
    expect(second.structuredContent).toEqual({
      items: [
        {
          id: secondCapabilityId,
          taskId: secondRow.task_id,
          name: secondRow.name,
          summary: secondRow.summary,
          kind: secondRow.kind,
          published: true,
          publishedAt: NOW,
          shareToken: 'share-token',
          createdAt: NOW,
        },
      ],
      page: { nextCursor: null, hasMore: false, limit: 1 },
      nextAction: null,
    });
    expect(JSON.parse(second.content[0]!.text)).toEqual(second.structuredContent);
  });

  it('guides a first-time user from an empty capability list into extraction', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const testContext = context();
    testContext.db = { query } as unknown as Queryable;

    const result = await executeExternalMcpTool(testContext, 'list_capabilities', {});

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      items: [],
      page: { nextCursor: null, hasMore: false, limit: 20 },
      nextAction: {
        kind: 'extract_capabilities',
        tool: 'create_extraction_task',
        requiresSourceAuthorization: true,
        userMessage: '还没有可用 Capability。请先确认要使用的本地对话历史范围，再开始能力提取。',
      },
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);

    const filtered = await executeExternalMcpTool(testContext, 'list_capabilities', {
      taskId: '00000000-0000-4000-8000-000000000010',
    });
    expect(filtered.structuredContent).toMatchObject({ items: [], nextAction: null });

    const exhaustedPage = await executeExternalMcpTool(testContext, 'list_capabilities', {
      cursor: encodeIdCursor(CAPABILITY_ID),
    });
    expect(exhaustedPage.structuredContent).toMatchObject({ items: [], nextAction: null });
  });

  it('returns list_agent_projects with items/page keys', async () => {
    mocks.listAgentProjects.mockResolvedValue({ items: [projectDetail.project], hasMore: false });
    const result = await executeExternalMcpTool(context(), 'list_agent_projects', {});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      items: [projectDetail.project],
      page: { hasMore: false, nextCursor: null },
    });
    expect(result.structuredContent).not.toHaveProperty('projects');
  });

  it('maps internal revision records to the public view without storage or mutation fields', async () => {
    mocks.saveAgentRevision.mockResolvedValue({ kind: 'created', revision: revisionRecord });
    const result = await executeExternalMcpTool(context(), 'commit_agent_revision', {
      projectId: PROJECT_ID,
      expectedHeadRevisionId: null,
      mutationId: 'mutation-request-123',
      changeSummary: 'Initial',
      definition,
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.revision).toMatchObject({
      id: REVISION_ID,
      projectId: PROJECT_ID,
      definitionSha256: SHA,
      runtimeBundleSha256: SHA,
    });
    const serialized = JSON.stringify(result.structuredContent);
    for (const privateField of [
      'definitionStorageKey',
      'runtimeBundleStorageKey',
      'uiStorageKey',
      'mutationId',
      'mutationSha256',
      'private/definition.json',
    ]) {
      expect(serialized).not.toContain(privateField);
    }
  });

  it('projects read_agent_revision without Runtime UI storage or mutation internals', async () => {
    mocks.readAgentRevisionDetail.mockResolvedValue({
      revision: projectDetail.headRevision,
      definition,
      capabilitySnapshots: [
        {
          capabilityId: CAPABILITY_ID,
          role: 'entry',
          definitionSha256: SHA,
          definition: capabilityDefinition,
        },
      ],
      runtimeBundle: {
        version: 1,
        compilerVersion: 'combo-agent-compiler/1',
        projectId: PROJECT_ID,
        revisionId: REVISION_ID,
        entryCapabilityId: CAPABILITY_ID,
        definition: capabilityDefinition,
        capabilityHashes: [{ capabilityId: CAPABILITY_ID, role: 'entry', definitionSha256: SHA }],
        ui: {
          artifactId: ARTIFACT_ID,
          storageKey: 'private/runtime-ui/index.html',
          sha256: SHA,
          bridgeVersion: 1,
        },
      },
    });

    const result = await executeExternalMcpTool(context(), 'read_agent_revision', {
      projectId: PROJECT_ID,
      revisionId: REVISION_ID,
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.runtimeBundle).toMatchObject({
      ui: { artifactId: ARTIFACT_ID, sha256: SHA, bridgeVersion: 1 },
    });
    const serialized = JSON.stringify(result.structuredContent);
    for (const privateValue of [
      'storageKey',
      'private/runtime-ui/index.html',
      'definitionStorageKey',
      'runtimeBundleStorageKey',
      'uiStorageKey',
      'mutationId',
      'mutationSha256',
      'private-mutation-id',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('derives publish revision identity from a passed Test and rejects cross-project Tests', async () => {
    const runtime = {
      readAgentTest: vi.fn().mockResolvedValue({
        test: {
          id: TEST_ID,
          projectId: PROJECT_ID,
          agentRevisionId: REVISION_ID,
          runtimeBundleSha256: SHA,
          uiSha256: SHA,
          sessionId: SESSION_ID,
          turnId: '00000000-0000-4000-8000-000000000008',
          status: 'passed',
          errorCode: null,
          createdAt: NOW,
          completedAt: NOW,
        },
        outputText: 'ok',
      }),
    };
    mocks.publishAgentRevision.mockResolvedValue({
      kind: 'created',
      release: {
        id: '00000000-0000-4000-8000-000000000009',
        projectId: PROJECT_ID,
        versionNumber: 1,
        agentRevisionId: REVISION_ID,
        qualifyingTestId: TEST_ID,
        runtimeBundleSha256: SHA,
        uiSha256: SHA,
        releaseSha256: SHA,
        notes: '',
        runtimePath: `/try/a/${PROJECT_ID}`,
        createdAt: NOW,
      },
    });

    await executeExternalMcpTool(context(runtime), 'publish_agent_revision', {
      projectId: PROJECT_ID,
      testId: TEST_ID,
      idempotencyKey: 'publish-request-123',
    });
    expect(mocks.publishAgentRevision).toHaveBeenCalledWith(expect.anything(), {
      projectId: PROJECT_ID,
      ownerUserId: OWNER_ID,
      body: {
        expectedHeadRevisionId: REVISION_ID,
        agentRevisionId: REVISION_ID,
        qualifyingTestId: TEST_ID,
        idempotencyKey: 'publish-request-123',
        notes: '',
      },
    });

    runtime.readAgentTest.mockResolvedValueOnce({
      ...(await runtime.readAgentTest.mock.results[0]!.value),
      test: {
        ...(await runtime.readAgentTest.mock.results[0]!.value).test,
        projectId: '00000000-0000-4000-8000-000000000099',
      },
    });
    const rejected = await executeExternalMcpTool(context(runtime), 'publish_agent_revision', {
      projectId: PROJECT_ID,
      testId: TEST_ID,
      idempotencyKey: 'publish-request-456',
    });
    expect(rejected.isError).toBe(true);
    expect(mocks.publishAgentRevision).toHaveBeenCalledTimes(1);
  });
});
