import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sharedHttpRateLimitOptions } from '../bootstrap/app.js';

const redisUrl = process.env.MCP_RATE_LIMIT_REDIS_URL;
const enabled = Boolean(redisUrl);
const integrationDescribe = enabled ? describe : describe.skip;

integrationDescribe('shared HTTP rate limiting across API replicas', () => {
  const environment = `rate-limit-${randomUUID()}`;
  const clients: Redis[] = [];
  const apps: FastifyInstance[] = [];

  async function replica(): Promise<FastifyInstance> {
    const redis = new Redis(redisUrl!, {
      connectTimeout: 1_000,
      maxRetriesPerRequest: 1,
    });
    redis.on('error', () => undefined);
    clients.push(redis);
    const app = Fastify({ logger: false });
    await app.register(
      rateLimit,
      sharedHttpRateLimitOptions({ COMBO_ENVIRONMENT: environment }, redis),
    );
    app.get('/shared-limit', {
      config: { rateLimit: { max: 2, timeWindow: '1 minute' } },
      handler: async () => ({ ok: true }),
    });
    await app.ready();
    apps.push(app);
    return app;
  }

  beforeAll(async () => {
    const cleanup = new Redis(redisUrl!);
    try {
      const keys = await cleanup.keys(`combo:${encodeURIComponent(environment)}:http-rate-limit:*`);
      if (keys.length > 0) await cleanup.del(...keys);
    } finally {
      cleanup.disconnect();
    }
  });

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
    for (const client of clients) client.disconnect();
  });

  it('combines counters from two independent replicas', async () => {
    const [first, second] = await Promise.all([replica(), replica()]);
    expect((await first.inject({ method: 'GET', url: '/shared-limit' })).statusCode).toBe(200);
    expect((await second.inject({ method: 'GET', url: '/shared-limit' })).statusCode).toBe(200);
    expect((await first.inject({ method: 'GET', url: '/shared-limit' })).statusCode).toBe(429);
  });

  it('fails closed instead of falling back to a replica-local counter', async () => {
    const app = await replica();
    const client = clients.at(-1)!;
    client.disconnect();
    const response = await app.inject({ method: 'GET', url: '/shared-limit' });
    expect(response.statusCode).toBe(500);
  });
});
