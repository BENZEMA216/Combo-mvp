import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  readlinkSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

const MAX_INDEX_ENTRIES = 500_000;
const MAX_UNIQUE_INDEX_BYTES = 32 * 1024 * 1024 * 1024;
const MAX_SENSITIVE_FILE_BYTES = 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024;
const READ_BUFFER_BYTES = 128 * 1024;

export type ProjectContextEntryKind = 'directory' | 'file' | 'symlink' | 'special';
export type ProjectContextCategory =
  | 'configuration'
  | 'documentation'
  | 'git'
  | 'log'
  | 'secret_candidate'
  | 'source'
  | 'task_record'
  | 'other';
export type ProjectContextGitClass =
  | 'TRACKED_CLEAN'
  | 'TRACKED_DIRTY'
  | 'UNTRACKED'
  | 'IGNORED'
  | 'GIT_ADMIN'
  | 'NA';

export type ProjectContextEntry = Readonly<{
  path: string;
  kind: ProjectContextEntryKind;
  category: ProjectContextCategory;
  gitClass: ProjectContextGitClass;
  hidden: boolean;
  executionAvailability: 'FIXED_GIT_TREE' | 'AUTHORING_ONLY';
  mode: number;
  modifiedAtMs: number;
  changedAtMs: number;
  sizeBytes: number;
  digest: `sha256:${string}`;
}>;

export type ProjectContextIndex = Readonly<{
  protocol: 'combo.creator-agent-project-context-index/1';
  rootDigest: `sha256:${string}`;
  entryCount: number;
  fileCount: number;
  /** Sum of every regular-file path, including hardlink aliases. */
  byteCount: number;
  /** Sum of unique regular-file inodes actually hashed. */
  uniqueByteCount: number;
  hardlinkAliasCount: number;
  categories: Readonly<Record<ProjectContextCategory, number>>;
  coverage: Readonly<{
    indexedEntryCount: number;
    indexedFileCount: number;
    indexedByteCount: number;
    hiddenEntryCount: number;
    trackedEntryCount: number;
    untrackedEntryCount: number;
    ignoredEntryCount: number;
    gitAdminEntryCount: number;
    authoringOnlyEntryCount: number;
  }>;
  entries: readonly ProjectContextEntry[];
}>;

export type ProjectContextScan = Readonly<{
  projectPath: string;
  index: ProjectContextIndex;
  /** In-memory only. Never serialize this set into an Agent Draft or index file. */
  sensitiveLiterals: ReadonlySet<string>;
}>;

export type ProjectContextIndexErrorCode =
  | 'PROJECT_CONTEXT_PATH_INVALID'
  | 'PROJECT_CONTEXT_SCAN_FAILED'
  | 'PROJECT_CONTEXT_SCAN_LIMIT'
  | 'PROJECT_CONTEXT_CHANGED';

type ProjectContextIndexHooks = Readonly<{
  beforeDirectoryRead?: (relativePath: string) => void;
  afterFileOpened?: (relativePath: string) => void;
  maximumEntries?: number;
  maximumUniqueBytes?: number;
}>;

export class ProjectContextIndexError extends Error {
  public constructor(
    public readonly code: ProjectContextIndexErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProjectContextIndexError';
  }
}

export function scanProjectContext(rawProjectPath: string): ProjectContextScan {
  return scanProjectContextWithHooks(rawProjectPath, {});
}

