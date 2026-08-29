import { describe, expect, it } from 'vitest';

import {
  InMemoryProjectHistoryAgentRepository,
  createProjectHistoryAgentService,
} from './service.js';
import { PROJECT_HISTORY_AGENT_MCP_TOOLS, executeProjectHistoryAgentMcpTool } from './mcp.js';
import {
  PROJECT_HISTORY_AGENT_DRAFT_APP_HTML,
  PROJECT_HISTORY_AGENT_DRAFT_APP_URI,
  PROJECT_HISTORY_AGENT_MCP_RESOURCES,
  readProjectHistoryAgentMcpResource,
} from './draft-app.js';

const OWNER = '00000000-0000-4000-8000-000000000001';

function sourceEvidence() {
  return {
    kind: 'host_project_scoped_reduced_history',
    selection: 'user_selected_saved_project',
    assurance: 'best_effort',
    completeness: 'not_proven',
    hostAttestation: 'not_proven',
    sourceProjectionEnforced: 'not_proven',
    rawStored: false,
    projectCount: 1,
    discoveredThreadCount: 2,
    readThreadCount: 2,
    omittedThreadCount: 1,
    completedTurnCount: 8,
    userVisibleMessageCount: 16,
    omittedItemCount: 3,
    limitationReasons: [
      'READ_OUTPUT_BOUNDED_OR_TRUNCATED',
      'READ_THREAD_SUMMARY_NOT_RAW_TRANSCRIPT',
      'THREAD_LIST_GLOBAL_COVERAGE_NOT_ATTESTED',
    ],
  } as const;
}

