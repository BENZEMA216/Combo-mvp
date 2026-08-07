import { z } from 'zod';
import { IsoDateTimeSchema } from '../core/ids.js';
import { ArtifactViewSchema, TerminalTurnErrorCodeSchema } from './trial.js';
import { CapabilityDefinitionSchema, CapabilityInputFieldSchema } from './capability.js';

export const AGENT_SCHEMA_VERSION = 'combo.agent/1' as const;
/** 历史编译器版本必须保留；current 只决定新 Revision，不能让旧 Release 失效。 */
export const AGENT_COMPILER_VERSIONS = ['combo-agent-compiler/1'] as const;
export const AGENT_COMPILER_VERSION = AGENT_COMPILER_VERSIONS[0];
export const AgentResourceIdSchema = z.string().uuid();

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export type Sha256 = z.infer<typeof Sha256Schema>;

export const AgentCapabilityBindingSchema = z
  .object({
    capabilityId: AgentResourceIdSchema,
    role: z.enum(['entry', 'support']),
  })
  .strict();
export type AgentCapabilityBinding = z.infer<typeof AgentCapabilityBindingSchema>;

export const AgentOutputSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('text') }).strict(),
    z
      .object({
        type: z.literal('structured'),
        schema: z.record(z.string(), z.unknown()),
      })
      .strict(),
  ])
  .describe('Agent 对外输出约定；V1 Runtime 仍以文本承载 structured JSON');
export type AgentOutput = z.infer<typeof AgentOutputSchema>;

export const AgentDefinitionSchema = z
  .object({
    schemaVersion: z.literal(AGENT_SCHEMA_VERSION),
    identity: z
      .object({
        name: z.string().trim().min(1).max(120),
        summary: z.string().trim().max(1_000).default(''),
      })
      .strict(),
    interface: z
      .object({
        inputs: z.array(CapabilityInputFieldSchema).max(50).default([]),
        output: AgentOutputSchema,
        starterPrompts: z.array(z.string().trim().min(1).max(2_000)).max(20).default([]),
      })
      .strict(),
    behavior: z
      .object({
        instructions: z.string().trim().min(1).max(200_000),
        capabilities: z.array(AgentCapabilityBindingSchema).min(1).max(20),
      })
      .strict(),
    ui: z
      .object({
        kind: z.literal('miniapp-html'),
        artifactId: AgentResourceIdSchema,
        bridgeVersion: z.literal(1),
      })
      .strict(),
    runtime: z.object({ mode: z.literal('single-loop') }).strict(),
  })
  .strict()
  .superRefine((definition, ctx) => {
    const entryCount = definition.behavior.capabilities.filter(
      (binding) => binding.role === 'entry',
    ).length;
    if (entryCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['behavior', 'capabilities'],
        message: 'V1 Agent 必须且只能绑定一个 entry Capability',
      });
    }
    const ids = definition.behavior.capabilities.map((binding) => binding.capabilityId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['behavior', 'capabilities'],
        message: '同一个 Capability 不能重复绑定',
      });
    }
  });
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export const AgentCapabilitySnapshotSchema = z
  .object({
    capabilityId: AgentResourceIdSchema,
    role: z.enum(['entry', 'support']),
    definitionSha256: Sha256Schema,
    definition: CapabilityDefinitionSchema,
  })
  .strict();
export type AgentCapabilitySnapshot = z.infer<typeof AgentCapabilitySnapshotSchema>;

export const AgentRuntimeBundleSchema = z
  .object({
    version: z.literal(1),
    compilerVersion: z.enum(AGENT_COMPILER_VERSIONS),
    projectId: AgentResourceIdSchema,
    revisionId: AgentResourceIdSchema,
    entryCapabilityId: AgentResourceIdSchema,
    definition: CapabilityDefinitionSchema,
    capabilityHashes: z.array(
      z
        .object({
          capabilityId: AgentResourceIdSchema,
          role: z.enum(['entry', 'support']),
          definitionSha256: Sha256Schema,
        })
        .strict(),
    ),
    ui: z
      .object({
        artifactId: AgentResourceIdSchema,
        storageKey: z.string().min(1),
        sha256: Sha256Schema,
        bridgeVersion: z.literal(1),
      })
      .strict(),
  })
  .strict();
