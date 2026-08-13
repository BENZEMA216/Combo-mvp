import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { VnextErrorResponseSchema, type VnextErrorResponse } from '@cb/creator-agent-protocol';
import { authSessionCookieName } from '@cb/shared';
import { describe, expect, it } from 'vitest';
import { ALWAYS_ENABLED_ENDPOINTS, registerBusinessRoutes } from '../../bootstrap/routes.js';
import { loadEnv, type Env } from '../../platform/config/env.js';
import type { RuntimeDb } from '../../platform/infra/db.js';

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

function db(
  options: { auth?: 'valid' | 'invalid' | 'error'; repositoryError?: Error } = {},
): RuntimeDb {
  return {
    async query<R>(sql: string) {
      if (sql.includes('FROM auth_sessions')) {
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
      if (options.repositoryError) throw options.repositoryError;
      return { rows: [] as R[], rowCount: 0 };
    },
    async connect() {
      if (options.repositoryError) throw options.repositoryError;
      throw new Error('repository connection was not expected');
    },
  };
}

async function appFor(input: {
  enabled: boolean;
  auth?: 'valid' | 'invalid' | 'error';
  repositoryError?: Error;
}) {
  const app = Fastify({ logger: false, genReqId: () => 'route-test-request-0001' });
  await app.register(cookie);
  const runtimeDb = db(input);
  app.decorate('infra', {
    env: env(input.enabled),
    db: runtimeDb,
    creatorAgentDb: input.enabled ? runtimeDb : null,
  } as never);
  await registerBusinessRoutes(app);
  await app.ready();
  return app;
}

function parseVnextError(body: string): VnextErrorResponse {
  return VnextErrorResponseSchema.parse(JSON.parse(body));
}

function validHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    origin: 'http://combo.test',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    'idempotency-key': '01900000-0000-7000-8000-000000000008',
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
