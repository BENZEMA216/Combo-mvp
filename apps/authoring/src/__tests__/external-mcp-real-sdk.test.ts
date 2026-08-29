import Fastify from 'fastify';
import { Ajv } from 'ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { registerExternalMcpRoutes } from '../modules/external-mcp/routes.js';
import { PROJECT_HISTORY_AGENT_DRAFT_APP_URI } from '../modules/project-history-agent/draft-app.js';
import { loadEnv } from '../platform/config/env.js';

const TOKEN = `mat1.${'a'.repeat(43)}`;
const OWNER = '00000000-0000-4000-8000-000000000028';
const CANONICAL_ORIGIN = 'http://127.0.0.1:39099';

describe('external MCP through the real SDK client', () => {
  const close: Array<() => Promise<unknown>> = [];

  afterEach(async () => {
    await Promise.allSettled(close.splice(0).map((dispose) => dispose()));
  });

  it('uses the real SDK for the exact 28/2 catalog and complete five-tool state chain', async () => {
    let draftRow: Record<string, unknown> | undefined;
    let confirmationRow: Record<string, unknown> | undefined;
    let shareRow: Record<string, unknown> | undefined;
    let failShareRead = false;
    let logOutput = '';
    const query = async (sql: string, params: unknown[] = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('cleanup_expired_oauth_artifacts')) {
        return {
          rows: [
            {
              authorization_requests_deleted: 0,
              authorization_codes_deleted: 0,
              access_tokens_deleted: 0,
              refresh_tokens_deleted: 0,
              clients_deleted: 0,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM oauth_access_tokens t')) {
        return {
          rows: [
            {
              owner_user_id: OWNER,
              account: 'creator-sdk-test',
              roles: ['creator'],
              disabled_at: null,
              scope: 'combo.agent:read combo.agent:write',
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('INSERT INTO project_history_agent_drafts')) {
        draftRow = {
          draft_id: params[0],
          revision: params[1],
          owner_user_id: params[2],
          draft_fingerprint: params[3],
          candidate_commitment: params[4],
          draft_json: params[5],
          idempotency_key: params[6],
          request_fingerprint: params[7],
          created_at: params[8],
        };
        return { rows: [draftRow], rowCount: 1 };
      }
      if (
        sql.includes('FROM project_history_agent_drafts') &&
        sql.includes('WHERE owner_user_id = $1 AND draft_id = $2') &&
        !sql.includes('SELECT draft_fingerprint')
      ) {
        return { rows: draftRow ? [draftRow] : [], rowCount: draftRow ? 1 : 0 };
      }
      if (sql.includes('issue_project_history_agent_confirmation')) {
        const createdAt = new Date();
        const expiresAt = new Date(createdAt.getTime() + 5 * 60 * 1_000);
        confirmationRow = {
          owner_user_id: params[0],
          draft_id: params[1],
          revision: params[2],
          draft_fingerprint: params[3],
          confirmation_token_sha256: params[4],
          created_at: createdAt.toISOString(),
          expires_at: expiresAt.toISOString(),
          consumed_at: null,
          consumed_share_token: null,
        };
        return {
          rows: [
            {
              confirmation_token_sha256: params[4],
              created_at: createdAt.toISOString(),
              expires_at: expiresAt.toISOString(),
            },
          ],
          rowCount: 1,
        };
      }
      if (
        sql.includes('FROM project_history_agent_confirmations c') &&
        sql.includes('JOIN project_history_agent_drafts d')
      ) {
        const found =
          draftRow &&
          confirmationRow &&
          confirmationRow.confirmation_token_sha256 === params[0] &&
          confirmationRow.owner_user_id === params[1] &&
          confirmationRow.draft_id === params[2];
        return {
          rows: found ? [{ ...draftRow, ...confirmationRow }] : [],
          rowCount: found ? 1 : 0,
        };
      }
      if (sql.includes('pg_advisory_xact_lock')) {
        return { rows: [], rowCount: 1 };
      }
      if (
        sql.includes('FROM project_history_agent_shares') &&
        sql.includes('owner_user_id = $1 AND idempotency_key = $2')
      ) {
        const found =
          shareRow &&
          shareRow.owner_user_id === params[0] &&
          shareRow.idempotency_key === params[1];
        return { rows: found ? [shareRow] : [], rowCount: found ? 1 : 0 };
      }
      if (sql.includes('FROM project_history_agent_confirmations') && sql.includes('FOR UPDATE')) {
        const found = confirmationRow && confirmationRow.confirmation_token_sha256 === params[0];
        return {
          rows: found ? [{ ...confirmationRow, checked_at: new Date().toISOString() }] : [],
          rowCount: found ? 1 : 0,
        };
      }
      if (
        sql.includes('SELECT draft_fingerprint') &&
        sql.includes('FROM project_history_agent_drafts')
      ) {
        return {
          rows: draftRow ? [{ draft_fingerprint: draftRow.draft_fingerprint }] : [],
          rowCount: draftRow ? 1 : 0,
        };
      }
      if (sql.includes('SELECT share_token') && sql.includes('source_draft_fingerprint = $2')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO project_history_agent_shares')) {
        shareRow = {
          share_token: params[0],
          owner_user_id: params[1],
          draft_id: params[2],
          source_draft_fingerprint: params[4],
          confirmation_token_sha256: params[5],
          package_digest: params[6],
          share_url: params[7],
          share_json: params[8],
          share_json_sha256: params[9],
          copy_prompt: params[10],
          idempotency_key: params[11],
          request_fingerprint: params[12],
        };
        return { rows: [shareRow], rowCount: 1 };
      }
      if (sql.includes('UPDATE project_history_agent_confirmations')) {
        if (confirmationRow) {
          confirmationRow.consumed_at = new Date().toISOString();
          confirmationRow.consumed_share_token = params[1];
        }
        return {
          rows: [{ confirmation_token_sha256: params[0] }],
          rowCount: 1,
        };
      }
      if (
        sql.includes('FROM project_history_agent_shares') &&
        sql.includes('WHERE share_token = $1')
      ) {
        if (failShareRead) {
          const error = new Error('repository unavailable: DECOY_SECRET') as Error & {
            code: string;
            constraint: string;
            detail: string;
          };
          error.code = '23514';
          error.constraint = 'unsafe_constraint_DECOY_SECRET';
          error.detail = `failing row contains DECOY_SECRET and ${String(params[0])}`;
          throw error;
        }
        const found = shareRow && shareRow.share_token === params[0];
        return { rows: found ? [shareRow] : [], rowCount: found ? 1 : 0 };
      }
      throw new Error(`unexpected SDK test SQL category: ${sql.slice(0, 60)}`);
    };
    const db = {
      query,
      async connect() {
        return { query, release() {} };
      },
    };
    const app = Fastify({
      logger: {
        level: 'error',
        stream: { write: (chunk: string) => (logOutput += chunk) },
      },
      disableRequestLogging: true,
    });
    app.decorate('infra', {
      env: {
        ...loadEnv(),
        NODE_ENV: 'test',
        COMBO_ENVIRONMENT: 'test',
        PUBLIC_APP_ORIGINS: 'https://second.example,https://first.example',
        EXTERNAL_MCP_PUBLIC_ORIGIN: CANONICAL_ORIGIN,
      },
      db,
      objectStore: {},
    } as never);
    await registerExternalMcpRoutes(app);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    close.push(() => app.close());

    const client = new Client({ name: 'combo-real-sdk-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('/api/external-mcp/mcp', address), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    await client.connect(transport);
    close.push(() => client.close());
    expect(client.getServerVersion()).toMatchObject({ name: 'combo', version: '0.8.4' });

    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(28);
    expect(listed.tools.slice(0, 23).map(({ name }) => name)).not.toContain(
      'create_agent_package_draft',
    );
    expect(listed.tools.slice(23).map(({ name }) => name)).toEqual([
      'create_agent_package_draft',
      'render_agent_package_draft',
      'create_agent_package_share',
      'read_agent_package_share',
      'prepare_agent_package_run',
    ]);
    const resources = await client.listResources();
    expect(resources.resources.map(({ uri }) => uri)).toEqual([
      'ui://combo/agent-builder/v1.html',
      PROJECT_HISTORY_AGENT_DRAFT_APP_URI,
    ]);
    const draftResource = await client.readResource({ uri: PROJECT_HISTORY_AGENT_DRAFT_APP_URI });
    expect(draftResource.contents).toEqual([
      expect.objectContaining({
        uri: PROJECT_HISTORY_AGENT_DRAFT_APP_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: expect.stringContaining('AGENT PACKAGE DRAFT'),
      }),
    ]);
    const createTool = listed.tools.find(({ name }) => name === 'create_agent_package_draft');
    if (!createTool) throw new Error('create_agent_package_draft is missing');
    const sourceSchema = (
      (createTool.inputSchema.properties as Record<string, unknown>).sourceEvidence as {
        properties: Record<string, unknown>;
      }
    ).properties.limitationReasons as Record<string, unknown>;
    expect(sourceSchema).toMatchObject({
      items: expect.any(Array),
      additionalItems: false,
    });
    expect(sourceSchema).not.toHaveProperty('prefixItems');

    const argumentsObject = {
      creatorRequest: '把这个 Project 里以前完成过的方法做成一个 Agent。',
      candidate: {
        name: '真实 SDK 核验员',
        description: '通过真实 MCP Client 核验 schema 与调用。',
        instructions:
          '可按任务需要讨论 curl、wget、scp、ssh、netcat 或 nc 方法；只读核验可见证据，再报告结论和边界。',
        starterPrompts: ['检查当前发布。'],
        outputDescription: '返回结论、证据和边界。',
      },
      sourceEvidence: {
        kind: 'host_project_scoped_reduced_history',
        selection: 'user_selected_saved_project',
        assurance: 'best_effort',
        completeness: 'not_proven',
        hostAttestation: 'not_proven',
        sourceProjectionEnforced: 'not_proven',
        rawStored: false,
        projectCount: 1,
        discoveredThreadCount: 20,
        readThreadCount: 20,
        omittedThreadCount: 73,
        completedTurnCount: 20,
        userVisibleMessageCount: 40,
        omittedItemCount: 3,
        limitationReasons: [
          'READ_OUTPUT_BOUNDED_OR_TRUNCATED',
          'READ_THREAD_SUMMARY_NOT_RAW_TRANSCRIPT',
          'THREAD_LIST_GLOBAL_COVERAGE_NOT_ATTESTED',
        ],
      },
      idempotencyKey: '10000000-0000-4000-8000-000000000028',
    };
    const ajv = new Ajv({ strict: true, allErrors: true });
    ajv.addFormat('uuid', {
      type: 'string',
      validate: (value: string) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value),
    });
    ajv.addFormat('uri', { type: 'string', validate: (value: string) => URL.canParse(value) });
    ajv.addFormat('date-time', {
      type: 'string',
      validate: (value: string) => !Number.isNaN(Date.parse(value)),
    });
    const validateCreateDraft = ajv.compile(createTool.inputSchema);
    expect(validateCreateDraft(argumentsObject), ajv.errorsText(validateCreateDraft.errors)).toBe(
      true,
    );
    for (const field of [
      'discoveredThreadCount',
      'readThreadCount',
      'completedTurnCount',
      'userVisibleMessageCount',
    ] as const) {
      const invalid = structuredClone(argumentsObject);
      invalid.sourceEvidence[field] = 0;
      expect(validateCreateDraft(invalid), `${field}=0 must fail draft-07 validation`).toBe(false);
    }

    const called = await client.callTool({
      name: 'create_agent_package_draft',
      arguments: argumentsObject,
    });
    expect(called.isError).not.toBe(true);
    expect(called.structuredContent).toMatchObject({
      schemaVersion: 'combo.agent-package-draft-result/1',
      created: true,
      draft: {
        source: {
          rawStored: false,
          limitationReasons: argumentsObject.sourceEvidence.limitationReasons,
        },
      },
    });
    assertSdkToolOutput(ajv, listed.tools, 'create_agent_package_draft', called.structuredContent);
    const createdContent = called.structuredContent as Record<string, unknown>;
    const draft = createdContent.draft as {
      draftId: string;
      draftFingerprint: string;
    };

    const rendered = await client.callTool({
      name: 'render_agent_package_draft',
      arguments: { draftId: draft.draftId, draftFingerprint: draft.draftFingerprint },
    });
    expect(rendered.isError).not.toBe(true);
    assertSdkToolOutput(
      ajv,
      listed.tools,
      'render_agent_package_draft',
      rendered.structuredContent,
    );
    const renderedContent = rendered.structuredContent as Record<string, unknown>;
    const confirmation = renderedContent.confirmation as {
      confirmationToken: string;
    };
    expect(JSON.stringify(rendered.content)).not.toContain(confirmation.confirmationToken);
    expect(JSON.stringify(renderedContent.cardSnapshot)).not.toContain('cfrm_');

    const shared = await client.callTool({
      name: 'create_agent_package_share',
      arguments: {
        draftId: draft.draftId,
        draftFingerprint: draft.draftFingerprint,
        confirmationToken: confirmation.confirmationToken,
        idempotencyKey: '20000000-0000-4000-8000-000000000028',
      },
    });
    expect(shared.isError).not.toBe(true);
    assertSdkToolOutput(ajv, listed.tools, 'create_agent_package_share', shared.structuredContent);
    const sharedContent = shared.structuredContent as Record<string, unknown>;
    const shareUrl = sharedContent.shareUrl as string;
    const packageDigest = sharedContent.packageDigest as string;

    const read = await client.callTool({
      name: 'read_agent_package_share',
      arguments: { shareUrl },
    });
    expect(read.isError).not.toBe(true);
    assertSdkToolOutput(ajv, listed.tools, 'read_agent_package_share', read.structuredContent);
    expect(read.structuredContent).toMatchObject({ shareUrl, packageDigest });
    expect((read.structuredContent as Record<string, unknown>).package).toEqual(
      sharedContent.package,
    );

    const prepared = await client.callTool({
      name: 'prepare_agent_package_run',
      arguments: {
        shareUrl,
        packageDigest,
        starterOrdinal: 1,
        starterPrompt: '检查当前发布。',
      },
    });
    expect(prepared.isError).not.toBe(true);
    assertSdkToolOutput(ajv, listed.tools, 'prepare_agent_package_run', prepared.structuredContent);
    expect(prepared.structuredContent).toMatchObject({
      shareUrl,
      packageDigest,
      starterOrdinal: 1,
      starterPrompt: '检查当前发布。',
      sourceDraftFingerprint: draft.draftFingerprint,
    });

    const wrongDigest = await client.callTool({
      name: 'prepare_agent_package_run',
      arguments: {
        shareUrl,
        packageDigest: `sha256:${'0'.repeat(64)}`,
        starterOrdinal: 1,
        starterPrompt: '检查当前发布。',
      },
    });
    expect(wrongDigest).toMatchObject({
      isError: true,
      structuredContent: { error: { category: 'digest_mismatch' } },
    });

    failShareRead = true;
    const repositoryFailure = await client.callTool({
      name: 'read_agent_package_share',
      arguments: { shareUrl },
    });
    expect(repositoryFailure).toMatchObject({
      isError: true,
      structuredContent: { error: { category: 'internal', retryable: true } },
    });
    assertSdkToolOutput(
      ajv,
      listed.tools,
      'read_agent_package_share',
      repositoryFailure.structuredContent,
    );
    expect(JSON.stringify(repositoryFailure)).not.toContain('DECOY_SECRET');
    expect(JSON.stringify(repositoryFailure)).not.toContain(
      new URL(shareUrl).pathname.split('/').at(-1),
    );
    expect(logOutput).toContain('project_history_agent_mcp_request_failed');
    expect(logOutput).toContain('23514');
    expect(logOutput).not.toContain('DECOY_SECRET');
    expect(logOutput).not.toContain(shareUrl);
    expect(logOutput).not.toContain(new URL(shareUrl).pathname.split('/').at(-1));
  });
});

function assertSdkToolOutput(
  ajv: Ajv,
  tools: Awaited<ReturnType<Client['listTools']>>['tools'],
  name: string,
  value: unknown,
): void {
  const schema = tools.find((tool) => tool.name === name)?.outputSchema;
  if (!schema) throw new Error(`${name} output schema is missing`);
  const validate = ajv.compile(schema);
  expect(validate(value), `${name}: ${ajv.errorsText(validate.errors)}`).toBe(true);
}
