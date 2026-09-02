import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  resolve(directory, '..', 'v2-migrations', '0015_v2_billing_idempotency.sql'),
  'utf8',
);

describe('0015 V2 billing exact-scope idempotency', () => {
  it('backfills a stable event key and restores append-only protection', () => {
    expect(sql).toContain('ADD COLUMN idempotency_key text');
    expect(sql).toContain("'legacy:v0:' || id::text");
    expect(sql).toContain('ALTER COLUMN idempotency_key SET NOT NULL');
    expect(sql).toContain('UNIQUE (idempotency_key)');
    expect(sql).toMatch(
      /DISABLE TRIGGER trg_v2_metering_append_only[\s\S]*ENABLE TRIGGER trg_v2_metering_append_only/,
    );
    expect(sql).toMatch(
      /DISABLE TRIGGER trg_v2_ledger_append_only[\s\S]*WHERE kind = 'recharge'[\s\S]*ENABLE TRIGGER trg_v2_ledger_append_only/,
    );
    expect(sql).toContain("digest(convert_to(idempotency_key, 'UTF8'), 'sha256')");
    expect(sql).toContain('CREATE TRIGGER trg_v2_ledger_idempotency_domain');
    expect(sql).toContain('CREATE TRIGGER trg_v2_metering_idempotency_domain');
    expect(sql).toContain("NEW.idempotency_key := 'legacy:v0:' || NEW.id::text");
    expect(sql).toContain("NEW.idempotency_key := 'meter:estimated:v1:' || NEW.hold_id::text");
  });

  it('keeps every JavaScript-facing amount and wallet derivation in safe integer range', () => {
    expect(sql).toContain('ck_v2_wallet_safe_integer_range');
    expect(sql).toContain('principal_balance::numeric + bonus_balance::numeric');
    expect(sql).toContain('ck_v2_ledger_safe_integer_range');
    expect(sql).toContain('ck_v2_holds_safe_integer_range');
    expect(sql).toContain('ck_v2_metering_safe_integer_range');
    expect(sql).toContain('9007199254740991');
  });

  it('binds every held event to the exact user, Agent, and Turn tuple', () => {
    expect(sql).toContain('UNIQUE (id, user_id, agent_id, turn_id)');
    expect(sql).toContain('FOREIGN KEY (hold_id, user_id, agent_id, turn_id)');
    expect(sql).toContain('REFERENCES v2_holds (id, user_id, agent_id, turn_id)');
    expect(sql).toContain('VALIDATE CONSTRAINT fk_v2_metering_exact_hold');
  });

  it('serializes metering against settlement and protects hold identity', () => {
    expect(sql).toContain('FOR UPDATE');
    expect(sql).toContain("bound_status <> 'held'");
    expect(sql).toContain('BEFORE INSERT ON v2_metering_events');
    expect(sql).toContain('BEFORE UPDATE ON v2_holds');
    expect(sql).toContain('v2_holds request identity is immutable');
    expect(sql).toContain('terminal v2_holds are immutable');
    expect(sql).toContain('GRANT UPDATE (status, actual_amount, settled_at) ON v2_holds');
    expect(sql).toContain('GRANT SELECT (id) ON v2_users TO combo_billing');
  });
});
