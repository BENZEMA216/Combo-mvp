import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';

import { z } from 'zod';

import { canonicalFingerprint, canonicalizeJson } from './canonical.js';
import {
  NON_PORTABLE_AGENT_REFERENCE_BROWSER_VALIDATION_SPEC,
  Sha256DigestSchema,
  containsLoneSurrogate,
  containsNonPortableAgentReference,
  containsUnsafeAgentText,
  isProjectRelativeAgentPath,
  type Sha256Digest,
} from './primitives.js';

export { containsNonPortableAgentReference } from './primitives.js';

export const CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_PROTOCOL =
  'combo.agent-package-creator-request/1' as const;
export const CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_V2_PROTOCOL =
  'combo.agent-package-creator-request/2' as const;
export const CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_V3_PROTOCOL =
  'combo.agent-package-creator-request/3' as const;
export const CREATOR_AGENT_PACKAGE_CREATOR_BOOTSTRAP_HANDOFF_PROTOCOL =
  'combo.agent-package-creator-bootstrap-handoff/1' as const;
export const CREATOR_AGENT_PACKAGE_CREATOR_GUIDE = 'combo.agent-package-creator-guide/1' as const;
export const CREATOR_AGENT_PACKAGE_CREATOR_SOURCE_BINDING =
  'codex_host_current_saved_project' as const;
export const CREATOR_AGENT_PACKAGE_CREATOR_BOOTSTRAP_HANDOFF_MAX_BYTES = 8_192;
export const CREATOR_AGENT_PACKAGE_DRAFT_PROTOCOL = 'combo.agent-package-draft/1' as const;
export const CREATOR_AGENT_PACKAGE_DRAFT_V2_PROTOCOL = 'combo.agent-package-draft/2' as const;
export const CREATOR_AGENT_PACKAGE_DRAFT_V3_PROTOCOL = 'combo.agent-package-draft/3' as const;
export const CREATOR_AGENT_PACKAGE_CONVERSATION_EXTRACTION_PROTOCOL =
  'combo.creator-conversation-draft-extraction/1' as const;
export const CREATOR_AGENT_PACKAGE_DRAFT_REVISION_PROTOCOL =
  'combo.agent-package-draft-revision/1' as const;
export const CREATOR_AGENT_PACKAGE_DRAFT_MAX_BYTES = 65_536;
export const CREATOR_AGENT_PACKAGE_PROJECT_HISTORY_MAX_SELECTED_THREADS = 20;
export const CREATOR_AGENT_PACKAGE_PROJECT_HISTORY_MAX_OMITTED_THREADS = 10_000;

const DRAFT_FINGERPRINT_DOMAIN = 'combo.agent-package-draft/1:fingerprint';
const DRAFT_V2_FINGERPRINT_DOMAIN = 'combo.agent-package-draft/2:fingerprint';
const DRAFT_V3_FINGERPRINT_DOMAIN = 'combo.agent-package-draft/3:fingerprint';
const PROJECT_HISTORY_CANDIDATE_COMMITMENT_DOMAIN =
  'combo.agent-package-draft/3:candidate-commitment';
const CONVERSATION_EXTRACTION_CANDIDATE_FINGERPRINT_DOMAIN =
  'combo.creator-conversation-draft-extraction/1:egress-candidate';
