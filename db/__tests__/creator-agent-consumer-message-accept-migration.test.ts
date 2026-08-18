import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  resolve(directory, '..', 'migrations', '0022_creator_agent_consumer_message_accept.sql'),
  'utf8',
);

function functionDefinition(name: string): string {
  const startToken = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const start = migration.indexOf(startToken);
  if (start < 0) throw new Error(`missing function ${name}`);
  const end = migration.indexOf(`REVOKE ALL ON FUNCTION public.${name}(`, start);
  if (end < 0) throw new Error(`missing function ACL ${name}`);
  return migration.slice(start, end);
}

describe('0022 Creator Agent Consumer message accept migration', () => {
  it('keeps the USER Message ID caller-supplied and owns the remaining identities and time', () => {
    const outer = functionDefinition('creator_agent_accept_consumer_message_v1');
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.creator_agent_accept_consumer_message_v1(',
    );
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = pg_catalog, public');
    expect(migration).toContain("session_user = 'combo_agent_consumer_api'");
    expect(migration).toContain('public.gen_uuid_v7()');
    expect(migration).toContain('clock_timestamp()');
    expect(migration).toContain("runtime_policy->>'maxTurnSeconds'");
    expect(migration).toContain('public.creator_agent_admit_user_message_core_v1(');
    expect(outer).toContain('input_user_message_id uuid');
    expect(outer).not.toContain('input_invocation_id uuid');
    expect(outer).not.toContain('input_outbox_command_id uuid');
    expect(outer).not.toContain('input_source_event_id uuid');
    expect(outer).not.toContain('input_deadline_at timestamptz');
    expect(outer).toContain('generated_invocation_id := public.gen_uuid_v7()');
    expect(outer).toContain('generated_outbox_command_id := public.gen_uuid_v7()');
    expect(outer).toContain('generated_source_event_id := public.gen_uuid_v7()');
    expect(outer).toContain(
      "generated_deadline_at := accepted_at + max_turn_seconds * interval '1 second'",
    );
    expect(outer).toContain('accepted_at := admission_now');
    for (const outcome of ['ADMITTED', 'CONTEXT_LIMIT', 'REPLAY', 'CONFLICT', 'UNAVAILABLE']) {
      expect(migration).toContain(`'${outcome}'`);
    }
  });

  it('keeps the public Consumer role on the outer capability and off every direct write', () => {
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.creator_agent_accept_consumer_message_v1\([^;]*\)\s+TO combo_agent_consumer_api;/u,
    );
    expect(migration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.creator_agent_admit_user_message_v1\([^;]*\)\s+TO combo_agent_consumer_api;/u,
    );
    expect(migration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.creator_agent_admit_user_message_core_v1\([^;]*\)\s+TO combo_agent_consumer_api;/u,
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.creator_agent_accept_consumer_message_v1(',
    );
    expect(migration).toContain('FROM PUBLIC');
    expect(migration).toMatch(
      /REVOKE (?:ALL PRIVILEGES|INSERT|UPDATE|DELETE)[^;]*FROM combo_agent_consumer_api;/u,
    );
    expect(migration).not.toMatch(
      /GRANT (?:INSERT|UPDATE|DELETE)[^;]*TO combo_agent_consumer_api;/u,
    );
    expect(migration).not.toContain('GRANT combo_agent_api TO combo_agent_consumer_api');
    expect(migration).not.toContain('GRANT combo_agent_broker TO combo_agent_consumer_api');
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.creator_agent_admit_user_message_core_v1\([^;]*\) FROM PUBLIC, combo_agent_api, combo_agent_consumer_api, combo_agent_broker,[^;]*;/u,
    );
  });

  it('gates the trusted owner and exact replay before fresh Conversation admission', () => {
    const outer = functionDefinition('creator_agent_accept_consumer_message_v1');
    expect(migration).toContain('requires a SUPERUSER or BYPASSRLS owner');
    expect(outer).toContain('context_admission_outcome');
    expect(outer).toMatch(
      /client_message_id = input_client_message_id[\s\S]+request_digest IS DISTINCT FROM input_request_digest[\s\S]+'CONFLICT'/u,
    );
    expect(outer).toMatch(
      /client_message_id = input_client_message_id[\s\S]+'REPLAY'[\s\S]+FOR UPDATE/u,
    );
    expect(outer).toMatch(
      /conversation\.expires_at[\s\S]+conversation_expires_at <= admission_now/u,
    );
  });

  it('preserves legacy text idempotency and fences fresh execution authority', () => {
    const outer = functionDefinition('creator_agent_accept_consumer_message_v1');
    const core = functionDefinition('creator_agent_admit_user_message_core_v1');
    for (const definition of [outer, core]) {
      expect(definition).toContain(
        'pg_catalog.length(input_client_message_id) NOT BETWEEN 1 AND 256',
      );
      expect(definition).not.toMatch(/input_client_message_id\s+IS NULL[\s\S]{0,120}!~/u);
    }
    expect(outer).toContain("version_control.availability = 'ACTIVE'");
    expect(outer).toContain("version_control.severity = 'NORMAL'");
    expect(outer).toContain("deployment.observed_state = 'ONLINE'");
    expect(outer).toContain("lease.state = 'ACTIVE'");
    expect(outer).toContain("gateway.state = 'ACTIVE'");
    expect(outer).toContain("current_lease_expires_at <= admission_now + interval '3 seconds'");
    expect(outer).toContain("current_gateway_expires_at <= admission_now + interval '3 seconds'");
    expect(outer).toContain('conversation_expires_at <= admission_now');
    expect(outer).toContain('FOR UPDATE OF conversation');
    expect(outer).not.toContain('FOR UPDATE;');
    const replayAt = outer.indexOf("'REPLAY'::text");
    const freshUuidV4At = outer.indexOf(
      'fresh Consumer message idempotency key must be canonical UUIDv4',
    );
    const freshConversationAt = outer.indexOf(
      'Resolve only the immutable lock identity before taking the shared Deployment lock order',
    );
    expect(replayAt).toBeGreaterThan(0);
    expect(freshUuidV4At).toBeGreaterThan(replayAt);
    expect(freshConversationAt).toBeGreaterThan(freshUuidV4At);
    expect(outer).toContain('ADR-VNEXT-033');
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.enforce_creator_agent_consumer_idempotency_v4()',
    );
    expect(migration).toContain("session_user = 'combo_agent_consumer_api'");
    expect(migration).toContain('fresh Consumer idempotency key must use UUIDv4');
    expect(migration).toContain('CREATE TRIGGER agent_conversations_consumer_idempotency_v4');
  });

  it('redefines all five API-like guards from non-privileged session_user only', () => {
    for (const name of [
      'enforce_creator_agent_message_insert_authority',
      'enforce_creator_agent_message_accept_chain',
      'enforce_creator_agent_api_invocation_insert',
      'enforce_creator_agent_api_prepare_outbox_insert',
      'enforce_creator_agent_api_accepted_event_insert',
    ]) {
      const guard = functionDefinition(name);
      expect(guard, name).toContain("session_user = 'combo_agent_api'");
      expect(guard, name).toContain("session_user = 'combo_agent_consumer_api'");
      expect(guard, name).not.toContain("current_user = 'combo_agent_api'");
      expect(guard, name).not.toContain('pg_has_role(current_user');
    }
    expect(migration).toContain("'public.enforce_creator_agent_message_accept_chain()'");
  });
});
