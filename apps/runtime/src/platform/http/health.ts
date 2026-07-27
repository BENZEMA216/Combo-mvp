// 健康检查路由。不在 /api/v1 前缀。
// GET /health 只检查进程存活；GET /ready 检查 db/minio/redis 必需依赖与可降级的 llm。
// 邮件供应商不影响既有会话，认证也没有独立的远端身份依赖。
import type { FastifyInstance } from 'fastify';
import {
  HEALTH_PATH,
  READY_PATH,
  type DependencyHealth,
  type HealthStatus,
  type ReadyView,
} from '@cb/shared';
import { pingDb } from '../infra/db.js';
import { pingObjectStore } from '../infra/object-store.js';
import { hasLlmCredential } from '../infra/llm.js';
import { pingRedis } from '../infra/redis.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get(HEALTH_PATH, async () => ({ status: 'ok' as const }));

  app.get(READY_PATH, async (req, reply) => {
    const { env } = app.infra;
    const [db, minio, redis] = await Promise.all([
      pingDb(env),
      pingObjectStore(env),
      pingRedis(env),
    ]);
    const llm: HealthStatus = hasLlmCredential(env) ? 'ok' : 'degraded';

    const toStatus = (up: boolean): HealthStatus => (up ? 'ok' : 'down');
    const dependencies: DependencyHealth[] = [
      { name: 'db', status: toStatus(db), required: true },
      { name: 'minio', status: toStatus(minio), required: true },
      { name: 'redis_queue', status: toStatus(redis), required: true },
      { name: 'llm', status: llm, required: false },
    ];

    const anyRequiredDown = dependencies.some(
      (dependency) => dependency.required && dependency.status === 'down',
    );
    const status: HealthStatus = anyRequiredDown ? 'down' : llm === 'degraded' ? 'degraded' : 'ok';
    const view: ReadyView = { status, ready: !anyRequiredDown, dependencies };

    return reply.code(view.ready ? 200 : 503).send({ data: view, meta: { traceId: req.id } });
  });
}
