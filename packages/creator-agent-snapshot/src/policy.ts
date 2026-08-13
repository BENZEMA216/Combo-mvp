import {
  SNAPSHOT_MAX_COMPRESSED_BYTES,
  SNAPSHOT_MAX_COMPRESSION_RATIO,
  SNAPSHOT_MAX_EXPANDED_BYTES,
  SNAPSHOT_MAX_FILE_BYTES,
  SNAPSHOT_MAX_FILES,
  SNAPSHOT_MAX_PATH_BYTES,
} from '@cb/creator-agent-protocol';

export type SnapshotPolicy = Readonly<{
  maxFileCount: number;
  maxFileBytes: number;
  maxExpandedBytes: number;
  maxCompressedBytes: number;
  maxPathUtf8Bytes: number;
  maxCompressionRatio: number;
}>;

export const ALPHA_SNAPSHOT_POLICY: SnapshotPolicy = Object.freeze({
  maxFileCount: SNAPSHOT_MAX_FILES,
  maxFileBytes: SNAPSHOT_MAX_FILE_BYTES,
  maxExpandedBytes: SNAPSHOT_MAX_EXPANDED_BYTES,
  maxCompressedBytes: SNAPSHOT_MAX_COMPRESSED_BYTES,
  maxPathUtf8Bytes: SNAPSHOT_MAX_PATH_BYTES,
  maxCompressionRatio: SNAPSHOT_MAX_COMPRESSION_RATIO,
});

export const SNAPSHOT_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

// tar header、PAX header、每个文件的 511-byte padding 和结束块都不属于 expanded file bytes。
export const MAX_DECOMPRESSED_TAR_BYTES =
  ALPHA_SNAPSHOT_POLICY.maxExpandedBytes + ALPHA_SNAPSHOT_POLICY.maxFileCount * 2_048 + 1024 * 1024;

export const DETERMINISTIC_ZSTD_LEVEL = 9;
export const DETERMINISTIC_TAR_FORMAT = 'combo-ustar-pax/1' as const;
export const REQUIRED_ZSTD_VERSION = '1.5.7' as const;
