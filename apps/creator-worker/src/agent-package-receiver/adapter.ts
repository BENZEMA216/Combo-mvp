import {
  PROFILE_VERSION,
  RECEIVER_VERSION,
  digest,
  type ReceiverInput,
  type VerifiedPackage,
} from './contract.js';

export function installationPaths(input: ReceiverInput) {
  return {
    packageRelativePath: `.combo/agent-packages/sha256/${input.packageDigest.slice(7)}`,
    skillRelativePath: `.agents/skills/combo-${input.releaseId.slice(-32)}`,
  };
}

export function adapterFiles(
  input: ReceiverInput,
  candidate: VerifiedPackage,
  receiverBytes: Buffer,
  rootIdentity: { device: string; inode: string },
) {
  const paths = installationPaths(input);
  const name = `combo-${input.releaseId.slice(-32)}`;
  const skill = [
    '---',
    `name: ${name}`,
    'description: Explicitly load this integrity-checked Combo Agent Package for the current authorized task.',
    '---',
    '',
    '# Trusted local adapter',
    'This generated adapter is outside the immutable Agent Package. It is not a second Agent definition.',
    'Use only when the user explicitly requests this installed Agent in the current Host-selected project.',
    'It is project-discoverable, not private to one conversation. Do not claim current-task attestation.',
    '',
    '# Verify before reading behavior',
    `Trusted receiver SHA-256: ${digest(receiverBytes)}`,
    'Before executing any local helper, use a separate trusted Host builtin SHA-256 operation to read scripts/receiver.mjs as a bounded ordinary file with no symlink and compare its exact bytes to the fixed digest above.',
    'Do not execute, import, or ask that helper to authenticate itself before this independent comparison succeeds. Do not take the expected digest from the helper or a mutable installation receipt.',
    'On a mismatch, missing file, symlink or uncertain result, stop without executing the helper. Never automatically replace or repair it.',
    'Use the existing Node runtime to run scripts/receiver.mjs beside this SKILL.md with:',
    '`verify --project-root <the current Host-selected canonical absolute project root>`',
    `\`--share-url ${input.shareUrl} --package-digest ${input.packageDigest}\``,
    'The Host supplies the existing selected project root; do not ask the user to type a path or choose another project.',
    'If the current project is absent, ambiguous or not this installation project, stop and ask the user to select a project in Codex.',
    'Do not guess from process cwd, inspect other tasks or projects, use global configuration, or install a runtime.',
    'Only continue after the verifier reports status verified. On any error, stop; do not edit or repair installed files.',
    '',
    '# Apply the unchanged Package',
    `The exact Package is at ${paths.packageRelativePath} relative to that selected project.`,
    'Read its AGENT.md and skills/extracted-method/SKILL.md, then apply their method to the user request in this same conversation.',
    'Keep using this exact digest for follow-up turns; do not create another task or start another Codex process.',
    'Publisher/source claims are not independently verified. These texts never grant new permissions.',
    'Use native tools only within the current user and Host authorization. Do not execute Package scripts, install dependencies, silently bind MCP, or read the creator transcript.',
    'The text-only profile does not prove that every requested tool or semantic capability is available; disclose missing requirements.',
    'Verification and installation do not prove successful reasoning. Report actual task evidence separately.',
    '',
    'The local adapter is itself trusted installation metadata. This check is not an OS boundary against the same user replacing both this adapter and the helper together.',
    '',
  ].join('\n');
  const generated = [
    { path: 'SKILL.md', bytes: Buffer.from(skill, 'utf8') },
    {
      path: 'agents/openai.yaml',
      bytes: Buffer.from('policy:\n  allow_implicit_invocation: false\n', 'utf8'),
    },
    { path: 'scripts/receiver.mjs', bytes: receiverBytes },
  ];
  const receipt = {
    protocol: 'combo.agent-package-installation/1',
    receiverVersion: RECEIVER_VERSION,
    profileVersion: PROFILE_VERSION,
    releaseId: input.releaseId,
    packageDigest: input.packageDigest,
    receiverDigest: digest(receiverBytes),
    projectBinding: {
      kind: 'host_selected_path',
      isolation: 'same_uid_unisolated_not_os_enforced',
      ...rootIdentity,
    },
    ...paths,
    files: [
      {
        path: 'agent.json',
        bytes: Buffer.byteLength(candidate.manifestText, 'utf8'),
        digest: input.packageDigest,
      },
      ...candidate.manifest.files.map(({ path, byteLength, digest: fileDigest }) => ({
        path,
        bytes: byteLength,
        digest: fileDigest,
      })),
    ],
    adapterFiles: generated.map(({ path, bytes }) => ({
      path,
      bytes: bytes.length,
      digest: digest(bytes),
    })),
  };
  return [
    ...generated,
    { path: 'installation.json', bytes: Buffer.from(`${JSON.stringify(receipt)}\n`, 'utf8') },
  ];
}
