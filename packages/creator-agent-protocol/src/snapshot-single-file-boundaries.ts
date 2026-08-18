import { z } from 'zod';

import { Sha256DigestSchema } from './primitives.js';

export const SNAPSHOT_SINGLE_FILE_BOUNDARY_CORPUS =
  'combo.snapshot-single-file-boundaries/1' as const;

const AcceptedProbeSchema = z
  .object({
    delta: z.union([z.literal(-1), z.literal(0)]),
    expected: z.literal('accepted'),
    fileBytes: z.number().int().positive(),
    contentDigest: Sha256DigestSchema,
    canonicalManifestDigest: Sha256DigestSchema,
    snapshotDigest: Sha256DigestSchema,
    archiveDigest: Sha256DigestSchema,
  })
  .strict();

const RejectedProbeSchema = z
  .object({
    delta: z.literal(1),
    expected: z.literal('rejected'),
    fileBytes: z.number().int().positive(),
    contentDigest: Sha256DigestSchema,
    canonicalManifestDigest: Sha256DigestSchema,
  })
  .strict();

/**
 * Additive, digest-bound SCH-004 evidence for the manifest-only single-file
 * maximum. It intentionally does not alter snapshot-resource-boundaries/1,
 * whose two cases also have HTTP request and OpenAPI owners.
 */
export const SnapshotSingleFileBoundaryCorpusSchema = z
  .object({
    protocol: z.literal(SNAPSHOT_SINGLE_FILE_BOUNDARY_CORPUS),
    schemaVersion: z.literal(1),
    scope: z.literal('snapshot-single-file-bytes-only'),
    authority: z
      .object({
        technicalPlanSection: z.literal('技术方案 §5.2 Alpha 输入边界'),
        testPlanCases: z.tuple([z.literal('SNP-004'), z.literal('SNP-005')]),
        decisionRegistryId: z.literal('ADR-VNEXT-003'),
      })
      .strict(),
    checkedArtifactDigests: z
      .object({
        contractSchemas: z.literal(
          'sha256:e1e6d2c02ffb275844c994afe25977f8f6282077e1e95a76707e2e6865f8b434',
        ),
      })
      .strict(),
    baseFixture: z
      .object({
        path: z.literal('snapshot-manifest.v1.json'),
        digest: z.literal(
          'sha256:d77fc869ee4f4c9b616fb8277b482515b22e9fe957214c63964436d302359088',
        ),
      })
      .strict(),
    contentRecipe: z
      .object({
        algorithm: z.literal('sha256-counter-hex-block-repeat/1'),
        seedUtf8: z.literal('combo:snapshot-single-file-boundary:v1'),
        counterEncoding: z.literal('uint32be'),
        digestEncoding: z.literal('lowercase-hex'),
        sourceBlockBytes: z.literal(1_048_576),
        filePath: z.literal('boundary.txt'),
        mediaType: z.literal('text/plain; charset=utf-8'),
      })
      .strict(),
    boundary: z
      .object({
        id: z.literal('snapshot-single-file-bytes'),
        maximum: z.literal(10_485_760),
        jsonSchemaKeyword: z.literal('maximum'),
        fileInstancePath: z.literal('/size'),
        manifestInstancePath: z.literal('/files/0/size'),
        contractArtifactPointer: z.literal(
          '/schemas/SnapshotManifest/definitions/SnapshotManifest/properties/files/items/properties/size',
        ),
        probes: z.tuple([
          AcceptedProbeSchema.extend({
            delta: z.literal(-1),
            fileBytes: z.literal(10_485_759),
            contentDigest: z.literal(
              'sha256:7cde415b28217c337e36f56fe8394ab5f8827eeca57b6af6ca6f49eb32decb58',
            ),
            canonicalManifestDigest: z.literal(
              'sha256:b6cec8f9d2e4ffcecf61e6cfef6eee3a238ab5d133608dcded254b5300f88e3b',
            ),
            snapshotDigest: z.literal(
              'sha256:b6cec8f9d2e4ffcecf61e6cfef6eee3a238ab5d133608dcded254b5300f88e3b',
            ),
            archiveDigest: z.literal(
              'sha256:9175958135e85b262b23de22592a2abe078649385841d4647e453946897d477b',
            ),
          }),
          AcceptedProbeSchema.extend({
            delta: z.literal(0),
            fileBytes: z.literal(10_485_760),
            contentDigest: z.literal(
              'sha256:7e8b3fc6938139c3feb84121a12f031c3bac0e0fb1fd91dcb973bdc722d0d97d',
            ),
            canonicalManifestDigest: z.literal(
              'sha256:d88ebb407db97f81c3acdb07825a5efea0f2bfb31a0fb925e95717d1a50f9e83',
            ),
            snapshotDigest: z.literal(
              'sha256:d88ebb407db97f81c3acdb07825a5efea0f2bfb31a0fb925e95717d1a50f9e83',
            ),
            archiveDigest: z.literal(
              'sha256:996423f5e5e29c444650e798ab190123aef051724eb929a95abbcd9ec225e6a7',
            ),
          }),
          RejectedProbeSchema.extend({
            fileBytes: z.literal(10_485_761),
            contentDigest: z.literal(
              'sha256:b64de5fa5ae98691e865d224ec302407b029cf27f1194e1c0ea9c4a4e255b32f',
            ),
            canonicalManifestDigest: z.literal(
              'sha256:cbaf8e3a15f3b0cc021c9e129e5fab879526cfadeee37b04d3659b2097617555',
            ),
          }),
        ]),
      })
      .strict(),
  })
  .strict();

export type SnapshotSingleFileBoundaryCorpus = z.infer<
  typeof SnapshotSingleFileBoundaryCorpusSchema
>;
