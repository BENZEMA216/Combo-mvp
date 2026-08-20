import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  resolve(directory, '..', 'migrations', '0025_creator_agent_prepared_fact_admission.sql'),
  'utf8',
);

describe('0025 Creator Agent prepared fact admission migration', () => {
  it('locks every cutover writer before the zero-legacy gate and authority replacement', () => {
    const lock = sql.indexOf('LOCK TABLE public.agent_invocations,');
    const helper = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.creator_agent_worker_prepared_fact_digest_v1(',
    );
    const legacy = sql.indexOf('DO $prepared_fact_zero_legacy$');
    const admission = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.creator_agent_project_prepared_fact_v1(',
    );
    const trigger = sql.lastIndexOf(
      'CREATE OR REPLACE FUNCTION public.enforce_creator_agent_worker_invocation_fact()',
    );

    expect(lock).toBeGreaterThanOrEqual(0);
    expect(helper).toBeGreaterThan(lock);
    expect(legacy).toBeGreaterThan(helper);
    expect(admission).toBeGreaterThan(legacy);
    expect(trigger).toBeGreaterThan(admission);
    const locked = sql.slice(lock, helper);
    for (const relation of [
      'public.agent_invocations',
      'public.agent_invocation_events',
      'public.broker_outbox',
      'public.creator_agent_journal_integrity_alerts',
    ]) {
      expect(locked).toContain(relation);
    }
    expect(locked).toContain('IN SHARE ROW EXCLUSIVE MODE');
  });

  it('freezes the private prepared-fact JCS recipe and golden digest', () => {
    const helperStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.creator_agent_worker_prepared_fact_digest_v1(',
    );
    const helperEnd = sql.indexOf('REVOKE ALL ON FUNCTION', helperStart);
    const helperSql = sql.slice(helperStart, helperEnd);

    const keys = [
      'agentVersionDigest',
      'executionCapabilityDigest',
      'fence',
      'invocationId',
      'leaseId',
      'prepareCommandId',
      'protocol',
      'requestDigest',
      'schemaVersion',
      'snapshotDigest',
      'sourceEventId',
      'type',
    ];
    const offsets = keys.map((key) => helperSql.indexOf(`"${key}"`));
    expect(offsets.every((offset) => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
    expect(helperSql).toContain('\',"schemaVersion":1\'');
    expect(helperSql).toContain('pg_catalog.to_jsonb(input_fence::text)::text');
    expect(helperSql).toContain('public.digest(');
    expect(helperSql).toContain("'sha256'");
    expect(helperSql).toContain('IMMUTABLE');
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.creator_agent_worker_prepared_fact_digest_v1\([\s\S]*?\) FROM PUBLIC;/u,
    );

    // Cross-language golden: the same scalar values produce this protocol JCS SHA-256.
    expect(sql).toContain('combo.worker-invocation-fact/1');
    expect('4bfcb4a52338b8b786ff28a488bc6dd45f408092533f5d08b9f17e50da31405c').toMatch(
      /^[a-f0-9]{64}$/u,
    );
  });

  it('gates Broker and cleared context before the global source lock and tenant derivation', () => {
    const body = sql.indexOf('AS $project_prepared$');
    const session = sql.indexOf("session_user <> 'combo_agent_broker'", body);
    const creatorContext = sql.indexOf("current_setting('app.creator_id', true)", session);
    const clearedConsumer = sql.indexOf("current_setting('app.consumer_id', true)", creatorContext);
    const sourceLock = sql.indexOf('pg_advisory_xact_lock', clearedConsumer);
    const incomingLock = sql.indexOf('FOR UPDATE OF invocation, conversation', sourceLock);
    const setConsumer = sql.indexOf("pg_catalog.set_config(\n    'app.consumer_id'", incomingLock);
    const globalRead = sql.indexOf(
      'event.source_event_id = input_source_event_id::text',
      setConsumer,
    );
    const freshLeaseRead = sql.indexOf('FROM public.worker_leases AS lease', globalRead);
    const freshCommandRead = sql.indexOf('FROM public.broker_outbox AS command', freshLeaseRead);

    expect(body).toBeGreaterThanOrEqual(0);
    expect(session).toBeGreaterThan(body);
    expect(creatorContext).toBeGreaterThan(session);
    expect(clearedConsumer).toBeGreaterThan(creatorContext);
    expect(sourceLock).toBeGreaterThan(clearedConsumer);
    expect(incomingLock).toBeGreaterThan(sourceLock);
    expect(setConsumer).toBeGreaterThan(incomingLock);
    expect(globalRead).toBeGreaterThan(setConsumer);
    expect(freshLeaseRead).toBeGreaterThan(globalRead);
    expect(freshCommandRead).toBeGreaterThan(freshLeaseRead);
    expect(sql).toContain("'combo.creator-agent-worker-source/1:'");
    expect(sql).toContain('invocation.assigned_worker_id = input_installation_id');
  });

  it('validates the exact fact digest, command, lease, and immutable authority', () => {
    expect(sql).toContain('input_source_event_id IS DISTINCT FROM input_prepare_command_id');
    expect(sql).toContain('recomputed_fact_digest IS DISTINCT FROM input_fact_digest');
    expect(sql).toContain('lease.deployment_id = incoming.deployment_id');
    expect(sql).toContain('lease.worker_id = input_installation_id');
    expect(sql).toContain("command.command_type IS DISTINCT FROM 'invocation.prepare'");
    expect(sql).toContain('command.predecessor_command_id IS NOT NULL');
    expect(sql).toContain(
      'incoming.agent_version_digest IS DISTINCT FROM input_agent_version_digest',
    );
    expect(sql).toContain('incoming.snapshot_digest IS DISTINCT FROM input_snapshot_digest');
    expect(sql).toContain('incoming.request_digest IS DISTINCT FROM input_request_digest');
    expect(sql).toContain(
      'incoming.execution_capability_digest IS DISTINCT FROM\n            input_execution_capability_digest',
    );
    expect(sql).toContain("incoming_command.state NOT IN ('SENT', 'EXPIRED')");
    expect(sql).toContain('incoming_command.attempt_count < 1');
  });

  it('returns only the seven fixed outcomes and low-sensitivity alert reference', () => {
    const returnsStart = sql.indexOf('RETURNS TABLE (');
    const returnsEnd = sql.indexOf('SECURITY DEFINER', returnsStart);
    const returnsSql = sql.slice(returnsStart, returnsEnd);
    expect(returnsSql).toBe(
      'RETURNS TABLE (outcome text, alert_id uuid, alert_replayed boolean)\n',
    );
    for (const outcome of [
      'ADMITTED',
      'EXACT',
      'SECURITY_BLOCKED',
      'TERMINAL',
      'UNAVAILABLE',
      'AUTHORITY_REJECTED',
      'INVARIANT_FAILED',
    ]) {
      expect(sql).toContain(`'${outcome}'::text`);
    }
  });

  it('hashes full existing and received identities without mutable time or order fields', () => {
    const identityStart = sql.indexOf("'domain', 'combo:vnext:worker-prepared-event-identity:v1'");
    const identityEnd = sql.indexOf('IF existing_identity = received_identity', identityStart);
    const identitySql = sql.slice(identityStart, identityEnd);
    for (const field of [
      'creatorId',
      'consumerId',
      'conversationId',
      'invocationId',
      'agentVersionId',
      'snapshotId',
      'deploymentId',
      'installationId',
      'executionCapabilityId',
      'source',
      'sourceEventId',
      'eventType',
      'payload',
      'brokerCommandId',
      'fact',
      'factDigest',
    ]) {
      expect(identitySql).toContain(`'${field}'`);
    }
    expect(identitySql).not.toMatch(/occurred|recorded|journalSeq|attemptCount|expiresAt|ackedAt/u);
    expect(sql).toContain("'domain', 'combo:vnext:worker-source-identity:v1'");
    expect(sql).toContain("'SOURCE_EVENT_CONFLICT'");
    expect(sql).toContain("'WORKER'");
  });

  it('owns exactly the prepared mutations and rolls them back before race reclassification', () => {
    const mutation = sql.indexOf('UPDATE public.agent_invocations AS invocation');
    const event = sql.indexOf('INSERT INTO public.agent_invocation_events', mutation);
    const ack = sql.indexOf('UPDATE public.broker_outbox AS command', event);
    const catchRace = sql.indexOf('EXCEPTION WHEN unique_violation', ack);
    const retry = sql.indexOf('CONTINUE classify_or_admit', catchRace);

    expect(mutation).toBeGreaterThanOrEqual(0);
    expect(event).toBeGreaterThan(mutation);
    expect(ack).toBeGreaterThan(event);
    expect(catchRace).toBeGreaterThan(ack);
    expect(retry).toBeGreaterThan(catchRace);
    const admissionBody = sql.slice(
      sql.indexOf('AS $project_prepared$'),
      sql.indexOf('$project_prepared$ LANGUAGE plpgsql;'),
    );
    expect(admissionBody).not.toContain("'invocation.start'");
    expect(admissionBody).not.toContain("'START_DISPATCH_UNKNOWN'");
    expect(admissionBody).not.toContain("'late-prepared:'");
  });

  it('cuts off only old prepared INSERT and leaves 0020 started/terminal rules intact', () => {
    const triggerStart = sql.lastIndexOf(
      'CREATE OR REPLACE FUNCTION public.enforce_creator_agent_worker_invocation_fact()',
    );
    const triggerSql = sql.slice(triggerStart);
    expect(triggerSql).toContain("NEW.event_type = 'invocation.persisted'");
    expect(triggerSql).toContain("session_user <> 'combo_agent_broker'");
    expect(triggerSql).toContain('current_user = session_user');
    expect(triggerSql).toContain('current_user IS DISTINCT FROM prepared_admission_owner');
    expect(triggerSql).toContain('invocation.persisted requires prepared fact admission authority');
    expect(triggerSql).toContain("'invocation.started'");
    expect(triggerSql).toContain("'invocation.succeeded', 'invocation.failed'");
    expect(triggerSql).toContain(
      'Worker Invocation failed fact requires a confirmed stable failure code',
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.creator_agent_project_prepared_fact_v1\([\s\S]*?\) TO combo_agent_broker;/u,
    );
    expect(sql).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.creator_agent_project_prepared_fact_v1\([\s\S]*?\) TO combo_agent_reconciler/u,
    );
    expect(sql).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[\s\S]*creator_agent_journal_integrity_alerts/iu,
    );
    expect(sql).not.toMatch(
      /GRANT EXECUTE[\s\S]*creator_agent_record_journal_integrity_alert_v1/iu,
    );
  });
});
