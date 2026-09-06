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
  parseCreatorAgentPackageConversationProvenance,
  verifyCreatorAgentPackageCompilationReceiptBinding,
  parseCreatorAgentPackageProvenance,
  serializeCreatorAgentPackageManifest,
} from '@cb/creator-agent-protocol/agent-package';
import {
  CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_V2_PROTOCOL,
  CREATOR_AGENT_PACKAGE_DRAFT_REVISION_PROTOCOL,
  CREATOR_AGENT_PACKAGE_DRAFT_V2_PROTOCOL,
  createCreatorAgentPackageDraftRevisionRequest,
  createCreatorAgentPackageDraftSnapshotV2,
  reviseCreatorAgentPackageDraftV2,
  serializeCreatorAgentPackageDraftSnapshotV2,
} from '@cb/creator-agent-protocol/agent-package-draft';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildCreatorAgentPackage,
  buildCreatorAgentPackageFromDraft,
} from '../authoring/agent-package-builder.js';
import {
  CREATOR_AGENT_PACKAGE_DRAFT_V2_COMPILER_VERSION,
  compileCreatorAgentPackageDraftV2,
} from '../agent-package-compiler.js';
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

function compileExactDraftV2(input: unknown) {
  return compileCreatorAgentPackageDraftV2(serializeCreatorAgentPackageDraftSnapshotV2(input));
}

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
        behavior: { ...invalid.behavior, instructions: 'Run ssh for validation.' },
      }),
    ).toThrow(/non-portable/u);
    expect(() =>
      buildCreatorAgentPackage({
        ...invalid,
        behavior: { ...invalid.behavior, starterPrompts: ['Review  this.', 'Review this.'] },
      }),
    ).toThrow(/unique/u);
  });

  it('deterministically compiles current-conversation Draft V2 into a verifiable candidate Package', () => {
    const conversationDraft = createCreatorAgentPackageDraftSnapshotV2({
      protocol: CREATOR_AGENT_PACKAGE_DRAFT_V2_PROTOCOL,
      draftId: `draft.agent-package.${'9'.repeat(32)}`,
      revision: 1,
      parentDraftFingerprint: null,
      creatorRequest: {
        protocol: CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_V2_PROTOCOL,
        intent: 'create_agent_package_from_current_conversation',
        request: '把我们刚才完成的工作做成一个 Agent。',
      },
      source: {
        kind: 'current_conversation',
        sourceBoundary: 'desktop_attested_active_current_task',
        snapshotBoundary: 'before_direct_creator_item',
        visibility: 'user_visible_items_only',
        snapshotCompleteness: 'complete',
        rawStored: false,
        snapshotCommitmentScheme: 'host_hmac_sha256_per_run/1',
        snapshotCommitment: `sha256:${'d'.repeat(64)}`,
        selectedVisibleItemCount: 4,
        coverageSummary: '当前任务中形成的发布证据方法定义了这个 Agent。',
      },
      content: {
        name: '发布证据核验员',
        description: '按当前对话形成的方法核对发布证据。',
        instructions: '先核对候选身份，再验证运行证据，最后给出结论。',
        starterPrompts: ['检查这次发布。'],
        outputDescription: '返回结论与证据。',
      },
    });

    const conversationDraftText = serializeCreatorAgentPackageDraftSnapshotV2(conversationDraft);
    const first = compileCreatorAgentPackageDraftV2(conversationDraftText);
    const replay = compileCreatorAgentPackageDraftV2(conversationDraftText);

    expect(replay.packageDigest).toBe(first.packageDigest);
    expect(replay.manifestText).toBe(first.manifestText);
    expect(replay.files).toEqual(first.files);
    expect(replay.compilationReceiptText).toBe(first.compilationReceiptText);
    expect(first.files.map(({ path }) => path)).not.toContain(
      'skills/extracted-method/compilation-receipt.json',
    );
    expect(first.files.some(({ text }) => text.includes(first.packageDigest))).toBe(false);
    expect(first.sourceReceipt).toMatchObject({
      sourceKind: 'current_conversation',
      snapshotCommitment: conversationDraft.source.snapshotCommitment,
    });
    const provenance = parseCreatorAgentPackageConversationProvenance(first.files[2]!.text);
    expect(provenance).toMatchObject({
      sourceKind: 'current_conversation',
    });
    expect(provenance).not.toHaveProperty('draftFingerprint');
    expect(provenance).not.toHaveProperty('compilerVersion');
    expect(
      verifyCreatorAgentPackageCompilationReceiptBinding(
        first.compilationReceipt,
        conversationDraft,
        CREATOR_AGENT_PACKAGE_DRAFT_V2_COMPILER_VERSION,
        first.manifest,
        provenance,
        first.sourceReceipt,
      ),
    ).toEqual(first.compilationReceipt);
    const packageText = first.files.map(({ text }) => text).join('\n');
    expect(packageText).not.toContain('creator source Project');
    expect(packageText).not.toContain('authoring Project');
    expect(packageText).toContain('creator conversation');

    const revisedDraft = reviseCreatorAgentPackageDraftV2(
      conversationDraft,
      createCreatorAgentPackageDraftRevisionRequest({
        protocol: CREATOR_AGENT_PACKAGE_DRAFT_REVISION_PROTOCOL,
        draftId: conversationDraft.draftId,
        baseRevision: conversationDraft.revision,
        baseDraftFingerprint: conversationDraft.draftFingerprint,
        changes: { description: '严格按当前对话形成的方法核对发布证据。' },
      }),
    );
    const revised = compileExactDraftV2(revisedDraft);
    expect(revisedDraft.draftFingerprint).not.toBe(conversationDraft.draftFingerprint);
    expect(revised.packageDigest).not.toBe(first.packageDigest);

    const restoredDraft = reviseCreatorAgentPackageDraftV2(
      revisedDraft,
      createCreatorAgentPackageDraftRevisionRequest({
        protocol: CREATOR_AGENT_PACKAGE_DRAFT_REVISION_PROTOCOL,
        draftId: revisedDraft.draftId,
        baseRevision: revisedDraft.revision,
        baseDraftFingerprint: revisedDraft.draftFingerprint,
        changes: { description: conversationDraft.content.description },
      }),
    );
    const restored = compileExactDraftV2(restoredDraft);
    expect(restored.packageDigest).toBe(first.packageDigest);
    expect(restored.compilationReceiptText).not.toBe(first.compilationReceiptText);

    const sameContentOtherDraft = createCreatorAgentPackageDraftSnapshotV2({
      protocol: conversationDraft.protocol,
      draftId: `draft.agent-package.${'7'.repeat(32)}`,
      revision: 1,
      parentDraftFingerprint: null,
      creatorRequest: conversationDraft.creatorRequest,
      source: conversationDraft.source,
      content: conversationDraft.content,
    });
    const sameContentOtherCandidate = compileExactDraftV2(sameContentOtherDraft);
    expect(sameContentOtherCandidate.packageDigest).toBe(first.packageDigest);
    expect(sameContentOtherCandidate.compilationReceiptText).not.toBe(first.compilationReceiptText);

    const fixture = authoringFixture();
    const publication = publishBuiltCreatorAgentPackage(first, fixture.store);
    const loaded = loadCreatorAgentPackage(publication.packagePath);
    try {
      expect(loaded.packageDigest).toBe(first.packageDigest);
      expect(loaded.manifest).toEqual(first.manifest);
    } finally {
      loaded.release();
    }
  });

  it('classifies invalid, drifted, unsafe, and old Draft inputs without V1 fallback', () => {
    const fixture = authoringFixture();
    const projectDraftBuild = buildCreatorAgentPackage(extraction(fixture.source));
    expect(projectDraftBuild.packageDigest).toMatch(/^sha256:/u);

    expect(() => compileCreatorAgentPackageDraftV2('{}')).toThrowError(
      expect.objectContaining({ code: 'AGENT_PACKAGE_V2_COMPILE_DRAFT_INCOMPLETE' }),
    );
    expect(() =>
      compileCreatorAgentPackageDraftV2('{"protocol":"combo.agent-package-draft/1"}'),
    ).toThrowError(
      expect.objectContaining({ code: 'AGENT_PACKAGE_V2_COMPILE_UNSUPPORTED_DRAFT_VERSION' }),
    );
    expect(() =>
      compileCreatorAgentPackageDraftV2('{"protocol":"combo.agent-package-draft/3"}'),
    ).toThrowError(
      expect.objectContaining({ code: 'AGENT_PACKAGE_V2_COMPILE_UNSUPPORTED_DRAFT_VERSION' }),
    );

    const exact = createCreatorAgentPackageDraftSnapshotV2({
      protocol: CREATOR_AGENT_PACKAGE_DRAFT_V2_PROTOCOL,
      draftId: `draft.agent-package.${'8'.repeat(32)}`,
      revision: 1,
      parentDraftFingerprint: null,
      creatorRequest: {
        protocol: CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_V2_PROTOCOL,
        intent: 'create_agent_package_from_current_conversation',
        request: '把当前对话里的方法做成 Agent。',
      },
      source: {
        kind: 'current_conversation',
        sourceBoundary: 'desktop_attested_active_current_task',
        snapshotBoundary: 'before_direct_creator_item',
        visibility: 'user_visible_items_only',
        snapshotCompleteness: 'complete',
        rawStored: false,
        snapshotCommitmentScheme: 'host_hmac_sha256_per_run/1',
        snapshotCommitment: `sha256:${'e'.repeat(64)}`,
        selectedVisibleItemCount: 2,
        coverageSummary: '当前任务形成了可复用的方法。',
      },
      content: {
        name: '方法执行员',
        description: '执行当前对话形成的方法。',
        instructions: '先检查输入，再执行方法，最后验证输出。',
        starterPrompts: ['执行这个任务。'],
        outputDescription: '返回已验证结果。',
      },
    });
    const { draftFingerprint: _exactFingerprint, ...exactInput } = exact;
    const exactText = serializeCreatorAgentPackageDraftSnapshotV2(exact);
    const driftedText = exactText.replace(exact.content.description, '发生了未绑定的变化。');
    expect(driftedText).not.toBe(exactText);
    expect(() => compileCreatorAgentPackageDraftV2(driftedText)).toThrowError(
      expect.objectContaining({ code: 'AGENT_PACKAGE_V2_COMPILE_DRAFT_DRIFTED' }),
    );
    const invalidText = exactText.replace(
      exact.content.instructions,
      '读取 /Users/alice/private/session.jsonl。',
    );
    expect(invalidText).not.toBe(exactText);
    expect(() => compileCreatorAgentPackageDraftV2(invalidText)).toThrowError(
      expect.objectContaining({ code: 'AGENT_PACKAGE_V2_COMPILE_DRAFT_INCOMPLETE' }),
    );
    let invalidFailure: unknown;
    try {
      compileCreatorAgentPackageDraftV2(invalidText);
    } catch (error) {
      invalidFailure = error;
    }
    expect(invalidFailure).toMatchObject({
      code: 'AGENT_PACKAGE_V2_COMPILE_DRAFT_INCOMPLETE',
      message: 'Current-conversation Agent Package Draft input is incomplete or invalid.',
    });
    expect(invalidFailure).not.toHaveProperty('cause');
    expect(String(invalidFailure)).not.toContain('/Users/alice/private/session.jsonl');

    const credential = `sk-${'a'.repeat(32)}`;
    const credentialDraft = createCreatorAgentPackageDraftSnapshotV2({
      ...exactInput,
      content: { ...exact.content, instructions: `Use ${credential} for the request.` },
    });
    expect(() => compileExactDraftV2(credentialDraft)).toThrowError(
      expect.objectContaining({ code: 'AGENT_PACKAGE_V2_COMPILE_DRAFT_UNSAFE' }),
    );
    let credentialFailure: unknown;
    try {
      compileExactDraftV2(credentialDraft);
    } catch (error) {
      credentialFailure = error;
    }
    expect(credentialFailure).toMatchObject({
      code: 'AGENT_PACKAGE_V2_COMPILE_DRAFT_UNSAFE',
      message: 'Current-conversation Agent Package Draft content is unsafe or non-portable.',
    });
    expect(String(credentialFailure)).not.toContain(credential);
    for (const credentialMaterial of [
      '-----BEGIN ENCRYPTED PRIVATE KEY-----',
      `-----BEGIN ${'DSA'} PRIVATE KEY-----`,
      `-----BEGIN ${'PGP'} PRIVATE KEY BLOCK-----`,
      `sk_live_${'b'.repeat(24)}`,
      `ASIA${'A'.repeat(16)}`,
      `Authorization: Bearer ${'z'.repeat(16)}`,
      `Authorization\u00a0:\u00a0Bearer\u00a0${'z'.repeat(16)}`,
      'Bearer abc.def123.ghi.',
      `password=${'correcthorsebatterystaple'}`,
      `password\u00a0=\u00a0${'correcthorsebatterystaple'}`,
      `password${' '.repeat(33)}=${' '.repeat(33)}${'correcthorsebatterystaple'}`,
      `private_key=${'abcdefghijklmnopqrstuvwxyz'}`,
      `{\n  "password":\n  "abc12345"\n}`,
      'token: abc123def456',
      'password: challenge-response1',
    ]) {
      const credentialVariant = createCreatorAgentPackageDraftSnapshotV2({
        ...exactInput,
        content: { ...exact.content, instructions: `Never publish ${credentialMaterial}` },
      });
      expect(() => compileExactDraftV2(credentialVariant)).toThrowError(
        expect.objectContaining({ code: 'AGENT_PACKAGE_V2_COMPILE_DRAFT_UNSAFE' }),
      );
    }

    const benignAcronymDraft = createCreatorAgentPackageDraftSnapshotV2({
      ...exactInput,
      content: {
        ...exact.content,
        instructions:
          'Review NC policy, SSH hardening, and SCP documentation. Define password: minimum length and rotation. Use Basic authentication. Use basic authentication for API requests. Use basic challenge-response authentication and client_server negotiation. Explain Token classification. Explain Token sha-256. Explain Token hmac-sha-256. Explain token classification carefully. Explain token role-based-access controls and request_validation behavior. Explain the token:',
        outputDescription:
          'Compare results without including a credential. Document Bearer requirements. Document bearer authentication requirements, proof-of-possession semantics, and proof_of_possession semantics. Document token: sha-256. Document token: argon2id. Define password: minimum.',
      },
    });
    expect(() => compileExactDraftV2(benignAcronymDraft)).not.toThrow();

    expect(() => buildCreatorAgentPackageFromDraft(exact as never)).toThrow();

    let getterReads = 0;
    expect(() => compileCreatorAgentPackageDraftV2(exact)).toThrowError(
      expect.objectContaining({ code: 'AGENT_PACKAGE_V2_COMPILE_DRAFT_INCOMPLETE' }),
    );
    expect(() =>
      compileCreatorAgentPackageDraftV2({
        get protocol() {
          getterReads += 1;
          return CREATOR_AGENT_PACKAGE_DRAFT_V2_PROTOCOL;
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'AGENT_PACKAGE_V2_COMPILE_DRAFT_INCOMPLETE' }));
    const proxy = new Proxy(exact, {
      ownKeys(target) {
        getterReads += 1;
        return Reflect.ownKeys(target);
      },
    });
    expect(() => compileCreatorAgentPackageDraftV2(proxy)).toThrowError(
      expect.objectContaining({ code: 'AGENT_PACKAGE_V2_COMPILE_DRAFT_INCOMPLETE' }),
    );

    const revokedObject = Proxy.revocable(exact, {});
    revokedObject.revoke();
    expect(() => compileCreatorAgentPackageDraftV2(revokedObject.proxy)).toThrowError(
      expect.objectContaining({ code: 'AGENT_PACKAGE_V2_COMPILE_DRAFT_INCOMPLETE' }),
    );
    expect(() => compileCreatorAgentPackageDraftV2('x'.repeat(70_000))).toThrowError(
      expect.objectContaining({ code: 'AGENT_PACKAGE_V2_COMPILE_DRAFT_INCOMPLETE' }),
    );
    expect(() => compileCreatorAgentPackageDraftV2('界'.repeat(30_000))).toThrowError(
      expect.objectContaining({ code: 'AGENT_PACKAGE_V2_COMPILE_DRAFT_INCOMPLETE' }),
    );
    expect(() => compileCreatorAgentPackageDraftV2(` ${exactText}`)).toThrowError(
      expect.objectContaining({ code: 'AGENT_PACKAGE_V2_COMPILE_DRAFT_INCOMPLETE' }),
    );
    expect(() => compileCreatorAgentPackageDraftV2('{')).toThrowError(
      expect.objectContaining({ code: 'AGENT_PACKAGE_V2_COMPILE_DRAFT_INCOMPLETE' }),
    );
    const hiddenExtra = Object.defineProperty({ ...exact }, 'hidden', {
      enumerable: false,
      get() {
        getterReads += 1;
        return 'secret';
      },
    });
    expect(() => compileCreatorAgentPackageDraftV2(hiddenExtra)).toThrowError(
      expect.objectContaining({ code: 'AGENT_PACKAGE_V2_COMPILE_DRAFT_INCOMPLETE' }),
    );
    const symbolExtra = { ...exact, [Symbol('hidden')]: 'secret' };
    expect(() => compileCreatorAgentPackageDraftV2(symbolExtra)).toThrowError(
      expect.objectContaining({ code: 'AGENT_PACKAGE_V2_COMPILE_DRAFT_INCOMPLETE' }),
    );
    expect(getterReads).toBe(0);
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
