-- 0016 · Exact Worker Invocation prepared/started/succeeded Cloud authority.
--
-- Existing 0012-0015 rows remain readable: the new fact and capability columns
-- are nullable for legacy facts. Every new WORKER persisted/started Event must,
-- however, bind one canonical fact digest to one exact durable Broker command.

-- ===================== immutable Invocation execution authority =====================

ALTER TABLE agent_invocations
  ADD COLUMN execution_capability_digest text
    CHECK (
      execution_capability_digest IS NULL
      OR execution_capability_digest ~ '^[a-f0-9]{64}$'
    ),
  ADD COLUMN execution_capability_expires_at timestamptz,
  ADD COLUMN execution_capability_revoked_at timestamptz,
  ADD CONSTRAINT ck_agent_invocations_execution_capability_deadline
    CHECK (
      execution_capability_expires_at IS NULL
      OR execution_capability_expires_at <= deadline_at + interval '30 seconds'
    ),
  ADD CONSTRAINT uq_agent_invocations_execution_authority UNIQUE (
    id,
    conversation_id,
    creator_id,
    consumer_subject_id,
    assigned_worker_id,
    assignment_lease_id,
    assignment_fence,
    execution_capability_id,
    execution_capability_digest
  );

CREATE OR REPLACE FUNCTION enforce_creator_agent_invocation_capability_authority()
RETURNS trigger AS $$
DECLARE
  authority_changed boolean;
  authority_deployment_id uuid;
  capability_issued boolean;
  capability_revoked boolean;
BEGIN
  authority_changed :=
    NEW.execution_capability_digest IS DISTINCT FROM OLD.execution_capability_digest
    OR NEW.execution_capability_expires_at IS DISTINCT FROM OLD.execution_capability_expires_at
    OR NEW.execution_capability_revoked_at IS DISTINCT FROM OLD.execution_capability_revoked_at;
  capability_issued :=
    (OLD.execution_capability_digest IS NULL
      AND NEW.execution_capability_digest IS NOT NULL)
    OR (OLD.execution_capability_expires_at IS NULL
      AND NEW.execution_capability_expires_at IS NOT NULL);
  capability_revoked :=
    OLD.execution_capability_revoked_at IS NULL
    AND NEW.execution_capability_revoked_at IS NOT NULL;

  IF OLD.execution_capability_digest IS NOT NULL
     AND NEW.execution_capability_digest IS DISTINCT FROM OLD.execution_capability_digest THEN
    RAISE EXCEPTION 'invocation execution capability digest is immutable once set'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.execution_capability_expires_at IS NOT NULL
     AND NEW.execution_capability_expires_at IS DISTINCT FROM OLD.execution_capability_expires_at THEN
    RAISE EXCEPTION 'invocation execution capability deadline is immutable once set'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.execution_capability_revoked_at IS NOT NULL
     AND NEW.execution_capability_revoked_at IS DISTINCT FROM OLD.execution_capability_revoked_at THEN
    RAISE EXCEPTION 'invocation execution capability revocation is immutable once set'
      USING ERRCODE = '55000';
  END IF;

  IF authority_changed AND (
    NEW.execution_capability_id IS NULL
    OR (NEW.execution_capability_digest IS NULL)
         <> (NEW.execution_capability_expires_at IS NULL)
    OR (
      NEW.execution_capability_revoked_at IS NULL
      AND NEW.execution_capability_digest IS NULL
    )
    OR (
      NEW.execution_capability_expires_at IS NOT NULL
      AND NEW.execution_capability_expires_at <= NEW.created_at
    )
    OR (
      NEW.execution_capability_revoked_at IS NOT NULL
      AND NEW.execution_capability_revoked_at < NEW.created_at
    )
  ) THEN
    RAISE EXCEPTION 'invocation execution capability authority is incomplete'
      USING ERRCODE = '23514';
  END IF;

  IF capability_issued OR capability_revoked THEN
    SELECT conversation.deployment_id
      INTO authority_deployment_id
      FROM public.agent_conversations AS conversation
      JOIN public.worker_leases AS lease
        ON lease.id = NEW.assignment_lease_id
       AND lease.creator_id = NEW.creator_id
       AND lease.worker_id = NEW.assigned_worker_id
       AND lease.fence = NEW.assignment_fence
       AND lease.deployment_id = conversation.deployment_id
     WHERE conversation.id = NEW.conversation_id
       AND conversation.creator_id = NEW.creator_id
       AND conversation.consumer_subject_id = NEW.consumer_subject_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invocation execution capability lacks exact Deployment/Lease/Fence authority'
        USING ERRCODE = '23514';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'combo.gateway.deployment/v1:'
          || NEW.creator_id::text
          || ':'
          || authority_deployment_id::text,
        0
      )
    );

    -- Re-read only after the shared Deployment lock. This closes the race in
    -- which a SECURITY transition fences a Deployment while another Consumer
    -- attempts to mint execution authority against its former active Lease.
    PERFORM 1
      FROM public.agent_conversations AS conversation
      JOIN public.deployments AS deployment
        ON deployment.id = conversation.deployment_id
       AND deployment.creator_id = conversation.creator_id
      JOIN public.worker_leases AS lease
        ON lease.id = NEW.assignment_lease_id
       AND lease.deployment_id = deployment.id
       AND lease.creator_id = NEW.creator_id
       AND lease.worker_id = NEW.assigned_worker_id
       AND lease.fence = NEW.assignment_fence
      LEFT JOIN public.agent_version_controls AS version_control
        ON version_control.version_id = NEW.agent_version_id
       AND version_control.creator_id = NEW.creator_id
     WHERE conversation.id = NEW.conversation_id
       AND conversation.creator_id = NEW.creator_id
       AND conversation.consumer_subject_id = NEW.consumer_subject_id
       AND (
         NOT capability_issued
         OR (
           (deployment.desired_version_id = NEW.agent_version_id
             OR deployment.serving_version_id = NEW.agent_version_id)
           AND lease.state = 'ACTIVE'
           AND lease.expires_at > clock_timestamp()
           AND version_control.availability = 'ACTIVE'
           AND version_control.severity = 'NORMAL'
         )
       );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invocation execution capability lost Deployment authority under lock'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION enforce_creator_agent_invocation_capability_authority() FROM PUBLIC;

