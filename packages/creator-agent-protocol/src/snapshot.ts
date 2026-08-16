import { z } from 'zod';
import { canonicalSha256, canonicalizeJson, sha256Hex } from './canonical.js';
import {
  CanonicalBase64UrlBytesSchema,
  containsForbiddenControl,
  Sha256HexSchema,
  UTF8_TEXT_SCHEMA_DESCRIPTION_PREFIX,
  UuidSchema,
} from './primitives.js';

export const SNAPSHOT_PROTOCOL = 'combo.snapshot-manifest/1' as const;
export const SNAPSHOT_ENVELOPE_PROTOCOL = 'combo.snapshot-envelope/1' as const;
export const SNAPSHOT_ARCHIVE_OBJECT_FORMAT = 'combo.snapshot-binary/1' as const;
export const SNAPSHOT_ARCHIVE_OBJECT_MAGIC = 'CSNPENC1' as const;
export const SNAPSHOT_MANIFEST_ENVELOPE_PROTOCOL = 'combo.snapshot-manifest-envelope/1' as const;
export const SNAPSHOT_MANIFEST_OBJECT_FORMAT = 'combo.snapshot-manifest-binary/1' as const;
export const SNAPSHOT_MANIFEST_OBJECT_MAGIC = 'CSNPMAN1' as const;
export const SNAPSHOT_OBJECT_STORAGE_PROTOCOL = 'combo.snapshot-object-storage/1' as const;
export const SNAPSHOT_PUBLICATION_PREPARATION_PROTOCOL =
  'combo.snapshot-publication-preparation/1' as const;
export const SNAPSHOT_PUBLICATION_COMMIT_PROTOCOL = 'combo.snapshot-publication-commit/1' as const;
export const SNAPSHOT_MAX_PUBLICATION_MARKER_BYTES = 16 * 1024;
export const SNAPSHOT_MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
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

export function snapshotArchiveObjectKey(creatorId: string, snapshotDigest: string): string {
  const creator = UuidSchema.parse(creatorId);
  const digest = Sha256HexSchema.parse(snapshotDigest);
  return `creators/${creator}/snapshots/sha256/${digest.slice(0, 2)}/${digest}.tar.zst.enc`;
}

export function snapshotManifestObjectKey(creatorId: string, snapshotDigest: string): string {
  const creator = UuidSchema.parse(creatorId);
  const digest = Sha256HexSchema.parse(snapshotDigest);
  return `creators/${creator}/manifests/sha256/${digest.slice(0, 2)}/${digest}.json.enc`;
}

export function snapshotPublicationPreparationObjectKey(
  creatorId: string,
  snapshotDigest: string,
): string {
  const creator = UuidSchema.parse(creatorId);
  const digest = Sha256HexSchema.parse(snapshotDigest);
  return `creators/${creator}/publications/sha256/${digest.slice(0, 2)}/${digest}.prepare.json`;
}

export function snapshotPublicationCommitObjectKey(
  creatorId: string,
  snapshotDigest: string,
): string {
  const creator = UuidSchema.parse(creatorId);
  const digest = Sha256HexSchema.parse(snapshotDigest);
  return `creators/${creator}/publications/sha256/${digest.slice(0, 2)}/${digest}.commit.json`;
}

export const SnapshotArchiveEnvelopeAadSchema = z
  .object({
    protocol: z.literal(SNAPSHOT_ENVELOPE_PROTOCOL),
    schemaVersion: z.literal(1),
    cipherObjectFormat: z.literal(SNAPSHOT_ARCHIVE_OBJECT_FORMAT),
    creatorId: UuidSchema,
    snapshotDigest: Sha256HexSchema,
    archiveDigest: Sha256HexSchema,
    objectKey: z.string().min(1).max(512),
    plaintextBytes: z.number().int().min(1).max(SNAPSHOT_MAX_COMPRESSED_BYTES),
    keyId: z.string().regex(/^[a-z0-9][a-z0-9._:/-]{0,255}$/u),
  })
  .strict()
  .superRefine((aad, context) => {
    if (aad.objectKey !== snapshotArchiveObjectKey(aad.creatorId, aad.snapshotDigest)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['objectKey'],
        message: 'objectKey 必须由 creatorId 和 snapshotDigest 精确派生',
      });
    }
  });
export type SnapshotArchiveEnvelopeAad = z.infer<typeof SnapshotArchiveEnvelopeAadSchema>;

