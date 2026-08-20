import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildAgentVersion,
  buildSnapshotFromProject,
  canonicalizeJson,
  createSnapshotManifest,
  isSnapshotError,
  sha256Hex,
  type AgentVersionExecutionInput,
  type JsonValue,
} from '../index.js';

const SEED = 0x5a17c0de;
const temporaryDirectories: string[] = [];

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const output = [...values];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [output[index], output[swap]] = [output[swap]!, output[index]!];
  }
  return output;
}

function reorderObject(value: JsonValue, random: () => number): JsonValue {
  if (Array.isArray(value)) return value.map((child) => reorderObject(child, random));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      shuffled(Object.entries(value), random).map(([key, child]) => [
        key,
        reorderObject(child, random),
      ]),
    );
  }
  return value;
}

function validAgentVersionExecution(): AgentVersionExecutionInput {
  return {
    snapshotDigest: sha256Hex(Buffer.from('snapshot')),
    behaviorContract: {
      schemaVersion: 1,
      role: 'Synthetic research assistant',
      objective: 'Answer only from the sealed context',
      developerInstructions: ['Cite evidence', 'Do not invent facts'],
      language: 'zh-CN',
      evidencePolicy: 'cite-relative-path-when-used',
      answerStyle: 'conclusion-evidence-risk',
    },
    runtimePolicy: {
      schemaVersion: 1,
      isolation: 'conversation-vm-required',
      filesystem: {
        context: 'read-only-noexec',
        scratch: 'conversation-only',
        hostMounts: 'forbidden',
      },
      contextTools: ['read_context', 'list_context', 'search_context'],
      projectExecution: 'forbidden',
      network: 'model-proxy-only',
      externalTools: 'disabled',
      hostCredentials: 'forbidden',
      maxTurnSeconds: 120,
      maxConversationTurns: 20,
      maxVisibleHistoryBytes: 65_536,
      maxActiveTurns: 1,
      resolvedModel: 'pinned-model',
      reasoningEffort: 'high',
    },
    ioContract: {
      schemaVersion: 1,
      input: { type: 'text', maxUtf8Bytes: 16_384 },
      output: { type: 'text', maxUtf8Bytes: 32_768 },
      files: false,
      actions: false,
      rawReasoning: false,
    },
    codexRuntime: {
      version: '0.147.0-test-linux-arm64',
      artifactDigest: `sha256:${sha256Hex(Buffer.from('runtime'))}`,
      protocolSchemaDigest: `sha256:${sha256Hex(Buffer.from('schema'))}`,
      platform: 'linux-arm64',
    },
    modelPolicy: {
      schemaVersion: 1,
      model: 'pinned-model',
      reasoningEffort: 'high',
      creatorFunded: true,
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe(`deterministic properties (seed=${SEED})`, () => {
  it('canonical JSON is invariant under 1,000 recursive key reorders', () => {
    const random = generator(SEED);
    const value: JsonValue = {
      schemaVersion: 1,
      behavior: {
        objective: 'sealed context',
        rules: ['grounded', 'unknown-honesty', 'relative-path-evidence'],
      },
      runtime: {
        network: 'model-proxy-only',
        filesystem: { context: 'read-only-noexec', scratch: 'conversation-only' },
      },
      input: { type: 'text', maxUtf8Bytes: 16_384 },
    };
    const canonical = canonicalizeJson(value);
    for (let iteration = 0; iteration < 1_000; iteration += 1) {
      expect(canonicalizeJson(reorderObject(value, random))).toBe(canonical);
    }
  });

  it('AgentVersion digest is invariant under 500 contract key reorders', () => {
    const random = generator(SEED ^ 0x55aa);
    const input = validAgentVersionExecution();
    const base = buildAgentVersion(input);
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const candidate = buildAgentVersion({
        ...input,
        behaviorContract: reorderObject(
          input.behaviorContract as JsonValue,
          random,
        ) as AgentVersionExecutionInput['behaviorContract'],
        runtimePolicy: reorderObject(
          input.runtimePolicy as JsonValue,
          random,
        ) as AgentVersionExecutionInput['runtimePolicy'],
        ioContract: reorderObject(
          input.ioContract as JsonValue,
          random,
        ) as AgentVersionExecutionInput['ioContract'],
        codexRuntime: reorderObject(
          input.codexRuntime as JsonValue,
          random,
        ) as AgentVersionExecutionInput['codexRuntime'],
        modelPolicy: reorderObject(
          input.modelPolicy as JsonValue,
          random,
        ) as AgentVersionExecutionInput['modelPolicy'],
      });
      expect(candidate.versionDigest).toBe(base.versionDigest);
    }
  });

  it('Snapshot bytes are stable for 24 randomized creation orders and mtimes', async () => {
    const random = generator(SEED ^ 0xaa55);
    const files = Array.from({ length: 24 }, (_, index) => ({
      path: `section-${index % 4}/file-${index.toString().padStart(2, '0')}.md`,
      contents: `# File ${index}\nRandom deterministic marker ${index * 17 + 3}.\n`,
    }));
    let expectedSnapshot: string | undefined;
    let expectedArchive: string | undefined;
    for (let iteration = 0; iteration < 24; iteration += 1) {
      const root = await mkdtemp(join(tmpdir(), 'combo-property-snapshot-'));
      temporaryDirectories.push(root);
      for (const file of shuffled(files, random)) {
        const target = join(root, ...file.path.split('/'));
        await mkdir(join(target, '..'), { recursive: true });
        await writeFile(target, file.contents, 'utf8');
        const mtime = new Date(Math.floor(random() * 1_900_000_000_000));
        await utimes(target, mtime, mtime);
      }
      const built = await buildSnapshotFromProject(root);
      expectedSnapshot ??= built.snapshotDigest;
      expectedArchive ??= built.archiveDigest;
      expect(built.snapshotDigest).toBe(expectedSnapshot);
      expect(built.archiveDigest).toBe(expectedArchive);
    }
  }, 60_000);

  it('one-byte content changes yield distinct manifest identities across 512 inputs', () => {
    const digests = new Set<string>();
    for (let index = 0; index < 512; index += 1) {
      const bytes = Buffer.alloc(2);
      bytes.writeUInt16BE(index);
      const manifest = createSnapshotManifest([
        {
          path: 'fact.txt',
          size: bytes.byteLength,
          mediaType: 'text/plain; charset=utf-8',
          sha256: sha256Hex(bytes),
        },
      ]);
      digests.add(sha256Hex(Buffer.from(canonicalizeJson(manifest as never), 'utf8')));
    }
    expect(digests.size).toBe(512);
  });

  it('case collision corpus is always rejected independent of order', () => {
    const random = generator(SEED ^ 0x1234);
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const pair = shuffled(['Path/File.md', 'path/file.md'], random);
      try {
        createSnapshotManifest(
          pair.map((path) => ({
            path,
            size: 1,
            mediaType: 'text/plain; charset=utf-8',
            sha256: sha256Hex(Buffer.from('x')),
          })),
        );
        expect.fail('expected collision');
      } catch (error) {
        expect(isSnapshotError(error, 'SNAPSHOT_CASE_COLLISION')).toBe(true);
      }
    }
  });
});
