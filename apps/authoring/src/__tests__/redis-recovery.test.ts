import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../platform/config/env.js';
import { attachBullErrorHandler } from '../platform/infra/queue.js';
import { closeRedis, getHotRedis, getQueueRedis } from '../platform/infra/redis.js';

const env = {
  REDIS_QUEUE_URL: 'redis://127.0.0.1:6379/0',
  REDIS_HOT_URL: 'redis://127.0.0.1:6380/0',
} as Env;

afterEach(async () => {
  await closeRedis();
});

describe('Redis dependency recovery', () => {
  it('keeps retrying both clients with a bounded delay after repeated connection failures', () => {
    const queue = getQueueRedis(env);
    const hot = getHotRedis(env);
    const clients = [queue, hot];

    for (const client of clients) {
      const retryStrategy = client.options.retryStrategy;
      expect(retryStrategy).toBeTypeOf('function');
      expect(retryStrategy?.(1)).toBe(200);
      expect(retryStrategy?.(2)).toBe(400);
      expect(retryStrategy?.(10)).toBe(2_000);
      expect(retryStrategy?.(1_000)).toBe(2_000);
    }

    expect(queue.options.maxRetriesPerRequest).toBeNull();
    expect(hot.options.maxRetriesPerRequest).toBe(1);
    expect(hot.options.connectTimeout).toBe(2_000);
  });

  it('handles BullMQ error events without exposing their payload to the observer', () => {
    const emitter = new EventEmitter();
    const notifications: unknown[][] = [];
    attachBullErrorHandler(emitter, (...args: unknown[]) => notifications.push(args));

    const sensitiveError = new Error('redis://user:password@queue.internal:6379/0');
    expect(() => emitter.emit('error', sensitiveError)).not.toThrow();
    expect(notifications).toEqual([[]]);
  });

  it('installs a safe no-op BullMQ error listener when no observer is provided', () => {
    const emitter = attachBullErrorHandler(new EventEmitter());

    expect(emitter.listenerCount('error')).toBe(1);
    expect(() => emitter.emit('error', new Error('queue restart'))).not.toThrow();
  });
});
