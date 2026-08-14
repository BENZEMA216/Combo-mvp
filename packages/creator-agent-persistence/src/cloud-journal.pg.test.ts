import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import {
  CONSUMER_EVENT_OUTBOX_PROTOCOL,
  ConsumerTerminalEventPayloadSchema,
  WORKER_INVOCATION_FACT_PROTOCOL,
  brokerSensitiveMessageAadBytes,
  brokerSensitiveMessageAadDigest,
  brokerSensitiveMessageCipherDigest,
  consumerEventPayloadDigest,
  domainSeparatedHmacSha256,
  workerInvocationFactDigest,
  type BrokerSensitiveMessage,
  type WorkerInvocationPreparedFact,
  type WorkerInvocationStartedFact,
  type WorkerInvocationSucceededFact,
} from '@cb/creator-agent-protocol';
import { Client, Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PostgresCloudJournal,
  type AcceptInvocationInput,
  type AssistantMessageSealer,
  type CloudJournalError,
  type CloudJournalStep,
  type CommitPreparedInput,
  type CommitStartedInput,
  type CommitSuccessInput,
  type InvocationProjectorTransaction,
  type JournalPool,
  type QueryResult,
} from './cloud-journal.js';
import { encryptMessage, type MessageRole } from './message-crypto.js';

const databaseUrl = process.env.DATABASE_URL;
const apiPassword = process.env.POSTGRES_AGENT_API_PASSWORD;
const brokerPassword = process.env.POSTGRES_AGENT_BROKER_PASSWORD;
const reconcilerPassword = process.env.POSTGRES_AGENT_RECONCILER_PASSWORD;
const enabled =
  process.env.CREATOR_AGENT_PERSISTENCE_PG_TEST === '1' &&
  Boolean(databaseUrl && apiPassword && brokerPassword && reconcilerPassword);
const pgDescribe = enabled ? describe : describe.skip;

function randomUuidV7(): string {
  const value = randomUUID();
  return `${value.slice(0, 14)}7${value.slice(15)}`;
}

function roleUrl(
  role: 'combo_agent_api' | 'combo_agent_broker' | 'combo_agent_reconciler',
  password: string,
): string {
  const url = new URL(databaseUrl ?? 'postgresql://invalid:invalid@127.0.0.1:1/invalid');
  url.username = role;
  url.password = password;
  return url.toString();
}

function digest(character: string): string {
  return character.repeat(64);
}

function hmac(character: string): `hmac-sha256:${string}` {
  return `hmac-sha256:${character.repeat(64)}`;
}

