import { isProxy } from 'node:util/types';

import { z } from 'zod';

import { canonicalFingerprint, canonicalizeJson } from './canonical.js';
import { Sha256DigestSchema, containsLoneSurrogate, type Sha256Digest } from './primitives.js';

export const CREATOR_AGENT_DEFINITION_PROTOCOL = 'combo.creator-agent-definition/1' as const;
export const CREATOR_AGENT_DRAFT_PROTOCOL = 'combo.creator-agent-draft/1' as const;
export const CREATOR_AGENT_DRAFT_HANDOFF_PROTOCOL = 'combo.creator-agent-draft-handoff/1' as const;
export const CREATOR_AGENT_VERSION_PROTOCOL = 'combo.creator-agent-version/1' as const;
export const CREATOR_AGENT_DEFINITION_V2_PROTOCOL = 'combo.creator-agent-definition/2' as const;
export const CREATOR_AGENT_DRAFT_V2_PROTOCOL = 'combo.creator-agent-draft/2' as const;
export const CREATOR_AGENT_DRAFT_HANDOFF_V2_PROTOCOL =
  'combo.creator-agent-draft-handoff/2' as const;
export const CREATOR_AGENT_VERSION_V2_PROTOCOL = 'combo.creator-agent-version/2' as const;
export const CREATOR_AGENT_DEFINITION_V3_PROTOCOL = 'combo.creator-agent-definition/3' as const;
export const CREATOR_AGENT_DRAFT_V3_PROTOCOL = 'combo.creator-agent-draft/3' as const;
export const CREATOR_AGENT_DRAFT_HANDOFF_V3_PROTOCOL =
  'combo.creator-agent-draft-handoff/3' as const;
export const CREATOR_AGENT_VERSION_V3_PROTOCOL = 'combo.creator-agent-version/3' as const;
export const CREATOR_AGENT_SOURCE_LEDGER_PROTOCOL =
  'combo.creator-agent-project-source-ledger/1' as const;
export const CREATOR_AGENT_MAX_CANONICAL_BYTES = 65_536;

const DEFINITION_FINGERPRINT_DOMAIN = 'combo.creator-agent-definition/1' as const;
const DRAFT_FINGERPRINT_DOMAIN = 'combo.creator-agent-draft/1' as const;
const VERSION_FINGERPRINT_DOMAIN = 'combo.creator-agent-version/1' as const;
const DEFINITION_V2_FINGERPRINT_DOMAIN = 'combo.creator-agent-definition/2' as const;
const DRAFT_V2_FINGERPRINT_DOMAIN = 'combo.creator-agent-draft/2' as const;
const VERSION_V2_FINGERPRINT_DOMAIN = 'combo.creator-agent-version/2' as const;
const DEFINITION_V3_FINGERPRINT_DOMAIN = 'combo.creator-agent-definition/3' as const;
const DRAFT_V3_FINGERPRINT_DOMAIN = 'combo.creator-agent-draft/3' as const;
const VERSION_V3_FINGERPRINT_DOMAIN = 'combo.creator-agent-version/3' as const;
const SOURCE_LEDGER_FINGERPRINT_DOMAIN = 'combo.creator-agent-project-source-ledger/1' as const;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REQUIREMENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u;

const IdentifierSchema = z.string().regex(IDENTIFIER_PATTERN);
const SafeText = (minimum: number, maximum: number) =>
  z
    .string()
    .min(minimum)
    .max(maximum)
    .refine(
      (value) => !containsLoneSurrogate(value) && !/[\0\r]/u.test(value),
      'Malformed or unsafe text is forbidden',
    );
const RequirementNameSchema = z.string().regex(REQUIREMENT_NAME_PATTERN);
const UniqueRequirementNamesSchema = z
  .array(RequirementNameSchema)
  .max(32)
  .superRefine(uniqueStrings)
  .readonly();

export const CreatorAgentProjectSnapshotSchema = z
  .object({
    kind: z.literal('git'),
    repositoryUrl: z
      .string()
      .max(160)
      .refine(isCanonicalGitHubRepository, 'GitHub repository URL is not canonical'),
    sourceRef: z.string().max(255).refine(isCanonicalHeadRef, 'Git source ref is unsafe'),
    commitSha: z.string().regex(GIT_SHA_PATTERN),
    treeSha: z.string().regex(GIT_SHA_PATTERN),
  })
  .strict()
  .readonly();
export type CreatorAgentProjectSnapshot = z.infer<typeof CreatorAgentProjectSnapshotSchema>;

const CreatorAgentBehaviorSchema = z
  .object({
    instructions: SafeText(1, 8_000),
    starterPrompts: z.array(SafeText(1, 1_000)).min(1).max(5).superRefine(uniqueStrings).readonly(),
  })
  .strict()
  .readonly();

const CreatorAgentRequirementsSchema = z
  .object({
    codexVersion: RequirementNameSchema.optional(),
    commands: UniqueRequirementNamesSchema,
    plugins: UniqueRequirementNamesSchema,
    environmentVariableNames: UniqueRequirementNamesSchema,
  })
  .strict()
  .readonly();

const CreatorAgentRuntimeSchema = z
  .object({
    contextProfile: z.literal('PROJECT_TREE_READ_ONLY_V1'),
    permissionProfile: z.literal('LOCAL_UNISOLATED_READ_ONLY_V1'),
    skills: z.array(z.never()).length(0).readonly(),
    dynamicTools: z.array(z.never()).length(0).readonly(),
    toolNetworkAccess: z.literal(false),
    output: z
      .object({
        kind: z.literal('text'),
        description: SafeText(1, 1_000),
      })
      .strict()
      .readonly(),
    turnTimeoutMs: z
      .number()
      .int()
      .min(10_000)
      .max(30 * 60_000),
  })
  .strict()
  .readonly();

const CreatorAgentBehaviorOnlyRuntimeSchema = z
  .object({
    contextProfile: z.literal('BEHAVIOR_ONLY_V1'),
    permissionProfile: z.literal('LOCAL_UNISOLATED_READ_ONLY_V1'),
    skills: z.array(z.never()).length(0).readonly(),
    dynamicTools: z.array(z.never()).length(0).readonly(),
    toolNetworkAccess: z.literal(false),
    output: z
      .object({
        kind: z.literal('text'),
        description: SafeText(1, 1_000),
      })
      .strict()
      .readonly(),
    turnTimeoutMs: z
      .number()
      .int()
      .min(10_000)
      .max(30 * 60_000),
  })
  .strict()
  .readonly();

const CreatorAgentAuthoringSourceSchema = z
  .object({
    kind: z.enum(['codex_current_task', 'manual']),
    rawStored: z.literal(false),
  })
  .strict()
  .readonly();

export const CreatorAgentDefinitionV1Schema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_DEFINITION_PROTOCOL),
    name: SafeText(1, 80),
    description: SafeText(1, 500),
    projectSnapshot: CreatorAgentProjectSnapshotSchema,
    behavior: CreatorAgentBehaviorSchema,
    requirements: CreatorAgentRequirementsSchema,
    authoringSource: CreatorAgentAuthoringSourceSchema,
    runtime: CreatorAgentRuntimeSchema,
  })
  .strict()
  .readonly();