CREATE TRIGGER agent_invocations_capability_authority
BEFORE UPDATE ON agent_invocations
FOR EACH ROW EXECUTE FUNCTION enforce_creator_agent_invocation_capability_authority();

-- Cross-Consumer revocation is one exact Deployment operation. Gateway callers
-- do not enumerate Consumer partitions: the definer acquires the same advisory
-- key as heartbeat/capability issuance and performs one RLS-independent UPDATE.
CREATE OR REPLACE FUNCTION creator_agent_security_revoke_deployment_capabilities(
  input_creator_id uuid,
  input_deployment_id uuid
)
RETURNS bigint AS $$
DECLARE
  revoked_count bigint;
BEGIN
  IF session_user <> current_user
     AND NULLIF(current_setting('app.creator_id', true), '')::uuid
           IS DISTINCT FROM input_creator_id THEN
    RAISE EXCEPTION 'Deployment capability revoke requires exact Creator authority'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'combo.gateway.deployment/v1:'
        || input_creator_id::text
        || ':'
        || input_deployment_id::text,
      0
    )
  );
  PERFORM 1
    FROM public.deployments
   WHERE id = input_deployment_id
     AND creator_id = input_creator_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Deployment capability revoke target does not exist'
      USING ERRCODE = 'P0002';
  END IF;

  -- statement_timestamp() is fixed before any row-lock wait. A SECURITY
  -- transition can therefore start first, wait on Version control, and resume
  -- only after a newer Invocation has received a Capability. Stamp each row at
  -- the actual write boundary and keep the immutable row-local lower bound even
  -- if the database wall clock is adjusted backwards.
  UPDATE public.agent_invocations AS invocation
     SET execution_capability_revoked_at =
           GREATEST(clock_timestamp(), invocation.created_at)
    FROM public.agent_conversations AS conversation
   WHERE conversation.id = invocation.conversation_id
     AND conversation.creator_id = invocation.creator_id
     AND conversation.consumer_subject_id = invocation.consumer_subject_id
     AND conversation.deployment_id = input_deployment_id
     AND invocation.creator_id = input_creator_id
     AND invocation.execution_capability_id IS NOT NULL
     AND invocation.execution_capability_revoked_at IS NULL
     AND invocation.state NOT IN (
       'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN', 'EXPIRED'
     );
  GET DIAGNOSTICS revoked_count = ROW_COUNT;
  RETURN revoked_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION creator_agent_security_revoke_deployment_capabilities(uuid, uuid)
  FROM PUBLIC;

-- A SECURITY Version transition must revoke the independent Execution
-- Capability in the same transaction as 0015's Session/Lease cascade. Natural
-- Session replacement revokes only transport authority and intentionally never
-- calls this trigger path.
CREATE OR REPLACE FUNCTION creator_agent_cascade_invocation_capability_security_revocation()
RETURNS trigger AS $$
DECLARE
  affected_deployment_id uuid;
BEGIN
  IF (NEW.availability <> 'REVOKED' AND NEW.severity <> 'SECURITY')
     OR (OLD.availability = 'REVOKED' OR OLD.severity = 'SECURITY') THEN
    RETURN NEW;
  END IF;

  FOR affected_deployment_id IN
    SELECT deployment.id
      FROM public.deployments AS deployment
     WHERE deployment.creator_id = NEW.creator_id
       AND (
         deployment.desired_version_id = NEW.version_id
         OR deployment.serving_version_id = NEW.version_id
         OR EXISTS (
           SELECT 1
             FROM public.agent_invocations AS invocation
             JOIN public.agent_conversations AS conversation
               ON conversation.id = invocation.conversation_id
              AND conversation.creator_id = invocation.creator_id
              AND conversation.consumer_subject_id = invocation.consumer_subject_id
            WHERE invocation.creator_id = NEW.creator_id
              AND invocation.agent_version_id = NEW.version_id
              AND conversation.deployment_id = deployment.id
              AND invocation.state NOT IN (
                'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN', 'EXPIRED'
              )
         )
       )
     ORDER BY deployment.id
  LOOP
    PERFORM public.creator_agent_security_revoke_deployment_capabilities(
      NEW.creator_id,
      affected_deployment_id
    );
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION creator_agent_cascade_invocation_capability_security_revocation()
  FROM PUBLIC;

