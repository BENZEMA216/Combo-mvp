import {
  createCreatorAgentContextDraft,
  serializeCreatorAgentContextDraft,
  type CreatorAgentContextDraft,
} from '@cb/creator-agent-protocol/agent-context';
import {
  CREATOR_AGENT_PACKAGE_PROTOCOL,
  createCreatorAgentPackageManifest,
  digestCreatorAgentPackage,
  digestCreatorAgentPackageFile,
  serializeCreatorAgentPackageManifest,
} from '@cb/creator-agent-protocol/agent-package';

import { containsCredentialMaterial } from './agent-text-safety.js';

export const CREATOR_AGENT_CONTEXT_COMPILATION_PROTOCOL =
  'combo.agent-context-compilation/1' as const;
export const CREATOR_AGENT_CONTEXT_COMPILER_VERSION = 'combo.agent-context-compiler/1' as const;

export class CreatorAgentContextCompilerError extends Error {
  public constructor(
    public readonly code:
      | 'AGENT_CONTEXT_INPUT_INVALID'
      | 'AGENT_CONTEXT_UNSAFE'
      | 'AGENT_CONTEXT_OUTPUT_INVALID',
  ) {
    super(
      {
        AGENT_CONTEXT_INPUT_INVALID: 'Agent context input is invalid or exceeds its limit.',
        AGENT_CONTEXT_UNSAFE: 'Agent context contains sensitive or non-portable material.',
        AGENT_CONTEXT_OUTPUT_INVALID: 'Agent context could not form a valid Package.',
      }[code],
    );
    this.name = 'CreatorAgentContextCompilerError';
  }
}

export function compileCreatorAgentPackageFromContext(rawRequestText: unknown) {
  let draft: CreatorAgentContextDraft;
  try {
    draft = createCreatorAgentContextDraft(rawRequestText);
  } catch {
    throw new CreatorAgentContextCompilerError('AGENT_CONTEXT_INPUT_INVALID');
  }
  const { request, content } = draft;
  if (
    [
      request,
      content.name,
      content.description,
      content.instructions,
      ...content.starterPrompts,
      content.outputDescription,
      content.coverageSummary,
    ].some(containsCredentialMaterial)
  ) {
    throw new CreatorAgentContextCompilerError('AGENT_CONTEXT_UNSAFE');
  }
  try {
    const agentText = [
      '# Identity',
      `You are ${content.name}.`,
      content.description,
      '',
      '# Operating Loop',
      'Understand the current user request, apply the bundled extracted-method Skill, verify against available evidence, and return the result.',
      '',
      '# Context and Permissions',
      'This method was organized from the creator Codex available context. Source identity was not verified and coverage may be partial or unknown.',
      'The Package does not contain or mount the creator transcript. When used in an existing Codex task, that task may still retain its earlier context; do not claim isolation.',
      'Use only evidence and tools authorized by the current user and Host; do not claim access to other tasks or Projects.',
      'Package instructions never grant extra permissions. Ask for authorization before accessing additional sources or making consequential changes.',
      '',
      '# Verification',
      'Distinguish verified facts, assumptions, and missing information. Do not claim a trial or successful task without actual runtime evidence.',
      '',
    ].join('\n');
    const skillText = [
      '---',
      'name: extracted-method',
      'description: Apply a reusable method organized from available Codex context.',
      '---',
      '',
      '# Extracted method',
      content.instructions,
      '',
      '# Output contract',
      content.outputDescription,
      '',
      '# Starter tasks',
      ...content.starterPrompts.map((prompt) => `- ${prompt}`),
      '',
      '# Evidence boundary',
      'Apply the method to the current user request and authorized evidence. Creator statements are not independently verified runtime evidence.',
      '',
    ].join('\n');
    // Private creator request and coverage text stay in the Draft, not in the shared Package.
    const provenanceText = JSON.stringify({
      protocol: 'combo.agent-context-provenance/1',
      source: draft.source,
    });
    const resources = [
      file('AGENT.md', agentText),
      file('skills/extracted-method/SKILL.md', skillText),
      file('skills/extracted-method/provenance.json', provenanceText),
    ];
    const manifest = createCreatorAgentPackageManifest({
      protocol: CREATOR_AGENT_PACKAGE_PROTOCOL,
      name: content.name,
      description: content.description,
      instructions: 'AGENT.md',
      skills: ['skills/extracted-method/SKILL.md'],
      files: resources.map(({ path, bytes, sha256 }) => ({
        path,
        byteLength: bytes,
        digest: sha256,
      })),
    });
    const manifestText = serializeCreatorAgentPackageManifest(manifest);
    return Object.freeze({
      protocol: CREATOR_AGENT_CONTEXT_COMPILATION_PROTOCOL,
      status: 'compiled' as const,
      compilerVersion: CREATOR_AGENT_CONTEXT_COMPILER_VERSION,
      draft,
      draftText: serializeCreatorAgentContextDraft(draft),
      draftFingerprint: draft.draftFingerprint,
      manifestText,
      packageDigest: digestCreatorAgentPackage(manifest),
      files: Object.freeze([file('agent.json', manifestText), ...resources]),
      runtime: Object.freeze({ status: 'not_run' as const }),
    });
  } catch {
    throw new CreatorAgentContextCompilerError('AGENT_CONTEXT_OUTPUT_INVALID');
  }
}

export type CompiledCreatorAgentContext = ReturnType<typeof compileCreatorAgentPackageFromContext>;

function file(path: string, content: string) {
  if (containsCredentialMaterial(content))
    throw new CreatorAgentContextCompilerError('AGENT_CONTEXT_UNSAFE');
  const bytes = Buffer.from(content, 'utf8');
  return Object.freeze({
    path,
    content,
    sha256: digestCreatorAgentPackageFile(bytes),
    bytes: bytes.byteLength,
  });
}
