import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  resolve(directory, '..', 'migrations', '0019_creator_agent_broker_outbox_publisher.sql'),
  'utf8',
);

describe('0019 Broker Outbox publisher contract', () => {
  it('gates unrepresentable v1 rows before adding immutable exact-wire time', () => {
    const lock = migration.indexOf('LOCK TABLE public.worker_gateway_outbound_frames');
    const gate = migration.indexOf('DO $broker_publisher_zero_delivery_gate$');
    const alter = migration.indexOf('ALTER TABLE public.worker_gateway_outbound_frames');
    expect(lock).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(lock);
    expect(alter).toBeGreaterThan(gate);
    expect(migration).toContain('WHERE delivery_contract_version = 1');
    expect(migration).toContain("USING ERRCODE = '55000'");
  });

  it('makes v1 wire time exact and immutable while keeping v0 nullable', () => {
    expect(migration).toContain('ADD COLUMN wire_sent_at timestamptz');
    expect(migration).toContain('ADD COLUMN wire_expires_at timestamptz');
    expect(migration).toContain('delivery_contract_version = 0');
    expect(migration).toContain('wire_sent_at IS NULL');
    expect(migration).toContain('wire_expires_at IS NULL');
    expect(migration).toContain('delivery_contract_version = 1');
    expect(migration).toContain('wire_sent_at IS NOT NULL');
    expect(migration).toContain('wire_expires_at > wire_sent_at');
    expect(migration).toContain('NEW.wire_sent_at IS DISTINCT FROM OLD.wire_sent_at');
    expect(migration).toContain('NEW.wire_expires_at IS DISTINCT FROM OLD.wire_expires_at');
  });

  it('allows only current Test authority and freezes expiry at first claim', () => {
    expect(migration).toContain("current_deployment.environment = 'TEST'");
    expect(migration).toContain("command.state IN ('PENDING', 'SENT')");
    expect(migration).toContain("gateway.state = 'ACTIVE'");
    expect(migration).toContain("delivery_lease.state = 'ACTIVE'");
    expect(migration).toContain(
      "NEW.wire_sent_at = date_trunc('milliseconds', transaction_timestamp())",
    );
    expect(migration).toContain('NEW.wire_expires_at = date_trunc(');
    expect(migration).toContain('LEAST(command.expires_at');
    expect(migration).toContain("NEW.wire_expires_at > clock_timestamp() + interval '3 seconds'");
    expect(migration).toContain('FOR UPDATE OF command');
    expect(migration).toContain('FOR SHARE OF gateway, current_deployment, delivery_lease');
  });

  it('stores only a strict identifier-and-digest conversation.open operation result', () => {
    expect(migration).toContain("'CLAIM_BROKER_COMMAND'");
    expect(migration).toContain('creator_agent_gateway_conversation_open_frame_is_safe');
    for (const field of [
      'visibleTranscriptDigest',
      'openAuthority',
      'workerSessionId',
      'wire_sent_at',
      'wire_expires_at',
    ]) {
      expect(migration).toContain(field);
    }
    expect(migration).not.toMatch(
      /(?:prompt|answer|credential|ciphertext)\s+(?:text|bytea|jsonb)/iu,
    );
  });

  it('durably binds an early replacement ACK without retaining its raw frame', () => {
    expect(migration).toContain('ADD COLUMN broker_acknowledged_message_id uuid');
    expect(migration).toContain('ADD COLUMN broker_ack_level text');
    expect(migration).toContain('ADD COLUMN broker_ack_decision text');
    expect(migration).toContain("envelope_type = 'message.ack'");
    expect(migration).toContain('broker_ack_level IS NOT NULL');
    expect(migration).toContain('broker_ack_decision IS NOT NULL');
    expect(migration).toContain('idx_worker_gateway_frame_receipts_broker_ack');
    expect(migration).not.toContain('worker_gateway_frame_receipts_broker_ack_insert');
    expect(migration).not.toMatch(/ADD COLUMN (?:raw_frame|prompt|answer|ciphertext)/iu);
  });
});
