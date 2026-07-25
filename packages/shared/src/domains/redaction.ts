// B-17 · 去敏规则引擎（纯函数模块，无 PG / 无网络 / 无 IO）。
//
// 归属：packages/shared/src/domains。本引擎同时定义去敏报告契约及其唯一生产逻辑；
// Authoring Task pipeline 通过 `redactBatch` 对解析后的会话段去敏。放在 shared 后可由
// 纯函数单测覆盖，不依赖 PostgreSQL、网络或运行时基础设施。
//
// 硬约束（20-step1-import.md §5.4 / 导入-30 / 提取-31）：
//   1. 真去标识——手机号/邮箱/API key/证件号/银行卡/IP/密钥型必须被替换或掩码，
//      去敏后文本里不得残留可识别原值。
//   2. 报告只给聚合（命中类别 + 计数），绝不回传被抹明文片段、绝不回传命中位置明文。
//   3. 幂等——对已去敏文本再跑结果稳定（掩码占位符本身不含 PII、不会被二次命中）。
//   4. 误伤控制——尽量保留正常文本语义（带 Luhn 校验、关键词锚定、词边界约束）。
//
// 规则集可迭代：每条规则带 category；ruleset 带 version 字符串，便于从 Task 上传元数据
// 回溯本次处理使用的规则版本。

import { z } from 'zod';

// ---------- 去敏报告（对外口径；类型与其生产逻辑同文件）----------
export const RedactionCategorySchema = z.enum([
  'phone',
  'api_key',
  'email',
  'id_card',
  'bank_card',
  'ip',
  'secret_other',
]);
export type RedactionCategory = z.infer<typeof RedactionCategorySchema>;

export const RedactionReportViewSchema = z.object({
  applied: z.literal(true),
  totalRedactions: z.number().int(),
  byCategory: z.array(
    z.object({
      category: RedactionCategorySchema,
      count: z.number().int(),
      label: z.string(),
    }),
  ),
  rulesetVersion: z.string(),
});
export type RedactionReportView = z.infer<typeof RedactionReportViewSchema>;

// ---------- 对外人话类别名（byCategory.label，§5.4「人话类别名」）----------

/** category → 对外人话标签。报告里 byCategory[].label 取此表。 */
export const REDACTION_CATEGORY_LABELS: Record<RedactionCategory, string> = {
  phone: '手机号',
  email: '邮箱',
  api_key: '密钥',
  id_card: '证件号',
  bank_card: '银行卡号',
  ip: 'IP 地址',
  secret_other: '其它密钥',
};

// ---------- 掩码占位符 ----------
//
// 设计为「方括号 + 全大写类别 + REDACTED」，占位符内不含任何会被规则二次命中的字符
// （无数字串、无 @、无 key 关键词跟值），保证幂等。

/** 每类的掩码占位符。保留语义提示（读者知道这里原本是什么类型的隐私）。 */
export const REDACTION_PLACEHOLDERS: Record<RedactionCategory, string> = {
  phone: '[手机号已抹除]',
  email: '[邮箱已抹除]',
  api_key: '[密钥已抹除]',
  id_card: '[证件号已抹除]',
  bank_card: '[银行卡号已抹除]',
  ip: '[IP已抹除]',
  secret_other: '[密钥已抹除]',
};

// ---------- 规则定义 ----------

/**
 * 单条去敏规则。
 * - `pattern`：全局正则（必须带 `g`，引擎会逐条 reset lastIndex）。
 * - `category`：命中归类。
 * - `validate`：可选二次校验（如 Luhn、长度、词边界），返回 false 则放过（误伤控制）。
 * - `mask`：可选自定义掩码函数（默认取 REDACTION_PLACEHOLDERS[category]）；
 *    自定义掩码**绝不能**把原文敏感值放进结果（幂等 + 不泄漏）。
 */
export interface RedactionRule {
  readonly id: string;
  readonly category: RedactionCategory;
  readonly pattern: RegExp;
  readonly validate?: (match: RegExpMatchArray) => boolean;
  readonly mask?: (match: RegExpMatchArray) => string;
}

/** 规则集：一组有序规则 + 版本号。顺序即优先级（先匹配的先抹，避免被泛规则误吞）。 */
export interface RedactionRuleset {
  readonly version: string;
  readonly rules: readonly RedactionRule[];
}

// ---------- 校验辅助（误伤控制）----------

