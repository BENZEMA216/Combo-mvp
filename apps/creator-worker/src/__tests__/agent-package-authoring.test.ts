import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseCreatorAgentPackageProvenance,
  serializeCreatorAgentPackageManifest,
} from '@cb/creator-agent-protocol/agent-package';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildCreatorAgentPackage } from '../authoring/agent-package-builder.js';
import type { CreatorAgentProjectBehaviorExtraction } from '../authoring/project-behavior-extractor.js';
import {
  createCreatorAgentPackageFromProjectWithDependencies,
  type CreatorAgentPackageAuthoringDependencies,
} from '../application/agent-package-authoring.js';
import { loadCreatorAgentPackage } from '../infrastructure/agent-package-loader.js';
import { publishBuiltCreatorAgentPackage } from '../infrastructure/agent-package-publisher.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0).reverse()) {
    makeDirectoriesWritable(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Agent Package authoring', () => {
  it('deterministically compiles extracted behavior into AGENT.md, one native Skill, and agent.json', () => {
    const fixture = authoringFixture();
    const first = buildCreatorAgentPackage(extraction(fixture.source));
    const second = buildCreatorAgentPackage(extraction(fixture.source));

    expect(second.packageDigest).toBe(first.packageDigest);
    expect(second.manifestText).toBe(first.manifestText);
    expect(first.manifest.skills).toEqual(['skills/extracted-method/SKILL.md']);
    expect(first.files.map(({ path }) => path)).toEqual([
      'AGENT.md',
      'skills/extracted-method/SKILL.md',
      'skills/extracted-method/provenance.json',
    ]);
    expect(first.files[0]?.text).toContain('# Operating Loop');
    expect(first.files[1]?.text).toContain('Apply evidence gate ALPHA before shipping.');
    expect(first.files.some(({ text }) => text.includes(fixture.source))).toBe(false);
    expect(first.sourceReceipt).toMatchObject({
      contextRootDigest: DIGEST_A,
      citedSources: [{ path: 'method.md', digest: DIGEST_B }],
    });
    const provenance = parseCreatorAgentPackageProvenance(first.files[2]!.text);
    expect(provenance).toMatchObject({
      sourceKind: 'current_project',
      creatorRequestDigest: null,
    });
    expect(first.files[2]!.text).not.toContain('method.md');
    const changedSource = buildCreatorAgentPackage({
      ...extraction(fixture.source),
      contextRootDigest: `sha256:${'c'.repeat(64)}`,
    });
    expect(changedSource.packageDigest).not.toBe(first.packageDigest);

    const invalid = extraction(fixture.source);
    expect(() =>
      buildCreatorAgentPackage({
        ...invalid,
        behavior: { ...invalid.behavior, instructions: '\n\t' },
      }),
    ).toThrow(/meaningful/u);
    expect(() =>
      buildCreatorAgentPackage({
        ...invalid,
        behavior: { ...invalid.behavior, starterPrompts: ['Review this.', '\ud800'] },
      }),
    ).toThrow(/unsafe/u);
    expect(() =>
      buildCreatorAgentPackage({
        ...invalid,
        behavior: { ...invalid.behavior, instructions: '\u200b' },
      }),
    ).toThrow(/unsafe/u);
    for (const instructions of ['坏\u0001输入', '坏\u007f输入', '坏\u2028输入', '坏\u2029输入']) {
      expect(() =>
        buildCreatorAgentPackage({
          ...invalid,
          behavior: { ...invalid.behavior, instructions },
        }),
      ).toThrow(/unsafe/u);
    }
    expect(() =>
      buildCreatorAgentPackage({
        ...invalid,
        behavior: { ...invalid.behavior, instructions: '先检查🙂\n\t再验证。' },
      }),
    ).not.toThrow();
    expect(() =>
      buildCreatorAgentPackage({
        ...invalid,
        behavior: {
          ...invalid.behavior,
          instructions: '请读取 $HOME/.ssh/config 后执行验收。',
        },
      }),
    ).toThrow(/non-portable/u);
    expect(() =>
      buildCreatorAgentPackage({
        ...invalid,
        behavior: { ...invalid.behavior, instructions: '\ufe0f' },
      }),
    ).toThrow(/meaningful/u);
    expect(() =>
      buildCreatorAgentPackage({
        ...invalid,
        behavior: { ...invalid.behavior, starterPrompts: ['Review  this.', 'Review this.'] },
      }),
    ).toThrow(/unique/u);
  });

  it('publishes a private digest-named Package, formally reloads it, and replays exactly', async () => {
    const fixture = authoringFixture();
    const dependencies = productionLikeDependencies(extraction(fixture.source));

    const first = await createCreatorAgentPackageFromProjectWithDependencies(
      options(fixture),
      dependencies,
    );
    const second = await createCreatorAgentPackageFromProjectWithDependencies(
      options(fixture),
      dependencies,
    );

    expect(first.disposition).toBe('CREATED');
    expect(second.disposition).toBe('EXISTING');
    expect(second.packagePath).toBe(first.packagePath);
    expect(second.packageDigest).toBe(first.packageDigest);
    expect(first.reloadVerified).toBe(true);
    expect(readFileSync(join(first.packagePath, 'agent.json'), 'utf8')).toBe(
      serializeCreatorAgentPackageManifest(first.manifest),
    );
    expect(first.packagePath.startsWith(`${fixture.store}/sha256-`)).toBe(true);
  });

  it('rejects unsafe configuration before extraction and preserves reload cleanup failures', async () => {
    const fixture = authoringFixture();
    const extractProject = vi.fn(async () => extraction(fixture.source));
    await expect(
      createCreatorAgentPackageFromProjectWithDependencies(
        { ...options(fixture), storeDirectory: fixture.source },
        { ...productionLikeDependencies(extraction(fixture.source)), extractProject },
      ),
    ).rejects.toMatchObject({ code: 'AGENT_PACKAGE_AUTHORING_CONFIGURATION_INVALID' });
    expect(extractProject).not.toHaveBeenCalled();

    let getterReads = 0;
    const accessor = {
      ...options(fixture),
      get sourceProjectPath() {
        getterReads += 1;
        return fixture.source;
      },
    };
    await expect(
      createCreatorAgentPackageFromProjectWithDependencies(
        accessor,
        productionLikeDependencies(extraction(fixture.source)),
      ),
    ).rejects.toMatchObject({ code: 'AGENT_PACKAGE_AUTHORING_CONFIGURATION_INVALID' });
    expect(getterReads).toBe(0);

    const committedPath = join(fixture.store, `sha256-${'c'.repeat(64)}`);
    await expect(
      createCreatorAgentPackageFromProjectWithDependencies(options(fixture), {
        ...productionLikeDependencies(extraction(fixture.source)),
        publishPackage: () => {
          throw Object.assign(new Error('POST_COMMIT_CANARY'), {
            packagePath: committedPath,
          });
        },
      }),
    ).rejects.toMatchObject({
      code: 'AGENT_PACKAGE_AUTHORING_PUBLISH_FAILED',
      packagePath: committedPath,
    });

    const broken = productionLikeDependencies(extraction(fixture.source));
    await expect(
      createCreatorAgentPackageFromProjectWithDependencies(options(fixture), {
        ...broken,
        loadPackage: () => ({
          packageDigest: buildCreatorAgentPackage(extraction(fixture.source)).packageDigest,
          manifest: buildCreatorAgentPackage(extraction(fixture.source)).manifest,
          release: () => {
            throw new Error('RELEASE_CANARY');
          },
        }),
      }),
    ).rejects.toMatchObject({ code: 'AGENT_PACKAGE_AUTHORING_STOP_INCOMPLETE' });
  });
});

