-- Creator-hosted Agent VNext: durable Worker challenge, Gateway session, sequence,
-- and connection-bound Lease authority. 0014 is intentionally owned by the
-- Conversation OPENING/open/ready tranche; this migration may be developed in
-- isolation but is applied after 0014 in the integrated chain.

CREATE TABLE worker_auth_challenges (
  id                    uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  creator_id            uuid        NOT NULL,
  installation_id       uuid        NOT NULL,
  deployment_id         uuid        NOT NULL,
  deployment_generation bigint      NOT NULL
                              CHECK (deployment_generation BETWEEN 0 AND 9223372036854775807),
  state                 text        NOT NULL DEFAULT 'ISSUED'
                        CONSTRAINT ck_worker_auth_challenges_state CHECK (
                          state IN ('ISSUED', 'CONSUMED', 'EXPIRED', 'REVOKED')
                        ),
  issued_at             timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at            timestamptz NOT NULL,
  consumed_at           timestamptz,
  CONSTRAINT fk_worker_auth_challenges_installation
    FOREIGN KEY (installation_id, creator_id)
    REFERENCES worker_installations (id, creator_id),
  CONSTRAINT fk_worker_auth_challenges_deployment
    FOREIGN KEY (deployment_id, creator_id)
    REFERENCES deployments (id, creator_id),
  CONSTRAINT uq_worker_auth_challenges_session_binding
    UNIQUE (id, installation_id, creator_id),
  CONSTRAINT uq_worker_auth_challenges_audit_binding
    UNIQUE (id, installation_id, creator_id, deployment_id),
  CONSTRAINT ck_worker_auth_challenges_time CHECK (
    expires_at > issued_at
    AND (
      (state = 'ISSUED' AND consumed_at IS NULL)
      OR (state <> 'ISSUED' AND consumed_at IS NOT NULL AND consumed_at >= issued_at)
    )
  )
);

CREATE UNIQUE INDEX uq_worker_auth_challenges_installation_issued
  ON worker_auth_challenges (installation_id)
  WHERE state = 'ISSUED';
CREATE INDEX idx_worker_auth_challenges_expirable
  ON worker_auth_challenges (expires_at)
  WHERE state = 'ISSUED';

CREATE OR REPLACE FUNCTION enforce_creator_agent_worker_challenge_transition()
RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.creator_id IS DISTINCT FROM OLD.creator_id
     OR NEW.installation_id IS DISTINCT FROM OLD.installation_id
     OR NEW.deployment_id IS DISTINCT FROM OLD.deployment_id
     OR NEW.deployment_generation IS DISTINCT FROM OLD.deployment_generation
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'worker challenge binding is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state <> 'ISSUED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal worker challenge is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'ISSUED' AND NEW.state NOT IN ('ISSUED', 'CONSUMED', 'EXPIRED', 'REVOKED') THEN
    RAISE EXCEPTION 'invalid worker challenge transition'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION enforce_creator_agent_worker_challenge_transition() FROM PUBLIC;

CREATE TRIGGER worker_auth_challenges_transition
BEFORE UPDATE ON worker_auth_challenges
FOR EACH ROW EXECUTE FUNCTION enforce_creator_agent_worker_challenge_transition();

CREATE TABLE worker_gateway_sessions (
  id                uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  creator_id        uuid        NOT NULL,
  installation_id   uuid        NOT NULL,
  challenge_id      uuid        NOT NULL,
  connection_id     uuid        NOT NULL DEFAULT gen_uuid_v7(),
  registration_digest text      NOT NULL CHECK (registration_digest ~ '^[a-f0-9]{64}$'),
  state             text        NOT NULL DEFAULT 'ACTIVE'
                    CONSTRAINT ck_worker_gateway_sessions_state CHECK (
                      state IN ('ACTIVE', 'CLOSED', 'REPLACED', 'REVOKED', 'EXPIRED')
                    ),
  inbound_next_seq  bigint      NOT NULL DEFAULT 0
                    CHECK (inbound_next_seq BETWEEN 0 AND 9223372036854775807),
  outbound_next_seq bigint      NOT NULL DEFAULT 0
                    CHECK (outbound_next_seq BETWEEN 0 AND 9223372036854775807),
  connected_at      timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at        timestamptz NOT NULL,
  closed_at         timestamptz,
  disconnect_reason text,
  CONSTRAINT fk_worker_gateway_sessions_installation
    FOREIGN KEY (installation_id, creator_id)
    REFERENCES worker_installations (id, creator_id),
  CONSTRAINT fk_worker_gateway_sessions_challenge
    FOREIGN KEY (challenge_id, installation_id, creator_id)
    REFERENCES worker_auth_challenges (id, installation_id, creator_id),
  CONSTRAINT uq_worker_gateway_sessions_challenge UNIQUE (challenge_id),
  CONSTRAINT uq_worker_gateway_sessions_connection UNIQUE (connection_id),
  CONSTRAINT uq_worker_gateway_sessions_id_creator UNIQUE (id, creator_id),
  CONSTRAINT uq_worker_gateway_sessions_auth_event
    UNIQUE (id, creator_id, challenge_id),
  CONSTRAINT ck_worker_gateway_sessions_time CHECK (
    expires_at > connected_at
    AND (
      (state = 'ACTIVE' AND closed_at IS NULL AND disconnect_reason IS NULL)
      OR (state <> 'ACTIVE' AND closed_at IS NOT NULL AND disconnect_reason IS NOT NULL)
    )
  ),
  CONSTRAINT ck_worker_gateway_sessions_reason CHECK (
    disconnect_reason IS NULL
    OR disconnect_reason IN (
      'CLIENT_CLOSED', 'SESSION_REPLACED', 'PROTOCOL_ERROR', 'AUTH_FAILED',
      'REPLAY_REQUIRED', 'CAPACITY', 'SERVER_STOPPED', 'INTERNAL_ERROR',
      'INSTALLATION_REVOKED', 'SESSION_EXPIRED'
    )
  )
);

