import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'migrations',
    '0030_creator_agent_runtime_product_wiring.sql',
  ),
  'utf8',
);

describe('0030 Runtime product wiring migration', () => {
  it('admits only strict payload-v2 prepare/start capability sources', () => {
    expect(migration).toContain('payload_contract_version = 2');
    expect(migration).toContain('creator_agent_execution_capability_wire_v1_is_safe');
    expect(migration).toContain('creator_agent_execution_capability_wire_v1_canonical_text');
    expect(migration).toContain('creator_agent_execution_capability_wire_v1_digest');
    expect(migration).toContain('input_execution_capability_digest IS DISTINCT FROM');
    expect(migration).toContain('pg_catalog.scale(');
    expect(migration).toContain('TO combo_agent_api, combo_agent_broker, combo_agent_reconciler;');
    expect(migration).toContain("NEW.command_type = 'invocation.cancel'");
    expect(migration).toContain(
      "RAISE EXCEPTION '0030 does not admit invocation.cancel producers'",
    );
    expect(migration).toMatch(
      /command\.command_type IN \(\s*'invocation\.prepare', 'invocation\.start'\s*\)/u,
    );
  });

  it('persists immutable exact wire text and binds its SHA-256 to the delivery', () => {
    expect(migration).toContain('ADD COLUMN wire_canonical_text text');
    expect(migration).toContain('wire_canonical_text::jsonb = wire_envelope');
    expect(migration).toContain(
      "public.digest(pg_catalog.convert_to(wire_canonical_text, 'UTF8'), 'sha256')",
    );
    expect(migration).toContain('NEW.wire_canonical_text IS DISTINCT FROM OLD.wire_canonical_text');
    expect(migration).toContain('uq_worker_gateway_outbound_lifecycle_per_session');
    expect(migration).toContain('creator_agent_gateway_lifecycle_frame_v2_is_safe');
    expect(migration).toContain('IF NOT COALESCE((');
  });

  it('keeps legacy v0 start projection additive', () => {
    expect(migration).toMatch(
      /SELECT predecessor\.execution_capability_wire[\s\S]+IF FOUND THEN[\s\S]+NEW\.payload_contract_version := 2;[\s\S]+ELSE[\s\S]+NEW\.execution_capability_wire := NULL;/u,
    );
  });

  it('exposes one exact Broker lock capability with native durable ciphertext bytes', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.creator_agent_lock_gateway_lifecycle_command_v2(',
    );
    for (const field of [
      'content_nonce bytea',
      'content_ciphertext bytea',
      'content_auth_tag bytea',
      'execution_capability_wire jsonb',
      'wire_sent_at timestamptz',
      'wire_expires_at timestamptz',
    ]) {
      expect(migration).toContain(field);
    }
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.creator_agent_lock_gateway_lifecycle_command_v2\([\s\S]+TO combo_agent_broker;/u,
    );
  });

  it('shares one owner-only exact Broker authority gate across readiness and lifecycle claim', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.creator_agent_gateway_lifecycle_v2_broker_is_exact()',
    );
    for (const contract of [
      'role.rolcanlogin',
      'role.rolinherit',
      'role.rolcreaterole',
      'role.rolcreatedb',
      'role.rolreplication',
      'pg_catalog.pg_auth_members',
      'expected_schema_privileges',
      'expected_table_privileges',
      'expected_column_privileges',
      'expected_sequence_privileges',
      'expected_security_definers',
      "pg_catalog.current_database(), 'CONNECT'",
      "pg_catalog.current_database(), 'TEMPORARY'",
      "pg_catalog.current_database(), 'CREATE'",
    ]) {
      expect(migration).toContain(contract);
    }
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.creator_agent_gateway_lifecycle_v2_broker_is_exact\(\)[\s\S]+FROM PUBLIC, combo_agent_api, combo_agent_broker, combo_agent_consumer_api,[\s\S]+combo_agent_reconciler, combo_agent_maintenance;/u,
    );
    expect(migration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.creator_agent_gateway_lifecycle_v2_broker_is_exact\(\)/u,
    );

    const lockStart = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.creator_agent_lock_gateway_lifecycle_command_v2(',
    );
    const lockEnd = migration.indexOf('$lock_gateway_lifecycle_v2$ LANGUAGE plpgsql;', lockStart);
    const readyStart = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.creator_agent_gateway_lifecycle_v2_ready()',
    );
    const readyEnd = migration.indexOf(
      '$gateway_lifecycle_v2_ready$ LANGUAGE plpgsql;',
      readyStart,
    );
    expect(migration.slice(lockStart, lockEnd)).toContain(
      'public.creator_agent_gateway_lifecycle_v2_broker_is_exact()',
    );
    expect(migration.slice(readyStart, readyEnd)).toContain(
      'public.creator_agent_gateway_lifecycle_v2_broker_is_exact()',
    );
  });

  it('makes fresh send one trusted-owner atomic durable chain', () => {
    expect(migration).toContain('creator_agent_preflight_consumer_message_v2');
    expect(migration).toContain('creator_agent_finalize_consumer_message_v2');
    expect(migration).toContain('creator_agent_issue_runtime_product_ids_v2');
    expect(migration).toContain('Consumer message v2 replay durable chain is incomplete');
    expect(migration).toContain('Consumer message v2 preflight replay durable chain is incomplete');
    expect(migration).toContain("'invocation.queued'");
    expect(migration).toContain("'invocation.leased'");
    expect(migration).toContain("'DISPATCH_PENDING'::text");
    expect(migration).toContain('$runtime_product_owner_gate$');
    expect(migration).toContain('$runtime_product_consumer_acl_gate$');
    expect(migration).toContain('Runtime product Consumer role must have zero role membership');
    expect(migration).toContain("'combo.gateway.deployment/v1:'");
    expect(migration).toContain('FOR SHARE NOWAIT');
    expect(migration).toContain('FOR UPDATE OF conversation');
    expect(migration).toContain('FOR SHARE OF deployment, installation, lease, gateway');
    expect(migration).toContain("'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'");
    expect(migration).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.creator_agent_accept_consumer_message_v1\([\s\S]+FROM combo_agent_consumer_api;/u,
    );
    expect(migration).toMatch(
      /pg_catalog\.has_function_privilege\(\s*'combo_agent_consumer_api',\s*'public\.creator_agent_accept_consumer_message_v1\([^)]+\)',\s*'EXECUTE'\s*\)/u,
    );
  });

  it('gives the exact Broker a ledger-free 0030 readiness predicate', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.creator_agent_gateway_lifecycle_v2_ready()',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.creator_agent_gateway_lifecycle_v2_ready()',
    );
    expect(migration).not.toMatch(
      /creator_agent_gateway_lifecycle_v2_ready[\s\S]+schema_migrations/u,
    );
  });

  it('stores only a low-sensitivity lifecycle claim receipt reference', () => {
    expect(migration).toContain('creator_agent_gateway_lifecycle_claim_receipt_v2_is_safe');
    expect(migration).toContain("ARRAY['sessionId', 'commandId', 'sequence', 'canonicalDigest']");
    expect(migration).not.toMatch(
      /creator_agent_gateway_lifecycle_claim_receipt_v2_is_safe[\s\S]+ARRAY\[[^\]]*wireEnvelope/u,
    );
  });
});
