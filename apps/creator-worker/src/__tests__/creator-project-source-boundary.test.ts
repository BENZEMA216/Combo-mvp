import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  materializeCreatorProjectSourceProjection,
  materializeCreatorProjectSourceProjectionWithHooks,
} from '../authoring/creator-project-source-projection.js';
import { extractCreatorAgentProjectBehaviorWithDependencies } from '../authoring/project-behavior-extractor.js';
import {
  assertCreatorProjectSourceFileIdentity,
  revalidateProjectContext,
  scanCreatorProjectSourceContext,
  scanCreatorProjectSourceContextWithHooks,
  scanProjectContext,
} from '../project-context-index.js';
import { FakeHost } from './test-fixture.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe('Agent Package Creator source boundary', () => {
  it('prunes Git, Codex and exact Host task metadata without changing legacy scans', () => {
    const fixture = creatorProjectFixture();

    const creator = scanCreatorProjectSourceContext(fixture.project);
    const legacy = scanProjectContext(fixture.project);
    const creatorPaths = creator.index.entries.map(({ path }) => path);
    const legacyPaths = legacy.index.entries.map(({ path }) => path);

    expect(creatorPaths).toEqual([
      'README.md',
      'src',
      'src/index.ts',
      'tasks',
      'tasks/release.json',
    ]);
    expect(creatorPaths.some(isPrivateHostPath)).toBe(false);
    expect(legacyPaths).toContain('.git/HEAD');
    expect(legacyPaths).toContain('.codex/sessions/host-task.jsonl');
    expect(legacyPaths).toContain('codex-thread.json');
    expect(legacyPaths).toContain('codex-task.json');
    expect(legacyPaths).toContain('codex-session.json');

    const digest = creator.index.rootDigest;
    writeFileSync(join(fixture.project, '.git/codex-thread.json'), '{"owner":"changed"}\n');
    writeFileSync(join(fixture.project, '.codex/sessions/host-task.jsonl'), '{"changed":true}\n');
    writeFileSync(join(fixture.project, 'codex-thread.json'), '{"owner":"changed"}\n');
    rmSync(join(fixture.project, 'codex-task.json'));
    writeFileSync(join(fixture.project, 'codex-session.json'), '{"session":"changed"}\n');
    writeFileSync(join(fixture.project, 'src/codex-thread.json'), '{"owner":"nested"}\n');
    const future = new Date(Date.now() + 10_000);
    utimesSync(fixture.project, future, future);
    utimesSync(join(fixture.project, 'src'), future, future);

    expect(scanCreatorProjectSourceContext(fixture.project).index.rootDigest).toBe(digest);
    expect(() => revalidateProjectContext(creator)).not.toThrow();
  });

  it('does not invoke Git classification for the Creator source profile', () => {
    const fixture = creatorProjectFixture();
    const beforeGitClassification = vi.fn();
    const visitedDirectories: string[] = [];
    const openedFiles: string[] = [];
    chmodSync(join(fixture.project, '.git'), 0o000);
    chmodSync(join(fixture.project, '.codex'), 0o000);

    try {
      scanCreatorProjectSourceContextWithHooks(fixture.project, {
        beforeGitClassification,
        beforeDirectoryRead: (path) => visitedDirectories.push(path),
        afterFileOpened: (path) => openedFiles.push(path),
      });
    } finally {
      chmodSync(join(fixture.project, '.git'), 0o700);
      chmodSync(join(fixture.project, '.codex'), 0o700);
    }

    expect(beforeGitClassification).not.toHaveBeenCalled();
    expect(visitedDirectories).not.toContain('.git');
    expect(visitedDirectories).not.toContain('.codex');
    expect(openedFiles).not.toContain('outside-link');
    expect(openedFiles.some(isPrivateHostPath)).toBe(false);
  });

  it('rejects a saved Project rooted inside Git or Codex private state before reading it', () => {
    const fixture = creatorProjectFixture();
    const metadataRoot = join(fixture.root, 'CoDeX-Thread.JsOn');
    mkdirSync(metadataRoot);
    writeFileSync(join(metadataRoot, 'canary'), 'must not be opened\n');
    const privateRoots = [
      join(fixture.project, '.git'),
      join(fixture.project, '.codex'),
      metadataRoot,
    ];

    for (const privateRoot of privateRoots) {
      const beforeDirectoryRead = vi.fn();
      const beforeGitClassification = vi.fn();
      const afterFileOpened = vi.fn();
      chmodSync(privateRoot, 0o000);
      try {
        expect(() =>
          scanCreatorProjectSourceContextWithHooks(realpathSync(privateRoot), {
            beforeDirectoryRead,
            beforeGitClassification,
            afterFileOpened,
          }),
        ).toThrowError(expect.objectContaining({ code: 'PROJECT_CONTEXT_PATH_INVALID' }));
      } finally {
        chmodSync(privateRoot, 0o700);
      }
      expect(beforeDirectoryRead).not.toHaveBeenCalled();
      expect(beforeGitClassification).not.toHaveBeenCalled();
      expect(afterFileOpened).not.toHaveBeenCalled();
      expect(scanProjectContext(realpathSync(privateRoot)).index.entryCount).toBeGreaterThan(0);
    }
  });

  it('fails closed on a non-portable business filename instead of treating it as private', () => {
    const fixture = creatorProjectFixture();
    const unsafePath = 'unsafe\\source.txt';
    writeFileSync(join(fixture.project, unsafePath), 'business content\n');

    expect(() => scanCreatorProjectSourceContext(fixture.project)).toThrowError(
      expect.objectContaining({ code: 'PROJECT_CONTEXT_SCAN_FAILED' }),
    );
    expect(scanProjectContext(fixture.project).index.entries.map(({ path }) => path)).toContain(
      unsafePath,
    );
  });

  it('preserves an exact well-formed NFD business path through scan, projection and citation', async () => {
    const fixture = creatorProjectFixture();
    const requestedPath = `cafe\u0301.md`;
    writeFileSync(join(fixture.project, requestedPath), 'decomposed filename content\n');
    const scan = scanCreatorProjectSourceContext(fixture.project);
    const exactPath = scan.index.entries.find(({ path }) => path.startsWith('cafe'))?.path;

    expect(exactPath).toBe(requestedPath);
    const projection = materializeCreatorProjectSourceProjection(scan);
    try {
      expect(readFileSync(join(projection.projectPath, exactPath!), 'utf8')).toBe(
        'decomposed filename content\n',
      );
    } finally {
      projection.release();
    }

    const host = new FakeHost();
    const pending = extractCreatorAgentProjectBehaviorWithDependencies(
      {
        projectPath: fixture.project,
        allowUnisolatedRead: true,
        allowSensitiveProjectContext: true,
      },
      {
        scanProject: scanCreatorProjectSourceContext,
        revalidateProject: revalidateProjectContext,
        materializeHostProject: materializeCreatorProjectSourceProjection,
        createHost: () => host,
      },
      'AGENT_PACKAGE_AUTHORING',
    );
    await vi.waitFor(() => expect(host.controllers).toHaveLength(1));
    settleCompilerHost(host, [exactPath!]);
    await expect(pending).resolves.toMatchObject({
      citedSources: [expect.objectContaining({ path: exactPath })],
    });
  });

  it('rejects an intermediate-directory symlink race during the initial scan before body read', () => {
    const fixture = creatorProjectFixture();
    const sourceDirectory = join(fixture.project, 'src');
    const movedDirectory = join(fixture.project, 'src-original');
    const outsideDirectory = join(fixture.root, 'outside-directory');
    mkdirSync(outsideDirectory);
    linkSync(join(sourceDirectory, 'index.ts'), join(outsideDirectory, 'index.ts'));
    const bodyReads: string[] = [];
    let replaced = false;

    try {
      expect(() =>
        scanCreatorProjectSourceContextWithHooks(fixture.project, {
          beforeFileOpen: (path) => {
            if (path !== 'src/index.ts' || replaced) return;
            replaced = true;
            renameSync(sourceDirectory, movedDirectory);
            symlinkSync(outsideDirectory, sourceDirectory);
          },
          beforeFileRead: (path) => bodyReads.push(path),
        }),
      ).toThrowError(expect.objectContaining({ code: 'PROJECT_CONTEXT_CHANGED' }));
    } finally {
      if (existsSync(sourceDirectory) && lstatSync(sourceDirectory).isSymbolicLink()) {
        rmSync(sourceDirectory);
      }
      if (existsSync(movedDirectory)) renameSync(movedDirectory, sourceDirectory);
    }

    expect(replaced).toBe(true);
    expect(bodyReads).not.toContain('src/index.ts');
  });

  it('rejects an intermediate-directory symlink race during projection before body read', () => {
    const fixture = creatorProjectFixture();
    const scan = scanCreatorProjectSourceContext(fixture.project);
    const sourceDirectory = join(fixture.project, 'src');
    const movedDirectory = join(fixture.project, 'src-original');
    const outsideDirectory = join(fixture.root, 'outside-directory');
    mkdirSync(outsideDirectory);
    linkSync(join(sourceDirectory, 'index.ts'), join(outsideDirectory, 'index.ts'));
    const bodyReads: string[] = [];
    let replaced = false;

    try {
      expect(() =>
        materializeCreatorProjectSourceProjectionWithHooks(scan, {
          beforeSourceFileOpen: (path) => {
            if (path !== 'src/index.ts' || replaced) return;
            replaced = true;
            renameSync(sourceDirectory, movedDirectory);
            symlinkSync(outsideDirectory, sourceDirectory);
          },
          beforeSourceFileRead: (path) => bodyReads.push(path),
        }),
      ).toThrowError(expect.objectContaining({ code: 'PROJECT_CONTEXT_CHANGED' }));
    } finally {
      if (existsSync(sourceDirectory) && lstatSync(sourceDirectory).isSymbolicLink()) {
        rmSync(sourceDirectory);
      }
      if (existsSync(movedDirectory)) renameSync(movedDirectory, sourceDirectory);
    }

    expect(replaced).toBe(true);
    expect(bodyReads).not.toContain('src/index.ts');
  });

  it('uses the cached identity map and ignores unreadable excluded state during projection and revalidation', () => {
    const fixture = creatorProjectFixture();
    const nestedMetadata = [
      join(fixture.project, 'src/codex-thread.json'),
      join(fixture.project, 'src/codex-session.json'),
      join(fixture.project, 'tasks/codex-task.json'),
    ];
    for (const path of nestedMetadata) writeFileSync(path, 'private host state\n');
    const scan = scanCreatorProjectSourceContext(fixture.project);
    const businessFile = scan.index.entries.find(({ path }) => path === 'README.md');
    if (businessFile === undefined) throw new Error('Creator source fixture is incomplete.');
    const find = vi.spyOn(Array.prototype, 'find').mockImplementation(() => {
      throw new Error('identity lookup must not scan the entry array');
    });
    let identityFailure: unknown;
    try {
      assertCreatorProjectSourceFileIdentity(
        scan,
        businessFile.path,
        lstatSync(join(fixture.project, businessFile.path), { bigint: true }),
      );
    } catch (error) {
      identityFailure = error;
    } finally {
      find.mockRestore();
    }
    expect(identityFailure).toBeUndefined();

    const protectedPaths = [
      join(fixture.project, '.git'),
      join(fixture.project, '.codex'),
      join(fixture.project, 'codex-task.json'),
      join(fixture.project, 'codex-thread.json'),
      join(fixture.project, 'codex-session.json'),
      ...nestedMetadata,
    ];
    for (const path of protectedPaths) chmodSync(path, 0o000);
    let projection: ReturnType<typeof materializeCreatorProjectSourceProjection> | undefined;
    try {
      projection = materializeCreatorProjectSourceProjection(scan);
      expect(snapshotTree(projection.projectPath, false).map(({ path }) => path)).toEqual([
        'README.md',
        'src',
        'src/index.ts',
        'tasks',
        'tasks/release.json',
      ]);
      expect(() => revalidateProjectContext(scan)).not.toThrow();
    } finally {
      projection?.release();
      for (const path of protectedPaths.slice().reverse()) {
        chmodSync(path, lstatSync(path).isDirectory() ? 0o700 : 0o600);
      }
    }
  });

  it('treats an unsafe business path added after scan as source drift', () => {
    const fixture = creatorProjectFixture();
    const scan = scanCreatorProjectSourceContext(fixture.project);
    writeFileSync(join(fixture.project, 'late\\unsafe.txt'), 'late business content\n');

    expect(() => revalidateProjectContext(scan)).toThrowError(
      expect.objectContaining({ code: 'PROJECT_CONTEXT_CHANGED' }),
    );
  });

  it('prunes a linked-worktree Git pointer before the Creator source inventory', () => {
    const fixture = creatorProjectFixture();
    const linked = join(fixture.root, 'linked');
    git(fixture.project, ['worktree', 'add', '-b', 'creator-source-boundary-linked', linked]);

    const linkedProject = realpathSync(linked);
    const creatorPaths = scanCreatorProjectSourceContext(linkedProject).index.entries.map(
      ({ path }) => path,
    );
    const legacyPaths = scanProjectContext(linkedProject).index.entries.map(({ path }) => path);

    expect(creatorPaths).not.toContain('.git');
    expect(legacyPaths).toContain('.git');
  });

  it('gives the authoring Host a private read-only projection and leaves the source unchanged', () => {
    const fixture = creatorProjectFixture();
    const scan = scanCreatorProjectSourceContext(fixture.project);
    const sourceBefore = snapshotTree(fixture.project);
    const projection = materializeCreatorProjectSourceProjection(scan);

    try {
      expect(projection.projectPath).not.toBe(fixture.project);
      expect(projection.projectPath.startsWith(realpathSync(tmpdir()))).toBe(true);
      const projectionTree = snapshotTree(projection.projectPath, false);
      expect(projectionTree.map(({ path }) => path)).toEqual([
        'README.md',
        'src',
        'src/index.ts',
        'tasks',
        'tasks/release.json',
      ]);
      expect(lstatSync(projection.projectPath).mode & 0o777).toBe(0o500);
      expect(lstatSync(join(projection.projectPath, 'README.md')).mode & 0o777).toBe(0o400);
      expect(
        projectionTree
          .filter(({ kind }) => kind === 'directory')
          .every(({ mode }) => mode === 0o500),
      ).toBe(true);
      expect(
        projectionTree.filter(({ kind }) => kind === 'file').every(({ mode }) => mode === 0o400),
      ).toBe(true);
      expect(JSON.stringify(projectionTree)).not.toContain(fixture.project);
      expect(JSON.stringify(projectionTree)).not.toContain(fixture.outside);
      expect(snapshotTree(fixture.project)).toEqual(sourceBefore);
    } finally {
      const projectionPath = projection.projectPath;
      projection.release();
      expect(existsSync(projectionPath)).toBe(false);
    }
  });

  it('refuses to project a legacy full-physical scan', () => {
    const fixture = creatorProjectFixture();

    expect(() =>
      materializeCreatorProjectSourceProjection(scanProjectContext(fixture.project)),
    ).toThrowError(expect.objectContaining({ code: 'PROJECT_CONTEXT_SCAN_FAILED' }));
  });

  it('hard-rejects a forbidden citation even if a compromised scanner reports it', async () => {
    const fixture = creatorProjectFixture();
    const host = new FakeHost();
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'combo-creator-host-workspace-')));
    roots.push(workspace);
    const release = vi.fn();
    const pending = extractCreatorAgentProjectBehaviorWithDependencies(
      {
        projectPath: fixture.project,
        creatorRequest: '请把当前 Project 的发布验收方法提炼成 Agent。',
        allowUnisolatedRead: true,
        allowSensitiveProjectContext: true,
      },
      {
        scanProject: scanProjectContext,
        revalidateProject: revalidateProjectContext,
        materializeHostProject: () => Object.freeze({ projectPath: workspace, release }),
        createHost: () => host,
      },
      'AGENT_PACKAGE_AUTHORING',
    );
    await vi.waitFor(() => expect(host.controllers).toHaveLength(1));
    settleCompilerHost(host, ['.git/codex-thread.json']);

    await expect(pending).rejects.toMatchObject({ code: 'PROJECT_COMPILER_OUTPUT_INVALID' });
    expect(release).toHaveBeenCalledOnce();
  });

  it('never passes the source Project to the Package authoring Host', async () => {
    const fixture = creatorProjectFixture();
    const host = new FakeHost();
    let hostOptions: Readonly<{ projectPath: string; developerInstructions: string }> | undefined;
    const pending = extractCreatorAgentProjectBehaviorWithDependencies(
      {
        projectPath: fixture.project,
        creatorRequest: '请把当前 Project 的发布验收方法提炼成 Agent。',
        allowUnisolatedRead: true,
        allowSensitiveProjectContext: true,
      },
      {
        scanProject: scanCreatorProjectSourceContext,
        revalidateProject: revalidateProjectContext,
        materializeHostProject: materializeCreatorProjectSourceProjection,
        createHost: (options) => {
          hostOptions = options;
          return host;
        },
      },
      'AGENT_PACKAGE_AUTHORING',
    );
    await vi.waitFor(() => expect(host.controllers).toHaveLength(1));
    settleCompilerHost(host, ['README.md', 'tasks/release.json']);

    await expect(pending).resolves.toMatchObject({ indexedFileCount: 3 });
    expect(hostOptions).toBeDefined();
    expect(hostOptions!.projectPath).not.toBe(fixture.project);
    expect(hostOptions!.developerInstructions).not.toContain('.git');
    expect(hostOptions!.developerInstructions).not.toContain('.codex');
    expect(hostOptions!.developerInstructions).not.toContain('task/session');
    expect(hostOptions!.developerInstructions).not.toContain(fixture.project);
  });

  it('reports projection cleanup failure instead of hiding it', async () => {
    const fixture = creatorProjectFixture();
    const host = new FakeHost();
    const cleanupFailure = new Error('CREATOR_PROJECTION_CLEANUP_CANARY');
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'combo-creator-host-workspace-')));
    roots.push(workspace);
    const pending = extractCreatorAgentProjectBehaviorWithDependencies(
      {
        projectPath: fixture.project,
        allowUnisolatedRead: true,
        allowSensitiveProjectContext: true,
      },
      {
        scanProject: scanCreatorProjectSourceContext,
        revalidateProject: revalidateProjectContext,
        materializeHostProject: () =>
          Object.freeze({
            projectPath: workspace,
            release: () => {
              throw cleanupFailure;
            },
          }),
        createHost: () => host,
      },
      'AGENT_PACKAGE_AUTHORING',
    );
    await vi.waitFor(() => expect(host.controllers).toHaveLength(1));
    settleCompilerHost(host, ['README.md']);

    let failure: unknown;
    try {
      await pending;
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'PROJECT_COMPILER_STOP_INCOMPLETE' });
    expect((failure as Error).cause).toBeInstanceOf(AggregateError);
    expect((failure as Error & { cause: AggregateError }).cause.errors).toContain(cleanupFailure);
  });

  it('releases the projection after Host failure and rejects a missing materializer', async () => {
    const fixture = creatorProjectFixture();
    const host = new FakeHost();
    const hostFailure = new Error('CREATOR_HOST_FAILURE_CANARY');
    vi.spyOn(host, 'start').mockRejectedValue(hostFailure);
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'combo-creator-host-workspace-')));
    roots.push(workspace);
    const release = vi.fn();

    await expect(
      extractCreatorAgentProjectBehaviorWithDependencies(
        {
          projectPath: fixture.project,
          allowUnisolatedRead: true,
          allowSensitiveProjectContext: true,
        },
        {
          scanProject: scanCreatorProjectSourceContext,
          revalidateProject: revalidateProjectContext,
          materializeHostProject: () => Object.freeze({ projectPath: workspace, release }),
          createHost: () => host,
        },
        'AGENT_PACKAGE_AUTHORING',
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_COMPILER_HOST_FAILED' });
    expect(release).toHaveBeenCalledOnce();
    expect(host.stopCalls).toBe(1);

    const createHost = vi.fn(() => new FakeHost());
    await expect(
      extractCreatorAgentProjectBehaviorWithDependencies(
        {
          projectPath: fixture.project,
          allowUnisolatedRead: true,
          allowSensitiveProjectContext: true,
        },
        {
          scanProject: scanCreatorProjectSourceContext,
          revalidateProject: revalidateProjectContext,
          createHost,
        },
        'AGENT_PACKAGE_AUTHORING',
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_COMPILER_CONFIGURATION_INVALID' });
    expect(createHost).not.toHaveBeenCalled();
  });

  it('keeps the legacy compiler on the original Project with historical Git citations', async () => {
    const fixture = creatorProjectFixture();
    const host = new FakeHost();
    let hostProjectPath: string | undefined;
    const pending = extractCreatorAgentProjectBehaviorWithDependencies(
      {
        projectPath: fixture.project,
        allowUnisolatedRead: true,
        allowSensitiveProjectContext: true,
      },
      {
        scanProject: scanProjectContext,
        revalidateProject: revalidateProjectContext,
        createHost: (options) => {
          hostProjectPath = options.projectPath;
          return host;
        },
      },
      'LEGACY_SOURCE_RUNTIME',
    );
    await vi.waitFor(() => expect(host.controllers).toHaveLength(1));
    settleCompilerHost(host, ['.git/HEAD']);

    await expect(pending).resolves.toMatchObject({
      citedSources: [expect.objectContaining({ path: '.git/HEAD' })],
    });
    expect(hostProjectPath).toBe(fixture.project);
  });
});

