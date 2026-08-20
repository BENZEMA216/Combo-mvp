import { z } from 'zod';

import {
  OptionalUnicodeScalarNoControlStringSchema,
  RequiredUnicodeScalarNoControlStringSchema,
  Sha256DigestSchema,
} from './primitives.js';

export const PROTOCOL_STRUCTURAL_BOUNDARY_CORPUS =
  'combo.protocol-structural-boundaries/1' as const;

const CheckedArtifactSchema = z.enum(['contractSchemas', 'brokerContract', 'openApi']);

const ArtifactPointerSchema = z
  .object({
    artifact: CheckedArtifactSchema,
    pointer: RequiredUnicodeScalarNoControlStringSchema.min(1)
      .max(2_048)
      .regex(/^\/(?:[^~]|~[01])*$/u),
  })
  .strict();

const UnicodeBoundarySchema = z
  .object({
    minimumCodePoints: z.number().int().nonnegative(),
    maximumCodePoints: z.number().int().positive(),
    artifactPointers: z.array(ArtifactPointerSchema).min(1),
  })
  .strict()
  .refine(({ minimumCodePoints, maximumCodePoints }) => minimumCodePoints <= maximumCodePoints, {
    path: ['minimumCodePoints'],
    message: 'Unicode code-point minimum must not exceed maximum',
  });

const UnicodeRuntimeOwnerIdSchema = z.enum([
  'invariant-statement',
  'invariant-owner',
  'testcase-title',
  'testcase-fixture',
  'testcase-fault',
  'testcase-step',
  'testcase-assertion',
  'testcase-evidence',
  'testcase-owner',
  'testcase-reviewer',
  'testcase-test-file',
  'testcase-release-tuple',
  'decision-title',
  'decision-owner',
  'decision-body',
  'decision-alternative',
  'decision-evidence',
  'decision-security-impact',
  'decision-reversal-trigger',
  'decision-protocol-version',
  'architecture-decision-summary',
  'data-flow-deletion-or-hold',
  'vnext-error-message',
  'vnext-error-request-id',
  'snapshot-publication-preparation-key',
  'snapshot-upload-error-code',
  'deployment-last-error-code',
  'snapshot-archive-object-key',
  'snapshot-manifest-object-key',
]);

const UnicodeRuntimeOwnerSchema = z
  .object({
    id: UnicodeRuntimeOwnerIdSchema,
    source: RequiredUnicodeScalarNoControlStringSchema.max(180),
    runtimeParser: RequiredUnicodeScalarNoControlStringSchema.max(96),
    fixtureSource: RequiredUnicodeScalarNoControlStringSchema.max(180),
    fixtureFormat: z.enum(['json', 'yaml', 'inline']),
    ownerPointer:
      OptionalUnicodeScalarNoControlStringSchema.max(512).regex(/^(?:|\/(?:[^~]|~[01])*)$/u),
    instancePointer: RequiredUnicodeScalarNoControlStringSchema.min(1)
      .max(512)
      .regex(/^\/(?:[^~]|~[01])*$/u),
    minimumCodePoints: z.number().int().nonnegative(),
    maximumCodePoints: z.number().int().positive(),
    kind: z.enum(['ordinary', 'exact-derived']),
  })
  .strict();