export function snapshotArchiveEnvelopeAadBytes(aad: SnapshotArchiveEnvelopeAad): Buffer {
  return Buffer.from(canonicalizeJson(SnapshotArchiveEnvelopeAadSchema.parse(aad)), 'utf8');
}

export function snapshotArchiveEnvelopeAadDigest(aad: SnapshotArchiveEnvelopeAad): string {
  return canonicalSha256(SnapshotArchiveEnvelopeAadSchema.parse(aad));
}

export const SnapshotArchiveEnvelopeSchema = z
  .object({
    protocol: z.literal(SNAPSHOT_ENVELOPE_PROTOCOL),
    schemaVersion: z.literal(1),
    cipherObjectFormat: z.literal(SNAPSHOT_ARCHIVE_OBJECT_FORMAT),
    algorithm: z.literal('aes-256-gcm/v1'),
    keyWrapAlgorithm: z.literal('rfc3394-aes-256-kw/v1'),
    aad: SnapshotArchiveEnvelopeAadSchema,
    aadDigest: Sha256HexSchema,
    nonce: CanonicalBase64UrlBytesSchema(12, 12),
    authTag: CanonicalBase64UrlBytesSchema(16, 16),
    wrappedDek: CanonicalBase64UrlBytesSchema(40, 40),
    cipherDigest: Sha256HexSchema,
    cipherBytes: z
      .number()
      .int()
      .min(37)
      .max(SNAPSHOT_MAX_COMPRESSED_BYTES + 36),
  })
  .strict()
  .superRefine((envelope, context) => {
    if (envelope.aadDigest !== canonicalSha256(envelope.aad)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aadDigest'],
        message: 'aadDigest 必须绑定 exact Snapshot archive AAD',
      });
    }
    if (envelope.cipherObjectFormat !== envelope.aad.cipherObjectFormat) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aad', 'cipherObjectFormat'],
        message: 'cipherObjectFormat 必须受 AAD 绑定',
      });
    }
    if (envelope.cipherBytes !== envelope.aad.plaintextBytes + 36) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cipherBytes'],
        message: 'cipherBytes 必须等于 plaintextBytes + 8-byte magic + 12-byte nonce + 16-byte tag',
      });
    }
  });
export type SnapshotArchiveEnvelope = z.infer<typeof SnapshotArchiveEnvelopeSchema>;

export function parseSnapshotArchiveCipherObject(
  envelopeInput: SnapshotArchiveEnvelope,
  objectBytesInput: Uint8Array,
): SnapshotArchiveEnvelope {
  const envelope = SnapshotArchiveEnvelopeSchema.parse(envelopeInput);
  if (!(objectBytesInput instanceof Uint8Array)) {
    throw new TypeError('Snapshot cipher object 必须是 bytes');
  }
  const object = Buffer.from(objectBytesInput);
  const nonce = Buffer.from(envelope.nonce, 'base64url');
  const tag = Buffer.from(envelope.authTag, 'base64url');
  const tagStart = object.byteLength - tag.byteLength;
  if (
    object.byteLength !== envelope.cipherBytes ||
    object.byteLength !== envelope.aad.plaintextBytes + 36 ||
    sha256Hex(object) !== envelope.cipherDigest ||
    object.subarray(0, 8).toString('ascii') !== SNAPSHOT_ARCHIVE_OBJECT_MAGIC ||
    !object.subarray(8, 20).equals(nonce) ||
    tagStart !== 20 + envelope.aad.plaintextBytes ||
    !object.subarray(tagStart).equals(tag)
  ) {
    throw new TypeError('Snapshot cipher object 与 Envelope 不匹配');
  }
  return envelope;
}

export const SnapshotManifestEnvelopeAadSchema = z
  .object({
    protocol: z.literal(SNAPSHOT_MANIFEST_ENVELOPE_PROTOCOL),
    schemaVersion: z.literal(1),
    cipherObjectFormat: z.literal(SNAPSHOT_MANIFEST_OBJECT_FORMAT),
    creatorId: UuidSchema,
    snapshotDigest: Sha256HexSchema,
    objectKey: z.string().min(1).max(512),
    plaintextBytes: z.number().int().min(1).max(SNAPSHOT_MAX_MANIFEST_BYTES),
    keyId: z.string().regex(/^[a-z0-9][a-z0-9._:/-]{0,255}$/u),
  })
  .strict()
  .superRefine((aad, context) => {
    if (aad.objectKey !== snapshotManifestObjectKey(aad.creatorId, aad.snapshotDigest)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['objectKey'],
        message: 'manifest objectKey 必须由 creatorId 和 snapshotDigest 精确派生',
      });
    }
  });
