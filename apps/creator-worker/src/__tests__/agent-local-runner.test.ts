import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import {
  CREATOR_AGENT_DEFINITION_PROTOCOL,
  createCreatorAgentDraftSnapshot,
  freezeCreatorAgentVersion,
  type CreatorAgentVersionV1,
} from '@cb/creator-agent-protocol/agent';
import type { HostStartTurnInput } from '@cb/creator-agent-protocol/host';
import { afterEach, describe, expect, it } from 'vitest';

import { compileCreatorAgentDeveloperInstructions } from '../agent-local-runner.js';
import { createLocalAlphaBroker } from '../local-alpha-broker.js';
import { runCreatorAgentLocalTurnWithDependencies } from '../agent-local-runner.js';
import { FakeHost } from './test-fixture.js';

const ANSWER = 'AGENT_ANSWER_must_not_enter_the_manifest';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe('local immutable Creator Agent execution', () => {
  it('runs the same frozen AgentVersion in two isolated durable invocations', async () => {
    const fixture = projectFixture();
    const version = agentVersion(fixture);
    const developerInstructions: string[] = [];
    const hosts: AutoSuccessHost[] = [];

    for (let run = 0; run < 2; run += 1) {
      const host = new AutoSuccessHost();
      hosts.push(host);
      const result = await runCreatorAgentLocalTurnWithDependencies(
        {
          version,
          projectPath: fixture.project,
          prompt: `PROMPT_AGENT_RUN_${run}`,
          stateDirectory: join(fixture.root, `state.${run}`),
          allowUnisolatedRead: true,
        },
        {
          createHost(options) {
            developerInstructions.push(options.developerInstructions);
            return host;
          },
          createBroker: createLocalAlphaBroker,
        },
      );
      expect(result).toMatchObject({
        agentId: version.agentId,
        versionId: version.versionId,
        versionFingerprint: version.versionFingerprint,
        text: ANSWER,
      });
    }

    expect(developerInstructions).toHaveLength(2);
    expect(developerInstructions[0]).toBe(developerInstructions[1]);
    expect(developerInstructions[0]).toContain(version.definition.behavior.instructions);
    expect(developerInstructions[0]).toContain(version.definition.runtime.output.description);
    expect(developerInstructions[0]).not.toContain('verification evidence');
    expect(hosts.map((host) => host.inputs[0]?.text)).toEqual([
      'PROMPT_AGENT_RUN_0',
      'PROMPT_AGENT_RUN_1',
    ]);
    expect(hosts[0]?.inputs[0]?.thread).not.toBe(hosts[1]?.inputs[0]?.thread);
    expect(readFileSync(join(fixture.project, 'README.md'), 'utf8')).toBe('fixture\n');
    expect(JSON.stringify(version)).not.toContain('PROMPT_AGENT_RUN');
    expect(JSON.stringify(version)).not.toContain(ANSWER);
  });

  it('runs the pinned Git tree instead of the mutable creator working tree', async () => {
    const fixture = projectFixture();
    const version = agentVersion(fixture);
    const state = join(fixture.root, 'state.snapshot');
    const marker = join(fixture.root, 'filter-executed');
    const attributes = join(fixture.root, 'external.attributes');
    const filter = join(fixture.root, 'filter.sh');
    const includedConfig = join(fixture.root, 'included.gitconfig');
    writeFileSync(attributes, '*.md filter=demo\n', { mode: 0o600 });
    writeFileSync(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o700 });
    writeFileSync(
      includedConfig,
      `[core]\n\tattributesFile = ${attributes}\n[filter "demo"]\n\tclean = ${filter}\n\trequired = true\n`,
      { mode: 0o600 },
    );
    git(fixture.project, ['config', '--local', 'include.path', includedConfig]);
    let executionProject = '';

    const result = await runCreatorAgentLocalTurnWithDependencies(
      {
        version,
        projectPath: fixture.project,
        prompt: 'read the frozen tree',
        stateDirectory: state,
        allowUnisolatedRead: true,
      },
      {
        createHost(options) {
          executionProject = options.projectPath;
          writeFileSync(join(fixture.project, 'README.md'), 'DRIFTED_DURING_RUN\n', {
            mode: 0o600,
          });
          writeFileSync(join(fixture.project, 'untracked.txt'), 'outside snapshot\n', {
            mode: 0o600,
          });
          return new AutoSuccessHost(readFileSync(join(options.projectPath, 'README.md'), 'utf8'));
        },
        createBroker: createLocalAlphaBroker,
      },
    );

    expect(result.text).toBe('fixture\n');
    expect(executionProject).not.toBe(fixture.project);
    expect(existsSync(executionProject)).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(fixture.project, 'README.md'), 'utf8')).toBe('DRIFTED_DURING_RUN\n');
  });

  it('rejects a source mismatch or unsupported committed tree before Host side effects', async () => {
    const mismatched = projectFixture();
    const mismatchedVersion = agentVersion(mismatched);
    git(mismatched.project, [
      'remote',
      'set-url',
      'origin',
      'https://github.com/example/other.git',
    ]);
    await expectRejectedProject(mismatched, mismatchedVersion, 'state.origin');

    const linked = projectFixture();
    symlinkSync('README.md', join(linked.project, 'README.link'));
    git(linked.project, ['add', 'README.link']);
    git(linked.project, ['commit', '-m', 'test: symlink']);
    const linkedVersion = agentVersion(currentSnapshot(linked));
    await expectRejectedProject(linked, linkedVersion, 'state.symlink');

    const corrupt = projectFixture();
    const corruptVersion = agentVersion(corrupt);
    const blob = git(corrupt.project, ['rev-parse', 'HEAD:README.md']);
    const objectPath = join(corrupt.project, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
    chmodSync(objectPath, 0o600);
    writeFileSync(objectPath, deflateSync(Buffer.from('blob 8\0CORRUPT\n')));
    await expectRejectedProject(corrupt, corruptVersion, 'state.corrupt');
  });

  it('rejects a tampered version and an unsupported runtime before side effects', async () => {
    const fixture = projectFixture();
    const version = agentVersion(fixture);
    const tampered = { ...version, versionNumber: 2 } as CreatorAgentVersionV1;
    await expect(
      runCreatorAgentLocalTurnWithDependencies(
        {
          version: tampered,
          projectPath: fixture.project,
          prompt: 'must not run',
          stateDirectory: join(fixture.root, 'state.tampered'),
          allowUnisolatedRead: true,
        },
        {
          createHost: () => new AutoSuccessHost(),
          createBroker: createLocalAlphaBroker,
        },
      ),
    ).rejects.toMatchObject({ code: 'CREATOR_AGENT_VERSION_INVALID' });

    const unsupportedDraft = createCreatorAgentDraftSnapshot({
      agentId: version.agentId,
      draftId: 'draft.unsupported',
      draftRevision: 2,
      baseVersionId: version.versionId,
      definition: {
        ...version.definition,
        requirements: { ...version.definition.requirements, plugins: ['private-plugin'] },
      },
    });
    const unsupported = freezeCreatorAgentVersion({
      versionId: 'version.unsupported',
      versionNumber: 2,
      createdAtMs: version.createdAtMs + 1,
      draft: unsupportedDraft,
    });
    expect(() => compileCreatorAgentDeveloperInstructions(unsupported)).toThrow(
      expect.objectContaining({ code: 'CREATOR_AGENT_RUNTIME_UNSUPPORTED' }),
    );
  });
});

