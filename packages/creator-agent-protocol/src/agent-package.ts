import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';

import { z } from 'zod';

import { canonicalizeJson } from './canonical.js';
import {
  Sha256DigestSchema,
  containsLoneSurrogate,
  containsNonPortableAgentReference,
  containsUnsafeAgentText,
  isProjectRelativeAgentPath,
  type Sha256Digest,
} from './primitives.js';
import { deepFreezeStrictJson, snapshotStrictJson } from './strict-json.js';
import {
  CREATOR_AGENT_PACKAGE_PROJECT_HISTORY_MAX_OMITTED_THREADS,
  CREATOR_AGENT_PACKAGE_PROJECT_HISTORY_MAX_SELECTED_THREADS,
} from './agent-package-draft.js';

export const CREATOR_AGENT_PACKAGE_PROTOCOL = 'combo.agent-package/1' as const;
export const CREATOR_AGENT_PACKAGE_FILENAME = 'agent.json' as const;
export const CREATOR_AGENT_PACKAGE_SOURCE_RECEIPT_PROTOCOL =
  'combo.agent-package-source-receipt/1' as const;
export const CREATOR_AGENT_PACKAGE_PROVENANCE_PROTOCOL =
  'combo.agent-package-provenance/1' as const;
export const CREATOR_AGENT_PACKAGE_HISTORY_SOURCE_RECEIPT_PROTOCOL =
  'combo.agent-package-history-source-receipt/1' as const;
export const CREATOR_AGENT_PACKAGE_HISTORY_PROVENANCE_PROTOCOL =
  'combo.agent-package-provenance/2' as const;
export const CREATOR_AGENT_PACKAGE_STARTER_PROMPTS_PROTOCOL =
  'combo.agent-package-starter-prompts/1' as const;
export const CREATOR_AGENT_PACKAGE_STARTER_PROMPTS_PATH =
  'skills/extracted-method/starter-prompts.json' as const;
export const CREATOR_AGENT_PACKAGE_MAX_MANIFEST_BYTES = 65_536;
export type CreatorAgentPackageDigest = Sha256Digest;

const AGENT_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,79}$/u;
const SKILL_PATH_PATTERN = /^skills\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\/SKILL\.md$/u;
const PACKAGE_FILE_PATH_PATTERN =
  /^(?:AGENT\.md|skills\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,79})+)$/u;
const MAX_PACKAGE_BYTES = 8 * 1_024 * 1_024;

const ProjectRelativeSourcePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) => isProjectRelativeAgentPath(value) && !containsLoneSurrogate(value),
    'Source receipt path must be Project-relative',
  )
  .refine((value) => !containsUnsafeAgentText(value), 'Source receipt path is unsafe');

const SourceReceiptSummarySchema = z
  .string()
  .min(1)
  .max(1_000)
  .refine((value) => value.normalize('NFC') === value, 'Source summary must use NFC')
  .refine((value) => value.trim() === value, 'Source summary must be canonical')
  .refine((value) => /[\p{L}\p{N}\p{P}\p{S}]/u.test(value), 'Source summary must be visible')
  .refine((value) => !containsUnsafeAgentText(value), 'Source summary is malformed or unsafe')
  .refine(
    (value) => !containsNonPortableAgentReference(value),
    'Source summary cannot contain local paths, URLs, or task identifiers',
  );

const CreatorAgentPackageSourceCitationSchema = z
  .object({
    path: ProjectRelativeSourcePathSchema,
    digest: Sha256DigestSchema,
  })
  .strict()
  .readonly();

export const CreatorAgentPackageSourceReceiptSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_PACKAGE_SOURCE_RECEIPT_PROTOCOL),
    sourceKind: z.literal('current_project'),
    contextRootDigest: Sha256DigestSchema,
    indexedEntryCount: z.number().int().nonnegative().max(500_000),
    indexedFileCount: z.number().int().nonnegative().max(500_000),
    uniqueIndexedByteCount: z
      .number()
      .int()
      .nonnegative()
      .max(32 * 1_024 * 1_024 * 1_024),
    coverageSummary: SourceReceiptSummarySchema,
    citedSources: z.array(CreatorAgentPackageSourceCitationSchema).min(1).max(32).readonly(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.indexedFileCount > receipt.indexedEntryCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['indexedFileCount'],
        message: 'Indexed files cannot exceed indexed entries',
      });
    }
    if (receipt.citedSources.length > receipt.indexedFileCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['citedSources'],
        message: 'Cited sources cannot exceed indexed files',
      });
    }
    requireAscendingUnique(
      receipt.citedSources.map(({ path }) => path),
      ['citedSources'],
      context,
    );
  })
  .readonly();
export type CreatorAgentPackageSourceReceipt = z.infer<
  typeof CreatorAgentPackageSourceReceiptSchema
>;

export const CreatorAgentPackageProvenanceSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_PACKAGE_PROVENANCE_PROTOCOL),
    sourceKind: z.literal('current_project'),
    sourceReceiptDigest: Sha256DigestSchema,
    creatorRequestDigest: Sha256DigestSchema.nullable(),
  })
  .strict()
  .readonly();
export type CreatorAgentPackageProvenance = z.infer<typeof CreatorAgentPackageProvenanceSchema>;

export const CreatorAgentPackageHistorySourceReceiptSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_PACKAGE_HISTORY_SOURCE_RECEIPT_PROTOCOL),
    sourceKind: z.literal('host_project_scoped_reduced_history'),
    selection: z.literal('user_selected_saved_project'),
    assurance: z.literal('best_effort'),
    completeness: z.literal('not_proven'),
    hostAttestation: z.literal('not_proven'),
    sourceProjectionEnforced: z.literal('not_proven'),
    rawStored: z.literal(false),
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
    limitationReasons: z
      .tuple([
        z.literal('READ_OUTPUT_BOUNDED_OR_TRUNCATED'),
        z.literal('READ_THREAD_SUMMARY_NOT_RAW_TRANSCRIPT'),
        z.literal('THREAD_LIST_GLOBAL_COVERAGE_NOT_ATTESTED'),
      ])
      .readonly(),
    candidateCommitment: Sha256DigestSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.readThreadCount !== receipt.discoveredThreadCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['readThreadCount'],
        message: 'Every selected eligible Project thread must be read before Package compilation',
      });
    }
  })
  .readonly();
export type CreatorAgentPackageHistorySourceReceipt = z.infer<
  typeof CreatorAgentPackageHistorySourceReceiptSchema
>;

export const CreatorAgentPackageHistoryProvenanceSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_PACKAGE_HISTORY_PROVENANCE_PROTOCOL),
    sourceKind: z.literal('host_project_scoped_reduced_history'),
    selection: z.literal('user_selected_saved_project'),
    sourceReceiptDigest: Sha256DigestSchema,
    creatorRequestDigest: Sha256DigestSchema,
    sourceDraftFingerprint: Sha256DigestSchema,
    completeness: z.literal('not_proven'),
    hostAttestation: z.literal('not_proven'),
    assurance: z.literal('best_effort'),
    sourceProjectionEnforced: z.literal('not_proven'),
    omittedThreadCount: z
      .number()
      .int()
      .nonnegative()
      .max(CREATOR_AGENT_PACKAGE_PROJECT_HISTORY_MAX_OMITTED_THREADS),
    rawStored: z.literal(false),
  })
  .strict()
  .readonly();
export type CreatorAgentPackageHistoryProvenance = z.infer<
  typeof CreatorAgentPackageHistoryProvenanceSchema
>;

const SafeLine = (minimum: number, maximum: number) =>
  z
    .string()
    .min(minimum)
    .max(maximum)
    .refine(
      (value) =>
        !containsLoneSurrogate(value) &&
        !/[\0\r\n\u0080-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value),
      'Agent Package text is malformed or unsafe',
    );

