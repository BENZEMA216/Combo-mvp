import { randomBytes, randomUUID } from 'node:crypto';
import {
  CONSUMER_EVENT_OUTBOX_PROTOCOL,
  consumerEventDedupeKey,
  consumerEventPayloadDigest,
} from '@cb/creator-agent-protocol';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
const passwords = {
  combo_agent_api: process.env.POSTGRES_AGENT_API_PASSWORD,
  combo_agent_broker: process.env.POSTGRES_AGENT_BROKER_PASSWORD,
  combo_agent_reconciler: process.env.POSTGRES_AGENT_RECONCILER_PASSWORD,
} as const;
const enabled =
  process.env.CREATOR_AGENT_PG_TEST === '1' &&
  Boolean(databaseUrl) &&
  Object.values(passwords).every(Boolean);
const pgDescribe = enabled ? describe : describe.skip;

function randomUuidV7(): string {
  const value = randomUUID();
  return `${value.slice(0, 14)}7${value.slice(15)}`;
}

type VnextRole = keyof typeof passwords;

function roleConnectionString(role: VnextRole): string {
  const url = new URL(databaseUrl!);
  url.username = role;
  url.password = passwords[role]!;
  return url.toString();
}

async function setLocalTenant(
  client: Client,
  identity: { creatorId?: string; consumerId?: string },
): Promise<void> {
  if (identity.creatorId) {
    await client.query(`SELECT set_config('app.creator_id', $1, true)`, [identity.creatorId]);
  }
  if (identity.consumerId) {
    await client.query(`SELECT set_config('app.consumer_id', $1, true)`, [identity.consumerId]);
  }
}

