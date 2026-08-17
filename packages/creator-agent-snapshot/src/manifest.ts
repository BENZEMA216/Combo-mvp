import {
  SNAPSHOT_PROTOCOL,
  SnapshotManifestSchema,
  canonicalizeJson as protocolCanonicalizeJson,
  parseJsonNoDuplicateKeys,
  snapshotDigest as protocolSnapshotDigest,
  type SnapshotFile as ProtocolSnapshotFile,
  type SnapshotManifest as ProtocolSnapshotManifest,
} from '@cb/creator-agent-protocol';
import { TextDecoder } from 'node:util';

import { SHA256_HEX_PATTERN } from './digest.js';
import { fail } from './errors.js';
import { SnapshotPathRegistry, utf8ByteCompare } from './path-policy.js';
import { ALPHA_SNAPSHOT_POLICY, SNAPSHOT_MANIFEST_MAX_BYTES } from './policy.js';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export type SnapshotManifestFile = ProtocolSnapshotFile;
export type SnapshotManifest = ProtocolSnapshotManifest;

const PATH_POLICY = Object.freeze({
  encoding: 'utf-8' as const,
  normalization: 'NFC' as const,
  ordering: 'utf-8-byte-order' as const,
  collision: 'nfc-plus-unicode-lowercase' as const,
});

const ARCHIVE_POLICY = Object.freeze({
  format: 'pax' as const,
  tarImplementation: 'combo-ustar-pax/1' as const,
  directoryEntries: 'omitted' as const,
  zstdImplementation: 'node-zlib-zstd@1.5.7' as const,
  zstdLevel: 9 as const,
  zstdChecksum: true as const,
  zstdContentSize: true as const,
  zstdDictionaryId: false as const,
  zstdWorkers: 0 as const,
  uid: 0 as const,
  gid: 0 as const,
  uname: '' as const,
  gname: '' as const,
  mtimeUnixSeconds: 0 as const,
  fileMode: '0444' as const,
});

function assertNonNegativeSafeInteger(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail('SNAPSHOT_ARCHIVE_INVALID');
}

function freezeManifest(manifest: SnapshotManifest): SnapshotManifest {
  return Object.freeze({
    ...manifest,
    pathPolicy: Object.freeze({ ...manifest.pathPolicy }),
    archive: Object.freeze({ ...manifest.archive }),
    files: Object.freeze(manifest.files.map((file) => Object.freeze({ ...file }))),
    totals: Object.freeze({ ...manifest.totals }),
  }) as SnapshotManifest;
}

export function validateSnapshotManifestFiles(files: readonly SnapshotManifestFile[]): {
  fileCount: number;
  expandedBytes: number;
} {
  if (files.length === 0) fail('SNAPSHOT_EMPTY');
  if (files.length > ALPHA_SNAPSHOT_POLICY.maxFileCount) fail('SNAPSHOT_TOO_MANY_FILES');

  const paths = new SnapshotPathRegistry();
  let expandedBytes = 0;
  let previousPath: string | undefined;
  for (const file of files) {
    const canonicalPath = paths.add(file.path);
    if (canonicalPath !== file.path) fail('SNAPSHOT_ARCHIVE_INVALID');
    if (previousPath !== undefined && utf8ByteCompare(previousPath, file.path) >= 0) {
      fail('SNAPSHOT_ARCHIVE_INVALID');
    }
    previousPath = file.path;

    assertNonNegativeSafeInteger(file.size);
    if (file.size > ALPHA_SNAPSHOT_POLICY.maxFileBytes) fail('SNAPSHOT_FILE_TOO_LARGE');
    expandedBytes += file.size;
    if (!Number.isSafeInteger(expandedBytes)) fail('SNAPSHOT_EXPANDED_TOO_LARGE');
    if (expandedBytes > ALPHA_SNAPSHOT_POLICY.maxExpandedBytes) {
      fail('SNAPSHOT_EXPANDED_TOO_LARGE');
    }
    if (!SHA256_HEX_PATTERN.test(file.sha256)) fail('SNAPSHOT_ARCHIVE_INVALID');
    if (
      typeof file.mediaType !== 'string' ||
      file.mediaType.length === 0 ||
      Buffer.byteLength(file.mediaType, 'utf8') > 128
    ) {
      fail('SNAPSHOT_ARCHIVE_INVALID');
    }
  }
  return { fileCount: files.length, expandedBytes };
}

export function createSnapshotManifest(
  inputFiles: readonly SnapshotManifestFile[],
): SnapshotManifest {
  const files = inputFiles
    .map((file) => ({ ...file }))
    .sort((left, right) => utf8ByteCompare(left.path, right.path));
  const totals = validateSnapshotManifestFiles(files);
  try {
    return freezeManifest(
      SnapshotManifestSchema.parse({
        protocol: SNAPSHOT_PROTOCOL,
        schemaVersion: 1,
        pathPolicy: PATH_POLICY,
        archive: ARCHIVE_POLICY,
        files,
        totals,
      }),
    );
  } catch (error) {
    fail('SNAPSHOT_ARCHIVE_INVALID', error);
  }
}

export function snapshotManifestBytes(manifest: SnapshotManifest): Buffer {
  try {
    const parsed = SnapshotManifestSchema.parse(manifest);
    return Buffer.from(protocolCanonicalizeJson(parsed), 'utf8');
  } catch (error) {
    fail('SNAPSHOT_ARCHIVE_INVALID', error);
  }
}

export function snapshotDigest(manifest: SnapshotManifest): string {
  try {
    return protocolSnapshotDigest(SnapshotManifestSchema.parse(manifest));
  } catch (error) {
    fail('SNAPSHOT_ARCHIVE_INVALID', error);
  }
}

export function parseSnapshotManifest(bytes: Uint8Array): SnapshotManifest {
  if (bytes.byteLength === 0 || bytes.byteLength > SNAPSHOT_MANIFEST_MAX_BYTES) {
    fail('SNAPSHOT_ARCHIVE_INVALID');
  }
  let text: string;
  let parsed: unknown;
  try {
    text = decoder.decode(bytes);
    parsed = parseJsonNoDuplicateKeys(text);
  } catch {
    fail('SNAPSHOT_ARCHIVE_INVALID');
  }

  let manifest: SnapshotManifest;
  try {
    manifest = SnapshotManifestSchema.parse(parsed);
    if (protocolCanonicalizeJson(manifest) !== text) fail('SNAPSHOT_ARCHIVE_INVALID');
  } catch {
    fail('SNAPSHOT_ARCHIVE_INVALID');
  }
  validateSnapshotManifestFiles(manifest.files);
  return freezeManifest(manifest);
}
