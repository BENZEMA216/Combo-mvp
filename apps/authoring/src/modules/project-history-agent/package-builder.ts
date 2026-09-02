import {
  CREATOR_AGENT_PACKAGE_HISTORY_PROVENANCE_PROTOCOL,
  CREATOR_AGENT_PACKAGE_HISTORY_SOURCE_RECEIPT_PROTOCOL,
  CREATOR_AGENT_PACKAGE_PROTOCOL,
  CREATOR_AGENT_PACKAGE_STARTER_PROMPTS_PATH,
  CREATOR_AGENT_PACKAGE_STARTER_PROMPTS_PROTOCOL,
  createCreatorAgentPackageHistoryProvenance,
  createCreatorAgentPackageHistorySourceReceipt,
  createCreatorAgentPackageManifest,
  createCreatorAgentPackageStarterPrompts,
  digestCreatorAgentPackage,
  digestCreatorAgentPackageFile,
  digestCreatorAgentPackageHistorySourceReceipt,
  serializeCreatorAgentPackageHistoryProvenance,
  serializeCreatorAgentPackageManifest,
  serializeCreatorAgentPackageStarterPrompts,
  type CreatorAgentPackageDigest,
  type CreatorAgentPackageHistorySourceReceipt,
  type CreatorAgentPackageManifest,
} from '@cb/creator-agent-protocol/agent-package';
import {
  CreatorAgentPackageDraftContentSchema,
  containsLikelyProjectHistoryCredential,
  containsNonPortableProjectHistoryReference,
  digestCreatorAgentPackageCreatorRequestV3,
  verifyCreatorAgentPackageDraftSnapshotV3,
  type CreatorAgentPackageDraftContent,
  type CreatorAgentPackageDraftSnapshotV3,
} from '@cb/creator-agent-protocol/agent-package-draft';

const SKILL_NAME = 'extracted-method';
const SKILL_PATH = `skills/${SKILL_NAME}/SKILL.md` as const;
const PROVENANCE_PATH = `skills/${SKILL_NAME}/provenance.json` as const;

export type BuiltProjectHistoryAgentPackage = Readonly<{
  manifest: CreatorAgentPackageManifest;
  manifestText: string;
  packageDigest: CreatorAgentPackageDigest;
  files: readonly Readonly<{ path: string; text: string }>[];
  starterPrompts: readonly string[];
  sourceReceipt: CreatorAgentPackageHistorySourceReceipt;
}>;

export function buildCreatorAgentPackageFromProjectHistoryDraft(
  rawDraft: CreatorAgentPackageDraftSnapshotV3,
): BuiltProjectHistoryAgentPackage {
  const draft = verifyCreatorAgentPackageDraftSnapshotV3(rawDraft);
  const sourceReceipt = createCreatorAgentPackageHistorySourceReceipt({
    protocol: CREATOR_AGENT_PACKAGE_HISTORY_SOURCE_RECEIPT_PROTOCOL,
    sourceKind: draft.source.kind,
    selection: draft.source.selection,
    assurance: draft.source.assurance,
    completeness: draft.source.completeness,
    hostAttestation: draft.source.hostAttestation,
    sourceProjectionEnforced: draft.source.sourceProjectionEnforced,
    rawStored: draft.source.rawStored,
    projectCount: draft.source.projectCount,
    discoveredThreadCount: draft.source.discoveredThreadCount,
    readThreadCount: draft.source.readThreadCount,
    omittedThreadCount: draft.source.omittedThreadCount,
    completedTurnCount: draft.source.completedTurnCount,
    userVisibleMessageCount: draft.source.userVisibleMessageCount,
    omittedItemCount: draft.source.omittedItemCount,
    limitationReasons: draft.source.limitationReasons,
    candidateCommitment: draft.source.candidateCommitment,
  });
  return buildPackageContent(
    draft.content,
    sourceReceipt,
    serializeCreatorAgentPackageHistoryProvenance(
      createCreatorAgentPackageHistoryProvenance({
        protocol: CREATOR_AGENT_PACKAGE_HISTORY_PROVENANCE_PROTOCOL,
        sourceKind: draft.source.kind,
        selection: draft.source.selection,
        sourceReceiptDigest: digestCreatorAgentPackageHistorySourceReceipt(sourceReceipt),
        creatorRequestDigest: digestCreatorAgentPackageCreatorRequestV3(draft.creatorRequest),
        sourceDraftFingerprint: draft.draftFingerprint,
        completeness: 'not_proven',
        hostAttestation: 'not_proven',
        assurance: 'best_effort',
        sourceProjectionEnforced: 'not_proven',
        omittedThreadCount: draft.source.omittedThreadCount,
        rawStored: false,
      }),
    ),
    undefined,
    'provided_verified_runtime_material',
  );
}

