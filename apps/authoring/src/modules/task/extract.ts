// LLM 提取：把切好的去敏段落分批喂 LLM 网关，归纳出结构化能力列表（name/summary/kind/instructions）。
//   - 上游降级/坏输出/无 key：标记对应批次 degraded，不生成任何占位能力。
//   - 每次 LLM 调用记 audit_llm_calls（经注入的 LlmAuditSink，归属 task_id）。
import { jsonrepair } from 'jsonrepair';
import type { CapabilityInputField, LlmGatewayPort } from '@cb/shared';
import type { LlmAuditSink } from '../../platform/infra/llm/types.js';
import { isBlockedCapabilityLabel } from '../../platform/text/session-noise.js';

/** 提取输入段（去敏后正文）。 */
export interface ExtractSegment {
  title: string;
  content: string;
  project?: string;
  messageCount: number;
}

/** 提取产出（未落库的能力草稿；写 MinIO/insert 由 pipeline 负责）。 */
export interface CapabilityDraft {
  name: string;
  summary: string;
  kind: string;
  instructions: string;
  /** 试用开场表单字段（LLM 建议；坏条目在解析时丢弃，可为空）。 */
  inputs: CapabilityInputField[];
  /** 开场提示语（试用页一键填入）。 */
  starterPrompts: string[];
  meta: Record<string, unknown>;
}

export interface ExtractDeps {
  llm: LlmGatewayPort;
  audit: LlmAuditSink;
  /** 审计记账用的模型名（网关内部已定，这里只为落库可读）。 */
  model?: string;
  /** 诊断日志（批次降级只记长度与安全错误分类，info 记每批耗时；缺省静默）。 */
  log?: { warn: (o: object, m: string) => void; info?: (o: object, m: string) => void };
}

export interface ExtractInput {
  taskId: string;
  ownerUserId: string;
  traceId: string;
  segments: ExtractSegment[];
  /** 每归纳完一批回调一次，报已处理段数/总段数（pipeline 据此推进度）。 */
  onBatchDone?: (segmentsDone: number, segmentsTotal: number) => Promise<void>;
}

export interface ExtractOutput {
  items: CapabilityDraft[];
  /** 任一批发生上游降级或输出不可解析；合法空数组不算降级。 */
  degraded: boolean;
}

/** 每批喂给 LLM 的段数（控制单次 prompt 体量）。 */
const BATCH_SIZE = 8;
/** 单段正文喂给 LLM 的截断长度。 */
const SEGMENT_SAMPLE_CHARS = 1500;
/** 本模块消费段正文的最长字符数；流水线据此在去敏后立刻丢弃不会进入 prompt 的尾部。 */
export const SEGMENT_CONTENT_MAX_CHARS = SEGMENT_SAMPLE_CHARS;
/** 全任务能力项上限（防 LLM 发散刷屏）。 */
const MAX_CAPABILITIES = 12;
/**
 * 批间并发路数。实测（2026-07-05，44 段 6 批）单批时延 26-82s 且方差大，8 路让常规上传
 * 一波跑完、提取步时长 ≈ 最慢一批。worker 任务级并发 2 → 进程内最多 16 路 LLM 调用在飞；
 * 网关限流桶 60 次/分钟且初始满额，单次上传超 60 批（480 段）才可能触限，触限批按现有语义降级。
 */
const EXTRACT_CONCURRENCY = 8;

/**
 * 提取主入口：分批归纳（批间并发）→ 跨批按名去重合并。
 * 不抛上游错误：网关异常按该批降级处理（部分批成功仍产出）。
 * 合法空数组保留为正常空结果；全批降级返回空 items + degraded=true，由流水线收口失败。
 * 并发只改时间不改结果：产出按批下标序合并，同输入必得同输出。
 */
