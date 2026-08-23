import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  parseCreatorAgentVersionAny,
  serializeCreatorAgentVersionAny,
  type CreatorAgentVersion,
} from '@cb/creator-agent-protocol/agent';

import {
  CreatorAgentLocalError,
  type CreatorAgentLocalTurnOptions,
  type CreatorAgentLocalTurnResult,
} from './agent-local-contract.js';
import {
  runCreatorWorkerLocalAlphaWithDependencies,
  type LocalAlphaDependencies,
} from './local-alpha-runner.js';
import { createBundledCodexHost } from './codex-app-server-host.js';
import { SUPPORTED_BUNDLED_CODEX_VERSION } from './codex-app-server-process.js';
import { createLocalAlphaBroker } from './local-alpha-broker.js';

const productionDependencies: LocalAlphaDependencies = Object.freeze({
  createHost: createBundledCodexHost,
  createBroker: createLocalAlphaBroker,
});
const MAX_SNAPSHOT_FILES = 50_000;
const MAX_SNAPSHOT_BLOB_BYTES = 32 * 1024 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 256 * 1024 * 1024;
const GIT_EXECUTABLE = '/usr/bin/git';

export function runCreatorAgentLocalTurn(
  options: CreatorAgentLocalTurnOptions,
): Promise<CreatorAgentLocalTurnResult> {
  return runCreatorAgentLocalTurnWithDependencies(options, productionDependencies);
}

