// 会话解析（纯函数模块）：把 Claude / Codex 对话历史的原始 JSONL 解析为标准「段（segment）」。
//   层级：会话(session=一个 jsonl 文件/会话流) → 消息(message) → 段(segment)。本期一段 = 一会话。
//   Claude 与 Codex 的「原始格式 → 段」口径只此一处实现。
//
// 纯函数：不依赖 PG / Redis / 网络 / 对象存储。仅用 node:crypto 算 hash。
//   - 容错：半结构 / 缺字段 / 混合格式不崩；坏会话 / 坏行跳过并计入报告（不污染统计）。
//   - 去敏边界：本模块只解析与切段，不做去敏。流水线先切段再对段正文跑去敏（@cb/shared redactBatch）。
import { createHash } from 'node:crypto';
import { isPlatformPromptText } from '../../platform/text/session-noise.js';

/** 会话来源（一个文件只属一来源）。 */
export type SessionSource = 'claude' | 'codex';

// ---------------------------------------------------------------------------
// 输出类型
// ---------------------------------------------------------------------------

/** 解析出的标准消息。 */
export interface ParsedMessage {
  role: ParsedRole;
  /** 纯文本正文（content 块拼接 / 字符串原样；非文本块按占位拼接）。 */
  text: string;
  /** 消息发生时刻 ISO（可空：原始缺/坏时间）。 */
  happenedAt: string | null;
}

export type ParsedRole = 'user' | 'assistant' | 'system' | 'tool';

/** 解析出的标准段。 */
export interface ParsedSegment {
  source: SessionSource;
  /** 去重键：sha256(正文规范化) hex（稳定、跨进程可复算）。 */
  contentHash: string;
  /** 标题（首条 user 文本首行截断；空则回退占位）。 */
  title: string;
  /** 会话发生时刻 ISO（段级取首条有效消息时间；空则 null）。 */
  happenedAt: string | null;
  /** 项目（cwd 末段；空则 undefined）。 */
  project?: string;
  /** 段内消息条数（仅计入有正文的消息）。 */
  messageCount: number;
  /** 段正文（消息按 `role: text` 拼接）。 */
  content: string;
}

/** 单条会话原料（一个 jsonl 文件 / 会话流）。 */
export interface RawSessionInput {
  source: SessionSource;
  /** 原始内容：整块 jsonl 文本，或已分好的行数组（半结构容错：两者皆可）。 */
  raw: string | string[];
  /** 可选：会话标识（文件名 / sessionId），仅用于报告定位坏会话，不入段。 */
  sessionRef?: string;
}

/** 单会话被跳过的原因（计入报告，不崩）。 */
export type SkipReason = 'no_parseable_lines' | 'no_messages' | 'empty_content' | 'unknown_format';

export interface SkippedSession {
  sessionRef: string | undefined;
  source: SessionSource;
  reason: SkipReason;
  badLineCount: number;
}

/** 整批解析统计。 */
export interface ParseStats {
  segmentCount: number;
  messageCount: number;
  projectCount: number;
  timeSpan: { from: string; to: string } | null;
  sources: SessionSource[];
  badLineCount: number;
  duplicateSegmentCount: number;
}

export interface ParseResult {
  /** 去重后、按 happened_at 降序的段。 */
  segments: ParsedSegment[];
  skipped: SkippedSession[];
  stats: ParseStats;
}

// ---------------------------------------------------------------------------
// 常量 / 工具
// ---------------------------------------------------------------------------

const TITLE_MAX = 80;
const EMPTY_TITLE = '(无标题会话)';

/** 规范化内容用于 hash：统一换行 + 去首尾空白（避免无意义差异炸去重）。 */
function canonicalizeForHash(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

/** content hash：sha256(规范化正文) hex。 */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(canonicalizeForHash(content), 'utf8').digest('hex');
}

/** 角色归一：把各家细分角色收敛到四类。 */
function normalizeRole(raw: unknown): ParsedRole {
  const r = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (r === 'assistant') return 'assistant';
  if (r === 'user') return 'user';
  if (r === 'tool' || r === 'function' || r === 'tool_result' || r === 'function_call_output')
    return 'tool';
  return 'system';
}

