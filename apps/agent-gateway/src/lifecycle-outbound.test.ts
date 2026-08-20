import { readFile } from 'node:fs/promises';

import {
  BrokerEnvelopeSchema,
  canonicalSha256,
  executionCapabilityDigest,
  type BrokerEnvelope,
} from '@cb/creator-agent-protocol';
import { describe, expect, it } from 'vitest';

import {
  BROKER_LIFECYCLE_PAYLOAD_CONTRACT_VERSION,
  materializeBrokerLifecycleCommandV2,
} from './lifecycle-outbound.js';

const fixtureUrl = new URL(
  '../../../packages/creator-agent-protocol/fixtures/broker-invocation-prepare.v1.json',
  import.meta.url,
);

type PrepareEnvelope = Extract<BrokerEnvelope, { type: 'invocation.prepare' }>;

async function prepareFixture(): Promise<PrepareEnvelope> {
  const parsed = BrokerEnvelopeSchema.parse(JSON.parse(await readFile(fixtureUrl, 'utf8')));
  if (parsed.type !== 'invocation.prepare') throw new TypeError('expected prepare fixture');
  return parsed;
}

describe('typed lifecycle payload-v2 outbound materializer', () => {
  it('materializes a strict prepare source into the unchanged Broker wire-v1 command', async () => {
    const fixture = await prepareFixture();
    const source = prepareSource(fixture);
    const materialized = materializeBrokerLifecycleCommandV2(
      source,
      delivery(fixture),
      fixture.body.userMessageCiphertext,
    );

    expect(materialized).toEqual(fixture);
    expect(materialized.schemaVersion).toBe(1);
    expect(source.payloadContractVersion).toBe(BROKER_LIFECYCLE_PAYLOAD_CONTRACT_VERSION);
  });

  it('materializes typed start with one stable command identity', async () => {
    const fixture = await prepareFixture();
    const base = prepareSource(fixture);
    const transport = delivery(fixture);
    const startSource = {
      payloadContractVersion: 2 as const,
      type: 'invocation.start' as const,
      commandId: '0198f00d-3000-7000-8000-000000000011',
      invocationId: base.invocationId,
      executionAuthority: base.executionAuthority,
      conversationId: base.conversationId,
      requestDigest: base.requestDigest,
      agentVersionId: base.agentVersionId,
      agentVersionDigest: base.agentVersionDigest,
      prepareCommandId: base.commandId,
      executionCapabilityId: base.executionCapability.capabilityId,
      executionCapability: base.executionCapability,
      executionCapabilityDigest: base.executionCapabilityDigest,
    };
    const start = materializeBrokerLifecycleCommandV2(startSource, transport);
    expect(start).toMatchObject({
      schemaVersion: 1,
      kind: 'command',
      type: 'invocation.start',
      messageId: '0198f00d-3000-7000-8000-000000000011',
      correlationId: base.invocationId,
      body: {
        invocationId: base.invocationId,
        prepareCommandId: base.commandId,
        executionCapabilityId: base.executionCapability.capabilityId,
      },
    });
    expect(() =>
      materializeBrokerLifecycleCommandV2(startSource, {
        ...transport,
        sentAt: '2026-08-13T07:59:58.999Z',
      }),
    ).toThrow('LIFECYCLE_START_AUTHORITY_MISMATCH');
  });

  it('fails closed for old/future source versions, unknown variants, and extra payload fields', async () => {
    const fixture = await prepareFixture();
    const source = prepareSource(fixture);
    const transport = delivery(fixture);

    for (const invalid of [
      { ...source, payloadContractVersion: 0 },
      { ...source, payloadContractVersion: 1 },
      { ...source, payloadContractVersion: 3 },
      { ...source, type: 'invocation.cancel', reason: 'CONSUMER_REQUEST' },
      { ...source, type: 'invocation.reconcile' },
      { ...source, plaintext: 'must-not-cross-the-boundary' },
    ]) {
      expect(() =>
        materializeBrokerLifecycleCommandV2(invalid, transport, fixture.body.userMessageCiphertext),
      ).toThrow();
    }
  });

  it('fails closed on capability, immutable assignment, transport, deadline, or AEAD binding drift', async () => {
    const fixture = await prepareFixture();
    const source = prepareSource(fixture);
    const transport = delivery(fixture);
    const differentUuid = '0198f00d-3000-7000-8000-000000000099';

    const cases = [
      { ...source, executionCapabilityDigest: 'f'.repeat(64) },
      {
        ...source,
        executionAuthority: { ...source.executionAuthority, leaseId: differentUuid },
      },
      { ...source, deadlineAt: '2026-08-13T08:00:20.000Z' },
      {
        ...source,
        executionCapability: {
          ...source.executionCapability,
          requestDigest: `hmac-sha256:${'f'.repeat(64)}`,
        },
      },
      { ...source, deadlineAt: '2026-08-13T08:02:30.001Z' },
    ];
    for (const invalid of cases) {
      expect(() =>
        materializeBrokerLifecycleCommandV2(invalid, transport, fixture.body.userMessageCiphertext),
      ).toThrow();
    }
    expect(() =>
      materializeBrokerLifecycleCommandV2(
        source,
        {
          ...transport,
          lease: { ...transport.lease, deploymentId: differentUuid },
        },
        fixture.body.userMessageCiphertext,
      ),
    ).toThrow('LIFECYCLE_DELIVERY_DEPLOYMENT_MISMATCH');
    expect(() =>
      materializeBrokerLifecycleCommandV2(
        source,
        { ...transport, sentAt: '2026-08-13T07:59:58.999Z' },
        fixture.body.userMessageCiphertext,
      ),
    ).toThrow('LIFECYCLE_PREPARE_AUTHORITY_MISMATCH');
    expect(() =>
      materializeBrokerLifecycleCommandV2(
        { ...source, deadlineAt: '2026-08-13T08:03:00.000Z' },
        { ...transport, expiresAt: '2026-08-13T08:02:30.001Z' },
        fixture.body.userMessageCiphertext,
      ),
    ).toThrow('LIFECYCLE_PREPARE_AUTHORITY_MISMATCH');
  });

  it('rejects a self-consistent AEAD object bound to a different command or session', async () => {
    const fixture = await prepareFixture();
    const source = prepareSource(fixture);
    const transport = delivery(fixture);
    const differentUuid = '0198f00d-3000-7000-8000-000000000099';
    const aad = { ...fixture.body.userMessageCiphertext.aad, messageId: differentUuid };
    const ciphertext = {
      ...fixture.body.userMessageCiphertext,
      aad,
      aadDigest: canonicalSha256(aad),
    };

    expect(() => materializeBrokerLifecycleCommandV2(source, transport, ciphertext)).toThrow();
  });
});

