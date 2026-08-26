import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_PROTOCOL,
  CREATOR_AGENT_PACKAGE_DRAFT_REVISION_PROTOCOL,
  createCreatorAgentPackageCreatorRequest,
  createCreatorAgentPackageDraftRevisionRequest,
  type CreatorAgentPackageDraftSnapshot,
} from '@cb/creator-agent-protocol/agent-package-draft';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildCreatorAgentPackageFromDraft,
  normalizeCreatorAgentPackageDraftContent,
} from '../authoring/agent-package-builder.js';
import type { CreatorAgentProjectBehaviorExtraction } from '../authoring/project-behavior-extractor.js';
import {
  createCreatorAgentPackageDraftFromCurrentProjectWithDependencies,
  type CreatorAgentPackageCreatorDependencies,
} from '../application/agent-package-creator.js';
import { loadCreatorAgentPackage } from '../infrastructure/agent-package-loader.js';
import { publishBuiltCreatorAgentPackage } from '../infrastructure/agent-package-publisher.js';

const roots: string[] = [];
const ROOT_DIGEST = `sha256:${'a'.repeat(64)}` as const;
const SOURCE_DIGEST = `sha256:${'b'.repeat(64)}` as const;

afterEach(() => {
  for (const root of roots.splice(0).reverse()) {
    makeDirectoriesWritable(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Agent Package creator Draft use case', () => {
  it('binds the Host-supplied current Project and creator sentence into one reviewable Draft', async () => {
    const fixture = creatorFixture();
    const extractProject = vi.fn(async () => extraction(fixture.project));
    const dependencies = creatorDependencies(extractProject);
    const request = createCreatorAgentPackageCreatorRequest({
      protocol: CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_PROTOCOL,
      intent: 'create_agent_package_from_current_project',
      request: '请看 combo.workflow.md，把目录里跑通的发布流程提炼成一个 Agent。',
    });

    const task = await createCreatorAgentPackageDraftFromCurrentProjectWithDependencies(
      {
        request,
        currentProjectPath: fixture.project,
        allowUnisolatedRead: true,
        allowSensitiveProjectContext: true,
      },
      dependencies,
    );

    expect(extractProject).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: fixture.project,
        creatorRequest: request.request,
        allowUnisolatedRead: true,
        allowSensitiveProjectContext: true,
      }),
    );
    const draft = task.readDraft();
    expect(draft.creatorRequest).toEqual(request);
    expect(draft.source).toMatchObject({
      kind: 'current_project',
      contextRootDigest: ROOT_DIGEST,
      citedSources: [{ path: 'combo.workflow.md', digest: SOURCE_DIGEST }],
    });
    expect(draft.content.name).toBe('Evidence Release Reviewer');
    expect(JSON.stringify(draft)).not.toContain(fixture.project);
  });

  it('revises one exact Draft and compiles each revision into its own formally reloaded digest', async () => {
    const fixture = creatorFixture();
    const buildPackage = vi.fn(buildCreatorAgentPackageFromDraft);
    const publishPackage = vi.fn(publishBuiltCreatorAgentPackage);
    const dependencies = {
      ...creatorDependencies(async () => extraction(fixture.project)),
      buildPackage,
      publishPackage,
    };
    const task = await createCreatorAgentPackageDraftFromCurrentProjectWithDependencies(
      creatorOptions(fixture.project),
      dependencies,
    );
    const first = task.readDraft();
    const revision = createCreatorAgentPackageDraftRevisionRequest({
      protocol: CREATOR_AGENT_PACKAGE_DRAFT_REVISION_PROTOCOL,
      draftId: first.draftId,
      baseRevision: first.revision,
      baseDraftFingerprint: first.draftFingerprint,
      changes: {
        description: 'Only immutable evidence can satisfy this release review.',
      },
    });
    const firstBuild = task.compile(compilationRequest(first, fixture.store));
    const second = task.revise(revision);
    expect(() => task.compile(compilationRequest(first, fixture.store))).toThrow(
      /current exact Draft/u,
    );
    expect(buildPackage).toHaveBeenCalledTimes(1);
    expect(publishPackage).toHaveBeenCalledTimes(1);
    const secondBuild = task.compile(compilationRequest(second, fixture.store));

    expect(firstBuild.reloadVerified).toBe(true);
    expect(secondBuild.reloadVerified).toBe(true);
    expect(firstBuild.draftFingerprint).toBe(first.draftFingerprint);
    expect(secondBuild.draftFingerprint).toBe(second.draftFingerprint);
    expect(secondBuild.draftRevision).toBe(2);
    expect(secondBuild.packageDigest).not.toBe(firstBuild.packageDigest);
    expect(secondBuild.packagePath).not.toBe(firstBuild.packagePath);
  });

  it('reuses one content-addressed Package across recreated Draft tasks', async () => {
    const fixture = creatorFixture();
    const firstTask = await createCreatorAgentPackageDraftFromCurrentProjectWithDependencies(
      creatorOptions(fixture.project),
      {
        ...creatorDependencies(async () => extraction(fixture.project)),
        randomId: () => '11111111-1111-1111-1111-111111111111',
      },
    );
    const secondTask = await createCreatorAgentPackageDraftFromCurrentProjectWithDependencies(
      creatorOptions(fixture.project),
      {
        ...creatorDependencies(async () => extraction(fixture.project)),
        randomId: () => '22222222-2222-2222-2222-222222222222',
      },
    );
    const firstDraft = firstTask.readDraft();
    const secondDraft = secondTask.readDraft();
    const firstBuild = firstTask.compile(compilationRequest(firstDraft, fixture.store));
    const firstReplay = firstTask.compile(compilationRequest(firstDraft, fixture.store));
    const secondBuild = secondTask.compile(compilationRequest(secondDraft, fixture.store));

    expect(secondDraft.draftId).not.toBe(firstDraft.draftId);
    expect(secondDraft.draftFingerprint).not.toBe(firstDraft.draftFingerprint);
    expect(firstBuild.disposition).toBe('CREATED');
    expect(firstReplay.disposition).toBe('EXISTING');
    expect(firstReplay.packageDigest).toBe(firstBuild.packageDigest);
    expect(secondBuild.disposition).toBe('EXISTING');
    expect(secondBuild.packageDigest).toBe(firstBuild.packageDigest);
    expect(secondBuild.packagePath).toBe(firstBuild.packagePath);

    const changedRequestTask =
      await createCreatorAgentPackageDraftFromCurrentProjectWithDependencies(
        creatorOptions(fixture.project, '请把当前目录的发布流程提炼成一个只核对回滚证据的 Agent。'),
        {
          ...creatorDependencies(async () => extraction(fixture.project)),
          randomId: () => '33333333-3333-3333-3333-333333333333',
        },
      );
    const changedDraft = changedRequestTask.readDraft();
    const changedBuild = changedRequestTask.compile(
      compilationRequest(changedDraft, fixture.store),
    );
    expect(changedBuild.packageDigest).not.toBe(firstBuild.packageDigest);
  });

  it('rejects accessor configuration and tampered Drafts before extraction or publication', async () => {
    const fixture = creatorFixture();
    const extractProject = vi.fn(async () => extraction(fixture.project));
    const buildPackage = vi.fn(buildCreatorAgentPackageFromDraft);
    const publishPackage = vi.fn(publishBuiltCreatorAgentPackage);
    const dependencies = {
      ...creatorDependencies(extractProject),
      buildPackage,
      publishPackage,
    };
    let reads = 0;
    const accessor = {
      ...creatorOptions(fixture.project),
      get currentProjectPath() {
        reads += 1;
        return fixture.project;
      },
    };

    await expect(
      createCreatorAgentPackageDraftFromCurrentProjectWithDependencies(accessor, dependencies),
    ).rejects.toMatchObject({ code: 'AGENT_PACKAGE_DRAFT_CONFIGURATION_INVALID' });
    expect(reads).toBe(0);
    expect(extractProject).not.toHaveBeenCalled();

    const task = await createCreatorAgentPackageDraftFromCurrentProjectWithDependencies(
      creatorOptions(fixture.project),
      dependencies,
    );
    const draft = task.readDraft();
    const compilationAccessor = {
      ...compilationRequest(draft, fixture.store),
      get storeDirectory() {
        reads += 1;
        return fixture.store;
      },
    };
    expect(() => task.compile(compilationAccessor)).toThrow(/compilation request is invalid/u);
    expect(reads).toBe(0);
    const stale = createCreatorAgentPackageDraftRevisionRequest({
      protocol: CREATOR_AGENT_PACKAGE_DRAFT_REVISION_PROTOCOL,
      draftId: draft.draftId,
      baseRevision: draft.revision,
      baseDraftFingerprint: `sha256:${'0'.repeat(64)}`,
      changes: { name: 'Tampered Agent' },
    });
    expect(() => task.revise(stale)).toThrow(/current exact Draft/u);
    expect(buildPackage).not.toHaveBeenCalled();
    expect(publishPackage).not.toHaveBeenCalled();
  });

  it('rejects a Package store inside the source Project before building or publishing', async () => {
    const fixture = creatorFixture();
    const nestedStore = join(fixture.project, 'private-package-store');
    mkdirSync(nestedStore, { mode: 0o700 });
    const buildPackage = vi.fn(buildCreatorAgentPackageFromDraft);
    const publishPackage = vi.fn(publishBuiltCreatorAgentPackage);
    const dependencies = {
      ...creatorDependencies(async () => extraction(fixture.project)),
      buildPackage,
      publishPackage,
    };
    const task = await createCreatorAgentPackageDraftFromCurrentProjectWithDependencies(
      creatorOptions(fixture.project),
      dependencies,
    );

    expect(() => task.compile(compilationRequest(task.readDraft(), nestedStore))).toThrow(
      /compilation paths are invalid/u,
    );
    expect(buildPackage).not.toHaveBeenCalled();
    expect(publishPackage).not.toHaveBeenCalled();
    expect(readdirSync(nestedStore)).toEqual([]);
  });

  it('rejects compilation after the bound source Project is moved', async () => {
    const fixture = creatorFixture();
    const movedProject = join(fixture.root, 'moved-project');
    const buildPackage = vi.fn(buildCreatorAgentPackageFromDraft);
    const publishPackage = vi.fn(publishBuiltCreatorAgentPackage);
    const dependencies = {
      ...creatorDependencies(async () => extraction(fixture.project)),
      buildPackage,
      publishPackage,
    };
    const task = await createCreatorAgentPackageDraftFromCurrentProjectWithDependencies(
      creatorOptions(fixture.project),
      dependencies,
    );
    renameSync(fixture.project, movedProject);
    const nestedStore = join(movedProject, 'private-package-store');
    mkdirSync(nestedStore, { mode: 0o700 });

    expect(() => task.compile(compilationRequest(task.readDraft(), nestedStore))).toThrow(
      /compilation paths are invalid/u,
    );
    expect(buildPackage).not.toHaveBeenCalled();
    expect(publishPackage).not.toHaveBeenCalled();
    expect(readdirSync(nestedStore)).toEqual([]);
  });
});

