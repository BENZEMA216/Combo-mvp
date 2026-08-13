import { describe, expect, it } from 'vitest';
import {
  brokerSensitiveMessageAadDigest,
  brokerSensitiveMessageCipherDigest,
} from '@cb/creator-agent-protocol';

import {
  BROKER_PROTOCOL,
  BrokerAckLedger,
  BrokerProtocolError,
  LeaseError,
  LeaseRegistry,
  consumeSequence,
  formatFence,
  initialSequenceCursor,
  parseBrokerEnvelope,
  parseFence,
  restoreSequenceCursor,
  serializeSequenceCursor,
  type BrokerEnvelope,
} from './protocol.js';
import {
  AGENT_VERSION_DIGEST,
  IDS,
  REQUEST_DIGEST,
  createSignedCapabilityFixture,
} from './reference-fixture.js';

const SIGNED_CAPABILITY = createSignedCapabilityFixture();

function envelope(sequence: number, overrides: Partial<BrokerEnvelope> = {}): BrokerEnvelope {
  const messageId = `0198f00d-1000-7000-8000-${sequence.toString(16).padStart(12, '0')}`;
  const keyId = 'worker-session-key-001';
  const nonce = Buffer.alloc(12, 1).toString('base64url');
  const ciphertext = Buffer.from('synthetic-prompt', 'utf8').toString('base64url');
  const authTag = Buffer.alloc(16, 2).toString('base64url');
  const aad = {
    protocol: BROKER_PROTOCOL,
    schemaVersion: 1 as const,
    envelopeType: 'invocation.prepare' as const,
    messageId,
    conversationId: IDS.conversationA,
    invocationId: IDS.invocationA,
    workerSessionId: IDS.workerSession,
    role: 'USER' as const,
    keyId,
  };
  return {
    protocol: BROKER_PROTOCOL,
    schemaVersion: 1,
    kind: 'command',
    messageId,
    type: 'invocation.prepare',
    correlationId: IDS.invocationA,
    connectionId: '0198f00d-1000-7000-8000-000000000001',
    sequence: sequence.toString(10),
    sentAt: '2026-08-13T08:00:00.000Z',
    expiresAt: '2026-08-13T08:01:00.000Z',
    lease: {
      deploymentId: IDS.deployment,
      leaseId: IDS.lease,
      workerSessionId: IDS.workerSession,
      fence: '42',
    },
    body: {
      invocationId: IDS.invocationA,
      conversationId: IDS.conversationA,
      clientMessageId: '0198f00d-1000-7000-8000-000000000002',
      requestDigest: REQUEST_DIGEST,
      userMessageCiphertext: {
        algorithm: 'aes-256-gcm/v1',
        keyScope: 'worker-session',
        keyId,
        nonce,
        ciphertext,
        authTag,
        cipherDigest: brokerSensitiveMessageCipherDigest(nonce, ciphertext, authTag),
        aad,
        aadDigest: brokerSensitiveMessageAadDigest(aad),
        aadVersion: 1,
      },
      agentVersionId: IDS.agentVersion,
      agentVersionDigest: AGENT_VERSION_DIGEST,
      snapshotDigest: '4'.repeat(64),
      deadlineAt: '2026-08-13T08:03:00.000Z',
      executionCapability: SIGNED_CAPABILITY.capability,
    },
    ...overrides,
  } as BrokerEnvelope;
}

