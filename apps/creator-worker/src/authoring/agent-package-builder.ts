import {
  CREATOR_AGENT_PACKAGE_PROTOCOL,
  createCreatorAgentPackageManifest,
  digestCreatorAgentPackage,
  digestCreatorAgentPackageFile,
  serializeCreatorAgentPackageManifest,
  type CreatorAgentPackageDigest,
  type CreatorAgentPackageManifest,
} from '@cb/creator-agent-protocol/agent-package';

import type { CreatorAgentProjectBehaviorExtraction } from './project-context-compiler.js';

const SKILL_NAME = 'extracted-method';
const SKILL_PATH = `skills/${SKILL_NAME}/SKILL.md` as const;

export type CreatorAgentPackageSourceReceipt = Readonly<{
  contextRootDigest: `sha256:${string}`;
  indexedEntryCount: number;
  indexedFileCount: number;
  uniqueIndexedByteCount: number;
  citedSources: readonly Readonly<{
    path: string;
    digest: `sha256:${string}`;
  }>[];
}>;

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
  const behavior = extraction.behavior;
  const packageName = packageNameFrom(normalizePackageText(behavior.name, 80));
  const packageDescription = packageDescriptionFrom(
    normalizePackageText(behavior.description, 500),
  );
  const instructions = normalizePackageText(behavior.instructions, 8_000);
  const outputDescription = normalizePackageText(behavior.outputDescription, 1_000);
  const starterPrompts = Object.freeze(
    behavior.starterPrompts.map((prompt) => singleLine(normalizePackageText(prompt, 1_000))),
  );
  if (starterPrompts.some((prompt) => !prompt)) {
    throw new TypeError(
      'Agent Package starter prompts must remain meaningful after normalization.',
    );
  }
  if (new Set(starterPrompts).size !== starterPrompts.length) {
    throw new TypeError('Agent Package starter prompts must remain unique after normalization.');
  }
  const agentMarkdown = renderAgentMarkdown(packageName, packageDescription);
  const skillMarkdown = renderSkillMarkdown(instructions, outputDescription, starterPrompts);
  assertPortablePackageText(agentMarkdown, extraction.sourceProjectPath);
  assertPortablePackageText(skillMarkdown, extraction.sourceProjectPath);
  const files = Object.freeze([
    Object.freeze({ path: 'AGENT.md', text: agentMarkdown }),
    Object.freeze({ path: SKILL_PATH, text: skillMarkdown }),
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
  const sourceReceipt = Object.freeze({
    contextRootDigest: extraction.contextRootDigest,
    indexedEntryCount: extraction.indexedEntryCount,
    indexedFileCount: extraction.indexedFileCount,
    uniqueIndexedByteCount: extraction.uniqueIndexedByteCount,
    citedSources: Object.freeze(
      extraction.citedSources.map(({ path, digest }) => Object.freeze({ path, digest })),
    ),
  });
  return Object.freeze({
    manifest,
    manifestText,
    packageDigest,
    files,
    starterPrompts,
    sourceReceipt,
  });
}

function renderAgentMarkdown(name: string, description: string): string {
  return [
    '# Identity',
    `You are ${name}.`,
    description.trim(),
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
    instructions.trim(),
    '',
    '# Output contract',
    outputDescription.trim(),
    '',
    '# Starter tasks',
    ...starterPrompts.map((prompt) => `- ${singleLine(prompt)}`),
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
  if (typeof value !== 'string' || value.length > maximum || hasUnsafePackageText(value)) {
    throw new TypeError('Agent Package text is unsafe or exceeds its bound.');
  }
  const normalized = value.normalize('NFC').trim();
  if (!normalized || normalized.length > maximum || !/[\p{L}\p{N}\p{P}\p{S}]/u.test(normalized)) {
    throw new TypeError('Agent Package text must contain meaningful content.');
  }
  return normalized;
}

function hasUnsafePackageText(value: string): boolean {
  if (/\p{Cf}/u.test(value)) {
    return true;
  }
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (
      unit <= 0x08 ||
      (unit >= 0x0b && unit <= 0x1f) ||
      (unit >= 0x7f && unit <= 0x9f) ||
      unit === 0x2028 ||
      unit === 0x2029
    ) {
      return true;
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertPortablePackageText(text: string, sourceProjectPath: string): void {
  if (
    !text ||
    text.includes('\0') ||
    text.charCodeAt(0) === 0xfeff ||
    text.includes(sourceProjectPath) ||
    Buffer.byteLength(text, 'utf8') > 65_536
  ) {
    throw new TypeError('Agent Package authoring output is not portable or bounded.');
  }
}
