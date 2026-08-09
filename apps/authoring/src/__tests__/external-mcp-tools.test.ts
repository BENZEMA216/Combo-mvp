import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeIdCursor, ProjectAgentShareResultSchema, type ObjectStorePort } from '@cb/shared';
import type { Queryable } from '../platform/infra/db.js';
import type { TxPool } from '../platform/infra/db-tx.js';

const mocks = vi.hoisted(() => ({
  listAgentProjects: vi.fn(),
  saveAgentRevision: vi.fn(),
  readAgentProjectDetail: vi.fn(),
  readAgentRevisionDetail: vi.fn(),
  publishAgentRevision: vi.fn(),
  recordAgentTestReview: vi.fn(),
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
    recordAgentTestReview: mocks.recordAgentTestReview,
  };
});

import {
  EXTERNAL_MCP_TOOLS,
  executeExternalMcpTool,
  renderCurrentCodexTaskConnectCommand,
} from '../modules/external-mcp/tools.js';
import type { McpRuntimeClient } from '../modules/external-mcp/runtime-client.js';

const CODEX_THREAD_ID_FIXTURE = '019fdd00-ff57-7550-be78-654a2e4cd49e';

function connectCommandEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_THREAD_ID: CODEX_THREAD_ID_FIXTURE,
    NO_PROXY: '127.0.0.1',
    no_proxy: '127.0.0.1',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    all_proxy: '',
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

