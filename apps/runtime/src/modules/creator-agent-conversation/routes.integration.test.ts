import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { VnextErrorResponseSchema, type VnextErrorResponse } from '@cb/creator-agent-protocol';
import { authSessionCookieName } from '@cb/shared';
import { describe, expect, it } from 'vitest';

// VNext registry case: SCH-005 (actual route response/log/authority remains canary-free).
import { ALWAYS_ENABLED_ENDPOINTS, registerBusinessRoutes } from '../../bootstrap/routes.js';
import { loadEnv, type Env } from '../../platform/config/env.js';
import { RUNTIME_HTTP_BODY_LIMIT_BYTES } from '../../platform/http/vnext-json-body.js';
import type { QueryResultLike, RuntimeDb, TxConn } from '../../platform/infra/db.js';

const SESSION_TOKEN = `s1.${'A'.repeat(43)}`;
const CONSUMER = '01900000-0000-7000-8000-000000000001';
const BASE_ENV = loadEnv();

function env(enabled: boolean): Env {
  return {
    ...BASE_ENV,
    NODE_ENV: 'test',
    CREATOR_AGENT_PUBLIC_ENABLED: enabled,
    CREATOR_AGENT_DATABASE_URL: enabled ? 'postgres://agent.invalid/agent' : undefined,
    PUBLIC_APP_ORIGINS: 'http://combo.test',
    SESSION_COOKIE_SECURE: false,
  };
}

interface DbCounters {
  authQueries: number;
  directQueries: number;
  connects: number;
  createConversationCalls: number;
  outboxMutations: number;
}

function emptyDbCounters(): DbCounters {
  return {
    authQueries: 0,
    directQueries: 0,
    connects: 0,
    createConversationCalls: 0,
    outboxMutations: 0,
  };
}

function db(
  options: { auth?: 'valid' | 'invalid' | 'error'; repositoryError?: Error } = {},
  counters?: DbCounters,
): RuntimeDb {
  return {
    async query<R>(sql: string) {
      if (sql.includes('FROM auth_sessions')) {
        if (counters) counters.authQueries += 1;
        if (options.auth === 'error') throw new Error('auth database unavailable');
        if (options.auth !== 'valid') return { rows: [] as R[], rowCount: 0 };
        return {
          rows: [
            {
              session_id: '01900000-0000-7000-8000-000000000002',
              user_id: CONSUMER,
              account: 'consumer-route-test',
              roles: ['creator'],
              disabled_at: null,
            },
          ] as R[],
          rowCount: 1,
        };
      }
      if (counters) counters.directQueries += 1;
      if (options.repositoryError) throw options.repositoryError;
      return { rows: [] as R[], rowCount: 0 };
    },
    async connect(): Promise<TxConn> {
      if (counters) counters.connects += 1;
      if (options.repositoryError) throw options.repositoryError;
      if (counters) {
        return {
          async query<R>(sql: string): Promise<QueryResultLike<R>> {
            if (sql.includes('creator_agent_create_opening_conversation_v2')) {
              counters.createConversationCalls += 1;
              counters.outboxMutations += 1;
            }
            return { rows: [] as R[], rowCount: 0 };
          },
          release: () => undefined,
        };
      }
      throw new Error('repository connection was not expected');
    },
  };
}

async function appFor(input: {
  enabled: boolean;
  auth?: 'valid' | 'invalid' | 'error';
  repositoryError?: Error;
  capturedParsedBodies?: unknown[];
  dbCounters?: DbCounters;
  logLines?: string[];
  legacyParserProbe?: boolean;
}) {
  const app = Fastify({
    bodyLimit: RUNTIME_HTTP_BODY_LIMIT_BYTES,
    logger:
      input.logLines === undefined
        ? false
        : {
            level: 'trace',
            stream: { write: (line: string) => input.logLines!.push(line) },
          },
    disableRequestLogging: true,
    genReqId: () => 'route-test-request-0001',
  });
  await app.register(cookie);
  app.addHook('preHandler', async (request) => {
    input.capturedParsedBodies?.push(structuredClone(request.body));
  });
  const runtimeDb = db(input, input.dbCounters);
  app.decorate('infra', {
    env: env(input.enabled),
    db: runtimeDb,
    creatorAgentDb: input.enabled ? runtimeDb : null,
  } as never);
  if (input.legacyParserProbe) {
    app.post('/legacy-parser-probe', async (request) => request.body);
  }
  await registerBusinessRoutes(app);
  await app.ready();
  return app;
}

