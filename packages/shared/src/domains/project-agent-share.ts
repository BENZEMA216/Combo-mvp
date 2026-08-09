import { z } from 'zod';
import { IsoDateTimeSchema } from '../core/ids.js';

export const PROJECT_AGENT_SHARE_SCHEMA_VERSION = 'combo.project-agent-share/1' as const;

export const ProjectAgentGitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);

export const ProjectAgentRepositoryUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .url()
  .superRefine((value, ctx) => {
    const match = value.match(
      /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})\.git$/u,
    );
    if (!match || match[2] === '.' || match[2] === '..' || match[2]?.endsWith('.git')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'repositoryUrl 必须是 canonical https://github.com/<owner>/<repo>.git URL',
      });
    }
  });

export const ProjectAgentSourceRefSchema = z
  .string()
  .min(1)
  .max(255)
  .superRefine((value, ctx) => {
    const prefix = value.startsWith('refs/heads/')
      ? 'refs/heads/'
      : value.startsWith('refs/tags/')
        ? 'refs/tags/'
        : null;
    const tail = prefix ? value.slice(prefix.length) : '';
    const components = tail.split('/');
    const hasUnsafeCharacter = [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x20 || codePoint === 0x7f || '~^:?*[\\'.includes(character);
    });
    const invalid =
      prefix === null ||
      tail.length === 0 ||
      value.endsWith('/') ||
      value.endsWith('.') ||
      value.includes('..') ||
      value.includes('@{') ||
      value.includes('//') ||
      hasUnsafeCharacter ||
      components.some(
        (component) =>
          component.length === 0 ||
          component === '.' ||
          component === '..' ||
          component.startsWith('.') ||
          component.endsWith('.lock'),
      );
    if (invalid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'sourceRef 必须是完整且有效的 refs/heads/... 或 refs/tags/...',
      });
    }
  });

function uniqueBoundedStrings(label: string, pattern: RegExp) {
  return z
    .array(z.string().trim().min(1).max(128).regex(pattern))
    .max(32)
    .default([])
    .superRefine((items, ctx) => {
      if (new Set(items).size !== items.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} 不能包含重复项`,
        });
      }
    });
}

export const ProjectAgentRequirementsSchema = z
  .object({
    codexVersion: z.string().trim().min(1).max(64).optional(),
    commands: uniqueBoundedStrings('commands', /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/),
    plugins: uniqueBoundedStrings(
      'plugins',
      /^(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,62}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,62}(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,62})?$/,
    ),
    environmentVariableNames: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(128)
          .regex(/^[A-Z_][A-Z0-9_]{0,127}$/),
      )
      .max(32)
      .default([])
      .superRefine((items, ctx) => {
        if (new Set(items).size !== items.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'environmentVariableNames 不能包含重复项',
          });
        }
      }),
  })
  .strict();
export type ProjectAgentRequirements = z.infer<typeof ProjectAgentRequirementsSchema>;

export const CreateProjectAgentShareBodySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(500),
    repositoryUrl: ProjectAgentRepositoryUrlSchema,
    sourceRef: ProjectAgentSourceRefSchema,
    commitSha: ProjectAgentGitShaSchema,
    treeSha: ProjectAgentGitShaSchema,
    startPrompt: z.string().trim().min(1).max(4_000),
    requirements: ProjectAgentRequirementsSchema.optional(),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
export type CreateProjectAgentShareBody = z.infer<typeof CreateProjectAgentShareBodySchema>;

export const ProjectAgentShareManifestSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_AGENT_SHARE_SCHEMA_VERSION),
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(500),
    source: z
      .object({
        repositoryUrl: ProjectAgentRepositoryUrlSchema,
        sourceRef: ProjectAgentSourceRefSchema,
        commitSha: ProjectAgentGitShaSchema,
        treeSha: ProjectAgentGitShaSchema,
      })
      .strict(),
    startPrompt: z.string().min(1).max(4_000),
    requirements: ProjectAgentRequirementsSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type ProjectAgentShareManifest = z.infer<typeof ProjectAgentShareManifestSchema>;

export const ProjectAgentShareResultSchema = z
  .object({
    manifest: ProjectAgentShareManifestSchema,
    shareUrl: z.string().url().max(2_048),
    copyPrompt: z.string().min(1).max(20_000),
  })
  .strict();
export type ProjectAgentShareResult = z.infer<typeof ProjectAgentShareResultSchema>;

/** 32 random bytes encoded as unpadded base64url. */
export const ProjectAgentShareTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const ReadProjectAgentShareBodySchema = z
  .object({ shareUrl: z.string().url().max(2_048) })
  .strict();
export type ReadProjectAgentShareBody = z.infer<typeof ReadProjectAgentShareBodySchema>;
