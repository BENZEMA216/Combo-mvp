import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createFreshCreatorAgentCatalog,
  openExistingCreatorAgentCatalog,
  type CreatorAgentCatalogOptions,
} from '@cb/creator-agent-persistence';
import {
  CREATOR_AGENT_DEFINITION_PROTOCOL,
  CREATOR_AGENT_DEFINITION_V2_PROTOCOL,
  CREATOR_AGENT_DEFINITION_V3_PROTOCOL,
  createCreatorAgentDefinitionV2,
  createCreatorAgentDefinitionV3,
  createCreatorAgentDraftHandoff,
  createCreatorAgentDraftHandoffV2,
  createCreatorAgentDraftHandoffV3,
  createCreatorAgentDraftSnapshot,
  createCreatorAgentDraftSnapshotV2,
  createCreatorAgentDraftSnapshotV3,
  createCreatorAgentProjectSourceLedger,
  serializeCreatorAgentDraftHandoff,
  serializeCreatorAgentDraftHandoffV2,
  serializeCreatorAgentDraftHandoffV3,
  type CreatorAgentVersion,
  type CreatorAgentDraftSnapshotV1,
} from '@cb/creator-agent-protocol/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { executeCreatorAgentCatalogCli } from '../agent-catalog-cli.js';
import type { CreatorAgentLocalTurnOptions } from '../agent-local-contract.js';
import type {
  CreatorAgentProjectCompilationOptions,
  CreatorAgentProjectCompilationResult,
} from '../project-context-compiler.js';

const roots: string[] = [];
const CATALOG_IDENTITY = 'combo.local.creator-agent-catalog.v1';

