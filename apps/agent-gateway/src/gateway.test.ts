import { once } from 'node:events';

import {
  BROKER_MAX_FRAME_BYTES,
  BrokerAuthenticationError,
  BrokerAuthenticationFailureCode,
  BrokerAckSchema,
  BrokerEnvelopeSchema,
  BrokerHandshakeSchema,
  canonicalizeJson,
  currentBrokerContractDigest,
  type BrokerAck,
  type BrokerEnvelope,
  type BrokerHandshake,
} from '@cb/creator-agent-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
  AgentGateway,
  WORKER_CONNECT_PATH,
  type AgentGatewayAuthorityPort,
  type AuthenticatedWorkerSession,
  type GatewayDelivery,
  type GatewayDisconnectReason,
} from './gateway.js';

const NOW_MS = Date.parse('2026-08-13T08:00:00.000Z');
const OWNER = '0198f00d-5000-7000-8000-000000000001';
const INSTALLATION = '0198f00d-5000-7000-8000-000000000002';
const CONNECTION_A = '0198f00d-5000-7000-8000-000000000003';
const CONNECTION_B = '0198f00d-5000-7000-8000-000000000004';
const SESSION_A = '0198f00d-5000-7000-8000-000000000005';
const SESSION_B = '0198f00d-5000-7000-8000-000000000006';
const CHALLENGE_A = '0198f00d-5000-7000-8000-000000000007';
const CHALLENGE_B = '0198f00d-5000-7000-8000-000000000008';
const DEPLOYMENT = '0198f00d-5000-7000-8000-000000000009';
const LEASE = '0198f00d-5000-7000-8000-00000000000a';
const HEARTBEAT_A = '0198f00d-5000-7000-8000-00000000000b';
const HEARTBEAT_B = '0198f00d-5000-7000-8000-00000000000c';
const ACK_A = '0198f00d-5000-7000-8000-00000000000d';
const CORRELATION = '0198f00d-5000-7000-8000-00000000000e';
const OPEN_COMMAND = '0198f00d-5000-7000-8000-000000000010';
const AGENT_VERSION = '0198f00d-5000-7000-8000-000000000011';
const ORIGINAL_LEASE = '0198f00d-5000-7000-8000-000000000012';
const REPLACEMENT_LEASE = '0198f00d-5000-7000-8000-000000000013';
const SIGNATURE = Buffer.alloc(64, 7).toString('base64url');
const PREVIOUS_BROKER_CONTRACT_DIGEST =
  'sha256:9db3770041d2da6ee3daae07c1a0a4ce05094cb3852887a72c20f4f8f2319b73';

const activeGateways = new Set<AgentGateway>();

afterEach(async () => {
  await Promise.allSettled([...activeGateways].map((gateway) => gateway.stop()));
  activeGateways.clear();
});

class FakeAuthority implements AgentGatewayAuthorityPort {
  readonly challenges = new Set([CHALLENGE_A, CHALLENGE_B]);
  readonly accepted: GatewayDelivery[] = [];
  readonly replayed: GatewayDelivery[] = [];
  durableConflicts = 0;
  readonly gaps: { expected: string; received: string }[] = [];
  readonly closed: GatewayDisconnectReason[] = [];
  readonly sessions: AuthenticatedWorkerSession[] = [];
  readonly leases: string[] = [];
  readonly lifecycleEvents: string[] = [];
  authenticateStarted = 0;
  openCalls = 0;
  abortedAuthentications = 0;
  abortedOpens = 0;
  abortedAccepts = 0;
  abortedReplays = 0;
  abortedGaps = 0;
  abortedClaims = 0;
  claimCalls = 0;
  authenticateBarrier?: Promise<void>;
  openBarrier?: Promise<void>;
  acceptBarrier?: Promise<void>;
  claimBarrier?: Promise<void>;
  authenticateCommitsAfterAbort = false;
  openCommitsAfterAbort = false;
  acceptCommitsAfterAbort = false;
  claimCommitsAfterAbort = false;
  failAccept = false;
  hangAccept = false;
  hangOpen = false;
  duplicateConnection = false;
  duplicateWorkerSession = false;
  oversizedAcceptResponse = false;
  revokeReason?: 'SECURITY' | 'IMMEDIATE';
  readonly claimFrames: BrokerEnvelope[] = [];

  async authenticate(input: {
    handshake: BrokerHandshake;
    connectedAt: string;
    signal: AbortSignal;
  }): Promise<AuthenticatedWorkerSession> {
    this.authenticateStarted += 1;
    if (input.handshake.brokerContractDigest !== currentBrokerContractDigest()) {
      throw new BrokerAuthenticationError(BrokerAuthenticationFailureCode.WORKER_INCOMPATIBLE);
    }
    if (
      input.connectedAt !== '2026-08-13T08:00:00.000Z' ||
      input.handshake.challengeSignature !== SIGNATURE ||
      !this.challenges.delete(input.handshake.challengeId)
    ) {
      throw new BrokerAuthenticationError(BrokerAuthenticationFailureCode.AUTHENTICATION_REJECTED);
    }
    if (this.authenticateBarrier !== undefined) {
      if (this.authenticateCommitsAfterAbort) await this.authenticateBarrier;
      else {
        await Promise.race([
          this.authenticateBarrier,
          abortPromise(input.signal, () => {
            this.abortedAuthentications += 1;
          }),
        ]);
      }
    }
    const index = this.sessions.length;
    const session = Object.freeze({
      ownerId: OWNER,
      installationId: input.handshake.installationId,
      connectionId: index === 0 || this.duplicateConnection ? CONNECTION_A : CONNECTION_B,
      workerSessionId: index === 0 || this.duplicateWorkerSession ? SESSION_A : SESSION_B,
    });
    this.sessions.push(session);
    this.leases.push(LEASE);
    return session;
  }