-- API admission no longer holds any Invocation UPDATE privilege, so the 0012
-- invoker trigger cannot use SELECT ... FOR UPDATE. Keep the row-locking
-- journal sequence invariant behind a tenant-exact definer instead of granting
-- a harmless-looking UPDATE column that would reopen direct API mutation.
CREATE OR REPLACE FUNCTION enforce_creator_agent_event_sequence()
RETURNS trigger AS $$
DECLARE
  expected_seq bigint;
  invocation_state text;
  privileged_session boolean;
BEGIN
  SELECT role.rolsuper OR role.rolbypassrls
    INTO privileged_session
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = session_user;

  IF NOT COALESCE(privileged_session, false) AND (
    NEW.creator_id IS DISTINCT FROM
      NULLIF(current_setting('app.creator_id', true), '')::uuid
    OR NEW.consumer_subject_id IS DISTINCT FROM
      NULLIF(current_setting('app.consumer_id', true), '')::uuid
  ) THEN
    RAISE EXCEPTION 'Invocation Event sequence requires exact tenant authority'
      USING ERRCODE = '42501';
  END IF;

  SELECT invocation.state
    INTO invocation_state
    FROM public.agent_invocations AS invocation
   WHERE invocation.id = NEW.invocation_id
     AND invocation.creator_id = NEW.creator_id
     AND invocation.consumer_subject_id = NEW.consumer_subject_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invocation tenant binding missing for event'
      USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.agent_invocation_events AS event
     WHERE event.invocation_id = NEW.invocation_id
       AND event.event_type IN (
         'invocation.succeeded', 'invocation.failed', 'invocation.cancelled',
         'invocation.uncertain', 'invocation.expired'
       )
  ) THEN
    RAISE EXCEPTION 'invocation journal is terminal'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.payload->>'state' IS DISTINCT FROM invocation_state THEN
    RAISE EXCEPTION 'event state % does not match invocation projection %',
      NEW.payload->>'state', invocation_state
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(max(event.journal_seq), 0) + 1
    INTO expected_seq
    FROM public.agent_invocation_events AS event
   WHERE event.invocation_id = NEW.invocation_id;
  IF NEW.journal_seq <> expected_seq THEN
    RAISE EXCEPTION 'invocation journal sequence must be %', expected_seq
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION enforce_creator_agent_event_sequence() FROM PUBLIC;

-- Every RLS-independent authority routine must be owned by a role that can
-- actually see and mutate every tenant partition. Refuse to install a partially
-- effective SECURITY DEFINER under an ordinary table owner: that configuration
-- could silently miss cross-Consumer capability issuance/revocation rows.
DO $invocation_authority_definer_owner_gate$
DECLARE
  function_signature text;
  trusted_owner boolean;
BEGIN
  FOREACH function_signature IN ARRAY ARRAY[
    'enforce_creator_agent_invocation_capability_authority()',
    'creator_agent_security_revoke_deployment_capabilities(uuid,uuid)',
    'creator_agent_cascade_invocation_capability_security_revocation()',
    'enforce_creator_agent_event_sequence()'
  ]
  LOOP
    SELECT procedure.prosecdef AND (role.rolsuper OR role.rolbypassrls)
      INTO trusted_owner
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_roles AS role ON role.oid = procedure.proowner
     WHERE procedure.oid = pg_catalog.to_regprocedure(function_signature);
    IF trusted_owner IS DISTINCT FROM true THEN
      RAISE EXCEPTION
        'Creator Agent Invocation authority function % requires a SUPERUSER or BYPASSRLS owner',
        function_signature
        USING ERRCODE = '42501';
    END IF;
  END LOOP;
END
$invocation_authority_definer_owner_gate$;

CREATE TRIGGER agent_version_controls_invocation_capability_security_cascade
AFTER UPDATE ON agent_version_controls
FOR EACH ROW EXECUTE FUNCTION creator_agent_cascade_invocation_capability_security_revocation();

-- These composite keys let the Outbox prove that its Conversation, Deployment,
-- Lease and Invocation all belong to one exact tenant and execution assignment.
ALTER TABLE agent_conversations
  ADD CONSTRAINT uq_agent_conversations_deployment_binding UNIQUE (
    id, deployment_id, creator_id, consumer_subject_id
  );

ALTER TABLE worker_leases
  ADD CONSTRAINT uq_worker_leases_deployment_binding UNIQUE (
    id, deployment_id, creator_id, worker_id, fence
  );

