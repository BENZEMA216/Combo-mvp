import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import {
  CONSUMER_EVENT_OUTBOX_PROTOCOL,
  ConsumerTerminalEventPayloadSchema,
  WORKER_INVOCATION_FACT_PROTOCOL,
  brokerSensitiveMessageAadBytes,
  brokerSensitiveMessageAadDigest,
  brokerSensitiveMessageCipherDigest,
  canonicalSha256,
  consumerEventDedupeKey,
  consumerEventPayloadDigest,
  domainSeparatedHmacSha256,
  workerInvocationFactDigest,
  type BrokerSensitiveMessage,
  type WorkerInvocationFailedFact,
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
  type CommitFailedInput,
  type CommitPreparedInput,
  type CommitStartedInput,
  type CommitSuccessInput,
  type InvocationProjectorTransaction,
  type JournalPool,
  type QueryResult,
} from './cloud-journal.js';
import {
  encryptMessageWithRawKeyForTest as encryptMessage,
  type EncryptedMessage,
  type MessageRole,
} from './message-crypto.js';

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

const BASE_RUNTIME_POLICY = Object.freeze({
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
  resolvedModel: 'gpt-5.6',
  reasoningEffort: 'high',
});

function runtimePolicyJson(
  overrides: Partial<
    Pick<typeof BASE_RUNTIME_POLICY, 'maxConversationTurns' | 'maxVisibleHistoryBytes'>
  > = {},
): string {
  return JSON.stringify({ ...BASE_RUNTIME_POLICY, ...overrides });
}

