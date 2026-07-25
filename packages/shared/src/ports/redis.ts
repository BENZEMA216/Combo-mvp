// Redis 双实例端口。redis_queue（BullMQ）/ redis_hot（streams/lock/限流）。
import type { TraceId } from '../core/ids.js';

/** redis_queue：队列抽象。queue 是队列名（如 'task-pipeline'），taskId 去重。 */
export interface QueuePort {
  enqueue(queue: string, taskId: string, traceId?: TraceId): Promise<void>;
  remove(queue: string, taskId: string): Promise<void>;
}

/** redis_hot streams：Task 与 Runtime SSE 的可重放事件源。 */
export interface EventStreamPort {
  /** 返回 entry id（= SSE id，Last-Event-ID 用）。 */
  xadd(streamKey: string, frame: { event: string; data: unknown }): Promise<string>;
}

/** redis_hot 带租约的分布式锁。 */
export interface LockPort {
  acquire(key: string, ttlMs: number): Promise<{ token: string } | null>;
  renew(key: string, token: string, ttlMs: number): Promise<boolean>;
  release(key: string, token: string): Promise<void>;
}

/** Redis 双实例 env 名（70 §8.1）。 */
export const REDIS_ENV = {
  queueUrl: 'REDIS_QUEUE_URL',
  hotUrl: 'REDIS_HOT_URL',
} as const;