describe('broker protocol', () => {
  it.each([
    ['0', 0n],
    ['9007199254740991', 9_007_199_254_740_991n],
    ['9007199254740992', 9_007_199_254_740_992n],
    ['9223372036854775807', 9_223_372_036_854_775_807n],
  ])('round-trips canonical uint63 fence %s', (wire, value) => {
    expect(parseFence(wire)).toBe(value);
    expect(formatFence(value)).toBe(wire);
  });

  it.each([-1, 1, '01', '+1', '1e3', '', '9223372036854775808', null])(
    'rejects non-canonical fence %j',
    (value) => {
      expect(() => parseFence(value)).toThrowError(
        expect.objectContaining({ code: 'INVALID_FENCE' }),
      );
    },
  );

  it('parses exact envelopes and rejects unknown keys', () => {
    expect(parseBrokerEnvelope(envelope(0))).toEqual(envelope(0));
    expect(() => parseBrokerEnvelope({ ...envelope(0), surprise: true })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ENVELOPE' }),
    );
    const valid = envelope(0);
    const wrongSession = {
      ...valid,
      lease: {
        ...valid.lease,
        workerSessionId: '0198f00d-1000-7000-8000-000000000099',
      },
    };
    expect(() => parseBrokerEnvelope(wrongSession)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ENVELOPE' }),
    );
  });

  it('enforces durable connection sequence, replay equality and gaps', () => {
    const now = Date.parse('2026-08-13T08:00:30.000Z');
    let cursor = initialSequenceCursor('0198f00d-1000-7000-8000-000000000001');
    const accepted = consumeSequence(cursor, envelope(0), 'digest-0', now);
    expect(accepted.type).toBe('ACCEPT');
    cursor = accepted.cursor;
    expect(consumeSequence(cursor, envelope(0), 'digest-0', now).type).toBe('REPLAY');
    expect(() => consumeSequence(cursor, envelope(0), 'changed', now)).toThrowError(
      expect.objectContaining({ code: 'SEQUENCE_CONFLICT' }),
    );
    expect(consumeSequence(cursor, envelope(2), 'digest-2', now)).toMatchObject({
      type: 'REQUEST_REPLAY',
      expected: '1',
      received: '2',
    });
    expect(cursor.nextExpected).toBe(1n);
  });

  it('tracks RECEIVED, PERSISTED and CLOUD_COMMITTED without conflating them', () => {
    const ledger = new BrokerAckLedger();
    expect(
      ledger.acknowledge({
        messageId: 'message-a',
        canonicalDigest: 'digest-a',
        level: 'RECEIVED',
      }).level,
    ).toBe('RECEIVED');
    expect(ledger.get('message-a')?.level).not.toBe('PERSISTED');
    expect(
      ledger.acknowledge({
        messageId: 'message-a',
        canonicalDigest: 'digest-a',
        level: 'PERSISTED',
        durableProof: {
          journal: 'WORKER_SQLITE',
          transactionId: 'sqlite-tx-a',
          canonicalDigest: 'digest-a',
        },
      }).level,
    ).toBe('PERSISTED');
    expect(
      ledger.acknowledge({
        messageId: 'message-a',
        canonicalDigest: 'digest-a',
        level: 'CLOUD_COMMITTED',
        durableProof: {
          journal: 'CLOUD_POSTGRESQL',
          transactionId: 'pg-tx-a',
          canonicalDigest: 'digest-a',
        },
      }).level,
    ).toBe('CLOUD_COMMITTED');
    expect(
      ledger.acknowledge({
        messageId: 'message-a',
        canonicalDigest: 'digest-a',
        level: 'RECEIVED',
      }).level,
    ).toBe('CLOUD_COMMITTED');
  });

  it('accepts a lost lower ACK only with durable proof and rejects proof mutation', () => {
    const ledger = new BrokerAckLedger();
    expect(
      ledger.acknowledge({
        messageId: 'message-a',
        canonicalDigest: 'digest-a',
        level: 'PERSISTED',
        durableProof: {
          journal: 'WORKER_SQLITE',
          transactionId: 'sqlite-tx-a',
          canonicalDigest: 'digest-a',
        },
      }).level,
    ).toBe('PERSISTED');
    expect(() =>
      ledger.acknowledge({
        messageId: 'message-b',
        canonicalDigest: 'digest-b',
        level: 'PERSISTED',
      }),
    ).toThrowError(expect.objectContaining({ code: 'ACK_DURABLE_PROOF_REQUIRED' }));
    expect(() =>
      ledger.acknowledge({
        messageId: 'message-a',
        canonicalDigest: 'digest-a',
        level: 'PERSISTED',
        durableProof: {
          journal: 'WORKER_SQLITE',
          transactionId: 'sqlite-tx-b',
          canonicalDigest: 'digest-a',
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
  });

  it('security-blocks an ACK replay with the same ID and a different digest', () => {
    const ledger = new BrokerAckLedger();
    ledger.acknowledge({
      messageId: 'message-a',
      canonicalDigest: 'digest-a',
      level: 'RECEIVED',
    });
    expect(() =>
      ledger.acknowledge({
        messageId: 'message-a',
        canonicalDigest: 'changed',
        level: 'PERSISTED',
      }),
    ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
  });

  it('reconstructs bounded ACK facts without downgrading durable levels', () => {
    const ledger = new BrokerAckLedger(2);
    ledger.acknowledge({
      messageId: 'message-a',
      canonicalDigest: 'digest-a',
      level: 'CLOUD_COMMITTED',
      durableProof: {
        journal: 'CLOUD_POSTGRESQL',
        transactionId: 'pg-tx-a',
        canonicalDigest: 'digest-a',
      },
    });
    const restored = BrokerAckLedger.restore(ledger.serialize(), 2);
    expect(restored.get('message-a')).toEqual(ledger.get('message-a'));
    expect(
      restored.acknowledge({
        messageId: 'message-a',
        canonicalDigest: 'digest-a',
        level: 'RECEIVED',
      }).level,
    ).toBe('CLOUD_COMMITTED');
    expect(() =>
      BrokerAckLedger.restore(
        JSON.stringify({
          schemaVersion: 3,
          records: [ledger.get('message-a'), { ...ledger.get('message-a') }],
          archived: [],
        }),
        2,
      ),
    ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    expect(() => BrokerAckLedger.restore(ledger.serialize(), 0)).toThrowError(
      expect.objectContaining({ code: 'ACK_LEDGER_CAPACITY' }),
    );
  });

  it('bounds active ACK backlog and prunes 1001 terminal ACK facts', () => {
    const ledger = new BrokerAckLedger(1, 1_001);
    for (let index = 0; index < 1_001; index += 1) {
      const messageId = `message-${index}`;
      const canonicalDigest = `digest-${index}`;
      ledger.acknowledge({ messageId, canonicalDigest, level: 'RECEIVED' });
      ledger.acknowledge({
        messageId,
        canonicalDigest,
        level: 'PERSISTED',
        durableProof: {
          journal: 'WORKER_SQLITE',
          transactionId: `sqlite-${index}`,
          canonicalDigest,
        },
      });
      ledger.acknowledge({
        messageId,
        canonicalDigest,
        level: 'CLOUD_COMMITTED',
        durableProof: {
          journal: 'CLOUD_POSTGRESQL',
          transactionId: `postgres-${index}`,
          canonicalDigest,
        },
      });
      expect(ledger.archiveCloudCommitted(messageId, canonicalDigest, index)).toBe(true);
    }
    const serialized = ledger.serialize();
    const restored = BrokerAckLedger.restore(serialized, 1, 1_001);
    expect(restored.get('message-0')).toMatchObject({ level: 'CLOUD_COMMITTED' });
    const negativeWatermark = JSON.parse(serialized) as {
      archived: Array<{ archivedAtMs: number; retainedUntilMs: number }>;
    };
    negativeWatermark.archived[0]!.archivedAtMs = -1;
    negativeWatermark.archived[0]!.retainedUntilMs = -1 + 7 * 24 * 60 * 60 * 1_000;
    expect(() => BrokerAckLedger.restore(JSON.stringify(negativeWatermark), 1, 1_001)).toThrowError(
      expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }),
    );
    expect(restored.pruneExpiredArchive(7 * 24 * 60 * 60 * 1_000 - 1)).toBe(0);
    expect(restored.get('message-0')).toMatchObject({ level: 'CLOUD_COMMITTED' });
    expect(restored.pruneExpiredArchive(7 * 24 * 60 * 60 * 1_000 + 1_000)).toBe(1_001);
    expect(restored.get('message-0')).toBeUndefined();
    expect(restored.get('message-1000')).toBeUndefined();
  });

  it('rejects expired and stale-connection frames', () => {
    const cursor = initialSequenceCursor('0198f00d-1000-7000-8000-000000000001');
    expect(() =>
      consumeSequence(cursor, envelope(0), 'digest', Date.parse('2026-08-13T08:01:00.000Z')),
    ).toThrowError(expect.objectContaining({ code: 'MESSAGE_EXPIRED' }));
    expect(() =>
      consumeSequence(
        cursor,
        envelope(0, { connectionId: '0198f00d-1000-7000-8000-000000000099' }),
        'digest',
        Date.parse('2026-08-13T08:00:30.000Z'),
      ),
    ).toThrowError(expect.objectContaining({ code: 'STALE_CONNECTION' }));
  });

  it('bounds the durable sequence replay cursor', () => {
    const now = Date.parse('2026-08-13T08:00:30.000Z');
    let cursor = initialSequenceCursor('0198f00d-1000-7000-8000-000000000001', 2);
    for (let sequence = 0; sequence < 3; sequence += 1) {
      cursor = consumeSequence(cursor, envelope(sequence), `digest-${sequence}`, now).cursor;
    }
    expect(cursor).toMatchObject({ nextExpected: 3n, lowestRetained: 1n, maxRetained: 2 });
    expect(cursor.accepted.size).toBe(2);
    expect(() => consumeSequence(cursor, envelope(0), 'digest-0', now)).toThrowError(
      expect.objectContaining({ code: 'CURSOR_EXPIRED' }),
    );
    const restored = restoreSequenceCursor(serializeSequenceCursor(cursor));
    expect(restored).toEqual(cursor);
    expect(consumeSequence(restored, envelope(2), 'digest-2', now).type).toBe('REPLAY');
    expect(() =>
      restoreSequenceCursor(
        JSON.stringify({
          schemaVersion: 1,
          connectionId: restored.connectionId,
          nextExpected: '3',
          lowestRetained: '1',
          maxRetained: 2,
          accepted: [
            ['1', 'digest-1'],
            ['1', 'changed'],
          ],
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SEQUENCE' }));
  });

  it('grants one active lease and rejects stale lease/fence after failover', () => {
    const registry = new LeaseRegistry();
    const first = registry.acquire({
      leaseId: 'lease-a',
      deploymentId: 'deployment-a',
      workerId: 'worker-a',
      workerSessionId: 'worker-session-a',
      connectionId: 'connection-a',
      nowMs: 0,
      ttlMs: 30_000,
    });
    expect(first.fence).toBe(0n);
    expect(() =>
      registry.acquire({
        leaseId: 'lease-b',
        deploymentId: 'deployment-a',
        workerId: 'worker-b',
        workerSessionId: 'worker-session-b',
        connectionId: 'connection-b',
        nowMs: 29_999,
        ttlMs: 30_000,
      }),
    ).toThrowError(expect.objectContaining({ code: 'ACTIVE_LEASE_EXISTS' }));

    const second = registry.acquire({
      leaseId: 'lease-b',
      deploymentId: 'deployment-a',
      workerId: 'worker-b',
      workerSessionId: 'worker-session-b',
      connectionId: 'connection-b',
      nowMs: 30_000,
      ttlMs: 30_000,
    });
    expect(second.fence).toBe(1n);
    expect(() =>
      registry.assertCurrent(
        {
          deploymentId: 'deployment-a',
          leaseId: 'lease-a',
          workerSessionId: 'worker-session-a',
          fence: '0',
        },
        'connection-a',
        30_001,
      ),
    ).toThrowError(LeaseError);
    expect(() =>
      registry.assertCurrent(
        {
          deploymentId: 'deployment-a',
          leaseId: 'lease-b',
          workerSessionId: 'worker-session-b',
          fence: '0',
        },
        'connection-b',
        30_001,
      ),
    ).toThrowError(expect.objectContaining({ code: 'STALE_FENCE' }));
    expect(() =>
      registry.assertCurrent(
        {
          deploymentId: 'deployment-a',
          leaseId: 'lease-b',
          workerSessionId: 'worker-session-a',
          fence: '1',
        },
        'connection-b',
        30_001,
      ),
    ).toThrowError(expect.objectContaining({ code: 'STALE_LEASE' }));
  });

  it('durably expires and revokes leases and never revives them through restore', () => {
    const registry = new LeaseRegistry();
    const first = registry.acquire({
      leaseId: 'lease-a',
      deploymentId: 'deployment-a',
      workerId: 'worker-a',
      workerSessionId: 'worker-session-a',
      connectionId: 'connection-a',
      nowMs: 0,
      ttlMs: 30_000,
    });
    expect(
      registry.assertWorkerCurrent(
        {
          deploymentId: first.deploymentId,
          leaseId: first.leaseId,
          workerSessionId: first.workerSessionId,
          fence: '0',
        },
        'worker-a',
        29_999,
      ).state,
    ).toBe('ACTIVE');
    expect(registry.expire(30_000)).toHaveLength(1);
    expect(() =>
      registry.assertWorkerCurrent(
        {
          deploymentId: first.deploymentId,
          leaseId: first.leaseId,
          workerSessionId: first.workerSessionId,
          fence: '0',
        },
        'worker-a',
        30_000,
      ),
    ).toThrowError(expect.objectContaining({ code: 'STALE_LEASE' }));

    const second = registry.acquire({
      leaseId: 'lease-b',
      deploymentId: 'deployment-a',
      workerId: 'worker-b',
      workerSessionId: 'worker-session-b',
      connectionId: 'connection-b',
      nowMs: 30_000,
      ttlMs: 30_000,
    });
    expect(registry.revoke('deployment-a')).toMatchObject({
      leaseId: second.leaseId,
      state: 'REVOKED',
    });
    const restored = LeaseRegistry.restore(registry.serialize());
    expect(restored.current('deployment-a')?.state).toBe('REVOKED');
    expect(() =>
      restored.assertWorkerCurrent(
        {
          deploymentId: second.deploymentId,
          leaseId: second.leaseId,
          workerSessionId: second.workerSessionId,
          fence: '1',
        },
        'worker-b',
        30_001,
      ),
    ).toThrowError(expect.objectContaining({ code: 'STALE_LEASE' }));
  });

  it('keeps stable protocol error identity', () => {
    expect(() => parseBrokerEnvelope(null)).toThrowError(BrokerProtocolError);
  });
});
