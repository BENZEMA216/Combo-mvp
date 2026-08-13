import { z } from 'zod';
import { canonicalSha256 } from './canonical.js';
import { containsForbiddenControl, Sha256HexSchema } from './primitives.js';

export const SNAPSHOT_PROTOCOL = 'combo.snapshot-manifest/1' as const;
export const SNAPSHOT_MAX_FILES = 2_000;
export const SNAPSHOT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const SNAPSHOT_MAX_EXPANDED_BYTES = 200 * 1024 * 1024;
export const SNAPSHOT_MAX_COMPRESSED_BYTES = 50 * 1024 * 1024;
export const SNAPSHOT_MAX_PATH_BYTES = 512;
export const SNAPSHOT_MAX_COMPRESSION_RATIO = 100;

const FORBIDDEN_SEGMENTS = new Set([
  '.git',
  '.gitmodules',
  '.ssh',
  '.codex',
  '.aws',
  'node_modules',
  '__macosx',
  '.ds_store',
  'thumbs.db',
]);

export const SnapshotPathSchema = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= SNAPSHOT_MAX_PATH_BYTES, {
    message: `路径不得超过 ${SNAPSHOT_MAX_PATH_BYTES} UTF-8 bytes`,
  })
  .refine((value) => value.normalize('NFC') === value, '路径必须先做 NFC normalization')
  .refine((value) => !value.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(value), '拒绝绝对路径')
  .refine((value) => !value.includes('\\'), 'manifest 路径只允许 / 分隔符')
  .refine((value) => !containsForbiddenControl(value), '拒绝 C0/C1 控制字符')
  .refine(
    (value) =>
      value
        .split('/')
        .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
    '路径段不能为空、. 或 ..',
  )
  .refine((value) => {
    const segments = value.split('/');
    return !segments.some((segment) => {
      const folded = segment.toLowerCase();
      return FORBIDDEN_SEGMENTS.has(folded) || folded.startsWith('.env');
    });
  }, '路径属于 Alpha 禁止发布目录或文件');

export const SnapshotFileSchema = z
  .object({
    path: SnapshotPathSchema,
    size: z.number().int().min(0).max(SNAPSHOT_MAX_FILE_BYTES),
    mediaType: z
      .string()
      .regex(
        /^(?:text\/[a-z0-9.+-]+|application\/(?:json|csv|javascript|xml|yaml|toml))(?:; charset=utf-8)?$/u,
      ),
    sha256: Sha256HexSchema,
  })
  .strict();
export type SnapshotFile = z.infer<typeof SnapshotFileSchema>;

export const SnapshotManifestSchema = z
  .object({
    protocol: z.literal(SNAPSHOT_PROTOCOL),
    schemaVersion: z.literal(1),
    pathPolicy: z
      .object({
        encoding: z.literal('utf-8'),
        normalization: z.literal('NFC'),
        ordering: z.literal('utf-8-byte-order'),
        collision: z.literal('nfc-plus-unicode-lowercase'),
      })
      .strict(),
    archive: z
      .object({
        format: z.literal('pax'),
        tarImplementation: z.literal('combo-ustar-pax/1'),
        directoryEntries: z.literal('omitted'),
        zstdImplementation: z.literal('node-zlib-zstd@1.5.7'),
        zstdLevel: z.literal(9),
        zstdChecksum: z.literal(true),
        zstdContentSize: z.literal(true),
        zstdDictionaryId: z.literal(false),
        zstdWorkers: z.literal(0),
        uid: z.literal(0),
        gid: z.literal(0),
        uname: z.literal(''),
        gname: z.literal(''),
        mtimeUnixSeconds: z.literal(0),
        fileMode: z.literal('0444'),
      })
      .strict(),
    files: z.array(SnapshotFileSchema).min(1).max(SNAPSHOT_MAX_FILES),
    totals: z
      .object({
        fileCount: z.number().int().min(1).max(SNAPSHOT_MAX_FILES),
        expandedBytes: z.number().int().min(0).max(SNAPSHOT_MAX_EXPANDED_BYTES),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const paths = new Set<string>();
    const foldedPaths = new Set<string>();
    let previous: Buffer | undefined;
    let expandedBytes = 0;

    for (const [index, file] of manifest.files.entries()) {
      const bytes = Buffer.from(file.path, 'utf8');
      if (previous && Buffer.compare(previous, bytes) >= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['files', index, 'path'],
          message: 'files 必须按 UTF-8 byte order 严格递增',
        });
      }
      previous = bytes;
      if (paths.has(file.path)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['files', index, 'path'],
          message: '路径重复',
        });
      }
      paths.add(file.path);

      const folded = file.path.toLowerCase();
      if (foldedPaths.has(folded)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['files', index, 'path'],
          message: '路径在冻结的 case-fold 策略下冲突',
        });
      }
      foldedPaths.add(folded);
      expandedBytes += file.size;
    }

    if (manifest.totals.fileCount !== manifest.files.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totals', 'fileCount'],
        message: 'fileCount 必须等于 files 数量',
      });
    }
    if (manifest.totals.expandedBytes !== expandedBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totals', 'expandedBytes'],
        message: 'expandedBytes 必须等于文件 size 之和',
      });
    }
  });
export type SnapshotManifest = z.infer<typeof SnapshotManifestSchema>;

export function snapshotDigest(manifest: SnapshotManifest): string {
  return canonicalSha256(SnapshotManifestSchema.parse(manifest));
}

export function isCompressionRatioAllowed(compressedBytes: number, expandedBytes: number): boolean {
  if (!Number.isSafeInteger(compressedBytes) || !Number.isSafeInteger(expandedBytes)) return false;
  if (compressedBytes <= 0 || compressedBytes > SNAPSHOT_MAX_COMPRESSED_BYTES) return false;
  if (expandedBytes < 0 || expandedBytes > SNAPSHOT_MAX_EXPANDED_BYTES) return false;
  return expandedBytes / compressedBytes <= SNAPSHOT_MAX_COMPRESSION_RATIO;
}
