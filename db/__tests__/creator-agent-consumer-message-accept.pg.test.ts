import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Client, Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
const consumerPassword = process.env.POSTGRES_AGENT_CONSUMER_API_PASSWORD;
const runtimePassword = process.env.POSTGRES_RUNTIME_PASSWORD;
const requested = process.env.CREATOR_AGENT_CONSUMER_ACCEPT_PG_TEST === '1';
if (requested && (!databaseUrl || !consumerPassword || !runtimePassword)) {
  throw new Error(
    'CREATOR_AGENT_CONSUMER_ACCEPT_PG_TEST requires DATABASE_URL, ' +
      'POSTGRES_AGENT_CONSUMER_API_PASSWORD and POSTGRES_RUNTIME_PASSWORD',
  );
}
const pgDescribe = requested ? describe.sequential : describe.skip;

type CipherInput = Readonly<{
  algorithm: 'aes-256-gcm/v1';
  keyId: string;
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
  cipherDigest: string;
  contentDigest: string;
  aadVersion: 1;
}>;

type AcceptInput = CipherInput &
  Readonly<{
    conversationId: string;
    consumerId: string;
    expectedCreatorId: string;
    expectedAgentVersionId: string;
    expectedVersionDigest: string;
    userMessageId: string;
    clientMessageId: string;
    requestDigest: string;
  }>;

type AcceptRow = Readonly<{
  accept_outcome: 'ADMITTED' | 'CONTEXT_LIMIT' | 'REPLAY' | 'CONFLICT' | 'UNAVAILABLE';
  user_message_id: string | null;
  invocation_id: string | null;
  invocation_state: string | null;
  outbox_command_id: string | null;
  source_event_id: string | null;
  deadline_at: Date | null;
}>;

type Footprint = Readonly<{
  state: string;
  next_turn_no: number;
  context_limit_reached_at: Date | null;
  messages: string;
  invocations: string;
  events: string;
  outbox: string;
}>;

type LiveAuthorityOptions = Readonly<{
  desiredState?: 'ONLINE' | 'OFFLINE';
  observedState?: 'ONLINE' | 'OFFLINE' | 'DEGRADED';
  generation?: number;
  observedGeneration?: number;
  observedWorkerMatches?: boolean;
  installationRevoked?: boolean;
  gatewayState?: 'ACTIVE' | 'CLOSED';
  gatewayExpiresSeconds?: number;
  leaseExpiresSeconds?: number;
}>;

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

function consumerDatabaseUrl(): string {
  const url = new URL(databaseUrl ?? 'postgresql://invalid:invalid@127.0.0.1:1/invalid');
  url.username = 'combo_agent_consumer_api';
  url.password = consumerPassword ?? 'invalid';
  return url.toString();
}

function runtimeDatabaseUrl(): string {
  const url = new URL(databaseUrl ?? 'postgresql://invalid:invalid@127.0.0.1:1/invalid');
  url.username = 'combo_runtime';
  url.password = runtimePassword ?? 'invalid';
  return url.toString();
}

function cipherInput(ciphertext: Buffer, marker: string): CipherInput {
  const nonce = randomBytes(12);
  const authTag = randomBytes(16);
  return {
    algorithm: 'aes-256-gcm/v1',
    keyId: `kms://combo/test/message/${marker}`,
    nonce,
    ciphertext,
    authTag,
    cipherDigest: createHash('sha256')
      .update(Buffer.concat([nonce, ciphertext, authTag]))
      .digest('hex'),
    contentDigest: hmac(marker),
    aadVersion: 1,
  };
}

function expectUuidV7(value: string | null): asserts value is string {
  expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
}

