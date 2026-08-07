// 提取流水线（worker 执行体）：逐片拉分片 → 解析 → 脱敏 → 截断成紧凑段 → LLM 归纳 → 逐项落能力项 → 清理分片 → 终态。
//   - 逐片消费：一次只读一个分片进内存，解析去敏后立刻截断到 extract 会消费的长度并释放原文，
//     跨片按内容哈希去重。真实规模（上百分片、上千段）下内存峰值 = 单片大小 + 紧凑段列表，
//     不再随上传总量线性增长（全量拼接曾把 worker 撑爆，见 issue #25）。
//   - claimTask 领租约防双跑（0 行 = 已被认领，直接跳过；对账循环重投的重复触发在这里被吸收）。
//   - 进度真源是 tasks.meta.progress（SSE state_snapshot 从它读全量）；每步同时把帧推 redis_hot 流。
//   - 失败：last_error 写人话错误体（errorBodyFor 组装）、status=failed、done 帧带 error。
//   - 终态写回都走 service.transition（乐观锁，0 行 = 已被接管，安全退出不发终态帧）。
import { randomUUID } from 'node:crypto';
import {
  CapabilityDefinitionSchema,
  ErrorCode,
  PIPELINE_SUBTASKS,
  errorBodyFor,
  mergeReports,
  redactBatch,
  type ErrorBody,
  type ErrorCodeValue,
  type LlmGatewayPort,
  type ObjectStorePort,
  type ProgressView,
  type RedactionReportView,
  type SubtaskStatus,
} from '@cb/shared';
import type { Queryable } from '../../platform/infra/db.js';
import type { TaskEventBridge } from '../../platform/sse/event-stream.js';
import type { LlmAuditSink } from '../../platform/infra/llm/types.js';
import { transition } from './service.js';
import {
  claimTask,
  markUploadProcessed,
  mergeUploadMeta,
  partsState,
  readUploadForPipeline,
  renewLease,
  saveTaskProgress,
} from './repo.js';
import { purgeRawObjects, RAW_BUCKET } from './raw-purge.js';
import {
  detectSessionSource,
  parseSessions,
  splitBundle,
  type ParseStats,
  type SessionSource,
} from './session-parse.js';
import { SEGMENT_CONTENT_MAX_CHARS, extractCapabilities, type ExtractSegment } from './extract.js';
import { insertCapability } from '../capability/index.js';

/** 能力项可运行定义所在桶（长期保留，与会被清除的原始件分桶）。 */
export const CAPABILITY_BUCKET = 'combo-artifacts' as const;

/** 能力项定义对象键。 */
export function capabilityDefinitionKey(capabilityId: string): string {
  return `capabilities/${capabilityId}/definition.json`;
}

/** 逐片循环里每处理这么多分片续一次租约（真实规模上百分片，处理时长会超过单次租期）。 */
const LEASE_RENEW_EVERY_PARTS = 20;

export interface PipelineDeps {
  db: Queryable;
  objectStore: ObjectStorePort;
  stream: TaskEventBridge;
  llm: LlmGatewayPort;
  audit: LlmAuditSink;
  /** 本 worker 标识（hostname#pid），领租约用。 */
  leaseOwner: string;
  /** 审计记账用的模型名。 */
  model?: string;
  log?: {
    info: (o: object, m: string) => void;
    warn: (o: object, m: string) => void;
    error: (o: object, m: string) => void;
  };
}

export type PipelineOutcome = 'succeeded' | 'failed' | 'not_claimed' | 'superseded';

/** 带内部 code 的流水线失败（人话信封由 code 经 errorBodyFor 组装）。 */
class PipelineFailure extends Error {
  constructor(
    readonly code: ErrorCodeValue,
    message: string,
  ) {
    super(message);
    this.name = 'PipelineFailure';
  }
}

/** 进度上报器：持久化 tasks.meta.progress（快照真源）+ 推增量帧到 redis 流。 */
class ProgressReporter {
  private readonly view: ProgressView;

  constructor(
    private readonly db: Queryable,
    private readonly stream: TaskEventBridge,
    private readonly taskId: string,
  ) {
    this.view = {
      percent: 0,
      phrase: '正在准备…',
      subtasks: PIPELINE_SUBTASKS.map((s) => ({ key: s.key, label: s.label, status: 'pending' })),
    };
  }

  /** 子任务点亮 + 全量快照帧（子任务变化只在 state_snapshot 里承载，前端据此逐条点亮）。 */
  async subtask(
    key: string,
    status: SubtaskStatus,
    percent: number,
    phrase: string,
  ): Promise<void> {
    for (const s of this.view.subtasks) if (s.key === key) s.status = status;
    this.view.percent = Math.max(this.view.percent, percent); // 单调不倒退
    this.view.phrase = phrase;
    await saveTaskProgress(this.db, this.taskId, this.view);
    await this.stream.publish(this.taskId, {
      event: 'state_snapshot',
      payload: { progress: this.view },
    });
  }

