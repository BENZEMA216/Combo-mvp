import { createServer, type Server as HttpServer } from 'node:http';
import { once } from 'node:events';

import {
  AgentGateway,
  type AgentGatewayAuthorityPort,
  type AuthenticatedWorkerSession,
  type GatewayDelivery,
  type GatewayDisconnectReason,
} from '@cb/agent-gateway';
import {
  BrokerAckSchema,
  BrokerAuthenticationError,
  BrokerAuthenticationFailureCode,
  BrokerEnvelopeSchema,
  BrokerHandshakeUnsignedSchema,
  BrokerCloseCode,
  BrokerCloseReason,
  brokerHandshakeSigningBytes,
  canonicalSha256,
  canonicalizeJson,
  parseBrokerFrame,
  parseBrokerHandshake,
  type BrokerEnvelope,
  type BrokerAuthenticationFailureCode as BrokerAuthenticationFailureCodeType,
  type BrokerHandshake,
  type LeaseBinding,
} from '@cb/creator-agent-protocol';
import {
  consumeSequence,
  initialSequenceCursor,
  restoreSequenceCursor,
  serializeSequenceCursor,
} from '@cb/creator-agent-broker-journal';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import {
  boundedBackoff,
  WorkerBrokerClient,
  WorkerBrokerClientError,
  WORKER_BROKER_CONNECT_PATH,
  type BrokerChallengePort,
  type DeviceSignerPort,
  type DurableBrokerConnection,
  type LeaseGrantCommand,
  type WorkerBrokerDiagnosticEvent,
  type WorkerBrokerDurableTransportPort,
} from './worker-broker-client.js';

const INSTALLATION = uuid(1);
const DEPLOYMENT = uuid(2);
const WORKER_SESSION = uuid(3);
const LEASE_A = uuid(4);
const CORRELATION = uuid(6);
const SIGNATURE = Buffer.alloc(64, 9).toString('base64url');
const SENT_AT = '2026-08-13T08:00:00.000Z';
const FRAME_EXPIRES_AT = '2026-08-13T08:01:00.000Z';

const activeClients = new Set<WorkerBrokerClient>();
const activeBrokers = new Set<FakeBroker>();
const activeAgentGateways = new Set<AgentGateway>();

afterEach(async () => {
  await Promise.allSettled([...activeClients].map((client) => client.stop()));
  activeClients.clear();
  await Promise.allSettled([...activeBrokers].map((broker) => broker.stop()));
  activeBrokers.clear();
  await Promise.allSettled([...activeAgentGateways].map((gateway) => gateway.stop()));
  activeAgentGateways.clear();
});

