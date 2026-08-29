import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  resolve(directory, '..', 'migrations', '0017_agent_session_usage_receipts.sql'),
  'utf8',
);

function tableDefinition(table: 'agent_usage_receipts'): string {
  const definition = sql.match(new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`))?.[1];
  expect(definition, `missing ${table} definition`).toBeDefined();
  return definition!;
}

describe('0017 Agent Package Session and knowledge usage receipts migration', () => {
  it('is append-only and leaves old Session or charge writers on explicit legacy defaults', () => {
    expect(sql).toMatch(
      /ALTER TABLE sessions[\s\S]*product_kind text NOT NULL DEFAULT 'legacy_capability'/,
    );
    expect(sql).toMatch(
      /ALTER TABLE usage_charges[\s\S]*product_kind text NOT NULL DEFAULT 'legacy_capability'/,
    );
    expect(sql).not.toMatch(/ALTER TABLE\s+(?:sessions|usage_charges)\s+DROP/iu);
    expect(sql).not.toMatch(/UPDATE\s+(?:sessions|usage_charges)\s+SET/iu);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+(?:sessions|usage_charges)/iu);
  });

  it('freezes one grouped v2 controlled-Test Package and fixed resource on Session INSERT', () => {
    expect(sql).toContain("product_kind IN ('legacy_capability', 'knowledge_agent_test')");
    expect(sql).toContain("capability_protocol = 'combo.agent-package-capability/2'");
    for (const field of [
      'capability_protocol',
      'release_id',
      'package_digest',
      'release_scope',
      'knowledge_resource_path',
      'knowledge_resource_digest',
    ]) {
      expect(sql).toContain(`AND ${field} IS NOT NULL`);
    }
    for (const legacyPin of ['agent_project_id', 'agent_revision_id', 'agent_release_id']) {
      expect(sql).toContain(`AND ${legacyPin} IS NULL`);
    }
    expect(sql).toContain("release_scope = 'controlled_test'");
    expect(sql).toContain(
      "knowledge_resource_path =\n        'skills/knowledge/references/knowledge-bundle.json'",
    );
    expect(sql).toContain("knowledge_resource_digest ~ '^sha256:[a-f0-9]{64}$'");
    expect(sql).toContain(
      'FOREIGN KEY (release_id, package_digest)\n  REFERENCES agent_package_releases (release_id, package_digest)\n  MATCH FULL',
    );
    expect(sql).toContain('CREATE TRIGGER trg_agent_session_binding_immutable');
    expect(sql).toContain("RAISE EXCEPTION 'knowledge Session binding is immutable'");
    expect(sql).not.toMatch(/publisher(?:_user)?_id/iu);
  });

  it('binds knowledge charges to the same freeze and maps every terminal outcome fail closed', () => {
    for (const field of [
      'billing_policy_version',
      'validator_policy_version',
      'execution_outcome',
      'knowledge_resource_digest',
    ]) {
      expect(sql).toContain(`ADD COLUMN ${field} text`);
    }
    expect(sql).toContain("status = 'reserved' AND execution_outcome IS NULL");
    expect(sql).toMatch(
      /status = 'completed'\s+AND execution_outcome IS NOT NULL\s+AND execution_outcome = 'answered'/,
    );
    expect(sql).toContain(
      "execution_outcome IN ('insufficient_evidence', 'failed', 'interrupted')",
    );
    expect(sql).toContain("billing_policy_version ~ '^[a-z0-9][a-z0-9._-]{0,127}$'");
    expect(sql).toContain("validator_policy_version ~ '^[a-z0-9][a-z0-9._-]{0,127}$'");
    expect(sql).toContain('CREATE TRIGGER trg_knowledge_usage_binding_immutable');
    expect(sql).toContain("RAISE EXCEPTION 'knowledge usage binding is immutable'");
  });

  it('creates one strongly scoped append-only receipt with exact audit snapshots', () => {
    const receipts = tableDefinition('agent_usage_receipts');
    for (const field of [
      'usage_charge_id',
      'owner_user_id',
      'usage_id',
      'capability_id',
      'session_id',
      'turn_id',
      'release_id',
      'package_digest',
      'knowledge_resource_path',
      'knowledge_resource_digest',
      'billing_policy_version',
      'validator_policy_version',
      'unit_price_cents',
      'free_limit_snapshot',
      'charge_source',
      'settled_cents',
      'execution_outcome',
      'validation_code',
      'response_digest',
      'citation_chunk_ids',
      'execution_environment',
      'runtime_release_id',
      'runtime_source_sha',
    ]) {
      expect(receipts).toContain(field);
    }
    expect(receipts).toMatch(/usage_charge_id\s+uuid\s+NOT NULL UNIQUE/);
    expect(receipts).toMatch(/turn_id\s+uuid\s+NOT NULL UNIQUE/);
    expect(receipts).toContain('UNIQUE (owner_user_id, usage_id)');
    expect(receipts).toContain('FOREIGN KEY (usage_charge_id, owner_user_id)');
    expect(receipts).toContain('FOREIGN KEY (session_id, capability_id, owner_user_id)');
    expect(receipts).toContain('FOREIGN KEY (turn_id, session_id)');
    expect(receipts).toContain('FOREIGN KEY (release_id, package_digest)');
    expect(receipts).toContain("CHECK (execution_environment = 'test')");
    expect(receipts).toContain("runtime_release_id ~ '^release-[0-9a-f]{40}$'");
    expect(receipts).toContain("runtime_release_id = 'release-' || runtime_source_sha");
    expect(receipts).toContain("runtime_source_sha ~ '^[0-9a-f]{40}$'");
    expect(receipts).toContain('cardinality(citation_chunk_ids) BETWEEN 1 AND 32');
    expect(receipts).toContain(
      "validation_code IN ('not_run', 'rejected', 'unavailable', 'protocol_invalid')",
    );
    expect(receipts).toMatch(
      /execution_outcome = 'answered'[\s\S]*?response_digest IS NOT NULL[\s\S]*?response_digest ~/,
    );
    expect(receipts).toMatch(
      /execution_outcome = 'insufficient_evidence'[\s\S]*?response_digest IS NOT NULL[\s\S]*?response_digest ~/,
    );
    expect(sql).toContain('CREATE TRIGGER trg_agent_usage_receipts_write_guard');
    expect(sql).toContain('CREATE TRIGGER trg_agent_usage_receipts_no_truncate');
  });

  it('checks Turn, charge, receipt, citations, and exactly-one terminal state at commit', () => {
    expect(sql).toContain('CREATE FUNCTION enforce_knowledge_usage_receipt_equation()');
    expect(sql).toMatch(
      /SELECT turn_id INTO affected_turn\s+FROM usage_charges\s+WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD[.]usage_charge_id ELSE NEW[.]usage_charge_id END;/,
    );
    expect(sql).not.toMatch(/SELECT turn_id INTO affected_turn[\s\S]{0,180}FOR UPDATE/);
    const sessionLock = sql.indexOf(
      'FROM sessions\n   WHERE id = affected_session\n   FOR UPDATE;',
    );
    const turnLock = sql.indexOf(
      'FROM turns\n   WHERE id = affected_turn AND session_id = affected_session\n   FOR UPDATE;',
    );
    const chargeLock = sql.indexOf(
      'FROM usage_charges\n   WHERE turn_id = affected_turn\n   FOR UPDATE;',
    );
    expect(sessionLock).toBeGreaterThan(-1);
    expect(turnLock).toBeGreaterThan(sessionLock);
    expect(chargeLock).toBeGreaterThan(turnLock);
    expect(sql).not.toContain('FOR UPDATE OF');
    expect(sql).not.toMatch(/FROM agent_usage_receipts[\s\S]{0,120}FOR UPDATE/);
    expect(sql).toContain("charge_row.execution_outcome = 'answered'");
    expect(sql).toContain("turn_status = 'completed'");
    expect(sql).toContain("charge_row.execution_outcome = 'failed'");
    expect(sql).toContain("turn_status = 'failed'");
    expect(sql).toContain("charge_row.execution_outcome = 'interrupted'");
    expect(sql).toContain("turn_status = 'interrupted'");
    expect(sql).toContain('terminal knowledge usage requires exactly one receipt');
    expect(sql).toContain("citation_id !~ '^chunk[.]knowledge[.][0-9a-f]{32}$'");
    for (const trigger of [
      'trg_turn_knowledge_usage_receipt_equation',
      'trg_usage_charge_knowledge_receipt_equation',
      'trg_agent_usage_receipt_equation',
    ]) {
      expect(sql).toMatch(
        new RegExp(`CREATE CONSTRAINT TRIGGER ${trigger}[\\s\\S]*DEFERRABLE INITIALLY DEFERRED`),
      );
    }
  });

  it('gives Runtime append/read and outcome update only while API, worker, and PUBLIC stay denied', () => {
    expect(sql).toMatch(
      /REVOKE ALL PRIVILEGES ON agent_usage_receipts\s+FROM PUBLIC, combo_api, combo_worker, combo_runtime/,
    );
    expect(sql).toContain('GRANT SELECT ON agent_usage_receipts TO combo_runtime;');
    const receiptInsertGrant = sql.match(
      /GRANT INSERT \(([\s\S]*?)\) ON agent_usage_receipts TO combo_runtime;/,
    )?.[1];
    expect(receiptInsertGrant).toBeDefined();
    expect(receiptInsertGrant).toContain('usage_charge_id');
    expect(receiptInsertGrant).toContain('runtime_release_id');
    const grantedColumns = receiptInsertGrant!.split(',').map((column) => column.trim());
    expect(grantedColumns).not.toContain('id');
    expect(grantedColumns).not.toContain('created_at');
    expect(sql).toContain('GRANT UPDATE (execution_outcome) ON usage_charges TO combo_runtime;');
    expect(sql).not.toMatch(/GRANT[^;]+agent_usage_receipts[^;]+TO combo_(?:api|worker)/isu);
    expect(sql).not.toMatch(
      /GRANT[^;]+agent_(?:packages|package_releases)[^;]+TO combo_runtime/isu,
    );
    for (const triggerFunction of [
      'reject_agent_session_binding_mutation',
      'reject_knowledge_usage_binding_mutation',
      'guard_agent_usage_receipt_write',
      'enforce_knowledge_usage_receipt_equation',
    ]) {
      expect(sql).toContain(`REVOKE ALL PRIVILEGES ON FUNCTION ${triggerFunction}()`);
    }
  });
});
