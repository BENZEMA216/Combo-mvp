import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  BrokerHandshakeSchema,
  ProtocolVersionCorpusSchema,
  type BrokerHandshake,
  type ProtocolVersionCorpus,
} from '@cb/creator-agent-protocol';
import { describe, expect, it } from 'vitest';

import {
  admitGatewayWorkerCompatibility,
  type GatewayCompatibilityPolicy,
  type GatewayWorkerCompatibilityRegistration,
} from './postgres-authority.js';

const fixtureRoot = new URL('../../../packages/creator-agent-protocol/fixtures/', import.meta.url);
const compatibilityFixture = new URL('protocol-compatibility.v1.json', fixtureRoot);
const runtimePolicy = Object.freeze({
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
  resolvedModel: 'gpt-5.6-sol',
  reasoningEffort: 'low',
} as const);

type WorkerProfile = ProtocolVersionCorpus['current'];

async function loadCorpus(): Promise<ProtocolVersionCorpus> {
  return ProtocolVersionCorpusSchema.parse(
    JSON.parse(await readFile(compatibilityFixture, 'utf8')),
  );
}

function profiles(corpus: ProtocolVersionCorpus): readonly WorkerProfile[] {
  return [corpus.declaredPrevious[0], corpus.current];
}

function policyFor(
  corpus: ProtocolVersionCorpus,
  gatewayReleaseId: ProtocolVersionCorpus['gatewayReleases'][number]['releaseId'],
): GatewayCompatibilityPolicy {
  const gateway = corpus.gatewayReleases.find(({ releaseId }) => releaseId === gatewayReleaseId);
  if (gateway === undefined) throw new Error('GATEWAY_RELEASE_NOT_DECLARED');
  const accepted = gateway.acceptedWorkerProfileIds.map((profileId) => {
    const profile = profiles(corpus).find((candidate) => candidate.profileId === profileId);
    if (profile === undefined) throw new Error('WORKER_PROFILE_NOT_DECLARED');
    return profile;
  });
  return {
    acceptedWorkerVersions: accepted.map(({ workerVersion }) => workerVersion),
    acceptedCodexRuntimeArtifacts: accepted.map(
      ({ codexRuntimeArtifacts }) => codexRuntimeArtifacts[0],
    ),
    acceptedCodexProtocolSchemaDigests: accepted.map(
      ({ codexProtocolSchemaDigests }) => codexProtocolSchemaDigests[0],
    ),
    acceptedIsolationModes: accepted.map(({ isolationModes }) => isolationModes[0]),
    acceptedBrokerContractDigests: [gateway.brokerContractDigest],
    sessionTtlMs: 60_000,
    leaseTtlMs: 10_000,
    responseTtlMs: 5_000,
    transactionTimeoutMs: 100,
  };
}

async function handshakeFor(profile: WorkerProfile): Promise<BrokerHandshake> {
  const fixtureUrl = new URL(profile.handshakeFixture.split('/').at(-1)!, fixtureRoot);
  const bytes = await readFile(fixtureUrl);
  expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(
    profile.handshakeFixtureDigest,
  );
  return BrokerHandshakeSchema.parse(JSON.parse(bytes.toString('utf8')));
}

function registrationFor(
  profile: WorkerProfile,
  handshake: BrokerHandshake,
): GatewayWorkerCompatibilityRegistration {
  return {
    workerVersion: handshake.workerVersion,
    protocolVersions: handshake.supportedProtocolVersions,
    capabilities: {
      codexRuntimeArtifacts: handshake.codexRuntimeArtifacts,
      codexProtocolSchemaDigests: handshake.codexProtocolSchemaDigests,
      isolationModes: handshake.isolationModes,
      brokerContractDigest: handshake.brokerContractDigest,
    },
    codexRuntimeArtifactDigest: profile.codexRuntimeArtifacts[0],
    codexProtocolSchemaDigest: profile.codexProtocolSchemaDigests[0],
    runtimePolicy,
  };
}

