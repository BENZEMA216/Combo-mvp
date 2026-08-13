import { randomBytes, randomUUID } from 'node:crypto';
import { canonicalSha256 } from '@cb/creator-agent-protocol';
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
    snapshotId: randomUUID(),
    agentId: randomUUID(),
    agentVersionId: randomUUID(),
    deploymentId: randomUUID(),
    workerId: randomUUID(),
    leaseId: randomUUID(),
  };
  const encryptionKey = Buffer.alloc(32, 0x31);
  const digestKey = Buffer.alloc(32, 0x32);
  let nonceCounter = 1;

  async function createConversation(): Promise<string> {
    const conversationId = randomUUID();
    await owner.query(
      `INSERT INTO agent_conversations (
         id, agent_id, deployment_id, agent_version_id, creator_id,
         consumer_subject_id, version_digest, state, assigned_worker_id, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'IDLE', $8, now() + interval '1 hour')`,
      [
        conversationId,
        ids.agentId,
        ids.deploymentId,
        ids.agentVersionId,
        ids.creatorId,
        ids.consumerId,
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
    const userMessageId = randomUUID();
    const turnNo = options.turnNo ?? 1;
    return {
      creatorId: ids.creatorId,
      consumerId: ids.consumerId,
      conversationId,
      agentVersionId: ids.agentVersionId,
      agentVersionDigest: digest('7'),
      targetWorkerId: ids.workerId,
      userMessageId,
      invocationId: randomUUID(),
      outboxCommandId: randomUUID(),
      sourceEventId: randomUUID(),
      clientMessageId: options.clientMessageId ?? randomUUID(),
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
    const capabilityId = randomUUID();
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

  function successInput(accepted: AcceptInvocationInput, capabilityId: string): CommitSuccessInput {
    const assistantMessageId = randomUUID();
    return {
      creatorId: ids.creatorId,
      consumerId: ids.consumerId,
      conversationId: accepted.conversationId,
      invocationId: accepted.invocationId,
      assistantMessageId,
      sourceEventId: randomUUID(),
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
      [ids.leaseId, ids.deploymentId, ids.creatorId, ids.workerId, randomUUID()],
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
      journal.commitSuccess({ ...success, sourceEventId: randomUUID() }),
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
            FROM consumer_event_outbox WHERE invocation_id = $1) AS payload_digest
       FROM agent_invocations AS invocation
       JOIN agent_conversations AS conversation ON conversation.id = invocation.conversation_id
       WHERE invocation.id = $1`,
      [accepted.invocationId],
    );
    expect(state.rows[0]).toEqual({
      messages: '2',
      succeeded_events: '1',
      state: 'SUCCEEDED',
      result_message_id: success.assistantMessageId,
      conversation_state: 'IDLE',
      consumer_events: '1',
      latest_cursor: committed.consumerEventCursor,
      payload_digest: canonicalSha256({
        state: 'SUCCEEDED',
        messageId: success.assistantMessageId,
        resultDigest: success.resultDigest,
      }),
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
        eventType: 'invocation.succeeded',
        state: 'PENDING',
        payload: {
          state: 'SUCCEEDED',
          messageId: success.assistantMessageId,
          resultDigest: success.resultDigest,
        },
      }),
    ]);
    await expect(
      journal.replayConsumerEvents({
        ...identity,
        consumerId: randomUUID(),
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

  it('allows lost PERSISTED execution evidence to converge through RECONCILING to UNCERTAIN', async () => {
    const conversationId = await createConversation();
    const accepted = acceptInput(conversationId);
    const journal = new PostgresCloudJournal(journalPools);
    await journal.acceptInvocation(accepted);
    await owner.query(`UPDATE agent_invocations SET state = 'QUEUED' WHERE id = $1`, [
      accepted.invocationId,
    ]);
    await owner.query(`UPDATE agent_invocations SET state = 'DISPATCH_PENDING' WHERE id = $1`, [
      accepted.invocationId,
    ]);
    await owner.query(`UPDATE agent_invocations SET state = 'PERSISTED' WHERE id = $1`, [
      accepted.invocationId,
    ]);
    await owner.query(`UPDATE agent_invocations SET state = 'RECONCILING' WHERE id = $1`, [
      accepted.invocationId,
    ]);
    await owner.query(
      `UPDATE agent_invocations
          SET state = 'UNCERTAIN', uncertainty_reason = $2, terminal_at = now()
        WHERE id = $1`,
      [accepted.invocationId, 'WORKER_JOURNAL_MISSING_HOST_UNAVAILABLE'],
    );
    const state = await owner.query<{
      state: string;
      runtime_thread_id: string | null;
      runtime_turn_id: string | null;
      uncertainty_reason: string;
    }>(
      `SELECT state, runtime_thread_id, runtime_turn_id, uncertainty_reason
         FROM agent_invocations WHERE id = $1`,
      [accepted.invocationId],
    );
    expect(state.rows[0]).toEqual({
      state: 'UNCERTAIN',
      runtime_thread_id: null,
      runtime_turn_id: null,
      uncertainty_reason: 'WORKER_JOURNAL_MISSING_HOST_UNAVAILABLE',
    });
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
