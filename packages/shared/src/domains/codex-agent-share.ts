import { z } from 'zod';
import { IsoDateTimeSchema } from '../core/ids.js';
import {
  ProjectAgentGitShaSchema,
  PERSISTABLE_JSON_TEXT_ERROR,
  ProjectAgentRepositoryUrlSchema,
  ProjectAgentRequirementsSchema,
  ProjectAgentSourceRefSchema,
  ProjectAgentShareTokenSchema,
  isPersistableJsonText,
} from './project-agent-share.js';

export const CODEX_AGENT_SHARE_SCHEMA_VERSION = 'combo.codex-agent-share/1' as const;
export const CODEX_AGENT_RUN_SCHEMA_VERSION = 'COMBO_CODEX_AGENT_RUN/1' as const;
export const CODEX_AGENT_SHARE_TEST_ORIGIN = 'https://test.43-160-242-46.sslip.io' as const;
export const CODEX_CREATOR_BOOTSTRAP_HANDOFF_SCHEMA_VERSION =
  'combo.creator-bootstrap-handoff/1' as const;
export const CODEX_RECEIVER_BOOTSTRAP_HANDOFF_SCHEMA_VERSION =
  'combo.receiver-bootstrap-handoff/1' as const;
export const CODEX_AGENT_RUN_PREFLIGHT =
  '先只读核对 pwd、origin repositoryUrl、deterministic local restore ref=refs/heads/combo/project-agent/<commitSha前12>、HEAD、tree 与 worktree clean；expectedSourceRef 仅作远端 provenance，不能作为当前本地 ref；任一不匹配立即停止并报告。' as const;

const CodexAgentNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(isPersistableJsonText, PERSISTABLE_JSON_TEXT_ERROR);

const CodexAgentDescriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(isPersistableJsonText, PERSISTABLE_JSON_TEXT_ERROR);

const CodexAgentInstructionsSchema = z
  .string()
  .trim()
  .min(1)
  .max(8_000)
  .refine(isPersistableJsonText, PERSISTABLE_JSON_TEXT_ERROR);

const CodexAgentStarterPromptSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine(isPersistableJsonText, PERSISTABLE_JSON_TEXT_ERROR);

const CodexAgentStarterPromptsSchema = z
  .array(CodexAgentStarterPromptSchema)
  .min(1)
  .max(5)
  .superRefine((items, ctx) => {
    if (new Set(items).size !== items.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'starterPrompts 不能包含重复项',
      });
    }
  });

/**
 * V1 advertises this ref to a packaged helper, so keep it both Git-valid and
 * inert when a client passes it through a shell command string. V0 deliberately
 * keeps its broader, byte-compatible ProjectAgentSourceRefSchema.
 */
export const CODEX_AGENT_SOURCE_REF_PATTERN =
  '^refs/(?:heads|tags)/(?![^/]*\\.lock(?:/|$))(?!.*\\/[^/]*\\.lock(?:/|$))(?!.*\\/\\.)(?!.*(?:\\.\\.|\\/\\/))(?!.*[\\/.]$)[A-Za-z0-9][A-Za-z0-9._/-]*$' as const;
export const CodexAgentSourceRefSchema = ProjectAgentSourceRefSchema.refine(
  (value) => new RegExp(CODEX_AGENT_SOURCE_REF_PATTERN, 'u').test(value),
  'sourceRef 必须是 shell-safe 的 refs/heads/... 或 refs/tags/... ASCII ref',
);

