import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type {
  GetObjectCommand,
  PutObjectCommand,
  GetObjectCommandOutput,
  PutObjectCommandOutput,
} from '@aws-sdk/client-s3';
import {
  SNAPSHOT_MAX_COMPRESSED_BYTES,
  SNAPSHOT_MAX_MANIFEST_BYTES,
  SnapshotArchiveEnvelopeSchema,
  SnapshotCompressedBoundaryCorpusSchema,
  SnapshotManifestEnvelopeSchema,
  canonicalizeJson,
  isCompressionRatioAllowed,
  parseSnapshotPublicationPreparationMarker,
  snapshotManifestEnvelopeAadDigest,
  snapshotManifestObjectKey,
  type SnapshotArchiveEnvelope,
  type SnapshotManifestEnvelope,
  type SnapshotPublicationPreparationMarker,
  type SnapshotSignedPutTarget,
  type SnapshotUploadCreateRequest,
  type SnapshotUploadCreateResponse,
} from '@cb/creator-agent-protocol';
import { describe, expect, it } from 'vitest';

import { isSnapshotError } from '../errors.js';
import {
  MAX_ENCRYPTED_MANIFEST_BYTES,
  MAX_ENCRYPTED_SNAPSHOT_BYTES,
  S3ImmutableSnapshotObjectStore,
  type SnapshotS3CommandClient,
  type SnapshotS3PutPresigner,
} from '../object-storage.js';
import { ALPHA_SNAPSHOT_POLICY } from '../policy.js';
import { assertCompressedArchiveLimits } from '../tar.js';

const corpusUrl = new URL(
  '../../../creator-agent-protocol/fixtures/snapshot-compressed-boundaries.v1.json',
  import.meta.url,
);
const fixtureDirectoryUrl = new URL('../../../creator-agent-protocol/fixtures/', import.meta.url);

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
  aad: SnapshotArchiveEnvelope['aad'];
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
  return {
    aad,
    envelope,
    request,
    preparation,
    target: archiveTarget,
    response: {
      protocol: 'combo.creator-agent-http/1',
      uploadId: derivation.selectedUploadId,
      state: 'CREATED',
      uploads: { archive: archiveTarget, manifest: manifestTarget },
      expiresAt: derivation.expiresAt,
    },
  };
}

class UnusedS3Client implements SnapshotS3CommandClient {
  calls = 0;

  async send(command: PutObjectCommand): Promise<PutObjectCommandOutput>;
  async send(command: GetObjectCommand): Promise<GetObjectCommandOutput>;
  async send(
    _command: PutObjectCommand | GetObjectCommand,
  ): Promise<PutObjectCommandOutput | GetObjectCommandOutput> {
    this.calls += 1;
    throw new Error('compressed numeric createUploadSession must not call S3');
  }
}

class CountingPresigner implements SnapshotS3PutPresigner {
  readonly calls: Array<{
    command: PutObjectCommand;
    requiredHeaders: Readonly<Record<string, string>>;
  }> = [];

  constructor(
    private readonly archivePutUrl: string,
    private readonly manifestPutUrl: string,
  ) {}

  async presignPut(input: {
    command: PutObjectCommand;
    requiredHeaders: Readonly<Record<string, string>>;
    expiresInSeconds: number;
    signingDate: Date;
  }): Promise<string> {
    this.calls.push({ command: input.command, requiredHeaders: input.requiredHeaders });
    return input.requiredHeaders['x-amz-meta-object-kind'] === 'archive'
      ? this.archivePutUrl
      : this.manifestPutUrl;
  }
}

function caught(action: () => unknown): unknown {
  try {
    action();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('production Snapshot compressed numeric owners', () => {
  it('derives both encrypted storage maxima from protocol plaintext maxima plus ADR-011 framing', () => {
    expect(ALPHA_SNAPSHOT_POLICY.maxCompressedBytes).toBe(SNAPSHOT_MAX_COMPRESSED_BYTES);
    expect(MAX_ENCRYPTED_SNAPSHOT_BYTES).toBe(SNAPSHOT_MAX_COMPRESSED_BYTES + 36);
    expect(MAX_ENCRYPTED_MANIFEST_BYTES).toBe(SNAPSHOT_MAX_MANIFEST_BYTES + 36);
  });

  it('runs the same digest-bound metadata probes through four production owners', async () => {
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
    let outcomes = 0;

    for (const probe of corpus.boundary.probes) {
      const documents = deriveDocuments(baseArchive, manifest, probe, corpus.derivation);
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

      const expected = probe.expected === 'accepted';
      expect(
        isCompressionRatioAllowed(probe.plaintextBytes, probe.plaintextBytes),
        `ratio:${probe.delta}`,
      ).toBe(expected);
      outcomes += 1;

      const limitError = caught(() =>
        assertCompressedArchiveLimits(probe.plaintextBytes, probe.plaintextBytes),
      );
      expect(limitError === undefined, `assert:${probe.delta}`).toBe(expected);
      if (!expected) {
        expect(isSnapshotError(limitError, 'SNAPSHOT_COMPRESSED_TOO_LARGE')).toBe(true);
      }
      outcomes += 1;

      const preparationBytes = Buffer.from(canonicalizeJson(documents.preparation), 'utf8');
      const parseError = caught(() => parseSnapshotPublicationPreparationMarker(preparationBytes));
      expect(parseError === undefined, `preparation:${probe.delta}`).toBe(expected);
      if (!expected) {
        const issues = (parseError as { issues?: unknown[] }).issues;
        expect(issues).toHaveLength(2);
        expect(issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'too_big',
              maximum: corpus.boundary.plaintextMaximum,
              path: ['request', 'archive', 'envelope', 'aad', 'plaintextBytes'],
            }),
            expect.objectContaining({
              code: 'too_big',
              maximum: corpus.boundary.cipherMaximum,
              path: ['request', 'archive', 'envelope', 'cipherBytes'],
            }),
          ]),
        );
      }
      outcomes += 1;

      const client = new UnusedS3Client();
      const presigner = new CountingPresigner(
        corpus.derivation.archivePutUrl,
        corpus.derivation.manifestPutUrl,
      );
      const store = new S3ImmutableSnapshotObjectStore({
        client,
        presigner,
        bucket: 'combo-agent-versions-test',
        creatorId: documents.aad.creatorId,
      });
      let response: SnapshotUploadCreateResponse | undefined;
      let storageError: unknown;
      try {
        response = await store.createUploadSession({
          uploadId: corpus.derivation.selectedUploadId,
          request: documents.request,
          expiresInSeconds: 900,
          now: new Date('2026-08-13T08:00:00.000Z'),
        });
      } catch (error) {
        storageError = error;
      }
      expect(response !== undefined, `storage:${probe.delta}`).toBe(expected);
      expect(client.calls).toBe(0);
      if (expected) {
        expect(presigner.calls).toHaveLength(2);
        expect(canonicalDigest(response), `storage-response:${probe.delta}`).toBe(
          probe.canonicalDigests.response,
        );
      } else {
        expect(isSnapshotError(storageError, 'SNAPSHOT_OBJECT_INVALID')).toBe(true);
        expect(presigner.calls).toHaveLength(0);
      }
      outcomes += 1;
    }
    expect(outcomes).toBe(12);
  });
});