const CanonicalStarterPromptSchema = z
  .string()
  .min(1)
  .max(1_000)
  .refine((value) => value.normalize('NFC') === value, 'Starter prompt must use NFC')
  .refine((value) => value.trim() === value, 'Starter prompt must not have outer whitespace')
  .refine((value) => /[\p{L}\p{N}\p{P}\p{S}]/u.test(value), 'Starter prompt must be visible')
  .refine(
    (value) =>
      !containsLoneSurrogate(value) &&
      !containsUnsafeAgentText(value) &&
      !/[\r\n]/u.test(value) &&
      value.replace(/\s+/gu, ' ') === value,
    'Starter prompt must be one canonical safe line',
  );

export const CreatorAgentPackageStarterPromptsSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_PACKAGE_STARTER_PROMPTS_PROTOCOL),
    starterPrompts: z.array(CanonicalStarterPromptSchema).min(1).max(5).readonly(),
  })
  .strict()
  .superRefine((artifact, context) => {
    if (new Set(artifact.starterPrompts).size !== artifact.starterPrompts.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['starterPrompts'],
        message: 'Starter prompts must be unique',
      });
    }
  })
  .readonly();
export type CreatorAgentPackageStarterPrompts = z.infer<
  typeof CreatorAgentPackageStarterPromptsSchema
>;

const AgentPackageResourceSchema = z
  .object({
    path: z.string().max(240).regex(PACKAGE_FILE_PATH_PATTERN),
    byteLength: z
      .number()
      .int()
      .min(1)
      .max(2 * 1_024 * 1_024),
    digest: Sha256DigestSchema,
  })
  .strict()
  .readonly();

export type CreatorAgentPackageFile = z.infer<typeof AgentPackageResourceSchema>;

export const CreatorAgentPackageManifestSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_PACKAGE_PROTOCOL),
    name: z.string().regex(AGENT_NAME_PATTERN),
    description: SafeLine(1, 500),
    instructions: z.literal('AGENT.md'),
    skills: z.array(z.string().regex(SKILL_PATH_PATTERN)).max(1).readonly(),
    files: z.array(AgentPackageResourceSchema).min(1).max(256).readonly(),
  })
  .strict()
  .superRefine((manifest, context) => {
    requireAscendingUnique(manifest.skills, ['skills'], context);
    requireAscendingUnique(
      manifest.files.map((file) => file.path),
      ['files'],
      context,
    );
    const files = new Map(manifest.files.map((file) => [file.path, file]));
    const foldedPaths = new Set<string>();
    for (const [index, file] of manifest.files.entries()) {
      const folded = file.path.toLowerCase();
      if (foldedPaths.has(folded)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['files', index, 'path'],
          message: 'Agent Package paths collide under case folding',
        });
      }
      foldedPaths.add(folded);
      for (const [otherIndex, other] of manifest.files.entries()) {
        if (otherIndex === index) continue;
        const otherFolded = other.path.toLowerCase();
        if (otherFolded.startsWith(`${folded}/`)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['files', otherIndex, 'path'],
            message: 'Agent Package file paths cannot be ancestors of other files',
          });
        }
      }
    }
    const instructions = files.get(manifest.instructions);
    if (instructions === undefined || instructions.byteLength > 65_536) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['instructions'],
        message: 'Agent Package must inventory a bounded AGENT.md',
      });
    }
    const skillRoots = new Set<string>();
    for (const [index, path] of manifest.skills.entries()) {
      const skillName = path.split('/')[1] ?? '';
      const file = files.get(path);
      if (file === undefined || file.byteLength > 65_536 || skillName.includes('--')) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['skills', index],
          message: 'Agent Package must inventory every bounded SKILL.md',
        });
      }
      skillRoots.add(path.slice(0, -'/SKILL.md'.length));
    }
    for (const [index, file] of manifest.files.entries()) {
      if (
        file.path !== 'AGENT.md' &&
        ![...skillRoots].some((root) => file.path.startsWith(`${root}/`))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['files', index, 'path'],
          message: 'Agent Package file is outside a declared Skill directory',
        });
      }
      if (file.path.endsWith('/SKILL.md') && !manifest.skills.includes(file.path)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['files', index, 'path'],
          message: 'Agent Package contains an undeclared Skill entry',
        });
      }
    }
    if (manifest.files.reduce((total, file) => total + file.byteLength, 0) > MAX_PACKAGE_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['files'],
        message: 'Agent Package exceeds the total byte limit',
      });
    }
  })
  .readonly();
