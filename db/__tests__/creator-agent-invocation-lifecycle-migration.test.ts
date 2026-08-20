import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  resolve(directory, '..', 'migrations', '0016_creator_agent_invocation_lifecycle.sql'),
  'utf8',
);

describe('0016 Creator Agent Invocation lifecycle migration', () => {
  it('is append-only schema evolution and leaves legacy facts nullable', () => {
    expect(sql).not.toContain('CREATE TABLE ');
    expect(sql).toContain('ALTER TABLE agent_invocations');
    expect(sql).toContain('ADD COLUMN execution_capability_digest text');
    expect(sql).toContain('ADD COLUMN execution_capability_expires_at timestamptz');
    expect(sql).toContain('ADD COLUMN execution_capability_revoked_at timestamptz');
    expect(sql).toContain('CONSTRAINT ck_agent_invocations_execution_capability_deadline');
    expect(sql).toContain("execution_capability_expires_at <= deadline_at + interval '30 seconds'");
    expect(sql).toContain('ALTER TABLE agent_invocation_events');
    expect(sql).toContain('ADD COLUMN source_fact_digest text');
    expect(sql).toContain('ADD COLUMN broker_command_id uuid');
    expect(sql).not.toMatch(/ADD COLUMN source_fact_digest text\s+NOT NULL/u);
  });

  it('binds prepare and start commands to one exact tenant execution authority', () => {
    for (const constraint of [
      'uq_agent_invocations_execution_authority',
      'uq_agent_conversations_deployment_binding',
      'uq_worker_leases_deployment_binding',
      'fk_broker_outbox_invocation_authority',
      'fk_broker_outbox_conversation_deployment',
      'fk_broker_outbox_lease_deployment',
      'fk_broker_outbox_predecessor_command',
      'uq_broker_outbox_invocation_event_binding',
      'fk_agent_invocation_events_broker_command',
    ]) {
      expect(sql, constraint).toContain(`CONSTRAINT ${constraint}`);
    }
    expect(sql).toContain("command_type = 'invocation.prepare'");
    expect(sql).toContain("command_type = 'invocation.start'");
    expect(sql).toContain('predecessor_command_id <> command_id');
    expect(sql).toContain('CREATE UNIQUE INDEX uq_broker_outbox_invocation_start');
    expect(sql).toContain("WHERE command_type = 'invocation.start'");
    expect(sql).toContain('COMMENT ON COLUMN broker_outbox.command_id');
    expect(sql).toContain('Stable Broker envelope.messageId');
    expect(sql).toContain('cross-connection retry MUST reuse this exact UUID');
  });

  it('permits one exact legacy prepare fill but freezes every durable command binding', () => {
    expect(sql).toContain('exact_legacy_prepare_binding :=');
    expect(sql).toContain("OLD.command_type = 'invocation.prepare'");
    expect(sql).toContain("OLD.state = 'PENDING'");
    expect(sql).toContain('OLD.execution_capability_digest IS NULL');
    expect(sql).toContain('NEW.execution_capability_digest IS NOT NULL');
    expect(sql).toContain('broker outbox execution authority is immutable');
    expect(sql).toContain('terminal broker outbox command is immutable');
  });

  it('requires canonical fact identity for every new WORKER lifecycle/terminal event', () => {
    expect(sql).toContain('CREATE TRIGGER agent_invocation_events_worker_fact');
    expect(sql).toContain("NEW.source = 'WORKER'");
    expect(sql).toContain("NEW.event_type IN ('invocation.persisted', 'invocation.started')");
    expect(sql).toContain('NEW.source_fact_digest IS NULL OR NEW.broker_command_id IS NULL');
    expect(sql).toContain("NEW.event_type = 'invocation.succeeded'");
    expect(sql).toMatch(/NEW\.source_fact_digest IS NULL\s+OR NEW\.broker_command_id IS NOT NULL/u);
    expect(sql).toContain('NEW.source_event_id <> NEW.broker_command_id::text');
    expect(sql).toContain("WHEN 'invocation.persisted' THEN 'invocation.prepare'");
    expect(sql).toContain("WHEN 'invocation.started' THEN 'invocation.start'");
    expect(sql).toContain('NEW.source_event_id <> NEW.invocation_id::text');
    expect(sql).toContain('CREATE UNIQUE INDEX uq_agent_invocation_events_worker_lifecycle_fact');
    expect(sql).toContain("WHERE source = 'WORKER'");
    expect(sql).toContain("source_fact_digest ~ '^[a-f0-9]{64}$'");
  });

  it('keeps capability authority immutable and exposes only narrow column updates', () => {
    expect(sql).toContain('CREATE TRIGGER agent_invocations_capability_authority');
    expect(sql).toContain('invocation execution capability digest is immutable once set');
    expect(sql).toContain('invocation execution capability deadline is immutable once set');
    expect(sql).toContain('invocation execution capability revocation is immutable once set');
    expect(sql).toContain('invocation execution capability authority is incomplete');
    expect(sql).toContain('ON agent_invocations TO combo_agent_broker, combo_agent_reconciler');
    expect(sql).toContain('reconciliation_reason,');
    expect(sql).toContain('reconciliation_started_at');
    expect(sql).toMatch(
      /GRANT UPDATE \(\s*conversation_id,\s*deployment_id,\s*assignment_lease_id,\s*assignment_fence,\s*execution_capability_id,\s*execution_capability_digest\s*\) ON broker_outbox TO combo_agent_broker;/u,
    );
    expect(sql).not.toMatch(/GRANT UPDATE ON agent_invocations/u);
    expect(sql).not.toMatch(/GRANT UPDATE ON broker_outbox/u);
  });

  it('removes API table INSERT and admits only the three initial request records', () => {
    expect(sql).toContain(
      'REVOKE INSERT ON agent_invocations, broker_outbox, agent_invocation_events',
    );
    expect(sql).toContain('CREATE TRIGGER agent_invocations_api_insert_authority');
    expect(sql).toContain('CREATE TRIGGER broker_outbox_api_insert_authority');
    expect(sql).toContain('CREATE TRIGGER agent_invocation_events_api_insert_authority');
    expect(sql).toContain("NEW.state <> 'ACCEPTED'");
    expect(sql).toContain("NEW.command_type <> 'invocation.prepare'");
    expect(sql).toContain("NEW.event_type <> 'invocation.accepted'");
    expect(sql).toContain("NEW.source <> 'API'");
    expect(sql).toContain('NEW.source_fact_digest IS NOT NULL');
    expect(sql).toContain('NEW.broker_command_id IS NOT NULL');
    expect(sql).toContain("pg_catalog.pg_has_role(current_user, 'combo_agent_api', 'MEMBER')");
    expect(sql).toMatch(
      /GRANT INSERT \(\s*id, conversation_id, creator_id, consumer_subject_id, agent_version_id,[\s\S]*\) ON agent_invocations TO combo_agent_api;/u,
    );
    expect(sql).toMatch(
      /GRANT INSERT \(\s*command_id, creator_id, target_worker_id, invocation_id, consumer_subject_id,[\s\S]*\) ON broker_outbox TO combo_agent_api;/u,
    );
    expect(sql).toMatch(
      /GRANT INSERT \(\s*invocation_id, creator_id, consumer_subject_id, journal_seq, source,[\s\S]*\) ON agent_invocation_events TO combo_agent_api;/u,
    );
  });

  it('removes legacy API Invocation UPDATE and narrows Message insertion to exact chains', () => {
    expect(sql).toMatch(
      /REVOKE UPDATE \(state, cancel_requested_at, terminal_at, error_code\)\s+ON agent_invocations FROM combo_agent_api;/u,
    );
    expect(sql).toContain(
      'REVOKE INSERT ON agent_messages FROM combo_agent_api, combo_agent_reconciler;',
    );
    expect(sql).toMatch(
      /GRANT INSERT \(\s*id, conversation_id, creator_id, consumer_subject_id, turn_no, role,[\s\S]*\) ON agent_messages TO combo_agent_api;/u,
    );
    expect(sql).toContain('CREATE TRIGGER agent_messages_insert_authority');
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER agent_messages_exact_chain');
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(sql).toContain("NEW.role <> 'USER'");
    expect(sql).toContain("NEW.role <> 'ASSISTANT'");
    expect(sql).toContain("accepted_event.event_type = 'invocation.accepted'");
    expect(sql).toContain("terminal_event.event_type = 'invocation.succeeded'");
    expect(sql).toContain("terminal_outbox.event_type = 'invocation.terminal'");
    expect(sql).toContain('terminal_stream.latest_cursor >= terminal_outbox.cursor');
    expect(sql).toContain("pg_catalog.pg_has_role(current_user, 'combo_agent_broker', 'MEMBER')");
  });

  it('linearizes capability issuance and SECURITY revoke under the Deployment fence', () => {
    expect(sql).toContain("'combo.gateway.deployment/v1:'");
    expect(sql).toContain('pg_catalog.pg_advisory_xact_lock(');
    expect(sql).toContain('invocation execution capability lost Deployment authority under lock');
    expect(sql).toMatch(
      /JOIN public\.agent_version_controls AS version_control[\s\S]*version_control\.availability = 'ACTIVE'[\s\S]*version_control\.severity = 'NORMAL'/u,
    );
    expect(sql).not.toMatch(/COALESCE\(version_control\.availability, 'ACTIVE'\)/u);
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION creator_agent_security_revoke_deployment_capabilities(',
    );
    expect(sql).toContain("current_setting('app.creator_id', true)");
    expect(sql).toContain('UPDATE public.agent_invocations AS invocation');
    expect(sql).toMatch(
      /SET execution_capability_revoked_at\s*=\s*GREATEST\(clock_timestamp\(\), invocation\.created_at\)/u,
    );
    expect(sql).toContain('conversation.deployment_id = input_deployment_id');
    expect(sql).toContain('GET DIAGNOSTICS revoked_count = ROW_COUNT');
    expect(sql).toContain(
      'CREATE TRIGGER agent_version_controls_invocation_capability_security_cascade',
    );
    expect(sql).toContain('PERFORM public.creator_agent_security_revoke_deployment_capabilities(');
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION creator_agent_security_revoke_deployment_capabilities\(uuid, uuid\)\s+TO combo_agent_broker, combo_agent_reconciler;/u,
    );
    expect(sql).toContain('DO $invocation_authority_definer_owner_gate$');
    expect(sql).toContain('role.rolsuper OR role.rolbypassrls');
    expect(sql).toContain('requires a SUPERUSER or BYPASSRLS owner');
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION enforce_creator_agent_event_sequence\(\)[\s\S]*SECURITY DEFINER/u,
    );
    expect(sql).toContain('Invocation Event sequence requires exact tenant authority');
    for (const signature of [
      'enforce_creator_agent_invocation_capability_authority()',
      'creator_agent_security_revoke_deployment_capabilities(uuid,uuid)',
      'creator_agent_cascade_invocation_capability_security_revocation()',
      'enforce_creator_agent_event_sequence()',
    ]) {
      expect(sql).toContain(`'${signature}'`);
    }
  });

  it('preserves a security-late started fact without projecting acceptable execution', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION creator_agent_event_payload_is_allowed(');
    expect(sql).toContain(
      `input_payload IN ('{"state":"RUNNING"}'::jsonb, '{"state":"RECONCILING"}'::jsonb)`,
    );
    expect(sql).toContain("NEW.event_type IN ('invocation.persisted', 'invocation.started')");
  });

  it('stores only identifier, digest, deadline and revocation metadata', () => {
    expect(sql).not.toMatch(
      /^\s+(prompt|answer|ciphertext|raw_frame|signature|token|credential|file_path)\s+/imu,
    );
    expect(sql).not.toContain('execution_capability jsonb');
    expect(sql).not.toContain('source_fact jsonb');
  });
});