async function runConnectCommand(
  command: string,
  env = connectCommandEnv(),
  xtrace = false,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn('sh', xtrace ? ['-x', '-c', command] : ['-c', command], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    const [status] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
    return { status, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

async function serveConnectScript(script: string): Promise<{
  server: Server;
  url: string;
  requestCount: () => number;
}> {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(script);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address unavailable');
  return {
    server,
    url: `http://127.0.0.1:${address.port}/api/v1/connect/script`,
    requestCount: () => requests,
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

const OWNER_ID = '00000000-0000-4000-8000-000000000001';
const PROJECT_ID = '00000000-0000-4000-8000-000000000002';
const REVISION_ID = '00000000-0000-4000-8000-000000000003';
const CAPABILITY_ID = '00000000-0000-4000-8000-000000000004';
const ARTIFACT_ID = '00000000-0000-4000-8000-000000000005';
const TEST_ID = '00000000-0000-4000-8000-000000000006';
const SESSION_ID = '00000000-0000-4000-8000-000000000007';
const REVIEW_ID = '00000000-0000-4000-8000-000000000008';
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
  it('appends the two Project Agent tools without reordering the existing catalog', () => {
    expect(EXTERNAL_MCP_TOOLS).toHaveLength(20);
    expect(EXTERNAL_MCP_TOOLS.slice(-2).map((tool) => tool.name)).toEqual([
      'create_project_agent_share',
      'read_project_agent_share',
    ]);
    const [createShare, readShare] = EXTERNAL_MCP_TOOLS.slice(-2);
    expect(createShare?.outputSchema).toBeDefined();
    expect(readShare?.outputSchema).toEqual(createShare?.outputSchema);
    expect(createShare?.outputSchema?.required).toEqual(['manifest', 'shareUrl', 'copyPrompt']);

    const sourceRef = createShare?.inputSchema.properties?.sourceRef as
      | { pattern?: string }
      | undefined;
    const repositoryUrl = createShare?.inputSchema.properties?.repositoryUrl as
      | { pattern?: string }
      | undefined;
    const repositoryUrlPattern = new RegExp(repositoryUrl?.pattern ?? 'fail');
    expect(repositoryUrlPattern.test('https://github.com/openai/codex.git')).toBe(true);
    for (const invalid of [
      'https://github.com/a-/repo.git',
      'https://github.com/a/..git',
      'https://github.com/a/...git',
      'https://github.com/a/repo.git.git',
    ]) {
      expect(repositoryUrlPattern.test(invalid), invalid).toBe(false);
    }
    const sourceRefPattern = new RegExp(sourceRef?.pattern ?? 'fail');
    expect(sourceRefPattern.test('refs/heads/foo./bar')).toBe(true);
    for (const invalid of [
      'refs/heads/trailing.',
      'refs/heads/a.lock',
      'refs/heads/feature/a.lock/child',
      'refs/heads/a..b',
      'refs/heads/a@{b',
      'refs/heads/a b',
      'refs/heads/a?b',
    ]) {
      expect(sourceRefPattern.test(invalid), invalid).toBe(false);
    }
  });

  it('locks the extraction command to the current Codex task', () => {
    const command = renderCurrentCodexTaskConnectCommand(
      'https://combo.example/api/v1/connect/script?code=one-time-code',
    );
    expect(command.startsWith('(set +x;')).toBe(true);
    expect(command).toContain('CODEX_THREAD_ID');
    expect(command).toContain(
      "combo_connect_script=$(curl -fsSL -- 'https://combo.example/api/v1/connect/script?code=one-time-code')",
    );
    expect(command).toContain('case "$combo_connect_script" in *[![:space:]]*');
    expect(command).toContain(
      'printf \'%s\\n\' "$combo_connect_script" | env BASH_ENV=/dev/null ENV=/dev/null COMBO_SOURCE_SCOPE=codex_current_task /bin/sh',
    );
    expect(command).not.toContain('<<');
    expect(command).not.toContain('mktemp');
    expect(command).not.toMatch(/\brm\b/);
    expect(command).not.toContain('trap');
    expect(command).not.toContain('unlink');
    expect(command).not.toContain('combo_connect_tmp');
  });

  it('returns a non-zero status when the connect script download fails', () => {
    const command = renderCurrentCodexTaskConnectCommand(
      'http://127.0.0.1:1/api/v1/connect/script?code=unreachable',
    );
    const result = spawnSync('sh', ['-c', command], {
      encoding: 'utf8',
      timeout: 2_000,
      env: connectCommandEnv(),
    });

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
  });

  it('does not download or execute when CODEX_THREAD_ID is unavailable', async () => {
    const fixture = await serveConnectScript("printf '%s\\n' should-not-run");
    try {
      const command = renderCurrentCodexTaskConnectCommand(fixture.url);
      const result = await runConnectCommand(
        command,
        connectCommandEnv({ CODEX_THREAD_ID: undefined }),
      );

      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain('should-not-run');
      expect(result.stderr).toContain('CODEX_THREAD_ID is required.');
      expect(fixture.requestCount()).toBe(0);
    } finally {
      await closeServer(fixture.server);
    }
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', ' \n\t\n'],
  ])('does not execute an %s successful download', async (_label, body) => {
    const fixture = await serveConnectScript(body);
    try {
      const command = renderCurrentCodexTaskConnectCommand(fixture.url);
      const result = await runConnectCommand(command);

      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        'Combo connect script response was empty or whitespace-only.',
      );
      expect(fixture.requestCount()).toBe(1);
    } finally {
      await closeServer(fixture.server);
    }
  });

  it('executes a complete download through stdin and inherits the Codex task environment', async () => {
    const fixture = await serveConnectScript(`#!/bin/sh
# downloaded-script-private-marker
test "\${COMBO_SOURCE_SCOPE:-}" = codex_current_task || exit 71
test -n "\${CODEX_THREAD_ID:-}" || exit 72
test "\${BASH_ENV:-}" = /dev/null || exit 73
test "\${ENV:-}" = /dev/null || exit 74
test "$#" -eq 0 || exit 75
printf '%s\\n' combo-connect-executed
`);
    try {
      const command = renderCurrentCodexTaskConnectCommand(fixture.url);
      const result = await runConnectCommand(command);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('combo-connect-executed\n');
      expect(result.stdout + result.stderr).not.toContain('downloaded-script-private-marker');
      expect(result.stdout + result.stderr).not.toContain(CODEX_THREAD_ID_FIXTURE);
      expect(fixture.requestCount()).toBe(1);
    } finally {
      await closeServer(fixture.server);
    }
  });

  it('disables inherited xtrace before touching the task identity or connect URL', async () => {
    const fixture = await serveConnectScript("printf '%s\\n' combo-xtrace-safe");
    try {
      const command = renderCurrentCodexTaskConnectCommand(fixture.url);
      const result = await runConnectCommand(command, connectCommandEnv(), true);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('combo-xtrace-safe\n');
      expect(result.stderr).toContain('+ set +x');
      expect(result.stderr).not.toContain(fixture.url);
      expect(result.stderr).not.toContain(CODEX_THREAD_ID_FIXTURE);
    } finally {
      await closeServer(fixture.server);
    }
  });

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

  it('lets a different OAuth principal read a Project Agent share by public link', async () => {
    let stored:
      | {
          id: string;
          owner_user_id: string;
          share_token: string;
          manifest: unknown;
          manifest_sha256: string;
          idempotency_key: string;
          idempotency_sha256: string;
          created_at: string;
        }
      | undefined;
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO project_agent_shares')) {
        stored = {
          id: '00000000-0000-4000-8000-000000000099',
          owner_user_id: String(params[0]),
          share_token: String(params[1]),
          manifest: JSON.parse(String(params[2])) as unknown,
          manifest_sha256: String(params[3]),
          idempotency_key: String(params[4]),
          idempotency_sha256: String(params[5]),
          created_at: String(params[6]),
        };
        return { rows: [stored], rowCount: 1 };
      }
      if (sql.includes('WHERE share_token')) {
        return { rows: stored && stored.share_token === params[0] ? [stored] : [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const creator = context();
    creator.db = { query } as unknown as Queryable;
    const created = await executeExternalMcpTool(creator, 'create_project_agent_share', {
      name: 'Repository reviewer',
      description: 'Review a fixed repository.',
      repositoryUrl: 'https://github.com/openai/codex.git',
      sourceRef: 'refs/heads/main',
      commitSha: 'a'.repeat(40),
      treeSha: 'b'.repeat(40),
      startPrompt: 'Review the architecture.',
      requirements: { commands: ['git'] },
      idempotencyKey: '00000000-0000-4000-8000-000000000090',
    });
    expect(created.isError).toBeUndefined();
    expect(() => ProjectAgentShareResultSchema.parse(created.structuredContent)).not.toThrow();
    const shareUrl = created.structuredContent.shareUrl;
    expect(typeof shareUrl).toBe('string');

    const recipient = context();
    recipient.db = { query } as unknown as Queryable;
    recipient.principal = {
      userId: '00000000-0000-4000-8000-000000000091',
      account: 'creator-bbbbbbbb',
      scopes: ['combo.agent:read'],
    };
    const read = await executeExternalMcpTool(recipient, 'read_project_agent_share', {
      shareUrl,
    });

    expect(read.isError).toBeUndefined();
    expect(() => ProjectAgentShareResultSchema.parse(read.structuredContent)).not.toThrow();
    expect(read.structuredContent.manifest).toEqual(created.structuredContent.manifest);
    const publicSelect = query.mock.calls.find(([sql]) =>
      String(sql).includes('WHERE share_token'),
    );
    const publicPredicate = String(publicSelect?.[0]).slice(
      String(publicSelect?.[0]).indexOf('WHERE'),
    );
    expect(publicPredicate).not.toContain('owner_user_id');
    expect(publicSelect?.[1]).toHaveLength(1);
    expect(read.structuredContent).not.toHaveProperty('ownerUserId');
    expect(read.structuredContent).not.toHaveProperty('shareToken');
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

  it('keeps legacy Studio private while returning authoritative Runtime preview links', async () => {
    mocks.readAgentRevisionDetail.mockResolvedValue({ revision: projectDetail.headRevision });
    const testDetail = {
      test: {
        id: TEST_ID,
        projectId: PROJECT_ID,
        agentRevisionId: REVISION_ID,
        runtimeBundleSha256: SHA,
        uiSha256: SHA,
        sessionId: SESSION_ID,
        turnId: '00000000-0000-4000-8000-000000000009',
        status: 'passed' as const,
        qualityStatus: 'unreviewed' as const,
        canPublish: false,
        errorCode: null,
        createdAt: NOW,
        completedAt: NOW,
      },
      outputText: 'ok',
    };
    const runtime = {
      createStudioSession: vi.fn().mockResolvedValue({ session: { id: SESSION_ID } }),
      saveAgentUiRevision: vi.fn().mockResolvedValue({
        artifact: { id: ARTIFACT_ID, sha256: SHA },
      }),
      startAgentTest: vi.fn().mockResolvedValue(testDetail),
      readAgentTest: vi.fn().mockResolvedValue(testDetail),
    };
    const testContext = context(runtime);

    const saved = await executeExternalMcpTool(testContext, 'save_agent_ui', {
      projectId: PROJECT_ID,
      entryCapabilityId: CAPABILITY_ID,
      html: '<!doctype html><html><body>Agent</body></html>',
      idempotencyKey: 'save-without-studio-url',
    });
    const started = await executeExternalMcpTool(testContext, 'run_agent_test', {
      projectId: PROJECT_ID,
      revisionId: REVISION_ID,
      text: 'Run the Agent',
      idempotencyKey: 'test-without-studio-url',
    });
    const read = await executeExternalMcpTool(testContext, 'read_agent_test', {
      testId: TEST_ID,
    });

    for (const result of [saved, started, read]) {
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).not.toHaveProperty('editorUrl');
    }
    expect(JSON.stringify(saved)).not.toContain('/try/session/');
    for (const result of [started, read]) {
      expect(result.structuredContent).toMatchObject({
        runtimeSessionUrl: `https://test.example/try/session/${SESSION_ID}`,
      });
      expect(result.content).toContainEqual(
        expect.objectContaining({
          type: 'resource_link',
          uri: `https://test.example/try/session/${SESSION_ID}`,
          name: 'combo-agent-test',
        }),
      );
    }
    expect(JSON.stringify([saved, started, read])).not.toContain('mode=studio');
  });

  it('renders only validated presentation data without changing business state', async () => {
    const payload = {
      stage: 'recommendations',
      title: 'Agent 建议',
      summary: '基于已确认范围。',
      progress: [
        { label: '范围已确认', state: 'done' },
        { label: '选择建议', state: 'current' },
      ],
      items: [
        {
          id: 'recommendation-1',
          title: '发布验收 Agent',
          summary: '重复核对发布证据。',
          facts: [{ label: '支撑实例', value: '3' }],
          action: {
            label: '选择这个 Agent',
            message: '我选择发布验收 Agent，请继续创建草稿。',
            emphasis: 'primary',
          },
        },
      ],
      actions: [],
    } as const;

    const rendered = await executeExternalMcpTool(context(), 'render_agent_builder', payload);
    expect(rendered.isError).toBeUndefined();
    expect(rendered.structuredContent).toEqual(payload);
    expect(mocks.readAgentProjectDetail).not.toHaveBeenCalled();

    const rejected = await executeExternalMcpTool(context(), 'render_agent_builder', {
      ...payload,
      actions: [{ label: 'Bad', message: '', emphasis: 'primary' }],
    });
    expect(rejected.isError).toBe(true);
  });

  it.each(['project_share', 'project_restore'] as const)(
    'renders the %s presentation stage without persisting state',
    async (stage) => {
      const rendered = await executeExternalMcpTool(context(), 'render_agent_builder', {
        stage,
        title: stage === 'project_share' ? 'Project Agent 分享' : 'Project Agent 恢复',
        summary: '等待用户确认。',
        progress: [],
        items: [],
        actions: [],
      });
      expect(rendered.isError).toBeUndefined();
      expect(rendered.structuredContent.stage).toBe(stage);
      expect(mocks.readAgentProjectDetail).not.toHaveBeenCalled();
    },
  );

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
          qualityStatus: 'passed',
          canPublish: true,
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
        qualifyingReviewId: REVIEW_ID,
        reviewSha256: SHA,
        runtimeBundleSha256: SHA,
        uiSha256: SHA,
        releaseSha256: SHA,
        notes: '',
        runtimePath: `/try/a/${PROJECT_ID}`,
        createdAt: NOW,
      },
    });
    const releasedProjectDetail = {
      ...projectDetail,
      project: {
        ...projectDetail.project,
        currentReleaseId: '00000000-0000-4000-8000-000000000009',
      },
    };
    mocks.readAgentProjectDetail
      .mockResolvedValueOnce(projectDetail)
      .mockResolvedValueOnce(releasedProjectDetail);

    const published = await executeExternalMcpTool(context(runtime), 'publish_agent_revision', {
      projectId: PROJECT_ID,
      testId: TEST_ID,
      idempotencyKey: 'publish-request-123',
    });
    expect(mocks.publishAgentRevision).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      {
        projectId: PROJECT_ID,
        ownerUserId: OWNER_ID,
        body: {
          expectedHeadRevisionId: REVISION_ID,
          agentRevisionId: REVISION_ID,
          qualifyingTestId: TEST_ID,
          idempotencyKey: 'publish-request-123',
          notes: '',
        },
      },
    );
    expect(published.isError).toBeUndefined();
    expect(published.structuredContent).toMatchObject({
      releasedAgentUrl: `https://test.example/try/a/${PROJECT_ID}`,
    });
    expect(published.content).toContainEqual(
      expect.objectContaining({
        type: 'resource_link',
        uri: `https://test.example/try/a/${PROJECT_ID}`,
      }),
    );

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

  it('records a user-confirmed three-case quality review and rejects an incomplete exception', async () => {
    const cases = [
      {
        caseId: 'normal-1',
        kind: 'normal' as const,
        executionStatus: 'completed' as const,
        qualityVerdict: 'passed' as const,
        reason: 'Normal result is complete.',
      },
      {
        caseId: 'boundary-1',
        kind: 'boundary' as const,
        executionStatus: 'completed' as const,
        qualityVerdict: 'accepted_exception' as const,
        reason: 'Missing rollback data is surfaced.',
        impact: 'Only incomplete rollback inputs require a follow-up.',
      },
      {
        caseId: 'failure-1',
        kind: 'failure' as const,
        executionStatus: 'completed' as const,
        qualityVerdict: 'passed' as const,
        reason: 'A critical unresolved defect returns NO_GO.',
      },
    ];
    mocks.recordAgentTestReview.mockResolvedValue({
      kind: 'created',
      review: {
        id: REVIEW_ID,
        projectId: PROJECT_ID,
        testId: TEST_ID,
        agentRevisionId: REVISION_ID,
        qualityStatus: 'accepted_exception',
        cases,
        summary: 'Accepted the bounded missing-data behavior.',
        reviewSha256: SHA,
        reviewerUserId: OWNER_ID,
        reviewedAt: NOW,
        acceptedAt: NOW,
      },
    });

    const result = await executeExternalMcpTool(context(), 'record_agent_test_review', {
      projectId: PROJECT_ID,
      testId: TEST_ID,
      idempotencyKey: 'quality-review-123',
      cases,
      summary: 'Accepted the bounded missing-data behavior.',
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      review: { id: REVIEW_ID, reviewerUserId: OWNER_ID, acceptedAt: NOW },
      canPublish: true,
    });
    expect(mocks.recordAgentTestReview).toHaveBeenCalledWith(expect.anything(), {
      projectId: PROJECT_ID,
      testId: TEST_ID,
      ownerUserId: OWNER_ID,
      body: {
        idempotencyKey: 'quality-review-123',
        cases,
        summary: 'Accepted the bounded missing-data behavior.',
      },
    });

    const rejected = await executeExternalMcpTool(context(), 'record_agent_test_review', {
      projectId: PROJECT_ID,
      testId: TEST_ID,
      idempotencyKey: 'quality-review-456',
      cases: cases.map((reviewCase) =>
        reviewCase.kind === 'boundary' ? { ...reviewCase, impact: undefined } : reviewCase,
      ),
    });
    expect(rejected.isError).toBe(true);
    expect(mocks.recordAgentTestReview).toHaveBeenCalledTimes(1);
  });
});