-- ===================== exact prepare/start Broker commands =====================

ALTER TABLE broker_outbox
  DROP CONSTRAINT ck_broker_outbox_authority_binding,
  ADD COLUMN predecessor_command_id uuid,
  ADD COLUMN execution_capability_id uuid,
  ADD COLUMN execution_capability_digest text
    CHECK (
      execution_capability_digest IS NULL
      OR execution_capability_digest ~ '^[a-f0-9]{64}$'
    ),
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
          conversation_id IS NULL
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
      command_type NOT IN ('conversation.open', 'invocation.prepare', 'invocation.start')
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
  ),
  ADD CONSTRAINT fk_broker_outbox_predecessor_command
    FOREIGN KEY (predecessor_command_id) REFERENCES broker_outbox (command_id),
  ADD CONSTRAINT fk_broker_outbox_invocation_authority
    FOREIGN KEY (
      invocation_id,
      conversation_id,
      creator_id,
      consumer_subject_id,
      target_worker_id,
      assignment_lease_id,
      assignment_fence,
      execution_capability_id,
      execution_capability_digest
    ) REFERENCES agent_invocations (
      id,
      conversation_id,
      creator_id,
      consumer_subject_id,
      assigned_worker_id,
      assignment_lease_id,
      assignment_fence,
      execution_capability_id,
      execution_capability_digest
    ),
  ADD CONSTRAINT fk_broker_outbox_conversation_deployment
    FOREIGN KEY (conversation_id, deployment_id, creator_id, consumer_subject_id)
    REFERENCES agent_conversations (id, deployment_id, creator_id, consumer_subject_id),
  ADD CONSTRAINT fk_broker_outbox_lease_deployment
    FOREIGN KEY (
      assignment_lease_id,
      deployment_id,
      creator_id,
      target_worker_id,
      assignment_fence
    ) REFERENCES worker_leases (id, deployment_id, creator_id, worker_id, fence),
  ADD CONSTRAINT uq_broker_outbox_invocation_event_binding UNIQUE (
    command_id, creator_id, invocation_id, consumer_subject_id
  );

CREATE UNIQUE INDEX uq_broker_outbox_invocation_start
  ON broker_outbox (invocation_id)
  WHERE command_type = 'invocation.start';

COMMENT ON COLUMN broker_outbox.command_id IS
  'Stable Broker envelope.messageId; every cross-connection retry MUST reuse this exact UUID.';

-- Reinstall the transition reducer so the new command authority is immutable.
-- A legacy PENDING invocation.prepare may be filled exactly once before send;
-- all later mutations remain forbidden.
CREATE OR REPLACE FUNCTION enforce_creator_agent_broker_outbox_transition()
RETURNS trigger AS $$
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
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
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
       'combo_agent_api',
       'combo_agent_broker',
       'combo_agent_reconciler',
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
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION enforce_creator_agent_broker_outbox_transition() FROM PUBLIC;

-- ===================== canonical Worker fact identity =====================

