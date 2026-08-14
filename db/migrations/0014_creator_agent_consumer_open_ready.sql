-- 0014 · Consumer-only authority and crash-safe Conversation open/ready.
--
-- The public Runtime process must never connect as combo_agent_api: that role also owns Creator
-- control-plane writes. This expand-only migration introduces one exact Consumer login role and
-- two narrow SECURITY DEFINER capabilities. The create capability atomically appends an OPENING
-- Conversation and its exact Lease/Fence-bound conversation.open command. The ready capability
-- is the only application path allowed to move OPENING -> IDLE.

-- ===================== exact Consumer service identity =====================

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'combo_agent_consumer_api') THEN
    EXECUTE 'CREATE ROLE combo_agent_consumer_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
END
$roles$;

ALTER ROLE combo_agent_consumer_api
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO combo_agent_consumer_api;

-- ===================== durable conversation.open authority =====================

ALTER TABLE broker_outbox
  DROP CONSTRAINT ck_broker_outbox_command_type,
  DROP CONSTRAINT ck_broker_outbox_invocation_tenant,
  ADD COLUMN conversation_id uuid,
  ADD COLUMN deployment_id uuid,
  ADD COLUMN assignment_lease_id uuid,
  ADD COLUMN assignment_fence bigint,
  ADD CONSTRAINT ck_broker_outbox_command_type CHECK (
    command_type IN (
      'conversation.open',
      'invocation.prepare', 'invocation.start', 'invocation.cancel',
      'deployment.prepare', 'deployment.drain', 'lease.revoke'
    )
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
    )
    OR
    (
      command_type <> 'conversation.open'
      AND conversation_id IS NULL
      AND deployment_id IS NULL
      AND assignment_lease_id IS NULL
      AND assignment_fence IS NULL
      AND (
        (invocation_id IS NULL AND consumer_subject_id IS NULL)
        OR (invocation_id IS NOT NULL AND consumer_subject_id IS NOT NULL)
      )
    )
  ),
  ADD CONSTRAINT fk_broker_outbox_conversation_tenant
    FOREIGN KEY (conversation_id, creator_id, consumer_subject_id)
    REFERENCES agent_conversations (id, creator_id, consumer_subject_id),
  ADD CONSTRAINT fk_broker_outbox_deployment_creator
    FOREIGN KEY (deployment_id, creator_id)
    REFERENCES deployments (id, creator_id),
  ADD CONSTRAINT fk_broker_outbox_lease_binding
    FOREIGN KEY (assignment_lease_id, creator_id, target_worker_id, assignment_fence)
    REFERENCES worker_leases (id, creator_id, worker_id, fence),
  ADD CONSTRAINT uq_broker_outbox_ready_binding UNIQUE (
    command_id,
    creator_id,
    target_worker_id,
    conversation_id,
    consumer_subject_id,
    assignment_lease_id,
    assignment_fence
  );

CREATE UNIQUE INDEX uq_broker_outbox_conversation_open
  ON broker_outbox (conversation_id)
  WHERE command_type = 'conversation.open';

CREATE OR REPLACE FUNCTION enforce_creator_agent_broker_outbox_transition()
RETURNS trigger AS $$
DECLARE
  transition_allowed boolean;
BEGIN
  IF NEW.command_id IS DISTINCT FROM OLD.command_id
     OR NEW.creator_id IS DISTINCT FROM OLD.creator_id
     OR NEW.target_worker_id IS DISTINCT FROM OLD.target_worker_id
     OR NEW.invocation_id IS DISTINCT FROM OLD.invocation_id
     OR NEW.consumer_subject_id IS DISTINCT FROM OLD.consumer_subject_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.deployment_id IS DISTINCT FROM OLD.deployment_id
     OR NEW.assignment_lease_id IS DISTINCT FROM OLD.assignment_lease_id
     OR NEW.assignment_fence IS DISTINCT FROM OLD.assignment_fence
     OR NEW.command_type IS DISTINCT FROM OLD.command_type
     OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'broker outbox command binding is immutable'
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

