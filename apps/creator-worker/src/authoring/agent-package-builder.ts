import {
  CREATOR_AGENT_PACKAGE_COMPILATION_RECEIPT_PROTOCOL,
  CREATOR_AGENT_PACKAGE_CONVERSATION_PROVENANCE_PROTOCOL,
  CREATOR_AGENT_PACKAGE_CONVERSATION_SOURCE_RECEIPT_PROTOCOL,
  CREATOR_AGENT_PACKAGE_PROVENANCE_PROTOCOL,
  CREATOR_AGENT_PACKAGE_PROTOCOL,
  CREATOR_AGENT_PACKAGE_SOURCE_RECEIPT_PROTOCOL,
  createCreatorAgentPackageCompilationReceipt,
  createCreatorAgentPackageConversationProvenance,
  createCreatorAgentPackageConversationSourceReceipt,
  createCreatorAgentPackageProvenance,
  createCreatorAgentPackageManifest,
  digestCreatorAgentPackageConversationSourceReceipt,
  digestCreatorAgentPackage,
  digestCreatorAgentPackageFile,
  digestCreatorAgentPackageSourceReceipt,
  createCreatorAgentPackageSourceReceipt,
  serializeCreatorAgentPackageCompilationReceipt,
  serializeCreatorAgentPackageConversationProvenance,
  serializeCreatorAgentPackageManifest,
  serializeCreatorAgentPackageProvenance,
  type CreatorAgentPackageCompilationReceipt,
  type CreatorAgentPackageConversationSourceReceipt,
  type CreatorAgentPackageDigest,
  type CreatorAgentPackageManifest,
  type CreatorAgentPackageSourceReceipt as ProtocolCreatorAgentPackageSourceReceipt,
} from '@cb/creator-agent-protocol/agent-package';
import {
  CREATOR_AGENT_PACKAGE_DRAFT_MAX_BYTES,
  CREATOR_AGENT_PACKAGE_DRAFT_V2_PROTOCOL,
  CreatorAgentPackageDraftV2FingerprintMismatchError,
  CreatorAgentPackageDraftContentSchema,
  containsNonPortableAgentReference,
  digestCreatorAgentPackageCreatorRequest,
  digestCreatorAgentPackageCreatorRequestV2,
  verifyCreatorAgentPackageDraftSnapshot,
  parseCreatorAgentPackageDraftSnapshotV2,
  type CreatorAgentPackageDraftContent,
  type CreatorAgentPackageDraftSnapshot,
  type CreatorAgentPackageDraftSnapshotV2,
} from '@cb/creator-agent-protocol/agent-package-draft';

import { containsCredentialMaterial, containsUnsafeAgentText } from './agent-text-safety.js';
import type { CreatorAgentProjectBehaviorExtraction } from './project-behavior-extractor.js';

const SKILL_NAME = 'extracted-method';
const SKILL_PATH = `skills/${SKILL_NAME}/SKILL.md` as const;
const PROVENANCE_PATH = `skills/${SKILL_NAME}/provenance.json` as const;
export const CREATOR_AGENT_PACKAGE_DRAFT_V2_COMPILER_VERSION =
  'combo.creator-worker.agent-package-draft-v2-compiler/1' as const;

export type CreatorAgentPackageSourceReceipt = ProtocolCreatorAgentPackageSourceReceipt;

export type BuiltCreatorAgentPackage = Readonly<{
  manifest: CreatorAgentPackageManifest;
  manifestText: string;
  packageDigest: CreatorAgentPackageDigest;
  files: readonly Readonly<{ path: string; text: string }>[];
  starterPrompts: readonly string[];
  sourceReceipt: CreatorAgentPackageSourceReceipt;
}>;

export type CompiledCreatorAgentPackageDraftV2 = Readonly<{
  manifest: CreatorAgentPackageManifest;
  manifestText: string;
  packageDigest: CreatorAgentPackageDigest;
  files: readonly Readonly<{ path: string; text: string }>[];
  starterPrompts: readonly string[];
  sourceReceipt: CreatorAgentPackageConversationSourceReceipt;
  compilationReceipt: CreatorAgentPackageCompilationReceipt;
  compilationReceiptText: string;
}>;