afterEach(() => {
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe('Creator Agent Catalog CLI', () => {
  it('compiles, reviews, confirms, freezes, reopens, and optionally runs in one create command', async () => {
    const fixture = cliFixture();
    const project = realpathSync(mkdtempSync(join(fixture.root, 'compiled-project-')));
    const compiledDraft = compiledDraftV2();
    const handoff = createCreatorAgentDraftHandoffV2({ draft: compiledDraft });
    const compilation: CreatorAgentProjectCompilationResult = Object.freeze({
      draft: compiledDraft,
      handoff,
      handoffText: serializeCreatorAgentDraftHandoffV2(handoff),
      report: Object.freeze({
        contextRootDigest: `sha256:${'c'.repeat(64)}`,
        indexedEntryCount: 9,
        indexedFileCount: 7,
        indexedByteCount: 1234,
        uniqueIndexedByteCount: 1234,
        hardlinkAliasCount: 0,
        runtimeContext: 'GIT_SNAPSHOT',
        categories: Object.freeze({
          configuration: 1,
          documentation: 1,
          git: 1,
          log: 1,
          secret_candidate: 1,
          source: 2,
          task_record: 1,
          other: 1,
        }),
        citedSources: Object.freeze([
          Object.freeze({
            path: 'README.md',
            digest: `sha256:${'d'.repeat(64)}` as const,
            executionAvailability: 'FIXED_GIT_TREE' as const,
          }),
        ]),
        coverageSummary: 'Indexed the complete Project and cited the behavior-defining sources.',
      }),
    });
    const compileProject = vi.fn(async () => compilation);
    const runAgentTurn = vi.fn(async () => Object.freeze({ text: 'created agent answer' }));

    const result = await invoke(
      [
        'create',
        '--catalog',
        fixture.catalog,
        '--project',
        project,
        '--allow-unisolated-read',
        '--allow-sensitive-project-context',
        '--run-prompt',
        'Use the new Agent.',
      ],
      runAgentTurn,
      compileProject,
      'FREEZE',
    );

    expect(result.exit).toBe(0);
    expect(result.stderr).toContain('Project 全量索引与 Agent 编译报告');
    expect(result.stderr).toContain(compiledDraft.draftFingerprint);
    expect(result.stdout).toContain('"contextRootDigest"');
    expect(result.stdout).toContain('created agent answer');
    expect(compileProject).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: project,
        allowUnisolatedRead: true,
        allowSensitiveProjectContext: true,
      }),
    );
    expect(runAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Use the new Agent.', projectPath: project }),
    );
    const catalog = openCatalog(fixture.catalog);
    expect(catalog.listVersions(compiledDraft.agentId)).toHaveLength(1);
    catalog.close();
  });

  it('freezes and runs a behavior-only create result without mounting the authoring Project', async () => {
    const fixture = cliFixture();
    const project = realpathSync(mkdtempSync(join(fixture.root, 'aggregate-project-')));
    const compiledDraft = compiledDraftV3();
    const handoff = createCreatorAgentDraftHandoffV3({ draft: compiledDraft });
    const compilation: CreatorAgentProjectCompilationResult = Object.freeze({
      draft: compiledDraft,
      handoff,
      handoffText: serializeCreatorAgentDraftHandoffV3(handoff),
      report: Object.freeze({
        contextRootDigest: `sha256:${'e'.repeat(64)}`,
        indexedEntryCount: 12,
        indexedFileCount: 8,
        indexedByteCount: 2048,
        uniqueIndexedByteCount: 1024,
        hardlinkAliasCount: 2,
        runtimeContext: 'BEHAVIOR_ONLY',
        categories: Object.freeze({
          configuration: 1,
          documentation: 2,
          git: 3,
          log: 1,
          secret_candidate: 1,
          source: 2,
          task_record: 1,
          other: 1,
        }),
        citedSources: Object.freeze([
          Object.freeze({
            path: 'root-notes.md',
            digest: `sha256:${'f'.repeat(64)}` as const,
            executionAvailability: 'AUTHORING_ONLY' as const,
          }),
        ]),
        coverageSummary: 'Used the aggregate authoring corpus to freeze reusable behavior.',
      }),
    });
    const runAgentTurn = vi.fn(async () => Object.freeze({ text: 'behavior-only answer' }));

    const result = await invoke(
      [
        'create',
        '--catalog',
        fixture.catalog,
        '--project',
        project,
        '--allow-unisolated-read',
        '--allow-sensitive-project-context',
        '--run-prompt',
        'Use the behavior-only Agent.',
      ],
      runAgentTurn,
      async () => compilation,
      'FREEZE',
    );

    expect(result.exit).toBe(0);
    expect(result.stderr).toContain('运行时不挂载原 Project');
    expect(result.stdout).toContain('"runtimeContext": "BEHAVIOR_ONLY"');
    expect(runAgentTurn).toHaveBeenCalledWith(
      expect.not.objectContaining({ projectPath: expect.anything() }),
    );
    const catalog = openCatalog(fixture.catalog);
    const [version] = catalog.listVersions(compiledDraft.agentId);
    catalog.close();
    expect(version?.definition.protocol).toBe(CREATOR_AGENT_DEFINITION_V3_PROTOCOL);

    const manualRun = vi.fn(async () => Object.freeze({ text: 'must not run' }));
    await expect(
      invoke(
        [
          'run',
          '--catalog',
          fixture.catalog,
          '--agent-id',
          compiledDraft.agentId,
          '--version-id',
          String(version?.versionId),
          '--project',
          project,
          '--prompt',
          'Do not mount the corpus.',
          '--allow-unisolated-read',
        ],
        manualRun,
      ),
    ).rejects.toMatchObject({ code: 'AGENT_CLI_INVALID' });
    expect(manualRun).not.toHaveBeenCalled();
  });

  it('runs a Git-backed local experience non-interactively from one Project argument', async () => {
    const fixture = cliFixture();
    const project = realpathSync(mkdtempSync(join(fixture.root, 'experience-git-project-')));
    const compilation = compiledResultV2();
    const compileProject = vi.fn(async () => compilation);
    const runAgentTurn = vi.fn(async () => Object.freeze({ text: 'one-command answer' }));

    const result = await invoke(
      ['experience', project],
      runAgentTurn,
      compileProject,
      undefined,
      fixture.catalog,
    );

    expect(result.exit).toBe(0);
    expect(result.confirmationReads).toBe(0);
    expect(result.stderr).toContain('本地体验模式');
    expect(result.stderr).toContain('[4/4]');
    expect(result.stdout).toContain('one-command answer');
    expect(compileProject).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: project,
        allowUnisolatedRead: true,
        allowSensitiveProjectContext: true,
        allowLoopbackProxy: true,
      }),
    );
    expect(runAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: project,
        prompt: compilation.draft.definition.behavior.starterPrompts[0],
      }),
    );
    const catalog = openCatalog(fixture.catalog);
    expect(catalog.listVersions(compilation.draft.agentId)).toHaveLength(1);
    catalog.close();
  });

  it('runs a behavior-only local experience without mounting its authoring Project', async () => {
    const fixture = cliFixture();
    const project = realpathSync(mkdtempSync(join(fixture.root, 'experience-aggregate-')));
    const compilation = compiledResultV3();
    const runAgentTurn = vi.fn(async () => Object.freeze({ text: 'behavior-only experience' }));

    const result = await invoke(
      ['experience', project],
      runAgentTurn,
      async () => compilation,
      undefined,
      fixture.catalog,
    );

    expect(result.exit).toBe(0);
    expect(result.confirmationReads).toBe(0);
    expect(result.stdout).toContain('behavior-only experience');
    expect(runAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: compilation.draft.definition.behavior.starterPrompts[0] }),
    );
    expect(runAgentTurn).toHaveBeenCalledWith(
      expect.not.objectContaining({ projectPath: expect.anything() }),
    );
  });

  it('reports that the exact Agent exists when only the experience trial fails', async () => {
    const fixture = cliFixture();
    const project = realpathSync(mkdtempSync(join(fixture.root, 'experience-trial-failure-')));
    const compilation = compiledResultV3();
    const trialFailure = new Error('TRIAL_CANARY');

    let failure: unknown;
    try {
      await invoke(
        ['experience', project],
        async () => Promise.reject(trialFailure),
        async () => compilation,
        undefined,
        fixture.catalog,
      );
    } catch (error) {
      failure = error;
    }

    const catalog = openCatalog(fixture.catalog);
    const [version] = catalog.listVersions(compilation.draft.agentId);
    catalog.close();
    expect(version).toBeDefined();
    expect(failure).toMatchObject({
      code: 'AGENT_EXPERIENCE_RUN_FAILED',
      cause: trialFailure,
      message: expect.stringContaining(`versionId=${version?.versionId}`),
    });
    expect((failure as Error).message).toContain('请不要重复运行 experience');
  });

  it('requires explicit sensitive-context authorization before scanning or opening a catalog', async () => {
    const fixture = cliFixture();
    const project = realpathSync(mkdtempSync(join(fixture.root, 'unauthorized-project-')));
    const compileProject = vi.fn();

    await expect(
      invoke(
        ['create', '--catalog', fixture.catalog, '--project', project, '--allow-unisolated-read'],
        undefined,
        compileProject,
        'FREEZE',
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_CONTEXT_AUTHORIZATION_REQUIRED' });
    expect(compileProject).not.toHaveBeenCalled();
    expect(() => openCatalog(fixture.catalog)).toThrow();
  });

  it('preflights TTY, run input, and explicit state before compiling or freezing', async () => {
    const fixture = cliFixture();
    const project = realpathSync(mkdtempSync(join(fixture.root, 'preflight-project-')));
    const promptFile = join(fixture.root, 'prompt.txt');
    writePrivate(promptFile, 'prompt');
    const compileProject = vi.fn();
    const base = [
      'create',
      '--catalog',
      fixture.catalog,
      '--project',
      project,
      '--allow-unisolated-read',
      '--allow-sensitive-project-context',
    ] as const;

    await expect(invoke(base, undefined, compileProject)).rejects.toMatchObject({
      code: 'AGENT_CONFIRMATION_REQUIRED',
    });
    await expect(
      invoke(
        [...base, '--run-prompt', 'inline', '--run-prompt-file', promptFile],
        undefined,
        compileProject,
        'FREEZE',
      ),
    ).rejects.toMatchObject({ code: 'AGENT_CLI_INVALID' });
    await expect(
      invoke([...base, '--state-dir', fixture.root], undefined, compileProject, 'FREEZE'),
    ).rejects.toMatchObject({ code: 'AGENT_CLI_INVALID' });

    expect(compileProject).not.toHaveBeenCalled();
    expect(() => openCatalog(fixture.catalog)).toThrow();
  });

  it('imports, reviews, freezes, reopens, and runs one exact Version', async () => {
    const fixture = cliFixture();
    await invoke(['init', '--catalog', fixture.catalog]);
    const first = draft(1, null);
    writePrivate(fixture.handoff, handoffText(first));
    const imported = await invoke([
      'import',
      '--catalog',
      fixture.catalog,
      '--handoff-file',
      fixture.handoff,
    ]);
    expect(imported.stdout).toContain('"disposition": "IMPORTED"');
    expect(imported.stdout).toContain(first.draftFingerprint);

    const reviewed = await invoke([
      'review',
      '--catalog',
      fixture.catalog,
      '--agent-id',
      first.agentId,
      '--draft-id',
      first.draftId,
      '--draft-revision',
      '1',
    ]);
    expect(reviewed.stdout).toContain(first.definition.behavior.instructions);
    expect(reviewed.stdout).toContain(first.draftFingerprint);
    const catalog = openCatalog(fixture.catalog);
    const review = catalog.createFreezeReview(ref(first));
    catalog.close();
    writePrivate(fixture.confirmation, review.confirmationText);

    const frozen = await invoke([
      'freeze',
      '--catalog',
      fixture.catalog,
      '--agent-id',
      first.agentId,
      '--draft-id',
      first.draftId,
      '--draft-revision',
      '1',
      '--confirmation-file',
      fixture.confirmation,
    ]);
    const freezeResult = JSON.parse(frozen.stdout) as Record<string, unknown>;
    expect(freezeResult.disposition).toBe('CREATED');
    expect(frozen.stderr).toContain('完整 Draft');
    const versionId = String(freezeResult.versionId);
    const prompt = 'PROMPT_MUST_NOT_ENTER_CATALOG';
    const answer = 'ANSWER_MUST_NOT_ENTER_CATALOG';
    const project = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'agent-project-')));
    roots.push(project);
    const observed: CreatorAgentVersion[] = [];
    const result = await invoke(
      [
        'run',
        '--catalog',
        fixture.catalog,
        '--agent-id',
        first.agentId,
        '--version-id',
        versionId,
        '--project',
        project,
        '--prompt',
        prompt,
        '--allow-unisolated-read',
      ],
      async (options) => {
        observed.push(options.version);
        const concurrentlyReopened = openCatalog(fixture.catalog);
        expect(concurrentlyReopened.readVersion({ agentId: first.agentId, versionId })).toEqual(
          options.version,
        );
        concurrentlyReopened.close();
        return Object.freeze({ text: answer });
      },
    );
    expect(result.stdout).toBe(`${answer}\n`);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.versionId).toBe(versionId);

    const bytes = readFileSync(fixture.catalog).toString('utf8');
    expect(bytes).not.toContain(prompt);
    expect(bytes).not.toContain(answer);
    expect(bytes).not.toContain(project);
  });

  it('requires exact confirmation and leaves the Draft unfrozen on refusal', async () => {
    const fixture = cliFixture();
    createCatalogWithDraft(fixture.catalog, draft(1, null));
    const first = draft(1, null);
    const arguments_ = [
      'freeze',
      '--catalog',
      fixture.catalog,
      '--agent-id',
      first.agentId,
      '--draft-id',
      first.draftId,
      '--draft-revision',
      '1',
    ];
    await expect(invoke(arguments_)).rejects.toMatchObject({
      code: 'AGENT_CONFIRMATION_REQUIRED',
    });
    const catalog = openCatalog(fixture.catalog);
    const review = catalog.createFreezeReview(ref(first));
    catalog.close();
    writePrivate(fixture.confirmation, `${review.confirmationText}\n`);
    await expect(
      invoke([...arguments_, '--confirmation-file', fixture.confirmation]),
    ).rejects.toMatchObject({ code: 'CATALOG_CONFIRMATION_MISMATCH' });
    const reopened = openCatalog(fixture.catalog);
    expect(reopened.listVersions(first.agentId)).toEqual([]);
    reopened.close();
  });

  it('escapes terminal controls while preserving the complete reviewed Draft', async () => {
    const fixture = cliFixture();
    const unsafe = draft(1, null, 'Visible\u009btext\u202eend\u2028line');
    createCatalogWithDraft(fixture.catalog, unsafe);
    const reviewed = await invoke([
      'review',
      '--catalog',
      fixture.catalog,
      '--agent-id',
      unsafe.agentId,
      '--draft-id',
      unsafe.draftId,
      '--draft-revision',
      '1',
    ]);
    expect(reviewed.stdout).toContain('Visible\\u009btext\\u202eend\\u2028line');
    expect(reviewed.stdout).not.toContain('\u009b');
    expect(reviewed.stdout).not.toContain('\u202e');
    expect(reviewed.stdout).not.toContain('\u2028');
    expect(reviewed.stdout).toContain(unsafe.draftFingerprint);
  });

  it('rejects invalid UTF-8 and never opens a Host for missing or implicit Versions', async () => {
    const fixture = cliFixture();
    await invoke(['init', '--catalog', fixture.catalog]);
    writeFileSync(fixture.handoff, Buffer.from([0xff]), { mode: 0o600 });
    await expect(
      invoke(['import', '--catalog', fixture.catalog, '--handoff-file', fixture.handoff]),
    ).rejects.toMatchObject({ code: 'AGENT_INPUT_INVALID' });
    const runAgent = vi.fn();
    await expect(
      invoke(
        [
          'run',
          '--catalog',
          fixture.catalog,
          '--agent-id',
          'agent.missing',
          '--version-id',
          'version.missing',
          '--project',
          fixture.root,
          '--prompt',
          'Do not run.',
          '--allow-unisolated-read',
        ],
        runAgent,
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_NOT_FOUND' });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('runs the requested old Version instead of drifting to the latest one', async () => {
    const fixture = cliFixture();
    const first = draft(1, null, 'Version one.');
    const catalog = createFreshCreatorAgentCatalog(options(fixture.catalog));
    catalog.importDraftHandoff(handoffText(first));
    const reviewOne = catalog.createFreezeReview(ref(first));
    const versionOne = catalog.freezeDraft({
      ref: ref(first),
      confirmationText: reviewOne.confirmationText,
    }).version;
    const second = draft(2, versionOne.versionId, 'Version two.');
    catalog.importDraftHandoff(handoffText(second));
    const reviewTwo = catalog.createFreezeReview(ref(second));
    const versionTwo = catalog.freezeDraft({
      ref: ref(second),
      confirmationText: reviewTwo.confirmationText,
    }).version;
    catalog.close();
    const observed: string[] = [];
    await invoke(
      [
        'run',
        '--catalog',
        fixture.catalog,
        '--agent-id',
        first.agentId,
        '--version-id',
        versionOne.versionId,
        '--project',
        fixture.root,
        '--prompt',
        'Use the old version.',
        '--allow-unisolated-read',
      ],
      async (input) => {
        observed.push(input.version.versionId);
        return Object.freeze({ text: 'old version result' });
      },
    );
    expect(observed).toEqual([versionOne.versionId]);
    expect(versionTwo.versionId).not.toBe(versionOne.versionId);
  });
});