/** Internal test seam; intentionally absent from the package root export. */
export async function runCreatorAgentLocalTurnWithDependencies(
  input: CreatorAgentLocalTurnOptions,
  dependencies: LocalAlphaDependencies,
): Promise<CreatorAgentLocalTurnResult> {
  let version: CreatorAgentVersion;
  try {
    version = verifyVersion(input.version);
  } catch (error) {
    throw agentError('CREATOR_AGENT_VERSION_INVALID', error);
  }
  assertSupportedRuntime(version);
  const sourceProject = assertVersionSource(input.projectPath, version);
  assertStateOutsideSource(sourceProject, input.stateDirectory);
  const snapshot = materializeVersionSnapshot(sourceProject, version);
  try {
    const result = await runCreatorWorkerLocalAlphaWithDependencies(
      {
        projectPath: snapshot,
        prompt: input.prompt,
        stateDirectory: input.stateDirectory,
        allowUnisolatedRead: input.allowUnisolatedRead,
        allowLoopbackProxy: input.allowLoopbackProxy,
        turnTimeoutMs: version.definition.runtime.turnTimeoutMs,
        signal: input.signal,
        diagnosticSink: input.diagnosticSink,
      },
      dependencies,
      {
        developerInstructions: compileDeveloperInstructions(version),
        executionBinding: version.versionFingerprint,
      },
    );
    return Object.freeze({
      agentId: version.agentId,
      versionId: version.versionId,
      versionFingerprint: version.versionFingerprint,
      invocationId: result.invocationId,
      text: result.text,
    });
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

export function compileCreatorAgentDeveloperInstructions(input: unknown): string {
  let version: CreatorAgentVersion;
  try {
    version = verifyVersion(input);
  } catch (error) {
    throw agentError('CREATOR_AGENT_VERSION_INVALID', error);
  }
  assertSupportedRuntime(version);
  return compileDeveloperInstructions(version);
}

/** Internal authoring preflight; intentionally absent from the package root export. */
export function assertCreatorAgentVersionRunnable(projectPath: string, input: unknown): void {
  let version: CreatorAgentVersion;
  try {
    version = verifyVersion(input);
  } catch (error) {
    throw agentError('CREATOR_AGENT_VERSION_INVALID', error);
  }
  assertSupportedRuntime(version);
  const sourceProject = assertVersionSource(projectPath, version);
  const snapshot = materializeVersionSnapshot(sourceProject, version);
  rmSync(snapshot, { recursive: true, force: true });
}

function verifyVersion(input: unknown): CreatorAgentVersion {
  return parseCreatorAgentVersionAny(serializeCreatorAgentVersionAny(input));
}

function compileDeveloperInstructions(version: CreatorAgentVersion): string {
  const { definition } = version;
  return [
    `You are the Combo Creator Agent “${definition.name}”.`,
    definition.behavior.instructions,
    'Runtime contract:',
    '- Treat the mounted Project as read-only and do not modify files.',
    '- Do not use browser, web search, model-exposed network access, plugins, or dynamic tools.',
    `- Produce this result: ${definition.runtime.output.description}`,
  ].join('\n');
}

function assertSupportedRuntime(version: CreatorAgentVersion): void {
  const { requirements, runtime } = version.definition;
  if (
    runtime.skills.length !== 0 ||
    runtime.dynamicTools.length !== 0 ||
    runtime.toolNetworkAccess !== false ||
    runtime.contextProfile !== 'PROJECT_TREE_READ_ONLY_V1' ||
    runtime.permissionProfile !== 'LOCAL_UNISOLATED_READ_ONLY_V1' ||
    requirements.commands.length !== 0 ||
    requirements.plugins.length !== 0 ||
    requirements.environmentVariableNames.length !== 0 ||
    (requirements.codexVersion !== undefined &&
      requirements.codexVersion !== SUPPORTED_BUNDLED_CODEX_VERSION)
  ) {
    throw agentError('CREATOR_AGENT_RUNTIME_UNSUPPORTED');
  }
}

function assertVersionSource(projectPath: string, version: CreatorAgentVersion): string {
  let canonicalProject: string;
  try {
    canonicalProject = realpathSync(projectPath);
    if (!statSync(canonicalProject).isDirectory()) throw new TypeError('not a directory');
  } catch (error) {
    throw agentError('CREATOR_AGENT_PROJECT_MISMATCH', error);
  }
  const snapshot = version.definition.projectSnapshot;
  try {
    const root = realpathSync(git(canonicalProject, ['rev-parse', '--show-toplevel']));
    const repositoryUrl = git(canonicalProject, [
      'config',
      '--local',
      '--no-includes',
      '--get',
      'remote.origin.url',
    ]);
    git(canonicalProject, ['check-ref-format', snapshot.sourceRef]);
    const commitSha = git(canonicalProject, [
      'rev-parse',
      '--verify',
      `${snapshot.commitSha}^{commit}`,
    ]);
    const treeSha = git(canonicalProject, ['rev-parse', `${snapshot.commitSha}^{tree}`]);
    if (
      root !== canonicalProject ||
      repositoryUrl !== snapshot.repositoryUrl ||
      commitSha !== snapshot.commitSha ||
      treeSha !== snapshot.treeSha
    ) {
      throw new TypeError('Project source does not contain the AgentVersion snapshot');
    }
    return canonicalProject;
  } catch (error) {
    throw agentError('CREATOR_AGENT_PROJECT_MISMATCH', error);
  }
}

function materializeVersionSnapshot(projectPath: string, version: CreatorAgentVersion): string {
  let root: string | undefined;
  try {
    const inspection = inspectVerifiedSnapshot(
      projectPath,
      version.definition.projectSnapshot.commitSha,
      version.definition.projectSnapshot.treeSha,
    );
    root = mkdtempSync(join(tmpdir(), 'combo-creator-agent-snapshot-'));
    chmodSync(root, 0o700);
    for (const entry of inspection.entries) {
      const content = inspection.blobs.get(entry.objectId);
      if (content === undefined || content.length !== entry.size) {
        throw new TypeError('AgentVersion blob materialization is incomplete');
      }
      const target = resolve(root, entry.path);
      if (target !== root && !target.startsWith(`${root}/`)) {
        throw new TypeError('AgentVersion path escaped its snapshot');
      }
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, content, {
        flag: 'wx',
        mode: entry.mode === '100755' ? 0o500 : 0o400,
      });
    }
    return root;
  } catch (error) {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    throw agentError('CREATOR_AGENT_PROJECT_MISMATCH', error);
  }
}

function assertStateOutsideSource(projectPath: string, stateDirectory: string): void {
  if (typeof stateDirectory !== 'string' || !isAbsolute(stateDirectory)) {
    throw agentError('CREATOR_AGENT_PROJECT_MISMATCH');
  }
  let cursor = resolve(stateDirectory);
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) throw agentError('CREATOR_AGENT_PROJECT_MISMATCH');
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  const candidate = resolve(realpathSync(cursor), ...suffix);
  const relation = relative(projectPath, candidate);
  if (relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))) {
    throw agentError('CREATOR_AGENT_PROJECT_MISMATCH');
  }
}

type SnapshotEntry = Readonly<{
  mode: '100644' | '100755';
  objectId: string;
  path: string;
  size: number;
}>;

type RequestedGitObject = Readonly<{
  objectId: string;
  type: 'blob' | 'commit' | 'tree';
}>;

type SnapshotInspection = Readonly<{
  entries: readonly SnapshotEntry[];
  blobs: ReadonlyMap<string, Buffer>;
}>;

type VerifiedGitObject = Readonly<{
  content: Buffer;
  type: RequestedGitObject['type'];
}>;