-- An authenticated started receipt is a durable fact even when the original
-- Execution Capability was revoked before the event reached Cloud. In that
-- security branch the projection remains RECONCILING and can never accept a
-- fresh final; the event payload therefore needs this second exact projection.
CREATE OR REPLACE FUNCTION creator_agent_event_payload_is_allowed(
  input_event_type text,
  input_payload jsonb
)
RETURNS boolean AS $$
  SELECT CASE input_event_type
    WHEN 'invocation.accepted' THEN
      input_payload = '{"state":"ACCEPTED"}'::jsonb
    WHEN 'invocation.queued' THEN
      input_payload = '{"state":"QUEUED"}'::jsonb
    WHEN 'invocation.leased' THEN
      input_payload = '{"state":"DISPATCH_PENDING"}'::jsonb
    WHEN 'invocation.persisted' THEN
      input_payload = '{"state":"PERSISTED"}'::jsonb
    WHEN 'invocation.started' THEN
      input_payload IN ('{"state":"RUNNING"}'::jsonb, '{"state":"RECONCILING"}'::jsonb)
    WHEN 'invocation.cancel_requested' THEN
      input_payload = '{"state":"CANCEL_REQUESTED"}'::jsonb
    WHEN 'invocation.reconciling' THEN
      (SELECT count(*) FROM jsonb_object_keys(input_payload)) = 2
      AND input_payload->>'state' = 'RECONCILING'
      AND input_payload->>'reason' IN (
        'START_DISPATCH_UNKNOWN',
        'HOST_EVIDENCE_LOST',
        'MODEL_ATTEMPT_UNKNOWN',
        'CANCEL_NOT_CONFIRMED',
        'JOURNAL_LOST'
      )
    WHEN 'invocation.cancelled' THEN
      input_payload = '{"state":"CANCELLED"}'::jsonb
    WHEN 'invocation.succeeded' THEN
      (SELECT count(*) FROM jsonb_object_keys(input_payload)) = 3
      AND input_payload->>'state' = 'SUCCEEDED'
      AND input_payload->>'messageId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND input_payload->>'resultDigest' ~ '^hmac-sha256:[a-f0-9]{64}$'
    WHEN 'invocation.failed' THEN
      (SELECT count(*) FROM jsonb_object_keys(input_payload)) = 2
      AND input_payload->>'state' = 'FAILED'
      AND input_payload->>'errorCode' ~ '^[A-Z][A-Z0-9_]{1,127}$'
    WHEN 'invocation.uncertain' THEN
      (SELECT count(*) FROM jsonb_object_keys(input_payload)) = 2
      AND input_payload->>'state' = 'UNCERTAIN'
      AND input_payload->>'errorCode' ~ '^[A-Z][A-Z0-9_]{1,127}$'
    WHEN 'invocation.expired' THEN
      input_payload = '{"state":"EXPIRED","errorCode":"INVOCATION_EXPIRED"}'::jsonb
    WHEN 'invocation.terminal' THEN
      (SELECT count(*) FROM jsonb_object_keys(input_payload)) = 10
      AND input_payload->>'protocol' = 'combo.consumer-event-outbox/1'
      AND input_payload->>'schemaVersion' = '1'
      AND input_payload->>'type' = 'invocation.terminal'
      AND input_payload->>'conversationId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND input_payload->>'invocationId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND input_payload->>'terminalState' IN (
        'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN', 'EXPIRED'
      )
      AND input_payload->>'occurredAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$'
      AND CASE input_payload->>'terminalState'
        WHEN 'SUCCEEDED' THEN
          input_payload->>'assistantMessageId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND input_payload->>'resultDigest' ~ '^hmac-sha256:[a-f0-9]{64}$'
          AND input_payload->'errorCode' = 'null'::jsonb
        WHEN 'FAILED' THEN
          input_payload->'assistantMessageId' = 'null'::jsonb
          AND input_payload->'resultDigest' = 'null'::jsonb
          AND input_payload->>'errorCode' ~ '^[A-Z][A-Z0-9_]{1,127}$'
        WHEN 'CANCELLED' THEN
          input_payload->'assistantMessageId' = 'null'::jsonb
          AND input_payload->'resultDigest' = 'null'::jsonb
          AND input_payload->'errorCode' = 'null'::jsonb
        WHEN 'UNCERTAIN' THEN
          input_payload->'assistantMessageId' = 'null'::jsonb
          AND input_payload->'resultDigest' = 'null'::jsonb
          AND input_payload->>'errorCode' = 'EXECUTION_STATE_UNKNOWN'
        WHEN 'EXPIRED' THEN
          input_payload->'assistantMessageId' = 'null'::jsonb
          AND input_payload->'resultDigest' = 'null'::jsonb
          AND input_payload->>'errorCode' = 'INVOCATION_EXPIRED'
        ELSE false
      END
    ELSE false
  END;
$$ LANGUAGE sql IMMUTABLE STRICT;

REVOKE ALL ON FUNCTION creator_agent_event_payload_is_allowed(text, jsonb) FROM PUBLIC;

ALTER TABLE agent_invocation_events
  ADD COLUMN source_fact_digest text
    CHECK (
      source_fact_digest IS NULL
      OR source_fact_digest ~ '^[a-f0-9]{64}$'
    ),
  ADD COLUMN broker_command_id uuid,
  ADD CONSTRAINT fk_agent_invocation_events_broker_command
    FOREIGN KEY (broker_command_id, creator_id, invocation_id, consumer_subject_id)
    REFERENCES broker_outbox (command_id, creator_id, invocation_id, consumer_subject_id);

CREATE OR REPLACE FUNCTION enforce_creator_agent_worker_invocation_fact()
RETURNS trigger AS $$
DECLARE
  bound_command_type text;
BEGIN
  IF NEW.source = 'WORKER'
     AND NEW.event_type IN ('invocation.persisted', 'invocation.started') THEN
    IF NEW.source_fact_digest IS NULL OR NEW.broker_command_id IS NULL THEN
      RAISE EXCEPTION 'Worker Invocation lifecycle fact requires digest and exact command'
        USING ERRCODE = '23514';
    END IF;
    SELECT command_type
      INTO bound_command_type
      FROM broker_outbox
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
  ELSIF NEW.source = 'WORKER' AND NEW.event_type = 'invocation.succeeded' THEN
    IF NEW.source_fact_digest IS NULL
       OR NEW.broker_command_id IS NOT NULL
       OR NEW.source_event_id <> NEW.invocation_id::text THEN
      RAISE EXCEPTION 'Worker Invocation terminal fact requires digest without a command'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.source_fact_digest IS NOT NULL OR NEW.broker_command_id IS NOT NULL THEN
    RAISE EXCEPTION 'fact digest and command are reserved for Worker Invocation lifecycle facts'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION enforce_creator_agent_worker_invocation_fact() FROM PUBLIC;

CREATE TRIGGER agent_invocation_events_worker_fact
BEFORE INSERT ON agent_invocation_events
FOR EACH ROW EXECUTE FUNCTION enforce_creator_agent_worker_invocation_fact();