export type CreatorAgentDefinitionV1 = z.infer<typeof CreatorAgentDefinitionV1Schema>;

const CreatorAgentSourceCitationSchema = z
  .object({
    path: SafeText(1, 512).refine(isSafeRelativeProjectPath, 'Project source path is unsafe'),
    digest: Sha256DigestSchema,
    executionAvailability: z.enum(['FIXED_GIT_TREE', 'AUTHORING_ONLY']),
  })
  .strict()
  .readonly();

type SourceCoverageValue = Readonly<{
  indexedEntryCount: number;
  indexedFileCount: number;
  indexedByteCount: number;
  hiddenEntryCount: number;
  trackedEntryCount: number;
  untrackedEntryCount: number;
  ignoredEntryCount: number;
  gitAdminEntryCount: number;
  authoringOnlyEntryCount: number;
}>;

const SourceCoverageSchema = z
  .object({
    indexedEntryCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    indexedFileCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    indexedByteCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    hiddenEntryCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    trackedEntryCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    untrackedEntryCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    ignoredEntryCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    gitAdminEntryCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    authoringOnlyEntryCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .superRefine(validateSourceCoverage)
  .readonly();

const creatorAgentSourceLedgerShape = {
  protocol: z.literal(CREATOR_AGENT_SOURCE_LEDGER_PROTOCOL),
  scanProfile: z.literal('FULL_PROJECT_READ_ONLY_V1'),
  rawStored: z.literal(false),
  contextRootDigest: Sha256DigestSchema,
  coverage: SourceCoverageSchema,
  citedSources: z
    .array(CreatorAgentSourceCitationSchema)
    .min(1)
    .max(32)
    .superRefine(uniqueSourcePaths)
    .readonly(),
} as const;
const CreatorAgentSourceLedgerWithoutFingerprintSchema = z
  .object(creatorAgentSourceLedgerShape)
  .strict()
  .superRefine(validateSourceLedgerCoverage)
  .readonly();
export const CreatorAgentProjectSourceLedgerSchema = z
  .object({ ...creatorAgentSourceLedgerShape, ledgerFingerprint: Sha256DigestSchema })
  .strict()
  .superRefine(validateSourceLedgerCoverage)
  .readonly();
export type CreatorAgentProjectSourceLedger = z.infer<typeof CreatorAgentProjectSourceLedgerSchema>;

const CreatorAgentAuthoringSourceV2Schema = z
  .object({
    kind: z.literal('project_context_compiler'),
    sourceLedger: CreatorAgentProjectSourceLedgerSchema,
  })
  .strict()
  .readonly();

export const CreatorAgentDefinitionV2Schema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_DEFINITION_V2_PROTOCOL),
    name: SafeText(1, 80),
    description: SafeText(1, 500),
    projectSnapshot: CreatorAgentProjectSnapshotSchema,
    behavior: CreatorAgentBehaviorSchema,
    requirements: CreatorAgentRequirementsSchema,
    authoringSource: CreatorAgentAuthoringSourceV2Schema,
    runtime: CreatorAgentRuntimeSchema,
  })
  .strict()
  .readonly();
export type CreatorAgentDefinitionV2 = z.infer<typeof CreatorAgentDefinitionV2Schema>;

export const CreatorAgentDefinitionV3Schema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_DEFINITION_V3_PROTOCOL),
    name: SafeText(1, 80),
    description: SafeText(1, 500),
    projectBinding: z
      .object({ kind: z.literal('none') })
      .strict()
      .readonly(),
    behavior: CreatorAgentBehaviorSchema,
    requirements: CreatorAgentRequirementsSchema,
    authoringSource: CreatorAgentAuthoringSourceV2Schema,
    runtime: CreatorAgentBehaviorOnlyRuntimeSchema,
  })
  .strict()
  .superRefine((definition, context) => {
    const { sourceLedger } = definition.authoringSource;
    if (
      sourceLedger.coverage.authoringOnlyEntryCount !== sourceLedger.coverage.indexedEntryCount ||
      sourceLedger.citedSources.some(
        ({ executionAvailability }) => executionAvailability !== 'AUTHORING_ONLY',
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Behavior-only Agent source evidence must be authoring-only',
      });
    }
  })
  .readonly();
export type CreatorAgentDefinitionV3 = z.infer<typeof CreatorAgentDefinitionV3Schema>;

const creatorAgentDraftShape = {
  protocol: z.literal(CREATOR_AGENT_DRAFT_PROTOCOL),
  agentId: IdentifierSchema,
  draftId: IdentifierSchema,
  draftRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  baseVersionId: IdentifierSchema.nullable(),
  definition: CreatorAgentDefinitionV1Schema,
  definitionFingerprint: Sha256DigestSchema,
} as const;
const CreatorAgentDraftWithoutFingerprintSchema = z
  .object(creatorAgentDraftShape)
  .strict()
  .readonly();
export const CreatorAgentDraftSnapshotV1Schema = z
  .object({ ...creatorAgentDraftShape, draftFingerprint: Sha256DigestSchema })
  .strict()
  .readonly();
export type CreatorAgentDraftSnapshotV1 = z.infer<typeof CreatorAgentDraftSnapshotV1Schema>;

export const CreatorAgentDraftHandoffV1Schema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_DRAFT_HANDOFF_PROTOCOL),
    intent: z.literal('import_local_draft'),
    draft: CreatorAgentDraftSnapshotV1Schema,
  })
  .strict()
  .readonly();
export type CreatorAgentDraftHandoffV1 = z.infer<typeof CreatorAgentDraftHandoffV1Schema>;

const CreatorAgentVersionSourceDraftSchema = z
  .object({
    draftId: IdentifierSchema,
    draftRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    draftFingerprint: Sha256DigestSchema,
  })
  .strict()
  .readonly();

const creatorAgentVersionShape = {
  protocol: z.literal(CREATOR_AGENT_VERSION_PROTOCOL),
  agentId: IdentifierSchema,
  versionId: IdentifierSchema,
  versionNumber: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  createdAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sourceDraft: CreatorAgentVersionSourceDraftSchema,
  definition: CreatorAgentDefinitionV1Schema,
  definitionFingerprint: Sha256DigestSchema,
} as const;
const CreatorAgentVersionWithoutFingerprintSchema = z
  .object(creatorAgentVersionShape)
  .strict()
  .readonly();
export const CreatorAgentVersionV1Schema = z
  .object({ ...creatorAgentVersionShape, versionFingerprint: Sha256DigestSchema })
  .strict()
  .readonly();
export type CreatorAgentVersionV1 = z.infer<typeof CreatorAgentVersionV1Schema>;

