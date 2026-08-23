import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CREATOR_AGENT_DEFINITION_PROTOCOL,
  createCreatorAgentDraftHandoff,
  createCreatorAgentDraftSnapshot,
  serializeCreatorAgentDraftHandoff,
} from '@cb/creator-agent-protocol/agent';
import {
  createFreshCreatorAgentCatalog,
  openExistingCreatorAgentCatalog,
} from '@cb/creator-agent-persistence';
import { afterEach, describe, expect, it } from 'vitest';

import { runCreatorAgentLocalTurn } from '../index.js';

const enabled = process.env.COMBO_REAL_CODEX_E2E === '1';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.runIf(enabled)('immutable Creator Agent real gate', () => {
  it('freezes, reopens, and runs one exact Version through bundled Codex', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'combo-real-creator-agent-')));
    temporaryDirectories.push(root);
    const projectPath = join(root, 'creator-project');
    const stateDirectory = join(root, 'state');
    await mkdir(projectPath, { mode: 0o700 });
    git(root, ['init', '--initial-branch=main', projectPath]);
    git(projectPath, ['config', 'user.name', 'Combo Test']);
    git(projectPath, ['config', 'user.email', 'combo-test@example.invalid']);
    git(projectPath, ['remote', 'add', 'origin', 'https://github.com/dangdang-tech/Combo.git']);
    const answer = `combo-agent-${randomUUID()}`;
    const promptMarker = `agent-prompt-${randomUUID()}`;
    await writeFile(join(projectPath, 'CANARY.txt'), `${answer}\n`, { mode: 0o600 });
    git(projectPath, ['add', 'CANARY.txt']);
    git(projectPath, ['commit', '-m', 'test: immutable agent fixture']);
    const draft = createCreatorAgentDraftSnapshot({
      agentId: 'agent.real.canary',
      draftId: 'draft.real.canary.1',
      draftRevision: 1,
      baseVersionId: null,
      definition: {
        protocol: CREATOR_AGENT_DEFINITION_PROTOCOL,
        name: 'Exact canary reader',
        description: 'Reads one fixed canary from an immutable Project snapshot.',
        projectSnapshot: {
          kind: 'git',
          repositoryUrl: 'https://github.com/dangdang-tech/Combo.git',
          sourceRef: 'refs/heads/main',
          commitSha: git(projectPath, ['rev-parse', 'HEAD^{commit}']),
          treeSha: git(projectPath, ['rev-parse', 'HEAD^{tree}']),
        },
        behavior: {
          instructions:
            'Read CANARY.txt when asked and return only its single line without punctuation.',
          starterPrompts: ['Read the immutable canary.'],
        },
        requirements: {
          codexVersion: '0.148.0-alpha.15',
          commands: [],
          plugins: [],
          environmentVariableNames: [],
        },
        authoringSource: { kind: 'codex_current_task', rawStored: false },
        runtime: {
          contextProfile: 'PROJECT_TREE_READ_ONLY_V1',
          permissionProfile: 'LOCAL_UNISOLATED_READ_ONLY_V1',
          skills: [],
          dynamicTools: [],
          toolNetworkAccess: false,
          output: { kind: 'text', description: 'The exact canary line.' },
          turnTimeoutMs: 120_000,
        },
      },
    });
    const catalogPath = join(root, 'agent-catalog.sqlite');
    const catalogOptions = Object.freeze({
      filename: catalogPath,
      catalogIdentity: 'catalog.real.creator-agent',
    });
    const catalog = createFreshCreatorAgentCatalog(catalogOptions);
    catalog.importDraftHandoff(
      serializeCreatorAgentDraftHandoff(createCreatorAgentDraftHandoff({ draft })),
    );
    const review = catalog.createFreezeReview({
      agentId: draft.agentId,
      draftId: draft.draftId,
      draftRevision: draft.draftRevision,
    });
    const frozen = catalog.freezeDraft({
      ref: {
        agentId: draft.agentId,
        draftId: draft.draftId,
        draftRevision: draft.draftRevision,
      },
      confirmationText: review.confirmationText,
    }).version;
    catalog.close();
    const reopened = openExistingCreatorAgentCatalog(catalogOptions);
    const version = reopened.readVersion({
      agentId: frozen.agentId,
      versionId: frozen.versionId,
    });
    reopened.close();
    expect(version).toEqual(frozen);
    const before = await snapshotDirectory(projectPath);

    const result = await runCreatorAgentLocalTurn({
      version,
      projectPath,
      stateDirectory,
      prompt: `${promptMarker}. Read CANARY.txt and reply with exactly its single line.`,
      allowUnisolatedRead: true,
    });

    expect(result.text).toBe(answer);
    expect(result.versionFingerprint).toBe(version.versionFingerprint);
    expect(await snapshotDirectory(projectPath)).toEqual(before);
    const durable = await readDurableBytes(stateDirectory);
    expect(durable).not.toContain(promptMarker);
    expect(durable).not.toContain(answer);
    const catalogBytes = await readFile(catalogPath, 'utf8');
    expect(catalogBytes).not.toContain(promptMarker);
    expect(catalogBytes).not.toContain(answer);
    expect(catalogBytes).not.toContain(projectPath);
  }, 180_000);
});

function git(cwd: string, arguments_: readonly string[]): string {
  return execFileSync('git', arguments_, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trimEnd();
}

async function snapshotDirectory(path: string): Promise<readonly string[]> {
  const names = (await readdir(path)).filter((name) => name !== '.git').sort();
  return Promise.all(
    names.map(async (name) => {
      const content = await readFile(join(path, name));
      return `${name}:${createHash('sha256').update(content).digest('hex')}`;
    }),
  );
}

async function readDurableBytes(stateDirectory: string): Promise<string> {
  const names = await readdir(stateDirectory);
  const contents = await Promise.all(
    names
      .filter((name) => name.includes('.sqlite'))
      .map((name) => readFile(join(stateDirectory, name))),
  );
  return Buffer.concat(contents).toString('utf8');
}