function creatorProjectFixture() {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'combo-creator-source-')));
  roots.push(root);
  const project = join(root, 'project');
  git(root, ['init', '--initial-branch=main', project]);
  git(project, ['config', 'user.name', 'Combo Test']);
  git(project, ['config', 'user.email', 'combo-test@example.invalid']);
  git(project, ['remote', 'add', 'origin', 'https://github.com/dangdang-tech/Combo.git']);
  mkdirSync(join(project, 'src'));
  mkdirSync(join(project, 'tasks'));
  mkdirSync(join(project, '.codex/sessions'), { recursive: true });
  writeFileSync(join(project, 'README.md'), '# Release workflow\n', { mode: 0o600 });
  writeFileSync(join(project, 'src/index.ts'), 'export const release = true;\n', { mode: 0o600 });
  writeFileSync(join(project, 'tasks/release.json'), '{"status":"READY"}\n', { mode: 0o600 });
  git(project, ['add', 'README.md', 'src/index.ts', 'tasks/release.json']);
  git(project, ['commit', '-m', 'test: creator source fixture']);
  writeFileSync(join(project, '.git/codex-thread.json'), '{"owner":"host"}\n');
  writeFileSync(join(project, '.codex/sessions/host-task.jsonl'), '{"host":true}\n');
  writeFileSync(join(project, 'codex-thread.json'), '{"owner":"host"}\n');
  writeFileSync(join(project, 'codex-task.json'), '{"task":"host"}\n');
  writeFileSync(join(project, 'codex-session.json'), '{"session":"host"}\n');
  const outside = join(root, 'outside.txt');
  writeFileSync(outside, 'outside source that must not be followed\n');
  execFileSync('/bin/ln', ['-s', outside, join(project, 'outside-link')]);
  return Object.freeze({ root, project: realpathSync(project), outside });
}

