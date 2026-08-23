import { describe, expect, it } from 'vitest';

import {
  CREATOR_AGENT_DEFINITION_PROTOCOL,
  CREATOR_AGENT_DEFINITION_V2_PROTOCOL,
  CREATOR_AGENT_DRAFT_HANDOFF_PROTOCOL,
  createCreatorAgentDraftHandoff,
  createCreatorAgentDraftHandoffV2,
  createCreatorAgentDefinition,
  createCreatorAgentDraftSnapshot,
  createCreatorAgentDraftSnapshotV2,
  createCreatorAgentDefinitionV2,
  createCreatorAgentProjectSourceLedger,
  fingerprintCreatorAgentDefinition,
  freezeCreatorAgentVersion,
  freezeCreatorAgentVersionAny,
  freezeCreatorAgentVersionV2,
  parseCreatorAgentDraftHandoffAny,
  parseCreatorAgentDraftHandoffV2,
  parseCreatorAgentDraftHandoff,
  parseCreatorAgentVersion,
  parseCreatorAgentVersionAny,
  serializeCreatorAgentDraftHandoffV2,
  serializeCreatorAgentVersionV2,
  serializeCreatorAgentDraftSnapshot,
  serializeCreatorAgentDraftHandoff,
  serializeCreatorAgentVersion,
  verifyCreatorAgentDraftSnapshot,
  verifyCreatorAgentDraftHandoff,
  verifyCreatorAgentVersion,
  verifyCreatorAgentVersionV2,
  type CreatorAgentDefinitionV1,
} from '../agent.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function definition(overrides: Partial<CreatorAgentDefinitionV1> = {}): CreatorAgentDefinitionV1 {
  return {
    protocol: CREATOR_AGENT_DEFINITION_PROTOCOL,
    name: 'Release evidence reviewer',
    description: 'Reviews one release using the creator’s fixed evidence standard.',
    projectSnapshot: {
      kind: 'git',
      repositoryUrl: 'https://github.com/dangdang-tech/Combo.git',
      sourceRef: 'refs/heads/main',
      commitSha: SHA_A,
      treeSha: SHA_B,
    },
    behavior: {
      instructions:
        'Inspect the requested release, separate durable facts from inference, and report blockers.',
      starterPrompts: ['Review the current release candidate.'],
    },
    requirements: {
      codexVersion: '0.148.0-alpha.15',
      commands: ['git'],
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
    ...overrides,
  };
}

function frozenVersion() {
  const draft = createCreatorAgentDraftSnapshot({
    agentId: 'agent.release-review',
    draftId: 'draft.release-review.7',
    draftRevision: 7,
    baseVersionId: null,
    definition: definition(),
  });
  return freezeCreatorAgentVersion({
    versionId: 'version.release-review.1',
    versionNumber: 1,
    createdAtMs: 1_787_413_200_000,
    draft,
  });
}