const DIGEST_A = `sha256:${'a'.repeat(64)}` as const;
const DIGEST_B = `sha256:${'b'.repeat(64)}` as const;

function authoringFixture(): { root: string; source: string; store: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'combo-agent-package-authoring-')));
  roots.push(root);
  const source = join(root, 'source');
  const store = join(root, 'store');
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(store, { mode: 0o700 });
  chmodSync(store, 0o700);
  return { root, source, store };
}

function extraction(sourceProjectPath: string): CreatorAgentProjectBehaviorExtraction {
  return Object.freeze({
    behavior: Object.freeze({
      protocol: 'combo.creator-agent-project-context-compilation/1',
      name: 'Evidence: Release Reviewer',
      description: 'Reviews release evidence without trusting status summaries.',
      instructions: 'Apply evidence gate ALPHA before shipping.',
      starterPrompts: ['Review this release.'],
      outputDescription: 'Return a verdict and the evidence that supports it.',
      sourcePaths: ['method.md'],
      coverageSummary: 'The release method and failure rules shaped this package.',
    }),
    sourceProjectPath,
    contextRootDigest: DIGEST_A,
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
        path: 'method.md',
        digest: DIGEST_B,
        executionAvailability: 'AUTHORING_ONLY',
      }),
    ]),
  });
}

function options(fixture: { source: string; store: string }) {
  return {
    sourceProjectPath: fixture.source,
    storeDirectory: fixture.store,
    allowUnisolatedRead: true as const,
    allowSensitiveProjectContext: true as const,
  };
}

function productionLikeDependencies(
  value: CreatorAgentProjectBehaviorExtraction,
): CreatorAgentPackageAuthoringDependencies {
  return {
    extractProject: async () => value,
    buildPackage: buildCreatorAgentPackage,
    publishPackage: publishBuiltCreatorAgentPackage,
    loadPackage: loadCreatorAgentPackage,
  };
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
