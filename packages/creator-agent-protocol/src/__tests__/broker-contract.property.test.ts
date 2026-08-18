import { describe, expect, it } from 'vitest';

// VNext registry cases: SCH-001 SCH-002 SCH-003
import { createBrokerContractArtifact, currentBrokerContractDigest } from '../artifacts.js';
import { canonicalSha256 } from '../canonical.js';
import {
  BrokerConversationOpenCommandSchema,
  brokerConversationOpenLogicalCommand,
  brokerConversationOpenLogicalDigest,
  type BrokerConversationOpenCommand,
} from '../broker.js';
import { readFixture } from './fixture-helpers.js';
import {
  PROPERTY_RUNS,
  PROPERTY_SEED_BASE,
  PROPERTY_SEED_COUNT,
  propertySeedMatrix,
} from './property-matrix.js';

class XorShift32 {
  public constructor(private state: number) {
    if (state === 0) this.state = 0x6d2b79f5;
  }

  public next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }
}

function generatedUuid(value: number, namespace: number): string {
  const suffix = (BigInt(namespace) * 0x1_0000_0000n + BigInt(value))
    .toString(16)
    .padStart(12, '0')
    .slice(-12);
  return `0198f00d-6000-7000-8000-${suffix}`;
}

function mutateOuter(
  command: BrokerConversationOpenCommand,
  random: XorShift32,
): BrokerConversationOpenCommand {
  const token = random.next();
  const sentAt = new Date(Date.UTC(2026, 7, 13, 8, 1, token % 20)).toISOString();
  const expiresAt = new Date(Date.parse(sentAt) + 30_000).toISOString();
  return BrokerConversationOpenCommandSchema.parse({
    ...command,
    connectionId: generatedUuid(token, 1),
    sequence: String(token),
    sentAt,
    expiresAt,
    lease: {
      deploymentId: command.body.openAuthority.deploymentId,
      workerSessionId: generatedUuid(token, 2),
      leaseId: generatedUuid(token, 3),
      fence: String(43 + (token % 1_000_000)),
    },
  });
}

function mutateImmutableOrInvalid(
  command: BrokerConversationOpenCommand,
  random: XorShift32,
): unknown {
  const token = random.next();
  switch (token % 12) {
    case 0:
      return { ...command, messageId: generatedUuid(token, 4) };
    case 1: {
      const conversationId = generatedUuid(token, 5);
      return {
        ...command,
        correlationId: conversationId,
        body: { ...command.body, conversationId },
      };
    }
    case 2:
      return {
        ...command,
        body: { ...command.body, agentVersionId: generatedUuid(token, 6) },
      };
    case 3:
      return {
        ...command,
        body: {
          ...command.body,
          visibleTranscriptDigest: `hmac-sha256:${'e'.repeat(64)}`,
        },
      };
    case 4:
      return {
        ...command,
        body: {
          ...command.body,
          openAuthority: {
            ...command.body.openAuthority,
            workerSessionId: generatedUuid(token, 7),
          },
        },
      };
    case 5:
      return { ...command, unexpected: true };
    case 6:
      return { ...command, body: { ...command.body, unexpected: true } };
    case 7:
      return { ...command, sequence: '9223372036854775808' };
    case 8:
      return {
        ...command,
        body: {
          ...command.body,
          openAuthority: { ...command.body.openAuthority, fence: '01' },
        },
      };
    case 9:
      return {
        ...command,
        lease: { ...command.lease, deploymentId: generatedUuid(token, 8) },
      };
    case 10:
      return { ...command, correlationId: command.messageId };
    default:
      return { ...command, type: 'conversation.open.v2' };
  }
}

describe('Broker conversation.open contract property model', () => {
  it('every transport authority field and close-map member participates in the contract digest', () => {
    const artifact = createBrokerContractArtifact() as {
      canonicalization: string;
      connectPath: string;
      maxFrameBytes: number;
      closeCodes: Record<string, number>;
      closeReasons: Record<string, string>;
      [key: string]: unknown;
    };
    const baselineDigest = currentBrokerContractDigest();
    const mutations: Record<string, unknown>[] = [
      { ...artifact, canonicalization: `${artifact.canonicalization}.mutated` },
      { ...artifact, connectPath: `${artifact.connectPath}.mutated` },
      { ...artifact, maxFrameBytes: artifact.maxFrameBytes + 1 },
      ...Object.entries(artifact.closeCodes).map(([key, value]) => ({
        ...artifact,
        closeCodes: { ...artifact.closeCodes, [key]: value + 1 },
      })),
      ...Object.entries(artifact.closeReasons).map(([key, value]) => ({
        ...artifact,
        closeReasons: { ...artifact.closeReasons, [key]: `${value}_MUTATED` },
      })),
    ];

    expect(baselineDigest).toBe(`sha256:${canonicalSha256(artifact)}`);
    for (const mutation of mutations) {
      expect(`sha256:${canonicalSha256(mutation)}`).not.toBe(baselineDigest);
    }
  });

  it(`${PROPERTY_SEED_COUNT} seeds from ${PROPERTY_SEED_BASE} run ${PROPERTY_RUNS} re-envelope/immutable/strict boundaries`, async () => {
    const baseline = BrokerConversationOpenCommandSchema.parse(
      await readFixture('broker-conversation-open.v1.json'),
    );
    const baselineDigest = brokerConversationOpenLogicalDigest(
      brokerConversationOpenLogicalCommand(baseline),
    );
    let changed = 0;
    let rejected = 0;

    for (const { seed, runs } of propertySeedMatrix()) {
      const random = new XorShift32(seed);
      for (let run = 0; run < runs; run += 1) {
        const reEnveloped = mutateOuter(baseline, random);
        expect(
          brokerConversationOpenLogicalDigest(brokerConversationOpenLogicalCommand(reEnveloped)),
        ).toBe(baselineDigest);

        const candidate = BrokerConversationOpenCommandSchema.safeParse(
          mutateImmutableOrInvalid(baseline, random),
        );
        if (candidate.success) {
          expect(
            brokerConversationOpenLogicalDigest(
              brokerConversationOpenLogicalCommand(candidate.data),
            ),
          ).not.toBe(baselineDigest);
          changed += 1;
        } else {
          rejected += 1;
        }
      }
    }

    expect(changed).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
  });
});
