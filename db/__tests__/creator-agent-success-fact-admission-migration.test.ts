import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  resolve(directory, '..', 'migrations', '0028_creator_agent_success_fact_admission.sql'),
  'utf8',
);

const section = (start: string, end: string): string => {
  const from = sql.indexOf(start);
  const to = sql.indexOf(end, from);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return sql.slice(from, to);
};

describe('0028 Creator Agent succeeded fact admission migration', () => {
  it('locks and rejects every legacy succeeded terminal before adding authority', () => {
    const lock = sql.indexOf('LOCK TABLE public.agent_invocations,');
    const gate = sql.indexOf('DO $success_fact_zero_legacy$');
    const column = sql.indexOf('ADD COLUMN source_local_result_cipher_digest');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(lock);
    expect(column).toBeGreaterThan(gate);
    for (const relation of [
      'public.agent_invocations',
      'public.agent_invocation_events',
      'public.agent_conversations',
      'public.agent_messages',
      'public.consumer_event_outbox',
      'public.consumer_event_streams',
      'public.creator_agent_journal_integrity_alerts',
    ]) {
      expect(sql.slice(lock, gate)).toContain(relation);
    }
    expect(sql).toContain('0028 requires zero legacy succeeded terminals');
    expect(sql).toContain('ck_agent_invocation_events_success_local_cipher_digest');
  });

  it('creates private same-transaction preflights and append-only permanent receipts', () => {
    const pending = section(
      'CREATE TABLE public.creator_agent_success_seal_preflights',
      'CREATE TABLE public.creator_agent_succeeded_terminal_receipts',
    );
    for (const column of [
      'transaction_id',
      'installation_id',
      'agent_version_digest',
      'snapshot_digest',
      'execution_capability_id',
      'execution_capability_digest',
      'lease_id',
      'fence',
      'assistant_message_id',
      'local_result_cipher_digest',
    ]) {
      expect(pending).toContain(column);
    }
    const receipt = section(
      'CREATE TABLE public.creator_agent_succeeded_terminal_receipts',
      'CREATE TRIGGER creator_agent_succeeded_terminal_receipts_immutable',
    );
    expect(receipt).not.toMatch(/jsonb|ciphertext|nonce|auth_tag/iu);
    expect(sql).toContain('creator_agent_succeeded_terminal_receipts_immutable');
    expect(sql).toContain('creator_agent_succeeded_terminal_receipts_no_truncate');
    expect(sql).toContain(
      'ALTER TABLE public.creator_agent_success_seal_preflights FORCE ROW LEVEL SECURITY',
    );
    expect(sql).toContain(
      'ALTER TABLE public.creator_agent_succeeded_terminal_receipts FORCE ROW LEVEL SECURITY',
    );
    expect(sql).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[\s\S]*creator_agent_succeeded_terminal_receipts/iu,
    );
  });

  it('freezes success fact, Consumer payload, and dedupe JCS recipes with exact goldens', () => {
    const successFact = {
      agentVersionDigest: 'a'.repeat(64),
      executionCapabilityDigest: 'c'.repeat(64),
      fence: '7',
      invocationId: '0198f00d-5000-7000-8000-000000000013',
      leaseId: '0198f00d-5000-7000-8000-000000000015',
      localResultCipherDigest: 'd'.repeat(64),
      protocol: 'combo.worker-invocation-fact/1',
      resultDigest: `hmac-sha256:${'e'.repeat(64)}`,
      runtimeThreadId: 'thread-golden',
      runtimeTurnId: 'turn-golden',
      schemaVersion: 1,
      snapshotDigest: 'b'.repeat(64),
      sourceEventId: '0198f00d-5000-7000-8000-000000000013',
      startedFactDigest: 'f'.repeat(64),
      type: 'invocation.succeeded',
    };
    const terminalPayload = {
      assistantMessageId: '0198f00d-5000-7000-8000-000000000016',
      conversationId: '0198f00d-5000-7000-8000-000000000012',
      errorCode: null,
      invocationId: '0198f00d-5000-7000-8000-000000000013',
      occurredAt: '2026-08-20T08:00:10.123Z',
      protocol: 'combo.consumer-event-outbox/1',
      resultDigest: `hmac-sha256:${'e'.repeat(64)}`,
      schemaVersion: 1,
      terminalState: 'SUCCEEDED',
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
    expect(digest(successFact)).toBe(
      '18e36805cffcec4d475163ac96bfd465fce6ede158b1af1e7e12378ed8ddece9',
    );
    expect(digest(terminalPayload)).toBe(
      'b80f18d6fa8afacd61f1dda54b374d363c231fba012aede12664b8911d47c632',
    );
    expect(digest(dedupe)).toBe('f80d5d425897b0e6a8668e1faaa20ec3c9bfa4ed253d8e6e1f4dc8d7452e0d9d');
    for (const helper of [
      'creator_agent_worker_success_fact_digest_v1',
      'creator_agent_success_consumer_payload_digest_v1',
      'creator_agent_success_consumer_dedupe_key_v1',
    ]) {
      expect(sql).toContain(`CREATE OR REPLACE FUNCTION public.${helper}(`);
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${helper}\\(`, 'u'));
    }
    const helper = section('AS $success_fact_digest$', '$success_fact_digest$;');
    const offsets = Object.keys(successFact).map((key) => helper.indexOf(`"${key}"`));
    expect(offsets.every((offset) => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
  });

  it('freezes the preflight and finalize signatures and exact return columns', () => {
    const preflight = section(
      'CREATE OR REPLACE FUNCTION public.creator_agent_preflight_success_fact_v1(',
      'AS $success_preflight$',
    );
    const finalize = section(
      'CREATE OR REPLACE FUNCTION public.creator_agent_finalize_success_fact_v1(',
      'AS $success_finalize$',
    );
    expect(preflight.match(/input_[a-z_]+\s+(?:uuid|text|integer|bigint)/gu) ?? []).toHaveLength(
      18,
    );
    expect(finalize.match(/input_[a-z_]+\s+(?:uuid|text|integer|bytea)/gu) ?? []).toHaveLength(14);
    for (const column of [
      'outcome text',
      'seal_token uuid',
      'assistant_message_id uuid',
      'aad_schema_version integer',
      'aad_owner_id uuid',
      'aad_conversation_id uuid',
      'aad_role text',
      'result_digest text',
      'consumer_event_cursor bigint',
      'alert_id uuid',
      'alert_replayed boolean',
    ])
      expect(preflight).toContain(column);
    for (const column of [
      'assistant_message_appended boolean',
      'invocation_succeeded boolean',
      'succeeded_event_appended boolean',
      'consumer_event_appended boolean',
      'consumer_stream_advanced boolean',
      'terminal_receipt_appended boolean',
      'conversation_idled boolean',
      'preflight_consumed boolean',
    ])
      expect(finalize).toContain(column);
  });

  it('orders preflight authentication, canonical input, source lock, tenant lock, and classification', () => {
    const body = section('AS $success_preflight$', '$success_preflight$ LANGUAGE plpgsql;');
    const session = body.indexOf("session_user <> 'combo_agent_broker'");
    const cleared = body.indexOf("current_setting('app.consumer_id', true)", session);
    const canonical = body.indexOf('expected_fact_digest :=', cleared);
    const sourceLock = body.indexOf('pg_advisory_xact_lock', canonical);
    const incoming = body.indexOf('FOR UPDATE OF invocation, conversation', sourceLock);
    const consumer = body.indexOf("set_config('app.consumer_id'", incoming);
    const global = body.indexOf('event.source_event_id = input_source_event_id::text', consumer);
    const pending = body.indexOf(
      'INSERT INTO public.creator_agent_success_seal_preflights',
      global,
    );
    expect(session).toBeGreaterThanOrEqual(0);
    expect(cleared).toBeGreaterThan(session);
    expect(canonical).toBeGreaterThan(cleared);
    expect(sourceLock).toBeGreaterThan(canonical);
    expect(incoming).toBeGreaterThan(sourceLock);
    expect(consumer).toBeGreaterThan(incoming);
    expect(global).toBeGreaterThan(consumer);
    expect(pending).toBeGreaterThan(global);
    expect(body).toContain('creator_agent_worker_started_fact_digest_v1');
    expect(body).toContain('creator_agent_worker_failed_fact_digest_v1');
    expect(body).toContain('retained_payload IS DISTINCT FROM terminal_payload');
    expect(body).toContain('start_command.assignment_lease_id AS start_command_lease_id');
    expect(body).toContain('start_command.assignment_fence AS start_command_fence');
    expect(body).not.toContain('start_command.lease_id AS start_command_lease_id');
    expect(body).not.toContain('start_command.fence AS start_command_fence');
  });

  it('makes finalize consume the intent only after final authority and the complete terminal chain', () => {
    const body = section('AS $success_finalize$', '$success_finalize$ LANGUAGE plpgsql;');
    const pending = body.indexOf('FOR UPDATE;');
    const mismatch = body.indexOf(
      'input_verified_result_digest IS DISTINCT FROM pending.result_digest',
    );
    const crypto = body.indexOf("input_algorithm IS DISTINCT FROM 'aes-256-gcm/v1'");
    const finalClock = body.indexOf('execution_capability_expires_at <= clock_timestamp()', crypto);
    const message = body.indexOf('INSERT INTO public.agent_messages', finalClock);
    const projection = body.indexOf("SET state = 'SUCCEEDED'", message);
    const event = body.indexOf("'invocation.succeeded'", projection);
    const outbox = body.indexOf('INSERT INTO public.consumer_event_outbox', event);
    const stream = body.indexOf('INSERT INTO public.consumer_event_streams', outbox);
    const receipt = body.indexOf(
      'INSERT INTO public.creator_agent_succeeded_terminal_receipts',
      stream,
    );
    const idle = body.indexOf("SET state = 'IDLE'", receipt);
    const consume = body.indexOf('DELETE FROM public.creator_agent_success_seal_preflights', idle);
    expect(pending).toBeGreaterThanOrEqual(0);
    expect(mismatch).toBeGreaterThan(pending);
    expect(crypto).toBeGreaterThan(mismatch);
    expect(finalClock).toBeGreaterThan(crypto);
    expect(message).toBeGreaterThan(finalClock);
    expect(projection).toBeGreaterThan(message);
    expect(event).toBeGreaterThan(projection);
    expect(outbox).toBeGreaterThan(event);
    expect(stream).toBeGreaterThan(outbox);
    expect(receipt).toBeGreaterThan(stream);
    expect(idle).toBeGreaterThan(receipt);
    expect(consume).toBeGreaterThan(idle);
    expect(body).toContain('input_content_digest = pending.result_digest');
    expect(body).toContain('input_cipher_digest = pending.local_result_cipher_digest');
  });

  it('returns the strict SECURITY_BLOCKED null shape after deleting a mismatched preflight', () => {
    const body = section('AS $success_finalize$', '$success_finalize$ LANGUAGE plpgsql;');
    const mismatch = body.indexOf(
      'input_verified_result_digest IS DISTINCT FROM pending.result_digest',
    );
    const security = body.indexOf("RETURN QUERY SELECT 'SECURITY_BLOCKED'::text", mismatch);
    const fragment = body.slice(mismatch, security + 520);
    expect(fragment).toContain('DELETE FROM public.creator_agent_success_seal_preflights');
    expect(fragment).toContain('NULL::boolean, NULL::boolean, durable_alert_id');
    expect(fragment).not.toContain("'SECURITY_BLOCKED'::text, pending.assistant_message_id");
  });

  it('cuts over Message, succeeded Event, and succeeded Outbox with deferred companions', () => {
    expect(sql).toContain('agent_invocation_events_00_succeeded_write_authority');
    expect(sql).not.toContain('CREATE TRIGGER agent_invocation_events_succeeded_write_authority');
    expect(sql).toContain('agent_messages_assistant_write_authority');
    expect(sql).toContain('consumer_event_outbox_succeeded_insert_authority');
    expect(sql).toContain('creator_agent_success_seal_preflight_consumed');
    expect(sql).toContain('agent_invocations_succeeded_terminal_companion');
    expect(sql.match(/DEFERRABLE INITIALLY DEFERRED/gu)).toHaveLength(2);
    expect(sql).toContain(
      'Success admission and companions require trusted SECURITY DEFINER owners',
    );
    expect(sql).not.toContain('enforce_creator_agent_success_outbox_authority');
  });

  it('authenticates and canonicalizes failed v2 before any global succeeded read', () => {
    const body = section('AS $failed_v2$', '$failed_v2$ LANGUAGE plpgsql;');
    const session = body.indexOf("session_user <> 'combo_agent_broker'");
    const canonical = body.indexOf('creator_agent_worker_failed_fact_digest_v1', session);
    const sourceLock = body.indexOf('pg_advisory_xact_lock', canonical);
    const incoming = body.indexOf('FOR UPDATE OF invocation, conversation', sourceLock);
    const global = body.indexOf("event.event_type = 'invocation.succeeded'", incoming);
    const full = body.indexOf('creator_agent_worker_success_fact_digest_v1', global);
    const alert = body.indexOf("'SOURCE_EVENT_CONFLICT', 'WORKER'", full);
    const delegate = body.indexOf('creator_agent_project_failed_fact_v1(', alert);
    expect(session).toBeGreaterThanOrEqual(0);
    expect(canonical).toBeGreaterThan(session);
    expect(sourceLock).toBeGreaterThan(canonical);
    expect(incoming).toBeGreaterThan(sourceLock);
    expect(global).toBeGreaterThan(incoming);
    expect(body.slice(incoming, global)).not.toContain(
      'incoming.agent_version_digest IS DISTINCT FROM input_agent_version_digest',
    );
    expect(body.slice(incoming, global)).not.toContain(
      'incoming.assignment_lease_id IS DISTINCT FROM input_lease_id',
    );
    expect(full).toBeGreaterThan(global);
    expect(alert).toBeGreaterThan(full);
    expect(delegate).toBeGreaterThan(alert);
    expect(body).toContain('retained_payload IS DISTINCT FROM terminal_payload');
    expect(body).toContain('start_command.assignment_lease_id AS started_command_lease_id');
    expect(body).toContain('start_command.assignment_fence AS started_command_fence');
    expect(body).not.toContain('start_command.lease_id AS started_command_lease_id');
    expect(body).not.toContain('start_command.fence AS started_command_fence');
    expect(sql).toContain('REVOKE EXECUTE ON FUNCTION public.creator_agent_project_failed_fact_v1');
    expect(sql).toContain('Failed v2 admission requires a trusted SECURITY DEFINER owner');
  });
});
