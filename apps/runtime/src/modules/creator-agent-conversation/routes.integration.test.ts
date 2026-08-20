import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {
  ExecutionCapabilitySchema,
  VnextErrorResponseSchema,
  executionCapabilityDigest,
  type VnextErrorResponse,
} from '@cb/creator-agent-protocol';
import { authSessionCookieName } from '@cb/shared';
import { describe, expect, it } from 'vitest';

// VNext registry case: SCH-005 (actual route response/log/authority remains canary-free).
import { ALWAYS_ENABLED_ENDPOINTS, registerBusinessRoutes } from '../../bootstrap/routes.js';
import { loadEnv, type Env } from '../../platform/config/env.js';
import { RUNTIME_HTTP_BODY_LIMIT_BYTES } from '../../platform/http/vnext-json-body.js';
import type { QueryResultLike, RuntimeDb, TxConn } from '../../platform/infra/db.js';
import type { ConsumerMessageAuthority } from './consumer-message-authority.js';
import { formatConsumerEventSse } from './consumer-events.js';
import type { InvocationPrepareAuthority } from './invocation-prepare-authority.js';
import type { ConsumerRuntimeProductAuthorities } from './runtime-product-repo.js';

const SESSION_TOKEN = `s1.${'A'.repeat(43)}`;
const CONSUMER = '01900000-0000-7000-8000-000000000001';
const CREATOR = '01900000-0000-7000-8000-000000000010';
const CONVERSATION = '01900000-0000-7000-8000-000000000011';
const AGENT = '01900000-0000-7000-8000-000000000012';
const AGENT_VERSION = '01900000-0000-7000-8000-000000000013';
const DEPLOYMENT = '01900000-0000-7000-8000-000000000014';
const INSTALLATION = '01900000-0000-7000-8000-000000000015';
const LEASE = '01900000-0000-7000-8000-000000000016';
const INVOCATION = '01900000-0000-7000-8000-000000000017';
const USER_MESSAGE = '01900000-0000-7000-8000-000000000018';
const ASSISTANT_MESSAGE = '01900000-0000-7000-8000-000000000019';
const CLIENT_MESSAGE = '550e8400-e29b-41d4-a716-446655440000';
const HMAC = `hmac-sha256:${'a'.repeat(64)}`;
const SHA = 'b'.repeat(64);
const CREATED_AT = '2026-08-20T00:00:00.000Z';
const TERMINAL_AT = '2026-08-20T00:00:05.000Z';
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
  creatorAgentDb?: RuntimeDb;
  runtimeProductAuthorities?: ConsumerRuntimeProductAuthorities | null;
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
    creatorAgentDb: input.enabled ? (input.creatorAgentDb ?? runtimeDb) : null,
    creatorAgentRuntimeProduct: input.enabled ? (input.runtimeProductAuthorities ?? null) : null,
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

type SqlResponder = (
  sql: string,
  parameters: unknown[] | undefined,
) => Promise<readonly unknown[]> | readonly unknown[];

function creatorProductDb(responder: SqlResponder) {
  const queries: Array<{ sql: string; parameters: unknown[] | undefined }> = [];
  let releases = 0;
  const query = async <R>(sql: string, parameters?: unknown[]): Promise<QueryResultLike<R>> => {
    queries.push({ sql, parameters });
    const rows = await responder(sql, parameters);
    return { rows: [...rows] as R[], rowCount: rows.length };
  };
  const runtimeDb: RuntimeDb = {
    query,
    async connect(): Promise<TxConn> {
      return {
        query,
        release: () => {
          releases += 1;
        },
      };
    },
  };
  return { runtimeDb, queries, releases: () => releases };
}

function encryptedMessage() {
  return {
    algorithm: 'aes-256-gcm/v1' as const,
    keyId: 'owner-key-v1',
    nonce: Buffer.alloc(12, 1),
    ciphertext: Buffer.from('sealed-user-message'),
    authTag: Buffer.alloc(16, 2),
    cipherDigest: 'c'.repeat(64),
    contentDigest: HMAC,
    aadVersion: 1 as const,
  };
}

