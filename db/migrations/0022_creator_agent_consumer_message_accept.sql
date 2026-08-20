-- 0022 · Consumer-only full Invocation acceptance capability.
--
-- The public Runtime still connects only as combo_agent_consumer_api. It never receives
-- combo_agent_api membership or direct business-table DML. This append-only migration adds one
-- narrow full-accept SECURITY DEFINER and keeps the 0021 USER admission primitive ACL-private to
-- the outer Consumer wrapper. Input ciphertext/requestDigest are future KMS products; this E2
-- capability neither creates AEAD nor proves an HTTP/header contract or any dispatch path.
--
-- Future Runtime code obtains input_user_message_id from the existing combo_runtime-authorized
-- gen_uuid_v7() call before KMS sealing so AAD can bind the exact Message ID. The outer function
-- validates UUIDv7 shape, uniqueness, tenant and every pinned Conversation fact, but PostgreSQL
-- cannot prove the provenance of a syntactically valid caller-supplied UUID.

-- ADR-VNEXT-033 applies only to fresh Consumer writes. Existing pre-ADR rows remain readable and
-- replayable; non-Consumer maintenance/upgrade fixtures do not redefine the public contract.
CREATE OR REPLACE FUNCTION public.enforce_creator_agent_consumer_idempotency_v4()
RETURNS trigger AS $consumer_idempotency_v4$
BEGIN
  IF session_user = 'combo_agent_consumer_api'
     AND NEW.idempotency_key::text !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'fresh Consumer idempotency key must use UUIDv4'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$consumer_idempotency_v4$ LANGUAGE plpgsql
   SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_consumer_idempotency_v4() FROM PUBLIC;

CREATE TRIGGER agent_conversations_consumer_idempotency_v4
BEFORE INSERT ON public.agent_conversations
FOR EACH ROW EXECUTE FUNCTION public.enforce_creator_agent_consumer_idempotency_v4();

