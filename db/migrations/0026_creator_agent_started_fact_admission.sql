-- 0026 · Database-owned invocation.started Worker fact admission.
--
-- Unlike prepared admission, a started fact's Event payload is decided by the same Cloud-time
-- authority checks which may create a late reconciliation root. Projection, Event, optional root,
-- and start-command acknowledgement therefore move into one Broker-only database authority.

LOCK TABLE public.agent_invocations,
           public.agent_invocation_events,
           public.broker_outbox,
           public.creator_agent_journal_integrity_alerts
  IN SHARE ROW EXCLUSIVE MODE;

-- Legacy started rows contain only an aggregate fact digest. The dispatch receipt and sandbox
-- attestation digests cannot be recovered or guessed, so this cutover is intentionally zero-row.
DO $started_fact_zero_legacy$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.agent_invocation_events AS event
     WHERE event.source = 'WORKER'
       AND event.event_type = 'invocation.started'
  ) THEN
    RAISE EXCEPTION '0026 cannot reconstruct legacy Worker started fact components'
      USING ERRCODE = '55000';
  END IF;
END;
$started_fact_zero_legacy$;

ALTER TABLE public.agent_invocation_events
  ADD COLUMN source_dispatch_receipt_digest text
    CHECK (
      source_dispatch_receipt_digest IS NULL
      OR source_dispatch_receipt_digest ~ '^sha256:[a-f0-9]{64}$'
    ),
  ADD COLUMN source_sandbox_attestation_digest text
    CHECK (
      source_sandbox_attestation_digest IS NULL
      OR source_sandbox_attestation_digest ~ '^sha256:[a-f0-9]{64}$'
    ),
  ADD CONSTRAINT ck_agent_invocation_events_started_fact_components CHECK (
    CASE
      WHEN source = 'WORKER' AND event_type = 'invocation.started' THEN
        source_dispatch_receipt_digest IS NOT NULL
        AND source_sandbox_attestation_digest IS NOT NULL
      ELSE
        source_dispatch_receipt_digest IS NULL
        AND source_sandbox_attestation_digest IS NULL
    END
  );

