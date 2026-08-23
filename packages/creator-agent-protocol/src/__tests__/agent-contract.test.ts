import { describe, expect, it } from 'vitest';

import {
  CREATOR_AGENT_DEFINITION_PROTOCOL,
  createCreatorAgentDefinition,
  createCreatorAgentDraftSnapshot,
  fingerprintCreatorAgentDefinition,
  freezeCreatorAgentVersion,
  parseCreatorAgentVersion,
  serializeCreatorAgentVersion,
  verifyCreatorAgentDraftSnapshot,
  verifyCreatorAgentVersion,
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