const creatorAgentDraftV2Shape = {
  protocol: z.literal(CREATOR_AGENT_DRAFT_V2_PROTOCOL),
  agentId: IdentifierSchema,
  draftId: IdentifierSchema,
  draftRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  baseVersionId: IdentifierSchema.nullable(),
  definition: CreatorAgentDefinitionV2Schema,
  definitionFingerprint: Sha256DigestSchema,
} as const;
const CreatorAgentDraftV2WithoutFingerprintSchema = z
  .object(creatorAgentDraftV2Shape)
  .strict()
  .readonly();
export const CreatorAgentDraftSnapshotV2Schema = z
  .object({ ...creatorAgentDraftV2Shape, draftFingerprint: Sha256DigestSchema })
  .strict()
  .readonly();
export type CreatorAgentDraftSnapshotV2 = z.infer<typeof CreatorAgentDraftSnapshotV2Schema>;

export const CreatorAgentDraftHandoffV2Schema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_DRAFT_HANDOFF_V2_PROTOCOL),
    intent: z.literal('import_project_context_draft'),
    draft: CreatorAgentDraftSnapshotV2Schema,
  })
  .strict()
  .readonly();
export type CreatorAgentDraftHandoffV2 = z.infer<typeof CreatorAgentDraftHandoffV2Schema>;

const creatorAgentVersionV2Shape = {
  protocol: z.literal(CREATOR_AGENT_VERSION_V2_PROTOCOL),
  agentId: IdentifierSchema,
  versionId: IdentifierSchema,
  versionNumber: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  createdAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sourceDraft: CreatorAgentVersionSourceDraftSchema,
  definition: CreatorAgentDefinitionV2Schema,
  definitionFingerprint: Sha256DigestSchema,
} as const;
const CreatorAgentVersionV2WithoutFingerprintSchema = z
  .object(creatorAgentVersionV2Shape)
  .strict()
  .readonly();
export const CreatorAgentVersionV2Schema = z
  .object({ ...creatorAgentVersionV2Shape, versionFingerprint: Sha256DigestSchema })
  .strict()
  .readonly();
export type CreatorAgentVersionV2 = z.infer<typeof CreatorAgentVersionV2Schema>;

const creatorAgentDraftV3Shape = {
  protocol: z.literal(CREATOR_AGENT_DRAFT_V3_PROTOCOL),
  agentId: IdentifierSchema,
  draftId: IdentifierSchema,
  draftRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  baseVersionId: IdentifierSchema.nullable(),
  definition: CreatorAgentDefinitionV3Schema,
  definitionFingerprint: Sha256DigestSchema,
} as const;
const CreatorAgentDraftV3WithoutFingerprintSchema = z
  .object(creatorAgentDraftV3Shape)
  .strict()
  .readonly();
export const CreatorAgentDraftSnapshotV3Schema = z
  .object({ ...creatorAgentDraftV3Shape, draftFingerprint: Sha256DigestSchema })
  .strict()
  .readonly();
export type CreatorAgentDraftSnapshotV3 = z.infer<typeof CreatorAgentDraftSnapshotV3Schema>;

export const CreatorAgentDraftHandoffV3Schema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_DRAFT_HANDOFF_V3_PROTOCOL),
    intent: z.literal('import_behavior_only_project_context_draft'),
    draft: CreatorAgentDraftSnapshotV3Schema,
  })
  .strict()
  .readonly();
export type CreatorAgentDraftHandoffV3 = z.infer<typeof CreatorAgentDraftHandoffV3Schema>;

const creatorAgentVersionV3Shape = {
  protocol: z.literal(CREATOR_AGENT_VERSION_V3_PROTOCOL),
  agentId: IdentifierSchema,
  versionId: IdentifierSchema,
  versionNumber: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  createdAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sourceDraft: CreatorAgentVersionSourceDraftSchema,
  definition: CreatorAgentDefinitionV3Schema,
  definitionFingerprint: Sha256DigestSchema,
} as const;
const CreatorAgentVersionV3WithoutFingerprintSchema = z
  .object(creatorAgentVersionV3Shape)
  .strict()
  .readonly();
export const CreatorAgentVersionV3Schema = z
  .object({ ...creatorAgentVersionV3Shape, versionFingerprint: Sha256DigestSchema })
  .strict()
  .readonly();
export type CreatorAgentVersionV3 = z.infer<typeof CreatorAgentVersionV3Schema>;

export type CreatorAgentDraftSnapshot =
  | CreatorAgentDraftSnapshotV1
  | CreatorAgentDraftSnapshotV2
  | CreatorAgentDraftSnapshotV3;
export type CreatorAgentDraftHandoff =
  | CreatorAgentDraftHandoffV1
  | CreatorAgentDraftHandoffV2
  | CreatorAgentDraftHandoffV3;
export type CreatorAgentVersion =
  | CreatorAgentVersionV1
  | CreatorAgentVersionV2
  | CreatorAgentVersionV3;

export type CreateCreatorAgentDraftSnapshotInput = Readonly<{
  agentId: string;
  draftId: string;
  draftRevision: number;
  baseVersionId: string | null;
  definition: unknown;
}>;

export type FreezeCreatorAgentVersionInput = Readonly<{
  versionId: string;
  versionNumber: number;
  createdAtMs: number;
  draft: unknown;
}>;

export type CreateCreatorAgentDraftHandoffInput = Readonly<{
  draft: unknown;
}>;

const CreateCreatorAgentDraftSnapshotInputSchema = z
  .object({
    agentId: IdentifierSchema,
    draftId: IdentifierSchema,
    draftRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    baseVersionId: IdentifierSchema.nullable(),
    definition: CreatorAgentDefinitionV1Schema,
  })
  .strict()
  .readonly();

const FreezeCreatorAgentVersionInputSchema = z
  .object({
    versionId: IdentifierSchema,
    versionNumber: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    createdAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    draft: CreatorAgentDraftSnapshotV1Schema,
  })
  .strict()
  .readonly();

const CreateCreatorAgentDraftHandoffInputSchema = z
  .object({ draft: CreatorAgentDraftSnapshotV1Schema })
  .strict()
  .readonly();

export type CreateCreatorAgentProjectSourceLedgerInput = Readonly<{
  contextRootDigest: string;
  coverage: unknown;
  citedSources: unknown;
}>;
export type CreateCreatorAgentDraftSnapshotV2Input = Readonly<{
  agentId: string;
  draftId: string;
  draftRevision: number;
  baseVersionId: string | null;
  definition: unknown;
}>;
export type FreezeCreatorAgentVersionV2Input = Readonly<{
  versionId: string;
  versionNumber: number;
  createdAtMs: number;
  draft: unknown;
}>;
export type CreateCreatorAgentDraftHandoffV2Input = Readonly<{
  draft: unknown;
}>;
export type CreateCreatorAgentDraftSnapshotV3Input = Readonly<{
  agentId: string;
  draftId: string;
  draftRevision: number;
  baseVersionId: string | null;
  definition: unknown;
}>;
export type FreezeCreatorAgentVersionV3Input = Readonly<{
  versionId: string;
  versionNumber: number;
  createdAtMs: number;
  draft: unknown;
}>;
export type CreateCreatorAgentDraftHandoffV3Input = Readonly<{
  draft: unknown;
}>;

