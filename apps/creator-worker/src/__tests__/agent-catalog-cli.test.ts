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
  createCreatorAgentDraftHandoff,
  createCreatorAgentDraftSnapshot,
  serializeCreatorAgentDraftHandoff,
  type CreatorAgentDraftSnapshotV1,
  type CreatorAgentVersionV1,
} from '@cb/creator-agent-protocol/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { executeCreatorAgentCatalogCli } from '../agent-catalog-cli.js';
import type { CreatorAgentLocalTurnOptions } from '../agent-local-contract.js';

const roots: string[] = [];
const CATALOG_IDENTITY = 'combo.local.creator-agent-catalog.v1';

afterEach(() => {
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe('Creator Agent Catalog CLI', () => {
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
    const observed: CreatorAgentVersionV1[] = [];
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
) {
  let stdout = '';
  let stderr = '';
  const exit = await executeCreatorAgentCatalogCli(
    argv,
    {
      stdout: { write: (chunk) => (stdout += chunk) },
      stderr: { write: (chunk) => (stderr += chunk) },
      stdinIsTty: false,
      stderrIsTty: false,
      readConfirmation: async () => '',
    },
    { runAgentTurn },
    new AbortController().signal,
  );
  return Object.freeze({ exit, stdout, stderr });
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
