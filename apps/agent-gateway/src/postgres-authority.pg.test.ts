import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';

import {
  BrokerAuthenticationError,
  BrokerEnvelopeSchema,
  BrokerHandshakeSchema,
  BrokerHandshakeUnsignedSchema,
  ProtocolVersionCorpusSchema,
  WORKER_INVOCATION_FACT_PROTOCOL,
  brokerSensitiveMessageAadDigest,
  brokerSensitiveMessageCipherDigest,
  brokerHandshakeSigningBytes,
  canonicalSha256,
  canonicalizeJson,
  currentBrokerContractDigest,
  parseBrokerFrame,
  workerInvocationFactDigest,
  workerInterruptReceiptDigest,
  type BrokerEnvelope,
  type BrokerHandshake,
  type BrokerSensitiveMessage,
  type WorkerInvocationFailedFact,
  type WorkerInvocationPreparedFact,
  type WorkerInvocationStartedFact,
  type WorkerInvocationSucceededFact,
  WorkerInterruptReceiptSchema,
  WORKER_INTERRUPT_RECEIPT_PROTOCOL,
  type WorkerInvocationCancelledFact,
  type WorkerInterruptReceipt,
} from '@cb/creator-agent-protocol';
import {
  PostgresCloudJournal,
  type AssistantMessageSealer,
  type JournalPool,
} from '@cb/creator-agent-persistence';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import {
  PostgresAgentGatewayAuthority,
  toGatewayPool,
  type GatewayCompatibilityPolicy,
  type GatewayConnection,
  type GatewayPool,
  type PostgresGatewayAuthorityError,
} from './postgres-authority.js';
import { PostgresGatewayBusinessEventProjector } from './postgres-business-event-projector.js';
import { AgentGateway, type AuthenticatedWorkerSession, type GatewayDelivery } from './gateway.js';

const databaseUrl = process.env.DATABASE_URL;
const apiPassword = process.env.POSTGRES_AGENT_API_PASSWORD;
const brokerPassword = process.env.POSTGRES_AGENT_BROKER_PASSWORD;
const enabled =
  process.env.CREATOR_AGENT_GATEWAY_PG_TEST === '1' &&
  Boolean(databaseUrl && apiPassword && brokerPassword);
const pgDescribe = enabled ? describe.sequential : describe.skip;

const WORKER_VERSION = 'combo-worker-gateway-pg/1';
const PREVIOUS_WORKER_VERSION = 'combo-worker-gateway-pg/0';
const RUNTIME_DIGEST = `sha256:${'a'.repeat(64)}`;
const PREVIOUS_RUNTIME_DIGEST = `sha256:${'e'.repeat(64)}`;
const PROTOCOL_DIGEST = `sha256:${'b'.repeat(64)}`;
const PREVIOUS_PROTOCOL_DIGEST = `sha256:${'d'.repeat(64)}`;
const BROKER_CONTRACT_DIGEST = currentBrokerContractDigest();
const compatibilityCorpus = readFile(
  new URL(
    '../../../packages/creator-agent-protocol/fixtures/protocol-compatibility.v1.json',
    import.meta.url,
  ),
  'utf8',
).then((text) => ProtocolVersionCorpusSchema.parse(JSON.parse(text)));
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

function digest(character: string): string {
  return character.repeat(64);
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

class CommitResponseLossPool implements GatewayPool {
  #loseNextCommit = false;

  constructor(readonly delegate: GatewayPool) {}

  arm(): void {
    if (this.#loseNextCommit) throw new Error('commit response loss already armed');
    this.#loseNextCommit = true;
  }

  async connect(): Promise<GatewayConnection> {
    const connection = await this.delegate.connect();
    let released = false;
    return {
      query: async <Row>(sql: string, parameters?: readonly unknown[], signal?: AbortSignal) => {
        if (sql !== 'COMMIT' || !this.#loseNextCommit) {
          return connection.query<Row>(sql, parameters, signal);
        }
        this.#loseNextCommit = false;
        await connection.query<Row>(sql, parameters, signal);
        connection.release(true);
        released = true;
        throw new Error('simulated socket loss after PostgreSQL COMMIT');
      },
      release: (destroy = false): void => {
        if (released) return;
        released = true;
        connection.release(destroy);
      },
    };
  }
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
  overrides: Partial<{
    workerVersion: string;
    codexRuntimeArtifacts: readonly string[];
    codexProtocolSchemaDigests: readonly string[];
    isolationModes: readonly ('apple-container-v1' | 'lima-vz-v1')[];
    brokerContractDigest: string;
    challengeSignature: string;
  }> = {},
): BrokerHandshake {
  const unsigned = BrokerHandshakeUnsignedSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    installationId,
    workerVersion: overrides.workerVersion ?? WORKER_VERSION,
    supportedProtocolVersions: [1],
    codexRuntimeArtifacts: overrides.codexRuntimeArtifacts ?? [RUNTIME_DIGEST],
    codexProtocolSchemaDigests: overrides.codexProtocolSchemaDigests ?? [PROTOCOL_DIGEST],
    isolationModes: overrides.isolationModes ?? ['apple-container-v1'],
    brokerContractDigest: overrides.brokerContractDigest ?? BROKER_CONTRACT_DIGEST,
    capacity: { maxActiveConversations: 1, maxActiveTurns: 1 },
    challengeId,
  });
  const challengeSignature =
    overrides.challengeSignature ??
    sign('sha256', brokerHandshakeSigningBytes(unsigned), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
  return BrokerHandshakeSchema.parse({ ...unsigned, challengeSignature });
}

function heartbeat(
  session: AuthenticatedWorkerSession,
  leaseGrant: Extract<BrokerEnvelope, { type: 'lease.grant' }>,
  sequence: bigint,
  messageId = randomUuidV7(),
): Extract<BrokerEnvelope, { type: 'heartbeat' }> {
  const sentAt = new Date().toISOString();
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'event',
    type: 'heartbeat',
    messageId,
    correlationId: leaseGrant.lease.deploymentId,
    connectionId: session.connectionId,
    sequence: sequence.toString(),
    sentAt,
    expiresAt: new Date(Date.parse(sentAt) + 30_000).toISOString(),
    lease: leaseGrant.lease,
    body: {
      workerSessionId: session.workerSessionId,
      runtimeReady: true,
      proxyReady: true,
      journalReady: true,
      activeInvocationId: null,
    },
  }) as Extract<BrokerEnvelope, { type: 'heartbeat' }>;
}

function leaseStatusEvent(
  type: 'lease.accepted' | 'lease.renewed',
  session: AuthenticatedWorkerSession,
  leaseGrant: Extract<BrokerEnvelope, { type: 'lease.grant' }>,
  sequence: bigint,
  leaseExpiresAt = leaseGrant.body.leaseExpiresAt,
): Extract<BrokerEnvelope, { type: 'lease.accepted' | 'lease.renewed' }> {
  const sentAt = new Date().toISOString();
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'event',
    type,
    messageId: randomUuidV7(),
    correlationId: leaseGrant.messageId,
    connectionId: session.connectionId,
    sequence: sequence.toString(),
    sentAt,
    expiresAt: new Date(Date.parse(sentAt) + 30_000).toISOString(),
    lease: leaseGrant.lease,
    body: { leaseExpiresAt },
  }) as Extract<BrokerEnvelope, { type: 'lease.accepted' | 'lease.renewed' }>;
}

function versionReady(
  session: AuthenticatedWorkerSession,
  leaseGrant: Extract<BrokerEnvelope, { type: 'lease.grant' }>,
  sequence: bigint,
): Extract<BrokerEnvelope, { type: 'version.ready' }> {
  const sentAt = new Date().toISOString();
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'event',
    type: 'version.ready',
    messageId: randomUuidV7(),
    correlationId: leaseGrant.lease.deploymentId,
    connectionId: session.connectionId,
    sequence: sequence.toString(),
    sentAt,
    expiresAt: new Date(Date.parse(sentAt) + 30_000).toISOString(),
    lease: leaseGrant.lease,
    body: {
      generation: leaseGrant.body.generation,
      agentVersionDigest: digest('7'),
      smokeAttestationDigest: `sha256:${'9'.repeat(64)}`,
    },
  }) as Extract<BrokerEnvelope, { type: 'version.ready' }>;
}

function invocationFailed(
  session: AuthenticatedWorkerSession,
  currentLease: Extract<BrokerEnvelope, { type: 'lease.grant' }>,
  sequence: bigint,
  original: {
    invocationId: string;
    agentVersionDigest: string;
    snapshotDigest: string;
    executionCapabilityDigest: string;
    leaseId: string;
    fence: string;
  },
): Extract<BrokerEnvelope, { type: 'invocation.failed' }> {
  const sentAt = new Date().toISOString();
  const fact = Object.freeze({
    protocol: 'combo.worker-invocation-fact/1',
    schemaVersion: 1,
    type: 'invocation.failed',
    sourceEventId: original.invocationId,
    invocationId: original.invocationId,
    agentVersionDigest: original.agentVersionDigest,
    snapshotDigest: original.snapshotDigest,
    executionCapabilityDigest: original.executionCapabilityDigest,
    leaseId: original.leaseId,
    fence: original.fence,
    errorCode: 'SYNTHETIC_HOST_FAILURE',
  } as const satisfies WorkerInvocationFailedFact);
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'event',
    type: 'invocation.failed',
    messageId: randomUuidV7(),
    correlationId: original.invocationId,
    connectionId: session.connectionId,
    sequence: sequence.toString(),
    sentAt,
    expiresAt: new Date(Date.parse(sentAt) + 30_000).toISOString(),
    lease: currentLease.lease,
    body: { ...fact, factDigest: workerInvocationFactDigest(fact) },
  }) as Extract<BrokerEnvelope, { type: 'invocation.failed' }>;
}

function invocationPrepared(
  session: AuthenticatedWorkerSession,
  currentLease: Extract<BrokerEnvelope, { type: 'lease.grant' }>,
  sequence: bigint,
  fact: WorkerInvocationPreparedFact,
): Extract<BrokerEnvelope, { type: 'invocation.prepared' }> {
  const sentAt = new Date().toISOString();
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'event',
    type: 'invocation.prepared',
    messageId: randomUuidV7(),
    correlationId: fact.prepareCommandId,
    connectionId: session.connectionId,
    sequence: sequence.toString(),
    sentAt,
    expiresAt: new Date(Date.parse(sentAt) + 30_000).toISOString(),
    lease: currentLease.lease,
    body: { ...fact, factDigest: workerInvocationFactDigest(fact) },
  }) as Extract<BrokerEnvelope, { type: 'invocation.prepared' }>;
}

function invocationStarted(
  session: AuthenticatedWorkerSession,
  currentLease: Extract<BrokerEnvelope, { type: 'lease.grant' }>,
  sequence: bigint,
  fact: WorkerInvocationStartedFact,
): Extract<BrokerEnvelope, { type: 'invocation.started' }> {
  const sentAt = new Date().toISOString();
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'event',
    type: 'invocation.started',
    messageId: randomUuidV7(),
    correlationId: fact.startCommandId,
    connectionId: session.connectionId,
    sequence: sequence.toString(),
    sentAt,
    expiresAt: new Date(Date.parse(sentAt) + 30_000).toISOString(),
    lease: currentLease.lease,
    body: { ...fact, factDigest: workerInvocationFactDigest(fact) },
  }) as Extract<BrokerEnvelope, { type: 'invocation.started' }>;
}

function invocationFailedFact(
  session: AuthenticatedWorkerSession,
  currentLease: Extract<BrokerEnvelope, { type: 'lease.grant' }>,
  sequence: bigint,
  fact: WorkerInvocationFailedFact,
): Extract<BrokerEnvelope, { type: 'invocation.failed' }> {
  const sentAt = new Date().toISOString();
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'event',
    type: 'invocation.failed',
    messageId: randomUuidV7(),
    correlationId: fact.invocationId,
    connectionId: session.connectionId,
    sequence: sequence.toString(),
    sentAt,
    expiresAt: new Date(Date.parse(sentAt) + 30_000).toISOString(),
    lease: currentLease.lease,
    body: { ...fact, factDigest: workerInvocationFactDigest(fact) },
  }) as Extract<BrokerEnvelope, { type: 'invocation.failed' }>;
}

function invocationSucceeded(
  session: AuthenticatedWorkerSession,
  currentLease: Extract<BrokerEnvelope, { type: 'lease.grant' }>,
  sequence: bigint,
  conversationId: string,
  fact: WorkerInvocationSucceededFact,
): Extract<BrokerEnvelope, { type: 'invocation.succeeded' }> {
  const sentAt = new Date().toISOString();
  const messageId = randomUuidV7();
  const keyId = `gateway-terminal-${messageId}`;
  const aad: BrokerSensitiveMessage['aad'] = {
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    envelopeType: 'invocation.succeeded',
    messageId,
    conversationId,
    invocationId: fact.invocationId,
    workerSessionId: session.workerSessionId,
    role: 'ASSISTANT',
    keyId,
  };
  const nonce = randomBytes(12).toString('base64url');
  const ciphertext = randomBytes(24).toString('base64url');
  const authTag = randomBytes(16).toString('base64url');
  const resultCiphertext: BrokerSensitiveMessage = {
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
  };
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'event',
    type: 'invocation.succeeded',
    messageId,
    correlationId: fact.invocationId,
    connectionId: session.connectionId,
    sequence: sequence.toString(),
    sentAt,
    expiresAt: new Date(Date.parse(sentAt) + 30_000).toISOString(),
    lease: currentLease.lease,
    body: {
      ...fact,
      factDigest: workerInvocationFactDigest(fact),
      conversationId,
      resultCiphertext,
    },
  }) as Extract<BrokerEnvelope, { type: 'invocation.succeeded' }>;
}

function cancelledInterruptReceipt(input: {
  session: AuthenticatedWorkerSession;
  fact: Omit<WorkerInvocationCancelledFact, 'interruptReceiptDigest'>;
  conversationId: string;
  agentVersionId: string;
  startCommandId: string;
  runtimeThreadId: string;
  runtimeTurnId: string;
  dispatchReceiptDigest: string;
  sandboxAttestationDigest: string;
}): WorkerInterruptReceipt {
  return WorkerInterruptReceiptSchema.parse({
    protocol: WORKER_INTERRUPT_RECEIPT_PROTOCOL,
    schemaVersion: 1,
    outcome: 'INTERRUPTED',
    evidenceAuthority: 'HOST',
    installationId: input.session.installationId,
    invocationId: input.fact.invocationId,
    conversationId: input.conversationId,
    agentVersionId: input.agentVersionId,
    agentVersionDigest: input.fact.agentVersionDigest,
    snapshotDigest: input.fact.snapshotDigest,
    leaseId: input.fact.leaseId,
    fence: input.fact.fence,
    executionCapabilityDigest: input.fact.executionCapabilityDigest,
    cancelCommandId: randomUuidV7(),
    cancelReason: 'CONSUMER_REQUEST',
    interruptNonce: randomUuidV7(),
    dispatchAttemptCount: 1,
    startCommandId: input.startCommandId,
    dispatchNonce: randomUuidV7(),
    runtimeThreadId: input.runtimeThreadId,
    runtimeTurnId: input.runtimeTurnId,
    dispatchReceiptDigest: input.dispatchReceiptDigest,
    sandboxInstanceId: randomUuidV7(),
    sandboxAttestationDigest: input.sandboxAttestationDigest,
    hostTerminalDigest: 'sha256:' + randomBytes(32).toString('hex'),
  });
}

function invocationCancelled(
  session: AuthenticatedWorkerSession,
  currentLease: Extract<BrokerEnvelope, { type: 'lease.grant' }>,
  sequence: bigint,
  fact: WorkerInvocationCancelledFact,
  interruptReceipt: WorkerInterruptReceipt,
): Extract<BrokerEnvelope, { type: 'invocation.cancelled' }> {
  const sentAt = new Date().toISOString();
  const receiptDigest = workerInterruptReceiptDigest(interruptReceipt);
  if (receiptDigest !== fact.interruptReceiptDigest) {
    throw new Error('CANCELLED_RECEIPT_DIGEST_UNBOUND');
  }
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'event',
    type: 'invocation.cancelled',
    messageId: randomUuidV7(),
    correlationId: fact.invocationId,
    connectionId: session.connectionId,
    sequence: sequence.toString(),
    sentAt,
    expiresAt: new Date(Date.parse(sentAt) + 30_000).toISOString(),
    lease: currentLease.lease,
    body: { ...fact, factDigest: workerInvocationFactDigest(fact), interruptReceipt },
  }) as Extract<BrokerEnvelope, { type: 'invocation.cancelled' }>;
}

function terminalSealer(
  resultDigest: string,
  forbiddenCipherDigest?: string,
): AssistantMessageSealer {
  return ({ aad }) => {
    let nonce: Buffer;
    let ciphertext: Buffer;
    let authTag: Buffer;
    let cipherDigest: string;
    do {
      nonce = randomBytes(12);
      ciphertext = randomBytes(24);
      authTag = randomBytes(16);
      cipherDigest = createHash('sha256')
        .update(nonce)
        .update(ciphertext)
        .update(authTag)
        .digest('hex');
    } while (cipherDigest === forbiddenCipherDigest);
    let contentDigest = `hmac-sha256:${randomBytes(32).toString('hex')}`;
    if (contentDigest === resultDigest) {
      const fallback = `hmac-sha256:${'f'.repeat(64)}`;
      contentDigest = resultDigest === fallback ? `hmac-sha256:${'e'.repeat(64)}` : fallback;
    }
    return {
      encryptedMessage: {
        algorithm: 'aes-256-gcm/v1',
        keyId: `gateway-terminal-key-${aad.messageId}`,
        nonce,
        ciphertext,
        authTag,
        cipherDigest,
        contentDigest,
        aadVersion: 1,
      },
      verifiedResultDigest: resultDigest,
    };
  };
}

function delivery(envelope: BrokerEnvelope): GatewayDelivery {
  return Object.freeze({ envelope, canonicalDigest: canonicalSha256(envelope) });
}