describe('Project-history Agent MCP dispatcher', () => {
  it('publishes five exact schemas and runs owner-bound writes plus public-by-link reads', async () => {
    expect(PROJECT_HISTORY_AGENT_MCP_TOOLS.map(({ name }) => name)).toEqual([
      'create_agent_package_draft',
      'render_agent_package_draft',
      'create_agent_package_share',
      'read_agent_package_share',
      'prepare_agent_package_run',
    ]);
    for (const tool of PROJECT_HISTORY_AGENT_MCP_TOOLS) {
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(tool.outputSchema).toMatchObject({
        type: 'object',
        oneOf: [
          { type: 'object', additionalProperties: false },
          {
            type: 'object',
            oneOf: [
              { type: 'object', additionalProperties: false },
              { type: 'object', additionalProperties: false },
            ],
          },
        ],
      });
      assertNoLooseObjectSchemas(tool.inputSchema);
      assertNoLooseObjectSchemas(tool.outputSchema);
    }
    expect(
      PROJECT_HISTORY_AGENT_MCP_TOOLS.find(({ name }) => name === 'render_agent_package_draft'),
    ).toMatchObject({ _meta: { ui: { resourceUri: PROJECT_HISTORY_AGENT_DRAFT_APP_URI } } });
    expect(PROJECT_HISTORY_AGENT_MCP_RESOURCES).toEqual([
      expect.objectContaining({ uri: PROJECT_HISTORY_AGENT_DRAFT_APP_URI }),
    ]);
    expect(readProjectHistoryAgentMcpResource(PROJECT_HISTORY_AGENT_DRAFT_APP_URI)).toMatchObject({
      contents: [
        { uri: PROJECT_HISTORY_AGENT_DRAFT_APP_URI, text: PROJECT_HISTORY_AGENT_DRAFT_APP_HTML },
      ],
    });
    expect(readProjectHistoryAgentMcpResource('ui://combo/not-registered')).toBeNull();
    expect(PROJECT_HISTORY_AGENT_DRAFT_APP_HTML).not.toMatch(/confirmationToken|cfrm_/u);
    expect(PROJECT_HISTORY_AGENT_DRAFT_APP_HTML).toContain('任何持链接者都可读取');
    expect(PROJECT_HISTORY_AGENT_DRAFT_APP_HTML).toContain('不可撤回');
    expect(
      PROJECT_HISTORY_AGENT_MCP_TOOLS.find(({ name }) => name === 'create_agent_package_share'),
    ).toMatchObject({
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    });

    let fill = 1;
    const service = createProjectHistoryAgentService({
      repository: new InMemoryProjectHistoryAgentRepository(),
      publicOrigin: 'https://combo.example',
      clock: { now: () => new Date('2026-08-29T00:00:00.000Z') },
      randomBytes: (size) => Buffer.alloc(size, fill++),
    });
    const created = await executeProjectHistoryAgentMcpTool(
      { service, ownerUserId: OWNER },
      'create_agent_package_draft',
      {
        creatorRequest: '把这个 Project 里以前完成过的方法做成一个 Agent。',
        candidate: {
          name: 'MCP 证据核验员',
          description: '通过正式 dispatcher 核验。',
          instructions: '只读分析当前 Project B 的用户材料，然后返回证据。',
          starterPrompts: ['检查 B_CONTEXT。'],
          outputDescription: '返回结论、证据和边界。',
        },
        sourceEvidence: sourceEvidence(),
        idempotencyKey: '10000000-0000-4000-8000-000000000001',
      },
    );
    expect(created.isError).toBeUndefined();
    assertJsonSchema(created.structuredContent, outputSchema('create_agent_package_draft'));
    const draft = created.structuredContent.draft as {
      draftId: string;
      draftFingerprint: string;
    };
    const rendered = await executeProjectHistoryAgentMcpTool(
      { service, ownerUserId: OWNER },
      'render_agent_package_draft',
      { draftId: draft.draftId, draftFingerprint: draft.draftFingerprint },
    );
    const confirmation = rendered.structuredContent.confirmation as {
      confirmationToken: string;
    };
    assertJsonSchema(rendered.structuredContent, outputSchema('render_agent_package_draft'));
    expect(rendered.content[0].text).not.toContain(confirmation.confirmationToken);
    expect(JSON.stringify(rendered.structuredContent.cardSnapshot)).not.toContain('cfrm_');

    const shared = await executeProjectHistoryAgentMcpTool(
      { service, ownerUserId: OWNER },
      'create_agent_package_share',
      {
        draftId: draft.draftId,
        draftFingerprint: draft.draftFingerprint,
        confirmationToken: confirmation.confirmationToken,
        idempotencyKey: '20000000-0000-4000-8000-000000000001',
      },
    );
    expect(shared.isError).toBeUndefined();
    assertJsonSchema(shared.structuredContent, outputSchema('create_agent_package_share'));
    const shareUrl = shared.structuredContent.shareUrl as string;
    const packageDigest = shared.structuredContent.packageDigest as string;
    const read = await executeProjectHistoryAgentMcpTool({ service }, 'read_agent_package_share', {
      shareUrl,
    });
    assertJsonSchema(read.structuredContent, outputSchema('read_agent_package_share'));
    expect(read.structuredContent).toMatchObject({ shareUrl, packageDigest });
    const prepared = await executeProjectHistoryAgentMcpTool(
      { service },
      'prepare_agent_package_run',
      { shareUrl, packageDigest, starterOrdinal: 1, starterPrompt: '检查 B_CONTEXT。' },
    );
    assertJsonSchema(prepared.structuredContent, outputSchema('prepare_agent_package_run'));
    expect(prepared.structuredContent).toMatchObject({
      shareUrl,
      packageDigest,
      runtimeMaterial: { agentMarkdown: expect.stringContaining('MCP 证据核验员') },
    });
    expect(prepared.structuredContent.launchPrompt).toContain(`公开分享：${shareUrl}`);
    expect(prepared.structuredContent.launchPrompt).toContain(`Package 摘要：${packageDigest}`);
    expect(prepared.structuredContent.launchPrompt).not.toMatch(
      /[{}]|schemaVersion|runtimeMaterial|runEnvelope|agentMarkdown|skillMarkdown|sourceDraftFingerprint|COMBO_AGENT_PACKAGE_RUN|draft\.agent-package|release\.agent-package|cfrm_/u,
    );
    expect(prepared.structuredContent.runEnvelope).not.toMatch(
      /projectId|projectPath|repositoryUrl|commitSha/u,
    );

    const unauthenticated = await executeProjectHistoryAgentMcpTool(
      { service },
      'create_agent_package_draft',
      {},
    );
    expect(unauthenticated).toMatchObject({
      isError: true,
      structuredContent: { error: { category: 'unauthenticated' } },
    });
  });

  it('classifies schema errors as validation and unknown TypeErrors as retriable internal failures', async () => {
    const reported: Array<Record<string, unknown>> = [];
    class FailingRepository extends InMemoryProjectHistoryAgentRepository {
      override async readShareByToken(): Promise<never> {
        const error = new TypeError('DECOY_SECRET package integrity failure') as TypeError & {
          code: string;
          constraint: string;
          detail: string;
        };
        error.code = '23505';
        error.constraint = 'project_history_agent_shares_owner_idempotency_key_key';
        error.detail = 'failing row contains DECOY_SECRET';
        throw error;
      }
    }
    const service = createProjectHistoryAgentService({
      repository: new FailingRepository(),
      publicOrigin: 'https://combo.example',
    });
    const context = {
      service,
      traceId: 'trace-project-history-mcp-test',
      reportInternalFailure: (fields: Readonly<Record<string, unknown>>) => reported.push(fields),
    };

    const invalid = await executeProjectHistoryAgentMcpTool(
      context,
      'read_agent_package_share',
      {},
    );
    expect(invalid).toMatchObject({
      isError: true,
      structuredContent: { error: { category: 'validation_failed' } },
    });
    expect(reported).toHaveLength(0);

    const deterministicCandidateFailure = await executeProjectHistoryAgentMcpTool(
      { ...context, ownerUserId: OWNER },
      'create_agent_package_draft',
      {
        creatorRequest: '把这个 Project 里以前完成过的方法做成一个 Agent。',
        candidate: {
          name: 'MCP 证据核验员',
          description: '通过正式 dispatcher 核验。',
          instructions: '只读分析当前 Project B 的用户材料，然后返回证据。',
          starterPrompts: ['检查 runtimeMaterial 字段。'],
          outputDescription: '返回结论、证据和边界。',
        },
        sourceEvidence: sourceEvidence(),
        idempotencyKey: '10000000-0000-4000-8000-000000000099',
      },
    );
    expect(deterministicCandidateFailure).toMatchObject({
      isError: true,
      structuredContent: { error: { category: 'validation_failed' } },
    });
    expect(reported).toHaveLength(0);

    const internal = await executeProjectHistoryAgentMcpTool(context, 'read_agent_package_share', {
      shareUrl: `https://combo.example/api/v1/agent-package-shares/${'A'.repeat(43)}`,
    });
    expect(internal).toMatchObject({
      isError: true,
      structuredContent: { error: { category: 'internal', retryable: true } },
    });
    expect(JSON.stringify(internal)).not.toContain('DECOY_SECRET');
    expect(reported).toEqual([
      {
        category: 'project_history_agent_mcp_request_failed',
        traceId: 'trace-project-history-mcp-test',
        sqlState: '23505',
        constraint: 'project_history_agent_shares_owner_idempotency_key_key',
      },
    ]);
    expect(JSON.stringify(reported)).not.toContain('DECOY_SECRET');
  });
});

