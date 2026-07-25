// worker 进程：BullMQ 消费 task-pipeline 队列 + 每 60s 一轮租约对账。
//   - 消费：job 触发 → runPipeline（领租约防双跑 → 提取流水线 → 终态写回）。
//   - 对账：把 running+extract 且租约过期（或从未被认领且长时间无更新）的任务重新入队；
//     重复触发由 claimTask 的租约条件吸收，多投无害。
//   tasks 表是状态真源，BullMQ 只触发执行。
import { hostname } from 'node:os';
import { Worker } from 'bullmq';
import pino, { type Logger } from 'pino';
import { loadEnv, type Env } from '../platform/config/env.js';
import { startNodeObservability, currentTraceLogFields } from '../platform/observability/node.js';
import { getPool } from '../platform/infra/db.js';
import { getHotRedis } from '../platform/infra/redis.js';
import {
  attachBullErrorHandler,
  bullConnectionFor,
  createBullQueuePort,
  QUEUE_PREFIX,
  TASK_PIPELINE_QUEUE,
} from '../platform/infra/queue.js';
import { createS3ObjectStore } from '../platform/infra/object-store.js';
import { createLlmGateway, resolveLlmProvider } from '../platform/infra/llm/index.js';
import { createPgAuditSink } from '../platform/infra/llm/audit.js';
import { RedisEventStream } from '../platform/sse/event-stream.js';
import { runPipeline, type PipelineDeps } from '../modules/task/pipeline.js';
import { findStalledExtractTasks } from '../modules/task/repo.js';
import {
  purgeExpiredUploadParts,
  purgeStaleUploadParts,
  reconcileExpiredUploadTasks,
} from '../modules/task/service.js';

/** 租约对账周期。 */
const RECONCILE_INTERVAL_MS = 60_000;

function buildWorkerLogger(env: Env): Logger {
  return pino({
    level: env.LOG_LEVEL ?? 'info',
    base: { service: env.OTEL_SERVICE_NAME, process: 'worker' },
    formatters: { log: (obj: Record<string, unknown>) => obj },
    ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
  });
}

async function main(): Promise<void> {
  const env = loadEnv();
  const observability = startNodeObservability(env, 'worker');
  const log = buildWorkerLogger(env);

  const db = getPool(env);
  const deps: PipelineDeps = {
    db,
    objectStore: createS3ObjectStore(env),
    stream: new RedisEventStream(getHotRedis(env)),
    // 网关不带内部审计 sink（避免与 extract.ts 按 task_id 记账双写）；审计经 deps.audit 落库。
    llm: createLlmGateway(env),
    audit: createPgAuditSink(db, (err) =>
      log.warn({ err }, 'audit_llm_calls write failed (ignored)'),
    ),
    leaseOwner: `${hostname()}#${process.pid}`,
    model: resolveLlmProvider(env).model,
    log,
  };

  // —— 消费 task-pipeline ——
  const worker = attachBullErrorHandler(
    new Worker(
      TASK_PIPELINE_QUEUE,
      async (job) => {
        const { taskId, traceId } = job.data as { taskId: string; traceId?: string };
        const trace = traceId ?? job.id ?? taskId;
        const outcome = await runPipeline(deps, taskId, trace);
        log.info({ taskId, outcome, ...currentTraceLogFields(trace) }, 'pipeline finished');
        return outcome; // 仅供 BullMQ 记录；tasks 表才是状态真源。
      },
      {
        prefix: QUEUE_PREFIX, // 必须与生产端 Queue 一致，否则入队了收不到。
        connection: bullConnectionFor(env),
        // 内存护栏：导入 pipeline 会把整份语料多副本驻留内存，并发>1 会成倍放大峰值内存
        // （海量历史下直接 OOM）。降为 1 顺序处理，配合容器 mem_limit 稳住内存上界。
        concurrency: 1,
        // 默认 30s 的锁在大分片同步解析阻塞事件循环或 Redis 抖动时容易被误判过期
        // （锁丢失后任务会被重派，靠 DB 租约吸收成 not_claimed 噪音）。放宽到 120s。
        lockDuration: 120_000,
      },
    ),
    () => log.error('bullmq worker error (details suppressed; readiness remains authoritative)'),
  );
  worker.on('failed', (job, err) => {
    // runPipeline 已把业务失败落 tasks.failed；这里记框架级失败（连接/反序列化/未捕获异常）。
    log.error({ err, bullJobId: job?.id, data: job?.data }, 'bullmq job failed (framework-level)');
  });

  // —— 租约对账循环：过期租约/丢失入队的任务重投（claimTask 吸收重复触发）——
  const queue = createBullQueuePort(env);
  const reconcile = async (): Promise<void> => {
    try {
      const expiredUploads = await reconcileExpiredUploadTasks(db, {
        traceId: 'worker-upload-reconcile',
      });
      if (expiredUploads > 0) {
        log.warn({ count: expiredUploads }, 'reconcile: expired upload tasks marked failed');
      }
      const purge = await purgeExpiredUploadParts(db, deps.objectStore);
      if (purge.purged > 0) {
        log.info({ count: purge.purged }, 'reconcile: expired upload raw parts purged');
      }
      if (purge.failedTaskIds.length > 0) {
        log.warn(
          { taskIds: purge.failedTaskIds },
          'reconcile: expired upload purge failed (will retry next round)',
        );
      }
      const stale = await purgeStaleUploadParts(db, deps.objectStore);
      if (stale.purged > 0) {
        log.info({ count: stale.purged }, 'reconcile: replaced upload parts purged');
      }
      if (stale.failedTaskIds.length > 0) {
        log.warn(
          { taskIds: stale.failedTaskIds },
          'reconcile: replaced upload purge failed (will retry next round)',
        );
      }
      const stalled = await findStalledExtractTasks(db);
      for (const taskId of stalled) {
        await queue.enqueue(TASK_PIPELINE_QUEUE, taskId);
        log.warn({ taskId }, 'reconcile: stalled extract task re-enqueued');
      }
    } catch (err) {
      log.error({ err }, 'reconcile round failed (will retry next round)');
    }
  };
  const reconcileTimer = setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);
  void reconcile(); // 启动即跑一轮，重启后尽快接住悬空任务。

  log.info(
    {
      leaseOwner: deps.leaseOwner,
      queue: TASK_PIPELINE_QUEUE,
      observability: observability.enabled,
    },
    'worker booted',
  );

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return; // 重复信号无视：只跑一次关停
    shuttingDown = true;
    clearInterval(reconcileTimer);
    // 兜底：worker.close() 等活动 job 跑完（提取可长达 lockDuration=120s，远超容器 10s 停机宽限）；
    // 到点强制退出，被中断的任务由租约对账下一轮重投（claimTask 吸收，多投无害）。
    const force = setTimeout(() => {
      log.error(`[worker] 关停在 ${env.SHUTDOWN_TIMEOUT_MS}ms 内未完成，强制退出`);
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS);
    force.unref();
    void worker
      .close()
      .then(() => observability.shutdown())
      .then(() => process.exit(0))
      .catch((err) => {
        log.error({ err }, '[worker] 关停出错，强制退出');
        process.exit(1);
      });
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, shutdown);
}

main().catch((err) => {
  console.error('[worker] fatal', err);
  process.exit(1);
});
