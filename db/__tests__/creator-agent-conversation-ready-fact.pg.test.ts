import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.CREATOR_AGENT_READY_FACT_PG_TEST === '1' && Boolean(databaseUrl);
const pgDescribe = enabled ? describe.sequential : describe.skip;
const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

type ReadyFact = Readonly<{
  protocol: 'combo.worker-conversation-ready-fact/1';
  schemaVersion: 1;
  type: 'conversation.ready';
  sourceEventId: string;
  conversationId: string;
  openCommandId: string;
  deploymentId: string;
  agentVersionId: string;
  agentVersionDigest: string;
  snapshotDigest: string;
  installationId: string;
  workerSessionId: string;
  leaseId: string;
  fence: string;
  sandboxInstanceId: string;
  runtimeThreadId: string;
  readyEvidenceDigest: string;
}>;

type ReadyRow = Readonly<{
  outcome: 'APPLIED' | 'REPLAY' | 'REJECTED';
  conversation_state: string | null;
  open_command_id: string | null;
}>;

function randomUuidV7(): string {
  const value = randomUUID();
  return `${value.slice(0, 14)}7${value.slice(15)}`;
}

function digest(marker: string): string {
  return marker.repeat(64);
}

function creatorAccount(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return `creator-${[...randomBytes(8)].map((value) => alphabet[value % 32]).join('')}`;
}

