import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import {
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix, relative } from 'node:path';

import {
  CREATOR_AGENT_PACKAGE_FILENAME,
  CREATOR_AGENT_PACKAGE_MAX_MANIFEST_BYTES,
  digestCreatorAgentPackage,
  digestCreatorAgentPackageFile,
  parseCreatorAgentPackageManifest,
  type CreatorAgentPackageDigest,
  type CreatorAgentPackageManifest,
} from '@cb/creator-agent-protocol/agent-package';

const MAX_DIRECTORY_ENTRIES = 512;
const MAX_TOTAL_BYTES = 8 * 1_024 * 1_024;

export type CreatorAgentPackageLoadErrorCode = 'AGENT_PACKAGE_INVALID' | 'AGENT_PACKAGE_IO';

export class CreatorAgentPackageLoadError extends Error {
  public constructor(
    public readonly code: CreatorAgentPackageLoadErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CreatorAgentPackageLoadError';
  }
}

export type LoadedCreatorAgentPackageSkill = Readonly<{
  name: string;
  path: string;
}>;

export type LoadedCreatorAgentPackage = Readonly<{
  root: string;
  manifest: CreatorAgentPackageManifest;
  packageDigest: CreatorAgentPackageDigest;
  instructions: string;
  skillsRoot?: string;
  skills: readonly LoadedCreatorAgentPackageSkill[];
  release(): void;
}>;

export function loadCreatorAgentPackage(rawDirectory: string): LoadedCreatorAgentPackage {
  try {
    const root = canonicalPackageRoot(rawDirectory);
    const tree = enumeratePackage(root);
    const manifestPath = join(root, CREATOR_AGENT_PACKAGE_FILENAME);
    if (!tree.files.has(CREATOR_AGENT_PACKAGE_FILENAME)) {
      throw invalid('Agent Package is missing agent.json.');
    }
    const manifestBytes = readStableFile(manifestPath, CREATOR_AGENT_PACKAGE_MAX_MANIFEST_BYTES);
    const manifestText = decodeUtf8(manifestBytes, 'agent.json');
    const manifest = parseCreatorAgentPackageManifest(manifestText);
    assertExactTree(tree, manifest);

    let totalBytes = 0;
    let instructions = '';
    const resources = new Map<string, Buffer>();
    for (const file of manifest.files) {
      totalBytes += file.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) throw invalid('Agent Package exceeds its byte limit.');
      const bytes = readStableFile(join(root, ...file.path.split('/')), file.byteLength);
      if (
        bytes.byteLength !== file.byteLength ||
        digestCreatorAgentPackageFile(bytes) !== file.digest
      ) {
        throw invalid(`Agent Package resource does not match its manifest: ${file.path}`);
      }
      resources.set(file.path, bytes);
      if (file.path === manifest.instructions) {
        instructions = decodeMarkdown(bytes, file.path);
      } else if (manifest.skills.includes(file.path)) {
        decodeMarkdown(bytes, file.path);
      }
    }
    if (!instructions) throw invalid('Agent Package AGENT.md is empty.');

    const runtimeRoot = materializeRuntimeSnapshot(manifestBytes, resources);
    let released = false;
    const release = (): void => {
      if (released) return;
      removeRuntimeSnapshot(runtimeRoot);
      released = true;
    };
    const skills = Object.freeze(
      manifest.skills.map((path) =>
        Object.freeze({
          name: path.split('/')[1]!,
          path: join(runtimeRoot, ...path.split('/')),
        }),
      ),
    );
    return Object.freeze({
      root: runtimeRoot,
      manifest,
      packageDigest: digestCreatorAgentPackage(manifest),
      instructions,
      ...(skills.length === 0 ? {} : { skillsRoot: join(runtimeRoot, 'skills') }),
      skills,
      release,
    });
  } catch (error) {
    if (error instanceof CreatorAgentPackageLoadError) throw error;
    if (error instanceof TypeError) {
      throw invalid('Agent Package failed strict validation.', error);
    }
    throw new CreatorAgentPackageLoadError(
      'AGENT_PACKAGE_IO',
      'Agent Package could not be read safely.',
      { cause: error },
    );
  }
}

function materializeRuntimeSnapshot(
  manifestBytes: Uint8Array,
  resources: ReadonlyMap<string, Uint8Array>,
): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'combo-agent-package-runtime-')));
  try {
    chmodSync(root, 0o700);
    const directories = new Set<string>();
    for (const path of resources.keys()) {
      let parent = posix.dirname(path);
      while (parent !== '.') {
        directories.add(parent);
        parent = posix.dirname(parent);
      }
    }
    const orderedDirectories = [...directories].sort((left, right) => {
      const depth = left.split('/').length - right.split('/').length;
      return depth === 0 ? left.localeCompare(right) : depth;
    });
    for (const directory of orderedDirectories) {
      mkdirSync(join(root, ...directory.split('/')), { mode: 0o700 });
    }
    writePrivateResource(join(root, CREATOR_AGENT_PACKAGE_FILENAME), manifestBytes);
    for (const [path, bytes] of resources) {
      writePrivateResource(join(root, ...path.split('/')), bytes);
    }
    for (const directory of orderedDirectories.reverse()) {
      chmodSync(join(root, ...directory.split('/')), 0o500);
    }
    chmodSync(root, 0o500);
    return root;
  } catch (error) {
    try {
      removeRuntimeSnapshot(root);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Agent Package snapshot creation and cleanup both failed.',
      );
    }
    throw error;
  }
}

