import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadyView } from '@cb/shared';
import { registerHealthRoutes } from '../platform/http/health.js';

const probes = vi.hoisted(() => ({
  db: vi.fn(),
  creatorAgentDb: vi.fn(),
  minio: vi.fn(),
  redis: vi.fn(),
  llm: vi.fn(),
}));

vi.mock('../platform/infra/db.js', () => ({
  pingDb: probes.db,
  pingCreatorAgentDb: probes.creatorAgentDb,
}));
vi.mock('../platform/infra/object-store.js', () => ({ pingObjectStore: probes.minio }));
vi.mock('../platform/infra/redis.js', () => ({ pingRedis: probes.redis }));
vi.mock('../platform/infra/llm.js', () => ({ hasLlmCredential: probes.llm }));

async function readyResponse(
  creatorAgentPublicEnabled = false,
): Promise<{ statusCode: number; view: ReadyView }> {
  const app = Fastify({ logger: false });
  app.decorate('infra', {
    env: { CREATOR_AGENT_PUBLIC_ENABLED: creatorAgentPublicEnabled },
  } as never);
  await registerHealthRoutes(app);
  const response = await app.inject({ method: 'GET', url: '/ready' });
  await app.close();
  return {
    statusCode: response.statusCode,
    view: (response.json() as { data: ReadyView }).data,
  };
}

beforeEach(() => {
  probes.db.mockResolvedValue(true);
  probes.creatorAgentDb.mockResolvedValue(true);
  probes.minio.mockResolvedValue(true);
  probes.redis.mockResolvedValue(true);
  probes.llm.mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('runtime readiness dependencies', () => {
  it('contains only runtime-owned dependencies', async () => {
    const response = await readyResponse();

    expect(response.statusCode).toBe(200);
    expect(response.view.dependencies.map((dependency) => dependency.name)).toEqual([
      'db',
      'minio',
      'redis_queue',
      'llm',
    ]);
    expect(JSON.stringify(response.view)).not.toMatch(/identity|issuer|jwks/i);
  });

  it('fails readiness when the dedicated Consumer authority is absent or misconfigured', async () => {
    probes.creatorAgentDb.mockResolvedValue(false);

    const response = await readyResponse(true);

    expect(response.statusCode).toBe(503);
    expect(response.view.dependencies).toContainEqual({
      name: 'creator_agent_db',
      status: 'down',
      required: true,
    });
  });

  it('still fails readiness when the PostgreSQL session fact source is unavailable', async () => {
    probes.db.mockResolvedValue(false);

    const response = await readyResponse();

    expect(response.statusCode).toBe(503);
    expect(response.view.ready).toBe(false);
    expect(response.view.status).toBe('down');
    expect(response.view.dependencies.find((dependency) => dependency.name === 'db')).toEqual({
      name: 'db',
      status: 'down',
      required: true,
    });
  });
});