function inspectVerifiedSnapshot(
  projectPath: string,
  commitSha: string,
  treeSha: string,
): SnapshotInspection {
  const commit = readVerifiedGitObjects(projectPath, [{ objectId: commitSha, type: 'commit' }]).get(
    commitSha,
  );
  if (commit === undefined || commitTreeId(commit.content) !== treeSha) {
    throw new TypeError('AgentVersion commit does not bind the declared tree');
  }
  const pending: Array<Readonly<{ depth: number; objectId: string; prefix: string }>> = [
    { depth: 0, objectId: treeSha, prefix: '' },
  ];
  const treeCache = new Map<string, Buffer>();
  const fileEntries: Array<Omit<SnapshotEntry, 'size'>> = [];
  const allPaths: Array<Readonly<{ kind: 'directory' | 'file'; path: string }>> = [];
  let visitedTreePaths = 0;
  while (pending.length > 0) {
    const batch = pending.splice(0);
    const missing = [...new Set(batch.map((entry) => entry.objectId))]
      .filter((objectId) => !treeCache.has(objectId))
      .map((objectId) => ({ objectId, type: 'tree' }) as const);
    for (const [objectId, object] of readVerifiedGitObjects(projectPath, missing)) {
      treeCache.set(objectId, object.content);
    }
    for (const tree of batch) {
      if (tree.depth > 64 || visitedTreePaths >= MAX_SNAPSHOT_FILES) {
        throw new TypeError('AgentVersion tree exceeds the local complexity budget');
      }
      visitedTreePaths += 1;
      const content = treeCache.get(tree.objectId);
      if (content === undefined) throw new TypeError('AgentVersion subtree is unavailable');
      for (const entry of parseGitTree(content)) {
        const path = tree.prefix === '' ? entry.name : `${tree.prefix}/${entry.name}`;
        assertSafeSnapshotPath(path);
        if (entry.mode === '40000') {
          allPaths.push({ kind: 'directory', path });
          pending.push({
            depth: tree.depth + 1,
            objectId: entry.objectId,
            prefix: path,
          });
        } else if (entry.mode === '100644' || entry.mode === '100755') {
          allPaths.push({ kind: 'file', path });
          if (fileEntries.length >= MAX_SNAPSHOT_FILES) {
            throw new TypeError('AgentVersion tree exceeds the local file budget');
          }
          fileEntries.push({ mode: entry.mode, objectId: entry.objectId, path });
        } else {
          throw new TypeError('AgentVersion contains a symlink, gitlink, or special file');
        }
      }
    }
  }
  assertNoLocalPathCollisions(allPaths);
  const requestedBlobs = [...new Set(fileEntries.map((entry) => entry.objectId))].map(
    (objectId) => ({ objectId, type: 'blob' }) as const,
  );
  const verifiedBlobs = readVerifiedGitObjects(projectPath, requestedBlobs);
  const blobs = new Map<string, Buffer>();
  const entries: SnapshotEntry[] = [];
  let totalBytes = 0;
  for (const entry of fileEntries) {
    const content = verifiedBlobs.get(entry.objectId)?.content;
    if (content === undefined || content.length > MAX_SNAPSHOT_BLOB_BYTES) {
      throw new TypeError('AgentVersion blob exceeds the local file budget');
    }
    totalBytes += content.length;
    if (totalBytes > MAX_SNAPSHOT_TOTAL_BYTES) {
      throw new TypeError('AgentVersion tree exceeds the local snapshot budget');
    }
    blobs.set(entry.objectId, content);
    entries.push({ ...entry, size: content.length });
  }
  return { entries, blobs };
}

function assertNoLocalPathCollisions(
  paths: ReadonlyArray<Readonly<{ kind: 'directory' | 'file'; path: string }>>,
): void {
  const normalizedKinds = new Map<string, 'directory' | 'file'>();
  for (const entry of paths) {
    const normalized = entry.path.normalize('NFC').toLowerCase();
    if (normalizedKinds.has(normalized)) {
      throw new TypeError('AgentVersion paths collide on the local filesystem');
    }
    normalizedKinds.set(normalized, entry.kind);
  }
  for (const path of normalizedKinds.keys()) {
    let separator = path.indexOf('/');
    while (separator >= 0) {
      if (normalizedKinds.get(path.slice(0, separator)) === 'file') {
        throw new TypeError('AgentVersion paths collide on the local filesystem');
      }
      separator = path.indexOf('/', separator + 1);
    }
  }
}

function commitTreeId(content: Buffer): string {
  const newline = content.indexOf(0x0a);
  const line = newline < 0 ? '' : content.subarray(0, newline).toString('ascii');
  const match = /^tree ([0-9a-f]{40})$/u.exec(line);
  if (match === null) throw new TypeError('AgentVersion commit object is malformed');
  return match[1] as string;
}

