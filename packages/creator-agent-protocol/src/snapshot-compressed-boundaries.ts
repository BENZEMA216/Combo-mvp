import { z } from 'zod';

import { Sha256DigestSchema } from './primitives.js';

export const SNAPSHOT_COMPRESSED_BOUNDARY_CORPUS =
  'combo.snapshot-compressed-boundaries/1' as const;

const ProbeDigestSchema = z
  .object({
    aad: Sha256DigestSchema,
    envelope: Sha256DigestSchema,
    request: Sha256DigestSchema,
    preparation: Sha256DigestSchema,
    target: Sha256DigestSchema,
    response: Sha256DigestSchema,
  })
  .strict();

const BoundaryProbeSchema = z
  .object({
    delta: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    expected: z.enum(['accepted', 'rejected']),
    plaintextBytes: z.number().int().positive(),
    cipherBytes: z.number().int().positive(),
    canonicalDigests: ProbeDigestSchema,
  })
  .strict();

const ArtifactConstraintSchema = z
  .object({
    artifact: z.enum(['contractSchemas', 'openApi']),
    owner: z.string().min(1).max(128),
    valueKind: z.enum(['plaintextBytes', 'cipherBytes']),
    jsonSchemaKeyword: z.literal('maximum'),
    artifactPointer: z.string().startsWith('/').max(2_048),
  })
  .strict();

/**
 * Additive SCH-004 evidence for the compressed archive's published numeric
 * owners. This corpus intentionally carries metadata-only probes: SNP-008's
 * real tar/zstd mechanism evidence remains a separate planned gate.
 */