  /** 步内量化进度（增量 progress 帧；持久化同步跟上，断线重连不丢）。 */
  async progress(
    percent: number,
    phrase: string,
    counts?: { done: number; total: number; unit: string },
  ): Promise<void> {
    this.view.percent = Math.max(this.view.percent, percent);
    this.view.phrase = phrase;
    if (counts) {
      this.view.done = counts.done;
      this.view.total = counts.total;
      this.view.unit = counts.unit;
    }
    await saveTaskProgress(this.db, this.taskId, this.view);
    await this.stream.publish(this.taskId, {
      event: 'progress',
      payload: { percent: this.view.percent, phrase, ...(counts ?? {}) },
    });
  }

  snapshot(): ProgressView {
    return this.view;
  }
}

/**
 * 流水线主入口。返回值仅供日志/BullMQ 记录；tasks 表才是状态真源。
 * 'not_claimed'：租约被占（重复触发），静默跳过。'superseded'：跑完落终态时 0 行（已被接管）。
 */
export async function runPipeline(
  deps: PipelineDeps,
  taskId: string,
  traceId: string,
): Promise<PipelineOutcome> {
  const claimed = await claimTask(deps.db, { taskId, leaseOwner: deps.leaseOwner });
  if (!claimed) return 'not_claimed';

  const reporter = new ProgressReporter(deps.db, deps.stream, taskId);
  try {
    const capabilityCount = await execute(deps, taskId, traceId, claimed.ownerUserId, reporter);

    // 终态：extract+succeeded（乐观锁 0 行 = 已被接管，不发终态帧）。
    const done = await transition(
      deps.db,
      taskId,
      { step: 'extract', status: 'running' },
      { status: 'succeeded', lastError: null, retry: 'reset' },
    );
    if (!done) return 'superseded';
    await deps.stream.publish(taskId, {
      event: 'done',
      payload: { status: 'succeeded', result: { capabilityCount } },
    });
    return 'succeeded';
  } catch (err) {
    const code = err instanceof PipelineFailure ? err.code : ErrorCode.INTERNAL;
    deps.log?.error({ err, taskId, traceId, code }, 'pipeline failed');
    const { body } = errorBodyFor(code, traceId);
    const failed = await transition(
      deps.db,
      taskId,
      { step: 'extract', status: 'running' },
      { status: 'failed', lastError: body },
    );
    if (!failed) return 'superseded';
    await publishFailure(deps.stream, taskId, body);
    return 'failed';
  }
}

/** 失败帧序：先 error（完整对外信封）再 done（带同一信封）。 */
async function publishFailure(
  stream: TaskEventBridge,
  taskId: string,
  body: ErrorBody,
): Promise<void> {
  const envelope = { error: body };
  await stream.publish(taskId, { event: 'error', payload: envelope });
  await stream.publish(taskId, { event: 'done', payload: { status: 'failed', error: envelope } });
}

