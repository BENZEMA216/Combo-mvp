-- 0028 · Two-stage database-owned invocation.succeeded authority.
--
-- Preflight holds the global Worker source and Invocation locks, allocates the durable Message ID,
-- and returns its exact KMS AAD. The caller seals outside PostgreSQL but inside the same outer
-- transaction; finalize rechecks Cloud time and atomically commits the complete terminal chain.

LOCK TABLE public.agent_invocations,
           public.agent_invocation_events,
           public.agent_conversations,
           public.agent_messages,
           public.consumer_event_outbox,
           public.consumer_event_streams,
           public.creator_agent_journal_integrity_alerts
  IN SHARE ROW EXCLUSIVE MODE;

DO $success_fact_zero_legacy$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.agent_invocation_events AS event
     WHERE event.source = 'WORKER' AND event.event_type = 'invocation.succeeded'
  ) OR EXISTS (
    SELECT 1 FROM public.agent_invocations AS invocation
     WHERE invocation.state = 'SUCCEEDED'
  ) OR EXISTS (
    SELECT 1 FROM public.agent_messages AS message
     WHERE message.role = 'ASSISTANT' AND message.invocation_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0028 requires zero legacy succeeded terminals'
      USING ERRCODE = '55000';
  END IF;
END;
$success_fact_zero_legacy$;

ALTER TABLE public.agent_invocation_events
  ADD COLUMN source_local_result_cipher_digest text
    CHECK (
      source_local_result_cipher_digest IS NULL
      OR source_local_result_cipher_digest ~ '^[a-f0-9]{64}$'
    ),
  ADD CONSTRAINT ck_agent_invocation_events_success_local_cipher_digest CHECK (
    CASE
      WHEN source = 'WORKER' AND event_type = 'invocation.succeeded' THEN
        source_local_result_cipher_digest IS NOT NULL
      ELSE
        source_local_result_cipher_digest IS NULL
    END
  );

CREATE TABLE public.creator_agent_success_seal_preflights (
  seal_token                       uuid        PRIMARY KEY DEFAULT public.gen_uuid_v7(),
  transaction_id                  bigint      NOT NULL,
  invocation_id                   uuid        NOT NULL UNIQUE,
  creator_id                      uuid        NOT NULL,
  consumer_subject_id             uuid        NOT NULL,
  conversation_id                 uuid        NOT NULL,
  installation_id                 uuid        NOT NULL,
  agent_version_digest            text        NOT NULL CHECK (agent_version_digest ~ '^[a-f0-9]{64}$'),
  snapshot_digest                 text        NOT NULL CHECK (snapshot_digest ~ '^[a-f0-9]{64}$'),
  execution_capability_id         uuid        NOT NULL,
  execution_capability_digest     text        NOT NULL
                                              CHECK (execution_capability_digest ~ '^[a-f0-9]{64}$'),
  lease_id                        uuid        NOT NULL,
  fence                           bigint      NOT NULL CHECK (fence >= 1),
  assistant_message_id            uuid        NOT NULL UNIQUE,
  user_turn_no                    integer     NOT NULL CHECK (user_turn_no BETWEEN 1 AND 20),
  fact_digest                     text        NOT NULL CHECK (fact_digest ~ '^[a-f0-9]{64}$'),
  result_digest                   text        NOT NULL
                                              CHECK (result_digest ~ '^hmac-sha256:[a-f0-9]{64}$'),
  local_result_cipher_digest      text        NOT NULL
                                              CHECK (local_result_cipher_digest ~ '^[a-f0-9]{64}$'),
  started_fact_digest             text        NOT NULL CHECK (started_fact_digest ~ '^[a-f0-9]{64}$'),
  runtime_thread_id               text        NOT NULL CHECK (length(runtime_thread_id) BETWEEN 1 AND 256),
  runtime_turn_id                 text        NOT NULL CHECK (length(runtime_turn_id) BETWEEN 1 AND 256),
  created_at                      timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_success_preflight_invocation_tenant
    FOREIGN KEY (invocation_id, conversation_id, creator_id, consumer_subject_id)
    REFERENCES public.agent_invocations (id, conversation_id, creator_id, consumer_subject_id)
);

CREATE TABLE public.creator_agent_succeeded_terminal_receipts (
  invocation_id          uuid        PRIMARY KEY,
  creator_id             uuid        NOT NULL,
  consumer_subject_id    uuid        NOT NULL,
  conversation_id        uuid        NOT NULL,
  terminal_event_id      bigint      NOT NULL UNIQUE,
  assistant_message_id   uuid        NOT NULL UNIQUE,
  consumer_event_cursor  bigint      NOT NULL UNIQUE CHECK (consumer_event_cursor >= 1),
  payload_digest         text        NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  dedupe_key             text        NOT NULL CHECK (dedupe_key ~ '^[a-f0-9]{64}$'),
  recorded_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_success_receipt_invocation_tenant
    FOREIGN KEY (invocation_id, conversation_id, creator_id, consumer_subject_id)
    REFERENCES public.agent_invocations (id, conversation_id, creator_id, consumer_subject_id),
  CONSTRAINT fk_success_receipt_event
    FOREIGN KEY (terminal_event_id, invocation_id)
    REFERENCES public.agent_invocation_events (id, invocation_id),
  CONSTRAINT fk_success_receipt_message
    FOREIGN KEY (assistant_message_id, conversation_id, creator_id, consumer_subject_id)
    REFERENCES public.agent_messages (id, conversation_id, creator_id, consumer_subject_id)
);

CREATE TRIGGER creator_agent_succeeded_terminal_receipts_immutable
BEFORE UPDATE OR DELETE ON public.creator_agent_succeeded_terminal_receipts
FOR EACH ROW EXECUTE FUNCTION public.reject_creator_agent_immutable_mutation();
CREATE TRIGGER creator_agent_succeeded_terminal_receipts_no_truncate
BEFORE TRUNCATE ON public.creator_agent_succeeded_terminal_receipts
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_creator_agent_immutable_mutation();

ALTER TABLE public.creator_agent_success_seal_preflights ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creator_agent_success_seal_preflights FORCE ROW LEVEL SECURITY;
ALTER TABLE public.creator_agent_succeeded_terminal_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creator_agent_succeeded_terminal_receipts FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON public.creator_agent_success_seal_preflights FROM PUBLIC;
REVOKE ALL PRIVILEGES ON public.creator_agent_succeeded_terminal_receipts FROM PUBLIC;
REVOKE ALL PRIVILEGES ON public.creator_agent_success_seal_preflights,
  public.creator_agent_succeeded_terminal_receipts FROM
  combo_agent_api, combo_agent_broker, combo_agent_reconciler,
  combo_agent_maintenance, combo_agent_consumer_api;

CREATE OR REPLACE FUNCTION public.creator_agent_worker_success_fact_digest_v1(
  input_source_event_id uuid,
  input_invocation_id uuid,
  input_agent_version_digest text,
  input_snapshot_digest text,
  input_execution_capability_digest text,
  input_lease_id uuid,
  input_fence bigint,
  input_local_result_cipher_digest text,
  input_result_digest text,
  input_runtime_thread_id text,
  input_runtime_turn_id text,
  input_started_fact_digest text
)
RETURNS text LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, public
AS $success_fact_digest$
  SELECT pg_catalog.encode(public.digest(pg_catalog.convert_to(
    '{"agentVersionDigest":' || pg_catalog.to_jsonb(input_agent_version_digest)::text ||
    ',"executionCapabilityDigest":' || pg_catalog.to_jsonb(input_execution_capability_digest)::text ||
    ',"fence":' || pg_catalog.to_jsonb(input_fence::text)::text ||
    ',"invocationId":' || pg_catalog.to_jsonb(input_invocation_id::text)::text ||
    ',"leaseId":' || pg_catalog.to_jsonb(input_lease_id::text)::text ||
    ',"localResultCipherDigest":' || pg_catalog.to_jsonb(input_local_result_cipher_digest)::text ||
    ',"protocol":"combo.worker-invocation-fact/1"' ||
    ',"resultDigest":' || pg_catalog.to_jsonb(input_result_digest)::text ||
    ',"runtimeThreadId":' || pg_catalog.to_jsonb(input_runtime_thread_id)::text ||
    ',"runtimeTurnId":' || pg_catalog.to_jsonb(input_runtime_turn_id)::text ||
    ',"schemaVersion":1' ||
    ',"snapshotDigest":' || pg_catalog.to_jsonb(input_snapshot_digest)::text ||
    ',"sourceEventId":' || pg_catalog.to_jsonb(input_source_event_id::text)::text ||
    ',"startedFactDigest":' || pg_catalog.to_jsonb(input_started_fact_digest)::text ||
    ',"type":"invocation.succeeded"}', 'UTF8'), 'sha256'), 'hex');
$success_fact_digest$;

CREATE OR REPLACE FUNCTION public.creator_agent_success_consumer_payload_digest_v1(
  input_assistant_message_id uuid,
  input_conversation_id uuid,
  input_invocation_id uuid,
  input_result_digest text,
  input_occurred_at text
)
RETURNS text LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, public
AS $success_payload_digest$
  SELECT pg_catalog.encode(public.digest(pg_catalog.convert_to(
    '{"assistantMessageId":' || pg_catalog.to_jsonb(input_assistant_message_id::text)::text ||
    ',"conversationId":' || pg_catalog.to_jsonb(input_conversation_id::text)::text ||
    ',"errorCode":null' ||
    ',"invocationId":' || pg_catalog.to_jsonb(input_invocation_id::text)::text ||
    ',"occurredAt":' || pg_catalog.to_jsonb(input_occurred_at)::text ||
    ',"protocol":"combo.consumer-event-outbox/1"' ||
    ',"resultDigest":' || pg_catalog.to_jsonb(input_result_digest)::text ||
    ',"schemaVersion":1' ||
    ',"terminalState":"SUCCEEDED"' ||
    ',"type":"invocation.terminal"}', 'UTF8'), 'sha256'), 'hex');
$success_payload_digest$;

CREATE OR REPLACE FUNCTION public.creator_agent_success_consumer_dedupe_key_v1(
  input_owner_id uuid,
  input_source_event_id bigint
)
RETURNS text LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, public
AS $success_dedupe_key$
  SELECT pg_catalog.encode(public.digest(pg_catalog.convert_to(
    '{"eventType":"invocation.terminal"' ||
    ',"ownerId":' || pg_catalog.to_jsonb(input_owner_id::text)::text ||
    ',"protocol":"combo.consumer-event-outbox/1"' ||
    ',"sourceEventId":' || pg_catalog.to_jsonb(input_source_event_id::text)::text || '}',
    'UTF8'), 'sha256'), 'hex');
$success_dedupe_key$;

REVOKE ALL ON FUNCTION public.creator_agent_worker_success_fact_digest_v1(
  uuid, uuid, text, text, text, uuid, bigint, text, text, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.creator_agent_success_consumer_payload_digest_v1(
  uuid, uuid, uuid, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.creator_agent_success_consumer_dedupe_key_v1(uuid, bigint)
  FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.creator_agent_preflight_success_fact_v1(
  input_creator_id uuid,
  input_installation_id uuid,
  input_protocol text,
  input_schema_version integer,
  input_type text,
  input_source_event_id uuid,
  input_invocation_id uuid,
  input_agent_version_digest text,
  input_snapshot_digest text,
  input_execution_capability_digest text,
  input_lease_id uuid,
  input_fence bigint,
  input_runtime_thread_id text,
  input_runtime_turn_id text,
  input_started_fact_digest text,
  input_result_digest text,
  input_local_result_cipher_digest text,
  input_fact_digest text
)
RETURNS TABLE (
  outcome text, seal_token uuid, assistant_message_id uuid,
  aad_schema_version integer, aad_owner_id uuid, aad_conversation_id uuid,
  aad_role text, result_digest text, consumer_event_cursor bigint,
  alert_id uuid, alert_replayed boolean
)
SECURITY DEFINER SET search_path = pg_catalog, public
AS $success_preflight$
DECLARE
  session_is_untrusted boolean;
  incoming record;
  existing record;
  pending record;
  received_fact jsonb;
  existing_fact jsonb;
  existing_identity jsonb;
  received_identity jsonb;
  source_identity_digest text;
  existing_identity_digest text;
  received_identity_digest text;
  expected_fact_digest text;
  expected_payload_digest text;
  expected_dedupe_key text;
  terminal_payload jsonb;
  occurred_at_text text;
  retained_cursor bigint;
  token_value uuid;
  message_id_value uuid;
  durable_alert_id uuid;
  durable_alert_replayed boolean;
BEGIN
  SELECT role.rolsuper OR role.rolbypassrls INTO session_is_untrusted
    FROM pg_catalog.pg_roles AS role WHERE role.rolname = session_user;
  IF session_user <> 'combo_agent_broker' OR COALESCE(session_is_untrusted, true) THEN
    RAISE EXCEPTION 'Success preflight requires exact Broker session authority'
      USING ERRCODE = '42501';
  END IF;
  IF input_creator_id IS DISTINCT FROM
       NULLIF(current_setting('app.creator_id', true), '')::uuid
     OR NULLIF(current_setting('app.consumer_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'Success preflight requires exact Creator and cleared Consumer context'
      USING ERRCODE = '42501';
  END IF;

  IF input_creator_id IS NULL OR input_installation_id IS NULL
     OR input_source_event_id IS NULL OR input_invocation_id IS NULL
     OR input_lease_id IS NULL OR input_protocol IS DISTINCT FROM 'combo.worker-invocation-fact/1'
     OR input_schema_version IS DISTINCT FROM 1 OR input_type IS DISTINCT FROM 'invocation.succeeded'
     OR input_source_event_id IS DISTINCT FROM input_invocation_id
     OR input_source_event_id::text !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR input_lease_id::text !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR input_fence IS NULL OR input_fence < 1
     OR input_agent_version_digest IS NULL
     OR input_agent_version_digest !~ '^[a-f0-9]{64}$'
     OR input_snapshot_digest IS NULL
     OR input_snapshot_digest !~ '^[a-f0-9]{64}$'
     OR input_execution_capability_digest IS NULL
     OR input_execution_capability_digest !~ '^[a-f0-9]{64}$'
     OR input_started_fact_digest IS NULL
     OR input_started_fact_digest !~ '^[a-f0-9]{64}$'
     OR input_local_result_cipher_digest IS NULL
     OR input_local_result_cipher_digest !~ '^[a-f0-9]{64}$'
     OR input_fact_digest IS NULL
     OR input_fact_digest !~ '^[a-f0-9]{64}$'
     OR input_result_digest IS NULL
     OR input_result_digest !~ '^hmac-sha256:[a-f0-9]{64}$'
     OR input_runtime_thread_id IS NULL
     OR length(input_runtime_thread_id) NOT BETWEEN 1 AND 256
     OR input_runtime_thread_id !~ '^[A-Za-z0-9._:-]+$'
     OR input_runtime_turn_id IS NULL
     OR length(input_runtime_turn_id) NOT BETWEEN 1 AND 256
     OR input_runtime_turn_id !~ '^[A-Za-z0-9._:-]+$' THEN
    RETURN QUERY SELECT 'AUTHORITY_REJECTED'::text, NULL::uuid, NULL::uuid,
      NULL::integer, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
      NULL::bigint, NULL::uuid, NULL::boolean;
    RETURN;
  END IF;
  expected_fact_digest := public.creator_agent_worker_success_fact_digest_v1(
    input_source_event_id, input_invocation_id, input_agent_version_digest,
    input_snapshot_digest, input_execution_capability_digest, input_lease_id,
    input_fence, input_local_result_cipher_digest, input_result_digest,
    input_runtime_thread_id, input_runtime_turn_id, input_started_fact_digest
  );
  IF expected_fact_digest IS DISTINCT FROM input_fact_digest THEN
    RETURN QUERY SELECT 'AUTHORITY_REJECTED'::text, NULL::uuid, NULL::uuid,
      NULL::integer, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
      NULL::bigint, NULL::uuid, NULL::boolean;
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'combo.creator-agent-worker-source/1:' || input_source_event_id::text, 0
  ));
  SELECT invocation.id, invocation.conversation_id, invocation.creator_id,
         invocation.consumer_subject_id, invocation.agent_version_id,
         invocation.state, invocation.result_message_id, invocation.result_digest,
         invocation.error_code, invocation.terminal_at, invocation.assigned_worker_id,
         invocation.assignment_lease_id, invocation.assignment_fence,
         invocation.execution_capability_id, invocation.execution_capability_digest,
         invocation.execution_capability_expires_at,
         invocation.execution_capability_revoked_at,
         invocation.runtime_thread_id, invocation.runtime_turn_id,
         conversation.deployment_id, conversation.state AS conversation_state,
         version.version_digest AS agent_version_digest,
         snapshot.id AS snapshot_id, snapshot.snapshot_digest,
         user_message.turn_no AS user_turn_no,
         lease.state AS lease_state, lease.expires_at AS lease_expires_at,
         started.source_fact_digest AS durable_started_fact_digest,
         started.payload AS durable_started_payload,
         started.source_event_id AS durable_started_source_event_id,
         started.source_dispatch_receipt_digest,
         started.source_sandbox_attestation_digest,
         started.broker_command_id AS start_command_id,
         start_command.command_type AS start_command_type,
         start_command.state AS start_command_state,
         start_command.attempt_count AS start_command_attempt_count,
         start_command.target_worker_id AS start_command_worker_id,
         start_command.conversation_id AS start_command_conversation_id,
         start_command.deployment_id AS start_command_deployment_id,
         start_command.assignment_lease_id AS start_command_lease_id,
         start_command.assignment_fence AS start_command_fence,
         start_command.execution_capability_id AS start_command_capability_id,
         start_command.execution_capability_digest AS start_command_capability_digest
    INTO incoming
    FROM public.agent_invocations AS invocation
    JOIN public.agent_conversations AS conversation
      ON conversation.id = invocation.conversation_id
     AND conversation.creator_id = invocation.creator_id
     AND conversation.consumer_subject_id = invocation.consumer_subject_id
    JOIN public.agent_versions AS version
      ON version.id = invocation.agent_version_id AND version.creator_id = invocation.creator_id
    JOIN public.context_snapshots AS snapshot
      ON snapshot.id = version.snapshot_id AND snapshot.creator_id = version.creator_id
    JOIN public.agent_messages AS user_message
      ON user_message.id = invocation.user_message_id
     AND user_message.conversation_id = invocation.conversation_id
     AND user_message.creator_id = invocation.creator_id
     AND user_message.consumer_subject_id = invocation.consumer_subject_id
     AND user_message.invocation_id = invocation.id AND user_message.role = 'USER'
    JOIN public.worker_leases AS lease
      ON lease.id = invocation.assignment_lease_id
     AND lease.deployment_id = conversation.deployment_id
     AND lease.creator_id = invocation.creator_id
     AND lease.worker_id = invocation.assigned_worker_id
     AND lease.fence = invocation.assignment_fence
    LEFT JOIN public.agent_invocation_events AS started
      ON started.invocation_id = invocation.id
     AND started.creator_id = invocation.creator_id
     AND started.consumer_subject_id = invocation.consumer_subject_id
     AND started.source = 'WORKER' AND started.event_type = 'invocation.started'
    LEFT JOIN public.broker_outbox AS start_command
      ON start_command.command_id = started.broker_command_id
     AND start_command.creator_id = invocation.creator_id
     AND start_command.consumer_subject_id = invocation.consumer_subject_id
     AND start_command.invocation_id = invocation.id
   WHERE invocation.id = input_invocation_id
     AND invocation.creator_id = input_creator_id
     AND invocation.assigned_worker_id = input_installation_id
   FOR UPDATE OF invocation, conversation;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'UNAVAILABLE'::text, NULL::uuid, NULL::uuid,
      NULL::integer, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
      NULL::bigint, NULL::uuid, NULL::boolean;
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config('app.consumer_id', incoming.consumer_subject_id::text, true);

  received_fact := pg_catalog.jsonb_build_object(
    'protocol', input_protocol, 'schemaVersion', input_schema_version,
    'type', input_type, 'sourceEventId', input_source_event_id::text,
    'invocationId', input_invocation_id::text,
    'agentVersionDigest', input_agent_version_digest,
    'snapshotDigest', input_snapshot_digest,
    'executionCapabilityDigest', input_execution_capability_digest,
    'leaseId', input_lease_id::text, 'fence', input_fence::text,
    'runtimeThreadId', input_runtime_thread_id,
    'runtimeTurnId', input_runtime_turn_id,
    'startedFactDigest', input_started_fact_digest,
    'resultDigest', input_result_digest,
    'localResultCipherDigest', input_local_result_cipher_digest
  );
  source_identity_digest := pg_catalog.encode(public.digest(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'domain', 'combo:vnext:worker-source-identity:v1',
      'protocol', 'combo.worker-invocation-fact/1', 'version', 1,
      'source', 'WORKER', 'sourceEventId', input_source_event_id::text
    )::text, 'UTF8'), 'sha256'), 'hex');

  SELECT event.id, event.invocation_id, event.creator_id AS event_creator_id,
         event.consumer_subject_id AS event_consumer_subject_id,
         event.event_type, event.source_event_id, event.payload,
         event.occurred_at, event.source_fact_digest, event.broker_command_id,
         event.source_local_result_cipher_digest,
         durable_invocation.state AS invocation_state,
         durable_invocation.result_message_id, durable_invocation.result_digest,
         durable_invocation.error_code, durable_invocation.terminal_at,
         durable_invocation.conversation_id, durable_invocation.consumer_subject_id,
         durable_invocation.creator_id, durable_invocation.agent_version_id,
         durable_invocation.assigned_worker_id, durable_invocation.assignment_lease_id,
         durable_invocation.assignment_fence, durable_invocation.execution_capability_id,
         durable_invocation.execution_capability_digest,
         durable_invocation.runtime_thread_id, durable_invocation.runtime_turn_id,
         durable_conversation.state AS conversation_state,
         durable_conversation.deployment_id,
         durable_version.version_digest AS agent_version_digest,
         durable_snapshot.id AS snapshot_id, durable_snapshot.snapshot_digest,
         started.source_fact_digest AS started_fact_digest,
         started.payload AS started_payload,
         started.source_event_id AS started_source_event_id,
         started.broker_command_id AS started_command_id,
         started.source_dispatch_receipt_digest AS started_dispatch_receipt_digest,
         started.source_sandbox_attestation_digest AS started_sandbox_attestation_digest,
         existing_start_command.command_type AS existing_start_command_type,
         existing_start_command.state AS existing_start_command_state,
         existing_start_command.attempt_count AS existing_start_command_attempt_count,
         message.id AS message_id, message.conversation_id AS message_conversation_id,
         message.creator_id AS message_creator_id,
         message.consumer_subject_id AS message_consumer_subject_id,
         message.invocation_id AS message_invocation_id,
         message.turn_no, message.role, message.client_message_id,
         message.content_algorithm, message.content_key_id, message.content_nonce,
         message.content_ciphertext, message.content_auth_tag,
         message.content_cipher_digest, message.content_digest, message.content_aad_version,
         receipt.consumer_event_cursor AS receipt_cursor,
         receipt.assistant_message_id AS receipt_message_id,
         receipt.creator_id AS receipt_creator_id,
         receipt.consumer_subject_id AS receipt_consumer_subject_id,
         receipt.conversation_id AS receipt_conversation_id,
         receipt.payload_digest AS receipt_payload_digest,
         receipt.dedupe_key AS receipt_dedupe_key,
         outbox.cursor AS retained_cursor, outbox.payload AS retained_payload,
         outbox.owner_id AS retained_owner_id,
         outbox.conversation_id AS retained_conversation_id,
         outbox.invocation_id AS retained_invocation_id,
         outbox.source_event_id AS retained_source_event_id,
         outbox.event_type AS retained_event_type,
         outbox.payload_digest AS retained_payload_digest,
         outbox.dedupe_key AS retained_dedupe_key,
         stream.latest_cursor, stream.expired_through_cursor,
         durable_lease.id AS durable_lease_id,
         durable_lease.worker_id AS durable_lease_worker_id,
         durable_lease.fence AS durable_lease_fence,
         failed_receipt.terminal_event_id AS failed_receipt_event_id,
         failed_receipt.consumer_event_cursor AS failed_receipt_cursor,
         failed_receipt.payload_digest AS failed_receipt_payload_digest,
         failed_receipt.dedupe_key AS failed_receipt_dedupe_key,
         failed_outbox.cursor AS failed_retained_cursor,
         failed_outbox.payload AS failed_retained_payload,
         failed_outbox.payload_digest AS failed_retained_payload_digest,
         failed_outbox.dedupe_key AS failed_retained_dedupe_key
    INTO existing
    FROM public.agent_invocation_events AS event
    LEFT JOIN public.agent_invocations AS durable_invocation
      ON durable_invocation.id = event.invocation_id
     AND durable_invocation.creator_id = event.creator_id
     AND durable_invocation.consumer_subject_id = event.consumer_subject_id
    LEFT JOIN public.agent_conversations AS durable_conversation
      ON durable_conversation.id = durable_invocation.conversation_id
     AND durable_conversation.creator_id = durable_invocation.creator_id
     AND durable_conversation.consumer_subject_id = durable_invocation.consumer_subject_id
    LEFT JOIN public.agent_versions AS durable_version
      ON durable_version.id = durable_invocation.agent_version_id
     AND durable_version.creator_id = durable_invocation.creator_id
    LEFT JOIN public.context_snapshots AS durable_snapshot
      ON durable_snapshot.id = durable_version.snapshot_id
     AND durable_snapshot.creator_id = durable_version.creator_id
    LEFT JOIN public.worker_leases AS durable_lease
      ON durable_lease.id = durable_invocation.assignment_lease_id
     AND durable_lease.deployment_id = durable_conversation.deployment_id
     AND durable_lease.creator_id = durable_invocation.creator_id
     AND durable_lease.worker_id = durable_invocation.assigned_worker_id
     AND durable_lease.fence = durable_invocation.assignment_fence
    LEFT JOIN public.agent_invocation_events AS started
      ON started.invocation_id = event.invocation_id
     AND started.source = 'WORKER' AND started.event_type = 'invocation.started'
    LEFT JOIN public.broker_outbox AS existing_start_command
      ON existing_start_command.command_id = started.broker_command_id
     AND existing_start_command.creator_id = event.creator_id
     AND existing_start_command.consumer_subject_id = event.consumer_subject_id
     AND existing_start_command.invocation_id = event.invocation_id
    LEFT JOIN public.agent_messages AS message
      ON message.id = durable_invocation.result_message_id
     AND message.invocation_id = durable_invocation.id AND message.role = 'ASSISTANT'
    LEFT JOIN public.creator_agent_succeeded_terminal_receipts AS receipt
      ON receipt.invocation_id = event.invocation_id AND receipt.terminal_event_id = event.id
    LEFT JOIN public.consumer_event_outbox AS outbox
      ON outbox.cursor = receipt.consumer_event_cursor
     AND outbox.owner_id = receipt.consumer_subject_id
     AND outbox.source_event_id = receipt.terminal_event_id
    LEFT JOIN public.consumer_event_streams AS stream
      ON stream.owner_id = event.consumer_subject_id
     AND stream.conversation_id = durable_invocation.conversation_id
    LEFT JOIN public.creator_agent_failed_terminal_receipts AS failed_receipt
      ON failed_receipt.invocation_id = event.invocation_id
     AND failed_receipt.creator_id = event.creator_id
     AND failed_receipt.consumer_subject_id = event.consumer_subject_id
     AND failed_receipt.terminal_event_id = event.id
    LEFT JOIN public.consumer_event_outbox AS failed_outbox
      ON failed_outbox.cursor = failed_receipt.consumer_event_cursor
     AND failed_outbox.owner_id = failed_receipt.consumer_subject_id
     AND failed_outbox.source_event_id = failed_receipt.terminal_event_id
     AND failed_outbox.invocation_id = event.invocation_id
     AND failed_outbox.conversation_id = durable_invocation.conversation_id
     AND failed_outbox.event_type = 'invocation.terminal'
   WHERE event.source = 'WORKER'
     AND (
       event.source_event_id = input_source_event_id::text
       OR event.invocation_id = input_invocation_id
          AND event.event_type IN ('invocation.succeeded', 'invocation.failed')
     )
   ORDER BY (event.invocation_id = input_invocation_id) DESC, event.id
   LIMIT 1;

  IF FOUND THEN
    IF existing.event_type = 'invocation.succeeded' THEN
      IF existing.source_event_id IS DISTINCT FROM input_source_event_id::text
         OR existing.source_event_id IS DISTINCT FROM existing.invocation_id::text
         OR existing.event_creator_id IS DISTINCT FROM existing.creator_id
         OR existing.event_consumer_subject_id IS DISTINCT FROM existing.consumer_subject_id
         OR existing.source_local_result_cipher_digest IS NULL
         OR existing.source_fact_digest IS NULL OR existing.broker_command_id IS NOT NULL
         OR existing.payload IS DISTINCT FROM pg_catalog.jsonb_build_object(
              'state', 'SUCCEEDED', 'messageId', existing.result_message_id,
              'resultDigest', existing.result_digest
            )
         OR existing.invocation_state IS DISTINCT FROM 'SUCCEEDED'
         OR existing.result_message_id IS NULL OR existing.result_digest IS NULL
         OR existing.result_digest !~ '^hmac-sha256:[a-f0-9]{64}$'
         OR existing.error_code IS NOT NULL OR existing.terminal_at IS NULL
         OR existing.occurred_at IS DISTINCT FROM existing.terminal_at
         OR existing.conversation_state IS DISTINCT FROM 'IDLE'
         OR existing.started_payload NOT IN (
              '{"state":"RUNNING"}'::jsonb, '{"state":"RECONCILING"}'::jsonb
            )
         OR existing.started_source_event_id IS DISTINCT FROM existing.started_command_id::text
         OR existing.started_dispatch_receipt_digest IS NULL
         OR existing.started_sandbox_attestation_digest IS NULL
         OR existing.existing_start_command_type IS DISTINCT FROM 'invocation.start'
         OR existing.existing_start_command_state NOT IN ('ACKED', 'EXPIRED')
         OR existing.existing_start_command_attempt_count IS NULL
         OR existing.existing_start_command_attempt_count < 1
         OR existing.started_fact_digest IS DISTINCT FROM
              public.creator_agent_worker_started_fact_digest_v1(
                existing.started_command_id, existing.invocation_id,
                existing.agent_version_digest, existing.snapshot_digest,
                existing.execution_capability_digest, existing.assignment_lease_id,
                existing.assignment_fence, existing.started_command_id,
                existing.runtime_thread_id, existing.runtime_turn_id,
                existing.started_dispatch_receipt_digest,
                existing.started_sandbox_attestation_digest
              )
         OR existing.message_id IS DISTINCT FROM existing.result_message_id
         OR existing.message_conversation_id IS DISTINCT FROM existing.conversation_id
         OR existing.message_creator_id IS DISTINCT FROM existing.creator_id
         OR existing.message_consumer_subject_id IS DISTINCT FROM existing.consumer_subject_id
         OR existing.message_invocation_id IS DISTINCT FROM existing.invocation_id
         OR existing.turn_no IS NULL OR existing.turn_no NOT BETWEEN 1 AND 20
         OR existing.role IS DISTINCT FROM 'ASSISTANT'
         OR existing.client_message_id IS NOT NULL
         OR existing.content_algorithm IS DISTINCT FROM 'aes-256-gcm/v1'
         OR existing.content_key_id IS NULL
         OR length(existing.content_key_id) NOT BETWEEN 1 AND 256
         OR existing.content_key_id !~ '^[-A-Za-z0-9_.:/]+$'
         OR existing.content_nonce IS NULL OR octet_length(existing.content_nonce) <> 12
         OR existing.content_ciphertext IS NULL
         OR octet_length(existing.content_ciphertext) NOT BETWEEN 1 AND 65536
         OR existing.content_auth_tag IS NULL OR octet_length(existing.content_auth_tag) <> 16
         OR existing.content_digest !~ '^hmac-sha256:[a-f0-9]{64}$'
         OR existing.content_aad_version IS DISTINCT FROM 1
         OR existing.content_cipher_digest IS DISTINCT FROM pg_catalog.encode(
              public.digest(
                existing.content_nonce || existing.content_ciphertext || existing.content_auth_tag,
                'sha256'
              ), 'hex'
            )
         OR existing.content_cipher_digest = existing.source_local_result_cipher_digest
         OR existing.content_digest = existing.result_digest
         OR existing.receipt_cursor IS NULL OR existing.latest_cursor IS NULL
         OR existing.receipt_message_id IS DISTINCT FROM existing.message_id
         OR existing.receipt_creator_id IS DISTINCT FROM existing.creator_id
         OR existing.receipt_consumer_subject_id IS DISTINCT FROM existing.consumer_subject_id
         OR existing.receipt_conversation_id IS DISTINCT FROM existing.conversation_id
         OR existing.latest_cursor < existing.receipt_cursor THEN
        RETURN QUERY SELECT 'INVARIANT_FAILED'::text, NULL::uuid, NULL::uuid,
          NULL::integer, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
          NULL::bigint, NULL::uuid, NULL::boolean;
        RETURN;
      END IF;
      expected_fact_digest := public.creator_agent_worker_success_fact_digest_v1(
        existing.source_event_id::uuid, existing.invocation_id,
        existing.agent_version_digest, existing.snapshot_digest,
        existing.execution_capability_digest, existing.assignment_lease_id,
        existing.assignment_fence, existing.source_local_result_cipher_digest,
        existing.result_digest, existing.runtime_thread_id, existing.runtime_turn_id,
        existing.started_fact_digest
      );
      occurred_at_text := pg_catalog.to_char(
        existing.terminal_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      );
      expected_payload_digest := public.creator_agent_success_consumer_payload_digest_v1(
        existing.message_id, existing.conversation_id, existing.invocation_id,
        existing.result_digest, occurred_at_text
      );
      expected_dedupe_key := public.creator_agent_success_consumer_dedupe_key_v1(
        existing.consumer_subject_id, existing.id
      );
      terminal_payload := pg_catalog.jsonb_build_object(
        'protocol', 'combo.consumer-event-outbox/1', 'schemaVersion', 1,
        'type', 'invocation.terminal', 'conversationId', existing.conversation_id::text,
        'invocationId', existing.invocation_id::text, 'terminalState', 'SUCCEEDED',
        'assistantMessageId', existing.message_id::text,
        'resultDigest', existing.result_digest, 'errorCode', NULL::text,
        'occurredAt', occurred_at_text
      );
      IF existing.source_fact_digest IS DISTINCT FROM expected_fact_digest
         OR existing.receipt_payload_digest IS DISTINCT FROM expected_payload_digest
         OR existing.receipt_dedupe_key IS DISTINCT FROM expected_dedupe_key THEN
        RETURN QUERY SELECT 'INVARIANT_FAILED'::text, NULL::uuid, NULL::uuid,
          NULL::integer, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
          NULL::bigint, NULL::uuid, NULL::boolean;
        RETURN;
      END IF;
      IF existing.retained_cursor IS NOT NULL THEN
        IF existing.retained_cursor IS DISTINCT FROM existing.receipt_cursor
           OR existing.retained_owner_id IS DISTINCT FROM existing.consumer_subject_id
           OR existing.retained_conversation_id IS DISTINCT FROM existing.conversation_id
           OR existing.retained_invocation_id IS DISTINCT FROM existing.invocation_id
           OR existing.retained_source_event_id IS DISTINCT FROM existing.id
           OR existing.retained_event_type IS DISTINCT FROM 'invocation.terminal'
           OR existing.retained_payload IS DISTINCT FROM terminal_payload
           OR existing.retained_payload_digest IS DISTINCT FROM expected_payload_digest
           OR existing.retained_dedupe_key IS DISTINCT FROM expected_dedupe_key THEN
          RETURN QUERY SELECT 'INVARIANT_FAILED'::text, NULL::uuid, NULL::uuid,
            NULL::integer, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
            NULL::bigint, NULL::uuid, NULL::boolean;
          RETURN;
        END IF;
        retained_cursor := existing.retained_cursor;
      ELSIF existing.expired_through_cursor IS NOT NULL
         AND existing.expired_through_cursor >= existing.receipt_cursor THEN
        retained_cursor := NULL;
      ELSE
        RETURN QUERY SELECT 'INVARIANT_FAILED'::text, NULL::uuid, NULL::uuid,
          NULL::integer, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
          NULL::bigint, NULL::uuid, NULL::boolean;
        RETURN;
      END IF;
      existing_fact := pg_catalog.jsonb_build_object(
        'protocol', 'combo.worker-invocation-fact/1', 'schemaVersion', 1,
        'type', 'invocation.succeeded', 'sourceEventId', existing.source_event_id,
        'invocationId', existing.invocation_id::text,
        'agentVersionDigest', existing.agent_version_digest,
        'snapshotDigest', existing.snapshot_digest,
        'executionCapabilityDigest', existing.execution_capability_digest,
        'leaseId', existing.assignment_lease_id::text,
        'fence', existing.assignment_fence::text,
        'runtimeThreadId', existing.runtime_thread_id,
        'runtimeTurnId', existing.runtime_turn_id,
        'startedFactDigest', existing.started_fact_digest,
        'resultDigest', existing.result_digest,
        'localResultCipherDigest', existing.source_local_result_cipher_digest
      );
      existing_identity := pg_catalog.jsonb_build_object(
        'domain', 'combo:vnext:worker-success-event-identity:v1',
        'protocol', 'combo.worker-invocation-fact/1', 'version', 1,
        'creatorId', existing.creator_id::text,
        'consumerId', existing.consumer_subject_id::text,
        'conversationId', existing.conversation_id::text,
        'invocationId', existing.invocation_id::text,
        'agentVersionId', existing.agent_version_id::text,
        'snapshotId', existing.snapshot_id::text,
        'deploymentId', existing.deployment_id::text,
        'installationId', existing.assigned_worker_id::text,
        'executionCapabilityId', existing.execution_capability_id::text,
        'source', 'WORKER', 'sourceEventId', existing.source_event_id,
        'eventType', 'invocation.succeeded', 'payload', existing.payload,
        'fact', existing_fact, 'factDigest', existing.source_fact_digest
      );
      received_identity := pg_catalog.jsonb_build_object(
        'domain', 'combo:vnext:worker-success-event-identity:v1',
        'protocol', 'combo.worker-invocation-fact/1', 'version', 1,
        'creatorId', input_creator_id::text,
        'consumerId', incoming.consumer_subject_id::text,
        'conversationId', incoming.conversation_id::text,
        'invocationId', input_invocation_id::text,
        'agentVersionId', incoming.agent_version_id::text,
        'snapshotId', incoming.snapshot_id::text,
        'deploymentId', incoming.deployment_id::text,
        'installationId', input_installation_id::text,
        'executionCapabilityId', incoming.execution_capability_id::text,
        'source', 'WORKER', 'sourceEventId', input_source_event_id::text,
        'eventType', 'invocation.succeeded', 'payload', pg_catalog.jsonb_build_object(
          'state', 'SUCCEEDED', 'messageId', existing.message_id,
          'resultDigest', input_result_digest
        ),
        'fact', received_fact, 'factDigest', input_fact_digest
      );
      IF existing_identity = received_identity THEN
        RETURN QUERY SELECT 'EXACT'::text, NULL::uuid, existing.message_id,
          NULL::integer, NULL::uuid, NULL::uuid, NULL::text,
          existing.result_digest, retained_cursor, NULL::uuid, NULL::boolean;
        RETURN;
      END IF;
    ELSIF existing.event_type = 'invocation.failed' THEN
      IF existing.source_event_id IS DISTINCT FROM existing.invocation_id::text
         OR existing.source_fact_digest IS NULL
         OR existing.source_fact_digest !~ '^[a-f0-9]{64}$'
         OR existing.broker_command_id IS NOT NULL
         OR existing.payload IS DISTINCT FROM pg_catalog.jsonb_build_object(
              'state', 'FAILED', 'errorCode', existing.error_code
            )
         OR existing.invocation_state IS DISTINCT FROM 'FAILED'
         OR existing.result_message_id IS NOT NULL OR existing.result_digest IS NOT NULL
         OR existing.error_code NOT IN (
              'SNAPSHOT_DIGEST_MISMATCH', 'PROTOCOL_INCOMPATIBLE',
              'SANDBOX_ATTESTATION_FAILED', 'RUNTIME_START_FAILED',
              'MODEL_QUOTA_EXHAUSTED', 'TURN_TIMEOUT', 'TURN_FAILED'
            )
         OR existing.terminal_at IS NULL
         OR existing.occurred_at IS DISTINCT FROM existing.terminal_at
         OR existing.conversation_state IS DISTINCT FROM 'IDLE'
         OR existing.agent_version_id IS NULL OR existing.agent_version_digest IS NULL
         OR existing.snapshot_id IS NULL OR existing.snapshot_digest IS NULL
         OR existing.assigned_worker_id IS NULL OR existing.assignment_lease_id IS NULL
         OR existing.assignment_fence IS NULL OR existing.execution_capability_id IS NULL
         OR existing.execution_capability_digest IS NULL
         OR existing.durable_lease_id IS NULL
         OR existing.durable_lease_worker_id IS DISTINCT FROM existing.assigned_worker_id
         OR existing.durable_lease_fence IS DISTINCT FROM existing.assignment_fence
         OR existing.failed_receipt_event_id IS DISTINCT FROM existing.id
         OR existing.failed_receipt_cursor IS NULL
         OR existing.latest_cursor IS NULL
         OR existing.latest_cursor < existing.failed_receipt_cursor THEN
        RETURN QUERY SELECT 'INVARIANT_FAILED'::text, NULL::uuid, NULL::uuid,
          NULL::integer, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
          NULL::bigint, NULL::uuid, NULL::boolean;
        RETURN;
      END IF;
      expected_fact_digest := public.creator_agent_worker_failed_fact_digest_v1(
        existing.source_event_id::uuid, existing.invocation_id,
        existing.agent_version_digest, existing.snapshot_digest,
        existing.execution_capability_digest, existing.assignment_lease_id,
        existing.assignment_fence, existing.error_code
      );
      occurred_at_text := pg_catalog.to_char(
        existing.terminal_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      );
      expected_payload_digest := public.creator_agent_failed_consumer_payload_digest_v1(
        existing.conversation_id, existing.invocation_id,
        existing.error_code, occurred_at_text
      );
      expected_dedupe_key := public.creator_agent_failed_consumer_dedupe_key_v1(
        existing.consumer_subject_id, existing.id
      );
      terminal_payload := pg_catalog.jsonb_build_object(
        'protocol', 'combo.consumer-event-outbox/1', 'schemaVersion', 1,
        'type', 'invocation.terminal', 'conversationId', existing.conversation_id::text,
        'invocationId', existing.invocation_id::text, 'terminalState', 'FAILED',
        'assistantMessageId', NULL::text, 'resultDigest', NULL::text,
        'errorCode', existing.error_code, 'occurredAt', occurred_at_text
      );
      IF existing.source_fact_digest IS DISTINCT FROM expected_fact_digest
         OR existing.failed_receipt_payload_digest IS DISTINCT FROM expected_payload_digest
         OR existing.failed_receipt_dedupe_key IS DISTINCT FROM expected_dedupe_key THEN
        RETURN QUERY SELECT 'INVARIANT_FAILED'::text, NULL::uuid, NULL::uuid,
          NULL::integer, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
          NULL::bigint, NULL::uuid, NULL::boolean;
        RETURN;
      END IF;
      IF existing.failed_retained_cursor IS NOT NULL THEN
        IF existing.failed_retained_cursor IS DISTINCT FROM existing.failed_receipt_cursor
           OR existing.failed_retained_payload IS DISTINCT FROM terminal_payload
           OR existing.failed_retained_payload_digest IS DISTINCT FROM expected_payload_digest
           OR existing.failed_retained_dedupe_key IS DISTINCT FROM expected_dedupe_key THEN
          RETURN QUERY SELECT 'INVARIANT_FAILED'::text, NULL::uuid, NULL::uuid,
            NULL::integer, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
            NULL::bigint, NULL::uuid, NULL::boolean;
          RETURN;
        END IF;
      ELSIF existing.expired_through_cursor IS NULL
         OR existing.expired_through_cursor < existing.failed_receipt_cursor THEN
        RETURN QUERY SELECT 'INVARIANT_FAILED'::text, NULL::uuid, NULL::uuid,
          NULL::integer, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
          NULL::bigint, NULL::uuid, NULL::boolean;
        RETURN;
      END IF;
      existing_fact := pg_catalog.jsonb_build_object(
        'protocol', 'combo.worker-invocation-fact/1', 'schemaVersion', 1,
        'type', 'invocation.failed', 'sourceEventId', existing.source_event_id,
        'invocationId', existing.invocation_id::text,
        'agentVersionDigest', existing.agent_version_digest,
        'snapshotDigest', existing.snapshot_digest,
        'executionCapabilityDigest', existing.execution_capability_digest,
        'leaseId', existing.assignment_lease_id::text,
        'fence', existing.assignment_fence::text, 'errorCode', existing.error_code
      );
      existing_identity := pg_catalog.jsonb_build_object(
        'domain', 'combo:vnext:full-stored-failed-terminal-source-binding:v1',
        'protocol', 'combo.worker-invocation-fact/1', 'version', 1,
        'creatorId', existing.creator_id::text,
        'consumerId', existing.consumer_subject_id::text,
        'conversationId', existing.conversation_id::text,
        'invocationId', existing.invocation_id::text,
        'agentVersionId', existing.agent_version_id::text,
        'snapshotId', existing.snapshot_id::text,
        'deploymentId', existing.deployment_id::text,
        'installationId', existing.assigned_worker_id::text,
        'executionCapabilityId', existing.execution_capability_id::text,
        'source', 'WORKER', 'sourceEventId', existing.source_event_id,
        'eventType', existing.event_type, 'payload', existing.payload,
        'fact', existing_fact, 'factDigest', existing.source_fact_digest
      );
      received_identity := pg_catalog.jsonb_build_object(
        'domain', 'combo:vnext:worker-success-event-identity:v1',
        'protocol', 'combo.worker-invocation-fact/1', 'version', 1,
        'creatorId', input_creator_id::text,
        'consumerId', incoming.consumer_subject_id::text,
        'conversationId', incoming.conversation_id::text,
        'invocationId', input_invocation_id::text,
        'agentVersionId', incoming.agent_version_id::text,
        'snapshotId', incoming.snapshot_id::text,
        'deploymentId', incoming.deployment_id::text,
        'installationId', input_installation_id::text,
        'executionCapabilityId', incoming.execution_capability_id::text,
        'source', 'WORKER', 'sourceEventId', input_source_event_id::text,
        'eventType', 'invocation.succeeded', 'fact', received_fact,
        'factDigest', input_fact_digest
      );
    ELSE
      RETURN QUERY SELECT 'INVARIANT_FAILED'::text, NULL::uuid, NULL::uuid,
        NULL::integer, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
        NULL::bigint, NULL::uuid, NULL::boolean;
      RETURN;
    END IF;

    existing_identity_digest := pg_catalog.encode(public.digest(
      pg_catalog.convert_to(existing_identity::text, 'UTF8'), 'sha256'), 'hex');
    received_identity_digest := pg_catalog.encode(public.digest(
      pg_catalog.convert_to(received_identity::text, 'UTF8'), 'sha256'), 'hex');
    INSERT INTO public.creator_agent_journal_integrity_alerts (
      invocation_id, creator_id, consumer_subject_id, reason, source,
      source_event_id_digest, existing_canonical_digest, received_canonical_digest,
      expected_journal_seq, received_journal_seq
    ) VALUES (
      input_invocation_id, input_creator_id, incoming.consumer_subject_id,
      'SOURCE_EVENT_CONFLICT', 'WORKER', source_identity_digest,
      existing_identity_digest, received_identity_digest, NULL, NULL
    ) ON CONFLICT ON CONSTRAINT uq_creator_agent_journal_integrity_alert_dedupe DO NOTHING
    RETURNING id INTO durable_alert_id;
    IF durable_alert_id IS NULL THEN
      SELECT alert.id INTO durable_alert_id
        FROM public.creator_agent_journal_integrity_alerts AS alert
       WHERE alert.invocation_id = input_invocation_id
         AND alert.reason = 'SOURCE_EVENT_CONFLICT' AND alert.source = 'WORKER'
         AND alert.source_event_id_digest = source_identity_digest
         AND alert.existing_canonical_digest = existing_identity_digest
         AND alert.received_canonical_digest = received_identity_digest
         AND alert.expected_journal_seq IS NULL AND alert.received_journal_seq IS NULL;
      durable_alert_replayed := true;
    ELSE durable_alert_replayed := false;
    END IF;
    IF durable_alert_id IS NULL THEN
      RAISE EXCEPTION 'success preflight alert dedupe invariant failed' USING ERRCODE = '55000';
    END IF;
    RETURN QUERY SELECT 'SECURITY_BLOCKED'::text, NULL::uuid, NULL::uuid,
      NULL::integer, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
      NULL::bigint, durable_alert_id, durable_alert_replayed;
    RETURN;
  END IF;

  IF incoming.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN', 'EXPIRED') THEN
    RETURN QUERY SELECT 'TERMINAL'::text, NULL::uuid, NULL::uuid,
      NULL::integer, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
      NULL::bigint, NULL::uuid, NULL::boolean;
    RETURN;
  END IF;
  IF incoming.state NOT IN ('RUNNING', 'CANCEL_REQUESTED', 'RECONCILING')
     OR incoming.conversation_state <> 'BUSY'
     OR incoming.result_message_id IS NOT NULL OR incoming.result_digest IS NOT NULL
     OR incoming.agent_version_digest IS DISTINCT FROM input_agent_version_digest
     OR incoming.snapshot_digest IS DISTINCT FROM input_snapshot_digest
     OR incoming.assignment_lease_id IS DISTINCT FROM input_lease_id
     OR incoming.assignment_fence IS DISTINCT FROM input_fence
     OR incoming.execution_capability_id IS NULL
     OR incoming.execution_capability_digest IS DISTINCT FROM input_execution_capability_digest
     OR incoming.execution_capability_expires_at IS NULL
     OR incoming.execution_capability_expires_at <= clock_timestamp()
     OR incoming.execution_capability_revoked_at IS NOT NULL
     OR incoming.runtime_thread_id IS DISTINCT FROM input_runtime_thread_id
     OR incoming.runtime_turn_id IS DISTINCT FROM input_runtime_turn_id
     OR incoming.durable_started_fact_digest IS DISTINCT FROM input_started_fact_digest
     OR incoming.durable_started_payload NOT IN (
          '{"state":"RUNNING"}'::jsonb, '{"state":"RECONCILING"}'::jsonb
        )
     OR incoming.durable_started_source_event_id IS DISTINCT FROM incoming.start_command_id::text
     OR incoming.source_dispatch_receipt_digest IS NULL
     OR incoming.source_sandbox_attestation_digest IS NULL
     OR incoming.start_command_type IS DISTINCT FROM 'invocation.start'
     OR incoming.start_command_state NOT IN ('ACKED', 'EXPIRED')
     OR incoming.start_command_attempt_count IS NULL OR incoming.start_command_attempt_count < 1
     OR incoming.start_command_worker_id IS DISTINCT FROM input_installation_id
     OR incoming.start_command_conversation_id IS DISTINCT FROM incoming.conversation_id
     OR incoming.start_command_deployment_id IS DISTINCT FROM incoming.deployment_id
     OR incoming.start_command_lease_id IS DISTINCT FROM input_lease_id
     OR incoming.start_command_fence IS DISTINCT FROM input_fence
     OR incoming.start_command_capability_id IS DISTINCT FROM incoming.execution_capability_id
     OR incoming.start_command_capability_digest IS DISTINCT FROM
          input_execution_capability_digest
     OR incoming.durable_started_fact_digest IS DISTINCT FROM
          public.creator_agent_worker_started_fact_digest_v1(
            incoming.start_command_id,
            input_invocation_id, input_agent_version_digest, input_snapshot_digest,
            input_execution_capability_digest, input_lease_id, input_fence,
            incoming.start_command_id, input_runtime_thread_id, input_runtime_turn_id,
            incoming.source_dispatch_receipt_digest,
            incoming.source_sandbox_attestation_digest
          )
     OR NOT (
       incoming.lease_state = 'ACTIVE' AND incoming.lease_expires_at > clock_timestamp()
       OR incoming.durable_started_fact_digest IS NOT NULL
     ) THEN
    RETURN QUERY SELECT 'AUTHORITY_REJECTED'::text, NULL::uuid, NULL::uuid,
      NULL::integer, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
      NULL::bigint, NULL::uuid, NULL::boolean;
    RETURN;
  END IF;

  SELECT * INTO pending
    FROM public.creator_agent_success_seal_preflights AS preflight
   WHERE preflight.invocation_id = input_invocation_id
     AND preflight.transaction_id = txid_current();
  IF FOUND THEN
    IF pending.fact_digest IS DISTINCT FROM input_fact_digest THEN
      RETURN QUERY SELECT 'INVARIANT_FAILED'::text, NULL::uuid, NULL::uuid,
        NULL::integer, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
        NULL::bigint, NULL::uuid, NULL::boolean;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'SEAL_REQUIRED'::text, pending.seal_token,
      pending.assistant_message_id, 1, pending.creator_id, pending.conversation_id,
      'ASSISTANT'::text, pending.result_digest, NULL::bigint, NULL::uuid, NULL::boolean;
    RETURN;
  END IF;

  token_value := public.gen_uuid_v7();
  message_id_value := public.gen_uuid_v7();
  INSERT INTO public.creator_agent_success_seal_preflights (
    seal_token, transaction_id, invocation_id, creator_id, consumer_subject_id,
    conversation_id, installation_id, agent_version_digest, snapshot_digest,
    execution_capability_id, execution_capability_digest, lease_id, fence,
    assistant_message_id, user_turn_no, fact_digest,
    result_digest, local_result_cipher_digest, started_fact_digest,
    runtime_thread_id, runtime_turn_id
  ) VALUES (
    token_value, txid_current(), input_invocation_id, input_creator_id,
    incoming.consumer_subject_id, incoming.conversation_id, input_installation_id,
    input_agent_version_digest, input_snapshot_digest, incoming.execution_capability_id,
    input_execution_capability_digest, input_lease_id, input_fence, message_id_value,
    incoming.user_turn_no, input_fact_digest, input_result_digest,
    input_local_result_cipher_digest, input_started_fact_digest,
    input_runtime_thread_id, input_runtime_turn_id
  );
  RETURN QUERY SELECT 'SEAL_REQUIRED'::text, token_value, message_id_value,
    1, input_creator_id, incoming.conversation_id, 'ASSISTANT'::text,
    input_result_digest, NULL::bigint, NULL::uuid, NULL::boolean;
END;
$success_preflight$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.creator_agent_finalize_success_fact_v1(
  input_seal_token uuid,
  input_creator_id uuid,
  input_invocation_id uuid,
  input_fact_digest text,
  input_assistant_message_id uuid,
  input_verified_result_digest text,
  input_algorithm text,
  input_key_id text,
  input_nonce bytea,
  input_ciphertext bytea,
  input_auth_tag bytea,
  input_cipher_digest text,
  input_content_digest text,
  input_aad_version integer
)
RETURNS TABLE (
  outcome text, assistant_message_id uuid, result_digest text,
  terminal_at timestamptz, consumer_event_cursor bigint,
  assistant_message_appended boolean, invocation_succeeded boolean,
  succeeded_event_appended boolean, consumer_event_appended boolean,
  consumer_stream_advanced boolean, terminal_receipt_appended boolean,
  conversation_idled boolean, preflight_consumed boolean,
  alert_id uuid, alert_replayed boolean
)
SECURITY DEFINER SET search_path = pg_catalog, public
AS $success_finalize$
DECLARE
  session_is_untrusted boolean;
  pending record;
  current record;
  terminal_event_id_value bigint;
  terminal_at_value timestamptz;
  occurred_at_text text;
  terminal_payload jsonb;
  payload_digest_value text;
  dedupe_key_value text;
  cursor_value bigint;
  existing_digest text;
  received_digest text;
  source_digest text;
  durable_alert_id uuid;
  durable_alert_replayed boolean;
BEGIN
  SELECT role.rolsuper OR role.rolbypassrls INTO session_is_untrusted
    FROM pg_catalog.pg_roles AS role WHERE role.rolname = session_user;
  IF session_user <> 'combo_agent_broker' OR COALESCE(session_is_untrusted, true)
     OR input_creator_id IS DISTINCT FROM
          NULLIF(current_setting('app.creator_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Success finalize requires exact Broker/Creator authority'
      USING ERRCODE = '42501';
  END IF;
  SELECT * INTO pending
    FROM public.creator_agent_success_seal_preflights AS preflight
   WHERE preflight.seal_token = input_seal_token
     AND preflight.transaction_id = txid_current()
     AND preflight.creator_id = input_creator_id
     AND preflight.invocation_id = input_invocation_id
     AND preflight.fact_digest = input_fact_digest
     AND preflight.assistant_message_id = input_assistant_message_id
   FOR UPDATE;
  IF NOT FOUND OR pending.consumer_subject_id IS DISTINCT FROM
       NULLIF(current_setting('app.consumer_id', true), '')::uuid THEN
    RETURN QUERY SELECT 'AUTHORITY_REJECTED'::text, NULL::uuid, NULL::text,
      NULL::timestamptz, NULL::bigint, NULL::boolean, NULL::boolean,
      NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
      NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
    RETURN;
  END IF;
  IF input_verified_result_digest IS NULL
     OR input_verified_result_digest !~ '^hmac-sha256:[a-f0-9]{64}$' THEN
    RETURN QUERY SELECT 'AUTHORITY_REJECTED'::text, NULL::uuid, NULL::text,
      NULL::timestamptz, NULL::bigint, NULL::boolean, NULL::boolean,
      NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
      NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
    RETURN;
  END IF;
  IF input_verified_result_digest IS DISTINCT FROM pending.result_digest THEN
    source_digest := pg_catalog.encode(public.digest(pg_catalog.convert_to(
      pg_catalog.jsonb_build_object(
        'domain', 'combo:vnext:worker-source-identity:v1',
        'source', 'WORKER', 'sourceEventId', input_invocation_id::text
      )::text, 'UTF8'), 'sha256'), 'hex');
    existing_digest := pg_catalog.encode(public.digest(pg_catalog.convert_to(
      pg_catalog.jsonb_build_object(
        'domain', 'combo:vnext:success-fact-result-digest:v1',
        'factDigest', pending.fact_digest, 'resultDigest', pending.result_digest
      )::text, 'UTF8'), 'sha256'), 'hex');
    received_digest := pg_catalog.encode(public.digest(pg_catalog.convert_to(
      pg_catalog.jsonb_build_object(
        'domain', 'combo:vnext:success-verified-result-digest:v1',
        'factDigest', pending.fact_digest, 'resultDigest', input_verified_result_digest
      )::text, 'UTF8'), 'sha256'), 'hex');
    INSERT INTO public.creator_agent_journal_integrity_alerts (
      invocation_id, creator_id, consumer_subject_id, reason, source,
      source_event_id_digest, existing_canonical_digest, received_canonical_digest,
      expected_journal_seq, received_journal_seq
    ) VALUES (
      input_invocation_id, input_creator_id, pending.consumer_subject_id,
      'SOURCE_EVENT_CONFLICT', 'WORKER', source_digest,
      existing_digest, received_digest, NULL, NULL
    ) ON CONFLICT ON CONSTRAINT uq_creator_agent_journal_integrity_alert_dedupe DO NOTHING
    RETURNING id INTO durable_alert_id;
    IF durable_alert_id IS NULL THEN
      SELECT alert.id INTO durable_alert_id
        FROM public.creator_agent_journal_integrity_alerts AS alert
       WHERE alert.invocation_id = input_invocation_id
         AND alert.reason = 'SOURCE_EVENT_CONFLICT' AND alert.source = 'WORKER'
         AND alert.source_event_id_digest = source_digest
         AND alert.existing_canonical_digest = existing_digest
         AND alert.received_canonical_digest = received_digest
         AND alert.expected_journal_seq IS NULL AND alert.received_journal_seq IS NULL;
      durable_alert_replayed := true;
    ELSE durable_alert_replayed := false;
    END IF;
    IF durable_alert_id IS NULL THEN
      RAISE EXCEPTION 'success finalize alert dedupe invariant failed' USING ERRCODE = '55000';
    END IF;
    DELETE FROM public.creator_agent_success_seal_preflights
     WHERE seal_token = input_seal_token;
    RETURN QUERY SELECT 'SECURITY_BLOCKED'::text, NULL::uuid, NULL::text,
      NULL::timestamptz, NULL::bigint, NULL::boolean, NULL::boolean,
      NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
      NULL::boolean, NULL::boolean, durable_alert_id, durable_alert_replayed;
    RETURN;
  END IF;

  IF input_algorithm IS DISTINCT FROM 'aes-256-gcm/v1'
     OR input_key_id IS NULL OR length(input_key_id) NOT BETWEEN 1 AND 256
     OR input_key_id !~ '^[-A-Za-z0-9_.:/]+$'
     OR input_nonce IS NULL OR octet_length(input_nonce) <> 12
     OR input_ciphertext IS NULL OR octet_length(input_ciphertext) NOT BETWEEN 1 AND 65536
     OR input_auth_tag IS NULL OR octet_length(input_auth_tag) <> 16
     OR input_cipher_digest IS NULL OR input_cipher_digest !~ '^[a-f0-9]{64}$'
     OR input_content_digest IS NULL
     OR input_content_digest !~ '^hmac-sha256:[a-f0-9]{64}$'
     OR input_aad_version IS DISTINCT FROM 1
     OR input_cipher_digest IS DISTINCT FROM pg_catalog.encode(
          public.digest(input_nonce || input_ciphertext || input_auth_tag, 'sha256'), 'hex'
        )
     OR input_content_digest = pending.result_digest
     OR input_cipher_digest = pending.local_result_cipher_digest THEN
    RETURN QUERY SELECT 'AUTHORITY_REJECTED'::text, NULL::uuid, NULL::text,
      NULL::timestamptz, NULL::bigint, NULL::boolean, NULL::boolean,
      NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
      NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
    RETURN;
  END IF;

  SELECT invocation.state, invocation.execution_capability_expires_at,
         invocation.execution_capability_revoked_at,
         invocation.result_message_id, invocation.result_digest,
         invocation.assigned_worker_id, invocation.assignment_lease_id,
         invocation.assignment_fence, invocation.execution_capability_id,
         invocation.execution_capability_digest,
         invocation.runtime_thread_id, invocation.runtime_turn_id,
         version.version_digest AS agent_version_digest,
         snapshot.snapshot_digest,
         started.source_fact_digest AS started_fact_digest,
         conversation.state AS conversation_state
    INTO current
    FROM public.agent_invocations AS invocation
    JOIN public.agent_conversations AS conversation
      ON conversation.id = invocation.conversation_id
     AND conversation.creator_id = invocation.creator_id
     AND conversation.consumer_subject_id = invocation.consumer_subject_id
    JOIN public.agent_versions AS version
      ON version.id = invocation.agent_version_id
     AND version.creator_id = invocation.creator_id
    JOIN public.context_snapshots AS snapshot
     ON snapshot.id = version.snapshot_id
     AND snapshot.creator_id = version.creator_id
    LEFT JOIN public.agent_invocation_events AS started
      ON started.invocation_id = invocation.id
     AND started.creator_id = invocation.creator_id
     AND started.consumer_subject_id = invocation.consumer_subject_id
     AND started.source = 'WORKER' AND started.event_type = 'invocation.started'
   WHERE invocation.id = input_invocation_id
     AND invocation.creator_id = input_creator_id
     AND invocation.consumer_subject_id = pending.consumer_subject_id
   FOR UPDATE OF invocation, conversation;
  IF NOT FOUND OR current.state NOT IN ('RUNNING', 'CANCEL_REQUESTED', 'RECONCILING')
     OR current.conversation_state <> 'BUSY'
     OR current.result_message_id IS NOT NULL OR current.result_digest IS NOT NULL
     OR current.assigned_worker_id IS DISTINCT FROM pending.installation_id
     OR current.assignment_lease_id IS DISTINCT FROM pending.lease_id
     OR current.assignment_fence IS DISTINCT FROM pending.fence
     OR current.execution_capability_id IS DISTINCT FROM pending.execution_capability_id
     OR current.execution_capability_digest IS DISTINCT FROM
          pending.execution_capability_digest
     OR current.agent_version_digest IS DISTINCT FROM pending.agent_version_digest
     OR current.snapshot_digest IS DISTINCT FROM pending.snapshot_digest
     OR current.runtime_thread_id IS DISTINCT FROM pending.runtime_thread_id
     OR current.runtime_turn_id IS DISTINCT FROM pending.runtime_turn_id
     OR current.started_fact_digest IS DISTINCT FROM pending.started_fact_digest
     OR current.execution_capability_expires_at IS NULL
     OR current.execution_capability_expires_at <= clock_timestamp()
     OR current.execution_capability_revoked_at IS NOT NULL THEN
    RETURN QUERY SELECT 'AUTHORITY_REJECTED'::text, NULL::uuid, NULL::text,
      NULL::timestamptz, NULL::bigint, NULL::boolean, NULL::boolean,
      NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
      NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
    RETURN;
  END IF;

  BEGIN
    INSERT INTO public.agent_messages (
      id, conversation_id, creator_id, consumer_subject_id, turn_no, role,
      client_message_id, content_algorithm, content_key_id, content_nonce,
      content_ciphertext, content_auth_tag, content_cipher_digest, content_digest,
      content_aad_version, invocation_id
    ) VALUES (
      pending.assistant_message_id, pending.conversation_id, pending.creator_id,
      pending.consumer_subject_id, pending.user_turn_no, 'ASSISTANT', NULL,
      input_algorithm, input_key_id, input_nonce, input_ciphertext, input_auth_tag,
      input_cipher_digest, input_content_digest, input_aad_version, pending.invocation_id
    );
    terminal_at_value := date_trunc('milliseconds', clock_timestamp());
    UPDATE public.agent_invocations AS invocation
       SET state = 'SUCCEEDED', result_message_id = pending.assistant_message_id,
           result_digest = pending.result_digest, error_code = NULL,
           uncertainty_reason = NULL, terminal_at = terminal_at_value
     WHERE invocation.id = pending.invocation_id
       AND invocation.creator_id = pending.creator_id
       AND invocation.consumer_subject_id = pending.consumer_subject_id
       AND invocation.state IN ('RUNNING', 'CANCEL_REQUESTED', 'RECONCILING')
       AND invocation.assigned_worker_id = pending.installation_id
       AND invocation.assignment_lease_id = pending.lease_id
       AND invocation.assignment_fence = pending.fence
       AND invocation.execution_capability_id = pending.execution_capability_id
       AND invocation.execution_capability_digest = pending.execution_capability_digest
       AND invocation.runtime_thread_id = pending.runtime_thread_id
       AND invocation.runtime_turn_id = pending.runtime_turn_id
       AND invocation.execution_capability_expires_at > clock_timestamp()
       AND invocation.execution_capability_revoked_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'success projection changed' USING ERRCODE = '55000'; END IF;

    INSERT INTO public.agent_invocation_events (
      invocation_id, creator_id, consumer_subject_id, journal_seq, source,
      source_event_id, event_type, payload, occurred_at,
      source_fact_digest, broker_command_id, source_local_result_cipher_digest
    )
    SELECT pending.invocation_id, pending.creator_id, pending.consumer_subject_id,
           COALESCE(max(event.journal_seq), 0) + 1, 'WORKER',
           pending.invocation_id::text, 'invocation.succeeded',
           pg_catalog.jsonb_build_object(
             'state', 'SUCCEEDED', 'messageId', pending.assistant_message_id,
             'resultDigest', pending.result_digest
           ),
           terminal_at_value, pending.fact_digest, NULL,
           pending.local_result_cipher_digest
      FROM public.agent_invocation_events AS event
     WHERE event.invocation_id = pending.invocation_id
    RETURNING id INTO terminal_event_id_value;

    occurred_at_text := pg_catalog.to_char(
      terminal_at_value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    );
    terminal_payload := pg_catalog.jsonb_build_object(
      'protocol', 'combo.consumer-event-outbox/1', 'schemaVersion', 1,
      'type', 'invocation.terminal', 'conversationId', pending.conversation_id::text,
      'invocationId', pending.invocation_id::text, 'terminalState', 'SUCCEEDED',
      'assistantMessageId', pending.assistant_message_id::text,
      'resultDigest', pending.result_digest, 'errorCode', NULL::text,
      'occurredAt', occurred_at_text
    );
    payload_digest_value := public.creator_agent_success_consumer_payload_digest_v1(
      pending.assistant_message_id, pending.conversation_id, pending.invocation_id,
      pending.result_digest, occurred_at_text
    );
    dedupe_key_value := public.creator_agent_success_consumer_dedupe_key_v1(
      pending.consumer_subject_id, terminal_event_id_value
    );
    INSERT INTO public.consumer_event_outbox (
      owner_id, conversation_id, invocation_id, source_event_id,
      event_type, payload, payload_digest, dedupe_key
    ) VALUES (
      pending.consumer_subject_id, pending.conversation_id, pending.invocation_id,
      terminal_event_id_value, 'invocation.terminal', terminal_payload,
      payload_digest_value, dedupe_key_value
    ) RETURNING cursor INTO cursor_value;
    INSERT INTO public.consumer_event_streams (
      owner_id, conversation_id, latest_cursor, expired_through_cursor, updated_at
    ) VALUES (
      pending.consumer_subject_id, pending.conversation_id, cursor_value, 0, clock_timestamp()
    ) ON CONFLICT (owner_id, conversation_id) DO UPDATE
      SET latest_cursor = GREATEST(consumer_event_streams.latest_cursor, EXCLUDED.latest_cursor),
          updated_at = clock_timestamp();
    INSERT INTO public.creator_agent_succeeded_terminal_receipts (
      invocation_id, creator_id, consumer_subject_id, conversation_id,
      terminal_event_id, assistant_message_id, consumer_event_cursor,
      payload_digest, dedupe_key
    ) VALUES (
      pending.invocation_id, pending.creator_id, pending.consumer_subject_id,
      pending.conversation_id, terminal_event_id_value, pending.assistant_message_id,
      cursor_value, payload_digest_value, dedupe_key_value
    );
    UPDATE public.agent_conversations AS conversation
       SET state = 'IDLE', last_activity_at = clock_timestamp()
     WHERE conversation.id = pending.conversation_id
       AND conversation.creator_id = pending.creator_id
       AND conversation.consumer_subject_id = pending.consumer_subject_id
       AND conversation.state = 'BUSY';
    IF NOT FOUND THEN RAISE EXCEPTION 'success Conversation not IDLE' USING ERRCODE = '55000'; END IF;
    DELETE FROM public.creator_agent_success_seal_preflights
     WHERE seal_token = input_seal_token;
  EXCEPTION WHEN unique_violation THEN
    RETURN QUERY SELECT 'INVARIANT_FAILED'::text, NULL::uuid, NULL::text,
      NULL::timestamptz, NULL::bigint, NULL::boolean, NULL::boolean,
      NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
      NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
    RETURN;
  END;
  RETURN QUERY SELECT 'ADMITTED'::text, pending.assistant_message_id,
    pending.result_digest, terminal_at_value, cursor_value,
    true, true, true, true, true, true, true, true, NULL::uuid, NULL::boolean;
END;
$success_finalize$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.creator_agent_preflight_success_fact_v1(
  uuid,uuid,text,integer,text,uuid,uuid,text,text,text,uuid,bigint,text,text,text,text,text,text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.creator_agent_preflight_success_fact_v1(
  uuid,uuid,text,integer,text,uuid,uuid,text,text,text,uuid,bigint,text,text,text,text,text,text
) TO combo_agent_broker;
REVOKE ALL ON FUNCTION public.creator_agent_finalize_success_fact_v1(
  uuid,uuid,uuid,text,uuid,text,text,text,bytea,bytea,bytea,text,text,integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.creator_agent_finalize_success_fact_v1(
  uuid,uuid,uuid,text,uuid,text,text,text,bytea,bytea,bytea,text,text,integer
) TO combo_agent_broker;

CREATE OR REPLACE FUNCTION public.enforce_creator_agent_success_preflight_consumed()
RETURNS trigger SECURITY DEFINER SET search_path = pg_catalog, public
AS $preflight_consumed$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.creator_agent_success_seal_preflights AS pending
     WHERE pending.seal_token = NEW.seal_token
  ) THEN
    RAISE EXCEPTION 'success seal preflight cannot commit without finalize'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$preflight_consumed$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_success_preflight_consumed() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_creator_agent_success_preflight_consumed()
  TO combo_agent_broker, combo_agent_reconciler;

CREATE CONSTRAINT TRIGGER creator_agent_success_seal_preflight_consumed
AFTER INSERT ON public.creator_agent_success_seal_preflights
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_creator_agent_success_preflight_consumed();

CREATE OR REPLACE FUNCTION public.enforce_creator_agent_succeeded_terminal_companion()
RETURNS trigger SECURITY DEFINER SET search_path = pg_catalog, public
AS $succeeded_companion$
DECLARE
  exact_chain boolean;
  occurred_at_text text;
BEGIN
  IF NEW.state <> 'SUCCEEDED' THEN RETURN NEW; END IF;
  occurred_at_text := pg_catalog.to_char(
    NEW.terminal_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  SELECT EXISTS (
    SELECT 1
      FROM public.agent_invocation_events AS event
      JOIN public.agent_versions AS version
        ON version.id = NEW.agent_version_id AND version.creator_id = NEW.creator_id
      JOIN public.context_snapshots AS snapshot
        ON snapshot.id = version.snapshot_id AND snapshot.creator_id = version.creator_id
      JOIN public.agent_invocation_events AS started
        ON started.invocation_id = NEW.id
       AND started.creator_id = NEW.creator_id
       AND started.consumer_subject_id = NEW.consumer_subject_id
       AND started.source = 'WORKER' AND started.event_type = 'invocation.started'
      JOIN public.agent_messages AS message
        ON message.id = NEW.result_message_id
       AND message.conversation_id = NEW.conversation_id
       AND message.creator_id = NEW.creator_id
       AND message.consumer_subject_id = NEW.consumer_subject_id
       AND message.invocation_id = NEW.id AND message.role = 'ASSISTANT'
      JOIN public.creator_agent_succeeded_terminal_receipts AS receipt
        ON receipt.invocation_id = NEW.id
       AND receipt.creator_id = NEW.creator_id
       AND receipt.consumer_subject_id = NEW.consumer_subject_id
       AND receipt.conversation_id = NEW.conversation_id
       AND receipt.terminal_event_id = event.id
       AND receipt.assistant_message_id = message.id
      JOIN public.consumer_event_outbox AS outbox
        ON outbox.cursor = receipt.consumer_event_cursor
       AND outbox.owner_id = receipt.consumer_subject_id
       AND outbox.conversation_id = NEW.conversation_id
       AND outbox.invocation_id = NEW.id
       AND outbox.source_event_id = event.id
       AND outbox.event_type = 'invocation.terminal'
      JOIN public.consumer_event_streams AS stream
        ON stream.owner_id = NEW.consumer_subject_id
       AND stream.conversation_id = NEW.conversation_id
       AND stream.latest_cursor >= receipt.consumer_event_cursor
      JOIN public.agent_conversations AS conversation
        ON conversation.id = NEW.conversation_id
       AND conversation.creator_id = NEW.creator_id
       AND conversation.consumer_subject_id = NEW.consumer_subject_id
       AND conversation.state = 'IDLE'
     WHERE event.invocation_id = NEW.id
       AND event.creator_id = NEW.creator_id
       AND event.consumer_subject_id = NEW.consumer_subject_id
       AND event.source = 'WORKER' AND event.event_type = 'invocation.succeeded'
       AND event.source_event_id = NEW.id::text
       AND event.source_fact_digest = public.creator_agent_worker_success_fact_digest_v1(
         NEW.id, NEW.id, version.version_digest, snapshot.snapshot_digest,
         NEW.execution_capability_digest, NEW.assignment_lease_id, NEW.assignment_fence,
         event.source_local_result_cipher_digest, NEW.result_digest,
         NEW.runtime_thread_id, NEW.runtime_turn_id, started.source_fact_digest
       )
       AND event.broker_command_id IS NULL
       AND event.source_local_result_cipher_digest IS NOT NULL
       AND event.payload = pg_catalog.jsonb_build_object(
         'state', 'SUCCEEDED', 'messageId', message.id, 'resultDigest', NEW.result_digest
       )
       AND event.occurred_at = NEW.terminal_at
       AND NEW.result_digest ~ '^hmac-sha256:[a-f0-9]{64}$'
       AND NEW.error_code IS NULL
       AND message.client_message_id IS NULL
       AND message.content_algorithm = 'aes-256-gcm/v1'
       AND message.content_aad_version = 1
       AND message.content_cipher_digest = pg_catalog.encode(
         public.digest(message.content_nonce || message.content_ciphertext ||
           message.content_auth_tag, 'sha256'), 'hex'
       )
       AND message.content_cipher_digest <> event.source_local_result_cipher_digest
       AND message.content_digest <> NEW.result_digest
       AND receipt.payload_digest = public.creator_agent_success_consumer_payload_digest_v1(
         message.id, NEW.conversation_id, NEW.id, NEW.result_digest, occurred_at_text
       )
       AND receipt.dedupe_key = public.creator_agent_success_consumer_dedupe_key_v1(
         NEW.consumer_subject_id, event.id
       )
       AND outbox.payload = pg_catalog.jsonb_build_object(
         'protocol', 'combo.consumer-event-outbox/1', 'schemaVersion', 1,
         'type', 'invocation.terminal', 'conversationId', NEW.conversation_id::text,
         'invocationId', NEW.id::text, 'terminalState', 'SUCCEEDED',
         'assistantMessageId', message.id::text, 'resultDigest', NEW.result_digest,
         'errorCode', NULL::text, 'occurredAt', occurred_at_text
       )
       AND outbox.payload_digest = receipt.payload_digest
       AND outbox.dedupe_key = receipt.dedupe_key
  ) INTO exact_chain;
  IF exact_chain IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SUCCEEDED projection requires exact terminal chain'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$succeeded_companion$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_succeeded_terminal_companion() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_creator_agent_succeeded_terminal_companion()
  TO combo_agent_broker, combo_agent_reconciler;

CREATE CONSTRAINT TRIGGER agent_invocations_succeeded_terminal_companion
AFTER UPDATE OF state, result_message_id, result_digest, error_code, terminal_at
ON public.agent_invocations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_creator_agent_succeeded_terminal_companion();

DO $success_authority_owner_gate$
DECLARE trusted boolean; owner_count integer;
BEGIN
  SELECT pg_catalog.bool_and(procedure.prosecdef AND (role.rolsuper OR role.rolbypassrls)),
         count(*)::integer
    INTO trusted, owner_count
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS role ON role.oid = procedure.proowner
   WHERE procedure.oid IN (
     'public.creator_agent_preflight_success_fact_v1(uuid,uuid,text,integer,text,uuid,uuid,text,text,text,uuid,bigint,text,text,text,text,text,text)'::regprocedure,
     'public.creator_agent_finalize_success_fact_v1(uuid,uuid,uuid,text,uuid,text,text,text,bytea,bytea,bytea,text,text,integer)'::regprocedure,
     'public.enforce_creator_agent_success_preflight_consumed()'::regprocedure,
     'public.enforce_creator_agent_succeeded_terminal_companion()'::regprocedure
   );
  IF trusted IS DISTINCT FROM true OR owner_count IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'Success admission and companions require trusted SECURITY DEFINER owners'
      USING ERRCODE = '42501';
  END IF;
END;
$success_authority_owner_gate$;

-- Existing phase gates remain; succeeded is now accepted only from the finalize definer owner.
CREATE OR REPLACE FUNCTION public.enforce_creator_agent_success_write_authority()
RETURNS trigger SET search_path = pg_catalog, public
AS $success_write_authority$
DECLARE owner_name name; privileged boolean;
BEGIN
  SELECT role.rolsuper OR role.rolbypassrls INTO privileged
    FROM pg_catalog.pg_roles AS role WHERE role.rolname = session_user;
  IF COALESCE(privileged, false) THEN RETURN NEW; END IF;
  SELECT role.rolname INTO owner_name
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS role ON role.oid = procedure.proowner
   WHERE procedure.oid =
     'public.creator_agent_finalize_success_fact_v1(uuid,uuid,uuid,text,uuid,text,text,text,bytea,bytea,bytea,text,text,integer)'::regprocedure;
  IF session_user <> 'combo_agent_broker' OR current_user = session_user
     OR current_user IS DISTINCT FROM owner_name THEN
    RAISE EXCEPTION 'succeeded terminal requires finalize authority'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$success_write_authority$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_success_write_authority() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_creator_agent_success_write_authority()
  TO combo_agent_broker, combo_agent_reconciler;

CREATE TRIGGER agent_invocation_events_00_succeeded_write_authority
BEFORE INSERT ON public.agent_invocation_events
FOR EACH ROW WHEN (NEW.source = 'WORKER' AND NEW.event_type = 'invocation.succeeded')
EXECUTE FUNCTION public.enforce_creator_agent_success_write_authority();
CREATE TRIGGER agent_messages_assistant_write_authority
BEFORE INSERT ON public.agent_messages
FOR EACH ROW WHEN (NEW.role = 'ASSISTANT')
EXECUTE FUNCTION public.enforce_creator_agent_success_write_authority();

-- Install the finalize-owner predicate directly on succeeded Outbox rows.
CREATE OR REPLACE FUNCTION public.enforce_creator_agent_success_outbox_insert()
RETURNS trigger SET search_path = pg_catalog, public
AS $success_outbox_insert$
DECLARE is_success boolean; owner_name name; privileged boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.agent_invocation_events AS event
     WHERE event.id = NEW.source_event_id AND event.invocation_id = NEW.invocation_id
       AND event.source = 'WORKER' AND event.event_type = 'invocation.succeeded'
  ) INTO is_success;
  IF NOT is_success THEN RETURN NEW; END IF;
  SELECT role.rolsuper OR role.rolbypassrls INTO privileged
    FROM pg_catalog.pg_roles AS role WHERE role.rolname = session_user;
  IF COALESCE(privileged, false) THEN RETURN NEW; END IF;
  SELECT role.rolname INTO owner_name
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS role ON role.oid = procedure.proowner
   WHERE procedure.oid =
     'public.creator_agent_finalize_success_fact_v1(uuid,uuid,uuid,text,uuid,text,text,text,bytea,bytea,bytea,text,text,integer)'::regprocedure;
  IF session_user <> 'combo_agent_broker' OR current_user = session_user
     OR current_user IS DISTINCT FROM owner_name THEN
    RAISE EXCEPTION 'succeeded Consumer terminal requires finalize authority'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$success_outbox_insert$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_success_outbox_insert() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_creator_agent_success_outbox_insert()
  TO combo_agent_broker, combo_agent_reconciler;

CREATE TRIGGER consumer_event_outbox_succeeded_insert_authority
BEFORE INSERT ON public.consumer_event_outbox
FOR EACH ROW EXECUTE FUNCTION public.enforce_creator_agent_success_outbox_insert();

-- Upgrade failed-after-succeeded classification before delegating all other failed work to v1.
CREATE OR REPLACE FUNCTION public.creator_agent_project_failed_fact_v2(
  input_creator_id uuid, input_installation_id uuid, input_protocol text,
  input_schema_version integer, input_type text, input_source_event_id uuid,
  input_invocation_id uuid, input_agent_version_digest text,
  input_snapshot_digest text, input_execution_capability_digest text,
  input_lease_id uuid, input_fence bigint, input_error_code text, input_fact_digest text
)
RETURNS TABLE (
  outcome text, error_code text, terminal_at timestamptz, consumer_event_cursor bigint,
  invocation_failed boolean, failed_event_appended boolean,
  consumer_event_appended boolean, consumer_stream_advanced boolean,
  terminal_receipt_appended boolean, conversation_idled boolean,
  alert_id uuid, alert_replayed boolean
)
SECURITY DEFINER SET search_path = pg_catalog, public
AS $failed_v2$
DECLARE
  session_is_untrusted boolean;
  incoming record;
  succeeded record;
  existing_fact jsonb;
  received_fact jsonb;
  terminal_payload jsonb;
  occurred_at_text text;
  expected_payload_digest text;
  expected_dedupe_key text;
  existing_digest text;
  received_digest text;
  source_digest text;
  durable_alert_id uuid;
  replayed_value boolean;
BEGIN
  SELECT role.rolsuper OR role.rolbypassrls INTO session_is_untrusted
    FROM pg_catalog.pg_roles AS role WHERE role.rolname = session_user;
  IF session_user <> 'combo_agent_broker' OR COALESCE(session_is_untrusted, true)
     OR input_creator_id IS DISTINCT FROM
          NULLIF(current_setting('app.creator_id', true), '')::uuid
     OR NULLIF(current_setting('app.consumer_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'failed v2 requires exact Broker and cleared tenant context'
      USING ERRCODE = '42501';
  END IF;
  IF input_creator_id IS NULL OR input_installation_id IS NULL
     OR input_source_event_id IS NULL OR input_invocation_id IS NULL
     OR input_source_event_id IS DISTINCT FROM input_invocation_id
     OR input_source_event_id::text !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR input_lease_id IS NULL OR input_lease_id::text !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR input_protocol IS DISTINCT FROM 'combo.worker-invocation-fact/1'
     OR input_schema_version IS DISTINCT FROM 1
     OR input_type IS DISTINCT FROM 'invocation.failed'
     OR input_agent_version_digest IS NULL
     OR input_agent_version_digest !~ '^[a-f0-9]{64}$'
     OR input_snapshot_digest IS NULL OR input_snapshot_digest !~ '^[a-f0-9]{64}$'
     OR input_execution_capability_digest IS NULL
     OR input_execution_capability_digest !~ '^[a-f0-9]{64}$'
     OR input_fence IS NULL OR input_fence < 1
     OR input_error_code IS NULL OR input_error_code NOT IN (
          'SNAPSHOT_DIGEST_MISMATCH', 'PROTOCOL_INCOMPATIBLE',
          'SANDBOX_ATTESTATION_FAILED', 'RUNTIME_START_FAILED',
          'MODEL_QUOTA_EXHAUSTED', 'TURN_TIMEOUT', 'TURN_FAILED'
        )
     OR input_fact_digest IS NULL OR input_fact_digest !~ '^[a-f0-9]{64}$'
     OR input_fact_digest IS DISTINCT FROM public.creator_agent_worker_failed_fact_digest_v1(
          input_source_event_id, input_invocation_id, input_agent_version_digest,
          input_snapshot_digest, input_execution_capability_digest,
          input_lease_id, input_fence, input_error_code
        ) THEN
    RETURN QUERY SELECT 'AUTHORITY_REJECTED'::text, NULL::text, NULL::timestamptz,
      NULL::bigint, NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
      NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
    RETURN;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'combo.creator-agent-worker-source/1:' || input_source_event_id::text, 0
  ));
  SELECT invocation.id, invocation.conversation_id, invocation.creator_id,
         invocation.consumer_subject_id, invocation.agent_version_id,
         invocation.assigned_worker_id, invocation.assignment_lease_id,
         invocation.assignment_fence, invocation.execution_capability_id,
         invocation.execution_capability_digest,
         conversation.deployment_id,
         version.version_digest AS agent_version_digest,
         snapshot.id AS snapshot_id, snapshot.snapshot_digest
    INTO incoming
    FROM public.agent_invocations AS invocation
    JOIN public.agent_conversations AS conversation
      ON conversation.id = invocation.conversation_id
     AND conversation.creator_id = invocation.creator_id
     AND conversation.consumer_subject_id = invocation.consumer_subject_id
    JOIN public.agent_versions AS version
      ON version.id = invocation.agent_version_id AND version.creator_id = invocation.creator_id
    JOIN public.context_snapshots AS snapshot
      ON snapshot.id = version.snapshot_id AND snapshot.creator_id = version.creator_id
   WHERE invocation.id = input_invocation_id
     AND invocation.creator_id = input_creator_id
     AND invocation.assigned_worker_id = input_installation_id
   FOR UPDATE OF invocation, conversation;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'UNAVAILABLE'::text, NULL::text, NULL::timestamptz,
      NULL::bigint, NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
      NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config('app.consumer_id', incoming.consumer_subject_id::text, true);
  received_fact := pg_catalog.jsonb_build_object(
    'protocol', input_protocol, 'schemaVersion', input_schema_version,
    'type', input_type, 'sourceEventId', input_source_event_id::text,
    'invocationId', input_invocation_id::text,
    'agentVersionDigest', input_agent_version_digest,
    'snapshotDigest', input_snapshot_digest,
    'executionCapabilityDigest', input_execution_capability_digest,
    'leaseId', input_lease_id::text, 'fence', input_fence::text,
    'errorCode', input_error_code
  );

  SELECT event.id, event.invocation_id, event.creator_id, event.consumer_subject_id,
         event.source_event_id, event.source_fact_digest,
         event.source_local_result_cipher_digest, event.payload, event.occurred_at,
         event.broker_command_id,
         invocation.state, invocation.result_message_id, invocation.result_digest,
         invocation.error_code, invocation.terminal_at, invocation.conversation_id,
         invocation.creator_id AS invocation_creator_id,
         invocation.consumer_subject_id AS invocation_consumer_subject_id,
         invocation.agent_version_id, invocation.assigned_worker_id,
         invocation.execution_capability_id,
         invocation.runtime_thread_id, invocation.runtime_turn_id,
         conversation.state AS conversation_state, conversation.deployment_id,
         version.version_digest, snapshot.id AS snapshot_id, snapshot.snapshot_digest,
         invocation.execution_capability_digest, invocation.assignment_lease_id,
         invocation.assignment_fence, lease.id AS durable_lease_id,
         lease.worker_id AS durable_lease_worker_id, lease.fence AS durable_lease_fence,
         started.source_fact_digest AS started_fact_digest,
         started.payload AS started_payload,
         started.source_event_id AS started_source_event_id,
         started.broker_command_id AS started_command_id,
         started.source_dispatch_receipt_digest AS started_dispatch_receipt_digest,
         started.source_sandbox_attestation_digest AS started_sandbox_attestation_digest,
         start_command.command_type AS started_command_type,
         start_command.state AS started_command_state,
         start_command.attempt_count AS started_command_attempt_count,
         start_command.target_worker_id AS started_command_worker_id,
         start_command.conversation_id AS started_command_conversation_id,
         start_command.deployment_id AS started_command_deployment_id,
         start_command.assignment_lease_id AS started_command_lease_id,
         start_command.assignment_fence AS started_command_fence,
         start_command.execution_capability_id AS started_command_capability_id,
         start_command.execution_capability_digest AS started_command_capability_digest,
         message.id AS message_id, message.conversation_id AS message_conversation_id,
         message.creator_id AS message_creator_id,
         message.consumer_subject_id AS message_consumer_subject_id,
         message.invocation_id AS message_invocation_id,
         message.role, message.client_message_id, message.content_algorithm,
         message.content_key_id, message.content_nonce, message.content_ciphertext,
         message.content_auth_tag, message.content_cipher_digest,
         message.content_digest, message.content_aad_version,
         receipt.terminal_event_id AS receipt_event_id,
         receipt.assistant_message_id AS receipt_message_id,
         receipt.consumer_event_cursor AS receipt_cursor,
         receipt.payload_digest AS receipt_payload_digest,
         receipt.dedupe_key AS receipt_dedupe_key,
         outbox.cursor AS retained_cursor, outbox.payload AS retained_payload,
         outbox.payload_digest AS retained_payload_digest,
         outbox.dedupe_key AS retained_dedupe_key,
         stream.latest_cursor, stream.expired_through_cursor
    INTO succeeded
    FROM public.agent_invocation_events AS event
    LEFT JOIN public.agent_invocations AS invocation
      ON invocation.id = event.invocation_id
     AND invocation.creator_id = event.creator_id
     AND invocation.consumer_subject_id = event.consumer_subject_id
    LEFT JOIN public.agent_conversations AS conversation
      ON conversation.id = invocation.conversation_id
     AND conversation.creator_id = invocation.creator_id
     AND conversation.consumer_subject_id = invocation.consumer_subject_id
    LEFT JOIN public.agent_versions AS version
      ON version.id = invocation.agent_version_id AND version.creator_id = invocation.creator_id
    LEFT JOIN public.context_snapshots AS snapshot
      ON snapshot.id = version.snapshot_id AND snapshot.creator_id = version.creator_id
    LEFT JOIN public.worker_leases AS lease
      ON lease.id = invocation.assignment_lease_id
     AND lease.deployment_id = conversation.deployment_id
     AND lease.creator_id = invocation.creator_id
     AND lease.worker_id = invocation.assigned_worker_id
     AND lease.fence = invocation.assignment_fence
    LEFT JOIN public.agent_invocation_events AS started
     ON started.invocation_id = invocation.id
     AND started.source = 'WORKER' AND started.event_type = 'invocation.started'
    LEFT JOIN public.broker_outbox AS start_command
      ON start_command.command_id = started.broker_command_id
     AND start_command.creator_id = event.creator_id
     AND start_command.consumer_subject_id = event.consumer_subject_id
     AND start_command.invocation_id = event.invocation_id
    LEFT JOIN public.agent_messages AS message
      ON message.id = invocation.result_message_id
     AND message.invocation_id = invocation.id AND message.role = 'ASSISTANT'
    LEFT JOIN public.creator_agent_succeeded_terminal_receipts AS receipt
      ON receipt.invocation_id = event.invocation_id
     AND receipt.creator_id = event.creator_id
     AND receipt.consumer_subject_id = event.consumer_subject_id
     AND receipt.terminal_event_id = event.id
    LEFT JOIN public.consumer_event_outbox AS outbox
      ON outbox.cursor = receipt.consumer_event_cursor
     AND outbox.owner_id = receipt.consumer_subject_id
     AND outbox.source_event_id = receipt.terminal_event_id
     AND outbox.invocation_id = event.invocation_id
     AND outbox.conversation_id = invocation.conversation_id
     AND outbox.event_type = 'invocation.terminal'
    LEFT JOIN public.consumer_event_streams AS stream
      ON stream.owner_id = event.consumer_subject_id
     AND stream.conversation_id = invocation.conversation_id
   WHERE event.source = 'WORKER' AND event.event_type = 'invocation.succeeded'
     AND (
       event.source_event_id = input_source_event_id::text
       OR event.invocation_id = input_invocation_id
     )
   ORDER BY (event.invocation_id = input_invocation_id) DESC, event.id
   LIMIT 1;
  IF FOUND THEN
    IF succeeded.source_event_id IS DISTINCT FROM succeeded.invocation_id::text
       OR succeeded.creator_id IS DISTINCT FROM succeeded.invocation_creator_id
       OR succeeded.consumer_subject_id IS DISTINCT FROM succeeded.invocation_consumer_subject_id
       OR succeeded.state IS DISTINCT FROM 'SUCCEEDED'
       OR succeeded.result_message_id IS NULL OR succeeded.result_digest IS NULL
       OR succeeded.result_digest !~ '^hmac-sha256:[a-f0-9]{64}$'
       OR succeeded.error_code IS NOT NULL OR succeeded.terminal_at IS NULL
       OR succeeded.occurred_at IS DISTINCT FROM succeeded.terminal_at
       OR succeeded.conversation_state IS DISTINCT FROM 'IDLE'
       OR succeeded.source_fact_digest IS NULL
       OR succeeded.source_local_result_cipher_digest IS NULL
       OR succeeded.broker_command_id IS NOT NULL
       OR succeeded.payload IS DISTINCT FROM pg_catalog.jsonb_build_object(
            'state', 'SUCCEEDED', 'messageId', succeeded.result_message_id,
            'resultDigest', succeeded.result_digest
          )
       OR succeeded.agent_version_id IS NULL OR succeeded.version_digest IS NULL
       OR succeeded.snapshot_id IS NULL OR succeeded.snapshot_digest IS NULL
       OR succeeded.assigned_worker_id IS NULL OR succeeded.assignment_lease_id IS NULL
       OR succeeded.assignment_fence IS NULL OR succeeded.execution_capability_id IS NULL
       OR succeeded.execution_capability_digest IS NULL
       OR succeeded.durable_lease_id IS NULL
       OR succeeded.durable_lease_worker_id IS DISTINCT FROM succeeded.assigned_worker_id
       OR succeeded.durable_lease_fence IS DISTINCT FROM succeeded.assignment_fence
       OR succeeded.started_fact_digest IS NULL
       OR succeeded.started_payload NOT IN (
            '{"state":"RUNNING"}'::jsonb, '{"state":"RECONCILING"}'::jsonb
          )
       OR succeeded.started_source_event_id IS DISTINCT FROM succeeded.started_command_id::text
       OR succeeded.started_dispatch_receipt_digest IS NULL
       OR succeeded.started_sandbox_attestation_digest IS NULL
       OR succeeded.started_command_type IS DISTINCT FROM 'invocation.start'
       OR succeeded.started_command_state NOT IN ('ACKED', 'EXPIRED')
       OR succeeded.started_command_attempt_count IS NULL
       OR succeeded.started_command_attempt_count < 1
       OR succeeded.started_command_worker_id IS DISTINCT FROM succeeded.assigned_worker_id
       OR succeeded.started_command_conversation_id IS DISTINCT FROM
            succeeded.conversation_id
       OR succeeded.started_command_deployment_id IS DISTINCT FROM succeeded.deployment_id
       OR succeeded.started_command_lease_id IS DISTINCT FROM succeeded.assignment_lease_id
       OR succeeded.started_command_fence IS DISTINCT FROM succeeded.assignment_fence
       OR succeeded.started_command_capability_id IS DISTINCT FROM
            succeeded.execution_capability_id
       OR succeeded.started_command_capability_digest IS DISTINCT FROM
            succeeded.execution_capability_digest
       OR succeeded.started_fact_digest IS DISTINCT FROM
            public.creator_agent_worker_started_fact_digest_v1(
              succeeded.started_command_id, succeeded.invocation_id,
              succeeded.version_digest, succeeded.snapshot_digest,
              succeeded.execution_capability_digest, succeeded.assignment_lease_id,
              succeeded.assignment_fence, succeeded.started_command_id,
              succeeded.runtime_thread_id, succeeded.runtime_turn_id,
              succeeded.started_dispatch_receipt_digest,
              succeeded.started_sandbox_attestation_digest
            )
       OR succeeded.message_id IS DISTINCT FROM succeeded.result_message_id
       OR succeeded.message_conversation_id IS DISTINCT FROM succeeded.conversation_id
       OR succeeded.message_creator_id IS DISTINCT FROM succeeded.creator_id
       OR succeeded.message_consumer_subject_id IS DISTINCT FROM succeeded.consumer_subject_id
       OR succeeded.message_invocation_id IS DISTINCT FROM succeeded.invocation_id
       OR succeeded.role IS DISTINCT FROM 'ASSISTANT'
       OR succeeded.client_message_id IS NOT NULL
       OR succeeded.content_algorithm IS DISTINCT FROM 'aes-256-gcm/v1'
       OR succeeded.content_key_id IS NULL
       OR length(succeeded.content_key_id) NOT BETWEEN 1 AND 256
       OR succeeded.content_key_id !~ '^[-A-Za-z0-9_.:/]+$'
       OR succeeded.content_nonce IS NULL OR octet_length(succeeded.content_nonce) <> 12
       OR succeeded.content_ciphertext IS NULL
       OR octet_length(succeeded.content_ciphertext) NOT BETWEEN 1 AND 65536
       OR succeeded.content_auth_tag IS NULL OR octet_length(succeeded.content_auth_tag) <> 16
       OR succeeded.content_aad_version IS DISTINCT FROM 1
       OR succeeded.content_digest !~ '^hmac-sha256:[a-f0-9]{64}$'
       OR succeeded.content_cipher_digest IS DISTINCT FROM pg_catalog.encode(
            public.digest(succeeded.content_nonce || succeeded.content_ciphertext ||
              succeeded.content_auth_tag, 'sha256'), 'hex'
          )
       OR succeeded.content_cipher_digest = succeeded.source_local_result_cipher_digest
       OR succeeded.content_digest = succeeded.result_digest
       OR succeeded.receipt_event_id IS DISTINCT FROM succeeded.id
       OR succeeded.receipt_message_id IS DISTINCT FROM succeeded.message_id
       OR succeeded.receipt_cursor IS NULL OR succeeded.latest_cursor IS NULL
       OR succeeded.latest_cursor < succeeded.receipt_cursor
       OR succeeded.source_fact_digest IS DISTINCT FROM
            public.creator_agent_worker_success_fact_digest_v1(
              succeeded.invocation_id, succeeded.invocation_id,
              succeeded.version_digest, succeeded.snapshot_digest,
              succeeded.execution_capability_digest, succeeded.assignment_lease_id,
              succeeded.assignment_fence, succeeded.source_local_result_cipher_digest,
              succeeded.result_digest, succeeded.runtime_thread_id,
              succeeded.runtime_turn_id, succeeded.started_fact_digest
            ) THEN
      RETURN QUERY SELECT 'INVARIANT_FAILED'::text, NULL::text, NULL::timestamptz,
        NULL::bigint, NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
        NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
      RETURN;
    END IF;
    occurred_at_text := pg_catalog.to_char(
      succeeded.terminal_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    );
    expected_payload_digest := public.creator_agent_success_consumer_payload_digest_v1(
      succeeded.message_id, succeeded.conversation_id, succeeded.invocation_id,
      succeeded.result_digest, occurred_at_text
    );
    expected_dedupe_key := public.creator_agent_success_consumer_dedupe_key_v1(
      succeeded.consumer_subject_id, succeeded.id
    );
    terminal_payload := pg_catalog.jsonb_build_object(
      'protocol', 'combo.consumer-event-outbox/1', 'schemaVersion', 1,
      'type', 'invocation.terminal', 'conversationId', succeeded.conversation_id::text,
      'invocationId', succeeded.invocation_id::text, 'terminalState', 'SUCCEEDED',
      'assistantMessageId', succeeded.message_id::text,
      'resultDigest', succeeded.result_digest, 'errorCode', NULL::text,
      'occurredAt', occurred_at_text
    );
    IF succeeded.receipt_payload_digest IS DISTINCT FROM expected_payload_digest
       OR succeeded.receipt_dedupe_key IS DISTINCT FROM expected_dedupe_key
       OR (
         succeeded.retained_cursor IS NOT NULL AND (
           succeeded.retained_cursor IS DISTINCT FROM succeeded.receipt_cursor
           OR succeeded.retained_payload IS DISTINCT FROM terminal_payload
           OR succeeded.retained_payload_digest IS DISTINCT FROM expected_payload_digest
           OR succeeded.retained_dedupe_key IS DISTINCT FROM expected_dedupe_key
         )
       )
       OR (
         succeeded.retained_cursor IS NULL AND (
           succeeded.expired_through_cursor IS NULL
           OR succeeded.expired_through_cursor < succeeded.receipt_cursor
         )
       ) THEN
      RETURN QUERY SELECT 'INVARIANT_FAILED'::text, NULL::text, NULL::timestamptz,
        NULL::bigint, NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
        NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
      RETURN;
    END IF;
    existing_fact := pg_catalog.jsonb_build_object(
      'protocol', 'combo.worker-invocation-fact/1', 'schemaVersion', 1,
      'type', 'invocation.succeeded', 'sourceEventId', succeeded.source_event_id,
      'invocationId', succeeded.invocation_id::text,
      'agentVersionDigest', succeeded.version_digest,
      'snapshotDigest', succeeded.snapshot_digest,
      'executionCapabilityDigest', succeeded.execution_capability_digest,
      'leaseId', succeeded.assignment_lease_id::text,
      'fence', succeeded.assignment_fence::text,
      'runtimeThreadId', succeeded.runtime_thread_id,
      'runtimeTurnId', succeeded.runtime_turn_id,
      'startedFactDigest', succeeded.started_fact_digest,
      'resultDigest', succeeded.result_digest,
      'localResultCipherDigest', succeeded.source_local_result_cipher_digest
    );
    source_digest := pg_catalog.encode(public.digest(pg_catalog.convert_to(
      pg_catalog.jsonb_build_object('domain', 'combo:vnext:worker-source-identity:v1',
        'source', 'WORKER', 'sourceEventId', input_source_event_id::text)::text,
      'UTF8'), 'sha256'), 'hex');
    existing_digest := pg_catalog.encode(public.digest(pg_catalog.convert_to(
      pg_catalog.jsonb_build_object(
        'domain', 'combo:vnext:full-stored-success-terminal-source-binding:v1',
        'protocol', 'combo.worker-invocation-fact/1', 'version', 1,
        'creatorId', succeeded.creator_id::text,
        'consumerId', succeeded.consumer_subject_id::text,
        'conversationId', succeeded.conversation_id::text,
        'invocationId', succeeded.invocation_id::text,
        'agentVersionId', succeeded.agent_version_id::text,
        'snapshotId', succeeded.snapshot_id::text,
        'deploymentId', succeeded.deployment_id::text,
        'installationId', succeeded.assigned_worker_id::text,
        'executionCapabilityId', succeeded.execution_capability_id::text,
        'source', 'WORKER', 'sourceEventId', succeeded.source_event_id,
        'eventType', 'invocation.succeeded', 'payload', succeeded.payload,
        'fact', existing_fact, 'factDigest', succeeded.source_fact_digest
      )::text, 'UTF8'), 'sha256'), 'hex');
    received_digest := pg_catalog.encode(public.digest(pg_catalog.convert_to(
      pg_catalog.jsonb_build_object(
        'domain', 'combo:vnext:worker-failed-event-identity:v1',
        'protocol', 'combo.worker-invocation-fact/1', 'version', 1,
        'creatorId', input_creator_id::text,
        'consumerId', incoming.consumer_subject_id::text,
        'conversationId', incoming.conversation_id::text,
        'invocationId', input_invocation_id::text,
        'agentVersionId', incoming.agent_version_id::text,
        'snapshotId', incoming.snapshot_id::text,
        'deploymentId', incoming.deployment_id::text,
        'installationId', input_installation_id::text,
        'executionCapabilityId', incoming.execution_capability_id::text,
        'source', 'WORKER', 'sourceEventId', input_source_event_id::text,
        'eventType', 'invocation.failed', 'payload', pg_catalog.jsonb_build_object(
          'state', 'FAILED', 'errorCode', input_error_code
        ),
        'fact', received_fact, 'factDigest', input_fact_digest
      )::text, 'UTF8'), 'sha256'), 'hex');
    INSERT INTO public.creator_agent_journal_integrity_alerts (
      invocation_id, creator_id, consumer_subject_id, reason, source,
      source_event_id_digest, existing_canonical_digest, received_canonical_digest,
      expected_journal_seq, received_journal_seq
    )
    VALUES (
      input_invocation_id, input_creator_id, incoming.consumer_subject_id,
      'SOURCE_EVENT_CONFLICT', 'WORKER', source_digest,
      existing_digest, received_digest, NULL, NULL
    )
    ON CONFLICT ON CONSTRAINT uq_creator_agent_journal_integrity_alert_dedupe DO NOTHING
    RETURNING id INTO durable_alert_id;
    replayed_value := durable_alert_id IS NULL;
    IF durable_alert_id IS NULL THEN
      SELECT alert.id INTO durable_alert_id
        FROM public.creator_agent_journal_integrity_alerts AS alert
       WHERE alert.invocation_id = input_invocation_id
         AND alert.reason = 'SOURCE_EVENT_CONFLICT' AND alert.source = 'WORKER'
         AND alert.source_event_id_digest = source_digest
         AND alert.existing_canonical_digest = existing_digest
         AND alert.received_canonical_digest = received_digest
         AND alert.expected_journal_seq IS NULL AND alert.received_journal_seq IS NULL;
    END IF;
    IF durable_alert_id IS NULL THEN
      RAISE EXCEPTION 'failed v2 alert dedupe invariant failed' USING ERRCODE = '55000';
    END IF;
    RETURN QUERY SELECT 'SECURITY_BLOCKED'::text, NULL::text, NULL::timestamptz,
      NULL::bigint, NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
      NULL::boolean, NULL::boolean, durable_alert_id, replayed_value;
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config('app.consumer_id', '', true);
  RETURN QUERY SELECT * FROM public.creator_agent_project_failed_fact_v1(
    input_creator_id, input_installation_id, input_protocol, input_schema_version,
    input_type, input_source_event_id, input_invocation_id,
    input_agent_version_digest, input_snapshot_digest,
    input_execution_capability_digest, input_lease_id, input_fence,
    input_error_code, input_fact_digest
  );
END;
$failed_v2$ LANGUAGE plpgsql;

REVOKE EXECUTE ON FUNCTION public.creator_agent_project_failed_fact_v1(
  uuid,uuid,text,integer,text,uuid,uuid,text,text,text,uuid,bigint,text,text
) FROM combo_agent_broker;
REVOKE ALL ON FUNCTION public.creator_agent_project_failed_fact_v2(
  uuid,uuid,text,integer,text,uuid,uuid,text,text,text,uuid,bigint,text,text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.creator_agent_project_failed_fact_v2(
  uuid,uuid,text,integer,text,uuid,uuid,text,text,text,uuid,bigint,text,text
) TO combo_agent_broker;

DO $failed_v2_owner_gate$
DECLARE trusted_owner boolean;
BEGIN
  SELECT procedure.prosecdef AND (role.rolsuper OR role.rolbypassrls)
    INTO trusted_owner
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS role ON role.oid = procedure.proowner
   WHERE procedure.oid =
     'public.creator_agent_project_failed_fact_v2(uuid,uuid,text,integer,text,uuid,uuid,text,text,text,uuid,bigint,text,text)'::regprocedure;
  IF trusted_owner IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Failed v2 admission requires a trusted SECURITY DEFINER owner'
      USING ERRCODE = '42501';
  END IF;
END;
$failed_v2_owner_gate$;
