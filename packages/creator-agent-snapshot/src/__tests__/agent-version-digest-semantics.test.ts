import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  AgentVersionManifestSchema,
  canonicalSha256,
  type AgentVersionManifest,
} from '@cb/creator-agent-protocol';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildAgentVersion, type AgentVersionExecutionInput } from '../index.js';

type DigestRecord = Readonly<{
  manifestBytes: number;
  manifestSha256: string;
  behaviorContractDigest: string;
  runtimePolicyDigest: string;
  ioContractDigest: string;
  derivedCodexRuntimeDigest: string;
  modelPolicyDigest: string;
  versionDigest: string;
}>;

type Mutation = Readonly<{
  id:
    | 'snapshot-digest-one-byte'
    | 'behavior-objective-one-byte'
    | 'codex-artifact-digest-one-byte'
    | 'protocol-schema-digest-one-byte'
    | 'resolved-model-one-byte'
    | 'reasoning-effort-one-byte';
  testPlanCase: 'AVR-003' | 'AVR-004' | 'AVR-006';
  path: string;
  operation: string;
  from: string;
  to: string;
  value: string;
  expected: DigestRecord;
}>;

type Corpus = Readonly<{
  protocol: 'combo.agent-version-digest-semantics/1';
  schemaVersion: 1;
  scope: 'agent-version-canonical-identity-semantics';
  evidenceClass: 'production-builder';
  authority: Readonly<{
    testPlanCases: readonly ['AVR-001', 'AVR-003', 'AVR-004', 'AVR-006'];
    technicalPlanSection: '技术方案 §4.1 AgentVersion 组成';
    testPlanSection: '测试方案 §7.1 AgentVersion Digest';
    decisionRegistryIds: readonly ['ADR-VNEXT-002', 'ADR-VNEXT-027', 'ADR-VNEXT-029'];
  }>;
  baseFixture: Readonly<{ path: string; bytes: number; sha256: string }>;
  materializations: ReadonlyArray<
    Readonly<{ id: string; derivation: string; bytes: number; sha256: string }>
  >;
  baseExpected: DigestRecord;
  mutations: readonly Mutation[];
}>;

const corpusUrl = new URL(
  '../../../creator-agent-protocol/fixtures/agent-version-digest-semantics.v1.json',
  import.meta.url,
);
const fixtureDirectoryUrl = new URL('../../../creator-agent-protocol/fixtures/', import.meta.url);
const fixtureIndexUrl = new URL(
  '../../../creator-agent-protocol/fixtures/index.json',
  import.meta.url,
);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

let corpus: Corpus;
let corpusBytes: Buffer;
let baseBytes: Buffer;
let baseManifest: AgentVersionManifest;

function executionInput(manifest: AgentVersionManifest): AgentVersionExecutionInput {
  const { protocol: _protocol, schemaVersion: _schemaVersion, ...input } = manifest;
  return input;
}

function digestRecord(manifest: AgentVersionManifest): {
  record: DigestRecord;
  manifestBytes: Buffer;
} {
  const built = buildAgentVersion(executionInput(manifest));
  return {
    record: {
      manifestBytes: built.manifestBytes.byteLength,
      manifestSha256: sha256(built.manifestBytes),
      behaviorContractDigest: built.behaviorContractDigest,
      runtimePolicyDigest: built.runtimePolicyDigest,
      ioContractDigest: built.ioContractDigest,
      derivedCodexRuntimeDigest: canonicalSha256(built.manifest.codexRuntime),
      modelPolicyDigest: built.modelPolicyDigest,
      versionDigest: built.versionDigest,
    },
    manifestBytes: built.manifestBytes,
  };
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, nested]) => [key, reverseObjectKeys(nested)]),
  );
}

function materialize(id: string): Buffer {
  const parsed = JSON.parse(baseBytes.toString('utf8')) as unknown;
  switch (id) {
    case 'fixture-pretty':
      return baseBytes;
    case 'compact':
      return Buffer.from(JSON.stringify(parsed), 'utf8');
    case 'recursive-reverse-pretty':
      return Buffer.from(`${JSON.stringify(reverseObjectKeys(parsed), null, 2)}\n`, 'utf8');
    default:
      throw new Error(`UNKNOWN_AVR_MATERIALIZATION_${id}`);
  }
}