-- Application roles may consume and acknowledge conversation.open, but only the narrow create
-- capability below may append it. Inside a SECURITY DEFINER call current_user is the migration
-- owner, while a direct application INSERT keeps its exact constrained role identity.
CREATE OR REPLACE FUNCTION enforce_creator_agent_conversation_open_outbox_insert()
RETURNS trigger AS $$
BEGIN
  IF NEW.command_type = 'conversation.open'
     AND current_user IN (
       'combo_agent_api',
       'combo_agent_broker',
       'combo_agent_reconciler',
       'combo_agent_consumer_api'
     ) THEN
    RAISE EXCEPTION 'conversation.open must use its atomic authority function'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION enforce_creator_agent_conversation_open_outbox_insert() FROM PUBLIC;

CREATE TRIGGER broker_outbox_conversation_open_insert
BEFORE INSERT ON broker_outbox
FOR EACH ROW EXECUTE FUNCTION enforce_creator_agent_conversation_open_outbox_insert();

CREATE OR REPLACE FUNCTION enforce_creator_agent_conversation_atomic_insert()
RETURNS trigger AS $$
BEGIN
  IF current_user IN (
    'combo_agent_api',
    'combo_agent_broker',
    'combo_agent_reconciler',
    'combo_agent_consumer_api'
  ) THEN
    RAISE EXCEPTION 'Conversation create must use its atomic open authority function'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION enforce_creator_agent_conversation_atomic_insert() FROM PUBLIC;

CREATE TRIGGER agent_conversations_atomic_insert
BEFORE INSERT ON agent_conversations
FOR EACH ROW EXECUTE FUNCTION enforce_creator_agent_conversation_atomic_insert();