describe('Real Worker transport ↔ Fake Broker', () => {
  it('rejects non-WSS public URLs and caps reconnect backoff', () => {
    expect(() =>
      createClient('ws://example.invalid/v1/worker/connect', new FakeDurablePort()),
    ).toThrow('INVALID_BROKER_URL');
    expect(() =>
      createClient(
        'wss://example.invalid/v1/worker/connect?token=forbidden',
        new FakeDurablePort(),
      ),
    ).toThrow('INVALID_BROKER_URL');
    expect(boundedBackoff(0, 10, 80)).toBe(10);
    expect(boundedBackoff(1, 10, 80)).toBe(10);
    expect(boundedBackoff(99, 10, 80)).toBe(80);
  });

  it('permanently blocks a malformed first Broker frame without durable activation', async () => {
    const durable = new FakeDurablePort();
    const broker = await startBroker({ malformedFirstFrame: true });
    const client = createClient(broker.url, durable);
    await client.start();

    await waitFor(() => client.status === 'BLOCKED');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(broker.connectionCount).toBe(1);
    expect(durable.committed).toHaveLength(0);
    expect(durable.releaseConnectionCalls).toBe(0);
  });

  it('uses the exact outbound path, signs canonical handshake bytes, and owns one installation', async () => {
    const durable = new FakeDurablePort();
    const broker = await startBroker();
    const signed: Buffer[] = [];
    const first = createClient(broker.url, durable, { signed });
    const second = createClient(broker.url, durable);

    await Promise.all([first.start(), first.start(), first.start()]);
    await waitFor(() => first.status === 'READY');
    await expect(second.start()).rejects.toMatchObject({
      code: 'INSTALLATION_ALREADY_ACTIVE',
    });
    await first.start();

    expect(broker.upgradePaths).toEqual([WORKER_BROKER_CONNECT_PATH]);
    expect(broker.handshakes).toHaveLength(1);
    const { challengeSignature: _signature, ...unsigned } = broker.handshakes[0]!;
    expect(signed).toHaveLength(1);
    expect(signed[0]).toEqual(
      brokerHandshakeSigningBytes(BrokerHandshakeUnsignedSchema.parse(unsigned)),
    );
    expect(broker.handshakes[0]!.challengeSignature).toBe(SIGNATURE);
    expect(durable.acquireCalls).toBe(3);
    expect(broker.connectionCount).toBe(1);
    await waitFor(() => broker.received.length >= 1);
    const accepted = broker.received.find((item) => item.envelope.type === 'lease.accepted');
    expect(accepted?.envelope.correlationId).toBe(uuid(300));
  });

  it('supersedes an old lease confirmation and confirms only the replacement grant', async () => {
    const durable = new FakeDurablePort();
    const broker = await startBroker({ closeFirstWorkerFrame: true });
    const client = createClient(broker.url, durable);
    await client.start();

    await waitFor(
      () =>
        broker.connectionCount >= 2 &&
        broker.received.some(
          (item) => item.connectionIndex === 1 && item.envelope.type === 'lease.accepted',
        ),
      2_000,
    );
    const firstConnection = broker.received.find((item) => item.connectionIndex === 0)!;
    expect(firstConnection.envelope).toMatchObject({
      type: 'lease.accepted',
      correlationId: uuid(300),
    });
    expect(
      broker.received.some(
        (item) =>
          item.connectionIndex === 1 &&
          item.envelope.messageId === firstConnection.envelope.messageId,
      ),
    ).toBe(false);
    const replacementConfirmation = broker.received.find(
      (item) => item.connectionIndex === 1 && item.envelope.type === 'lease.accepted',
    );
    expect(replacementConfirmation?.envelope.correlationId).toBe(uuid(301));
    expect(durable.releaseConnectionCalls).toBeGreaterThanOrEqual(1);
    expect(durable.reboundMessageIds).not.toContain(firstConnection.envelope.messageId);
    expect(
      durable.outbox.some((item) => item.envelope.messageId === firstConnection.envelope.messageId),
    ).toBe(false);
    expect(broker.handshakes).toHaveLength(2);
  });

  it('rejects equal/lower replacement fences before accepting a strictly newer lease', async () => {
    const durable = new FakeDurablePort();
    const ownerToken = 'fake-owner-a';
    await durable.acquireInstallation({ installationId: INSTALLATION, ownerToken });
    const firstGrant = leaseGrant({
      connectionId: uuid(320),
      sequence: '0',
      lease: leaseBinding(LEASE_A, '7'),
      messageId: uuid(321),
      sentAt: SENT_AT,
      leaseExpiresAt: FRAME_EXPIRES_AT,
    });
    const first = await durable.activateConnection(fakeActivationInput(ownerToken, firstGrant));
    const firstConfirmation = durable.outbox[0]!.envelope;

    const staleGrant = leaseGrant({
      connectionId: uuid(322),
      sequence: '0',
      lease: leaseBinding(LEASE_A, '7'),
      messageId: uuid(323),
      sentAt: SENT_AT,
      leaseExpiresAt: FRAME_EXPIRES_AT,
    });
    await expect(
      durable.activateConnection(fakeActivationInput(ownerToken, staleGrant)),
    ).rejects.toMatchObject({ code: 'STALE_FENCE' });
    expect(durable.current?.connectionId).toBe(first.connectionId);
    expect(durable.retired).not.toContain(first.connectionId);
    expect(durable.outbox.map((item) => item.envelope)).toEqual([firstConfirmation]);

    const lowerGrant = BrokerEnvelopeSchema.parse({
      ...staleGrant,
      connectionId: uuid(325),
      messageId: uuid(326),
      lease: { ...staleGrant.lease, fence: '6' },
    }) as LeaseGrantCommand;
    await expect(
      durable.activateConnection(fakeActivationInput(ownerToken, lowerGrant)),
    ).rejects.toMatchObject({ code: 'STALE_FENCE' });
    expect(durable.current?.connectionId).toBe(first.connectionId);
    expect(durable.retired).not.toContain(first.connectionId);
    expect(durable.outbox.map((item) => item.envelope)).toEqual([firstConfirmation]);

    const replacementLease = {
      ...staleGrant.lease,
      leaseId: uuid(327),
      workerSessionId: uuid(328),
      fence: '8',
    };
    const replacementGrant = BrokerEnvelopeSchema.parse({
      ...staleGrant,
      messageId: uuid(329),
      lease: replacementLease,
      body: { ...staleGrant.body, workerSessionId: replacementLease.workerSessionId },
    }) as LeaseGrantCommand;
    const replacement = await durable.activateConnection(
      fakeActivationInput(ownerToken, replacementGrant),
    );
    expect(replacement.connectionId).toBe(staleGrant.connectionId);
    expect(durable.retired).toContain(first.connectionId);
    expect(durable.outbox).toHaveLength(1);
    expect(durable.outbox[0]!.envelope).toMatchObject({
      type: 'lease.accepted',
      correlationId: replacementGrant.messageId,
    });
    expect(durable.outbox[0]!.envelope.messageId).not.toBe(firstConfirmation.messageId);
  });

  it('does not reconnect or release installation ownership when durable disconnect recovery fails', async () => {
    const durable = new FakeDurablePort();
    durable.hangConnectionRelease = true;
    const broker = await startBroker({ closeFirstWorkerFrame: true });
    const client = createClient(broker.url, durable, { portTimeoutMs: 50 });
    await client.start();

    await waitFor(() => client.status === 'BLOCKED');
    expect(broker.connectionCount).toBe(1);
    expect(durable.releaseConnectionCalls).toBe(1);
    expect(durable.owner).toBeDefined();
    await expect(client.stop()).rejects.toMatchObject({ code: 'STOP_TIMEOUT' });
    expect(durable.owner).toBeDefined();
  });

  it('releases a durably activated connection even when the returned state is invalid', async () => {
    const durable = new FakeDurablePort();
    durable.corruptActivationReturn = true;
    const broker = await startBroker();
    const client = createClient(broker.url, durable);
    await client.start();

    await waitFor(() => client.status === 'BLOCKED');
    expect(durable.releaseConnectionCalls).toBe(1);
    expect(durable.current).toBeUndefined();
    expect(durable.owner).toBeDefined();
  });

  it('fails closed when the durable port returns an outbound frame outside its cursor', async () => {
    const durable = new FakeDurablePort();
    durable.corruptNextOutbound = true;
    const broker = await startBroker();
    const client = createClient(broker.url, durable);
    await client.start();

    await waitFor(() => client.status === 'BLOCKED');
    expect(broker.received).toHaveLength(0);
  });

  it('prioritizes durable inbound and outbound facts after 1024 cursor digests expire', async () => {
    const durable = new FakeDurablePort();
    durable.holdOutbound = true;
    const broker = await startBroker({ leaseDurationMs: 60_000 });
    const client = createClient(broker.url, durable, { heartbeatIntervalMs: 100 });
    await client.start();
    await waitFor(() => client.status === 'READY');
    const connection = broker.connections[0]!;
    const ancientOutboundId = durable.outbox[0]!.envelope.messageId;
    durable.advanceOutboundCursor(1_025);
    durable.holdOutbound = false;
    await waitFor(() =>
      broker.received.some((item) => item.envelope.messageId === ancientOutboundId),
    );
    expect(client.status).toBe('READY');

    const ancientInbound = pingCommand({
      connectionId: connection.connectionId,
      sequence: '1',
      lease: leaseBinding(LEASE_A, '7'),
      messageId: uuid(17_100),
      nonce: Buffer.alloc(16, 1).toString('base64url'),
    });
    broker.send(connection.socket, ancientInbound);
    await waitFor(() => durable.committed.length === 2);
    for (let start = 2; start <= 1_026; start += 16) {
      const end = Math.min(1_026, start + 15);
      for (let sequence = start; sequence <= end; sequence += 1) {
        broker.send(
          connection.socket,
          pingCommand({
            connectionId: connection.connectionId,
            sequence: String(sequence),
            lease: leaseBinding(LEASE_A, '7'),
            messageId: uuid(17_100 + sequence),
            nonce: Buffer.alloc(16, sequence % 255).toString('base64url'),
          }),
        );
      }
      await waitFor(() => durable.committed.length >= end + 1);
    }
    broker.send(connection.socket, ancientInbound);
    await waitFor(() => durable.replayed.includes(ancientInbound.messageId));
    expect(client.status).toBe('READY');
    broker.send(
      connection.socket,
      pingCommand({
        connectionId: connection.connectionId,
        sequence: '1',
        lease: leaseBinding(LEASE_A, '7'),
        messageId: ancientInbound.messageId,
        nonce: Buffer.alloc(16, 2).toString('base64url'),
      }),
    );
    await waitFor(() => client.status === 'BLOCKED');
  }, 30_000);

  it('permanently blocks unknown, wrong-direction, and binary established frames', async () => {
    for (const invalid of ['unknown-type', 'wrong-direction', 'binary'] as const) {
      const durable = new FakeDurablePort();
      const broker = await startBroker();
      const client = createClient(broker.url, durable);
      await client.start();
      await waitFor(() => client.status === 'READY');
      const connection = broker.connections[0]!;

      if (invalid === 'unknown-type') {
        broker.sendRaw(connection.socket, {
          ...pingCommand({
            connectionId: connection.connectionId,
            sequence: '1',
            lease: leaseBinding(LEASE_A, '7'),
            messageId: uuid(80),
          }),
          type: 'future.unknown-command',
        });
      } else if (invalid === 'wrong-direction') {
        broker.send(
          connection.socket,
          heartbeatEvent({
            connectionId: connection.connectionId,
            sequence: '1',
            lease: leaseBinding(LEASE_A, '7'),
            messageId: uuid(81),
          }),
        );
      } else {
        connection.socket.send(Buffer.from('binary-is-not-json'), { binary: true });
      }

      await waitFor(() => client.status === 'BLOCKED');
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(broker.connectionCount).toBe(1);
      expect(durable.committed).toHaveLength(1);

      await client.stop();
      activeClients.delete(client);
      await broker.stop();
      activeBrokers.delete(broker);
    }
  });

  it('fails the live connection when an explicit flush finds a corrupted durable outbox', async () => {
    const durable = new FakeDurablePort();
    const broker = await startBroker();
    const client = createClient(broker.url, durable);
    await client.start();
    await waitFor(() => client.status === 'READY' && broker.received.length >= 1);
    const record = durable.outbox[0]!;
    record.envelope = BrokerEnvelopeSchema.parse({ ...record.envelope, sequence: '1' });
    record.digest = canonicalSha256(record.envelope);
    record.state = 'PENDING';

    await expect(client.flush()).rejects.toMatchObject({ code: 'PORT_FAILED' });
    await waitFor(() => client.status === 'BLOCKED');
  });

  it('bounds inbound queue and oversized frames before durable business handling', async () => {
    const durable = new FakeDurablePort();
    const barrier = deferred<void>();
    durable.commitBarrier = barrier.promise;
    const broker = await startBroker();
    const client = createClient(broker.url, durable, {
      maxPendingInboundFrames: 1,
      reconnectInitialMs: 200,
      reconnectMaximumMs: 200,
    });
    await client.start();
    await waitFor(() => client.status === 'READY');
    const connection = broker.connections[0]!;
    broker.send(
      connection.socket,
      pingCommand({
        connectionId: connection.connectionId,
        sequence: '1',
        lease: leaseBinding(LEASE_A, '7'),
        messageId: uuid(90),
      }),
    );
    broker.send(
      connection.socket,
      pingCommand({
        connectionId: connection.connectionId,
        sequence: '2',
        lease: leaseBinding(LEASE_A, '7'),
        messageId: uuid(91),
      }),
    );
    await waitFor(() => connection.socket.readyState >= 2);
    barrier.resolve();
    await client.stop();
    activeClients.delete(client);
    expect(durable.committed).toHaveLength(1);
    expect(durable.committed.map((item) => item.messageId)).not.toContain(uuid(91));

    const secondDurable = new FakeDurablePort();
    const secondBroker = await startBroker();
    const secondClient = createClient(secondBroker.url, secondDurable);
    await secondClient.start();
    await waitFor(() => secondClient.status === 'READY');
    secondBroker.connections[0]!.socket.send('x'.repeat(65_537));
    await waitFor(
      () => secondBroker.connectionCount >= 2 && secondDurable.committed.length >= 2,
      2_000,
    );
    expect(secondDurable.committed).toHaveLength(2);
  });

  it('blocks an old connection and stale fence without applying either command', async () => {
    const durable = new FakeDurablePort();
    const broker = await startBroker();
    const diagnostics: WorkerBrokerDiagnosticEvent[] = [];
    const client = createClient(broker.url, durable, { diagnostics });
    await client.start();
    await waitFor(() => client.status === 'READY');
    const socket = broker.connections[0]!.socket;
    const before = durable.committed.length;

    broker.sendRaw(
      socket,
      pingCommand({
        connectionId: uuid(999),
        sequence: '1',
        lease: leaseBinding(LEASE_A, '7'),
        messageId: uuid(100),
      }),
    );
    await waitFor(() => client.status === 'BLOCKED');
    expect(durable.committed).toHaveLength(before);
    expect(diagnostics).toContain('security_block');

    await client.stop();
    activeClients.delete(client);

    const secondDurable = new FakeDurablePort();
    const secondBroker = await startBroker({ initialFence: '8' });
    const secondClient = createClient(secondBroker.url, secondDurable);
    await secondClient.start();
    await waitFor(() => secondClient.status === 'READY');
    secondBroker.send(
      secondBroker.connections[0]!.socket,
      pingCommand({
        connectionId: secondBroker.connections[0]!.connectionId,
        sequence: '1',
        lease: leaseBinding(LEASE_A, '7'),
        messageId: uuid(101),
      }),
    );
    await waitFor(() => secondClient.status === 'BLOCKED');
    expect(secondDurable.committed).toHaveLength(1);
  });

  it('rejects an ACK from a stale fence before it can mutate the durable outbox', async () => {
    const durable = new FakeDurablePort();
    const broker = await startBroker();
    const client = createClient(broker.url, durable);
    await client.start();
    await waitFor(() => client.status === 'READY' && broker.received.length >= 1);
    const connection = broker.connections[0]!;
    const acknowledged = broker.received[0]!.envelope;

    broker.send(
      connection.socket,
      ackFrame({
        connectionId: connection.connectionId,
        sequence: '1',
        lease: leaseBinding(LEASE_A, '6'),
        messageId: uuid(105),
        acknowledgedMessageId: acknowledged.messageId,
      }),
    );

    await waitFor(() => client.status === 'BLOCKED');
    expect(durable.committed).toHaveLength(1);
    expect(
      durable.outbox.find((item) => item.envelope.messageId === acknowledged.messageId)?.state,
    ).toBeUndefined();
  });

  it('persists revocation, stops heartbeats, and rejects later business commands', async () => {
    const durable = new FakeDurablePort();
    const broker = await startBroker();
    const client = createClient(broker.url, durable, { heartbeatIntervalMs: 20 });
    await client.start();
    await waitFor(() => client.status === 'READY');
    const connection = broker.connections[0]!;

    broker.send(
      connection.socket,
      revokeCommand({
        connectionId: connection.connectionId,
        sequence: '1',
        lease: leaseBinding(LEASE_A, '7'),
        messageId: uuid(110),
        reason: 'DRAIN',
      }),
    );
    await waitFor(() => durable.current?.leaseState === 'REVOKED');
    const heartbeatCount = durable.heartbeatCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(durable.heartbeatCalls).toHaveLength(heartbeatCount);

    broker.send(
      connection.socket,
      pingCommand({
        connectionId: connection.connectionId,
        sequence: '2',
        lease: leaseBinding(LEASE_A, '7'),
        messageId: uuid(111),
      }),
    );
    await waitFor(() => client.status === 'BLOCKED');
    expect(durable.committed.map((item) => item.type)).toEqual(['lease.grant', 'lease.revoke']);
  });

  it('does not reconnect when Cloud rejects the installation before granting a lease', async () => {
    const durable = new FakeDurablePort();
    const diagnostics: WorkerBrokerDiagnosticEvent[] = [];
    const broker = await startBroker({ rejectInstallationBeforeGrant: true });
    const client = createClient(broker.url, durable, { diagnostics });
    await client.start();

    await waitFor(() => client.status === 'BLOCKED');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(broker.connectionCount).toBe(1);
    expect(durable.committed).toHaveLength(0);
    expect(diagnostics.filter((event) => event === 'installation_revoked')).toHaveLength(1);
  });

  it('replays an exact duplicate and security-blocks the same sequence with a different body', async () => {
    const durable = new FakeDurablePort();
    const broker = await startBroker();
    const client = createClient(broker.url, durable);
    await client.start();
    await waitFor(() => client.status === 'READY');
    const connection = broker.connections[0]!;
    const command = pingCommand({
      connectionId: connection.connectionId,
      sequence: '1',
      lease: leaseBinding(LEASE_A, '7'),
      messageId: uuid(120),
      nonce: Buffer.alloc(16, 1).toString('base64url'),
    });
    broker.send(connection.socket, command);
    await waitFor(() => durable.committed.length === 2);
    broker.send(connection.socket, command);
    await waitFor(() => durable.replayed.length === 1);
    expect(durable.committed).toHaveLength(2);

    broker.send(
      connection.socket,
      pingCommand({
        connectionId: connection.connectionId,
        sequence: '1',
        lease: leaseBinding(LEASE_A, '7'),
        messageId: uuid(120),
        nonce: Buffer.alloc(16, 2).toString('base64url'),
      }),
    );
    await waitFor(() => client.status === 'BLOCKED');
    expect(durable.committed).toHaveLength(2);
  });

  it('records a sequence gap durably and reconnects instead of sorting later frames', async () => {
    const durable = new FakeDurablePort();
    const broker = await startBroker();
    const client = createClient(broker.url, durable);
    await client.start();
    await waitFor(() => client.status === 'READY');
    const connection = broker.connections[0]!;
    broker.send(
      connection.socket,
      pingCommand({
        connectionId: connection.connectionId,
        sequence: '2',
        lease: leaseBinding(LEASE_A, '7'),
        messageId: uuid(130),
      }),
    );
    await waitFor(
      () =>
        durable.gaps.length === 1 && broker.connectionCount >= 2 && durable.committed.length >= 2,
      2_000,
    );
    expect(durable.gaps).toEqual([{ expected: '1', received: '2' }]);
    expect(durable.committed).toHaveLength(2);
  });

  it('permanently blocks an established frame at expiry without durable business effects', async () => {
    const durable = new FakeDurablePort();
    const broker = await startBroker();
    const client = createClient(broker.url, durable);
    await client.start();
    await waitFor(() => client.status === 'READY');
    const connection = broker.connections[0]!;
    broker.send(
      connection.socket,
      BrokerEnvelopeSchema.parse({
        ...pingCommand({
          connectionId: connection.connectionId,
          sequence: '1',
          lease: leaseBinding(LEASE_A, '7'),
          messageId: uuid(131),
        }),
        sentAt: '2026-08-13T07:59:59.000Z',
        expiresAt: SENT_AT,
      }),
    );

    await waitFor(() => client.status === 'BLOCKED');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(broker.connectionCount).toBe(1);
    expect(durable.committed).toHaveLength(1);
  });

  it('uses only Cloud grant duration for heartbeat authority and never self-renews', async () => {
    const durable = new FakeDurablePort();
    const broker = await startBroker({ leaseDurationMs: 80 });
    const client = createClient(broker.url, durable, {
      heartbeatIntervalMs: 20,
      reconnectInitialMs: 200,
      reconnectMaximumMs: 200,
    });
    await client.start();
    await waitFor(() => durable.heartbeatCalls.length >= 1);
    await waitFor(() => broker.connections[0]!.socket.readyState >= 2, 500);
    const countAtExpiry = durable.heartbeatCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(durable.heartbeatCalls).toHaveLength(countAtExpiry);
    expect(durable.heartbeatCalls.every((expiry) => expiry === broker.leaseExpiresAt(0))).toBe(
      true,
    );
  });

  it('subtracts transport delay from an initial lease using the Cloud challenge time anchor', async () => {
    const durable = new FakeDurablePort();
    const broker = await startBroker({ leaseDurationMs: 80, initialGrantDelayMs: 120 });
    const client = createClient(broker.url, durable, {
      challengeCloudTime: SENT_AT,
      reconnectInitialMs: 200,
      reconnectMaximumMs: 200,
    });
    await client.start();
    await waitFor(() => client.status === 'BLOCKED', 1_000);
    expect(durable.committed).toHaveLength(0);
    expect(durable.releaseConnectionCalls).toBe(0);
  });

  it('moves the heartbeat deadline only after a later Cloud lease grant commits', async () => {
    const durable = new FakeDurablePort();
    const broker = await startBroker({ leaseDurationMs: 120 });
    const client = createClient(broker.url, durable, { heartbeatIntervalMs: 20 });
    await client.start();
    await waitFor(() => durable.heartbeatCalls.length >= 1);
    const connection = broker.connections[0]!;
    const renewedSentAt = new Date(Date.parse(SENT_AT) + 60).toISOString();
    const renewedExpiry = new Date(Date.parse(SENT_AT) + 180).toISOString();
    const renewalGrantMessageId = uuid(135);
    broker.send(
      connection.socket,
      leaseGrant({
        connectionId: connection.connectionId,
        sequence: '1',
        lease: leaseBinding(LEASE_A, '7'),
        messageId: renewalGrantMessageId,
        sentAt: renewedSentAt,
        leaseExpiresAt: renewedExpiry,
      }),
    );
    await waitFor(() => durable.current?.leaseExpiresAt === renewedExpiry);
    await waitFor(() => durable.heartbeatCalls.includes(renewedExpiry));
    await waitFor(() => broker.received.some((item) => item.envelope.type === 'lease.renewed'));
    expect(
      broker.received.find((item) => item.envelope.type === 'lease.renewed')?.envelope
        .correlationId,
    ).toBe(renewalGrantMessageId);
    expect(durable.heartbeatCalls[0]).toBe(broker.leaseExpiresAt(0));
  });

  it('rejects plaintext sensitive bodies and emits only fixed diagnostic names', async () => {
    const marker = 'SENSITIVE-MARKER-MUST-NOT-LOG';
    const durable = new FakeDurablePort();
    const broker = await startBroker();
    const diagnostics: WorkerBrokerDiagnosticEvent[] = [];
    const client = createClient(broker.url, durable, { diagnostics });
    await client.start();
    await waitFor(() => client.status === 'READY');
    const connection = broker.connections[0]!;
    broker.sendRaw(connection.socket, {
      protocol: 'combo.creator-broker/1',
      schemaVersion: 1,
      kind: 'command',
      type: 'invocation.prepare',
      messageId: uuid(140),
      correlationId: uuid(141),
      connectionId: connection.connectionId,
      sequence: '1',
      sentAt: SENT_AT,
      expiresAt: FRAME_EXPIRES_AT,
      lease: leaseBinding(LEASE_A, '7'),
      body: { text: marker },
    });
    await waitFor(() => broker.connections[0]!.socket.readyState >= 2);
    expect(JSON.stringify(diagnostics)).not.toContain(marker);
    expect(durable.committed).toHaveLength(1);
  });

  it('isolates a throwing diagnostic sink from acquire, heartbeat, reconnect, and stop', async () => {
    const durable = new FakeDurablePort();
    const broker = await startBroker({ closeFirstWorkerFrame: true });
    const client = createClient(broker.url, durable, {
      heartbeatIntervalMs: 20,
      diagnosticSink: () => {
        throw new Error('DIAGNOSTIC_SINK_FAILED');
      },
    });

    await client.start();
    await waitFor(
      () =>
        broker.connectionCount >= 2 &&
        client.status === 'READY' &&
        durable.heartbeatCalls.length >= 1,
      2_000,
    );
    await client.stop();
    activeClients.delete(client);

    expect(client.status).toBe('STOPPED');
    expect(durable.releaseConnectionCalls).toBeGreaterThanOrEqual(2);
    expect(durable.owner).toBeUndefined();
  });

  it('bounds stop even when a required durable release port does not return', async () => {
    const durable = new FakeDurablePort();
    const broker = await startBroker();
    const client = createClient(broker.url, durable, { portTimeoutMs: 50 });
    await client.start();
    await waitFor(() => client.status === 'READY');
    durable.hangInstallationRelease = true;
    const startedAt = Date.now();
    await expect(client.stop()).rejects.toMatchObject({ code: 'STOP_TIMEOUT' });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(client.status).toBe('BLOCKED');
    expect(durable.owner).toBeDefined();
  });
});

