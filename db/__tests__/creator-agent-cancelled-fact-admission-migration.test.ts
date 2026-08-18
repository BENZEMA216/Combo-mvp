import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  resolve(directory, '..', 'migrations', '0029_creator_agent_cancelled_fact_admission.sql'),
  'utf8',
);

describe('0029 Creator Agent cancelled fact admission migration', () => {
  it('locks the full terminal chain and fails closed on legacy cancelled terminals', () => {
    const lock = sql.indexOf('LOCK TABLE public.agent_invocations,');
    const gate = sql.indexOf('DO $cancelled_fact_zero_legacy$');
    const table = sql.indexOf('CREATE TABLE public.creator_agent_cancelled_terminal_receipts');
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
    expect(sql).toContain('0029 requires zero legacy confirmed Worker cancelled terminals');
  });

  it('creates a private append-only retention-proof receipt', () => {
    const tableStart = sql.indexOf('CREATE TABLE public.creator_agent_cancelled_terminal_receipts');
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
    expect(sql).toContain('creator_agent_cancelled_terminal_receipts_immutable');
    expect(sql).toContain('creator_agent_cancelled_terminal_receipts_no_truncate');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[\s\S]*creator_agent_cancelled_terminal_receipts/iu,
    );
  });

  it('freezes cancelled fact, Consumer payload, and dedupe JCS recipes with goldens', () => {
    const cancelledFact = {
      agentVersionDigest: 'a'.repeat(64),
      executionCapabilityDigest: 'c'.repeat(64),
      fence: '7',
      interruptReceiptDigest: `sha256:${'d'.repeat(64)}`,
      invocationId: '0198f00d-5000-7000-8000-000000000013',
      leaseId: '0198f00d-5000-7000-8000-000000000015',
      protocol: 'combo.worker-invocation-fact/1',
      schemaVersion: 1,
      snapshotDigest: 'b'.repeat(64),
      sourceEventId: '0198f00d-5000-7000-8000-000000000013',
      type: 'invocation.cancelled',
    };
    const canonicalJson = [
      `"agentVersionDigest":${JSON.stringify(cancelledFact.agentVersionDigest)}`,
      `"executionCapabilityDigest":${JSON.stringify(cancelledFact.executionCapabilityDigest)}`,
      `"fence":${JSON.stringify(cancelledFact.fence)}`,
      `"interruptReceiptDigest":${JSON.stringify(cancelledFact.interruptReceiptDigest)}`,
      `"invocationId":${JSON.stringify(cancelledFact.invocationId)}`,
      `"leaseId":${JSON.stringify(cancelledFact.leaseId)}`,
      `"protocol":${JSON.stringify(cancelledFact.protocol)}`,
      `"schemaVersion":${cancelledFact.schemaVersion}`,
      `"snapshotDigest":${JSON.stringify(cancelledFact.snapshotDigest)}`,
      `"sourceEventId":${JSON.stringify(cancelledFact.sourceEventId)}`,
      `"type":${JSON.stringify(cancelledFact.type)}`,
    ].join(',');
    expect(createHash('sha256').update(`{${canonicalJson}}`, 'utf8').digest('hex')).toBe(
      'a906d06b2770c55c8683093bfa86871b2a926d1834ae6a4042235853b208d77b',
    );

    const payloadJson = [
      '"assistantMessageId":null',
      `"conversationId":${JSON.stringify('0198f00d-5000-7000-8000-000000000014')}`,
      '"errorCode":null',
      `"invocationId":${JSON.stringify('0198f00d-5000-7000-8000-000000000013')}`,
      `"occurredAt":${JSON.stringify('2026-08-18T09:00:00.000Z')}`,
      '"protocol":"combo.consumer-event-outbox/1"',
      '"resultDigest":null',
      '"schemaVersion":1',
      '"terminalState":"CANCELLED"',
      '"type":"invocation.terminal"',
    ].join(',');
    expect(createHash('sha256').update(`{${payloadJson}}`, 'utf8').digest('hex')).toBe(
      '0963d84e401a07d0587eb7777cc1ec543175ca3475c2d3f871dc66b309b14f4a',
    );

    const dedupeJson = [
      '"eventType":"invocation.terminal"',
      `"ownerId":${JSON.stringify('0198f00d-5000-7000-8000-000000000016')}`,
      '"protocol":"combo.consumer-event-outbox/1"',
      '"sourceEventId":"4242"',
    ].join(',');
    expect(createHash('sha256').update(`{${dedupeJson}}`, 'utf8').digest('hex')).toBe(
      '62655eec2e236678cc602e9aa9595c9f0bba3717283d31d18960e082408ab507',
    );
  });

  it('restricts every admission definer to the Broker role and verifies trusted owners', () => {
    for (const expected of [
      'creator_agent_project_cancelled_fact_v1(uuid,uuid,text,integer,text,uuid,uuid,text,text,text,uuid,bigint,text,text)',
      'enforce_creator_agent_confirmed_cancelled_companion()',
    ]) {
      expect(sql).toContain(expected);
    }
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.creator_agent_project_cancelled_fact_v1(',
    );
    expect(sql).toContain('TO combo_agent_broker;');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.creator_agent_project_cancelled_fact_v1(');
  });

  it('keeps the Worker terminal Event payload CANCELLED minimal per the lifecycle CHECK', () => {
    expect(sql).toContain("jsonb_build_object('state', 'CANCELLED')");
    // The receipt digest never leaks into the Event payload; it is preserved through the
    // canonical Worker fact digest and proven by the replay digest-equality invariant.
    expect(sql).toMatch(/source_fact_digest IS DISTINCT FROM input_fact_digest/u);
    expect(sql).toMatch(/'terminalState', 'CANCELLED'/u);
  });
});