pgDescribe('0022 Consumer message full-accept real PostgreSQL authority', () => {
  const owner = new Client({ connectionString: databaseUrl });
  const consumer = new Pool({ connectionString: consumerDatabaseUrl(), max: 20 });
  const runtime = new Pool({ connectionString: runtimeDatabaseUrl(), max: 2 });
  const ids = {
    creator: '',
    consumer: '',
    intruder: '',
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
  let nextVersionOrdinal = 2;

  beforeAll(async () => {
    await owner.connect();
    const users = await owner.query<{ id: string; account: string }>(
      `INSERT INTO users (account)
       VALUES ($1), ($2), ($3)
       RETURNING id, account`,
      [creatorAccount(), creatorAccount(), creatorAccount()],
    );
    [ids.creator, ids.consumer, ids.intruder] = users.rows.map((row) => row.id) as [
      string,
      string,
      string,
    ];

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
        `consumer-accept/${ids.snapshot}.archive.enc`,
        `consumer-accept/${ids.snapshot}.manifest.enc`,
        `kms://${ids.snapshot}`,
      ],
    );
    await owner.query(
      `INSERT INTO agents (id, creator_id, public_slug, name)
       VALUES ($1, $2, $3, 'Consumer Accept PG Agent')`,
      [ids.agent, ids.creator, `accept-${ids.agent.slice(0, 8)}`],
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
         '0.147.0-consumer-accept', $11, $12
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
        digest('8'),
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
       ) VALUES ($1, $2, $3, $4, 'consumer-accept-pg/1', '[1]'::jsonb, '{}'::jsonb)`,
      [ids.installation, ids.creator, `accept-key-${ids.installation}`, Buffer.alloc(65, 7)],
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
        digest('9'),
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
  });

  afterAll(async () => {
    await Promise.all([owner.end(), consumer.end(), runtime.end()]);
  });

  async function runtimeMessageId(): Promise<string> {
    const result = await runtime.query<{ id: string }>(`SELECT gen_uuid_v7() AS id`);
    const id = result.rows[0]?.id;
    if (!id) throw new Error('combo_runtime UUIDv7 authority returned no ID');
    expectUuidV7(id);
    return id;
  }

  async function createVersion(maxTurnSeconds: unknown): Promise<{
    id: string;
    digest: string;
  }> {
    const id = randomUuidV7();
    const versionIdentity = createHash('sha256')
      .update(`${id}:${JSON.stringify(maxTurnSeconds)}`)
      .digest('hex');
    const ordinal = nextVersionOrdinal;
    nextVersionOrdinal += 1;
    await owner.query(
      `INSERT INTO agent_versions (
         id, agent_id, creator_id, ordinal, schema_version, version_digest, snapshot_id,
         behavior_contract, behavior_contract_digest, runtime_policy, runtime_policy_digest,
         io_contract, io_contract_digest, model_policy, model_policy_digest,
         codex_runtime_version, codex_runtime_artifact_digest, codex_protocol_schema_digest
       ) VALUES (
         $1, $2, $3, $4, 1, $5, $6,
         '{}'::jsonb, $7, $8::jsonb, $9, '{}'::jsonb, $10, '{}'::jsonb, $11,
         '0.147.0-consumer-accept', $12, $13
       )`,
      [
        id,
        ids.agent,
        ids.creator,
        ordinal,
        versionIdentity,
        ids.snapshot,
        digest('4'),
        JSON.stringify({
          maxTurnSeconds,
          maxConversationTurns: 20,
          maxVisibleHistoryBytes: 32,
        }),
        digest('5'),
        digest('6'),
        digest('8'),
        `sha256:${digest('a')}`,
        `sha256:${digest('b')}`,
      ],
    );
    await owner.query(
      `INSERT INTO agent_version_controls (version_id, creator_id) VALUES ($1, $2)`,
      [id, ids.creator],
    );
    return { id, digest: versionIdentity };
  }

  async function createConversation(
    version: { id: string; digest: string } = { id: ids.version, digest: versionDigest },
    expired = false,
  ): Promise<string> {
    const conversationId = randomUuidV7();
    await owner.query(
      `INSERT INTO agent_conversations (
         id, agent_id, deployment_id, agent_version_id, creator_id,
         consumer_subject_id, idempotency_key, request_digest, version_digest,
         state, assigned_worker_id, created_at, last_activity_at, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         'IDLE', $10,
         CASE WHEN $11::boolean THEN clock_timestamp() - interval '2 days'
              ELSE clock_timestamp() END,
         CASE WHEN $11::boolean THEN clock_timestamp() - interval '2 days'
              ELSE clock_timestamp() END,
         CASE WHEN $11::boolean THEN clock_timestamp() - interval '1 day'
              ELSE clock_timestamp() + interval '1 day' END
       )`,
      [
        conversationId,
        ids.agent,
        ids.deployment,
        version.id,
        ids.creator,
        ids.consumer,
        randomUuidV7(),
        digest('1'),
        version.digest,
        ids.installation,
        expired,
      ],
    );
    return conversationId;
  }

  function acceptInput(conversationId: string, overrides: Partial<AcceptInput> = {}): AcceptInput {
    return {
      conversationId,
      consumerId: ids.consumer,
      expectedCreatorId: ids.creator,
      expectedAgentVersionId: ids.version,
      expectedVersionDigest: versionDigest,
      userMessageId: randomUuidV7(),
      clientMessageId: randomUUID(),
      requestDigest: hmac('2'),
      ...cipherInput(Buffer.alloc(32, 5), randomUUID()),
      ...overrides,
    };
  }

  async function acceptInsideTransaction(
    connection: PoolClient,
    input: AcceptInput,
    tenantConsumerId = input.consumerId,
  ): Promise<AcceptRow> {
    await connection.query(`SELECT set_config('app.consumer_id', $1, true)`, [tenantConsumerId]);
    const result = await connection.query<AcceptRow>(
      `SELECT accept_outcome, user_message_id, invocation_id, invocation_state,
              outbox_command_id, source_event_id, deadline_at
         FROM creator_agent_accept_consumer_message_v1(
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9, $10, $11, $12, $13, $14, $15, $16
         )`,
      [
        input.conversationId,
        input.consumerId,
        input.expectedCreatorId,
        input.expectedAgentVersionId,
        input.expectedVersionDigest,
        input.userMessageId,
        input.clientMessageId,
        input.requestDigest,
        input.algorithm,
        input.keyId,
        input.nonce,
        input.ciphertext,
        input.authTag,
        input.cipherDigest,
        input.contentDigest,
        input.aadVersion,
      ],
    );
    const row = result.rows[0];
    if (result.rowCount !== 1 || row === undefined) {
      throw new Error('Consumer message accept returned no exact outcome');
    }
    return row;
  }

  async function accept(
    input: AcceptInput,
    tenantConsumerId = input.consumerId,
  ): Promise<AcceptRow> {
    const connection = await consumer.connect();
    try {
      await connection.query('BEGIN');
      const row = await acceptInsideTransaction(connection, input, tenantConsumerId);
      await connection.query('SET CONSTRAINTS ALL IMMEDIATE');
      await connection.query('COMMIT');
      return row;
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async function footprint(conversationId: string): Promise<Footprint> {
    const result = await owner.query<Footprint>(
      `SELECT conversation.state, conversation.next_turn_no,
              conversation.context_limit_reached_at,
              (SELECT count(*)::text FROM agent_messages AS message
                WHERE message.conversation_id = conversation.id) AS messages,
              (SELECT count(*)::text FROM agent_invocations AS invocation
                WHERE invocation.conversation_id = conversation.id) AS invocations,
              (SELECT count(*)::text
                 FROM agent_invocation_events AS event
                 JOIN agent_invocations AS invocation ON invocation.id = event.invocation_id
                WHERE invocation.conversation_id = conversation.id) AS events,
              (SELECT count(*)::text
                 FROM broker_outbox AS command
                 JOIN agent_invocations AS invocation ON invocation.id = command.invocation_id
                WHERE invocation.conversation_id = conversation.id) AS outbox
         FROM agent_conversations AS conversation
        WHERE conversation.id = $1`,
      [conversationId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Consumer accept Conversation fixture disappeared');
    return row;
  }

  async function seedLegacyAcceptedChain(input: AcceptInput): Promise<AcceptRow> {
    const invocationId = randomUuidV7();
    const outboxCommandId = randomUuidV7();
    const sourceEventId = randomUuidV7();
    await owner.query('BEGIN');
    try {
      const clock = await owner.query<{ accepted_at: Date; deadline_at: Date }>(
        `SELECT clock_timestamp() AS accepted_at,
                clock_timestamp() + interval '30 seconds' AS deadline_at`,
      );
      const acceptedAt = clock.rows[0]!.accepted_at;
      const deadlineAt = clock.rows[0]!.deadline_at;
      await owner.query(
        `INSERT INTO agent_messages (
           id, conversation_id, creator_id, consumer_subject_id, turn_no, role,
           client_message_id, content_algorithm, content_key_id, content_nonce,
           content_ciphertext, content_auth_tag, content_cipher_digest, content_digest,
           content_aad_version, invocation_id
         ) VALUES (
           $1, $2, $3, $4, 1, 'USER', $5, $6, $7, $8,
           $9, $10, $11, $12, $13, $14
         )`,
        [
          input.userMessageId,
          input.conversationId,
          ids.creator,
          ids.consumer,
          input.clientMessageId,
          input.algorithm,
          input.keyId,
          input.nonce,
          input.ciphertext,
          input.authTag,
          input.cipherDigest,
          input.contentDigest,
          input.aadVersion,
          invocationId,
        ],
      );
      await owner.query(
        `UPDATE agent_conversations
            SET state = 'BUSY', next_turn_no = 2,
                last_activity_at = GREATEST(last_activity_at, $2)
          WHERE id = $1 AND state = 'IDLE' AND next_turn_no = 1`,
        [input.conversationId, acceptedAt],
      );
      await owner.query(
        `INSERT INTO agent_invocations (
           id, conversation_id, creator_id, consumer_subject_id, agent_version_id,
           user_message_id, client_message_id, request_digest, state, deadline_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACCEPTED', $9)`,
        [
          invocationId,
          input.conversationId,
          ids.creator,
          ids.consumer,
          ids.version,
          input.userMessageId,
          input.clientMessageId,
          input.requestDigest,
          deadlineAt,
        ],
      );
      await owner.query(
        `INSERT INTO agent_invocation_events (
           invocation_id, creator_id, consumer_subject_id, journal_seq, source,
           source_event_id, event_type, payload, occurred_at
         ) VALUES ($1, $2, $3, 1, 'API', $4, 'invocation.accepted',
                   '{"state":"ACCEPTED"}'::jsonb, $5)`,
        [invocationId, ids.creator, ids.consumer, sourceEventId, acceptedAt],
      );
      await owner.query(
        `INSERT INTO broker_outbox (
           command_id, creator_id, target_worker_id, invocation_id, consumer_subject_id,
           command_type, dedupe_key, state, next_attempt_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5, 'invocation.prepare', $6, 'PENDING', $7, $8)`,
        [
          outboxCommandId,
          ids.creator,
          ids.installation,
          invocationId,
          ids.consumer,
          `invocation:${invocationId}:prepare`,
          acceptedAt,
          deadlineAt,
        ],
      );
      await owner.query('SET CONSTRAINTS ALL IMMEDIATE');
      await owner.query('COMMIT');
      return {
        accept_outcome: 'REPLAY',
        user_message_id: input.userMessageId,
        invocation_id: invocationId,
        invocation_state: 'ACCEPTED',
        outbox_command_id: outboxCommandId,
        source_event_id: sourceEventId,
        deadline_at: deadlineAt,
      };
    } catch (error) {
      await owner.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  async function replaceActiveLease(
    previousLeaseId: string,
    fence: number,
    ttlSeconds: number,
  ): Promise<string> {
    const replacementLeaseId = randomUuidV7();
    await owner.query('BEGIN');
    try {
      await owner.query(`UPDATE worker_leases SET state = 'REVOKED' WHERE id = $1`, [
        previousLeaseId,
      ]);
      await owner.query(`UPDATE deployments SET lease_fence = $1 WHERE id = $2`, [
        fence,
        ids.deployment,
      ]);
      await owner.query(
        `INSERT INTO worker_leases (
           id, deployment_id, creator_id, worker_id, connection_id, fence,
           state, acquired_at, renewed_at, expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 'ACTIVE',
           clock_timestamp() - interval '1 second',
           clock_timestamp() - interval '1 second',
           clock_timestamp() + $7::integer * interval '1 second'
         )`,
        [
          replacementLeaseId,
          ids.deployment,
          ids.creator,
          ids.installation,
          ids.connection,
          fence,
          ttlSeconds,
        ],
      );
      await owner.query('COMMIT');
      return replacementLeaseId;
    } catch (error) {
      await owner.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  async function createLiveAuthorityFixture(
    options: LiveAuthorityOptions = {},
  ): Promise<{ conversationId: string; versionId: string; versionDigest: string }> {
    const fixture = {
      agent: randomUuidV7(),
      version: randomUuidV7(),
      deployment: randomUuidV7(),
      installation: randomUuidV7(),
      observedInstallation: randomUuidV7(),
      grant: randomUuidV7(),
      challenge: randomUuidV7(),
      session: randomUuidV7(),
      connection: randomUuidV7(),
      lease: randomUuidV7(),
      conversation: randomUuidV7(),
    };
    const fixtureVersionDigest = createHash('sha256').update(fixture.version).digest('hex');
    const desiredState = options.desiredState ?? 'ONLINE';
    const observedState = options.observedState ?? 'ONLINE';
    const generation = options.generation ?? 1;
    const observedGeneration = options.observedGeneration ?? generation;
    const observedWorkerMatches = options.observedWorkerMatches ?? true;
    const gatewayState = options.gatewayState ?? 'ACTIVE';
    const gatewayExpiresSeconds = options.gatewayExpiresSeconds ?? 3600;
    const leaseExpiresSeconds = options.leaseExpiresSeconds ?? 3600;

    await owner.query(
      `INSERT INTO agents (id, creator_id, public_slug, name)
       VALUES ($1, $2, $3, 'Consumer Accept Authority Fixture')`,
      [fixture.agent, ids.creator, `accept-${fixture.agent.slice(0, 8)}`],
    );
    await owner.query(
      `INSERT INTO agent_access_grants (id, agent_id, creator_id, consumer_subject_id)
       VALUES ($1, $2, $3, $4)`,
      [fixture.grant, fixture.agent, ids.creator, ids.consumer],
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
         '0.147.0-consumer-accept', $11, $12
       )`,
      [
        fixture.version,
        fixture.agent,
        ids.creator,
        fixtureVersionDigest,
        ids.snapshot,
        digest('4'),
        JSON.stringify({
          maxTurnSeconds: 30,
          maxConversationTurns: 20,
          maxVisibleHistoryBytes: 32,
        }),
        digest('5'),
        digest('6'),
        digest('8'),
        `sha256:${digest('a')}`,
        `sha256:${digest('b')}`,
      ],
    );
    await owner.query(
      `INSERT INTO agent_version_controls (version_id, creator_id) VALUES ($1, $2)`,
      [fixture.version, ids.creator],
    );
    await owner.query(
      `INSERT INTO worker_installations (
         id, creator_id, installation_key_id, device_public_key,
         worker_version, protocol_versions, capabilities, revoked_at
       ) VALUES (
         $1, $2, $3, $4, 'consumer-accept-fixture/1', '[1]'::jsonb, '{}'::jsonb,
         CASE WHEN $5::boolean THEN clock_timestamp() ELSE NULL END
       )`,
      [
        fixture.installation,
        ids.creator,
        `accept-key-${fixture.installation}`,
        Buffer.alloc(65, 7),
        options.installationRevoked ?? false,
      ],
    );
    if (!observedWorkerMatches) {
      await owner.query(
        `INSERT INTO worker_installations (
           id, creator_id, installation_key_id, device_public_key,
           worker_version, protocol_versions, capabilities
         ) VALUES ($1, $2, $3, $4, 'consumer-accept-observed/1', '[1]'::jsonb, '{}'::jsonb)`,
        [
          fixture.observedInstallation,
          ids.creator,
          `accept-key-${fixture.observedInstallation}`,
          Buffer.alloc(65, 8),
        ],
      );
    }
    await owner.query(
      `INSERT INTO deployments (
         id, agent_id, creator_id, environment, desired_state, desired_version_id,
         serving_version_id, observed_state, generation, lease_fence,
         observed_worker_id, observed_generation
       ) VALUES ($1, $2, $3, 'TEST', $4, $5, $5, $6, $7, 1, $8, $9)`,
      [
        fixture.deployment,
        fixture.agent,
        ids.creator,
        desiredState,
        fixture.version,
        observedState,
        generation,
        observedWorkerMatches ? fixture.installation : fixture.observedInstallation,
        observedGeneration,
      ],
    );
    await owner.query(
      `INSERT INTO worker_auth_challenges (
         id, creator_id, installation_id, deployment_id, deployment_generation,
         state, issued_at, expires_at, consumed_at
       ) VALUES (
         $1, $2, $3, $4, $5, 'CONSUMED',
         clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour',
         clock_timestamp() - interval '30 seconds'
       )`,
      [fixture.challenge, ids.creator, fixture.installation, fixture.deployment, generation],
    );
    await owner.query(
      `INSERT INTO worker_gateway_sessions (
         id, creator_id, installation_id, challenge_id, connection_id,
         registration_digest, state, connected_at, expires_at, closed_at, disconnect_reason
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         clock_timestamp() - interval '1 minute',
         clock_timestamp() + $8::integer * interval '1 second',
         CASE WHEN $7::text = 'ACTIVE' THEN NULL ELSE clock_timestamp() END,
         CASE WHEN $7::text = 'ACTIVE' THEN NULL ELSE 'CLIENT_CLOSED' END
       )`,
      [
        fixture.session,
        ids.creator,
        fixture.installation,
        fixture.challenge,
        fixture.connection,
        digest('9'),
        gatewayState,
        gatewayExpiresSeconds,
      ],
    );
    await owner.query(
      `INSERT INTO worker_leases (
         id, deployment_id, creator_id, worker_id, connection_id, fence,
         state, acquired_at, renewed_at, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, 1, 'ACTIVE',
         clock_timestamp() - interval '1 second',
         clock_timestamp() - interval '1 second',
         clock_timestamp() + $6::integer * interval '1 second'
       )`,
      [
        fixture.lease,
        fixture.deployment,
        ids.creator,
        fixture.installation,
        fixture.connection,
        leaseExpiresSeconds,
      ],
    );
    await owner.query(
      `INSERT INTO agent_conversations (
         id, agent_id, deployment_id, agent_version_id, creator_id,
         consumer_subject_id, idempotency_key, request_digest, version_digest,
         state, assigned_worker_id, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         'IDLE', $10, clock_timestamp() + interval '1 day'
       )`,
      [
        fixture.conversation,
        fixture.agent,
        fixture.deployment,
        fixture.version,
        ids.creator,
        ids.consumer,
        randomUuidV7(),
        digest('1'),
        fixtureVersionDigest,
        fixture.installation,
      ],
    );
    return {
      conversationId: fixture.conversation,
      versionId: fixture.version,
      versionDigest: fixtureVersionDigest,
    };
  }

  it('exposes only the two exact Consumer definers and zero direct mutation authority', async () => {
    const connection = await consumer.connect();
    try {
      const authority = await connection.query<{
        current_user: string;
        session_user: string;
        full_accept: boolean;
        create_open: boolean;
        api_admission: boolean;
        private_core: boolean;
        direct_message_insert: boolean;
        direct_invocation_insert: boolean;
        direct_event_insert: boolean;
        direct_outbox_insert: boolean;
        direct_conversation_update: boolean;
        uuid_generator: boolean;
        role_memberships: string;
      }>(
        `SELECT current_user,
                session_user,
                has_function_privilege(
                  current_user,
                  'creator_agent_accept_consumer_message_v1(uuid,uuid,uuid,uuid,text,uuid,text,text,text,text,bytea,bytea,bytea,text,text,integer)',
                  'EXECUTE'
                ) AS full_accept,
                has_function_privilege(
                  current_user,
                  'creator_agent_create_opening_conversation_v2(uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid,bigint,integer,text,text,bigint,text)',
                  'EXECUTE'
                ) AS create_open,
                has_function_privilege(
                  current_user,
                  'creator_agent_admit_user_message_v1(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,timestamptz,text,text,text,bytea,bytea,bytea,text,text,integer,uuid)',
                  'EXECUTE'
                ) AS api_admission,
                has_function_privilege(
                  current_user,
                  'creator_agent_admit_user_message_core_v1(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,timestamptz,text,text,text,bytea,bytea,bytea,text,text,integer,uuid)',
                  'EXECUTE'
                ) AS private_core,
                has_table_privilege(current_user, 'agent_messages', 'INSERT')
                  AS direct_message_insert,
                has_table_privilege(current_user, 'agent_invocations', 'INSERT')
                  AS direct_invocation_insert,
                has_table_privilege(current_user, 'agent_invocation_events', 'INSERT')
                  AS direct_event_insert,
                has_table_privilege(current_user, 'broker_outbox', 'INSERT')
                  AS direct_outbox_insert,
                has_table_privilege(current_user, 'agent_conversations', 'UPDATE')
                  AS direct_conversation_update,
                has_function_privilege(current_user, 'gen_uuid_v7()', 'EXECUTE')
                  AS uuid_generator,
                (SELECT count(*)::text
                   FROM pg_auth_members AS membership
                  WHERE membership.member = (
                          SELECT role.oid FROM pg_roles AS role
                           WHERE role.rolname = current_user
                        )
                     OR membership.roleid = (
                          SELECT role.oid FROM pg_roles AS role
                           WHERE role.rolname = current_user
                        )) AS role_memberships`,
      );
      expect(authority.rows[0]).toEqual({
        current_user: 'combo_agent_consumer_api',
        session_user: 'combo_agent_consumer_api',
        full_accept: true,
        create_open: true,
        api_admission: false,
        private_core: false,
        direct_message_insert: false,
        direct_invocation_insert: false,
        direct_event_insert: false,
        direct_outbox_insert: false,
        direct_conversation_update: false,
        uuid_generator: false,
        role_memberships: '0',
      });
      await expect(
        connection.query(`INSERT INTO agent_messages DEFAULT VALUES`),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        connection.query(`UPDATE agent_conversations SET state = 'CLOSED' WHERE false`),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        connection.query(
          `SELECT * FROM creator_agent_admit_user_message_core_v1(
             NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid,
             NULL::text, NULL::uuid, NULL::integer, NULL::timestamptz,
             NULL::text, NULL::text, NULL::text, NULL::bytea, NULL::bytea,
             NULL::bytea, NULL::text, NULL::text, NULL::integer, NULL::uuid
           )`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      connection.release();
    }
    await expect(
      owner.query(
        `SELECT * FROM creator_agent_accept_consumer_message_v1(
           NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid,
           NULL::text, NULL::uuid, NULL::text, NULL::text,
           NULL::text, NULL::text, NULL::bytea, NULL::bytea,
           NULL::bytea, NULL::text, NULL::text, NULL::integer
         )`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('rejects a direct Consumer create-v2 UUIDv7 before Conversation or Outbox persistence', async () => {
    const idempotencyKey = randomUuidV7();
    const connection = await consumer.connect();
    try {
      await connection.query('BEGIN');
      await connection.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creator]);
      await connection.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumer]);
      await expect(
        connection.query(
          `SELECT * FROM creator_agent_create_opening_conversation_v2(
             $1, $2, $3, $4, $5, $6, $7, $8,
             $9, $10, $11, $12, $13, $14, $15
           )`,
          [
            ids.agent,
            ids.deployment,
            ids.version,
            ids.creator,
            ids.consumer,
            idempotencyKey,
            digest('c'),
            versionDigest,
            ids.installation,
            1,
            3600,
            hmac('d'),
            'visible-test-key',
            1,
            'kms://combo/visible/test@1',
          ],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        message: 'fresh Consumer idempotency key must use UUIDv4',
      });
      await connection.query('ROLLBACK');
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
    await expect(
      owner.query(
        `SELECT count(*)::text AS conversations,
                (SELECT count(*)::text
                   FROM broker_outbox AS command
                   JOIN agent_conversations AS conversation
                     ON conversation.id = command.conversation_id
                  WHERE conversation.consumer_subject_id = $1
                    AND conversation.idempotency_key = $2::uuid) AS commands
           FROM agent_conversations
          WHERE consumer_subject_id = $1 AND idempotency_key = $2::uuid`,
        [ids.consumer, idempotencyKey],
      ),
    ).resolves.toMatchObject({ rows: [{ conversations: '0', commands: '0' }] });
  });

  it('atomically accepts one USER Message with caller Message ID and database-owned facts', async () => {
    const conversationId = await createConversation();
    const input = acceptInput(conversationId, { userMessageId: await runtimeMessageId() });
    const connection = await consumer.connect();
    let accepted: AcceptRow | undefined;
    try {
      await connection.query('BEGIN');
      accepted = await acceptInsideTransaction(connection, input);
      await connection.query('SET CONSTRAINTS ALL IMMEDIATE');
      await expect(footprint(conversationId)).resolves.toEqual({
        state: 'IDLE',
        next_turn_no: 1,
        context_limit_reached_at: null,
        messages: '0',
        invocations: '0',
        events: '0',
        outbox: '0',
      });
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
    if (!accepted) throw new Error('Consumer accept did not return before COMMIT');

    expect(accepted).toMatchObject({
      accept_outcome: 'ADMITTED',
      user_message_id: input.userMessageId,
      invocation_state: 'ACCEPTED',
    });
    for (const generated of [
      accepted.invocation_id,
      accepted.outbox_command_id,
      accepted.source_event_id,
    ]) {
      expectUuidV7(generated);
      expect(generated).not.toBe(input.userMessageId);
    }
    expect(accepted.deadline_at).toBeInstanceOf(Date);

    const chain = await owner.query<{
      message_id: string;
      invocation_id: string;
      command_id: string;
      source_event_id: string;
      request_digest: string;
      invocation_state: string;
      conversation_state: string;
      next_turn_no: number;
      event_payload: { state: string };
      command_state: string;
      command_type: string;
      dedupe_key: string;
      deadline_seconds: string;
      outbox_deadline_matches: boolean;
      outbox_clock_matches: boolean;
      target_worker_id: string;
    }>(
      `SELECT message.id AS message_id,
              invocation.id AS invocation_id,
              command.command_id,
              event.source_event_id,
              invocation.request_digest,
              invocation.state AS invocation_state,
              conversation.state AS conversation_state,
              conversation.next_turn_no,
              event.payload AS event_payload,
              command.state AS command_state,
              command.command_type,
              command.dedupe_key,
              extract(epoch FROM invocation.deadline_at - event.occurred_at)::text
                AS deadline_seconds,
              command.expires_at = invocation.deadline_at AS outbox_deadline_matches,
              command.next_attempt_at = event.occurred_at AS outbox_clock_matches,
              command.target_worker_id
         FROM agent_messages AS message
         JOIN agent_invocations AS invocation
           ON invocation.id = message.invocation_id
          AND invocation.user_message_id = message.id
         JOIN agent_invocation_events AS event
           ON event.invocation_id = invocation.id
          AND event.journal_seq = 1
         JOIN broker_outbox AS command
           ON command.invocation_id = invocation.id
          AND command.command_type = 'invocation.prepare'
         JOIN agent_conversations AS conversation ON conversation.id = invocation.conversation_id
        WHERE message.id = $1`,
      [input.userMessageId],
    );
    expect(chain.rows).toEqual([
      {
        message_id: input.userMessageId,
        invocation_id: accepted.invocation_id,
        command_id: accepted.outbox_command_id,
        source_event_id: accepted.source_event_id,
        request_digest: input.requestDigest,
        invocation_state: 'ACCEPTED',
        conversation_state: 'BUSY',
        next_turn_no: 2,
        event_payload: { state: 'ACCEPTED' },
        command_state: 'PENDING',
        command_type: 'invocation.prepare',
        dedupe_key: `invocation:${accepted.invocation_id}:prepare`,
        deadline_seconds: '30.000000',
        outbox_deadline_matches: true,
        outbox_clock_matches: true,
        target_worker_id: ids.installation,
      },
    ]);
  });

  it('serializes concurrent same-key accepts into one ADMITTED chain and exact REPLAYs', async () => {
    const conversationId = await createConversation();
    const base = acceptInput(conversationId);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => accept({ ...base, userMessageId: randomUuidV7() })),
    );
    expect(results.filter((row) => row.accept_outcome === 'ADMITTED')).toHaveLength(1);
    expect(results.filter((row) => row.accept_outcome === 'REPLAY')).toHaveLength(11);
    const identities = new Set(
      results.map((row) =>
        [
          row.user_message_id,
          row.invocation_id,
          row.outbox_command_id,
          row.source_event_id,
          row.deadline_at?.toISOString(),
        ].join('|'),
      ),
    );
    expect(identities.size).toBe(1);
    await expect(footprint(conversationId)).resolves.toMatchObject({
      state: 'BUSY',
      next_turn_no: 2,
      messages: '1',
      invocations: '1',
      events: '1',
      outbox: '1',
    });

    const conflict = await accept({
      ...base,
      userMessageId: randomUuidV7(),
      requestDigest: hmac('3'),
    });
    expect(conflict).toEqual({
      accept_outcome: 'CONFLICT',
      user_message_id: null,
      invocation_id: null,
      invocation_state: null,
      outbox_command_id: null,
      source_event_id: null,
      deadline_at: null,
    });
    await expect(footprint(conversationId)).resolves.toMatchObject({
      messages: '1',
      invocations: '1',
      events: '1',
      outbox: '1',
    });
  });

  it('rejects fresh non-v4 keys while preserving exact legacy replay and conflict', async () => {
    const freshConversation = await createConversation();
    const freshV7 = acceptInput(freshConversation, {
      clientMessageId: randomUuidV7(),
      userMessageId: await runtimeMessageId(),
    });
    await expect(accept(freshV7)).rejects.toMatchObject({
      code: '23514',
      message: 'fresh Consumer message idempotency key must be canonical UUIDv4',
    });
    await expect(footprint(freshConversation)).resolves.toMatchObject({
      state: 'IDLE',
      next_turn_no: 1,
      messages: '0',
      invocations: '0',
      events: '0',
      outbox: '0',
    });

    const legacyConversation = await createConversation();
    const legacy = acceptInput(legacyConversation, {
      clientMessageId: `legacy-idempotency-${randomUUID()}`,
      userMessageId: await runtimeMessageId(),
    });
    const durable = await seedLegacyAcceptedChain(legacy);
    const replay = await accept({ ...legacy, userMessageId: await runtimeMessageId() });
    expect(replay).toEqual(durable);
    const conflict = await accept({
      ...legacy,
      userMessageId: await runtimeMessageId(),
      requestDigest: hmac('f'),
    });
    expect(conflict).toMatchObject({
      accept_outcome: 'CONFLICT',
      user_message_id: null,
      invocation_id: null,
      outbox_command_id: null,
      source_event_id: null,
      deadline_at: null,
    });
    await expect(footprint(legacyConversation)).resolves.toMatchObject({
      state: 'BUSY',
      next_turn_no: 2,
      messages: '1',
      invocations: '1',
      events: '1',
      outbox: '1',
    });
  });

  it('derives exact 1-second and 120-second deadlines and rejects invalid pinned policy', async () => {
    for (const seconds of [1, 120]) {
      const version = await createVersion(seconds);
      const conversationId = await createConversation(version);
      const input = acceptInput(conversationId, {
        expectedAgentVersionId: version.id,
        expectedVersionDigest: version.digest,
        userMessageId: await runtimeMessageId(),
      });
      const accepted = await accept(input);
      expect(accepted.accept_outcome).toBe('ADMITTED');
      const timing = await owner.query<{ seconds: string }>(
        `SELECT extract(epoch FROM invocation.deadline_at - event.occurred_at)::text AS seconds
           FROM agent_invocations AS invocation
           JOIN agent_invocation_events AS event
             ON event.invocation_id = invocation.id
            AND event.journal_seq = 1
          WHERE invocation.id = $1`,
        [accepted.invocation_id],
      );
      expect(timing.rows).toEqual([{ seconds: `${seconds}.000000` }]);
    }

    for (const invalid of [0, 121, '30']) {
      const version = await createVersion(invalid);
      const conversationId = await createConversation(version);
      const input = acceptInput(conversationId, {
        expectedAgentVersionId: version.id,
        expectedVersionDigest: version.digest,
        userMessageId: await runtimeMessageId(),
      });
      await expect(
        accept(input),
        `maxTurnSeconds=${JSON.stringify(invalid)}`,
      ).rejects.toMatchObject({ code: '23514' });
      await expect(footprint(conversationId)).resolves.toEqual({
        state: 'IDLE',
        next_turn_no: 1,
        context_limit_reached_at: null,
        messages: '0',
        invocations: '0',
        events: '0',
        outbox: '0',
      });
    }
  });

  it('commits only the monotonic context-limit marker when the candidate exceeds policy', async () => {
    const conversationId = await createConversation();
    const input = acceptInput(conversationId, {
      ...cipherInput(Buffer.alloc(33, 5), randomUUID()),
    });
    const limited = await accept(input);
    expect(limited).toEqual({
      accept_outcome: 'CONTEXT_LIMIT',
      user_message_id: null,
      invocation_id: null,
      invocation_state: null,
      outbox_command_id: null,
      source_event_id: null,
      deadline_at: null,
    });
    const first = await footprint(conversationId);
    expect(first).toMatchObject({
      state: 'SUSPENDED',
      next_turn_no: 1,
      messages: '0',
      invocations: '0',
      events: '0',
      outbox: '0',
    });
    expect(first.context_limit_reached_at).toBeInstanceOf(Date);

    await expect(accept({ ...input, userMessageId: randomUuidV7() })).resolves.toMatchObject({
      accept_outcome: 'CONTEXT_LIMIT',
    });
    const replay = await footprint(conversationId);
    expect(replay).toEqual(first);
  });

  it('rejects cross-Consumer authority and returns zero-mutation UNAVAILABLE for stale tuples', async () => {
    const conversationId = await createConversation();
    const input = acceptInput(conversationId);
    await expect(
      accept({ ...input, consumerId: ids.intruder }, ids.intruder),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(footprint(conversationId)).resolves.toMatchObject({
      state: 'IDLE',
      next_turn_no: 1,
      messages: '0',
      invocations: '0',
      events: '0',
      outbox: '0',
    });

    const unavailable = await accept({ ...input, expectedVersionDigest: digest('f') });
    expect(unavailable).toEqual({
      accept_outcome: 'UNAVAILABLE',
      user_message_id: null,
      invocation_id: null,
      invocation_state: null,
      outbox_command_id: null,
      source_event_id: null,
      deadline_at: null,
    });
    await expect(footprint(conversationId)).resolves.toMatchObject({
      state: 'IDLE',
      next_turn_no: 1,
      messages: '0',
      invocations: '0',
      events: '0',
      outbox: '0',
    });

    const expiredConversation = await createConversation(undefined, true);
    const expired = await accept(
      acceptInput(expiredConversation, { userMessageId: await runtimeMessageId() }),
    );
    expect(expired.accept_outcome).toBe('UNAVAILABLE');
    await expect(footprint(expiredConversation)).resolves.toMatchObject({
      state: 'IDLE',
      next_turn_no: 1,
      messages: '0',
      invocations: '0',
      events: '0',
      outbox: '0',
    });
  });

  it('blocks fresh accept after Version SECURITY revoke or when the active Lease is expiring', async () => {
    const revokedVersion = await createVersion(30);
    const revokedConversation = await createConversation(revokedVersion);
    await owner.query(
      `UPDATE agent_version_controls
          SET availability = 'REVOKED', severity = 'SECURITY',
              reason_code = 'TEST_SECURITY_REVOKE', updated_at = clock_timestamp()
        WHERE version_id = $1 AND creator_id = $2`,
      [revokedVersion.id, ids.creator],
    );
    const revoked = await accept(
      acceptInput(revokedConversation, {
        expectedAgentVersionId: revokedVersion.id,
        expectedVersionDigest: revokedVersion.digest,
        userMessageId: await runtimeMessageId(),
      }),
    );
    expect(revoked.accept_outcome).toBe('UNAVAILABLE');
    await expect(footprint(revokedConversation)).resolves.toMatchObject({
      state: 'IDLE',
      next_turn_no: 1,
      messages: '0',
      invocations: '0',
      events: '0',
      outbox: '0',
    });

    const expiringConversation = await createConversation();
    const expiringLease = await replaceActiveLease(ids.lease, 2, 2);
    try {
      const unavailable = await accept(
        acceptInput(expiringConversation, { userMessageId: await runtimeMessageId() }),
      );
      expect(unavailable.accept_outcome).toBe('UNAVAILABLE');
    } finally {
      await replaceActiveLease(expiringLease, 3, 3600);
    }
    await expect(footprint(expiringConversation)).resolves.toMatchObject({
      state: 'IDLE',
      next_turn_no: 1,
      messages: '0',
      invocations: '0',
      events: '0',
      outbox: '0',
    });
  });

  it('executes every Deployment, Worker, Gateway, and three-second freshness fence in PostgreSQL', async () => {
    const unavailableCases: ReadonlyArray<{
      title: string;
      options: LiveAuthorityOptions;
    }> = [
      {
        title: 'desired offline',
        options: { desiredState: 'OFFLINE', observedState: 'ONLINE' },
      },
      { title: 'observed degraded', options: { observedState: 'DEGRADED' } },
      {
        title: 'generation mismatch',
        options: { generation: 2, observedGeneration: 1 },
      },
      { title: 'observed Worker mismatch', options: { observedWorkerMatches: false } },
      { title: 'installation revoked', options: { installationRevoked: true } },
      { title: 'Gateway closed', options: { gatewayState: 'CLOSED' } },
      { title: 'Gateway below freshness window', options: { gatewayExpiresSeconds: 2 } },
      { title: 'Gateway at freshness window', options: { gatewayExpiresSeconds: 3 } },
      { title: 'Lease below freshness window', options: { leaseExpiresSeconds: 2 } },
      { title: 'Lease at freshness window', options: { leaseExpiresSeconds: 3 } },
    ];
    for (const testCase of unavailableCases) {
      const fixture = await createLiveAuthorityFixture(testCase.options);
      const outcome = await accept(
        acceptInput(fixture.conversationId, {
          expectedAgentVersionId: fixture.versionId,
          expectedVersionDigest: fixture.versionDigest,
          userMessageId: await runtimeMessageId(),
        }),
      );
      expect(outcome.accept_outcome, testCase.title).toBe('UNAVAILABLE');
      await expect(footprint(fixture.conversationId), testCase.title).resolves.toMatchObject({
        state: 'IDLE',
        next_turn_no: 1,
        messages: '0',
        invocations: '0',
        events: '0',
        outbox: '0',
      });
    }

    for (const testCase of [
      { title: 'Gateway above freshness window', options: { gatewayExpiresSeconds: 10 } },
      { title: 'Lease above freshness window', options: { leaseExpiresSeconds: 10 } },
    ] as const) {
      const fixture = await createLiveAuthorityFixture(testCase.options);
      const outcome = await accept(
        acceptInput(fixture.conversationId, {
          expectedAgentVersionId: fixture.versionId,
          expectedVersionDigest: fixture.versionDigest,
          userMessageId: await runtimeMessageId(),
        }),
      );
      expect(outcome.accept_outcome, testCase.title).toBe('ADMITTED');
      await expect(footprint(fixture.conversationId), testCase.title).resolves.toMatchObject({
        state: 'BUSY',
        next_turn_no: 2,
        messages: '1',
        invocations: '1',
        events: '1',
        outbox: '1',
      });
    }
  });

  it('rolls back the complete accept chain at every write boundary and before COMMIT', async () => {
    const failpoints = [
      { relation: 'agent_messages', event: 'INSERT' },
      { relation: 'agent_conversations', event: 'UPDATE' },
      { relation: 'agent_invocations', event: 'INSERT' },
      { relation: 'agent_invocation_events', event: 'INSERT' },
      { relation: 'broker_outbox', event: 'INSERT' },
    ] as const;
    for (const failpoint of failpoints) {
      for (const timing of ['BEFORE', 'AFTER'] as const) {
        const conversationId = await createConversation();
        const input = acceptInput(conversationId, { userMessageId: await runtimeMessageId() });
        const suffix = randomUUID().replaceAll('-', '');
        const functionName = `test_reject_accept_${suffix}`;
        const triggerName = `test_reject_accept_${suffix}`;
        await owner.query(`
          CREATE FUNCTION public.${functionName}()
          RETURNS trigger
          LANGUAGE plpgsql
          AS $test_reject_accept$
          BEGIN
            RAISE EXCEPTION 'synthetic accept failpoint' USING ERRCODE = 'P0001';
          END;
          $test_reject_accept$;
          CREATE TRIGGER ${triggerName}
          ${timing} ${failpoint.event} ON public.${failpoint.relation}
          FOR EACH ROW EXECUTE FUNCTION public.${functionName}();
        `);
        try {
          await expect(
            accept(input),
            `${timing} ${failpoint.event} ${failpoint.relation}`,
          ).rejects.toMatchObject({ code: 'P0001' });
        } finally {
          await owner.query(`DROP TRIGGER ${triggerName} ON public.${failpoint.relation}`);
          await owner.query(`DROP FUNCTION public.${functionName}()`);
        }
        await expect(footprint(conversationId)).resolves.toEqual({
          state: 'IDLE',
          next_turn_no: 1,
          context_limit_reached_at: null,
          messages: '0',
          invocations: '0',
          events: '0',
          outbox: '0',
        });
      }
    }

    const rollbackConversation = await createConversation();
    const rollbackInput = acceptInput(rollbackConversation, {
      userMessageId: await runtimeMessageId(),
    });
    const connection = await consumer.connect();
    try {
      await connection.query('BEGIN');
      await expect(acceptInsideTransaction(connection, rollbackInput)).resolves.toMatchObject({
        accept_outcome: 'ADMITTED',
      });
      await connection.query('SET CONSTRAINTS ALL IMMEDIATE');
      await connection.query('ROLLBACK');
    } finally {
      connection.release();
    }
    await expect(footprint(rollbackConversation)).resolves.toEqual({
      state: 'IDLE',
      next_turn_no: 1,
      context_limit_reached_at: null,
      messages: '0',
      invocations: '0',
      events: '0',
      outbox: '0',
    });
  });
});