function parseGitTree(
  content: Buffer,
): Array<Readonly<{ mode: string; name: string; objectId: string }>> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries: Array<Readonly<{ mode: string; name: string; objectId: string }>> = [];
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset);
    const nul = space < 0 ? -1 : content.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > content.length) {
      throw new TypeError('AgentVersion tree object is malformed');
    }
    const mode = content.subarray(offset, space).toString('ascii');
    const name = decoder.decode(content.subarray(space + 1, nul));
    if (name.includes('/')) throw new TypeError('AgentVersion tree entry name is malformed');
    const objectId = content.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, objectId });
    offset = nul + 21;
  }
  return entries;
}

function readVerifiedGitObjects(
  projectPath: string,
  objects: readonly RequestedGitObject[],
): ReadonlyMap<string, VerifiedGitObject> {
  if (objects.length === 0) return new Map();
  const request = `${objects.map((object) => object.objectId).join('\n')}\n`;
  const result = spawnSync(
    GIT_EXECUTABLE,
    [...safeGitArguments(projectPath), 'cat-file', '--batch'],
    {
      encoding: null,
      env: isolatedGitEnvironment(),
      input: request,
      maxBuffer: MAX_SNAPSHOT_TOTAL_BYTES + 32 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'ignore'],
    },
  );
  if (result.status !== 0 || !(result.stdout instanceof Buffer)) {
    throw new TypeError('AgentVersion objects could not be read');
  }
  const verified = new Map<string, VerifiedGitObject>();
  let offset = 0;
  for (const object of objects) {
    const newline = result.stdout.indexOf(0x0a, offset);
    if (newline < 0) throw new TypeError('AgentVersion object response is incomplete');
    const header = result.stdout.subarray(offset, newline).toString('ascii');
    const match = /^([0-9a-f]{40}) (blob|commit|tree) ([0-9]+)$/u.exec(header);
    const size = Number(match?.[3]);
    if (
      match?.[1] !== object.objectId ||
      match[2] !== object.type ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > MAX_SNAPSHOT_TOTAL_BYTES
    ) {
      throw new TypeError('AgentVersion object identity changed');
    }
    const start = newline + 1;
    const end = start + size;
    if (end >= result.stdout.length || result.stdout[end] !== 0x0a) {
      throw new TypeError('AgentVersion object response has an invalid boundary');
    }
    const content = result.stdout.subarray(start, end);
    const observed = createHash('sha1')
      .update(`${object.type} ${size}\0`)
      .update(content)
      .digest('hex');
    if (observed !== object.objectId) {
      throw new TypeError('AgentVersion Git object content failed its SHA-1 check');
    }
    verified.set(object.objectId, { content, type: object.type });
    offset = end + 1;
  }
  if (offset !== result.stdout.length) {
    throw new TypeError('AgentVersion object response contains trailing bytes');
  }
  return verified;
}

function assertSafeSnapshotPath(path: string): void {
  const components = path.split('/');
  if (
    path.length === 0 ||
    path.length > 2_048 ||
    path.startsWith('/') ||
    /[\\\n\r]/u.test(path) ||
    components.some(
      (component) =>
        component.length === 0 ||
        component === '.' ||
        component === '..' ||
        component.toLowerCase() === '.git' ||
        Buffer.byteLength(component, 'utf8') > 255,
    )
  ) {
    throw new TypeError('AgentVersion contains an unsafe snapshot path');
  }
}

function safeGitArguments(projectPath: string): string[] {
  return [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.attributesFile=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.filemode=true',
    '-c',
    'credential.helper=',
    '-c',
    'core.protectHFS=true',
    '-c',
    'core.protectNTFS=true',
    '-c',
    'protocol.file.allow=never',
    '-c',
    'protocol.ext.allow=never',
    '-c',
    'filter.lfs.smudge=',
    '-c',
    'filter.lfs.required=false',
    '-C',
    projectPath,
  ];
}

function git(projectPath: string, arguments_: readonly string[]): string {
  return execFileSync(GIT_EXECUTABLE, [...safeGitArguments(projectPath), ...arguments_], {
    encoding: 'utf8',
    env: isolatedGitEnvironment(),
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trimEnd();
}

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
  return {
    ...environment,
    GIT_ASKPASS: '/usr/bin/false',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function agentError(code: CreatorAgentLocalError['code'], cause?: unknown): CreatorAgentLocalError {
  const messages: Record<CreatorAgentLocalError['code'], string> = {
    CREATOR_AGENT_VERSION_INVALID: 'The Creator AgentVersion failed integrity validation.',
    CREATOR_AGENT_PROJECT_MISMATCH: 'The local Project does not match the AgentVersion snapshot.',
    CREATOR_AGENT_RUNTIME_UNSUPPORTED:
      'The Creator AgentVersion requests a runtime capability that is not implemented.',
  };
  return new CreatorAgentLocalError(code, messages[code], { cause });
}
