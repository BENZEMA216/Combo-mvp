-- ADR-VNEXT-006: authoritative Conversation turn/history admission.
--
-- This is a Test-only quiescent exact-release-tuple cutover, not a rolling expand migration.
-- Drain/stop the old combo_agent_api writer before applying it, then deploy the migration and
-- matching CloudJournal binary as one release tuple.  Revoking the old direct Message/Conversation
-- column grants makes an old binary fail closed; rollback requires database restore or forward fix.
-- This migration is append-only in the source ledger and moves the final resource decision into
-- one database-owned USER Message admission capability.
-- A rejected candidate persists only the low-sensitivity Conversation suspension marker; the
-- Message row is skipped before any Invocation, Event, or Outbox row can exist.

ALTER TABLE public.agent_conversations
  ADD COLUMN context_limit_reached_at timestamptz,
  ADD CONSTRAINT ck_agent_conversations_context_limit_marker CHECK (
    context_limit_reached_at IS NULL
    OR (
      context_limit_reached_at >= created_at
      AND state IN ('SUSPENDED', 'CLOSING', 'CLOSED', 'FAILED', 'EXPIRED')
    )
  );

COMMENT ON COLUMN public.agent_conversations.context_limit_reached_at IS
  'Cloud-time ADR-VNEXT-006 marker. Non-NULL means the Conversation is permanently read-only because its pinned turn or visible-history policy was exhausted.';

-- Preserve every transition installed through 0014 and add one monotonic marker edge.  The
-- marker may be created only with IDLE -> SUSPENDED and is never cleared or rewritten.
CREATE OR REPLACE FUNCTION public.enforce_creator_agent_conversation_transition()
RETURNS trigger AS $conversation_transition$
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
  IF OLD.context_limit_reached_at IS NOT NULL
     AND NEW.context_limit_reached_at IS DISTINCT FROM OLD.context_limit_reached_at THEN
    RAISE EXCEPTION 'context limit marker is immutable once set'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.context_limit_reached_at IS NULL
     AND NEW.context_limit_reached_at IS NOT NULL
     AND (
       OLD.state <> 'IDLE'
       OR NEW.state <> 'SUSPENDED'
       OR NEW.context_limit_reached_at < OLD.created_at
     ) THEN
    RAISE EXCEPTION 'context limit marker requires the exact IDLE to SUSPENDED edge'
      USING ERRCODE = '23514';
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
$conversation_transition$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_conversation_transition() FROM PUBLIC;

-- Keep the table trigger structural.  A SECURITY DEFINER caller changes current_user to its
-- trusted owner, and PostgreSQL reports a superuser as a member of every role; service authority
-- therefore derives only from the non-privileged session_user login (including audited member
-- logins that SET ROLE combo_agent_api).
CREATE OR REPLACE FUNCTION public.enforce_creator_agent_message_insert_authority()
RETURNS trigger AS $message_insert_authority$
DECLARE
  uses_api_authority boolean;
  uses_broker_authority boolean;
  privileged_session boolean;
BEGIN
  SELECT session_role.rolsuper OR session_role.rolbypassrls,
         session_user = 'combo_agent_api'
           OR (
             NOT (session_role.rolsuper OR session_role.rolbypassrls)
             AND pg_catalog.pg_has_role(session_user, 'combo_agent_api', 'MEMBER')
           ),
         session_user = 'combo_agent_broker'
           OR (
             NOT (session_role.rolsuper OR session_role.rolbypassrls)
             AND pg_catalog.pg_has_role(session_user, 'combo_agent_broker', 'MEMBER')
           )
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
$message_insert_authority$ LANGUAGE plpgsql
   SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_message_insert_authority() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_creator_agent_message_insert_authority()
  TO combo_agent_api, combo_agent_broker;

-- AES-256-GCM emits exactly one ciphertext byte per plaintext byte and stores the 16-byte tag in
-- content_auth_tag.  While content_algorithm is fixed to aes-256-gcm/v1, summing ciphertext octets
-- is therefore the database-owned visible UTF-8 byte count; no caller-provided count is accepted.
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
AS $admit_user_message$
DECLARE
  uses_api_authority boolean;
  uses_broker_authority boolean;
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
  SELECT session_user = 'combo_agent_api'
           OR (
             NOT (session_role.rolsuper OR session_role.rolbypassrls)
             AND pg_catalog.pg_has_role(session_user, 'combo_agent_api', 'MEMBER')
           ),
         session_user = 'combo_agent_broker'
           OR (
             NOT (session_role.rolsuper OR session_role.rolbypassrls)
             AND pg_catalog.pg_has_role(session_user, 'combo_agent_broker', 'MEMBER')
           )
    INTO uses_api_authority, uses_broker_authority
    FROM pg_catalog.pg_roles AS session_role
   WHERE session_role.rolname = session_user;
  IF COALESCE(uses_api_authority, false)
     AND COALESCE(uses_broker_authority, false) THEN
    RAISE EXCEPTION 'USER Message admission authority is ambiguous'
      USING ERRCODE = '42501';
  END IF;
  IF uses_api_authority IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'USER Message admission requires the API authority'
      USING ERRCODE = '42501';
  END IF;
  IF input_creator_id IS DISTINCT FROM
       NULLIF(current_setting('app.creator_id', true), '')::uuid
     OR input_consumer_id IS DISTINCT FROM
       NULLIF(current_setting('app.consumer_id', true), '')::uuid THEN
    RAISE EXCEPTION 'USER Message admission requires exact tenant authority'
      USING ERRCODE = '42501';
  END IF;
  IF input_message_id IS NULL
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
     OR input_invocation_id IS NULL THEN
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
$admit_user_message$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.creator_agent_admit_user_message_v1(
  uuid, uuid, uuid, uuid, uuid, text, uuid, integer, timestamptz,
  text, text, text, bytea, bytea, bytea,
  text, text, integer, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.creator_agent_admit_user_message_v1(
  uuid, uuid, uuid, uuid, uuid, text, uuid, integer, timestamptz,
  text, text, text, bytea, bytea, bytea,
  text, text, integer, uuid
) TO combo_agent_api;

-- API callers can no longer bypass the narrow admission function with column INSERT.  Broker's
-- existing ASSISTANT-only authority and deferred exact-terminal-chain trigger remain unchanged.
REVOKE INSERT ON public.agent_messages FROM combo_agent_api;
REVOKE INSERT (
  id, conversation_id, creator_id, consumer_subject_id, turn_no, role,
  client_message_id, content_algorithm, content_key_id, content_nonce,
  content_ciphertext, content_auth_tag, content_cipher_digest, content_digest,
  content_aad_version, invocation_id
) ON public.agent_messages FROM combo_agent_api;
REVOKE UPDATE (state, next_turn_no, last_activity_at)
  ON public.agent_conversations FROM combo_agent_api;

DO $context_admission_definer_owner_gate$
DECLARE
  trusted_owner boolean;
BEGIN
  SELECT procedure.prosecdef AND (role.rolsuper OR role.rolbypassrls)
    INTO trusted_owner
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS role ON role.oid = procedure.proowner
   WHERE procedure.oid = 'public.creator_agent_admit_user_message_v1(uuid,uuid,uuid,uuid,uuid,text,uuid,integer,timestamptz,text,text,text,bytea,bytea,bytea,text,text,integer,uuid)'::regprocedure;
  IF trusted_owner IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'context admission authority requires a SUPERUSER or BYPASSRLS owner'
      USING ERRCODE = '55000';
  END IF;
END;
$context_admission_definer_owner_gate$;