export const SnapshotCompressedBoundaryCorpusSchema = z
  .object({
    protocol: z.literal(SNAPSHOT_COMPRESSED_BOUNDARY_CORPUS),
    schemaVersion: z.literal(1),
    scope: z.literal('snapshot-compressed-archive-bytes-only'),
    evidenceClass: z.literal('metadata-numeric-only'),
    authority: z
      .object({
        technicalPlanSection: z.literal('技术方案 §5.2 Alpha 输入边界'),
        testPlanCases: z.tuple([z.literal('SNP-008')]),
        decisionRegistryId: z.literal('ADR-VNEXT-003'),
        cipherOverheadDecisionId: z.literal('ADR-VNEXT-011'),
      })
      .strict(),
    checkedArtifactDigests: z
      .object({
        contractSchemas: z.literal(
          'sha256:ebbd5e475380de98a17e29f4ae2c0d6af3ad6ceaabc7e02bbc335eddc4ed24eb',
        ),
        openApi: z.literal(
          'sha256:4b7b30dd948c96a3d37e32670eec16970faca5154a4ff0a130b3d01b265d0fce',
        ),
      })
      .strict(),
    baseFixtures: z.tuple([
      z
        .object({
          kind: z.literal('archiveEnvelope'),
          path: z.literal('snapshot-envelope.v1.json'),
          digest: z.literal(
            'sha256:4beebe50ab28e454e3136c908feefb7df3fe97dc02e846882231614722a3dfe9',
          ),
        })
        .strict(),
      z
        .object({
          kind: z.literal('manifestEnvelope'),
          path: z.literal('snapshot-manifest-envelope.v1.json'),
          digest: z.literal(
            'sha256:5daaeaccbcabf1eac51dc06e467c8464b4b65b7fd12cfbaae0d450c1581940fd',
          ),
        })
        .strict(),
    ]),
    derivation: z
      .object({
        expandedBytes: z.literal('same-as-archive-plaintext-bytes'),
        fileCount: z.literal(1),
        selectedUploadId: z.literal('0198f00d-8000-7000-8000-000000000011'),
        archivePutUrl: z.literal('https://uploads.example.invalid/archive'),
        manifestPutUrl: z.literal('https://uploads.example.invalid/manifest'),
        expiresAt: z.literal('2026-08-13T08:15:00.000Z'),
      })
      .strict(),
    runtimeOwners: z.tuple([
      z.literal('SnapshotArchiveEnvelopeAadSchema'),
      z.literal('SnapshotArchiveEnvelopeSchema'),
      z.literal('SnapshotUploadCreateRequestSchema'),
      z.literal('SnapshotPublicationPreparationMarkerSchema'),
      z.literal('SnapshotArchiveSignedPutTargetSchema'),
      z.literal('SnapshotSignedPutTargetSchema'),
      z.literal('SnapshotUploadCreateResponseSchema'),
    ]),
    productionOwners: z.tuple([
      z.literal('isCompressionRatioAllowed'),
      z.literal('assertCompressedArchiveLimits'),
      z.literal('parseSnapshotPublicationPreparationMarker'),
      z.literal('S3ImmutableSnapshotObjectStore.createUploadSession'),
    ]),
    advertisedConstraints: z.tuple([
      ArtifactConstraintSchema.extend({
        artifact: z.literal('contractSchemas'),
        owner: z.literal('SnapshotArchiveEnvelopeAad'),
        valueKind: z.literal('plaintextBytes'),
        artifactPointer: z.literal(
          '/schemas/SnapshotArchiveEnvelopeAad/definitions/SnapshotArchiveEnvelopeAad/properties/plaintextBytes',
        ),
      }),
      ArtifactConstraintSchema.extend({
        artifact: z.literal('contractSchemas'),
        owner: z.literal('SnapshotArchiveEnvelope'),
        valueKind: z.literal('plaintextBytes'),
        artifactPointer: z.literal(
          '/schemas/SnapshotArchiveEnvelope/definitions/SnapshotArchiveEnvelope/properties/aad/properties/plaintextBytes',
        ),
      }),
      ArtifactConstraintSchema.extend({
        artifact: z.literal('contractSchemas'),
        owner: z.literal('SnapshotArchiveEnvelope'),
        valueKind: z.literal('cipherBytes'),
        artifactPointer: z.literal(
          '/schemas/SnapshotArchiveEnvelope/definitions/SnapshotArchiveEnvelope/properties/cipherBytes',
        ),
      }),
      ArtifactConstraintSchema.extend({
        artifact: z.literal('contractSchemas'),
        owner: z.literal('SnapshotUploadCreateRequest'),
        valueKind: z.literal('plaintextBytes'),
        artifactPointer: z.literal(
          '/schemas/SnapshotUploadCreateRequest/definitions/SnapshotUploadCreateRequest/properties/archive/properties/envelope/properties/aad/properties/plaintextBytes',
        ),
      }),
      ArtifactConstraintSchema.extend({
        artifact: z.literal('contractSchemas'),
        owner: z.literal('SnapshotUploadCreateRequest'),
        valueKind: z.literal('cipherBytes'),
        artifactPointer: z.literal(
          '/schemas/SnapshotUploadCreateRequest/definitions/SnapshotUploadCreateRequest/properties/archive/properties/envelope/properties/cipherBytes',
        ),
      }),
      ArtifactConstraintSchema.extend({
        artifact: z.literal('contractSchemas'),
        owner: z.literal('SnapshotPublicationPreparationMarker'),
        valueKind: z.literal('plaintextBytes'),
        artifactPointer: z.literal(
          '/schemas/SnapshotPublicationPreparationMarker/definitions/SnapshotPublicationPreparationMarker/properties/request/properties/archive/properties/envelope/properties/aad/properties/plaintextBytes',
        ),
      }),
      ArtifactConstraintSchema.extend({
        artifact: z.literal('contractSchemas'),
        owner: z.literal('SnapshotPublicationPreparationMarker'),
        valueKind: z.literal('cipherBytes'),
        artifactPointer: z.literal(
          '/schemas/SnapshotPublicationPreparationMarker/definitions/SnapshotPublicationPreparationMarker/properties/request/properties/archive/properties/envelope/properties/cipherBytes',
        ),
      }),
      ArtifactConstraintSchema.extend({
        artifact: z.literal('contractSchemas'),
        owner: z.literal('SnapshotUploadCreateResponse'),
        valueKind: z.literal('cipherBytes'),
        artifactPointer: z.literal(
          '/schemas/SnapshotUploadCreateResponse/definitions/SnapshotUploadCreateResponse/properties/uploads/properties/archive/properties/cipherBytes',
        ),
      }),
      ArtifactConstraintSchema.extend({
        artifact: z.literal('openApi'),
        owner: z.literal('SnapshotUploadCreateRequest'),
        valueKind: z.literal('plaintextBytes'),
        artifactPointer: z.literal(
          '/components/schemas/SnapshotUploadCreateRequest/properties/archive/properties/envelope/properties/aad/properties/plaintextBytes',
        ),
      }),
      ArtifactConstraintSchema.extend({
        artifact: z.literal('openApi'),
        owner: z.literal('SnapshotUploadCreateRequest'),
        valueKind: z.literal('cipherBytes'),
        artifactPointer: z.literal(
          '/components/schemas/SnapshotUploadCreateRequest/properties/archive/properties/envelope/properties/cipherBytes',
        ),
      }),
      ArtifactConstraintSchema.extend({
        artifact: z.literal('openApi'),
        owner: z.literal('SnapshotUploadCreateResponse'),
        valueKind: z.literal('cipherBytes'),
        artifactPointer: z.literal(
          '/components/schemas/SnapshotUploadCreateResponse/properties/uploads/properties/archive/properties/cipherBytes',
        ),
      }),
    ]),
    boundary: z
      .object({
        id: z.literal('snapshot-compressed-archive-bytes'),
        plaintextMaximum: z.literal(52_428_800),
        cipherOverheadBytes: z.literal(36),
        cipherMaximum: z.literal(52_428_836),
        probes: z.tuple([
          BoundaryProbeSchema.extend({
            delta: z.literal(-1),
            expected: z.literal('accepted'),
            plaintextBytes: z.literal(52_428_799),
            cipherBytes: z.literal(52_428_835),
            canonicalDigests: ProbeDigestSchema.extend({
              aad: z.literal(
                'sha256:5c624d5180c5d7685883fa02543b84891ecea7e066776e3012b275f4ba10b20a',
              ),
              envelope: z.literal(
                'sha256:6c4651d8dbe736901ff451f18a9f8cfa5569bb1bd1c8594f439513be4c0fcc2b',
              ),
              request: z.literal(
                'sha256:cb757b75a84f5fa918ec0f94fef8b40de746915602eedde6e4d0d0ab5ebb7852',
              ),
              preparation: z.literal(
                'sha256:15823c35c0cf93da84021d114f08d06dc5ab942cf932a47e96af7cf8bc862bd7',
              ),
              target: z.literal(
                'sha256:eed651c94ae4cb5cb1b0472d8673112b894faf6af769805d7261f18f18aa2ade',
              ),
              response: z.literal(
                'sha256:718ddfa8a90bddbc422dec3ec52a27a795c278a93e04c4e4616dae022c5ef76f',
              ),
            }),
          }),
          BoundaryProbeSchema.extend({
            delta: z.literal(0),
            expected: z.literal('accepted'),
            plaintextBytes: z.literal(52_428_800),
            cipherBytes: z.literal(52_428_836),
            canonicalDigests: ProbeDigestSchema.extend({
              aad: z.literal(
                'sha256:c917e24e3615a156c644fca84c551d44b6419b507d799674b15ce7fd661c31c3',
              ),
              envelope: z.literal(
                'sha256:435890d8340f208f3a278c65e3ca285a83de89ceb9016a11e9b69a3360d4d342',
              ),
              request: z.literal(
                'sha256:7ab46071a57bca410ccfb420397c6fa363fc7b1b8554c1894585b8ef6c399bd5',
              ),
              preparation: z.literal(
                'sha256:f553636dbd31334329b56993f17054b807fe93ade7cc45b567d378a26a155821',
              ),
              target: z.literal(
                'sha256:056812403aef584f348052d6505c2d28f69223cad2b7dbd2a7cdd6b4d82f3719',
              ),
              response: z.literal(
                'sha256:60596a2ba94f54f6e9c72e56942126922e38f2254c515466c0e98f40a4063e47',
              ),
            }),
          }),
          BoundaryProbeSchema.extend({
            delta: z.literal(1),
            expected: z.literal('rejected'),
            plaintextBytes: z.literal(52_428_801),
            cipherBytes: z.literal(52_428_837),
            canonicalDigests: ProbeDigestSchema.extend({
              aad: z.literal(
                'sha256:d317d90655d3809c5429a3c7eff7c9589b1d24a15970f92ca4963208c88b1898',
              ),
              envelope: z.literal(
                'sha256:43d9224b04e159e3784aa59e2155204a7cb709ffbb78ba2b499d042d3a921ba0',
              ),
              request: z.literal(
                'sha256:0cbcabb32ccd0326a01b9fc8b722ce8522c0d657010e72eb8666b10213aeaa0b',
              ),
              preparation: z.literal(
                'sha256:9deae34b3155ddf015ee30e1e98199a0611f6cfcb4b09aa903e487edaf752990',
              ),
              target: z.literal(
                'sha256:30121999b697897c70c74b6e02b4464c0314713007f7aa72b8839eacbc3bcc7c',
              ),
              response: z.literal(
                'sha256:6e779cf382670f3be96d9c9ab1128d4780acb126f375469976449a26d0d46908',
              ),
            }),
          }),
        ]),
      })
      .strict(),
  })
  .strict();

export type SnapshotCompressedBoundaryCorpus = z.infer<
  typeof SnapshotCompressedBoundaryCorpusSchema
>;
