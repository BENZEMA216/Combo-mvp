import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  resolve(directory, '..', 'migrations', '0018_creator_agent_broker_delivery_contract.sql'),
  'utf8',
);

describe('0018 Broker delivery contract', () => {
  it('locks every mutable authority before a zero-live 55000 gate', () => {
    const lock = migration.indexOf('LOCK TABLE public.broker_outbox');
    const gate = migration.indexOf('DO $broker_delivery_zero_live_gate$');
    const firstAlter = migration.indexOf('ALTER TABLE public.broker_outbox');
    expect(lock).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(lock);
    expect(firstAlter).toBeGreaterThan(gate);
    expect(migration).toContain('public.worker_gateway_outbound_frames');
    expect(migration).toContain('public.worker_gateway_sessions');
    expect(migration).toContain('public.worker_leases');
    expect(migration).toContain("state IN ('PENDING', 'SENT')");
    expect(migration).toContain("durable_ack_level IS DISTINCT FROM 'CLOUD_COMMITTED'");
    expect(migration).toContain("WHERE state = 'ACTIVE'");
    expect(migration).toContain("USING ERRCODE = '55000'");
    const deliveryGate = migration.slice(
      migration.indexOf('INTO live_delivery_count'),
      migration.indexOf('INTO active_session_count'),
    );
    expect(deliveryGate).not.toContain("'lease.revoke'");
  });

  it('keeps v0 nullable/read-only and binds v1 to trusted digest metadata and original authority', () => {
    for (const field of [
      'payload_contract_version',
      'visible_transcript_digest',
      'visible_transcript_key_id',
      'visible_transcript_key_version',
      'visible_transcript_key_ref',
      'original_worker_session_id',
      'original_connection_id',
    ]) {
      expect(migration).toContain(field);
    }
    expect(migration).toContain('payload_contract_version = 0');
    expect(migration).toContain('payload_contract_version = 1');
    expect(migration).toContain("visible_transcript_digest ~ '^hmac-sha256:[a-f0-9]{64}$'");
    expect(migration).toContain('fk_broker_outbox_original_session');
    expect(migration).toContain('fk_broker_outbox_original_lease_connection');
    expect(migration).not.toMatch(/visible_transcript_(?:key|secret|plaintext)\s+(?:bytea|jsonb)/u);
  });

  it('separates stable business identity from current reconnect delivery authority', () => {
    for (const field of [
      'broker_command_id',
      'broker_target_worker_id',
      'broker_deployment_id',
      'claim_session_id',
      'claim_connection_id',
      'current_delivery_lease_id',
      'current_delivery_fence',
    ]) {
      expect(migration).toContain(field);
    }
    expect(migration).toContain('message_id = broker_command_id');
    expect(migration).toContain('claim_session_id = session_id');
    expect(migration).toContain('fk_worker_gateway_outbound_broker_command');
    expect(migration).toContain('fk_worker_gateway_outbound_claim_session');
    expect(migration).toContain('fk_worker_gateway_outbound_current_lease');
    expect(migration).toContain('uq_worker_gateway_outbound_business_per_session');
    expect(migration).toContain('uq_worker_gateway_outbound_control_message');
    expect(migration).toContain('legacy Broker delivery contract cannot claim a business command');
    expect(migration).toContain('Broker business delivery lost current claim authority');
    const v0BusinessGuard = migration.slice(
      migration.indexOf('IF NEW.delivery_contract_version = 0'),
      migration.indexOf('IF NEW.delivery_contract_version = 1'),
    );
    expect(v0BusinessGuard).not.toContain("'lease.revoke'");
    expect(migration).toContain('lease.revoke is a protocol control frame');
  });

  it('creates only the v2 Consumer definer and revalidates Session plus Lease under lock', () => {
    const v2 = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.creator_agent_create_opening_conversation_v2(',
    );
    const insert = migration.indexOf('INSERT INTO public.broker_outbox (', v2);
    const deploymentAdvisory = migration.indexOf("'combo.gateway.deployment/v1:'", v2);
    const versionNowait = migration.indexOf('FOR SHARE NOWAIT', deploymentAdvisory);
    const deploymentRows = migration.indexOf('FROM public.deployments AS deployment', v2);
    expect(v2).toBeGreaterThan(0);
    expect(insert).toBeGreaterThan(v2);
    expect(deploymentAdvisory).toBeGreaterThan(v2);
    expect(versionNowait).toBeGreaterThan(deploymentAdvisory);
    expect(deploymentRows).toBeGreaterThan(versionNowait);
    expect(migration).toContain("version_control.availability = 'ACTIVE'");
    expect(migration).toContain("version_control.severity = 'NORMAL'");
    expect(migration).toContain("USING ERRCODE = '40001'");
    expect(migration).toContain("lease.state = 'ACTIVE'");
    expect(migration).toContain("gateway.state = 'ACTIVE'");
    expect(migration).toContain('FOR SHARE OF lease, installation, gateway');
    expect(migration).toContain('create_open_v2_definer_owner_gate');
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.creator_agent_create_opening_conversation\([\s\S]+combo_agent_consumer_api/u,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.creator_agent_create_opening_conversation_v2\([\s\S]+TO combo_agent_consumer_api;/u,
    );
  });

  it('keys the API insert guard only from the non-privileged login authority', () => {
    const guard = migration.slice(
      migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.enforce_creator_agent_api_prepare_outbox_insert()',
      ),
      migration.indexOf(
        'REVOKE ALL ON FUNCTION public.enforce_creator_agent_api_prepare_outbox_insert()',
      ),
    );
    expect(guard).toContain("session_user = 'combo_agent_api'");
    expect(guard).toContain("pg_catalog.pg_has_role(session_user, 'combo_agent_api', 'MEMBER')");
    expect(guard).toContain('NOT (session_role.rolsuper OR session_role.rolbypassrls)');
    expect(guard).not.toContain('pg_catalog.pg_has_role(current_user');
    expect(guard).not.toContain("current_user = 'combo_agent_api'");
  });

  it('adds the stable Broker contract incompatibility audit reason', () => {
    expect(migration.match(/BROKER_CONTRACT_INCOMPATIBLE/gu)).toHaveLength(2);
  });
});
