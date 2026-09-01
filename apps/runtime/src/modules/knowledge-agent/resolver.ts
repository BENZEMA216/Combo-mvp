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
  KnowledgeTurnResultSchema,
  knowledgeBindingsEqual,
  type KnowledgeAgentBinding,
  type KnowledgeTurnResult,
} from '@cb/shared';

import type { KnowledgeAgentTestGate } from '../../platform/config/env.js';
import {
  withTransaction,
  type Queryable,
  type RuntimeDb,
  type TransactionOptions,
} from '../../platform/infra/db.js';
import {
  BoundedObjectReadError,
  type RuntimeObjectStore,
} from '../../platform/infra/object-store.js';
import type { CapabilitySummary } from '../capability/loader.js';
import { appendTurnMessage, toIso, type MessageRecord } from '../session/repo.js';
import {
  completeUsageCharge,
  findUsageChargeByTurn,
  releaseUsageCharge,
  type KnowledgeExecutionOutcome,
  type UsageChargeRecord,
} from '../billing/repo.js';
import { lockUsageId } from '../billing/repo.js';
import {
  closePendingUsageRecoveryForTerminal,
  findPendingUsageRecovery,
  readUsageIdentityByTurn,
} from '../billing/pending-recovery.js';
import {
  finishTurnCas,
  lockRunningTurn,
  lockTurnSession,
  type TerminalTurn,
  type TerminalTurnStatus,
  type TurnLastError,
} from '../agent/turn-repo.js';

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
export type KnowledgeValidationCode =
  | 'accepted'
  | 'insufficient_evidence'
  | 'not_run'
  | 'rejected'
  | 'unavailable'
  | 'protocol_invalid';