const UnicodeScalarParitySchema = z
  .object({
    canaryPrefix: z.literal('UNICODE_SCALAR_CANARY_'),
    strictPatternSource: z.literal(
      '^(?:[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])+$',
    ),
    strictOptionalPatternSource: z.literal(
      '^(?:[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])*$',
    ),
    strictRuntimeOwnerIds: z.array(UnicodeRuntimeOwnerIdSchema).length(14),
    strictArtifactPointers: z.array(ArtifactPointerSchema).length(29),
    runtimeOwners: z.array(UnicodeRuntimeOwnerSchema).length(29),
    probeRecipe: z
      .object({
        accepted: z.tuple([
          z.object({ id: z.literal('tab'), codeUnits: z.tuple([z.literal(0x09)]) }).strict(),
          z.object({ id: z.literal('lf'), codeUnits: z.tuple([z.literal(0x0a)]) }).strict(),
          z.object({ id: z.literal('cr'), codeUnits: z.tuple([z.literal(0x0d)]) }).strict(),
          z
            .object({
              id: z.literal('astral'),
              codeUnits: z.tuple([z.literal(0xd83d), z.literal(0xde00)]),
            })
            .strict(),
        ]),
        forbiddenControlRanges: z.tuple([
          z.object({ id: z.literal('c0'), start: z.literal(0x00), end: z.literal(0x1f) }).strict(),
          z.object({ id: z.literal('c1'), start: z.literal(0x7f), end: z.literal(0x9f) }).strict(),
        ]),
        allowedControlCodeUnits: z.tuple([z.literal(0x09), z.literal(0x0a), z.literal(0x0d)]),
        loneSurrogates: z.tuple([
          z.object({ id: z.literal('high-surrogate'), codeUnit: z.literal(0xd800) }).strict(),
          z.object({ id: z.literal('low-surrogate'), codeUnit: z.literal(0xdc00) }).strict(),
        ]),
        expectedCounts: z
          .object({
            accepted: z.literal(4),
            rejected: z.literal(64),
            total: z.literal(68),
          })
          .strict(),
      })
      .strict(),
    nullableWrappers: z.tuple([
      z
        .object({
          id: z.literal('snapshot-upload-error-code'),
          artifact: z.literal('contractSchemas'),
          pointer: z.literal(
            '/schemas/SnapshotUploadView/definitions/SnapshotUploadView/properties/errorCode',
          ),
        })
        .strict(),
      z
        .object({
          id: z.literal('deployment-last-error-code'),
          artifact: z.literal('contractSchemas'),
          pointer: z.literal(
            '/schemas/DeploymentView/definitions/DeploymentView/properties/lastErrorCode',
          ),
        })
        .strict(),
    ]),
    syntheticBasePatternSource: z.literal('^base-[a-z]+$'),
    expectedCounts: z
      .object({
        runtimeOwners: z.literal(29),
        ordinaryOwners: z.literal(26),
        exactDerivedOwners: z.literal(3),
        strictRuntimeOwners: z.literal(14),
        publicNodes: z.literal(47),
        strictPublicNodes: z.literal(29),
        helperBoundaries: z.literal(8),
        outcomes: z.literal(5_712),
      })
      .strict(),
  })
  .strict()
  .superRefine((parity, context) => {
    const ids = parity.runtimeOwners.map(({ id }) => id);
    const ordinary = parity.runtimeOwners.filter(({ kind }) => kind === 'ordinary').length;
    const derived = parity.runtimeOwners.filter(({ kind }) => kind === 'exact-derived').length;
    const strictIds = new Set(parity.strictRuntimeOwnerIds);
    const strictPointers = parity.strictArtifactPointers.map(
      ({ artifact, pointer }) => `${artifact}:${pointer}`,
    );
    if (
      new Set(ids).size !== parity.expectedCounts.runtimeOwners ||
      ordinary !== parity.expectedCounts.ordinaryOwners ||
      derived !== parity.expectedCounts.exactDerivedOwners ||
      strictIds.size !== parity.expectedCounts.strictRuntimeOwners ||
      parity.strictRuntimeOwnerIds.some((id) => !ids.includes(id)) ||
      new Set(strictPointers).size !== parity.expectedCounts.strictPublicNodes
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['runtimeOwners'],
        message: 'Unicode scalar runtime-owner coverage must remain exact',
      });
    }
  });

const HttpBoundarySchema = z
  .object({
    id: z.enum(['public-agent-slug', 'deployment-generation-etag', 'last-event-id']),
    runtimeParser: z.enum([
      'PublicAgentSlugSchema',
      'DeploymentGenerationEtagSchema',
      'LastEventIdSchema',
    ]),
    openApiComponent: z.enum(['PublicAgentSlug', 'DeploymentGenerationEtag', 'LastEventId']),
    minimumLength: z.number().int().nonnegative(),
    maximumLength: z.number().int().positive(),
  })
  .strict();

const OwnerFixtureSchema = z
  .object({
    path: RequiredUnicodeScalarNoControlStringSchema.max(512),
    format: z.enum(['json', 'yaml']),
    valuePointer: RequiredUnicodeScalarNoControlStringSchema.min(1)
      .max(512)
      .regex(/^\/(?:[^~]|~[01])*$/u),
  })
  .strict();

const ServerIdBoundarySchema = z
  .object({
    id: z.literal('server-id-path-uuidv7'),
    runtimeParser: z.literal('ServerIdSchema'),
    contractSchema: z.literal('ServerId'),
    openApiComponent: z.literal('ServerId'),
    ownerFixture: OwnerFixtureSchema,
    minimumLength: z.literal(36),
    maximumLength: z.literal(36),
    pathParameterPointers: z.array(ArtifactPointerSchema).length(11),
  })
  .strict();