const CreateCreatorAgentProjectSourceLedgerInputSchema = z
  .object({
    contextRootDigest: Sha256DigestSchema,
    coverage: SourceCoverageSchema,
    citedSources: z
      .array(CreatorAgentSourceCitationSchema)
      .min(1)
      .max(32)
      .superRefine(uniqueSourcePaths)
      .readonly(),
  })
  .strict()
  .readonly();
const CreateCreatorAgentDraftSnapshotV2InputSchema = z
  .object({
    agentId: IdentifierSchema,
    draftId: IdentifierSchema,
    draftRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    baseVersionId: IdentifierSchema.nullable(),
    definition: CreatorAgentDefinitionV2Schema,
  })
  .strict()
  .readonly();
const FreezeCreatorAgentVersionV2InputSchema = z
  .object({
    versionId: IdentifierSchema,
    versionNumber: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    createdAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    draft: CreatorAgentDraftSnapshotV2Schema,
  })
  .strict()
  .readonly();
const CreateCreatorAgentDraftHandoffV2InputSchema = z
  .object({ draft: CreatorAgentDraftSnapshotV2Schema })
  .strict()
  .readonly();
const CreateCreatorAgentDraftSnapshotV3InputSchema = z
  .object({
    agentId: IdentifierSchema,
    draftId: IdentifierSchema,
    draftRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    baseVersionId: IdentifierSchema.nullable(),
    definition: CreatorAgentDefinitionV3Schema,
  })
  .strict()
  .readonly();
const FreezeCreatorAgentVersionV3InputSchema = z
  .object({
    versionId: IdentifierSchema,
    versionNumber: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    createdAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    draft: CreatorAgentDraftSnapshotV3Schema,
  })
  .strict()
  .readonly();
const CreateCreatorAgentDraftHandoffV3InputSchema = z
  .object({ draft: CreatorAgentDraftSnapshotV3Schema })
  .strict()
  .readonly();
const FreezeCreatorAgentVersionAnyInputSchema = z
  .object({
    versionId: IdentifierSchema,
    versionNumber: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    createdAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    draft: z.union([
      CreatorAgentDraftSnapshotV1Schema,
      CreatorAgentDraftSnapshotV2Schema,
      CreatorAgentDraftSnapshotV3Schema,
    ]),
  })
  .strict()
  .readonly();

export function createCreatorAgentDefinition(input: unknown): CreatorAgentDefinitionV1 {
  return exactDetached(CreatorAgentDefinitionV1Schema, input, 'Agent definition');
}

export function fingerprintCreatorAgentDefinition(input: unknown): Sha256Digest {
  const definition = createCreatorAgentDefinition(input);
  return canonicalFingerprint(DEFINITION_FINGERPRINT_DOMAIN, definition);
}

export function createCreatorAgentDraftSnapshot(
  input: CreateCreatorAgentDraftSnapshotInput,
): CreatorAgentDraftSnapshotV1 {
  const snapshot = exactDetached(
    CreateCreatorAgentDraftSnapshotInputSchema,
    input,
    'Agent draft input',
  );
  const definition = createCreatorAgentDefinition(snapshot.definition);
  const definitionFingerprint = fingerprintCreatorAgentDefinition(definition);
  const withoutFingerprint = exactDetached(
    CreatorAgentDraftWithoutFingerprintSchema,
    {
      protocol: CREATOR_AGENT_DRAFT_PROTOCOL,
      agentId: snapshot.agentId,
      draftId: snapshot.draftId,
      draftRevision: snapshot.draftRevision,
      baseVersionId: snapshot.baseVersionId,
      definition,
      definitionFingerprint,
    },
    'Agent draft',
  );
  return exactDetached(
    CreatorAgentDraftSnapshotV1Schema,
    {
      ...withoutFingerprint,
      draftFingerprint: canonicalFingerprint(DRAFT_FINGERPRINT_DOMAIN, withoutFingerprint),
    },
    'Agent draft',
  );
}

export function verifyCreatorAgentDraftSnapshot(input: unknown): CreatorAgentDraftSnapshotV1 {
  const draft = exactDetached(CreatorAgentDraftSnapshotV1Schema, input, 'Agent draft');
  const definitionFingerprint = fingerprintCreatorAgentDefinition(draft.definition);
  if (draft.definitionFingerprint !== definitionFingerprint) {
    throw new TypeError('Agent draft definition fingerprint does not match');
  }
  const { draftFingerprint: _fingerprint, ...withoutFingerprint } = draft;
  const expected = canonicalFingerprint(DRAFT_FINGERPRINT_DOMAIN, withoutFingerprint);
  if (draft.draftFingerprint !== expected) {
    throw new TypeError('Agent draft fingerprint does not match');
  }
  return draft;
}

export function serializeCreatorAgentDraftSnapshot(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentDraftSnapshot(input));
}

export function createCreatorAgentDraftHandoff(
  input: CreateCreatorAgentDraftHandoffInput,
): CreatorAgentDraftHandoffV1 {
  const snapshot = exactDetached(
    CreateCreatorAgentDraftHandoffInputSchema,
    input,
    'Agent draft handoff input',
  );
  const draft = verifyCreatorAgentDraftSnapshot(snapshot.draft);
  return verifyCreatorAgentDraftHandoff({
    protocol: CREATOR_AGENT_DRAFT_HANDOFF_PROTOCOL,
    intent: 'import_local_draft',
    draft,
  });
}

export function verifyCreatorAgentDraftHandoff(input: unknown): CreatorAgentDraftHandoffV1 {
  const handoff = exactDetached(CreatorAgentDraftHandoffV1Schema, input, 'Agent draft handoff');
  const draft = verifyCreatorAgentDraftSnapshot(handoff.draft);
  if (
    draft.definition.authoringSource.kind !== 'codex_current_task' ||
    draft.definition.authoringSource.rawStored !== false
  ) {
    throw new TypeError('Agent draft handoff must come from visible Codex task context');
  }
  return exactDetached(
    CreatorAgentDraftHandoffV1Schema,
    { protocol: handoff.protocol, intent: handoff.intent, draft },
    'Agent draft handoff',
  );
}

export function serializeCreatorAgentDraftHandoff(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentDraftHandoff(input));
}

export function parseCreatorAgentDraftHandoff(text: string): CreatorAgentDraftHandoffV1 {
  if (typeof text !== 'string') throw new TypeError('Agent draft handoff must be JSON text');
  if (Buffer.byteLength(text, 'utf8') > CREATOR_AGENT_MAX_CANONICAL_BYTES) {
    throw new TypeError('Agent draft handoff exceeds the canonical byte limit');
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError('Agent draft handoff is not valid JSON');
  }
  const handoff = verifyCreatorAgentDraftHandoff(value);
  if (canonicalizeJson(handoff) !== text) {
    throw new TypeError('Agent draft handoff is not exact canonical JSON');
  }
  return handoff;
}

