import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Ajv, type AnySchema } from 'ajv';
import { describe, expect, it } from 'vitest';

import { canonicalizeJson } from '../canonical.js';
import { SnapshotPathBoundaryCorpusSchema } from '../snapshot-path-boundaries.js';
import {
  SnapshotFileSchema,
  SnapshotManifestSchema,
  SnapshotPathSchema,
  type SnapshotManifest,
} from '../snapshot.js';

const corpusUrl = new URL('../../fixtures/snapshot-path-boundaries.v1.json', import.meta.url);
const corpusFixturePath = 'snapshot-path-boundaries.v1.json';
const fixtureDirectoryUrl = new URL('../../fixtures/', import.meta.url);
const fixtureIndexUrl = new URL('../../fixtures/index.json', import.meta.url);
const contractSchemasUrl = new URL('../../schemas/contract-schemas.v1.json', import.meta.url);
const portablePathPattern =
  '^(?:[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])+$';

function sha256(bytes: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function pointerSegments(pointer: string): string[] {
  if (pointer === '') return [];
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
      throw new Error(`SNAPSHOT_PATH_BOUNDARY_POINTER_MISSING:${pointer}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || typeof current !== 'object') {
    throw new Error(`SNAPSHOT_PATH_BOUNDARY_POINTER_NOT_OBJECT:${pointer}`);
  }
  return current as Record<string, unknown>;
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

function deriveManifest(
  base: SnapshotManifest,
  path: string,
  recipe: {
    contentBytes: number;
    contentDigest: `sha256:${string}`;
    mediaType: string;
  },
): unknown {
  return {
    ...base,
    files: [
      {
        path,
        size: recipe.contentBytes,
        mediaType: recipe.mediaType,
        sha256: recipe.contentDigest.slice('sha256:'.length),
      },
    ],
    totals: { fileCount: 1, expandedBytes: recipe.contentBytes },
  };
}

function expectOnlyPathByteIssue(
  result: {
    success: boolean;
    error?: { issues: ReadonlyArray<{ code: string; path: Array<string | number> }> };
  },
  path: Array<string | number>,
): void {
  if (result.success || result.error === undefined) {
    throw new Error('SNAPSHOT_PATH_BOUNDARY_RUNTIME_ACCEPTED:N+1');
  }
  expect(result.error.issues).toHaveLength(1);
  expect(result.error.issues[0]).toEqual(expect.objectContaining({ code: 'custom', path }));
}

describe('digest-bound Snapshot path boundary', () => {
  it('pins the authority, dependencies, portable pattern and sole advertised owner', async () => {
    const corpusBytes = await readFile(corpusUrl);
    const corpus = SnapshotPathBoundaryCorpusSchema.parse(JSON.parse(corpusBytes.toString('utf8')));
    expect(corpus.authority).toEqual({
      technicalPlanSection: '技术方案 §5.2 Alpha 输入边界',
      testPlanCases: ['SCH-004', 'SNP-009'],
      pathPolicyDecisionId: 'ADR-VNEXT-004',
    });
    expect(corpus.remainingBoundaryClasses).toEqual([
      'filesystem-component-255-byte-policy-not-frozen',
    ]);

    const fixtureIndex = JSON.parse(await readFile(fixtureIndexUrl, 'utf8')) as {
      fixtures: Array<{ path: string; bytes: number; digest: string }>;
    };
    expect(fixtureIndex.fixtures.find(({ path }) => path === corpusFixturePath)).toEqual({
      path: corpusFixturePath,
      bytes: corpusBytes.byteLength,
      digest: sha256(corpusBytes),
    });
    for (const dependency of [
      corpus.checkedDependencies.utf8BoundaryCorpus,
      corpus.checkedDependencies.baseManifest,
    ]) {
      const bytes = await readFile(new URL(dependency.path, fixtureDirectoryUrl));
      expect(sha256(bytes), dependency.path).toBe(dependency.digest);
      expect(fixtureIndex.fixtures.find(({ path }) => path === dependency.path)).toEqual({
        path: dependency.path,
        bytes: bytes.byteLength,
        digest: dependency.digest,
      });
    }
    const contractBytes = await readFile(contractSchemasUrl);
    expect(sha256(contractBytes)).toBe(corpus.checkedDependencies.contractSchemas);
    const node = lookupPointer(
      JSON.parse(contractBytes.toString('utf8')) as unknown,
      corpus.boundary.contractArtifactPointer,
    );
    expect(node.maxLength).toBe(corpus.boundary.maximumUtf8Bytes);
    expect(node[corpus.boundary.jsonSchemaKeyword]).toBe(corpus.boundary.maximumUtf8Bytes);
    expect(node.pattern).toBe(portablePathPattern);
  });

  it('keeps runtime and contract pair-aware for surrogates, astral text and controls', async () => {
    const contractSchemas = JSON.parse(await readFile(contractSchemasUrl, 'utf8')) as unknown;
    const corpus = SnapshotPathBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(corpusUrl, 'utf8')),
    );
    const validateContractPath = new Ajv({
      allErrors: true,
      strict: false,
      validateFormats: false,
    }).compile(
      lookupPointer(contractSchemas, corpus.boundary.contractArtifactPointer) as AnySchema,
    );
    const cases = [
      ['high-surrogate', `safe-\ud800.txt`, false],
      ['low-surrogate', `safe-\udc00.txt`, false],
      ['valid-astral', 'safe-😀.txt', true],
      ['nul', 'safe-\u0000.txt', false],
      ['c0', 'safe-\u001f.txt', false],
      ['del', 'safe-\u007f.txt', false],
      ['c1', 'safe-\u009f.txt', false],
    ] as const;

    for (const [name, path, expected] of cases) {
      expect(SnapshotPathSchema.safeParse(path).success, `runtime:${name}`).toBe(expected);
      expect(validateContractPath(path), `contract:${name}`).toBe(expected);
    }
  });

  it('runs one exact mixed path through three runtime owners and the linked contract owner', async () => {
    const corpus = SnapshotPathBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(corpusUrl, 'utf8')),
    );
    const baseBytes = await readFile(
      new URL(corpus.checkedDependencies.baseManifest.path, fixtureDirectoryUrl),
    );
    expect(sha256(baseBytes)).toBe(corpus.checkedDependencies.baseManifest.digest);
    const baseManifest = SnapshotManifestSchema.parse(JSON.parse(baseBytes.toString('utf8')));
    const contractSchemas = JSON.parse(await readFile(contractSchemasUrl, 'utf8')) as {
      schemas: Record<string, AnySchema>;
    };
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    ajv.addKeyword({
      keyword: corpus.boundary.jsonSchemaKeyword,
      type: 'string',
      schemaType: 'number',
      errors: false,
      validate(maximumBytes: number, value: string): boolean {
        return Buffer.byteLength(value, 'utf8') <= maximumBytes;
      },
    });
    const validateContractManifest = ajv.compile(contractSchemas.schemas.SnapshotManifest!);
    let outcomes = 0;

    for (const probe of corpus.boundary.probes) {
      const path = derivePath(corpus.pathRecipe, probe.delta);
      const manifest = deriveManifest(baseManifest, path, corpus.pathRecipe);
      const file = (manifest as { files: unknown[] }).files[0];
      expect(Buffer.byteLength(path, 'utf8'), `bytes:${probe.delta}`).toBe(probe.pathUtf8Bytes);
      expect([...path].length, `codepoints:${probe.delta}`).toBe(probe.pathCodePoints);
      expect([...path].length).toBeLessThan(corpus.boundary.maximumUtf8Bytes);
      expect(sha256(Buffer.from(path, 'utf8')), `path:${probe.delta}`).toBe(probe.pathDigest);
      expect(sha256(canonicalizeJson(manifest)), `manifest:${probe.delta}`).toBe(
        probe.candidateManifestDigest,
      );

      const expected = probe.expected === 'accepted';
      const pathRuntime = SnapshotPathSchema.safeParse(path);
      const fileRuntime = SnapshotFileSchema.safeParse(file);
      const manifestRuntime = SnapshotManifestSchema.safeParse(manifest);
      const contractAccepted = validateContractManifest(manifest);
      expect(pathRuntime.success, `runtime-path:${probe.delta}`).toBe(expected);
      expect(fileRuntime.success, `runtime-file:${probe.delta}`).toBe(expected);
      expect(manifestRuntime.success, `runtime-manifest:${probe.delta}`).toBe(expected);
      expect(contractAccepted, `contract-manifest:${probe.delta}`).toBe(expected);
      outcomes += 4;

      if (!expected) {
        expectOnlyPathByteIssue(pathRuntime, runtimePathSegments(corpus.boundary.pathInstancePath));
        expectOnlyPathByteIssue(fileRuntime, runtimePathSegments(corpus.boundary.fileInstancePath));
        expectOnlyPathByteIssue(
          manifestRuntime,
          runtimePathSegments(corpus.boundary.manifestInstancePath),
        );
        expect(validateContractManifest.errors).toHaveLength(1);
        expect(validateContractManifest.errors![0]).toEqual(
          expect.objectContaining({
            instancePath: corpus.boundary.manifestInstancePath,
            keyword: corpus.boundary.jsonSchemaKeyword,
          }),
        );
      }
    }
    expect(outcomes).toBe(12);
  });
});
