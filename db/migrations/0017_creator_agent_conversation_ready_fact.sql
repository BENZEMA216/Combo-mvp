-- 0017 · Durable, replay-safe conversation.ready fact authority.
--
-- 0014 keyed readiness by the transport event and required the original Lease to still be
-- current. A Cloud commit followed by ACK loss could therefore become unreplayable after an
-- authorized Worker reconnect. This additive authority instead keys the immutable business fact
-- by its conversation.open command. The current transport remains a Gateway concern; PostgreSQL
-- binds and commits only the original open authority and the canonical ready fact.

-- ===================== structural bindings for the full ready fact =====================

ALTER TABLE agent_versions
  ADD CONSTRAINT uq_agent_versions_ready_fact_binding UNIQUE (
    id, creator_id, version_digest, snapshot_id
  );

ALTER TABLE context_snapshots
  ADD CONSTRAINT uq_context_snapshots_ready_fact_binding UNIQUE (
    id, creator_id, snapshot_digest
  );

ALTER TABLE worker_gateway_sessions
  ADD CONSTRAINT uq_worker_gateway_sessions_ready_fact_binding UNIQUE (
    id, creator_id, installation_id, connection_id
  );

ALTER TABLE worker_leases
  ADD CONSTRAINT uq_worker_leases_ready_fact_binding UNIQUE (
    id, deployment_id, creator_id, worker_id, connection_id, fence
  );

ALTER TABLE broker_outbox
  ADD CONSTRAINT uq_broker_outbox_ready_fact_binding UNIQUE (
    command_id,
    creator_id,
    target_worker_id,
    conversation_id,
    consumer_subject_id,
    deployment_id,
    assignment_lease_id,
    assignment_fence
  );

CREATE TABLE conversation_ready_fact_receipts (
  source_event_id             uuid        PRIMARY KEY,
  fact_digest                 text        NOT NULL UNIQUE
                                           CHECK (fact_digest ~ '^[a-f0-9]{64}$'),
  fact_protocol               text        NOT NULL DEFAULT 'combo.worker-conversation-ready-fact/1'
                                           CHECK (
                                             fact_protocol =
                                               'combo.worker-conversation-ready-fact/1'
                                           ),
  fact_schema_version         integer     NOT NULL DEFAULT 1
                                           CHECK (fact_schema_version = 1),
  fact_type                   text        NOT NULL DEFAULT 'conversation.ready'
                                           CHECK (fact_type = 'conversation.ready'),
  conversation_id            uuid        NOT NULL UNIQUE,
  open_command_id            uuid        NOT NULL UNIQUE,
  creator_id                 uuid        NOT NULL,
  consumer_subject_id        uuid        NOT NULL,
  deployment_id              uuid        NOT NULL,
  agent_version_id           uuid        NOT NULL,
  agent_version_digest       text        NOT NULL
                                           CHECK (agent_version_digest ~ '^[a-f0-9]{64}$'),
  snapshot_id                uuid        NOT NULL,
  snapshot_digest            text        NOT NULL
                                           CHECK (snapshot_digest ~ '^[a-f0-9]{64}$'),
  installation_id            uuid        NOT NULL,
  original_worker_session_id uuid        NOT NULL,
  original_lease_id          uuid        NOT NULL,
  original_connection_id     uuid        NOT NULL,
  original_fence             bigint      NOT NULL
                                           CHECK (
                                             original_fence BETWEEN 1 AND 9223372036854775807
                                           ),
  sandbox_instance_id        uuid        NOT NULL,
  runtime_thread_id          text        NOT NULL
                                           CHECK (
                                             length(runtime_thread_id) BETWEEN 1 AND 256
                                             AND runtime_thread_id ~ '^[A-Za-z0-9._:-]+$'
                                           ),
  ready_evidence_digest      text        NOT NULL
                                           CHECK (
                                             ready_evidence_digest ~
                                               '^sha256:[a-f0-9]{64}$'
                                           ),
  recorded_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ck_conversation_ready_fact_stable_source
    CHECK (source_event_id = open_command_id),
  CONSTRAINT fk_ready_fact_conversation
    FOREIGN KEY (conversation_id, deployment_id, creator_id, consumer_subject_id)
    REFERENCES agent_conversations (id, deployment_id, creator_id, consumer_subject_id),
  CONSTRAINT fk_ready_fact_version
    FOREIGN KEY (agent_version_id, creator_id, agent_version_digest, snapshot_id)
    REFERENCES agent_versions (id, creator_id, version_digest, snapshot_id),
  CONSTRAINT fk_ready_fact_snapshot
    FOREIGN KEY (snapshot_id, creator_id, snapshot_digest)
    REFERENCES context_snapshots (id, creator_id, snapshot_digest),
  CONSTRAINT fk_ready_fact_original_session
    FOREIGN KEY (
      original_worker_session_id,
      creator_id,
      installation_id,
      original_connection_id
    ) REFERENCES worker_gateway_sessions (id, creator_id, installation_id, connection_id),
  CONSTRAINT fk_ready_fact_original_lease
    FOREIGN KEY (
      original_lease_id,
      deployment_id,
      creator_id,
      installation_id,
      original_connection_id,
      original_fence
    ) REFERENCES worker_leases (
      id,
      deployment_id,
      creator_id,
      worker_id,
      connection_id,
      fence
    ),
  CONSTRAINT fk_ready_fact_open_command
    FOREIGN KEY (
      open_command_id,
      creator_id,
      installation_id,
      conversation_id,
      consumer_subject_id,
      deployment_id,
      original_lease_id,
      original_fence
    ) REFERENCES broker_outbox (
      command_id,
      creator_id,
      target_worker_id,
      conversation_id,
      consumer_subject_id,
      deployment_id,
      assignment_lease_id,
      assignment_fence
    )
);

