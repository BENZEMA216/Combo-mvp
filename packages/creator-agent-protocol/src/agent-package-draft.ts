import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';

import { z } from 'zod';

import { canonicalFingerprint, canonicalizeJson } from './canonical.js';
import {
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
export const CREATOR_AGENT_PACKAGE_DRAFT_PROTOCOL = 'combo.agent-package-draft/1' as const;
export const CREATOR_AGENT_PACKAGE_DRAFT_REVISION_PROTOCOL =
  'combo.agent-package-draft-revision/1' as const;
export const CREATOR_AGENT_PACKAGE_DRAFT_MAX_BYTES = 65_536;

const DRAFT_FINGERPRINT_DOMAIN = 'combo.agent-package-draft/1:fingerprint';
const DRAFT_ID_PATTERN = /^draft\.agent-package\.[0-9a-f]{32}$/u;
const AGENT_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,79}$/u;

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

export function serializeCreatorAgentPackageDraftSnapshot(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentPackageDraftSnapshot(input));
}

export function parseCreatorAgentPackageDraftSnapshot(
  text: string,
): CreatorAgentPackageDraftSnapshot {
  return parseExact(text, verifyCreatorAgentPackageDraftSnapshot, 'Agent Package Draft');
}

function parseExact<Value>(text: string, verify: (input: unknown) => Value, label: string): Value {
  if (
    typeof text !== 'string' ||
    Buffer.byteLength(text, 'utf8') > CREATOR_AGENT_PACKAGE_DRAFT_MAX_BYTES
  ) {
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
): z.output<Schema> {
  const snapshot = snapshotJson(input, 0, { nodes: 0, bytes: 0 });
  const before = canonicalizeJson(snapshot);
  if (Buffer.byteLength(before, 'utf8') > CREATOR_AGENT_PACKAGE_DRAFT_MAX_BYTES) {
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
    if (budget.bytes > CREATOR_AGENT_PACKAGE_DRAFT_MAX_BYTES || containsLoneSurrogate(input)) {
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
      return snapshotJson(descriptor.value, depth + 1, budget);
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
    output[key] = snapshotJson(descriptor.value, depth + 1, budget);
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
