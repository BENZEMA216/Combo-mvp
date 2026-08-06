import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../platform/config/env.js';
import type { InfraContext } from '../platform/infra/index.js';
import {
  canonicalBrowserOrigins,
  corsOriginPolicy,
  requireTrustedMutationOrigin,
} from '../platform/http/browser-origin.js';

const productionEnv = {
  NODE_ENV: 'production',
  PUBLIC_APP_ORIGINS: 'https://combo.example,https://try.combo.example',
} as Env;
const developmentEnv = {
  NODE_ENV: 'development',
  PUBLIC_APP_ORIGINS: 'http://localhost:5173',
} as Env;

const apps: FastifyInstance[] = [];

async function corsApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(cors, { origin: corsOriginPolicy(env), credentials: true });
  app.get('/probe', async () => ({ ok: true }));
  return app;
}

async function mutationApp(env: Env, handler: ReturnType<typeof vi.fn>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.decorate('infra', { env } as InfraContext);
  app.post('/mutate', { preHandler: requireTrustedMutationOrigin() }, async (_req, reply) => {
    handler();
    return reply.code(204).send();
  });
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('browser origin policy', () => {
  it('accepts only a strict, unique PUBLIC_APP_ORIGINS list', () => {
    expect(canonicalBrowserOrigins(productionEnv)).toEqual([
      'https://combo.example',
      'https://try.combo.example',
    ]);
    expect(() =>
      canonicalBrowserOrigins({
        PUBLIC_APP_ORIGINS: 'https://combo.example/path?secret=value',
      }),
    ).toThrowError('PUBLIC_APP_ORIGINS');
    expect(() =>
      canonicalBrowserOrigins({ PUBLIC_APP_ORIGINS: 'javascript:secret-value' }),
    ).toThrowError('PUBLIC_APP_ORIGINS');
    expect(() =>
      canonicalBrowserOrigins({
        PUBLIC_APP_ORIGINS: 'https://combo.example,https://combo.example',
      }),
    ).toThrowError('PUBLIC_APP_ORIGINS');
  });

  it('reflects only the exact configured origin in CORS responses', async () => {
    const app = await corsApp(productionEnv);
    const exact = await app.inject({
      method: 'OPTIONS',
      url: '/probe',
      headers: {
        origin: 'https://combo.example',
        'access-control-request-method': 'GET',
      },
    });
    expect(exact.statusCode).toBe(204);
    expect(exact.headers['access-control-allow-origin']).toBe('https://combo.example');

    const secondAllowed = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'https://try.combo.example' },
    });
    expect(secondAllowed.headers['access-control-allow-origin']).toBe('https://try.combo.example');

    const sibling = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'https://admin.combo.example' },
    });
    expect(sibling.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('authentication mutation origin guard', () => {
  it('allows exact Origin with same-origin metadata or no metadata', async () => {
    const handler = vi.fn();
    const app = await mutationApp(productionEnv, handler);

    const browser = await app.inject({
      method: 'POST',
      url: '/mutate',
      headers: { origin: 'https://combo.example', 'sec-fetch-site': 'same-origin' },
    });
    const olderBrowser = await app.inject({
      method: 'POST',
      url: '/mutate',
      headers: { origin: 'https://combo.example' },
    });

    expect(browser.statusCode).toBe(204);
    expect(olderBrowser.statusCode).toBe(204);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: 'missing Origin', headers: {} },
    {
      name: 'opaque Origin',
      headers: { origin: 'null', 'sec-fetch-site': 'same-origin' },
    },
    {
      name: 'same-site sibling',
      headers: {
        cookie: `cb_session=s1.${'A'.repeat(43)}`,
        origin: 'https://admin.combo.example',
        'sec-fetch-site': 'same-site',
      },
    },
    {
      name: 'same-site metadata despite exact Origin',
      headers: { origin: 'https://combo.example', 'sec-fetch-site': 'same-site' },
    },
    {
      name: 'cross-site metadata',
      headers: { origin: 'https://combo.example', 'sec-fetch-site': 'cross-site' },
    },
    {
      name: 'unknown metadata',
      headers: { origin: 'https://combo.example', 'sec-fetch-site': 'surprise' },
    },
  ])('rejects $name before the handler', async ({ headers }) => {
    const handler = vi.fn();
    const app = await mutationApp(productionEnv, handler);
    const response = await app.inject({ method: 'POST', url: '/mutate', headers });

    expect(response.statusCode).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    const body = response.json() as { error: Record<string, unknown> };
    expect(body.error.userMessage).toEqual(expect.any(String));
    expect(body.error).not.toHaveProperty('code');
    expect(response.body).not.toContain('combo.example');
  });

  it('uses the configured development origin rather than a broad local-port allowlist', async () => {
    const handler = vi.fn();
    const app = await mutationApp(developmentEnv, handler);
    const accepted = await app.inject({
      method: 'POST',
      url: '/mutate',
      headers: { origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin' },
    });
    const rejected = await app.inject({
      method: 'POST',
      url: '/mutate',
      headers: { origin: 'http://localhost:5174', 'sec-fetch-site': 'same-origin' },
    });
    expect(accepted.statusCode).toBe(204);
    expect(rejected.statusCode).toBe(403);
  });
});