describe('Creator Agent contract', () => {
  it('round-trips a V2 Project source ledger without changing any V1 bytes', () => {
    const v1Text = serializeCreatorAgentVersion(frozenVersion());
    const sourceLedger = createCreatorAgentProjectSourceLedger({
      contextRootDigest: `sha256:${'c'.repeat(64)}`,
      coverage: {
        indexedEntryCount: 12,
        indexedFileCount: 8,
        indexedByteCount: 4096,
        hiddenEntryCount: 3,
        trackedEntryCount: 4,
        untrackedEntryCount: 2,
        ignoredEntryCount: 2,
        gitAdminEntryCount: 2,
        authoringOnlyEntryCount: 8,
      },
      citedSources: [
        {
          path: 'README.md',
          digest: `sha256:${'d'.repeat(64)}`,
          executionAvailability: 'FIXED_GIT_TREE',
        },
        {
          path: 'logs/creator.jsonl',
          digest: `sha256:${'e'.repeat(64)}`,
          executionAvailability: 'AUTHORING_ONLY',
        },
      ],
    });
    const definitionV2 = createCreatorAgentDefinitionV2({
      ...definition(),
      protocol: CREATOR_AGENT_DEFINITION_V2_PROTOCOL,
      authoringSource: { kind: 'project_context_compiler', sourceLedger },
    });
    const draft = createCreatorAgentDraftSnapshotV2({
      agentId: 'agent.context-review',
      draftId: 'draft.context-review.1',
      draftRevision: 1,
      baseVersionId: null,
      definition: definitionV2,
    });
    const handoff = createCreatorAgentDraftHandoffV2({ draft });
    const handoffText = serializeCreatorAgentDraftHandoffV2(handoff);
    const version = freezeCreatorAgentVersionV2({
      versionId: 'version.context-review.1',
      versionNumber: 1,
      createdAtMs: 1_787_413_200_000,
      draft,
    });
    const versionText = serializeCreatorAgentVersionV2(version);

    expect(parseCreatorAgentDraftHandoffV2(handoffText)).toEqual(handoff);
    expect(parseCreatorAgentDraftHandoffAny(handoffText)).toEqual(handoff);
    expect(parseCreatorAgentVersionAny(versionText)).toEqual(version);
    expect(parseCreatorAgentVersion(v1Text)).toEqual(frozenVersion());
    expect(() =>
      verifyCreatorAgentVersionV2({
        ...version,
        definition: {
          ...version.definition,
          authoringSource: {
            ...version.definition.authoringSource,
            sourceLedger: {
              ...sourceLedger,
              citedSources: [
                { ...sourceLedger.citedSources[0]!, executionAvailability: 'AUTHORING_ONLY' },
                sourceLedger.citedSources[1]!,
              ],
            },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      createCreatorAgentProjectSourceLedger({
        contextRootDigest: `sha256:${'c'.repeat(64)}`,
        coverage: {
          indexedEntryCount: 0,
          indexedFileCount: 1,
          indexedByteCount: 1,
          hiddenEntryCount: 1,
          trackedEntryCount: 1,
          untrackedEntryCount: 1,
          ignoredEntryCount: 1,
          gitAdminEntryCount: 1,
          authoringOnlyEntryCount: 1,
        },
        citedSources: [
          {
            path: 'README.md',
            digest: `sha256:${'d'.repeat(64)}`,
            executionAvailability: 'FIXED_GIT_TREE',
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      createCreatorAgentProjectSourceLedger({
        contextRootDigest: `sha256:${'c'.repeat(64)}`,
        coverage: {
          indexedEntryCount: 100,
          indexedFileCount: 1,
          indexedByteCount: 1,
          hiddenEntryCount: 0,
          trackedEntryCount: 1,
          untrackedEntryCount: 0,
          ignoredEntryCount: 0,
          gitAdminEntryCount: 0,
          authoringOnlyEntryCount: 1,
        },
        citedSources: [
          {
            path: 'README.md',
            digest: `sha256:${'d'.repeat(64)}`,
            executionAvailability: 'FIXED_GIT_TREE',
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects accessor and Proxy inputs on V2 handoff and generic freeze dispatch', () => {
    const sourceLedger = createCreatorAgentProjectSourceLedger({
      contextRootDigest: `sha256:${'c'.repeat(64)}`,
      coverage: {
        indexedEntryCount: 1,
        indexedFileCount: 1,
        indexedByteCount: 1,
        hiddenEntryCount: 0,
        trackedEntryCount: 1,
        untrackedEntryCount: 0,
        ignoredEntryCount: 0,
        gitAdminEntryCount: 0,
        authoringOnlyEntryCount: 0,
      },
      citedSources: [
        {
          path: 'README.md',
          digest: `sha256:${'d'.repeat(64)}`,
          executionAvailability: 'FIXED_GIT_TREE',
        },
      ],
    });
    const draft = createCreatorAgentDraftSnapshotV2({
      agentId: 'agent.context-accessor',
      draftId: 'draft.context-accessor.1',
      draftRevision: 1,
      baseVersionId: null,
      definition: createCreatorAgentDefinitionV2({
        ...definition(),
        protocol: CREATOR_AGENT_DEFINITION_V2_PROTOCOL,
        authoringSource: { kind: 'project_context_compiler', sourceLedger },
      }),
    });
    let getterReads = 0;
    const accessorInput = Object.defineProperty({}, 'draft', {
      enumerable: true,
      get() {
        getterReads += 1;
        return draft;
      },
    });
    expect(() => createCreatorAgentDraftHandoffV2(accessorInput as never)).toThrow(
      /data properties/u,
    );
    expect(getterReads).toBe(0);

    let proxyReads = 0;
    const proxiedDraft = new Proxy(draft, {
      get(target, key, receiver) {
        proxyReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() =>
      freezeCreatorAgentVersionAny({
        versionId: 'version.context-accessor.1',
        versionNumber: 1,
        createdAtMs: 1,
        draft: proxiedDraft,
      }),
    ).toThrow(/Proxy/u);
    expect(proxyReads).toBe(0);
  });

  it('freezes one detached Definition, Draft, and immutable Version', () => {
    const callerOwned = definition();
    const draft = createCreatorAgentDraftSnapshot({
      agentId: 'agent.release-review',
      draftId: 'draft.release-review.7',
      draftRevision: 7,
      baseVersionId: null,
      definition: callerOwned,
    });
    const version = freezeCreatorAgentVersion({
      versionId: 'version.release-review.1',
      versionNumber: 1,
      createdAtMs: 1_787_413_200_000,
      draft,
    });

    expect(version.definition).not.toBe(callerOwned);
    expect(version.definition).toEqual(callerOwned);
    expect(version.definitionFingerprint).toBe(draft.definitionFingerprint);
    expect(version.sourceDraft).toEqual({
      draftId: draft.draftId,
      draftRevision: draft.draftRevision,
      draftFingerprint: draft.draftFingerprint,
    });
    expect(Object.isFrozen(version)).toBe(true);
    expect(Object.isFrozen(version.definition)).toBe(true);
    expect(Object.isFrozen(version.definition.behavior.starterPrompts)).toBe(true);
    expect(version.definitionFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(version.versionFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('round-trips only exact canonical version JSON', () => {
    const version = frozenVersion();
    const text = serializeCreatorAgentVersion(version);
    const parsed = parseCreatorAgentVersion(text);

    expect(parsed).toEqual(version);
    expect(parsed).not.toBe(version);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(() => parseCreatorAgentVersion(`${text}\n`)).toThrow(/canonical/u);
    expect(() => parseCreatorAgentVersion(JSON.stringify(version, null, 2))).toThrow(/canonical/u);
  });

  it('serializes equivalent Draft key orders to one canonical snapshot', () => {
    const version = frozenVersion();
    const draft = createCreatorAgentDraftSnapshot({
      agentId: version.agentId,
      draftId: 'draft.release-review.canonical',
      draftRevision: 1,
      baseVersionId: version.versionId,
      definition: version.definition,
    });
    const reordered = {
      draftFingerprint: draft.draftFingerprint,
      definitionFingerprint: draft.definitionFingerprint,
      definition: draft.definition,
      baseVersionId: draft.baseVersionId,
      draftRevision: draft.draftRevision,
      draftId: draft.draftId,
      agentId: draft.agentId,
      protocol: draft.protocol,
    };
    expect(serializeCreatorAgentDraftSnapshot(reordered)).toBe(
      serializeCreatorAgentDraftSnapshot(draft),
    );
  });

  it('round-trips a strict visible-task Draft handoff without raw task state', () => {
    const version = frozenVersion();
    const draft = createCreatorAgentDraftSnapshot({
      agentId: version.agentId,
      draftId: 'draft.release-review.8',
      draftRevision: 8,
      baseVersionId: version.versionId,
      definition: version.definition,
    });
    const handoff = createCreatorAgentDraftHandoff({ draft });
    const text = serializeCreatorAgentDraftHandoff(handoff);

    expect(handoff).toMatchObject({
      protocol: CREATOR_AGENT_DRAFT_HANDOFF_PROTOCOL,
      intent: 'import_local_draft',
      draft,
    });
    expect(Object.isFrozen(handoff)).toBe(true);
    expect(parseCreatorAgentDraftHandoff(text)).toEqual(handoff);
    expect(() => parseCreatorAgentDraftHandoff(`${text}\n`)).toThrow(/canonical/u);
    expect(() => parseCreatorAgentDraftHandoff(JSON.stringify(handoff, null, 2))).toThrow(
      /canonical/u,
    );
    expect(() =>
      verifyCreatorAgentDraftHandoff({ ...handoff, rawTask: 'forbidden transcript' }),
    ).toThrow();
  });

  it('rejects manual or tampered Drafts on the current-task handoff route', () => {
    const version = frozenVersion();
    const manual = createCreatorAgentDraftSnapshot({
      agentId: 'agent.manual',
      draftId: 'draft.manual.1',
      draftRevision: 1,
      baseVersionId: null,
      definition: {
        ...version.definition,
        authoringSource: { kind: 'manual', rawStored: false },
      },
    });
    expect(() => createCreatorAgentDraftHandoff({ draft: manual })).toThrow(/visible Codex task/u);

    const taskDraft = createCreatorAgentDraftSnapshot({
      agentId: version.agentId,
      draftId: 'draft.release-review.tamper',
      draftRevision: 1,
      baseVersionId: version.versionId,
      definition: version.definition,
    });
    expect(() =>
      createCreatorAgentDraftHandoff({ draft: { ...taskDraft, draftRevision: 2 } }),
    ).toThrow(/draft fingerprint/u);
    expect(() =>
      createCreatorAgentDraftHandoff({ draft: taskDraft, taskId: 'hidden' } as never),
    ).toThrow();
  });

  it('rejects Proxy-backed handoff inputs without reading their traps', () => {
    const version = frozenVersion();
    const draft = createCreatorAgentDraftSnapshot({
      agentId: version.agentId,
      draftId: 'draft.release-review.proxy',
      draftRevision: 1,
      baseVersionId: version.versionId,
      definition: version.definition,
    });
    let draftReads = 0;
    const proxiedDraft = new Proxy(draft, {
      get(target, key, receiver) {
        draftReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() => createCreatorAgentDraftHandoff({ draft: proxiedDraft })).toThrow(/Proxy/u);
    expect(draftReads).toBe(0);

    let outerReads = 0;
    const proxiedInput = new Proxy(
      { draft },
      {
        get(target, key, receiver) {
          outerReads += 1;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    expect(() => createCreatorAgentDraftHandoff(proxiedInput)).toThrow(/Proxy/u);
    expect(outerReads).toBe(0);
  });

  it('rejects ambiguous, over-complex, and unrelated handoff wire text', () => {
    const version = frozenVersion();
    const draft = createCreatorAgentDraftSnapshot({
      agentId: version.agentId,
      draftId: 'draft.release-review.wire',
      draftRevision: 1,
      baseVersionId: version.versionId,
      definition: version.definition,
    });
    const text = serializeCreatorAgentDraftHandoff(createCreatorAgentDraftHandoff({ draft }));
    expect(() =>
      parseCreatorAgentDraftHandoff(text.replace('"intent":', '"intent":"wrong","intent":')),
    ).toThrow(/canonical/u);
    expect(() =>
      parseCreatorAgentDraftHandoff(`{"unknown":${'['.repeat(20_000)}0${']'.repeat(20_000)}}`),
    ).toThrow(/complexity/u);
    expect(() =>
      parseCreatorAgentDraftHandoff(
        JSON.stringify({
          schemaVersion: 'combo.creator-bootstrap-handoff/1',
          continueIntent: 'create_codex_agent_share',
        }),
      ),
    ).toThrow();
  });

  it('keeps behavior identity separate from draft and version identity', () => {
    const first = frozenVersion();
    const secondDraft = createCreatorAgentDraftSnapshot({
      agentId: first.agentId,
      draftId: 'draft.release-review.8',
      draftRevision: 8,
      baseVersionId: first.versionId,
      definition: first.definition,
    });
    const second = freezeCreatorAgentVersion({
      versionId: 'version.release-review.2',
      versionNumber: 2,
      createdAtMs: first.createdAtMs + 1,
      draft: secondDraft,
    });

    expect(second.definitionFingerprint).toBe(first.definitionFingerprint);
    expect(secondDraft.draftFingerprint).not.toBe(first.sourceDraft.draftFingerprint);
    expect(second.versionFingerprint).not.toBe(first.versionFingerprint);
  });

  it('rejects definition, draft, and version tampering', () => {
    const version = frozenVersion();
    const changedDefinition = {
      ...version,
      definition: {
        ...version.definition,
        behavior: { ...version.definition.behavior, instructions: 'Different behavior.' },
      },
    };
    expect(() => verifyCreatorAgentVersion(changedDefinition)).toThrow(/definition fingerprint/u);
    expect(() => verifyCreatorAgentVersion({ ...version, versionNumber: 2 })).toThrow(
      /version fingerprint/u,
    );

    const draft = createCreatorAgentDraftSnapshot({
      agentId: version.agentId,
      draftId: 'draft.tamper',
      draftRevision: 1,
      baseVersionId: null,
      definition: version.definition,
    });
    expect(() => verifyCreatorAgentDraftSnapshot({ ...draft, draftRevision: 2 })).toThrow(
      /draft fingerprint/u,
    );
  });

  it('fails closed on unsupported runtime claims and malformed Git sources', () => {
    expect(() =>
      createCreatorAgentDefinition({
        ...definition(),
        runtime: { ...definition().runtime, skills: ['filesystem'] },
      }),
    ).toThrow();
    expect(() =>
      createCreatorAgentDefinition({
        ...definition(),
        projectSnapshot: {
          ...definition().projectSnapshot,
          sourceRef: 'refs/tags/v1.0.0',
        },
      }),
    ).toThrow();
    expect(() =>
      createCreatorAgentDefinition({
        ...definition(),
        runtime: { ...definition().runtime, toolNetworkAccess: true },
      }),
    ).toThrow();
    expect(() =>
      createCreatorAgentDefinition({
        ...definition(),
        projectSnapshot: {
          ...definition().projectSnapshot,
          repositoryUrl: 'ssh://github.com/dangdang-tech/Combo.git',
        },
      }),
    ).toThrow();
    for (const repositoryUrl of [
      'https://github.com/a-/repo.git',
      'https://github.com/a/...git',
      'https://github.com/a/repo.git.git',
    ]) {
      expect(() =>
        createCreatorAgentDefinition({
          ...definition(),
          projectSnapshot: { ...definition().projectSnapshot, repositoryUrl },
        }),
      ).toThrow();
    }
    for (const sourceRef of [
      'refs/heads/foo.lock/bar',
      'refs/heads/.hidden',
      'refs/heads/a..b',
      'refs/heads/a@{b',
    ]) {
      expect(() =>
        createCreatorAgentDefinition({
          ...definition(),
          projectSnapshot: { ...definition().projectSnapshot, sourceRef },
        }),
      ).toThrow();
    }
    expect(() => createCreatorAgentDefinition({ ...definition(), unknown: true })).toThrow();
  });

  it('rejects accessors, sparse arrays, duplicate prompts, and malformed Unicode', () => {
    let getterReads = 0;
    const withGetter = { ...definition() } as Record<string, unknown>;
    Object.defineProperty(withGetter, 'name', {
      enumerable: true,
      get() {
        getterReads += 1;
        return 'unsafe';
      },
    });
    expect(() => createCreatorAgentDefinition(withGetter)).toThrow(/data properties/u);
    expect(getterReads).toBe(0);

    const sparse = new Array<string>(1);
    expect(() =>
      createCreatorAgentDefinition({
        ...definition(),
        behavior: { ...definition().behavior, starterPrompts: sparse },
      }),
    ).toThrow(/dense/u);
    expect(() =>
      createCreatorAgentDefinition({
        ...definition(),
        behavior: { ...definition().behavior, starterPrompts: ['same', 'same'] },
      }),
    ).toThrow(/unique/u);
    expect(() => createCreatorAgentDefinition({ ...definition(), name: '\ud800' })).toThrow();

    let outerReads = 0;
    const draftInput = {
      agentId: 'agent.getter',
      draftId: 'draft.getter',
      draftRevision: 1,
      baseVersionId: null,
      definition: definition(),
    };
    Object.defineProperty(draftInput, 'agentId', {
      enumerable: true,
      get() {
        outerReads += 1;
        return 'agent.getter';
      },
    });
    expect(() => createCreatorAgentDraftSnapshot(draftInput)).toThrow(/data properties/u);
    expect(outerReads).toBe(0);
  });

  it('rejects deeply nested or oversized unknown JSON before recursive canonicalization', () => {
    const deeplyNested = `{"unknown":${'['.repeat(20_000)}0${']'.repeat(20_000)}}`;
    expect(() => parseCreatorAgentVersion(deeplyNested)).toThrow(/complexity/u);
    expect(() =>
      createCreatorAgentDefinition({ ...definition(), unknown: 'x'.repeat(70_000) }),
    ).toThrow(/byte limit/u);
  });

  it('produces a stable definition fingerprint independent of object key order', () => {
    const original = definition();
    const reordered = {
      runtime: original.runtime,
      authoringSource: original.authoringSource,
      requirements: original.requirements,
      behavior: original.behavior,
      projectSnapshot: original.projectSnapshot,
      description: original.description,
      name: original.name,
      protocol: original.protocol,
    };
    expect(fingerprintCreatorAgentDefinition(reordered)).toBe(
      fingerprintCreatorAgentDefinition(original),
    );
  });
});