export interface KnowledgeTerminalInput {
  sessionId: string;
  turnId: string;
  /**
   * The ordinary executor supplies the resolved binding as a second assertion. Recovery paths
   * deliberately omit it and use the immutable usage reservation as their only product truth.
   */
  binding?: KnowledgeAgentBinding;
  outcome: KnowledgeExecutionOutcome;
  validationCode: KnowledgeValidationCode;
  answer: string | null;
  citationChunkIds: readonly string[];
  runtimeSourceSha: string;
  lastError?: TurnLastError | null;
}
export interface KnowledgeTerminalResult {
  won: boolean;
  turnStatus?: TerminalTurnStatus;
  response?: MessageRecord | null;
  receiptId?: string;
}
function digestText(text: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}
function terminalStatus(outcome: KnowledgeExecutionOutcome): TerminalTurnStatus {
  if (outcome === 'answered' || outcome === 'insufficient_evidence') return 'completed';
  return outcome;
}
type ResolvedKnowledgeTerminalInput = KnowledgeTerminalInput & { binding: KnowledgeAgentBinding };
function validateTerminalInput(input: KnowledgeTerminalInput): void {
  if (!/^[0-9a-f]{40}$/u.test(input.runtimeSourceSha)) {
    throw new Error('knowledge terminal Runtime identity is invalid');
  }
  if (input.binding && input.binding.productKind !== 'knowledge_agent_test') {
    throw new Error('knowledge terminal binding is invalid');
  }
  if (input.outcome === 'answered') {
    if (
      input.validationCode !== 'accepted' ||
      !input.answer ||
      input.answer === INSUFFICIENT_EVIDENCE_ANSWER ||
      input.citationChunkIds.length < 1
    ) {
      throw new Error('answered knowledge terminal is invalid');
    }
  } else if (input.outcome === 'insufficient_evidence') {
    if (
      input.validationCode !== 'insufficient_evidence' ||
      input.answer !== INSUFFICIENT_EVIDENCE_ANSWER ||
      input.citationChunkIds.length !== 0
    ) {
      throw new Error('insufficient knowledge terminal is invalid');
    }
  } else if (
    input.answer !== null ||
    input.citationChunkIds.length !== 0 ||
    (input.outcome === 'interrupted' && input.validationCode !== 'not_run') ||
    (input.outcome === 'failed' &&
      !['not_run', 'rejected', 'unavailable', 'protocol_invalid'].includes(input.validationCode))
  ) {
    throw new Error('failed knowledge terminal is invalid');
  }
  for (let index = 0; index < input.citationChunkIds.length; index += 1) {
    const current = input.citationChunkIds[index]!;
    if (
      !/^chunk[.]knowledge[.][0-9a-f]{32}$/u.test(current) ||
      (index > 0 && input.citationChunkIds[index - 1]! >= current)
    ) {
      throw new Error('knowledge terminal citations are invalid');
    }
  }
}
function bindingMatchesCharge(binding: KnowledgeAgentBinding, charge: UsageChargeRecord): boolean {
  return (
    charge.productKind === 'knowledge_agent_test' &&
    charge.knowledgeBinding !== null &&
    knowledgeBindingsEqual(charge.knowledgeBinding, binding)
  );
}
async function insertReceipt(
  db: Queryable,
  input: ResolvedKnowledgeTerminalInput,
  charge: UsageChargeRecord,
  response: MessageRecord | null,
): Promise<string> {
  if (!charge.billingPolicyVersion || !charge.validatorPolicyVersion) {
    throw new Error('knowledge usage policy snapshot is missing');
  }
  const settledCents =
    input.outcome === 'answered' && charge.chargeSource === 'wallet' ? charge.reservedCents : 0n;
  const result = await db.query<{ id: string }>(
    `INSERT INTO agent_usage_receipts
       (protocol, usage_charge_id, owner_user_id, usage_id, capability_id, session_id, turn_id,
        product_kind, capability_protocol, release_id, package_digest, release_scope,
        knowledge_resource_path, knowledge_resource_digest,
        billing_policy_version, validator_policy_version,
        unit_price_cents, free_limit_snapshot, charge_source, settled_cents,
        execution_outcome, validation_code, response_message_id, response_digest,
        citation_chunk_ids, execution_environment, runtime_release_id, runtime_source_sha)
     VALUES
       ('combo.agent-usage-receipt/1', $1, $2, $3, $4, $5, $6,
        'knowledge_agent_test', $7, $8, $9, $10, $11, $12, $13, $14,
        $15::bigint, $16, $17, $18::bigint, $19, $20, $21, $22, $23::text[],
        'test', $24, $25)
     RETURNING id`,
    [
      charge.id,
      charge.ownerUserId,
      charge.usageId,
      charge.capabilityId,
      charge.sessionId,
      charge.turnId,
      input.binding.capability.protocol,
      input.binding.release.releaseId,
      input.binding.release.packageDigest,
      input.binding.releaseScope,
      input.binding.knowledge.resourcePath,
      input.binding.knowledge.resourceDigest,
      charge.billingPolicyVersion,
      charge.validatorPolicyVersion,
      charge.unitPriceCents.toString(),
      charge.freeLimitSnapshot,
      charge.chargeSource,
      settledCents.toString(),
      input.outcome,
      input.validationCode,
      response?.id ?? null,
      response && input.answer !== null ? digestText(input.answer) : null,
      [...input.citationChunkIds],
      `release-${input.runtimeSourceSha}`,
      input.runtimeSourceSha,
    ],
  );
  const receiptId = result.rows[0]?.id;
  if (!receiptId) throw new Error('knowledge receipt insert returned no row');
  return receiptId;
}

/**
 * Commits the only authoritative knowledge terminal. The transaction follows the database lock
 * order Session -> owner/usage advisory -> pending recovery -> Turn -> usage charge -> response
 * Message and appends Redis only after return.
 */
export async function finishKnowledgeTurn(
  db: RuntimeDb,
  input: KnowledgeTerminalInput,
  options: {
    beforeFinish?: (turn: { id: string; sessionId: string }) => Promise<void>;
    transaction?: TransactionOptions;
  } = {},
): Promise<KnowledgeTerminalResult> {
  validateTerminalInput(input);
  return withTransaction(
    db,
    async (transaction) => {
      await lockTurnSession(transaction, input.sessionId);
      const usageIdentity = await readUsageIdentityByTurn(transaction, input.turnId);
      if (!usageIdentity || usageIdentity.sessionId !== input.sessionId) {
        throw new Error('knowledge usage identity is invalid');
      }
      await lockUsageId(transaction, usageIdentity.ownerUserId, usageIdentity.usageId);
      await findPendingUsageRecovery(
        transaction,
        usageIdentity.ownerUserId,
        usageIdentity.usageId,
        true,
      );
      if (!(await lockRunningTurn(transaction, input.turnId, input.sessionId))) {
        return { won: false };
      }
      const charge = await findUsageChargeByTurn(transaction, input.turnId);
      if (
        !charge ||
        charge.status !== 'reserved' ||
        charge.sessionId !== input.sessionId ||
        charge.productKind !== 'knowledge_agent_test' ||
        charge.knowledgeBinding === null ||
        (input.binding !== undefined && !bindingMatchesCharge(input.binding, charge))
      ) {
        throw new Error('knowledge usage reservation is invalid');
      }
      const resolvedInput: ResolvedKnowledgeTerminalInput = {
        ...input,
        binding: charge.knowledgeBinding,
      };
      await options.beforeFinish?.({ id: input.turnId, sessionId: input.sessionId });

      const status = terminalStatus(input.outcome);
      const won = await finishTurnCas(transaction, {
        id: input.turnId,
        status,
        lastError: input.lastError ?? null,
      });
      if (!won) return { won: false };

      let response: MessageRecord | null = null;
      if (input.answer !== null) {
        response = await appendTurnMessage(transaction, {
          sessionId: input.sessionId,
          turnId: input.turnId,
          idx: 1,
          role: 'assistant',
          content: [{ type: 'text', text: input.answer }],
          status: 'completed',
        });
      }

      if (input.outcome === 'answered') {
        await completeUsageCharge(transaction, charge, 'answered');
      } else {
        await releaseUsageCharge(transaction, charge, input.outcome);
      }
      const receiptId = await insertReceipt(transaction, resolvedInput, charge, response);
      await closePendingUsageRecoveryForTerminal(transaction, {
        ownerUserId: usageIdentity.ownerUserId,
        usageId: usageIdentity.usageId,
        turnId: input.turnId,
        outcome: input.outcome,
      });
      return { won: true, turnStatus: status, response, receiptId };
    },
    options.transaction,
  );
}

