-- 0030 · Test-only Runtime product wiring and lifecycle Broker payload v2.
--
-- Fresh Consumer sends use one database-owned finalize capability. The caller may preflight and
-- obtain opaque server IDs before KMS/signing work, but only this final function can atomically
-- commit the durable USER Message, Invocation journal, signed Execution Capability, exact
-- invocation.prepare Outbox command, and BUSY Conversation projection. Preview/Production remain
-- blocked until real KMS and signing authorities are supplied outside this migration.

-- ===================== immutable lifecycle payload v2 =====================

CREATE OR REPLACE FUNCTION public.creator_agent_execution_capability_wire_v1_is_safe(
  input_capability jsonb
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $capability_safe$
  SELECT COALESCE((
         public.creator_agent_gateway_json_has_exact_keys(
           input_capability,
           ARRAY[
             'protocol', 'schemaVersion', 'capabilityId', 'invocationId', 'conversationId',
             'deploymentId', 'agentVersionId', 'agentVersionDigest', 'workerInstallationId',
             'leaseId', 'fence', 'providerRequestId', 'requestDigest', 'model',
             'reasoningEffort', 'budget', 'notBefore', 'expiresAt', 'nonce',
             'signatureAlgorithm', 'signatureEncoding', 'signature'
           ]
         )
         AND NOT EXISTS (
           SELECT 1
             FROM pg_catalog.unnest(ARRAY[
               'protocol', 'capabilityId', 'invocationId', 'conversationId',
               'deploymentId', 'agentVersionId', 'agentVersionDigest',
               'workerInstallationId', 'leaseId', 'fence', 'providerRequestId',
               'requestDigest', 'model', 'reasoningEffort', 'notBefore',
               'expiresAt', 'nonce', 'signatureAlgorithm', 'signatureEncoding',
               'signature'
             ]) AS required_string(key_name)
            WHERE pg_catalog.jsonb_typeof(input_capability->required_string.key_name)
                  IS DISTINCT FROM 'string'
         )
         AND input_capability->>'protocol' = 'combo.execution-capability/1'
         AND pg_catalog.jsonb_typeof(input_capability->'schemaVersion') = 'number'
         AND input_capability->'schemaVersion' = '1'::jsonb
         AND input_capability->>'capabilityId' ~
           '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         AND input_capability->>'invocationId' ~
           '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         AND input_capability->>'conversationId' ~
           '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         AND input_capability->>'deploymentId' ~
           '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         AND input_capability->>'agentVersionId' ~
           '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         AND input_capability->>'workerInstallationId' ~
           '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         AND input_capability->>'leaseId' ~
           '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         AND input_capability->>'providerRequestId' ~
           '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         AND input_capability->>'agentVersionDigest' ~ '^[a-f0-9]{64}$'
         AND input_capability->>'requestDigest' ~ '^hmac-sha256:[a-f0-9]{64}$'
         AND input_capability->>'fence' ~ '^[1-9][0-9]{0,18}$'
         AND input_capability->>'model' ~
           '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
         AND input_capability->>'reasoningEffort' IN ('low', 'medium', 'high', 'xhigh')
         AND pg_catalog.jsonb_typeof(input_capability->'budget') = 'object'
         AND public.creator_agent_gateway_json_has_exact_keys(
           input_capability->'budget',
           ARRAY['maxInputTokens', 'maxOutputTokens', 'maxCostMicros']
         )
         AND pg_catalog.jsonb_typeof(input_capability->'budget'->'maxInputTokens') = 'number'
         AND pg_catalog.jsonb_typeof(input_capability->'budget'->'maxOutputTokens') = 'number'
         AND pg_catalog.jsonb_typeof(input_capability->'budget'->'maxCostMicros') = 'number'
         AND (input_capability->'budget'->>'maxInputTokens')::numeric BETWEEN 1 AND 200000
         AND (input_capability->'budget'->>'maxOutputTokens')::numeric BETWEEN 1 AND 32768
         AND (input_capability->'budget'->>'maxCostMicros')::numeric BETWEEN 1 AND 100000000
         AND pg_catalog.scale(
           (input_capability->'budget'->>'maxInputTokens')::numeric
         ) = 0
         AND pg_catalog.scale(
           (input_capability->'budget'->>'maxOutputTokens')::numeric
         ) = 0
         AND pg_catalog.scale(
           (input_capability->'budget'->>'maxCostMicros')::numeric
         ) = 0
         AND input_capability->>'notBefore' ~
           '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$'
         AND input_capability->>'expiresAt' ~
           '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$'
         AND (input_capability->>'expiresAt')::timestamptz >
             (input_capability->>'notBefore')::timestamptz
         AND pg_catalog.length(input_capability->>'nonce') BETWEEN 22 AND 128
         AND input_capability->>'nonce' ~ '^[A-Za-z0-9_-]+$'
         AND input_capability->>'signatureAlgorithm' = 'ES256'
         AND input_capability->>'signatureEncoding' = 'ieee-p1363'
         AND input_capability->>'signature' ~ '^[A-Za-z0-9_-]{86}$'
       ), false);
$capability_safe$;

REVOKE ALL ON FUNCTION public.creator_agent_execution_capability_wire_v1_is_safe(jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.creator_agent_execution_capability_wire_v1_is_safe(jsonb)
  TO combo_agent_api, combo_agent_broker, combo_agent_reconciler;

-- Fixed-schema RFC 8785 serialization used only for the already-strict capability shape above.
-- Object keys are emitted in UTF-16 lexical order; strings use PostgreSQL's JSON string encoder,
-- and the three schema-bounded integers are rendered without JSONB whitespace or exponent drift.
CREATE OR REPLACE FUNCTION public.creator_agent_execution_capability_wire_v1_canonical_text(
  input_capability jsonb
) RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $capability_canonical$
BEGIN
  IF NOT COALESCE(
    public.creator_agent_execution_capability_wire_v1_is_safe(input_capability),
    false
  ) THEN
    RETURN NULL;
  END IF;
  RETURN
    '{"agentVersionDigest":' || pg_catalog.to_jsonb(input_capability->>'agentVersionDigest')::text
    || ',"agentVersionId":' || pg_catalog.to_jsonb(input_capability->>'agentVersionId')::text
    || ',"budget":{"maxCostMicros":'
    || ((input_capability->'budget'->>'maxCostMicros')::numeric)::text
    || ',"maxInputTokens":'
    || ((input_capability->'budget'->>'maxInputTokens')::numeric)::text
    || ',"maxOutputTokens":'
    || ((input_capability->'budget'->>'maxOutputTokens')::numeric)::text
    || '},"capabilityId":' || pg_catalog.to_jsonb(input_capability->>'capabilityId')::text
    || ',"conversationId":' || pg_catalog.to_jsonb(input_capability->>'conversationId')::text
    || ',"deploymentId":' || pg_catalog.to_jsonb(input_capability->>'deploymentId')::text
    || ',"expiresAt":' || pg_catalog.to_jsonb(input_capability->>'expiresAt')::text
    || ',"fence":' || pg_catalog.to_jsonb(input_capability->>'fence')::text
    || ',"invocationId":' || pg_catalog.to_jsonb(input_capability->>'invocationId')::text
    || ',"leaseId":' || pg_catalog.to_jsonb(input_capability->>'leaseId')::text
    || ',"model":' || pg_catalog.to_jsonb(input_capability->>'model')::text
    || ',"nonce":' || pg_catalog.to_jsonb(input_capability->>'nonce')::text
    || ',"notBefore":' || pg_catalog.to_jsonb(input_capability->>'notBefore')::text
    || ',"protocol":' || pg_catalog.to_jsonb(input_capability->>'protocol')::text
    || ',"providerRequestId":'
    || pg_catalog.to_jsonb(input_capability->>'providerRequestId')::text
    || ',"reasoningEffort":' || pg_catalog.to_jsonb(input_capability->>'reasoningEffort')::text
    || ',"requestDigest":' || pg_catalog.to_jsonb(input_capability->>'requestDigest')::text
    || ',"schemaVersion":1'
    || ',"signature":' || pg_catalog.to_jsonb(input_capability->>'signature')::text
    || ',"signatureAlgorithm":'
    || pg_catalog.to_jsonb(input_capability->>'signatureAlgorithm')::text
    || ',"signatureEncoding":'
    || pg_catalog.to_jsonb(input_capability->>'signatureEncoding')::text
    || ',"workerInstallationId":'
    || pg_catalog.to_jsonb(input_capability->>'workerInstallationId')::text
    || '}';
END;
$capability_canonical$;

CREATE OR REPLACE FUNCTION public.creator_agent_execution_capability_wire_v1_digest(
  input_capability jsonb
) RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $capability_digest$
  SELECT pg_catalog.encode(
    public.digest(
      pg_catalog.convert_to(
        public.creator_agent_execution_capability_wire_v1_canonical_text(input_capability),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$capability_digest$;

REVOKE ALL ON FUNCTION public.creator_agent_execution_capability_wire_v1_canonical_text(jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.creator_agent_execution_capability_wire_v1_digest(jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.creator_agent_execution_capability_wire_v1_canonical_text(jsonb)
  TO combo_agent_broker;
GRANT EXECUTE ON FUNCTION public.creator_agent_execution_capability_wire_v1_digest(jsonb)
  TO combo_agent_api, combo_agent_broker, combo_agent_reconciler;

-- PostgreSQL jsonb is useful for strict structural validation but is not an exact-byte store.
-- The delivery table below therefore keeps both this parsed projection and the caller-supplied
-- RFC 8785 text. Gateway re-parses and re-canonicalizes the text; this helper rejects unknown
-- fields, plaintext side channels and cross-context sensitive-message AAD before any row lands.
CREATE OR REPLACE FUNCTION public.creator_agent_gateway_lifecycle_frame_v2_is_safe(
  input_frame jsonb
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $lifecycle_frame_safe$
DECLARE
  frame_body jsonb;
  frame_lease jsonb;
  sensitive jsonb;
  sensitive_aad jsonb;
  capability jsonb;
  uuid_v7_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
  iso_pattern constant text :=
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$';
BEGIN
  IF NOT COALESCE((
     pg_catalog.jsonb_typeof(input_frame) = 'object'
     AND public.creator_agent_gateway_json_has_exact_keys(
       input_frame,
       ARRAY[
         'protocol', 'schemaVersion', 'kind', 'type', 'messageId', 'correlationId',
         'connectionId', 'sequence', 'sentAt', 'expiresAt', 'lease', 'body'
       ]
     )
     AND NOT EXISTS (
       SELECT 1
         FROM pg_catalog.unnest(ARRAY[
           'protocol', 'kind', 'type', 'messageId', 'correlationId',
           'connectionId', 'sequence', 'sentAt', 'expiresAt'
         ]) AS required_string(key_name)
        WHERE pg_catalog.jsonb_typeof(input_frame->required_string.key_name)
              IS DISTINCT FROM 'string'
     )
     AND input_frame->>'protocol' = 'combo.creator-broker/1'
     AND input_frame->'schemaVersion' = '1'::jsonb
     AND input_frame->>'kind' = 'command'
     AND input_frame->>'type' IN (
       'invocation.prepare', 'invocation.start', 'invocation.cancel'
     )
     AND input_frame->>'messageId' ~ uuid_v7_pattern
     AND input_frame->>'correlationId' ~ uuid_v7_pattern
     AND input_frame->>'connectionId' ~ uuid_v7_pattern
     AND pg_catalog.jsonb_typeof(input_frame->'sequence') = 'string'
     AND input_frame->>'sequence' ~ '^(0|[1-9][0-9]{0,18})$'
     AND (input_frame->>'sequence')::numeric <= 9223372036854775807
     AND input_frame->>'sentAt' ~ iso_pattern
     AND input_frame->>'expiresAt' ~ iso_pattern
     AND (input_frame->>'expiresAt')::timestamptz >
          (input_frame->>'sentAt')::timestamptz
  ), false) THEN
    RETURN false;
  END IF;

  frame_lease := input_frame->'lease';
  frame_body := input_frame->'body';
  IF NOT COALESCE((
     pg_catalog.jsonb_typeof(frame_lease) = 'object'
     AND public.creator_agent_gateway_json_has_exact_keys(
       frame_lease, ARRAY['deploymentId', 'leaseId', 'workerSessionId', 'fence']
     )
     AND NOT EXISTS (
       SELECT 1
         FROM pg_catalog.unnest(ARRAY[
           'deploymentId', 'leaseId', 'workerSessionId', 'fence'
         ]) AS required_string(key_name)
        WHERE pg_catalog.jsonb_typeof(frame_lease->required_string.key_name)
              IS DISTINCT FROM 'string'
     )
     AND frame_lease->>'deploymentId' ~ uuid_v7_pattern
     AND frame_lease->>'leaseId' ~ uuid_v7_pattern
     AND frame_lease->>'workerSessionId' ~ uuid_v7_pattern
     AND pg_catalog.jsonb_typeof(frame_lease->'fence') = 'string'
     AND frame_lease->>'fence' ~ '^[1-9][0-9]{0,18}$'
     AND (frame_lease->>'fence')::numeric <= 9223372036854775807
     AND pg_catalog.jsonb_typeof(frame_body) = 'object'
  ), false) THEN
    RETURN false;
  END IF;

  CASE input_frame->>'type'
    WHEN 'invocation.prepare' THEN
      IF NOT COALESCE((
         public.creator_agent_gateway_json_has_exact_keys(
           frame_body,
           ARRAY[
             'invocationId', 'conversationId', 'clientMessageId', 'requestDigest',
             'userMessageCiphertext', 'agentVersionId', 'agentVersionDigest',
             'snapshotDigest', 'deadlineAt', 'executionCapability'
           ]
         )
         AND NOT EXISTS (
           SELECT 1
             FROM pg_catalog.unnest(ARRAY[
               'invocationId', 'conversationId', 'clientMessageId',
               'requestDigest', 'agentVersionId', 'agentVersionDigest',
               'snapshotDigest', 'deadlineAt'
             ]) AS required_string(key_name)
            WHERE pg_catalog.jsonb_typeof(frame_body->required_string.key_name)
                  IS DISTINCT FROM 'string'
         )
         AND pg_catalog.jsonb_typeof(frame_body->'userMessageCiphertext') = 'object'
         AND pg_catalog.jsonb_typeof(frame_body->'executionCapability') = 'object'
         AND frame_body->>'invocationId' ~ uuid_v7_pattern
         AND frame_body->>'conversationId' ~ uuid_v7_pattern
         AND frame_body->>'clientMessageId' ~
              '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         AND frame_body->>'requestDigest' ~ '^hmac-sha256:[a-f0-9]{64}$'
         AND frame_body->>'agentVersionId' ~ uuid_v7_pattern
         AND frame_body->>'agentVersionDigest' ~ '^[a-f0-9]{64}$'
         AND frame_body->>'snapshotDigest' ~ '^[a-f0-9]{64}$'
         AND frame_body->>'deadlineAt' ~ iso_pattern
         AND (frame_body->>'deadlineAt')::timestamptz >=
              (input_frame->>'expiresAt')::timestamptz
         AND input_frame->>'correlationId' = frame_body->>'invocationId'
      ), false) THEN
        RETURN false;
      END IF;

      capability := frame_body->'executionCapability';
      IF NOT COALESCE((
         public.creator_agent_execution_capability_wire_v1_is_safe(capability)
         AND capability->>'invocationId' = frame_body->>'invocationId'
         AND capability->>'conversationId' = frame_body->>'conversationId'
         AND capability->>'agentVersionId' = frame_body->>'agentVersionId'
         AND capability->>'agentVersionDigest' = frame_body->>'agentVersionDigest'
         AND capability->>'deploymentId' = frame_lease->>'deploymentId'
         AND capability->>'workerInstallationId' ~ uuid_v7_pattern
         AND capability->>'leaseId' ~ uuid_v7_pattern
         AND capability->>'requestDigest' = frame_body->>'requestDigest'
      ), false) THEN
        RETURN false;
      END IF;

      sensitive := frame_body->'userMessageCiphertext';
      IF NOT COALESCE((
         pg_catalog.jsonb_typeof(sensitive) = 'object'
         AND public.creator_agent_gateway_json_has_exact_keys(
           sensitive,
           ARRAY[
             'algorithm', 'keyScope', 'keyId', 'nonce', 'ciphertext', 'authTag',
             'cipherDigest', 'aad', 'aadDigest', 'aadVersion'
           ]
         )
         AND NOT EXISTS (
           SELECT 1
             FROM pg_catalog.unnest(ARRAY[
               'algorithm', 'keyScope', 'keyId', 'nonce', 'ciphertext',
               'authTag', 'cipherDigest', 'aadDigest'
             ]) AS required_string(key_name)
            WHERE pg_catalog.jsonb_typeof(sensitive->required_string.key_name)
                  IS DISTINCT FROM 'string'
         )
         AND pg_catalog.jsonb_typeof(sensitive->'aad') = 'object'
         AND sensitive->>'algorithm' = 'aes-256-gcm/v1'
         AND sensitive->>'keyScope' = 'worker-session'
         AND sensitive->>'keyId' ~ '^[a-z0-9][a-z0-9._:-]{2,127}$'
         AND sensitive->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
         AND pg_catalog.length(sensitive->>'ciphertext') BETWEEN 2 AND 61440
         AND sensitive->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
         AND sensitive->>'authTag' ~ '^[A-Za-z0-9_-]{22}$'
         AND sensitive->>'cipherDigest' ~ '^[a-f0-9]{64}$'
         AND sensitive->>'aadDigest' ~ '^[a-f0-9]{64}$'
         AND sensitive->'aadVersion' = '1'::jsonb
      ), false) THEN
        RETURN false;
      END IF;
      sensitive_aad := sensitive->'aad';
      IF NOT COALESCE((
         pg_catalog.jsonb_typeof(sensitive_aad) = 'object'
         AND public.creator_agent_gateway_json_has_exact_keys(
           sensitive_aad,
           ARRAY[
             'protocol', 'schemaVersion', 'envelopeType', 'messageId',
             'conversationId', 'invocationId', 'workerSessionId', 'role', 'keyId'
           ]
         )
         AND NOT EXISTS (
           SELECT 1
             FROM pg_catalog.unnest(ARRAY[
               'protocol', 'envelopeType', 'messageId', 'conversationId',
               'invocationId', 'workerSessionId', 'role', 'keyId'
             ]) AS required_string(key_name)
            WHERE pg_catalog.jsonb_typeof(sensitive_aad->required_string.key_name)
                  IS DISTINCT FROM 'string'
         )
         AND sensitive_aad->>'protocol' = 'combo.creator-broker/1'
         AND sensitive_aad->'schemaVersion' = '1'::jsonb
         AND sensitive_aad->>'envelopeType' = 'invocation.prepare'
         AND sensitive_aad->>'messageId' = input_frame->>'messageId'
         AND sensitive_aad->>'conversationId' = frame_body->>'conversationId'
         AND sensitive_aad->>'invocationId' = frame_body->>'invocationId'
         AND sensitive_aad->>'workerSessionId' = frame_lease->>'workerSessionId'
         AND sensitive_aad->>'role' = 'USER'
         AND sensitive_aad->>'keyId' = sensitive->>'keyId'
      ), false) THEN
        RETURN false;
      END IF;
    WHEN 'invocation.start' THEN
      IF NOT COALESCE((
         public.creator_agent_gateway_json_has_exact_keys(
           frame_body,
           ARRAY['invocationId', 'prepareCommandId', 'executionCapabilityId']
         )
         AND NOT EXISTS (
           SELECT 1
             FROM pg_catalog.unnest(ARRAY[
               'invocationId', 'prepareCommandId', 'executionCapabilityId'
             ]) AS required_string(key_name)
            WHERE pg_catalog.jsonb_typeof(frame_body->required_string.key_name)
                  IS DISTINCT FROM 'string'
         )
         AND frame_body->>'invocationId' ~ uuid_v7_pattern
         AND frame_body->>'prepareCommandId' ~ uuid_v7_pattern
         AND frame_body->>'executionCapabilityId' ~ uuid_v7_pattern
         AND input_frame->>'correlationId' = frame_body->>'invocationId'
      ), false) THEN
        RETURN false;
      END IF;
    WHEN 'invocation.cancel' THEN
      IF NOT COALESCE((
         public.creator_agent_gateway_json_has_exact_keys(
           frame_body, ARRAY['invocationId', 'reason']
         )
         AND NOT EXISTS (
           SELECT 1
             FROM pg_catalog.unnest(ARRAY['invocationId', 'reason'])
               AS required_string(key_name)
            WHERE pg_catalog.jsonb_typeof(frame_body->required_string.key_name)
                  IS DISTINCT FROM 'string'
         )
         AND frame_body->>'invocationId' ~ uuid_v7_pattern
         AND frame_body->>'reason' IN (
           'CONSUMER_REQUEST', 'DRAIN_DEADLINE', 'SECURITY_REVOKE', 'DEADLINE'
         )
         AND input_frame->>'correlationId' = frame_body->>'invocationId'
      ), false) THEN
        RETURN false;
      END IF;
    ELSE
      RETURN false;
  END CASE;
  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END;
$lifecycle_frame_safe$;

REVOKE ALL ON FUNCTION public.creator_agent_gateway_lifecycle_frame_v2_is_safe(jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.creator_agent_gateway_lifecycle_frame_v2_is_safe(jsonb)
  TO combo_agent_broker;

ALTER TABLE public.broker_outbox
  DROP CONSTRAINT ck_broker_outbox_payload_contract,
  ADD COLUMN execution_capability_wire jsonb,
  ADD COLUMN cancel_reason text,
  ADD CONSTRAINT ck_broker_outbox_payload_contract CHECK (
    (
      payload_contract_version = 0
      AND visible_transcript_digest IS NULL
      AND visible_transcript_key_id IS NULL
      AND visible_transcript_key_version IS NULL
      AND visible_transcript_key_ref IS NULL
      AND original_worker_session_id IS NULL
      AND original_connection_id IS NULL
      AND execution_capability_wire IS NULL
      AND cancel_reason IS NULL
    )
    OR
    COALESCE((
      payload_contract_version = 1
      AND command_type = 'conversation.open'
      AND visible_transcript_digest ~ '^hmac-sha256:[a-f0-9]{64}$'
      AND length(visible_transcript_key_id) BETWEEN 1 AND 256
      AND visible_transcript_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
      AND visible_transcript_key_version BETWEEN 1 AND 9223372036854775807
      AND length(visible_transcript_key_ref) BETWEEN 1 AND 512
      AND visible_transcript_key_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]*$'
      AND original_worker_session_id IS NOT NULL
      AND original_connection_id IS NOT NULL
      AND execution_capability_wire IS NULL
      AND cancel_reason IS NULL
    ), false)
    OR
    COALESCE((
      payload_contract_version = 2
      AND command_type IN ('invocation.prepare', 'invocation.start', 'invocation.cancel')
      AND visible_transcript_digest IS NULL
      AND visible_transcript_key_id IS NULL
      AND visible_transcript_key_version IS NULL
      AND visible_transcript_key_ref IS NULL
      AND original_worker_session_id IS NULL
      AND original_connection_id IS NULL
      AND CASE command_type
        WHEN 'invocation.prepare' THEN
          execution_capability_wire IS NOT NULL
          AND COALESCE(
            public.creator_agent_execution_capability_wire_v1_is_safe(
              execution_capability_wire
            ),
            false
          )
          AND execution_capability_wire->>'capabilityId' = execution_capability_id::text
          AND execution_capability_digest =
              public.creator_agent_execution_capability_wire_v1_digest(
                execution_capability_wire
              )
          AND execution_capability_wire->>'invocationId' = invocation_id::text
          AND execution_capability_wire->>'conversationId' = conversation_id::text
          AND execution_capability_wire->>'deploymentId' = deployment_id::text
          AND execution_capability_wire->>'workerInstallationId' = target_worker_id::text
          AND execution_capability_wire->>'leaseId' = assignment_lease_id::text
          AND (execution_capability_wire->>'fence')::bigint = assignment_fence
          AND (execution_capability_wire->>'expiresAt')::timestamptz >= expires_at
          AND cancel_reason IS NULL
        WHEN 'invocation.start' THEN
          execution_capability_wire IS NOT NULL
          AND COALESCE(
            public.creator_agent_execution_capability_wire_v1_is_safe(
              execution_capability_wire
            ),
            false
          )
          AND execution_capability_wire->>'capabilityId' = execution_capability_id::text
          AND execution_capability_digest =
              public.creator_agent_execution_capability_wire_v1_digest(
                execution_capability_wire
              )
          AND execution_capability_wire->>'invocationId' = invocation_id::text
          AND execution_capability_wire->>'conversationId' = conversation_id::text
          AND execution_capability_wire->>'deploymentId' = deployment_id::text
          AND execution_capability_wire->>'workerInstallationId' = target_worker_id::text
          AND execution_capability_wire->>'leaseId' = assignment_lease_id::text
          AND (execution_capability_wire->>'fence')::bigint = assignment_fence
          AND cancel_reason IS NULL
        WHEN 'invocation.cancel' THEN
          execution_capability_wire IS NULL
          AND cancel_reason IN (
            'CONSUMER_REQUEST', 'DRAIN_DEADLINE', 'SECURITY_REVOKE', 'DEADLINE'
          )
        ELSE false
      END
    ), false)
  );

COMMENT ON COLUMN public.broker_outbox.execution_capability_wire IS
  'Full signed immutable ExecutionCapability. Present on payload-v2 prepare/start source rows.';
COMMENT ON COLUMN public.broker_outbox.cancel_reason IS
  'Typed WorkerCancelReason. Present only on payload-v2 invocation.cancel.';

-- v0 cancel/control rows remain readable. A payload-v2 cancel, however, is a first-class
-- Invocation command and must carry the same immutable assignment/capability binding as start.
ALTER TABLE public.broker_outbox
  DROP CONSTRAINT ck_broker_outbox_authority_binding,
  ADD CONSTRAINT ck_broker_outbox_authority_binding CHECK (
    (
      command_type = 'conversation.open'
      AND invocation_id IS NULL
      AND consumer_subject_id IS NOT NULL
      AND conversation_id IS NOT NULL
      AND deployment_id IS NOT NULL
      AND assignment_lease_id IS NOT NULL
      AND assignment_fence BETWEEN 1 AND 9223372036854775807
      AND predecessor_command_id IS NULL
      AND execution_capability_id IS NULL
      AND execution_capability_digest IS NULL
    )
    OR
    (
      command_type = 'invocation.prepare'
      AND invocation_id IS NOT NULL
      AND consumer_subject_id IS NOT NULL
      AND predecessor_command_id IS NULL
      AND (
        (
          payload_contract_version = 0
          AND conversation_id IS NULL
          AND deployment_id IS NULL
          AND assignment_lease_id IS NULL
          AND assignment_fence IS NULL
          AND execution_capability_id IS NULL
          AND execution_capability_digest IS NULL
        )
        OR
        (
          conversation_id IS NOT NULL
          AND deployment_id IS NOT NULL
          AND assignment_lease_id IS NOT NULL
          AND assignment_fence BETWEEN 1 AND 9223372036854775807
          AND execution_capability_id IS NOT NULL
          AND execution_capability_digest IS NOT NULL
        )
      )
    )
    OR
    (
      command_type = 'invocation.start'
      AND invocation_id IS NOT NULL
      AND consumer_subject_id IS NOT NULL
      AND conversation_id IS NOT NULL
      AND deployment_id IS NOT NULL
      AND assignment_lease_id IS NOT NULL
      AND assignment_fence BETWEEN 1 AND 9223372036854775807
      AND predecessor_command_id IS NOT NULL
      AND predecessor_command_id <> command_id
      AND execution_capability_id IS NOT NULL
      AND execution_capability_digest IS NOT NULL
    )
    OR
    (
      command_type = 'invocation.cancel'
      AND invocation_id IS NOT NULL
      AND consumer_subject_id IS NOT NULL
      AND (
        (
          payload_contract_version = 0
          AND conversation_id IS NULL
          AND deployment_id IS NULL
          AND assignment_lease_id IS NULL
          AND assignment_fence IS NULL
          AND predecessor_command_id IS NULL
          AND execution_capability_id IS NULL
          AND execution_capability_digest IS NULL
        )
        OR
        (
          payload_contract_version = 2
          AND conversation_id IS NOT NULL
          AND deployment_id IS NOT NULL
          AND assignment_lease_id IS NOT NULL
          AND assignment_fence BETWEEN 1 AND 9223372036854775807
          AND predecessor_command_id IS NOT NULL
          AND predecessor_command_id <> command_id
          AND execution_capability_id IS NOT NULL
          AND execution_capability_digest IS NOT NULL
        )
      )
    )
    OR
    (
      command_type NOT IN (
        'conversation.open', 'invocation.prepare', 'invocation.start', 'invocation.cancel'
      )
      AND conversation_id IS NULL
      AND deployment_id IS NULL
      AND assignment_lease_id IS NULL
      AND assignment_fence IS NULL
      AND predecessor_command_id IS NULL
      AND execution_capability_id IS NULL
      AND execution_capability_digest IS NULL
      AND (
        (invocation_id IS NULL AND consumer_subject_id IS NULL)
        OR (invocation_id IS NOT NULL AND consumer_subject_id IS NOT NULL)
      )
    )
  );

CREATE OR REPLACE FUNCTION public.enforce_creator_agent_broker_outbox_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $outbox_transition_v2$
DECLARE
  transition_allowed boolean;
  exact_legacy_prepare_binding boolean;
BEGIN
  exact_legacy_prepare_binding :=
    OLD.command_type = 'invocation.prepare'
    AND OLD.state = 'PENDING'
    AND NEW.state IN ('PENDING', 'SENT')
    AND OLD.conversation_id IS NULL
    AND OLD.deployment_id IS NULL
    AND OLD.assignment_lease_id IS NULL
    AND OLD.assignment_fence IS NULL
    AND OLD.execution_capability_id IS NULL
    AND OLD.execution_capability_digest IS NULL
    AND OLD.predecessor_command_id IS NULL
    AND NEW.conversation_id IS NOT NULL
    AND NEW.deployment_id IS NOT NULL
    AND NEW.assignment_lease_id IS NOT NULL
    AND NEW.assignment_fence BETWEEN 1 AND 9223372036854775807
    AND NEW.execution_capability_id IS NOT NULL
    AND NEW.execution_capability_digest IS NOT NULL
    AND NEW.predecessor_command_id IS NULL;

  IF NEW.command_id IS DISTINCT FROM OLD.command_id
     OR NEW.creator_id IS DISTINCT FROM OLD.creator_id
     OR NEW.target_worker_id IS DISTINCT FROM OLD.target_worker_id
     OR NEW.invocation_id IS DISTINCT FROM OLD.invocation_id
     OR NEW.consumer_subject_id IS DISTINCT FROM OLD.consumer_subject_id
     OR NEW.command_type IS DISTINCT FROM OLD.command_type
     OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.payload_contract_version IS DISTINCT FROM OLD.payload_contract_version
     OR NEW.visible_transcript_digest IS DISTINCT FROM OLD.visible_transcript_digest
     OR NEW.visible_transcript_key_id IS DISTINCT FROM OLD.visible_transcript_key_id
     OR NEW.visible_transcript_key_version IS DISTINCT FROM OLD.visible_transcript_key_version
     OR NEW.visible_transcript_key_ref IS DISTINCT FROM OLD.visible_transcript_key_ref
     OR NEW.original_worker_session_id IS DISTINCT FROM OLD.original_worker_session_id
     OR NEW.original_connection_id IS DISTINCT FROM OLD.original_connection_id
     OR NEW.execution_capability_wire IS DISTINCT FROM OLD.execution_capability_wire
     OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason THEN
    RAISE EXCEPTION 'broker outbox command binding is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF (
    NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
    OR NEW.deployment_id IS DISTINCT FROM OLD.deployment_id
    OR NEW.assignment_lease_id IS DISTINCT FROM OLD.assignment_lease_id
    OR NEW.assignment_fence IS DISTINCT FROM OLD.assignment_fence
    OR NEW.predecessor_command_id IS DISTINCT FROM OLD.predecessor_command_id
    OR NEW.execution_capability_id IS DISTINCT FROM OLD.execution_capability_id
    OR NEW.execution_capability_digest IS DISTINCT FROM OLD.execution_capability_digest
  ) AND NOT exact_legacy_prepare_binding THEN
    RAISE EXCEPTION 'broker outbox execution authority is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state IN ('ACKED', 'EXPIRED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal broker outbox command is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION 'broker outbox attempt count is monotonic'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.command_type = 'conversation.open'
     AND NEW.state = 'ACKED'
     AND current_user IN (
       'combo_agent_api', 'combo_agent_broker', 'combo_agent_reconciler',
       'combo_agent_consumer_api'
     ) THEN
    RAISE EXCEPTION 'conversation.open ACK requires exact conversation.ready authority'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.state <> OLD.state THEN
    transition_allowed := CASE OLD.state
      WHEN 'PENDING' THEN NEW.state IN ('SENT', 'ACKED', 'EXPIRED')
      WHEN 'SENT' THEN NEW.state IN ('ACKED', 'EXPIRED')
      ELSE false
    END;
    IF NOT transition_allowed THEN
      RAISE EXCEPTION 'invalid broker outbox transition % -> %', OLD.state, NEW.state
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$outbox_transition_v2$;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_broker_outbox_transition() FROM PUBLIC;

-- Existing CloudJournal creates invocation.start after a durable prepared fact. Upgrade only
-- that exact INSERT shape before constraints run; no legacy row can be promoted in place.
CREATE OR REPLACE FUNCTION public.creator_agent_default_lifecycle_payload_v2()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $default_lifecycle_v2$
BEGIN
  IF NEW.command_type = 'invocation.cancel'
     AND NEW.payload_contract_version = 2 THEN
    RAISE EXCEPTION '0030 does not admit invocation.cancel producers'
      USING ERRCODE = '0A000';
  END IF;
  IF NEW.command_type = 'invocation.start'
     AND NEW.payload_contract_version = 0
     AND NEW.predecessor_command_id IS NOT NULL
     AND NEW.execution_capability_id IS NOT NULL
     AND NEW.execution_capability_digest IS NOT NULL THEN
    SELECT predecessor.execution_capability_wire
      INTO NEW.execution_capability_wire
      FROM public.broker_outbox AS predecessor
     WHERE predecessor.command_id = NEW.predecessor_command_id
       AND predecessor.creator_id = NEW.creator_id
       AND predecessor.invocation_id = NEW.invocation_id
       AND predecessor.command_type = 'invocation.prepare'
       AND predecessor.payload_contract_version = 2
       AND predecessor.execution_capability_id = NEW.execution_capability_id
       AND predecessor.execution_capability_digest = NEW.execution_capability_digest;
    IF FOUND THEN
      NEW.payload_contract_version := 2;
    ELSE
      -- Existing v0 prepares retain their legacy v0 start contract. The migration is additive
      -- and must not reinterpret a durable pre-0030 source fact as payload-v2 authority.
      NEW.execution_capability_wire := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$default_lifecycle_v2$;

REVOKE ALL ON FUNCTION public.creator_agent_default_lifecycle_payload_v2() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.creator_agent_default_lifecycle_payload_v2()
  TO combo_agent_broker;

CREATE TRIGGER aa_broker_outbox_lifecycle_payload_v2
BEFORE INSERT ON public.broker_outbox
FOR EACH ROW EXECUTE FUNCTION public.creator_agent_default_lifecycle_payload_v2();

-- Lifecycle deliveries use delivery_contract_version=2 so the composite FK binds the exact v2
-- command. conversation.open remains byte-for-byte delivery v1.
ALTER TABLE public.worker_gateway_outbound_frames
  DROP CONSTRAINT ck_worker_gateway_outbound_delivery_contract,
  ADD COLUMN wire_envelope jsonb,
  ADD COLUMN wire_canonical_text text,
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
      AND wire_envelope IS NULL
      AND wire_canonical_text IS NULL
    )
    OR
    (
      delivery_contract_version IN (1, 2)
      AND broker_command_id IS NOT NULL
      AND message_id = broker_command_id
      AND broker_target_worker_id IS NOT NULL
      AND broker_deployment_id IS NOT NULL
      AND claim_session_id = session_id
      AND claim_connection_id IS NOT NULL
      AND current_delivery_lease_id IS NOT NULL
      AND current_delivery_fence BETWEEN 1 AND 9223372036854775807
      AND wire_sent_at IS NOT NULL
      AND wire_expires_at > wire_sent_at
      AND (
        (
          delivery_contract_version = 1
          AND envelope_type = 'conversation.open'
          AND wire_envelope IS NULL
          AND wire_canonical_text IS NULL
        )
        OR
        (
          delivery_contract_version = 2
          AND envelope_type IN ('invocation.prepare', 'invocation.start')
          AND wire_envelope IS NOT NULL
          AND wire_canonical_text IS NOT NULL
          AND pg_catalog.octet_length(wire_canonical_text) BETWEEN 1 AND 65536
          AND COALESCE(
            public.creator_agent_gateway_lifecycle_frame_v2_is_safe(wire_envelope),
            false
          )
          AND wire_canonical_text::jsonb = wire_envelope
          AND pg_catalog.encode(
                public.digest(pg_catalog.convert_to(wire_canonical_text, 'UTF8'), 'sha256'),
                'hex'
              ) = canonical_digest
          AND wire_envelope->>'type' = envelope_type
          AND wire_envelope->>'messageId' = message_id::text
          AND wire_envelope->>'connectionId' = claim_connection_id::text
          AND wire_envelope->>'sentAt' =
                pg_catalog.to_char(
                  wire_sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                )
          AND wire_envelope->>'expiresAt' =
                pg_catalog.to_char(
                  wire_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                )
          AND wire_envelope->'lease'->>'deploymentId' = broker_deployment_id::text
          AND wire_envelope->'lease'->>'leaseId' = current_delivery_lease_id::text
          AND wire_envelope->'lease'->>'workerSessionId' = claim_session_id::text
          AND wire_envelope->'lease'->>'fence' = current_delivery_fence::text
        )
      )
    )
  );

COMMENT ON COLUMN public.worker_gateway_outbound_frames.wire_envelope IS
  'Strict parsed projection of the per-Session payload-v2 Broker envelope; never byte authority.';
COMMENT ON COLUMN public.worker_gateway_outbound_frames.wire_canonical_text IS
  'Exact immutable RFC 8785 Broker bytes as UTF-8 text. Contains ciphertext, never plaintext or raw keys.';

CREATE UNIQUE INDEX uq_worker_gateway_outbound_lifecycle_per_session
  ON public.worker_gateway_outbound_frames (session_id, broker_command_id)
  WHERE delivery_contract_version = 2;

CREATE OR REPLACE FUNCTION public.enforce_creator_agent_gateway_outbound_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $gateway_outbound_insert_v2$
BEGIN
  IF NEW.delivery_contract_version = 0
     AND NEW.envelope_type IN (
       'conversation.open', 'invocation.prepare', 'invocation.start', 'invocation.cancel',
       'deployment.prepare', 'deployment.drain'
     )
     AND current_user IN (
       'combo_agent_api', 'combo_agent_broker', 'combo_agent_reconciler',
       'combo_agent_consumer_api'
     ) THEN
    RAISE EXCEPTION 'legacy Broker delivery contract cannot claim a business command'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.delivery_contract_version IN (1, 2) THEN
    PERFORM 1
      FROM public.broker_outbox AS command
      LEFT JOIN public.agent_invocations AS invocation
        ON invocation.id = command.invocation_id
       AND invocation.creator_id = command.creator_id
       AND invocation.consumer_subject_id = command.consumer_subject_id
      LEFT JOIN public.agent_versions AS version
        ON version.id = invocation.agent_version_id
       AND version.creator_id = invocation.creator_id
      LEFT JOIN public.context_snapshots AS snapshot
        ON snapshot.id = version.snapshot_id
       AND snapshot.creator_id = version.creator_id
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
       AND command.payload_contract_version = NEW.delivery_contract_version
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
       AND (
         (
           NEW.delivery_contract_version = 1
           AND command.command_type = 'conversation.open'
           AND NEW.wire_envelope IS NULL
           AND NEW.wire_canonical_text IS NULL
         )
         OR
         (
           NEW.delivery_contract_version = 2
           AND command.command_type IN (
             'invocation.prepare', 'invocation.start'
           )
           AND NEW.wire_envelope IS NOT NULL
           AND NEW.wire_canonical_text IS NOT NULL
           AND NEW.wire_envelope->>'messageId' = command.command_id::text
           AND NEW.wire_envelope->>'correlationId' = command.invocation_id::text
           AND NEW.wire_envelope->'body'->>'invocationId' = command.invocation_id::text
           AND CASE command.command_type
             WHEN 'invocation.prepare' THEN
               NEW.wire_envelope->'body'->>'conversationId' = command.conversation_id::text
               AND NEW.wire_envelope->'body'->>'clientMessageId' =
                     invocation.client_message_id
               AND NEW.wire_envelope->'body'->>'requestDigest' = invocation.request_digest
               AND NEW.wire_envelope->'body'->>'agentVersionId' =
                     invocation.agent_version_id::text
               AND NEW.wire_envelope->'body'->>'agentVersionDigest' = version.version_digest
               AND NEW.wire_envelope->'body'->>'snapshotDigest' = snapshot.snapshot_digest
               AND NEW.wire_envelope->'body'->>'deadlineAt' =
                     pg_catalog.to_char(
                       invocation.deadline_at AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                     )
               AND NEW.wire_envelope->'body'->'executionCapability' =
                     command.execution_capability_wire
             WHEN 'invocation.start' THEN
               NEW.wire_envelope->'body'->>'prepareCommandId' =
                     command.predecessor_command_id::text
               AND NEW.wire_envelope->'body'->>'executionCapabilityId' =
                     command.execution_capability_id::text
             ELSE false
           END
         )
       )
     FOR UPDATE OF command
     FOR SHARE OF gateway, current_deployment, delivery_lease;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Broker business delivery lost current Test claim authority'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$gateway_outbound_insert_v2$;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_gateway_outbound_insert() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.enforce_creator_agent_gateway_outbound_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $gateway_outbound_transition_v2$
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
     OR NEW.wire_envelope IS DISTINCT FROM OLD.wire_envelope
     OR NEW.wire_canonical_text IS DISTINCT FROM OLD.wire_canonical_text
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
    WHEN '' THEN 0 WHEN 'RECEIVED' THEN 1 WHEN 'PERSISTED' THEN 2
    WHEN 'CLOUD_COMMITTED' THEN 3 ELSE 4 END;
  new_ack_rank := CASE COALESCE(NEW.durable_ack_level, '')
    WHEN '' THEN 0 WHEN 'RECEIVED' THEN 1 WHEN 'PERSISTED' THEN 2
    WHEN 'CLOUD_COMMITTED' THEN 3 ELSE -1 END;
  IF new_ack_rank < old_ack_rank THEN
    RAISE EXCEPTION 'worker gateway ACK level is monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$gateway_outbound_transition_v2$;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_gateway_outbound_transition() FROM PUBLIC;

-- Broker obtains only one locked, current Test delivery source. Durable owner Message bytes are
-- returned for prepare so the mounted Gateway keyring can authenticate and re-seal them to the
-- current Session AAD. The database never returns plaintext or key material.
-- The lifecycle read and claim boundaries share one catalog-backed authority predicate. It is
-- deliberately owner-only: Broker may execute the two public wrappers, never the predicate that
-- defines their authority. The allowlists below freeze the effective 0030 Broker capability set;
-- any role, schema, table, column, sequence or SECURITY DEFINER drift fails closed.
CREATE OR REPLACE FUNCTION public.creator_agent_gateway_lifecycle_v2_broker_is_exact()
RETURNS boolean
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $gateway_lifecycle_v2_broker_exact$
DECLARE
  broker_role record;
BEGIN
  SELECT role.oid,
         role.rolsuper,
         role.rolinherit,
         role.rolcreaterole,
         role.rolcreatedb,
         role.rolcanlogin,
         role.rolreplication,
         role.rolbypassrls
    INTO broker_role
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = session_user;
  IF session_user <> 'combo_agent_broker'
     OR current_user = session_user
     OR broker_role.oid IS NULL
     OR broker_role.rolsuper
     OR broker_role.rolinherit
     OR broker_role.rolcreaterole
     OR broker_role.rolcreatedb
     OR NOT broker_role.rolcanlogin
     OR broker_role.rolreplication
     OR broker_role.rolbypassrls
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_auth_members AS membership
        WHERE membership.member = broker_role.oid
           OR membership.roleid = broker_role.oid
     ) THEN
    RETURN false;
  END IF;

  RETURN COALESCE((
    WITH expected_schema_privileges(schema_name, privilege_type) AS (
      VALUES ('public'::name, 'USAGE'::text)
    ), actual_schema_privileges AS (
      SELECT namespace.nspname AS schema_name,
             privilege.privilege_type
        FROM pg_catalog.pg_namespace AS namespace
        CROSS JOIN (VALUES ('USAGE'::text), ('CREATE'::text)) AS privilege(privilege_type)
       WHERE namespace.nspname <> 'information_schema'
         AND namespace.nspname !~ '^pg_'
         AND pg_catalog.has_schema_privilege(
               session_user,
               namespace.oid,
               privilege.privilege_type
             )
    ), expected_table_privileges(schema_name, table_name, privilege_type) AS (
      SELECT 'public'::name, table_name::name, 'SELECT'::text
        FROM unnest(ARRAY[
          'agent_conversations',
          'agent_invocation_events',
          'agent_invocations',
          'agent_messages',
          'agent_version_controls',
          'agent_versions',
          'agents',
          'broker_outbox',
          'consumer_event_outbox',
          'consumer_event_streams',
          'context_snapshots',
          'deployments',
          'worker_auth_challenges',
          'worker_auth_security_events',
          'worker_gateway_frame_receipts',
          'worker_gateway_operation_receipts',
          'worker_gateway_outbound_frames',
          'worker_gateway_security_events',
          'worker_gateway_sequence_gaps',
          'worker_gateway_sessions',
          'worker_installations',
          'worker_leases'
        ]::text[]) AS allowed(table_name)
      UNION ALL
      SELECT 'public'::name, table_name::name, 'INSERT'::text
        FROM unnest(ARRAY[
          'agent_invocation_events',
          'agent_messages',
          'broker_outbox',
          'consumer_event_outbox',
          'consumer_event_streams',
          'worker_auth_security_events',
          'worker_gateway_frame_receipts',
          'worker_gateway_operation_receipts',
          'worker_gateway_outbound_frames',
          'worker_gateway_security_events',
          'worker_gateway_sequence_gaps',
          'worker_gateway_sessions',
          'worker_installations',
          'worker_leases'
        ]::text[]) AS allowed(table_name)
      UNION ALL
      SELECT 'public'::name, table_name::name, 'UPDATE'::text
        FROM unnest(ARRAY[
          'worker_auth_challenges',
          'worker_gateway_outbound_frames',
          'worker_gateway_sessions'
        ]::text[]) AS allowed(table_name)
    ), actual_table_privileges AS (
      SELECT namespace.nspname AS schema_name,
             relation.relname AS table_name,
             privilege.privilege_type
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        CROSS JOIN (
          VALUES ('SELECT'::text), ('INSERT'::text), ('UPDATE'::text), ('DELETE'::text),
                 ('TRUNCATE'::text), ('REFERENCES'::text), ('TRIGGER'::text)
        ) AS privilege(privilege_type)
       WHERE namespace.nspname <> 'information_schema'
         AND namespace.nspname !~ '^pg_'
         AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND pg_catalog.has_table_privilege(
               session_user,
               relation.oid,
               privilege.privilege_type
             )
    ), expected_column_privileges(
      schema_name, table_name, column_name, privilege_type
    ) AS (
      SELECT 'public'::name, 'agent_conversations'::name, column_name::name, 'UPDATE'::text
        FROM unnest(ARRAY[
          'state', 'assigned_worker_id', 'last_activity_at', 'closed_at'
        ]::text[]) AS allowed(column_name)
      UNION ALL
      SELECT 'public'::name, 'agent_invocations'::name, column_name::name, 'UPDATE'::text
        FROM unnest(ARRAY[
          'state', 'assigned_worker_id', 'assignment_lease_id', 'assignment_fence',
          'execution_capability_id', 'cancel_requested_at', 'runtime_thread_id',
          'runtime_turn_id', 'result_message_id', 'result_digest', 'error_code',
          'reconciliation_reason', 'reconciliation_started_at', 'uncertainty_reason',
          'started_at', 'terminal_at', 'execution_capability_digest',
          'execution_capability_expires_at', 'execution_capability_revoked_at'
        ]::text[]) AS allowed(column_name)
      UNION ALL
      SELECT 'public'::name, 'broker_outbox'::name, column_name::name, 'UPDATE'::text
        FROM unnest(ARRAY[
          'state', 'attempt_count', 'next_attempt_at', 'acked_at', 'conversation_id',
          'deployment_id', 'assignment_lease_id', 'assignment_fence',
          'execution_capability_id', 'execution_capability_digest'
        ]::text[]) AS allowed(column_name)
      UNION ALL
      SELECT 'public'::name, 'consumer_event_outbox'::name, column_name::name, 'UPDATE'::text
        FROM unnest(ARRAY[
          'state', 'attempt_count', 'next_attempt_at', 'published_at'
        ]::text[]) AS allowed(column_name)
      UNION ALL
      SELECT 'public'::name, 'consumer_event_streams'::name, column_name::name, 'UPDATE'::text
        FROM unnest(ARRAY[
          'latest_cursor', 'expired_through_cursor', 'updated_at'
        ]::text[]) AS allowed(column_name)
      UNION ALL
      SELECT 'public'::name, 'deployments'::name, column_name::name, 'UPDATE'::text
        FROM unnest(ARRAY[
          'serving_version_id', 'observed_state', 'lease_fence', 'observed_worker_id',
          'observed_generation', 'last_error_code', 'updated_at'
        ]::text[]) AS allowed(column_name)
      UNION ALL
      SELECT 'public'::name, 'worker_installations'::name, column_name::name, 'UPDATE'::text
        FROM unnest(ARRAY[
          'worker_version', 'protocol_versions', 'capabilities', 'last_seen_at', 'revoked_at'
        ]::text[]) AS allowed(column_name)
      UNION ALL
      SELECT 'public'::name, 'worker_leases'::name, column_name::name, 'UPDATE'::text
        FROM unnest(ARRAY['state', 'renewed_at', 'expires_at']::text[])
          AS allowed(column_name)
    ), actual_column_privileges AS (
      SELECT namespace.nspname AS schema_name,
             relation.relname AS table_name,
             attribute.attname AS column_name,
             privilege.privilege_type
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = relation.oid
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
        CROSS JOIN (
          VALUES ('SELECT'::text), ('INSERT'::text), ('UPDATE'::text), ('REFERENCES'::text)
        ) AS privilege(privilege_type)
       WHERE namespace.nspname <> 'information_schema'
         AND namespace.nspname !~ '^pg_'
         AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND NOT pg_catalog.has_table_privilege(
               session_user,
               relation.oid,
               privilege.privilege_type
             )
         AND pg_catalog.has_column_privilege(
               session_user,
               relation.oid,
               attribute.attnum,
               privilege.privilege_type
             )
    ), expected_sequence_privileges(schema_name, sequence_name, privilege_type) AS (
      SELECT 'public'::name, sequence_name::name, privilege_type::text
        FROM unnest(ARRAY[
          'agent_invocation_events_id_seq',
          'consumer_event_outbox_cursor_seq',
          'worker_auth_security_events_id_seq',
          'worker_gateway_security_events_id_seq',
          'worker_gateway_sequence_gaps_id_seq'
        ]::text[]) AS allowed(sequence_name)
        CROSS JOIN (VALUES ('USAGE'::text), ('SELECT'::text)) AS privilege(privilege_type)
    ), actual_sequence_privileges AS (
      SELECT namespace.nspname AS schema_name,
             sequence.relname AS sequence_name,
             privilege.privilege_type
        FROM pg_catalog.pg_class AS sequence
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = sequence.relnamespace
        CROSS JOIN (
          VALUES ('USAGE'::text), ('SELECT'::text), ('UPDATE'::text)
        ) AS privilege(privilege_type)
       WHERE namespace.nspname <> 'information_schema'
         AND namespace.nspname !~ '^pg_'
         AND sequence.relkind = 'S'
         AND pg_catalog.has_sequence_privilege(
               session_user,
               sequence.oid,
               privilege.privilege_type
             )
    ), expected_security_definers(procedure_oid) AS (
      SELECT signature::pg_catalog.regprocedure
        FROM unnest(ARRAY[
          'public.creator_agent_commit_conversation_ready_fact(uuid,text,uuid,uuid,uuid,uuid,uuid,text,text,uuid,uuid,uuid,bigint,uuid,text,text)',
          'public.creator_agent_execution_capability_wire_v1_canonical_text(jsonb)',
          'public.creator_agent_execution_capability_wire_v1_digest(jsonb)',
          'public.creator_agent_execution_capability_wire_v1_is_safe(jsonb)',
          'public.creator_agent_finalize_success_fact_v1(uuid,uuid,uuid,text,uuid,text,text,text,bytea,bytea,bytea,text,text,integer)',
          'public.creator_agent_gateway_lifecycle_frame_v2_is_safe(jsonb)',
          'public.creator_agent_gateway_lifecycle_v2_ready()',
          'public.creator_agent_lock_consumed_worker_challenge(uuid,uuid)',
          'public.creator_agent_lock_gateway_lifecycle_command_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,bigint)',
          'public.creator_agent_lock_worker_challenge(uuid,uuid)',
          'public.creator_agent_preflight_success_fact_v1(uuid,uuid,text,integer,text,uuid,uuid,text,text,text,uuid,bigint,text,text,text,text,text,text)',
          'public.creator_agent_project_cancelled_fact_v1(uuid,uuid,text,integer,text,uuid,uuid,text,text,text,uuid,bigint,text,text)',
          'public.creator_agent_project_failed_fact_v2(uuid,uuid,text,integer,text,uuid,uuid,text,text,text,uuid,bigint,text,text)',
          'public.creator_agent_project_prepared_fact_v1(uuid,uuid,text,integer,text,uuid,uuid,text,text,text,uuid,bigint,text,uuid,text)',
          'public.creator_agent_project_started_fact_v1(uuid,uuid,text,integer,text,uuid,uuid,text,text,text,uuid,bigint,uuid,text,text,text,text,text)',
          'public.creator_agent_security_revoke_deployment_capabilities(uuid,uuid)',
          'public.enforce_creator_agent_confirmed_cancelled_companion()',
          'public.enforce_creator_agent_confirmed_failed_companion()',
          'public.enforce_creator_agent_event_sequence()',
          'public.enforce_creator_agent_invocation_capability_authority()',
          'public.enforce_creator_agent_message_accept_chain()',
          'public.enforce_creator_agent_succeeded_terminal_companion()',
          'public.enforce_creator_agent_success_preflight_consumed()'
        ]::text[]) AS allowed(signature)
    ), actual_security_definers AS (
      SELECT procedure.oid AS procedure_oid
        FROM pg_catalog.pg_proc AS procedure
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
       WHERE namespace.nspname <> 'information_schema'
         AND namespace.nspname !~ '^pg_'
         AND procedure.prosecdef
         AND pg_catalog.has_function_privilege(session_user, procedure.oid, 'EXECUTE')
    )
    SELECT pg_catalog.has_database_privilege(
             session_user, pg_catalog.current_database(), 'CONNECT'
           )
       AND pg_catalog.has_database_privilege(
             session_user, pg_catalog.current_database(), 'TEMPORARY'
           )
       AND NOT pg_catalog.has_database_privilege(
             session_user, pg_catalog.current_database(), 'CREATE'
           )
       AND NOT EXISTS (
         SELECT schema_name, privilege_type FROM expected_schema_privileges
         EXCEPT
         SELECT schema_name, privilege_type FROM actual_schema_privileges
       )
       AND NOT EXISTS (
         SELECT schema_name, privilege_type FROM actual_schema_privileges
         EXCEPT
         SELECT schema_name, privilege_type FROM expected_schema_privileges
       )
       AND NOT EXISTS (
         SELECT schema_name, table_name, privilege_type FROM expected_table_privileges
         EXCEPT
         SELECT schema_name, table_name, privilege_type FROM actual_table_privileges
       )
       AND NOT EXISTS (
         SELECT schema_name, table_name, privilege_type FROM actual_table_privileges
         EXCEPT
         SELECT schema_name, table_name, privilege_type FROM expected_table_privileges
       )
       AND NOT EXISTS (
         SELECT schema_name, table_name, column_name, privilege_type
           FROM expected_column_privileges
         EXCEPT
         SELECT schema_name, table_name, column_name, privilege_type
           FROM actual_column_privileges
       )
       AND NOT EXISTS (
         SELECT schema_name, table_name, column_name, privilege_type
           FROM actual_column_privileges
         EXCEPT
         SELECT schema_name, table_name, column_name, privilege_type
           FROM expected_column_privileges
       )
       AND NOT EXISTS (
         SELECT schema_name, sequence_name, privilege_type FROM expected_sequence_privileges
         EXCEPT
         SELECT schema_name, sequence_name, privilege_type FROM actual_sequence_privileges
       )
       AND NOT EXISTS (
         SELECT schema_name, sequence_name, privilege_type FROM actual_sequence_privileges
         EXCEPT
         SELECT schema_name, sequence_name, privilege_type FROM expected_sequence_privileges
       )
       AND NOT EXISTS (
         SELECT procedure_oid FROM expected_security_definers
         EXCEPT
         SELECT procedure_oid FROM actual_security_definers
       )
       AND NOT EXISTS (
         SELECT procedure_oid FROM actual_security_definers
         EXCEPT
         SELECT procedure_oid FROM expected_security_definers
       )
  ), false);
END;
$gateway_lifecycle_v2_broker_exact$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.creator_agent_gateway_lifecycle_v2_broker_is_exact()
  FROM PUBLIC, combo_agent_api, combo_agent_broker, combo_agent_consumer_api,
    combo_agent_reconciler, combo_agent_maintenance;

CREATE OR REPLACE FUNCTION public.creator_agent_lock_gateway_lifecycle_command_v2(
  input_command_id uuid,
  input_creator_id uuid,
  input_installation_id uuid,
  input_deployment_id uuid,
  input_session_id uuid,
  input_connection_id uuid,
  input_current_lease_id uuid,
  input_current_fence bigint
)
RETURNS TABLE(
  command_type text,
  command_id uuid,
  invocation_id uuid,
  creator_id uuid,
  conversation_id uuid,
  client_message_id text,
  request_digest text,
  deployment_id uuid,
  installation_id uuid,
  assignment_lease_id uuid,
  assignment_fence bigint,
  agent_version_id uuid,
  agent_version_digest text,
  snapshot_digest text,
  deadline_at timestamptz,
  execution_capability_wire jsonb,
  execution_capability_id uuid,
  execution_capability_digest text,
  predecessor_command_id uuid,
  cancel_reason text,
  message_id uuid,
  content_algorithm text,
  content_key_id text,
  content_nonce bytea,
  content_ciphertext bytea,
  content_auth_tag bytea,
  content_cipher_digest text,
  content_digest text,
  content_aad_version integer,
  wire_sent_at timestamptz,
  wire_expires_at timestamptz
)
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $lock_gateway_lifecycle_v2$
DECLARE
  delivery_sent_at timestamptz;
BEGIN
  IF NOT COALESCE(
       public.creator_agent_gateway_lifecycle_v2_broker_is_exact(),
       false
     ) THEN
    RAISE EXCEPTION 'Lifecycle claim requires exact isolated Broker authority'
      USING ERRCODE = '42501';
  END IF;
  IF input_creator_id IS DISTINCT FROM
       NULLIF(current_setting('app.creator_id', true), '')::uuid
     OR NULLIF(current_setting('app.consumer_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'Lifecycle claim requires exact Creator and cleared Consumer context'
      USING ERRCODE = '42501';
  END IF;
  IF input_command_id IS NULL
     OR input_creator_id IS NULL
     OR input_installation_id IS NULL
     OR input_deployment_id IS NULL
     OR input_session_id IS NULL
     OR input_connection_id IS NULL
     OR input_current_lease_id IS NULL
     OR input_current_fence IS NULL
     OR input_current_fence NOT BETWEEN 1 AND 9223372036854775807 THEN
    RAISE EXCEPTION 'Lifecycle claim candidate is incomplete'
      USING ERRCODE = '23514';
  END IF;

  delivery_sent_at := date_trunc('milliseconds', transaction_timestamp());
  RETURN QUERY
  SELECT command.command_type,
         command.command_id,
         invocation.id,
         command.creator_id,
         invocation.conversation_id,
         invocation.client_message_id,
         invocation.request_digest,
         command.deployment_id,
         command.target_worker_id,
         command.assignment_lease_id,
         command.assignment_fence,
         invocation.agent_version_id,
         version.version_digest,
         snapshot.snapshot_digest,
         invocation.deadline_at,
         command.execution_capability_wire,
         command.execution_capability_id,
         command.execution_capability_digest,
         command.predecessor_command_id,
         command.cancel_reason,
         user_message.id,
         user_message.content_algorithm,
         user_message.content_key_id,
         user_message.content_nonce,
         user_message.content_ciphertext,
         user_message.content_auth_tag,
         user_message.content_cipher_digest,
         user_message.content_digest,
         user_message.content_aad_version,
         delivery_sent_at,
         date_trunc(
           'milliseconds',
           LEAST(command.expires_at, gateway.expires_at, current_lease.expires_at)
         )
    FROM public.broker_outbox AS command
    JOIN public.agent_invocations AS invocation
      ON invocation.id = command.invocation_id
     AND invocation.creator_id = command.creator_id
     AND invocation.consumer_subject_id = command.consumer_subject_id
     AND invocation.conversation_id = command.conversation_id
     AND invocation.assigned_worker_id = command.target_worker_id
     AND invocation.assignment_lease_id = command.assignment_lease_id
     AND invocation.assignment_fence = command.assignment_fence
     AND invocation.execution_capability_id = command.execution_capability_id
     AND invocation.execution_capability_digest = command.execution_capability_digest
    JOIN public.agent_messages AS user_message
      ON user_message.id = invocation.user_message_id
     AND user_message.conversation_id = invocation.conversation_id
     AND user_message.creator_id = invocation.creator_id
     AND user_message.consumer_subject_id = invocation.consumer_subject_id
     AND user_message.invocation_id = invocation.id
     AND user_message.role = 'USER'
     AND user_message.client_message_id = invocation.client_message_id
    JOIN public.agent_conversations AS conversation
      ON conversation.id = invocation.conversation_id
     AND conversation.creator_id = invocation.creator_id
     AND conversation.consumer_subject_id = invocation.consumer_subject_id
     AND conversation.deployment_id = command.deployment_id
     AND conversation.agent_version_id = invocation.agent_version_id
    JOIN public.agent_versions AS version
      ON version.id = invocation.agent_version_id
     AND version.creator_id = invocation.creator_id
     AND version.version_digest = conversation.version_digest
    JOIN public.context_snapshots AS snapshot
      ON snapshot.id = version.snapshot_id
     AND snapshot.creator_id = version.creator_id
    JOIN public.deployments AS deployment
      ON deployment.id = command.deployment_id
     AND deployment.creator_id = command.creator_id
     AND deployment.serving_version_id = invocation.agent_version_id
    JOIN public.worker_gateway_sessions AS gateway
      ON gateway.id = input_session_id
     AND gateway.creator_id = command.creator_id
     AND gateway.installation_id = command.target_worker_id
     AND gateway.connection_id = input_connection_id
    JOIN public.worker_leases AS current_lease
      ON current_lease.id = input_current_lease_id
     AND current_lease.deployment_id = command.deployment_id
     AND current_lease.creator_id = command.creator_id
     AND current_lease.worker_id = command.target_worker_id
     AND current_lease.connection_id = gateway.connection_id
     AND current_lease.fence = input_current_fence
    LEFT JOIN public.broker_outbox AS predecessor
      ON predecessor.command_id = command.predecessor_command_id
     AND predecessor.creator_id = command.creator_id
     AND predecessor.invocation_id = command.invocation_id
     AND predecessor.consumer_subject_id = command.consumer_subject_id
   WHERE command.command_id = input_command_id
     AND command.creator_id = input_creator_id
     AND command.target_worker_id = input_installation_id
     AND command.deployment_id = input_deployment_id
     AND command.payload_contract_version = 2
     AND command.command_type IN (
       'invocation.prepare', 'invocation.start'
     )
     AND command.state IN ('PENDING', 'SENT')
     AND command.expires_at > delivery_sent_at + interval '3 seconds'
     AND command.expires_at <= invocation.deadline_at
     AND gateway.state = 'ACTIVE'
     AND gateway.expires_at > delivery_sent_at + interval '3 seconds'
     AND current_lease.state = 'ACTIVE'
     AND current_lease.expires_at > delivery_sent_at + interval '3 seconds'
     AND deployment.environment = 'TEST'
     AND deployment.desired_state = 'ONLINE'
     AND deployment.observed_state = 'ONLINE'
     AND deployment.observed_worker_id = command.target_worker_id
     AND deployment.observed_generation = deployment.generation
     AND deployment.lease_fence = input_current_fence
     AND COALESCE(
       public.creator_agent_execution_capability_wire_v1_is_safe(
         command.execution_capability_wire
       ),
       false
     )
     AND CASE command.command_type
       WHEN 'invocation.prepare' THEN
         invocation.state = 'DISPATCH_PENDING'
         AND command.predecessor_command_id IS NULL
         AND command.cancel_reason IS NULL
       WHEN 'invocation.start' THEN
         invocation.state = 'PERSISTED'
         AND command.cancel_reason IS NULL
         AND predecessor.command_type = 'invocation.prepare'
         AND predecessor.payload_contract_version = 2
         AND predecessor.execution_capability_id = command.execution_capability_id
         AND predecessor.execution_capability_digest = command.execution_capability_digest
         AND predecessor.execution_capability_wire = command.execution_capability_wire
       ELSE false
     END
     AND command.execution_capability_wire->>'capabilityId' =
           command.execution_capability_id::text
     AND command.execution_capability_wire->>'invocationId' = invocation.id::text
     AND command.execution_capability_wire->>'conversationId' =
           invocation.conversation_id::text
     AND command.execution_capability_wire->>'deploymentId' = command.deployment_id::text
     AND command.execution_capability_wire->>'agentVersionId' =
           invocation.agent_version_id::text
     AND command.execution_capability_wire->>'agentVersionDigest' = version.version_digest
     AND command.execution_capability_wire->>'workerInstallationId' =
           command.target_worker_id::text
     AND command.execution_capability_wire->>'leaseId' =
           command.assignment_lease_id::text
     AND (command.execution_capability_wire->>'fence')::bigint =
           command.assignment_fence
     AND command.execution_capability_wire->>'requestDigest' = invocation.request_digest
     AND (command.execution_capability_wire->>'expiresAt')::timestamptz =
           invocation.execution_capability_expires_at
   FOR UPDATE OF command, invocation
   FOR SHARE OF user_message, conversation, version, snapshot, deployment,
                gateway, current_lease;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lifecycle command lost exact current Test delivery authority'
      USING ERRCODE = '55000';
  END IF;
END;
$lock_gateway_lifecycle_v2$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.creator_agent_lock_gateway_lifecycle_command_v2(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, bigint
) FROM PUBLIC, combo_agent_api, combo_agent_consumer_api, combo_agent_reconciler,
  combo_agent_maintenance;
GRANT EXECUTE ON FUNCTION public.creator_agent_lock_gateway_lifecycle_command_v2(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, bigint
) TO combo_agent_broker;

CREATE OR REPLACE FUNCTION public.creator_agent_gateway_lifecycle_claim_receipt_v2_is_safe(
  input_result jsonb
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $lifecycle_claim_receipt_safe$
  SELECT COALESCE((
    pg_catalog.jsonb_typeof(input_result) = 'object'
    AND public.creator_agent_gateway_json_has_exact_keys(
      input_result, ARRAY['sessionId', 'commandId', 'sequence', 'canonicalDigest']
    )
    AND input_result->>'sessionId' ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND input_result->>'commandId' ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND pg_catalog.jsonb_typeof(input_result->'sequence') = 'string'
    AND input_result->>'sequence' ~ '^(0|[1-9][0-9]{0,18})$'
    AND (input_result->>'sequence')::numeric <= 9223372036854775807
    AND input_result->>'canonicalDigest' ~ '^[a-f0-9]{64}$'
  ), false);
$lifecycle_claim_receipt_safe$;

REVOKE ALL ON FUNCTION public.creator_agent_gateway_lifecycle_claim_receipt_v2_is_safe(jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.creator_agent_gateway_lifecycle_claim_receipt_v2_is_safe(jsonb)
  TO combo_agent_broker;

-- CLAIM recovery retains only a strict low-sensitivity reference. Exact lifecycle bytes live in
-- the immutable outbound frame, not in the bounded operation receipt.
CREATE OR REPLACE FUNCTION public.creator_agent_gateway_operation_result_is_safe(
  input_kind text,
  input_result jsonb
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $gateway_operation_result_v2$
DECLARE
  input_session jsonb;
  uuid_v7_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
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
        input_result, ARRAY['lease.grant'], 1
      );
    WHEN 'ACCEPT_ENVELOPE' THEN
      IF public.creator_agent_gateway_json_has_exact_keys(input_result, ARRAY['kind'])
         AND input_result->>'kind' = 'SEQUENCE_CONFLICT' THEN
        RETURN true;
      END IF;
      RETURN public.creator_agent_gateway_json_has_exact_keys(
               input_result, ARRAY['kind', 'responses']
             )
        AND input_result->>'kind' = 'RESPONSES'
        AND public.creator_agent_gateway_accept_response_batch_is_safe(
          input_result->'responses'
        );
    WHEN 'CLAIM_BROKER_COMMAND' THEN
      RETURN COALESCE(
        public.creator_agent_gateway_conversation_open_frame_is_safe(input_result),
        false
      ) OR COALESCE(
        public.creator_agent_gateway_lifecycle_claim_receipt_v2_is_safe(input_result),
        false
      );
    WHEN 'SEQUENCE_GAP', 'CLOSE_SESSION' THEN
      RETURN input_result = 'null'::jsonb;
    ELSE
      RETURN false;
  END CASE;
END;
$gateway_operation_result_v2$;

REVOKE ALL ON FUNCTION public.creator_agent_gateway_operation_result_is_safe(text, jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.creator_agent_gateway_operation_result_is_safe(text, jsonb)
  TO combo_agent_api, combo_agent_broker;

-- The v2 finalizer advances ACCEPTED -> QUEUED -> DISPATCH_PENDING in one transaction. Preserve
-- the old direct API/Consumer rule while admitting the two additional exact events only when the
-- Consumer is executing through the trusted-owner SECURITY DEFINER boundary.
CREATE OR REPLACE FUNCTION public.enforce_creator_agent_api_accepted_event_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $api_lifecycle_event_insert_v2$
DECLARE
  privileged_session boolean;
  uses_api_authority boolean;
  uses_consumer_authority boolean;
  uses_api_like_authority boolean;
  v2_wrapper_owner oid;
  uses_v2_wrapper boolean;
BEGIN
  SELECT session_role.rolsuper OR session_role.rolbypassrls,
         session_user = 'combo_agent_api'
           OR (
             NOT (session_role.rolsuper OR session_role.rolbypassrls)
             AND pg_catalog.pg_has_role(session_user, 'combo_agent_api', 'MEMBER')
           ),
         session_user = 'combo_agent_consumer_api'
           AND NOT (session_role.rolsuper OR session_role.rolbypassrls)
    INTO privileged_session, uses_api_authority, uses_consumer_authority
    FROM pg_catalog.pg_roles AS session_role
   WHERE session_role.rolname = session_user;
  IF COALESCE(privileged_session, false) THEN
    RETURN NEW;
  END IF;
  IF COALESCE(uses_api_authority, false)
     AND COALESCE(uses_consumer_authority, false) THEN
    RAISE EXCEPTION 'API lifecycle Event insert authority is ambiguous'
      USING ERRCODE = '42501';
  END IF;
  uses_api_like_authority :=
    COALESCE(uses_api_authority, false) OR COALESCE(uses_consumer_authority, false);
  SELECT procedure.proowner
    INTO v2_wrapper_owner
    FROM pg_catalog.pg_proc AS procedure
   WHERE procedure.oid =
     'public.creator_agent_finalize_consumer_message_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,bytea,bytea,bytea,text,text,integer,jsonb,text)'::regprocedure;
  uses_v2_wrapper :=
    COALESCE(uses_consumer_authority, false)
    AND current_user <> session_user
    AND current_user::regrole::oid = v2_wrapper_owner;

  IF uses_v2_wrapper THEN
    IF NEW.source IS DISTINCT FROM 'API'
       OR NEW.source_fact_digest IS NOT NULL
       OR NEW.broker_command_id IS NOT NULL
       OR NOT (
         (NEW.event_type = 'invocation.accepted' AND NEW.journal_seq = 1
           AND NEW.payload = '{"state":"ACCEPTED"}'::jsonb)
         OR (NEW.event_type = 'invocation.queued' AND NEW.journal_seq = 2
           AND NEW.payload = '{"state":"QUEUED"}'::jsonb)
         OR (NEW.event_type = 'invocation.leased' AND NEW.journal_seq = 3
           AND NEW.payload = '{"state":"DISPATCH_PENDING"}'::jsonb)
       ) THEN
      RAISE EXCEPTION 'Consumer v2 wrapper may insert only the exact initial lifecycle Events'
        USING ERRCODE = '42501';
    END IF;
  ELSIF uses_api_like_authority AND (
    NEW.source IS DISTINCT FROM 'API'
    OR NEW.event_type IS DISTINCT FROM 'invocation.accepted'
    OR NEW.journal_seq <> 1
    OR NEW.payload <> '{"state":"ACCEPTED"}'::jsonb
    OR NEW.source_fact_digest IS NOT NULL
    OR NEW.broker_command_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'API-like authority may insert only an invocation.accepted Event without Worker authority'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$api_lifecycle_event_insert_v2$;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_api_accepted_event_insert() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.enforce_creator_agent_api_prepare_outbox_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $api_prepare_outbox_insert_v2$
DECLARE
  privileged_session boolean;
  uses_api_authority boolean;
  uses_consumer_authority boolean;
  uses_api_like_authority boolean;
  v2_wrapper_owner oid;
  uses_v2_wrapper boolean;
  exact_request boolean;
BEGIN
  SELECT session_role.rolsuper OR session_role.rolbypassrls,
         session_user = 'combo_agent_api'
           OR (
             NOT (session_role.rolsuper OR session_role.rolbypassrls)
             AND pg_catalog.pg_has_role(session_user, 'combo_agent_api', 'MEMBER')
           ),
         session_user = 'combo_agent_consumer_api'
           AND NOT (session_role.rolsuper OR session_role.rolbypassrls)
    INTO privileged_session, uses_api_authority, uses_consumer_authority
    FROM pg_catalog.pg_roles AS session_role
   WHERE session_role.rolname = session_user;
  IF COALESCE(privileged_session, false) THEN
    RETURN NEW;
  END IF;
  IF COALESCE(uses_api_authority, false)
     AND COALESCE(uses_consumer_authority, false) THEN
    RAISE EXCEPTION 'prepare Outbox insert authority is ambiguous'
      USING ERRCODE = '42501';
  END IF;
  uses_api_like_authority :=
    COALESCE(uses_api_authority, false) OR COALESCE(uses_consumer_authority, false);
  IF COALESCE(uses_consumer_authority, false)
     AND NEW.command_type = 'conversation.open' THEN
    RETURN NEW;
  END IF;
  IF uses_api_like_authority AND NEW.command_type IS DISTINCT FROM 'invocation.prepare' THEN
    RAISE EXCEPTION 'API-like authority may insert only invocation.prepare here'
      USING ERRCODE = '42501';
  END IF;
  IF NOT uses_api_like_authority THEN
    RETURN NEW;
  END IF;

  SELECT procedure.proowner
    INTO v2_wrapper_owner
    FROM pg_catalog.pg_proc AS procedure
   WHERE procedure.oid =
     'public.creator_agent_finalize_consumer_message_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,bytea,bytea,bytea,text,text,integer,jsonb,text)'::regprocedure;
  uses_v2_wrapper :=
    COALESCE(uses_consumer_authority, false)
    AND current_user <> session_user
    AND current_user::regrole::oid = v2_wrapper_owner;

  IF NEW.payload_contract_version = 2 THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.agent_invocations AS invocation
        JOIN public.agent_conversations AS conversation
          ON conversation.id = invocation.conversation_id
         AND conversation.creator_id = invocation.creator_id
         AND conversation.consumer_subject_id = invocation.consumer_subject_id
       WHERE invocation.id = NEW.invocation_id
         AND invocation.creator_id = NEW.creator_id
         AND invocation.consumer_subject_id = NEW.consumer_subject_id
         AND invocation.state = 'DISPATCH_PENDING'
         AND invocation.conversation_id = NEW.conversation_id
         AND invocation.assigned_worker_id = NEW.target_worker_id
         AND invocation.assignment_lease_id = NEW.assignment_lease_id
         AND invocation.assignment_fence = NEW.assignment_fence
         AND invocation.execution_capability_id = NEW.execution_capability_id
         AND invocation.execution_capability_digest = NEW.execution_capability_digest
         AND invocation.execution_capability_expires_at =
               (NEW.execution_capability_wire->>'expiresAt')::timestamptz
         AND conversation.deployment_id = NEW.deployment_id
         AND invocation.deadline_at = NEW.expires_at
         AND NEW.dedupe_key = 'invocation:' || invocation.id::text || ':prepare'
         AND NEW.execution_capability_wire->>'capabilityId' =
               invocation.execution_capability_id::text
         AND NEW.execution_capability_wire->>'invocationId' = invocation.id::text
         AND NEW.execution_capability_wire->>'requestDigest' = invocation.request_digest
    ) INTO exact_request;
    IF NOT uses_v2_wrapper
       OR NEW.state IS DISTINCT FROM 'PENDING'
       OR NEW.attempt_count <> 0
       OR NEW.acked_at IS NOT NULL
       OR NEW.predecessor_command_id IS NOT NULL
       OR NEW.execution_capability_wire IS NULL
       OR NEW.cancel_reason IS NOT NULL
       OR NOT COALESCE(exact_request, false) THEN
      RAISE EXCEPTION 'Consumer v2 wrapper may insert only one exact invocation.prepare source'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    SELECT EXISTS (
      SELECT 1
        FROM public.agent_invocations AS invocation
        JOIN public.agent_conversations AS conversation
          ON conversation.id = invocation.conversation_id
         AND conversation.creator_id = invocation.creator_id
         AND conversation.consumer_subject_id = invocation.consumer_subject_id
       WHERE invocation.id = NEW.invocation_id
         AND invocation.creator_id = NEW.creator_id
         AND invocation.consumer_subject_id = NEW.consumer_subject_id
         AND invocation.state = 'ACCEPTED'
         AND invocation.assigned_worker_id IS NULL
         AND invocation.assignment_lease_id IS NULL
         AND invocation.assignment_fence IS NULL
         AND invocation.execution_capability_id IS NULL
         AND invocation.execution_capability_digest IS NULL
         AND invocation.execution_capability_expires_at IS NULL
         AND invocation.execution_capability_revoked_at IS NULL
         AND conversation.assigned_worker_id = NEW.target_worker_id
         AND invocation.deadline_at = NEW.expires_at
         AND NEW.dedupe_key = 'invocation:' || invocation.id::text || ':prepare'
    ) INTO exact_request;
    IF NEW.payload_contract_version <> 0
       OR NEW.state IS DISTINCT FROM 'PENDING'
       OR NEW.attempt_count <> 0
       OR NEW.acked_at IS NOT NULL
       OR NEW.conversation_id IS NOT NULL
       OR NEW.deployment_id IS NOT NULL
       OR NEW.assignment_lease_id IS NOT NULL
       OR NEW.assignment_fence IS NOT NULL
       OR NEW.predecessor_command_id IS NOT NULL
       OR NEW.execution_capability_id IS NOT NULL
       OR NEW.execution_capability_digest IS NOT NULL
       OR NEW.execution_capability_wire IS NOT NULL
       OR NEW.cancel_reason IS NOT NULL
       OR NOT COALESCE(exact_request, false) THEN
      RAISE EXCEPTION 'API-like authority may insert only the exact legacy invocation.prepare source'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$api_prepare_outbox_insert_v2$;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_api_prepare_outbox_insert() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.enforce_creator_agent_message_accept_chain()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $message_accept_chain_v2$
DECLARE
  uses_api_authority boolean;
  uses_consumer_authority boolean;
  uses_broker_authority boolean;
  privileged_session boolean;
  uses_api_like_authority boolean;
  exact_chain boolean;
BEGIN
  SELECT session_role.rolsuper OR session_role.rolbypassrls,
         session_user = 'combo_agent_api'
           OR (
             NOT (session_role.rolsuper OR session_role.rolbypassrls)
             AND pg_catalog.pg_has_role(session_user, 'combo_agent_api', 'MEMBER')
           ),
         session_user = 'combo_agent_consumer_api'
           AND NOT (session_role.rolsuper OR session_role.rolbypassrls),
         session_user = 'combo_agent_broker'
           OR (
             NOT (session_role.rolsuper OR session_role.rolbypassrls)
             AND pg_catalog.pg_has_role(session_user, 'combo_agent_broker', 'MEMBER')
           )
    INTO privileged_session, uses_api_authority,
         uses_consumer_authority, uses_broker_authority
    FROM pg_catalog.pg_roles AS session_role
   WHERE session_role.rolname = session_user;
  IF COALESCE(privileged_session, false) THEN
    RETURN NEW;
  END IF;
  IF (COALESCE(uses_api_authority, false) AND COALESCE(uses_consumer_authority, false))
     OR (
       (COALESCE(uses_api_authority, false) OR COALESCE(uses_consumer_authority, false))
       AND COALESCE(uses_broker_authority, false)
     ) THEN
    RAISE EXCEPTION 'Message exact-chain authority is ambiguous'
      USING ERRCODE = '42501';
  END IF;
  uses_api_like_authority :=
    COALESCE(uses_api_authority, false) OR COALESCE(uses_consumer_authority, false);

  IF uses_api_like_authority THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.agent_invocations AS invocation
        JOIN public.agent_conversations AS conversation
          ON conversation.id = invocation.conversation_id
         AND conversation.creator_id = invocation.creator_id
         AND conversation.consumer_subject_id = invocation.consumer_subject_id
        JOIN public.agent_invocation_events AS accepted_event
          ON accepted_event.invocation_id = invocation.id
         AND accepted_event.creator_id = invocation.creator_id
         AND accepted_event.consumer_subject_id = invocation.consumer_subject_id
         AND accepted_event.journal_seq = 1
         AND accepted_event.source = 'API'
         AND accepted_event.event_type = 'invocation.accepted'
         AND accepted_event.payload = '{"state":"ACCEPTED"}'::jsonb
         AND accepted_event.source_fact_digest IS NULL
         AND accepted_event.broker_command_id IS NULL
        JOIN public.broker_outbox AS prepare_command
          ON prepare_command.invocation_id = invocation.id
         AND prepare_command.creator_id = invocation.creator_id
         AND prepare_command.consumer_subject_id = invocation.consumer_subject_id
         AND prepare_command.command_type = 'invocation.prepare'
         AND prepare_command.dedupe_key =
               'invocation:' || invocation.id::text || ':prepare'
         AND prepare_command.state = 'PENDING'
         AND prepare_command.attempt_count = 0
         AND prepare_command.acked_at IS NULL
         AND prepare_command.expires_at = invocation.deadline_at
         AND prepare_command.target_worker_id = conversation.assigned_worker_id
       WHERE invocation.id = NEW.invocation_id
         AND invocation.conversation_id = NEW.conversation_id
         AND invocation.creator_id = NEW.creator_id
         AND invocation.consumer_subject_id = NEW.consumer_subject_id
         AND invocation.user_message_id = NEW.id
         AND invocation.client_message_id = NEW.client_message_id
         AND NEW.role = 'USER'
         AND (
           (
             prepare_command.payload_contract_version = 0
             AND invocation.state = 'ACCEPTED'
             AND invocation.assigned_worker_id IS NULL
             AND invocation.assignment_lease_id IS NULL
             AND invocation.assignment_fence IS NULL
             AND invocation.execution_capability_id IS NULL
             AND invocation.execution_capability_digest IS NULL
             AND invocation.execution_capability_expires_at IS NULL
             AND invocation.execution_capability_revoked_at IS NULL
             AND prepare_command.conversation_id IS NULL
             AND prepare_command.deployment_id IS NULL
             AND prepare_command.assignment_lease_id IS NULL
             AND prepare_command.assignment_fence IS NULL
             AND prepare_command.execution_capability_id IS NULL
             AND prepare_command.execution_capability_digest IS NULL
             AND prepare_command.execution_capability_wire IS NULL
           )
           OR
           (
             prepare_command.payload_contract_version = 2
             AND invocation.state = 'DISPATCH_PENDING'
             AND invocation.assigned_worker_id = conversation.assigned_worker_id
             AND invocation.assignment_lease_id = prepare_command.assignment_lease_id
             AND invocation.assignment_fence = prepare_command.assignment_fence
             AND invocation.execution_capability_id =
                   prepare_command.execution_capability_id
             AND invocation.execution_capability_digest =
                   prepare_command.execution_capability_digest
             AND invocation.execution_capability_expires_at =
                   (prepare_command.execution_capability_wire->>'expiresAt')::timestamptz
             AND invocation.execution_capability_revoked_at IS NULL
             AND prepare_command.conversation_id = invocation.conversation_id
             AND prepare_command.deployment_id = conversation.deployment_id
             AND prepare_command.predecessor_command_id IS NULL
             AND prepare_command.execution_capability_wire IS NOT NULL
             AND prepare_command.cancel_reason IS NULL
             AND prepare_command.execution_capability_wire->>'invocationId' =
                   invocation.id::text
             AND prepare_command.execution_capability_wire->>'requestDigest' =
                   invocation.request_digest
             AND EXISTS (
               SELECT 1
                 FROM public.agent_invocation_events AS queued_event
                WHERE queued_event.invocation_id = invocation.id
                  AND queued_event.creator_id = invocation.creator_id
                  AND queued_event.consumer_subject_id = invocation.consumer_subject_id
                  AND queued_event.journal_seq = 2
                  AND queued_event.source = 'API'
                  AND queued_event.event_type = 'invocation.queued'
                  AND queued_event.payload = '{"state":"QUEUED"}'::jsonb
                  AND queued_event.source_fact_digest IS NULL
                  AND queued_event.broker_command_id IS NULL
             )
             AND EXISTS (
               SELECT 1
                 FROM public.agent_invocation_events AS leased_event
                WHERE leased_event.invocation_id = invocation.id
                  AND leased_event.creator_id = invocation.creator_id
                  AND leased_event.consumer_subject_id = invocation.consumer_subject_id
                  AND leased_event.journal_seq = 3
                  AND leased_event.source = 'API'
                  AND leased_event.event_type = 'invocation.leased'
                  AND leased_event.payload = '{"state":"DISPATCH_PENDING"}'::jsonb
                  AND leased_event.source_fact_digest IS NULL
                  AND leased_event.broker_command_id IS NULL
             )
           )
         )
    ) INTO exact_chain;
  ELSIF COALESCE(uses_broker_authority, false) THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.agent_invocations AS invocation
        JOIN public.agent_conversations AS conversation
          ON conversation.id = invocation.conversation_id
         AND conversation.creator_id = invocation.creator_id
         AND conversation.consumer_subject_id = invocation.consumer_subject_id
         AND conversation.state = 'IDLE'
        JOIN public.agent_messages AS user_message
          ON user_message.id = invocation.user_message_id
         AND user_message.conversation_id = invocation.conversation_id
         AND user_message.creator_id = invocation.creator_id
         AND user_message.consumer_subject_id = invocation.consumer_subject_id
         AND user_message.turn_no = NEW.turn_no
         AND user_message.role = 'USER'
        JOIN public.agent_invocation_events AS terminal_event
          ON terminal_event.invocation_id = invocation.id
         AND terminal_event.creator_id = invocation.creator_id
         AND terminal_event.consumer_subject_id = invocation.consumer_subject_id
         AND terminal_event.source = 'WORKER'
         AND terminal_event.event_type = 'invocation.succeeded'
         AND terminal_event.source_fact_digest IS NOT NULL
         AND terminal_event.broker_command_id IS NULL
         AND terminal_event.payload = pg_catalog.jsonb_build_object(
               'state', 'SUCCEEDED',
               'messageId', NEW.id,
               'resultDigest', invocation.result_digest
             )
        JOIN public.consumer_event_outbox AS terminal_outbox
          ON terminal_outbox.owner_id = invocation.consumer_subject_id
         AND terminal_outbox.conversation_id = invocation.conversation_id
         AND terminal_outbox.invocation_id = invocation.id
         AND terminal_outbox.source_event_id = terminal_event.id
         AND terminal_outbox.event_type = 'invocation.terminal'
         AND terminal_outbox.payload->>'type' = 'invocation.terminal'
         AND terminal_outbox.payload->>'terminalState' = 'SUCCEEDED'
         AND terminal_outbox.payload->>'assistantMessageId' = NEW.id::text
         AND terminal_outbox.payload->>'resultDigest' = invocation.result_digest
        JOIN public.consumer_event_streams AS terminal_stream
          ON terminal_stream.owner_id = terminal_outbox.owner_id
         AND terminal_stream.conversation_id = terminal_outbox.conversation_id
         AND terminal_stream.latest_cursor >= terminal_outbox.cursor
       WHERE invocation.id = NEW.invocation_id
         AND invocation.conversation_id = NEW.conversation_id
         AND invocation.creator_id = NEW.creator_id
         AND invocation.consumer_subject_id = NEW.consumer_subject_id
         AND invocation.state = 'SUCCEEDED'
         AND invocation.result_message_id = NEW.id
         AND invocation.result_digest IS NOT NULL
         AND invocation.terminal_at IS NOT NULL
         AND NEW.role = 'ASSISTANT'
    ) INTO exact_chain;
  ELSE
    RETURN NEW;
  END IF;

  IF NOT COALESCE(exact_chain, false) THEN
    RAISE EXCEPTION 'Message is not bound to one exact durable accept/terminal chain'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$message_accept_chain_v2$;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_message_accept_chain() FROM PUBLIC;

-- ===================== Runtime preflight and atomic send finalize =====================

-- The public send path must not borrow the legacy combo_runtime pool merely to mint identities.
-- This narrow definer issues exactly one fresh-send batch and nothing else.
CREATE OR REPLACE FUNCTION public.creator_agent_issue_runtime_product_ids_v2(
  input_count integer
)
RETURNS TABLE(ordinal integer, id uuid)
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $runtime_product_ids_v2$
BEGIN
  IF session_user <> 'combo_agent_consumer_api'
     OR current_user = session_user THEN
    RAISE EXCEPTION 'Runtime product ID issue requires exact isolated Consumer authority'
      USING ERRCODE = '42501';
  END IF;
  IF input_count IS DISTINCT FROM 8 THEN
    RAISE EXCEPTION 'Runtime product ID issue requires one exact fresh-send batch'
      USING ERRCODE = '23514';
  END IF;
  RETURN QUERY
  SELECT series.ordinal, public.gen_uuid_v7()
    FROM pg_catalog.generate_series(1, input_count) AS series(ordinal)
   ORDER BY series.ordinal;
END;
$runtime_product_ids_v2$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.creator_agent_issue_runtime_product_ids_v2(integer)
  FROM PUBLIC, combo_agent_api, combo_agent_broker, combo_agent_reconciler,
    combo_agent_maintenance;
GRANT EXECUTE ON FUNCTION public.creator_agent_issue_runtime_product_ids_v2(integer)
  TO combo_agent_consumer_api;

CREATE OR REPLACE FUNCTION public.creator_agent_preflight_consumer_message_v2(
  input_conversation_id uuid,
  input_consumer_id uuid,
  input_client_message_id text,
  input_request_digest text
)
RETURNS TABLE(
  outcome text,
  existing_invocation_id uuid,
  existing_state text,
  creator_id uuid,
  deployment_id uuid,
  agent_version_id uuid,
  agent_version_digest text,
  snapshot_digest text,
  installation_id uuid,
  lease_id uuid,
  fence bigint,
  capability_not_before timestamptz,
  deadline_at timestamptz,
  capability_expires_at timestamptz,
  resolved_model text,
  reasoning_effort text
)
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $consumer_preflight_v2$
DECLARE
  existing record;
  authority record;
  preflight_now timestamptz;
BEGIN
  IF session_user <> 'combo_agent_consumer_api'
     OR current_user = session_user
     OR input_consumer_id IS DISTINCT FROM
          NULLIF(current_setting('app.consumer_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Consumer message preflight requires exact isolated authority'
      USING ERRCODE = '42501';
  END IF;
  IF input_client_message_id !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR input_request_digest !~ '^hmac-sha256:[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Consumer message preflight candidate is invalid'
      USING ERRCODE = '23514';
  END IF;

  SELECT invocation.id, invocation.state, invocation.request_digest,
         message.id AS durable_message_id,
         command.command_id,
         command.payload_contract_version,
         command.execution_capability_wire
    INTO existing
    FROM public.agent_invocations AS invocation
    LEFT JOIN public.agent_messages AS message
      ON message.id = invocation.user_message_id
     AND message.conversation_id = invocation.conversation_id
     AND message.creator_id = invocation.creator_id
     AND message.consumer_subject_id = invocation.consumer_subject_id
     AND message.invocation_id = invocation.id
     AND message.role = 'USER'
    LEFT JOIN public.broker_outbox AS command
      ON command.invocation_id = invocation.id
     AND command.creator_id = invocation.creator_id
     AND command.consumer_subject_id = invocation.consumer_subject_id
     AND command.command_type = 'invocation.prepare'
   WHERE invocation.conversation_id = input_conversation_id
     AND invocation.consumer_subject_id = input_consumer_id
     AND invocation.client_message_id = input_client_message_id;
  IF FOUND THEN
    IF existing.request_digest IS DISTINCT FROM input_request_digest THEN
      RETURN QUERY SELECT
        'CONFLICT'::text, NULL::uuid, NULL::text, NULL::uuid, NULL::uuid,
        NULL::uuid, NULL::text, NULL::text, NULL::uuid, NULL::uuid, NULL::bigint,
        NULL::timestamptz, NULL::timestamptz, NULL::timestamptz,
        NULL::text, NULL::text;
    ELSE
      IF existing.durable_message_id IS NULL
         OR existing.command_id IS NULL
         OR existing.payload_contract_version IS DISTINCT FROM 2
         OR existing.execution_capability_wire IS NULL THEN
        RAISE EXCEPTION 'Consumer message v2 preflight replay durable chain is incomplete'
          USING ERRCODE = '55000';
      END IF;
      RETURN QUERY SELECT
        'REPLAY'::text, existing.id::uuid, existing.state::text,
        NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
        NULL::uuid, NULL::uuid, NULL::bigint, NULL::timestamptz, NULL::timestamptz,
        NULL::timestamptz, NULL::text, NULL::text;
    END IF;
    RETURN;
  END IF;

  preflight_now := date_trunc('milliseconds', clock_timestamp());
  SELECT conversation.creator_id,
         conversation.deployment_id,
         conversation.agent_version_id,
         conversation.version_digest,
         snapshot.snapshot_digest,
         conversation.assigned_worker_id,
         lease.id,
         lease.fence,
         version.runtime_policy->>'maxTurnSeconds' AS max_turn_seconds,
         version.runtime_policy->>'resolvedModel' AS resolved_model,
         version.runtime_policy->>'reasoningEffort' AS reasoning_effort
    INTO authority
    FROM public.agent_conversations AS conversation
    JOIN public.deployments AS deployment
      ON deployment.id = conversation.deployment_id
     AND deployment.creator_id = conversation.creator_id
    JOIN public.agent_versions AS version
      ON version.id = conversation.agent_version_id
     AND version.creator_id = conversation.creator_id
     AND version.version_digest = conversation.version_digest
    JOIN public.context_snapshots AS snapshot
      ON snapshot.id = version.snapshot_id
     AND snapshot.creator_id = version.creator_id
    JOIN public.agent_version_controls AS version_control
      ON version_control.version_id = version.id
     AND version_control.creator_id = version.creator_id
    JOIN public.worker_leases AS lease
      ON lease.deployment_id = deployment.id
     AND lease.creator_id = deployment.creator_id
     AND lease.worker_id = conversation.assigned_worker_id
     AND lease.fence = deployment.lease_fence
    JOIN public.worker_gateway_sessions AS gateway
      ON gateway.creator_id = deployment.creator_id
     AND gateway.installation_id = conversation.assigned_worker_id
     AND gateway.connection_id = lease.connection_id
   WHERE conversation.id = input_conversation_id
     AND conversation.consumer_subject_id = input_consumer_id
     AND conversation.state = 'IDLE'
     AND conversation.context_limit_reached_at IS NULL
     AND conversation.expires_at > preflight_now
     AND deployment.environment = 'TEST'
     AND deployment.desired_state = 'ONLINE'
     AND deployment.observed_state = 'ONLINE'
     AND deployment.serving_version_id = conversation.agent_version_id
     AND deployment.observed_worker_id = conversation.assigned_worker_id
     AND deployment.observed_generation = deployment.generation
     AND version_control.availability = 'ACTIVE'
     AND version_control.severity = 'NORMAL'
     AND lease.state = 'ACTIVE'
     AND lease.expires_at > preflight_now + interval '3 seconds'
     AND gateway.state = 'ACTIVE'
     AND gateway.expires_at > preflight_now + interval '3 seconds'
     AND pg_catalog.jsonb_typeof(version.runtime_policy->'maxTurnSeconds') = 'number'
     AND version.runtime_policy->>'maxTurnSeconds' ~ '^(?:[1-9]|[1-9][0-9]|1[01][0-9]|120)$'
     AND version.runtime_policy->>'resolvedModel' ~
           '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
     AND version.runtime_policy->>'reasoningEffort' IN ('low', 'medium', 'high', 'xhigh');
  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'UNAVAILABLE'::text, NULL::uuid, NULL::text, NULL::uuid, NULL::uuid,
      NULL::uuid, NULL::text, NULL::text, NULL::uuid, NULL::uuid, NULL::bigint,
      NULL::timestamptz, NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    'READY'::text, NULL::uuid, NULL::text,
    authority.creator_id::uuid,
    authority.deployment_id::uuid,
    authority.agent_version_id::uuid,
    authority.version_digest::text,
    authority.snapshot_digest::text,
    authority.assigned_worker_id::uuid,
    authority.id::uuid,
    authority.fence::bigint,
    preflight_now - interval '1 second',
    preflight_now + authority.max_turn_seconds::integer * interval '1 second',
    preflight_now + authority.max_turn_seconds::integer * interval '1 second' + interval '30 seconds',
    authority.resolved_model::text,
    authority.reasoning_effort::text;
END;
$consumer_preflight_v2$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.creator_agent_preflight_consumer_message_v2(
  uuid, uuid, text, text
) FROM PUBLIC, combo_agent_api, combo_agent_broker, combo_agent_reconciler,
  combo_agent_maintenance;
GRANT EXECUTE ON FUNCTION public.creator_agent_preflight_consumer_message_v2(
  uuid, uuid, text, text
) TO combo_agent_consumer_api;

CREATE OR REPLACE FUNCTION public.creator_agent_finalize_consumer_message_v2(
  input_conversation_id uuid,
  input_consumer_id uuid,
  input_user_message_id uuid,
  input_invocation_id uuid,
  input_prepare_command_id uuid,
  input_accepted_source_event_id uuid,
  input_queued_source_event_id uuid,
  input_leased_source_event_id uuid,
  input_client_message_id text,
  input_request_digest text,
  input_content_algorithm text,
  input_content_key_id text,
  input_content_nonce bytea,
  input_content_ciphertext bytea,
  input_content_auth_tag bytea,
  input_content_cipher_digest text,
  input_content_digest text,
  input_content_aad_version integer,
  input_execution_capability_wire jsonb,
  input_execution_capability_digest text
)
RETURNS TABLE(
  finalize_outcome text,
  user_message_id uuid,
  invocation_id uuid,
  invocation_state text,
  outbox_command_id uuid,
  deadline_at timestamptz
)
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $consumer_finalize_v2$
DECLARE
  existing record;
  authority record;
  context_outcome text;
  accepted_at timestamptz;
  capability_expires_at timestamptz;
  capability_id uuid;
  conversation_creator_id uuid;
  conversation_deployment_id uuid;
  conversation_agent_version_id uuid;
  version_authority_live boolean;
BEGIN
  IF session_user <> 'combo_agent_consumer_api'
     OR current_user = session_user
     OR input_consumer_id IS DISTINCT FROM
          NULLIF(current_setting('app.consumer_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Consumer message finalize requires exact isolated authority'
      USING ERRCODE = '42501';
  END IF;
  IF input_client_message_id !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR input_user_message_id::text !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR input_invocation_id::text !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR input_prepare_command_id::text !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR input_accepted_source_event_id::text !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR input_queued_source_event_id::text !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR input_leased_source_event_id::text !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR input_request_digest !~ '^hmac-sha256:[a-f0-9]{64}$'
     OR input_execution_capability_digest !~ '^[a-f0-9]{64}$'
     OR NOT public.creator_agent_execution_capability_wire_v1_is_safe(
       input_execution_capability_wire
     )
     OR input_execution_capability_digest IS DISTINCT FROM
          public.creator_agent_execution_capability_wire_v1_digest(
            input_execution_capability_wire
          ) THEN
    RAISE EXCEPTION 'Consumer message finalize candidate is invalid'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      input_conversation_id::text || ':' || input_client_message_id,
      0
    )
  );

  SELECT invocation.id, invocation.user_message_id, invocation.state,
         invocation.request_digest, command.command_id,
         message.id AS durable_message_id,
         command.payload_contract_version,
         command.execution_capability_wire
    INTO existing
    FROM public.agent_invocations AS invocation
    LEFT JOIN public.agent_messages AS message
      ON message.id = invocation.user_message_id
     AND message.conversation_id = invocation.conversation_id
     AND message.creator_id = invocation.creator_id
     AND message.consumer_subject_id = invocation.consumer_subject_id
     AND message.invocation_id = invocation.id
     AND message.role = 'USER'
    LEFT JOIN public.broker_outbox AS command
      ON command.invocation_id = invocation.id
     AND command.creator_id = invocation.creator_id
     AND command.consumer_subject_id = invocation.consumer_subject_id
     AND command.command_type = 'invocation.prepare'
   WHERE invocation.conversation_id = input_conversation_id
     AND invocation.consumer_subject_id = input_consumer_id
     AND invocation.client_message_id = input_client_message_id;
  IF FOUND THEN
    IF existing.request_digest IS DISTINCT FROM input_request_digest THEN
      RETURN QUERY SELECT
        'CONFLICT'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::uuid,
        NULL::timestamptz;
    ELSE
      IF existing.durable_message_id IS NULL
         OR existing.command_id IS NULL
         OR existing.payload_contract_version IS DISTINCT FROM 2
         OR existing.execution_capability_wire IS NULL THEN
        RAISE EXCEPTION 'Consumer message v2 replay durable chain is incomplete'
          USING ERRCODE = '55000';
      END IF;
      RETURN QUERY SELECT
        'REPLAY'::text, existing.user_message_id::uuid, existing.id::uuid,
        existing.state::text, existing.command_id::uuid,
        (SELECT deadline_at FROM public.agent_invocations WHERE id = existing.id)::timestamptz;
    END IF;
    RETURN;
  END IF;

  -- Resolve only the immutable lock identity, then enter the same Deployment advisory lock order
  -- used by Version SECURITY transitions and the legacy v1 accept authority. This read grants no
  -- execution authority; every mutable fact is revalidated below while the locks are held.
  SELECT conversation.creator_id,
         conversation.deployment_id,
         conversation.agent_version_id
    INTO conversation_creator_id,
         conversation_deployment_id,
         conversation_agent_version_id
    FROM public.agent_conversations AS conversation
   WHERE conversation.id = input_conversation_id
     AND conversation.consumer_subject_id = input_consumer_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'UNAVAILABLE'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::uuid,
      NULL::timestamptz;
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'combo.gateway.deployment/v1:'
        || conversation_creator_id::text
        || ':'
        || conversation_deployment_id::text,
      0
    )
  );
  BEGIN
    SELECT true
      INTO version_authority_live
      FROM public.agent_version_controls AS version_control
     WHERE version_control.version_id = conversation_agent_version_id
       AND version_control.creator_id = conversation_creator_id
       AND version_control.availability = 'ACTIVE'
       AND version_control.severity = 'NORMAL'
     FOR SHARE NOWAIT;
  EXCEPTION
    WHEN lock_not_available THEN
      RAISE EXCEPTION
        'Consumer message v2 Version authority is concurrently changing; retry transaction'
        USING ERRCODE = '40001';
  END;
  IF version_authority_live IS DISTINCT FROM true THEN
    RETURN QUERY SELECT
      'UNAVAILABLE'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::uuid,
      NULL::timestamptz;
    RETURN;
  END IF;

  SELECT conversation.creator_id,
         conversation.deployment_id,
         conversation.agent_version_id,
         conversation.version_digest,
         conversation.assigned_worker_id,
         conversation.next_turn_no,
         version.runtime_policy->>'maxTurnSeconds' AS max_turn_seconds,
         version.runtime_policy->>'resolvedModel' AS resolved_model,
         version.runtime_policy->>'reasoningEffort' AS reasoning_effort,
         snapshot.snapshot_digest,
         lease.id AS lease_id,
         lease.fence
    INTO authority
    FROM public.agent_conversations AS conversation
    JOIN public.deployments AS deployment
      ON deployment.id = conversation.deployment_id
     AND deployment.creator_id = conversation.creator_id
    JOIN public.agent_versions AS version
      ON version.id = conversation.agent_version_id
     AND version.creator_id = conversation.creator_id
     AND version.version_digest = conversation.version_digest
    JOIN public.context_snapshots AS snapshot
      ON snapshot.id = version.snapshot_id
     AND snapshot.creator_id = version.creator_id
    JOIN public.agent_version_controls AS version_control
      ON version_control.version_id = version.id
     AND version_control.creator_id = version.creator_id
    JOIN public.worker_installations AS installation
      ON installation.id = conversation.assigned_worker_id
     AND installation.creator_id = conversation.creator_id
     AND installation.revoked_at IS NULL
    JOIN public.worker_leases AS lease
      ON lease.deployment_id = deployment.id
     AND lease.creator_id = deployment.creator_id
     AND lease.worker_id = conversation.assigned_worker_id
     AND lease.fence = deployment.lease_fence
    JOIN public.worker_gateway_sessions AS gateway
      ON gateway.creator_id = deployment.creator_id
     AND gateway.installation_id = conversation.assigned_worker_id
     AND gateway.connection_id = lease.connection_id
   WHERE conversation.id = input_conversation_id
     AND conversation.consumer_subject_id = input_consumer_id
     AND conversation.creator_id = conversation_creator_id
     AND conversation.deployment_id = conversation_deployment_id
     AND conversation.agent_version_id = conversation_agent_version_id
     AND conversation.state = 'IDLE'
     AND conversation.context_limit_reached_at IS NULL
     AND conversation.expires_at > clock_timestamp()
     AND deployment.environment = 'TEST'
     AND deployment.desired_state = 'ONLINE'
     AND deployment.observed_state = 'ONLINE'
     AND deployment.serving_version_id = conversation.agent_version_id
     AND deployment.observed_worker_id = conversation.assigned_worker_id
     AND deployment.observed_generation = deployment.generation
     AND version_control.availability = 'ACTIVE'
     AND version_control.severity = 'NORMAL'
     AND lease.state = 'ACTIVE'
     AND lease.expires_at > clock_timestamp() + interval '3 seconds'
     AND gateway.state = 'ACTIVE'
     AND gateway.expires_at > clock_timestamp() + interval '3 seconds'
     AND version.runtime_policy->>'resolvedModel' ~
           '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
     AND version.runtime_policy->>'reasoningEffort' IN ('low', 'medium', 'high', 'xhigh')
   FOR UPDATE OF conversation
   FOR SHARE OF deployment, installation, lease, gateway;
  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'UNAVAILABLE'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::uuid,
      NULL::timestamptz;
    RETURN;
  END IF;

  accepted_at := date_trunc('milliseconds', clock_timestamp());
  capability_id := (input_execution_capability_wire->>'capabilityId')::uuid;
  capability_expires_at := (input_execution_capability_wire->>'expiresAt')::timestamptz;
  IF input_execution_capability_wire->>'invocationId' <> input_invocation_id::text
     OR input_execution_capability_wire->>'conversationId' <> input_conversation_id::text
     OR input_execution_capability_wire->>'deploymentId' <> authority.deployment_id::text
     OR input_execution_capability_wire->>'agentVersionId' <> authority.agent_version_id::text
     OR input_execution_capability_wire->>'agentVersionDigest' <> authority.version_digest
     OR input_execution_capability_wire->>'workerInstallationId' <>
          authority.assigned_worker_id::text
     OR input_execution_capability_wire->>'leaseId' <> authority.lease_id::text
     OR (input_execution_capability_wire->>'fence')::bigint <> authority.fence
     OR input_execution_capability_wire->>'requestDigest' <> input_request_digest
     OR input_execution_capability_wire->>'model' <> authority.resolved_model
     OR input_execution_capability_wire->>'reasoningEffort' <> authority.reasoning_effort
     OR (input_execution_capability_wire->>'notBefore')::timestamptz > accepted_at
     OR (input_execution_capability_wire->>'notBefore')::timestamptz <
          accepted_at - interval '30 seconds'
     OR capability_expires_at <= accepted_at
     OR capability_expires_at >
          accepted_at + authority.max_turn_seconds::integer * interval '1 second'
            + interval '30 seconds' THEN
    RETURN QUERY SELECT
      'AUTHORITY_REJECTED'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::uuid,
      NULL::timestamptz;
    RETURN;
  END IF;

  PERFORM set_config('app.creator_id', authority.creator_id::text, true);
  SELECT core.admission_outcome
    INTO context_outcome
    FROM public.creator_agent_admit_user_message_core_v1(
      input_user_message_id,
      input_conversation_id,
      authority.creator_id,
      input_consumer_id,
      authority.agent_version_id,
      authority.version_digest,
      authority.assigned_worker_id,
      authority.next_turn_no,
      accepted_at + authority.max_turn_seconds::integer * interval '1 second',
      input_client_message_id,
      input_content_algorithm,
      input_content_key_id,
      input_content_nonce,
      input_content_ciphertext,
      input_content_auth_tag,
      input_content_cipher_digest,
      input_content_digest,
      input_content_aad_version,
      input_invocation_id
    ) AS core;
  IF context_outcome = 'CONTEXT_LIMIT' THEN
    RETURN QUERY SELECT
      'CONTEXT_LIMIT'::text, NULL::uuid, NULL::uuid, NULL::text, NULL::uuid,
      NULL::timestamptz;
    RETURN;
  END IF;
  IF context_outcome IS DISTINCT FROM 'ADMITTED' THEN
    RAISE EXCEPTION 'Consumer message v2 admission returned unknown outcome'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.agent_invocations (
    id, conversation_id, creator_id, consumer_subject_id, agent_version_id,
    user_message_id, client_message_id, request_digest, state, deadline_at
  ) VALUES (
    input_invocation_id, input_conversation_id, authority.creator_id, input_consumer_id,
    authority.agent_version_id, input_user_message_id, input_client_message_id,
    input_request_digest, 'ACCEPTED',
    accepted_at + authority.max_turn_seconds::integer * interval '1 second'
  );
  INSERT INTO public.agent_invocation_events (
    invocation_id, creator_id, consumer_subject_id, journal_seq, source,
    source_event_id, event_type, payload, occurred_at
  ) VALUES (
    input_invocation_id, authority.creator_id, input_consumer_id, 1, 'API',
    input_accepted_source_event_id::text, 'invocation.accepted',
    '{"state":"ACCEPTED"}'::jsonb, accepted_at
  );

  UPDATE public.agent_invocations
     SET assigned_worker_id = authority.assigned_worker_id,
         assignment_lease_id = authority.lease_id,
         assignment_fence = authority.fence,
         execution_capability_id = capability_id,
         execution_capability_digest = input_execution_capability_digest,
         execution_capability_expires_at = capability_expires_at
   WHERE id = input_invocation_id;
  UPDATE public.agent_invocations SET state = 'QUEUED' WHERE id = input_invocation_id;
  INSERT INTO public.agent_invocation_events (
    invocation_id, creator_id, consumer_subject_id, journal_seq, source,
    source_event_id, event_type, payload, occurred_at
  ) VALUES (
    input_invocation_id, authority.creator_id, input_consumer_id, 2, 'API',
    input_queued_source_event_id::text, 'invocation.queued',
    '{"state":"QUEUED"}'::jsonb, accepted_at
  );
  UPDATE public.agent_invocations SET state = 'DISPATCH_PENDING' WHERE id = input_invocation_id;
  INSERT INTO public.agent_invocation_events (
    invocation_id, creator_id, consumer_subject_id, journal_seq, source,
    source_event_id, event_type, payload, occurred_at
  ) VALUES (
    input_invocation_id, authority.creator_id, input_consumer_id, 3, 'API',
    input_leased_source_event_id::text, 'invocation.leased',
    '{"state":"DISPATCH_PENDING"}'::jsonb, accepted_at
  );

  INSERT INTO public.broker_outbox (
    command_id, creator_id, target_worker_id, invocation_id, consumer_subject_id,
    conversation_id, deployment_id, assignment_lease_id, assignment_fence,
    predecessor_command_id, execution_capability_id, execution_capability_digest,
    command_type, dedupe_key, state, next_attempt_at, expires_at,
    payload_contract_version, execution_capability_wire
  ) VALUES (
    input_prepare_command_id, authority.creator_id, authority.assigned_worker_id,
    input_invocation_id, input_consumer_id, input_conversation_id,
    authority.deployment_id, authority.lease_id, authority.fence,
    NULL, capability_id, input_execution_capability_digest,
    'invocation.prepare', 'invocation:' || input_invocation_id::text || ':prepare',
    'PENDING', accepted_at,
    accepted_at + authority.max_turn_seconds::integer * interval '1 second',
    2, input_execution_capability_wire
  );

  RETURN QUERY SELECT
    'ADMITTED'::text, input_user_message_id, input_invocation_id,
    'DISPATCH_PENDING'::text, input_prepare_command_id,
    accepted_at + authority.max_turn_seconds::integer * interval '1 second';
END;
$consumer_finalize_v2$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.creator_agent_finalize_consumer_message_v2(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text,
  text, text, bytea, bytea, bytea, text, text, integer, jsonb, text
) FROM PUBLIC, combo_agent_api, combo_agent_broker, combo_agent_reconciler,
  combo_agent_maintenance;
GRANT EXECUTE ON FUNCTION public.creator_agent_finalize_consumer_message_v2(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text,
  text, text, bytea, bytea, bytea, text, text, integer, jsonb, text
) TO combo_agent_consumer_api;

-- 0030 replaces the legacy one-shot accept wrapper with preflight, external authority and
-- finalize. Keeping both executable would let Runtime bypass the exact v2 capability boundary.
REVOKE EXECUTE ON FUNCTION public.creator_agent_accept_consumer_message_v1(
  uuid, uuid, uuid, uuid, text, uuid, text, text,
  text, text, bytea, bytea, bytea, text, text, integer
) FROM combo_agent_consumer_api;

-- Consumer reads remain RLS-bound and column-minimal. Ciphertext never crosses the HTTP boundary;
-- Runtime must authenticate it through its injected MessageKeyAuthority before returning text.
GRANT SELECT (
  id, agent_id, agent_version_id, creator_id, consumer_subject_id, version_digest,
  state, created_at, expires_at
) ON public.agent_conversations TO combo_agent_consumer_api;
GRANT SELECT (
  id, conversation_id, creator_id, consumer_subject_id, turn_no, role,
  content_algorithm, content_key_id, content_nonce, content_ciphertext,
  content_auth_tag, content_cipher_digest, content_digest, content_aad_version,
  invocation_id, created_at
) ON public.agent_messages TO combo_agent_consumer_api;
GRANT SELECT (
  id, conversation_id, creator_id, consumer_subject_id, state, result_digest,
  error_code, retry_of_invocation_id, created_at, terminal_at
) ON public.agent_invocations TO combo_agent_consumer_api;
GRANT SELECT (owner_id, conversation_id, latest_cursor, expired_through_cursor, updated_at)
  ON public.consumer_event_streams TO combo_agent_consumer_api;
GRANT SELECT (
  cursor, owner_id, conversation_id, invocation_id, event_type, payload,
  retained_until
) ON public.consumer_event_outbox TO combo_agent_consumer_api;

-- 0030 reserves only nullable typed cancel transport storage and validates the future wire shape.
-- Its source trigger and lock definer both reject cancel: exact pre-dispatch versus interrupt
-- semantics, terminal projection and cancel-command ACK retirement require the follow-up slice.
COMMENT ON COLUMN public.broker_outbox.cancel_reason IS
  'Typed payload-v2 cancel transport field. 0030 has no public producer; later admission wiring must own cancel semantics.';

-- Broker readiness must not read the migration ledger. This 0030-only definer exposes one boolean
-- predicate over the exact lifecycle objects without returning schema names, DDL, rows or secrets.
CREATE OR REPLACE FUNCTION public.creator_agent_gateway_lifecycle_v2_ready()
RETURNS boolean
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $gateway_lifecycle_v2_ready$
BEGIN
  IF NOT COALESCE(
       public.creator_agent_gateway_lifecycle_v2_broker_is_exact(),
       false
     ) THEN
    RAISE EXCEPTION 'Lifecycle v2 readiness requires the exact isolated Broker authority'
      USING ERRCODE = '42501';
  END IF;

  RETURN COALESCE((
    pg_catalog.to_regprocedure(
      'public.creator_agent_lock_gateway_lifecycle_command_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,bigint)'
    ) IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid = 'public.worker_gateway_outbound_frames'::regclass
         AND attribute.attname = 'wire_canonical_text'
         AND NOT attribute.attisdropped
         AND pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) = 'text'
    )
    AND EXISTS (
      SELECT 1
        FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid = 'public.broker_outbox'::regclass
         AND attribute.attname = 'execution_capability_wire'
         AND NOT attribute.attisdropped
         AND pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) = 'jsonb'
    )
    AND EXISTS (
      SELECT 1
        FROM pg_catalog.pg_class AS index_relation
        JOIN pg_catalog.pg_index AS index_definition
          ON index_definition.indexrelid = index_relation.oid
       WHERE index_relation.oid =
             pg_catalog.to_regclass('public.uq_worker_gateway_outbound_lifecycle_per_session')
         AND index_definition.indisvalid
         AND index_definition.indisunique
    )
  ), false);
END;
$gateway_lifecycle_v2_ready$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.creator_agent_gateway_lifecycle_v2_ready()
  FROM PUBLIC, combo_agent_api, combo_agent_consumer_api, combo_agent_reconciler,
    combo_agent_maintenance;
GRANT EXECUTE ON FUNCTION public.creator_agent_gateway_lifecycle_v2_ready()
  TO combo_agent_broker;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON
  public.agent_messages,
  public.agent_invocations,
  public.agent_invocation_events,
  public.broker_outbox,
  public.agent_conversations,
  public.consumer_event_streams,
  public.consumer_event_outbox,
  public.worker_gateway_outbound_frames
FROM combo_agent_consumer_api;

DO $runtime_product_owner_gate$
DECLARE
  function_signature text;
  trusted_owner boolean;
  expected_owner oid;
  actual_owner oid;
BEGIN
  FOREACH function_signature IN ARRAY ARRAY[
    'public.creator_agent_admit_user_message_core_v1(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,timestamptz,text,text,text,bytea,bytea,bytea,text,text,integer,uuid)',
    'public.creator_agent_issue_runtime_product_ids_v2(integer)',
    'public.creator_agent_preflight_consumer_message_v2(uuid,uuid,text,text)',
    'public.creator_agent_finalize_consumer_message_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,bytea,bytea,bytea,text,text,integer,jsonb,text)',
    'public.creator_agent_gateway_lifecycle_v2_broker_is_exact()',
    'public.creator_agent_lock_gateway_lifecycle_command_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,bigint)',
    'public.creator_agent_gateway_lifecycle_v2_ready()',
    'public.enforce_creator_agent_message_accept_chain()',
    'public.creator_agent_execution_capability_wire_v1_is_safe(jsonb)',
    'public.creator_agent_execution_capability_wire_v1_canonical_text(jsonb)',
    'public.creator_agent_execution_capability_wire_v1_digest(jsonb)',
    'public.creator_agent_gateway_lifecycle_frame_v2_is_safe(jsonb)'
  ]
  LOOP
    SELECT procedure.prosecdef AND (role.rolsuper OR role.rolbypassrls),
           procedure.proowner
      INTO trusted_owner, actual_owner
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_roles AS role ON role.oid = procedure.proowner
     WHERE procedure.oid = function_signature::regprocedure;
    IF trusted_owner IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Runtime product function % requires a trusted SECURITY DEFINER owner',
        function_signature
        USING ERRCODE = '42501';
    END IF;
    IF expected_owner IS NULL THEN
      expected_owner := actual_owner;
    ELSIF actual_owner IS DISTINCT FROM expected_owner THEN
      RAISE EXCEPTION 'Runtime product wrappers, validators and private core require one owner'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;
END;
$runtime_product_owner_gate$;

DO $runtime_product_consumer_acl_gate$
DECLARE
  table_name text;
  consumer_role_oid oid;
BEGIN
  SELECT role.oid
    INTO consumer_role_oid
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = 'combo_agent_consumer_api';
  IF consumer_role_oid IS NULL THEN
    RAISE EXCEPTION 'Runtime product wiring requires combo_agent_consumer_api'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
     WHERE membership.member = consumer_role_oid
        OR membership.roleid = consumer_role_oid
  ) THEN
    RAISE EXCEPTION 'Runtime product Consumer role must have zero role membership'
      USING ERRCODE = '42501';
  END IF;
  FOREACH table_name IN ARRAY ARRAY[
    'public.agent_messages',
    'public.agent_invocations',
    'public.agent_invocation_events',
    'public.broker_outbox',
    'public.agent_conversations',
    'public.consumer_event_streams',
    'public.consumer_event_outbox',
    'public.worker_gateway_outbound_frames'
  ]
  LOOP
    IF pg_catalog.has_table_privilege(
         'combo_agent_consumer_api', table_name,
         'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR pg_catalog.has_any_column_privilege(
         'combo_agent_consumer_api', table_name, 'INSERT,UPDATE,REFERENCES'
       ) THEN
      RAISE EXCEPTION 'Runtime product Consumer role has forbidden direct DML on %', table_name
        USING ERRCODE = '42501';
    END IF;
  END LOOP;
  IF NOT pg_catalog.has_function_privilege(
       'combo_agent_consumer_api',
       'public.creator_agent_issue_runtime_product_ids_v2(integer)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'combo_agent_consumer_api',
       'public.creator_agent_preflight_consumer_message_v2(uuid,uuid,text,text)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'combo_agent_consumer_api',
       'public.creator_agent_finalize_consumer_message_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,bytea,bytea,bytea,text,text,integer,jsonb,text)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'combo_agent_consumer_api',
       'public.creator_agent_lock_gateway_lifecycle_command_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,bigint)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'combo_agent_consumer_api',
       'public.creator_agent_admit_user_message_core_v1(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,timestamptz,text,text,text,bytea,bytea,bytea,text,text,integer,uuid)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'combo_agent_consumer_api',
       'public.creator_agent_accept_consumer_message_v1(uuid,uuid,uuid,uuid,text,uuid,text,text,text,text,bytea,bytea,bytea,text,text,integer)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Runtime product Consumer function ACL is not exact'
      USING ERRCODE = '42501';
  END IF;
END;
$runtime_product_consumer_acl_gate$;
