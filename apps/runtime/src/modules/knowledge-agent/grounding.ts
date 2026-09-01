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
const INTERROGATIVE_TERMINATOR_PATTERN = /[?？]/u;
const DECLARATIVE_TERMINATOR_PATTERN = /[。；;！!]/u;
const MARKDOWN_BLOCK_PREFIX_PATTERN = /^(?:#{1,6}|[-*+]\s|\d{1,9}[.)、]\s|>\s?)/u;
const HAN_EDGE_GRAMMATICAL_PARTICLE_PATTERN = /^的+|的+$/gu;
const INTERROGATIVE_PHRASE_PATTERN =
  /请问|如何|为什么|为何|怎么回事|怎么|怎样|什么|多少|哪些|哪个|哪一个|哪种|哪家|哪里|哪儿|谁|何时|什么时候|是不是|有没有|能不能|可不可以|是否|能否|可否|几(?:个|次|种|天|年|月|元)|吗$|呢$/u;
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
  '允许',
  '禁止',
  '收取',
  '支付',
  '扣除',
  '释放',
  '提示',
  '支持',
  '适用',
]);
const HAN_STANDALONE_PREDICATE_PHRASES = Object.freeze(['存在', '生效', '失效', '开启', '关闭']);
const HAN_DECLARATIVE_ARGUMENT_PREDICATE_PHRASES = Object.freeze([
  ...HAN_CLAUSAL_ARGUMENT_RELATION_PHRASES,
  ...HAN_ACTION_ARGUMENT_PREDICATE_PHRASES,
]);
const HAN_TOPIC_MASK_RELATION_PHRASES = Object.freeze([...HAN_CLAUSAL_ARGUMENT_RELATION_PHRASES]);
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
const QUESTION_FORM_NOISE_PHRASES = Object.freeze([
  '什么时候',
  '为什么',
  '怎么回事',
  '可不可以',
  '是不是',
  '有没有',
  '能不能',
  '是多少',
  '是什么',
  '哪一个',
  '怎么样',
  '如何',
  '为何',
  '怎么',
  '怎样',
  '什么',
  '多少',
  '哪些',
  '哪个',
  '哪种',
  '哪家',
  '哪里',
  '哪儿',
  '何时',
  '是否',
  '能否',
  '可否',
  '请问',
  '意味着',
  '代表',
  '表示',
  '含义',
  '意思',
  '谁',
  '吗',
  '呢',
]);
const QUESTION_FORM_MASK_PHRASES = Object.freeze(
  [...QUESTION_FORM_NOISE_PHRASES].sort(
    (left, right) => right.length - left.length || left.localeCompare(right),
  ),
);
const GENERIC_HAN_TOPIC_PHRASES = Object.freeze([
  '系统',
  '内容',
  '信息',
  '问题',
  '答案',
  ...HAN_NOMINAL_FRAGMENT_SUFFIXES,
]);
const QUESTION_TOPIC_MASK_PHRASES = Object.freeze(
  [
    ...new Set([
      ...QUESTION_FORM_MASK_PHRASES,
      ...GENERIC_HAN_TOPIC_PHRASES,
      ...HAN_TOPIC_MASK_RELATION_PHRASES,
    ]),
  ].sort((left, right) => right.length - left.length || left.localeCompare(right)),
);
const GENERIC_LITERAL_TOPIC_TOKENS = new Set(['api', 'http', 'https']);
const YEAR_LITERAL_PATTERN = /^(?:19|20)\d{2}$/u;
const LATIN_LITERAL_PATTERN = /\p{Script=Latin}/u;
const ASCII_INTEGER_LITERAL_PATTERN = /^\d+$/u;

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

/**
 * Chinese words are not whitespace-delimited, so retrieval uses overlapping Han bigrams/trigrams.
 * Latin and numeric material remains a whole token for stable search scoring. Billable validation
 * below deliberately uses a narrower NFC-preserving representation instead of this NFKC index.
 */
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