export async function extractCapabilities(
  deps: ExtractDeps,
  input: ExtractInput,
): Promise<ExtractOutput> {
  const batches: ExtractSegment[][] = [];
  for (let i = 0; i < input.segments.length; i += BATCH_SIZE) {
    batches.push(input.segments.slice(i, i + BATCH_SIZE));
  }

  // 结果按批下标存放，完成乱序不影响合并顺序。
  const results = new Array<CapabilityDraft[] | null>(batches.length).fill(null);
  let nextIndex = 0;
  let segmentsDone = 0;
  // 进度上报经 promise 链串行化：reporter 的 done/phrase 无单调守卫，
  // 乱序上报会让「已分析 x/y」倒退；链上值只增不减，落库/推帧顺序与值序一致。
  let reportChain: Promise<void> = Promise.resolve();

  const runWorker = async (): Promise<void> => {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= batches.length) return;
      const startedAt = performance.now(); // 单调钟：墙钟跳变不影响耗时差值
      results[i] = await extractBatch(deps, input, batches[i]!);
      deps.log?.info?.(
        {
          batchIndex: i,
          segments: batches[i]!.length,
          ms: Math.round(performance.now() - startedAt),
          drafts: results[i]?.length ?? null, // null = 本批降级
        },
        'extract batch done',
      );
      segmentsDone += batches[i]!.length;
      const done = segmentsDone;
      reportChain = reportChain.then(() => input.onBatchDone?.(done, input.segments.length));
      await reportChain; // 上报失败中止整个提取（与串行版语义一致），且链上无未处理拒绝。
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(EXTRACT_CONCURRENCY, batches.length) }, runWorker),
  );

  const merged: CapabilityDraft[] = [];
  const seenNames = new Set<string>();
  let degraded = false;
  for (const drafts of results) {
    if (drafts === null) {
      degraded = true;
      continue;
    }
    for (const d of drafts) {
      const nameKey = d.name.replace(/\s+/g, '').toLowerCase();
      if (seenNames.has(nameKey)) continue;
      seenNames.add(nameKey);
      if (merged.length < MAX_CAPABILITIES) merged.push(d);
    }
  }

  return { items: merged, degraded };
}

/** 归纳一批段落。返回 null 表示本批降级（上游不稳/坏输出），调用方计 degraded。 */
async function extractBatch(
  deps: ExtractDeps,
  input: ExtractInput,
  segments: ExtractSegment[],
): Promise<CapabilityDraft[] | null> {
  const prompt = buildPrompt(segments);
  let result;
  try {
    result = await deps.llm.complete(prompt, {
      taskClass: 'extract',
      traceId: input.traceId,
      ownerUserId: input.ownerUserId,
    });
  } catch {
    return null; // 网关异常 escape：本批降级，不阻塞其余批。
  }

  await recordAudit(deps, input, result.usage, result.degraded);
  if (result.degraded || !result.text) {
    deps.log?.warn(
      { degraded: result.degraded, textLen: result.text?.length ?? 0 },
      'extract batch degraded: gateway degraded or empty text',
    );
    return null;
  }

  const diag: ParseDiag = {};
  const parsed = parseCapabilityJson(result.text, diag);
  if (parsed === null) {
    deps.log?.warn(
      {
        textLen: result.text.length,
        // 只含固定分类和数字位置，不保留 JSON.parse 可能附带的模型正文片段。
        parseError: diag.parseError ?? null,
      },
      'extract batch degraded: model text not parseable as capability array',
    );
    return null;
  }
  return parsed;
}

