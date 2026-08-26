import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  digestCreatorAgentPackageFile,
  type CreatorAgentPackageManifest,
} from '@cb/creator-agent-protocol/agent-package';
import {
  CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_PROTOCOL,
  CREATOR_AGENT_PACKAGE_DRAFT_PROTOCOL,
  createCreatorAgentPackageDraftSnapshot,
  parseCreatorAgentPackageDraftSnapshot,
} from '@cb/creator-agent-protocol/agent-package-draft';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { executeCreatorAgentPackageCli } from '../agent-package-cli.js';
import {
  CreatorAgentPackageAuthoringError,
  type CreatorAgentPackageAuthoringOptions,
  type CreatorAgentPackageAuthoringResult,
} from '../application/agent-package-authoring.js';
import type { CreatorAgentPackageSession } from '../application/agent-package-session.js';

const roots: string[] = [];
const DIGEST = digestCreatorAgentPackageFile(Buffer.from('cli package fixture'));

afterEach(() => {
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe('Agent Package experience CLI', () => {
  it('creates a reviewable Draft from one sentence and the bound working Project without path input', async () => {
    const fixture = cliFixture();
    const writes = { stdout: '', stderr: '' };
    const draft = draftFixture();
    const authorDraft = vi.fn(async () => ({
      readDraft: () => draft,
      revise: () => draft,
      compile: () => ({
        ...authored(fixture.package),
        draftId: draft.draftId,
        draftRevision: draft.revision,
        draftFingerprint: draft.draftFingerprint,
      }),
    }));
    const startSession = vi.fn(async () => new FakeSession());

    const exit = await executeCreatorAgentPackageCli(
      ['draft-current', '--', '请把当前目录跑通的发布流程提炼成一个 Agent。'],
      {
        stdout: { write: (chunk) => (writes.stdout += chunk) },
        stderr: { write: (chunk) => (writes.stderr += chunk) },
      },
      {
        authorPackage: async () => authored(fixture.package),
        authorDraft,
        startSession,
        currentProjectDirectory: () => fixture.source,
        defaultStoreDirectory: () => fixture.store,
        prepareStore: (path) => path,
      },
      new AbortController().signal,
    );

    expect(exit).toBe(0);
    expect(authorDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          protocol: CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_PROTOCOL,
          intent: 'create_agent_package_from_current_project',
        }),
        currentProjectPath: fixture.source,
      }),
    );
    expect(parseCreatorAgentPackageDraftSnapshot(writes.stdout.trim())).toEqual(draft);
    expect(writes.stdout).not.toContain(fixture.source);
    expect(writes.stderr).toContain('[Draft 1/2]');
    expect(writes.stderr).toContain('[Draft 2/2]');
    expect(startSession).not.toHaveBeenCalled();
  });

  it('rejects an empty or non-portable creator sentence with an actionable CLI error', async () => {
    const fixture = cliFixture();
    const authorDraft = vi.fn();
    const dependencies = {
      authorPackage: async () => authored(fixture.package),
      authorDraft,
      startSession: async () => new FakeSession(),
      currentProjectDirectory: () => fixture.source,
      defaultStoreDirectory: () => fixture.store,
      prepareStore: (path: string) => path,
    };

    for (const request of ['   ', '请读取 /Users/alice/private.md']) {
      await expect(
        executeCreatorAgentPackageCli(
          ['draft-current', request],
          silentIo(),
          dependencies,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        code: 'AGENT_PACKAGE_CLI_INVALID',
        message: expect.stringContaining('Draft-current'),
      });
    }
    expect(authorDraft).not.toHaveBeenCalled();
  });

  it('runs the package-draft wrapper and preserves its separator contract', () => {
    const result = runPackageScript('package-draft', ['--', '   ']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('AGENT_PACKAGE_CLI_INVALID');
    expect(result.stderr).toContain('Draft-current requires one non-empty creator request');
    expect(result.stderr).not.toContain('CreatorAgentPackageCliError');
  }, 30_000);

  it('authors, reloads, and consumes the exact Package for two turns without confirmation', async () => {
    const fixture = cliFixture();
    const writes = { stdout: '', stderr: '' };
    const session = new FakeSession();
    const authorPackage = vi.fn(async (options: CreatorAgentPackageAuthoringOptions) => {
      options.diagnosticSink?.('index_started');
      options.indexProgressSink?.({
        phase: 'CONTENT_SCAN',
        entryCount: 12,
        fileCount: 8,
        uniqueBytesRead: 2_048,
      });
      return authored(fixture.package);
    });

    const exit = await executeCreatorAgentPackageCli(
      ['experience', fixture.source, fixture.consumer],
      {
        stdout: { write: (chunk) => (writes.stdout += chunk) },
        stderr: { write: (chunk) => (writes.stderr += chunk) },
      },
      {
        authorPackage,
        startSession: async () => session,
        defaultStoreDirectory: () => fixture.store,
        prepareStore: (path) => path,
      },
      new AbortController().signal,
    );

    expect(exit).toBe(0);
    expect(authorPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceProjectPath: fixture.source,
        storeDirectory: fixture.store,
        allowUnisolatedRead: true,
        allowSensitiveProjectContext: true,
      }),
    );
    expect(session.messages).toEqual([
      'Review the consumer release.',
      expect.stringContaining('same conversation'),
    ]);
    expect(session.closeCalls).toBe(1);
    expect(writes.stdout).toContain(DIGEST);
    expect(writes.stdout).toContain('answer-1\nanswer-2');
    expect(writes.stderr).toContain('已索引 12 个条目、8 个文件，读取 2.0 KiB');
    expect(writes.stderr).toContain('[5/5]');
  });

  it('accepts the pnpm separator after experience and rejects additional separators', async () => {
    const fixture = cliFixture();
    const authorPackage = vi.fn(async () => authored(fixture.package));
    const session = new FakeSession();

    await expect(
      executeCreatorAgentPackageCli(
        ['experience', '--', fixture.source, fixture.consumer],
        silentIo(),
        {
          authorPackage,
          startSession: async () => session,
          defaultStoreDirectory: () => fixture.store,
          prepareStore: (path) => path,
        },
        new AbortController().signal,
      ),
    ).resolves.toBe(0);
    expect(authorPackage).toHaveBeenCalledTimes(1);

    await expect(
      executeCreatorAgentPackageCli(
        ['experience', '--', '--', fixture.source, fixture.consumer],
        silentIo(),
        {
          authorPackage,
          startSession: async () => new FakeSession(),
          defaultStoreDirectory: () => fixture.store,
          prepareStore: (path) => path,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'AGENT_PACKAGE_CLI_INVALID',
      message: 'Experience requires exactly two absolute Project paths.',
    });
    expect(authorPackage).toHaveBeenCalledTimes(1);
  });

  it('runs the documented pnpm wrapper and reports the actionable overlap error', () => {
    const fixture = cliFixture();
    const withSeparator = runPackageExperience(['--', fixture.source, fixture.source]);
    const withoutSeparator = runPackageExperience([fixture.source, fixture.source]);

    for (const result of [withSeparator, withoutSeparator]) {
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('AGENT_PACKAGE_CLI_INVALID');
      expect(result.stderr).toContain('Source and consumer Projects must be separate directories.');
      expect(result.stderr).not.toContain(
        'Experience requires exactly two absolute Project paths.',
      );
      expect(result.stderr).not.toContain('CreatorAgentPackageCliError');
    }

    const missingPath = join(fixture.source, 'missing');
    const unknownFailure = runPackageExperience(['--', missingPath, fixture.consumer]);
    expect(unknownFailure.status).toBe(1);
    expect(unknownFailure.stderr).toBe(
      'Agent Package 流程失败 [ENOENT]：未完成的阶段已安全停止。\n',
    );
    expect(unknownFailure.stderr).not.toContain(missingPath);
    expect(unknownFailure.stderr).not.toContain('no such file');
    expect(unknownFailure.stderr).not.toContain('Error:');
  }, 30_000);

  it('rejects overlapping Projects before authoring and closes the Session after a turn failure', async () => {
    const fixture = cliFixture();
    const authorPackage = vi.fn(async () => authored(fixture.package));
    await expect(
      executeCreatorAgentPackageCli(
        ['experience', fixture.source, fixture.source],
        silentIo(),
        {
          authorPackage,
          startSession: async () => new FakeSession(),
          defaultStoreDirectory: () => fixture.store,
          prepareStore: (path) => path,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'AGENT_PACKAGE_CLI_INVALID' });
    expect(authorPackage).not.toHaveBeenCalled();

    const session = new FakeSession();
    session.failure = new Error('TURN_CANARY');
    let trialRecovery = '';
    await expect(
      executeCreatorAgentPackageCli(
        ['experience', fixture.source, fixture.consumer],
        {
          stdout: { write: () => undefined },
          stderr: { write: (chunk) => (trialRecovery += chunk) },
        },
        {
          authorPackage,
          startSession: async () => session,
          defaultStoreDirectory: () => fixture.store,
          prepareStore: (path) => path,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('TURN_CANARY');
    expect(session.closeCalls).toBe(1);
    expect(trialRecovery).toContain('只有试跑未完成，请不要重新提取');

    const committedPath = join(fixture.store, 'sha256-committed');
    let recovery = '';
    await expect(
      executeCreatorAgentPackageCli(
        ['experience', fixture.source, fixture.consumer],
        { stdout: { write: () => undefined }, stderr: { write: (chunk) => (recovery += chunk) } },
        {
          authorPackage: async () => {
            throw new CreatorAgentPackageAuthoringError(
              'AGENT_PACKAGE_AUTHORING_PUBLISH_FAILED',
              'PUBLISH_CANARY',
              { packagePath: committedPath },
            );
          },
          startSession: async () => new FakeSession(),
          defaultStoreDirectory: () => fixture.store,
          prepareStore: (path) => path,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('PUBLISH_CANARY');
    expect(recovery).toContain(committedPath);
    expect(recovery).toContain('发布或正式重载未完整');
    expect(recovery).not.toContain('只有试跑未完成');
  });
});

class FakeSession implements CreatorAgentPackageSession {
  public readonly packageDigest = DIGEST;
  public state = 'READY' as const;
  public readonly messages: string[] = [];
  public closeCalls = 0;
  public failure?: Error;

  public async send(message: string): Promise<string> {
    this.messages.push(message);
    if (this.failure !== undefined) throw this.failure;
    return `answer-${this.messages.length}`;
  }

  public async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function cliFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'combo-agent-package-cli-')));
  roots.push(root);
  const source = join(root, 'source');
  const consumer = join(root, 'consumer');
  const store = join(root, 'store');
  const packagePath = join(store, 'sha256-fixture');
  for (const path of [source, consumer, store, packagePath]) mkdirSync(path, { mode: 0o700 });
  return { source, consumer, store, package: packagePath };
}

function authored(packagePath: string): CreatorAgentPackageAuthoringResult {
  return {
    disposition: 'CREATED' as const,
    packagePath,
    packageDigest: DIGEST,
    manifest: {} as CreatorAgentPackageManifest,
    starterPrompts: ['Review the consumer release.'],
    sourceReceipt: {
      protocol: 'combo.agent-package-source-receipt/1' as const,
      sourceKind: 'current_project' as const,
      contextRootDigest: DIGEST,
      indexedEntryCount: 1,
      indexedFileCount: 1,
      uniqueIndexedByteCount: 10,
      coverageSummary: 'One release method shaped this Agent.',
      citedSources: [{ path: 'method.md', digest: DIGEST }],
    },
    reloadVerified: true as const,
  };
}

function draftFixture() {
  return createCreatorAgentPackageDraftSnapshot({
    protocol: CREATOR_AGENT_PACKAGE_DRAFT_PROTOCOL,
    draftId: `draft.agent-package.${'1'.repeat(32)}`,
    revision: 1,
    parentDraftFingerprint: null,
    creatorRequest: {
      protocol: CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_PROTOCOL,
      intent: 'create_agent_package_from_current_project',
      request: '请把当前目录跑通的发布流程提炼成一个 Agent。',
    },
    source: {
      kind: 'current_project',
      contextRootDigest: `sha256:${'c'.repeat(64)}`,
      indexedEntryCount: 1,
      indexedFileCount: 1,
      uniqueIndexedByteCount: 10,
      coverageSummary: '发布流程定义了可复用方法。',
      citedSources: [{ path: 'combo.workflow.md', digest: `sha256:${'d'.repeat(64)}` }],
    },
    content: {
      name: '发布验收 Agent',
      description: '根据项目证据执行发布验收。',
      instructions: '核对版本身份、运行门槛和发布证据。',
      starterPrompts: ['检查这个发布候选。'],
      outputDescription: '返回结论、阻断项和证据。',
    },
  });
}

function silentIo() {
  return { stdout: { write: () => undefined }, stderr: { write: () => undefined } };
}

function runPackageExperience(arguments_: readonly string[]) {
  return runPackageScript('package-experience', arguments_);
}

function runPackageScript(
  script: 'package-draft' | 'package-experience',
  arguments_: readonly string[],
) {
  const npmExecPath = process.env.npm_execpath;
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const command = npmExecPath === undefined ? 'pnpm' : process.execPath;
  const prefix = npmExecPath === undefined ? [] : [npmExecPath];
  return spawnSync(
    command,
    [...prefix, '--silent', '--dir', 'apps/creator-worker', script, ...arguments_],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      timeout: 20_000,
    },
  );
}
