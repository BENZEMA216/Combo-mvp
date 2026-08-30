import { createHash } from 'node:crypto';
import {
  CREATOR_AGENT_PACKAGE_FILENAME,
  CREATOR_AGENT_PACKAGE_MAX_MANIFEST_BYTES,
  CREATOR_AGENT_PACKAGE_PROTOCOL,
  digestCreatorAgentPackage,
  digestCreatorAgentPackageFile,
  parseCreatorAgentPackageManifest,
  type CreatorAgentPackageFile,
} from '@cb/creator-agent-protocol/agent-package';
import type { CreatorAgentPackageCapability } from '@cb/creator-agent-protocol/agent-package-capability';
import { CREATOR_AGENT_PACKAGE_RELEASE_PROTOCOL } from '@cb/creator-agent-protocol/agent-package-release';
import {
  CREATOR_KNOWLEDGE_BUNDLE_MAX_BYTES,
  CREATOR_KNOWLEDGE_BUNDLE_PROTOCOL,
  CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH,
  CREATOR_KNOWLEDGE_SKILL_PATH,
  parseCreatorKnowledgeBundle,
  resolveCreatorKnowledgeBundleResource,
  type CreatorKnowledgeBundle,
  type CreatorKnowledgeChunk,
} from '@cb/creator-agent-protocol/knowledge-bundle';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { StringEnum, Type, type Static } from '@earendil-works/pi-ai';
import {
  INSUFFICIENT_EVIDENCE_ANSWER,
  KnowledgeAgentBindingSchema,
  type KnowledgeAgentBinding,
} from '@cb/shared';

import type { KnowledgeAgentTestGate } from '../../platform/config/env.js';
import type { Queryable } from '../../platform/infra/db.js';
import {
  BoundedObjectReadError,
  type RuntimeObjectStore,
} from '../../platform/infra/object-store.js';
import type { CapabilitySummary } from '../capability/loader.js';

export const AGENT_PACKAGE_OBJECT_BUCKET = 'combo-artifacts' as const;
const MARKDOWN_MAX_BYTES = 65_536;
const PACKAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const FIXED_PACKAGE_PATHS = new Set<string>([
  CREATOR_AGENT_PACKAGE_FILENAME,
  'AGENT.md',
  CREATOR_KNOWLEDGE_SKILL_PATH,
  CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH,
]);

export type KnowledgeAgentResolutionFailure =
  | 'closed'
  | 'not_found'
  | 'invalid_registry'
  | 'invalid_package'
  | 'aborted'
  | 'unavailable';

const FAILURE_MESSAGES: Readonly<Record<KnowledgeAgentResolutionFailure, string>> = {
  closed: 'controlled knowledge Agent is closed',
  not_found: 'knowledge Agent Release was not found',
  invalid_registry: 'knowledge Agent Registry state is invalid',
  invalid_package: 'knowledge Agent Package is invalid',
  aborted: 'knowledge Agent resolution was aborted',
  unavailable: 'knowledge Agent dependency is unavailable',
};

/** Stable failure category; never includes object keys, Package bytes, DB rows, or provider errors. */
export class KnowledgeAgentResolutionError extends Error {
  constructor(readonly failure: KnowledgeAgentResolutionFailure) {
    super(FAILURE_MESSAGES[failure]);
    this.name = 'KnowledgeAgentResolutionError';
  }
}

interface RegistryReleaseRow {
  release_id: string;
  package_digest: string;
  owner_user_id: string;
  release_protocol: string;
  release_scope: string;
  package_protocol: string;
}

export interface ResolvedKnowledgeAgent {
  binding: KnowledgeAgentBinding;
  name: string;
  description: string;
  instructions: string;
  knowledge: CreatorKnowledgeBundle;
}

export function agentPackageObjectKey(packageDigest: string, manifestPath: string): string {
  if (!PACKAGE_DIGEST_PATTERN.test(packageDigest) || !FIXED_PACKAGE_PATHS.has(manifestPath)) {
    throw new KnowledgeAgentResolutionError('invalid_package');
  }
  return `agent-packages/sha256/${packageDigest.slice('sha256:'.length)}/${manifestPath}`;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new KnowledgeAgentResolutionError('invalid_package');
  }
}

function exactFileMatches(bytes: Uint8Array, file: CreatorAgentPackageFile): boolean {
  return (
    bytes.byteLength === file.byteLength && digestCreatorAgentPackageFile(bytes) === file.digest
  );
}