  async openSession(
    _session: AuthenticatedWorkerSession,
    signal: AbortSignal,
  ): Promise<readonly BrokerEnvelope[]> {
    this.openCalls += 1;
    this.lifecycleEvents.push('open-start');
    if (this.hangOpen) {
      return abortPromise(signal, () => {
        this.abortedOpens += 1;
        this.lifecycleEvents.push('open-abort');
      });
    }
    if (this.openBarrier !== undefined) {
      if (this.openCommitsAfterAbort) await this.openBarrier;
      else {
        await Promise.race([
          this.openBarrier,
          abortPromise(signal, () => {
            this.abortedOpens += 1;
            this.lifecycleEvents.push('open-abort');
          }),
        ]);
      }
      this.lifecycleEvents.push('open-commit');
    }
    return [];
  }

  async acceptEnvelope(
    session: AuthenticatedWorkerSession,
    delivery: GatewayDelivery,
    signal: AbortSignal,
  ): Promise<readonly BrokerEnvelope[]> {
    this.lifecycleEvents.push('accept-start');
    if (this.failAccept) throw new Error('PG_UNAVAILABLE');
    if (this.hangAccept) {
      return abortPromise(signal, () => {
        this.abortedAccepts += 1;
        this.lifecycleEvents.push('accept-abort');
      });
    }
    if (this.acceptBarrier !== undefined) {
      if (this.acceptCommitsAfterAbort) await this.acceptBarrier;
      else {
        await Promise.race([
          this.acceptBarrier,
          abortPromise(signal, () => {
            this.abortedAccepts += 1;
            this.lifecycleEvents.push('accept-abort');
          }),
        ]);
      }
      this.lifecycleEvents.push('accept-commit');
    }
    this.accepted.push(delivery);
    const response = ackFor(session, delivery.envelope);
    if (this.oversizedAcceptResponse) return Array(1_001).fill(response);
    return this.revokeReason === undefined
      ? [response]
      : [response, revokeFor(session, delivery.envelope, this.revokeReason)];
  }

  async replayEnvelope(
    session: AuthenticatedWorkerSession,
    delivery: GatewayDelivery,
    _signal: AbortSignal,
  ): Promise<readonly BrokerEnvelope[]> {
    const accepted = this.accepted.find(
      (candidate) => candidate.envelope.sequence === delivery.envelope.sequence,
    );
    if (accepted === undefined || accepted.canonicalDigest !== delivery.canonicalDigest) {
      this.durableConflicts += 1;
      throw Object.assign(new Error('SEQUENCE_CONFLICT'), { code: 'SEQUENCE_CONFLICT' });
    }
    this.replayed.push(delivery);
    return [ackFor(session, delivery.envelope)];
  }

  async claimBrokerCommand(
    session: AuthenticatedWorkerSession,
    signal: AbortSignal,
  ): Promise<BrokerEnvelope | undefined> {
    this.claimCalls += 1;
    this.lifecycleEvents.push('claim-start');
    if (this.claimBarrier !== undefined) {
      if (this.claimCommitsAfterAbort) await this.claimBarrier;
      else {
        await Promise.race([
          this.claimBarrier,
          abortPromise(signal, () => {
            this.abortedClaims += 1;
            this.lifecycleEvents.push('claim-abort');
          }),
        ]);
      }
    }
    this.lifecycleEvents.push('claim-commit');
    const frame = this.claimFrames.shift();
    if (frame === undefined) return undefined;
    expect(frame.connectionId).toBe(session.connectionId);
    expect(frame.lease.workerSessionId).toBe(session.workerSessionId);
    return frame;
  }

  async sequenceGap(
    _session: AuthenticatedWorkerSession,
    input: { expected: string; received: string },
    _signal: AbortSignal,
  ): Promise<void> {
    this.gaps.push(input);
  }

  async closeSession(
    _session: AuthenticatedWorkerSession,
    reason: GatewayDisconnectReason,
  ): Promise<void> {
    this.closed.push(reason);
    this.lifecycleEvents.push('close-commit');
  }
}

