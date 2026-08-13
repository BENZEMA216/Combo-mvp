import {
  SnapshotArchiveEnvelopeSchema,
  type SnapshotArchiveEnvelope,
} from '@cb/creator-agent-protocol';

import { equalHexDigest, sha256Hex } from './digest.js';
import { inspectTextContent } from './content-policy.js';
import { decryptSnapshotArchive } from './encryption.js';
import { fail } from './errors.js';
import {
  createSnapshotManifest,
  parseSnapshotManifest,
  snapshotDigest,
  snapshotManifestBytes,
  type SnapshotManifest,
} from './manifest.js';
import { readStagedProject, stageProject } from './staging.js';
import {
  assertCompressedArchiveLimits,
  compressDeterministicTar,
  createDeterministicTar,
  decompressAndParseDeterministicArchive,
} from './tar.js';

export type BuiltSnapshot = Readonly<{
  manifest: SnapshotManifest;
  manifestBytes: Buffer;
  archiveBytes: Buffer;
  snapshotDigest: string;
  archiveDigest: string;
  fileCount: number;
  expandedBytes: number;
  compressedBytes: number;
}>;

export async function buildSnapshotFromProject(projectRoot: string): Promise<BuiltSnapshot> {
  const staged = await stageProject(projectRoot);
  try {
    const stagedFiles = await readStagedProject(staged);
    const manifest = createSnapshotManifest(
      stagedFiles.map(({ path, size, mediaType, sha256 }) => ({ path, size, mediaType, sha256 })),
    );
    const manifestBytes = snapshotManifestBytes(manifest);
    const tarBytes = createDeterministicTar(
      stagedFiles.map(({ path, bytes }) => ({ path, bytes })),
    );
    const archiveBytes = compressDeterministicTar(tarBytes);
    assertCompressedArchiveLimits(archiveBytes.byteLength, manifest.totals.expandedBytes);
    return Object.freeze({
      manifest,
      manifestBytes,
      archiveBytes,
      snapshotDigest: snapshotDigest(manifest),
      archiveDigest: sha256Hex(archiveBytes),
      fileCount: manifest.totals.fileCount,
      expandedBytes: manifest.totals.expandedBytes,
      compressedBytes: archiveBytes.byteLength,
    });
  } finally {
    await staged.cleanup();
  }
}

export type VerifySnapshotArchiveInput = Readonly<{
  manifestBytes: Uint8Array;
  archiveBytes: Uint8Array;
  expectedSnapshotDigest: string;
  expectedArchiveDigest: string;
}>;

export type VerifiedSnapshotArchive = Readonly<{
  manifest: SnapshotManifest;
  snapshotDigest: string;
  archiveDigest: string;
  fileCount: number;
  expandedBytes: number;
  compressedBytes: number;
}>;

export function verifySnapshotArchive(input: VerifySnapshotArchiveInput): VerifiedSnapshotArchive {
  const manifest = parseSnapshotManifest(input.manifestBytes);
  const actualSnapshotDigest = sha256Hex(input.manifestBytes);
  const actualArchiveDigest = sha256Hex(input.archiveBytes);
  if (
    !equalHexDigest(actualSnapshotDigest, input.expectedSnapshotDigest) ||
    !equalHexDigest(actualArchiveDigest, input.expectedArchiveDigest)
  ) {
    fail('SNAPSHOT_DIGEST_MISMATCH');
  }
  assertCompressedArchiveLimits(input.archiveBytes.byteLength, manifest.totals.expandedBytes);
  const archiveFiles = decompressAndParseDeterministicArchive(input.archiveBytes);
  if (archiveFiles.length !== manifest.files.length) fail('SNAPSHOT_ARCHIVE_INVALID');

  for (let index = 0; index < manifest.files.length; index += 1) {
    const expected = manifest.files[index]!;
    const actual = archiveFiles[index]!;
    const inspected = inspectTextContent(actual.path, actual.bytes);
    if (
      actual.path !== expected.path ||
      actual.bytes.byteLength !== expected.size ||
      inspected.mediaType !== expected.mediaType ||
      !equalHexDigest(sha256Hex(actual.bytes), expected.sha256)
    ) {
      fail('SNAPSHOT_DIGEST_MISMATCH');
    }
  }

  return Object.freeze({
    manifest,
    snapshotDigest: actualSnapshotDigest,
    archiveDigest: actualArchiveDigest,
    fileCount: manifest.totals.fileCount,
    expandedBytes: manifest.totals.expandedBytes,
    compressedBytes: input.archiveBytes.byteLength,
  });
}

export type VerifyEncryptedSnapshotInput = Readonly<{
  manifestBytes: Uint8Array;
  encryptedObjectBytes: Uint8Array;
  encryptionEnvelope: SnapshotArchiveEnvelope;
  dataEncryptionKey: Uint8Array;
}>;

export function decryptAndVerifySnapshot(
  input: VerifyEncryptedSnapshotInput,
): VerifiedSnapshotArchive {
  const envelope = SnapshotArchiveEnvelopeSchema.safeParse(input.encryptionEnvelope);
  if (!envelope.success) fail('SNAPSHOT_ENCRYPTION_INVALID');
  const archiveBytes = decryptSnapshotArchive(
    input.encryptedObjectBytes,
    envelope.data,
    input.dataEncryptionKey,
  );
  return verifySnapshotArchive({
    manifestBytes: input.manifestBytes,
    archiveBytes,
    expectedSnapshotDigest: envelope.data.aad.snapshotDigest,
    expectedArchiveDigest: envelope.data.aad.archiveDigest,
  });
}
