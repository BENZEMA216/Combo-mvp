import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  resolve(directory, '..', 'migrations', '0017_creator_agent_conversation_ready_fact.sql'),
  'utf8',
);

describe('0017 durable conversation.ready fact authority', () => {
  it('persists every immutable business-fact and original-authority field', () => {
    expect(migration).toContain('CREATE TABLE conversation_ready_fact_receipts (');
    for (const column of [
      'source_event_id',
      'fact_digest',
      'conversation_id',
      'open_command_id',
      'deployment_id',
      'agent_version_id',
      'agent_version_digest',
      'snapshot_id',
      'snapshot_digest',
      'installation_id',
      'original_worker_session_id',
      'original_lease_id',
      'original_connection_id',
      'original_fence',
      'sandbox_instance_id',
      'runtime_thread_id',
      'ready_evidence_digest',
    ]) {
      expect(migration).toContain(column);
    }
    expect(migration).toContain('CHECK (source_event_id = open_command_id)');
    expect(migration).toContain('fk_ready_fact_original_session');
    expect(migration).toContain('fk_ready_fact_original_lease');
    expect(migration).toContain('fk_ready_fact_open_command');
  });

  it('recomputes the canonical protocol digest in exact JCS key order', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION creator_agent_conversation_ready_fact_digest(',
    );
    expect(migration).toContain('public.digest(');
    const orderedKeys = [
      'agentVersionDigest',
      'agentVersionId',
      'conversationId',
      'deploymentId',
      'fence',
      'installationId',
      'leaseId',
      'openCommandId',
      'protocol',
      'readyEvidenceDigest',
      'runtimeThreadId',
      'sandboxInstanceId',
      'schemaVersion',
      'snapshotDigest',
      'sourceEventId',
      'type',
      'workerSessionId',
    ];
    let previousIndex = -1;
    for (const key of orderedKeys) {
      const index = migration.indexOf(`"${key}"`, previousIndex + 1);
      expect(index).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
    expect(migration).toContain('expected_fact_digest IS DISTINCT FROM input_fact_digest');
  });

  it('checks exact replay before live Version authority and never requires original liveness', () => {
    const replayLookup = migration.indexOf(
      'FROM public.conversation_ready_fact_receipts AS receipt',
    );
    const activeVersion = migration.indexOf("version_control.availability = 'ACTIVE'");
    expect(replayLookup).toBeGreaterThan(0);
    expect(activeVersion).toBeGreaterThan(replayLookup);
    expect(migration).toContain("command.state = 'SENT'");
    expect(migration).toContain("conversation.state = 'OPENING'");
    expect(migration).toContain("deployment.desired_state = 'ONLINE'");
    expect(migration).toContain("deployment.observed_state = 'ONLINE'");
    expect(migration).toContain('deployment.serving_version_id = input_agent_version_id');
    expect(migration).toContain('deployment.observed_worker_id = input_installation_id');
    expect(migration).toContain('deployment.observed_generation = deployment.generation');
    expect(migration).toContain('installation.revoked_at IS NULL');
    expect(migration).not.toContain('original_lease.state =');
    expect(migration).not.toContain('original_session.state =');
    expect(migration).not.toContain('original_lease.expires_at >');
    expect(migration).not.toContain('deployment.lease_fence = input_original_fence');
  });

  it('turns a concurrent Version security row lock into a stable whole-transaction retry', () => {
    const replayLookup = migration.indexOf(
      'FROM public.conversation_ready_fact_receipts AS receipt',
    );
    const versionNowait = migration.indexOf('FOR SHARE NOWAIT');
    expect(versionNowait).toBeGreaterThan(replayLookup);
    expect(migration).toMatch(
      /FROM public\.agent_version_controls AS version_control[\s\S]+FOR SHARE NOWAIT;[\s\S]+WHEN lock_not_available THEN[\s\S]+USING ERRCODE = '40001'/u,
    );
    expect(migration).toContain('FOR SHARE OF deployment, installation;');
    expect(migration).not.toContain('FOR SHARE OF deployment, version_control, installation;');
  });

  it('fails closed for partial 0014 receipts and commits receipt, ACK, and IDLE atomically', () => {
    expect(migration).toContain('They cannot be safely promoted');
    expect(migration).toMatch(
      /FROM public\.conversation_ready_receipts AS legacy_receipt[\s\S]+RETURN QUERY SELECT 'REJECTED'::text/u,
    );
    expect(migration).toMatch(
      /INSERT INTO public\.conversation_ready_fact_receipts[\s\S]+UPDATE public\.broker_outbox[\s\S]+UPDATE public\.agent_conversations/u,
    );
    expect(migration).toContain("RETURN QUERY SELECT 'REPLAY'::text");
    expect(migration).toContain("RETURN QUERY SELECT 'APPLIED'::text, 'IDLE'::text");
  });

  it('exposes only the new definer to Broker and FORCE-RLS protects the immutable journal', () => {
    expect(migration).toContain('conversation_ready_fact_receipts_immutable');
    expect(migration).toContain(
      'ALTER TABLE conversation_ready_fact_receipts ENABLE ROW LEVEL SECURITY;',
    );
    expect(migration).toContain(
      'ALTER TABLE conversation_ready_fact_receipts FORCE ROW LEVEL SECURITY;',
    );
    expect(migration).toContain('conversation_ready_fact_definer_owner_gate');
    expect(migration).toContain('procedure.prosecdef AND (role.rolsuper OR role.rolbypassrls)');
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION creator_agent_commit_conversation_ready\([\s\S]+FROM PUBLIC, combo_api/u,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION creator_agent_commit_conversation_ready_fact\([\s\S]+TO combo_agent_broker;/u,
    );
    expect(migration).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[\s\S]+conversation_ready_fact_receipts/u,
    );
  });
});