function buildPackageContent(
  behavior: CreatorAgentPackageDraftContent,
  sourceReceipt: CreatorAgentPackageHistorySourceReceipt,
  provenanceText: string,
  sourceProjectPath?: string,
  runtimeDelivery: 'installed_skill' | 'provided_verified_runtime_material' = 'installed_skill',
): BuiltProjectHistoryAgentPackage {
  const content = normalizeCreatorAgentPackageDraftContent(behavior);
  const {
    name: packageName,
    description: packageDescription,
    instructions,
    outputDescription,
    starterPrompts,
  } = content;
  const agentMarkdown = renderAgentMarkdown(packageName, packageDescription, runtimeDelivery);
  const skillMarkdown = renderSkillMarkdown(instructions, outputDescription, starterPrompts);
  const starterPromptsText = serializeCreatorAgentPackageStarterPrompts(
    createCreatorAgentPackageStarterPrompts({
      protocol: CREATOR_AGENT_PACKAGE_STARTER_PROMPTS_PROTOCOL,
      starterPrompts,
    }),
  );
  assertPortablePackageText(agentMarkdown, sourceProjectPath);
  assertPortablePackageText(skillMarkdown, sourceProjectPath);
  assertPortablePackageText(provenanceText, sourceProjectPath);
  assertPortablePackageText(starterPromptsText, sourceProjectPath);
  const files = Object.freeze([
    Object.freeze({ path: 'AGENT.md', text: agentMarkdown }),
    Object.freeze({ path: SKILL_PATH, text: skillMarkdown }),
    Object.freeze({ path: PROVENANCE_PATH, text: provenanceText }),
    Object.freeze({ path: CREATOR_AGENT_PACKAGE_STARTER_PROMPTS_PATH, text: starterPromptsText }),
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

function renderAgentMarkdown(
  name: string,
  description: string,
  runtimeDelivery: 'installed_skill' | 'provided_verified_runtime_material',
): string {
  const outcome =
    runtimeDelivery === 'installed_skill'
      ? 'Complete the user task by applying the installed `extracted-method` Skill to evidence in the current consumer Project.'
      : 'Complete the user task by applying the provided and verified `extracted-method` Skill runtime material to evidence in the current consumer Project.';
  const routing =
    runtimeDelivery === 'installed_skill'
      ? 'Use the installed `extracted-method` Skill for every task in this Agent Package.'
      : 'Use the provided and verified `extracted-method` Skill runtime material for every task in this Agent Package.';
  return [
    '# Identity',
    `You are ${name}.`,
    description,
    '',
    '# Outcomes',
    outcome,
    '',
    '# Operating Loop',
    'Understand the request, inspect the current Project, apply the extracted method, verify the result, and then answer.',
    '',
    '# Capability Routing',
    routing,
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
    containsLikelyProjectHistoryCredential(text) ||
    containsNonPortableProjectHistoryReference(text)
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

function containsUnsafeAgentText(value: string): boolean {
  if (/\p{Cf}/u.test(value)) return true;
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
