import { randomUUID } from 'node:crypto';
import { Client, Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../platform/config/env.js';
import { closeDb, pingCreatorAgentDb, toRuntimeDb } from '../../platform/infra/db.js';
import type { ConsumerConversationError } from './repo.js';
import {
  createConsumerConversation as createConsumerConversationWithAuthority,
  type CreateConsumerConversationInput,
  type CreateConsumerConversationOptions,
} from './repo.js';

const databaseUrl = process.env.DATABASE_URL;
const consumerPassword = process.env.POSTGRES_AGENT_CONSUMER_API_PASSWORD;
const brokerPassword = process.env.POSTGRES_AGENT_BROKER_PASSWORD;
const controlPlanePassword = process.env.POSTGRES_AGENT_API_PASSWORD;
const requested = process.env.CREATOR_AGENT_CONVERSATION_PG_TEST === '1';
if (requested && (!databaseUrl || !consumerPassword || !brokerPassword || !controlPlanePassword)) {
  throw new Error(
    'CREATOR_AGENT_CONVERSATION_PG_TEST requires DATABASE_URL, ' +
      'POSTGRES_AGENT_CONSUMER_API_PASSWORD, POSTGRES_AGENT_BROKER_PASSWORD ' +
      'and POSTGRES_AGENT_API_PASSWORD',
  );
}
const enabled = requested;
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
  url.username = 'combo_agent_consumer_api';
  url.password = consumerPassword ?? 'invalid';
  return url.toString();
}

function brokerDatabaseUrl(): string {
  const url = new URL(databaseUrl ?? 'postgresql://invalid:invalid@127.0.0.1:1/invalid');
  url.username = 'combo_agent_broker';
  url.password = brokerPassword ?? 'invalid';
  return url.toString();
}

function controlPlaneDatabaseUrl(): string {
  const url = new URL(databaseUrl ?? 'postgresql://invalid:invalid@127.0.0.1:1/invalid');
  url.username = 'combo_agent_api';
  url.password = controlPlanePassword ?? 'invalid';
  return url.toString();
}

function createConsumerConversation(
  db: Parameters<typeof createConsumerConversationWithAuthority>[0],
  input: CreateConsumerConversationInput,
  options: Omit<CreateConsumerConversationOptions, 'visibleTranscriptDigester'> = {},
) {
  return createConsumerConversationWithAuthority(db, input, {
    ...options,
    visibleTranscriptDigester: async ({ creatorId, agentVersionId }) => ({
      digest: `hmac-sha256:${digest('8')}`,
      keyId: `visible-${creatorId}`,
      keyVersion: 7n,
      keyRef: `kms://combo/visible/${creatorId}/${agentVersionId}@7`,
    }),
  });
}

