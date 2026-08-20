import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  SnapshotManifestSchema,
  SnapshotResourceBoundaryCorpusSchema,
  canonicalizeJson,
  type SnapshotManifest,
} from '@cb/creator-agent-protocol';
import { describe, expect, it } from 'vitest';

import { isSnapshotError, parseSnapshotManifest } from '../index.js';

const corpusUrl = new URL(
  '../../../creator-agent-protocol/fixtures/snapshot-resource-boundaries.v1.json',
  import.meta.url,
);
const fixtureDirectoryUrl = new URL('../../../creator-agent-protocol/fixtures/', import.meta.url);
const ONE_MIB = 1024 * 1024;

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function buildBoundaryManifest(
  base: SnapshotManifest,
  boundaryId: 'snapshot-manifest-file-count' | 'snapshot-manifest-expanded-bytes',
  maximum: number,
  delta: -1 | 0 | 1,
): unknown {
  const seed = base.files[0]!;
  const file = (path: string, size: number) => ({ ...seed, path, size });
  if (boundaryId === 'snapshot-manifest-file-count') {
    const fileCount = maximum + delta;
    const files = Array.from({ length: fileCount }, (_, index) =>
      file(`files/${index.toString().padStart(4, '0')}.txt`, 1),
    );
    return { ...base, files, totals: { fileCount, expandedBytes: fileCount } };
  }

  const expandedBytes = maximum + delta;
  const fullChunks = Math.floor(expandedBytes / ONE_MIB);
  const remainder = expandedBytes % ONE_MIB;
  const files = Array.from({ length: fullChunks }, (_, index) =>
    file(`expanded/${index.toString().padStart(3, '0')}.txt`, ONE_MIB),
  );
  if (remainder > 0) files.push(file('expanded/zzz-tail.txt', remainder));
  return { ...base, files, totals: { fileCount: files.length, expandedBytes } };
}

describe('production Snapshot manifest resource parser', () => {
  it('runs the same two digest-bound N-1/N/N+1 variants for six parser outcomes', async () => {
    const corpus = SnapshotResourceBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(corpusUrl, 'utf8')),
    );
    const baseBytes = await readFile(new URL(corpus.baseFixture.path, fixtureDirectoryUrl));
    expect(sha256(baseBytes)).toBe(corpus.baseFixture.digest);
    const baseManifest = SnapshotManifestSchema.parse(JSON.parse(baseBytes.toString('utf8')));
    let outcomes = 0;

    for (const boundary of corpus.cases) {
      for (const delta of [-1, 0, 1] as const) {
        const manifest = buildBoundaryManifest(baseManifest, boundary.id, boundary.maximum, delta);
        const parsedManifest = manifest as { totals: { fileCount: number; expandedBytes: number } };
        const probe = boundary.probes.find(({ delta: probeDelta }) => probeDelta === delta);
        if (!probe) {
          throw new Error(`SNAPSHOT_RESOURCE_BOUNDARY_PROBE_MISSING:${boundary.id}:${delta}`);
        }
        const wireBytes = Buffer.from(canonicalizeJson(manifest), 'utf8');
        expect(sha256(wireBytes), `canonical-digest:${boundary.id}:${delta}`).toBe(
          probe.canonicalDigest,
        );
        expect(parsedManifest.totals, `canonical-totals:${boundary.id}:${delta}`).toEqual({
          fileCount: probe.fileCount,
          expandedBytes: probe.expandedBytes,
        });
        const expected = delta <= 0;
        let accepted = false;
        let rejection: unknown;
        try {
          parseSnapshotManifest(wireBytes);
          accepted = true;
        } catch (error) {
          rejection = error;
        }
        expect(accepted, `${boundary.id}:${delta}`).toBe(expected);
        if (!expected) {
          expect(isSnapshotError(rejection, 'SNAPSHOT_ARCHIVE_INVALID')).toBe(true);
        }
        outcomes += 1;
      }
    }
    expect(outcomes).toBe(6);
  });
});