/** 时间归一：宽松解析为 ISO；不可解析 → null（不崩）。 */
function normalizeTimestamp(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // 兼容秒级 / 毫秒级 epoch（codex 历史曾用秒）。
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof raw === 'string' && raw.length > 0) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/** cwd / path → 项目名（取末段目录名；空 / 根 → undefined）。 */
function projectFromCwd(cwd: unknown): string | undefined {
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined;
  const parts = cwd.split(/[\\/]+/).filter((p) => p.length > 0);
  const last = parts[parts.length - 1];
  return last && last.length > 0 ? last : undefined;
}

/** 安全 JSON.parse：失败返回 undefined（坏行不崩，调用方计 badLine）。 */
function tryParseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** raw（string | string[]）→ 非空行数组（容错：CRLF / 空行 / 多余空白）。 */
function toLines(raw: string | string[]): string[] {
  const arr = Array.isArray(raw) ? raw : raw.split(/\r?\n/);
  return arr.map((l) => (typeof l === 'string' ? l.trim() : '')).filter((l) => l.length > 0);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// 内容块 → 文本（两家都可能用 content 块数组 / 纯字符串 / 嵌套）
// ---------------------------------------------------------------------------

/** 把一条消息的 content 抽成纯文本。非文本块按占位标注、不丢消息存在性。 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
        continue;
      }
      if (!isRecord(block)) continue;
      // Claude: {type:'text', text}; Codex: {type:'input_text'|'output_text'|'text', text}
      const t = block['text'];
      if (typeof t === 'string') {
        parts.push(t);
        continue;
      }
      // 嵌套 content（少见的 tool_result 结构）。
      if ('content' in block) {
        const nested = extractText(block['content']);
        if (nested) parts.push(nested);
        continue;
      }
      // 非文本块（image / tool_use / thinking 等）：标占位，保留「这条消息有内容」。
      const bt = typeof block['type'] === 'string' ? (block['type'] as string) : 'block';
      parts.push(`[${bt}]`);
    }
    return parts.join('\n').trim();
  }
  if (isRecord(content) && typeof content['text'] === 'string') return content['text'];
  return '';
}

// ---------------------------------------------------------------------------
// Claude 解析（~/.claude/projects/<enc-cwd>/<sessionId>.jsonl）
//   一行一对象：{ type, message:{ role, content }, timestamp, cwd, ... }；只取带 message.role 的会话消息。
// ---------------------------------------------------------------------------

interface SessionAccum {
  messages: ParsedMessage[];
  project: string | undefined;
  badLineCount: number;
  /** 是否至少有一行成功 JSON.parse（不论结构）。 */
  sawAnyJson: boolean;
  /** 是否至少有一行是「本解析器认识的结构」——区分 no_messages 与 unknown_format。 */
  sawRecognizableStructure: boolean;
}

function newAccum(): SessionAccum {
  return {
    messages: [],
    project: undefined,
    badLineCount: 0,
    sawAnyJson: false,
    sawRecognizableStructure: false,
  };
}