describe('Real Worker transport ↔ Real Gateway close authority', () => {
  it('re-challenges and re-authenticates after an expired short session', async () => {
    const authority = new InteropGatewayAuthority([
      BrokerAuthenticationFailureCode.SESSION_EXPIRED,
    ]);
    const url = await startAgentGateway(authority);
    const durable = new FakeDurablePort();
    const client = createClient(url, durable);

    await client.start();
    await waitFor(() => client.status === 'READY' && authority.handshakes.length === 2, 2_000);

    expect(authority.handshakes[0]!.challengeId).not.toBe(authority.handshakes[1]!.challengeId);
    expect(durable.committed.map((item) => item.type)).toContain('lease.grant');
  });

  it('blocks machine-readable revoked and incompatible authentication failures', async () => {
    for (const failure of [
      BrokerAuthenticationFailureCode.INSTALLATION_REVOKED,
      BrokerAuthenticationFailureCode.WORKER_INCOMPATIBLE,
    ]) {
      const authority = new InteropGatewayAuthority([failure]);
      const gateway = new AgentGateway({
        authority,
        host: '127.0.0.1',
        port: 0,
        now: () => Date.parse(SENT_AT),
      });
      activeAgentGateways.add(gateway);
      const address = await gateway.start();
      const durable = new FakeDurablePort();
      const client = createClient(`ws://${address.host}:${address.port}${address.path}`, durable);

      await client.start();
      await waitFor(() => client.status === 'BLOCKED');
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(authority.handshakes).toHaveLength(1);
      expect(durable.committed).toHaveLength(0);

      await client.stop();
      activeClients.delete(client);
      await gateway.stop();
      activeAgentGateways.delete(gateway);
    }
  });

  it('drops connection-scoped overflow before retrying Gateway transport capacity', async () => {
    const authority = new InteropGatewayAuthority();
    const url = await startAgentGateway(authority);
    const durable = new FakeDurablePort();
    const client = createClient(url, durable, {
      reconnectInitialMs: 100,
      reconnectMaximumMs: 100,
    });
    await client.start();
    await waitFor(
      () => client.status === 'READY' && durable.outbox.some((item) => item.state === 'ACKED'),
      2_000,
    );

    authority.hangAccept = true;
    const stalePongIds = durable.seedPongs(12);
    void client.flush().catch(() => undefined);
    await waitFor(
      () => durable.releaseConnectionCalls >= 1 && authority.closed.includes('CAPACITY'),
      2_000,
    );
    authority.hangAccept = false;

    await waitFor(() => client.status === 'READY' && authority.sessions.length >= 2, 3_000);
    expect(client.status).not.toBe('BLOCKED');
    expect(stalePongIds.some((messageId) => durable.reboundMessageIds.includes(messageId))).toBe(
      false,
    );
    expect(
      stalePongIds.some((messageId) =>
        durable.outbox.some((item) => item.envelope.messageId === messageId),
      ),
    ).toBe(false);
  });

  it('blocks a Gateway SESSION_REPLACED close instead of reconnect oscillation', async () => {
    const authority = new InteropGatewayAuthority();
    const url = await startAgentGateway(authority);
    const durable = new FakeDurablePort();
    const client = createClient(url, durable);
    await client.start();
    await waitFor(() => client.status === 'READY');

    const replacement = new WebSocket(url, { perMessageDeflate: false });
    replacement.on('error', () => undefined);
    await once(replacement, 'open');
    replacement.send(canonicalizeJson(gatewayHandshake(uuid(1_900))));
    await waitFor(() => client.status === 'BLOCKED' && authority.sessions.length === 2, 2_000);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(authority.handshakes).toHaveLength(2);
    expect(authority.closed).toContain('SESSION_REPLACED');
    expect(durable.releaseConnectionCalls).toBeGreaterThanOrEqual(1);
    replacement.terminate();
  });
});

