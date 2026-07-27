import type { FastifyInstance } from 'fastify';
import {
  HEALTH_PATH,
  READY_PATH,
  type DependencyHealth,
  type HealthStatus,
  type ReadyView,
} from '@cb/shared';
import { pingDb } from '../infra/db.js';
import { pingRedis } from '../infra/redis.js';
import { pingObjectStore } from '../infra/object-store.js';
import { probeLlm } from '../infra/llm-gateway.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get(HEALTH_PATH, async () => ({ status: 'ok' as const }));

  app.get(READY_PATH, async (req, reply) => {
    const { infra } = app;
    const [db, redisQueue, redisHot, minio] = await Promise.all([
      pingDb(infra.env),
      pingRedis(infra.redisQueue),
      pingRedis(infra.redisHot),
      pingObjectStore(infra.env),
    ]);
    const llm = probeLlm(infra.env);

    const toStatus = (up: boolean): HealthStatus => (up ? 'ok' : 'down');
    const dependencies: DependencyHealth[] = [
      { name: 'db', status: toStatus(db), required: true },
      { name: 'redis_queue', status: toStatus(redisQueue), required: true },
      { name: 'redis_hot', status: toStatus(redisHot), required: true },
      { name: 'minio', status: toStatus(minio), required: true },
      { name: 'llm', status: llm, required: false },
    ];

    const anyRequiredDown = dependencies.some((dependency) => {
      return dependency.required && dependency.status === 'down';
    });
    const status: HealthStatus = anyRequiredDown ? 'down' : llm === 'degraded' ? 'degraded' : 'ok';
    const view: ReadyView = { status, ready: !anyRequiredDown, dependencies };
    return reply.code(view.ready ? 200 : 503).send({ data: view, meta: { traceId: req.id } });
  });
}
