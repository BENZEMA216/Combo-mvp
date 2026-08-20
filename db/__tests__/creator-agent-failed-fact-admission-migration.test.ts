import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  resolve(directory, '..', 'migrations', '0027_creator_agent_failed_fact_admission.sql'),
  'utf8',
);

describe('0027 Creator Agent failed fact admission migration', () => {
  it('locks the full terminal chain and fails closed on legacy confirmed failures', () => {
    const lock = sql.indexOf('LOCK TABLE public.agent_invocations,');
    const gate = sql.indexOf('DO $failed_fact_zero_legacy$');
    const table = sql.indexOf('CREATE TABLE public.creator_agent_failed_terminal_receipts');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(lock);
    expect(table).toBeGreaterThan(gate);
    for (const relation of [
      'public.agent_invocations',
      'public.agent_invocation_events',
      'public.agent_conversations',
      'public.consumer_event_outbox',
      'public.consumer_event_streams',
      'public.creator_agent_journal_integrity_alerts',
    ]) {
      expect(sql.slice(lock, gate)).toContain(relation);
    }
    expect(sql).toContain('0027 requires zero legacy confirmed Worker failed terminals');
  });

  it('creates a private append-only retention-proof receipt', () => {
    const tableStart = sql.indexOf('CREATE TABLE public.creator_agent_failed_terminal_receipts');
    const tableEnd = sql.indexOf('CREATE TRIGGER', tableStart);
    const table = sql.slice(tableStart, tableEnd);
    for (const column of [
      'invocation_id',
      'creator_id',
      'consumer_subject_id',
      'terminal_event_id',
      'consumer_event_cursor',
      'payload_digest',
      'dedupe_key',
      'recorded_at',
    ]) {
      expect(table).toContain(column);
    }
    expect(table).not.toMatch(/jsonb|payload\s+json|prompt|answer|ciphertext/iu);
    expect(sql).toContain('creator_agent_failed_terminal_receipts_immutable');
    expect(sql).toContain('creator_agent_failed_terminal_receipts_no_truncate');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[\s\S]*creator_agent_failed_terminal_receipts/iu,
    );
  });

  it('freezes failed fact, Consumer payload, and dedupe JCS recipes with goldens', () => {
    const failedFact = {
      agentVersionDigest: 'a'.repeat(64),
      errorCode: 'TURN_FAILED',
      executionCapabilityDigest: 'c'.repeat(64),
      fence: '7',
      invocationId: '0198f00d-5000-7000-8000-000000000013',
      leaseId: '0198f00d-5000-7000-8000-000000000015',
      protocol: 'combo.worker-invocation-fact/1',
      schemaVersion: 1,
      snapshotDigest: 'b'.repeat(64),
      sourceEventId: '0198f00d-5000-7000-8000-000000000013',
      type: 'invocation.failed',
    };
    const terminalPayload = {
      assistantMessageId: null,
      conversationId: '0198f00d-5000-7000-8000-000000000012',
      errorCode: 'TURN_FAILED',
      invocationId: '0198f00d-5000-7000-8000-000000000013',
      occurredAt: '2026-08-20T08:00:10.123Z',
      protocol: 'combo.consumer-event-outbox/1',
      resultDigest: null,
      schemaVersion: 1,
      terminalState: 'FAILED',
      type: 'invocation.terminal',
    };
    const dedupe = {
      eventType: 'invocation.terminal',
      ownerId: '0198f00d-5000-7000-8000-000000000011',
      protocol: 'combo.consumer-event-outbox/1',
      sourceEventId: '42',
    };
    const digest = (value: unknown): string =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex');
    expect(digest(failedFact)).toBe(
      '869a68366e876060ce899ebda7da9ac86656230267e95578bb799856e2180173',
    );
    expect(digest(terminalPayload)).toBe(
      '07ef5b866ba609d187a5dc036121c5c816fd927a8ce5e63d0ec0e41402b8fe04',
    );
    expect(digest(dedupe)).toBe('f80d5d425897b0e6a8668e1faaa20ec3c9bfa4ed253d8e6e1f4dc8d7452e0d9d');

    const helperNames = [
      'creator_agent_worker_failed_fact_digest_v1',
      'creator_agent_failed_consumer_payload_digest_v1',
      'creator_agent_failed_consumer_dedupe_key_v1',
    ];
    for (const helper of helperNames) {
      expect(sql).toContain(`CREATE OR REPLACE FUNCTION public.${helper}(`);
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${helper}\\(`, 'u'));
    }
    const failedHelper = sql.slice(
      sql.indexOf('AS $failed_fact_digest$'),
      sql.indexOf('$failed_fact_digest$;', sql.indexOf('AS $failed_fact_digest$')),
    );
    const failedKeys = Object.keys(failedFact);
    const offsets = failedKeys.map((key) => failedHelper.indexOf(`"${key}"`));
    expect(offsets.every((offset) => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
  });

  it('gates Broker/context and global source before incoming authority', () => {
    const body = sql.indexOf('AS $project_failed$');
    const session = sql.indexOf("session_user <> 'combo_agent_broker'", body);
    const creator = sql.indexOf("current_setting('app.creator_id', true)", session);
    const cleared = sql.indexOf("current_setting('app.consumer_id', true)", creator);
    const sourceLock = sql.indexOf('pg_advisory_xact_lock', cleared);
    const incoming = sql.indexOf('FOR UPDATE OF invocation, conversation', sourceLock);
    const setConsumer = sql.indexOf("set_config('app.consumer_id'", incoming);
    const global = sql.indexOf('event.source_event_id = input_source_event_id::text', setConsumer);
    const freshLease = sql.indexOf('FROM public.worker_leases AS lease', global);
    expect(session).toBeGreaterThan(body);
    expect(creator).toBeGreaterThan(session);
    expect(cleared).toBeGreaterThan(creator);
    expect(sourceLock).toBeGreaterThan(cleared);
    expect(incoming).toBeGreaterThan(sourceLock);
    expect(setConsumer).toBeGreaterThan(incoming);
    expect(global).toBeGreaterThan(setConsumer);
    expect(freshLease).toBeGreaterThan(global);
  });

  it('returns only the fixed terminal outcome and mutation metadata', () => {
    const start = sql.indexOf('RETURNS TABLE (');
    const end = sql.indexOf('SECURITY DEFINER', start);
    const returns = sql.slice(start, end);
    for (const column of [
      'outcome text',
      'error_code text',
      'terminal_at timestamptz',
      'consumer_event_cursor bigint',
      'invocation_failed boolean',
      'failed_event_appended boolean',
      'consumer_event_appended boolean',
      'consumer_stream_advanced boolean',
      'terminal_receipt_appended boolean',
      'conversation_idled boolean',
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

  it('owns the complete failed Event, Consumer chain, receipt, and IDLE mutation', () => {
    const bodyStart = sql.indexOf('AS $project_failed$');
    const bodyEnd = sql.indexOf('$project_failed$ LANGUAGE plpgsql;', bodyStart);
    const body = sql.slice(bodyStart, bodyEnd);
    const invocation = body.indexOf("SET state = 'FAILED'");
    const event = body.indexOf("'invocation.failed'", invocation);
    const outbox = body.indexOf('INSERT INTO public.consumer_event_outbox', event);
    const stream = body.indexOf('INSERT INTO public.consumer_event_streams', outbox);
    const receipt = body.indexOf(
      'INSERT INTO public.creator_agent_failed_terminal_receipts',
      stream,
    );
    const conversation = body.indexOf("SET state = 'IDLE'", receipt);
    const raced = body.indexOf('EXCEPTION WHEN unique_violation', conversation);
    expect(invocation).toBeGreaterThanOrEqual(0);
    expect(event).toBeGreaterThan(invocation);
    expect(outbox).toBeGreaterThan(event);
    expect(stream).toBeGreaterThan(outbox);
    expect(receipt).toBeGreaterThan(stream);
    expect(conversation).toBeGreaterThan(receipt);
    expect(raced).toBeGreaterThan(conversation);
    expect(body).not.toContain('agent_messages');
  });

  it('distinguishes full failed reconstruction from generic succeeded source conflict', () => {
    expect(sql).toContain("'domain', 'combo:vnext:worker-failed-event-identity:v1'");
    expect(sql).toContain("'domain', 'combo:vnext:generic-stored-terminal-source-binding:v1'");
    expect(sql).toContain("existing.event_type = 'invocation.succeeded'");
    expect(sql).toContain("'opaqueFactDigest', existing.source_fact_digest");
    expect(sql).toContain("date_trunc('milliseconds', existing.occurred_at)");
    expect(sql).toContain("date_trunc('milliseconds', existing.terminal_at)");
    expect(sql).toContain('existing.occurred_at IS DISTINCT FROM existing.terminal_at');
    expect(sql).toContain("'SOURCE_EVENT_CONFLICT', 'WORKER'");
    expect(sql).toContain('expired_through_cursor < existing.receipt_cursor');
  });

  it('cuts over failed Event and Consumer Outbox while preserving prior phase authorities', () => {
    expect(sql).toContain('creator_agent_project_prepared_fact_v1');
    expect(sql).toContain('creator_agent_project_started_fact_v1');
    expect(sql).toContain('creator_agent_project_failed_fact_v1');
    expect(sql).toContain('invocation.failed requires failed fact admission authority');
    expect(sql).toContain('consumer_event_outbox_failed_insert_authority');
    expect(sql).toContain('failed Consumer terminal requires failed fact admission authority');
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER agent_invocations_confirmed_failed_companion');
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(sql).toContain('Failed companion requires a trusted SECURITY DEFINER owner');
    expect(sql).not.toMatch(
      /GRANT EXECUTE[\s\S]*creator_agent_record_journal_integrity_alert_v1/iu,
    );
  });
});
