import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  digestCreatorAgentPackageFile,
  type CreatorAgentPackageManifest,
} from '@cb/creator-agent-protocol/agent-package';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { executeCreatorAgentPackageCli } from '../agent-package-cli.js';
import {
  CreatorAgentPackageAuthoringError,
  type CreatorAgentPackageAuthoringOptions,
} from '../application/agent-package-authoring.js';
import type { CreatorAgentPackageSession } from '../application/agent-package-session.js';

const roots: string[] = [];
const DIGEST = digestCreatorAgentPackageFile(Buffer.from('cli package fixture'));

afterEach(() => {
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe('Agent Package experience CLI', () => {
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

function authored(packagePath: string) {
  return {
    disposition: 'CREATED' as const,
    packagePath,
    packageDigest: DIGEST,
    manifest: {} as CreatorAgentPackageManifest,
    starterPrompts: ['Review the consumer release.'],
    sourceReceipt: {
      contextRootDigest: `sha256:${'b'.repeat(64)}` as const,
      indexedEntryCount: 1,
      indexedFileCount: 1,
      uniqueIndexedByteCount: 10,
      citedSources: [],
    },
    reloadVerified: true as const,
  };
}

function silentIo() {
  return { stdout: { write: () => undefined }, stderr: { write: () => undefined } };
}