CREATE TRIGGER conversation_ready_fact_receipts_immutable
BEFORE UPDATE OR DELETE ON conversation_ready_fact_receipts
FOR EACH ROW EXECUTE FUNCTION reject_creator_agent_immutable_mutation();

ALTER TABLE conversation_ready_fact_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_ready_fact_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY conversation_ready_fact_receipts_tenant ON conversation_ready_fact_receipts
  USING (
    creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
    AND consumer_subject_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
  )
  WITH CHECK (
    creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
    AND consumer_subject_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
  );

COMMENT ON TABLE conversation_ready_fact_receipts IS
  'Append-only full conversation.ready facts. Transport connection authority is deliberately absent.';

-- The protocol fact has a fixed scalar-only shape. Host runtime IDs are restricted to the
-- protocol alphabet, so PostgreSQL's JSON string rendering is byte-identical to RFC 8785/JCS for
-- every admitted value. Keys below are in Unicode lexicographic order, exactly as canonicalSha256.
CREATE OR REPLACE FUNCTION creator_agent_conversation_ready_fact_digest(
  input_source_event_id uuid,
  input_conversation_id uuid,
  input_deployment_id uuid,
  input_agent_version_id uuid,
  input_agent_version_digest text,
  input_snapshot_digest text,
  input_installation_id uuid,
  input_original_worker_session_id uuid,
  input_original_lease_id uuid,
  input_original_fence bigint,
  input_sandbox_instance_id uuid,
  input_runtime_thread_id text,
  input_ready_evidence_digest text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $ready_fact_digest$
  SELECT pg_catalog.encode(
    public.digest(
      '{"agentVersionDigest":' || pg_catalog.to_jsonb(input_agent_version_digest)::text
      || ',"agentVersionId":' || pg_catalog.to_jsonb(input_agent_version_id::text)::text
      || ',"conversationId":' || pg_catalog.to_jsonb(input_conversation_id::text)::text
      || ',"deploymentId":' || pg_catalog.to_jsonb(input_deployment_id::text)::text
      || ',"fence":' || pg_catalog.to_jsonb(input_original_fence::text)::text
      || ',"installationId":' || pg_catalog.to_jsonb(input_installation_id::text)::text
      || ',"leaseId":' || pg_catalog.to_jsonb(input_original_lease_id::text)::text
      || ',"openCommandId":' || pg_catalog.to_jsonb(input_source_event_id::text)::text
      || ',"protocol":"combo.worker-conversation-ready-fact/1"'
      || ',"readyEvidenceDigest":' || pg_catalog.to_jsonb(input_ready_evidence_digest)::text
      || ',"runtimeThreadId":' || pg_catalog.to_jsonb(input_runtime_thread_id)::text
      || ',"sandboxInstanceId":' || pg_catalog.to_jsonb(input_sandbox_instance_id::text)::text
      || ',"schemaVersion":1'
      || ',"snapshotDigest":' || pg_catalog.to_jsonb(input_snapshot_digest)::text
      || ',"sourceEventId":' || pg_catalog.to_jsonb(input_source_event_id::text)::text
      || ',"type":"conversation.ready"'
      || ',"workerSessionId":'
      || pg_catalog.to_jsonb(input_original_worker_session_id::text)::text
      || '}',
      'sha256'
    ),
    'hex'
  );
$ready_fact_digest$;

REVOKE ALL ON FUNCTION creator_agent_conversation_ready_fact_digest(
  uuid, uuid, uuid, uuid, text, text, uuid, uuid, uuid, bigint, uuid, text, text
) FROM PUBLIC;

-- Stable sourceEventId is the exact conversation.open command ID. Exact durable replay is checked
-- before all live authority, so a later authorized connection/Lease replacement cannot turn a
-- committed fact into a rejection. A fresh late fact still has to prove the immutable original
-- Session/connection/Lease/Fence binding, a converged ONLINE Deployment, a live installation, an
-- OPENING Conversation, a SENT open command, and an ACTIVE non-security Version. No original
-- Session or Lease liveness check is intentional, and the current Deployment fence is never
-- compared with the original fact fence.
CREATE OR REPLACE FUNCTION creator_agent_commit_conversation_ready_fact(
  input_source_event_id uuid,
  input_fact_digest text,
  input_conversation_id uuid,
  input_creator_id uuid,
  input_consumer_id uuid,
  input_deployment_id uuid,
  input_agent_version_id uuid,
  input_agent_version_digest text,
  input_snapshot_digest text,
  input_installation_id uuid,
  input_original_worker_session_id uuid,
  input_original_lease_id uuid,
  input_original_fence bigint,
  input_sandbox_instance_id uuid,
  input_runtime_thread_id text,
  input_ready_evidence_digest text
)
RETURNS TABLE (outcome text, conversation_state text, open_command_id uuid)
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $ready_fact_commit$
DECLARE
  existing_receipt public.conversation_ready_fact_receipts%ROWTYPE;
  expected_fact_digest text;
  current_state text;
  current_snapshot_id uuid;
  original_connection_id uuid;
  current_command_id uuid;
  version_authority_live boolean;
  affected_rows bigint;
BEGIN
  IF input_source_event_id IS NULL
     OR input_fact_digest IS NULL
     OR input_conversation_id IS NULL
     OR input_creator_id IS NULL
     OR input_consumer_id IS NULL
     OR input_deployment_id IS NULL
     OR input_agent_version_id IS NULL
     OR input_agent_version_digest IS NULL
     OR input_snapshot_digest IS NULL
     OR input_installation_id IS NULL
     OR input_original_worker_session_id IS NULL
     OR input_original_lease_id IS NULL
     OR input_sandbox_instance_id IS NULL
     OR input_runtime_thread_id IS NULL
     OR input_ready_evidence_digest IS NULL
     OR input_fact_digest !~ '^[a-f0-9]{64}$'
     OR input_agent_version_digest !~ '^[a-f0-9]{64}$'
     OR input_snapshot_digest !~ '^[a-f0-9]{64}$'
     OR input_ready_evidence_digest !~ '^sha256:[a-f0-9]{64}$'
     OR length(input_runtime_thread_id) NOT BETWEEN 1 AND 256
     OR input_runtime_thread_id !~ '^[A-Za-z0-9._:-]+$'
     OR input_original_fence NOT BETWEEN 1 AND 9223372036854775807
     OR NULLIF(current_setting('app.creator_id', true), '')
          IS DISTINCT FROM input_creator_id::text
     OR NULLIF(current_setting('app.consumer_id', true), '')
          IS DISTINCT FROM input_consumer_id::text THEN
    RETURN QUERY SELECT 'REJECTED'::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  expected_fact_digest := public.creator_agent_conversation_ready_fact_digest(
    input_source_event_id,
    input_conversation_id,
    input_deployment_id,
    input_agent_version_id,
    input_agent_version_digest,
    input_snapshot_digest,
    input_installation_id,
    input_original_worker_session_id,
    input_original_lease_id,
    input_original_fence,
    input_sandbox_instance_id,
    input_runtime_thread_id,
    input_ready_evidence_digest
  );
  IF expected_fact_digest IS DISTINCT FROM input_fact_digest THEN
    RETURN QUERY SELECT 'REJECTED'::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  -- Serialize Version security transitions, then both business idempotency domains. The first
  -- lock is re-entrant when this function runs inside the Gateway's already-authorized frame tx.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'combo.gateway.deployment/v1:'
        || input_creator_id::text
        || ':'
        || input_deployment_id::text,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'creator-agent:conversation-ready-fact:' || input_conversation_id::text,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'creator-agent:ready-fact-source:' || input_source_event_id::text,
      0
    )
  );

  SELECT receipt.*
    INTO existing_receipt
    FROM public.conversation_ready_fact_receipts AS receipt
   WHERE receipt.source_event_id = input_source_event_id;
  IF FOUND THEN
    SELECT conversation.state
      INTO current_state
      FROM public.agent_conversations AS conversation
     WHERE conversation.id = existing_receipt.conversation_id
       AND conversation.creator_id = existing_receipt.creator_id
       AND conversation.consumer_subject_id = existing_receipt.consumer_subject_id;

    IF existing_receipt.fact_digest = input_fact_digest
       AND existing_receipt.conversation_id = input_conversation_id
       AND existing_receipt.open_command_id = input_source_event_id
       AND existing_receipt.creator_id = input_creator_id
       AND existing_receipt.consumer_subject_id = input_consumer_id
       AND existing_receipt.deployment_id = input_deployment_id
       AND existing_receipt.agent_version_id = input_agent_version_id
       AND existing_receipt.agent_version_digest = input_agent_version_digest
       AND existing_receipt.snapshot_digest = input_snapshot_digest
       AND existing_receipt.installation_id = input_installation_id
       AND existing_receipt.original_worker_session_id = input_original_worker_session_id
       AND existing_receipt.original_lease_id = input_original_lease_id
       AND existing_receipt.original_fence = input_original_fence
       AND existing_receipt.sandbox_instance_id = input_sandbox_instance_id
       AND existing_receipt.runtime_thread_id = input_runtime_thread_id
       AND existing_receipt.ready_evidence_digest = input_ready_evidence_digest THEN
      RETURN QUERY SELECT 'REPLAY'::text, current_state, existing_receipt.open_command_id;
    ELSE
      RETURN QUERY SELECT 'REJECTED'::text, NULL::text, NULL::uuid;
    END IF;
    RETURN;
  END IF;

  -- 0014 receipts did not retain a canonical digest, Version/Snapshot, original Session/
  -- connection, runtime thread, or evidence digest. They cannot be safely promoted. Any overlap
  -- with a legacy source, Conversation, or open command therefore fails closed with zero writes.
  IF EXISTS (
    SELECT 1
      FROM public.conversation_ready_receipts AS legacy_receipt
     WHERE legacy_receipt.source_event_id = input_source_event_id
        OR legacy_receipt.conversation_id = input_conversation_id
        OR legacy_receipt.open_command_id = input_source_event_id
  ) OR EXISTS (
    SELECT 1
      FROM public.conversation_ready_fact_receipts AS receipt
     WHERE receipt.conversation_id = input_conversation_id
        OR receipt.open_command_id = input_source_event_id
        OR receipt.fact_digest = input_fact_digest
  ) THEN
    RETURN QUERY SELECT 'REJECTED'::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  -- A SECURITY Version transition locks agent_version_controls before its AFTER trigger waits
  -- for the Deployment advisory key. Gateway already owns that advisory key while projecting a
  -- Worker frame, so waiting here for the Version row would invert the lock order and let
  -- PostgreSQL choose an arbitrary 40P01 victim. Preserve the live Version row lock, but acquire
  -- it without waiting and turn contention into one stable, whole-transaction retry signal.
  -- Exact committed replay intentionally returned above and never reaches this live-authority
  -- lock.
  BEGIN
    SELECT true
      INTO version_authority_live
      FROM public.agent_version_controls AS version_control
     WHERE version_control.version_id = input_agent_version_id
       AND version_control.creator_id = input_creator_id
       AND version_control.availability = 'ACTIVE'
       AND version_control.severity = 'NORMAL'
     FOR SHARE NOWAIT;
  EXCEPTION
    WHEN lock_not_available THEN
      RAISE EXCEPTION
        'conversation.ready Version authority is concurrently changing; retry transaction'
        USING ERRCODE = '40001';
  END;
  IF version_authority_live IS DISTINCT FROM true THEN
    RETURN QUERY SELECT 'REJECTED'::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  SELECT snapshot.id, original_session.connection_id, command.command_id
    INTO current_snapshot_id, original_connection_id, current_command_id
    FROM public.agent_conversations AS conversation
    JOIN public.deployments AS deployment
      ON deployment.id = conversation.deployment_id
     AND deployment.id = input_deployment_id
     AND deployment.agent_id = conversation.agent_id
     AND deployment.creator_id = conversation.creator_id
     AND deployment.desired_state = 'ONLINE'
     AND deployment.observed_state = 'ONLINE'
     AND deployment.serving_version_id = input_agent_version_id
     AND deployment.observed_worker_id = input_installation_id
     AND deployment.observed_generation = deployment.generation
    JOIN public.agent_versions AS version
      ON version.id = input_agent_version_id
     AND version.id = conversation.agent_version_id
     AND version.agent_id = conversation.agent_id
     AND version.creator_id = conversation.creator_id
     AND version.version_digest = input_agent_version_digest
     AND version.version_digest = conversation.version_digest
    JOIN public.context_snapshots AS snapshot
      ON snapshot.id = version.snapshot_id
     AND snapshot.creator_id = version.creator_id
     AND snapshot.snapshot_digest = input_snapshot_digest
    JOIN public.worker_installations AS installation
      ON installation.id = input_installation_id
     AND installation.creator_id = conversation.creator_id
     AND installation.revoked_at IS NULL
    JOIN public.broker_outbox AS command
      ON command.command_id = input_source_event_id
     AND command.command_type = 'conversation.open'
     AND command.state = 'SENT'
     AND command.conversation_id = conversation.id
     AND command.creator_id = conversation.creator_id
     AND command.consumer_subject_id = conversation.consumer_subject_id
     AND command.deployment_id = conversation.deployment_id
     AND command.target_worker_id = input_installation_id
     AND command.assignment_lease_id = input_original_lease_id
     AND command.assignment_fence = input_original_fence
    JOIN public.worker_gateway_sessions AS original_session
      ON original_session.id = input_original_worker_session_id
     AND original_session.creator_id = conversation.creator_id
     AND original_session.installation_id = input_installation_id
    JOIN public.worker_leases AS original_lease
      ON original_lease.id = input_original_lease_id
     AND original_lease.deployment_id = conversation.deployment_id
     AND original_lease.creator_id = conversation.creator_id
     AND original_lease.worker_id = input_installation_id
     AND original_lease.connection_id = original_session.connection_id
     AND original_lease.fence = input_original_fence
   WHERE conversation.id = input_conversation_id
     AND conversation.creator_id = input_creator_id
     AND conversation.consumer_subject_id = input_consumer_id
     AND conversation.deployment_id = input_deployment_id
     AND conversation.state = 'OPENING'
     AND conversation.assigned_worker_id = input_installation_id
   FOR UPDATE OF conversation, command
   FOR SHARE OF deployment, installation;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'REJECTED'::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  INSERT INTO public.conversation_ready_fact_receipts (
    source_event_id,
    fact_digest,
    conversation_id,
    open_command_id,
    creator_id,
    consumer_subject_id,
    deployment_id,
    agent_version_id,
    agent_version_digest,
    snapshot_id,
    snapshot_digest,
    installation_id,
    original_worker_session_id,
    original_lease_id,
    original_connection_id,
    original_fence,
    sandbox_instance_id,
    runtime_thread_id,
    ready_evidence_digest
  ) VALUES (
    input_source_event_id,
    input_fact_digest,
    input_conversation_id,
    input_source_event_id,
    input_creator_id,
    input_consumer_id,
    input_deployment_id,
    input_agent_version_id,
    input_agent_version_digest,
    current_snapshot_id,
    input_snapshot_digest,
    input_installation_id,
    input_original_worker_session_id,
    input_original_lease_id,
    original_connection_id,
    input_original_fence,
    input_sandbox_instance_id,
    input_runtime_thread_id,
    input_ready_evidence_digest
  );

  UPDATE public.broker_outbox
     SET state = 'ACKED', acked_at = clock_timestamp()
   WHERE command_id = current_command_id
     AND state = 'SENT';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 1 THEN
    RAISE EXCEPTION 'conversation.ready fact open-command ACK invariant failed'
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.agent_conversations
     SET state = 'IDLE'
   WHERE id = input_conversation_id
     AND creator_id = input_creator_id
     AND consumer_subject_id = input_consumer_id
     AND state = 'OPENING';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 1 THEN
    RAISE EXCEPTION 'conversation.ready fact projection invariant failed'
      USING ERRCODE = '55000';
  END IF;

  RETURN QUERY SELECT 'APPLIED'::text, 'IDLE'::text, current_command_id;