CREATE UNIQUE INDEX uq_agent_invocation_events_worker_lifecycle_fact
  ON agent_invocation_events (invocation_id, event_type)
  WHERE source = 'WORKER'
    AND event_type IN ('invocation.persisted', 'invocation.started');

-- 0012 also admitted table-wide API INSERT on Message. Preserve the one
-- legitimate API write (the USER half of one exact accept transaction), while
-- making ASSISTANT rows Broker-terminal-only. The structural trigger rejects
-- wrong-role rows immediately; the deferred trigger rejects orphan USER or
-- ASSISTANT rows after every fact in the same transaction has had a chance to
-- become durable.
CREATE OR REPLACE FUNCTION enforce_creator_agent_message_insert_authority()
RETURNS trigger AS $$
DECLARE
  uses_api_authority boolean;
  uses_broker_authority boolean;
  privileged_session boolean;
BEGIN
  SELECT session_role.rolsuper OR session_role.rolbypassrls,
         current_user = 'combo_agent_api'
           OR session_user = 'combo_agent_api'
           OR pg_catalog.pg_has_role(current_user, 'combo_agent_api', 'MEMBER')
           OR pg_catalog.pg_has_role(session_user, 'combo_agent_api', 'MEMBER'),
         current_user = 'combo_agent_broker'
           OR session_user = 'combo_agent_broker'
           OR pg_catalog.pg_has_role(current_user, 'combo_agent_broker', 'MEMBER')
           OR pg_catalog.pg_has_role(session_user, 'combo_agent_broker', 'MEMBER')
    INTO privileged_session, uses_api_authority, uses_broker_authority
    FROM pg_catalog.pg_roles AS session_role
   WHERE session_role.rolname = session_user;

  IF COALESCE(privileged_session, false) THEN
    RETURN NEW;
  END IF;
  IF COALESCE(uses_api_authority, false)
     AND COALESCE(uses_broker_authority, false) THEN
    RAISE EXCEPTION 'Message insert authority is ambiguous'
      USING ERRCODE = '42501';
  END IF;
  IF COALESCE(uses_api_authority, false) AND (
    NEW.role <> 'USER'
    OR NEW.client_message_id IS NULL
    OR NEW.invocation_id IS NULL
    OR NEW.creator_id IS DISTINCT FROM
         NULLIF(current_setting('app.creator_id', true), '')::uuid
    OR NEW.consumer_subject_id IS DISTINCT FROM
         NULLIF(current_setting('app.consumer_id', true), '')::uuid
  ) THEN
    RAISE EXCEPTION 'API may insert only a tenant-bound USER Message'
      USING ERRCODE = '42501';
  ELSIF COALESCE(uses_broker_authority, false) AND (
    NEW.role <> 'ASSISTANT'
    OR NEW.client_message_id IS NOT NULL
    OR NEW.invocation_id IS NULL
    OR NEW.creator_id IS DISTINCT FROM
         NULLIF(current_setting('app.creator_id', true), '')::uuid
    OR NEW.consumer_subject_id IS DISTINCT FROM
         NULLIF(current_setting('app.consumer_id', true), '')::uuid
  ) THEN
    RAISE EXCEPTION 'Broker may insert only a tenant-bound terminal ASSISTANT Message'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
   SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION enforce_creator_agent_message_insert_authority() FROM PUBLIC;

CREATE TRIGGER agent_messages_insert_authority
BEFORE INSERT ON agent_messages
FOR EACH ROW EXECUTE FUNCTION enforce_creator_agent_message_insert_authority();

CREATE OR REPLACE FUNCTION enforce_creator_agent_message_accept_chain()
RETURNS trigger AS $$
DECLARE
  uses_api_authority boolean;
  uses_broker_authority boolean;
  privileged_session boolean;
  exact_chain boolean;
BEGIN
  SELECT session_role.rolsuper OR session_role.rolbypassrls,
         current_user = 'combo_agent_api'
           OR session_user = 'combo_agent_api'
           OR pg_catalog.pg_has_role(current_user, 'combo_agent_api', 'MEMBER')
           OR pg_catalog.pg_has_role(session_user, 'combo_agent_api', 'MEMBER'),
         current_user = 'combo_agent_broker'
           OR session_user = 'combo_agent_broker'
           OR pg_catalog.pg_has_role(current_user, 'combo_agent_broker', 'MEMBER')
           OR pg_catalog.pg_has_role(session_user, 'combo_agent_broker', 'MEMBER')
    INTO privileged_session, uses_api_authority, uses_broker_authority
    FROM pg_catalog.pg_roles AS session_role
   WHERE session_role.rolname = session_user;

  IF COALESCE(privileged_session, false) THEN
    RETURN NEW;
  END IF;

  IF COALESCE(uses_api_authority, false) THEN
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
         AND invocation.state = 'ACCEPTED'
         AND invocation.assigned_worker_id IS NULL
         AND invocation.assignment_lease_id IS NULL
         AND invocation.assignment_fence IS NULL
         AND invocation.execution_capability_id IS NULL
         AND invocation.execution_capability_digest IS NULL
         AND invocation.execution_capability_expires_at IS NULL
         AND invocation.execution_capability_revoked_at IS NULL
         AND NEW.role = 'USER'
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
$$ LANGUAGE plpgsql
   SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION enforce_creator_agent_message_accept_chain() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER agent_messages_exact_chain
