-- 0018 · Broker payload v1, reconnect-safe delivery binding, and trusted
-- visible-transcript authority.
--
-- This is an intentionally quiescent contract migration. The old schema cannot
-- distinguish an original business assignment from the current transport used
-- to retry it. Installing the new constraints while either authority is live
-- would therefore create an unprovable mixed-version claim. The migration takes
-- table locks first and refuses the whole transaction with SQLSTATE 55000 unless
-- every business publisher and Worker transport has drained.

LOCK TABLE public.broker_outbox,
  public.worker_gateway_outbound_frames,
  public.worker_gateway_sessions,
  public.worker_leases
IN ACCESS EXCLUSIVE MODE;

DO $broker_delivery_zero_live_gate$
DECLARE
  live_outbox_count bigint;
  live_delivery_count bigint;
  active_session_count bigint;
  active_lease_count bigint;
BEGIN
  SELECT count(*)
    INTO live_outbox_count
    FROM public.broker_outbox
   WHERE state IN ('PENDING', 'SENT');

  SELECT count(*)
    INTO live_delivery_count
    FROM public.worker_gateway_outbound_frames
   WHERE envelope_type IN (
     'conversation.open',
     'invocation.prepare', 'invocation.start', 'invocation.cancel',
     'deployment.prepare', 'deployment.drain'
   )
     AND durable_ack_level IS DISTINCT FROM 'CLOUD_COMMITTED';

  SELECT count(*)
    INTO active_session_count
    FROM public.worker_gateway_sessions
   WHERE state = 'ACTIVE';

  SELECT count(*)
    INTO active_lease_count
    FROM public.worker_leases
   WHERE state = 'ACTIVE';

  IF live_outbox_count <> 0
     OR live_delivery_count <> 0
     OR active_session_count <> 0
     OR active_lease_count <> 0 THEN
    RAISE EXCEPTION '0018 Broker delivery contract requires a zero-live cutover'
      USING ERRCODE = '55000',
            DETAIL = pg_catalog.format(
              'outbox=%s delivery=%s sessions=%s leases=%s',
              live_outbox_count,
              live_delivery_count,
              active_session_count,
              active_lease_count
            );
  END IF;
END
$broker_delivery_zero_live_gate$;

-- ===================== immutable Broker payload v1 =====================

ALTER TABLE public.broker_outbox
  ADD COLUMN payload_contract_version smallint NOT NULL DEFAULT 0,
  ADD COLUMN visible_transcript_digest text,
  ADD COLUMN visible_transcript_key_id text,
  ADD COLUMN visible_transcript_key_version bigint,
  ADD COLUMN visible_transcript_key_ref text,
  ADD COLUMN original_worker_session_id uuid,
  ADD COLUMN original_connection_id uuid,
  ADD CONSTRAINT ck_broker_outbox_payload_contract CHECK (
    (
      payload_contract_version = 0
      AND visible_transcript_digest IS NULL
      AND visible_transcript_key_id IS NULL
      AND visible_transcript_key_version IS NULL
      AND visible_transcript_key_ref IS NULL
      AND original_worker_session_id IS NULL
      AND original_connection_id IS NULL
    )
    OR
    (
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
    )
  ),
  ADD CONSTRAINT fk_broker_outbox_original_session
    FOREIGN KEY (
      original_worker_session_id,
      creator_id,
      target_worker_id,
      original_connection_id
    ) REFERENCES public.worker_gateway_sessions (
      id,
      creator_id,
      installation_id,
      connection_id
    ),
  ADD CONSTRAINT fk_broker_outbox_original_lease_connection
    FOREIGN KEY (
      assignment_lease_id,
      deployment_id,
      creator_id,
      target_worker_id,
      original_connection_id,
      assignment_fence
    ) REFERENCES public.worker_leases (
      id,
      deployment_id,
      creator_id,
      worker_id,
      connection_id,
      fence
    ),
  ADD CONSTRAINT uq_broker_outbox_delivery_contract_binding UNIQUE (
    command_id,
    creator_id,
    target_worker_id,
    deployment_id,
    payload_contract_version,
    command_type
  );

COMMENT ON COLUMN public.broker_outbox.payload_contract_version IS
  '0 is legacy/control and cannot claim a business command; 1 is the exact trusted Broker payload contract.';
COMMENT ON COLUMN public.broker_outbox.visible_transcript_digest IS
  'Domain-separated KMS HMAC over exact visible transcript JCS bytes; never a client field.';
COMMENT ON COLUMN public.broker_outbox.original_worker_session_id IS
  'Immutable Session authority at business-command creation, distinct from retry delivery Session.';