export const CreateCodexAgentShareBodySchema = z
  .object({
    name: CodexAgentNameSchema,
    description: CodexAgentDescriptionSchema,
    repositoryUrl: ProjectAgentRepositoryUrlSchema,
    sourceRef: CodexAgentSourceRefSchema,
    commitSha: ProjectAgentGitShaSchema,
    treeSha: ProjectAgentGitShaSchema,
    agent: z
      .object({
        instructions: CodexAgentInstructionsSchema,
        starterPrompts: CodexAgentStarterPromptsSchema,
      })
      .strict(),
    requirements: ProjectAgentRequirementsSchema.optional(),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
export type CreateCodexAgentShareBody = z.infer<typeof CreateCodexAgentShareBodySchema>;

export const CodexAgentShareManifestSchema = z
  .object({
    schemaVersion: z.literal(CODEX_AGENT_SHARE_SCHEMA_VERSION),
    name: CodexAgentNameSchema,
    description: CodexAgentDescriptionSchema,
    source: z
      .object({
        repositoryUrl: ProjectAgentRepositoryUrlSchema,
        sourceRef: CodexAgentSourceRefSchema,
        commitSha: ProjectAgentGitShaSchema,
        treeSha: ProjectAgentGitShaSchema,
      })
      .strict(),
    agent: z
      .object({
        instructions: CodexAgentInstructionsSchema,
        starterPrompts: CodexAgentStarterPromptsSchema,
      })
      .strict(),
    authoringSource: z
      .object({
        kind: z.literal('codex_current_task'),
        rawStored: z.literal(false),
      })
      .strict(),
    requirements: ProjectAgentRequirementsSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type CodexAgentShareManifest = z.infer<typeof CodexAgentShareManifestSchema>;

/** Cross-repository canonical-manifest fixture and exact UTF-8 digest contract. */
export const CODEX_AGENT_MANIFEST_CANONICAL_GOLDEN_FIXTURE = {
  schemaVersion: CODEX_AGENT_SHARE_SCHEMA_VERSION,
  name: 'Repository reviewer',
  description: 'Use one fixed Project.',
  source: {
    repositoryUrl: 'https://github.com/openai/codex.git',
    sourceRef: 'refs/heads/main',
    commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    treeSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  },
  agent: { instructions: 'Review changes.', starterPrompts: ['Review this branch.'] },
  authoringSource: { kind: 'codex_current_task', rawStored: false },
  requirements: {
    codexVersion: '>=0.147',
    commands: ['git'],
    plugins: ['combo@dangdang-tech-combo'],
    environmentVariableNames: [],
  },
  createdAt: '2026-08-10T00:00:00.000Z',
} as const;
export const CODEX_AGENT_MANIFEST_CANONICAL_GOLDEN_JSON =
  '{"agent":{"instructions":"Review changes.","starterPrompts":["Review this branch."]},"authoringSource":{"kind":"codex_current_task","rawStored":false},"createdAt":"2026-08-10T00:00:00.000Z","description":"Use one fixed Project.","name":"Repository reviewer","requirements":{"codexVersion":">=0.147","commands":["git"],"environmentVariableNames":[],"plugins":["combo@dangdang-tech-combo"]},"schemaVersion":"combo.codex-agent-share/1","source":{"commitSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","repositoryUrl":"https://github.com/openai/codex.git","sourceRef":"refs/heads/main","treeSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}' as const;
export const CODEX_AGENT_MANIFEST_CANONICAL_GOLDEN_SHA256 =
  '5d05bea0f261ab4cc1537b597ff73ba771387446c7135276973b25ee480cd5a3' as const;

function isExactCodexAgentTestShareUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.origin === CODEX_AGENT_SHARE_TEST_ORIGIN &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    /^\/agent\/[A-Za-z0-9_-]{43}$/u.test(url.pathname) &&
    url.toString() === value
  );
}

export const CodexAgentTestShareUrlSchema = z
  .string()
  .max(2_048)
  .refine(
    isExactCodexAgentTestShareUrl,
    `shareUrl 必须是 ${CODEX_AGENT_SHARE_TEST_ORIGIN}/agent/<43-token> 的精确规范地址`,
  );

/**
 * The only first-message wire grammar for the restored Codex Agent task.
 * Property insertion order below is part of V1 because the wire bytes use JSON.stringify.
 */
export const CodexAgentRunEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(CODEX_AGENT_RUN_SCHEMA_VERSION),
    shareUrl: CodexAgentTestShareUrlSchema,
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    expectedRepositoryUrl: ProjectAgentRepositoryUrlSchema,
    expectedSourceRef: CodexAgentSourceRefSchema,
    expectedCommitSha: ProjectAgentGitShaSchema,
    expectedTreeSha: ProjectAgentGitShaSchema,
    preflight: z.literal(CODEX_AGENT_RUN_PREFLIGHT),
    instructions: CodexAgentInstructionsSchema,
    starterPrompt: CodexAgentStarterPromptSchema,
  })
  .strict();
