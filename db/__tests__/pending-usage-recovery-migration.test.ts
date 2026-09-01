import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  resolve(directory, '..', 'migrations', '0019_pending_usage_recovery.sql'),
  'utf8',
);

function tableDefinition(table: 'pending_usage_recoveries'): string {
  const definition = sql.match(new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`))?.[1];
  expect(definition, `missing ${table} definition`).toBeDefined();
  return definition!;
}

describe('0019 pending usage recovery migration', () => {
  it('is expand-only and preserves every existing recharge order as a nullable legacy row', () => {
    expect(sql).toContain('CREATE TABLE pending_usage_recoveries (');
    expect(sql).toContain('ALTER TABLE recharge_orders\n  ADD COLUMN recovery_usage_id uuid;');
    expect(sql).not.toMatch(/UPDATE\s+recharge_orders/iu);
    expect(sql).not.toMatch(/ALTER TABLE\s+(?:sessions|usage_charges)\b/iu);
    expect(sql).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN|CONSTRAINT)\b/iu);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/iu);
    expect(sql).not.toMatch(/recovery_usage_id\s+uuid\s+NOT NULL/iu);
  });

  it('freezes text, usageId, Session, exact Package, policy, price, active intent, and expiry', () => {
    const pending = tableDefinition('pending_usage_recoveries');
    for (const field of [
      'owner_user_id',
      'usage_id',
      'session_id',
      'capability_id',
      'request_text',
      'request_fingerprint',
      'product_kind',
      'capability_protocol',
      'release_id',
      'package_digest',
      'release_scope',
      'knowledge_resource_path',
      'knowledge_resource_digest',
      'billing_policy_version',
      'validator_policy_version',
      'unit_price_cents',
      'free_limit_snapshot',
      'active_recharge_intent_id',
      'recovery_status',
      'terminal_turn_id',
      'expires_at',
    ]) {
      expect(pending).toContain(field);
    }
    expect(pending).toContain('PRIMARY KEY (owner_user_id, usage_id)');
    expect(pending).toContain('FOREIGN KEY (session_id, capability_id, owner_user_id)');
    expect(pending).toContain('FOREIGN KEY (release_id, package_digest)');
    expect(pending).toContain('FOREIGN KEY (terminal_turn_id, session_id)');
    expect(pending).toContain("product_kind = 'knowledge_agent_test'");
    expect(pending).toContain("capability_protocol = 'combo.agent-package-capability/2'");
    expect(pending).toContain("release_scope = 'controlled_test'");
    expect(pending).toContain('unit_price_cents > 0');
    expect(pending).toContain("expires_at <= created_at + interval '7 days'");
    expect(sql).toContain('initial recharge intent must equal the recovery usageId');
    expect(sql).toContain('pending usage recovery and Session binding diverged');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX uq_pending_usage_recoveries_session_active\n' +
        '  ON pending_usage_recoveries (session_id)\n' +
        "  WHERE recovery_status = 'active';",
    );
  });

  it('makes active recovery monotonic and clears text in either immutable terminal state', () => {
    const pending = tableDefinition('pending_usage_recoveries');
    expect(pending).toMatch(
      /recovery_status = 'active'[\s\S]*request_text IS NOT NULL[\s\S]*terminal_turn_id IS NULL/,
    );
    expect(pending).toMatch(
      /recovery_status = 'accepted'[\s\S]*request_text IS NULL[\s\S]*terminal_turn_id IS NOT NULL/,
    );
    expect(pending).toMatch(/recovery_status = 'abandoned'[\s\S]*request_text IS NULL/);
    expect(sql).toContain("IF OLD.recovery_status <> 'active' THEN");
    expect(sql).toContain('terminal pending usage recovery is immutable');
    expect(sql).toContain('expired pending usage cannot replace its recharge intent');
    expect(sql).toContain('accepted recovery requires an answered settled wallet usage receipt');
    expect(sql).toContain('abandoned admitted recovery requires a released non-answer receipt');
    expect(sql).toContain('charge-free abandonment requires an unadmitted recovery');
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER trg_pending_usage_recovery_terminal_equation');
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER trg_usage_charge_pending_recovery_equation');
    expect(sql).toMatch(
      /trg_pending_usage_recovery_terminal_equation[\s\S]*DEFERRABLE INITIALLY DEFERRED/,
    );
    expect(sql).toContain("charge_row.status IS DISTINCT FROM 'completed'");
    expect(sql).toContain("charge_row.execution_outcome IS DISTINCT FROM 'answered'");
    expect(sql).toContain("charge_row.status IS DISTINCT FROM 'released'");
    expect(sql).toContain('terminal recovery, charge, and receipt snapshots diverged');
    expect(sql).toContain('CREATE TRIGGER trg_pending_usage_recovery_no_truncate');
  });

  it('keeps the order relationship one-way and does not add cross-service trigger locks', () => {
    expect(sql).toContain(
      'FOREIGN KEY (owner_user_id, recovery_usage_id)\n  REFERENCES pending_usage_recoveries (owner_user_id, usage_id)',
    );
    expect(sql).toContain('CREATE TRIGGER trg_recharge_order_recovery_binding_immutable');
    expect(sql).toContain('recharge order does not match the active pending usage intent');
    expect(sql).toContain('recharge order recovery binding is immutable');
    const pendingDefinition = tableDefinition('pending_usage_recoveries');
    expect(pendingDefinition).not.toContain('REFERENCES recharge_orders');
    const guard = sql.match(
      /CREATE FUNCTION guard_pending_usage_recovery_write\(\) RETURNS trigger AS \$\$([\s\S]*?)\n\$\$/,
    )?.[1];
    expect(guard).toBeDefined();
    expect(guard).not.toMatch(/recharge_orders/iu);
    expect(guard).not.toMatch(/FOR\s+(?:NO\s+KEY\s+)?UPDATE/iu);
    const closure = sql.match(
      /CREATE FUNCTION enforce_pending_usage_recovery_terminal\(\) RETURNS trigger AS \$\$([\s\S]*?)\n\$\$/,
    )?.[1];
    expect(closure).toBeDefined();
    expect(closure).not.toMatch(/recharge_orders/iu);
    expect(closure).not.toMatch(/FOR\s+(?:NO\s+KEY\s+)?UPDATE/iu);
    expect(sql).toContain("pg_advisory_xact_lock(hashtextextended(owner_user_id::text || ':' ||");
    expect(sql).toContain('This ordinary SELECT is only a static last-line binding check');
  });

  it('separates Runtime text ownership from the API payment CAS and leaves worker denied', () => {
    expect(sql).toContain('GRANT SELECT ON pending_usage_recoveries TO combo_runtime;');
    const runtimeUpdate = sql.match(
      /GRANT UPDATE \(([\s\S]*?)\) ON pending_usage_recoveries TO combo_runtime;/,
    )?.[1];
    expect(runtimeUpdate).toContain('request_text');
    expect(runtimeUpdate).toContain('recovery_status');
    expect(runtimeUpdate).not.toContain('active_recharge_intent_id');

    const apiSelect = sql.match(
      /GRANT SELECT \(([\s\S]*?)\) ON pending_usage_recoveries TO combo_api;/,
    )?.[1];
    expect(apiSelect).toContain('active_recharge_intent_id');
    expect(apiSelect).toContain('unit_price_cents');
    expect(apiSelect).not.toContain('request_text');
    expect(apiSelect).not.toContain('package_digest');
    expect(sql).toContain(
      'GRANT UPDATE (active_recharge_intent_id, updated_at)\n  ON pending_usage_recoveries TO combo_api;',
    );
    expect(sql).not.toMatch(/GRANT[^;]+pending_usage_recoveries[^;]+TO combo_worker/isu);
    expect(sql).not.toMatch(/GRANT[^;]+recharge_orders[^;]+TO combo_runtime/isu);
    for (const triggerFunction of [
      'guard_pending_usage_recovery_write',
      'enforce_pending_usage_recovery_terminal',
      'guard_recharge_order_recovery_binding',
    ]) {
      expect(sql).toContain(`REVOKE ALL PRIVILEGES ON FUNCTION ${triggerFunction}()`);
    }
    for (const privilegedGuard of [
      'guard_pending_usage_recovery_write',
      'enforce_pending_usage_recovery_terminal',
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `CREATE FUNCTION ${privilegedGuard}\\(\\) RETURNS trigger AS \\$\\$[\\s\\S]*?SECURITY DEFINER[\\s\\S]*?SET search_path = pg_catalog, public;`,
        ),
      );
    }
    expect(sql).not.toMatch(/\bEXECUTE\s+(?:FORMAT|IMMEDIATE)\b/iu);
  });
});
