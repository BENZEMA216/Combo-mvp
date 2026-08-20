import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';

import {
  BrokerEnvelopeSchema,
  BrokerHandshakeUnsignedSchema,
  brokerHandshakeSigningBytes,
  canonicalSha256,
  currentBrokerContractDigest,
  workerConversationReadyFactDigest,
  type BrokerEnvelope,
  type BrokerHandshake,
} from '@cb/creator-agent-protocol';
import {
  type AssistantMessageSealer,
  type PostgresCloudJournal,
} from '@cb/creator-agent-persistence';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PostgresAgentGatewayAuthority,
  toGatewayPool,
  type GatewayCompatibilityPolicy,
} from './postgres-authority.js';
import { PostgresGatewayBusinessEventProjector } from './postgres-business-event-projector.js';
import type { AuthenticatedWorkerSession, GatewayDelivery } from './gateway.js';

const databaseUrl = process.env.DATABASE_URL;
const apiPassword = process.env.POSTGRES_AGENT_API_PASSWORD;
const brokerPassword = process.env.POSTGRES_AGENT_BROKER_PASSWORD;
const enabled =
  process.env.CREATOR_AGENT_GATEWAY_PG_TEST === '1' &&
  Boolean(databaseUrl && apiPassword && brokerPassword);
const pgDescribe = enabled ? describe.sequential : describe.skip;

const WORKER_VERSION = 'combo-worker-ready-vertical/1';
const RUNTIME_DIGEST = `sha256:${'a'.repeat(64)}`;
const PROTOCOL_DIGEST = `sha256:${'b'.repeat(64)}`;
const BROKER_CONTRACT_DIGEST = currentBrokerContractDigest();
const TEST_RUNTIME_POLICY = Object.freeze({
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

function randomUuidV7(): string {
  const value = randomUUID();
  return `${value.slice(0, 14)}7${value.slice(15)}`;
}

function digest(marker: string): string {
  return marker.repeat(64);
}

function creatorAccount(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return `creator-${[...randomBytes(8)].map((value) => alphabet[value % 32]).join('')}`;
}

function roleUrl(role: 'combo_agent_api' | 'combo_agent_broker', password: string): string {
  const url = new URL(databaseUrl ?? 'postgresql://invalid:invalid@127.0.0.1:1/invalid');
  url.username = role;
  url.password = password;
  return url.toString();
}

function publicPoint(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new Error('P-256 public key did not expose affine coordinates');
  }
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  if (x.byteLength !== 32 || y.byteLength !== 32) throw new Error('invalid P-256 point');
  return Buffer.concat([Buffer.from([0x04]), x, y]);
}

function signedHandshake(
  privateKey: KeyObject,
  installationId: string,
  challengeId: string,
): BrokerHandshake {
  const unsigned = BrokerHandshakeUnsignedSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    installationId,
    workerVersion: WORKER_VERSION,
    supportedProtocolVersions: [1],
    codexRuntimeArtifacts: [RUNTIME_DIGEST],
    codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
    isolationModes: ['apple-container-v1'],
    brokerContractDigest: BROKER_CONTRACT_DIGEST,
    capacity: { maxActiveConversations: 1, maxActiveTurns: 1 },
    challengeId,
  });
  return {
    ...unsigned,
    challengeSignature: sign('sha256', brokerHandshakeSigningBytes(unsigned), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url'),
  };
}

function delivery(envelope: BrokerEnvelope): GatewayDelivery {
  return Object.freeze({ envelope, canonicalDigest: canonicalSha256(envelope) });
}