export type CreatorAgentPackageManifest = z.infer<typeof CreatorAgentPackageManifestSchema>;

export function createCreatorAgentPackageManifest(input: unknown): CreatorAgentPackageManifest {
  return exactDetached(CreatorAgentPackageManifestSchema, input, 'Agent Package manifest');
}

export function verifyCreatorAgentPackageManifest(input: unknown): CreatorAgentPackageManifest {
  return exactDetached(CreatorAgentPackageManifestSchema, input, 'Agent Package manifest');
}

export function createCreatorAgentPackageStarterPrompts(
  input: unknown,
): CreatorAgentPackageStarterPrompts {
  return exactDetached(
    CreatorAgentPackageStarterPromptsSchema,
    input,
    'Agent Package starter prompts',
  );
}

export function verifyCreatorAgentPackageStarterPrompts(
  input: unknown,
): CreatorAgentPackageStarterPrompts {
  return createCreatorAgentPackageStarterPrompts(input);
}

export function serializeCreatorAgentPackageStarterPrompts(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentPackageStarterPrompts(input));
}

export function parseCreatorAgentPackageStarterPrompts(
  text: string,
): CreatorAgentPackageStarterPrompts {
  return parseExactPackageJson(
    text,
    verifyCreatorAgentPackageStarterPrompts,
    'Agent Package starter prompts',
  );
}

export function createCreatorAgentPackageSourceReceipt(
  input: unknown,
): CreatorAgentPackageSourceReceipt {
  return exactDetached(
    CreatorAgentPackageSourceReceiptSchema,
    input,
    'Agent Package source receipt',
  );
}

export function verifyCreatorAgentPackageSourceReceipt(
  input: unknown,
): CreatorAgentPackageSourceReceipt {
  return createCreatorAgentPackageSourceReceipt(input);
}

export function serializeCreatorAgentPackageSourceReceipt(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentPackageSourceReceipt(input));
}

export function parseCreatorAgentPackageSourceReceipt(
  text: string,
): CreatorAgentPackageSourceReceipt {
  return parseExactPackageJson(
    text,
    verifyCreatorAgentPackageSourceReceipt,
    'Agent Package source receipt',
  );
}

export function digestCreatorAgentPackageSourceReceipt(input: unknown): Sha256Digest {
  return rawDigest(Buffer.from(serializeCreatorAgentPackageSourceReceipt(input), 'utf8'));
}

export function createCreatorAgentPackageProvenance(input: unknown): CreatorAgentPackageProvenance {
  return exactDetached(
    CreatorAgentPackageProvenanceSchema,
    input,
    'Agent Package provenance binding',
  );
}

export function verifyCreatorAgentPackageProvenance(input: unknown): CreatorAgentPackageProvenance {
  return createCreatorAgentPackageProvenance(input);
}

export function serializeCreatorAgentPackageProvenance(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentPackageProvenance(input));
}

export function parseCreatorAgentPackageProvenance(text: string): CreatorAgentPackageProvenance {
  return parseExactPackageJson(
    text,
    verifyCreatorAgentPackageProvenance,
    'Agent Package provenance',
  );
}

export function createCreatorAgentPackageHistorySourceReceipt(
  input: unknown,
): CreatorAgentPackageHistorySourceReceipt {
  return exactDetached(
    CreatorAgentPackageHistorySourceReceiptSchema,
    input,
    'Agent Package history source receipt',
  );
}