describe('AgentGateway real WebSocket transport', () => {
  it('binds an exact path and rejects browser Origin, credentials, cookies, and query variants', async () => {
    const { gateway, url } = await startGateway(new FakeAuthority());
    expect('dispatch' in gateway).toBe(false);
    const httpUrl = url.replace('ws://', 'http://').replace(WORKER_CONNECT_PATH, '/');
    const response = await fetch(httpUrl);
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');

    await expectUpgradeStatus(`${url}?token=forbidden`, {}, 403);
    await expectUpgradeStatus(url, { origin: 'https://browser.invalid' }, 403);
    await expectUpgradeStatus(url, { headers: { authorization: 'Bearer forbidden' } }, 403);
    await expectUpgradeStatus(url, { headers: { cookie: 'session=forbidden' } }, 403);
    expect(gateway.activeConnections).toBe(0);
  });

  it('enforces connection capacity before an unauthenticated socket can allocate a session', async () => {
    const { url } = await startGateway(new FakeAuthority(), { maxConnections: 1 });
    const first = await connect(url);
    await expectUpgradeStatus(url, {}, 503);
    first.terminate();
  });

  it('keeps the durable publisher disabled by default', async () => {
    const authority = new FakeAuthority();
    authority.claimFrames.push(conversationOpen(CONNECTION_A, SESSION_A, ORIGINAL_LEASE, '1'));
    const { gateway, url } = await startGateway(authority);
    const socket = await connect(url);
    socket.send(canonicalizeJson(handshake(CHALLENGE_A)));
    await waitFor(() => gateway.activeConnections === 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(authority.claimCalls).toBe(0);
  });

  it('writes a publisher frame only after the durable claim resolves', async () => {
    const authority = new FakeAuthority();
    const claim = deferred<void>();
    authority.claimBarrier = claim.promise;
    authority.claimFrames.push(conversationOpen(CONNECTION_A, SESSION_A, ORIGINAL_LEASE, '1'));
    const { gateway, url } = await startGateway(authority, {
      publisherEnabled: true,
      publisherPollIntervalMs: 30_000,
    });
    const socket = await connect(url);
    const frame = nextEnvelope(socket);
    socket.send(canonicalizeJson(handshake(CHALLENGE_A)));
    await waitFor(() => authority.lifecycleEvents.includes('claim-start'));
    const premature = await Promise.race([
      frame.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    expect(premature).toBe(false);

    claim.resolve();
    await expect(frame).resolves.toMatchObject({
      type: 'conversation.open',
      messageId: OPEN_COMMAND,
      connectionId: CONNECTION_A,
      lease: { workerSessionId: SESSION_A, leaseId: ORIGINAL_LEASE },
    });
    expect(authority.lifecycleEvents).toContain('claim-commit');
    expect(authority.claimCalls).toBe(1);
    expect(gateway.activeConnections).toBe(1);
  });

  it('retries a claimed exact frame before a long idle poll interval', async () => {
    const authority = new FakeAuthority();
    const command = conversationOpen(CONNECTION_A, SESSION_A, ORIGINAL_LEASE, '1');
    authority.claimFrames.push(command, command);
    const { url } = await startGateway(authority, {
      publisherEnabled: true,
      publisherPollIntervalMs: 30_000,
    });
    const socket = await connect(url);
    const firstFrame = nextEnvelope(socket);
    socket.send(canonicalizeJson(handshake(CHALLENGE_A)));
    await expect(within('FIRST_PUBLISH_TIMEOUT', firstFrame)).resolves.toEqual(command);

    const retryFrame = nextEnvelope(socket);
    await expect(within('NATURAL_PUBLISH_RETRY_TIMEOUT', retryFrame, 2_000)).resolves.toEqual(
      command,
    );
    expect(authority.claimCalls).toBe(2);
  });

  it('drops only the send opportunity on disconnect and reclaims on a replacement Session', async () => {
    const authority = new FakeAuthority();
    const claim = deferred<void>();
    authority.claimBarrier = claim.promise;
    authority.claimCommitsAfterAbort = true;
    const original = conversationOpen(CONNECTION_A, SESSION_A, ORIGINAL_LEASE, '1');
    const replacement = conversationOpen(CONNECTION_B, SESSION_B, REPLACEMENT_LEASE, '2');
    authority.claimFrames.push(original, replacement);
    const { url } = await startGateway(authority, {
      publisherEnabled: true,
      publisherPollIntervalMs: 30_000,
    });
    const first = await connect(url);
    const firstFrames: BrokerEnvelope[] = [];
    first.on('message', (data) => {
      firstFrames.push(
        BrokerEnvelopeSchema.parse(JSON.parse(Buffer.from(data as Buffer).toString())),
      );
    });
    first.send(canonicalizeJson(handshake(CHALLENGE_A)));
    await waitFor(() => authority.lifecycleEvents.includes('claim-start'));
    const firstClosed = once(first, 'close');
    first.close();
    await firstClosed;
    claim.resolve();
    await waitFor(() => authority.lifecycleEvents.includes('claim-commit'));
    expect(firstFrames).toEqual([]);

    const second = await connect(url);
    const replacementFrame = nextEnvelope(second);
    second.send(canonicalizeJson(handshake(CHALLENGE_B)));
    const delivered = await within('REPLACEMENT_PUBLISH_TIMEOUT', replacementFrame);
    expect(delivered.messageId).toBe(original.messageId);
    expect(delivered).toMatchObject({
      type: 'conversation.open',
      connectionId: CONNECTION_B,
      lease: { workerSessionId: SESSION_B, leaseId: REPLACEMENT_LEASE, fence: '2' },
      body: original.body,
    });
    expect(authority.claimCalls).toBe(2);
  });

  it('rejects a legacy handshake without a Broker contract digest before authority', async () => {
    const authority = new FakeAuthority();
    const { gateway, url } = await startGateway(authority);
    const socket = await connect(url);
    const legacyHandshake: Record<string, unknown> = { ...handshake(CHALLENGE_A) };
    delete legacyHandshake.brokerContractDigest;
    const close = closeResult(socket);

    socket.send(canonicalizeJson(legacyHandshake));

    await expect(close).resolves.toMatchObject({
      code: 4003,
      reason: 'AUTHENTICATION_REJECTED',
    });
    expect(authority.authenticateStarted).toBe(0);
    expect(authority.sessions).toHaveLength(0);
    expect(authority.openCalls).toBe(0);
    expect(gateway.activeConnections).toBe(0);
  });

  it('rejects the exact previous Broker digest before allocating a Session or Lease', async () => {
    const authority = new FakeAuthority();
    const { gateway, url } = await startGateway(authority);
    const socket = await connect(url);
    const close = closeResult(socket);
    const stale = BrokerHandshakeSchema.parse({
      ...handshake(CHALLENGE_A),
      brokerContractDigest: PREVIOUS_BROKER_CONTRACT_DIGEST,
    });
    expect(PREVIOUS_BROKER_CONTRACT_DIGEST).not.toBe(currentBrokerContractDigest());

    socket.send(canonicalizeJson(stale));

    await expect(close).resolves.toEqual({ code: 4003, reason: 'WORKER_INCOMPATIBLE' });
    expect(authority.authenticateStarted).toBe(1);
    expect(authority.sessions).toHaveLength(0);
    expect(authority.leases).toHaveLength(0);
    expect(authority.openCalls).toBe(0);
    expect(gateway.activeConnections).toBe(0);
  });

  it('authenticates one challenge, commits one frame, and replays the exact durable ACK', async () => {
    const authority = new FakeAuthority();
    const { gateway, url } = await startGateway(authority);
    const socket = await connect(url);
    socket.send(canonicalizeJson(handshake(CHALLENGE_A)));
    await waitFor(() => gateway.activeConnections === 1);

    const event = heartbeat(CONNECTION_A, SESSION_A, '0', HEARTBEAT_A);
    const firstAckPromise = nextEnvelope(socket);
    socket.send(canonicalizeJson(event));
    const firstAck = await within('FIRST_ACK_TIMEOUT', firstAckPromise);
    expect(BrokerAckSchema.parse(firstAck).body).toEqual({
      acknowledgedMessageId: HEARTBEAT_A,
      level: 'CLOUD_COMMITTED',
      decision: 'APPLIED',
    });
    expect(authority.accepted).toHaveLength(1);

    const replayAckPromise = nextEnvelope(socket);
    const unexpectedClose = closeResult(socket);
    socket.send(canonicalizeJson(event));
    const replayOutcome = await within(
      'REPLAY_OUTCOME_TIMEOUT',
      Promise.race([
        replayAckPromise.then((envelope) => ({ type: 'ack' as const, envelope })),
        unexpectedClose.then((close) => ({ type: 'close' as const, close })),
      ]),
    );
    expect(replayOutcome).toEqual({ type: 'ack', envelope: firstAck });
    expect(authority.accepted).toHaveLength(1);
    expect(authority.replayed).toHaveLength(1);

    const close = closeResult(socket);
    socket.send(canonicalizeJson(heartbeat(CONNECTION_A, SESSION_A, '0', HEARTBEAT_B)));
    await expect(within('CONFLICT_CLOSE_TIMEOUT', close)).resolves.toMatchObject({
      code: 4002,
      reason: 'PROTOCOL_ERROR',
    });
    expect(authority.accepted).toHaveLength(1);
    expect(authority.durableConflicts).toBe(1);
  });

  it('delegates an exact replay older than the bounded memory cursor to durable authority', async () => {
    const authority = new FakeAuthority();
    const { gateway, url } = await startGateway(authority);
    const socket = await connect(url);
    socket.send(canonicalizeJson(handshake(CHALLENGE_A)));
    await waitFor(() => gateway.activeConnections === 1);

    const first = heartbeat(CONNECTION_A, SESSION_A, '0', messageIdForSequence(0));
    for (let sequence = 0; sequence <= 1_024; sequence += 1) {
      const acknowledged = nextEnvelope(socket);
      socket.send(
        canonicalizeJson(
          heartbeat(CONNECTION_A, SESSION_A, String(sequence), messageIdForSequence(sequence)),
        ),
      );
      await acknowledged;
    }
    expect(authority.accepted).toHaveLength(1_025);

    const replay = nextEnvelope(socket);
    socket.send(canonicalizeJson(first));
    expect(BrokerAckSchema.parse(await replay).body.acknowledgedMessageId).toBe(first.messageId);
    expect(authority.replayed).toHaveLength(1);
    expect(gateway.activeConnections).toBe(1);
  });

  it('delivers a durable security revoke and closes the Worker permanently', async () => {
    const authority = new FakeAuthority();
    authority.revokeReason = 'SECURITY';
    const { gateway, url } = await startGateway(authority);
    const socket = await connect(url);
    socket.send(canonicalizeJson(handshake(CHALLENGE_A)));
    await waitFor(() => gateway.activeConnections === 1);

    const frames = nextEnvelopes(socket, 2);
    const closed = closeResult(socket);
    socket.send(canonicalizeJson(heartbeat(CONNECTION_A, SESSION_A, '0', HEARTBEAT_A)));

    const [ack, revoke] = await frames;
    expect(ack).toMatchObject({ type: 'message.ack' });
    expect(revoke).toMatchObject({ type: 'lease.revoke', body: { reason: 'SECURITY' } });
    await expect(closed).resolves.toEqual({ code: 4003, reason: 'AUTHENTICATION_REJECTED' });
    expect(gateway.activeConnections).toBe(0);
  });

  it('closes on a sequence gap without applying the later frame', async () => {
    const authority = new FakeAuthority();
    const { gateway, url } = await startGateway(authority);
    const socket = await connect(url);
    socket.send(canonicalizeJson(handshake(CHALLENGE_A)));
    await waitFor(() => gateway.activeConnections === 1);
    const close = closeResult(socket);
    socket.send(canonicalizeJson(heartbeat(CONNECTION_A, SESSION_A, '1', HEARTBEAT_A)));
    await expect(close).resolves.toMatchObject({ code: 4009, reason: 'REPLAY_REQUIRED' });
    expect(authority.gaps).toEqual([{ expected: '0', received: '1' }]);
    expect(authority.accepted).toHaveLength(0);
  });

  it('consumes each authentication challenge once and rejects its replay', async () => {
    const authority = new FakeAuthority();
    const { gateway, url } = await startGateway(authority);
    const first = await connect(url);
    first.send(canonicalizeJson(handshake(CHALLENGE_A)));
    await waitFor(() => gateway.activeConnections === 1);
    const firstClosed = once(first, 'close');
    first.close();
    await firstClosed;

    const second = await connect(url);
    const close = closeResult(second);
    second.send(canonicalizeJson(handshake(CHALLENGE_A)));
    await expect(close).resolves.toMatchObject({
      code: 4003,
      reason: 'AUTHENTICATION_REJECTED',
    });
    expect(authority.sessions).toHaveLength(1);
  });

  it('does not install a ghost session when the socket closes during authentication', async () => {
    const authority = new FakeAuthority();
    const barrier = deferred<void>();
    authority.authenticateBarrier = barrier.promise;
    const { gateway, url } = await startGateway(authority);
    const socket = await connect(url);
    socket.send(canonicalizeJson(handshake(CHALLENGE_A)));
    await waitFor(() => authority.authenticateStarted === 1);
    const closed = once(socket, 'close');
    socket.close();
    await closed;
    barrier.resolve();

    await waitFor(
      () =>
        (authority.sessions.length === 0 && authority.abortedAuthentications === 1) ||
        (authority.sessions.length === 1 && authority.closed.includes('CLIENT_CLOSED')),
    );
    if (authority.sessions.length === 0) {
      expect(authority.abortedAuthentications).toBe(1);
      expect(authority.closed).toHaveLength(0);
    } else {
      expect(authority.closed).toContain('CLIENT_CLOSED');
    }
    expect(authority.openCalls).toBe(0);
    expect(gateway.activeConnections).toBe(0);
  });

  it('rejects authority-issued connection or worker-session identifier reuse', async () => {
    for (const duplicate of ['connection', 'worker-session'] as const) {
      const authority = new FakeAuthority();
      if (duplicate === 'connection') authority.duplicateConnection = true;
      else authority.duplicateWorkerSession = true;
      const { gateway, url } = await startGateway(authority);
      const first = await connect(url);
      first.send(canonicalizeJson(handshake(CHALLENGE_A)));
      await waitFor(() => gateway.activeConnections === 1);

      const second = await connect(url);
      const rejected = closeResult(second);
      second.send(canonicalizeJson(handshake(CHALLENGE_B)));
      await expect(rejected).resolves.toMatchObject({
        code: 4003,
        reason: 'AUTHENTICATION_REJECTED',
      });
      expect(gateway.activeConnections).toBe(1);
      expect(first.readyState).toBe(WebSocket.OPEN);

      await gateway.stop();
      activeGateways.delete(gateway);
    }
  });

  it('replaces the old connection for one installation and rejects stale session frames', async () => {
    const authority = new FakeAuthority();
    const { gateway, url } = await startGateway(authority);
    const first = await connect(url);
    first.send(canonicalizeJson(handshake(CHALLENGE_A)));
    await waitFor(() => gateway.activeConnections === 1);
    const firstClose = closeResult(first);

    const second = await connect(url);
    second.send(canonicalizeJson(handshake(CHALLENGE_B)));
    await expect(firstClose).resolves.toMatchObject({
      code: 4001,
      reason: 'SESSION_REPLACED',
    });
    await waitFor(() => gateway.activeConnections === 1 && authority.sessions.length === 2);

    const secondAckPromise = nextEnvelope(second);
    second.send(canonicalizeJson(heartbeat(CONNECTION_B, SESSION_B, '0', HEARTBEAT_B)));
    expect(BrokerAckSchema.parse(await secondAckPromise).body.acknowledgedMessageId).toBe(
      HEARTBEAT_B,
    );
    expect(authority.closed).toContain('SESSION_REPLACED');
  });

  it('fails boundedly on handshake timeout, bad direction, expired frame, and authority failure', async () => {
    const authority = new FakeAuthority();
    const { gateway, url } = await startGateway(authority, { handshakeTimeoutMs: 30 });

    const idle = await connect(url);
    await expect(closeResult(idle)).resolves.toMatchObject({
      code: 4003,
      reason: 'HANDSHAKE_TIMEOUT',
    });

    const wrongDirection = await connect(url);
    wrongDirection.send(canonicalizeJson(handshake(CHALLENGE_A)));
    await waitFor(() => gateway.activeConnections === 1);
    const wrongClose = closeResult(wrongDirection);
    wrongDirection.send(
      canonicalizeJson({
        ...ackFor(authority.sessions[0]!, heartbeat(CONNECTION_A, SESSION_A, '0', HEARTBEAT_A)),
        kind: 'command',
        type: 'ping',
        body: { nonce: Buffer.alloc(16, 1).toString('base64url') },
      } as unknown as BrokerEnvelope),
    );
    await expect(wrongClose).resolves.toMatchObject({ code: 4002 });

    const expired = await connect(url);
    expired.send(canonicalizeJson(handshake(CHALLENGE_B)));
    await waitFor(() => authority.sessions.length === 2 && gateway.activeConnections === 1);
    const expiredClose = closeResult(expired);
    expired.send(
      canonicalizeJson({
        ...heartbeat(CONNECTION_B, SESSION_B, '0', HEARTBEAT_B),
        expiresAt: '2026-08-13T08:00:00.000Z',
      }),
    );
    await expect(expiredClose).resolves.toMatchObject({ code: 4002 });

    const failingAuthority = new FakeAuthority();
    failingAuthority.failAccept = true;
    const secondGateway = await startGateway(failingAuthority);
    const failing = await connect(secondGateway.url);
    failing.send(canonicalizeJson(handshake(CHALLENGE_A)));
    await waitFor(() => secondGateway.gateway.activeConnections === 1);
    const failingClose = closeResult(failing);
    failing.send(canonicalizeJson(heartbeat(CONNECTION_A, SESSION_A, '0', HEARTBEAT_A)));
    await expect(failingClose).resolves.toMatchObject({
      code: 1011,
      reason: 'AUTHORITY_FAILED',
    });
  });

  it('rejects binary, malformed, combined, and oversized frames without projecting them', async () => {
    const cases: Array<(socket: WebSocket) => void> = [
      (socket) =>
        socket.send(Buffer.from(canonicalizeJson(handshake(CHALLENGE_A))), { binary: true }),
      (socket) => socket.send('{not-json'),
      (socket) => socket.send(Buffer.from([0x22, 0x80, 0x22]), { binary: false }),
      (socket) => {
        const value = canonicalizeJson(handshake(CHALLENGE_A));
        socket.send(`${value}${value}`);
      },
      (socket) => socket.send('x'.repeat(BROKER_MAX_FRAME_BYTES + 1)),
    ];
    for (const send of cases) {
      const authority = new FakeAuthority();
      const started = await startGateway(authority);
      const socket = await connect(started.url);
      const close = closeResult(socket);
      send(socket);
      await within('MALFORMED_FRAME_CLOSE_TIMEOUT', close);
      expect(authority.accepted).toHaveLength(0);
      await started.gateway.stop();
      activeGateways.delete(started.gateway);
    }
  });

  it('accepts an exact maximum-size handshake and rejects malformed UTF-8 after authentication without authority mutation', async () => {
    const authority = new FakeAuthority();
    const started = await startGateway(authority);
    const socket = await connect(started.url);
    const handshakeJson = canonicalizeJson(handshake(CHALLENGE_A));
    const paddingBytes = BROKER_MAX_FRAME_BYTES - Buffer.byteLength(handshakeJson, 'utf8');
    expect(paddingBytes).toBeGreaterThanOrEqual(0);
    socket.send(`${handshakeJson}${' '.repeat(paddingBytes)}`);
    await waitFor(() => started.gateway.activeConnections === 1);

    const close = closeResult(socket);
    socket.send(Buffer.from([0x22, 0x80, 0x22]), { binary: false });
    await within('INVALID_UTF8_ESTABLISHED_CLOSE_TIMEOUT', close);

    expect(authority.authenticateStarted).toBe(1);
    expect(authority.sessions).toHaveLength(1);
    expect(authority.openCalls).toBe(1);
    expect(authority.accepted).toHaveLength(0);
    expect(authority.replayed).toHaveLength(0);
    expect(authority.gaps).toHaveLength(0);
  });

  it('bounds one outbound authority batch before parsing or writing its frames', async () => {
    const authority = new FakeAuthority();
    authority.oversizedAcceptResponse = true;
    const { gateway, url } = await startGateway(authority);
    const socket = await connect(url);
    socket.send(canonicalizeJson(handshake(CHALLENGE_A)));
    await waitFor(() => gateway.activeConnections === 1);
    const close = closeResult(socket);
    socket.send(canonicalizeJson(heartbeat(CONNECTION_A, SESSION_A, '0', HEARTBEAT_A)));
    await expect(close).resolves.toMatchObject({ code: 1011, reason: 'AUTHORITY_FAILED' });
  });

  it('does not let a diagnostic sink failure alter a valid connection', async () => {
    const authority = new FakeAuthority();
    const { gateway, url } = await startGateway(authority, {
      diagnosticSink: () => {
        throw new Error('DIAGNOSTIC_FAILURE');
      },
    });
    const socket = await connect(url);
    socket.send(canonicalizeJson(handshake(CHALLENGE_A)));
    await waitFor(() => gateway.activeConnections === 1);
    const ack = nextEnvelope(socket);
    socket.send(canonicalizeJson(heartbeat(CONNECTION_A, SESSION_A, '0', HEARTBEAT_A)));
    expect(BrokerAckSchema.parse(await ack).body.acknowledgedMessageId).toBe(HEARTBEAT_A);
  });

  it('closes boundedly when the durable authority does not return', async () => {
    const authority = new FakeAuthority();
    authority.hangAccept = true;
    const { gateway, url } = await startGateway(authority, { authorityTimeoutMs: 20 });
    const socket = await connect(url);
    socket.send(canonicalizeJson(handshake(CHALLENGE_A)));
    await waitFor(() => gateway.activeConnections === 1);
    const close = closeResult(socket);
    socket.send(canonicalizeJson(heartbeat(CONNECTION_A, SESSION_A, '0', HEARTBEAT_A)));
    await expect(close).resolves.toMatchObject({ code: 1011, reason: 'AUTHORITY_FAILED' });
    await waitFor(() => gateway.activeConnections === 0);
    expect(authority.abortedAccepts).toBe(1);
  });

  it('aborts envelope persistence before committing close when the client disconnects', async () => {
    const authority = new FakeAuthority();
    authority.hangAccept = true;
    const { gateway, url } = await startGateway(authority, { authorityTimeoutMs: 1_000 });
    const socket = await connect(url);
    socket.send(canonicalizeJson(handshake(CHALLENGE_A)));
    await waitFor(() => gateway.activeConnections === 1);
    socket.send(canonicalizeJson(heartbeat(CONNECTION_A, SESSION_A, '0', HEARTBEAT_A)));
    await waitFor(() => authority.lifecycleEvents.includes('accept-start'));
    const closed = once(socket, 'close');
    socket.close();
    await closed;
    await waitFor(() => authority.closed.includes('CLIENT_CLOSED'));
    expect(authority.lifecycleEvents.slice(-3)).toEqual([
      'accept-start',
      'accept-abort',
      'close-commit',
    ]);
    expect(gateway.activeConnections).toBe(0);
  });

  it('does not report a connection active before durable session open commits', async () => {
    const authority = new FakeAuthority();
    authority.hangOpen = true;
    const { gateway, url } = await startGateway(authority, { authorityTimeoutMs: 20 });
    const socket = await connect(url);
    const close = closeResult(socket);
    socket.send(canonicalizeJson(handshake(CHALLENGE_A)));
    expect(gateway.activeConnections).toBe(0);
    await expect(close).resolves.toMatchObject({ code: 1011, reason: 'AUTHORITY_FAILED' });
    expect(gateway.activeConnections).toBe(0);
    expect(authority.abortedOpens).toBe(1);
  });

  it('aborts session open before committing close when the client disconnects', async () => {
    const authority = new FakeAuthority();
    authority.hangOpen = true;
    const { gateway, url } = await startGateway(authority, { authorityTimeoutMs: 1_000 });
    const socket = await connect(url);
    socket.send(canonicalizeJson(handshake(CHALLENGE_A)));
    await waitFor(() => authority.openCalls === 1);
    const closed = once(socket, 'close');
    socket.close();
    await closed;
    await waitFor(() => authority.closed.includes('CLIENT_CLOSED'));
    expect(authority.lifecycleEvents).toEqual(['open-start', 'open-abort', 'close-commit']);
    expect(gateway.activeConnections).toBe(0);
  });

  it('aborts an authentication transaction when its hard deadline expires', async () => {
    const authority = new FakeAuthority();
    authority.authenticateBarrier = new Promise(() => undefined);
    const { gateway, url } = await startGateway(authority, { authorityTimeoutMs: 20 });
    const socket = await connect(url);
    const close = closeResult(socket);
    socket.send(canonicalizeJson(handshake(CHALLENGE_A)));
    await expect(close).resolves.toMatchObject({ code: 1011, reason: 'AUTHORITY_FAILED' });
    expect(authority.abortedAuthentications).toBe(1);
    expect(authority.sessions).toHaveLength(0);
    expect(gateway.activeConnections).toBe(0);
  });

  it('compensates a durable authentication that commits just after the hard deadline', async () => {
    const authority = new FakeAuthority();
    const barrier = deferred<void>();
    authority.authenticateBarrier = barrier.promise;
    authority.authenticateCommitsAfterAbort = true;
    const { gateway, url } = await startGateway(authority, { authorityTimeoutMs: 20 });
    const socket = await connect(url);
    const close = closeResult(socket);
    socket.send(canonicalizeJson(handshake(CHALLENGE_A)));
    await waitFor(() => authority.authenticateStarted === 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    barrier.resolve();

    await expect(close).resolves.toMatchObject({ code: 1011, reason: 'AUTHORITY_FAILED' });
    await waitFor(() => authority.closed.includes('INTERNAL_ERROR'));
    expect(authority.sessions).toHaveLength(1);
    expect(authority.openCalls).toBe(0);
    expect(gateway.activeConnections).toBe(0);
  });

  it('does not activate a Lease whose durable open commits just after its hard deadline', async () => {
    const authority = new FakeAuthority();
    const barrier = deferred<void>();
    authority.openBarrier = barrier.promise;
    authority.openCommitsAfterAbort = true;
    const { gateway, url } = await startGateway(authority, { authorityTimeoutMs: 20 });
    const socket = await connect(url);
    const close = closeResult(socket);
    socket.send(canonicalizeJson(handshake(CHALLENGE_A)));
    await waitFor(() => authority.openCalls === 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    barrier.resolve();

    await expect(close).resolves.toMatchObject({ code: 1011, reason: 'AUTHORITY_FAILED' });
    await waitFor(() => authority.closed.includes('INTERNAL_ERROR'));
    expect(authority.lifecycleEvents).toContain('open-commit');
    expect(gateway.activeConnections).toBe(0);
  });

  it('closes without sending a late ACK when envelope persistence commits after its deadline', async () => {
    const authority = new FakeAuthority();
    const barrier = deferred<void>();
    authority.acceptBarrier = barrier.promise;
    authority.acceptCommitsAfterAbort = true;
    const { gateway, url } = await startGateway(authority, { authorityTimeoutMs: 20 });
    const socket = await connect(url);
    socket.send(canonicalizeJson(handshake(CHALLENGE_A)));
    await waitFor(() => gateway.activeConnections === 1);
    const close = closeResult(socket);
    socket.send(canonicalizeJson(heartbeat(CONNECTION_A, SESSION_A, '0', HEARTBEAT_A)));
    await waitFor(() => authority.lifecycleEvents.includes('accept-start'));
    await new Promise((resolve) => setTimeout(resolve, 25));
    barrier.resolve();

    await expect(close).resolves.toMatchObject({ code: 1011, reason: 'AUTHORITY_FAILED' });
    await waitFor(() => authority.closed.includes('INTERNAL_ERROR'));
    expect(authority.lifecycleEvents).toContain('accept-commit');
    expect(authority.accepted).toHaveLength(1);
    expect(gateway.activeConnections).toBe(0);
  });

  it('bounds frames queued behind a stalled durable transaction', async () => {
    const authority = new FakeAuthority();
    authority.hangAccept = true;
    const { gateway, url } = await startGateway(authority, { authorityTimeoutMs: 1_000 });
    const socket = await connect(url);
    socket.send(canonicalizeJson(handshake(CHALLENGE_A)));
    await waitFor(() => gateway.activeConnections === 1);
    const close = closeResult(socket);
    const event = canonicalizeJson(heartbeat(CONNECTION_A, SESSION_A, '0', HEARTBEAT_A));
    for (let index = 0; index < 10; index += 1) socket.send(event);
    await expect(close).resolves.toMatchObject({ code: 4004, reason: 'TRANSPORT_CAPACITY' });
    expect(authority.accepted).toHaveLength(0);
  });

  it('coalesces concurrent start/stop and does not retain active sessions', async () => {
    const authority = new FakeAuthority();
    const gateway = new AgentGateway({ authority, host: '127.0.0.1', port: 0, now: () => NOW_MS });
    activeGateways.add(gateway);
    const [first, second] = await Promise.all([gateway.start(), gateway.start()]);
    expect(second).toEqual(first);
    const socket = await connect(`ws://${first.host}:${first.port}${first.path}`);
    socket.send(canonicalizeJson(handshake(CHALLENGE_A)));
    await waitFor(() => gateway.activeConnections === 1);
    await Promise.all([gateway.stop(), gateway.stop()]);
    expect(gateway.activeConnections).toBe(0);
    expect(authority.closed).toContain('SERVER_STOPPED');
  });

  it('closes a listener when stop races its initial start', async () => {
    const gateway = new AgentGateway({
      authority: new FakeAuthority(),
      host: '127.0.0.1',
      port: 0,
      now: () => NOW_MS,
    });
    activeGateways.add(gateway);
    const start = gateway.start();
    const stop = gateway.stop();
    await expect(start).rejects.toThrow('AGENT_GATEWAY_STOPPING');
    await expect(stop).resolves.toBeUndefined();
    expect(gateway.address).toBeUndefined();
    expect(gateway.activeConnections).toBe(0);
  });
});

function handshake(challengeId: string): BrokerHandshake {
  return BrokerHandshakeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    installationId: INSTALLATION,
    workerVersion: '0.1.0',
    supportedProtocolVersions: [1],
    codexRuntimeArtifacts: [`sha256:${'1'.repeat(64)}`],
    codexProtocolSchemaDigests: [`sha256:${'2'.repeat(64)}`],
    isolationModes: ['apple-container-v1'],
    brokerContractDigest: currentBrokerContractDigest(),
    capacity: { maxActiveConversations: 1, maxActiveTurns: 1 },
    challengeId,
    challengeSignature: SIGNATURE,
  });
}

function heartbeat(
  connectionId: string,
  workerSessionId: string,
  sequence: string,
  messageId: string,
): BrokerEnvelope {
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'event',
    messageId,
    type: 'heartbeat',
    correlationId: CORRELATION,
    connectionId,
    sequence,
    sentAt: '2026-08-13T07:59:59.000Z',
    expiresAt: '2026-08-13T08:01:00.000Z',
    lease: { deploymentId: DEPLOYMENT, leaseId: LEASE, workerSessionId, fence: '1' },
    body: {
      workerSessionId,
      runtimeReady: true,
      proxyReady: true,
      journalReady: true,
      activeInvocationId: null,
    },
  });
}

function conversationOpen(
  connectionId: string,
  workerSessionId: string,
  leaseId: string,
  fence: string,
): BrokerEnvelope {
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'command',
    type: 'conversation.open',
    messageId: OPEN_COMMAND,
    correlationId: CORRELATION,
    connectionId,
    sequence: '0',
    sentAt: '2026-08-13T08:00:00.000Z',
    expiresAt: '2026-08-13T08:01:00.000Z',
    lease: { deploymentId: DEPLOYMENT, leaseId, workerSessionId, fence },
    body: {
      conversationId: CORRELATION,
      agentVersionId: AGENT_VERSION,
      agentVersionDigest: '3'.repeat(64),
      snapshotDigest: '4'.repeat(64),
      visibleTranscriptDigest: `hmac-sha256:${'5'.repeat(64)}`,
      openAuthority: {
        deploymentId: DEPLOYMENT,
        installationId: INSTALLATION,
        workerSessionId: SESSION_A,
        leaseId: ORIGINAL_LEASE,
        fence: '1',
      },
    },
  });
}

