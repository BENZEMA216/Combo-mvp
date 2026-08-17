import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Ajv, type AnySchema, type ValidateFunction } from 'ajv';
import { describe, expect, it } from 'vitest';

import { canonicalizeJson } from '../canonical.js';
import {
  SnapshotArchiveSignedPutTargetSchema,
  SnapshotPublicationPreparationMarkerSchema,
  SnapshotSignedPutTargetSchema,
  SnapshotUploadCreateRequestSchema,
  SnapshotUploadCreateResponseSchema,
  type SnapshotPublicationPreparationMarker,
  type SnapshotSignedPutTarget,
  type SnapshotUploadCreateRequest,
  type SnapshotUploadCreateResponse,
} from '../http.js';
import { SnapshotCompressedBoundaryCorpusSchema } from '../snapshot-compressed-boundaries.js';
import {
  SnapshotArchiveEnvelopeAadSchema,
  SnapshotArchiveEnvelopeSchema,
  SnapshotManifestEnvelopeSchema,
  snapshotManifestEnvelopeAadDigest,
  snapshotManifestObjectKey,
  type SnapshotArchiveEnvelope,
  type SnapshotArchiveEnvelopeAad,
  type SnapshotManifestEnvelope,
} from '../snapshot.js';

const corpusUrl = new URL('../../fixtures/snapshot-compressed-boundaries.v1.json', import.meta.url);
const corpusFixturePath = 'snapshot-compressed-boundaries.v1.json';
const fixtureDirectoryUrl = new URL('../../fixtures/', import.meta.url);
const fixtureIndexUrl = new URL('../../fixtures/index.json', import.meta.url);
const artifactUrls = {
  contractSchemas: new URL('../../schemas/contract-schemas.v1.json', import.meta.url),
  openApi: new URL('../../openapi/creator-agent-v1.openapi.json', import.meta.url),
} as const;