const DRAFT_ID_PATTERN = /^draft\.agent-package\.[0-9a-f]{32}$/u;
const AGENT_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,79}$/u;
const PROJECT_HISTORY_CREDENTIAL_PATTERNS = [
  // Exact first-party secret shapes, synchronized with @cb/shared auth/MCP OAuth contracts and
  // the Project-history confirmation contract. Public mcp_client_ IDs and unprefixed 43-character
  // PKCE/share values are intentionally not classified as credentials here.
  /(?:^|[^A-Za-z0-9_-])s1\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/u,
  /(?:^|[^A-Za-z0-9_-])(?:mat1|mrt1|mar1|mac1)\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/u,
  /(?:^|[^A-Za-z0-9_-])cfrm_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/u,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|pwd|secret)\s*(?:=|:|：)\s*["']?[^\s"'<>]{6,}/iu,
  /(?:密钥|令牌|密码|口令)\s*(?:=|:|：)\s*["']?[^\s"'<>]{6,}/u,
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{12,})\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
] as const;
const PROJECT_HISTORY_HOST_IDENTIFIER_PATTERN =
  /\b(?:(?:source|client)[-_ ]?thread|thread|task|session|project|item|host)[-_ ]?id["'`]?\s*(?:=|:|：)\s*["'`]?[^\s"'`<>{},]{1,256}/iu;

function serializeBrowserRegex(pattern: RegExp): Readonly<{ source: string; flags: string }> {
  // Keep the confirmation-token prefix out of the rendered App source while preserving exact
  // matching semantics. The App itself also constructs the opaque confirmation field name.
  return Object.freeze({
    source: pattern.source.replace('cfrm_', 'cf(?:rm_)'),
    flags: pattern.flags,
  });
}

/**
 * JSON-only validation inputs consumed by the Draft App's browser-side mirror. Server validation
 * remains authoritative; exporting the exact regex sources/root list prevents the visual trust
 * boundary from drifting silently from the V3 schema refinements.
 */
export const CREATOR_AGENT_PACKAGE_PROJECT_HISTORY_BROWSER_VALIDATION_SPEC = Object.freeze({
  agentNamePattern: serializeBrowserRegex(AGENT_NAME_PATTERN),
  credentialPatterns: Object.freeze(PROJECT_HISTORY_CREDENTIAL_PATTERNS.map(serializeBrowserRegex)),
  hostIdentifierPattern: serializeBrowserRegex(PROJECT_HISTORY_HOST_IDENTIFIER_PATTERN),
  nonPortableAgentReference: NON_PORTABLE_AGENT_REFERENCE_BROWSER_VALIDATION_SPEC,
});

/** Best-effort V3 egress guard; this is not a proof that arbitrary secrets were removed. */
export function containsLikelyProjectHistoryCredential(value: string): boolean {
  return PROJECT_HISTORY_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
}

/** V3-only egress guard: creator Host identity labels must never enter the Draft. */
export function containsNonPortableProjectHistoryReference(value: string): boolean {
  return (
    containsNonPortableAgentReference(value) || PROJECT_HISTORY_HOST_IDENTIFIER_PATTERN.test(value)
  );
}

function rejectProjectHistoryCredentials(
  values: readonly string[],
  context: z.RefinementCtx,
): void {
  if (values.some(containsLikelyProjectHistoryCredential)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Project-history Draft contains credential-like material',
    });
  }
}

function rejectProjectHistoryNonPortableReferences(
  values: readonly string[],
  context: z.RefinementCtx,
): void {
  if (values.some(containsNonPortableProjectHistoryReference)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Project-history Draft contains a non-portable source reference',
    });
  }
}

const SafeText = (minimum: number, maximum: number) =>
  z
    .string()
    .min(minimum)
    .max(maximum)
    .refine((value) => value.normalize('NFC') === value, 'Draft text must use NFC')
    .refine((value) => value.trim() === value, 'Draft text must not have outer whitespace')
    .refine((value) => value.trim().length > 0, 'Meaningful text is required')
    .refine((value) => /[\p{L}\p{N}\p{P}\p{S}]/u.test(value), 'Visible text is required')
    .refine((value) => !containsUnsafeAgentText(value), 'Draft text is malformed or unsafe')
    .refine(
      (value) => !containsNonPortableAgentReference(value),
      'Draft text cannot contain local paths, URLs, or task identifiers',
    );

const SafeLine = (minimum: number, maximum: number) =>
  SafeText(minimum, maximum)
    .refine((value) => !/[\r\n]/u.test(value), 'Draft line text cannot contain line breaks')
    .refine((value) => value.replace(/\s+/gu, ' ') === value, 'Draft line text must be canonical');

const ProjectRelativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(isProjectRelativeAgentPath, 'Source path must be a Project-relative path')
  .refine((value) => !containsUnsafeAgentText(value), 'Source path is malformed or unsafe');

const CitedSourceSchema = z
  .object({
    path: ProjectRelativePathSchema,
    digest: Sha256DigestSchema,
  })
  .strict()
  .readonly();

const DraftSourceSchema = z
  .object({
    kind: z.literal('current_project'),
    contextRootDigest: Sha256DigestSchema,
    indexedEntryCount: z.number().int().nonnegative().max(500_000),
    indexedFileCount: z.number().int().nonnegative().max(500_000),
    uniqueIndexedByteCount: z
      .number()
      .int()
      .nonnegative()
      .max(32 * 1_024 * 1_024 * 1_024),
    coverageSummary: SafeText(1, 1_000),
    citedSources: z.array(CitedSourceSchema).min(1).max(32).readonly(),
  })
  .strict()
  .superRefine((source, context) => {
    if (source.indexedFileCount > source.indexedEntryCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['indexedFileCount'],
        message: 'Indexed files cannot exceed indexed entries',
      });
    }
    if (source.citedSources.length > source.indexedFileCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['citedSources'],
        message: 'Cited sources cannot exceed indexed files',
      });
    }
    requireAscendingUnique(
      source.citedSources.map((citation) => citation.path),
      ['citedSources'],
      context,
    );
  })
  .readonly();

const CreatorAgentPackageDraftContentObjectSchema = z
  .object({
    name: z
      .string()
      .regex(AGENT_NAME_PATTERN)
      .refine((value) => value.normalize('NFC') === value, 'Agent name must use NFC')
      .refine(
        (value) => value.trim() === value && value.replace(/\s+/gu, ' ') === value,
        'Agent name must be canonical',
      ),
    description: SafeLine(1, 500),
    instructions: SafeText(1, 8_000),
    starterPrompts: z
      .array(SafeLine(1, 1_000))
      .min(1)
      .max(5)
      .superRefine((values, context) => requireUnique(values, context))
      .readonly(),
    outputDescription: SafeText(1, 1_000),
  })
  .strict();
export const CreatorAgentPackageDraftContentSchema =
  CreatorAgentPackageDraftContentObjectSchema.readonly();
export type CreatorAgentPackageDraftContent = z.infer<typeof CreatorAgentPackageDraftContentSchema>;

export const CreatorAgentPackageConversationExtractionCandidateSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_PACKAGE_CONVERSATION_EXTRACTION_PROTOCOL),
    name: CreatorAgentPackageDraftContentObjectSchema.shape.name,
    description: CreatorAgentPackageDraftContentObjectSchema.shape.description,
    instructions: CreatorAgentPackageDraftContentObjectSchema.shape.instructions,
    starterPrompts: CreatorAgentPackageDraftContentObjectSchema.shape.starterPrompts,
    outputDescription: CreatorAgentPackageDraftContentObjectSchema.shape.outputDescription,
    coverageSummary: SafeText(1, 1_000),
  })
  .strict()
  .readonly();
export type CreatorAgentPackageConversationExtractionCandidate = z.infer<
  typeof CreatorAgentPackageConversationExtractionCandidateSchema
>;

export const CreatorAgentPackageCreatorRequestSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_PROTOCOL),
    intent: z.literal('create_agent_package_from_current_project'),
    request: SafeText(1, 2_000),
  })
  .strict()
  .readonly();
export type CreatorAgentPackageCreatorRequest = z.infer<
  typeof CreatorAgentPackageCreatorRequestSchema
>;

export const CreatorAgentPackageCreatorRequestV2Schema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_V2_PROTOCOL),
    intent: z.literal('create_agent_package_from_current_conversation'),
    request: SafeText(1, 2_000),
  })
  .strict()
  .readonly();
export type CreatorAgentPackageCreatorRequestV2 = z.infer<
  typeof CreatorAgentPackageCreatorRequestV2Schema
>;

export const CreatorAgentPackageCreatorRequestV3Schema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_V3_PROTOCOL),
    intent: z.literal('create_agent_package_from_project_task_history'),
    request: SafeText(1, 2_000),
  })
  .strict()
  .superRefine((input, context) =>
    rejectProjectHistoryNonPortableReferences([input.request], context),
  )
  .readonly();
export type CreatorAgentPackageCreatorRequestV3 = z.infer<
  typeof CreatorAgentPackageCreatorRequestV3Schema
>;

export const CreatorAgentPackageProjectHistoryLimitationReasonSchema = z.enum([
  'READ_OUTPUT_BOUNDED_OR_TRUNCATED',
  'READ_THREAD_SUMMARY_NOT_RAW_TRANSCRIPT',
  'THREAD_LIST_GLOBAL_COVERAGE_NOT_ATTESTED',
]);
export type CreatorAgentPackageProjectHistoryLimitationReason = z.infer<
  typeof CreatorAgentPackageProjectHistoryLimitationReasonSchema
>;

const ProjectHistoryCountsObjectSchema = z.object({
  projectCount: z.literal(1),
  discoveredThreadCount: z
    .number()
    .int()
    .min(1)
    .max(CREATOR_AGENT_PACKAGE_PROJECT_HISTORY_MAX_SELECTED_THREADS),
  readThreadCount: z
    .number()
    .int()
    .min(1)
    .max(CREATOR_AGENT_PACKAGE_PROJECT_HISTORY_MAX_SELECTED_THREADS),
  omittedThreadCount: z
    .number()
    .int()
    .nonnegative()
    .max(CREATOR_AGENT_PACKAGE_PROJECT_HISTORY_MAX_OMITTED_THREADS),
  completedTurnCount: z.number().int().min(1).max(10_000),
  userVisibleMessageCount: z.number().int().min(1).max(20_000),
  omittedItemCount: z.number().int().nonnegative().max(20_000),
});

function projectHistoryEvidenceRefinement(
  source: {
    discoveredThreadCount: number;
    readThreadCount: number;
    omittedThreadCount: number;
    completedTurnCount: number;
    userVisibleMessageCount: number;
    limitationReasons: readonly CreatorAgentPackageProjectHistoryLimitationReason[];
  },
  context: z.RefinementCtx,
): void {
  if (source.readThreadCount !== source.discoveredThreadCount) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['readThreadCount'],
      message: 'Every selected eligible Project thread must be read before Draft creation',
    });
  }
  if (source.userVisibleMessageCount > source.completedTurnCount * 1_000) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['userVisibleMessageCount'],
      message: 'Visible message count exceeds the bounded per-turn contract',
    });
  }
  const requiredReasons = [
    'READ_OUTPUT_BOUNDED_OR_TRUNCATED',
    'READ_THREAD_SUMMARY_NOT_RAW_TRANSCRIPT',
    'THREAD_LIST_GLOBAL_COVERAGE_NOT_ATTESTED',
  ] as const;
  if (
    source.limitationReasons.length !== requiredReasons.length ||
    source.limitationReasons.some((reason, index) => reason !== requiredReasons[index])
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['limitationReasons'],
      message: 'All current Host history limitations must be disclosed in canonical order',
    });
  }
}

const CreatorAgentPackageProjectHistorySourceEvidenceObjectSchema =
  ProjectHistoryCountsObjectSchema.extend({
    kind: z.literal('host_project_scoped_reduced_history'),
    selection: z.literal('user_selected_saved_project'),
    assurance: z.literal('best_effort'),
    completeness: z.literal('not_proven'),
    hostAttestation: z.literal('not_proven'),
    sourceProjectionEnforced: z.literal('not_proven'),
    rawStored: z.literal(false),
    limitationReasons: z
      .tuple([
        z.literal('READ_OUTPUT_BOUNDED_OR_TRUNCATED'),
        z.literal('READ_THREAD_SUMMARY_NOT_RAW_TRANSCRIPT'),
        z.literal('THREAD_LIST_GLOBAL_COVERAGE_NOT_ATTESTED'),
      ])
      .readonly(),
  });

export const CreatorAgentPackageProjectHistorySourceEvidenceSchema =
  CreatorAgentPackageProjectHistorySourceEvidenceObjectSchema.strict()
    .superRefine(projectHistoryEvidenceRefinement)
    .readonly();
export type CreatorAgentPackageProjectHistorySourceEvidence = z.infer<
  typeof CreatorAgentPackageProjectHistorySourceEvidenceSchema
>;

export const CreatorAgentPackageProjectHistorySourceSchema =
  CreatorAgentPackageProjectHistorySourceEvidenceObjectSchema.extend({
    candidateCommitment: Sha256DigestSchema,
  })
    .strict()
    .superRefine(projectHistoryEvidenceRefinement)
    .readonly();
export type CreatorAgentPackageProjectHistorySource = z.infer<
  typeof CreatorAgentPackageProjectHistorySourceSchema
>;

const ProjectHistoryCandidateCommitmentInputSchema = z
  .object({
    creatorRequest: CreatorAgentPackageCreatorRequestV3Schema,
    candidate: CreatorAgentPackageDraftContentSchema,
    sourceEvidence: CreatorAgentPackageProjectHistorySourceEvidenceSchema,
  })
  .strict()
  .superRefine((input, context) => {
    rejectProjectHistoryCredentials(
      [
        input.creatorRequest.request,
        input.candidate.name,
        input.candidate.description,
        input.candidate.instructions,
        ...input.candidate.starterPrompts,
        input.candidate.outputDescription,
      ],
      context,
    );
    rejectProjectHistoryNonPortableReferences(
      [
        input.creatorRequest.request,
        input.candidate.name,
        input.candidate.description,
        input.candidate.instructions,
        ...input.candidate.starterPrompts,
        input.candidate.outputDescription,
      ],
      context,
    );
  })
  .readonly();

function fingerprintProjectHistoryCandidate(input: {
  creatorRequest: unknown;
  candidate: unknown;
  sourceEvidence: unknown;
}): Sha256Digest {
  return canonicalFingerprint(PROJECT_HISTORY_CANDIDATE_COMMITMENT_DOMAIN, {
    creatorRequest: input.creatorRequest,
    candidate: input.candidate,
    sourceEvidence: input.sourceEvidence,
  });
}

export const CreatorAgentPackageCurrentConversationSourceSchema = z
  .object({
    kind: z.literal('current_conversation'),
    sourceBoundary: z.literal('desktop_attested_active_current_task'),
    snapshotBoundary: z.literal('before_direct_creator_item'),
    visibility: z.literal('user_visible_items_only'),
    snapshotCompleteness: z.literal('complete'),
    rawStored: z.literal(false),
    snapshotCommitmentScheme: z.literal('host_hmac_sha256_per_run/1'),
    snapshotCommitment: Sha256DigestSchema,
    selectedVisibleItemCount: z.number().int().min(1).max(500_000),
    coverageSummary: SafeText(1, 1_000),
  })
  .strict()
  .readonly();
export type CreatorAgentPackageCurrentConversationSource = z.infer<
  typeof CreatorAgentPackageCurrentConversationSourceSchema
>;

const CreatorAgentPackageCreatorBootstrapHandoffSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_PACKAGE_CREATOR_BOOTSTRAP_HANDOFF_PROTOCOL),
    creatorGuide: z.literal(CREATOR_AGENT_PACKAGE_CREATOR_GUIDE),
    sourceBinding: z.literal(CREATOR_AGENT_PACKAGE_CREATOR_SOURCE_BINDING),
    creatorRequest: CreatorAgentPackageCreatorRequestSchema,
  })
  .strict()
  .readonly();
export type CreatorAgentPackageCreatorBootstrapHandoff = z.infer<
  typeof CreatorAgentPackageCreatorBootstrapHandoffSchema
>;

const DraftFingerprintInputObjectSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_PACKAGE_DRAFT_PROTOCOL),
    draftId: z.string().regex(DRAFT_ID_PATTERN),
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    parentDraftFingerprint: Sha256DigestSchema.nullable(),
    creatorRequest: CreatorAgentPackageCreatorRequestSchema,
    source: DraftSourceSchema,
    content: CreatorAgentPackageDraftContentSchema,
  })
  .strict();
const DraftFingerprintInputSchema = DraftFingerprintInputObjectSchema.readonly();

export const CreatorAgentPackageDraftSnapshotSchema = DraftFingerprintInputObjectSchema.extend({
  draftFingerprint: Sha256DigestSchema,
})
  .strict()
  .superRefine((draft, context) => {
    if ((draft.revision === 1) !== (draft.parentDraftFingerprint === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parentDraftFingerprint'],
        message: 'Only the first Draft revision can omit its parent fingerprint',
      });
    }
    if (draft.draftFingerprint !== fingerprintDraft(draft)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['draftFingerprint'],
        message: 'Draft fingerprint does not match the exact Draft revision',
      });
    }
  })
  .readonly();
export type CreatorAgentPackageDraftSnapshot = z.infer<
  typeof CreatorAgentPackageDraftSnapshotSchema
>;

const DraftV2FingerprintInputObjectSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_PACKAGE_DRAFT_V2_PROTOCOL),
    draftId: z.string().regex(DRAFT_ID_PATTERN),
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    parentDraftFingerprint: Sha256DigestSchema.nullable(),
    creatorRequest: CreatorAgentPackageCreatorRequestV2Schema,
    source: CreatorAgentPackageCurrentConversationSourceSchema,
    content: CreatorAgentPackageDraftContentSchema,
  })
  .strict();
const DraftV2FingerprintInputSchema = DraftV2FingerprintInputObjectSchema.readonly();

export const CreatorAgentPackageDraftSnapshotV2Schema = DraftV2FingerprintInputObjectSchema.extend({
  draftFingerprint: Sha256DigestSchema,
})
  .strict()
  .superRefine((draft, context) => {
    if ((draft.revision === 1) !== (draft.parentDraftFingerprint === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parentDraftFingerprint'],
        message: 'Only the first Draft revision can omit its parent fingerprint',
      });
    }
    if (draft.draftFingerprint !== fingerprintDraftV2(draft)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['draftFingerprint'],
        message: 'Draft fingerprint does not match the exact Draft revision',
      });
    }
  })
  .readonly();
export type CreatorAgentPackageDraftSnapshotV2 = z.infer<
  typeof CreatorAgentPackageDraftSnapshotV2Schema
>;

const DraftV3FingerprintInputObjectSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_PACKAGE_DRAFT_V3_PROTOCOL),
    draftId: z.string().regex(DRAFT_ID_PATTERN),
    revision: z.literal(1),
    parentDraftFingerprint: z.null(),
    creatorRequest: CreatorAgentPackageCreatorRequestV3Schema,
    source: CreatorAgentPackageProjectHistorySourceSchema,
    content: CreatorAgentPackageDraftContentSchema,
  })
  .strict();

function validateProjectHistoryCandidateCommitment(
  draft: z.infer<typeof DraftV3FingerprintInputObjectSchema>,
  context: z.RefinementCtx,
): void {
  const { candidateCommitment, ...sourceEvidence } = draft.source;
  const expected = fingerprintProjectHistoryCandidate({
    creatorRequest: draft.creatorRequest,
    candidate: draft.content,
    sourceEvidence,
  });
  if (candidateCommitment !== expected) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['source', 'candidateCommitment'],
      message: 'Project-history candidate commitment does not match the exact Draft candidate',
    });
  }
}

const DraftV3FingerprintInputSchema = DraftV3FingerprintInputObjectSchema.superRefine(
  (draft, context) => {
    rejectProjectHistoryCredentials(
      [
        draft.creatorRequest.request,
        draft.content.name,
        draft.content.description,
        draft.content.instructions,
        ...draft.content.starterPrompts,
        draft.content.outputDescription,
      ],
      context,
    );
    rejectProjectHistoryNonPortableReferences(
      [
        draft.creatorRequest.request,
        draft.content.name,
        draft.content.description,
        draft.content.instructions,
        ...draft.content.starterPrompts,
        draft.content.outputDescription,
      ],
      context,
    );
    validateProjectHistoryCandidateCommitment(draft, context);
  },
).readonly();

export const CreatorAgentPackageDraftSnapshotV3Schema = DraftV3FingerprintInputObjectSchema.extend({
  draftFingerprint: Sha256DigestSchema,
})
  .strict()
  .superRefine((draft, context) => {
    rejectProjectHistoryCredentials(
      [
        draft.creatorRequest.request,
        draft.content.name,
        draft.content.description,
        draft.content.instructions,
        ...draft.content.starterPrompts,
        draft.content.outputDescription,
      ],
      context,
    );
    rejectProjectHistoryNonPortableReferences(
      [
        draft.creatorRequest.request,
        draft.content.name,
        draft.content.description,
        draft.content.instructions,
        ...draft.content.starterPrompts,
        draft.content.outputDescription,
      ],
      context,
    );
    validateProjectHistoryCandidateCommitment(draft, context);
    if (draft.draftFingerprint !== fingerprintDraftV3(draft)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['draftFingerprint'],
        message: 'Draft fingerprint does not match the exact Draft revision',
      });
    }
  })
  .readonly();
export type CreatorAgentPackageDraftSnapshotV3 = z.infer<
  typeof CreatorAgentPackageDraftSnapshotV3Schema
>;

const DraftChangesSchema = CreatorAgentPackageDraftContentObjectSchema.partial()
  .strict()
  .superRefine((changes, context) => {
    if (Object.keys(changes).length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Draft changes cannot be empty' });
    }
  })
  .readonly();

export const CreatorAgentPackageDraftRevisionRequestSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_PACKAGE_DRAFT_REVISION_PROTOCOL),
    draftId: z.string().regex(DRAFT_ID_PATTERN),
    baseRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    baseDraftFingerprint: Sha256DigestSchema,
    changes: DraftChangesSchema,
  })
  .strict()
  .readonly();
export type CreatorAgentPackageDraftRevisionRequest = z.infer<
  typeof CreatorAgentPackageDraftRevisionRequestSchema
>;

export function createCreatorAgentPackageCreatorRequest(
  input: unknown,
): CreatorAgentPackageCreatorRequest {
  return exactDetached(
    CreatorAgentPackageCreatorRequestSchema,
    input,
    'Agent Package creator request',
  );
}

export function verifyCreatorAgentPackageCreatorRequest(
  input: unknown,
): CreatorAgentPackageCreatorRequest {
  return createCreatorAgentPackageCreatorRequest(input);
}

export function serializeCreatorAgentPackageCreatorRequest(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentPackageCreatorRequest(input));
}

export function digestCreatorAgentPackageCreatorRequest(input: unknown): Sha256Digest {
  const bytes = Buffer.from(serializeCreatorAgentPackageCreatorRequest(input), 'utf8');
  return Sha256DigestSchema.parse(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
}

export function parseCreatorAgentPackageCreatorRequest(
  text: string,
): CreatorAgentPackageCreatorRequest {
  return parseExact(text, verifyCreatorAgentPackageCreatorRequest, 'Agent Package creator request');
}

export function createCreatorAgentPackageCreatorRequestV2(
  input: unknown,
): CreatorAgentPackageCreatorRequestV2 {
  return exactDetached(
    CreatorAgentPackageCreatorRequestV2Schema,
    input,
    'Conversation Agent Package creator request',
  );
}

export function verifyCreatorAgentPackageCreatorRequestV2(
  input: unknown,
): CreatorAgentPackageCreatorRequestV2 {
  return createCreatorAgentPackageCreatorRequestV2(input);
}

export function serializeCreatorAgentPackageCreatorRequestV2(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentPackageCreatorRequestV2(input));
}

export function digestCreatorAgentPackageCreatorRequestV2(input: unknown): Sha256Digest {
  const bytes = Buffer.from(serializeCreatorAgentPackageCreatorRequestV2(input), 'utf8');
  return Sha256DigestSchema.parse(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
}

export function parseCreatorAgentPackageCreatorRequestV2(
  text: string,
): CreatorAgentPackageCreatorRequestV2 {
  return parseExact(
    text,
    verifyCreatorAgentPackageCreatorRequestV2,
    'Conversation Agent Package creator request',
  );
}

export function createCreatorAgentPackageCreatorRequestV3(
  input: unknown,
): CreatorAgentPackageCreatorRequestV3 {
  return exactDetached(
    CreatorAgentPackageCreatorRequestV3Schema,
    input,
    'Project-history Agent Package creator request',
  );
}

export function verifyCreatorAgentPackageCreatorRequestV3(
  input: unknown,
): CreatorAgentPackageCreatorRequestV3 {
  return createCreatorAgentPackageCreatorRequestV3(input);
}

export function serializeCreatorAgentPackageCreatorRequestV3(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentPackageCreatorRequestV3(input));
}

export function digestCreatorAgentPackageCreatorRequestV3(input: unknown): Sha256Digest {
  const bytes = Buffer.from(serializeCreatorAgentPackageCreatorRequestV3(input), 'utf8');
  return Sha256DigestSchema.parse(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
}

export function parseCreatorAgentPackageCreatorRequestV3(
  text: string,
): CreatorAgentPackageCreatorRequestV3 {
  return parseExact(
    text,
    verifyCreatorAgentPackageCreatorRequestV3,
    'Project-history Agent Package creator request',
  );
}

export function commitCreatorAgentPackageProjectHistoryCandidate(input: {
  creatorRequest: unknown;
  candidate: unknown;
  sourceEvidence: unknown;
}): Sha256Digest {
  const value = exactDetached(
    ProjectHistoryCandidateCommitmentInputSchema,
    input,
    'Project-history Agent Package candidate commitment input',
  );
  return fingerprintProjectHistoryCandidate(value);
}

export function verifyCreatorAgentPackageConversationExtractionCandidate(
  input: unknown,
): CreatorAgentPackageConversationExtractionCandidate {
  return exactDetached(
    CreatorAgentPackageConversationExtractionCandidateSchema,
    input,
    'Conversation Agent Package extraction candidate',
  );
}

export function digestCreatorAgentPackageConversationExtractionCandidate(
  input: unknown,
): Sha256Digest {
  return canonicalFingerprint(
    CONVERSATION_EXTRACTION_CANDIDATE_FINGERPRINT_DOMAIN,
    verifyCreatorAgentPackageConversationExtractionCandidate(input),
  );
}

export function createCreatorAgentPackageCreatorBootstrapHandoff(
  input: unknown,
): CreatorAgentPackageCreatorBootstrapHandoff {
  return exactDetached(
    CreatorAgentPackageCreatorBootstrapHandoffSchema,
    input,
    'Agent Package creator bootstrap handoff',
    CREATOR_AGENT_PACKAGE_CREATOR_BOOTSTRAP_HANDOFF_MAX_BYTES,
  );
}

export function verifyCreatorAgentPackageCreatorBootstrapHandoff(
  input: unknown,
): CreatorAgentPackageCreatorBootstrapHandoff {
  return createCreatorAgentPackageCreatorBootstrapHandoff(input);
}

export function serializeCreatorAgentPackageCreatorBootstrapHandoff(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentPackageCreatorBootstrapHandoff(input));
}

export function parseCreatorAgentPackageCreatorBootstrapHandoff(
  text: string,
): CreatorAgentPackageCreatorBootstrapHandoff {
  return parseExact(
    text,
    verifyCreatorAgentPackageCreatorBootstrapHandoff,
    'Agent Package creator bootstrap handoff',
    CREATOR_AGENT_PACKAGE_CREATOR_BOOTSTRAP_HANDOFF_MAX_BYTES,
  );
}

export function createCreatorAgentPackageDraftSnapshot(
  input: z.input<typeof DraftFingerprintInputSchema>,
): CreatorAgentPackageDraftSnapshot {
  const detached = exactDetached(DraftFingerprintInputSchema, input, 'Agent Package Draft');
  return exactDetached(
    CreatorAgentPackageDraftSnapshotSchema,
    { ...detached, draftFingerprint: fingerprintDraft(detached) },
    'Agent Package Draft snapshot',
  );
}

export function verifyCreatorAgentPackageDraftSnapshot(
  input: unknown,
): CreatorAgentPackageDraftSnapshot {
  return exactDetached(
    CreatorAgentPackageDraftSnapshotSchema,
    input,
    'Agent Package Draft snapshot',
  );
}

export function createCreatorAgentPackageDraftSnapshotV2(
  input: unknown,
): CreatorAgentPackageDraftSnapshotV2 {
  const detached = exactDetached(
    DraftV2FingerprintInputSchema,
    input,
    'Conversation Agent Package Draft',
  );
  return exactDetached(
    CreatorAgentPackageDraftSnapshotV2Schema,
    { ...detached, draftFingerprint: fingerprintDraftV2(detached) },
    'Conversation Agent Package Draft snapshot',
  );
}

export function verifyCreatorAgentPackageDraftSnapshotV2(
  input: unknown,
): CreatorAgentPackageDraftSnapshotV2 {
  return exactDetached(
    CreatorAgentPackageDraftSnapshotV2Schema,
    input,
    'Conversation Agent Package Draft snapshot',
  );
}

export function createCreatorAgentPackageDraftSnapshotV3(
  input: unknown,
): CreatorAgentPackageDraftSnapshotV3 {
  const detached = exactDetached(
    DraftV3FingerprintInputSchema,
    input,
    'Project-history Agent Package Draft',
  );
  return exactDetached(
    CreatorAgentPackageDraftSnapshotV3Schema,
    { ...detached, draftFingerprint: fingerprintDraftV3(detached) },
    'Project-history Agent Package Draft snapshot',
  );
}

export function verifyCreatorAgentPackageDraftSnapshotV3(
  input: unknown,
): CreatorAgentPackageDraftSnapshotV3 {
  return exactDetached(
    CreatorAgentPackageDraftSnapshotV3Schema,
    input,
    'Project-history Agent Package Draft snapshot',
  );
}

export function createCreatorAgentPackageDraftRevisionRequest(
  input: unknown,
): CreatorAgentPackageDraftRevisionRequest {
  return exactDetached(
    CreatorAgentPackageDraftRevisionRequestSchema,
    input,
    'Agent Package Draft revision request',
  );
}

export function serializeCreatorAgentPackageDraftRevisionRequest(input: unknown): string {
  return canonicalizeJson(createCreatorAgentPackageDraftRevisionRequest(input));
}

export function parseCreatorAgentPackageDraftRevisionRequest(
  text: string,
): CreatorAgentPackageDraftRevisionRequest {
  return parseExact(
    text,
    createCreatorAgentPackageDraftRevisionRequest,
    'Agent Package Draft revision request',
  );
}

export function reviseCreatorAgentPackageDraft(
  rawDraft: unknown,
  rawRequest: unknown,
): CreatorAgentPackageDraftSnapshot {
  const draft = verifyCreatorAgentPackageDraftSnapshot(rawDraft);
  const request = createCreatorAgentPackageDraftRevisionRequest(rawRequest);
  if (
    request.draftId !== draft.draftId ||
    request.baseRevision !== draft.revision ||
    request.baseDraftFingerprint !== draft.draftFingerprint
  ) {
    throw new TypeError('Agent Package Draft revision does not match its exact base');
  }
  const content = { ...draft.content, ...request.changes };
  if (canonicalizeJson(content) === canonicalizeJson(draft.content)) {
    throw new TypeError('Agent Package Draft revision must change its exact content');
  }
  return createCreatorAgentPackageDraftSnapshot({
    protocol: CREATOR_AGENT_PACKAGE_DRAFT_PROTOCOL,
    draftId: draft.draftId,
    revision: draft.revision + 1,
    parentDraftFingerprint: draft.draftFingerprint,
    creatorRequest: draft.creatorRequest,
    source: draft.source,
    content,
  });
}

export function reviseCreatorAgentPackageDraftV2(
  rawDraft: unknown,
  rawRequest: unknown,
): CreatorAgentPackageDraftSnapshotV2 {
  const draft = verifyCreatorAgentPackageDraftSnapshotV2(rawDraft);
  const request = createCreatorAgentPackageDraftRevisionRequest(rawRequest);
  if (
    request.draftId !== draft.draftId ||
    request.baseRevision !== draft.revision ||
    request.baseDraftFingerprint !== draft.draftFingerprint
  ) {
    throw new TypeError('Agent Package Draft revision does not match its exact base');
  }
  const content = { ...draft.content, ...request.changes };
  if (canonicalizeJson(content) === canonicalizeJson(draft.content)) {
    throw new TypeError('Agent Package Draft revision must change its exact content');
  }
  return createCreatorAgentPackageDraftSnapshotV2({
    protocol: CREATOR_AGENT_PACKAGE_DRAFT_V2_PROTOCOL,
    draftId: draft.draftId,
    revision: draft.revision + 1,
    parentDraftFingerprint: draft.draftFingerprint,
    creatorRequest: draft.creatorRequest,
    source: draft.source,
    content,
  });
}

export function serializeCreatorAgentPackageDraftSnapshot(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentPackageDraftSnapshot(input));
}

export function parseCreatorAgentPackageDraftSnapshot(
  text: string,
): CreatorAgentPackageDraftSnapshot {
  return parseExact(text, verifyCreatorAgentPackageDraftSnapshot, 'Agent Package Draft');
}

export function serializeCreatorAgentPackageDraftSnapshotV2(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentPackageDraftSnapshotV2(input));
}

export function parseCreatorAgentPackageDraftSnapshotV2(
  text: string,
): CreatorAgentPackageDraftSnapshotV2 {
  return parseExact(
    text,
    verifyCreatorAgentPackageDraftSnapshotV2,
    'Conversation Agent Package Draft',
  );
}

export function serializeCreatorAgentPackageDraftSnapshotV3(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentPackageDraftSnapshotV3(input));
}

export function parseCreatorAgentPackageDraftSnapshotV3(
  text: string,
): CreatorAgentPackageDraftSnapshotV3 {
  return parseExact(
    text,
    verifyCreatorAgentPackageDraftSnapshotV3,
    'Project-history Agent Package Draft',
  );
}

function parseExact<Value>(
  text: string,
  verify: (input: unknown) => Value,
  label: string,
  maximumBytes = CREATOR_AGENT_PACKAGE_DRAFT_MAX_BYTES,
): Value {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maximumBytes) {
    throw new TypeError(`${label} exceeds the canonical byte limit`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError(`${label} is not valid JSON`);
  }
  const verified = verify(value);
  if (canonicalizeJson(verified) !== text) {
    throw new TypeError(`${label} is not exact canonical JSON`);
  }
  return verified;
}

function fingerprintDraft(input: unknown): Sha256Digest {
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const value = {
    protocol: dataValue(descriptors, 'protocol'),
    draftId: dataValue(descriptors, 'draftId'),
    revision: dataValue(descriptors, 'revision'),
    parentDraftFingerprint: dataValue(descriptors, 'parentDraftFingerprint'),
    creatorRequest: dataValue(descriptors, 'creatorRequest'),
    source: dataValue(descriptors, 'source'),
    content: dataValue(descriptors, 'content'),
  };
  return canonicalFingerprint(DRAFT_FINGERPRINT_DOMAIN, value);
}

function fingerprintDraftV2(input: unknown): Sha256Digest {
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const value = {
    protocol: dataValue(descriptors, 'protocol'),
    draftId: dataValue(descriptors, 'draftId'),
    revision: dataValue(descriptors, 'revision'),
    parentDraftFingerprint: dataValue(descriptors, 'parentDraftFingerprint'),
    creatorRequest: dataValue(descriptors, 'creatorRequest'),
    source: dataValue(descriptors, 'source'),
    content: dataValue(descriptors, 'content'),
  };
  return canonicalFingerprint(DRAFT_V2_FINGERPRINT_DOMAIN, value);
}

function fingerprintDraftV3(input: unknown): Sha256Digest {
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const value = {
    protocol: dataValue(descriptors, 'protocol'),
    draftId: dataValue(descriptors, 'draftId'),
    revision: dataValue(descriptors, 'revision'),
    parentDraftFingerprint: dataValue(descriptors, 'parentDraftFingerprint'),
    creatorRequest: dataValue(descriptors, 'creatorRequest'),
    source: dataValue(descriptors, 'source'),
    content: dataValue(descriptors, 'content'),
  };
  return canonicalFingerprint(DRAFT_V3_FINGERPRINT_DOMAIN, value);
}

function dataValue(descriptors: Record<PropertyKey, PropertyDescriptor>, key: string): unknown {
  const descriptor = descriptors[key];
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    throw new TypeError('Agent Package Draft must contain enumerable data properties');
  }
  return descriptor.value;
}

function requireAscendingUnique(
  values: readonly string[],
  path: readonly (string | number)[],
  context: z.RefinementCtx,
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index],
        message: 'Values must be unique and in ascending order',
      });
    }
  }
}

function requireUnique(values: readonly string[], context: z.RefinementCtx): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Values must be unique' });
  }
}

function exactDetached<Schema extends z.ZodTypeAny>(
  schema: Schema,
  input: unknown,
  label: string,
  maximumBytes = CREATOR_AGENT_PACKAGE_DRAFT_MAX_BYTES,
): z.output<Schema> {
  const snapshot = snapshotJson(input, 0, { nodes: 0, bytes: 0 }, maximumBytes);
  const before = canonicalizeJson(snapshot);
  if (Buffer.byteLength(before, 'utf8') > maximumBytes) {
    throw new TypeError(`${label} exceeds the canonical byte limit`);
  }
  const parsed = schema.parse(snapshot);
  if (canonicalizeJson(parsed) !== before) {
    throw new TypeError(`${label} changed during schema parsing`);
  }
  deepFreeze(parsed);
  return parsed;
}

function snapshotJson(
  input: unknown,
  depth: number,
  budget: { nodes: number; bytes: number },
  maximumBytes: number,
): unknown {
  budget.nodes += 1;
  if (budget.nodes > 2_048 || depth > 16) {
    throw new TypeError('Agent Package Draft exceeds the canonical complexity limit');
  }
  if (input === null || typeof input === 'boolean') return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new TypeError('Draft value is not canonical JSON');
    return input;
  }
  if (typeof input === 'string') {
    budget.bytes += Buffer.byteLength(input, 'utf8');
    if (budget.bytes > maximumBytes || containsLoneSurrogate(input)) {
      throw new TypeError('Agent Package Draft exceeds the canonical byte limit');
    }
    return input;
  }
  if (typeof input !== 'object' || isProxy(input)) {
    throw new TypeError('Draft value must contain only plain JSON values');
  }
  if (Array.isArray(input)) {
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors).filter((key) => key !== 'length');
    if (
      keys.length !== input.length ||
      keys.some((key, index) => typeof key !== 'string' || key !== String(index))
    ) {
      throw new TypeError('Draft value must contain only dense arrays');
    }
    return keys.map((key) => {
      const descriptor = descriptors[key as string];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('Draft properties must be enumerable data properties');
      }
      return snapshotJson(descriptor.value, depth + 1, budget, maximumBytes);
    });
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Draft value must contain only plain JSON objects');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || containsLoneSurrogate(key)) {
      throw new TypeError('Draft value contains a malformed key');
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Draft properties must be enumerable data properties');
    }
    budget.bytes += Buffer.byteLength(key, 'utf8');
    if (budget.bytes > maximumBytes) {
      throw new TypeError('Agent Package Draft exceeds the canonical byte limit');
    }
    output[key] = snapshotJson(descriptor.value, depth + 1, budget, maximumBytes);
  }
  return output;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