/** Internal race-test seam; intentionally absent from the package root export. */
export function scanProjectContextWithHooks(
  rawProjectPath: string,
  hooks: ProjectContextIndexHooks,
): ProjectContextScan {
  const projectPath = canonicalProjectPath(rawProjectPath);
  const maximumEntries = hooks.maximumEntries ?? MAX_INDEX_ENTRIES;
  const maximumUniqueBytes = hooks.maximumUniqueBytes ?? MAX_UNIQUE_INDEX_BYTES;
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
    throw new ProjectContextIndexError(
      'PROJECT_CONTEXT_SCAN_LIMIT',
      'Project context entry limit is invalid.',
    );
  }
  if (!Number.isSafeInteger(maximumUniqueBytes) || maximumUniqueBytes < 1) {
    throw new ProjectContextIndexError(
      'PROJECT_CONTEXT_SCAN_LIMIT',
      'Project context byte limit is invalid.',
    );
  }
  const entries: ProjectContextEntry[] = [];
  const sensitiveLiterals = new Set<string>();
  const hardlinks = new Map<
    string,
    Readonly<{ content: ReturnType<typeof hashFile>; stat: Stats }>
  >();
  const gitClassification = readGitClassification(projectPath);
  const rootStat = lstatSync(projectPath);
  const pending: Array<
    Readonly<{ logicalParent: string; absoluteParent: string; expected: Stats }>
  > = [{ logicalParent: '', absoluteParent: projectPath, expected: rootStat }];
  let byteCount = 0;
  let uniqueByteCount = 0;
  let hardlinkAliasCount = 0;
  let fileCount = 0;

  while (pending.length > 0) {
    const parent = pending.pop();
    if (parent === undefined) break;
    const { logicalParent, absoluteParent, expected } = parent;
    hooks.beforeDirectoryRead?.(logicalParent);
    const names = readStableDirectoryNames(
      absoluteParent,
      expected,
      maximumEntries - entries.length,
    );
    for (const name of names) {
      if (entries.length >= maximumEntries) {
        throw new ProjectContextIndexError(
          'PROJECT_CONTEXT_SCAN_LIMIT',
          'Project context exceeds the bounded full-index limit.',
        );
      }
      assertDirectoryPathStable(absoluteParent, expected);
      const path = logicalParent.length === 0 ? name : `${logicalParent}/${name}`;
      const absolute = join(absoluteParent, name);
      let stat: Stats;
      try {
        stat = lstatSync(absolute);
      } catch (error) {
        throw indexError('PROJECT_CONTEXT_SCAN_FAILED', error);
      }
      const category = classify(path);
      let entry: ProjectContextEntry;
      if (stat.isDirectory()) {
        const gitClass = classifyGitPath(path, gitClassification);
        entry = projectEntry(path, 'directory', category, gitClass, stat, digestText('directory'));
        pending.push({ logicalParent: path, absoluteParent: absolute, expected: stat });
      } else if (stat.isFile()) {
        const hardlinkKey = `${stat.dev}:${stat.ino}`;
        const cached = hardlinks.get(hardlinkKey);
        let content: ReturnType<typeof hashFile>;
        if (cached === undefined) {
          if (stat.size > maximumUniqueBytes - uniqueByteCount) {
            throw new ProjectContextIndexError(
              'PROJECT_CONTEXT_SCAN_LIMIT',
              'Project context exceeds the bounded unique-content limit.',
            );
          }
          content = hashFile(absolute, stat, isSensitiveCandidate(path), () =>
            hooks.afterFileOpened?.(path),
          );
          hardlinks.set(hardlinkKey, Object.freeze({ content, stat: content.stableStat }));
          uniqueByteCount += stat.size;
        } else {
          assertSameFile(cached.stat, stat);
          hardlinkAliasCount += 1;
          content = cached.content;
          if (isSensitiveCandidate(path) && content.sensitiveText === undefined) {
            content = hashFile(absolute, stat, true, () => hooks.afterFileOpened?.(path));
            hardlinks.set(hardlinkKey, Object.freeze({ content, stat: content.stableStat }));
          }
        }
        const stableStat = content.stableStat;
        const gitClass = classifyGitPath(path, gitClassification, {
          mode: stableStat.mode & 0o111 ? '100755' : '100644',
          objectId: content.gitBlobSha,
        });
        byteCount += stableStat.size;
        if (!Number.isSafeInteger(byteCount)) {
          throw new ProjectContextIndexError(
            'PROJECT_CONTEXT_SCAN_LIMIT',
            'Project context logical byte count exceeds the supported range.',
          );
        }
        fileCount += 1;
        if (content.sensitiveText !== undefined) {
          collectSensitiveLiterals(content.sensitiveText, sensitiveLiterals);
        }
        entry = projectEntry(path, 'file', category, gitClass, stableStat, content.digest);
      } else if (stat.isSymbolicLink()) {
        let target: string;
        try {
          target = readlinkSync(absolute);
        } catch (error) {
          throw indexError('PROJECT_CONTEXT_SCAN_FAILED', error);
        }
        const targetBytes = Buffer.from(target, 'utf8');
        const gitClass = classifyGitPath(path, gitClassification, {
          mode: '120000',
          objectId: gitBlobSha(targetBytes),
        });
        entry = projectEntry(
          path,
          'symlink',
          category,
          gitClass,
          stat,
          digestText(`symlink\0${target}`),
        );
      } else {
        throw new ProjectContextIndexError(
          'PROJECT_CONTEXT_SCAN_FAILED',
          'Project contains a special file whose content cannot be indexed safely.',
        );
      }
      entries.push(entry);
      assertDirectoryPathStable(absoluteParent, expected);
      if (uniqueByteCount > maximumUniqueBytes) {
        throw new ProjectContextIndexError(
          'PROJECT_CONTEXT_SCAN_LIMIT',
          'Project context exceeds the bounded full-index limit.',
        );
      }
    }
  }

  entries.sort((left, right) => compareStrings(left.path, right.path));
  const categories = categoryCounts(entries);
  const coverage = coverageCounts(entries, fileCount, byteCount);
  const rootHash = createHash('sha256');
  rootHash.update('combo.creator-agent-project-context-index/1\0');
  rootHash.update(`root\0${rootStat.mode & 0o7777}\0${rootStat.mtimeMs}\0${rootStat.ctimeMs}\n`);
  for (const entry of entries) {
    rootHash.update(
      `${entry.path}\0${entry.kind}\0${entry.category}\0${entry.gitClass}\0${entry.hidden}\0${entry.executionAvailability}\0${entry.mode}\0${entry.modifiedAtMs}\0${entry.changedAtMs}\0${entry.sizeBytes}\0${entry.digest}\n`,
    );
  }
  const index = deepFreeze({
    protocol: 'combo.creator-agent-project-context-index/1' as const,
    rootDigest: `sha256:${rootHash.digest('hex')}` as const,
    entryCount: entries.length,
    fileCount,
    byteCount,
    uniqueByteCount,
    hardlinkAliasCount,
    categories,
    coverage,
    entries,
  });
  return Object.freeze({
    projectPath,
    index,
    sensitiveLiterals: Object.freeze(sensitiveLiterals),
  });
}