function ackFor(session: AuthenticatedWorkerSession, inbound: BrokerEnvelope): BrokerAck {
  return BrokerAckSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'ack',
    messageId: ACK_A,
    type: 'message.ack',
    correlationId: inbound.correlationId,
    connectionId: session.connectionId,
    sequence: '0',
    sentAt: '2026-08-13T08:00:00.000Z',
    expiresAt: '2026-08-13T08:01:00.000Z',
    lease: {
      deploymentId: DEPLOYMENT,
      leaseId: LEASE,
      workerSessionId: session.workerSessionId,
      fence: '1',
    },
    body: {
      acknowledgedMessageId: inbound.messageId,
      level: 'CLOUD_COMMITTED',
      decision: 'APPLIED',
    },
  });
}

function revokeFor(
  session: AuthenticatedWorkerSession,
  inbound: BrokerEnvelope,
  reason: 'SECURITY' | 'IMMEDIATE',
): BrokerEnvelope {
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'command',
    messageId: '0198f00d-5000-7000-8000-00000000000f',
    type: 'lease.revoke',
    correlationId: inbound.correlationId,
    connectionId: session.connectionId,
    sequence: '1',
    sentAt: '2026-08-13T08:00:00.000Z',
    expiresAt: '2026-08-13T08:01:00.000Z',
    lease: {
      deploymentId: DEPLOYMENT,
      leaseId: LEASE,
      workerSessionId: session.workerSessionId,
      fence: '1',
    },
    body: { reason, effectiveAt: '2026-08-13T08:00:00.000Z' },
  });
}

