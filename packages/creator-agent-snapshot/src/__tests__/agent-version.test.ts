import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  SNAPSHOT_ARCHIVE_OBJECT_FORMAT,
  SNAPSHOT_ENVELOPE_PROTOCOL,
  snapshotArchiveEnvelopeAadDigest,
  snapshotArchiveObjectKey,
} from '@cb/creator-agent-protocol';

import {
  buildAgentVersion,
  InMemoryConversationPinRepository,
  InMemoryImmutableAgentVersionRepository,
  InMemoryImmutableSnapshotRepository,
  isSnapshotError,
  sha256Hex,
  createSnapshotManifest,
  snapshotDigest,
  snapshotManifestBytes,
  type AgentVersionExecutionInput,
} from '../index.js';

const digest = (marker: string) => sha256Hex(Buffer.from(marker, 'utf8'));

function execution(
  overrides: Partial<AgentVersionExecutionInput> = {},
): AgentVersionExecutionInput {
  return {
    snapshotDigest: digest('snapshot'),
    behaviorContract: {
      schemaVersion: 1,
      role: 'Synthetic research assistant',
      objective: 'Use the sealed context',
      developerInstructions: ['Use evidence', 'Do not invent facts'],
      language: 'zh-CN',
      evidencePolicy: 'cite-relative-path-when-used',
      answerStyle: 'conclusion-evidence-risk',
    },
    runtimePolicy: {
      schemaVersion: 1,
      isolation: 'conversation-vm-required',
      filesystem: {
        context: 'read-only-noexec',
        scratch: 'conversation-only',
        hostMounts: 'forbidden',
      },
      contextTools: ['read_context', 'list_context', 'search_context'],
      projectExecution: 'forbidden',
      network: 'model-proxy-only',
      externalTools: 'disabled',
      hostCredentials: 'forbidden',
      maxTurnSeconds: 120,
      maxConversationTurns: 20,
      maxVisibleHistoryBytes: 65_536,
      maxActiveTurns: 1,
      resolvedModel: 'gpt-test-pinned',
      reasoningEffort: 'high',
    },
    ioContract: {
      schemaVersion: 1,
      input: { type: 'text', maxUtf8Bytes: 16_384 },
      output: { type: 'text', maxUtf8Bytes: 32_768 },
      files: false,
      actions: false,
      rawReasoning: false,
    },
    codexRuntime: {
      version: '0.147.0-test-linux-arm64',
      artifactDigest: `sha256:${digest('codex-artifact')}`,
      protocolSchemaDigest: `sha256:${digest('protocol-schema')}`,
      platform: 'linux-arm64',
    },
    modelPolicy: {
      schemaVersion: 1,
      model: 'gpt-test-pinned',
      reasoningEffort: 'high',
      creatorFunded: true,
    },
    ...overrides,
  };
}