export function verifyCreatorAgentPackageHistorySourceReceipt(
  input: unknown,
): CreatorAgentPackageHistorySourceReceipt {
  return createCreatorAgentPackageHistorySourceReceipt(input);
}

export function serializeCreatorAgentPackageHistorySourceReceipt(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentPackageHistorySourceReceipt(input));
}

export function parseCreatorAgentPackageHistorySourceReceipt(
  text: string,
): CreatorAgentPackageHistorySourceReceipt {
  return parseExactPackageJson(
    text,
    verifyCreatorAgentPackageHistorySourceReceipt,
    'Agent Package history source receipt',
  );
}

export function digestCreatorAgentPackageHistorySourceReceipt(input: unknown): Sha256Digest {
  return rawDigest(Buffer.from(serializeCreatorAgentPackageHistorySourceReceipt(input), 'utf8'));
}

export function createCreatorAgentPackageHistoryProvenance(
  input: unknown,
): CreatorAgentPackageHistoryProvenance {
  return exactDetached(
    CreatorAgentPackageHistoryProvenanceSchema,
    input,
    'Agent Package history provenance binding',
  );
}

export function verifyCreatorAgentPackageHistoryProvenance(
  input: unknown,
): CreatorAgentPackageHistoryProvenance {
  return createCreatorAgentPackageHistoryProvenance(input);
}

export function serializeCreatorAgentPackageHistoryProvenance(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentPackageHistoryProvenance(input));
}

export function parseCreatorAgentPackageHistoryProvenance(
  text: string,
): CreatorAgentPackageHistoryProvenance {
  return parseExactPackageJson(
    text,
    verifyCreatorAgentPackageHistoryProvenance,
    'Agent Package history provenance',
  );
}

export function digestCreatorAgentPackage(input: unknown): CreatorAgentPackageDigest {
  const bytes = serializeCreatorAgentPackageManifest(input);
  return rawDigest(Buffer.from(bytes, 'utf8'));
}

export function digestCreatorAgentPackageFile(bytes: Uint8Array): Sha256Digest {
  if (!(bytes instanceof Uint8Array) || isProxy(bytes)) {
    throw new TypeError('Agent Package file bytes must be a Uint8Array');
  }
  return rawDigest(bytes);
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
        message: 'Agent Package paths must be unique and in ascending order',
      });
    }
  }
}

export function serializeCreatorAgentPackageManifest(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentPackageManifest(input));
}

export function parseCreatorAgentPackageManifest(text: string): CreatorAgentPackageManifest {
  return parseExactPackageJson(text, verifyCreatorAgentPackageManifest, 'Agent Package manifest');
}

function parseExactPackageJson<Value>(
  text: string,
  verify: (input: unknown) => Value,
  label: string,
): Value {
  if (typeof text !== 'string') throw new TypeError(`${label} must be JSON text`);
  if (Buffer.byteLength(text, 'utf8') > CREATOR_AGENT_PACKAGE_MAX_MANIFEST_BYTES) {
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

function exactDetached<Schema extends z.ZodTypeAny>(
  schema: Schema,
  input: unknown,
  label: string,
): z.output<Schema> {
  const snapshot = snapshotStrictJson(input, {
    maximumBytes: CREATOR_AGENT_PACKAGE_MAX_MANIFEST_BYTES,
    label: 'Agent Package value',
  });
  const before = canonicalizeJson(snapshot);
  if (Buffer.byteLength(before, 'utf8') > CREATOR_AGENT_PACKAGE_MAX_MANIFEST_BYTES) {
    throw new TypeError('Agent Package value exceeds the canonical byte limit');
  }
  const parsed = schema.parse(snapshot);
  if (canonicalizeJson(parsed) !== before) {
    throw new TypeError(`${label} changed during schema parsing`);
  }
  deepFreezeStrictJson(parsed);
  return parsed;
}

function rawDigest(bytes: Uint8Array): Sha256Digest {
  return Sha256DigestSchema.parse(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
}