pgDescribe('PostgresCloudJournal real transactions', () => {
  const owner = new Client({ connectionString: databaseUrl });
  const apiPool = new Pool({
    connectionString: roleUrl('combo_agent_api', apiPassword ?? 'invalid'),
    max: 12,
  });
  const brokerPool = new Pool({
    connectionString: roleUrl('combo_agent_broker', brokerPassword ?? 'invalid'),
    max: 4,
  });
  const reconcilerPool = new Pool({
    connectionString: roleUrl('combo_agent_reconciler', reconcilerPassword ?? 'invalid'),
    max: 2,
  });
  const journalPools = {
    api: apiPool as unknown as JournalPool,
    broker: brokerPool as unknown as JournalPool,
    reconciler: reconcilerPool as unknown as JournalPool,
  };
  const ids = {
    creatorId: '',
    consumerId: '',
    snapshotId: randomUuidV7(),
    agentId: randomUuidV7(),
    agentVersionId: randomUuidV7(),
    deploymentId: randomUuidV7(),
    workerId: randomUuidV7(),
    leaseId: randomUuidV7(),
  };
  const encryptionKey = Buffer.alloc(32, 0x31);
  const digestKey = Buffer.alloc(32, 0x32);
  const transportKey = Buffer.alloc(32, 0x33);
  let nonceCounter = 1;
  let transportNonceCounter = 1;

  interface TestExecutionAssignment {
    deploymentId: string;
    workerId: string;
    leaseId: string;
    fence: string;
  }

  interface ExecutionAuthority extends TestExecutionAssignment {
    executionCapabilityId: string;
    executionCapabilityDigest: string;
  }

  interface StartedExecutionAuthority extends ExecutionAuthority {
    runtimeThreadId: string;
    runtimeTurnId: string;
    startedFactDigest: string;
  }

  async function createConversation(
    options: Partial<{
      consumerId: string;
      deploymentId: string;
      workerId: string;
      agentId: string;
      agentVersionId: string;
    }> = {},
  ): Promise<string> {
    const conversationId = randomUuidV7();
    await owner.query(
      `INSERT INTO agent_conversations (
         id, agent_id, deployment_id, agent_version_id, creator_id,
         consumer_subject_id, idempotency_key, request_digest,
         version_digest, state, assigned_worker_id, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, gen_uuid_v7(), $7, $8, 'IDLE', $9, now() + interval '1 hour')`,
      [
        conversationId,
        options.agentId ?? ids.agentId,
        options.deploymentId ?? ids.deploymentId,
        options.agentVersionId ?? ids.agentVersionId,
        ids.creatorId,
        options.consumerId ?? ids.consumerId,
        digest('c'),
        digest('7'),
        options.workerId ?? ids.workerId,
      ],
    );
    return conversationId;
  }

  function encrypted(
    conversationId: string,
    messageId: string,
    role: MessageRole,
    text: string,
    options: { keyId?: string; nonce?: Buffer } = {},
  ) {
    const nonce = options.nonce ?? Buffer.alloc(12, nonceCounter++);
    return encryptMessage({
      plaintext: text,
      encryptionKey,
      digestKey,
      keyId: options.keyId ?? `pg-test:${messageId}`,
      aad: {
        schemaVersion: 1,
        ownerId: ids.creatorId,
        conversationId,
        messageId,
        role,
      },
      nonce,
    });
  }

  function transportEncryptedAssistant(
    conversationId: string,
    invocationId: string,
    text: string,
  ): BrokerSensitiveMessage {
    const keyId = 'pg-test.worker-session.v1';
    const aad: BrokerSensitiveMessage['aad'] = {
      protocol: 'combo.creator-broker/1',
      schemaVersion: 1,
      envelopeType: 'invocation.succeeded',
      messageId: randomUuidV7(),
      conversationId,
      invocationId,
      workerSessionId: randomUuidV7(),
      role: 'ASSISTANT',
      keyId,
    };
    const nonce = Buffer.alloc(12, transportNonceCounter++);
    const cipher = createCipheriv('aes-256-gcm', transportKey, nonce);
    cipher.setAAD(brokerSensitiveMessageAadBytes(aad));
    const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const nonceText = nonce.toString('base64url');
    const ciphertextText = ciphertext.toString('base64url');
    const authTagText = authTag.toString('base64url');
    return {
      algorithm: 'aes-256-gcm/v1',
      keyScope: 'worker-session',
      keyId,
      nonce: nonceText,
      ciphertext: ciphertextText,
      authTag: authTagText,
      cipherDigest: brokerSensitiveMessageCipherDigest(nonceText, ciphertextText, authTagText),
      aad,
      aadDigest: brokerSensitiveMessageAadDigest(aad),
      aadVersion: 1,
    };
  }

  const sealAssistantMessage: AssistantMessageSealer = ({ resultCiphertext, aad }) => {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      transportKey,
      Buffer.from(resultCiphertext.nonce, 'base64url'),
    );
    decipher.setAAD(brokerSensitiveMessageAadBytes(resultCiphertext.aad));
    decipher.setAuthTag(Buffer.from(resultCiphertext.authTag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(resultCiphertext.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const encryptedMessage = encryptMessage({
      plaintext,
      encryptionKey,
      digestKey,
      keyId: `pg-test:${aad.messageId}`,
      aad,
      nonce: Buffer.alloc(12, nonceCounter++),
    });
    return {
      encryptedMessage,
      verifiedResultDigest: domainSeparatedHmacSha256('combo:vnext:result:v1', digestKey, {
        text: plaintext,
      }),
    };
  };

  function acceptInput(
    conversationId: string,
    options: {
      clientMessageId?: string;
      requestDigest?: `hmac-sha256:${string}`;
      keyId?: string;
      nonce?: Buffer;
      turnNo?: number;
      consumerId?: string;
      targetWorkerId?: string;
      agentVersionId?: string;
    } = {},
  ): AcceptInvocationInput {
    const userMessageId = randomUuidV7();
    const turnNo = options.turnNo ?? 1;
    return {
      creatorId: ids.creatorId,
      consumerId: options.consumerId ?? ids.consumerId,
      conversationId,
      agentVersionId: options.agentVersionId ?? ids.agentVersionId,
      agentVersionDigest: digest('7'),
      targetWorkerId: options.targetWorkerId ?? ids.workerId,
      userMessageId,
      invocationId: randomUuidV7(),
      outboxCommandId: randomUuidV7(),
      sourceEventId: randomUuidV7(),
      clientMessageId: options.clientMessageId ?? randomUuidV7(),
      requestDigest: options.requestDigest ?? hmac('8'),
      turnNo,
      deadlineAt: new Date(Date.now() + 120_000),
      encryptedUserMessage: encrypted(
        conversationId,
        userMessageId,
        'USER',
        'consumer secret',
        options,
      ),
    };
  }

  async function assignRunning(
    input: AcceptInvocationInput,
    selectedAssignment?: TestExecutionAssignment,
  ): Promise<StartedExecutionAuthority> {
    const journal = new PostgresCloudJournal(journalPools);
    const authority = await assignDispatchPending(input, selectedAssignment);
    const prepared = preparedInput(input, authority);
    const committedPrepared = await journal.commitPrepared(prepared);
    if (!committedPrepared.startCommandId) throw new Error('expected start command');
    await markStartSent(committedPrepared.startCommandId);
    const started = startedInput(prepared, committedPrepared.startCommandId);
    await journal.commitStarted(started);
    return {
      ...authority,
      runtimeThreadId: started.fact.runtimeThreadId,
      runtimeTurnId: started.fact.runtimeTurnId,
      startedFactDigest: started.factDigest,
    };
  }

  async function assignPersisted(input: AcceptInvocationInput): Promise<void> {
    await owner.query(`UPDATE agent_invocations SET state = 'QUEUED' WHERE id = $1`, [
      input.invocationId,
    ]);
    await owner.query(
      `UPDATE agent_invocations
          SET state = 'DISPATCH_PENDING', assigned_worker_id = $2,
              assignment_lease_id = $3, assignment_fence = 1,
              execution_capability_id = $4
        WHERE id = $1`,
      [input.invocationId, ids.workerId, ids.leaseId, randomUuidV7()],
    );
    await owner.query(`UPDATE agent_invocations SET state = 'PERSISTED' WHERE id = $1`, [
      input.invocationId,
    ]);
  }

  async function assignDispatchPending(
    input: AcceptInvocationInput,
    selectedAssignment: TestExecutionAssignment = {
      deploymentId: ids.deploymentId,
      workerId: ids.workerId,
      leaseId: ids.leaseId,
      fence: '1',
    },
  ): Promise<ExecutionAuthority> {
    const executionCapabilityId = randomUuidV7();
    const executionCapabilityDigest = digest('4');
    const broker = await brokerPool.connect();
    try {
      await broker.query('BEGIN');
      await broker.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await broker.query(`SELECT set_config('app.consumer_id', $1, true)`, [input.consumerId]);
      const queued = await broker.query(
        `UPDATE agent_invocations SET state = 'QUEUED' WHERE id = $1 AND state = 'ACCEPTED'`,
        [input.invocationId],
      );
      expect(queued.rowCount).toBe(1);
      const assigned = await broker.query(
        `UPDATE agent_invocations
            SET state = 'DISPATCH_PENDING', assigned_worker_id = $2,
                assignment_lease_id = $3, assignment_fence = $4,
                execution_capability_id = $5, execution_capability_digest = $6,
                execution_capability_expires_at = deadline_at + interval '30 seconds'
          WHERE id = $1 AND state = 'QUEUED'`,
        [
          input.invocationId,
          selectedAssignment.workerId,
          selectedAssignment.leaseId,
          selectedAssignment.fence,
          executionCapabilityId,
          executionCapabilityDigest,
        ],
      );
      expect(assigned.rowCount).toBe(1);
      const bound = await broker.query(
        `UPDATE broker_outbox
            SET conversation_id = $2, deployment_id = $3,
                assignment_lease_id = $4, assignment_fence = $5,
                execution_capability_id = $6, execution_capability_digest = $7,
                state = 'SENT', attempt_count = 1, next_attempt_at = now()
          WHERE command_id = $1 AND state = 'PENDING'`,
        [
          input.outboxCommandId,
          input.conversationId,
          selectedAssignment.deploymentId,
          selectedAssignment.leaseId,
          selectedAssignment.fence,
          executionCapabilityId,
          executionCapabilityDigest,
        ],
      );
      expect(bound.rowCount).toBe(1);
      await broker.query('COMMIT');
    } catch (error) {
      await broker.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      broker.release();
    }
    return { ...selectedAssignment, executionCapabilityId, executionCapabilityDigest };
  }

  function preparedInput(
    accepted: AcceptInvocationInput,
    authority: ExecutionAuthority,
  ): CommitPreparedInput {
    const fact: WorkerInvocationPreparedFact = {
      protocol: WORKER_INVOCATION_FACT_PROTOCOL,
      schemaVersion: 1,
      type: 'invocation.prepared',
      sourceEventId: accepted.outboxCommandId,
      invocationId: accepted.invocationId,
      agentVersionDigest: digest('7'),
      snapshotDigest: digest('1'),
      executionCapabilityDigest: authority.executionCapabilityDigest,
      leaseId: authority.leaseId,
      fence: authority.fence,
      requestDigest: accepted.requestDigest,
      prepareCommandId: accepted.outboxCommandId,
    };
    return {
      creatorId: ids.creatorId,
      installationId: authority.workerId,
      fact,
      factDigest: workerInvocationFactDigest(fact),
    };
  }

  function startedInput(prepared: CommitPreparedInput, startCommandId: string): CommitStartedInput {
    const fact: WorkerInvocationStartedFact = {
      protocol: WORKER_INVOCATION_FACT_PROTOCOL,
      schemaVersion: 1,
      type: 'invocation.started',
      sourceEventId: startCommandId,
      invocationId: prepared.fact.invocationId,
      agentVersionDigest: prepared.fact.agentVersionDigest,
      snapshotDigest: prepared.fact.snapshotDigest,
      executionCapabilityDigest: prepared.fact.executionCapabilityDigest,
      leaseId: prepared.fact.leaseId,
      fence: prepared.fact.fence,
      startCommandId,
      runtimeThreadId: `thread-${prepared.fact.invocationId}`,
      runtimeTurnId: `turn-${prepared.fact.invocationId}`,
      dispatchReceiptDigest: `sha256:${digest('5')}`,
      sandboxAttestationDigest: `sha256:${digest('6')}`,
    };
    return {
      creatorId: prepared.creatorId,
      installationId: prepared.installationId,
      fact,
      factDigest: workerInvocationFactDigest(fact),
    };
  }

  async function markStartSent(commandId: string): Promise<void> {
    await owner.query(
      `UPDATE broker_outbox
          SET state = 'SENT', attempt_count = 1, next_attempt_at = now()
        WHERE command_id = $1`,
      [commandId],
    );
  }

  function gatewayProjectorTransaction(
    client: PoolClient,
    observedSignals: AbortSignal[] = [],
  ): InvocationProjectorTransaction {
    return {
      async query<R = Record<string, unknown>>(
        sql: string,
        parameters?: readonly unknown[],
        signal?: AbortSignal,
      ): Promise<QueryResult<R>> {
        if (signal) observedSignals.push(signal);
        signal?.throwIfAborted();
        const result = await client.query(sql, parameters as unknown[] | undefined);
        signal?.throwIfAborted();
        return result as unknown as QueryResult<R>;
      },
    };
  }

  async function backdateReconciliation(
    input: AcceptInvocationInput,
    reason: string,
    sourceEventId: string,
  ): Promise<void> {
    await assignPersisted(input);
    const transition = await owner.query<{ reconciliation_started_at: Date }>(
      `UPDATE agent_invocations
          SET state = 'RECONCILING', reconciliation_reason = $2,
              reconciliation_started_at = now() - interval '301 seconds'
        WHERE id = $1
        RETURNING reconciliation_started_at`,
      [input.invocationId, reason],
    );
    await owner.query(
      `INSERT INTO agent_invocation_events (
         invocation_id, creator_id, consumer_subject_id, journal_seq, source,
         source_event_id, event_type, payload, occurred_at
       ) VALUES ($1, $2, $3, 2, 'RECONCILER', $4,
                 'invocation.reconciling', $5::jsonb, $6)`,
      [
        input.invocationId,
        ids.creatorId,
        ids.consumerId,
        sourceEventId,
        JSON.stringify({ state: 'RECONCILING', reason }),
        transition.rows[0]!.reconciliation_started_at,
      ],
    );
  }

  function successInput(
    accepted: AcceptInvocationInput,
    capability: StartedExecutionAuthority,
  ): CommitSuccessInput {
    const resultDigest = domainSeparatedHmacSha256('combo:vnext:result:v1', digestKey, {
      text: 'assistant secret',
    });
    const resultCiphertext = transportEncryptedAssistant(
      accepted.conversationId,
      accepted.invocationId,
      'assistant secret',
    );
    const sourceEventId = accepted.invocationId;
    const fact: WorkerInvocationSucceededFact = {
      protocol: WORKER_INVOCATION_FACT_PROTOCOL,
      schemaVersion: 1,
      type: 'invocation.succeeded',
      sourceEventId,
      invocationId: accepted.invocationId,
      agentVersionDigest: digest('7'),
      snapshotDigest: digest('1'),
      executionCapabilityDigest: capability.executionCapabilityDigest,
      leaseId: capability.leaseId,
      fence: capability.fence,
      runtimeThreadId: capability.runtimeThreadId,
      runtimeTurnId: capability.runtimeTurnId,
      startedFactDigest: capability.startedFactDigest,
      resultDigest,
      localResultCipherDigest: digest('a'),
    };
    return {
      creatorId: ids.creatorId,
      installationId: capability.workerId,
      fact,
      factDigest: workerInvocationFactDigest(fact),
      resultCiphertext,
    };
  }

  async function counts(conversationId: string) {
    const result = await owner.query<{
      messages: string;
      invocations: string;
      events: string;
      commands: string;
      consumer_events: string;
      consumer_streams: string;
      conversation_state: string;
      next_turn_no: number;
    }>(
      `SELECT
         (SELECT count(*) FROM agent_messages WHERE conversation_id = $1)::text AS messages,
         (SELECT count(*) FROM agent_invocations WHERE conversation_id = $1)::text AS invocations,
         (SELECT count(*) FROM agent_invocation_events AS event
            JOIN agent_invocations AS invocation ON invocation.id = event.invocation_id
           WHERE invocation.conversation_id = $1)::text AS events,
         (SELECT count(*) FROM broker_outbox AS command
            JOIN agent_invocations AS invocation ON invocation.id = command.invocation_id
           WHERE invocation.conversation_id = $1)::text AS commands,
         (SELECT count(*) FROM consumer_event_outbox
           WHERE conversation_id = $1)::text AS consumer_events,
         (SELECT count(*) FROM consumer_event_streams
           WHERE conversation_id = $1)::text AS consumer_streams,
         state AS conversation_state, next_turn_no
       FROM agent_conversations WHERE id = $1`,
      [conversationId],
    );
    return result.rows[0]!;
  }

  async function publishAndPruneTerminalEvent(
    journal: PostgresCloudJournal,
    input: {
      conversationId: string;
      cursor: string;
    },
  ): Promise<void> {
    const event = await owner.query<{ payload_digest: string }>(
      `SELECT payload_digest FROM consumer_event_outbox WHERE cursor = $1`,
      [input.cursor],
    );
    expect(event.rows).toHaveLength(1);
    await journal.markConsumerEventPublished({
      creatorId: ids.creatorId,
      consumerId: ids.consumerId,
      conversationId: input.conversationId,
      cursor: input.cursor,
      payloadDigest: event.rows[0]!.payload_digest,
    });
    await owner.query(
      `ALTER TABLE consumer_event_outbox DISABLE TRIGGER consumer_event_outbox_transition`,
    );
    try {
      await owner.query(
        `UPDATE consumer_event_outbox
            SET created_at = now() - interval '8 days',
                retained_until = (now() - interval '8 days') + interval '7 days'
          WHERE cursor = $1`,
        [input.cursor],
      );
    } finally {
      await owner.query(
        `ALTER TABLE consumer_event_outbox ENABLE TRIGGER consumer_event_outbox_transition`,
      );
    }
    await expect(
      journal.pruneExpiredConsumerEvents({
        creatorId: ids.creatorId,
        consumerId: ids.consumerId,
        conversationId: input.conversationId,
      }),
    ).resolves.toMatchObject({ deleted: 1 });
  }

  async function timeWarpCapabilityExpiry(
    invocationId: string,
    expiryInterval: string,
  ): Promise<void> {
    // Production capability deadlines are immutable. Boundary tests alter only
    // disposable PostgreSQL rows so clock_timestamp() can cross the frozen
    // deadline inside one in-flight projector transaction.
    await owner.query(
      `ALTER TABLE agent_invocations DISABLE TRIGGER agent_invocations_capability_authority`,
    );
    try {
      await owner.query(
        `UPDATE agent_invocations
            SET execution_capability_expires_at = clock_timestamp() + $2::interval
          WHERE id = $1`,
        [invocationId, expiryInterval],
      );
    } finally {
      await owner.query(
        `ALTER TABLE agent_invocations ENABLE TRIGGER agent_invocations_capability_authority`,
      );
    }
  }

  beforeAll(async () => {
    await owner.connect();
    const users = await owner.query<{ id: string }>(
      `INSERT INTO users (account) VALUES ($1), ($2) RETURNING id`,
      ['creator-eeeeeeee', 'creator-ffffffff'],
    );
    ids.creatorId = users.rows[0]!.id;
    ids.consumerId = users.rows[1]!.id;

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
        `vnext/${ids.snapshotId}.cipher`,
        `vnext/${ids.snapshotId}.manifest`,
        `kms://${ids.snapshotId}`,
      ],
    );
    await owner.query(
      `INSERT INTO agents (id, creator_id, public_slug, name)
       VALUES ($1, $2, $3, 'Journal Test Agent')`,
      [ids.agentId, ids.creatorId, `journal-${ids.agentId.slice(0, 8)}`],
    );
    await owner.query(
      `INSERT INTO agent_versions (
         id, agent_id, creator_id, ordinal, schema_version, version_digest, snapshot_id,
         behavior_contract, behavior_contract_digest, runtime_policy, runtime_policy_digest,
         io_contract, io_contract_digest, model_policy, model_policy_digest,
         codex_runtime_version, codex_runtime_artifact_digest, codex_protocol_schema_digest
       ) VALUES (
         $1, $2, $3, 1, 1, $4, $5,
         '{}'::jsonb, $6, '{}'::jsonb, $7, '{}'::jsonb, $8, '{}'::jsonb, $9,
         '0.147.0-alpha.6.5', $10, $11
       )`,
      [
        ids.agentVersionId,
        ids.agentId,
        ids.creatorId,
        digest('7'),
        ids.snapshotId,
        digest('a'),
        digest('b'),
        digest('c'),
        digest('d'),
        `sha256:${digest('e')}`,
        `sha256:${digest('f')}`,
      ],
    );
    await owner.query(
      `INSERT INTO agent_version_controls (version_id, creator_id)
       VALUES ($1, $2)`,
      [ids.agentVersionId, ids.creatorId],
    );
    await owner.query(
      `INSERT INTO deployments (id, agent_id, creator_id, environment, desired_version_id)
       VALUES ($1, $2, $3, 'TEST', $4)`,
      [ids.deploymentId, ids.agentId, ids.creatorId, ids.agentVersionId],
    );
    await owner.query(
      `INSERT INTO worker_installations (
         id, creator_id, installation_key_id, device_public_key,
         worker_version, protocol_versions, capabilities
       ) VALUES ($1, $2, $3, $4, '0.1.0', '[1]'::jsonb, '{}'::jsonb)`,
      [ids.workerId, ids.creatorId, `key-${ids.workerId}`, Buffer.alloc(65, 4)],
    );
    await owner.query(
      `INSERT INTO worker_leases (
         id, deployment_id, creator_id, worker_id, connection_id, fence, expires_at
       ) VALUES ($1, $2, $3, $4, $5, 1, now() + interval '10 minutes')`,
      [ids.leaseId, ids.deploymentId, ids.creatorId, ids.workerId, randomUuidV7()],
    );
  });

  afterAll(async () => {
    await Promise.all([owner.end(), apiPool.end(), brokerPool.end(), reconcilerPool.end()]);
  });

  it('commits the five accept facts atomically and replays one exact Invocation', async () => {
    const conversationId = await createConversation();
    const input = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => journal.acceptInvocation(input)),
    );
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(new Set(results.map((result) => result.invocationId))).toEqual(
      new Set([input.invocationId]),
    );
    expect(await counts(conversationId)).toEqual({
      messages: '1',
      invocations: '1',
      events: '1',
      commands: '1',
      consumer_events: '0',
      consumer_streams: '0',
      conversation_state: 'BUSY',
      next_turn_no: 2,
    });

    await expect(
      journal.acceptInvocation({ ...input, requestDigest: hmac('6') }),
    ).rejects.toMatchObject<Partial<CloudJournalError>>({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('limits the real API role to a pure ACCEPTED request, prepare command, and API fact', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await expect(journal.acceptInvocation(accepted)).resolves.toMatchObject({ replayed: false });

    await expect(
      apiPool.query<{
        invocation_table_insert: boolean;
        invocation_state_insert: boolean;
        invocation_capability_insert: boolean;
        outbox_table_insert: boolean;
        outbox_command_type_insert: boolean;
        outbox_capability_insert: boolean;
        event_table_insert: boolean;
        event_source_insert: boolean;
        event_fact_digest_insert: boolean;
        invocation_table_update: boolean;
        invocation_state_update: boolean;
        invocation_cancel_update: boolean;
        invocation_terminal_update: boolean;
        invocation_error_update: boolean;
        message_table_insert: boolean;
        message_role_insert: boolean;
      }>(
        `SELECT
           has_table_privilege(current_user, 'agent_invocations', 'INSERT')
             AS invocation_table_insert,
           has_column_privilege(current_user, 'agent_invocations', 'state', 'INSERT')
             AS invocation_state_insert,
           has_column_privilege(
             current_user,
             'agent_invocations',
             'execution_capability_digest',
             'INSERT'
           ) AS invocation_capability_insert,
           has_table_privilege(current_user, 'broker_outbox', 'INSERT')
             AS outbox_table_insert,
           has_column_privilege(current_user, 'broker_outbox', 'command_type', 'INSERT')
             AS outbox_command_type_insert,
           has_column_privilege(
             current_user,
             'broker_outbox',
             'execution_capability_digest',
             'INSERT'
           ) AS outbox_capability_insert,
           has_table_privilege(current_user, 'agent_invocation_events', 'INSERT')
             AS event_table_insert,
           has_column_privilege(current_user, 'agent_invocation_events', 'source', 'INSERT')
             AS event_source_insert,
           has_column_privilege(
             current_user,
             'agent_invocation_events',
             'source_fact_digest',
             'INSERT'
           ) AS event_fact_digest_insert,
           has_table_privilege(current_user, 'agent_invocations', 'UPDATE')
             AS invocation_table_update,
           has_column_privilege(current_user, 'agent_invocations', 'state', 'UPDATE')
             AS invocation_state_update,
           has_column_privilege(
             current_user,
             'agent_invocations',
             'cancel_requested_at',
             'UPDATE'
           ) AS invocation_cancel_update,
           has_column_privilege(current_user, 'agent_invocations', 'terminal_at', 'UPDATE')
             AS invocation_terminal_update,
           has_column_privilege(current_user, 'agent_invocations', 'error_code', 'UPDATE')
             AS invocation_error_update,
           has_table_privilege(current_user, 'agent_messages', 'INSERT')
             AS message_table_insert,
           has_column_privilege(current_user, 'agent_messages', 'role', 'INSERT')
             AS message_role_insert`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          invocation_table_insert: false,
          invocation_state_insert: true,
          invocation_capability_insert: false,
          outbox_table_insert: false,
          outbox_command_type_insert: true,
          outbox_capability_insert: false,
          event_table_insert: false,
          event_source_insert: true,
          event_fact_digest_insert: false,
          invocation_table_update: false,
          invocation_state_update: false,
          invocation_cancel_update: false,
          invocation_terminal_update: false,
          invocation_error_update: false,
          message_table_insert: false,
          message_role_insert: true,
        },
      ],
    });

    async function expectApiWriteDenied(sql: string, parameters: readonly unknown[]) {
      const api = await apiPool.connect();
      try {
        await api.query('BEGIN');
        await api.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
        await api.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumerId]);
        await expect(api.query(sql, [...parameters])).rejects.toMatchObject({ code: '42501' });
      } finally {
        await api.query('ROLLBACK').catch(() => undefined);
        api.release();
      }
    }

    await expectApiWriteDenied(
      `INSERT INTO agent_invocations (
         id, conversation_id, creator_id, consumer_subject_id, agent_version_id,
         user_message_id, client_message_id, request_digest, state, deadline_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'RUNNING', $9)`,
      [
        randomUuidV7(),
        conversationId,
        ids.creatorId,
        ids.consumerId,
        ids.agentVersionId,
        accepted.userMessageId,
        randomUuidV7(),
        hmac('3'),
        accepted.deadlineAt,
      ],
    );
    await expectApiWriteDenied(
      `INSERT INTO broker_outbox (
         command_id, creator_id, target_worker_id, invocation_id, consumer_subject_id,
         command_type, dedupe_key, state, next_attempt_at, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, 'invocation.start', $6, 'PENDING',
         clock_timestamp(), $7
       )`,
      [
        randomUuidV7(),
        ids.creatorId,
        ids.workerId,
        accepted.invocationId,
        ids.consumerId,
        `invocation:${accepted.invocationId}:forged-start`,
        accepted.deadlineAt,
      ],
    );
    await expectApiWriteDenied(
      `INSERT INTO agent_invocation_events (
         invocation_id, creator_id, consumer_subject_id, journal_seq, source,
         source_event_id, event_type, payload, occurred_at
       ) VALUES (
         $1, $2, $3, 2, 'WORKER', $4, 'invocation.started',
         '{"state":"RUNNING"}'::jsonb, clock_timestamp()
       )`,
      [accepted.invocationId, ids.creatorId, ids.consumerId, randomUuidV7()],
    );
    await expectApiWriteDenied(
      `INSERT INTO agent_invocations (
         id, conversation_id, creator_id, consumer_subject_id, agent_version_id,
         user_message_id, client_message_id, request_digest, state, deadline_at,
         execution_capability_id, execution_capability_digest,
         execution_capability_expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, 'ACCEPTED', $9,
         $10, $11, $9::timestamptz + interval '30 seconds'
       )`,
      [
        randomUuidV7(),
        conversationId,
        ids.creatorId,
        ids.consumerId,
        ids.agentVersionId,
        accepted.userMessageId,
        randomUuidV7(),
        hmac('2'),
        accepted.deadlineAt,
        randomUuidV7(),
        digest('4'),
      ],
    );
    for (const forbiddenState of [
      'STARTING',
      'RUNNING',
      'FAILED',
      'SUCCEEDED',
      'RECONCILING',
      'CANCEL_REQUESTED',
    ]) {
      await expectApiWriteDenied(`UPDATE agent_invocations SET state = $2 WHERE id = $1`, [
        accepted.invocationId,
        forbiddenState,
      ]);
    }
    for (const forbiddenMutation of [
      `UPDATE agent_invocations
          SET cancel_requested_at = clock_timestamp() WHERE id = $1`,
      `UPDATE agent_invocations
          SET terminal_at = clock_timestamp() WHERE id = $1`,
      `UPDATE agent_invocations
          SET error_code = 'FORGED_API_ERROR' WHERE id = $1`,
    ]) {
      await expectApiWriteDenied(forbiddenMutation, [accepted.invocationId]);
    }

    expect(await counts(conversationId)).toEqual({
      messages: '1',
      invocations: '1',
      events: '1',
      commands: '1',
      consumer_events: '0',
      consumer_streams: '0',
      conversation_state: 'BUSY',
      next_turn_no: 2,
    });
    await expect(
      owner.query(
        `SELECT state, cancel_requested_at, terminal_at, error_code
           FROM agent_invocations WHERE id = $1`,
        [accepted.invocationId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: 'ACCEPTED',
          cancel_requested_at: null,
          terminal_at: null,
          error_code: null,
        },
      ],
    });
  });

  it('rejects API ASSISTANT and orphan USER Messages before commit with zero mutation', async () => {
    const conversationId = await createConversation();
    const orphan = acceptInput(conversationId);
    const orphanCipher = orphan.encryptedUserMessage;
    const api = await apiPool.connect();
    try {
      await api.query('BEGIN');
      await api.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await api.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumerId]);
      await expect(
        api.query(
          `INSERT INTO agent_messages (
             id, conversation_id, creator_id, consumer_subject_id, turn_no, role,
             client_message_id, content_algorithm, content_key_id, content_nonce,
             content_ciphertext, content_auth_tag, content_cipher_digest, content_digest,
             content_aad_version, invocation_id
           ) VALUES (
             $1, $2, $3, $4, 1, 'ASSISTANT', NULL,
             $5, $6, $7, $8, $9, $10, $11, $12, $13
           )`,
          [
            randomUuidV7(),
            conversationId,
            ids.creatorId,
            ids.consumerId,
            orphanCipher.algorithm,
            orphanCipher.keyId,
            orphanCipher.nonce,
            orphanCipher.ciphertext,
            orphanCipher.authTag,
            orphanCipher.cipherDigest,
            orphanCipher.contentDigest,
            orphanCipher.aadVersion,
            randomUuidV7(),
          ],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await api.query('ROLLBACK').catch(() => undefined);
      api.release();
    }

    const orphanApi = await apiPool.connect();
    try {
      await orphanApi.query('BEGIN');
      await orphanApi.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await orphanApi.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumerId]);
      await orphanApi.query(
        `INSERT INTO agent_messages (
           id, conversation_id, creator_id, consumer_subject_id, turn_no, role,
           client_message_id, content_algorithm, content_key_id, content_nonce,
           content_ciphertext, content_auth_tag, content_cipher_digest, content_digest,
           content_aad_version, invocation_id
         ) VALUES (
           $1, $2, $3, $4, 1, 'USER', $5,
           $6, $7, $8, $9, $10, $11, $12, $13, $14
         )`,
        [
          orphan.userMessageId,
          conversationId,
          ids.creatorId,
          ids.consumerId,
          orphan.clientMessageId,
          orphanCipher.algorithm,
          orphanCipher.keyId,
          orphanCipher.nonce,
          orphanCipher.ciphertext,
          orphanCipher.authTag,
          orphanCipher.cipherDigest,
          orphanCipher.contentDigest,
          orphanCipher.aadVersion,
          orphan.invocationId,
        ],
      );
      await orphanApi.query(
        `INSERT INTO agent_invocations (
           id, conversation_id, creator_id, consumer_subject_id, agent_version_id,
           user_message_id, client_message_id, request_digest, state, deadline_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACCEPTED', $9)`,
        [
          orphan.invocationId,
          conversationId,
          ids.creatorId,
          ids.consumerId,
          ids.agentVersionId,
          orphan.userMessageId,
          orphan.clientMessageId,
          orphan.requestDigest,
          orphan.deadlineAt,
        ],
      );
      await expect(orphanApi.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
    } finally {
      await orphanApi.query('ROLLBACK').catch(() => undefined);
      orphanApi.release();
    }

    expect(await counts(conversationId)).toEqual({
      messages: '0',
      invocations: '0',
      events: '0',
      commands: '0',
      consumer_events: '0',
      consumer_streams: '0',
      conversation_state: 'IDLE',
      next_turn_no: 1,
    });
  });

  it('installs every cross-tenant SECURITY DEFINER authority under a trusted owner', async () => {
    const authorities = await owner.query<{
      proname: string;
      owner_name: string;
      trusted_owner: boolean;
      security_definer: boolean;
    }>(
      `SELECT procedure.proname, role.rolname AS owner_name,
              role.rolsuper OR role.rolbypassrls AS trusted_owner,
              procedure.prosecdef AS security_definer
         FROM pg_catalog.pg_proc AS procedure
         JOIN pg_catalog.pg_roles AS role ON role.oid = procedure.proowner
        WHERE procedure.oid = ANY(ARRAY[
          'enforce_creator_agent_invocation_capability_authority()'::regprocedure,
          'creator_agent_security_revoke_deployment_capabilities(uuid,uuid)'::regprocedure,
          'creator_agent_cascade_invocation_capability_security_revocation()'::regprocedure,
          'enforce_creator_agent_event_sequence()'::regprocedure
        ])
        ORDER BY procedure.proname`,
    );
    expect(authorities.rows).toHaveLength(4);
    expect(authorities.rows.every((row) => row.security_definer && row.trusted_owner)).toBe(true);
  });

  it('rolls back every accept crash window without partial facts', async () => {
    const steps: CloudJournalStep[] = [
      'USER_MESSAGE',
      'INVOCATION',
      'ACCEPTED_EVENT',
      'BROKER_OUTBOX',
      'CONVERSATION_BUSY',
    ];
    for (const target of steps) {
      const conversationId = await createConversation();
      const input = acceptInput(conversationId);
      const journal = new PostgresCloudJournal(journalPools, (step) => {
        if (step === target) throw new Error(`FAILPOINT:${target}`);
      });
      await expect(journal.acceptInvocation(input)).rejects.toThrow(`FAILPOINT:${target}`);
      expect(await counts(conversationId), target).toEqual({
        messages: '0',
        invocations: '0',
        events: '0',
        commands: '0',
        consumer_events: '0',
        consumer_streams: '0',
        conversation_state: 'IDLE',
        next_turn_no: 1,
      });
    }
  });

  it('uses the Cloud database clock rather than API Date.now for deadline validity', async () => {
    const conversationId = await createConversation();
    const input = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(input.deadlineAt.getTime() + 86_400_000);
    try {
      await expect(journal.acceptInvocation(input)).resolves.toMatchObject({ replayed: false });
    } finally {
      clock.mockRestore();
    }
  });

  it('rejects a caller-selected deadline outside the frozen 120-second budget', async () => {
    const conversationId = await createConversation();
    const input = acceptInput(conversationId);
    input.deadlineAt = new Date(Date.now() + 121_000);
    const journal = new PostgresCloudJournal(journalPools);
    await expect(journal.acceptInvocation(input)).rejects.toMatchObject<Partial<CloudJournalError>>(
      { code: 'CONVERSATION_UNAVAILABLE' },
    );
    expect(await counts(conversationId)).toMatchObject({
      messages: '0',
      invocations: '0',
      conversation_state: 'IDLE',
    });
  });

  it('enforces the execution Capability deadline grace at -1ms, exact, and +1ms', async () => {
    for (const boundary of [
      { offset: '29.999 seconds', allowed: true },
      { offset: '30 seconds', allowed: true },
      { offset: '30.001 seconds', allowed: false },
    ]) {
      const conversationId = await createConversation();
      const accepted = acceptInput(conversationId);
      await new PostgresCloudJournal(journalPools).acceptInvocation(accepted);
      const broker = await brokerPool.connect();
      try {
        await broker.query('BEGIN');
        await broker.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
        await broker.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumerId]);
        await broker.query(
          `UPDATE agent_invocations SET state = 'QUEUED'
            WHERE id = $1 AND state = 'ACCEPTED'`,
          [accepted.invocationId],
        );
        const issued = broker.query(
          `UPDATE agent_invocations
              SET state = 'DISPATCH_PENDING', assigned_worker_id = $2,
                  assignment_lease_id = $3, assignment_fence = 1,
                  execution_capability_id = $4, execution_capability_digest = $5,
                  execution_capability_expires_at = deadline_at + $6::interval
            WHERE id = $1 AND state = 'QUEUED'`,
          [
            accepted.invocationId,
            ids.workerId,
            ids.leaseId,
            randomUuidV7(),
            digest('4'),
            boundary.offset,
          ],
        );
        if (boundary.allowed) {
          await expect(issued, boundary.offset).resolves.toMatchObject({ rowCount: 1 });
          await broker.query('COMMIT');
          await expect(
            owner.query<{ exact_boundary: boolean }>(
              `SELECT execution_capability_expires_at = deadline_at + $2::interval
                        AS exact_boundary
                 FROM agent_invocations WHERE id = $1`,
              [accepted.invocationId, boundary.offset],
            ),
          ).resolves.toMatchObject({ rows: [{ exact_boundary: true }] });
        } else {
          await expect(issued, boundary.offset).rejects.toMatchObject({ code: '23514' });
          await broker.query('ROLLBACK');
          await expect(
            owner.query(
              `SELECT state, execution_capability_id, execution_capability_digest,
                      execution_capability_expires_at
                 FROM agent_invocations WHERE id = $1`,
              [accepted.invocationId],
            ),
          ).resolves.toMatchObject({
            rows: [
              {
                state: 'ACCEPTED',
                execution_capability_id: null,
                execution_capability_digest: null,
                execution_capability_expires_at: null,
              },
            ],
          });
        }
      } finally {
        await broker.query('ROLLBACK').catch(() => undefined);
        broker.release();
      }
    }
  });

  it('fails capability issuance closed when Version control is missing, revoked, or SECURITY', async () => {
    for (const controlMutation of [
      `DELETE FROM agent_version_controls WHERE version_id = $1 AND creator_id = $2`,
      `UPDATE agent_version_controls
          SET availability = 'REVOKED', reason_code = 'PG_NEGATIVE'
        WHERE version_id = $1 AND creator_id = $2`,
      `UPDATE agent_version_controls
          SET severity = 'SECURITY', reason_code = 'PG_NEGATIVE'
        WHERE version_id = $1 AND creator_id = $2`,
    ]) {
      const conversationId = await createConversation();
      const accepted = acceptInput(conversationId);
      await new PostgresCloudJournal(journalPools).acceptInvocation(accepted);
      await owner.query(`UPDATE agent_invocations SET state = 'QUEUED' WHERE id = $1`, [
        accepted.invocationId,
      ]);

      await owner.query('BEGIN');
      try {
        await owner.query(controlMutation, [ids.agentVersionId, ids.creatorId]);
        await expect(
          owner.query(
            `UPDATE agent_invocations
                SET state = 'DISPATCH_PENDING', assigned_worker_id = $2,
                    assignment_lease_id = $3, assignment_fence = 1,
                    execution_capability_id = $4, execution_capability_digest = $5,
                    execution_capability_expires_at = deadline_at + interval '30 seconds'
              WHERE id = $1 AND state = 'QUEUED'`,
            [accepted.invocationId, ids.workerId, ids.leaseId, randomUuidV7(), digest('4')],
          ),
        ).rejects.toMatchObject({ code: '55000' });
      } finally {
        await owner.query('ROLLBACK').catch(() => undefined);
      }

      await expect(
        owner.query(
          `SELECT state, execution_capability_id, execution_capability_digest
             FROM agent_invocations WHERE id = $1`,
          [accepted.invocationId],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            state: 'QUEUED',
            execution_capability_id: null,
            execution_capability_digest: null,
          },
        ],
      });
    }
  });

  it('commits exact prepared/start facts and their command projections with exact replay', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignDispatchPending(accepted);
    const prepared = preparedInput(accepted, authority);

    const committedPrepared = await journal.commitPrepared(prepared);
    expect(committedPrepared).toMatchObject({
      invocationId: accepted.invocationId,
      state: 'PERSISTED',
      prepareCommandId: accepted.outboxCommandId,
      startCommandId: expect.any(String),
      factDigest: prepared.factDigest,
      replayed: false,
    });
    const startCommandId = committedPrepared.startCommandId;
    if (!startCommandId) throw new Error('expected start command');
    await expect(journal.commitPrepared(prepared)).resolves.toEqual({
      ...committedPrepared,
      replayed: true,
    });

    await markStartSent(startCommandId);
    const started = startedInput(prepared, startCommandId);
    const committedStarted = await journal.commitStarted(started);
    expect(committedStarted).toMatchObject({
      invocationId: accepted.invocationId,
      state: 'RUNNING',
      startCommandId,
      factDigest: started.factDigest,
      replayed: false,
    });
    await expect(journal.commitStarted(started)).resolves.toEqual({
      ...committedStarted,
      replayed: true,
    });

    const state = await owner.query<{
      state: string;
      started_at: Date;
      runtime_thread_id: string;
      runtime_turn_id: string;
      lifecycle_events: string;
      fact_digests: string[];
      source_event_ids: string[];
      command_ids: string[];
      command_states: string[];
      predecessor_command_id: string;
      command_id_comment: string;
    }>(
      `SELECT invocation.state, invocation.started_at,
              invocation.runtime_thread_id, invocation.runtime_turn_id,
              (SELECT count(*) FROM agent_invocation_events
                WHERE invocation_id = invocation.id
                  AND source = 'WORKER'
                  AND event_type IN ('invocation.persisted', 'invocation.started'))::text
                AS lifecycle_events,
              (SELECT array_agg(source_fact_digest ORDER BY journal_seq)
                 FROM agent_invocation_events
                WHERE invocation_id = invocation.id AND source = 'WORKER') AS fact_digests,
              (SELECT array_agg(source_event_id ORDER BY journal_seq)
                 FROM agent_invocation_events
                WHERE invocation_id = invocation.id AND source = 'WORKER') AS source_event_ids,
              (SELECT array_agg(command_id::text ORDER BY command_type)
                 FROM broker_outbox
                WHERE invocation_id = invocation.id) AS command_ids,
              (SELECT array_agg(state ORDER BY command_type)
                 FROM broker_outbox
                WHERE invocation_id = invocation.id) AS command_states,
              (SELECT predecessor_command_id::text
                 FROM broker_outbox
                WHERE invocation_id = invocation.id AND command_type = 'invocation.start')
                AS predecessor_command_id,
              col_description(
                'broker_outbox'::regclass,
                (SELECT attnum FROM pg_attribute
                  WHERE attrelid = 'broker_outbox'::regclass AND attname = 'command_id')
              ) AS command_id_comment
         FROM agent_invocations AS invocation
        WHERE invocation.id = $1`,
      [accepted.invocationId],
    );
    expect(state.rows[0]).toMatchObject({
      state: 'RUNNING',
      runtime_thread_id: started.fact.runtimeThreadId,
      runtime_turn_id: started.fact.runtimeTurnId,
      lifecycle_events: '2',
      fact_digests: [prepared.factDigest, started.factDigest],
      source_event_ids: [accepted.outboxCommandId, startCommandId],
      command_ids: [accepted.outboxCommandId, startCommandId],
      command_states: ['ACKED', 'ACKED'],
      predecessor_command_id: accepted.outboxCommandId,
      command_id_comment:
        'Stable Broker envelope.messageId; every cross-connection retry MUST reuse this exact UUID.',
    });
    expect(state.rows[0]!.started_at.toISOString()).toBe(committedStarted.startedAt);
  });

  it('rechecks prepared authority at the final start write and reconciles an in-flight expiry', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const admission = new PostgresCloudJournal(journalPools);
    await admission.acceptInvocation(accepted);
    const authority = await assignDispatchPending(accepted);
    const prepared = preparedInput(accepted, authority);
    await timeWarpCapabilityExpiry(accepted.invocationId, '1 second');

    let delayedAfterAck = false;
    const journal = new PostgresCloudJournal(journalPools, async (step) => {
      if (step === 'PREPARE_COMMAND_ACK') {
        delayedAfterAck = true;
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
    });
    const committed = await journal.commitPrepared(prepared);
    expect(delayedAfterAck).toBe(true);
    expect(committed).toEqual({
      invocationId: accepted.invocationId,
      state: 'RECONCILING',
      prepareCommandId: accepted.outboxCommandId,
      startCommandId: null,
      factDigest: prepared.factDigest,
      replayed: false,
    });
    expect(await counts(conversationId)).toMatchObject({
      messages: '1',
      invocations: '1',
      events: '3',
      commands: '1',
      conversation_state: 'BUSY',
    });
    await expect(
      owner.query(
        `SELECT invocation.state, invocation.reconciliation_reason,
                  command.state AS prepare_state,
                  (SELECT count(*) FROM broker_outbox
                    WHERE invocation_id = invocation.id
                      AND command_type = 'invocation.start')::text AS start_commands,
                  (SELECT source_fact_digest FROM agent_invocation_events
                    WHERE invocation_id = invocation.id
                      AND event_type = 'invocation.persisted') AS prepared_fact_digest
             FROM agent_invocations AS invocation
             JOIN broker_outbox AS command
               ON command.invocation_id = invocation.id
              AND command.command_type = 'invocation.prepare'
            WHERE invocation.id = $1`,
        [accepted.invocationId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: 'RECONCILING',
          reconciliation_reason: 'START_DISPATCH_UNKNOWN',
          prepare_state: 'ACKED',
          start_commands: '0',
          prepared_fact_digest: prepared.factDigest,
        },
      ],
    });
  }, 10_000);

  it('rechecks started authority after STARTING and preserves the fact as CANCEL_NOT_CONFIRMED', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const admission = new PostgresCloudJournal(journalPools);
    await admission.acceptInvocation(accepted);
    const authority = await assignDispatchPending(accepted);
    const prepared = preparedInput(accepted, authority);
    const committedPrepared = await admission.commitPrepared(prepared);
    if (!committedPrepared.startCommandId) throw new Error('expected start command');
    await markStartSent(committedPrepared.startCommandId);
    const started = startedInput(prepared, committedPrepared.startCommandId);
    await timeWarpCapabilityExpiry(accepted.invocationId, '1 second');

    let delayedAfterStarting = false;
    const journal = new PostgresCloudJournal(journalPools, async (step) => {
      if (step === 'INVOCATION_STARTING') {
        delayedAfterStarting = true;
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
    });
    await expect(journal.commitStarted(started)).resolves.toMatchObject({
      invocationId: accepted.invocationId,
      state: 'RECONCILING',
      startCommandId: committedPrepared.startCommandId,
      factDigest: started.factDigest,
      replayed: false,
    });
    expect(delayedAfterStarting).toBe(true);
    expect(await counts(conversationId)).toMatchObject({
      messages: '1',
      invocations: '1',
      events: '3',
      commands: '2',
      conversation_state: 'BUSY',
    });
    await expect(
      owner.query(
        `SELECT invocation.state, invocation.reconciliation_reason,
                  invocation.runtime_thread_id, invocation.runtime_turn_id,
                  command.state AS start_state,
                  event.payload, event.source_fact_digest
             FROM agent_invocations AS invocation
             JOIN broker_outbox AS command
               ON command.invocation_id = invocation.id
              AND command.command_type = 'invocation.start'
             JOIN agent_invocation_events AS event
               ON event.invocation_id = invocation.id
              AND event.event_type = 'invocation.started'
            WHERE invocation.id = $1`,
        [accepted.invocationId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: 'RECONCILING',
          reconciliation_reason: 'CANCEL_NOT_CONFIRMED',
          runtime_thread_id: started.fact.runtimeThreadId,
          runtime_turn_id: started.fact.runtimeTurnId,
          start_state: 'ACKED',
          payload: { state: 'RECONCILING' },
          source_fact_digest: started.factDigest,
        },
      ],
    });
  }, 10_000);

  it('fails closed on fact, command, fence, capability, and source-event conflicts', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignDispatchPending(accepted);
    const prepared = preparedInput(accepted, authority);

    await expect(
      journal.commitPrepared({ ...prepared, factDigest: digest('0') }),
    ).rejects.toMatchObject<Partial<CloudJournalError>>({ code: 'WORKER_FACT_CONFLICT' });

    const wrongFenceFact: WorkerInvocationPreparedFact = { ...prepared.fact, fence: '2' };
    await expect(
      journal.commitPrepared({
        ...prepared,
        fact: wrongFenceFact,
        factDigest: workerInvocationFactDigest(wrongFenceFact),
      }),
    ).rejects.toMatchObject<Partial<CloudJournalError>>({
      code: 'EXECUTION_AUTHORITY_MISMATCH',
    });

    const wrongCommandId = randomUuidV7();
    const wrongCommandFact: WorkerInvocationPreparedFact = {
      ...prepared.fact,
      sourceEventId: wrongCommandId,
      prepareCommandId: wrongCommandId,
    };
    await expect(
      journal.commitPrepared({
        ...prepared,
        fact: wrongCommandFact,
        factDigest: workerInvocationFactDigest(wrongCommandFact),
      }),
    ).rejects.toMatchObject<Partial<CloudJournalError>>({
      code: 'EXECUTION_AUTHORITY_MISMATCH',
    });

    const committedPrepared = await journal.commitPrepared(prepared);
    const conflictingSourceFact: WorkerInvocationPreparedFact = {
      ...prepared.fact,
      requestDigest: hmac('7'),
    };
    await expect(
      journal.commitPrepared({
        ...prepared,
        fact: conflictingSourceFact,
        factDigest: workerInvocationFactDigest(conflictingSourceFact),
      }),
    ).rejects.toMatchObject<Partial<CloudJournalError>>({ code: 'WORKER_FACT_CONFLICT' });

    if (!committedPrepared.startCommandId) throw new Error('expected start command');
    await markStartSent(committedPrepared.startCommandId);
    const started = startedInput(prepared, committedPrepared.startCommandId);
    const wrongCapabilityFact: WorkerInvocationStartedFact = {
      ...started.fact,
      executionCapabilityDigest: digest('a'),
    };
    await expect(
      journal.commitStarted({
        ...started,
        fact: wrongCapabilityFact,
        factDigest: workerInvocationFactDigest(wrongCapabilityFact),
      }),
    ).rejects.toMatchObject<Partial<CloudJournalError>>({
      code: 'EXECUTION_AUTHORITY_MISMATCH',
    });
    expect(
      await owner.query(`SELECT state FROM agent_invocations WHERE id = $1`, [
        accepted.invocationId,
      ]),
    ).toMatchObject({ rows: [{ state: 'PERSISTED' }] });
  });

  it('lets the real Broker role fill exact legacy prepare authority and denies RLS/stale mutation', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignDispatchPending(accepted);

    await expect(
      brokerPool.query<{ current_user: string }>(`SELECT current_user`),
    ).resolves.toMatchObject({ rows: [{ current_user: 'combo_agent_broker' }] });

    const rls = await brokerPool.connect();
    try {
      await rls.query('BEGIN');
      await rls.query(`SELECT set_config('app.creator_id', $1, true)`, [randomUuidV7()]);
      await rls.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumerId]);
      const wrongCreator = await rls.query(
        `UPDATE broker_outbox SET state = state WHERE command_id = $1`,
        [accepted.outboxCommandId],
      );
      expect(wrongCreator.rowCount).toBe(0);
      await rls.query('ROLLBACK');

      await rls.query('BEGIN');
      await rls.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await rls.query(`SELECT set_config('app.consumer_id', $1, true)`, [randomUuidV7()]);
      const wrongConsumer = await rls.query(
        `UPDATE agent_invocations SET state = state WHERE id = $1`,
        [accepted.invocationId],
      );
      expect(wrongConsumer.rowCount).toBe(0);
      await rls.query('ROLLBACK');
    } finally {
      await rls.query('ROLLBACK').catch(() => undefined);
      rls.release();
    }

    for (const [column, value] of [
      ['assignment_lease_id', randomUuidV7()],
      ['execution_capability_digest', digest('9')],
    ] as const) {
      const stale = await brokerPool.connect();
      try {
        await stale.query('BEGIN');
        await stale.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
        await stale.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumerId]);
        await expect(
          stale.query(`UPDATE broker_outbox SET ${column} = $2 WHERE command_id = $1`, [
            accepted.outboxCommandId,
            value,
          ]),
        ).rejects.toMatchObject({ code: '55000' });
      } finally {
        await stale.query('ROLLBACK').catch(() => undefined);
        stale.release();
      }
    }

    await expect(
      owner.query(
        `SELECT assignment_lease_id::text, execution_capability_digest
           FROM broker_outbox WHERE command_id = $1`,
        [accepted.outboxCommandId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          assignment_lease_id: ids.leaseId,
          execution_capability_digest: authority.executionCapabilityDigest,
        },
      ],
    });
  });

  it('rolls back every prepared/started projection crash window', async () => {
    for (const target of [
      'INVOCATION_PERSISTED',
      'PREPARED_EVENT',
      'PREPARE_COMMAND_ACK',
      'START_COMMAND',
    ] satisfies CloudJournalStep[]) {
      const conversationId = await createConversation();
      const accepted = acceptInput(conversationId);
      await new PostgresCloudJournal(journalPools).acceptInvocation(accepted);
      const authority = await assignDispatchPending(accepted);
      const prepared = preparedInput(accepted, authority);
      const journal = new PostgresCloudJournal(journalPools, (step) => {
        if (step === target) throw new Error(`FAILPOINT:${target}`);
      });
      await expect(journal.commitPrepared(prepared)).rejects.toThrow(`FAILPOINT:${target}`);
      const state = await owner.query<{
        state: string;
        worker_events: string;
        prepare_state: string;
        start_commands: string;
      }>(
        `SELECT invocation.state,
                (SELECT count(*) FROM agent_invocation_events
                  WHERE invocation_id = invocation.id AND source = 'WORKER')::text AS worker_events,
                (SELECT state FROM broker_outbox
                  WHERE invocation_id = invocation.id AND command_type = 'invocation.prepare')
                  AS prepare_state,
                (SELECT count(*) FROM broker_outbox
                  WHERE invocation_id = invocation.id AND command_type = 'invocation.start')::text
                  AS start_commands
           FROM agent_invocations AS invocation WHERE invocation.id = $1`,
        [accepted.invocationId],
      );
      expect(state.rows[0], target).toEqual({
        state: 'DISPATCH_PENDING',
        worker_events: '0',
        prepare_state: 'SENT',
        start_commands: '0',
      });
    }

    for (const target of [
      'INVOCATION_STARTING',
      'INVOCATION_RUNNING',
      'STARTED_EVENT',
      'START_COMMAND_ACK',
    ] satisfies CloudJournalStep[]) {
      const conversationId = await createConversation();
      const accepted = acceptInput(conversationId);
      const setupJournal = new PostgresCloudJournal(journalPools);
      await setupJournal.acceptInvocation(accepted);
      const authority = await assignDispatchPending(accepted);
      const prepared = preparedInput(accepted, authority);
      const committedPrepared = await setupJournal.commitPrepared(prepared);
      if (!committedPrepared.startCommandId) throw new Error('expected start command');
      await markStartSent(committedPrepared.startCommandId);
      const started = startedInput(prepared, committedPrepared.startCommandId);
      const journal = new PostgresCloudJournal(journalPools, (step) => {
        if (step === target) throw new Error(`FAILPOINT:${target}`);
      });
      await expect(journal.commitStarted(started)).rejects.toThrow(`FAILPOINT:${target}`);
      const state = await owner.query<{
        state: string;
        started_at: Date | null;
        runtime_thread_id: string | null;
        runtime_turn_id: string | null;
        started_events: string;
        start_state: string;
      }>(
        `SELECT invocation.state, invocation.started_at,
                invocation.runtime_thread_id, invocation.runtime_turn_id,
                (SELECT count(*) FROM agent_invocation_events
                  WHERE invocation_id = invocation.id
                    AND event_type = 'invocation.started')::text AS started_events,
                (SELECT state FROM broker_outbox
                  WHERE invocation_id = invocation.id AND command_type = 'invocation.start')
                  AS start_state
           FROM agent_invocations AS invocation WHERE invocation.id = $1`,
        [accepted.invocationId],
      );
      expect(state.rows[0], target).toEqual({
        state: 'PERSISTED',
        started_at: null,
        runtime_thread_id: null,
        runtime_turn_id: null,
        started_events: '0',
        start_state: 'SENT',
      });
    }

    for (const target of [
      'INVOCATION_RECONCILING',
      'RECONCILING_EVENT',
    ] satisfies CloudJournalStep[]) {
      const conversationId = await createConversation();
      const accepted = acceptInput(conversationId);
      await new PostgresCloudJournal(journalPools).acceptInvocation(accepted);
      const authority = await assignDispatchPending(accepted);
      const prepared = preparedInput(accepted, authority);
      await owner.query(
        `UPDATE agent_invocations
            SET execution_capability_revoked_at = now()
          WHERE id = $1`,
        [accepted.invocationId],
      );
      const journal = new PostgresCloudJournal(journalPools, (step) => {
        if (step === target) throw new Error(`FAILPOINT:${target}`);
      });
      await expect(journal.commitPrepared(prepared)).rejects.toThrow(`FAILPOINT:${target}`);
      const state = await owner.query<{
        state: string;
        worker_events: string;
        reconciliation_events: string;
        prepare_state: string;
        start_commands: string;
      }>(
        `SELECT invocation.state,
                (SELECT count(*) FROM agent_invocation_events
                  WHERE invocation_id = invocation.id AND source = 'WORKER')::text
                  AS worker_events,
                (SELECT count(*) FROM agent_invocation_events
                  WHERE invocation_id = invocation.id
                    AND event_type = 'invocation.reconciling')::text AS reconciliation_events,
                (SELECT state FROM broker_outbox
                  WHERE invocation_id = invocation.id AND command_type = 'invocation.prepare')
                  AS prepare_state,
                (SELECT count(*) FROM broker_outbox
                  WHERE invocation_id = invocation.id AND command_type = 'invocation.start')::text
                  AS start_commands
           FROM agent_invocations AS invocation WHERE invocation.id = $1`,
        [accepted.invocationId],
      );
      expect(state.rows[0], target).toEqual({
        state: 'DISPATCH_PENDING',
        worker_events: '0',
        reconciliation_events: '0',
        prepare_state: 'SENT',
        start_commands: '0',
      });
    }
  });

  it('projects prepared, started, and success inside one caller transaction', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignDispatchPending(accepted);
    const prepared = preparedInput(accepted, authority);
    const signal = new AbortController().signal;
    const observedSignals: AbortSignal[] = [];
    const broker = await brokerPool.connect();
    try {
      await broker.query('BEGIN');
      await broker.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      const transaction = gatewayProjectorTransaction(broker, observedSignals);
      const committedPrepared = await journal.projectPrepared(transaction, prepared, signal);
      if (!committedPrepared.startCommandId) throw new Error('expected start command');
      await broker.query(
        `UPDATE broker_outbox
            SET state = 'SENT', attempt_count = 1, next_attempt_at = now()
          WHERE command_id = $1`,
        [committedPrepared.startCommandId],
      );
      const started = startedInput(prepared, committedPrepared.startCommandId);
      await expect(journal.projectStarted(transaction, started, signal)).resolves.toMatchObject({
        state: 'RUNNING',
        replayed: false,
      });
      const success = successInput(accepted, {
        ...authority,
        runtimeThreadId: started.fact.runtimeThreadId,
        runtimeTurnId: started.fact.runtimeTurnId,
        startedFactDigest: started.factDigest,
      });
      await expect(
        journal.projectSuccess(transaction, success, sealAssistantMessage, signal),
      ).resolves.toMatchObject({ replayed: false });
      expect(observedSignals.length).toBeGreaterThan(20);
      expect(observedSignals.every((observed) => observed === signal)).toBe(true);
    } finally {
      await broker.query('ROLLBACK').catch(() => undefined);
      broker.release();
    }

    expect(await counts(conversationId)).toMatchObject({
      messages: '1',
      invocations: '1',
      events: '1',
      commands: '1',
      consumer_events: '0',
      consumer_streams: '0',
      conversation_state: 'BUSY',
    });
    await expect(
      owner.query(`SELECT state FROM agent_invocations WHERE id = $1`, [accepted.invocationId]),
    ).resolves.toMatchObject({ rows: [{ state: 'DISPATCH_PENDING' }] });
  });

  it('honors a caller AbortSignal before lock and after a partial prepared projection', async () => {
    const preLockConversationId = await createConversation();
    const preLockAccepted = acceptInput(preLockConversationId);
    await new PostgresCloudJournal(journalPools).acceptInvocation(preLockAccepted);
    const preLockAuthority = await assignDispatchPending(preLockAccepted);
    const preLockPrepared = preparedInput(preLockAccepted, preLockAuthority);
    const preAborted = new AbortController();
    preAborted.abort(new Error('gateway disconnected before projector lock'));
    const preLockBroker = await brokerPool.connect();
    try {
      await preLockBroker.query('BEGIN');
      await preLockBroker.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await expect(
        new PostgresCloudJournal(journalPools).projectPrepared(
          gatewayProjectorTransaction(preLockBroker),
          preLockPrepared,
          preAborted.signal,
        ),
      ).rejects.toThrow('gateway disconnected before projector lock');
    } finally {
      await preLockBroker.query('ROLLBACK').catch(() => undefined);
      preLockBroker.release();
    }
    expect(await counts(preLockConversationId)).toMatchObject({
      messages: '1',
      events: '1',
      commands: '1',
      conversation_state: 'BUSY',
    });

    const partialConversationId = await createConversation();
    const partialAccepted = acceptInput(partialConversationId);
    await new PostgresCloudJournal(journalPools).acceptInvocation(partialAccepted);
    const partialAuthority = await assignDispatchPending(partialAccepted);
    const partialPrepared = preparedInput(partialAccepted, partialAuthority);
    let enterBarrier!: () => void;
    let releaseBarrier!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterBarrier = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const controller = new AbortController();
    const partialJournal = new PostgresCloudJournal(journalPools, async (step) => {
      if (step === 'INVOCATION_PERSISTED') {
        enterBarrier();
        await released;
      }
    });
    const partialBroker = await brokerPool.connect();
    try {
      await partialBroker.query('BEGIN');
      await partialBroker.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      const projected = partialJournal.projectPrepared(
        gatewayProjectorTransaction(partialBroker),
        partialPrepared,
        controller.signal,
      );
      await entered;
      controller.abort(new Error('gateway disconnected during prepared projection'));
      releaseBarrier();
      await expect(projected).rejects.toThrow('gateway disconnected during prepared projection');
    } finally {
      releaseBarrier();
      await partialBroker.query('ROLLBACK').catch(() => undefined);
      partialBroker.release();
    }
    expect(await counts(partialConversationId)).toMatchObject({
      messages: '1',
      events: '1',
      commands: '1',
      conversation_state: 'BUSY',
    });
    await expect(
      owner.query(`SELECT state FROM agent_invocations WHERE id = $1`, [
        partialAccepted.invocationId,
      ]),
    ).resolves.toMatchObject({ rows: [{ state: 'DISPATCH_PENDING' }] });
  });

  it('aborts a blocked terminal sealer and leaves zero terminal projection', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignRunning(accepted);
    const success = successInput(accepted, authority);
    let enterSealer!: () => void;
    let releaseSealer!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterSealer = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseSealer = resolve;
    });
    const controller = new AbortController();
    const blockedSealer: AssistantMessageSealer = async (input) => {
      expect(input.signal).toBe(controller.signal);
      enterSealer();
      await released;
      return sealAssistantMessage(input);
    };
    const broker = await brokerPool.connect();
    try {
      await broker.query('BEGIN');
      await broker.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      const projected = journal.projectSuccess(
        gatewayProjectorTransaction(broker),
        success,
        blockedSealer,
        controller.signal,
      );
      await entered;
      controller.abort(new Error('gateway authority timeout'));
      releaseSealer();
      await expect(projected).rejects.toThrow('gateway authority timeout');
    } finally {
      releaseSealer();
      await broker.query('ROLLBACK').catch(() => undefined);
      broker.release();
    }

    expect(await counts(conversationId)).toMatchObject({
      messages: '1',
      events: '3',
      consumer_events: '0',
      consumer_streams: '0',
      conversation_state: 'BUSY',
    });
    await expect(
      owner.query(`SELECT state, result_message_id FROM agent_invocations WHERE id = $1`, [
        accepted.invocationId,
      ]),
    ).resolves.toMatchObject({ rows: [{ state: 'RUNNING', result_message_id: null }] });
  });

  it('durably records a late prepared fact and reconciles without creating start authority', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignDispatchPending(accepted);
    const prepared = preparedInput(accepted, authority);
    await owner.query(
      `UPDATE agent_invocations SET execution_capability_revoked_at = now() WHERE id = $1`,
      [accepted.invocationId],
    );

    const committed = await journal.commitPrepared(prepared);
    expect(committed).toEqual({
      invocationId: accepted.invocationId,
      state: 'RECONCILING',
      prepareCommandId: accepted.outboxCommandId,
      startCommandId: null,
      factDigest: prepared.factDigest,
      replayed: false,
    });
    await expect(journal.commitPrepared(prepared)).resolves.toEqual({
      ...committed,
      replayed: true,
    });

    const conflictingFact: WorkerInvocationPreparedFact = {
      ...prepared.fact,
      requestDigest: hmac('7'),
    };
    await expect(
      journal.commitPrepared({
        ...prepared,
        fact: conflictingFact,
        factDigest: workerInvocationFactDigest(conflictingFact),
      }),
    ).rejects.toMatchObject<Partial<CloudJournalError>>({ code: 'WORKER_FACT_CONFLICT' });

    const state = await owner.query<{
      state: string;
      reason: string;
      worker_events: string;
      reconciliation_events: string;
      prepare_state: string;
      start_commands: string;
    }>(
      `SELECT state, reconciliation_reason AS reason,
              (SELECT count(*) FROM agent_invocation_events
                WHERE invocation_id = agent_invocations.id AND source = 'WORKER')::text
                AS worker_events,
              (SELECT count(*) FROM agent_invocation_events
                WHERE invocation_id = agent_invocations.id
                  AND source = 'RECONCILER'
                  AND event_type = 'invocation.reconciling')::text AS reconciliation_events,
              (SELECT state FROM broker_outbox
                WHERE invocation_id = agent_invocations.id
                  AND command_type = 'invocation.prepare') AS prepare_state,
              (SELECT count(*) FROM broker_outbox
                WHERE invocation_id = agent_invocations.id
                  AND command_type = 'invocation.start')::text AS start_commands
         FROM agent_invocations WHERE id = $1`,
      [accepted.invocationId],
    );
    expect(state.rows[0]).toEqual({
      state: 'RECONCILING',
      reason: 'START_DISPATCH_UNKNOWN',
      worker_events: '1',
      reconciliation_events: '1',
      prepare_state: 'ACKED',
      start_commands: '0',
    });
  });

  it('records a naturally late started fact after command expiry and converges to RUNNING', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignDispatchPending(accepted);
    const prepared = preparedInput(accepted, authority);
    const committedPrepared = await journal.commitPrepared(prepared);
    if (!committedPrepared.startCommandId) throw new Error('expected start command');
    await markStartSent(committedPrepared.startCommandId);
    await owner.query(`UPDATE broker_outbox SET state = 'EXPIRED' WHERE command_id = $1`, [
      committedPrepared.startCommandId,
    ]);
    const started = startedInput(prepared, committedPrepared.startCommandId);

    const committed = await journal.commitStarted(started);
    expect(committed).toMatchObject({
      invocationId: accepted.invocationId,
      state: 'RUNNING',
      startCommandId: committedPrepared.startCommandId,
      factDigest: started.factDigest,
      replayed: false,
    });
    await expect(journal.commitStarted(started)).resolves.toEqual({
      ...committed,
      replayed: true,
    });

    const state = await owner.query<{
      state: string;
      started_events: string;
      start_commands: string;
      start_state: string;
    }>(
      `SELECT invocation.state,
              (SELECT count(*) FROM agent_invocation_events
                WHERE invocation_id = invocation.id
                  AND source = 'WORKER'
                  AND event_type = 'invocation.started')::text AS started_events,
              (SELECT count(*) FROM broker_outbox
                WHERE invocation_id = invocation.id
                  AND command_type = 'invocation.start')::text AS start_commands,
              (SELECT state FROM broker_outbox
                WHERE invocation_id = invocation.id
                  AND command_type = 'invocation.start') AS start_state
         FROM agent_invocations AS invocation WHERE invocation.id = $1`,
      [accepted.invocationId],
    );
    expect(state.rows[0]).toEqual({
      state: 'RUNNING',
      started_events: '1',
      start_commands: '1',
      start_state: 'EXPIRED',
    });
  });

  it('records a security-revoked started fact but keeps the Invocation in reconciliation', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignDispatchPending(accepted);
    const prepared = preparedInput(accepted, authority);
    const committedPrepared = await journal.commitPrepared(prepared);
    if (!committedPrepared.startCommandId) throw new Error('expected start command');
    await markStartSent(committedPrepared.startCommandId);
    await owner.query(`UPDATE broker_outbox SET state = 'EXPIRED' WHERE command_id = $1`, [
      committedPrepared.startCommandId,
    ]);
    await owner.query(
      `UPDATE agent_invocations
          SET execution_capability_revoked_at = now()
        WHERE id = $1`,
      [accepted.invocationId],
    );
    const started = startedInput(prepared, committedPrepared.startCommandId);

    const committed = await journal.commitStarted(started);
    expect(committed).toMatchObject({
      invocationId: accepted.invocationId,
      state: 'RECONCILING',
      startCommandId: committedPrepared.startCommandId,
      factDigest: started.factDigest,
      replayed: false,
    });
    await expect(journal.commitStarted(started)).resolves.toEqual({
      ...committed,
      replayed: true,
    });

    const success = successInput(accepted, {
      ...authority,
      runtimeThreadId: started.fact.runtimeThreadId,
      runtimeTurnId: started.fact.runtimeTurnId,
      startedFactDigest: started.factDigest,
    });
    await expect(journal.commitSuccess(success, sealAssistantMessage)).rejects.toMatchObject<
      Partial<CloudJournalError>
    >({ code: 'EXECUTION_AUTHORITY_MISMATCH' });

    const state = await owner.query<{
      state: string;
      reconciliation_reason: string;
      started_events: string;
      started_payload_state: string;
      succeeded_events: string;
      messages: string;
      start_state: string;
    }>(
      `SELECT invocation.state, invocation.reconciliation_reason,
              (SELECT count(*) FROM agent_invocation_events
                WHERE invocation_id = invocation.id
                  AND source = 'WORKER'
                  AND event_type = 'invocation.started')::text AS started_events,
              (SELECT payload->>'state' FROM agent_invocation_events
                WHERE invocation_id = invocation.id
                  AND source = 'WORKER'
                  AND event_type = 'invocation.started') AS started_payload_state,
              (SELECT count(*) FROM agent_invocation_events
                WHERE invocation_id = invocation.id
                  AND event_type = 'invocation.succeeded')::text AS succeeded_events,
              (SELECT count(*) FROM agent_messages
                WHERE invocation_id = invocation.id)::text AS messages,
              (SELECT state FROM broker_outbox
                WHERE invocation_id = invocation.id
                  AND command_type = 'invocation.start') AS start_state
         FROM agent_invocations AS invocation WHERE invocation.id = $1`,
      [accepted.invocationId],
    );
    expect(state.rows[0]).toEqual({
      state: 'RECONCILING',
      reconciliation_reason: 'CANCEL_NOT_CONFIRMED',
      started_events: '1',
      started_payload_state: 'RECONCILING',
      succeeded_events: '0',
      messages: '1',
      start_state: 'EXPIRED',
    });
  });

  it('commits an exact-authority final atomically and exact replay never duplicates it', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const capabilityId = await assignRunning(accepted);
    const success = successInput(accepted, capabilityId);

    const wrongFenceFact: WorkerInvocationSucceededFact = { ...success.fact, fence: '2' };
    await expect(
      journal.commitSuccess(
        {
          ...success,
          fact: wrongFenceFact,
          factDigest: workerInvocationFactDigest(wrongFenceFact),
        },
        sealAssistantMessage,
      ),
    ).rejects.toMatchObject<Partial<CloudJournalError>>({
      code: 'EXECUTION_AUTHORITY_MISMATCH',
    });

    for (const conflictingFact of [
      { ...success.fact, runtimeThreadId: 'thread-conflict' },
      { ...success.fact, runtimeTurnId: 'turn-conflict' },
      { ...success.fact, startedFactDigest: digest('0') },
    ] satisfies WorkerInvocationSucceededFact[]) {
      await expect(
        journal.commitSuccess(
          {
            ...success,
            fact: conflictingFact,
            factDigest: workerInvocationFactDigest(conflictingFact),
          },
          sealAssistantMessage,
        ),
      ).rejects.toMatchObject<Partial<CloudJournalError>>({
        code: 'EXECUTION_AUTHORITY_MISMATCH',
      });
    }
    const wrongAad = {
      ...success.resultCiphertext.aad,
      conversationId: randomUuidV7(),
    };
    await expect(
      journal.commitSuccess(
        {
          ...success,
          resultCiphertext: {
            ...success.resultCiphertext,
            aad: wrongAad,
            aadDigest: brokerSensitiveMessageAadDigest(wrongAad),
          },
        },
        sealAssistantMessage,
      ),
    ).rejects.toMatchObject<Partial<CloudJournalError>>({ code: 'EXECUTION_AUTHORITY_MISMATCH' });

    const tamperedWireBytes = Buffer.from(success.resultCiphertext.ciphertext, 'base64url');
    tamperedWireBytes[0] = tamperedWireBytes[0]! ^ 1;
    const tamperedWireCiphertext = tamperedWireBytes.toString('base64url');
    await expect(
      journal.commitSuccess(
        {
          ...success,
          resultCiphertext: {
            ...success.resultCiphertext,
            ciphertext: tamperedWireCiphertext,
            cipherDigest: brokerSensitiveMessageCipherDigest(
              success.resultCiphertext.nonce,
              tamperedWireCiphertext,
              success.resultCiphertext.authTag,
            ),
          },
        },
        sealAssistantMessage,
      ),
    ).rejects.toThrow();

    const swappedDigestDomainSealer: AssistantMessageSealer = ({ aad }) => {
      const encryptedMessage = encryptMessage({
        plaintext: 'different assistant secret',
        encryptionKey,
        digestKey,
        keyId: `pg-test:${aad.messageId}`,
        aad,
        nonce: Buffer.alloc(12, nonceCounter++),
      });
      return {
        encryptedMessage,
        verifiedResultDigest: encryptedMessage.contentDigest,
      };
    };
    await expect(journal.commitSuccess(success, swappedDigestDomainSealer)).rejects.toMatchObject<
      Partial<CloudJournalError>
    >({ code: 'WORKER_FACT_CONFLICT' });
    await expect(
      owner.query(
        `SELECT state,
                (SELECT count(*) FROM agent_invocation_events
                  WHERE invocation_id = $1
                    AND event_type = 'invocation.succeeded')::text AS succeeded_events,
                (SELECT count(*) FROM agent_messages
                  WHERE invocation_id = $1)::text AS messages
           FROM agent_invocations WHERE id = $1`,
        [accepted.invocationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: 'RUNNING', succeeded_events: '0', messages: '1' }],
    });
    const sealer = vi.fn(sealAssistantMessage);
    const committed = await journal.commitSuccess(success, sealer);
    expect(committed).toMatchObject({ replayed: false });
    expect(sealer).toHaveBeenCalledTimes(1);
    const unavailableOnReplay = vi.fn<AssistantMessageSealer>(() => {
      throw new Error('KMS_UNAVAILABLE');
    });
    await expect(journal.commitSuccess(success, unavailableOnReplay)).resolves.toMatchObject({
      replayed: true,
      consumerEventCursor: committed.consumerEventCursor,
    });
    expect(unavailableOnReplay).not.toHaveBeenCalled();
    const wrongResultFact: WorkerInvocationSucceededFact = {
      ...success.fact,
      resultDigest: hmac('5'),
    };
    await expect(
      journal.commitSuccess({
        ...success,
        fact: wrongResultFact,
        factDigest: workerInvocationFactDigest(wrongResultFact),
      }),
    ).rejects.toMatchObject<Partial<CloudJournalError>>({ code: 'WORKER_FACT_CONFLICT' });
    await expect(
      journal.commitSuccess({
        ...success,
        fact: wrongFenceFact,
        factDigest: workerInvocationFactDigest(wrongFenceFact),
      }),
    ).rejects.toMatchObject<Partial<CloudJournalError>>({
      code: 'EXECUTION_AUTHORITY_MISMATCH',
    });
    const differentLocalCipherFact: WorkerInvocationSucceededFact = {
      ...success.fact,
      localResultCipherDigest: digest('b'),
    };
    await expect(
      journal.commitSuccess({
        ...success,
        fact: differentLocalCipherFact,
        factDigest: workerInvocationFactDigest(differentLocalCipherFact),
      }),
    ).rejects.toMatchObject<Partial<CloudJournalError>>({ code: 'WORKER_FACT_CONFLICT' });

    const state = await owner.query<{
      messages: string;
      succeeded_events: string;
      state: string;
      result_message_id: string;
      conversation_state: string;
      consumer_events: string;
      latest_cursor: string;
      payload_digest: string;
      payload: unknown;
      terminal_source: string;
      terminal_source_event_id: string;
      terminal_fact_digest: string;
      started_fact_digest: string;
      runtime_thread_id: string;
      runtime_turn_id: string;
      durable_cipher_digest: string;
      durable_content_digest: string;
    }>(
      `SELECT
         (SELECT count(*) FROM agent_messages WHERE invocation_id = $1)::text AS messages,
         (SELECT count(*) FROM agent_invocation_events
           WHERE invocation_id = $1 AND event_type = 'invocation.succeeded')::text AS succeeded_events,
         invocation.state, invocation.result_message_id,
         invocation.runtime_thread_id, invocation.runtime_turn_id,
         (SELECT content_cipher_digest FROM agent_messages
           WHERE id = invocation.result_message_id) AS durable_cipher_digest,
         (SELECT content_digest FROM agent_messages
           WHERE id = invocation.result_message_id) AS durable_content_digest,
         conversation.state AS conversation_state,
         (SELECT count(*) FROM consumer_event_outbox
           WHERE invocation_id = $1)::text AS consumer_events,
         (SELECT latest_cursor::text FROM consumer_event_streams
           WHERE conversation_id = invocation.conversation_id) AS latest_cursor,
         (SELECT payload_digest
            FROM consumer_event_outbox WHERE invocation_id = $1) AS payload_digest,
         (SELECT payload
            FROM consumer_event_outbox WHERE invocation_id = $1) AS payload,
         (SELECT source FROM agent_invocation_events
            WHERE invocation_id = $1 AND event_type = 'invocation.succeeded')
            AS terminal_source,
         (SELECT source_event_id FROM agent_invocation_events
            WHERE invocation_id = $1 AND event_type = 'invocation.succeeded')
            AS terminal_source_event_id,
         (SELECT source_fact_digest FROM agent_invocation_events
            WHERE invocation_id = $1 AND event_type = 'invocation.succeeded')
            AS terminal_fact_digest,
         (SELECT source_fact_digest FROM agent_invocation_events
            WHERE invocation_id = $1 AND event_type = 'invocation.started')
            AS started_fact_digest
       FROM agent_invocations AS invocation
       JOIN agent_conversations AS conversation ON conversation.id = invocation.conversation_id
       WHERE invocation.id = $1`,
      [accepted.invocationId],
    );
    const terminalPayload = ConsumerTerminalEventPayloadSchema.parse(state.rows[0]!.payload);
    expect(terminalPayload).toMatchObject({
      protocol: CONSUMER_EVENT_OUTBOX_PROTOCOL,
      schemaVersion: 1,
      type: 'invocation.terminal',
      conversationId,
      invocationId: accepted.invocationId,
      terminalState: 'SUCCEEDED',
      assistantMessageId: committed.assistantMessageId,
      resultDigest: success.fact.resultDigest,
      errorCode: null,
    });
    expect(state.rows[0]).toEqual({
      messages: '2',
      succeeded_events: '1',
      state: 'SUCCEEDED',
      result_message_id: committed.assistantMessageId,
      conversation_state: 'IDLE',
      consumer_events: '1',
      latest_cursor: committed.consumerEventCursor,
      payload_digest: consumerEventPayloadDigest(terminalPayload),
      payload: terminalPayload,
      terminal_source: 'WORKER',
      terminal_source_event_id: accepted.invocationId,
      terminal_fact_digest: success.factDigest,
      started_fact_digest: success.fact.startedFactDigest,
      runtime_thread_id: success.fact.runtimeThreadId,
      runtime_turn_id: success.fact.runtimeTurnId,
      durable_cipher_digest: expect.any(String),
      durable_content_digest: domainSeparatedHmacSha256('combo:vnext:message:v1', digestKey, {
        text: 'assistant secret',
      }),
    });
    expect(state.rows[0]!.durable_cipher_digest).not.toBe(success.fact.localResultCipherDigest);
    expect(state.rows[0]!.durable_cipher_digest).not.toBe(success.resultCiphertext.cipherDigest);
    expect(success.resultCiphertext.cipherDigest).not.toBe(success.fact.localResultCipherDigest);
    expect(state.rows[0]!.durable_content_digest).not.toBe(success.fact.resultDigest);
  });

  it('replays SUCCEEDED from the durable Invocation journal after Consumer retention pruning', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const capability = await assignRunning(accepted);
    const success = successInput(accepted, capability);
    const committed = await journal.commitSuccess(success, sealAssistantMessage);
    expect(committed.consumerEventCursor).not.toBeNull();
    await publishAndPruneTerminalEvent(journal, {
      conversationId,
      cursor: committed.consumerEventCursor!,
    });

    const afterPrune = await counts(conversationId);
    expect(afterPrune.consumer_events).toBe('0');
    await expect(journal.commitSuccess(success)).resolves.toEqual({
      invocationId: accepted.invocationId,
      assistantMessageId: committed.assistantMessageId,
      resultDigest: success.fact.resultDigest,
      consumerEventCursor: null,
      replayed: true,
    });
    expect(await counts(conversationId)).toEqual(afterPrune);

    const conflictingFact: WorkerInvocationSucceededFact = {
      ...success.fact,
      resultDigest: hmac('5'),
    };
    await expect(
      journal.commitSuccess({
        ...success,
        fact: conflictingFact,
        factDigest: workerInvocationFactDigest(conflictingFact),
      }),
    ).rejects.toMatchObject<Partial<CloudJournalError>>({ code: 'WORKER_FACT_CONFLICT' });
    expect(await counts(conversationId)).toEqual(afterPrune);
  });

  it('claims, publishes, replays, and prunes Consumer events from PostgreSQL authority', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const capabilityId = await assignRunning(accepted);
    const success = successInput(accepted, capabilityId);
    const committed = await journal.commitSuccess(success, sealAssistantMessage);
    const identity = {
      creatorId: ids.creatorId,
      consumerId: ids.consumerId,
      conversationId,
    };

    const replay = await journal.replayConsumerEvents({
      ...identity,
      afterCursor: '0',
      limit: 10,
    });
    expect(replay).toMatchObject({
      latestCursor: committed.consumerEventCursor,
      expiredThroughCursor: '0',
    });
    expect(replay.events).toEqual([
      expect.objectContaining({
        cursor: committed.consumerEventCursor,
        conversationId,
        invocationId: accepted.invocationId,
        protocol: CONSUMER_EVENT_OUTBOX_PROTOCOL,
        eventType: 'invocation.terminal',
        state: 'PENDING',
        payload: expect.objectContaining({
          protocol: CONSUMER_EVENT_OUTBOX_PROTOCOL,
          type: 'invocation.terminal',
          conversationId,
          invocationId: accepted.invocationId,
          terminalState: 'SUCCEEDED',
          assistantMessageId: committed.assistantMessageId,
          resultDigest: success.fact.resultDigest,
          errorCode: null,
        }),
      }),
    ]);
    await expect(
      journal.replayConsumerEvents({
        ...identity,
        consumerId: randomUuidV7(),
        afterCursor: '0',
        limit: 10,
      }),
    ).rejects.toMatchObject<Partial<CloudJournalError>>({
      code: 'CONVERSATION_UNAVAILABLE',
    });

    const claimed = await journal.claimConsumerEvents({
      creatorId: ids.creatorId,
      consumerId: ids.consumerId,
      limit: 100,
    });
    const claimedEvent = claimed.find((event) => event.cursor === committed.consumerEventCursor);
    expect(claimedEvent).toMatchObject({
      cursor: committed.consumerEventCursor,
      attemptCount: 1,
      state: 'PENDING',
    });
    await expect(
      journal.claimConsumerEvents({
        creatorId: ids.creatorId,
        consumerId: ids.consumerId,
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await expect(
      journal.markConsumerEventPublished({
        ...identity,
        cursor: committed.consumerEventCursor,
        payloadDigest: digest('0'),
      }),
    ).rejects.toMatchObject<Partial<CloudJournalError>>({
      code: 'PERSISTENCE_INVARIANT_FAILED',
    });
    const payloadDigest = claimedEvent!.payloadDigest;
    await expect(
      journal.markConsumerEventPublished({
        ...identity,
        cursor: committed.consumerEventCursor,
        payloadDigest,
      }),
    ).resolves.toEqual({ cursor: committed.consumerEventCursor, replayed: false });
    await expect(
      journal.markConsumerEventPublished({
        ...identity,
        cursor: committed.consumerEventCursor,
        payloadDigest,
      }),
    ).resolves.toEqual({ cursor: committed.consumerEventCursor, replayed: true });
    await expect(
      owner.query<{ next_attempt_at: Date | null }>(
        `SELECT next_attempt_at FROM consumer_event_outbox WHERE cursor = $1`,
        [committed.consumerEventCursor],
      ),
    ).resolves.toMatchObject({ rows: [{ next_attempt_at: null }] });

    // Advance this one disposable fixture past retention without weakening the
    // production transition trigger or waiting seven wall-clock days.
    await owner.query(
      `ALTER TABLE consumer_event_outbox DISABLE TRIGGER consumer_event_outbox_transition`,
    );
    try {
      await owner.query(
        `UPDATE consumer_event_outbox
            SET created_at = now() - interval '8 days',
                retained_until = (now() - interval '8 days') + interval '7 days'
          WHERE cursor = $1`,
        [committed.consumerEventCursor],
      );
    } finally {
      await owner.query(
        `ALTER TABLE consumer_event_outbox ENABLE TRIGGER consumer_event_outbox_transition`,
      );
    }
    await expect(journal.pruneExpiredConsumerEvents(identity)).resolves.toEqual({
      deleted: 1,
      expiredThroughCursor: committed.consumerEventCursor,
    });
    await expect(
      journal.replayConsumerEvents({
        ...identity,
        afterCursor: committed.consumerEventCursor,
        limit: 10,
      }),
    ).rejects.toMatchObject<Partial<CloudJournalError>>({ code: 'SSE_CURSOR_EXPIRED' });
    await expect(
      journal.replayConsumerEvents({ ...identity, afterCursor: '0', limit: 10 }),
    ).resolves.toEqual({
      latestCursor: committed.consumerEventCursor,
      expiredThroughCursor: committed.consumerEventCursor,
      events: [],
    });
  });

  it('prunes only the contiguous expired prefix of one Consumer stream', async () => {
    const conversationId = await createConversation();
    const journal = new PostgresCloudJournal(journalPools);
    const cursors: string[] = [];

    for (const turnNo of [1, 2, 3]) {
      const accepted = acceptInput(conversationId, { turnNo });
      await journal.acceptInvocation(accepted);
      const capabilityId = await assignRunning(accepted);
      const committed = await journal.commitSuccess(
        successInput(accepted, capabilityId),
        sealAssistantMessage,
      );
      cursors.push(committed.consumerEventCursor);
    }

    await owner.query(
      `ALTER TABLE consumer_event_outbox DISABLE TRIGGER consumer_event_outbox_transition`,
    );
    try {
      await owner.query(
        `UPDATE consumer_event_outbox
            SET created_at = CASE
                  WHEN cursor = $2 THEN now()
                  ELSE now() - interval '8 days'
                END,
                retained_until = CASE
                  WHEN cursor = $2 THEN now() + interval '7 days'
                  ELSE (now() - interval '8 days') + interval '7 days'
                END
          WHERE owner_id = $1 AND conversation_id = $4 AND cursor IN ($2, $3, $5)`,
        [ids.consumerId, cursors[1], cursors[2], conversationId, cursors[0]],
      );
    } finally {
      await owner.query(
        `ALTER TABLE consumer_event_outbox ENABLE TRIGGER consumer_event_outbox_transition`,
      );
    }

    await expect(
      journal.pruneExpiredConsumerEvents({
        creatorId: ids.creatorId,
        consumerId: ids.consumerId,
        conversationId,
      }),
    ).resolves.toEqual({ deleted: 1, expiredThroughCursor: cursors[0] });

    const durable = await owner.query<{ cursor: string }>(
      `SELECT cursor::text
         FROM consumer_event_outbox
        WHERE owner_id = $1 AND conversation_id = $2
        ORDER BY cursor`,
      [ids.consumerId, conversationId],
    );
    expect(durable.rows.map((row) => row.cursor)).toEqual([cursors[1], cursors[2]]);
  });

  it('durably begins reconciliation once and does not mark UNCERTAIN before 300 seconds', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    await assignPersisted(accepted);
    const sourceEventId = randomUuidV7();
    const reconciliation = await journal.beginReconciliation({
      creatorId: ids.creatorId,
      consumerId: ids.consumerId,
      conversationId,
      invocationId: accepted.invocationId,
      sourceEventId,
      reason: 'JOURNAL_LOST',
    });
    expect(reconciliation).toMatchObject({
      invocationId: accepted.invocationId,
      state: 'RECONCILING',
      reason: 'JOURNAL_LOST',
      replayed: false,
    });
    expect(
      Date.parse(reconciliation.reconciliationDeadlineAt) -
        Date.parse(reconciliation.reconciliationStartedAt),
    ).toBe(300_000);
    await expect(
      journal.beginReconciliation({
        creatorId: ids.creatorId,
        consumerId: ids.consumerId,
        conversationId,
        invocationId: accepted.invocationId,
        sourceEventId,
        reason: 'JOURNAL_LOST',
      }),
    ).resolves.toMatchObject({ replayed: true });
    await expect(
      journal.beginReconciliation({
        creatorId: ids.creatorId,
        consumerId: ids.consumerId,
        conversationId,
        invocationId: accepted.invocationId,
        sourceEventId: randomUuidV7(),
        reason: 'JOURNAL_LOST',
      }),
    ).rejects.toMatchObject({ code: 'TERMINAL_CONFLICT' });
    await expect(
      journal.beginReconciliation({
        creatorId: ids.creatorId,
        consumerId: randomUuidV7(),
        conversationId,
        invocationId: accepted.invocationId,
        sourceEventId,
        reason: 'JOURNAL_LOST',
      }),
    ).rejects.toMatchObject({ code: 'EXECUTION_AUTHORITY_MISMATCH' });

    await expect(
      owner.query(
        `UPDATE agent_invocations
            SET state = 'UNCERTAIN', uncertainty_reason = reconciliation_reason,
                error_code = 'EXECUTION_STATE_UNKNOWN', terminal_at = now()
          WHERE id = $1`,
        [accepted.invocationId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await owner.query(`UPDATE agent_invocations SET state = 'RUNNING' WHERE id = $1`, [
      accepted.invocationId,
    ]);
    await expect(
      journal.beginReconciliation({
        creatorId: ids.creatorId,
        consumerId: ids.consumerId,
        conversationId,
        invocationId: accepted.invocationId,
        sourceEventId,
        reason: 'JOURNAL_LOST',
      }),
    ).resolves.toMatchObject({ state: 'RECONCILING', replayed: true });

    await expect(
      journal.markUncertain({
        creatorId: ids.creatorId,
        consumerId: ids.consumerId,
        conversationId,
        invocationId: accepted.invocationId,
        sourceEventId: randomUuidV7(),
        reason: 'JOURNAL_LOST',
      }),
    ).resolves.toMatchObject({
      state: 'RECONCILING',
      exhausted: false,
      consumerEventCursor: null,
    });
    const state = await owner.query<{
      state: string;
      reconciliation_reason: string;
      reconciliation_started_at: Date;
      terminal_at: Date | null;
    }>(
      `SELECT state, reconciliation_reason, reconciliation_started_at, terminal_at
         FROM agent_invocations WHERE id = $1`,
      [accepted.invocationId],
    );
    expect(state.rows[0]).toMatchObject({
      state: 'RECONCILING',
      reconciliation_reason: 'JOURNAL_LOST',
      terminal_at: null,
    });
    expect(await counts(conversationId)).toMatchObject({
      events: '2',
      consumer_events: '0',
      consumer_streams: '0',
      conversation_state: 'BUSY',
    });
  });

  it('uses Cloud time at the before/equal/after 300-second boundary', async () => {
    const boundary = await owner.query<{ before: boolean; equal: boolean; after: boolean }>(
      `SELECT
         creator_agent_reconciliation_is_exhausted(
           '2026-08-13T08:00:00.000Z'::timestamptz,
           '2026-08-13T08:04:59.999Z'::timestamptz
         ) AS before,
         creator_agent_reconciliation_is_exhausted(
           '2026-08-13T08:00:00.000Z'::timestamptz,
           '2026-08-13T08:05:00.000Z'::timestamptz
         ) AS equal,
         creator_agent_reconciliation_is_exhausted(
           '2026-08-13T08:00:00.000Z'::timestamptz,
           '2026-08-13T08:05:00.001Z'::timestamptz
         ) AS after`,
    );
    expect(boundary.rows[0]).toEqual({ before: false, equal: true, after: true });
  });

  it('atomically commits UNCERTAIN, terminal event, Consumer outbox and IDLE projection', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    await backdateReconciliation(accepted, 'HOST_EVIDENCE_LOST', randomUuidV7());
    const terminalSourceEventId = randomUuidV7();

    const terminal = await journal.markUncertain({
      creatorId: ids.creatorId,
      consumerId: ids.consumerId,
      conversationId,
      invocationId: accepted.invocationId,
      sourceEventId: terminalSourceEventId,
      reason: 'HOST_EVIDENCE_LOST',
    });
    expect(terminal).toMatchObject({
      state: 'UNCERTAIN',
      reason: 'HOST_EVIDENCE_LOST',
      exhausted: true,
      replayed: false,
    });
    expect(terminal.consumerEventCursor).not.toBeNull();
    await expect(
      journal.markUncertain({
        creatorId: ids.creatorId,
        consumerId: ids.consumerId,
        conversationId,
        invocationId: accepted.invocationId,
        sourceEventId: terminalSourceEventId,
        reason: 'HOST_EVIDENCE_LOST',
      }),
    ).resolves.toMatchObject({ state: 'UNCERTAIN', replayed: true });
    await expect(
      journal.markUncertain({
        creatorId: ids.creatorId,
        consumerId: ids.consumerId,
        conversationId,
        invocationId: accepted.invocationId,
        sourceEventId: randomUuidV7(),
        reason: 'HOST_EVIDENCE_LOST',
      }),
    ).rejects.toMatchObject({ code: 'TERMINAL_CONFLICT' });

    const durable = await owner.query<{
      state: string;
      error_code: string;
      uncertainty_reason: string;
      reconciliation_reason: string;
      events: string;
      consumer_events: string;
      conversation_state: string;
    }>(
      `SELECT invocation.state, invocation.error_code, invocation.uncertainty_reason,
              invocation.reconciliation_reason,
              (SELECT count(*) FROM agent_invocation_events
                WHERE invocation_id = invocation.id)::text AS events,
              (SELECT count(*) FROM consumer_event_outbox
                WHERE invocation_id = invocation.id)::text AS consumer_events,
              conversation.state AS conversation_state
         FROM agent_invocations AS invocation
         JOIN agent_conversations AS conversation
           ON conversation.id = invocation.conversation_id
        WHERE invocation.id = $1`,
      [accepted.invocationId],
    );
    expect(durable.rows[0]).toEqual({
      state: 'UNCERTAIN',
      error_code: 'EXECUTION_STATE_UNKNOWN',
      uncertainty_reason: 'HOST_EVIDENCE_LOST',
      reconciliation_reason: 'HOST_EVIDENCE_LOST',
      events: '3',
      consumer_events: '1',
      conversation_state: 'IDLE',
    });
    const page = await journal.replayConsumerEvents({
      creatorId: ids.creatorId,
      consumerId: ids.consumerId,
      conversationId,
      afterCursor: '0',
      limit: 10,
    });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({
      cursor: terminal.consumerEventCursor,
      eventType: 'invocation.terminal',
      payload: {
        terminalState: 'UNCERTAIN',
        errorCode: 'EXECUTION_STATE_UNKNOWN',
      },
    });
  });

  it('replays UNCERTAIN from the durable Invocation journal after Consumer retention pruning', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    await backdateReconciliation(accepted, 'HOST_EVIDENCE_LOST', randomUuidV7());
    const terminalSourceEventId = randomUuidV7();
    const input = {
      creatorId: ids.creatorId,
      consumerId: ids.consumerId,
      conversationId,
      invocationId: accepted.invocationId,
      sourceEventId: terminalSourceEventId,
      reason: 'HOST_EVIDENCE_LOST' as const,
    };
    const terminal = await journal.markUncertain(input);
    expect(terminal.consumerEventCursor).not.toBeNull();
    await publishAndPruneTerminalEvent(journal, {
      conversationId,
      cursor: terminal.consumerEventCursor!,
    });

    const afterPrune = await counts(conversationId);
    expect(afterPrune.consumer_events).toBe('0');
    await expect(journal.markUncertain(input)).resolves.toMatchObject({
      invocationId: accepted.invocationId,
      state: 'UNCERTAIN',
      reason: 'HOST_EVIDENCE_LOST',
      consumerEventCursor: null,
      exhausted: true,
      replayed: true,
    });
    expect(await counts(conversationId)).toEqual(afterPrune);
    await expect(
      journal.markUncertain({ ...input, sourceEventId: randomUuidV7() }),
    ).rejects.toMatchObject<Partial<CloudJournalError>>({ code: 'TERMINAL_CONFLICT' });
    expect(await counts(conversationId)).toEqual(afterPrune);
  });

  it('rolls back every UNCERTAIN crash window and safely retries the exact terminal event', async () => {
    const steps: CloudJournalStep[] = [
      'INVOCATION_UNCERTAIN',
      'UNCERTAIN_EVENT',
      'CONSUMER_EVENT_OUTBOX',
      'CONSUMER_EVENT_STREAM',
      'CONVERSATION_IDLE',
    ];
    for (const target of steps) {
      const conversationId = await createConversation();
      const accepted = acceptInput(conversationId);
      const baseJournal = new PostgresCloudJournal(journalPools);
      await baseJournal.acceptInvocation(accepted);
      await backdateReconciliation(accepted, 'MODEL_ATTEMPT_UNKNOWN', randomUuidV7());
      const input = {
        creatorId: ids.creatorId,
        consumerId: ids.consumerId,
        conversationId,
        invocationId: accepted.invocationId,
        sourceEventId: randomUuidV7(),
        reason: 'MODEL_ATTEMPT_UNKNOWN' as const,
      };
      const failing = new PostgresCloudJournal(journalPools, (step) => {
        if (step === target) throw new Error(`FAILPOINT:${target}`);
      });

      await expect(failing.markUncertain(input)).rejects.toThrow(`FAILPOINT:${target}`);
      expect(await counts(conversationId), target).toMatchObject({
        events: '2',
        consumer_events: '0',
        consumer_streams: '0',
        conversation_state: 'BUSY',
      });
      await expect(baseJournal.markUncertain(input)).resolves.toMatchObject({
        state: 'UNCERTAIN',
        replayed: false,
      });
    }
  });

  it('rolls back every final crash window to the original RUNNING projection', async () => {
    const steps: CloudJournalStep[] = [
      'ASSISTANT_MESSAGE',
      'INVOCATION_SUCCEEDED',
      'SUCCEEDED_EVENT',
      'CONSUMER_EVENT_OUTBOX',
      'CONSUMER_EVENT_STREAM',
      'CONVERSATION_IDLE',
    ];
    for (const target of steps) {
      const conversationId = await createConversation();
      const accepted = acceptInput(conversationId);
      const baseJournal = new PostgresCloudJournal(journalPools);
      await baseJournal.acceptInvocation(accepted);
      const capabilityId = await assignRunning(accepted);
      const success = successInput(accepted, capabilityId);
      const journal = new PostgresCloudJournal(journalPools, (step) => {
        if (step === target) throw new Error(`FAILPOINT:${target}`);
      });

      await expect(journal.commitSuccess(success, sealAssistantMessage)).rejects.toThrow(
        `FAILPOINT:${target}`,
      );
      const state = await owner.query<{
        messages: string;
        events: string;
        state: string;
        result_message_id: string | null;
        conversation_state: string;
        consumer_events: string;
        consumer_streams: string;
      }>(
        `SELECT
           (SELECT count(*) FROM agent_messages WHERE invocation_id = $1)::text AS messages,
           (SELECT count(*) FROM agent_invocation_events WHERE invocation_id = $1)::text AS events,
           invocation.state, invocation.result_message_id,
           conversation.state AS conversation_state,
           (SELECT count(*) FROM consumer_event_outbox
             WHERE invocation_id = $1)::text AS consumer_events,
           (SELECT count(*) FROM consumer_event_streams
             WHERE conversation_id = invocation.conversation_id)::text AS consumer_streams
         FROM agent_invocations AS invocation
         JOIN agent_conversations AS conversation ON conversation.id = invocation.conversation_id
         WHERE invocation.id = $1`,
        [accepted.invocationId],
      );
      expect(state.rows[0], target).toEqual({
        messages: '1',
        events: '3',
        state: 'RUNNING',
        result_message_id: null,
        conversation_state: 'BUSY',
        consumer_events: '0',
        consumer_streams: '0',
      });
    }
  });

  it('rejects an AES-GCM key/nonce reuse at the durable database boundary', async () => {
    const sharedNonce = randomBytes(12);
    const sharedKeyId = `pg-test:shared-${randomUUID()}`;
    const firstConversation = await createConversation();
    const secondConversation = await createConversation();
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(
      acceptInput(firstConversation, { keyId: sharedKeyId, nonce: sharedNonce }),
    );
    await expect(
      journal.acceptInvocation(
        acceptInput(secondConversation, { keyId: sharedKeyId, nonce: sharedNonce }),
      ),
    ).rejects.toMatchObject({ code: '23505' });
    expect(await counts(secondConversation)).toMatchObject({
      messages: '0',
      invocations: '0',
      conversation_state: 'IDLE',
    });
  });

  it('rejects a fresh final after an explicit Execution Capability security revoke', async () => {
    const conversationId = await createConversation();
    const journal = new PostgresCloudJournal(journalPools);
    const accepted = acceptInput(conversationId);
    await journal.acceptInvocation(accepted);
    const authority = await assignDispatchPending(accepted);
    const prepared = preparedInput(accepted, authority);
    const committedPrepared = await journal.commitPrepared(prepared);
    if (!committedPrepared.startCommandId) throw new Error('expected start command');
    await markStartSent(committedPrepared.startCommandId);
    const started = startedInput(prepared, committedPrepared.startCommandId);
    await journal.commitStarted(started);
    const success = successInput(accepted, {
      ...authority,
      runtimeThreadId: started.fact.runtimeThreadId,
      runtimeTurnId: started.fact.runtimeTurnId,
      startedFactDigest: started.factDigest,
    });

    await owner.query(
      `UPDATE agent_invocations
          SET execution_capability_revoked_at = now()
        WHERE id = $1`,
      [accepted.invocationId],
    );
    await expect(journal.commitSuccess(success, sealAssistantMessage)).rejects.toMatchObject<
      Partial<CloudJournalError>
    >({
      code: 'EXECUTION_AUTHORITY_MISMATCH',
    });
    await expect(
      owner.query(
        `SELECT state,
                (SELECT count(*) FROM agent_invocation_events
                  WHERE invocation_id = $1
                    AND event_type = 'invocation.succeeded')::text AS succeeded_events,
                (SELECT count(*) FROM agent_messages
                  WHERE invocation_id = $1)::text AS messages
           FROM agent_invocations WHERE id = $1`,
        [accepted.invocationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: 'RUNNING', succeeded_events: '0', messages: '1' }],
    });
  });

  it('uses strict Cloud capability deadlines: before/equal reject and after remains eligible', async () => {
    for (const boundary of [
      { offset: '-1 second', shouldCommit: false },
      { offset: '0 seconds', shouldCommit: false },
      { offset: '1 minute', shouldCommit: true },
    ]) {
      const conversationId = await createConversation();
      const journal = new PostgresCloudJournal(journalPools);
      const accepted = acceptInput(conversationId);
      await journal.acceptInvocation(accepted);
      const authority = await assignRunning(accepted);
      const success = successInput(accepted, authority);

      // This is a database-clock time-warp for an immutable deadline: production
      // reaches the same rows by waiting, never by changing the frozen value.
      await owner.query(
        `ALTER TABLE agent_invocations DISABLE TRIGGER agent_invocations_capability_authority`,
      );
      try {
        await owner.query(
          `UPDATE agent_invocations
              SET execution_capability_expires_at = clock_timestamp() + $2::interval
            WHERE id = $1`,
          [accepted.invocationId, boundary.offset],
        );
      } finally {
        await owner.query(
          `ALTER TABLE agent_invocations ENABLE TRIGGER agent_invocations_capability_authority`,
        );
      }

      if (boundary.shouldCommit) {
        await expect(journal.commitSuccess(success, sealAssistantMessage)).resolves.toMatchObject({
          replayed: false,
        });
      } else {
        await expect(journal.commitSuccess(success, sealAssistantMessage)).rejects.toMatchObject<
          Partial<CloudJournalError>
        >({
          code: 'EXECUTION_AUTHORITY_MISMATCH',
        });
        expect(await counts(conversationId)).toMatchObject({
          messages: '1',
          events: '3',
          consumer_events: '0',
          conversation_state: 'BUSY',
        });
      }
    }
  });

  it('rolls back every terminal mutation when a 3-second capability expires inside a 4-second sealer', async () => {
    const conversationId = await createConversation();
    const journal = new PostgresCloudJournal(journalPools);
    const accepted = acceptInput(conversationId);
    await journal.acceptInvocation(accepted);
    const authority = await assignRunning(accepted);
    const success = successInput(accepted, authority);
    await timeWarpCapabilityExpiry(accepted.invocationId, '3 seconds');

    let sealerCalls = 0;
    const delayedSealer: AssistantMessageSealer = async (input) => {
      sealerCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      input.signal.throwIfAborted();
      return sealAssistantMessage(input);
    };
    await expect(
      journal.commitSuccess(success, delayedSealer, AbortSignal.timeout(8_000)),
    ).rejects.toMatchObject<Partial<CloudJournalError>>({
      code: 'EXECUTION_AUTHORITY_MISMATCH',
    });
    expect(sealerCalls).toBe(1);
    await expect(
      owner.query(
        `SELECT invocation.state, invocation.result_message_id, invocation.result_digest,
                  invocation.terminal_at,
                  (SELECT count(*) FROM agent_messages
                    WHERE invocation_id = invocation.id AND role = 'ASSISTANT')::text
                    AS assistant_messages,
                  (SELECT count(*) FROM agent_invocation_events
                    WHERE invocation_id = invocation.id
                      AND event_type = 'invocation.succeeded')::text AS succeeded_events,
                  (SELECT count(*) FROM consumer_event_outbox
                    WHERE invocation_id = invocation.id)::text AS terminal_outbox
             FROM agent_invocations AS invocation
            WHERE invocation.id = $1`,
        [accepted.invocationId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: 'RUNNING',
          result_message_id: null,
          result_digest: null,
          terminal_at: null,
          assistant_messages: '0',
          succeeded_events: '0',
          terminal_outbox: '0',
        },
      ],
    });
    expect(await counts(conversationId)).toMatchObject({
      messages: '1',
      events: '3',
      commands: '2',
      consumer_events: '0',
      conversation_state: 'BUSY',
    });
  }, 12_000);

  it('commits an old exact final after replacement revokes its Lease while Capability remains live', async () => {
    const conversationId = await createConversation();
    const staleConversationId = await createConversation();
    const journal = new PostgresCloudJournal(journalPools);
    const accepted = acceptInput(conversationId);
    const staleAccepted = acceptInput(staleConversationId);
    await journal.acceptInvocation(accepted);
    await journal.acceptInvocation(staleAccepted);
    const authority = await assignDispatchPending(accepted);
    const staleAuthority = await assignDispatchPending(staleAccepted);
    const prepared = preparedInput(accepted, authority);
    const stalePrepared = preparedInput(staleAccepted, staleAuthority);
    const committedPrepared = await journal.commitPrepared(prepared);
    const committedStalePrepared = await journal.commitPrepared(stalePrepared);
    if (!committedPrepared.startCommandId || !committedStalePrepared.startCommandId) {
      throw new Error('expected start commands');
    }
    await markStartSent(committedPrepared.startCommandId);
    await markStartSent(committedStalePrepared.startCommandId);
    const started = startedInput(prepared, committedPrepared.startCommandId);
    const staleStarted = startedInput(stalePrepared, committedStalePrepared.startCommandId);
    await journal.commitStarted(started);
    await journal.commitStarted(staleStarted);
    const success = successInput(accepted, {
      ...authority,
      runtimeThreadId: started.fact.runtimeThreadId,
      runtimeTurnId: started.fact.runtimeTurnId,
      startedFactDigest: started.factDigest,
    });
    const staleSuccess = successInput(staleAccepted, {
      ...staleAuthority,
      runtimeThreadId: staleStarted.fact.runtimeThreadId,
      runtimeTurnId: staleStarted.fact.runtimeTurnId,
      startedFactDigest: staleStarted.factDigest,
    });

    await owner.query(`UPDATE worker_leases SET state = 'REVOKED' WHERE id = $1`, [ids.leaseId]);
    const committed = await journal.commitSuccess(success, sealAssistantMessage);
    expect(committed).toMatchObject({ replayed: false });

    const currentTransportLeaseId = randomUuidV7();
    await owner.query(
      `INSERT INTO worker_leases (
         id, deployment_id, creator_id, worker_id, connection_id, fence, expires_at
       ) VALUES ($1, $2, $3, $4, $5, 2, now() + interval '10 minutes')`,
      [currentTransportLeaseId, ids.deploymentId, ids.creatorId, ids.workerId, randomUuidV7()],
    );
    const currentAuthorityBefore = await owner.query(
      `SELECT lease.state AS lease_state, lease.fence, lease.worker_id,
              deployment.serving_version_id, deployment.observed_state,
              deployment.lease_fence, deployment.observed_worker_id,
              deployment.observed_generation
         FROM worker_leases AS lease
         JOIN deployments AS deployment ON deployment.id = lease.deployment_id
        WHERE lease.id = $1`,
      [currentTransportLeaseId],
    );
    await expect(journal.commitSuccess(success)).resolves.toEqual({
      ...committed,
      replayed: true,
    });
    await expect(journal.commitSuccess(staleSuccess, sealAssistantMessage)).resolves.toMatchObject({
      invocationId: staleAccepted.invocationId,
      replayed: false,
    });
    const currentAuthorityAfter = await owner.query(
      `SELECT lease.state AS lease_state, lease.fence, lease.worker_id,
              deployment.serving_version_id, deployment.observed_state,
              deployment.lease_fence, deployment.observed_worker_id,
              deployment.observed_generation
         FROM worker_leases AS lease
         JOIN deployments AS deployment ON deployment.id = lease.deployment_id
        WHERE lease.id = $1`,
      [currentTransportLeaseId],
    );
    expect(currentAuthorityAfter.rows).toEqual(currentAuthorityBefore.rows);
    await expect(
      owner.query(
        `SELECT state,
                (SELECT count(*) FROM agent_invocation_events
                  WHERE invocation_id = $1
                    AND event_type = 'invocation.succeeded')::text AS succeeded_events
           FROM agent_invocations WHERE id = $1`,
        [staleAccepted.invocationId],
      ),
    ).resolves.toMatchObject({ rows: [{ state: 'SUCCEEDED', succeeded_events: '1' }] });
    expect(await counts(conversationId)).toMatchObject({
      messages: '2',
      events: '4',
      commands: '2',
      consumer_events: '1',
      conversation_state: 'IDLE',
    });
  });

  it('revokes a Capability created after a blocked SECURITY statement began', async () => {
    const raceAgentId = randomUuidV7();
    const raceVersionId = randomUuidV7();
    const raceDeploymentId = randomUuidV7();
    const raceLeaseId = randomUuidV7();
    await owner.query(
      `INSERT INTO agents (id, creator_id, public_slug, name)
       VALUES ($1, $2, $3, 'Security Timestamp Race Agent')`,
      [raceAgentId, ids.creatorId, `security-race-${raceAgentId.slice(0, 8)}`],
    );
    await owner.query(
      `INSERT INTO agent_versions (
         id, agent_id, creator_id, ordinal, schema_version, version_digest, snapshot_id,
         behavior_contract, behavior_contract_digest, runtime_policy, runtime_policy_digest,
         io_contract, io_contract_digest, model_policy, model_policy_digest,
         codex_runtime_version, codex_runtime_artifact_digest, codex_protocol_schema_digest
       ) VALUES (
         $1, $2, $3, 1, 1, $4, $5,
         '{}'::jsonb, $6, '{}'::jsonb, $7, '{}'::jsonb, $8, '{}'::jsonb, $9,
         '0.147.0-alpha.6.5', $10, $11
       )`,
      [
        raceVersionId,
        raceAgentId,
        ids.creatorId,
        digest('7'),
        ids.snapshotId,
        digest('a'),
        digest('b'),
        digest('c'),
        digest('d'),
        `sha256:${digest('e')}`,
        `sha256:${digest('f')}`,
      ],
    );
    await owner.query(
      `INSERT INTO agent_version_controls (version_id, creator_id)
       VALUES ($1, $2)`,
      [raceVersionId, ids.creatorId],
    );
    await owner.query(
      `INSERT INTO deployments (id, agent_id, creator_id, environment, desired_version_id)
       VALUES ($1, $2, $3, 'TEST', $4)`,
      [raceDeploymentId, raceAgentId, ids.creatorId, raceVersionId],
    );
    await owner.query(
      `INSERT INTO worker_leases (
         id, deployment_id, creator_id, worker_id, connection_id, fence, expires_at
       ) VALUES ($1, $2, $3, $4, $5, 1, now() + interval '10 minutes')`,
      [raceLeaseId, raceDeploymentId, ids.creatorId, ids.workerId, randomUuidV7()],
    );
    const raceConversationId = await createConversation({
      deploymentId: raceDeploymentId,
      agentId: raceAgentId,
      agentVersionId: raceVersionId,
    });
    const raceAccepted = acceptInput(raceConversationId, { agentVersionId: raceVersionId });
    const raceAssignment: TestExecutionAssignment = {
      deploymentId: raceDeploymentId,
      workerId: ids.workerId,
      leaseId: raceLeaseId,
      fence: '1',
    };
    const versionLockClient = new Client({ connectionString: databaseUrl });
    const securityUpdateClient = new Client({ connectionString: databaseUrl });
    await Promise.all([versionLockClient.connect(), securityUpdateClient.connect()]);
    let securityUpdate:
      | Promise<
          { status: 'fulfilled'; rowCount: number | null } | { status: 'rejected'; error: unknown }
        >
      | undefined;
    try {
      await versionLockClient.query('BEGIN');
      const versionLockPid = await versionLockClient.query<{ pid: number }>(
        `SELECT pg_backend_pid() AS pid`,
      );
      await versionLockClient.query(
        `SELECT 1
           FROM agent_version_controls
          WHERE version_id = $1 AND creator_id = $2
          FOR SHARE`,
        [raceVersionId, ids.creatorId],
      );

      await securityUpdateClient.query('BEGIN');
      const securityUpdatePid = await securityUpdateClient.query<{ pid: number }>(
        `SELECT pg_backend_pid() AS pid`,
      );
      securityUpdate = securityUpdateClient
        .query(
          `UPDATE agent_version_controls
              SET severity = 'SECURITY', reason_code = 'SECURITY_TIMESTAMP_RACE',
                  updated_at = clock_timestamp()
            WHERE version_id = $1 AND creator_id = $2`,
          [raceVersionId, ids.creatorId],
        )
        .then(
          (result) => ({ status: 'fulfilled' as const, rowCount: result.rowCount }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        );

      let blockedStatementStartedAt: Date | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const blocking = await owner.query<{
          blocked_by_version_lock: boolean;
          query_start: Date;
        }>(
          `SELECT $2::integer = ANY(pg_blocking_pids($1)) AS blocked_by_version_lock,
                  query_start
             FROM pg_stat_activity
            WHERE pid = $1`,
          [securityUpdatePid.rows[0]!.pid, versionLockPid.rows[0]!.pid],
        );
        if (blocking.rows[0]?.blocked_by_version_lock === true) {
          blockedStatementStartedAt = blocking.rows[0].query_start;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blockedStatementStartedAt).toBeDefined();

      const journal = new PostgresCloudJournal(journalPools);
      await journal.acceptInvocation(raceAccepted);
      const raceAuthority = await assignDispatchPending(raceAccepted, raceAssignment);
      const invocationBeforeRelease = await owner.query<{
        created_after_security_statement: boolean;
        execution_capability_id: string;
        execution_capability_revoked_at: Date | null;
      }>(
        `SELECT created_at > $2::timestamptz AS created_after_security_statement,
                execution_capability_id, execution_capability_revoked_at
           FROM agent_invocations
          WHERE id = $1`,
        [raceAccepted.invocationId, blockedStatementStartedAt],
      );
      expect(invocationBeforeRelease.rows).toEqual([
        {
          created_after_security_statement: true,
          execution_capability_id: raceAuthority.executionCapabilityId,
          execution_capability_revoked_at: null,
        },
      ]);

      await versionLockClient.query('COMMIT');
      const securityOutcome = await securityUpdate;
      expect(securityOutcome).toEqual({ status: 'fulfilled', rowCount: 1 });
      await securityUpdateClient.query('COMMIT');
    } finally {
      await versionLockClient.query('ROLLBACK').catch(() => undefined);
      if (securityUpdate) await securityUpdate;
      await securityUpdateClient.query('ROLLBACK').catch(() => undefined);
      await Promise.all([versionLockClient.end(), securityUpdateClient.end()]);
    }

    await expect(
      owner.query(
        `SELECT control.severity,
                invocation.execution_capability_revoked_at IS NOT NULL AS revoked,
                invocation.execution_capability_revoked_at >= invocation.created_at
                  AS revoke_not_before_creation
           FROM agent_invocations AS invocation
           JOIN agent_version_controls AS control
             ON control.version_id = invocation.agent_version_id
            AND control.creator_id = invocation.creator_id
          WHERE invocation.id = $1`,
        [raceAccepted.invocationId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          severity: 'SECURITY',
          revoked: true,
          revoke_not_before_creation: true,
        },
      ],
    });
  });

  it('revokes one Deployment across Consumers under the shared fence and preserves exact replay', async () => {
    const securityAgentId = randomUuidV7();
    const securityVersionId = randomUuidV7();
    const securityDeploymentId = randomUuidV7();
    const securityLeaseId = randomUuidV7();
    const secondConsumer = await owner.query<{ id: string }>(
      `INSERT INTO users (account) VALUES ($1) RETURNING id`,
      ['creator-gggggggg'],
    );
    const secondConsumerId = secondConsumer.rows[0]!.id;
    await owner.query(
      `INSERT INTO agents (id, creator_id, public_slug, name)
       VALUES ($1, $2, $3, 'Security Fence Test Agent')`,
      [securityAgentId, ids.creatorId, `security-${securityAgentId.slice(0, 8)}`],
    );
    await owner.query(
      `INSERT INTO agent_versions (
         id, agent_id, creator_id, ordinal, schema_version, version_digest, snapshot_id,
         behavior_contract, behavior_contract_digest, runtime_policy, runtime_policy_digest,
         io_contract, io_contract_digest, model_policy, model_policy_digest,
         codex_runtime_version, codex_runtime_artifact_digest, codex_protocol_schema_digest
       ) VALUES (
         $1, $2, $3, 1, 1, $4, $5,
         '{}'::jsonb, $6, '{}'::jsonb, $7, '{}'::jsonb, $8, '{}'::jsonb, $9,
         '0.147.0-alpha.6.5', $10, $11
       )`,
      [
        securityVersionId,
        securityAgentId,
        ids.creatorId,
        digest('7'),
        ids.snapshotId,
        digest('a'),
        digest('b'),
        digest('c'),
        digest('d'),
        `sha256:${digest('e')}`,
        `sha256:${digest('f')}`,
      ],
    );
    await owner.query(
      `INSERT INTO agent_version_controls (version_id, creator_id)
       VALUES ($1, $2)`,
      [securityVersionId, ids.creatorId],
    );
    await owner.query(
      `INSERT INTO deployments (id, agent_id, creator_id, environment, desired_version_id)
       VALUES ($1, $2, $3, 'TEST', $4)`,
      [securityDeploymentId, securityAgentId, ids.creatorId, securityVersionId],
    );
    await owner.query(
      `INSERT INTO worker_leases (
         id, deployment_id, creator_id, worker_id, connection_id, fence, expires_at
       ) VALUES ($1, $2, $3, $4, $5, 1, now() + interval '10 minutes')`,
      [securityLeaseId, securityDeploymentId, ids.creatorId, ids.workerId, randomUuidV7()],
    );
    const assignment: TestExecutionAssignment = {
      deploymentId: securityDeploymentId,
      workerId: ids.workerId,
      leaseId: securityLeaseId,
      fence: '1',
    };
    const journal = new PostgresCloudJournal(journalPools);
    const securityConversation = {
      deploymentId: securityDeploymentId,
      agentId: securityAgentId,
      agentVersionId: securityVersionId,
    };

    const replayConversationId = await createConversation(securityConversation);
    const replayAccepted = acceptInput(replayConversationId, {
      agentVersionId: securityVersionId,
    });
    await journal.acceptInvocation(replayAccepted);
    const replayAuthority = await assignRunning(replayAccepted, assignment);
    const replaySuccess = successInput(replayAccepted, replayAuthority);
    const replayCommitted = await journal.commitSuccess(replaySuccess, sealAssistantMessage);

    const firstConversationId = await createConversation(securityConversation);
    const secondConversationId = await createConversation({
      ...securityConversation,
      consumerId: secondConsumerId,
    });
    const firstAccepted = acceptInput(firstConversationId, {
      agentVersionId: securityVersionId,
    });
    const secondAccepted = acceptInput(secondConversationId, {
      consumerId: secondConsumerId,
      agentVersionId: securityVersionId,
    });
    await journal.acceptInvocation(firstAccepted);
    await journal.acceptInvocation(secondAccepted);
    const firstAuthority = await assignRunning(firstAccepted, assignment);
    const secondAuthority = await assignRunning(secondAccepted, assignment);
    const firstSuccess = successInput(firstAccepted, firstAuthority);
    const secondSuccess = successInput(secondAccepted, secondAuthority);

    const broker = await brokerPool.connect();
    try {
      await broker.query('BEGIN');
      await broker.query(`SELECT set_config('app.creator_id', $1, true)`, [randomUuidV7()]);
      await expect(
        broker.query(`SELECT creator_agent_security_revoke_deployment_capabilities($1, $2)`, [
          ids.creatorId,
          securityDeploymentId,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await broker.query('ROLLBACK');

      await broker.query('BEGIN');
      await broker.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await expect(
        broker.query<{ revoked: string }>(
          `SELECT creator_agent_security_revoke_deployment_capabilities($1, $2)::text AS revoked`,
          [ids.creatorId, securityDeploymentId],
        ),
      ).resolves.toMatchObject({ rows: [{ revoked: '2' }] });
      await broker.query('COMMIT');
    } finally {
      await broker.query('ROLLBACK').catch(() => undefined);
      broker.release();
    }

    await expect(
      owner.query(
        `SELECT consumer_subject_id, execution_capability_revoked_at IS NOT NULL AS revoked
           FROM agent_invocations
          WHERE id = ANY($1::uuid[])
          ORDER BY consumer_subject_id`,
        [[firstAccepted.invocationId, secondAccepted.invocationId]],
      ),
    ).resolves.toMatchObject({
      rows: [
        { consumer_subject_id: ids.consumerId, revoked: true },
        { consumer_subject_id: secondConsumerId, revoked: true },
      ].sort((left, right) => left.consumer_subject_id.localeCompare(right.consumer_subject_id)),
    });
    await expect(journal.commitSuccess(firstSuccess, sealAssistantMessage)).rejects.toMatchObject({
      code: 'EXECUTION_AUTHORITY_MISMATCH',
    });
    await expect(journal.commitSuccess(secondSuccess, sealAssistantMessage)).rejects.toMatchObject({
      code: 'EXECUTION_AUTHORITY_MISMATCH',
    });
    await expect(journal.commitSuccess(replaySuccess)).resolves.toEqual({
      ...replayCommitted,
      replayed: true,
    });

    const triggerConversationId = await createConversation(securityConversation);
    const triggerAccepted = acceptInput(triggerConversationId, {
      agentVersionId: securityVersionId,
    });
    await journal.acceptInvocation(triggerAccepted);
    const triggerAuthority = await assignRunning(triggerAccepted, assignment);
    const triggerSuccess = successInput(triggerAccepted, triggerAuthority);

    const racingConversationId = await createConversation(securityConversation);
    const racingAccepted = acceptInput(racingConversationId, {
      agentVersionId: securityVersionId,
    });
    await journal.acceptInvocation(racingAccepted);
    const fenceClient = new Client({ connectionString: databaseUrl });
    await fenceClient.connect();
    try {
      await fenceClient.query('BEGIN');
      await fenceClient.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended('combo.gateway.deployment/v1:' || $1::text || ':' || $2::text, 0)
         )`,
        [ids.creatorId, securityDeploymentId],
      );
      const racingAssignment = assignDispatchPending(racingAccepted, assignment).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      const early = await Promise.race([
        racingAssignment,
        new Promise<{ status: 'blocked' }>((resolve) => {
          setTimeout(() => resolve({ status: 'blocked' }), 100);
        }),
      ]);
      expect(early).toEqual({ status: 'blocked' });

      await fenceClient.query(
        `UPDATE agent_version_controls
            SET severity = 'SECURITY', reason_code = 'SECURITY_PG_GATE', updated_at = now()
          WHERE version_id = $1 AND creator_id = $2`,
        [securityVersionId, ids.creatorId],
      );
      await fenceClient.query('COMMIT');
      const afterFence = await racingAssignment;
      expect(afterFence.status).toBe('rejected');
      if (afterFence.status !== 'rejected') throw new Error('capability issuance crossed SECURITY');
      expect(afterFence.error).toMatchObject({ code: '55000' });
    } finally {
      await fenceClient.query('ROLLBACK').catch(() => undefined);
      await fenceClient.end();
    }
    await expect(
      owner.query(
        `SELECT invocation.execution_capability_revoked_at IS NOT NULL AS capability_revoked,
                lease.state AS lease_state, deployment.observed_state,
                deployment.last_error_code
           FROM agent_invocations AS invocation
           JOIN worker_leases AS lease ON lease.id = invocation.assignment_lease_id
           JOIN agent_conversations AS conversation ON conversation.id = invocation.conversation_id
           JOIN deployments AS deployment ON deployment.id = conversation.deployment_id
          WHERE invocation.id = $1`,
        [triggerAccepted.invocationId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          capability_revoked: true,
          lease_state: 'REVOKED',
          observed_state: 'BLOCKED',
          last_error_code: 'VERSION_SECURITY_REVOKED',
        },
      ],
    });
    await expect(journal.commitSuccess(triggerSuccess, sealAssistantMessage)).rejects.toMatchObject(
      {
        code: 'EXECUTION_AUTHORITY_MISMATCH',
      },
    );
    await expect(
      owner.query(
        `SELECT state, execution_capability_id, execution_capability_digest
           FROM agent_invocations WHERE id = $1`,
        [racingAccepted.invocationId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: 'ACCEPTED',
          execution_capability_id: null,
          execution_capability_digest: null,
        },
      ],
    });
    await expect(journal.commitSuccess(replaySuccess)).resolves.toEqual({
      ...replayCommitted,
      replayed: true,
    });
  });
});