export type SnapshotManifestEnvelopeAad = z.infer<typeof SnapshotManifestEnvelopeAadSchema>;

export function snapshotManifestEnvelopeAadBytes(aad: SnapshotManifestEnvelopeAad): Buffer {
  return Buffer.from(canonicalizeJson(SnapshotManifestEnvelopeAadSchema.parse(aad)), 'utf8');
}

export function snapshotManifestEnvelopeAadDigest(aad: SnapshotManifestEnvelopeAad): string {
  return canonicalSha256(SnapshotManifestEnvelopeAadSchema.parse(aad));
}

export const SnapshotManifestEnvelopeSchema = z
  .object({
    protocol: z.literal(SNAPSHOT_MANIFEST_ENVELOPE_PROTOCOL),
    schemaVersion: z.literal(1),
    cipherObjectFormat: z.literal(SNAPSHOT_MANIFEST_OBJECT_FORMAT),
    algorithm: z.literal('aes-256-gcm/v1'),
    keyWrapAlgorithm: z.literal('rfc3394-aes-256-kw/v1'),
    aad: SnapshotManifestEnvelopeAadSchema,
    aadDigest: Sha256HexSchema,
    nonce: CanonicalBase64UrlBytesSchema(12, 12),
    authTag: CanonicalBase64UrlBytesSchema(16, 16),
    wrappedDek: CanonicalBase64UrlBytesSchema(40, 40),
    cipherDigest: Sha256HexSchema,
    cipherBytes: z
      .number()
      .int()
      .min(37)
      .max(SNAPSHOT_MAX_MANIFEST_BYTES + 36),
  })
  .strict()
  .superRefine((envelope, context) => {
    if (envelope.aadDigest !== canonicalSha256(envelope.aad)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aadDigest'],
        message: 'aadDigest 必须绑定 exact Snapshot manifest AAD',
      });
    }
    if (envelope.cipherObjectFormat !== envelope.aad.cipherObjectFormat) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aad', 'cipherObjectFormat'],
        message: 'cipherObjectFormat 必须受 AAD 绑定',
      });
    }
    if (envelope.cipherBytes !== envelope.aad.plaintextBytes + 36) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cipherBytes'],
        message: 'cipherBytes 必须等于 plaintextBytes + 8-byte magic + 12-byte nonce + 16-byte tag',
      });
    }
  });
export type SnapshotManifestEnvelope = z.infer<typeof SnapshotManifestEnvelopeSchema>;

export function parseSnapshotManifestCipherObject(
  envelopeInput: SnapshotManifestEnvelope,
  objectBytesInput: Uint8Array,
): SnapshotManifestEnvelope {
  const envelope = SnapshotManifestEnvelopeSchema.parse(envelopeInput);
  if (!(objectBytesInput instanceof Uint8Array)) {
    throw new TypeError('Snapshot manifest cipher object 必须是 bytes');
  }
  const object = Buffer.from(objectBytesInput);
  const nonce = Buffer.from(envelope.nonce, 'base64url');
  const tag = Buffer.from(envelope.authTag, 'base64url');
  const tagStart = object.byteLength - tag.byteLength;
  if (
    object.byteLength !== envelope.cipherBytes ||
    object.byteLength !== envelope.aad.plaintextBytes + 36 ||
    sha256Hex(object) !== envelope.cipherDigest ||
    object.subarray(0, 8).toString('ascii') !== SNAPSHOT_MANIFEST_OBJECT_MAGIC ||
    !object.subarray(8, 20).equals(nonce) ||
    tagStart !== 20 + envelope.aad.plaintextBytes ||
    !object.subarray(tagStart).equals(tag)
  ) {
    throw new TypeError('Snapshot manifest cipher object 与 Envelope 不匹配');
  }
  return envelope;
}

export const SnapshotPathSchema = z
  .string()
  .min(1)
  .max(SNAPSHOT_MAX_PATH_BYTES)
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
  }, '路径属于 Alpha 禁止发布目录或文件')
  .describe(`${UTF8_TEXT_SCHEMA_DESCRIPTION_PREFIX}${SNAPSHOT_MAX_PATH_BYTES}`);

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
