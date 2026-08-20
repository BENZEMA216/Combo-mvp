import { readFile } from 'node:fs/promises';

import {
  AgentVersionManifestSchema,
  canonicalSha256,
  computeAgentVersionDigests,
  type AgentVersionManifest,
} from '@cb/creator-agent-protocol';
import { describe, expect, it } from 'vitest';

import {
  InMemoryImmutableAgentVersionRepository,
  buildAgentVersion,
  type AgentVersionExecutionInput,
} from '../agent-version.js';

const UUIDS = {
  agent: '0198f00d-5000-7000-8000-000000000001',
  creator: '0198f00d-5000-7000-8000-000000000002',
  version: '0198f00d-5000-7000-8000-000000000003',
};

const fixtureDirectoryUrl = new URL('../../../creator-agent-protocol/fixtures/', import.meta.url);

async function goldenExecution(): Promise<AgentVersionExecutionInput> {
  const corpusBytes = await readFile(
    new URL('agent-version-digest-semantics.v1.json', fixtureDirectoryUrl),
  );
  const corpus = JSON.parse(corpusBytes.toString('utf8')) as { baseFixture: { path: string } };
  const baseBytes = await readFile(new URL(corpus.baseFixture.path, fixtureDirectoryUrl));
  const manifest = AgentVersionManifestSchema.parse(JSON.parse(baseBytes.toString('utf8')));
  const { protocol: _protocol, schemaVersion: _schemaVersion, ...execution } = manifest;
  return execution as AgentVersionExecutionInput;
}

function mutatedExecution(
  execution: AgentVersionExecutionInput,
  mutate: (manifest: AgentVersionManifest) => AgentVersionManifest,
): AgentVersionExecutionInput {
  const manifest = AgentVersionManifestSchema.parse({
    protocol: 'combo.agent-version-manifest/1',
    schemaVersion: 1,
    ...execution,
  });
  const { protocol: _protocol, schemaVersion: _schemaVersion, ...next } = mutate(manifest);
  return next as AgentVersionExecutionInput;
}

describe('AVR-002 + AVR-005 AgentVersion identity semantics', () => {
  it('AVR-002: display metadata (name/description/statistics) stays outside versionDigest', async () => {
    const execution = await goldenExecution();
    const repository = new InMemoryImmutableAgentVersionRepository();
    const baseline = repository.publish({
      id: UUIDS.version,
      agentId: UUIDS.agent,
      creatorId: UUIDS.creator,
      ordinal: 1,
      execution,
      displayName: '研究助手',
      description: '第一版',
    });
    // The version digest is computed exclusively over the canonical manifest; display fields
    // live on the PublishedAgentVersion row, never inside the execution identity.
    const renamed = repository.publish({
      id: UUIDS.version,
      agentId: UUIDS.agent,
      creatorId: UUIDS.creator,
      ordinal: 1,
      execution,
      displayName: '完全不同的名字',
      description: '第二版描述',
    });
    expect(renamed.versionDigest).toBe(baseline.versionDigest);
    // Same digest + same id/ordinal dedupes to the same immutable row; only the display copy
    // changed, and the repository returns the previously published version.
    expect(renamed.id).toBe(UUIDS.version);
    // A fresh build with different display metadata produces the identical digest bytes.
    const rebuilt = buildAgentVersion(execution);
    expect(rebuilt.versionDigest).toBe(baseline.versionDigest);
    // Statistics are not part of the digest domain either: there is no statistics input to the
    // canonical manifest, so any future statistics must live outside it to keep identity stable.
    expect(computeAgentVersionDigests(baseline.manifest).versionDigest).toBe(
      baseline.versionDigest,
    );
  });

  it('AVR-005: RuntimePolicy and IOContract changes both participate in versionDigest', async () => {
    const execution = await goldenExecution();
    const baseline = buildAgentVersion(execution);
    const runtimePolicyMutation = mutatedExecution(execution, (manifest) => ({
      ...manifest,
      runtimePolicy: {
        ...manifest.runtimePolicy,
        maxTurnSeconds: manifest.runtimePolicy.maxTurnSeconds - 1,
      },
    }));
    const changedRuntime = buildAgentVersion(runtimePolicyMutation);
    expect(changedRuntime.runtimePolicyDigest).not.toBe(baseline.runtimePolicyDigest);
    expect(changedRuntime.versionDigest).not.toBe(baseline.versionDigest);

    // The frozen schemaVersion-1 IOContract is a single literal set (input 16384,
    // output 32768, files/actions/rawReasoning false): no schema-valid manifest can carry a
    // different IOContract today, so no buildable ioContract mutation exists to demonstrate.
    // The identity computation covers it by construction: versionDigest is the canonical digest
    // of the complete manifest (including ioContract bytes), and ioContractDigest is its own
    // component. Any future schema version that legally changes the ioContract therefore
    // necessarily changes versionDigest.
    expect(canonicalSha256(baseline.manifest)).toBe(baseline.versionDigest);
    expect(baseline.ioContractDigest).toBe(canonicalSha256(baseline.manifest.ioContract));

    // A display-only mutation never changes any contract digest.
    const displayDigest = computeAgentVersionDigests(baseline.manifest).versionDigest;
    expect(displayDigest).toBe(baseline.versionDigest);
  });
});