CREATE UNIQUE INDEX uq_worker_gateway_sessions_installation_active
  ON worker_gateway_sessions (installation_id)
  WHERE state = 'ACTIVE';
CREATE INDEX idx_worker_gateway_sessions_expirable
  ON worker_gateway_sessions (expires_at)
  WHERE state = 'ACTIVE';

CREATE OR REPLACE FUNCTION enforce_creator_agent_gateway_session_transition()
RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.creator_id IS DISTINCT FROM OLD.creator_id
     OR NEW.installation_id IS DISTINCT FROM OLD.installation_id
     OR NEW.challenge_id IS DISTINCT FROM OLD.challenge_id
     OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.registration_digest IS DISTINCT FROM OLD.registration_digest
     OR NEW.connected_at IS DISTINCT FROM OLD.connected_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'worker gateway session binding is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state <> 'ACTIVE' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal worker gateway session is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.inbound_next_seq < OLD.inbound_next_seq
     OR NEW.outbound_next_seq < OLD.outbound_next_seq THEN
    RAISE EXCEPTION 'worker gateway session cursors are monotonic'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'ACTIVE'
     AND NEW.state NOT IN ('ACTIVE', 'CLOSED', 'REPLACED', 'REVOKED', 'EXPIRED') THEN
    RAISE EXCEPTION 'invalid worker gateway session transition'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION enforce_creator_agent_gateway_session_transition() FROM PUBLIC;

CREATE TRIGGER worker_gateway_sessions_transition
BEFORE UPDATE ON worker_gateway_sessions
FOR EACH ROW EXECUTE FUNCTION enforce_creator_agent_gateway_session_transition();

-- Authentication failures are append-only, identifier-only security facts. No
-- signature, public key, registration payload, capability value, Prompt, answer,
-- ciphertext, raw frame, credential, path, or free-form reason is retained.
CREATE TABLE worker_auth_security_events (
  id                  bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  creator_id          uuid        NOT NULL,
  installation_id     uuid        NOT NULL,
  challenge_id        uuid        NOT NULL,
  deployment_id       uuid        NOT NULL,
  original_session_id uuid,
  event_type          text        NOT NULL CHECK (
    event_type IN ('CHALLENGE_REPLAY', 'WORKER_INCOMPATIBLE')
  ),
  reason_code         text        NOT NULL CHECK (
    reason_code IN (
      'CHALLENGE_ALREADY_CONSUMED',
      'WORKER_REGISTRATION_INCOMPATIBLE',
      'WORKER_VERSION_INCOMPATIBLE',
      'PROTOCOL_INCOMPATIBLE',
      'CODEX_RUNTIME_INCOMPATIBLE',
      'CODEX_PROTOCOL_INCOMPATIBLE',
      'ISOLATION_INCOMPATIBLE'
    )
  ),
  recorded_at         timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT fk_worker_auth_security_events_installation
    FOREIGN KEY (installation_id, creator_id)
    REFERENCES worker_installations (id, creator_id),
  CONSTRAINT fk_worker_auth_security_events_challenge
    FOREIGN KEY (challenge_id, installation_id, creator_id, deployment_id)
    REFERENCES worker_auth_challenges (id, installation_id, creator_id, deployment_id),
  CONSTRAINT fk_worker_auth_security_events_deployment
    FOREIGN KEY (deployment_id, creator_id)
    REFERENCES deployments (id, creator_id),
  CONSTRAINT fk_worker_auth_security_events_original_session
    FOREIGN KEY (original_session_id, creator_id, challenge_id)
    REFERENCES worker_gateway_sessions (id, creator_id, challenge_id),
  CONSTRAINT uq_worker_auth_security_events_challenge_type
    UNIQUE (challenge_id, event_type),
  CONSTRAINT ck_worker_auth_security_events_reason CHECK (
    (
      event_type = 'CHALLENGE_REPLAY'
      AND reason_code = 'CHALLENGE_ALREADY_CONSUMED'
    )
    OR (
      event_type = 'WORKER_INCOMPATIBLE'
      AND reason_code IN (
        'WORKER_REGISTRATION_INCOMPATIBLE',
        'WORKER_VERSION_INCOMPATIBLE',
        'PROTOCOL_INCOMPATIBLE',
        'CODEX_RUNTIME_INCOMPATIBLE',
        'CODEX_PROTOCOL_INCOMPATIBLE',
        'ISOLATION_INCOMPATIBLE'
      )
      AND original_session_id IS NULL
    )
  )
);

CREATE TRIGGER worker_auth_security_events_immutable
BEFORE UPDATE OR DELETE ON worker_auth_security_events
FOR EACH ROW EXECUTE FUNCTION reject_creator_agent_immutable_mutation();

-- PostgreSQL roles must not be able to turn a bounded jsonb column into an
-- accidental Prompt/answer/raw-frame sink.  These validators admit only the three
-- strict control frames that the Gateway itself can return.
CREATE OR REPLACE FUNCTION creator_agent_gateway_json_has_exact_keys(
  input_value jsonb,
  expected_keys text[]
) RETURNS boolean AS $$
BEGIN
  IF jsonb_typeof(input_value) <> 'object' THEN
    RETURN false;
  END IF;
  RETURN input_value ?& expected_keys
    AND (SELECT count(*) FROM jsonb_object_keys(input_value)) = cardinality(expected_keys);
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

CREATE OR REPLACE FUNCTION creator_agent_gateway_control_frame_is_safe(input_frame jsonb)
RETURNS boolean AS $$
DECLARE
  input_lease jsonb;
  input_body jsonb;
  uuid_v7_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
  iso_pattern constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$';
  uint63_pattern constant text := '^(0|[1-9][0-9]{0,18})$';