function isPrivateHostPath(path: string): boolean {
  return (
    path === '.git' ||
    path.startsWith('.git/') ||
    path === '.codex' ||
    path.startsWith('.codex/') ||
    /(?:^|\/)codex-(?:task|thread|session)\.json$/u.test(path)
  );
}

type SnapshotEntry = Readonly<{
  path: string;
  kind: 'directory' | 'file' | 'symlink';
  mode: number;
  digest: string;
}>;

function snapshotTree(root: string, filterPrivate = true): readonly SnapshotEntry[] {
  const output: SnapshotEntry[] = [];
  const pending = [''];
  while (pending.length > 0) {
    const parent = pending.pop()!;
    const directory = parent === '' ? root : join(root, ...parent.split('/'));
    for (const entry of execFileSync('/bin/ls', ['-1A', directory], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .sort()) {
      const path = parent === '' ? entry : `${parent}/${entry}`;
      if (filterPrivate && isPrivateHostPath(path)) continue;
      const absolute = join(root, ...path.split('/'));
      const stat = lstatSync(absolute);
      const kind = stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file';
      const bytes =
        kind === 'file'
          ? readFileSync(absolute)
          : kind === 'symlink'
            ? Buffer.from(readlinkSync(absolute), 'utf8')
            : Buffer.from(kind, 'utf8');
      output.push(
        Object.freeze({
          path,
          kind,
          mode: stat.mode & 0o777,
          digest: createHash('sha256').update(bytes).digest('hex'),
        }),
      );
      if (kind === 'directory') pending.push(path);
    }
  }
  return output.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

function settleCompilerHost(host: FakeHost, sourcePaths: readonly string[]): void {
  const controller = host.controllers.at(-1);
  if (controller === undefined) throw new Error('Compiler Host controller is unavailable.');
  controller.settle(
    {
      thread: controller.handle.thread,
      turnId: controller.handle.turnId,
      completedAt: Date.now(),
      terminalStatus: 'completed',
      terminalError: 'NONE',
      outputState: 'USABLE',
    },
    {
      text: JSON.stringify({
        protocol: 'combo.creator-agent-project-context-compilation/1',
        name: 'Release reviewer',
        description: 'Reviews a release against durable Project evidence.',
        instructions: 'Read the consumer evidence and report the first release blocker.',
        starterPrompts: ['Review this release.'],
        outputDescription: 'A concise release decision with evidence.',
        sourcePaths,
        coverageSummary: 'Used the release evidence recorded in the Project.',
      }),
    },
  );
}

function git(cwd: string, arguments_: readonly string[]): string {
  return execFileSync('/usr/bin/git', arguments_, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}