class AutoSuccessHost extends FakeHost {
  public constructor(private readonly answer = ANSWER) {
    super();
  }

  public override async createThread() {
    const thread = await super.createThread();
    return Object.freeze({
      ...thread,
      id: `thread.agent.${Math.random().toString(16).slice(2)}` as typeof thread.id,
    });
  }

  public override async startTurn(input: HostStartTurnInput) {
    const handle = await super.startTurn(input);
    const controller = this.controllers.at(-1);
    if (controller === undefined) throw new Error('Test Host controller was not created.');
    queueMicrotask(() => {
      controller.settle(
        {
          thread: handle.thread,
          turnId: handle.turnId,
          completedAt: Date.now(),
          terminalStatus: 'completed',
          terminalError: 'NONE',
          outputState: 'USABLE',
        },
        { text: this.answer },
      );
    });
    return handle;
  }
}

type ProjectFixture = Readonly<{
  root: string;
  project: string;
  repositoryUrl: string;
  sourceRef: string;
  commitSha: string;
  treeSha: string;
}>;

function projectFixture(): ProjectFixture {
  const root = mkdtempSync(join(tmpdir(), 'combo-creator-agent-'));
  roots.push(root);
  chmodSync(root, 0o700);
  const project = join(root, 'project');
  git(root, ['init', '--initial-branch=main', project]);
  git(project, ['config', 'user.name', 'Combo Test']);
  git(project, ['config', 'user.email', 'combo-test@example.invalid']);
  const repositoryUrl = 'https://github.com/dangdang-tech/Combo.git';
  git(project, ['remote', 'add', 'origin', repositoryUrl]);
  writeFileSync(join(project, 'README.md'), 'fixture\n', { mode: 0o600 });
  mkdirSync(join(project, 'src'), { mode: 0o700 });
  writeFileSync(join(project, 'src', 'index.ts'), 'export const fixture = true;\n', {
    mode: 0o600,
  });
  git(project, ['add', '.']);
  git(project, ['commit', '-m', 'test: fixture']);
  return Object.freeze({
    root,
    project,
    repositoryUrl,
    sourceRef: git(project, ['symbolic-ref', '-q', 'HEAD']),
    commitSha: git(project, ['rev-parse', 'HEAD^{commit}']),
    treeSha: git(project, ['rev-parse', 'HEAD^{tree}']),
  });
}

