-- 0029 · Database-owned confirmed invocation.cancelled terminal admission.
--
-- One Broker-only authority owns the cancelled projection, Worker Event, Consumer terminal payload,
-- Outbox cursor/digests, stream advancement, permanent low-sensitivity receipt, and Conversation
-- IDLE transition. No Assistant Message is created.

LOCK TABLE public.agent_invocations,
           public.agent_invocation_events,
           public.agent_conversations,
           public.consumer_event_outbox,
           public.consumer_event_streams,
           public.creator_agent_journal_integrity_alerts
  IN SHARE ROW EXCLUSIVE MODE;

DO $cancelled_fact_zero_legacy$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.agent_invocation_events AS event
     WHERE event.source = 'WORKER' AND event.event_type = 'invocation.cancelled'
  ) OR EXISTS (
    SELECT 1 FROM public.agent_invocations AS invocation
     WHERE invocation.state = 'CANCELLED'
  ) THEN
    RAISE EXCEPTION '0029 requires zero legacy confirmed Worker cancelled terminals'
      USING ERRCODE = '55000';
  END IF;
END;
$cancelled_fact_zero_legacy$;

CREATE TABLE public.creator_agent_cancelled_terminal_receipts (
  invocation_id          uuid        PRIMARY KEY,
  creator_id             uuid        NOT NULL,
  consumer_subject_id    uuid        NOT NULL,
  terminal_event_id      bigint      NOT NULL UNIQUE,
  consumer_event_cursor  bigint      NOT NULL UNIQUE CHECK (consumer_event_cursor >= 1),
  payload_digest         text        NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  dedupe_key             text        NOT NULL CHECK (dedupe_key ~ '^[a-f0-9]{64}$'),
  recorded_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_cancelled_terminal_receipt_invocation_tenant
    FOREIGN KEY (invocation_id, creator_id, consumer_subject_id)
    REFERENCES public.agent_invocations (id, creator_id, consumer_subject_id),
  CONSTRAINT fk_cancelled_terminal_receipt_event
    FOREIGN KEY (terminal_event_id, invocation_id)
    REFERENCES public.agent_invocation_events (id, invocation_id)
);

CREATE TRIGGER creator_agent_cancelled_terminal_receipts_immutable
BEFORE UPDATE OR DELETE ON public.creator_agent_cancelled_terminal_receipts
FOR EACH ROW EXECUTE FUNCTION public.reject_creator_agent_immutable_mutation();

CREATE TRIGGER creator_agent_cancelled_terminal_receipts_no_truncate
BEFORE TRUNCATE ON public.creator_agent_cancelled_terminal_receipts
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_creator_agent_immutable_mutation();

ALTER TABLE public.creator_agent_cancelled_terminal_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creator_agent_cancelled_terminal_receipts FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON public.creator_agent_cancelled_terminal_receipts FROM PUBLIC;
REVOKE ALL PRIVILEGES ON public.creator_agent_cancelled_terminal_receipts FROM
  combo_agent_api,
  combo_agent_broker,
  combo_agent_reconciler,
  combo_agent_maintenance,
  combo_agent_consumer_api;