-- Treat the exact Consumer full wrapper as API-like only inside the trusted outer transaction.
-- The role has no table INSERT privilege, so a direct DML attempt is rejected before this trigger.
CREATE OR REPLACE FUNCTION public.enforce_creator_agent_message_insert_authority()
RETURNS trigger AS $message_insert_authority$
DECLARE
  uses_api_authority boolean;
  uses_consumer_accept_authority boolean;
  uses_broker_authority boolean;
  privileged_session boolean;
  uses_api_like_authority boolean;
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
         uses_consumer_accept_authority, uses_broker_authority
    FROM pg_catalog.pg_roles AS session_role
   WHERE session_role.rolname = session_user;

  IF COALESCE(privileged_session, false) THEN
    RETURN NEW;
  END IF;
  IF (COALESCE(uses_api_authority, false) AND COALESCE(uses_consumer_accept_authority, false))
     OR (
       (COALESCE(uses_api_authority, false) OR COALESCE(uses_consumer_accept_authority, false))
       AND COALESCE(uses_broker_authority, false)
     ) THEN
    RAISE EXCEPTION 'Message insert authority is ambiguous'
      USING ERRCODE = '42501';
  END IF;
  uses_api_like_authority :=
    COALESCE(uses_api_authority, false) OR COALESCE(uses_consumer_accept_authority, false);
  IF uses_api_like_authority AND (
    NEW.role IS DISTINCT FROM 'USER'
    OR NEW.client_message_id IS NULL
    OR NEW.invocation_id IS NULL
    OR NEW.creator_id IS DISTINCT FROM
         NULLIF(current_setting('app.creator_id', true), '')::uuid
    OR NEW.consumer_subject_id IS DISTINCT FROM
         NULLIF(current_setting('app.consumer_id', true), '')::uuid
  ) THEN
    RAISE EXCEPTION 'API-like authority may insert only a tenant-bound USER Message'
      USING ERRCODE = '42501';
  ELSIF COALESCE(uses_broker_authority, false) AND (
    NEW.role IS DISTINCT FROM 'ASSISTANT'
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
$message_insert_authority$ LANGUAGE plpgsql
   SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_message_insert_authority() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_creator_agent_message_insert_authority()
  TO combo_agent_api, combo_agent_broker;

-- Deferred exact-chain validation must recognize the Consumer outer wrapper explicitly. It may
-- not depend on a SUPERUSER owner being reported as a member of every application role.
CREATE OR REPLACE FUNCTION public.enforce_creator_agent_message_accept_chain()
RETURNS trigger AS $message_accept_chain$
DECLARE
  uses_api_authority boolean;
  uses_consumer_accept_authority boolean;
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
         uses_consumer_accept_authority, uses_broker_authority
    FROM pg_catalog.pg_roles AS session_role
   WHERE session_role.rolname = session_user;

  IF COALESCE(privileged_session, false) THEN
    RETURN NEW;
  END IF;
  IF (COALESCE(uses_api_authority, false) AND COALESCE(uses_consumer_accept_authority, false))
     OR (
       (COALESCE(uses_api_authority, false) OR COALESCE(uses_consumer_accept_authority, false))
       AND COALESCE(uses_broker_authority, false)
     ) THEN
    RAISE EXCEPTION 'Message exact-chain authority is ambiguous'
      USING ERRCODE = '42501';
  END IF;
  uses_api_like_authority :=
    COALESCE(uses_api_authority, false) OR COALESCE(uses_consumer_accept_authority, false);

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
$message_accept_chain$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_message_accept_chain() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_creator_agent_message_accept_chain()
  TO combo_agent_api, combo_agent_broker;

CREATE OR REPLACE FUNCTION public.enforce_creator_agent_api_invocation_insert()
RETURNS trigger AS $api_invocation_insert$
DECLARE
  privileged_session boolean;
  uses_api_authority boolean;
  uses_consumer_accept_authority boolean;
  uses_api_like_authority boolean;
BEGIN
  SELECT session_role.rolsuper OR session_role.rolbypassrls,
         session_user = 'combo_agent_api'
           OR (
             NOT (session_role.rolsuper OR session_role.rolbypassrls)
             AND pg_catalog.pg_has_role(session_user, 'combo_agent_api', 'MEMBER')
           ),
         session_user = 'combo_agent_consumer_api'
           AND NOT (session_role.rolsuper OR session_role.rolbypassrls)
    INTO privileged_session, uses_api_authority, uses_consumer_accept_authority
    FROM pg_catalog.pg_roles AS session_role
   WHERE session_role.rolname = session_user;

  IF COALESCE(privileged_session, false) THEN
    RETURN NEW;
  END IF;
  IF COALESCE(uses_api_authority, false)
     AND COALESCE(uses_consumer_accept_authority, false) THEN
    RAISE EXCEPTION 'Invocation insert authority is ambiguous'
      USING ERRCODE = '42501';
  END IF;
  uses_api_like_authority :=
    COALESCE(uses_api_authority, false) OR COALESCE(uses_consumer_accept_authority, false);
  IF uses_api_like_authority AND (
    NEW.state IS DISTINCT FROM 'ACCEPTED'
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
    RAISE EXCEPTION 'API-like authority may insert only a pure ACCEPTED Invocation request'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$api_invocation_insert$ LANGUAGE plpgsql
   SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_api_invocation_insert() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_creator_agent_api_invocation_insert()
  TO combo_agent_api;

CREATE OR REPLACE FUNCTION public.enforce_creator_agent_api_prepare_outbox_insert()
RETURNS trigger AS $api_prepare_outbox_insert$
DECLARE
  privileged_session boolean;
  uses_api_authority boolean;
  uses_consumer_accept_authority boolean;
  uses_api_like_authority boolean;
  exact_accepted_request boolean;
BEGIN
  SELECT session_role.rolsuper OR session_role.rolbypassrls,
         session_user = 'combo_agent_api'
           OR (
             NOT (session_role.rolsuper OR session_role.rolbypassrls)
             AND pg_catalog.pg_has_role(session_user, 'combo_agent_api', 'MEMBER')
           ),
         session_user = 'combo_agent_consumer_api'
           AND NOT (session_role.rolsuper OR session_role.rolbypassrls)
    INTO privileged_session, uses_api_authority, uses_consumer_accept_authority
    FROM pg_catalog.pg_roles AS session_role
   WHERE session_role.rolname = session_user;

  IF COALESCE(privileged_session, false) THEN
    RETURN NEW;
  END IF;
  IF COALESCE(uses_api_authority, false)
     AND COALESCE(uses_consumer_accept_authority, false) THEN
    RAISE EXCEPTION 'prepare Outbox insert authority is ambiguous'
      USING ERRCODE = '42501';
  END IF;
  uses_api_like_authority :=
    COALESCE(uses_api_authority, false) OR COALESCE(uses_consumer_accept_authority, false);
  IF COALESCE(uses_consumer_accept_authority, false)
     AND NEW.command_type = 'conversation.open' THEN
    -- The existing conversation-open insert trigger and create-v2 SECURITY DEFINER remain the
    -- exact authority. This guard must not reinterpret that separate Consumer capability.
    RETURN NEW;
  END IF;
  IF COALESCE(uses_consumer_accept_authority, false)
     AND NEW.command_type IS DISTINCT FROM 'invocation.prepare' THEN
    RAISE EXCEPTION 'Consumer authority may insert only conversation.open or invocation.prepare'
      USING ERRCODE = '42501';
  END IF;
  IF uses_api_like_authority THEN
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

    IF NEW.command_type IS DISTINCT FROM 'invocation.prepare'
       OR NEW.invocation_id IS NULL
       OR NEW.consumer_subject_id IS NULL
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
       OR NOT COALESCE(exact_accepted_request, false) THEN
      RAISE EXCEPTION 'API-like authority may insert only the exact initial invocation.prepare command'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$api_prepare_outbox_insert$ LANGUAGE plpgsql
   SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_api_prepare_outbox_insert() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_creator_agent_api_prepare_outbox_insert()
  TO combo_agent_api, combo_agent_broker;

CREATE OR REPLACE FUNCTION public.enforce_creator_agent_api_accepted_event_insert()
RETURNS trigger AS $api_accepted_event_insert$
DECLARE
  privileged_session boolean;
  uses_api_authority boolean;
  uses_consumer_accept_authority boolean;
  uses_api_like_authority boolean;
BEGIN
  SELECT session_role.rolsuper OR session_role.rolbypassrls,
         session_user = 'combo_agent_api'
           OR (
             NOT (session_role.rolsuper OR session_role.rolbypassrls)
             AND pg_catalog.pg_has_role(session_user, 'combo_agent_api', 'MEMBER')
           ),
         session_user = 'combo_agent_consumer_api'
           AND NOT (session_role.rolsuper OR session_role.rolbypassrls)
    INTO privileged_session, uses_api_authority, uses_consumer_accept_authority
    FROM pg_catalog.pg_roles AS session_role
   WHERE session_role.rolname = session_user;

  IF COALESCE(privileged_session, false) THEN
    RETURN NEW;
  END IF;
  IF COALESCE(uses_api_authority, false)
     AND COALESCE(uses_consumer_accept_authority, false) THEN
    RAISE EXCEPTION 'accepted Event insert authority is ambiguous'
      USING ERRCODE = '42501';
  END IF;
  uses_api_like_authority :=
    COALESCE(uses_api_authority, false) OR COALESCE(uses_consumer_accept_authority, false);
  IF uses_api_like_authority AND (
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
$api_accepted_event_insert$ LANGUAGE plpgsql
   SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_api_accepted_event_insert() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_creator_agent_api_accepted_event_insert()
  TO combo_agent_api, combo_agent_broker, combo_agent_reconciler;

-- ACL-private shared USER admission core. Only trusted-owner wrappers may execute it; public and
-- every application role are revoked below. It retains all 0021 candidate, policy, turn, history,
-- marker and deadline checks while removing caller-role selection from the shared mutation body.
CREATE OR REPLACE FUNCTION public.creator_agent_admit_user_message_core_v1(
  input_message_id uuid,
  input_conversation_id uuid,
  input_creator_id uuid,
  input_consumer_id uuid,
  input_agent_version_id uuid,
  input_agent_version_digest text,
  input_target_worker_id uuid,
  input_turn_no integer,
  input_deadline_at timestamptz,
  input_client_message_id text,
  input_content_algorithm text,
  input_content_key_id text,
  input_content_nonce bytea,
  input_content_ciphertext bytea,
  input_content_auth_tag bytea,
  input_content_cipher_digest text,
  input_content_digest text,
  input_content_aad_version integer,
  input_invocation_id uuid
)
RETURNS TABLE(admission_outcome text)
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $message_admission_core$
DECLARE
  conversation_agent_version_id uuid;
  conversation_agent_version_digest text;
  conversation_assigned_worker_id uuid;
  conversation_state text;
  conversation_next_turn_no integer;
  context_limit_reached_at_value timestamptz;
  max_conversation_turns_text text;
  max_visible_history_bytes_text text;
  max_conversation_turns_type text;
  max_visible_history_bytes_type text;
  max_conversation_turns integer;
  max_visible_history_bytes integer;
  accepted_user_turns integer;
  minimum_user_turn integer;
  maximum_user_turn integer;
  visible_history_bytes bigint;
  history_algorithms_valid boolean;
  admission_now timestamptz;
  limit_reached_at timestamptz;
BEGIN
  IF input_creator_id IS DISTINCT FROM
       NULLIF(current_setting('app.creator_id', true), '')::uuid
     OR input_consumer_id IS DISTINCT FROM
       NULLIF(current_setting('app.consumer_id', true), '')::uuid THEN
    RAISE EXCEPTION 'USER Message admission requires exact tenant authority'
      USING ERRCODE = '42501';
  END IF;
  IF input_message_id IS NULL
     OR input_message_id::text !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR input_conversation_id IS NULL
     OR input_creator_id IS NULL
     OR input_consumer_id IS NULL
     OR input_agent_version_id IS NULL
     OR input_agent_version_digest IS NULL
     OR input_agent_version_digest !~ '^[a-f0-9]{64}$'
     OR input_target_worker_id IS NULL
     OR input_turn_no IS NULL OR input_turn_no NOT BETWEEN 1 AND 21
     OR input_deadline_at IS NULL
     OR input_client_message_id IS NULL
     OR pg_catalog.length(input_client_message_id) NOT BETWEEN 1 AND 256
     OR input_content_algorithm IS DISTINCT FROM 'aes-256-gcm/v1'
     OR input_content_key_id IS NULL
     OR pg_catalog.length(input_content_key_id) NOT BETWEEN 1 AND 256
     OR input_content_key_id !~ '^[-A-Za-z0-9_.:/]+$'
     OR input_content_nonce IS NULL OR pg_catalog.octet_length(input_content_nonce) <> 12
     OR input_content_ciphertext IS NULL
     OR pg_catalog.octet_length(input_content_ciphertext) NOT BETWEEN 1 AND 65536
     OR input_content_auth_tag IS NULL
     OR pg_catalog.octet_length(input_content_auth_tag) <> 16
     OR input_content_cipher_digest IS NULL
     OR input_content_cipher_digest !~ '^[a-f0-9]{64}$'
     OR input_content_cipher_digest IS DISTINCT FROM pg_catalog.encode(
       public.digest(
         input_content_nonce || input_content_ciphertext || input_content_auth_tag,
         'sha256'
       ),
       'hex'
     )
     OR input_content_digest IS NULL
     OR input_content_digest !~ '^hmac-sha256:[a-f0-9]{64}$'
     OR input_content_aad_version IS DISTINCT FROM 1
     OR input_invocation_id IS NULL
     OR input_invocation_id::text !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'USER Message admission candidate shape is invalid'
      USING ERRCODE = '23514';
  END IF;

  SELECT conversation.agent_version_id,
         conversation.version_digest,
         conversation.assigned_worker_id,
         conversation.state,
         conversation.next_turn_no,
         conversation.context_limit_reached_at,
         version.runtime_policy->>'maxConversationTurns',
         version.runtime_policy->>'maxVisibleHistoryBytes',
         pg_catalog.jsonb_typeof(version.runtime_policy->'maxConversationTurns'),
         pg_catalog.jsonb_typeof(version.runtime_policy->'maxVisibleHistoryBytes')
    INTO conversation_agent_version_id,
         conversation_agent_version_digest,
         conversation_assigned_worker_id,
         conversation_state,
         conversation_next_turn_no,
         context_limit_reached_at_value,
         max_conversation_turns_text,
         max_visible_history_bytes_text,
         max_conversation_turns_type,
         max_visible_history_bytes_type
    FROM public.agent_conversations AS conversation
    JOIN public.agent_versions AS version
      ON version.id = conversation.agent_version_id
     AND version.agent_id = conversation.agent_id
     AND version.creator_id = conversation.creator_id
     AND version.version_digest = conversation.version_digest
   WHERE conversation.id = input_conversation_id
     AND conversation.creator_id = input_creator_id
     AND conversation.consumer_subject_id = input_consumer_id
   FOR UPDATE OF conversation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'context admission requires exact tenant and pinned Version authority'
      USING ERRCODE = '23514';
  END IF;
  admission_now := clock_timestamp();
  IF conversation_agent_version_id IS DISTINCT FROM input_agent_version_id
     OR conversation_agent_version_digest IS DISTINCT FROM input_agent_version_digest
     OR conversation_assigned_worker_id IS DISTINCT FROM input_target_worker_id THEN
    RAISE EXCEPTION 'USER Message admission lost pinned Version or Worker authority'
      USING ERRCODE = '55000';
  END IF;
  IF max_conversation_turns_type IS DISTINCT FROM 'number'
     OR max_visible_history_bytes_type IS DISTINCT FROM 'number'
     OR max_conversation_turns_text IS NULL
     OR max_conversation_turns_text !~ '^(?:[1-9]|1[0-9]|20)$'
     OR max_visible_history_bytes_text IS NULL
     OR max_visible_history_bytes_text !~ '^[1-9][0-9]{0,4}$'
     OR max_visible_history_bytes_text::integer > 65536 THEN
    RAISE EXCEPTION 'pinned AgentVersion context policy is invalid'
      USING ERRCODE = '23514';
  END IF;
  max_conversation_turns := max_conversation_turns_text::integer;
  max_visible_history_bytes := max_visible_history_bytes_text::integer;

  SELECT COALESCE(
           pg_catalog.sum(pg_catalog.octet_length(message.content_ciphertext)),
           0
         )::bigint,
         COALESCE(pg_catalog.bool_and(message.content_algorithm = 'aes-256-gcm/v1'), true)
    INTO visible_history_bytes, history_algorithms_valid
    FROM public.agent_messages AS message
   WHERE message.conversation_id = input_conversation_id
     AND message.creator_id = input_creator_id
     AND message.consumer_subject_id = input_consumer_id
     AND message.role IN ('USER', 'ASSISTANT');
  SELECT pg_catalog.count(*)::integer,
         COALESCE(pg_catalog.min(message.turn_no), 0),
         COALESCE(pg_catalog.max(message.turn_no), 0)
    INTO accepted_user_turns, minimum_user_turn, maximum_user_turn
    FROM public.agent_messages AS message
   WHERE message.conversation_id = input_conversation_id
     AND message.creator_id = input_creator_id
     AND message.consumer_subject_id = input_consumer_id
     AND message.role = 'USER';
  IF history_algorithms_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'visible history contains an unsupported content algorithm'
      USING ERRCODE = '23514';
  END IF;
  IF (accepted_user_turns = 0 AND (minimum_user_turn <> 0 OR maximum_user_turn <> 0))
     OR (
       accepted_user_turns > 0
       AND (minimum_user_turn <> 1 OR maximum_user_turn <> accepted_user_turns)
     ) THEN
    RAISE EXCEPTION 'Conversation USER turn facts are not contiguous from one'
      USING ERRCODE = '55000';
  END IF;
  IF conversation_next_turn_no <> accepted_user_turns + 1
     OR input_turn_no <> accepted_user_turns + 1 THEN
    RAISE EXCEPTION 'Conversation turn projection does not match immutable USER facts'
      USING ERRCODE = '55000';
  END IF;
  IF context_limit_reached_at_value IS NOT NULL THEN
    IF conversation_state <> 'SUSPENDED' THEN
      RAISE EXCEPTION 'context-limit Conversation left its stable SUSPENDED state'
        USING ERRCODE = '55000';
    END IF;
    RETURN QUERY SELECT 'CONTEXT_LIMIT'::text;
    RETURN;
  END IF;
  IF conversation_state <> 'IDLE' THEN
    RAISE EXCEPTION 'Conversation is not IDLE for USER Message admission'
      USING ERRCODE = '55000';
  END IF;
  IF input_deadline_at <= admission_now
     OR input_deadline_at > admission_now + interval '120 seconds' THEN
    RAISE EXCEPTION 'USER Message admission lost Cloud deadline authority'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.agent_messages AS message
     WHERE message.id = input_message_id
        OR (
          message.conversation_id = input_conversation_id
          AND message.client_message_id = input_client_message_id
        )
        OR (
          message.content_key_id = input_content_key_id
          AND message.content_nonce = input_content_nonce
        )
        OR (message.invocation_id = input_invocation_id AND message.role = 'USER')
  ) OR EXISTS (
    SELECT 1 FROM public.agent_invocations AS invocation
     WHERE invocation.id = input_invocation_id
  ) THEN
    RAISE EXCEPTION 'USER Message admission candidate conflicts with durable identity'
      USING ERRCODE = '23505';
  END IF;

  IF accepted_user_turns >= max_conversation_turns
     OR visible_history_bytes + pg_catalog.octet_length(input_content_ciphertext)
          > max_visible_history_bytes THEN
    limit_reached_at := admission_now;
    UPDATE public.agent_conversations AS conversation
       SET state = 'SUSPENDED',
           context_limit_reached_at = limit_reached_at
     WHERE conversation.id = input_conversation_id
       AND conversation.creator_id = input_creator_id
       AND conversation.consumer_subject_id = input_consumer_id
       AND conversation.state = 'IDLE'
       AND conversation.context_limit_reached_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'context admission lost the locked Conversation authority'
        USING ERRCODE = '40001';
    END IF;
    RETURN QUERY SELECT 'CONTEXT_LIMIT'::text;
    RETURN;
  END IF;

  IF input_deadline_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'USER Message admission deadline elapsed before durable INSERT'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.agent_messages (
    id, conversation_id, creator_id, consumer_subject_id, turn_no, role,
    client_message_id, content_algorithm, content_key_id, content_nonce,
    content_ciphertext, content_auth_tag, content_cipher_digest, content_digest,
    content_aad_version, invocation_id
  ) VALUES (
    input_message_id, input_conversation_id, input_creator_id, input_consumer_id,
    input_turn_no, 'USER', input_client_message_id, input_content_algorithm,
    input_content_key_id, input_content_nonce, input_content_ciphertext,
    input_content_auth_tag, input_content_cipher_digest, input_content_digest,
    input_content_aad_version, input_invocation_id
  );
  UPDATE public.agent_conversations AS conversation
     SET state = 'BUSY',
         next_turn_no = conversation.next_turn_no + 1,
         last_activity_at = GREATEST(conversation.last_activity_at, clock_timestamp())
   WHERE conversation.id = input_conversation_id
     AND conversation.creator_id = input_creator_id
     AND conversation.consumer_subject_id = input_consumer_id
     AND conversation.state = 'IDLE'
     AND conversation.next_turn_no = input_turn_no
     AND conversation.context_limit_reached_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER Message admission lost the locked Conversation projection'
      USING ERRCODE = '40001';
  END IF;
  RETURN QUERY SELECT 'ADMITTED'::text;
END;
$message_admission_core$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.creator_agent_admit_user_message_core_v1(
  uuid, uuid, uuid, uuid, uuid, text, uuid, integer, timestamptz,
  text, text, text, bytea, bytea, bytea, text, text, integer, uuid
) FROM PUBLIC, combo_agent_api, combo_agent_consumer_api, combo_agent_broker,
  combo_agent_reconciler, combo_agent_maintenance;

-- Preserve the existing combo_agent_api entrypoint while delegating the mutation to the private
-- core. Consumer never receives this wrapper's EXECUTE privilege.
CREATE OR REPLACE FUNCTION public.creator_agent_admit_user_message_v1(
  input_message_id uuid,
  input_conversation_id uuid,
  input_creator_id uuid,
  input_consumer_id uuid,
  input_agent_version_id uuid,
  input_agent_version_digest text,
  input_target_worker_id uuid,
  input_turn_no integer,
  input_deadline_at timestamptz,
  input_client_message_id text,
  input_content_algorithm text,
  input_content_key_id text,
  input_content_nonce bytea,
  input_content_ciphertext bytea,
  input_content_auth_tag bytea,
  input_content_cipher_digest text,
  input_content_digest text,
  input_content_aad_version integer,
  input_invocation_id uuid
)
RETURNS TABLE(admission_outcome text)
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $api_message_admission$
DECLARE
  privileged_session boolean;
  uses_api_authority boolean;
  uses_consumer_accept_authority boolean;
  uses_broker_authority boolean;
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
         uses_consumer_accept_authority, uses_broker_authority
    FROM pg_catalog.pg_roles AS session_role
   WHERE session_role.rolname = session_user;
  IF COALESCE(uses_api_authority, false)
     AND (
       COALESCE(uses_consumer_accept_authority, false)
       OR COALESCE(uses_broker_authority, false)
     ) THEN
    RAISE EXCEPTION 'USER Message admission authority is ambiguous'
      USING ERRCODE = '42501';
  END IF;
  IF COALESCE(privileged_session, false)
     OR uses_api_authority IS DISTINCT FROM true
     OR COALESCE(uses_consumer_accept_authority, false)
     OR COALESCE(uses_broker_authority, false) THEN
    RAISE EXCEPTION 'USER Message admission requires the unambiguous API authority'
      USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT core.admission_outcome
    FROM public.creator_agent_admit_user_message_core_v1(
      input_message_id, input_conversation_id, input_creator_id, input_consumer_id,
      input_agent_version_id, input_agent_version_digest, input_target_worker_id,
      input_turn_no, input_deadline_at, input_client_message_id,
      input_content_algorithm, input_content_key_id, input_content_nonce,
      input_content_ciphertext, input_content_auth_tag, input_content_cipher_digest,
      input_content_digest, input_content_aad_version, input_invocation_id
    ) AS core;
END;
$api_message_admission$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.creator_agent_admit_user_message_v1(
  uuid, uuid, uuid, uuid, uuid, text, uuid, integer, timestamptz,
  text, text, text, bytea, bytea, bytea, text, text, integer, uuid
) FROM PUBLIC, combo_agent_consumer_api, combo_agent_broker,
  combo_agent_reconciler, combo_agent_maintenance;
GRANT EXECUTE ON FUNCTION public.creator_agent_admit_user_message_v1(
  uuid, uuid, uuid, uuid, uuid, text, uuid, integer, timestamptz,
  text, text, text, bytea, bytea, bytea, text, text, integer, uuid
) TO combo_agent_api;

CREATE OR REPLACE FUNCTION public.creator_agent_accept_consumer_message_v1(
  input_conversation_id uuid,
  input_consumer_id uuid,
  input_expected_creator_id uuid,
  input_expected_agent_version_id uuid,
  input_expected_version_digest text,
  input_user_message_id uuid,
  input_client_message_id text,
  input_request_digest text,
  input_content_algorithm text,
  input_content_key_id text,
  input_content_nonce bytea,
  input_content_ciphertext bytea,
  input_content_auth_tag bytea,
  input_content_cipher_digest text,
  input_content_digest text,
  input_content_aad_version integer
)
RETURNS TABLE(
  accept_outcome text,
  user_message_id uuid,
  invocation_id uuid,
  invocation_state text,
  outbox_command_id uuid,
  source_event_id uuid,
  deadline_at timestamptz
)
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $consumer_message_accept$
DECLARE
  session_is_privileged boolean;
  session_has_api_membership boolean;
  session_has_broker_membership boolean;
  session_has_any_membership boolean;
  existing_invocation record;
  conversation_deployment_id uuid;
  conversation_creator_id uuid;
  conversation_agent_version_id uuid;
  conversation_version_digest text;
  conversation_worker_id uuid;
  conversation_next_turn_no integer;
  conversation_state text;
  conversation_context_limit_at timestamptz;
  conversation_expires_at timestamptz;
  max_turn_seconds_text text;
  max_turn_seconds_type text;
  max_turn_seconds integer;
  current_lease_expires_at timestamptz;
  current_gateway_expires_at timestamptz;
  version_authority_live boolean;
  generated_invocation_id uuid;
  generated_outbox_command_id uuid;
  generated_source_event_id uuid;
  generated_deadline_at timestamptz;
  accepted_at timestamptz;
  context_admission_outcome text;
  projection record;
  admission_now timestamptz;
BEGIN
  SELECT role.rolsuper OR role.rolbypassrls,
         pg_catalog.pg_has_role(session_user, 'combo_agent_api', 'MEMBER'),
         pg_catalog.pg_has_role(session_user, 'combo_agent_broker', 'MEMBER'),
         EXISTS (
           SELECT 1
             FROM pg_catalog.pg_auth_members AS membership
            WHERE membership.member = role.oid
               OR membership.roleid = role.oid
         )
    INTO session_is_privileged, session_has_api_membership,
         session_has_broker_membership, session_has_any_membership
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = session_user;
  IF session_user <> 'combo_agent_consumer_api'
     OR COALESCE(session_is_privileged, true)
     OR COALESCE(session_has_api_membership, true)
     OR COALESCE(session_has_broker_membership, true)
     OR COALESCE(session_has_any_membership, true) THEN
    RAISE EXCEPTION 'Consumer message accept requires the exact isolated Consumer authority'
      USING ERRCODE = '42501';
  END IF;
  IF input_consumer_id IS DISTINCT FROM
       NULLIF(current_setting('app.consumer_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Consumer message accept requires exact Consumer tenant authority'
      USING ERRCODE = '42501';
  END IF;
  IF input_conversation_id IS NULL
     OR input_conversation_id::text !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR input_consumer_id IS NULL
     OR input_expected_creator_id IS NULL
     OR input_expected_agent_version_id IS NULL
     OR input_expected_version_digest IS NULL
     OR input_expected_version_digest !~ '^[a-f0-9]{64}$'
     OR input_user_message_id IS NULL
     OR input_user_message_id::text !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR input_client_message_id IS NULL
     OR pg_catalog.length(input_client_message_id) NOT BETWEEN 1 AND 256
     OR input_request_digest IS NULL
     OR input_request_digest !~ '^hmac-sha256:[a-f0-9]{64}$'
     OR input_content_algorithm IS DISTINCT FROM 'aes-256-gcm/v1'
     OR input_content_key_id IS NULL
     OR pg_catalog.length(input_content_key_id) NOT BETWEEN 1 AND 256
     OR input_content_key_id !~ '^[-A-Za-z0-9_.:/]+$'
     OR input_content_nonce IS NULL OR pg_catalog.octet_length(input_content_nonce) <> 12
     OR input_content_ciphertext IS NULL
     OR pg_catalog.octet_length(input_content_ciphertext) NOT BETWEEN 1 AND 65536
     OR input_content_auth_tag IS NULL OR pg_catalog.octet_length(input_content_auth_tag) <> 16
     OR input_content_cipher_digest IS NULL
     OR input_content_cipher_digest !~ '^[a-f0-9]{64}$'
     OR input_content_cipher_digest IS DISTINCT FROM pg_catalog.encode(
       public.digest(
         input_content_nonce || input_content_ciphertext || input_content_auth_tag,
         'sha256'
       ),
       'hex'
     )
     OR input_content_digest IS NULL
     OR input_content_digest !~ '^hmac-sha256:[a-f0-9]{64}$'
     OR input_content_aad_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Consumer message accept candidate shape is invalid'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      input_conversation_id::text || ':' || input_client_message_id,
      0
    )
  );

  SELECT invocation.id,
         invocation.user_message_id,
         invocation.request_digest,
         invocation.state,
         invocation.deadline_at,
         prepare_command.command_id AS outbox_command_id,
         accepted_event.source_event_id
    INTO existing_invocation
    FROM public.agent_invocations AS invocation
    JOIN public.agent_conversations AS conversation
      ON conversation.id = invocation.conversation_id
     AND conversation.creator_id = invocation.creator_id
     AND conversation.consumer_subject_id = invocation.consumer_subject_id
    LEFT JOIN public.broker_outbox AS prepare_command
      ON prepare_command.invocation_id = invocation.id
     AND prepare_command.creator_id = invocation.creator_id
     AND prepare_command.consumer_subject_id = invocation.consumer_subject_id
     AND prepare_command.command_type = 'invocation.prepare'
    LEFT JOIN public.agent_invocation_events AS accepted_event
      ON accepted_event.invocation_id = invocation.id
     AND accepted_event.creator_id = invocation.creator_id
     AND accepted_event.consumer_subject_id = invocation.consumer_subject_id
     AND accepted_event.journal_seq = 1
     AND accepted_event.source = 'API'
     AND accepted_event.event_type = 'invocation.accepted'
   WHERE invocation.conversation_id = input_conversation_id
     AND invocation.consumer_subject_id = input_consumer_id
     AND invocation.client_message_id = input_client_message_id;
  IF FOUND THEN
    IF existing_invocation.request_digest IS DISTINCT FROM input_request_digest THEN
      RETURN QUERY SELECT
        'CONFLICT'::text, NULL::uuid, NULL::uuid, NULL::text,
        NULL::uuid, NULL::uuid, NULL::timestamptz;
      RETURN;
    END IF;
    IF existing_invocation.outbox_command_id IS NULL
       OR existing_invocation.source_event_id IS NULL
       OR existing_invocation.source_event_id !~
            '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Consumer message replay durable accept chain is incomplete'
        USING ERRCODE = '55000';
    END IF;
    RETURN QUERY SELECT
      'REPLAY'::text,
      existing_invocation.user_message_id::uuid,
      existing_invocation.id::uuid,
      existing_invocation.state::text,
      existing_invocation.outbox_command_id::uuid,
      existing_invocation.source_event_id::uuid,
      existing_invocation.deadline_at::timestamptz;
    RETURN;
  END IF;

  -- ADR-VNEXT-033 freezes fresh public idempotency identity to canonical lowercase UUIDv4.
  -- Replay stays before this check so already-durable pre-ADR text/v7 keys remain recoverable.
  IF input_client_message_id !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'fresh Consumer message idempotency key must be canonical UUIDv4'
      USING ERRCODE = '23514';
  END IF;

  -- Resolve only the immutable lock identity before taking the shared Deployment lock order used
  -- by Version SECURITY transitions. This first read grants no fresh execution authority.
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
    RAISE EXCEPTION 'Consumer message accept Conversation authority is unavailable'
      USING ERRCODE = '42501';
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
        'Consumer message accept Version authority is concurrently changing; retry transaction'
        USING ERRCODE = '40001';
  END;
  IF version_authority_live IS DISTINCT FROM true THEN
    RETURN QUERY SELECT
      'UNAVAILABLE'::text, NULL::uuid, NULL::uuid, NULL::text,
      NULL::uuid, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT conversation.deployment_id,
         conversation.creator_id,
         conversation.agent_version_id,
         conversation.version_digest,
         conversation.assigned_worker_id,
         conversation.next_turn_no,
         conversation.state,
         conversation.context_limit_reached_at,
         conversation.expires_at,
         version.runtime_policy->>'maxTurnSeconds',
         pg_catalog.jsonb_typeof(version.runtime_policy->'maxTurnSeconds'),
         lease.expires_at,
         gateway.expires_at
    INTO conversation_deployment_id,
         conversation_creator_id,
         conversation_agent_version_id,
         conversation_version_digest,
         conversation_worker_id,
         conversation_next_turn_no,
         conversation_state,
         conversation_context_limit_at,
         conversation_expires_at,
         max_turn_seconds_text,
         max_turn_seconds_type,
         current_lease_expires_at,
         current_gateway_expires_at
    FROM public.agent_conversations AS conversation
    JOIN public.agent_versions AS version
      ON version.id = conversation.agent_version_id
     AND version.agent_id = conversation.agent_id
     AND version.creator_id = conversation.creator_id
     AND version.version_digest = conversation.version_digest
    JOIN public.deployments AS deployment
      ON deployment.id = conversation.deployment_id
     AND deployment.agent_id = conversation.agent_id
     AND deployment.creator_id = conversation.creator_id
     AND deployment.desired_state = 'ONLINE'
     AND deployment.observed_state = 'ONLINE'
     AND deployment.observed_worker_id = conversation.assigned_worker_id
     AND deployment.observed_generation = deployment.generation
    JOIN public.worker_installations AS installation
      ON installation.id = conversation.assigned_worker_id
     AND installation.creator_id = conversation.creator_id
     AND installation.revoked_at IS NULL
    JOIN public.worker_leases AS lease
      ON lease.deployment_id = conversation.deployment_id
     AND lease.creator_id = conversation.creator_id
     AND lease.worker_id = conversation.assigned_worker_id
     AND lease.fence = deployment.lease_fence
     AND lease.state = 'ACTIVE'
    JOIN public.worker_gateway_sessions AS gateway
      ON gateway.creator_id = lease.creator_id
     AND gateway.installation_id = lease.worker_id
     AND gateway.connection_id = lease.connection_id
     AND gateway.state = 'ACTIVE'
   WHERE conversation.id = input_conversation_id
     AND conversation.consumer_subject_id = input_consumer_id
   FOR UPDATE OF conversation
   FOR SHARE OF deployment, installation, lease, gateway;
  IF NOT FOUND THEN
    RETURN QUERY SELECT
      'UNAVAILABLE'::text, NULL::uuid, NULL::uuid, NULL::text,
      NULL::uuid, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;
  admission_now := clock_timestamp();
  IF conversation_creator_id IS DISTINCT FROM input_expected_creator_id
     OR conversation_agent_version_id IS DISTINCT FROM input_expected_agent_version_id
     OR conversation_version_digest IS DISTINCT FROM input_expected_version_digest THEN
    RETURN QUERY SELECT
      'UNAVAILABLE'::text, NULL::uuid, NULL::uuid, NULL::text,
      NULL::uuid, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;
  IF max_turn_seconds_type IS DISTINCT FROM 'number'
     OR max_turn_seconds_text IS NULL
     OR max_turn_seconds_text !~ '^(?:[1-9]|[1-9][0-9]|1[01][0-9]|120)$' THEN
    RAISE EXCEPTION 'Consumer message accept pinned turn deadline policy is invalid'
      USING ERRCODE = '23514';
  END IF;
  max_turn_seconds := max_turn_seconds_text::integer;
  IF (conversation_context_limit_at IS NULL AND (
        conversation_state <> 'IDLE'
        OR conversation_expires_at <= admission_now
        OR conversation_worker_id IS NULL
        OR conversation_next_turn_no NOT BETWEEN 1 AND 21
        OR current_lease_expires_at <= admission_now + interval '3 seconds'
        OR current_gateway_expires_at <= admission_now + interval '3 seconds'
      ))
     OR (
       conversation_context_limit_at IS NOT NULL
       AND conversation_state <> 'SUSPENDED'
     ) THEN
    RETURN QUERY SELECT
      'UNAVAILABLE'::text, NULL::uuid, NULL::uuid, NULL::text,
      NULL::uuid, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  PERFORM set_config('app.creator_id', conversation_creator_id::text, true);
  generated_invocation_id := public.gen_uuid_v7();
  generated_outbox_command_id := public.gen_uuid_v7();
  generated_source_event_id := public.gen_uuid_v7();
  accepted_at := admission_now;
  generated_deadline_at := accepted_at + max_turn_seconds * interval '1 second';

  SELECT core.admission_outcome
    INTO context_admission_outcome
    FROM public.creator_agent_admit_user_message_core_v1(
      input_user_message_id,
      input_conversation_id,
      conversation_creator_id,
      input_consumer_id,
      conversation_agent_version_id,
      conversation_version_digest,
      conversation_worker_id,
      conversation_next_turn_no,
      generated_deadline_at,
      input_client_message_id,
      input_content_algorithm,
      input_content_key_id,
      input_content_nonce,
      input_content_ciphertext,
      input_content_auth_tag,
      input_content_cipher_digest,
      input_content_digest,
      input_content_aad_version,
      generated_invocation_id
    ) AS core;
  IF context_admission_outcome = 'CONTEXT_LIMIT' THEN
    RETURN QUERY SELECT
      'CONTEXT_LIMIT'::text, NULL::uuid, NULL::uuid, NULL::text,
      NULL::uuid, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;
  IF context_admission_outcome IS DISTINCT FROM 'ADMITTED' THEN
    RAISE EXCEPTION 'Consumer message accept received an unknown admission outcome'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.agent_invocations (
    id, conversation_id, creator_id, consumer_subject_id, agent_version_id,
    user_message_id, client_message_id, request_digest, state, deadline_at
  ) VALUES (
    generated_invocation_id, input_conversation_id, conversation_creator_id,
    input_consumer_id, conversation_agent_version_id, input_user_message_id,
    input_client_message_id, input_request_digest, 'ACCEPTED', generated_deadline_at
  );

  INSERT INTO public.agent_invocation_events (
    invocation_id, creator_id, consumer_subject_id, journal_seq, source,
    source_event_id, event_type, payload, occurred_at
  ) VALUES (
    generated_invocation_id, conversation_creator_id, input_consumer_id,
    1, 'API', generated_source_event_id::text, 'invocation.accepted',
    '{"state":"ACCEPTED"}'::jsonb, accepted_at
  );

  INSERT INTO public.broker_outbox (
    command_id, creator_id, target_worker_id, invocation_id, consumer_subject_id,
    command_type, dedupe_key, state, next_attempt_at, expires_at
  ) VALUES (
    generated_outbox_command_id, conversation_creator_id, conversation_worker_id,
    generated_invocation_id, input_consumer_id, 'invocation.prepare',
    'invocation:' || generated_invocation_id::text || ':prepare',
    'PENDING', accepted_at, generated_deadline_at
  );

  SELECT conversation.state, conversation.next_turn_no
    INTO projection
    FROM public.agent_conversations AS conversation
   WHERE conversation.id = input_conversation_id
     AND conversation.creator_id = conversation_creator_id
     AND conversation.consumer_subject_id = input_consumer_id;
  IF projection.state IS DISTINCT FROM 'BUSY'
     OR projection.next_turn_no IS DISTINCT FROM conversation_next_turn_no + 1 THEN
    RAISE EXCEPTION 'Consumer message accept lost the atomic Conversation projection'
      USING ERRCODE = '55000';
  END IF;

  RETURN QUERY SELECT
    'ADMITTED'::text,
    input_user_message_id,
    generated_invocation_id,
    'ACCEPTED'::text,
    generated_outbox_command_id,
    generated_source_event_id,
    generated_deadline_at;
END;
$consumer_message_accept$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.creator_agent_accept_consumer_message_v1(
  uuid, uuid, uuid, uuid, text, uuid, text, text,
  text, text, bytea, bytea, bytea, text, text, integer
) FROM PUBLIC, combo_agent_api, combo_agent_broker,
  combo_agent_reconciler, combo_agent_maintenance;
GRANT EXECUTE ON FUNCTION public.creator_agent_accept_consumer_message_v1(
  uuid, uuid, uuid, uuid, text, uuid, text, text,
  text, text, bytea, bytea, bytea, text, text, integer
) TO combo_agent_consumer_api;

-- Reassert zero direct mutation authority. Consumer can call only the existing create-v2 definer
-- and the new full-accept wrapper; it cannot call the private core or 0021 API wrapper.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON
  public.agent_messages,
  public.agent_invocations,
  public.agent_invocation_events,
  public.broker_outbox,
  public.agent_conversations
FROM combo_agent_consumer_api;

DO $consumer_message_accept_owner_gate$
DECLARE
  function_signature text;
  trusted_owner boolean;
  expected_owner oid;
  actual_owner oid;
BEGIN
  FOREACH function_signature IN ARRAY ARRAY[
    'public.enforce_creator_agent_message_accept_chain()',
    'public.creator_agent_admit_user_message_core_v1(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,timestamptz,text,text,text,bytea,bytea,bytea,text,text,integer,uuid)',
    'public.creator_agent_admit_user_message_v1(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,timestamptz,text,text,text,bytea,bytea,bytea,text,text,integer,uuid)',
    'public.creator_agent_accept_consumer_message_v1(uuid,uuid,uuid,uuid,text,uuid,text,text,text,text,bytea,bytea,bytea,text,text,integer)'
  ]
  LOOP
    SELECT procedure.prosecdef AND (role.rolsuper OR role.rolbypassrls), procedure.proowner
      INTO trusted_owner, actual_owner
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_roles AS role ON role.oid = procedure.proowner
     WHERE procedure.oid = function_signature::regprocedure;
    IF trusted_owner IS DISTINCT FROM true THEN
      RAISE EXCEPTION
        'Consumer message accept function % requires a SUPERUSER or BYPASSRLS owner',
        function_signature
        USING ERRCODE = '42501';
    END IF;
    IF expected_owner IS NULL THEN
      expected_owner := actual_owner;
    ELSIF actual_owner IS DISTINCT FROM expected_owner THEN
      RAISE EXCEPTION 'Consumer message accept wrappers and private core require one owner'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;
END;
$consumer_message_accept_owner_gate$;

DO $consumer_message_accept_acl_gate$
DECLARE
  table_name text;
  consumer_role_oid oid;
BEGIN
  SELECT role.oid
    INTO consumer_role_oid
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = 'combo_agent_consumer_api';
  IF consumer_role_oid IS NULL THEN
    RAISE EXCEPTION 'Consumer message accept requires combo_agent_consumer_api'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
     WHERE membership.member = consumer_role_oid
        OR membership.roleid = consumer_role_oid
  ) THEN
    RAISE EXCEPTION 'Consumer message accept role must have zero role membership'
      USING ERRCODE = '42501';
  END IF;
  FOREACH table_name IN ARRAY ARRAY[
    'public.agent_messages',
    'public.agent_invocations',
    'public.agent_invocation_events',
    'public.broker_outbox',
    'public.agent_conversations'
  ]
  LOOP
    IF pg_catalog.has_table_privilege(
         'combo_agent_consumer_api', table_name, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR pg_catalog.has_any_column_privilege(
         'combo_agent_consumer_api', table_name, 'INSERT,UPDATE,REFERENCES'
       ) THEN
      RAISE EXCEPTION 'Consumer message accept role has forbidden direct DML on %', table_name
        USING ERRCODE = '42501';
    END IF;
  END LOOP;
  IF NOT pg_catalog.has_function_privilege(
       'combo_agent_consumer_api',
       'public.creator_agent_accept_consumer_message_v1(uuid,uuid,uuid,uuid,text,uuid,text,text,text,text,bytea,bytea,bytea,text,text,integer)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'combo_agent_consumer_api',
       'public.creator_agent_admit_user_message_core_v1(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,timestamptz,text,text,text,bytea,bytea,bytea,text,text,integer,uuid)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'combo_agent_consumer_api',
       'public.creator_agent_admit_user_message_v1(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,timestamptz,text,text,text,bytea,bytea,bytea,text,text,integer,uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Consumer message accept role function ACL is not exact'
      USING ERRCODE = '42501';
  END IF;
END;
$consumer_message_accept_acl_gate$;