export type AgentRuntimeBundle = z.infer<typeof AgentRuntimeBundleSchema>;

export const AgentProjectStatusSchema = z.enum(['active', 'archived']);
export type AgentProjectStatus = z.infer<typeof AgentProjectStatusSchema>;

export const AgentProjectViewSchema = z
  .object({
    id: AgentResourceIdSchema,
    name: z.string(),
    summary: z.string(),
    sourceTaskId: AgentResourceIdSchema.nullable(),
    status: AgentProjectStatusSchema,
    headRevisionId: AgentResourceIdSchema.nullable(),
    currentReleaseId: AgentResourceIdSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type AgentProjectView = z.infer<typeof AgentProjectViewSchema>;

export const CreateAgentProjectBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    summary: z.string().trim().max(1_000).default(''),
    sourceTaskId: AgentResourceIdSchema.optional(),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();
export type CreateAgentProjectBody = z.infer<typeof CreateAgentProjectBodySchema>;

export const CommitAgentRevisionBodySchema = z
  .object({
    expectedHeadRevisionId: AgentResourceIdSchema.nullable(),
    mutationId: z.string().trim().min(8).max(200),
    changeSummary: z.string().trim().min(1).max(1_000),
    definition: AgentDefinitionSchema,
  })
  .strict();
export type CommitAgentRevisionBody = z.infer<typeof CommitAgentRevisionBodySchema>;

export const AgentRevisionViewSchema = z
  .object({
    id: AgentResourceIdSchema,
    projectId: AgentResourceIdSchema,
    revisionNumber: z.number().int().positive(),
    parentRevisionId: AgentResourceIdSchema.nullable(),
    entryCapabilityId: AgentResourceIdSchema,
    definitionSha256: Sha256Schema,
    runtimeBundleSha256: Sha256Schema,
    uiArtifactId: AgentResourceIdSchema,
    uiSha256: Sha256Schema,
    compilerVersion: z.string().min(1),
    changeSummary: z.string(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type AgentRevisionView = z.infer<typeof AgentRevisionViewSchema>;

export const AgentRevisionDetailSchema = z
  .object({
    revision: AgentRevisionViewSchema,
    definition: AgentDefinitionSchema,
    capabilitySnapshots: z.array(AgentCapabilitySnapshotSchema),
    runtimeBundle: AgentRuntimeBundleSchema,
  })
  .strict();
export type AgentRevisionDetail = z.infer<typeof AgentRevisionDetailSchema>;

export const AgentProjectDetailSchema = z
  .object({
    project: AgentProjectViewSchema,
    headRevision: AgentRevisionViewSchema.nullable(),
    currentRelease: z.lazy(() => AgentReleaseViewSchema).nullable(),
  })
  .strict();
export type AgentProjectDetail = z.infer<typeof AgentProjectDetailSchema>;

export const SaveAgentUiRevisionBodySchema = z
  .object({
    html: z.string().min(1).max(1_000_000),
    title: z.string().trim().min(1).max(120).default('Agent Miniapp'),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();
export type SaveAgentUiRevisionBody = z.infer<typeof SaveAgentUiRevisionBodySchema>;

export const SavedAgentUiRevisionSchema = z
  .object({
    sessionId: AgentResourceIdSchema,
    capabilityId: AgentResourceIdSchema,
    artifact: ArtifactViewSchema,
    sha256: Sha256Schema,
  })
  .strict();
export type SavedAgentUiRevision = z.infer<typeof SavedAgentUiRevisionSchema>;

export const StartAgentTestBodySchema = z
  .object({
    text: z.string().trim().min(1).max(20_000),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();
export type StartAgentTestBody = z.infer<typeof StartAgentTestBodySchema>;

export const AgentTestStatusSchema = z.enum(['running', 'passed', 'failed']);
export type AgentTestStatus = z.infer<typeof AgentTestStatusSchema>;

export const AgentTestReviewCaseKindSchema = z.enum(['normal', 'boundary', 'failure']);
export type AgentTestReviewCaseKind = z.infer<typeof AgentTestReviewCaseKindSchema>;

export const AgentTestCaseExecutionStatusSchema = z.enum(['completed', 'failed']);
export type AgentTestCaseExecutionStatus = z.infer<typeof AgentTestCaseExecutionStatusSchema>;

export const AgentTestQualityVerdictSchema = z.enum(['passed', 'failed', 'accepted_exception']);
export type AgentTestQualityVerdict = z.infer<typeof AgentTestQualityVerdictSchema>;

export const AgentTestReviewStatusSchema = AgentTestQualityVerdictSchema;
export type AgentTestReviewStatus = z.infer<typeof AgentTestReviewStatusSchema>;

export const AgentTestQualityStatusSchema = z.enum([
  'unreviewed',
  'passed',
  'failed',
  'accepted_exception',
]);
export type AgentTestQualityStatus = z.infer<typeof AgentTestQualityStatusSchema>;

export const AgentTestReviewCaseSchema = z
  .object({
    caseId: z.string().trim().min(1).max(120),
    kind: AgentTestReviewCaseKindSchema,
    executionStatus: AgentTestCaseExecutionStatusSchema,
    qualityVerdict: AgentTestQualityVerdictSchema,
    reason: z.string().trim().min(1).max(2_000),
    impact: z.string().trim().max(2_000).optional(),
  })
  .strict()
  .superRefine((reviewCase, ctx) => {
    if (reviewCase.qualityVerdict === 'accepted_exception' && !reviewCase.impact) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['impact'],
        message: 'accepted_exception 必须说明影响范围',
      });
    }
  });
export type AgentTestReviewCase = z.infer<typeof AgentTestReviewCaseSchema>;

export const AgentTestReviewCasesSchema = z
  .array(AgentTestReviewCaseSchema)
  .min(3)
  .max(50)
  .superRefine((cases, ctx) => {
    const caseIds = new Set<string>();
    for (const [index, reviewCase] of cases.entries()) {
      if (caseIds.has(reviewCase.caseId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'caseId'],
          message: 'caseId 不能重复',
        });
      }
      caseIds.add(reviewCase.caseId);
    }
    for (const requiredKind of AgentTestReviewCaseKindSchema.options) {
      if (!cases.some((reviewCase) => reviewCase.kind === requiredKind)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `质量复核至少需要一个 ${requiredKind} 案例`,
        });
      }
    }
  });

export const RecordAgentTestReviewBodySchema = z
  .object({
    idempotencyKey: z.string().trim().min(8).max(200),
    cases: AgentTestReviewCasesSchema,
    summary: z.string().trim().max(2_000).default(''),
  })
  .strict();
export type RecordAgentTestReviewBody = z.infer<typeof RecordAgentTestReviewBodySchema>;

export function deriveAgentTestReviewStatus(
  cases: readonly AgentTestReviewCase[],
): AgentTestReviewStatus {
  if (
    cases.some(
      (reviewCase) =>
        reviewCase.executionStatus === 'failed' || reviewCase.qualityVerdict === 'failed',
    )
  ) {
    return 'failed';
  }
  if (cases.some((reviewCase) => reviewCase.qualityVerdict === 'accepted_exception')) {
    return 'accepted_exception';
  }
  return 'passed';
}

export function isPublishableAgentTestQualityStatus(
  status: AgentTestQualityStatus,
): status is 'passed' | 'accepted_exception' {
  return status === 'passed' || status === 'accepted_exception';
}

export const AgentTestViewSchema = z
  .object({
    id: AgentResourceIdSchema,
    projectId: AgentResourceIdSchema,
    agentRevisionId: AgentResourceIdSchema,
    runtimeBundleSha256: Sha256Schema,
    uiSha256: Sha256Schema,
    sessionId: AgentResourceIdSchema,
    turnId: AgentResourceIdSchema,
    status: AgentTestStatusSchema,
    qualityStatus: AgentTestQualityStatusSchema.default('unreviewed'),
    canPublish: z.boolean().default(false),
    errorCode: TerminalTurnErrorCodeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();
export type AgentTestView = z.infer<typeof AgentTestViewSchema>;

export const AgentTestReviewViewSchema = z
  .object({
    id: AgentResourceIdSchema,
    projectId: AgentResourceIdSchema,
    testId: AgentResourceIdSchema,
    agentRevisionId: AgentResourceIdSchema,
    qualityStatus: AgentTestReviewStatusSchema,
    cases: AgentTestReviewCasesSchema,
    summary: z.string(),
    reviewSha256: Sha256Schema,
    reviewerUserId: AgentResourceIdSchema,
    reviewedAt: IsoDateTimeSchema,
    acceptedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();
export type AgentTestReviewView = z.infer<typeof AgentTestReviewViewSchema>;

export const AgentTestDetailSchema = z
  .object({
    test: AgentTestViewSchema,
    outputText: z.string().nullable(),
    review: AgentTestReviewViewSchema.nullable().default(null),
  })
  .strict();
export type AgentTestDetail = z.infer<typeof AgentTestDetailSchema>;

export const AGENT_TEST_LIST_DEFAULT_LIMIT = 20;
export const AGENT_TEST_LIST_MAX_LIMIT = 50;

/** Project 恢复视图包含尚未绑定 Session/Turn 的 starting claim。 */
export const AgentTestListStatusSchema = z.enum(['starting', 'running', 'passed', 'failed']);
export type AgentTestListStatus = z.infer<typeof AgentTestListStatusSchema>;

export const AgentTestListItemSchema = z
  .object({
    id: AgentResourceIdSchema,
    projectId: AgentResourceIdSchema,
    agentRevisionId: AgentResourceIdSchema,
    requestKey: z.string().min(8).max(200),
    sessionId: AgentResourceIdSchema.nullable(),
    turnId: AgentResourceIdSchema.nullable(),
    status: AgentTestListStatusSchema,
    qualityStatus: AgentTestQualityStatusSchema.default('unreviewed'),
    canPublish: z.boolean().default(false),
    errorCode: TerminalTurnErrorCodeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();
export type AgentTestListItem = z.infer<typeof AgentTestListItemSchema>;

export const ListAgentProjectTestsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(AGENT_TEST_LIST_MAX_LIMIT)
      .default(AGENT_TEST_LIST_DEFAULT_LIMIT),
  })
  .strict();
export type ListAgentProjectTestsQuery = z.infer<typeof ListAgentProjectTestsQuerySchema>;

export const AgentTestListSchema = z.array(AgentTestListItemSchema).max(AGENT_TEST_LIST_MAX_LIMIT);
export type AgentTestList = z.infer<typeof AgentTestListSchema>;

export const CreateAgentReleaseBodySchema = z
  .object({
    expectedHeadRevisionId: AgentResourceIdSchema,
    agentRevisionId: AgentResourceIdSchema,
    qualifyingTestId: AgentResourceIdSchema,
    idempotencyKey: z.string().trim().min(8).max(200),
    notes: z.string().trim().max(2_000).default(''),
  })
  .strict();
export type CreateAgentReleaseBody = z.infer<typeof CreateAgentReleaseBodySchema>;

export const AgentReleaseViewSchema = z
  .object({
    id: AgentResourceIdSchema,
    projectId: AgentResourceIdSchema,
    versionNumber: z.number().int().positive(),
    agentRevisionId: AgentResourceIdSchema,
    qualifyingTestId: AgentResourceIdSchema,
    qualifyingReviewId: AgentResourceIdSchema.nullable().default(null),
    reviewSha256: Sha256Schema.nullable().default(null),
    runtimeBundleSha256: Sha256Schema,
    uiSha256: Sha256Schema,
    releaseSha256: Sha256Schema,
    notes: z.string(),
    runtimePath: z.string().min(1),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type AgentReleaseView = z.infer<typeof AgentReleaseViewSchema>;

export const CreateReleasedAgentSessionBodySchema = z.object({}).strict();
export type CreateReleasedAgentSessionBody = z.infer<typeof CreateReleasedAgentSessionBodySchema>;
