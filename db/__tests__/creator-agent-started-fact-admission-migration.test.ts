import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  resolve(directory, '..', 'migrations', '0026_creator_agent_started_fact_admission.sql'),
  'utf8',
);

describe('0026 Creator Agent started fact admission migration', () => {
  it('locks the cutover writers and refuses unreconstructible legacy started facts', () => {
    const lock = sql.indexOf('LOCK TABLE public.agent_invocations,');
    const gate = sql.indexOf('DO $started_fact_zero_legacy$');
    const alter = sql.indexOf('ALTER TABLE public.agent_invocation_events');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(lock);
    expect(alter).toBeGreaterThan(gate);
    for (const relation of [
      'public.agent_invocations',
      'public.agent_invocation_events',
      'public.broker_outbox',
      'public.creator_agent_journal_integrity_alerts',
    ]) {
      expect(sql.slice(lock, gate)).toContain(relation);
    }
    expect(sql).toContain('0026 cannot reconstruct legacy Worker started fact components');
  });

  it('adds closed-world low-sensitivity started component digests', () => {
    expect(sql).toContain('ADD COLUMN source_dispatch_receipt_digest text');
    expect(sql).toContain('ADD COLUMN source_sandbox_attestation_digest text');
    expect(sql).toContain('ck_agent_invocation_events_started_fact_components');
    expect(sql).toContain("WHEN source = 'WORKER' AND event_type = 'invocation.started' THEN");
    const alter = sql.slice(
      sql.indexOf('ALTER TABLE public.agent_invocation_events'),
      sql.indexOf('CREATE OR REPLACE FUNCTION', sql.indexOf('ALTER TABLE')),
    );
    expect(alter.match(/\^sha256:\[a-f0-9\]\{64\}\$/gu)).toHaveLength(2);
  });

  it('freezes the private started-fact JCS key order', () => {
    const start = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.creator_agent_worker_started_fact_digest_v1(',
    );
    const end = sql.indexOf('REVOKE ALL ON FUNCTION', start);
    const helper = sql.slice(start, end);
    const keys = [
      'agentVersionDigest',
      'dispatchReceiptDigest',
      'executionCapabilityDigest',
      'fence',
      'invocationId',
      'leaseId',
      'protocol',
      'runtimeThreadId',
      'runtimeTurnId',
      'sandboxAttestationDigest',
      'schemaVersion',
      'snapshotDigest',
      'sourceEventId',
      'startCommandId',
      'type',
    ];
    const offsets = keys.map((key) => helper.indexOf(`"${key}"`));
    expect(offsets.every((offset) => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
    expect(helper).toContain('IMMUTABLE');
    expect(helper).toContain('pg_catalog.to_jsonb(input_fence::text)::text');
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.creator_agent_worker_started_fact_digest_v1\([\s\S]*?\) FROM PUBLIC;/u,
    );

    const goldenCanonical = JSON.stringify({
      agentVersionDigest: 'a'.repeat(64),
      dispatchReceiptDigest: `sha256:${'d'.repeat(64)}`,
      executionCapabilityDigest: 'c'.repeat(64),
      fence: '7',
      invocationId: '0198f00d-5000-7000-8000-000000000013',
      leaseId: '0198f00d-5000-7000-8000-000000000015',
      protocol: 'combo.worker-invocation-fact/1',
      runtimeThreadId: 'thread-golden',
      runtimeTurnId: 'turn-golden',
      sandboxAttestationDigest: `sha256:${'e'.repeat(64)}`,
      schemaVersion: 1,
      snapshotDigest: 'b'.repeat(64),
      sourceEventId: '0198f00d-5000-7000-8000-000000000016',
      startCommandId: '0198f00d-5000-7000-8000-000000000016',
      type: 'invocation.started',
    });
    expect(createHash('sha256').update(goldenCanonical).digest('hex')).toBe(
      '55355cc2101293379d320db25c1e02961778c7b1341ccfb21a1176c475931836',
    );
  });

  it('gates context and source before tenant derivation and fresh authority reads', () => {
    const body = sql.indexOf('AS $project_started$');
    const session = sql.indexOf("session_user <> 'combo_agent_broker'", body);
    const creator = sql.indexOf("current_setting('app.creator_id', true)", session);
    const cleared = sql.indexOf("current_setting('app.consumer_id', true)", creator);
    const sourceLock = sql.indexOf('pg_advisory_xact_lock', cleared);
    const incoming = sql.indexOf('FOR UPDATE OF invocation, conversation', sourceLock);
    const setConsumer = sql.indexOf("set_config('app.consumer_id'", incoming);
    const global = sql.indexOf('event.source_event_id = input_source_event_id::text', setConsumer);
    const freshLease = sql.indexOf('FROM public.worker_leases AS lease', global);
    const freshCommand = sql.indexOf('FROM public.broker_outbox AS command', freshLease);
    expect(session).toBeGreaterThan(body);
    expect(creator).toBeGreaterThan(session);
    expect(cleared).toBeGreaterThan(creator);
    expect(sourceLock).toBeGreaterThan(cleared);
    expect(incoming).toBeGreaterThan(sourceLock);
    expect(setConsumer).toBeGreaterThan(incoming);
    expect(global).toBeGreaterThan(setConsumer);
    expect(freshLease).toBeGreaterThan(global);
    expect(freshCommand).toBeGreaterThan(freshLease);
    expect(sql).toContain("'combo.creator-agent-worker-source/1:'");
  });

  it('returns the fixed outcome and exact mutation metadata contract', () => {
    const returnsStart = sql.indexOf('RETURNS TABLE (');
    const returnsEnd = sql.indexOf('SECURITY DEFINER', returnsStart);
    const returns = sql.slice(returnsStart, returnsEnd);
    for (const column of [
      'outcome text',
      'projected_state text',
      'started_at timestamptz',
      'entered_starting boolean',
      'reconciliation_root_appended boolean',
      'start_command_acked boolean',
      'alert_id uuid',
      'alert_replayed boolean',
    ]) {
      expect(returns).toContain(column);
    }
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

  it('reconstructs a full immutable existing started identity', () => {
    const identityStart = sql.indexOf("'domain', 'combo:vnext:worker-started-event-identity:v1'");
    const identityEnd = sql.indexOf('IF existing_identity = received_identity', identityStart);
    const identity = sql.slice(identityStart, identityEnd);
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
      'sourceEventId',
      'eventType',
      'payload',
      'brokerCommandId',
      'preparedCommandId',
      'preparedFactDigest',
      'fact',
      'factDigest',
    ]) {
      expect(identity).toContain(`'${field}'`);
    }
    expect(identity).not.toMatch(/journalSeq|recordedAt|expiresAt|attemptCount|ackedAt/u);
    expect(sql).toContain("'SOURCE_EVENT_CONFLICT', 'WORKER'");
  });

  it('owns projection, Event, optional root, and command ACK in one race-safe subtransaction', () => {
    const bodyStart = sql.indexOf('AS $project_started$');
    const bodyEnd = sql.indexOf('$project_started$ LANGUAGE plpgsql;', bodyStart);
    const body = sql.slice(bodyStart, bodyEnd);
    const starting = body.indexOf("SET state = 'STARTING'");
    const running = body.indexOf("SET state = 'RUNNING'", starting);
    const reconciling = body.indexOf("SET state = 'RECONCILING'", running);
    const event = body.indexOf('INSERT INTO public.agent_invocation_events', reconciling);
    const root = body.indexOf("'late-started:' || input_source_event_id::text", event);
    const ack = body.indexOf("SET state = 'ACKED'", root);
    const caught = body.indexOf('EXCEPTION WHEN unique_violation', ack);
    const retry = body.indexOf('CONTINUE classify_or_admit', caught);
    expect(starting).toBeGreaterThanOrEqual(0);
    expect(running).toBeGreaterThan(starting);
    expect(reconciling).toBeGreaterThan(running);
    expect(event).toBeGreaterThan(reconciling);
    expect(root).toBeGreaterThan(event);
    expect(ack).toBeGreaterThan(root);
    expect(caught).toBeGreaterThan(ack);
    expect(retry).toBeGreaterThan(caught);
  });

  it('cuts over started only while preserving prepared and terminal authorities', () => {
    const triggerStart = sql.lastIndexOf(
      'CREATE OR REPLACE FUNCTION public.enforce_creator_agent_worker_invocation_fact()',
    );
    const trigger = sql.slice(triggerStart);
    expect(trigger).toContain("NEW.event_type IN ('invocation.persisted', 'invocation.started')");
    expect(trigger).toContain('creator_agent_project_prepared_fact_v1');
    expect(trigger).toContain('creator_agent_project_started_fact_v1');
    expect(trigger).toContain('current_user = session_user');
    expect(trigger).toContain('current_user IS DISTINCT FROM phase_admission_owner');
    expect(trigger).toContain("'invocation.succeeded', 'invocation.failed'");
    expect(trigger).toContain(
      'Worker Invocation failed fact requires a confirmed stable failure code',
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.creator_agent_project_started_fact_v1\([\s\S]*?\) TO combo_agent_broker;/u,
    );
    expect(sql).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.creator_agent_project_started_fact_v1\([\s\S]*?\) TO combo_agent_reconciler/u,
    );
    expect(sql).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[\s\S]*creator_agent_journal_integrity_alerts/iu,
    );
  });
});