export function buildPrompt(segments: ExtractSegment[]): string {
  const body = segments
    .map((s, i) => {
      const head = `【段 ${i + 1}】标题：${s.title}${s.project ? `（项目：${s.project}）` : ''}`;
      return `${head}\n${s.content.slice(0, SEGMENT_SAMPLE_CHARS)}`;
    })
    .join('\n\n');
  return (
    `下面是一位用户与 coding agent 的若干段去敏工作会话。请从中归纳出可复用的「能力项」——` +
    `每个能力项是一类可以反复交给 AI 执行的工作流（不是复述单次会话）。\n` +
    `每个能力项输出六个字段：\n` +
    `  name：中文能力名，≤12 字，像一个 mini 应用的名字；\n` +
    `  summary：一句话说明这个能力帮用户完成什么；\n` +
    `  kind：能力类型，从「写作 / 编码 / 分析 / 结构化文档 / 工作流」中选一个；\n` +
    `  instructions：给执行这个能力的 AI 的系统提示词（怎么干活的完整知识，含步骤与输出要求），200-800 字。\n` +
    `  inputs：使用者开始前需要填的输入字段，1-4 个，每个是 ` +
    `{"key":"英文小写下划线","label":"中文名","type":"string|text|number|enum","required":true|false,"options":["仅 enum 给候选"]}；` +
    `只列真正影响产出的字段，没有就给空数组。\n` +
    `  starterPrompts：1-3 条开场提示语，替使用者说出第一句需求（中文完整句子）。\n` +
    `只归纳确有支撑的能力，最多 4 个；没有可归纳的就输出空数组。\n` +
    `严格输出 JSON 数组：[{"name":"...","summary":"...","kind":"...","instructions":"...",` +
    `"inputs":[...],"starterPrompts":["..."]}]，不要其它内容。\n\n` +
    body
  );
}

/** 解析诊断出参：首个严格 JSON.parse 的安全错误分类与数字位置，不含模型正文。 */
export interface ParseDiag {
  parseError?: string;
}

/**
 * 容错解析 LLM 输出的能力数组。模型常在数组前后加说明文字或 markdown 围栏，
 * 且说明文字里可能含方括号——贪婪正则会抓出非法 JSON。改为括号配平扫描：
 * 从每个 '[' 起点按字符串感知的深度计数找到配对 ']'，逐个候选先严格 JSON.parse，
 * 失败再用 jsonrepair 修复重试（覆盖字符串内裸控制字符、尾逗号、未转义引号、
 * 截断等模型常见毛病，见 issue #57）。坏 JSON / 坏条目 → 丢弃。
 */
export function parseCapabilityJson(text: string, diag?: ParseDiag): CapabilityDraft[] | null {
  const arr = extractFirstJsonArray(text, diag);
  if (!Array.isArray(arr)) return null;
  const out: CapabilityDraft[] = [];
  for (const item of arr) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim().slice(0, 24) : '';
    const instructions = typeof o.instructions === 'string' ? o.instructions.trim() : '';
    if (!name || !instructions || isBlockedCapabilityLabel(name)) continue;
    out.push({
      name,
      summary: typeof o.summary === 'string' ? o.summary.trim().slice(0, 200) : '',
      kind: typeof o.kind === 'string' ? o.kind.trim().slice(0, 20) : '工作流',
      instructions,
      inputs: coerceInputFields(o.inputs),
      starterPrompts: coerceStarterPrompts(o.starterPrompts),
      meta: { origin: 'llm' },
    });
  }
  // 明确的 [] 是“没有可归纳能力”的合法结果；非空数组若所有条目都坏，则属于模型坏输出。
  if (arr.length > 0 && out.length === 0) return null;
  return out;
}

const INPUT_FIELD_TYPES = new Set(['string', 'text', 'number', 'enum']);

/** 容错收敛 LLM 给的开场表单字段：坏条目丢弃、enum 无候选降级为 string、最多 4 个。 */
export function coerceInputFields(raw: unknown): CapabilityInputField[] {
  if (!Array.isArray(raw)) return [];
  const out: CapabilityInputField[] = [];
  const seenKeys = new Set<string>();
  for (const item of raw) {
    if (out.length >= 4) break;
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const key = typeof o.key === 'string' ? o.key.trim().slice(0, 40) : '';
    const label = typeof o.label === 'string' ? o.label.trim().slice(0, 40) : '';
    if (!key || !label || seenKeys.has(key)) continue;
    seenKeys.add(key);
    const options = Array.isArray(o.options)
      ? o.options.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      : [];
    let type = typeof o.type === 'string' && INPUT_FIELD_TYPES.has(o.type) ? o.type : 'string';
    if (type === 'enum' && options.length === 0) type = 'string';
    out.push({
      key,
      label,
      type: type as CapabilityInputField['type'],
      required: o.required === true,
      ...(type === 'enum' ? { options: options.slice(0, 8) } : {}),
    });
  }
  return out;
}

