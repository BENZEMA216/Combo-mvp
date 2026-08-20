import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
const brokerPassword = process.env.POSTGRES_AGENT_BROKER_PASSWORD;
const requested = process.env.CREATOR_AGENT_CANCELLED_PG_TEST === '1';
if (requested && (!databaseUrl || !brokerPassword)) {
  throw new Error(
    'CREATOR_AGENT_CANCELLED_PG_TEST requires DATABASE_URL and POSTGRES_AGENT_BROKER_PASSWORD',
  );
}
const pgDescribe = requested ? describe.sequential : describe.skip;

function randomUuidV7(): string {
  const value = randomUUID();
  return `${value.slice(0, 14)}7${value.slice(15)}`;
}

function digest(character: string): string {
  return character.repeat(64);
}

function hmac(character: string): string {
  return `hmac-sha256:${createHash('sha256').update(character).digest('hex')}`;
}

function creatorAccount(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return `creator-${[...randomBytes(8)].map((value) => alphabet[value % 32]).join('')}`;
}

/**
 * Independent canonical digest over the cancelled Worker fact (keys sorted, RFC-8785-style).
 * Mirrors creator_agent_worker_cancelled_fact_digest_v1 so the SQL recompute is cross-checked.
 */
function cancelledFactDigest(fact: {
  protocol: string;
  schemaVersion: number;
  type: string;
  sourceEventId: string;
  invocationId: string;
  agentVersionDigest: string;
  snapshotDigest: string;
  executionCapabilityDigest: string;
  leaseId: string;
  fence: string;
  interruptReceiptDigest: string;
}): string {
  const json = [
    `"agentVersionDigest":${JSON.stringify(fact.agentVersionDigest)}`,
    `"executionCapabilityDigest":${JSON.stringify(fact.executionCapabilityDigest)}`,
    `"fence":${JSON.stringify(fact.fence)}`,
    `"interruptReceiptDigest":${JSON.stringify(fact.interruptReceiptDigest)}`,
    `"invocationId":${JSON.stringify(fact.invocationId)}`,
    `"leaseId":${JSON.stringify(fact.leaseId)}`,
    `"protocol":${JSON.stringify(fact.protocol)}`,
    `"schemaVersion":${fact.schemaVersion}`,
    `"snapshotDigest":${JSON.stringify(fact.snapshotDigest)}`,
    `"sourceEventId":${JSON.stringify(fact.sourceEventId)}`,
    `"type":${JSON.stringify(fact.type)}`,
  ].join(',');
  return createHash('sha256').update(`{${json}}`, 'utf8').digest('hex');
}

type AdmissionRow = Readonly<{
  outcome: string;
  interrupt_receipt_digest: string | null;
  terminal_at: Date | null;
  consumer_event_cursor: string | null;
  invocation_cancelled: boolean | null;
  cancelled_event_appended: boolean | null;
  consumer_event_appended: boolean | null;
  consumer_stream_advanced: boolean | null;
  terminal_receipt_appended: boolean | null;
  conversation_idled: boolean | null;
  alert_id: string | null;
  alert_replayed: boolean | null;
}>;

