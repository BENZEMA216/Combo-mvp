import { z } from 'zod';

import {
  CreatorAgentPackageDraftContentSchema,
  CreatorAgentPackageProjectHistorySourceEvidenceSchema,
  containsLikelyProjectHistoryCredential,
  containsNonPortableProjectHistoryReference,
} from '@cb/creator-agent-protocol/agent-package-draft';

export const PROJECT_HISTORY_AGENT_DRAFT_RESULT_SCHEMA_VERSION =
  'combo.agent-package-draft-result/1' as const;
export const PROJECT_HISTORY_AGENT_DRAFT_CARD_SCHEMA_VERSION =
  'combo.agent-package-draft-card/1' as const;
export const PROJECT_HISTORY_AGENT_SHARE_RESULT_SCHEMA_VERSION =
  'combo.agent-package-share-result/2' as const;
export const PROJECT_HISTORY_AGENT_RUN_PREPARATION_SCHEMA_VERSION =
  'combo.agent-package-run-preparation/2' as const;
export const PROJECT_HISTORY_AGENT_CONFIRMATION_SCHEME =
  'combo.agent-package-share-confirmation/1' as const;
export const PROJECT_HISTORY_AGENT_CONFIRMATION_TTL_MS = 5 * 60 * 1_000;
export const PROJECT_HISTORY_AGENT_SHARE_MAX_BYTES = 256 * 1_024;

const DraftIdSchema = z.string().regex(/^draft\.agent-package\.[0-9a-f]{32}$/u);
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const ConfirmationTokenSchema = z.string().regex(/^cfrm_[A-Za-z0-9_-]{43}$/u);

export const CreateAgentPackageDraftInputSchema = z
  .object({
    creatorRequest: z.string().min(1).max(2_000),
    candidate: CreatorAgentPackageDraftContentSchema,
    sourceEvidence: CreatorAgentPackageProjectHistorySourceEvidenceSchema,
    idempotencyKey: z.string().uuid(),
  })
  .strict()
  .superRefine((input, context) => {
    const text = [
      input.creatorRequest,
      input.candidate.name,
      input.candidate.description,
      input.candidate.instructions,
      ...input.candidate.starterPrompts,
      input.candidate.outputDescription,
    ];
    if (text.some(containsLikelyProjectHistoryCredential)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Project-history Draft contains credential-like material',
      });
    }
    if (text.some(containsNonPortableProjectHistoryReference)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Project-history Draft contains a non-portable source reference',
      });
    }
  })
  .readonly();
export type CreateAgentPackageDraftInput = z.infer<typeof CreateAgentPackageDraftInputSchema>;

export const RenderAgentPackageDraftBodySchema = z
  .object({
    draftFingerprint: DigestSchema,
  })
  .strict()
  .readonly();
export const RenderAgentPackageDraftInputSchema = z
  .object({
    draftId: DraftIdSchema,
    draftFingerprint: DigestSchema,
  })
  .strict()
  .readonly();
export type RenderAgentPackageDraftInput = z.infer<typeof RenderAgentPackageDraftInputSchema>;

export const CreateAgentPackageShareInputSchema = z
  .object({
    draftId: DraftIdSchema,
    draftFingerprint: DigestSchema,
    confirmationToken: ConfirmationTokenSchema,
    idempotencyKey: z.string().uuid(),
  })
  .strict()
  .readonly();
export type CreateAgentPackageShareInput = z.infer<typeof CreateAgentPackageShareInputSchema>;

const AgentPackageShareUrlInputObjectSchema = z.object({
  shareUrl: z.string().url().max(2_048),
});
export const ReadAgentPackageShareInputSchema =
  AgentPackageShareUrlInputObjectSchema.strict().readonly();
export type ReadAgentPackageShareInput = z.infer<typeof ReadAgentPackageShareInputSchema>;

export const PrepareAgentPackageRunInputSchema = AgentPackageShareUrlInputObjectSchema.extend({
  packageDigest: DigestSchema,
  starterOrdinal: z.number().int().min(1).max(5),
  starterPrompt: z.string().min(1).max(1_000),
})
  .strict()
  .readonly();
export type PrepareAgentPackageRunInput = z.infer<typeof PrepareAgentPackageRunInputSchema>;

export const PROJECT_HISTORY_AGENT_TOOL_NAMES = [
  'create_agent_package_draft',
  'render_agent_package_draft',
  'create_agent_package_share',
  'read_agent_package_share',
  'prepare_agent_package_run',
] as const;
export type ProjectHistoryAgentToolName = (typeof PROJECT_HISTORY_AGENT_TOOL_NAMES)[number];

export const PROJECT_HISTORY_AGENT_FIXED_CONFIRMATION_MESSAGE =
  '我确认当前卡片中完整显示的 Agent 草稿，并授权从这个精确版本创建公开链接分享。任何持链接者都可读取；当前分享不过期且不可撤回，但这不等于 marketplace publication 或 public listing。如果卡片已变化，请停止。' as const;
export const PROJECT_HISTORY_AGENT_FIXED_CONFIRMATION_LABEL =
  '确认创建公开且不可撤回的分享' as const;
export const PROJECT_HISTORY_AGENT_DRAFT_SUMMARY =
  '这是从用户明确选择的来源 Project 历史中提炼出的草稿。模型按 Skill 仅采用 user/agent 字段，但 Host 的完整 reduced 结果已进入模型；字段投影、来源覆盖、完整性以及所有原文或秘密均未获技术证明，服务端只会额外拒绝明显的凭据模式。确认后会创建不过期且不可撤回的公开链接；任何持链接者都可读取，但这不等于 marketplace publication 或 public listing。' as const;
