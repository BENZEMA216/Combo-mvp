import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { installationPaths } from './adapter.js';
import {
  MAX_ARTIFACT_BYTES,
  MINIMUM_NODE_VERSION,
  PROFILE_VERSION,
  RECEIVER_VERSION,
  ReceiverError,
  assertSupportedRuntime,
  digest,
  parseArguments,
  supportsNodeVersion,
} from './contract.js';
import { downloadPackage } from './download.js';
import { ProjectFiles } from './filesystem.js';
import { installPackage, verifyInstalled } from './install.js';

function readReceiverArtifact(url: string): Buffer {
  const path = fileURLToPath(url);
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1 ||
    before.size > MAX_ARTIFACT_BYTES
  )
    throw new ReceiverError('INPUT_INVALID');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      throw new ReceiverError('INPUT_INVALID');
    if (!opened.isFile()) throw new ReceiverError('INPUT_INVALID');
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    const bytes = buffer.subarray(0, length);
    const after = fstatSync(fd);
    if (
      bytes.length !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw new ReceiverError('INPUT_INVALID');
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** Intended for the trusted Host; import alone does not read files, start a process or use the network. */
export async function runAgentPackageReceiver(args: readonly string[]) {
  assertSupportedRuntime();
  const input = parseArguments(args);
  const fs = new ProjectFiles(input.projectRoot);
  const receiverBytes = readReceiverArtifact(import.meta.url);
  const paths = installationPaths(input);
  let status: 'installed' | 'already_installed' | 'verified';
  let name: string;
  if (input.mode === 'verify') {
    name = verifyInstalled(input, fs, receiverBytes).manifest.name;
    status = 'verified';
  } else {
    const candidate = await downloadPackage(input);
    name = candidate.manifest.name;
    fs.assertBound();
    status = installPackage(input, fs, candidate, receiverBytes);
  }
  return {
    protocol: 'combo.agent-package-receiver-result/1',
    status,
    receiverVersion: RECEIVER_VERSION,
    profileVersion: PROFILE_VERSION,
    releaseId: input.releaseId,
    packageDigest: input.packageDigest,
    supportedPlatforms: ['darwin', 'linux'],
    minimumNodeVersion: MINIMUM_NODE_VERSION,
    name,
    skillName: `combo-${input.releaseId.slice(-32)}`,
    receiverDigest: digest(receiverBytes),
    packagePath: fs.path(paths.packageRelativePath),
    skillPath: fs.path(`${paths.skillRelativePath}/SKILL.md`),
    receiptPath: fs.path(`${paths.skillRelativePath}/installation.json`),
    projectBinding: {
      kind: 'host_selected_path',
      isolation: 'same_uid_unisolated_not_os_enforced',
    },
    runtime: { status: 'not_run' },
  };
}

async function main(): Promise<void> {
  try {
    process.stdout.write(
      `${JSON.stringify(await runAgentPackageReceiver(process.argv.slice(2)))}\n`,
    );
  } catch (error) {
    const failure =
      error instanceof ReceiverError ? error : new ReceiverError('INSTALL_INCOMPLETE');
    process.stdout.write(
      `${JSON.stringify({
        protocol: 'combo.agent-package-receiver-error/1',
        status: 'error',
        code: failure.code,
        message: failure.message,
        runtime: { status: 'not_run' },
      })}\n`,
    );
    process.exitCode = 1;
  }
}
// Native entry identity handles ancestor aliases without filesystem I/O during supported imports.
// Older Node lacks this property: emit the unsupported-runtime error instead of a silent exit 0.
if (
  import.meta.main ||
  (import.meta.main === undefined && !supportsNodeVersion(process.versions.node))
)
  await main();
