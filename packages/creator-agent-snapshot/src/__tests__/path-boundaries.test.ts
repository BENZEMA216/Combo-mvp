import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SnapshotPathBoundaryCorpusSchema } from '@cb/creator-agent-protocol';
import { describe, expect, it } from 'vitest';

import { buildSnapshotFromProject, isSnapshotError, verifySnapshotArchive } from '../index.js';

const corpusUrl = new URL(
  '../../../creator-agent-protocol/fixtures/snapshot-path-boundaries.v1.json',
  import.meta.url,
);

function prefixedDigest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function derivePath(
  recipe: {
    firstSegment: string;
    firstSegmentCodePoints: number;
    secondSegment: string;
    secondSegmentCodePoints: number;
    tailSegment: string;
    tailBaseCodePoints: number;
    cjkSuffix: string;
    astralSuffix: string;
    separator: string;
  },
  delta: -1 | 0 | 1,
): string {
  return [
    recipe.firstSegment.repeat(recipe.firstSegmentCodePoints),
    recipe.secondSegment.repeat(recipe.secondSegmentCodePoints),
    `${recipe.tailSegment.repeat(recipe.tailBaseCodePoints + delta)}${recipe.cjkSuffix}${recipe.astralSuffix}`,
  ].join(recipe.separator);
}

describe('real Snapshot path boundary', () => {
  it('runs SNP-009 through real mixed UTF-8 paths and build-to-verify', async () => {
    const corpus = SnapshotPathBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(corpusUrl, 'utf8')),
    );
    const content = Buffer.from(corpus.pathRecipe.contentUtf8, 'utf8');
    expect(content.byteLength).toBe(corpus.pathRecipe.contentBytes);
    expect(prefixedDigest(content)).toBe(corpus.pathRecipe.contentDigest);
    let outcomes = 0;
    let verifierCalls = 0;

    for (const probe of corpus.boundary.probes) {
      const root = await mkdtemp(join(tmpdir(), 'combo-snapshot-path-boundary-'));
      try {
        const path = derivePath(corpus.pathRecipe, probe.delta);
        expect(Buffer.byteLength(path, 'utf8'), `bytes:${probe.delta}`).toBe(probe.pathUtf8Bytes);
        expect([...path].length, `codepoints:${probe.delta}`).toBe(probe.pathCodePoints);
        expect(prefixedDigest(Buffer.from(path, 'utf8')), `path:${probe.delta}`).toBe(
          probe.pathDigest,
        );
        const segments = path.split(corpus.pathRecipe.separator);
        const sourcePath = join(root, ...segments);
        await mkdir(join(root, ...segments.slice(0, -1)), { recursive: true });
        await writeFile(sourcePath, content, { flag: 'wx', mode: 0o600 });

        if (probe.expected === 'accepted') {
          const built = await buildSnapshotFromProject(root);
          expect(prefixedDigest(built.manifestBytes), `manifest:${probe.delta}`).toBe(
            probe.candidateManifestDigest,
          );
          expect(`sha256:${built.snapshotDigest}`, `snapshot:${probe.delta}`).toBe(
            probe.snapshotDigest,
          );
          expect(`sha256:${built.archiveDigest}`, `archive:${probe.delta}`).toBe(
            probe.archiveDigest,
          );
          expect(built).toMatchObject({ fileCount: 1, expandedBytes: content.byteLength });

          verifierCalls += 1;
          const verified = verifySnapshotArchive({
            manifestBytes: built.manifestBytes,
            archiveBytes: built.archiveBytes,
            expectedSnapshotDigest: built.snapshotDigest,
            expectedArchiveDigest: built.archiveDigest,
          });
          expect(verified).toMatchObject({
            snapshotDigest: built.snapshotDigest,
            archiveDigest: built.archiveDigest,
            fileCount: 1,
            expandedBytes: content.byteLength,
          });
        } else {
          let rejection: unknown;
          try {
            await buildSnapshotFromProject(root);
          } catch (error) {
            rejection = error;
          }
          expect(isSnapshotError(rejection, 'SNAPSHOT_PATH_TOO_LONG')).toBe(true);
          expect(verifierCalls).toBe(2);
        }
        outcomes += 1;
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
    expect(outcomes).toBe(3);
    expect(verifierCalls).toBe(2);
  }, 30_000);
});