const GateSetBoundarySchema = z
  .object({
    id: z.enum(['evidence-reviewer-signoff-reviewed-gates', 'invariant-registry-gates']),
    runtimeParser: z.enum(['EvidenceReviewerSignoffSchema', 'InvariantRegistrySchema']),
    contractSchema: z.enum(['EvidenceReviewerSignoff', 'InvariantRegistry']),
    ownerFixture: OwnerFixtureSchema,
    contractPointer: RequiredUnicodeScalarNoControlStringSchema.min(1)
      .max(2_048)
      .regex(/^\/(?:[^~]|~[01])*$/u),
    minimumItems: z.literal(1),
    maximumItems: z.literal(9),
    uniqueItems: z.literal(true),
    reverseSemantics: z.enum(['runtime-rejects', 'runtime-accepts']),
  })
  .strict();

/**
 * Digest-bound subset of SCH-004 covering structural Unicode-count alignment, bounded public
 * path/header values, exact server UUIDv7 paths, and frozen nine-gate resource sets.
 */
export const ProtocolStructuralBoundaryCorpusSchema = z
  .object({
    protocol: z.literal(PROTOCOL_STRUCTURAL_BOUNDARY_CORPUS),
    schemaVersion: z.literal(1),
    scope: z.literal('unicode-http-and-frozen-resource-boundaries-only'),
    checkedArtifactDigests: z
      .object({
        contractSchemas: Sha256DigestSchema,
        brokerContract: Sha256DigestSchema,
        openApi: Sha256DigestSchema,
      })
      .strict(),
    unicodeBoundaries: z.array(UnicodeBoundarySchema).length(8),
    unicodeScalarParity: UnicodeScalarParitySchema,
    httpBoundaries: z.array(HttpBoundarySchema).length(3),
    serverIdBoundary: ServerIdBoundarySchema,
    gateSetBoundaries: z.tuple([
      GateSetBoundarySchema.extend({
        id: z.literal('evidence-reviewer-signoff-reviewed-gates'),
        runtimeParser: z.literal('EvidenceReviewerSignoffSchema'),
        contractSchema: z.literal('EvidenceReviewerSignoff'),
        reverseSemantics: z.literal('runtime-rejects'),
      }),
      GateSetBoundarySchema.extend({
        id: z.literal('invariant-registry-gates'),
        runtimeParser: z.literal('InvariantRegistrySchema'),
        contractSchema: z.literal('InvariantRegistry'),
        reverseSemantics: z.literal('runtime-accepts'),
      }),
    ]),
    ownerCases: z.tuple([
      z.literal('vnext-error-response'),
      z.literal('invariant-registry'),
      z.literal('evidence-reviewer-signoff'),
      z.literal('public-agent-slug'),
      z.literal('deployment-generation-etag'),
      z.literal('last-event-id'),
      z.literal('server-id-path-uuidv7'),
    ]),
    remainingBoundaryClasses: z.tuple([
      z.literal('other-structural-string-patterns'),
      z.literal('array-count'),
      z.literal('map-property-count'),
      z.literal('numeric-maximum'),
      z.literal('evidence-json-bytes'),
      z.literal('canonical-json-bytes'),
    ]),
  })
  .strict()
  .superRefine((corpus, context) => {
    const boundaryKeys = corpus.unicodeBoundaries.map(
      ({ minimumCodePoints, maximumCodePoints }) => `${minimumCodePoints}:${maximumCodePoints}`,
    );
    if (new Set(boundaryKeys).size !== boundaryKeys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unicodeBoundaries'],
        message: 'Unicode code-point boundary pairs must be unique',
      });
    }
    const pointers = corpus.unicodeBoundaries.flatMap(({ artifactPointers }) =>
      artifactPointers.map(({ artifact, pointer }) => `${artifact}:${pointer}`),
    );
    if (new Set(pointers).size !== pointers.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unicodeBoundaries'],
        message: 'Unicode code-point artifact pointers must be unique',
      });
    }
    const httpIds = corpus.httpBoundaries.map(({ id }) => id);
    if (new Set(httpIds).size !== httpIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['httpBoundaries'],
        message: 'HTTP boundary IDs must be unique',
      });
    }
    const pathPointers = corpus.serverIdBoundary.pathParameterPointers.map(
      ({ artifact, pointer }) => `${artifact}:${pointer}`,
    );
    if (new Set(pathPointers).size !== pathPointers.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['serverIdBoundary', 'pathParameterPointers'],
        message: 'Server-ID path parameter pointers must be unique',
      });
    }
  });

export type ProtocolStructuralBoundaryCorpus = z.infer<
  typeof ProtocolStructuralBoundaryCorpusSchema
>;