type FakeBrokerOptions = Readonly<{
  closeFirstWorkerFrame?: boolean;
  initialFence?: string;
  leaseDurationMs?: number;
  malformedFirstFrame?: boolean;
  rejectInstallationBeforeGrant?: boolean;
  initialGrantDelayMs?: number;
}>;

type BrokerConnection = {
  socket: WebSocket;
  connectionId: string;
  handshake?: BrokerHandshake;
  workerFrameCount: number;
};

class FakeBroker {
  readonly handshakes: BrokerHandshake[] = [];
  readonly received: Array<{ connectionIndex: number; envelope: BrokerEnvelope }> = [];
  readonly upgradePaths: string[] = [];
  readonly connections: BrokerConnection[] = [];
  readonly #server: HttpServer;
  readonly #webSockets: WebSocketServer;
  readonly #options: FakeBrokerOptions;
  readonly #baseNow = Date.parse(SENT_AT);
  url = '';

  constructor(options: FakeBrokerOptions = {}) {
    this.#options = options;
    this.#server = createServer((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    this.#webSockets = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      perMessageDeflate: false,
      maxPayload: 65_536,
    });
    this.#server.on('upgrade', (request, socket, head) => {
      this.upgradePaths.push(request.url ?? '');
      if (request.url !== WORKER_BROKER_CONNECT_PATH) {
        socket.destroy();
        return;
      }
      this.#webSockets.handleUpgrade(request, socket, head, (webSocket) => this.#accept(webSocket));
    });
  }

  get connectionCount(): number {
    return this.connections.length;
  }

  leaseExpiresAt(index: number): string {
    return new Date(
      this.#baseNow + index * 1_000 + (this.#options.leaseDurationMs ?? 30_000),
    ).toISOString();
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.#server.address();
    if (address === null || typeof address === 'string') throw new Error('INVALID_ADDRESS');
    this.url = `ws://127.0.0.1:${address.port}${WORKER_BROKER_CONNECT_PATH}`;
  }

  async stop(): Promise<void> {
    for (const connection of this.connections) connection.socket.terminate();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    this.#webSockets.close();
  }

  send(socket: WebSocket, envelope: BrokerEnvelope): void {
    socket.send(canonicalizeJson(BrokerEnvelopeSchema.parse(envelope)));
  }

  sendRaw(socket: WebSocket, input: unknown): void {
    socket.send(canonicalizeJson(input));
  }

  #accept(socket: WebSocket): void {
    const index = this.connections.length;
    const connection: BrokerConnection = {
      socket,
      connectionId: uuid(200 + index),
      workerFrameCount: 0,
    };
    this.connections.push(connection);
    socket.on('error', () => undefined);
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(4002, 'BINARY');
        return;
      }
      if (connection.handshake === undefined) {
        const handshake = parseBrokerHandshake(rawDataBytes(data));
        connection.handshake = handshake;
        this.handshakes.push(handshake);
        if (this.#options.malformedFirstFrame) {
          socket.send('{not-json');
          return;
        }
        if (this.#options.rejectInstallationBeforeGrant) {
          socket.close(BrokerCloseCode.AUTH_FAILED, BrokerCloseReason.INSTALLATION_REVOKED);
          return;
        }
        const fence = (BigInt(this.#options.initialFence ?? '7') + BigInt(index)).toString(10);
        const lease = leaseBinding(index === 0 ? LEASE_A : uuid(400 + index), fence);
        const grant = leaseGrant({
          connectionId: connection.connectionId,
          sequence: '0',
          lease: {
            ...lease,
            workerSessionId: index === 0 ? WORKER_SESSION : uuid(500 + index),
          },
          messageId: uuid(300 + index),
          sentAt: new Date(this.#baseNow + index * 1_000).toISOString(),
          leaseExpiresAt: this.leaseExpiresAt(index),
        });
        if ((this.#options.initialGrantDelayMs ?? 0) > 0) {
          const timer = setTimeout(
            () => this.send(socket, grant),
            this.#options.initialGrantDelayMs,
          );
          timer.unref();
        } else {
          this.send(socket, grant);
        }
        return;
      }
      const envelope = parseBrokerFrame(rawDataBytes(data));
      connection.workerFrameCount += 1;
      this.received.push({ connectionIndex: index, envelope });
      if (this.#options.closeFirstWorkerFrame && index === 0 && connection.workerFrameCount === 1) {
        socket.close(1012, 'FAKE_BROKER_RESTART');
      }
    });
  }
}

