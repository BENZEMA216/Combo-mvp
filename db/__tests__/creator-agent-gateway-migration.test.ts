import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  resolve(directory, '..', 'migrations', '0015_creator_agent_gateway_authority.sql'),
  'utf8',
);

const TABLES = [
  'worker_auth_challenges',
  'worker_gateway_sessions',
  'worker_auth_security_events',
  'worker_gateway_operation_receipts',
  'worker_gateway_frame_receipts',
  'worker_gateway_security_events',
  'worker_gateway_outbound_frames',
  'worker_gateway_sequence_gaps',
] as const;

describe('0015 Creator Agent Gateway authority migration', () => {
  it('adds only the challenge, session, sequence, and ACK authority owned by this tranche', () => {
    for (const table of TABLES) expect(sql, table).toContain(`CREATE TABLE ${table} (`);
    expect(sql.match(/CREATE TABLE /gu)).toHaveLength(TABLES.length);
    expect(sql).not.toContain('ALTER TABLE broker_outbox');
    expect(sql).not.toContain('conversation_ready_receipts');
    expect(sql).not.toContain('creator_agent_commit_conversation_ready');
  });

  it('forces tenant RLS while permitting only the narrow pre-tenant definer lookup', () => {
    for (const table of TABLES) {
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }
    expect(sql).toContain('CREATE POLICY worker_auth_challenges_definer_lookup');
    expect(sql).toContain("session_user = 'combo_agent_broker'");
    expect(sql).toContain('current_user <> session_user');
    expect(sql).toContain('creator_agent_issue_worker_challenge(');
    expect(sql).toContain('creator_agent_lock_worker_challenge(');
    expect(sql).toContain('creator_agent_lock_consumed_worker_challenge(');
    expect(sql).not.toContain('agent_invocations_gateway_authority_update');
    expect(sql).toContain('creator_agent_cascade_version_security_revocation()');
    expect(sql).toContain('agent_version_controls_gateway_security_cascade');
    expect(sql).toContain("'combo.gateway.deployment/v1:'");
    expect(sql).toContain("SET state = 'REVOKED'");
    expect(sql).toContain("disconnect_reason = 'AUTH_FAILED'");
    expect(sql).toContain("last_error_code = 'VERSION_SECURITY_REVOKED'");
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION creator_agent_issue_worker_challenge(uuid, uuid, bigint, integer)',
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION creator_agent_lock_worker_challenge(uuid, uuid) TO combo_agent_broker',
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION creator_agent_lock_consumed_worker_challenge(uuid, uuid)',
    );
    expect(sql).toContain("AND state = 'CONSUMED'");
    expect(sql).toContain('FOR UPDATE;');
    const apiGatewayGrants = sql.match(/GRANT[^;]+worker_gateway_[^;]+TO combo_agent_api/giu);
    expect(apiGatewayGrants).toEqual([
      'GRANT SELECT, INSERT ON worker_gateway_operation_receipts TO combo_agent_api',
    ]);
  });

  it('makes challenge use, session identity, cursors, receipts, and ACK facts monotonic', () => {
    expect(sql).toContain('uq_worker_auth_challenges_installation_issued');
    expect(sql).toContain('deployment_generation bigint');
    expect(sql).toContain('fk_worker_auth_challenges_deployment');
    expect(sql).toContain('uq_worker_auth_challenges_audit_binding');
    expect(sql).toContain('NEW.deployment_id IS DISTINCT FROM OLD.deployment_id');
    expect(sql).toContain('NEW.deployment_generation IS DISTINCT FROM OLD.deployment_generation');
    expect(sql).toContain("deployment.desired_state = 'ONLINE'");
    expect(sql).toContain('deployment.generation = requested_deployment_generation');
    expect(sql).toContain('uq_worker_gateway_sessions_installation_active');
    expect(sql).toContain('uq_worker_gateway_sessions_challenge UNIQUE (challenge_id)');
    expect(sql).toContain('terminal worker challenge is immutable');
    expect(sql).toContain('terminal worker gateway session is immutable');
    expect(sql).toContain('registration_digest text');
    expect(sql).toContain('NEW.registration_digest IS DISTINCT FROM OLD.registration_digest');
    expect(sql).toContain('worker gateway session cursors are monotonic');
    expect(sql).toContain('CREATE TRIGGER worker_gateway_operation_receipts_immutable');
    expect(sql).toContain('CREATE TRIGGER worker_auth_security_events_immutable');
    expect(sql).toContain('uq_worker_auth_security_events_challenge_type');
    expect(sql).toContain("event_type IN ('CHALLENGE_REPLAY', 'WORKER_INCOMPATIBLE')");
    expect(sql).toContain("'CHALLENGE_ALREADY_CONSUMED'");
    expect(sql).toContain("'WORKER_REGISTRATION_INCOMPATIBLE'");
    expect(sql).toContain("'WORKER_VERSION_INCOMPATIBLE'");
    expect(sql).toContain("'PROTOCOL_INCOMPATIBLE'");
    expect(sql).toContain("'CODEX_RUNTIME_INCOMPATIBLE'");
    expect(sql).toContain("'CODEX_PROTOCOL_INCOMPATIBLE'");
    expect(sql).toContain("'ISOLATION_INCOMPATIBLE'");
    expect(sql).toContain('worker_auth_security_events_id_seq TO combo_agent_broker');
    expect(sql).toContain('ck_worker_gateway_operation_receipts_retention');
    expect(sql).toContain('PRIMARY KEY (creator_id, operation_kind, operation_key)');
    expect(sql).not.toContain('operation_id');
    expect(sql).toContain('CREATE TRIGGER worker_gateway_frame_receipts_immutable');
    expect(sql).toContain('CREATE TRIGGER worker_gateway_security_events_immutable');
    expect(sql).toContain('existing_sequence        bigint');
    expect(sql).toContain('uq_worker_gateway_security_events_conflict');
    expect(sql).toContain('existing_sequence,\n    sequence,\n    existing_message_id');
    expect(sql).not.toContain('uq_worker_gateway_security_events_sequence');
    expect(sql).toContain('worker gateway ACK level is monotonic');
    expect(sql).toContain('worker gateway ACK decision is immutable');
    expect(sql).toContain('worker gateway first ACK time is immutable');
    expect(sql).toContain('CREATE TRIGGER worker_gateway_sequence_gaps_immutable');
    expect(sql).toContain('grant_lease_id    uuid');
    expect(sql).toContain('grant_fence       bigint');
    expect(sql).toContain('grant_expires_at  timestamptz');
    expect(sql).toContain('ck_worker_gateway_outbound_frames_grant_binding');
  });

  it('stores no raw frame, prompt, answer, credential, path, or free-form payload column', () => {
    expect(sql).not.toMatch(
      /^\s+(raw_frame|prompt|answer|credential|file_path|stderr|ciphertext)\s+/imu,
    );
    expect(sql).toContain('canonical_digest text');
    expect(sql).toContain('envelope_type');
    expect(sql).toContain('response_frames');
    expect(sql).toContain('jsonb_array_length(response_frames) <= 2');
    expect(sql).toContain('octet_length(response_frames::text) <= 8192');
    expect(sql).toContain('request_digest');
    expect(sql).toContain('result_digest');
    expect(sql).toContain('octet_length(result_value::text) <= 16384');
    expect(sql).toContain('creator_agent_gateway_operation_result_is_safe');
    expect(sql).toContain('creator_agent_gateway_control_frame_batch_is_safe');
    expect(sql).toContain('creator_agent_gateway_accept_response_batch_is_safe');
    expect(sql).toContain("ARRAY['lease.grant', 'message.ack', 'lease.revoke']");
    expect(sql).toContain("input_body->>'leaseExpiresAt' = input_frame->>'expiresAt'");
    expect(sql).toContain("input_body->>'workerSessionId' = input_lease->>'workerSessionId'");
    expect(sql).toContain("first_type = 'lease.grant' AND second_type = 'message.ack'");
    expect(sql).toContain("first_type = 'message.ack' AND second_type = 'lease.revoke'");
    expect(sql).toContain("WHEN 'ISSUE_CHALLENGE' THEN");
    expect(sql).toContain("WHEN 'AUTHENTICATE' THEN");
    expect(sql).toContain("input_result->>'kind' = 'AUTHENTICATED'");
    expect(sql).toContain("input_result->>'kind' = 'REJECTED'");
    expect(sql).toContain("input_result->>'code' = 'WORKER_INCOMPATIBLE'");
    expect(sql).toContain("WHEN 'AUDIT_CHALLENGE_REPLAY' THEN");
    expect(sql).toContain("input_result->'recorded' = 'true'::jsonb");
    expect(sql).toContain("WHEN 'OPEN_SESSION' THEN");
    expect(sql).toContain("WHEN 'ACCEPT_ENVELOPE' THEN");
    expect(sql).not.toContain("'REPLAY_ENVELOPE'");
  });
});