pgDescribe('PostgresAgentGatewayAuthority real transactions', () => {
  const owner = new Client({ connectionString: databaseUrl });
  const apiPool = new Pool({
    connectionString: roleUrl('combo_agent_api', apiPassword ?? 'invalid'),
    max: 4,
  });
  const brokerPool = new Pool({
    connectionString: roleUrl('combo_agent_broker', brokerPassword ?? 'invalid'),
    max: 8,
  });
  const apiGatewayPool = toGatewayPool(apiPool);
  const brokerGatewayPool = toGatewayPool(brokerPool);
  const pools = { api: apiGatewayPool, broker: brokerGatewayPool };
  const lossyApiPool = new CommitResponseLossPool(apiGatewayPool);
  const lossyBrokerPool = new CommitResponseLossPool(brokerGatewayPool);
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
  const authority = new PostgresAgentGatewayAuthority(pools, policy);
  const lossyAuthority = new PostgresAgentGatewayAuthority(
    { api: lossyApiPool, broker: lossyBrokerPool },
    policy,
  );
  const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ids = {
    creatorId: '',
    snapshotId: randomUuidV7(),
    agentId: randomUuidV7(),
    versionId: randomUuidV7(),
    deploymentId: randomUuidV7(),
    installationId: randomUuidV7(),
  };
  const challengeTarget = {
    deploymentId: ids.deploymentId,
    deploymentGeneration: '1',
  } as const;
  let firstHandshake: BrokerHandshake;
  let firstSession: AuthenticatedWorkerSession;
  let firstLease: Extract<BrokerEnvelope, { type: 'lease.grant' }>;
  let firstRenewal: Extract<BrokerEnvelope, { type: 'lease.grant' }>;
  let latestSession: AuthenticatedWorkerSession | undefined;

  async function seedInvocationProjectionFixture(label: string) {
    const fixture = {
      agentId: randomUuidV7(),
      versionId: randomUuidV7(),
      versionDigest: randomBytes(32).toString('hex'),
      deploymentId: randomUuidV7(),
      installationId: randomUuidV7(),
      conversationId: randomUuidV7(),
      userMessageId: randomUuidV7(),
      invocationId: randomUuidV7(),
      prepareCommandId: randomUuidV7(),
      capabilityId: randomUuidV7(),
      capabilityDigest: randomBytes(32).toString('hex'),
      requestDigest: `hmac-sha256:${randomBytes(32).toString('hex')}`,
    } as const;
    const fixtureKeyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const matchingCapabilities = JSON.stringify({
      codexRuntimeArtifacts: [RUNTIME_DIGEST],
      codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
      isolationModes: ['apple-container-v1'],
      brokerContractDigest: BROKER_CONTRACT_DIGEST,
    });
    await owner.query(
      `INSERT INTO agents (id, creator_id, public_slug, name)
       VALUES ($1, $2, $3, $4)`,
      [
        fixture.agentId,
        ids.creatorId,
        `gateway-${canonicalSha256(label).slice(0, 8)}-${fixture.agentId.slice(0, 8)}`,
        `Gateway ${label}`,
      ],
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
         '0.147.0-alpha.6.5', $11, $12
       )`,
      [
        fixture.versionId,
        fixture.agentId,
        ids.creatorId,
        fixture.versionDigest,
        ids.snapshotId,
        randomBytes(32).toString('hex'),
        JSON.stringify(TEST_RUNTIME_POLICY),
        randomBytes(32).toString('hex'),
        randomBytes(32).toString('hex'),
        randomBytes(32).toString('hex'),
        RUNTIME_DIGEST,
        PROTOCOL_DIGEST,
      ],
    );
    await owner.query(
      `INSERT INTO agent_version_controls (version_id, creator_id) VALUES ($1, $2)`,
      [fixture.versionId, ids.creatorId],
    );
    await owner.query(
      `INSERT INTO deployments (
         id, agent_id, creator_id, environment, desired_state,
         desired_version_id, generation
       ) VALUES ($1, $2, $3, 'TEST', 'ONLINE', $4, 1)`,
      [fixture.deploymentId, fixture.agentId, ids.creatorId, fixture.versionId],
    );
    await owner.query(
      `INSERT INTO worker_installations (
         id, creator_id, installation_key_id, device_public_key,
         worker_version, protocol_versions, capabilities
       ) VALUES ($1, $2, $3, $4, $5, '[1]'::jsonb, $6::jsonb)`,
      [
        fixture.installationId,
        ids.creatorId,
        `gateway-key-${fixture.installationId}`,
        publicPoint(fixtureKeyPair.publicKey),
        WORKER_VERSION,
        matchingCapabilities,
      ],
    );

    const securityPolicy = {
      ...policy,
      leaseTtlMs: 60_000,
      transactionTimeoutMs: 5_000,
    } satisfies GatewayCompatibilityPolicy;
    const bootstrapAuthority = new PostgresAgentGatewayAuthority(pools, securityPolicy);
    const challenge = await bootstrapAuthority.issueChallenge({
      creatorId: ids.creatorId,
      installationId: fixture.installationId,
      deploymentId: fixture.deploymentId,
      deploymentGeneration: '1',
      operationId: randomUuidV7(),
      signal: AbortSignal.timeout(5_000),
    });
    const session = await bootstrapAuthority.authenticate({
      handshake: signedHandshake(
        fixtureKeyPair.privateKey,
        fixture.installationId,
        challenge.challengeId,
      ),
      connectedAt: new Date().toISOString(),
      signal: AbortSignal.timeout(5_000),
    });
    const opened = await bootstrapAuthority.openSession(session, AbortSignal.timeout(5_000));
    const lease = opened[0];
    if (lease?.type !== 'lease.grant') throw new Error(`expected ${label} lease.grant`);

    const clientMessageId = randomUUID();
    await owner.query(
      `INSERT INTO agent_conversations (
         id, agent_id, deployment_id, agent_version_id, creator_id,
         consumer_subject_id, version_digest, state, assigned_worker_id,
         next_turn_no, expires_at, idempotency_key, request_digest
       ) VALUES (
         $1, $2, $3, $4, $5, $5, $6, 'BUSY', $7, 2,
         statement_timestamp() + interval '1 hour', $8, $9
       )`,
      [
        fixture.conversationId,
        fixture.agentId,
        fixture.deploymentId,
        fixture.versionId,
        ids.creatorId,
        fixture.versionDigest,
        fixture.installationId,
        randomUuidV7(),
        randomBytes(32).toString('hex'),
      ],
    );
    await owner.query('BEGIN');
    try {
      await owner.query(
        `INSERT INTO agent_messages (
           id, conversation_id, creator_id, consumer_subject_id, turn_no, role,
           client_message_id, content_algorithm, content_key_id, content_nonce,
           content_ciphertext, content_auth_tag, content_cipher_digest,
           content_digest, content_aad_version, invocation_id
         ) VALUES (
           $1, $2, $3, $3, 1, 'USER', $4, 'aes-256-gcm/v1', $5, $6, $7, $8,
           $9, $10, 1, $11
         )`,
        [
          fixture.userMessageId,
          fixture.conversationId,
          ids.creatorId,
          clientMessageId,
          `gateway-key-${fixture.userMessageId}`,
          randomBytes(12),
          randomBytes(32),
          randomBytes(16),
          randomBytes(32).toString('hex'),
          `hmac-sha256:${randomBytes(32).toString('hex')}`,
          fixture.invocationId,
        ],
      );
      await owner.query(
        `INSERT INTO agent_invocations (
           id, conversation_id, creator_id, consumer_subject_id, agent_version_id,
           user_message_id, client_message_id, request_digest, state,
           assigned_worker_id, assignment_lease_id, assignment_fence,
           execution_capability_id, execution_capability_digest,
           execution_capability_expires_at, deadline_at
         ) VALUES (
           $1, $2, $3, $3, $4, $5, $6, $7, 'DISPATCH_PENDING',
           $8, $9, $10, $11, $12,
           statement_timestamp() + interval '2 minutes 15 seconds',
           statement_timestamp() + interval '2 minutes'
         )`,
        [
          fixture.invocationId,
          fixture.conversationId,
          ids.creatorId,
          fixture.versionId,
          fixture.userMessageId,
          clientMessageId,
          fixture.requestDigest,
          fixture.installationId,
          lease.lease.leaseId,
          lease.lease.fence,
          fixture.capabilityId,
          fixture.capabilityDigest,
        ],
      );
      await owner.query('COMMIT');
    } catch (error) {
      await owner.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
    await owner.query(
      `INSERT INTO broker_outbox (
         command_id, creator_id, target_worker_id, invocation_id, consumer_subject_id,
         command_type, dedupe_key, state, attempt_count, next_attempt_at, expires_at,
         conversation_id, deployment_id, assignment_lease_id, assignment_fence,
         execution_capability_id, execution_capability_digest
       ) VALUES (
         $1, $2, $3, $4, $2, 'invocation.prepare', $5, 'SENT', 1,
         statement_timestamp(), statement_timestamp() + interval '2 minutes',
         $6, $7, $8, $9, $10, $11
       )`,
      [
        fixture.prepareCommandId,
        ids.creatorId,
        fixture.installationId,
        fixture.invocationId,
        `gateway-${label}:${fixture.invocationId}`,
        fixture.conversationId,
        fixture.deploymentId,
        lease.lease.leaseId,
        lease.lease.fence,
        fixture.capabilityId,
        fixture.capabilityDigest,
      ],
    );

    const journal = new PostgresCloudJournal({
      api: apiPool as unknown as JournalPool,
      broker: brokerPool as unknown as JournalPool,
    });
    const assistantMessageSealer = vi.fn<AssistantMessageSealer>();
    const businessProjector = new PostgresGatewayBusinessEventProjector(
      journal,
      assistantMessageSealer,
    );
    const projectingAuthority = new PostgresAgentGatewayAuthority(
      pools,
      securityPolicy,
      businessProjector,
    );
    const preparedFact = {
      protocol: WORKER_INVOCATION_FACT_PROTOCOL,
      schemaVersion: 1,
      type: 'invocation.prepared',
      sourceEventId: fixture.prepareCommandId,
      invocationId: fixture.invocationId,
      agentVersionDigest: fixture.versionDigest,
      snapshotDigest: digest('1'),
      executionCapabilityDigest: fixture.capabilityDigest,
      leaseId: lease.lease.leaseId,
      fence: lease.lease.fence,
      requestDigest: fixture.requestDigest,
      prepareCommandId: fixture.prepareCommandId,
    } as const satisfies WorkerInvocationPreparedFact;

    return {
      fixture,
      session,
      lease,
      securityPolicy,
      journal,
      assistantMessageSealer,
      businessProjector,
      projectingAuthority,
      preparedFact,
    };
  }

  async function advanceFixtureToRunning(
    seeded: Awaited<ReturnType<typeof seedInvocationProjectionFixture>>,
  ) {
    const { fixture, session, lease, projectingAuthority, preparedFact } = seeded;
    const preparedEvent = invocationPrepared(session, lease, 0n, preparedFact);
    await expect(
      projectingAuthority.acceptEnvelope(
        session,
        delivery(preparedEvent),
        AbortSignal.timeout(5_000),
      ),
    ).resolves.toMatchObject([
      {
        type: 'message.ack',
        body: { decision: 'APPLIED', level: 'CLOUD_COMMITTED' },
      },
    ]);
    const startCommand = await owner.query<{ command_id: string }>(
      `UPDATE broker_outbox
          SET state = 'SENT', attempt_count = 1, next_attempt_at = statement_timestamp()
        WHERE invocation_id = $1 AND command_type = 'invocation.start'
          AND state = 'PENDING'
      RETURNING command_id::text`,
      [fixture.invocationId],
    );
    const startCommandId = startCommand.rows[0]?.command_id;
    if (!startCommandId) throw new Error('expected one Invocation start command');
    const startedFact = {
      protocol: WORKER_INVOCATION_FACT_PROTOCOL,
      schemaVersion: 1,
      type: 'invocation.started',
      sourceEventId: startCommandId,
      invocationId: fixture.invocationId,
      agentVersionDigest: fixture.versionDigest,
      snapshotDigest: digest('1'),
      executionCapabilityDigest: fixture.capabilityDigest,
      leaseId: lease.lease.leaseId,
      fence: lease.lease.fence,
      startCommandId,
      runtimeThreadId: `thread-${fixture.invocationId}`,
      runtimeTurnId: `turn-${fixture.invocationId}`,
      dispatchReceiptDigest: `sha256:${randomBytes(32).toString('hex')}`,
      sandboxAttestationDigest: `sha256:${randomBytes(32).toString('hex')}`,
    } as const satisfies WorkerInvocationStartedFact;
    const startedEvent = invocationStarted(session, lease, 1n, startedFact);
    await expect(
      projectingAuthority.acceptEnvelope(
        session,
        delivery(startedEvent),
        AbortSignal.timeout(5_000),
      ),
    ).resolves.toMatchObject([
      {
        type: 'message.ack',
        body: { decision: 'APPLIED', level: 'CLOUD_COMMITTED' },
      },
    ]);
    return { preparedEvent, startCommandId, startedFact, startedEvent };
  }

  beforeAll(async () => {
    await owner.connect();
    const account = creatorAccount();
    const creator = await owner.query<{ id: string }>(
      `INSERT INTO users (account) VALUES ($1) RETURNING id::text`,
      [account],
    );
    const creatorId = creator.rows[0]?.id;
    if (creatorId === undefined) throw new Error('failed to seed Gateway creator');
    ids.creatorId = creatorId;
    await owner.query(
      `INSERT INTO context_snapshots (
         id, creator_id, snapshot_digest, archive_digest, cipher_digest,
         object_key, manifest_object_key, compressed_bytes, expanded_bytes,
         file_count, encryption_key_ref
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 128, 256, 1, $8)`,
      [
        ids.snapshotId,
        ids.creatorId,
        digest('1'),
        digest('2'),
        digest('3'),
        `vnext/${ids.snapshotId}.archive.enc`,
        `vnext/${ids.snapshotId}.manifest.enc`,
        `kms://${ids.snapshotId}`,
      ],
    );
    await owner.query(
      `INSERT INTO agents (id, creator_id, public_slug, name)
       VALUES ($1, $2, $3, 'Gateway PG Agent')`,
      [ids.agentId, ids.creatorId, `gateway-${ids.agentId.slice(0, 8)}`],
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
         '0.147.0-alpha.6.5', $11, $12
       )`,
      [
        ids.versionId,
        ids.agentId,
        ids.creatorId,
        digest('7'),
        ids.snapshotId,
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
      `INSERT INTO deployments (
         id, agent_id, creator_id, environment, desired_state,
         desired_version_id, generation
       ) VALUES ($1, $2, $3, 'TEST', 'ONLINE', $4, 1)`,
      [ids.deploymentId, ids.agentId, ids.creatorId, ids.versionId],
    );
    await owner.query(
      `INSERT INTO agent_version_controls (version_id, creator_id)
       VALUES ($1, $2)`,
      [ids.versionId, ids.creatorId],
    );
    await owner.query(
      `INSERT INTO worker_installations (
         id, creator_id, installation_key_id, device_public_key,
         worker_version, protocol_versions, capabilities
       ) VALUES ($1, $2, $3, $4, $5, '[1]'::jsonb, $6::jsonb)`,
      [
        ids.installationId,
        ids.creatorId,
        `gateway-key-${ids.installationId}`,
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
  });

  afterAll(async () => {
    if (latestSession !== undefined) {
      await authority.closeSession(latestSession, 'SERVER_STOPPED').catch(() => undefined);
    }
    await Promise.all([owner.end(), apiPool.end(), brokerPool.end()]);
  });

  it('consumes a real P-256 challenge and commits one connection-bound Lease', async () => {
    const challengeOperationId = randomUuidV7();
    lossyApiPool.arm();
    const challenge = await lossyAuthority.issueChallenge({
      creatorId: ids.creatorId,
      installationId: ids.installationId,
      ...challengeTarget,
      operationId: challengeOperationId,
      signal: AbortSignal.timeout(5_000),
    });
    await expect(
      authority.issueChallenge({
        creatorId: ids.creatorId,
        installationId: ids.installationId,
        ...challengeTarget,
        operationId: challengeOperationId,
        signal: AbortSignal.timeout(5_000),
      }),
    ).resolves.toEqual(challenge);
    await expect(
      authority.issueChallenge({
        creatorId: ids.creatorId,
        installationId: randomUuidV7(),
        ...challengeTarget,
        operationId: challengeOperationId,
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toMatchObject({
      code: 'OPERATION_CONFLICT',
      operationKey: challengeOperationId,
    } satisfies Partial<PostgresGatewayAuthorityError>);
    const issuedOnce = await owner.query<{ challenges: string; operations: string }>(
      `SELECT
         (SELECT count(*)::text FROM worker_auth_challenges
           WHERE creator_id = $1 AND installation_id = $2) AS challenges,
         (SELECT count(*)::text FROM worker_gateway_operation_receipts
           WHERE creator_id = $1 AND operation_kind = 'ISSUE_CHALLENGE'
             AND operation_key = $3) AS operations`,
      [ids.creatorId, ids.installationId, challengeOperationId],
    );
    expect(issuedOnce.rows).toEqual([{ challenges: '1', operations: '1' }]);
    firstHandshake = signedHandshake(keyPair.privateKey, ids.installationId, challenge.challengeId);
    lossyBrokerPool.arm();
    firstSession = await lossyAuthority.authenticate({
      handshake: firstHandshake,
      connectedAt: new Date().toISOString(),
      signal: AbortSignal.timeout(5_000),
    });
    latestSession = firstSession;
    lossyBrokerPool.arm();
    const opened = await lossyAuthority.openSession(firstSession, AbortSignal.timeout(5_000));
    expect(opened).toHaveLength(1);
    await expect(authority.openSession(firstSession, AbortSignal.timeout(5_000))).resolves.toEqual(
      opened,
    );
    const leaseGrant = opened[0];
    if (leaseGrant?.type !== 'lease.grant') throw new Error('expected lease.grant');
    firstLease = leaseGrant;
    expect(firstLease.lease.workerSessionId).toBe(firstSession.workerSessionId);
    expect(firstLease.lease.fence).toBe('1');

    const facts = await owner.query<{
      challenge_state: string;
      session_state: string;
      lease_state: string;
      lease_fence: string;
      deployment_fence: string;
    }>(
      `SELECT challenge.state AS challenge_state,
              gateway.state AS session_state,
              lease.state AS lease_state,
              lease.fence::text AS lease_fence,
              deployment.lease_fence::text AS deployment_fence
         FROM worker_gateway_sessions AS gateway
         JOIN worker_auth_challenges AS challenge ON challenge.id = gateway.challenge_id
         JOIN worker_leases AS lease ON lease.connection_id = gateway.connection_id
         JOIN deployments AS deployment ON deployment.id = lease.deployment_id
        WHERE gateway.id = $1`,
      [firstSession.workerSessionId],
    );
    expect(facts.rows).toEqual([
      {
        challenge_state: 'CONSUMED',
        session_state: 'ACTIVE',
        lease_state: 'ACTIVE',
        lease_fence: '1',
        deployment_fence: '1',
      },
    ]);

    const replayAttempts = await Promise.allSettled([
      authority.authenticate({
        handshake: firstHandshake,
        connectedAt: new Date().toISOString(),
        signal: AbortSignal.timeout(5_000),
      }),
      authority.authenticate({
        handshake: firstHandshake,
        connectedAt: new Date().toISOString(),
        signal: AbortSignal.timeout(5_000),
      }),
    ]);
    expect(replayAttempts).toHaveLength(2);
    for (const attempt of replayAttempts) {
      expect(attempt.status).toBe('rejected');
      if (attempt.status === 'rejected') {
        expect(attempt.reason).toBeInstanceOf(BrokerAuthenticationError);
      }
    }
    const replayAudit = await owner.query<{
      events: string;
      operations: string;
      reason_code: string;
    }>(
      `SELECT
         count(*)::text AS events,
         min(reason_code) AS reason_code,
         (SELECT count(*)::text FROM worker_gateway_operation_receipts
           WHERE creator_id = $1 AND operation_kind = 'AUDIT_CHALLENGE_REPLAY'
             AND operation_key = $2::text) AS operations
       FROM worker_auth_security_events
       WHERE creator_id = $1 AND challenge_id = $2::uuid
         AND event_type = 'CHALLENGE_REPLAY'`,
      [ids.creatorId, firstHandshake.challengeId],
    );
    expect(replayAudit.rows).toEqual([
      { events: '1', operations: '1', reason_code: 'CHALLENGE_ALREADY_CONSUMED' },
    ]);
    const direct = await brokerPool.query(`SELECT id FROM worker_auth_challenges`);
    expect(direct.rows).toEqual([]);
  });

  it('atomically commits heartbeat, monotonic sequence, durable ACK, and exact replay', async () => {
    await owner.query(`SELECT pg_sleep(0.01)`);
    const input = heartbeat(firstSession, firstLease, 0n);
    lossyBrokerPool.arm();
    const first = await lossyAuthority.acceptEnvelope(
      firstSession,
      delivery(input),
      AbortSignal.timeout(5_000),
    );
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({
      type: 'lease.grant',
      lease: firstLease.lease,
      body: {
        workerSessionId: firstSession.workerSessionId,
        generation: firstLease.body.generation,
      },
    });
    firstRenewal = first[0] as Extract<BrokerEnvelope, { type: 'lease.grant' }>;
    expect(Date.parse(firstRenewal.body.leaseExpiresAt)).toBeGreaterThan(
      Date.parse(firstLease.body.leaseExpiresAt),
    );
    expect(first[1]).toMatchObject({
      type: 'message.ack',
      body: {
        acknowledgedMessageId: input.messageId,
        level: 'CLOUD_COMMITTED',
        decision: 'APPLIED',
      },
    });
    const replay = await authority.replayEnvelope(
      firstSession,
      delivery(input),
      AbortSignal.timeout(5_000),
    );
    expect(replay).toEqual(first);

    const counts = await owner.query<{
      receipts: string;
      outbound: string;
      inbound_next_seq: string;
      observed_state: string;
      lease_expires_at: Date | string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM worker_gateway_frame_receipts WHERE session_id = $1) AS receipts,
         (SELECT count(*)::text FROM worker_gateway_outbound_frames WHERE session_id = $1) AS outbound,
         gateway.inbound_next_seq::text,
         deployment.observed_state,
         lease.expires_at AS lease_expires_at
       FROM worker_gateway_sessions AS gateway
       JOIN worker_leases AS lease ON lease.connection_id = gateway.connection_id
       JOIN deployments AS deployment ON deployment.id = lease.deployment_id
       WHERE gateway.id = $1`,
      [firstSession.workerSessionId],
    );
    expect(counts.rows).toHaveLength(1);
    expect(counts.rows[0]).toMatchObject({
      receipts: '1',
      outbound: '3',
      inbound_next_seq: '1',
      observed_state: 'PREPARING',
    });
    expect(new Date(counts.rows[0]?.lease_expires_at ?? 0).toISOString()).toBe(
      firstRenewal.body.leaseExpiresAt,
    );

    const conflict = BrokerEnvelopeSchema.parse({
      ...input,
      body: { ...input.body, runtimeReady: false },
    });
    await expect(
      authority.replayEnvelope(firstSession, delivery(conflict), AbortSignal.timeout(5_000)),
    ).rejects.toMatchObject({
      code: 'SEQUENCE_CONFLICT',
    } satisfies Partial<PostgresGatewayAuthorityError>);
    const conflictFacts = await owner.query<{
      security_events: string;
      inbound_next_seq: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM worker_gateway_security_events
           WHERE session_id = $1 AND sequence = 0) AS security_events,
         inbound_next_seq::text
       FROM worker_gateway_sessions
       WHERE id = $1`,
      [firstSession.workerSessionId],
    );
    expect(conflictFacts.rows).toEqual([{ security_events: '1', inbound_next_seq: '1' }]);

    const reusedMessage = BrokerEnvelopeSchema.parse({
      ...input,
      sequence: '1',
      body: { ...input.body, proxyReady: false },
    });
    await expect(
      authority.acceptEnvelope(firstSession, delivery(reusedMessage), AbortSignal.timeout(5_000)),
    ).rejects.toMatchObject({
      code: 'SEQUENCE_CONFLICT',
    } satisfies Partial<PostgresGatewayAuthorityError>);
    const messageConflictFacts = await owner.query<{
      security_events: string;
      inbound_next_seq: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM worker_gateway_security_events
           WHERE session_id = $1 AND existing_sequence = 0
             AND received_message_id = $2) AS security_events,
         inbound_next_seq::text
       FROM worker_gateway_sessions
       WHERE id = $1`,
      [firstSession.workerSessionId, input.messageId],
    );
    expect(messageConflictFacts.rows).toEqual([{ security_events: '2', inbound_next_seq: '1' }]);
  });

  it('rejects a bounded jsonb receipt that tries to add a Prompt-like field', async () => {
    const grantValidation = await owner.query<{
      valid: boolean;
      wrong_worker: boolean;
      wrong_expiry: boolean;
    }>(
      `SELECT
         creator_agent_gateway_control_frame_is_safe($1::jsonb) AS valid,
         creator_agent_gateway_control_frame_is_safe($2::jsonb) AS wrong_worker,
         creator_agent_gateway_control_frame_is_safe($3::jsonb) AS wrong_expiry`,
      [
        JSON.stringify(firstLease),
        JSON.stringify({
          ...firstLease,
          body: { ...firstLease.body, workerSessionId: randomUuidV7() },
        }),
        JSON.stringify({
          ...firstLease,
          body: {
            ...firstLease.body,
            leaseExpiresAt: new Date(
              Date.parse(firstLease.body.leaseExpiresAt) + 1_000,
            ).toISOString(),
          },
        }),
      ],
    );
    expect(grantValidation.rows).toEqual([
      { valid: true, wrong_worker: false, wrong_expiry: false },
    ]);
    const client = await apiPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await expect(
        client.query(
          `INSERT INTO worker_gateway_operation_receipts (
             creator_id, operation_kind, operation_key, request_digest,
             result_value, result_digest
           ) VALUES ($1, 'ISSUE_CHALLENGE', $2, $3, $4::jsonb, $5)`,
          [
            ids.creatorId,
            randomUuidV7(),
            digest('a'),
            JSON.stringify({ challengeId: randomUuidV7(), prompt: 'must-not-persist' }),
            digest('b'),
          ],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK');
    } finally {
      client.release(true);
    }
  });

  it('uses Cloud time to reject a newly expired frame without advancing durable sequence', async () => {
    const sentAt = new Date(Date.now() - 60_000).toISOString();
    const expired = BrokerEnvelopeSchema.parse({
      ...heartbeat(firstSession, firstLease, 1n),
      messageId: randomUuidV7(),
      sentAt,
      expiresAt: new Date(Date.parse(sentAt) + 1_000).toISOString(),
    });
    await expect(
      authority.acceptEnvelope(firstSession, delivery(expired), AbortSignal.timeout(5_000)),
    ).rejects.toMatchObject({
      code: 'MESSAGE_EXPIRED',
    } satisfies Partial<PostgresGatewayAuthorityError>);
    const facts = await owner.query<{ inbound_next_seq: string; receipts: string }>(
      `SELECT inbound_next_seq::text,
              (SELECT count(*)::text FROM worker_gateway_frame_receipts
                WHERE session_id = gateway.id) AS receipts
         FROM worker_gateway_sessions AS gateway
        WHERE id = $1`,
      [firstSession.workerSessionId],
    );
    expect(facts.rows).toEqual([{ inbound_next_seq: '1', receipts: '1' }]);
  });

  it('keeps a healthy heartbeat PREPARING until an attestation-aware projector commits readiness', async () => {
    const beforeReady = await owner.query<{ state: string; serving: string | null }>(
      `SELECT observed_state AS state, serving_version_id::text AS serving
         FROM deployments WHERE id = $1`,
      [ids.deploymentId],
    );
    expect(beforeReady.rows).toEqual([{ state: 'PREPARING', serving: null }]);
    const claimedReady = versionReady(firstSession, firstLease, 1n);
    await expect(
      authority.acceptEnvelope(firstSession, delivery(claimedReady), AbortSignal.timeout(5_000)),
    ).rejects.toMatchObject({
      code: 'BUSINESS_PROJECTOR_UNAVAILABLE',
    } satisfies Partial<PostgresGatewayAuthorityError>);
    const afterClaim = await owner.query<{
      state: string;
      serving: string | null;
      next_sequence: string;
    }>(
      `SELECT deployment.observed_state AS state,
              deployment.serving_version_id::text AS serving,
              gateway.inbound_next_seq::text AS next_sequence
         FROM deployments AS deployment
         JOIN worker_leases AS lease ON lease.deployment_id = deployment.id
         JOIN worker_gateway_sessions AS gateway ON gateway.connection_id = lease.connection_id
        WHERE deployment.id = $1 AND gateway.id = $2`,
      [ids.deploymentId, firstSession.workerSessionId],
    );
    expect(afterClaim.rows).toEqual([{ state: 'PREPARING', serving: null, next_sequence: '1' }]);
  });

  it('ACKs an exact lease renewal without extending it again or creating a grant loop', async () => {
    const before = await owner.query<{ expires_at: Date | string }>(
      `SELECT expires_at FROM worker_leases WHERE id = $1`,
      [firstRenewal.lease.leaseId],
    );
    const renewalEvent = leaseStatusEvent('lease.renewed', firstSession, firstRenewal, 1n);
    const accepted = await authority.acceptEnvelope(
      firstSession,
      delivery(renewalEvent),
      AbortSignal.timeout(5_000),
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      type: 'message.ack',
      body: {
        acknowledgedMessageId: renewalEvent.messageId,
        level: 'CLOUD_COMMITTED',
        decision: 'APPLIED',
      },
    });
    await expect(
      authority.replayEnvelope(firstSession, delivery(renewalEvent), AbortSignal.timeout(5_000)),
    ).resolves.toEqual(accepted);
    const after = await owner.query<{ expires_at: Date | string }>(
      `SELECT expires_at FROM worker_leases WHERE id = $1`,
      [firstRenewal.lease.leaseId],
    );
    expect(new Date(after.rows[0]?.expires_at ?? 0).toISOString()).toBe(
      new Date(before.rows[0]?.expires_at ?? 0).toISOString(),
    );
    const confirmedGrant = await owner.query<{
      durable_ack_level: string | null;
      ack_decision: string | null;
    }>(
      `SELECT durable_ack_level, ack_decision
         FROM worker_gateway_outbound_frames
        WHERE session_id = $1 AND message_id = $2`,
      [firstSession.workerSessionId, firstRenewal.messageId],
    );
    expect(confirmedGrant.rows).toEqual([
      { durable_ack_level: 'PERSISTED', ack_decision: 'APPLIED' },
    ]);

    const oldGrantWithCurrentExpiry = BrokerEnvelopeSchema.parse({
      ...leaseStatusEvent('lease.renewed', firstSession, firstRenewal, 2n),
      correlationId: firstLease.messageId,
    });
    await expect(
      authority.acceptEnvelope(
        firstSession,
        delivery(oldGrantWithCurrentExpiry),
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toMatchObject({ code: 'OUTBOUND_ACK_CONFLICT' });

    const unrelatedGrant = BrokerEnvelopeSchema.parse({
      ...leaseStatusEvent('lease.renewed', firstSession, firstRenewal, 2n),
      correlationId: randomUuidV7(),
    });
    await expect(
      authority.acceptEnvelope(firstSession, delivery(unrelatedGrant), AbortSignal.timeout(5_000)),
    ).rejects.toMatchObject({ code: 'OUTBOUND_ACK_CONFLICT' });

    const staleAccepted = leaseStatusEvent(
      'lease.accepted',
      firstSession,
      firstRenewal,
      2n,
      firstLease.body.leaseExpiresAt,
    );
    await expect(
      authority.acceptEnvelope(firstSession, delivery(staleAccepted), AbortSignal.timeout(5_000)),
    ).rejects.toMatchObject({ code: 'LEASE_UNAVAILABLE' });
    const rejectedFacts = await owner.query<{ inbound_next_seq: string; receipts: string }>(
      `SELECT inbound_next_seq::text,
              (SELECT count(*)::text FROM worker_gateway_frame_receipts
                WHERE session_id = gateway.id) AS receipts
         FROM worker_gateway_sessions AS gateway
        WHERE id = $1`,
      [firstSession.workerSessionId],
    );
    expect(rejectedFacts.rows).toEqual([{ inbound_next_seq: '2', receipts: '2' }]);
  });

  it('rolls back a bad signature and an abort at the exact pre-COMMIT fence', async () => {
    const challenge = await authority.issueChallenge({
      creatorId: ids.creatorId,
      installationId: ids.installationId,
      ...challengeTarget,
      operationId: randomUuidV7(),
      signal: AbortSignal.timeout(5_000),
    });
    const valid = signedHandshake(keyPair.privateKey, ids.installationId, challenge.challengeId);
    const invalid = signedHandshake(keyPair.privateKey, ids.installationId, challenge.challengeId, {
      challengeSignature: Buffer.alloc(64, 0x55).toString('base64url'),
    });
    const readInvalidFacts = () =>
      owner.query<{
        challenge_state: string;
        deployment_state: string;
        security_events: string;
        sessions: string;
        leases: string;
      }>(
        `SELECT challenge.state AS challenge_state,
                deployment.observed_state AS deployment_state,
                (SELECT count(*)::text FROM worker_auth_security_events
                  WHERE challenge_id = challenge.id) AS security_events,
                (SELECT count(*)::text FROM worker_gateway_sessions
                  WHERE challenge_id = challenge.id) AS sessions,
                (SELECT count(*)::text FROM worker_leases
                  WHERE worker_id = challenge.installation_id AND state = 'ACTIVE') AS leases
           FROM worker_auth_challenges AS challenge
           JOIN deployments AS deployment ON deployment.id = challenge.deployment_id
          WHERE challenge.id = $1`,
        [challenge.challengeId],
      );
    const invalidFactsBefore = await readInvalidFacts();
    expect(invalidFactsBefore.rows).toMatchObject([
      { challenge_state: 'ISSUED', security_events: '0', sessions: '0' },
    ]);
    await expect(
      authority.authenticate({
        handshake: invalid,
        connectedAt: new Date().toISOString(),
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toBeInstanceOf(BrokerAuthenticationError);
    const invalidFactsAfter = await readInvalidFacts();
    expect(invalidFactsAfter.rows).toEqual(invalidFactsBefore.rows);

    let entered!: () => void;
    let release!: () => void;
    const atCommit = new Promise<void>((resolve) => (entered = resolve));
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const abortingAuthority = new PostgresAgentGatewayAuthority(
      pools,
      policy,
      undefined,
      async (step) => {
        if (step !== 'BEFORE_COMMIT') return;
        entered();
        await barrier;
      },
    );
    const controller = new AbortController();
    const pending = abortingAuthority.authenticate({
      handshake: valid,
      connectedAt: new Date().toISOString(),
      signal: controller.signal,
    });
    await atCommit;
    controller.abort(new Error('test transport closed'));
    release();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    const rolledBack = await owner.query<{ challenge_state: string; sessions: string }>(
      `SELECT challenge.state AS challenge_state,
              (SELECT count(*)::text FROM worker_gateway_sessions WHERE challenge_id = challenge.id) AS sessions
         FROM worker_auth_challenges AS challenge
        WHERE challenge.id = $1`,
      [challenge.challengeId],
    );
    expect(rolledBack.rows).toEqual([{ challenge_state: 'ISSUED', sessions: '0' }]);
  });

  it('rejects both creator A to installation B and device key A to challenge B', async () => {
    const otherKeyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const otherInstallationId = randomUuidV7();
    const otherCreator = await owner.query<{ id: string }>(
      `INSERT INTO users (account) VALUES ($1) RETURNING id::text`,
      [creatorAccount()],
    );
    const otherCreatorId = otherCreator.rows[0]?.id;
    if (otherCreatorId === undefined) throw new Error('failed to seed second creator');
    await owner.query(
      `INSERT INTO worker_installations (
         id, creator_id, installation_key_id, device_public_key,
         worker_version, protocol_versions, capabilities
       ) VALUES ($1, $2, $3, $4, $5, '[1]'::jsonb, $6::jsonb)`,
      [
        otherInstallationId,
        otherCreatorId,
        `gateway-key-${otherInstallationId}`,
        publicPoint(otherKeyPair.publicKey),
        WORKER_VERSION,
        JSON.stringify({
          codexRuntimeArtifacts: [RUNTIME_DIGEST],
          codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
          isolationModes: ['apple-container-v1'],
          brokerContractDigest: BROKER_CONTRACT_DIGEST,
        }),
      ],
    );

    await expect(
      authority.issueChallenge({
        creatorId: ids.creatorId,
        installationId: otherInstallationId,
        ...challengeTarget,
        operationId: randomUuidV7(),
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toBeDefined();
    const otherChallenge = await authority.issueChallenge({
      creatorId: ids.creatorId,
      installationId: ids.installationId,
      ...challengeTarget,
      operationId: randomUuidV7(),
      signal: AbortSignal.timeout(5_000),
    });
    await expect(
      authority.authenticate({
        handshake: signedHandshake(
          keyPair.privateKey,
          otherInstallationId,
          otherChallenge.challengeId,
        ),
        connectedAt: new Date().toISOString(),
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toBeInstanceOf(BrokerAuthenticationError);
    const isolation = await owner.query<{ state: string; sessions: string }>(
      `SELECT state,
              (SELECT count(*)::text FROM worker_gateway_sessions
                WHERE installation_id = $2) AS sessions
         FROM worker_auth_challenges
        WHERE id = $1`,
      [otherChallenge.challengeId, otherInstallationId],
    );
    expect(isolation.rows).toEqual([{ state: 'ISSUED', sessions: '0' }]);
  });

  it('replaces the prior session, advances Fence, and rejects the old connection forever', async () => {
    const challenge = await authority.issueChallenge({
      creatorId: ids.creatorId,
      installationId: ids.installationId,
      ...challengeTarget,
      operationId: randomUuidV7(),
      signal: AbortSignal.timeout(5_000),
    });
    const nextHandshake = signedHandshake(
      keyPair.privateKey,
      ids.installationId,
      challenge.challengeId,
    );
    const nextSession = await authority.authenticate({
      handshake: nextHandshake,
      connectedAt: new Date().toISOString(),
      signal: AbortSignal.timeout(5_000),
    });
    latestSession = nextSession;
    const nextOpened = await authority.openSession(nextSession, AbortSignal.timeout(5_000));
    const nextLease = nextOpened[0];
    if (nextLease?.type !== 'lease.grant') throw new Error('expected replacement lease.grant');
    expect(nextLease.lease.fence).toBe('2');

    await expect(
      authority.acceptEnvelope(
        firstSession,
        delivery(heartbeat(firstSession, firstLease, 2n)),
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toMatchObject({
      code: 'LEASE_UNAVAILABLE',
    } satisfies Partial<PostgresGatewayAuthorityError>);
    await authority.closeSession(firstSession, 'CLIENT_CLOSED');

    const replacementHeartbeat = heartbeat(nextSession, nextLease, 0n);
    await expect(
      authority.acceptEnvelope(
        nextSession,
        delivery(replacementHeartbeat),
        AbortSignal.timeout(5_000),
      ),
    ).resolves.toHaveLength(2);
    const states = await owner.query<{
      state: string;
      lease_state: string | null;
      fence: string | null;
    }>(
      `SELECT gateway.state, lease.state AS lease_state, lease.fence::text
         FROM worker_gateway_sessions AS gateway
         LEFT JOIN worker_leases AS lease ON lease.connection_id = gateway.connection_id
        WHERE gateway.installation_id = $1
        ORDER BY gateway.connected_at, gateway.id`,
      [ids.installationId],
    );
    expect(states.rows).toEqual([
      { state: 'REPLACED', lease_state: 'REVOKED', fence: '1' },
      { state: 'ACTIVE', lease_state: 'ACTIVE', fence: '2' },
    ]);
  });

  it('separates current transport authority from an old Invocation execution fact', async () => {
    const fixture = {
      snapshotDigest: digest('1'),
      agentId: randomUuidV7(),
      otherAgentId: randomUuidV7(),
      healthyVersionId: randomUuidV7(),
      healthyVersionDigest: randomBytes(32).toString('hex'),
      securityVersionId: randomUuidV7(),
      securityVersionDigest: randomBytes(32).toString('hex'),
      otherVersionId: randomUuidV7(),
      otherVersionDigest: randomBytes(32).toString('hex'),
      deploymentId: randomUuidV7(),
      otherDeploymentId: randomUuidV7(),
      installationId: randomUuidV7(),
      otherInstallationId: randomUuidV7(),
    };
    const fixtureKeyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const otherKeyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const matchingCapabilities = JSON.stringify({
      codexRuntimeArtifacts: [RUNTIME_DIGEST],
      codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
      isolationModes: ['apple-container-v1'],
      brokerContractDigest: BROKER_CONTRACT_DIGEST,
    });
    const secondaryConsumer = await owner.query<{ id: string }>(
      `INSERT INTO users (account) VALUES ($1) RETURNING id::text`,
      [creatorAccount()],
    );
    const secondaryConsumerId = secondaryConsumer.rows[0]?.id;
    if (secondaryConsumerId === undefined) throw new Error('failed to seed secondary Consumer');
    await owner.query(
      `INSERT INTO agents (id, creator_id, public_slug, name)
       VALUES
         ($1, $3, $4, 'Gateway dual authority'),
         ($2, $3, $5, 'Gateway wrong deployment')`,
      [
        fixture.agentId,
        fixture.otherAgentId,
        ids.creatorId,
        `gateway-dual-${fixture.agentId.slice(0, 8)}`,
        `gateway-other-${fixture.otherAgentId.slice(0, 8)}`,
      ],
    );
    for (const version of [
      {
        id: fixture.healthyVersionId,
        agentId: fixture.agentId,
        ordinal: 1,
        versionDigest: fixture.healthyVersionDigest,
      },
      {
        id: fixture.securityVersionId,
        agentId: fixture.agentId,
        ordinal: 2,
        versionDigest: fixture.securityVersionDigest,
      },
      {
        id: fixture.otherVersionId,
        agentId: fixture.otherAgentId,
        ordinal: 1,
        versionDigest: fixture.otherVersionDigest,
      },
    ]) {
      await owner.query(
        `INSERT INTO agent_versions (
           id, agent_id, creator_id, ordinal, schema_version, version_digest, snapshot_id,
           behavior_contract, behavior_contract_digest, runtime_policy, runtime_policy_digest,
           io_contract, io_contract_digest, model_policy, model_policy_digest,
           codex_runtime_version, codex_runtime_artifact_digest, codex_protocol_schema_digest
         ) VALUES (
           $1, $2, $3, $4, 1, $5, $6,
           '{}'::jsonb, $7, $8::jsonb, $9, '{}'::jsonb, $10, '{}'::jsonb, $11,
           '0.147.0-alpha.6.5', $12, $13
         )`,
        [
          version.id,
          version.agentId,
          ids.creatorId,
          version.ordinal,
          version.versionDigest,
          ids.snapshotId,
          randomBytes(32).toString('hex'),
          JSON.stringify(TEST_RUNTIME_POLICY),
          randomBytes(32).toString('hex'),
          randomBytes(32).toString('hex'),
          randomBytes(32).toString('hex'),
          RUNTIME_DIGEST,
          PROTOCOL_DIGEST,
        ],
      );
    }
    await owner.query(
      `INSERT INTO agent_version_controls (
         version_id, creator_id, availability, severity, reason_code
       ) VALUES
         ($1, $4, 'ACTIVE', 'NORMAL', NULL),
         ($2, $4, 'REVOKED', 'SECURITY', 'DUAL_AUTHORITY_SECURITY_FIXTURE'),
         ($3, $4, 'ACTIVE', 'NORMAL', NULL)`,
      [fixture.healthyVersionId, fixture.securityVersionId, fixture.otherVersionId, ids.creatorId],
    );
    await owner.query(
      `INSERT INTO deployments (
         id, agent_id, creator_id, environment, desired_state,
         desired_version_id, generation
       ) VALUES
         ($1, $3, $5, 'TEST', 'ONLINE', $6, 1),
         ($2, $4, $5, 'TEST', 'ONLINE', $7, 1)`,
      [
        fixture.deploymentId,
        fixture.otherDeploymentId,
        fixture.agentId,
        fixture.otherAgentId,
        ids.creatorId,
        fixture.healthyVersionId,
        fixture.otherVersionId,
      ],
    );
    for (const installation of [
      { id: fixture.installationId, publicKey: fixtureKeyPair.publicKey },
      { id: fixture.otherInstallationId, publicKey: otherKeyPair.publicKey },
    ]) {
      await owner.query(
        `INSERT INTO worker_installations (
           id, creator_id, installation_key_id, device_public_key,
           worker_version, protocol_versions, capabilities
         ) VALUES ($1, $2, $3, $4, $5, '[1]'::jsonb, $6::jsonb)`,
        [
          installation.id,
          ids.creatorId,
          `gateway-key-${installation.id}`,
          publicPoint(installation.publicKey),
          WORKER_VERSION,
          matchingCapabilities,
        ],
      );
    }

    let originalSession: AuthenticatedWorkerSession | undefined;
    let currentSession: AuthenticatedWorkerSession | undefined;
    try {
      const originalChallenge = await authority.issueChallenge({
        creatorId: ids.creatorId,
        installationId: fixture.installationId,
        deploymentId: fixture.deploymentId,
        deploymentGeneration: '1',
        operationId: randomUuidV7(),
        signal: AbortSignal.timeout(5_000),
      });
      originalSession = await authority.authenticate({
        handshake: signedHandshake(
          fixtureKeyPair.privateKey,
          fixture.installationId,
          originalChallenge.challengeId,
        ),
        connectedAt: new Date().toISOString(),
        signal: AbortSignal.timeout(5_000),
      });
      const originalOpened = await authority.openSession(
        originalSession,
        AbortSignal.timeout(5_000),
      );
      const originalLease = originalOpened[0];
      if (originalLease?.type !== 'lease.grant') throw new Error('expected original lease.grant');
      expect(originalLease.lease.fence).toBe('1');

      const wrongInstallationLeaseId = randomUuidV7();
      const wrongDeploymentLeaseId = randomUuidV7();
      await owner.query(
        `INSERT INTO worker_leases (
           id, deployment_id, creator_id, worker_id, connection_id, fence, state, expires_at
         ) VALUES
           ($1, $3, $4, $5, $6, 77, 'REVOKED', statement_timestamp() + interval '10 minutes'),
           ($2, $7, $4, $8, $9, 1, 'REVOKED', statement_timestamp() + interval '10 minutes')`,
        [
          wrongInstallationLeaseId,
          wrongDeploymentLeaseId,
          fixture.deploymentId,
          ids.creatorId,
          fixture.otherInstallationId,
          randomUuidV7(),
          fixture.otherDeploymentId,
          fixture.installationId,
          randomUuidV7(),
        ],
      );

      const seedInvocation = async (input: {
        agentId?: string;
        deploymentId: string;
        versionId: string;
        versionDigest: string;
        installationId: string;
        leaseId: string;
        fence: string;
        consumerId?: string;
        withCapability?: boolean;
      }): Promise<{
        invocationId: string;
        capabilityDigest: string;
        versionDigest: string;
        leaseId: string;
        fence: string;
      }> => {
        const conversationId = randomUuidV7();
        const userMessageId = randomUuidV7();
        const invocationId = randomUuidV7();
        const capabilityDigest = randomBytes(32).toString('hex');
        const capabilityId = input.withCapability === false ? null : randomUuidV7();
        const consumerId = input.consumerId ?? ids.creatorId;
        await owner.query(
          `INSERT INTO agent_conversations (
             id, agent_id, deployment_id, agent_version_id, creator_id,
             consumer_subject_id, version_digest, state, assigned_worker_id, expires_at,
             idempotency_key, request_digest
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, 'BUSY', $8,
             statement_timestamp() + interval '30 days', $9, $10
           )`,
          [
            conversationId,
            input.agentId ?? fixture.agentId,
            input.deploymentId,
            input.versionId,
            ids.creatorId,
            consumerId,
            input.versionDigest,
            input.installationId,
            randomUuidV7(),
            digest('a'),
          ],
        );
        await owner.query(
          `INSERT INTO agent_messages (
             id, conversation_id, creator_id, consumer_subject_id, turn_no, role,
             client_message_id, content_algorithm, content_key_id, content_nonce,
             content_ciphertext, content_auth_tag, content_cipher_digest,
             content_digest, content_aad_version
           ) VALUES (
             $1, $2, $3, $4, 1, 'USER', $5, 'aes-256-gcm/v1', $6, $7, $8, $9,
             $10, $11, 1
           )`,
          [
            userMessageId,
            conversationId,
            ids.creatorId,
            consumerId,
            `gateway-dual-${userMessageId}`,
            `gateway-key-${userMessageId}`,
            randomBytes(12),
            randomBytes(32),
            randomBytes(16),
            randomBytes(32).toString('hex'),
            `hmac-sha256:${randomBytes(32).toString('hex')}`,
          ],
        );
        await owner.query(
          `INSERT INTO agent_invocations (
             id, conversation_id, creator_id, consumer_subject_id, agent_version_id,
             user_message_id, client_message_id, request_digest, state,
             assigned_worker_id, assignment_lease_id, assignment_fence,
             execution_capability_id, execution_capability_digest,
             execution_capability_expires_at, deadline_at, started_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, 'RUNNING', $9, $10, $11,
             $12, $13, CASE WHEN $12::uuid IS NULL THEN NULL
                            ELSE statement_timestamp() + interval '2 minutes 30 seconds' END,
             statement_timestamp() + interval '2 minutes', statement_timestamp()
           )`,
          [
            invocationId,
            conversationId,
            ids.creatorId,
            consumerId,
            input.versionId,
            userMessageId,
            `gateway-dual-${invocationId}`,
            `hmac-sha256:${randomBytes(32).toString('hex')}`,
            input.installationId,
            input.leaseId,
            input.fence,
            capabilityId,
            capabilityId === null ? null : capabilityDigest,
          ],
        );
        return {
          invocationId,
          capabilityDigest,
          versionDigest: input.versionDigest,
          leaseId: input.leaseId,
          fence: input.fence,
        };
      };

      const originalInvocation = await seedInvocation({
        deploymentId: fixture.deploymentId,
        versionId: fixture.healthyVersionId,
        versionDigest: fixture.healthyVersionDigest,
        installationId: fixture.installationId,
        leaseId: originalLease.lease.leaseId,
        fence: originalLease.lease.fence,
      });
      const wrongInstallationInvocation = await seedInvocation({
        deploymentId: fixture.deploymentId,
        versionId: fixture.healthyVersionId,
        versionDigest: fixture.healthyVersionDigest,
        installationId: fixture.otherInstallationId,
        leaseId: wrongInstallationLeaseId,
        fence: '77',
        consumerId: secondaryConsumerId,
      });
      const wrongDeploymentInvocation = await seedInvocation({
        agentId: fixture.otherAgentId,
        deploymentId: fixture.otherDeploymentId,
        versionId: fixture.otherVersionId,
        versionDigest: fixture.otherVersionDigest,
        installationId: fixture.installationId,
        leaseId: wrongDeploymentLeaseId,
        fence: '1',
      });
      const securityInvocation = await seedInvocation({
        deploymentId: fixture.deploymentId,
        versionId: fixture.securityVersionId,
        versionDigest: fixture.securityVersionDigest,
        installationId: fixture.installationId,
        leaseId: originalLease.lease.leaseId,
        fence: originalLease.lease.fence,
      });

      const replacementChallenge = await authority.issueChallenge({
        creatorId: ids.creatorId,
        installationId: fixture.installationId,
        deploymentId: fixture.deploymentId,
        deploymentGeneration: '1',
        operationId: randomUuidV7(),
        signal: AbortSignal.timeout(5_000),
      });
      currentSession = await authority.authenticate({
        handshake: signedHandshake(
          fixtureKeyPair.privateKey,
          fixture.installationId,
          replacementChallenge.challengeId,
        ),
        connectedAt: new Date().toISOString(),
        signal: AbortSignal.timeout(5_000),
      });
      const replacementFacts = await owner.query<{
        old_lease_state: string;
        capability_revoked_at: Date | string | null;
      }>(
        `SELECT lease.state AS old_lease_state,
                invocation.execution_capability_revoked_at AS capability_revoked_at
           FROM worker_leases AS lease
           JOIN agent_invocations AS invocation ON invocation.id = $2
          WHERE lease.id = $1`,
        [originalLease.lease.leaseId, originalInvocation.invocationId],
      );
      expect(replacementFacts.rows).toEqual([
        { old_lease_state: 'REVOKED', capability_revoked_at: null },
      ]);
      const currentOpened = await authority.openSession(currentSession, AbortSignal.timeout(5_000));
      const currentLease = currentOpened[0];
      if (currentLease?.type !== 'lease.grant') throw new Error('expected current lease.grant');
      expect(currentLease.lease.fence).toBe('2');
      expect(currentLease.lease.leaseId).not.toBe(originalLease.lease.leaseId);
      const lateCapabilityInvocation = await seedInvocation({
        deploymentId: fixture.deploymentId,
        versionId: fixture.healthyVersionId,
        versionDigest: fixture.healthyVersionDigest,
        installationId: fixture.installationId,
        leaseId: currentLease.lease.leaseId,
        fence: currentLease.lease.fence,
        withCapability: false,
      });

      const projected: string[] = [];
      const projector = {
        project: async ({ transaction, session, transport, event, signal }) => {
          if (event.type !== 'invocation.failed') throw new Error('unexpected projected event');
          const durable = await transaction.query<{
            invocation_id: string;
            deployment_id: string;
            installation_id: string;
            original_lease_id: string;
            original_fence: string;
            current_lease_id: string;
            current_fence: string;
          }>(
            `SELECT invocation.id::text AS invocation_id,
                    conversation.deployment_id::text,
                    invocation.assigned_worker_id::text AS installation_id,
                    invocation.assignment_lease_id::text AS original_lease_id,
                    invocation.assignment_fence::text AS original_fence,
                    current_lease.id::text AS current_lease_id,
                    current_lease.fence::text AS current_fence
               FROM agent_invocations AS invocation
               JOIN agent_conversations AS conversation
                 ON conversation.id = invocation.conversation_id
                AND conversation.creator_id = invocation.creator_id
                AND conversation.consumer_subject_id = invocation.consumer_subject_id
               JOIN worker_leases AS current_lease
                 ON current_lease.id = $5
                AND current_lease.creator_id = invocation.creator_id
              WHERE invocation.id = $1 AND invocation.creator_id = $2
                AND conversation.deployment_id = $3
                AND invocation.assigned_worker_id = $4`,
            [
              event.body.invocationId,
              session.ownerId,
              transport.deploymentId,
              transport.installationId,
              transport.leaseId,
            ],
            signal,
          );
          expect(durable.rows).toEqual([
            {
              invocation_id: originalInvocation.invocationId,
              deployment_id: fixture.deploymentId,
              installation_id: fixture.installationId,
              original_lease_id: originalLease.lease.leaseId,
              original_fence: '1',
              current_lease_id: currentLease.lease.leaseId,
              current_fence: '2',
            },
          ]);
          expect(transport).toMatchObject({
            creatorId: ids.creatorId,
            installationId: fixture.installationId,
            workerSessionId: currentSession?.workerSessionId,
            connectionId: currentSession?.connectionId,
            deploymentId: fixture.deploymentId,
            leaseId: currentLease.lease.leaseId,
            fence: '2',
          });
          expect(event.body).toMatchObject({
            leaseId: originalLease.lease.leaseId,
            fence: '1',
          });
          projected.push(event.messageId);
          return 'APPLIED';
        },
      } satisfies NonNullable<ConstructorParameters<typeof PostgresAgentGatewayAuthority>[2]>;
      const projectingAuthority = new PostgresAgentGatewayAuthority(pools, policy, projector);
      const invocationEvent = (
        invocation: typeof originalInvocation,
        sequence = 0n,
      ): Extract<BrokerEnvelope, { type: 'invocation.failed' }> =>
        invocationFailed(currentSession!, currentLease, sequence, {
          invocationId: invocation.invocationId,
          agentVersionDigest: invocation.versionDigest,
          snapshotDigest: fixture.snapshotDigest,
          executionCapabilityDigest: invocation.capabilityDigest,
          leaseId: invocation.leaseId,
          fence: invocation.fence,
        });

      const currentHeartbeat = heartbeat(currentSession, currentLease, 0n);
      const staleActiveHeartbeat = BrokerEnvelopeSchema.parse({
        ...currentHeartbeat,
        body: {
          ...currentHeartbeat.body,
          activeInvocationId: originalInvocation.invocationId,
        },
      });
      await expect(
        projectingAuthority.acceptEnvelope(
          currentSession,
          delivery(staleActiveHeartbeat),
          AbortSignal.timeout(5_000),
        ),
      ).rejects.toMatchObject({ code: 'LEASE_UNAVAILABLE' });
      for (const rejected of [
        invocationEvent(wrongInstallationInvocation),
        invocationEvent(wrongDeploymentInvocation),
        invocationFailed(currentSession, currentLease, 0n, {
          invocationId: randomUuidV7(),
          agentVersionDigest: fixture.healthyVersionDigest,
          snapshotDigest: fixture.snapshotDigest,
          executionCapabilityDigest: randomBytes(32).toString('hex'),
          leaseId: originalLease.lease.leaseId,
          fence: '1',
        }),
      ]) {
        await expect(
          projectingAuthority.acceptEnvelope(
            currentSession,
            delivery(rejected),
            AbortSignal.timeout(5_000),
          ),
        ).rejects.toMatchObject({ code: 'LEASE_UNAVAILABLE' });
      }
      expect(projected).toEqual([]);
      const beforeProjection = await owner.query<{ inbound_next_seq: string }>(
        `SELECT inbound_next_seq::text FROM worker_gateway_sessions WHERE id = $1`,
        [currentSession.workerSessionId],
      );
      expect(beforeProjection.rows).toEqual([{ inbound_next_seq: '0' }]);

      const valid = invocationEvent(originalInvocation);
      const committed = await projectingAuthority.acceptEnvelope(
        currentSession,
        delivery(valid),
        AbortSignal.timeout(5_000),
      );
      expect(committed).toHaveLength(1);
      expect(committed[0]).toMatchObject({
        type: 'message.ack',
        body: {
          acknowledgedMessageId: valid.messageId,
          level: 'CLOUD_COMMITTED',
          decision: 'APPLIED',
        },
      });
      await expect(
        projectingAuthority.replayEnvelope(
          currentSession,
          delivery(valid),
          AbortSignal.timeout(5_000),
        ),
      ).resolves.toEqual(committed);
      expect(projected).toEqual([valid.messageId]);
      const afterProjection = await owner.query<{
        capability_revoked_at: Date | string | null;
        inbound_next_seq: string;
      }>(
        `SELECT invocation.execution_capability_revoked_at AS capability_revoked_at,
                gateway.inbound_next_seq::text
           FROM agent_invocations AS invocation
           JOIN worker_gateway_sessions AS gateway ON gateway.id = $2
          WHERE invocation.id = $1`,
        [originalInvocation.invocationId, currentSession.workerSessionId],
      );
      expect(afterProjection.rows).toEqual([
        { capability_revoked_at: null, inbound_next_seq: '1' },
      ]);

      const securityEvent = invocationEvent(securityInvocation, 1n);
      let securityProjected!: () => void;
      let releaseSecurityProjection!: () => void;
      const securityProjectedPromise = new Promise<void>(
        (resolve) => (securityProjected = resolve),
      );
      const securityProjectionBarrier = new Promise<void>(
        (resolve) => (releaseSecurityProjection = resolve),
      );
      const racingSecurityAuthority = new PostgresAgentGatewayAuthority(
        pools,
        policy,
        projector,
        async (step) => {
          if (step !== 'EVENT_PROJECTED') return;
          securityProjected();
          await securityProjectionBarrier;
        },
      );
      const pendingSecurity = racingSecurityAuthority.acceptEnvelope(
        currentSession,
        delivery(securityEvent),
        AbortSignal.timeout(5_000),
      );
      await securityProjectedPromise;
      const issuerName = `gateway-capability-race-${randomUuidV7()}`;
      const issuerUrl = new URL(databaseUrl ?? 'postgresql://invalid');
      issuerUrl.searchParams.set('application_name', issuerName);
      const issuer = new Client({ connectionString: issuerUrl.toString() });
      await issuer.connect();
      let blocked: readonly BrokerEnvelope[];
      let pendingCapabilityIssue: Promise<unknown> | undefined;
      try {
        pendingCapabilityIssue = issuer.query(
          `UPDATE agent_invocations
              SET execution_capability_id = $2,
                  execution_capability_digest = $3,
                  execution_capability_expires_at =
                    statement_timestamp() + interval '2 minutes 30 seconds'
            WHERE id = $1`,
          [
            lateCapabilityInvocation.invocationId,
            randomUuidV7(),
            lateCapabilityInvocation.capabilityDigest,
          ],
        );
        // The SECURITY transaction may reject this statement before the barrier assertion below
        // reaches its awaited matcher. Attach the rejection observer immediately so Node never
        // classifies the expected database refusal as an unhandled promise.
        void pendingCapabilityIssue.catch(() => undefined);
        await waitForPgWaitEvent(owner, issuerName, 'advisory');
        releaseSecurityProjection();
        blocked = await pendingSecurity;
        await expect(pendingCapabilityIssue).rejects.toMatchObject({
          code: '55000',
          message: 'invocation execution capability lost Deployment authority under lock',
        });
      } finally {
        releaseSecurityProjection();
        await pendingSecurity.catch(() => undefined);
        await pendingCapabilityIssue?.catch(() => undefined);
        await issuer.end();
      }
      expect(blocked.map((frame) => frame.type)).toEqual(['message.ack', 'lease.revoke']);
      expect(blocked[0]).toMatchObject({
        type: 'message.ack',
        body: { acknowledgedMessageId: securityEvent.messageId, decision: 'SECURITY_BLOCK' },
      });
      expect(projected).toEqual([valid.messageId]);
      const revoked = await owner.query<{
        invocation_id: string;
        revoked: boolean;
      }>(
        `SELECT invocation.id::text AS invocation_id,
                invocation.execution_capability_revoked_at IS NOT NULL AS revoked
           FROM agent_invocations AS invocation
          WHERE invocation.id = ANY($1::uuid[])
          ORDER BY invocation.id`,
        [
          [
            originalInvocation.invocationId,
            wrongInstallationInvocation.invocationId,
            wrongDeploymentInvocation.invocationId,
            securityInvocation.invocationId,
          ],
        ],
      );
      expect(
        Object.fromEntries(revoked.rows.map((row) => [row.invocation_id, row.revoked])),
      ).toEqual({
        [originalInvocation.invocationId]: true,
        [wrongInstallationInvocation.invocationId]: true,
        [wrongDeploymentInvocation.invocationId]: false,
        [securityInvocation.invocationId]: true,
      });
      const rejectedIssue = await owner.query<{
        execution_capability_id: string | null;
        execution_capability_digest: string | null;
        execution_capability_expires_at: Date | string | null;
      }>(
        `SELECT execution_capability_id::text, execution_capability_digest,
                execution_capability_expires_at
           FROM agent_invocations
          WHERE id = $1`,
        [lateCapabilityInvocation.invocationId],
      );
      expect(rejectedIssue.rows).toEqual([
        {
          execution_capability_id: null,
          execution_capability_digest: null,
          execution_capability_expires_at: null,
        },
      ]);
      const blockedAuthority = await owner.query<{
        lease_state: string;
        session_state: string;
        deployment_state: string;
      }>(
        `SELECT lease.state AS lease_state, gateway.state AS session_state,
                deployment.observed_state AS deployment_state
           FROM worker_leases AS lease
           JOIN worker_gateway_sessions AS gateway
             ON gateway.connection_id = lease.connection_id
            AND gateway.creator_id = lease.creator_id
           JOIN deployments AS deployment
             ON deployment.id = lease.deployment_id
            AND deployment.creator_id = lease.creator_id
          WHERE lease.id = $1`,
        [currentLease.lease.leaseId],
      );
      expect(blockedAuthority.rows).toEqual([
        { lease_state: 'REVOKED', session_state: 'REVOKED', deployment_state: 'BLOCKED' },
      ]);
    } finally {
      await Promise.all([
        originalSession === undefined
          ? Promise.resolve()
          : authority.closeSession(originalSession, 'SERVER_STOPPED').catch(() => undefined),
        currentSession === undefined
          ? Promise.resolve()
          : authority.closeSession(currentSession, 'SERVER_STOPPED').catch(() => undefined),
      ]);
    }
  });

  it('runs the real WebSocket Gateway through signed auth, PG Lease, ACK, and replay', async () => {
    const challenge = await authority.issueChallenge({
      creatorId: ids.creatorId,
      installationId: ids.installationId,
      ...challengeTarget,
      operationId: randomUuidV7(),
      signal: AbortSignal.timeout(5_000),
    });
    const gateway = new AgentGateway({
      authority,
      host: '127.0.0.1',
      port: 0,
      authorityTimeoutMs: 5_000,
    });
    const address = await gateway.start();
    const socket = new WebSocket(`ws://${address.host}:${address.port}${address.path}`, {
      perMessageDeflate: false,
    });
    try {
      await once(socket, 'open');
      socket.send(
        canonicalizeJson(
          signedHandshake(keyPair.privateKey, ids.installationId, challenge.challengeId),
        ),
      );
      const leaseFrame = parseBrokerFrame(await nextTextFrame(socket));
      if (leaseFrame.type !== 'lease.grant') throw new Error('expected real lease.grant');
      const session = Object.freeze({
        ownerId: ids.creatorId,
        installationId: ids.installationId,
        connectionId: leaseFrame.connectionId,
        workerSessionId: leaseFrame.lease.workerSessionId,
      });
      latestSession = session;
      const event = heartbeat(session, leaseFrame, 0n);
      const renewalFrames = nextTextFrames(socket, 2);
      socket.send(canonicalizeJson(event));
      const [renewalGrantRaw, firstAckRaw] = await renewalFrames;
      const renewalGrant = parseBrokerFrame(renewalGrantRaw ?? '');
      expect(renewalGrant).toMatchObject({
        type: 'lease.grant',
        lease: leaseFrame.lease,
      });
      const firstAck = parseBrokerFrame(firstAckRaw ?? '');
      expect(firstAck).toMatchObject({
        type: 'message.ack',
        body: { acknowledgedMessageId: event.messageId, level: 'CLOUD_COMMITTED' },
      });

      const replayFrames = nextTextFrames(socket, 2);
      socket.send(canonicalizeJson(event));
      const [replayGrantRaw, replayAckRaw] = await replayFrames;
      const replayGrant = parseBrokerFrame(replayGrantRaw ?? '');
      const replayAck = parseBrokerFrame(replayAckRaw ?? '');
      expect(replayGrant).toEqual(renewalGrant);
      expect(replayAck).toEqual(firstAck);
      expect(gateway.activeConnections).toBe(1);
    } finally {
      const closed = once(socket, 'close');
      socket.close();
      await closed.catch(() => undefined);
      await gateway.stop();
    }
    const active = await owner.query<{ sessions: string; leases: string }>(
      `SELECT
         (SELECT count(*)::text FROM worker_gateway_sessions
           WHERE installation_id = $1 AND state = 'ACTIVE') AS sessions,
         (SELECT count(*)::text FROM worker_leases
           WHERE worker_id = $1 AND state = 'ACTIVE') AS leases`,
      [ids.installationId],
    );
    expect(active.rows).toEqual([{ sessions: '0', leases: '0' }]);
  });

  it('durably blocks a signed incompatible challenge without granting Session or Lease', async () => {
    const incompatibleKeyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const incompatibleInstallationId = randomUuidV7();
    await owner.query(
      `INSERT INTO worker_installations (
         id, creator_id, installation_key_id, device_public_key,
         worker_version, protocol_versions, capabilities
       ) VALUES ($1, $2, $3, $4, $5, '[1]'::jsonb, $6::jsonb)`,
      [
        incompatibleInstallationId,
        ids.creatorId,
        `gateway-key-${incompatibleInstallationId}`,
        publicPoint(incompatibleKeyPair.publicKey),
        WORKER_VERSION,
        JSON.stringify({
          codexRuntimeArtifacts: [RUNTIME_DIGEST],
          codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
          isolationModes: ['lima-vz-v1'],
          brokerContractDigest: BROKER_CONTRACT_DIGEST,
        }),
      ],
    );
    const challenge = await authority.issueChallenge({
      creatorId: ids.creatorId,
      installationId: incompatibleInstallationId,
      ...challengeTarget,
      operationId: randomUuidV7(),
      signal: AbortSignal.timeout(5_000),
    });
    const handshake = signedHandshake(
      incompatibleKeyPair.privateKey,
      incompatibleInstallationId,
      challenge.challengeId,
    );
    await expect(
      authority.authenticate({
        handshake,
        connectedAt: new Date().toISOString(),
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toMatchObject({ code: 'WORKER_INCOMPATIBLE' });

    const incompatibleFacts = await owner.query<{
      challenge_state: string;
      deployment_state: string;
      last_error_code: string | null;
      sessions: string;
      leases: string;
      incompatible_events: string;
    }>(
      `SELECT challenge.state AS challenge_state,
              deployment.observed_state AS deployment_state,
              deployment.last_error_code,
              (SELECT count(*)::text FROM worker_gateway_sessions
                WHERE challenge_id = challenge.id) AS sessions,
              (SELECT count(*)::text FROM worker_leases
                WHERE deployment_id = challenge.deployment_id AND state = 'ACTIVE') AS leases,
              (SELECT count(*)::text FROM worker_auth_security_events
                WHERE challenge_id = challenge.id
                  AND event_type = 'WORKER_INCOMPATIBLE') AS incompatible_events
         FROM worker_auth_challenges AS challenge
         JOIN deployments AS deployment ON deployment.id = challenge.deployment_id
        WHERE challenge.id = $1`,
      [challenge.challengeId],
    );
    expect(incompatibleFacts.rows).toEqual([
      {
        challenge_state: 'CONSUMED',
        deployment_state: 'BLOCKED',
        last_error_code: 'ISOLATION_INCOMPATIBLE',
        sessions: '0',
        leases: '0',
        incompatible_events: '1',
      },
    ]);

    await expect(
      authority.authenticate({
        handshake,
        connectedAt: new Date().toISOString(),
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_REJECTED' });
    const replayAudit = await owner.query<{ replays: string; incompatibles: string }>(
      `SELECT
         count(*) FILTER (WHERE event_type = 'CHALLENGE_REPLAY')::text AS replays,
         count(*) FILTER (WHERE event_type = 'WORKER_INCOMPATIBLE')::text AS incompatibles
       FROM worker_auth_security_events WHERE challenge_id = $1`,
      [challenge.challengeId],
    );
    expect(replayAudit.rows).toEqual([{ replays: '1', incompatibles: '1' }]);

    await owner.query(
      `UPDATE deployments
          SET observed_state = 'OFFLINE', observed_worker_id = NULL,
              last_error_code = NULL, updated_at = statement_timestamp()
        WHERE id = $1`,
      [ids.deploymentId],
    );
  });

  // G0 SCH-010/BRK-005 exact-profile evidence. Registration is seeded directly; Creator OAuth,
  // Runtime/Snapshot readiness, public WSS, and Native Host composition remain planned.
  it('durably blocks signed N+1 unknown native and undeclared cross-profile registrations', async () => {
    const corpus = await compatibilityCorpus;
    const exactProfileAuthority = new PostgresAgentGatewayAuthority(pools, {
      ...policy,
      acceptedWorkerVersions: [PREVIOUS_WORKER_VERSION, WORKER_VERSION],
      acceptedCodexRuntimeArtifacts: [PREVIOUS_RUNTIME_DIGEST, RUNTIME_DIGEST],
      acceptedCodexProtocolSchemaDigests: [PREVIOUS_PROTOCOL_DIGEST, PROTOCOL_DIGEST],
      acceptedIsolationModes: ['lima-vz-v1', 'apple-container-v1'],
    });
    expect(corpus.current).toMatchObject({
      wireProtocol: 'combo.creator-broker/1',
      wireSchemaVersion: 1,
      supportedProtocolVersions: [1],
    });
    expect(corpus.declaredPrevious).toHaveLength(1);
    expect(corpus.declaredPairs).toHaveLength(4);

    for (const testCase of corpus.rejectedRegistrations) {
      const testKeyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const installationId = randomUuidV7();
      let registeredWorkerVersion = WORKER_VERSION;
      const capabilities: Record<string, unknown> = {
        codexRuntimeArtifacts: [RUNTIME_DIGEST],
        codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
        isolationModes: ['apple-container-v1'],
        brokerContractDigest: BROKER_CONTRACT_DIGEST,
      };
      switch (testCase.id) {
        case 'future-protocol-v2':
          break;
        case 'future-worker-version':
          registeredWorkerVersion = testCase.advertisedValue!;
          break;
        case 'unknown-capability-key':
          capabilities.futureCapability = testCase.advertisedValue;
          break;
        case 'native-macos':
          capabilities.isolationModes = [testCase.advertisedValue];
          break;
        case 'stale-broker-contract':
          capabilities.brokerContractDigest = testCase.advertisedValue;
          break;
        case 'unaccepted-codex-runtime':
          capabilities.codexRuntimeArtifacts = [testCase.advertisedValue];
          break;
        case 'unaccepted-codex-protocol':
          capabilities.codexProtocolSchemaDigests = [testCase.advertisedValue];
          break;
        case 'unaccepted-isolation':
          capabilities.isolationModes = [testCase.advertisedValue];
          break;
        case 'undeclared-cross-mix':
          capabilities.codexRuntimeArtifacts = [PREVIOUS_RUNTIME_DIGEST];
          break;
      }
      await owner.query(
        `INSERT INTO worker_installations (
           id, creator_id, installation_key_id, device_public_key,
           worker_version, protocol_versions, capabilities
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
        [
          installationId,
          ids.creatorId,
          `gateway-compatibility-key-${installationId}`,
          publicPoint(testKeyPair.publicKey),
          registeredWorkerVersion,
          JSON.stringify(testCase.protocolVersions),
          JSON.stringify(capabilities),
        ],
      );
      const challenge = await exactProfileAuthority.issueChallenge({
        creatorId: ids.creatorId,
        installationId,
        ...challengeTarget,
        operationId: randomUuidV7(),
        signal: AbortSignal.timeout(5_000),
      });
      const handshake = signedHandshake(
        testKeyPair.privateKey,
        installationId,
        challenge.challengeId,
        {
          ...(testCase.id === 'future-worker-version'
            ? { workerVersion: testCase.advertisedValue! }
            : {}),
          ...(testCase.id === 'stale-broker-contract'
            ? { brokerContractDigest: testCase.advertisedValue! }
            : {}),
          ...(testCase.id === 'unaccepted-codex-runtime'
            ? { codexRuntimeArtifacts: [testCase.advertisedValue!] }
            : {}),
          ...(testCase.id === 'unaccepted-codex-protocol'
            ? { codexProtocolSchemaDigests: [testCase.advertisedValue!] }
            : {}),
          ...(testCase.id === 'unaccepted-isolation'
            ? {
                isolationModes: [testCase.advertisedValue! as 'apple-container-v1' | 'lima-vz-v1'],
              }
            : {}),
          ...(testCase.id === 'undeclared-cross-mix'
            ? { codexRuntimeArtifacts: [PREVIOUS_RUNTIME_DIGEST] }
            : {}),
        },
      );

      await expect(
        exactProfileAuthority.authenticate({
          handshake,
          connectedAt: new Date().toISOString(),
          signal: AbortSignal.timeout(5_000),
        }),
        testCase.id,
      ).rejects.toMatchObject({ code: 'WORKER_INCOMPATIBLE' });

      const facts = await owner.query<{
        challenge_state: string;
        deployment_state: string;
        last_error_code: string | null;
        sessions: string;
        leases: string;
        reasons: string[];
      }>(
        `SELECT challenge.state AS challenge_state,
                deployment.observed_state AS deployment_state,
                deployment.last_error_code,
                (SELECT count(*)::text FROM worker_gateway_sessions
                  WHERE challenge_id = challenge.id) AS sessions,
                (SELECT count(*)::text FROM worker_leases
                  WHERE deployment_id = challenge.deployment_id AND state = 'ACTIVE') AS leases,
                ARRAY(
                  SELECT reason_code FROM worker_auth_security_events
                   WHERE challenge_id = challenge.id ORDER BY id
                ) AS reasons
           FROM worker_auth_challenges AS challenge
           JOIN deployments AS deployment ON deployment.id = challenge.deployment_id
          WHERE challenge.id = $1`,
        [challenge.challengeId],
      );
      expect(facts.rows, testCase.id).toEqual([
        {
          challenge_state: 'CONSUMED',
          deployment_state: 'BLOCKED',
          last_error_code: testCase.expectedError,
          sessions: '0',
          leases: '0',
          reasons: [testCase.expectedError],
        },
      ]);

      await owner.query(
        `UPDATE deployments
            SET observed_state = 'OFFLINE', observed_worker_id = NULL,
                last_error_code = NULL, updated_at = statement_timestamp()
          WHERE id = $1`,
        [ids.deploymentId],
      );
    }
  });

  it('durably blocks every signed Broker contract mismatch before Session or Lease', async () => {
    const staleDigest = 'sha256:9db3770041d2da6ee3daae07c1a0a4ce05094cb3852887a72c20f4f8f2319b73';
    expect(staleDigest).not.toBe(BROKER_CONTRACT_DIGEST);
    const cases = [
      {
        name: 'stale signed handshake',
        registeredDigest: BROKER_CONTRACT_DIGEST,
        handshakeDigest: staleDigest,
      },
      {
        name: 'registration mismatch',
        registeredDigest: staleDigest,
        handshakeDigest: BROKER_CONTRACT_DIGEST,
      },
      {
        name: 'missing registration digest',
        registeredDigest: undefined,
        handshakeDigest: BROKER_CONTRACT_DIGEST,
      },
    ] as const;

    for (const testCase of cases) {
      const testKeyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const installationId = randomUuidV7();
      const capabilities: Record<string, unknown> = {
        codexRuntimeArtifacts: [RUNTIME_DIGEST],
        codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
        isolationModes: ['apple-container-v1'],
      };
      if (testCase.registeredDigest !== undefined) {
        capabilities.brokerContractDigest = testCase.registeredDigest;
      }
      await owner.query(
        `INSERT INTO worker_installations (
           id, creator_id, installation_key_id, device_public_key,
           worker_version, protocol_versions, capabilities
         ) VALUES ($1, $2, $3, $4, $5, '[1]'::jsonb, $6::jsonb)`,
        [
          installationId,
          ids.creatorId,
          `gateway-contract-key-${installationId}`,
          publicPoint(testKeyPair.publicKey),
          WORKER_VERSION,
          JSON.stringify(capabilities),
        ],
      );
      const challenge = await authority.issueChallenge({
        creatorId: ids.creatorId,
        installationId,
        ...challengeTarget,
        operationId: randomUuidV7(),
        signal: AbortSignal.timeout(5_000),
      });
      const handshake = signedHandshake(
        testKeyPair.privateKey,
        installationId,
        challenge.challengeId,
        { brokerContractDigest: testCase.handshakeDigest },
      );

      await expect(
        authority.authenticate({
          handshake,
          connectedAt: new Date().toISOString(),
          signal: AbortSignal.timeout(5_000),
        }),
        testCase.name,
      ).rejects.toMatchObject({ code: 'WORKER_INCOMPATIBLE' });

      const facts = await owner.query<{
        challenge_state: string;
        deployment_state: string;
        last_error_code: string | null;
        sessions: string;
        leases: string;
        reasons: string[];
      }>(
        `SELECT challenge.state AS challenge_state,
                deployment.observed_state AS deployment_state,
                deployment.last_error_code,
                (SELECT count(*)::text FROM worker_gateway_sessions
                  WHERE challenge_id = challenge.id) AS sessions,
                (SELECT count(*)::text FROM worker_leases
                  WHERE worker_id = challenge.installation_id AND state = 'ACTIVE') AS leases,
                ARRAY(
                  SELECT reason_code FROM worker_auth_security_events
                   WHERE challenge_id = challenge.id ORDER BY id
                ) AS reasons
           FROM worker_auth_challenges AS challenge
           JOIN deployments AS deployment ON deployment.id = challenge.deployment_id
          WHERE challenge.id = $1`,
        [challenge.challengeId],
      );
      expect(facts.rows, testCase.name).toEqual([
        {
          challenge_state: 'CONSUMED',
          deployment_state: 'BLOCKED',
          last_error_code: 'BROKER_CONTRACT_INCOMPATIBLE',
          sessions: '0',
          leases: '0',
          reasons: ['BROKER_CONTRACT_INCOMPATIBLE'],
        },
      ]);
      await owner.query(
        `UPDATE deployments
            SET observed_state = 'OFFLINE', observed_worker_id = NULL,
                last_error_code = NULL, updated_at = statement_timestamp()
          WHERE id = $1`,
        [ids.deploymentId],
      );
    }
  });

  it('refuses incompatible, concurrently leased, offline, and revoked deployment authority', async () => {
    const matchingCapabilities = JSON.stringify({
      codexRuntimeArtifacts: [RUNTIME_DIGEST],
      codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
      isolationModes: ['apple-container-v1'],
      brokerContractDigest: BROKER_CONTRACT_DIGEST,
    });
    let primarySession: AuthenticatedWorkerSession | undefined;
    let competingSession: AuthenticatedWorkerSession | undefined;
    try {
      const challenge = await authority.issueChallenge({
        creatorId: ids.creatorId,
        installationId: ids.installationId,
        ...challengeTarget,
        operationId: randomUuidV7(),
        signal: AbortSignal.timeout(5_000),
      });
      primarySession = await authority.authenticate({
        handshake: signedHandshake(keyPair.privateKey, ids.installationId, challenge.challengeId),
        connectedAt: new Date().toISOString(),
        signal: AbortSignal.timeout(5_000),
      });
      await owner.query(
        `UPDATE worker_installations
            SET capabilities = jsonb_set(
              capabilities,
              '{codexRuntimeArtifacts}',
              to_jsonb(ARRAY[$2::text])
            )
          WHERE id = $1`,
        [ids.installationId, `sha256:${'f'.repeat(64)}`],
      );
      await expect(
        authority.openSession(primarySession, AbortSignal.timeout(5_000)),
      ).rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' });
      await owner.query(`UPDATE worker_installations SET capabilities = $2::jsonb WHERE id = $1`, [
        ids.installationId,
        JSON.stringify({
          codexRuntimeArtifacts: [RUNTIME_DIGEST],
          codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
          isolationModes: ['lima-vz-v1'],
          brokerContractDigest: BROKER_CONTRACT_DIGEST,
        }),
      ]);
      await expect(
        authority.openSession(primarySession, AbortSignal.timeout(5_000)),
      ).rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' });
      await owner.query(`UPDATE worker_installations SET capabilities = $2::jsonb WHERE id = $1`, [
        ids.installationId,
        matchingCapabilities,
      ]);

      const eligibleChallenge = await authority.issueChallenge({
        creatorId: ids.creatorId,
        installationId: ids.installationId,
        ...challengeTarget,
        operationId: randomUuidV7(),
        signal: AbortSignal.timeout(5_000),
      });
      primarySession = await authority.authenticate({
        handshake: signedHandshake(
          keyPair.privateKey,
          ids.installationId,
          eligibleChallenge.challengeId,
        ),
        connectedAt: new Date().toISOString(),
        signal: AbortSignal.timeout(5_000),
      });

      const opened = await authority.openSession(primarySession, AbortSignal.timeout(5_000));
      const lease = opened[0];
      if (lease?.type !== 'lease.grant') throw new Error('expected eligible lease.grant');
      const concurrentA = heartbeat(primarySession, lease, 0n);
      const concurrentB = BrokerEnvelopeSchema.parse({
        ...concurrentA,
        body: { ...concurrentA.body, journalReady: false },
      }) as Extract<BrokerEnvelope, { type: 'heartbeat' }>;
      const concurrentResults = await Promise.allSettled([
        authority.acceptEnvelope(primarySession, delivery(concurrentA), AbortSignal.timeout(5_000)),
        authority.acceptEnvelope(primarySession, delivery(concurrentB), AbortSignal.timeout(5_000)),
      ]);
      expect(concurrentResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejectedConflict = concurrentResults.find((result) => result.status === 'rejected');
      expect(rejectedConflict).toMatchObject({
        status: 'rejected',
        reason: { code: 'SEQUENCE_CONFLICT' },
      });
      const winningInput = concurrentResults[0]?.status === 'fulfilled' ? concurrentA : concurrentB;
      const winningResult = concurrentResults.find((result) => result.status === 'fulfilled');
      if (winningResult?.status !== 'fulfilled') throw new Error('missing winning frame');
      await expect(
        authority.replayEnvelope(
          primarySession,
          delivery(winningInput),
          AbortSignal.timeout(5_000),
        ),
      ).resolves.toEqual(winningResult.value);

      const nextSequenceConflict = BrokerEnvelopeSchema.parse({
        ...winningInput,
        sequence: '1',
        body: { ...winningInput.body, proxyReady: !winningInput.body.proxyReady },
      });
      await expect(
        authority.acceptEnvelope(
          primarySession,
          delivery(nextSequenceConflict),
          AbortSignal.timeout(5_000),
        ),
      ).rejects.toMatchObject({ code: 'SEQUENCE_CONFLICT' });
      const concurrentFacts = await owner.query<{
        receipts: string;
        conflicts: string;
        inbound_next_seq: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM worker_gateway_frame_receipts
             WHERE session_id = $1) AS receipts,
           (SELECT count(*)::text FROM worker_gateway_security_events
             WHERE session_id = $1) AS conflicts,
           inbound_next_seq::text
         FROM worker_gateway_sessions WHERE id = $1`,
        [primarySession.workerSessionId],
      );
      expect(concurrentFacts.rows).toEqual([
        { receipts: '1', conflicts: '2', inbound_next_seq: '1' },
      ]);
      const beforeBlock = await owner.query<{ expires_at: Date | string }>(
        `SELECT expires_at FROM worker_leases WHERE id = $1`,
        [lease.lease.leaseId],
      );
      const originalExpiry = new Date(beforeBlock.rows[0]?.expires_at ?? 0).getTime();

      await owner.query(`UPDATE worker_installations SET capabilities = $2::jsonb WHERE id = $1`, [
        ids.installationId,
        JSON.stringify({
          codexRuntimeArtifacts: [RUNTIME_DIGEST],
          codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
          isolationModes: ['lima-vz-v1'],
          brokerContractDigest: BROKER_CONTRACT_DIGEST,
        }),
      ]);
      await expect(
        authority.acceptEnvelope(
          primarySession,
          delivery(heartbeat(primarySession, lease, 1n)),
          AbortSignal.timeout(5_000),
        ),
      ).rejects.toMatchObject({
        code: 'LEASE_UNAVAILABLE',
      } satisfies Partial<PostgresGatewayAuthorityError>);
      await owner.query(`UPDATE worker_installations SET capabilities = $2::jsonb WHERE id = $1`, [
        ids.installationId,
        matchingCapabilities,
      ]);

      const competingKeyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const competingInstallationId = randomUuidV7();
      await owner.query(
        `INSERT INTO worker_installations (
           id, creator_id, installation_key_id, device_public_key,
           worker_version, protocol_versions, capabilities
         ) VALUES ($1, $2, $3, $4, $5, '[1]'::jsonb, $6::jsonb)`,
        [
          competingInstallationId,
          ids.creatorId,
          `gateway-key-${competingInstallationId}`,
          publicPoint(competingKeyPair.publicKey),
          WORKER_VERSION,
          matchingCapabilities,
        ],
      );
      const competingChallenge = await authority.issueChallenge({
        creatorId: ids.creatorId,
        installationId: competingInstallationId,
        ...challengeTarget,
        operationId: randomUuidV7(),
        signal: AbortSignal.timeout(5_000),
      });
      competingSession = await authority.authenticate({
        handshake: signedHandshake(
          competingKeyPair.privateKey,
          competingInstallationId,
          competingChallenge.challengeId,
        ),
        connectedAt: new Date().toISOString(),
        signal: AbortSignal.timeout(5_000),
      });
      await expect(
        authority.openSession(competingSession, AbortSignal.timeout(5_000)),
      ).rejects.toMatchObject({ code: 'LEASE_UNAVAILABLE' });

      await owner.query(
        `UPDATE deployments
            SET desired_state = 'OFFLINE', generation = generation + 1,
                updated_at = statement_timestamp()
          WHERE id = $1`,
        [ids.deploymentId],
      );
      const blockedHeartbeat = heartbeat(primarySession, lease, 1n);
      const blockedAck = await authority.acceptEnvelope(
        primarySession,
        delivery(blockedHeartbeat),
        AbortSignal.timeout(5_000),
      );
      expect(blockedAck).toHaveLength(2);
      expect(blockedAck[0]).toMatchObject({
        type: 'message.ack',
        body: { decision: 'SECURITY_BLOCK', level: 'CLOUD_COMMITTED' },
      });
      expect(blockedAck[1]).toMatchObject({
        type: 'lease.revoke',
        body: { reason: 'IMMEDIATE' },
      });
      await expect(
        authority.replayEnvelope(
          primarySession,
          delivery(blockedHeartbeat),
          AbortSignal.timeout(5_000),
        ),
      ).resolves.toEqual(blockedAck);
      const afterBlock = await owner.query<{
        expires_at: Date | string;
        observed_state: string;
        lease_state: string;
      }>(
        `SELECT lease.expires_at, lease.state AS lease_state, deployment.observed_state
           FROM worker_leases AS lease
           JOIN deployments AS deployment ON deployment.id = lease.deployment_id
          WHERE lease.id = $1`,
        [lease.lease.leaseId],
      );
      expect(new Date(afterBlock.rows[0]?.expires_at ?? 0).getTime()).toBe(originalExpiry);
      expect(afterBlock.rows[0]).toMatchObject({
        lease_state: 'REVOKED',
        observed_state: 'OFFLINE',
      });
      await authority.closeSession(primarySession, 'SERVER_STOPPED');
      primarySession = undefined;

      const installationGeneration = await owner.query<{ generation: string }>(
        `UPDATE deployments
            SET desired_state = 'ONLINE', generation = generation + 1,
                updated_at = statement_timestamp()
          WHERE id = $1
        RETURNING generation::text`,
        [ids.deploymentId],
      );
      const installationTarget = {
        deploymentId: ids.deploymentId,
        deploymentGeneration: installationGeneration.rows[0]?.generation ?? '',
      };
      const installationChallenge = await authority.issueChallenge({
        creatorId: ids.creatorId,
        installationId: ids.installationId,
        ...installationTarget,
        operationId: randomUuidV7(),
        signal: AbortSignal.timeout(5_000),
      });
      primarySession = await authority.authenticate({
        handshake: signedHandshake(
          keyPair.privateKey,
          ids.installationId,
          installationChallenge.challengeId,
        ),
        connectedAt: new Date().toISOString(),
        signal: AbortSignal.timeout(5_000),
      });
      const installationOpened = await authority.openSession(
        primarySession,
        AbortSignal.timeout(5_000),
      );
      const installationLease = installationOpened[0];
      if (installationLease?.type !== 'lease.grant') {
        throw new Error('expected installation revoke test lease.grant');
      }
      await owner.query(
        `UPDATE worker_installations
            SET revoked_at = statement_timestamp(), last_seen_at = statement_timestamp()
          WHERE id = $1`,
        [ids.installationId],
      );
      const installationHeartbeat = heartbeat(primarySession, installationLease, 0n);
      const installationBlocked = await authority.acceptEnvelope(
        primarySession,
        delivery(installationHeartbeat),
        AbortSignal.timeout(5_000),
      );
      expect(installationBlocked).toHaveLength(2);
      expect(installationBlocked[1]).toMatchObject({
        type: 'lease.revoke',
        body: { reason: 'INSTALLATION_REVOKED' },
      });
      const installationFacts = await owner.query<{
        lease_state: string;
        observed_state: string;
      }>(
        `SELECT lease.state AS lease_state, deployment.observed_state
           FROM worker_leases AS lease
           JOIN deployments AS deployment ON deployment.id = lease.deployment_id
          WHERE lease.id = $1`,
        [installationLease.lease.leaseId],
      );
      expect(installationFacts.rows).toEqual([
        { lease_state: 'REVOKED', observed_state: 'BLOCKED' },
      ]);
      await authority.closeSession(primarySession, 'SERVER_STOPPED');
      primarySession = undefined;
      const securityDesiredVersionId = randomUuidV7();
      await owner.query(
        `INSERT INTO agent_versions (
           id, agent_id, creator_id, ordinal, schema_version, version_digest, snapshot_id,
           behavior_contract, behavior_contract_digest, runtime_policy, runtime_policy_digest,
           io_contract, io_contract_digest, model_policy, model_policy_digest,
           codex_runtime_version, codex_runtime_artifact_digest, codex_protocol_schema_digest
         ) VALUES (
           $1, $2, $3, 2, 1, $4, $5,
           '{}'::jsonb, $6, $7::jsonb, $8, '{}'::jsonb, $9, '{}'::jsonb, $10,
           '0.147.0-alpha.6.5', $11, $12
         )`,
        [
          securityDesiredVersionId,
          ids.agentId,
          ids.creatorId,
          digest('e'),
          ids.snapshotId,
          digest('a'),
          JSON.stringify(TEST_RUNTIME_POLICY),
          digest('b'),
          digest('c'),
          digest('d'),
          RUNTIME_DIGEST,
          PROTOCOL_DIGEST,
        ],
      );
      await owner.query(
        `INSERT INTO agent_version_controls (version_id, creator_id) VALUES ($1, $2)`,
        [securityDesiredVersionId, ids.creatorId],
      );
      const securityGeneration = await owner.query<{ generation: string }>(
        `UPDATE deployments
            SET desired_state = 'ONLINE', desired_version_id = $2,
                serving_version_id = $3, observed_state = 'OFFLINE',
                generation = generation + 1, observed_generation = generation + 1,
                observed_worker_id = NULL, last_error_code = NULL,
                updated_at = statement_timestamp()
          WHERE id = $1
        RETURNING generation::text`,
        [ids.deploymentId, securityDesiredVersionId, ids.versionId],
      );
      const securityTarget = {
        deploymentId: ids.deploymentId,
        deploymentGeneration: securityGeneration.rows[0]?.generation ?? '',
      };
      const securityChallenge = await authority.issueChallenge({
        creatorId: ids.creatorId,
        installationId: competingInstallationId,
        ...securityTarget,
        operationId: randomUuidV7(),
        signal: AbortSignal.timeout(5_000),
      });
      competingSession = await authority.authenticate({
        handshake: signedHandshake(
          competingKeyPair.privateKey,
          competingInstallationId,
          securityChallenge.challengeId,
        ),
        connectedAt: new Date().toISOString(),
        signal: AbortSignal.timeout(5_000),
      });
      const securityOpened = await authority.openSession(
        competingSession,
        AbortSignal.timeout(5_000),
      );
      const securityLease = securityOpened[0];
      if (securityLease?.type !== 'lease.grant') {
        throw new Error('expected security test lease.grant');
      }
      const beforeSecurity = await owner.query<{ expires_at: Date | string }>(
        `SELECT expires_at FROM worker_leases WHERE id = $1`,
        [securityLease.lease.leaseId],
      );
      const securityExpiry = new Date(beforeSecurity.rows[0]?.expires_at ?? 0).getTime();
      const pinnedConversationId = randomUuidV7();
      const pinnedMessageId = randomUuidV7();
      const pinnedInvocationId = randomUuidV7();
      await owner.query(
        `UPDATE deployments
            SET serving_version_id = $2, observed_state = 'ONLINE',
                updated_at = statement_timestamp()
          WHERE id = $1`,
        [ids.deploymentId, securityDesiredVersionId],
      );
      await owner.query(
        `INSERT INTO agent_conversations (
           id, agent_id, deployment_id, agent_version_id, creator_id,
           consumer_subject_id, version_digest, state, assigned_worker_id, expires_at,
           idempotency_key, request_digest
         ) VALUES ($1, $2, $3, $4, $5, $5, $6, 'BUSY', $7,
                   statement_timestamp() + interval '30 days', $8, $9)`,
        [
          pinnedConversationId,
          ids.agentId,
          ids.deploymentId,
          ids.versionId,
          ids.creatorId,
          digest('7'),
          competingInstallationId,
          randomUuidV7(),
          digest('c'),
        ],
      );
      await owner.query(
        `INSERT INTO agent_messages (
           id, conversation_id, creator_id, consumer_subject_id, turn_no, role,
           client_message_id, content_algorithm, content_key_id, content_nonce,
           content_ciphertext, content_auth_tag, content_cipher_digest,
           content_digest, content_aad_version
         ) VALUES (
           $1, $2, $3, $3, 1, 'USER', $4, 'aes-256-gcm/v1', $5, $6, $7, $8,
           $9, $10, 1
         )`,
        [
          pinnedMessageId,
          pinnedConversationId,
          ids.creatorId,
          `gateway-pinned-${pinnedMessageId}`,
          `gateway-key-${pinnedMessageId}`,
          randomBytes(12),
          randomBytes(32),
          randomBytes(16),
          digest('f'),
          `hmac-sha256:${digest('e')}`,
        ],
      );
      await owner.query(
        `INSERT INTO agent_invocations (
           id, conversation_id, creator_id, consumer_subject_id, agent_version_id,
           user_message_id, client_message_id, request_digest, state,
           assigned_worker_id, assignment_lease_id, assignment_fence,
           deadline_at, started_at
         ) VALUES (
           $1, $2, $3, $3, $4, $5, $6, $7, 'RUNNING', $8, $9, $10,
           statement_timestamp() + interval '2 minutes', statement_timestamp()
         )`,
        [
          pinnedInvocationId,
          pinnedConversationId,
          ids.creatorId,
          ids.versionId,
          pinnedMessageId,
          `gateway-pinned-${pinnedInvocationId}`,
          `hmac-sha256:${digest('d')}`,
          competingInstallationId,
          securityLease.lease.leaseId,
          securityLease.lease.fence,
        ],
      );
      const brokerProbe = new Client({
        connectionString: roleUrl('combo_agent_broker', brokerPassword ?? ''),
      });
      await brokerProbe.connect();
      try {
        await brokerProbe.query('BEGIN');
        await brokerProbe.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
        const crossConsumerUpdate = await brokerProbe.query(
          `UPDATE agent_invocations
              SET state = state
            WHERE id = $1
          RETURNING id`,
          [pinnedInvocationId],
        );
        expect(crossConsumerUpdate.rowCount).toBe(0);
        await brokerProbe.query('ROLLBACK');
      } finally {
        await brokerProbe.end();
      }
      const revokedHeartbeat = heartbeat(competingSession, securityLease, 0n);
      expect(revokedHeartbeat.body.activeInvocationId).toBeNull();
      let projected!: () => void;
      let releaseProjection!: () => void;
      const projectedPromise = new Promise<void>((resolve) => (projected = resolve));
      const projectionBarrier = new Promise<void>((resolve) => (releaseProjection = resolve));
      let projectionPaused = false;
      const racingAuthority = new PostgresAgentGatewayAuthority(
        pools,
        policy,
        undefined,
        async (step) => {
          if (step !== 'EVENT_PROJECTED' || projectionPaused) return;
          projectionPaused = true;
          projected();
          await projectionBarrier;
        },
      );
      const pendingHeartbeat = racingAuthority.acceptEnvelope(
        competingSession,
        delivery(revokedHeartbeat),
        AbortSignal.timeout(5_000),
      );
      await projectedPromise;

      const revokerName = `gateway-security-revoke-${randomUuidV7()}`;
      const revokerUrl = new URL(databaseUrl ?? 'postgresql://invalid');
      revokerUrl.searchParams.set('application_name', revokerName);
      const revoker = new Client({ connectionString: revokerUrl.toString() });
      await revoker.connect();
      let committedRenewalExpiry: string | undefined;
      const pendingRevocation = revoker.query(
        `UPDATE agent_version_controls
            SET availability = 'REVOKED', severity = 'SECURITY',
                reason_code = 'GATEWAY_TEST_REVOKED', updated_at = statement_timestamp()
          WHERE version_id = $1`,
        [ids.versionId],
      );
      try {
        await waitForPgWaitEvent(owner, revokerName, 'advisory');
        releaseProjection();
        const [renewed] = await Promise.all([pendingHeartbeat, pendingRevocation]);
        expect(renewed.map((frame) => frame.type)).toEqual(['lease.grant', 'message.ack']);
        const renewedGrant = renewed[0];
        if (renewedGrant?.type !== 'lease.grant') throw new Error('expected renewed lease grant');
        committedRenewalExpiry = renewedGrant.body.leaseExpiresAt;
        await expect(
          racingAuthority.replayEnvelope(
            competingSession,
            delivery(revokedHeartbeat),
            AbortSignal.timeout(5_000),
          ),
        ).resolves.toEqual(renewed);
      } finally {
        releaseProjection();
        await revoker.end();
      }
      await expect(
        authority.acceptEnvelope(
          competingSession,
          delivery(heartbeat(competingSession, securityLease, 1n)),
          AbortSignal.timeout(5_000),
        ),
      ).rejects.toMatchObject({ code: 'LEASE_UNAVAILABLE' });
      const afterRevocation = await owner.query<{
        expires_at: Date | string;
        lease_state: string;
        observed_state: string;
        session_state: string;
      }>(
        `SELECT lease.expires_at, lease.state AS lease_state, deployment.observed_state,
                gateway.state AS session_state
           FROM worker_leases AS lease
           JOIN deployments AS deployment ON deployment.id = lease.deployment_id
           JOIN worker_gateway_sessions AS gateway ON gateway.connection_id = lease.connection_id
          WHERE lease.id = $1`,
        [securityLease.lease.leaseId],
      );
      expect(new Date(afterRevocation.rows[0]?.expires_at ?? 0).getTime()).toBe(
        Date.parse(committedRenewalExpiry ?? ''),
      );
      expect(Date.parse(committedRenewalExpiry ?? '')).toBeGreaterThanOrEqual(securityExpiry);
      expect(afterRevocation.rows[0]).toMatchObject({
        lease_state: 'REVOKED',
        observed_state: 'BLOCKED',
        session_state: 'REVOKED',
      });

      competingSession = undefined;
      await expect(
        authority.issueChallenge({
          creatorId: ids.creatorId,
          installationId: ids.installationId,
          ...securityTarget,
          operationId: randomUuidV7(),
          signal: AbortSignal.timeout(5_000),
        }),
      ).rejects.toBeDefined();
    } finally {
      await Promise.all([
        primarySession === undefined
          ? Promise.resolve()
          : authority.closeSession(primarySession, 'SERVER_STOPPED').catch(() => undefined),
        competingSession === undefined
          ? Promise.resolve()
          : authority.closeSession(competingSession, 'SERVER_STOPPED').catch(() => undefined),
      ]);
    }
  });

  it('atomically isolates a durable prepared-fact conflict and replays its receipt after revocation', async () => {
    const fixture = {
      agentId: randomUuidV7(),
      versionId: randomUuidV7(),
      versionDigest: randomBytes(32).toString('hex'),
      deploymentId: randomUuidV7(),
      installationId: randomUuidV7(),
      conversationId: randomUuidV7(),
      userMessageId: randomUuidV7(),
      invocationId: randomUuidV7(),
      prepareCommandId: randomUuidV7(),
      capabilityId: randomUuidV7(),
      capabilityDigest: randomBytes(32).toString('hex'),
      requestDigest: `hmac-sha256:${randomBytes(32).toString('hex')}`,
    } as const;
    const fixtureKeyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const matchingCapabilities = JSON.stringify({
      codexRuntimeArtifacts: [RUNTIME_DIGEST],
      codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
      isolationModes: ['apple-container-v1'],
      brokerContractDigest: BROKER_CONTRACT_DIGEST,
    });
    await owner.query(
      `INSERT INTO agents (id, creator_id, public_slug, name)
         VALUES ($1, $2, $3, 'Gateway prepared conflict')`,
      [fixture.agentId, ids.creatorId, `gateway-prepared-${fixture.agentId.slice(0, 8)}`],
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
           '0.147.0-alpha.6.5', $11, $12
         )`,
      [
        fixture.versionId,
        fixture.agentId,
        ids.creatorId,
        fixture.versionDigest,
        ids.snapshotId,
        randomBytes(32).toString('hex'),
        JSON.stringify(TEST_RUNTIME_POLICY),
        randomBytes(32).toString('hex'),
        randomBytes(32).toString('hex'),
        randomBytes(32).toString('hex'),
        RUNTIME_DIGEST,
        PROTOCOL_DIGEST,
      ],
    );
    await owner.query(
      `INSERT INTO agent_version_controls (version_id, creator_id) VALUES ($1, $2)`,
      [fixture.versionId, ids.creatorId],
    );
    await owner.query(
      `INSERT INTO deployments (
           id, agent_id, creator_id, environment, desired_state,
           desired_version_id, generation
         ) VALUES ($1, $2, $3, 'TEST', 'ONLINE', $4, 1)`,
      [fixture.deploymentId, fixture.agentId, ids.creatorId, fixture.versionId],
    );
    await owner.query(
      `INSERT INTO worker_installations (
           id, creator_id, installation_key_id, device_public_key,
           worker_version, protocol_versions, capabilities
         ) VALUES ($1, $2, $3, $4, $5, '[1]'::jsonb, $6::jsonb)`,
      [
        fixture.installationId,
        ids.creatorId,
        `gateway-key-${fixture.installationId}`,
        publicPoint(fixtureKeyPair.publicKey),
        WORKER_VERSION,
        matchingCapabilities,
      ],
    );

    const securityPolicy = {
      ...policy,
      leaseTtlMs: 60_000,
      transactionTimeoutMs: 5_000,
    } satisfies GatewayCompatibilityPolicy;
    const bootstrapAuthority = new PostgresAgentGatewayAuthority(pools, securityPolicy);
    const challenge = await bootstrapAuthority.issueChallenge({
      creatorId: ids.creatorId,
      installationId: fixture.installationId,
      deploymentId: fixture.deploymentId,
      deploymentGeneration: '1',
      operationId: randomUuidV7(),
      signal: AbortSignal.timeout(5_000),
    });
    const session = await bootstrapAuthority.authenticate({
      handshake: signedHandshake(
        fixtureKeyPair.privateKey,
        fixture.installationId,
        challenge.challengeId,
      ),
      connectedAt: new Date().toISOString(),
      signal: AbortSignal.timeout(5_000),
    });
    const opened = await bootstrapAuthority.openSession(session, AbortSignal.timeout(5_000));
    const lease = opened[0];
    if (lease?.type !== 'lease.grant') throw new Error('expected prepared-conflict lease.grant');

    const clientMessageId = randomUUID();
    await owner.query(
      `INSERT INTO agent_conversations (
           id, agent_id, deployment_id, agent_version_id, creator_id,
           consumer_subject_id, version_digest, state, assigned_worker_id,
           next_turn_no, expires_at, idempotency_key, request_digest
         ) VALUES (
           $1, $2, $3, $4, $5, $5, $6, 'BUSY', $7, 2,
           statement_timestamp() + interval '1 hour', $8, $9
         )`,
      [
        fixture.conversationId,
        fixture.agentId,
        fixture.deploymentId,
        fixture.versionId,
        ids.creatorId,
        fixture.versionDigest,
        fixture.installationId,
        randomUuidV7(),
        randomBytes(32).toString('hex'),
      ],
    );
    await owner.query(
      `INSERT INTO agent_messages (
           id, conversation_id, creator_id, consumer_subject_id, turn_no, role,
           client_message_id, content_algorithm, content_key_id, content_nonce,
           content_ciphertext, content_auth_tag, content_cipher_digest,
           content_digest, content_aad_version
         ) VALUES (
           $1, $2, $3, $3, 1, 'USER', $4, 'aes-256-gcm/v1', $5, $6, $7, $8,
           $9, $10, 1
         )`,
      [
        fixture.userMessageId,
        fixture.conversationId,
        ids.creatorId,
        clientMessageId,
        `gateway-key-${fixture.userMessageId}`,
        randomBytes(12),
        randomBytes(32),
        randomBytes(16),
        randomBytes(32).toString('hex'),
        `hmac-sha256:${randomBytes(32).toString('hex')}`,
      ],
    );
    await owner.query(
      `INSERT INTO agent_invocations (
           id, conversation_id, creator_id, consumer_subject_id, agent_version_id,
           user_message_id, client_message_id, request_digest, state,
           assigned_worker_id, assignment_lease_id, assignment_fence,
           execution_capability_id, execution_capability_digest,
           execution_capability_expires_at, deadline_at
         ) VALUES (
           $1, $2, $3, $3, $4, $5, $6, $7, 'DISPATCH_PENDING',
           $8, $9, $10, $11, $12,
           statement_timestamp() + interval '2 minutes 15 seconds',
           statement_timestamp() + interval '2 minutes'
         )`,
      [
        fixture.invocationId,
        fixture.conversationId,
        ids.creatorId,
        fixture.versionId,
        fixture.userMessageId,
        clientMessageId,
        fixture.requestDigest,
        fixture.installationId,
        lease.lease.leaseId,
        lease.lease.fence,
        fixture.capabilityId,
        fixture.capabilityDigest,
      ],
    );
    await owner.query(
      `INSERT INTO broker_outbox (
           command_id, creator_id, target_worker_id, invocation_id, consumer_subject_id,
           command_type, dedupe_key, state, attempt_count, next_attempt_at, expires_at,
           conversation_id, deployment_id, assignment_lease_id, assignment_fence,
           execution_capability_id, execution_capability_digest
         ) VALUES (
           $1, $2, $3, $4, $2, 'invocation.prepare', $5, 'SENT', 1,
           statement_timestamp(), statement_timestamp() + interval '2 minutes',
           $6, $7, $8, $9, $10, $11
         )`,
      [
        fixture.prepareCommandId,
        ids.creatorId,
        fixture.installationId,
        fixture.invocationId,
        `gateway-prepared:${fixture.invocationId}`,
        fixture.conversationId,
        fixture.deploymentId,
        lease.lease.leaseId,
        lease.lease.fence,
        fixture.capabilityId,
        fixture.capabilityDigest,
      ],
    );

    const journal = new PostgresCloudJournal({
      api: apiPool as unknown as JournalPool,
      broker: brokerPool as unknown as JournalPool,
    });
    const assistantMessageSealer = vi.fn<AssistantMessageSealer>();
    const businessProjector = new PostgresGatewayBusinessEventProjector(
      journal,
      assistantMessageSealer,
    );
    const projectingAuthority = new PostgresAgentGatewayAuthority(
      pools,
      securityPolicy,
      businessProjector,
    );
    const admittedFact = {
      protocol: WORKER_INVOCATION_FACT_PROTOCOL,
      schemaVersion: 1,
      type: 'invocation.prepared',
      sourceEventId: fixture.prepareCommandId,
      invocationId: fixture.invocationId,
      agentVersionDigest: fixture.versionDigest,
      snapshotDigest: digest('1'),
      executionCapabilityDigest: fixture.capabilityDigest,
      leaseId: lease.lease.leaseId,
      fence: lease.lease.fence,
      requestDigest: fixture.requestDigest,
      prepareCommandId: fixture.prepareCommandId,
    } as const satisfies WorkerInvocationPreparedFact;
    const admittedEvent = invocationPrepared(session, lease, 0n, admittedFact);
    const admitted = await projectingAuthority.acceptEnvelope(
      session,
      delivery(admittedEvent),
      AbortSignal.timeout(5_000),
    );
    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toMatchObject({
      type: 'message.ack',
      body: {
        acknowledgedMessageId: admittedEvent.messageId,
        level: 'CLOUD_COMMITTED',
        decision: 'APPLIED',
      },
    });

    const conflictingFact = {
      ...admittedFact,
      requestDigest: `hmac-sha256:${randomBytes(32).toString('hex')}`,
    } satisfies WorkerInvocationPreparedFact;
    const conflictEvent = invocationPrepared(session, lease, 1n, conflictingFact);
    const admittedOperationKey = `${admittedEvent.messageId}:${canonicalSha256(admittedEvent)}`;
    const conflictOperationKey = `${conflictEvent.messageId}:${canonicalSha256(conflictEvent)}`;
    const footprint = async () => {
      const observed = await owner.query<{
        invocation_state: string;
        capability_revoked: boolean;
        lease_state: string;
        session_state: string;
        deployment_state: string;
        last_error_code: string | null;
        alerts: string;
        worker_events: string;
        start_commands: string;
        receipts: string;
        outbound_frames: string;
        operations: string;
        inbound_next_seq: string;
        outbound_next_seq: string;
      }>(
        `SELECT invocation.state AS invocation_state,
                  invocation.execution_capability_revoked_at IS NOT NULL AS capability_revoked,
                  lease.state AS lease_state, gateway.state AS session_state,
                  deployment.observed_state AS deployment_state,
                  deployment.last_error_code,
                  (SELECT count(*)::text FROM creator_agent_journal_integrity_alerts AS alert
                    WHERE alert.invocation_id = invocation.id) AS alerts,
                  (SELECT count(*)::text FROM agent_invocation_events AS event
                    WHERE event.invocation_id = invocation.id AND event.source = 'WORKER')
                    AS worker_events,
                  (SELECT count(*)::text FROM broker_outbox AS command
                    WHERE command.invocation_id = invocation.id
                      AND command.command_type = 'invocation.start') AS start_commands,
                  (SELECT count(*)::text FROM worker_gateway_frame_receipts AS receipt
                    WHERE receipt.session_id = gateway.id) AS receipts,
                  (SELECT count(*)::text FROM worker_gateway_outbound_frames AS frame
                    WHERE frame.session_id = gateway.id) AS outbound_frames,
                  (SELECT count(*)::text FROM worker_gateway_operation_receipts AS operation
                    WHERE operation.creator_id = invocation.creator_id
                      AND operation.operation_kind = 'ACCEPT_ENVELOPE'
                      AND operation.operation_key = ANY($4::text[])) AS operations,
                  gateway.inbound_next_seq::text, gateway.outbound_next_seq::text
             FROM agent_invocations AS invocation
             JOIN worker_leases AS lease ON lease.id = $2
             JOIN worker_gateway_sessions AS gateway ON gateway.id = $3
             JOIN deployments AS deployment ON deployment.id = $1
            WHERE invocation.id = $5`,
        [
          fixture.deploymentId,
          lease.lease.leaseId,
          session.workerSessionId,
          [admittedOperationKey, conflictOperationKey],
          fixture.invocationId,
        ],
      );
      const row = observed.rows[0];
      if (!row) throw new Error('prepared conflict footprint missing');
      return row;
    };
    const beforeConflict = await footprint();
    expect(beforeConflict).toMatchObject({
      invocation_state: 'PERSISTED',
      capability_revoked: false,
      lease_state: 'ACTIVE',
      session_state: 'ACTIVE',
      alerts: '0',
      worker_events: '1',
      start_commands: '1',
      receipts: '1',
      outbound_frames: '2',
      operations: '1',
      inbound_next_seq: '1',
      outbound_next_seq: '2',
    });

    for (const target of ['EVENT_PROJECTED', 'RECEIPT_INSERTED'] as const) {
      const failingAuthority = new PostgresAgentGatewayAuthority(
        pools,
        securityPolicy,
        businessProjector,
        (step) => {
          if (step === target) throw new Error(`FAILPOINT:${target}`);
        },
      );
      await expect(
        failingAuthority.acceptEnvelope(
          session,
          delivery(conflictEvent),
          AbortSignal.timeout(5_000),
        ),
      ).rejects.toThrow(`FAILPOINT:${target}`);
      expect(await footprint(), target).toEqual(beforeConflict);
    }

    const lossySecurityAuthority = new PostgresAgentGatewayAuthority(
      { api: apiGatewayPool, broker: lossyBrokerPool },
      securityPolicy,
      businessProjector,
    );
    lossyBrokerPool.arm();
    const blocked = await lossySecurityAuthority.acceptEnvelope(
      session,
      delivery(conflictEvent),
      AbortSignal.timeout(5_000),
    );
    expect(blocked.map((frame) => frame.type)).toEqual(['message.ack', 'lease.revoke']);
    expect(blocked[0]).toMatchObject({
      type: 'message.ack',
      body: {
        acknowledgedMessageId: conflictEvent.messageId,
        level: 'CLOUD_COMMITTED',
        decision: 'SECURITY_BLOCK',
      },
    });
    expect(blocked[1]).toMatchObject({
      type: 'lease.revoke',
      body: { reason: 'SECURITY' },
    });
    expect(assistantMessageSealer).not.toHaveBeenCalled();

    expect(await footprint()).toMatchObject({
      invocation_state: 'PERSISTED',
      capability_revoked: true,
      lease_state: 'REVOKED',
      session_state: 'REVOKED',
      deployment_state: 'BLOCKED',
      last_error_code: 'WORKER_FACT_CONFLICT',
      alerts: '1',
      worker_events: '1',
      start_commands: '1',
      receipts: '2',
      outbound_frames: '4',
      operations: '2',
      inbound_next_seq: '2',
      outbound_next_seq: '4',
    });
    const durableFact = await owner.query<{
      state: string;
      source_event_id: string;
      source_fact_digest: string;
      request_digest: string;
      prepare_state: string;
      start_commands: string;
    }>(
      `SELECT invocation.state, event.source_event_id, event.source_fact_digest,
                invocation.request_digest,
                prepare.state AS prepare_state,
                (SELECT count(*)::text FROM broker_outbox AS start_command
                  WHERE start_command.invocation_id = invocation.id
                    AND start_command.command_type = 'invocation.start') AS start_commands
           FROM agent_invocations AS invocation
           JOIN agent_invocation_events AS event
             ON event.invocation_id = invocation.id
            AND event.source = 'WORKER'
            AND event.event_type = 'invocation.persisted'
           JOIN broker_outbox AS prepare ON prepare.command_id = $2
          WHERE invocation.id = $1`,
      [fixture.invocationId, fixture.prepareCommandId],
    );
    expect(durableFact.rows).toEqual([
      {
        state: 'PERSISTED',
        source_event_id: fixture.prepareCommandId,
        source_fact_digest: workerInvocationFactDigest(admittedFact),
        request_digest: fixture.requestDigest,
        prepare_state: 'ACKED',
        start_commands: '1',
      },
    ]);
    const alerts = await owner.query<{
      reason: string;
      source: string;
      source_event_id_digest: string;
      existing_canonical_digest: string;
      received_canonical_digest: string;
    }>(
      `SELECT reason, source, source_event_id_digest,
                existing_canonical_digest, received_canonical_digest
           FROM creator_agent_journal_integrity_alerts
          WHERE invocation_id = $1`,
      [fixture.invocationId],
    );
    expect(alerts.rows).toHaveLength(1);
    expect(alerts.rows[0]).toMatchObject({
      reason: 'SOURCE_EVENT_CONFLICT',
      source: 'WORKER',
    });
    for (const value of [
      alerts.rows[0]?.source_event_id_digest,
      alerts.rows[0]?.existing_canonical_digest,
      alerts.rows[0]?.received_canonical_digest,
    ]) {
      expect(value).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(alerts.rows[0]?.existing_canonical_digest).not.toBe(
      alerts.rows[0]?.received_canonical_digest,
    );
    const serializedAlert = JSON.stringify(alerts.rows[0]);
    expect(serializedAlert).not.toContain(fixture.prepareCommandId);
    expect(serializedAlert).not.toContain(fixture.requestDigest);
    expect(serializedAlert).not.toContain(conflictingFact.requestDigest);

    const conflictReceipt = await owner.query<{
      response_frames: unknown;
      result_value: unknown;
    }>(
      `SELECT receipt.response_frames, operation.result_value
           FROM worker_gateway_frame_receipts AS receipt
           JOIN worker_gateway_operation_receipts AS operation
             ON operation.creator_id = receipt.creator_id
            AND operation.operation_kind = 'ACCEPT_ENVELOPE'
            AND operation.operation_key = $4
          WHERE receipt.session_id = $1 AND receipt.sequence = 1
            AND receipt.message_id = $2 AND receipt.canonical_digest = $3`,
      [
        session.workerSessionId,
        conflictEvent.messageId,
        canonicalSha256(conflictEvent),
        conflictOperationKey,
      ],
    );
    expect(conflictReceipt.rows).toEqual([
      {
        response_frames: blocked,
        result_value: { kind: 'RESPONSES', responses: blocked },
      },
    ]);

    const afterCommit = await footprint();
    await expect(
      projectingAuthority.replayEnvelope(
        session,
        delivery(conflictEvent),
        AbortSignal.timeout(5_000),
      ),
    ).resolves.toEqual(blocked);
    expect(await footprint()).toEqual(afterCommit);
    expect(assistantMessageSealer).not.toHaveBeenCalled();

    const transportConflict = BrokerEnvelopeSchema.parse({
      ...conflictEvent,
      messageId: randomUuidV7(),
    });
    await expect(
      projectingAuthority.acceptEnvelope(
        session,
        delivery(transportConflict),
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toMatchObject({ code: 'SEQUENCE_CONFLICT' });
    await expect(
      owner.query<{ alerts: string; transport_conflicts: string }>(
        `SELECT
             (SELECT count(*)::text FROM creator_agent_journal_integrity_alerts
               WHERE invocation_id = $1) AS alerts,
             (SELECT count(*)::text FROM worker_gateway_security_events
               WHERE session_id = $2 AND event_type = 'SEQUENCE_CONFLICT')
               AS transport_conflicts`,
        [fixture.invocationId, session.workerSessionId],
      ),
    ).resolves.toMatchObject({
      rows: [{ alerts: '1', transport_conflicts: '1' }],
    });
    expect(assistantMessageSealer).not.toHaveBeenCalled();
  }, 20_000);

  it('atomically isolates a durable started-fact conflict and preserves the original Host evidence', async () => {
    const seeded = await seedInvocationProjectionFixture('started-conflict');
    const {
      fixture,
      session,
      lease,
      securityPolicy,
      assistantMessageSealer,
      businessProjector,
      projectingAuthority,
      preparedFact,
    } = seeded;
    const preparedEvent = invocationPrepared(session, lease, 0n, preparedFact);
    await expect(
      projectingAuthority.acceptEnvelope(
        session,
        delivery(preparedEvent),
        AbortSignal.timeout(5_000),
      ),
    ).resolves.toMatchObject([
      {
        type: 'message.ack',
        body: {
          acknowledgedMessageId: preparedEvent.messageId,
          level: 'CLOUD_COMMITTED',
          decision: 'APPLIED',
        },
      },
    ]);
    const startCommand = await owner.query<{ command_id: string }>(
      `UPDATE broker_outbox
          SET state = 'SENT', attempt_count = 1, next_attempt_at = statement_timestamp()
        WHERE invocation_id = $1 AND command_type = 'invocation.start'
          AND state = 'PENDING'
      RETURNING command_id::text`,
      [fixture.invocationId],
    );
    const startCommandId = startCommand.rows[0]?.command_id;
    if (!startCommandId) throw new Error('expected one started-conflict start command');

    const admittedFact = {
      protocol: WORKER_INVOCATION_FACT_PROTOCOL,
      schemaVersion: 1,
      type: 'invocation.started',
      sourceEventId: startCommandId,
      invocationId: fixture.invocationId,
      agentVersionDigest: fixture.versionDigest,
      snapshotDigest: digest('1'),
      executionCapabilityDigest: fixture.capabilityDigest,
      leaseId: lease.lease.leaseId,
      fence: lease.lease.fence,
      startCommandId,
      runtimeThreadId: `thread-${fixture.invocationId}`,
      runtimeTurnId: `turn-${fixture.invocationId}`,
      dispatchReceiptDigest: `sha256:${randomBytes(32).toString('hex')}`,
      sandboxAttestationDigest: `sha256:${randomBytes(32).toString('hex')}`,
    } as const satisfies WorkerInvocationStartedFact;
    const admittedEvent = invocationStarted(session, lease, 1n, admittedFact);
    await expect(
      projectingAuthority.acceptEnvelope(
        session,
        delivery(admittedEvent),
        AbortSignal.timeout(5_000),
      ),
    ).resolves.toMatchObject([
      {
        type: 'message.ack',
        body: {
          acknowledgedMessageId: admittedEvent.messageId,
          level: 'CLOUD_COMMITTED',
          decision: 'APPLIED',
        },
      },
    ]);

    const conflictingFact = {
      ...admittedFact,
      runtimeThreadId: `thread-conflict-${fixture.invocationId}`,
      runtimeTurnId: `turn-conflict-${fixture.invocationId}`,
      dispatchReceiptDigest: `sha256:${randomBytes(32).toString('hex')}`,
      sandboxAttestationDigest: `sha256:${randomBytes(32).toString('hex')}`,
    } satisfies WorkerInvocationStartedFact;
    const conflictEvent = invocationStarted(session, lease, 2n, conflictingFact);
    const operationKeys = [preparedEvent, admittedEvent, conflictEvent].map(
      (event) => `${event.messageId}:${canonicalSha256(event)}`,
    );
    const footprint = async () => {
      const observed = await owner.query<{
        invocation_state: string;
        capability_revoked: boolean;
        runtime_thread_id: string | null;
        runtime_turn_id: string | null;
        dispatch_receipt_digest: string | null;
        sandbox_attestation_digest: string | null;
        lease_state: string;
        session_state: string;
        deployment_state: string;
        last_error_code: string | null;
        alerts: string;
        started_events: string;
        started_source_event_id: string | null;
        started_fact_digest: string | null;
        started_payload: unknown;
        reconciliation_roots: string;
        start_commands: string;
        start_state: string | null;
        receipts: string;
        outbound_frames: string;
        operations: string;
        inbound_next_seq: string;
        outbound_next_seq: string;
      }>(
        `SELECT invocation.state AS invocation_state,
                invocation.execution_capability_revoked_at IS NOT NULL AS capability_revoked,
                invocation.runtime_thread_id, invocation.runtime_turn_id,
                started.source_dispatch_receipt_digest AS dispatch_receipt_digest,
                started.source_sandbox_attestation_digest AS sandbox_attestation_digest,
                lease.state AS lease_state, gateway.state AS session_state,
                deployment.observed_state AS deployment_state,
                deployment.last_error_code,
                (SELECT count(*)::text FROM creator_agent_journal_integrity_alerts AS alert
                  WHERE alert.invocation_id = invocation.id) AS alerts,
                (SELECT count(*)::text FROM agent_invocation_events AS event
                  WHERE event.invocation_id = invocation.id AND event.source = 'WORKER'
                    AND event.event_type = 'invocation.started') AS started_events,
                started.source_event_id AS started_source_event_id,
                started.source_fact_digest AS started_fact_digest,
                started.payload AS started_payload,
                (SELECT count(*)::text FROM agent_invocation_events AS root
                  WHERE root.invocation_id = invocation.id AND root.source = 'RECONCILER'
                    AND root.event_type = 'invocation.reconciling') AS reconciliation_roots,
                (SELECT count(*)::text FROM broker_outbox AS command
                  WHERE command.invocation_id = invocation.id
                    AND command.command_type = 'invocation.start') AS start_commands,
                start_command.state AS start_state,
                (SELECT count(*)::text FROM worker_gateway_frame_receipts AS receipt
                  WHERE receipt.session_id = gateway.id) AS receipts,
                (SELECT count(*)::text FROM worker_gateway_outbound_frames AS frame
                  WHERE frame.session_id = gateway.id) AS outbound_frames,
                (SELECT count(*)::text FROM worker_gateway_operation_receipts AS operation
                  WHERE operation.creator_id = invocation.creator_id
                    AND operation.operation_kind = 'ACCEPT_ENVELOPE'
                    AND operation.operation_key = ANY($4::text[])) AS operations,
                gateway.inbound_next_seq::text, gateway.outbound_next_seq::text
           FROM agent_invocations AS invocation
           JOIN worker_leases AS lease ON lease.id = $2
           JOIN worker_gateway_sessions AS gateway ON gateway.id = $3
           JOIN deployments AS deployment ON deployment.id = $1
           LEFT JOIN agent_invocation_events AS started
             ON started.invocation_id = invocation.id AND started.source = 'WORKER'
            AND started.event_type = 'invocation.started'
           LEFT JOIN broker_outbox AS start_command
             ON start_command.invocation_id = invocation.id
            AND start_command.command_type = 'invocation.start'
          WHERE invocation.id = $5`,
        [
          fixture.deploymentId,
          lease.lease.leaseId,
          session.workerSessionId,
          operationKeys,
          fixture.invocationId,
        ],
      );
      const row = observed.rows[0];
      if (!row) throw new Error('started conflict footprint missing');
      return row;
    };
    const beforeConflict = await footprint();
    expect(beforeConflict).toMatchObject({
      invocation_state: 'RUNNING',
      capability_revoked: false,
      runtime_thread_id: admittedFact.runtimeThreadId,
      runtime_turn_id: admittedFact.runtimeTurnId,
      dispatch_receipt_digest: admittedFact.dispatchReceiptDigest,
      sandbox_attestation_digest: admittedFact.sandboxAttestationDigest,
      lease_state: 'ACTIVE',
      session_state: 'ACTIVE',
      alerts: '0',
      started_events: '1',
      started_source_event_id: startCommandId,
      started_fact_digest: workerInvocationFactDigest(admittedFact),
      started_payload: { state: 'RUNNING' },
      reconciliation_roots: '0',
      start_commands: '1',
      start_state: 'ACKED',
      receipts: '2',
      outbound_frames: '3',
      operations: '2',
      inbound_next_seq: '2',
      outbound_next_seq: '3',
    });

    for (const target of ['EVENT_PROJECTED', 'RECEIPT_INSERTED'] as const) {
      const failingAuthority = new PostgresAgentGatewayAuthority(
        pools,
        securityPolicy,
        businessProjector,
        (step) => {
          if (step === target) throw new Error(`FAILPOINT:STARTED:${target}`);
        },
      );
      await expect(
        failingAuthority.acceptEnvelope(
          session,
          delivery(conflictEvent),
          AbortSignal.timeout(5_000),
        ),
      ).rejects.toThrow(`FAILPOINT:STARTED:${target}`);
      expect(await footprint(), target).toEqual(beforeConflict);
    }

    const lossySecurityAuthority = new PostgresAgentGatewayAuthority(
      { api: apiGatewayPool, broker: lossyBrokerPool },
      securityPolicy,
      businessProjector,
    );
    lossyBrokerPool.arm();
    const blocked = await lossySecurityAuthority.acceptEnvelope(
      session,
      delivery(conflictEvent),
      AbortSignal.timeout(5_000),
    );
    expect(blocked.map((frame) => frame.type)).toEqual(['message.ack', 'lease.revoke']);
    expect(blocked[0]).toMatchObject({
      type: 'message.ack',
      body: {
        acknowledgedMessageId: conflictEvent.messageId,
        level: 'CLOUD_COMMITTED',
        decision: 'SECURITY_BLOCK',
      },
    });
    expect(blocked[1]).toMatchObject({ type: 'lease.revoke', body: { reason: 'SECURITY' } });
    expect(assistantMessageSealer).not.toHaveBeenCalled();

    expect(await footprint()).toMatchObject({
      ...beforeConflict,
      // RUNNING remains live until the shared Deployment revoker stamps its capability.
      capability_revoked: true,
      lease_state: 'REVOKED',
      session_state: 'REVOKED',
      deployment_state: 'BLOCKED',
      last_error_code: 'WORKER_FACT_CONFLICT',
      alerts: '1',
      receipts: '3',
      outbound_frames: '5',
      operations: '3',
      inbound_next_seq: '3',
      outbound_next_seq: '5',
    });
    const alerts = await owner.query<{
      reason: string;
      source: string;
      source_event_id_digest: string;
      existing_canonical_digest: string;
      received_canonical_digest: string;
    }>(
      `SELECT reason, source, source_event_id_digest,
              existing_canonical_digest, received_canonical_digest
         FROM creator_agent_journal_integrity_alerts
        WHERE invocation_id = $1`,
      [fixture.invocationId],
    );
    expect(alerts.rows).toHaveLength(1);
    expect(alerts.rows[0]).toMatchObject({ reason: 'SOURCE_EVENT_CONFLICT', source: 'WORKER' });
    expect(alerts.rows[0]?.existing_canonical_digest).not.toBe(
      alerts.rows[0]?.received_canonical_digest,
    );
    const serializedAlert = JSON.stringify(alerts.rows[0]);
    for (const forbidden of [
      startCommandId,
      admittedFact.runtimeThreadId,
      admittedFact.runtimeTurnId,
      admittedFact.dispatchReceiptDigest,
      admittedFact.sandboxAttestationDigest,
      conflictingFact.runtimeThreadId,
      conflictingFact.runtimeTurnId,
      conflictingFact.dispatchReceiptDigest,
      conflictingFact.sandboxAttestationDigest,
    ]) {
      expect(serializedAlert).not.toContain(forbidden);
    }

    const conflictOperationKey = operationKeys[2]!;
    await expect(
      owner.query<{ response_frames: unknown; result_value: unknown }>(
        `SELECT receipt.response_frames, operation.result_value
           FROM worker_gateway_frame_receipts AS receipt
           JOIN worker_gateway_operation_receipts AS operation
             ON operation.creator_id = receipt.creator_id
            AND operation.operation_kind = 'ACCEPT_ENVELOPE'
            AND operation.operation_key = $4
          WHERE receipt.session_id = $1 AND receipt.sequence = 2
            AND receipt.message_id = $2 AND receipt.canonical_digest = $3`,
        [
          session.workerSessionId,
          conflictEvent.messageId,
          canonicalSha256(conflictEvent),
          conflictOperationKey,
        ],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          response_frames: blocked,
          result_value: { kind: 'RESPONSES', responses: blocked },
        },
      ],
    });

    const afterCommit = await footprint();
    await expect(
      projectingAuthority.replayEnvelope(
        session,
        delivery(conflictEvent),
        AbortSignal.timeout(5_000),
      ),
    ).resolves.toEqual(blocked);
    expect(await footprint()).toEqual(afterCommit);

    const transportConflict = BrokerEnvelopeSchema.parse({
      ...conflictEvent,
      messageId: randomUuidV7(),
    });
    await expect(
      projectingAuthority.acceptEnvelope(
        session,
        delivery(transportConflict),
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toMatchObject({ code: 'SEQUENCE_CONFLICT' });
    await expect(
      owner.query<{ alerts: string; transport_conflicts: string; start_commands: string }>(
        `SELECT
           (SELECT count(*)::text FROM creator_agent_journal_integrity_alerts
             WHERE invocation_id = $1) AS alerts,
           (SELECT count(*)::text FROM worker_gateway_security_events
             WHERE session_id = $2 AND event_type = 'SEQUENCE_CONFLICT')
             AS transport_conflicts,
           (SELECT count(*)::text FROM broker_outbox
             WHERE invocation_id = $1 AND command_type = 'invocation.start')
             AS start_commands`,
        [fixture.invocationId, session.workerSessionId],
      ),
    ).resolves.toMatchObject({
      rows: [{ alerts: '1', transport_conflicts: '1', start_commands: '1' }],
    });
    expect(assistantMessageSealer).not.toHaveBeenCalled();
  }, 20_000);

  it('keeps one late-started reconciliation root when a replayed source changes its evidence', async () => {
    const seeded = await seedInvocationProjectionFixture('late-started-conflict');
    const { fixture, session, lease, assistantMessageSealer, projectingAuthority, preparedFact } =
      seeded;
    const preparedEvent = invocationPrepared(session, lease, 0n, preparedFact);
    await projectingAuthority.acceptEnvelope(
      session,
      delivery(preparedEvent),
      AbortSignal.timeout(5_000),
    );
    const startCommand = await owner.query<{ command_id: string }>(
      `UPDATE broker_outbox
          SET state = 'SENT', attempt_count = 1, next_attempt_at = statement_timestamp()
        WHERE invocation_id = $1 AND command_type = 'invocation.start'
          AND state = 'PENDING'
      RETURNING command_id::text`,
      [fixture.invocationId],
    );
    const startCommandId = startCommand.rows[0]?.command_id;
    if (!startCommandId) throw new Error('expected one late-started start command');
    await owner.query(
      `UPDATE agent_invocations
          SET execution_capability_revoked_at = clock_timestamp()
        WHERE id = $1`,
      [fixture.invocationId],
    );
    const admittedFact = {
      protocol: WORKER_INVOCATION_FACT_PROTOCOL,
      schemaVersion: 1,
      type: 'invocation.started',
      sourceEventId: startCommandId,
      invocationId: fixture.invocationId,
      agentVersionDigest: fixture.versionDigest,
      snapshotDigest: digest('1'),
      executionCapabilityDigest: fixture.capabilityDigest,
      leaseId: lease.lease.leaseId,
      fence: lease.lease.fence,
      startCommandId,
      runtimeThreadId: `late-thread-${fixture.invocationId}`,
      runtimeTurnId: `late-turn-${fixture.invocationId}`,
      dispatchReceiptDigest: `sha256:${randomBytes(32).toString('hex')}`,
      sandboxAttestationDigest: `sha256:${randomBytes(32).toString('hex')}`,
    } as const satisfies WorkerInvocationStartedFact;
    const admittedEvent = invocationStarted(session, lease, 1n, admittedFact);
    await expect(
      projectingAuthority.acceptEnvelope(
        session,
        delivery(admittedEvent),
        AbortSignal.timeout(5_000),
      ),
    ).resolves.toMatchObject([
      {
        type: 'message.ack',
        body: {
          acknowledgedMessageId: admittedEvent.messageId,
          decision: 'RECONCILE',
          level: 'CLOUD_COMMITTED',
        },
      },
    ]);
    const beforeConflict = await owner.query<{
      state: string;
      runtime_thread_id: string;
      runtime_turn_id: string;
      source_fact_digest: string;
      source_dispatch_receipt_digest: string;
      source_sandbox_attestation_digest: string;
      payload: unknown;
      root_source_event_id: string;
      root_payload: unknown;
      root_events: string;
      start_state: string;
      alerts: string;
    }>(
      `SELECT invocation.state, invocation.runtime_thread_id, invocation.runtime_turn_id,
              started.source_fact_digest, started.source_dispatch_receipt_digest,
              started.source_sandbox_attestation_digest, started.payload,
              root.source_event_id AS root_source_event_id, root.payload AS root_payload,
              (SELECT count(*)::text FROM agent_invocation_events AS candidate
                WHERE candidate.invocation_id = invocation.id
                  AND candidate.source = 'RECONCILER'
                  AND candidate.event_type = 'invocation.reconciling') AS root_events,
              start_command.state AS start_state,
              (SELECT count(*)::text FROM creator_agent_journal_integrity_alerts AS alert
                WHERE alert.invocation_id = invocation.id) AS alerts
         FROM agent_invocations AS invocation
         JOIN agent_invocation_events AS started
           ON started.invocation_id = invocation.id AND started.source = 'WORKER'
          AND started.event_type = 'invocation.started'
         JOIN agent_invocation_events AS root
           ON root.invocation_id = invocation.id AND root.source = 'RECONCILER'
          AND root.event_type = 'invocation.reconciling'
         JOIN broker_outbox AS start_command
           ON start_command.command_id = $2
        WHERE invocation.id = $1`,
      [fixture.invocationId, startCommandId],
    );
    expect(beforeConflict.rows).toEqual([
      {
        state: 'RECONCILING',
        runtime_thread_id: admittedFact.runtimeThreadId,
        runtime_turn_id: admittedFact.runtimeTurnId,
        source_fact_digest: workerInvocationFactDigest(admittedFact),
        source_dispatch_receipt_digest: admittedFact.dispatchReceiptDigest,
        source_sandbox_attestation_digest: admittedFact.sandboxAttestationDigest,
        payload: { state: 'RECONCILING' },
        root_source_event_id: `late-started:${startCommandId}`,
        root_payload: { state: 'RECONCILING', reason: 'CANCEL_NOT_CONFIRMED' },
        root_events: '1',
        start_state: 'ACKED',
        alerts: '0',
      },
    ]);

    const conflictingFact = {
      ...admittedFact,
      dispatchReceiptDigest: `sha256:${randomBytes(32).toString('hex')}`,
    } satisfies WorkerInvocationStartedFact;
    const conflictEvent = invocationStarted(session, lease, 2n, conflictingFact);
    const blocked = await projectingAuthority.acceptEnvelope(
      session,
      delivery(conflictEvent),
      AbortSignal.timeout(5_000),
    );
    expect(blocked).toMatchObject([
      {
        type: 'message.ack',
        body: { decision: 'SECURITY_BLOCK', level: 'CLOUD_COMMITTED' },
      },
      { type: 'lease.revoke', body: { reason: 'SECURITY' } },
    ]);
    expect(assistantMessageSealer).not.toHaveBeenCalled();

    await expect(
      owner.query<{
        state: string;
        source_fact_digest: string;
        source_dispatch_receipt_digest: string;
        source_sandbox_attestation_digest: string;
        root_events: string;
        alerts: string;
        lease_state: string;
        session_state: string;
        deployment_state: string;
        last_error_code: string;
      }>(
        `SELECT invocation.state, started.source_fact_digest,
                started.source_dispatch_receipt_digest,
                started.source_sandbox_attestation_digest,
                (SELECT count(*)::text FROM agent_invocation_events AS root
                  WHERE root.invocation_id = invocation.id AND root.source = 'RECONCILER'
                    AND root.event_type = 'invocation.reconciling') AS root_events,
                (SELECT count(*)::text FROM creator_agent_journal_integrity_alerts AS alert
                  WHERE alert.invocation_id = invocation.id) AS alerts,
                lease.state AS lease_state, gateway.state AS session_state,
                deployment.observed_state AS deployment_state, deployment.last_error_code
           FROM agent_invocations AS invocation
           JOIN agent_invocation_events AS started
             ON started.invocation_id = invocation.id AND started.source = 'WORKER'
            AND started.event_type = 'invocation.started'
           JOIN worker_leases AS lease ON lease.id = $2
           JOIN worker_gateway_sessions AS gateway ON gateway.id = $3
           JOIN deployments AS deployment ON deployment.id = $4
          WHERE invocation.id = $1`,
        [fixture.invocationId, lease.lease.leaseId, session.workerSessionId, fixture.deploymentId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: 'RECONCILING',
          source_fact_digest: workerInvocationFactDigest(admittedFact),
          source_dispatch_receipt_digest: admittedFact.dispatchReceiptDigest,
          source_sandbox_attestation_digest: admittedFact.sandboxAttestationDigest,
          root_events: '1',
          alerts: '1',
          lease_state: 'REVOKED',
          session_state: 'REVOKED',
          deployment_state: 'BLOCKED',
          last_error_code: 'WORKER_FACT_CONFLICT',
        },
      ],
    });
  }, 20_000);

  it('atomically isolates a confirmed failed-fact mutation after an exact re-envelope', async () => {
    const seeded = await seedInvocationProjectionFixture('failed-conflict');
    const {
      fixture,
      session,
      lease,
      securityPolicy,
      assistantMessageSealer,
      businessProjector,
      projectingAuthority,
    } = seeded;
    const running = await advanceFixtureToRunning(seeded);
    const admittedFact = {
      protocol: WORKER_INVOCATION_FACT_PROTOCOL,
      schemaVersion: 1,
      type: 'invocation.failed',
      sourceEventId: fixture.invocationId,
      invocationId: fixture.invocationId,
      agentVersionDigest: fixture.versionDigest,
      snapshotDigest: digest('1'),
      executionCapabilityDigest: fixture.capabilityDigest,
      leaseId: lease.lease.leaseId,
      fence: lease.lease.fence,
      errorCode: 'TURN_FAILED',
    } as const satisfies WorkerInvocationFailedFact;
    const admittedEvent = invocationFailedFact(session, lease, 2n, admittedFact);
    await expect(
      projectingAuthority.acceptEnvelope(
        session,
        delivery(admittedEvent),
        AbortSignal.timeout(5_000),
      ),
    ).resolves.toMatchObject([
      {
        type: 'message.ack',
        body: { decision: 'APPLIED', level: 'CLOUD_COMMITTED' },
      },
    ]);
    const exactEvent = invocationFailedFact(session, lease, 3n, admittedFact);
    await expect(
      projectingAuthority.acceptEnvelope(session, delivery(exactEvent), AbortSignal.timeout(5_000)),
    ).resolves.toMatchObject([
      {
        type: 'message.ack',
        body: { decision: 'IDEMPOTENT_REPLAY', level: 'CLOUD_COMMITTED' },
      },
    ]);

    const conflictingFact = {
      ...admittedFact,
      errorCode: 'TURN_TIMEOUT',
    } satisfies WorkerInvocationFailedFact;
    const conflictEvent = invocationFailedFact(session, lease, 4n, conflictingFact);
    const operationKeys = [
      running.preparedEvent,
      running.startedEvent,
      admittedEvent,
      exactEvent,
      conflictEvent,
    ].map((event) => `${event.messageId}:${canonicalSha256(event)}`);
    const footprint = async () => {
      const observed = await owner.query<{
        invocation_state: string;
        error_code: string | null;
        result_message_id: string | null;
        result_digest: string | null;
        capability_revoked: boolean;
        conversation_state: string;
        failed_events: string;
        succeeded_events: string;
        terminal_source_event_id: string | null;
        terminal_fact_digest: string | null;
        terminal_payload: unknown;
        consumer_events: string;
        assistant_messages: string;
        start_commands: string;
        start_state: string | null;
        alerts: string;
        lease_state: string;
        session_state: string;
        deployment_state: string;
        last_error_code: string | null;
        receipts: string;
        outbound_frames: string;
        operations: string;
        inbound_next_seq: string;
        outbound_next_seq: string;
      }>(
        `SELECT invocation.state AS invocation_state, invocation.error_code,
                invocation.result_message_id::text, invocation.result_digest,
                invocation.execution_capability_revoked_at IS NOT NULL AS capability_revoked,
                conversation.state AS conversation_state,
                (SELECT count(*)::text FROM agent_invocation_events AS event
                  WHERE event.invocation_id = invocation.id
                    AND event.event_type = 'invocation.failed') AS failed_events,
                (SELECT count(*)::text FROM agent_invocation_events AS event
                  WHERE event.invocation_id = invocation.id
                    AND event.event_type = 'invocation.succeeded') AS succeeded_events,
                terminal.source_event_id AS terminal_source_event_id,
                terminal.source_fact_digest AS terminal_fact_digest,
                terminal.payload AS terminal_payload,
                (SELECT count(*)::text FROM consumer_event_outbox AS consumer_event
                  WHERE consumer_event.invocation_id = invocation.id
                    AND consumer_event.event_type = 'invocation.terminal') AS consumer_events,
                (SELECT count(*)::text FROM agent_messages AS message
                  WHERE message.invocation_id = invocation.id
                    AND message.role = 'ASSISTANT') AS assistant_messages,
                (SELECT count(*)::text FROM broker_outbox AS command
                  WHERE command.invocation_id = invocation.id
                    AND command.command_type = 'invocation.start') AS start_commands,
                start_command.state AS start_state,
                (SELECT count(*)::text FROM creator_agent_journal_integrity_alerts AS alert
                  WHERE alert.invocation_id = invocation.id) AS alerts,
                lease.state AS lease_state, gateway.state AS session_state,
                deployment.observed_state AS deployment_state, deployment.last_error_code,
                (SELECT count(*)::text FROM worker_gateway_frame_receipts AS receipt
                  WHERE receipt.session_id = gateway.id) AS receipts,
                (SELECT count(*)::text FROM worker_gateway_outbound_frames AS frame
                  WHERE frame.session_id = gateway.id) AS outbound_frames,
                (SELECT count(*)::text FROM worker_gateway_operation_receipts AS operation
                  WHERE operation.creator_id = invocation.creator_id
                    AND operation.operation_kind = 'ACCEPT_ENVELOPE'
                    AND operation.operation_key = ANY($4::text[])) AS operations,
                gateway.inbound_next_seq::text, gateway.outbound_next_seq::text
           FROM agent_invocations AS invocation
           JOIN agent_conversations AS conversation
             ON conversation.id = invocation.conversation_id
           JOIN worker_leases AS lease ON lease.id = $2
           JOIN worker_gateway_sessions AS gateway ON gateway.id = $3
           JOIN deployments AS deployment ON deployment.id = $1
           LEFT JOIN agent_invocation_events AS terminal
             ON terminal.invocation_id = invocation.id AND terminal.source = 'WORKER'
            AND terminal.event_type = 'invocation.failed'
           LEFT JOIN broker_outbox AS start_command
             ON start_command.invocation_id = invocation.id
            AND start_command.command_type = 'invocation.start'
          WHERE invocation.id = $5`,
        [
          fixture.deploymentId,
          lease.lease.leaseId,
          session.workerSessionId,
          operationKeys,
          fixture.invocationId,
        ],
      );
      const row = observed.rows[0];
      if (!row) throw new Error('failed conflict footprint missing');
      return row;
    };
    const beforeConflict = await footprint();
    expect(beforeConflict).toMatchObject({
      invocation_state: 'FAILED',
      error_code: admittedFact.errorCode,
      result_message_id: null,
      result_digest: null,
      capability_revoked: false,
      conversation_state: 'IDLE',
      failed_events: '1',
      succeeded_events: '0',
      terminal_source_event_id: fixture.invocationId,
      terminal_fact_digest: workerInvocationFactDigest(admittedFact),
      terminal_payload: { state: 'FAILED', errorCode: admittedFact.errorCode },
      consumer_events: '1',
      assistant_messages: '0',
      start_commands: '1',
      start_state: 'ACKED',
      alerts: '0',
      lease_state: 'ACTIVE',
      session_state: 'ACTIVE',
      receipts: '4',
      outbound_frames: '5',
      operations: '4',
      inbound_next_seq: '4',
      outbound_next_seq: '5',
    });
    expect(assistantMessageSealer).not.toHaveBeenCalled();

    for (const target of ['EVENT_PROJECTED', 'RECEIPT_INSERTED'] as const) {
      const failingAuthority = new PostgresAgentGatewayAuthority(
        pools,
        securityPolicy,
        businessProjector,
        (step) => {
          if (step === target) throw new Error(`FAILPOINT:FAILED:${target}`);
        },
      );
      await expect(
        failingAuthority.acceptEnvelope(
          session,
          delivery(conflictEvent),
          AbortSignal.timeout(5_000),
        ),
      ).rejects.toThrow(`FAILPOINT:FAILED:${target}`);
      expect(await footprint(), target).toEqual(beforeConflict);
    }

    const lossySecurityAuthority = new PostgresAgentGatewayAuthority(
      { api: apiGatewayPool, broker: lossyBrokerPool },
      securityPolicy,
      businessProjector,
    );
    lossyBrokerPool.arm();
    const blocked = await lossySecurityAuthority.acceptEnvelope(
      session,
      delivery(conflictEvent),
      AbortSignal.timeout(5_000),
    );
    expect(blocked).toMatchObject([
      {
        type: 'message.ack',
        body: { decision: 'SECURITY_BLOCK', level: 'CLOUD_COMMITTED' },
      },
      { type: 'lease.revoke', body: { reason: 'SECURITY' } },
    ]);
    expect(assistantMessageSealer).not.toHaveBeenCalled();
    expect(await footprint()).toMatchObject({
      ...beforeConflict,
      // FAILED is already terminal; its historical capability remains unstamped but inert.
      capability_revoked: false,
      alerts: '1',
      lease_state: 'REVOKED',
      session_state: 'REVOKED',
      deployment_state: 'BLOCKED',
      last_error_code: 'WORKER_FACT_CONFLICT',
      receipts: '5',
      outbound_frames: '7',
      operations: '5',
      inbound_next_seq: '5',
      outbound_next_seq: '7',
    });
    const alerts = await owner.query<{
      reason: string;
      source: string;
      source_event_id_digest: string;
      existing_canonical_digest: string;
      received_canonical_digest: string;
    }>(
      `SELECT reason, source, source_event_id_digest,
              existing_canonical_digest, received_canonical_digest
         FROM creator_agent_journal_integrity_alerts
        WHERE invocation_id = $1`,
      [fixture.invocationId],
    );
    expect(alerts.rows).toHaveLength(1);
    expect(alerts.rows[0]).toMatchObject({ reason: 'SOURCE_EVENT_CONFLICT', source: 'WORKER' });
    expect(alerts.rows[0]?.existing_canonical_digest).not.toBe(
      alerts.rows[0]?.received_canonical_digest,
    );
    const serializedAlert = JSON.stringify(alerts.rows[0]);
    expect(serializedAlert).not.toContain(fixture.invocationId);
    expect(serializedAlert).not.toContain(admittedFact.errorCode);
    expect(serializedAlert).not.toContain(conflictingFact.errorCode);

    const conflictOperationKey = operationKeys[4]!;
    await expect(
      owner.query<{ response_frames: unknown; result_value: unknown }>(
        `SELECT receipt.response_frames, operation.result_value
           FROM worker_gateway_frame_receipts AS receipt
           JOIN worker_gateway_operation_receipts AS operation
             ON operation.creator_id = receipt.creator_id
            AND operation.operation_kind = 'ACCEPT_ENVELOPE'
            AND operation.operation_key = $4
          WHERE receipt.session_id = $1 AND receipt.sequence = 4
            AND receipt.message_id = $2 AND receipt.canonical_digest = $3`,
        [
          session.workerSessionId,
          conflictEvent.messageId,
          canonicalSha256(conflictEvent),
          conflictOperationKey,
        ],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          response_frames: blocked,
          result_value: { kind: 'RESPONSES', responses: blocked },
        },
      ],
    });
    const afterCommit = await footprint();
    await expect(
      projectingAuthority.replayEnvelope(
        session,
        delivery(conflictEvent),
        AbortSignal.timeout(5_000),
      ),
    ).resolves.toEqual(blocked);
    expect(await footprint()).toEqual(afterCommit);

    const transportConflict = BrokerEnvelopeSchema.parse({
      ...conflictEvent,
      messageId: randomUuidV7(),
    });
    await expect(
      projectingAuthority.acceptEnvelope(
        session,
        delivery(transportConflict),
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toMatchObject({ code: 'SEQUENCE_CONFLICT' });
    await expect(
      owner.query<{ alerts: string; transport_conflicts: string }>(
        `SELECT
           (SELECT count(*)::text FROM creator_agent_journal_integrity_alerts
             WHERE invocation_id = $1) AS alerts,
           (SELECT count(*)::text FROM worker_gateway_security_events
             WHERE session_id = $2 AND event_type = 'SEQUENCE_CONFLICT')
             AS transport_conflicts`,
        [fixture.invocationId, session.workerSessionId],
      ),
    ).resolves.toMatchObject({ rows: [{ alerts: '1', transport_conflicts: '1' }] });
    expect(assistantMessageSealer).not.toHaveBeenCalled();
  }, 25_000);

  it('atomically isolates a full succeeded-fact mutation after an exact transport re-envelope', async () => {
    const seeded = await seedInvocationProjectionFixture('succeeded-conflict');
    const {
      fixture,
      session,
      lease,
      securityPolicy,
      assistantMessageSealer,
      businessProjector,
      projectingAuthority,
    } = seeded;
    const running = await advanceFixtureToRunning(seeded);
    const resultDigest = `hmac-sha256:${randomBytes(32).toString('hex')}`;
    const admittedFact = {
      protocol: WORKER_INVOCATION_FACT_PROTOCOL,
      schemaVersion: 1,
      type: 'invocation.succeeded',
      sourceEventId: fixture.invocationId,
      invocationId: fixture.invocationId,
      agentVersionDigest: fixture.versionDigest,
      snapshotDigest: digest('1'),
      executionCapabilityDigest: fixture.capabilityDigest,
      leaseId: lease.lease.leaseId,
      fence: lease.lease.fence,
      runtimeThreadId: running.startedFact.runtimeThreadId,
      runtimeTurnId: running.startedFact.runtimeTurnId,
      startedFactDigest: workerInvocationFactDigest(running.startedFact),
      resultDigest,
      localResultCipherDigest: randomBytes(32).toString('hex'),
    } as const satisfies WorkerInvocationSucceededFact;
    assistantMessageSealer.mockImplementation(
      terminalSealer(resultDigest, admittedFact.localResultCipherDigest),
    );
    const admittedEvent = invocationSucceeded(
      session,
      lease,
      2n,
      fixture.conversationId,
      admittedFact,
    );
    await expect(
      projectingAuthority.acceptEnvelope(
        session,
        delivery(admittedEvent),
        AbortSignal.timeout(5_000),
      ),
    ).resolves.toMatchObject([
      {
        type: 'message.ack',
        body: { decision: 'APPLIED', level: 'CLOUD_COMMITTED' },
      },
    ]);
    expect(assistantMessageSealer).toHaveBeenCalledTimes(1);

    // A new envelope necessarily has a new messageId/AAD and transport ciphertext. Durable source
    // identity is the exact Worker fact, so this must replay without a second KMS/sealer call.
    const exactEvent = invocationSucceeded(
      session,
      lease,
      3n,
      fixture.conversationId,
      admittedFact,
    );
    expect(exactEvent.body.resultCiphertext).not.toEqual(admittedEvent.body.resultCiphertext);
    await expect(
      projectingAuthority.acceptEnvelope(session, delivery(exactEvent), AbortSignal.timeout(5_000)),
    ).resolves.toMatchObject([
      {
        type: 'message.ack',
        body: { decision: 'IDEMPOTENT_REPLAY', level: 'CLOUD_COMMITTED' },
      },
    ]);
    expect(assistantMessageSealer).toHaveBeenCalledTimes(1);

    const conflictingFact = {
      ...admittedFact,
      agentVersionDigest: randomBytes(32).toString('hex'),
      snapshotDigest: randomBytes(32).toString('hex'),
      executionCapabilityDigest: randomBytes(32).toString('hex'),
      leaseId: randomUuidV7(),
      fence: (BigInt(admittedFact.fence) + 1n).toString(),
      runtimeThreadId: `success-conflict-thread-${fixture.invocationId}`,
      runtimeTurnId: `success-conflict-turn-${fixture.invocationId}`,
      startedFactDigest: randomBytes(32).toString('hex'),
      resultDigest: `hmac-sha256:${randomBytes(32).toString('hex')}`,
      localResultCipherDigest: randomBytes(32).toString('hex'),
    } satisfies WorkerInvocationSucceededFact;
    const conflictEvent = invocationSucceeded(
      session,
      lease,
      4n,
      fixture.conversationId,
      conflictingFact,
    );
    const operationKeys = [
      running.preparedEvent,
      running.startedEvent,
      admittedEvent,
      exactEvent,
      conflictEvent,
    ].map((event) => `${event.messageId}:${canonicalSha256(event)}`);
    const footprint = async () => {
      const observed = await owner.query<{
        invocation_state: string;
        result_message_id: string | null;
        result_digest: string | null;
        error_code: string | null;
        capability_revoked: boolean;
        conversation_state: string;
        succeeded_events: string;
        failed_events: string;
        terminal_source_event_id: string | null;
        terminal_fact_digest: string | null;
        terminal_local_cipher_digest: string | null;
        terminal_payload: unknown;
        assistant_messages: string;
        message_key_id: string | null;
        message_nonce: string | null;
        message_ciphertext: string | null;
        message_auth_tag: string | null;
        message_cipher_digest: string | null;
        message_content_digest: string | null;
        consumer_events: string;
        consumer_payload: unknown;
        consumer_payload_digest: string | null;
        consumer_dedupe_key: string | null;
        terminal_receipts: string;
        start_commands: string;
        start_state: string | null;
        alerts: string;
        lease_state: string;
        session_state: string;
        deployment_state: string;
        last_error_code: string | null;
        receipts: string;
        outbound_frames: string;
        operations: string;
        inbound_next_seq: string;
        outbound_next_seq: string;
      }>(
        `SELECT invocation.state AS invocation_state,
                invocation.result_message_id::text, invocation.result_digest,
                invocation.error_code,
                invocation.execution_capability_revoked_at IS NOT NULL AS capability_revoked,
                conversation.state AS conversation_state,
                (SELECT count(*)::text FROM agent_invocation_events AS event
                  WHERE event.invocation_id = invocation.id
                    AND event.event_type = 'invocation.succeeded') AS succeeded_events,
                (SELECT count(*)::text FROM agent_invocation_events AS event
                  WHERE event.invocation_id = invocation.id
                    AND event.event_type = 'invocation.failed') AS failed_events,
                terminal.source_event_id AS terminal_source_event_id,
                terminal.source_fact_digest AS terminal_fact_digest,
                terminal.source_local_result_cipher_digest AS terminal_local_cipher_digest,
                terminal.payload AS terminal_payload,
                (SELECT count(*)::text FROM agent_messages AS candidate
                  WHERE candidate.invocation_id = invocation.id
                    AND candidate.role = 'ASSISTANT') AS assistant_messages,
                message.content_key_id AS message_key_id,
                encode(message.content_nonce, 'hex') AS message_nonce,
                encode(message.content_ciphertext, 'hex') AS message_ciphertext,
                encode(message.content_auth_tag, 'hex') AS message_auth_tag,
                message.content_cipher_digest AS message_cipher_digest,
                message.content_digest AS message_content_digest,
                (SELECT count(*)::text FROM consumer_event_outbox AS candidate
                  WHERE candidate.invocation_id = invocation.id
                    AND candidate.event_type = 'invocation.terminal') AS consumer_events,
                consumer.payload AS consumer_payload,
                consumer.payload_digest AS consumer_payload_digest,
                consumer.dedupe_key AS consumer_dedupe_key,
                (SELECT count(*)::text FROM creator_agent_succeeded_terminal_receipts AS receipt
                  WHERE receipt.invocation_id = invocation.id) AS terminal_receipts,
                (SELECT count(*)::text FROM broker_outbox AS command
                  WHERE command.invocation_id = invocation.id
                    AND command.command_type = 'invocation.start') AS start_commands,
                start_command.state AS start_state,
                (SELECT count(*)::text FROM creator_agent_journal_integrity_alerts AS alert
                  WHERE alert.invocation_id = invocation.id) AS alerts,
                lease.state AS lease_state, gateway.state AS session_state,
                deployment.observed_state AS deployment_state, deployment.last_error_code,
                (SELECT count(*)::text FROM worker_gateway_frame_receipts AS receipt
                  WHERE receipt.session_id = gateway.id) AS receipts,
                (SELECT count(*)::text FROM worker_gateway_outbound_frames AS frame
                  WHERE frame.session_id = gateway.id) AS outbound_frames,
                (SELECT count(*)::text FROM worker_gateway_operation_receipts AS operation
                  WHERE operation.creator_id = invocation.creator_id
                    AND operation.operation_kind = 'ACCEPT_ENVELOPE'
                    AND operation.operation_key = ANY($4::text[])) AS operations,
                gateway.inbound_next_seq::text, gateway.outbound_next_seq::text
           FROM agent_invocations AS invocation
           JOIN agent_conversations AS conversation
             ON conversation.id = invocation.conversation_id
           JOIN worker_leases AS lease ON lease.id = $2
           JOIN worker_gateway_sessions AS gateway ON gateway.id = $3
           JOIN deployments AS deployment ON deployment.id = $1
           LEFT JOIN agent_invocation_events AS terminal
             ON terminal.invocation_id = invocation.id AND terminal.source = 'WORKER'
            AND terminal.event_type = 'invocation.succeeded'
           LEFT JOIN agent_messages AS message
             ON message.id = invocation.result_message_id AND message.role = 'ASSISTANT'
           LEFT JOIN consumer_event_outbox AS consumer
             ON consumer.invocation_id = invocation.id
            AND consumer.source_event_id = terminal.id
            AND consumer.event_type = 'invocation.terminal'
           LEFT JOIN broker_outbox AS start_command
             ON start_command.invocation_id = invocation.id
            AND start_command.command_type = 'invocation.start'
          WHERE invocation.id = $5`,
        [
          fixture.deploymentId,
          lease.lease.leaseId,
          session.workerSessionId,
          operationKeys,
          fixture.invocationId,
        ],
      );
      const row = observed.rows[0];
      if (!row) throw new Error('succeeded conflict footprint missing');
      return row;
    };
    const beforeConflict = await footprint();
    expect(beforeConflict).toMatchObject({
      invocation_state: 'SUCCEEDED',
      result_message_id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      result_digest: admittedFact.resultDigest,
      error_code: null,
      capability_revoked: false,
      conversation_state: 'IDLE',
      succeeded_events: '1',
      failed_events: '0',
      terminal_source_event_id: fixture.invocationId,
      terminal_fact_digest: workerInvocationFactDigest(admittedFact),
      terminal_local_cipher_digest: admittedFact.localResultCipherDigest,
      terminal_payload: {
        state: 'SUCCEEDED',
        messageId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        resultDigest: admittedFact.resultDigest,
      },
      assistant_messages: '1',
      consumer_events: '1',
      consumer_payload: {
        terminalState: 'SUCCEEDED',
        resultDigest: admittedFact.resultDigest,
      },
      terminal_receipts: '1',
      start_commands: '1',
      start_state: 'ACKED',
      alerts: '0',
      lease_state: 'ACTIVE',
      session_state: 'ACTIVE',
      receipts: '4',
      outbound_frames: '5',
      operations: '4',
      inbound_next_seq: '4',
      outbound_next_seq: '5',
    });

    for (const target of ['EVENT_PROJECTED', 'RECEIPT_INSERTED'] as const) {
      const failingAuthority = new PostgresAgentGatewayAuthority(
        pools,
        securityPolicy,
        businessProjector,
        (step) => {
          if (step === target) throw new Error(`FAILPOINT:SUCCEEDED:${target}`);
        },
      );
      await expect(
        failingAuthority.acceptEnvelope(
          session,
          delivery(conflictEvent),
          AbortSignal.timeout(5_000),
        ),
      ).rejects.toThrow(`FAILPOINT:SUCCEEDED:${target}`);
      expect(await footprint(), target).toEqual(beforeConflict);
      expect(assistantMessageSealer).toHaveBeenCalledTimes(1);
    }

    const lossySecurityAuthority = new PostgresAgentGatewayAuthority(
      { api: apiGatewayPool, broker: lossyBrokerPool },
      securityPolicy,
      businessProjector,
    );
    lossyBrokerPool.arm();
    const blocked = await lossySecurityAuthority.acceptEnvelope(
      session,
      delivery(conflictEvent),
      AbortSignal.timeout(5_000),
    );
    expect(blocked).toMatchObject([
      {
        type: 'message.ack',
        body: { decision: 'SECURITY_BLOCK', level: 'CLOUD_COMMITTED' },
      },
      { type: 'lease.revoke', body: { reason: 'SECURITY' } },
    ]);
    expect(assistantMessageSealer).toHaveBeenCalledTimes(1);
    expect(await footprint()).toMatchObject({
      ...beforeConflict,
      capability_revoked: false,
      alerts: '1',
      lease_state: 'REVOKED',
      session_state: 'REVOKED',
      deployment_state: 'BLOCKED',
      last_error_code: 'WORKER_FACT_CONFLICT',
      receipts: '5',
      outbound_frames: '7',
      operations: '5',
      inbound_next_seq: '5',
      outbound_next_seq: '7',
    });
    const alerts = await owner.query<{
      reason: string;
      source: string;
      source_event_id_digest: string;
      existing_canonical_digest: string;
      received_canonical_digest: string;
    }>(
      `SELECT reason, source, source_event_id_digest,
              existing_canonical_digest, received_canonical_digest
         FROM creator_agent_journal_integrity_alerts
        WHERE invocation_id = $1`,
      [fixture.invocationId],
    );
    expect(alerts.rows).toHaveLength(1);
    expect(alerts.rows[0]).toMatchObject({ reason: 'SOURCE_EVENT_CONFLICT', source: 'WORKER' });
    const serializedAlert = JSON.stringify(alerts.rows[0]);
    for (const forbidden of [
      fixture.invocationId,
      admittedFact.resultDigest,
      admittedFact.localResultCipherDigest,
      conflictingFact.resultDigest,
      conflictingFact.localResultCipherDigest,
      beforeConflict.message_key_id,
      beforeConflict.message_nonce,
      beforeConflict.message_ciphertext,
      beforeConflict.message_auth_tag,
      beforeConflict.message_cipher_digest,
      beforeConflict.message_content_digest,
    ]) {
      if (forbidden !== null) expect(serializedAlert).not.toContain(forbidden);
    }

    const conflictOperationKey = operationKeys[4]!;
    await expect(
      owner.query<{ response_frames: unknown; result_value: unknown }>(
        `SELECT receipt.response_frames, operation.result_value
           FROM worker_gateway_frame_receipts AS receipt
           JOIN worker_gateway_operation_receipts AS operation
             ON operation.creator_id = receipt.creator_id
            AND operation.operation_kind = 'ACCEPT_ENVELOPE'
            AND operation.operation_key = $4
          WHERE receipt.session_id = $1 AND receipt.sequence = 4
            AND receipt.message_id = $2 AND receipt.canonical_digest = $3`,
        [
          session.workerSessionId,
          conflictEvent.messageId,
          canonicalSha256(conflictEvent),
          conflictOperationKey,
        ],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          response_frames: blocked,
          result_value: { kind: 'RESPONSES', responses: blocked },
        },
      ],
    });
    const afterCommit = await footprint();
    await expect(
      projectingAuthority.replayEnvelope(
        session,
        delivery(conflictEvent),
        AbortSignal.timeout(5_000),
      ),
    ).resolves.toEqual(blocked);
    expect(await footprint()).toEqual(afterCommit);

    const transportConflict = invocationSucceeded(
      session,
      lease,
      4n,
      fixture.conversationId,
      conflictingFact,
    );
    await expect(
      projectingAuthority.acceptEnvelope(
        session,
        delivery(transportConflict),
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toMatchObject({ code: 'SEQUENCE_CONFLICT' });
    await expect(
      owner.query<{ alerts: string; transport_conflicts: string; start_commands: string }>(
        `SELECT
           (SELECT count(*)::text FROM creator_agent_journal_integrity_alerts
             WHERE invocation_id = $1) AS alerts,
           (SELECT count(*)::text FROM worker_gateway_security_events
             WHERE session_id = $2 AND event_type = 'SEQUENCE_CONFLICT')
             AS transport_conflicts,
           (SELECT count(*)::text FROM broker_outbox
             WHERE invocation_id = $1 AND command_type = 'invocation.start')
             AS start_commands`,
        [fixture.invocationId, session.workerSessionId],
      ),
    ).resolves.toMatchObject({
      rows: [{ alerts: '1', transport_conflicts: '1', start_commands: '1' }],
    });
    expect(assistantMessageSealer).toHaveBeenCalledTimes(1);
  }, 25_000);

  it('atomically projects a canonical invocation.cancelled fact after durable started evidence and replays exactly', async () => {
    const seeded = await seedInvocationProjectionFixture('cancelled-authority');
    const { fixture, session, lease, projectingAuthority } = seeded;
    const running = await advanceFixtureToRunning(seeded);
    // The Cloud cancel authority (phase-B invocation.cancel command processing) durably
    // transitions RUNNING -> CANCEL_REQUESTED with a timestamp before the Worker terminal
    // fact may finalize CANCEL_REQUESTED -> CANCELLED (0012 transition trigger).
    const tenantRow = await owner.query<{ creator_id: string }>(
      'SELECT creator_id::text FROM agent_invocations WHERE id = $1',
      [fixture.invocationId],
    );
    const creatorId = tenantRow.rows[0]?.creator_id;
    if (creatorId === undefined) throw new Error('CANCELLED_CREATOR_MISSING');
    const cancelRequest = await owner.query(
      'UPDATE agent_invocations' +
        " SET state = 'CANCEL_REQUESTED', cancel_requested_at = clock_timestamp()" +
        " WHERE id = $1 AND creator_id = $2 AND state = 'RUNNING' RETURNING state",
      [fixture.invocationId, creatorId],
    );
    if (cancelRequest.rows[0]?.state !== 'CANCEL_REQUESTED') {
      throw new Error('CANCEL_REQUEST_TRANSITION_FAILED');
    }
    const cancelledFactFields = {
      protocol: WORKER_INVOCATION_FACT_PROTOCOL,
      schemaVersion: 1,
      type: 'invocation.cancelled',
      sourceEventId: fixture.invocationId,
      invocationId: fixture.invocationId,
      agentVersionDigest: fixture.versionDigest,
      snapshotDigest: digest('1'),
      executionCapabilityDigest: fixture.capabilityDigest,
      leaseId: lease.lease.leaseId,
      fence: lease.lease.fence,
    } as const;
    const receiptInput = {
      session,
      fact: cancelledFactFields,
      conversationId: fixture.conversationId,
      agentVersionId: fixture.versionId,
      startCommandId: running.startCommandId,
      runtimeThreadId: running.startedFact.runtimeThreadId,
      runtimeTurnId: running.startedFact.runtimeTurnId,
      dispatchReceiptDigest: running.startedFact.dispatchReceiptDigest,
      sandboxAttestationDigest: running.startedFact.sandboxAttestationDigest,
    };
    const admittedReceipt = cancelledInterruptReceipt(receiptInput);
    const admittedReceiptDigest = workerInterruptReceiptDigest(admittedReceipt);
    const admittedFact = {
      ...cancelledFactFields,
      interruptReceiptDigest: admittedReceiptDigest,
    } as const satisfies WorkerInvocationCancelledFact;
    const admittedEvent = invocationCancelled(session, lease, 2n, admittedFact, admittedReceipt);
    await expect(
      projectingAuthority.acceptEnvelope(
        session,
        delivery(admittedEvent),
        AbortSignal.timeout(5_000),
      ),
    ).resolves.toMatchObject([
      {
        type: 'message.ack',
        body: { decision: 'APPLIED', level: 'CLOUD_COMMITTED' },
      },
    ]);

    // The durable Worker fact digest is persisted on the cancelled event: recompute it in TS and
    // compare with the SQL-persisted source_fact_digest across the real projector chain.
    const persisted = await owner.query<{
      source_fact_digest: string;
      state: string;
      conversation_state: string;
      receipts: string;
      cancelled_events: string;
      consumer_events: string;
      alerts: string;
    }>(
      'SELECT' +
        ' (SELECT source_fact_digest FROM agent_invocation_events WHERE invocation_id = $1' +
        "   AND event_type = 'invocation.cancelled') AS source_fact_digest," +
        ' (SELECT state FROM agent_invocations WHERE id = $1) AS state,' +
        ' (SELECT state FROM agent_conversations WHERE id = $2) AS conversation_state,' +
        ' (SELECT count(*)::text FROM creator_agent_cancelled_terminal_receipts' +
        '   WHERE invocation_id = $1) AS receipts,' +
        ' (SELECT count(*)::text FROM agent_invocation_events' +
        "   WHERE invocation_id = $1 AND event_type = 'invocation.cancelled') AS cancelled_events," +
        ' (SELECT count(*)::text FROM consumer_event_outbox' +
        "   WHERE invocation_id = $1 AND event_type = 'invocation.terminal') AS consumer_events," +
        ' (SELECT count(*)::text FROM creator_agent_journal_integrity_alerts' +
        '   WHERE invocation_id = $1) AS alerts',
      [fixture.invocationId, fixture.conversationId],
    );
    const footprint = persisted.rows[0];
    if (footprint === undefined) throw new Error('CANCELLED_FOOTPRINT_MISSING');
    expect(footprint).toMatchObject({
      state: 'CANCELLED',
      conversation_state: 'IDLE',
      receipts: '1',
      cancelled_events: '1',
      consumer_events: '1',
      alerts: '0',
    });
    expect(footprint.source_fact_digest).toBe(workerInvocationFactDigest(admittedFact));

    // A new envelope for the exact same durable fact replays: one receipt, no second mutation.
    const exactEvent = invocationCancelled(session, lease, 3n, admittedFact, admittedReceipt);
    expect(exactEvent.messageId).not.toBe(admittedEvent.messageId);
    await expect(
      projectingAuthority.acceptEnvelope(session, delivery(exactEvent), AbortSignal.timeout(5_000)),
    ).resolves.toMatchObject([
      {
        type: 'message.ack',
        body: { decision: 'IDEMPOTENT_REPLAY', level: 'CLOUD_COMMITTED' },
      },
    ]);

    // Same terminal type but a different durable fact (new Host receipt) is a same-identity
    // conflict: the Cloud authority rejects it and the first receipt stays immutable.
    const conflictingReceipt = cancelledInterruptReceipt(receiptInput);
    const conflictingFact = {
      ...cancelledFactFields,
      interruptReceiptDigest: workerInterruptReceiptDigest(conflictingReceipt),
    } satisfies WorkerInvocationCancelledFact;
    const conflictEvent = invocationCancelled(
      session,
      lease,
      4n,
      conflictingFact,
      conflictingReceipt,
    );
    // The same-identity conflict (same source, different durable fact) is an invariant failure:
    // the Cloud authority rejects the mutation and the first receipt stays immutable, with no
    // integrity alert because no durable fact was admitted.
    await expect(
      projectingAuthority.acceptEnvelope(
        session,
        delivery(conflictEvent),
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toThrow();
    await expect(
      owner.query<{ receipts: string; alerts: string }>(
        'SELECT' +
          ' (SELECT count(*)::text FROM creator_agent_cancelled_terminal_receipts' +
          '   WHERE invocation_id = $1) AS receipts,' +
          ' (SELECT count(*)::text FROM creator_agent_journal_integrity_alerts' +
          '   WHERE invocation_id = $1) AS alerts',
        [fixture.invocationId],
      ),
    ).resolves.toMatchObject({ rows: [{ receipts: '1', alerts: '0' }] });

    // Terminal authority is exclusive in the other direction too: a cancelled fact for an
    // invocation that already reached SUCCEEDED is rejected as a terminal conflict.
    const successSeed = await seedInvocationProjectionFixture('cancelled-after-succeeded');
    const {
      fixture: successFixture,
      session: successSession,
      lease: successLease,
      assistantMessageSealer: successSealer,
      projectingAuthority: successAuthority,
    } = successSeed;
    const successRunning = await advanceFixtureToRunning(successSeed);
    const successResultDigest = 'hmac-sha256:' + randomBytes(32).toString('hex');
    const successFact = {
      protocol: WORKER_INVOCATION_FACT_PROTOCOL,
      schemaVersion: 1,
      type: 'invocation.succeeded',
      sourceEventId: successFixture.invocationId,
      invocationId: successFixture.invocationId,
      agentVersionDigest: successFixture.versionDigest,
      snapshotDigest: digest('1'),
      executionCapabilityDigest: successFixture.capabilityDigest,
      leaseId: successLease.lease.leaseId,
      fence: successLease.lease.fence,
      runtimeThreadId: successRunning.startedFact.runtimeThreadId,
      runtimeTurnId: successRunning.startedFact.runtimeTurnId,
      startedFactDigest: workerInvocationFactDigest(successRunning.startedFact),
      resultDigest: successResultDigest,
      localResultCipherDigest: randomBytes(32).toString('hex'),
    } as const satisfies WorkerInvocationSucceededFact;
    successSealer.mockImplementation(
      terminalSealer(successResultDigest, successFact.localResultCipherDigest),
    );
    const successEvent = invocationSucceeded(
      successSession,
      successLease,
      2n,
      successFixture.conversationId,
      successFact,
    );
    await expect(
      successAuthority.acceptEnvelope(
        successSession,
        delivery(successEvent),
        AbortSignal.timeout(5_000),
      ),
    ).resolves.toMatchObject([
      {
        type: 'message.ack',
        body: { decision: 'APPLIED', level: 'CLOUD_COMMITTED' },
      },
    ]);
    const lateCancelledFields = {
      protocol: WORKER_INVOCATION_FACT_PROTOCOL,
      schemaVersion: 1,
      type: 'invocation.cancelled',
      sourceEventId: successFixture.invocationId,
      invocationId: successFixture.invocationId,
      agentVersionDigest: successFixture.versionDigest,
      snapshotDigest: digest('1'),
      executionCapabilityDigest: successFixture.capabilityDigest,
      leaseId: successLease.lease.leaseId,
      fence: successLease.lease.fence,
    } as const;
    const lateReceipt = cancelledInterruptReceipt({
      session: successSession,
      fact: lateCancelledFields,
      conversationId: successFixture.conversationId,
      agentVersionId: successFixture.versionId,
      startCommandId: successRunning.startCommandId,
      runtimeThreadId: successRunning.startedFact.runtimeThreadId,
      runtimeTurnId: successRunning.startedFact.runtimeTurnId,
      dispatchReceiptDigest: successRunning.startedFact.dispatchReceiptDigest,
      sandboxAttestationDigest: successRunning.startedFact.sandboxAttestationDigest,
    });
    const lateCancelledFact = {
      ...lateCancelledFields,
      interruptReceiptDigest: workerInterruptReceiptDigest(lateReceipt),
    } as const satisfies WorkerInvocationCancelledFact;
    const lateCancelledEvent = invocationCancelled(
      successSession,
      successLease,
      3n,
      lateCancelledFact,
      lateReceipt,
    );
    // A cancelled terminal for an already-SUCCEEDED invocation is security-isolated exactly
    // like the failed/succeeded terminal-type conflicts: SECURITY_BLOCK ack plus Lease
    // revocation, and the succeeded terminal stays immutable.
    const lateBlocked = await successAuthority.acceptEnvelope(
      successSession,
      delivery(lateCancelledEvent),
      AbortSignal.timeout(5_000),
    );
    expect(lateBlocked).toMatchObject([
      {
        type: 'message.ack',
        body: { decision: 'SECURITY_BLOCK', level: 'CLOUD_COMMITTED' },
      },
      { type: 'lease.revoke', body: { reason: 'SECURITY' } },
    ]);
    await expect(
      owner.query<{ state: string }>('SELECT state FROM agent_invocations WHERE id = $1', [
        successFixture.invocationId,
      ]),
    ).resolves.toMatchObject({ rows: [{ state: 'SUCCEEDED' }] });
    expect(successSealer).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('security-isolates a failed terminal-type conflict after a durable succeeded chain', async () => {
    const seeded = await seedInvocationProjectionFixture('succeeded-failed-conflict');
    const { fixture, session, lease, assistantMessageSealer, projectingAuthority } = seeded;
    const running = await advanceFixtureToRunning(seeded);
    const resultDigest = `hmac-sha256:${randomBytes(32).toString('hex')}`;
    const succeededFact = {
      protocol: WORKER_INVOCATION_FACT_PROTOCOL,
      schemaVersion: 1,
      type: 'invocation.succeeded',
      sourceEventId: fixture.invocationId,
      invocationId: fixture.invocationId,
      agentVersionDigest: fixture.versionDigest,
      snapshotDigest: digest('1'),
      executionCapabilityDigest: fixture.capabilityDigest,
      leaseId: lease.lease.leaseId,
      fence: lease.lease.fence,
      runtimeThreadId: running.startedFact.runtimeThreadId,
      runtimeTurnId: running.startedFact.runtimeTurnId,
      startedFactDigest: workerInvocationFactDigest(running.startedFact),
      resultDigest,
      localResultCipherDigest: randomBytes(32).toString('hex'),
    } as const satisfies WorkerInvocationSucceededFact;
    assistantMessageSealer.mockImplementation(
      terminalSealer(resultDigest, succeededFact.localResultCipherDigest),
    );
    const succeededEvent = invocationSucceeded(
      session,
      lease,
      2n,
      fixture.conversationId,
      succeededFact,
    );
    await expect(
      projectingAuthority.acceptEnvelope(
        session,
        delivery(succeededEvent),
        AbortSignal.timeout(5_000),
      ),
    ).resolves.toMatchObject([
      {
        type: 'message.ack',
        body: { decision: 'APPLIED', level: 'CLOUD_COMMITTED' },
      },
    ]);
    expect(assistantMessageSealer).toHaveBeenCalledTimes(1);

    const failedFact = {
      protocol: WORKER_INVOCATION_FACT_PROTOCOL,
      schemaVersion: 1,
      type: 'invocation.failed',
      sourceEventId: fixture.invocationId,
      invocationId: fixture.invocationId,
      agentVersionDigest: fixture.versionDigest,
      snapshotDigest: digest('1'),
      executionCapabilityDigest: fixture.capabilityDigest,
      leaseId: lease.lease.leaseId,
      fence: lease.lease.fence,
      errorCode: 'TURN_FAILED',
    } as const satisfies WorkerInvocationFailedFact;
    const failedEvent = invocationFailedFact(session, lease, 3n, failedFact);
    const blocked = await projectingAuthority.acceptEnvelope(
      session,
      delivery(failedEvent),
      AbortSignal.timeout(5_000),
    );
    expect(blocked).toMatchObject([
      {
        type: 'message.ack',
        body: { decision: 'SECURITY_BLOCK', level: 'CLOUD_COMMITTED' },
      },
      { type: 'lease.revoke', body: { reason: 'SECURITY' } },
    ]);
    expect(assistantMessageSealer).toHaveBeenCalledTimes(1);

    await expect(
      owner.query<{
        state: string;
        result_message_id: string;
        result_digest: string;
        error_code: string | null;
        succeeded_events: string;
        failed_events: string;
        assistant_messages: string;
        consumer_events: string;
        start_commands: string;
        alerts: string;
        capability_revoked: boolean;
        lease_state: string;
        session_state: string;
        deployment_state: string;
        last_error_code: string;
      }>(
        `SELECT invocation.state, invocation.result_message_id::text,
                invocation.result_digest, invocation.error_code,
                (SELECT count(*)::text FROM agent_invocation_events AS event
                  WHERE event.invocation_id = invocation.id
                    AND event.event_type = 'invocation.succeeded') AS succeeded_events,
                (SELECT count(*)::text FROM agent_invocation_events AS event
                  WHERE event.invocation_id = invocation.id
                    AND event.event_type = 'invocation.failed') AS failed_events,
                (SELECT count(*)::text FROM agent_messages AS message
                  WHERE message.invocation_id = invocation.id
                    AND message.role = 'ASSISTANT') AS assistant_messages,
                (SELECT count(*)::text FROM consumer_event_outbox AS consumer_event
                  WHERE consumer_event.invocation_id = invocation.id
                    AND consumer_event.event_type = 'invocation.terminal') AS consumer_events,
                (SELECT count(*)::text FROM broker_outbox AS command
                  WHERE command.invocation_id = invocation.id
                    AND command.command_type = 'invocation.start') AS start_commands,
                (SELECT count(*)::text FROM creator_agent_journal_integrity_alerts AS alert
                  WHERE alert.invocation_id = invocation.id) AS alerts,
                invocation.execution_capability_revoked_at IS NOT NULL AS capability_revoked,
                lease.state AS lease_state, gateway.state AS session_state,
                deployment.observed_state AS deployment_state, deployment.last_error_code
           FROM agent_invocations AS invocation
           JOIN worker_leases AS lease ON lease.id = $2
           JOIN worker_gateway_sessions AS gateway ON gateway.id = $3
           JOIN deployments AS deployment ON deployment.id = $4
          WHERE invocation.id = $1`,
        [fixture.invocationId, lease.lease.leaseId, session.workerSessionId, fixture.deploymentId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: 'SUCCEEDED',
          result_message_id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
          result_digest: resultDigest,
          error_code: null,
          succeeded_events: '1',
          failed_events: '0',
          assistant_messages: '1',
          consumer_events: '1',
          start_commands: '1',
          alerts: '1',
          // SUCCEEDED is already terminal; its historical capability remains unstamped but inert.
          capability_revoked: false,
          lease_state: 'REVOKED',
          session_state: 'REVOKED',
          deployment_state: 'BLOCKED',
          last_error_code: 'WORKER_FACT_CONFLICT',
        },
      ],
    });
  }, 20_000);

  it('security-isolates a succeeded terminal-type conflict after a durable failed chain', async () => {
    const seeded = await seedInvocationProjectionFixture('failed-succeeded-conflict');
    const { fixture, session, lease, assistantMessageSealer, projectingAuthority } = seeded;
    const running = await advanceFixtureToRunning(seeded);
    const failedFact = {
      protocol: WORKER_INVOCATION_FACT_PROTOCOL,
      schemaVersion: 1,
      type: 'invocation.failed',
      sourceEventId: fixture.invocationId,
      invocationId: fixture.invocationId,
      agentVersionDigest: fixture.versionDigest,
      snapshotDigest: digest('1'),
      executionCapabilityDigest: fixture.capabilityDigest,
      leaseId: lease.lease.leaseId,
      fence: lease.lease.fence,
      errorCode: 'TURN_FAILED',
    } as const satisfies WorkerInvocationFailedFact;
    const failedEvent = invocationFailedFact(session, lease, 2n, failedFact);
    await expect(
      projectingAuthority.acceptEnvelope(
        session,
        delivery(failedEvent),
        AbortSignal.timeout(5_000),
      ),
    ).resolves.toMatchObject([
      {
        type: 'message.ack',
        body: { decision: 'APPLIED', level: 'CLOUD_COMMITTED' },
      },
    ]);
    expect(assistantMessageSealer).not.toHaveBeenCalled();

    const succeededFact = {
      protocol: WORKER_INVOCATION_FACT_PROTOCOL,
      schemaVersion: 1,
      type: 'invocation.succeeded',
      sourceEventId: fixture.invocationId,
      invocationId: fixture.invocationId,
      agentVersionDigest: fixture.versionDigest,
      snapshotDigest: digest('1'),
      executionCapabilityDigest: fixture.capabilityDigest,
      leaseId: lease.lease.leaseId,
      fence: lease.lease.fence,
      runtimeThreadId: running.startedFact.runtimeThreadId,
      runtimeTurnId: running.startedFact.runtimeTurnId,
      startedFactDigest: workerInvocationFactDigest(running.startedFact),
      resultDigest: `hmac-sha256:${randomBytes(32).toString('hex')}`,
      localResultCipherDigest: randomBytes(32).toString('hex'),
    } as const satisfies WorkerInvocationSucceededFact;
    const succeededEvent = invocationSucceeded(
      session,
      lease,
      3n,
      fixture.conversationId,
      succeededFact,
    );
    const blocked = await projectingAuthority.acceptEnvelope(
      session,
      delivery(succeededEvent),
      AbortSignal.timeout(5_000),
    );
    expect(blocked).toMatchObject([
      {
        type: 'message.ack',
        body: { decision: 'SECURITY_BLOCK', level: 'CLOUD_COMMITTED' },
      },
      { type: 'lease.revoke', body: { reason: 'SECURITY' } },
    ]);
    expect(assistantMessageSealer).not.toHaveBeenCalled();

    await expect(
      owner.query<{
        state: string;
        error_code: string;
        result_message_id: string | null;
        result_digest: string | null;
        failed_events: string;
        succeeded_events: string;
        assistant_messages: string;
        consumer_events: string;
        failed_receipts: string;
        succeeded_receipts: string;
        start_commands: string;
        alerts: string;
        capability_revoked: boolean;
        lease_state: string;
        session_state: string;
        deployment_state: string;
        last_error_code: string;
      }>(
        `SELECT invocation.state, invocation.error_code,
                invocation.result_message_id::text, invocation.result_digest,
                (SELECT count(*)::text FROM agent_invocation_events AS event
                  WHERE event.invocation_id = invocation.id
                    AND event.event_type = 'invocation.failed') AS failed_events,
                (SELECT count(*)::text FROM agent_invocation_events AS event
                  WHERE event.invocation_id = invocation.id
                    AND event.event_type = 'invocation.succeeded') AS succeeded_events,
                (SELECT count(*)::text FROM agent_messages AS message
                  WHERE message.invocation_id = invocation.id
                    AND message.role = 'ASSISTANT') AS assistant_messages,
                (SELECT count(*)::text FROM consumer_event_outbox AS consumer_event
                  WHERE consumer_event.invocation_id = invocation.id
                    AND consumer_event.event_type = 'invocation.terminal') AS consumer_events,
                (SELECT count(*)::text FROM creator_agent_failed_terminal_receipts AS receipt
                  WHERE receipt.invocation_id = invocation.id) AS failed_receipts,
                (SELECT count(*)::text FROM creator_agent_succeeded_terminal_receipts AS receipt
                  WHERE receipt.invocation_id = invocation.id) AS succeeded_receipts,
                (SELECT count(*)::text FROM broker_outbox AS command
                  WHERE command.invocation_id = invocation.id
                    AND command.command_type = 'invocation.start') AS start_commands,
                (SELECT count(*)::text FROM creator_agent_journal_integrity_alerts AS alert
                  WHERE alert.invocation_id = invocation.id) AS alerts,
                invocation.execution_capability_revoked_at IS NOT NULL AS capability_revoked,
                lease.state AS lease_state, gateway.state AS session_state,
                deployment.observed_state AS deployment_state, deployment.last_error_code
           FROM agent_invocations AS invocation
           JOIN worker_leases AS lease ON lease.id = $2
           JOIN worker_gateway_sessions AS gateway ON gateway.id = $3
           JOIN deployments AS deployment ON deployment.id = $4
          WHERE invocation.id = $1`,
        [fixture.invocationId, lease.lease.leaseId, session.workerSessionId, fixture.deploymentId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: 'FAILED',
          error_code: failedFact.errorCode,
          result_message_id: null,
          result_digest: null,
          failed_events: '1',
          succeeded_events: '0',
          assistant_messages: '0',
          consumer_events: '1',
          failed_receipts: '1',
          succeeded_receipts: '0',
          start_commands: '1',
          alerts: '1',
          capability_revoked: false,
          lease_state: 'REVOKED',
          session_state: 'REVOKED',
          deployment_state: 'BLOCKED',
          last_error_code: 'WORKER_FACT_CONFLICT',
        },
      ],
    });
  }, 20_000);

  it.each(['THROW', 'IGNORE_ABORT'] as const)(
    'rolls back Gateway frame and sequence state when the fresh success sealer is %s',
    async (mode) => {
      const seeded = await seedInvocationProjectionFixture(`success-sealer-${mode.toLowerCase()}`);
      const { fixture, session, lease, assistantMessageSealer, projectingAuthority } = seeded;
      const running = await advanceFixtureToRunning(seeded);
      const resultDigest = `hmac-sha256:${randomBytes(32).toString('hex')}`;
      if (mode === 'THROW') {
        assistantMessageSealer.mockImplementation(() => {
          throw new Error('SIMULATED_SUCCESS_SEALER_FAILURE');
        });
      } else {
        assistantMessageSealer.mockImplementation(() => new Promise<never>(() => undefined));
      }
      const fact = {
        protocol: WORKER_INVOCATION_FACT_PROTOCOL,
        schemaVersion: 1,
        type: 'invocation.succeeded',
        sourceEventId: fixture.invocationId,
        invocationId: fixture.invocationId,
        agentVersionDigest: fixture.versionDigest,
        snapshotDigest: digest('1'),
        executionCapabilityDigest: fixture.capabilityDigest,
        leaseId: lease.lease.leaseId,
        fence: lease.lease.fence,
        runtimeThreadId: running.startedFact.runtimeThreadId,
        runtimeTurnId: running.startedFact.runtimeTurnId,
        startedFactDigest: workerInvocationFactDigest(running.startedFact),
        resultDigest,
        localResultCipherDigest: randomBytes(32).toString('hex'),
      } as const satisfies WorkerInvocationSucceededFact;
      const event = invocationSucceeded(session, lease, 2n, fixture.conversationId, fact);
      const footprint = () =>
        owner.query<{
          invocation_state: string;
          assistant_messages: string;
          succeeded_events: string;
          consumer_events: string;
          terminal_receipts: string;
          alerts: string;
          start_commands: string;
          receipts: string;
          outbound_frames: string;
          inbound_next_seq: string;
          outbound_next_seq: string;
        }>(
          `SELECT invocation.state AS invocation_state,
                  (SELECT count(*)::text FROM agent_messages AS message
                    WHERE message.invocation_id = invocation.id
                      AND message.role = 'ASSISTANT') AS assistant_messages,
                  (SELECT count(*)::text FROM agent_invocation_events AS terminal
                    WHERE terminal.invocation_id = invocation.id
                      AND terminal.event_type = 'invocation.succeeded') AS succeeded_events,
                  (SELECT count(*)::text FROM consumer_event_outbox AS consumer_event
                    WHERE consumer_event.invocation_id = invocation.id
                      AND consumer_event.event_type = 'invocation.terminal') AS consumer_events,
                  (SELECT count(*)::text FROM creator_agent_succeeded_terminal_receipts AS receipt
                    WHERE receipt.invocation_id = invocation.id) AS terminal_receipts,
                  (SELECT count(*)::text FROM creator_agent_journal_integrity_alerts AS alert
                    WHERE alert.invocation_id = invocation.id) AS alerts,
                  (SELECT count(*)::text FROM broker_outbox AS command
                    WHERE command.invocation_id = invocation.id
                      AND command.command_type = 'invocation.start') AS start_commands,
                  (SELECT count(*)::text FROM worker_gateway_frame_receipts AS receipt
                    WHERE receipt.session_id = gateway.id) AS receipts,
                  (SELECT count(*)::text FROM worker_gateway_outbound_frames AS frame
                    WHERE frame.session_id = gateway.id) AS outbound_frames,
                  gateway.inbound_next_seq::text, gateway.outbound_next_seq::text
             FROM agent_invocations AS invocation
             JOIN worker_gateway_sessions AS gateway ON gateway.id = $2
            WHERE invocation.id = $1`,
          [fixture.invocationId, session.workerSessionId],
        );
      const before = await footprint();
      expect(before.rows).toEqual([
        {
          invocation_state: 'RUNNING',
          assistant_messages: '0',
          succeeded_events: '0',
          consumer_events: '0',
          terminal_receipts: '0',
          alerts: '0',
          start_commands: '1',
          receipts: '2',
          outbound_frames: '3',
          inbound_next_seq: '2',
          outbound_next_seq: '3',
        },
      ]);

      await expect(
        projectingAuthority.acceptEnvelope(
          session,
          delivery(event),
          mode === 'THROW' ? AbortSignal.timeout(5_000) : AbortSignal.timeout(100),
        ),
      ).rejects.toBeDefined();
      expect(assistantMessageSealer).toHaveBeenCalledTimes(1);
      expect((await footprint()).rows).toEqual(before.rows);
    },
    10_000,
  );

  it('serializes a first Lease grant with concurrent SECURITY revocation', async () => {
    const raceAgentId = randomUuidV7();
    const raceVersionId = randomUuidV7();
    const raceDeploymentId = randomUuidV7();
    const raceInstallationId = randomUuidV7();
    const raceKeyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const matchingCapabilities = JSON.stringify({
      codexRuntimeArtifacts: [RUNTIME_DIGEST],
      codexProtocolSchemaDigests: [PROTOCOL_DIGEST],
      isolationModes: ['apple-container-v1'],
      brokerContractDigest: BROKER_CONTRACT_DIGEST,
    });
    await owner.query(
      `INSERT INTO agents (id, creator_id, public_slug, name)
       VALUES ($1, $2, $3, 'Gateway open/revoke race')`,
      [raceAgentId, ids.creatorId, `gateway-race-${raceAgentId.slice(0, 8)}`],
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
         '0.147.0-alpha.6.5', $11, $12
       )`,
      [
        raceVersionId,
        raceAgentId,
        ids.creatorId,
        randomBytes(32).toString('hex'),
        ids.snapshotId,
        randomBytes(32).toString('hex'),
        JSON.stringify(TEST_RUNTIME_POLICY),
        randomBytes(32).toString('hex'),
        randomBytes(32).toString('hex'),
        randomBytes(32).toString('hex'),
        RUNTIME_DIGEST,
        PROTOCOL_DIGEST,
      ],
    );
    await owner.query(
      `INSERT INTO agent_version_controls (version_id, creator_id) VALUES ($1, $2)`,
      [raceVersionId, ids.creatorId],
    );
    await owner.query(
      `INSERT INTO deployments (
         id, agent_id, creator_id, environment, desired_state,
         desired_version_id, generation
       ) VALUES ($1, $2, $3, 'TEST', 'ONLINE', $4, 1)`,
      [raceDeploymentId, raceAgentId, ids.creatorId, raceVersionId],
    );
    await owner.query(
      `INSERT INTO worker_installations (
         id, creator_id, installation_key_id, device_public_key,
         worker_version, protocol_versions, capabilities
       ) VALUES ($1, $2, $3, $4, $5, '[1]'::jsonb, $6::jsonb)`,
      [
        raceInstallationId,
        ids.creatorId,
        `gateway-key-${raceInstallationId}`,
        publicPoint(raceKeyPair.publicKey),
        WORKER_VERSION,
        matchingCapabilities,
      ],
    );
    const challenge = await authority.issueChallenge({
      creatorId: ids.creatorId,
      installationId: raceInstallationId,
      deploymentId: raceDeploymentId,
      deploymentGeneration: '1',
      operationId: randomUuidV7(),
      signal: AbortSignal.timeout(5_000),
    });
    const session = await authority.authenticate({
      handshake: signedHandshake(raceKeyPair.privateKey, raceInstallationId, challenge.challengeId),
      connectedAt: new Date().toISOString(),
      signal: AbortSignal.timeout(5_000),
    });

    let leaseInserted!: () => void;
    let releaseLease!: () => void;
    const leaseInsertedPromise = new Promise<void>((resolve) => (leaseInserted = resolve));
    const leaseBarrier = new Promise<void>((resolve) => (releaseLease = resolve));
    let paused = false;
    const racingAuthority = new PostgresAgentGatewayAuthority(
      pools,
      policy,
      undefined,
      async (step) => {
        if (step !== 'LEASE_INSERTED' || paused) return;
        paused = true;
        leaseInserted();
        await leaseBarrier;
      },
    );
    const pendingOpen = racingAuthority.openSession(session, AbortSignal.timeout(5_000));
    await leaseInsertedPromise;

    // PostgreSQL truncates application_name at NAMEDATALEN; keep the deterministic
    // wait probe safely below that boundary.
    const revokerName = `gw-open-revoke-${randomUuidV7()}`;
    const revokerUrl = new URL(databaseUrl ?? 'postgresql://invalid');
    revokerUrl.searchParams.set('application_name', revokerName);
    const revoker = new Client({ connectionString: revokerUrl.toString() });
    await revoker.connect();
    const pendingRevocation = revoker.query(
      `UPDATE agent_version_controls
          SET availability = 'REVOKED', severity = 'SECURITY',
              reason_code = 'OPEN_SESSION_RACE_REVOKED', updated_at = statement_timestamp()
        WHERE version_id = $1`,
      [raceVersionId],
    );
    try {
      await waitForPgWaitEvent(owner, revokerName, 'advisory');
      releaseLease();
      const [opened] = await Promise.all([pendingOpen, pendingRevocation]);
      expect(opened.map((frame) => frame.type)).toEqual(['lease.grant']);
    } finally {
      releaseLease();
      await revoker.end();
    }

    const fenced = await owner.query<{
      lease_state: string;
      session_state: string;
      observed_state: string;
      active_leases: string;
    }>(
      `SELECT lease.state AS lease_state, gateway.state AS session_state,
              deployment.observed_state,
              (SELECT count(*)::text FROM worker_leases AS active
                WHERE active.creator_id = deployment.creator_id
                  AND active.deployment_id = deployment.id
                  AND active.state = 'ACTIVE') AS active_leases
         FROM worker_gateway_sessions AS gateway
         JOIN worker_leases AS lease ON lease.connection_id = gateway.connection_id
         JOIN deployments AS deployment ON deployment.id = lease.deployment_id
        WHERE gateway.id = $1`,
      [session.workerSessionId],
    );
    expect(fenced.rows).toEqual([
      {
        lease_state: 'REVOKED',
        session_state: 'REVOKED',
        observed_state: 'BLOCKED',
        active_leases: '0',
      },
    ]);
  });
});

function nextTextFrame(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
      cleanup();
      if (isBinary) reject(new Error('unexpected binary Gateway frame'));
      else resolve(Buffer.from(data as Buffer).toString('utf8'));
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('Gateway socket closed before a frame arrived'));
    };
    const cleanup = (): void => {
      socket.off('message', onMessage);
      socket.off('close', onClose);
    };
    socket.on('message', onMessage);
    socket.on('close', onClose);
  });
}

async function waitForPgWaitEvent(
  pool: Client,
  applicationName: string,
  expectedWaitEvent: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const observed = await pool.query<{ wait_event: string | null }>(
      `SELECT wait_event
         FROM pg_stat_activity
        WHERE application_name = $1 AND state = 'active'`,
      [applicationName],
    );
    if (observed.rows.some((row) => row.wait_event === expectedWaitEvent)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`PostgreSQL did not enter ${expectedWaitEvent} wait`);
}

function nextTextFrames(socket: WebSocket, count: number): Promise<readonly string[]> {
  return new Promise((resolve, reject) => {
    const frames: string[] = [];
    const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
      if (isBinary) {
        cleanup();
        reject(new Error('unexpected binary Gateway frame'));
        return;
      }
      frames.push(Buffer.from(data as Buffer).toString('utf8'));
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