pgDescribe('Creator-hosted Agent VNext PostgreSQL authority', () => {
  const owner = new Client({ connectionString: databaseUrl });
  const clients = new Map<VnextRole, Client>();
  const ids = {
    creatorA: '',
    creatorB: '',
    consumerA: '',
    consumerB: '',
    snapshotA: randomUuidV7(),
    snapshotB: randomUuidV7(),
    agentA: randomUuidV7(),
    agentB: randomUuidV7(),
    versionA: randomUuidV7(),
    versionB: randomUuidV7(),
    deploymentA: randomUuidV7(),
    workerA: randomUuidV7(),
    leaseA: randomUuidV7(),
    conversationA: randomUuidV7(),
    conversationB: randomUuidV7(),
  };

  beforeAll(async () => {
    await owner.connect();
    for (const role of Object.keys(passwords) as VnextRole[]) {
      const client = new Client({
        connectionString: roleConnectionString(role),
        application_name: `combo-vnext-role-${role}`,
      });
      await client.connect();
      clients.set(role, client);
    }

    const users = await owner.query<{ id: string }>(
      `INSERT INTO users (account)
       VALUES ($1), ($2), ($3), ($4)
       RETURNING id`,
      ['creator-aaaaaaaa', 'creator-bbbbbbbb', 'creator-cccccccc', 'creator-dddddddd'],
    );
    [ids.creatorA, ids.creatorB, ids.consumerA, ids.consumerB] = users.rows.map((row) => row.id);

    const digest = (character: string) => character.repeat(64);
    const insertSnapshot = async (id: string, creatorId: string, marker: string) =>
      owner.query(
        `INSERT INTO context_snapshots (
           id, creator_id, snapshot_digest, archive_digest, cipher_digest,
           object_key, manifest_object_key, compressed_bytes, expanded_bytes,
           file_count, encryption_key_ref
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 128, 256, 1, $8)`,
        [
          id,
          creatorId,
          digest(marker),
          digest(marker === 'a' ? 'c' : 'd'),
          digest(marker === 'a' ? 'e' : 'f'),
          `vnext/${id}.cipher`,
          `vnext/${id}.manifest`,
          `kms://${id}`,
        ],
      );
    await insertSnapshot(ids.snapshotA, ids.creatorA, 'a');
    await insertSnapshot(ids.snapshotB, ids.creatorB, 'b');

    await owner.query(
      `INSERT INTO agents (id, creator_id, public_slug, name)
       VALUES ($1, $2, $3, 'Agent A'), ($4, $5, $6, 'Agent B')`,
      [
        ids.agentA,
        ids.creatorA,
        `agent-${ids.agentA.slice(0, 8)}`,
        ids.agentB,
        ids.creatorB,
        `agent-${ids.agentB.slice(0, 8)}`,
      ],
    );

    const insertVersion = async (
      id: string,
      agentId: string,
      creatorId: string,
      snapshotId: string,
      marker: string,
    ) =>
      owner.query(
        `INSERT INTO agent_versions (
           id, agent_id, creator_id, ordinal, schema_version, version_digest, snapshot_id,
           behavior_contract, behavior_contract_digest, runtime_policy, runtime_policy_digest,
           io_contract, io_contract_digest, model_policy, model_policy_digest,
           codex_runtime_version, codex_runtime_artifact_digest, codex_protocol_schema_digest
         ) VALUES (
           $1, $2, $3, 1, 1, $4, $5,
           '{}'::jsonb, $6, '{}'::jsonb, $7,
           '{}'::jsonb, $8, '{}'::jsonb, $9,
           '0.147.0-alpha.6.5', $10, $11
         )`,
        [
          id,
          agentId,
          creatorId,
          digest(marker),
          snapshotId,
          digest('1'),
          digest('2'),
          digest('3'),
          digest('4'),
          `sha256:${digest('5')}`,
          `sha256:${digest('6')}`,
        ],
      );
    await insertVersion(ids.versionA, ids.agentA, ids.creatorA, ids.snapshotA, '7');
    await insertVersion(ids.versionB, ids.agentB, ids.creatorB, ids.snapshotB, '8');

    await owner.query(
      `INSERT INTO deployments (
         id, agent_id, creator_id, environment, desired_version_id
       ) VALUES ($1, $2, $3, 'TEST', $4)`,
      [ids.deploymentA, ids.agentA, ids.creatorA, ids.versionA],
    );
    await owner.query(
      `INSERT INTO worker_installations (
         id, creator_id, installation_key_id, device_public_key,
         worker_version, protocol_versions, capabilities
       ) VALUES ($1, $2, $3, $4, '0.1.0', '[1]'::jsonb, '{}'::jsonb)`,
      [ids.workerA, ids.creatorA, `key-${ids.workerA}`, Buffer.alloc(65, 4)],
    );
    await owner.query(
      `INSERT INTO worker_leases (
         id, deployment_id, creator_id, worker_id, connection_id, fence, expires_at
       ) VALUES ($1, $2, $3, $4, $5, 1, now() + interval '30 seconds')`,
      [ids.leaseA, ids.deploymentA, ids.creatorA, ids.workerA, randomUuidV7()],
    );
    await owner.query(
      `INSERT INTO agent_conversations (
         id, agent_id, deployment_id, agent_version_id, creator_id,
         consumer_subject_id, idempotency_key, request_digest,
         version_digest, state, expires_at
       ) VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'IDLE', now() + interval '1 hour'),
         ($10, $2, $3, $4, $5, $11, $12, $13, $9, 'IDLE', now() + interval '1 hour')`,
      [
        ids.conversationA,
        ids.agentA,
        ids.deploymentA,
        ids.versionA,
        ids.creatorA,
        ids.consumerA,
        randomUuidV7(),
        digest('c'),
        digest('7'),
        ids.conversationB,
        ids.consumerB,
        randomUuidV7(),
        digest('d'),
      ],
    );
  });

  afterAll(async () => {
    await Promise.all([owner.end(), ...[...clients.values()].map((client) => client.end())]);
  });

  it('forces transaction-local Creator and Consumer RLS without pool leakage', async () => {
    const api = clients.get('combo_agent_api')!;
    await expect(api.query(`SELECT id FROM agents`)).resolves.toMatchObject({ rows: [] });

    await api.query('BEGIN');
    await setLocalTenant(api, { creatorId: ids.creatorA });
    const creatorRows = await api.query<{ id: string }>(`SELECT id FROM agents ORDER BY id`);
    expect(creatorRows.rows.map((row) => row.id)).toEqual([ids.agentA]);
    await api.query('COMMIT');

    await expect(api.query(`SELECT id FROM agents`)).resolves.toMatchObject({ rows: [] });
    await api.query('BEGIN');
    await setLocalTenant(api, { consumerId: ids.consumerA });
    const consumerOnlyRows = await api.query<{ id: string }>(
      `SELECT id FROM agent_conversations ORDER BY id`,
    );
    expect(consumerOnlyRows.rows.map((row) => row.id)).toEqual([ids.conversationA]);
    await api.query('COMMIT');

    await api.query('BEGIN');
    await setLocalTenant(api, { creatorId: ids.creatorA, consumerId: ids.consumerA });
    const consumerRows = await api.query<{ id: string }>(
      `SELECT id FROM agent_conversations ORDER BY id`,
    );
    expect(consumerRows.rows.map((row) => row.id)).toEqual([ids.conversationA]);
    await expect(
      api.query(
        `INSERT INTO agent_conversations (
           agent_id, deployment_id, agent_version_id, creator_id,
           consumer_subject_id, idempotency_key, request_digest,
           version_digest, state, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'IDLE', now() + interval '1 hour')`,
        [
          ids.agentA,
          ids.deploymentA,
          ids.versionA,
          ids.creatorA,
          ids.consumerB,
          randomUuidV7(),
          'e'.repeat(64),
          '7'.repeat(64),
        ],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await api.query('ROLLBACK');
  });

  it('rejects cross-Creator composite references and immutable Version mutations', async () => {
    await expect(
      owner.query(
        `INSERT INTO agent_versions (
           agent_id, creator_id, ordinal, schema_version, version_digest, snapshot_id,
           behavior_contract, behavior_contract_digest, runtime_policy, runtime_policy_digest,
           io_contract, io_contract_digest, model_policy, model_policy_digest,
           codex_runtime_version, codex_runtime_artifact_digest, codex_protocol_schema_digest
         ) VALUES (
           $1, $2, 2, 1, $3, $4, '{}'::jsonb, $5, '{}'::jsonb, $5,
           '{}'::jsonb, $5, '{}'::jsonb, $5, 'test', $6, $6
         )`,
        [
          ids.agentA,
          ids.creatorA,
          '9'.repeat(64),
          ids.snapshotB,
          'a'.repeat(64),
          `sha256:${'b'.repeat(64)}`,
        ],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      owner.query(`UPDATE agent_versions SET ordinal = 2 WHERE id = $1`, [ids.versionA]),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('keeps upload, Version-control, Agent, Worker, and Conversation state monotonic', async () => {
    const uploadId = randomUuidV7();
    await owner.query(
      `INSERT INTO snapshot_uploads (
         id, creator_id, idempotency_key, request_digest,
         expected_snapshot_digest, expected_archive_digest,
         expected_compressed_bytes, temp_object_key, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 128, $7, now() + interval '1 hour')`,
      [
        uploadId,
        ids.creatorA,
        `upload-${uploadId}`,
        `hmac-sha256:${'1'.repeat(64)}`,
        '2'.repeat(64),
        '3'.repeat(64),
        `tmp/${uploadId}`,
      ],
    );
    await expect(
      owner.query(
        `UPDATE snapshot_uploads SET state = 'VERIFIED', verified_at = now() WHERE id = $1`,
        [uploadId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await owner.query(`UPDATE snapshot_uploads SET state = 'UPLOADED' WHERE id = $1`, [uploadId]);
    await owner.query(`UPDATE snapshot_uploads SET state = 'VERIFYING' WHERE id = $1`, [uploadId]);
    await owner.query(
      `UPDATE snapshot_uploads SET state = 'VERIFIED', verified_at = now() WHERE id = $1`,
      [uploadId],
    );
    await expect(
      owner.query(
        `UPDATE snapshot_uploads SET state = 'UPLOADED', verified_at = NULL WHERE id = $1`,
        [uploadId],
      ),
    ).rejects.toMatchObject({ code: '55000' });

    await owner.query(
      `INSERT INTO agent_version_controls (version_id, creator_id)
       VALUES ($1, $2)`,
      [ids.versionB, ids.creatorB],
    );
    await owner.query(
      `UPDATE agent_version_controls
          SET availability = 'DEPRECATED', updated_at = now()
        WHERE version_id = $1`,
      [ids.versionB],
    );
    await expect(
      owner.query(
        `UPDATE agent_version_controls
            SET availability = 'ACTIVE', updated_at = now()
          WHERE version_id = $1`,
        [ids.versionB],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await owner.query(
      `UPDATE agents SET lifecycle = 'ARCHIVED', updated_at = now() WHERE id = $1`,
      [ids.agentB],
    );
    await expect(
      owner.query(`UPDATE agents SET lifecycle = 'ACTIVE', updated_at = now() WHERE id = $1`, [
        ids.agentB,
      ]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      owner.query(`UPDATE worker_installations SET device_public_key = $2 WHERE id = $1`, [
        ids.workerA,
        Buffer.alloc(65, 5),
      ]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      owner.query(
        `UPDATE agent_conversations SET state = 'CLOSED', closed_at = now() WHERE id = $1`,
        [ids.conversationA],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('allows exactly one valid access-grant revocation and never reopens it', async () => {
    const grantId = randomUuidV7();
    await owner.query(
      `INSERT INTO agent_access_grants (
         id, agent_id, creator_id, consumer_subject_id
       ) VALUES ($1, $2, $3, $4)`,
      [grantId, ids.agentA, ids.creatorA, ids.consumerA],
    );

    await expect(
      owner.query(
        `UPDATE agent_access_grants
            SET state = 'REVOKED', revoked_at = created_at - interval '1 second'
          WHERE id = $1`,
        [grantId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await owner.query(
      `UPDATE agent_access_grants
          SET state = 'REVOKED', revoked_at = clock_timestamp()
        WHERE id = $1`,
      [grantId],
    );
    await expect(
      owner.query(
        `UPDATE agent_access_grants
            SET state = 'ACTIVE', revoked_at = NULL
          WHERE id = $1`,
        [grantId],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      owner.query(
        `UPDATE agent_access_grants
            SET consumer_subject_id = $2
          WHERE id = $1`,
        [grantId, ids.consumerB],
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('keeps Deployment generations and Lease fencing monotonic', async () => {
    await expect(
      owner.query(`UPDATE deployments SET desired_state = 'ONLINE' WHERE id = $1`, [
        ids.deploymentA,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner.query(
        `UPDATE deployments
            SET desired_state = 'ONLINE', generation = generation + 1, updated_at = now()
          WHERE id = $1`,
        [ids.deploymentA],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      owner.query(`UPDATE deployments SET generation = generation - 1 WHERE id = $1`, [
        ids.deploymentA,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner.query(
        `UPDATE worker_leases SET renewed_at = acquired_at - interval '1 second' WHERE id = $1`,
        [ids.leaseA],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('binds assignment to the exact Lease worker and fence', async () => {
    const userMessageId = randomUuidV7();
    await owner.query(
      `INSERT INTO agent_messages (
         id, conversation_id, creator_id, consumer_subject_id, turn_no, role,
         client_message_id, content_algorithm, content_key_id, content_nonce,
         content_ciphertext, content_auth_tag, content_cipher_digest,
         content_digest, content_aad_version
       ) VALUES (
         $1, $2, $3, $4, 1, 'USER', $5, 'aes-256-gcm/v1', 'test-key',
         $6, $7, $8, $9, $10, 1
       )`,
      [
        userMessageId,
        ids.conversationA,
        ids.creatorA,
        ids.consumerA,
        randomUuidV7(),
        randomBytes(12),
        Buffer.from('ciphertext'),
        Buffer.alloc(16, 2),
        'c'.repeat(64),
        `hmac-sha256:${'d'.repeat(64)}`,
      ],
    );
    await expect(
      owner.query(
        `INSERT INTO agent_invocations (
           conversation_id, creator_id, consumer_subject_id, agent_version_id,
           user_message_id, client_message_id, request_digest, assigned_worker_id,
           assignment_lease_id, assignment_fence, deadline_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 2, now() + interval '2 minutes')`,
        [
          ids.conversationA,
          ids.creatorA,
          ids.consumerA,
          ids.versionA,
          userMessageId,
          randomUuidV7(),
          `hmac-sha256:${'e'.repeat(64)}`,
          ids.workerA,
          ids.leaseA,
        ],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('enforces WIP=1, exact Event sequence, and immutable Event history', async () => {
    const insertUser = async (turnNo: number) => {
      const id = randomUuidV7();
      await owner.query(
        `INSERT INTO agent_messages (
           id, conversation_id, creator_id, consumer_subject_id, turn_no, role,
           client_message_id, content_algorithm, content_key_id, content_nonce,
           content_ciphertext, content_auth_tag, content_cipher_digest,
           content_digest, content_aad_version
         ) VALUES (
           $1, $2, $3, $4, $5, 'USER', $6, 'aes-256-gcm/v1', 'test-key',
           $7, $8, $9, $10, $11, 1
         )`,
        [
          id,
          ids.conversationB,
          ids.creatorA,
          ids.consumerB,
          turnNo,
          randomUuidV7(),
          randomBytes(12),
          Buffer.from(`ciphertext-${turnNo}`),
          Buffer.alloc(16, turnNo),
          String(turnNo).repeat(64),
          `hmac-sha256:${String(turnNo + 2).repeat(64)}`,
        ],
      );
      return id;
    };
    const firstUser = await insertUser(1);
    const secondUser = await insertUser(2);
    const firstInvocation = randomUuidV7();
    await owner.query(
      `INSERT INTO agent_invocations (
         id, conversation_id, creator_id, consumer_subject_id, agent_version_id,
         user_message_id, client_message_id, request_digest, deadline_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '2 minutes')`,
      [
        firstInvocation,
        ids.conversationB,
        ids.creatorA,
        ids.consumerB,
        ids.versionA,
        firstUser,
        randomUuidV7(),
        `hmac-sha256:${'7'.repeat(64)}`,
      ],
    );
    await expect(
      owner.query(
        `INSERT INTO agent_invocations (
           conversation_id, creator_id, consumer_subject_id, agent_version_id,
           user_message_id, client_message_id, request_digest, deadline_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '2 minutes')`,
        [
          ids.conversationB,
          ids.creatorA,
          ids.consumerB,
          ids.versionA,
          secondUser,
          randomUuidV7(),
          `hmac-sha256:${'8'.repeat(64)}`,
        ],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    await owner.query(
      `INSERT INTO agent_invocation_events (
         invocation_id, creator_id, consumer_subject_id, journal_seq,
         source, source_event_id, event_type, payload, occurred_at
       ) VALUES (
         $1, $2, $3, 1, 'API', $4, 'invocation.accepted',
         '{"state":"ACCEPTED"}'::jsonb, now()
       )`,
      [firstInvocation, ids.creatorA, ids.consumerB, randomUuidV7()],
    );
    await expect(
      owner.query(
        `INSERT INTO agent_invocation_events (
           invocation_id, creator_id, consumer_subject_id, journal_seq,
           source, source_event_id, event_type, payload, occurred_at
         ) VALUES (
           $1, $2, $3, 3, 'BROKER', $4, 'invocation.persisted',
           '{"state":"PERSISTED"}'::jsonb, now()
         )`,
        [firstInvocation, ids.creatorA, ids.consumerB, randomUuidV7()],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner.query(`UPDATE agent_invocation_events SET payload = '{}' WHERE invocation_id = $1`, [
        firstInvocation,
      ]),
    ).rejects.toMatchObject({ code: '55000' });

    await expect(
      owner.query(
        `INSERT INTO agent_invocation_events (
           invocation_id, creator_id, consumer_subject_id, journal_seq,
           source, source_event_id, event_type, payload, occurred_at
         ) VALUES (
           $1, $2, $3, 2, 'BROKER', $4, 'invocation.queued',
           '{"state":"QUEUED"}'::jsonb, now()
         )`,
        [firstInvocation, ids.creatorA, ids.consumerB, randomUuidV7()],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await owner.query(`UPDATE agent_invocations SET state = 'QUEUED' WHERE id = $1`, [
      firstInvocation,
    ]);
    await owner.query(
      `INSERT INTO agent_invocation_events (
         invocation_id, creator_id, consumer_subject_id, journal_seq,
         source, source_event_id, event_type, payload, occurred_at
       ) VALUES (
         $1, $2, $3, 2, 'BROKER', $4, 'invocation.queued',
         '{"state":"QUEUED"}'::jsonb, now()
       )`,
      [firstInvocation, ids.creatorA, ids.consumerB, randomUuidV7()],
    );
    await owner.query(
      `UPDATE agent_invocations SET state = 'CANCELLED', terminal_at = now() WHERE id = $1`,
      [firstInvocation],
    );
    const terminalSourceEventId = randomUuidV7();
    const terminalEvent = await owner.query<{ id: string; occurred_at: Date }>(
      `INSERT INTO agent_invocation_events (
         invocation_id, creator_id, consumer_subject_id, journal_seq,
         source, source_event_id, event_type, payload, occurred_at
       ) VALUES (
         $1, $2, $3, 3, 'BROKER', $4, 'invocation.cancelled',
         '{"state":"CANCELLED"}'::jsonb, now()
       ) RETURNING id::text AS id, occurred_at`,
      [firstInvocation, ids.creatorA, ids.consumerB, terminalSourceEventId],
    );
    await expect(
      owner.query(
        `INSERT INTO agent_invocation_events (
           invocation_id, creator_id, consumer_subject_id, journal_seq,
           source, source_event_id, event_type, payload, occurred_at
         ) VALUES (
           $1, $2, $3, 4, 'BROKER', $4, 'invocation.cancelled',
           '{"state":"CANCELLED"}'::jsonb, now()
         )`,
        [firstInvocation, ids.creatorA, ids.consumerB, randomUuidV7()],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      owner.query(
        `UPDATE agent_invocations SET state = 'QUEUED', terminal_at = NULL WHERE id = $1`,
        [firstInvocation],
      ),
    ).rejects.toMatchObject({ code: '55000' });

    const commandId = randomUuidV7();
    await owner.query(
      `INSERT INTO broker_outbox (
         command_id, creator_id, target_worker_id, invocation_id, consumer_subject_id,
         command_type, dedupe_key, expires_at
       ) VALUES ($1, $2, $3, $4, $5, 'invocation.cancel', $6, now() + interval '1 hour')`,
      [
        commandId,
        ids.creatorA,
        ids.workerA,
        firstInvocation,
        ids.consumerB,
        `cancel:${firstInvocation}`,
      ],
    );
    await owner.query(
      `UPDATE broker_outbox SET state = 'SENT', attempt_count = 1 WHERE command_id = $1`,
      [commandId],
    );
    await owner.query(
      `UPDATE broker_outbox SET state = 'ACKED', acked_at = now() WHERE command_id = $1`,
      [commandId],
    );
    await expect(
      owner.query(
        `UPDATE broker_outbox SET state = 'SENT', acked_at = NULL WHERE command_id = $1`,
        [commandId],
      ),
    ).rejects.toMatchObject({ code: '55000' });

    const terminalEventId = terminalEvent.rows[0]!.id;
    const terminalPayload = {
      protocol: CONSUMER_EVENT_OUTBOX_PROTOCOL,
      schemaVersion: 1 as const,
      type: 'invocation.terminal' as const,
      conversationId: ids.conversationB,
      invocationId: firstInvocation,
      terminalState: 'CANCELLED' as const,
      assistantMessageId: null,
      resultDigest: null,
      errorCode: null,
      occurredAt: terminalEvent.rows[0]!.occurred_at.toISOString(),
    };
    const consumerEvent = await owner.query<{ cursor: string }>(
      `INSERT INTO consumer_event_outbox (
         owner_id, conversation_id, invocation_id, source_event_id, event_type,
         payload, payload_digest, dedupe_key
       ) VALUES (
         $1, $2, $3, $4, 'invocation.terminal', $5::jsonb, $6, $7
       ) RETURNING cursor::text AS cursor`,
      [
        ids.consumerB,
        ids.conversationB,
        firstInvocation,
        terminalEventId,
        JSON.stringify(terminalPayload),
        consumerEventPayloadDigest(terminalPayload),
        consumerEventDedupeKey({
          ownerId: ids.consumerB,
          sourceEventId: terminalEventId,
          eventType: 'invocation.terminal',
        }),
      ],
    );
    const cursor = consumerEvent.rows[0]!.cursor;
    await owner.query(
      `INSERT INTO consumer_event_streams (owner_id, conversation_id, latest_cursor)
       VALUES ($1, $2, $3)`,
      [ids.consumerB, ids.conversationB, cursor],
    );
    await expect(
      owner.query(
        `UPDATE consumer_event_streams SET latest_cursor = 0 WHERE owner_id = $1 AND conversation_id = $2`,
        [ids.consumerB, ids.conversationB],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await owner.query(
      `UPDATE consumer_event_outbox
          SET state = 'PUBLISHED', published_at = now(), next_attempt_at = NULL,
              attempt_count = 1
        WHERE cursor = $1`,
      [cursor],
    );
    await expect(
      owner.query(
        `UPDATE consumer_event_outbox
            SET state = 'PENDING', published_at = NULL
          WHERE cursor = $1`,
        [cursor],
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('keeps each service role non-bypass and least-privileged', async () => {
    for (const [role, client] of clients) {
      const identity = await client.query<{
        current_user: string;
        bypass_rls: boolean;
        superuser: boolean;
      }>(
        `SELECT current_user, rolbypassrls AS bypass_rls, rolsuper AS superuser
           FROM pg_roles WHERE rolname = current_user`,
      );
      expect(identity.rows[0]).toEqual({
        current_user: role,
        bypass_rls: false,
        superuser: false,
      });
    }
    const api = clients.get('combo_agent_api')!;
    const broker = clients.get('combo_agent_broker')!;
    const reconciler = clients.get('combo_agent_reconciler')!;
    await expect(
      api.query(`SELECT has_table_privilege(current_user, 'worker_installations', 'INSERT') AS ok`),
    ).resolves.toMatchObject({ rows: [{ ok: false }] });
    await expect(
      broker.query(`SELECT has_table_privilege(current_user, 'snapshot_uploads', 'INSERT') AS ok`),
    ).resolves.toMatchObject({ rows: [{ ok: false }] });
    await expect(
      broker.query(`SELECT has_table_privilege(current_user, 'deployments', 'INSERT') AS ok`),
    ).resolves.toMatchObject({ rows: [{ ok: false }] });
    await expect(
      broker.query(
        `SELECT has_table_privilege(current_user, 'agent_access_grants', 'SELECT') AS ok`,
      ),
    ).resolves.toMatchObject({ rows: [{ ok: false }] });
    await expect(
      broker.query(
        `SELECT has_table_privilege(current_user, 'agent_conversations', 'INSERT') AS ok`,
      ),
    ).resolves.toMatchObject({ rows: [{ ok: false }] });
    await expect(
      broker.query(`SELECT has_table_privilege(current_user, 'agent_invocations', 'INSERT') AS ok`),
    ).resolves.toMatchObject({ rows: [{ ok: false }] });
    await expect(
      reconciler.query(
        `SELECT has_table_privilege(current_user, 'agent_versions', 'UPDATE') AS ok`,
      ),
    ).resolves.toMatchObject({ rows: [{ ok: false }] });
    await expect(
      reconciler.query(
        `SELECT has_table_privilege(current_user, 'agent_access_grants', 'SELECT') AS ok`,
      ),
    ).resolves.toMatchObject({ rows: [{ ok: false }] });
    await expect(
      api.query(`SELECT has_table_privilege(current_user, 'agents', 'UPDATE') AS ok`),
    ).resolves.toMatchObject({ rows: [{ ok: false }] });
    await expect(
      api.query(`SELECT has_column_privilege(current_user, 'agents', 'name', 'UPDATE') AS ok`),
    ).resolves.toMatchObject({ rows: [{ ok: true }] });
    await expect(
      api.query(
        `SELECT has_column_privilege(current_user, 'agents', 'creator_id', 'UPDATE') AS ok`,
      ),
    ).resolves.toMatchObject({ rows: [{ ok: false }] });
    await expect(
      api.query(`SELECT has_table_privilege(current_user, 'worker_leases', 'UPDATE') AS ok`),
    ).resolves.toMatchObject({ rows: [{ ok: false }] });
    await expect(
      api.query(
        `SELECT has_column_privilege(
           current_user,
           'agent_access_grants',
           'state',
           'UPDATE'
         ) AS ok`,
      ),
    ).resolves.toMatchObject({ rows: [{ ok: false }] });
    await expect(
      api.query(
        `SELECT has_function_privilege(
           current_user,
           'creator_agent_lock_live_worker(uuid,uuid,uuid,bigint)',
           'EXECUTE'
         ) AS ok`,
      ),
    ).resolves.toMatchObject({ rows: [{ ok: true }] });
    await expect(
      api.query(
        `SELECT has_function_privilege(
           current_user,
           'creator_agent_lock_consumer_access(uuid,uuid,uuid)',
           'EXECUTE'
         ) AS ok`,
      ),
    ).resolves.toMatchObject({ rows: [{ ok: true }] });
    await expect(
      api.query<{ live: boolean }>(
        `SELECT creator_agent_lock_live_worker($1, $2, $3, $4) AS live`,
        [ids.deploymentA, ids.creatorA, ids.workerA, 1],
      ),
    ).resolves.toMatchObject({ rows: [{ live: false }] });

    await owner.query(`UPDATE worker_leases SET state = 'REVOKED' WHERE id = $1`, [ids.leaseA]);
    await expect(
      owner.query(`UPDATE worker_leases SET state = 'ACTIVE' WHERE id = $1`, [ids.leaseA]),
    ).rejects.toMatchObject({ code: '55000' });
  });
});
