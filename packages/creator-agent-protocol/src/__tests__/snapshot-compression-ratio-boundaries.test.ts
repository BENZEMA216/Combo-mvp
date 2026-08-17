import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { canonicalizeJson } from '../canonical.js';
import { SnapshotCompressionRatioBoundaryCorpusSchema } from '../snapshot-compression-ratio-boundaries.js';
import { SNAPSHOT_MAX_COMPRESSION_RATIO, isCompressionRatioAllowed } from '../snapshot.js';

const corpusUrl = new URL(
  '../../fixtures/snapshot-compression-ratio-boundaries.v1.json',
  import.meta.url,
);
const fixtureIndexUrl = new URL('../../fixtures/index.json', import.meta.url);
const corpusFixturePath = 'snapshot-compression-ratio-boundaries.v1.json';

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

describe('digest-bound Snapshot compression-ratio boundaries', () => {
  it('pins the authority, local generator tuple, mechanism vectors, exclusions and fixture index', async () => {
    const corpusBytes = await readFile(corpusUrl);
    const corpus = SnapshotCompressionRatioBoundaryCorpusSchema.parse(
      JSON.parse(corpusBytes.toString('utf8')),
    );
    expect(corpus.authority).toEqual({
      technicalPlanSection: '技术方案 §5.2 Alpha 输入边界',
      testPlanSection: '测试方案 §8.3 危险文件与路径',
      decisionRegistryId: 'ADR-VNEXT-003',
      additiveRegistryCaseId: 'SCH-004',
    });
    expect(corpus.evidenceClass).toBe('local-deterministic-only');
    expect(corpus.generatorRuntime).toEqual({
      observedPlatform: 'darwin-arm64',
      nodeVersion: 'v25.6.1',
      zstdVersion: '1.5.7',
      tarImplementation: 'combo-ustar-pax/1',
      zstdLevel: 9,
      zstdChecksum: true,
      zstdContentSize: true,
      zstdDictionaryId: false,
      zstdWorkers: 0,
    });
    expect(corpus.mechanism.vectors).toHaveLength(2);
    expect(corpus.exclusions).toEqual([
      'accepted-real-vector-is-not-an-exact-100-to-1-archive',
      'does-not-cover-SNP-008-real-50MiB-compressed-boundary',
      'does-not-observe-decompressor-call-count',
      'does-not-prove-T0-LINUX-CI-or-formal-E1',
      'does-not-prove-E2-MinIO-PostgreSQL-or-cloud-state',
      'generated-large-bytes-are-not-committed',
    ]);

    const fixtureIndex = JSON.parse(await readFile(fixtureIndexUrl, 'utf8')) as {
      fixtures: Array<{ path: string; bytes: number; digest: string }>;
    };
    expect(fixtureIndex.fixtures.find(({ path }) => path === corpusFixturePath)).toEqual({
      path: corpusFixturePath,
      bytes: corpusBytes.byteLength,
      digest: sha256(corpusBytes),
    });
  });

  it('runs 99/100/101 through the frozen integer decision and production helper', async () => {
    const corpus = SnapshotCompressionRatioBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(corpusUrl, 'utf8')),
    );
    expect(SNAPSHOT_MAX_COMPRESSION_RATIO).toBe(corpus.numericBoundary.maximumRatio);
    expect(corpus.numericBoundary.comparison).toBe(
      'expandedBytes <= compressedBytes * maximumRatio',
    );
    let outcomes = 0;

    for (const probe of corpus.numericBoundary.probes) {
      const input = {
        compressedBytes: probe.compressedBytes,
        expandedBytes: probe.expandedBytes,
      };
      expect(sha256(Buffer.from(canonicalizeJson(input), 'utf8')), `digest:${probe.ratio}`).toBe(
        probe.canonicalInputDigest,
      );
      const expected = probe.expected === 'accepted';
      expect(
        probe.expandedBytes <= probe.compressedBytes * corpus.numericBoundary.maximumRatio,
        `decision:${probe.ratio}`,
      ).toBe(expected);
      outcomes += 1;
      expect(
        isCompressionRatioAllowed(probe.compressedBytes, probe.expandedBytes),
        `helper:${probe.ratio}`,
      ).toBe(expected);
      outcomes += 1;
    }
    expect(outcomes).toBe(6);
  });
});