function isInterrogativeSentence(sentence: ExtractiveSentence): boolean {
  const terminator = sentence.canonical.match(SENTENCE_TERMINATOR_PATTERN)?.[0] ?? '';
  return (
    INTERROGATIVE_TERMINATOR_PATTERN.test(terminator) ||
    INTERROGATIVE_PHRASE_PATTERN.test(sentence.body)
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

function questionRelevanceText(value: string): string {
  const text = validationText(value).toLocaleLowerCase('und');
  return maskPhrasesToFixedPoint(text, QUESTION_FORM_MASK_PHRASES);
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

function relevanceAnchors(
  value: string,
  mode: 'answer' | 'question',
): Map<string, RelevanceAnchor> {
  const text =
    mode === 'answer'
      ? validationText(value).toLocaleLowerCase('und')
      : questionRelevanceText(value);
  const anchors = new Map<string, RelevanceAnchor>();
  setHanRelevanceAnchors(anchors, text);
  setLiteralRelevanceAnchors(anchors, text);
  return anchors;
}

function questionTopicGroups(value: string): readonly ReadonlyMap<string, RelevanceAnchor>[] {
  // User whitespace is not a semantic boundary, but every masked platform-grammar phrase inserts
  // one. Topic masking is deliberately narrower than declarative grammar: contentful actions such
  // as `支付`, `使用`, and `返回`, plus standalone states such as `生效`, remain topics. Only
  // clausal/modal/copular relations become boundaries.
  const compact = validationText(value)
    .toLocaleLowerCase('und')
    .replace(USER_WHITESPACE_PATTERN, '');
  const text = maskPhrasesToFixedPoint(compact, QUESTION_TOPIC_MASK_PHRASES);
  const groups: Map<string, RelevanceAnchor>[] = [];
  for (const match of text.matchAll(HAN_PATTERN)) {
    const anchors = new Map<string, RelevanceAnchor>();
    const topic = match[0].replace(HAN_EDGE_GRAMMATICAL_PARTICLE_PATTERN, '');
    setHanRelevanceAnchors(anchors, topic);
    if (anchors.size > 0) groups.push(anchors);
  }
  return groups;
}

function questionLiteralQualifiers(value: string): ReadonlyMap<string, RelevanceAnchor> {
  const anchors = new Map<string, RelevanceAnchor>();
  setLiteralRelevanceAnchors(anchors, validationText(value).toLocaleLowerCase('und'));
  return anchors;
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

function hasTopicGroupCoverage(
  group: ReadonlyMap<string, RelevanceAnchor>,
  target: ReadonlyMap<string, RelevanceAnchor>,
): boolean {
  let matched = 0;
  for (const key of group.keys()) matched += Number(target.has(key));
  if (group.size <= 3) return matched === group.size;
  return matched * 4 >= group.size;
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

function hasInformationGain(
  question: ReadonlyMap<string, RelevanceAnchor>,
  answer: ReadonlyMap<string, RelevanceAnchor>,
): boolean {
  return [...answer.keys()].some((key) => !question.has(key));
}

function hasQuestionCoverage(question: string, sentences: readonly ExtractiveSentence[]): boolean {
  const topicGroups = questionTopicGroups(question);
  const literalQualifiers = questionLiteralQualifiers(question);
  const questionAnchors = relevanceAnchors(question, 'question');
  const answerAnchors = relevanceAnchors(
    sentences.map((sentence) => sentence.body).join('\n'),
    'answer',
  );
  if (!hasInformationGain(questionAnchors, answerAnchors)) return false;

  if (topicGroups.length === 0) {
    if (
      !hasDiscriminatingLiteralCoverage(literalQualifiers, answerAnchors) ||
      !hasEveryLiteralQualifier(literalQualifiers, answerAnchors)
    ) {
      return false;
    }
    return sentences.every((sentence) => {
      const sentenceAnchors = relevanceAnchors(sentence.body, 'answer');
      return (
        hasDiscriminatingLiteralCoverage(literalQualifiers, sentenceAnchors) &&
        hasEveryLiteralQualifier(literalQualifiers, sentenceAnchors) &&
        hasInformationGain(questionAnchors, sentenceAnchors)
      );
    });
  }

  if (
    !topicGroups.every((group) => hasTopicGroupCoverage(group, answerAnchors)) ||
    !hasEveryLiteralQualifier(literalQualifiers, answerAnchors)
  ) {
    return false;
  }

  // Every sentence must cover one topic group and all mixed literal qualifiers. Other sentences
  // cannot subsidize an unrelated topic or repair a year/version/API drift after the fact.
  return sentences.every((sentence) => {
    const sentenceAnchors = relevanceAnchors(sentence.body, 'answer');
    return (
      topicGroups.some((group) => hasTopicGroupCoverage(group, sentenceAnchors)) &&
      hasEveryLiteralQualifier(literalQualifiers, sentenceAnchors) &&
      hasInformationGain(questionAnchors, sentenceAnchors)
    );
  });
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
      // Retrieval marks an excerpt cut with an ellipsis. Boundary fragments are not full source
      // sentences and therefore cannot be used as billable extractive evidence.
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

/**
 * Conservative Test-only extractive guard. Every declarative answer sentence must NFC-match one
 * complete cited sentence, including its internal whitespace, terminal punctuation, and ordered
 * Latin/numeric tokens. The proposition gate recognizes the full declarative grammar; the narrower
 * topic mask removes only question/meta/nominal and clausal/modal/copular relations while
 * preserving contentful actions and standalone states. Two- and three-character Han groups require
 * every anchor; longer groups need 25% unweighted bigram/trigram coverage across the answer. Every
 * sentence needs one covered group, and every literal qualifier must appear in every sentence. With
 * no Han group, one discriminating literal plus all literal qualifiers are required; a
 * one-code-point Latin token, short number, lone year, or API token remains insufficient. Passing
 * only proves direct textual support and query relevance in the fixed Package; it does not prove
 * that the source itself is factually true.
 */
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
      (sentence) => isInterrogativeSentence(sentence) || !isDeclarativeProposition(sentence),
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

  // Every listed citation must directly support at least one answer sentence; labels never count.
  return citedHits.every((hit) => supportingChunkIds.has(hit.chunkId));
}