function mutateBase(mutation: Mutation): AgentVersionManifest {
  const candidate = structuredClone(baseManifest);
  switch (mutation.id) {
    case 'snapshot-digest-one-byte':
      expect(candidate.snapshotDigest.endsWith(mutation.from)).toBe(true);
      candidate.snapshotDigest = mutation.value;
      break;
    case 'behavior-objective-one-byte':
      expect(candidate.behaviorContract.objective).toBe(mutation.from);
      candidate.behaviorContract.objective = mutation.to;
      break;
    case 'codex-artifact-digest-one-byte':
      expect(candidate.codexRuntime.artifactDigest.endsWith(mutation.from)).toBe(true);
      candidate.codexRuntime.artifactDigest = mutation.value as `sha256:${string}`;
      break;
    case 'protocol-schema-digest-one-byte':
      expect(candidate.codexRuntime.protocolSchemaDigest.endsWith(mutation.from)).toBe(true);
      candidate.codexRuntime.protocolSchemaDigest = mutation.value as `sha256:${string}`;
      break;
    case 'resolved-model-one-byte':
      expect(candidate.runtimePolicy.resolvedModel).toBe(mutation.from);
      expect(candidate.modelPolicy.model).toBe(mutation.from);
      candidate.runtimePolicy.resolvedModel = mutation.to;
      candidate.modelPolicy.model = mutation.to;
      break;
    case 'reasoning-effort-one-byte':
      expect(candidate.runtimePolicy.reasoningEffort).toBe(mutation.from);
      expect(candidate.modelPolicy.reasoningEffort).toBe(mutation.from);
      candidate.runtimePolicy.reasoningEffort = 'xhigh';
      candidate.modelPolicy.reasoningEffort = 'xhigh';
      break;
  }
  return AgentVersionManifestSchema.parse(candidate);
}

beforeAll(async () => {
  corpusBytes = await readFile(corpusUrl);
  corpus = JSON.parse(corpusBytes.toString('utf8')) as Corpus;
  baseBytes = await readFile(new URL(corpus.baseFixture.path, fixtureDirectoryUrl));
  baseManifest = AgentVersionManifestSchema.parse(JSON.parse(baseBytes.toString('utf8')));
});

