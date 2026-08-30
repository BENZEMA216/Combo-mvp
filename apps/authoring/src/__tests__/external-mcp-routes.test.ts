import Fastify, { type FastifyInstance } from 'fastify';
import { Ajv } from 'ajv';
import cookie from '@fastify/cookie';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AgentDefinitionSchema,
  CodexAgentShareManifestSchema,
  CodexAgentShareResultSchema,
  MCP_OAUTH_SCOPES,
  OAuthAuthorizationServerMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  PrepareCodexAgentRunResultSchema,
  canonicalJson,
  renderCodexAgentRunEnvelope,
} from '@cb/shared';
import { buildApp } from '../bootstrap/app.js';
import { loadEnv } from '../platform/config/env.js';
import {
  PROJECT_HISTORY_BUSINESS_HANDOFF,
  PROJECT_HISTORY_INSTALL_PROMPT,
  PROJECT_HISTORY_RECOVERY_PROMPT_TEMPLATE,
  PROJECT_HISTORY_RECOVERY_SUMMARIES,
  renderProjectHistoryRecoveryPrompt,
} from '../modules/external-mcp/handlers.js';
import { registerExternalMcpRoutes } from '../modules/external-mcp/routes.js';

const ORIGIN = 'https://test.43-160-242-46.sslip.io';
const RESOURCE = `${ORIGIN}/api/external-mcp/mcp`;
const TOKEN = `mat1.${'a'.repeat(43)}`;
const CAPABILITY_ID = '00000000-0000-4000-8000-000000000004';
const TASK_ID = '00000000-0000-4000-8000-000000000010';
const NOW = '2026-08-06T00:00:00.000Z';
const EXPECTED_PROJECT_HISTORY_INSTALL_PROMPT =
  '阅读 https://test.43-160-242-46.sslip.io/codex-plugin ，帮我安装 Combo 插件并创建一个新任务。';
const EXPECTED_PROJECT_HISTORY_BUSINESS_HANDOFF =
  'Combo 插件已经安装好了，请用 Combo 把我以前保存的 Project 里完成过的方法做成一个 Agent：先列出安全的 Project 名称让我选择来源，完整展示将分享的内容，等我确认后创建并核对分享；然后让我选择另一个 Project，并在为它创建的同一个新任务里连续验证两轮。';
const EXPECTED_PROJECT_HISTORY_RECOVERY_PROMPT_TEMPLATE =
  'Combo 安装续接：上一步未完成的低敏摘要是“<summary>”。请只继续核对官方 Combo 0.8.6 安装、Test MCP 与当前任务的 Project-history 能力；不得把本续接任务当作 Project-history 业务已就绪，也不得再创建安装续接任务。修复并验证成功后，创建一个新的 Codex 顶层任务，并把下面这整段话作为唯一第一条消息原样发送：<exact-business-paragraph>';
const EXPECTED_PROJECT_HISTORY_RECOVERY_SUMMARIES = [
  '当前任务在 Combo 0.8.6 安装或升级前启动，尚未加载最新 Skill 和工具目录。',
  'Combo 0.8.6 官方安装元数据尚未完成核对。',
  'Combo Test MCP 元数据尚未通过核对。',
  'Combo OAuth 尚未完成。',
] as const;
const FORBIDDEN_PROJECT_HISTORY_RELEASE_CLAIMS = [
  '当前只在 Test 输出 Combo Plugin 0.8.6',
  '`/codex-plugin` 当前只在 Test 环境提供',
  '请使用已验收的 Test 安装页',
  'Combo Plugin 0.8.6 已部署',
  'Combo Plugin 0.8.6 已验收',
] as const;

function testEnv() {
  const sourceSha = 'a'.repeat(40);
  return {
    ...loadEnv(),
    NODE_ENV: 'test' as const,
    COMBO_ENVIRONMENT: 'test',
    COMBO_SOURCE_SHA: sourceSha,
    COMBO_RELEASE_ID: `release-${sourceSha}`,
    COMBO_BUILT_AT: '2026-08-06T00:00:00.000Z',
    COMBO_RELEASE_MANIFEST_DIGEST: `sha256:${'b'.repeat(64)}`,
    COMBO_WEB_ASSET_MANIFEST: `sha256:${'c'.repeat(64)}`,
    LOG_LEVEL: 'fatal' as const,
    PUBLIC_APP_ORIGINS: ORIGIN,
    EXTERNAL_MCP_PUBLIC_ORIGIN: ORIGIN,
    MCP_RUNTIME_INTERNAL_BASE_URL: 'http://localhost:3100',
    SESSION_COOKIE_SECURE: false,
    OTP_HMAC_SECRET: 'h'.repeat(32),
    RESEND_API_KEY: 'test-only-key',
    RESEND_FROM_EMAIL: 'login@example.test',
    RESEND_API_BASE_URL: 'http://127.0.0.1:9',
  };
}

describe('Project-history fixed bootstrap request', () => {
  it('exports the exact short installation request without implementation wires', () => {
    expect(PROJECT_HISTORY_INSTALL_PROMPT).toBe(EXPECTED_PROJECT_HISTORY_INSTALL_PROMPT);
    expect(PROJECT_HISTORY_INSTALL_PROMPT).not.toMatch(/[\r\n]/u);
    expect(PROJECT_HISTORY_INSTALL_PROMPT).not.toMatch(
      /create_agent_package|render_agent_package|schema|mcp login|plugin add|marketplace upgrade/iu,
    );
    expect(Buffer.byteLength(PROJECT_HISTORY_INSTALL_PROMPT, 'utf8')).toBe(111);
    expect(createHash('sha256').update(PROJECT_HISTORY_INSTALL_PROMPT, 'utf8').digest('hex')).toBe(
      'd93995bb094a7d58bd14b34dcc33869627a254694ad51444554441fbfe32525f',
    );

    const guideUrl = 'https://test.43-160-242-46.sslip.io/codex-plugin';
    const markdownMirror = PROJECT_HISTORY_INSTALL_PROMPT.replace(
      guideUrl,
      `[${guideUrl}](${guideUrl})`,
    );
    for (const [rendered, expectedOccurrences] of [
      [PROJECT_HISTORY_INSTALL_PROMPT, 1],
      [markdownMirror, 2],
    ] as const) {
      const urls = [...rendered.matchAll(/https:\/\/[a-z0-9.-]+(?:\/[a-z0-9._~-]+)*/giu)].map(
        (match) => match[0],
      );
      expect(urls).toHaveLength(expectedOccurrences);
      expect(new Set(urls)).toEqual(new Set([guideUrl]));
    }
  });

  it('exports the exact single-paragraph business handoff for the fresh task', () => {
    expect(PROJECT_HISTORY_BUSINESS_HANDOFF).toBe(EXPECTED_PROJECT_HISTORY_BUSINESS_HANDOFF);
    expect(PROJECT_HISTORY_BUSINESS_HANDOFF).not.toMatch(/[\r\n]/u);
    expect(PROJECT_HISTORY_BUSINESS_HANDOFF).not.toMatch(
      /create_agent_package|render_agent_package|schema|mcp login|plugin add|marketplace upgrade/iu,
    );
    expect(Buffer.byteLength(PROJECT_HISTORY_BUSINESS_HANDOFF, 'utf8')).toBe(345);
    expect(
      createHash('sha256').update(PROJECT_HISTORY_BUSINESS_HANDOFF, 'utf8').digest('hex'),
    ).toBe('86035706c60165e4e32f01a8b28cd44960f4a607197cb44dc3dae91ebeb8564b');
  });

  it('freezes the recovery template and accepts only the ordered low-sensitivity summaries', () => {
    expect(PROJECT_HISTORY_RECOVERY_PROMPT_TEMPLATE).toBe(
      EXPECTED_PROJECT_HISTORY_RECOVERY_PROMPT_TEMPLATE,
    );
    expect(PROJECT_HISTORY_RECOVERY_SUMMARIES).toEqual(EXPECTED_PROJECT_HISTORY_RECOVERY_SUMMARIES);
    expect(Object.isFrozen(PROJECT_HISTORY_RECOVERY_SUMMARIES)).toBe(true);

    for (const summary of EXPECTED_PROJECT_HISTORY_RECOVERY_SUMMARIES) {
      const prompt = renderProjectHistoryRecoveryPrompt(summary);
      expect(prompt).toBe(
        EXPECTED_PROJECT_HISTORY_RECOVERY_PROMPT_TEMPLATE.replace('<summary>', summary).replace(
          '<exact-business-paragraph>',
          EXPECTED_PROJECT_HISTORY_BUSINESS_HANDOFF,
        ),
      );
      expect(prompt).not.toMatch(/<summary>|<exact-business-paragraph>/u);
    }

    for (const rejected of [
      'raw error: unauthorized',
      '/Users/example/project',
      'threadId=abc',
      'https://untrusted.example',
      'token=secret',
    ]) {
      expect(() => renderProjectHistoryRecoveryPrompt(rejected)).toThrow(
        'Project-history recovery summary is not allowed',
      );
    }
  });

  it('documents the 0.8.6 guide without freezing a stale deployment or UAT state', () => {
    const documents = [
      readFileSync(new URL('../../../../README.md', import.meta.url), 'utf8'),
      readFileSync(new URL('../modules/external-mcp/README.md', import.meta.url), 'utf8'),
    ];

    for (const document of documents) {
      expect(document).toContain('`/version.json`');
      expect(document).toContain('`sourceSha`');
      expect(document).toContain('`releaseId`');
      expect(document).toContain('`UAT_STATUS=EXTERNAL_EVIDENCE_REQUIRED`');
      expect(document).not.toContain('`NOT_DEPLOYED`');
      expect(document).not.toContain('`NOT_UAT`');
      expect(document).not.toContain('不是当前 Test 运行输出的证据');
      for (const claim of FORBIDDEN_PROJECT_HISTORY_RELEASE_CLAIMS) {
        expect(document).not.toContain(claim);
      }
    }
  });
});

