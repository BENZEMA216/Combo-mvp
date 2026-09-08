import { createHash } from 'node:crypto';

import {
  digestCreatorAgentPackage,
  digestCreatorAgentPackageFile,
  parseCreatorAgentPackageManifest,
} from '@cb/creator-agent-protocol/agent-package';
import { z } from 'zod';

export const RECEIVER_VERSION = 'combo.agent-package-receiver/1' as const;
export const PROFILE_VERSION = 'combo.agent-package-receiver-text/1' as const;
export const PUBLIC_ORIGIN = 'https://test.43-160-242-46.sslip.io';
export const MAX_ARTIFACT_BYTES = 1_048_576;
export const MAX_PACKAGE_BYTES = 524_288;
export const MINIMUM_NODE_VERSION = '24.2.0';
export const PROFILE_PATHS = [
  'AGENT.md',
  'skills/extracted-method/SKILL.md',
  'skills/extracted-method/provenance.json',
] as const;
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const textSchema = z.string().refine((text) => Buffer.from(text, 'utf8').toString('utf8') === text);
const packageSchema = z
  .object({
    manifestText: textSchema,
    packageDigest: digestSchema,
    files: z.array(z.object({ path: z.string(), text: textSchema }).strict()).length(3),
  })
  .strict();
const source = z
  .object({
    kind: z.literal('codex_available_context'),
    verification: z.literal('not_verified'),
    completeness: z.literal('partial_or_unknown'),
  })
  .strict();
const provenance = z
  .object({ protocol: z.literal('combo.agent-context-provenance/1'), source })
  .strict();

export type ReceiverCode =
  | 'UNSUPPORTED_RUNTIME'
  | 'INPUT_INVALID'
  | 'PROJECT_UNAVAILABLE'
  | 'PACKAGE_INVALID'
  | 'NETWORK_UNAVAILABLE'
  | 'INSTALL_CONFLICT'
  | 'INSTALL_BUSY'
  | 'INSTALL_INCOMPLETE';
export class ReceiverError extends Error {
  constructor(public readonly code: ReceiverCode) {
    super(
      {
        UNSUPPORTED_RUNTIME:
          'Node 24.2 or newer on macOS or Linux is required; no runtime will be installed.',
        INPUT_INVALID: 'Receiver arguments or trusted artifact are invalid.',
        PROJECT_UNAVAILABLE: 'A canonical current project directory is required.',
        PACKAGE_INVALID: 'The exact published Package did not pass the supported text profile.',
        NETWORK_UNAVAILABLE: 'The public Package could not be retrieved securely.',
        INSTALL_CONFLICT: 'Existing project files conflict; nothing will be overwritten.',
        INSTALL_BUSY: 'Another installation or an interrupted installation lock exists.',
        INSTALL_INCOMPLETE:
          'Installation could not be fully verified; files may remain. Do not apply them.',
      }[code],
    );
    this.name = 'ReceiverError';
  }
}
export function supportsNodeVersion(nodeVersion: string): boolean {
  if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/u.test(nodeVersion)) return false;
  const [major = 0, minor = 0] = nodeVersion.split('.').map(Number);
  return major > 24 || (major === 24 && minor >= 2);
}
export function assertSupportedRuntime(
  platform: string = process.platform,
  nodeVersion: string = process.versions.node,
): void {
  if (!['darwin', 'linux'].includes(platform) || !supportsNodeVersion(nodeVersion))
    throw new ReceiverError('UNSUPPORTED_RUNTIME');
}
export function digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
export type ReceiverInput = {
  mode: 'install' | 'verify';
  projectRoot: string;
  shareUrl: string;
  releaseId: string;
  packageDigest: string;
};
export function parseArguments(args: readonly string[]): ReceiverInput {
  const [mode, ...flags] = args;
  if ((mode !== 'install' && mode !== 'verify') || flags.length !== 6)
    throw new ReceiverError('INPUT_INVALID');
  const values = new Map<string, string>();
  for (let i = 0; i < flags.length; i += 2) {
    const key = flags[i]!;
    const value = flags[i + 1]!;
    if (
      !['--project-root', '--share-url', '--package-digest'].includes(key) ||
      values.has(key) ||
      !value ||
      value.includes('\0')
    )
      throw new ReceiverError('INPUT_INVALID');
    values.set(key, value);
  }
  const shareUrl = values.get('--share-url')!;
  const prefix = `${PUBLIC_ORIGIN}/agents/`;
  const releaseId = shareUrl.slice(prefix.length);
  const packageDigest = values.get('--package-digest')!;
  if (
    !shareUrl.startsWith(prefix) ||
    !/^release\.agent-package\.[0-9a-f]{32}$/u.test(releaseId) ||
    !digestSchema.safeParse(packageDigest).success
  )
    throw new ReceiverError('INPUT_INVALID');
  return { mode, projectRoot: values.get('--project-root')!, shareUrl, releaseId, packageDigest };
}
export function verifyPackage(input: unknown, expectedDigest: string) {
  try {
    // Cap the wire array before a schema library can walk an attacker-sized item collection.
    if (
      !input ||
      typeof input !== 'object' ||
      !('files' in input) ||
      !Array.isArray(input.files) ||
      input.files.length !== 3
    )
      throw new Error('file count');
    const candidate = packageSchema.parse(input);
    if (Buffer.byteLength(candidate.manifestText, 'utf8') > 65_536) throw new Error('limit');
    const manifest = parseCreatorAgentPackageManifest(candidate.manifestText);
    if (
      candidate.packageDigest !== expectedDigest ||
      digestCreatorAgentPackage(manifest) !== expectedDigest ||
      JSON.stringify(manifest.skills) !== JSON.stringify([PROFILE_PATHS[1]]) ||
      JSON.stringify(manifest.files.map(({ path }) => path)) !== JSON.stringify(PROFILE_PATHS) ||
      JSON.stringify(candidate.files.map(({ path }) => path)) !== JSON.stringify(PROFILE_PATHS)
    )
      throw new Error('profile');
    let byteCount = Buffer.byteLength(candidate.manifestText, 'utf8');
    for (const [index, file] of candidate.files.entries()) {
      const bytes = Buffer.from(file.text, 'utf8');
      byteCount += bytes.length;
      const expected = manifest.files[index]!;
      if (
        bytes.length !== expected.byteLength ||
        digestCreatorAgentPackageFile(bytes) !== expected.digest
      )
        throw new Error('bytes');
    }
    if (byteCount > MAX_PACKAGE_BYTES) throw new Error('limit');
    provenance.parse(JSON.parse(candidate.files[2]!.text));
    // Only this native Skill entry is registered by the lightweight compiler. No package scripts run.
    if (
      !candidate.files[1]!.text.startsWith(
        '---\nname: extracted-method\n' +
          'description: Apply a reusable method organized from available Codex context.\n---\n',
      )
    )
      throw new Error('skill');
    return { ...candidate, manifest };
  } catch {
    throw new ReceiverError('PACKAGE_INVALID');
  }
}
export type VerifiedPackage = ReturnType<typeof verifyPackage>;
