import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';

import { inspectTextContent } from './content-policy.js';
import { sha256Hex } from './digest.js';
import { fail } from './errors.js';
import { SnapshotPathRegistry, utf8ByteCompare } from './path-policy.js';
import { ALPHA_SNAPSHOT_POLICY } from './policy.js';

const filenameDecoder = new TextDecoder('utf-8', { fatal: true });

type StableStat = Readonly<{
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  size: bigint;
  blocks: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

function stableStat(value: unknown): StableStat {
  const candidate = value as unknown as {
    dev: bigint;
    ino: bigint;
    mode: bigint;
    nlink: bigint;
    size: bigint;
    blocks: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  };
  return {
    dev: candidate.dev,
    ino: candidate.ino,
    mode: candidate.mode,
    nlink: candidate.nlink,
    size: candidate.size,
    blocks: candidate.blocks,
    mtimeNs: candidate.mtimeNs,
    ctimeNs: candidate.ctimeNs,
  };
}

async function bigLstat(path: string) {
  return lstat(path, { bigint: true });
}

function sameIdentity(left: StableStat, right: StableStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.blocks === right.blocks &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertNotSparse(file: StableStat): void {
  if (file.size > 0n && file.blocks * 512n < file.size) fail('SNAPSHOT_SPARSE_FILE_FORBIDDEN');
}

function isInside(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === '' ||
    (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference))
  );
}

function sourceRelativePath(relativeSegments: readonly string[]): string {
  return relativeSegments.join('/');
}

export type StagedSnapshotFile = Readonly<{
  path: string;
  size: number;
  mediaType: string;
  sha256: string;
}>;

export type StagedProject = Readonly<{
  root: string;
  files: readonly StagedSnapshotFile[];
  cleanup: () => Promise<void>;
}>;

export type StagingBoundary = Readonly<{
  phase:
    | 'before-root-copy'
    | 'after-directory-enumeration'
    | 'after-file-stat'
    | 'after-file-read-chunk'
    | 'after-file-read';
  relativePath: string;
  bytesRead?: number;
}>;

export type StageProjectOptions = Readonly<{
  onBoundary?: (boundary: StagingBoundary) => void | Promise<void>;
}>;

async function decodeFilename(name: Buffer | string): Promise<string> {
  if (typeof name === 'string') {
    if (name.includes('\ufffd')) fail('SNAPSHOT_UTF8_REQUIRED');
    return name;
  }
  try {
    return filenameDecoder.decode(name);
  } catch (error) {
    fail('SNAPSHOT_UTF8_REQUIRED', error);
  }
}

