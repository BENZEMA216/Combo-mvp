-- Phase A installs only the durable, Test-environment conversation.open claim contract.
-- It does not start a Gateway process or enable a publisher. Existing v1 delivery rows cannot be
-- given exact historical wire timestamps, so the expand is deliberately gated before ALTER.

LOCK TABLE public.worker_gateway_outbound_frames IN ACCESS EXCLUSIVE MODE;

DO $broker_publisher_zero_delivery_gate$
DECLARE
  v1_delivery_count bigint;
BEGIN
  SELECT count(*)
    INTO v1_delivery_count
    FROM public.worker_gateway_outbound_frames
   WHERE delivery_contract_version = 1;

  IF v1_delivery_count <> 0 THEN
    RAISE EXCEPTION
      '0019 Broker publisher migration requires zero v1 delivery rows; found %',
      v1_delivery_count
      USING ERRCODE = '55000';
  END IF;
END
$broker_publisher_zero_delivery_gate$;

-- A delivery retry must reproduce the exact same Session wire frame. Session and Lease expiry
-- can move after the first claim, so neither may be consulted to reconstruct historical bytes.
ALTER TABLE public.worker_gateway_outbound_frames
  DROP CONSTRAINT ck_worker_gateway_outbound_delivery_contract,
  ADD COLUMN wire_sent_at timestamptz,
  ADD COLUMN wire_expires_at timestamptz,
  ADD CONSTRAINT ck_worker_gateway_outbound_delivery_contract CHECK (
    (
      delivery_contract_version = 0
      AND broker_command_id IS NULL
      AND broker_target_worker_id IS NULL
      AND broker_deployment_id IS NULL
      AND claim_session_id IS NULL
      AND claim_connection_id IS NULL
      AND current_delivery_lease_id IS NULL
      AND current_delivery_fence IS NULL
      AND wire_sent_at IS NULL
      AND wire_expires_at IS NULL
    )
    OR
    (
      delivery_contract_version = 1
      AND broker_command_id IS NOT NULL
      AND message_id = broker_command_id
      AND broker_target_worker_id IS NOT NULL
      AND broker_deployment_id IS NOT NULL
      AND claim_session_id = session_id
      AND claim_connection_id IS NOT NULL
      AND current_delivery_lease_id IS NOT NULL
      AND current_delivery_fence BETWEEN 1 AND 9223372036854775807
      AND envelope_type = 'conversation.open'
      AND wire_sent_at IS NOT NULL
      AND wire_expires_at > wire_sent_at
    )
  );

COMMENT ON COLUMN public.worker_gateway_outbound_frames.wire_sent_at IS
  'Immutable PostgreSQL transaction timestamp used by an exact v1 Session wire delivery.';
COMMENT ON COLUMN public.worker_gateway_outbound_frames.wire_expires_at IS
  'Immutable minimum of command, current Session, and current Lease expiry at first claim.';

-- A replacement Worker can durably replay its SQLite PERSISTED acknowledgement before the
-- publisher has had an opportunity to create the replacement Session delivery. Preserve only
-- the acknowledgement binding needed to converge that ordering window; the raw inbound frame,
-- Prompt, answer, ciphertext, and free-form error remain outside this append-only receipt. The
-- all-NULL branch is an intentional expand/rollback window for pre-0019 Gateway binaries; partial
-- metadata and metadata on a non-ACK receipt are rejected.
ALTER TABLE public.worker_gateway_frame_receipts
  ADD COLUMN broker_acknowledged_message_id uuid,
  ADD COLUMN broker_ack_level text,
  ADD COLUMN broker_ack_decision text,
  ADD CONSTRAINT ck_worker_gateway_frame_receipts_broker_ack CHECK (
    (
      broker_acknowledged_message_id IS NULL
      AND broker_ack_level IS NULL
      AND broker_ack_decision IS NULL
    )
    OR
    (
      envelope_type = 'message.ack'
      AND broker_acknowledged_message_id IS NOT NULL
      AND broker_ack_level IS NOT NULL
      AND broker_ack_level IN ('RECEIVED', 'PERSISTED', 'CLOUD_COMMITTED')
      AND broker_ack_decision IS NOT NULL
      AND broker_ack_decision IN (
        'APPLIED', 'IDEMPOTENT_REPLAY', 'NOOP_TERMINAL', 'RECONCILE', 'SECURITY_BLOCK'
      )
    )
  );

