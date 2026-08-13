import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  resolve(directory, '..', 'migrations', '0012_creator_hosted_agent_vnext.sql'),
  'utf8',
);

const TABLES = [
  'snapshot_uploads',
  'context_snapshots',
  'agents',
  'agent_versions',
  'agent_version_controls',
  'deployments',
  'worker_installations',
  'worker_leases',
  'agent_conversations',
  'agent_messages',
  'agent_invocations',
  'agent_invocation_events',
  'broker_outbox',
  'consumer_event_streams',
  'consumer_event_outbox',
] as const;

const APPLICATION_ROLES = [
  'combo_agent_api',
  'combo_agent_broker',
  'combo_agent_reconciler',
] as const;

describe('0012 Creator-hosted Agent VNext migration', () => {
  it('creates the complete PostgreSQL authority model', () => {
    for (const table of TABLES) expect(sql, table).toContain(`CREATE TABLE ${table} (`);
    expect(sql.match(/CREATE TABLE /g)).toHaveLength(TABLES.length);
  });

  it('freezes Snapshot and AgentVersion content-addressed identities', () => {
    expect(sql).toContain(
      'uq_context_snapshots_creator_digest UNIQUE (creator_id, snapshot_digest)',
    );
    expect(sql).toContain('uq_agent_versions_agent_ordinal UNIQUE (agent_id, ordinal)');
    expect(sql).toContain('uq_agent_versions_agent_digest UNIQUE (agent_id, version_digest)');
    expect(sql).toContain('CREATE TRIGGER context_snapshots_immutable');
    expect(sql).toContain('CREATE TRIGGER snapshot_uploads_transition');
    expect(sql).toContain('terminal snapshot upload is immutable');
    expect(sql).toContain('CREATE TRIGGER agent_versions_immutable');
    expect(sql).toContain('CREATE TRIGGER agents_transition');
    expect(sql).toContain('CREATE TRIGGER agent_version_controls_transition');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON context_snapshots');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON agent_versions');
    expect(sql).toContain("codex_runtime_artifact_digest ~ '^sha256:[a-f0-9]{64}$'");
  });

  it('uses composite Creator bindings on every cross-tenant relationship', () => {
    for (const constraint of [
      'fk_agent_versions_agent_creator',
      'fk_agent_versions_snapshot_creator',
      'fk_deployments_desired_version',
      'fk_deployments_serving_version',
      'fk_worker_leases_deployment_creator',
      'fk_worker_leases_worker_creator',
      'fk_agent_conversations_deployment_agent_creator',
      'fk_agent_conversations_version_agent_creator',
      'fk_agent_messages_conversation_tenant',
      'fk_agent_invocations_conversation_tenant',
      'fk_agent_invocations_conversation_version',
      'fk_agent_invocations_lease_binding',
      'fk_agent_invocation_events_invocation_tenant',
      'fk_broker_outbox_invocation_tenant',
      'fk_consumer_event_streams_conversation_owner',
      'fk_consumer_event_outbox_conversation_owner',
      'fk_consumer_event_outbox_invocation_owner',
      'fk_consumer_event_outbox_source_event',
    ]) {
      expect(sql, constraint).toContain(`CONSTRAINT ${constraint}`);
    }
  });

  it('enforces one active Lease and one non-terminal Invocation per Conversation', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX uq_worker_leases_deployment_active[\s\S]+WHERE state = 'ACTIVE'/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX uq_agent_invocations_conversation_wip[\s\S]+WHERE state NOT IN \('SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN', 'EXPIRED'\)/,
    );
    expect(sql).toContain('uq_agent_invocations_execution_capability');
    expect(sql).toContain('uq_agent_invocations_conversation_client');
    expect(sql).toContain('uq_worker_leases_binding UNIQUE (id, creator_id, worker_id, fence)');
    expect(sql).toContain('uq_agent_versions_execution_binding');
    expect(sql).toContain('CREATE TRIGGER deployments_transition');
    expect(sql).toContain('CREATE TRIGGER worker_leases_transition');
    expect(sql).toContain('deployment generation and lease fence are monotonic');
    expect(sql).toContain('terminal worker lease is immutable');
    expect(sql).toContain('CREATE TRIGGER agent_invocations_transition');
    expect(sql).toContain(
      "WHEN 'PERSISTED' THEN NEW.state IN ('STARTING', 'CANCEL_REQUESTED', 'RECONCILING')",
    );
    expect(sql).toContain('reconciliation_started_at timestamptz');
    expect(sql).toContain('reconciliation_reason    text');
    expect(sql).toContain('creator_agent_reconciliation_is_exhausted(');
    expect(sql).toContain("input_started_at + interval '300 seconds'");
    expect(sql).toContain('invocation reconciliation binding is immutable once set');
    expect(sql).toContain('uncertain invocation requires exhausted reconciliation deadline');
    expect(sql).toContain('CREATE TRIGGER worker_installations_transition');
    expect(sql).toContain('CREATE TRIGGER agent_conversations_transition');
    expect(sql).toContain('terminal invocation is immutable');
  });

  it('keeps chat plaintext out of PostgreSQL and binds message AEAD metadata', () => {
    for (const column of [
      'content_algorithm',
      'content_key_id',
      'content_nonce',
      'content_ciphertext',
      'content_auth_tag',
      'content_cipher_digest',
      'content_digest',
      'content_aad_version',
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain("content_algorithm = 'aes-256-gcm/v1'");
    expect(sql).toContain('octet_length(content_nonce) = 12');
    expect(sql).toContain('octet_length(content_auth_tag) = 16');
    expect(sql).toContain('uq_agent_messages_aead_nonce UNIQUE (content_key_id, content_nonce)');
    expect(sql).not.toMatch(/\bcontent\s+(?:text|jsonb)\b/iu);
    expect(sql).not.toMatch(/\bprompt\s+(?:text|jsonb)\b/iu);
    expect(sql).not.toMatch(/\banswer\s+(?:text|jsonb)\b/iu);
  });

  it('makes Events append-only, tenant-bound, strictly sequenced, and payload constrained', () => {
    expect(sql).toContain('CREATE TRIGGER agent_invocation_events_sequence');
    expect(sql).toContain('FOR UPDATE;');
    expect(sql).toContain('NEW.journal_seq <> expected_seq');
    expect(sql).toContain('invocation journal is terminal');
    expect(sql).toContain("NEW.payload->>'state' IS DISTINCT FROM invocation_state");
    expect(sql).toContain('CREATE TRIGGER agent_invocation_events_immutable');
    expect(sql).toContain('uq_agent_invocation_events_invocation_seq');
    expect(sql).toContain('uq_agent_invocation_events_source_id');
    expect(sql).toContain('uq_agent_invocation_events_reconciliation');
    expect(sql).toContain("'invocation.reconciling'");
    expect(sql).toContain("input_payload->>'reason' IN (");
    expect(sql).toContain('creator_agent_event_payload_is_allowed(event_type, payload)');
    expect(sql).toContain("input_payload->>'state' = 'SUCCEEDED'");
    expect(sql).toContain("input_payload->>'messageId'");
    expect(sql).toContain("input_payload->>'resultDigest'");
    expect(sql).not.toContain('payload ?| ARRAY[');
  });

  it('forces RLS on every tenant table and requires transaction-local identities', () => {
    for (const table of TABLES) {
      expect(sql, `${table} enable`).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql, `${table} force`).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }
    expect(sql).toContain("current_setting('app.creator_id', true)");
    expect(sql).toContain("current_setting('app.consumer_id', true)");
    expect(sql).toContain('CREATE POLICY agent_conversations_select');
    expect(sql).toContain('CREATE POLICY agent_conversations_insert');
    expect(sql).toContain('CREATE POLICY agent_invocations_update');
    expect(sql).toContain('CREATE POLICY agent_invocation_events_insert');
    expect(sql).toContain('CREATE POLICY consumer_event_outbox_select');
    expect(sql).toContain('CREATE POLICY consumer_event_outbox_insert');
    expect(sql).toContain(
      "creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid\n    AND consumer_subject_id",
    );
  });

  it('creates isolated non-bypass service roles without granting legacy services the new tables', () => {
    for (const role of [...APPLICATION_ROLES, 'combo_agent_maintenance']) {
      expect(sql).toContain(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER`);
      expect(sql).toContain(`ALTER ROLE ${role} NOLOGIN NOSUPERUSER`);
    }
    expect(sql).toContain('NOBYPASSRLS');
    const grants = [...sql.matchAll(/GRANT[\s\S]*?TO (combo_[a-z_]+);/g)].map((match) => match[1]);
    expect(grants).not.toContain('combo_api');
    expect(grants).not.toContain('combo_worker');
    expect(grants).not.toContain('combo_runtime');
    expect(grants).not.toContain('combo_agent_maintenance');
  });

  it('keeps the Outbox relational and bounded instead of persisting command bodies', () => {
    expect(sql).toContain('CREATE TABLE broker_outbox (');
    expect(sql).toContain('uq_broker_outbox');
    expect(sql).toContain('idx_broker_outbox_dispatch');
    const brokerOutboxDefinition = /CREATE TABLE broker_outbox \(([\s\S]*?)\n\);/u.exec(sql)?.[1];
    expect(brokerOutboxDefinition).toBeDefined();
    expect(brokerOutboxDefinition).not.toMatch(/\bpayload\b/u);
    expect(sql).toContain('attempt_count BETWEEN 0 AND 100');
    expect(sql).toContain('expires_at > created_at');
    expect(sql).toContain('CREATE TRIGGER broker_outbox_transition');
    expect(sql).toContain('terminal broker outbox command is immutable');
  });

  it('persists a separate Consumer replay Outbox with a durable cursor and strict payload', () => {
    expect(sql).toContain('CREATE TABLE consumer_event_streams (');
    expect(sql).toContain('CREATE TABLE consumer_event_outbox (');
    expect(sql).toContain('cursor           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY');
    expect(sql).toContain('uq_consumer_event_outbox_owner_source');
    expect(sql).toContain('uq_consumer_event_outbox_owner_dedupe');
    expect(sql).toContain('source_event_id  bigint      NOT NULL');
    expect(sql).toContain("event_type = 'invocation.terminal'");
    expect(sql).toContain('uq_agent_invocation_events_terminal_binding');
    expect(sql).toContain('uq_agent_invocation_events_id_invocation');
    expect(sql).toContain('idx_consumer_event_outbox_publish');
    expect(sql).toContain('idx_consumer_event_outbox_replay');
    expect(sql).toContain("state IN ('PENDING', 'PUBLISHED')");
    expect(sql).toContain("now() + interval '7 days'");
    expect(sql).toContain("retained_until = created_at + interval '7 days'");
    expect(sql).toContain(
      "state = 'PUBLISHED' AND published_at IS NOT NULL AND next_attempt_at IS NULL",
    );
    expect(sql).toContain(
      "state = 'PENDING' AND published_at IS NULL AND next_attempt_at IS NOT NULL",
    );
    expect(sql).toContain('NEW.retained_until IS DISTINCT FROM OLD.retained_until');
    expect(sql).toContain('creator_agent_event_payload_is_allowed(event_type, payload)');
    expect(sql).toContain('CREATE TRIGGER consumer_event_streams_transition');
    expect(sql).toContain('CREATE TRIGGER consumer_event_outbox_transition');
    expect(sql).toContain('published consumer event is immutable');
  });
});
