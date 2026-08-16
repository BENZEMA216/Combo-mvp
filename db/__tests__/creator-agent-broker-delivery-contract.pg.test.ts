import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
const requested = process.env.CREATOR_AGENT_BROKER_CONTRACT_PG_TEST === '1';
if (requested && !databaseUrl) {
  throw new Error('CREATOR_AGENT_BROKER_CONTRACT_PG_TEST requires DATABASE_URL');
}
const pgDescribe = requested ? describe.sequential : describe.skip;
const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const migration0018 = '0018_creator_agent_broker_delivery_contract.sql';

function childDatabaseUrl(name: string): string {
  const url = new URL(databaseUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

function digest(marker: string): string {
  return marker.repeat(64);
}

function account(marker: string): string {
  return `creator-${marker
    .replaceAll(/[^a-z2-7]/gu, 'a')
    .slice(0, 8)
    .padEnd(8, 'a')}`;
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

async function expectZeroLiveRollback(client: Client): Promise<void> {
  const sql = readFileSync(join(migrationsDirectory, migration0018), 'utf8');
  await client.query('BEGIN');
  let failure: unknown;
  try {
    await client.query(sql);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: '55000' });
  await client.query('ROLLBACK');
  await expect(
    client.query(
      `SELECT
         to_regclass('public.schema_migrations') IS NOT NULL AS ledger,
         EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'broker_outbox'
              AND column_name = 'payload_contract_version'
         ) AS payload_column,
         EXISTS (
           SELECT 1 FROM schema_migrations WHERE filename = $1
         ) AS migration_record`,
      [migration0018],
    ),
  ).resolves.toMatchObject({
    rows: [{ ledger: true, payload_column: false, migration_record: false }],
  });
}

async function waitForBackendLock(observer: Client, backendPid: number): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const activity = await observer.query<{
      wait_event_type: string | null;
      wait_event: string | null;
    }>(
      `SELECT wait_event_type, wait_event
         FROM pg_stat_activity
        WHERE pid = $1`,
      [backendPid],
    );
    const row = activity.rows[0];
    if (row?.wait_event_type === 'Lock' && row.wait_event) return row.wait_event;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`backend ${backendPid} did not reach the deterministic lock barrier`);
}