export function freezeCreatorAgentVersion(
  input: FreezeCreatorAgentVersionInput,
): CreatorAgentVersionV1 {
  const snapshot = exactDetached(
    FreezeCreatorAgentVersionInputSchema,
    input,
    'Agent version input',
  );
  const draft = verifyCreatorAgentDraftSnapshot(snapshot.draft);
  const withoutFingerprint = exactDetached(
    CreatorAgentVersionWithoutFingerprintSchema,
    {
      protocol: CREATOR_AGENT_VERSION_PROTOCOL,
      agentId: draft.agentId,
      versionId: snapshot.versionId,
      versionNumber: snapshot.versionNumber,
      createdAtMs: snapshot.createdAtMs,
      sourceDraft: {
        draftId: draft.draftId,
        draftRevision: draft.draftRevision,
        draftFingerprint: draft.draftFingerprint,
      },
      definition: draft.definition,
      definitionFingerprint: draft.definitionFingerprint,
    },
    'Agent version',
  );
  return exactDetached(
    CreatorAgentVersionV1Schema,
    {
      ...withoutFingerprint,
      versionFingerprint: canonicalFingerprint(VERSION_FINGERPRINT_DOMAIN, withoutFingerprint),
    },
    'Agent version',
  );
}

export function verifyCreatorAgentVersion(input: unknown): CreatorAgentVersionV1 {
  const version = exactDetached(CreatorAgentVersionV1Schema, input, 'Agent version');
  const definitionFingerprint = fingerprintCreatorAgentDefinition(version.definition);
  if (version.definitionFingerprint !== definitionFingerprint) {
    throw new TypeError('Agent version definition fingerprint does not match');
  }
  const { versionFingerprint: _fingerprint, ...withoutFingerprint } = version;
  const expected = canonicalFingerprint(VERSION_FINGERPRINT_DOMAIN, withoutFingerprint);
  if (version.versionFingerprint !== expected) {
    throw new TypeError('Agent version fingerprint does not match');
  }
  return version;
}

export function serializeCreatorAgentVersion(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentVersion(input));
}

export function parseCreatorAgentVersion(text: string): CreatorAgentVersionV1 {
  if (typeof text !== 'string') throw new TypeError('Agent version must be JSON text');
  if (Buffer.byteLength(text, 'utf8') > CREATOR_AGENT_MAX_CANONICAL_BYTES) {
    throw new TypeError('Agent version exceeds the canonical byte limit');
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError('Agent version is not valid JSON');
  }
  const version = verifyCreatorAgentVersion(value);
  if (canonicalizeJson(version) !== text) {
    throw new TypeError('Agent version is not exact canonical JSON');
  }
  return version;
}

export function createCreatorAgentProjectSourceLedger(
  input: CreateCreatorAgentProjectSourceLedgerInput,
): CreatorAgentProjectSourceLedger {
  const snapshot = exactDetached(
    CreateCreatorAgentProjectSourceLedgerInputSchema,
    input,
    'Agent Project source ledger input',
  );
  const withoutFingerprint = exactDetached(
    CreatorAgentSourceLedgerWithoutFingerprintSchema,
    {
      protocol: CREATOR_AGENT_SOURCE_LEDGER_PROTOCOL,
      scanProfile: 'FULL_PROJECT_READ_ONLY_V1',
      rawStored: false,
      contextRootDigest: snapshot.contextRootDigest,
      coverage: snapshot.coverage,
      citedSources: snapshot.citedSources,
    },
    'Agent Project source ledger',
  );
  return exactDetached(
    CreatorAgentProjectSourceLedgerSchema,
    {
      ...withoutFingerprint,
      ledgerFingerprint: canonicalFingerprint(SOURCE_LEDGER_FINGERPRINT_DOMAIN, withoutFingerprint),
    },
    'Agent Project source ledger',
  );
}

export function verifyCreatorAgentProjectSourceLedger(
  input: unknown,
): CreatorAgentProjectSourceLedger {
  const ledger = exactDetached(
    CreatorAgentProjectSourceLedgerSchema,
    input,
    'Agent Project source ledger',
  );
  const { ledgerFingerprint: _fingerprint, ...withoutFingerprint } = ledger;
  if (
    ledger.ledgerFingerprint !==
    canonicalFingerprint(SOURCE_LEDGER_FINGERPRINT_DOMAIN, withoutFingerprint)
  ) {
    throw new TypeError('Agent Project source ledger fingerprint does not match');
  }
  return ledger;
}

export function createCreatorAgentDefinitionV2(input: unknown): CreatorAgentDefinitionV2 {
  const definition = exactDetached(CreatorAgentDefinitionV2Schema, input, 'Agent definition v2');
  verifyCreatorAgentProjectSourceLedger(definition.authoringSource.sourceLedger);
  return definition;
}

export function fingerprintCreatorAgentDefinitionV2(input: unknown): Sha256Digest {
  return canonicalFingerprint(
    DEFINITION_V2_FINGERPRINT_DOMAIN,
    createCreatorAgentDefinitionV2(input),
  );
}

export function createCreatorAgentDraftSnapshotV2(
  input: CreateCreatorAgentDraftSnapshotV2Input,
): CreatorAgentDraftSnapshotV2 {
  const snapshot = exactDetached(
    CreateCreatorAgentDraftSnapshotV2InputSchema,
    input,
    'Agent draft v2 input',
  );
  const definition = createCreatorAgentDefinitionV2(snapshot.definition);
  const withoutFingerprint = exactDetached(
    CreatorAgentDraftV2WithoutFingerprintSchema,
    {
      protocol: CREATOR_AGENT_DRAFT_V2_PROTOCOL,
      agentId: snapshot.agentId,
      draftId: snapshot.draftId,
      draftRevision: snapshot.draftRevision,
      baseVersionId: snapshot.baseVersionId,
      definition,
      definitionFingerprint: fingerprintCreatorAgentDefinitionV2(definition),
    },
    'Agent draft v2',
  );
  return exactDetached(
    CreatorAgentDraftSnapshotV2Schema,
    {
      ...withoutFingerprint,
      draftFingerprint: canonicalFingerprint(DRAFT_V2_FINGERPRINT_DOMAIN, withoutFingerprint),
    },
    'Agent draft v2',
  );
}

export function verifyCreatorAgentDraftSnapshotV2(input: unknown): CreatorAgentDraftSnapshotV2 {
  const draft = exactDetached(CreatorAgentDraftSnapshotV2Schema, input, 'Agent draft v2');
  if (draft.definitionFingerprint !== fingerprintCreatorAgentDefinitionV2(draft.definition)) {
    throw new TypeError('Agent draft v2 definition fingerprint does not match');
  }
  const { draftFingerprint: _fingerprint, ...withoutFingerprint } = draft;
  if (
    draft.draftFingerprint !== canonicalFingerprint(DRAFT_V2_FINGERPRINT_DOMAIN, withoutFingerprint)
  ) {
    throw new TypeError('Agent draft v2 fingerprint does not match');
  }
  return draft;
}