/**
 * Knowledge counterpart to the legacy stale-Turn sweeper. It never writes a candidate response;
 * every claimed Turn releases the reservation and records an immutable failed receipt.
 */
export async function sweepExpiredKnowledgeTurns(
  db: RuntimeDb,
  cutoff: Date,
  input: {
    runtimeSourceSha: string;
    beforeFinish?: (turn: { id: string; sessionId: string }) => Promise<void>;
  },
): Promise<TerminalTurn[]> {
  const candidates = await db.query<{ id: string; session_id: string }>(
    `SELECT t.id, t.session_id
       FROM turns t
       JOIN usage_charges uc ON uc.turn_id = t.id
      WHERE t.status = 'running'
        AND t.created_at < $1
        AND uc.product_kind = 'knowledge_agent_test'
      ORDER BY t.created_at, t.id`,
    [cutoff],
  );
  const swept: TerminalTurn[] = [];
  for (const candidate of candidates.rows) {
    const lastError: TurnLastError = {
      code: 'TURN_ABANDONED',
      message: '轮次运行超时，已由清扫器终止。',
    };
    const terminal = await finishKnowledgeTurn(
      db,
      {
        sessionId: candidate.session_id,
        turnId: candidate.id,
        outcome: 'failed',
        validationCode: 'unavailable',
        answer: null,
        citationChunkIds: [],
        runtimeSourceSha: input.runtimeSourceSha,
        lastError,
      },
      { beforeFinish: input.beforeFinish },
    );
    if (terminal.won) {
      swept.push({
        id: candidate.id,
        sessionId: candidate.session_id,
        status: 'failed',
        lastError,
      });
    }
  }
  return swept;
}

export interface KnowledgeReceiptDbRow {
  id: string;
  usage_id: string;
  turn_id: string;
  capability_id: string;
  capability_protocol: string;
  release_id: string;
  package_digest: string;
  release_scope: string;
  knowledge_resource_path: string;
  knowledge_resource_digest: string;
  billing_policy_version: string;
  validator_policy_version: string;
  unit_price_cents: string | number | bigint;
  free_limit_snapshot: number;
  charge_source: string;
  settled_cents: string | number | bigint;
  execution_outcome: string;
  validation_code: string;
  response_message_id: string | null;
  response_digest: string | null;
  citation_chunk_ids: string[];
  execution_environment: string;
  runtime_release_id: string;
  runtime_source_sha: string;
  created_at: string | Date;
}

export async function readKnowledgeUsageReceipts(
  db: Queryable,
  sessionId: string,
): Promise<KnowledgeReceiptDbRow[]> {
  const result = await db.query<KnowledgeReceiptDbRow>(
    `SELECT id, usage_id, turn_id, capability_id, capability_protocol,
            release_id, package_digest, release_scope,
            knowledge_resource_path, knowledge_resource_digest,
            billing_policy_version, validator_policy_version,
            unit_price_cents, free_limit_snapshot, charge_source, settled_cents,
            execution_outcome, validation_code, response_message_id, response_digest,
            citation_chunk_ids, execution_environment,
            runtime_release_id, runtime_source_sha, created_at
       FROM agent_usage_receipts
      WHERE session_id = $1
      ORDER BY created_at, id`,
    [sessionId],
  );
  return result.rows;
}

