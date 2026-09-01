import type {
  CreatorKnowledgeBundle,
  CreatorKnowledgeChunk,
} from '@cb/creator-agent-protocol/knowledge-bundle';

const EXCERPT_MAX_CODE_POINTS = 1_200;
const HAN_PATTERN = /\p{Script=Han}+/gu;
const LITERAL_PATTERN = /[\p{Script=Latin}\p{N}]+(?:[-._:/+][\p{Script=Latin}\p{N}]+)*/gu;
const CLAIM_SEPARATOR_PATTERN = /[。！？!?；;，,\n]+/gu;

interface LexicalFeature {
  key: string;
  text: string;
  weight: number;
  strength: 'weak' | 'strong';
  literal: boolean;
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
 * Chinese words are not whitespace-delimited, so retrieval and validation use overlapping Han
 * bigrams/trigrams. Latin and numeric material remains an exact whole token so dates, amounts,
 * versions, HTTP codes, and identifiers cannot be supported by partial substrings.
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
        strength: 'weak',
        literal: false,
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
          strength: size === 3 ? 'strong' : 'weak',
          literal: false,
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
      strength: 'strong',
      literal: true,
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

function hasStrongOverlap(
  left: ReadonlyMap<string, LexicalFeature>,
  right: ReadonlyMap<string, LexicalFeature>,
): boolean {
  let weakMatches = 0;
  for (const feature of left.values()) {
    if (!right.has(feature.key)) continue;
    if (feature.strength === 'strong') return true;
    weakMatches += 1;
  }
  return weakMatches >= 2;
}

function claimHasSupport(claim: string, evidence: ReadonlyMap<string, LexicalFeature>): boolean {
  const features = lexicalFeatures(claim);
  if (features.size === 0) return false;
  for (const feature of features.values()) {
    if (feature.literal && !evidence.has(feature.key)) return false;
  }
  const total = [...features.values()].reduce((sum, feature) => sum + feature.weight, 0);
  const matched = [...features.values()].reduce(
    (sum, feature) => sum + (evidence.has(feature.key) ? feature.weight : 0),
    0,
  );
  return hasStrongOverlap(features, evidence) && matched * 2 >= total;
}

/**
 * Conservative Test-only lexical support guard. Passing it means every candidate clause and
 * citation has strong lexical support in the excerpts exposed to this Turn. It does not prove
 * semantic entailment or factual truth; the immutable receipt records the policy version so this
 * limited claim remains auditable.
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

  const answerFeatures = lexicalFeatures(input.answer);
  const evidenceFeatures = lexicalFeatures(citedHits.map((hit) => hit.excerpt).join('\n'));
  if (!hasStrongOverlap(lexicalFeatures(input.question), evidenceFeatures)) return false;
  const claims = input.answer
    .split(CLAIM_SEPARATOR_PATTERN)
    .map((claim) => claim.trim())
    .filter(Boolean);
  if (claims.length === 0 || claims.some((claim) => !claimHasSupport(claim, evidenceFeatures))) {
    return false;
  }

  // Every listed citation must support the answer itself; labels never count as evidence here.
  return citedHits.every((hit) => hasStrongOverlap(answerFeatures, lexicalFeatures(hit.excerpt)));
}