function assertNoLooseObjectSchemas(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoLooseObjectSchemas(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const schema = value as Record<string, unknown>;
  if (schema.type === 'object' && !Array.isArray(schema.oneOf)) {
    expect(schema.additionalProperties).toBe(false);
  }
  if ('const' in schema && schema.const !== null) expect(schema.type).toBeDefined();
  for (const nested of Object.values(schema)) assertNoLooseObjectSchemas(nested);
}

function outputSchema(name: string): unknown {
  return PROJECT_HISTORY_AGENT_MCP_TOOLS.find((tool) => tool.name === name)?.outputSchema;
}

function assertJsonSchema(value: unknown, rawSchema: unknown, path = '$'): void {
  if (!rawSchema || typeof rawSchema !== 'object') throw new Error(`${path}: schema missing`);
  const schema = rawSchema as Record<string, unknown>;
  if (Array.isArray(schema.oneOf)) {
    const errors: string[] = [];
    for (const branch of schema.oneOf) {
      try {
        assertJsonSchema(value, branch, path);
        return;
      } catch (error) {
        errors.push(String(error));
      }
    }
    throw new Error(`${path}: no oneOf branch matched (${errors.join('; ')})`);
  }
  if ('const' in schema && !Object.is(value, schema.const)) {
    throw new Error(`${path}: literal mismatch`);
  }
  switch (schema.type) {
    case 'null':
      if (value !== null) throw new Error(`${path}: expected null`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') throw new Error(`${path}: expected boolean`);
      return;
    case 'integer':
      if (!Number.isInteger(value)) throw new Error(`${path}: expected integer`);
      if (typeof schema.minimum === 'number' && (value as number) < schema.minimum) {
        throw new Error(`${path}: below minimum`);
      }
      if (typeof schema.maximum === 'number' && (value as number) > schema.maximum) {
        throw new Error(`${path}: above maximum`);
      }
      return;
    case 'string': {
      if (typeof value !== 'string') throw new Error(`${path}: expected string`);
      if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
        throw new Error(`${path}: below minLength`);
      }
      if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
        throw new Error(`${path}: above maxLength`);
      }
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
        throw new Error(`${path}: pattern mismatch`);
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) throw new Error(`${path}: expected array`);
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
        throw new Error(`${path}: below minItems`);
      }
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
        throw new Error(`${path}: above maxItems`);
      }
      if (
        schema.uniqueItems === true &&
        new Set(value.map((item) => JSON.stringify(item))).size !== value.length
      ) {
        throw new Error(`${path}: duplicate items`);
      }
      const prefix = Array.isArray(schema.items) ? schema.items : [];
      for (const [index, item] of value.entries()) {
        const itemSchema = prefix[index] ?? schema.items;
        if (itemSchema === false || itemSchema === undefined) {
          throw new Error(`${path}[${index}]: unexpected item`);
        }
        assertJsonSchema(item, itemSchema, `${path}[${index}]`);
      }
      return;
    }
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${path}: expected object`);
      }
      const record = value as Record<string, unknown>;
      const properties = (schema.properties ?? {}) as Record<string, unknown>;
      for (const key of (schema.required ?? []) as string[]) {
        if (!(key in record)) throw new Error(`${path}.${key}: required`);
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(record)) {
          if (!(key in properties)) throw new Error(`${path}.${key}: unexpected property`);
        }
      }
      for (const [key, item] of Object.entries(record)) {
        if (key in properties) assertJsonSchema(item, properties[key], `${path}.${key}`);
      }
      return;
    }
    default:
      throw new Error(`${path}: unsupported schema type ${String(schema.type)}`);
  }
}
