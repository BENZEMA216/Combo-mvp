import { z } from 'zod';

import { Sha256DigestSchema } from './primitives.js';

export const PROTOCOL_STRUCTURAL_BOUNDARY_CORPUS =
  'combo.protocol-structural-boundaries/1' as const;

const CheckedArtifactSchema = z.enum(['contractSchemas', 'brokerContract', 'openApi']);

const ArtifactPointerSchema = z
  .object({
    artifact: CheckedArtifactSchema,
    pointer: z
      .string()
      .min(1)
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

/**
 * Digest-bound subset of SCH-004 covering structural Unicode-count alignment and the three
 * public path/header values that previously bypassed their runtime parser constraints.
 */
export const ProtocolStructuralBoundaryCorpusSchema = z
  .object({
    protocol: z.literal(PROTOCOL_STRUCTURAL_BOUNDARY_CORPUS),
    schemaVersion: z.literal(1),
    scope: z.literal('unicode-code-point-and-http-path-header-limits-only'),
    checkedArtifactDigests: z
      .object({
        contractSchemas: Sha256DigestSchema,
        brokerContract: Sha256DigestSchema,
        openApi: Sha256DigestSchema,
      })
      .strict(),
    unicodeBoundaries: z.array(UnicodeBoundarySchema).length(8),
    httpBoundaries: z.array(HttpBoundarySchema).length(3),
    ownerCases: z.tuple([
      z.literal('vnext-error-response'),
      z.literal('invariant-registry'),
      z.literal('public-agent-slug'),
      z.literal('deployment-generation-etag'),
      z.literal('last-event-id'),
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
  });

export type ProtocolStructuralBoundaryCorpus = z.infer<
  typeof ProtocolStructuralBoundaryCorpusSchema
>;