AFTER INSERT ON agent_messages
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_creator_agent_message_accept_chain();

-- 0012 admitted Invocation requests with table-wide INSERT. After execution
-- authority and canonical Worker fact columns were appended, retaining that
-- grant would let the API role mint capabilities or forge lifecycle facts. The
-- trigger guards also cover future non-privileged login roles that inherit
-- combo_agent_api membership; a privileged migration session is deliberately
-- exempt, including when it SET ROLEs during schema verification.
CREATE OR REPLACE FUNCTION enforce_creator_agent_api_invocation_insert()
RETURNS trigger AS $$
DECLARE
  uses_api_authority boolean;
BEGIN
  SELECT (
           current_user = 'combo_agent_api'
           OR session_user = 'combo_agent_api'
           OR pg_catalog.pg_has_role(current_user, 'combo_agent_api', 'MEMBER')
           OR pg_catalog.pg_has_role(session_user, 'combo_agent_api', 'MEMBER')
         )
         AND NOT (session_role.rolsuper OR session_role.rolbypassrls)
    INTO uses_api_authority
    FROM pg_catalog.pg_roles AS session_role
   WHERE session_role.rolname = session_user;

  IF COALESCE(uses_api_authority, false) AND (
    NEW.state <> 'ACCEPTED'
    OR NEW.assigned_worker_id IS NOT NULL
    OR NEW.assignment_lease_id IS NOT NULL
    OR NEW.assignment_fence IS NOT NULL
    OR NEW.execution_capability_id IS NOT NULL
    OR NEW.execution_capability_digest IS NOT NULL
    OR NEW.execution_capability_expires_at IS NOT NULL
    OR NEW.execution_capability_revoked_at IS NOT NULL
    OR NEW.cancel_requested_at IS NOT NULL
    OR NEW.runtime_thread_id IS NOT NULL
    OR NEW.runtime_turn_id IS NOT NULL
    OR NEW.result_message_id IS NOT NULL
    OR NEW.result_digest IS NOT NULL
    OR NEW.error_code IS NOT NULL
    OR NEW.reconciliation_reason IS NOT NULL
    OR NEW.reconciliation_started_at IS NOT NULL
    OR NEW.uncertainty_reason IS NOT NULL
    OR NEW.retry_of_invocation_id IS NOT NULL
    OR NEW.started_at IS NOT NULL
    OR NEW.terminal_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'API may insert only a pure ACCEPTED Invocation request'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION enforce_creator_agent_api_invocation_insert() FROM PUBLIC;

CREATE TRIGGER agent_invocations_api_insert_authority
BEFORE INSERT ON agent_invocations
FOR EACH ROW EXECUTE FUNCTION enforce_creator_agent_api_invocation_insert();

CREATE OR REPLACE FUNCTION enforce_creator_agent_api_prepare_outbox_insert()
RETURNS trigger AS $$
DECLARE
  uses_api_authority boolean;
  exact_accepted_request boolean;
BEGIN
  SELECT (
           current_user = 'combo_agent_api'
           OR session_user = 'combo_agent_api'
           OR pg_catalog.pg_has_role(current_user, 'combo_agent_api', 'MEMBER')
           OR pg_catalog.pg_has_role(session_user, 'combo_agent_api', 'MEMBER')
         )
         AND NOT (session_role.rolsuper OR session_role.rolbypassrls)
    INTO uses_api_authority
    FROM pg_catalog.pg_roles AS session_role
   WHERE session_role.rolname = session_user;

  IF COALESCE(uses_api_authority, false) THEN
    SELECT EXISTS (
      SELECT 1
        FROM agent_invocations AS invocation
        JOIN agent_conversations AS conversation
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
    ) INTO exact_accepted_request;

    IF NEW.command_type <> 'invocation.prepare'
       OR NEW.invocation_id IS NULL
       OR NEW.consumer_subject_id IS NULL
       OR NEW.state <> 'PENDING'
       OR NEW.attempt_count <> 0
       OR NEW.acked_at IS NOT NULL
       OR NEW.conversation_id IS NOT NULL
       OR NEW.deployment_id IS NOT NULL
       OR NEW.assignment_lease_id IS NOT NULL
       OR NEW.assignment_fence IS NOT NULL
       OR NEW.predecessor_command_id IS NOT NULL
       OR NEW.execution_capability_id IS NOT NULL
       OR NEW.execution_capability_digest IS NOT NULL
       OR NOT COALESCE(exact_accepted_request, false) THEN
      RAISE EXCEPTION 'API may insert only the exact initial invocation.prepare command'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION enforce_creator_agent_api_prepare_outbox_insert() FROM PUBLIC;

CREATE TRIGGER broker_outbox_api_insert_authority
BEFORE INSERT ON broker_outbox
FOR EACH ROW EXECUTE FUNCTION enforce_creator_agent_api_prepare_outbox_insert();

CREATE OR REPLACE FUNCTION enforce_creator_agent_api_accepted_event_insert()
RETURNS trigger AS $$
DECLARE
  uses_api_authority boolean;
BEGIN
  SELECT (
           current_user = 'combo_agent_api'
           OR session_user = 'combo_agent_api'
           OR pg_catalog.pg_has_role(current_user, 'combo_agent_api', 'MEMBER')
           OR pg_catalog.pg_has_role(session_user, 'combo_agent_api', 'MEMBER')
         )
         AND NOT (session_role.rolsuper OR session_role.rolbypassrls)
    INTO uses_api_authority
    FROM pg_catalog.pg_roles AS session_role
   WHERE session_role.rolname = session_user;

  IF COALESCE(uses_api_authority, false) AND (
    NEW.source <> 'API'
    OR NEW.event_type <> 'invocation.accepted'
    OR NEW.journal_seq <> 1
    OR NEW.payload <> '{"state":"ACCEPTED"}'::jsonb
    OR NEW.source_fact_digest IS NOT NULL
    OR NEW.broker_command_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'API may insert only an invocation.accepted Event without Worker authority'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION enforce_creator_agent_api_accepted_event_insert() FROM PUBLIC;

CREATE TRIGGER agent_invocation_events_api_insert_authority
BEFORE INSERT ON agent_invocation_events
FOR EACH ROW EXECUTE FUNCTION enforce_creator_agent_api_accepted_event_insert();

REVOKE INSERT ON agent_invocations, broker_outbox, agent_invocation_events
  FROM combo_agent_api;

REVOKE INSERT ON agent_messages FROM combo_agent_api, combo_agent_reconciler;

-- Fail closed until an explicit pre-dispatch cancellation authority is added.
-- In particular, the legacy 0012 column grants must not let API callers forge
-- execution or terminal projections.
REVOKE UPDATE (state, cancel_requested_at, terminal_at, error_code)
  ON agent_invocations FROM combo_agent_api;

GRANT INSERT (
  id, conversation_id, creator_id, consumer_subject_id, turn_no, role,
  client_message_id, content_algorithm, content_key_id, content_nonce,
  content_ciphertext, content_auth_tag, content_cipher_digest, content_digest,
  content_aad_version, invocation_id
) ON agent_messages TO combo_agent_api;

GRANT INSERT (
  id, conversation_id, creator_id, consumer_subject_id, agent_version_id,
  user_message_id, client_message_id, request_digest, state, deadline_at
) ON agent_invocations TO combo_agent_api;

GRANT INSERT (
  command_id, creator_id, target_worker_id, invocation_id, consumer_subject_id,
  command_type, dedupe_key, state, next_attempt_at, expires_at
) ON broker_outbox TO combo_agent_api;

GRANT INSERT (
  invocation_id, creator_id, consumer_subject_id, journal_seq, source,
  source_event_id, event_type, payload, occurred_at
) ON agent_invocation_events TO combo_agent_api;

-- Only the Broker/Reconciler may fill or revoke an Invocation capability binding.
GRANT UPDATE (
  execution_capability_digest,
  execution_capability_expires_at,
  execution_capability_revoked_at,
  reconciliation_reason,
  reconciliation_started_at
) ON agent_invocations TO combo_agent_broker, combo_agent_reconciler;

GRANT UPDATE (
  conversation_id,
  deployment_id,
  assignment_lease_id,
  assignment_fence,
  execution_capability_id,
  execution_capability_digest
) ON broker_outbox TO combo_agent_broker;

GRANT EXECUTE ON FUNCTION enforce_creator_agent_invocation_capability_authority()
  TO combo_agent_broker, combo_agent_reconciler;
GRANT EXECUTE ON FUNCTION creator_agent_security_revoke_deployment_capabilities(uuid, uuid)
  TO combo_agent_broker, combo_agent_reconciler;
GRANT EXECUTE ON FUNCTION enforce_creator_agent_worker_invocation_fact()
  TO combo_agent_broker, combo_agent_reconciler;
GRANT EXECUTE ON FUNCTION enforce_creator_agent_api_invocation_insert()
  TO combo_agent_api;
GRANT EXECUTE ON FUNCTION enforce_creator_agent_api_prepare_outbox_insert()
  TO combo_agent_api, combo_agent_broker;
GRANT EXECUTE ON FUNCTION enforce_creator_agent_api_accepted_event_insert()
  TO combo_agent_api, combo_agent_broker, combo_agent_reconciler;
GRANT EXECUTE ON FUNCTION enforce_creator_agent_message_insert_authority()
  TO combo_agent_api, combo_agent_broker;
GRANT EXECUTE ON FUNCTION enforce_creator_agent_message_accept_chain()
  TO combo_agent_api, combo_agent_broker;
