import { z } from 'zod';

export const SNAPSHOT_COMPRESSION_RATIO_BOUNDARY_CORPUS =
  'combo.snapshot-compression-ratio-boundaries/1' as const;

const NumericProbeDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

const MechanismVectorDigestSchema = z
  .object({
    content: NumericProbeDigestSchema,
    manifest: NumericProbeDigestSchema,
    snapshot: NumericProbeDigestSchema,
    tar: NumericProbeDigestSchema,
    archive: NumericProbeDigestSchema,
  })
  .strict();

const AcceptedMechanismVectorSchema = z
  .object({
    id: z.literal('accepted-counter-hex'),
    expected: z.literal('accepted'),
    filePath: z.literal('ratio-accepted.txt'),
    contentBytes: z.literal(1_048_576),
    manifestBytes: z.literal(720),
    tarBytes: z.literal(1_050_112),
    archiveBytes: z.literal(557_990),
    ratioNumerator: z.literal(1_048_576),
    ratioDenominator: z.literal(557_990),
    ratioDecimal: z.literal('1.8792021362390008'),
    digests: MechanismVectorDigestSchema.extend({
      content: z.literal('sha256:87fa9e7bc1ebd053bac7930a65c21f9cfa5e21eade2a878ddff0c7f4d71a8230'),
      manifest: z.literal(
        'sha256:ef94bbb51e6fa4d16179c6ab4730e112c3f0d6673b61c88dfdc26943a0bc8227',
      ),
      snapshot: z.literal(
        'sha256:ef94bbb51e6fa4d16179c6ab4730e112c3f0d6673b61c88dfdc26943a0bc8227',
      ),
      tar: z.literal('sha256:a57a33255228551cae882a5449450d40f4f921d4a97f58fe064478d9a7ffedc0'),
      archive: z.literal('sha256:72ba9ad10435bdda55f10ca5779fb8eab473463ded5be053e0150f19dc9a70c4'),
    }),
    canonicalArchiveRoundTrip: z.literal(true),
    fullVerify: z.literal('accepted'),
  })
  .strict();

const BombMechanismVectorSchema = z
  .object({
    id: z.literal('bomb-ascii-a'),
    expected: z.literal('rejected'),
    expectedError: z.literal('SNAPSHOT_COMPRESSION_RATIO_EXCEEDED'),
    filePath: z.literal('ratio-bomb.txt'),
    contentBytes: z.literal(1_048_576),
    manifestBytes: z.literal(716),
    tarBytes: z.literal(1_050_112),
    archiveBytes: z.literal(128),
    ratioNumerator: z.literal(1_048_576),
    ratioDenominator: z.literal(128),
    ratioDecimal: z.literal('8192'),
    digests: MechanismVectorDigestSchema.extend({
      content: z.literal('sha256:9bc1b2a288b26af7257a36277ae3816a7d4f16e89c1e7e77d0a5c48bad62b360'),
      manifest: z.literal(
        'sha256:2dbbda349ad67c2ce972883d4c0358597d6d1c5891b75965273a7b52bd8b92e0',
      ),
      snapshot: z.literal(
        'sha256:2dbbda349ad67c2ce972883d4c0358597d6d1c5891b75965273a7b52bd8b92e0',
      ),
      tar: z.literal('sha256:913acc574979fc891caf86fd71a24689c599a844e3f983cb719dde12f4e92651'),
      archive: z.literal('sha256:9107b77bd4cc889cd6a6b30f469cd0b3145e0e6c0f7fbc5dbea97e3ef12d6890'),
    }),
    canonicalArchiveRoundTrip: z.literal(true),
    fullVerify: z.literal('rejected-before-verified'),
  })
  .strict();

/**
 * Additive SCH-004 evidence for ADR-VNEXT-003's cross-field compression-ratio
 * policy. It is deliberately distinct from SNP-008's real 50 MiB archive gate.
 */