export function createCreatorAgentDraftHandoffV2(
  input: CreateCreatorAgentDraftHandoffV2Input,
): CreatorAgentDraftHandoffV2 {
  const snapshot = exactDetached(
    CreateCreatorAgentDraftHandoffV2InputSchema,
    input,
    'Agent draft handoff v2 input',
  );
  const draft = verifyCreatorAgentDraftSnapshotV2(snapshot.draft);
  return verifyCreatorAgentDraftHandoffV2({
    protocol: CREATOR_AGENT_DRAFT_HANDOFF_V2_PROTOCOL,
    intent: 'import_project_context_draft',
    draft,
  });
}

export function verifyCreatorAgentDraftHandoffV2(input: unknown): CreatorAgentDraftHandoffV2 {
  const handoff = exactDetached(CreatorAgentDraftHandoffV2Schema, input, 'Agent draft handoff v2');
  const draft = verifyCreatorAgentDraftSnapshotV2(handoff.draft);
  return exactDetached(
    CreatorAgentDraftHandoffV2Schema,
    { protocol: handoff.protocol, intent: handoff.intent, draft },
    'Agent draft handoff v2',
  );
}

export function serializeCreatorAgentDraftHandoffV2(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentDraftHandoffV2(input));
}

export function parseCreatorAgentDraftHandoffV2(text: string): CreatorAgentDraftHandoffV2 {
  const value = parseCanonicalAgentJson(text, 'Agent draft handoff v2');
  const handoff = verifyCreatorAgentDraftHandoffV2(value);
  if (canonicalizeJson(handoff) !== text) {
    throw new TypeError('Agent draft handoff v2 is not exact canonical JSON');
  }
  return handoff;
}

export function freezeCreatorAgentVersionV2(
  input: FreezeCreatorAgentVersionV2Input,
): CreatorAgentVersionV2 {
  const snapshot = exactDetached(
    FreezeCreatorAgentVersionV2InputSchema,
    input,
    'Agent version v2 input',
  );
  const draft = verifyCreatorAgentDraftSnapshotV2(snapshot.draft);
  const withoutFingerprint = exactDetached(
    CreatorAgentVersionV2WithoutFingerprintSchema,
    {
      protocol: CREATOR_AGENT_VERSION_V2_PROTOCOL,
      agentId: draft.agentId,
      versionId: snapshot.versionId,
      versionNumber: snapshot.versionNumber,
      createdAtMs: snapshot.createdAtMs,
      sourceDraft: {
        draftId: draft.draftId,
        draftRevision: draft.draftRevision,
        draftFingerprint: draft.draftFingerprint,
      },
      definition: draft.definition,
      definitionFingerprint: draft.definitionFingerprint,
    },
    'Agent version v2',
  );
  return exactDetached(
    CreatorAgentVersionV2Schema,
    {
      ...withoutFingerprint,
      versionFingerprint: canonicalFingerprint(VERSION_V2_FINGERPRINT_DOMAIN, withoutFingerprint),
    },
    'Agent version v2',
  );
}

export function verifyCreatorAgentVersionV2(input: unknown): CreatorAgentVersionV2 {
  const version = exactDetached(CreatorAgentVersionV2Schema, input, 'Agent version v2');
  if (version.definitionFingerprint !== fingerprintCreatorAgentDefinitionV2(version.definition)) {
    throw new TypeError('Agent version v2 definition fingerprint does not match');
  }
  const { versionFingerprint: _fingerprint, ...withoutFingerprint } = version;
  if (
    version.versionFingerprint !==
    canonicalFingerprint(VERSION_V2_FINGERPRINT_DOMAIN, withoutFingerprint)
  ) {
    throw new TypeError('Agent version v2 fingerprint does not match');
  }
  return version;
}

export function serializeCreatorAgentVersionV2(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentVersionV2(input));
}

export function parseCreatorAgentVersionV2(text: string): CreatorAgentVersionV2 {
  const value = parseCanonicalAgentJson(text, 'Agent version v2');
  const version = verifyCreatorAgentVersionV2(value);
  if (canonicalizeJson(version) !== text) {
    throw new TypeError('Agent version v2 is not exact canonical JSON');
  }
  return version;
}

export function createCreatorAgentDefinitionV3(input: unknown): CreatorAgentDefinitionV3 {
  const definition = exactDetached(CreatorAgentDefinitionV3Schema, input, 'Agent definition v3');
  verifyCreatorAgentProjectSourceLedger(definition.authoringSource.sourceLedger);
  return definition;
}

export function fingerprintCreatorAgentDefinitionV3(input: unknown): Sha256Digest {
  return canonicalFingerprint(
    DEFINITION_V3_FINGERPRINT_DOMAIN,
    createCreatorAgentDefinitionV3(input),
  );
}

export function createCreatorAgentDraftSnapshotV3(
  input: CreateCreatorAgentDraftSnapshotV3Input,
): CreatorAgentDraftSnapshotV3 {
  const snapshot = exactDetached(
    CreateCreatorAgentDraftSnapshotV3InputSchema,
    input,
    'Agent draft v3 input',
  );
  const definition = createCreatorAgentDefinitionV3(snapshot.definition);
  const withoutFingerprint = exactDetached(
    CreatorAgentDraftV3WithoutFingerprintSchema,
    {
      protocol: CREATOR_AGENT_DRAFT_V3_PROTOCOL,
      agentId: snapshot.agentId,
      draftId: snapshot.draftId,
      draftRevision: snapshot.draftRevision,
      baseVersionId: snapshot.baseVersionId,
      definition,
      definitionFingerprint: fingerprintCreatorAgentDefinitionV3(definition),
    },
    'Agent draft v3',
  );
  return exactDetached(
    CreatorAgentDraftSnapshotV3Schema,
    {
      ...withoutFingerprint,
      draftFingerprint: canonicalFingerprint(DRAFT_V3_FINGERPRINT_DOMAIN, withoutFingerprint),
    },
    'Agent draft v3',
  );
}

export function verifyCreatorAgentDraftSnapshotV3(input: unknown): CreatorAgentDraftSnapshotV3 {
  const draft = exactDetached(CreatorAgentDraftSnapshotV3Schema, input, 'Agent draft v3');
  if (draft.definitionFingerprint !== fingerprintCreatorAgentDefinitionV3(draft.definition)) {
    throw new TypeError('Agent draft v3 definition fingerprint does not match');
  }
  const { draftFingerprint: _fingerprint, ...withoutFingerprint } = draft;
  if (
    draft.draftFingerprint !== canonicalFingerprint(DRAFT_V3_FINGERPRINT_DOMAIN, withoutFingerprint)
  ) {
    throw new TypeError('Agent draft v3 fingerprint does not match');
  }
  return draft;
}

export function createCreatorAgentDraftHandoffV3(
  input: CreateCreatorAgentDraftHandoffV3Input,
): CreatorAgentDraftHandoffV3 {
  const snapshot = exactDetached(
    CreateCreatorAgentDraftHandoffV3InputSchema,
    input,
    'Agent draft handoff v3 input',
  );
  const draft = verifyCreatorAgentDraftSnapshotV3(snapshot.draft);
  return verifyCreatorAgentDraftHandoffV3({
    protocol: CREATOR_AGENT_DRAFT_HANDOFF_V3_PROTOCOL,
    intent: 'import_behavior_only_project_context_draft',
    draft,
  });
}

