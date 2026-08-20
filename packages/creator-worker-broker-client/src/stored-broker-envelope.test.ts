import { canonicalSha256, canonicalizeJson } from '@cb/creator-agent-protocol';
import { describe, expect, it } from 'vitest';

import {
  decodeStoredBrokerEnvelope,
  materializeStoredBrokerEnvelope,
  type StoredBrokerConversationAuthority,
  type StoredBrokerTransportAuthority,
} from './stored-broker-envelope.js';

const SHA = (character: string) => character.repeat(64);
const HMAC = (character: string) => `hmac-sha256:${character.repeat(64)}`;
const uuid = (value: number) => `00000000-0000-7000-8000-${value.toString(16).padStart(12, '0')}`;

type LegacyOpen = ReturnType<typeof legacyOpen>;

describe('stored c687 conversation.open compatibility', () => {
  it('projects original and replacement storage through immutable local open authority only', () => {
    const originalRaw = legacyOpen();
    const original = decode(originalRaw);
    const originalTransport = transportAuthority(originalRaw);
    const conversation = conversationAuthority(originalRaw);
    const projectedOriginal = materializeStoredBrokerEnvelope(
      original,
      originalTransport,
      conversation,
      original.logicalDigest,
    );
    expect(projectedOriginal).toMatchObject({
      connectionId: originalTransport.connectionId,
      body: { openAuthority: originalAuthority(conversation) },
    });

    const replacementRaw = legacyOpen({
      connectionId: uuid(20),
      workerSessionId: uuid(21),
      leaseId: uuid(22),
      fence: '2',
    });
    const replacement = decode(replacementRaw);
    const replacementTransport = transportAuthority(replacementRaw);
    const projectedReplacement = materializeStoredBrokerEnvelope(
      replacement,
      replacementTransport,
      conversation,
      original.logicalDigest,
    );
    expect(replacement.logicalDigest).toBe(original.logicalDigest);
    expect(projectedReplacement).toMatchObject({
      connectionId: replacementTransport.connectionId,
      lease: replacementRaw.lease,
      body: { openAuthority: originalAuthority(conversation) },
    });
  });

  it('rejects legacy bytes without local authority and bodies outside the exact old five keys', () => {
    const raw = legacyOpen();
    const stored = decode(raw);
    expect(() =>
      materializeStoredBrokerEnvelope(
        stored,
        transportAuthority(stored.envelope),
        undefined,
        stored.logicalDigest,
      ),
    ).toThrow(/legacy-authority/u);
    const unknownBody = { ...raw, body: { ...raw.body, unexpected: true } };
    expect(() => decode(unknownBody)).toThrow(/legacy-body-shape/u);
  });

  it('rejects a recanonicalized legacy semantic change against the consumed open identity', () => {
    const raw = legacyOpen();
    const original = decode(raw);
    const changed = decode({
      ...raw,
      body: { ...raw.body, visibleTranscriptDigest: HMAC('d') },
    });
    expect(changed.logicalDigest).not.toBe(original.logicalDigest);
    expect(() =>
      materializeStoredBrokerEnvelope(
        changed,
        transportAuthority(raw),
        conversationAuthority(raw),
        original.logicalDigest,
      ),
    ).toThrow(/legacy-authority/u);
  });

  it.each(['connectionId', 'deploymentId', 'workerSessionId', 'leaseId', 'fence'] as const)(
    'rejects a recomputed legacy original with tampered outer %s',
    (field) => {
      const raw = legacyOpen();
      const tampered = structuredClone(raw);
      if (field === 'connectionId') tampered.connectionId = uuid(30);
      else if (field === 'deploymentId') tampered.lease.deploymentId = uuid(31);
      else if (field === 'workerSessionId') tampered.lease.workerSessionId = uuid(32);
      else if (field === 'leaseId') tampered.lease.leaseId = uuid(33);
      else tampered.lease.fence = '9';
      const stored = decode(tampered);
      expect(() =>
        materializeStoredBrokerEnvelope(
          stored,
          transportAuthority(raw),
          conversationAuthority(raw),
          stored.logicalDigest,
        ),
      ).toThrow(/authority|transport/u);
    },
  );

  it.each(['installationId', 'deploymentId', 'workerSessionId', 'leaseId', 'fence'] as const)(
    'rejects a recomputed legacy original with tampered local %s',
    (field) => {
      const raw = legacyOpen();
      const stored = decode(raw);
      const conversation = {
        ...conversationAuthority(raw),
        [field]: field === 'fence' ? '9' : uuid(40),
      };
      expect(() =>
        materializeStoredBrokerEnvelope(
          stored,
          transportAuthority(raw),
          conversation,
          stored.logicalDigest,
        ),
      ).toThrow(/authority/u);
    },
  );
});

function legacyOpen(
  outer: Partial<{
    connectionId: string;
    deploymentId: string;
    workerSessionId: string;
    leaseId: string;
    fence: string;
  }> = {},
) {
  return {
    protocol: 'combo.creator-broker/1' as const,
    schemaVersion: 1 as const,
    kind: 'command' as const,
    type: 'conversation.open' as const,
    messageId: uuid(1),
    correlationId: uuid(2),
    connectionId: outer.connectionId ?? uuid(3),
    sequence: '1',
    sentAt: '2026-08-15T00:00:00.000Z',
    expiresAt: '2026-08-15T00:01:00.000Z',
    lease: {
      deploymentId: outer.deploymentId ?? uuid(4),
      workerSessionId: outer.workerSessionId ?? uuid(5),
      leaseId: outer.leaseId ?? uuid(6),
      fence: outer.fence ?? '1',
    },
    body: {
      conversationId: uuid(2),
      agentVersionId: uuid(7),
      agentVersionDigest: SHA('a'),
      snapshotDigest: SHA('b'),
      visibleTranscriptDigest: HMAC('c'),
    },
  };
}

function decode(raw: LegacyOpen) {
  const serialized = canonicalizeJson(raw);
  return decodeStoredBrokerEnvelope(serialized, canonicalSha256(raw));
}

function transportAuthority(
  envelope: LegacyOpen | ReturnType<typeof decode>['envelope'],
): StoredBrokerTransportAuthority {
  return {
    installationId: uuid(8),
    connectionId: envelope.connectionId,
    deploymentId: envelope.lease.deploymentId,
    workerSessionId: envelope.lease.workerSessionId,
    leaseId: envelope.lease.leaseId,
    fence: envelope.lease.fence,
  };
}

function conversationAuthority(envelope: LegacyOpen): StoredBrokerConversationAuthority {
  return {
    conversationId: envelope.body.conversationId,
    installationId: uuid(8),
    deploymentId: envelope.lease.deploymentId,
    workerSessionId: envelope.lease.workerSessionId,
    leaseId: envelope.lease.leaseId,
    fence: envelope.lease.fence,
    agentVersionId: envelope.body.agentVersionId,
    agentVersionDigest: envelope.body.agentVersionDigest,
    snapshotDigest: envelope.body.snapshotDigest,
    openCommandId: envelope.messageId,
    openConnectionId: envelope.connectionId,
    openSequence: envelope.sequence,
  };
}

function originalAuthority(conversation: StoredBrokerConversationAuthority) {
  return {
    installationId: conversation.installationId,
    deploymentId: conversation.deploymentId,
    workerSessionId: conversation.workerSessionId,
    leaseId: conversation.leaseId,
    fence: conversation.fence,
  };
}