pgDescribe('Creator-hosted Consumer Conversation real PostgreSQL transaction', () => {
  const owner = new Client({ connectionString: databaseUrl });
  const api = new Pool({ connectionString: apiDatabaseUrl(), max: 20 });
  const broker = new Pool({ connectionString: brokerDatabaseUrl(), max: 4 });
  const controlPlane = new Pool({ connectionString: controlPlaneDatabaseUrl(), max: 1 });
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
    challengeId: randomUuidV7(),
    workerSessionId: randomUuidV7(),
    connectionId: randomUuidV7(),
    leaseId: randomUuidV7(),
    grantId: randomUuidV7(),
  };
  const publicSlug = `consumer-${ids.agentId.slice(0, 8)}`;

  beforeAll(async () => {
    await owner.connect();
    const accountSuffixes = randomUUID()
      .replaceAll('-', '')
      .replaceAll('0', 'a')
      .replaceAll('1', 'b')
      .replaceAll('8', 'c')
      .replaceAll('9', 'd');
    const accounts = [
      `creator-${accountSuffixes.slice(0, 8)}`,
      `creator-${accountSuffixes.slice(8, 16)}`,
      `creator-${accountSuffixes.slice(16, 24)}`,
    ] as const;
    const users = await owner.query<{ id: string; account: string }>(
      `INSERT INTO users (account)
       VALUES ($1), ($2), ($3)
       RETURNING id, account`,
      [...accounts],
    );
    const creator = users.rows.find((row) => row.account === accounts[0]);
    const consumer = users.rows.find((row) => row.account === accounts[1]);
    const intruder = users.rows.find((row) => row.account === accounts[2]);
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
      `INSERT INTO worker_auth_challenges (
         id, creator_id, installation_id, deployment_id, deployment_generation,
         state, issued_at, expires_at, consumed_at
       ) VALUES (
         $1, $2, $3, $4, 1, 'CONSUMED',
         statement_timestamp(), statement_timestamp() + interval '10 minutes',
         statement_timestamp()
       )`,
      [ids.challengeId, ids.creatorId, ids.workerId, ids.deploymentId],
    );
    await owner.query(
      `INSERT INTO worker_gateway_sessions (
         id, creator_id, installation_id, challenge_id, connection_id,
         registration_digest, state, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', now() + interval '10 minutes')`,
      [
        ids.workerSessionId,
        ids.creatorId,
        ids.workerId,
        ids.challengeId,
        ids.connectionId,
        digest('6'),
      ],
    );
    await owner.query(
      `INSERT INTO worker_leases (
         id, deployment_id, creator_id, worker_id, connection_id, fence, expires_at
       ) VALUES ($1, $2, $3, $4, $5, 1, now() + interval '10 minutes')`,
      [ids.leaseId, ids.deploymentId, ids.creatorId, ids.workerId, ids.connectionId],
    );
  });

  afterAll(async () => {
    await Promise.all([owner.end(), api.end(), broker.end(), controlPlane.end(), closeDb()]);
  });

  async function controlPlaneTransaction<T>(
    operation: (connection: PoolClient) => Promise<T>,
  ): Promise<T> {
    const connection = await controlPlane.connect();
    try {
      await connection.query('BEGIN');
      await connection.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await connection.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumerId]);
      const result = await operation(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async function brokerTransaction<T>(
    consumerId: string,
    operation: (connection: PoolClient) => Promise<T>,
  ): Promise<T> {
    const connection = await broker.connect();
    try {
      await connection.query('BEGIN');
      await connection.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creatorId]);
      await connection.query(`SELECT set_config('app.consumer_id', $1, true)`, [consumerId]);
      const result = await operation(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async function markOpenCommandSent(conversationId: string): Promise<{
    commandId: string;
    leaseId: string;
    fence: string;
  }> {
    return brokerTransaction(ids.consumerId, async (connection) => {
      const updated = await connection.query<{
        command_id: string;
        assignment_lease_id: string;
        assignment_fence: string;
      }>(
        `UPDATE broker_outbox
            SET state = 'SENT', attempt_count = attempt_count + 1
          WHERE conversation_id = $1 AND command_type = 'conversation.open' AND state = 'PENDING'
          RETURNING command_id, assignment_lease_id, assignment_fence::text`,
        [conversationId],
      );
      const row = updated.rows[0];
      if (!row) throw new Error('conversation.open command was not PENDING');
      return {
        commandId: row.command_id,
        leaseId: row.assignment_lease_id,
        fence: row.assignment_fence,
      };
    });
  }

  async function findOpenCommand(conversationId: string): Promise<{
    commandId: string;
    leaseId: string;
    fence: string;
  }> {
    const result = await owner.query<{
      command_id: string;
      assignment_lease_id: string;
      assignment_fence: string;
    }>(
      `SELECT command_id, assignment_lease_id, assignment_fence::text
         FROM broker_outbox
        WHERE conversation_id = $1 AND command_type = 'conversation.open'`,
      [conversationId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('conversation.open command is missing');
    return {
      commandId: row.command_id,
      leaseId: row.assignment_lease_id,
      fence: row.assignment_fence,
    };
  }

  async function commitReady(input: {
    sourceEventId: string;
    conversationId: string;
    workerId?: string;
    leaseId: string;
    fence: string;
    sandboxInstanceId: string;
  }): Promise<{
    outcome: string;
    conversation_state: string | null;
    open_command_id: string | null;
  }> {
    const runtimeThreadId = `thread-${input.sandboxInstanceId}`;
    const readyEvidenceDigest = `sha256:${digest('9')}`;
    const fact = await owner.query<{ fact_digest: string }>(
      `SELECT creator_agent_conversation_ready_fact_digest(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
       ) AS fact_digest`,
      [
        input.sourceEventId,
        input.conversationId,
        ids.deploymentId,
        ids.versionId,
        digest('7'),
        digest('1'),
        input.workerId ?? ids.workerId,
        ids.workerSessionId,
        input.leaseId,
        input.fence,
        input.sandboxInstanceId,
        runtimeThreadId,
        readyEvidenceDigest,
      ],
    );
    const factDigest = fact.rows[0]?.fact_digest;
    if (!factDigest) throw new Error('conversation.ready fact digest is missing');
    return brokerTransaction(ids.consumerId, async (connection) => {
      const result = await connection.query<{
        outcome: string;
        conversation_state: string | null;
        open_command_id: string | null;
      }>(
        `SELECT outcome, conversation_state, open_command_id
           FROM creator_agent_commit_conversation_ready_fact(
             $1, $2, $3, $4, $5, $6, $7, $8,
             $9, $10, $11, $12, $13, $14, $15, $16
           )`,
        [
          input.sourceEventId,
          factDigest,
          input.conversationId,
          ids.creatorId,
          ids.consumerId,
          ids.deploymentId,
          ids.versionId,
          digest('7'),
          digest('1'),
          input.workerId ?? ids.workerId,
          ids.workerSessionId,
          input.leaseId,
          input.fence,
          input.sandboxInstanceId,
          runtimeThreadId,
          readyEvidenceDigest,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('conversation.ready authority returned no outcome');
      return row;
    });
  }

  it('logs in as the exact non-bypass Consumer role with only create-open-v2 authority', async () => {
    await expect(
      pingCreatorAgentDb({
        CREATOR_AGENT_PUBLIC_ENABLED: true,
        CREATOR_AGENT_DATABASE_URL: apiDatabaseUrl(),
      } as Env),
    ).resolves.toBe(true);

    const connection = await api.connect();
    try {
      const identity = await connection.query<{
        current_user: string;
        session_user: string;
        superuser: boolean;
        bypass_rls: boolean;
        database_connect: boolean;
        database_create: boolean;
        database_temporary: boolean;
      }>(
        `SELECT current_user, session_user, role.rolsuper AS superuser,
                role.rolbypassrls AS bypass_rls,
                has_database_privilege(current_user, current_database(), 'CONNECT')
                  AS database_connect,
                has_database_privilege(current_user, current_database(), 'CREATE')
                  AS database_create,
                has_database_privilege(current_user, current_database(), 'TEMPORARY')
                  AS database_temporary
           FROM pg_roles AS role
          WHERE role.rolname = current_user`,
      );
      expect(identity.rows[0]).toEqual({
        current_user: 'combo_agent_consumer_api',
        session_user: 'combo_agent_consumer_api',
        superuser: false,
        bypass_rls: false,
        database_connect: true,
        database_create: false,
        database_temporary: true,
      });
      for (const table of [
        'agents',
        'agent_access_grants',
        'agent_versions',
        'agent_version_controls',
        'deployments',
        'worker_installations',
        'worker_leases',
        'agent_conversations',
        'broker_outbox',
        'conversation_ready_receipts',
        'conversation_ready_fact_receipts',
      ]) {
        await expect(
          connection.query<{ allowed: boolean }>(
            `SELECT has_any_column_privilege(current_user, $1, 'UPDATE') AS allowed`,
            [table],
          ),
          `${table} UPDATE`,
        ).resolves.toMatchObject({ rows: [{ allowed: false }] });
      }
      await expect(
        connection.query(
          `SELECT has_table_privilege(current_user, 'agent_conversations', 'INSERT') AS allowed,
                  has_table_privilege(current_user, 'broker_outbox', 'INSERT') AS outbox_allowed`,
        ),
      ).resolves.toMatchObject({ rows: [{ allowed: false, outbox_allowed: false }] });
    } finally {
      connection.release();
    }

    const bypassConversationId = randomUuidV7();
    await expect(
      controlPlaneTransaction((controlConnection) =>
        controlConnection.query(
          `INSERT INTO agent_conversations (
             id, agent_id, deployment_id, agent_version_id, creator_id,
             consumer_subject_id, idempotency_key, request_digest, version_digest,
             state, assigned_worker_id, expires_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPENING', $10,
             now() + interval '1 hour'
           )`,
          [
            bypassConversationId,
            ids.agentId,
            ids.deploymentId,
            ids.versionId,
            ids.creatorId,
            ids.consumerId,
            randomUuidV7(),
            digest('9'),
            digest('7'),
            ids.workerId,
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      owner.query(`SELECT count(*)::text AS count FROM agent_conversations WHERE id = $1`, [
        bypassConversationId,
      ]),
    ).resolves.toMatchObject({ rows: [{ count: '0' }] });
  });

  it('fails readiness closed for v0, either missing approved definer, or any extra definer', async () => {
    const env = {
      CREATOR_AGENT_PUBLIC_ENABLED: true,
      CREATOR_AGENT_DATABASE_URL: apiDatabaseUrl(),
    } as Env;
    const v0Signature = `public.creator_agent_create_opening_conversation(
      uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid,bigint,integer
    )`;
    const v2Signature = `public.creator_agent_create_opening_conversation_v2(
      uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid,bigint,integer,text,text,bigint,text
    )`;
    const acceptSignature = `public.creator_agent_accept_consumer_message_v1(
      uuid,uuid,uuid,uuid,text,uuid,text,text,text,text,bytea,bytea,bytea,text,text,integer
    )`;

    await expect(pingCreatorAgentDb(env)).resolves.toBe(true);

    await owner.query(`GRANT EXECUTE ON FUNCTION ${v0Signature} TO combo_agent_consumer_api`);
    try {
      await expect(pingCreatorAgentDb(env)).resolves.toBe(false);
    } finally {
      await owner.query(`REVOKE EXECUTE ON FUNCTION ${v0Signature} FROM combo_agent_consumer_api`);
    }
    await expect(pingCreatorAgentDb(env)).resolves.toBe(true);

    await owner.query(`
      CREATE FUNCTION public.creator_agent_consumer_readiness_probe()
      RETURNS integer
      SECURITY DEFINER
      SET search_path = pg_catalog
      LANGUAGE sql
      AS 'SELECT 1';
      REVOKE ALL ON FUNCTION public.creator_agent_consumer_readiness_probe() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.creator_agent_consumer_readiness_probe()
        TO combo_agent_consumer_api;
    `);
    try {
      await expect(pingCreatorAgentDb(env)).resolves.toBe(false);
    } finally {
      await owner.query(`DROP FUNCTION public.creator_agent_consumer_readiness_probe()`);
    }
    await expect(pingCreatorAgentDb(env)).resolves.toBe(true);

    await owner.query(`REVOKE EXECUTE ON FUNCTION ${v2Signature} FROM combo_agent_consumer_api`);
    try {
      await expect(pingCreatorAgentDb(env)).resolves.toBe(false);
    } finally {
      await owner.query(`GRANT EXECUTE ON FUNCTION ${v2Signature} TO combo_agent_consumer_api`);
    }
    await expect(pingCreatorAgentDb(env)).resolves.toBe(true);

    await owner.query(`GRANT EXECUTE ON FUNCTION ${acceptSignature} TO combo_agent_consumer_api`);
    try {
      await expect(pingCreatorAgentDb(env)).resolves.toBe(false);
    } finally {
      await owner.query(
        `REVOKE EXECUTE ON FUNCTION ${acceptSignature} FROM combo_agent_consumer_api`,
      );
    }
    await expect(pingCreatorAgentDb(env)).resolves.toBe(true);
  });

  it('fails readiness closed when the Consumer role gains one unapproved column', async () => {
    await owner.query(`GRANT SELECT (name) ON agents TO combo_agent_consumer_api`);
    try {
      await expect(
        pingCreatorAgentDb({
          CREATOR_AGENT_PUBLIC_ENABLED: true,
          CREATOR_AGENT_DATABASE_URL: apiDatabaseUrl(),
        } as Env),
      ).resolves.toBe(false);
    } finally {
      await owner.query(`REVOKE SELECT (name) ON agents FROM combo_agent_consumer_api`);
    }
    await expect(
      pingCreatorAgentDb({
        CREATOR_AGENT_PUBLIC_ENABLED: true,
        CREATOR_AGENT_DATABASE_URL: apiDatabaseUrl(),
      } as Env),
    ).resolves.toBe(true);
  });

  it('fails readiness closed when either side of the Consumer role graph gains membership', async () => {
    const env = {
      CREATOR_AGENT_PUBLIC_ENABLED: true,
      CREATOR_AGENT_DATABASE_URL: apiDatabaseUrl(),
    } as Env;

    await owner.query(`GRANT combo_agent_consumer_api TO combo_runtime`);
    try {
      await expect(pingCreatorAgentDb(env)).resolves.toBe(false);
      await expect(
        owner.query(
          `SELECT pg_has_role(
                    'combo_runtime',
                    'combo_agent_consumer_api',
                    'MEMBER'
                  ) AS member`,
        ),
      ).resolves.toMatchObject({ rows: [{ member: true }] });
    } finally {
      await owner.query(`REVOKE combo_agent_consumer_api FROM combo_runtime`);
    }
    await expect(pingCreatorAgentDb(env)).resolves.toBe(true);

    await owner.query(`GRANT combo_runtime TO combo_agent_consumer_api`);
    try {
      await expect(pingCreatorAgentDb(env)).resolves.toBe(false);
    } finally {
      await owner.query(`REVOKE combo_runtime FROM combo_agent_consumer_api`);
    }
    await expect(pingCreatorAgentDb(env)).resolves.toBe(true);
  });

  it('freezes current-database CONNECT/CREATE/TEMPORARY to the exact allowed set', async () => {
    const env = {
      CREATOR_AGENT_PUBLIC_ENABLED: true,
      CREATOR_AGENT_DATABASE_URL: apiDatabaseUrl(),
    } as Env;
    const schema = `consumer_authority_drift_${randomUUID().replaceAll('-', '')}`;

    await owner.query(`
      DO $grant_create$
      BEGIN
        EXECUTE format(
          'GRANT CREATE ON DATABASE %I TO combo_agent_consumer_api',
          current_database()
        );
      END
      $grant_create$;
    `);
    try {
      await expect(pingCreatorAgentDb(env)).resolves.toBe(false);
      await expect(api.query(`CREATE SCHEMA ${schema}`)).resolves.toMatchObject({ rowCount: null });
    } finally {
      await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await owner.query(`
        DO $revoke_create$
        BEGIN
          EXECUTE format(
            'REVOKE CREATE ON DATABASE %I FROM combo_agent_consumer_api',
            current_database()
          );
        END
        $revoke_create$;
      `);
    }
    await expect(pingCreatorAgentDb(env)).resolves.toBe(true);

    await owner.query(`
      DO $revoke_temp$
      BEGIN
        EXECUTE format(
          'REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC',
          current_database()
        );
      END
      $revoke_temp$;
    `);
    try {
      await expect(pingCreatorAgentDb(env)).resolves.toBe(false);
    } finally {
      await owner.query(`
        DO $restore_temp$
        BEGIN
          EXECUTE format(
            'GRANT TEMPORARY ON DATABASE %I TO PUBLIC',
            current_database()
          );
        END
        $restore_temp$;
      `);
    }
    await expect(pingCreatorAgentDb(env)).resolves.toBe(true);
  });

  it('fails readiness closed for any public sequence capability and proves UPDATE is writable', async () => {
    const env = {
      CREATOR_AGENT_PUBLIC_ENABLED: true,
      CREATOR_AGENT_DATABASE_URL: apiDatabaseUrl(),
    } as Env;
    const before = await owner.query<{ last_value: string; is_called: boolean }>(
      `SELECT last_value::text, is_called FROM public.agent_invocation_events_id_seq`,
    );
    const sequenceState = before.rows[0];
    if (!sequenceState) throw new Error('sequence state fixture is missing');

    await owner.query(
      `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public
         TO combo_agent_consumer_api`,
    );
    try {
      await expect(pingCreatorAgentDb(env)).resolves.toBe(false);
      await expect(
        api.query<{ value: string }>(
          `SELECT setval('public.agent_invocation_events_id_seq', 4242, false)::text AS value`,
        ),
      ).resolves.toMatchObject({ rows: [{ value: '4242' }] });
    } finally {
      await owner.query(
        `SELECT setval(
                  'public.agent_invocation_events_id_seq',
                  $1::bigint,
                  $2::boolean
                )`,
        [sequenceState.last_value, sequenceState.is_called],
      );
      await owner.query(
        `REVOKE USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public
           FROM combo_agent_consumer_api`,
      );
    }
    await expect(pingCreatorAgentDb(env)).resolves.toBe(true);
  });

  it('rejects a reachable Creator control-plane URL as the public readiness identity', async () => {
    await closeDb();
    await expect(
      pingCreatorAgentDb({
        CREATOR_AGENT_PUBLIC_ENABLED: true,
        CREATOR_AGENT_DATABASE_URL: controlPlaneDatabaseUrl(),
      } as Env),
    ).resolves.toBe(false);
    await closeDb();
    await expect(
      pingCreatorAgentDb({
        CREATOR_AGENT_PUBLIC_ENABLED: true,
        CREATOR_AGENT_DATABASE_URL: apiDatabaseUrl(),
      } as Env),
    ).resolves.toBe(true);
  });

  it('serializes 20 identical requests into one version-pinned row', async () => {
    const idempotencyKey = randomUUID();
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
    expect(new Set(results.map((result) => result.conversation.state))).toEqual(
      new Set(['OPENING']),
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
      state: string;
      commands: string;
      command_type: string;
      assignment_lease_id: string;
      assignment_fence: string;
      payload_contract_version: number;
      visible_transcript_digest: string;
      visible_transcript_key_id: string;
      visible_transcript_key_version: string;
      visible_transcript_key_ref: string;
      original_worker_session_id: string;
      original_connection_id: string;
    }>(
      `SELECT count(*) OVER ()::text AS rows,
              conversation.agent_version_id, conversation.assigned_worker_id,
              conversation.version_digest, conversation.state,
              count(command.command_id) OVER ()::text AS commands,
              command.command_type, command.assignment_lease_id,
              command.assignment_fence::text, command.payload_contract_version,
              command.visible_transcript_digest, command.visible_transcript_key_id,
              command.visible_transcript_key_version::text,
              command.visible_transcript_key_ref, command.original_worker_session_id,
              command.original_connection_id
         FROM agent_conversations AS conversation
         JOIN broker_outbox AS command
           ON command.conversation_id = conversation.id
          AND command.creator_id = conversation.creator_id
          AND command.consumer_subject_id = conversation.consumer_subject_id
        WHERE conversation.consumer_subject_id = $1 AND conversation.idempotency_key = $2`,
      [ids.consumerId, idempotencyKey],
    );
    expect(persisted.rows).toEqual([
      {
        rows: '1',
        agent_version_id: ids.versionId,
        assigned_worker_id: ids.workerId,
        version_digest: digest('7'),
        state: 'OPENING',
        commands: '1',
        command_type: 'conversation.open',
        assignment_lease_id: ids.leaseId,
        assignment_fence: '1',
        payload_contract_version: 1,
        visible_transcript_digest: `hmac-sha256:${digest('8')}`,
        visible_transcript_key_id: `visible-${ids.creatorId}`,
        visible_transcript_key_version: '7',
        visible_transcript_key_ref: `kms://combo/visible/${ids.creatorId}/${ids.versionId}@7`,
        original_worker_session_id: ids.workerSessionId,
        original_connection_id: ids.connectionId,
      },
    ]);
  });

  it('rejects the same key with a different canonical request without a second row', async () => {
    const idempotencyKey = randomUUID();
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

  it('requires a SENT exact original ready fact and makes exact replay immutable', async () => {
    const created = await createConsumerConversation(runtimeDb, {
      consumerId: ids.consumerId,
      publicSlug,
      idempotencyKey: randomUUID(),
      environment: 'TEST',
    });
    expect(created.conversation.state).toBe('OPENING');
    const sandboxInstanceId = randomUuidV7();
    const pendingCommand = await findOpenCommand(created.conversation.conversationId);

    const beforeSent = await commitReady({
      sourceEventId: pendingCommand.commandId,
      conversationId: created.conversation.conversationId,
      leaseId: pendingCommand.leaseId,
      fence: pendingCommand.fence,
      sandboxInstanceId,
    });
    expect(beforeSent).toEqual({
      outcome: 'REJECTED',
      conversation_state: null,
      open_command_id: null,
    });

    const command = await markOpenCommandSent(created.conversation.conversationId);
    const concurrent = await Promise.all([
      commitReady({
        sourceEventId: command.commandId,
        conversationId: created.conversation.conversationId,
        leaseId: command.leaseId,
        fence: command.fence,
        sandboxInstanceId,
      }),
      commitReady({
        sourceEventId: command.commandId,
        conversationId: created.conversation.conversationId,
        leaseId: command.leaseId,
        fence: command.fence,
        sandboxInstanceId,
      }),
    ]);
    expect(concurrent.sort((left, right) => left.outcome.localeCompare(right.outcome))).toEqual([
      {
        outcome: 'APPLIED',
        conversation_state: 'IDLE',
        open_command_id: command.commandId,
      },
      {
        outcome: 'REPLAY',
        conversation_state: 'IDLE',
        open_command_id: command.commandId,
      },
    ]);

    await expect(
      commitReady({
        sourceEventId: command.commandId,
        conversationId: created.conversation.conversationId,
        leaseId: command.leaseId,
        fence: command.fence,
        sandboxInstanceId,
      }),
    ).resolves.toEqual({
      outcome: 'REPLAY',
      conversation_state: 'IDLE',
      open_command_id: command.commandId,
    });

    await expect(
      commitReady({
        sourceEventId: command.commandId,
        conversationId: created.conversation.conversationId,
        leaseId: command.leaseId,
        fence: command.fence,
        sandboxInstanceId: randomUuidV7(),
      }),
    ).resolves.toEqual({
      outcome: 'REJECTED',
      conversation_state: null,
      open_command_id: null,
    });
    await expect(
      commitReady({
        sourceEventId: randomUuidV7(),
        conversationId: created.conversation.conversationId,
        leaseId: command.leaseId,
        fence: command.fence,
        sandboxInstanceId,
      }),
    ).resolves.toEqual({
      outcome: 'REJECTED',
      conversation_state: null,
      open_command_id: null,
    });

    await expect(
      owner.query<{
        state: string;
        command_state: string;
        receipts: string;
      }>(
        `SELECT conversation.state, command.state AS command_state,
                count(receipt.source_event_id)::text AS receipts
           FROM agent_conversations AS conversation
           JOIN broker_outbox AS command ON command.conversation_id = conversation.id
           LEFT JOIN conversation_ready_fact_receipts AS receipt
             ON receipt.conversation_id = conversation.id
          WHERE conversation.id = $1
          GROUP BY conversation.state, command.state`,
        [created.conversation.conversationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: 'IDLE', command_state: 'ACKED', receipts: '1' }],
    });
  });

  it('rejects stale ready authority and blocks direct Broker OPENING to IDLE writes', async () => {
    const created = await createConsumerConversation(runtimeDb, {
      consumerId: ids.consumerId,
      publicSlug,
      idempotencyKey: randomUUID(),
      environment: 'TEST',
    });
    const command = await markOpenCommandSent(created.conversation.conversationId);

    await expect(
      commitReady({
        sourceEventId: command.commandId,
        conversationId: created.conversation.conversationId,
        leaseId: command.leaseId,
        fence: '2',
        sandboxInstanceId: randomUuidV7(),
      }),
    ).resolves.toEqual({
      outcome: 'REJECTED',
      conversation_state: null,
      open_command_id: null,
    });

    await expect(
      brokerTransaction(ids.consumerId, (connection) =>
        connection.query(
          `UPDATE broker_outbox
              SET state = 'ACKED', acked_at = now()
            WHERE command_id = $1`,
          [command.commandId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      brokerTransaction(ids.consumerId, (connection) =>
        connection.query(`UPDATE agent_conversations SET state = 'IDLE' WHERE id = $1`, [
          created.conversation.conversationId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      owner.query(
        `SELECT state,
                (SELECT count(*)::text FROM conversation_ready_fact_receipts
                  WHERE conversation_id = $1) AS receipts,
                (SELECT state FROM broker_outbox
                  WHERE command_id = $2) AS command_state
           FROM agent_conversations WHERE id = $1`,
        [created.conversation.conversationId, command.commandId],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: 'OPENING', receipts: '0', command_state: 'SENT' }],
    });
  });

  it('rolls back the Conversation when durable conversation.open append fails', async () => {
    const idempotencyKey = randomUUID();
    await owner.query(`
      CREATE OR REPLACE FUNCTION reject_test_conversation_open()
      RETURNS trigger AS $test$
      BEGIN
        IF NEW.command_type = 'conversation.open'
           AND NEW.consumer_subject_id = '${ids.consumerId}'::uuid THEN
          RAISE EXCEPTION 'injected conversation.open failure' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $test$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_test_conversation_open
      BEFORE INSERT ON broker_outbox
      FOR EACH ROW EXECUTE FUNCTION reject_test_conversation_open();
    `);
    try {
      await expect(
        createConsumerConversation(runtimeDb, {
          consumerId: ids.consumerId,
          publicSlug,
          idempotencyKey,
          environment: 'TEST',
        }),
      ).rejects.toThrow(/conversation\.open failure/u);
      await expect(
        owner.query(
          `SELECT count(*)::text AS conversations,
                  (SELECT count(*)::text
                     FROM broker_outbox AS command
                     JOIN agent_conversations AS conversation
                       ON conversation.id = command.conversation_id
                    WHERE conversation.consumer_subject_id = $1
                      AND conversation.idempotency_key = $2) AS commands
             FROM agent_conversations
            WHERE consumer_subject_id = $1 AND idempotency_key = $2`,
          [ids.consumerId, idempotencyKey],
        ),
      ).resolves.toMatchObject({ rows: [{ conversations: '0', commands: '0' }] });
    } finally {
      await owner.query(`DROP TRIGGER reject_test_conversation_open ON broker_outbox`);
      await owner.query(`DROP FUNCTION reject_test_conversation_open()`);
    }
  });

  it('applies grant revocation to new requests while preserving exact replay of an existing row', async () => {
    const idempotencyKey = randomUUID();
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
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<ConsumerConversationError>);
  });

  it('does not expose or create the Conversation for another Consumer', async () => {
    await expect(
      createConsumerConversation(runtimeDb, {
        consumerId: ids.intruderId,
        publicSlug,
        idempotencyKey: randomUUID(),
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