const SERVER_IDS = Object.freeze([
  USER_MESSAGE,
  INVOCATION,
  '01900000-0000-7000-8000-000000000020',
  '01900000-0000-7000-8000-000000000021',
  '01900000-0000-7000-8000-000000000022',
  '01900000-0000-7000-8000-000000000023',
  '01900000-0000-7000-8000-000000000024',
  '01900000-0000-7000-8000-000000000025',
]);

function productAuthorities(options: { openedText?: string } = {}) {
  const calls = { bind: 0, seal: 0, prepare: 0, issue: 0, open: 0 };
  const message: ConsumerMessageAuthority = {
    async bindUserMessage() {
      calls.bind += 1;
      return {
        requestDigest: HMAC,
        async seal() {
          calls.seal += 1;
          return encryptedMessage();
        },
      };
    },
    async openMessage() {
      calls.open += 1;
      return options.openedText ?? 'opened visible message';
    },
  };
  const invocationPrepare: InvocationPrepareAuthority = {
    async prepare(input) {
      calls.prepare += 1;
      const { installationId, signal: _signal, ...wireInput } = input;
      const capability = ExecutionCapabilitySchema.parse({
        protocol: 'combo.execution-capability/1',
        schemaVersion: 1,
        ...wireInput,
        workerInstallationId: installationId,
        budget: { maxInputTokens: 1_024, maxOutputTokens: 512, maxCostMicros: 10_000 },
        nonce: Buffer.alloc(32, 4).toString('base64url'),
        signatureAlgorithm: 'ES256',
        signatureEncoding: 'ieee-p1363',
        signature: Buffer.alloc(64, 5).toString('base64url'),
      });
      return { capability, capabilityDigest: executionCapabilityDigest(capability) };
    },
  };
  const authorities: ConsumerRuntimeProductAuthorities = Object.freeze({
    message,
    invocationPrepare,
    serverIds: {
      async issue(count: number) {
        calls.issue += 1;
        return SERVER_IDS.slice(0, count);
      },
    },
  });
  return { authorities, calls };
}

function readyPreflight() {
  return {
    outcome: 'READY',
    existing_invocation_id: null,
    existing_state: null,
    creator_id: CREATOR,
    deployment_id: DEPLOYMENT,
    agent_version_id: AGENT_VERSION,
    agent_version_digest: SHA,
    snapshot_digest: 'd'.repeat(64),
    installation_id: INSTALLATION,
    lease_id: LEASE,
    fence: '7',
    capability_not_before: '2026-08-20T00:00:00.000Z',
    deadline_at: '2026-08-20T00:00:30.000Z',
    capability_expires_at: '2026-08-20T00:01:00.000Z',
    resolved_model: 'openai/gpt-5',
    reasoning_effort: 'medium',
  };
}

const NEW_PRODUCT_ROUTES = [
  { method: 'POST' as const, url: '/v1/public/agents/:slug/conversations' },
  { method: 'POST' as const, url: '/v1/conversations/:conversationId/messages' },
  { method: 'GET' as const, url: '/v1/conversations/:conversationId' },
  { method: 'GET' as const, url: '/v1/invocations/:invocationId' },
  { method: 'GET' as const, url: '/v1/conversations/:conversationId/events' },
];

