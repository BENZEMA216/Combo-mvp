import { z } from 'zod';

import { Sha256DigestSchema } from './primitives.js';

export const SNAPSHOT_RESOURCE_BOUNDARY_CORPUS = 'combo.snapshot-resource-boundaries/1' as const;

const JsonPointerSchema = z
  .string()
  .min(1)
  .max(2_048)
  .regex(/^\/(?:[^~]|~[01])*$/u);

const ManifestConstraintSchema = z
  .object({
    instancePath: JsonPointerSchema,
    jsonSchemaKeyword: z.enum(['maxItems', 'maximum']),
    contractArtifactPointer: JsonPointerSchema,
  })
  .strict();

const RequestConstraintSchema = z
  .object({
    instancePath: JsonPointerSchema,
    jsonSchemaKeyword: z.literal('maximum'),
    contractArtifactPointer: JsonPointerSchema,
    openApiArtifactPointer: JsonPointerSchema,
  })
  .strict();

const BoundaryProbeSchema = z
  .object({
    delta: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    fileCount: z.number().int().positive(),
    expandedBytes: z.number().int().nonnegative(),
    canonicalDigest: Sha256DigestSchema,
  })
  .strict();

const BoundaryCaseSchema = z
  .object({
    id: z.enum(['snapshot-manifest-file-count', 'snapshot-manifest-expanded-bytes']),
    maximum: z.number().int().positive(),
    probes: z.array(BoundaryProbeSchema).length(3),
    manifestConstraints: z.array(ManifestConstraintSchema).min(1).max(2),
    requestConstraint: RequestConstraintSchema,
  })
  .strict();

/**
 * Digest-bound SCH-004 subset for the two Snapshot Manifest maxima which share
 * runtime Manifest, HTTP request, contract, OpenAPI and production parser owners.
 */
