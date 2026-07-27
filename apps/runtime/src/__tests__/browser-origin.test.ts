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

const env = {
  NODE_ENV: 'production',
  PUBLIC_APP_ORIGINS: 'https://combo.example,https://review.combo.example',
  SESSION_COOKIE_SECURE: true,
} as Env;
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('runtime browser origin boundary', () => {
  it('reflects credentials only to an exact configured public app origin', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(cors, { origin: corsOriginPolicy(env), credentials: true });
    app.get('/probe', async () => ({ ok: true }));

    const exact = await app.inject({
      method: 'OPTIONS',
      url: '/probe',
      headers: {
        origin: 'https://combo.example',
        'access-control-request-method': 'GET',
      },
    });
    expect(exact.headers['access-control-allow-origin']).toBe('https://combo.example');

    const second = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'https://review.combo.example' },
    });
    expect(second.headers['access-control-allow-origin']).toBe('https://review.combo.example');

    const sibling = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'https://admin.combo.example' },
    });
    expect(sibling.headers['access-control-allow-origin']).toBeUndefined();

    const siblingPreflight = await app.inject({
      method: 'OPTIONS',
      url: '/probe',
      headers: {
        origin: 'https://admin.combo.example',
        'access-control-request-method': 'GET',
      },
    });
    expect(siblingPreflight.statusCode).toBeGreaterThanOrEqual(400);
    expect(siblingPreflight.statusCode).toBeLessThan(500);
    expect(siblingPreflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('uses the same strict origin-list grammar as authoring', () => {
    expect(canonicalBrowserOrigins(env)).toEqual([
      'https://combo.example',
      'https://review.combo.example',
    ]);
    for (const invalid of [
      'https://combo.example, https://review.combo.example',
      'https://combo.example/',
      'https://combo.example,https://combo.example',
      'https://user@combo.example',
    ]) {
      expect(() => canonicalBrowserOrigins({ PUBLIC_APP_ORIGINS: invalid })).toThrowError(
        'PUBLIC_APP_ORIGINS',
      );
    }
  });

  it('rejects a valid Cookie from a same-site sibling before any write handler runs', async () => {
    const write = vi.fn();
    const app = Fastify({ logger: false });
    apps.push(app);
    app.decorate('infra', { env } as InfraContext);
    app.post('/mutate', { preHandler: requireTrustedMutationOrigin() }, async (_request, reply) => {
      write();
      return reply.code(204).send();
    });

    const response = await app.inject({
      method: 'POST',
      url: '/mutate',
      headers: {
        cookie: `cb_session=s1.${'A'.repeat(43)}`,
        origin: 'https://admin.combo.example',
        'sec-fetch-site': 'same-site',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(write).not.toHaveBeenCalled();
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect((response.json() as { error: Record<string, unknown> }).error).not.toHaveProperty(
      'code',
    );
  });
});
