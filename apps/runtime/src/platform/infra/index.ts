// 基础设施容器：数据库（含只读认证会话查询）、对象存储和会话事件能力聚成一个上下文并注入 Fastify。
// 业务 handler 经 req.server.infra 取用；TurnRunner 在 bootstrap 组装（依赖 modules/agent，不在本层建）。
import type { Env } from '../config/env.js';
import { getCreatorAgentPool, getPool, toRuntimeDb, type RuntimeDb } from './db.js';
import { createS3ObjectStore, type RuntimeObjectStore } from './object-store.js';
import { createRedisSessionEventBus, type SessionEventBus } from './event-bus.js';
import { createRedisSessionEventLog } from './redis-event-log.js';
import type { SessionEventLog } from '../../modules/agent/event-log.js';
import { createDisabledSandboxBackend, type SandboxBackend } from './sandbox-backend.js';
import type { VisibleTranscriptKmsBinding } from './visible-transcript-test-kms.js';

interface InfraLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface InfraContext {
  env: Env;
  db: RuntimeDb;
  /** Dedicated Consumer-only transaction identity; never aliases legacy Runtime or control API. */
  creatorAgentDb: RuntimeDb | null;
  objectStore: RuntimeObjectStore;
  bus: SessionEventBus;
  eventLog: SessionEventLog;
  sandbox: SandboxBackend;
  /** Test-only visible-transcript key binding; absent while the public feature remains disabled. */
  visibleTranscriptKms: VisibleTranscriptKmsBinding | null;
}

/** Feature-off avoids even loading the Test adapter module or reading its mounted keyring. */
export async function createVisibleTranscriptKmsForEnv(
  env: Env,
): Promise<VisibleTranscriptKmsBinding | null> {
  if (!env.CREATOR_AGENT_PUBLIC_ENABLED) return null;
  if (
    env.COMBO_ENVIRONMENT !== 'test' ||
    env.CREATOR_AGENT_VISIBLE_TRANSCRIPT_KMS_PROVIDER !== 'test-k8s-secret-file' ||
    !env.CREATOR_AGENT_VISIBLE_TRANSCRIPT_KMS_NAMESPACE ||
    !env.CREATOR_AGENT_VISIBLE_TRANSCRIPT_KMS_KEY_REF_PREFIX ||
    !env.CREATOR_AGENT_VISIBLE_TRANSCRIPT_KMS_KEYRING_FILE
  ) {
    throw new Error('[infra] visible transcript Test key provider configuration is invalid');
  }
  const { createVisibleTranscriptTestKmsBinding } =
    await import('./visible-transcript-test-kms.js');
  return createVisibleTranscriptTestKmsBinding(
    {
      keyNamespace: env.CREATOR_AGENT_VISIBLE_TRANSCRIPT_KMS_NAMESPACE,
      keyRefPrefix: env.CREATOR_AGENT_VISIBLE_TRANSCRIPT_KMS_KEY_REF_PREFIX,
      minimumKeyVersion: BigInt(env.CREATOR_AGENT_VISIBLE_TRANSCRIPT_KMS_MIN_KEY_VERSION),
    },
    { keyringFile: env.CREATOR_AGENT_VISIBLE_TRANSCRIPT_KMS_KEYRING_FILE },
  );
}

/** 组装基础设施上下文。沙箱关闭时连 Kubernetes 客户端模块都不加载。 */
export async function buildInfra(env: Env, log?: InfraLogger): Promise<InfraContext> {
  const db = toRuntimeDb(getPool(env));
  const creatorAgentDb = env.CREATOR_AGENT_PUBLIC_ENABLED
    ? toRuntimeDb(getCreatorAgentPool(env))
    : null;
  const sandbox = env.SANDBOX_TOOLS_ENABLED
    ? (await import('./kubernetes-sandbox-backend.js')).createKubernetesSandboxBackend(env, db, {
        log,
      })
    : createDisabledSandboxBackend();
  const visibleTranscriptKms = await createVisibleTranscriptKmsForEnv(env);
  return {
    env,
    db,
    creatorAgentDb,
    objectStore: createS3ObjectStore(env),
    bus: createRedisSessionEventBus(env),
    eventLog: createRedisSessionEventLog(env),
    sandbox,
    visibleTranscriptKms,
  };
}

export * from './db.js';
export * from './auth-session.js';
export * from './object-store.js';
export * from './event-bus.js';
export * from './llm.js';
export * from './redis.js';
export * from './redis-interrupt-bus.js';
export * from './redis-event-log.js';
export * from './sandbox-backend.js';
export * from './sandbox-capability.js';
export * from './sandbox-client.js';