function nonNegativeCents(value: string | number | bigint): string {
  try {
    const parsed = typeof value === 'bigint' ? value : BigInt(value);
    if (parsed < 0n) throw new Error('negative');
    return parsed.toString();
  } catch {
    throw new Error('knowledge receipt amount is invalid');
  }
}

function responseText(message: MessageRecord): string {
  if (
    message.role !== 'assistant' ||
    message.status !== 'completed' ||
    message.content.length !== 1
  ) {
    throw new Error('knowledge receipt response Message is invalid');
  }
  const block = message.content[0];
  if (
    typeof block !== 'object' ||
    block === null ||
    Object.getPrototypeOf(block) !== Object.prototype ||
    Reflect.ownKeys(block).length !== 2 ||
    (block as { type?: unknown }).type !== 'text' ||
    typeof (block as { text?: unknown }).text !== 'string'
  ) {
    throw new Error('knowledge receipt response Message is invalid');
  }
  return (block as { text: string }).text;
}

function bindingFromReceipt(row: KnowledgeReceiptDbRow): KnowledgeAgentBinding {
  return KnowledgeAgentBindingSchema.parse({
    productKind: 'knowledge_agent_test',
    capability: { id: row.capability_id, protocol: row.capability_protocol },
    release: {
      protocol: 'combo.agent-package-release/1',
      releaseId: row.release_id,
      packageDigest: row.package_digest,
    },
    releaseScope: row.release_scope,
    knowledge: {
      protocol: 'combo.knowledge-bundle/1',
      resourcePath: row.knowledge_resource_path,
      resourceDigest: row.knowledge_resource_digest,
    },
  });
}

/** Re-verifies every display field from the immutable receipt, Message, and frozen Bundle bytes. */
export function projectKnowledgeResults(input: {
  binding: KnowledgeAgentBinding;
  receipts: readonly KnowledgeReceiptDbRow[];
  messages: readonly MessageRecord[];
  knowledge: CreatorKnowledgeBundle;
}): KnowledgeTurnResult[] {
  const messages = new Map(input.messages.map((message) => [message.id, message]));
  const chunks = new Map(input.knowledge.chunks.map((chunk) => [chunk.id, chunk]));
  return input.receipts.map((row) => {
    const binding = bindingFromReceipt(row);
    if (!knowledgeBindingsEqual(binding, input.binding)) {
      throw new Error('knowledge receipt binding diverged from Session');
    }
    let answer: { messageId: string; text: string; responseDigest: string } | null = null;
    if (row.response_message_id !== null) {
      const message = messages.get(row.response_message_id);
      if (!message || message.turnId !== row.turn_id) {
        throw new Error('knowledge receipt response Message is missing');
      }
      const text = responseText(message);
      const responseDigest = digestText(text);
      if (row.response_digest !== responseDigest) {
        throw new Error('knowledge receipt response digest mismatch');
      }
      answer = { messageId: message.id, text, responseDigest };
    } else if (row.response_digest !== null) {
      throw new Error('knowledge receipt response digest has no Message');
    }

    const citations = row.citation_chunk_ids.map((chunkId) => {
      const chunk = chunks.get(chunkId);
      if (!chunk) throw new Error('knowledge receipt citation is absent from the frozen Bundle');
      return {
        chunkId: chunk.id,
        sourceId: chunk.source.sourceId,
        displayLabel: chunk.source.displayLabel,
      };
    });
    return KnowledgeTurnResultSchema.parse({
      protocol: 'combo.agent-usage-receipt/1',
      receiptId: row.id,
      usageId: row.usage_id,
      turnId: row.turn_id,
      createdAt: toIso(row.created_at),
      binding,
      billing: {
        policyVersion: row.billing_policy_version,
        source: row.charge_source,
        currency: 'CNY',
        unitPriceCents: nonNegativeCents(row.unit_price_cents),
        settledCents: nonNegativeCents(row.settled_cents),
        freeLimitSnapshot: row.free_limit_snapshot,
      },
      runtime: {
        environment: row.execution_environment,
        releaseId: row.runtime_release_id,
        sourceSha: row.runtime_source_sha,
      },
      outcome: row.execution_outcome,
      validation: {
        policyVersion: row.validator_policy_version,
        code: row.validation_code,
      },
      answer,
      citations,
    });
  });
}