function readStableDirectoryNames(
  path: string,
  expected: Stats,
  remainingEntryBudget: number,
): string[] {
  let descriptor: number | undefined;
  let directory: ReturnType<typeof opendirSync> | undefined;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
    );
    assertSameDirectory(expected, fstatSync(descriptor));
    directory = opendirSync(path);
    assertSameDirectory(expected, lstatSync(path));
    const names: string[] = [];
    while (true) {
      const entry = directory.readSync();
      if (entry === null) break;
      if (names.length >= remainingEntryBudget) {
        throw new ProjectContextIndexError(
          'PROJECT_CONTEXT_SCAN_LIMIT',
          'Project context exceeds the bounded full-index limit.',
        );
      }
      names.push(entry.name);
    }
    assertSameDirectory(expected, fstatSync(descriptor));
    assertSameDirectory(expected, lstatSync(path));
    return names.sort(compareStrings);
  } catch (error) {
    if (error instanceof ProjectContextIndexError) throw error;
    throw indexError('PROJECT_CONTEXT_SCAN_FAILED', error);
  } finally {
    if (directory !== undefined) directory.closeSync();
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertSameDirectory(expected: Stats, actual: Stats): void {
  if (
    !actual.isDirectory() ||
    expected.dev !== actual.dev ||
    expected.ino !== actual.ino ||
    expected.mode !== actual.mode ||
    expected.mtimeMs !== actual.mtimeMs ||
    expected.ctimeMs !== actual.ctimeMs
  ) {
    throw new ProjectContextIndexError(
      'PROJECT_CONTEXT_CHANGED',
      'A Project directory changed while it was being indexed.',
    );
  }
}

function assertDirectoryPathStable(path: string, expected: Stats): void {
  try {
    assertSameDirectory(expected, lstatSync(path));
  } catch (error) {
    if (error instanceof ProjectContextIndexError) throw error;
    throw indexError('PROJECT_CONTEXT_SCAN_FAILED', error);
  }
}

export function assertSameProjectContext(
  before: ProjectContextIndex,
  after: ProjectContextIndex,
): void {
  if (
    before.rootDigest !== after.rootDigest ||
    before.entryCount !== after.entryCount ||
    before.fileCount !== after.fileCount ||
    before.byteCount !== after.byteCount ||
    before.uniqueByteCount !== after.uniqueByteCount ||
    before.hardlinkAliasCount !== after.hardlinkAliasCount
  ) {
    throw new ProjectContextIndexError(
      'PROJECT_CONTEXT_CHANGED',
      'Project context changed while the Agent Draft was being compiled.',
    );
  }
}

function canonicalProjectPath(rawProjectPath: string): string {
  if (
    typeof rawProjectPath !== 'string' ||
    rawProjectPath.includes('\0') ||
    !isAbsolute(rawProjectPath) ||
    resolve(rawProjectPath) !== rawProjectPath
  ) {
    throw new ProjectContextIndexError(
      'PROJECT_CONTEXT_PATH_INVALID',
      'Project path must be canonical and absolute.',
    );
  }
  try {
    const projectPath = realpathSync(rawProjectPath);
    if (projectPath !== rawProjectPath || !statSync(projectPath).isDirectory()) {
      throw new TypeError('not a canonical directory');
    }
    return projectPath;
  } catch (error) {
    throw new ProjectContextIndexError(
      'PROJECT_CONTEXT_PATH_INVALID',
      'Project path is unavailable or unsafe.',
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

function hashFile(
  filename: string,
  expected: Stats,
  retainSensitiveText: boolean,
  afterOpen: () => void,
): Readonly<{
  digest: `sha256:${string}`;
  gitBlobSha: string;
  stableStat: Stats;
  sensitiveText?: string;
}> {
  if (retainSensitiveText && expected.size > MAX_SENSITIVE_FILE_BYTES) {
    throw new ProjectContextIndexError(
      'PROJECT_CONTEXT_SCAN_LIMIT',
      'A sensitive Project file exceeds the bounded inspection limit.',
    );
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    assertSameFile(expected, opened);
    afterOpen();
    const probe = Buffer.allocUnsafe(1);
    if (opened.size > 0 && readSync(descriptor, probe, 0, 1, 0) !== 1) {
      throw new ProjectContextIndexError(
        'PROJECT_CONTEXT_CHANGED',
        'A Project file changed while it was being indexed.',
      );
    }
    const stableStat = fstatSync(descriptor);
    assertSameFileExceptChangedAt(opened, stableStat);
    const hash = createHash('sha256');
    const gitHash = createHash('sha1');
    gitHash.update(`blob ${stableStat.size}\0`);
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    const retained: Buffer[] = [];
    let retainedBytes = 0;
    let bytesRead = 0;
    while (bytesRead < stableStat.size) {
      const requested = Math.min(buffer.length, stableStat.size - bytesRead);
      const read = readSync(descriptor, buffer, 0, requested, null);
      if (read === 0) {
        throw new ProjectContextIndexError(
          'PROJECT_CONTEXT_CHANGED',
          'A Project file changed while it was being indexed.',
        );
      }
      bytesRead += read;
      const chunk = buffer.subarray(0, read);
      hash.update(chunk);
      gitHash.update(chunk);
      if (retainSensitiveText && retainedBytes < MAX_SENSITIVE_FILE_BYTES) {
        const keep = Math.min(read, MAX_SENSITIVE_FILE_BYTES - retainedBytes);
        retained.push(Buffer.from(chunk.subarray(0, keep)));
        retainedBytes += keep;
      }
    }
    assertSameFile(stableStat, fstatSync(descriptor));
    const digest = `sha256:${hash.digest('hex')}` as const;
    const gitBlobSha = gitHash.digest('hex');
    const frozenStat = Object.freeze(stableStat);
    if (!retainSensitiveText || retained.length === 0) {
      return Object.freeze({ digest, gitBlobSha, stableStat: frozenStat });
    }
    const bytes = Buffer.concat(retained);
    if (bytes.includes(0)) {
      return Object.freeze({ digest, gitBlobSha, stableStat: frozenStat });
    }
    let sensitiveText: string;
    try {
      sensitiveText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return Object.freeze({ digest, gitBlobSha, stableStat: frozenStat });
    }
    return Object.freeze({ digest, gitBlobSha, stableStat: frozenStat, sensitiveText });
  } catch (error) {
    if (error instanceof ProjectContextIndexError) throw error;
    throw indexError('PROJECT_CONTEXT_SCAN_FAILED', error);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertSameFile(expected: Stats, actual: Stats): void {
  if (
    !actual.isFile() ||
    expected.dev !== actual.dev ||
    expected.ino !== actual.ino ||
    expected.size !== actual.size ||
    normalizedTimestamp(expected.mtimeMs) !== normalizedTimestamp(actual.mtimeMs) ||
    normalizedTimestamp(expected.ctimeMs) !== normalizedTimestamp(actual.ctimeMs) ||
    expected.mode !== actual.mode ||
    expected.uid !== actual.uid ||
    expected.gid !== actual.gid ||
    expected.nlink !== actual.nlink
  ) {
    throw new ProjectContextIndexError(
      'PROJECT_CONTEXT_CHANGED',
      'A Project file changed while it was being indexed.',
    );
  }
}

function assertSameFileExceptChangedAt(expected: Stats, actual: Stats): void {
  if (
    !actual.isFile() ||
    expected.dev !== actual.dev ||
    expected.ino !== actual.ino ||
    expected.size !== actual.size ||
    normalizedTimestamp(expected.mtimeMs) !== normalizedTimestamp(actual.mtimeMs) ||
    expected.mode !== actual.mode ||
    expected.uid !== actual.uid ||
    expected.gid !== actual.gid ||
    expected.nlink !== actual.nlink
  ) {
    throw new ProjectContextIndexError(
      'PROJECT_CONTEXT_CHANGED',
      'A Project file changed while it was being indexed.',
    );
  }
}

function projectEntry(
  path: string,
  kind: ProjectContextEntryKind,
  category: ProjectContextCategory,
  gitClass: ProjectContextGitClass,
  stat: Stats,
  digest: `sha256:${string}`,
): ProjectContextEntry {
  if (path.length === 0 || path.startsWith('/') || relative('/', `/${path}`) !== path) {
    throw new ProjectContextIndexError(
      'PROJECT_CONTEXT_SCAN_FAILED',
      'Project contains an unsafe relative path.',
    );
  }
  return Object.freeze({
    path,
    kind,
    category,
    gitClass,
    hidden: path.split('/').some((segment) => segment.startsWith('.')),
    executionAvailability: gitClass === 'TRACKED_CLEAN' ? 'FIXED_GIT_TREE' : 'AUTHORING_ONLY',
    mode: stat.mode & 0o7777,
    modifiedAtMs: normalizedTimestamp(stat.mtimeMs),
    changedAtMs: normalizedTimestamp(stat.ctimeMs),
    sizeBytes: stat.size,
    digest,
  });
}

function normalizedTimestamp(value: number): number {
  return Math.trunc(value);
}

function classify(path: string): ProjectContextCategory {
  const lower = path.toLowerCase();
  const name = basename(lower);
  if (
    lower === '.git' ||
    lower.startsWith('.git/') ||
    lower.endsWith('/.git') ||
    lower.includes('/.git/')
  ) {
    return 'git';
  }
  if (/(^|\/)(\.env(?:\.|$)|auth\.json$|\.npmrc$|\.pypirc$)/u.test(lower)) {
    return 'secret_candidate';
  }
  if (/(secret|credential|token|private[-_.]?key)/u.test(name)) return 'secret_candidate';
  if (/(^|\/)(task|tasks|session|sessions|thread|threads|rollout|rollouts)(\/|\.|$)/u.test(lower)) {
    return 'task_record';
  }
  if (/\.(log|jsonl|ndjson|trace)$/u.test(lower) || /(^|\/)logs?\//u.test(lower)) return 'log';
  if (/\.(md|mdx|rst|txt|pdf|docx?)$/u.test(lower) || /(^|\/)docs?\//u.test(lower)) {
    return 'documentation';
  }
  if (
    /(^|\/)(package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig[^/]*\.json|.*\.config\.[^/]+)$/u.test(
      lower,
    ) ||
    /\.(ya?ml|toml|ini|properties)$/u.test(lower)
  ) {
    return 'configuration';
  }
  if (
    /\.(?:[cm]?[jt]sx?|py|rb|rs|go|java|kt|swift|c|cc|cpp|h|hpp|sh|zsh|fish|sql|html|css)$/u.test(
      lower,
    )
  ) {
    return 'source';
  }
  return 'other';
}

function isSensitiveCandidate(path: string): boolean {
  return classify(path) === 'secret_candidate';
}

function collectSensitiveLiterals(text: string, output: Set<string>): void {
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    const candidate = (separator >= 0 ? line.slice(separator + 1) : line)
      .trim()
      .replace(/^['"]|['"]$/gu, '');
    if (candidate.length >= 8 && candidate.length <= 4_096) output.add(candidate);
  }
}

function categoryCounts(
  entries: readonly ProjectContextEntry[],
): Readonly<Record<ProjectContextCategory, number>> {
  const counts: Record<ProjectContextCategory, number> = {
    configuration: 0,
    documentation: 0,
    git: 0,
    log: 0,
    secret_candidate: 0,
    source: 0,
    task_record: 0,
    other: 0,
  };
  for (const entry of entries) counts[entry.category] += 1;
  return Object.freeze(counts);
}

function coverageCounts(
  entries: readonly ProjectContextEntry[],
  fileCount: number,
  byteCount: number,
): ProjectContextIndex['coverage'] {
  const count = (predicate: (entry: ProjectContextEntry) => boolean) =>
    entries.filter(predicate).length;
  return Object.freeze({
    indexedEntryCount: entries.length,
    indexedFileCount: fileCount,
    indexedByteCount: byteCount,
    hiddenEntryCount: count(({ hidden }) => hidden),
    trackedEntryCount: count(({ gitClass }) =>
      ['TRACKED_CLEAN', 'TRACKED_DIRTY'].includes(gitClass),
    ),
    untrackedEntryCount: count(({ gitClass }) => gitClass === 'UNTRACKED'),
    ignoredEntryCount: count(({ gitClass }) => gitClass === 'IGNORED'),
    gitAdminEntryCount: count(({ gitClass }) => gitClass === 'GIT_ADMIN'),
    authoringOnlyEntryCount: count(
      ({ executionAvailability }) => executionAvailability === 'AUTHORING_ONLY',
    ),
  });
}

type GitClassification = Readonly<{
  tracked: ReadonlyMap<string, Readonly<{ mode: string; objectId: string }>>;
  staged: ReadonlySet<string>;
  untracked: ReadonlySet<string>;
  ignored: ReadonlySet<string>;
}>;

function readGitClassification(projectPath: string): GitClassification {
  try {
    const insideWorktree = optionalGitOutput(projectPath, ['rev-parse', '--is-inside-work-tree']);
    if (insideWorktree?.trim() !== 'true') return emptyGitClassification();
    const root = optionalGitOutput(projectPath, ['rev-parse', '--show-toplevel']);
    if (root === undefined || realpathSync(root.trim()) !== projectPath) {
      return emptyGitClassification();
    }
    const hasHead =
      optionalGitOutput(projectPath, ['rev-parse', '--verify', 'HEAD^{commit}']) !== undefined;
    return Object.freeze({
      tracked: hasHead ? gitTreeEntries(projectPath) : new Map(),
      staged: gitIndexPaths(projectPath),
      untracked: gitPathSet(projectPath, ['ls-files', '--others', '--exclude-standard', '-z']),
      ignored: gitPathSet(projectPath, [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '-z',
      ]),
    });
  } catch (error) {
    throw indexError('PROJECT_CONTEXT_SCAN_FAILED', error);
  }
}

function emptyGitClassification(): GitClassification {
  return Object.freeze({
    tracked: new Map<string, Readonly<{ mode: string; objectId: string }>>(),
    staged: new Set<string>(),
    untracked: new Set<string>(),
    ignored: new Set<string>(),
  });
}

function gitTreeEntries(
  projectPath: string,
): ReadonlyMap<string, Readonly<{ mode: string; objectId: string }>> {
  const value = gitOutput(projectPath, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD']);
  const output = new Map<string, Readonly<{ mode: string; objectId: string }>>();
  for (const record of value.split('\0').filter(Boolean)) {
    const match = /^(100644|100755|120000|160000) (?:blob|commit) ([0-9a-f]{40})\t(.+)$/u.exec(
      record,
    );
    if (match === null) throw new TypeError('Unexpected Git tree record');
    output.set(match[3]!, Object.freeze({ mode: match[1]!, objectId: match[2]! }));
  }
  return output;
}

function gitIndexPaths(projectPath: string): ReadonlySet<string> {
  const value = gitOutput(projectPath, ['ls-files', '--stage', '-z']);
  const output = new Set<string>();
  for (const record of value.split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    if (tab < 0) throw new TypeError('Unexpected Git index record');
    output.add(record.slice(tab + 1));
  }
  return output;
}

function gitPathSet(projectPath: string, arguments_: readonly string[]): ReadonlySet<string> {
  return new Set(gitOutput(projectPath, arguments_).split('\0').filter(Boolean));
}

function gitOutput(projectPath: string, arguments_: readonly string[]): string {
  return execFileSync(
    '/usr/bin/git',
    [
      '--no-optional-locks',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      ...arguments_,
    ],
    {
      cwd: projectPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_NO_REPLACE_OBJECTS: '1',
      },
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    },
  );
}

function optionalGitOutput(projectPath: string, arguments_: readonly string[]): string | undefined {
  try {
    return gitOutput(projectPath, arguments_);
  } catch {
    return undefined;
  }
}

function classifyGitPath(
  path: string,
  classification: GitClassification,
  observed?: Readonly<{ mode: string; objectId: string }>,
): ProjectContextGitClass {
  if (
    path === '.git' ||
    path.startsWith('.git/') ||
    path.endsWith('/.git') ||
    path.includes('/.git/')
  ) {
    return 'GIT_ADMIN';
  }
  const tracked = classification.tracked.get(path);
  if (tracked !== undefined) {
    return observed?.mode === tracked.mode && observed.objectId === tracked.objectId
      ? 'TRACKED_CLEAN'
      : 'TRACKED_DIRTY';
  }
  if (classification.staged.has(path)) return 'TRACKED_DIRTY';
  if (classification.ignored.has(path)) return 'IGNORED';
  if (classification.untracked.has(path)) return 'UNTRACKED';
  return 'NA';
}

function gitBlobSha(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

function digestText(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function indexError(code: ProjectContextIndexErrorCode, cause: unknown): ProjectContextIndexError {
  return new ProjectContextIndexError(
    code,
    'Project context could not be indexed exactly.',
    cause instanceof Error ? { cause } : undefined,
  );
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