class FakeDurablePort implements WorkerBrokerDurableTransportPort {
  owner?: string;
  current?: MutableConnection;
  acquireCalls = 0;
  releaseConnectionCalls = 0;
  readonly retired = new Set<string>();
  readonly committed: BrokerEnvelope[] = [];
  readonly replayed: string[] = [];
  readonly gaps: Array<{ expected: string; received: string }> = [];
  readonly heartbeatCalls: string[] = [];
  readonly reboundMessageIds: string[] = [];
  readonly outbox: OutboxRecord[] = [];
  readonly #highestFenceByDeployment = new Map<string, bigint>();
  corruptActivationReturn = false;
  corruptNextOutbound = false;
  holdOutbound = false;
  commitBarrier?: Promise<void>;
  hangConnectionRelease = false;
  hangInstallationRelease = false;
  #nextMessage = 500;

  seedPongs(count: number): readonly string[] {
    if (!Number.isSafeInteger(count) || count < 1 || count > 32) {
      throw new Error('INVALID_SEED_COUNT');
    }
    const current = this.requireCurrent(this.current!.connectionId);
    const messageIds: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const messageId = uuid(this.#nextMessage++);
      messageIds.push(messageId);
      this.enqueue(
        BrokerEnvelopeSchema.parse({
          protocol: 'combo.creator-broker/1',
          schemaVersion: 1,
          kind: 'event',
          type: 'pong',
          messageId,
          correlationId: CORRELATION,
          connectionId: current.connectionId,
          sequence: this.nextOutboundSequence(),
          sentAt: current.leaseGrantedAt,
          expiresAt: current.leaseExpiresAt,
          lease: current.lease,
          body: { nonce: Buffer.alloc(16, index + 1).toString('base64url') },
        }),
      );
    }
    return messageIds;
  }