function databaseConnectionString(name: string): string {
  const url = new URL(databaseUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function applyMigration(client: Client, filename: string): Promise<void> {
  const sql = readFileSync(join(migrationsDirectory, filename), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(`INSERT INTO schema_migrations(filename) VALUES ($1)`, [filename]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function readyFactDigest(fact: ReadyFact): string {
  return createHash('sha256').update(canonicalJson(fact)).digest('hex');
}

pgDescribe('0017 conversation.ready durable fact real PostgreSQL authority', () => {
  const admin = new Client({ connectionString: databaseUrl });
  const databaseName = `combo_ready_fact_${randomUUID().replaceAll('-', '')}`;
  let target: Client;
  let targetUrl: string;

  const ids = {
    creator: randomUuidV7(),
    consumer: randomUuidV7(),
    snapshot: randomUuidV7(),
    agent: randomUuidV7(),
    version: randomUuidV7(),
    deployment: randomUuidV7(),
    installation: randomUuidV7(),
    originalChallenge: randomUuidV7(),
    originalSession: randomUuidV7(),
    originalConnection: randomUuidV7(),
    originalLease: randomUuidV7(),
    currentChallenge: randomUuidV7(),
    currentSession: randomUuidV7(),
    currentConnection: randomUuidV7(),
    currentLease: randomUuidV7(),
    primaryConversation: randomUuidV7(),
    primaryOpen: randomUuidV7(),
    concurrentConversation: randomUuidV7(),
    concurrentOpen: randomUuidV7(),
    securityRaceConversation: randomUuidV7(),
    securityRaceOpen: randomUuidV7(),
    negativeConversation: randomUuidV7(),
    negativeOpen: randomUuidV7(),
    legacyConversation: randomUuidV7(),
    legacyOpen: randomUuidV7(),
    legacySource: randomUuidV7(),
  };

  function factFor(conversationId: string, openCommandId: string, marker: string): ReadyFact {
    return Object.freeze({
      protocol: 'combo.worker-conversation-ready-fact/1',
      schemaVersion: 1,
      type: 'conversation.ready',
      sourceEventId: openCommandId,
      conversationId,
      openCommandId,
      deploymentId: ids.deployment,
      agentVersionId: ids.version,
      agentVersionDigest: digest('7'),
      snapshotDigest: digest('1'),
      installationId: ids.installation,
      workerSessionId: ids.originalSession,
      leaseId: ids.originalLease,
      fence: '1',
      sandboxInstanceId: randomUuidV7(),
      runtimeThreadId: `thread-ready-${marker}`,
      readyEvidenceDigest: `sha256:${marker.repeat(64)}`,
    });
  }

  const primaryFact = factFor(ids.primaryConversation, ids.primaryOpen, 'a');
  const concurrentFact = factFor(ids.concurrentConversation, ids.concurrentOpen, 'b');
  const securityRaceFact = factFor(ids.securityRaceConversation, ids.securityRaceOpen, 'e');
  const negativeFact = factFor(ids.negativeConversation, ids.negativeOpen, 'c');
  const legacyFact = factFor(ids.legacyConversation, ids.legacyOpen, 'd');

  async function seedConversation(
    conversationId: string,
    openCommandId: string,
    state: 'OPENING' | 'IDLE',
    commandState: 'SENT' | 'ACKED',
  ): Promise<void> {
    await target.query(
      `INSERT INTO agent_conversations (
         id, agent_id, deployment_id, agent_version_id, creator_id,
         consumer_subject_id, idempotency_key, request_digest, version_digest,
         state, assigned_worker_id, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         clock_timestamp() + interval '1 day'
       )`,
      [
        conversationId,
        ids.agent,
        ids.deployment,
        ids.version,
        ids.creator,
        ids.consumer,
        randomUuidV7(),
        digest('9'),
        digest('7'),
        state,
        ids.installation,
      ],
    );
    await target.query(
      `INSERT INTO broker_outbox (
         command_id, creator_id, target_worker_id, consumer_subject_id,
         conversation_id, deployment_id, assignment_lease_id, assignment_fence,
         command_type, dedupe_key, state, next_attempt_at, expires_at, acked_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, 1,
         'conversation.open', $8, $9, clock_timestamp(),
         clock_timestamp() + interval '1 day',
         CASE WHEN $9::text = 'ACKED' THEN clock_timestamp() ELSE NULL END
       )`,
      [
        openCommandId,
        ids.creator,
        ids.installation,
        ids.consumer,
        conversationId,
        ids.deployment,
        ids.originalLease,
        `ready-pg-${openCommandId}`,
        commandState,
      ],
    );
  }

  async function selectReady(
    client: Client,
    fact: ReadyFact,
    factDigest = readyFactDigest(fact),
  ): Promise<ReadyRow> {
    const result = await client.query<ReadyRow>(
      `SELECT outcome, conversation_state, open_command_id::text
         FROM creator_agent_commit_conversation_ready_fact(
           $1::uuid, $2::text, $3::uuid, $4::uuid,
           $5::uuid, $6::uuid, $7::uuid, $8::text,
           $9::text, $10::uuid, $11::uuid, $12::uuid,
           $13::bigint, $14::uuid, $15::text, $16::text
         )`,
      [
        fact.sourceEventId,
        factDigest,
        fact.conversationId,
        ids.creator,
        ids.consumer,
        fact.deploymentId,
        fact.agentVersionId,
        fact.agentVersionDigest,
        fact.snapshotDigest,
        fact.installationId,
        fact.workerSessionId,
        fact.leaseId,
        fact.fence,
        fact.sandboxInstanceId,
        fact.runtimeThreadId,
        fact.readyEvidenceDigest,
      ],
    );
    const row = result.rows[0];
    if (result.rows.length !== 1 || row === undefined) {
      throw new Error('ready authority did not return exactly one row');
    }
    return row;
  }

  async function callReady(
    client: Client,
    fact: ReadyFact,
    factDigest = readyFactDigest(fact),
  ): Promise<ReadyRow> {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE combo_agent_broker');
      await client.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creator]);
      await client.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumer]);
      const row = await selectReady(client, fact, factDigest);
      await client.query('COMMIT');
      return row;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  async function callReadyInsideOwnerTransaction(
    fact: ReadyFact,
    factDigest = readyFactDigest(fact),
  ): Promise<ReadyRow> {
    await target.query('SET LOCAL ROLE combo_agent_broker');
    await target.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creator]);
    await target.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumer]);
    const row = await selectReady(target, fact, factDigest);
    await target.query('RESET ROLE');
    return row;
  }

  async function negativeState(): Promise<{
    receipts: string;
    conversation_state: string;
    command_state: string;
  }> {
    const result = await target.query<{
      receipts: string;
      conversation_state: string;
      command_state: string;
    }>(
      `SELECT
         (SELECT count(*)::text
            FROM conversation_ready_fact_receipts
           WHERE conversation_id = $1) AS receipts,
         conversation.state AS conversation_state,
         command.state AS command_state
       FROM agent_conversations AS conversation
       JOIN broker_outbox AS command ON command.command_id = $2
      WHERE conversation.id = $1`,
      [ids.negativeConversation, ids.negativeOpen],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('negative fixture disappeared');
    return row;
  }

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    targetUrl = databaseConnectionString(databaseName);
    target = new Client({ connectionString: targetUrl });
    await target.connect();
    await target.query(`
      CREATE TABLE schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const migrations = readdirSync(migrationsDirectory)
      .filter((filename) => /^\d{4}_.+\.sql$/u.test(filename))
      .sort();
    expect(migrations.at(-1)).toBe('0017_creator_agent_conversation_ready_fact.sql');
    for (const filename of migrations.filter((filename) => filename < '0017_')) {
      await applyMigration(target, filename);
    }

    await target.query(
      `INSERT INTO users (id, account)
       VALUES ($1, $3), ($2, $4)`,
      [ids.creator, ids.consumer, creatorAccount(), creatorAccount()],
    );
    await target.query(
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
        `ready/${ids.snapshot}.archive.enc`,
        `ready/${ids.snapshot}.manifest.enc`,
        `kms://${ids.snapshot}`,
      ],
    );
    await target.query(
      `INSERT INTO agents (id, creator_id, public_slug, name)
       VALUES ($1, $2, $3, 'Ready Fact PG Agent')`,
      [ids.agent, ids.creator, `ready-${ids.agent.slice(0, 8)}`],
    );
    await target.query(
      `INSERT INTO agent_versions (
         id, agent_id, creator_id, ordinal, schema_version, version_digest, snapshot_id,
         behavior_contract, behavior_contract_digest, runtime_policy, runtime_policy_digest,
         io_contract, io_contract_digest, model_policy, model_policy_digest,
         codex_runtime_version, codex_runtime_artifact_digest, codex_protocol_schema_digest
       ) VALUES (
         $1, $2, $3, 1, 1, $4, $5,
         '{}'::jsonb, $6, '{}'::jsonb, $7, '{}'::jsonb, $8, '{}'::jsonb, $9,
         '0.147.0-ready-fact', $10, $11
       )`,
      [
        ids.version,
        ids.agent,
        ids.creator,
        digest('7'),
        ids.snapshot,
        digest('4'),
        digest('5'),
        digest('6'),
        digest('8'),
        `sha256:${digest('a')}`,
        `sha256:${digest('b')}`,
      ],
    );
    await target.query(
      `INSERT INTO worker_installations (
         id, creator_id, installation_key_id, device_public_key,
         worker_version, protocol_versions, capabilities
       ) VALUES ($1, $2, $3, $4, 'ready-pg/1', '[1]'::jsonb, '{}'::jsonb)`,
      [ids.installation, ids.creator, `ready-key-${ids.installation}`, Buffer.alloc(65, 7)],
    );
    await target.query(
      `INSERT INTO deployments (
         id, agent_id, creator_id, environment, desired_state, desired_version_id,
         serving_version_id, observed_state, generation, lease_fence,
         observed_worker_id, observed_generation
       ) VALUES ($1, $2, $3, 'TEST', 'ONLINE', $4, $4, 'ONLINE', 1, 2, $5, 1)`,
      [ids.deployment, ids.agent, ids.creator, ids.version, ids.installation],
    );
    await target.query(
      `INSERT INTO agent_version_controls (version_id, creator_id)
       VALUES ($1, $2)`,
      [ids.version, ids.creator],
    );
    await target.query(
      `INSERT INTO worker_auth_challenges (
         id, creator_id, installation_id, deployment_id, deployment_generation,
         state, issued_at, expires_at, consumed_at
       ) VALUES
         ($1, $3, $4, $5, 1, 'CONSUMED',
          clock_timestamp() - interval '5 minutes', clock_timestamp() + interval '1 hour',
          clock_timestamp() - interval '4 minutes'),
         ($2, $3, $4, $5, 1, 'CONSUMED',
          clock_timestamp() - interval '3 minutes', clock_timestamp() + interval '1 hour',
          clock_timestamp() - interval '2 minutes')`,
      [ids.originalChallenge, ids.currentChallenge, ids.creator, ids.installation, ids.deployment],
    );
    await target.query(
      `INSERT INTO worker_gateway_sessions (
         id, creator_id, installation_id, challenge_id, connection_id,
         registration_digest, state, connected_at, expires_at, closed_at,
         disconnect_reason
       ) VALUES
         ($1, $3, $4, $5, $6, $7, 'REPLACED',
          clock_timestamp() - interval '5 minutes', clock_timestamp() + interval '1 hour',
          clock_timestamp() - interval '2 minutes', 'SESSION_REPLACED'),
         ($2, $3, $4, $8, $9, $7, 'ACTIVE',
          clock_timestamp() - interval '2 minutes', clock_timestamp() + interval '1 hour',
          NULL, NULL)`,
      [
        ids.originalSession,
        ids.currentSession,
        ids.creator,
        ids.installation,
        ids.originalChallenge,
        ids.originalConnection,
        digest('e'),
        ids.currentChallenge,
        ids.currentConnection,
      ],
    );
    await target.query(
      `INSERT INTO worker_leases (
         id, deployment_id, creator_id, worker_id, connection_id, fence,
         state, acquired_at, renewed_at, expires_at
       ) VALUES
         ($1, $3, $4, $5, $6, 1, 'REVOKED',
          clock_timestamp() - interval '5 minutes', clock_timestamp() - interval '4 minutes',
          clock_timestamp() + interval '1 hour'),
         ($2, $3, $4, $5, $7, 2, 'ACTIVE',
          clock_timestamp() - interval '2 minutes', clock_timestamp() - interval '1 minute',
          clock_timestamp() + interval '1 hour')`,
      [
        ids.originalLease,
        ids.currentLease,
        ids.deployment,
        ids.creator,
        ids.installation,
        ids.originalConnection,
        ids.currentConnection,
      ],
    );

    await seedConversation(ids.primaryConversation, ids.primaryOpen, 'OPENING', 'SENT');
    await seedConversation(ids.concurrentConversation, ids.concurrentOpen, 'OPENING', 'SENT');
    await seedConversation(ids.securityRaceConversation, ids.securityRaceOpen, 'OPENING', 'SENT');
    await seedConversation(ids.negativeConversation, ids.negativeOpen, 'OPENING', 'SENT');
    await seedConversation(ids.legacyConversation, ids.legacyOpen, 'IDLE', 'ACKED');
    await target.query(
      `INSERT INTO conversation_ready_receipts (
         source_event_id, conversation_id, creator_id, consumer_subject_id,
         open_command_id, worker_id, lease_id, fence, sandbox_instance_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8)`,
      [
        ids.legacySource,
        ids.legacyConversation,
        ids.creator,
        ids.consumer,
        ids.legacyOpen,
        ids.installation,
        ids.originalLease,
        randomUuidV7(),
      ],
    );
    await applyMigration(target, '0017_creator_agent_conversation_ready_fact.sql');
  }, 60_000);

  afterAll(async () => {
    if (target !== undefined) await target.end().catch(() => undefined);
    if (admin !== undefined) {
      await admin
        .query(
          `SELECT pg_terminate_backend(pid)
             FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [databaseName],
        )
        .catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });

  it('matches the protocol golden digest and installs the full 0017 schema', async () => {
    const golden = await target.query<{ fact_digest: string }>(
      `SELECT creator_agent_conversation_ready_fact_digest(
         '0198f00d-3000-7000-8000-000000000001',
         '0198f00d-3000-7000-8000-000000000010',
         '0198f00d-3000-7000-8000-000000000004',
         '0198f00d-3000-7000-8000-000000000020',
         repeat('e', 64), repeat('a', 64),
         '0198f00d-1111-7111-8111-111111111111',
         '0198f00d-1111-7111-8111-111111111112',
         '0198f00d-3000-7000-8000-000000000005', 42,
         '0198f00d-3000-7000-8000-000000000030',
         'thread-conversation-001', 'sha256:' || repeat('b', 64)
       ) AS fact_digest`,
    );
    expect(golden.rows).toEqual([
      { fact_digest: 'c5f74842f7d380de1c5f665843b4f067d3f04082627e209eb74b0b6f7aeaceb4' },
    ]);

    const authority = await target.query<{
      row_security: boolean;
      force_row_security: boolean;
      security_definer: boolean;
      trusted_owner: boolean;
      broker_execute: boolean;
      api_execute: boolean;
      broker_select: boolean;
    }>(
      `SELECT relation.relrowsecurity AS row_security,
              relation.relforcerowsecurity AS force_row_security,
              procedure.prosecdef AS security_definer,
              (owner.rolsuper OR owner.rolbypassrls) AS trusted_owner,
              has_function_privilege(
                'combo_agent_broker', procedure.oid, 'EXECUTE'
              ) AS broker_execute,
              has_function_privilege(
                'combo_agent_api', procedure.oid, 'EXECUTE'
              ) AS api_execute,
              has_table_privilege(
                'combo_agent_broker', relation.oid, 'SELECT'
              ) AS broker_select
         FROM pg_class AS relation
         JOIN pg_proc AS procedure
           ON procedure.oid = to_regprocedure(
             'creator_agent_commit_conversation_ready_fact(uuid,text,uuid,uuid,uuid,uuid,uuid,text,text,uuid,uuid,uuid,bigint,uuid,text,text)'
           )
         JOIN pg_roles AS owner ON owner.oid = procedure.proowner
        WHERE relation.oid = 'conversation_ready_fact_receipts'::regclass`,
    );
    expect(authority.rows).toEqual([
      {
        row_security: true,
        force_row_security: true,
        security_definer: true,
        trusted_owner: true,
        broker_execute: true,
        api_execute: false,
        broker_select: false,
      },
    ]);
  });

  it('applies a first late fact from terminal original authority while a new fence is current', async () => {
    const before = await target.query<{
      original_session_state: string;
      original_lease_state: string;
      current_lease_state: string;
      current_fence: string;
    }>(
      `SELECT original_session.state AS original_session_state,
              original_lease.state AS original_lease_state,
              current_lease.state AS current_lease_state,
              deployment.lease_fence::text AS current_fence
         FROM worker_gateway_sessions AS original_session
         JOIN worker_leases AS original_lease ON original_lease.id = $2
         JOIN worker_leases AS current_lease ON current_lease.id = $3
         JOIN deployments AS deployment ON deployment.id = original_lease.deployment_id
        WHERE original_session.id = $1`,
      [ids.originalSession, ids.originalLease, ids.currentLease],
    );
    expect(before.rows).toEqual([
      {
        original_session_state: 'REPLACED',
        original_lease_state: 'REVOKED',
        current_lease_state: 'ACTIVE',
        current_fence: '2',
      },
    ]);

    const primaryDigest = readyFactDigest(primaryFact);
    const wrongDigest = `${primaryDigest.slice(0, 63)}${primaryDigest.endsWith('0') ? '1' : '0'}`;
    await expect(callReady(target, primaryFact, wrongDigest)).resolves.toEqual({
      outcome: 'REJECTED',
      conversation_state: null,
      open_command_id: null,
    });
    await expect(callReady(target, primaryFact)).resolves.toEqual({
      outcome: 'APPLIED',
      conversation_state: 'IDLE',
      open_command_id: ids.primaryOpen,
    });

    const committed = await target.query<{
      conversation_state: string;
      command_state: string;
      receipts: string;
      fact_digest: string;
      original_connection_id: string;
      original_fence: string;
    }>(
      `SELECT conversation.state AS conversation_state,
              command.state AS command_state,
              count(receipt.source_event_id)::text AS receipts,
              min(receipt.fact_digest) AS fact_digest,
              min(receipt.original_connection_id::text) AS original_connection_id,
              min(receipt.original_fence::text) AS original_fence
         FROM agent_conversations AS conversation
         JOIN broker_outbox AS command ON command.command_id = $2
         LEFT JOIN conversation_ready_fact_receipts AS receipt
           ON receipt.conversation_id = conversation.id
        WHERE conversation.id = $1
        GROUP BY conversation.state, command.state`,
      [ids.primaryConversation, ids.primaryOpen],
    );
    expect(committed.rows).toEqual([
      {
        conversation_state: 'IDLE',
        command_state: 'ACKED',
        receipts: '1',
        fact_digest: readyFactDigest(primaryFact),
        original_connection_id: ids.originalConnection,
        original_fence: '1',
      },
    ]);

    const changedSandbox = { ...primaryFact, sandboxInstanceId: randomUuidV7() };
    await expect(
      callReady(target, changedSandbox, readyFactDigest(changedSandbox)),
    ).resolves.toEqual({
      outcome: 'REJECTED',
      conversation_state: null,
      open_command_id: null,
    });
    await expect(callReady(target, primaryFact, digest('f'))).resolves.toEqual({
      outcome: 'REJECTED',
      conversation_state: null,
      open_command_id: null,
    });
  });

  it('returns exact REPLAY after another current Session and Lease replacement', async () => {
    const next = {
      challenge: randomUuidV7(),
      session: randomUuidV7(),
      connection: randomUuidV7(),
      lease: randomUuidV7(),
    };
    await target.query('BEGIN');
    try {
      await target.query(
        `UPDATE worker_gateway_sessions
            SET state = 'REPLACED', closed_at = clock_timestamp(),
                disconnect_reason = 'SESSION_REPLACED'
          WHERE id = $1 AND state = 'ACTIVE'`,
        [ids.currentSession],
      );
      await target.query(`UPDATE worker_leases SET state = 'REVOKED' WHERE id = $1`, [
        ids.currentLease,
      ]);
      await target.query(
        `INSERT INTO worker_auth_challenges (
           id, creator_id, installation_id, deployment_id, deployment_generation,
           state, issued_at, expires_at, consumed_at
         ) VALUES (
           $1, $2, $3, $4, 1, 'CONSUMED', clock_timestamp(),
           clock_timestamp() + interval '1 hour', clock_timestamp()
         )`,
        [next.challenge, ids.creator, ids.installation, ids.deployment],
      );
      await target.query(
        `INSERT INTO worker_gateway_sessions (
           id, creator_id, installation_id, challenge_id, connection_id,
           registration_digest, state, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', clock_timestamp() + interval '1 hour')`,
        [next.session, ids.creator, ids.installation, next.challenge, next.connection, digest('e')],
      );
      await target.query(
        `INSERT INTO worker_leases (
           id, deployment_id, creator_id, worker_id, connection_id, fence, expires_at
         ) VALUES ($1, $2, $3, $4, $5, 3, clock_timestamp() + interval '1 hour')`,
        [next.lease, ids.deployment, ids.creator, ids.installation, next.connection],
      );
      await target.query(
        `UPDATE deployments
            SET lease_fence = 3, observed_state = 'ONLINE',
                observed_worker_id = $2, observed_generation = generation,
                updated_at = clock_timestamp()
          WHERE id = $1`,
        [ids.deployment, ids.installation],
      );
      await target.query('COMMIT');
    } catch (error) {
      await target.query('ROLLBACK');
      throw error;
    }

    await expect(callReady(target, primaryFact)).resolves.toEqual({
      outcome: 'REPLAY',
      conversation_state: 'IDLE',
      open_command_id: ids.primaryOpen,
    });
  });

  it('fails closed on an overlapping legacy 0014 receipt with zero mutation', async () => {
    await expect(callReady(target, legacyFact)).resolves.toEqual({
      outcome: 'REJECTED',
      conversation_state: null,
      open_command_id: null,
    });
    const facts = await target.query<{
      modern_receipts: string;
      legacy_receipts: string;
      conversation_state: string;
      command_state: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM conversation_ready_fact_receipts
           WHERE conversation_id = $1) AS modern_receipts,
         (SELECT count(*)::text FROM conversation_ready_receipts
           WHERE conversation_id = $1) AS legacy_receipts,
         conversation.state AS conversation_state,
         command.state AS command_state
       FROM agent_conversations AS conversation
       JOIN broker_outbox AS command ON command.command_id = $2
      WHERE conversation.id = $1`,
      [ids.legacyConversation, ids.legacyOpen],
    );
    expect(facts.rows).toEqual([
      {
        modern_receipts: '0',
        legacy_receipts: '1',
        conversation_state: 'IDLE',
        command_state: 'ACKED',
      },
    ]);
  });

  it('direct Broker calls reject offline, blocked, revoked-installation, and revoked-Version fresh facts', async () => {
    const scenarios: Array<{
      name: string;
      mutate: () => Promise<unknown>;
      alsoReplay?: boolean;
    }> = [
      {
        name: 'offline',
        mutate: () =>
          target.query(
            `UPDATE deployments
                SET desired_state = 'OFFLINE', generation = generation + 1,
                    observed_state = 'OFFLINE', observed_generation = generation + 1,
                    updated_at = clock_timestamp()
              WHERE id = $1`,
            [ids.deployment],
          ),
      },
      {
        name: 'blocked',
        mutate: () =>
          target.query(
            `UPDATE deployments
                SET observed_state = 'BLOCKED', observed_generation = generation,
                    updated_at = clock_timestamp()
              WHERE id = $1`,
            [ids.deployment],
          ),
      },
      {
        name: 'revoked installation',
        mutate: () =>
          target.query(
            `UPDATE worker_installations SET revoked_at = clock_timestamp() WHERE id = $1`,
            [ids.installation],
          ),
      },
      {
        name: 'revoked Version',
        mutate: () =>
          target.query(
            `UPDATE agent_version_controls
                SET availability = 'REVOKED', severity = 'SECURITY',
                    reason_code = 'READY_FACT_PG_TEST', updated_at = clock_timestamp()
              WHERE version_id = $1`,
            [ids.version],
          ),
        alsoReplay: true,
      },
    ];

    for (const scenario of scenarios) {
      await target.query('BEGIN');
      try {
        await scenario.mutate();
        expect(await callReadyInsideOwnerTransaction(negativeFact)).toEqual({
          outcome: 'REJECTED',
          conversation_state: null,
          open_command_id: null,
        });
        if (scenario.alsoReplay === true) {
          expect(await callReadyInsideOwnerTransaction(primaryFact)).toEqual({
            outcome: 'REPLAY',
            conversation_state: 'IDLE',
            open_command_id: ids.primaryOpen,
          });
        }
        expect(await negativeState(), scenario.name).toEqual({
          receipts: '0',
          conversation_state: 'OPENING',
          command_state: 'SENT',
        });
      } finally {
        await target.query('ROLLBACK');
      }
    }
  });

  it('serializes two exact deliveries into one APPLIED and one REPLAY', async () => {
    const first = new Client({ connectionString: targetUrl });
    const second = new Client({ connectionString: targetUrl });
    await Promise.all([first.connect(), second.connect()]);
    try {
      const outcomes = await Promise.all([
        callReady(first, concurrentFact),
        callReady(second, concurrentFact),
      ]);
      expect(outcomes.map((row) => row.outcome).sort()).toEqual(['APPLIED', 'REPLAY']);
    } finally {
      await Promise.all([first.end(), second.end()]);
    }
    const count = await target.query<{ receipts: string }>(
      `SELECT count(*)::text AS receipts
         FROM conversation_ready_fact_receipts
        WHERE conversation_id = $1`,
      [ids.concurrentConversation],
    );
    expect(count.rows).toEqual([{ receipts: '1' }]);
  });

  it('denies direct journal reads, the retired 0014 projector, and receipt mutation', async () => {
    await target.query('BEGIN');
    try {
      await target.query('SET LOCAL ROLE combo_agent_broker');
      await expect(
        target.query(`SELECT source_event_id FROM conversation_ready_fact_receipts`),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await target.query('ROLLBACK');
    }

    await target.query('BEGIN');
    try {
      await target.query('SET LOCAL ROLE combo_agent_broker');
      await target.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creator]);
      await target.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumer]);
      await expect(
        target.query(
          `SELECT * FROM creator_agent_commit_conversation_ready(
             $1, $2, $3, $4, $5, $6, 1, $7
           )`,
          [
            randomUuidV7(),
            ids.negativeConversation,
            ids.creator,
            ids.consumer,
            ids.installation,
            ids.originalLease,
            randomUuidV7(),
          ],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await target.query('ROLLBACK');
    }

    await expect(
      target.query(
        `UPDATE conversation_ready_fact_receipts
            SET fact_digest = fact_digest
          WHERE source_event_id = $1`,
        [ids.primaryOpen],
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('returns 40001 instead of deadlocking when SECURITY owns Version and waits on Gateway', async () => {
    const gateway = new Client({ connectionString: targetUrl });
    const security = new Client({ connectionString: targetUrl });
    await Promise.all([gateway.connect(), security.connect()]);

    let securityOutcome:
      | Promise<{ ok: true; rowCount: number | null } | { ok: false; error: unknown }>
      | undefined;
    let gatewayFinished = false;
    let securityFinished = false;
    try {
      await gateway.query('BEGIN');
      await gateway.query(`SET LOCAL statement_timeout = '750ms'`);
      await gateway.query('SET LOCAL ROLE combo_agent_broker');
      await gateway.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creator]);
      await gateway.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumer]);
      await gateway.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended(
             'combo.gateway.deployment/v1:' || $1::uuid::text || ':' || $2::uuid::text,
             0
           )
         )`,
        [ids.creator, ids.deployment],
      );

      const securityPidResult = await security.query<{ pid: number }>(
        `SELECT pg_backend_pid() AS pid`,
      );
      const securityPid = securityPidResult.rows[0]?.pid;
      if (securityPid === undefined) throw new Error('SECURITY backend pid missing');
      await security.query('BEGIN');
      securityOutcome = security
        .query(
          `UPDATE agent_version_controls
              SET availability = 'REVOKED', severity = 'SECURITY',
                  reason_code = 'READY_FACT_LOCK_ORDER_TEST', updated_at = clock_timestamp()
            WHERE version_id = $1 AND creator_id = $2`,
          [ids.version, ids.creator],
        )
        .then(
          (result) => ({ ok: true as const, rowCount: result.rowCount }),
          (error: unknown) => ({ ok: false as const, error }),
        );

      const waitDeadline = Date.now() + 5_000;
      let waitingOnDeploymentAdvisory = false;
      while (Date.now() < waitDeadline) {
        const locks = await target.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1
               FROM pg_locks
              WHERE pid = $1
                AND locktype = 'advisory'
                AND NOT granted
           ) AS waiting`,
          [securityPid],
        );
        if (locks.rows[0]?.waiting === true) {
          waitingOnDeploymentAdvisory = true;
          break;
        }
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
      }
      expect(waitingOnDeploymentAdvisory).toBe(true);

      await expect(
        target.query(
          `SELECT 1
             FROM agent_version_controls
            WHERE version_id = $1 AND creator_id = $2
            FOR SHARE NOWAIT`,
          [ids.version, ids.creator],
        ),
      ).rejects.toMatchObject({ code: '55P03' });

      await expect(selectReady(gateway, securityRaceFact)).rejects.toMatchObject({
        code: '40001',
        message: 'conversation.ready Version authority is concurrently changing; retry transaction',
      });
      await expect(gateway.query('SELECT 1')).rejects.toMatchObject({ code: '25P02' });

      const untouched = await target.query<{
        receipts: string;
        conversation_state: string;
        command_state: string;
      }>(
        `SELECT
           (SELECT count(*)::text
              FROM conversation_ready_fact_receipts
             WHERE conversation_id = $1) AS receipts,
           conversation.state AS conversation_state,
           command.state AS command_state
         FROM agent_conversations AS conversation
         JOIN broker_outbox AS command ON command.command_id = $2
        WHERE conversation.id = $1`,
        [ids.securityRaceConversation, ids.securityRaceOpen],
      );
      expect(untouched.rows).toEqual([
        { receipts: '0', conversation_state: 'OPENING', command_state: 'SENT' },
      ]);

      await gateway.query('ROLLBACK');
      gatewayFinished = true;
      const securityResult = await securityOutcome;
      if (!securityResult.ok) throw securityResult.error;
      expect(securityResult.rowCount).toBe(1);
      await security.query('COMMIT');
      securityFinished = true;

      await expect(callReady(target, securityRaceFact)).resolves.toEqual({
        outcome: 'REJECTED',
        conversation_state: null,
        open_command_id: null,
      });
      await expect(callReady(target, primaryFact)).resolves.toEqual({
        outcome: 'REPLAY',
        conversation_state: 'IDLE',
        open_command_id: ids.primaryOpen,
      });
    } finally {
      if (!gatewayFinished) await gateway.query('ROLLBACK').catch(() => undefined);
      if (securityOutcome !== undefined) await securityOutcome;
      if (!securityFinished) await security.query('ROLLBACK').catch(() => undefined);
      await Promise.all([gateway.end(), security.end()]);
    }
  });
});
