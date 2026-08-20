import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { SnapshotCompressionRatioBoundaryCorpusSchema } from '@cb/creator-agent-protocol';
import { describe, expect, it } from 'vitest';

import { isSnapshotError } from '../errors.js';
import { createSnapshotManifest, snapshotDigest, snapshotManifestBytes } from '../manifest.js';
import { ALPHA_SNAPSHOT_POLICY } from '../policy.js';
import { verifySnapshotArchive } from '../snapshot.js';
import {
  assertCompressedArchiveLimits,
  compressDeterministicTar,
  createDeterministicTar,
  decompressAndParseDeterministicArchive,
} from '../tar.js';

const corpusUrl = new URL(
  '../../../creator-agent-protocol/fixtures/snapshot-compression-ratio-boundaries.v1.json',
  import.meta.url,
);

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function buildCounterHex(recipe: { seedUtf8: string; contentBytes: number }): Buffer {
  const output = Buffer.alloc(recipe.contentBytes);
  const seed = Buffer.from(recipe.seedUtf8, 'utf8');
  for (let offset = 0, counter = 0; offset < output.byteLength; offset += 64, counter += 1) {
    const counterBytes = Buffer.alloc(4);
    counterBytes.writeUInt32BE(counter);
    const block = createHash('sha256').update(seed).update(counterBytes).digest('hex');
    output.write(block, offset, Math.min(64, output.byteLength - offset), 'ascii');
  }
  return output;
}

function caught(action: () => unknown): unknown {
  try {
    action();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('real deterministic Snapshot compression-ratio boundaries', () => {
  it('runs the numeric probes through the production Snapshot assertion', async () => {
    const corpus = SnapshotCompressionRatioBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(corpusUrl, 'utf8')),
    );

    for (const probe of corpus.numericBoundary.probes) {
      const error = caught(() =>
        assertCompressedArchiveLimits(probe.compressedBytes, probe.expandedBytes),
      );
      if (probe.expected === 'accepted') {
        expect(error, `ratio:${probe.ratio}`).toBeUndefined();
      } else {
        expect(
          isSnapshotError(error, 'SNAPSHOT_COMPRESSION_RATIO_EXCEEDED'),
          `ratio:${probe.ratio}`,
        ).toBe(true);
      }
    }
  });

  it('rejects invalid expanded values with stable errors before applying the ratio', () => {
    expect(
      isSnapshotError(
        caught(() => assertCompressedArchiveLimits(1, -1)),
        'SNAPSHOT_ARCHIVE_INVALID',
      ),
    ).toBe(true);
    expect(
      isSnapshotError(
        caught(() => assertCompressedArchiveLimits(1, 0.5)),
        'SNAPSHOT_ARCHIVE_INVALID',
      ),
    ).toBe(true);
    expect(
      isSnapshotError(
        caught(() => assertCompressedArchiveLimits(1, ALPHA_SNAPSHOT_POLICY.maxExpandedBytes + 1)),
        'SNAPSHOT_EXPANDED_TOO_LARGE',
      ),
    ).toBe(true);
    expect(() => assertCompressedArchiveLimits(1, 0)).not.toThrow();
  });

  it('fully verifies the accepted vector and rejects a canonical bomb before any VERIFIED result', async () => {
    const corpus = SnapshotCompressionRatioBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(corpusUrl, 'utf8')),
    );
    const acceptedContent = buildCounterHex(corpus.mechanism.acceptedRecipe);
    const bombContent = Buffer.alloc(
      corpus.mechanism.bombRecipe.contentBytes,
      Number.parseInt(corpus.mechanism.bombRecipe.byteHex, 16),
    );
    let outcomes = 0;

    for (const [vector, content] of [
      [corpus.mechanism.vectors[0], acceptedContent],
      [corpus.mechanism.vectors[1], bombContent],
    ] as const) {
      expect(content.byteLength, `content-bytes:${vector.id}`).toBe(vector.contentBytes);
      expect(sha256(content), `content-digest:${vector.id}`).toBe(vector.digests.content);
      const manifest = createSnapshotManifest([
        {
          path: vector.filePath,
          size: content.byteLength,
          mediaType: corpus.mechanism.mediaType,
          sha256: sha256(content).slice('sha256:'.length),
        },
      ]);
      const manifestBytes = snapshotManifestBytes(manifest);
      const tarBytes = createDeterministicTar([{ path: vector.filePath, bytes: content }]);
      const archiveBytes = compressDeterministicTar(tarBytes);

      expect(manifestBytes.byteLength, `manifest-bytes:${vector.id}`).toBe(vector.manifestBytes);
      expect(sha256(manifestBytes), `manifest-digest:${vector.id}`).toBe(vector.digests.manifest);
      expect(`sha256:${snapshotDigest(manifest)}`, `snapshot-digest:${vector.id}`).toBe(
        vector.digests.snapshot,
      );
      expect(tarBytes.byteLength, `tar-bytes:${vector.id}`).toBe(vector.tarBytes);
      expect(sha256(tarBytes), `tar-digest:${vector.id}`).toBe(vector.digests.tar);
      expect(archiveBytes.byteLength, `archive-bytes:${vector.id}`).toBe(vector.archiveBytes);
      expect(sha256(archiveBytes), `archive-digest:${vector.id}`).toBe(vector.digests.archive);
      expect(content.byteLength, `ratio-numerator:${vector.id}`).toBe(vector.ratioNumerator);
      expect(archiveBytes.byteLength, `ratio-denominator:${vector.id}`).toBe(
        vector.ratioDenominator,
      );
      expect(String(content.byteLength / archiveBytes.byteLength), `ratio:${vector.id}`).toBe(
        vector.ratioDecimal,
      );

      const parsedFiles = decompressAndParseDeterministicArchive(archiveBytes);
      const canonicalArchive = compressDeterministicTar(
        createDeterministicTar(parsedFiles.map(({ path, bytes }) => ({ path, bytes }))),
      );
      expect(canonicalArchive.equals(archiveBytes), `canonical:${vector.id}`).toBe(
        vector.canonicalArchiveRoundTrip,
      );

      const verify = () =>
        verifySnapshotArchive({
          manifestBytes,
          archiveBytes,
          expectedSnapshotDigest: snapshotDigest(manifest),
          expectedArchiveDigest: sha256(archiveBytes).slice('sha256:'.length),
        });
      if (vector.expected === 'accepted') {
        expect(verify()).toMatchObject({
          fileCount: 1,
          expandedBytes: content.byteLength,
          compressedBytes: archiveBytes.byteLength,
        });
      } else {
        expect(isSnapshotError(caught(verify), vector.expectedError)).toBe(true);
      }
      outcomes += 1;
    }
    expect(outcomes).toBe(2);
  }, 10_000);
});