BEGIN
  IF NOT creator_agent_gateway_json_has_exact_keys(
    input_frame,
    ARRAY[
      'protocol', 'schemaVersion', 'kind', 'type', 'messageId', 'correlationId',
      'connectionId', 'sequence', 'sentAt', 'expiresAt', 'lease', 'body'
    ]
  ) THEN
    RETURN false;
  END IF;
  IF input_frame->>'protocol' <> 'combo.creator-broker/1'
     OR input_frame->>'schemaVersion' <> '1'
     OR input_frame->>'messageId' !~ uuid_v7_pattern
     OR input_frame->>'correlationId' !~ uuid_v7_pattern
     OR input_frame->>'connectionId' !~ uuid_v7_pattern
     OR input_frame->>'sequence' !~ uint63_pattern
     OR length(input_frame->>'sequence') > 19
     OR input_frame->>'sentAt' !~ iso_pattern
     OR input_frame->>'expiresAt' !~ iso_pattern THEN
    RETURN false;
  END IF;

  input_lease := input_frame->'lease';
  IF NOT creator_agent_gateway_json_has_exact_keys(
    input_lease,
    ARRAY['deploymentId', 'leaseId', 'workerSessionId', 'fence']
  ) OR input_lease->>'deploymentId' !~ uuid_v7_pattern
     OR input_lease->>'leaseId' !~ uuid_v7_pattern
     OR input_lease->>'workerSessionId' !~ uuid_v7_pattern
     OR input_lease->>'fence' !~ '^[1-9][0-9]{0,18}$'
     OR length(input_lease->>'fence') > 19 THEN
    RETURN false;
  END IF;

  input_body := input_frame->'body';
  CASE input_frame->>'type'
    WHEN 'lease.grant' THEN
      RETURN input_frame->>'kind' = 'command'
        AND creator_agent_gateway_json_has_exact_keys(
          input_body,
          ARRAY['leaseExpiresAt', 'workerSessionId', 'generation']
        )
        AND input_body->>'leaseExpiresAt' ~ iso_pattern
        AND input_body->>'workerSessionId' ~ uuid_v7_pattern
        AND input_body->>'leaseExpiresAt' = input_frame->>'expiresAt'
        AND input_body->>'workerSessionId' = input_lease->>'workerSessionId'
        AND input_body->>'generation' ~ uint63_pattern
        AND length(input_body->>'generation') <= 19;
    WHEN 'message.ack' THEN
      RETURN input_frame->>'kind' = 'ack'
        AND creator_agent_gateway_json_has_exact_keys(
          input_body,
          ARRAY['acknowledgedMessageId', 'level', 'decision']
        )
        AND input_body->>'acknowledgedMessageId' ~ uuid_v7_pattern
        AND input_body->>'level' IN ('RECEIVED', 'PERSISTED', 'CLOUD_COMMITTED')
        AND input_body->>'decision' IN (
          'APPLIED', 'IDEMPOTENT_REPLAY', 'NOOP_TERMINAL', 'RECONCILE', 'SECURITY_BLOCK'
        );
    WHEN 'lease.revoke' THEN
      RETURN input_frame->>'kind' = 'command'
        AND creator_agent_gateway_json_has_exact_keys(input_body, ARRAY['reason', 'effectiveAt'])
        AND input_body->>'reason' IN (
          'SESSION_REPLACED', 'DRAIN', 'IMMEDIATE', 'SECURITY', 'INSTALLATION_REVOKED'
        )
        AND input_body->>'effectiveAt' ~ iso_pattern;
    ELSE
      RETURN false;
  END CASE;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

CREATE OR REPLACE FUNCTION creator_agent_gateway_control_frame_batch_is_safe(
  input_frames jsonb,
  allowed_types text[],
  maximum_count integer
) RETURNS boolean AS $$
DECLARE
  input_frame jsonb;
BEGIN
  IF jsonb_typeof(input_frames) <> 'array'
     OR jsonb_array_length(input_frames) > maximum_count THEN
    RETURN false;
  END IF;
  FOR input_frame IN SELECT value FROM jsonb_array_elements(input_frames)
  LOOP
    IF NOT creator_agent_gateway_control_frame_is_safe(input_frame)
       OR NOT (input_frame->>'type' = ANY(allowed_types)) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

CREATE OR REPLACE FUNCTION creator_agent_gateway_accept_response_batch_is_safe(
  input_frames jsonb
) RETURNS boolean AS $$
DECLARE
  frame_count integer;
  first_type text;
  second_type text;
BEGIN
  IF NOT creator_agent_gateway_control_frame_batch_is_safe(
    input_frames,
    ARRAY['lease.grant', 'message.ack', 'lease.revoke'],
    2
  ) THEN
    RETURN false;
  END IF;
  frame_count := jsonb_array_length(input_frames);
  IF frame_count = 0 THEN
    RETURN true;
  END IF;
  first_type := input_frames->0->>'type';
  IF frame_count = 1 THEN
    RETURN first_type IN ('message.ack', 'lease.revoke');
  END IF;
  second_type := input_frames->1->>'type';
  RETURN (first_type = 'lease.grant' AND second_type = 'message.ack')
      OR (first_type = 'message.ack' AND second_type = 'lease.revoke');
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

CREATE OR REPLACE FUNCTION creator_agent_gateway_operation_result_is_safe(
  input_kind text,
  input_result jsonb
) RETURNS boolean AS $$
DECLARE
  input_session jsonb;
  uuid_v7_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