export const SnapshotResourceBoundaryCorpusSchema = z
  .object({
    protocol: z.literal(SNAPSHOT_RESOURCE_BOUNDARY_CORPUS),
    schemaVersion: z.literal(1),
    scope: z.literal('snapshot-manifest-file-count-and-expanded-bytes-only'),
    authority: z
      .object({
        technicalPlanSection: z.literal('技术方案 §5.2 Alpha 输入边界'),
        testPlanCases: z.tuple([
          z.literal('SNP-002'),
          z.literal('SNP-003'),
          z.literal('SNP-006'),
          z.literal('SNP-007'),
        ]),
      })
      .strict(),
    checkedArtifactDigests: z
      .object({
        contractSchemas: Sha256DigestSchema,
        openApi: Sha256DigestSchema,
      })
      .strict(),
    baseFixture: z
      .object({
        path: z.literal('snapshot-manifest.v1.json'),
        digest: Sha256DigestSchema,
      })
      .strict(),
    cases: z.tuple([
      BoundaryCaseSchema.extend({
        id: z.literal('snapshot-manifest-file-count'),
        maximum: z.literal(2_000),
        probes: z.tuple([
          BoundaryProbeSchema.extend({
            delta: z.literal(-1),
            fileCount: z.literal(1_999),
            expandedBytes: z.literal(1_999),
            canonicalDigest: z.literal(
              'sha256:f07070e8da79cb15b18beab4538a02261e6c28737b6e4d9f858c468a2eddad30',
            ),
          }),
          BoundaryProbeSchema.extend({
            delta: z.literal(0),
            fileCount: z.literal(2_000),
            expandedBytes: z.literal(2_000),
            canonicalDigest: z.literal(
              'sha256:86604d840acb1628daac149be7ed34d377920cb1e1debb082eba29771392460d',
            ),
          }),
          BoundaryProbeSchema.extend({
            delta: z.literal(1),
            fileCount: z.literal(2_001),
            expandedBytes: z.literal(2_001),
            canonicalDigest: z.literal(
              'sha256:a0d515656eef7568b791a162226fb5ac97b8d4b14ac30acf6795ca79464e28b0',
            ),
          }),
        ]),
        manifestConstraints: z.tuple([
          ManifestConstraintSchema.extend({
            instancePath: z.literal('/files'),
            jsonSchemaKeyword: z.literal('maxItems'),
            contractArtifactPointer: z.literal(
              '/schemas/SnapshotManifest/definitions/SnapshotManifest/properties/files',
            ),
          }),
          ManifestConstraintSchema.extend({
            instancePath: z.literal('/totals/fileCount'),
            jsonSchemaKeyword: z.literal('maximum'),
            contractArtifactPointer: z.literal(
              '/schemas/SnapshotManifest/definitions/SnapshotManifest/properties/totals/properties/fileCount',
            ),
          }),
        ]),
        requestConstraint: RequestConstraintSchema.extend({
          instancePath: z.literal('/fileCount'),
          contractArtifactPointer: z.literal(
            '/schemas/SnapshotUploadCreateRequest/definitions/SnapshotUploadCreateRequest/properties/fileCount',
          ),
          openApiArtifactPointer: z.literal(
            '/components/schemas/SnapshotUploadCreateRequest/properties/fileCount',
          ),
        }),
      }),
      BoundaryCaseSchema.extend({
        id: z.literal('snapshot-manifest-expanded-bytes'),
        maximum: z.literal(209_715_200),
        probes: z.tuple([
          BoundaryProbeSchema.extend({
            delta: z.literal(-1),
            fileCount: z.literal(200),
            expandedBytes: z.literal(209_715_199),
            canonicalDigest: z.literal(
              'sha256:4727286493250ece96de441b7331d6d001b9d76834bf55a144dd25e5b00397cb',
            ),
          }),
          BoundaryProbeSchema.extend({
            delta: z.literal(0),
            fileCount: z.literal(200),
            expandedBytes: z.literal(209_715_200),
            canonicalDigest: z.literal(
              'sha256:510cd24f3aebb0b33efbe6cfe5f5bc7bdd552ed1824977961ca09ed47be38d18',
            ),
          }),
          BoundaryProbeSchema.extend({
            delta: z.literal(1),
            fileCount: z.literal(201),
            expandedBytes: z.literal(209_715_201),
            canonicalDigest: z.literal(
              'sha256:5e8f02cf63fc1ac5c2f5de058899e4ff3c861b51cfb0f7e2f70c238d5dda549f',
            ),
          }),
        ]),
        manifestConstraints: z.tuple([
          ManifestConstraintSchema.extend({
            instancePath: z.literal('/totals/expandedBytes'),
            jsonSchemaKeyword: z.literal('maximum'),
            contractArtifactPointer: z.literal(
              '/schemas/SnapshotManifest/definitions/SnapshotManifest/properties/totals/properties/expandedBytes',
            ),
          }),
        ]),
        requestConstraint: RequestConstraintSchema.extend({
          instancePath: z.literal('/expandedBytes'),
          contractArtifactPointer: z.literal(
            '/schemas/SnapshotUploadCreateRequest/definitions/SnapshotUploadCreateRequest/properties/expandedBytes',
          ),
          openApiArtifactPointer: z.literal(
            '/components/schemas/SnapshotUploadCreateRequest/properties/expandedBytes',
          ),
        }),
      }),
    ]),
  })
  .strict()
  .superRefine((corpus, context) => {
    const pointers = corpus.cases.flatMap((boundary) => [
      ...boundary.manifestConstraints.map(
        ({ contractArtifactPointer }) => `contract:${contractArtifactPointer}`,
      ),
      `contract:${boundary.requestConstraint.contractArtifactPointer}`,
      `openapi:${boundary.requestConstraint.openApiArtifactPointer}`,
    ]);
    if (new Set(pointers).size !== pointers.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cases'],
        message: 'Snapshot resource-boundary artifact pointers must be unique',
      });
    }
  });

export type SnapshotResourceBoundaryCorpus = z.infer<typeof SnapshotResourceBoundaryCorpusSchema>;
