import { isProxy } from 'node:util/types';

import { z } from 'zod';

import { canonicalFingerprint, canonicalizeJson } from './canonical.js';
import { Sha256DigestSchema, containsLoneSurrogate, type Sha256Digest } from './primitives.js';

export const CREATOR_AGENT_DEFINITION_PROTOCOL = 'combo.creator-agent-definition/1' as const;
export const CREATOR_AGENT_DRAFT_PROTOCOL = 'combo.creator-agent-draft/1' as const;
export const CREATOR_AGENT_DRAFT_HANDOFF_PROTOCOL = 'combo.creator-agent-draft-handoff/1' as const;
export const CREATOR_AGENT_VERSION_PROTOCOL = 'combo.creator-agent-version/1' as const;
export const CREATOR_AGENT_MAX_CANONICAL_BYTES = 65_536;

const DEFINITION_FINGERPRINT_DOMAIN = 'combo.creator-agent-definition/1' as const;
const DRAFT_FINGERPRINT_DOMAIN = 'combo.creator-agent-draft/1' as const;
const VERSION_FINGERPRINT_DOMAIN = 'combo.creator-agent-version/1' as const;
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
