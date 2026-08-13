import { z } from 'zod';
import { canonicalSha256 } from './canonical.js';
import { Sha256DigestSchema, Sha256HexSchema, Utf8TextSchema } from './primitives.js';

export const AGENT_VERSION_PROTOCOL = 'combo.agent-version-manifest/1' as const;

export const BehaviorContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    role: Utf8TextSchema(512),
    objective: Utf8TextSchema(2_048),
    developerInstructions: z.array(Utf8TextSchema(2_048)).min(1).max(32),
    language: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/u),
    evidencePolicy: z.enum(['none', 'cite-relative-path-when-used']),
    answerStyle: z.enum(['plain', 'conclusion-evidence-risk']),
  })
  .strict();
export type BehaviorContract = z.infer<typeof BehaviorContractSchema>;

export const RuntimePolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    isolation: z.literal('conversation-vm-required'),
    filesystem: z
      .object({
        context: z.literal('read-only-noexec'),
        scratch: z.literal('conversation-only'),
        hostMounts: z.literal('forbidden'),
      })
      .strict(),
    contextTools: z.tuple([
      z.literal('read_context'),
      z.literal('list_context'),
      z.literal('search_context'),
    ]),
    projectExecution: z.literal('forbidden'),
    network: z.literal('model-proxy-only'),
    externalTools: z.literal('disabled'),
    hostCredentials: z.literal('forbidden'),
    maxTurnSeconds: z.number().int().min(1).max(120),
    maxConversationTurns: z.number().int().min(1).max(20),
    maxVisibleHistoryBytes: z.number().int().min(1).max(65_536),
    maxActiveTurns: z.literal(1),
    resolvedModel: Utf8TextSchema(128),
    reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']),
  })
  .strict();
export type RuntimePolicy = z.infer<typeof RuntimePolicySchema>;

export const IOContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    input: z.object({ type: z.literal('text'), maxUtf8Bytes: z.literal(16_384) }).strict(),
    output: z.object({ type: z.literal('text'), maxUtf8Bytes: z.literal(32_768) }).strict(),
    files: z.literal(false),
    actions: z.literal(false),
    rawReasoning: z.literal(false),
  })
  .strict();
export type IOContract = z.infer<typeof IOContractSchema>;

export const ModelPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    model: Utf8TextSchema(128),
    reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']),
    creatorFunded: z.literal(true),
  })
  .strict();
export type ModelPolicy = z.infer<typeof ModelPolicySchema>;

export const AgentVersionManifestSchema = z
  .object({
    protocol: z.literal(AGENT_VERSION_PROTOCOL),
    schemaVersion: z.literal(1),
    snapshotDigest: Sha256HexSchema,
    behaviorContract: BehaviorContractSchema,
    runtimePolicy: RuntimePolicySchema,
    ioContract: IOContractSchema,
    codexRuntime: z
      .object({
        version: Utf8TextSchema(128),
        artifactDigest: Sha256DigestSchema,
        protocolSchemaDigest: Sha256DigestSchema,
        platform: z.literal('linux-arm64'),
      })
      .strict(),
    modelPolicy: ModelPolicySchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.runtimePolicy.resolvedModel !== manifest.modelPolicy.model) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modelPolicy', 'model'],
        message: 'modelPolicy.model 必须与 RuntimePolicy.resolvedModel 相同',
      });
    }
    if (manifest.runtimePolicy.reasoningEffort !== manifest.modelPolicy.reasoningEffort) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modelPolicy', 'reasoningEffort'],
        message: 'modelPolicy.reasoningEffort 必须与 RuntimePolicy 相同',
      });
    }
  });
export type AgentVersionManifest = z.infer<typeof AgentVersionManifestSchema>;

export interface AgentVersionDigests {
  snapshotDigest: string;
  behaviorContractDigest: string;
  runtimePolicyDigest: string;
  ioContractDigest: string;
  modelPolicyDigest: string;
  versionDigest: string;
}

export function computeAgentVersionDigests(manifest: AgentVersionManifest): AgentVersionDigests {
  const parsed = AgentVersionManifestSchema.parse(manifest);
  return {
    snapshotDigest: parsed.snapshotDigest,
    behaviorContractDigest: canonicalSha256(parsed.behaviorContract),
    runtimePolicyDigest: canonicalSha256(parsed.runtimePolicy),
    ioContractDigest: canonicalSha256(parsed.ioContract),
    modelPolicyDigest: canonicalSha256(parsed.modelPolicy),
    versionDigest: canonicalSha256(parsed),
  };
}