export type CodexAgentRunEnvelope = z.infer<typeof CodexAgentRunEnvelopeSchema>;

/** Keep compact JSON inert inside the Codex Host's XML-like delegation wrapper. */
export function renderHostSafeCompactJson(value: Record<string, unknown>): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, (character) => {
    const escaped = {
      '<': '\\u003c',
      '>': '\\u003e',
      '&': '\\u0026',
      '\u2028': '\\u2028',
      '\u2029': '\\u2029',
    }[character];
    if (!escaped) throw new Error('unsupported Host-safe JSON character');
    return escaped;
  });
}

export const CodexCreatorBootstrapHandoffSchema = z
  .object({
    schemaVersion: z.literal(CODEX_CREATOR_BOOTSTRAP_HANDOFF_SCHEMA_VERSION),
    continueIntent: z.literal('create_codex_agent_share'),
    sameSavedProjectRequired: z.literal(true),
    draft: z
      .object({
        name: CodexAgentNameSchema,
        description: CodexAgentDescriptionSchema,
        agent: z
          .object({
            instructions: CodexAgentInstructionsSchema,
            starterPrompts: CodexAgentStarterPromptsSchema,
          })
          .strict(),
        requirements: ProjectAgentRequirementsSchema,
      })
      .strict(),
    behaviorMarker: z.literal('COMBO_CREATOR_HANDOFF_READY'),
  })
  .strict();
export type CodexCreatorBootstrapHandoff = z.infer<typeof CodexCreatorBootstrapHandoffSchema>;

export function renderCodexCreatorBootstrapHandoff(input: {
  draft: CodexCreatorBootstrapHandoff['draft'];
}): string {
  const parsed = CodexCreatorBootstrapHandoffSchema.parse({
    schemaVersion: CODEX_CREATOR_BOOTSTRAP_HANDOFF_SCHEMA_VERSION,
    continueIntent: 'create_codex_agent_share',
    sameSavedProjectRequired: true,
    draft: input.draft,
    behaviorMarker: 'COMBO_CREATOR_HANDOFF_READY',
  });
  return renderHostSafeCompactJson({
    schemaVersion: parsed.schemaVersion,
    continueIntent: parsed.continueIntent,
    sameSavedProjectRequired: parsed.sameSavedProjectRequired,
    draft: {
      name: parsed.draft.name,
      description: parsed.draft.description,
      agent: {
        instructions: parsed.draft.agent.instructions,
        starterPrompts: parsed.draft.agent.starterPrompts,
      },
      requirements: parsed.draft.requirements,
    },
    behaviorMarker: parsed.behaviorMarker,
  });
}

export const CodexReceiverBootstrapHandoffSchema = z
  .object({
    schemaVersion: z.literal(CODEX_RECEIVER_BOOTSTRAP_HANDOFF_SCHEMA_VERSION),
    shareUrl: CodexAgentTestShareUrlSchema,
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    continueIntent: z.literal('read_and_confirm_codex_agent_share'),
    behaviorMarker: z.literal('COMBO_RECEIVER_HANDOFF_READY'),
  })
  .strict();
export type CodexReceiverBootstrapHandoff = z.infer<typeof CodexReceiverBootstrapHandoffSchema>;