function gateMatches(
  gate: KnowledgeAgentTestGate | null,
  capability: CapabilitySummary,
  projection: CreatorAgentPackageCapability,
): gate is KnowledgeAgentTestGate {
  return (
    gate !== null &&
    gate.capabilityId === capability.id &&
    gate.publisherUserId === capability.ownerUserId &&
    gate.releaseId === projection.release.releaseId &&
    gate.packageDigest === projection.release.packageDigest
  );
}

function mapReadFailure(error: unknown): never {
  if (error instanceof KnowledgeAgentResolutionError) throw error;
  if (error instanceof BoundedObjectReadError) {
    if (error.failure === 'aborted') throw new KnowledgeAgentResolutionError('aborted');
    if (error.failure === 'too_large' || error.failure === 'invalid_response') {
      throw new KnowledgeAgentResolutionError('invalid_package');
    }
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  ) {
    throw new KnowledgeAgentResolutionError('aborted');
  }
  throw new KnowledgeAgentResolutionError('unavailable');
}

async function readExactFile(
  objectStore: RuntimeObjectStore,
  packageDigest: string,
  file: CreatorAgentPackageFile,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const maximum =
    file.path === CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH
      ? CREATOR_KNOWLEDGE_BUNDLE_MAX_BYTES
      : MARKDOWN_MAX_BYTES;
  if (file.byteLength > maximum) throw new KnowledgeAgentResolutionError('invalid_package');
  let bytes: Uint8Array;
  try {
    bytes = await objectStore.getObjectBounded(
      AGENT_PACKAGE_OBJECT_BUCKET,
      agentPackageObjectKey(packageDigest, file.path),
      file.byteLength,
      signal ? { abortSignal: signal } : undefined,
    );
  } catch (error) {
    mapReadFailure(error);
  }
  if (!exactFileMatches(bytes, file)) throw new KnowledgeAgentResolutionError('invalid_package');
  return bytes;
}

/**
 * Resolves the exact controlled-Test Package. Registry and the frozen digest select bytes; the
 * mutable Capability row contributes only access metadata and must exactly match the gate owner.
 */
export async function resolveKnowledgeAgentPackage(input: {
  db: Queryable;
  objectStore: RuntimeObjectStore;
  capability: CapabilitySummary;
  projection: CreatorAgentPackageCapability;
  gate: KnowledgeAgentTestGate | null;
  signal?: AbortSignal;
}): Promise<ResolvedKnowledgeAgent> {
  if (!gateMatches(input.gate, input.capability, input.projection)) {
    throw new KnowledgeAgentResolutionError('closed');
  }

  let registry;
  try {
    registry = await input.db.query<RegistryReleaseRow>(
      `SELECT r.release_id, r.package_digest, r.owner_user_id,
              r.protocol AS release_protocol, r.release_scope,
              p.protocol AS package_protocol
         FROM agent_package_releases r
         JOIN agent_packages p ON p.package_digest = r.package_digest
        WHERE r.release_id = $1 AND r.package_digest = $2
        LIMIT 1`,
      [input.projection.release.releaseId, input.projection.release.packageDigest],
      input.signal,
    );
  } catch (error) {
    mapReadFailure(error);
  }
  const row = registry.rows[0];
  if (!row) throw new KnowledgeAgentResolutionError('not_found');
  if (
    row.release_id !== input.projection.release.releaseId ||
    row.package_digest !== input.projection.release.packageDigest ||
    row.owner_user_id !== input.capability.ownerUserId ||
    row.owner_user_id !== input.gate.publisherUserId ||
    row.release_protocol !== CREATOR_AGENT_PACKAGE_RELEASE_PROTOCOL ||
    row.release_scope !== 'controlled_test' ||
    row.package_protocol !== CREATOR_AGENT_PACKAGE_PROTOCOL
  ) {
    throw new KnowledgeAgentResolutionError('invalid_registry');
  }

  let manifestBytes: Uint8Array;
  try {
    manifestBytes = await input.objectStore.getObjectBounded(
      AGENT_PACKAGE_OBJECT_BUCKET,
      agentPackageObjectKey(row.package_digest, CREATOR_AGENT_PACKAGE_FILENAME),
      CREATOR_AGENT_PACKAGE_MAX_MANIFEST_BYTES,
      input.signal ? { abortSignal: input.signal } : undefined,
    );
  } catch (error) {
    mapReadFailure(error);
  }

  try {
    const manifest = parseCreatorAgentPackageManifest(decodeUtf8(manifestBytes));
    if (digestCreatorAgentPackage(manifest) !== row.package_digest) {
      throw new KnowledgeAgentResolutionError('invalid_package');
    }
    const { resource } = resolveCreatorKnowledgeBundleResource(manifest);
    const files = new Map<string, Uint8Array>();
    for (const file of manifest.files) {
      files.set(
        file.path,
        await readExactFile(input.objectStore, row.package_digest, file, input.signal),
      );
    }
    const agentMarkdown = files.get('AGENT.md');
    const skillMarkdown = files.get(CREATOR_KNOWLEDGE_SKILL_PATH);
    const bundleBytes = files.get(CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH);
    if (!agentMarkdown || !skillMarkdown || !bundleBytes) {
      throw new KnowledgeAgentResolutionError('invalid_package');
    }
    const knowledge = parseCreatorKnowledgeBundle(decodeUtf8(bundleBytes));
    const binding = KnowledgeAgentBindingSchema.parse({
      productKind: 'knowledge_agent_test',
      capability: {
        id: input.capability.id,
        protocol: input.projection.protocol,
      },
      release: input.projection.release,
      releaseScope: row.release_scope,
      knowledge: {
        protocol: CREATOR_KNOWLEDGE_BUNDLE_PROTOCOL,
        resourcePath: resource.path,
        resourceDigest: resource.digest,
      },
    });
    return Object.freeze({
      binding,
      name: manifest.name,
      description: manifest.description,
      instructions: `${decodeUtf8(agentMarkdown)}\n\n${decodeUtf8(skillMarkdown)}`,
      knowledge,
    });
  } catch (error) {
    if (error instanceof KnowledgeAgentResolutionError) throw error;
    throw new KnowledgeAgentResolutionError('invalid_package');
  }
}