BEGIN
  CASE input_kind
    WHEN 'ISSUE_CHALLENGE' THEN
      RETURN creator_agent_gateway_json_has_exact_keys(input_result, ARRAY['challengeId'])
        AND input_result->>'challengeId' ~ uuid_v7_pattern;
    WHEN 'AUTHENTICATE' THEN
      IF creator_agent_gateway_json_has_exact_keys(input_result, ARRAY['kind', 'session'])
         AND input_result->>'kind' = 'AUTHENTICATED' THEN
        input_session := input_result->'session';
        RETURN COALESCE(
          creator_agent_gateway_json_has_exact_keys(
            input_session,
            ARRAY['ownerId', 'installationId', 'connectionId', 'workerSessionId']
          )
          AND input_session->>'ownerId' ~ uuid_v7_pattern
          AND input_session->>'installationId' ~ uuid_v7_pattern
          AND input_session->>'connectionId' ~ uuid_v7_pattern
          AND input_session->>'workerSessionId' ~ uuid_v7_pattern,
          false
        );
      END IF;
      RETURN COALESCE(
        creator_agent_gateway_json_has_exact_keys(input_result, ARRAY['kind', 'code'])
        AND input_result->>'kind' = 'REJECTED'
        AND input_result->>'code' = 'WORKER_INCOMPATIBLE',
        false
      );
    WHEN 'AUDIT_CHALLENGE_REPLAY' THEN
      RETURN COALESCE(
        creator_agent_gateway_json_has_exact_keys(input_result, ARRAY['recorded'])
        AND input_result->'recorded' = 'true'::jsonb,
        false
      );
    WHEN 'OPEN_SESSION' THEN
      RETURN creator_agent_gateway_control_frame_batch_is_safe(
        input_result,
        ARRAY['lease.grant'],
        1
      );
    WHEN 'ACCEPT_ENVELOPE' THEN
      IF creator_agent_gateway_json_has_exact_keys(input_result, ARRAY['kind'])
         AND input_result->>'kind' = 'SEQUENCE_CONFLICT' THEN
        RETURN true;
      END IF;
      RETURN creator_agent_gateway_json_has_exact_keys(input_result, ARRAY['kind', 'responses'])
        AND input_result->>'kind' = 'RESPONSES'
        AND creator_agent_gateway_accept_response_batch_is_safe(input_result->'responses');
    WHEN 'SEQUENCE_GAP', 'CLOSE_SESSION' THEN
      RETURN input_result = 'null'::jsonb;
    ELSE
      RETURN false;
  END CASE;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

