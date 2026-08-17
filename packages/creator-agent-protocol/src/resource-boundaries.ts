import { z } from 'zod';

import { Sha256DigestSchema } from './primitives.js';

export const AGENT_VERSION_RESOURCE_BOUNDARY_CORPUS =
  'combo.agent-version-resource-boundaries/1' as const;

const JsonPointerSchema = z
  .string()
  .min(1)
  .max(2_048)
  .regex(/^\/(?:[^~]|~[01])*$/u);

const ArtifactPointersSchema = z
  .object({
    contractAgentVersionManifest: JsonPointerSchema,
    contractCreateAgentVersionRequest: JsonPointerSchema,
    openApiCreateAgentVersionRequest: JsonPointerSchema,
  })
  .strict();

const BoundaryCaseSchema = z
  .object({
    id: z.string().min(1).max(128),
    valueKind: z.enum(['array-cardinality', 'integer-maximum']),
    maximum: z.number().int().positive(),
    jsonSchemaKeyword: z.enum(['maxItems', 'maximum']),
    manifestInstancePath: JsonPointerSchema,
    requestInstancePath: JsonPointerSchema,
    artifactPointers: ArtifactPointersSchema,
  })
  .strict();

/**
 * Digest-bound SCH-004 subset for the four variable AgentVersion cardinality/numeric maxima.
 * Tuple/literal fields such as contextTools, maxActiveTurns and IO maxUtf8Bytes are excluded.
 */
export const AgentVersionResourceBoundaryCorpusSchema = z
  .object({
    protocol: z.literal(AGENT_VERSION_RESOURCE_BOUNDARY_CORPUS),
    schemaVersion: z.literal(1),
    scope: z.literal('agent-version-variable-cardinality-and-numeric-maximums-only'),
    checkedArtifactDigests: z
      .object({
        contractSchemas: Sha256DigestSchema,
        openApi: Sha256DigestSchema,
      })
      .strict(),
    baseFixture: z
      .object({
        path: z.literal('agent-version-manifest.v1.json'),
        digest: Sha256DigestSchema,
      })
      .strict(),
    verifiedSnapshotId: z.literal('0198f00d-6000-7000-8000-000000000001'),
    cases: z.tuple([
      BoundaryCaseSchema.extend({
        id: z.literal('behavior-contract-developer-instructions'),
        valueKind: z.literal('array-cardinality'),
        maximum: z.literal(32),
        jsonSchemaKeyword: z.literal('maxItems'),
        manifestInstancePath: z.literal('/behaviorContract/developerInstructions'),
        requestInstancePath: z.literal('/manifest/behaviorContract/developerInstructions'),
      }),
      BoundaryCaseSchema.extend({
        id: z.literal('runtime-policy-max-turn-seconds'),
        valueKind: z.literal('integer-maximum'),
        maximum: z.literal(120),
        jsonSchemaKeyword: z.literal('maximum'),
        manifestInstancePath: z.literal('/runtimePolicy/maxTurnSeconds'),
        requestInstancePath: z.literal('/manifest/runtimePolicy/maxTurnSeconds'),
      }),
      BoundaryCaseSchema.extend({
        id: z.literal('runtime-policy-max-conversation-turns'),
        valueKind: z.literal('integer-maximum'),
        maximum: z.literal(20),
        jsonSchemaKeyword: z.literal('maximum'),
        manifestInstancePath: z.literal('/runtimePolicy/maxConversationTurns'),
        requestInstancePath: z.literal('/manifest/runtimePolicy/maxConversationTurns'),
      }),
      BoundaryCaseSchema.extend({
        id: z.literal('runtime-policy-max-visible-history-bytes'),
        valueKind: z.literal('integer-maximum'),
        maximum: z.literal(65_536),
        jsonSchemaKeyword: z.literal('maximum'),
        manifestInstancePath: z.literal('/runtimePolicy/maxVisibleHistoryBytes'),
        requestInstancePath: z.literal('/manifest/runtimePolicy/maxVisibleHistoryBytes'),
      }),
    ]),
    excludedLiteralFields: z.tuple([
      z.literal('/runtimePolicy/contextTools'),
      z.literal('/runtimePolicy/maxActiveTurns'),
      z.literal('/ioContract/input/maxUtf8Bytes'),
      z.literal('/ioContract/output/maxUtf8Bytes'),
    ]),
  })
  .strict()
  .superRefine((corpus, context) => {
    const pointers = corpus.cases.flatMap(({ artifactPointers }) =>
      Object.entries(artifactPointers).map(([artifact, pointer]) => `${artifact}:${pointer}`),
    );
    if (new Set(pointers).size !== pointers.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cases'],
        message: 'AgentVersion resource-boundary artifact pointers must be unique',
      });
    }
  });

export type AgentVersionResourceBoundaryCorpus = z.infer<
  typeof AgentVersionResourceBoundaryCorpusSchema
>;