CREATE OR REPLACE FUNCTION public.creator_agent_worker_cancelled_fact_digest_v1(
  input_source_event_id uuid,
  input_invocation_id uuid,
  input_agent_version_digest text,
  input_snapshot_digest text,
  input_execution_capability_digest text,
  input_lease_id uuid,
  input_fence bigint,
  input_interrupt_receipt_digest text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $failed_fact_digest$
  SELECT pg_catalog.encode(
    public.digest(
      pg_catalog.convert_to(
        '{"agentVersionDigest":' || pg_catalog.to_jsonb(input_agent_version_digest)::text ||
        ',"executionCapabilityDigest":' ||
          pg_catalog.to_jsonb(input_execution_capability_digest)::text ||
        ',"fence":' || pg_catalog.to_jsonb(input_fence::text)::text ||
        ',"interruptReceiptDigest":' ||
          pg_catalog.to_jsonb(input_interrupt_receipt_digest)::text ||
        ',"invocationId":' || pg_catalog.to_jsonb(input_invocation_id::text)::text ||
        ',"leaseId":' || pg_catalog.to_jsonb(input_lease_id::text)::text ||
        ',"protocol":"combo.worker-invocation-fact/1"' ||
        ',"schemaVersion":1' ||
        ',"snapshotDigest":' || pg_catalog.to_jsonb(input_snapshot_digest)::text ||
        ',"sourceEventId":' || pg_catalog.to_jsonb(input_source_event_id::text)::text ||
        ',"type":"invocation.cancelled"}',
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$failed_fact_digest$;

CREATE OR REPLACE FUNCTION public.creator_agent_cancelled_consumer_payload_digest_v1(
  input_conversation_id uuid,
  input_invocation_id uuid,
  input_occurred_at text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $failed_payload_digest$
  SELECT pg_catalog.encode(
    public.digest(
      pg_catalog.convert_to(
        '{"assistantMessageId":null' ||
        ',"conversationId":' || pg_catalog.to_jsonb(input_conversation_id::text)::text ||
        ',"errorCode":null' ||
        ',"invocationId":' || pg_catalog.to_jsonb(input_invocation_id::text)::text ||
        ',"occurredAt":' || pg_catalog.to_jsonb(input_occurred_at)::text ||
        ',"protocol":"combo.consumer-event-outbox/1"' ||
        ',"resultDigest":null' ||
        ',"schemaVersion":1' ||
        ',"terminalState":"CANCELLED"' ||
        ',"type":"invocation.terminal"}',
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$failed_payload_digest$;

CREATE OR REPLACE FUNCTION public.creator_agent_cancelled_consumer_dedupe_key_v1(
  input_owner_id uuid,
  input_source_event_id bigint
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $failed_dedupe_key$
  SELECT pg_catalog.encode(
    public.digest(
      pg_catalog.convert_to(
        '{"eventType":"invocation.terminal"' ||
        ',"ownerId":' || pg_catalog.to_jsonb(input_owner_id::text)::text ||
        ',"protocol":"combo.consumer-event-outbox/1"' ||
        ',"sourceEventId":' || pg_catalog.to_jsonb(input_source_event_id::text)::text || '}',
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$failed_dedupe_key$;

REVOKE ALL ON FUNCTION public.creator_agent_worker_cancelled_fact_digest_v1(
  uuid, uuid, text, text, text, uuid, bigint, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.creator_agent_cancelled_consumer_payload_digest_v1(
  uuid, uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.creator_agent_cancelled_consumer_dedupe_key_v1(uuid, bigint)
  FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.creator_agent_project_cancelled_fact_v1(
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
  input_interrupt_receipt_digest text,
  input_fact_digest text
)
RETURNS TABLE (
  outcome text,
  interrupt_receipt_digest text,
  terminal_at timestamptz,
  consumer_event_cursor bigint,
  invocation_cancelled boolean,
  cancelled_event_appended boolean,
  consumer_event_appended boolean,
  consumer_stream_advanced boolean,
  terminal_receipt_appended boolean,
  conversation_idled boolean,
  alert_id uuid,
  alert_replayed boolean
)
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $project_failed$
DECLARE
  session_is_untrusted boolean;
  incoming record;
  incoming_lease record;
  existing record;
  received_fact jsonb;
  existing_fact jsonb;
  received_identity jsonb;
  existing_identity jsonb;
  source_identity jsonb;
  source_identity_digest text;
  existing_identity_digest text;
  received_identity_digest text;
  recomputed_fact_digest text;
  existing_recomputed_digest text;
  durable_alert_id uuid;
  durable_alert_replayed boolean;
  terminal_event_id_value bigint;
  terminal_at_value timestamptz;
  terminal_occurred_at_text text;
  terminal_payload jsonb;
  payload_digest_value text;
  dedupe_key_value text;
  consumer_cursor_value bigint;
  race_retried boolean := false;
BEGIN
  SELECT role.rolsuper OR role.rolbypassrls
    INTO session_is_untrusted
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = session_user;
  IF session_user <> 'combo_agent_broker'
     OR COALESCE(session_is_untrusted, true) THEN
    RAISE EXCEPTION 'Cancelled fact admission requires exact Broker session authority'
      USING ERRCODE = '42501';
  END IF;
  IF input_creator_id IS DISTINCT FROM
       NULLIF(current_setting('app.creator_id', true), '')::uuid
     OR NULLIF(current_setting('app.consumer_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'Cancelled fact admission requires exact Creator and cleared Consumer context'
      USING ERRCODE = '42501';
  END IF;

  IF input_creator_id IS NULL OR input_installation_id IS NULL
     OR input_source_event_id IS NULL OR input_invocation_id IS NULL
     OR input_lease_id IS NULL OR input_agent_version_digest IS NULL
     OR input_snapshot_digest IS NULL OR input_execution_capability_digest IS NULL
     OR input_interrupt_receipt_digest IS NULL OR input_fact_digest IS NULL
     OR input_interrupt_receipt_digest !~ '^sha256:[a-f0-9]{64}$'
     OR input_protocol IS DISTINCT FROM 'combo.worker-invocation-fact/1'
     OR input_schema_version IS DISTINCT FROM 1
     OR input_type IS DISTINCT FROM 'invocation.cancelled'
     OR input_source_event_id IS DISTINCT FROM input_invocation_id
     OR input_source_event_id::text !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR input_lease_id::text !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR input_fence IS NULL OR input_fence < 1
     OR input_agent_version_digest !~ '^[a-f0-9]{64}$'
     OR input_snapshot_digest !~ '^[a-f0-9]{64}$'
     OR input_execution_capability_digest !~ '^[a-f0-9]{64}$'
     OR input_fact_digest !~ '^[a-f0-9]{64}$' THEN
    RETURN QUERY
      SELECT 'AUTHORITY_REJECTED'::text, NULL::text, NULL::timestamptz, NULL::bigint,
             NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
             NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
    RETURN;
  END IF;

  recomputed_fact_digest := public.creator_agent_worker_cancelled_fact_digest_v1(
    input_source_event_id, input_invocation_id, input_agent_version_digest,
    input_snapshot_digest, input_execution_capability_digest,
    input_lease_id, input_fence, input_interrupt_receipt_digest
  );
  IF recomputed_fact_digest IS DISTINCT FROM input_fact_digest THEN
    RETURN QUERY
      SELECT 'AUTHORITY_REJECTED'::text, NULL::text, NULL::timestamptz, NULL::bigint,
             NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
             NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'combo.creator-agent-worker-source/1:' || input_source_event_id::text,
      0
    )
  );

  SELECT invocation.id, invocation.conversation_id, invocation.creator_id,
         invocation.consumer_subject_id, invocation.agent_version_id,
         invocation.state, invocation.result_message_id, invocation.result_digest,
         invocation.error_code, invocation.terminal_at,
         invocation.assigned_worker_id, invocation.assignment_lease_id,
         invocation.assignment_fence, invocation.execution_capability_id,
         invocation.execution_capability_digest,
         invocation.execution_capability_expires_at,
         invocation.execution_capability_revoked_at,
         conversation.deployment_id, conversation.state AS conversation_state,
         version.version_digest AS agent_version_digest,
         snapshot.id AS snapshot_id, snapshot.snapshot_digest,
         EXISTS (
           SELECT 1
             FROM public.agent_invocation_events AS started
             JOIN public.broker_outbox AS start_command
               ON start_command.command_id = started.broker_command_id
              AND start_command.creator_id = started.creator_id
              AND start_command.invocation_id = started.invocation_id
              AND start_command.consumer_subject_id = started.consumer_subject_id
            WHERE started.invocation_id = invocation.id
              AND started.source = 'WORKER'
              AND started.event_type = 'invocation.started'
              AND started.creator_id = invocation.creator_id
              AND started.consumer_subject_id = invocation.consumer_subject_id
              AND started.source_fact_digest IS NOT NULL
              AND started.source_dispatch_receipt_digest IS NOT NULL
              AND started.source_sandbox_attestation_digest IS NOT NULL
              AND started.source_event_id = started.broker_command_id::text
              AND invocation.runtime_thread_id IS NOT NULL
              AND invocation.runtime_turn_id IS NOT NULL
              AND start_command.command_type = 'invocation.start'
              AND start_command.state IN ('ACKED', 'EXPIRED')
              AND start_command.target_worker_id = invocation.assigned_worker_id
              AND start_command.conversation_id = invocation.conversation_id
              AND start_command.deployment_id = conversation.deployment_id
              AND start_command.assignment_lease_id = invocation.assignment_lease_id
              AND start_command.assignment_fence = invocation.assignment_fence
              AND start_command.execution_capability_id = invocation.execution_capability_id
              AND start_command.execution_capability_digest =
                    invocation.execution_capability_digest
              AND started.source_fact_digest =
                    public.creator_agent_worker_started_fact_digest_v1(
                      started.source_event_id::uuid,
                      invocation.id,
                      version.version_digest,
                      snapshot.snapshot_digest,
                      invocation.execution_capability_digest,
                      invocation.assignment_lease_id,
                      invocation.assignment_fence,
                      started.broker_command_id,
                      invocation.runtime_thread_id,
                      invocation.runtime_turn_id,
                      started.source_dispatch_receipt_digest,
                      started.source_sandbox_attestation_digest
                    )
         ) AS has_durable_started_evidence
    INTO incoming
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
   WHERE invocation.id = input_invocation_id
     AND invocation.creator_id = input_creator_id
     AND invocation.assigned_worker_id = input_installation_id
   FOR UPDATE OF invocation, conversation;
  IF NOT FOUND THEN
    RETURN QUERY
      SELECT 'UNAVAILABLE'::text, NULL::text, NULL::timestamptz, NULL::bigint,
             NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
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
    'interruptReceiptDigest', input_interrupt_receipt_digest
  );
  source_identity := pg_catalog.jsonb_build_object(
    'domain', 'combo:vnext:worker-source-identity:v1',
    'protocol', 'combo.worker-invocation-fact/1', 'version', 1,
    'source', 'WORKER', 'sourceEventId', input_source_event_id::text
  );
  source_identity_digest := pg_catalog.encode(
    public.digest(pg_catalog.convert_to(source_identity::text, 'UTF8'), 'sha256'), 'hex'
  );

  <<classify_or_admit>>
  LOOP
    SELECT event.id, event.invocation_id, event.creator_id, event.consumer_subject_id,
           event.source_event_id, event.event_type, event.payload, event.occurred_at,
           event.source_fact_digest, event.broker_command_id,
           durable_invocation.conversation_id, durable_invocation.agent_version_id,
           durable_invocation.state AS invocation_state,
           durable_invocation.result_message_id, durable_invocation.result_digest,
           durable_invocation.error_code, durable_invocation.terminal_at,
           durable_invocation.assigned_worker_id, durable_invocation.assignment_lease_id,
           durable_invocation.assignment_fence, durable_invocation.execution_capability_id,
           durable_invocation.execution_capability_digest,
           durable_conversation.state AS conversation_state,
           durable_conversation.deployment_id,
           durable_version.version_digest AS agent_version_digest,
           durable_snapshot.id AS snapshot_id, durable_snapshot.snapshot_digest,
           durable_lease.id AS lease_id, durable_lease.worker_id AS lease_worker_id,
           durable_lease.fence AS lease_fence,
           receipt.terminal_event_id, receipt.consumer_event_cursor AS receipt_cursor,
           receipt.payload_digest AS receipt_payload_digest,
           receipt.dedupe_key AS receipt_dedupe_key,
           terminal_outbox.cursor AS retained_cursor,
           terminal_outbox.payload AS retained_payload,
           terminal_outbox.payload_digest AS retained_payload_digest,
           terminal_outbox.dedupe_key AS retained_dedupe_key,
           terminal_stream.latest_cursor,
           terminal_stream.expired_through_cursor
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
      LEFT JOIN public.creator_agent_cancelled_terminal_receipts AS receipt
        ON receipt.invocation_id = event.invocation_id
       AND receipt.creator_id = event.creator_id
       AND receipt.consumer_subject_id = event.consumer_subject_id
       AND receipt.terminal_event_id = event.id
      LEFT JOIN public.consumer_event_outbox AS terminal_outbox
        ON terminal_outbox.cursor = receipt.consumer_event_cursor
       AND terminal_outbox.owner_id = receipt.consumer_subject_id
       AND terminal_outbox.source_event_id = receipt.terminal_event_id
       AND terminal_outbox.invocation_id = event.invocation_id
       AND terminal_outbox.conversation_id = durable_invocation.conversation_id
       AND terminal_outbox.event_type = 'invocation.terminal'
      LEFT JOIN public.consumer_event_streams AS terminal_stream
        ON terminal_stream.owner_id = event.consumer_subject_id
       AND terminal_stream.conversation_id = durable_invocation.conversation_id
     WHERE event.source = 'WORKER'
       AND (
         event.source_event_id = input_source_event_id::text
         OR (
           event.invocation_id = input_invocation_id
           AND event.event_type IN (
             'invocation.succeeded', 'invocation.cancelled', 'invocation.cancelled',
             'invocation.uncertain', 'invocation.expired'
           )
         )
       )
     ORDER BY (event.invocation_id = input_invocation_id) DESC, event.id
     LIMIT 1;

    IF FOUND THEN
      IF existing.event_type = 'invocation.cancelled' THEN
        IF existing.source_event_id IS DISTINCT FROM existing.invocation_id::text
           OR existing.broker_command_id IS NOT NULL
           OR existing.source_fact_digest IS NULL
           OR existing.payload IS DISTINCT FROM pg_catalog.jsonb_build_object(
             'state', 'CANCELLED'
           )
           OR existing.invocation_state IS DISTINCT FROM 'CANCELLED'
           OR existing.result_message_id IS NOT NULL OR existing.result_digest IS NOT NULL
           OR existing.error_code IS NOT NULL
           OR existing.terminal_at IS NULL
           OR existing.occurred_at IS DISTINCT FROM existing.terminal_at
           OR existing.conversation_state IS DISTINCT FROM 'IDLE'
           OR existing.agent_version_id IS NULL OR existing.agent_version_digest IS NULL
           OR existing.snapshot_id IS NULL OR existing.snapshot_digest IS NULL
           OR existing.assigned_worker_id IS NULL OR existing.assignment_lease_id IS NULL
           OR existing.assignment_fence IS NULL OR existing.execution_capability_id IS NULL
           OR existing.execution_capability_digest IS NULL OR existing.lease_id IS NULL
           OR existing.lease_worker_id IS DISTINCT FROM existing.assigned_worker_id
           OR existing.lease_fence IS DISTINCT FROM existing.assignment_fence
           OR existing.terminal_event_id IS DISTINCT FROM existing.id
           OR existing.receipt_cursor IS NULL
           OR existing.latest_cursor IS NULL
           OR existing.latest_cursor < existing.receipt_cursor THEN
          RETURN QUERY
            SELECT 'INVARIANT_FAILED'::text, NULL::text, NULL::timestamptz, NULL::bigint,
                   NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
                   NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
          RETURN;
        END IF;

        -- interruptReceiptDigest is covered by the canonical Worker fact digest only; the
        -- stored source_fact_digest must equal the received canonical digest for an EXACT replay.
        terminal_occurred_at_text := pg_catalog.to_char(
          existing.terminal_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        );
        payload_digest_value := public.creator_agent_cancelled_consumer_payload_digest_v1(
          existing.conversation_id, existing.invocation_id, terminal_occurred_at_text
        );
        dedupe_key_value := public.creator_agent_cancelled_consumer_dedupe_key_v1(
          existing.consumer_subject_id, existing.id
        );
        IF existing.source_fact_digest IS DISTINCT FROM input_fact_digest
           OR existing.receipt_payload_digest IS DISTINCT FROM payload_digest_value
           OR existing.receipt_dedupe_key IS DISTINCT FROM dedupe_key_value THEN
          RETURN QUERY
            SELECT 'INVARIANT_FAILED'::text, NULL::text, NULL::timestamptz, NULL::bigint,
                   NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
                   NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
          RETURN;
        END IF;

        terminal_payload := pg_catalog.jsonb_build_object(
          'protocol', 'combo.consumer-event-outbox/1', 'schemaVersion', 1,
          'type', 'invocation.terminal', 'conversationId', existing.conversation_id::text,
          'invocationId', existing.invocation_id::text, 'terminalState', 'CANCELLED',
          'assistantMessageId', NULL::text, 'resultDigest', NULL::text,
          'errorCode', NULL::text, 'occurredAt', terminal_occurred_at_text
        );
        IF existing.retained_cursor IS NOT NULL THEN
          IF existing.retained_cursor IS DISTINCT FROM existing.receipt_cursor
             OR existing.retained_payload IS DISTINCT FROM terminal_payload
             OR existing.retained_payload_digest IS DISTINCT FROM payload_digest_value
             OR existing.retained_dedupe_key IS DISTINCT FROM dedupe_key_value THEN
            RETURN QUERY
              SELECT 'INVARIANT_FAILED'::text, NULL::text, NULL::timestamptz, NULL::bigint,
                     NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
                     NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
            RETURN;
          END IF;
          consumer_cursor_value := existing.retained_cursor;
        ELSE
          IF existing.expired_through_cursor IS NULL
             OR existing.expired_through_cursor < existing.receipt_cursor THEN
            RETURN QUERY
              SELECT 'INVARIANT_FAILED'::text, NULL::text, NULL::timestamptz, NULL::bigint,
                     NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
                     NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
            RETURN;
          END IF;
          consumer_cursor_value := NULL;
        END IF;

        RETURN QUERY
          SELECT 'EXACT'::text, input_interrupt_receipt_digest,
                 existing.terminal_at, consumer_cursor_value,
                 false, false, false, false, false, false, NULL::uuid, NULL::boolean;
        RETURN;
      ELSIF existing.event_type = 'invocation.succeeded'
         AND existing.source_event_id = existing.invocation_id::text
         AND existing.source_fact_digest ~ '^[a-f0-9]{64}$'
         AND existing.broker_command_id IS NULL
         AND existing.payload->>'state' = 'SUCCEEDED'
         AND existing.invocation_state = 'SUCCEEDED'
         AND existing.result_message_id IS NOT NULL
         AND existing.result_digest IS NOT NULL
         AND existing.terminal_at IS NOT NULL
         AND date_trunc('milliseconds', existing.occurred_at) =
               date_trunc('milliseconds', existing.terminal_at)
         AND existing.conversation_state = 'IDLE' THEN
        existing_identity := pg_catalog.jsonb_build_object(
          'domain', 'combo:vnext:generic-stored-terminal-source-binding:v1',
          'creatorId', existing.creator_id::text,
          'consumerId', existing.consumer_subject_id::text,
          'invocationId', existing.invocation_id::text,
          'source', 'WORKER', 'sourceEventId', existing.source_event_id,
          'eventType', existing.event_type, 'payload', existing.payload,
          'opaqueFactDigest', existing.source_fact_digest
        );
        received_identity := pg_catalog.jsonb_build_object(
          'domain', 'combo:vnext:worker-cancelled-event-identity:v1',
          'creatorId', input_creator_id::text,
          'consumerId', incoming.consumer_subject_id::text,
          'invocationId', input_invocation_id::text,
          'source', 'WORKER', 'sourceEventId', input_source_event_id::text,
          'eventType', 'invocation.cancelled', 'fact', received_fact,
          'factDigest', input_fact_digest
        );
      ELSE
        RETURN QUERY
          SELECT 'INVARIANT_FAILED'::text, NULL::text, NULL::timestamptz, NULL::bigint,
                 NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
                 NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
        RETURN;
      END IF;

      existing_identity_digest := pg_catalog.encode(
        public.digest(pg_catalog.convert_to(existing_identity::text, 'UTF8'), 'sha256'), 'hex'
      );
      received_identity_digest := pg_catalog.encode(
        public.digest(pg_catalog.convert_to(received_identity::text, 'UTF8'), 'sha256'), 'hex'
      );
      INSERT INTO public.creator_agent_journal_integrity_alerts (
        invocation_id, creator_id, consumer_subject_id, reason, source,
        source_event_id_digest, existing_canonical_digest, received_canonical_digest,
        expected_journal_seq, received_journal_seq
      ) VALUES (
        input_invocation_id, input_creator_id, incoming.consumer_subject_id,
        'SOURCE_EVENT_CONFLICT', 'WORKER', source_identity_digest,
        existing_identity_digest, received_identity_digest, NULL, NULL
      )
      ON CONFLICT ON CONSTRAINT uq_creator_agent_journal_integrity_alert_dedupe DO NOTHING
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
      ELSE
        durable_alert_replayed := false;
      END IF;
      IF durable_alert_id IS NULL THEN
        RAISE EXCEPTION 'Failed fact alert dedupe invariant failed' USING ERRCODE = '55000';
      END IF;
      RETURN QUERY
        SELECT 'SECURITY_BLOCKED'::text, NULL::text, NULL::timestamptz, NULL::bigint,
               NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
               NULL::boolean, NULL::boolean, durable_alert_id, durable_alert_replayed;
      RETURN;
    END IF;

    IF race_retried THEN
      RETURN QUERY
        SELECT 'INVARIANT_FAILED'::text, NULL::text, NULL::timestamptz, NULL::bigint,
               NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
               NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
      RETURN;
    END IF;
    IF incoming.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN', 'EXPIRED') THEN
      RETURN QUERY
        SELECT 'TERMINAL'::text, NULL::text, NULL::timestamptz, NULL::bigint,
               NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
               NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
      RETURN;
    END IF;
    IF incoming.state NOT IN ('RUNNING', 'CANCEL_REQUESTED', 'RECONCILING')
       OR incoming.conversation_state <> 'BUSY'
       OR incoming.result_message_id IS NOT NULL OR incoming.result_digest IS NOT NULL
       OR incoming.error_code IS NOT NULL
       OR incoming.agent_version_digest IS DISTINCT FROM input_agent_version_digest
       OR incoming.snapshot_digest IS DISTINCT FROM input_snapshot_digest
       OR incoming.assignment_lease_id IS DISTINCT FROM input_lease_id
       OR incoming.assignment_fence IS DISTINCT FROM input_fence
       OR incoming.execution_capability_id IS NULL
       OR incoming.execution_capability_digest IS DISTINCT FROM input_execution_capability_digest
       OR incoming.execution_capability_expires_at IS NULL
       OR incoming.execution_capability_expires_at <= clock_timestamp()
       OR incoming.execution_capability_revoked_at IS NOT NULL THEN
      RETURN QUERY
        SELECT 'AUTHORITY_REJECTED'::text, NULL::text, NULL::timestamptz, NULL::bigint,
               NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
               NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
      RETURN;
    END IF;

    SELECT lease.id, lease.state, lease.expires_at, lease.worker_id, lease.fence
      INTO incoming_lease
      FROM public.worker_leases AS lease
     WHERE lease.id = input_lease_id
       AND lease.deployment_id = incoming.deployment_id
       AND lease.creator_id = input_creator_id
       AND lease.worker_id = input_installation_id
       AND lease.fence = input_fence
     FOR UPDATE;
    IF NOT FOUND OR NOT (
      (incoming_lease.state = 'ACTIVE' AND incoming_lease.expires_at > clock_timestamp())
      OR incoming.has_durable_started_evidence
    ) THEN
      RETURN QUERY
        SELECT 'AUTHORITY_REJECTED'::text, NULL::text, NULL::timestamptz, NULL::bigint,
               NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
               NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
      RETURN;
    END IF;

    BEGIN
      terminal_at_value := date_trunc('milliseconds', clock_timestamp());
      UPDATE public.agent_invocations AS invocation
         SET state = 'CANCELLED', result_message_id = NULL, result_digest = NULL,
             error_code = NULL, uncertainty_reason = NULL,
             terminal_at = terminal_at_value
       WHERE invocation.id = input_invocation_id
         AND invocation.creator_id = input_creator_id
         AND invocation.consumer_subject_id = incoming.consumer_subject_id
         AND invocation.state IN ('RUNNING', 'CANCEL_REQUESTED', 'RECONCILING')
         AND invocation.assigned_worker_id = input_installation_id
         AND invocation.assignment_lease_id = input_lease_id
         AND invocation.assignment_fence = input_fence
         AND invocation.execution_capability_id = incoming.execution_capability_id
         AND invocation.execution_capability_digest = input_execution_capability_digest
         AND invocation.execution_capability_expires_at > clock_timestamp()
         AND invocation.execution_capability_revoked_at IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'cancelled projection changed unexpectedly' USING ERRCODE = '55000';
      END IF;

      INSERT INTO public.agent_invocation_events (
        invocation_id, creator_id, consumer_subject_id, journal_seq, source,
        source_event_id, event_type, payload, occurred_at,
        source_fact_digest, broker_command_id
      )
      SELECT input_invocation_id, input_creator_id, incoming.consumer_subject_id,
             COALESCE(max(event.journal_seq), 0) + 1, 'WORKER',
             input_source_event_id::text, 'invocation.cancelled',
             pg_catalog.jsonb_build_object('state', 'CANCELLED'),
             terminal_at_value, input_fact_digest, NULL
        FROM public.agent_invocation_events AS event
       WHERE event.invocation_id = input_invocation_id
      RETURNING id INTO terminal_event_id_value;

      terminal_occurred_at_text := pg_catalog.to_char(
        terminal_at_value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      );
      terminal_payload := pg_catalog.jsonb_build_object(
        'protocol', 'combo.consumer-event-outbox/1', 'schemaVersion', 1,
        'type', 'invocation.terminal', 'conversationId', incoming.conversation_id::text,
        'invocationId', input_invocation_id::text, 'terminalState', 'CANCELLED',
        'assistantMessageId', NULL::text, 'resultDigest', NULL::text,
        'errorCode', NULL::text, 'occurredAt', terminal_occurred_at_text
      );
      payload_digest_value := public.creator_agent_cancelled_consumer_payload_digest_v1(
        incoming.conversation_id, input_invocation_id, terminal_occurred_at_text
      );
      dedupe_key_value := public.creator_agent_cancelled_consumer_dedupe_key_v1(
        incoming.consumer_subject_id, terminal_event_id_value
      );

      INSERT INTO public.consumer_event_outbox (
        owner_id, conversation_id, invocation_id, source_event_id,
        event_type, payload, payload_digest, dedupe_key
      ) VALUES (
        incoming.consumer_subject_id, incoming.conversation_id, input_invocation_id,
        terminal_event_id_value, 'invocation.terminal', terminal_payload,
        payload_digest_value, dedupe_key_value
      ) RETURNING cursor INTO consumer_cursor_value;

      INSERT INTO public.consumer_event_streams (
        owner_id, conversation_id, latest_cursor, expired_through_cursor, updated_at
      ) VALUES (
        incoming.consumer_subject_id, incoming.conversation_id,
        consumer_cursor_value, 0, clock_timestamp()
      )
      ON CONFLICT (owner_id, conversation_id) DO UPDATE
        SET latest_cursor = GREATEST(
              consumer_event_streams.latest_cursor,
              EXCLUDED.latest_cursor
            ),
            updated_at = clock_timestamp();

      INSERT INTO public.creator_agent_cancelled_terminal_receipts (
        invocation_id, creator_id, consumer_subject_id, terminal_event_id,
        consumer_event_cursor, payload_digest, dedupe_key
      ) VALUES (
        input_invocation_id, input_creator_id, incoming.consumer_subject_id,
        terminal_event_id_value, consumer_cursor_value,
        payload_digest_value, dedupe_key_value
      );

      UPDATE public.agent_conversations AS conversation
         SET state = 'IDLE', last_activity_at = clock_timestamp()
       WHERE conversation.id = incoming.conversation_id
         AND conversation.creator_id = input_creator_id
         AND conversation.consumer_subject_id = incoming.consumer_subject_id
         AND conversation.state = 'BUSY';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'cancelled Conversation did not return to IDLE' USING ERRCODE = '55000';
      END IF;
    EXCEPTION WHEN unique_violation THEN
      race_retried := true;
    END;

    IF race_retried THEN CONTINUE classify_or_admit; END IF;
    RETURN QUERY
      SELECT 'ADMITTED'::text, input_interrupt_receipt_digest, terminal_at_value,
             consumer_cursor_value, true, true, true, true, true, true,
             NULL::uuid, NULL::boolean;
    RETURN;
  END LOOP classify_or_admit;
END;
$project_failed$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.creator_agent_project_cancelled_fact_v1(
  uuid, uuid, text, integer, text, uuid, uuid, text, text, text,
  uuid, bigint, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.creator_agent_project_cancelled_fact_v1(
  uuid, uuid, text, integer, text, uuid, uuid, text, text, text,
  uuid, bigint, text, text
) TO combo_agent_broker;

DO $failed_admission_owner_gate$
DECLARE trusted_owner boolean;
BEGIN
  SELECT procedure.prosecdef AND (role.rolsuper OR role.rolbypassrls)
    INTO trusted_owner
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS role ON role.oid = procedure.proowner
   WHERE procedure.oid =
     'public.creator_agent_project_cancelled_fact_v1(uuid,uuid,text,integer,text,uuid,uuid,text,text,text,uuid,bigint,text,text)'::regprocedure;
  IF trusted_owner IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Cancelled fact admission requires a trusted SECURITY DEFINER owner'
      USING ERRCODE = '42501';
  END IF;
END;
$failed_admission_owner_gate$;

CREATE OR REPLACE FUNCTION public.enforce_creator_agent_worker_invocation_fact()
RETURNS trigger AS $worker_fact_authority$
DECLARE
  bound_command_type text;
  privileged_session boolean;
  phase_admission_owner name;
BEGIN
  IF NEW.source = 'WORKER'
     AND NEW.event_type IN ('invocation.persisted', 'invocation.started') THEN
    IF NEW.source_fact_digest IS NULL OR NEW.broker_command_id IS NULL THEN
      RAISE EXCEPTION 'Worker Invocation lifecycle fact requires digest and exact command'
        USING ERRCODE = '23514';
    END IF;
    SELECT command_type INTO bound_command_type FROM public.broker_outbox
     WHERE command_id = NEW.broker_command_id AND creator_id = NEW.creator_id
       AND invocation_id = NEW.invocation_id
       AND consumer_subject_id = NEW.consumer_subject_id;
    IF NOT FOUND OR NEW.source_event_id <> NEW.broker_command_id::text
       OR bound_command_type <> (
         CASE NEW.event_type
           WHEN 'invocation.persisted' THEN 'invocation.prepare'
           WHEN 'invocation.started' THEN 'invocation.start'
         END
       ) THEN
      RAISE EXCEPTION 'Worker Invocation lifecycle source identity must bind the exact phase command'
        USING ERRCODE = '23514';
    END IF;
    SELECT role.rolsuper OR role.rolbypassrls INTO privileged_session
      FROM pg_catalog.pg_roles AS role WHERE role.rolname = session_user;
    IF NOT COALESCE(privileged_session, false) THEN
      IF NEW.event_type = 'invocation.persisted' THEN
        SELECT role.rolname INTO phase_admission_owner
          FROM pg_catalog.pg_proc AS procedure
          JOIN pg_catalog.pg_roles AS role ON role.oid = procedure.proowner
         WHERE procedure.oid =
           'public.creator_agent_project_prepared_fact_v1(uuid,uuid,text,integer,text,uuid,uuid,text,text,text,uuid,bigint,text,uuid,text)'::regprocedure;
      ELSE
        SELECT role.rolname INTO phase_admission_owner
          FROM pg_catalog.pg_proc AS procedure
          JOIN pg_catalog.pg_roles AS role ON role.oid = procedure.proowner
         WHERE procedure.oid =
           'public.creator_agent_project_started_fact_v1(uuid,uuid,text,integer,text,uuid,uuid,text,text,text,uuid,bigint,uuid,text,text,text,text,text)'::regprocedure;
      END IF;
      IF session_user <> 'combo_agent_broker' OR current_user = session_user
         OR current_user IS DISTINCT FROM phase_admission_owner THEN
        RAISE EXCEPTION 'Worker phase Event requires database admission authority'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  ELSIF NEW.source = 'WORKER'
        AND NEW.event_type IN ('invocation.succeeded', 'invocation.cancelled') THEN
    IF NEW.source_fact_digest IS NULL OR NEW.broker_command_id IS NOT NULL
       OR NEW.source_event_id <> NEW.invocation_id::text THEN
      RAISE EXCEPTION 'Worker Invocation terminal fact requires digest without a command'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.event_type = 'invocation.cancelled' THEN
      IF NEW.payload->>'state' IS DISTINCT FROM 'CANCELLED' THEN
        RAISE EXCEPTION 'Worker Invocation cancelled fact requires the CANCELLED terminal state'
          USING ERRCODE = '23514';
      END IF;
      SELECT role.rolsuper OR role.rolbypassrls INTO privileged_session
        FROM pg_catalog.pg_roles AS role WHERE role.rolname = session_user;
      IF NOT COALESCE(privileged_session, false) THEN
        SELECT role.rolname INTO phase_admission_owner
          FROM pg_catalog.pg_proc AS procedure
          JOIN pg_catalog.pg_roles AS role ON role.oid = procedure.proowner
         WHERE procedure.oid =
           'public.creator_agent_project_cancelled_fact_v1(uuid,uuid,text,integer,text,uuid,uuid,text,text,text,uuid,bigint,text,text)'::regprocedure;
        IF session_user <> 'combo_agent_broker' OR current_user = session_user
           OR current_user IS DISTINCT FROM phase_admission_owner THEN
          RAISE EXCEPTION 'invocation.cancelled requires cancelled fact admission authority'
            USING ERRCODE = '42501';
        END IF;
      END IF;
    END IF;
  ELSIF NEW.source_fact_digest IS NOT NULL OR NEW.broker_command_id IS NOT NULL THEN
    RAISE EXCEPTION 'fact digest and command are reserved for Worker Invocation lifecycle facts'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$worker_fact_authority$ LANGUAGE plpgsql
  SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_worker_invocation_fact() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_creator_agent_worker_invocation_fact()
  TO combo_agent_broker, combo_agent_reconciler;

CREATE OR REPLACE FUNCTION public.enforce_creator_agent_cancelled_consumer_outbox_insert()
RETURNS trigger AS $failed_outbox_authority$
DECLARE
  privileged_session boolean;
  admission_owner name;
  is_cancelled_terminal boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.agent_invocation_events AS event
     WHERE event.id = NEW.source_event_id AND event.invocation_id = NEW.invocation_id
       AND event.source = 'WORKER' AND event.event_type = 'invocation.cancelled'
  ) INTO is_cancelled_terminal;
  IF NOT is_cancelled_terminal THEN RETURN NEW; END IF;

  SELECT role.rolsuper OR role.rolbypassrls INTO privileged_session
    FROM pg_catalog.pg_roles AS role WHERE role.rolname = session_user;
  IF COALESCE(privileged_session, false) THEN RETURN NEW; END IF;
  SELECT role.rolname INTO admission_owner
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS role ON role.oid = procedure.proowner
   WHERE procedure.oid =
     'public.creator_agent_project_cancelled_fact_v1(uuid,uuid,text,integer,text,uuid,uuid,text,text,text,uuid,bigint,text,text)'::regprocedure;
  IF session_user <> 'combo_agent_broker' OR current_user = session_user
     OR current_user IS DISTINCT FROM admission_owner THEN
    RAISE EXCEPTION 'cancelled Consumer terminal requires cancelled fact admission authority'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$failed_outbox_authority$ LANGUAGE plpgsql
  SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_cancelled_consumer_outbox_insert() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_creator_agent_cancelled_consumer_outbox_insert()
  TO combo_agent_broker, combo_agent_reconciler;

CREATE TRIGGER consumer_event_outbox_cancelled_insert_authority
BEFORE INSERT ON public.consumer_event_outbox
FOR EACH ROW EXECUTE FUNCTION public.enforce_creator_agent_cancelled_consumer_outbox_insert();

CREATE OR REPLACE FUNCTION public.enforce_creator_agent_confirmed_cancelled_companion()
RETURNS trigger AS $failed_companion$
DECLARE exact_chain boolean;
BEGIN
  IF NEW.state <> 'CANCELLED' OR NEW.error_code IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT EXISTS (
    SELECT 1
      FROM public.agent_invocation_events AS event
      JOIN public.creator_agent_cancelled_terminal_receipts AS receipt
        ON receipt.invocation_id = NEW.id
       AND receipt.creator_id = NEW.creator_id
       AND receipt.consumer_subject_id = NEW.consumer_subject_id
       AND receipt.terminal_event_id = event.id
      JOIN public.consumer_event_outbox AS outbox
        ON outbox.cursor = receipt.consumer_event_cursor
       AND outbox.owner_id = receipt.consumer_subject_id
       AND outbox.source_event_id = receipt.terminal_event_id
      JOIN public.consumer_event_streams AS stream
        ON stream.owner_id = receipt.consumer_subject_id
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
       AND event.source = 'WORKER' AND event.event_type = 'invocation.cancelled'
       AND event.source_event_id = NEW.id::text
       AND event.source_fact_digest IS NOT NULL AND event.broker_command_id IS NULL
       AND event.payload = pg_catalog.jsonb_build_object('state', 'CANCELLED')
       AND event.occurred_at = NEW.terminal_at
       AND receipt.payload_digest = outbox.payload_digest
       AND receipt.dedupe_key = outbox.dedupe_key
  ) INTO exact_chain;
  IF exact_chain IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'confirmed CANCELLED projection requires exact terminal chain'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$failed_companion$ LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_confirmed_cancelled_companion() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_creator_agent_confirmed_cancelled_companion()
  TO combo_agent_broker, combo_agent_reconciler;

CREATE CONSTRAINT TRIGGER agent_invocations_confirmed_cancelled_companion
AFTER UPDATE OF state, error_code, terminal_at ON public.agent_invocations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_creator_agent_confirmed_cancelled_companion();

DO $failed_companion_owner_gate$
DECLARE trusted_owner boolean;
BEGIN
  SELECT procedure.prosecdef AND (role.rolsuper OR role.rolbypassrls)
    INTO trusted_owner
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS role ON role.oid = procedure.proowner
   WHERE procedure.oid =
     'public.enforce_creator_agent_confirmed_cancelled_companion()'::regprocedure;
  IF trusted_owner IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Cancelled companion requires a trusted SECURITY DEFINER owner'
      USING ERRCODE = '42501';
  END IF;
END;
$failed_companion_owner_gate$;