COMMENT ON COLUMN public.worker_gateway_frame_receipts.broker_acknowledged_message_id IS
  'Identifier-only binding for an accepted inbound message.ack; never a raw Broker frame.';
COMMENT ON COLUMN public.worker_gateway_frame_receipts.broker_ack_level IS
  'Validated durable level of the accepted inbound message.ack.';
COMMENT ON COLUMN public.worker_gateway_frame_receipts.broker_ack_decision IS
  'Validated decision of the accepted inbound message.ack.';

CREATE INDEX idx_worker_gateway_frame_receipts_broker_ack
  ON public.worker_gateway_frame_receipts (
    session_id, creator_id, broker_acknowledged_message_id, committed_at
  )
  WHERE broker_acknowledged_message_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.enforce_creator_agent_gateway_outbound_insert()
RETURNS trigger AS $$
BEGIN
  IF NEW.delivery_contract_version = 0
     AND NEW.envelope_type IN (
       'conversation.open',
       'invocation.prepare', 'invocation.start', 'invocation.cancel',
       'deployment.prepare', 'deployment.drain'
     )
     AND current_user IN (
       'combo_agent_api',
       'combo_agent_broker',
       'combo_agent_reconciler',
       'combo_agent_consumer_api'
     ) THEN
    RAISE EXCEPTION 'legacy Broker delivery contract cannot claim a business command'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.delivery_contract_version = 1 THEN
    PERFORM 1
      FROM public.broker_outbox AS command
      JOIN public.worker_gateway_sessions AS gateway
        ON gateway.id = NEW.claim_session_id
       AND gateway.creator_id = command.creator_id
       AND gateway.installation_id = command.target_worker_id
       AND gateway.connection_id = NEW.claim_connection_id
      JOIN public.deployments AS current_deployment
        ON current_deployment.id = command.deployment_id
       AND current_deployment.creator_id = command.creator_id
      JOIN public.worker_leases AS delivery_lease
        ON delivery_lease.id = NEW.current_delivery_lease_id
       AND delivery_lease.deployment_id = command.deployment_id
       AND delivery_lease.creator_id = command.creator_id
       AND delivery_lease.worker_id = command.target_worker_id
       AND delivery_lease.connection_id = gateway.connection_id
       AND delivery_lease.fence = NEW.current_delivery_fence
     WHERE command.command_id = NEW.broker_command_id
       AND command.creator_id = NEW.creator_id
       AND command.payload_contract_version = 1
       AND command.command_type = NEW.envelope_type
       AND command.state IN ('PENDING', 'SENT')
       AND command.expires_at > clock_timestamp()
       AND gateway.state = 'ACTIVE'
       AND gateway.expires_at > clock_timestamp()
       AND current_deployment.environment = 'TEST'
       AND current_deployment.desired_state = 'ONLINE'
       AND current_deployment.observed_state = 'ONLINE'
       AND current_deployment.observed_worker_id = command.target_worker_id
       AND current_deployment.observed_generation = current_deployment.generation
       AND current_deployment.lease_fence = NEW.current_delivery_fence
       AND delivery_lease.state = 'ACTIVE'
       AND delivery_lease.expires_at > clock_timestamp()
       AND NEW.wire_sent_at = date_trunc('milliseconds', transaction_timestamp())
       AND NEW.wire_expires_at = date_trunc(
         'milliseconds',
         LEAST(command.expires_at, gateway.expires_at, delivery_lease.expires_at)
       )
       AND NEW.wire_expires_at > clock_timestamp() + interval '3 seconds'
     FOR UPDATE OF command
     FOR SHARE OF gateway, current_deployment, delivery_lease;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Broker business delivery lost current Test claim authority'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_gateway_outbound_insert() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.enforce_creator_agent_gateway_outbound_transition()
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
     OR NEW.delivery_contract_version IS DISTINCT FROM OLD.delivery_contract_version
     OR NEW.broker_command_id IS DISTINCT FROM OLD.broker_command_id
     OR NEW.broker_target_worker_id IS DISTINCT FROM OLD.broker_target_worker_id
     OR NEW.broker_deployment_id IS DISTINCT FROM OLD.broker_deployment_id
     OR NEW.claim_session_id IS DISTINCT FROM OLD.claim_session_id
     OR NEW.claim_connection_id IS DISTINCT FROM OLD.claim_connection_id
     OR NEW.current_delivery_lease_id IS DISTINCT FROM OLD.current_delivery_lease_id
     OR NEW.current_delivery_fence IS DISTINCT FROM OLD.current_delivery_fence
     OR NEW.wire_sent_at IS DISTINCT FROM OLD.wire_sent_at
     OR NEW.wire_expires_at IS DISTINCT FROM OLD.wire_expires_at
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