export function buildCreatorAgentPackage(
  extraction: CreatorAgentProjectBehaviorExtraction,
): BuiltCreatorAgentPackage {
  return buildCurrentProjectPackageContent(
    extraction.behavior,
    createCreatorAgentPackageSourceReceipt({
      protocol: CREATOR_AGENT_PACKAGE_SOURCE_RECEIPT_PROTOCOL,
      sourceKind: 'current_project',
      contextRootDigest: extraction.contextRootDigest,
      indexedEntryCount: extraction.indexedEntryCount,
      indexedFileCount: extraction.indexedFileCount,
      uniqueIndexedByteCount: extraction.uniqueIndexedByteCount,
      coverageSummary: extraction.behavior.coverageSummary.normalize('NFC').trim(),
      citedSources: extraction.citedSources
        .map(({ path, digest }) => ({ path, digest }))
        .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    }),
    null,
    extraction.sourceProjectPath,
  );
}

export function buildCreatorAgentPackageFromDraft(
  rawDraft: CreatorAgentPackageDraftSnapshot,
): BuiltCreatorAgentPackage {
  const draft = verifyCreatorAgentPackageDraftSnapshot(rawDraft);
  return buildCurrentProjectPackageContent(
    draft.content,
    createCreatorAgentPackageSourceReceipt({
      protocol: CREATOR_AGENT_PACKAGE_SOURCE_RECEIPT_PROTOCOL,
      sourceKind: 'current_project',
      contextRootDigest: draft.source.contextRootDigest as `sha256:${string}`,
      indexedEntryCount: draft.source.indexedEntryCount,
      indexedFileCount: draft.source.indexedFileCount,
      uniqueIndexedByteCount: draft.source.uniqueIndexedByteCount,
      coverageSummary: draft.source.coverageSummary,
      citedSources: draft.source.citedSources.map(({ path, digest }) => ({ path, digest })),
    }),
    digestCreatorAgentPackageCreatorRequest(draft.creatorRequest),
  );
}

export type CreatorAgentPackageDraftV2CompilerErrorCode =
  | 'AGENT_PACKAGE_V2_COMPILE_DRAFT_INCOMPLETE'
  | 'AGENT_PACKAGE_V2_COMPILE_UNSUPPORTED_DRAFT_VERSION'
  | 'AGENT_PACKAGE_V2_COMPILE_DRAFT_DRIFTED'
  | 'AGENT_PACKAGE_V2_COMPILE_DRAFT_UNSAFE'
  | 'AGENT_PACKAGE_V2_COMPILE_OUTPUT_INVALID';

export class CreatorAgentPackageDraftV2CompilerError extends Error {
  public constructor(
    public readonly code: CreatorAgentPackageDraftV2CompilerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CreatorAgentPackageDraftV2CompilerError';
  }
}