END;
$ready_fact_commit$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION creator_agent_commit_conversation_ready_fact(
  uuid, text, uuid, uuid, uuid, uuid, uuid, text,
  text, uuid, uuid, uuid, bigint, uuid, text, text
) FROM PUBLIC;

-- A FORCE-RLS definer owned by an ordinary role would silently turn exact replay into a
-- tenant-dependent miss. Refuse to install that partial authority.
DO $conversation_ready_fact_definer_owner_gate$
DECLARE
  trusted_owner boolean;
BEGIN
  SELECT procedure.prosecdef AND (role.rolsuper OR role.rolbypassrls)
    INTO trusted_owner
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS role ON role.oid = procedure.proowner
   WHERE procedure.oid = pg_catalog.to_regprocedure(
     'creator_agent_commit_conversation_ready_fact(uuid,text,uuid,uuid,uuid,uuid,uuid,text,text,uuid,uuid,uuid,bigint,uuid,text,text)'
   );
  IF trusted_owner IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'Creator Agent conversation.ready fact authority requires a SUPERUSER or BYPASSRLS owner'
      USING ERRCODE = '42501';
  END IF;
END
$conversation_ready_fact_definer_owner_gate$;

-- 0014 remains readable for upgrade audit only. Its transport-keyed projector is no longer an
-- executable application capability because it cannot prove the full durable fact.
REVOKE ALL ON FUNCTION creator_agent_commit_conversation_ready(
  uuid, uuid, uuid, uuid, uuid, uuid, bigint, uuid
) FROM PUBLIC, combo_api, combo_worker, combo_runtime,
  combo_agent_api, combo_agent_broker, combo_agent_reconciler,
  combo_agent_consumer_api, combo_agent_maintenance;