function cliFixture() {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'combo-agent-cli-')));
  roots.push(root);
  chmodSync(root, 0o700);
  return Object.freeze({
    root,
    catalog: join(root, 'catalog.sqlite'),
    handoff: join(root, 'handoff.json'),
    confirmation: join(root, 'confirmation.txt'),
  });
}

function options(filename: string): CreatorAgentCatalogOptions {
  return Object.freeze({ filename, catalogIdentity: CATALOG_IDENTITY });
}

function openCatalog(filename: string) {
  return openExistingCreatorAgentCatalog(options(filename));
}

function createCatalogWithDraft(filename: string, value: CreatorAgentDraftSnapshotV1): void {
  const catalog = createFreshCreatorAgentCatalog(options(filename));
  catalog.importDraftHandoff(handoffText(value));
  catalog.close();
}

async function invoke(
  argv: readonly string[],
  runAgentTurn: (
    options: CreatorAgentLocalTurnOptions,
  ) => Promise<Readonly<{ text: string }>> = async () => Object.freeze({ text: 'unused' }),
  compileProject: (
    options: CreatorAgentProjectCompilationOptions,
  ) => Promise<CreatorAgentProjectCompilationResult> = async () => {
    throw new Error('unused compiler');
  },
  interactiveConfirmation?: string,
  defaultCatalog = join(realpathSync(tmpdir()), 'unused-creator-agent-catalog.sqlite'),
) {
  let stdout = '';
  let stderr = '';
  let confirmationReads = 0;
  const exit = await executeCreatorAgentCatalogCli(
    argv,
    {
      stdout: { write: (chunk) => (stdout += chunk) },
      stderr: { write: (chunk) => (stderr += chunk) },
      stdinIsTty: interactiveConfirmation !== undefined,
      stderrIsTty: interactiveConfirmation !== undefined,
      readConfirmation: async () => {
        confirmationReads += 1;
        return interactiveConfirmation ?? '';
      },
    },
    { runAgentTurn, compileProject, defaultCatalogPath: () => defaultCatalog },
    new AbortController().signal,
  );
  return Object.freeze({ exit, stdout, stderr, confirmationReads });
}