export function compileCreatorAgentPackageDraftV2(
  rawDraftText: unknown,
): CompiledCreatorAgentPackageDraftV2 {
  if (
    typeof rawDraftText !== 'string' ||
    rawDraftText.length > CREATOR_AGENT_PACKAGE_DRAFT_MAX_BYTES ||
    Buffer.byteLength(rawDraftText, 'utf8') > CREATOR_AGENT_PACKAGE_DRAFT_MAX_BYTES
  ) {
    throw compilerError(
      'AGENT_PACKAGE_V2_COMPILE_DRAFT_INCOMPLETE',
      'Current-conversation Agent Package Draft input is incomplete or invalid.',
    );
  }
  let protocol: unknown;
  try {
    protocol = readDraftProtocolFromBoundedJson(rawDraftText);
  } catch {
    throw compilerError(
      'AGENT_PACKAGE_V2_COMPILE_DRAFT_INCOMPLETE',
      'Current-conversation Agent Package Draft input is incomplete or invalid.',
    );
  }
  if (protocol === undefined) {
    throw compilerError(
      'AGENT_PACKAGE_V2_COMPILE_DRAFT_INCOMPLETE',
      'Current-conversation Agent Package Draft input is incomplete or invalid.',
    );
  }
  if (protocol !== CREATOR_AGENT_PACKAGE_DRAFT_V2_PROTOCOL) {
    throw compilerError(
      'AGENT_PACKAGE_V2_COMPILE_UNSUPPORTED_DRAFT_VERSION',
      'Only current-conversation Agent Package Draft V2 can be compiled by this compiler.',
    );
  }
  let draft: CreatorAgentPackageDraftSnapshotV2;
  try {
    draft = parseCreatorAgentPackageDraftSnapshotV2(rawDraftText);
  } catch (error) {
    if (error instanceof CreatorAgentPackageDraftV2FingerprintMismatchError) {
      throw compilerError(
        'AGENT_PACKAGE_V2_COMPILE_DRAFT_DRIFTED',
        'Current-conversation Agent Package Draft fingerprint does not match its exact revision.',
      );
    }
    throw compilerError(
      'AGENT_PACKAGE_V2_COMPILE_DRAFT_INCOMPLETE',
      'Current-conversation Agent Package Draft input is incomplete or invalid.',
    );
  }
  if (containsUnsafeDraftContent(draft)) {
    throw compilerError(
      'AGENT_PACKAGE_V2_COMPILE_DRAFT_UNSAFE',
      'Current-conversation Agent Package Draft content is unsafe or non-portable.',
    );
  }

  try {
    const sourceReceipt = createCreatorAgentPackageConversationSourceReceipt({
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
    const sourceReceiptDigest = digestCreatorAgentPackageConversationSourceReceipt(sourceReceipt);
    const creatorRequestDigest = digestCreatorAgentPackageCreatorRequestV2(draft.creatorRequest);
    const provenanceText = serializeCreatorAgentPackageConversationProvenance(
      createCreatorAgentPackageConversationProvenance({
        protocol: CREATOR_AGENT_PACKAGE_CONVERSATION_PROVENANCE_PROTOCOL,
        sourceKind: 'current_conversation',
        sourceReceiptDigest,
        creatorRequestDigest,
      }),
    );
    const build = buildPackageContent(
      draft.content,
      sourceReceipt,
      provenanceText,
      'current_conversation',
    );
    const provenanceFile = build.files.find(({ path }) => path === PROVENANCE_PATH);
    if (provenanceFile === undefined) throw new TypeError('Package provenance file is missing.');
    const compilationReceipt = createCreatorAgentPackageCompilationReceipt({
      protocol: CREATOR_AGENT_PACKAGE_COMPILATION_RECEIPT_PROTOCOL,
      draftProtocol: draft.protocol,
      draftId: draft.draftId,
      draftRevision: draft.revision,
      draftFingerprint: draft.draftFingerprint,
      compilerVersion: CREATOR_AGENT_PACKAGE_DRAFT_V2_COMPILER_VERSION,
      sourceReceiptDigest,
      creatorRequestDigest,
      provenancePath: provenanceFile.path,
      provenanceFileDigest: digestCreatorAgentPackageFile(Buffer.from(provenanceFile.text, 'utf8')),
      packageProtocol: build.manifest.protocol,
      packageDigest: build.packageDigest,
    });
    return Object.freeze({
      ...build,
      compilationReceipt,
      compilationReceiptText: serializeCreatorAgentPackageCompilationReceipt(compilationReceipt),
    });
  } catch (error) {
    if (error instanceof CreatorAgentPackageDraftV2CompilerError) throw error;
    throw compilerError(
      'AGENT_PACKAGE_V2_COMPILE_OUTPUT_INVALID',
      'The exact current-conversation Draft could not form a valid Agent Package candidate.',
    );
  }
}

function buildCurrentProjectPackageContent(
  behavior: CreatorAgentPackageDraftContent,
  sourceReceipt: CreatorAgentPackageSourceReceipt,
  creatorRequestDigest: ReturnType<typeof digestCreatorAgentPackageCreatorRequest> | null,
  sourceProjectPath?: string,
): BuiltCreatorAgentPackage {
  const provenanceText = serializeCreatorAgentPackageProvenance(
    createCreatorAgentPackageProvenance({
      protocol: CREATOR_AGENT_PACKAGE_PROVENANCE_PROTOCOL,
      sourceKind: 'current_project',
      sourceReceiptDigest: digestCreatorAgentPackageSourceReceipt(sourceReceipt),
      creatorRequestDigest,
    }),
  );
  return buildPackageContent(
    behavior,
    sourceReceipt,
    provenanceText,
    'current_project',
    sourceProjectPath,
  );
}

function buildPackageContent<SourceReceipt extends object>(
  behavior: CreatorAgentPackageDraftContent,
  sourceReceipt: SourceReceipt,
  provenanceText: string,
  sourceKind: 'current_project' | 'current_conversation',
  sourceProjectPath?: string,
): Readonly<{
  manifest: CreatorAgentPackageManifest;
  manifestText: string;
  packageDigest: CreatorAgentPackageDigest;
  files: readonly Readonly<{ path: string; text: string }>[];
  starterPrompts: readonly string[];
  sourceReceipt: SourceReceipt;
}> {
  const content = normalizeCreatorAgentPackageDraftContentForSource(behavior, sourceKind);
  const {
    name: packageName,
    description: packageDescription,
    instructions,
    outputDescription,
    starterPrompts,
  } = content;
  const agentMarkdown = renderAgentMarkdown(packageName, packageDescription, sourceKind);
  const skillMarkdown = renderSkillMarkdown(
    instructions,
    outputDescription,
    starterPrompts,
    sourceKind,
  );
  assertPortablePackageText(agentMarkdown, sourceProjectPath);
  assertPortablePackageText(skillMarkdown, sourceProjectPath);
  assertPortablePackageText(provenanceText, sourceProjectPath);
  if (
    sourceKind === 'current_conversation' &&
    [agentMarkdown, skillMarkdown, provenanceText].some(containsCredentialMaterial)
  ) {
    throw new TypeError('Conversation Agent Package output contains credential material.');
  }
  const files = Object.freeze([
    Object.freeze({ path: 'AGENT.md', text: agentMarkdown }),
    Object.freeze({ path: SKILL_PATH, text: skillMarkdown }),
    Object.freeze({ path: PROVENANCE_PATH, text: provenanceText }),
  ]);
  const manifest = createCreatorAgentPackageManifest({
    protocol: CREATOR_AGENT_PACKAGE_PROTOCOL,
    name: packageName,
    description: packageDescription,
    instructions: 'AGENT.md',
    skills: [SKILL_PATH],
    files: files.map(({ path, text }) => {
      const bytes = Buffer.from(text, 'utf8');
      return {
        path,
        byteLength: bytes.byteLength,
        digest: digestCreatorAgentPackageFile(bytes),
      };
    }),
  });
  const manifestText = serializeCreatorAgentPackageManifest(manifest);
  const packageDigest = digestCreatorAgentPackage(manifest);
  return Object.freeze({
    manifest,
    manifestText,
    packageDigest,
    files,
    starterPrompts,
    sourceReceipt,
  });
}

export function normalizeCreatorAgentPackageDraftContent(
  behavior: CreatorAgentPackageDraftContent,
): CreatorAgentPackageDraftContent {
  return normalizeCreatorAgentPackageDraftContentForSource(behavior, 'current_project');
}

function normalizeCreatorAgentPackageDraftContentForSource(
  behavior: CreatorAgentPackageDraftContent,
  sourceKind: 'current_project' | 'current_conversation',
): CreatorAgentPackageDraftContent {
  assertPortableBehavior(behavior, sourceKind);
  const normalized = {
    name: packageNameFrom(normalizePackageText(behavior.name, 80)),
    description: packageDescriptionFrom(normalizePackageText(behavior.description, 500)),
    instructions: normalizePackageText(behavior.instructions, 8_000),
    starterPrompts: behavior.starterPrompts.map((prompt) =>
      singleLine(normalizePackageText(prompt, 1_000)),
    ),
    outputDescription: normalizePackageText(behavior.outputDescription, 1_000),
  };
  if (normalized.starterPrompts.some((prompt) => !prompt)) {
    throw new TypeError(
      'Agent Package starter prompts must remain meaningful after normalization.',
    );
  }
  if (new Set(normalized.starterPrompts).size !== normalized.starterPrompts.length) {
    throw new TypeError('Agent Package starter prompts must remain unique after normalization.');
  }
  return CreatorAgentPackageDraftContentSchema.parse(normalized);
}

function renderAgentMarkdown(
  name: string,
  description: string,
  sourceKind: 'current_project' | 'current_conversation',
): string {
  if (sourceKind === 'current_conversation') {
    return [
      '# Identity',
      `You are ${name}.`,
      description,
      '',
      '# Outcomes',
      'Complete the user task by applying the installed `extracted-method` Skill to evidence in the current consumer Project.',
      '',
      '# Operating Loop',
      'Understand the request, inspect the current consumer Project, apply the extracted method, verify the result, and then answer.',
      '',
      '# Capability Routing',
      'Use the installed `extracted-method` Skill for every task in this Agent Package.',
      '',
      '# Context and State',
      'The current consumer Project and runtime conversation are context. The creator conversation is not mounted and must not be treated as runtime evidence.',
      '',
      '# Invariants',
      'Remain read-only. Do not invent evidence, claim access to the creator conversation, or weaken Host and Project constraints.',
      '',
      '# Verification and Definition of Done',
      'Follow the Skill output contract and verify every material claim against current evidence before finishing.',
      '',
      '# Interaction and Output',
      'Ask only for information that is necessary to complete the current task. Return the requested result without unrelated commentary.',
      '',
      '# Escalation and Stop',
      'If required evidence is absent or contradictory, state the exact blocker and stop instead of guessing.',
      '',
    ].join('\n');
  }
  return [
    '# Identity',
    `You are ${name}.`,
    description,
    '',
    '# Outcomes',
    'Complete the user task by applying the installed `extracted-method` Skill to evidence in the current consumer Project.',
    '',
    '# Operating Loop',
    'Understand the request, inspect the current Project, apply the extracted method, verify the result, and then answer.',
    '',
    '# Capability Routing',
    'Use the installed `extracted-method` Skill for every task in this Agent Package.',
    '',
    '# Context and State',
    'The current consumer Project and this conversation are runtime context. The authoring Project is not mounted and must not be treated as runtime evidence.',
    '',
    '# Invariants',
    'Remain read-only. Do not invent evidence, claim access to the authoring Project, or weaken Host and Project constraints.',
    '',
    '# Verification and Definition of Done',
    'Follow the Skill output contract and verify every material claim against current evidence before finishing.',
    '',
    '# Interaction and Output',
    'Ask only for information that is necessary to complete the current task. Return the requested result without unrelated commentary.',
    '',
    '# Escalation and Stop',
    'If required evidence is absent or contradictory, state the exact blocker and stop instead of guessing.',
    '',
  ].join('\n');
}

function renderSkillMarkdown(
  instructions: string,
  outputDescription: string,
  starterPrompts: readonly string[],
  sourceKind: 'current_project' | 'current_conversation',
): string {
  if (sourceKind === 'current_conversation') {
    return [
      '---',
      `name: ${SKILL_NAME}`,
      'description: Apply the reusable method extracted from the creator conversation.',
      '---',
      '',
      '# Extracted method',
      instructions,
      '',
      '# Output contract',
      outputDescription,
      '',
      '# Starter tasks',
      ...starterPrompts.map((prompt) => `- ${prompt}`),
      '',
      '# Runtime evidence boundary',
      'Apply this method only to the current consumer Project and runtime conversation. Creator-conversation statements are not runtime evidence unless the consumer provides them again.',
      '',
    ].join('\n');
  }
  return [
    '---',
    `name: ${SKILL_NAME}`,
    'description: Apply the reusable method extracted from the creator source Project.',
    '---',
    '',
    '# Extracted method',
    instructions,
    '',
    '# Output contract',
    outputDescription,
    '',
    '# Starter tasks',
    ...starterPrompts.map((prompt) => `- ${prompt}`),
    '',
    '# Runtime evidence boundary',
    'Apply this method only to the current consumer Project and conversation. Source Project paths and source-only conclusions are not runtime evidence.',
    '',
  ].join('\n');
}

function packageNameFrom(value: string): string {
  const normalized = value
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} ._'-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const candidate = [...normalized].slice(0, 80).join('').trim();
  return candidate && /^[\p{L}\p{N}]/u.test(candidate) ? candidate : 'Extracted Agent';
}

function packageDescriptionFrom(value: string): string {
  const normalized = [...singleLine(value)].slice(0, 500).join('').trim();
  return normalized || 'A reusable Agent Package extracted from a creator source Project.';
}

function singleLine(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizePackageText(value: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum || containsUnsafeAgentText(value)) {
    throw new TypeError('Agent Package text is unsafe or exceeds its bound.');
  }
  const normalized = value.normalize('NFC').trim();
  if (!normalized || normalized.length > maximum || !/[\p{L}\p{N}\p{P}\p{S}]/u.test(normalized)) {
    throw new TypeError('Agent Package text must contain meaningful content.');
  }
  return normalized;
}

function assertPortableBehavior(
  behavior: CreatorAgentPackageDraftContent,
  sourceKind: 'current_project' | 'current_conversation',
): void {
  const text = [
    behavior.name,
    behavior.description,
    behavior.instructions,
    ...behavior.starterPrompts,
    behavior.outputDescription,
  ].join('\n');
  if (
    containsNonPortableAgentReference(text) ||
    /https?:\/\/|\b(?:task|session|thread)[-_ ]?id\s*[:=]/iu.test(text) ||
    (sourceKind === 'current_project' && /\b(?:curl|wget|scp|ssh|netcat|nc)\b/iu.test(text))
  ) {
    throw new TypeError('Agent Package Draft contains non-portable behavior.');
  }
}

function assertPortablePackageText(text: string, sourceProjectPath?: string): void {
  if (
    !text ||
    text.includes('\0') ||
    text.charCodeAt(0) === 0xfeff ||
    (sourceProjectPath !== undefined && text.includes(sourceProjectPath)) ||
    Buffer.byteLength(text, 'utf8') > 65_536
  ) {
    throw new TypeError('Agent Package authoring output is not portable or bounded.');
  }
}

function readDraftProtocolFromBoundedJson(input: string): unknown {
  const decoded = JSON.parse(input) as unknown;
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(decoded, 'protocol');
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    return undefined;
  }
  return descriptor.value;
}

function containsUnsafeDraftContent(draft: CreatorAgentPackageDraftSnapshotV2): boolean {
  const { content } = draft;
  const values = [
    content.name,
    content.description,
    content.instructions,
    ...content.starterPrompts,
    content.outputDescription,
  ];
  const text = values.join('\n');
  return (
    values.some(containsUnsafeAgentText) ||
    values.some(containsCredentialMaterial) ||
    containsNonPortableAgentReference(text) ||
    /https?:\/\/|\b(?:task|session|thread)[-_ ]?id\s*[:=]/iu.test(text)
  );
}

function compilerError(
  code: CreatorAgentPackageDraftV2CompilerErrorCode,
  message: string,
): CreatorAgentPackageDraftV2CompilerError {
  return new CreatorAgentPackageDraftV2CompilerError(code, message);
}
