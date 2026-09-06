import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';

import { z } from 'zod';

import { canonicalizeJson } from './canonical.js';
import {
  CREATOR_AGENT_PACKAGE_DRAFT_V2_PROTOCOL,
  digestCreatorAgentPackageCreatorRequestV2,
  verifyCreatorAgentPackageDraftSnapshotV2,
} from './agent-package-draft.js';
import {
  Sha256DigestSchema,
  containsLoneSurrogate,
  containsNonPortableAgentReference,
  containsUnsafeAgentText,
  isProjectRelativeAgentPath,
  type Sha256Digest,
} from './primitives.js';

export const CREATOR_AGENT_PACKAGE_PROTOCOL = 'combo.agent-package/1' as const;
export const CREATOR_AGENT_PACKAGE_FILENAME = 'agent.json' as const;
export const CREATOR_AGENT_PACKAGE_SOURCE_RECEIPT_PROTOCOL =
  'combo.agent-package-source-receipt/1' as const;
export const CREATOR_AGENT_PACKAGE_CONVERSATION_SOURCE_RECEIPT_PROTOCOL =
  'combo.agent-package-source-receipt/2' as const;
export const CREATOR_AGENT_PACKAGE_PROVENANCE_PROTOCOL =
  'combo.agent-package-provenance/1' as const;
export const CREATOR_AGENT_PACKAGE_CONVERSATION_PROVENANCE_PROTOCOL =
  'combo.agent-package-provenance/2' as const;
export const CREATOR_AGENT_PACKAGE_COMPILATION_RECEIPT_PROTOCOL =
  'combo.agent-package-compilation-receipt/1' as const;
export const CREATOR_AGENT_PACKAGE_MAX_MANIFEST_BYTES = 65_536;
export type CreatorAgentPackageDigest = Sha256Digest;

const AGENT_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,79}$/u;
const SKILL_PATH_PATTERN = /^skills\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\/SKILL\.md$/u;
const PACKAGE_FILE_PATH_PATTERN =
  /^(?:AGENT\.md|skills\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,79})+)$/u;
const PACKAGE_PROVENANCE_PATH_PATTERN =
  /^skills\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\/provenance\.json$/u;
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

export const CreatorAgentPackageConversationSourceReceiptSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_PACKAGE_CONVERSATION_SOURCE_RECEIPT_PROTOCOL),
    sourceKind: z.literal('current_conversation'),
    sourceBoundary: z.literal('desktop_attested_active_current_task'),
    snapshotBoundary: z.literal('before_direct_creator_item'),
    visibility: z.literal('user_visible_items_only'),
    snapshotCompleteness: z.literal('complete'),
    rawStored: z.literal(false),
    snapshotCommitmentScheme: z.literal('host_hmac_sha256_per_run/1'),
    snapshotCommitment: Sha256DigestSchema,
    selectedVisibleItemCount: z.number().int().min(1).max(500_000),
    coverageSummary: SourceReceiptSummarySchema,
  })
  .strict()
  .readonly();
export type CreatorAgentPackageConversationSourceReceipt = z.infer<
  typeof CreatorAgentPackageConversationSourceReceiptSchema
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

export const CreatorAgentPackageConversationProvenanceSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_PACKAGE_CONVERSATION_PROVENANCE_PROTOCOL),
    sourceKind: z.literal('current_conversation'),
    sourceReceiptDigest: Sha256DigestSchema,
    creatorRequestDigest: Sha256DigestSchema,
  })
  .strict()
  .readonly();
export type CreatorAgentPackageConversationProvenance = z.infer<
  typeof CreatorAgentPackageConversationProvenanceSchema
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

const CompilerVersionSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^combo\.[a-z0-9](?:[a-z0-9.-]{0,110})\/[1-9][0-9]*$/u)
  .refine((value) => value.normalize('NFC') === value, 'Compiler version must use NFC');

export const CreatorAgentPackageCompilationReceiptSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_PACKAGE_COMPILATION_RECEIPT_PROTOCOL),
    draftProtocol: z.literal(CREATOR_AGENT_PACKAGE_DRAFT_V2_PROTOCOL),
    draftId: z.string().regex(/^draft\.agent-package\.[0-9a-f]{32}$/u),
    draftRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    draftFingerprint: Sha256DigestSchema,
    compilerVersion: CompilerVersionSchema,
    sourceReceiptDigest: Sha256DigestSchema,
    creatorRequestDigest: Sha256DigestSchema,
    provenancePath: z.string().max(240).regex(PACKAGE_PROVENANCE_PATH_PATTERN),
    provenanceFileDigest: Sha256DigestSchema,
    packageProtocol: z.literal(CREATOR_AGENT_PACKAGE_PROTOCOL),
    packageDigest: Sha256DigestSchema,
  })
  .strict()
  .readonly();
export type CreatorAgentPackageCompilationReceipt = z.infer<
  typeof CreatorAgentPackageCompilationReceiptSchema
>;

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

export function createCreatorAgentPackageSourceReceipt(
  input: unknown,
): CreatorAgentPackageSourceReceipt {
  return exactDetached(
    CreatorAgentPackageSourceReceiptSchema,
    input,
    'Agent Package source receipt',
  );
}

export function createCreatorAgentPackageConversationSourceReceipt(
  input: unknown,
): CreatorAgentPackageConversationSourceReceipt {
  return exactDetached(
    CreatorAgentPackageConversationSourceReceiptSchema,
    input,
    'Conversation Agent Package source receipt',
  );
}

export function verifyCreatorAgentPackageConversationSourceReceipt(
  input: unknown,
): CreatorAgentPackageConversationSourceReceipt {
  return createCreatorAgentPackageConversationSourceReceipt(input);
}

export function serializeCreatorAgentPackageConversationSourceReceipt(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentPackageConversationSourceReceipt(input));
}

export function parseCreatorAgentPackageConversationSourceReceipt(
  text: string,
): CreatorAgentPackageConversationSourceReceipt {
  return parseExactPackageJson(
    text,
    verifyCreatorAgentPackageConversationSourceReceipt,
    'Conversation Agent Package source receipt',
  );
}