/** Luhn 校验（银行卡），过滤掉随手写的长数字串。 */
function luhnValid(digits: string): boolean {
  const d = digits.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** 中国大陆身份证 18 位校验码（ISO 7064 mod 11-2）。 */
function chinaIdChecksumValid(id: string): boolean {
  if (!/^\d{17}[\dXx]$/.test(id)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checkMap = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (id.charCodeAt(i) - 48) * weights[i]!;
  return checkMap[sum % 11] === id[17]!.toUpperCase();
}

/** IPv4 四段 0-255。过滤掉版本号 / 普通点分数字（如 1.2.3.4 也算，但 999.1.1.1 不算）。 */
function ipv4InRange(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

// ---------- 默认规则集 v1 ----------
//
// 顺序重要：高特异性 / 带关键词锚的规则在前，泛规则在后。
//   keyed secret（key=... / token: ...）→ 已知厂商 token 前缀 → 邮箱 → 银行卡（Luhn）
//   → 证件号（校验码）→ 手机号 → IPv4 → 泛 base64/hex 长串。
// 这样邮箱里的 @、token 里的数字不会被手机号/卡号规则误吞。

const DEFAULT_RULES: readonly RedactionRule[] = [
  // 1) Authorization: Bearer <token>（scheme + token 形态）。
  //    必须排在 keyed-secret 前——否则 keyed-secret 会把 `authorization: ` 的值当成 `Bearer`
  //    这一个词、只抹 `Bearer` 而漏掉真正的 token（已被单测逮到）。整段（scheme+token）一起抹。
  {
    id: 'bearer-token',
    category: 'api_key',
    pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._\-+/=]{12,}/gi,
    mask: (m) => `${m[1]} ${REDACTION_PLACEHOLDERS.api_key}`,
  },
  // 2) 已知厂商密钥前缀（无需关键词锚，前缀本身即强信号）。排在 keyed-secret 前，
  //    保证 `key is sk-ant-...` 这种无键值锚的形态也命中。
  //    sk-/pk-(OpenAI/Stripe)、ghp_/gho_/ghs_/github_pat_(GitHub)、xox[baprs]-(Slack)、
  //    AKIA(AWS Access Key Id)、AIza(Google)、glpat-(GitLab)、Anthropic sk-ant-
  {
    id: 'vendor-token',
    category: 'api_key',
    pattern:
      /\b(sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|pk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|ghs_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{20,})\b/g,
  },
  // 3) 显式键值密钥：api_key=xxx / "token": "xxx" / secret: xxx / password=xxx。
  //    关键词可被引号包裹（JSON 形态 "token"）；分隔为 : 或 =；值可带引号。
  //    抹掉值、保留 key 名让文本仍可读（误伤控制 + 语义保留）。
  //    值字符类**排除 [ 和 ]**：占位符 `[密钥已抹除]` 含方括号，排除后二次运行不会把占位符
  //    再当成值重抹（幂等关键，已被单测逮到）。
  {
    id: 'keyed-secret',
    category: 'api_key',
    // 可选引号 + 关键词 + 可选引号 + 分隔(:|=) + 可选引号 + 值（非空白/引号/闭合标点/方括号，>=6）
    pattern:
      /(["'`]?)(api[_-]?key|secret[_-]?key|access[_-]?key|secret|token|password|passwd|pwd|auth[_-]?token|client[_-]?secret|private[_-]?key)\1\s*[:=]\s*(["'`]?)([^\s"'`,;)}[\]]{6,})\3/gi,
    mask: (m) => `${m[1]}${m[2]}${m[1]}${midSep(m[0])}${REDACTION_PLACEHOLDERS.api_key}`,
  },
  // 3) 邮箱（在卡号/手机号之前，避免 @ 前后数字被误判）
  {
    id: 'email',
    category: 'email',
    pattern:
      /\b[A-Za-z0-9](?:[A-Za-z0-9._%+-]*[A-Za-z0-9])?@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}\b/g,
  },
  // 4) 中国大陆身份证 18 位（带校验码，强校验降误伤）
  {
    id: 'china-id-card',
    category: 'id_card',
    pattern: /(?<![0-9A-Za-z])\d{17}[\dXx](?![0-9A-Za-z])/g,
    validate: (m) => chinaIdChecksumValid(m[0]),
  },
  // 5) 银行卡 13-19 位（可含空格/连字符分组），Luhn 校验降误伤
  {
    id: 'bank-card',
    category: 'bank_card',
    pattern: /(?<![0-9])(?:\d[ -]?){12,18}\d(?![0-9])/g,
    validate: (m) => luhnValid(m[0]),
  },
  // 6) 手机号：中国大陆 1[3-9]xxxxxxxxx（11 位），可带 +86 / 86 前缀；
  //    也覆盖通用 E.164（+ 国码 8-15 位）。词边界约束避免吞更长数字串。
  {
    id: 'phone-cn',
    category: 'phone',
    pattern: /(?<![0-9])(?:(?:\+?86[-\s]?)?1[3-9]\d{9})(?![0-9])/g,
  },
  {
    id: 'phone-e164',
    category: 'phone',
    pattern: /(?<![0-9A-Za-z._%+-])\+\d{1,3}[-\s]?\d[\d-\s]{6,13}\d(?![0-9])/g,
    validate: (m) => m[0].replace(/\D/g, '').length >= 8 && m[0].replace(/\D/g, '').length <= 15,
  },
  // 7) IPv4（四段 0-255 校验）
  {
    id: 'ipv4',
    category: 'ip',
    // 前后排除字母/数字/点：避免把 `v1.2.3.4`（版本号，前有字母）误判为 IP。
    pattern: /(?<![0-9A-Za-z.])\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![0-9A-Za-z.])/g,
    validate: (m) => ipv4InRange(m[0]),
  },
  // 8) 泛长随机串（base64 / hex），作为兜底密钥型。要求足够长 + 字符多样，避免吞普通单词。
  //    >=32 长、含大小写或数字混合，归 secret_other。
  {
    id: 'generic-secret',
    category: 'secret_other',
    pattern: /\b[A-Za-z0-9_\-+/=]{32,}\b/g,
    validate: (m) => looksLikeSecret(m[0]),
  },
];

/** 默认规则集 v1（版本号即对外 rulesetVersion，可迭代时升版本）。 */
export const DEFAULT_RULESET: RedactionRuleset = {
  version: 'redaction-v1',
  rules: DEFAULT_RULES,
};

// 从 keyed-secret 整段命中里取出「关键词与值之间的分隔片段」（含空格/冒号/等号/起始引号），
// 以便掩码后保留 `key: ` / `"token": "` 的原样书写风格。命中整体形如
// `<q1><kw><q1><sep+q2><val><q2>`——切掉首尾引号与关键词、再切掉末尾值与闭合引号即得 sep。
function midSep(whole: string): string {
  const m = whole.match(/[:=]\s*["'`]?/);
  // 末尾的 [:=]\s*quote? 之前即关键词段，之后即值；这里只取该分隔含起始引号。
  if (!m) return ': ';
  // m[0] 是 `: "` 之类；但 whole 里可能含值后引号，匹配的是第一个分隔，正是所需。
  return m[0];
}

/** 泛串「看起来像密钥」启发式：足够长 + 字符类多样（不是纯字母单词、不是纯数字）。 */
function looksLikeSecret(s: string): boolean {
  if (s.length < 32) return false;
  const hasLower = /[a-z]/.test(s);
  const hasUpper = /[A-Z]/.test(s);
  const hasDigit = /\d/.test(s);
  const hasSym = /[_\-+/=]/.test(s);
  // 纯小写字母长串（如自然语言被拼接）放过；要求至少两类字符且含数字或大小写混排。
  const classes = [hasLower, hasUpper, hasDigit, hasSym].filter(Boolean).length;
  return classes >= 2 && (hasDigit || (hasLower && hasUpper));
}

// ---------- 引擎 ----------

/** 单条命中（仅内部用，不外泄；不含原文敏感值出口）。 */
interface Hit {
  start: number;
  end: number;
  category: RedactionCategory;
  replacement: string;
}

export interface RedactOptions {
  /** 规则集；默认 DEFAULT_RULESET。 */
  ruleset?: RedactionRuleset;
}

export interface RedactResult {
  /** 去敏后文本（被抹内容以占位符呈现，无明文残留）。 */
  text: string;
  /** 对外聚合报告（§5.4 RedactionReportView 形态）。 */
  report: RedactionReportView;
}

/**
 * 对单段文本去敏。纯函数：同输入同输出，无副作用。
 *
 * 算法：
 *   1) 逐条规则全局扫描，收集所有命中区间（带 validate 过滤误伤）。
 *   2) 按起点排序，区间重叠时**先注册的规则优先**（顺序即优先级），后到的重叠命中丢弃，
 *      保证一个字符只被抹一次、不会 phone 又被 secret 重复计数。
 *   3) 一次性按区间重建字符串（O(n)），插入占位符。
 *   4) 计数聚合成 RedactionReportView。
 *
 * 幂等：占位符不含会被任何规则命中的子串，二次运行命中数为 0、文本不变。
 */
export function redact(input: string, options: RedactOptions = {}): RedactResult {
  const ruleset = options.ruleset ?? DEFAULT_RULESET;
  const hits: Array<Hit & { ruleOrder: number }> = [];

  ruleset.rules.forEach((rule, ruleOrder) => {
    const re = new RegExp(rule.pattern.source, ensureGlobal(rule.pattern.flags));
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
      // 防零宽死循环
      if (m.index === re.lastIndex) re.lastIndex++;
      if (m[0].length === 0) continue;
      if (rule.validate && !rule.validate(m)) continue;
      const replacement = rule.mask ? rule.mask(m) : REDACTION_PLACEHOLDERS[rule.category];
      hits.push({
        start: m.index,
        end: m.index + m[0].length,
        category: rule.category,
        replacement,
        ruleOrder,
      });
    }
  });

  // 排序：起点升序；同起点时规则顺序靠前优先（再按更长区间优先，吞掉更多）。
  hits.sort((a, b) => a.start - b.start || a.ruleOrder - b.ruleOrder || b.end - a.end);

  // 去重叠：扫描线，保留不与已选区间重叠者。
  const chosen: Hit[] = [];
  let cursor = 0;
  for (const h of hits) {
    if (h.start < cursor) continue; // 与已选区间重叠 → 丢弃（先注册者已占用）
    chosen.push(h);
    cursor = h.end;
  }

  // 重建文本
  let out = '';
  let pos = 0;
  const counts: Partial<Record<RedactionCategory, number>> = {};
  for (const h of chosen) {
    out += input.slice(pos, h.start);
    out += h.replacement;
    pos = h.end;
    counts[h.category] = (counts[h.category] ?? 0) + 1;
  }
  out += input.slice(pos);

  const report = buildReport(counts, ruleset.version);
  return { text: out, report };
}

/** 把命中计数聚合成对外报告（按 category 固定顺序，稳定输出）。 */
function buildReport(
  counts: Partial<Record<RedactionCategory, number>>,
  rulesetVersion: string,
): RedactionReportView {
  const order: RedactionCategory[] = [
    'phone',
    'email',
    'api_key',
    'id_card',
    'bank_card',
    'ip',
    'secret_other',
  ];
  const byCategory = order
    .filter((c) => (counts[c] ?? 0) > 0)
    .map((c) => ({
      category: c,
      count: counts[c]!,
      label: REDACTION_CATEGORY_LABELS[c],
    }));
  const totalRedactions = byCategory.reduce((s, x) => s + x.count, 0);
  return {
    applied: true,
    totalRedactions,
    byCategory,
    rulesetVersion,
  };
}

/** 合并多段文本的报告（Task pipeline 跨段聚合用，见 redactBatch）。 */
export function mergeReports(
  reports: readonly RedactionReportView[],
  rulesetVersion: string,
): RedactionReportView {
  const counts: Partial<Record<RedactionCategory, number>> = {};
  for (const r of reports) {
    for (const b of r.byCategory) counts[b.category] = (counts[b.category] ?? 0) + b.count;
  }
  return buildReport(counts, rulesetVersion);
}

export interface RedactBatchResult {
  /** 与输入同序的去敏后文本。 */
  texts: string[];
  /** 跨段聚合的单份报告，由 Task pipeline 写入上传元数据。 */
  report: RedactionReportView;
}

/**
 * 批量去敏并聚合报告。Task pipeline 输入 N 段原文，得到 N 段去敏文本和一份聚合报告；
 * 本函数保持纯函数与无 IO，调用方负责保存提取结果和上传元数据。
 */
export function redactBatch(
  inputs: readonly string[],
  options: RedactOptions = {},
): RedactBatchResult {
  const ruleset = options.ruleset ?? DEFAULT_RULESET;
  const texts: string[] = [];
  const reports: RedactionReportView[] = [];
  for (const s of inputs) {
    const r = redact(s, { ruleset });
    texts.push(r.text);
    reports.push(r.report);
  }
  return { texts, report: mergeReports(reports, ruleset.version) };
}

function ensureGlobal(flags: string): string {
  return flags.includes('g') ? flags : flags + 'g';
}