-- Reinstall 0016's reducer with the payload contract and original assignment
-- included in the immutable command identity. No v0 -> v1 in-place promotion is
-- allowed: the zero-live cutover deliberately makes every surviving v0 row
-- terminal, and every new conversation.open must use the v2 definer below.
CREATE OR REPLACE FUNCTION public.enforce_creator_agent_broker_outbox_transition()
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
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.payload_contract_version IS DISTINCT FROM OLD.payload_contract_version
     OR NEW.visible_transcript_digest IS DISTINCT FROM OLD.visible_transcript_digest
     OR NEW.visible_transcript_key_id IS DISTINCT FROM OLD.visible_transcript_key_id
     OR NEW.visible_transcript_key_version IS DISTINCT FROM OLD.visible_transcript_key_version
     OR NEW.visible_transcript_key_ref IS DISTINCT FROM OLD.visible_transcript_key_ref
     OR NEW.original_worker_session_id IS DISTINCT FROM OLD.original_worker_session_id
     OR NEW.original_connection_id IS DISTINCT FROM OLD.original_connection_id THEN
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

REVOKE ALL ON FUNCTION public.enforce_creator_agent_broker_outbox_transition() FROM PUBLIC;

-- 0016's API-only INSERT guard used current_user as one signal. That identity
-- is the trusted owner while a Consumer calls the SECURITY DEFINER below, and
-- PostgreSQL reports every role as a member to a superuser. Identify the login
-- authority exclusively from session_user so the guard still catches direct
-- API callers and audited pool roles that are API members, without confusing a
-- migration owner or a Consumer-to-definer call for API authority.
CREATE OR REPLACE FUNCTION public.enforce_creator_agent_api_prepare_outbox_insert()
RETURNS trigger AS $$
DECLARE
  uses_api_authority boolean;
  exact_accepted_request boolean;
BEGIN
  SELECT (
           session_user = 'combo_agent_api'
           OR (
             NOT (session_role.rolsuper OR session_role.rolbypassrls)
             AND pg_catalog.pg_has_role(session_user, 'combo_agent_api', 'MEMBER')
           )
         )
    INTO uses_api_authority
    FROM pg_catalog.pg_roles AS session_role
   WHERE session_role.rolname = session_user;

  IF COALESCE(uses_api_authority, false) THEN
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

REVOKE ALL ON FUNCTION public.enforce_creator_agent_api_prepare_outbox_insert() FROM PUBLIC;

-- ===================== current delivery versus original authority =====================

ALTER TABLE public.worker_gateway_outbound_frames
  DROP CONSTRAINT uq_worker_gateway_outbound_frames_message,
  ADD COLUMN delivery_contract_version smallint NOT NULL DEFAULT 0,
  ADD COLUMN broker_command_id uuid,
  ADD COLUMN broker_target_worker_id uuid,
  ADD COLUMN broker_deployment_id uuid,
  ADD COLUMN claim_session_id uuid,
  ADD COLUMN claim_connection_id uuid,
  ADD COLUMN current_delivery_lease_id uuid,
  ADD COLUMN current_delivery_fence bigint,
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
    )
  ),
  ADD CONSTRAINT fk_worker_gateway_outbound_broker_command
    FOREIGN KEY (
      broker_command_id,
      creator_id,
      broker_target_worker_id,
      broker_deployment_id,
      delivery_contract_version,
      envelope_type
    ) REFERENCES public.broker_outbox (
      command_id,
      creator_id,
      target_worker_id,
      deployment_id,
      payload_contract_version,
      command_type
    ),
  ADD CONSTRAINT fk_worker_gateway_outbound_claim_session
    FOREIGN KEY (
      claim_session_id,
      creator_id,
      broker_target_worker_id,
      claim_connection_id
    ) REFERENCES public.worker_gateway_sessions (
      id,
      creator_id,
      installation_id,
      connection_id
    ),
  ADD CONSTRAINT fk_worker_gateway_outbound_current_lease
    FOREIGN KEY (
      current_delivery_lease_id,
      broker_deployment_id,
      creator_id,
      broker_target_worker_id,
      claim_connection_id,
      current_delivery_fence
    ) REFERENCES public.worker_leases (
      id,
      deployment_id,
      creator_id,
      worker_id,
      connection_id,
      fence
    );

-- Stable business messageId is the Broker command ID and may be delivered once
-- per replacement Session. Control IDs retain their former global uniqueness.
CREATE UNIQUE INDEX uq_worker_gateway_outbound_business_per_session
  ON public.worker_gateway_outbound_frames (session_id, broker_command_id)
  WHERE delivery_contract_version = 1;

CREATE UNIQUE INDEX uq_worker_gateway_outbound_control_message
  ON public.worker_gateway_outbound_frames (message_id)
  WHERE broker_command_id IS NULL;