pgDescribe('Gateway -> Cloud conversation.ready reconnect vertical', () => {
  const owner = new Client({ connectionString: databaseUrl });
  const apiPool = new Pool({
    connectionString: roleUrl('combo_agent_api', apiPassword ?? 'invalid'),
    max: 2,
  });
  const brokerPool = new Pool({
    connectionString: roleUrl('combo_agent_broker', brokerPassword ?? 'invalid'),
    max: 4,
  });
  const policy: GatewayCompatibilityPolicy = {
    acceptedWorkerVersions: [WORKER_VERSION],
    acceptedCodexRuntimeArtifacts: [RUNTIME_DIGEST],
    acceptedCodexProtocolSchemaDigests: [PROTOCOL_DIGEST],
    acceptedIsolationModes: ['apple-container-v1'],
    acceptedBrokerContractDigests: [BROKER_CONTRACT_DIGEST],
    sessionTtlMs: 15 * 60_000,
    leaseTtlMs: 30_000,
    responseTtlMs: 30_000,
    transactionTimeoutMs: 2_000,
  };
  const lifecycle = {
    projectPrepared: async () => {
      throw new Error('invocation projector must not run in ready vertical');
    },
    projectStarted: async () => {
      throw new Error('invocation projector must not run in ready vertical');
    },
    projectSuccess: async () => {
      throw new Error('invocation projector must not run in ready vertical');
    },
    projectFailed: async () => {
      throw new Error('invocation projector must not run in ready vertical');
    },
    projectCancelled: async () => {
      throw new Error('invocation projector must not run in ready vertical');
    },
  } satisfies Pick<
    PostgresCloudJournal,
    'projectPrepared' | 'projectStarted' | 'projectSuccess' | 'projectFailed' | 'projectCancelled'
  >;
  const unavailableSealer: AssistantMessageSealer = () => {
    throw new Error('terminal sealer must not run in ready vertical');
  };
  const projector = new PostgresGatewayBusinessEventProjector(lifecycle, unavailableSealer);
  const authority = new PostgresAgentGatewayAuthority(
    { api: toGatewayPool(apiPool), broker: toGatewayPool(brokerPool) },
    policy,
    projector,
  );
  const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ids = {
    creator: '',
    consumer: '',
    snapshot: randomUuidV7(),
    agent: randomUuidV7(),
    version: randomUuidV7(),
    deployment: randomUuidV7(),
    installation: randomUuidV7(),
    conversation: randomUuidV7(),
    openCommand: randomUuidV7(),
    sandbox: randomUuidV7(),
  };
  let originalSession: AuthenticatedWorkerSession | undefined;
  let currentSession: AuthenticatedWorkerSession | undefined;
  let replaySession: AuthenticatedWorkerSession | undefined;
  let originalLease: Extract<BrokerEnvelope, { type: 'lease.grant' }>;
  let currentLease: Extract<BrokerEnvelope, { type: 'lease.grant' }>;
  let replayLease: Extract<BrokerEnvelope, { type: 'lease.grant' }>;

  async function connectWorker(): Promise<{
    session: AuthenticatedWorkerSession;
    lease: Extract<BrokerEnvelope, { type: 'lease.grant' }>;
  }> {
    const challenge = await authority.issueChallenge({
      creatorId: ids.creator,
      installationId: ids.installation,
      deploymentId: ids.deployment,
      deploymentGeneration: '1',
      operationId: randomUuidV7(),
      signal: AbortSignal.timeout(5_000),
    });
    const session = await authority.authenticate({
      handshake: signedHandshake(keyPair.privateKey, ids.installation, challenge.challengeId),
      connectedAt: new Date().toISOString(),
      signal: AbortSignal.timeout(5_000),
    });
    const frames = await authority.openSession(session, AbortSignal.timeout(5_000));
    const lease = frames[0];
    if (lease?.type !== 'lease.grant') throw new Error('expected lease.grant');
    return { session, lease };
  }

  async function convergeDeployment(): Promise<void> {
    await owner.query(
      `UPDATE deployments
          SET serving_version_id = desired_version_id,
              observed_state = 'ONLINE', observed_worker_id = $2,
              observed_generation = generation, updated_at = clock_timestamp()
        WHERE id = $1 AND creator_id = $3`,
      [ids.deployment, ids.installation, ids.creator],
    );
  }

  function readyEnvelope(
    session: AuthenticatedWorkerSession,
    lease: Extract<BrokerEnvelope, { type: 'lease.grant' }>,
    messageId: string,
  ): Extract<BrokerEnvelope, { type: 'conversation.ready' }> {
    const fact = Object.freeze({
      protocol: 'combo.worker-conversation-ready-fact/1',
      schemaVersion: 1,
      type: 'conversation.ready',
      sourceEventId: ids.openCommand,
      conversationId: ids.conversation,
      openCommandId: ids.openCommand,
      deploymentId: ids.deployment,
      agentVersionId: ids.version,
      agentVersionDigest: digest('7'),
      snapshotDigest: digest('1'),
      installationId: ids.installation,
      workerSessionId: originalSession!.workerSessionId,
      leaseId: originalLease.lease.leaseId,
      fence: originalLease.lease.fence,
      sandboxInstanceId: ids.sandbox,
      runtimeThreadId: 'ready-vertical-thread-1',
      readyEvidenceDigest: `sha256:${digest('e')}`,
    } as const);
    const sentAt = new Date().toISOString();
    return BrokerEnvelopeSchema.parse({
      protocol: 'combo.creator-broker/1',
      schemaVersion: 1,
      kind: 'event',
      type: 'conversation.ready',
      messageId,
      correlationId: ids.conversation,
      connectionId: session.connectionId,
      sequence: '0',
      sentAt,
      expiresAt: new Date(Date.parse(sentAt) + 30_000).toISOString(),
      lease: lease.lease,
      body: { ...fact, factDigest: workerConversationReadyFactDigest(fact) },
    }) as Extract<BrokerEnvelope, { type: 'conversation.ready' }>;
  }

  beforeAll(async () => {
    await owner.connect();
    const people = await owner.query<{ id: string }>(
      `INSERT INTO users (account) VALUES ($1), ($2) RETURNING id::text`,
      [creatorAccount(), creatorAccount()],
    );
    const creator = people.rows[0]?.id;
    const consumer = people.rows[1]?.id;
    if (creator === undefined || consumer === undefined) throw new Error('failed to seed tenants');
    ids.creator = creator;
    ids.consumer = consumer;
    await owner.query(
      `INSERT INTO context_snapshots (
         id, creator_id, snapshot_digest, archive_digest, cipher_digest,
         object_key, manifest_object_key, compressed_bytes, expanded_bytes,
         file_count, encryption_key_ref
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 128, 256, 1, $8)`,
      [
        ids.snapshot,
        ids.creator,
        digest('1'),
        digest('2'),
        digest('3'),
        `ready-vertical/${ids.snapshot}.archive.enc`,
        `ready-vertical/${ids.snapshot}.manifest.enc`,
        `kms://${ids.snapshot}`,
      ],
    );
    await owner.query(
      `INSERT INTO agents (id, creator_id, public_slug, name)
       VALUES ($1, $2, $3, 'Ready reconnect vertical')`,
      [ids.agent, ids.creator, `ready-vertical-${ids.agent.slice(0, 8)}`],
    );
    await owner.query(
      `INSERT INTO agent_versions (
         id, agent_id, creator_id, ordinal, schema_version, version_digest, snapshot_id,
         behavior_contract, behavior_contract_digest, runtime_policy, runtime_policy_digest,
         io_contract, io_contract_digest, model_policy, model_policy_digest,
         codex_runtime_version, codex_runtime_artifact_digest, codex_protocol_schema_digest
       ) VALUES (
         $1, $2, $3, 1, 1, $4, $5,
         '{}'::jsonb, $6, $7::jsonb, $8, '{}'::jsonb, $9, '{}'::jsonb, $10,
         '0.147.0-ready-vertical', $11, $12
       )`,
      [
        ids.version,
        ids.agent,
        ids.creator,
        digest('7'),
        ids.snapshot,
        digest('4'),
        JSON.stringify(TEST_RUNTIME_POLICY),
        digest('5'),
        digest('6'),
        digest('8'),
        RUNTIME_DIGEST,
        PROTOCOL_DIGEST,
      ],
    );
    await owner.query(
      `INSERT INTO agent_version_controls (version_id, creator_id)
       VALUES ($1, $2)`,
      [ids.version, ids.creator],
    );
    await owner.query(
      `INSERT INTO deployments (
         id, agent_id, creator_id, environment, desired_state, desired_version_id, generation
       ) VALUES ($1, $2, $3, 'TEST', 'ONLINE', $4, 1)`,
      [ids.deployment, ids.agent, ids.creator, ids.version],
    );
    await owner.query(
      `INSERT INTO worker_installations (
         id, creator_id, installation_key_id, device_public_key,
         worker_version, protocol_versions, capabilities
       ) VALUES ($1, $2, $3, $4, $5, '[1]'::jsonb, $6::jsonb)`,
      [
        ids.installation,
        ids.creator,
        `ready-vertical-key-${ids.installation}`,
        publicPoint(keyPair.publicKey),
        WORKER_VERSION,
        JSON.stringify({
          codexRuntimeArtifacts: [RUNTIME_DIGEST],
          codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
          isolationModes: ['apple-container-v1'],
          brokerContractDigest: BROKER_CONTRACT_DIGEST,
        }),
      ],
    );

    ({ session: originalSession, lease: originalLease } = await connectWorker());
    await owner.query(
      `INSERT INTO agent_conversations (
         id, agent_id, deployment_id, agent_version_id, creator_id,
         consumer_subject_id, idempotency_key, request_digest, version_digest,
         state, assigned_worker_id, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         'OPENING', $10, clock_timestamp() + interval '1 day'
       )`,
      [
        ids.conversation,
        ids.agent,
        ids.deployment,
        ids.version,
        ids.creator,
        ids.consumer,
        randomUuidV7(),
        digest('9'),
        digest('7'),
        ids.installation,
      ],
    );
    await owner.query(
      `INSERT INTO broker_outbox (
         command_id, creator_id, target_worker_id, consumer_subject_id,
         conversation_id, deployment_id, assignment_lease_id, assignment_fence,
         command_type, dedupe_key, state, next_attempt_at, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         'conversation.open', $9, 'SENT', clock_timestamp(),
         clock_timestamp() + interval '1 day'
       )`,
      [
        ids.openCommand,
        ids.creator,
        ids.installation,
        ids.consumer,
        ids.conversation,
        ids.deployment,
        originalLease.lease.leaseId,
        originalLease.lease.fence,
        `ready-vertical-${ids.openCommand}`,
      ],
    );
    ({ session: currentSession, lease: currentLease } = await connectWorker());
    await convergeDeployment();
  }, 30_000);

  afterAll(async () => {
    for (const session of [originalSession, currentSession, replaySession]) {
      if (session !== undefined) {
        await authority.closeSession(session, 'SERVER_STOPPED').catch(() => undefined);
      }
    }
    await Promise.all([owner.end(), apiPool.end(), brokerPool.end()]);
  });

  it('commits once, then re-envelopes the same ready fact after ACK loss and replays once', async () => {
    const firstEvent = readyEnvelope(currentSession!, currentLease, randomUuidV7());
    const firstResponses = await authority.acceptEnvelope(
      currentSession!,
      delivery(firstEvent),
      AbortSignal.timeout(5_000),
    );
    expect(firstResponses).toHaveLength(1);
    expect(firstResponses[0]).toMatchObject({
      type: 'message.ack',
      body: {
        acknowledgedMessageId: firstEvent.messageId,
        level: 'CLOUD_COMMITTED',
        decision: 'APPLIED',
      },
    });

    ({ session: replaySession, lease: replayLease } = await connectWorker());
    expect(replayLease.lease.fence).toBe('3');
    await convergeDeployment();
    const replayEvent = readyEnvelope(replaySession, replayLease, randomUuidV7());
    expect(replayEvent.messageId).not.toBe(firstEvent.messageId);
    expect(replayEvent.lease.leaseId).not.toBe(firstEvent.lease.leaseId);
    expect(replayEvent.body).toEqual(firstEvent.body);

    const replayResponses = await authority.acceptEnvelope(
      replaySession,
      delivery(replayEvent),
      AbortSignal.timeout(5_000),
    );
    expect(replayResponses).toHaveLength(1);
    expect(replayResponses[0]).toMatchObject({
      type: 'message.ack',
      body: {
        acknowledgedMessageId: replayEvent.messageId,
        level: 'CLOUD_COMMITTED',
        decision: 'IDEMPOTENT_REPLAY',
      },
    });
    await expect(
      authority.replayEnvelope(replaySession, delivery(replayEvent), AbortSignal.timeout(5_000)),
    ).resolves.toEqual(replayResponses);

    const facts = await owner.query<{
      ready_receipts: string;
      first_frame_receipts: string;
      replay_frame_receipts: string;
      first_next_seq: string;
      replay_next_seq: string;
      conversation_state: string;
      command_state: string;
      original_fence: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM conversation_ready_fact_receipts
           WHERE source_event_id = $1) AS ready_receipts,
         (SELECT count(*)::text FROM worker_gateway_frame_receipts
           WHERE session_id = $2 AND message_id = $3) AS first_frame_receipts,
         (SELECT count(*)::text FROM worker_gateway_frame_receipts
           WHERE session_id = $4 AND message_id = $5) AS replay_frame_receipts,
         first_session.inbound_next_seq::text AS first_next_seq,
         replay_session.inbound_next_seq::text AS replay_next_seq,
         conversation.state AS conversation_state,
         command.state AS command_state,
         receipt.original_fence::text AS original_fence
       FROM worker_gateway_sessions AS first_session
       JOIN worker_gateway_sessions AS replay_session ON replay_session.id = $4
       JOIN agent_conversations AS conversation ON conversation.id = $6
       JOIN broker_outbox AS command ON command.command_id = $1
       JOIN conversation_ready_fact_receipts AS receipt ON receipt.source_event_id = $1
      WHERE first_session.id = $2`,
      [
        ids.openCommand,
        currentSession!.workerSessionId,
        firstEvent.messageId,
        replaySession.workerSessionId,
        replayEvent.messageId,
        ids.conversation,
      ],
    );
    expect(facts.rows).toEqual([
      {
        ready_receipts: '1',
        first_frame_receipts: '1',
        replay_frame_receipts: '1',
        first_next_seq: '1',
        replay_next_seq: '1',
        conversation_state: 'IDLE',
        command_state: 'ACKED',
        original_fence: '1',
      },
    ]);
  });
});