export function digestCreatorAgentPackageConversationSourceReceipt(input: unknown): Sha256Digest {
  return rawDigest(
    Buffer.from(serializeCreatorAgentPackageConversationSourceReceipt(input), 'utf8'),
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

export function createCreatorAgentPackageConversationProvenance(
  input: unknown,
): CreatorAgentPackageConversationProvenance {
  return exactDetached(
    CreatorAgentPackageConversationProvenanceSchema,
    input,
    'Conversation Agent Package provenance binding',
  );
}

export function verifyCreatorAgentPackageConversationProvenance(
  input: unknown,
): CreatorAgentPackageConversationProvenance {
  return createCreatorAgentPackageConversationProvenance(input);
}

export function serializeCreatorAgentPackageConversationProvenance(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentPackageConversationProvenance(input));
}

export function parseCreatorAgentPackageConversationProvenance(
  text: string,
): CreatorAgentPackageConversationProvenance {
  return parseExactPackageJson(
    text,
    verifyCreatorAgentPackageConversationProvenance,
    'Conversation Agent Package provenance',
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

export function createCreatorAgentPackageCompilationReceipt(
  input: unknown,
): CreatorAgentPackageCompilationReceipt {
  return exactDetached(
    CreatorAgentPackageCompilationReceiptSchema,
    input,
    'Agent Package compilation receipt',
  );
}

export function verifyCreatorAgentPackageCompilationReceipt(
  input: unknown,
): CreatorAgentPackageCompilationReceipt {
  return createCreatorAgentPackageCompilationReceipt(input);
}

export function serializeCreatorAgentPackageCompilationReceipt(input: unknown): string {
  return canonicalizeJson(verifyCreatorAgentPackageCompilationReceipt(input));
}

export function parseCreatorAgentPackageCompilationReceipt(
  text: string,
): CreatorAgentPackageCompilationReceipt {
  return parseExactPackageJson(
    text,
    verifyCreatorAgentPackageCompilationReceipt,
    'Agent Package compilation receipt',
  );
}

export function digestCreatorAgentPackageCompilationReceipt(input: unknown): Sha256Digest {
  return rawDigest(Buffer.from(serializeCreatorAgentPackageCompilationReceipt(input), 'utf8'));
}

export function verifyCreatorAgentPackageCompilationReceiptBinding(
  rawReceipt: unknown,
  rawDraft: unknown,
  expectedCompilerVersion: string,
  rawManifest: unknown,
  rawProvenance: unknown,
  rawSourceReceipt: unknown,
): CreatorAgentPackageCompilationReceipt {
  const receipt = verifyCreatorAgentPackageCompilationReceipt(rawReceipt);
  const draft = verifyCreatorAgentPackageDraftSnapshotV2(rawDraft);
  const manifest = verifyCreatorAgentPackageManifest(rawManifest);
  const provenance = verifyCreatorAgentPackageConversationProvenance(rawProvenance);
  const sourceReceipt = verifyCreatorAgentPackageConversationSourceReceipt(rawSourceReceipt);
  if (
    receipt.draftProtocol !== draft.protocol ||
    receipt.draftId !== draft.draftId ||
    receipt.draftRevision !== draft.revision ||
    receipt.draftFingerprint !== draft.draftFingerprint
  ) {
    throw new TypeError('Compilation receipt does not bind the exact Draft revision.');
  }
  if (receipt.compilerVersion !== CompilerVersionSchema.parse(expectedCompilerVersion)) {
    throw new TypeError('Compilation receipt does not bind the expected compiler version.');
  }

  const expectedSourceReceipt = createCreatorAgentPackageConversationSourceReceipt({
    protocol: CREATOR_AGENT_PACKAGE_CONVERSATION_SOURCE_RECEIPT_PROTOCOL,
    sourceKind: 'current_conversation',
    sourceBoundary: draft.source.sourceBoundary,
    snapshotBoundary: draft.source.snapshotBoundary,
    visibility: draft.source.visibility,
    snapshotCompleteness: draft.source.snapshotCompleteness,
    rawStored: draft.source.rawStored,
    snapshotCommitmentScheme: draft.source.snapshotCommitmentScheme,
    snapshotCommitment: draft.source.snapshotCommitment,
    selectedVisibleItemCount: draft.source.selectedVisibleItemCount,
    coverageSummary: draft.source.coverageSummary,
  });
  if (
    serializeCreatorAgentPackageConversationSourceReceipt(sourceReceipt) !==
      serializeCreatorAgentPackageConversationSourceReceipt(expectedSourceReceipt) ||
    receipt.sourceReceiptDigest !==
      digestCreatorAgentPackageConversationSourceReceipt(sourceReceipt)
  ) {
    throw new TypeError('Compilation receipt does not bind the exact conversation source receipt.');
  }

  const creatorRequestDigest = digestCreatorAgentPackageCreatorRequestV2(draft.creatorRequest);
  if (receipt.creatorRequestDigest !== creatorRequestDigest) {
    throw new TypeError('Compilation receipt does not bind the exact creator request.');
  }
  if (
    provenance.sourceReceiptDigest !== receipt.sourceReceiptDigest ||
    provenance.creatorRequestDigest !== creatorRequestDigest
  ) {
    throw new TypeError('Compilation receipt does not bind the Package provenance.');
  }

  const provenanceText = serializeCreatorAgentPackageConversationProvenance(provenance);
  const provenanceBytes = Buffer.from(provenanceText, 'utf8');
  const provenanceFileDigest = digestCreatorAgentPackageFile(provenanceBytes);
  const manifestProvenance = manifest.files.find(({ path }) => path === receipt.provenancePath);
  if (
    receipt.provenanceFileDigest !== provenanceFileDigest ||
    manifestProvenance === undefined ||
    manifestProvenance.digest !== provenanceFileDigest ||
    manifestProvenance.byteLength !== provenanceBytes.byteLength
  ) {
    throw new TypeError('Compilation receipt provenance is not bound into the Package manifest.');
  }
  if (
    receipt.packageProtocol !== manifest.protocol ||
    receipt.packageDigest !== digestCreatorAgentPackage(manifest)
  ) {
    throw new TypeError('Compilation receipt does not bind the exact Package output.');
  }
  return receipt;
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
  const budget = { nodes: 0, bytes: 0 };
  const snapshot = snapshotJson(input, 0, budget);
  const before = canonicalizeJson(snapshot);
  if (Buffer.byteLength(before, 'utf8') > CREATOR_AGENT_PACKAGE_MAX_MANIFEST_BYTES) {
    throw new TypeError('Agent Package value exceeds the canonical byte limit');
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
    throw new TypeError('Agent Package value exceeds the canonical complexity limit');
  }
  if (input === null || typeof input === 'boolean') return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new TypeError('Agent Package value is not canonical JSON');
    return input;
  }
  if (typeof input === 'string') {
    budget.bytes += Buffer.byteLength(input, 'utf8');
    if (budget.bytes > CREATOR_AGENT_PACKAGE_MAX_MANIFEST_BYTES || containsLoneSurrogate(input)) {
      throw new TypeError('Agent Package value exceeds the canonical byte limit');
    }
    return input;
  }
  if (typeof input !== 'object' || isProxy(input)) {
    throw new TypeError('Agent Package value must contain only plain JSON values');
  }
  if (Array.isArray(input)) {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Array.prototype && prototype !== null) {
      throw new TypeError('Agent Package value must contain only plain JSON arrays');
    }
    if (input.length > 2_048 - budget.nodes) {
      throw new TypeError('Agent Package value exceeds the canonical complexity limit');
    }
    let enumerablePropertyCount = 0;
    for (const key in input) {
      if (!Object.hasOwn(input, key)) continue;
      enumerablePropertyCount += 1;
      if (enumerablePropertyCount > 2_048 - budget.nodes) {
        throw new TypeError('Agent Package value exceeds the canonical complexity limit');
      }
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors).filter((key) => key !== 'length');
    if (
      keys.length !== input.length ||
      keys.some((key, index) => typeof key !== 'string' || key !== String(index))
    ) {
      throw new TypeError('Agent Package value must contain only dense arrays');
    }
    return keys.map((key) => {
      const descriptor = descriptors[key as string];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('Agent Package properties must be enumerable data properties');
      }
      return snapshotJson(descriptor.value, depth + 1, budget);
    });
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Agent Package value must contain only plain JSON objects');
  }
  let enumerablePropertyCount = 0;
  for (const key in input) {
    if (!Object.hasOwn(input, key)) continue;
    enumerablePropertyCount += 1;
    if (enumerablePropertyCount > 2_048 - budget.nodes) {
      throw new TypeError('Agent Package value exceeds the canonical complexity limit');
    }
  }
  const output: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (
      typeof key !== 'string' ||
      key === '__proto__' ||
      key === 'prototype' ||
      key === 'constructor'
    ) {
      throw new TypeError('Agent Package value contains an unsafe property');
    }
    budget.bytes += Buffer.byteLength(key, 'utf8');
    if (budget.bytes > CREATOR_AGENT_PACKAGE_MAX_MANIFEST_BYTES) {
      throw new TypeError('Agent Package value exceeds the canonical byte limit');
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Agent Package properties must be enumerable data properties');
    }
    output[key] = snapshotJson(descriptor.value, depth + 1, budget);
  }
  return output;
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if (!Object.isFrozen(value)) Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}

function rawDigest(bytes: Uint8Array): Sha256Digest {
  return Sha256DigestSchema.parse(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
}
