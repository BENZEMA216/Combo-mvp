import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeSync,
  type BigIntStats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertCreatorProjectSourceScan,
  assertCreatorProjectSourceFileIdentity,
  isAllowedCreatorProjectSourcePath,
  ProjectContextIndexError,
  type ProjectContextEntry,
  type ProjectContextScan,
} from '../project-context-index.js';
import { isFileDescriptorBoundToCanonicalProjectPath } from './file-descriptor-path-binding.js';

const COPY_BUFFER_BYTES = 128 * 1024;

export type CreatorProjectSourceProjection = Readonly<{
  projectPath: string;
  release(): void;
}>;

type CreatorProjectSourceProjectionHooks = Readonly<{
  beforeSourceFileOpen?: (relativePath: string) => void;
  beforeSourceFileRead?: (relativePath: string) => void;
}>;

/** Materializes only the exact Creator-profile files into an inert read-only Host workspace. */
export function materializeCreatorProjectSourceProjection(
  scan: ProjectContextScan,
): CreatorProjectSourceProjection {
  return materializeCreatorProjectSourceProjectionWithHooks(scan, {});
}

/** Internal race-test seam; intentionally absent from the package root export. */
export function materializeCreatorProjectSourceProjectionWithHooks(
  scan: ProjectContextScan,
  hooks: CreatorProjectSourceProjectionHooks,
): CreatorProjectSourceProjection {
  assertCreatorProjectSourceScan(scan);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'combo-agent-package-creator-source-')));
  const rootIdentity = lstatSync(root, { bigint: true });
  try {
    chmodSync(root, 0o700);
    const allowed = scan.index.entries.filter(({ path }) =>
      isAllowedCreatorProjectSourcePath(path),
    );
    const directories = allowed.filter(({ kind }) => kind === 'directory').sort(compareEntryDepth);
    const files = allowed.filter(({ kind }) => kind !== 'directory');
    if (files.some(({ kind }) => kind !== 'file')) {
      throw new ProjectContextIndexError(
        'PROJECT_CONTEXT_SCAN_FAILED',
        'Agent Package Creator source projection contains a non-regular entry.',
      );
    }
    for (const directory of directories) {
      mkdirSync(projectedPath(root, directory.path), { mode: 0o700 });
    }
    for (const file of files) copyVerifiedFile(scan, root, file, hooks);
    for (const directory of [...directories].reverse()) {
      chmodSync(projectedPath(root, directory.path), 0o500);
    }
    chmodSync(root, 0o500);
  } catch (error) {
    try {
      removeProjection(root, rootIdentity);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Creator source projection creation and cleanup both failed.',
      );
    }
    throw error;
  }

  let released = false;
  return Object.freeze({
    projectPath: root,
    release: () => {
      if (released) return;
      removeProjection(root, rootIdentity);
      released = true;
    },
  });
}

function copyVerifiedFile(
  scan: ProjectContextScan,
  projectionRoot: string,
  entry: ProjectContextEntry,
  hooks: CreatorProjectSourceProjectionHooks,
): void {
  const sourceRoot = scan.projectPath;
  const source = projectedPath(sourceRoot, entry.path);
  const destination = projectedPath(projectionRoot, entry.path);
  let sourceDescriptor: number | undefined;
  let destinationDescriptor: number | undefined;
  try {
    hooks.beforeSourceFileOpen?.(entry.path);
    sourceDescriptor = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(sourceDescriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.size !== BigInt(entry.sizeBytes) ||
      !isFileDescriptorBoundToCanonicalProjectPath(sourceRoot, source, sourceDescriptor)
    ) {
      throw sourceChanged();
    }
    assertCreatorProjectSourceFileIdentity(scan, entry.path, before);
    destinationDescriptor = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o400,
    );
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let copied = 0;
    hooks.beforeSourceFileRead?.(entry.path);
    while (true) {
      const bytesRead = readSync(sourceDescriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const bytesWritten = writeSync(
          destinationDescriptor,
          buffer,
          written,
          bytesRead - written,
          null,
        );
        if (bytesWritten === 0) throw sourceChanged();
        written += bytesWritten;
      }
      copied += bytesRead;
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = fstatSync(sourceDescriptor, { bigint: true });
    if (
      copied !== entry.sizeBytes ||
      `sha256:${digest.digest('hex')}` !== entry.digest ||
      !sameFile(before, after) ||
      !isFileDescriptorBoundToCanonicalProjectPath(sourceRoot, source, sourceDescriptor)
    ) {
      throw sourceChanged();
    }
    assertCreatorProjectSourceFileIdentity(scan, entry.path, after);
  } catch (error) {
    if (error instanceof ProjectContextIndexError) throw error;
    throw new ProjectContextIndexError(
      'PROJECT_CONTEXT_SCAN_FAILED',
      'Agent Package Creator source projection could not be materialized safely.',
      error instanceof Error ? { cause: error } : undefined,
    );
  } finally {
    if (destinationDescriptor !== undefined) closeSync(destinationDescriptor);
    if (sourceDescriptor !== undefined) closeSync(sourceDescriptor);
  }
  chmodSync(destination, 0o400);
}

function projectedPath(root: string, path: string): string {
  if (!isAllowedCreatorProjectSourcePath(path)) {
    throw new ProjectContextIndexError(
      'PROJECT_CONTEXT_SCAN_FAILED',
      'Agent Package Creator source projection received a forbidden path.',
    );
  }
  return join(root, ...path.split('/'));
}

function compareEntryDepth(left: ProjectContextEntry, right: ProjectContextEntry): number {
  const depth = left.path.split('/').length - right.path.split('/').length;
  return depth === 0 ? compareStrings(left.path, right.path) : depth;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sourceChanged(): ProjectContextIndexError {
  return new ProjectContextIndexError(
    'PROJECT_CONTEXT_CHANGED',
    'Project context changed while the Creator Host projection was being materialized.',
  );
}

function removeProjection(root: string, expected: BigIntStats): void {
  const actual = lstatSync(root, { bigint: true });
  if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new TypeError('Creator source projection root changed unexpectedly.');
  }
  const directories = [root];
  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index]!;
    chmodSync(directory, 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        directories.push(join(directory, entry.name));
      }
    }
  }
  rmSync(root, { recursive: true, force: false });
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