function prepareSource(fixture: PrepareEnvelope) {
  const capability = fixture.body.executionCapability;
  return {
    payloadContractVersion: 2 as const,
    type: 'invocation.prepare' as const,
    commandId: fixture.messageId as string,
    invocationId: fixture.body.invocationId as string,
    executionAuthority: {
      deploymentId: capability.deploymentId as string,
      installationId: capability.workerInstallationId as string,
      leaseId: capability.leaseId as string,
      fence: capability.fence as string,
    },
    conversationId: fixture.body.conversationId as string,
    clientMessageId: fixture.body.clientMessageId as string,
    requestDigest: fixture.body.requestDigest as string,
    agentVersionId: fixture.body.agentVersionId as string,
    agentVersionDigest: fixture.body.agentVersionDigest as string,
    snapshotDigest: fixture.body.snapshotDigest as string,
    deadlineAt: fixture.body.deadlineAt as string,
    executionCapability: capability,
    executionCapabilityDigest: executionCapabilityDigest(capability),
  };
}

function delivery(fixture: PrepareEnvelope) {
  return {
    connectionId: fixture.connectionId,
    sequence: fixture.sequence,
    sentAt: fixture.sentAt,
    expiresAt: fixture.expiresAt,
    lease: fixture.lease,
  };
}