-- Exact RFC 8785 bytes for combo.worker-invocation-fact/1 invocation.started. Dynamic values are
-- JSON strings; the ASCII keys below are frozen in JCS order.
CREATE OR REPLACE FUNCTION public.creator_agent_worker_started_fact_digest_v1(
  input_source_event_id uuid,
  input_invocation_id uuid,
  input_agent_version_digest text,
  input_snapshot_digest text,
  input_execution_capability_digest text,
  input_lease_id uuid,
  input_fence bigint,
  input_start_command_id uuid,
  input_runtime_thread_id text,
  input_runtime_turn_id text,
  input_dispatch_receipt_digest text,
  input_sandbox_attestation_digest text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $started_fact_digest$
  SELECT pg_catalog.encode(
    public.digest(
      pg_catalog.convert_to(
        '{"agentVersionDigest":' || pg_catalog.to_jsonb(input_agent_version_digest)::text ||
        ',"dispatchReceiptDigest":' || pg_catalog.to_jsonb(input_dispatch_receipt_digest)::text ||
        ',"executionCapabilityDigest":' ||
          pg_catalog.to_jsonb(input_execution_capability_digest)::text ||
        ',"fence":' || pg_catalog.to_jsonb(input_fence::text)::text ||
        ',"invocationId":' || pg_catalog.to_jsonb(input_invocation_id::text)::text ||
        ',"leaseId":' || pg_catalog.to_jsonb(input_lease_id::text)::text ||
        ',"protocol":"combo.worker-invocation-fact/1"' ||
        ',"runtimeThreadId":' || pg_catalog.to_jsonb(input_runtime_thread_id)::text ||
        ',"runtimeTurnId":' || pg_catalog.to_jsonb(input_runtime_turn_id)::text ||
        ',"sandboxAttestationDigest":' ||
          pg_catalog.to_jsonb(input_sandbox_attestation_digest)::text ||
        ',"schemaVersion":1' ||
        ',"snapshotDigest":' || pg_catalog.to_jsonb(input_snapshot_digest)::text ||
        ',"sourceEventId":' || pg_catalog.to_jsonb(input_source_event_id::text)::text ||
        ',"startCommandId":' || pg_catalog.to_jsonb(input_start_command_id::text)::text ||
        ',"type":"invocation.started"}',
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$started_fact_digest$;

REVOKE ALL ON FUNCTION public.creator_agent_worker_started_fact_digest_v1(
  uuid, uuid, text, text, text, uuid, bigint, uuid, text, text, text, text
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.creator_agent_project_started_fact_v1(
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
  input_start_command_id uuid,
  input_runtime_thread_id text,
  input_runtime_turn_id text,
  input_dispatch_receipt_digest text,
  input_sandbox_attestation_digest text,
  input_fact_digest text
)
RETURNS TABLE (
  outcome text,
  projected_state text,
  started_at timestamptz,
  entered_starting boolean,
  reconciliation_root_appended boolean,
  start_command_acked boolean,
  alert_id uuid,
  alert_replayed boolean
)
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $project_started$
DECLARE
  session_is_untrusted boolean;
  incoming record;
  incoming_root record;
  incoming_lease record;
  incoming_command record;
  prepared_predecessor record;
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
  projected_state_value text;
  started_at_value timestamptz;
  reconciliation_reason_value text;
  reconciliation_started_at_value timestamptz;
  entered_starting_value boolean := false;
  root_appended_value boolean := false;
  command_acked_value boolean := false;
  race_retried boolean := false;
BEGIN
  SELECT role.rolsuper OR role.rolbypassrls
    INTO session_is_untrusted
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = session_user;
  IF session_user <> 'combo_agent_broker'
     OR COALESCE(session_is_untrusted, true) THEN
    RAISE EXCEPTION 'Started fact admission requires exact Broker session authority'
      USING ERRCODE = '42501';
  END IF;
  IF input_creator_id IS DISTINCT FROM
       NULLIF(current_setting('app.creator_id', true), '')::uuid
     OR NULLIF(current_setting('app.consumer_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'Started fact admission requires exact Creator and cleared Consumer context'
      USING ERRCODE = '42501';
  END IF;

  IF input_creator_id IS NULL
     OR input_installation_id IS NULL
     OR input_source_event_id IS NULL
     OR input_invocation_id IS NULL
     OR input_lease_id IS NULL
     OR input_start_command_id IS NULL
     OR input_agent_version_digest IS NULL
     OR input_snapshot_digest IS NULL
     OR input_execution_capability_digest IS NULL
     OR input_runtime_thread_id IS NULL
     OR input_runtime_turn_id IS NULL
     OR input_dispatch_receipt_digest IS NULL
     OR input_sandbox_attestation_digest IS NULL
     OR input_fact_digest IS NULL
     OR input_protocol IS DISTINCT FROM 'combo.worker-invocation-fact/1'
     OR input_schema_version IS DISTINCT FROM 1
     OR input_type IS DISTINCT FROM 'invocation.started'
     OR input_source_event_id IS DISTINCT FROM input_start_command_id
     OR input_source_event_id::text !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR input_invocation_id::text !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR input_lease_id::text !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR input_fence IS NULL OR input_fence < 1
     OR input_agent_version_digest !~ '^[a-f0-9]{64}$'
     OR input_snapshot_digest !~ '^[a-f0-9]{64}$'
     OR input_execution_capability_digest !~ '^[a-f0-9]{64}$'
     OR length(input_runtime_thread_id) NOT BETWEEN 1 AND 256
     OR input_runtime_thread_id !~ '^[A-Za-z0-9._:-]+$'
     OR length(input_runtime_turn_id) NOT BETWEEN 1 AND 256
     OR input_runtime_turn_id !~ '^[A-Za-z0-9._:-]+$'
     OR input_dispatch_receipt_digest !~ '^sha256:[a-f0-9]{64}$'
     OR input_sandbox_attestation_digest !~ '^sha256:[a-f0-9]{64}$'
     OR input_fact_digest !~ '^[a-f0-9]{64}$' THEN
    RETURN QUERY
      SELECT 'AUTHORITY_REJECTED'::text, NULL::text, NULL::timestamptz,
             NULL::boolean, NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
    RETURN;
  END IF;

  recomputed_fact_digest := public.creator_agent_worker_started_fact_digest_v1(
    input_source_event_id,
    input_invocation_id,
    input_agent_version_digest,
    input_snapshot_digest,
    input_execution_capability_digest,
    input_lease_id,
    input_fence,
    input_start_command_id,
    input_runtime_thread_id,
    input_runtime_turn_id,
    input_dispatch_receipt_digest,
    input_sandbox_attestation_digest
  );
  IF recomputed_fact_digest IS DISTINCT FROM input_fact_digest THEN
    RETURN QUERY
      SELECT 'AUTHORITY_REJECTED'::text, NULL::text, NULL::timestamptz,
             NULL::boolean, NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'combo.creator-agent-worker-source/1:' || input_source_event_id::text,
      0
    )
  );

  SELECT invocation.id,
         invocation.conversation_id,
         invocation.creator_id,
         invocation.consumer_subject_id,
         invocation.agent_version_id,
         invocation.request_digest,
         invocation.state,
         invocation.started_at,
         invocation.runtime_thread_id,
         invocation.runtime_turn_id,
         invocation.assigned_worker_id,
         invocation.assignment_lease_id,
         invocation.assignment_fence,
         invocation.execution_capability_id,
         invocation.execution_capability_digest,
         invocation.deadline_at,
         invocation.execution_capability_expires_at,
         invocation.execution_capability_revoked_at,
         invocation.reconciliation_reason,
         invocation.reconciliation_started_at,
         conversation.deployment_id,
         conversation.state AS conversation_state,
         version.version_digest AS agent_version_digest,
         snapshot.id AS snapshot_id,
         snapshot.snapshot_digest
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
      SELECT 'UNAVAILABLE'::text, NULL::text, NULL::timestamptz,
             NULL::boolean, NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
    RETURN;
  END IF;

  PERFORM pg_catalog.set_config('app.consumer_id', incoming.consumer_subject_id::text, true);

  SELECT root.source_event_id,
         root.payload,
         root.occurred_at,
         root.source_fact_digest,
         root.broker_command_id
    INTO incoming_root
    FROM public.agent_invocation_events AS root
   WHERE root.invocation_id = input_invocation_id
     AND root.creator_id = input_creator_id
     AND root.consumer_subject_id = incoming.consumer_subject_id
     AND root.source = 'RECONCILER'
     AND root.event_type = 'invocation.reconciling';
  IF incoming.reconciliation_started_at IS NULL THEN
    IF incoming.reconciliation_reason IS NOT NULL OR FOUND THEN
      RETURN QUERY
        SELECT 'INVARIANT_FAILED'::text, NULL::text, NULL::timestamptz,
               NULL::boolean, NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
      RETURN;
    END IF;
  ELSIF NOT FOUND
     OR incoming.reconciliation_reason NOT IN (
       'START_DISPATCH_UNKNOWN', 'HOST_EVIDENCE_LOST', 'MODEL_ATTEMPT_UNKNOWN',
       'CANCEL_NOT_CONFIRMED', 'JOURNAL_LOST'
     )
     OR incoming_root.payload IS DISTINCT FROM pg_catalog.jsonb_build_object(
       'state', 'RECONCILING', 'reason', incoming.reconciliation_reason
     )
     OR incoming_root.occurred_at IS DISTINCT FROM incoming.reconciliation_started_at
     OR incoming_root.source_fact_digest IS NOT NULL
     OR incoming_root.broker_command_id IS NOT NULL THEN
    RETURN QUERY
      SELECT 'INVARIANT_FAILED'::text, NULL::text, NULL::timestamptz,
             NULL::boolean, NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
    RETURN;
  END IF;

  received_fact := pg_catalog.jsonb_build_object(
    'protocol', input_protocol,
    'schemaVersion', input_schema_version,
    'type', input_type,
    'sourceEventId', input_source_event_id::text,
    'invocationId', input_invocation_id::text,
    'agentVersionDigest', input_agent_version_digest,
    'snapshotDigest', input_snapshot_digest,
    'executionCapabilityDigest', input_execution_capability_digest,
    'leaseId', input_lease_id::text,
    'fence', input_fence::text,
    'startCommandId', input_start_command_id::text,
    'runtimeThreadId', input_runtime_thread_id,
    'runtimeTurnId', input_runtime_turn_id,
    'dispatchReceiptDigest', input_dispatch_receipt_digest,
    'sandboxAttestationDigest', input_sandbox_attestation_digest
  );
  source_identity := pg_catalog.jsonb_build_object(
    'domain', 'combo:vnext:worker-source-identity:v1',
    'protocol', 'combo.worker-invocation-fact/1',
    'version', 1,
    'source', 'WORKER',
    'sourceEventId', input_source_event_id::text
  );
  source_identity_digest := pg_catalog.encode(
    public.digest(pg_catalog.convert_to(source_identity::text, 'UTF8'), 'sha256'),
    'hex'
  );

  <<classify_or_admit>>
  LOOP
    SELECT event.id,
           event.invocation_id,
           event.creator_id,
           event.consumer_subject_id,
           event.source_event_id,
           event.event_type,
           event.payload,
           event.occurred_at,
           event.source_fact_digest,
           event.broker_command_id,
           event.source_dispatch_receipt_digest,
           event.source_sandbox_attestation_digest,
           durable_invocation.conversation_id,
           durable_invocation.agent_version_id,
           durable_invocation.request_digest,
           durable_invocation.state AS invocation_state,
           durable_invocation.started_at AS invocation_started_at,
           durable_invocation.runtime_thread_id,
           durable_invocation.runtime_turn_id,
           durable_invocation.assigned_worker_id,
           durable_invocation.assignment_lease_id,
           durable_invocation.assignment_fence,
           durable_invocation.execution_capability_id,
           durable_invocation.execution_capability_digest,
           durable_invocation.reconciliation_reason,
           durable_invocation.reconciliation_started_at,
           durable_conversation.deployment_id,
           durable_version.version_digest AS agent_version_digest,
           durable_snapshot.id AS snapshot_id,
           durable_snapshot.snapshot_digest,
           durable_lease.id AS lease_id,
           durable_lease.worker_id AS lease_worker_id,
           durable_lease.fence AS lease_fence,
           durable_command.command_id,
           durable_command.target_worker_id,
           durable_command.command_type,
           durable_command.state AS command_state,
           durable_command.attempt_count AS command_attempt_count,
           durable_command.conversation_id AS command_conversation_id,
           durable_command.deployment_id AS command_deployment_id,
           durable_command.assignment_lease_id AS command_lease_id,
           durable_command.assignment_fence AS command_fence,
           durable_command.predecessor_command_id,
           durable_command.execution_capability_id AS command_capability_id,
           durable_command.execution_capability_digest AS command_capability_digest,
           prepared_event.source_event_id AS prepared_source_event_id,
           prepared_event.payload AS prepared_payload,
           prepared_event.source_fact_digest AS prepared_fact_digest,
           prepared_event.broker_command_id AS prepared_command_id,
           prepared_command.command_type AS prepared_command_type,
           prepared_command.state AS prepared_command_state,
           prepared_command.attempt_count AS prepared_command_attempt_count,
           prepared_command.target_worker_id AS prepared_target_worker_id,
           prepared_command.conversation_id AS prepared_command_conversation_id,
           prepared_command.deployment_id AS prepared_command_deployment_id,
           prepared_command.assignment_lease_id AS prepared_command_lease_id,
           prepared_command.assignment_fence AS prepared_command_fence,
           prepared_command.predecessor_command_id AS prepared_predecessor_command_id,
           prepared_command.execution_capability_id AS prepared_command_capability_id,
           prepared_command.execution_capability_digest AS prepared_command_capability_digest,
           root.source_event_id AS root_source_event_id,
           root.payload AS root_payload,
           root.occurred_at AS root_occurred_at,
           root.source_fact_digest AS root_fact_digest,
           root.broker_command_id AS root_command_id
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
      LEFT JOIN public.broker_outbox AS durable_command
        ON durable_command.command_id = event.broker_command_id
       AND durable_command.creator_id = event.creator_id
       AND durable_command.invocation_id = event.invocation_id
       AND durable_command.consumer_subject_id = event.consumer_subject_id
      LEFT JOIN public.agent_invocation_events AS prepared_event
        ON prepared_event.invocation_id = event.invocation_id
       AND prepared_event.creator_id = event.creator_id
       AND prepared_event.consumer_subject_id = event.consumer_subject_id
       AND prepared_event.source = 'WORKER'
       AND prepared_event.event_type = 'invocation.persisted'
      LEFT JOIN public.agent_invocation_events AS root
        ON root.invocation_id = event.invocation_id
       AND root.creator_id = event.creator_id
       AND root.consumer_subject_id = event.consumer_subject_id
       AND root.source = 'RECONCILER'
       AND root.event_type = 'invocation.reconciling'
      LEFT JOIN public.broker_outbox AS prepared_command
        ON prepared_command.command_id = prepared_event.broker_command_id
       AND prepared_command.creator_id = prepared_event.creator_id
       AND prepared_command.invocation_id = prepared_event.invocation_id
       AND prepared_command.consumer_subject_id = prepared_event.consumer_subject_id
     WHERE event.source = 'WORKER'
       AND (
         event.source_event_id = input_source_event_id::text
         OR (event.invocation_id = input_invocation_id AND event.event_type = 'invocation.started')
       )
     ORDER BY (
       event.invocation_id = input_invocation_id AND event.event_type = 'invocation.started'
     ) DESC, event.id
     LIMIT 1;

    IF FOUND THEN
      IF existing.event_type IS DISTINCT FROM 'invocation.started'
         OR existing.payload NOT IN ('{"state":"RUNNING"}'::jsonb, '{"state":"RECONCILING"}'::jsonb)
         OR existing.source_event_id !~
           '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         OR existing.source_event_id IS DISTINCT FROM existing.broker_command_id::text
         OR existing.source_fact_digest IS NULL
         OR existing.source_dispatch_receipt_digest IS NULL
         OR existing.source_sandbox_attestation_digest IS NULL
         OR existing.conversation_id IS NULL
         OR existing.agent_version_id IS NULL
         OR existing.agent_version_digest IS NULL
         OR existing.snapshot_id IS NULL
         OR existing.snapshot_digest IS NULL
         OR existing.assigned_worker_id IS NULL
         OR existing.assignment_lease_id IS NULL
         OR existing.assignment_fence IS NULL
         OR existing.execution_capability_id IS NULL
         OR existing.execution_capability_digest IS NULL
         OR existing.runtime_thread_id IS NULL
         OR existing.runtime_turn_id IS NULL
         OR existing.invocation_started_at IS DISTINCT FROM existing.occurred_at
         OR existing.lease_id IS NULL
         OR existing.lease_worker_id IS DISTINCT FROM existing.assigned_worker_id
         OR existing.lease_fence IS DISTINCT FROM existing.assignment_fence
         OR existing.command_id IS NULL
         OR existing.command_type IS DISTINCT FROM 'invocation.start'
         OR existing.command_state NOT IN ('ACKED', 'EXPIRED')
         OR existing.command_attempt_count IS NULL OR existing.command_attempt_count < 1
         OR existing.target_worker_id IS DISTINCT FROM existing.assigned_worker_id
         OR existing.command_conversation_id IS DISTINCT FROM existing.conversation_id
         OR existing.command_deployment_id IS DISTINCT FROM existing.deployment_id
         OR existing.command_lease_id IS DISTINCT FROM existing.assignment_lease_id
         OR existing.command_fence IS DISTINCT FROM existing.assignment_fence
         OR existing.command_capability_id IS DISTINCT FROM existing.execution_capability_id
         OR existing.command_capability_digest IS DISTINCT FROM existing.execution_capability_digest
         OR existing.predecessor_command_id IS NULL
         OR existing.prepared_payload IS DISTINCT FROM '{"state":"PERSISTED"}'::jsonb
         OR existing.prepared_source_event_id IS DISTINCT FROM existing.prepared_command_id::text
         OR existing.prepared_command_id IS DISTINCT FROM existing.predecessor_command_id
         OR existing.prepared_fact_digest IS NULL
         OR existing.prepared_command_type IS DISTINCT FROM 'invocation.prepare'
         OR existing.prepared_command_state NOT IN ('ACKED', 'EXPIRED')
         OR existing.prepared_command_attempt_count IS NULL
         OR existing.prepared_command_attempt_count < 1
         OR existing.prepared_target_worker_id IS DISTINCT FROM existing.assigned_worker_id
         OR existing.prepared_command_conversation_id IS DISTINCT FROM existing.conversation_id
         OR existing.prepared_command_deployment_id IS DISTINCT FROM existing.deployment_id
         OR existing.prepared_command_lease_id IS DISTINCT FROM existing.assignment_lease_id
         OR existing.prepared_command_fence IS DISTINCT FROM existing.assignment_fence
         OR existing.prepared_predecessor_command_id IS NOT NULL
         OR existing.prepared_command_capability_id IS DISTINCT FROM
              existing.execution_capability_id
         OR existing.prepared_command_capability_digest IS DISTINCT FROM
              existing.execution_capability_digest THEN
        RETURN QUERY
          SELECT 'INVARIANT_FAILED'::text, NULL::text, NULL::timestamptz,
                 NULL::boolean, NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
        RETURN;
      END IF;
      IF existing.prepared_fact_digest IS DISTINCT FROM
           public.creator_agent_worker_prepared_fact_digest_v1(
             existing.prepared_source_event_id::uuid,
             existing.invocation_id,
             existing.agent_version_digest,
             existing.snapshot_digest,
             existing.execution_capability_digest,
             existing.assignment_lease_id,
             existing.assignment_fence,
             existing.request_digest,
             existing.prepared_command_id
           ) THEN
        RETURN QUERY
          SELECT 'INVARIANT_FAILED'::text, NULL::text, NULL::timestamptz,
                 NULL::boolean, NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
        RETURN;
      END IF;
      IF existing.reconciliation_started_at IS NULL THEN
        IF existing.reconciliation_reason IS NOT NULL OR existing.root_source_event_id IS NOT NULL THEN
          RETURN QUERY
            SELECT 'INVARIANT_FAILED'::text, NULL::text, NULL::timestamptz,
                   NULL::boolean, NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
          RETURN;
        END IF;
      ELSIF existing.root_source_event_id IS NULL
         OR existing.reconciliation_reason NOT IN (
           'START_DISPATCH_UNKNOWN', 'HOST_EVIDENCE_LOST', 'MODEL_ATTEMPT_UNKNOWN',
           'CANCEL_NOT_CONFIRMED', 'JOURNAL_LOST'
         )
         OR existing.root_payload IS DISTINCT FROM pg_catalog.jsonb_build_object(
           'state', 'RECONCILING', 'reason', existing.reconciliation_reason
         )
         OR existing.root_occurred_at IS DISTINCT FROM existing.reconciliation_started_at
         OR existing.root_fact_digest IS NOT NULL OR existing.root_command_id IS NOT NULL THEN
        RETURN QUERY
          SELECT 'INVARIANT_FAILED'::text, NULL::text, NULL::timestamptz,
                 NULL::boolean, NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
        RETURN;
      END IF;
      IF existing.payload = '{"state":"RUNNING"}'::jsonb THEN
        IF existing.invocation_state NOT IN (
          'RUNNING', 'CANCEL_REQUESTED', 'RECONCILING', 'SUCCEEDED',
          'FAILED', 'CANCELLED', 'UNCERTAIN'
        ) THEN
          RETURN QUERY
            SELECT 'INVARIANT_FAILED'::text, NULL::text, NULL::timestamptz,
                   NULL::boolean, NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
          RETURN;
        END IF;
      ELSIF existing.invocation_state NOT IN ('RECONCILING', 'FAILED', 'CANCELLED', 'UNCERTAIN') THEN
        RETURN QUERY
          SELECT 'INVARIANT_FAILED'::text, NULL::text, NULL::timestamptz,
                 NULL::boolean, NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
        RETURN;
      END IF;

      existing_recomputed_digest := public.creator_agent_worker_started_fact_digest_v1(
        existing.source_event_id::uuid,
        existing.invocation_id,
        existing.agent_version_digest,
        existing.snapshot_digest,
        existing.execution_capability_digest,
        existing.assignment_lease_id,
        existing.assignment_fence,
        existing.broker_command_id,
        existing.runtime_thread_id,
        existing.runtime_turn_id,
        existing.source_dispatch_receipt_digest,
        existing.source_sandbox_attestation_digest
      );
      IF existing.source_fact_digest IS DISTINCT FROM existing_recomputed_digest THEN
        RETURN QUERY
          SELECT 'INVARIANT_FAILED'::text, NULL::text, NULL::timestamptz,
                 NULL::boolean, NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
        RETURN;
      END IF;

      existing_fact := pg_catalog.jsonb_build_object(
        'protocol', 'combo.worker-invocation-fact/1', 'schemaVersion', 1,
        'type', 'invocation.started', 'sourceEventId', existing.source_event_id,
        'invocationId', existing.invocation_id::text,
        'agentVersionDigest', existing.agent_version_digest,
        'snapshotDigest', existing.snapshot_digest,
        'executionCapabilityDigest', existing.execution_capability_digest,
        'leaseId', existing.assignment_lease_id::text,
        'fence', existing.assignment_fence::text,
        'startCommandId', existing.broker_command_id::text,
        'runtimeThreadId', existing.runtime_thread_id,
        'runtimeTurnId', existing.runtime_turn_id,
        'dispatchReceiptDigest', existing.source_dispatch_receipt_digest,
        'sandboxAttestationDigest', existing.source_sandbox_attestation_digest
      );
      existing_identity := pg_catalog.jsonb_build_object(
        'domain', 'combo:vnext:worker-started-event-identity:v1',
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
        'eventType', 'invocation.started', 'payload', existing.payload,
        'brokerCommandId', existing.broker_command_id::text,
        'preparedCommandId', existing.prepared_command_id::text,
        'preparedFactDigest', existing.prepared_fact_digest,
        'fact', existing_fact, 'factDigest', existing.source_fact_digest
      );
      received_identity := pg_catalog.jsonb_build_object(
        'domain', 'combo:vnext:worker-started-event-identity:v1',
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
        'eventType', 'invocation.started', 'payload', existing.payload,
        'brokerCommandId', input_start_command_id::text,
        'preparedCommandId', existing.prepared_command_id::text,
        'preparedFactDigest', existing.prepared_fact_digest,
        'fact', received_fact, 'factDigest', input_fact_digest
      );
      IF existing_identity = received_identity THEN
        RETURN QUERY
          SELECT 'EXACT'::text, existing.payload->>'state', existing.occurred_at,
                 false, false, false, NULL::uuid, NULL::boolean;
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
        SELECT alert.id
          INTO durable_alert_id
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
        RAISE EXCEPTION 'Started fact alert dedupe invariant failed' USING ERRCODE = '55000';
      END IF;
      RETURN QUERY
        SELECT 'SECURITY_BLOCKED'::text, NULL::text, NULL::timestamptz,
               NULL::boolean, NULL::boolean, NULL::boolean,
               durable_alert_id, durable_alert_replayed;
      RETURN;
    END IF;

    IF race_retried THEN
      RETURN QUERY
        SELECT 'INVARIANT_FAILED'::text, NULL::text, NULL::timestamptz,
               NULL::boolean, NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
      RETURN;
    END IF;
    IF incoming.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN', 'EXPIRED') THEN
      RETURN QUERY
        SELECT 'TERMINAL'::text, NULL::text, NULL::timestamptz,
               NULL::boolean, NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
      RETURN;
    END IF;
    IF incoming.state NOT IN ('PERSISTED', 'RECONCILING')
       OR incoming.conversation_state <> 'BUSY' THEN
      RETURN QUERY
        SELECT 'UNAVAILABLE'::text, NULL::text, NULL::timestamptz,
               NULL::boolean, NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
      RETURN;
    END IF;

    SELECT lease.id, lease.deployment_id, lease.creator_id, lease.worker_id,
           lease.fence, lease.state, lease.expires_at
      INTO incoming_lease
      FROM public.worker_leases AS lease
     WHERE lease.id = input_lease_id
       AND lease.deployment_id = incoming.deployment_id
       AND lease.creator_id = input_creator_id
       AND lease.worker_id = input_installation_id
       AND lease.fence = input_fence
     FOR UPDATE;
    IF NOT FOUND THEN
      RETURN QUERY
        SELECT 'AUTHORITY_REJECTED'::text, NULL::text, NULL::timestamptz,
               NULL::boolean, NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
      RETURN;
    END IF;

    SELECT command.command_id, command.target_worker_id, command.invocation_id,
           command.consumer_subject_id, command.conversation_id, command.deployment_id,
           command.assignment_lease_id, command.assignment_fence,
           command.predecessor_command_id, command.execution_capability_id,
           command.execution_capability_digest, command.command_type, command.state,
           command.attempt_count, command.expires_at
      INTO incoming_command
      FROM public.broker_outbox AS command
     WHERE command.command_id = input_start_command_id
       AND command.creator_id = input_creator_id
       AND command.target_worker_id = input_installation_id
       AND command.invocation_id = input_invocation_id
       AND command.consumer_subject_id = incoming.consumer_subject_id
       AND command.conversation_id = incoming.conversation_id
       AND command.deployment_id = incoming.deployment_id
       AND command.assignment_lease_id = input_lease_id
       AND command.assignment_fence = input_fence
     FOR UPDATE;
    IF NOT FOUND
       OR incoming_command.command_type IS DISTINCT FROM 'invocation.start'
       OR incoming_command.predecessor_command_id IS NULL
       OR incoming_command.execution_capability_id IS DISTINCT FROM incoming.execution_capability_id
       OR incoming_command.execution_capability_digest IS DISTINCT FROM
            incoming.execution_capability_digest THEN
      RETURN QUERY
        SELECT 'AUTHORITY_REJECTED'::text, NULL::text, NULL::timestamptz,
               NULL::boolean, NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
      RETURN;
    END IF;

    SELECT event.source_fact_digest, event.broker_command_id, event.source_event_id,
           event.payload, prepare.command_id, prepare.command_type, prepare.state,
           prepare.attempt_count, prepare.target_worker_id, prepare.conversation_id,
           prepare.deployment_id, prepare.assignment_lease_id, prepare.assignment_fence,
           prepare.predecessor_command_id, prepare.execution_capability_id,
           prepare.execution_capability_digest
      INTO prepared_predecessor
      FROM public.agent_invocation_events AS event
      JOIN public.broker_outbox AS prepare
        ON prepare.command_id = event.broker_command_id
       AND prepare.creator_id = event.creator_id
       AND prepare.invocation_id = event.invocation_id
       AND prepare.consumer_subject_id = event.consumer_subject_id
     WHERE event.invocation_id = input_invocation_id
       AND event.creator_id = input_creator_id
       AND event.consumer_subject_id = incoming.consumer_subject_id
       AND event.source = 'WORKER' AND event.event_type = 'invocation.persisted'
       AND event.payload = '{"state":"PERSISTED"}'::jsonb
       AND event.source_event_id = event.broker_command_id::text
       AND prepare.command_id = incoming_command.predecessor_command_id
       AND prepare.command_type = 'invocation.prepare'
       AND prepare.state IN ('ACKED', 'EXPIRED')
       AND prepare.attempt_count >= 1
       AND prepare.target_worker_id = input_installation_id
       AND prepare.conversation_id = incoming.conversation_id
       AND prepare.deployment_id = incoming.deployment_id
       AND prepare.assignment_lease_id = input_lease_id
       AND prepare.assignment_fence = input_fence
       AND prepare.predecessor_command_id IS NULL
       AND prepare.execution_capability_id = incoming.execution_capability_id
       AND prepare.execution_capability_digest = incoming.execution_capability_digest;
    IF NOT FOUND
       OR prepared_predecessor.source_fact_digest IS NULL
       OR prepared_predecessor.source_fact_digest IS DISTINCT FROM
            public.creator_agent_worker_prepared_fact_digest_v1(
              prepared_predecessor.source_event_id::uuid,
              input_invocation_id,
              incoming.agent_version_digest,
              incoming.snapshot_digest,
              incoming.execution_capability_digest,
              input_lease_id,
              input_fence,
              incoming.request_digest,
              prepared_predecessor.broker_command_id
            ) THEN
      RETURN QUERY
        SELECT 'INVARIANT_FAILED'::text, NULL::text, NULL::timestamptz,
               NULL::boolean, NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
      RETURN;
    END IF;

    IF incoming.agent_version_digest IS DISTINCT FROM input_agent_version_digest
       OR incoming.snapshot_digest IS DISTINCT FROM input_snapshot_digest
       OR incoming.assignment_lease_id IS DISTINCT FROM input_lease_id
       OR incoming.assignment_fence IS DISTINCT FROM input_fence
       OR incoming.execution_capability_id IS NULL
       OR incoming.execution_capability_digest IS DISTINCT FROM input_execution_capability_digest
       OR (incoming.runtime_thread_id IS NOT NULL AND
           incoming.runtime_thread_id IS DISTINCT FROM input_runtime_thread_id)
       OR (incoming.runtime_turn_id IS NOT NULL AND
           incoming.runtime_turn_id IS DISTINCT FROM input_runtime_turn_id)
       OR incoming_command.state NOT IN ('SENT', 'EXPIRED')
       OR incoming_command.attempt_count < 1 THEN
      RETURN QUERY
        SELECT 'AUTHORITY_REJECTED'::text, NULL::text, NULL::timestamptz,
               NULL::boolean, NULL::boolean, NULL::boolean, NULL::uuid, NULL::boolean;
      RETURN;
    END IF;

    entered_starting_value := false;
    root_appended_value := false;
    command_acked_value := false;
    projected_state_value := NULL;
    started_at_value := NULL;
    BEGIN
      IF incoming.state = 'PERSISTED'
         AND incoming.deadline_at > clock_timestamp()
         AND incoming.execution_capability_expires_at > clock_timestamp()
         AND incoming.execution_capability_revoked_at IS NULL THEN
        UPDATE public.agent_invocations AS invocation
           SET state = 'STARTING', started_at = clock_timestamp(),
               runtime_thread_id = input_runtime_thread_id,
               runtime_turn_id = input_runtime_turn_id
         WHERE invocation.id = input_invocation_id
           AND invocation.creator_id = input_creator_id
           AND invocation.consumer_subject_id = incoming.consumer_subject_id
           AND invocation.state = 'PERSISTED'
           AND invocation.deadline_at > clock_timestamp()
           AND invocation.execution_capability_expires_at > clock_timestamp()
           AND invocation.execution_capability_revoked_at IS NULL
         RETURNING invocation.started_at INTO started_at_value;
        entered_starting_value := FOUND;
        IF entered_starting_value THEN
          UPDATE public.agent_invocations AS invocation
             SET state = 'RUNNING'
           WHERE invocation.id = input_invocation_id
             AND invocation.creator_id = input_creator_id
             AND invocation.consumer_subject_id = incoming.consumer_subject_id
             AND invocation.state = 'STARTING'
             AND invocation.runtime_thread_id = input_runtime_thread_id
             AND invocation.runtime_turn_id = input_runtime_turn_id
             AND invocation.deadline_at > clock_timestamp()
             AND invocation.execution_capability_expires_at > clock_timestamp()
             AND invocation.execution_capability_revoked_at IS NULL;
          IF FOUND THEN projected_state_value := 'RUNNING'; END IF;
        END IF;
      ELSIF incoming.state = 'RECONCILING'
         AND incoming.deadline_at > clock_timestamp()
         AND incoming.execution_capability_expires_at > clock_timestamp()
         AND incoming.execution_capability_revoked_at IS NULL THEN
        UPDATE public.agent_invocations AS invocation
           SET state = 'RUNNING',
               started_at = COALESCE(invocation.started_at, clock_timestamp()),
               runtime_thread_id = COALESCE(
                 invocation.runtime_thread_id, input_runtime_thread_id
               ),
               runtime_turn_id = COALESCE(invocation.runtime_turn_id, input_runtime_turn_id)
         WHERE invocation.id = input_invocation_id
           AND invocation.creator_id = input_creator_id
           AND invocation.consumer_subject_id = incoming.consumer_subject_id
           AND invocation.state = 'RECONCILING'
           AND invocation.reconciliation_reason IS NOT NULL
           AND invocation.reconciliation_started_at IS NOT NULL
           AND (invocation.runtime_thread_id IS NULL OR
                invocation.runtime_thread_id = input_runtime_thread_id)
           AND (invocation.runtime_turn_id IS NULL OR
                invocation.runtime_turn_id = input_runtime_turn_id)
           AND invocation.deadline_at > clock_timestamp()
           AND invocation.execution_capability_expires_at > clock_timestamp()
           AND invocation.execution_capability_revoked_at IS NULL
         RETURNING invocation.started_at INTO started_at_value;
        IF FOUND THEN projected_state_value := 'RUNNING'; END IF;
      END IF;

      IF projected_state_value IS DISTINCT FROM 'RUNNING' THEN
        UPDATE public.agent_invocations AS invocation
           SET state = 'RECONCILING',
               started_at = COALESCE(invocation.started_at, clock_timestamp()),
               runtime_thread_id = COALESCE(
                 invocation.runtime_thread_id, input_runtime_thread_id
               ),
               runtime_turn_id = COALESCE(invocation.runtime_turn_id, input_runtime_turn_id),
               reconciliation_reason = COALESCE(
                 invocation.reconciliation_reason, 'CANCEL_NOT_CONFIRMED'
               ),
               reconciliation_started_at = COALESCE(
                 invocation.reconciliation_started_at,
                 date_trunc('milliseconds', clock_timestamp())
               )
         WHERE invocation.id = input_invocation_id
           AND invocation.creator_id = input_creator_id
           AND invocation.consumer_subject_id = incoming.consumer_subject_id
           AND invocation.state IN ('PERSISTED', 'STARTING', 'RECONCILING')
           AND (invocation.runtime_thread_id IS NULL OR
                invocation.runtime_thread_id = input_runtime_thread_id)
           AND (invocation.runtime_turn_id IS NULL OR
                invocation.runtime_turn_id = input_runtime_turn_id)
         RETURNING invocation.started_at, invocation.reconciliation_reason,
                   invocation.reconciliation_started_at
              INTO started_at_value, reconciliation_reason_value,
                   reconciliation_started_at_value;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'started projection did not converge' USING ERRCODE = '55000';
        END IF;
        projected_state_value := 'RECONCILING';
        root_appended_value := incoming.reconciliation_started_at IS NULL;
      END IF;

      INSERT INTO public.agent_invocation_events (
        invocation_id, creator_id, consumer_subject_id, journal_seq, source,
        source_event_id, event_type, payload, occurred_at,
        source_fact_digest, broker_command_id,
        source_dispatch_receipt_digest, source_sandbox_attestation_digest
      )
      SELECT input_invocation_id, input_creator_id, incoming.consumer_subject_id,
             COALESCE(max(event.journal_seq), 0) + 1, 'WORKER',
             input_source_event_id::text, 'invocation.started',
             pg_catalog.jsonb_build_object('state', projected_state_value),
             started_at_value, input_fact_digest, input_start_command_id,
             input_dispatch_receipt_digest, input_sandbox_attestation_digest
        FROM public.agent_invocation_events AS event
       WHERE event.invocation_id = input_invocation_id;

      IF root_appended_value THEN
        INSERT INTO public.agent_invocation_events (
          invocation_id, creator_id, consumer_subject_id, journal_seq, source,
          source_event_id, event_type, payload, occurred_at
        )
        SELECT input_invocation_id, input_creator_id, incoming.consumer_subject_id,
               COALESCE(max(event.journal_seq), 0) + 1, 'RECONCILER',
               'late-started:' || input_source_event_id::text,
               'invocation.reconciling',
               pg_catalog.jsonb_build_object(
                 'state', 'RECONCILING', 'reason', reconciliation_reason_value
               ),
               reconciliation_started_at_value
          FROM public.agent_invocation_events AS event
         WHERE event.invocation_id = input_invocation_id;
      END IF;

      IF incoming_command.state = 'SENT' THEN
        UPDATE public.broker_outbox AS command
           SET state = 'ACKED', acked_at = clock_timestamp()
         WHERE command.command_id = input_start_command_id
           AND command.creator_id = input_creator_id
           AND command.state = 'SENT';
        IF NOT FOUND THEN
          RAISE EXCEPTION 'locked start command changed unexpectedly' USING ERRCODE = '55000';
        END IF;
        command_acked_value := true;
      END IF;
    EXCEPTION WHEN unique_violation THEN
      race_retried := true;
    END;

    IF race_retried THEN CONTINUE classify_or_admit; END IF;
    RETURN QUERY
      SELECT 'ADMITTED'::text, projected_state_value, started_at_value,
             entered_starting_value, root_appended_value, command_acked_value,
             NULL::uuid, NULL::boolean;
    RETURN;
  END LOOP classify_or_admit;
END;
$project_started$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.creator_agent_project_started_fact_v1(
  uuid, uuid, text, integer, text, uuid, uuid, text, text, text,
  uuid, bigint, uuid, text, text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.creator_agent_project_started_fact_v1(
  uuid, uuid, text, integer, text, uuid, uuid, text, text, text,
  uuid, bigint, uuid, text, text, text, text, text
) TO combo_agent_broker;

DO $started_admission_owner_gate$
DECLARE trusted_owner boolean;
BEGIN
  SELECT procedure.prosecdef AND (role.rolsuper OR role.rolbypassrls)
    INTO trusted_owner
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS role ON role.oid = procedure.proowner
   WHERE procedure.oid =
     'public.creator_agent_project_started_fact_v1(uuid,uuid,text,integer,text,uuid,uuid,text,text,text,uuid,bigint,uuid,text,text,text,text,text)'::regprocedure;
  IF trusted_owner IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Started fact admission requires a trusted SECURITY DEFINER owner'
      USING ERRCODE = '42501';
  END IF;
END;
$started_admission_owner_gate$;

-- Preserve 0025 prepared cutover and 0020 terminal authority; add the equivalent owner gate only
-- for invocation.started.
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
    SELECT command_type INTO bound_command_type
      FROM public.broker_outbox
     WHERE command_id = NEW.broker_command_id
       AND creator_id = NEW.creator_id
       AND invocation_id = NEW.invocation_id
       AND consumer_subject_id = NEW.consumer_subject_id;
    IF NOT FOUND
       OR NEW.source_event_id <> NEW.broker_command_id::text
       OR bound_command_type <> (
         CASE NEW.event_type
           WHEN 'invocation.persisted' THEN 'invocation.prepare'
           WHEN 'invocation.started' THEN 'invocation.start'
         END
       ) THEN
      RAISE EXCEPTION 'Worker Invocation lifecycle source identity must bind the exact phase command'
        USING ERRCODE = '23514';
    END IF;

    SELECT role.rolsuper OR role.rolbypassrls
      INTO privileged_session
      FROM pg_catalog.pg_roles AS role
     WHERE role.rolname = session_user;
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
      IF session_user <> 'combo_agent_broker'
         OR current_user = session_user
         OR current_user IS DISTINCT FROM phase_admission_owner THEN
        RAISE EXCEPTION 'Worker phase Event requires database admission authority'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  ELSIF NEW.source = 'WORKER'
        AND NEW.event_type IN ('invocation.succeeded', 'invocation.failed') THEN
    IF NEW.source_fact_digest IS NULL
       OR NEW.broker_command_id IS NOT NULL
       OR NEW.source_event_id <> NEW.invocation_id::text THEN
      RAISE EXCEPTION 'Worker Invocation terminal fact requires digest without a command'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.event_type = 'invocation.failed'
       AND (
         NEW.payload->>'state' IS DISTINCT FROM 'FAILED'
         OR COALESCE(NEW.payload->>'errorCode', '') NOT IN (
           'SNAPSHOT_DIGEST_MISMATCH', 'PROTOCOL_INCOMPATIBLE',
           'SANDBOX_ATTESTATION_FAILED', 'RUNTIME_START_FAILED',
           'MODEL_QUOTA_EXHAUSTED', 'TURN_TIMEOUT', 'TURN_FAILED'
         )
       ) THEN
      RAISE EXCEPTION 'Worker Invocation failed fact requires a confirmed stable failure code'
        USING ERRCODE = '23514';
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

-- Existing alert ACLs and the Reconciler-only 0023 recorder remain unchanged.
