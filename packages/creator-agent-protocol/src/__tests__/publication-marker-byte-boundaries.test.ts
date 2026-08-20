import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

// VNext registry case: SCH-004 (reachable canonical marker N-1/N/N+1).

import { canonicalizeJson } from '../canonical.js';
import { assertPublicManualCapOutcomeSubset } from '../public-manual-cap-outcomes.js';
import {
  parseSnapshotPublicationCommitMarker,
  parseSnapshotPublicationPreparationMarker,
  snapshotPublicationCommitMarkerBytes,
  snapshotPublicationPreparationMarkerBytes,
  type SnapshotPublicationCommitMarker,
  type SnapshotPublicationPreparationMarker,
} from '../http.js';
import {
  SNAPSHOT_EXACT_PUBLICATION_COMMIT_MARKER_BYTES,
  SNAPSHOT_MAX_COMPRESSED_BYTES,
  SNAPSHOT_MAX_CANONICAL_MANIFEST_BYTES,
  SNAPSHOT_MAX_EXPANDED_BYTES,
  SNAPSHOT_MAX_FILES,
  SNAPSHOT_MAX_PUBLICATION_PREPARATION_MARKER_BYTES,
  SnapshotArchiveEnvelopeSchema,
  SnapshotManifestEnvelopeSchema,
  snapshotArchiveEnvelopeAadDigest,
  snapshotArchiveObjectKey,
  snapshotManifestEnvelopeAadDigest,
  snapshotManifestObjectKey,
  snapshotPublicationPreparationObjectKey,
  type SnapshotArchiveEnvelope,
  type SnapshotManifestEnvelope,
} from '../snapshot.js';

const fixtureDirectory = new URL('../../fixtures/', import.meta.url);
const manualOutcomeFixtureUrl = new URL(
  '../../fixtures/public-manual-cap-outcomes.v1.json',
  import.meta.url,
);
const consumerTestFile =
  'packages/creator-agent-protocol/src/__tests__/publication-marker-byte-boundaries.test.ts';

function checksumForHexDigest(digest: string): string {
  return Buffer.from(digest, 'hex').toString('base64');
}

async function maximumPreparationMarker(
  fileCount: number,
): Promise<SnapshotPublicationPreparationMarker> {
  const [archiveFixture, manifestFixture] = await Promise.all([
    readFile(new URL('snapshot-envelope.v1.json', fixtureDirectory), 'utf8'),
    readFile(new URL('snapshot-manifest-envelope.v1.json', fixtureDirectory), 'utf8'),
  ]);
  const baseArchive = SnapshotArchiveEnvelopeSchema.parse(JSON.parse(archiveFixture));
  const baseManifest = SnapshotManifestEnvelopeSchema.parse(JSON.parse(manifestFixture));
  const creatorId = baseArchive.aad.creatorId;
  const snapshotDigest = baseArchive.aad.snapshotDigest;
  const keyId = 'k'.repeat(256);
  const archiveAad = {
    ...baseArchive.aad,
    creatorId,
    snapshotDigest,
    objectKey: snapshotArchiveObjectKey(creatorId, snapshotDigest),
    plaintextBytes: SNAPSHOT_MAX_COMPRESSED_BYTES,
    keyId,
  };
  const archive: SnapshotArchiveEnvelope = SnapshotArchiveEnvelopeSchema.parse({
    ...baseArchive,
    aad: archiveAad,
    aadDigest: snapshotArchiveEnvelopeAadDigest(archiveAad),
    cipherBytes: SNAPSHOT_MAX_COMPRESSED_BYTES + 36,
  });
  const manifestAad = {
    ...baseManifest.aad,
    creatorId,
    snapshotDigest,
    objectKey: snapshotManifestObjectKey(creatorId, snapshotDigest),
    plaintextBytes: SNAPSHOT_MAX_CANONICAL_MANIFEST_BYTES,
    keyId,
  };
  const manifest: SnapshotManifestEnvelope = SnapshotManifestEnvelopeSchema.parse({
    ...baseManifest,
    aad: manifestAad,
    aadDigest: snapshotManifestEnvelopeAadDigest(manifestAad),
    wrappedDek: archive.wrappedDek,
    cipherBytes: SNAPSHOT_MAX_CANONICAL_MANIFEST_BYTES + 36,
  });
  return {
    protocol: 'combo.snapshot-publication-preparation/1',
    schemaVersion: 1,
    creatorId,
    snapshotDigest,
    selectedUploadId: '0198f00d-8000-7000-8000-000000000011',
    request: {
      archive: { envelope: archive, checksumSha256: checksumForHexDigest(archive.cipherDigest) },
      manifest: {
        envelope: manifest,
        checksumSha256: checksumForHexDigest(manifest.cipherDigest),
      },
      expandedBytes: SNAPSHOT_MAX_EXPANDED_BYTES,
      fileCount,
    },
  };
}

