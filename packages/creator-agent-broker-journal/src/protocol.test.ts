import { describe, expect, it } from 'vitest';

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
  type BrokerEnvelope,
} from './protocol.js';

function envelope(sequence: number, overrides: Partial<BrokerEnvelope> = {}): BrokerEnvelope {
  return {
    protocol: BROKER_PROTOCOL,
    schemaVersion: 1,
    kind: 'command',
    messageId: `message-${sequence}`,
    type: 'invocation.prepare',
    correlationId: 'invocation-a',
    connectionId: 'connection-a',
    sequence,
    sentAt: '2026-08-13T08:00:00.000Z',
    expiresAt: '2026-08-13T08:01:00.000Z',
    lease: { deploymentId: 'deployment-a', leaseId: 'lease-a', fence: '42' },
    body: {},
    ...overrides,
  };
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
      expect.objectContaining({ code: 'UNKNOWN_KEY' }),
    );
  });

  it('enforces durable connection sequence, replay equality and gaps', () => {
    const now = Date.parse('2026-08-13T08:00:30.000Z');
    let cursor = initialSequenceCursor('connection-a');
    const accepted = consumeSequence(cursor, envelope(0), 'digest-0', now);
    expect(accepted.type).toBe('ACCEPT');
    cursor = accepted.cursor;
    expect(consumeSequence(cursor, envelope(0), 'digest-0', now).type).toBe('REPLAY');
    expect(() => consumeSequence(cursor, envelope(0), 'changed', now)).toThrowError(
      expect.objectContaining({ code: 'SEQUENCE_CONFLICT' }),
    );
    expect(consumeSequence(cursor, envelope(2), 'digest-2', now)).toMatchObject({
      type: 'REQUEST_REPLAY',
      expected: 1,
      received: 2,
    });
    expect(cursor.nextExpected).toBe(1);
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
      }).level,
    ).toBe('PERSISTED');
    expect(
      ledger.acknowledge({
        messageId: 'message-a',
        canonicalDigest: 'digest-a',
        level: 'CLOUD_COMMITTED',
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

  it('rejects expired and stale-connection frames', () => {
    const cursor = initialSequenceCursor('connection-a');
    expect(() =>
      consumeSequence(cursor, envelope(0), 'digest', Date.parse('2026-08-13T08:01:00.000Z')),
    ).toThrowError(expect.objectContaining({ code: 'MESSAGE_EXPIRED' }));
    expect(() =>
      consumeSequence(
        cursor,
        envelope(0, { connectionId: 'connection-old' }),
        'digest',
        Date.parse('2026-08-13T08:00:30.000Z'),
      ),
    ).toThrowError(expect.objectContaining({ code: 'STALE_CONNECTION' }));
  });

  it('grants one active lease and rejects stale lease/fence after failover', () => {
    const registry = new LeaseRegistry();
    const first = registry.acquire({
      leaseId: 'lease-a',
      deploymentId: 'deployment-a',
      workerId: 'worker-a',
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
        connectionId: 'connection-b',
        nowMs: 29_999,
        ttlMs: 30_000,
      }),
    ).toThrowError(expect.objectContaining({ code: 'ACTIVE_LEASE_EXISTS' }));

    const second = registry.acquire({
      leaseId: 'lease-b',
      deploymentId: 'deployment-a',
      workerId: 'worker-b',
      connectionId: 'connection-b',
      nowMs: 30_000,
      ttlMs: 30_000,
    });
    expect(second.fence).toBe(1n);
    expect(() =>
      registry.assertCurrent(
        { deploymentId: 'deployment-a', leaseId: 'lease-a', fence: '0' },
        'connection-a',
        30_001,
      ),
    ).toThrowError(LeaseError);
    expect(() =>
      registry.assertCurrent(
        { deploymentId: 'deployment-a', leaseId: 'lease-b', fence: '0' },
        'connection-b',
        30_001,
      ),
    ).toThrowError(expect.objectContaining({ code: 'STALE_FENCE' }));
  });

  it('keeps stable protocol error identity', () => {
    expect(() => parseBrokerEnvelope(null)).toThrowError(BrokerProtocolError);
  });
});