describe('external MCP root route integration', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ env: testEnv(), httpRateLimitStore: 'memory' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers both protected-resource paths and AS metadata on the root app', async () => {
    const [root, resource, authorizationServer] = await Promise.all([
      app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' }),
      app.inject({
        method: 'GET',
        url: '/.well-known/oauth-protected-resource/api/external-mcp/mcp',
      }),
      app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' }),
    ]);

    expect(root.statusCode).toBe(200);
    expect(resource.statusCode).toBe(200);
    expect(root.headers['content-type']).toMatch(/^application\/json/);
    expect(root.json()).toEqual(resource.json());
    expect(OAuthProtectedResourceMetadataSchema.parse(root.json())).toEqual({
      resource: RESOURCE,
      authorization_servers: [ORIGIN],
      scopes_supported: MCP_OAUTH_SCOPES,
      bearer_methods_supported: ['header'],
    });
    expect(OAuthAuthorizationServerMetadataSchema.parse(authorizationServer.json())).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/api/external-mcp/oauth/authorize`,
      token_endpoint: `${ORIGIN}/api/external-mcp/oauth/token`,
      registration_endpoint: `${ORIGIN}/api/external-mcp/oauth/register`,
      code_challenge_methods_supported: ['S256'],
    });
  });

  it('returns the exact OAuth challenge instead of a 404 or SPA document', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/external-mcp/mcp',
      headers: { accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.headers['access-control-expose-headers']).toBe('WWW-Authenticate');
    expect(response.headers['www-authenticate']).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/external-mcp/mcp", scope="combo.agent:read combo.agent:write"`,
    );
  });

  it('accepts Codex repeated identical resource values but rejects conflicting resources', async () => {
    const clientId = `mcp_client_${'a'.repeat(43)}`;
    const redirectUri = 'http://127.0.0.1:49152/callback/codex-id';
    const query = vi.fn(async (sql: string) => {
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
      if (sql.includes('UPDATE oauth_clients')) {
        return {
          rows: [
            {
              client_id: clientId,
              client_name: 'Codex',
              redirect_uris: [redirectUri],
              grant_types: ['authorization_code', 'refresh_token'],
              response_types: ['code'],
              token_endpoint_auth_method: 'none',
              created_at: new Date('2026-08-06T00:00:00.000Z'),
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('INSERT INTO oauth_authorization_requests')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error('unexpected SQL');
    });
    const isolated = Fastify({ logger: false });
    isolated.decorate('infra', {
      env: testEnv(),
      db: { query },
      objectStore: {},
    } as never);
    await registerExternalMcpRoutes(isolated);
    const parameters = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'combo.agent:read combo.agent:write',
      state: 'codex-state',
      code_challenge: 'c'.repeat(43),
      code_challenge_method: 'S256',
      resource: RESOURCE,
    });
    try {
      parameters.append('resource', RESOURCE);
      const repeated = await isolated.inject({
        method: 'GET',
        url: `/api/external-mcp/oauth/authorize?${parameters.toString()}`,
      });
      expect(repeated.statusCode).toBe(303);
      expect(repeated.headers.location).toMatch(/^\/api\/external-mcp\/oauth\/authorize\?request=/);

      parameters.set('resource', RESOURCE);
      parameters.append('resource', `${RESOURCE}/conflict`);
      const conflicting = await isolated.inject({
        method: 'GET',
        url: `/api/external-mcp/oauth/authorize?${parameters.toString()}`,
      });
      expect(conflicting.statusCode).toBe(400);
      expect(conflicting.body).toContain('授权请求无效');
      expect(
        query.mock.calls.filter(([sql]) =>
          String(sql).includes('INSERT INTO oauth_authorization_requests'),
        ),
      ).toHaveLength(1);
    } finally {
      await isolated.close();
    }
  });

  it('serves an environment-pinned Desktop upgrade guide without duplicate mcp add', async () => {
    const response = await app.inject({ method: 'GET', url: '/codex-plugin' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.body).toContain('/Applications/ChatGPT.app/Contents/Resources/codex');
    expect(response.body).toContain('Combo Plugin 0.8.6 Test');
    expect(response.body).toContain('Project-history Agent');
    expect(response.body).toContain('<code>TEST_RUNTIME</code>');
    expect(response.body).toContain('<code>environment=test</code>');
    expect(response.body).toContain(`<code>sourceSha=${'a'.repeat(40)}</code>`);
    expect(response.body).toContain(`<code>releaseId=release-${'a'.repeat(40)}</code>`);
    expect(response.body).toContain('<code>UAT_STATUS=EXTERNAL_EVIDENCE_REQUIRED</code>');
    expect(response.body).toContain('<a href="/version.json">/version.json</a>');
    expect(response.body).toContain('与本页运行身份逐字一致');
    expect(response.body).not.toContain('NOT_DEPLOYED');
    expect(response.body).not.toContain('NOT_UAT');
    expect(response.body).not.toContain('不是当前 Test 运行输出的证据');
    for (const claim of FORBIDDEN_PROJECT_HISTORY_RELEASE_CLAIMS) {
      expect(response.body).not.toContain(claim.replaceAll('`', ''));
    }
    expect(response.body).toContain(
      `<textarea readonly>${EXPECTED_PROJECT_HISTORY_INSTALL_PROMPT}</textarea>`,
    );
    expect(response.body.split(EXPECTED_PROJECT_HISTORY_INSTALL_PROMPT)).toHaveLength(2);
    expect(response.body).toContain('Combo Plugin 安装在 Codex Host，不是安装到当前 Project');
    expect(response.body).toContain('<strong>新安装：</strong>');
    expect(response.body).toContain('<strong>旧版：</strong>');
    expect(response.body).toContain('<strong>当前版：</strong>');
    expect(response.body).toContain('official stable 有效 semver');
    expect(response.body).toContain('五个 Project-history 工具齐全');
    expect(response.body).toContain('readiness 实际调用成功且 OAuth ready');
    expect(response.body).toContain('仅重试该失败的 readiness 一次');
    expect(response.body).toContain('business create 调用数为 0');
    expect(response.body).toContain('metadata 已是当前版不等于 OAuth ready');
    expect(response.body).toContain('在创建 recovery 任务前恰好执行一次 Codex-managed OAuth/login');
    expect(response.body).toContain('登录成功时用第一个 stale-catalog allowlist 摘要');
    expect(response.body).toContain('登录失败或用户取消时改用第四个 OAuth allowlist 摘要');
    expect(response.body).toContain('初始 bootstrap 的 recovery create 总预算始终为 1');
    expect(response.body).toContain('上述两分支互斥且 business create 调用数为 0');
    expect(response.body).toContain('<h2>BLOCK：零子任务</h2>');
    expect(response.body).toContain('同名错源、orphaned Plugin、无效或不兼容版本');
    expect(response.body).toContain(
      'remove、overwrite、盲目 upgrade、替换 source、其他 mutation、business create 与 recovery create 的调用数都为 0',
    );
    expect(response.body).toContain(
      'Test MCP 的 name、enabled/disabled 状态、transport.type 或 URL 只要存在明确 mismatch',
    );
    expect(response.body).toContain(
      'current task 已加载五个 Project-history 工具时，任何非 authorization 的 readiness 或内部失败',
    );
    expect(response.body).toContain('不得伪装成 OAuth recovery');
    expect(response.body).toContain('BLOCK 不得映射到四个 recovery 摘要');
    expect(response.body).toContain('<h2>RECOVERY：仅限四个 typed 分类</h2>');
    expect(response.body).toContain(
      '<strong>第二个摘要：</strong>仅限 initial official Marketplace/Plugin absent 或有效旧版',
    );
    expect(response.body).toContain(
      '<strong>第一个摘要：</strong>仅限 final official metadata 与 Test MCP gate 精确通过',
    );
    expect(response.body).toContain(
      '<strong>第三个摘要：</strong>仅限 official mutation 已完成后 Test MCP entry 暂时 missing 或 unavailable',
    );
    expect(response.body).toContain('明确 mismatch 或 disabled 属于 BLOCK');
    expect(response.body).toContain(
      '<strong>第四个摘要：</strong>仅限 OAuth incomplete、login failure 或用户取消',
    );
    expect(response.body).toContain('其他状态不得创建 recovery');
    expect(response.body).toContain('<code>metadataMutationAttempted=true</code>');
    expect(response.body).toContain('mutation history 优先于 frozen task catalog 的表面快照');
    expect(response.body).toContain('无论五工具表面为 true 或 false');
    expect(response.body).toContain('都必须恰好 login 一次');
    expect(response.body).toContain('登录后只创建 typed recovery，business create=0');
    expect(response.body).not.toContain(
      '同名错源、Plugin/Marketplace orphan 或非法版本用第二个 official-install-metadata 摘要创建 recovery',
    );
    expect(response.body).toContain(
      '不得把 metadata current 冒充为 authorization 或 business ready',
    );
    expect(response.body).toContain('安装或升级不会让已经运行的任务热加载');
    expect(response.body).toContain(EXPECTED_PROJECT_HISTORY_BUSINESS_HANDOFF);
    expect(response.body).toContain('target:{type:&quot;projectless&quot;}');
    expect(response.body).toContain('navigate_to_codex_page(threadId)');
    expect(response.body).toContain('projectless setup 任务不是');
    expect(response.body).toContain('Combo 安装续接：上一步未完成的低敏摘要是“&lt;summary&gt;”');
    expect(response.body).toContain('&lt;exact-business-paragraph&gt;');
    for (const summary of EXPECTED_PROJECT_HISTORY_RECOVERY_SUMMARIES) {
      expect(response.body).toContain(`<li><code>${summary}</code></li>`);
    }
    expect(response.body).not.toContain('exact-low-sensitivity-step-summary');
    expect(response.body).toContain('recovery 不得声称已安装');
    expect(response.body).toContain(
      'create_thread({prompt:recoveryPrompt,target:{type:&quot;projectless&quot;}})',
    );
    expect(response.body).toContain('business 与 recovery 两类 create_thread');
    expect(response.body).toContain('只返回一个非空 clientThreadId 时分类为 QUEUED');
    expect(response.body).toContain(
      '不得把 clientThreadId 传给 wait_threads、read_thread 或 navigate_to_codex_page',
    );
    expect(response.body).toContain('不得重复调用 create_thread');
    expect(response.body).toContain('只有同一次 create_thread 同时返回 ready threadId 与 hostId');
    expect(response.body).toContain('wait_threads({targets:[{threadId,hostId}],timeoutMs:0})');
    expect(response.body).toContain('wait 成功后才最多调用一次');
    expect(response.body).toContain('wait 失败时 navigate 调用数为 0');
    expect(response.body).toContain('::created-thread{clientThreadId=&quot;...&quot;}');
    expect(response.body).toContain('::created-thread{threadId=&quot;...&quot;}');
    expect(response.body).toContain('该指令不能代替 ready/open 验证');
    expect(response.body).toContain(
      '即使随后的 snapshot 或 navigation 失败，也必须保留 threadId 机器指令这一独立最终行',
    );
    expect(response.body).toContain('不得丢弃指令后只返回 marker');
    expect(response.body).toContain('PROJECT_HISTORY_BOOTSTRAP_CREATE_FAILED');
    expect(response.body).toContain('PROJECT_HISTORY_BOOTSTRAP_OPEN_FAILED');
    expect(response.body).toContain('create_thread 能力不可用也使用该 marker');
    expect(response.body).toContain(
      'wait_threads 或 navigate_to_codex_page 能力不可用也使用 OPEN_FAILED',
    );
    expect(response.body).toContain('用户 prose 只报告唯一固定 marker');
    expect(response.body).not.toContain('PROJECT_HISTORY_BOOTSTRAP_WAIT_FAILED');
    expect(response.body).toContain('setup 入口最多创建一个 recovery 任务');
    expect(response.body).toContain('recovery 入口创建 recovery 任务的预算为 0');
    expect(response.body).toContain('任何失败都不得继续链式创建');
    expect(response.body).toContain('readiness 通过后最多创建一个固定 business 任务');
    expect(response.body).toContain('仅供 Codex 自动处理失败时使用的命令 fallback');
    expect(response.body.indexOf(EXPECTED_PROJECT_HISTORY_INSTALL_PROMPT)).toBeLessThan(
      response.body.indexOf('仅供 Codex 自动处理失败时使用的命令 fallback'),
    );
    expect(response.body).toContain('Legacy current-task Codex Agent 流程');
    expect(response.body).not.toContain('0.8.4');
    expect(response.body).toContain('plugin marketplace upgrade dangdang-tech-combo --json');
    expect(response.body).toContain('plugin list --json');
    expect(response.body).toContain('marketplaceInitiallyPresent');
    expect(response.body).toContain('upgradePerformed=false');
    expect(response.body).toContain(
      '无论 marketplaceInitiallyPresent 初值为何，只要此时已确认 official Marketplace 且 Plugin 仍缺失，就恰好执行一次',
    );
    expect(response.body).toContain(
      'fresh install 的固定顺序必须是 marketplace add→重新读取并确认 official source→plugin add→最终检查',
    );
    const marketplaceAddIndex = response.body.indexOf(
      'plugin marketplace add https://github.com/dangdang-tech/combo-plugin.git',
    );
    const pluginAddIndex = response.body.indexOf('plugin add combo@dangdang-tech-combo --json');
    const finalCheckIndex = response.body.indexOf('最后再次执行');
    expect(marketplaceAddIndex).toBeGreaterThan(-1);
    expect(pluginAddIndex).toBeGreaterThan(marketplaceAddIndex);
    expect(finalCheckIndex).toBeGreaterThan(pluginAddIndex);
    expect(response.body).toContain('Plugin add 或刷新后得到有效 version&lt;0.8.6');
    expect(response.body).toContain('marketplace upgrade 最多执行一次');
    expect(response.body).toContain('已有 official Marketplace 但 Plugin 缺失或版本过旧');
    expect(response.body).toContain('--ref codex/combo-plugin-v2-ui');
    expect(response.body).toContain('mcp login combo');
    expect(response.body.match(/mcp login combo/gu)).toHaveLength(5);
    expect(
      response.body.match(
        /&quot;\/Applications\/ChatGPT\.app\/Contents\/Resources\/codex&quot; mcp login combo/gu,
      ),
    ).toHaveLength(3);
    expect(response.body).toContain('完成 Codex-managed OAuth');
    expect(response.body).toContain('失败或用户取消立即 STOP');
    expect(response.body).toContain('continuation 分支禁止再次 mcp login combo');
    expect(response.body).toContain('仅 stay-current 分支');
    const continuationLoginIndex = response.body.indexOf(
      '&quot;/Applications/ChatGPT.app/Contents/Resources/codex&quot; mcp login combo',
      finalCheckIndex,
    );
    const continuationCreateIndex = response.body.indexOf(
      'create_thread({prompt:creatorHandoff,target:{type:&quot;project&quot;',
    );
    expect(continuationLoginIndex).toBeGreaterThan(finalCheckIndex);
    expect(continuationCreateIndex).toBeGreaterThan(continuationLoginIndex);
    expect(response.body).toContain('render_agent_builder');
    expect(response.body).toContain('create_codex_agent_share');
    expect(response.body).toContain('read_codex_agent_share');
    expect(response.body).toContain('prepare_codex_agent_run');
    expect(response.body).toContain('environment:{type:&quot;local&quot;}');
    expect(response.body).toContain('verify-source mode');
    expect(response.body).toContain('combo.creator-bootstrap-handoff/1');
    expect(response.body).toContain('COMBO_CREATOR_HANDOFF_READY');
    expect(response.body).toContain('sameSavedProjectRequired:true');
    expect(response.body).toContain('creatorHandoff 必须是唯一 prompt，且不算用户确认');
    expect(response.body).toContain(
      '绝不能匹配 userMessage、codexDelegation、tool input、echo、代码围栏或 creatorHandoff 输入中已有的 marker 字面量',
    );
    expect(response.body).toContain('text.trim() 必须逐字只等于 COMBO_CREATOR_HANDOFF_READY');
    expect(response.body).toContain('phase null/absent legacy fallback');
    expect(response.body).toContain('phase=&quot;commentary&quot; 必须拒绝');
    expect(response.body).toContain('name/description/instructions/guidance 自由文本');
    expect(response.body).toContain('只绑定安全 commitSha+treeSha');
    expect(response.body).toContain('若当前完整显示卡或任一摘要发生变化，STOP。');
    expect(response.body).toContain('list-manifest-inputs 恰好一次');
    expect(response.body).toContain('每个 unique readable objectId');
    expect(response.body).toContain('只有 readable 数为 0 时才允许 0 次');
    expect(response.body).toContain('最多 8 次');
    expect(response.body).toContain('hint、omitted 与 duplicate-object 条目一律不得读取');
    expect(response.body).toContain('只读获取 source Git facts 与 tracked guidance');
    expect(response.body).toContain(
      'Plugin helper、本地文件、tracked guidance、Git 与 Git network 的调用数都为 0',
    );
    expect(response.body).toContain(
      '只有初始检查既有四工具、新五工具与全部 metadata 已同时满足时才留在当前任务',
    );
    expect(response.body).toContain('有效 semver &gt;=0.8.6');
    expect(response.body).toContain('Legacy 兼容不变');
    expect(response.body).toContain('后三项即使为空也显式写 []');
    expect(response.body).toContain('navigate_to_codex_page(threadId)');
    expect(response.body).toContain('\\u003c');
    expect(response.body).toContain('V1 不支持撤销或过期');
    expect(response.body).toContain('全程零重启');
    expect(response.body).toContain('Plugin tool catalog 阻断');
    expect(response.body).not.toContain('完全退出并重开');
    expect(response.body).not.toContain('plugin remove');
    expect(response.body).not.toContain('marketplace remove');
    expect(response.body).not.toContain('mcp add combo');
    expect(response.body).not.toContain('$COMBO_CODEX_CLI');
  });

  it.each(['development', 'preview', 'production'] as const)(
    'does not expose a cross-environment install command in %s',
    async (environment) => {
      const isolated = Fastify({ logger: false });
      isolated.decorate('infra', {
        env: { ...testEnv(), COMBO_ENVIRONMENT: environment },
        db: { query: vi.fn() },
        objectStore: {},
      } as never);
      await registerExternalMcpRoutes(isolated);
      try {
        const response = await isolated.inject({ method: 'GET', url: '/codex-plugin' });
        expect(response.statusCode).toBe(200);
        expect(response.body).toContain('暂不可安装');
        expect(response.body).not.toContain('plugin marketplace add');
        expect(response.body).not.toContain('mcp login combo');
        expect(response.body).not.toContain('codex/combo-plugin-v2-ui');
        expect(response.body).not.toContain('已验收的 Test 安装页');
        expect(response.body).toContain('部署并验证后');
      } finally {
        await isolated.close();
      }
    },
  );

  it('rate-limits authorization and both MCP methods before handlers run', async () => {
    const isolated = Fastify({ logger: false });
    const seen: Array<{ method: unknown; url: string; config: Record<string, unknown> }> = [];
    isolated.addHook('onRoute', (route) => {
      seen.push({
        method: route.method,
        url: route.url,
        config: (route.config ?? {}) as Record<string, unknown>,
      });
    });
    isolated.decorate('infra', {
      env: testEnv(),
      db: { query: vi.fn() },
      objectStore: {},
    } as never);
    await registerExternalMcpRoutes(isolated);
    try {
      const authorizeGet = seen.find(
        (route) => route.url === '/api/external-mcp/oauth/authorize' && route.method === 'GET',
      );
      expect(authorizeGet?.config).toMatchObject({
        rateLimit: { max: 30, timeWindow: '1 minute' },
      });
      for (const method of ['GET', 'POST']) {
        const mcp = seen.find(
          (route) => route.url === '/api/external-mcp/mcp' && route.method === method,
        );
        expect(mcp?.config).toMatchObject({
          rateLimit: { max: 300, timeWindow: '1 minute' },
        });
      }
    } finally {
      await isolated.close();
    }
  });

  it('drives one shared low-frequency cleanup scheduler from every OAuth write and MCP entrypoint', async () => {
    vi.useFakeTimers();
    const cleanupQuery = vi.fn().mockResolvedValue({
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
    });
    const isolated = Fastify({ logger: false });
    isolated.decorate('infra', {
      env: testEnv(),
      db: { query: cleanupQuery },
      objectStore: {},
    } as never);
    await registerExternalMcpRoutes(isolated);
    let clock = Date.UTC(2100, 0, 1);
    const advanceWindow = () => {
      vi.setSystemTime(clock);
      clock += 61_000;
    };
    try {
      advanceWindow();
      await isolated.inject({
        method: 'POST',
        url: '/api/external-mcp/oauth/register',
        headers: { authorization: 'Bearer rejected' },
      });
      advanceWindow();
      await isolated.inject({ method: 'GET', url: '/api/external-mcp/oauth/authorize' });
      advanceWindow();
      await isolated.inject({
        method: 'POST',
        url: '/api/external-mcp/oauth/authorize',
        headers: { origin: 'https://untrusted.example' },
      });
      advanceWindow();
      await isolated.inject({
        method: 'POST',
        url: '/api/external-mcp/oauth/token',
        headers: { authorization: 'Bearer rejected' },
      });
      advanceWindow();
      await isolated.inject({
        method: 'GET',
        url: '/api/external-mcp/mcp',
        headers: { origin: 'https://untrusted.example' },
      });
      advanceWindow();
      await isolated.inject({
        method: 'POST',
        url: '/api/external-mcp/mcp',
        headers: { origin: 'https://untrusted.example' },
      });

      expect(cleanupQuery).toHaveBeenCalledTimes(6);
      for (const call of cleanupQuery.mock.calls) {
        expect(call[0]).toContain('cleanup_expired_oauth_artifacts($1)');
        expect(call[0]).toContain('cleanup_retired_project_history_confirmations($1)');
        expect(call[1]).toEqual([100]);
      }
    } finally {
      vi.useRealTimers();
      await isolated.close();
    }
  });
});

describe('external MCP stateless machine contract', () => {
  let app: FastifyInstance;
  let scope = 'combo.agent:read combo.agent:write';
  let storedCodexShare:
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

  beforeAll(async () => {
    app = Fastify({ logger: false });
    const db = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('INSERT INTO project_agent_shares')) {
          storedCodexShare = {
            id: '00000000-0000-4000-8000-000000000099',
            owner_user_id: String(params[0]),
            share_token: String(params[1]),
            manifest: JSON.parse(String(params[2])) as unknown,
            manifest_sha256: String(params[3]),
            idempotency_key: String(params[4]),
            idempotency_sha256: String(params[5]),
            created_at: String(params[6]),
          };
          return { rows: [storedCodexShare], rowCount: 1 };
        }
        if (sql.includes('FROM project_agent_shares') && sql.includes('WHERE share_token')) {
          const found =
            storedCodexShare && storedCodexShare.share_token === params[0]
              ? [storedCodexShare]
              : [];
          return { rows: found, rowCount: found.length };
        }
        if (sql.includes('FROM capabilities')) {
          return {
            rows: [
              {
                id: CAPABILITY_ID,
                task_id: TASK_ID,
                name: 'Entry capability',
                summary: 'A reusable workflow.',
                kind: 'knowledge',
                published: false,
                published_at: null,
                share_token: null,
                created_at: NOW,
              },
              {
                id: '00000000-0000-4000-8000-000000000003',
                task_id: TASK_ID,
                name: 'Second capability',
                summary: '',
                kind: 'workflow',
                published: false,
                published_at: null,
                share_token: null,
                created_at: NOW,
              },
            ],
            rowCount: 2,
          };
        }
        if (!sql.includes('FROM oauth_access_tokens')) throw new Error('unexpected SQL');
        return {
          rows: [
            {
              owner_user_id: '00000000-0000-4000-8000-000000000001',
              account: 'creator-aaaaaaaa',
              roles: ['creator'],
              disabled_at: null,
              scope,
            },
          ],
          rowCount: 1,
        };
      }),
    };
    app.decorate('infra', {
      env: testEnv(),
      db,
      objectStore: {},
    } as never);
    await registerExternalMcpRoutes(app);
  });

  afterAll(async () => {
    await app.close();
  });

  async function call(
    method: string,
    params?: unknown,
    accept = 'application/json, text/event-stream',
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/external-mcp/mcp',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept,
      },
      payload: { jsonrpc: '2.0', id: 7, method, ...(params === undefined ? {} : { params }) },
    });
  }

  it('supports initialize and advertises the exact 23 legacy plus five Package tools', async () => {
    const initialized = await call('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'Codex', version: '0.147.0' },
    });
    expect(initialized.statusCode).toBe(200);
    expect(initialized.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 7,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { version: '0.8.4' },
        instructions: expect.stringContaining('use create_codex_agent_share'),
      },
    });
    const initializeResult = initialized.json() as {
      result: { instructions: string };
    };
    expect(initializeResult.result.instructions).toContain(
      'then use create_codex_agent_share and immediately read back the same URL',
    );
    expect(initializeResult.result.instructions).toContain('prepare_codex_agent_run');
    expect(initializeResult.result.instructions).toContain('codex_agent_restore');
    expect(initializeResult.result.instructions).toContain('starterOrdinal');
    expect(initializeResult.result.instructions).toContain('fixed Creator confirmation action');
    expect(initializeResult.result.instructions).toContain(
      'Do not call extraction, Capability, legacy Agent Project, or Project Agent share tools',
    );

    const listed = await call('tools/list');
    const tools = (listed.json() as { result: { tools: Array<Record<string, unknown>> } }).result
      .tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      'create_extraction_task',
      'read_extraction_task',
      'list_capabilities',
      'read_capability_definition',
      'list_agent_projects',
      'render_agent_builder',
      'create_agent_project',
      'target_agent_project',
      'read_agent_project',
      'save_agent_ui',
      'read_agent_ui',
      'commit_agent_revision',
      'read_agent_revision',
      'run_agent_test',
      'list_agent_tests',
      'read_agent_test',
      'record_agent_test_review',
      'publish_agent_revision',
      'create_project_agent_share',
      'read_project_agent_share',
      'create_codex_agent_share',
      'read_codex_agent_share',
      'prepare_codex_agent_run',
      'create_agent_package_draft',
      'render_agent_package_draft',
      'create_agent_package_share',
      'read_agent_package_share',
      'prepare_agent_package_run',
    ]);
    expect(tools).toHaveLength(28);
    const run = tools.find((tool) => tool.name === 'run_agent_test')!;
    expect((run.inputSchema as { required: string[] }).required).toContain('revisionId');
    const readUi = tools.find((tool) => tool.name === 'read_agent_ui')!;
    expect((readUi.inputSchema as { oneOf: unknown[] }).oneOf).toHaveLength(2);
    const renderer = tools.find((tool) => tool.name === 'render_agent_builder')!;
    expect(renderer).toMatchObject({
      inputSchema: { type: 'object', oneOf: expect.any(Array) },
      outputSchema: { type: 'object' },
      _meta: {
        ui: { resourceUri: 'ui://combo/agent-builder/v1.html' },
        'openai/outputTemplate': 'ui://combo/agent-builder/v1.html',
      },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    });
    expect((renderer.inputSchema as { oneOf: unknown[] }).oneOf).toHaveLength(2);
    const renderAjv = new Ajv({ allErrors: true, strict: false });
    const validateRender = renderAjv.compile(renderer.inputSchema as Record<string, unknown>);
    const strictRestoreInput = {
      stage: 'codex_agent_restore',
      shareUrl: `${ORIGIN}/agent/${'A'.repeat(43)}`,
      manifestSha256: 'c'.repeat(64),
    };
    expect(validateRender(strictRestoreInput), JSON.stringify(validateRender.errors)).toBe(true);
    expect(validateRender({ ...strictRestoreInput, title: 'forbidden' })).toBe(false);
    expect(
      validateRender({
        stage: 'project_restore',
        title: 'Legacy V0',
        summary: '保留字节兼容。',
        progress: [],
        items: [],
        actions: [],
      }),
      JSON.stringify(validateRender.errors),
    ).toBe(true);
    for (const name of ['create_project_agent_share', 'read_project_agent_share']) {
      expect(tools.find((tool) => tool.name === name)).toMatchObject({
        outputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['manifest', 'shareUrl', 'copyPrompt'],
        },
      });
    }
    for (const name of ['create_codex_agent_share', 'read_codex_agent_share']) {
      expect(tools.find((tool) => tool.name === name)).toMatchObject({
        outputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['manifest', 'manifestSha256', 'shareUrl', 'copyPrompt'],
        },
      });
    }
    expect(tools.find((tool) => tool.name === 'prepare_codex_agent_run')).toMatchObject({
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['shareUrl', 'manifestSha256', 'starterOrdinal', 'starterPrompt'],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['shareUrl', 'manifestSha256', 'starterOrdinal', 'starterPrompt', 'runEnvelope'],
      },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    });

    const resources = await call('resources/list');
    expect(resources.json()).toMatchObject({
      result: {
        resources: [
          {
            uri: 'ui://combo/agent-builder/v1.html',
            name: 'combo-agent-builder',
            mimeType: 'text/html;profile=mcp-app',
          },
          {
            uri: 'ui://combo/project-history-agent-draft/v1.html',
            name: 'combo-project-history-agent-draft',
            mimeType: 'text/html;profile=mcp-app',
          },
        ],
      },
    });
    const resource = await call('resources/read', {
      uri: 'ui://combo/agent-builder/v1.html',
    });
    expect(resource.json()).toMatchObject({
      result: {
        contents: [
          {
            uri: 'ui://combo/agent-builder/v1.html',
            mimeType: 'text/html;profile=mcp-app',
            _meta: { ui: { prefersBorder: true } },
          },
        ],
      },
    });
    const html = resource.json().result.contents[0].text as string;
    expect(html).toContain("request('ui/initialize'");
    expect(html).toContain("notify('ui/notifications/initialized'");
    expect(html).toContain("request('ui/message'");
    expect(html).toContain('window.openai.sendFollowUpMessage');
  });

  it.each([
    'application/jsonp, text/event-streaming',
    'application/json; q=0, text/event-stream',
    'application/json, text/event-stream; q=0',
    '*/*',
  ])('rejects a non-exact or explicitly unacceptable MCP Accept header: %s', async (accept) => {
    const response = await call('ping', undefined, accept);
    expect(response.statusCode).toBe(406);
  });

  it('accepts exact MCP media types with case-insensitive tokens and positive parameters', async () => {
    const response = await call(
      'ping',
      undefined,
      'Application/JSON; charset=utf-8, Text/Event-Stream; q=0.5',
    );
    expect(response.statusCode).toBe(200);
  });

  it('rejects incomplete initialize params and negotiates an unsupported body version', async () => {
    const incomplete = await call('initialize', { protocolVersion: '2025-11-25' });
    expect(incomplete.json()).toMatchObject({
      error: { code: -32602, message: 'Invalid initialize params.' },
    });

    const unsupported = await call('initialize', {
      protocolVersion: '2099-01-01',
      capabilities: {},
      clientInfo: { name: 'Codex', version: '0.147.0' },
    });
    expect(unsupported.json()).toMatchObject({
      result: { protocolVersion: '2025-11-25' },
    });
  });

  it('advertises a commit schema that applies the canonical defaults and output union', async () => {
    const listed = await call('tools/list');
    const tools = (listed.json() as { result: { tools: Array<Record<string, unknown>> } }).result
      .tools;
    const commit = tools.find((tool) => tool.name === 'commit_agent_revision')!;
    const inputSchema = commit.inputSchema as Record<string, unknown>;
    const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
    ajv.addFormat(
      'uuid',
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const validate = ajv.compile(inputSchema);
    const input = {
      projectId: '00000000-0000-4000-8000-000000000010',
      expectedHeadRevisionId: null,
      mutationId: 'mutation-123',
      changeSummary: 'Initial',
      definition: {
        schemaVersion: 'combo.agent/1',
        identity: { name: 'Schema Agent' },
        interface: { output: { type: 'structured', schema: { type: 'object' } } },
        behavior: {
          instructions: 'Help.',
          capabilities: [
            {
              capabilityId: '00000000-0000-4000-8000-000000000011',
              role: 'entry',
            },
          ],
        },
        ui: {
          kind: 'miniapp-html',
          artifactId: '00000000-0000-4000-8000-000000000012',
          bridgeVersion: 1,
        },
        runtime: { mode: 'single-loop' },
      },
    };

    expect(validate(input), ajv.errorsText(validate.errors)).toBe(true);
    expect(input.definition).toMatchObject({
      identity: { summary: '' },
      interface: { inputs: [], starterPrompts: [] },
    });
    expect(AgentDefinitionSchema.safeParse(input.definition).success).toBe(true);

    const definitionSchema = (inputSchema.properties as Record<string, unknown>)
      .definition as Record<string, unknown>;
    const definitionProperties = definitionSchema.properties as Record<string, unknown>;
    const interfaceSchema = definitionProperties.interface as Record<string, unknown>;
    const interfaceProperties = interfaceSchema.properties as Record<string, unknown>;
    expect(interfaceSchema.required).toEqual(['output']);
    expect((interfaceProperties.output as { oneOf: unknown[] }).oneOf).toHaveLength(2);
    const inputs = interfaceProperties.inputs as Record<string, unknown>;
    const inputField = inputs.items as Record<string, unknown>;
    expect(inputField.required).toEqual(['key', 'label', 'type']);
    const inputProperties = inputField.properties as Record<string, Record<string, unknown>>;
    expect(inputProperties.type).toEqual({
      type: 'string',
      enum: ['string', 'text', 'number', 'enum'],
    });
    expect(inputProperties.required).toEqual({ type: 'boolean', default: false });

    const output = interfaceProperties.output as Record<string, unknown>;
    expect(output).toEqual({
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['type'],
          properties: { type: { type: 'string', const: 'text' } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'schema'],
          properties: {
            type: { type: 'string', const: 'structured' },
            schema: {
              type: 'object',
              propertyNames: { type: 'string' },
              additionalProperties: {},
            },
          },
        },
      ],
    });
    const behavior = definitionProperties.behavior as Record<string, unknown>;
    const bindings = (behavior.properties as Record<string, unknown>).capabilities as Record<
      string,
      unknown
    >;
    const bindingProperties = (bindings.items as Record<string, unknown>).properties as Record<
      string,
      unknown
    >;
    expect(bindingProperties.role).toEqual({
      type: 'string',
      enum: ['entry', 'support'],
    });
    const ui = definitionProperties.ui as Record<string, unknown>;
    expect((ui.properties as Record<string, unknown>).kind).toEqual({
      type: 'string',
      const: 'miniapp-html',
    });
    expect((ui.properties as Record<string, unknown>).bridgeVersion).toEqual({
      type: 'number',
      const: 1,
    });
    const runtime = definitionProperties.runtime as Record<string, unknown>;
    expect((runtime.properties as Record<string, unknown>).mode).toEqual({
      type: 'string',
      const: 'single-loop',
    });

    const invalidStructured = structuredClone(input) as unknown as {
      definition: { interface: { output: unknown } };
    };
    invalidStructured.definition.interface.output = { type: 'structured' };
    expect(validate(invalidStructured)).toBe(false);
    expect(AgentDefinitionSchema.safeParse(invalidStructured.definition).success).toBe(false);
  });

  it('advertises the two-axis three-kind quality review contract', async () => {
    const listed = await call('tools/list');
    const tools = (listed.json() as { result: { tools: Array<Record<string, unknown>> } }).result
      .tools;
    const review = tools.find((tool) => tool.name === 'record_agent_test_review')!;
    const ajv = new Ajv({ allErrors: true, strict: false });
    ajv.addFormat(
      'uuid',
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const validate = ajv.compile(review.inputSchema as Record<string, unknown>);
    const cases = [
      {
        caseId: 'normal-1',
        kind: 'normal',
        executionStatus: 'completed',
        qualityVerdict: 'passed',
        reason: 'complete',
      },
      {
        caseId: 'boundary-1',
        kind: 'boundary',
        executionStatus: 'completed',
        qualityVerdict: 'accepted_exception',
        reason: 'bounded exception',
        impact: 'missing rollback inputs only',
      },
      {
        caseId: 'failure-1',
        kind: 'failure',
        executionStatus: 'completed',
        qualityVerdict: 'passed',
        reason: 'returns NO_GO',
      },
    ];
    expect(
      validate({
        projectId: '00000000-0000-4000-8000-000000000002',
        testId: '00000000-0000-4000-8000-000000000006',
        idempotencyKey: 'quality-review-123',
        cases,
      }),
    ).toBe(true);
    expect(
      validate({
        projectId: '00000000-0000-4000-8000-000000000002',
        testId: '00000000-0000-4000-8000-000000000006',
        idempotencyKey: 'quality-review-456',
        cases: cases.map((reviewCase) =>
          reviewCase.kind === 'boundary' ? { ...reviewCase, impact: undefined } : reviewCase,
        ),
      }),
    ).toBe(false);
    expect(
      validate({
        projectId: '00000000-0000-4000-8000-000000000002',
        testId: '00000000-0000-4000-8000-000000000006',
        idempotencyKey: 'quality-review-789',
        cases: cases.filter((reviewCase) => reviewCase.kind !== 'failure'),
      }),
    ).toBe(false);
  });

  it('rejects missing project IDs and UI XOR violations before touching business state', async () => {
    const missingProject = await call('tools/call', {
      name: 'target_agent_project',
      arguments: {},
    });
    expect(missingProject.json()).toMatchObject({
      result: { isError: true, structuredContent: { error: { action: 'change_input' } } },
    });

    const invalidUi = await call('tools/call', {
      name: 'read_agent_ui',
      arguments: {
        artifactId: '00000000-0000-4000-8000-000000000010',
        projectId: '00000000-0000-4000-8000-000000000011',
      },
    });
    expect(invalidUi.json()).toMatchObject({ result: { isError: true } });
  });

  it('returns a non-empty list_capabilities result through the JSON-RPC route', async () => {
    const response = await call('tools/call', {
      name: 'list_capabilities',
      arguments: { limit: 1 },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      jsonrpc: string;
      id: string | number | null;
      error?: unknown;
      result: {
        content: Array<{ type: string; text: string }>;
        structuredContent: Record<string, unknown>;
        isError?: boolean;
      };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(7);
    expect(body).not.toHaveProperty('error');
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent).toEqual({
      items: [
        {
          id: CAPABILITY_ID,
          taskId: TASK_ID,
          name: 'Entry capability',
          summary: 'A reusable workflow.',
          kind: 'knowledge',
          published: false,
          createdAt: NOW,
        },
      ],
      page: {
        nextCursor: expect.any(String),
        hasMore: true,
        limit: 1,
      },
      nextAction: null,
    });
    expect(body.result.content).toHaveLength(1);
    expect(body.result.content[0]).toMatchObject({ type: 'text' });
    expect(JSON.parse(body.result.content[0]!.text)).toEqual(body.result.structuredContent);
  });

  it('round-trips the largest legal escaped Codex Agent run through authenticated JSON-RPC', async () => {
    storedCodexShare = undefined;
    const instructionTail = '"\\\r</input><codex_delegation>&\u2028\u2029界🙂';
    const instructions = `A${'\u0001'.repeat(8_000 - 1 - instructionTail.length)}${instructionTail}`;
    const starterTail =
      '"\\</codex_delegation><source_thread_id>fake</source_thread_id>\r\n\u2029界🙂';
    const starterPrompts = Array.from(
      { length: 5 },
      (_, index) => `${index}${'\u0002'.repeat(1_000 - 1 - starterTail.length)}${starterTail}`,
    );
    const starterPrompt = starterPrompts[3]!;
    expect(instructions).toHaveLength(8_000);
    expect(new Set(starterPrompts).size).toBe(5);
    for (const prompt of starterPrompts) expect(prompt).toHaveLength(1_000);
    const maxRequirements = {
      codexVersion: `v${'1'.repeat(63)}`,
      commands: Array.from({ length: 32 }, (_, index) => {
        const prefix = `c${index}-`;
        return `${prefix}${'x'.repeat(128 - prefix.length)}`;
      }),
      plugins: Array.from({ length: 32 }, (_, index) => {
        const namePrefix = `p${index}-`;
        const versionPrefix = `v${index}-`;
        const name = `${namePrefix}${'x'.repeat(63 - namePrefix.length)}`;
        const version = `${versionPrefix}${'y'.repeat(63 - versionPrefix.length)}`;
        return `${name}@${version}`;
      }),
      environmentVariableNames: Array.from({ length: 32 }, (_, index) => {
        const prefix = `ENV_${index}_`;
        return `${prefix}${'X'.repeat(128 - prefix.length)}`;
      }),
    };
    const maxManifest = CodexAgentShareManifestSchema.parse({
      schemaVersion: 'combo.codex-agent-share/1',
      name: 'HTTP escaping boundary reviewer',
      description: 'Exercise the authenticated JSON-RPC run-envelope boundary.',
      source: {
        repositoryUrl: 'https://github.com/openai/codex.git',
        sourceRef: 'refs/heads/main',
        commitSha: 'a'.repeat(40),
        treeSha: 'b'.repeat(40),
      },
      authoringSource: { kind: 'codex_current_task', rawStored: false },
      agent: { instructions, starterPrompts },
      requirements: maxRequirements,
      createdAt: NOW,
    });
    expect(canonicalJson(maxManifest.requirements).length).toBeGreaterThan(10_000);
    expect(canonicalJson(maxManifest.requirements).length).toBeLessThanOrEqual(20_000);

    const createdResponse = await call('tools/call', {
      name: 'create_codex_agent_share',
      arguments: {
        name: maxManifest.name,
        description: maxManifest.description,
        repositoryUrl: maxManifest.source.repositoryUrl,
        sourceRef: maxManifest.source.sourceRef,
        commitSha: maxManifest.source.commitSha,
        treeSha: maxManifest.source.treeSha,
        agent: maxManifest.agent,
        requirements: maxManifest.requirements,
        idempotencyKey: '00000000-0000-4000-8000-000000000099',
      },
    });
    expect(createdResponse.statusCode).toBe(200);
    const createdBody = createdResponse.json() as {
      result: {
        content: Array<{ type: string; text?: string }>;
        structuredContent: unknown;
        isError?: boolean;
      };
    };
    expect(createdBody.result.isError).toBeUndefined();
    const created = CodexAgentShareResultSchema.parse(createdBody.result.structuredContent);
    expect(created.manifest.agent).toEqual({ instructions, starterPrompts });
    expect(createdBody.result.content[0]).toEqual({ type: 'text', text: '{"created":true}' });
    expect(createdBody.result.content[0]?.text).not.toContain(instructions);
    expect(createdBody.result.content[0]?.text).not.toContain(created.copyPrompt);
    for (const prompt of starterPrompts) {
      expect(createdBody.result.content[0]?.text).not.toContain(prompt);
    }

    const readResponse = await call('tools/call', {
      name: 'read_codex_agent_share',
      arguments: { shareUrl: created.shareUrl },
    });
    expect(readResponse.statusCode).toBe(200);
    const readBody = readResponse.json() as {
      result: {
        content: Array<{ type: string; text?: string }>;
        structuredContent: unknown;
        isError?: boolean;
      };
    };
    expect(readBody.result.isError).toBeUndefined();
    expect(CodexAgentShareResultSchema.parse(readBody.result.structuredContent)).toEqual(created);
    expect(readBody.result.content[0]).toEqual({ type: 'text', text: '{"read":true}' });
    expect(readBody.result.content[0]?.text).not.toContain(instructions);
    expect(readBody.result.content[0]?.text).not.toContain(created.copyPrompt);
    for (const prompt of starterPrompts) {
      expect(readBody.result.content[0]?.text).not.toContain(prompt);
    }

    const renderedResponse = await call('tools/call', {
      name: 'render_agent_builder',
      arguments: {
        stage: 'codex_agent_restore',
        shareUrl: created.shareUrl,
        manifestSha256: created.manifestSha256,
      },
    });
    expect(renderedResponse.statusCode).toBe(200);
    const renderedBody = renderedResponse.json() as {
      result: {
        content: Array<{ type: string; text: string }>;
        structuredContent: {
          stage: string;
          items: Array<{
            summary: string;
            facts: Array<{ label: string; value: string }>;
            action?: { message: string };
          }>;
        };
        isError?: boolean;
      };
    };
    expect(renderedBody.result.isError).toBeUndefined();
    expect(renderedBody.result.content).toEqual([
      { type: 'text', text: '{"rendered":true,"stage":"codex_agent_restore"}' },
    ]);
    expect(renderedBody.result.structuredContent.stage).toBe('codex_agent_restore');
    expect(renderedBody.result.structuredContent.items).toHaveLength(6);
    expect(
      renderedBody.result.structuredContent.items.slice(1).map((item) => item.summary),
    ).toEqual(starterPrompts);
    expect(
      renderedBody.result.structuredContent.items[0]?.facts.find(
        (fact) => fact.label === 'manifestSha256',
      )?.value,
    ).toBe(created.manifestSha256);
    const renderedRequirements = renderedBody.result.structuredContent.items[0]?.facts.find(
      (fact) => fact.label === 'requirements 完整 JSON',
    )?.value;
    expect(renderedRequirements).toBe(canonicalJson(maxRequirements));
    expect(renderedRequirements?.length).toBeGreaterThan(10_000);
    expect(renderedRequirements?.length).toBeLessThanOrEqual(20_000);
    for (const item of renderedBody.result.structuredContent.items.slice(1)) {
      for (const prompt of starterPrompts) {
        expect(item.action?.message).not.toContain(prompt);
      }
    }

    const preparedResponse = await call('tools/call', {
      name: 'prepare_codex_agent_run',
      arguments: {
        shareUrl: created.shareUrl,
        manifestSha256: created.manifestSha256,
        starterOrdinal: 4,
        starterPrompt,
      },
    });
    expect(preparedResponse.statusCode).toBe(200);
    const preparedBody = preparedResponse.json() as {
      result: {
        content: Array<{ type: string; text: string }>;
        structuredContent: unknown;
        isError?: boolean;
      };
    };
    expect(preparedBody.result.isError).toBeUndefined();
    const prepared = PrepareCodexAgentRunResultSchema.parse(preparedBody.result.structuredContent);
    expect(prepared).toEqual({
      shareUrl: created.shareUrl,
      manifestSha256: created.manifestSha256,
      starterOrdinal: 4,
      starterPrompt,
      runEnvelope: renderCodexAgentRunEnvelope({
        manifest: created.manifest,
        manifestSha256: created.manifestSha256,
        shareUrl: created.shareUrl,
        starterOrdinal: 4,
        chosenStarterPrompt: starterPrompt,
      }),
    });
    expect(prepared.runEnvelope.length).toBeLessThanOrEqual(64_000);
    expect(prepared.runEnvelope).toContain('\\u0001');
    expect(prepared.runEnvelope).not.toMatch(/[<>&\u2028\u2029]/u);
    expect(JSON.parse(prepared.runEnvelope)).toMatchObject({
      instructions,
      starterOrdinal: 4,
      starterPrompt,
    });
    expect(preparedBody.result.content).toEqual([{ type: 'text', text: '{"prepared":true}' }]);
    expect(preparedBody.result.content[0]?.text).not.toContain(prepared.runEnvelope);
    expect(preparedBody.result.content[0]?.text).not.toContain(instructions);
    expect(preparedBody.result.content[0]?.text).not.toContain(starterPrompt);
    for (const unchosen of starterPrompts.filter((prompt) => prompt !== starterPrompt)) {
      expect(JSON.stringify(prepared)).not.toContain(unchosen);
    }
  });

  it('denies a write tool when the access token has read-only scope', async () => {
    scope = 'combo.agent:read';
    try {
      const response = await call('tools/call', {
        name: 'create_agent_project',
        arguments: { name: 'Denied', idempotencyKey: 'idempotency-123' },
      });
      expect(response.json()).toMatchObject({
        result: {
          isError: true,
          structuredContent: { error: { action: 'escalate', retriable: false } },
        },
      });
    } finally {
      scope = 'combo.agent:read combo.agent:write';
    }
  });
});

