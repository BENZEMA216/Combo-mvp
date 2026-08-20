import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  resolve(directory, '..', 'migrations', '0024_creator_agent_reconciliation_source_admission.sql'),
  'utf8',
);

describe('0024 Creator Agent reconciliation source admission migration', () => {
  it('cuts over all root writers under locks and closes logical-source alias races', () => {
    const lock = sql.indexOf('LOCK TABLE public.agent_invocations,');
    const legacyGate = sql.indexOf('DO $reconciliation_source_zero_legacy$');
    const logicalIndex = sql.indexOf(
      'CREATE UNIQUE INDEX uq_agent_invocation_events_reconciler_logical_source',
    );
    const admission = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.creator_agent_begin_reconciliation_v2(',
    );
    const triggerReplacement = sql.lastIndexOf(
      'CREATE OR REPLACE FUNCTION public.enforce_creator_agent_reconciling_root_event()',
    );

    expect(lock).toBeGreaterThanOrEqual(0);
    expect(legacyGate).toBeGreaterThan(lock);
    expect(logicalIndex).toBeGreaterThan(legacyGate);
    expect(admission).toBeGreaterThan(logicalIndex);
    expect(triggerReplacement).toBeGreaterThan(admission);
    expect(sql.slice(lock, legacyGate)).toContain('public.agent_invocation_events');
    expect(sql.slice(lock, legacyGate)).toContain('public.creator_agent_journal_integrity_alerts');
    expect(sql.slice(lock, legacyGate)).toContain('IN SHARE ROW EXCLUSIVE MODE');
    expect(sql).toContain("pg_catalog.split_part(source_event_id, ':', 2)");
    expect(sql).toContain("'late-prepared:' || input_source_event_id::text");
    expect(sql).toContain("'late-started:' || input_source_event_id::text");
  });

  it('gates authority and tenant context before global source and row locks', () => {
    const bodyStart = sql.indexOf('AS $begin_reconciliation$');
    const sessionGate = sql.indexOf("session_user <> 'combo_agent_reconciler'", bodyStart);
    const creatorContext = sql.indexOf("current_setting('app.creator_id', true)", sessionGate);
    const consumerContext = sql.indexOf("current_setting('app.consumer_id', true)", creatorContext);
    const sourceLock = sql.indexOf('pg_advisory_xact_lock', consumerContext);
    const rowLock = sql.indexOf('FOR UPDATE OF invocation, conversation', sourceLock);
    const globalRead = sql.indexOf('This read is intentionally global', rowLock);

    expect(bodyStart).toBeGreaterThanOrEqual(0);
    expect(sessionGate).toBeGreaterThan(bodyStart);
    expect(creatorContext).toBeGreaterThan(sessionGate);
    expect(consumerContext).toBeGreaterThan(creatorContext);
    expect(sourceLock).toBeGreaterThan(consumerContext);
    expect(rowLock).toBeGreaterThan(sourceLock);
    expect(globalRead).toBeGreaterThan(rowLock);
    expect(sql).toContain("'combo.creator-agent-reconciliation-logical-source/1:'");
    expect(sql).toContain('OR input_reason IS NULL');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = pg_catalog, public');
    expect(sql).toContain('requires SUPERUSER or BYPASSRLS owner');
  });

  it('returns only the closed admission outcomes and no existing identity columns', () => {
    const returnsStart = sql.indexOf('RETURNS TABLE (');
    const returnsEnd = sql.indexOf('SECURITY DEFINER', returnsStart);
    const returnsSql = sql.slice(returnsStart, returnsEnd);

    expect(returnsSql).toContain('outcome text');
    expect(returnsSql).toContain('reconciliation_started_at timestamptz');
    expect(returnsSql).toContain('alert_id uuid');
    expect(returnsSql).toContain('alert_replayed boolean');
    for (const outcome of [
      'ADMITTED',
      'EXACT',
      'SECURITY_BLOCKED',
      'SOURCE_DIFFERENT',
      'TERMINAL',
      'UNAVAILABLE',
      'INVARIANT_FAILED',
    ]) {
      expect(sql).toContain(`'${outcome}'::text`);
    }
    expect(returnsSql).not.toMatch(/creator|consumer|conversation|invocation|payload|reason/iu);
  });

  it('classifies an exact stored root before state-independent reason conflict', () => {
    const rootRead = sql.indexOf("event.event_type = 'invocation.reconciling';");
    const rootValidation = sql.indexOf(
      'root_event.payload IS DISTINCT FROM pg_catalog.jsonb_build_object(',
      rootRead,
    );
    const sourceDifferent = sql.indexOf("'SOURCE_DIFFERENT'::text", rootValidation);
    const reasonConflict = sql.indexOf(
      'incoming.reconciliation_reason IS DISTINCT FROM input_reason',
      sourceDifferent,
    );
    const eligibility = sql.indexOf(
      "incoming.state NOT IN ('PERSISTED', 'STARTING', 'RUNNING', 'CANCEL_REQUESTED')",
      reasonConflict,
    );

    expect(rootRead).toBeGreaterThanOrEqual(0);
    expect(rootValidation).toBeGreaterThan(rootRead);
    expect(sourceDifferent).toBeGreaterThan(rootValidation);
    expect(reasonConflict).toBeGreaterThan(sourceDifferent);
    expect(eligibility).toBeGreaterThan(reasonConflict);
    expect(sql.indexOf("'TERMINAL'::text", reasonConflict)).toBeLessThan(eligibility);
    expect(sql).toContain(
      'root_event.occurred_at IS DISTINCT FROM incoming.reconciliation_started_at',
    );
    expect(sql).toContain('root_event.source_fact_digest IS NOT NULL');
    expect(sql).toContain('root_event.broker_command_id IS NOT NULL');
  });

  it('uses DB-owned versioned canonical identities and the existing append-only alert definer', () => {
    expect(sql).toContain("'domain', 'combo:vnext:journal-source-identity:v1'");
    expect(sql).toContain("'domain', 'combo:vnext:journal-event-body:v1'");
    expect(sql).toContain("'protocol', 'combo.creator-agent-reconciliation-event'");
    expect(sql).toContain("'version', 1");
    for (const field of [
      'creatorId',
      'consumerId',
      'conversationId',
      'invocationId',
      'source',
      'logicalSourceEventId',
      'eventType',
      'payload',
    ]) {
      expect(sql).toContain(`'${field}'`);
    }
    expect(sql).toContain(
      "public.digest(pg_catalog.convert_to(existing_identity::text, 'UTF8'), 'sha256')",
    );
    expect(sql).toContain(
      "public.digest(pg_catalog.convert_to(received_identity::text, 'UTF8'), 'sha256')",
    );
    expect(sql).toContain('public.creator_agent_record_journal_integrity_alert_v1(');
    expect(sql).toContain("'SOURCE_EVENT_CONFLICT'");
    expect(sql).toContain("'RECONCILER'");
  });

  it('allows explicit roots only through the trusted definer current_user', () => {
    const replacement = sql.lastIndexOf(
      'CREATE OR REPLACE FUNCTION public.enforce_creator_agent_reconciling_root_event()',
    );
    const triggerSql = sql.slice(replacement);

    expect(triggerSql).toContain(
      "'public.creator_agent_begin_reconciliation_v2(uuid,uuid,uuid,uuid,uuid,text)'::regprocedure",
    );
    expect(triggerSql).toContain("session_user <> 'combo_agent_reconciler'");
    expect(triggerSql).toContain('current_user = session_user');
    expect(triggerSql).toContain('current_user IS DISTINCT FROM admission_owner');
    expect(triggerSql).toContain('explicit reconciliation root requires v2 admission authority');
    expect(triggerSql).toContain("session_user <> 'combo_agent_broker'");
    expect(triggerSql).toContain("'late-prepared:' || fact.source_event_id");
    expect(triggerSql).toContain("'late-started:' || fact.source_event_id");
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.creator_agent_begin_reconciliation_v2\([\s\S]*?\) TO combo_agent_reconciler;/u,
    );
    expect(sql).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.creator_agent_begin_reconciliation_v2\([\s\S]*?\) TO (?:combo_agent_api|combo_agent_broker)/u,
    );
  });

  it('rolls projection mutation back on a raced logical-source collision', () => {
    const mutation = sql.indexOf('UPDATE public.agent_invocations AS invocation');
    const insert = sql.indexOf('INSERT INTO public.agent_invocation_events', mutation);
    const catchConflict = sql.indexOf('EXCEPTION WHEN unique_violation', insert);
    const collisionOutcome = sql.indexOf('IF admission_collided THEN', catchConflict);
    const alertAfterCollision = sql.indexOf(
      'public.creator_agent_record_journal_integrity_alert_v1(',
      collisionOutcome,
    );

    expect(mutation).toBeGreaterThanOrEqual(0);
    expect(insert).toBeGreaterThan(mutation);
    expect(catchConflict).toBeGreaterThan(insert);
    expect(collisionOutcome).toBeGreaterThan(catchConflict);
    expect(alertAfterCollision).toBeGreaterThan(collisionOutcome);
    expect(sql).toContain('The subtransaction rolls the projection update back');
  });
});
