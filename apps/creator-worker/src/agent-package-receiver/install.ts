import { linkSync, lstatSync, unlinkSync, type Stats } from 'node:fs';

import { adapterFiles, installationPaths } from './adapter.js';
import {
  MAX_PACKAGE_BYTES,
  ReceiverError,
  verifyPackage,
  type ReceiverInput,
  type VerifiedPackage,
} from './contract.js';
import { ProjectFiles, expectedInventory } from './filesystem.js';

const lockPath = '.combo/receiver-install.lock';
function assertLockState(fs: ProjectFiles, owned?: Stats): void {
  fs.assertBound();
  if (!fs.directory('.combo', false)) {
    if (owned) throw new ReceiverError('INSTALL_INCOMPLETE');
    return;
  }
  let current: Stats;
  try {
    current = lstatSync(fs.path(lockPath));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT' && !owned) return;
    throw new ReceiverError('INSTALL_INCOMPLETE');
  }
  if (
    !owned ||
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.dev !== owned.dev ||
    current.ino !== owned.ino
  )
    throw new ReceiverError('INSTALL_BUSY');
  fs.assertBound();
}
function equalInventory(actual: string[], expected: string[]): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new ReceiverError('INSTALL_CONFLICT');
}
function packageFiles(candidate: VerifiedPackage) {
  return [
    { path: 'agent.json', bytes: Buffer.from(candidate.manifestText, 'utf8') },
    ...candidate.files.map(({ path, text }) => ({ path, bytes: Buffer.from(text, 'utf8') })),
  ];
}
function assertExactFiles(
  fs: ProjectFiles,
  parent: string,
  files: { path: string; bytes: Buffer }[],
): void {
  equalInventory(fs.inventory(parent), expectedInventory(files.map(({ path }) => path)));
  for (const file of files)
    if (!fs.read(`${parent}/${file.path}`, file.bytes.length).equals(file.bytes))
      throw new ReceiverError('INSTALL_CONFLICT');
}
export function verifyInstalled(
  input: ReceiverInput,
  fs: ProjectFiles,
  receiverBytes: Buffer,
  ownedLock?: Stats,
) {
  assertLockState(fs, ownedLock);
  try {
    const paths = installationPaths(input);
    const manifestText = new TextDecoder('utf-8', { fatal: true }).decode(
      fs.read(`${paths.packageRelativePath}/agent.json`, 65_536),
    );
    const files = [
      'AGENT.md',
      'skills/extracted-method/SKILL.md',
      'skills/extracted-method/provenance.json',
    ].map((path) => ({
      path,
      text: new TextDecoder('utf-8', { fatal: true }).decode(
        fs.read(`${paths.packageRelativePath}/${path}`, MAX_PACKAGE_BYTES),
      ),
    }));
    const candidate = verifyPackage(
      { manifestText, packageDigest: input.packageDigest, files },
      input.packageDigest,
    );
    assertExactFiles(fs, paths.packageRelativePath, packageFiles(candidate));
    assertExactFiles(
      fs,
      paths.skillRelativePath,
      adapterFiles(input, candidate, receiverBytes, fs.rootIdentity),
    );
    fs.assertBound();
    assertLockState(fs, ownedLock);
    return candidate;
  } catch (error) {
    if (
      error instanceof ReceiverError &&
      ['PROJECT_UNAVAILABLE', 'INSTALL_BUSY', 'INSTALL_INCOMPLETE'].includes(error.code)
    )
      throw error;
    throw new ReceiverError('INSTALL_CONFLICT');
  }
}

function removeOwnedFile(fs: ProjectFiles, relative: string, expected: Stats): void {
  fs.assertBound();
  const path = fs.path(relative);
  const current = lstatSync(path);
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  )
    throw new ReceiverError('INSTALL_INCOMPLETE');
  unlinkSync(path);
  fs.assertBound();
}

export function installPackage(
  input: ReceiverInput,
  fs: ProjectFiles,
  candidate: VerifiedPackage,
  receiverBytes: Buffer,
): 'installed' | 'already_installed' {
  const paths = installationPaths(input);
  assertLockState(fs);
  // Check known destinations before acquiring a lock or creating any directories.
  const hasPackage = fs.directory(paths.packageRelativePath, false);
  const hasSkill = fs.directory(paths.skillRelativePath, false);
  if (hasSkill) {
    verifyInstalled(input, fs, receiverBytes);
    return 'already_installed';
  }
  if (hasPackage) assertExactFiles(fs, paths.packageRelativePath, packageFiles(candidate));
  fs.directory('.combo', true);
  const lock = lockPath;
  try {
    fs.write(lock, Buffer.from('combo.agent-package-receiver/1\n', 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new ReceiverError('INSTALL_BUSY');
    throw error;
  }
  const lockIdentity = lstatSync(fs.path(lock));
  let activated: Stats | undefined;
  let result: 'installed' | undefined;
  let failure: unknown;
  try {
    // Repeat after the exclusive lock: another receiver may have completed since preflight.
    if (fs.directory(paths.skillRelativePath, false)) throw new ReceiverError('INSTALL_CONFLICT');
    if (!hasPackage) {
      fs.directory(paths.packageRelativePath, true, true);
      for (const file of packageFiles(candidate))
        fs.write(`${paths.packageRelativePath}/${file.path}`, file.bytes);
    }
    assertExactFiles(fs, paths.packageRelativePath, packageFiles(candidate));
    fs.directory(paths.skillRelativePath, true, true);
    const generated = adapterFiles(input, candidate, receiverBytes, fs.rootIdentity);
    const entry = generated.find(({ path }) => path === 'SKILL.md')!;
    for (const file of generated.filter(({ path }) => path !== 'SKILL.md'))
      fs.write(`${paths.skillRelativePath}/${file.path}`, file.bytes);
    const pending = `${paths.skillRelativePath}/entry-pending`;
    fs.write(pending, entry.bytes);
    assertExactFiles(fs, paths.skillRelativePath, [
      ...generated.filter(({ path }) => path !== 'SKILL.md'),
      { path: 'entry-pending', bytes: entry.bytes },
    ]);
    fs.assertBound();
    const pendingIdentity = lstatSync(fs.path(pending));
    // Unlike rename(), hard-link publication never replaces an existing SKILL.md.
    linkSync(fs.path(pending), fs.path(`${paths.skillRelativePath}/SKILL.md`));
    activated = pendingIdentity;
    removeOwnedFile(fs, pending, pendingIdentity);
    fs.syncParent(`${paths.skillRelativePath}/SKILL.md`);
    verifyInstalled(input, fs, receiverBytes, lockIdentity);
    result = 'installed';
  } catch (error) {
    failure = error;
    if (activated) {
      try {
        removeOwnedFile(fs, `${paths.skillRelativePath}/SKILL.md`, activated);
      } catch {
        failure = new ReceiverError('INSTALL_INCOMPLETE');
      }
    }
  }
  try {
    removeOwnedFile(fs, lock, lockIdentity);
  } catch {
    throw new ReceiverError('INSTALL_INCOMPLETE');
  }
  if (failure)
    throw failure instanceof ReceiverError ? failure : new ReceiverError('INSTALL_INCOMPLETE');
  if (!result) throw new ReceiverError('INSTALL_INCOMPLETE');
  return result;
}