REVOKE ALL ON FUNCTION public.enforce_creator_agent_gateway_outbound_transition() FROM PUBLIC;

-- Operation receipts may retain only this identifier/digest-only business frame. Prompt,
-- answer, ciphertext, credential, path, and free-form error fields have no representation here.
CREATE OR REPLACE FUNCTION public.creator_agent_gateway_conversation_open_frame_is_safe(
  input_frame jsonb
) RETURNS boolean AS $$
DECLARE
  input_lease jsonb;
  input_body jsonb;
  input_authority jsonb;
  uuid_v7_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
  iso_pattern constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$';
  uint63_pattern constant text := '^(0|[1-9][0-9]{0,18})$';
  positive_uint63_pattern constant text := '^[1-9][0-9]{0,18}$';
BEGIN
  IF NOT public.creator_agent_gateway_json_has_exact_keys(
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
     OR input_frame->>'kind' <> 'command'
     OR input_frame->>'type' <> 'conversation.open'
     OR input_frame->>'messageId' !~ uuid_v7_pattern
     OR input_frame->>'correlationId' !~ uuid_v7_pattern
     OR input_frame->>'messageId' = input_frame->>'correlationId'
     OR input_frame->>'connectionId' !~ uuid_v7_pattern
     OR input_frame->>'sequence' !~ uint63_pattern
     OR length(input_frame->>'sequence') > 19
     OR (input_frame->>'sequence')::numeric > 9223372036854775807
     OR input_frame->>'sentAt' !~ iso_pattern
     OR input_frame->>'expiresAt' !~ iso_pattern
     OR (input_frame->>'expiresAt')::timestamptz <= (input_frame->>'sentAt')::timestamptz THEN
    RETURN false;
  END IF;

  input_lease := input_frame->'lease';
  IF NOT public.creator_agent_gateway_json_has_exact_keys(
    input_lease,
    ARRAY['deploymentId', 'leaseId', 'workerSessionId', 'fence']
  ) OR input_lease->>'deploymentId' !~ uuid_v7_pattern
     OR input_lease->>'leaseId' !~ uuid_v7_pattern
     OR input_lease->>'workerSessionId' !~ uuid_v7_pattern
     OR input_lease->>'fence' !~ positive_uint63_pattern
     OR length(input_lease->>'fence') > 19
     OR (input_lease->>'fence')::numeric > 9223372036854775807 THEN
    RETURN false;
  END IF;

  input_body := input_frame->'body';
  IF NOT public.creator_agent_gateway_json_has_exact_keys(
    input_body,
    ARRAY[
      'conversationId', 'agentVersionId', 'agentVersionDigest', 'snapshotDigest',
      'visibleTranscriptDigest', 'openAuthority'
    ]
  ) OR input_body->>'conversationId' !~ uuid_v7_pattern
     OR input_body->>'agentVersionId' !~ uuid_v7_pattern
     OR input_body->>'agentVersionDigest' !~ '^[a-f0-9]{64}$'
     OR input_body->>'snapshotDigest' !~ '^[a-f0-9]{64}$'
     OR input_body->>'visibleTranscriptDigest' !~ '^hmac-sha256:[a-f0-9]{64}$'
     OR input_frame->>'correlationId' <> input_body->>'conversationId' THEN
    RETURN false;
  END IF;

  input_authority := input_body->'openAuthority';
  IF NOT public.creator_agent_gateway_json_has_exact_keys(
    input_authority,
    ARRAY['deploymentId', 'installationId', 'workerSessionId', 'leaseId', 'fence']
  ) OR input_authority->>'deploymentId' !~ uuid_v7_pattern
     OR input_authority->>'installationId' !~ uuid_v7_pattern
     OR input_authority->>'workerSessionId' !~ uuid_v7_pattern
     OR input_authority->>'leaseId' !~ uuid_v7_pattern
     OR input_authority->>'fence' !~ positive_uint63_pattern
     OR length(input_authority->>'fence') > 19
     OR (input_authority->>'fence')::numeric > 9223372036854775807
     OR input_lease->>'deploymentId' <> input_authority->>'deploymentId' THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

REVOKE ALL ON FUNCTION public.creator_agent_gateway_conversation_open_frame_is_safe(jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.creator_agent_gateway_conversation_open_frame_is_safe(jsonb)
  TO combo_agent_broker;

ALTER TABLE public.worker_gateway_operation_receipts
  DROP CONSTRAINT worker_gateway_operation_receipts_operation_kind_check,
  ADD CONSTRAINT worker_gateway_operation_receipts_operation_kind_check CHECK (
    operation_kind IN (
      'ISSUE_CHALLENGE', 'AUTHENTICATE', 'OPEN_SESSION',
      'AUDIT_CHALLENGE_REPLAY', 'ACCEPT_ENVELOPE',
      'SEQUENCE_GAP', 'CLOSE_SESSION', 'CLAIM_BROKER_COMMAND'
    )
  );

CREATE OR REPLACE FUNCTION public.creator_agent_gateway_operation_result_is_safe(
  input_kind text,
  input_result jsonb
) RETURNS boolean AS $$
DECLARE
  input_session jsonb;
  uuid_v7_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
BEGIN
  CASE input_kind
    WHEN 'ISSUE_CHALLENGE' THEN
      RETURN public.creator_agent_gateway_json_has_exact_keys(input_result, ARRAY['challengeId'])
        AND input_result->>'challengeId' ~ uuid_v7_pattern;
    WHEN 'AUTHENTICATE' THEN
      IF public.creator_agent_gateway_json_has_exact_keys(input_result, ARRAY['kind', 'session'])
         AND input_result->>'kind' = 'AUTHENTICATED' THEN
        input_session := input_result->'session';
        RETURN COALESCE(
          public.creator_agent_gateway_json_has_exact_keys(
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
        public.creator_agent_gateway_json_has_exact_keys(input_result, ARRAY['kind', 'code'])
        AND input_result->>'kind' = 'REJECTED'
        AND input_result->>'code' = 'WORKER_INCOMPATIBLE',
        false
      );
    WHEN 'AUDIT_CHALLENGE_REPLAY' THEN
      RETURN COALESCE(
        public.creator_agent_gateway_json_has_exact_keys(input_result, ARRAY['recorded'])
        AND input_result->'recorded' = 'true'::jsonb,
        false
      );
    WHEN 'OPEN_SESSION' THEN
      RETURN public.creator_agent_gateway_control_frame_batch_is_safe(
        input_result,
        ARRAY['lease.grant'],
        1
      );
    WHEN 'ACCEPT_ENVELOPE' THEN
      IF public.creator_agent_gateway_json_has_exact_keys(input_result, ARRAY['kind'])
         AND input_result->>'kind' = 'SEQUENCE_CONFLICT' THEN
        RETURN true;
      END IF;
      RETURN public.creator_agent_gateway_json_has_exact_keys(input_result, ARRAY['kind', 'responses'])
        AND input_result->>'kind' = 'RESPONSES'
        AND public.creator_agent_gateway_accept_response_batch_is_safe(input_result->'responses');
    WHEN 'CLAIM_BROKER_COMMAND' THEN
      RETURN public.creator_agent_gateway_conversation_open_frame_is_safe(input_result);
    WHEN 'SEQUENCE_GAP', 'CLOSE_SESSION' THEN
      RETURN input_result = 'null'::jsonb;
    ELSE
      RETURN false;
  END CASE;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

REVOKE ALL ON FUNCTION public.creator_agent_gateway_operation_result_is_safe(text, jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.creator_agent_gateway_operation_result_is_safe(text, jsonb)
  TO combo_agent_api, combo_agent_broker;
