import type {
  CreatorKnowledgeBundle,
  CreatorKnowledgeChunk,
} from '@cb/creator-agent-protocol/knowledge-bundle';
const EXCERPT_MAX_CODE_POINTS = 1_200;
const HAN_PATTERN = /\p{Script=Han}+/gu;
const LITERAL_PATTERN = /[\p{Script=Latin}\p{N}]+(?:[-._:/+][\p{Script=Latin}\p{N}]+)*/gu;
const SENTENCE_UNIT_PATTERN = /[^。！？!?；;\n]+(?:[。！？!?；;\n]+|$)/gu;
const SENTENCE_TERMINATOR_PATTERN = /[。！？!?；;\n]+$/u;
const EDGE_HORIZONTAL_WHITESPACE_PATTERN = /^[\p{Zs}\t\r]+|[\p{Zs}\t\r]+$/gu;
const USER_WHITESPACE_PATTERN = /\s+/gu;
const QUESTION_HAN_WHITESPACE_PATTERN = /(?<=\p{Script=Han})\s+|\s+(?=\p{Script=Han})/gu;
const INTERROGATIVE_TERMINATOR_PATTERN = /[?？]/u;
const DECLARATIVE_TERMINATOR_PATTERN = /[。；;！!]/u;
const MARKDOWN_BLOCK_PREFIX_PATTERN = /^(?:#{1,6}|[-*+]\s|\d{1,9}[.)、]\s|>\s?)/u;
const QUESTION_CLAUSE_PATTERN = /[^，,。；;！？!?\n]+/gu;
const ANSWER_SUBCLAUSE_PATTERN = /[^，,]+/gu;
const QUESTION_QUANTITY_SLOT = '\u{e000}';
const QUESTION_CHOICE_SLOT = '\u{e001}';
const QUESTION_OPTIONAL_QUANTITY_SLOT = '\u{e002}';
const QUESTION_VALUE_SLOT_SPLIT_PATTERN = /([\u{e000}\u{e001}\u{e002}])/u;
const QUESTION_QUANTITY_VALUE_PATTERN =
  /^(?:\p{N}+|[零〇一二两三四五六七八九十百千万亿]+)(?:[\p{Script=Latin}][\p{Script=Latin}\p{N}]*|个|份|次|种|项|名|位|家|条|台|套|本|张|件|笔|元|天|年|月|人)?$/u;
const QUESTION_UNTYPED_CHOICE_PATTERN =
  /^(?:(?:很|非常|比较|相当|太)多|许多|多个|多种|多项|多类|若干|一些|不少|任意|某种|某个|某项|某类|某些|各种|各类|好几|其他|其余|未知|不确定|(?:第)?(?:\p{N}+|[零〇一二两三四五六七八九十百千万亿]+)(?:种|个|项|类)|数(?:种|个|项|类)|多样|海量|大量|少量|少数|多数|全部|所有|任一|任选|随便|不定|不详|不清楚|无法确定|视情况|看情况)/u;
const QUESTION_SKELETON_ATOM_PATTERN =
  /\p{Script=Han}+|[\p{Script=Latin}\p{N}]+(?:[-._:/+][\p{Script=Latin}\p{N}]+)*/gu;
const HAN_CLAUSAL_ARGUMENT_RELATION_PHRASES = Object.freeze([
  '定义为',
  '意味着',
  '应当',
  '应该',
  '不得',
  '不能',
  '不会',
  '无需',
  '属于',
  '等于',
  '高于',
  '低于',
  '超过',
  '少于',
  '多于',
  '视为',
  '称为',
  '分为',
  '设为',
  '改为',
  '可以',
  '能够',
  '必须',
  '需要',
  '允许',
  '要求',
  '没有',
  '是',
]);
const HAN_ACTION_ARGUMENT_PREDICATE_PHRASES = Object.freeze([
  '位于',
  '基于',
  '用于',
  '使用',
  '返回',
  '表示',
  '包含',
  '包括',
  '提供',
  '禁止',
  '收取',
  '支付',
  '扣除',
  '释放',
  '记录',
  '提示',
  '支持',
  '适用',
]);
const HAN_STANDALONE_PREDICATE_PHRASES = Object.freeze(['存在', '生效', '失效', '开启', '关闭']);
const HAN_DECLARATIVE_ARGUMENT_PREDICATE_PHRASES = Object.freeze([
  ...HAN_CLAUSAL_ARGUMENT_RELATION_PHRASES,
  ...HAN_ACTION_ARGUMENT_PREDICATE_PHRASES,
]);
const HAN_NOMINAL_FRAGMENT_SUFFIXES = Object.freeze([
  '说明',
  '申请',
  '流程',
  '规则',
  '指南',
  '政策',
  '功能',
  '方案',
  '步骤',
  '方法',
  '方式',
  '标题',
  '手册',
  '文档',
  '介绍',
  '概述',
  '须知',
  '教程',
  '帮助',
  '服务',
]);

function regexAlternative(phrases: readonly string[]): string {
  return [...phrases]
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('|');
}

const HAN_DECLARATIVE_PREDICATE_PATTERN = new RegExp(
  `(?:${regexAlternative(HAN_DECLARATIVE_ARGUMENT_PREDICATE_PHRASES)})(?=.)|(?:${regexAlternative(HAN_STANDALONE_PREDICATE_PHRASES)})|为(?=[\\p{Zs}\\t]*[\\p{N}\\p{Script=Latin}])`,
  'u',
);
const HAN_CLAUSAL_RELATION_PATTERN = new RegExp(
  `(?:${regexAlternative(HAN_CLAUSAL_ARGUMENT_RELATION_PHRASES)})(?=.)|(?:${regexAlternative(HAN_STANDALONE_PREDICATE_PHRASES.filter((phrase) => phrase !== '开启' && phrase !== '关闭'))})|为(?=[\\p{Zs}\\t]*[\\p{N}\\p{Script=Latin}])`,
  'u',
);
const HAN_NOMINAL_FRAGMENT_SUFFIX_PATTERN = new RegExp(
  `(?:${regexAlternative(HAN_NOMINAL_FRAGMENT_SUFFIXES)})$`,
  'u',
);
const LATIN_DECLARATIVE_PREDICATE_PATTERN =
  /(?:^|[^\p{Script=Latin}\p{N}_])(?:is|are|was|were|has|have|can|must|should|will|means?|requires?|returns?|uses?|includes?|provides?|allows?|supports?)(?=[^\p{Script=Latin}\p{N}_]+.)/iu;
const LATIN_CLAUSAL_RELATION_PATTERN =
  /(?:^|[^\p{Script=Latin}\p{N}_])(?:is|are|was|were|has|have|can|must|should|will)(?=[^\p{Script=Latin}\p{N}_]+.)/iu;
const LATIN_NOMINAL_FRAGMENT_SUFFIX_PATTERN =
  /(?:^|[^\p{Script=Latin}\p{N}_])(?:guide|manual|documentation|instructions?|overview|policy|process|workflow|application|title)$/iu;
const QUESTION_STRUCTURAL_OPERATOR_PHRASES = Object.freeze(
  [
    '什么时候',
    '为什么',
    '怎么回事',
    '可不可以',
    '是不是',
    '有没有',
    '能不能',
    '如何',
    '为何',
    '怎么',
    '怎样',
    '哪里',
    '哪儿',
    '何时',
    '是否',
    '能否',
    '可否',
    '请问',
    '谁',
    '什么是',
  ].sort((left, right) => right.length - left.length || left.localeCompare(right)),
);
const QUESTION_VALUE_OPERATOR_PHRASES = Object.freeze(
  ['哪一个', '多少', '哪些', '哪几', '哪种', '哪个', '哪家'].sort(
    (left, right) => right.length - left.length || left.localeCompare(right),
  ),
);
const QUESTION_COUNTING_GE_PATTERN =
  /几(?=(?:个|份|次|种|项|名|位|家|条|台|套|本|张|件|笔|元|天|年|月|人))/gu;
const QUESTION_TRAILING_SHELL_PHRASES = Object.freeze(
  [
    '是什么意思',
    '什么时候',
    '怎么回事',
    '可不可以',
    '是不是',
    '有没有',
    '能不能',
    '是多少',
    '是什么',
    '哪一个',
    '怎么样',
    '什么',
    '多少',
    '哪些',
    '哪个',
    '哪种',
    '哪家',
    '哪里',
    '哪儿',
    '何时',
    '谁',
    '怎样',
    '怎么',
  ].sort((left, right) => right.length - left.length || left.localeCompare(right)),
);
const TRAILING_QUANTITY_SHELLS = new Set(['是多少', '多少']);
const TRAILING_CHOICE_SHELLS = new Set(['哪一个', '哪些', '哪个', '哪种', '哪家']);
const QUESTION_DEMONSTRATIVE_SCAFFOLD_PHRASES = Object.freeze(['该服务的']);
const TERMINAL_QUESTION_PARTICLE_PATTERN = /[吗呢](?=[?？]*$)/u;
const RELATION_SIDE_HAN_PATTERN = /\p{Script=Han}{2,}/u;
const RELATION_SIDE_LITERAL_PATTERN = /[\p{Script=Latin}\p{N}]{2,}/u;
const GENERIC_LITERAL_TOPIC_TOKENS = new Set(['api', 'http', 'https']);
const GENERIC_INFORMATION_GAIN_LITERAL_TOKENS = new Set([...GENERIC_LITERAL_TOPIC_TOKENS, 'combo']);
const YEAR_LITERAL_PATTERN = /^(?:19|20)\d{2}$/u;
const LATIN_LITERAL_PATTERN = /\p{Script=Latin}/u;
const ASCII_INTEGER_LITERAL_PATTERN = /^\d+$/u;
const NUMERIC_LITERAL_PATTERN = /^\p{N}+$/u;
const LATIN_INFORMATION_GAIN_NOISE_PATTERN =
  /^(?:a|an|and|are|as|at|but|by|can|for|from|has|have|in|include|includes|is|it|itself|mean|means|must|of|on|or|provide|provides|require|requires|return|returns|self|should|support|supports|the|to|use|uses|was|were|will|with)$/iu;
const HAN_PREFIX_PATTERN = /^\p{Script=Han}/u;
const LEADING_SEMANTIC_NEGATION_PATTERN = /[不没未无非莫]$/u;
const LOCAL_SCOPE_MISMATCH_PATTERN =
  /(?:不|没|未|无|非|莫|可能|也许|或许|大概|恐怕|似乎|看似|据称|貌似|暂定|倾向|拒绝|禁止|否认)/u;
const LOCAL_UNCERTAINTY_SCOPE_PATTERN =
  /(?:不一定|未必|可能|也许|或许|大概|恐怕|似乎|看似|据称|貌似|暂定|倾向)/u;
const SHORT_TOPIC_ACTIONS = new Set(HAN_ACTION_ARGUMENT_PREDICATE_PHRASES);
const SHORT_TOPIC_STANDALONES = new Set(HAN_STANDALONE_PREDICATE_PHRASES);
const DECLARATIVE_CONTINUATION_PHRASES = Object.freeze(
  [
    ...new Set([
      ...HAN_DECLARATIVE_ARGUMENT_PREDICATE_PHRASES,
      ...HAN_STANDALONE_PREDICATE_PHRASES,
    ]),
  ].sort((left, right) => right.length - left.length || left.localeCompare(right)),
);
const CLAUSE_CONTINUATION_PHRASES = Object.freeze(['并且', '而且', '但是', '并', '且', '但']);
const SUBSTANTIVE_HAN_NOISE_PHRASES = Object.freeze([
  '本系统',
  '该系统',
  '系统',
  '本平台',
  '该平台',
  '平台',
  '本服务',
  '该服务',
  '服务',
  '本功能',
  '该功能',
  '功能',
  '已经',
  '目前',
  '现在',
  '相关',
  '对应',
  '明确',
  '正式',
  '只是',
  '就是',
  '仍然',
  '依然',
  '确实',
  '因为',
  '所以',
  '以及',
  '并且',
  '而且',
  '同时',
  '本身',
  '自身',
]);
const SUBSTANTIVE_HAN_FUNCTION_PHRASES = Object.freeze([
  '关于',
  '对于',
  '针对',
  '围绕',
  '有关',
  '面向',
  '涉及',
  '以及',
  '并且',
  '而且',
  '或者',
  '的',
  '与',
  '和',
  '及',
  '或',
  '之',
]);
export const GROUNDED_ANSWER_STRUCTURE_POLICY =
  '不完整的前置上下文分句必须与后续疑问分句组成同一连通骨架；每个连通骨架必须完整出现在同一个答案逗号分句内；只有带主语的短动作与其直接宾语之间可以原位插入一个格式明确的数量值，其他部分仍须连续；显式数量或选择问句槽位必须由同一分句内的有界非空值填充；真正的多个完整问题才可由不同答案句分别支持；拉丁字母或数字限定只约束它所属的问题和答案句，不得跨问题补齐。';
const SUBSTANTIVE_DEMONSTRATIVE_RUN_PATTERN =
  /(?<![\p{Script=Han}\p{N}])(?:另一个|上述|前述|这些|这个|该等|某个|某些|同一|相同|这种|那种|那个|那些|另一|本|该|此|其|这|那)\p{Script=Han}*/gu;

interface LexicalFeature {
  key: string;
  text: string;
  weight: number;
}

export interface GroundedKnowledgeSearchHit {
  chunkId: string;
  sourceId: string;
  displayLabel: string;
  contentDigest: string;
  excerpt: string;
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('und');
}

function setFeature(features: Map<string, LexicalFeature>, feature: LexicalFeature): void {
  const prior = features.get(feature.key);
  if (!prior || prior.weight < feature.weight) features.set(feature.key, feature);
}

// Retrieval is NFKC/fuzzy; billable validation below is NFC/extractive.
function lexicalFeatures(value: string): Map<string, LexicalFeature> {
  const text = normalized(value);
  const features = new Map<string, LexicalFeature>();
  for (const match of text.matchAll(HAN_PATTERN)) {
    const points = Array.from(match[0]);
    if (points.length === 1) {
      const token = points[0]!;
      setFeature(features, {
        key: `han1:${token}`,
        text: token,
        weight: 1,
      });
      continue;
    }
    for (const size of [2, 3] as const) {
      for (let index = 0; index + size <= points.length; index += 1) {
        const token = points.slice(index, index + size).join('');
        setFeature(features, {
          key: `han${size}:${token}`,
          text: token,
          weight: size === 3 ? 4 : 1,
        });
      }
    }
  }
  for (const match of text.matchAll(LITERAL_PATTERN)) {
    const token = match[0];
    setFeature(features, {
      key: `literal:${token}`,
      text: token,
      weight: Math.min(16, Math.max(4, Array.from(token).length * 2)),
    });
  }
  return features;
}

function featureOverlapScore(
  query: ReadonlyMap<string, LexicalFeature>,
  target: ReadonlyMap<string, LexicalFeature>,
): number {
  let score = 0;
  for (const feature of query.values()) {
    if (target.has(feature.key)) score += feature.weight;
  }
  return score;
}

function contentAnchor(content: string, query: string): number {
  const searchable = normalized(content);
  const exact = searchable.indexOf(normalized(query));
  if (exact >= 0) return Array.from(searchable.slice(0, exact)).length;

  const features = [...lexicalFeatures(query).values()].sort(
    (left, right) =>
      right.weight - left.weight ||
      Array.from(right.text).length - Array.from(left.text).length ||
      left.key.localeCompare(right.key),
  );
  for (const feature of features) {
    const position = searchable.indexOf(feature.text);
    if (position >= 0) return Array.from(searchable.slice(0, position)).length;
  }
  return 0;
}

function boundedExcerpt(content: string, anchor: number): string {
  const points = Array.from(content);
  if (points.length <= EXCERPT_MAX_CODE_POINTS) return content;

  const centeredStart = Math.max(0, anchor - Math.floor(EXCERPT_MAX_CODE_POINTS / 2));
  let start = Math.min(points.length - EXCERPT_MAX_CODE_POINTS, centeredStart);
  let leadingMarker = start > 0;
  let trailingMarker = start + EXCERPT_MAX_CODE_POINTS < points.length;
  let contentBudget = EXCERPT_MAX_CODE_POINTS - Number(leadingMarker) - Number(trailingMarker);
  start = Math.min(points.length - contentBudget, centeredStart);
  leadingMarker = start > 0;
  trailingMarker = start + contentBudget < points.length;
  contentBudget = EXCERPT_MAX_CODE_POINTS - Number(leadingMarker) - Number(trailingMarker);
  const end = start + contentBudget;
  return `${leadingMarker ? '…' : ''}${points.slice(start, end).join('')}${trailingMarker ? '…' : ''}`;
}

function scoreChunk(
  chunk: CreatorKnowledgeChunk,
  query: string,
  queryFeatures: ReadonlyMap<string, LexicalFeature>,
): number {
  const content = normalized(chunk.content);
  const exact = content.includes(normalized(query)) ? 10_000 : 0;
  const contentScore = featureOverlapScore(queryFeatures, lexicalFeatures(chunk.content)) * 100;
  // A source label can break an otherwise exact tie, but it cannot outweigh one content feature.
  const labelScore = Math.min(
    25,
    featureOverlapScore(queryFeatures, lexicalFeatures(chunk.source.displayLabel)),
  );
  return exact + contentScore + labelScore;
}

export function searchGroundedKnowledgeBundle(
  bundle: CreatorKnowledgeBundle,
  query: string,
  limit: number,
): GroundedKnowledgeSearchHit[] {
  const queryFeatures = lexicalFeatures(query);
  if (queryFeatures.size === 0) throw new Error('knowledge query is invalid');
  return bundle.chunks
    .map((chunk) => ({ chunk, score: scoreChunk(chunk, query, queryFeatures) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id))
    .slice(0, limit)
    .map(({ chunk }) => ({
      chunkId: chunk.id,
      sourceId: chunk.source.sourceId,
      displayLabel: chunk.source.displayLabel,
      contentDigest: chunk.contentDigest,
      excerpt: boundedExcerpt(chunk.content, contentAnchor(chunk.content, query)),
    }));
}

interface ExtractiveSentence {
  canonical: string;
  body: string;
  literalTokens: readonly string[];
}
interface RelevanceAnchor {
  key: string;
  kind: 'han' | 'literal';
  text: string;
}
interface QuestionTopicGroup {
  text: string;
  predicateContext: 'none' | 'action' | 'standalone';
}
interface StrippedQuestionClause {
  text: string;
  removedStructuralOperator: boolean;
  removedQuestionShell: boolean;
}
interface QuestionObligation {
  pattern: string;
  topicGroups: readonly QuestionTopicGroup[];
  literalQualifiers: ReadonlyMap<string, RelevanceAnchor>;
}
function validationText(value: string): string {
  return value.normalize('NFC');
}

function literalTokenSequence(value: string): readonly string[] {
  return Object.freeze(
    [...validationText(value).matchAll(LITERAL_PATTERN)].map((match) => match[0]),
  );
}
function extractiveSentences(value: string): ExtractiveSentence[] {
  const text = validationText(value);
  const rawUnits = [...text.matchAll(SENTENCE_UNIT_PATTERN)].map((match) => match[0]);
  if (rawUnits.join('') !== text) return [];
  const sentences: ExtractiveSentence[] = [];
  for (const rawUnit of rawUnits) {
    const canonical = rawUnit.replace(EDGE_HORIZONTAL_WHITESPACE_PATTERN, '');
    const terminator = canonical.match(SENTENCE_TERMINATOR_PATTERN)?.[0] ?? '';
    const body = terminator === '' ? canonical : canonical.slice(0, -terminator.length).trimEnd();
    if (body === '') return [];
    sentences.push(
      Object.freeze({ canonical, body, literalTokens: literalTokenSequence(canonical) }),
    );
  }
  return sentences;
}
function hasQuestionSideContent(value: string): boolean {
  return RELATION_SIDE_HAN_PATTERN.test(value) || RELATION_SIDE_LITERAL_PATTERN.test(value);
}

function hasTrailingQuestionShell(value: string): boolean {
  return QUESTION_TRAILING_SHELL_PHRASES.some(
    (phrase) => value.endsWith(phrase) && hasQuestionSideContent(value.slice(0, -phrase.length)),
  );
}
function isInterrogativeSentence(sentence: ExtractiveSentence, question: string): boolean {
  const terminator = sentence.canonical.match(SENTENCE_TERMINATOR_PATTERN)?.[0] ?? '';
  const body = validationText(sentence.body)
    .toLocaleLowerCase('und')
    .replace(USER_WHITESPACE_PATTERN, '');
  if (
    INTERROGATIVE_TERMINATOR_PATTERN.test(terminator) ||
    hasTrailingQuestionShell(body) ||
    (TERMINAL_QUESTION_PARTICLE_PATTERN.test(body) && hasQuestionSideContent(body.slice(0, -1)))
  ) {
    return true;
  }
  const operators = structuralQuestionOperatorMatches(body);
  if (operators.length === 0) return false;
  const groups = questionTopicGroups(question);
  return (
    groups === null ||
    operators.some(
      (operator) =>
        !groups.some((group) => group.text.includes(operator.phrase) && body.includes(group.text)),
    )
  );
}
function isDeclarativeProposition(sentence: ExtractiveSentence): boolean {
  const terminator = sentence.canonical.match(SENTENCE_TERMINATOR_PATTERN)?.[0] ?? '';
  const isNominalFragment =
    HAN_NOMINAL_FRAGMENT_SUFFIX_PATTERN.test(sentence.body) ||
    LATIN_NOMINAL_FRAGMENT_SUFFIX_PATTERN.test(sentence.body);
  const hasPredicate =
    HAN_DECLARATIVE_PREDICATE_PATTERN.test(sentence.body) ||
    LATIN_DECLARATIVE_PREDICATE_PATTERN.test(sentence.body);
  const hasUnambiguousClause =
    HAN_CLAUSAL_RELATION_PATTERN.test(sentence.body) ||
    LATIN_CLAUSAL_RELATION_PATTERN.test(sentence.body);
  return (
    DECLARATIVE_TERMINATOR_PATTERN.test(terminator) &&
    !MARKDOWN_BLOCK_PREFIX_PATTERN.test(sentence.body) &&
    hasPredicate &&
    (!isNominalFragment || hasUnambiguousClause)
  );
}

function maskPhrasesToFixedPoint(value: string, phrases: readonly string[]): string {
  let text = value;
  while (true) {
    let masked = text;
    for (const phrase of phrases) masked = masked.replaceAll(phrase, ' ');
    if (masked === text) return masked;
    text = masked;
  }
}

function stripTerminalQuestionParticle(value: string): string {
  return value.replace(TERMINAL_QUESTION_PARTICLE_PATTERN, ' ');
}

function structuralQuestionOperatorMatches(
  value: string,
): readonly { index: number; phrase: string }[] {
  const matches: { index: number; phrase: string }[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const phrase = QUESTION_STRUCTURAL_OPERATOR_PHRASES.find((candidate) =>
      value.startsWith(candidate, index),
    );
    if (!phrase) continue;
    const end = index + phrase.length;
    const hasRight = hasQuestionSideContent(value.slice(end));
    const structurallyPlaced =
      hasRight && (index === 0 || hasQuestionSideContent(value.slice(0, index)));
    if (structurallyPlaced) matches.push({ index, phrase });
    index = end - 1;
  }
  return matches;
}

function valueQuestionOperatorMatches(value: string): readonly { index: number; phrase: string }[] {
  const matches: { index: number; phrase: string }[] = [];
  for (const phrase of QUESTION_VALUE_OPERATOR_PHRASES) {
    let fromIndex = 0;
    while (fromIndex <= value.length - phrase.length) {
      const index = value.indexOf(phrase, fromIndex);
      if (index < 0) break;
      if (
        hasQuestionSideContent(value.slice(index + phrase.length)) &&
        (index === 0 || hasQuestionSideContent(value.slice(0, index)))
      ) {
        matches.push({ index, phrase });
      }
      fromIndex = index + phrase.length;
    }
  }
  for (const match of value.matchAll(QUESTION_COUNTING_GE_PATTERN)) {
    const index = match.index;
    if (
      hasQuestionSideContent(value.slice(index + match[0].length)) &&
      (index === 0 || hasQuestionSideContent(value.slice(0, index)))
    ) {
      matches.push({ index, phrase: match[0] });
    }
  }
  return matches.sort((left, right) => left.index - right.index);
}

function stripQuestionClauseShell(value: string): StrippedQuestionClause | null {
  const withoutTerminalParticle = stripTerminalQuestionParticle(value);
  const removedTerminalParticle = withoutTerminalParticle !== value;
  let text = withoutTerminalParticle.trimEnd();
  const suffix = QUESTION_TRAILING_SHELL_PHRASES.find(
    (phrase) => text.endsWith(phrase) && hasQuestionSideContent(text.slice(0, -phrase.length)),
  );
  const usedSuffix = suffix !== undefined;
  const trailingSlot = suffix
    ? TRAILING_QUANTITY_SHELLS.has(suffix)
      ? QUESTION_QUANTITY_SLOT
      : TRAILING_CHOICE_SHELLS.has(suffix)
        ? QUESTION_CHOICE_SLOT
        : null
    : null;
  if (suffix) {
    const prefix = text.slice(0, -suffix.length);
    text = `${prefix}${suffix === '是多少' ? '是' : ''}${trailingSlot ?? ''}`;
  }
  for (const scaffold of QUESTION_DEMONSTRATIVE_SCAFFOLD_PHRASES) {
    if (text.startsWith(scaffold) && hasQuestionSideContent(text.slice(scaffold.length))) {
      text = text.slice(scaffold.length);
      break;
    }
  }
  if (usedSuffix) {
    return {
      text,
      removedStructuralOperator: trailingSlot !== null,
      removedQuestionShell: true,
    };
  }

  const operators = structuralQuestionOperatorMatches(text);
  const valueOperators = valueQuestionOperatorMatches(text);
  if (operators.length + valueOperators.length > 1) return null;
  const [valueOperator] = valueOperators;
  if (valueOperator) {
    const slot =
      valueOperator.phrase === '多少' || valueOperator.phrase === '几'
        ? QUESTION_QUANTITY_SLOT
        : QUESTION_CHOICE_SLOT;
    text = `${text.slice(0, valueOperator.index)}${slot}${text.slice(
      valueOperator.index + valueOperator.phrase.length,
    )}`;
    return { text, removedStructuralOperator: true, removedQuestionShell: true };
  }
  const [operator] = operators;
  if (operator) {
    text = `${text.slice(0, operator.index)}${text.slice(operator.index + operator.phrase.length)}`;
  }
  return {
    text,
    removedStructuralOperator: operator !== undefined,
    removedQuestionShell: removedTerminalParticle || operator !== undefined,
  };
}

function connectedSkeletonText(value: string): string {
  return [
    ...validationText(value).toLocaleLowerCase('und').matchAll(QUESTION_SKELETON_ATOM_PATTERN),
  ]
    .map((match) => match[0])
    .join('');
}

function connectedSkeletonPatternText(value: string): string {
  return value
    .split(QUESTION_VALUE_SLOT_SPLIT_PATTERN)
    .map((part) =>
      part === QUESTION_QUANTITY_SLOT ||
      part === QUESTION_CHOICE_SLOT ||
      part === QUESTION_OPTIONAL_QUANTITY_SLOT
        ? part
        : connectedSkeletonText(part),
    )
    .join('');
}

function parsedQuestionObligations(
  value: string,
): readonly { text: string; removedStructuralOperator: boolean }[] | null {
  const compact = validationText(value)
    .toLocaleLowerCase('und')
    .replace(QUESTION_HAN_WHITESPACE_PATTERN, '');
  const obligations: { text: string; removedStructuralOperator: boolean }[] = [];
  let pendingContext = '';
  for (const clauseMatch of compact.matchAll(QUESTION_CLAUSE_PATTERN)) {
    const shelled = stripQuestionClauseShell(clauseMatch[0]);
    if (shelled === null) return null;
    const skeleton = connectedSkeletonPatternText(shelled.text);
    if (skeleton.replaceAll(QUESTION_QUANTITY_SLOT, '').replaceAll(QUESTION_CHOICE_SLOT, '') === '')
      continue;
    if (shelled.removedQuestionShell) {
      obligations.push({
        text: `${pendingContext}${shelled.text}`,
        removedStructuralOperator: shelled.removedStructuralOperator,
      });
      pendingContext = '';
    } else {
      pendingContext += shelled.text;
    }
  }
  if (pendingContext !== '') {
    obligations.push({ text: pendingContext, removedStructuralOperator: false });
  }
  return obligations;
}

function answerConnectedSubclauses(
  sentence: ExtractiveSentence,
): readonly { text: string; skeleton: string }[] {
  return Object.freeze(
    [...sentence.body.matchAll(ANSWER_SUBCLAUSE_PATTERN)]
      .map((match) => ({
        text: validationText(match[0]).toLocaleLowerCase('und'),
        skeleton: connectedSkeletonText(match[0]),
      }))
      .filter((value) => value.skeleton !== ''),
  );
}

function validQuestionSlotFill(slot: string, fill: string): boolean {
  if (slot === QUESTION_OPTIONAL_QUANTITY_SLOT && fill === '') return true;
  if (fill === '') return false;
  if (slot !== QUESTION_CHOICE_SLOT) return QUESTION_QUANTITY_VALUE_PATTERN.test(fill);
  return (
    Array.from(fill).length <= 32 &&
    !QUESTION_UNTYPED_CHOICE_PATTERN.test(fill) &&
    !HAN_CLAUSAL_ARGUMENT_RELATION_PHRASES.some(
      (phrase) => Array.from(phrase).length >= 2 && fill.includes(phrase),
    ) &&
    !HAN_STANDALONE_PREDICATE_PHRASES.some((phrase) => fill.includes(phrase))
  );
}

function matchesConnectedSkeleton(pattern: string, target: string): boolean {
  if (!QUESTION_VALUE_SLOT_SPLIT_PATTERN.test(pattern)) {
    return target.includes(pattern);
  }
  const parts = pattern.split(QUESTION_VALUE_SLOT_SPLIT_PATTERN).filter((part) => part !== '');
  let cursor = 0;
  let pendingSlot: string | null = null;
  for (const part of parts) {
    if (
      part === QUESTION_QUANTITY_SLOT ||
      part === QUESTION_CHOICE_SLOT ||
      part === QUESTION_OPTIONAL_QUANTITY_SLOT
    ) {
      if (pendingSlot !== null) return false;
      pendingSlot = part;
      continue;
    }
    const found = target.indexOf(part, cursor);
    if (found < 0) return false;
    if (pendingSlot !== null) {
      const fill = target.slice(cursor, found);
      if (!validQuestionSlotFill(pendingSlot, fill)) return false;
      pendingSlot = null;
    }
    cursor = found + part.length;
  }
  return pendingSlot === null || validQuestionSlotFill(pendingSlot, target.slice(cursor));
}

function setHanRelevanceAnchors(anchors: Map<string, RelevanceAnchor>, text: string): void {
  for (const match of text.matchAll(HAN_PATTERN)) {
    const points = Array.from(match[0]);
    for (const size of [2, 3] as const) {
      for (let index = 0; index + size <= points.length; index += 1) {
        const token = points.slice(index, index + size).join('');
        const anchor = { key: `han${size}:${token}`, kind: 'han' as const, text: token };
        anchors.set(anchor.key, anchor);
      }
    }
  }
}

function setLiteralRelevanceAnchors(anchors: Map<string, RelevanceAnchor>, text: string): void {
  for (const match of text.matchAll(LITERAL_PATTERN)) {
    const anchor = {
      key: `literal:${match[0]}`,
      kind: 'literal' as const,
      text: match[0],
    };
    anchors.set(anchor.key, anchor);
  }
}

function relevanceAnchors(value: string): Map<string, RelevanceAnchor> {
  const text = validationText(value).toLocaleLowerCase('und');
  const anchors = new Map<string, RelevanceAnchor>();
  setHanRelevanceAnchors(anchors, text);
  setLiteralRelevanceAnchors(anchors, text);
  return anchors;
}

function questionTopicGroupsFromText(
  text: string,
  removedStructuralOperator: boolean,
): readonly QuestionTopicGroup[] {
  const groups: QuestionTopicGroup[] = [];
  const compact = text.replace(USER_WHITESPACE_PATTERN, '');
  for (const match of compact.matchAll(HAN_PATTERN)) {
    if (Array.from(match[0]).length < 2) continue;
    const split = removedStructuralOperator ? splitInteriorQuestionAction(match[0]) : null;
    if (split) {
      groups.push({ text: split[0], predicateContext: 'action' });
      groups.push({ text: split[1], predicateContext: 'none' });
      continue;
    }
    const actionContext =
      SHORT_TOPIC_ACTIONS.has(match[0]) ||
      (removedStructuralOperator &&
        [...SHORT_TOPIC_ACTIONS].some((phrase) => match[0].endsWith(phrase)));
    const standaloneContext =
      SHORT_TOPIC_STANDALONES.has(match[0]) ||
      (removedStructuralOperator &&
        [...SHORT_TOPIC_STANDALONES].some((phrase) => match[0].endsWith(phrase)));
    groups.push({
      text: match[0],
      predicateContext: actionContext ? 'action' : standaloneContext ? 'standalone' : 'none',
    });
  }
  return Object.freeze(groups);
}

function literalQualifiers(value: string): ReadonlyMap<string, RelevanceAnchor> {
  const anchors = new Map<string, RelevanceAnchor>();
  setLiteralRelevanceAnchors(anchors, validationText(value).toLocaleLowerCase('und'));
  return anchors;
}

function splitInteriorQuestionAction(value: string): readonly [string, string] | null {
  for (const action of SHORT_TOPIC_ACTIONS) {
    const index = value.indexOf(action);
    const end = index + action.length;
    if (index > 0 && end < value.length) return [value.slice(0, end), value.slice(end)];
  }
  return null;
}

function questionObligations(value: string): readonly QuestionObligation[] | null {
  const parsed = parsedQuestionObligations(value);
  if (parsed === null) return null;
  const obligations: QuestionObligation[] = [];
  for (const { text, removedStructuralOperator } of parsed) {
    const directPattern = connectedSkeletonPatternText(text);
    const split =
      removedStructuralOperator && !QUESTION_VALUE_SLOT_SPLIT_PATTERN.test(directPattern)
        ? splitInteriorQuestionAction(directPattern)
        : null;
    const pattern = split
      ? `${split[0]}${QUESTION_OPTIONAL_QUANTITY_SLOT}${split[1]}`
      : directPattern;
    if (
      pattern
        .replaceAll(QUESTION_QUANTITY_SLOT, '')
        .replaceAll(QUESTION_CHOICE_SLOT, '')
        .replaceAll(QUESTION_OPTIONAL_QUANTITY_SLOT, '') === ''
    )
      continue;
    obligations.push(
      Object.freeze({
        pattern,
        topicGroups: questionTopicGroupsFromText(text, removedStructuralOperator),
        literalQualifiers: literalQualifiers(text),
      }),
    );
  }
  return Object.freeze(obligations);
}
function questionTopicGroups(value: string): readonly QuestionTopicGroup[] | null {
  const obligations = questionObligations(value);
  return obligations === null
    ? null
    : Object.freeze(obligations.flatMap((obligation) => obligation.topicGroups));
}
function literalAnchorIsDiscriminating(anchor: RelevanceAnchor): boolean {
  if (
    anchor.kind !== 'literal' ||
    GENERIC_LITERAL_TOPIC_TOKENS.has(anchor.text) ||
    YEAR_LITERAL_PATTERN.test(anchor.text)
  ) {
    return false;
  }
  return (
    (LATIN_LITERAL_PATTERN.test(anchor.text) && Array.from(anchor.text).length >= 2) ||
    (ASCII_INTEGER_LITERAL_PATTERN.test(anchor.text) && anchor.text.length >= 3)
  );
}

function hasDeclarativeContinuation(
  target: string,
  end: number,
  allowTerminal: boolean,
  allowLiteralContinuation: boolean,
): boolean {
  const suffix = target.slice(end).trimStart();
  if (suffix === '') return allowTerminal;
  if (!HAN_PREFIX_PATTERN.test(suffix)) return allowLiteralContinuation;
  return (
    DECLARATIVE_CONTINUATION_PHRASES.some((phrase) => suffix.startsWith(phrase)) ||
    CLAUSE_CONTINUATION_PHRASES.some(
      (phrase) => suffix.startsWith(phrase) && hasQuestionSideContent(suffix.slice(phrase.length)),
    )
  );
}

function localSubclausePrefix(target: string, end: number): string {
  const prefix = target.slice(0, end);
  const boundary = Math.max(prefix.lastIndexOf('，'), prefix.lastIndexOf(','));
  return prefix.slice(boundary + 1);
}

function prefixBeforeNextPredicate(value: string): string {
  let end = value.length;
  for (const phrase of DECLARATIVE_CONTINUATION_PHRASES) {
    const index = value.indexOf(phrase);
    if (index >= 0) end = Math.min(end, index);
  }
  return value.slice(0, end);
}

function hasNominalizedActionContinuation(target: string, end: number): boolean {
  const suffix = target.slice(end).trimStart();
  let boundary = suffix.length;
  for (const phrase of CLAUSE_CONTINUATION_PHRASES) {
    const index = suffix.indexOf(phrase);
    if (index >= 0) boundary = Math.min(boundary, index);
  }
  const local = suffix.slice(0, boundary);
  return HAN_NOMINAL_FRAGMENT_SUFFIXES.some((phrase) => {
    const index = local.indexOf(phrase);
    if (index < 0) return false;
    const following = local.slice(index + phrase.length).trimStart();
    return (
      local.slice(0, index).trimEnd().endsWith('的') ||
      following === '' ||
      HAN_DECLARATIVE_PREDICATE_PATTERN.test(following)
    );
  });
}

function actionGroupHasSubject(group: string): boolean {
  const action = [...SHORT_TOPIC_ACTIONS].find((phrase) => group.endsWith(phrase));
  if (!action) return false;
  return Array.from(group.slice(0, -action.length)).some((point) => /\p{Script=Han}/u.test(point));
}

function hasTopicGroupCoverage(
  group: string,
  target: string,
  predicateContext: QuestionTopicGroup['predicateContext'],
  hasTypedValueSlot: boolean,
): boolean {
  let fromIndex = 0;
  while (fromIndex <= target.length - group.length) {
    const index = target.indexOf(group, fromIndex);
    if (index < 0) return false;
    const localPrefix = localSubclausePrefix(target, index);
    const hasUnsupportedPrefix =
      LEADING_SEMANTIC_NEGATION_PATTERN.test(localPrefix) ||
      LOCAL_SCOPE_MISMATCH_PATTERN.test(localPrefix);
    const hasUnsupportedFollowingScope = LOCAL_UNCERTAINTY_SCOPE_PATTERN.test(
      prefixBeforeNextPredicate(target.slice(index + group.length)),
    );
    const hasRequiredPredicateContext =
      predicateContext === 'none' ||
      (predicateContext === 'action' && hasTypedValueSlot) ||
      hasDeclarativeContinuation(
        target,
        index + group.length,
        predicateContext === 'standalone',
        predicateContext === 'action' && actionGroupHasSubject(group),
      );
    const hasNominalBridgePrefix =
      predicateContext === 'action' &&
      SUBSTANTIVE_HAN_FUNCTION_PHRASES.some((phrase) => localPrefix.includes(phrase));
    const hasPriorPredicate =
      predicateContext === 'action' &&
      (DECLARATIVE_CONTINUATION_PHRASES.some((phrase) => localPrefix.trimEnd().endsWith(phrase)) ||
        HAN_DECLARATIVE_PREDICATE_PATTERN.test(localPrefix) ||
        LATIN_DECLARATIVE_PREDICATE_PATTERN.test(localPrefix));
    const hasNominalizedAction =
      predicateContext === 'action' &&
      hasNominalizedActionContinuation(target, index + group.length);
    if (
      !hasUnsupportedPrefix &&
      !hasUnsupportedFollowingScope &&
      !hasNominalBridgePrefix &&
      !hasPriorPredicate &&
      !hasNominalizedAction &&
      hasRequiredPredicateContext
    ) {
      return true;
    }
    fromIndex = index + 1;
  }
  return false;
}

function hasDiscriminatingLiteralCoverage(
  queryLiterals: ReadonlyMap<string, RelevanceAnchor>,
  target: ReadonlyMap<string, RelevanceAnchor>,
): boolean {
  return [...queryLiterals.values()].some(
    (anchor) => literalAnchorIsDiscriminating(anchor) && target.has(anchor.key),
  );
}

function hasEveryLiteralQualifier(
  queryLiterals: ReadonlyMap<string, RelevanceAnchor>,
  target: ReadonlyMap<string, RelevanceAnchor>,
): boolean {
  return [...queryLiterals.keys()].every((key) => target.has(key));
}

function hasNovelSubstantiveLiteral(
  question: ReadonlyMap<string, RelevanceAnchor>,
  answer: ReadonlyMap<string, RelevanceAnchor>,
): boolean {
  return [...answer.values()].some((anchor) => {
    if (anchor.kind !== 'literal' || question.has(anchor.key)) return false;
    if (NUMERIC_LITERAL_PATTERN.test(anchor.text)) return !YEAR_LITERAL_PATTERN.test(anchor.text);
    return (
      LATIN_LITERAL_PATTERN.test(anchor.text) &&
      Array.from(anchor.text).length >= 2 &&
      !GENERIC_INFORMATION_GAIN_LITERAL_TOKENS.has(anchor.text) &&
      !LATIN_INFORMATION_GAIN_NOISE_PATTERN.test(anchor.text) &&
      !YEAR_LITERAL_PATTERN.test(anchor.text)
    );
  });
}

function hasSubstantiveHanContent(
  sentence: ExtractiveSentence,
  topicGroups: readonly string[],
  questionAnchors: ReadonlyMap<string, RelevanceAnchor>,
): boolean {
  let text = validationText(sentence.body).toLocaleLowerCase('und');
  text = maskPhrasesToFixedPoint(text, topicGroups);
  text = maskPhrasesToFixedPoint(text, [
    ...HAN_DECLARATIVE_ARGUMENT_PREDICATE_PHRASES,
    ...HAN_STANDALONE_PREDICATE_PHRASES,
  ]);
  text = maskPhrasesToFixedPoint(text, SUBSTANTIVE_HAN_NOISE_PHRASES);
  text = text.replace(SUBSTANTIVE_DEMONSTRATIVE_RUN_PATTERN, ' ');
  text = maskPhrasesToFixedPoint(text, SUBSTANTIVE_HAN_FUNCTION_PHRASES);
  return [...text.matchAll(HAN_PATTERN)].some((match) => {
    const residualAnchors = new Map<string, RelevanceAnchor>();
    setHanRelevanceAnchors(residualAnchors, match[0]);
    return [...residualAnchors.keys()].some((key) => !questionAnchors.has(key));
  });
}

function hasSubstantiveInformationGain(
  sentence: ExtractiveSentence,
  topicGroups: readonly string[],
  questionAnchors: ReadonlyMap<string, RelevanceAnchor>,
): boolean {
  return (
    hasSubstantiveHanContent(sentence, topicGroups, questionAnchors) ||
    hasNovelSubstantiveLiteral(questionAnchors, relevanceAnchors(sentence.body))
  );
}

function isNominalFragmentBody(body: string): boolean {
  return (
    HAN_NOMINAL_FRAGMENT_SUFFIX_PATTERN.test(body) ||
    LATIN_NOMINAL_FRAGMENT_SUFFIX_PATTERN.test(body)
  );
}

function hasPredicateOutsideTopicSpan(
  sentence: ExtractiveSentence,
  strictTopicGroups: readonly string[],
): boolean {
  if (!isNominalFragmentBody(sentence.body)) return true;
  const text = maskPhrasesToFixedPoint(
    validationText(sentence.body).toLocaleLowerCase('und'),
    strictTopicGroups,
  );
  return (
    HAN_DECLARATIVE_PREDICATE_PATTERN.test(text) || LATIN_DECLARATIVE_PREDICATE_PATTERN.test(text)
  );
}

function sentenceSupportsObligation(
  sentence: ExtractiveSentence,
  obligation: QuestionObligation,
  allQuestionAnchors: ReadonlyMap<string, RelevanceAnchor>,
): boolean {
  const strictTopicGroups = obligation.topicGroups.map((group) => group.text);
  const hasTypedValueSlot =
    obligation.pattern.includes(QUESTION_QUANTITY_SLOT) ||
    obligation.pattern.includes(QUESTION_CHOICE_SLOT) ||
    obligation.pattern.includes(QUESTION_OPTIONAL_QUANTITY_SLOT);
  const hasRequiredTypedValueSlot = !obligation.pattern.includes(QUESTION_OPTIONAL_QUANTITY_SLOT);
  const matchingSubclauses = answerConnectedSubclauses(sentence).filter((subclause) =>
    matchesConnectedSkeleton(obligation.pattern, subclause.skeleton),
  );
  if (matchingSubclauses.length === 0) return false;
  const directSubclause = matchingSubclauses.some((subclause) => {
    const anchors = relevanceAnchors(subclause.text);
    if (obligation.topicGroups.length === 0) {
      return (
        hasDiscriminatingLiteralCoverage(obligation.literalQualifiers, anchors) &&
        hasEveryLiteralQualifier(obligation.literalQualifiers, anchors)
      );
    }
    return (
      obligation.topicGroups.every((group) =>
        hasTopicGroupCoverage(
          group.text,
          subclause.text,
          group.predicateContext,
          hasTypedValueSlot,
        ),
      ) && hasEveryLiteralQualifier(obligation.literalQualifiers, anchors)
    );
  });
  return (
    directSubclause &&
    hasPredicateOutsideTopicSpan(sentence, strictTopicGroups) &&
    ((hasRequiredTypedValueSlot && hasTypedValueSlot) ||
      hasSubstantiveInformationGain(sentence, strictTopicGroups, allQuestionAnchors))
  );
}

function hasQuestionCoverage(question: string, sentences: readonly ExtractiveSentence[]): boolean {
  const obligations = questionObligations(question);
  if (obligations === null || obligations.length === 0) return false;
  const allQuestionAnchors = relevanceAnchors(question);
  const bindings = sentences.map((sentence) =>
    obligations
      .map((obligation, index) =>
        sentenceSupportsObligation(sentence, obligation, allQuestionAnchors) ? index : -1,
      )
      .filter((index) => index >= 0),
  );
  return (
    bindings.every((indexes) => indexes.length === 1) &&
    obligations.every((_, index) => bindings.some(([bound]) => bound === index))
  );
}

function sentenceSupportKey(sentence: ExtractiveSentence): string {
  return JSON.stringify([sentence.canonical, sentence.literalTokens]);
}
function citedSentenceSupport(
  hits: readonly GroundedKnowledgeSearchHit[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const support = new Map<string, Set<string>>();
  for (const hit of hits) {
    const sentences = extractiveSentences(hit.excerpt);
    for (let index = 0; index < sentences.length; index += 1) {
      const sentence = sentences[index]!;
      if (
        (index === 0 && hit.excerpt.startsWith('…')) ||
        (index === sentences.length - 1 && hit.excerpt.endsWith('…'))
      ) {
        continue;
      }
      const key = sentenceSupportKey(sentence);
      const chunkIds = support.get(key) ?? new Set<string>();
      chunkIds.add(hit.chunkId);
      support.set(key, chunkIds);
    }
  }
  return support;
}
export function hasGroundedLexicalSupport(input: {
  question: string;
  answer: string;
  citationChunkIds: readonly string[];
  exposedHits: readonly GroundedKnowledgeSearchHit[];
}): boolean {
  if (input.citationChunkIds.length === 0) return false;
  const hitsById = new Map(input.exposedHits.map((hit) => [hit.chunkId, hit]));
  const citedHits: GroundedKnowledgeSearchHit[] = [];
  for (let index = 0; index < input.citationChunkIds.length; index += 1) {
    const chunkId = input.citationChunkIds[index]!;
    if (index > 0 && input.citationChunkIds[index - 1]! >= chunkId) return false;
    const hit = hitsById.get(chunkId);
    if (!hit) return false;
    citedHits.push(hit);
  }

  const sentences = extractiveSentences(input.answer);
  if (
    sentences.length === 0 ||
    sentences.some(
      (sentence) =>
        isInterrogativeSentence(sentence, input.question) || !isDeclarativeProposition(sentence),
    ) ||
    !hasQuestionCoverage(input.question, sentences)
  ) {
    return false;
  }

  const supportBySentence = citedSentenceSupport(citedHits);
  const supportingChunkIds = new Set<string>();
  for (const sentence of sentences) {
    const chunkIds = supportBySentence.get(sentenceSupportKey(sentence));
    if (!chunkIds || chunkIds.size === 0) return false;
    for (const chunkId of chunkIds) supportingChunkIds.add(chunkId);
  }

  return citedHits.every((hit) => supportingChunkIds.has(hit.chunkId));
}
