import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  BrokerCommandSchema,
  BrokerEventSchema,
  BrokerHandshakeSchema,
  BrokerRegistrationCapabilitiesSchema,
  ExecutionCapabilitySchema,
} from '../broker.js';
import { ConsumerEventOutboxRecordSchema } from '../consumer-events.js';
import {
  EvidenceBundleIndexSchema,
  EvidenceCaseResultSchema,
  EvidenceCaseResultsSchema,
  EvidenceEnvironmentSchema,
  EvidenceEnvironmentsSchema,
} from '../evidence.js';
import { ConsumerMessageSchema, ConversationTranscriptSchema } from '../http.js';
import {
  BrokerContractRegistrySchema,
  DataFlowAllowlistSchema,
  DataFlowFieldSchema,
  DecisionRegistrySchema,
  InvariantRegistrySchema,
  parseVnextRegistryYaml,
} from '../registry.js';
import { SandboxAttestationSchema } from '../sandbox.js';

const fixtureDirectory = new URL('../../fixtures/', import.meta.url);
const repositoryRoot = new URL('../../../../', import.meta.url);
const uuid = '0198f00d-8000-7000-8000-000000000001';
const timestamp = '2026-08-13T08:00:00.000Z';

async function fixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(name, fixtureDirectory), 'utf8')) as Record<
    string,
    unknown
  >;
}

function uniqueStrings(prefix: string, size: number): string[] {
  return Array.from(
    { length: size },
    (_unused, index) => `${prefix}-${index.toString().padStart(5, '0')}`,
  );
}

