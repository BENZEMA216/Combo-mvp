import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toRuntimeDb } from '../../platform/infra/db.js';
import type { ConsumerConversationError } from './repo.js';
import { createConsumerConversation } from './repo.js';

const databaseUrl = process.env.DATABASE_URL;
const apiPassword = process.env.POSTGRES_AGENT_API_PASSWORD;
const enabled =
  process.env.CREATOR_AGENT_CONVERSATION_PG_TEST === '1' && Boolean(databaseUrl && apiPassword);
const pgDescribe = enabled ? describe.sequential : describe.skip;

function randomUuidV7(): string {
  const value = randomUUID();
  return `${value.slice(0, 14)}7${value.slice(15)}`;
}

function digest(character: string): string {
  return character.repeat(64);
}

function apiDatabaseUrl(): string {
  const url = new URL(databaseUrl ?? 'postgresql://invalid:invalid@127.0.0.1:1/invalid');
  url.username = 'combo_agent_api';
  url.password = apiPassword ?? 'invalid';
  return url.toString();
}

pgDescribe('Creator-hosted Consumer Conversation real PostgreSQL transaction', () => {
  const owner = new Client({ connectionString: databaseUrl });
  const api = new Pool({ connectionString: apiDatabaseUrl(), max: 20 });
  const runtimeDb = toRuntimeDb(api);
  const ids = {
    creatorId: '',
    consumerId: '',
    intruderId: '',
    snapshotId: randomUuidV7(),
    agentId: randomUuidV7(),
    versionId: randomUuidV7(),
    deploymentId: randomUuidV7(),
    workerId: randomUuidV7(),
    leaseId: randomUuidV7(),
    grantId: randomUuidV7(),
  };
  const publicSlug = `consumer-${ids.agentId.slice(0, 8)}`;

  beforeAll(async () => {
    await owner.connect();
    const users = await owner.query<{ id: string; account: string }>(
      `INSERT INTO users (account)
       VALUES ('creator-gggggggg'), ('creator-hhhhhhhh'), ('creator-iiiiiiii')
       RETURNING id, account`,
    );
    const creator = users.rows.find((row) => row.account === 'creator-gggggggg');
    const consumer = users.rows.find((row) => row.account === 'creator-hhhhhhhh');
    const intruder = users.rows.find((row) => row.account === 'creator-iiiiiiii');
    if (!creator || !consumer || !intruder) throw new Error('PG fixture user insert failed');
    ids.creatorId = creator.id;
    ids.consumerId = consumer.id;
    ids.intruderId = intruder.id;

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
       VALUES ($1, $2, $3, 'Consumer PG Agent')`,
      [ids.agentId, ids.creatorId, publicSlug],
    );
    await owner.query(
      `INSERT INTO agent_access_grants (
         id, agent_id, creator_id, consumer_subject_id
       ) VALUES ($1, $2, $3, $4)`,
      [ids.grantId, ids.agentId, ids.creatorId, ids.consumerId],
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
        ids.versionId,
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
      [ids.versionId, ids.creatorId],
    );
    await owner.query(
      `INSERT INTO deployments (
         id, agent_id, creator_id, environment, desired_version_id
       ) VALUES ($1, $2, $3, 'TEST', $4)`,
      [ids.deploymentId, ids.agentId, ids.creatorId, ids.versionId],
    );
    await owner.query(
      `INSERT INTO worker_installations (
         id, creator_id, installation_key_id, device_public_key,
         worker_version, protocol_versions, capabilities
       ) VALUES ($1, $2, $3, $4, '0.1.0', '[1]'::jsonb, '{}'::jsonb)`,
      [ids.workerId, ids.creatorId, `key-${ids.workerId}`, Buffer.alloc(65, 7)],
    );
    await owner.query(
      `UPDATE deployments
          SET desired_state = 'ONLINE', generation = 1,
              serving_version_id = $2, observed_state = 'ONLINE',
              observed_worker_id = $3, observed_generation = 1,
              lease_fence = 1, updated_at = now()
        WHERE id = $1`,
      [ids.deploymentId, ids.versionId, ids.workerId],
    );
    await owner.query(
      `INSERT INTO worker_leases (
         id, deployment_id, creator_id, worker_id, connection_id, fence, expires_at
       ) VALUES ($1, $2, $3, $4, $5, 1, now() + interval '10 minutes')`,
      [ids.leaseId, ids.deploymentId, ids.creatorId, ids.workerId, randomUuidV7()],
    );
  });

  afterAll(async () => {
    await Promise.all([owner.end(), api.end()]);
  });

  it('serializes 20 identical requests into one version-pinned row', async () => {
    const idempotencyKey = randomUuidV7();
    const input = {
      consumerId: ids.consumerId,
      publicSlug,
      idempotencyKey,
      environment: 'TEST' as const,
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => createConsumerConversation(runtimeDb, input)),
    );

    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(new Set(results.map((result) => result.conversation.conversationId)).size).toBe(1);
    expect(new Set(results.map((result) => result.conversation.agentVersionId))).toEqual(
      new Set([ids.versionId]),
    );
    const first = results[0];
    if (!first) throw new Error('Concurrent create returned no result');
    expect(
      new Date(first.conversation.expiresAt).valueOf() -
        new Date(first.conversation.createdAt).valueOf(),
    ).toBe(30 * 24 * 60 * 60 * 1_000);
    const persisted = await owner.query<{
      rows: string;
      agent_version_id: string;
      assigned_worker_id: string;
      version_digest: string;
    }>(
      `SELECT count(*) OVER ()::text AS rows,
              agent_version_id, assigned_worker_id, version_digest
         FROM agent_conversations
        WHERE consumer_subject_id = $1 AND idempotency_key = $2`,
      [ids.consumerId, idempotencyKey],
    );
    expect(persisted.rows).toEqual([
      {
        rows: '1',
        agent_version_id: ids.versionId,
        assigned_worker_id: ids.workerId,
        version_digest: digest('7'),
      },
    ]);
  });

  it('rejects the same key with a different canonical request without a second row', async () => {
    const idempotencyKey = randomUuidV7();
    const base = {
      consumerId: ids.consumerId,
      publicSlug,
      idempotencyKey,
      environment: 'TEST' as const,
    };
    const created = await createConsumerConversation(runtimeDb, base);

    await expect(
      createConsumerConversation(runtimeDb, {
        ...base,
        environment: 'PREVIEW',
      }),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    } satisfies Partial<ConsumerConversationError>);
    await expect(
      owner.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM agent_conversations
          WHERE consumer_subject_id = $1 AND idempotency_key = $2`,
        [ids.consumerId, idempotencyKey],
      ),
    ).resolves.toMatchObject({ rows: [{ count: '1' }] });
    expect(created.replayed).toBe(false);
  });

  it('applies grant revocation to new requests while preserving exact replay of an existing row', async () => {
    const idempotencyKey = randomUuidV7();
    const input = {
      consumerId: ids.consumerId,
      publicSlug,
      idempotencyKey,
      environment: 'TEST' as const,
    };
    const created = await createConsumerConversation(runtimeDb, input);

    await owner.query(
      `UPDATE agent_access_grants
          SET state = 'REVOKED', revoked_at = now()
        WHERE id = $1`,
      [ids.grantId],
    );
    const replay = await createConsumerConversation(runtimeDb, input);
    expect(replay).toEqual({ ...created, replayed: true });
    await expect(
      createConsumerConversation(runtimeDb, {
        ...input,
        idempotencyKey: randomUuidV7(),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<ConsumerConversationError>);
  });

  it('does not expose or create the Conversation for another Consumer', async () => {
    await expect(
      createConsumerConversation(runtimeDb, {
        consumerId: ids.intruderId,
        publicSlug,
        idempotencyKey: randomUuidV7(),
        environment: 'TEST',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<ConsumerConversationError>);

    const connection = await api.connect();
    try {
      await connection.query('BEGIN');
      await connection.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.intruderId]);
      await expect(connection.query(`SELECT id FROM agent_conversations`)).resolves.toMatchObject({
        rows: [],
      });
      await connection.query('COMMIT');
    } finally {
      connection.release();
    }
  });
});