function compiledResultV2(): CreatorAgentProjectCompilationResult {
  const draft = compiledDraftV2();
  const handoff = createCreatorAgentDraftHandoffV2({ draft });
  return Object.freeze({
    draft,
    handoff,
    handoffText: serializeCreatorAgentDraftHandoffV2(handoff),
    report: compilationReport('GIT_SNAPSHOT'),
  });
}

function compiledResultV3(): CreatorAgentProjectCompilationResult {
  const draft = compiledDraftV3();
  const handoff = createCreatorAgentDraftHandoffV3({ draft });
  return Object.freeze({
    draft,
    handoff,
    handoffText: serializeCreatorAgentDraftHandoffV3(handoff),
    report: compilationReport('BEHAVIOR_ONLY'),
  });
}

function compilationReport(runtimeContext: 'GIT_SNAPSHOT' | 'BEHAVIOR_ONLY') {
  return Object.freeze({
    contextRootDigest: `sha256:${'a'.repeat(64)}` as const,
    indexedEntryCount: 4,
    indexedFileCount: 3,
    indexedByteCount: 256,
    uniqueIndexedByteCount: 256,
    hardlinkAliasCount: 0,
    runtimeContext,
    categories: Object.freeze({
      configuration: 0,
      documentation: 1,
      git: 1,
      log: 1,
      secret_candidate: 0,
      source: 1,
      task_record: 0,
      other: 0,
    }),
    citedSources: Object.freeze([]),
    coverageSummary: 'Compiled the relevant Project evidence.',
  });
}