export function verifyCreatorAgentDraftHandoffV3(input: unknown): CreatorAgentDraftHandoffV3 {
  const handoff = exactDetached(CreatorAgentDraftHandoffV3Schema, input, 'Agent draft handoff v3');
  const draft = verifyCreatorAgentDraftSnapshotV3(handoff.draft);
  return exactDetached(
    CreatorAgentDraftHandoffV3Schema,
    { protocol: handoff.protocol, intent: handoff.intent, draft },
    'Agent draft handoff v3',
  );
}

export function serializeCreatorAgentDraftHandoffV3(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentDraftHandoffV3(input));
}

export function parseCreatorAgentDraftHandoffV3(text: string): CreatorAgentDraftHandoffV3 {
  const value = parseCanonicalAgentJson(text, 'Agent draft handoff v3');
  const handoff = verifyCreatorAgentDraftHandoffV3(value);
  if (canonicalizeJson(handoff) !== text) {
    throw new TypeError('Agent draft handoff v3 is not exact canonical JSON');
  }
  return handoff;
}

export function freezeCreatorAgentVersionV3(
  input: FreezeCreatorAgentVersionV3Input,
): CreatorAgentVersionV3 {
  const snapshot = exactDetached(
    FreezeCreatorAgentVersionV3InputSchema,
    input,
    'Agent version v3 input',
  );
  const draft = verifyCreatorAgentDraftSnapshotV3(snapshot.draft);
  const withoutFingerprint = exactDetached(
    CreatorAgentVersionV3WithoutFingerprintSchema,
    {
      protocol: CREATOR_AGENT_VERSION_V3_PROTOCOL,
      agentId: draft.agentId,
      versionId: snapshot.versionId,
      versionNumber: snapshot.versionNumber,
      createdAtMs: snapshot.createdAtMs,
      sourceDraft: {
        draftId: draft.draftId,
        draftRevision: draft.draftRevision,
        draftFingerprint: draft.draftFingerprint,
      },
      definition: draft.definition,
      definitionFingerprint: draft.definitionFingerprint,
    },
    'Agent version v3',
  );
  return exactDetached(
    CreatorAgentVersionV3Schema,
    {
      ...withoutFingerprint,
      versionFingerprint: canonicalFingerprint(VERSION_V3_FINGERPRINT_DOMAIN, withoutFingerprint),
    },
    'Agent version v3',
  );
}

export function verifyCreatorAgentVersionV3(input: unknown): CreatorAgentVersionV3 {
  const version = exactDetached(CreatorAgentVersionV3Schema, input, 'Agent version v3');
  if (version.definitionFingerprint !== fingerprintCreatorAgentDefinitionV3(version.definition)) {
    throw new TypeError('Agent version v3 definition fingerprint does not match');
  }
  const { versionFingerprint: _fingerprint, ...withoutFingerprint } = version;
  if (
    version.versionFingerprint !==
    canonicalFingerprint(VERSION_V3_FINGERPRINT_DOMAIN, withoutFingerprint)
  ) {
    throw new TypeError('Agent version v3 fingerprint does not match');
  }
  return version;
}

export function serializeCreatorAgentVersionV3(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentVersionV3(input));
}

export function parseCreatorAgentVersionV3(text: string): CreatorAgentVersionV3 {
  const value = parseCanonicalAgentJson(text, 'Agent version v3');
  const version = verifyCreatorAgentVersionV3(value);
  if (canonicalizeJson(version) !== text) {
    throw new TypeError('Agent version v3 is not exact canonical JSON');
  }
  return version;
}

export function parseCreatorAgentDraftHandoffAny(text: string): CreatorAgentDraftHandoff {
  const value = parseCanonicalAgentJson(text, 'Agent draft handoff');
  if (protocolValue(value) === CREATOR_AGENT_DRAFT_HANDOFF_V3_PROTOCOL) {
    return parseCreatorAgentDraftHandoffV3(text);
  }
  if (protocolValue(value) === CREATOR_AGENT_DRAFT_HANDOFF_V2_PROTOCOL) {
    return parseCreatorAgentDraftHandoffV2(text);
  }
  return parseCreatorAgentDraftHandoff(text);
}

export function serializeCreatorAgentDraftHandoffAny(input: unknown): string {
  if (protocolValue(input) === CREATOR_AGENT_DRAFT_HANDOFF_V3_PROTOCOL) {
    return serializeCreatorAgentDraftHandoffV3(input);
  }
  if (protocolValue(input) === CREATOR_AGENT_DRAFT_HANDOFF_V2_PROTOCOL) {
    return serializeCreatorAgentDraftHandoffV2(input);
  }
  return serializeCreatorAgentDraftHandoff(input);
}

export function serializeCreatorAgentDraftSnapshotAny(input: unknown): string {
  if (protocolValue(input) === CREATOR_AGENT_DRAFT_V3_PROTOCOL) {
    return canonicalizeJson(verifyCreatorAgentDraftSnapshotV3(input));
  }
  if (protocolValue(input) === CREATOR_AGENT_DRAFT_V2_PROTOCOL) {
    return canonicalizeJson(verifyCreatorAgentDraftSnapshotV2(input));
  }
  return serializeCreatorAgentDraftSnapshot(input);
}

export function parseCreatorAgentVersionAny(text: string): CreatorAgentVersion {
  const value = parseCanonicalAgentJson(text, 'Agent version');
  if (protocolValue(value) === CREATOR_AGENT_VERSION_V3_PROTOCOL) {
    return parseCreatorAgentVersionV3(text);
  }
  if (protocolValue(value) === CREATOR_AGENT_VERSION_V2_PROTOCOL) {
    return parseCreatorAgentVersionV2(text);
  }
  return parseCreatorAgentVersion(text);
}

export function serializeCreatorAgentVersionAny(input: unknown): string {
  if (protocolValue(input) === CREATOR_AGENT_VERSION_V3_PROTOCOL) {
    return serializeCreatorAgentVersionV3(input);
  }
  if (protocolValue(input) === CREATOR_AGENT_VERSION_V2_PROTOCOL) {
    return serializeCreatorAgentVersionV2(input);
  }
  return serializeCreatorAgentVersion(input);
}

export function freezeCreatorAgentVersionAny(
  input: Readonly<{
    versionId: string;
    versionNumber: number;
    createdAtMs: number;
    draft: unknown;
  }>,
): CreatorAgentVersion {
  const snapshot = exactDetached(
    FreezeCreatorAgentVersionAnyInputSchema,
    input,
    'Agent version input',
  );
  if (protocolValue(snapshot.draft) === CREATOR_AGENT_DRAFT_V3_PROTOCOL) {
    return freezeCreatorAgentVersionV3(snapshot);
  }
  if (protocolValue(snapshot.draft) === CREATOR_AGENT_DRAFT_V2_PROTOCOL) {
    return freezeCreatorAgentVersionV2(snapshot);
  }
  return freezeCreatorAgentVersion(snapshot);
}

