import {
  CREATOR_AGENT_PACKAGE_PROVENANCE_PROTOCOL,
  CREATOR_AGENT_PACKAGE_PROTOCOL,
  CREATOR_AGENT_PACKAGE_SOURCE_RECEIPT_PROTOCOL,
  createCreatorAgentPackageProvenance,
  createCreatorAgentPackageManifest,
  digestCreatorAgentPackage,
  digestCreatorAgentPackageFile,
  digestCreatorAgentPackageSourceReceipt,
  createCreatorAgentPackageSourceReceipt,
  serializeCreatorAgentPackageManifest,
  serializeCreatorAgentPackageProvenance,
  type CreatorAgentPackageDigest,
  type CreatorAgentPackageManifest,
  type CreatorAgentPackageSourceReceipt as ProtocolCreatorAgentPackageSourceReceipt,
} from '@cb/creator-agent-protocol/agent-package';
import {
  CreatorAgentPackageDraftContentSchema,
  containsNonPortableAgentReference,
  digestCreatorAgentPackageCreatorRequest,
  verifyCreatorAgentPackageDraftSnapshot,
  type CreatorAgentPackageDraftContent,
  type CreatorAgentPackageDraftSnapshot,
} from '@cb/creator-agent-protocol/agent-package-draft';

import { containsUnsafeAgentText } from './agent-text-safety.js';
import type { CreatorAgentProjectBehaviorExtraction } from './project-behavior-extractor.js';

const SKILL_NAME = 'extracted-method';
const SKILL_PATH = `skills/${SKILL_NAME}/SKILL.md` as const;
const PROVENANCE_PATH = `skills/${SKILL_NAME}/provenance.json` as const;

export type CreatorAgentPackageSourceReceipt = ProtocolCreatorAgentPackageSourceReceipt;

export type BuiltCreatorAgentPackage = Readonly<{
  manifest: CreatorAgentPackageManifest;
  manifestText: string;
  packageDigest: CreatorAgentPackageDigest;
  files: readonly Readonly<{ path: string; text: string }>[];
  starterPrompts: readonly string[];
  sourceReceipt: CreatorAgentPackageSourceReceipt;
}>;

export function buildCreatorAgentPackage(
  extraction: CreatorAgentProjectBehaviorExtraction,
): BuiltCreatorAgentPackage {
  return buildPackageContent(
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
  return buildPackageContent(
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

function buildPackageContent(
  behavior: CreatorAgentPackageDraftContent,
  sourceReceipt: CreatorAgentPackageSourceReceipt,
  creatorRequestDigest: ReturnType<typeof digestCreatorAgentPackageCreatorRequest> | null,
  sourceProjectPath?: string,
): BuiltCreatorAgentPackage {
  const content = normalizeCreatorAgentPackageDraftContent(behavior);
  const {
    name: packageName,
    description: packageDescription,
    instructions,
    outputDescription,
    starterPrompts,
  } = content;
  const agentMarkdown = renderAgentMarkdown(packageName, packageDescription);
  const skillMarkdown = renderSkillMarkdown(instructions, outputDescription, starterPrompts);
  const provenanceText = serializeCreatorAgentPackageProvenance(
    createCreatorAgentPackageProvenance({
      protocol: CREATOR_AGENT_PACKAGE_PROVENANCE_PROTOCOL,
      sourceKind: 'current_project',
      sourceReceiptDigest: digestCreatorAgentPackageSourceReceipt(sourceReceipt),
      creatorRequestDigest,
    }),
  );
  assertPortablePackageText(agentMarkdown, sourceProjectPath);
  assertPortablePackageText(skillMarkdown, sourceProjectPath);
  assertPortablePackageText(provenanceText, sourceProjectPath);
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
  assertPortableBehavior(behavior);
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

function renderAgentMarkdown(name: string, description: string): string {
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
): string {
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

function assertPortableBehavior(behavior: CreatorAgentPackageDraftContent): void {
  const text = [
    behavior.name,
    behavior.description,
    behavior.instructions,
    ...behavior.starterPrompts,
    behavior.outputDescription,
  ].join('\n');
  if (
    containsNonPortableAgentReference(text) ||
    /https?:\/\/|\b(?:curl|wget|scp|ssh|netcat|nc)\b|\b(?:task|session|thread)[-_ ]?id\s*[:=]/iu.test(
      text,
    )
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