function creatorFixture(): { root: string; project: string; store: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'combo-agent-package-creator-')));
  roots.push(root);
  const project = join(root, 'project');
  const store = join(root, 'store');
  mkdirSync(project, { mode: 0o700 });
  mkdirSync(store, { mode: 0o700 });
  return { root, project, store };
}

function creatorOptions(
  currentProjectPath: string,
  request = '请把当前目录已经跑通的发布流程提炼成一个 Agent。',
) {
  return {
    request: createCreatorAgentPackageCreatorRequest({
      protocol: CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_PROTOCOL,
      intent: 'create_agent_package_from_current_project',
      request,
    }),
    currentProjectPath,
    allowUnisolatedRead: true as const,
    allowSensitiveProjectContext: true as const,
  };
}

function compilationRequest(draft: CreatorAgentPackageDraftSnapshot, storeDirectory: string) {
  return {
    draftId: draft.draftId,
    draftRevision: draft.revision,
    draftFingerprint: draft.draftFingerprint,
    storeDirectory,
  };
}

function creatorDependencies(
  extractProject: CreatorAgentPackageCreatorDependencies['extractProject'],
): CreatorAgentPackageCreatorDependencies {
  return {
    extractProject,
    normalizeDraftContent: normalizeCreatorAgentPackageDraftContent,
    buildPackage: buildCreatorAgentPackageFromDraft,
    publishPackage: publishBuiltCreatorAgentPackage,
    loadPackage: loadCreatorAgentPackage,
    randomId: randomUUID,
  };
}