const SEARCH_LIMIT_DEFAULT = 5;
const SEARCH_LIMIT_MAX = 8;
const QUERY_MAX_UTF8_BYTES = 1_024;
const ANSWER_MAX_UTF8_BYTES = 32 * 1_024;
const EXCERPT_MAX_CODE_POINTS = 1_200;
const EMPTY_CITATIONS = Object.freeze([]) as readonly [];

const SearchParams = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: QUERY_MAX_UTF8_BYTES }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: SEARCH_LIMIT_MAX })),
  },
  { additionalProperties: false },
);
type SearchParamsT = Static<typeof SearchParams>;

const SubmitParams = Type.Object(
  {
    status: StringEnum(['answered', 'insufficient_evidence']),
    answer: Type.Optional(Type.String({ minLength: 1, maxLength: ANSWER_MAX_UTF8_BYTES })),
    citationChunkIds: Type.Optional(
      Type.Array(Type.String({ pattern: '^chunk[.]knowledge[.][0-9a-f]{32}$' }), {
        maxItems: 32,
      }),
    ),
  },
  { additionalProperties: false },
);
type SubmitParamsT = Static<typeof SubmitParams>;

export interface KnowledgeSearchHit {
  chunkId: string;
  sourceId: string;
  displayLabel: string;
  contentDigest: string;
  excerpt: string;
}

export type KnowledgeAnswerCandidate =
  | Readonly<{ status: 'answered'; answer: string; citationChunkIds: readonly string[] }>
  | Readonly<{
      status: 'insufficient_evidence';
      answer: typeof INSUFFICIENT_EVIDENCE_ANSWER;
      citationChunkIds: readonly [];
    }>;

interface KnowledgeSearchDetails {
  query: string;
  hits: KnowledgeSearchHit[];
}

interface KnowledgeSubmitDetails {
  acceptedForValidation: true;
  status: KnowledgeAnswerCandidate['status'];
}

export type KnowledgeAgentTool =
  | AgentTool<typeof SearchParams, KnowledgeSearchDetails>
  | AgentTool<typeof SubmitParams, KnowledgeSubmitDetails>;

export interface KnowledgeToolSession {
  tools: KnowledgeAgentTool[];
  candidate(): KnowledgeAnswerCandidate | null;
  exposedHits(): readonly KnowledgeSearchHit[];
}

function fail(message: string): never {
  throw new Error(message);
}