-- Reinstall the append-only transition reducer with an application-role fence around the single
-- sensitive edge. Other existing transitions remain unchanged for Broker/Reconciler journals.
CREATE OR REPLACE FUNCTION enforce_creator_agent_conversation_transition()
RETURNS trigger AS $$
DECLARE
  transition_allowed boolean;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.deployment_id IS DISTINCT FROM OLD.deployment_id
     OR NEW.agent_version_id IS DISTINCT FROM OLD.agent_version_id
     OR NEW.creator_id IS DISTINCT FROM OLD.creator_id
     OR NEW.consumer_subject_id IS DISTINCT FROM OLD.consumer_subject_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
     OR NEW.version_digest IS DISTINCT FROM OLD.version_digest
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'conversation version and tenant binding is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.assigned_worker_id IS NOT NULL
     AND NEW.assigned_worker_id IS DISTINCT FROM OLD.assigned_worker_id THEN
    RAISE EXCEPTION 'conversation worker binding is immutable once set'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state IN ('CLOSED', 'FAILED', 'EXPIRED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal conversation is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'OPENING'
     AND NEW.state = 'IDLE'
     AND current_user IN (
       'combo_agent_api',
       'combo_agent_broker',
       'combo_agent_reconciler',
       'combo_agent_consumer_api'
     ) THEN
    RAISE EXCEPTION 'OPENING conversation requires exact conversation.ready authority'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.state <> OLD.state THEN
    transition_allowed := CASE OLD.state
      WHEN 'OPENING' THEN NEW.state IN ('IDLE', 'FAILED', 'EXPIRED')
      WHEN 'IDLE' THEN NEW.state IN ('BUSY', 'SUSPENDED', 'CLOSING', 'FAILED', 'EXPIRED')
      WHEN 'BUSY' THEN NEW.state IN ('IDLE', 'SUSPENDED', 'CLOSING', 'FAILED', 'EXPIRED')
      WHEN 'SUSPENDED' THEN NEW.state IN ('CLOSING', 'CLOSED', 'FAILED', 'EXPIRED')
      WHEN 'CLOSING' THEN NEW.state IN ('CLOSED', 'FAILED')
      ELSE false
    END;
    IF NOT transition_allowed THEN
      RAISE EXCEPTION 'invalid conversation transition % -> %', OLD.state, NEW.state
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.next_turn_no < OLD.next_turn_no
     OR NEW.last_activity_at < OLD.last_activity_at
     OR NEW.expires_at < OLD.expires_at THEN
    RAISE EXCEPTION 'conversation counters and deadlines are monotonic'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'EXPIRED' AND OLD.expires_at > now() THEN
    RAISE EXCEPTION 'conversation cannot expire before its Cloud deadline'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION enforce_creator_agent_conversation_transition() FROM PUBLIC;

CREATE TABLE conversation_ready_receipts (
  source_event_id       uuid        PRIMARY KEY,
  conversation_id      uuid        NOT NULL UNIQUE,
  creator_id            uuid        NOT NULL,
  consumer_subject_id   uuid        NOT NULL,
  open_command_id       uuid        NOT NULL UNIQUE,
  worker_id             uuid        NOT NULL,
  lease_id              uuid        NOT NULL,
  fence                 bigint      NOT NULL CHECK (fence BETWEEN 1 AND 9223372036854775807),
  sandbox_instance_id   uuid        NOT NULL,
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_conversation_ready_receipts_conversation
    FOREIGN KEY (conversation_id, creator_id, consumer_subject_id)
    REFERENCES agent_conversations (id, creator_id, consumer_subject_id),
  CONSTRAINT fk_conversation_ready_receipts_lease
    FOREIGN KEY (lease_id, creator_id, worker_id, fence)
    REFERENCES worker_leases (id, creator_id, worker_id, fence),
  CONSTRAINT fk_conversation_ready_receipts_open_command
    FOREIGN KEY (
      open_command_id,
      creator_id,
      worker_id,
      conversation_id,
      consumer_subject_id,
      lease_id,
      fence
    ) REFERENCES broker_outbox (
      command_id,
      creator_id,
      target_worker_id,
      conversation_id,
      consumer_subject_id,
      assignment_lease_id,
      assignment_fence
    )
);

CREATE TRIGGER conversation_ready_receipts_immutable
BEFORE UPDATE OR DELETE ON conversation_ready_receipts
FOR EACH ROW EXECUTE FUNCTION reject_creator_agent_immutable_mutation();

ALTER TABLE conversation_ready_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_ready_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY conversation_ready_receipts_tenant ON conversation_ready_receipts
  USING (
    creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
    AND consumer_subject_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
  )
  WITH CHECK (
    creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
    AND consumer_subject_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
  );

-- This is the only INSERT capability exposed to the public Runtime pool. It rechecks every
-- immutable authority field under locks, generates both IDs in PostgreSQL, and either commits
-- both rows or neither row. An idempotency conflict returns no row for the caller to resolve via
-- its already-serialized replay query.
CREATE OR REPLACE FUNCTION creator_agent_create_opening_conversation(
  input_agent_id uuid,
  input_deployment_id uuid,
  input_agent_version_id uuid,
  input_creator_id uuid,
  input_consumer_id uuid,
  input_idempotency_key uuid,
  input_request_digest text,
  input_version_digest text,
  input_worker_id uuid,
  input_fence bigint,
  input_ttl_seconds integer
)
RETURNS TABLE (
  conversation_id uuid,
  agent_id uuid,
  agent_version_id uuid,
  version_digest text,
  conversation_state text,
  created_at timestamptz,
  expires_at timestamptz,
  open_command_id uuid,
  assignment_lease_id uuid,
  assignment_fence bigint
)
SECURITY DEFINER
-- public is safe here because 0008 revoked CREATE from PUBLIC before any application login;
-- gen_uuid_v7's pgcrypto call resolves there on supported PostgreSQL versions.
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  created_conversation_id uuid;
  created_at_value timestamptz;
  expires_at_value timestamptz;
  current_lease_id uuid;
  current_lease_expires_at timestamptz;
  created_command_id uuid;
BEGIN
  IF input_creator_id IS NULL
     OR input_consumer_id IS NULL
     OR input_fence NOT BETWEEN 1 AND 9223372036854775807
     OR input_ttl_seconds NOT BETWEEN 60 AND 2592000
     OR NULLIF(current_setting('app.creator_id', true), '') IS DISTINCT FROM input_creator_id::text
     OR NULLIF(current_setting('app.consumer_id', true), '') IS DISTINCT FROM input_consumer_id::text THEN
    RETURN;
  END IF;

  -- The function is the authority boundary, so it cannot rely on the HTTP repository acquiring
  -- this lock first. Any direct concurrent caller waits before all grant/deployment/Lease checks.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'creator-agent:create-conversation:' || input_consumer_id::text || ':' ||
      input_idempotency_key::text,
      0
    )
  );

  PERFORM 1
    FROM public.agents AS agent
    JOIN public.agent_access_grants AS access_grant
      ON access_grant.agent_id = agent.id
     AND access_grant.creator_id = agent.creator_id
     AND access_grant.consumer_subject_id = input_consumer_id
     AND access_grant.state = 'ACTIVE'
   WHERE agent.id = input_agent_id
     AND agent.creator_id = input_creator_id
     AND agent.lifecycle = 'ACTIVE'
   FOR SHARE OF agent, access_grant;
  IF NOT FOUND THEN RETURN; END IF;

  PERFORM 1
    FROM public.deployments AS deployment
    JOIN public.agent_versions AS version
      ON version.id = input_agent_version_id
     AND version.agent_id = deployment.agent_id
     AND version.creator_id = deployment.creator_id
     AND version.version_digest = input_version_digest
    JOIN public.agent_version_controls AS version_control
      ON version_control.version_id = version.id
     AND version_control.creator_id = version.creator_id
     AND version_control.availability = 'ACTIVE'
   WHERE deployment.id = input_deployment_id
     AND deployment.agent_id = input_agent_id
     AND deployment.creator_id = input_creator_id
     AND deployment.desired_state = 'ONLINE'
     AND deployment.observed_state = 'ONLINE'
     AND deployment.serving_version_id = input_agent_version_id
     AND deployment.observed_worker_id = input_worker_id
     AND deployment.lease_fence = input_fence
     AND deployment.observed_generation = deployment.generation
   FOR SHARE OF deployment, version, version_control;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT lease.id, lease.expires_at
    INTO current_lease_id, current_lease_expires_at
    FROM public.worker_leases AS lease
    JOIN public.worker_installations AS worker
      ON worker.id = lease.worker_id
     AND worker.creator_id = lease.creator_id
   WHERE lease.deployment_id = input_deployment_id
     AND lease.creator_id = input_creator_id
     AND lease.worker_id = input_worker_id
     AND lease.fence = input_fence
     AND lease.state = 'ACTIVE'
     AND lease.expires_at > clock_timestamp() + interval '3 seconds'
     AND worker.revoked_at IS NULL
   FOR SHARE OF lease, worker;
  IF NOT FOUND THEN RETURN; END IF;

  created_conversation_id := public.gen_uuid_v7();
  created_command_id := public.gen_uuid_v7();

  INSERT INTO public.agent_conversations (
    id, agent_id, deployment_id, agent_version_id, creator_id,
    consumer_subject_id, idempotency_key, request_digest, version_digest,
    state, assigned_worker_id, expires_at
  ) VALUES (
    created_conversation_id, input_agent_id, input_deployment_id, input_agent_version_id,
    input_creator_id, input_consumer_id, input_idempotency_key, input_request_digest,
    input_version_digest, 'OPENING', input_worker_id,
    now() + make_interval(secs => input_ttl_seconds)
  )
  ON CONFLICT (consumer_subject_id, idempotency_key) DO NOTHING
  RETURNING agent_conversations.created_at, agent_conversations.expires_at
       INTO created_at_value, expires_at_value;

  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO public.broker_outbox (
    command_id, creator_id, target_worker_id, invocation_id, consumer_subject_id,
    conversation_id, deployment_id, assignment_lease_id, assignment_fence,
    command_type, dedupe_key, state, next_attempt_at, expires_at
  ) VALUES (
    created_command_id, input_creator_id, input_worker_id, NULL, input_consumer_id,
    created_conversation_id, input_deployment_id, current_lease_id, input_fence,
    'conversation.open', 'conversation:' || created_conversation_id::text || ':open',
    'PENDING', now(), current_lease_expires_at
  );

  RETURN QUERY SELECT
    created_conversation_id,
    input_agent_id,
    input_agent_version_id,
    input_version_digest,
    'OPENING'::text,
    created_at_value,
    expires_at_value,
    created_command_id,
    current_lease_id,
    input_fence;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION creator_agent_create_opening_conversation(
  uuid, uuid, uuid, uuid, uuid, uuid, text, text, uuid, bigint, integer
) FROM PUBLIC;