function parseCanonicalAgentJson(text: string, label: string): unknown {
  if (typeof text !== 'string') throw new TypeError(`${label} must be JSON text`);
  if (Buffer.byteLength(text, 'utf8') > CREATOR_AGENT_MAX_CANONICAL_BYTES) {
    throw new TypeError(`${label} exceeds the canonical byte limit`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new TypeError(`${label} is not valid JSON`);
  }
}

function protocolValue(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || isProxy(input)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(input, 'protocol');
  return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor
    ? descriptor.value
    : undefined;
}

function exactDetached<Schema extends z.ZodTypeAny>(
  schema: Schema,
  input: unknown,
  label: string,
): z.output<Schema> {
  preflightAgentValue(input);
  const before = canonicalizeJson(input);
  if (Buffer.byteLength(before, 'utf8') > CREATOR_AGENT_MAX_CANONICAL_BYTES) {
    throw new TypeError('Agent value exceeds the canonical byte limit');
  }
  const parsed = schema.parse(input);
  if (canonicalizeJson(parsed) !== before) {
    throw new TypeError(`${label} changed during schema parsing`);
  }
  deepFreeze(parsed);
  return parsed;
}

function preflightAgentValue(input: unknown): void {
  const pending: Array<Readonly<{ value: unknown; depth: number; ancestors: readonly object[] }>> =
    [{ value: input, depth: 0, ancestors: [] }];
  let nodes = 0;
  let approximateBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    nodes += 1;
    if (nodes > 4_096 || current.depth > 32) {
      throw new TypeError('Agent value exceeds the canonical complexity limit');
    }
    const { value } = current;
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError('Agent value contains a non-finite number');
      continue;
    }
    if (typeof value === 'string') {
      approximateBytes += Buffer.byteLength(value, 'utf8');
      if (approximateBytes > CREATOR_AGENT_MAX_CANONICAL_BYTES) {
        throw new TypeError('Agent value exceeds the canonical byte limit');
      }
      continue;
    }
    if (typeof value !== 'object') throw new TypeError('Agent value is not canonical JSON');
    if (isProxy(value)) throw new TypeError('Agent value must not contain Proxy objects');
    if (current.ancestors.includes(value)) throw new TypeError('Agent value contains a cycle');
    const childAncestors = [...current.ancestors, value];
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
      throw new TypeError('Agent value must contain only plain JSON objects');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) {
      throw new TypeError('Agent value contains a symbol key');
    }
    if (
      Array.isArray(value) &&
      (keys.filter((key) => key !== 'length').length !== value.length ||
        keys.filter((key) => key !== 'length').some((key, index) => key !== String(index)))
    ) {
      throw new TypeError('Agent value must contain only dense arrays');
    }
    for (const key of keys) {
      if (key === 'length' && Array.isArray(value)) continue;
      approximateBytes += Buffer.byteLength(key as string, 'utf8');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('Agent value properties must be enumerable data properties');
      }
      pending.push({
        value: descriptor.value,
        depth: current.depth + 1,
        ancestors: childAncestors,
      });
    }
  }
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if (!Object.isFrozen(value)) Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}

function uniqueStrings(values: readonly string[], context: z.RefinementCtx): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Values must be unique' });
  }
}

function uniqueSourcePaths(
  values: readonly Readonly<{ path: string }>[],
  context: z.RefinementCtx,
): void {
  if (new Set(values.map(({ path }) => path)).size !== values.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Source paths must be unique' });
  }
}

function validateSourceCoverage(coverage: SourceCoverageValue, context: z.RefinementCtx): void {
  const entryBoundCounts = [
    coverage.indexedFileCount,
    coverage.hiddenEntryCount,
    coverage.trackedEntryCount,
    coverage.untrackedEntryCount,
    coverage.ignoredEntryCount,
    coverage.gitAdminEntryCount,
    coverage.authoringOnlyEntryCount,
  ];
  if (entryBoundCounts.some((count) => count > coverage.indexedEntryCount)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Source coverage count exceeds indexed entries',
    });
  }
  if (
    coverage.trackedEntryCount +
      coverage.untrackedEntryCount +
      coverage.ignoredEntryCount +
      coverage.gitAdminEntryCount >
    coverage.indexedEntryCount
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Source coverage Git classes exceed indexed entries',
    });
  }
  if (
    coverage.untrackedEntryCount + coverage.ignoredEntryCount + coverage.gitAdminEntryCount >
    coverage.authoringOnlyEntryCount
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Source coverage authoring-only count is inconsistent',
    });
  }
  if (coverage.trackedEntryCount + coverage.authoringOnlyEntryCount < coverage.indexedEntryCount) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Source coverage leaves entries without execution availability',
    });
  }
  if (coverage.indexedFileCount === 0 && coverage.indexedByteCount !== 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Source coverage bytes require at least one indexed file',
    });
  }
}

function validateSourceLedgerCoverage(
  ledger: Readonly<{
    coverage: SourceCoverageValue;
    citedSources: readonly z.infer<typeof CreatorAgentSourceCitationSchema>[];
  }>,
  context: z.RefinementCtx,
): void {
  const fixedCount = ledger.citedSources.filter(
    ({ executionAvailability }) => executionAvailability === 'FIXED_GIT_TREE',
  ).length;
  const authoringOnlyCount = ledger.citedSources.length - fixedCount;
  if (
    ledger.citedSources.length > ledger.coverage.indexedEntryCount ||
    fixedCount > ledger.coverage.trackedEntryCount ||
    authoringOnlyCount > ledger.coverage.authoringOnlyEntryCount
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Source citations exceed their declared coverage',
    });
  }
}

function isSafeRelativeProjectPath(value: string): boolean {
  return (
    !value.startsWith('/') &&
    !value.startsWith('\\') &&
    !value.includes('\\') &&
    !value.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  );
}

function isCanonicalGitHubRepository(value: string): boolean {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\.git$/u.exec(value);
  if (match === null) return false;
  const owner = match[1] ?? '';
  const repository = match[2] ?? '';
  return (
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(owner) &&
    /^[A-Za-z0-9._-]{1,100}$/u.test(repository) &&
    repository !== '.' &&
    repository !== '..' &&
    !repository.toLowerCase().endsWith('.git')
  );
}

function isCanonicalHeadRef(value: string): boolean {
  if (!value.startsWith('refs/heads/')) return false;
  const branch = value.slice('refs/heads/'.length);
  if (
    branch.length === 0 ||
    branch === '@' ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.includes('..') ||
    branch.includes('//') ||
    branch.includes('@{') ||
    containsForbiddenGitRefCharacter(branch)
  ) {
    return false;
  }
  return branch.split('/').every((component) => {
    return component.length > 0 && !component.startsWith('.') && !component.endsWith('.lock');
  });
}

function containsForbiddenGitRefCharacter(value: string): boolean {
  const punctuation = new Set(['~', '^', ':', '?', '*', '[', '\\']);
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || punctuation.has(character)) return true;
  }
  return false;
}
