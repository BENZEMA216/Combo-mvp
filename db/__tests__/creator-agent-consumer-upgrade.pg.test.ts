import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.CREATOR_AGENT_UPGRADE_PG_TEST === '1' && Boolean(databaseUrl);
const pgDescribe = enabled ? describe : describe.skip;
const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

function digest(marker: string): string {
  return marker.repeat(64);
}

function hmac(marker: string): string {
  return `hmac-sha256:${digest(marker)}`;
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

pgDescribe('0012 -> 0013 -> 0014 -> 0015 -> 0016 Creator Agent persistent upgrade', () => {
  it('preserves legacy commands, Invocations, and Gateway receipts through lifecycle authority', async () => {
    const admin = new Client({ connectionString: databaseUrl });
    const databaseName = `combo_vnext_upgrade_${randomUUID().replaceAll('-', '')}`;
    await admin.connect();
    let target: Client | undefined;
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      target = new Client({ connectionString: databaseConnectionString(databaseName) });
      await target.connect();
      await target.query(`
        CREATE TABLE schema_migrations (
          filename text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      const pre0013 = readdirSync(migrationsDirectory)
        .filter((filename) => /^\d{4}_.+\.sql$/u.test(filename) && filename < '0013_')
        .sort();
      expect(pre0013.at(-1)).toBe('0012_creator_hosted_agent_vnext.sql');
      for (const filename of pre0013) await applyMigration(target, filename);

      const ids = {
        creator: randomUUID(),
        consumer: randomUUID(),
        snapshot: randomUUID(),
        agent: randomUUID(),
        version: randomUUID(),
        deployment: randomUUID(),
        worker: randomUUID(),
        preexistingCommand: randomUUID(),
        idle: randomUUID(),
        closed: randomUUID(),
        lease: randomUUID(),
        connection: randomUUID(),
        challenge: randomUUID(),
        session: randomUUID(),
        frameMessage: randomUUID(),
        runningConversation: randomUUID(),
        terminalConversation: randomUUID(),
        runningUserMessage: randomUUID(),
        terminalUserMessage: randomUUID(),
        terminalAssistantMessage: randomUUID(),
        runningInvocation: randomUUID(),
        terminalInvocation: randomUUID(),
        runningCapability: randomUUID(),
        terminalCapability: randomUUID(),
        pendingPrepare: randomUUID(),
        sentPrepare: randomUUID(),
        ackedCommand: randomUUID(),
      };
      await target.query(
        `INSERT INTO users (id, account)
         VALUES ($1, 'creator-aaaaaaab'), ($2, 'creator-aaaaaaac')`,
        [ids.creator, ids.consumer],
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
          `upgrade/${ids.snapshot}.archive.enc`,
          `upgrade/${ids.snapshot}.manifest.enc`,
          `kms://${ids.snapshot}`,
        ],
      );
      await target.query(
        `INSERT INTO agents (id, creator_id, public_slug, name)
         VALUES ($1, $2, 'upgrade-agent', 'Upgrade Agent')`,
        [ids.agent, ids.creator],
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
        `INSERT INTO deployments (id, agent_id, creator_id, environment, desired_version_id)
         VALUES ($1, $2, $3, 'TEST', $4)`,
        [ids.deployment, ids.agent, ids.creator, ids.version],
      );
      await target.query(
        `INSERT INTO worker_installations (
           id, creator_id, installation_key_id, device_public_key,
           worker_version, protocol_versions, capabilities
         ) VALUES ($1, $2, $3, $4, '0.1.0', '[1]'::jsonb, '{}'::jsonb)`,
        [ids.worker, ids.creator, `upgrade-${ids.worker}`, Buffer.alloc(65, 7)],
      );
      await target.query(
        `INSERT INTO broker_outbox (
           command_id, creator_id, target_worker_id, command_type,
           dedupe_key, state, expires_at
         ) VALUES ($1, $2, $3, 'deployment.prepare', $4, 'PENDING', now() + interval '1 day')`,
        [ids.preexistingCommand, ids.creator, ids.worker, `upgrade-${ids.preexistingCommand}`],
      );
      await target.query(
        `INSERT INTO agent_conversations (
           id, agent_id, deployment_id, agent_version_id, creator_id,
           consumer_subject_id, version_digest, state, expires_at, closed_at
         ) VALUES
           ($1, $3, $4, $5, $6, $7, $8, 'IDLE', now() + interval '1 day', NULL),
           ($2, $3, $4, $5, $6, $7, $8, 'CLOSED', now() + interval '1 day', now())`,
        [
          ids.idle,
          ids.closed,
          ids.agent,
          ids.deployment,
          ids.version,
          ids.creator,
          ids.consumer,
          digest('7'),
        ],
      );

      await applyMigration(target, '0013_creator_agent_consumer_create.sql');

      const rows = await target.query<{
        id: string;
        idempotency_key: string;
        request_digest: string;
        state: string;
      }>(
        `SELECT id, idempotency_key, request_digest, state
           FROM agent_conversations
          ORDER BY state`,
      );
      expect(rows.rows).toHaveLength(2);
      for (const row of rows.rows) {
        expect(row.idempotency_key).toBe(row.id);
        expect(row.request_digest).toMatch(/^[a-f0-9]{64}$/u);
      }
      await expect(
        target.query(`UPDATE agent_conversations SET request_digest = $2 WHERE id = $1`, [
          ids.closed,
          digest('9'),
        ]),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(
        target.query<{ enabled: string }>(
          `SELECT tgenabled AS enabled
             FROM pg_trigger
            WHERE tgrelid = 'agent_conversations'::regclass
              AND tgname = 'agent_conversations_transition'
              AND NOT tgisinternal`,
        ),
      ).resolves.toMatchObject({ rows: [{ enabled: 'O' }] });

      await applyMigration(target, '0014_creator_agent_consumer_open_ready.sql');

      await expect(
        target.query<{
          id: string;
          state: string;
          idempotency_key: string;
          open_commands: string;
        }>(
          `SELECT conversation.id, conversation.state, conversation.idempotency_key,
                  count(command.command_id)::text AS open_commands
             FROM agent_conversations AS conversation
             LEFT JOIN broker_outbox AS command
               ON command.conversation_id = conversation.id
              AND command.command_type = 'conversation.open'
            GROUP BY conversation.id, conversation.state, conversation.idempotency_key
            ORDER BY conversation.state`,
        ),
      ).resolves.toMatchObject({
        rows: [
          { id: ids.closed, state: 'CLOSED', idempotency_key: ids.closed, open_commands: '0' },
          { id: ids.idle, state: 'IDLE', idempotency_key: ids.idle, open_commands: '0' },
        ],
      });
      await expect(
        target.query(
          `SELECT to_regclass('public.conversation_ready_receipts')::text AS receipts,
                  to_regprocedure(
                    'public.creator_agent_commit_conversation_ready(uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid)'
                  )::text AS ready_function`,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            receipts: 'conversation_ready_receipts',
            ready_function:
              'creator_agent_commit_conversation_ready(uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid)',
          },
        ],
      });
      await expect(
        target.query(
          `SELECT command_type, conversation_id, deployment_id,
                  assignment_lease_id, assignment_fence
             FROM broker_outbox
            WHERE command_id = $1`,
          [ids.preexistingCommand],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            command_type: 'deployment.prepare',
            conversation_id: null,
            deployment_id: null,
            assignment_lease_id: null,
            assignment_fence: null,
          },
        ],
      });

      await applyMigration(target, '0015_creator_agent_gateway_authority.sql');

      await expect(
        target.query<{ table_name: string }>(
          `SELECT table_name
             FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = ANY($1::text[])
            ORDER BY table_name`,
          [
            [
              'worker_auth_challenges',
              'worker_auth_security_events',
              'worker_gateway_frame_receipts',
              'worker_gateway_operation_receipts',
              'worker_gateway_outbound_frames',
              'worker_gateway_security_events',
              'worker_gateway_sequence_gaps',
              'worker_gateway_sessions',
            ],
          ],
        ),
      ).resolves.toMatchObject({
        rows: [
          { table_name: 'worker_auth_challenges' },
          { table_name: 'worker_auth_security_events' },
          { table_name: 'worker_gateway_frame_receipts' },
          { table_name: 'worker_gateway_operation_receipts' },
          { table_name: 'worker_gateway_outbound_frames' },
          { table_name: 'worker_gateway_security_events' },
          { table_name: 'worker_gateway_sequence_gaps' },
          { table_name: 'worker_gateway_sessions' },
        ],
      });
      await expect(
        target.query<{ id: string; state: string }>(
          `SELECT id, state
             FROM agent_conversations
            WHERE id = ANY($1::uuid[])
            ORDER BY state`,
          [[ids.idle, ids.closed]],
        ),
      ).resolves.toMatchObject({
        rows: [
          { id: ids.closed, state: 'CLOSED' },
          { id: ids.idle, state: 'IDLE' },
        ],
      });

      await target.query('BEGIN');
      try {
        await target.query(
          `INSERT INTO agent_version_controls (version_id, creator_id)
           VALUES ($1, $2)`,
          [ids.version, ids.creator],
        );
        await target.query(
          `INSERT INTO worker_auth_challenges (
             id, creator_id, installation_id, deployment_id, deployment_generation,
             state, issued_at, expires_at, consumed_at
           ) VALUES (
             $1, $2, $3, $4, 0, 'CONSUMED',
             now(), now() + interval '1 hour', now()
           )`,
          [ids.challenge, ids.creator, ids.worker, ids.deployment],
        );
        await target.query(
          `INSERT INTO worker_gateway_sessions (
             id, creator_id, installation_id, challenge_id, connection_id,
             registration_digest, state, inbound_next_seq, expires_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', 1, now() + interval '1 hour')`,
          [ids.session, ids.creator, ids.worker, ids.challenge, ids.connection, digest('6')],
        );
        await target.query(
          `INSERT INTO worker_leases (
             id, deployment_id, creator_id, worker_id, connection_id, fence, expires_at
           ) VALUES ($1, $2, $3, $4, $5, 1, now() + interval '1 hour')`,
          [ids.lease, ids.deployment, ids.creator, ids.worker, ids.connection],
        );
        await target.query(
          `INSERT INTO agent_conversations (
             id, agent_id, deployment_id, agent_version_id, creator_id,
             consumer_subject_id, idempotency_key, request_digest, version_digest,
             state, assigned_worker_id, expires_at
           ) VALUES
             ($1, $3, $4, $5, $6, $7, gen_uuid_v7(), $8, $9,
              'BUSY', $10, now() + interval '1 hour'),
             ($2, $3, $4, $5, $6, $7, gen_uuid_v7(), $8, $9,
              'IDLE', $10, now() + interval '1 hour')`,
          [
            ids.runningConversation,
            ids.terminalConversation,
            ids.agent,
            ids.deployment,
            ids.version,
            ids.creator,
            ids.consumer,
            digest('5'),
            digest('7'),
            ids.worker,
          ],
        );
        await target.query(
          `INSERT INTO agent_messages (
             id, conversation_id, creator_id, consumer_subject_id, turn_no, role,
             client_message_id, content_algorithm, content_key_id, content_nonce,
             content_ciphertext, content_auth_tag, content_cipher_digest, content_digest,
             content_aad_version, invocation_id
           ) VALUES
             ($1, $4, $6, $7, 1, 'USER', $8, 'aes-256-gcm/v1', $9, $10,
              $11, $12, $13, $14, 1, $15),
             ($2, $5, $6, $7, 1, 'USER', $16, 'aes-256-gcm/v1', $17, $18,
              $19, $20, $21, $22, 1, $23),
             ($3, $5, $6, $7, 1, 'ASSISTANT', NULL, 'aes-256-gcm/v1', $24, $25,
              $26, $27, $28, $29, 1, $23)`,
          [
            ids.runningUserMessage,
            ids.terminalUserMessage,
            ids.terminalAssistantMessage,
            ids.runningConversation,
            ids.terminalConversation,
            ids.creator,
            ids.consumer,
            `upgrade-running-${ids.runningInvocation}`,
            `upgrade-key-${ids.runningUserMessage}`,
            Buffer.alloc(12, 1),
            Buffer.from('running-user'),
            Buffer.alloc(16, 1),
            digest('1'),
            hmac('1'),
            ids.runningInvocation,
            `upgrade-terminal-${ids.terminalInvocation}`,
            `upgrade-key-${ids.terminalUserMessage}`,
            Buffer.alloc(12, 2),
            Buffer.from('terminal-user'),
            Buffer.alloc(16, 2),
            digest('2'),
            hmac('2'),
            ids.terminalInvocation,
            `upgrade-key-${ids.terminalAssistantMessage}`,
            Buffer.alloc(12, 3),
            Buffer.from('terminal-assistant'),
            Buffer.alloc(16, 3),
            digest('3'),
            hmac('3'),
          ],
        );
        await target.query(
          `INSERT INTO agent_invocations (
             id, conversation_id, creator_id, consumer_subject_id, agent_version_id,
             user_message_id, client_message_id, request_digest, state,
             assigned_worker_id, assignment_lease_id, assignment_fence,
             execution_capability_id, deadline_at, runtime_thread_id, runtime_turn_id,
             result_message_id, result_digest, started_at, terminal_at
           ) VALUES
             ($1, $3, $5, $6, $7, $8, $9, $10, 'RUNNING',
              $11, $12, 1, $13, now() + interval '1 hour', 'legacy-thread-running',
              'legacy-turn-running', NULL, NULL, now(), NULL),
             ($2, $4, $5, $6, $7, $14, $15, $16, 'SUCCEEDED',
              $11, $12, 1, $17, now() + interval '1 hour', 'legacy-thread-terminal',
              'legacy-turn-terminal', $18, $19, now(), now())`,
          [
            ids.runningInvocation,
            ids.terminalInvocation,
            ids.runningConversation,
            ids.terminalConversation,
            ids.creator,
            ids.consumer,
            ids.version,
            ids.runningUserMessage,
            `upgrade-running-${ids.runningInvocation}`,
            hmac('4'),
            ids.worker,
            ids.lease,
            ids.runningCapability,
            ids.terminalUserMessage,
            `upgrade-terminal-${ids.terminalInvocation}`,
            hmac('5'),
            ids.terminalCapability,
            ids.terminalAssistantMessage,
            hmac('6'),
          ],
        );
        await target.query(
          `INSERT INTO broker_outbox (
             command_id, creator_id, target_worker_id, invocation_id,
             consumer_subject_id, command_type, dedupe_key, state,
             attempt_count, next_attempt_at, expires_at, acked_at
           ) VALUES
             ($1, $4, $5, $6, $7, 'invocation.prepare', $8, 'PENDING',
              0, now(), now() + interval '1 hour', NULL),
             ($2, $4, $5, $9, $7, 'invocation.prepare', $10, 'SENT',
              1, now(), now() + interval '1 hour', NULL),
             ($3, $4, $5, NULL, NULL, 'deployment.prepare', $11, 'ACKED',
              1, now(), now() + interval '1 hour', now())`,
          [
            ids.pendingPrepare,
            ids.sentPrepare,
            ids.ackedCommand,
            ids.creator,
            ids.worker,
            ids.runningInvocation,
            ids.consumer,
            `upgrade-pending-${ids.pendingPrepare}`,
            ids.terminalInvocation,
            `upgrade-sent-${ids.sentPrepare}`,
            `upgrade-acked-${ids.ackedCommand}`,
          ],
        );
        await target.query(
          `INSERT INTO worker_gateway_operation_receipts (
             creator_id, operation_kind, operation_key, request_digest,
             result_value, result_digest
           ) VALUES ($1, 'SEQUENCE_GAP', $2, $3, 'null'::jsonb, $4)`,
          [ids.creator, `upgrade-gap-${ids.session}`, digest('8'), digest('9')],
        );
        await target.query(
          `INSERT INTO worker_gateway_frame_receipts (
             session_id, creator_id, sequence, message_id, canonical_digest,
             envelope_type, response_frames
           ) VALUES ($1, $2, 0, $3, $4, 'invocation.started', '[]'::jsonb)`,
          [ids.session, ids.creator, ids.frameMessage, digest('a')],
        );
        await target.query('COMMIT');
      } catch (error) {
        await target.query('ROLLBACK');
        throw error;
      }

      for (let run = 1; run <= 2; run += 1) {
        const alreadyApplied = await target.query(
          `SELECT 1 FROM schema_migrations
            WHERE filename = '0016_creator_agent_invocation_lifecycle.sql'`,
        );
        if (alreadyApplied.rowCount === 0) {
          await applyMigration(target, '0016_creator_agent_invocation_lifecycle.sql');
        }
      }

      await expect(
        target.query(
          `SELECT command_id, state, conversation_id, deployment_id,
                  assignment_lease_id, assignment_fence, predecessor_command_id,
                  execution_capability_id, execution_capability_digest
             FROM broker_outbox
            WHERE command_id = ANY($1::uuid[])
            ORDER BY state, command_id`,
          [[ids.pendingPrepare, ids.sentPrepare, ids.ackedCommand]],
        ),
      ).resolves.toMatchObject({
        rows: expect.arrayContaining([
          expect.objectContaining({ command_id: ids.pendingPrepare, state: 'PENDING' }),
          expect.objectContaining({ command_id: ids.sentPrepare, state: 'SENT' }),
          expect.objectContaining({ command_id: ids.ackedCommand, state: 'ACKED' }),
        ]),
      });
      const invocationRows = await target.query<{
        id: string;
        state: string;
        execution_capability_id: string;
        execution_capability_digest: string | null;
        execution_capability_expires_at: Date | null;
        execution_capability_revoked_at: Date | null;
      }>(
        `SELECT id, state, execution_capability_id,
                execution_capability_digest, execution_capability_expires_at,
                execution_capability_revoked_at
           FROM agent_invocations
          WHERE id = ANY($1::uuid[])
          ORDER BY state`,
        [[ids.runningInvocation, ids.terminalInvocation]],
      );
      expect(invocationRows.rows).toEqual([
        {
          id: ids.runningInvocation,
          state: 'RUNNING',
          execution_capability_id: ids.runningCapability,
          execution_capability_digest: null,
          execution_capability_expires_at: null,
          execution_capability_revoked_at: null,
        },
        {
          id: ids.terminalInvocation,
          state: 'SUCCEEDED',
          execution_capability_id: ids.terminalCapability,
          execution_capability_digest: null,
          execution_capability_expires_at: null,
          execution_capability_revoked_at: null,
        },
      ]);
      await expect(
        target.query<{ revoked: string }>(
          `SELECT creator_agent_security_revoke_deployment_capabilities($1, $2)::text AS revoked`,
          [ids.creator, ids.deployment],
        ),
      ).resolves.toMatchObject({ rows: [{ revoked: '1' }] });
      await expect(
        target.query(
          `SELECT id, execution_capability_revoked_at IS NOT NULL AS revoked
             FROM agent_invocations
            WHERE id = ANY($1::uuid[])
            ORDER BY state`,
          [[ids.runningInvocation, ids.terminalInvocation]],
        ),
      ).resolves.toMatchObject({
        rows: [
          { id: ids.runningInvocation, revoked: true },
          { id: ids.terminalInvocation, revoked: false },
        ],
      });
      await expect(
        target.query(
          `SELECT
             (SELECT count(*) FROM worker_gateway_sessions WHERE id = $1)::text AS sessions,
             (SELECT count(*) FROM worker_gateway_operation_receipts
               WHERE creator_id = $2)::text AS operation_receipts,
             (SELECT count(*) FROM worker_gateway_frame_receipts
               WHERE session_id = $1)::text AS frame_receipts`,
          [ids.session, ids.creator],
        ),
      ).resolves.toMatchObject({
        rows: [{ sessions: '1', operation_receipts: '1', frame_receipts: '1' }],
      });
      await expect(
        target.query(
          `UPDATE broker_outbox SET attempt_count = attempt_count + 1 WHERE command_id = $1`,
          [ids.ackedCommand],
        ),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(
        target.query(`SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1`),
      ).resolves.toMatchObject({
        rows: [{ filename: '0016_creator_agent_invocation_lifecycle.sql' }],
      });
      await expect(
        target.query(
          `SELECT count(*)::text AS applied
             FROM schema_migrations
            WHERE filename = '0016_creator_agent_invocation_lifecycle.sql'`,
        ),
      ).resolves.toMatchObject({ rows: [{ applied: '1' }] });
    } finally {
      await target?.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.end();
    }
  }, 120_000);
});