-- lease.revoke is a protocol control frame, not a Broker business command. It
-- remains an exact v0 frame with the global messageId uniqueness above; only
-- business commands must prove the payload-v1 Broker/current-delivery binding.
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
       AND current_deployment.desired_state = 'ONLINE'
       AND current_deployment.observed_state = 'ONLINE'
       AND current_deployment.observed_worker_id = command.target_worker_id
       AND current_deployment.observed_generation = current_deployment.generation
       AND current_deployment.lease_fence = NEW.current_delivery_fence
       AND delivery_lease.state = 'ACTIVE'
       AND delivery_lease.expires_at > clock_timestamp()
     FOR UPDATE OF command
     FOR SHARE OF gateway, current_deployment, delivery_lease;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Broker business delivery lost current claim authority'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_gateway_outbound_insert() FROM PUBLIC;

CREATE TRIGGER worker_gateway_outbound_frames_insert_authority
BEFORE INSERT ON public.worker_gateway_outbound_frames
FOR EACH ROW EXECUTE FUNCTION public.enforce_creator_agent_gateway_outbound_insert();

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

-- ===================== exact Consumer create-open v2 =====================

CREATE OR REPLACE FUNCTION public.creator_agent_create_opening_conversation_v2(
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
  input_ttl_seconds integer,
  input_visible_transcript_digest text,
  input_visible_transcript_key_id text,
  input_visible_transcript_key_version bigint,
  input_visible_transcript_key_ref text
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
SET search_path = pg_catalog, public
SET row_security = on
AS $create_open_v2$
DECLARE
  created_conversation_id uuid;
  created_at_value timestamptz;
  expires_at_value timestamptz;
  current_lease_id uuid;
  current_lease_expires_at timestamptz;
  current_connection_id uuid;
  current_worker_session_id uuid;
  created_command_id uuid;
  version_authority_live boolean;
BEGIN
  IF input_creator_id IS NULL
     OR input_consumer_id IS NULL
     OR input_fence NOT BETWEEN 1 AND 9223372036854775807
     OR input_ttl_seconds NOT BETWEEN 60 AND 2592000
     OR input_visible_transcript_digest !~ '^hmac-sha256:[a-f0-9]{64}$'
     OR length(input_visible_transcript_key_id) NOT BETWEEN 1 AND 256
     OR input_visible_transcript_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
     OR input_visible_transcript_key_version NOT BETWEEN 1 AND 9223372036854775807
     OR length(input_visible_transcript_key_ref) NOT BETWEEN 1 AND 512
     OR input_visible_transcript_key_ref !~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]*$'
     OR NULLIF(current_setting('app.creator_id', true), '') IS DISTINCT FROM input_creator_id::text
     OR NULLIF(current_setting('app.consumer_id', true), '') IS DISTINCT FROM input_consumer_id::text THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'creator-agent:create-conversation:' || input_consumer_id::text || ':' ||
      input_idempotency_key::text,
      0
    )
  );

  -- Version SECURITY transitions lock agent_version_controls before their
  -- AFTER triggers acquire this Deployment advisory key. Match the 0017 lock
  -- order before touching any Deployment row, then refuse to wait on a Version
  -- row held by a transition that may already be waiting for this key.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'combo.gateway.deployment/v1:'
        || input_creator_id::text
        || ':'
        || input_deployment_id::text,
      0
    )
  );
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
        'create-open Version authority is concurrently changing; retry transaction'
        USING ERRCODE = '40001';
  END;
  IF version_authority_live IS DISTINCT FROM true THEN RETURN; END IF;

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
   WHERE deployment.id = input_deployment_id
     AND deployment.agent_id = input_agent_id
     AND deployment.creator_id = input_creator_id
     AND deployment.desired_state = 'ONLINE'
     AND deployment.observed_state = 'ONLINE'
     AND deployment.serving_version_id = input_agent_version_id
     AND deployment.observed_worker_id = input_worker_id
     AND deployment.lease_fence = input_fence
     AND deployment.observed_generation = deployment.generation
   FOR SHARE OF deployment, version;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT lease.id, lease.expires_at, lease.connection_id, gateway.id
    INTO current_lease_id, current_lease_expires_at,
         current_connection_id, current_worker_session_id
    FROM public.worker_leases AS lease
    JOIN public.worker_installations AS installation
      ON installation.id = lease.worker_id
     AND installation.creator_id = lease.creator_id
    JOIN public.worker_gateway_sessions AS gateway
      ON gateway.creator_id = lease.creator_id
     AND gateway.installation_id = lease.worker_id
     AND gateway.connection_id = lease.connection_id
   WHERE lease.deployment_id = input_deployment_id
     AND lease.creator_id = input_creator_id
     AND lease.worker_id = input_worker_id
     AND lease.fence = input_fence
     AND lease.state = 'ACTIVE'
     AND lease.expires_at > clock_timestamp() + interval '3 seconds'
     AND installation.revoked_at IS NULL
     AND gateway.state = 'ACTIVE'
     AND gateway.expires_at > clock_timestamp() + interval '3 seconds'
   FOR SHARE OF lease, installation, gateway;
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
    now() + pg_catalog.make_interval(secs => input_ttl_seconds)
  )
  ON CONFLICT (consumer_subject_id, idempotency_key) DO NOTHING
  RETURNING agent_conversations.created_at, agent_conversations.expires_at
       INTO created_at_value, expires_at_value;

  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO public.broker_outbox (
    command_id, creator_id, target_worker_id, invocation_id, consumer_subject_id,
    conversation_id, deployment_id, assignment_lease_id, assignment_fence,
    command_type, dedupe_key, state, next_attempt_at, expires_at,
    payload_contract_version, visible_transcript_digest,
    visible_transcript_key_id, visible_transcript_key_version,
    visible_transcript_key_ref, original_worker_session_id, original_connection_id
  ) VALUES (
    created_command_id, input_creator_id, input_worker_id, NULL, input_consumer_id,
    created_conversation_id, input_deployment_id, current_lease_id, input_fence,
    'conversation.open', 'conversation:' || created_conversation_id::text || ':open',
    'PENDING', now(), current_lease_expires_at,
    1, input_visible_transcript_digest,
    input_visible_transcript_key_id, input_visible_transcript_key_version,
    input_visible_transcript_key_ref, current_worker_session_id, current_connection_id
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
$create_open_v2$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.creator_agent_create_opening_conversation_v2(
  uuid, uuid, uuid, uuid, uuid, uuid, text, text, uuid, bigint, integer,
  text, text, bigint, text
) FROM PUBLIC;

-- The v0 create routine stays in the migration ledger for audit only. A stale
-- Consumer binary cannot create an unclaimable open command after this cutover.
REVOKE ALL ON FUNCTION public.creator_agent_create_opening_conversation(
  uuid, uuid, uuid, uuid, uuid, uuid, text, text, uuid, bigint, integer
) FROM PUBLIC, combo_api, combo_worker, combo_runtime,
  combo_agent_api, combo_agent_broker, combo_agent_reconciler,
  combo_agent_consumer_api, combo_agent_maintenance;

DO $create_open_v2_definer_owner_gate$
DECLARE
  trusted_owner boolean;
BEGIN
  SELECT procedure.prosecdef AND (role.rolsuper OR role.rolbypassrls)
    INTO trusted_owner
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS role ON role.oid = procedure.proowner
   WHERE procedure.oid = pg_catalog.to_regprocedure(
     'creator_agent_create_opening_conversation_v2(uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid,bigint,integer,text,text,bigint,text)'
   );
  IF trusted_owner IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'Creator Agent create-open v2 authority requires a SUPERUSER or BYPASSRLS owner'
      USING ERRCODE = '42501';
  END IF;
END
$create_open_v2_definer_owner_gate$;

GRANT EXECUTE ON FUNCTION public.creator_agent_create_opening_conversation_v2(
  uuid, uuid, uuid, uuid, uuid, uuid, text, text, uuid, bigint, integer,
  text, text, bigint, text
) TO combo_agent_consumer_api;

-- ===================== broker compatibility audit reason =====================

ALTER TABLE public.worker_auth_security_events
  DROP CONSTRAINT worker_auth_security_events_reason_code_check,
  DROP CONSTRAINT ck_worker_auth_security_events_reason,
  ADD CONSTRAINT worker_auth_security_events_reason_code_check CHECK (
    reason_code IN (
      'CHALLENGE_ALREADY_CONSUMED',
      'WORKER_REGISTRATION_INCOMPATIBLE',
      'WORKER_VERSION_INCOMPATIBLE',
      'PROTOCOL_INCOMPATIBLE',
      'CODEX_RUNTIME_INCOMPATIBLE',
      'CODEX_PROTOCOL_INCOMPATIBLE',
      'ISOLATION_INCOMPATIBLE',
      'BROKER_CONTRACT_INCOMPATIBLE'
    )
  ),
  ADD CONSTRAINT ck_worker_auth_security_events_reason CHECK (
    (
      event_type = 'CHALLENGE_REPLAY'
      AND reason_code = 'CHALLENGE_ALREADY_CONSUMED'
    )
    OR
    (
      event_type = 'WORKER_INCOMPATIBLE'
      AND reason_code IN (
        'WORKER_REGISTRATION_INCOMPATIBLE',
        'WORKER_VERSION_INCOMPATIBLE',
        'PROTOCOL_INCOMPATIBLE',
        'CODEX_RUNTIME_INCOMPATIBLE',
        'CODEX_PROTOCOL_INCOMPATIBLE',
        'ISOLATION_INCOMPATIBLE',
        'BROKER_CONTRACT_INCOMPATIBLE'
      )
      AND original_session_id IS NULL
    )
  );