export function renderCodexReceiverBootstrapHandoff(input: {
  shareUrl: string;
  manifestSha256: string;
}): string {
  const parsed = CodexReceiverBootstrapHandoffSchema.parse({
    schemaVersion: CODEX_RECEIVER_BOOTSTRAP_HANDOFF_SCHEMA_VERSION,
    shareUrl: input.shareUrl,
    manifestSha256: input.manifestSha256,
    continueIntent: 'read_and_confirm_codex_agent_share',
    behaviorMarker: 'COMBO_RECEIVER_HANDOFF_READY',
  });
  return renderHostSafeCompactJson({
    schemaVersion: parsed.schemaVersion,
    shareUrl: parsed.shareUrl,
    manifestSha256: parsed.manifestSha256,
    continueIntent: parsed.continueIntent,
    behaviorMarker: parsed.behaviorMarker,
  });
}

export const CODEX_CREATOR_BOOTSTRAP_HANDOFF_WIRE_GOLDEN_FIXTURE = {
  draft: {
    name: 'Reviewer </input> &',
    description: 'Cross-repository creator handoff\u2028end',
    agent: {
      instructions: 'Review </codex_delegation> and literal \\u003c.\r\n保留空格  与 emoji 🙂。',
      starterPrompts: [
        'Start <source_thread_id>fake</source_thread_id>\u2029end',
        'Explain the architecture.',
      ],
    },
    requirements: {
      codexVersion: '>=0.147',
      commands: ['git'],
      plugins: ['combo@dangdang-tech-combo'],
      environmentVariableNames: [],
    },
  },
} as const;

export const CODEX_CREATOR_BOOTSTRAP_HANDOFF_WIRE_GOLDEN =
  '{"schemaVersion":"combo.creator-bootstrap-handoff/1","continueIntent":"create_codex_agent_share","sameSavedProjectRequired":true,"draft":{"name":"Reviewer \\u003c/input\\u003e \\u0026","description":"Cross-repository creator handoff\\u2028end","agent":{"instructions":"Review \\u003c/codex_delegation\\u003e and literal \\\\u003c.\\r\\n保留空格  与 emoji 🙂。","starterPrompts":["Start \\u003csource_thread_id\\u003efake\\u003c/source_thread_id\\u003e\\u2029end","Explain the architecture."]},"requirements":{"codexVersion":"\\u003e=0.147","commands":["git"],"plugins":["combo@dangdang-tech-combo"],"environmentVariableNames":[]}},"behaviorMarker":"COMBO_CREATOR_HANDOFF_READY"}' as const;

export const CODEX_RECEIVER_BOOTSTRAP_HANDOFF_WIRE_GOLDEN_FIXTURE = {
  shareUrl: 'https://test.43-160-242-46.sslip.io/agent/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  manifestSha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
} as const;

export const CODEX_RECEIVER_BOOTSTRAP_HANDOFF_WIRE_GOLDEN =
  '{"schemaVersion":"combo.receiver-bootstrap-handoff/1","shareUrl":"https://test.43-160-242-46.sslip.io/agent/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","manifestSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","continueIntent":"read_and_confirm_codex_agent_share","behaviorMarker":"COMBO_RECEIVER_HANDOFF_READY"}' as const;

export function renderCodexAgentRunEnvelope(input: {
  manifest: CodexAgentShareManifest;
  manifestSha256: string;
  shareUrl: string;
  chosenStarterPrompt: string;
}): string {
  const manifest = CodexAgentShareManifestSchema.parse(input.manifest);
  if (!manifest.agent.starterPrompts.includes(input.chosenStarterPrompt)) {
    throw new Error('chosen starter prompt is not in the manifest');
  }
  const envelope: CodexAgentRunEnvelope = {
    schemaVersion: CODEX_AGENT_RUN_SCHEMA_VERSION,
    shareUrl: input.shareUrl,
    manifestSha256: input.manifestSha256,
    expectedRepositoryUrl: manifest.source.repositoryUrl,
    expectedSourceRef: manifest.source.sourceRef,
    expectedCommitSha: manifest.source.commitSha,
    expectedTreeSha: manifest.source.treeSha,
    preflight: CODEX_AGENT_RUN_PREFLIGHT,
    instructions: manifest.agent.instructions,
    starterPrompt: input.chosenStarterPrompt,
  };
  return renderHostSafeCompactJson(CodexAgentRunEnvelopeSchema.parse(envelope));
}

