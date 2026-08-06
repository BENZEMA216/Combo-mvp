import Fastify, { type FastifyInstance } from 'fastify';
import { Ajv } from 'ajv';
import cookie from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AgentDefinitionSchema,
  MCP_OAUTH_SCOPES,
  OAuthAuthorizationServerMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
} from '@cb/shared';
import { buildApp } from '../bootstrap/app.js';
import { loadEnv } from '../platform/config/env.js';
import { registerExternalMcpRoutes } from '../modules/external-mcp/routes.js';

const ORIGIN = 'http://localhost';
const RESOURCE = `${ORIGIN}/api/external-mcp/mcp`;
const TOKEN = `mat1.${'a'.repeat(43)}`;

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
    expect(response.body).toContain('--ref codex/mcp-oauth-v1');
    expect(response.body).toContain('mcp login combo');
    expect(response.body).not.toContain('mcp add combo');
  });

  it.each(['preview', 'production'] as const)(
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
        expect(response.body).not.toContain('codex/mcp-oauth-v1');
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

  beforeAll(async () => {
    app = Fastify({ logger: false });
    const db = {
      query: vi.fn(async (sql: string) => {
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

  async function call(method: string, params?: unknown) {
    return app.inject({
      method: 'POST',
      url: '/api/external-mcp/mcp',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: 'application/json, text/event-stream',
      },
      payload: { jsonrpc: '2.0', id: 7, method, ...(params === undefined ? {} : { params }) },
    });
  }

  it('supports initialize and advertises exactly the 16 stateless tools', async () => {
    const initialized = await call('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'Codex', version: '0.147.0' },
    });
    expect(initialized.statusCode).toBe(200);
    expect(initialized.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 7,
      result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } },
    });

    const listed = await call('tools/list');
    const tools = (listed.json() as { result: { tools: Array<Record<string, unknown>> } }).result
      .tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      'create_extraction_task',
      'read_extraction_task',
      'list_capabilities',
      'read_capability_definition',
      'list_agent_projects',
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
      'publish_agent_revision',
    ]);
    expect(tools).toHaveLength(16);
    const run = tools.find((tool) => tool.name === 'run_agent_test')!;
    expect((run.inputSchema as { required: string[] }).required).toContain('revisionId');
    const readUi = tools.find((tool) => tool.name === 'read_agent_ui')!;
    expect((readUi.inputSchema as { oneOf: unknown[] }).oneOf).toHaveLength(2);
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
  const query = vi.fn(async (sql: string) => {
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
    throw new Error(`unexpected SQL: ${sql}`);
  });

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.decorate('infra', {
      env: testEnv(),
      db: { query },
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
  });

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
    expect(query).not.toHaveBeenCalled();
  });
});
