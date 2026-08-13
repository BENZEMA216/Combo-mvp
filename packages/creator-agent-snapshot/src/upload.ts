import {
  SNAPSHOT_ARCHIVE_OBJECT_FORMAT,
  SNAPSHOT_ENVELOPE_PROTOCOL,
  SNAPSHOT_MANIFEST_ENVELOPE_PROTOCOL,
  SNAPSHOT_MANIFEST_OBJECT_FORMAT,
  SnapshotUploadCreateRequestSchema,
  UuidSchema,
  snapshotArchiveObjectKey,
  snapshotManifestObjectKey,
  type SnapshotUploadCreateRequest,
} from '@cb/creator-agent-protocol';

import {
  encryptSnapshotArchive,
  encryptSnapshotManifest,
  type SnapshotDataKeyCreatorPort,
  type WrappedSnapshotDataKey,
} from './encryption.js';
import { fail, isSnapshotError } from './errors.js';
import { snapshotManifestBytes } from './manifest.js';
import { verifySnapshotArchive, type BuiltSnapshot } from './snapshot.js';

const DATA_ENCRYPTION_KEY_BYTES = 32;
const WRAPPED_DEK_BYTES = 40;

export type PrepareEncryptedSnapshotUploadInput = Readonly<{
  creatorId: string;
  snapshot: BuiltSnapshot;
  keyEnvelope: SnapshotDataKeyCreatorPort;
}>;

export type PreparedEncryptedSnapshotUpload = Readonly<{
  request: SnapshotUploadCreateRequest;
  archiveObjectBytes: Buffer;
  manifestObjectBytes: Buffer;
}>;

function checksumForHexDigest(digest: string): string {
  return Buffer.from(digest, 'hex').toString('base64');
}

function verifyBuiltSnapshot(snapshot: BuiltSnapshot): void {
  if (
    snapshot === null ||
    typeof snapshot !== 'object' ||
    !(snapshot.manifestBytes instanceof Uint8Array) ||
    !(snapshot.archiveBytes instanceof Uint8Array)
  ) {
    fail('SNAPSHOT_ARCHIVE_INVALID');
  }
  let verified;
  try {
    verified = verifySnapshotArchive({
      manifestBytes: snapshot.manifestBytes,
      archiveBytes: snapshot.archiveBytes,
      expectedSnapshotDigest: snapshot.snapshotDigest,
      expectedArchiveDigest: snapshot.archiveDigest,
    });
    if (!snapshotManifestBytes(snapshot.manifest).equals(Buffer.from(snapshot.manifestBytes))) {
      fail('SNAPSHOT_DIGEST_MISMATCH');
    }
  } catch (error) {
    if (isSnapshotError(error)) throw error;
    fail('SNAPSHOT_ARCHIVE_INVALID', error);
  }
  if (
    snapshot.fileCount !== verified.fileCount ||
    snapshot.expandedBytes !== verified.expandedBytes ||
    snapshot.compressedBytes !== verified.compressedBytes
  ) {
    fail('SNAPSHOT_DIGEST_MISMATCH');
  }
}

function assertCreatedDataKey(value: WrappedSnapshotDataKey): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof value.keyId !== 'string' ||
    !(value.wrappedDek instanceof Uint8Array) ||
    value.wrappedDek.byteLength !== WRAPPED_DEK_BYTES ||
    !(value.plaintextKey instanceof Uint8Array) ||
    value.plaintextKey.byteLength !== DATA_ENCRYPTION_KEY_BYTES
  ) {
    fail('SNAPSHOT_ENCRYPTION_INVALID');
  }
}

/**
 * Creator Worker bridge. The complete deterministic Snapshot is verified before a DEK is minted;
 * both cipher objects then exist before the Authoring upload-session request can be constructed.
 */
export async function prepareEncryptedSnapshotUpload(
  input: PrepareEncryptedSnapshotUploadInput,
): Promise<PreparedEncryptedSnapshotUpload> {
  const creator = UuidSchema.safeParse(input.creatorId);
  if (!creator.success) fail('SNAPSHOT_ENCRYPTION_INVALID');
  verifyBuiltSnapshot(input.snapshot);

  let created: WrappedSnapshotDataKey | undefined;
  let dataKey: Buffer | undefined;
  let wrappedDek: Buffer | undefined;
  try {
    try {
      created = await input.keyEnvelope.createDataKey({
        creatorId: creator.data,
        snapshotDigest: input.snapshot.snapshotDigest,
        archiveDigest: input.snapshot.archiveDigest,
      });
    } catch (error) {
      if (isSnapshotError(error)) throw error;
      fail('SNAPSHOT_ENCRYPTION_INVALID', error);
    }
    assertCreatedDataKey(created);
    dataKey = Buffer.from(created.plaintextKey);
    wrappedDek = Buffer.from(created.wrappedDek);
    const keyWrap = { keyId: created.keyId, wrappedDek };
    const archive = encryptSnapshotArchive(
      input.snapshot.archiveBytes,
      {
        protocol: SNAPSHOT_ENVELOPE_PROTOCOL,
        schemaVersion: 1,
        cipherObjectFormat: SNAPSHOT_ARCHIVE_OBJECT_FORMAT,
        creatorId: creator.data,
        snapshotDigest: input.snapshot.snapshotDigest,
        archiveDigest: input.snapshot.archiveDigest,
        objectKey: snapshotArchiveObjectKey(creator.data, input.snapshot.snapshotDigest),
        plaintextBytes: input.snapshot.archiveBytes.byteLength,
        keyId: created.keyId,
      },
      dataKey,
      keyWrap,
    );
    const manifest = encryptSnapshotManifest(
      input.snapshot.manifestBytes,
      {
        protocol: SNAPSHOT_MANIFEST_ENVELOPE_PROTOCOL,
        schemaVersion: 1,
        cipherObjectFormat: SNAPSHOT_MANIFEST_OBJECT_FORMAT,
        creatorId: creator.data,
        snapshotDigest: input.snapshot.snapshotDigest,
        objectKey: snapshotManifestObjectKey(creator.data, input.snapshot.snapshotDigest),
        plaintextBytes: input.snapshot.manifestBytes.byteLength,
        keyId: created.keyId,
      },
      dataKey,
      keyWrap,
    );
    const request = SnapshotUploadCreateRequestSchema.parse({
      archive: {
        envelope: archive.envelope,
        checksumSha256: checksumForHexDigest(archive.envelope.cipherDigest),
      },
      manifest: {
        envelope: manifest.envelope,
        checksumSha256: checksumForHexDigest(manifest.envelope.cipherDigest),
      },
      expandedBytes: input.snapshot.expandedBytes,
      fileCount: input.snapshot.fileCount,
    });
    return Object.freeze({
      request,
      archiveObjectBytes: archive.objectBytes,
      manifestObjectBytes: manifest.objectBytes,
    });
  } finally {
    dataKey?.fill(0);
    wrappedDek?.fill(0);
    created?.plaintextKey.fill(0);
    created?.wrappedDek.fill(0);
  }
}