function commitMarker(preparationDigest = 'f'.repeat(64)): SnapshotPublicationCommitMarker {
  const creatorId = '0198f00d-8000-7000-8000-000000000001';
  const snapshotDigest = '0'.repeat(64);
  return {
    protocol: 'combo.snapshot-publication-commit/1',
    schemaVersion: 1,
    creatorId,
    snapshotDigest,
    preparationKey: snapshotPublicationPreparationObjectKey(creatorId, snapshotDigest),
    preparationDigest,
  };
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalizeJson(value), 'utf8');
}

describe('ADR-VNEXT-034 exact canonical publication-marker byte boundaries', () => {
  it('accepts a real preparation N-1/N and rejects canonical known-field N+1 before parsing', async () => {
    const atMaximum = await maximumPreparationMarker(SNAPSHOT_MAX_FILES);
    const belowMaximum = await maximumPreparationMarker(999);
    const n = snapshotPublicationPreparationMarkerBytes(atMaximum);
    const nMinusOne = snapshotPublicationPreparationMarkerBytes(belowMaximum);
    const aboveMaximum = {
      ...atMaximum,
      request: { ...atMaximum.request, expandedBytes: 1_000_000_000 },
    };
    const nPlusOne = canonicalBytes(aboveMaximum);

    expect(n.byteLength).toBe(SNAPSHOT_MAX_PUBLICATION_PREPARATION_MARKER_BYTES);
    expect(nMinusOne.byteLength).toBe(SNAPSHOT_MAX_PUBLICATION_PREPARATION_MARKER_BYTES - 1);
    expect(nPlusOne.byteLength).toBe(SNAPSHOT_MAX_PUBLICATION_PREPARATION_MARKER_BYTES + 1);
    expect(parseSnapshotPublicationPreparationMarker(nMinusOne)).toEqual(belowMaximum);
    expect(parseSnapshotPublicationPreparationMarker(n)).toEqual(atMaximum);
    expect(() => parseSnapshotPublicationPreparationMarker(nPlusOne)).toThrowError(
      expect.objectContaining({
        name: 'ProtocolRawInputError',
        code: 'SNAPSHOT_PREPARATION_MARKER_INVALID',
      }),
    );
    const accepted = (bytes: Uint8Array): boolean => {
      try {
        parseSnapshotPublicationPreparationMarker(bytes);
        return true;
      } catch {
        return false;
      }
    };
    assertPublicManualCapOutcomeSubset(
      JSON.parse(await readFile(manualOutcomeFixtureUrl, 'utf8')),
      consumerTestFile,
      [
        {
          probeId: 'manual-cap:preparation-marker:n-minus-one-n-plus-one',
          delta: -1,
          accepted: accepted(nMinusOne),
        },
        {
          probeId: 'manual-cap:preparation-marker:n-minus-one-n-plus-one',
          delta: 0,
          accepted: accepted(n),
        },
        {
          probeId: 'manual-cap:preparation-marker:n-minus-one-n-plus-one',
          delta: 1,
          accepted: accepted(nPlusOne),
        },
      ],
    );
  });

  it('treats the commit marker as one exact reachable length, not a variable maximum', async () => {
    const exact = commitMarker();
    const n = snapshotPublicationCommitMarkerBytes(exact);
    const nMinusOne = canonicalBytes(commitMarker('f'.repeat(63)));
    const nPlusOne = canonicalBytes(commitMarker('f'.repeat(65)));

    expect(n.byteLength).toBe(SNAPSHOT_EXACT_PUBLICATION_COMMIT_MARKER_BYTES);
    expect(nMinusOne.byteLength).toBe(SNAPSHOT_EXACT_PUBLICATION_COMMIT_MARKER_BYTES - 1);
    expect(nPlusOne.byteLength).toBe(SNAPSHOT_EXACT_PUBLICATION_COMMIT_MARKER_BYTES + 1);
    expect(parseSnapshotPublicationCommitMarker(n)).toEqual(exact);
    for (const candidate of [nMinusOne, nPlusOne]) {
      expect(() => parseSnapshotPublicationCommitMarker(candidate)).toThrowError(
        expect.objectContaining({
          name: 'ProtocolRawInputError',
          code: 'SNAPSHOT_COMMIT_MARKER_INVALID',
        }),
      );
    }
    const accepted = (bytes: Uint8Array): boolean => {
      try {
        parseSnapshotPublicationCommitMarker(bytes);
        return true;
      } catch {
        return false;
      }
    };
    assertPublicManualCapOutcomeSubset(
      JSON.parse(await readFile(manualOutcomeFixtureUrl, 'utf8')),
      consumerTestFile,
      [
        {
          probeId: 'manual-cap:commit-marker:exact-n-minus-one-n-plus-one',
          delta: -1,
          accepted: accepted(nMinusOne),
        },
        {
          probeId: 'manual-cap:commit-marker:exact-n-minus-one-n-plus-one',
          delta: 0,
          accepted: accepted(n),
        },
        {
          probeId: 'manual-cap:commit-marker:exact-n-minus-one-n-plus-one',
          delta: 1,
          accepted: accepted(nPlusOne),
        },
      ],
    );
  });
});