function messageIdForSequence(sequence: number): string {
  return `0198f00d-5000-7000-8000-${sequence.toString(16).padStart(12, '0')}`;
}

async function startGateway(
  authority: FakeAuthority,
  overrides: Partial<ConstructorParameters<typeof AgentGateway>[0]> = {},
): Promise<{ gateway: AgentGateway; url: string }> {
  const gateway = new AgentGateway({
    authority,
    host: '127.0.0.1',
    port: 0,
    now: () => NOW_MS,
    ...overrides,
  });
  activeGateways.add(gateway);
  const address = await gateway.start();
  return {
    gateway,
    url: `ws://${address.host}:${address.port}${address.path}`,
  };
}

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { perMessageDeflate: false });
  await once(socket, 'open');
  return socket;
}

async function nextEnvelope(socket: WebSocket): Promise<BrokerEnvelope> {
  const [data, isBinary] = (await once(socket, 'message')) as [Buffer, boolean];
  expect(isBinary).toBe(false);
  return BrokerEnvelopeSchema.parse(JSON.parse(data.toString('utf8')));
}

function nextEnvelopes(socket: WebSocket, count: number): Promise<BrokerEnvelope[]> {
  return new Promise((resolve, reject) => {
    const frames: BrokerEnvelope[] = [];
    const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
      if (isBinary) {
        cleanup();
        reject(new Error('unexpected binary Gateway frame'));
        return;
      }
      try {
        frames.push(BrokerEnvelopeSchema.parse(JSON.parse(Buffer.from(data as Buffer).toString())));
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      if (frames.length === count) {
        cleanup();
        resolve(frames);
      }
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('Gateway socket closed before all frames arrived'));
    };
    const cleanup = (): void => {
      socket.off('message', onMessage);
      socket.off('close', onClose);
    };
    socket.on('message', onMessage);
    socket.on('close', onClose);
  });
}

function closeResult(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
  });
}

async function expectUpgradeStatus(
  url: string,
  options: ConstructorParameters<typeof WebSocket>[2],
  expectedStatus: number,
): Promise<void> {
  const socket = new WebSocket(url, [], { perMessageDeflate: false, ...options });
  socket.on('error', () => undefined);
  const status = await new Promise<number>((resolve) => {
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
  });
  expect(status).toBe(expectedStatus);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('WAIT_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function within<T>(label: string, promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(label)), timeoutMs);
      timer.unref();
    }),
  ]);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function abortPromise<T>(signal: AbortSignal, onAbort: () => void): Promise<T> {
  return new Promise((_resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(signal.reason instanceof Error ? signal.reason : new Error('ABORTED'));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
