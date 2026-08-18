import {
  SNAPSHOT_MAX_COMPRESSED_BYTES,
  SNAPSHOT_MAX_COMPRESSION_RATIO,
  SNAPSHOT_MAX_EXPANDED_BYTES,
  SNAPSHOT_MAX_FILE_BYTES,
  SNAPSHOT_MAX_FILES,
  SNAPSHOT_MAX_CANONICAL_MANIFEST_BYTES,
  SNAPSHOT_MAX_MEDIA_TYPE_BYTES,
  SNAPSHOT_MAX_MANIFEST_BYTES,
  SNAPSHOT_MAX_PATH_BYTES,
} from '@cb/creator-agent-protocol';

export type SnapshotPolicy = Readonly<{
  maxFileCount: number;
  maxFileBytes: number;
  maxExpandedBytes: number;
  maxCompressedBytes: number;
  maxPathUtf8Bytes: number;
  maxMediaTypeBytes: number;
  maxCompressionRatio: number;
}>;

export const ALPHA_SNAPSHOT_POLICY: SnapshotPolicy = Object.freeze({
  maxFileCount: SNAPSHOT_MAX_FILES,
  maxFileBytes: SNAPSHOT_MAX_FILE_BYTES,
  maxExpandedBytes: SNAPSHOT_MAX_EXPANDED_BYTES,
  maxCompressedBytes: SNAPSHOT_MAX_COMPRESSED_BYTES,
  maxPathUtf8Bytes: SNAPSHOT_MAX_PATH_BYTES,
  maxMediaTypeBytes: SNAPSHOT_MAX_MEDIA_TYPE_BYTES,
  maxCompressionRatio: SNAPSHOT_MAX_COMPRESSION_RATIO,
});

/** Production JSON pre-parse ceiling: the exact reachable canonical semantic maximum. */
export const SNAPSHOT_MANIFEST_MAX_BYTES = SNAPSHOT_MAX_CANONICAL_MANIFEST_BYTES;
/** Encrypted-object/read-all defense ceiling retained separately from the semantic maximum. */
export const SNAPSHOT_MANIFEST_RAW_DEFENSE_MAX_BYTES = SNAPSHOT_MAX_MANIFEST_BYTES;

// tar header、PAX header、每个文件的 511-byte padding 和结束块都不属于 expanded file bytes。
export const MAX_DECOMPRESSED_TAR_BYTES =
  ALPHA_SNAPSHOT_POLICY.maxExpandedBytes + ALPHA_SNAPSHOT_POLICY.maxFileCount * 2_048 + 1024 * 1024;

export const DETERMINISTIC_ZSTD_LEVEL = 9;
// Non-semantic retry-only parameter for disambiguating a Node sync wrapper empty-frame alias.
// Ordinary archive bytes continue to come from Node's default output chunking.
export const ZSTD_SYNC_ALIAS_RETRY_OUTPUT_CHUNK_BYTES = 65_537;
export const DETERMINISTIC_TAR_FORMAT = 'combo-ustar-pax/1' as const;
export const REQUIRED_ZSTD_VERSION = '1.5.7' as const;
