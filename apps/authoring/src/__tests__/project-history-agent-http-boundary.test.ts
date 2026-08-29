import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../bootstrap/app.js';
import {
  createAgentPackageDraftHandler,
  projectHistoryErrorLogFields,
  renderAgentPackageDraftHandler,
} from '../modules/project-history-agent/handlers.js';
import { PROJECT_HISTORY_AGENT_ENDPOINTS } from '../modules/project-history-agent/routes.js';
import { externalMcpPublicOrigin, loadEnv } from '../platform/config/env.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({
    env: {
      ...loadEnv(),
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      PUBLIC_APP_ORIGINS: 'http://localhost',
      SESSION_COOKIE_SECURE: false,
      OTP_HMAC_SECRET: 'h'.repeat(32),
      RESEND_API_KEY: 'test-only-key',
      RESEND_FROM_EMAIL: 'login@example.test',
      RESEND_API_BASE_URL: 'http://127.0.0.1:9',
    },
    httpRateLimitStore: 'memory',
  });
});

afterAll(async () => {
  await app.close();
});

describe('Project-history Agent HTTP boundary', () => {
  it('keeps canonical share origin independent of PUBLIC_APP_ORIGINS ordering', () => {
    const canonical = 'https://mcp.combo.example';
    for (const PUBLIC_APP_ORIGINS of [
      'https://first.example,https://second.example',
      'https://second.example,https://first.example',
    ]) {
      const env = { ...loadEnv(), PUBLIC_APP_ORIGINS, EXTERNAL_MCP_PUBLIC_ORIGIN: canonical };
      expect(externalMcpPublicOrigin(env)).toBe(canonical);
    }
  });
  it('registers the five production API routes without treating them as MCP transport', () => {
    expect(PROJECT_HISTORY_AGENT_ENDPOINTS.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'POST /agent-package-drafts',
      'POST /agent-package-drafts/:draftId/render',
      'POST /agent-package-shares',
      'GET /agent-package-shares/:shareToken',
      'POST /agent-package-runs/prepare',
    ]);
    for (const endpoint of PROJECT_HISTORY_AGENT_ENDPOINTS) {
      expect(endpoint.onRequest?.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('requires trusted browser Origin and owner Session for Draft/share mutations', async () => {
    const withoutOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-package-drafts',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(withoutOrigin.statusCode).toBe(403);
    expect(withoutOrigin.headers['cache-control']).toBe('no-store');

    const withoutOwner = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-package-drafts',
      headers: {
        origin: 'http://localhost',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(withoutOwner.statusCode).toBe(401);
    expect(withoutOwner.headers['cache-control']).toBe('no-store');
  });

  it('keeps public-by-link API inputs strict without requiring a browser Origin', async () => {
    const token = 'A'.repeat(42);
    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-package-shares/${token}`,
    });
    expect(read.statusCode).toBe(404);
    for (const response of [read]) {
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers.pragma).toBe('no-cache');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    }

    const prepare = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-package-runs/prepare',
      headers: { 'content-type': 'application/json' },
      payload: {
        shareUrl: `http://localhost/api/v1/agent-package-shares/${'A'.repeat(43)}`,
        packageDigest: `sha256:${'a'.repeat(64)}`,
        starterOrdinal: 1,
        starterPrompt: 'extra',
        creatorProjectPath: '/must-not-enter',
      },
    });
    expect(prepare.statusCode).toBe(400);
    expect(prepare.headers['cache-control']).toBe('private, no-store');
    expect(prepare.headers.pragma).toBe('no-cache');
    expect(prepare.headers['referrer-policy']).toBe('no-referrer');
    expect(prepare.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(prepare.headers['x-content-type-options']).toBe('nosniff');
  });

  it.each([
    ['projectId', 'private-project'],
    ['rawTranscript', 'private transcript'],
    ['confirmationToken', `cfrm_${'S'.repeat(43)}`],
  ])('rejects render body extra %s before any confirmation persistence', async (field, value) => {
    let queryCount = 0;
    const req = {
      id: 'trace-render-strict',
      auth: { userId: '00000000-0000-4000-8000-000000000029' },
      params: { draftId: `draft.agent-package.${'a'.repeat(32)}` },
      body: {
        draftFingerprint: `sha256:${'b'.repeat(64)}`,
        [field]: value,
      },
      log: { error: () => undefined },
      server: {
        infra: {
          env: { ...loadEnv(), EXTERNAL_MCP_PUBLIC_ORIGIN: 'http://localhost' },
          db: {
            query: async () => {
              queryCount += 1;
              throw new Error('strict render input must not reach PostgreSQL');
            },
          },
        },
      },
    } as unknown as FastifyRequest;
    const reply = makeReply();

    await renderAgentPackageDraftHandler().call(req.server, req, reply);

    expect(reply.statusCode).toBe(400);
    expect(queryCount).toBe(0);
  });

  it('maps deterministic Package/launch preflight failures to validation before Draft writes', async () => {
    let queryCount = 0;
    const req = {
      id: 'trace-create-preflight',
      auth: { userId: '00000000-0000-4000-8000-000000000029' },
      body: {
        creatorRequest: '把这个 Project 里以前完成过的方法做成一个 Agent。',
        candidate: {
          name: 'HTTP 证据核验员',
          description: '通过 HTTP 边界核验。',
          instructions: '只读分析当前 Project 的用户材料，然后返回证据。',
          starterPrompts: ['检查 schemaVersion 字段。'],
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
          discoveredThreadCount: 1,
          readThreadCount: 1,
          omittedThreadCount: 0,
          completedTurnCount: 1,
          userVisibleMessageCount: 1,
          omittedItemCount: 0,
          limitationReasons: [
            'READ_OUTPUT_BOUNDED_OR_TRUNCATED',
            'READ_THREAD_SUMMARY_NOT_RAW_TRANSCRIPT',
            'THREAD_LIST_GLOBAL_COVERAGE_NOT_ATTESTED',
          ],
        },
        idempotencyKey: '10000000-0000-4000-8000-000000000099',
      },
      log: { error: () => undefined },
      server: {
        infra: {
          env: { ...loadEnv(), EXTERNAL_MCP_PUBLIC_ORIGIN: 'http://localhost' },
          db: {
            query: async () => {
              queryCount += 1;
              throw new Error('preflight failure must not reach PostgreSQL');
            },
          },
        },
      },
    } as unknown as FastifyRequest;
    const reply = makeReply();

    await createAgentPackageDraftHandler().call(req.server, req, reply);

    expect(reply.statusCode).toBe(400);
    expect(queryCount).toBe(0);
  });

  it('rejects hidden query fields on every Project-history endpoint before any write or read', async () => {
    const query = vi
      .spyOn(app.infra.db, 'query')
      .mockRejectedValue(new Error('strict query boundary must not reach PostgreSQL') as never);
    const cases = [
      {
        method: 'POST' as const,
        url: '/api/v1/agent-package-drafts?projectId=private-project',
        payload: {},
        publicHeaders: false,
      },
      {
        method: 'POST' as const,
        url: `/api/v1/agent-package-drafts/draft.agent-package.${'a'.repeat(32)}/render?rawTranscript=private`,
        payload: { draftFingerprint: `sha256:${'b'.repeat(64)}` },
        publicHeaders: false,
      },
      {
        method: 'POST' as const,
        url: '/api/v1/agent-package-shares?confirmationToken=private',
        payload: {},
        publicHeaders: false,
      },
      {
        method: 'GET' as const,
        url: `/api/v1/agent-package-shares/${'A'.repeat(43)}?packageDigest=hidden`,
        publicHeaders: true,
      },
      {
        method: 'POST' as const,
        url: '/api/v1/agent-package-runs/prepare?packageDigest=hidden',
        payload: {},
        publicHeaders: true,
      },
    ];
    try {
      for (const input of cases) {
        const response = await app.inject({
          method: input.method,
          url: input.url,
          headers: {
            origin: 'http://localhost',
            'sec-fetch-site': 'same-origin',
            'content-type': 'application/json',
          },
          ...('payload' in input ? { payload: input.payload } : {}),
        });
        expect(response.statusCode, input.url).toBe(400);
        expect(response.headers['cache-control']).toBe(
          input.publicHeaders ? 'private, no-store' : 'no-store',
        );
        if (input.publicHeaders) {
          expect(response.headers['referrer-policy']).toBe('no-referrer');
          expect(response.headers['x-robots-tag']).toBe('noindex, nofollow');
          expect(response.headers['x-content-type-options']).toBe('nosniff');
        }
      }
      expect(query).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
    }
  });

  it('logs only a fixed category, trace, and allowlisted database metadata', () => {
    const secret = 'cfrm_SUPER_SECRET_CONFIRMATION_TOKEN';
    const rawTranscript = 'raw transcript from private project';
    const fields = projectHistoryErrorLogFields('trace-safe', {
      code: '23514',
      constraint: 'untrusted_constraint_with_private_name',
      detail: `Failing row contains ${secret} and ${rawTranscript}`,
      body: { confirmationToken: secret },
      cause: new Error(rawTranscript),
    });

    expect(fields).toEqual({
      category: 'project_history_agent_request_failed',
      traceId: 'trace-safe',
      sqlState: '23514',
    });
    expect(JSON.stringify(fields)).not.toContain(secret);
    expect(JSON.stringify(fields)).not.toContain(rawTranscript);
  });
});

function makeReply(): FastifyReply & { statusCode: number; body?: unknown } {
  const reply = {
    statusCode: 0,
    body: undefined as unknown,
    code(statusCode: number) {
      this.statusCode = statusCode;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return reply as unknown as FastifyReply & { statusCode: number; body?: unknown };
}
