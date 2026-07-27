// B-04 · Redis 双实例客户端（脊柱 70 §8.1）。
//   redis_queue：BullMQ 专用（noeviction + AOF，maxRetriesPerRequest=null 是 BullMQ 硬要求）。
//   redis_hot  ：热态（Streams = SSE 源、分布式锁、限流计数）。
// 骨架阶段：惰性创建、lazyConnect（不在 import/启动期连，便于无 Docker 跑 tsc/单测/启动冒烟）。
import { Redis, type RedisOptions } from 'ioredis';
import type { Env } from '../config/env.js';

const reconnectDelay = (times: number): number => Math.min(times * 200, 2_000);

/** redis_queue 连接（BullMQ）。maxRetriesPerRequest 必须为 null（BullMQ 阻塞命令要求）。 */
const QUEUE_OPTS: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
  // 依赖重启期间持续限速重连；/ready 自己有短超时，关停则由 disconnect 立即终止。
  retryStrategy: reconnectDelay,
};

/** redis_hot 连接（streams/lock/限流）。 */
const HOT_OPTS: RedisOptions = {
  lazyConnect: true,
  retryStrategy: reconnectDelay,
};

let queueClient: Redis | undefined;
let hotClient: Redis | undefined;

/** ioredis 在连不上时会 emit 'error'；不挂监听会变 unhandled。骨架阶段静默吞（探针据连接状态判 down）。 */
function attachSilentErrorHandler(client: Redis): Redis {
  client.on('error', () => {
    /* swallow connection errors; readiness probe reports down via ping failure */
  });
  return client;
}

/** redis_queue 单例（BullMQ 用）。 */
export function getQueueRedis(env: Env): Redis {
  if (!queueClient)
    queueClient = attachSilentErrorHandler(new Redis(env.REDIS_QUEUE_URL, QUEUE_OPTS));
  return queueClient;
}

/** redis_hot 单例（SSE streams / lock / 限流）。 */
export function getHotRedis(env: Env): Redis {
  if (!hotClient) hotClient = attachSilentErrorHandler(new Redis(env.REDIS_HOT_URL, HOT_OPTS));
  return hotClient;
}

/** 优雅关闭两实例（进程退出时调用）。 */
export async function closeRedis(): Promise<void> {
  // disconnect（非 quit）：连不上时 quit 会挂；disconnect 立即断、不等回包。
  queueClient?.disconnect();
  hotClient?.disconnect();
  queueClient = undefined;
  hotClient = undefined;
}

/** ready 探针：PING（连不上 → down），带短超时，避免 /ready 因依赖宕机而长挂。 */
export async function pingRedis(client: Redis, timeoutMs = 2_000): Promise<boolean> {
  try {
    const pong = await withTimeout(client.ping(), timeoutMs);
    return pong === 'PONG';
  } catch {
    return false;
  }
}

/** 给 Promise 套超时（探针专用：依赖宕机时快速判 down，不裸挂）。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}