describe('external MCP consent boundary', () => {
  const requestToken = `mar1.${'r'.repeat(43)}`;
  const sessionCookie = `s1.${'s'.repeat(43)}`;
  let app: FastifyInstance;
  const release = vi.fn();
  const query = vi.fn(async (sql: string) => {
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
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM oauth_authorization_requests')) {
      return {
        rows: [
          {
            request_digest: Buffer.alloc(32),
            client_id: `mcp_client_${'c'.repeat(43)}`,
            client_name: '<img src=x onerror=alert(1)>',
            redirect_uri: 'http://127.0.0.1:49152/callback/codex-id?internal=not-visible',
            state: 'private-oauth-state',
            scope: 'combo.agent:read combo.agent:write',
            resource_uri: RESOURCE,
            code_challenge: 'p'.repeat(43),
            expires_at: new Date(Date.now() + 60_000),
            consumed_at: null,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('FROM auth_sessions')) {
      return {
        rows: [
          {
            session_id: '00000000-0000-4000-8000-000000000020',
            user_id: '00000000-0000-4000-8000-000000000021',
            account: 'creator-aaaaaaaa',
            roles: ['creator'],
            disabled_at: null,
          },
        ],
        rowCount: 1,
      };
    }
    if (
      sql.includes('UPDATE oauth_authorization_requests') ||
      sql.includes('INSERT INTO oauth_authorization_codes')
    ) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const connect = vi.fn(async () => ({ query, release }));
  const nonCleanupQueries = () =>
    query.mock.calls.filter(([sql]) => !String(sql).includes('cleanup_expired_oauth_artifacts'));

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.decorate('infra', {
      env: testEnv(),
      db: { query, connect },
      objectStore: {},
    } as never);
    await app.register(cookie);
    await registerExternalMcpRoutes(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('shows an escaped local callback identity without rendering OAuth state', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/external-mcp/oauth/authorize?request=${requestToken}`,
      headers: { cookie: `cb_session=${sessionCookie}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(response.body).not.toContain('<img src=x');
    expect(response.body).toContain('<code>127.0.0.1/callback/codex-id</code>');
    expect(response.body).not.toContain('private-oauth-state');
    expect(response.body).not.toContain('internal=not-visible');
    expect(response.headers['referrer-policy']).toBe('strict-origin');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' http://127.0.0.1:49152; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(response.headers['content-security-policy']).not.toContain('/callback');
    expect(response.headers['content-security-policy']).not.toContain('internal=not-visible');
  });

  it('keeps no-referrer on authorization error pages', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/external-mcp/oauth/authorize?request=invalid',
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
  });

  it('accepts the same-origin consent POST emitted by the authorization page', async () => {
    query.mockClear();
    connect.mockClear();
    release.mockClear();
    const response = await app.inject({
      method: 'POST',
      url: '/api/external-mcp/oauth/authorize',
      headers: {
        cookie: `cb_session=${sessionCookie}`,
        origin: ORIGIN,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `request=${requestToken}&decision=approve`,
    });

    expect(response.statusCode).toBe(303);
    const redirect = new URL(response.headers.location ?? '');
    expect(`${redirect.origin}${redirect.pathname}`).toBe(
      'http://127.0.0.1:49152/callback/codex-id',
    );
    expect(redirect.searchParams.get('state')).toBe('private-oauth-state');
    expect(redirect.searchParams.get('code')).toMatch(/^mac1\./);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'opaque Origin', origin: 'null', fetchSite: 'same-origin' },
    { name: 'cross-site metadata', origin: ORIGIN, fetchSite: 'cross-site' },
  ])(
    'rejects $name before session or authorization state lookup',
    async ({ origin, fetchSite }) => {
      query.mockClear();
      const response = await app.inject({
        method: 'POST',
        url: '/api/external-mcp/oauth/authorize',
        headers: {
          origin,
          'sec-fetch-site': fetchSite,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `request=${requestToken}&decision=approve`,
      });

      expect(response.statusCode).toBe(403);
      expect(response.body).toContain('授权确认来源无效');
      expect(nonCleanupQueries()).toHaveLength(0);
    },
  );

  it.each([
    `request=${requestToken}&request=${requestToken}&decision=approve`,
    `request=${requestToken}&decision=approve&decision=deny`,
  ])('rejects duplicated consent fields before session lookup', async (payload) => {
    query.mockClear();
    const response = await app.inject({
      method: 'POST',
      url: '/api/external-mcp/oauth/authorize',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('授权确认内容无效');
    expect(nonCleanupQueries()).toHaveLength(0);
  });
});
