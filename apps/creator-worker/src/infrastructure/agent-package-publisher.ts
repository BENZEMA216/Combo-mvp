import { constants } from 'node:fs';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, posix, resolve } from 'node:path';

import type { CreatorAgentPackageDigest } from '@cb/creator-agent-protocol/agent-package';

export type CreatorAgentPackagePublication = Readonly<{
  disposition: 'CREATED' | 'EXISTING';
  packagePath: string;
}>;

export type CreatorAgentPackagePublicationInput = Readonly<{
  packageDigest: CreatorAgentPackageDigest;
  manifestText: string;
  files: readonly Readonly<{ path: string; text: string }>[];
}>;

class CreatorAgentPackageCommittedPublicationError extends Error {
  public constructor(
    public readonly packagePath: string,
    cause: unknown,
  ) {
    super('Agent Package was committed but final publication durability did not complete.', {
      cause,
    });
    this.name = 'CreatorAgentPackageCommittedPublicationError';
  }
}

export function publishBuiltCreatorAgentPackage(
  build: CreatorAgentPackagePublicationInput,
  rawStoreDirectory: string,
): CreatorAgentPackagePublication {
  const store = privateCanonicalStore(rawStoreDirectory);
  const packagePath = join(store, build.packageDigest.replace(':', '-'));
  if (directoryEntryExists(packagePath)) {
    return Object.freeze({
      disposition: 'EXISTING',
      packagePath: exactExistingDirectory(packagePath),
    });
  }
  const stage = realpathSync(mkdtempSync(join(store, '.agent-package-stage-')));
  let committed = false;
  try {
    chmodSync(stage, 0o700);
    const directories = packageDirectories(build.files.map(({ path }) => path));
    for (const directory of directories) {
      mkdirSync(join(stage, ...directory.split('/')), { mode: 0o700 });
    }
    for (const file of build.files) {
      writePrivateFile(join(stage, ...file.path.split('/')), Buffer.from(file.text, 'utf8'));
    }
    writePrivateFile(join(stage, 'agent.json'), Buffer.from(build.manifestText, 'utf8'));
    for (const directory of [...directories].reverse()) {
      syncDirectory(join(stage, ...directory.split('/')));
    }
    syncDirectory(stage);
    try {
      renameSync(stage, packagePath);
    } catch (error) {
      if (!directoryEntryExists(packagePath)) throw error;
      return Object.freeze({
        disposition: 'EXISTING',
        packagePath: exactExistingDirectory(packagePath),
      });
    }
    committed = true;
    try {
      for (const directory of [...directories].reverse()) {
        chmodSync(join(packagePath, ...directory.split('/')), 0o500);
      }
      chmodSync(packagePath, 0o500);
      syncDirectory(store);
      return Object.freeze({ disposition: 'CREATED', packagePath: realpathSync(packagePath) });
    } catch (error) {
      throw new CreatorAgentPackageCommittedPublicationError(packagePath, error);
    }
  } finally {
    if (!committed && directoryEntryExists(stage)) removePrivateTree(stage);
  }
}

function exactExistingDirectory(path: string): string {
  const stat = lstatSync(path);
  const canonical = realpathSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== path) {
    throw new TypeError('Agent Package digest target is not a real directory.');
  }
  return canonical;
}

function privateCanonicalStore(input: string): string {
  if (
    typeof input !== 'string' ||
    !input ||
    input.length > 2_048 ||
    !isAbsolute(input) ||
    resolve(input) !== input
  ) {
    throw new TypeError('Agent Package store must be a canonical absolute directory.');
  }
  const root = realpathSync(input);
  const stat = statSync(root);
  if (root !== input || !stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new TypeError('Agent Package store must be a private real directory.');
  }
  return root;
}

function packageDirectories(paths: readonly string[]): readonly string[] {
  const directories = new Set<string>();
  for (const path of paths) {
    let parent = posix.dirname(path);
    while (parent !== '.') {
      directories.add(parent);
      parent = posix.dirname(parent);
    }
  }
  return [...directories].sort((left, right) => {
    const depth = left.split('/').length - right.split('/').length;
    return depth === 0 ? left.localeCompare(right) : depth;
  });
}

function writePrivateFile(path: string, bytes: Uint8Array): void {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o400,
  );
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o400);
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function directoryEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

function removePrivateTree(root: string): void {
  const pending = [root];
  for (let index = 0; index < pending.length; index += 1) {
    const directory = pending[index]!;
    chmodSync(directory, 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(join(directory, entry.name));
    }
  }
  rmSync(root, { recursive: true, force: false });
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