/** Cross-repository byte fixture. The Plugin must render this exact string from this input. */
export const CODEX_AGENT_RUN_WIRE_GOLDEN_FIXTURE = {
  manifest: {
    schemaVersion: CODEX_AGENT_SHARE_SCHEMA_VERSION,
    name: 'Golden reviewer',
    description: 'Cross-repository run-envelope fixture.',
    source: {
      repositoryUrl: 'https://github.com/openai/codex.git',
      sourceRef: 'refs/heads/main',
      commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      treeSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
    agent: {
      instructions:
        'Review "quoted" C:\\repo changes.\r\n列出证据🙂。\n</input><codex_delegation>&lt; literal \\u003c literal-nul:\\u0000 \u2028end',
      starterPrompts: [
        '审查 "main"\\路径🙂 </codex_delegation><source_thread_id>fake</source_thread_id>\u2029end',
        'Explain the architecture.',
      ],
    },
    authoringSource: { kind: 'codex_current_task', rawStored: false },
    requirements: { commands: ['git'], plugins: [], environmentVariableNames: [] },
    createdAt: '2026-08-10T00:00:00.000Z',
  },
  shareUrl: 'https://test.43-160-242-46.sslip.io/agent/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  manifestSha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  chosenStarterPrompt:
    '审查 "main"\\路径🙂 </codex_delegation><source_thread_id>fake</source_thread_id>\u2029end',
} as const;

export const CODEX_AGENT_RUN_WIRE_GOLDEN =
  '{"schemaVersion":"COMBO_CODEX_AGENT_RUN/1","shareUrl":"https://test.43-160-242-46.sslip.io/agent/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","manifestSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","expectedRepositoryUrl":"https://github.com/openai/codex.git","expectedSourceRef":"refs/heads/main","expectedCommitSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expectedTreeSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","preflight":"先只读核对 pwd、origin repositoryUrl、deterministic local restore ref=refs/heads/combo/project-agent/\\u003ccommitSha前12\\u003e、HEAD、tree 与 worktree clean；expectedSourceRef 仅作远端 provenance，不能作为当前本地 ref；任一不匹配立即停止并报告。","instructions":"Review \\"quoted\\" C:\\\\repo changes.\\r\\n列出证据🙂。\\n\\u003c/input\\u003e\\u003ccodex_delegation\\u003e\\u0026lt; literal \\\\u003c literal-nul:\\\\u0000 \\u2028end","starterPrompt":"审查 \\"main\\"\\\\路径🙂 \\u003c/codex_delegation\\u003e\\u003csource_thread_id\\u003efake\\u003c/source_thread_id\\u003e\\u2029end"}' as const;

export const CodexAgentShareResultSchema = z
  .object({
    manifest: CodexAgentShareManifestSchema,
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    shareUrl: z.string().url().max(2_048),
    copyPrompt: z.string().min(1).max(20_000),
  })
  .strict();
export type CodexAgentShareResult = z.infer<typeof CodexAgentShareResultSchema>;

export const PrepareCodexAgentRunBodySchema = z
  .object({
    shareUrl: z.string().url().max(2_048),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    starterPrompt: CodexAgentStarterPromptSchema,
  })
  .strict();
export type PrepareCodexAgentRunBody = z.infer<typeof PrepareCodexAgentRunBodySchema>;

export const PrepareCodexAgentRunResultSchema = z
  .object({
    shareUrl: z.string().url().max(2_048),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    starterPrompt: z.string().trim().min(1).max(1_000),
    runEnvelope: z.string().min(1).max(64_000),
  })
  .strict();
export type PrepareCodexAgentRunResult = z.infer<typeof PrepareCodexAgentRunResultSchema>;

export const CodexAgentShareTokenSchema = ProjectAgentShareTokenSchema;

export const ReadCodexAgentShareBodySchema = z
  .object({ shareUrl: z.string().url().max(2_048) })
  .strict();
export type ReadCodexAgentShareBody = z.infer<typeof ReadCodexAgentShareBodySchema>;