function hasUnsafeText(value: string): boolean {
  if (/\p{Cf}/u.test(value)) return true;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (
      unit <= 0x08 ||
      (unit >= 0x0b && unit <= 0x1f) ||
      (unit >= 0x7f && unit <= 0x9f) ||
      unit === 0x2028 ||
      unit === 0x2029
    ) {
      return true;
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function canonicalText(value: unknown, maximumBytes: number, field: string): string {
  if (typeof value !== 'string') fail(`${field} must be text`);
  if (
    value.length === 0 ||
    value.trim() !== value ||
    value.normalize('NFC') !== value ||
    hasUnsafeText(value) ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    fail(`${field} is invalid`);
  }
  return value;
}

function tokens(value: string): string[] {
  return value.toLocaleLowerCase('und').match(/[\p{L}\p{N}]+/gu) ?? [];
}

function excerpt(content: string): string {
  const points = Array.from(content);
  if (points.length <= EXCERPT_MAX_CODE_POINTS) return content;
  return `${points.slice(0, EXCERPT_MAX_CODE_POINTS).join('')}…`;
}

function scoreChunk(
  chunk: CreatorKnowledgeChunk,
  query: string,
  queryTokens: readonly string[],
): number {
  const normalized = chunk.content.toLocaleLowerCase('und');
  let score = normalized.includes(query.toLocaleLowerCase('und')) ? 10_000 : 0;
  for (const token of queryTokens) {
    if (normalized.includes(token)) score += 100 + Math.min(token.length, 32);
  }
  return score;
}

export function searchKnowledgeBundle(
  bundle: CreatorKnowledgeBundle,
  rawQuery: unknown,
  rawLimit: unknown = SEARCH_LIMIT_DEFAULT,
): KnowledgeSearchHit[] {
  const query = canonicalText(rawQuery, QUERY_MAX_UTF8_BYTES, 'knowledge query');
  const queryTokens = [...new Set(tokens(query))];
  if (queryTokens.length === 0) fail('knowledge query is invalid');
  if (
    !Number.isSafeInteger(rawLimit) ||
    Number(rawLimit) < 1 ||
    Number(rawLimit) > SEARCH_LIMIT_MAX
  ) {
    fail('knowledge search limit is invalid');
  }
  return bundle.chunks
    .map((chunk) => ({ chunk, score: scoreChunk(chunk, query, queryTokens) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id))
    .slice(0, Number(rawLimit))
    .map(({ chunk }) => ({
      chunkId: chunk.id,
      sourceId: chunk.source.sourceId,
      displayLabel: chunk.source.displayLabel,
      contentDigest: chunk.contentDigest,
      excerpt: excerpt(chunk.content),
    }));
}

function canonicalCitationIds(value: unknown, exposed: ReadonlySet<string>): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    fail('answered submission requires citations');
  }
  const ids = value.map((candidate) => {
    if (typeof candidate !== 'string' || !/^chunk[.]knowledge[.][0-9a-f]{32}$/u.test(candidate)) {
      fail('citation is invalid');
    }
    if (!exposed.has(candidate)) fail('citation was not exposed by this turn');
    return candidate;
  });
  for (let index = 1; index < ids.length; index += 1) {
    if (ids[index - 1]! >= ids[index]!) fail('citations must be unique and sorted');
  }
  return Object.freeze(ids);
}

/**
 * Turn-local knowledge tools. They expose bounded evidence and capture exactly one candidate;
 * neither tool writes PostgreSQL nor decides whether the user may be charged.
 */
export function createKnowledgeToolSession(input: {
  knowledge: CreatorKnowledgeBundle;
  turnSignal: AbortSignal;
}): KnowledgeToolSession {
  const exposed = new Map<string, KnowledgeSearchHit>();
  let searchPerformed = false;
  let submitted: KnowledgeAnswerCandidate | null = null;

  const search: AgentTool<typeof SearchParams, KnowledgeSearchDetails> = {
    name: 'knowledge_search',
    label: '检索知识库',
    description: '检索本 Agent 固定知识库。回答前必须先检索，只能引用本轮检索返回的 chunkId。',
    parameters: SearchParams,
    async execute(
      _toolCallId: string,
      params: SearchParamsT,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<KnowledgeSearchDetails>> {
      const operationSignal = signal
        ? AbortSignal.any([signal, input.turnSignal])
        : input.turnSignal;
      if (operationSignal.aborted) throw new DOMException('knowledge search aborted', 'AbortError');
      const query = canonicalText(params.query, QUERY_MAX_UTF8_BYTES, 'knowledge query');
      const hits = searchKnowledgeBundle(
        input.knowledge,
        query,
        params.limit ?? SEARCH_LIMIT_DEFAULT,
      );
      searchPerformed = true;
      for (const hit of hits) exposed.set(hit.chunkId, hit);
      const details = { query, hits };
      return {
        content: [{ type: 'text', text: JSON.stringify(details) }],
        details,
      };
    },
  };

  const submit: AgentTool<typeof SubmitParams, KnowledgeSubmitDetails> = {
    name: 'submit_knowledge_answer',
    label: '提交知识答案',
    description:
      '提交唯一候选终态。answered 必须给出答案和本轮检索过的升序 chunkId；证据不足时提交 insufficient_evidence。平台会独立验证。',
    parameters: SubmitParams,
    async execute(
      _toolCallId: string,
      params: SubmitParamsT,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<KnowledgeSubmitDetails>> {
      const operationSignal = signal
        ? AbortSignal.any([signal, input.turnSignal])
        : input.turnSignal;
      if (operationSignal.aborted)
        throw new DOMException('knowledge submission aborted', 'AbortError');
      if (submitted !== null) fail('knowledge answer was already submitted');
      if (!searchPerformed) fail('knowledge answer requires a prior search');

      if (params.status === 'answered') {
        const answer = canonicalText(params.answer, ANSWER_MAX_UTF8_BYTES, 'knowledge answer');
        if (answer === INSUFFICIENT_EVIDENCE_ANSWER) fail('answered submission uses reserved text');
        submitted = Object.freeze({
          status: 'answered',
          answer,
          citationChunkIds: canonicalCitationIds(params.citationChunkIds, new Set(exposed.keys())),
        });
      } else if (params.status === 'insufficient_evidence') {
        if (params.answer !== undefined || (params.citationChunkIds?.length ?? 0) !== 0) {
          fail('insufficient evidence cannot contain an answer or citations');
        }
        const next: KnowledgeAnswerCandidate = Object.freeze({
          status: 'insufficient_evidence',
          answer: INSUFFICIENT_EVIDENCE_ANSWER,
          citationChunkIds: EMPTY_CITATIONS,
        });
        submitted = next;
      } else {
        fail('knowledge answer status is invalid');
      }
      const details = { acceptedForValidation: true as const, status: submitted!.status };
      return {
        content: [{ type: 'text', text: '候选答案已提交，等待平台验证。' }],
        details,
      };
    },
  };

  return {
    tools: [search, submit],
    candidate: () => submitted,
    exposedHits: () => Object.freeze([...exposed.values()]),
  };
}

export const KNOWLEDGE_QUESTION_DIGEST_DOMAIN = 'combo.knowledge-agent-test-question/1' as const;

export type KnowledgeValidation =
  | Readonly<{
      outcome: 'answered';
      validationCode: 'accepted';
      answer: string;
      citationChunkIds: readonly string[];
    }>
  | Readonly<{
      outcome: 'insufficient_evidence';
      validationCode: 'insufficient_evidence';
      answer: typeof INSUFFICIENT_EVIDENCE_ANSWER;
      citationChunkIds: readonly [];
    }>
  | Readonly<{
      outcome: 'failed';
      validationCode: 'rejected' | 'protocol_invalid';
      answer: null;
      citationChunkIds: readonly [];
    }>;

export function knowledgeQuestionDigest(question: string): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(`${KNOWLEDGE_QUESTION_DIGEST_DOMAIN}\0`, 'utf8')
    .update(question, 'utf8')
    .digest('hex')}`;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Platform-owned controlled-Test oracle. Package instructions never configure acceptance. */
export function validateKnowledgeCandidate(input: {
  gate: KnowledgeAgentTestGate;
  question: string;
  candidate: KnowledgeAnswerCandidate | null;
  exposedHits: readonly KnowledgeSearchHit[];
}): KnowledgeValidation {
  if (input.candidate === null) {
    return Object.freeze({
      outcome: 'failed',
      validationCode: 'protocol_invalid',
      answer: null,
      citationChunkIds: EMPTY_CITATIONS,
    });
  }
  if (input.candidate.status === 'insufficient_evidence') {
    return Object.freeze({
      outcome: 'insufficient_evidence',
      validationCode: 'insufficient_evidence',
      answer: INSUFFICIENT_EVIDENCE_ANSWER,
      citationChunkIds: EMPTY_CITATIONS,
    });
  }

  const expected = input.gate.cases.find(
    (candidate) => candidate.questionDigest === knowledgeQuestionDigest(input.question),
  );
  const exposed = new Set(input.exposedHits.map((hit) => hit.chunkId));
  const citationsWereExposed = input.candidate.citationChunkIds.every((id) => exposed.has(id));
  if (
    expected === undefined ||
    input.candidate.answer !== expected.answer ||
    !arraysEqual(input.candidate.citationChunkIds, expected.citationChunkIds) ||
    !citationsWereExposed
  ) {
    return Object.freeze({
      outcome: 'failed',
      validationCode: 'rejected',
      answer: null,
      citationChunkIds: EMPTY_CITATIONS,
    });
  }
  return Object.freeze({
    outcome: 'answered',
    validationCode: 'accepted',
    answer: input.candidate.answer,
    citationChunkIds: Object.freeze([...input.candidate.citationChunkIds]),
  });
}
