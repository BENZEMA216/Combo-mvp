import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  resolve(directory, '..', 'migrations', '0020_creator_agent_confirmed_failure_fact.sql'),
  'utf8',
);
const cloudJournal = readFileSync(
  resolve(
    directory,
    '..',
    '..',
    'packages',
    'creator-agent-persistence',
    'src',
    'cloud-journal.ts',
  ),
  'utf8',
);

const confirmedFailureCodes = [
  'SNAPSHOT_DIGEST_MISMATCH',
  'PROTOCOL_INCOMPATIBLE',
  'SANDBOX_ATTESTATION_FAILED',
  'RUNTIME_START_FAILED',
  'MODEL_QUOTA_EXHAUSTED',
  'TURN_TIMEOUT',
  'TURN_FAILED',
] as const;

describe('0020 confirmed Worker failure fact contract', () => {
  it('fails closed before tightening an unbound legacy Worker failure population', () => {
    const lock = migration.indexOf('LOCK TABLE public.agent_invocation_events');
    const gate = migration.indexOf('DO $confirmed_failure_zero_legacy_gate$');
    const replacement = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.enforce_creator_agent_worker_invocation_fact()',
    );
    expect(lock).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(lock);
    expect(replacement).toBeGreaterThan(gate);
    expect(migration).toContain("source = 'WORKER'");
    expect(migration).toContain("event_type = 'invocation.failed'");
    expect(migration).toContain("USING ERRCODE = '55000'");
  });

  it('binds failed facts to the Invocation source identity without a Broker command', () => {
    expect(migration).toContain("NEW.event_type IN ('invocation.succeeded', 'invocation.failed')");
    expect(migration).toContain('NEW.source_fact_digest IS NULL');
    expect(migration).toContain('NEW.broker_command_id IS NOT NULL');
    expect(migration).toContain('NEW.source_event_id <> NEW.invocation_id::text');
    expect(migration).not.toContain(
      "NEW.event_type IN ('invocation.succeeded', 'invocation.failed', 'invocation.cancelled')",
    );
  });

  it('keeps the stable confirmed-failure registry exact across SQL and Cloud code', () => {
    const sqlRegistry =
      /COALESCE\(NEW\.payload->>'errorCode', ''\) NOT IN \(([\s\S]*?)\n {9}\)/u.exec(
        migration,
      )?.[1];
    const cloudRegistry = /const CONFIRMED_WORKER_FAILURE_CODES = \[([\s\S]*?)\] as const/u.exec(
      cloudJournal,
    )?.[1];
    expect(sqlRegistry).toBeDefined();
    expect(cloudRegistry).toBeDefined();
    const quotedCodes = (source: string | undefined): string[] =>
      [...(source ?? '').matchAll(/'([A-Z][A-Z0-9_]+)'/gu)].map((match) => match[1]!).sort();
    expect(quotedCodes(sqlRegistry)).toEqual([...confirmedFailureCodes].sort());
    expect(quotedCodes(cloudRegistry)).toEqual([...confirmedFailureCodes].sort());
    for (const code of confirmedFailureCodes) {
      expect(migration).toContain(`'${code}'`);
      expect(cloudJournal).toContain(`'${code}'`);
    }
    for (const rejected of [
      'INVOCATION_DEADLINE_EXPIRED',
      'START_COMMAND_CONFLICT',
      'EXECUTION_CAPABILITY_INVALID',
      'CANCEL_NOT_CONFIRMED',
      'EXECUTION_STATE_UNKNOWN',
    ]) {
      const registry = cloudJournal.slice(
        cloudJournal.indexOf('const CONFIRMED_WORKER_FAILURE_CODES'),
        cloudJournal.indexOf('const ConfirmedWorkerFailureCodeSchema'),
      );
      expect(registry).not.toContain(`'${rejected}'`);
      expect(migration).not.toContain(`'${rejected}'`);
    }
  });

  it('enables CANCELLED only through the verified interrupt-receipt admission authority (0029)', () => {
    // 0029 superseded the 0020-era guard: cancelled terminals are admitted only by the
    // DB-owned definer that recomputes the canonical fact digest (which covers the interrupt
    // receipt digest) and enforces exact Broker session authority + replay digest equality.
    const cancelledMigration = readFileSync(
      resolve(__dirname, '..', 'migrations', '0029_creator_agent_cancelled_fact_admission.sql'),
      'utf8',
    );
    expect(cancelledMigration).toContain("NEW.event_type = 'invocation.cancelled'");
    expect(cancelledMigration).toContain("jsonb_build_object('state', 'CANCELLED')");
    expect(cancelledMigration).toMatch(/source_fact_digest IS DISTINCT FROM input_fact_digest/u);
    expect(cancelledMigration).toContain(
      'Cancelled fact admission requires exact Broker session authority',
    );
    expect(cloudJournal).toContain('projectCancelled(');
    expect(cloudJournal).toContain('creator_agent_project_cancelled_fact_v1(');
  });
});