function writePrivateResource(path: string, bytes: Uint8Array): void {
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o400 });
  chmodSync(path, 0o400);
}

function removeRuntimeSnapshot(root: string): void {
  if (!lstatSync(root).isDirectory()) {
    throw new TypeError('Agent Package runtime snapshot root changed unexpectedly.');
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

type PackageTree = Readonly<{
  files: ReadonlyMap<string, bigint>;
  directories: ReadonlySet<string>;
}>;

function canonicalPackageRoot(input: string): string {
  if (typeof input !== 'string' || !input || input.length > 2_048 || !isAbsolute(input)) {
    throw invalid('Agent Package path must be an absolute directory path.');
  }
  const root = realpathSync(input);
  if (!statSync(root).isDirectory()) throw invalid('Agent Package path is not a directory.');
  return root;
}

function enumeratePackage(root: string): PackageTree {
  const files = new Map<string, bigint>();
  const directories = new Set<string>();
  const pending = [''];
  let entries = 0;
  while (pending.length > 0) {
    const parent = pending.pop()!;
    const absoluteParent = parent ? join(root, ...parent.split('/')) : root;
    const before = lstatSync(absoluteParent, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw invalid('Agent Package contains an unsafe directory.');
    }
    const names = readdirSync(absoluteParent).sort();
    for (const name of names) {
      entries += 1;
      if (
        entries > MAX_DIRECTORY_ENTRIES ||
        !name ||
        name.includes('/') ||
        name === '.' ||
        name === '..'
      ) {
        throw invalid('Agent Package directory exceeds its structural limit.');
      }
      const path = parent ? `${parent}/${name}` : name;
      const absolute = join(root, ...path.split('/'));
      assertInside(root, absolute);
      const stat = lstatSync(absolute, { bigint: true });
      if (stat.isSymbolicLink()) throw invalid(`Agent Package contains a symbolic link: ${path}`);
      if (stat.isDirectory()) {
        directories.add(path);
        pending.push(path);
      } else if (stat.isFile()) {
        files.set(path, stat.size);
      } else {
        throw invalid(`Agent Package contains a non-regular file: ${path}`);
      }
    }
    const after = lstatSync(absoluteParent, { bigint: true });
    if (!sameDirectory(before, after)) {
      throw invalid('Agent Package directory changed while it was being inspected.');
    }
  }
  return Object.freeze({ files, directories });
}

function assertExactTree(tree: PackageTree, manifest: CreatorAgentPackageManifest): void {
  const expectedFiles = new Set<string>([
    CREATOR_AGENT_PACKAGE_FILENAME,
    ...manifest.files.map((file) => file.path),
  ]);
  const expectedDirectories = new Set<string>();
  for (const path of manifest.files.map((file) => file.path)) {
    let directory = posix.dirname(path);
    while (directory !== '.') {
      expectedDirectories.add(directory);
      directory = posix.dirname(directory);
    }
  }
  if (!sameStringSet(expectedFiles, new Set(tree.files.keys()))) {
    throw invalid('Agent Package files do not exactly match agent.json.');
  }
  if (!sameStringSet(expectedDirectories, tree.directories)) {
    throw invalid('Agent Package directories do not exactly match agent.json.');
  }
  for (const file of manifest.files) {
    if (tree.files.get(file.path) !== BigInt(file.byteLength)) {
      throw invalid(`Agent Package resource length does not match agent.json: ${file.path}`);
    }
  }
}

function readStableFile(path: string, maximumBytes: number): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maximumBytes)) {
      throw invalid('Agent Package file exceeds its byte limit.');
    }
    const expectedBytes = Number(before.size);
    const bytes = Buffer.alloc(expectedBytes);
    let offset = 0;
    while (offset < expectedBytes) {
      const count = readSync(descriptor, bytes, offset, expectedBytes - offset, offset);
      if (count === 0) throw invalid('Agent Package file changed while it was being read.');
      offset += count;
    }
    const overflow = Buffer.alloc(1);
    if (readSync(descriptor, overflow, 0, 1, expectedBytes) !== 0) {
      throw invalid('Agent Package file changed while it was being read.');
    }
    const after = fstatSync(descriptor, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    if (
      BigInt(bytes.byteLength) !== before.size ||
      !sameFile(before, after) ||
      !sameFile(after, current)
    ) {
      throw invalid('Agent Package file changed while it was being read.');
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw invalid(`Agent Package ${label} is not valid UTF-8.`, error);
  }
}

function decodeMarkdown(bytes: Uint8Array, label: string): string {
  const text = decodeUtf8(bytes, label);
  if (!text || text.charCodeAt(0) === 0xfeff || /\0/u.test(text)) {
    throw invalid(`Agent Package ${label} is not safe Markdown.`);
  }
  return text;
}

function sameDirectory(left: BigIntStats, right: BigIntStats): boolean {
  return (
    right.isDirectory() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs
  );
}

function assertInside(root: string, path: string): void {
  const child = relative(root, path);
  if (!child || child === '..' || child.startsWith(`..${posix.sep}`) || isAbsolute(child)) {
    throw invalid('Agent Package path escaped its root.');
  }
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function invalid(message: string, cause?: unknown): CreatorAgentPackageLoadError {
  return new CreatorAgentPackageLoadError('AGENT_PACKAGE_INVALID', message, { cause });
}
