import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Ajv, type AnySchema } from 'ajv';
import { describe, expect, it } from 'vitest';

import { canonicalizeJson } from '../canonical.js';
import { SnapshotUploadCreateRequestSchema } from '../http.js';
import { SnapshotResourceBoundaryCorpusSchema } from '../snapshot-resource-boundaries.js';
import {
  SnapshotArchiveEnvelopeSchema,
  SnapshotManifestEnvelopeSchema,
  SnapshotManifestSchema,
  snapshotManifestEnvelopeAadDigest,
  snapshotManifestObjectKey,
  type SnapshotManifest,
} from '../snapshot.js';

const corpusUrl = new URL('../../fixtures/snapshot-resource-boundaries.v1.json', import.meta.url);
const corpusFixturePath = 'snapshot-resource-boundaries.v1.json';
const fixtureDirectoryUrl = new URL('../../fixtures/', import.meta.url);
const fixtureIndexUrl = new URL('../../fixtures/index.json', import.meta.url);
const artifactUrls = {
  contractSchemas: new URL('../../schemas/contract-schemas.v1.json', import.meta.url),
  openApi: new URL('../../openapi/creator-agent-v1.openapi.json', import.meta.url),
} as const;
const ONE_MIB = 1024 * 1024;

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function pointerSegments(pointer: string): string[] {
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function lookupPointer(document: unknown, pointer: string): Record<string, unknown> {
  let current = document;
  for (const segment of pointerSegments(pointer)) {
    if (current === null || typeof current !== 'object' || !(segment in current)) {
      throw new Error(`SNAPSHOT_RESOURCE_BOUNDARY_POINTER_MISSING:${pointer}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || typeof current !== 'object') {
    throw new Error(`SNAPSHOT_RESOURCE_BOUNDARY_POINTER_NOT_OBJECT:${pointer}`);
  }
  return current as Record<string, unknown>;
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

async function createValidUploadRequestBase() {
  const archive = SnapshotArchiveEnvelopeSchema.parse(
    JSON.parse(await readFile(new URL('snapshot-envelope.v1.json', fixtureDirectoryUrl), 'utf8')),
  );
  const manifestFixture = SnapshotManifestEnvelopeSchema.parse(
    JSON.parse(
      await readFile(new URL('snapshot-manifest-envelope.v1.json', fixtureDirectoryUrl), 'utf8'),
    ),
  );
  const manifestAad = {
    ...manifestFixture.aad,
    creatorId: archive.aad.creatorId,
    snapshotDigest: archive.aad.snapshotDigest,
    objectKey: snapshotManifestObjectKey(archive.aad.creatorId, archive.aad.snapshotDigest),
    keyId: archive.aad.keyId,
  };
  const manifest = SnapshotManifestEnvelopeSchema.parse({
    ...manifestFixture,
    aad: manifestAad,
    aadDigest: snapshotManifestEnvelopeAadDigest(manifestAad),
    wrappedDek: archive.wrappedDek,
  });
  return SnapshotUploadCreateRequestSchema.parse({
    archive: {
      envelope: archive,
      checksumSha256: Buffer.from(archive.cipherDigest, 'hex').toString('base64'),
    },
    manifest: {
      envelope: manifest,
      checksumSha256: Buffer.from(manifest.cipherDigest, 'hex').toString('base64'),
    },
    expandedBytes: 1,
    fileCount: 1,
  });
}

describe('digest-bound Snapshot manifest resource boundaries', () => {
  it('pins the external authority, real base fixture and seven advertised keyword paths', async () => {
    const corpusBytes = await readFile(corpusUrl);
    const corpus = SnapshotResourceBoundaryCorpusSchema.parse(
      JSON.parse(corpusBytes.toString('utf8')),
    );
    expect(corpus.authority).toEqual({
      technicalPlanSection: '技术方案 §5.2 Alpha 输入边界',
      testPlanCases: ['SNP-002', 'SNP-003', 'SNP-006', 'SNP-007'],
    });
    expect(corpus.cases.map(({ id }) => id)).toEqual([
      'snapshot-manifest-file-count',
      'snapshot-manifest-expanded-bytes',
    ]);

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

    const documents = {
      contractSchemas: JSON.parse(await readFile(artifactUrls.contractSchemas, 'utf8')) as unknown,
      openApi: JSON.parse(await readFile(artifactUrls.openApi, 'utf8')) as unknown,
    };
    expect(corpus.checkedArtifactDigests).toEqual({
      contractSchemas: sha256(await readFile(artifactUrls.contractSchemas)),
      openApi: sha256(await readFile(artifactUrls.openApi)),
    });

    const pointers: string[] = [];
    for (const boundary of corpus.cases) {
      for (const constraint of boundary.manifestConstraints) {
        const node = lookupPointer(documents.contractSchemas, constraint.contractArtifactPointer);
        expect(node[constraint.jsonSchemaKeyword], boundary.id).toBe(boundary.maximum);
        pointers.push(`contract:${constraint.contractArtifactPointer}`);
      }
      const contractRequestNode = lookupPointer(
        documents.contractSchemas,
        boundary.requestConstraint.contractArtifactPointer,
      );
      const openApiRequestNode = lookupPointer(
        documents.openApi,
        boundary.requestConstraint.openApiArtifactPointer,
      );
      expect(contractRequestNode[boundary.requestConstraint.jsonSchemaKeyword], boundary.id).toBe(
        boundary.maximum,
      );
      expect(openApiRequestNode[boundary.requestConstraint.jsonSchemaKeyword], boundary.id).toBe(
        boundary.maximum,
      );
      pointers.push(
        `contract:${boundary.requestConstraint.contractArtifactPointer}`,
        `openapi:${boundary.requestConstraint.openApiArtifactPointer}`,
      );
    }
    expect(pointers).toHaveLength(7);
    expect(new Set(pointers).size).toBe(7);
  });

  it('runs both N-1/N/N+1 variants through five runtime and advertised owners', async () => {
    const corpus = SnapshotResourceBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(corpusUrl, 'utf8')),
    );
    const baseBytes = await readFile(new URL(corpus.baseFixture.path, fixtureDirectoryUrl));
    expect(sha256(baseBytes)).toBe(corpus.baseFixture.digest);
    const baseManifest = SnapshotManifestSchema.parse(JSON.parse(baseBytes.toString('utf8')));
    const requestBase = await createValidUploadRequestBase();
    const contractSchemas = JSON.parse(await readFile(artifactUrls.contractSchemas, 'utf8')) as {
      schemas: Record<string, AnySchema>;
    };
    const openApi = JSON.parse(await readFile(artifactUrls.openApi, 'utf8')) as {
      components: { schemas: Record<string, AnySchema> };
    };
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const validateContractManifest = ajv.compile(contractSchemas.schemas.SnapshotManifest!);
    const validateContractRequest = ajv.compile(
      contractSchemas.schemas.SnapshotUploadCreateRequest!,
    );
    const validateOpenApiRequest = ajv.compile(
      openApi.components.schemas.SnapshotUploadCreateRequest!,
    );
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
        const request = {
          ...requestBase,
          fileCount: parsedManifest.totals.fileCount,
          expandedBytes: parsedManifest.totals.expandedBytes,
        };
        const expected = delta <= 0;
        const label = `${boundary.id}:${delta}`;
        const manifestRuntime = SnapshotManifestSchema.safeParse(manifest);
        const requestRuntime = SnapshotUploadCreateRequestSchema.safeParse(request);

        expect(manifestRuntime.success, `runtime-manifest:${label}`).toBe(expected);
        expect(requestRuntime.success, `runtime-request:${label}`).toBe(expected);
        outcomes += 2;

        const advertised = [
          { name: 'contract-manifest', validate: validateContractManifest, value: manifest },
          { name: 'contract-request', validate: validateContractRequest, value: request },
          { name: 'openapi-request', validate: validateOpenApiRequest, value: request },
        ];
        for (const validator of advertised) {
          expect(validator.validate(validator.value), `${validator.name}:${label}`).toBe(expected);
          outcomes += 1;
        }

        if (!expected) {
          if (manifestRuntime.success || requestRuntime.success) {
            throw new Error(`SNAPSHOT_RESOURCE_BOUNDARY_RUNTIME_ACCEPTED:${label}`);
          }
          for (const constraint of boundary.manifestConstraints) {
            expect(manifestRuntime.error.issues, `runtime-manifest:${label}`).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  code: 'too_big',
                  maximum: boundary.maximum,
                  path: pointerSegments(constraint.instancePath),
                }),
              ]),
            );
            expect(validateContractManifest.errors, `contract-manifest:${label}`).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  instancePath: constraint.instancePath,
                  keyword: constraint.jsonSchemaKeyword,
                }),
              ]),
            );
          }
          expect(requestRuntime.error.issues, `runtime-request:${label}`).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                code: 'too_big',
                maximum: boundary.maximum,
                path: pointerSegments(boundary.requestConstraint.instancePath),
              }),
            ]),
          );
          for (const validator of [validateContractRequest, validateOpenApiRequest]) {
            expect(validator.errors, `request:${label}`).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  instancePath: boundary.requestConstraint.instancePath,
                  keyword: boundary.requestConstraint.jsonSchemaKeyword,
                }),
              ]),
            );
          }
        }
      }
    }
    expect(outcomes).toBe(30);
  });
});