REVOKE ALL PRIVILEGES ON conversation_ready_fact_receipts
FROM PUBLIC, combo_api, combo_worker, combo_runtime,
  combo_agent_api, combo_agent_broker, combo_agent_reconciler,
  combo_agent_consumer_api, combo_agent_maintenance;

REVOKE ALL ON FUNCTION creator_agent_conversation_ready_fact_digest(
  uuid, uuid, uuid, uuid, text, text, uuid, uuid, uuid, bigint, uuid, text, text
) FROM PUBLIC, combo_api, combo_worker, combo_runtime,
  combo_agent_api, combo_agent_broker, combo_agent_reconciler,
  combo_agent_consumer_api, combo_agent_maintenance;

REVOKE ALL ON FUNCTION creator_agent_commit_conversation_ready_fact(
  uuid, text, uuid, uuid, uuid, uuid, uuid, text,
  text, uuid, uuid, uuid, bigint, uuid, text, text
) FROM PUBLIC, combo_api, combo_worker, combo_runtime,
  combo_agent_api, combo_agent_broker, combo_agent_reconciler,
  combo_agent_consumer_api, combo_agent_maintenance;

GRANT EXECUTE ON FUNCTION creator_agent_commit_conversation_ready_fact(
  uuid, text, uuid, uuid, uuid, uuid, uuid, text,
  text, uuid, uuid, uuid, bigint, uuid, text, text
) TO combo_agent_broker;