export async function stageProject(
  projectRootInput: string,
  options: StageProjectOptions = {},
): Promise<StagedProject> {
  const requestedRoot = resolve(projectRootInput);
  const requestedInfo = await bigLstat(requestedRoot).catch((error: unknown) => {
    fail('SNAPSHOT_WRONG_FILE_TYPE', error);
  });
  if (requestedInfo.isSymbolicLink()) fail('SNAPSHOT_SYMLINK_FORBIDDEN');
  if (!requestedInfo.isDirectory()) fail('SNAPSHOT_WRONG_FILE_TYPE');
  const requestedStable = stableStat(requestedInfo);

  const projectRoot = await realpath(requestedRoot).catch((error: unknown) => {
    fail('SNAPSHOT_SOURCE_CHANGED', error);
  });
  const canonicalRootInfo = await bigLstat(projectRoot).catch((error: unknown) => {
    fail('SNAPSHOT_SOURCE_CHANGED', error);
  });
  if (!sameIdentity(requestedStable, stableStat(canonicalRootInfo))) {
    fail('SNAPSHOT_SOURCE_CHANGED');
  }
  const stagingRoot = await mkdtemp(join(tmpdir(), 'combo-vnext-snapshot-'));
  await chmod(stagingRoot, 0o700);
  const files: StagedSnapshotFile[] = [];
  const paths = new SnapshotPathRegistry();
  let expandedBytes = 0;

  const cleanup = async (): Promise<void> => {
    await chmod(stagingRoot, 0o700).catch(() => undefined);
    await rm(stagingRoot, { recursive: true, force: true });
  };

  const copyDirectory = async (
    sourceDirectory: string,
    segments: readonly string[],
  ): Promise<void> => {
    const beforeLstat = await bigLstat(sourceDirectory).catch((error: unknown) => {
      fail('SNAPSHOT_SOURCE_CHANGED', error);
    });
    if (segments.length === 0 && !sameIdentity(requestedStable, stableStat(beforeLstat))) {
      fail('SNAPSHOT_SOURCE_CHANGED');
    }
    if (beforeLstat.isSymbolicLink()) fail('SNAPSHOT_SYMLINK_FORBIDDEN');
    if (!beforeLstat.isDirectory()) fail('SNAPSHOT_SOURCE_CHANGED');
    const before = stableStat(beforeLstat);
    const canonicalDirectory = await realpath(sourceDirectory).catch((error: unknown) => {
      fail('SNAPSHOT_SOURCE_CHANGED', error);
    });
    if (!isInside(projectRoot, canonicalDirectory)) fail('SNAPSHOT_SYMLINK_FORBIDDEN');

    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(sourceDirectory, { withFileTypes: true, encoding: 'buffer' });
    } catch (error) {
      fail('SNAPSHOT_SOURCE_CHANGED', error);
    }
    const decodedEntries = await Promise.all(
      entries.map(async (entry) => ({ entry, name: await decodeFilename(entry.name) })),
    );
    decodedEntries.sort((left, right) => utf8ByteCompare(left.name, right.name));
    await options.onBoundary?.({
      phase: 'after-directory-enumeration',
      relativePath: sourceRelativePath(segments),
    });
    if (!sameIdentity(before, stableStat(await bigLstat(sourceDirectory)))) {
      fail('SNAPSHOT_SOURCE_CHANGED');
    }

    for (const { name } of decodedEntries) {
      if (name === '.' || name === '..' || name.includes('/')) fail('SNAPSHOT_INVALID_PATH');
      const sourcePath = join(sourceDirectory, name);
      const relativeSegments = [...segments, name];
      const sourceRelative = sourceRelativePath(relativeSegments);
      const canonicalRelative = paths.add(sourceRelative);
      const sourceInfo = await bigLstat(sourcePath).catch((error: unknown) => {
        fail('SNAPSHOT_SOURCE_CHANGED', error);
      });

      if (sourceInfo.isSymbolicLink()) fail('SNAPSHOT_SYMLINK_FORBIDDEN');
      if (sourceInfo.isDirectory()) {
        await mkdir(join(stagingRoot, ...canonicalRelative.split('/')), { mode: 0o700 });
        await copyDirectory(sourcePath, relativeSegments);
        continue;
      }
      if (!sourceInfo.isFile()) fail('SNAPSHOT_SPECIAL_FILE_FORBIDDEN');

      if (sourceInfo.nlink !== 1n) fail('SNAPSHOT_HARDLINK_FORBIDDEN');
      const sourceStable = stableStat(sourceInfo);
      const canonicalFile = await realpath(sourcePath).catch((error: unknown) => {
        fail('SNAPSHOT_SOURCE_CHANGED', error);
      });
      if (!isInside(projectRoot, canonicalFile)) fail('SNAPSHOT_SYMLINK_FORBIDDEN');
      if (!sameIdentity(sourceStable, stableStat(await bigLstat(canonicalFile)))) {
        fail('SNAPSHOT_SOURCE_CHANGED');
      }
      assertNotSparse(sourceStable);
      if (sourceStable.size > BigInt(ALPHA_SNAPSHOT_POLICY.maxFileBytes)) {
        fail('SNAPSHOT_FILE_TOO_LARGE');
      }
      if (files.length >= ALPHA_SNAPSHOT_POLICY.maxFileCount) fail('SNAPSHOT_TOO_MANY_FILES');
      expandedBytes += Number(sourceStable.size);
      if (expandedBytes > ALPHA_SNAPSHOT_POLICY.maxExpandedBytes) {
        fail('SNAPSHOT_EXPANDED_TOO_LARGE');
      }
      await options.onBoundary?.({ phase: 'after-file-stat', relativePath: canonicalRelative });
      if (!sameIdentity(before, stableStat(await bigLstat(sourceDirectory)))) {
        fail('SNAPSHOT_SOURCE_CHANGED');
      }

      let sourceHandle;
      try {
        sourceHandle = await open(
          sourcePath,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
      } catch (error) {
        fail('SNAPSHOT_SOURCE_CHANGED', error);
      }
      let bytes: Buffer;
      try {
        const openedBefore = stableStat(await sourceHandle.stat({ bigint: true }));
        if (!sameIdentity(sourceStable, openedBefore)) fail('SNAPSHOT_SOURCE_CHANGED');
        bytes = Buffer.alloc(Number(openedBefore.size));
        let totalBytesRead = 0;
        while (totalBytesRead < bytes.byteLength) {
          const chunkLength = Math.min(64 * 1024, bytes.byteLength - totalBytesRead);
          const result = await sourceHandle.read(
            bytes,
            totalBytesRead,
            chunkLength,
            totalBytesRead,
          );
          if (result.bytesRead <= 0) fail('SNAPSHOT_SOURCE_CHANGED');
          totalBytesRead += result.bytesRead;
          await options.onBoundary?.({
            phase: 'after-file-read-chunk',
            relativePath: canonicalRelative,
            bytesRead: totalBytesRead,
          });
        }
        await options.onBoundary?.({ phase: 'after-file-read', relativePath: canonicalRelative });
        const openedAfter = stableStat(await sourceHandle.stat({ bigint: true }));
        if (
          !sameIdentity(openedBefore, openedAfter) ||
          bytes.byteLength !== Number(openedAfter.size)
        ) {
          fail('SNAPSHOT_SOURCE_CHANGED');
        }
      } finally {
        await sourceHandle.close().catch(() => undefined);
      }

      const inspected = inspectTextContent(canonicalRelative, bytes);
      const destination = join(stagingRoot, ...canonicalRelative.split('/'));
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      let destinationHandle;
      try {
        destinationHandle = await open(
          destination,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        await destinationHandle.writeFile(bytes);
        await destinationHandle.sync();
        await destinationHandle.chmod(0o444);
      } catch (error) {
        fail('SNAPSHOT_SOURCE_CHANGED', error);
      } finally {
        await destinationHandle?.close().catch(() => undefined);
      }
      files.push(
        Object.freeze({
          path: canonicalRelative,
          size: bytes.byteLength,
          mediaType: inspected.mediaType,
          sha256: sha256Hex(bytes),
        }),
      );
    }

    const after = stableStat(
      await bigLstat(sourceDirectory).catch((error: unknown) => {
        fail('SNAPSHOT_SOURCE_CHANGED', error);
      }),
    );
    if (!sameIdentity(before, after)) fail('SNAPSHOT_SOURCE_CHANGED');
  };

  try {
    await options.onBoundary?.({ phase: 'before-root-copy', relativePath: '' });
    await copyDirectory(projectRoot, []);
    if (files.length === 0) fail('SNAPSHOT_EMPTY');
    files.sort((left, right) => utf8ByteCompare(left.path, right.path));
    return Object.freeze({ root: stagingRoot, files: Object.freeze(files), cleanup });
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function readStagedProject(
  staged: StagedProject,
): Promise<readonly ArchiveFileWithMetadata[]> {
  const output: ArchiveFileWithMetadata[] = [];
  for (const expected of staged.files) {
    const stagedPath = join(staged.root, ...expected.path.split('/'));
    const info = await bigLstat(stagedPath).catch((error: unknown) => {
      fail('SNAPSHOT_SOURCE_CHANGED', error);
    });
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1n ||
      (info.mode & 0o777n) !== 0o444n
    ) {
      fail('SNAPSHOT_SOURCE_CHANGED');
    }
    const expectedIdentity = stableStat(info);
    const handle = await open(stagedPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
      (error: unknown) => {
        fail('SNAPSHOT_SOURCE_CHANGED', error);
      },
    );
    let bytes: Buffer;
    try {
      const openedBefore = stableStat(await handle.stat({ bigint: true }));
      if (!sameIdentity(expectedIdentity, openedBefore)) fail('SNAPSHOT_SOURCE_CHANGED');
      bytes = await handle.readFile();
      const openedAfter = stableStat(await handle.stat({ bigint: true }));
      if (!sameIdentity(openedBefore, openedAfter)) fail('SNAPSHOT_SOURCE_CHANGED');
    } finally {
      await handle.close().catch(() => undefined);
    }
    if (
      bytes.byteLength !== expected.size ||
      sha256Hex(bytes) !== expected.sha256 ||
      inspectTextContent(expected.path, bytes).mediaType !== expected.mediaType
    ) {
      fail('SNAPSHOT_SOURCE_CHANGED');
    }
    output.push(Object.freeze({ ...expected, bytes }));
  }
  return Object.freeze(output);
}

export type ArchiveFileWithMetadata = StagedSnapshotFile & Readonly<{ bytes: Buffer }>;