function draft(
  draftRevision: number,
  baseVersionId: string | null,
  instructions = 'Inspect evidence, separate facts from inference, and report blockers.',
): CreatorAgentDraftSnapshotV1 {
  return createCreatorAgentDraftSnapshot({
    agentId: 'agent.release-review',
    draftId: 'draft.release-review',
    draftRevision,
    baseVersionId,
    definition: {
      protocol: CREATOR_AGENT_DEFINITION_PROTOCOL,
      name: 'Release evidence reviewer',
      description: 'Reviews one release using the creator’s fixed evidence standard.',
      projectSnapshot: {
        kind: 'git',
        repositoryUrl: 'https://github.com/dangdang-tech/Combo.git',
        sourceRef: 'refs/heads/main',
        commitSha: 'a'.repeat(40),
        treeSha: 'b'.repeat(40),
      },
      behavior: { instructions, starterPrompts: ['Review this release candidate.'] },
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
        output: { kind: 'text', description: 'A concise evidence-backed review.' },
        turnTimeoutMs: 300_000,
      },
    },
  });
}

function compiledDraftV2() {
  const sourceLedger = createCreatorAgentProjectSourceLedger({
    contextRootDigest: `sha256:${'c'.repeat(64)}`,
    coverage: {
      indexedEntryCount: 9,
      indexedFileCount: 7,
      indexedByteCount: 1234,
      hiddenEntryCount: 2,
      trackedEntryCount: 3,
      untrackedEntryCount: 1,
      ignoredEntryCount: 1,
      gitAdminEntryCount: 1,
      authoringOnlyEntryCount: 6,
    },
    citedSources: [
      {
        path: 'README.md',
        digest: `sha256:${'d'.repeat(64)}`,
        executionAvailability: 'FIXED_GIT_TREE',
      },
    ],
  });
  return createCreatorAgentDraftSnapshotV2({
    agentId: 'agent.compiled.release-review',
    draftId: 'draft.compiled.release-review',
    draftRevision: 1,
    baseVersionId: null,
    definition: createCreatorAgentDefinitionV2({
      protocol: CREATOR_AGENT_DEFINITION_V2_PROTOCOL,
      name: 'Compiled release reviewer',
      description: 'Reviews releases from complete Project authoring evidence.',
      projectSnapshot: {
        kind: 'git',
        repositoryUrl: 'https://github.com/dangdang-tech/Combo.git',
        sourceRef: 'refs/heads/main',
        commitSha: 'a'.repeat(40),
        treeSha: 'b'.repeat(40),
      },
      behavior: {
        instructions: 'Use all reviewed Project evidence consistently.',
        starterPrompts: ['Review this release.'],
      },
      requirements: {
        codexVersion: '0.148.0-alpha.15',
        commands: [],
        plugins: [],
        environmentVariableNames: [],
      },
      authoringSource: { kind: 'project_context_compiler', sourceLedger },
      runtime: {
        contextProfile: 'PROJECT_TREE_READ_ONLY_V1',
        permissionProfile: 'LOCAL_UNISOLATED_READ_ONLY_V1',
        skills: [],
        dynamicTools: [],
        toolNetworkAccess: false,
        output: { kind: 'text', description: 'An evidence-backed review.' },
        turnTimeoutMs: 300_000,
      },
    }),
  });
}

