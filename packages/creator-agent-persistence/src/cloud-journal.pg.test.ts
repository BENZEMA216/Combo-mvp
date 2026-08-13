import { randomBytes, randomUUID } from 'node:crypto';
import {
  CONSUMER_EVENT_OUTBOX_PROTOCOL,
  ConsumerTerminalEventPayloadSchema,
  consumerEventPayloadDigest,
} from '@cb/creator-agent-protocol';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PostgresCloudJournal,
  type AcceptInvocationInput,
  type CloudJournalError,
  type CloudJournalStep,
  type CommitSuccessInput,
  type JournalPool,
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
  let nonceCounter = 1;

  async function createConversation(): Promise<string> {
    const conversationId = randomUuidV7();
    await owner.query(
      `INSERT INTO agent_conversations (
         id, agent_id, deployment_id, agent_version_id, creator_id,
         consumer_subject_id, idempotency_key, request_digest,
         version_digest, state, assigned_worker_id, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, gen_uuid_v7(), $7, $8, 'IDLE', $9, now() + interval '1 hour')`,
      [
        conversationId,
        ids.agentId,
        ids.deploymentId,
        ids.agentVersionId,
        ids.creatorId,
        ids.consumerId,
        digest('c'),
        digest('7'),
        ids.workerId,
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

  function acceptInput(
    conversationId: string,
    options: {
      clientMessageId?: string;
      requestDigest?: `hmac-sha256:${string}`;
      keyId?: string;
      nonce?: Buffer;
      turnNo?: number;
    } = {},
  ): AcceptInvocationInput {
    const userMessageId = randomUuidV7();
    const turnNo = options.turnNo ?? 1;
    return {
      creatorId: ids.creatorId,
      consumerId: ids.consumerId,
      conversationId,
      agentVersionId: ids.agentVersionId,
      agentVersionDigest: digest('7'),
      targetWorkerId: ids.workerId,
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

  async function assignRunning(input: AcceptInvocationInput): Promise<string> {
    const capabilityId = randomUuidV7();
    await owner.query(`UPDATE agent_invocations SET state = 'QUEUED' WHERE id = $1`, [
      input.invocationId,
    ]);
    await owner.query(
      `UPDATE agent_invocations
          SET state = 'DISPATCH_PENDING', assigned_worker_id = $2,
              assignment_lease_id = $3, assignment_fence = 1,
              execution_capability_id = $4
        WHERE id = $1`,
      [input.invocationId, ids.workerId, ids.leaseId, capabilityId],
    );
    await owner.query(`UPDATE agent_invocations SET state = 'PERSISTED' WHERE id = $1`, [
      input.invocationId,
    ]);
    await owner.query(
      `UPDATE agent_invocations
          SET state = 'STARTING', started_at = now(),
              runtime_thread_id = 'thread-test', runtime_turn_id = 'turn-test'
        WHERE id = $1`,
      [input.invocationId],
    );
    await owner.query(`UPDATE agent_invocations SET state = 'RUNNING' WHERE id = $1`, [
      input.invocationId,
    ]);
    return capabilityId;
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

  function successInput(accepted: AcceptInvocationInput, capabilityId: string): CommitSuccessInput {
    const assistantMessageId = randomUuidV7();
    return {
      creatorId: ids.creatorId,
      consumerId: ids.consumerId,
      conversationId: accepted.conversationId,
      invocationId: accepted.invocationId,
      assistantMessageId,
      sourceEventId: randomUuidV7(),
      agentVersionId: ids.agentVersionId,
      workerId: ids.workerId,
      leaseId: ids.leaseId,
      fence: 1n,
      executionCapabilityId: capabilityId,
      turnNo: accepted.turnNo,
      resultDigest: hmac('9'),
      encryptedAssistantMessage: encrypted(
        accepted.conversationId,
        assistantMessageId,
        'ASSISTANT',
        'assistant secret',
      ),
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

  it('commits an exact-authority final atomically and exact replay never duplicates it', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const capabilityId = await assignRunning(accepted);
    const success = successInput(accepted, capabilityId);

    await expect(journal.commitSuccess({ ...success, fence: 2n })).rejects.toMatchObject<
      Partial<CloudJournalError>
    >({
      code: 'EXECUTION_AUTHORITY_MISMATCH',
    });
    const committed = await journal.commitSuccess(success);
    expect(committed).toMatchObject({ replayed: false });
    await expect(journal.commitSuccess(success)).resolves.toMatchObject({
      replayed: true,
      consumerEventCursor: committed.consumerEventCursor,
    });
    await expect(
      journal.commitSuccess({ ...success, sourceEventId: randomUuidV7() }),
    ).rejects.toMatchObject<Partial<CloudJournalError>>({ code: 'TERMINAL_CONFLICT' });
    await expect(journal.commitSuccess({ ...success, fence: 2n })).rejects.toMatchObject<
      Partial<CloudJournalError>
    >({
      code: 'EXECUTION_AUTHORITY_MISMATCH',
    });
    await expect(
      journal.commitSuccess({ ...success, resultDigest: hmac('5') }),
    ).rejects.toMatchObject<Partial<CloudJournalError>>({ code: 'TERMINAL_CONFLICT' });

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
    }>(
      `SELECT
         (SELECT count(*) FROM agent_messages WHERE invocation_id = $1)::text AS messages,
         (SELECT count(*) FROM agent_invocation_events
           WHERE invocation_id = $1 AND event_type = 'invocation.succeeded')::text AS succeeded_events,
         invocation.state, invocation.result_message_id,
         conversation.state AS conversation_state,
         (SELECT count(*) FROM consumer_event_outbox
           WHERE invocation_id = $1)::text AS consumer_events,
         (SELECT latest_cursor::text FROM consumer_event_streams
           WHERE conversation_id = invocation.conversation_id) AS latest_cursor,
         (SELECT payload_digest
            FROM consumer_event_outbox WHERE invocation_id = $1) AS payload_digest,
         (SELECT payload
            FROM consumer_event_outbox WHERE invocation_id = $1) AS payload
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
      assistantMessageId: success.assistantMessageId,
      resultDigest: success.resultDigest,
      errorCode: null,
    });
    expect(state.rows[0]).toEqual({
      messages: '2',
      succeeded_events: '1',
      state: 'SUCCEEDED',
      result_message_id: success.assistantMessageId,
      conversation_state: 'IDLE',
      consumer_events: '1',
      latest_cursor: committed.consumerEventCursor,
      payload_digest: consumerEventPayloadDigest(terminalPayload),
      payload: terminalPayload,
    });
  });

  it('claims, publishes, replays, and prunes Consumer events from PostgreSQL authority', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    const capabilityId = await assignRunning(accepted);
    const success = successInput(accepted, capabilityId);
    const committed = await journal.commitSuccess(success);
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
          assistantMessageId: success.assistantMessageId,
          resultDigest: success.resultDigest,
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
      const committed = await journal.commitSuccess(successInput(accepted, capabilityId));
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

      await expect(journal.commitSuccess(success)).rejects.toThrow(`FAILPOINT:${target}`);
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
        events: '1',
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

  it('rejects a final after the exact Worker Lease is no longer active', async () => {
    const committedConversationId = await createConversation();
    const pendingConversationId = await createConversation();
    const journal = new PostgresCloudJournal(journalPools);

    const committedInvocation = acceptInput(committedConversationId);
    await journal.acceptInvocation(committedInvocation);
    const committedCapabilityId = await assignRunning(committedInvocation);
    const committedSuccess = successInput(committedInvocation, committedCapabilityId);
    await journal.commitSuccess(committedSuccess);

    const pendingInvocation = acceptInput(pendingConversationId);
    await journal.acceptInvocation(pendingInvocation);
    const pendingCapabilityId = await assignRunning(pendingInvocation);
    const pendingSuccess = successInput(pendingInvocation, pendingCapabilityId);

    await owner.query(`UPDATE worker_leases SET state = 'REVOKED' WHERE id = $1`, [ids.leaseId]);
    await expect(journal.commitSuccess(committedSuccess)).resolves.toMatchObject({
      replayed: true,
    });
    await expect(journal.commitSuccess(pendingSuccess)).rejects.toMatchObject<
      Partial<CloudJournalError>
    >({ code: 'EXECUTION_AUTHORITY_MISMATCH' });
  });
});
