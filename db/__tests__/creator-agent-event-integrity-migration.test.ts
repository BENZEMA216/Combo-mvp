import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  resolve(directory, '..', 'migrations', '0023_creator_agent_event_integrity.sql'),
  'utf8',
);

describe('0023 Creator Agent Event integrity migration', () => {
  it('locks writers before rejecting non-reconstructible legacy gaps', () => {
    const lock = sql.indexOf('LOCK TABLE public.agent_invocations, public.agent_invocation_events');
    const legacyGate = sql.indexOf('DO $event_integrity_zero_legacy$');
    const schemaMutation = sql.indexOf('ALTER TABLE public.agent_invocation_events');

    expect(lock).toBeGreaterThanOrEqual(0);
    expect(legacyGate).toBeGreaterThan(lock);
    expect(schemaMutation).toBeGreaterThan(legacyGate);
    expect(sql).toContain('IN SHARE ROW EXCLUSIVE MODE');
    expect(sql).toContain('zero RECONCILING projections without an exact root Event');
    expect(sql).toContain('cannot infer a missing late-started reconciliation root Event');
    expect(sql).toContain('cannot infer a missing reconciliation re-entry Event');
    expect(sql).toContain("invocation.state = 'UNCERTAIN'");
    expect(sql).toContain("uncertain.event_type = 'invocation.uncertain'");

    const gateSql = sql.slice(legacyGate, schemaMutation);
    expect(gateSql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/u);
  });

  it('adds one exact at-most-once reconciliation-resumed Event without weakening roots', () => {
    expect(sql).toContain("'invocation.reconciling_resumed'");
    expect(sql).toContain("WHEN 'invocation.reconciling_resumed' THEN");
    expect(sql).toContain("input_payload->>'state' = 'RECONCILING'");
    expect(sql).toContain('uq_agent_invocation_events_reconciling_resumed');
    expect(sql).toMatch(
      /ON public\.agent_invocation_events \(invocation_id, event_type\)[\s\S]*WHERE event_type = 'invocation\.reconciling_resumed'/u,
    );
    expect(sql).not.toMatch(/DROP\s+INDEX\s+uq_agent_invocation_events_reconciliation/iu);
    expect(sql).not.toMatch(/DROP\s+INDEX\s+uq_agent_invocation_events_worker_lifecycle_fact/iu);
    expect(sql).toContain('enforce_creator_agent_reconciling_root_event');
    expect(sql).toContain('enforce_creator_agent_reconciling_resumed_event');
    expect(sql).toContain("session_user NOT IN ('combo_agent_broker', 'combo_agent_reconciler')");
    expect(sql).toContain("session_user <> 'combo_agent_reconciler'");
    expect(sql).toContain("'late-prepared:' || fact.source_event_id");
    expect(sql).toContain("'late-started:' || fact.source_event_id");
    expect(sql).toContain("'resume-reconciliation:' || root_event.source_event_id");
    expect(sql).toContain('started.payload = \'{"state":"RUNNING"}\'::jsonb');
    expect(sql).toContain('NEW.journal_seq IS DISTINCT FROM running_started_event.journal_seq + 1');
    expect(sql).toContain(
      'CREATE CONSTRAINT TRIGGER agent_invocations_reconciliation_event_companion',
    );
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(sql).toContain("IF NEW.state <> 'RECONCILING' THEN");
    expect(sql).toContain("'reason', NEW.reconciliation_reason");
  });

  it('creates a closed low-sensitivity append-only alert relation', () => {
    const tableStart = sql.indexOf('CREATE TABLE public.creator_agent_journal_integrity_alerts');
    const tableEnd = sql.indexOf('CREATE TRIGGER creator_agent_journal_integrity_alerts_immutable');
    expect(tableStart).toBeGreaterThanOrEqual(0);
    expect(tableEnd).toBeGreaterThan(tableStart);
    const tableSql = sql.slice(tableStart, tableEnd);

    for (const column of [
      'invocation_id',
      'creator_id',
      'consumer_subject_id',
      'reason',
      'source',
      'source_event_id_digest',
      'existing_canonical_digest',
      'received_canonical_digest',
      'expected_journal_seq',
      'received_journal_seq',
      'recorded_at',
    ]) {
      expect(tableSql).toContain(column);
    }
    for (const reason of [
      'SOURCE_EVENT_CONFLICT',
      'JOURNAL_ORDER_CONFLICT',
      'PROJECTION_DIGEST_MISMATCH',
    ]) {
      expect(tableSql).toContain(`'${reason}'`);
    }
    expect(tableSql).not.toMatch(/\bjsonb\b/iu);
    expect(tableSql).not.toMatch(/\b(?:payload|prompt|answer|token|path|ciphertext|error)\b/iu);
    expect(tableSql.match(/\^\[a-f0-9\]\{64\}\$/gu)).toHaveLength(3);
    expect(sql).toContain('creator_agent_journal_integrity_alerts_immutable');
    expect(sql).toContain('creator_agent_journal_integrity_alerts_no_truncate');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('uq_creator_agent_journal_integrity_alert_dedupe');
    expect(tableSql).toContain('UNIQUE NULLS NOT DISTINCT');
    expect(tableSql).toContain("WHEN 'JOURNAL_ORDER_CONFLICT' THEN");
  });

  it('exposes only an exact tenant-bound Reconciler definer, never table DML or reads', () => {
    expect(sql).toContain('creator_agent_record_journal_integrity_alert_v1');
    expect(sql).toContain("session_user <> 'combo_agent_reconciler'");
    expect(sql).toContain("current_setting('app.creator_id', true)");
    expect(sql).toContain("current_setting('app.consumer_id', true)");
    expect(sql).toContain(
      'ON CONFLICT ON CONSTRAINT uq_creator_agent_journal_integrity_alert_dedupe',
    );
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = pg_catalog, public');
    expect(sql).toContain('requires SUPERUSER or BYPASSRLS owner');
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.creator_agent_record_journal_integrity_alert_v1\([\s\S]*\) TO combo_agent_reconciler/u,
    );
    expect(sql).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[\s\S]*ON public\.creator_agent_journal_integrity_alerts/iu,
    );
  });
});