function compiledDraftV3() {
  const sourceLedger = createCreatorAgentProjectSourceLedger({
    contextRootDigest: `sha256:${'e'.repeat(64)}`,
    coverage: {
      indexedEntryCount: 12,
      indexedFileCount: 8,
      indexedByteCount: 2048,
      hiddenEntryCount: 2,
      trackedEntryCount: 0,
      untrackedEntryCount: 7,
      ignoredEntryCount: 2,
      gitAdminEntryCount: 3,
      authoringOnlyEntryCount: 12,
    },
    citedSources: [
      {
        path: 'root-notes.md',
        digest: `sha256:${'f'.repeat(64)}`,
        executionAvailability: 'AUTHORING_ONLY',
      },
    ],
  });
  return createCreatorAgentDraftSnapshotV3({
    agentId: 'agent.compiled.aggregate-review',
    draftId: 'draft.compiled.aggregate-review',
    draftRevision: 1,
    baseVersionId: null,
    definition: createCreatorAgentDefinitionV3({
      protocol: CREATOR_AGENT_DEFINITION_V3_PROTOCOL,
      name: 'Aggregate behavior reviewer',
      description: 'Applies behavior compiled from an aggregate authoring corpus.',
      projectBinding: { kind: 'none' },
      behavior: {
        instructions: 'Apply the frozen method without claiming access to source files.',
        starterPrompts: ['Review this request.'],
      },
      requirements: {
        codexVersion: '0.148.0-alpha.15',
        commands: [],
        plugins: [],
        environmentVariableNames: [],
      },
      authoringSource: { kind: 'project_context_compiler', sourceLedger },
      runtime: {
        contextProfile: 'BEHAVIOR_ONLY_V1',
        permissionProfile: 'LOCAL_UNISOLATED_READ_ONLY_V1',
        skills: [],
        dynamicTools: [],
        toolNetworkAccess: false,
        output: { kind: 'text', description: 'A concise behavior-only review.' },
        turnTimeoutMs: 300_000,
      },
    }),
  });
}

function handoffText(value: CreatorAgentDraftSnapshotV1): string {
  return serializeCreatorAgentDraftHandoff(createCreatorAgentDraftHandoff({ draft: value }));
}

function ref(value: CreatorAgentDraftSnapshotV1) {
  return Object.freeze({
    agentId: value.agentId,
    draftId: value.draftId,
    draftRevision: value.draftRevision,
  });
}

function writePrivate(filename: string, value: string): void {
  writeFileSync(filename, value, { encoding: 'utf8', mode: 0o600 });
}
