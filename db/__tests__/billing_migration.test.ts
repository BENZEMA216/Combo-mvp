import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(resolve(directory, '..', 'migrations', '0009_billing.sql'), 'utf8');

function tableDefinition(table: string): string {
  const match = sql.match(new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`));
  expect(match, `missing table ${table}`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('0009 shared Agent billing', () => {
  it('separates the global wallet from per-user per-Agent free allowances', () => {
    const account = tableDefinition('billing_accounts');
    expect(account).toContain('owner_user_id uuid        PRIMARY KEY REFERENCES users(id)');
    expect(account).toMatch(/balance_cents bigint\s+NOT NULL DEFAULT 0/);
    expect(account).toMatch(/reserved_cents bigint\s+NOT NULL DEFAULT 0/);
    expect(account).toMatch(/balance_cents >= 0[\s\S]*reserved_cents >= 0/);

    const allowance = tableDefinition('billing_free_allowances');
    expect(allowance).toContain('PRIMARY KEY (owner_user_id, capability_id)');
    expect(allowance).toContain('REFERENCES billing_accounts(owner_user_id)');
    expect(allowance).toContain('REFERENCES capabilities(id)');
    expect(allowance).toContain('policy_version');
    expect(allowance).toContain('free_limit_snapshot');
    expect(allowance).toMatch(/free_used_count \+ free_reserved_count <= free_limit_snapshot/);
  });

  it('makes usageId and Turn charging idempotent inside the exact Session scope', () => {
    const charge = tableDefinition('usage_charges');
    expect(charge).toContain('UNIQUE (owner_user_id, usage_id)');
    expect(charge).toContain('UNIQUE (turn_id)');
    expect(charge).toContain("charge_source IN ('owner', 'free', 'wallet')");
    expect(charge).toContain("status IN ('reserved', 'completed', 'released')");
    expect(charge).toContain("request_fingerprint ~ '^[0-9a-f]{64}$'");
    expect(charge).toMatch(/unit_price_cents\s+bigint\s+NOT NULL/);
    expect(charge).toMatch(/reserved_cents\s+bigint\s+NOT NULL/);
    expect(charge).toMatch(/settled_cents\s+bigint\s+NOT NULL DEFAULT 0/);
    expect(charge).toContain('FOREIGN KEY (session_id, capability_id, owner_user_id)');
    expect(charge).toContain('REFERENCES sessions (id, capability_id, owner_user_id)');
    expect(charge).toContain('FOREIGN KEY (turn_id, session_id)');
    expect(charge).toContain('REFERENCES turns (id, session_id)');
    expect(sql).toContain("WHERE status = 'reserved'");
  });

  it('stores recharge state separately from idempotent wallet credit state', () => {
    const order = tableDefinition('recharge_orders');
    expect(order).toContain('UNIQUE (owner_user_id, client_idempotency_key)');
    expect(order).toContain('UNIQUE (pay_trace_no, pay_time)');
    expect(order).toContain("payment_method IN ('h5', 'aggregate_qr')");
    expect(order).toContain("gateway_environment IN ('test', 'production')");
    expect(order).toContain(
      "payment_status IN ('created', 'pending', 'unknown', 'succeeded', 'failed', 'closed')",
    );
    expect(order).toContain("credit_status IN ('uncredited', 'credited')");
    expect(order).toMatch(
      /credit_status = 'credited'[\s\S]*payment_status = 'succeeded'[\s\S]*credited_at IS NOT NULL/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX uq_recharge_platform_trade[\s\S]*gateway_environment,[\s\S]*institution_no,[\s\S]*merchant_no,[\s\S]*platform_trade_no/,
    );
    expect(sql).toMatch(
      /CREATE INDEX idx_recharge_query_due[\s\S]*payment_status IN \('created', 'pending', 'unknown'\)[\s\S]*credit_status = 'uncredited'/,
    );
    expect(sql).not.toMatch(/paid_at IS NULL OR paid_at >= created_at/);
  });

  it('persists low-sensitivity gateway attempts and callback fingerprints without raw payloads', () => {
    const attempt = tableDefinition('payment_attempts');
    expect(attempt).toContain('UNIQUE (recharge_order_id, attempt_no)');
    expect(attempt).toContain(
      "status IN ('submitting', 'pending', 'unknown', 'succeeded', 'failed')",
    );
    expect(attempt).toContain("action_kind IN ('redirect_url', 'code_url')");
    expect(attempt).toMatch(/action_value IS NOT NULL[\s\S]*action_expires_at IS NOT NULL/);
    expect(attempt).toContain("request_fingerprint ~ '^[0-9a-f]{64}$'");

    const callback = tableDefinition('payment_callback_events');
    expect(callback).toMatch(/event_fingerprint\s+char\(64\)\s+NOT NULL UNIQUE/);
    expect(callback).toContain("processing_status IN ('received', 'processed', 'rejected')");
    expect(callback).toMatch(
      /processing_status = 'processed'[\s\S]*signature_valid[\s\S]*recharge_order_id IS NOT NULL/,
    );
    expect(callback).not.toMatch(/raw_(?:json|body|payload)|signature\s+text|sign\s+text/i);
    expect(sql).toContain('CREATE INDEX idx_payment_attempts_action_expiry');
    expect(sql).toContain('CREATE INDEX idx_payment_callback_rejected_retention');
  });

  it('uses signed bigint cents and strong owner references in an append-only wallet ledger', () => {
    const ledger = tableDefinition('wallet_ledger');
    expect(ledger).toMatch(/amount_cents\s+bigint\s+NOT NULL/);
    expect(ledger).toContain("'recharge_credit'");
    expect(ledger).toContain("'recharge_refund'");
    expect(ledger).toContain("'usage_debit'");
    expect(ledger).toContain("'usage_compensation'");
    expect(ledger).toContain('FOREIGN KEY (recharge_order_id, owner_user_id)');
    expect(ledger).toContain('FOREIGN KEY (usage_charge_id, owner_user_id)');
    expect(sql).toContain('CREATE UNIQUE INDEX uq_wallet_ledger_recharge_entry');
    expect(sql).toContain('CREATE UNIQUE INDEX uq_wallet_ledger_usage_entry');
    expect(sql).toContain('CREATE TRIGGER trg_wallet_ledger_append_only');
    expect(sql).toContain('CREATE TRIGGER trg_wallet_ledger_no_truncate');
    expect(sql).toContain("RAISE EXCEPTION 'wallet_ledger is append-only'");
    expect(sql).toContain('CREATE TRIGGER trg_wallet_ledger_writer');
    expect(sql.match(/SECURITY INVOKER/g)).toHaveLength(6);
    expect(sql).toContain("current_user = 'combo_api'");
    expect(sql).toContain("current_user = 'combo_runtime'");
    expect(sql).toContain("NEW.entry_type <> 'recharge_credit'");
    expect(sql).toContain("NEW.entry_type <> 'usage_debit'");
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER trg_billing_account_ledger_equation');
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER trg_wallet_ledger_account_equation');
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER trg_usage_charge_account_equation');
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER trg_recharge_order_credit_equation');
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER trg_wallet_ledger_recharge_equation');
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER trg_usage_charge_debit_equation');
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER trg_wallet_ledger_usage_equation');
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER trg_billing_free_allowance_equation');
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER trg_usage_charge_free_equation');
    expect(sql).toContain('balance_cents::numeric');
    expect(sql).toContain('sum(amount_cents)');
    expect(sql).toContain("charge_source = 'wallet'");
    expect(sql).toContain("OLD.charge_source <> 'wallet'");
    expect(sql).toContain("OLD.charge_source <> 'free'");
    expect(sql).toContain("entry_type = 'recharge_credit'");
    expect(sql).toContain("entry_type = 'usage_debit'");
  });

  it('gives API and Runtime only their billing responsibilities and leaves worker denied', () => {
    expect(sql).toContain('FROM PUBLIC, combo_api, combo_worker, combo_runtime');

    expect(sql).toContain('GRANT SELECT ON billing_free_allowances, usage_charges TO combo_api');
    expect(sql).toContain('GRANT SELECT, INSERT ON recharge_orders TO combo_api');
    expect(sql).toContain('GRANT SELECT, INSERT ON wallet_ledger TO combo_api');
    const rechargeUpdateGrant = sql.match(
      /GRANT UPDATE \(([\s\S]*?)\) ON recharge_orders TO combo_api;/,
    )?.[1];
    expect(rechargeUpdateGrant).toContain('payment_status');
    expect(rechargeUpdateGrant).not.toMatch(/payment_method|pay_trace_no|pay_time|amount_cents/);

    expect(sql).toContain('GRANT SELECT, INSERT ON billing_free_allowances TO combo_runtime');
    expect(sql).toContain('GRANT SELECT, INSERT ON usage_charges TO combo_runtime');
    expect(sql).toContain('GRANT SELECT, INSERT ON wallet_ledger TO combo_runtime');
    expect(sql).not.toMatch(
      /GRANT[^;]*(?:recharge_orders|payment_attempts|payment_callback_events)[^;]*TO combo_runtime/is,
    );

    expect(sql).not.toMatch(/GRANT[^;]*TO combo_worker/);
    expect(sql).not.toMatch(
      /GRANT (?:UPDATE|DELETE)[^;]*wallet_ledger[^;]*TO combo_(?:api|runtime|worker)/is,
    );
  });
});