function extraction(sourceProjectPath: string): CreatorAgentProjectBehaviorExtraction {
  return Object.freeze({
    behavior: Object.freeze({
      protocol: 'combo.creator-agent-project-context-compilation/1',
      name: 'Evidence: Release Reviewer',
      description: 'Reviews release evidence without trusting summaries.',
      instructions: 'Apply evidence gate ALPHA before shipping.',
      starterPrompts: ['Review this release.'],
      outputDescription: 'Return a verdict and its exact supporting evidence.',
      sourcePaths: ['combo.workflow.md'],
      coverageSummary: 'The workflow and its release evidence shaped this Agent.',
    }),
    sourceProjectPath,
    contextRootDigest: ROOT_DIGEST,
    coverage: Object.freeze({
      indexedEntryCount: 1,
      indexedFileCount: 1,
      indexedByteCount: 10,
      hiddenEntryCount: 0,
      trackedEntryCount: 0,
      untrackedEntryCount: 1,
      ignoredEntryCount: 0,
      gitAdminEntryCount: 0,
      authoringOnlyEntryCount: 1,
    }),
    categories: Object.freeze({
      configuration: 0,
      documentation: 1,
      git: 0,
      log: 0,
      secret_candidate: 0,
      source: 0,
      task_record: 0,
      other: 0,
    }),
    indexedEntryCount: 1,
    indexedFileCount: 1,
    indexedByteCount: 10,
    uniqueIndexedByteCount: 10,
    hardlinkAliasCount: 0,
    citedSources: Object.freeze([
      Object.freeze({
        path: 'combo.workflow.md',
        digest: SOURCE_DIGEST,
        executionAvailability: 'AUTHORING_ONLY' as const,
      }),
    ]),
  });
}

function makeDirectoriesWritable(root: string): void {
  const pending = [root];
  for (let index = 0; index < pending.length; index += 1) {
    const directory = pending[index]!;
    chmodSync(directory, 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(join(directory, entry.name));
    }
  }
}