describe('G0 exact N-1/N compatibility corpus', () => {
  it('SCH-009 executes all four declared Gateway and Worker release pairs', async () => {
    const corpus = await loadCorpus();
    expect(corpus.declaredPairs).toHaveLength(4);

    const executed: string[] = [];
    for (const pair of corpus.declaredPairs) {
      const profile = profiles(corpus).find(({ profileId }) => profileId === pair.workerProfileId);
      if (profile === undefined) throw new Error('PAIR_PROFILE_NOT_DECLARED');
      const handshake = await handshakeFor(profile);
      expect(handshake).toMatchObject({
        protocol: profile.wireProtocol,
        schemaVersion: profile.wireSchemaVersion,
        workerVersion: profile.workerVersion,
        supportedProtocolVersions: profile.supportedProtocolVersions,
        codexRuntimeArtifacts: profile.codexRuntimeArtifacts,
        codexProtocolSchemaDigests: profile.codexProtocolSchemaDigests,
        isolationModes: profile.isolationModes,
        brokerContractDigest: profile.brokerContractDigest,
      });
      let admittedCalls = 0;
      expect(
        admitGatewayWorkerCompatibility(
          policyFor(corpus, pair.gatewayReleaseId),
          handshake,
          registrationFor(profile, handshake),
          () => {
            admittedCalls += 1;
            return pair.workerProfileId;
          },
        ),
      ).toEqual({ kind: 'ADMITTED', value: pair.workerProfileId });
      expect(admittedCalls).toBe(1);
      executed.push(`${pair.gatewayReleaseId}:${pair.workerProfileId}`);
    }

    const declared = corpus.gatewayReleases.flatMap(({ releaseId }) =>
      profiles(corpus).map(({ profileId }) => `${releaseId}:${profileId}`),
    );
    expect(executed.sort()).toEqual(declared.sort());
  });

  it('SCH-010 blocks N+1 unknown native and undeclared cross-mix without Host fallback', async () => {
    const corpus = await loadCorpus();
    const current = corpus.current;
    const previous = corpus.declaredPrevious[0];
    const currentHandshake = await handshakeFor(current);
    const policy = policyFor(corpus, 'gateway-n');

    for (const rejected of corpus.rejectedRegistrations) {
      let handshake = currentHandshake;
      const registration = structuredClone(registrationFor(current, currentHandshake));
      const capabilities = registration.capabilities as Record<string, unknown>;
      registration.protocolVersions = rejected.protocolVersions;
      switch (rejected.id) {
        case 'future-protocol-v2':
          break;
        case 'future-worker-version':
          registration.workerVersion = rejected.advertisedValue!;
          handshake = BrokerHandshakeSchema.parse({
            ...currentHandshake,
            workerVersion: rejected.advertisedValue,
          });
          break;
        case 'unknown-capability-key':
          capabilities.futureCapability = rejected.advertisedValue;
          break;
        case 'native-macos':
          capabilities.isolationModes = [rejected.advertisedValue];
          break;
        case 'stale-broker-contract':
          capabilities.brokerContractDigest = rejected.advertisedValue;
          handshake = BrokerHandshakeSchema.parse({
            ...currentHandshake,
            brokerContractDigest: rejected.advertisedValue,
          });
          break;
        case 'unaccepted-codex-runtime':
          capabilities.codexRuntimeArtifacts = [rejected.advertisedValue];
          handshake = BrokerHandshakeSchema.parse({
            ...currentHandshake,
            codexRuntimeArtifacts: [rejected.advertisedValue],
          });
          break;
        case 'unaccepted-codex-protocol':
          capabilities.codexProtocolSchemaDigests = [rejected.advertisedValue];
          handshake = BrokerHandshakeSchema.parse({
            ...currentHandshake,
            codexProtocolSchemaDigests: [rejected.advertisedValue],
          });
          break;
        case 'unaccepted-isolation':
          capabilities.isolationModes = [rejected.advertisedValue];
          handshake = BrokerHandshakeSchema.parse({
            ...currentHandshake,
            isolationModes: [rejected.advertisedValue],
          });
          break;
        case 'undeclared-cross-mix':
          handshake = BrokerHandshakeSchema.parse({
            ...currentHandshake,
            codexRuntimeArtifacts: previous.codexRuntimeArtifacts,
          });
          capabilities.codexRuntimeArtifacts = previous.codexRuntimeArtifacts;
          break;
      }

      let admittedHostCalls = 0;
      const admission = admitGatewayWorkerCompatibility(policy, handshake, registration, () => {
        admittedHostCalls += 1;
        return 'ISOLATED_HOST_ONLY' as const;
      });

      expect(admission, rejected.id).toEqual({
        kind: 'BLOCKED',
        reason: rejected.expectedError,
      });
      expect(admittedHostCalls, rejected.id).toBe(0);
    }
  });
});