  advanceOutboundCursor(count: number): void {
    if (!Number.isSafeInteger(count) || count < 1 || count > 2_048) {
      throw new Error('INVALID_ADVANCE_COUNT');
    }
    const current = this.requireCurrent(this.current!.connectionId);
    for (let index = 0; index < count; index += 1) {
      this.acceptOutbound(
        BrokerEnvelopeSchema.parse({
          protocol: 'combo.creator-broker/1',
          schemaVersion: 1,
          kind: 'event',
          type: 'pong',
          messageId: uuid(this.#nextMessage++),
          correlationId: CORRELATION,
          connectionId: current.connectionId,
          sequence: this.nextOutboundSequence(),
          sentAt: current.leaseGrantedAt,
          expiresAt: current.leaseExpiresAt,
          lease: current.lease,
          body: { nonce: Buffer.alloc(16, (index % 254) + 1).toString('base64url') },
        }),
      );
    }
  }

  async acquireInstallation(input: {
    installationId: string;
    ownerToken: string;
  }): Promise<boolean> {
    expect(input.installationId).toBe(INSTALLATION);
    this.acquireCalls += 1;
    if (this.owner !== undefined && this.owner !== input.ownerToken) return false;
    this.owner = input.ownerToken;
    return true;
  }

  async releaseInstallation(input: { ownerToken: string }): Promise<void> {
    if (this.hangInstallationRelease) await new Promise<void>(() => undefined);
    if (this.owner === input.ownerToken) this.owner = undefined;
  }

  async activateConnection(input: {
    installationId: string;
    ownerToken: string;
    envelope: LeaseGrantCommand;
    canonicalDigest: string;
    inboundCursor: string;
  }): Promise<DurableBrokerConnection> {
    this.assertOwner(input.ownerToken);
    if (this.retired.has(input.envelope.connectionId)) {
      throw new WorkerBrokerClientError('STALE_CONNECTION', true);
    }
    if (canonicalSha256(input.envelope) !== input.canonicalDigest) {
      throw new WorkerBrokerClientError('PORT_FAILED', true);
    }
    const deploymentId = input.envelope.lease.deploymentId;
    const nextFence = BigInt(input.envelope.lease.fence);
    const highestFence = this.#highestFenceByDeployment.get(deploymentId);
    if (
      highestFence !== undefined &&
      (nextFence < highestFence ||
        (nextFence === highestFence &&
          (this.current?.connectionId !== input.envelope.connectionId ||
            !sameLease(this.current.lease, input.envelope.lease))))
    ) {
      throw new WorkerBrokerClientError('STALE_FENCE', true);
    }
    if (this.current !== undefined && this.current.connectionId !== input.envelope.connectionId) {
      this.retired.add(this.current.connectionId);
    }
    const outboundCursor = initialSequenceCursor(input.envelope.connectionId);
    this.current = {
      installationId: input.installationId,
      connectionId: input.envelope.connectionId,
      workerSessionId: input.envelope.lease.workerSessionId,
      lease: { ...input.envelope.lease },
      leaseState: 'ACTIVE',
      leaseGrantedAt: input.envelope.sentAt,
      leaseExpiresAt: input.envelope.body.leaseExpiresAt,
      inboundCursor: input.inboundCursor,
      outboundCursor: serializeSequenceCursor(outboundCursor),
    };
    this.committed.push(input.envelope);

    this.discardConnectionScopedOutbound();
    const pending = this.outbox.filter((item) => item.state !== 'ACKED');
    for (const item of pending) {
      item.envelope = this.reframe(item.envelope, this.current);
      item.digest = canonicalSha256(item.envelope);
      item.state = 'PENDING';
      this.reboundMessageIds.push(item.envelope.messageId);
      this.acceptOutbound(item.envelope);
    }
    this.enqueueLeaseEvent('lease.accepted', input.envelope.messageId);
    this.#highestFenceByDeployment.set(deploymentId, nextFence);
    const activated = cloneConnection(this.current);
    if (!this.corruptActivationReturn) return activated;
    return {
      ...activated,
      workerSessionId: uuid(998),
    };
  }

  async loadConnection(input: {
    ownerToken: string;
    connectionId: string;
  }): Promise<DurableBrokerConnection | null> {
    this.assertOwner(input.ownerToken);
    return this.current?.connectionId === input.connectionId ? cloneConnection(this.current) : null;
  }

  async commitInbound(input: {
    ownerToken: string;
    connectionId: string;
    expectedInboundCursor: string;
    nextInboundCursor: string;
    envelope: BrokerEnvelope;
    canonicalDigest: string;
    signal: AbortSignal;
  }): Promise<DurableBrokerConnection> {
    this.assertOwner(input.ownerToken);
    if (this.commitBarrier !== undefined) {
      await Promise.race([this.commitBarrier, abortPromise(input.signal)]);
    }
    const current = this.requireCurrent(input.connectionId);
    if (
      current.inboundCursor !== input.expectedInboundCursor ||
      canonicalSha256(input.envelope) !== input.canonicalDigest
    ) {
      throw new WorkerBrokerClientError('PORT_FAILED', true);
    }
    if (input.envelope.kind === 'command' && input.envelope.type === 'lease.grant') {
      const highestFence = this.#highestFenceByDeployment.get(input.envelope.lease.deploymentId);
      const nextFence = BigInt(input.envelope.lease.fence);
      if (
        input.envelope.lease.deploymentId !== current.lease.deploymentId ||
        highestFence === undefined ||
        nextFence < highestFence ||
        (nextFence === highestFence && !sameLease(current.lease, input.envelope.lease))
      ) {
        throw new WorkerBrokerClientError('STALE_FENCE', true);
      }
    }
    current.inboundCursor = input.nextInboundCursor;
    this.committed.push(input.envelope);
    if (input.envelope.kind === 'command' && input.envelope.type === 'lease.grant') {
      const deploymentId = input.envelope.lease.deploymentId;
      const nextFence = BigInt(input.envelope.lease.fence);
      current.lease = { ...input.envelope.lease };
      current.workerSessionId = input.envelope.lease.workerSessionId;
      current.leaseState = 'ACTIVE';
      current.leaseGrantedAt = input.envelope.sentAt;
      current.leaseExpiresAt = input.envelope.body.leaseExpiresAt;
      this.enqueueLeaseEvent('lease.renewed', input.envelope.messageId);
      this.#highestFenceByDeployment.set(deploymentId, nextFence);
    } else if (input.envelope.kind === 'command' && input.envelope.type === 'lease.revoke') {
      current.leaseState = 'REVOKED';
    } else if (input.envelope.kind === 'ack') {
      const acknowledgedMessageId = input.envelope.body.acknowledgedMessageId;
      const record = this.outbox.find((item) => item.envelope.messageId === acknowledgedMessageId);
      if (record !== undefined && input.envelope.body.level === 'CLOUD_COMMITTED') {
        record.state = 'ACKED';
      }
    }
    return cloneConnection(current);
  }

  async replayInbound(input: {
    ownerToken: string;
    connectionId: string;
    envelope: BrokerEnvelope;
    canonicalDigest: string;
  }): Promise<'EXACT_REPLAY' | 'NOT_FOUND'> {
    this.assertOwner(input.ownerToken);
    this.requireCurrent(input.connectionId);
    const sameSequence = this.committed.find(
      (item) =>
        item.connectionId === input.envelope.connectionId &&
        item.sequence === input.envelope.sequence,
    );
    if (sameSequence === undefined) {
      const sameMessage = this.committed.find(
        (item) => item.messageId === input.envelope.messageId,
      );
      if (sameMessage !== undefined && canonicalSha256(sameMessage) !== input.canonicalDigest) {
        throw new WorkerBrokerClientError('SEQUENCE_CONFLICT', true);
      }
      return 'NOT_FOUND';
    }
    if (
      sameSequence.messageId !== input.envelope.messageId ||
      canonicalSha256(sameSequence) !== input.canonicalDigest
    ) {
      throw new WorkerBrokerClientError('SEQUENCE_CONFLICT', true);
    }
    this.replayed.push(input.envelope.messageId);
    return 'EXACT_REPLAY';
  }

  async recordSequenceGap(input: {
    ownerToken: string;
    expected: string;
    received: string;
  }): Promise<void> {
    this.assertOwner(input.ownerToken);
    this.gaps.push({ expected: input.expected, received: input.received });
  }

  async enqueueHeartbeat(input: {
    ownerToken: string;
    connectionId: string;
    lease: LeaseBinding;
    cloudLeaseExpiresAt: string;
  }): Promise<void> {
    this.assertOwner(input.ownerToken);
    const current = this.requireCurrent(input.connectionId);
    if (
      current.leaseState !== 'ACTIVE' ||
      !sameLease(current.lease, input.lease) ||
      current.leaseExpiresAt !== input.cloudLeaseExpiresAt
    ) {
      throw new WorkerBrokerClientError('STALE_LEASE');
    }
    this.heartbeatCalls.push(input.cloudLeaseExpiresAt);
    const messageId = uuid(this.#nextMessage++);
    this.enqueue(
      BrokerEnvelopeSchema.parse({
        protocol: 'combo.creator-broker/1',
        schemaVersion: 1,
        kind: 'event',
        type: 'heartbeat',
        messageId,
        correlationId: CORRELATION,
        connectionId: current.connectionId,
        sequence: this.nextOutboundSequence(),
        sentAt: current.leaseGrantedAt,
        expiresAt: current.leaseExpiresAt,
        lease: current.lease,
        body: {
          workerSessionId: current.workerSessionId,
          runtimeReady: true,
          proxyReady: true,
          journalReady: true,
          activeInvocationId: null,
        },
      }),
    );
  }

  async readOutbound(input: {
    ownerToken: string;
    connectionId: string;
    limit: number;
  }): Promise<readonly BrokerEnvelope[]> {
    this.assertOwner(input.ownerToken);
    this.requireCurrent(input.connectionId);
    if (this.holdOutbound) return [];
    return this.outbox
      .filter((item) => item.state === 'PENDING')
      .slice(0, input.limit)
      .map((item) => item.envelope);
  }

  async markOutboundWritten(input: {
    ownerToken: string;
    connectionId: string;
    messageId: string;
    canonicalDigest: string;
  }): Promise<void> {
    this.assertOwner(input.ownerToken);
    this.requireCurrent(input.connectionId);
    const item = this.outbox.find((record) => record.envelope.messageId === input.messageId);
    if (item === undefined || item.digest !== input.canonicalDigest || item.state !== 'PENDING') {
      throw new WorkerBrokerClientError('PORT_FAILED', true);
    }
    item.state = 'WRITTEN';
  }

  async releaseConnection(input: { ownerToken: string; connectionId: string }): Promise<void> {
    this.assertOwner(input.ownerToken);
    this.releaseConnectionCalls += 1;
    if (this.hangConnectionRelease) await new Promise<void>(() => undefined);
    if (this.current?.connectionId !== input.connectionId) return;
    this.retired.add(input.connectionId);
    this.discardConnectionScopedOutbound();
    this.current = undefined;
  }

  private discardConnectionScopedOutbound(): void {
    for (let index = this.outbox.length - 1; index >= 0; index -= 1) {
      const item = this.outbox[index]!;
      if (item.state === 'ACKED') continue;
      if (item.envelope.kind !== 'ack' || item.envelope.type !== 'message.ack') {
        this.outbox.splice(index, 1);
        continue;
      }
      item.state = 'PENDING';
    }
  }

  private enqueueLeaseEvent(
    type: 'lease.accepted' | 'lease.renewed',
    grantMessageId: string,
  ): void {
    const current = this.requireCurrent(this.current!.connectionId);
    this.enqueue(
      BrokerEnvelopeSchema.parse({
        protocol: 'combo.creator-broker/1',
        schemaVersion: 1,
        kind: 'event',
        type,
        messageId: uuid(this.#nextMessage++),
        correlationId: grantMessageId,
        connectionId: current.connectionId,
        sequence: this.nextOutboundSequence(),
        sentAt: current.leaseGrantedAt,
        expiresAt: current.leaseExpiresAt,
        lease: current.lease,
        body: { leaseExpiresAt: current.leaseExpiresAt },
      }),
    );
  }

  private enqueue(envelope: BrokerEnvelope): void {
    this.acceptOutbound(envelope);
    let stored = envelope;
    if (this.corruptNextOutbound) {
      this.corruptNextOutbound = false;
      stored = BrokerEnvelopeSchema.parse({
        ...envelope,
        sequence: (BigInt(envelope.sequence) + 1n).toString(10),
      });
    }
    this.outbox.push({ envelope: stored, digest: canonicalSha256(stored), state: 'PENDING' });
  }

  private acceptOutbound(envelope: BrokerEnvelope): void {
    const current = this.requireCurrent(envelope.connectionId);
    const cursor = restoreSequenceCursor(current.outboundCursor);
    const decision = consumeSequence(
      cursor,
      envelope,
      canonicalSha256(envelope),
      Date.parse(envelope.sentAt),
    );
    if (decision.type !== 'ACCEPT') throw new WorkerBrokerClientError('PORT_FAILED', true);
    current.outboundCursor = serializeSequenceCursor(decision.cursor);
  }

  private nextOutboundSequence(): string {
    const current = this.requireCurrent(this.current!.connectionId);
    return restoreSequenceCursor(current.outboundCursor).nextExpected.toString(10);
  }

  private reframe(envelope: BrokerEnvelope, current: MutableConnection): BrokerEnvelope {
    if (envelope.kind !== 'ack' || envelope.type !== 'message.ack') {
      throw new WorkerBrokerClientError('PORT_FAILED', true);
    }
    return BrokerEnvelopeSchema.parse({
      ...envelope,
      connectionId: current.connectionId,
      sequence: this.nextOutboundSequence(),
      sentAt: current.leaseGrantedAt,
      expiresAt: current.leaseExpiresAt,
      lease: current.lease,
      body: envelope.body,
    });
  }

  private requireCurrent(connectionId: string): MutableConnection {
    if (this.current === undefined || this.current.connectionId !== connectionId) {
      throw new WorkerBrokerClientError('STALE_CONNECTION', true);
    }
    return this.current;
  }

  private assertOwner(ownerToken: string): void {
    if (this.owner !== ownerToken) throw new WorkerBrokerClientError('PORT_FAILED', true);
  }
}

type MutableConnection = {
  installationId: string;
  connectionId: string;
  workerSessionId: string;
  lease: LeaseBinding;
  leaseState: 'ACTIVE' | 'REVOKED';
  leaseGrantedAt: string;
  leaseExpiresAt: string;
  inboundCursor: string;
  outboundCursor: string;
};

type OutboxRecord = {
  envelope: BrokerEnvelope;
  digest: string;
  state: 'PENDING' | 'WRITTEN' | 'ACKED';
};

class InteropGatewayAuthority implements AgentGatewayAuthorityPort {
  readonly handshakes: BrokerHandshake[] = [];
  readonly sessions: AuthenticatedWorkerSession[] = [];
  readonly accepted: GatewayDelivery[] = [];
  readonly closed: GatewayDisconnectReason[] = [];
  readonly #failures: BrokerAuthenticationFailureCodeType[];
  readonly #leases = new Map<string, LeaseBinding>();
  readonly #nextOutbound = new Map<string, bigint>();
  readonly #acks = new Map<string, BrokerEnvelope>();
  hangAccept = false;
  #nextMessage = 3_000;

  constructor(failures: readonly BrokerAuthenticationFailureCodeType[] = []) {
    this.#failures = [...failures];
  }

  async authenticate(input: {
    handshake: BrokerHandshake;
    signal: AbortSignal;
  }): Promise<AuthenticatedWorkerSession> {
    if (input.signal.aborted) throw input.signal.reason;
    this.handshakes.push(input.handshake);
    const failure = this.#failures.shift();
    if (failure !== undefined) throw new BrokerAuthenticationError(failure);
    const index = this.sessions.length;
    const session = Object.freeze({
      ownerId: uuid(2_000),
      installationId: input.handshake.installationId,
      connectionId: uuid(2_100 + index),
      workerSessionId: uuid(2_200 + index),
    });
    this.sessions.push(session);
    return session;
  }

  async openSession(
    session: AuthenticatedWorkerSession,
    signal: AbortSignal,
  ): Promise<readonly BrokerEnvelope[]> {
    if (signal.aborted) throw signal.reason;
    const index = this.sessions.findIndex((item) => item.connectionId === session.connectionId);
    if (index < 0) throw new Error('MISSING_SESSION');
    const lease = leaseBinding(uuid(2_300 + index), String(7 + index));
    const boundLease = Object.freeze({ ...lease, workerSessionId: session.workerSessionId });
    this.#leases.set(session.connectionId, boundLease);
    this.#nextOutbound.set(session.connectionId, 1n);
    return [
      leaseGrant({
        connectionId: session.connectionId,
        sequence: '0',
        lease: boundLease,
        messageId: uuid(this.#nextMessage++),
        sentAt: SENT_AT,
        leaseExpiresAt: new Date(Date.parse(SENT_AT) + 30_000).toISOString(),
      }),
    ];
  }

  async acceptEnvelope(
    session: AuthenticatedWorkerSession,
    delivery: GatewayDelivery,
    signal: AbortSignal,
  ): Promise<readonly BrokerEnvelope[]> {
    if (this.hangAccept) await abortPromise(signal);
    this.accepted.push(delivery);
    const ack = this.ackFor(session, delivery.envelope, 'APPLIED');
    this.#acks.set(delivery.envelope.messageId, ack);
    return [ack];
  }

  async replayEnvelope(
    _session: AuthenticatedWorkerSession,
    delivery: GatewayDelivery,
  ): Promise<readonly BrokerEnvelope[]> {
    const ack = this.#acks.get(delivery.envelope.messageId);
    if (ack === undefined) throw new Error('MISSING_DURABLE_ACK');
    return [ack];
  }

  async sequenceGap(): Promise<void> {
    return undefined;
  }

  async closeSession(
    _session: AuthenticatedWorkerSession,
    reason: GatewayDisconnectReason,
  ): Promise<void> {
    this.closed.push(reason);
  }

  private ackFor(
    session: AuthenticatedWorkerSession,
    inbound: BrokerEnvelope,
    decision: 'APPLIED' | 'IDEMPOTENT_REPLAY',
  ): BrokerEnvelope {
    const lease = this.#leases.get(session.connectionId);
    const sequence = this.#nextOutbound.get(session.connectionId);
    if (lease === undefined || sequence === undefined) throw new Error('MISSING_SESSION_LEASE');
    this.#nextOutbound.set(session.connectionId, sequence + 1n);
    return BrokerAckSchema.parse({
      protocol: 'combo.creator-broker/1',
      schemaVersion: 1,
      kind: 'ack',
      type: 'message.ack',
      messageId: uuid(this.#nextMessage++),
      correlationId: inbound.correlationId,
      connectionId: session.connectionId,
      sequence: sequence.toString(10),
      sentAt: SENT_AT,
      expiresAt: FRAME_EXPIRES_AT,
      lease,
      body: {
        acknowledgedMessageId: inbound.messageId,
        level: 'CLOUD_COMMITTED',
        decision,
      },
    });
  }
}

async function startAgentGateway(authority: InteropGatewayAuthority): Promise<string> {
  const gateway = new AgentGateway({
    authority,
    host: '127.0.0.1',
    port: 0,
    now: () => Date.parse(SENT_AT),
  });
  activeAgentGateways.add(gateway);
  const address = await gateway.start();
  return `ws://${address.host}:${address.port}${address.path}`;
}

function gatewayHandshake(challengeId: string): BrokerHandshake {
  return parseBrokerHandshake(
    canonicalizeJson({
      protocol: 'combo.creator-broker/1',
      schemaVersion: 1,
      installationId: INSTALLATION,
      workerVersion: '0.1.0',
      supportedProtocolVersions: [1],
      codexRuntimeArtifacts: [`sha256:${'1'.repeat(64)}`],
      codexProtocolSchemaDigests: [`sha256:${'2'.repeat(64)}`],
      isolationModes: ['apple-container-v1'],
      capacity: { maxActiveConversations: 1, maxActiveTurns: 1 },
      challengeId,
      challengeSignature: SIGNATURE,
    }),
  );
}

function createClient(
  url: string,
  durablePort: FakeDurablePort,
  options: {
    signed?: Buffer[];
    diagnostics?: WorkerBrokerDiagnosticEvent[];
    heartbeatIntervalMs?: number;
    reconnectInitialMs?: number;
    reconnectMaximumMs?: number;
    maxPendingInboundFrames?: number;
    portTimeoutMs?: number;
    diagnosticSink?: (event: WorkerBrokerDiagnosticEvent) => void;
    challengeCloudTime?: string;
  } = {},
): WorkerBrokerClient {
  let challenge = 700;
  const challengePort: BrokerChallengePort = {
    async requestChallenge() {
      return {
        challengeId: uuid(challenge++),
        ...(options.challengeCloudTime === undefined
          ? {}
          : { cloudTime: options.challengeCloudTime }),
      };
    },
  };
  const deviceSigner: DeviceSignerPort = {
    async signCanonicalHandshake(input) {
      options.signed?.push(Buffer.from(input.canonicalBytes));
      return SIGNATURE;
    },
  };
  const diagnostics = options.diagnostics;
  const client = new WorkerBrokerClient({
    url,
    installationId: INSTALLATION,
    workerVersion: '0.1.0',
    codexRuntimeArtifacts: [`sha256:${'1'.repeat(64)}`],
    codexProtocolSchemaDigests: [`sha256:${'2'.repeat(64)}`],
    isolationModes: ['apple-container-v1'],
    challengePort,
    deviceSigner,
    durablePort,
    allowInsecureLoopbackForTests: true,
    handshakeTimeoutMs: 500,
    portTimeoutMs: options.portTimeoutMs ?? 500,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 200,
    reconnectInitialMs: options.reconnectInitialMs ?? 10,
    reconnectMaximumMs: options.reconnectMaximumMs ?? 20,
    maxPendingInboundFrames: options.maxPendingInboundFrames,
    stopTimeoutMs: 500,
    diagnosticSink:
      options.diagnosticSink ??
      (diagnostics === undefined ? undefined : (event) => diagnostics.push(event)),
  });
  activeClients.add(client);
  return client;
}

async function startBroker(options: FakeBrokerOptions = {}): Promise<FakeBroker> {
  const broker = new FakeBroker(options);
  await broker.start();
  activeBrokers.add(broker);
  return broker;
}

function leaseGrant(input: {
  connectionId: string;
  sequence: string;
  lease: LeaseBinding;
  messageId: string;
  sentAt: string;
  leaseExpiresAt: string;
}): LeaseGrantCommand {
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'command',
    type: 'lease.grant',
    messageId: input.messageId,
    correlationId: CORRELATION,
    connectionId: input.connectionId,
    sequence: input.sequence,
    sentAt: input.sentAt,
    expiresAt: new Date(Date.parse(input.sentAt) + 60_000).toISOString(),
    lease: input.lease,
    body: {
      leaseExpiresAt: input.leaseExpiresAt,
      workerSessionId: input.lease.workerSessionId,
      generation: '1',
    },
  }) as LeaseGrantCommand;
}

function fakeActivationInput(ownerToken: string, envelope: LeaseGrantCommand) {
  const canonicalDigest = canonicalSha256(envelope);
  const decision = consumeSequence(
    initialSequenceCursor(envelope.connectionId),
    envelope,
    canonicalDigest,
    Date.parse(envelope.sentAt),
  );
  if (decision.type !== 'ACCEPT') throw new Error('INVALID_FAKE_GRANT');
  return {
    installationId: INSTALLATION,
    ownerToken,
    envelope,
    canonicalDigest,
    inboundCursor: serializeSequenceCursor(decision.cursor),
  };
}

function pingCommand(input: {
  connectionId: string;
  sequence: string;
  lease: LeaseBinding;
  messageId: string;
  nonce?: string;
}): BrokerEnvelope {
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'command',
    type: 'ping',
    messageId: input.messageId,
    correlationId: CORRELATION,
    connectionId: input.connectionId,
    sequence: input.sequence,
    sentAt: SENT_AT,
    expiresAt: FRAME_EXPIRES_AT,
    lease: input.lease,
    body: { nonce: input.nonce ?? Buffer.alloc(16, 3).toString('base64url') },
  });
}

function revokeCommand(input: {
  connectionId: string;
  sequence: string;
  lease: LeaseBinding;
  messageId: string;
  reason: 'SESSION_REPLACED' | 'DRAIN' | 'IMMEDIATE' | 'SECURITY' | 'INSTALLATION_REVOKED';
}): BrokerEnvelope {
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'command',
    type: 'lease.revoke',
    messageId: input.messageId,
    correlationId: CORRELATION,
    connectionId: input.connectionId,
    sequence: input.sequence,
    sentAt: SENT_AT,
    expiresAt: FRAME_EXPIRES_AT,
    lease: input.lease,
    body: { reason: input.reason, effectiveAt: SENT_AT },
  });
}

