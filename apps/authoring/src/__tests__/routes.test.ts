import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { describe, expect, it } from 'vitest';
import { ALL_ENDPOINTS } from '../bootstrap/routes.js';
import { getCapabilityDefinitionHandler } from '../modules/capability/handlers.js';

interface CapturedReply {
  statusCode: number;
  body: unknown;
}

function makeReply(): FastifyReply {
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
  return reply as unknown as FastifyReply;
}

async function call(handler: RouteHandlerMethod, req: FastifyRequest): Promise<CapturedReply> {
  const reply = makeReply();
  await handler.call(req.server, req, reply);
  return reply as unknown as CapturedReply;
}

describe('route registry self-check', () => {
  it('registers exactly 33 endpoints including both immutable share schema families', () => {
    expect(ALL_ENDPOINTS).toHaveLength(33);
  });

  it('has no duplicate method and URL pairs', () => {
    const seen = new Set<string>();
    for (const endpoint of ALL_ENDPOINTS) {
      const key = `${String(endpoint.method)} ${endpoint.url}`;
      expect(seen.has(key), `duplicate route: ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('exposes only the four first-party authentication endpoints', () => {
    const account = ALL_ENDPOINTS.filter(
      (endpoint) => endpoint.url === '/me' || endpoint.url.startsWith('/auth/'),
    );
    expect(account.map((endpoint) => `${String(endpoint.method)} ${endpoint.url}`)).toEqual([
      'POST /auth/email/challenges',
      'POST /auth/email/verifications',
      'GET /me',
      'POST /auth/logout',
    ]);
  });

  it('puts no-store on all auth responses and a 4 KiB JSON/origin guard on auth POSTs', () => {
    const account = ALL_ENDPOINTS.filter(
      (endpoint) => endpoint.url === '/me' || endpoint.url.startsWith('/auth/'),
    );
    for (const endpoint of account) expect(endpoint.onRequest).toHaveLength(1);

    const mutations = account.filter((endpoint) => endpoint.method === 'POST');
    for (const endpoint of mutations) {
      expect(endpoint.bodyLimit).toBe(4_096);
      expect(endpoint.preHandlers).toHaveLength(2);
    }
    expect(account.find((endpoint) => endpoint.url === '/me')?.preHandlers).toHaveLength(1);
  });

  it('puts an Origin guard before every browser write and exempts only pairing-code uploads', () => {
    const exempt = new Set([
      '/connect/prepare',
      '/connect/upload',
      '/billing/leshouying/payment-notify',
    ]);
    for (const endpoint of ALL_ENDPOINTS) {
      if (endpoint.method === 'GET' || exempt.has(endpoint.url)) continue;
      expect(
        (endpoint.preHandlers ?? []).length,
        `${String(endpoint.method)} ${endpoint.url} 缺浏览器来源守卫`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps the payment notification independent from browser credentials and tightly bounded', () => {
    const callback = ALL_ENDPOINTS.find(
      (endpoint) => endpoint.url === '/billing/leshouying/payment-notify',
    );
    expect(callback).toMatchObject({
      method: 'POST',
      bodyLimit: 16 * 1_024,
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
    });
    expect(callback?.preHandlers).toHaveLength(1);
  });

  it('protects wallet and recharge-order browser endpoints with authentication and Origin', () => {
    const billing = ALL_ENDPOINTS.filter(
      (endpoint) =>
        endpoint.url.startsWith('/billing/') &&
        endpoint.url !== '/billing/leshouying/payment-notify',
    );
    expect(billing).toHaveLength(4);
    for (const endpoint of billing) {
      expect(endpoint.preHandlers?.length).toBeGreaterThanOrEqual(2);
    }
    expect(billing.find((endpoint) => endpoint.url === '/billing/recharge-orders')?.bodyLimit).toBe(
      4_096,
    );
    expect(billing.find((endpoint) => endpoint.url === '/billing/recharge-orders')?.config).toEqual(
      { rateLimit: { max: 10, timeWindow: '1 minute' } },
    );
  });

  it('keeps assistant endpoints independent from browser login', () => {
    const connect = ALL_ENDPOINTS.filter((endpoint) => endpoint.url.startsWith('/connect/'));
    expect(connect.length).toBeGreaterThanOrEqual(2);
    for (const endpoint of connect) expect(endpoint.preHandlers ?? []).toHaveLength(0);
  });

  it('protects Project Agent creation but keeps exact-token reads public', () => {
    const create = ALL_ENDPOINTS.find(
      (endpoint) => endpoint.method === 'POST' && endpoint.url === '/project-agent-shares',
    );
    expect(create).toMatchObject({
      bodyLimit: 32 * 1_024,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    });
    expect(create?.preHandlers).toHaveLength(2);

    const read = ALL_ENDPOINTS.find(
      (endpoint) =>
        endpoint.method === 'GET' && endpoint.url === '/project-agent-shares/:shareToken',
    );
    expect(read?.preHandlers ?? []).toHaveLength(0);
    expect(read?.config).toEqual({ rateLimit: { max: 120, timeWindow: '1 minute' } });
  });

  it('protects Codex Agent creation but keeps exact-token v2 reads public', () => {
    const create = ALL_ENDPOINTS.find(
      (endpoint) => endpoint.method === 'POST' && endpoint.url === '/codex-agent-shares',
    );
    expect(create).toMatchObject({
      bodyLimit: 128 * 1_024,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    });
    expect(create?.preHandlers).toHaveLength(2);

    const read = ALL_ENDPOINTS.find(
      (endpoint) => endpoint.method === 'GET' && endpoint.url === '/codex-agent-shares/:shareToken',
    );
    expect(read?.preHandlers ?? []).toHaveLength(0);
    expect(read?.config).toEqual({ rateLimit: { max: 120, timeWindow: '1 minute' } });
  });
});

describe('GET /capabilities/:capabilityId/definition', () => {
  it('rejects a malformed capability id before querying PostgreSQL', async () => {
    let queryCount = 0;
    const req = {
      id: 'trace-test',
      auth: { userId: 'user-test', account: 'tester', roles: ['creator'] },
      params: { capabilityId: 'not-a-uuid' },
      log: { error: () => undefined },
      server: {
        infra: {
          db: {
            query: async () => {
              queryCount += 1;
              throw new Error('database must not be queried');
            },
          },
        },
      },
    } as unknown as FastifyRequest;

    const reply = await call(getCapabilityDefinitionHandler(), req);

    expect(reply.statusCode).toBe(400);
    expect(queryCount).toBe(0);
  });
});
