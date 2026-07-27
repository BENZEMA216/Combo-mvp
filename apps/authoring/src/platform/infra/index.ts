// 基础设施容器把数据库、Redis、队列、对象存储、大模型、邮件与认证限流端口注入 Fastify。
// 业务 handler 只经 req.server.infra 使用这些实例，不在模块内自行创建外部客户端。
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import type { LlmGatewayPort, ObjectStorePort, QueuePort } from '@cb/shared';
import type { Env } from '../config/env.js';
import { getPool } from './db.js';
import { getHotRedis, getQueueRedis } from './redis.js';
import { createBullQueuePort } from './queue.js';
import { createS3ObjectStore } from './object-store.js';
import { createLlmGateway } from './llm-gateway.js';
import { createResendEmailSender, type ResendEmailPort } from './resend.js';
import { createRedisAuthRateLimiter, type AuthRateLimitPort } from './auth-rate-limit.js';

/** 注入到 Fastify 的基础设施上下文（端口接口，实现可替换/可 mock）。 */
export interface InfraContext {
  env: Env;
  db: Pool;
  redisQueue: Redis;
  redisHot: Redis;
  queue: QueuePort;
  objectStore: ObjectStorePort;
  llm: LlmGatewayPort;
  resend: ResendEmailPort;
  authRateLimiter: AuthRateLimitPort;
}

/** 组装基础设施上下文（惰性客户端，骨架阶段不强连）。 */
export function buildInfra(env: Env): InfraContext {
  // 数据库实例同时注入大模型审计；热态 Redis 同时承载事件流与认证软限流。
  const db = getPool(env);
  const redisHot = getHotRedis(env);
  return {
    env,
    db,
    redisQueue: getQueueRedis(env),
    redisHot,
    queue: createBullQueuePort(env),
    objectStore: createS3ObjectStore(env),
    llm: createLlmGateway(env, db),
    resend: createResendEmailSender(env),
    authRateLimiter: createRedisAuthRateLimiter(redisHot),
  };
}

export * from './db.js';
export * from './redis.js';
export * from './queue.js';
export * from './object-store.js';
export * from './llm-gateway.js';
export * from './resend.js';
export * from './auth-rate-limit.js';
export * from './auth-session.js';
