// BullMQ 队列封装（实现 shared QueuePort）。任务流水线只有一条队列：task-pipeline。
//   - BullMQ jobId = taskId：同一任务在 waiting/active 期间重复入队被去重（配对收齐与对账循环
//     并发触发不产生双触发）；removeOnComplete/removeOnFail 立即清（tasks 表才是状态真源，
//     完成/失败后的重试、对账重投都能再入队，不被历史触发占位挡住）。
//   - attempts=1：失败重试是业务语义（tasks.retry_count + 用户点重试 / 租约对账重投），
//     不叠加 BullMQ 自动重试；双跑由 worker 领租约兜底。
// 惰性建 Queue（不连 Redis 直到首次 enqueue），可 tsc/单测/启动冒烟无 Docker。
import { Queue } from 'bullmq';
import type { QueuePort, TraceId } from '@cb/shared';
import type { Env } from '../config/env.js';

/** 提取流水线队列名（api 入队 / worker 消费共用真源）。 */
export const TASK_PIPELINE_QUEUE = 'task-pipeline';

/** BullMQ key 命名空间（生产端 Queue 与消费端 Worker 必须一致）。 */
export const QUEUE_PREFIX = 'cb';

/** BullMQ 连接配置（redis_queue；maxRetriesPerRequest=null 是 BullMQ 硬要求）。 */
export function bullConnectionFor(env: Env): {
  host: string;
  port: number;
  password?: string;
  db: number;
  maxRetriesPerRequest: null;
  enableReadyCheck: boolean;
} {
  const url = new URL(env.REDIS_QUEUE_URL);
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    ...(url.password ? { password: url.password } : {}),
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

const queues = new Map<string, Queue>();

type BullErrorEmitter = {
  on(event: 'error', listener: (error: Error) => void): unknown;
};

/**
 * BullMQ 会把依赖与内部故障作为 EventEmitter 的 error 事件发出。监听器只接收无参数通知，
 * 避免默认错误输出或调用方日志意外带出连接材料；恢复与终态仍由 BullMQ、业务状态和探针判断。
 */
export function attachBullErrorHandler<T extends BullErrorEmitter>(
  emitter: T,
  onError: () => void = () => undefined,
): T {
  emitter.on('error', () => onError());
  return emitter;
}

function queueFor(env: Env, name: string): Queue {
  let q = queues.get(name);
  if (!q) {
    q = attachBullErrorHandler(
      new Queue(name, {
        prefix: QUEUE_PREFIX,
        connection: bullConnectionFor(env),
        defaultJobOptions: {
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
        },
      }),
    );
    queues.set(name, q);
  }
  return q;
}

/** BullMQ 实现的 QueuePort：enqueue(queue, taskId) / remove(queue, taskId)。 */
export function createBullQueuePort(env: Env): QueuePort {
  return {
    async enqueue(queue: string, taskId: string, traceId?: TraceId): Promise<void> {
      await queueFor(env, queue).add(
        'run',
        { taskId, ...(traceId ? { traceId } : {}) },
        { jobId: taskId },
      );
    },
    async remove(queue: string, taskId: string): Promise<void> {
      await queueFor(env, queue)
        .remove(taskId)
        .catch(() => undefined);
    },
  };
}

/** 优雅关闭所有队列。 */
export async function closeQueues(): Promise<void> {
  await Promise.allSettled([...queues.values()].map((q) => q.close()));
  queues.clear();
}