-- Frozen Gateway projector boundary. Exact source-event replay is successful and mutation-free;
-- a different event, stale Lease/Fence/Worker, an unsent command, or any partial durable state is
-- rejected without revealing which authority check failed.
CREATE OR REPLACE FUNCTION creator_agent_commit_conversation_ready(
  input_source_event_id uuid,
  input_conversation_id uuid,
  input_creator_id uuid,
  input_consumer_id uuid,
  input_worker_id uuid,
  input_lease_id uuid,
  input_fence bigint,
  input_sandbox_instance_id uuid
)
RETURNS TABLE (outcome text, conversation_state text, open_command_id uuid)
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  existing_receipt public.conversation_ready_receipts%ROWTYPE;
  current_deployment_id uuid;
  current_agent_version_id uuid;
  current_state text;
  current_worker_id uuid;
  current_command_id uuid;
  affected_rows bigint;
BEGIN
  IF input_source_event_id IS NULL
     OR input_conversation_id IS NULL
     OR input_creator_id IS NULL
     OR input_consumer_id IS NULL
     OR input_worker_id IS NULL
     OR input_lease_id IS NULL
     OR input_sandbox_instance_id IS NULL
     OR input_fence NOT BETWEEN 1 AND 9223372036854775807
     OR NULLIF(current_setting('app.creator_id', true), '') IS DISTINCT FROM input_creator_id::text
     OR NULLIF(current_setting('app.consumer_id', true), '') IS DISTINCT FROM input_consumer_id::text THEN
    RETURN QUERY SELECT 'REJECTED'::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  -- Serializes concurrent delivery of the same or conflicting ready event. The lock is held until
  -- the caller commits, so a waiter observes the durable receipt and returns exact REPLAY rather
  -- than misclassifying a concurrent duplicate as stale.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('creator-agent:conversation-ready:' || input_conversation_id::text, 0)
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended('creator-agent:ready-source:' || input_source_event_id::text, 0)
  );

  SELECT receipt.*
    INTO existing_receipt
    FROM public.conversation_ready_receipts AS receipt
   WHERE receipt.source_event_id = input_source_event_id;
  IF FOUND THEN
    SELECT conversation.state
      INTO current_state
      FROM public.agent_conversations AS conversation
     WHERE conversation.id = existing_receipt.conversation_id;
    IF existing_receipt.conversation_id = input_conversation_id
       AND existing_receipt.creator_id = input_creator_id
       AND existing_receipt.consumer_subject_id = input_consumer_id
       AND existing_receipt.worker_id = input_worker_id
       AND existing_receipt.lease_id = input_lease_id
       AND existing_receipt.fence = input_fence
       AND existing_receipt.sandbox_instance_id = input_sandbox_instance_id THEN
      RETURN QUERY SELECT 'REPLAY'::text, current_state, existing_receipt.open_command_id;
    ELSE
      RETURN QUERY SELECT 'REJECTED'::text, NULL::text, NULL::uuid;
    END IF;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.conversation_ready_receipts AS receipt
     WHERE receipt.conversation_id = input_conversation_id
  ) THEN
    RETURN QUERY SELECT 'REJECTED'::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  SELECT conversation.deployment_id, conversation.agent_version_id
    INTO current_deployment_id, current_agent_version_id
    FROM public.agent_conversations AS conversation
   WHERE conversation.id = input_conversation_id
     AND conversation.creator_id = input_creator_id
     AND conversation.consumer_subject_id = input_consumer_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'REJECTED'::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  PERFORM 1
    FROM public.deployments AS deployment
   WHERE deployment.id = current_deployment_id
     AND deployment.creator_id = input_creator_id
     AND deployment.desired_state = 'ONLINE'
     AND deployment.observed_state = 'ONLINE'
     AND deployment.observed_worker_id = input_worker_id
     AND deployment.lease_fence = input_fence
     AND deployment.observed_generation = deployment.generation
   FOR SHARE OF deployment;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'REJECTED'::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  PERFORM 1
    FROM public.worker_leases AS lease
    JOIN public.worker_installations AS worker
      ON worker.id = lease.worker_id
     AND worker.creator_id = lease.creator_id
   WHERE lease.id = input_lease_id
     AND lease.deployment_id = current_deployment_id
     AND lease.creator_id = input_creator_id
     AND lease.worker_id = input_worker_id
     AND lease.fence = input_fence
     AND lease.state = 'ACTIVE'
     AND lease.expires_at > clock_timestamp() + interval '3 seconds'
     AND worker.revoked_at IS NULL
   FOR SHARE OF lease, worker;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'REJECTED'::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  PERFORM 1
    FROM public.agent_version_controls AS version_control
   WHERE version_control.version_id = current_agent_version_id
     AND version_control.creator_id = input_creator_id
     AND version_control.availability = 'ACTIVE'
   FOR SHARE OF version_control;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'REJECTED'::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  SELECT conversation.state, conversation.assigned_worker_id
    INTO current_state, current_worker_id
    FROM public.agent_conversations AS conversation
   WHERE conversation.id = input_conversation_id
     AND conversation.creator_id = input_creator_id
     AND conversation.consumer_subject_id = input_consumer_id
   FOR UPDATE;
  IF NOT FOUND OR current_state <> 'OPENING' OR current_worker_id <> input_worker_id THEN
    RETURN QUERY SELECT 'REJECTED'::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  SELECT command.command_id
    INTO current_command_id
    FROM public.broker_outbox AS command
   WHERE command.conversation_id = input_conversation_id
     AND command.creator_id = input_creator_id
     AND command.consumer_subject_id = input_consumer_id
     AND command.target_worker_id = input_worker_id
     AND command.deployment_id = current_deployment_id
     AND command.assignment_lease_id = input_lease_id
     AND command.assignment_fence = input_fence
     AND command.command_type = 'conversation.open'
     AND command.state = 'SENT'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'REJECTED'::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  -- Every mutable authority row and both idempotency domains are now locked. Recheck the one
  -- condition that can change without a row update so lock waits cannot admit an expired Lease.
  IF NOT EXISTS (
    SELECT 1
      FROM public.worker_leases AS lease
     WHERE lease.id = input_lease_id
       AND lease.expires_at > clock_timestamp() + interval '3 seconds'
  ) THEN
    RETURN QUERY SELECT 'REJECTED'::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  INSERT INTO public.conversation_ready_receipts (
    source_event_id, conversation_id, creator_id, consumer_subject_id,
    open_command_id, worker_id, lease_id, fence, sandbox_instance_id
  ) VALUES (
    input_source_event_id, input_conversation_id, input_creator_id, input_consumer_id,
    current_command_id, input_worker_id, input_lease_id, input_fence,
    input_sandbox_instance_id
  );

  UPDATE public.broker_outbox
     SET state = 'ACKED', acked_at = now()
   WHERE command_id = current_command_id AND state = 'SENT';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 1 THEN
    RAISE EXCEPTION 'conversation.open command ACK invariant failed'
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.agent_conversations
     SET state = 'IDLE'
   WHERE id = input_conversation_id AND state = 'OPENING';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 1 THEN
    RAISE EXCEPTION 'conversation.ready projection invariant failed'
      USING ERRCODE = '55000';
  END IF;

  RETURN QUERY SELECT 'APPLIED'::text, 'IDLE'::text, current_command_id;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION creator_agent_commit_conversation_ready(
  uuid, uuid, uuid, uuid, uuid, uuid, bigint, uuid
) FROM PUBLIC;