/** 容错收敛开场提示语：非字符串/空串丢弃，最多 3 条。 */
export function coerceStarterPrompts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim().slice(0, 200))
    .slice(0, 3);
}

/**
 * 从自由文本中提取第一个能力形 JSON 数组（字符串感知的括号配平扫描）。
 * 优先返回「能力形」候选（至少一个条目带非空字符串 name）：外层数组坏掉时，
 * 后续 '[' 起点会撞上条目里的 inputs 嵌套数组，无条件收下会拿空数组掩盖真实病灶
 * （issue #57）。非能力形的首个合法数组（如空数组）记为兜底返回，保住
 * 「模型明说没能力可归纳」的空数组语义。其它非空、非能力形数组不是合法结果，不作兜底。
 */
function extractFirstJsonArray(text: string, diag?: ParseDiag): unknown | null {
  let emptyArrayFallback: unknown[] | null = null;
  for (let start = text.indexOf('['); start !== -1; start = text.indexOf('[', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = inString; // 反斜杠只在字符串内是转义
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '[') depth += 1;
      else if (ch === ']') {
        depth -= 1;
        if (depth === 0) {
          const parsed = parseCandidate(text.slice(start, i + 1), diag);
          if (isCapabilityShapedArray(parsed)) return parsed;
          if (emptyArrayFallback === null && Array.isArray(parsed) && parsed.length === 0) {
            emptyArrayFallback = parsed;
          }
          break; // 本起点不是能力形数组：换下一个 '[' 起点
        }
      }
    }
  }
  // 没有任何能力形候选：典型是输出截断导致外层数组没闭合，配平扫描永远走不到
  // 外层候选。把首个 '[' 到结尾整段交给 jsonrepair 补全兜底一把，修出来的结果
  // 仍要过能力形校验，修歪了就丢弃。
  const start = text.indexOf('[');
  if (start !== -1) {
    const parsed = parseCandidate(text.slice(start), diag);
    if (isCapabilityShapedArray(parsed)) return parsed;
  }
  return emptyArrayFallback;
}

/** 单个候选串：严格 JSON.parse 失败 → jsonrepair 修复重试；都失败返回 null。 */
function parseCandidate(candidate: string, diag?: ParseDiag): unknown | null {
  try {
    return JSON.parse(candidate);
  } catch (e) {
    if (diag && diag.parseError === undefined) {
      diag.parseError = safeJsonParseError(e);
    }
  }
  try {
    return JSON.parse(jsonrepair(candidate));
  } catch {
    return null;
  }
}

/** Node 的 JSON.parse 错误可能回显输入片段；日志只保留可枚举分类和纯数字坐标。 */
function safeJsonParseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const position = /\bposition\s+(\d+)\b/i.exec(message)?.[1];
  const lineColumn = /\bline\s+(\d+)\s+column\s+(\d+)\b/i.exec(message);
  const coords = [
    ...(position ? [`position=${position}`] : []),
    ...(lineColumn ? [`line=${lineColumn[1]}`, `column=${lineColumn[2]}`] : []),
  ];
  return coords.length > 0 ? `JSON_PARSE_FAILED ${coords.join(' ')}` : 'JSON_PARSE_FAILED';
}

/** 能力形数组：至少一个条目是带非空字符串 name 的对象。 */
function isCapabilityShapedArray(v: unknown): v is unknown[] {
  return (
    Array.isArray(v) &&
    v.some(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { name?: unknown }).name === 'string' &&
        (item as { name: string }).name.trim().length > 0,
    )
  );
}

async function recordAudit(
  deps: ExtractDeps,
  input: ExtractInput,
  usage: { promptTokens: number; completionTokens: number; costMicros: number },
  degraded: boolean,
): Promise<void> {
  try {
    await deps.audit.record({
      ownerUserId: input.ownerUserId,
      taskId: input.taskId,
      taskClass: 'extract',
      model: deps.model ?? '',
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costMicros: usage.costMicros,
      degraded,
      retries: 0,
      traceId: input.traceId,
    });
  } catch {
    // 审计失败不阻塞提取（非计费真源）。
  }
}