async function postRawJson(
  app: Awaited<ReturnType<typeof appFor>>,
  body: Buffer,
  path = '/v1/public/agents/research-agent/conversations',
  headerOverrides: Record<string, string> = {},
  declaredContentLength = body.byteLength,
): Promise<{ statusCode: number; body: string }> {
  if (!app.server.listening) await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: address.port,
        method: 'POST',
        path,
        headers: {
          ...validHeaders(headerOverrides),
          'content-length': String(declaredContentLength),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

function parseVnextError(body: string): VnextErrorResponse {
  return VnextErrorResponseSchema.parse(JSON.parse(body));
}

function validHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    origin: 'http://combo.test',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    'idempotency-key': '550e8400-e29b-41d4-a716-446655440000',
    cookie: `${authSessionCookieName(false)}=${SESSION_TOKEN}`,
    ...overrides,
  };
}

describe('VNext Consumer route registration and wire errors', () => {
  it('keeps the public route absent when the feature flag is false', async () => {
    const app = await appFor({ enabled: false });
    try {
      expect(app.hasRoute({ method: 'POST', url: '/v1/public/agents/:slug/conversations' })).toBe(
        false,
      );
      expect(ALWAYS_ENABLED_ENDPOINTS).toHaveLength(11);
      const response = await app.inject({
        method: 'POST',
        url: '/v1/public/agents/research-agent/conversations',
        headers: validHeaders(),
        payload: {},
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('registers the route only when enabled and rejects a missing origin in VNext shape', async () => {
    const app = await appFor({ enabled: true });
    try {
      expect(app.hasRoute({ method: 'POST', url: '/v1/public/agents/:slug/conversations' })).toBe(
        true,
      );
      const response = await app.inject({
        method: 'POST',
        url: '/v1/public/agents/research-agent/conversations',
        headers: validHeaders({ origin: '' }),
        payload: {},
      });
      expect(response.statusCode).toBe(403);
      expect(parseVnextError(response.body).code).toBe('FORBIDDEN');
    } finally {
      await app.close();
    }
  });

  it.each([
    ['missing Cookie', validHeaders({ cookie: '' }), 'UNAUTHORIZED'],
    [
      'alternate bearer credential',
      validHeaders({ authorization: 'Bearer forbidden' }),
      'UNAUTHORIZED',
    ],
    ['missing Idempotency-Key', validHeaders({ 'idempotency-key': '' }), 'INVALID_INPUT'],
    [
      'server UUIDv7 Idempotency-Key',
      validHeaders({ 'idempotency-key': '01900000-0000-7000-8000-000000000008' }),
      'INVALID_INPUT',
    ],
    [
      'uppercase UUIDv4 Idempotency-Key',
      validHeaders({ 'idempotency-key': '550E8400-E29B-41D4-A716-446655440000' }),
      'INVALID_INPUT',
    ],
  ] as const)('returns a strict VNext error for %s', async (_name, headers, expectedCode) => {
    const app = await appFor({ enabled: true, auth: 'valid' });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/public/agents/research-agent/conversations',
        headers,
        payload: {},
      });
      expect(parseVnextError(response.body).code).toBe(expectedCode);
    } finally {
      await app.close();
    }
  });

  it('rejects an absent body and unknown request fields as INVALID_INPUT', async () => {
    const app = await appFor({ enabled: true, auth: 'valid' });
    try {
      const absent = await app.inject({
        method: 'POST',
        url: '/v1/public/agents/research-agent/conversations',
        headers: validHeaders({ 'content-type': '' }),
      });
      expect(absent.statusCode).toBe(400);
      expect(parseVnextError(absent.body).code).toBe('INVALID_INPUT');

      const unknown = await app.inject({
        method: 'POST',
        url: '/v1/public/agents/research-agent/conversations',
        headers: validHeaders(),
        payload: { unexpected: true },
      });
      expect(unknown.statusCode).toBe(400);
      expect(parseVnextError(unknown.body).code).toBe('INVALID_INPUT');
    } finally {
      await app.close();
    }
  });

  it('maps malformed JSON and an authentication dependency failure to the frozen wire schema', async () => {
    const malformedApp = await appFor({ enabled: true });
    try {
      const malformed = await malformedApp.inject({
        method: 'POST',
        url: '/v1/public/agents/research-agent/conversations',
        headers: validHeaders(),
        payload: '{',
      });
      expect(malformed.statusCode).toBe(400);
      expect(parseVnextError(malformed.body).code).toBe('INVALID_INPUT');
    } finally {
      await malformedApp.close();
    }

    const authFailureApp = await appFor({ enabled: true, auth: 'error' });
    try {
      const unavailable = await authFailureApp.inject({
        method: 'POST',
        url: '/v1/public/agents/research-agent/conversations',
        headers: validHeaders(),
        payload: {},
      });
      expect(unavailable.statusCode).toBe(503);
      expect(parseVnextError(unavailable.body).code).toBe('AGENT_OFFLINE');
    } finally {
      await authFailureApp.close();
    }
  });

  it('rejects duplicate raw JSON before Fastify exposes a last-wins body to preHandlers', async () => {
    const capturedParsedBodies: unknown[] = [];
    const app = await appFor({ enabled: true, auth: 'valid', capturedParsedBodies });
    try {
      const response = await postRawJson(
        app,
        Buffer.from('{"unexpected":1,"unexpected":2}', 'utf8'),
        '/v1/public/agents/research-agent/conversations',
        { 'content-type': 'application/json; charset=utf-8' },
      );
      expect(response.statusCode).toBe(400);
      expect(parseVnextError(response.body).code).toBe('INVALID_INPUT');
      expect(capturedParsedBodies).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('keeps the fatal duplicate parser encapsulated away from a legacy sibling', async () => {
    const app = await appFor({ enabled: true, auth: 'valid', legacyParserProbe: true });
    const duplicate = Buffer.from('{"value":1,"value":2}', 'utf8');
    try {
      const legacy = await postRawJson(app, duplicate, '/legacy-parser-probe');
      expect(legacy.statusCode).toBe(200);
      expect(JSON.parse(legacy.body)).toEqual({ value: 2 });

      const vnext = await postRawJson(app, duplicate);
      expect(vnext.statusCode).toBe(400);
      expect(parseVnextError(vnext.body).code).toBe('INVALID_INPUT');
    } finally {
      await app.close();
    }
  });

  it('freezes the VNext media type and Content-Encoding before auth or PG', async () => {
    const capturedParsedBodies: unknown[] = [];
    const dbCounters = emptyDbCounters();
    const logLines: string[] = [];
    const app = await appFor({
      enabled: true,
      auth: 'valid',
      capturedParsedBodies,
      dbCounters,
      logLines,
    });
    const body = Buffer.from('{"HEADER_CONTRACT_CANARY":true}', 'utf8');
    const accepted = [
      { id: 'bare', headers: { 'content-type': 'application/json' } },
      { id: 'case-insensitive', headers: { 'content-type': 'Application/JSON' } },
      {
        id: 'ows-charset',
        headers: { 'content-type': 'application/json;  charset = UTF-8' },
      },
      {
        id: 'quoted-charset-identity',
        headers: {
          'content-type': 'application/json;charset="utf-8"',
          'content-encoding': 'IDENTITY',
        },
      },
    ] as const;
    const rejected = [
      { id: 'utf16', headers: { 'content-type': 'application/json; charset=utf-16' } },
      {
        id: 'duplicate-charset',
        headers: { 'content-type': 'application/json; charset=utf-8; charset=utf-8' },
      },
      {
        id: 'conflicting-charset',
        headers: { 'content-type': 'application/json; charset=utf-8; charset=utf-16' },
      },
      { id: 'unknown-parameter', headers: { 'content-type': 'application/json; profile=vnext' } },
      { id: 'text-plain', headers: { 'content-type': 'text/plain' } },
      { id: 'suffix-json', headers: { 'content-type': 'application/merge-patch+json' } },
      {
        id: 'gzip',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      },
    ] as const;

    try {
      for (const testCase of accepted) {
        const before = capturedParsedBodies.length;
        const response = await postRawJson(
          app,
          body,
          '/v1/public/agents/research-agent/conversations',
          testCase.headers,
        );
        expect(response.statusCode, testCase.id).toBe(400);
        expect(parseVnextError(response.body).code, testCase.id).toBe('INVALID_INPUT');
        expect(response.body, testCase.id).not.toContain('HEADER_CONTRACT_CANARY');
        expect(capturedParsedBodies, testCase.id).toHaveLength(before + 1);
      }
      for (const testCase of rejected) {
        const before = capturedParsedBodies.length;
        const response = await postRawJson(
          app,
          body,
          '/v1/public/agents/research-agent/conversations',
          testCase.headers,
        );
        expect(response.statusCode, testCase.id).toBe(400);
        expect(parseVnextError(response.body).code, testCase.id).toBe('INVALID_INPUT');
        expect(response.body, testCase.id).not.toContain('HEADER_CONTRACT_CANARY');
        expect(capturedParsedBodies, testCase.id).toHaveLength(before);
      }
      expect(dbCounters).toEqual(emptyDbCounters());
      expect(logLines.join('\n')).not.toContain('HEADER_CONTRACT_CANARY');
    } finally {
      await app.close();
    }
  });

  it('rejects the raw hostile matrix with no auth, PG, Outbox, response, or log leakage', async () => {
    const capturedParsedBodies: unknown[] = [];
    const dbCounters = emptyDbCounters();
    const logLines: string[] = [];
    const app = await appFor({
      enabled: true,
      auth: 'valid',
      capturedParsedBodies,
      dbCounters,
      logLines,
    });
    const malformedUtf8 = ['80', 'c0af', 'e282', 'eda080', 'f4908080'] as const;
    const parserCases: Array<{ id: string; canary: string; bytes: Buffer }> = malformedUtf8.map(
      (hex) => {
        const canary = `RAW_MALFORMED_${hex}_CANARY`;
        return {
          id: `malformed-${hex}`,
          canary,
          bytes: Buffer.concat([
            Buffer.from(`{"${canary}":"`, 'utf8'),
            Buffer.from(hex, 'hex'),
            Buffer.from('"}', 'utf8'),
          ]),
        };
      },
    );
    parserCases.push(
      {
        id: 'bom',
        canary: 'RAW_BOM_CANARY',
        bytes: Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from('{"RAW_BOM_CANARY":true}', 'utf8'),
        ]),
      },
      {
        id: 'root-duplicate',
        canary: 'RAW_ROOT_DUPLICATE_CANARY',
        bytes: Buffer.from('{"RAW_ROOT_DUPLICATE_CANARY":1,"RAW_ROOT_DUPLICATE_CANARY":2}', 'utf8'),
      },
      {
        id: 'nested-duplicate',
        canary: 'RAW_NESTED_DUPLICATE_CANARY',
        bytes: Buffer.from(
          '{"outer":{"RAW_NESTED_DUPLICATE_CANARY":1,"RAW_NESTED_DUPLICATE_CANARY":2}}',
          'utf8',
        ),
      },
      {
        id: 'syntax',
        canary: 'RAW_SYNTAX_CANARY',
        bytes: Buffer.from('{"RAW_SYNTAX_CANARY":', 'utf8'),
      },
    );

    const structuredCases = [
      ['escaped-high-surrogate', 'RAW_HIGH_CANARY', '{"RAW_HIGH_CANARY":"\\ud800"}', false],
      ['escaped-low-surrogate', 'RAW_LOW_CANARY', '{"RAW_LOW_CANARY":"\\udc00"}', false],
      ['escaped-nul', 'RAW_NUL_CANARY', '{"RAW_NUL_CANARY":"\\u0000"}', true],
      ['escaped-c0', 'RAW_C0_CANARY', '{"RAW_C0_CANARY":"\\u001f"}', true],
      ['escaped-del', 'RAW_DEL_CANARY', '{"RAW_DEL_CANARY":"\\u007f"}', true],
      ['escaped-c1', 'RAW_C1_CANARY', '{"RAW_C1_CANARY":"\\u009f"}', true],
      ['unknown-key', 'RAW_UNKNOWN_CANARY', '{"RAW_UNKNOWN_CANARY":"safe"}', true],
    ] as const;

    try {
      for (const testCase of parserCases) {
        const before = capturedParsedBodies.length;
        const response = await postRawJson(app, testCase.bytes);
        expect(response.statusCode, testCase.id).toBe(400);
        expect(parseVnextError(response.body).code, testCase.id).toBe('INVALID_INPUT');
        expect(response.body, testCase.id).not.toContain(testCase.canary);
        expect(capturedParsedBodies, testCase.id).toHaveLength(before);
      }

      for (const [id, canary, json, reachesBodySchema] of structuredCases) {
        const before = capturedParsedBodies.length;
        const response = await postRawJson(app, Buffer.from(json, 'utf8'));
        expect(response.statusCode, id).toBe(400);
        expect(parseVnextError(response.body).code, id).toBe('INVALID_INPUT');
        expect(response.body, id).not.toContain(canary);
        expect(capturedParsedBodies, id).toHaveLength(before + (reachesBodySchema ? 1 : 0));
      }

      const oversizeCanary = 'RAW_OVERSIZE_CANARY';
      const prefix = Buffer.from(`{"${oversizeCanary}":true}`, 'utf8');
      const beforeOversized = capturedParsedBodies.length;
      const oversizedResponse = await postRawJson(
        app,
        prefix,
        '/v1/public/agents/research-agent/conversations',
        {},
        RUNTIME_HTTP_BODY_LIMIT_BYTES + 1,
      );
      expect(oversizedResponse.statusCode).toBe(400);
      expect(parseVnextError(oversizedResponse.body).code).toBe('INVALID_INPUT');
      expect(oversizedResponse.body).not.toContain(oversizeCanary);
      expect(capturedParsedBodies).toHaveLength(beforeOversized);

      expect(dbCounters).toEqual(emptyDbCounters());
      expect(logLines.join('\n')).not.toContain('CANARY');
    } finally {
      await app.close();
    }
  }, 15_000);

  it('maps an unknown repository failure without leaking its message or legacy wrapper', async () => {
    const app = await appFor({
      enabled: true,
      auth: 'valid',
      repositoryError: new Error('secret database pathname and stack'),
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/public/agents/research-agent/conversations',
        headers: validHeaders(),
        payload: {},
      });
      expect(response.statusCode).toBe(503);
      const error = parseVnextError(response.body);
      expect(error.code).toBe('AGENT_OFFLINE');
      expect(JSON.parse(response.body)).not.toHaveProperty('error');
      expect(response.body).not.toContain('secret database');
    } finally {
      await app.close();
    }
  });
});
