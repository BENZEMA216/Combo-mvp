import { createHash } from 'node:crypto';
import { connect } from 'node:net';

import { SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { serializeAgentPackageShareV2 } from '@cb/creator-agent-protocol/agent-package-share';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../bootstrap/app.js';
import {
  InMemoryProjectHistoryAgentRepository,
  createProjectHistoryAgentService,
} from '../modules/project-history-agent/service.js';
import { loadEnv } from '../platform/config/env.js';
import { createSafeTraceExporter } from '../platform/observability/node.js';

const OWNER = '00000000-0000-4000-8000-000000000029';
const SHARE_IDEMPOTENCY_KEY = '20000000-0000-4000-8000-000000000029';

describe('Project-history public capability URL security', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let logOutput = '';
  let shareUrl = '';
  let packageDigest = '';
  let shareRow: Record<string, unknown>;
  let repoFailure = false;
  let listenPort = 0;
  let shareReadCount = 0;

  beforeAll(async () => {
    let fill = 1;
    const service = createProjectHistoryAgentService({
      repository: new InMemoryProjectHistoryAgentRepository(),
      publicOrigin: 'http://localhost',
      clock: { now: () => new Date('2026-08-29T00:00:00.000Z') },
      randomBytes: (size) => Buffer.alloc(size, fill++),
    });
    const created = await service.createDraft(OWNER, {
      creatorRequest: '把这个 Project 里以前完成过的方法做成一个 Agent。',
      candidate: {
        name: '公开链接核验员',
        description: '核验 link-only 安全边界。',
        instructions: '只读核验当前 Project 的可见证据。',
        starterPrompts: ['检查公开链接。'],
        outputDescription: '返回结论与边界。',
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
        completedTurnCount: 2,
        userVisibleMessageCount: 4,
        omittedItemCount: 1,
        limitationReasons: [
          'READ_OUTPUT_BOUNDED_OR_TRUNCATED',
          'READ_THREAD_SUMMARY_NOT_RAW_TRANSCRIPT',
          'THREAD_LIST_GLOBAL_COVERAGE_NOT_ATTESTED',
        ],
      },
      idempotencyKey: '10000000-0000-4000-8000-000000000029',
    });
    const rendered = await service.renderDraft(OWNER, {
      draftId: created.draft.draftId,
      draftFingerprint: created.draft.draftFingerprint,
    });
    const shared = await service.createShare(OWNER, {
      draftId: created.draft.draftId,
      draftFingerprint: created.draft.draftFingerprint,
      confirmationToken: rendered.confirmation.confirmationToken,
      idempotencyKey: SHARE_IDEMPOTENCY_KEY,
    });
    shareUrl = shared.shareUrl;
    packageDigest = shared.packageDigest;
    const token = new URL(shareUrl).pathname.split('/').at(-1)!;
    const confirmationTokenDigest = createHash('sha256')
      .update(rendered.confirmation.confirmationToken, 'utf8')
      .digest('hex');
    const requestFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          draftId: created.draft.draftId,
          draftFingerprint: created.draft.draftFingerprint,
          confirmationTokenDigest,
        }),
        'utf8',
      )
      .digest('hex');
    const shareJson = serializeAgentPackageShareV2(shared.share);
    shareRow = {
      share_token: token,
      owner_user_id: OWNER,
      draft_id: created.draft.draftId,
      source_draft_fingerprint: created.draft.draftFingerprint,
      confirmation_token_sha256: confirmationTokenDigest,
      package_digest: shared.packageDigest,
      idempotency_key: SHARE_IDEMPOTENCY_KEY,
      request_fingerprint: requestFingerprint,
      share_url: shared.shareUrl,
      share_json: shareJson,
      share_json_sha256: createHash('sha256').update(shareJson, 'utf8').digest('hex'),
      copy_prompt: shared.copyPrompt,
    };

    app = await buildApp({
      env: {
        ...loadEnv(),
        NODE_ENV: 'test',
        LOG_LEVEL: 'info',
        PUBLIC_APP_ORIGINS: 'http://localhost',
        EXTERNAL_MCP_PUBLIC_ORIGIN: 'http://localhost',
        SESSION_COOKIE_SECURE: false,
        OTP_HMAC_SECRET: 'h'.repeat(32),
        RESEND_API_KEY: 'test-only-key',
        RESEND_FROM_EMAIL: 'login@example.test',
        RESEND_API_BASE_URL: 'http://127.0.0.1:9',
      },
      httpRateLimitStore: 'memory',
      loggerStream: { write: (chunk: string) => (logOutput += chunk) },
    });
    vi.spyOn(app.infra.db, 'query').mockImplementation(async (sql, params) => {
      if (String(sql).includes('FROM project_history_agent_shares')) {
        shareReadCount += 1;
        if (repoFailure) {
          const error = new Error(`failing row has ${new URL(shareUrl).pathname}`) as Error & {
            code: string;
            detail: string;
          };
          error.code = '23514';
          error.detail = `private transcript plus ${shareUrl}`;
          throw error;
        }
        return {
          rows: params?.[0] === shareRow.share_token ? [shareRow] : [],
          rowCount: params?.[0] === shareRow.share_token ? 1 : 0,
        } as never;
      }
      throw new Error('unexpected public-link test SQL category');
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    listenPort = Number(new URL(address).port);
  });

  afterAll(async () => {
    await app?.close();
  });

  function expectPublicHeaders(headers: Record<string, string | string[] | number | undefined>) {
    expect(headers['cache-control']).toBe('private, no-store');
    expect(headers.pragma).toBe('no-cache');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(headers['x-content-type-options']).toBe('nosniff');
  }

  it('reads the immutable Package from the link alone and returns the authoritative digest', async () => {
    const response = await app.inject({ method: 'GET', url: new URL(shareUrl).pathname });
    expect(response.statusCode).toBe(200);
    expectPublicHeaders(response.headers);
    expect(response.json().data).toMatchObject({ shareUrl, packageDigest });
    expect(response.json().data.package).toEqual(response.json().data.share.package);
  });

  it.each([
    ['hidden digest', '?packageDigest=hidden'],
    ['unknown query', '?unexpected=value'],
    ['duplicate query', '?unexpected=one&unexpected=two'],
  ])(
    'rejects a valid capability path with %s instead of canonicalizing it',
    async (_name, suffix) => {
      const response = await app.inject({
        method: 'GET',
        url: `${new URL(shareUrl).pathname}${suffix}`,
      });
      expect(response.statusCode).not.toBe(200);
      expectPublicHeaders(response.headers);
    },
  );

  it.each(['?', '#', '?#'])(
    'rejects the raw request-target suffix %s instead of losing it during URL parsing',
    async (suffix) => {
      const response = await rawHttpGet(listenPort, `${new URL(shareUrl).pathname}${suffix}`);
      expect(response.statusCode).not.toBe(200);
      expectPublicHeaders(response.headers);
    },
  );

  it('rejects a GET request body before reading or materializing the public capability', async () => {
    const sentinel = 'rawTranscript=PRIVATE_GET_BODY_SENTINEL&packageDigest=hidden';
    const readsBefore = shareReadCount;
    const response = await rawHttpRequest(
      listenPort,
      new URL(shareUrl).pathname,
      sentinel,
      'application/json',
    );
    expect(response.statusCode).toBe(400);
    expectPublicHeaders(response.headers);
    expect(shareReadCount).toBe(readsBefore);
    expect(logOutput).not.toContain('PRIVATE_GET_BODY_SENTINEL');
  });

  it('rejects non-canonical percent encoding of an otherwise valid capability token', async () => {
    const path = new URL(shareUrl).pathname;
    const tokenStart = path.lastIndexOf('/') + 1;
    const encoded = `${path.slice(0, tokenStart)}%${path.charCodeAt(tokenStart).toString(16)}${path.slice(
      tokenStart + 1,
    )}`;
    const response = await app.inject({ method: 'GET', url: encoded });
    expect(response.statusCode).not.toBe(200);
    expectPublicHeaders(response.headers);
  });

  it('prepares a run from the public link plus the authoritative digest with protected headers', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-package-runs/prepare',
      payload: {
        shareUrl,
        packageDigest,
        starterOrdinal: 1,
        starterPrompt: '检查公开链接。',
      },
    });
    expect(response.statusCode).toBe(200);
    expectPublicHeaders(response.headers);
    expect(response.json().data).toMatchObject({
      shareUrl,
      packageDigest,
      starterOrdinal: 1,
      starterPrompt: '检查公开链接。',
    });
  });

  it('returns a protected 404 for a different high-entropy token', async () => {
    const tamperedToken = 'Z'.repeat(43);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/agent-package-shares/${tamperedToken}`,
    });
    expect(response.statusCode).toBe(404);
    expectPublicHeaders(response.headers);
    expect(logOutput).not.toContain(tamperedToken);
  });

  it('does not serialize a capability token from repository errors or completion logs', async () => {
    repoFailure = true;
    const response = await app.inject({ method: 'GET', url: new URL(shareUrl).pathname });
    repoFailure = false;
    expect(response.statusCode).toBe(500);
    expectPublicHeaders(response.headers);

    const token = new URL(shareUrl).pathname.split('/').at(-1)!;
    expect(logOutput).not.toContain(token);
    expect(logOutput).not.toContain(shareUrl);
    expect(logOutput).not.toContain('private transcript');
    expect(logOutput).toContain('/api/v1/agent-package-shares/:shareToken');
  });

  it('templates capability tokens in exported span names, attributes, and events', async () => {
    const memory = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(createSafeTraceExporter(memory))],
    });
    const token = new URL(shareUrl).pathname.split('/').at(-1)!;
    const encodeCharacter = (value: string, index: number, uppercase: boolean) => {
      const encoded = value.charCodeAt(index).toString(16).padStart(2, '0');
      return `${value.slice(0, index)}%${uppercase ? encoded.toUpperCase() : encoded}${value.slice(
        index + 1,
      )}`;
    };
    const encodedTokens = [
      encodeCharacter(token, 0, true),
      encodeCharacter(encodeCharacter(token, 0, false), 4, false),
      encodeCharacter(token, 1, false),
    ];
    const encodePathLayers = (value: string, layers: number) => {
      let encoded = value;
      for (let layer = 0; layer < layers; layer += 1) encoded = encodeURIComponent(encoded);
      return `/${encoded}`;
    };
    const suffixTokens = [`${token};matrix`, `${token}.x`, `${token},x`];
    const encodedRoutePaths = [
      `/api%2Fv1%2Fagent-package-shares%2F${token}`,
      `/%61pi%2fv1%2fagent-package-shares%2f${token}`,
      `/api%252Fv1%252Fagent-package-shares%252F${token}`,
      `/api%2Fv1%2Fagent-package-shares%2F${token}%`,
      `/API/V1/AGENT-PACKAGE-SHARES/${token}`,
      encodePathLayers(`/api/v1/agent-package-shares/${token}`, 4),
      encodePathLayers(`/API/v1/Agent-Package-Shares/${token}`, 5).replace(/2F/gu, '2f'),
      encodePathLayers(`/%61pi%2fv1%2fagent-package-shares%2f${token}`, 12),
      encodePathLayers(`/%61pi%2fv1%2fagent-package-shares%2f${token}`, 40),
      `${'x'.repeat(20_000)}${encodePathLayers(`/api/v1/agent-package-shares/${token}`, 4)}`,
    ];
    const sensitivePaths = [
      ...[token, ...encodedTokens, ...suffixTokens].map(
        (pathToken) => `/api/v1/agent-package-shares/${pathToken}`,
      ),
      ...encodedRoutePaths,
    ];
    for (const sensitivePath of sensitivePaths) {
      const path = `${sensitivePath}?failed=1`;
      const span = provider.getTracer('project-history-link').startSpan(`GET ${path}`);
      span.setAttribute('http.route', path);
      span.setAttribute('url.path', path);
      span.setAttribute('http.request.body', 'PRIVATE_GET_BODY_SENTINEL');
      span.addEvent(`lookup ${path}`, { 'db.operation.name': path });
      span.addLink({ context: span.spanContext(), attributes: { 'db.query.summary': path } });
      span.setStatus({ code: SpanStatusCode.ERROR, message: path });
      span.end();
    }
    await provider.forceFlush();

    const serialized = JSON.stringify(
      memory.getFinishedSpans().map(({ name, attributes, events, links, status }) => ({
        name,
        attributes,
        events,
        links,
        status,
      })),
    );
    for (const sensitive of [
      token,
      ...encodedTokens,
      ...suffixTokens,
      ...encodedRoutePaths,
      'PRIVATE_GET_BODY_SENTINEL',
    ]) {
      expect(serialized).not.toContain(sensitive);
    }
    expect(serialized).toContain(':shareToken');
    await provider.shutdown();
  });

  it('enforces bounded runtime budgets on both public-by-link routes without logging the token', async () => {
    let readLimited: Awaited<ReturnType<typeof app.inject>> | undefined;
    for (let attempt = 0; attempt < 130 && !readLimited; attempt += 1) {
      const response = await app.inject({ method: 'GET', url: new URL(shareUrl).pathname });
      if (response.statusCode === 429) readLimited = response;
    }
    expect(readLimited?.statusCode).toBe(429);
    expectPublicHeaders(readLimited?.headers ?? {});

    let prepareLimited: Awaited<ReturnType<typeof app.inject>> | undefined;
    for (let attempt = 0; attempt < 70 && !prepareLimited; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/agent-package-runs/prepare',
        payload: {
          shareUrl,
          packageDigest,
          starterOrdinal: 1,
          starterPrompt: '检查公开链接。',
        },
      });
      if (response.statusCode === 429) prepareLimited = response;
    }
    expect(prepareLimited?.statusCode).toBe(429);
    expectPublicHeaders(prepareLimited?.headers ?? {});

    const token = new URL(shareUrl).pathname.split('/').at(-1)!;
    expect(logOutput).not.toContain(token);
    expect(logOutput).not.toContain(shareUrl);
  });
});

async function rawHttpGet(
  port: number,
  target: string,
): Promise<{ statusCode: number; headers: Record<string, string> }> {
  return rawHttpRequest(port, target);
}

async function rawHttpRequest(
  port: number,
  target: string,
  body = '',
  contentType?: string,
): Promise<{ statusCode: number; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let response = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      const bodyHeaders = body
        ? `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\nContent-Type: ${contentType ?? 'application/octet-stream'}\r\n`
        : '';
      socket.end(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${bodyHeaders}Connection: close\r\n\r\n${body}`,
      );
    });
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.on('error', reject);
    socket.on('end', () => {
      const [head = ''] = response.split('\r\n\r\n', 1);
      const lines = head.split('\r\n');
      const statusCode = Number(/^HTTP\/1\.1 (\d{3})/u.exec(lines.shift() ?? '')?.[1]);
      const headers = Object.fromEntries(
        lines.map((line) => {
          const separator = line.indexOf(':');
          return [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()];
        }),
      );
      resolve({ statusCode, headers });
    });
  });
}