describe('AgentVersion digest', () => {
  it('builds the authoritative protocol fixture without a duplicate local schema', async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL(
          '../../../creator-agent-protocol/fixtures/agent-version-manifest.v1.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as AgentVersionExecutionInput & { protocol: string; schemaVersion: number };
    const { protocol: _protocol, schemaVersion: _schemaVersion, ...input } = fixture;
    const built = buildAgentVersion(input);

    expect(JSON.parse(built.manifestBytes.toString('utf8'))).toEqual(fixture);
    expect(built.versionDigest).toBe(sha256Hex(built.manifestBytes));
  });

  it('is independent of JSON key order', () => {
    const first = buildAgentVersion(execution());
    const second = buildAgentVersion(
      execution({
        behaviorContract: {
          language: 'zh-CN',
          objective: 'Use the sealed context',
          schemaVersion: 1,
          role: 'Synthetic research assistant',
          developerInstructions: ['Use evidence', 'Do not invent facts'],
          evidencePolicy: 'cite-relative-path-when-used',
          answerStyle: 'conclusion-evidence-risk',
        },
      }),
    );
    expect(second.behaviorContractDigest).toBe(first.behaviorContractDigest);
    expect(second.versionDigest).toBe(first.versionDigest);
  });

  it.each([
    [
      'snapshot',
      (value: AgentVersionExecutionInput) => ({ ...value, snapshotDigest: digest('two') }),
    ],
    [
      'behavior',
      (value: AgentVersionExecutionInput) => ({
        ...value,
        behaviorContract: { ...value.behaviorContract, objective: 'Changed objective' },
      }),
    ],
    [
      'runtime',
      (value: AgentVersionExecutionInput) => ({
        ...value,
        runtimePolicy: { ...value.runtimePolicy, maxTurnSeconds: 119 },
      }),
    ],
    [
      'codex artifact',
      (value: AgentVersionExecutionInput) => ({
        ...value,
        codexRuntime: {
          ...value.codexRuntime,
          artifactDigest: `sha256:${digest('other-runtime')}` as `sha256:${string}`,
        },
      }),
    ],
    [
      'protocol schema',
      (value: AgentVersionExecutionInput) => ({
        ...value,
        codexRuntime: {
          ...value.codexRuntime,
          protocolSchemaDigest: `sha256:${digest('other-schema')}` as `sha256:${string}`,
        },
      }),
    ],
    [
      'model and effort',
      (value: AgentVersionExecutionInput) => ({
        ...value,
        runtimePolicy: {
          ...value.runtimePolicy,
          resolvedModel: 'other-model',
          reasoningEffort: 'medium' as const,
        },
        modelPolicy: {
          ...value.modelPolicy,
          model: 'other-model',
          reasoningEffort: 'medium' as const,
        },
      }),
    ],
  ] as const)('changes versionDigest when %s changes', (_name, mutate) => {
    expect(buildAgentVersion(mutate(execution())).versionDigest).not.toBe(
      buildAgentVersion(execution()).versionDigest,
    );
  });

  it('rejects an IO contract outside the frozen Alpha text-only contract', () => {
    expectAgentVersionFailure(
      () =>
        buildAgentVersion(
          execution({
            ioContract: {
              ...execution().ioContract,
              output: { type: 'text', maxUtf8Bytes: 32_767 },
            } as unknown as AgentVersionExecutionInput['ioContract'],
          }),
        ),
      'AGENT_VERSION_INVALID',
    );
  });

  it('does not include display name or description in execution identity', () => {
    const repository = new InMemoryImmutableAgentVersionRepository();
    const first = repository.publish({
      id: 'version-1',
      agentId: 'agent-1',
      creatorId: 'creator-1',
      ordinal: 1,
      execution: execution(),
      displayName: 'First display name',
      description: 'First description',
    });
    const replay = repository.publish({
      id: 'ignored-second-id',
      agentId: 'agent-1',
      creatorId: 'creator-1',
      ordinal: 2,
      execution: execution(),
      displayName: 'Changed display name',
      description: 'Changed description',
    });
    expect(replay.id).toBe(first.id);
    expect(replay.versionDigest).toBe(first.versionDigest);
  });

  it('returns deeply frozen execution contracts', () => {
    const built = buildAgentVersion(execution());
    expect(Object.isFrozen(built.manifest)).toBe(true);
    expect(Object.isFrozen(built.manifest.behaviorContract)).toBe(true);
    expect(Object.isFrozen(built.manifest.behaviorContract.developerInstructions)).toBe(true);
    expect(Object.isFrozen(built.manifest.runtimePolicy.filesystem)).toBe(true);
    expect(Object.isFrozen(built.manifest.runtimePolicy.contextTools)).toBe(true);
    expect(Object.isFrozen(built.manifest.ioContract.input)).toBe(true);
    expect(Object.isFrozen(built.manifest.codexRuntime)).toBe(true);
    expect(Object.isFrozen(built.manifest.modelPolicy)).toBe(true);
  });
});

