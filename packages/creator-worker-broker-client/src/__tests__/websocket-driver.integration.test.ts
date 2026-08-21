import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createBrokerTransportFrame,
  parseBrokerTransportFrame,
  type BrokerTransportFrameInput,
  type BrokerTransportFrameMaterialization,
} from '@cb/creator-agent-protocol/broker-transport';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type RawData } from 'ws';
import type WebSocket from 'ws';

import { issueWorkerTransportSendable } from '../transport-authority.js';
import { createFreshWorkerDurableTransportRepository } from '../sqlite-repository.js';
import type {
  WorkerDurableTransportRepository,
  WorkerTransportConnectionCursor,
  WorkerTransportOwner,
  WorkerTransportSendable,
} from '../transport-types.js';
import { createWorkerBrokerWebSocketDriver } from '../websocket-driver.js';

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const INSTALLATION = 'installation.test';
const DEPLOYMENT = 'deployment.test';
const servers: WebSocketServer[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    ),
  );
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe('Worker Broker WebSocket driver', () => {
  it('becomes READY only after lease commit and persists a command before sending its ACK', async () => {
    const { owner, repository } = realRepository();
    let ackObservedAfterCommit = false;
    const endpoint = await fakeBroker((socket, request) => {
      expect(request.url).toBe('/v1/worker/connect');
      socket.send(lease('connection.1', 1).canonicalText);
      socket.on('message', (data: RawData) => {
        const outbound = parseBrokerTransportFrame(data.toString());
        if (outbound.frame.body.type === 'message.ack') {
          ackObservedAfterCommit = repository.readPendingCommands(owner).length === 1;
        }
      });
      socket.send(command('connection.1', 1, 1, 'command.1').canonicalText);
    });
    const diagnostics: string[] = [];
    const driver = createDriver(
      endpoint,
      repository,
      {
        diagnosticSink(event: string) {
          diagnostics.push(event);
          throw new Error('diagnostic failure must be isolated');
        },
      },
      owner,
    );
    await driver.start();
    await waitFor(() => ackObservedAfterCommit);
    expect(ackObservedAfterCommit).toBe(true);
    expect(diagnostics).toContain('lease_committed');
    expect(driver.status).toBe('READY');
    await driver.stop();
  });
  it('drains >4 batches, reframes WRITTEN, and reconnects on lease expiry', async () => {
    const repository = new FakeRepository();
    const received: BrokerTransportFrameMaterialization[] = [];
    const receivedOnSecond = new Set<string>();
    let connectionNumber = 0;
    const endpoint = await fakeBroker((socket) => {
      const ordinal = ++connectionNumber;
      const connectionId = `connection.${ordinal}`;
      socket.send(
        lease(connectionId, ordinal, Date.now() + (ordinal === 2 ? 500 : 60_000)).canonicalText,
      );
      socket.on('message', (data: RawData) => {
        const outbound = parseBrokerTransportFrame(data.toString());
        if (outbound.frame.body.type !== 'worker.message') return;
        received.push(outbound);
        if (ordinal === 2) receivedOnSecond.add(outbound.frame.messageId);
        if (ordinal === 1) {
          socket.terminate();
          return;
        }
        if (outbound.frame.messageId === 'delivery.replay') {
          socket.send(cloudCommit(connectionId, ordinal, outbound).canonicalText);
        }
      });
    });
    const driver = createDriver(endpoint, repository);
    await driver.start();
    repository.enqueueWorkerMessageForTest('delivery.replay');
    for (let index = 0; index < 64; index += 1)
      repository.enqueueWorkerMessageForTest(`delivery.batch.${index}`);
    await driver.flush().catch(() => undefined);
    await waitFor(() => repository.acked.size === 1 && receivedOnSecond.size === 65);
    await waitFor(() => connectionNumber >= 3);
    const replayed = received.filter((item) => item.frame.messageId === 'delivery.replay');
    expect(replayed).toHaveLength(2);
    expect(replayed[0]?.frame.connectionId).not.toBe(replayed[1]?.frame.connectionId);
    expect(replayed[0]?.wireFingerprint).not.toBe(replayed[1]?.wireFingerprint);
    expect(repository.written.length).toBeGreaterThanOrEqual(66);
    await driver.stop();
  });
  it('reconnects without ACK or cursor advance when durable command capacity is full', async () => {
    const { owner, repository } = realRepository(1);
    const acknowledged: string[] = [];
    let connections = 0;
    let sentOverflow = false;
    let retrySocket: WebSocket | undefined;
    const endpoint = await fakeBroker((socket) => {
      const ordinal = ++connections;
      const connectionId = `connection.capacity.${ordinal}`;
      if (ordinal === 2) retrySocket = socket;
      socket.send(lease(connectionId, ordinal).canonicalText);
      socket.on('message', (data: RawData) => {
        const outbound = parseBrokerTransportFrame(data.toString());
        if (outbound.frame.body.type !== 'message.ack') return;
        acknowledged.push(outbound.frame.body.acknowledgedMessageId);
        if (
          ordinal === 1 &&
          outbound.frame.body.acknowledgedMessageId === 'command.capacity.1' &&
          !sentOverflow
        ) {
          sentOverflow = true;
          socket.send(command(connectionId, ordinal, 2, 'command.capacity.2').canonicalText);
        }
      });
      if (ordinal === 1) {
        socket.send(command(connectionId, ordinal, 1, 'command.capacity.1').canonicalText);
      }
    });
    const driver = createDriver(endpoint, repository, {}, owner);
    await driver.start();
    await waitFor(
      () =>
        acknowledged.includes('command.capacity.1') &&
        connections >= 2 &&
        retrySocket !== undefined &&
        driver.status === 'READY',
    );
    expect(acknowledged).not.toContain('command.capacity.2');
    expect(
      repository.readPendingCommands(owner, 100).map((item) => item.deliveryMessageId),
    ).toEqual(['command.capacity.1']);

    repository.markCommandApplied(owner, 'command.capacity.1');
    if (retrySocket === undefined) throw new Error('Retry socket was not established.');
    retrySocket.send(command('connection.capacity.2', 2, 1, 'command.capacity.2').canonicalText);
    await waitFor(() => acknowledged.includes('command.capacity.2'));
    expect(
      repository.readPendingCommands(owner, 100).map((item) => item.deliveryMessageId),
    ).toEqual(['command.capacity.2']);
    expect(driver.status).toBe('READY');
    await driver.stop();
  });
  it.each([
    {
      label: 'malformed JSON',
      send(socket: WebSocket) {
        socket.send('{"not":"a broker frame"}');
        socket.send(lease('connection.after-malformed', 1).canonicalText);
      },
    },
    {
      label: 'binary input',
      send(socket: WebSocket) {
        socket.send(lease('connection.binary', 1).canonicalText, { binary: true });
      },
    },
    {
      label: 'invalid UTF-8',
      send(socket: WebSocket) {
        socket.send(Buffer.from([0xc3, 0x28]), { binary: false });
      },
    },
    {
      label: 'UTF-8 BOM alias',
      send(socket: WebSocket) {
        const frame = Buffer.from(lease('connection.bom', 1).canonicalText);
        socket.send(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), frame]), { binary: false });
      },
    },
    {
      label: 'oversized input',
      send(socket: WebSocket) {
        socket.send('x'.repeat(65_537));
      },
    },
  ])('blocks $label before durable activation', async ({ send }) => {
    const repository = new FakeRepository();
    const endpoint = await fakeBroker((socket) => send(socket));
    const driver = createDriver(endpoint, repository);
    await expect(driver.start()).rejects.toThrow();
    await waitFor(() => driver.status === 'BLOCKED');
    expect(repository.activationCommitted).toBe(false);
    await expect(driver.stop()).resolves.toBeUndefined();
  });
  it('keeps a prior release failure BLOCKED and never lets a later stop claim success', async () => {
    const repository = new FakeRepository();
    let brokerSocket: WebSocket | undefined;
    const endpoint = await fakeBroker((socket) => {
      brokerSocket = socket;
      socket.send(lease('connection.release-failure', 1).canonicalText);
    });
    const driver = createDriver(endpoint, repository, {
      firstLeaseTimeoutMs: 5_000,
      ownerLeaseMs: 1_000,
      ownerRenewIntervalMs: 20,
    });
    await driver.start();
    await waitFor(() => repository.renewals >= 2);
    repository.failRelease = true;
    brokerSocket?.terminate();
    await waitFor(() => driver.status === 'BLOCKED');
    const firstStop = driver.stop();
    const secondStop = driver.stop();
    expect(firstStop).toBe(secondStop);
    await expect(firstStop).rejects.toThrow('STOP_INCOMPLETE');
    expect(driver.status).toBe('BLOCKED');
    expect(repository.releases).toBe(1);
  });
  it('honors a synchronous diagnostic stop reentry within its bound', async () => {
    const repository = new FakeRepository();
    const endpoint = await fakeBroker(() => undefined);
    let reentrantStop: Promise<void> | undefined;
    const driver = createDriver(endpoint, repository, {
      diagnosticSink(event: string) {
        if (event === 'connection_attempted') reentrantStop = driver.stop();
      },
    });
    const starting = driver.start();
    void starting.catch(() => undefined);
    await waitFor(() => reentrantStop !== undefined);
    if (reentrantStop === undefined) throw new Error('Stop was not reentered.');
    expect(driver.stop()).toBe(reentrantStop);
    await expect(reentrantStop).resolves.toBeUndefined();
    await expect(starting).rejects.toThrow();
    expect(driver.status).toBe('STOPPED');
  });
  it('rejects unsafe production and non-exact loopback URLs', async () => {
    const repository = new FakeRepository();
    expect(() => createDriver('ws://example.com/v1/worker/connect', repository)).toThrow();
    expect(() => createDriver('ws://[::1]/v1/worker/connect', repository)).toThrow();
    expect(() => createDriver('ws://127.0.0.1/other', repository)).toThrow();
    expect(() => createDriver('ws://user@127.0.0.1/v1/worker/connect', repository)).toThrow();
  });
});
class FakeRepository {
  readonly owner = Object.freeze({
    storeIdentity: 'transport.test',
    epoch: 1,
  }) as WorkerTransportOwner;
  readonly written: string[] = [];
  readonly acked = new Set<string>();
  activationCommitted = false;
  inboundCommitted = false;
  renewals = 0;
  releases = 0;
  failRelease = false;
  #connection: WorkerTransportConnectionCursor | null = null;
  #nextInbound = 1;
  #nextOutbound = 1;
  #deliveries = new Map<string, FakeDelivery>();
  renewOwner(owner: WorkerTransportOwner): WorkerTransportOwner {
    if (owner !== this.owner) throw repositoryError('OWNER_STALE');
    this.renewals += 1;
    return owner;
  }
  activateLease(
    owner: WorkerTransportOwner,
    grant: BrokerTransportFrameMaterialization,
  ): WorkerTransportConnectionCursor {
    this.#assertOwner(owner);
    const { frame } = grant;
    if (frame.body.type !== 'lease.grant') throw repositoryError('LEASE_STALE');
    this.#connection = Object.freeze({
      connectionId: frame.connectionId,
      installationId: frame.installationId,
      deploymentId: frame.deploymentId,
      workerSessionId: frame.workerSessionId,
      leaseId: frame.leaseId,
      fence: frame.fence,
    }) as WorkerTransportConnectionCursor;
    this.#nextInbound = 1;
    this.#nextOutbound = 1;
    this.activationCommitted = true;
    return this.#connection;
  }
  commitInbound(
    owner: WorkerTransportOwner,
    cursor: WorkerTransportConnectionCursor,
    incoming: BrokerTransportFrameMaterialization,
  ): Readonly<{ disposition: 'APPLIED'; command: null; acknowledgement: null }> {
    this.#assertCurrent(owner, cursor);
    const { frame } = incoming;
    if (frame.sequence !== this.#nextInbound) {
      throw repositoryError(
        frame.sequence > this.#nextInbound ? 'SEQUENCE_GAP' : 'SEQUENCE_CONFLICT',
      );
    }
    this.#nextInbound += 1;
    if (frame.body.type === 'command') {
      this.inboundCommitted = true;
      this.#queue(
        {
          type: 'message.ack',
          acknowledgedMessageId: frame.messageId,
          acknowledgedSemanticFingerprint: frame.semanticFingerprint,
          acknowledgedWireFingerprint: incoming.wireFingerprint,
          level: 'PERSISTED',
          decision: 'APPLIED',
        },
        `ack.${frame.messageId}`,
      );
    } else if (frame.body.type === 'message.ack' && frame.body.level === 'CLOUD_COMMITTED') {
      const delivery = this.#deliveries.get(frame.body.acknowledgedMessageId);
      if (
        delivery === undefined ||
        delivery.materialized?.frame.semanticFingerprint !==
          frame.body.acknowledgedSemanticFingerprint ||
        delivery.materialized.wireFingerprint !== frame.body.acknowledgedWireFingerprint
      ) {
        throw repositoryError('MESSAGE_CONFLICT');
      }
      delivery.state = 'ACKED';
      this.acked.add(delivery.messageId);
    }
    return { disposition: 'APPLIED', command: null, acknowledgement: null };
  }
  prepareSendable(
    owner: WorkerTransportOwner,
    cursor: WorkerTransportConnectionCursor,
    limit = 16,
  ): readonly WorkerTransportSendable[] {
    this.#assertCurrent(owner, cursor);
    const result: WorkerTransportSendable[] = [];
    for (const delivery of this.#deliveries.values()) {
      if (result.length >= limit) break;
      if (delivery.state !== 'PENDING') continue;
      delivery.materialized = workerFrame(
        cursor,
        this.#nextOutbound,
        delivery.messageId,
        delivery.body,
      );
      this.#nextOutbound += 1;
      delivery.state = 'PREPARED';
      const materialized = delivery.materialized;
      result.push(
        issueWorkerTransportSendable({
          frameText: materialized.canonicalText,
          messageId: delivery.messageId,
          connectionId: cursor.connectionId,
          sequence: materialized.frame.sequence,
          wireFingerprint: materialized.wireFingerprint,
          assertCurrent: () => this.#assertCurrent(owner, cursor),
        }),
      );
    }
    return result;
  }
  markWireWritten(
    owner: WorkerTransportOwner,
    cursor: WorkerTransportConnectionCursor,
    sendable: WorkerTransportSendable,
  ): object {
    this.#assertCurrent(owner, cursor);
    const delivery = this.#deliveries.get(sendable.messageId);
    if (delivery?.state !== 'PREPARED') throw repositoryError('DELIVERY_STATE_INVALID');
    delivery.state = 'WRITTEN';
    this.written.push(sendable.wireFingerprint);
    if (delivery.body.type === 'message.ack' && delivery.body.level === 'PERSISTED') {
      delivery.state = 'ACKED';
    }
    return {};
  }
  enqueueWorkerMessageForTest(messageId: string): void {
    this.#queue(
      {
        type: 'worker.message',
        messageType: 'invocation.started',
        sourceId: 'fact.started',
        sourceFingerprint: DIGEST_A,
        payload: {},
      },
      messageId,
    );
  }
  releaseConnection(owner: WorkerTransportOwner, cursor: WorkerTransportConnectionCursor): void {
    this.#assertCurrent(owner, cursor);
    this.releases += 1;
    if (this.failRelease) throw repositoryError('STORE_COMMIT_UNKNOWN');
    for (const delivery of this.#deliveries.values()) {
      if (delivery.state === 'PREPARED' || delivery.state === 'WRITTEN') {
        delivery.state = 'PENDING';
        delivery.materialized = undefined;
      }
    }
    this.#connection = null;
  }
  #queue(body: BrokerTransportFrameInput['body'], messageId: string): void {
    this.#deliveries.set(messageId, { messageId, body, state: 'PENDING' });
  }
  #assertOwner(owner: WorkerTransportOwner): void {
    if (owner !== this.owner) throw repositoryError('OWNER_STALE');
  }
  #assertCurrent(owner: WorkerTransportOwner, cursor: WorkerTransportConnectionCursor): void {
    this.#assertOwner(owner);
    if (cursor !== this.#connection) throw repositoryError('CURSOR_STALE');
  }
}
type FakeDelivery = {
  messageId: string;
  body: BrokerTransportFrameInput['body'];
  state: 'PENDING' | 'PREPARED' | 'WRITTEN' | 'ACKED';
  materialized?: BrokerTransportFrameMaterialization;
};
function createDriver(
  url: string,
  repository: FakeRepository | WorkerDurableTransportRepository,
  extra: Record<string, unknown> = {},
  owner = (repository as FakeRepository).owner,
) {
  return createWorkerBrokerWebSocketDriver({
    url,
    owner,
    repository: repository as WorkerDurableTransportRepository,
    allowInsecureLoopbackForTests: true,
    connectTimeoutMs: 500,
    firstLeaseTimeoutMs: 500,
    reconnectInitialMs: 10,
    reconnectMaximumMs: 20,
    sendTimeoutMs: 500,
    stopTimeoutMs: 500,
    ...extra,
  });
}
function realRepository(maxPendingCommands = 256) {
  const created = mkdtempSync(join(tmpdir(), 'combo-r2c-driver-'));
  chmodSync(created, 0o700);
  const directory = realpathSync(created);
  const repository = createFreshWorkerDurableTransportRepository({
    filename: join(directory, 'transport.sqlite'),
    storeIdentity: 'transport.integration',
    installationId: INSTALLATION,
    maxPendingCommands,
  });
  const owner = repository.acquireOwner({ leaseMs: 30_000 });
  cleanups.push(() => {
    repository.close(owner);
    rmSync(directory, { recursive: true, force: true });
  });
  return { owner, repository };
}
function lease(
  connectionId: string,
  fence: number,
  leaseExpiresAtMs = Date.now() + 60_000,
): BrokerTransportFrameMaterialization {
  return createBrokerTransportFrame({
    ...authority(connectionId, fence),
    direction: 'CLOUD_TO_WORKER',
    sequence: 0,
    messageId: `lease.${connectionId}`,
    body: { type: 'lease.grant', leaseExpiresAtMs },
  });
}
function command(
  connectionId: string,
  fence: number,
  sequence: number,
  messageId: string,
): BrokerTransportFrameMaterialization {
  return createBrokerTransportFrame({
    ...authority(connectionId, fence),
    direction: 'CLOUD_TO_WORKER',
    sequence,
    messageId,
    body: { type: 'command', commandType: 'invocation.prepare', payload: {} },
  });
}
function cloudCommit(
  connectionId: string,
  fence: number,
  acknowledged: BrokerTransportFrameMaterialization,
): BrokerTransportFrameMaterialization {
  return createBrokerTransportFrame({
    ...authority(connectionId, fence),
    direction: 'CLOUD_TO_WORKER',
    sequence: 1,
    messageId: `cloud-ack.${acknowledged.frame.messageId}`,
    body: {
      type: 'message.ack',
      acknowledgedMessageId: acknowledged.frame.messageId,
      acknowledgedSemanticFingerprint: acknowledged.frame.semanticFingerprint,
      acknowledgedWireFingerprint: acknowledged.wireFingerprint,
      level: 'CLOUD_COMMITTED',
      decision: 'APPLIED',
    },
  });
}
function workerFrame(
  cursor: WorkerTransportConnectionCursor,
  sequence: number,
  messageId: string,
  body: BrokerTransportFrameInput['body'],
): BrokerTransportFrameMaterialization {
  return createBrokerTransportFrame({
    direction: 'WORKER_TO_CLOUD',
    connectionId: cursor.connectionId,
    sequence,
    installationId: cursor.installationId,
    deploymentId: cursor.deploymentId,
    workerSessionId: cursor.workerSessionId,
    leaseId: cursor.leaseId,
    fence: cursor.fence,
    messageId,
    body,
  });
}
function authority(connectionId: string, fence: number) {
  return {
    connectionId,
    installationId: INSTALLATION,
    deploymentId: DEPLOYMENT,
    workerSessionId: `session.${fence}`,
    leaseId: `lease.${fence}`,
    fence,
  } as const;
}
function repositoryError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
async function fakeBroker(connected: Parameters<WebSocketServer['on']>[1]): Promise<string> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
  servers.push(server);
  server.on('connection', connected);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  if (typeof address === 'string' || address === null)
    throw new Error('Fake Broker did not listen.');
  return `ws://127.0.0.1:${address.port}/v1/worker/connect`;
}
async function waitFor(assertion: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!assertion()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for driver state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