/** 流水线主体（成功路径）。返回产出的能力项数。 */
async function execute(
  deps: PipelineDeps,
  taskId: string,
  traceId: string,
  ownerUserId: string,
  reporter: ProgressReporter,
): Promise<number> {
  // 分步耗时（毫秒），最后汇总一条 info 日志——线上观测哪步是瓶颈。
  // 用单调钟（performance.now）而非墙钟：墙钟被 NTP 校正时差值会变成负数或虚高。
  const startedAt = performance.now();
  let stepStartedAt = startedAt;
  const stepMs: Record<string, number> = {};
  const markStep = (name: string): void => {
    const now = performance.now();
    stepMs[name] = Math.round(now - stepStartedAt);
    stepStartedAt = now;
  };

  // ① fetch：读上传行，取分片键清单。收齐后不存在拼接好的完整原始件，
  //    分片本身是「整文件打包」的合法文本单元，可以独立解析。
  await reporter.subtask('fetch', 'running', 2, '正在读取上传内容…');
  const upload = await readUploadForPipeline(deps.db, taskId);
  const partKeys = upload ? partsState(upload.parts).orderedKeys : [];
  if (partKeys.length === 0) {
    throw new PipelineFailure(ErrorCode.UPLOAD_NO_CONTENT, 'no landed parts');
  }
  await reporter.subtask('fetch', 'done', 6, `待处理 ${partKeys.length} 个分片`);
  markStep('fetch');

  // ②③ 逐片：解析 → 跨片去重 → 去敏 → 截断成紧凑段。每轮循环结束该片原文即可被回收，
  //    任意时刻内存里只有一个分片的全文加已积累的紧凑段（每段 ≤ SEGMENT_CONTENT_MAX_CHARS）。
  //    去敏在截断之前：截断可能把敏感串切成识别不出的半截，先抹干净再丢弃尾部。
  await reporter.subtask('redact', 'running', 8, '正在解析并抹掉隐私信息…');
  type CompactSegment = ExtractSegment & { happenedAt: string | null };
  const segments: CompactSegment[] = [];
  const seenHashes = new Set<string>();
  const redactionReports: RedactionReportView[] = [];
  const projects = new Set<string>();
  const sources = new Set<SessionSource>();
  let messageCount = 0;
  let badLineCount = 0;
  let duplicateSegmentCount = 0;
  let minTime: string | null = null;
  let maxTime: string | null = null;

  for (let p = 0; p < partKeys.length; p++) {
    let text: string;
    try {
      text = await deps.objectStore.getObjectText(RAW_BUCKET, partKeys[p]!);
    } catch (err) {
      throw new PipelineFailure(
        ErrorCode.DEPENDENCY_UNAVAILABLE,
        `part object unreadable: ${String(err)}`,
      );
    }
    const files = splitBundle(text);
    const inputs = (files.length > 0 ? files : [text]).map((fileText, i) => ({
      source: detectSessionSource(fileText),
      raw: fileText,
      sessionRef: `part-${p}-file-${i}`,
    }));
    const parsed = parseSessions(inputs);
    badLineCount += parsed.stats.badLineCount;
    duplicateSegmentCount += parsed.stats.duplicateSegmentCount;

    // 跨片去重：同一会话文件重传或跨片重复时只保留首次出现。
    const fresh = parsed.segments.filter((s) => !seenHashes.has(s.contentHash));
    duplicateSegmentCount += parsed.segments.length - fresh.length;
    const redacted = redactBatch(fresh.map((s) => s.content));
    redactionReports.push(redacted.report);
    fresh.forEach((s, i) => {
      seenHashes.add(s.contentHash);
      segments.push({
        title: s.title,
        content: redacted.texts[i]!.slice(0, SEGMENT_CONTENT_MAX_CHARS),
        ...(s.project ? { project: s.project } : {}),
        messageCount: s.messageCount,
        happenedAt: s.happenedAt,
      });
      messageCount += s.messageCount;
      sources.add(s.source);
      if (s.project) projects.add(s.project);
      if (s.happenedAt) {
        if (minTime === null || s.happenedAt < minTime) minTime = s.happenedAt;
        if (maxTime === null || s.happenedAt > maxTime) maxTime = s.happenedAt;
      }
    });

    if ((p + 1) % LEASE_RENEW_EVERY_PARTS === 0) {
      await renewLease(deps.db, { taskId, leaseOwner: deps.leaseOwner });
    }
    await reporter.progress(
      8 + Math.round(((p + 1) / partKeys.length) * 20),
      `已处理 ${p + 1} / ${partKeys.length} 个分片`,
      { done: p + 1, total: partKeys.length, unit: '片' },
    );
  }
  if (segments.length === 0) {
    throw new PipelineFailure(ErrorCode.UPLOAD_NO_CONTENT, 'no parseable segments');
  }
  markStep('parse');

  // ③ redact：已在上面逐片循环里按片完成（每片 redactBatch 后立刻截断到 SEGMENT_CONTENT_MAX_CHARS
  //    并释放原文）。main 的「全量 redactBatch 前先截到 REDACT_INPUT_CAP」内存护栏在逐片架构下
  //    不再需要——任意时刻内存里只有一个分片的去敏产物，不存在全量语料驻留。这里只聚合统计与报告。
  const parseStats: ParseStats = {
    segmentCount: segments.length,
    messageCount,
    projectCount: projects.size,
    timeSpan: minTime !== null && maxTime !== null ? { from: minTime, to: maxTime } : null,
    sources: [...sources],
    badLineCount,
    duplicateSegmentCount,
  };
  const redactionReport = mergeReports(redactionReports, redactionReports[0]!.rulesetVersion);
  await mergeUploadMeta(deps.db, taskId, {
    parseStats,
    redaction: redactionReport,
  });
  await reporter.subtask(
    'redact',
    'done',
    30,
    `已抹除 ${redactionReport.totalRedactions} 处隐私信息`,
  );
  markStep('redact');

  // ④ segment：段清单成型（按会话时间从新到旧，与整包解析时代的顺序一致）。
  await reporter.subtask('segment', 'running', 35, '正在切分会话段落…');
  segments.sort((a, b) => {
    if (a.happenedAt === b.happenedAt) return 0;
    if (a.happenedAt === null) return 1;
    if (b.happenedAt === null) return -1;
    return a.happenedAt < b.happenedAt ? 1 : -1;
  });
  await reporter.subtask('segment', 'done', 45, `已切出 ${segments.length} 段会话`);
  await renewLease(deps.db, { taskId, leaseOwner: deps.leaseOwner });
  markStep('segment');

  // ⑤ extract：LLM 归纳。部分批次降级仍保留真实产物；全量降级由本层失败收口。
  await reporter.subtask('extract', 'running', 48, '正在归纳提炼能力…');
  const extracted = await extractCapabilities(
    {
      llm: deps.llm,
      audit: deps.audit,
      ...(deps.model ? { model: deps.model } : {}),
      ...(deps.log ? { log: deps.log } : {}),
    },
    {
      taskId,
      ownerUserId,
      traceId,
      segments,
      onBatchDone: async (segmentsDone, segmentsTotal) => {
        // extract 是最慢的一步（真实 LLM 延迟下可超过租约的 10 分钟），每批完成都续租，
        // 否则租约过期后对账循环会把仍在跑的任务重新派出去，造成双跑与能力项重复落库。
        await renewLease(deps.db, { taskId, leaseOwner: deps.leaseOwner });
        const percent = 48 + Math.round((segmentsDone / segmentsTotal) * 30);
        await reporter.progress(percent, `已分析 ${segmentsDone} / ${segmentsTotal} 段会话`, {
          done: segmentsDone,
          total: segmentsTotal,
          unit: '段',
        });
      },
    },
  );
  // 全部批次都降级/输出不可解析时，不允许用空成功掩盖上游故障，更不能持久化占位能力。
  // 明确的模型空数组是 degraded=false，会继续走成功且 capabilityCount=0 的诚实结果。
  if (extracted.degraded && extracted.items.length === 0) {
    throw new PipelineFailure(
      ErrorCode.LLM_UPSTREAM_FAILED,
      'all extraction batches degraded or returned invalid output',
    );
  }
  await reporter.subtask('extract', 'done', 80, `归纳出 ${extracted.items.length} 个能力项`);
  await renewLease(deps.db, { taskId, leaseOwner: deps.leaseOwner });
  markStep('extract');

  // ⑥ persist：逐项校验 → 写 MinIO 定义 → 插 capabilities 行 → item-appended 帧（边生成边显示）。
  await reporter.subtask('persist', 'running', 82, '正在生成能力项…');
  let landed = 0;
  for (const draft of extracted.items) {
    const capabilityId = randomUUID();
    const definition = CapabilityDefinitionSchema.parse({
      version: 1,
      name: draft.name,
      summary: draft.summary,
      kind: draft.kind,
      instructions: draft.instructions,
      inputs: draft.inputs,
      starterPrompts: draft.starterPrompts,
      meta: draft.meta,
    });
    const storageKey = capabilityDefinitionKey(capabilityId);
    await deps.objectStore.putObject(
      CAPABILITY_BUCKET,
      storageKey,
      new TextEncoder().encode(JSON.stringify(definition)),
      { contentType: 'application/json' },
    );
    const view = await insertCapability(deps.db, {
      id: capabilityId,
      taskId,
      ownerUserId,
      name: definition.name,
      summary: definition.summary,
      kind: definition.kind,
      storageKey,
      meta: { ...draft.meta, ...(extracted.degraded ? { degraded: true } : {}) },
    });
    landed += 1;
    await deps.stream.publish(taskId, { event: 'item-appended', payload: { item: view } });
    await reporter.progress(
      82 + Math.round((landed / extracted.items.length) * 13),
      `已生成 ${landed} / ${extracted.items.length} 个能力项`,
      { done: landed, total: extracted.items.length, unit: '个' },
    );
  }

  // ⑦ 清理分片（合规：处理完按期清除，raw_purged_at 只在真删成功时打戳）。
  //    历史行可能还有拼接时代写下的 storage_key，非空时一并删。
  //    清理失败不翻整个任务，只记日志、留空戳等补清。
  let purged = false;
  try {
    const legacyRaw = upload?.storageKey ? [upload.storageKey] : [];
    await purgeRawObjects(deps.objectStore, [...legacyRaw, ...partKeys]);
    purged = true;
  } catch (err) {
    deps.log?.error({ err, taskId }, 'raw purge failed (task still succeeds)');
  }
  await markUploadProcessed(deps.db, taskId, purged);
  await reporter.subtask('persist', 'done', 100, `完成：${landed} 个能力项`);
  markStep('persist');
  deps.log?.info(
    {
      taskId,
      traceId,
      stepMs,
      totalMs: Math.round(performance.now() - startedAt),
      segments: segments.length,
      capabilities: landed,
      degraded: extracted.degraded,
    },
    'pipeline step timings',
  );

  return landed;
}