function sha256(bytes: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function canonicalDigest(value: unknown): `sha256:${string}` {
  return sha256(canonicalizeJson(value));
}

function bareDigest(digest: `sha256:${string}`): string {
  return digest.slice('sha256:'.length);
}

function checksumForHexDigest(digest: string): string {
  return Buffer.from(digest, 'hex').toString('base64');
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
      throw new Error(`SNAPSHOT_COMPRESSED_BOUNDARY_POINTER_MISSING:${pointer}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || typeof current !== 'object') {
    throw new Error(`SNAPSHOT_COMPRESSED_BOUNDARY_POINTER_NOT_OBJECT:${pointer}`);
  }
  return current as Record<string, unknown>;
}

function target(
  kind: 'archive' | 'manifest',
  putUrl: string,
  cipherBytes: number,
  cipherDigest: string,
  checksumSha256: string,
  archiveDigest: string,
  snapshotDigest: string,
): SnapshotSignedPutTarget {
  return {
    method: 'PUT',
    putUrl,
    cipherBytes,
    cipherDigest,
    requiredHeaders: {
      'cache-control': 'no-store',
      'content-length': String(cipherBytes),
      'content-type': 'application/octet-stream',
      'if-none-match': '*',
      'x-amz-checksum-sha256': checksumSha256,
      'x-amz-meta-archive-digest': archiveDigest,
      'x-amz-meta-cipher-bytes': String(cipherBytes),
      'x-amz-meta-cipher-digest': cipherDigest,
      'x-amz-meta-object-kind': kind,
      'x-amz-meta-object-state': 'upload',
      'x-amz-meta-protocol': 'combo.snapshot-object-storage/1',
      'x-amz-meta-snapshot-digest': snapshotDigest,
    },
  };
}

function synchronizedManifestEnvelope(
  archive: SnapshotArchiveEnvelope,
  fixture: SnapshotManifestEnvelope,
): SnapshotManifestEnvelope {
  const aad = {
    ...fixture.aad,
    creatorId: archive.aad.creatorId,
    snapshotDigest: archive.aad.snapshotDigest,
    objectKey: snapshotManifestObjectKey(archive.aad.creatorId, archive.aad.snapshotDigest),
    keyId: archive.aad.keyId,
  };
  return SnapshotManifestEnvelopeSchema.parse({
    ...fixture,
    aad,
    aadDigest: snapshotManifestEnvelopeAadDigest(aad),
    wrappedDek: archive.wrappedDek,
  });
}

type DerivedDocuments = Readonly<{
  aad: SnapshotArchiveEnvelopeAad;
  envelope: SnapshotArchiveEnvelope;
  request: SnapshotUploadCreateRequest;
  preparation: SnapshotPublicationPreparationMarker;
  target: SnapshotSignedPutTarget;
  response: SnapshotUploadCreateResponse;
}>;

function deriveDocuments(
  baseArchive: SnapshotArchiveEnvelope,
  manifest: SnapshotManifestEnvelope,
  probe: { plaintextBytes: number; cipherBytes: number },
  derivation: {
    selectedUploadId: string;
    archivePutUrl: string;
    manifestPutUrl: string;
    expiresAt: string;
  },
): DerivedDocuments {
  const aad = { ...baseArchive.aad, plaintextBytes: probe.plaintextBytes };
  const envelope = {
    ...baseArchive,
    aad,
    aadDigest: bareDigest(canonicalDigest(aad)),
    cipherBytes: probe.cipherBytes,
  };
  const archiveChecksum = checksumForHexDigest(envelope.cipherDigest);
  const manifestChecksum = checksumForHexDigest(manifest.cipherDigest);
  const request = {
    archive: { envelope, checksumSha256: archiveChecksum },
    manifest: { envelope: manifest, checksumSha256: manifestChecksum },
    expandedBytes: probe.plaintextBytes,
    fileCount: 1,
  };
  const preparation = {
    protocol: 'combo.snapshot-publication-preparation/1' as const,
    schemaVersion: 1 as const,
    creatorId: aad.creatorId,
    snapshotDigest: aad.snapshotDigest,
    selectedUploadId: derivation.selectedUploadId,
    request,
  };
  const archiveTarget = target(
    'archive',
    derivation.archivePutUrl,
    probe.cipherBytes,
    envelope.cipherDigest,
    archiveChecksum,
    aad.archiveDigest,
    aad.snapshotDigest,
  );
  const manifestTarget = target(
    'manifest',
    derivation.manifestPutUrl,
    manifest.cipherBytes,
    manifest.cipherDigest,
    manifestChecksum,
    aad.archiveDigest,
    aad.snapshotDigest,
  );
  const response = {
    protocol: 'combo.creator-agent-http/1' as const,
    uploadId: derivation.selectedUploadId,
    state: 'CREATED' as const,
    uploads: { archive: archiveTarget, manifest: manifestTarget },
    expiresAt: derivation.expiresAt,
  };
  return { aad, envelope, request, preparation, target: archiveTarget, response };
}

function expectZodMaximumIssues(
  result: {
    success: boolean;
    error?: { issues: ReadonlyArray<{ code: string; path: Array<string | number> }> };
  },
  expected: ReadonlyArray<{ path: Array<string | number>; maximum: number }>,
): void {
  if (result.success || result.error === undefined) {
    throw new Error('SNAPSHOT_COMPRESSED_BOUNDARY_RUNTIME_ACCEPTED:N+1');
  }
  expect(result.error.issues).toHaveLength(expected.length);
  for (const issue of expected) {
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({ code: 'too_big', maximum: issue.maximum, path: issue.path }),
    );
  }
}

function expectAjvMaximumIssues(
  validator: ValidateFunction,
  expectedPaths: readonly string[],
): void {
  expect(validator.errors).toHaveLength(expectedPaths.length);
  for (const instancePath of expectedPaths) {
    expect(validator.errors).toContainEqual(
      expect.objectContaining({
        instancePath,
        keyword: 'maximum',
        params: expect.objectContaining({ comparison: '<=' }),
      }),
    );
  }
}

describe('digest-bound Snapshot compressed numeric owners', () => {
  it('pins the external authority, evidence class, base fixtures and eleven advertised paths', async () => {
    const corpusBytes = await readFile(corpusUrl);
    const corpus = SnapshotCompressedBoundaryCorpusSchema.parse(
      JSON.parse(corpusBytes.toString('utf8')),
    );
    expect(corpus.authority).toEqual({
      technicalPlanSection: '技术方案 §5.2 Alpha 输入边界',
      testPlanCases: ['SNP-008'],
      decisionRegistryId: 'ADR-VNEXT-003',
      cipherOverheadDecisionId: 'ADR-VNEXT-011',
    });
    expect(corpus.evidenceClass).toBe('metadata-numeric-only');
    expect(corpus.boundary.cipherMaximum).toBe(
      corpus.boundary.plaintextMaximum + corpus.boundary.cipherOverheadBytes,
    );

    const fixtureIndex = JSON.parse(await readFile(fixtureIndexUrl, 'utf8')) as {
      fixtures: Array<{ path: string; bytes: number; digest: string }>;
    };
    expect(fixtureIndex.fixtures.find(({ path }) => path === corpusFixturePath)).toEqual({
      path: corpusFixturePath,
      bytes: corpusBytes.byteLength,
      digest: sha256(corpusBytes),
    });
    for (const fixture of corpus.baseFixtures) {
      const bytes = await readFile(new URL(fixture.path, fixtureDirectoryUrl));
      expect(sha256(bytes), fixture.kind).toBe(fixture.digest);
      expect(fixtureIndex.fixtures.find(({ path }) => path === fixture.path)).toEqual({
        path: fixture.path,
        bytes: bytes.byteLength,
        digest: fixture.digest,
      });
    }

    const documents = {
      contractSchemas: JSON.parse(await readFile(artifactUrls.contractSchemas, 'utf8')) as unknown,
      openApi: JSON.parse(await readFile(artifactUrls.openApi, 'utf8')) as unknown,
    };
    expect(corpus.checkedArtifactDigests).toEqual({
      contractSchemas: sha256(await readFile(artifactUrls.contractSchemas)),
      openApi: sha256(await readFile(artifactUrls.openApi)),
    });
    const pointers: string[] = [];
    for (const constraint of corpus.advertisedConstraints) {
      const node = lookupPointer(documents[constraint.artifact], constraint.artifactPointer);
      const maximum =
        constraint.valueKind === 'plaintextBytes'
          ? corpus.boundary.plaintextMaximum
          : corpus.boundary.cipherMaximum;
      expect(node[constraint.jsonSchemaKeyword], constraint.owner).toBe(maximum);
      pointers.push(`${constraint.artifact}:${constraint.artifactPointer}`);
    }
    expect(pointers).toHaveLength(11);
    expect(new Set(pointers).size).toBe(11);
  });

  it('runs one digest-identical N-1/N/N+1 variant through fourteen runtime and advertised owners', async () => {
    const corpus = SnapshotCompressedBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(corpusUrl, 'utf8')),
    );
    const [archiveFixture, manifestFixture] = await Promise.all(
      corpus.baseFixtures.map(async (fixture) => {
        const bytes = await readFile(new URL(fixture.path, fixtureDirectoryUrl));
        expect(sha256(bytes), fixture.kind).toBe(fixture.digest);
        return JSON.parse(bytes.toString('utf8')) as unknown;
      }),
    );
    const baseArchive = SnapshotArchiveEnvelopeSchema.parse(archiveFixture);
    const manifest = synchronizedManifestEnvelope(
      baseArchive,
      SnapshotManifestEnvelopeSchema.parse(manifestFixture),
    );
    const contractSchemas = JSON.parse(await readFile(artifactUrls.contractSchemas, 'utf8')) as {
      schemas: Record<string, AnySchema>;
    };
    const openApi = JSON.parse(await readFile(artifactUrls.openApi, 'utf8')) as {
      components: { schemas: Record<string, AnySchema> };
    };
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const advertised = {
      contractAad: ajv.compile(contractSchemas.schemas.SnapshotArchiveEnvelopeAad!),
      contractEnvelope: ajv.compile(contractSchemas.schemas.SnapshotArchiveEnvelope!),
      contractRequest: ajv.compile(contractSchemas.schemas.SnapshotUploadCreateRequest!),
      contractPreparation: ajv.compile(
        contractSchemas.schemas.SnapshotPublicationPreparationMarker!,
      ),
      contractResponse: ajv.compile(contractSchemas.schemas.SnapshotUploadCreateResponse!),
      openApiRequest: ajv.compile(openApi.components.schemas.SnapshotUploadCreateRequest!),
      openApiResponse: ajv.compile(openApi.components.schemas.SnapshotUploadCreateResponse!),
    };
    let outcomes = 0;

    for (const probe of corpus.boundary.probes) {
      expect(probe.cipherBytes, `overhead:${probe.delta}`).toBe(
        probe.plaintextBytes + corpus.boundary.cipherOverheadBytes,
      );
      const documents = deriveDocuments(baseArchive, manifest, probe, corpus.derivation);

      // These six identities are checked before any derived document enters a parser/validator.
      for (const key of [
        'aad',
        'envelope',
        'request',
        'preparation',
        'target',
        'response',
      ] as const) {
        expect(canonicalDigest(documents[key]), `${key}:${probe.delta}`).toBe(
          probe.canonicalDigests[key],
        );
      }

      // Numeric owner evidence deliberately uses direct Schema.safeParse so exact Zod maximum
      // issues remain inspectable; public raw parsers expose only ProtocolRawInputError.
      const runtime = {
        aad: SnapshotArchiveEnvelopeAadSchema.safeParse(documents.aad),
        envelope: SnapshotArchiveEnvelopeSchema.safeParse(documents.envelope),
        request: SnapshotUploadCreateRequestSchema.safeParse(documents.request),
        preparation: SnapshotPublicationPreparationMarkerSchema.safeParse(documents.preparation),
        archiveTarget: SnapshotArchiveSignedPutTargetSchema.safeParse(documents.target),
        target: SnapshotSignedPutTargetSchema.safeParse(documents.target),
        response: SnapshotUploadCreateResponseSchema.safeParse(documents.response),
      };
      const expected = probe.expected === 'accepted';
      for (const [owner, result] of Object.entries(runtime)) {
        expect(result.success, `runtime:${owner}:${probe.delta}`).toBe(expected);
        outcomes += 1;
      }

      const advertisedValues: ReadonlyArray<readonly [string, ValidateFunction, unknown]> = [
        ['contract-aad', advertised.contractAad, documents.aad],
        ['contract-envelope', advertised.contractEnvelope, documents.envelope],
        ['contract-request', advertised.contractRequest, documents.request],
        ['contract-preparation', advertised.contractPreparation, documents.preparation],
        ['contract-response', advertised.contractResponse, documents.response],
        ['openapi-request', advertised.openApiRequest, documents.request],
        ['openapi-response', advertised.openApiResponse, documents.response],
      ];
      for (const [owner, validate, value] of advertisedValues) {
        expect(validate(value), `${owner}:${probe.delta}`).toBe(expected);
        outcomes += 1;
      }

      if (!expected) {
        expectZodMaximumIssues(runtime.aad, [
          { path: ['plaintextBytes'], maximum: corpus.boundary.plaintextMaximum },
        ]);
        expectZodMaximumIssues(runtime.envelope, [
          { path: ['aad', 'plaintextBytes'], maximum: corpus.boundary.plaintextMaximum },
          { path: ['cipherBytes'], maximum: corpus.boundary.cipherMaximum },
        ]);
        expectZodMaximumIssues(runtime.request, [
          {
            path: ['archive', 'envelope', 'aad', 'plaintextBytes'],
            maximum: corpus.boundary.plaintextMaximum,
          },
          {
            path: ['archive', 'envelope', 'cipherBytes'],
            maximum: corpus.boundary.cipherMaximum,
          },
        ]);
        expectZodMaximumIssues(runtime.preparation, [
          {
            path: ['request', 'archive', 'envelope', 'aad', 'plaintextBytes'],
            maximum: corpus.boundary.plaintextMaximum,
          },
          {
            path: ['request', 'archive', 'envelope', 'cipherBytes'],
            maximum: corpus.boundary.cipherMaximum,
          },
        ]);
        expectZodMaximumIssues(runtime.archiveTarget, [
          { path: ['cipherBytes'], maximum: corpus.boundary.cipherMaximum },
        ]);
        expectZodMaximumIssues(runtime.response, [
          {
            path: ['uploads', 'archive', 'cipherBytes'],
            maximum: corpus.boundary.cipherMaximum,
          },
        ]);
        expectZodMaximumIssues(runtime.target, [
          { path: ['cipherBytes'], maximum: corpus.boundary.cipherMaximum },
        ]);

        expectAjvMaximumIssues(advertised.contractAad, ['/plaintextBytes']);
        expectAjvMaximumIssues(advertised.contractEnvelope, [
          '/aad/plaintextBytes',
          '/cipherBytes',
        ]);
        expectAjvMaximumIssues(advertised.contractRequest, [
          '/archive/envelope/aad/plaintextBytes',
          '/archive/envelope/cipherBytes',
        ]);
        expectAjvMaximumIssues(advertised.contractPreparation, [
          '/request/archive/envelope/aad/plaintextBytes',
          '/request/archive/envelope/cipherBytes',
        ]);
        expectAjvMaximumIssues(advertised.contractResponse, ['/uploads/archive/cipherBytes']);
        expectAjvMaximumIssues(advertised.openApiRequest, [
          '/archive/envelope/aad/plaintextBytes',
          '/archive/envelope/cipherBytes',
        ]);
        expectAjvMaximumIssues(advertised.openApiResponse, ['/uploads/archive/cipherBytes']);
      }
    }
    expect(outcomes).toBe(42);
  });
});