describe('SCH-004 remaining actual public roots', () => {
  it('drives Consumer transcript, turn and durable outbox maxima through actual roots', async () => {
    const message = {
      messageId: uuid,
      invocationId: null,
      turnNo: 20,
      role: 'USER' as const,
      text: 'boundary',
      createdAt: timestamp,
    };
    expect(ConsumerMessageSchema.safeParse({ ...message, turnNo: 19 }).success).toBe(true);
    expect(ConsumerMessageSchema.safeParse(message).success).toBe(true);
    expect(ConsumerMessageSchema.safeParse({ ...message, turnNo: 21 }).success).toBe(false);

    const transcript = {
      protocol: 'combo.creator-agent-http/1' as const,
      conversation: {
        protocol: 'combo.creator-agent-http/1' as const,
        conversationId: uuid,
        agentId: uuid,
        agentVersionId: uuid,
        versionDigest: '0'.repeat(64),
        state: 'IDLE' as const,
        createdAt: timestamp,
        expiresAt: '2026-08-14T08:00:00.000Z',
      },
      latestEventId: '1',
    };
    for (const [count, accepted] of [
      [39, true],
      [40, true],
      [41, false],
    ] as const) {
      expect(
        ConversationTranscriptSchema.safeParse({
          ...transcript,
          messages: Array.from({ length: count }, () => message),
        }).success,
        `messages:${count}`,
      ).toBe(accepted);
    }

    const outbox = await fixture('consumer-terminal-event-outbox.v1.json');
    for (const [attemptCount, accepted] of [
      [999_999, true],
      [1_000_000, true],
      [1_000_001, false],
    ] as const) {
      expect(
        ConsumerEventOutboxRecordSchema.safeParse({ ...outbox, attemptCount }).success,
        `attemptCount:${attemptCount}`,
      ).toBe(accepted);
    }
  });

  it('drives Evidence array and numeric maxima through actual roots', async () => {
    const index = await fixture('evidence-bundle-index.v1.json');
    const artifacts = index.artifacts as Array<Record<string, unknown>>;
    for (const [bytes, accepted] of [
      [1_073_741_823, true],
      [1_073_741_824, true],
      [1_073_741_825, false],
    ] as const) {
      const candidate = {
        ...index,
        artifacts: artifacts.map((artifact, position) =>
          position === 0 ? { ...artifact, bytes } : artifact,
        ),
      };
      expect(EvidenceBundleIndexSchema.safeParse(candidate).success, `bytes:${bytes}`).toBe(
        accepted,
      );
    }
    expect(
      EvidenceBundleIndexSchema.safeParse({ ...index, artifacts: artifacts.slice(1) }).success,
    ).toBe(false);
    expect(
      EvidenceBundleIndexSchema.safeParse({ ...index, artifacts: [...artifacts, artifacts[0]] })
        .success,
    ).toBe(false);

    const environment = await fixture('evidence-environment.v1.json');
    for (const [size, accepted] of [
      [63, true],
      [64, true],
      [65, false],
    ] as const) {
      expect(
        EvidenceEnvironmentSchema.safeParse({
          ...environment,
          realComponents: uniqueStrings('component', size),
        }).success,
        `realComponents:${size}`,
      ).toBe(accepted);
    }

    const environmentIds = [
      'T0-LINUX-CI',
      'T1-SERVICE-CI',
      'T2-LOCAL-CONTRACT',
      'T3-MAC-REAL-HOST',
      'T4-MAC-ISOLATION',
      'T5-K3S-TEST',
      'T6-FULL-E2E',
      'T7-DR',
    ] as const;
    const environments = environmentIds.map((environmentId) => ({ ...environment, environmentId }));
    expect(
      EvidenceEnvironmentsSchema.safeParse({
        protocol: 'combo.vnext-evidence-bundle/1',
        schemaVersion: 1,
        environments: environments.slice(0, 7),
      }).success,
    ).toBe(true);
    expect(
      EvidenceEnvironmentsSchema.safeParse({
        protocol: 'combo.vnext-evidence-bundle/1',
        schemaVersion: 1,
        environments,
      }).success,
    ).toBe(true);
    expect(
      EvidenceEnvironmentsSchema.safeParse({
        protocol: 'combo.vnext-evidence-bundle/1',
        schemaVersion: 1,
        environments: [...environments, environments[0]],
      }).success,
    ).toBe(false);

    const caseResult = await fixture('evidence-case-result.v1.json');
    const artifactDigests = (size: number) =>
      Array.from(
        { length: size },
        (_unused, indexValue) => `sha256:${indexValue.toString(16).padStart(64, '0')}`,
      );
    for (const [size, accepted] of [
      [1_023, true],
      [1_024, true],
      [1_025, false],
    ] as const) {
      expect(
        EvidenceCaseResultSchema.safeParse({
          ...caseResult,
          artifactDigests: artifactDigests(size),
        }).success,
        `artifactDigests:${size}`,
      ).toBe(accepted);
    }

    const results = (size: number) =>
      Array.from({ length: size }, (_unused, indexValue) => ({
        ...caseResult,
        testCaseId: `SCH-${indexValue.toString().padStart(5, '0')}`,
      }));
    expect(EvidenceCaseResultsSchema.safeParse(results(9_999)).success).toBe(true);
    expect(EvidenceCaseResultsSchema.safeParse(results(10_000)).success).toBe(true);
    expect(EvidenceCaseResultsSchema.safeParse(results(10_001)).success).toBe(false);
  });

  it('drives Registry tuple, array and AAD maxima through actual roots', async () => {
    const [registriesText, invariantsText, decisionsText, allowlistText] = await Promise.all([
      readFile(new URL('tests/vnext/registries.yaml', repositoryRoot), 'utf8'),
      readFile(new URL('tests/vnext/invariants.yaml', repositoryRoot), 'utf8'),
      readFile(new URL('tests/vnext/decisions.yaml', repositoryRoot), 'utf8'),
      readFile(new URL('tests/vnext/data-flow-allowlist.yaml', repositoryRoot), 'utf8'),
    ]);
    const registries = parseVnextRegistryYaml(registriesText) as Record<string, unknown>;
    const invariants = parseVnextRegistryYaml(invariantsText) as Record<string, unknown>;
    const decisions = parseVnextRegistryYaml(decisionsText) as Record<string, unknown>;
    const allowlist = parseVnextRegistryYaml(allowlistText) as Record<string, unknown>;

    expect(BrokerContractRegistrySchema.safeParse(registries).success).toBe(true);
    expect(BrokerContractRegistrySchema.safeParse({ ...registries, contracts: [] }).success).toBe(
      false,
    );
    expect(
      BrokerContractRegistrySchema.safeParse({
        ...registries,
        contracts: [...(registries.contracts as unknown[]), (registries.contracts as unknown[])[0]],
      }).success,
    ).toBe(false);

    expect(InvariantRegistrySchema.safeParse(invariants).success).toBe(true);
    expect(
      InvariantRegistrySchema.safeParse({
        ...invariants,
        invariants: (invariants.invariants as unknown[]).slice(1),
      }).success,
    ).toBe(false);
    expect(DecisionRegistrySchema.safeParse(decisions).success).toBe(true);
    expect(
      DecisionRegistrySchema.safeParse({
        ...decisions,
        decisions: (decisions.decisions as unknown[]).slice(1),
      }).success,
    ).toBe(false);

    const baseField = (allowlist.fields as Array<Record<string, unknown>>)[0]!;
    const fields = (size: number) =>
      Array.from({ length: size }, (_unused, index) => ({
        ...baseField,
        fieldId: `answer.generated-${index.toString().padStart(3, '0')}`,
        container: `generated.${index.toString().padStart(3, '0')}`,
        field: `field${index.toString().padStart(3, '0')}`,
      }));
    expect(DataFlowAllowlistSchema.safeParse({ ...allowlist, fields: fields(127) }).success).toBe(
      true,
    );
    expect(DataFlowAllowlistSchema.safeParse({ ...allowlist, fields: fields(128) }).success).toBe(
      true,
    );
    expect(DataFlowAllowlistSchema.safeParse({ ...allowlist, fields: fields(129) }).success).toBe(
      false,
    );

    const bindings = [
      'agentVersionDigest',
      'archiveDigest',
      'artifactPath',
      'cipherObjectFormat',
      'conversationId',
      'creatorId',
      'installationId',
      'invocationId',
      'keyId',
      'messageId',
      'objectKey',
      'ownerId',
      'plaintextBytes',
    ];
    expect(
      DataFlowFieldSchema.safeParse({ ...baseField, aadBindings: bindings.slice(0, 11) }).success,
    ).toBe(true);
    expect(
      DataFlowFieldSchema.safeParse({ ...baseField, aadBindings: bindings.slice(0, 12) }).success,
    ).toBe(true);
    expect(DataFlowFieldSchema.safeParse({ ...baseField, aadBindings: bindings }).success).toBe(
      false,
    );
  });

  it('drives Broker registration, capability budget and heartbeat maxima through actual roots', async () => {
    const handshake = await fixture('broker-handshake.v1.json');
    const registration = {
      codexRuntimeArtifacts: handshake.codexRuntimeArtifacts,
      codexProtocolSchemaDigests: handshake.codexProtocolSchemaDigests,
      isolationModes: handshake.isolationModes,
      brokerContractDigest: handshake.brokerContractDigest,
    };
    const digest = 'sha256:'.concat('0'.repeat(64));
    for (const [size, accepted] of [
      [7, true],
      [8, true],
      [9, false],
    ] as const) {
      expect(
        BrokerRegistrationCapabilitiesSchema.safeParse({
          ...registration,
          codexRuntimeArtifacts: Array.from({ length: size }, () => digest),
        }).success,
      ).toBe(accepted);
    }
    expect(BrokerHandshakeSchema.safeParse(handshake).success).toBe(true);
    expect(
      BrokerHandshakeSchema.safeParse({ ...handshake, supportedProtocolVersions: [] }).success,
    ).toBe(false);
    expect(
      BrokerHandshakeSchema.safeParse({ ...handshake, supportedProtocolVersions: [1, 1] }).success,
    ).toBe(false);

    const prepare = await fixture('broker-invocation-prepare.v1.json');
    const capability = ((prepare.body as Record<string, unknown>).executionCapability ??
      {}) as Record<string, unknown>;
    const budget = capability.budget as Record<string, unknown>;
    for (const [field, maximum] of [
      ['maxInputTokens', 200_000],
      ['maxOutputTokens', 32_768],
      ['maxCostMicros', 100_000_000],
    ] as const) {
      for (const [value, accepted] of [
        [maximum - 1, true],
        [maximum, true],
        [maximum + 1, false],
      ] as const) {
        expect(
          ExecutionCapabilitySchema.safeParse({
            ...capability,
            budget: { ...budget, [field]: value },
          }).success,
          `${field}:${value}`,
        ).toBe(accepted);
      }
    }

    const common = {
      protocol: prepare.protocol,
      schemaVersion: prepare.schemaVersion,
      messageId: prepare.messageId,
      correlationId: prepare.correlationId,
      connectionId: prepare.connectionId,
      sequence: prepare.sequence,
      sentAt: prepare.sentAt,
      expiresAt: prepare.expiresAt,
      lease: prepare.lease,
    };
    for (const [length, accepted] of [
      [127, true],
      [128, true],
      [129, false],
    ] as const) {
      const nonce = 'A'.repeat(length);
      expect(
        BrokerCommandSchema.safeParse({ ...common, kind: 'command', type: 'ping', body: { nonce } })
          .success,
      ).toBe(accepted);
      expect(
        BrokerEventSchema.safeParse({ ...common, kind: 'event', type: 'pong', body: { nonce } })
          .success,
      ).toBe(accepted);
    }
  });

  it('drives Sandbox boot nonce and proxy binding maxima through the signed actual root', async () => {
    const attestation = await fixture('sandbox-attestation.v1.json');
    for (const [field, maximum] of [
      ['bootNonce', 128],
      ['proxyTransportBinding', 256],
    ] as const) {
      for (const [length, accepted] of [
        [maximum - 1, true],
        [maximum, true],
        [maximum + 1, false],
      ] as const) {
        expect(
          SandboxAttestationSchema.safeParse({ ...attestation, [field]: 'A'.repeat(length) })
            .success,
          `${field}:${length}`,
        ).toBe(accepted);
      }
    }
  });
});