function heartbeatEvent(input: {
  connectionId: string;
  sequence: string;
  lease: LeaseBinding;
  messageId: string;
}): BrokerEnvelope {
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'event',
    type: 'heartbeat',
    messageId: input.messageId,
    correlationId: CORRELATION,
    connectionId: input.connectionId,
    sequence: input.sequence,
    sentAt: SENT_AT,
    expiresAt: FRAME_EXPIRES_AT,
    lease: input.lease,
    body: {
      workerSessionId: input.lease.workerSessionId,
      runtimeReady: true,
      proxyReady: true,
      journalReady: true,
      activeInvocationId: null,
    },
  });
}

function ackFrame(input: {
  connectionId: string;
  sequence: string;
  lease: LeaseBinding;
  messageId: string;
  acknowledgedMessageId: string;
}): BrokerEnvelope {
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'ack',
    type: 'message.ack',
    messageId: input.messageId,
    correlationId: CORRELATION,
    connectionId: input.connectionId,
    sequence: input.sequence,
    sentAt: SENT_AT,
    expiresAt: FRAME_EXPIRES_AT,
    lease: input.lease,
    body: {
      acknowledgedMessageId: input.acknowledgedMessageId,
      level: 'CLOUD_COMMITTED',
      decision: 'APPLIED',
    },
  });
}

function leaseBinding(leaseId: string, fence: string): LeaseBinding {
  return { deploymentId: DEPLOYMENT, leaseId, workerSessionId: WORKER_SESSION, fence };
}

function cloneConnection(input: MutableConnection): DurableBrokerConnection {
  return Object.freeze({ ...input, lease: Object.freeze({ ...input.lease }) });
}

function sameLease(left: LeaseBinding, right: LeaseBinding): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function uuid(value: number): string {
  return `0198f00d-5000-7000-8000-${value.toString(16).padStart(12, '0')}`;
}

function rawDataBytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  throw new Error('UNSUPPORTED_RAW_DATA');
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('WAIT_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new WorkerBrokerClientError('PORT_FAILED'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