pgDescribe('0018 Broker delivery contract real PostgreSQL upgrade', () => {
  it('rolls back each live authority, then upgrades v0 and enforces v1 reconnect delivery', async () => {
    const admin = new Client({ connectionString: databaseUrl });
    const databaseName = `combo_broker_0018_${randomUUID().replaceAll('-', '')}`;
    const apiMemberRole = `combo_0018_api_member_${randomUUID().replaceAll('-', '')}`;
    await admin.connect();
    let target: Client | undefined;
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      target = new Client({ connectionString: childDatabaseUrl(databaseName) });
      await target.connect();
      await target.query(`
        CREATE TABLE schema_migrations (
          filename text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      const pre0018 = readdirSync(migrationsDirectory)
        .filter((filename) => /^\d{4}_.+\.sql$/u.test(filename) && filename < '0018_')
        .sort();
      expect(pre0018.at(-1)).toBe('0017_creator_agent_conversation_ready_fact.sql');
      for (const filename of pre0018) await applyMigration(target, filename);

      const ids = {
        creator: randomUUID(),
        consumer: randomUUID(),
        snapshot: randomUUID(),
        agent: randomUUID(),
        grant: randomUUID(),
        version: randomUUID(),
        deployment: randomUUID(),
        worker: randomUUID(),
        legacyCommand: randomUUID(),
        legacyChallenge: randomUUID(),
        legacySession: randomUUID(),
        legacyConnection: randomUUID(),
        legacyFrame: randomUUID(),
        activeSessionChallenge: randomUUID(),
        activeSession: randomUUID(),
        activeSessionConnection: randomUUID(),
        activeLease: randomUUID(),
      };

      await target.query(`INSERT INTO users (id, account) VALUES ($1, $2), ($3, $4)`, [
        ids.creator,
        account(randomUUID()),
        ids.consumer,
        account(randomUUID()),
      ]);
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
          `vnext/${ids.snapshot}.archive.enc`,
          `vnext/${ids.snapshot}.manifest.enc`,
          `kms://${ids.snapshot}`,
        ],
      );
      await target.query(
        `INSERT INTO agents (id, creator_id, public_slug, name)
         VALUES ($1, $2, $3, 'Broker 0018 Agent')`,
        [ids.agent, ids.creator, `broker-${ids.agent.slice(0, 8)}`],
      );
      await target.query(
        `INSERT INTO agent_access_grants (
           id, agent_id, creator_id, consumer_subject_id
         ) VALUES ($1, $2, $3, $4)`,
        [ids.grant, ids.agent, ids.creator, ids.consumer],
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
           '0.147.0-alpha.6.5', $10, $11
         )`,
        [
          ids.version,
          ids.agent,
          ids.creator,
          digest('7'),
          ids.snapshot,
          digest('a'),
          digest('b'),
          digest('c'),
          digest('d'),
          `sha256:${digest('e')}`,
          `sha256:${digest('f')}`,
        ],
      );
      await target.query(
        `INSERT INTO agent_version_controls (version_id, creator_id) VALUES ($1, $2)`,
        [ids.version, ids.creator],
      );
      await target.query(
        `INSERT INTO deployments (
           id, agent_id, creator_id, environment, desired_version_id
         ) VALUES ($1, $2, $3, 'TEST', $4)`,
        [ids.deployment, ids.agent, ids.creator, ids.version],
      );
      await target.query(
        `INSERT INTO worker_installations (
           id, creator_id, installation_key_id, device_public_key,
           worker_version, protocol_versions, capabilities
         ) VALUES ($1, $2, $3, $4, '0.1.0', '[1]'::jsonb, '{}'::jsonb)`,
        [ids.worker, ids.creator, `key-${ids.worker}`, Buffer.alloc(65, 7)],
      );

      await target.query(
        `INSERT INTO worker_auth_challenges (
           id, creator_id, installation_id, deployment_id, deployment_generation,
           state, issued_at, expires_at, consumed_at
         ) VALUES (
           $1, $2, $3, $4, 0, 'CONSUMED',
           statement_timestamp(), statement_timestamp() + interval '1 hour', statement_timestamp()
         )`,
        [ids.legacyChallenge, ids.creator, ids.worker, ids.deployment],
      );
      await target.query(
        `INSERT INTO worker_gateway_sessions (
           id, creator_id, installation_id, challenge_id, connection_id,
           registration_digest, state, expires_at, closed_at, disconnect_reason
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 'CLOSED',
           now() + interval '1 hour', now(), 'CLIENT_CLOSED'
         )`,
        [
          ids.legacySession,
          ids.creator,
          ids.worker,
          ids.legacyChallenge,
          ids.legacyConnection,
          digest('4'),
        ],
      );

      // PENDING/SENT business Outbox alone blocks and leaves schema + ledger untouched.
      await target.query(
        `INSERT INTO broker_outbox (
           command_id, creator_id, target_worker_id, command_type,
           dedupe_key, state, next_attempt_at, expires_at
         ) VALUES ($1, $2, $3, 'deployment.prepare', $4, 'PENDING', now(), now() + interval '1 hour')`,
        [ids.legacyCommand, ids.creator, ids.worker, `legacy:${ids.legacyCommand}`],
      );
      await expectZeroLiveRollback(target);
      await target.query(`UPDATE broker_outbox SET state = 'EXPIRED' WHERE command_id = $1`, [
        ids.legacyCommand,
      ]);

      // A nonterminal legacy business delivery blocks even with no live Outbox/Session/Lease.
      await target.query(
        `INSERT INTO worker_gateway_outbound_frames (
           session_id, creator_id, sequence, message_id, canonical_digest, envelope_type
         ) VALUES ($1, $2, 0, $3, $4, 'conversation.open')`,
        [ids.legacySession, ids.creator, ids.legacyFrame, digest('5')],
      );
      await expectZeroLiveRollback(target);
      await target.query(
        `UPDATE worker_gateway_outbound_frames
            SET durable_ack_level = 'CLOUD_COMMITTED',
                ack_decision = 'APPLIED', acked_at = now()
          WHERE session_id = $1 AND sequence = 0`,
        [ids.legacySession],
      );

      // ACTIVE Gateway Session alone blocks.
      await target.query(
        `INSERT INTO worker_auth_challenges (
           id, creator_id, installation_id, deployment_id, deployment_generation,
           state, issued_at, expires_at, consumed_at
         ) VALUES (
           $1, $2, $3, $4, 0, 'CONSUMED',
           statement_timestamp(), statement_timestamp() + interval '1 hour', statement_timestamp()
         )`,
        [ids.activeSessionChallenge, ids.creator, ids.worker, ids.deployment],
      );
      await target.query(
        `INSERT INTO worker_gateway_sessions (
           id, creator_id, installation_id, challenge_id, connection_id,
           registration_digest, state, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', now() + interval '1 hour')`,
        [
          ids.activeSession,
          ids.creator,
          ids.worker,
          ids.activeSessionChallenge,
          ids.activeSessionConnection,
          digest('6'),
        ],
      );
      await expectZeroLiveRollback(target);
      await target.query(
        `UPDATE worker_gateway_sessions
            SET state = 'CLOSED', closed_at = now(), disconnect_reason = 'CLIENT_CLOSED'
          WHERE id = $1`,
        [ids.activeSession],
      );

      // ACTIVE Lease alone blocks.
      await target.query(
        `INSERT INTO worker_leases (
           id, deployment_id, creator_id, worker_id, connection_id, fence, state, expires_at
         ) VALUES ($1, $2, $3, $4, $5, 1, 'ACTIVE', now() + interval '1 hour')`,
        [ids.activeLease, ids.deployment, ids.creator, ids.worker, ids.activeSessionConnection],
      );
      await expectZeroLiveRollback(target);
      await target.query(`UPDATE worker_leases SET state = 'RELEASED' WHERE id = $1`, [
        ids.activeLease,
      ]);

      await applyMigration(target, migration0018);
      await expect(
        target.query(`SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1`),
      ).resolves.toMatchObject({ rows: [{ filename: migration0018 }] });
      await expect(
        target.query(
          `SELECT
             (SELECT payload_contract_version FROM broker_outbox WHERE command_id = $1) AS outbox_v,
             (SELECT visible_transcript_digest FROM broker_outbox WHERE command_id = $1) AS digest,
             (SELECT delivery_contract_version
                FROM worker_gateway_outbound_frames
               WHERE session_id = $2 AND sequence = 0) AS delivery_v`,
          [ids.legacyCommand, ids.legacySession],
        ),
      ).resolves.toMatchObject({ rows: [{ outbox_v: 0, digest: null, delivery_v: 0 }] });

      await target.query(
        `CREATE ROLE "${apiMemberRole}"
           NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
      );
      await target.query(`GRANT combo_agent_api TO "${apiMemberRole}"`);

      const live = {
        challenge: randomUUID(),
        session: randomUUID(),
        connection: randomUUID(),
        lease: randomUUID(),
        revokeMessage: randomUUID(),
        idempotency: randomUUID(),
      };
      await target.query(
        `UPDATE deployments
            SET desired_state = 'ONLINE', generation = 3,
                serving_version_id = $2, observed_state = 'ONLINE',
                observed_worker_id = $3, observed_generation = 3,
                lease_fence = 3, updated_at = now()
          WHERE id = $1`,
        [ids.deployment, ids.version, ids.worker],
      );
      await target.query(
        `INSERT INTO worker_auth_challenges (
           id, creator_id, installation_id, deployment_id, deployment_generation,
           state, issued_at, expires_at, consumed_at
         ) VALUES (
           $1, $2, $3, $4, 3, 'CONSUMED',
           statement_timestamp(), statement_timestamp() + interval '1 hour', statement_timestamp()
         )`,
        [live.challenge, ids.creator, ids.worker, ids.deployment],
      );
      await target.query(
        `INSERT INTO worker_gateway_sessions (
           id, creator_id, installation_id, challenge_id, connection_id,
           registration_digest, state, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', now() + interval '1 hour')`,
        [live.session, ids.creator, ids.worker, live.challenge, live.connection, digest('8')],
      );
      await target.query(
        `INSERT INTO worker_leases (
           id, deployment_id, creator_id, worker_id, connection_id, fence, state, expires_at
         ) VALUES ($1, $2, $3, $4, $5, 3, 'ACTIVE', now() + interval '1 hour')`,
        [live.lease, ids.deployment, ids.creator, ids.worker, live.connection],
      );

      // The API guard identifies the authenticated API authority, not the
      // SECURITY DEFINER owner. Both a direct API session and an audited pool
      // login that SET ROLEs into API remain limited to invocation.prepare.
      await target.query('SET SESSION AUTHORIZATION combo_agent_api');
      await target.query(`SELECT set_config('app.creator_id', $1, false)`, [ids.creator]);
      await expect(
        target.query(
          `INSERT INTO broker_outbox (
             command_id, creator_id, target_worker_id, consumer_subject_id,
             command_type, dedupe_key, state, next_attempt_at, expires_at
           ) VALUES (
             $1, $2, $3, $4, 'conversation.open', $5,
             'PENDING', now(), now() + interval '1 hour'
           )`,
          [randomUUID(), ids.creator, ids.worker, ids.consumer, `forbidden-api:${randomUUID()}`],
        ),
      ).rejects.toMatchObject({
        code: '42501',
        message: 'API may insert only the exact initial invocation.prepare command',
      });
      await target.query('RESET SESSION AUTHORIZATION');

      await target.query(`SET SESSION AUTHORIZATION "${apiMemberRole}"`);
      await target.query('SET ROLE combo_agent_api');
      await target.query(`SELECT set_config('app.creator_id', $1, false)`, [ids.creator]);
      await expect(
        target.query(
          `INSERT INTO broker_outbox (
             command_id, creator_id, target_worker_id, consumer_subject_id,
             command_type, dedupe_key, state, next_attempt_at, expires_at
           ) VALUES (
             $1, $2, $3, $4, 'conversation.open', $5,
             'PENDING', now(), now() + interval '1 hour'
           )`,
          [randomUUID(), ids.creator, ids.worker, ids.consumer, `forbidden-member:${randomUUID()}`],
        ),
      ).rejects.toMatchObject({
        code: '42501',
        message: 'API may insert only the exact initial invocation.prepare command',
      });
      await target.query('RESET ROLE');
      await target.query('RESET SESSION AUTHORIZATION');

      // Old Consumer binaries cannot call create-open v0. An exact Consumer
      // session may call v2 through the trusted definer without being mistaken
      // for either API authority or the owner executing the function body.
      await target.query('SET SESSION AUTHORIZATION combo_agent_consumer_api');
      await target.query('BEGIN');
      await target.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creator]);
      await target.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumer]);
      await expect(
        target.query(
          `SELECT * FROM creator_agent_create_opening_conversation(
             $1, $2, $3, $4, $5, $6, $7, $8, $9, 3, 3600
           )`,
          [
            ids.agent,
            ids.deployment,
            ids.version,
            ids.creator,
            ids.consumer,
            randomUUID(),
            digest('9'),
            digest('7'),
            ids.worker,
          ],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await target.query('ROLLBACK');

      await target.query('BEGIN');
      await target.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creator]);
      await target.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumer]);
      const created = await target.query<{ open_command_id: string }>(
        `SELECT * FROM creator_agent_create_opening_conversation_v2(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, 3, 3600,
           $10, $11, 7, $12
         )`,
        [
          ids.agent,
          ids.deployment,
          ids.version,
          ids.creator,
          ids.consumer,
          live.idempotency,
          digest('9'),
          digest('7'),
          ids.worker,
          `hmac-sha256:${digest('a')}`,
          'visible-key-a',
          'kms://creator/version/visible-key-a@7',
        ],
      );
      await target.query('COMMIT');
      await target.query('RESET SESSION AUTHORIZATION');
      const commandId = created.rows[0]?.open_command_id;
      expect(commandId).toBeTypeOf('string');

      // A migration-owner session is privileged but must not be classified as
      // API merely because PostgreSQL reports a superuser as every role's member.
      await target.query(`SELECT set_config('app.creator_id', $1, false)`, [ids.creator]);
      await target.query(`SELECT set_config('app.consumer_id', $1, false)`, [ids.consumer]);
      const ownerCreated = await target.query<{ open_command_id: string }>(
        `SELECT * FROM creator_agent_create_opening_conversation_v2(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, 3, 3600,
           $10, $11, 7, $12
         )`,
        [
          ids.agent,
          ids.deployment,
          ids.version,
          ids.creator,
          ids.consumer,
          randomUUID(),
          digest('9'),
          digest('7'),
          ids.worker,
          `hmac-sha256:${digest('b')}`,
          'visible-key-owner',
          'kms://creator/version/visible-key-owner@7',
        ],
      );
      expect(ownerCreated.rows[0]?.open_command_id).toBeTypeOf('string');
      await expect(
        target.query(
          `SELECT payload_contract_version, visible_transcript_digest,
                  visible_transcript_key_id, visible_transcript_key_version,
                  visible_transcript_key_ref, original_worker_session_id,
                  original_connection_id, assignment_lease_id, assignment_fence
             FROM broker_outbox WHERE command_id = $1`,
          [commandId],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            payload_contract_version: 1,
            visible_transcript_digest: `hmac-sha256:${digest('a')}`,
            visible_transcript_key_id: 'visible-key-a',
            visible_transcript_key_version: '7',
            visible_transcript_key_ref: 'kms://creator/version/visible-key-a@7',
            original_worker_session_id: live.session,
            original_connection_id: live.connection,
            assignment_lease_id: live.lease,
            assignment_fence: '3',
          },
        ],
      });
      await expect(
        target.query(
          `UPDATE broker_outbox SET visible_transcript_digest = $2 WHERE command_id = $1`,
          [commandId, `hmac-sha256:${digest('b')}`],
        ),
      ).rejects.toMatchObject({ code: '55000' });

      // The Broker may persist an exact v0 lease.revoke control while its
      // Session/Lease authority is active. Its message ID remains globally
      // unique and every durable binding remains immutable.
      await target.query('BEGIN');
      await target.query('SET LOCAL ROLE combo_agent_broker');
      await target.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creator]);
      await expect(
        target.query(
          `SELECT session.id
             FROM worker_gateway_sessions AS session
             JOIN worker_leases AS lease
               ON lease.creator_id = session.creator_id
              AND lease.worker_id = session.installation_id
              AND lease.connection_id = session.connection_id
            WHERE session.id = $1
              AND session.creator_id = $2
              AND session.state = 'ACTIVE'
              AND lease.id = $3
              AND lease.deployment_id = $4
              AND lease.fence = 3
              AND lease.state = 'ACTIVE'`,
          [live.session, ids.creator, live.lease, ids.deployment],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await target.query(
        `INSERT INTO worker_gateway_outbound_frames (
           session_id, creator_id, sequence, message_id, canonical_digest, envelope_type
         ) VALUES ($1, $2, 7, $3, $4, 'lease.revoke')`,
        [live.session, ids.creator, live.revokeMessage, digest('c')],
      );
      await target.query('COMMIT');
      await expect(
        target.query(
          `SELECT delivery_contract_version, broker_command_id, envelope_type
             FROM worker_gateway_outbound_frames
            WHERE session_id = $1 AND message_id = $2`,
          [live.session, live.revokeMessage],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            delivery_contract_version: 0,
            broker_command_id: null,
            envelope_type: 'lease.revoke',
          },
        ],
      });

      await target.query('BEGIN');
      await target.query('SET LOCAL ROLE combo_agent_broker');
      await target.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creator]);
      await expect(
        target.query(
          `INSERT INTO worker_gateway_outbound_frames (
             session_id, creator_id, sequence, message_id, canonical_digest, envelope_type
           ) VALUES ($1, $2, 8, $3, $4, 'lease.revoke')`,
          [live.session, ids.creator, live.revokeMessage, digest('1')],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await target.query('ROLLBACK');

      await target.query('BEGIN');
      await target.query('SET LOCAL ROLE combo_agent_broker');
      await target.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creator]);
      await expect(
        target.query(
          `UPDATE worker_gateway_outbound_frames
              SET canonical_digest = $3
            WHERE session_id = $1 AND message_id = $2`,
          [live.session, live.revokeMessage, digest('2')],
        ),
      ).rejects.toMatchObject({ code: '55000' });
      await target.query('ROLLBACK');

      // Every v0 business family remains unclaimable by the Broker role.
      for (const [index, envelopeType] of [
        'conversation.open',
        'invocation.prepare',
        'deployment.prepare',
      ].entries()) {
        await target.query('BEGIN');
        await target.query('SET LOCAL ROLE combo_agent_broker');
        await target.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creator]);
        await expect(
          target.query(
            `INSERT INTO worker_gateway_outbound_frames (
               session_id, creator_id, sequence, message_id, canonical_digest, envelope_type
             ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [live.session, ids.creator, 20 + index, randomUUID(), digest('3'), envelopeType],
          ),
        ).rejects.toMatchObject({ code: '42501' });
        await target.query('ROLLBACK');
      }

      await target.query(
        `INSERT INTO worker_gateway_outbound_frames (
           session_id, creator_id, sequence, message_id, canonical_digest, envelope_type,
           delivery_contract_version, broker_command_id, broker_target_worker_id,
           broker_deployment_id, claim_session_id, claim_connection_id,
           current_delivery_lease_id, current_delivery_fence
         ) VALUES (
           $1, $2, 0, $3, $4, 'conversation.open',
           1, $3, $5, $6, $1, $7, $8, 3
         )`,
        [
          live.session,
          ids.creator,
          commandId,
          digest('d'),
          ids.worker,
          ids.deployment,
          live.connection,
          live.lease,
        ],
      );

      // A replacement Session/Lease may redeliver the same stable command/message ID.
      await target.query(
        `UPDATE worker_gateway_sessions
            SET state = 'REPLACED', closed_at = now(), disconnect_reason = 'SESSION_REPLACED'
          WHERE id = $1`,
        [live.session],
      );
      await target.query(`UPDATE worker_leases SET state = 'RELEASED' WHERE id = $1`, [live.lease]);
      const replacement = {
        challenge: randomUUID(),
        session: randomUUID(),
        connection: randomUUID(),
        lease: randomUUID(),
      };
      await target.query(
        `UPDATE deployments
            SET generation = 4, observed_generation = 4, lease_fence = 4, updated_at = now()
          WHERE id = $1`,
        [ids.deployment],
      );
      await target.query(
        `INSERT INTO worker_auth_challenges (
           id, creator_id, installation_id, deployment_id, deployment_generation,
           state, issued_at, expires_at, consumed_at
         ) VALUES (
           $1, $2, $3, $4, 4, 'CONSUMED',
           statement_timestamp(), statement_timestamp() + interval '1 hour', statement_timestamp()
         )`,
        [replacement.challenge, ids.creator, ids.worker, ids.deployment],
      );
      await target.query(
        `INSERT INTO worker_gateway_sessions (
           id, creator_id, installation_id, challenge_id, connection_id,
           registration_digest, state, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', now() + interval '1 hour')`,
        [
          replacement.session,
          ids.creator,
          ids.worker,
          replacement.challenge,
          replacement.connection,
          digest('e'),
        ],
      );
      await target.query(
        `INSERT INTO worker_leases (
           id, deployment_id, creator_id, worker_id, connection_id, fence, state, expires_at
         ) VALUES ($1, $2, $3, $4, $5, 4, 'ACTIVE', now() + interval '1 hour')`,
        [replacement.lease, ids.deployment, ids.creator, ids.worker, replacement.connection],
      );
      await target.query(
        `INSERT INTO worker_gateway_outbound_frames (
           session_id, creator_id, sequence, message_id, canonical_digest, envelope_type,
           delivery_contract_version, broker_command_id, broker_target_worker_id,
           broker_deployment_id, claim_session_id, claim_connection_id,
           current_delivery_lease_id, current_delivery_fence
         ) VALUES (
           $1, $2, 0, $3, $4, 'conversation.open',
           1, $3, $5, $6, $1, $7, $8, 4
         )`,
        [
          replacement.session,
          ids.creator,
          commandId,
          digest('f'),
          ids.worker,
          ids.deployment,
          replacement.connection,
          replacement.lease,
        ],
      );
      await expect(
        target.query(
          `SELECT count(*)::text AS deliveries,
                  count(DISTINCT message_id)::text AS stable_ids
             FROM worker_gateway_outbound_frames
            WHERE broker_command_id = $1`,
          [commandId],
        ),
      ).resolves.toMatchObject({ rows: [{ deliveries: '2', stable_ids: '1' }] });
      await expect(
        target.query(
          `INSERT INTO worker_gateway_outbound_frames (
             session_id, creator_id, sequence, message_id, canonical_digest, envelope_type,
             delivery_contract_version, broker_command_id, broker_target_worker_id,
             broker_deployment_id, claim_session_id, claim_connection_id,
             current_delivery_lease_id, current_delivery_fence
           ) VALUES (
             $1, $2, 1, $3, $4, 'conversation.open',
             1, $3, $5, $6, $1, $7, $8, 4
           )`,
          [
            replacement.session,
            ids.creator,
            commandId,
            digest('1'),
            ids.worker,
            ids.deployment,
            replacement.connection,
            replacement.lease,
          ],
        ),
      ).rejects.toMatchObject({ code: '23505' });

      // Two independent authorities exercise both sides of the Version SECURITY
      // lock order. The first holds the Deployment advisory while SECURITY owns
      // version_control; create-open must return 40001 and release zero writes.
      // The second holds advisory + Version SHARE first; create-open commits,
      // then the non-victim SECURITY update fences that newly opened authority.
      const lockFixtures = [4, 5].map((marker) => ({
        marker: String(marker),
        agent: randomUUID(),
        grant: randomUUID(),
        version: randomUUID(),
        deployment: randomUUID(),
        worker: randomUUID(),
        challenge: randomUUID(),
        session: randomUUID(),
        connection: randomUUID(),
        lease: randomUUID(),
      }));
      for (const fixture of lockFixtures) {
        await target.query(
          `INSERT INTO agents (id, creator_id, public_slug, name)
           VALUES ($1, $2, $3, '0018 lock-order Agent')`,
          [fixture.agent, ids.creator, `lock-${fixture.agent.slice(0, 8)}`],
        );
        await target.query(
          `INSERT INTO agent_access_grants (
             id, agent_id, creator_id, consumer_subject_id
           ) VALUES ($1, $2, $3, $4)`,
          [fixture.grant, fixture.agent, ids.creator, ids.consumer],
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
             '0.147.0-alpha.6.5', $10, $11
           )`,
          [
            fixture.version,
            fixture.agent,
            ids.creator,
            digest('7'),
            ids.snapshot,
            digest('a'),
            digest('b'),
            digest('c'),
            digest('d'),
            `sha256:${digest('e')}`,
            `sha256:${digest('f')}`,
          ],
        );
        await target.query(
          `INSERT INTO agent_version_controls (version_id, creator_id) VALUES ($1, $2)`,
          [fixture.version, ids.creator],
        );
        await target.query(
          `INSERT INTO deployments (
             id, agent_id, creator_id, environment, desired_version_id
           ) VALUES ($1, $2, $3, 'TEST', $4)`,
          [fixture.deployment, fixture.agent, ids.creator, fixture.version],
        );
        await target.query(
          `INSERT INTO worker_installations (
             id, creator_id, installation_key_id, device_public_key,
             worker_version, protocol_versions, capabilities
           ) VALUES ($1, $2, $3, $4, '0.1.0', '[1]'::jsonb, '{}'::jsonb)`,
          [
            fixture.worker,
            ids.creator,
            `key-${fixture.worker}`,
            Buffer.alloc(65, Number(fixture.marker)),
          ],
        );
        await target.query(
          `UPDATE deployments
              SET desired_state = 'ONLINE', generation = 1,
                  serving_version_id = $2, observed_state = 'ONLINE',
                  observed_worker_id = $3, observed_generation = 1,
                  lease_fence = 1, updated_at = now()
            WHERE id = $1`,
          [fixture.deployment, fixture.version, fixture.worker],
        );
        await target.query(
          `INSERT INTO worker_auth_challenges (
             id, creator_id, installation_id, deployment_id, deployment_generation,
             state, issued_at, expires_at, consumed_at
           ) VALUES (
             $1, $2, $3, $4, 1, 'CONSUMED',
             statement_timestamp(), statement_timestamp() + interval '1 hour',
             statement_timestamp()
           )`,
          [fixture.challenge, ids.creator, fixture.worker, fixture.deployment],
        );
        await target.query(
          `INSERT INTO worker_gateway_sessions (
             id, creator_id, installation_id, challenge_id, connection_id,
             registration_digest, state, expires_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', now() + interval '1 hour')`,
          [
            fixture.session,
            ids.creator,
            fixture.worker,
            fixture.challenge,
            fixture.connection,
            digest(fixture.marker),
          ],
        );
        await target.query(
          `INSERT INTO worker_leases (
             id, deployment_id, creator_id, worker_id, connection_id, fence, state, expires_at
           ) VALUES ($1, $2, $3, $4, $5, 1, 'ACTIVE', now() + interval '1 hour')`,
          [fixture.lease, fixture.deployment, ids.creator, fixture.worker, fixture.connection],
        );
      }

      const opener = new Client({ connectionString: childDatabaseUrl(databaseName) });
      const security = new Client({ connectionString: childDatabaseUrl(databaseName) });
      await Promise.all([opener.connect(), security.connect()]);
      const securityPid = (await security.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]?.pid;
      if (!securityPid) throw new Error('security backend PID is missing');

      const lockDeployment = (client: Client, fixture: (typeof lockFixtures)[number]) =>
        client.query(
          `SELECT pg_advisory_xact_lock(
             hashtextextended('combo.gateway.deployment/v1:' || $1::text || ':' || $2::text, 0)
           )`,
          [ids.creator, fixture.deployment],
        );
      const setConsumerContext = async (client: Client) => {
        await client.query('SET LOCAL ROLE combo_agent_consumer_api');
        await client.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creator]);
        await client.query(`SELECT set_config('app.consumer_id', $1, true)`, [ids.consumer]);
      };
      const setSecurityContext = async (client: Client) => {
        await client.query('SET LOCAL ROLE combo_agent_api');
        await client.query(`SELECT set_config('app.creator_id', $1, true)`, [ids.creator]);
      };
      const createUnderLock = (
        client: Client,
        fixture: (typeof lockFixtures)[number],
        idempotencyKey: string,
      ) =>
        client.query<{ open_command_id: string }>(
          `SELECT open_command_id
             FROM creator_agent_create_opening_conversation_v2(
               $1, $2, $3, $4, $5, $6, $7, $8, $9, 1, 3600,
               $10, $11, 7, $12
             )`,
          [
            fixture.agent,
            fixture.deployment,
            fixture.version,
            ids.creator,
            ids.consumer,
            idempotencyKey,
            digest('9'),
            digest('7'),
            fixture.worker,
            `hmac-sha256:${digest('a')}`,
            `lock-key-${fixture.marker}`,
            `kms://creator/version/lock-key-${fixture.marker}@7`,
          ],
        );
      const startSecurityUpdate = (client: Client, fixture: (typeof lockFixtures)[number]) =>
        client.query<{ severity: string }>(
          `UPDATE agent_version_controls
              SET severity = 'SECURITY',
                  reason_code = 'CONCURRENT_SECURITY_TEST',
                  updated_at = clock_timestamp()
            WHERE version_id = $1 AND creator_id = $2
            RETURNING severity`,
          [fixture.version, ids.creator],
        );

      try {
        const securityFirst = lockFixtures[0]!;
        const rejectedIdempotency = randomUUID();
        await opener.query('BEGIN');
        await opener.query(`SET LOCAL lock_timeout = '5s'`);
        await lockDeployment(opener, securityFirst);
        await security.query('BEGIN');
        await security.query(`SET LOCAL lock_timeout = '5s'`);
        await setSecurityContext(security);
        const blockedSecurityUpdate = startSecurityUpdate(security, securityFirst);
        expect(await waitForBackendLock(target, securityPid)).toBe('advisory');
        await setConsumerContext(opener);
        let openFailure: unknown;
        try {
          await createUnderLock(opener, securityFirst, rejectedIdempotency);
        } catch (error) {
          openFailure = error;
        }
        expect(openFailure).toMatchObject({ code: '40001' });
        await opener.query('ROLLBACK');
        await expect(blockedSecurityUpdate).resolves.toMatchObject({
          rows: [{ severity: 'SECURITY' }],
        });
        await security.query('COMMIT');
        await expect(
          target.query(
            `SELECT control.severity, deployment.observed_state,
                    (SELECT count(*)::text
                       FROM agent_conversations
                      WHERE consumer_subject_id = $3 AND idempotency_key = $4) AS conversations,
                    (SELECT count(*)::text
                       FROM broker_outbox AS command
                       JOIN agent_conversations AS conversation
                         ON conversation.id = command.conversation_id
                      WHERE conversation.consumer_subject_id = $3
                        AND conversation.idempotency_key = $4) AS commands
               FROM agent_version_controls AS control
               JOIN deployments AS deployment ON deployment.id = $2
              WHERE control.version_id = $1`,
            [securityFirst.version, securityFirst.deployment, ids.consumer, rejectedIdempotency],
          ),
        ).resolves.toMatchObject({
          rows: [
            {
              severity: 'SECURITY',
              observed_state: 'BLOCKED',
              conversations: '0',
              commands: '0',
            },
          ],
        });

        const openerFirst = lockFixtures[1]!;
        const createdIdempotency = randomUUID();
        await opener.query('BEGIN');
        await opener.query(`SET LOCAL lock_timeout = '5s'`);
        await lockDeployment(opener, openerFirst);
        await opener.query(
          `SELECT 1
             FROM agent_version_controls
            WHERE version_id = $1 AND creator_id = $2
            FOR SHARE`,
          [openerFirst.version, ids.creator],
        );
        await setConsumerContext(opener);
        await security.query('BEGIN');
        await security.query(`SET LOCAL lock_timeout = '5s'`);
        await setSecurityContext(security);
        const waitingSecurityUpdate = startSecurityUpdate(security, openerFirst);
        await waitForBackendLock(target, securityPid);
        const opened = await createUnderLock(opener, openerFirst, createdIdempotency);
        expect(opened.rows[0]?.open_command_id).toBeTypeOf('string');
        await opener.query('COMMIT');
        await expect(waitingSecurityUpdate).resolves.toMatchObject({
          rows: [{ severity: 'SECURITY' }],
        });
        await security.query('COMMIT');
        await expect(
          target.query(
            `SELECT control.severity, deployment.observed_state,
                    count(DISTINCT conversation.id)::text AS conversations,
                    count(command.command_id)::text AS commands
               FROM agent_version_controls AS control
               JOIN deployments AS deployment ON deployment.id = $2
               LEFT JOIN agent_conversations AS conversation
                 ON conversation.deployment_id = deployment.id
                AND conversation.consumer_subject_id = $3
                AND conversation.idempotency_key = $4
               LEFT JOIN broker_outbox AS command
                 ON command.conversation_id = conversation.id
              WHERE control.version_id = $1
              GROUP BY control.severity, deployment.observed_state`,
            [openerFirst.version, openerFirst.deployment, ids.consumer, createdIdempotency],
          ),
        ).resolves.toMatchObject({
          rows: [
            {
              severity: 'SECURITY',
              observed_state: 'BLOCKED',
              conversations: '1',
              commands: '1',
            },
          ],
        });
      } finally {
        await opener.query('ROLLBACK').catch(() => undefined);
        await security.query('ROLLBACK').catch(() => undefined);
        await Promise.all([opener.end(), security.end()]);
      }
    } finally {
      await target?.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS "${apiMemberRole}"`);
      await admin.end();
    }
  }, 120_000);
});