describe('immutable version and conversation pin repositories', () => {
  it('rejects id and ordinal reuse with different execution identity', () => {
    const repository = new InMemoryImmutableAgentVersionRepository();
    repository.publish({
      id: 'version-1',
      agentId: 'agent-1',
      creatorId: 'creator-1',
      ordinal: 1,
      execution: execution(),
    });
    expectAgentVersionFailure(
      () =>
        repository.publish({
          id: 'version-1',
          agentId: 'agent-1',
          creatorId: 'creator-1',
          ordinal: 2,
          execution: execution({ snapshotDigest: digest('changed') }),
        }),
      'AGENT_VERSION_IMMUTABLE_CONFLICT',
    );
    expectAgentVersionFailure(
      () =>
        repository.publish({
          id: 'version-2',
          agentId: 'agent-1',
          creatorId: 'creator-1',
          ordinal: 1,
          execution: execution({ snapshotDigest: digest('changed') }),
        }),
      'AGENT_VERSION_IMMUTABLE_CONFLICT',
    );
  });

  it('does not let an exact replay hide an id already owned by another version', () => {
    const repository = new InMemoryImmutableAgentVersionRepository();
    repository.publish({
      id: 'version-1',
      agentId: 'agent-1',
      creatorId: 'creator-1',
      ordinal: 1,
      execution: execution(),
    });
    repository.publish({
      id: 'version-2',
      agentId: 'agent-1',
      creatorId: 'creator-1',
      ordinal: 2,
      execution: execution({ snapshotDigest: digest('snapshot-v2') }),
    });
    expectAgentVersionFailure(
      () =>
        repository.publish({
          id: 'version-2',
          agentId: 'agent-1',
          creatorId: 'creator-1',
          ordinal: 3,
          execution: execution(),
        }),
      'AGENT_VERSION_IMMUTABLE_CONFLICT',
    );
  });

  it('stores revocation in a separate control object without changing the version', () => {
    const repository = new InMemoryImmutableAgentVersionRepository();
    const published = repository.publish({
      id: 'version-1',
      agentId: 'agent-1',
      creatorId: 'creator-1',
      ordinal: 1,
      execution: execution(),
    });
    repository.setControl('version-1', {
      availability: 'REVOKED',
      severity: 'SECURITY',
      reasonCode: 'SECURITY_REVOKE_TEST',
    });
    expect(repository.get('version-1')).toEqual(published);
    expect(repository.getControl('version-1')).toEqual({
      availability: 'REVOKED',
      severity: 'SECURITY',
      reasonCode: 'SECURITY_REVOKE_TEST',
    });
  });

  it('pins a Conversation once and rejects deployment cutover attempts', () => {
    const pins = new InMemoryConversationPinRepository();
    const v1 = buildAgentVersion(execution());
    const v2 = buildAgentVersion(execution({ snapshotDigest: digest('snapshot-v2') }));
    expect(
      pins.createOrGet({
        conversationId: 'conversation-1',
        agentId: 'agent-1',
        agentVersionId: 'version-1',
        versionDigest: v1.versionDigest,
      }),
    ).toMatchObject({ agentVersionId: 'version-1' });
    expect(() => pins.assertPinned('conversation-1', 'version-1', v1.versionDigest)).not.toThrow();
    expectAgentVersionFailure(
      () =>
        pins.createOrGet({
          conversationId: 'conversation-1',
          agentId: 'agent-1',
          agentVersionId: 'version-2',
          versionDigest: v2.versionDigest,
        }),
      'CONVERSATION_VERSION_PIN_CONFLICT',
    );
  });

  it('clones stored contract JSON so caller mutations cannot alter a published version', () => {
    const repository = new InMemoryImmutableAgentVersionRepository();
    const mutableBehavior = { ...execution().behaviorContract, objective: 'original' };
    const published = repository.publish({
      id: 'version-1',
      agentId: 'agent-1',
      creatorId: 'creator-1',
      ordinal: 1,
      execution: execution({ behaviorContract: mutableBehavior }),
    });
    mutableBehavior.objective = 'mutated';
    expect(repository.get('version-1')?.behaviorContract).toEqual({
      ...execution().behaviorContract,
      objective: 'original',
    });
    expect(repository.get('version-1')?.versionDigest).toBe(published.versionDigest);
  });
});