function account(): string {
  return `creator-${randomUUID()
    .replaceAll(/[^a-z2-7]/gu, 'a')
    .slice(0, 8)
    .padEnd(8, 'a')}`;
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
      versionDigest: string;
      nextTurnNo: number;
    }> = {},
  ): Promise<string> {
    const conversationId = randomUuidV7();
    await owner.query(
      `INSERT INTO agent_conversations (
         id, agent_id, deployment_id, agent_version_id, creator_id,
         consumer_subject_id, idempotency_key, request_digest,
         version_digest, state, assigned_worker_id, next_turn_no, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, gen_uuid_v7(), $7, $8, 'IDLE', $9, $10,
         now() + interval '1 hour'
       )`,
      [
        conversationId,
        options.agentId ?? ids.agentId,
        options.deploymentId ?? ids.deploymentId,
        options.agentVersionId ?? ids.agentVersionId,
        ids.creatorId,
        options.consumerId ?? ids.consumerId,
        digest('c'),
        options.versionDigest ?? digest('7'),
        options.workerId ?? ids.workerId,
        options.nextTurnNo ?? 1,
      ],
    );
    return conversationId;
  }

  async function createPinnedContextVersion(input: {
    maxConversationTurns: number;
    maxVisibleHistoryBytes: number;
    runtimePolicy?: unknown;
  }): Promise<{ id: string; digest: string }> {
    const id = randomUuidV7();
    const versionDigest = randomBytes(32).toString('hex');
    const policy =
      input.runtimePolicy ??
      ({
        ...BASE_RUNTIME_POLICY,
        maxConversationTurns: input.maxConversationTurns,
        maxVisibleHistoryBytes: input.maxVisibleHistoryBytes,
      } as const);
    await owner.query(
      `INSERT INTO agent_versions (
         id, agent_id, creator_id, ordinal, schema_version, version_digest, snapshot_id,
         behavior_contract, behavior_contract_digest, runtime_policy, runtime_policy_digest,
         io_contract, io_contract_digest, model_policy, model_policy_digest,
         codex_runtime_version, codex_runtime_artifact_digest, codex_protocol_schema_digest
       ) VALUES (
         $1, $2, $3,
         (SELECT COALESCE(max(ordinal), 0) + 1 FROM agent_versions WHERE agent_id = $2),
         1, $4, $5,
         '{}'::jsonb, $6, $7::jsonb, $8, '{}'::jsonb, $9, '{}'::jsonb, $10,
         '0.147.0-alpha.6.5', $11, $12
       )`,
      [
        id,
        ids.agentId,
        ids.creatorId,
        versionDigest,
        ids.snapshotId,
        digest('a'),
        JSON.stringify(policy),
        canonicalSha256(policy),
        digest('c'),
        digest('d'),
        `sha256:${digest('e')}`,
        `sha256:${digest('f')}`,
      ],
    );
    return { id, digest: versionDigest };
  }

  function encrypted(
    conversationId: string,
    messageId: string,
    role: MessageRole,
    text: string,
    options: { keyId?: string } = {},
  ) {
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
    });
  }

  function encryptedParametersForTest(message: ReturnType<typeof encrypted>): readonly unknown[] {
    return [
      message.algorithm,
      message.keyId,
      message.nonce,
      message.ciphertext,
      message.authTag,
      message.cipherDigest,
      message.contentDigest,
      message.aadVersion,
    ];
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
      encryptedUserMessage?: EncryptedMessage;
      turnNo?: number;
      consumerId?: string;
      targetWorkerId?: string;
      agentVersionId?: string;
      agentVersionDigest?: string;
      text?: string;
    } = {},
  ): AcceptInvocationInput {
    const userMessageId = randomUuidV7();
    const turnNo = options.turnNo ?? 1;
    return {
      creatorId: ids.creatorId,
      consumerId: options.consumerId ?? ids.consumerId,
      conversationId,
      agentVersionId: options.agentVersionId ?? ids.agentVersionId,
      agentVersionDigest: options.agentVersionDigest ?? digest('7'),
      targetWorkerId: options.targetWorkerId ?? ids.workerId,
      userMessageId,
      invocationId: randomUuidV7(),
      outboxCommandId: randomUuidV7(),
      sourceEventId: randomUuidV7(),
      clientMessageId: options.clientMessageId ?? randomUUID(),
      requestDigest: options.requestDigest ?? hmac('8'),
      turnNo,
      deadlineAt: new Date(Date.now() + 120_000),
      encryptedUserMessage:
        options.encryptedUserMessage ??
        encrypted(
          conversationId,
          userMessageId,
          'USER',
          options.text ?? 'consumer secret',
          options,
        ),
    };
  }

  function userAdmissionParameters(
    input: AcceptInvocationInput,
    encryptedOverride = input.encryptedUserMessage,
  ): unknown[] {
    return [
      input.userMessageId,
      input.conversationId,
      input.creatorId,
      input.consumerId,
      input.agentVersionId,
      input.agentVersionDigest,
      input.targetWorkerId,
      input.turnNo,
      input.deadlineAt,
      input.clientMessageId,
      ...encryptedParametersForTest(encryptedOverride),
      input.invocationId,
    ];
  }

  async function callUserAdmission(
    connection: Pick<PoolClient, 'query'> | Client,
    input: AcceptInvocationInput,
    parameters = userAdmissionParameters(input),
  ) {
    return connection.query<{ admission_outcome: string }>(
      `SELECT admission_outcome
         FROM creator_agent_admit_user_message_v1(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15, $16, $17, $18, $19
         )`,
      parameters,
    );
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
      agentVersionDigest: accepted.agentVersionDigest,
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
    observedSql: string[] = [],
  ): InvocationProjectorTransaction {
    return {
      async query<R = Record<string, unknown>>(
        sql: string,
        parameters?: readonly unknown[],
        signal?: AbortSignal,
      ): Promise<QueryResult<R>> {
        if (signal) observedSignals.push(signal);
        observedSql.push(sql);
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
    await owner.query('BEGIN');
    try {
      const transition = await owner.query<{ reconciliation_started_at: Date }>(
        `UPDATE agent_invocations
            SET state = 'RECONCILING', reconciliation_reason = $2,
                reconciliation_started_at = date_trunc(
                  'milliseconds', clock_timestamp() - interval '301 seconds'
                )
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
      await owner.query('COMMIT');
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }
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
      agentVersionDigest: accepted.agentVersionDigest,
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

  function successPreflightParameters(input: CommitSuccessInput): readonly unknown[] {
    return [
      input.creatorId,
      input.installationId,
      input.fact.protocol,
      input.fact.schemaVersion,
      input.fact.type,
      input.fact.sourceEventId,
      input.fact.invocationId,
      input.fact.agentVersionDigest,
      input.fact.snapshotDigest,
      input.fact.executionCapabilityDigest,
      input.fact.leaseId,
      input.fact.fence,
      input.fact.runtimeThreadId,
      input.fact.runtimeTurnId,
      input.fact.startedFactDigest,
      input.fact.resultDigest,
      input.fact.localResultCipherDigest,
      input.factDigest,
    ];
  }

  function failedInput(
    accepted: AcceptInvocationInput,
    authority: ExecutionAuthority,
    errorCode = 'TURN_FAILED',
  ): CommitFailedInput {
    const fact: WorkerInvocationFailedFact = {
      protocol: WORKER_INVOCATION_FACT_PROTOCOL,
      schemaVersion: 1,
      type: 'invocation.failed',
      sourceEventId: accepted.invocationId,
      invocationId: accepted.invocationId,
      agentVersionDigest: accepted.agentVersionDigest,
      snapshotDigest: digest('1'),
      executionCapabilityDigest: authority.executionCapabilityDigest,
      leaseId: authority.leaseId,
      fence: authority.fence,
      errorCode,
    };
    return {
      creatorId: ids.creatorId,
      installationId: authority.workerId,
      fact,
      factDigest: workerInvocationFactDigest(fact),
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

  async function reconciliationBusinessFootprint(
    invocationId: string,
    conversationId: string,
  ): Promise<unknown> {
    const result = await owner.query<{ footprint: unknown }>(
      `SELECT pg_catalog.jsonb_build_object(
         'invocation', pg_catalog.to_jsonb(invocation),
         'conversation', pg_catalog.to_jsonb(conversation),
         'messages', COALESCE((
           SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(message) ORDER BY message.id)
             FROM agent_messages AS message
            WHERE message.conversation_id = conversation.id
         ), '[]'::jsonb),
         'events', COALESCE((
           SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(event) ORDER BY event.journal_seq)
             FROM agent_invocation_events AS event
            WHERE event.invocation_id = invocation.id
         ), '[]'::jsonb),
         'brokerOutbox', COALESCE((
           SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(command) ORDER BY command.command_id)
             FROM broker_outbox AS command
            WHERE command.invocation_id = invocation.id
         ), '[]'::jsonb),
         'consumerOutbox', COALESCE((
           SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(event) ORDER BY event.cursor)
             FROM consumer_event_outbox AS event
            WHERE event.invocation_id = invocation.id
         ), '[]'::jsonb)
       ) AS footprint
         FROM agent_invocations AS invocation
         JOIN agent_conversations AS conversation
           ON conversation.id = invocation.conversation_id
        WHERE invocation.id = $1 AND conversation.id = $2`,
      [invocationId, conversationId],
    );
    if (result.rows.length !== 1) throw new Error('missing reconciliation footprint');
    return result.rows[0]!.footprint;
  }

  async function reconciliationIntegrityAlerts(invocationId: string) {
    const result = await owner.query<{
      id: string;
      invocation_id: string;
      creator_id: string;
      consumer_subject_id: string;
      reason: string;
      source: string;
      source_event_id_digest: string;
      existing_canonical_digest: string;
      received_canonical_digest: string;
      expected_journal_seq: string | null;
      received_journal_seq: string | null;
      recorded_at: Date;
    }>(
      `SELECT id::text, invocation_id::text, creator_id::text, consumer_subject_id::text,
              reason, source, source_event_id_digest, existing_canonical_digest,
              received_canonical_digest, expected_journal_seq::text,
              received_journal_seq::text, recorded_at
         FROM creator_agent_journal_integrity_alerts
        WHERE invocation_id = $1
        ORDER BY recorded_at, id`,
      [invocationId],
    );
    return result.rows;
  }

  async function successControlFootprint(invocationId: string) {
    const result = await owner.query<{ preflights: string; receipts: string }>(
      `SELECT
         (SELECT count(*)::text FROM creator_agent_success_seal_preflights
           WHERE invocation_id = $1) AS preflights,
         (SELECT count(*)::text FROM creator_agent_succeeded_terminal_receipts
           WHERE invocation_id = $1) AS receipts`,
      [invocationId],
    );
    return result.rows[0]!;
  }

  async function reconciliationCanonicalDigests(input: {
    creatorId: string;
    consumerId: string;
    conversationId: string;
    invocationId: string;
    sourceEventId: string;
    existingReason: string;
    receivedReason: string;
  }) {
    const result = await owner.query<{
      source_identity_digest: string;
      existing_identity_digest: string;
      received_identity_digest: string;
    }>(
      `WITH identities AS (
         SELECT pg_catalog.jsonb_build_object(
                  'domain', 'combo:vnext:journal-source-identity:v1',
                  'protocol', 'combo.creator-agent-reconciliation-source-admission',
                  'version', 2,
                  'creatorId', $1::uuid::text,
                  'consumerId', $2::uuid::text,
                  'conversationId', $3::uuid::text,
                  'invocationId', $4::uuid::text,
                  'source', 'RECONCILER',
                  'logicalSourceEventId', $5::uuid::text
                ) AS source_identity,
                pg_catalog.jsonb_build_object(
                  'domain', 'combo:vnext:journal-event-body:v1',
                  'protocol', 'combo.creator-agent-reconciliation-event',
                  'version', 1,
                  'creatorId', $1::uuid::text,
                  'consumerId', $2::uuid::text,
                  'conversationId', $3::uuid::text,
                  'invocationId', $4::uuid::text,
                  'source', 'RECONCILER',
                  'logicalSourceEventId', $5::uuid::text,
                  'eventType', 'invocation.reconciling',
                  'payload', pg_catalog.jsonb_build_object(
                    'state', 'RECONCILING', 'reason', $6::text
                  )
                ) AS existing_identity,
                pg_catalog.jsonb_build_object(
                  'domain', 'combo:vnext:journal-event-body:v1',
                  'protocol', 'combo.creator-agent-reconciliation-event',
                  'version', 1,
                  'creatorId', $1::uuid::text,
                  'consumerId', $2::uuid::text,
                  'conversationId', $3::uuid::text,
                  'invocationId', $4::uuid::text,
                  'source', 'RECONCILER',
                  'logicalSourceEventId', $5::uuid::text,
                  'eventType', 'invocation.reconciling',
                  'payload', pg_catalog.jsonb_build_object(
                    'state', 'RECONCILING', 'reason', $7::text
                  )
                ) AS received_identity
       )
       SELECT pg_catalog.encode(public.digest(
                pg_catalog.convert_to(source_identity::text, 'UTF8'), 'sha256'
              ), 'hex') AS source_identity_digest,
              pg_catalog.encode(public.digest(
                pg_catalog.convert_to(existing_identity::text, 'UTF8'), 'sha256'
              ), 'hex') AS existing_identity_digest,
              pg_catalog.encode(public.digest(
                pg_catalog.convert_to(received_identity::text, 'UTF8'), 'sha256'
              ), 'hex') AS received_identity_digest
         FROM identities`,
      [
        input.creatorId,
        input.consumerId,
        input.conversationId,
        input.invocationId,
        input.sourceEventId,
        input.existingReason,
        input.receivedReason,
      ],
    );
    if (result.rows.length !== 1) throw new Error('missing reconciliation canonical digests');
    return result.rows[0]!;
  }

  async function seedVisibleHistory(conversationId: string, plaintextBytes: number): Promise<void> {
    if (!Number.isSafeInteger(plaintextBytes) || plaintextBytes < 0 || plaintextBytes > 65_536) {
      throw new Error('invalid visible-history fixture size');
    }
    let remaining = plaintextBytes;
    let turnNo = 1;
    while (remaining > 0) {
      const chunkBytes = Math.min(remaining, 32_768);
      const messageId = randomUuidV7();
      const sealed = encrypted(conversationId, messageId, 'ASSISTANT', 'a'.repeat(chunkBytes));
      await owner.query(
        `INSERT INTO agent_messages (
           id, conversation_id, creator_id, consumer_subject_id, turn_no, role,
           client_message_id, content_algorithm, content_key_id, content_nonce,
           content_ciphertext, content_auth_tag, content_cipher_digest, content_digest,
           content_aad_version, invocation_id
         ) VALUES (
           $1, $2, $3, $4, $5, 'ASSISTANT', NULL,
           $6, $7, $8, $9, $10, $11, $12, $13, NULL
         )`,
        [
          messageId,
          conversationId,
          ids.creatorId,
          ids.consumerId,
          turnNo,
          ...encryptedParametersForTest(sealed),
        ],
      );
      remaining -= chunkBytes;
      turnNo += 1;
    }
  }

  async function contextAdmissionSnapshot(conversationId: string) {
    const result = await owner.query<{
      messages: string;
      invocations: string;
      events: string;
      commands: string;
      consumer_events: string;
      consumer_streams: string;
      visible_history_bytes: string;
      conversation_state: string;
      next_turn_no: number;
      context_limit_reached_at: Date | null;
      last_activity_at: Date;
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
         (SELECT COALESCE(sum(octet_length(content_ciphertext)), 0)
            FROM agent_messages WHERE conversation_id = $1)::text AS visible_history_bytes,
         state AS conversation_state, next_turn_no, context_limit_reached_at, last_activity_at
       FROM agent_conversations WHERE id = $1`,
      [conversationId],
    );
    return result.rows[0]!;
  }

  async function candidateFootprint(input: AcceptInvocationInput) {
    const result = await owner.query<{
      messages: string;
      invocations: string;
      events: string;
      commands: string;
      consumer_events: string;
    }>(
      `SELECT
         (SELECT count(*) FROM agent_messages WHERE id = $1)::text AS messages,
         (SELECT count(*) FROM agent_invocations WHERE id = $2)::text AS invocations,
         (SELECT count(*) FROM agent_invocation_events WHERE invocation_id = $2)::text AS events,
         (SELECT count(*) FROM broker_outbox
           WHERE command_id = $3 OR invocation_id = $2)::text AS commands,
         (SELECT count(*) FROM consumer_event_outbox WHERE invocation_id = $2)::text
           AS consumer_events`,
      [input.userMessageId, input.invocationId, input.outboxCommandId],
    );
    return result.rows[0]!;
  }

  function expectOnlyContextSuspension(
    before: Awaited<ReturnType<typeof contextAdmissionSnapshot>>,
    after: Awaited<ReturnType<typeof contextAdmissionSnapshot>>,
  ): void {
    expect({
      ...after,
      conversation_state: before.conversation_state,
      context_limit_reached_at: before.context_limit_reached_at,
    }).toEqual(before);
    expect(after.conversation_state).toBe('SUSPENDED');
    expect(after.context_limit_reached_at).toBeInstanceOf(Date);
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
      [account(), account()],
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
         '{}'::jsonb, $6, $7::jsonb, $8, '{}'::jsonb, $9, '{}'::jsonb, $10,
         '0.147.0-alpha.6.5', $11, $12
       )`,
      [
        ids.agentVersionId,
        ids.agentId,
        ids.creatorId,
        digest('7'),
        ids.snapshotId,
        digest('a'),
        runtimePolicyJson(),
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

  it('enforces pinned twenty-USER-turn N-1, N, and N+1 admission', async () => {
    const journal = new PostgresCloudJournal(journalPools);
    const conversationId = await createConversation();
    for (let turnNo = 1; turnNo <= 18; turnNo += 1) {
      const input = acceptInput(conversationId, { turnNo, text: 'u' });
      await journal.acceptInvocation(input);
      const authority = await assignRunning(input);
      await journal.commitSuccess(successInput(input, authority), sealAssistantMessage);
    }

    for (const turnNo of [19, 20]) {
      const input = acceptInput(conversationId, { turnNo, text: 'u' });
      await expect(journal.acceptInvocation(input), `real-turn-${turnNo}`).resolves.toMatchObject({
        invocationId: input.invocationId,
        replayed: false,
      });
      await expect(contextAdmissionSnapshot(conversationId)).resolves.toMatchObject({
        messages: String((turnNo - 1) * 2 + 1),
        invocations: String(turnNo),
        conversation_state: 'BUSY',
        next_turn_no: turnNo + 1,
        context_limit_reached_at: null,
      });
      const authority = await assignRunning(input);
      await journal.commitSuccess(successInput(input, authority), sealAssistantMessage);
    }

    const input = acceptInput(conversationId, { turnNo: 21, text: 'u' });
    const before = await contextAdmissionSnapshot(conversationId);
    const beforeClock = await owner.query<{ now: Date }>(`SELECT clock_timestamp() AS now`);
    await expect(journal.acceptInvocation(input)).rejects.toMatchObject<Partial<CloudJournalError>>(
      {
        code: 'CONVERSATION_CONTEXT_LIMIT',
      },
    );
    const afterClock = await owner.query<{ now: Date }>(`SELECT clock_timestamp() AS now`);
    const after = await contextAdmissionSnapshot(conversationId);
    expectOnlyContextSuspension(before, after);
    expect(after.next_turn_no).toBe(21);
    expect(after.context_limit_reached_at!.valueOf()).toBeGreaterThanOrEqual(
      beforeClock.rows[0]!.now.valueOf(),
    );
    expect(after.context_limit_reached_at!.valueOf()).toBeLessThanOrEqual(
      afterClock.rows[0]!.now.valueOf(),
    );
    expect(await candidateFootprint(input)).toEqual({
      messages: '0',
      invocations: '0',
      events: '0',
      commands: '0',
      consumer_events: '0',
    });
  });

  it('enforces pinned 65536 visible UTF-8 bytes at N-1, N, and N+1', async () => {
    const journal = new PostgresCloudJournal(journalPools);
    for (const existingBytes of [65_534, 65_535]) {
      const conversationId = await createConversation();
      await seedVisibleHistory(conversationId, existingBytes);
      const input = acceptInput(conversationId, { text: 'u' });
      await expect(
        journal.acceptInvocation(input),
        `bytes-${existingBytes + 1}`,
      ).resolves.toMatchObject({ invocationId: input.invocationId, replayed: false });
      await expect(contextAdmissionSnapshot(conversationId)).resolves.toMatchObject({
        visible_history_bytes: String(existingBytes + 1),
        conversation_state: 'BUSY',
        next_turn_no: 2,
        context_limit_reached_at: null,
      });
    }

    const conversationId = await createConversation();
    await seedVisibleHistory(conversationId, 65_536);
    const input = acceptInput(conversationId, { text: 'u' });
    const before = await contextAdmissionSnapshot(conversationId);
    await expect(journal.acceptInvocation(input)).rejects.toMatchObject<Partial<CloudJournalError>>(
      {
        code: 'CONVERSATION_CONTEXT_LIMIT',
      },
    );
    const after = await contextAdmissionSnapshot(conversationId);
    expectOnlyContextSuspension(before, after);
    expect(after).toMatchObject({ next_turn_no: 1, visible_history_bytes: '65536' });
    expect(await candidateFootprint(input)).toEqual({
      messages: '0',
      invocations: '0',
      events: '0',
      commands: '0',
      consumer_events: '0',
    });
  });

  it('uses a secondary AgentVersion pinned policy instead of hard-coded global maxima', async () => {
    const version = await createPinnedContextVersion({
      maxConversationTurns: 1,
      maxVisibleHistoryBytes: 64,
    });
    const journal = new PostgresCloudJournal(journalPools);

    const turnConversationId = await createConversation({
      agentVersionId: version.id,
      versionDigest: version.digest,
    });
    const first = acceptInput(turnConversationId, {
      agentVersionId: version.id,
      agentVersionDigest: version.digest,
      turnNo: 1,
      text: 'u',
    });
    await expect(journal.acceptInvocation(first)).resolves.toMatchObject({ replayed: false });
    await owner.query(
      `UPDATE agent_conversations SET state = 'IDLE' WHERE id = $1 AND state = 'BUSY'`,
      [turnConversationId],
    );
    const second = acceptInput(turnConversationId, {
      agentVersionId: version.id,
      agentVersionDigest: version.digest,
      turnNo: 2,
      text: 'u',
    });
    await expect(journal.acceptInvocation(second)).rejects.toMatchObject({
      code: 'CONVERSATION_CONTEXT_LIMIT',
    });
    expect(await candidateFootprint(second)).toEqual({
      messages: '0',
      invocations: '0',
      events: '0',
      commands: '0',
      consumer_events: '0',
    });

    const byteConversationId = await createConversation({
      agentVersionId: version.id,
      versionDigest: version.digest,
    });
    await seedVisibleHistory(byteConversationId, 64);
    const byteCandidate = acceptInput(byteConversationId, {
      agentVersionId: version.id,
      agentVersionDigest: version.digest,
      text: 'u',
    });
    await expect(journal.acceptInvocation(byteCandidate)).rejects.toMatchObject({
      code: 'CONVERSATION_CONTEXT_LIMIT',
    });
    expect(await candidateFootprint(byteCandidate)).toEqual({
      messages: '0',
      invocations: '0',
      events: '0',
      commands: '0',
      consumer_events: '0',
    });
  });

  it('rejects a pinned policy whose numeric limits are JSON strings', async () => {
    const invalidPolicy = {
      ...BASE_RUNTIME_POLICY,
      maxConversationTurns: '20',
      maxVisibleHistoryBytes: '65536',
    };
    const version = await createPinnedContextVersion({
      maxConversationTurns: 20,
      maxVisibleHistoryBytes: 65_536,
      runtimePolicy: invalidPolicy,
    });
    const conversationId = await createConversation({
      agentVersionId: version.id,
      versionDigest: version.digest,
    });
    const input = acceptInput(conversationId, {
      agentVersionId: version.id,
      agentVersionDigest: version.digest,
      text: 'u',
    });
    const before = await contextAdmissionSnapshot(conversationId);
    await expect(
      new PostgresCloudJournal(journalPools).acceptInvocation(input),
    ).rejects.toMatchObject({
      code: '23514',
      message: 'pinned AgentVersion context policy is invalid',
    });
    expect(await contextAdmissionSnapshot(conversationId)).toEqual(before);
    expect(await candidateFootprint(input)).toEqual({
      messages: '0',
      invocations: '0',
      events: '0',
      commands: '0',
      consumer_events: '0',
    });
  });

  it('serializes ten distinct N+1 candidates to one monotonic suspension with zero facts', async () => {
    const conversationId = await createConversation();
    await seedVisibleHistory(conversationId, 65_536);
    const before = await contextAdmissionSnapshot(conversationId);
    const inputs = Array.from({ length: 10 }, () => acceptInput(conversationId, { text: 'u' }));
    const results = await Promise.allSettled(
      inputs.map((input) => new PostgresCloudJournal(journalPools).acceptInvocation(input)),
    );
    expect(results).toHaveLength(10);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'fulfilled') throw new Error('context N+1 unexpectedly committed');
      expect(result.reason).toMatchObject({ code: 'CONVERSATION_CONTEXT_LIMIT' });
    }
    const after = await contextAdmissionSnapshot(conversationId);
    expectOnlyContextSuspension(before, after);
    for (const input of inputs) {
      expect(await candidateFootprint(input)).toEqual({
        messages: '0',
        invocations: '0',
        events: '0',
        commands: '0',
        consumer_events: '0',
      });
    }
  });

  it('fails closed on BUSY, wrong-turn, and corrupted next-turn projections', async () => {
    const journal = new PostgresCloudJournal(journalPools);

    const wrongTurnConversation = await createConversation();
    const wrongTurn = acceptInput(wrongTurnConversation, { turnNo: 2, text: 'u' });
    const wrongTurnBefore = await contextAdmissionSnapshot(wrongTurnConversation);
    await expect(journal.acceptInvocation(wrongTurn)).rejects.toMatchObject({
      code: 'CONVERSATION_UNAVAILABLE',
    });
    expect(await contextAdmissionSnapshot(wrongTurnConversation)).toEqual(wrongTurnBefore);
    expect(await candidateFootprint(wrongTurn)).toEqual({
      messages: '0',
      invocations: '0',
      events: '0',
      commands: '0',
      consumer_events: '0',
    });

    const busyConversation = await createConversation();
    const first = acceptInput(busyConversation, { turnNo: 1, text: 'u' });
    await journal.acceptInvocation(first);
    const busyCandidate = acceptInput(busyConversation, { turnNo: 2, text: 'u' });
    const busyBefore = await contextAdmissionSnapshot(busyConversation);
    await expect(journal.acceptInvocation(busyCandidate)).rejects.toMatchObject({
      code: 'CONVERSATION_UNAVAILABLE',
    });
    expect(await contextAdmissionSnapshot(busyConversation)).toEqual(busyBefore);
    expect(await candidateFootprint(busyCandidate)).toEqual({
      messages: '0',
      invocations: '0',
      events: '0',
      commands: '0',
      consumer_events: '0',
    });

    const corruptedConversation = await createConversation();
    await owner.query(`UPDATE agent_conversations SET next_turn_no = 2 WHERE id = $1`, [
      corruptedConversation,
    ]);
    const corrupted = acceptInput(corruptedConversation, { turnNo: 2, text: 'u' });
    const corruptedBefore = await contextAdmissionSnapshot(corruptedConversation);
    await expect(journal.acceptInvocation(corrupted)).rejects.toMatchObject({ code: '55000' });
    expect(await contextAdmissionSnapshot(corruptedConversation)).toEqual(corruptedBefore);
    expect(await candidateFootprint(corrupted)).toEqual({
      messages: '0',
      invocations: '0',
      events: '0',
      commands: '0',
      consumer_events: '0',
    });

    const gappedConversation = await createConversation({ nextTurnNo: 3 });
    for (const turnNo of [1, 3]) {
      const messageId = randomUuidV7();
      const sealed = encrypted(gappedConversation, messageId, 'USER', 'u');
      await owner.query(
        `INSERT INTO agent_messages (
           id, conversation_id, creator_id, consumer_subject_id, turn_no, role,
           client_message_id, content_algorithm, content_key_id, content_nonce,
           content_ciphertext, content_auth_tag, content_cipher_digest, content_digest,
           content_aad_version, invocation_id
         ) VALUES (
           $1, $2, $3, $4, $5, 'USER', $6,
           $7, $8, $9, $10, $11, $12, $13, $14, NULL
         )`,
        [
          messageId,
          gappedConversation,
          ids.creatorId,
          ids.consumerId,
          turnNo,
          randomUuidV7(),
          ...encryptedParametersForTest(sealed),
        ],
      );
    }
    const gapped = acceptInput(gappedConversation, { turnNo: 3, text: 'u' });
    const gappedBefore = await contextAdmissionSnapshot(gappedConversation);
    await expect(journal.acceptInvocation(gapped)).rejects.toMatchObject({ code: '55000' });
    expect(await contextAdmissionSnapshot(gappedConversation)).toEqual(gappedBefore);
    expect(await candidateFootprint(gapped)).toEqual({
      messages: '0',
      invocations: '0',
      events: '0',
      commands: '0',
      consumer_events: '0',
    });
  });

  it('rejects malformed or stale direct-function candidates before a full Conversation can suspend', async () => {
    const conversationId = await createConversation();
    await seedVisibleHistory(conversationId, 65_536);
    const input = acceptInput(conversationId, { text: 'u' });
    const base = userAdmissionParameters(input);
    const wrongCipherDigest =
      input.encryptedUserMessage.cipherDigest === digest('f') ? digest('e') : digest('f');
    expect(wrongCipherDigest).not.toBe(input.encryptedUserMessage.cipherDigest);
    const mutate = (index: number, value: unknown): unknown[] => {
      const candidate = [...base];
      candidate[index] = value;
      return candidate;
    };
    const cases: Array<{ id: string; parameters: unknown[]; code: string }> = [
      { id: 'null-message-id', parameters: mutate(0, null), code: '23514' },
      { id: 'turn-zero', parameters: mutate(7, 0), code: '23514' },
      { id: 'turn-twenty-two', parameters: mutate(7, 22), code: '23514' },
      { id: 'future-algorithm', parameters: mutate(10, 'future-aead/v2'), code: '23514' },
      { id: 'bad-key-id', parameters: mutate(11, 'bad key id'), code: '23514' },
      { id: 'bad-nonce', parameters: mutate(12, Buffer.alloc(11)), code: '23514' },
      { id: 'oversized-cipher', parameters: mutate(13, Buffer.alloc(65_537)), code: '23514' },
      { id: 'bad-tag', parameters: mutate(14, Buffer.alloc(15)), code: '23514' },
      { id: 'bad-cipher-digest', parameters: mutate(15, 'bad'), code: '23514' },
      { id: 'wrong-cipher-digest', parameters: mutate(15, wrongCipherDigest), code: '23514' },
      { id: 'bad-content-digest', parameters: mutate(16, 'bad'), code: '23514' },
      { id: 'bad-aad-version', parameters: mutate(17, 2), code: '23514' },
      { id: 'wrong-version', parameters: mutate(4, randomUuidV7()), code: '55000' },
      { id: 'wrong-version-digest', parameters: mutate(5, digest('6')), code: '55000' },
      { id: 'wrong-worker', parameters: mutate(6, randomUuidV7()), code: '55000' },
      {
        id: 'expired-deadline',
        parameters: mutate(8, new Date(Date.now() - 1_000)),
        code: '55000',
      },
      {
        id: 'deadline-over-120s',
        parameters: mutate(8, new Date(Date.now() + 130_000)),
        code: '55000',
      },
    ];
    const before = await contextAdmissionSnapshot(conversationId);
    for (const testCase of cases) {
      const api = await apiPool.connect();
      try {
        await api.query('BEGIN');
        await api.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
        await api.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumerId]);
        await expect(
          callUserAdmission(api, input, testCase.parameters),
          testCase.id,
        ).rejects.toMatchObject({ code: testCase.code });
      } finally {
        await api.query('ROLLBACK').catch(() => undefined);
        api.release();
      }
      expect(await contextAdmissionSnapshot(conversationId), testCase.id).toEqual(before);
      expect(await candidateFootprint(input), testCase.id).toEqual({
        messages: '0',
        invocations: '0',
        events: '0',
        commands: '0',
        consumer_events: '0',
      });
    }
  });

  it('fails closed if durable visible history contains a future content algorithm', async () => {
    const conversationId = await createConversation();
    await seedVisibleHistory(conversationId, 1);
    const input = acceptInput(conversationId, { text: 'u' });
    const before = await contextAdmissionSnapshot(conversationId);
    const constraint = await owner.query<{ conname: string }>(
      `SELECT conname
         FROM pg_catalog.pg_constraint
        WHERE conrelid = 'agent_messages'::regclass
          AND contype = 'c'
          AND pg_catalog.pg_get_constraintdef(oid) LIKE '%content_algorithm%'
        ORDER BY conname`,
    );
    expect(constraint.rows).toHaveLength(1);
    const constraintName = constraint.rows[0]!.conname;
    await owner.query(`ALTER TABLE agent_messages DROP CONSTRAINT "${constraintName}"`);
    try {
      await owner.query(`ALTER TABLE agent_messages DISABLE TRIGGER agent_messages_immutable`);
      try {
        await owner.query(
          `UPDATE agent_messages SET content_algorithm = 'future-aead/v2'
            WHERE conversation_id = $1`,
          [conversationId],
        );
      } finally {
        await owner.query(`ALTER TABLE agent_messages ENABLE TRIGGER agent_messages_immutable`);
      }
      await expect(
        new PostgresCloudJournal(journalPools).acceptInvocation(input),
      ).rejects.toMatchObject({
        code: '23514',
        message: 'visible history contains an unsupported content algorithm',
      });
      const rejected = await contextAdmissionSnapshot(conversationId);
      expect(rejected).toMatchObject({
        ...before,
        context_limit_reached_at: null,
        conversation_state: 'IDLE',
      });
      expect(await candidateFootprint(input)).toEqual({
        messages: '0',
        invocations: '0',
        events: '0',
        commands: '0',
        consumer_events: '0',
      });
    } finally {
      await owner.query(`ALTER TABLE agent_messages DISABLE TRIGGER agent_messages_immutable`);
      try {
        await owner.query(
          `UPDATE agent_messages SET content_algorithm = 'aes-256-gcm/v1'
            WHERE conversation_id = $1`,
          [conversationId],
        );
      } finally {
        await owner.query(`ALTER TABLE agent_messages ENABLE TRIGGER agent_messages_immutable`);
      }
      await owner.query(
        `ALTER TABLE agent_messages
           ADD CONSTRAINT "${constraintName}"
           CHECK (content_algorithm = 'aes-256-gcm/v1')`,
      );
    }
  });

  it('rechecks the Cloud deadline after waiting on the Conversation row lock', async () => {
    const conversationId = await createConversation();
    const input = acceptInput(conversationId, { text: 'u' });
    input.deadlineAt = new Date(Date.now() + 1_000);
    const before = await contextAdmissionSnapshot(conversationId);
    const locker = new Client({ connectionString: databaseUrl });
    const api = await apiPool.connect();
    await locker.connect();
    try {
      await locker.query('BEGIN');
      await locker.query(`SELECT id FROM agent_conversations WHERE id = $1 FOR UPDATE`, [
        conversationId,
      ]);
      await api.query('BEGIN');
      await api.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await api.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumerId]);
      const pending = callUserAdmission(api, input).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      const early = await Promise.race([
        pending,
        new Promise<{ status: 'blocked' }>((resolve) => {
          setTimeout(() => resolve({ status: 'blocked' }), 100);
        }),
      ]);
      expect(early).toEqual({ status: 'blocked' });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1_100);
      });
      await locker.query('COMMIT');
      const result = await pending;
      expect(result.status).toBe('rejected');
      if (result.status === 'fulfilled') throw new Error('expired lock waiter was admitted');
      expect(result.error).toMatchObject({ code: '55000' });
    } finally {
      await locker.query('ROLLBACK').catch(() => undefined);
      await api.query('ROLLBACK').catch(() => undefined);
      api.release();
      await locker.end();
    }
    expect(await contextAdmissionSnapshot(conversationId)).toEqual(before);
    expect(await candidateFootprint(input)).toEqual({
      messages: '0',
      invocations: '0',
      events: '0',
      commands: '0',
      consumer_events: '0',
    });
  });

  it('keeps an exact accepted replay ahead of a later context-limit suspension', async () => {
    const conversationId = await createConversation();
    const journal = new PostgresCloudJournal(journalPools);
    const accepted = acceptInput(conversationId, { text: 'first' });
    const first = await journal.acceptInvocation(accepted);
    await owner.query(
      `UPDATE agent_conversations SET state = 'IDLE' WHERE id = $1 AND state = 'BUSY'`,
      [conversationId],
    );
    await seedVisibleHistory(conversationId, 65_536 - Buffer.byteLength('first', 'utf8'));
    const rejected = acceptInput(conversationId, { turnNo: 2, text: 'u' });
    await expect(journal.acceptInvocation(rejected)).rejects.toMatchObject({
      code: 'CONVERSATION_CONTEXT_LIMIT',
    });
    const marker = (await contextAdmissionSnapshot(conversationId)).context_limit_reached_at;
    const wrongAuthority = acceptInput(conversationId, {
      agentVersionId: randomUuidV7(),
      turnNo: 2,
      text: 'u',
    });
    await expect(journal.acceptInvocation(wrongAuthority)).rejects.toMatchObject({
      code: 'CONVERSATION_UNAVAILABLE',
    });
    expect((await contextAdmissionSnapshot(conversationId)).context_limit_reached_at).toEqual(
      marker,
    );
    expect(await candidateFootprint(wrongAuthority)).toEqual({
      messages: '0',
      invocations: '0',
      events: '0',
      commands: '0',
      consumer_events: '0',
    });
    await expect(journal.acceptInvocation(accepted)).resolves.toEqual({
      ...first,
      replayed: true,
    });
    expect((await contextAdmissionSnapshot(conversationId)).context_limit_reached_at).toEqual(
      marker,
    );
    expect(await candidateFootprint(rejected)).toEqual({
      messages: '0',
      invocations: '0',
      events: '0',
      commands: '0',
      consumer_events: '0',
    });
  });

  it('rolls a context marker back at the failpoint and commits it before the stable retry error', async () => {
    const conversationId = await createConversation();
    await seedVisibleHistory(conversationId, 65_536);
    const input = acceptInput(conversationId, { text: 'u' });
    const before = await contextAdmissionSnapshot(conversationId);
    const failing = new PostgresCloudJournal(journalPools, (step) => {
      if (step === 'CONVERSATION_CONTEXT_LIMIT') throw new Error('FAILPOINT:CONTEXT_LIMIT');
    });
    await expect(failing.acceptInvocation(input)).rejects.toThrow('FAILPOINT:CONTEXT_LIMIT');
    expect(await contextAdmissionSnapshot(conversationId)).toEqual(before);
    expect(await candidateFootprint(input)).toEqual({
      messages: '0',
      invocations: '0',
      events: '0',
      commands: '0',
      consumer_events: '0',
    });

    await expect(
      new PostgresCloudJournal(journalPools).acceptInvocation(input),
    ).rejects.toMatchObject({ code: 'CONVERSATION_CONTEXT_LIMIT' });
    expectOnlyContextSuspension(before, await contextAdmissionSnapshot(conversationId));
    expect(await candidateFootprint(input)).toEqual({
      messages: '0',
      invocations: '0',
      events: '0',
      commands: '0',
      consumer_events: '0',
    });
  });

  it('replays the same context-limit candidate after its original deadline expires', async () => {
    const conversationId = await createConversation();
    await seedVisibleHistory(conversationId, 65_536);
    const input = acceptInput(conversationId, { text: 'u' });
    input.deadlineAt = new Date(Date.now() + 1_000);
    const journal = new PostgresCloudJournal(journalPools);
    await expect(journal.acceptInvocation(input)).rejects.toMatchObject({
      code: 'CONVERSATION_CONTEXT_LIMIT',
    });
    const marker = (await contextAdmissionSnapshot(conversationId)).context_limit_reached_at;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1_100);
    });
    expect(input.deadlineAt.valueOf()).toBeLessThan(Date.now());
    await expect(journal.acceptInvocation(input)).rejects.toMatchObject({
      code: 'CONVERSATION_CONTEXT_LIMIT',
    });
    expect((await contextAdmissionSnapshot(conversationId)).context_limit_reached_at).toEqual(
      marker,
    );
    expect(await candidateFootprint(input)).toEqual({
      messages: '0',
      invocations: '0',
      events: '0',
      commands: '0',
      consumer_events: '0',
    });
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
        conversation_state_update: boolean;
        conversation_next_turn_update: boolean;
        context_marker_update: boolean;
        admission_execute: boolean;
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
             AS message_role_insert,
           has_column_privilege(current_user, 'agent_conversations', 'state', 'UPDATE')
             AS conversation_state_update,
           has_column_privilege(current_user, 'agent_conversations', 'next_turn_no', 'UPDATE')
             AS conversation_next_turn_update,
           has_column_privilege(
             current_user,
             'agent_conversations',
             'context_limit_reached_at',
             'UPDATE'
           ) AS context_marker_update,
           has_function_privilege(
             current_user,
             'creator_agent_admit_user_message_v1(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,timestamptz,text,text,text,bytea,bytea,bytea,text,text,integer,uuid)',
             'EXECUTE'
           ) AS admission_execute`,
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
          message_role_insert: false,
          conversation_state_update: false,
          conversation_next_turn_update: false,
          context_marker_update: false,
          admission_execute: true,
        },
      ],
    });

    const messageInsertColumns = [
      'id',
      'conversation_id',
      'creator_id',
      'consumer_subject_id',
      'turn_no',
      'role',
      'client_message_id',
      'content_algorithm',
      'content_key_id',
      'content_nonce',
      'content_ciphertext',
      'content_auth_tag',
      'content_cipher_digest',
      'content_digest',
      'content_aad_version',
      'invocation_id',
    ];
    await expect(
      apiPool.query<{ column_name: string; allowed: boolean }>(
        `SELECT column_name,
                has_column_privilege(current_user, 'agent_messages', column_name, 'INSERT')
                  AS allowed
           FROM unnest($1::text[]) AS column_name
          ORDER BY column_name`,
        [messageInsertColumns],
      ),
    ).resolves.toMatchObject({
      rows: [...messageInsertColumns]
        .sort()
        .map((column_name) => ({ column_name, allowed: false })),
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

  it('accepts only exact API and real API-member logins while denying direct DML and ambiguous roles', async () => {
    const memberRole = `combo_context_api_${randomUUID().replaceAll('-', '')}`;
    const dualRole = `combo_context_dual_${randomUUID().replaceAll('-', '')}`;
    const memberPassword = `Api${randomUUID().replaceAll('-', '')}9x`;
    const dualPassword = `Dual${randomUUID().replaceAll('-', '')}9x`;
    const roleClient = (role: string, password: string) => {
      const url = new URL(databaseUrl!);
      url.username = role;
      url.password = password;
      return new Client({ connectionString: url.toString() });
    };
    await owner.query(
      `CREATE ROLE "${memberRole}"
         LOGIN PASSWORD '${memberPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE
         NOINHERIT NOREPLICATION NOBYPASSRLS`,
    );
    await owner.query(`GRANT combo_agent_api TO "${memberRole}"`);
    await owner.query(
      `CREATE ROLE "${dualRole}"
         LOGIN PASSWORD '${dualPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE
         NOINHERIT NOREPLICATION NOBYPASSRLS`,
    );
    await owner.query(`GRANT combo_agent_api, combo_agent_broker TO "${dualRole}"`);

    const member = roleClient(memberRole, memberPassword);
    const dual = roleClient(dualRole, dualPassword);
    try {
      await member.connect();
      await dual.connect();

      const conversationId = await createConversation();
      await seedVisibleHistory(conversationId, 65_536);
      const input = acceptInput(conversationId, { text: 'u' });

      await member.query('SET ROLE combo_agent_api');
      await expect(
        member.query<{
          message_insert: boolean;
          marker_update: boolean;
          state_update: boolean;
          admission_execute: boolean;
        }>(
          `SELECT
             has_column_privilege(current_user, 'agent_messages', 'id', 'INSERT')
               AS message_insert,
             has_column_privilege(
               current_user,
               'agent_conversations',
               'context_limit_reached_at',
               'UPDATE'
             ) AS marker_update,
             has_column_privilege(current_user, 'agent_conversations', 'state', 'UPDATE')
               AS state_update,
             has_function_privilege(
               current_user,
               'creator_agent_admit_user_message_v1(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,timestamptz,text,text,text,bytea,bytea,bytea,text,text,integer,uuid)',
               'EXECUTE'
             ) AS admission_execute`,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            message_insert: false,
            marker_update: false,
            state_update: false,
            admission_execute: true,
          },
        ],
      });

      await member.query('BEGIN');
      await member.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await member.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumerId]);
      await expect(
        member.query(
          `UPDATE agent_conversations
              SET state = 'SUSPENDED', context_limit_reached_at = clock_timestamp()
            WHERE id = $1`,
          [conversationId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await member.query('ROLLBACK');

      await member.query('BEGIN');
      await member.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await member.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumerId]);
      await expect(
        member.query(
          `INSERT INTO agent_messages (
             id, conversation_id, creator_id, consumer_subject_id, turn_no, role,
             client_message_id, content_algorithm, content_key_id, content_nonce,
             content_ciphertext, content_auth_tag, content_cipher_digest, content_digest,
             content_aad_version, invocation_id
           ) VALUES (
             $1, $2, $3, $4, $5, 'USER', $6,
             $7, $8, $9, $10, $11, $12, $13, $14, $15
           )`,
          [
            input.userMessageId,
            input.conversationId,
            input.creatorId,
            input.consumerId,
            input.turnNo,
            input.clientMessageId,
            ...encryptedParametersForTest(input.encryptedUserMessage),
            input.invocationId,
          ],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await member.query('ROLLBACK');

      await member.query('BEGIN');
      await member.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await member.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumerId]);
      input.deadlineAt = new Date(Date.now() + 1_000);
      await expect(callUserAdmission(member, input)).resolves.toMatchObject({
        rows: [{ admission_outcome: 'CONTEXT_LIMIT' }],
      });
      await member.query('COMMIT');
      const committedMarker = (await contextAdmissionSnapshot(conversationId))
        .context_limit_reached_at;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1_100);
      });
      await member.query('BEGIN');
      await member.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await member.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumerId]);
      await expect(callUserAdmission(member, input)).resolves.toMatchObject({
        rows: [{ admission_outcome: 'CONTEXT_LIMIT' }],
      });
      await member.query('COMMIT');
      expect((await contextAdmissionSnapshot(conversationId)).context_limit_reached_at).toEqual(
        committedMarker,
      );
      expect((await contextAdmissionSnapshot(conversationId)).conversation_state).toBe('SUSPENDED');
      expect(await candidateFootprint(input)).toEqual({
        messages: '0',
        invocations: '0',
        events: '0',
        commands: '0',
        consumer_events: '0',
      });

      const deniedConversation = await createConversation();
      const denied = acceptInput(deniedConversation, { text: 'u' });
      await dual.query('SET ROLE combo_agent_api');
      await dual.query('BEGIN');
      await dual.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await dual.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumerId]);
      await expect(callUserAdmission(dual, denied)).rejects.toMatchObject({
        code: '42501',
        message: 'USER Message admission authority is ambiguous',
      });
      await dual.query('ROLLBACK');

      const broker = await brokerPool.connect();
      try {
        await broker.query('BEGIN');
        await broker.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
        await broker.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumerId]);
        await expect(callUserAdmission(broker, denied)).rejects.toMatchObject({ code: '42501' });
        await broker.query('ROLLBACK');
      } finally {
        await broker.query('ROLLBACK').catch(() => undefined);
        broker.release();
      }
      await owner.query(`SELECT set_config('app.creator_id', $1, false)`, [ids.creatorId]);
      await owner.query(`SELECT set_config('app.consumer_id', $1, false)`, [ids.consumerId]);
      await expect(callUserAdmission(owner, denied)).rejects.toMatchObject({ code: '42501' });
      expect(await contextAdmissionSnapshot(deniedConversation)).toMatchObject({
        conversation_state: 'IDLE',
        context_limit_reached_at: null,
      });
    } finally {
      await member.end().catch(() => undefined);
      await dual.end().catch(() => undefined);
      await owner.query(`REVOKE combo_agent_api FROM "${memberRole}"`).catch(() => undefined);
      await owner
        .query(`REVOKE combo_agent_api, combo_agent_broker FROM "${dualRole}"`)
        .catch(() => undefined);
      await owner.query(`DROP ROLE IF EXISTS "${memberRole}"`).catch(() => undefined);
      await owner.query(`DROP ROLE IF EXISTS "${dualRole}"`).catch(() => undefined);
    }
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
      await expect(callUserAdmission(orphanApi, orphan)).resolves.toMatchObject({
        rows: [{ admission_outcome: 'ADMITTED' }],
      });
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
          'enforce_creator_agent_event_sequence()'::regprocedure,
          'creator_agent_admit_user_message_v1(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,timestamptz,text,text,text,bytea,bytea,bytea,text,text,integer,uuid)'::regprocedure
        ])
        ORDER BY procedure.proname`,
    );
    expect(authorities.rows).toHaveLength(5);
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

  it('atomically decides started authority before post-admission failpoints run', async () => {
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
      state: 'RUNNING',
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
                  event.payload, event.source_fact_digest,
                  (SELECT count(*) FROM agent_invocation_events AS root
                    WHERE root.invocation_id = invocation.id
                      AND root.event_type = 'invocation.reconciling')::text AS root_events
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
          state: 'RUNNING',
          reconciliation_reason: null,
          runtime_thread_id: started.fact.runtimeThreadId,
          runtime_turn_id: started.fact.runtimeTurnId,
          start_state: 'ACKED',
          payload: { state: 'RUNNING' },
          source_fact_digest: started.factDigest,
          root_events: '0',
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
    const preparedBeforeConflict = await reconciliationBusinessFootprint(
      accepted.invocationId,
      conversationId,
    );
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
    ).rejects.toMatchObject<Partial<CloudJournalError>>({
      code: 'JOURNAL_SECURITY_BLOCKED',
      message: 'JOURNAL_SECURITY_BLOCKED',
    });
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      preparedBeforeConflict,
    );
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toMatchObject([
      { reason: 'SOURCE_EVENT_CONFLICT', source: 'WORKER' },
    ]);

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

  it('matches the PostgreSQL prepared-fact JCS helper to workerInvocationFactDigest', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    await new PostgresCloudJournal(journalPools).acceptInvocation(accepted);
    const authority = await assignDispatchPending(accepted);
    const prepared = preparedInput(accepted, authority);
    const databaseDigest = await owner.query<{ fact_digest: string }>(
      `SELECT creator_agent_worker_prepared_fact_digest_v1(
         $1, $2, $3, $4, $5, $6, $7, $8, $9
       ) AS fact_digest`,
      [
        prepared.fact.sourceEventId,
        prepared.fact.invocationId,
        prepared.fact.agentVersionDigest,
        prepared.fact.snapshotDigest,
        prepared.fact.executionCapabilityDigest,
        prepared.fact.leaseId,
        prepared.fact.fence,
        prepared.fact.requestDigest,
        prepared.fact.prepareCommandId,
      ],
    );
    expect(databaseDigest.rows).toEqual([{ fact_digest: prepared.factDigest }]);

    const goldenFact: WorkerInvocationPreparedFact = {
      protocol: WORKER_INVOCATION_FACT_PROTOCOL,
      schemaVersion: 1,
      type: 'invocation.prepared',
      sourceEventId: '0198f00d-5000-7000-8000-000000000014',
      invocationId: '0198f00d-5000-7000-8000-000000000013',
      agentVersionDigest: digest('a'),
      snapshotDigest: digest('b'),
      executionCapabilityDigest: digest('c'),
      leaseId: '0198f00d-5000-7000-8000-000000000015',
      fence: '7',
      requestDigest: hmac('d'),
      prepareCommandId: '0198f00d-5000-7000-8000-000000000014',
    };
    const golden = '4bfcb4a52338b8b786ff28a488bc6dd45f408092533f5d08b9f17e50da31405c';
    expect(workerInvocationFactDigest(goldenFact)).toBe(golden);
    await expect(
      owner.query<{ fact_digest: string }>(
        `SELECT creator_agent_worker_prepared_fact_digest_v1(
           $1, $2, $3, $4, $5, $6, $7, $8, $9
         ) AS fact_digest`,
        [
          goldenFact.sourceEventId,
          goldenFact.invocationId,
          goldenFact.agentVersionDigest,
          goldenFact.snapshotDigest,
          goldenFact.executionCapabilityDigest,
          goldenFact.leaseId,
          goldenFact.fence,
          goldenFact.requestDigest,
          goldenFact.prepareCommandId,
        ],
      ),
    ).resolves.toMatchObject({ rows: [{ fact_digest: golden }] });
  });

  it('matches the PostgreSQL started-fact JCS helper to workerInvocationFactDigest', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignDispatchPending(accepted);
    const prepared = preparedInput(accepted, authority);
    const committedPrepared = await journal.commitPrepared(prepared);
    if (!committedPrepared.startCommandId) throw new Error('expected start command');
    const started = startedInput(prepared, committedPrepared.startCommandId);
    const databaseDigest = await owner.query<{ fact_digest: string }>(
      `SELECT creator_agent_worker_started_fact_digest_v1(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
       ) AS fact_digest`,
      [
        started.fact.sourceEventId,
        started.fact.invocationId,
        started.fact.agentVersionDigest,
        started.fact.snapshotDigest,
        started.fact.executionCapabilityDigest,
        started.fact.leaseId,
        started.fact.fence,
        started.fact.startCommandId,
        started.fact.runtimeThreadId,
        started.fact.runtimeTurnId,
        started.fact.dispatchReceiptDigest,
        started.fact.sandboxAttestationDigest,
      ],
    );
    expect(databaseDigest.rows).toEqual([{ fact_digest: started.factDigest }]);

    const goldenFact: WorkerInvocationStartedFact = {
      protocol: WORKER_INVOCATION_FACT_PROTOCOL,
      schemaVersion: 1,
      type: 'invocation.started',
      sourceEventId: '0198f00d-5000-7000-8000-000000000016',
      invocationId: '0198f00d-5000-7000-8000-000000000013',
      agentVersionDigest: digest('a'),
      snapshotDigest: digest('b'),
      executionCapabilityDigest: digest('c'),
      leaseId: '0198f00d-5000-7000-8000-000000000015',
      fence: '7',
      startCommandId: '0198f00d-5000-7000-8000-000000000016',
      runtimeThreadId: 'thread-golden',
      runtimeTurnId: 'turn-golden',
      dispatchReceiptDigest: `sha256:${digest('d')}`,
      sandboxAttestationDigest: `sha256:${digest('e')}`,
    };
    const golden = '55355cc2101293379d320db25c1e02961778c7b1341ccfb21a1176c475931836';
    expect(workerInvocationFactDigest(goldenFact)).toBe(golden);
    await expect(
      owner.query<{ fact_digest: string }>(
        `SELECT creator_agent_worker_started_fact_digest_v1(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
         ) AS fact_digest`,
        [
          goldenFact.sourceEventId,
          goldenFact.invocationId,
          goldenFact.agentVersionDigest,
          goldenFact.snapshotDigest,
          goldenFact.executionCapabilityDigest,
          goldenFact.leaseId,
          goldenFact.fence,
          goldenFact.startCommandId,
          goldenFact.runtimeThreadId,
          goldenFact.runtimeTurnId,
          goldenFact.dispatchReceiptDigest,
          goldenFact.sandboxAttestationDigest,
        ],
      ),
    ).resolves.toMatchObject({ rows: [{ fact_digest: golden }] });
  });

  it('security-blocks every mutable prepared body field and dedupes concurrent repeats', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignDispatchPending(accepted);
    const prepared = preparedInput(accepted, authority);
    await journal.commitPrepared(prepared);
    const before = await reconciliationBusinessFootprint(accepted.invocationId, conversationId);
    const mutatedFacts: WorkerInvocationPreparedFact[] = [
      { ...prepared.fact, agentVersionDigest: digest('2') },
      { ...prepared.fact, snapshotDigest: digest('3') },
      { ...prepared.fact, executionCapabilityDigest: digest('6') },
      { ...prepared.fact, leaseId: randomUuidV7() },
      { ...prepared.fact, fence: '2' },
      { ...prepared.fact, requestDigest: hmac('5') },
    ];
    for (const fact of mutatedFacts) {
      await expect(
        journal.commitPrepared({
          ...prepared,
          fact,
          factDigest: workerInvocationFactDigest(fact),
        }),
      ).rejects.toMatchObject({
        code: 'JOURNAL_SECURITY_BLOCKED',
        message: 'JOURNAL_SECURITY_BLOCKED',
      });
    }
    const repeated = await Promise.allSettled(
      Array.from({ length: 8 }, () => {
        const fact = mutatedFacts[0]!;
        return journal.commitPrepared({
          ...prepared,
          fact,
          factDigest: workerInvocationFactDigest(fact),
        });
      }),
    );
    expect(repeated.every((result) => result.status === 'rejected')).toBe(true);
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      before,
    );
    const alerts = await reconciliationIntegrityAlerts(accepted.invocationId);
    expect(alerts).toHaveLength(mutatedFacts.length);
    expect(alerts.every((alert) => alert.source === 'WORKER')).toBe(true);
  });

  it('security-blocks every mutable started body field and dedupes concurrent repeats', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignDispatchPending(accepted);
    const prepared = preparedInput(accepted, authority);
    const committedPrepared = await journal.commitPrepared(prepared);
    if (!committedPrepared.startCommandId) throw new Error('expected start command');
    await markStartSent(committedPrepared.startCommandId);
    const started = startedInput(prepared, committedPrepared.startCommandId);
    await journal.commitStarted(started);
    const before = await reconciliationBusinessFootprint(accepted.invocationId, conversationId);
    const mutatedFacts: WorkerInvocationStartedFact[] = [
      { ...started.fact, agentVersionDigest: digest('2') },
      { ...started.fact, snapshotDigest: digest('3') },
      { ...started.fact, executionCapabilityDigest: digest('7') },
      { ...started.fact, leaseId: randomUuidV7() },
      { ...started.fact, fence: '2' },
      { ...started.fact, runtimeThreadId: 'thread-mutated' },
      { ...started.fact, runtimeTurnId: 'turn-mutated' },
      { ...started.fact, dispatchReceiptDigest: `sha256:${digest('8')}` },
      { ...started.fact, sandboxAttestationDigest: `sha256:${digest('9')}` },
    ];
    for (const fact of mutatedFacts) {
      await expect(
        journal.commitStarted({
          ...started,
          fact,
          factDigest: workerInvocationFactDigest(fact),
        }),
      ).rejects.toMatchObject({
        code: 'JOURNAL_SECURITY_BLOCKED',
        message: 'JOURNAL_SECURITY_BLOCKED',
      });
    }
    const repeated = await Promise.allSettled(
      Array.from({ length: 8 }, () => {
        const fact = mutatedFacts[0]!;
        return journal.commitStarted({
          ...started,
          fact,
          factDigest: workerInvocationFactDigest(fact),
        });
      }),
    );
    expect(repeated.every((result) => result.status === 'rejected')).toBe(true);
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      before,
    );
    const alerts = await reconciliationIntegrityAlerts(accepted.invocationId);
    expect(alerts).toHaveLength(mutatedFacts.length);
    expect(alerts.every((alert) => alert.source === 'WORKER')).toBe(true);
  });

  it('preserves exact started replay after terminal and security-blocks a terminal-phase mutation', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignDispatchPending(accepted);
    const prepared = preparedInput(accepted, authority);
    const committedPrepared = await journal.commitPrepared(prepared);
    if (!committedPrepared.startCommandId) throw new Error('expected start command');
    await markStartSent(committedPrepared.startCommandId);
    const started = startedInput(prepared, committedPrepared.startCommandId);
    const committedStarted = await journal.commitStarted(started);
    await journal.commitFailed(failedInput(accepted, authority));
    await expect(journal.commitStarted(started)).resolves.toEqual({
      ...committedStarted,
      replayed: true,
    });
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toEqual([]);
    const before = await reconciliationBusinessFootprint(accepted.invocationId, conversationId);
    const conflictFact: WorkerInvocationStartedFact = {
      ...started.fact,
      runtimeTurnId: 'turn-terminal-conflict',
    };
    await expect(
      journal.commitStarted({
        ...started,
        fact: conflictFact,
        factDigest: workerInvocationFactDigest(conflictFact),
      }),
    ).rejects.toMatchObject({ code: 'JOURNAL_SECURITY_BLOCKED' });
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      before,
    );
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toMatchObject([
      { reason: 'SOURCE_EVENT_CONFLICT', source: 'WORKER' },
    ]);
  });

  it('security-blocks global cross-Consumer source reuse and a conflicting same-phase source', async () => {
    const secondConsumer = await owner.query<{ id: string }>(
      `INSERT INTO users (account) VALUES ($1) RETURNING id`,
      [account()],
    );
    const secondConsumerId = secondConsumer.rows[0]!.id;
    const firstConversationId = await createConversation();
    const secondConversationId = await createConversation({ consumerId: secondConsumerId });
    const first = acceptInput(firstConversationId);
    const second = acceptInput(secondConversationId, { consumerId: secondConsumerId });
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(first);
    await journal.acceptInvocation(second);
    const firstAuthority = await assignDispatchPending(first);
    const secondAuthority = await assignDispatchPending(second);
    const firstPrepared = preparedInput(first, firstAuthority);
    const secondPrepared = preparedInput(second, secondAuthority);
    await journal.commitPrepared(firstPrepared);
    const loserBefore = await reconciliationBusinessFootprint(
      second.invocationId,
      secondConversationId,
    );

    const globalConflictFact: WorkerInvocationPreparedFact = {
      ...secondPrepared.fact,
      sourceEventId: firstPrepared.fact.sourceEventId,
      prepareCommandId: firstPrepared.fact.prepareCommandId,
    };
    const globalConflict = {
      ...secondPrepared,
      fact: globalConflictFact,
      factDigest: workerInvocationFactDigest(globalConflictFact),
    };
    const globalAttempts = await Promise.allSettled(
      Array.from({ length: 8 }, () => journal.commitPrepared(globalConflict)),
    );
    expect(globalAttempts.every((result) => result.status === 'rejected')).toBe(true);
    for (const result of globalAttempts) {
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({ code: 'JOURNAL_SECURITY_BLOCKED' });
      }
    }
    expect(
      await reconciliationBusinessFootprint(second.invocationId, secondConversationId),
    ).toEqual(loserBefore);
    expect(await reconciliationIntegrityAlerts(first.invocationId)).toEqual([]);
    expect(await reconciliationIntegrityAlerts(second.invocationId)).toMatchObject([
      {
        creator_id: ids.creatorId,
        consumer_subject_id: secondConsumerId,
        reason: 'SOURCE_EVENT_CONFLICT',
        source: 'WORKER',
      },
    ]);

    await journal.commitPrepared(secondPrepared);
    const committedBefore = await reconciliationBusinessFootprint(
      second.invocationId,
      secondConversationId,
    );
    const competingPhaseId = randomUuidV7();
    const phaseConflictFact: WorkerInvocationPreparedFact = {
      ...secondPrepared.fact,
      sourceEventId: competingPhaseId,
      prepareCommandId: competingPhaseId,
    };
    await expect(
      journal.commitPrepared({
        ...secondPrepared,
        fact: phaseConflictFact,
        factDigest: workerInvocationFactDigest(phaseConflictFact),
      }),
    ).rejects.toMatchObject({ code: 'JOURNAL_SECURITY_BLOCKED' });
    expect(
      await reconciliationBusinessFootprint(second.invocationId, secondConversationId),
    ).toEqual(committedBefore);
    expect(await reconciliationIntegrityAlerts(second.invocationId)).toHaveLength(2);
  });

  it('security-blocks global cross-Consumer started source reuse and a conflicting same-phase source', async () => {
    const secondConsumer = await owner.query<{ id: string }>(
      `INSERT INTO users (account) VALUES ($1) RETURNING id`,
      [account()],
    );
    const secondConsumerId = secondConsumer.rows[0]!.id;
    const firstConversationId = await createConversation();
    const secondConversationId = await createConversation({ consumerId: secondConsumerId });
    const first = acceptInput(firstConversationId);
    const second = acceptInput(secondConversationId, { consumerId: secondConsumerId });
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(first);
    await journal.acceptInvocation(second);
    const firstAuthority = await assignDispatchPending(first);
    const secondAuthority = await assignDispatchPending(second);
    const firstPrepared = preparedInput(first, firstAuthority);
    const secondPrepared = preparedInput(second, secondAuthority);
    const firstCommittedPrepared = await journal.commitPrepared(firstPrepared);
    const secondCommittedPrepared = await journal.commitPrepared(secondPrepared);
    if (!firstCommittedPrepared.startCommandId || !secondCommittedPrepared.startCommandId) {
      throw new Error('expected start commands');
    }
    await markStartSent(firstCommittedPrepared.startCommandId);
    await markStartSent(secondCommittedPrepared.startCommandId);
    const firstStarted = startedInput(firstPrepared, firstCommittedPrepared.startCommandId);
    const secondStarted = startedInput(secondPrepared, secondCommittedPrepared.startCommandId);
    await journal.commitStarted(firstStarted);
    const loserBefore = await reconciliationBusinessFootprint(
      second.invocationId,
      secondConversationId,
    );

    const globalConflictFact: WorkerInvocationStartedFact = {
      ...secondStarted.fact,
      sourceEventId: firstStarted.fact.sourceEventId,
      startCommandId: firstStarted.fact.startCommandId,
    };
    const globalConflict = {
      ...secondStarted,
      fact: globalConflictFact,
      factDigest: workerInvocationFactDigest(globalConflictFact),
    };
    const globalAttempts = await Promise.allSettled(
      Array.from({ length: 8 }, () => journal.commitStarted(globalConflict)),
    );
    expect(globalAttempts.every((result) => result.status === 'rejected')).toBe(true);
    for (const result of globalAttempts) {
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({ code: 'JOURNAL_SECURITY_BLOCKED' });
      }
    }
    expect(
      await reconciliationBusinessFootprint(second.invocationId, secondConversationId),
    ).toEqual(loserBefore);
    expect(await reconciliationIntegrityAlerts(first.invocationId)).toEqual([]);
    expect(await reconciliationIntegrityAlerts(second.invocationId)).toMatchObject([
      {
        creator_id: ids.creatorId,
        consumer_subject_id: secondConsumerId,
        reason: 'SOURCE_EVENT_CONFLICT',
        source: 'WORKER',
      },
    ]);

    await journal.commitStarted(secondStarted);
    const committedBefore = await reconciliationBusinessFootprint(
      second.invocationId,
      secondConversationId,
    );
    const competingPhaseId = randomUuidV7();
    const phaseConflictFact: WorkerInvocationStartedFact = {
      ...secondStarted.fact,
      sourceEventId: competingPhaseId,
      startCommandId: competingPhaseId,
    };
    await expect(
      journal.commitStarted({
        ...secondStarted,
        fact: phaseConflictFact,
        factDigest: workerInvocationFactDigest(phaseConflictFact),
      }),
    ).rejects.toMatchObject({ code: 'JOURNAL_SECURITY_BLOCKED' });
    expect(
      await reconciliationBusinessFootprint(second.invocationId, secondConversationId),
    ).toEqual(committedBefore);
    expect(await reconciliationIntegrityAlerts(second.invocationId)).toHaveLength(2);
  });

  it('returns a prepared SECURITY_BLOCKED marker inside a caller transaction and standalone throws post-commit', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignDispatchPending(accepted);
    const prepared = preparedInput(accepted, authority);
    await journal.commitPrepared(prepared);
    const conflictFact: WorkerInvocationPreparedFact = {
      ...prepared.fact,
      requestDigest: hmac('6'),
    };
    const conflict = {
      ...prepared,
      fact: conflictFact,
      factDigest: workerInvocationFactDigest(conflictFact),
    };
    const before = await reconciliationBusinessFootprint(accepted.invocationId, conversationId);
    const broker = await brokerPool.connect();
    try {
      await broker.query('BEGIN');
      await broker.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await broker.query(`SELECT set_config('app.consumer_id', '', true)`);
      const outcome = await journal.projectPrepared(
        gatewayProjectorTransaction(broker),
        conflict,
        AbortSignal.timeout(5_000),
      );
      expect(outcome).toEqual({ kind: 'SECURITY_BLOCKED' });
      await broker.query('COMMIT');
    } finally {
      await broker.query('ROLLBACK').catch(() => undefined);
      broker.release();
    }
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toHaveLength(1);
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      before,
    );
    await expect(journal.commitPrepared(conflict)).rejects.toMatchObject({
      code: 'JOURNAL_SECURITY_BLOCKED',
      message: 'JOURNAL_SECURITY_BLOCKED',
    });
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toHaveLength(1);
  });

  it('rolls back a prepared alert failpoint and dedupes after standalone COMMIT ACK loss', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const baseJournal = new PostgresCloudJournal(journalPools);
    await baseJournal.acceptInvocation(accepted);
    const authority = await assignDispatchPending(accepted);
    const prepared = preparedInput(accepted, authority);
    await baseJournal.commitPrepared(prepared);
    const conflictFact: WorkerInvocationPreparedFact = {
      ...prepared.fact,
      requestDigest: hmac('9'),
    };
    const conflict = {
      ...prepared,
      fact: conflictFact,
      factDigest: workerInvocationFactDigest(conflictFact),
    };
    const before = await reconciliationBusinessFootprint(accepted.invocationId, conversationId);

    const failing = new PostgresCloudJournal(journalPools, (step) => {
      if (step === 'JOURNAL_INTEGRITY_ALERT') {
        throw new Error('FAILPOINT:PREPARED_JOURNAL_INTEGRITY_ALERT');
      }
    });
    await expect(failing.commitPrepared(conflict)).rejects.toThrow(
      'FAILPOINT:PREPARED_JOURNAL_INTEGRITY_ALERT',
    );
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toEqual([]);
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      before,
    );

    let loseCommitAcknowledgement = true;
    const ambiguousBrokerPool: JournalPool = {
      async connect() {
        const client = await brokerPool.connect();
        return {
          async query<R = Record<string, unknown>>(
            sql: string,
            parameters?: readonly unknown[],
          ): Promise<QueryResult<R>> {
            const result = await client.query(sql, parameters as unknown[] | undefined);
            if (sql === 'COMMIT' && loseCommitAcknowledgement) {
              loseCommitAcknowledgement = false;
              throw new Error('SIMULATED_PREPARED_COMMIT_ACK_LOSS');
            }
            return result as unknown as QueryResult<R>;
          },
          release() {
            client.release();
          },
        };
      },
    };
    const ambiguousJournal = new PostgresCloudJournal({
      ...journalPools,
      broker: ambiguousBrokerPool,
    });
    await expect(ambiguousJournal.commitPrepared(conflict)).rejects.toThrow(
      'SIMULATED_PREPARED_COMMIT_ACK_LOSS',
    );
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toHaveLength(1);
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      before,
    );
    await expect(baseJournal.commitPrepared(conflict)).rejects.toMatchObject({
      code: 'JOURNAL_SECURITY_BLOCKED',
      message: 'JOURNAL_SECURITY_BLOCKED',
    });
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toHaveLength(1);
  });

  it('returns a started SECURITY_BLOCKED marker inside a caller transaction and standalone throws post-commit', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignDispatchPending(accepted);
    const prepared = preparedInput(accepted, authority);
    const committedPrepared = await journal.commitPrepared(prepared);
    if (!committedPrepared.startCommandId) throw new Error('expected start command');
    await markStartSent(committedPrepared.startCommandId);
    const started = startedInput(prepared, committedPrepared.startCommandId);
    await journal.commitStarted(started);
    const conflictFact: WorkerInvocationStartedFact = {
      ...started.fact,
      runtimeThreadId: 'thread-security-conflict',
    };
    const conflict = {
      ...started,
      fact: conflictFact,
      factDigest: workerInvocationFactDigest(conflictFact),
    };
    const before = await reconciliationBusinessFootprint(accepted.invocationId, conversationId);
    const broker = await brokerPool.connect();
    try {
      await broker.query('BEGIN');
      await broker.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await broker.query(`SELECT set_config('app.consumer_id', '', true)`);
      const outcome = await journal.projectStarted(
        gatewayProjectorTransaction(broker),
        conflict,
        AbortSignal.timeout(5_000),
      );
      expect(outcome).toEqual({ kind: 'SECURITY_BLOCKED' });
      await broker.query('COMMIT');
    } finally {
      await broker.query('ROLLBACK').catch(() => undefined);
      broker.release();
    }
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toHaveLength(1);
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      before,
    );
    await expect(journal.commitStarted(conflict)).rejects.toMatchObject({
      code: 'JOURNAL_SECURITY_BLOCKED',
      message: 'JOURNAL_SECURITY_BLOCKED',
    });
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toHaveLength(1);
  });

  it('rolls back a started alert failpoint and dedupes after standalone COMMIT ACK loss', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const baseJournal = new PostgresCloudJournal(journalPools);
    await baseJournal.acceptInvocation(accepted);
    const authority = await assignDispatchPending(accepted);
    const prepared = preparedInput(accepted, authority);
    const committedPrepared = await baseJournal.commitPrepared(prepared);
    if (!committedPrepared.startCommandId) throw new Error('expected start command');
    await markStartSent(committedPrepared.startCommandId);
    const started = startedInput(prepared, committedPrepared.startCommandId);
    await baseJournal.commitStarted(started);
    const conflictFact: WorkerInvocationStartedFact = {
      ...started.fact,
      runtimeTurnId: 'turn-security-conflict',
    };
    const conflict = {
      ...started,
      fact: conflictFact,
      factDigest: workerInvocationFactDigest(conflictFact),
    };
    const before = await reconciliationBusinessFootprint(accepted.invocationId, conversationId);
    const failing = new PostgresCloudJournal(journalPools, (step) => {
      if (step === 'JOURNAL_INTEGRITY_ALERT') {
        throw new Error('FAILPOINT:STARTED_JOURNAL_INTEGRITY_ALERT');
      }
    });
    await expect(failing.commitStarted(conflict)).rejects.toThrow(
      'FAILPOINT:STARTED_JOURNAL_INTEGRITY_ALERT',
    );
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toEqual([]);
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      before,
    );

    let loseCommitAcknowledgement = true;
    const ambiguousBrokerPool: JournalPool = {
      async connect() {
        const client = await brokerPool.connect();
        return {
          async query<R = Record<string, unknown>>(
            sql: string,
            parameters?: readonly unknown[],
          ): Promise<QueryResult<R>> {
            const result = await client.query(sql, parameters as unknown[] | undefined);
            if (sql === 'COMMIT' && loseCommitAcknowledgement) {
              loseCommitAcknowledgement = false;
              throw new Error('SIMULATED_STARTED_COMMIT_ACK_LOSS');
            }
            return result as unknown as QueryResult<R>;
          },
          release() {
            client.release();
          },
        };
      },
    };
    const ambiguousJournal = new PostgresCloudJournal({
      ...journalPools,
      broker: ambiguousBrokerPool,
    });
    await expect(ambiguousJournal.commitStarted(conflict)).rejects.toThrow(
      'SIMULATED_STARTED_COMMIT_ACK_LOSS',
    );
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toHaveLength(1);
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      before,
    );
    await expect(baseJournal.commitStarted(conflict)).rejects.toMatchObject({
      code: 'JOURNAL_SECURITY_BLOCKED',
      message: 'JOURNAL_SECURITY_BLOCKED',
    });
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toHaveLength(1);
  });

  it('blocks the legacy direct prepared writer and still denies RLS/stale mutation', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignDispatchPending(accepted);
    const prepared = preparedInput(accepted, authority);

    await expect(
      brokerPool.query<{ current_user: string }>(`SELECT current_user`),
    ).resolves.toMatchObject({ rows: [{ current_user: 'combo_agent_broker' }] });

    const legacyWriter = await brokerPool.connect();
    try {
      await legacyWriter.query('BEGIN');
      await legacyWriter.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await legacyWriter.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumerId]);
      await legacyWriter.query(`UPDATE agent_invocations SET state = 'PERSISTED' WHERE id = $1`, [
        accepted.invocationId,
      ]);
      await expect(
        legacyWriter.query(
          `INSERT INTO agent_invocation_events (
             invocation_id, creator_id, consumer_subject_id, journal_seq, source,
             source_event_id, event_type, payload, occurred_at,
             source_fact_digest, broker_command_id
           ) VALUES (
             $1, $2, $3, 2, 'WORKER', $4, 'invocation.persisted',
             '{"state":"PERSISTED"}'::jsonb, clock_timestamp(), $5, $6
           )`,
          [
            accepted.invocationId,
            ids.creatorId,
            ids.consumerId,
            prepared.fact.sourceEventId,
            prepared.factDigest,
            prepared.fact.prepareCommandId,
          ],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await legacyWriter.query('ROLLBACK').catch(() => undefined);
      legacyWriter.release();
    }
    await expect(
      owner.query<{
        state: string;
        persisted_events: string;
        prepare_state: string;
      }>(
        `SELECT invocation.state,
                (SELECT count(*) FROM agent_invocation_events
                  WHERE invocation_id = invocation.id
                    AND event_type = 'invocation.persisted')::text AS persisted_events,
                (SELECT state FROM broker_outbox
                  WHERE invocation_id = invocation.id
                    AND command_type = 'invocation.prepare') AS prepare_state
           FROM agent_invocations AS invocation WHERE invocation.id = $1`,
        [accepted.invocationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: 'DISPATCH_PENDING', persisted_events: '0', prepare_state: 'SENT' }],
    });

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

  it('blocks the legacy direct started writer without rolling forward its projection', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignDispatchPending(accepted);
    const prepared = preparedInput(accepted, authority);
    const committedPrepared = await journal.commitPrepared(prepared);
    if (!committedPrepared.startCommandId) throw new Error('expected start command');
    await markStartSent(committedPrepared.startCommandId);
    const started = startedInput(prepared, committedPrepared.startCommandId);
    const legacyWriter = await brokerPool.connect();
    try {
      await legacyWriter.query('BEGIN');
      await legacyWriter.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await legacyWriter.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumerId]);
      await legacyWriter.query(
        `UPDATE agent_invocations
            SET state = 'STARTING', started_at = clock_timestamp(),
                runtime_thread_id = $2, runtime_turn_id = $3
          WHERE id = $1`,
        [accepted.invocationId, started.fact.runtimeThreadId, started.fact.runtimeTurnId],
      );
      await legacyWriter.query(`UPDATE agent_invocations SET state = 'RUNNING' WHERE id = $1`, [
        accepted.invocationId,
      ]);
      await expect(
        legacyWriter.query(
          `INSERT INTO agent_invocation_events (
             invocation_id, creator_id, consumer_subject_id, journal_seq, source,
             source_event_id, event_type, payload, occurred_at,
             source_fact_digest, broker_command_id,
             source_dispatch_receipt_digest, source_sandbox_attestation_digest
           ) VALUES (
             $1, $2, $3, 3, 'WORKER', $4, 'invocation.started',
             '{"state":"RUNNING"}'::jsonb, clock_timestamp(), $5, $6, $7, $8
           )`,
          [
            accepted.invocationId,
            ids.creatorId,
            ids.consumerId,
            started.fact.sourceEventId,
            started.factDigest,
            started.fact.startCommandId,
            started.fact.dispatchReceiptDigest,
            started.fact.sandboxAttestationDigest,
          ],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await legacyWriter.query('ROLLBACK').catch(() => undefined);
      legacyWriter.release();
    }
    await expect(
      owner.query<{
        state: string;
        started_events: string;
        start_state: string;
      }>(
        `SELECT invocation.state,
                (SELECT count(*) FROM agent_invocation_events
                  WHERE invocation_id = invocation.id
                    AND event_type = 'invocation.started')::text AS started_events,
                (SELECT state FROM broker_outbox
                  WHERE invocation_id = invocation.id
                    AND command_type = 'invocation.start') AS start_state
           FROM agent_invocations AS invocation WHERE invocation.id = $1`,
        [accepted.invocationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: 'PERSISTED', started_events: '0', start_state: 'SENT' }],
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

    for (const target of [
      'INVOCATION_RECONCILING',
      'STARTED_EVENT',
      'RECONCILING_EVENT',
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
      await owner.query(
        `UPDATE agent_invocations
            SET execution_capability_revoked_at = clock_timestamp()
          WHERE id = $1`,
        [accepted.invocationId],
      );
      const started = startedInput(prepared, committedPrepared.startCommandId);
      const journal = new PostgresCloudJournal(journalPools, (step) => {
        if (step === target) throw new Error(`FAILPOINT:${target}`);
      });
      await expect(journal.commitStarted(started)).rejects.toThrow(`FAILPOINT:${target}`);
      const state = await owner.query<{
        state: string;
        reconciliation_reason: string | null;
        reconciliation_started_at: Date | null;
        runtime_thread_id: string | null;
        runtime_turn_id: string | null;
        started_events: string;
        reconciliation_events: string;
        start_state: string;
      }>(
        `SELECT invocation.state, invocation.reconciliation_reason,
                invocation.reconciliation_started_at,
                invocation.runtime_thread_id, invocation.runtime_turn_id,
                (SELECT count(*) FROM agent_invocation_events
                  WHERE invocation_id = invocation.id
                    AND event_type = 'invocation.started')::text AS started_events,
                (SELECT count(*) FROM agent_invocation_events
                  WHERE invocation_id = invocation.id
                    AND event_type = 'invocation.reconciling')::text AS reconciliation_events,
                (SELECT state FROM broker_outbox
                  WHERE invocation_id = invocation.id AND command_type = 'invocation.start')
                  AS start_state
           FROM agent_invocations AS invocation WHERE invocation.id = $1`,
        [accepted.invocationId],
      );
      expect(state.rows[0], `fresh-started-root:${target}`).toEqual({
        state: 'PERSISTED',
        reconciliation_reason: null,
        reconciliation_started_at: null,
        runtime_thread_id: null,
        runtime_turn_id: null,
        started_events: '0',
        reconciliation_events: '0',
        start_state: 'SENT',
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
    const observedSql: string[] = [];
    const broker = await brokerPool.connect();
    try {
      await broker.query('BEGIN');
      await broker.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      const transaction = gatewayProjectorTransaction(broker, observedSignals, observedSql);
      const preparedOutcome = await journal.projectPrepared(transaction, prepared, signal);
      if (preparedOutcome.kind !== 'COMMITTED') throw new Error('expected committed prepared');
      const committedPrepared = preparedOutcome.committed;
      if (!committedPrepared.startCommandId) throw new Error('expected start command');
      await broker.query(`SELECT set_config('app.consumer_id', '', true)`);
      await broker.query(
        `UPDATE broker_outbox
            SET state = 'SENT', attempt_count = 1, next_attempt_at = now()
          WHERE command_id = $1`,
        [committedPrepared.startCommandId],
      );
      const started = startedInput(prepared, committedPrepared.startCommandId);
      await expect(journal.projectStarted(transaction, started, signal)).resolves.toMatchObject({
        kind: 'COMMITTED',
        committed: { state: 'RUNNING', replayed: false },
      });
      const success = successInput(accepted, {
        ...authority,
        runtimeThreadId: started.fact.runtimeThreadId,
        runtimeTurnId: started.fact.runtimeTurnId,
        startedFactDigest: started.factDigest,
      });
      await broker.query(`SELECT set_config('app.consumer_id', '', true)`);
      const successSqlStart = observedSql.length;
      const successSignalStart = observedSignals.length;
      await expect(
        journal.projectSuccess(transaction, success, sealAssistantMessage, signal),
      ).resolves.toMatchObject({ kind: 'COMMITTED', committed: { replayed: false } });
      const successSql = observedSql.slice(successSqlStart);
      const successSignals = observedSignals.slice(successSignalStart);
      const preflightIndex = successSql.findIndex((sql) =>
        sql.includes('creator_agent_preflight_success_fact_v1'),
      );
      const finalizeIndex = successSql.findIndex((sql) =>
        sql.includes('creator_agent_finalize_success_fact_v1'),
      );
      expect(preflightIndex).toBe(0);
      expect(finalizeIndex).toBeGreaterThan(preflightIndex);
      expect(successSignals.length).toBeGreaterThanOrEqual(2);
      expect(successSignals[preflightIndex]).toBe(signal);
      expect(successSignals[finalizeIndex]).toBe(signal);
      expect(successSignals.every((observed) => observed === signal)).toBe(true);
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
      expect(input.signal).not.toBe(controller.signal);
      expect(input.signal.aborted).toBe(false);
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
    expect(await successControlFootprint(accepted.invocationId)).toEqual({
      preflights: '0',
      receipts: '0',
    });
  });

  it('settles a terminal sealer that ignores caller abort and releases its database locks', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignRunning(accepted);
    const success = successInput(accepted, authority);
    const hungSealer: AssistantMessageSealer = () => new Promise<never>(() => undefined);

    await expect(
      journal.commitSuccess(success, hungSealer, AbortSignal.timeout(100)),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(await counts(conversationId)).toMatchObject({
      messages: '1',
      events: '3',
      consumer_events: '0',
      consumer_streams: '0',
      conversation_state: 'BUSY',
    });
    expect(await successControlFootprint(accepted.invocationId)).toEqual({
      preflights: '0',
      receipts: '0',
    });
    await expect(journal.commitSuccess(success, sealAssistantMessage)).resolves.toMatchObject({
      replayed: false,
    });
  });

  it('refuses to commit an unconsumed success seal preflight', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignRunning(accepted);
    const success = successInput(accepted, authority);
    const before = await reconciliationBusinessFootprint(accepted.invocationId, conversationId);
    const broker = await brokerPool.connect();
    try {
      await broker.query('BEGIN');
      await broker.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await broker.query(`SELECT set_config('app.consumer_id', '', true)`);
      await expect(
        broker.query<{ outcome: string; seal_token: string; assistant_message_id: string }>(
          `SELECT outcome, seal_token::text, assistant_message_id::text
             FROM creator_agent_preflight_success_fact_v1(
               $1, $2, $3, $4, $5, $6, $7, $8, $9,
               $10, $11, $12, $13, $14, $15, $16, $17, $18
             )`,
          successPreflightParameters(success) as unknown[],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            outcome: 'SEAL_REQUIRED',
            seal_token: expect.any(String),
            assistant_message_id: expect.any(String),
          },
        ],
      });
      await expect(broker.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
    } finally {
      await broker.query('ROLLBACK').catch(() => undefined);
      broker.release();
    }
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      before,
    );
    await expect(
      owner.query<{ pending: string }>(
        `SELECT count(*)::text AS pending FROM creator_agent_success_seal_preflights
          WHERE invocation_id = $1`,
        [accepted.invocationId],
      ),
    ).resolves.toMatchObject({ rows: [{ pending: '0' }] });
  });

  it('rejects cross-transaction and direct success finalize without a matching seal intent', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignRunning(accepted);
    const success = successInput(accepted, authority);
    const preflightOwner = await brokerPool.connect();
    const outsider = await brokerPool.connect();
    try {
      await preflightOwner.query('BEGIN');
      await preflightOwner.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await preflightOwner.query(`SELECT set_config('app.consumer_id', '', true)`);
      const pending = await preflightOwner.query<{
        seal_token: string;
        assistant_message_id: string;
        aad_owner_id: string;
        aad_conversation_id: string;
      }>(
        `SELECT seal_token::text, assistant_message_id::text,
                aad_owner_id::text, aad_conversation_id::text
           FROM creator_agent_preflight_success_fact_v1(
             $1, $2, $3, $4, $5, $6, $7, $8, $9,
             $10, $11, $12, $13, $14, $15, $16, $17, $18
           )`,
        successPreflightParameters(success) as unknown[],
      );
      const intent = pending.rows[0]!;
      const sealed = await sealAssistantMessage({
        resultCiphertext: success.resultCiphertext,
        aad: {
          schemaVersion: 1,
          ownerId: intent.aad_owner_id,
          conversationId: intent.aad_conversation_id,
          messageId: intent.assistant_message_id,
          role: 'ASSISTANT',
        },
        signal: AbortSignal.timeout(5_000),
      });
      const encrypted = sealed.encryptedMessage;
      const finalize = async (sealToken: string) =>
        outsider.query<{ outcome: string }>(
          `SELECT outcome FROM creator_agent_finalize_success_fact_v1(
             $1, $2, $3, $4, $5, $6, $7,
             $8, $9, $10, $11, $12, $13, $14
           )`,
          [
            sealToken,
            ids.creatorId,
            success.fact.invocationId,
            success.factDigest,
            intent.assistant_message_id,
            sealed.verifiedResultDigest,
            encrypted.algorithm,
            encrypted.keyId,
            encrypted.nonce,
            encrypted.ciphertext,
            encrypted.authTag,
            encrypted.cipherDigest,
            encrypted.contentDigest,
            encrypted.aadVersion,
          ],
        );

      await outsider.query('BEGIN');
      await outsider.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await outsider.query(`SELECT set_config('app.consumer_id', '', true)`);
      await expect(finalize(intent.seal_token)).resolves.toMatchObject({
        rows: [{ outcome: 'AUTHORITY_REJECTED' }],
      });
      await expect(finalize(randomUuidV7())).resolves.toMatchObject({
        rows: [{ outcome: 'AUTHORITY_REJECTED' }],
      });
      await outsider.query('ROLLBACK');
    } finally {
      await preflightOwner.query('ROLLBACK').catch(() => undefined);
      await outsider.query('ROLLBACK').catch(() => undefined);
      preflightOwner.release();
      outsider.release();
    }
    await expect(journal.commitSuccess(success, sealAssistantMessage)).resolves.toMatchObject({
      replayed: false,
    });
  });

  it('returns a success SECURITY_BLOCKED marker after finalize commits a digest alert', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignRunning(accepted);
    const success = successInput(accepted, authority);
    const before = await reconciliationBusinessFootprint(accepted.invocationId, conversationId);
    const mismatchedSealer: AssistantMessageSealer = async (input) => ({
      ...(await sealAssistantMessage(input)),
      verifiedResultDigest: hmac('5'),
    });
    const failing = new PostgresCloudJournal(journalPools, (step) => {
      if (step === 'JOURNAL_INTEGRITY_ALERT') {
        throw new Error('FAILPOINT:SUCCESS_JOURNAL_INTEGRITY_ALERT');
      }
    });
    await expect(failing.commitSuccess(success, mismatchedSealer)).rejects.toThrow(
      'FAILPOINT:SUCCESS_JOURNAL_INTEGRITY_ALERT',
    );
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toEqual([]);
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      before,
    );
    expect(await successControlFootprint(accepted.invocationId)).toEqual({
      preflights: '0',
      receipts: '0',
    });
    const broker = await brokerPool.connect();
    try {
      await broker.query('BEGIN');
      await broker.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await broker.query(`SELECT set_config('app.consumer_id', '', true)`);
      await expect(
        journal.projectSuccess(
          gatewayProjectorTransaction(broker),
          success,
          mismatchedSealer,
          AbortSignal.timeout(5_000),
        ),
      ).resolves.toEqual({ kind: 'SECURITY_BLOCKED' });
      await broker.query('COMMIT');
    } finally {
      await broker.query('ROLLBACK').catch(() => undefined);
      broker.release();
    }
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      before,
    );
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toHaveLength(1);
    expect(await successControlFootprint(accepted.invocationId)).toEqual({
      preflights: '0',
      receipts: '0',
    });
    await expect(journal.commitSuccess(success, mismatchedSealer)).rejects.toMatchObject({
      code: 'JOURNAL_SECURITY_BLOCKED',
      message: 'JOURNAL_SECURITY_BLOCKED',
    });
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toHaveLength(1);
    await expect(journal.commitSuccess(success, sealAssistantMessage)).resolves.toMatchObject({
      replayed: false,
    });
  });

  it('serializes concurrent exact success facts and invokes the terminal sealer once', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignRunning(accepted);
    const success = successInput(accepted, authority);
    const sealer = vi.fn(sealAssistantMessage);

    const committed = await Promise.all(
      Array.from({ length: 8 }, () => journal.commitSuccess(success, sealer)),
    );
    expect(sealer).toHaveBeenCalledTimes(1);
    expect(committed.filter((result) => !result.replayed)).toHaveLength(1);
    expect(committed.filter((result) => result.replayed)).toHaveLength(7);
    expect(new Set(committed.map((result) => result.assistantMessageId)).size).toBe(1);
    expect(new Set(committed.map((result) => result.consumerEventCursor)).size).toBe(1);
  });

  it('serializes concurrent different success bodies to one admitted fact and one security block', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignRunning(accepted);
    const first = successInput(accepted, authority);
    const secondFact: WorkerInvocationSucceededFact = {
      ...first.fact,
      resultDigest: domainSeparatedHmacSha256('combo:vnext:result:v1', digestKey, {
        text: 'alternate assistant secret',
      }),
      localResultCipherDigest: digest('b'),
    };
    const second: CommitSuccessInput = {
      ...first,
      fact: secondFact,
      factDigest: workerInvocationFactDigest(secondFact),
      resultCiphertext: transportEncryptedAssistant(
        conversationId,
        accepted.invocationId,
        'alternate assistant secret',
      ),
    };
    const sealer = vi.fn(sealAssistantMessage);

    const attempts = await Promise.allSettled([
      journal.commitSuccess(first, sealer),
      journal.commitSuccess(second, sealer),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'JOURNAL_SECURITY_BLOCKED', message: 'JOURNAL_SECURITY_BLOCKED' },
    });
    expect(sealer).toHaveBeenCalledTimes(1);
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toHaveLength(1);
    await expect(
      owner.query<{ state: string; result_digest: string; messages: string; events: string }>(
        `SELECT state, result_digest,
                (SELECT count(*)::text FROM agent_messages
                  WHERE invocation_id = agent_invocations.id AND role = 'ASSISTANT') AS messages,
                (SELECT count(*)::text FROM agent_invocation_events
                  WHERE invocation_id = agent_invocations.id
                    AND event_type = 'invocation.succeeded') AS events
           FROM agent_invocations WHERE id = $1`,
        [accepted.invocationId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: 'SUCCEEDED',
          result_digest: expect.stringMatching(/^hmac-sha256:[a-f0-9]{64}$/u),
          messages: '1',
          events: '1',
        },
      ],
    });
  });

  it('recovers a success COMMIT acknowledgement loss through exact replay without resealing', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const baseJournal = new PostgresCloudJournal(journalPools);
    await baseJournal.acceptInvocation(accepted);
    const authority = await assignRunning(accepted);
    const success = successInput(accepted, authority);
    let loseCommitAcknowledgement = true;
    const ambiguousBrokerPool: JournalPool = {
      async connect() {
        const client = await brokerPool.connect();
        return {
          async query<R = Record<string, unknown>>(
            sql: string,
            parameters?: readonly unknown[],
          ): Promise<QueryResult<R>> {
            const result = await client.query(sql, parameters as unknown[] | undefined);
            if (sql === 'COMMIT' && loseCommitAcknowledgement) {
              loseCommitAcknowledgement = false;
              throw new Error('SIMULATED_SUCCESS_COMMIT_ACK_LOSS');
            }
            return result as unknown as QueryResult<R>;
          },
          release() {
            client.release();
          },
        };
      },
    };
    const ambiguousJournal = new PostgresCloudJournal({
      ...journalPools,
      broker: ambiguousBrokerPool,
    });
    const sealer = vi.fn(sealAssistantMessage);
    await expect(ambiguousJournal.commitSuccess(success, sealer)).rejects.toThrow(
      'SIMULATED_SUCCESS_COMMIT_ACK_LOSS',
    );
    expect(sealer).toHaveBeenCalledTimes(1);
    const forbiddenReplaySealer = vi.fn<AssistantMessageSealer>(() => {
      throw new Error('EXACT_REPLAY_MUST_NOT_SEAL');
    });
    await expect(baseJournal.commitSuccess(success, forbiddenReplaySealer)).resolves.toMatchObject({
      replayed: true,
      assistantMessageId: expect.any(String),
      consumerEventCursor: expect.any(String),
    });
    expect(forbiddenReplaySealer).not.toHaveBeenCalled();
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
    const beforeConflict = await reconciliationBusinessFootprint(
      accepted.invocationId,
      conversationId,
    );

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
    ).rejects.toMatchObject<Partial<CloudJournalError>>({
      code: 'JOURNAL_SECURITY_BLOCKED',
      message: 'JOURNAL_SECURITY_BLOCKED',
    });
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      beforeConflict,
    );
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toMatchObject([
      { reason: 'SOURCE_EVENT_CONFLICT', source: 'WORKER' },
    ]);

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

  it.each([
    {
      label: 'explicit UUID',
      reason: 'JOURNAL_LOST' as const,
      internalLatePrepared: false,
    },
    {
      label: 'internal late-prepared UUID suffix',
      reason: 'START_DISPATCH_UNKNOWN' as const,
      internalLatePrepared: true,
    },
  ])(
    'keeps one $label reconciliation root and appends one deterministic resumed event',
    async ({ reason, internalLatePrepared }) => {
      const conversationId = await createConversation();
      const accepted = acceptInput(conversationId);
      const journal = new PostgresCloudJournal(journalPools);
      await journal.acceptInvocation(accepted);
      const authority = await assignDispatchPending(accepted);
      const prepared = preparedInput(accepted, authority);
      const committedPrepared = await journal.commitPrepared(prepared);
      if (!committedPrepared.startCommandId) throw new Error('expected start command');
      await markStartSent(committedPrepared.startCommandId);

      const rootInputSourceEventId = internalLatePrepared
        ? prepared.fact.sourceEventId
        : randomUuidV7();
      const rootSourceEventId = internalLatePrepared
        ? `late-prepared:${rootInputSourceEventId}`
        : rootInputSourceEventId;
      if (internalLatePrepared) {
        await owner.query('BEGIN');
        try {
          const transition = await owner.query<{ reconciliation_started_at: Date }>(
            `UPDATE agent_invocations
                SET state = 'RECONCILING', reconciliation_reason = $2,
                    reconciliation_started_at = date_trunc('milliseconds', clock_timestamp())
              WHERE id = $1 AND state = 'PERSISTED'
              RETURNING reconciliation_started_at`,
            [accepted.invocationId, reason],
          );
          await owner.query(
            `INSERT INTO agent_invocation_events (
               invocation_id, creator_id, consumer_subject_id, journal_seq, source,
               source_event_id, event_type, payload, occurred_at
             )
             SELECT $1, $2, $3, COALESCE(max(journal_seq), 0) + 1,
                    'RECONCILER', $4, 'invocation.reconciling', $5::jsonb, $6
               FROM agent_invocation_events
              WHERE invocation_id = $1`,
            [
              accepted.invocationId,
              ids.creatorId,
              ids.consumerId,
              rootSourceEventId,
              JSON.stringify({ state: 'RECONCILING', reason }),
              transition.rows[0]!.reconciliation_started_at,
            ],
          );
          await owner.query('COMMIT');
        } catch (error) {
          await owner.query('ROLLBACK');
          throw error;
        }
      } else {
        await journal.beginReconciliation({
          creatorId: ids.creatorId,
          consumerId: ids.consumerId,
          conversationId,
          invocationId: accepted.invocationId,
          sourceEventId: rootInputSourceEventId,
          reason,
        });
      }

      const started = startedInput(prepared, committedPrepared.startCommandId);
      await expect(journal.commitStarted(started)).resolves.toMatchObject({
        state: 'RUNNING',
        replayed: false,
      });
      const reentered = await journal.beginReconciliation({
        creatorId: ids.creatorId,
        consumerId: ids.consumerId,
        conversationId,
        invocationId: accepted.invocationId,
        sourceEventId: rootInputSourceEventId,
        reason,
      });
      expect(reentered).toMatchObject({ state: 'RECONCILING', reason, replayed: false });

      const durable = await owner.query<{
        state: string;
        reconciliation_reason: string;
        reconciliation_started_at: Date;
        root_events: string;
        root_source_event_id: string;
        root_payload: unknown;
        root_occurred_at: Date;
        root_journal_seq: string;
        started_source_event_id: string;
        started_journal_seq: string;
        resumed_events: string;
        resumed_source_event_id: string;
        resumed_payload: unknown;
        resumed_journal_seq: string;
      }>(
        `SELECT invocation.state, invocation.reconciliation_reason,
                invocation.reconciliation_started_at,
                (SELECT count(*) FROM agent_invocation_events
                  WHERE invocation_id = invocation.id
                    AND event_type = 'invocation.reconciling')::text AS root_events,
                root.source_event_id AS root_source_event_id,
                root.payload AS root_payload,
                root.occurred_at AS root_occurred_at,
                root.journal_seq::text AS root_journal_seq,
                started.source_event_id AS started_source_event_id,
                started.journal_seq::text AS started_journal_seq,
                (SELECT count(*) FROM agent_invocation_events
                  WHERE invocation_id = invocation.id
                    AND event_type = 'invocation.reconciling_resumed')::text AS resumed_events,
                resumed.source_event_id AS resumed_source_event_id,
                resumed.payload AS resumed_payload,
                resumed.journal_seq::text AS resumed_journal_seq
           FROM agent_invocations AS invocation
           JOIN agent_invocation_events AS root
             ON root.invocation_id = invocation.id
            AND root.event_type = 'invocation.reconciling'
           JOIN agent_invocation_events AS started
             ON started.invocation_id = invocation.id
            AND started.source = 'WORKER'
            AND started.event_type = 'invocation.started'
           JOIN agent_invocation_events AS resumed
             ON resumed.invocation_id = invocation.id
            AND resumed.source = 'RECONCILER'
            AND resumed.event_type = 'invocation.reconciling_resumed'
          WHERE invocation.id = $1`,
        [accepted.invocationId],
      );
      expect(durable.rows[0]).toMatchObject({
        state: 'RECONCILING',
        reconciliation_reason: reason,
        root_events: '1',
        root_source_event_id: rootSourceEventId,
        root_payload: { state: 'RECONCILING', reason },
        root_journal_seq: '3',
        started_source_event_id: started.fact.sourceEventId,
        started_journal_seq: '4',
        resumed_events: '1',
        resumed_source_event_id: `resume-reconciliation:${rootSourceEventId}:${started.fact.sourceEventId}`,
        resumed_payload: { state: 'RECONCILING', reason },
        resumed_journal_seq: '5',
      });
      expect(durable.rows[0]!.root_occurred_at.toISOString()).toBe(
        durable.rows[0]!.reconciliation_started_at.toISOString(),
      );
      const afterReentry = await counts(conversationId);
      expect(afterReentry.events).toBe('5');
      await expect(
        journal.beginReconciliation({
          creatorId: ids.creatorId,
          consumerId: ids.consumerId,
          conversationId,
          invocationId: accepted.invocationId,
          sourceEventId: rootInputSourceEventId,
          reason,
        }),
      ).resolves.toEqual({ ...reentered, replayed: true });
      expect(await counts(conversationId)).toEqual(afterReentry);
    },
  );

  it('rejects direct Broker or old Reconciler attempts to spoof reconciliation Events', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignDispatchPending(accepted);
    const prepared = preparedInput(accepted, authority);
    const committedPrepared = await journal.commitPrepared(prepared);
    if (!committedPrepared.startCommandId) throw new Error('expected start command');
    await markStartSent(committedPrepared.startCommandId);
    const rootSourceEventId = randomUuidV7();
    const broker = await brokerPool.connect();
    try {
      await broker.query('BEGIN');
      await broker.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await broker.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumerId]);
      const transition = await broker.query<{ reconciliation_started_at: Date }>(
        `UPDATE agent_invocations
            SET state = 'RECONCILING', reconciliation_reason = 'JOURNAL_LOST',
                reconciliation_started_at = date_trunc('milliseconds', clock_timestamp())
          WHERE id = $1 AND state = 'PERSISTED'
          RETURNING reconciliation_started_at`,
        [accepted.invocationId],
      );
      await expect(
        broker.query(
          `INSERT INTO agent_invocation_events (
             invocation_id, creator_id, consumer_subject_id, journal_seq, source,
             source_event_id, event_type, payload, occurred_at
           )
           SELECT $1, $2, $3, COALESCE(max(journal_seq), 0) + 1,
                  'RECONCILER', $4, 'invocation.reconciling', $5::jsonb, $6
             FROM agent_invocation_events WHERE invocation_id = $1`,
          [
            accepted.invocationId,
            ids.creatorId,
            ids.consumerId,
            rootSourceEventId,
            JSON.stringify({ state: 'RECONCILING', reason: 'JOURNAL_LOST' }),
            transition.rows[0]!.reconciliation_started_at,
          ],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await broker.query('ROLLBACK');

      const oldReconciler = await reconcilerPool.connect();
      try {
        await oldReconciler.query('BEGIN');
        await oldReconciler.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
        await oldReconciler.query(`SELECT set_config('app.consumer_id', $1, true)`, [
          ids.consumerId,
        ]);
        const oldTransition = await oldReconciler.query<{ reconciliation_started_at: Date }>(
          `UPDATE agent_invocations
              SET state = 'RECONCILING', reconciliation_reason = 'JOURNAL_LOST',
                  reconciliation_started_at = date_trunc('milliseconds', clock_timestamp())
            WHERE id = $1 AND state = 'PERSISTED'
            RETURNING reconciliation_started_at`,
          [accepted.invocationId],
        );
        await expect(
          oldReconciler.query(
            `INSERT INTO agent_invocation_events (
               invocation_id, creator_id, consumer_subject_id, journal_seq, source,
               source_event_id, event_type, payload, occurred_at
             )
             SELECT $1, $2, $3, COALESCE(max(journal_seq), 0) + 1,
                    'RECONCILER', $4, 'invocation.reconciling', $5::jsonb, $6
               FROM agent_invocation_events WHERE invocation_id = $1`,
            [
              accepted.invocationId,
              ids.creatorId,
              ids.consumerId,
              rootSourceEventId,
              JSON.stringify({ state: 'RECONCILING', reason: 'JOURNAL_LOST' }),
              oldTransition.rows[0]!.reconciliation_started_at,
            ],
          ),
        ).rejects.toMatchObject({ code: '42501' });
        await oldReconciler.query('ROLLBACK');
      } finally {
        await oldReconciler.query('ROLLBACK').catch(() => undefined);
        oldReconciler.release();
      }

      await journal.beginReconciliation({
        creatorId: ids.creatorId,
        consumerId: ids.consumerId,
        conversationId,
        invocationId: accepted.invocationId,
        sourceEventId: rootSourceEventId,
        reason: 'JOURNAL_LOST',
      });
      const started = startedInput(prepared, committedPrepared.startCommandId);
      await journal.commitStarted(started);

      await broker.query('BEGIN');
      await broker.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await broker.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumerId]);
      await broker.query(`UPDATE agent_invocations SET state = 'RECONCILING' WHERE id = $1`, [
        accepted.invocationId,
      ]);
      await expect(
        broker.query(
          `INSERT INTO agent_invocation_events (
             invocation_id, creator_id, consumer_subject_id, journal_seq, source,
             source_event_id, event_type, payload, occurred_at
           )
           SELECT $1, $2, $3, COALESCE(max(journal_seq), 0) + 1,
                  'RECONCILER', $4, 'invocation.reconciling_resumed', $5::jsonb,
                  clock_timestamp()
             FROM agent_invocation_events WHERE invocation_id = $1`,
          [
            accepted.invocationId,
            ids.creatorId,
            ids.consumerId,
            `resume-reconciliation:${rootSourceEventId}:${started.fact.sourceEventId}`,
            JSON.stringify({ state: 'RECONCILING', reason: 'JOURNAL_LOST' }),
          ],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await broker.query('ROLLBACK');
    } finally {
      await broker.query('ROLLBACK').catch(() => undefined);
      broker.release();
    }
    await expect(
      owner.query<{ state: string; roots: string; resumed: string }>(
        `SELECT invocation.state,
                count(event.id) FILTER (
                  WHERE event.event_type = 'invocation.reconciling'
                )::text AS roots,
                count(event.id) FILTER (
                  WHERE event.event_type = 'invocation.reconciling_resumed'
                )::text AS resumed
           FROM agent_invocations AS invocation
           JOIN agent_invocation_events AS event ON event.invocation_id = invocation.id
          WHERE invocation.id = $1
          GROUP BY invocation.state`,
        [accepted.invocationId],
      ),
    ).resolves.toMatchObject({ rows: [{ state: 'RUNNING', roots: '1', resumed: '0' }] });
  });

  it('rejects same-transaction re-entry to terminal without a resumed Event', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignDispatchPending(accepted);
    const prepared = preparedInput(accepted, authority);
    const committedPrepared = await journal.commitPrepared(prepared);
    if (!committedPrepared.startCommandId) throw new Error('expected start command');
    await markStartSent(committedPrepared.startCommandId);
    const rootSourceEventId = randomUuidV7();
    const reconciliationInput = {
      creatorId: ids.creatorId,
      consumerId: ids.consumerId,
      conversationId,
      invocationId: accepted.invocationId,
      sourceEventId: rootSourceEventId,
      reason: 'JOURNAL_LOST' as const,
    };
    await journal.beginReconciliation(reconciliationInput);
    const started = startedInput(prepared, committedPrepared.startCommandId);
    await journal.commitStarted(started);

    const reconciler = await reconcilerPool.connect();
    const bindContext = async (): Promise<void> => {
      await reconciler.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await reconciler.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumerId]);
    };
    try {
      await reconciler.query('BEGIN');
      await bindContext();
      await reconciler.query(`UPDATE agent_invocations SET state = 'RECONCILING' WHERE id = $1`, [
        accepted.invocationId,
      ]);
      await reconciler.query(
        `UPDATE agent_invocations
            SET state = 'FAILED', error_code = 'SNAPSHOT_MISMATCH',
                terminal_at = clock_timestamp()
          WHERE id = $1`,
        [accepted.invocationId],
      );
      await expect(reconciler.query('COMMIT')).rejects.toMatchObject({
        code: '23514',
        message: expect.stringContaining('requires exact durable resumed Event'),
      });
      await reconciler.query('ROLLBACK');

      await reconciler.query('BEGIN');
      await bindContext();
      await reconciler.query(`UPDATE agent_invocations SET state = 'RECONCILING' WHERE id = $1`, [
        accepted.invocationId,
      ]);
      await reconciler.query(
        `INSERT INTO agent_invocation_events (
           invocation_id, creator_id, consumer_subject_id, journal_seq, source,
           source_event_id, event_type, payload, occurred_at
         )
         SELECT $1, $2, $3, COALESCE(max(journal_seq), 0) + 1,
                'RECONCILER', $4, 'invocation.reconciling_resumed', $5::jsonb,
                clock_timestamp()
           FROM agent_invocation_events WHERE invocation_id = $1`,
        [
          accepted.invocationId,
          ids.creatorId,
          ids.consumerId,
          `resume-reconciliation:${rootSourceEventId}:${started.fact.sourceEventId}`,
          JSON.stringify({ state: 'RECONCILING', reason: 'JOURNAL_LOST' }),
        ],
      );
      await reconciler.query(
        `UPDATE agent_invocations
            SET state = 'FAILED', error_code = 'SNAPSHOT_MISMATCH',
                terminal_at = clock_timestamp()
          WHERE id = $1`,
        [accepted.invocationId],
      );
      await reconciler.query('COMMIT');
    } finally {
      await reconciler.query('ROLLBACK').catch(() => undefined);
      reconciler.release();
    }
    await expect(
      owner.query<{ state: string; resumed: string }>(
        `SELECT invocation.state,
                count(event.id) FILTER (
                  WHERE event.event_type = 'invocation.reconciling_resumed'
                )::text AS resumed
           FROM agent_invocations AS invocation
           JOIN agent_invocation_events AS event ON event.invocation_id = invocation.id
          WHERE invocation.id = $1
          GROUP BY invocation.state`,
        [accepted.invocationId],
      ),
    ).resolves.toMatchObject({ rows: [{ state: 'FAILED', resumed: '1' }] });
  });

  it('rolls back every reconciliation re-entry crash window and retries exactly once', async () => {
    for (const target of [
      'INVOCATION_RECONCILING',
      'RECONCILING_RESUMED_EVENT',
    ] satisfies CloudJournalStep[]) {
      const conversationId = await createConversation();
      const accepted = acceptInput(conversationId);
      const baseJournal = new PostgresCloudJournal(journalPools);
      await baseJournal.acceptInvocation(accepted);
      const authority = await assignDispatchPending(accepted);
      const prepared = preparedInput(accepted, authority);
      const committedPrepared = await baseJournal.commitPrepared(prepared);
      if (!committedPrepared.startCommandId) throw new Error('expected start command');
      await markStartSent(committedPrepared.startCommandId);
      const rootSourceEventId = randomUuidV7();
      const input = {
        creatorId: ids.creatorId,
        consumerId: ids.consumerId,
        conversationId,
        invocationId: accepted.invocationId,
        sourceEventId: rootSourceEventId,
        reason: 'JOURNAL_LOST' as const,
      };
      await baseJournal.beginReconciliation(input);
      const started = startedInput(prepared, committedPrepared.startCommandId);
      await expect(baseJournal.commitStarted(started)).resolves.toMatchObject({
        state: 'RUNNING',
        replayed: false,
      });

      const failing = new PostgresCloudJournal(journalPools, (step) => {
        if (step === target) throw new Error(`FAILPOINT:${target}`);
      });
      await expect(failing.beginReconciliation(input)).rejects.toThrow(`FAILPOINT:${target}`);
      const rolledBack = await owner.query<{
        state: string;
        root_events: string;
        resumed_events: string;
        events: string;
      }>(
        `SELECT invocation.state,
                (SELECT count(*) FROM agent_invocation_events
                  WHERE invocation_id = invocation.id
                    AND event_type = 'invocation.reconciling')::text AS root_events,
                (SELECT count(*) FROM agent_invocation_events
                  WHERE invocation_id = invocation.id
                    AND event_type = 'invocation.reconciling_resumed')::text AS resumed_events,
                (SELECT count(*) FROM agent_invocation_events
                  WHERE invocation_id = invocation.id)::text AS events
           FROM agent_invocations AS invocation WHERE invocation.id = $1`,
        [accepted.invocationId],
      );
      expect(rolledBack.rows[0], target).toEqual({
        state: 'RUNNING',
        root_events: '1',
        resumed_events: '0',
        events: '4',
      });

      const retried = await baseJournal.beginReconciliation(input);
      expect(retried).toMatchObject({ state: 'RECONCILING', replayed: false });
      const afterRetry = await counts(conversationId);
      expect(afterRetry.events).toBe('5');
      await expect(baseJournal.beginReconciliation(input)).resolves.toEqual({
        ...retried,
        replayed: true,
      });
      expect(await counts(conversationId)).toEqual(afterRetry);
    }
  });

  it('rejects a RECONCILING projection without its current resumed Event', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignDispatchPending(accepted);
    const prepared = preparedInput(accepted, authority);
    const committedPrepared = await journal.commitPrepared(prepared);
    if (!committedPrepared.startCommandId) throw new Error('expected start command');
    await markStartSent(committedPrepared.startCommandId);
    const input = {
      creatorId: ids.creatorId,
      consumerId: ids.consumerId,
      conversationId,
      invocationId: accepted.invocationId,
      sourceEventId: randomUuidV7(),
      reason: 'JOURNAL_LOST' as const,
    };
    await journal.beginReconciliation(input);
    const started = startedInput(prepared, committedPrepared.startCommandId);
    await journal.commitStarted(started);

    await expect(
      owner.query(`UPDATE agent_invocations SET state = 'RECONCILING' WHERE id = $1`, [
        accepted.invocationId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    const before = await counts(conversationId);
    expect(before.events).toBe('4');
    await expect(journal.beginReconciliation(input)).resolves.toMatchObject({
      state: 'RECONCILING',
      replayed: false,
    });
    const after = await counts(conversationId);
    expect(after.events).toBe('5');
    await expect(
      owner.query<{
        state: string;
        resumed_events: string;
      }>(
        `SELECT invocation.state,
                (SELECT count(*) FROM agent_invocation_events
                  WHERE invocation_id = invocation.id
                    AND event_type = 'invocation.reconciling_resumed')::text AS resumed_events
           FROM agent_invocations AS invocation WHERE invocation.id = $1`,
        [accepted.invocationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: 'RECONCILING', resumed_events: '1' }],
    });
  });

  it('records only deduplicated low-sensitivity integrity alerts through exact Reconciler authority', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    await new PostgresCloudJournal(journalPools).acceptInvocation(accepted);
    const sourceEventIdDigest = digest('8');
    const existingCanonicalDigest = digest('9');
    const receivedCanonicalDigest = digest('a');
    const connection = await reconcilerPool.connect();
    let alertId = '';
    try {
      await connection.query('BEGIN');
      await connection.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await connection.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumerId]);
      const first = await connection.query<{ alert_id: string; replayed: boolean }>(
        `SELECT * FROM creator_agent_record_journal_integrity_alert_v1(
           $1, $2, $3, 'SOURCE_EVENT_CONFLICT', 'WORKER', $4, $5, $6
         )`,
        [
          ids.creatorId,
          ids.consumerId,
          accepted.invocationId,
          sourceEventIdDigest,
          existingCanonicalDigest,
          receivedCanonicalDigest,
        ],
      );
      alertId = first.rows[0]?.alert_id ?? '';
      expect(alertId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(first.rows[0]?.replayed).toBe(false);
      const replay = await connection.query<{ alert_id: string; replayed: boolean }>(
        `SELECT * FROM creator_agent_record_journal_integrity_alert_v1(
           $1, $2, $3, 'SOURCE_EVENT_CONFLICT', 'WORKER', $4, $5, $6
         )`,
        [
          ids.creatorId,
          ids.consumerId,
          accepted.invocationId,
          sourceEventIdDigest,
          existingCanonicalDigest,
          receivedCanonicalDigest,
        ],
      );
      expect(replay.rows).toEqual([{ alert_id: alertId, replayed: true }]);
      const order = await connection.query<{ alert_id: string; replayed: boolean }>(
        `SELECT * FROM creator_agent_record_journal_integrity_alert_v1(
           $1, $2, $3, 'JOURNAL_ORDER_CONFLICT', 'RECONCILER', $4, $5, $5, 4, 6
         )`,
        [ids.creatorId, ids.consumerId, accepted.invocationId, digest('c'), digest('d')],
      );
      expect(order.rows[0]?.alert_id).toMatch(/^[0-9a-f-]{36}$/u);
      expect(order.rows[0]?.replayed).toBe(false);
      await connection.query('COMMIT');

      await expect(
        connection.query(`SELECT id FROM creator_agent_journal_integrity_alerts`),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        connection.query(
          `INSERT INTO creator_agent_journal_integrity_alerts (
             invocation_id, creator_id, consumer_subject_id, reason, source,
             source_event_id_digest, existing_canonical_digest, received_canonical_digest
           ) VALUES ($1, $2, $3, 'SOURCE_EVENT_CONFLICT', 'WORKER', $4, $5, $6)`,
          [
            accepted.invocationId,
            ids.creatorId,
            ids.consumerId,
            digest('b'),
            existingCanonicalDigest,
            receivedCanonicalDigest,
          ],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await connection.query('ROLLBACK').catch(() => undefined);
      connection.release();
    }

    await expect(
      owner.query(
        `SELECT * FROM creator_agent_record_journal_integrity_alert_v1(
           $1, $2, $3, 'SOURCE_EVENT_CONFLICT', 'WORKER', $4, $5, $6
         )`,
        [
          ids.creatorId,
          ids.consumerId,
          accepted.invocationId,
          sourceEventIdDigest,
          existingCanonicalDigest,
          receivedCanonicalDigest,
        ],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const durable = await owner.query<{
      alerts: string;
      reason: string;
      source: string;
      source_event_id_digest: string;
      existing_canonical_digest: string;
      received_canonical_digest: string;
    }>(
      `SELECT count(*)::text AS alerts, min(reason) AS reason, min(source) AS source,
              min(source_event_id_digest) AS source_event_id_digest,
              min(existing_canonical_digest) AS existing_canonical_digest,
              min(received_canonical_digest) AS received_canonical_digest
         FROM creator_agent_journal_integrity_alerts
        WHERE invocation_id = $1 AND reason = 'SOURCE_EVENT_CONFLICT'`,
      [accepted.invocationId],
    );
    expect(durable.rows[0]).toEqual({
      alerts: '1',
      reason: 'SOURCE_EVENT_CONFLICT',
      source: 'WORKER',
      source_event_id_digest: sourceEventIdDigest,
      existing_canonical_digest: existingCanonicalDigest,
      received_canonical_digest: receivedCanonicalDigest,
    });
    await expect(
      owner.query<{ alerts: string }>(
        `SELECT count(*)::text AS alerts
           FROM creator_agent_journal_integrity_alerts
          WHERE invocation_id = $1 AND reason = 'JOURNAL_ORDER_CONFLICT'
            AND existing_canonical_digest = received_canonical_digest
            AND expected_journal_seq = 4 AND received_journal_seq = 6`,
        [accepted.invocationId],
      ),
    ).resolves.toMatchObject({ rows: [{ alerts: '1' }] });
    await expect(
      owner.query(
        `UPDATE creator_agent_journal_integrity_alerts SET recorded_at = now() WHERE id = $1`,
        [alertId],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      owner.query(`DELETE FROM creator_agent_journal_integrity_alerts WHERE id = $1`, [alertId]),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('commits one sanitized reconciliation source conflict alert and dedupes repeated concurrency', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    await assignPersisted(accepted);
    const sourceEventId = randomUuidV7();
    const exactInput = {
      creatorId: ids.creatorId,
      consumerId: ids.consumerId,
      conversationId,
      invocationId: accepted.invocationId,
      sourceEventId,
      reason: 'JOURNAL_LOST' as const,
    };
    const admitted = await journal.beginReconciliation(exactInput);
    const before = await reconciliationBusinessFootprint(accepted.invocationId, conversationId);
    await expect(journal.beginReconciliation(exactInput)).resolves.toEqual({
      ...admitted,
      replayed: true,
    });
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toEqual([]);

    await expect(
      journal.beginReconciliation({
        ...exactInput,
        sourceEventId: randomUuidV7(),
        reason: 'HOST_EVIDENCE_LOST',
      }),
    ).rejects.toMatchObject({ code: 'TERMINAL_CONFLICT' });
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toEqual([]);
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      before,
    );

    const conflictInput = { ...exactInput, reason: 'HOST_EVIDENCE_LOST' as const };
    const firstConflict = await journal.beginReconciliation(conflictInput).then(
      () => null,
      (error: unknown) => error,
    );
    expect(firstConflict).toBeInstanceOf(Error);
    expect(firstConflict).toMatchObject({
      name: 'CloudJournalError',
      code: 'JOURNAL_SECURITY_BLOCKED',
      message: 'JOURNAL_SECURITY_BLOCKED',
    });
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      before,
    );

    const repeated = await Promise.allSettled(
      Array.from({ length: 8 }, () => journal.beginReconciliation(conflictInput)),
    );
    expect(repeated).toHaveLength(8);
    for (const outcome of repeated) {
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toMatchObject({
          code: 'JOURNAL_SECURITY_BLOCKED',
          message: 'JOURNAL_SECURITY_BLOCKED',
        });
      }
    }
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      before,
    );

    const alerts = await reconciliationIntegrityAlerts(accepted.invocationId);
    expect(alerts).toHaveLength(1);
    const expectedDigests = await reconciliationCanonicalDigests({
      creatorId: ids.creatorId,
      consumerId: ids.consumerId,
      conversationId,
      invocationId: accepted.invocationId,
      sourceEventId,
      existingReason: exactInput.reason,
      receivedReason: conflictInput.reason,
    });
    expect(alerts[0]).toMatchObject({
      invocation_id: accepted.invocationId,
      creator_id: ids.creatorId,
      consumer_subject_id: ids.consumerId,
      reason: 'SOURCE_EVENT_CONFLICT',
      source: 'RECONCILER',
      source_event_id_digest: expectedDigests.source_identity_digest,
      existing_canonical_digest: expectedDigests.existing_identity_digest,
      received_canonical_digest: expectedDigests.received_identity_digest,
      expected_journal_seq: null,
      received_journal_seq: null,
    });
    const serializedAlert = JSON.stringify(alerts[0]);
    expect(serializedAlert).not.toContain(sourceEventId);
    expect(serializedAlert).not.toContain(exactInput.reason);
    expect(serializedAlert).not.toContain(conflictInput.reason);

    const golden = await reconciliationCanonicalDigests({
      creatorId: '0198f00d-5000-7000-8000-000000000010',
      consumerId: '0198f00d-5000-7000-8000-000000000011',
      conversationId: '0198f00d-5000-7000-8000-000000000012',
      invocationId: '0198f00d-5000-7000-8000-000000000013',
      sourceEventId: '0198f00d-5000-7000-8000-000000000014',
      existingReason: 'JOURNAL_LOST',
      receivedReason: 'HOST_EVIDENCE_LOST',
    });
    expect(golden).toEqual({
      source_identity_digest: 'df412e52aa83fab44e23ae91e99ef9a3df8b67976aba6210830e7a21fa153a1e',
      existing_identity_digest: 'e804548e36120c0758c7176b655804253f0e53ee7168aec927612843bd391bf3',
      received_identity_digest: '71e67afd7cb67431d4cfa686d589a05f72123070b9947fe695e7aa26ad36ace5',
    });
  });

  it.each(['RUNNING', 'FAILED', 'LATE_PREPARED', 'LATE_STARTED'] as const)(
    'security-blocks the same logical reconciliation source with a different reason in %s',
    async (fixtureState) => {
      const conversationId = await createConversation();
      const accepted = acceptInput(conversationId);
      const journal = new PostgresCloudJournal(journalPools);
      await journal.acceptInvocation(accepted);
      const authority = await assignDispatchPending(accepted);
      const prepared = preparedInput(accepted, authority);
      let sourceEventId: string;
      let existingReason: 'JOURNAL_LOST' | 'START_DISPATCH_UNKNOWN' | 'CANCEL_NOT_CONFIRMED';

      if (fixtureState === 'LATE_PREPARED') {
        await owner.query(
          `UPDATE agent_invocations
              SET execution_capability_revoked_at = clock_timestamp()
            WHERE id = $1`,
          [accepted.invocationId],
        );
        await journal.commitPrepared(prepared);
        sourceEventId = prepared.fact.sourceEventId;
        existingReason = 'START_DISPATCH_UNKNOWN';
      } else {
        const committedPrepared = await journal.commitPrepared(prepared);
        if (!committedPrepared.startCommandId) throw new Error('expected start command');
        await markStartSent(committedPrepared.startCommandId);
        const started = startedInput(prepared, committedPrepared.startCommandId);
        if (fixtureState === 'LATE_STARTED') {
          await owner.query(
            `UPDATE agent_invocations
                SET execution_capability_revoked_at = clock_timestamp()
              WHERE id = $1`,
            [accepted.invocationId],
          );
          await journal.commitStarted(started);
          sourceEventId = started.fact.sourceEventId;
          existingReason = 'CANCEL_NOT_CONFIRMED';
        } else {
          sourceEventId = randomUuidV7();
          existingReason = 'JOURNAL_LOST';
          await journal.beginReconciliation({
            creatorId: ids.creatorId,
            consumerId: ids.consumerId,
            conversationId,
            invocationId: accepted.invocationId,
            sourceEventId,
            reason: existingReason,
          });
          await journal.commitStarted(started);
          if (fixtureState === 'FAILED') {
            await journal.commitFailed(failedInput(accepted, authority));
          }
        }
      }

      const exactInput = {
        creatorId: ids.creatorId,
        consumerId: ids.consumerId,
        conversationId,
        invocationId: accepted.invocationId,
        sourceEventId,
        reason: existingReason,
      };
      if (fixtureState === 'LATE_PREPARED' || fixtureState === 'LATE_STARTED') {
        await expect(journal.beginReconciliation(exactInput)).resolves.toMatchObject({
          state: 'RECONCILING',
          replayed: true,
        });
        expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toEqual([]);
      }
      const before = await reconciliationBusinessFootprint(accepted.invocationId, conversationId);
      const receivedReason =
        existingReason === 'JOURNAL_LOST' ? 'HOST_EVIDENCE_LOST' : 'JOURNAL_LOST';
      await expect(
        journal.beginReconciliation({ ...exactInput, reason: receivedReason }),
      ).rejects.toMatchObject({
        code: 'JOURNAL_SECURITY_BLOCKED',
        message: 'JOURNAL_SECURITY_BLOCKED',
      });
      expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
        before,
      );
      expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toHaveLength(1);
    },
  );

  it('rolls back an alert failpoint and dedupes after a committed alert ACK is lost', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const baseJournal = new PostgresCloudJournal(journalPools);
    await baseJournal.acceptInvocation(accepted);
    await assignPersisted(accepted);
    const input = {
      creatorId: ids.creatorId,
      consumerId: ids.consumerId,
      conversationId,
      invocationId: accepted.invocationId,
      sourceEventId: randomUuidV7(),
      reason: 'JOURNAL_LOST' as const,
    };
    await baseJournal.beginReconciliation(input);
    const conflict = { ...input, reason: 'MODEL_ATTEMPT_UNKNOWN' as const };
    const before = await reconciliationBusinessFootprint(accepted.invocationId, conversationId);

    const failing = new PostgresCloudJournal(journalPools, (step) => {
      if (step === 'JOURNAL_INTEGRITY_ALERT') {
        throw new Error('FAILPOINT:JOURNAL_INTEGRITY_ALERT');
      }
    });
    await expect(failing.beginReconciliation(conflict)).rejects.toThrow(
      'FAILPOINT:JOURNAL_INTEGRITY_ALERT',
    );
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toEqual([]);
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      before,
    );

    let loseCommitAcknowledgement = true;
    const ambiguousReconcilerPool: JournalPool = {
      async connect() {
        const client = await reconcilerPool.connect();
        return {
          async query<R = Record<string, unknown>>(
            sql: string,
            parameters?: readonly unknown[],
          ): Promise<QueryResult<R>> {
            const result = await client.query(sql, parameters as unknown[] | undefined);
            if (sql === 'COMMIT' && loseCommitAcknowledgement) {
              loseCommitAcknowledgement = false;
              throw new Error('SIMULATED_COMMIT_ACK_LOSS');
            }
            return result as unknown as QueryResult<R>;
          },
          release() {
            client.release();
          },
        };
      },
    };
    const ambiguousJournal = new PostgresCloudJournal({
      ...journalPools,
      reconciler: ambiguousReconcilerPool,
    });
    await expect(ambiguousJournal.beginReconciliation(conflict)).rejects.toThrow(
      'SIMULATED_COMMIT_ACK_LOSS',
    );
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toHaveLength(1);
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      before,
    );

    await expect(baseJournal.beginReconciliation(conflict)).rejects.toMatchObject({
      code: 'JOURNAL_SECURITY_BLOCKED',
      message: 'JOURNAL_SECURITY_BLOCKED',
    });
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toHaveLength(1);
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      before,
    );
  });

  it.each([
    { label: 'same Consumer tenant', crossConsumer: false },
    { label: 'different Consumer tenants', crossConsumer: true },
  ])(
    'serializes one global reconciliation source winner across $label',
    async ({ crossConsumer }) => {
      const secondConsumerId = crossConsumer
        ? (
            await owner.query<{ id: string }>(
              `INSERT INTO users (account) VALUES ($1) RETURNING id`,
              [account()],
            )
          ).rows[0]!.id
        : ids.consumerId;
      const firstConversationId = await createConversation();
      const secondConversationId = await createConversation({ consumerId: secondConsumerId });
      const first = acceptInput(firstConversationId);
      const second = acceptInput(secondConversationId, { consumerId: secondConsumerId });
      const journal = new PostgresCloudJournal(journalPools);
      await journal.acceptInvocation(first);
      await journal.acceptInvocation(second);
      await assignPersisted(first);
      await assignPersisted(second);
      const firstBefore = await reconciliationBusinessFootprint(
        first.invocationId,
        firstConversationId,
      );
      const secondBefore = await reconciliationBusinessFootprint(
        second.invocationId,
        secondConversationId,
      );
      const sourceEventId = randomUuidV7();
      const attempts = await Promise.allSettled([
        journal.beginReconciliation({
          creatorId: ids.creatorId,
          consumerId: ids.consumerId,
          conversationId: firstConversationId,
          invocationId: first.invocationId,
          sourceEventId,
          reason: 'JOURNAL_LOST',
        }),
        journal.beginReconciliation({
          creatorId: ids.creatorId,
          consumerId: secondConsumerId,
          conversationId: secondConversationId,
          invocationId: second.invocationId,
          sourceEventId,
          reason: 'HOST_EVIDENCE_LOST',
        }),
      ]);
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
      expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
      const loserIndex = attempts.findIndex((attempt) => attempt.status === 'rejected');
      const winnerIndex = loserIndex === 0 ? 1 : 0;
      const loser = loserIndex === 0 ? first : second;
      const winner = winnerIndex === 0 ? first : second;
      const loserConversationId = loserIndex === 0 ? firstConversationId : secondConversationId;
      const loserBefore = loserIndex === 0 ? firstBefore : secondBefore;
      const loserConsumerId = loserIndex === 0 ? ids.consumerId : secondConsumerId;
      const winnerConversationId = winnerIndex === 0 ? firstConversationId : secondConversationId;
      const rejected = attempts[loserIndex];
      if (rejected?.status !== 'rejected') throw new Error('expected one security-blocked loser');
      expect(rejected.reason).toMatchObject({
        code: 'JOURNAL_SECURITY_BLOCKED',
        message: 'JOURNAL_SECURITY_BLOCKED',
      });

      expect(
        await reconciliationBusinessFootprint(loser.invocationId, loserConversationId),
      ).toEqual(loserBefore);
      await expect(
        owner.query<{ state: string; roots: string }>(
          `SELECT invocation.state,
                (SELECT count(*) FROM agent_invocation_events
                  WHERE invocation_id = invocation.id
                    AND event_type = 'invocation.reconciling')::text AS roots
           FROM agent_invocations AS invocation WHERE invocation.id = $1`,
          [winner.invocationId],
        ),
      ).resolves.toMatchObject({ rows: [{ state: 'RECONCILING', roots: '1' }] });
      expect(winnerConversationId).not.toBe(loserConversationId);
      const loserAlerts = await reconciliationIntegrityAlerts(loser.invocationId);
      expect(loserAlerts).toHaveLength(1);
      expect(loserAlerts[0]).toMatchObject({
        creator_id: ids.creatorId,
        consumer_subject_id: loserConsumerId,
        reason: 'SOURCE_EVENT_CONFLICT',
        source: 'RECONCILER',
      });
      const serializedAlert = JSON.stringify(loserAlerts[0]);
      expect(serializedAlert).not.toContain(sourceEventId);
      expect(serializedAlert).not.toContain(winner.invocationId);
      expect(await reconciliationIntegrityAlerts(winner.invocationId)).toEqual([]);
    },
  );

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
    await expect(
      journal.beginReconciliation({
        creatorId: ids.creatorId,
        consumerId: ids.consumerId,
        conversationId,
        invocationId: accepted.invocationId,
        sourceEventId: started.fact.sourceEventId,
        reason: 'CANCEL_NOT_CONFIRMED',
      }),
    ).resolves.toMatchObject({ state: 'RECONCILING', replayed: true });
    await expect(
      owner.query<{ roots: string; resumed: string }>(
        `SELECT
           count(*) FILTER (WHERE event_type = 'invocation.reconciling')::text AS roots,
           count(*) FILTER (WHERE event_type = 'invocation.reconciling_resumed')::text AS resumed
         FROM agent_invocation_events WHERE invocation_id = $1`,
        [accepted.invocationId],
      ),
    ).resolves.toMatchObject({ rows: [{ roots: '1', resumed: '0' }] });

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
      reconciliation_events: string;
      reconciliation_source_event_id: string;
      reconciliation_payload: unknown;
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
                  AND source = 'RECONCILER'
                  AND event_type = 'invocation.reconciling')::text AS reconciliation_events,
              (SELECT source_event_id FROM agent_invocation_events
                WHERE invocation_id = invocation.id
                  AND source = 'RECONCILER'
                  AND event_type = 'invocation.reconciling') AS reconciliation_source_event_id,
              (SELECT payload FROM agent_invocation_events
                WHERE invocation_id = invocation.id
                  AND source = 'RECONCILER'
                  AND event_type = 'invocation.reconciling') AS reconciliation_payload,
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
      reconciliation_events: '1',
      reconciliation_source_event_id: `late-started:${started.fact.sourceEventId}`,
      reconciliation_payload: { state: 'RECONCILING', reason: 'CANCEL_NOT_CONFIRMED' },
      succeeded_events: '0',
      messages: '1',
      start_state: 'EXPIRED',
    });
  });

  it('commits a confirmed failure atomically without an Assistant Message and exact replay never duplicates it', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignRunning(accepted);
    const failed = failedInput(accepted, authority);

    const committed = await journal.commitFailed(failed);
    expect(committed).toEqual({
      invocationId: accepted.invocationId,
      state: 'FAILED',
      errorCode: 'TURN_FAILED',
      consumerEventCursor: expect.any(String),
      replayed: false,
    });
    await expect(journal.commitFailed(failed)).resolves.toEqual({
      ...committed,
      replayed: true,
    });

    const state = await owner.query<{
      messages: string;
      failed_events: string;
      state: string;
      result_message_id: string | null;
      result_digest: string | null;
      error_code: string;
      terminal_at: Date;
      conversation_state: string;
      consumer_events: string;
      latest_cursor: string;
      payload_digest: string;
      dedupe_key: string;
      payload: unknown;
      terminal_payload: unknown;
      terminal_event_id: string;
      terminal_source: string;
      terminal_source_event_id: string;
      terminal_fact_digest: string;
      terminal_occurred_at: Date;
      receipt_cursor: string;
      receipt_payload_digest: string;
      receipt_dedupe_key: string;
    }>(
      `SELECT
         (SELECT count(*) FROM agent_messages WHERE invocation_id = $1)::text AS messages,
         (SELECT count(*) FROM agent_invocation_events
           WHERE invocation_id = $1 AND event_type = 'invocation.failed')::text AS failed_events,
         invocation.state, invocation.result_message_id, invocation.result_digest,
         invocation.error_code, invocation.terminal_at,
         conversation.state AS conversation_state,
         (SELECT count(*) FROM consumer_event_outbox
           WHERE invocation_id = $1)::text AS consumer_events,
         (SELECT latest_cursor::text FROM consumer_event_streams
           WHERE conversation_id = invocation.conversation_id) AS latest_cursor,
         terminal_outbox.payload_digest, terminal_outbox.dedupe_key, terminal_outbox.payload,
         terminal_event.payload AS terminal_payload,
         terminal_event.id::text AS terminal_event_id,
         terminal_event.source AS terminal_source,
         terminal_event.source_event_id AS terminal_source_event_id,
         terminal_event.source_fact_digest AS terminal_fact_digest,
         terminal_event.occurred_at AS terminal_occurred_at,
         terminal_receipt.consumer_event_cursor::text AS receipt_cursor,
         terminal_receipt.payload_digest AS receipt_payload_digest,
         terminal_receipt.dedupe_key AS receipt_dedupe_key
       FROM agent_invocations AS invocation
       JOIN agent_conversations AS conversation ON conversation.id = invocation.conversation_id
       JOIN agent_invocation_events AS terminal_event
         ON terminal_event.invocation_id = invocation.id
        AND terminal_event.event_type = 'invocation.failed'
       JOIN consumer_event_outbox AS terminal_outbox
         ON terminal_outbox.invocation_id = invocation.id
        AND terminal_outbox.source_event_id = terminal_event.id
        AND terminal_outbox.event_type = 'invocation.terminal'
       JOIN creator_agent_failed_terminal_receipts AS terminal_receipt
         ON terminal_receipt.invocation_id = invocation.id
        AND terminal_receipt.terminal_event_id = terminal_event.id
        AND terminal_receipt.consumer_event_cursor = terminal_outbox.cursor
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
      terminalState: 'FAILED',
      assistantMessageId: null,
      resultDigest: null,
      errorCode: 'TURN_FAILED',
    });
    expect(state.rows[0]).toEqual({
      messages: '1',
      failed_events: '1',
      state: 'FAILED',
      result_message_id: null,
      result_digest: null,
      error_code: 'TURN_FAILED',
      terminal_at: expect.any(Date),
      conversation_state: 'IDLE',
      consumer_events: '1',
      latest_cursor: committed.consumerEventCursor,
      payload_digest: consumerEventPayloadDigest(terminalPayload),
      dedupe_key: consumerEventDedupeKey({
        ownerId: ids.consumerId,
        sourceEventId: state.rows[0]!.terminal_event_id,
        eventType: 'invocation.terminal',
      }),
      payload: terminalPayload,
      terminal_payload: { state: 'FAILED', errorCode: 'TURN_FAILED' },
      terminal_event_id: expect.any(String),
      terminal_source: 'WORKER',
      terminal_source_event_id: accepted.invocationId,
      terminal_fact_digest: failed.factDigest,
      terminal_occurred_at: expect.any(Date),
      receipt_cursor: committed.consumerEventCursor,
      receipt_payload_digest: consumerEventPayloadDigest(terminalPayload),
      receipt_dedupe_key: consumerEventDedupeKey({
        ownerId: ids.consumerId,
        sourceEventId: state.rows[0]!.terminal_event_id,
        eventType: 'invocation.terminal',
      }),
    });
    expect(state.rows[0]!.terminal_occurred_at.toISOString()).toBe(
      state.rows[0]!.terminal_at.toISOString(),
    );
    expect(terminalPayload.occurredAt).toBe(state.rows[0]!.terminal_at.toISOString());
    const databaseDigests = await owner.query<{
      fact_digest: string;
      payload_digest: string;
      dedupe_key: string;
    }>(
      `SELECT creator_agent_worker_failed_fact_digest_v1(
                $1, $2, $3, $4, $5, $6, $7, $8
              ) AS fact_digest,
              creator_agent_failed_consumer_payload_digest_v1(
                $9, $2, $8, $10
              ) AS payload_digest,
              creator_agent_failed_consumer_dedupe_key_v1($11, $12) AS dedupe_key`,
      [
        failed.fact.sourceEventId,
        failed.fact.invocationId,
        failed.fact.agentVersionDigest,
        failed.fact.snapshotDigest,
        failed.fact.executionCapabilityDigest,
        failed.fact.leaseId,
        failed.fact.fence,
        failed.fact.errorCode,
        conversationId,
        terminalPayload.occurredAt,
        ids.consumerId,
        state.rows[0]!.terminal_event_id,
      ],
    );
    expect(databaseDigests.rows).toEqual([
      {
        fact_digest: failed.factDigest,
        payload_digest: consumerEventPayloadDigest(terminalPayload),
        dedupe_key: consumerEventDedupeKey({
          ownerId: ids.consumerId,
          sourceEventId: state.rows[0]!.terminal_event_id,
          eventType: 'invocation.terminal',
        }),
      },
    ]);
    const goldenFact: WorkerInvocationFailedFact = {
      protocol: WORKER_INVOCATION_FACT_PROTOCOL,
      schemaVersion: 1,
      type: 'invocation.failed',
      sourceEventId: '0198f00d-5000-7000-8000-000000000013',
      invocationId: '0198f00d-5000-7000-8000-000000000013',
      agentVersionDigest: digest('a'),
      snapshotDigest: digest('b'),
      executionCapabilityDigest: digest('c'),
      leaseId: '0198f00d-5000-7000-8000-000000000015',
      fence: '7',
      errorCode: 'TURN_FAILED',
    };
    const goldenPayload = ConsumerTerminalEventPayloadSchema.parse({
      protocol: CONSUMER_EVENT_OUTBOX_PROTOCOL,
      schemaVersion: 1,
      type: 'invocation.terminal',
      conversationId: '0198f00d-5000-7000-8000-000000000012',
      invocationId: goldenFact.invocationId,
      terminalState: 'FAILED',
      assistantMessageId: null,
      resultDigest: null,
      errorCode: goldenFact.errorCode,
      occurredAt: '2026-08-20T08:00:10.123Z',
    });
    const factGolden = '869a68366e876060ce899ebda7da9ac86656230267e95578bb799856e2180173';
    const payloadGolden = '07ef5b866ba609d187a5dc036121c5c816fd927a8ce5e63d0ec0e41402b8fe04';
    const dedupeGolden = 'f80d5d425897b0e6a8668e1faaa20ec3c9bfa4ed253d8e6e1f4dc8d7452e0d9d';
    expect(workerInvocationFactDigest(goldenFact)).toBe(factGolden);
    expect(consumerEventPayloadDigest(goldenPayload)).toBe(payloadGolden);
    expect(
      consumerEventDedupeKey({
        ownerId: '0198f00d-5000-7000-8000-000000000011',
        sourceEventId: '42',
        eventType: 'invocation.terminal',
      }),
    ).toBe(dedupeGolden);
    await expect(
      owner.query<{ fact_digest: string; payload_digest: string; dedupe_key: string }>(
        `SELECT creator_agent_worker_failed_fact_digest_v1(
                  $1, $2, $3, $4, $5, $6, $7, $8
                ) AS fact_digest,
                creator_agent_failed_consumer_payload_digest_v1(
                  $9, $2, $8, $10
                ) AS payload_digest,
                creator_agent_failed_consumer_dedupe_key_v1($11, 42) AS dedupe_key`,
        [
          goldenFact.sourceEventId,
          goldenFact.invocationId,
          goldenFact.agentVersionDigest,
          goldenFact.snapshotDigest,
          goldenFact.executionCapabilityDigest,
          goldenFact.leaseId,
          goldenFact.fence,
          goldenFact.errorCode,
          goldenPayload.conversationId,
          goldenPayload.occurredAt,
          '0198f00d-5000-7000-8000-000000000011',
        ],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          fact_digest: factGolden,
          payload_digest: payloadGolden,
          dedupe_key: dedupeGolden,
        },
      ],
    });

    if (committed.consumerEventCursor === null) {
      throw new Error('expected retained failed Consumer event');
    }
    await publishAndPruneTerminalEvent(journal, {
      conversationId,
      cursor: committed.consumerEventCursor,
    });
    await expect(
      owner.query<{ receipt_cursor: string; payload_digest: string; dedupe_key: string }>(
        `SELECT consumer_event_cursor::text AS receipt_cursor, payload_digest, dedupe_key
           FROM creator_agent_failed_terminal_receipts
          WHERE invocation_id = $1`,
        [accepted.invocationId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          receipt_cursor: committed.consumerEventCursor,
          payload_digest: consumerEventPayloadDigest(terminalPayload),
          dedupe_key: consumerEventDedupeKey({
            ownerId: ids.consumerId,
            sourceEventId: state.rows[0]!.terminal_event_id,
            eventType: 'invocation.terminal',
          }),
        },
      ],
    });
    await expect(journal.commitFailed(failed)).resolves.toEqual({
      ...committed,
      consumerEventCursor: null,
      replayed: true,
    });
    await expect(
      journal.beginReconciliation({
        creatorId: ids.creatorId,
        consumerId: ids.consumerId,
        conversationId,
        invocationId: accepted.invocationId,
        sourceEventId: randomUuidV7(),
        reason: 'JOURNAL_LOST',
      }),
    ).rejects.toMatchObject<Partial<CloudJournalError>>({ code: 'TERMINAL_CONFLICT' });
    const beforeSuccessConflict = await reconciliationBusinessFootprint(
      accepted.invocationId,
      conversationId,
    );
    const alertsBeforeSuccessConflict = (await reconciliationIntegrityAlerts(accepted.invocationId))
      .length;
    const forbiddenSuccessSealer = vi.fn(sealAssistantMessage);
    await expect(
      journal.commitSuccess(successInput(accepted, authority), forbiddenSuccessSealer),
    ).rejects.toMatchObject<Partial<CloudJournalError>>({
      code: 'JOURNAL_SECURITY_BLOCKED',
      message: 'JOURNAL_SECURITY_BLOCKED',
    });
    expect(forbiddenSuccessSealer).not.toHaveBeenCalled();
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      beforeSuccessConflict,
    );
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toHaveLength(
      alertsBeforeSuccessConflict + 1,
    );
    await expect(
      owner.query(
        `SELECT
           (SELECT count(*) FROM agent_invocation_events
             WHERE invocation_id = $1 AND event_type = 'invocation.failed')::text
             AS failed_events,
           (SELECT count(*) FROM agent_invocation_events
             WHERE invocation_id = $1 AND event_type = 'invocation.succeeded')::text
             AS succeeded_events,
           (SELECT count(*) FROM consumer_event_outbox
             WHERE invocation_id = $1)::text AS retained_consumer_events
         FROM agent_invocations WHERE id = $1`,
        [accepted.invocationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ failed_events: '1', succeeded_events: '0', retained_consumer_events: '0' }],
    });
  });

  it.each([
    'SNAPSHOT_DIGEST_MISMATCH',
    'PROTOCOL_INCOMPATIBLE',
    'SANDBOX_ATTESTATION_FAILED',
    'RUNTIME_START_FAILED',
    'MODEL_QUOTA_EXHAUSTED',
    'TURN_TIMEOUT',
    'TURN_FAILED',
  ] as const)(
    'admits confirmed failure code %s through one DB terminal authority',
    async (errorCode) => {
      const conversationId = await createConversation();
      const accepted = acceptInput(conversationId);
      const journal = new PostgresCloudJournal(journalPools);
      await journal.acceptInvocation(accepted);
      const authority = await assignRunning(accepted);
      await expect(
        journal.commitFailed(failedInput(accepted, authority, errorCode)),
      ).resolves.toMatchObject({
        invocationId: accepted.invocationId,
        state: 'FAILED',
        errorCode,
        consumerEventCursor: expect.any(String),
        replayed: false,
      });
    },
  );

  it('security-blocks every mutable failed body field and dedupes concurrent repeats', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignRunning(accepted);
    const failed = failedInput(accepted, authority, 'TURN_FAILED');
    await journal.commitFailed(failed);
    const before = await reconciliationBusinessFootprint(accepted.invocationId, conversationId);
    const mutatedFacts: WorkerInvocationFailedFact[] = [
      { ...failed.fact, agentVersionDigest: digest('2') },
      { ...failed.fact, snapshotDigest: digest('3') },
      { ...failed.fact, executionCapabilityDigest: digest('7') },
      { ...failed.fact, leaseId: randomUuidV7() },
      { ...failed.fact, fence: '2' },
      { ...failed.fact, errorCode: 'TURN_TIMEOUT' },
    ];
    for (const fact of mutatedFacts) {
      await expect(
        journal.commitFailed({
          ...failed,
          fact,
          factDigest: workerInvocationFactDigest(fact),
        }),
      ).rejects.toMatchObject({
        code: 'JOURNAL_SECURITY_BLOCKED',
        message: 'JOURNAL_SECURITY_BLOCKED',
      });
    }
    const repeated = await Promise.allSettled(
      Array.from({ length: 8 }, () => {
        const fact = mutatedFacts[0]!;
        return journal.commitFailed({
          ...failed,
          fact,
          factDigest: workerInvocationFactDigest(fact),
        });
      }),
    );
    expect(repeated.every((result) => result.status === 'rejected')).toBe(true);
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      before,
    );
    const alerts = await reconciliationIntegrityAlerts(accepted.invocationId);
    expect(alerts).toHaveLength(mutatedFacts.length);
    expect(alerts.every((alert) => alert.source === 'WORKER')).toBe(true);
  });

  it('returns a failed SECURITY_BLOCKED marker inside a caller transaction and standalone throws post-commit', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignRunning(accepted);
    const failed = failedInput(accepted, authority, 'TURN_FAILED');
    await journal.commitFailed(failed);
    const conflictFact: WorkerInvocationFailedFact = {
      ...failed.fact,
      errorCode: 'TURN_TIMEOUT',
    };
    const conflict = {
      ...failed,
      fact: conflictFact,
      factDigest: workerInvocationFactDigest(conflictFact),
    };
    const before = await reconciliationBusinessFootprint(accepted.invocationId, conversationId);
    const broker = await brokerPool.connect();
    try {
      await broker.query('BEGIN');
      await broker.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await broker.query(`SELECT set_config('app.consumer_id', '', true)`);
      const outcome = await journal.projectFailed(
        gatewayProjectorTransaction(broker),
        conflict,
        AbortSignal.timeout(5_000),
      );
      expect(outcome).toEqual({ kind: 'SECURITY_BLOCKED' });
      await broker.query('COMMIT');
    } finally {
      await broker.query('ROLLBACK').catch(() => undefined);
      broker.release();
    }
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toHaveLength(1);
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      before,
    );
    await expect(journal.commitFailed(conflict)).rejects.toMatchObject({
      code: 'JOURNAL_SECURITY_BLOCKED',
      message: 'JOURNAL_SECURITY_BLOCKED',
    });
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toHaveLength(1);
  });

  it('security-blocks a confirmed failed fact after the same terminal source already succeeded', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignRunning(accepted);
    await journal.commitSuccess(successInput(accepted, authority), sealAssistantMessage);
    const before = await reconciliationBusinessFootprint(accepted.invocationId, conversationId);
    await expect(journal.commitFailed(failedInput(accepted, authority))).rejects.toMatchObject({
      code: 'JOURNAL_SECURITY_BLOCKED',
      message: 'JOURNAL_SECURITY_BLOCKED',
    });
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      before,
    );
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toMatchObject([
      { reason: 'SOURCE_EVENT_CONFLICT', source: 'WORKER' },
    ]);
  });

  it('security-blocks a succeeded fact after the same terminal source already failed', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignRunning(accepted);
    await journal.commitFailed(failedInput(accepted, authority));
    const before = await reconciliationBusinessFootprint(accepted.invocationId, conversationId);
    const forbiddenSealer = vi.fn<AssistantMessageSealer>(() => {
      throw new Error('TERMINAL_CONFLICT_MUST_NOT_SEAL');
    });
    await expect(
      journal.commitSuccess(successInput(accepted, authority), forbiddenSealer),
    ).rejects.toMatchObject({
      code: 'JOURNAL_SECURITY_BLOCKED',
      message: 'JOURNAL_SECURITY_BLOCKED',
    });
    expect(forbiddenSealer).not.toHaveBeenCalled();
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      before,
    );
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toMatchObject([
      { reason: 'SOURCE_EVENT_CONFLICT', source: 'WORKER' },
    ]);
  });

  it('rolls back a failed alert failpoint and dedupes after standalone COMMIT ACK loss', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const baseJournal = new PostgresCloudJournal(journalPools);
    await baseJournal.acceptInvocation(accepted);
    const authority = await assignRunning(accepted);
    const failed = failedInput(accepted, authority, 'TURN_FAILED');
    await baseJournal.commitFailed(failed);
    const conflictFact: WorkerInvocationFailedFact = {
      ...failed.fact,
      errorCode: 'TURN_TIMEOUT',
    };
    const conflict = {
      ...failed,
      fact: conflictFact,
      factDigest: workerInvocationFactDigest(conflictFact),
    };
    const before = await reconciliationBusinessFootprint(accepted.invocationId, conversationId);
    const failing = new PostgresCloudJournal(journalPools, (step) => {
      if (step === 'JOURNAL_INTEGRITY_ALERT') {
        throw new Error('FAILPOINT:FAILED_JOURNAL_INTEGRITY_ALERT');
      }
    });
    await expect(failing.commitFailed(conflict)).rejects.toThrow(
      'FAILPOINT:FAILED_JOURNAL_INTEGRITY_ALERT',
    );
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toEqual([]);
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      before,
    );

    let loseCommitAcknowledgement = true;
    const ambiguousBrokerPool: JournalPool = {
      async connect() {
        const client = await brokerPool.connect();
        return {
          async query<R = Record<string, unknown>>(
            sql: string,
            parameters?: readonly unknown[],
          ): Promise<QueryResult<R>> {
            const result = await client.query(sql, parameters as unknown[] | undefined);
            if (sql === 'COMMIT' && loseCommitAcknowledgement) {
              loseCommitAcknowledgement = false;
              throw new Error('SIMULATED_FAILED_COMMIT_ACK_LOSS');
            }
            return result as unknown as QueryResult<R>;
          },
          release() {
            client.release();
          },
        };
      },
    };
    const ambiguousJournal = new PostgresCloudJournal({
      ...journalPools,
      broker: ambiguousBrokerPool,
    });
    await expect(ambiguousJournal.commitFailed(conflict)).rejects.toThrow(
      'SIMULATED_FAILED_COMMIT_ACK_LOSS',
    );
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toHaveLength(1);
    expect(await reconciliationBusinessFootprint(accepted.invocationId, conversationId)).toEqual(
      before,
    );
    await expect(baseJournal.commitFailed(conflict)).rejects.toMatchObject({
      code: 'JOURNAL_SECURITY_BLOCKED',
      message: 'JOURNAL_SECURITY_BLOCKED',
    });
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toHaveLength(1);
  });

  it.each(['CANCEL_REQUESTED', 'RECONCILING'] as const)(
    'commits a confirmed failure from %s without weakening the running authority chain',
    async (preterminalState) => {
      const conversationId = await createConversation();
      const accepted = acceptInput(conversationId);
      const journal = new PostgresCloudJournal(journalPools);
      await journal.acceptInvocation(accepted);
      const authority = await assignRunning(accepted);

      if (preterminalState === 'CANCEL_REQUESTED') {
        await owner.query(
          `UPDATE agent_invocations
              SET state = 'CANCEL_REQUESTED', cancel_requested_at = clock_timestamp()
            WHERE id = $1`,
          [accepted.invocationId],
        );
      } else {
        await journal.beginReconciliation({
          creatorId: ids.creatorId,
          consumerId: ids.consumerId,
          conversationId,
          invocationId: accepted.invocationId,
          sourceEventId: randomUuidV7(),
          reason: 'JOURNAL_LOST',
        });
      }

      await expect(journal.commitFailed(failedInput(accepted, authority))).resolves.toMatchObject({
        invocationId: accepted.invocationId,
        state: 'FAILED',
        errorCode: 'TURN_FAILED',
        replayed: false,
      });
      await expect(
        owner.query(
          `SELECT invocation.state, invocation.error_code,
                  conversation.state AS conversation_state,
                  (SELECT count(*) FROM agent_invocation_events
                    WHERE invocation_id = invocation.id
                      AND event_type = 'invocation.failed')::text AS failed_events
             FROM agent_invocations AS invocation
             JOIN agent_conversations AS conversation
               ON conversation.id = invocation.conversation_id
            WHERE invocation.id = $1`,
          [accepted.invocationId],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            state: 'FAILED',
            error_code: 'TURN_FAILED',
            conversation_state: 'IDLE',
            failed_events: '1',
          },
        ],
      });
    },
  );

  it.each(['EXPIRED', 'REVOKED'] as const)(
    'rejects a fresh confirmed failure after its Execution Capability is %s',
    async (capabilityState) => {
      const conversationId = await createConversation();
      const accepted = acceptInput(conversationId);
      const journal = new PostgresCloudJournal(journalPools);
      await journal.acceptInvocation(accepted);
      const authority = await assignRunning(accepted);
      if (capabilityState === 'EXPIRED') {
        await timeWarpCapabilityExpiry(accepted.invocationId, '-1 second');
      } else {
        await owner.query(
          `UPDATE agent_invocations
              SET execution_capability_revoked_at = clock_timestamp()
            WHERE id = $1`,
          [accepted.invocationId],
        );
      }

      await expect(journal.commitFailed(failedInput(accepted, authority))).rejects.toMatchObject<
        Partial<CloudJournalError>
      >({
        code: 'EXECUTION_AUTHORITY_MISMATCH',
      });
      await expect(
        owner.query(
          `SELECT state, error_code, terminal_at,
                  (SELECT count(*) FROM agent_invocation_events
                    WHERE invocation_id = $1
                      AND event_type = 'invocation.failed')::text AS failed_events,
                  (SELECT count(*) FROM consumer_event_outbox
                    WHERE invocation_id = $1)::text AS consumer_events
             FROM agent_invocations WHERE id = $1`,
          [accepted.invocationId],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            state: 'RUNNING',
            error_code: null,
            terminal_at: null,
            failed_events: '0',
            consumer_events: '0',
          },
        ],
      });
    },
  );

  it('rejects non-canonical, unknown, pre-dispatch, and pre-RUNNING failure facts with zero terminal mutation', async () => {
    const runningConversationId = await createConversation();
    const runningAccepted = acceptInput(runningConversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(runningAccepted);
    const runningAuthority = await assignRunning(runningAccepted);
    const failed = failedInput(runningAccepted, runningAuthority);

    await expect(
      journal.commitFailed({ ...failed, factDigest: digest('0') }),
    ).rejects.toMatchObject<Partial<CloudJournalError>>({ code: 'WORKER_FACT_CONFLICT' });
    for (const errorCode of ['UNKNOWN_FAILURE', 'INVOCATION_DEADLINE_EXPIRED']) {
      const rejectedFact: WorkerInvocationFailedFact = { ...failed.fact, errorCode };
      await expect(
        journal.commitFailed({
          ...failed,
          fact: rejectedFact,
          factDigest: workerInvocationFactDigest(rejectedFact),
        }),
      ).rejects.toMatchObject<Partial<CloudJournalError>>({ code: 'WORKER_FACT_CONFLICT' });
    }
    for (const factPatch of [
      { snapshotDigest: digest('9') },
      { agentVersionDigest: digest('8') },
      { executionCapabilityDigest: digest('6') },
      { leaseId: randomUuidV7() },
      { fence: '9223372036854775807' },
    ] satisfies readonly Partial<WorkerInvocationFailedFact>[]) {
      const rejectedFact: WorkerInvocationFailedFact = { ...failed.fact, ...factPatch };
      await expect(
        journal.commitFailed({
          ...failed,
          fact: rejectedFact,
          factDigest: workerInvocationFactDigest(rejectedFact),
        }),
      ).rejects.toMatchObject<Partial<CloudJournalError>>({
        code: 'EXECUTION_AUTHORITY_MISMATCH',
      });
    }
    await expect(
      journal.commitFailed({ ...failed, installationId: randomUuidV7() }),
    ).rejects.toMatchObject<Partial<CloudJournalError>>({
      code: 'EXECUTION_AUTHORITY_MISMATCH',
    });
    await expect(
      owner.query(
        `SELECT state, result_message_id, result_digest, error_code, terminal_at,
                (SELECT count(*) FROM agent_invocation_events
                  WHERE invocation_id = $1
                    AND event_type = 'invocation.failed')::text AS failed_events,
                (SELECT count(*) FROM consumer_event_outbox
                  WHERE invocation_id = $1)::text AS consumer_events
           FROM agent_invocations WHERE id = $1`,
        [runningAccepted.invocationId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: 'RUNNING',
          result_message_id: null,
          result_digest: null,
          error_code: null,
          terminal_at: null,
          failed_events: '0',
          consumer_events: '0',
        },
      ],
    });

    const persistedConversationId = await createConversation();
    const persistedAccepted = acceptInput(persistedConversationId);
    await journal.acceptInvocation(persistedAccepted);
    const persistedAuthority = await assignDispatchPending(persistedAccepted);
    await journal.commitPrepared(preparedInput(persistedAccepted, persistedAuthority));
    await expect(
      journal.commitFailed(failedInput(persistedAccepted, persistedAuthority)),
    ).rejects.toMatchObject<Partial<CloudJournalError>>({
      code: 'EXECUTION_AUTHORITY_MISMATCH',
    });
    expect(await counts(persistedConversationId)).toMatchObject({
      messages: '1',
      events: '2',
      consumer_events: '0',
      consumer_streams: '0',
      conversation_state: 'BUSY',
    });
    await expect(
      owner.query(`SELECT state, error_code, terminal_at FROM agent_invocations WHERE id = $1`, [
        persistedAccepted.invocationId,
      ]),
    ).resolves.toMatchObject({
      rows: [{ state: 'PERSISTED', error_code: null, terminal_at: null }],
    });
  });

  it('blocks the legacy direct failed writer without rolling forward its terminal projection', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignRunning(accepted);
    const failed = failedInput(accepted, authority);
    const legacyWriter = await brokerPool.connect();
    try {
      await legacyWriter.query('BEGIN');
      await legacyWriter.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await legacyWriter.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumerId]);
      const terminal = await legacyWriter.query<{ terminal_at: Date }>(
        `UPDATE agent_invocations
            SET state = 'FAILED', error_code = $2,
                terminal_at = date_trunc('milliseconds', clock_timestamp())
          WHERE id = $1
          RETURNING terminal_at`,
        [accepted.invocationId, failed.fact.errorCode],
      );
      await expect(
        legacyWriter.query(
          `INSERT INTO agent_invocation_events (
             invocation_id, creator_id, consumer_subject_id, journal_seq, source,
             source_event_id, event_type, payload, occurred_at,
             source_fact_digest, broker_command_id
           ) VALUES (
             $1, $2, $3, 4, 'WORKER', $4, 'invocation.failed', $5::jsonb, $6, $7, NULL
           )`,
          [
            accepted.invocationId,
            ids.creatorId,
            ids.consumerId,
            failed.fact.sourceEventId,
            JSON.stringify({ state: 'FAILED', errorCode: failed.fact.errorCode }),
            terminal.rows[0]!.terminal_at,
            failed.factDigest,
          ],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await legacyWriter.query('ROLLBACK').catch(() => undefined);
      legacyWriter.release();
    }
    await expect(
      owner.query<{
        state: string;
        failed_events: string;
        consumer_events: string;
      }>(
        `SELECT invocation.state,
                (SELECT count(*) FROM agent_invocation_events
                  WHERE invocation_id = invocation.id
                    AND event_type = 'invocation.failed')::text AS failed_events,
                (SELECT count(*) FROM consumer_event_outbox
                  WHERE invocation_id = invocation.id)::text AS consumer_events
           FROM agent_invocations AS invocation WHERE invocation.id = $1`,
        [accepted.invocationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: 'RUNNING', failed_events: '0', consumer_events: '0' }],
    });
  });

  it('rolls back every confirmed failure crash window to the original RUNNING projection', async () => {
    for (const target of [
      'INVOCATION_FAILED',
      'FAILED_EVENT',
      'CONSUMER_EVENT_OUTBOX',
      'CONSUMER_EVENT_STREAM',
      'FAILED_TERMINAL_RECEIPT',
      'CONVERSATION_IDLE',
    ] satisfies CloudJournalStep[]) {
      const conversationId = await createConversation();
      const accepted = acceptInput(conversationId);
      const baseJournal = new PostgresCloudJournal(journalPools);
      await baseJournal.acceptInvocation(accepted);
      const authority = await assignRunning(accepted);
      const failed = failedInput(accepted, authority);
      const failing = new PostgresCloudJournal(journalPools, (step) => {
        if (step === target) throw new Error(`FAILPOINT:${target}`);
      });

      await expect(failing.commitFailed(failed)).rejects.toThrow(`FAILPOINT:${target}`);
      const state = await owner.query<{
        messages: string;
        events: string;
        failed_events: string;
        state: string;
        result_message_id: string | null;
        result_digest: string | null;
        error_code: string | null;
        terminal_at: Date | null;
        conversation_state: string;
        consumer_events: string;
        consumer_streams: string;
        terminal_receipts: string;
      }>(
        `SELECT
           (SELECT count(*) FROM agent_messages WHERE invocation_id = $1)::text AS messages,
           (SELECT count(*) FROM agent_invocation_events
             WHERE invocation_id = $1)::text AS events,
           (SELECT count(*) FROM agent_invocation_events
             WHERE invocation_id = $1
               AND event_type = 'invocation.failed')::text AS failed_events,
           invocation.state, invocation.result_message_id, invocation.result_digest,
           invocation.error_code, invocation.terminal_at,
           conversation.state AS conversation_state,
           (SELECT count(*) FROM consumer_event_outbox
             WHERE invocation_id = $1)::text AS consumer_events,
           (SELECT count(*) FROM consumer_event_streams
             WHERE conversation_id = invocation.conversation_id)::text AS consumer_streams,
           (SELECT count(*) FROM creator_agent_failed_terminal_receipts
             WHERE invocation_id = invocation.id)::text AS terminal_receipts
         FROM agent_invocations AS invocation
         JOIN agent_conversations AS conversation ON conversation.id = invocation.conversation_id
         WHERE invocation.id = $1`,
        [accepted.invocationId],
      );
      expect(state.rows[0], target).toEqual({
        messages: '1',
        events: '3',
        failed_events: '0',
        state: 'RUNNING',
        result_message_id: null,
        result_digest: null,
        error_code: null,
        terminal_at: null,
        conversation_state: 'BUSY',
        consumer_events: '0',
        consumer_streams: '0',
        terminal_receipts: '0',
      });
      await expect(baseJournal.commitFailed(failed)).resolves.toMatchObject({
        state: 'FAILED',
        replayed: false,
      });
    }
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

    const invalidDurableCipherSealer: AssistantMessageSealer = async (input) => {
      const sealed = await sealAssistantMessage(input);
      return {
        ...sealed,
        encryptedMessage: {
          ...sealed.encryptedMessage,
          cipherDigest: digest('9'),
        },
      };
    };
    await expect(journal.commitSuccess(success, invalidDurableCipherSealer)).rejects.toMatchObject<
      Partial<CloudJournalError>
    >({ code: 'EXECUTION_AUTHORITY_MISMATCH' });

    const swappedContentDomainSealer: AssistantMessageSealer = async (input) => {
      const sealed = await sealAssistantMessage(input);
      return {
        ...sealed,
        encryptedMessage: {
          ...sealed.encryptedMessage,
          contentDigest: success.fact.resultDigest,
        },
      };
    };
    await expect(journal.commitSuccess(success, swappedContentDomainSealer)).rejects.toMatchObject<
      Partial<CloudJournalError>
    >({ code: 'EXECUTION_AUTHORITY_MISMATCH' });

    const swappedDigestDomainSealer: AssistantMessageSealer = ({ aad }) => {
      const encryptedMessage = encryptMessage({
        plaintext: 'different assistant secret',
        encryptionKey,
        digestKey,
        keyId: `pg-test:${aad.messageId}`,
        aad,
      });
      return {
        encryptedMessage,
        verifiedResultDigest: encryptedMessage.contentDigest,
      };
    };
    await expect(journal.commitSuccess(success, swappedDigestDomainSealer)).rejects.toMatchObject<
      Partial<CloudJournalError>
    >({ code: 'JOURNAL_SECURITY_BLOCKED', message: 'JOURNAL_SECURITY_BLOCKED' });
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toHaveLength(1);
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
    const reencryptedReplay = {
      ...success,
      resultCiphertext: transportEncryptedAssistant(
        conversationId,
        accepted.invocationId,
        'different replay transport bytes',
      ),
    };
    await expect(journal.commitSuccess(reencryptedReplay, unavailableOnReplay)).resolves.toEqual({
      ...committed,
      replayed: true,
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
    ).rejects.toMatchObject<Partial<CloudJournalError>>({ code: 'JOURNAL_SECURITY_BLOCKED' });
    await expect(
      journal.commitSuccess({
        ...success,
        fact: wrongFenceFact,
        factDigest: workerInvocationFactDigest(wrongFenceFact),
      }),
    ).rejects.toMatchObject<Partial<CloudJournalError>>({ code: 'JOURNAL_SECURITY_BLOCKED' });
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
    ).rejects.toMatchObject<Partial<CloudJournalError>>({ code: 'JOURNAL_SECURITY_BLOCKED' });
    for (const factPatch of [
      { agentVersionDigest: digest('2') },
      { snapshotDigest: digest('3') },
      { executionCapabilityDigest: digest('8') },
      { leaseId: randomUuidV7() },
      { runtimeThreadId: 'thread-security-conflict' },
      { runtimeTurnId: 'turn-security-conflict' },
      { startedFactDigest: digest('6') },
    ] satisfies readonly Partial<WorkerInvocationSucceededFact>[]) {
      const conflictingFact: WorkerInvocationSucceededFact = { ...success.fact, ...factPatch };
      await expect(
        journal.commitSuccess({
          ...success,
          fact: conflictingFact,
          factDigest: workerInvocationFactDigest(conflictingFact),
        }),
      ).rejects.toMatchObject<Partial<CloudJournalError>>({
        code: 'JOURNAL_SECURITY_BLOCKED',
        message: 'JOURNAL_SECURITY_BLOCKED',
      });
    }
    expect(await reconciliationIntegrityAlerts(accepted.invocationId)).toHaveLength(11);

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
      terminal_local_cipher_digest: string;
      started_fact_digest: string;
      runtime_thread_id: string;
      runtime_turn_id: string;
      durable_cipher_digest: string;
      durable_content_digest: string;
      receipt_event_id: string;
      receipt_message_id: string;
      receipt_cursor: string;
      receipt_payload_digest: string;
      receipt_dedupe_key: string;
      pending_preflights: string;
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
         (SELECT source_local_result_cipher_digest FROM agent_invocation_events
            WHERE invocation_id = $1 AND event_type = 'invocation.succeeded')
            AS terminal_local_cipher_digest,
         (SELECT source_fact_digest FROM agent_invocation_events
            WHERE invocation_id = $1 AND event_type = 'invocation.started')
            AS started_fact_digest,
         receipt.terminal_event_id::text AS receipt_event_id,
         receipt.assistant_message_id::text AS receipt_message_id,
         receipt.consumer_event_cursor::text AS receipt_cursor,
         receipt.payload_digest AS receipt_payload_digest,
         receipt.dedupe_key AS receipt_dedupe_key,
         (SELECT count(*)::text FROM creator_agent_success_seal_preflights
           WHERE invocation_id = invocation.id) AS pending_preflights
       FROM agent_invocations AS invocation
       JOIN agent_conversations AS conversation ON conversation.id = invocation.conversation_id
       JOIN creator_agent_succeeded_terminal_receipts AS receipt
         ON receipt.invocation_id = invocation.id
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
      terminal_local_cipher_digest: success.fact.localResultCipherDigest,
      started_fact_digest: success.fact.startedFactDigest,
      runtime_thread_id: success.fact.runtimeThreadId,
      runtime_turn_id: success.fact.runtimeTurnId,
      durable_cipher_digest: expect.any(String),
      durable_content_digest: domainSeparatedHmacSha256('combo:vnext:message:v1', digestKey, {
        text: 'assistant secret',
      }),
      receipt_event_id: expect.any(String),
      receipt_message_id: committed.assistantMessageId,
      receipt_cursor: committed.consumerEventCursor,
      receipt_payload_digest: consumerEventPayloadDigest(terminalPayload),
      receipt_dedupe_key: consumerEventDedupeKey({
        ownerId: ids.consumerId,
        sourceEventId: state.rows[0]!.receipt_event_id,
        eventType: 'invocation.terminal',
      }),
      pending_preflights: '0',
    });
    expect(state.rows[0]!.durable_cipher_digest).not.toBe(success.fact.localResultCipherDigest);
    expect(state.rows[0]!.durable_cipher_digest).not.toBe(success.resultCiphertext.cipherDigest);
    expect(success.resultCiphertext.cipherDigest).not.toBe(success.fact.localResultCipherDigest);
    expect(state.rows[0]!.durable_content_digest).not.toBe(success.fact.resultDigest);

    await expect(
      owner.query<{ fact_digest: string; payload_digest: string; dedupe_key: string }>(
        `SELECT creator_agent_worker_success_fact_digest_v1(
                  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
                ) AS fact_digest,
                creator_agent_success_consumer_payload_digest_v1(
                  $13, $14, $2, $9, $15
                ) AS payload_digest,
                creator_agent_success_consumer_dedupe_key_v1($16, $17) AS dedupe_key`,
        [
          success.fact.sourceEventId,
          success.fact.invocationId,
          success.fact.agentVersionDigest,
          success.fact.snapshotDigest,
          success.fact.executionCapabilityDigest,
          success.fact.leaseId,
          success.fact.fence,
          success.fact.localResultCipherDigest,
          success.fact.resultDigest,
          success.fact.runtimeThreadId,
          success.fact.runtimeTurnId,
          success.fact.startedFactDigest,
          committed.assistantMessageId,
          conversationId,
          terminalPayload.occurredAt,
          ids.consumerId,
          state.rows[0]!.receipt_event_id,
        ],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          fact_digest: success.factDigest,
          payload_digest: consumerEventPayloadDigest(terminalPayload),
          dedupe_key: consumerEventDedupeKey({
            ownerId: ids.consumerId,
            sourceEventId: state.rows[0]!.receipt_event_id,
            eventType: 'invocation.terminal',
          }),
        },
      ],
    });

    const goldenFact: WorkerInvocationSucceededFact = {
      protocol: WORKER_INVOCATION_FACT_PROTOCOL,
      schemaVersion: 1,
      type: 'invocation.succeeded',
      sourceEventId: '0198f00d-5000-7000-8000-000000000013',
      invocationId: '0198f00d-5000-7000-8000-000000000013',
      agentVersionDigest: digest('a'),
      snapshotDigest: digest('b'),
      executionCapabilityDigest: digest('c'),
      leaseId: '0198f00d-5000-7000-8000-000000000015',
      fence: '7',
      localResultCipherDigest: digest('d'),
      resultDigest: hmac('e'),
      runtimeThreadId: 'thread-golden',
      runtimeTurnId: 'turn-golden',
      startedFactDigest: digest('f'),
    };
    const goldenPayload = ConsumerTerminalEventPayloadSchema.parse({
      protocol: CONSUMER_EVENT_OUTBOX_PROTOCOL,
      schemaVersion: 1,
      type: 'invocation.terminal',
      conversationId: '0198f00d-5000-7000-8000-000000000012',
      invocationId: goldenFact.invocationId,
      terminalState: 'SUCCEEDED',
      assistantMessageId: '0198f00d-5000-7000-8000-000000000016',
      resultDigest: goldenFact.resultDigest,
      errorCode: null,
      occurredAt: '2026-08-20T08:00:10.123Z',
    });
    const factGolden = '18e36805cffcec4d475163ac96bfd465fce6ede158b1af1e7e12378ed8ddece9';
    const payloadGolden = 'b80f18d6fa8afacd61f1dda54b374d363c231fba012aede12664b8911d47c632';
    const dedupeGolden = 'f80d5d425897b0e6a8668e1faaa20ec3c9bfa4ed253d8e6e1f4dc8d7452e0d9d';
    expect(workerInvocationFactDigest(goldenFact)).toBe(factGolden);
    expect(consumerEventPayloadDigest(goldenPayload)).toBe(payloadGolden);
    expect(
      consumerEventDedupeKey({
        ownerId: '0198f00d-5000-7000-8000-000000000011',
        sourceEventId: '42',
        eventType: 'invocation.terminal',
      }),
    ).toBe(dedupeGolden);
    await expect(
      owner.query<{ fact_digest: string; payload_digest: string; dedupe_key: string }>(
        `SELECT creator_agent_worker_success_fact_digest_v1(
                  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
                ) AS fact_digest,
                creator_agent_success_consumer_payload_digest_v1(
                  $13, $14, $2, $9, $15
                ) AS payload_digest,
                creator_agent_success_consumer_dedupe_key_v1($16, 42) AS dedupe_key`,
        [
          goldenFact.sourceEventId,
          goldenFact.invocationId,
          goldenFact.agentVersionDigest,
          goldenFact.snapshotDigest,
          goldenFact.executionCapabilityDigest,
          goldenFact.leaseId,
          goldenFact.fence,
          goldenFact.localResultCipherDigest,
          goldenFact.resultDigest,
          goldenFact.runtimeThreadId,
          goldenFact.runtimeTurnId,
          goldenFact.startedFactDigest,
          goldenPayload.assistantMessageId,
          goldenPayload.conversationId,
          goldenPayload.occurredAt,
          '0198f00d-5000-7000-8000-000000000011',
        ],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          fact_digest: factGolden,
          payload_digest: payloadGolden,
          dedupe_key: dedupeGolden,
        },
      ],
    });
  });

  it('blocks legacy direct Assistant Message, succeeded Event, and succeeded Consumer Outbox writes', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const authority = await assignRunning(accepted);
    const success = successInput(accepted, authority);
    const legacy = await brokerPool.connect();
    try {
      const directMessageId = randomUuidV7();
      const sealed = await sealAssistantMessage({
        resultCiphertext: success.resultCiphertext,
        aad: {
          schemaVersion: 1,
          ownerId: ids.creatorId,
          conversationId,
          messageId: directMessageId,
          role: 'ASSISTANT',
        },
        signal: AbortSignal.timeout(5_000),
      });
      const encrypted = sealed.encryptedMessage;
      await legacy.query('BEGIN');
      await legacy.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await legacy.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumerId]);
      await expect(
        legacy.query(
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
            directMessageId,
            conversationId,
            ids.creatorId,
            ids.consumerId,
            encrypted.algorithm,
            encrypted.keyId,
            encrypted.nonce,
            encrypted.ciphertext,
            encrypted.authTag,
            encrypted.cipherDigest,
            encrypted.contentDigest,
            encrypted.aadVersion,
            accepted.invocationId,
          ],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await legacy.query('ROLLBACK');

      await legacy.query('BEGIN');
      await legacy.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await legacy.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumerId]);
      await expect(
        legacy.query(
          `INSERT INTO agent_invocation_events (
             invocation_id, creator_id, consumer_subject_id, journal_seq, source,
             source_event_id, event_type, payload, occurred_at,
             source_fact_digest, broker_command_id, source_local_result_cipher_digest
           )
           SELECT $1::uuid, $2, $3, COALESCE(max(journal_seq), 0) + 1,
                  'WORKER', $1::uuid::text, 'invocation.succeeded', $4::jsonb,
                  date_trunc('milliseconds', clock_timestamp()), $5, NULL, $6
             FROM agent_invocation_events WHERE invocation_id = $1::uuid`,
          [
            accepted.invocationId,
            ids.creatorId,
            ids.consumerId,
            JSON.stringify({
              state: 'SUCCEEDED',
              messageId: directMessageId,
              resultDigest: success.fact.resultDigest,
            }),
            success.factDigest,
            success.fact.localResultCipherDigest,
          ],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await legacy.query('ROLLBACK');

      await journal.commitSuccess(success, sealAssistantMessage);
      await legacy.query('BEGIN');
      await legacy.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await legacy.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumerId]);
      await expect(
        legacy.query(`SELECT invocation_id FROM creator_agent_succeeded_terminal_receipts`),
      ).rejects.toMatchObject({ code: '42501' });
      await legacy.query('ROLLBACK');

      await legacy.query('BEGIN');
      await legacy.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await legacy.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumerId]);
      await expect(
        legacy.query(
          `INSERT INTO consumer_event_outbox (
             owner_id, conversation_id, invocation_id, source_event_id,
             event_type, payload, payload_digest, dedupe_key
           )
           SELECT owner_id, conversation_id, invocation_id, source_event_id,
                  event_type, payload, payload_digest, dedupe_key
             FROM consumer_event_outbox WHERE invocation_id = $1`,
          [accepted.invocationId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await legacy.query('ROLLBACK');
    } finally {
      await legacy.query('ROLLBACK').catch(() => undefined);
      legacy.release();
    }
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
    await expect(
      owner.query<{ receipt_cursor: string; assistant_message_id: string; pending: string }>(
        `SELECT receipt.consumer_event_cursor::text AS receipt_cursor,
                receipt.assistant_message_id::text,
                (SELECT count(*)::text FROM creator_agent_success_seal_preflights
                  WHERE invocation_id = receipt.invocation_id) AS pending
           FROM creator_agent_succeeded_terminal_receipts AS receipt
          WHERE receipt.invocation_id = $1`,
        [accepted.invocationId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          receipt_cursor: committed.consumerEventCursor,
          assistant_message_id: committed.assistantMessageId,
          pending: '0',
        },
      ],
    });
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
    ).rejects.toMatchObject<Partial<CloudJournalError>>({ code: 'JOURNAL_SECURITY_BLOCKED' });
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
      'SUCCESS_SEAL_PREFLIGHT',
      'ASSISTANT_MESSAGE',
      'INVOCATION_SUCCEEDED',
      'SUCCEEDED_EVENT',
      'CONSUMER_EVENT_OUTBOX',
      'CONSUMER_EVENT_STREAM',
      'SUCCESS_TERMINAL_RECEIPT',
      'CONVERSATION_IDLE',
      'SUCCESS_PREFLIGHT_CONSUMED',
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
        success_preflights: string;
        success_receipts: string;
      }>(
        `SELECT
           (SELECT count(*) FROM agent_messages WHERE invocation_id = $1)::text AS messages,
           (SELECT count(*) FROM agent_invocation_events WHERE invocation_id = $1)::text AS events,
           invocation.state, invocation.result_message_id,
           conversation.state AS conversation_state,
           (SELECT count(*) FROM consumer_event_outbox
             WHERE invocation_id = $1)::text AS consumer_events,
           (SELECT count(*) FROM consumer_event_streams
             WHERE conversation_id = invocation.conversation_id)::text AS consumer_streams,
           (SELECT count(*) FROM creator_agent_success_seal_preflights
             WHERE invocation_id = invocation.id)::text AS success_preflights,
           (SELECT count(*) FROM creator_agent_succeeded_terminal_receipts
             WHERE invocation_id = invocation.id)::text AS success_receipts
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
        success_preflights: '0',
        success_receipts: '0',
      });
      await expect(baseJournal.commitSuccess(success, sealAssistantMessage)).resolves.toMatchObject(
        {
          replayed: false,
        },
      );
    }
  });

  it('rejects an AES-GCM key/nonce reuse at the durable database boundary', async () => {
    const sharedKeyId = `pg-test:shared-${randomUUID()}`;
    const firstConversation = await createConversation();
    const secondConversation = await createConversation();
    const journal = new PostgresCloudJournal(journalPools);
    const first = acceptInput(firstConversation, { keyId: sharedKeyId });
    await journal.acceptInvocation(first);
    await expect(
      journal.acceptInvocation(
        acceptInput(secondConversation, {
          keyId: sharedKeyId,
          encryptedUserMessage: first.encryptedUserMessage,
        }),
      ),
    ).rejects.toMatchObject({ code: '23505' });
    expect(await counts(secondConversation)).toEqual({
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
    expect(await successControlFootprint(accepted.invocationId)).toEqual({
      preflights: '0',
      receipts: '0',
    });
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
         '{}'::jsonb, $6, $7::jsonb, $8, '{}'::jsonb, $9, '{}'::jsonb, $10,
         '0.147.0-alpha.6.5', $11, $12
       )`,
      [
        raceVersionId,
        raceAgentId,
        ids.creatorId,
        digest('7'),
        ids.snapshotId,
        digest('a'),
        runtimePolicyJson(),
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
      [account()],
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
         '{}'::jsonb, $6, $7::jsonb, $8, '{}'::jsonb, $9, '{}'::jsonb, $10,
         '0.147.0-alpha.6.5', $11, $12
       )`,
      [
        securityVersionId,
        securityAgentId,
        ids.creatorId,
        digest('7'),
        ids.snapshotId,
        digest('a'),
        runtimePolicyJson(),
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