-- ===================== exact least-privilege grants =====================

REVOKE ALL PRIVILEGES ON
  snapshot_uploads,
  context_snapshots,
  agents,
  agent_access_grants,
  agent_versions,
  agent_version_controls,
  deployments,
  worker_installations,
  worker_leases,
  agent_conversations,
  agent_messages,
  agent_invocations,
  agent_invocation_events,
  broker_outbox,
  conversation_ready_receipts,
  consumer_event_streams,
  consumer_event_outbox
FROM combo_agent_consumer_api;

GRANT SELECT (id, creator_id, public_slug, lifecycle)
  ON agents TO combo_agent_consumer_api;
GRANT SELECT (agent_id, creator_id, consumer_subject_id, state)
  ON agent_access_grants TO combo_agent_consumer_api;
GRANT SELECT (
  id, agent_id, creator_id, environment, desired_state, serving_version_id,
  observed_state, generation, lease_fence, observed_worker_id, observed_generation
) ON deployments TO combo_agent_consumer_api;
GRANT SELECT (id, agent_id, creator_id, version_digest)
  ON agent_versions TO combo_agent_consumer_api;
GRANT SELECT (version_id, creator_id, availability)
  ON agent_version_controls TO combo_agent_consumer_api;
GRANT SELECT (
  id, agent_id, agent_version_id, creator_id, consumer_subject_id,
  idempotency_key, request_digest, version_digest, state, created_at, expires_at
) ON agent_conversations TO combo_agent_consumer_api;

GRANT EXECUTE ON FUNCTION creator_agent_create_opening_conversation(
  uuid, uuid, uuid, uuid, uuid, uuid, text, text, uuid, bigint, integer
) TO combo_agent_consumer_api;
GRANT EXECUTE ON FUNCTION creator_agent_commit_conversation_ready(
  uuid, uuid, uuid, uuid, uuid, uuid, bigint, uuid
) TO combo_agent_broker;
