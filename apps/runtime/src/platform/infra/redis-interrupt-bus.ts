import type { Env } from '../config/env.js';
import { getRedis, getRedisSubscriber } from './redis.js';

const INTERRUPT_CHANNEL = 'rt:turn:interrupt';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const logFailure = (operation: string, err: unknown): void => {
  process.stderr.write(
    `[redis-interrupt-bus] ${operation} failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
};

export interface InterruptRequest {
  readonly sessionId: string;
  readonly runId: string;
}

export function encodeInterruptRequest(request: InterruptRequest): string {
  if (!UUID_PATTERN.test(request.sessionId) || !UUID_PATTERN.test(request.runId)) {
    throw new Error('interrupt request requires canonical UUIDs');
  }
  return JSON.stringify({ sessionId: request.sessionId, runId: request.runId });
}

export function decodeInterruptRequest(raw: string): InterruptRequest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'sessionId') ||
    !Object.hasOwn(value, 'runId')
  ) {
    return undefined;
  }
  const request = value as { sessionId?: unknown; runId?: unknown };
  return typeof request.sessionId === 'string' &&
    typeof request.runId === 'string' &&
    UUID_PATTERN.test(request.sessionId) &&
    UUID_PATTERN.test(request.runId)
    ? { sessionId: request.sessionId, runId: request.runId }
    : undefined;
}

export interface InterruptBus {
  publish(request: InterruptRequest): void;
  subscribe(cb: (request: InterruptRequest) => void): () => void;
}
export function createInterruptBus(): InterruptBus {
  const listeners = new Set<(request: InterruptRequest) => void>();
  return {
    publish(request) {
      listeners.forEach((listener) => listener(request));
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
export function createRedisInterruptBus(env: Env): InterruptBus {
  const listeners = new Set<(request: InterruptRequest) => void>();
  let subscribed = false;
  return {
    publish(request) {
      let encoded: string;
      try {
        encoded = encodeInterruptRequest(request);
      } catch (err) {
        logFailure('encode', err);
        return;
      }
      void getRedis(env)
        .publish(INTERRUPT_CHANNEL, encoded)
        .catch((err) => logFailure('publish', err));
    },
    subscribe(cb) {
      listeners.add(cb);
      if (!subscribed) {
        subscribed = true;
        const subscriber = getRedisSubscriber(env);
        subscriber.on('message', (channel, raw) => {
          if (channel !== INTERRUPT_CHANNEL) return;
          const request = decodeInterruptRequest(raw);
          if (request) listeners.forEach((listener) => listener(request));
        });
        void subscriber.subscribe(INTERRUPT_CHANNEL).catch((err) => logFailure('subscribe', err));
      }
      return () => listeners.delete(cb);
    },
  };
}