REVOKE ALL ON FUNCTION creator_agent_gateway_json_has_exact_keys(jsonb, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION creator_agent_gateway_control_frame_is_safe(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION creator_agent_gateway_control_frame_batch_is_safe(jsonb, text[], integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION creator_agent_gateway_accept_response_batch_is_safe(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION creator_agent_gateway_operation_result_is_safe(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION creator_agent_gateway_json_has_exact_keys(jsonb, text[])
  TO combo_agent_api, combo_agent_broker;
GRANT EXECUTE ON FUNCTION creator_agent_gateway_control_frame_is_safe(jsonb)
  TO combo_agent_api, combo_agent_broker;
GRANT EXECUTE ON FUNCTION creator_agent_gateway_control_frame_batch_is_safe(jsonb, text[], integer)
  TO combo_agent_api, combo_agent_broker;
GRANT EXECUTE ON FUNCTION creator_agent_gateway_accept_response_batch_is_safe(jsonb)
  TO combo_agent_api, combo_agent_broker;
GRANT EXECUTE ON FUNCTION creator_agent_gateway_operation_result_is_safe(text, jsonb)
  TO combo_agent_api, combo_agent_broker;

-- A transaction operation receipt resolves the only unsafe ambiguity left after a
-- PostgreSQL COMMIT has been submitted and the client transport disappears.  The
-- stable operation key is chosen before BEGIN, locked with pg_advisory_xact_lock,
-- and inserted in the same transaction as the mutation. A recovery connection takes
-- the same lock and can therefore distinguish an exact committed result from a
-- rolled-back operation without re-running the mutation.  Results are strict,
-- bounded control-plane values only; Prompt/answer/ciphertext/raw frames are banned.
CREATE TABLE worker_gateway_operation_receipts (
  creator_id       uuid        NOT NULL REFERENCES users (id),
  operation_kind   text        NOT NULL CHECK (
    operation_kind IN (
      'ISSUE_CHALLENGE', 'AUTHENTICATE', 'OPEN_SESSION',
      'AUDIT_CHALLENGE_REPLAY', 'ACCEPT_ENVELOPE',
      'SEQUENCE_GAP', 'CLOSE_SESSION'
    )
  ),
  operation_key    text        NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 256),
  request_digest   text        NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  result_value     jsonb       NOT NULL CHECK (
    octet_length(result_value::text) <= 16384
    AND creator_agent_gateway_operation_result_is_safe(operation_kind, result_value)
  ),
  result_digest    text        NOT NULL CHECK (result_digest ~ '^[a-f0-9]{64}$'),
  committed_at     timestamptz NOT NULL DEFAULT statement_timestamp(),
  retained_until   timestamptz NOT NULL DEFAULT statement_timestamp() + interval '7 days',
  CONSTRAINT ck_worker_gateway_operation_receipts_retention CHECK (
    retained_until = committed_at + interval '7 days'
  ),
  PRIMARY KEY (creator_id, operation_kind, operation_key)
);

CREATE INDEX idx_worker_gateway_operation_receipts_retention
  ON worker_gateway_operation_receipts (retained_until, creator_id, operation_kind, operation_key);

CREATE TRIGGER worker_gateway_operation_receipts_immutable
BEFORE UPDATE OR DELETE ON worker_gateway_operation_receipts
FOR EACH ROW EXECUTE FUNCTION reject_creator_agent_immutable_mutation();

-- This append-only receipt intentionally stores no Prompt, answer, ciphertext, raw
-- frame, credential, path, or free-form Host error. The response is a bounded array
-- of strict ACK/control frames and is re-validated by the application before replay.
CREATE TABLE worker_gateway_frame_receipts (
  session_id       uuid        NOT NULL,
  creator_id       uuid        NOT NULL,
  sequence         bigint      NOT NULL CHECK (sequence BETWEEN 0 AND 9223372036854775807),
  message_id       uuid        NOT NULL,
  canonical_digest text        NOT NULL CHECK (canonical_digest ~ '^[a-f0-9]{64}$'),
  envelope_type    text        NOT NULL CHECK (length(envelope_type) BETWEEN 1 AND 64),
  response_frames  jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(response_frames) = 'array'
    AND jsonb_array_length(response_frames) <= 2
    AND octet_length(response_frames::text) <= 8192
    AND creator_agent_gateway_accept_response_batch_is_safe(response_frames)
  ),
  committed_at     timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (session_id, sequence),
  CONSTRAINT fk_worker_gateway_frame_receipts_session
    FOREIGN KEY (session_id, creator_id)
    REFERENCES worker_gateway_sessions (id, creator_id),
  CONSTRAINT uq_worker_gateway_frame_receipts_message UNIQUE (session_id, message_id)
);

CREATE TRIGGER worker_gateway_frame_receipts_immutable
BEFORE UPDATE OR DELETE ON worker_gateway_frame_receipts
FOR EACH ROW EXECUTE FUNCTION reject_creator_agent_immutable_mutation();

-- A conflicting replay is a security fact, not a retryable transport error. Store
-- only immutable identifiers/digests; never retain the conflicting raw frame.
CREATE TABLE worker_gateway_security_events (
  id                       bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id               uuid        NOT NULL,
  creator_id               uuid        NOT NULL,
  existing_sequence        bigint      NOT NULL CHECK (
    existing_sequence BETWEEN 0 AND 9223372036854775807
  ),
  sequence                 bigint      NOT NULL CHECK (sequence BETWEEN 0 AND 9223372036854775807),
  event_type               text        NOT NULL CHECK (event_type = 'SEQUENCE_CONFLICT'),
  existing_message_id      uuid        NOT NULL,
  received_message_id      uuid        NOT NULL,
  existing_canonical_digest text       NOT NULL CHECK (existing_canonical_digest ~ '^[a-f0-9]{64}$'),
  received_canonical_digest text       NOT NULL CHECK (received_canonical_digest ~ '^[a-f0-9]{64}$'),
  recorded_at              timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT fk_worker_gateway_security_events_session
    FOREIGN KEY (session_id, creator_id)
    REFERENCES worker_gateway_sessions (id, creator_id),
  CONSTRAINT uq_worker_gateway_security_events_conflict UNIQUE (
    session_id,
    existing_sequence,
    sequence,
    existing_message_id,
    received_message_id,
    existing_canonical_digest,
    received_canonical_digest
  )
);

CREATE TRIGGER worker_gateway_security_events_immutable
BEFORE UPDATE OR DELETE ON worker_gateway_security_events
FOR EACH ROW EXECUTE FUNCTION reject_creator_agent_immutable_mutation();

CREATE TABLE worker_gateway_outbound_frames (
  session_id        uuid        NOT NULL,
  creator_id        uuid        NOT NULL,
  sequence          bigint      NOT NULL CHECK (sequence BETWEEN 0 AND 9223372036854775807),
  message_id        uuid        NOT NULL,
  canonical_digest  text        NOT NULL CHECK (canonical_digest ~ '^[a-f0-9]{64}$'),
  envelope_type     text        NOT NULL CHECK (length(envelope_type) BETWEEN 1 AND 64),
  grant_lease_id    uuid,
  grant_fence       bigint      CHECK (
    grant_fence IS NULL OR grant_fence BETWEEN 1 AND 9223372036854775807
  ),
  grant_expires_at  timestamptz,
  durable_ack_level text        CHECK (
    durable_ack_level IS NULL OR durable_ack_level IN ('RECEIVED', 'PERSISTED', 'CLOUD_COMMITTED')
  ),
  ack_decision      text        CHECK (
    ack_decision IS NULL
    OR ack_decision IN (
      'APPLIED', 'IDEMPOTENT_REPLAY', 'NOOP_TERMINAL', 'RECONCILE', 'SECURITY_BLOCK'
    )
  ),
  acked_at          timestamptz,
  created_at        timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (session_id, sequence),
  CONSTRAINT fk_worker_gateway_outbound_frames_session
    FOREIGN KEY (session_id, creator_id)
    REFERENCES worker_gateway_sessions (id, creator_id),
  CONSTRAINT uq_worker_gateway_outbound_frames_message UNIQUE (message_id),
  CONSTRAINT ck_worker_gateway_outbound_frames_grant_binding CHECK (
    (
      envelope_type = 'lease.grant'
      AND grant_lease_id IS NOT NULL
      AND grant_fence IS NOT NULL
      AND grant_expires_at IS NOT NULL
    )
    OR (
      envelope_type <> 'lease.grant'
      AND grant_lease_id IS NULL
      AND grant_fence IS NULL
      AND grant_expires_at IS NULL
    )
  ),
  CONSTRAINT ck_worker_gateway_outbound_frames_ack CHECK (
    (durable_ack_level IS NULL AND ack_decision IS NULL AND acked_at IS NULL)
    OR (durable_ack_level IS NOT NULL AND ack_decision IS NOT NULL AND acked_at IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION enforce_creator_agent_gateway_outbound_transition()
RETURNS trigger AS $$
DECLARE
  old_ack_rank integer;
  new_ack_rank integer;
BEGIN
  IF NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.creator_id IS DISTINCT FROM OLD.creator_id
     OR NEW.sequence IS DISTINCT FROM OLD.sequence
     OR NEW.message_id IS DISTINCT FROM OLD.message_id
     OR NEW.canonical_digest IS DISTINCT FROM OLD.canonical_digest
     OR NEW.envelope_type IS DISTINCT FROM OLD.envelope_type
     OR NEW.grant_lease_id IS DISTINCT FROM OLD.grant_lease_id
     OR NEW.grant_fence IS DISTINCT FROM OLD.grant_fence
     OR NEW.grant_expires_at IS DISTINCT FROM OLD.grant_expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'worker gateway outbound frame binding is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.durable_ack_level = 'CLOUD_COMMITTED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'cloud-committed gateway outbound frame is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.ack_decision IS NOT NULL AND NEW.ack_decision IS DISTINCT FROM OLD.ack_decision THEN
    RAISE EXCEPTION 'worker gateway ACK decision is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.acked_at IS NOT NULL AND NEW.acked_at IS DISTINCT FROM OLD.acked_at THEN
    RAISE EXCEPTION 'worker gateway first ACK time is immutable'
      USING ERRCODE = '55000';
  END IF;
  old_ack_rank := CASE COALESCE(OLD.durable_ack_level, '')
    WHEN '' THEN 0
    WHEN 'RECEIVED' THEN 1
    WHEN 'PERSISTED' THEN 2
    WHEN 'CLOUD_COMMITTED' THEN 3
    ELSE 4
  END;
  new_ack_rank := CASE COALESCE(NEW.durable_ack_level, '')
    WHEN '' THEN 0
    WHEN 'RECEIVED' THEN 1
    WHEN 'PERSISTED' THEN 2
    WHEN 'CLOUD_COMMITTED' THEN 3
    ELSE -1
  END;
  IF new_ack_rank < old_ack_rank THEN
    RAISE EXCEPTION 'worker gateway ACK level is monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION enforce_creator_agent_gateway_outbound_transition() FROM PUBLIC;

CREATE TRIGGER worker_gateway_outbound_frames_transition
BEFORE UPDATE ON worker_gateway_outbound_frames
FOR EACH ROW EXECUTE FUNCTION enforce_creator_agent_gateway_outbound_transition();

CREATE TABLE worker_gateway_sequence_gaps (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id   uuid        NOT NULL,
  creator_id   uuid        NOT NULL,
  expected_seq bigint      NOT NULL CHECK (expected_seq BETWEEN 0 AND 9223372036854775807),
  received_seq bigint      NOT NULL CHECK (received_seq BETWEEN 0 AND 9223372036854775807),
  detected_at  timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT fk_worker_gateway_sequence_gaps_session
    FOREIGN KEY (session_id, creator_id)
    REFERENCES worker_gateway_sessions (id, creator_id)
);

CREATE TRIGGER worker_gateway_sequence_gaps_immutable
BEFORE UPDATE OR DELETE ON worker_gateway_sequence_gaps
FOR EACH ROW EXECUTE FUNCTION reject_creator_agent_immutable_mutation();

-- Authoring/Creator API receives an authenticated creator context and can only ask
-- this narrow definer to rotate one challenge for one already-owned installation.
CREATE OR REPLACE FUNCTION creator_agent_issue_worker_challenge(
  requested_installation_id uuid,
  requested_deployment_id uuid,
  requested_deployment_generation bigint,
  ttl_seconds integer DEFAULT 60
) RETURNS uuid AS $$
DECLARE
  expected_creator uuid;
  issued_id uuid;
  issued_now timestamptz := statement_timestamp();
BEGIN
  IF session_user <> 'combo_agent_api' THEN
    RAISE EXCEPTION 'worker challenge issuer role is invalid'
      USING ERRCODE = '42501';
  END IF;
  expected_creator := NULLIF(current_setting('app.creator_id', true), '')::uuid;
  IF expected_creator IS NULL
     OR requested_installation_id IS NULL
     OR requested_deployment_id IS NULL
     OR requested_deployment_generation IS NULL
     OR requested_deployment_generation < 0
     OR ttl_seconds IS NULL
     OR ttl_seconds < 10
     OR ttl_seconds > 120 THEN
    RAISE EXCEPTION 'worker challenge request is invalid'
      USING ERRCODE = '22023';
  END IF;
  PERFORM 1
    FROM public.worker_installations AS installation
    JOIN public.deployments AS deployment
      ON deployment.id = requested_deployment_id
     AND deployment.creator_id = installation.creator_id
   WHERE installation.id = requested_installation_id
     AND installation.creator_id = expected_creator
     AND installation.revoked_at IS NULL
     AND deployment.desired_state = 'ONLINE'
     AND deployment.generation = requested_deployment_generation
   FOR UPDATE OF installation, deployment;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'worker installation or deployment is unavailable'
      USING ERRCODE = 'P0002';
  END IF;
  UPDATE public.worker_auth_challenges
     SET state = 'REVOKED', consumed_at = issued_now
   WHERE installation_id = requested_installation_id
     AND creator_id = expected_creator
     AND state = 'ISSUED';
  INSERT INTO public.worker_auth_challenges (
    creator_id, installation_id, deployment_id, deployment_generation, expires_at
  ) VALUES (
    expected_creator,
    requested_installation_id,
    requested_deployment_id,
    requested_deployment_generation,
    issued_now + pg_catalog.make_interval(secs => ttl_seconds)
  )
  RETURNING id INTO issued_id;
  RETURN issued_id;
END;
-- public is required only because the published gen_uuid_v7() resolves pgcrypto's
-- public.gen_random_bytes at execution time. 0008 revoked CREATE on public from
-- application roles, and every table reference above remains schema-qualified.
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public SET row_security = on;

REVOKE ALL ON FUNCTION creator_agent_issue_worker_challenge(uuid, uuid, bigint, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION creator_agent_issue_worker_challenge(uuid, uuid, bigint, integer)
  TO combo_agent_api;

-- Gateway calls this as combo_agent_broker before it knows creator_id. The row lock
-- survives for the caller transaction; no public key or credential is returned.
CREATE OR REPLACE FUNCTION creator_agent_lock_worker_challenge(
  requested_challenge_id uuid,
  requested_installation_id uuid
) RETURNS uuid AS $$
DECLARE
  challenge_creator uuid;
BEGIN
  IF session_user <> 'combo_agent_broker' THEN
    RAISE EXCEPTION 'worker challenge verifier role is invalid'
      USING ERRCODE = '42501';
  END IF;
  SELECT creator_id
    INTO challenge_creator
    FROM public.worker_auth_challenges
   WHERE id = requested_challenge_id
     AND installation_id = requested_installation_id
     AND state = 'ISSUED'
     AND expires_at > statement_timestamp()
   FOR UPDATE;
  RETURN challenge_creator;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET row_security = on;

REVOKE ALL ON FUNCTION creator_agent_lock_worker_challenge(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION creator_agent_lock_worker_challenge(uuid, uuid) TO combo_agent_broker;

-- A replay cannot use the ISSUED-only resolver above. After an exact signed nonce
-- is presented again, the Broker may resolve and lock only its exact consumed
-- (challenge, installation) pair. The caller still receives only creator_id and
-- must establish tenant context before reading the installation or original session.
CREATE OR REPLACE FUNCTION creator_agent_lock_consumed_worker_challenge(
  requested_challenge_id uuid,
  requested_installation_id uuid
) RETURNS uuid AS $$
DECLARE
  challenge_creator uuid;
BEGIN
  IF session_user <> 'combo_agent_broker' THEN
    RAISE EXCEPTION 'consumed worker challenge verifier role is invalid'
      USING ERRCODE = '42501';
  END IF;
  SELECT creator_id
    INTO challenge_creator
    FROM public.worker_auth_challenges
   WHERE id = requested_challenge_id
     AND installation_id = requested_installation_id
     AND state = 'CONSUMED'
   FOR UPDATE;
  RETURN challenge_creator;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET row_security = on;

REVOKE ALL ON FUNCTION creator_agent_lock_consumed_worker_challenge(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION creator_agent_lock_consumed_worker_challenge(uuid, uuid)
  TO combo_agent_broker;

ALTER TABLE worker_auth_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_auth_challenges FORCE ROW LEVEL SECURITY;
ALTER TABLE worker_gateway_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_gateway_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE worker_auth_security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_auth_security_events FORCE ROW LEVEL SECURITY;
ALTER TABLE worker_gateway_operation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_gateway_operation_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE worker_gateway_frame_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_gateway_frame_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE worker_gateway_security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_gateway_security_events FORCE ROW LEVEL SECURITY;
ALTER TABLE worker_gateway_outbound_frames ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_gateway_outbound_frames FORCE ROW LEVEL SECURITY;
ALTER TABLE worker_gateway_sequence_gaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_gateway_sequence_gaps FORCE ROW LEVEL SECURITY;

-- A SECURITY version transition is authoritative only after every affected
-- Deployment, Lease and Gateway Session has been fenced in the same transaction.
-- Heartbeat processing acquires the same per-Deployment advisory key before it
-- locks mutable rows. Therefore either the heartbeat commits first and this
-- trigger immediately revokes it, or this trigger commits first and the heartbeat
-- cannot renew the revoked Lease. No broad cross-Consumer Invocation UPDATE policy
-- is required merely to inspect the current Lease's pinned work.
CREATE OR REPLACE FUNCTION creator_agent_cascade_version_security_revocation()
RETURNS trigger AS $$
DECLARE
  affected_deployment record;
BEGIN
  IF (NEW.availability <> 'REVOKED' AND NEW.severity <> 'SECURITY')
     OR (OLD.availability = 'REVOKED' OR OLD.severity = 'SECURITY') THEN
    RETURN NEW;
  END IF;

  FOR affected_deployment IN
    SELECT deployment.id, deployment.creator_id
      FROM public.deployments AS deployment
     WHERE deployment.creator_id = NEW.creator_id
       AND (
         deployment.desired_version_id = NEW.version_id
         OR deployment.serving_version_id = NEW.version_id
         OR EXISTS (
           SELECT 1
             FROM public.agent_invocations AS invocation
             JOIN public.worker_leases AS invocation_lease
               ON invocation_lease.id = invocation.assignment_lease_id
              AND invocation_lease.creator_id = invocation.creator_id
              AND invocation_lease.worker_id = invocation.assigned_worker_id
              AND invocation_lease.fence = invocation.assignment_fence
            WHERE invocation.creator_id = NEW.creator_id
              AND invocation.agent_version_id = NEW.version_id
              AND invocation_lease.deployment_id = deployment.id
              AND invocation.state NOT IN (
                'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN', 'EXPIRED'
              )
         )
       )
     ORDER BY deployment.id
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'combo.gateway.deployment/v1:'
          || affected_deployment.creator_id::text
          || ':'
          || affected_deployment.id::text,
        0
      )
    );

    UPDATE public.worker_leases
       SET state = 'REVOKED'
     WHERE creator_id = affected_deployment.creator_id
       AND deployment_id = affected_deployment.id
       AND state = 'ACTIVE';

    UPDATE public.worker_gateway_sessions AS gateway
       SET state = 'REVOKED',
           closed_at = statement_timestamp(),
           disconnect_reason = 'AUTH_FAILED'
     WHERE gateway.creator_id = affected_deployment.creator_id
       AND gateway.state = 'ACTIVE'
       AND EXISTS (
         SELECT 1
           FROM public.worker_leases AS lease
          WHERE lease.creator_id = affected_deployment.creator_id
            AND lease.deployment_id = affected_deployment.id
            AND lease.worker_id = gateway.installation_id
            AND lease.connection_id = gateway.connection_id
            AND lease.state = 'REVOKED'
       );

    UPDATE public.deployments
       SET observed_state = 'BLOCKED',
           observed_generation = generation,
           last_error_code = 'VERSION_SECURITY_REVOKED',
           updated_at = statement_timestamp()
     WHERE id = affected_deployment.id
       AND creator_id = affected_deployment.creator_id;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION creator_agent_cascade_version_security_revocation() FROM PUBLIC;

CREATE TRIGGER agent_version_controls_gateway_security_cascade
AFTER UPDATE ON agent_version_controls
FOR EACH ROW EXECUTE FUNCTION creator_agent_cascade_version_security_revocation();

CREATE POLICY worker_auth_challenges_tenant ON worker_auth_challenges
  USING (creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid)
  WITH CHECK (creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid);
-- The Broker does not know creator_id until it resolves the opaque challenge. Only
-- the SECURITY DEFINER lookup gets this cross-tenant read: direct Broker SQL has
-- current_user=session_user and therefore cannot use this policy.
CREATE POLICY worker_auth_challenges_definer_lookup ON worker_auth_challenges
  FOR SELECT
  USING (
    session_user = 'combo_agent_broker'
    AND current_user <> session_user
  );
CREATE POLICY worker_gateway_sessions_tenant ON worker_gateway_sessions
  USING (
    current_user = 'combo_agent_broker'
    AND creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
  )
  WITH CHECK (
    current_user = 'combo_agent_broker'
    AND creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
  );
CREATE POLICY worker_auth_security_events_tenant ON worker_auth_security_events
  USING (
    current_user = 'combo_agent_broker'
    AND creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
  )
  WITH CHECK (
    current_user = 'combo_agent_broker'
    AND creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
  );
CREATE POLICY worker_gateway_operation_receipts_api_tenant
  ON worker_gateway_operation_receipts
  USING (
    current_user = 'combo_agent_api'
    AND operation_kind = 'ISSUE_CHALLENGE'
    AND creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
  )
  WITH CHECK (
    current_user = 'combo_agent_api'
    AND operation_kind = 'ISSUE_CHALLENGE'
    AND creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
  );
CREATE POLICY worker_gateway_operation_receipts_broker_tenant
  ON worker_gateway_operation_receipts
  USING (
    current_user = 'combo_agent_broker'
    AND operation_kind <> 'ISSUE_CHALLENGE'
    AND creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
  )
  WITH CHECK (
    current_user = 'combo_agent_broker'
    AND operation_kind <> 'ISSUE_CHALLENGE'
    AND creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
  );
CREATE POLICY worker_gateway_frame_receipts_tenant ON worker_gateway_frame_receipts
  USING (
    current_user = 'combo_agent_broker'
    AND creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
  )
  WITH CHECK (
    current_user = 'combo_agent_broker'
    AND creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
  );
CREATE POLICY worker_gateway_security_events_tenant ON worker_gateway_security_events
  USING (
    current_user = 'combo_agent_broker'
    AND creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
  )
  WITH CHECK (
    current_user = 'combo_agent_broker'
    AND creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
  );
CREATE POLICY worker_gateway_outbound_frames_tenant ON worker_gateway_outbound_frames
  USING (
    current_user = 'combo_agent_broker'
    AND creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
  )
  WITH CHECK (
    current_user = 'combo_agent_broker'
    AND creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
  );
CREATE POLICY worker_gateway_sequence_gaps_tenant ON worker_gateway_sequence_gaps
  USING (
    current_user = 'combo_agent_broker'
    AND creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
  )
  WITH CHECK (
    current_user = 'combo_agent_broker'
    AND creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
  );

REVOKE ALL PRIVILEGES ON
  worker_auth_challenges,
  worker_gateway_sessions,
  worker_auth_security_events,
  worker_gateway_operation_receipts,
  worker_gateway_frame_receipts,
  worker_gateway_security_events,
  worker_gateway_outbound_frames,
  worker_gateway_sequence_gaps
FROM PUBLIC, combo_api, combo_worker, combo_runtime,
  combo_agent_api, combo_agent_broker, combo_agent_reconciler, combo_agent_maintenance;

GRANT SELECT, UPDATE ON worker_auth_challenges TO combo_agent_broker;
GRANT SELECT, INSERT, UPDATE ON worker_gateway_sessions TO combo_agent_broker;
GRANT SELECT, INSERT ON worker_auth_security_events TO combo_agent_broker;
GRANT USAGE, SELECT ON SEQUENCE worker_auth_security_events_id_seq TO combo_agent_broker;
GRANT SELECT, INSERT ON worker_gateway_operation_receipts TO combo_agent_api;
GRANT SELECT, INSERT ON worker_gateway_operation_receipts TO combo_agent_broker;
GRANT SELECT, INSERT ON worker_gateway_frame_receipts TO combo_agent_broker;
GRANT SELECT, INSERT ON worker_gateway_security_events TO combo_agent_broker;
GRANT USAGE, SELECT ON SEQUENCE worker_gateway_security_events_id_seq TO combo_agent_broker;
GRANT SELECT, INSERT, UPDATE ON worker_gateway_outbound_frames TO combo_agent_broker;
GRANT SELECT, INSERT ON worker_gateway_sequence_gaps TO combo_agent_broker;
GRANT USAGE, SELECT ON SEQUENCE worker_gateway_sequence_gaps_id_seq TO combo_agent_broker;