describe('VNext Consumer route registration and wire errors', () => {
  it('keeps all five Creator Agent product routes absent when the feature flag is false', async () => {
    const app = await appFor({ enabled: false });
    try {
      for (const route of NEW_PRODUCT_ROUTES) expect(app.hasRoute(route)).toBe(false);
      expect(ALWAYS_ENABLED_ENDPOINTS).toHaveLength(11);
      const requests = [
        ['POST', '/v1/public/agents/research-agent/conversations', {}],
        ['POST', `/v1/conversations/${CONVERSATION}/messages`, {}],
        ['GET', `/v1/conversations/${CONVERSATION}`, undefined],
        ['GET', `/v1/invocations/${INVOCATION}`, undefined],
        ['GET', `/v1/conversations/${CONVERSATION}/events`, undefined],
      ] as const;
      for (const [method, url, payload] of requests) {
        const response = await app.inject({ method, url, headers: validHeaders(), payload });
        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }
    } finally {
      await app.close();
    }
  });

  it('registers all five routes only when enabled and rejects a missing origin in VNext shape', async () => {
    const app = await appFor({ enabled: true });
    try {
      for (const route of NEW_PRODUCT_ROUTES) expect(app.hasRoute(route)).toBe(true);
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

describe('registered Creator Agent Runtime product routes', () => {
  it('requires the session Cookie on every message/read/invocation/events route', async () => {
    const product = creatorProductDb(() => []);
    const { authorities } = productAuthorities();
    const app = await appFor({
      enabled: true,
      creatorAgentDb: product.runtimeDb,
      runtimeProductAuthorities: authorities,
    });
    const requests = [
      {
        method: 'POST' as const,
        url: `/v1/conversations/${CONVERSATION}/messages`,
        payload: { clientMessageId: CLIENT_MESSAGE, text: 'hello' },
      },
      { method: 'GET' as const, url: `/v1/conversations/${CONVERSATION}` },
      { method: 'GET' as const, url: `/v1/invocations/${INVOCATION}` },
      { method: 'GET' as const, url: `/v1/conversations/${CONVERSATION}/events` },
    ];
    try {
      for (const request of requests) {
        const response = await app.inject({
          ...request,
          headers: validHeaders({ cookie: '' }),
        });
        expect(response.statusCode, `${request.method} ${request.url}`).toBe(401);
        expect(parseVnextError(response.body).code).toBe('UNAUTHORIZED');
      }
      expect(product.queries).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('enforces message Origin, exact body, and body-bound Idempotency-Key before product IO', async () => {
    const product = creatorProductDb(() => []);
    const { authorities, calls } = productAuthorities();
    const app = await appFor({
      enabled: true,
      auth: 'valid',
      creatorAgentDb: product.runtimeDb,
      runtimeProductAuthorities: authorities,
    });
    try {
      const missingOrigin = await app.inject({
        method: 'POST',
        url: `/v1/conversations/${CONVERSATION}/messages`,
        headers: validHeaders({ origin: '' }),
        payload: { clientMessageId: CLIENT_MESSAGE, text: 'hello' },
      });
      expect(missingOrigin.statusCode).toBe(403);
      expect(parseVnextError(missingOrigin.body).code).toBe('FORBIDDEN');

      const unknownBody = await app.inject({
        method: 'POST',
        url: `/v1/conversations/${CONVERSATION}/messages`,
        headers: validHeaders(),
        payload: { clientMessageId: CLIENT_MESSAGE, text: 'hello', unknown: true },
      });
      expect(unknownBody.statusCode).toBe(400);
      expect(parseVnextError(unknownBody.body).code).toBe('INVALID_INPUT');

      const mismatchedKey = await app.inject({
        method: 'POST',
        url: `/v1/conversations/${CONVERSATION}/messages`,
        headers: validHeaders({
          'idempotency-key': '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
        }),
        payload: { clientMessageId: CLIENT_MESSAGE, text: 'hello' },
      });
      expect(mismatchedKey.statusCode).toBe(400);
      expect(parseVnextError(mismatchedKey.body).code).toBe('INVALID_INPUT');
      expect(product.queries).toEqual([]);
      expect(calls).toEqual({ bind: 0, seal: 0, prepare: 0, issue: 0, open: 0 });
    } finally {
      await app.close();
    }
  });

  it('returns 202 only after the injected DB and message/signing/ID authorities finalize admission', async () => {
    const product = creatorProductDb((sql, parameters) => {
      if (sql.includes('SELECT creator_id') && sql.includes('FROM agent_conversations')) {
        return [{ creator_id: CREATOR }];
      }
      if (sql.includes('creator_agent_preflight_consumer_message_v2')) {
        return [readyPreflight()];
      }
      if (sql.includes('creator_agent_finalize_consumer_message_v2')) {
        return [
          {
            finalize_outcome: 'ADMITTED',
            invocation_id: parameters?.[3],
            invocation_state: 'DISPATCH_PENDING',
          },
        ];
      }
      return [];
    });
    const { authorities, calls } = productAuthorities();
    const app = await appFor({
      enabled: true,
      auth: 'valid',
      creatorAgentDb: product.runtimeDb,
      runtimeProductAuthorities: authorities,
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/conversations/${CONVERSATION}/messages`,
        headers: validHeaders(),
        payload: { clientMessageId: CLIENT_MESSAGE, text: 'run the mounted product path' },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        protocol: 'combo.creator-agent-http/1',
        invocationId: INVOCATION,
        state: 'QUEUED',
      });
      expect(calls).toEqual({ bind: 1, seal: 1, prepare: 1, issue: 1, open: 0 });
      expect(
        product.queries.find(({ sql }) =>
          sql.includes('creator_agent_finalize_consumer_message_v2'),
        )?.parameters,
      ).toHaveLength(20);
      expect(product.queries.map(({ sql }) => sql)).toContain('COMMIT');
      expect(product.releases()).toBe(3);
    } finally {
      await app.close();
    }
  });

  it('serves transcript and invocation views through their read-only transaction wiring', async () => {
    const product = creatorProductDb((sql) => {
      if (sql.includes('SELECT id, agent_id') && sql.includes('FROM agent_conversations')) {
        return [
          {
            id: CONVERSATION,
            agent_id: AGENT,
            agent_version_id: AGENT_VERSION,
            creator_id: CREATOR,
            version_digest: SHA,
            state: 'IDLE',
            created_at: CREATED_AT,
            expires_at: '2026-08-21T00:00:00.000Z',
          },
        ];
      }
      if (sql.includes('FROM agent_messages')) {
        return [
          {
            id: USER_MESSAGE,
            invocation_id: INVOCATION,
            turn_no: 1,
            role: 'USER',
            content_algorithm: 'aes-256-gcm/v1',
            content_key_id: 'owner-key-v1',
            content_nonce: Buffer.alloc(12, 1),
            content_ciphertext: Buffer.from('sealed-user-message'),
            content_auth_tag: Buffer.alloc(16, 2),
            content_cipher_digest: 'c'.repeat(64),
            content_digest: HMAC,
            content_aad_version: 1,
            created_at: CREATED_AT,
          },
        ];
      }
      if (sql.includes('FROM consumer_event_streams')) return [{ latest_cursor: '9' }];
      if (sql.includes('SELECT creator_id, conversation_id')) {
        return [{ creator_id: CREATOR, conversation_id: CONVERSATION }];
      }
      if (sql.includes('SELECT id, conversation_id') && sql.includes('FROM agent_invocations')) {
        return [
          {
            id: INVOCATION,
            conversation_id: CONVERSATION,
            creator_id: CREATOR,
            state: 'SUCCEEDED',
            result_digest: HMAC,
            error_code: null,
            retry_of_invocation_id: null,
            created_at: CREATED_AT,
            terminal_at: TERMINAL_AT,
          },
        ];
      }
      return [];
    });
    const { authorities, calls } = productAuthorities({ openedText: 'visible user message' });
    const app = await appFor({
      enabled: true,
      auth: 'valid',
      creatorAgentDb: product.runtimeDb,
      runtimeProductAuthorities: authorities,
    });
    try {
      const transcript = await app.inject({
        method: 'GET',
        url: `/v1/conversations/${CONVERSATION}`,
        headers: validHeaders(),
      });
      expect(transcript.statusCode).toBe(200);
      expect(transcript.json()).toMatchObject({
        protocol: 'combo.creator-agent-http/1',
        conversation: { conversationId: CONVERSATION, state: 'IDLE' },
        messages: [
          {
            messageId: USER_MESSAGE,
            invocationId: INVOCATION,
            role: 'USER',
            text: 'visible user message',
          },
        ],
        latestEventId: '9',
      });

      const invocation = await app.inject({
        method: 'GET',
        url: `/v1/invocations/${INVOCATION}`,
        headers: validHeaders(),
      });
      expect(invocation.statusCode).toBe(200);
      expect(invocation.json()).toEqual({
        protocol: 'combo.creator-agent-http/1',
        invocationId: INVOCATION,
        conversationId: CONVERSATION,
        state: 'SUCCEEDED',
        resultDigest: HMAC,
        error: null,
        retryOfInvocationId: null,
        createdAt: CREATED_AT,
        terminalAt: TERMINAL_AT,
      });
      expect(calls.open).toBe(1);
      expect(product.releases()).toBe(2);
      expect(product.queries.filter(({ sql }) => sql.includes('READ ONLY'))).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it('maps absent Consumer ownership to the frozen error on every registered product repository', async () => {
    const product = creatorProductDb(() => []);
    const { authorities } = productAuthorities();
    const app = await appFor({
      enabled: true,
      auth: 'valid',
      creatorAgentDb: product.runtimeDb,
      runtimeProductAuthorities: authorities,
    });
    const requests = [
      {
        method: 'POST' as const,
        url: `/v1/conversations/${CONVERSATION}/messages`,
        payload: { clientMessageId: CLIENT_MESSAGE, text: 'not mine' },
      },
      { method: 'GET' as const, url: `/v1/conversations/${CONVERSATION}` },
      { method: 'GET' as const, url: `/v1/invocations/${INVOCATION}` },
      { method: 'GET' as const, url: `/v1/conversations/${CONVERSATION}/events` },
    ];
    try {
      for (const request of requests) {
        const response = await app.inject({ ...request, headers: validHeaders() });
        expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
        expect(parseVnextError(response.body).code).toBe('FORBIDDEN');
      }
    } finally {
      await app.close();
    }
  });

  it('replays a terminal SSE frame strictly after Last-Event-ID through the registered route', async () => {
    const terminalEvent = {
      id: '9',
      type: 'invocation.terminal' as const,
      payload: {
        protocol: 'combo.consumer-event-outbox/1' as const,
        schemaVersion: 1 as const,
        type: 'invocation.terminal' as const,
        conversationId: CONVERSATION,
        invocationId: INVOCATION,
        occurredAt: TERMINAL_AT,
        terminalState: 'SUCCEEDED' as const,
        assistantMessageId: ASSISTANT_MESSAGE,
        resultDigest: HMAC,
        errorCode: null,
      },
    };
    const product = creatorProductDb((sql) => {
      if (sql.includes('FROM agent_conversations')) {
        return [{ creator_id: CREATOR, created_at: CREATED_AT }];
      }
      if (sql.includes('FROM consumer_event_streams')) {
        return [
          {
            owner_id: CONSUMER,
            conversation_id: CONVERSATION,
            latest_cursor: '9',
            expired_through_cursor: '0',
            updated_at: TERMINAL_AT,
          },
        ];
      }
      if (sql.includes('FROM consumer_event_outbox')) {
        return [
          {
            cursor: '9',
            owner_id: CONSUMER,
            conversation_id: CONVERSATION,
            invocation_id: INVOCATION,
            event_type: 'invocation.terminal',
            payload: terminalEvent.payload,
          },
        ];
      }
      return [];
    });
    const app = await appFor({ enabled: true, auth: 'valid', creatorAgentDb: product.runtimeDb });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/conversations/${CONVERSATION}/events`,
        headers: validHeaders({ 'last-event-id': '7' }),
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers).toMatchObject({
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
        'content-type': 'text/event-stream; charset=utf-8',
      });
      expect(response.body).toBe(formatConsumerEventSse(terminalEvent));
      expect(
        product.queries.find(({ sql }) => sql.includes('FROM consumer_event_outbox'))?.parameters,
      ).toEqual([CONSUMER, CONVERSATION, '7', 51]);

      const malformedCursor = await app.inject({
        method: 'GET',
        url: `/v1/conversations/${CONVERSATION}/events`,
        headers: validHeaders({ 'last-event-id': '9223372036854775808' }),
      });
      expect(malformedCursor.statusCode).toBe(400);
      expect(parseVnextError(malformedCursor.body).code).toBe('INVALID_INPUT');
    } finally {
      await app.close();
    }
  });
});