pgDescribe('0029 invocation.cancelled real PostgreSQL admission authority', () => {
  const owner = new Pool({ connectionString: databaseUrl, max: 4 });
  const ids = {
    creator: '',
    consumer: '',
    snapshot: randomUuidV7(),
    agent: randomUuidV7(),
    version: randomUuidV7(),
    deployment: randomUuidV7(),
    installation: randomUuidV7(),
    grant: randomUuidV7(),
    challenge: randomUuidV7(),
    workerSession: randomUuidV7(),
    connection: randomUuidV7(),
    lease: randomUuidV7(),
  };
  const versionDigest = digest('7');
  const capabilityDigest = digest('8');
  let seedFence = 1;

  beforeAll(async () => {
    const users = await owner.query<{ id: string }>(
      `INSERT INTO users (account)
       VALUES ($1), ($2)
       RETURNING id`,
      [creatorAccount(), creatorAccount()],
    );
    [ids.creator, ids.consumer] = users.rows.map((row) => row.id) as [string, string];

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
        `c/${ids.snapshot}.a`,
        `c/${ids.snapshot}.m`,
        `kms://${ids.snapshot}`,
      ],
    );
    await owner.query(
      `INSERT INTO agents (id, creator_id, public_slug, name)
       VALUES ($1, $2, $3, 'Cancelled PG Agent')`,
      [ids.agent, ids.creator, `cancelled-${ids.agent.slice(0, 8)}`],
    );
    await owner.query(
      `INSERT INTO agent_access_grants (id, agent_id, creator_id, consumer_subject_id)
       VALUES ($1, $2, $3, $4)`,
      [ids.grant, ids.agent, ids.creator, ids.consumer],
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
         '0.147.0-cancelled-pg', $11, $12
       )`,
      [
        ids.version,
        ids.agent,
        ids.creator,
        versionDigest,
        ids.snapshot,
        digest('4'),
        JSON.stringify({
          maxTurnSeconds: 30,
          maxConversationTurns: 20,
          maxVisibleHistoryBytes: 32,
        }),
        digest('5'),
        digest('6'),
        digest('9'),
        `sha256:${digest('a')}`,
        `sha256:${digest('b')}`,
      ],
    );
    await owner.query(
      `INSERT INTO agent_version_controls (version_id, creator_id) VALUES ($1, $2)`,
      [ids.version, ids.creator],
    );
    await owner.query(
      `INSERT INTO worker_installations (
         id, creator_id, installation_key_id, device_public_key,
         worker_version, protocol_versions, capabilities
       ) VALUES ($1, $2, $3, $4, 'cancelled-pg/1', '[1]'::jsonb, '{}'::jsonb)`,
      [ids.installation, ids.creator, `ck-${ids.installation}`, Buffer.alloc(65, 7)],
    );
    await owner.query(
      `INSERT INTO deployments (
         id, agent_id, creator_id, environment, desired_state, desired_version_id,
         serving_version_id, observed_state, generation, lease_fence,
         observed_worker_id, observed_generation
       ) VALUES ($1, $2, $3, 'TEST', 'ONLINE', $4, $4, 'ONLINE', 1, 1, $5, 1)`,
      [ids.deployment, ids.agent, ids.creator, ids.version, ids.installation],
    );
    await owner.query(
      `INSERT INTO worker_auth_challenges (
         id, creator_id, installation_id, deployment_id, deployment_generation,
         state, issued_at, expires_at, consumed_at
       ) VALUES (
         $1, $2, $3, $4, 1, 'CONSUMED',
         clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour',
         clock_timestamp() - interval '30 seconds'
       )`,
      [ids.challenge, ids.creator, ids.installation, ids.deployment],
    );
    await owner.query(
      `INSERT INTO worker_gateway_sessions (
         id, creator_id, installation_id, challenge_id, connection_id,
         registration_digest, state, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', clock_timestamp() + interval '1 hour')`,
      [
        ids.workerSession,
        ids.creator,
        ids.installation,
        ids.challenge,
        ids.connection,
        digest('a'),
      ],
    );
    await owner.query(
      `INSERT INTO worker_leases (
         id, deployment_id, creator_id, worker_id, connection_id, fence,
         state, acquired_at, renewed_at, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, 1, 'ACTIVE',
         clock_timestamp() - interval '1 minute', clock_timestamp(),
         clock_timestamp() + interval '1 hour'
       )`,
      [ids.lease, ids.deployment, ids.creator, ids.installation, ids.connection],
    );
    await owner.query(`ALTER ROLE combo_agent_broker WITH LOGIN PASSWORD 'test-broker-pw'`);
    await owner.query(`DELETE FROM worker_leases WHERE id = $1`, [ids.lease]);
  });

  afterAll(async () => {
    await owner.end();
  });

  async function seedRunningInvocation(
    conversationState: 'BUSY' | 'IDLE',
    leaseExpired = false,
  ): Promise<{
    conversationId: string;
    invocationId: string;
    leaseId: string;
    fence: number;
  }> {
    const conversationId = randomUuidV7();
    const messageId = randomUuidV7();
    const invocationId = randomUuidV7();
    const leaseId = randomUuidV7();
    const fence = seedFence;
    seedFence += 1;
    const connection = await owner.connect();
    try {
      await connection.query('BEGIN');
      await connection.query(
        `INSERT INTO worker_leases (
           id, deployment_id, creator_id, worker_id, connection_id, fence,
           state, acquired_at, renewed_at, expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6::bigint,
           $7,
           clock_timestamp() - interval '2 minutes',
           clock_timestamp() - interval '2 minutes',
           CASE WHEN $8::boolean THEN clock_timestamp() - interval '1 minute'
                ELSE clock_timestamp() + interval '1 hour' END
         )`,
        [
          leaseId,
          ids.deployment,
          ids.creator,
          ids.installation,
          ids.connection,
          fence,
          leaseExpired ? 'EXPIRED' : 'ACTIVE',
          leaseExpired,
        ],
      );
      await connection.query(
        `INSERT INTO agent_conversations (
         id, agent_id, deployment_id, agent_version_id, creator_id,
         consumer_subject_id, idempotency_key, request_digest, version_digest,
         state, assigned_worker_id, created_at, last_activity_at, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         $10, $11, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 day'
       )`,
        [
          conversationId,
          ids.agent,
          ids.deployment,
          ids.version,
          ids.creator,
          ids.consumer,
          randomUuidV7(),
          digest('1'),
          versionDigest,
          conversationState,
          ids.installation,
        ],
      );
      await connection.query(
        `INSERT INTO agent_messages (
         id, conversation_id, creator_id, consumer_subject_id, turn_no, role,
         invocation_id, client_message_id, content_algorithm, content_key_id,
         content_nonce, content_ciphertext, content_auth_tag, content_cipher_digest,
         content_digest, content_aad_version
       ) VALUES (
         $1, $2, $3, $4, 1, 'USER', $5, $6, 'aes-256-gcm/v1', 'kms://cancelled',
         $7, $8, $9, $10, $11, 1
       )`,
        [
          messageId,
          conversationId,
          ids.creator,
          ids.consumer,
          invocationId,
          randomUuidV7(),
          randomBytes(12),
          Buffer.alloc(32, 2),
          randomBytes(16),
          digest('b'),
          hmac('2'),
        ],
      );
      await connection.query(
        `INSERT INTO agent_invocations (
         id, conversation_id, creator_id, consumer_subject_id, agent_version_id,
         user_message_id, client_message_id, request_digest, state,
         assigned_worker_id, assignment_lease_id, assignment_fence,
         execution_capability_id, execution_capability_digest, deadline_at,
         execution_capability_expires_at, execution_capability_revoked_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, 'CANCEL_REQUESTED',
         $9, $10, $11::bigint, $12, $13, clock_timestamp() + interval '1 hour',
         clock_timestamp() + interval '1 hour', NULL
       )`,
        [
          invocationId,
          conversationId,
          ids.creator,
          ids.consumer,
          ids.version,
          messageId,
          randomUuidV7(),
          hmac('3'),
          ids.installation,
          leaseId,
          fence,
          randomUuidV7(),
          capabilityDigest,
        ],
      );
      await connection.query('SET CONSTRAINTS ALL IMMEDIATE');
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
    return { conversationId, invocationId, leaseId, fence };
  }

  function cancelledInput(
    invocationId: string,
    leaseId: string,
    fence: number,
    overrides: Partial<Record<string, string>> = {},
  ): {
    creatorId: string;
    installationId: string;
    protocol: string;
    schemaVersion: number;
    type: string;
    sourceEventId: string;
    invocationId: string;
    agentVersionDigest: string;
    snapshotDigest: string;
    executionCapabilityDigest: string;
    leaseId: string;
    fence: string;
    interruptReceiptDigest: string;
    factDigest: string;
  } {
    const fact = {
      protocol: 'combo.worker-invocation-fact/1',
      schemaVersion: 1,
      type: 'invocation.cancelled',
      sourceEventId: invocationId,
      invocationId,
      agentVersionDigest: versionDigest,
      snapshotDigest: digest('1'),
      executionCapabilityDigest: capabilityDigest,
      leaseId,
      fence: String(fence),
      interruptReceiptDigest: `sha256:${digest('c')}`,
      ...overrides,
    };
    return {
      creatorId: ids.creator,
      installationId: ids.installation,
      protocol: fact.protocol,
      schemaVersion: fact.schemaVersion,
      type: fact.type,
      sourceEventId: fact.sourceEventId,
      invocationId: fact.invocationId,
      agentVersionDigest: fact.agentVersionDigest,
      snapshotDigest: fact.snapshotDigest,
      executionCapabilityDigest: fact.executionCapabilityDigest,
      leaseId: fact.leaseId,
      fence: fact.fence,
      interruptReceiptDigest: fact.interruptReceiptDigest,
      factDigest: cancelledFactDigest(fact),
    };
  }

  async function retireLease(leaseId: string): Promise<void> {
    await owner.query(
      `UPDATE worker_leases
          SET state = 'REVOKED'
        WHERE id = $1 AND state = 'ACTIVE'`,
      [leaseId],
    );
  }

  async function admit(input: ReturnType<typeof cancelledInput>): Promise<AdmissionRow> {
    const brokerUrl = new URL(databaseUrl ?? 'postgresql://invalid:invalid@127.0.0.1:1/invalid');
    brokerUrl.username = 'combo_agent_broker';
    brokerUrl.password = 'test-broker-pw';
    const broker = new Client({ connectionString: brokerUrl.toString() });
    await broker.connect();
    try {
      await broker.query('BEGIN');
      await broker.query(`SELECT set_config('app.creator_id', $1, true)`, [input.creatorId]);
      const result = await broker.query<AdmissionRow>(
        `SELECT outcome, interrupt_receipt_digest::text, terminal_at,
                consumer_event_cursor::text,
                invocation_cancelled, cancelled_event_appended, consumer_event_appended,
                consumer_stream_advanced, terminal_receipt_appended, conversation_idled,
                alert_id::text, alert_replayed
           FROM creator_agent_project_cancelled_fact_v1(
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
           )`,
        [
          input.creatorId,
          input.installationId,
          input.protocol,
          input.schemaVersion,
          input.type,
          input.sourceEventId,
          input.invocationId,
          input.agentVersionDigest,
          input.snapshotDigest,
          input.executionCapabilityDigest,
          input.leaseId,
          input.fence,
          input.interruptReceiptDigest,
          input.factDigest,
        ],
      );
      await broker.query('SET CONSTRAINTS ALL IMMEDIATE');
      await broker.query('COMMIT');
      const row = result.rows[0];
      if (!row) throw new Error('no admission row');
      return row;
    } catch (error) {
      await broker.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await broker.end();
    }
  }

  it('admits a confirmed cancelled terminal with the full durable chain', async () => {
    const { conversationId, invocationId, leaseId, fence } = await seedRunningInvocation('BUSY');
    const row = await admit(cancelledInput(invocationId, leaseId, fence));
    expect(row.outcome).toBe('ADMITTED');
    expect(row.interrupt_receipt_digest).toBe(`sha256:${digest('c')}`);
    expect(row.terminal_at).not.toBeNull();
    expect(row.consumer_event_cursor).not.toBeNull();
    expect(row.invocation_cancelled).toBe(true);
    expect(row.cancelled_event_appended).toBe(true);
    expect(row.consumer_event_appended).toBe(true);
    expect(row.consumer_stream_advanced).toBe(true);
    expect(row.terminal_receipt_appended).toBe(true);
    expect(row.conversation_idled).toBe(true);
    expect(row.alert_id).toBeNull();

    const invocation = await owner.query<{
      state: string;
      error_code: string | null;
      terminal_at: Date | null;
    }>(`SELECT state, error_code, terminal_at FROM agent_invocations WHERE id = $1`, [
      invocationId,
    ]);
    expect(invocation.rows[0]).toMatchObject({ state: 'CANCELLED', error_code: null });
    expect(invocation.rows[0]?.terminal_at).not.toBeNull();

    const event = await owner.query<{
      event_type: string;
      payload: unknown;
      source_fact_digest: string | null;
    }>(
      `SELECT event_type, payload, source_fact_digest
         FROM agent_invocation_events WHERE invocation_id = $1 ORDER BY id DESC LIMIT 1`,
      [invocationId],
    );
    expect(event.rows[0]).toMatchObject({
      event_type: 'invocation.cancelled',
      payload: { state: 'CANCELLED' },
    });
    expect(event.rows[0]?.source_fact_digest).toBe(
      cancelledInput(invocationId, leaseId, fence).factDigest,
    );

    const outbox = await owner.query<{ event_type: string; payload: unknown }>(
      `SELECT event_type, payload FROM consumer_event_outbox
        WHERE invocation_id = $1 ORDER BY cursor DESC LIMIT 1`,
      [invocationId],
    );
    expect(outbox.rows[0]).toMatchObject({
      event_type: 'invocation.terminal',
      payload: expect.objectContaining({ terminalState: 'CANCELLED', errorCode: null }),
    });

    const receipt = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM creator_agent_cancelled_terminal_receipts
        WHERE invocation_id = $1`,
      [invocationId],
    );
    expect(receipt.rows[0]?.count).toBe('1');

    const conversation = await owner.query<{ state: string }>(
      `SELECT state FROM agent_conversations WHERE id = $1`,
      [conversationId],
    );
    expect(conversation.rows[0]?.state).toBe('IDLE');
    await retireLease(leaseId);
  });

  it('replays the exact cancelled terminal without mutations', async () => {
    const { invocationId, leaseId, fence } = await seedRunningInvocation('BUSY');
    const input = cancelledInput(invocationId, leaseId, fence);
    const first = await admit(input);
    expect(first.outcome).toBe('ADMITTED');
    const replay = await admit(input);
    expect(replay.outcome).toBe('EXACT');
    expect(replay.invocation_cancelled).toBe(false);
    expect(replay.cancelled_event_appended).toBe(false);
    expect(replay.consumer_event_appended).toBe(false);
    expect(replay.consumer_stream_advanced).toBe(false);
    expect(replay.terminal_receipt_appended).toBe(false);
    expect(replay.conversation_idled).toBe(false);
    expect(replay.interrupt_receipt_digest).toBe(`sha256:${digest('c')}`);
    await retireLease(leaseId);
  });

  it('rejects a tampered fact digest with AUTHORITY_REJECTED', async () => {
    const { invocationId, leaseId, fence } = await seedRunningInvocation('BUSY');
    const input = { ...cancelledInput(invocationId, leaseId, fence), factDigest: digest('f') };
    const row = await admit(input);
    expect(row.outcome).toBe('AUTHORITY_REJECTED');
    await retireLease(leaseId);
  });

  it('rejects a cancelled fact for a busy conversation without an active lease', async () => {
    const { invocationId, leaseId, fence } = await seedRunningInvocation('BUSY', true);
    const row = await admit(cancelledInput(invocationId, leaseId, fence));
    expect(row.outcome).toBe('AUTHORITY_REJECTED');
  });

  it('returns UNAVAILABLE for an unknown invocation', async () => {
    const row = await admit(cancelledInput(randomUuidV7(), randomUuidV7(), 1));
    expect(row.outcome).toBe('UNAVAILABLE');
  });

  it('fails closed when a conflicting cancelled fact replays the same source identity', async () => {
    const { invocationId, leaseId, fence } = await seedRunningInvocation('BUSY');
    const input = cancelledInput(invocationId, leaseId, fence);
    const first = await admit(input);
    expect(first.outcome).toBe('ADMITTED');
    // A conflicting receipt digest with the same source identity is a canonical digest
    // mismatch: the durable source_fact_digest can never equal the incoming digest, so the
    // admission fails closed as INVARIANT_FAILED without fabricating any mutation.
    const conflict = await admit(
      cancelledInput(invocationId, leaseId, fence, {
        interruptReceiptDigest: `sha256:${digest('d')}`,
      }),
    );
    expect(conflict.outcome).toBe('INVARIANT_FAILED');
    expect(conflict.alert_id).toBeNull();
    const events = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_invocation_events
        WHERE invocation_id = $1 AND event_type = 'invocation.cancelled'`,
      [invocationId],
    );
    expect(events.rows[0]?.count).toBe('1');
    await retireLease(leaseId);
  });

  it('requires exact Broker session authority', async () => {
    const { invocationId, leaseId, fence } = await seedRunningInvocation('BUSY');
    const input = cancelledInput(invocationId, leaseId, fence);
    await expect(
      owner.query(
        `SELECT * FROM creator_agent_project_cancelled_fact_v1(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
         )`,
        [
          input.creatorId,
          input.installationId,
          input.protocol,
          input.schemaVersion,
          input.type,
          input.sourceEventId,
          input.invocationId,
          input.agentVersionDigest,
          input.snapshotDigest,
          input.executionCapabilityDigest,
          input.leaseId,
          input.fence,
          input.interruptReceiptDigest,
          input.factDigest,
        ],
      ),
    ).rejects.toThrow(/Cancelled fact admission requires exact Broker session authority/u);
    await retireLease(leaseId);
  });
});
