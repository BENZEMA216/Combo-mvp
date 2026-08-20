import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SnapshotPathBoundaryCorpusSchema, canonicalizeJson } from '@cb/creator-agent-protocol';
import { describe, expect, it } from 'vitest';

import {
  buildSnapshotFromProject,
  canonicalizeSnapshotPath,
  isSnapshotError,
  parseSnapshotManifest,
  verifySnapshotArchive,
} from '../index.js';

const corpusUrl = new URL(
  '../../../creator-agent-protocol/fixtures/snapshot-path-boundaries.v1.json',
  import.meta.url,
);
const manifestUrl = new URL(
  '../../../creator-agent-protocol/fixtures/snapshot-manifest.v1.json',
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

function hostilePathProbes(corpus: {
  canaryPrefix: string;
  forbiddenControlRanges: readonly { id: string; start: number; end: number }[];
  loneSurrogates: readonly { id: string; codeUnit: number }[];
}): Array<{ id: string; canary: string; path: string; surrogateEscape?: string }> {
  const controls = corpus.forbiddenControlRanges.flatMap((range) =>
    Array.from({ length: range.end - range.start + 1 }, (_, offset) => {
      const codeUnit = range.start + offset;
      const id = `${range.id}-${codeUnit.toString(16).padStart(2, '0')}`;
      const canary = `${corpus.canaryPrefix}${id.toUpperCase()}_`;
      return { id, canary, path: `${canary}${String.fromCharCode(codeUnit)}.txt` };
    }),
  );
  const surrogates = corpus.loneSurrogates.map(({ id, codeUnit }) => {
    const canary = `${corpus.canaryPrefix}${id.toUpperCase()}_`;
    return {
      id,
      canary,
      path: `${canary}${String.fromCharCode(codeUnit)}.txt`,
      surrogateEscape: `\\u${codeUnit.toString(16).padStart(4, '0')}`,
    };
  });
  return [...controls, ...surrogates];
}

function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('real Snapshot path boundary', () => {
  it('SCH-005 rejects the complete strict path control/surrogate matrix without echo', async () => {
    const corpus = SnapshotPathBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(corpusUrl, 'utf8')),
    );
    const baseManifest = JSON.parse(await readFile(manifestUrl, 'utf8')) as {
      files: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };
    const safePath = String(baseManifest.files[0]!.path);
    const safeCanonical = canonicalizeJson(baseManifest);
    const probes = hostilePathProbes(corpus.hostileUnicode);
    expect(probes).toHaveLength(corpus.hostileUnicode.expectedCounts.probes);
    let outcomes = 0;

    for (const probe of probes) {
      const directError = caught(() => canonicalizeSnapshotPath(probe.path));
      expect(isSnapshotError(directError, 'SNAPSHOT_INVALID_PATH'), `direct:${probe.id}`).toBe(
        true,
      );
      expect(
        `${String(directError)} ${JSON.stringify(directError)}`,
        `direct:${probe.id}`,
      ).not.toContain(probe.canary);
      outcomes += 1;

      let hostileBytes: Buffer;
      if (probe.surrogateEscape === undefined) {
        const manifest = structuredClone(baseManifest);
        manifest.files[0] = { ...manifest.files[0]!, path: probe.path };
        hostileBytes = Buffer.from(canonicalizeJson(manifest), 'utf8');
      } else {
        const encodedPath = `${probe.canary}${probe.surrogateEscape}.txt`;
        hostileBytes = Buffer.from(
          safeCanonical.replace(JSON.stringify(safePath), `"${encodedPath}"`),
          'utf8',
        );
      }
      expect(hostileBytes.includes(Buffer.from(probe.canary, 'utf8')), `raw:${probe.id}`).toBe(
        true,
      );
      const rawError = caught(() => parseSnapshotManifest(hostileBytes));
      expect(isSnapshotError(rawError, 'SNAPSHOT_ARCHIVE_INVALID'), `raw:${probe.id}`).toBe(true);
      expect(rawError, `raw:${probe.id}`).not.toHaveProperty('cause');
      expect(rawError, `raw:${probe.id}`).not.toHaveProperty('issues');
      expect(rawError, `raw:${probe.id}`).not.toHaveProperty('input');
      expect(`${String(rawError)} ${JSON.stringify(rawError)}`, `raw:${probe.id}`).not.toContain(
        probe.canary,
      );
      outcomes += 1;
    }

    expect(outcomes).toBe(corpus.hostileUnicode.expectedCounts.outcomes / 2);
  });

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
