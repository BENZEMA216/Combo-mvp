import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Ajv, type AnySchema } from 'ajv';
import { describe, expect, it } from 'vitest';

import { canonicalizeJson } from '../canonical.js';
import { SnapshotSingleFileBoundaryCorpusSchema } from '../snapshot-single-file-boundaries.js';
import { SnapshotFileSchema, SnapshotManifestSchema, type SnapshotManifest } from '../snapshot.js';

const corpusUrl = new URL(
  '../../fixtures/snapshot-single-file-boundaries.v1.json',
  import.meta.url,
);
const corpusFixturePath = 'snapshot-single-file-boundaries.v1.json';
const fixtureDirectoryUrl = new URL('../../fixtures/', import.meta.url);
const fixtureIndexUrl = new URL('../../fixtures/index.json', import.meta.url);
const contractSchemasUrl = new URL('../../schemas/contract-schemas.v1.json', import.meta.url);

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function bareDigest(digest: `sha256:${string}`): string {
  return digest.slice('sha256:'.length);
}

function pointerSegments(pointer: string): string[] {
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function runtimePathSegments(pointer: string): Array<string | number> {
  return pointerSegments(pointer).map((segment) =>
    /^(?:0|[1-9][0-9]*)$/u.test(segment) ? Number(segment) : segment,
  );
}

function lookupPointer(document: unknown, pointer: string): Record<string, unknown> {
  let current = document;
  for (const segment of pointerSegments(pointer)) {
    if (current === null || typeof current !== 'object' || !(segment in current)) {
      throw new Error(`SNAPSHOT_SINGLE_FILE_POINTER_MISSING:${pointer}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || typeof current !== 'object') {
    throw new Error(`SNAPSHOT_SINGLE_FILE_POINTER_NOT_OBJECT:${pointer}`);
  }
  return current as Record<string, unknown>;
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

function derivedContentDigest(sourceBlock: Buffer, fileBytes: number): `sha256:${string}` {
  const hash = createHash('sha256');
  let remaining = fileBytes;
  while (remaining > 0) {
    const bytes = Math.min(remaining, sourceBlock.byteLength);
    hash.update(sourceBlock.subarray(0, bytes));
    remaining -= bytes;
  }
  return `sha256:${hash.digest('hex')}`;
}

function deriveManifest(
  base: SnapshotManifest,
  fixture: { filePath: string; mediaType: string },
  probe: { fileBytes: number; contentDigest: `sha256:${string}` },
): unknown {
  return {
    ...base,
    files: [
      {
        path: fixture.filePath,
        size: probe.fileBytes,
        mediaType: fixture.mediaType,
        sha256: bareDigest(probe.contentDigest),
      },
    ],
    totals: { fileCount: 1, expandedBytes: probe.fileBytes },
  };
}

describe('digest-bound Snapshot single-file resource boundary', () => {
  it('pins the external authority, generator, base fixture and sole advertised owner', async () => {
    const corpusBytes = await readFile(corpusUrl);
    const corpus = SnapshotSingleFileBoundaryCorpusSchema.parse(
      JSON.parse(corpusBytes.toString('utf8')),
    );
    expect(corpus.authority).toEqual({
      technicalPlanSection: '技术方案 §5.2 Alpha 输入边界',
      testPlanCases: ['SNP-004', 'SNP-005'],
      decisionRegistryId: 'ADR-VNEXT-003',
    });
    expect(corpus.contentRecipe).toEqual({
      algorithm: 'sha256-counter-hex-block-repeat/1',
      seedUtf8: 'combo:snapshot-single-file-boundary:v1',
      counterEncoding: 'uint32be',
      digestEncoding: 'lowercase-hex',
      sourceBlockBytes: 1_048_576,
      filePath: 'boundary.txt',
      mediaType: 'text/plain; charset=utf-8',
    });

    const baseBytes = await readFile(new URL(corpus.baseFixture.path, fixtureDirectoryUrl));
    expect(sha256(baseBytes)).toBe(corpus.baseFixture.digest);
    expect(SnapshotManifestSchema.safeParse(JSON.parse(baseBytes.toString('utf8'))).success).toBe(
      true,
    );
    const fixtureIndex = JSON.parse(await readFile(fixtureIndexUrl, 'utf8')) as {
      fixtures: Array<{ path: string; bytes: number; digest: string }>;
    };
    expect(fixtureIndex.fixtures.find(({ path }) => path === corpusFixturePath)).toEqual({
      path: corpusFixturePath,
      bytes: corpusBytes.byteLength,
      digest: sha256(corpusBytes),
    });
    expect(fixtureIndex.fixtures.find(({ path }) => path === corpus.baseFixture.path)).toEqual({
      path: corpus.baseFixture.path,
      bytes: baseBytes.byteLength,
      digest: corpus.baseFixture.digest,
    });

    const contractBytes = await readFile(contractSchemasUrl);
    expect(sha256(contractBytes)).toBe(corpus.checkedArtifactDigests.contractSchemas);
    const contractSchemas = JSON.parse(contractBytes.toString('utf8')) as unknown;
    const node = lookupPointer(contractSchemas, corpus.boundary.contractArtifactPointer);
    expect(node[corpus.boundary.jsonSchemaKeyword]).toBe(corpus.boundary.maximum);
  });

  it('runs one exact N-1/N/N+1 manifest through three owners with one targeted rejection', async () => {
    const corpus = SnapshotSingleFileBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(corpusUrl, 'utf8')),
    );
    const baseBytes = await readFile(new URL(corpus.baseFixture.path, fixtureDirectoryUrl));
    expect(sha256(baseBytes)).toBe(corpus.baseFixture.digest);
    const baseManifest = SnapshotManifestSchema.parse(JSON.parse(baseBytes.toString('utf8')));
    const sourceBlock = buildSourceBlock(corpus.contentRecipe);
    const contractSchemas = JSON.parse(await readFile(contractSchemasUrl, 'utf8')) as {
      schemas: Record<string, AnySchema>;
    };
    const validateContractManifest = new Ajv({
      allErrors: true,
      strict: false,
      validateFormats: false,
    }).compile(contractSchemas.schemas.SnapshotManifest!);
    let outcomes = 0;

    for (const probe of corpus.boundary.probes) {
      expect(derivedContentDigest(sourceBlock, probe.fileBytes), `content:${probe.delta}`).toBe(
        probe.contentDigest,
      );
      const manifest = deriveManifest(baseManifest, corpus.contentRecipe, probe);
      const wireBytes = Buffer.from(canonicalizeJson(manifest), 'utf8');
      expect(sha256(wireBytes), `manifest:${probe.delta}`).toBe(probe.canonicalManifestDigest);
      const file = (manifest as { files: unknown[] }).files[0];
      const expected = probe.expected === 'accepted';

      const fileRuntime = SnapshotFileSchema.safeParse(file);
      const manifestRuntime = SnapshotManifestSchema.safeParse(manifest);
      const contractAccepted = validateContractManifest(manifest);
      expect(fileRuntime.success, `runtime-file:${probe.delta}`).toBe(expected);
      expect(manifestRuntime.success, `runtime-manifest:${probe.delta}`).toBe(expected);
      expect(contractAccepted, `contract-manifest:${probe.delta}`).toBe(expected);
      outcomes += 3;

      if (!expected) {
        if (fileRuntime.success || manifestRuntime.success) {
          throw new Error('SNAPSHOT_SINGLE_FILE_RUNTIME_ACCEPTED:N+1');
        }
        expect(fileRuntime.error.issues).toHaveLength(1);
        expect(fileRuntime.error.issues[0]).toEqual(
          expect.objectContaining({
            code: 'too_big',
            maximum: corpus.boundary.maximum,
            path: pointerSegments(corpus.boundary.fileInstancePath),
          }),
        );
        expect(manifestRuntime.error.issues).toHaveLength(1);
        expect(manifestRuntime.error.issues[0]).toEqual(
          expect.objectContaining({
            code: 'too_big',
            maximum: corpus.boundary.maximum,
            path: runtimePathSegments(corpus.boundary.manifestInstancePath),
          }),
        );
        expect(validateContractManifest.errors).toHaveLength(1);
        expect(validateContractManifest.errors![0]).toEqual(
          expect.objectContaining({
            instancePath: corpus.boundary.manifestInstancePath,
            keyword: corpus.boundary.jsonSchemaKeyword,
            params: { comparison: '<=', limit: corpus.boundary.maximum },
          }),
        );
      }
    }
    expect(outcomes).toBe(9);
  });
});