function parseClaudeLines(lines: string[]): SessionAccum {
  const acc = newAccum();
  for (const line of lines) {
    const obj = tryParseLine(line);
    if (obj === undefined) {
      acc.badLineCount++;
      continue;
    }
    acc.sawAnyJson = true;
    if (!isRecord(obj)) continue; // 合法 JSON 但非对象：结构不认识，不算坏行。
    if (acc.project === undefined) acc.project = projectFromCwd(obj['cwd']);
    const msg = obj['message'];
    if (!isRecord(msg)) continue; // 非消息行（summary/attachment 元信息等）跳过、不算坏。
    acc.sawRecognizableStructure = true;
    const text = extractText(msg['content']);
    if (!text) continue; // 空内容消息（纯 tool_use 等）不计条数。
    acc.messages.push({
      role: normalizeRole(msg['role'] ?? obj['type']),
      text,
      happenedAt: normalizeTimestamp(obj['timestamp']),
    });
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Codex 解析（~/.codex/sessions/YYYY/.../*.jsonl）
//   一行一对象：{ type, payload, timestamp }。消息真源优先取 response_item.payload(type=message)，
//   缺失时回退 event_msg(user_message/agent_message)。同一 turn 双写按 (role, 文本 hash) 去重。
// ---------------------------------------------------------------------------

type CodexDelegationResult =
  | { kind: 'not_delegation' }
  | { kind: 'valid'; input: string }
  | { kind: 'malformed' };

const CODEX_DELEGATION_OPEN = '<codex_delegation>';
const CODEX_DELEGATION_CLOSE = '</codex_delegation>';

/** 与 Codex Desktop 的 delegation 文本转义保持一致；只解码宿主会编码的三种实体。 */
function decodeCodexDelegationText(text: string): string {
  return text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

function readCodexDelegationElement(text: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'i').exec(text);
  return match?.[1]?.trim() ?? null;
}

/**
 * Codex Desktop 把委派任务包装成 codex_delegation。只有完整包裹且同时含来源与 input 才解包；
 * 一旦消息以该宿主标签开头却不满足契约，就按 malformed 跳过，绝不把内部元数据当用户正文。
 */
function unwrapCodexDelegation(text: string): CodexDelegationResult {
  const trimmed = text.trim();
  if (!trimmed.startsWith(CODEX_DELEGATION_OPEN)) return { kind: 'not_delegation' };
  if (!trimmed.endsWith(CODEX_DELEGATION_CLOSE)) return { kind: 'malformed' };

  const sourceThreadId = readCodexDelegationElement(trimmed, 'source_thread_id');
  const input = readCodexDelegationElement(trimmed, 'input');
  if (sourceThreadId === null || input === null) return { kind: 'malformed' };
  return { kind: 'valid', input: decodeCodexDelegationText(input) };
}

function parseCodexLines(lines: string[]): SessionAccum {
  const acc = newAccum();
  const seen = new Set<string>();
  let sawRealUserTask = false;
  for (const line of lines) {
    const obj = tryParseLine(line);
    if (obj === undefined) {
      acc.badLineCount++;
      continue;
    }
    acc.sawAnyJson = true;
    if (!isRecord(obj)) continue;
    const topType = obj['type'];
    const payload = obj['payload'];
    if (!isRecord(payload)) continue; // 无 payload 行跳过（不算坏，半结构容错）。
    acc.sawRecognizableStructure = true;
    const pType = typeof payload['type'] === 'string' ? (payload['type'] as string) : undefined;

    if (acc.project === undefined && (topType === 'session_meta' || topType === 'turn_context')) {
      acc.project = projectFromCwd(payload['cwd']);
    }

    let role: unknown;
    let text = '';
    if (topType === 'response_item' && pType === 'message') {
      role = payload['role'];
      text = extractText(payload['content']);
    } else if (topType === 'event_msg' && pType === 'user_message') {
      role = 'user';
      text = extractText(payload['message'] ?? payload['text']);
    } else if (topType === 'event_msg' && pType === 'agent_message') {
      role = 'assistant';
      text = extractText(payload['message'] ?? payload['text']);
    } else {
      continue; // reasoning / function_call / token_count 等非消息：不计、不算坏。
    }
    if (!text) continue;
    const normRole = normalizeRole(role);

    // Codex 会把环境、AGENTS、标题生成等运行时上下文也记录成 role=user。
    // 这些不是用户真正要复用的工作流，必须在解析阶段剥掉，避免污染标题、正文和后续提取。
    if (normRole === 'user') {
      const delegation = unwrapCodexDelegation(text);
      if (delegation.kind === 'malformed') continue;
      if (delegation.kind === 'valid') text = delegation.input;
      if (!text.trim() || isPlatformPromptText(text)) continue;
    }
    if (normRole !== 'user' && normRole !== 'assistant') continue;
    if (!sawRealUserTask && normRole !== 'user') continue;

    const dedupKey = `${normRole}|${computeContentHash(text)}`;
    if (seen.has(dedupKey)) continue; // 同 turn 双写去重（event_msg ↔ response_item）。
    seen.add(dedupKey);
    if (normRole === 'user') sawRealUserTask = true;
    acc.messages.push({
      role: normRole,
      text,
      happenedAt: normalizeTimestamp(obj['timestamp']),
    });
  }
  return acc;
}

// ---------------------------------------------------------------------------
// 来源嗅探（按内容判 claude|codex）
// ---------------------------------------------------------------------------

/**
 * 按内容嗅探单会话来源。判据与两个解析器的结构判定同源：Codex 行顶层带对象型 `payload`，
 * Claude 行顶层带对象型 `message`（两家结构互斥）。扫可解析行投票，多者胜；
 * 都不命中回退 hint，hint 缺省 'claude'。
 */
export function detectSessionSource(raw: string | string[], hint?: SessionSource): SessionSource {
  const lines = toLines(raw);
  let claudeHits = 0;
  let codexHits = 0;
  for (const line of lines) {
    const obj = tryParseLine(line);
    if (!isRecord(obj)) continue;
    if (isRecord(obj['payload'])) codexHits++;
    else if (isRecord(obj['message'])) claudeHits++;
    if (claudeHits + codexHits >= 64) break; // 早停：足够区分即可，不必全扫大文件。
  }
  if (codexHits > claudeHits) return 'codex';
  if (claudeHits > codexHits) return 'claude';
  return hint ?? 'claude';
}

// ---------------------------------------------------------------------------
// 单会话 → 段（或跳过原因）
// ---------------------------------------------------------------------------

/** 段标题：首条 user 文本首行（截断）；无 user 则首条任意消息；空则占位。 */
function deriveTitle(messages: ParsedMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user' && m.text.trim().length > 0);
  const pick = firstUser ?? messages.find((m) => m.text.trim().length > 0);
  if (!pick) return EMPTY_TITLE;
  const firstLine = pick.text.split('\n')[0]?.trim() ?? '';
  if (!firstLine) return EMPTY_TITLE;
  return firstLine.length > TITLE_MAX ? `${firstLine.slice(0, TITLE_MAX - 1)}…` : firstLine;
}

/** 段正文：消息按 `role: text` 拼接。 */
function buildSegmentContent(messages: ParsedMessage[]): string {
  return messages.map((m) => `${m.role}: ${m.text}`.trim()).join('\n\n');
}

/** 段时刻：首条有 happenedAt 的消息（升序后取最早；无则 null）。 */
function deriveHappenedAt(messages: ParsedMessage[]): string | null {
  const times = messages
    .map((m) => m.happenedAt)
    .filter((t): t is string => typeof t === 'string')
    .sort();
  return times[0] ?? null;
}

type SegmentOrSkip =
  | { ok: true; segment: ParsedSegment; messageBadLines: number }
  | { ok: false; reason: SkipReason; badLineCount: number };

function sessionToSegment(input: RawSessionInput): SegmentOrSkip {
  const lines = toLines(input.raw);
  const acc = input.source === 'claude' ? parseClaudeLines(lines) : parseCodexLines(lines);

  if (!acc.sawAnyJson) {
    return { ok: false, reason: 'no_parseable_lines', badLineCount: acc.badLineCount };
  }
  if (acc.messages.length === 0) {
    const reason: SkipReason = acc.sawRecognizableStructure ? 'no_messages' : 'unknown_format';
    return { ok: false, reason, badLineCount: acc.badLineCount };
  }
  const content = buildSegmentContent(acc.messages);
  if (!canonicalizeForHash(content)) {
    return { ok: false, reason: 'empty_content', badLineCount: acc.badLineCount };
  }
  const happenedAt = deriveHappenedAt(acc.messages);
  const segment: ParsedSegment = {
    source: input.source,
    contentHash: computeContentHash(content),
    title: deriveTitle(acc.messages),
    happenedAt,
    ...(acc.project !== undefined ? { project: acc.project } : {}),
    messageCount: acc.messages.length,
    content,
  };
  return { ok: true, segment, messageBadLines: acc.badLineCount };
}

// ---------------------------------------------------------------------------
// 批解析（多会话 → 去重段 + 统计 + 跳过报告）—— 提取流水线的主入口
// ---------------------------------------------------------------------------

/**
 * 解析一批会话（Claude / Codex / 混合）为标准段集 + 统计 + 跳过报告。
 *   容错：单坏会话不影响其它会话；全坏 / 全空也正常返回（segments=[]、有跳过报告），
 *   由流水线据空结果出 UPLOAD_NO_CONTENT。
 *   去重：同 contentHash 只保留首段；重复计入 stats.duplicateSegmentCount。
 */
export function parseSessions(inputs: RawSessionInput[]): ParseResult {
  const segments: ParsedSegment[] = [];
  const skipped: SkippedSession[] = [];
  const byHash = new Set<string>();
  const sourcesSeen = new Set<SessionSource>();
  const projects = new Set<string>();
  let messageCount = 0;
  let badLineCount = 0;
  let duplicateSegmentCount = 0;
  let minTime: string | null = null;
  let maxTime: string | null = null;

  for (const input of inputs) {
    const res = sessionToSegment(input);
    if (!res.ok) {
      badLineCount += res.badLineCount;
      skipped.push({
        sessionRef: input.sessionRef,
        source: input.source,
        reason: res.reason,
        badLineCount: res.badLineCount,
      });
      continue;
    }
    badLineCount += res.messageBadLines;
    const seg = res.segment;
    if (byHash.has(seg.contentHash)) {
      duplicateSegmentCount++;
      continue;
    }
    byHash.add(seg.contentHash);
    segments.push(seg);
    messageCount += seg.messageCount;
    sourcesSeen.add(seg.source);
    if (seg.project) projects.add(seg.project);
    if (seg.happenedAt) {
      if (minTime === null || seg.happenedAt < minTime) minTime = seg.happenedAt;
      if (maxTime === null || seg.happenedAt > maxTime) maxTime = seg.happenedAt;
    }
  }

  // 按 happened_at 降序（null 时间排末尾，稳定）。
  segments.sort((a, b) => {
    if (a.happenedAt === b.happenedAt) return 0;
    if (a.happenedAt === null) return 1;
    if (b.happenedAt === null) return -1;
    return a.happenedAt < b.happenedAt ? 1 : -1;
  });

  const timeSpan = minTime !== null && maxTime !== null ? { from: minTime, to: maxTime } : null;

  const stats: ParseStats = {
    segmentCount: segments.length,
    messageCount,
    projectCount: projects.size,
    timeSpan,
    sources: [...sourcesSeen],
    badLineCount,
    duplicateSegmentCount,
  };

  return { segments, skipped, stats };
}

// ---------------------------------------------------------------------------
// 打包上传：本机助手把成百上千个会话文件按「整文件」拼进少数几个分片再传。
//   每个分片是「sentinel 行 + 文件原文 + 换行」反复拼接，只含【整文件】（不跨分片切单个文件），
//   故分片本身永远是合法 UTF-8 文本。worker 拿到收齐后的完整文本按 sentinel 拆回每个文件原文。
// ---------------------------------------------------------------------------

/** 打包分隔行（助手脚本写、worker 拆共用真源）。真实 JSONL 不会有这一行（非合法 JSON 对象行）。 */
export const BUNDLE_SENTINEL = '__COMBO_FILE_BOUNDARY__';

/**
 * 把打包文本拆回各文件原文。形如：
 *   __COMBO_FILE_BOUNDARY__\n<文件0原文>\n__COMBO_FILE_BOUNDARY__\n<文件1原文>\n …
 * 返回非空文件原文数组（每段含末尾换行无妨，parseSessions 的 toLines 会 trim）。
 */
export function splitBundle(text: string): string[] {
  return text.split(`${BUNDLE_SENTINEL}\n`).filter((s) => s.trim().length > 0);
}