describe('AVR-001 / AVR-003 / AVR-004 / AVR-006 AgentVersion digest semantics', () => {
  it('binds the strict compact corpus, dependency, and fixture index', async () => {
    expect(Object.keys(corpus).sort()).toEqual([
      'authority',
      'baseExpected',
      'baseFixture',
      'evidenceClass',
      'materializations',
      'mutations',
      'protocol',
      'schemaVersion',
      'scope',
    ]);
    expect(corpus).toMatchObject({
      protocol: 'combo.agent-version-digest-semantics/1',
      schemaVersion: 1,
      scope: 'agent-version-canonical-identity-semantics',
      evidenceClass: 'production-builder',
      authority: {
        testPlanCases: ['AVR-001', 'AVR-003', 'AVR-004', 'AVR-006'],
        technicalPlanSection: '技术方案 §4.1 AgentVersion 组成',
        testPlanSection: '测试方案 §7.1 AgentVersion Digest',
        decisionRegistryIds: ['ADR-VNEXT-002', 'ADR-VNEXT-027', 'ADR-VNEXT-029'],
      },
    });
    expect(baseBytes.byteLength).toBe(corpus.baseFixture.bytes);
    expect(sha256(baseBytes)).toBe(corpus.baseFixture.sha256);
    expect(digestRecord(baseManifest).record).toEqual(corpus.baseExpected);
    for (const materialization of corpus.materializations) {
      expect(Object.keys(materialization).sort(), materialization.id).toEqual([
        'bytes',
        'derivation',
        'id',
        'sha256',
      ]);
    }
    for (const mutation of corpus.mutations) {
      expect(Object.keys(mutation).sort(), mutation.id).toEqual([
        'expected',
        'from',
        'id',
        'operation',
        'path',
        'testPlanCase',
        'to',
        'value',
      ]);
      expect(Object.keys(mutation.expected).sort(), mutation.id).toEqual([
        'behaviorContractDigest',
        'derivedCodexRuntimeDigest',
        'ioContractDigest',
        'manifestBytes',
        'manifestSha256',
        'modelPolicyDigest',
        'runtimePolicyDigest',
        'versionDigest',
      ]);
      expect(mutation.path.startsWith('/'), mutation.id).toBe(true);
      expect(mutation.operation.length, mutation.id).toBeGreaterThan(0);
      if (mutation.operation === 'replace-last-ascii-byte') {
        expect(mutation.value.endsWith(mutation.to), mutation.id).toBe(true);
      } else {
        expect(mutation.value, mutation.id).toBe(mutation.to);
      }
    }

    const index = JSON.parse(await readFile(fixtureIndexUrl, 'utf8')) as {
      fixtures: Array<{ path: string; bytes: number; digest: string }>;
    };
    expect(
      index.fixtures.find(({ path }) => path === 'agent-version-digest-semantics.v1.json'),
    ).toEqual({
      path: 'agent-version-digest-semantics.v1.json',
      bytes: corpusBytes.byteLength,
      digest: `sha256:${sha256(corpusBytes)}`,
    });
  });

  it('AVR-001 and AVR-004 normalize recursive key order and whitespace before identity', () => {
    const canonical = digestRecord(baseManifest).manifestBytes;
    const rawDigests = new Set<string>();
    for (const materialization of corpus.materializations) {
      const raw = materialize(materialization.id);
      expect(raw.byteLength, materialization.id).toBe(materialization.bytes);
      expect(sha256(raw), materialization.id).toBe(materialization.sha256);
      rawDigests.add(materialization.sha256);
      const parsed = AgentVersionManifestSchema.parse(JSON.parse(raw.toString('utf8')));
      const built = digestRecord(parsed);
      expect(built.record, materialization.id).toEqual(corpus.baseExpected);
      expect(built.manifestBytes.equals(canonical), materialization.id).toBe(true);
    }
    expect(rawDigests.size).toBe(corpus.materializations.length);
  });

  it('AVR-003 / AVR-004 / AVR-006 bind every semantic mutation to exact component digests', () => {
    expect(corpus.mutations.map(({ id }) => id)).toEqual([
      'snapshot-digest-one-byte',
      'behavior-objective-one-byte',
      'codex-artifact-digest-one-byte',
      'protocol-schema-digest-one-byte',
      'resolved-model-one-byte',
      'reasoning-effort-one-byte',
    ]);
    expect(
      corpus.mutations.map(
        ({ id, testPlanCase, path, operation, from, to }) =>
          [id, testPlanCase, path, operation, from, to] as const,
      ),
    ).toEqual([
      [
        'snapshot-digest-one-byte',
        'AVR-003',
        '/snapshotDigest',
        'replace-last-ascii-byte',
        'a',
        'd',
      ],
      [
        'behavior-objective-one-byte',
        'AVR-004',
        '/behaviorContract/objective',
        'append-one-ascii-byte',
        '只根据已发布资料回答受邀消费者的问题',
        '只根据已发布资料回答受邀消费者的问题!',
      ],
      [
        'codex-artifact-digest-one-byte',
        'AVR-006',
        '/codexRuntime/artifactDigest',
        'replace-last-ascii-byte',
        'b',
        'd',
      ],
      [
        'protocol-schema-digest-one-byte',
        'AVR-006',
        '/codexRuntime/protocolSchemaDigest',
        'replace-last-ascii-byte',
        'c',
        'e',
      ],
      [
        'resolved-model-one-byte',
        'AVR-006',
        '/runtimePolicy/resolvedModel+/modelPolicy/model',
        'replace-one-ascii-byte-in-both-bound-fields',
        'gpt-5.6',
        'gpt-5.7',
      ],
      [
        'reasoning-effort-one-byte',
        'AVR-006',
        '/runtimePolicy/reasoningEffort+/modelPolicy/reasoningEffort',
        'insert-one-ascii-byte-in-both-bound-fields',
        'high',
        'xhigh',
      ],
    ]);
    for (const mutation of corpus.mutations) {
      const mutated = mutateBase(mutation);
      const actual = digestRecord(mutated).record;
      expect(actual, mutation.id).toEqual(mutation.expected);
      expect(actual.versionDigest, mutation.id).not.toBe(corpus.baseExpected.versionDigest);

      if (mutation.testPlanCase === 'AVR-003') {
        expect(actual).toMatchObject({
          behaviorContractDigest: corpus.baseExpected.behaviorContractDigest,
          runtimePolicyDigest: corpus.baseExpected.runtimePolicyDigest,
          ioContractDigest: corpus.baseExpected.ioContractDigest,
          derivedCodexRuntimeDigest: corpus.baseExpected.derivedCodexRuntimeDigest,
          modelPolicyDigest: corpus.baseExpected.modelPolicyDigest,
        });
      } else if (mutation.testPlanCase === 'AVR-004') {
        expect(actual.behaviorContractDigest).not.toBe(corpus.baseExpected.behaviorContractDigest);
        expect(actual).toMatchObject({
          runtimePolicyDigest: corpus.baseExpected.runtimePolicyDigest,
          ioContractDigest: corpus.baseExpected.ioContractDigest,
          derivedCodexRuntimeDigest: corpus.baseExpected.derivedCodexRuntimeDigest,
          modelPolicyDigest: corpus.baseExpected.modelPolicyDigest,
        });
      } else if (mutation.id.startsWith('codex-') || mutation.id.startsWith('protocol-')) {
        expect(actual.derivedCodexRuntimeDigest).not.toBe(
          corpus.baseExpected.derivedCodexRuntimeDigest,
        );
        expect(actual).toMatchObject({
          behaviorContractDigest: corpus.baseExpected.behaviorContractDigest,
          runtimePolicyDigest: corpus.baseExpected.runtimePolicyDigest,
          ioContractDigest: corpus.baseExpected.ioContractDigest,
          modelPolicyDigest: corpus.baseExpected.modelPolicyDigest,
        });
      } else {
        expect(actual.runtimePolicyDigest).not.toBe(corpus.baseExpected.runtimePolicyDigest);
        expect(actual.modelPolicyDigest).not.toBe(corpus.baseExpected.modelPolicyDigest);
        expect(actual).toMatchObject({
          behaviorContractDigest: corpus.baseExpected.behaviorContractDigest,
          ioContractDigest: corpus.baseExpected.ioContractDigest,
          derivedCodexRuntimeDigest: corpus.baseExpected.derivedCodexRuntimeDigest,
        });
      }
    }
  });
});