function agentVersion(fixture: ProjectFixture): CreatorAgentVersionV1 {
  const draft = createCreatorAgentDraftSnapshot({
    agentId: 'agent.local.release-review',
    draftId: 'draft.local.release-review.1',
    draftRevision: 1,
    baseVersionId: null,
    definition: {
      protocol: CREATOR_AGENT_DEFINITION_PROTOCOL,
      name: 'Release evidence reviewer',
      description: 'Reviews a release using one frozen creator method.',
      projectSnapshot: {
        kind: 'git',
        repositoryUrl: fixture.repositoryUrl,
        sourceRef: fixture.sourceRef,
        commitSha: fixture.commitSha,
        treeSha: fixture.treeSha,
      },
      behavior: {
        instructions: 'Inspect evidence, identify blockers, and never guess missing facts.',
        starterPrompts: ['Review this release candidate.'],
      },
      requirements: {
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
        output: { kind: 'text', description: 'An evidence-backed review.' },
        turnTimeoutMs: 10_000,
      },
    },
  });
  return freezeCreatorAgentVersion({
    versionId: 'version.local.release-review.1',
    versionNumber: 1,
    createdAtMs: 1_787_413_200_000,
    draft,
  });
}

function currentSnapshot(fixture: ProjectFixture): ProjectFixture {
  return Object.freeze({
    ...fixture,
    sourceRef: git(fixture.project, ['symbolic-ref', '-q', 'HEAD']),
    commitSha: git(fixture.project, ['rev-parse', 'HEAD^{commit}']),
    treeSha: git(fixture.project, ['rev-parse', 'HEAD^{tree}']),
  });
}

async function expectRejectedProject(
  fixture: ProjectFixture,
  version: CreatorAgentVersionV1,
  stateName: string,
): Promise<void> {
  let hostFactories = 0;
  let brokerFactories = 0;
  await expect(
    runCreatorAgentLocalTurnWithDependencies(
      {
        version,
        projectPath: fixture.project,
        prompt: 'must not run',
        stateDirectory: join(fixture.root, stateName),
        allowUnisolatedRead: true,
      },
      {
        createHost() {
          hostFactories += 1;
          return new AutoSuccessHost();
        },
        async createBroker() {
          brokerFactories += 1;
          return createLocalAlphaBroker('installation.unreachable');
        },
      },
    ),
  ).rejects.toMatchObject({ code: 'CREATOR_AGENT_PROJECT_MISMATCH' });
  expect(hostFactories).toBe(0);
  expect(brokerFactories).toBe(0);
}

function git(cwd: string, arguments_: readonly string[]): string {
  return execFileSync('git', arguments_, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trimEnd();
}
