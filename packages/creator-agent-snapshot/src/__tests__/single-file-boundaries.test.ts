import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SnapshotSingleFileBoundaryCorpusSchema } from '@cb/creator-agent-protocol';
import { describe, expect, it } from 'vitest';

import { buildSnapshotFromProject, isSnapshotError, verifySnapshotArchive } from '../index.js';

const corpusUrl = new URL(
  '../../../creator-agent-protocol/fixtures/snapshot-single-file-boundaries.v1.json',
  import.meta.url,
);

function prefixedDigest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function buildSourceBlock(recipe: { seedUtf8: string; sourceBlockBytes: number }): Buffer {
  const output = Buffer.alloc(recipe.sourceBlockBytes);
  const seed = Buffer.from(recipe.seedUtf8, 'utf8');
  for (let offset = 0, counter = 0; offset < output.byteLength; offset += 64, counter += 1) {
    const counterBytes = Buffer.alloc(4);
    counterBytes.writeUInt32BE(counter);
    const hex = createHash('sha256').update(seed).update(counterBytes).digest('hex');
    output.write(hex, offset, 64, 'ascii');
  }
  return output;
}

async function writeNonSparseFixture(
  path: string,
  sourceBlock: Buffer,
  fileBytes: number,
): Promise<`sha256:${string}`> {
  const handle = await open(path, 'wx', 0o600);
  const hash = createHash('sha256');
  let remaining = fileBytes;
  try {
    while (remaining > 0) {
      const bytes = Math.min(remaining, sourceBlock.byteLength);
      let offset = 0;
      while (offset < bytes) {
        const result = await handle.write(sourceBlock, offset, bytes - offset, null);
        if (result.bytesWritten <= 0) throw new Error('SNAPSHOT_FIXTURE_SHORT_WRITE');
        offset += result.bytesWritten;
      }
      hash.update(sourceBlock.subarray(0, bytes));
      remaining -= bytes;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  const info = await stat(path, { bigint: true });
  expect(info.size).toBe(BigInt(fileBytes));
  expect(info.blocks * 512n).toBeGreaterThanOrEqual(info.size);
  return `sha256:${hash.digest('hex')}`;
}

describe('real Snapshot single-file boundary', () => {
  it('runs SNP-004 / SNP-005 through real non-sparse files and build-to-verify', async () => {
    const corpusBytes = await readFile(corpusUrl);
    const corpus = SnapshotSingleFileBoundaryCorpusSchema.parse(
      JSON.parse(corpusBytes.toString('utf8')),
    );
    const sourceBlock = buildSourceBlock(corpus.contentRecipe);
    let outcomes = 0;

    for (const probe of corpus.boundary.probes) {
      const root = await mkdtemp(join(tmpdir(), 'combo-snapshot-single-file-'));
      try {
        const sourcePath = join(root, corpus.contentRecipe.filePath);
        expect(
          await writeNonSparseFixture(sourcePath, sourceBlock, probe.fileBytes),
          `content:${probe.delta}`,
        ).toBe(probe.contentDigest);

        if (probe.expected === 'accepted') {
          const built = await buildSnapshotFromProject(root);
          expect(prefixedDigest(built.manifestBytes), `manifest:${probe.delta}`).toBe(
            probe.canonicalManifestDigest,
          );
          expect(`sha256:${built.snapshotDigest}`, `snapshot:${probe.delta}`).toBe(
            probe.snapshotDigest,
          );
          expect(`sha256:${built.archiveDigest}`, `archive:${probe.delta}`).toBe(
            probe.archiveDigest,
          );
          expect(built).toMatchObject({ fileCount: 1, expandedBytes: probe.fileBytes });

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
            expandedBytes: probe.fileBytes,
          });
        } else {
          let rejection: unknown;
          try {
            await buildSnapshotFromProject(root);
          } catch (error) {
            rejection = error;
          }
          expect(isSnapshotError(rejection, 'SNAPSHOT_FILE_TOO_LARGE')).toBe(true);
        }
        outcomes += 1;
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
    expect(outcomes).toBe(3);
  }, 30_000);
});