describe('immutable Snapshot object repository', () => {
  it('returns the same object for exact replay and rejects overwrite', async () => {
    const repository = new InMemoryImmutableSnapshotRepository();
    const manifest = createSnapshotManifest([
      {
        path: 'FACTS.md',
        size: 5,
        mediaType: 'text/markdown; charset=utf-8',
        sha256: sha256Hex(Buffer.from('facts')),
      },
    ]);
    const manifestBytes = snapshotManifestBytes(manifest);
    const encryptedObjectBytes = Buffer.concat([
      Buffer.from('CSNPENC1'),
      Buffer.alloc(12, 1),
      Buffer.alloc(1, 2),
      Buffer.alloc(16, 3),
    ]);
    const creatorId = '0198f00d-8000-7000-8000-000000000099';
    const manifestDigest = snapshotDigest(manifest);
    const aad = {
      protocol: SNAPSHOT_ENVELOPE_PROTOCOL,
      schemaVersion: 1 as const,
      cipherObjectFormat: SNAPSHOT_ARCHIVE_OBJECT_FORMAT,
      creatorId,
      snapshotDigest: manifestDigest,
      archiveDigest: digest('archive'),
      objectKey: snapshotArchiveObjectKey(creatorId, manifestDigest),
      plaintextBytes: 1,
      keyId: 'test-kek/key-1',
    };
    const object = {
      envelope: {
        protocol: SNAPSHOT_ENVELOPE_PROTOCOL,
        schemaVersion: 1 as const,
        cipherObjectFormat: SNAPSHOT_ARCHIVE_OBJECT_FORMAT,
        algorithm: 'aes-256-gcm/v1' as const,
        keyWrapAlgorithm: 'rfc3394-aes-256-kw/v1' as const,
        aad,
        aadDigest: snapshotArchiveEnvelopeAadDigest(aad),
        nonce: Buffer.alloc(12, 1).toString('base64url'),
        authTag: Buffer.alloc(16, 3).toString('base64url'),
        wrappedDek: Buffer.alloc(40, 4).toString('base64url'),
        cipherDigest: sha256Hex(encryptedObjectBytes),
        cipherBytes: encryptedObjectBytes.byteLength,
      },
      manifestBytes,
      encryptedObjectBytes,
    };
    expect(await repository.putIfAbsent(object)).toEqual(await repository.putIfAbsent(object));
    const reorderedEnvelope = {
      cipherBytes: object.envelope.cipherBytes,
      cipherDigest: object.envelope.cipherDigest,
      wrappedDek: object.envelope.wrappedDek,
      authTag: object.envelope.authTag,
      nonce: object.envelope.nonce,
      aadDigest: object.envelope.aadDigest,
      aad: {
        keyId: aad.keyId,
        plaintextBytes: aad.plaintextBytes,
        objectKey: aad.objectKey,
        archiveDigest: aad.archiveDigest,
        snapshotDigest: aad.snapshotDigest,
        creatorId: aad.creatorId,
        cipherObjectFormat: aad.cipherObjectFormat,
        schemaVersion: aad.schemaVersion,
        protocol: aad.protocol,
      },
      keyWrapAlgorithm: object.envelope.keyWrapAlgorithm,
      algorithm: object.envelope.algorithm,
      cipherObjectFormat: object.envelope.cipherObjectFormat,
      schemaVersion: object.envelope.schemaVersion,
      protocol: object.envelope.protocol,
    };
    expect(await repository.putIfAbsent({ ...object, envelope: reorderedEnvelope })).toEqual(
      await repository.putIfAbsent(object),
    );
    const competingBytes = Buffer.from(encryptedObjectBytes);
    competingBytes[competingBytes.length - 1] = competingBytes[competingBytes.length - 1]! ^ 1;
    await expect(
      repository.putIfAbsent({
        ...object,
        encryptedObjectBytes: competingBytes,
        envelope: {
          ...object.envelope,
          authTag: competingBytes.subarray(competingBytes.length - 16).toString('base64url'),
          cipherDigest: sha256Hex(competingBytes),
        },
      }),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_IMMUTABLE_CONFLICT' });
  });
});

function expectAgentVersionFailure(
  action: () => unknown,
  code: Parameters<typeof isSnapshotError>[1],
): void {
  try {
    action();
    expect.fail(`expected ${code}`);
  } catch (error) {
    expect(isSnapshotError(error, code)).toBe(true);
  }
}
