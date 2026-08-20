import { readFileSync } from 'node:fs';

import {
  BrokerEnvelopeSchema,
  BrokerSensitiveMessageSchema,
  brokerSensitiveMessageAadDigest,
  brokerSensitiveMessageCipherDigest,
  canonicalSha256,
  canonicalizeJson,
  currentBrokerContractDigest,
  executionCapabilityDigest,
  type BrokerSensitiveMessage,
} from '@cb/creator-agent-protocol';
import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedWorkerSession } from './gateway.js';
import type { GatewayUserMessageSealer } from './lifecycle-outbound.js';
import {
  PostgresAgentGatewayAuthority,
  type GatewayCompatibilityPolicy,
  type GatewayConnection,
  type GatewayPool,
  type GatewayQueryResult,
} from './postgres-authority.js';

const fixture = (() => {
  const parsed = BrokerEnvelopeSchema.parse(
    JSON.parse(
      readFileSync(
        new URL(
          '../../../packages/creator-agent-protocol/fixtures/broker-invocation-prepare.v1.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as unknown,
  );
  if (parsed.type !== 'invocation.prepare') throw new Error('prepare fixture required');
  return parsed;
})();

const OWNER_ID = '0198f00d-3000-7000-8000-000000000020';
const USER_MESSAGE_ID = '0198f00d-3000-7000-8000-000000000021';
const REPLACEMENT_SESSION_ID = '0198f00d-3000-7000-8000-000000000022';
const REPLACEMENT_CONNECTION_ID = '0198f00d-3000-7000-8000-000000000023';
const REPLACEMENT_LEASE_ID = '0198f00d-3000-7000-8000-000000000024';
const START_COMMAND_ID = '0198f00d-3000-7000-8000-000000000025';

const POLICY: GatewayCompatibilityPolicy = {
  acceptedWorkerVersions: ['combo-worker-test/1'],
  acceptedCodexRuntimeArtifacts: [`sha256:${'a'.repeat(64)}`],
  acceptedCodexProtocolSchemaDigests: [`sha256:${'b'.repeat(64)}`],
  acceptedIsolationModes: ['apple-container-v1'],
  acceptedBrokerContractDigests: [currentBrokerContractDigest()],
  publisherDeploymentAllowlist: [fixture.lease.deploymentId],
  sessionTtlMs: 60_000,
  leaseTtlMs: 10_000,
  responseTtlMs: 5_000,
  transactionTimeoutMs: 100,
};

const ORIGINAL_SESSION: AuthenticatedWorkerSession = {
  ownerId: OWNER_ID,
  installationId: fixture.body.executionCapability.workerInstallationId,
  connectionId: fixture.connectionId,
  workerSessionId: fixture.lease.workerSessionId,
};
const REPLACEMENT_SESSION: AuthenticatedWorkerSession = {
  ...ORIGINAL_SESSION,
  connectionId: REPLACEMENT_CONNECTION_ID,
  workerSessionId: REPLACEMENT_SESSION_ID,
};

type CommandVariant = 'invocation.prepare' | 'invocation.start';

type StoredLifecycleFrame = {
  session_id: string;
  creator_id: string;
  sequence: string;
  message_id: string;
  canonical_digest: string;
  envelope_type: CommandVariant;
  broker_deployment_id: string;
  claim_connection_id: string;
  current_delivery_lease_id: string;
  current_delivery_fence: string;
  wire_sent_at: string;
  wire_expires_at: string;
  wire_envelope: unknown;
  wire_canonical_text: string | null;
  durable_ack_level: string | null;
  wire_retryable: boolean;
};

type StoredOperationReceipt = {
  operation_kind: string;
  operation_key: string;
  request_digest: string;
  result_value: unknown;
  result_digest: string;
};

class LifecyclePublisherPool implements GatewayPool {
  readonly queries: string[] = [];
  readonly frames = new Map<string, StoredLifecycleFrame>();
  readonly operationReceipts: StoredOperationReceipt[] = [];
  readonly #authority = new Map<
    string,
    { leaseId: string; fence: string; outboundNextSequence: string }
  >();
  #loseNextCommit = false;

  constructor(
    readonly variant: CommandVariant = 'invocation.prepare',
    readonly commandOverride: Readonly<Record<string, unknown>> = {},
  ) {
    this.registerSession(
      ORIGINAL_SESSION,
      fixture.lease.leaseId,
      fixture.lease.fence,
      fixture.sequence,
    );
  }

  registerSession(
    session: AuthenticatedWorkerSession,
    leaseId: string,
    fence: string,
    outboundNextSequence = '0',
  ): void {
    this.#authority.set(session.workerSessionId, { leaseId, fence, outboundNextSequence });
  }

  armCommitResponseLoss(): void {
    this.#loseNextCommit = true;
  }

  async connect(): Promise<GatewayConnection> {
    return {
      query: <Row>(sql: string, parameters?: readonly unknown[]) =>
        this.#query<Row>(sql, parameters),
      release: () => undefined,
    };
  }

  async #query<Row>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<GatewayQueryResult<Row>> {
    const normalized = sql.trim().replace(/\s+/gu, ' ');
    this.queries.push(normalized);
    if (sql.includes('SELECT command.command_id::text, command.deployment_id::text')) {
      return result([
        {
          command_id: this.commandId,
          deployment_id: fixture.lease.deploymentId,
          command_type: this.variant,
          payload_contract_version: 2,
        },
      ] as Row[]);
    }
    if (sql.includes('SELECT gateway.registration_digest, gateway.outbound_next_seq')) {
      const sessionId = String(parameters?.[0]);
      const authority = this.#authority.get(sessionId);
      if (authority === undefined) return result([]);
      const capabilities = {
        codexRuntimeArtifacts: POLICY.acceptedCodexRuntimeArtifacts,
        codexProtocolSchemaDigests: POLICY.acceptedCodexProtocolSchemaDigests,
        isolationModes: POLICY.acceptedIsolationModes,
        brokerContractDigest: POLICY.acceptedBrokerContractDigests[0],
      };
      return result([
        {
          registration_digest: canonicalSha256({
            workerVersion: POLICY.acceptedWorkerVersions[0],
            protocolVersions: [1],
            capabilities,
          }),
          outbound_next_seq: authority.outboundNextSequence,
          session_expires_at: fixture.body.deadlineAt,
          lease_id: authority.leaseId,
          lease_fence: authority.fence,
          lease_expires_at: fixture.body.deadlineAt,
          worker_version: POLICY.acceptedWorkerVersions[0],
          protocol_versions: [1],
          capabilities,
          revoked_at: null,
        },
      ] as Row[]);
    }
    if (sql.includes('creator_agent_lock_gateway_lifecycle_command_v2')) {
      return result([this.commandRow] as Row[]);
    }
    if (
      sql.includes('SELECT sequence, canonical_digest, durable_ack_level') &&
      sql.includes('wire_canonical_text')
    ) {
      const frame = this.frames.get(frameKey(String(parameters?.[0]), String(parameters?.[2])));
      return result((frame === undefined ? [] : [frame]) as Row[]);
    }
    if (sql.includes('FROM worker_gateway_frame_receipts')) return result([]);
    if (sql.includes('INSERT INTO worker_gateway_outbound_frames')) {
      if (parameters === undefined || parameters.length !== 18) throw new Error('bad frame insert');
      const canonicalText = String(parameters[14]);
      const frame: StoredLifecycleFrame = {
        session_id: String(parameters[0]),
        creator_id: String(parameters[1]),
        sequence: String(parameters[2]),
        message_id: String(parameters[3]),
        canonical_digest: String(parameters[4]),
        envelope_type: String(parameters[5]) as CommandVariant,
        broker_deployment_id: String(parameters[7]),
        claim_connection_id: String(parameters[8]),
        current_delivery_lease_id: String(parameters[9]),
        current_delivery_fence: String(parameters[10]),
        wire_sent_at: String(parameters[11]),
        wire_expires_at: String(parameters[12]),
        wire_envelope: JSON.parse(String(parameters[13])) as unknown,
        wire_canonical_text: canonicalText,
        durable_ack_level: parameters[15] === null ? null : String(parameters[15]),
        wire_retryable: true,
      };
      this.frames.set(frameKey(frame.session_id, frame.message_id), frame);
      return result([], 1);
    }
    if (sql.startsWith('UPDATE worker_gateway_sessions')) {
      const authority = this.#authority.get(String(parameters?.[0]));
      if (authority === undefined || authority.outboundNextSequence !== String(parameters?.[3])) {
        return result([], 0);
      }
      authority.outboundNextSequence = (BigInt(authority.outboundNextSequence) + 1n).toString();
      return result([], 1);
    }
    if (sql.includes('UPDATE broker_outbox')) return result([], 1);
    if (sql.includes('INSERT INTO worker_gateway_operation_receipts')) {
      if (parameters === undefined || parameters.length !== 6) throw new Error('bad receipt');
      this.operationReceipts.push({
        operation_kind: String(parameters[1]),
        operation_key: String(parameters[2]),
        request_digest: String(parameters[3]),
        result_value: JSON.parse(String(parameters[4])) as unknown,
        result_digest: String(parameters[5]),
      });
      return result([], 1);
    }
    if (sql.includes('FROM worker_gateway_operation_receipts')) {
      const receipt = this.operationReceipts.find(
        (candidate) =>
          candidate.operation_kind === String(parameters?.[1]) &&
          candidate.operation_key === String(parameters?.[2]),
      );
      return result((receipt === undefined ? [] : [receipt]) as Row[]);
    }
    if (sql.includes('SELECT wire_canonical_text, wire_envelope, broker_deployment_id::text')) {
      const frame = this.frames.get(frameKey(String(parameters?.[0]), String(parameters?.[2])));
      return result((frame === undefined ? [] : [frame]) as Row[]);
    }
    if (sql === 'COMMIT' && this.#loseNextCommit) {
      this.#loseNextCommit = false;
      throw new Error('simulated response loss after commit');
    }
    return result([]);
  }

  get commandId(): string {
    return this.variant === 'invocation.prepare' ? fixture.messageId : START_COMMAND_ID;
  }

  get commandRow(): Readonly<Record<string, unknown>> {
    const capability = fixture.body.executionCapability;
    return {
      command_type: this.variant,
      command_id: this.commandId,
      invocation_id: fixture.body.invocationId,
      creator_id: OWNER_ID,
      conversation_id: fixture.body.conversationId,
      client_message_id: fixture.body.clientMessageId,
      request_digest: fixture.body.requestDigest,
      deployment_id: fixture.lease.deploymentId,
      installation_id: capability.workerInstallationId,
      assignment_lease_id: capability.leaseId,
      assignment_fence: capability.fence,
      agent_version_id: fixture.body.agentVersionId,
      agent_version_digest: fixture.body.agentVersionDigest,
      snapshot_digest: fixture.body.snapshotDigest,
      deadline_at: fixture.body.deadlineAt,
      execution_capability_wire: capability,
      execution_capability_id: capability.capabilityId,
      execution_capability_digest: executionCapabilityDigest(capability),
      predecessor_command_id: this.variant === 'invocation.start' ? fixture.messageId : null,
      cancel_reason: null,
      message_id: this.variant === 'invocation.prepare' ? USER_MESSAGE_ID : null,
      content_algorithm: this.variant === 'invocation.prepare' ? 'aes-256-gcm/v1' : null,
      content_key_id: this.variant === 'invocation.prepare' ? 'owner-message-test-1' : null,
      content_nonce: this.variant === 'invocation.prepare' ? Buffer.alloc(12, 1) : null,
      content_ciphertext: this.variant === 'invocation.prepare' ? Buffer.from('durable') : null,
      content_auth_tag: this.variant === 'invocation.prepare' ? Buffer.alloc(16, 2) : null,
      content_cipher_digest: this.variant === 'invocation.prepare' ? 'c'.repeat(64) : null,
      content_digest:
        this.variant === 'invocation.prepare' ? `hmac-sha256:${'d'.repeat(64)}` : null,
      content_aad_version: this.variant === 'invocation.prepare' ? 1 : null,
      wire_sent_at: fixture.sentAt,
      wire_expires_at: fixture.expiresAt,
      ...this.commandOverride,
    };
  }
}

function result<Row>(rows: Row[], rowCount = rows.length): GatewayQueryResult<Row> {
  return { rows, rowCount };
}

function frameKey(sessionId: string, commandId: string): string {
  return `${sessionId}:${commandId}`;
}

function createSealer() {
  let seals = 0;
  return vi.fn<GatewayUserMessageSealer>(async (input): Promise<BrokerSensitiveMessage> => {
    seals += 1;
    const nonce = Buffer.alloc(12, seals).toString('base64url');
    const ciphertext = Buffer.from(`sealed-${seals}`, 'utf8').toString('base64url');
    const authTag = Buffer.alloc(16, seals + 10).toString('base64url');
    const aad = {
      protocol: 'combo.creator-broker/1' as const,
      schemaVersion: 1 as const,
      envelopeType: 'invocation.prepare' as const,
      messageId: input.command.messageId,
      conversationId: input.command.conversationId,
      invocationId: input.command.invocationId,
      workerSessionId: input.command.workerSessionId,
      role: 'USER' as const,
      keyId: 'worker-session-test-1',
    };
    return BrokerSensitiveMessageSchema.parse({
      algorithm: 'aes-256-gcm/v1',
      keyScope: 'worker-session',
      keyId: aad.keyId,
      nonce,
      ciphertext,
      authTag,
      cipherDigest: brokerSensitiveMessageCipherDigest(nonce, ciphertext, authTag),
      aad,
      aadDigest: brokerSensitiveMessageAadDigest(aad),
      aadVersion: 1,
    });
  });
}

function authority(pool: LifecyclePublisherPool, sealer = createSealer()) {
  return {
    authority: new PostgresAgentGatewayAuthority(
      { api: pool, broker: pool },
      POLICY,
      undefined,
      undefined,
      sealer,
    ),
    sealer,
  };
}

describe('Postgres lifecycle payload-v2 publisher', () => {
  it('persists exact canonical bytes before its ref-only receipt and replays with sealer=0', async () => {
    const pool = new LifecyclePublisherPool();
    const composition = authority(pool);
    const first = await composition.authority.claimBrokerCommand(
      ORIGINAL_SESSION,
      AbortSignal.timeout(2_000),
    );
    expect(first?.type).toBe('invocation.prepare');
    expect(composition.sealer).toHaveBeenCalledTimes(1);
    const canonicalText = canonicalizeJson(first);
    const stored = pool.frames.get(frameKey(ORIGINAL_SESSION.workerSessionId, fixture.messageId));
    expect(stored?.wire_canonical_text).toBe(canonicalText);
    expect(stored?.canonical_digest).toBe(canonicalSha256(first));
    const frameInsert = pool.queries.findIndex((sql) =>
      sql.startsWith('INSERT INTO worker_gateway_outbound_frames'),
    );
    const receiptInsert = pool.queries.findIndex((sql) =>
      sql.startsWith('INSERT INTO worker_gateway_operation_receipts'),
    );
    expect(frameInsert).toBeGreaterThan(-1);
    expect(receiptInsert).toBeGreaterThan(frameInsert);
    expect(pool.operationReceipts[0]?.result_value).toEqual({
      sessionId: ORIGINAL_SESSION.workerSessionId,
      commandId: fixture.messageId,
      sequence: fixture.sequence,
      canonicalDigest: canonicalSha256(first),
    });
    expect(JSON.stringify(pool.operationReceipts[0]?.result_value)).not.toMatch(
      /cipher|body|envelope|prompt/iu,
    );

    composition.sealer.mockClear();
    const replay = await composition.authority.claimBrokerCommand(
      ORIGINAL_SESSION,
      AbortSignal.timeout(2_000),
    );
    expect(composition.sealer).not.toHaveBeenCalled();
    expect(canonicalizeJson(replay)).toBe(canonicalText);
    expect(replay).toEqual(first);
  });

  it('fresh-seals only a replacement Session while preserving immutable execution authority', async () => {
    const pool = new LifecyclePublisherPool();
    pool.registerSession(REPLACEMENT_SESSION, REPLACEMENT_LEASE_ID, '43');
    const composition = authority(pool);
    const original = await composition.authority.claimBrokerCommand(
      ORIGINAL_SESSION,
      AbortSignal.timeout(2_000),
    );
    const replacement = await composition.authority.claimBrokerCommand(
      REPLACEMENT_SESSION,
      AbortSignal.timeout(2_000),
    );
    expect(composition.sealer).toHaveBeenCalledTimes(2);
    if (original?.type !== 'invocation.prepare' || replacement?.type !== 'invocation.prepare') {
      throw new Error('prepare required');
    }
    expect(replacement.connectionId).toBe(REPLACEMENT_CONNECTION_ID);
    expect(replacement.lease).toEqual({
      deploymentId: fixture.lease.deploymentId,
      leaseId: REPLACEMENT_LEASE_ID,
      workerSessionId: REPLACEMENT_SESSION_ID,
      fence: '43',
    });
    expect(replacement.body.executionCapability).toEqual(original.body.executionCapability);
    expect(replacement.body.userMessageCiphertext).not.toEqual(original.body.userMessageCiphertext);
    expect(replacement.body.userMessageCiphertext.aad.workerSessionId).toBe(REPLACEMENT_SESSION_ID);
  });

  it('recovers COMMIT response loss through a ref receipt and exact immutable frame read', async () => {
    const pool = new LifecyclePublisherPool();
    pool.armCommitResponseLoss();
    const composition = authority(pool);
    const claimed = await composition.authority.claimBrokerCommand(
      ORIGINAL_SESSION,
      AbortSignal.timeout(2_000),
    );
    expect(claimed?.type).toBe('invocation.prepare');
    expect(composition.sealer).toHaveBeenCalledTimes(1);
    expect(pool.operationReceipts).toHaveLength(1);
    expect(canonicalizeJson(claimed)).toBe(
      pool.frames.get(frameKey(ORIGINAL_SESSION.workerSessionId, fixture.messageId))
        ?.wire_canonical_text,
    );
    expect(
      pool.queries.filter((sql) => sql.includes('FROM worker_gateway_operation_receipts')),
    ).toHaveLength(2);
  });

  it('recomputes the full predecessor capability for start and fails closed on tamper', async () => {
    const validPool = new LifecyclePublisherPool('invocation.start');
    const valid = authority(validPool);
    await expect(
      valid.authority.claimBrokerCommand(ORIGINAL_SESSION, AbortSignal.timeout(2_000)),
    ).resolves.toMatchObject({
      type: 'invocation.start',
      body: {
        invocationId: fixture.body.invocationId,
        prepareCommandId: fixture.messageId,
        executionCapabilityId: fixture.body.executionCapability.capabilityId,
      },
    });
    expect(valid.sealer).not.toHaveBeenCalled();

    const tamperedCapability = {
      ...fixture.body.executionCapability,
      requestDigest: `hmac-sha256:${'f'.repeat(64)}`,
    };
    const tamperedPool = new LifecyclePublisherPool('invocation.start', {
      execution_capability_wire: tamperedCapability,
    });
    const tampered = authority(tamperedPool);
    await expect(
      tampered.authority.claimBrokerCommand(ORIGINAL_SESSION, AbortSignal.timeout(2_000)),
    ).rejects.toThrow();
    expect(tamperedPool.frames).toHaveLength(0);
  });

  it('rejects null or binding-tampered exact frame text without calling the sealer', async () => {
    for (const mutate of [
      (frame: StoredLifecycleFrame) => {
        frame.wire_canonical_text = null;
      },
      (frame: StoredLifecycleFrame) => {
        frame.broker_deployment_id = '0198f00d-3000-7000-8000-000000000099';
      },
    ]) {
      const pool = new LifecyclePublisherPool();
      const composition = authority(pool);
      await composition.authority.claimBrokerCommand(ORIGINAL_SESSION, AbortSignal.timeout(2_000));
      composition.sealer.mockClear();
      const frame = pool.frames.get(frameKey(ORIGINAL_SESSION.workerSessionId, fixture.messageId));
      if (frame === undefined) throw new Error('frame required');
      mutate(frame);
      await expect(
        composition.authority.claimBrokerCommand(ORIGINAL_SESSION, AbortSignal.timeout(2_000)),
      ).rejects.toThrow();
      expect(composition.sealer).not.toHaveBeenCalled();
    }
  });
});