export const SnapshotCompressionRatioBoundaryCorpusSchema = z
  .object({
    protocol: z.literal(SNAPSHOT_COMPRESSION_RATIO_BOUNDARY_CORPUS),
    schemaVersion: z.literal(1),
    scope: z.literal('snapshot-expanded-to-compressed-ratio-only'),
    evidenceClass: z.literal('local-deterministic-only'),
    authority: z
      .object({
        technicalPlanSection: z.literal('技术方案 §5.2 Alpha 输入边界'),
        testPlanSection: z.literal('测试方案 §8.3 危险文件与路径'),
        decisionRegistryId: z.literal('ADR-VNEXT-003'),
        additiveRegistryCaseId: z.literal('SCH-004'),
      })
      .strict(),
    generatorRuntime: z
      .object({
        observedPlatform: z.literal('darwin-arm64'),
        nodeVersion: z.literal('v25.6.1'),
        zstdVersion: z.literal('1.5.7'),
        tarImplementation: z.literal('combo-ustar-pax/1'),
        zstdLevel: z.literal(9),
        zstdChecksum: z.literal(true),
        zstdContentSize: z.literal(true),
        zstdDictionaryId: z.literal(false),
        zstdWorkers: z.literal(0),
      })
      .strict(),
    numericBoundary: z
      .object({
        comparison: z.literal('expandedBytes <= compressedBytes * maximumRatio'),
        maximumRatio: z.literal(100),
        probes: z.tuple([
          z
            .object({
              ratio: z.literal(99),
              compressedBytes: z.literal(1),
              expandedBytes: z.literal(99),
              expected: z.literal('accepted'),
              canonicalInputDigest: z.literal(
                'sha256:a92698072412c7c19618bff315cbf61de85378baa7c49913acc78dad33091f90',
              ),
            })
            .strict(),
          z
            .object({
              ratio: z.literal(100),
              compressedBytes: z.literal(1),
              expandedBytes: z.literal(100),
              expected: z.literal('accepted'),
              canonicalInputDigest: z.literal(
                'sha256:87d65f0287b8a0dc00219fc0cfc2a4c2ef6185ab7b84cb3471255621a79b7f18',
              ),
            })
            .strict(),
          z
            .object({
              ratio: z.literal(101),
              compressedBytes: z.literal(1),
              expandedBytes: z.literal(101),
              expected: z.literal('rejected'),
              canonicalInputDigest: z.literal(
                'sha256:dc824361af537441ea7f2d71d51c117678106f5c0a342e51f23f191bf22cf430',
              ),
            })
            .strict(),
        ]),
      })
      .strict(),
    mechanism: z
      .object({
        mediaType: z.literal('text/plain; charset=utf-8'),
        acceptedRecipe: z
          .object({
            algorithm: z.literal('sha256-counter-lowercase-hex/1'),
            seedUtf8: z.literal('combo:snapshot-compression-ratio:accepted:v1'),
            counterEncoding: z.literal('uint32be'),
            digestEncoding: z.literal('lowercase-hex'),
            contentBytes: z.literal(1_048_576),
          })
          .strict(),
        bombRecipe: z
          .object({
            algorithm: z.literal('ascii-byte-repeat/1'),
            byteHex: z.literal('61'),
            character: z.literal('a'),
            contentBytes: z.literal(1_048_576),
          })
          .strict(),
        vectors: z.tuple([AcceptedMechanismVectorSchema, BombMechanismVectorSchema]),
      })
      .strict(),
    productionOwners: z.tuple([
      z.literal('isCompressionRatioAllowed'),
      z.literal('assertCompressedArchiveLimits'),
      z.literal('verifySnapshotArchive'),
      z.literal('S3ImmutableSnapshotObjectStore.finalizeUpload'),
    ]),
    exclusions: z.tuple([
      z.literal('accepted-real-vector-is-not-an-exact-100-to-1-archive'),
      z.literal('does-not-cover-SNP-008-real-50MiB-compressed-boundary'),
      z.literal('does-not-observe-decompressor-call-count'),
      z.literal('does-not-prove-T0-LINUX-CI-or-formal-E1'),
      z.literal('does-not-prove-E2-MinIO-PostgreSQL-or-cloud-state'),
      z.literal('generated-large-bytes-are-not-committed'),
    ]),
  })
  .strict();

export type SnapshotCompressionRatioBoundaryCorpus = z.infer<
  typeof SnapshotCompressionRatioBoundaryCorpusSchema
>;
