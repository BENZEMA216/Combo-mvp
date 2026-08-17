import { z } from 'zod';

import { Sha256DigestSchema } from './primitives.js';

export const SNAPSHOT_PATH_BOUNDARY_CORPUS = 'combo.snapshot-path-boundaries/1' as const;

const AcceptedProbeSchema = z
  .object({
    delta: z.union([z.literal(-1), z.literal(0)]),
    expected: z.literal('accepted'),
    pathUtf8Bytes: z.number().int().positive(),
    pathCodePoints: z.number().int().positive(),
    pathDigest: Sha256DigestSchema,
    candidateManifestDigest: Sha256DigestSchema,
    snapshotDigest: Sha256DigestSchema,
    archiveDigest: Sha256DigestSchema,
  })
  .strict();

const RejectedProbeSchema = z
  .object({
    delta: z.literal(1),
    expected: z.literal('rejected'),
    pathUtf8Bytes: z.number().int().positive(),
    pathCodePoints: z.number().int().positive(),
    pathDigest: Sha256DigestSchema,
    candidateManifestDigest: Sha256DigestSchema,
  })
  .strict();

/**
 * Additive SCH-004/SNP-009 evidence for the complete relative-path UTF-8
 * byte maximum. Filesystem component policy remains explicitly unfrozen.
 */
export const SnapshotPathBoundaryCorpusSchema = z
  .object({
    protocol: z.literal(SNAPSHOT_PATH_BOUNDARY_CORPUS),
    schemaVersion: z.literal(1),
    scope: z.literal('snapshot-relative-path-utf8-bytes-only'),
    authority: z
      .object({
        technicalPlanSection: z.literal('技术方案 §5.2 Alpha 输入边界'),
        testPlanCases: z.tuple([z.literal('SCH-004'), z.literal('SNP-009')]),
        pathPolicyDecisionId: z.literal('ADR-VNEXT-004'),
      })
      .strict(),
    checkedDependencies: z
      .object({
        utf8BoundaryCorpus: z
          .object({
            path: z.literal('protocol-utf8-boundaries.v1.json'),
            digest: z.literal(
              'sha256:b2d7d67e69c05074c69c2d39a84ff83b56ecbafe0f9902c39d5283166595aec1',
            ),
          })
          .strict(),
        baseManifest: z
          .object({
            path: z.literal('snapshot-manifest.v1.json'),
            digest: z.literal(
              'sha256:d77fc869ee4f4c9b616fb8277b482515b22e9fe957214c63964436d302359088',
            ),
          })
          .strict(),
        contractSchemas: z.literal(
          'sha256:34bf5033e0ea32482af4f299aefe26c22936a1beea345f3a573708dd505d60e3',
        ),
      })
      .strict(),
    pathRecipe: z
      .object({
        algorithm: z.literal('segmented-ascii-cjk-astral/1'),
        firstSegment: z.literal('a'),
        firstSegmentCodePoints: z.literal(250),
        secondSegment: z.literal('b'),
        secondSegmentCodePoints: z.literal(250),
        tailSegment: z.literal('c'),
        tailBaseCodePoints: z.literal(3),
        cjkSuffix: z.literal('界'),
        astralSuffix: z.literal('😀'),
        separator: z.literal('/'),
        contentUtf8: z.literal('snapshot path boundary fixture\n'),
        contentBytes: z.literal(31),
        contentDigest: z.literal(
          'sha256:57af1904099f86cb97614b2617eeebd75aaa4d5b7a29c34830bc9604c8d4ad1f',
        ),
        mediaType: z.literal('text/plain; charset=utf-8'),
      })
      .strict(),
    boundary: z
      .object({
        id: z.literal('snapshot-relative-path-utf8-bytes'),
        maximumUtf8Bytes: z.literal(512),
        jsonSchemaKeyword: z.literal('x-combo-maxUtf8Bytes'),
        pathInstancePath: z.literal(''),
        fileInstancePath: z.literal('/path'),
        manifestInstancePath: z.literal('/files/0/path'),
        contractArtifactPointer: z.literal(
          '/schemas/SnapshotManifest/definitions/SnapshotManifest/properties/files/items/properties/path',
        ),
        probes: z.tuple([
          AcceptedProbeSchema.extend({
            delta: z.literal(-1),
            pathUtf8Bytes: z.literal(511),
            pathCodePoints: z.literal(506),
            pathDigest: z.literal(
              'sha256:f7a5c2673b12dc24d0ef871202b1df5abbbee2d7989b218bd2b490b1830f6feb',
            ),
            candidateManifestDigest: z.literal(
              'sha256:000c1e80c5847d67b11ca3385e24e0795f92380fc56427f19815f33eaf5522a1',
            ),
            snapshotDigest: z.literal(
              'sha256:000c1e80c5847d67b11ca3385e24e0795f92380fc56427f19815f33eaf5522a1',
            ),
            archiveDigest: z.literal(
              'sha256:570af01e1ba48c8d7b083f3259f98ed0a1fcb5a8680ec034d3cc419cb35eada2',
            ),
          }),
          AcceptedProbeSchema.extend({
            delta: z.literal(0),
            pathUtf8Bytes: z.literal(512),
            pathCodePoints: z.literal(507),
            pathDigest: z.literal(
              'sha256:679aefd9e3cb9ec72f25bbb7e0d476860dd8082fdcbddde02af0fdac33074f9d',
            ),
            candidateManifestDigest: z.literal(
              'sha256:cdc0628d972eb95b59413ed1e05f4259e0362d4f6951acc121613d25f63f9d7a',
            ),
            snapshotDigest: z.literal(
              'sha256:cdc0628d972eb95b59413ed1e05f4259e0362d4f6951acc121613d25f63f9d7a',
            ),
            archiveDigest: z.literal(
              'sha256:6fcf0e46ade82d047341d1a0138ef8fa7236f31802bfaffbd0fd5c69526b18b4',
            ),
          }),
          RejectedProbeSchema.extend({
            pathUtf8Bytes: z.literal(513),
            pathCodePoints: z.literal(508),
            pathDigest: z.literal(
              'sha256:fd1f41cdb1f530b686db71f40f8f8f3ae983d38a39db82d6aad9ea0e3ec063b8',
            ),
            candidateManifestDigest: z.literal(
              'sha256:27c39ef1d3fdca7e1407a4b6442a1e670e7c938414f8ade97db4674392496abb',
            ),
          }),
        ]),
      })
      .strict(),
    remainingBoundaryClasses: z.tuple([
      z.literal('filesystem-component-255-byte-policy-not-frozen'),
    ]),
  })
  .strict();

export type SnapshotPathBoundaryCorpus = z.infer<typeof SnapshotPathBoundaryCorpusSchema>;
