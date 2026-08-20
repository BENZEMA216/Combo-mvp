-- 0024 · Database-owned explicit reconciliation-root admission.
--
-- Explicit Reconciler roots are admitted only through one SECURITY DEFINER. The authority
-- serializes the logical UUIDv7 globally, locks the incoming Invocation and Conversation, and
-- classifies an immutable existing root before it mutates the projection. Broker-owned
-- late-prepared/late-started roots retain their 0023 authority.

LOCK TABLE public.agent_invocations,
           public.agent_invocation_events,
           public.creator_agent_journal_integrity_alerts
  IN SHARE ROW EXCLUSIVE MODE;

-- Every recognized Reconciler source identity has one global logical UUID. Reject ambiguous
-- legacy data while writers are locked, then make the invariant race-safe for Broker prefixes
-- as well as explicit roots.
DO $reconciliation_source_zero_legacy$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.agent_invocation_events AS event
     WHERE event.source = 'RECONCILER'
       AND event.event_type = 'invocation.reconciling'
       AND event.source_event_id !~
         '^(?:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|late-(?:prepared|started):[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$'
  ) THEN
    RAISE EXCEPTION '0024 requires canonical logical UUIDv7 reconciliation root identities'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT logical_source_event_id
      FROM (
        SELECT CASE
                 WHEN event.source_event_id ~
                      '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                   THEN event.source_event_id
                 WHEN event.source_event_id ~
                      '^late-(?:prepared|started):[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                   THEN pg_catalog.split_part(event.source_event_id, ':', 2)
               END AS logical_source_event_id
          FROM public.agent_invocation_events AS event
         WHERE event.source = 'RECONCILER'
           AND (
             event.source_event_id ~
               '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
             OR event.source_event_id ~
               '^late-(?:prepared|started):[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           )
      ) AS normalized
     GROUP BY logical_source_event_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '0024 found duplicate global logical Reconciler source identities'
      USING ERRCODE = '55000';
  END IF;
END;
$reconciliation_source_zero_legacy$;

CREATE UNIQUE INDEX uq_agent_invocation_events_reconciler_logical_source
  ON public.agent_invocation_events (
    (CASE
       WHEN source_event_id ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         THEN source_event_id
       WHEN source_event_id ~
            '^late-(?:prepared|started):[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         THEN pg_catalog.split_part(source_event_id, ':', 2)
     END)
  )
  WHERE source = 'RECONCILER'
    AND (
      source_event_id ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR source_event_id ~
        '^late-(?:prepared|started):[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    );

CREATE OR REPLACE FUNCTION public.creator_agent_begin_reconciliation_v2(
  input_creator_id uuid,
  input_consumer_subject_id uuid,
  input_conversation_id uuid,
  input_invocation_id uuid,
  input_source_event_id uuid,
  input_reason text
)
RETURNS TABLE (
  outcome text,
  reconciliation_started_at timestamptz,
  alert_id uuid,
  alert_replayed boolean
)
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $begin_reconciliation$
DECLARE
  session_is_untrusted boolean;
  incoming record;
  root_event record;
  existing_event record;
  logical_root_source_event_id uuid;
  admitted_at timestamptz;
  source_identity jsonb;
  existing_identity jsonb;
  received_identity jsonb;
  source_identity_digest text;
  existing_identity_digest text;
  received_identity_digest text;
  durable_alert_id uuid;
  durable_alert_replayed boolean;
  admission_collided boolean := false;
BEGIN
  -- Authentication and tenant context are checked before validation, locks, or global reads.
  SELECT role.rolsuper OR role.rolbypassrls
    INTO session_is_untrusted
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = session_user;
  IF session_user <> 'combo_agent_reconciler'
     OR COALESCE(session_is_untrusted, true) THEN
    RAISE EXCEPTION 'Reconciliation admission requires exact Reconciler session authority'
      USING ERRCODE = '42501';
  END IF;
  IF input_creator_id IS DISTINCT FROM
       NULLIF(current_setting('app.creator_id', true), '')::uuid
     OR input_consumer_subject_id IS DISTINCT FROM
       NULLIF(current_setting('app.consumer_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Reconciliation admission tenant context mismatch'
      USING ERRCODE = '42501';
  END IF;

  IF input_conversation_id IS NULL
     OR input_invocation_id IS NULL
     OR input_source_event_id IS NULL
     OR input_reason IS NULL
     OR input_source_event_id::text !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR input_reason NOT IN (
       'START_DISPATCH_UNKNOWN',
       'HOST_EVIDENCE_LOST',
       'MODEL_ATTEMPT_UNKNOWN',
       'CANCEL_NOT_CONFIRMED',
       'JOURNAL_LOST'
     ) THEN
    RETURN QUERY SELECT 'INVARIANT_FAILED'::text, NULL::timestamptz, NULL::uuid, NULL::boolean;
    RETURN;
  END IF;

  -- This key is deliberately independent of tenant and Invocation. It orders every admission
  -- which claims the same public logical source identity.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'combo.creator-agent-reconciliation-logical-source/1:' || input_source_event_id::text,
      0
    )
  );

  SELECT invocation.id,
         invocation.conversation_id,
         invocation.creator_id,
         invocation.consumer_subject_id,
         invocation.state,
         invocation.reconciliation_reason,
         invocation.reconciliation_started_at,
         conversation.state AS conversation_state
    INTO incoming
    FROM public.agent_invocations AS invocation
    JOIN public.agent_conversations AS conversation
      ON conversation.id = invocation.conversation_id
     AND conversation.creator_id = invocation.creator_id
     AND conversation.consumer_subject_id = invocation.consumer_subject_id
   WHERE invocation.id = input_invocation_id
     AND invocation.conversation_id = input_conversation_id
     AND invocation.creator_id = input_creator_id
     AND invocation.consumer_subject_id = input_consumer_subject_id
   FOR UPDATE OF invocation, conversation;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'UNAVAILABLE'::text, NULL::timestamptz, NULL::uuid, NULL::boolean;
    RETURN;
  END IF;

  source_identity := pg_catalog.jsonb_build_object(
    'domain', 'combo:vnext:journal-source-identity:v1',
    'protocol', 'combo.creator-agent-reconciliation-source-admission',
    'version', 2,
    'creatorId', input_creator_id::text,
    'consumerId', input_consumer_subject_id::text,
    'conversationId', input_conversation_id::text,
    'invocationId', input_invocation_id::text,
    'source', 'RECONCILER',
    'logicalSourceEventId', input_source_event_id::text
  );
  source_identity_digest := pg_catalog.encode(
    public.digest(pg_catalog.convert_to(source_identity::text, 'UTF8'), 'sha256'),
    'hex'
  );

  SELECT event.source_event_id,
         event.source,
         event.event_type,
         event.payload,
         event.occurred_at,
         event.journal_seq,
         event.source_fact_digest,
         event.broker_command_id,
         event.creator_id,
         event.consumer_subject_id,
         event.invocation_id
    INTO root_event
    FROM public.agent_invocation_events AS event
   WHERE event.invocation_id = input_invocation_id
     AND event.creator_id = input_creator_id
     AND event.consumer_subject_id = input_consumer_subject_id
     AND event.source = 'RECONCILER'
     AND event.event_type = 'invocation.reconciling';

  IF FOUND THEN
    IF root_event.source_event_id ~
       '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      logical_root_source_event_id := root_event.source_event_id::uuid;
    ELSIF root_event.source_event_id ~
       '^late-(?:prepared|started):[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      logical_root_source_event_id :=
        pg_catalog.split_part(root_event.source_event_id, ':', 2)::uuid;
    ELSE
      RETURN QUERY SELECT 'INVARIANT_FAILED'::text, NULL::timestamptz, NULL::uuid, NULL::boolean;
      RETURN;
    END IF;

    IF incoming.reconciliation_reason IS NULL
       OR incoming.reconciliation_reason NOT IN (
         'START_DISPATCH_UNKNOWN',
         'HOST_EVIDENCE_LOST',
         'MODEL_ATTEMPT_UNKNOWN',
         'CANCEL_NOT_CONFIRMED',
         'JOURNAL_LOST'
       )
       OR incoming.reconciliation_started_at IS NULL
       OR incoming.state NOT IN (
         'RECONCILING', 'RUNNING', 'CANCEL_REQUESTED',
         'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN'
       )
       OR root_event.source IS DISTINCT FROM 'RECONCILER'
       OR root_event.event_type IS DISTINCT FROM 'invocation.reconciling'
       OR root_event.payload IS DISTINCT FROM pg_catalog.jsonb_build_object(
         'state', 'RECONCILING',
         'reason', incoming.reconciliation_reason
       )
       OR root_event.occurred_at IS DISTINCT FROM incoming.reconciliation_started_at
       OR root_event.journal_seq IS NULL
       OR root_event.journal_seq < 1
       OR root_event.source_fact_digest IS NOT NULL
       OR root_event.broker_command_id IS NOT NULL THEN
      RETURN QUERY SELECT 'INVARIANT_FAILED'::text, NULL::timestamptz, NULL::uuid, NULL::boolean;
      RETURN;
    END IF;

    IF logical_root_source_event_id IS DISTINCT FROM input_source_event_id THEN
      RETURN QUERY SELECT 'SOURCE_DIFFERENT'::text, NULL::timestamptz, NULL::uuid, NULL::boolean;
      RETURN;
    END IF;

    IF incoming.reconciliation_reason IS DISTINCT FROM input_reason THEN
      existing_identity := pg_catalog.jsonb_build_object(
        'domain', 'combo:vnext:journal-event-body:v1',
        'protocol', 'combo.creator-agent-reconciliation-event',
        'version', 1,
        'creatorId', input_creator_id::text,
        'consumerId', input_consumer_subject_id::text,
        'conversationId', input_conversation_id::text,
        'invocationId', input_invocation_id::text,
        'source', 'RECONCILER',
        'logicalSourceEventId', input_source_event_id::text,
        'eventType', 'invocation.reconciling',
        'payload', root_event.payload
      );
      received_identity := pg_catalog.jsonb_build_object(
        'domain', 'combo:vnext:journal-event-body:v1',
        'protocol', 'combo.creator-agent-reconciliation-event',
        'version', 1,
        'creatorId', input_creator_id::text,
        'consumerId', input_consumer_subject_id::text,
        'conversationId', input_conversation_id::text,
        'invocationId', input_invocation_id::text,
        'source', 'RECONCILER',
        'logicalSourceEventId', input_source_event_id::text,
        'eventType', 'invocation.reconciling',
        'payload', pg_catalog.jsonb_build_object('state', 'RECONCILING', 'reason', input_reason)
      );
      existing_identity_digest := pg_catalog.encode(
        public.digest(pg_catalog.convert_to(existing_identity::text, 'UTF8'), 'sha256'),
        'hex'
      );
      received_identity_digest := pg_catalog.encode(
        public.digest(pg_catalog.convert_to(received_identity::text, 'UTF8'), 'sha256'),
        'hex'
      );
      SELECT alert.alert_id, alert.replayed
        INTO durable_alert_id, durable_alert_replayed
        FROM public.creator_agent_record_journal_integrity_alert_v1(
          input_creator_id,
          input_consumer_subject_id,
          input_invocation_id,
          'SOURCE_EVENT_CONFLICT',
          'RECONCILER',
          source_identity_digest,
          existing_identity_digest,
          received_identity_digest
        ) AS alert;
      IF durable_alert_id IS NULL OR durable_alert_replayed IS NULL THEN
        RAISE EXCEPTION 'Reconciliation conflict alert returned no durable outcome'
          USING ERRCODE = '55000';
      END IF;
      RETURN QUERY
        SELECT 'SECURITY_BLOCKED'::text, NULL::timestamptz,
               durable_alert_id, durable_alert_replayed;
      RETURN;
    END IF;

    RETURN QUERY
      SELECT 'EXACT'::text, incoming.reconciliation_started_at, NULL::uuid, NULL::boolean;
    RETURN;
  END IF;

  IF incoming.reconciliation_reason IS NOT NULL
     OR incoming.reconciliation_started_at IS NOT NULL THEN
    RETURN QUERY SELECT 'INVARIANT_FAILED'::text, NULL::timestamptz, NULL::uuid, NULL::boolean;
    RETURN;
  END IF;
  IF incoming.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN', 'EXPIRED') THEN
    RETURN QUERY SELECT 'TERMINAL'::text, NULL::timestamptz, NULL::uuid, NULL::boolean;
    RETURN;
  END IF;
  IF incoming.state NOT IN ('PERSISTED', 'STARTING', 'RUNNING', 'CANCEL_REQUESTED')
     OR incoming.conversation_state <> 'BUSY' THEN
    RETURN QUERY SELECT 'UNAVAILABLE'::text, NULL::timestamptz, NULL::uuid, NULL::boolean;
    RETURN;
  END IF;

  -- This read is intentionally global and RLS-independent. Only the canonical digests are ever
  -- copied into the incoming tenant's alert; no existing tenant, id, source, or payload returns.
  SELECT event.creator_id,
         event.consumer_subject_id,
         invocation.conversation_id,
         event.invocation_id,
         event.source,
         event.event_type,
         event.payload
    INTO existing_event
    FROM public.agent_invocation_events AS event
    JOIN public.agent_invocations AS invocation
      ON invocation.id = event.invocation_id
     AND invocation.creator_id = event.creator_id
     AND invocation.consumer_subject_id = event.consumer_subject_id
   WHERE event.source = 'RECONCILER'
     AND event.source_event_id IN (
       input_source_event_id::text,
       'late-prepared:' || input_source_event_id::text,
       'late-started:' || input_source_event_id::text
     )
   ORDER BY event.id
   LIMIT 1;
  IF FOUND THEN
    existing_identity := pg_catalog.jsonb_build_object(
      'domain', 'combo:vnext:journal-event-body:v1',
      'protocol', 'combo.creator-agent-reconciliation-event',
      'version', 1,
      'creatorId', existing_event.creator_id::text,
      'consumerId', existing_event.consumer_subject_id::text,
      'conversationId', existing_event.conversation_id::text,
      'invocationId', existing_event.invocation_id::text,
      'source', existing_event.source,
      'logicalSourceEventId', input_source_event_id::text,
      'eventType', existing_event.event_type,
      'payload', existing_event.payload
    );
    received_identity := pg_catalog.jsonb_build_object(
      'domain', 'combo:vnext:journal-event-body:v1',
      'protocol', 'combo.creator-agent-reconciliation-event',
      'version', 1,
      'creatorId', input_creator_id::text,
      'consumerId', input_consumer_subject_id::text,
      'conversationId', input_conversation_id::text,
      'invocationId', input_invocation_id::text,
      'source', 'RECONCILER',
      'logicalSourceEventId', input_source_event_id::text,
      'eventType', 'invocation.reconciling',
      'payload', pg_catalog.jsonb_build_object('state', 'RECONCILING', 'reason', input_reason)
    );
    existing_identity_digest := pg_catalog.encode(
      public.digest(pg_catalog.convert_to(existing_identity::text, 'UTF8'), 'sha256'),
      'hex'
    );
    received_identity_digest := pg_catalog.encode(
      public.digest(pg_catalog.convert_to(received_identity::text, 'UTF8'), 'sha256'),
      'hex'
    );
    SELECT alert.alert_id, alert.replayed
      INTO durable_alert_id, durable_alert_replayed
      FROM public.creator_agent_record_journal_integrity_alert_v1(
        input_creator_id,
        input_consumer_subject_id,
        input_invocation_id,
        'SOURCE_EVENT_CONFLICT',
        'RECONCILER',
        source_identity_digest,
        existing_identity_digest,
        received_identity_digest
      ) AS alert;
    IF durable_alert_id IS NULL OR durable_alert_replayed IS NULL THEN
      RAISE EXCEPTION 'Global reconciliation source alert returned no durable outcome'
        USING ERRCODE = '55000';
    END IF;
    RETURN QUERY
      SELECT 'SECURITY_BLOCKED'::text, NULL::timestamptz,
             durable_alert_id, durable_alert_replayed;
    RETURN;
  END IF;

  admitted_at := date_trunc('milliseconds', clock_timestamp());
  BEGIN
    UPDATE public.agent_invocations AS invocation
       SET state = 'RECONCILING',
           reconciliation_reason = input_reason,
           reconciliation_started_at = admitted_at
     WHERE invocation.id = input_invocation_id
       AND invocation.conversation_id = input_conversation_id
       AND invocation.creator_id = input_creator_id
       AND invocation.consumer_subject_id = input_consumer_subject_id
       AND invocation.state IN ('PERSISTED', 'STARTING', 'RUNNING', 'CANCEL_REQUESTED')
       AND invocation.reconciliation_reason IS NULL
       AND invocation.reconciliation_started_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'locked reconciliation projection changed unexpectedly'
        USING ERRCODE = '55000';
    END IF;

    INSERT INTO public.agent_invocation_events (
      invocation_id,
      creator_id,
      consumer_subject_id,
      journal_seq,
      source,
      source_event_id,
      event_type,
      payload,
      occurred_at
    )
    SELECT input_invocation_id,
           input_creator_id,
           input_consumer_subject_id,
           COALESCE(max(event.journal_seq), 0) + 1,
           'RECONCILER',
           input_source_event_id::text,
           'invocation.reconciling',
           pg_catalog.jsonb_build_object('state', 'RECONCILING', 'reason', input_reason),
           admitted_at
      FROM public.agent_invocation_events AS event
     WHERE event.invocation_id = input_invocation_id;
  EXCEPTION WHEN unique_violation THEN
    -- The subtransaction rolls the projection update back before classification is retried.
    admission_collided := true;
  END;

  IF admission_collided THEN
    SELECT event.creator_id,
           event.consumer_subject_id,
           invocation.conversation_id,
           event.invocation_id,
           event.source,
           event.event_type,
           event.payload
      INTO existing_event
      FROM public.agent_invocation_events AS event
      JOIN public.agent_invocations AS invocation
        ON invocation.id = event.invocation_id
       AND invocation.creator_id = event.creator_id
       AND invocation.consumer_subject_id = event.consumer_subject_id
     WHERE event.source = 'RECONCILER'
       AND event.source_event_id IN (
         input_source_event_id::text,
         'late-prepared:' || input_source_event_id::text,
         'late-started:' || input_source_event_id::text
       )
     ORDER BY event.id
     LIMIT 1;
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'INVARIANT_FAILED'::text, NULL::timestamptz, NULL::uuid, NULL::boolean;
      RETURN;
    END IF;

    existing_identity := pg_catalog.jsonb_build_object(
      'domain', 'combo:vnext:journal-event-body:v1',
      'protocol', 'combo.creator-agent-reconciliation-event',
      'version', 1,
      'creatorId', existing_event.creator_id::text,
      'consumerId', existing_event.consumer_subject_id::text,
      'conversationId', existing_event.conversation_id::text,
      'invocationId', existing_event.invocation_id::text,
      'source', existing_event.source,
      'logicalSourceEventId', input_source_event_id::text,
      'eventType', existing_event.event_type,
      'payload', existing_event.payload
    );
    received_identity := pg_catalog.jsonb_build_object(
      'domain', 'combo:vnext:journal-event-body:v1',
      'protocol', 'combo.creator-agent-reconciliation-event',
      'version', 1,
      'creatorId', input_creator_id::text,
      'consumerId', input_consumer_subject_id::text,
      'conversationId', input_conversation_id::text,
      'invocationId', input_invocation_id::text,
      'source', 'RECONCILER',
      'logicalSourceEventId', input_source_event_id::text,
      'eventType', 'invocation.reconciling',
      'payload', pg_catalog.jsonb_build_object('state', 'RECONCILING', 'reason', input_reason)
    );
    existing_identity_digest := pg_catalog.encode(
      public.digest(pg_catalog.convert_to(existing_identity::text, 'UTF8'), 'sha256'),
      'hex'
    );
    received_identity_digest := pg_catalog.encode(
      public.digest(pg_catalog.convert_to(received_identity::text, 'UTF8'), 'sha256'),
      'hex'
    );
    SELECT alert.alert_id, alert.replayed
      INTO durable_alert_id, durable_alert_replayed
      FROM public.creator_agent_record_journal_integrity_alert_v1(
        input_creator_id,
        input_consumer_subject_id,
        input_invocation_id,
        'SOURCE_EVENT_CONFLICT',
        'RECONCILER',
        source_identity_digest,
        existing_identity_digest,
        received_identity_digest
      ) AS alert;
    IF durable_alert_id IS NULL OR durable_alert_replayed IS NULL THEN
      RAISE EXCEPTION 'Raced reconciliation source alert returned no durable outcome'
        USING ERRCODE = '55000';
    END IF;
    RETURN QUERY
      SELECT 'SECURITY_BLOCKED'::text, NULL::timestamptz,
             durable_alert_id, durable_alert_replayed;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'ADMITTED'::text, admitted_at, NULL::uuid, NULL::boolean;
END;
$begin_reconciliation$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.creator_agent_begin_reconciliation_v2(
  uuid, uuid, uuid, uuid, uuid, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.creator_agent_begin_reconciliation_v2(
  uuid, uuid, uuid, uuid, uuid, text
) TO combo_agent_reconciler;

DO $reconciliation_admission_owner_gate$
DECLARE
  trusted_owner boolean;
BEGIN
  SELECT role.rolsuper OR role.rolbypassrls
    INTO trusted_owner
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS role ON role.oid = procedure.proowner
   WHERE procedure.oid =
     'public.creator_agent_begin_reconciliation_v2(uuid,uuid,uuid,uuid,uuid,text)'::regprocedure;
  IF trusted_owner IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Reconciliation admission definer requires SUPERUSER or BYPASSRLS owner'
      USING ERRCODE = '42501';
  END IF;
END;
$reconciliation_admission_owner_gate$;

-- Replace 0023's trigger at the same name. Direct explicit inserts from an old Reconciler binary
-- now fail: only SQL executed with the trusted admission definer's current_user may insert a
-- canonical UUIDv7 root. Broker prefix rules remain byte-for-byte equivalent.
CREATE OR REPLACE FUNCTION public.enforce_creator_agent_reconciling_root_event()
RETURNS trigger AS $reconciling_root_authority$
DECLARE
  privileged_session boolean;
  invocation_row record;
  exact_internal_fact boolean;
  admission_owner name;
BEGIN
  IF NEW.event_type <> 'invocation.reconciling' THEN
    RETURN NEW;
  END IF;

  SELECT role.rolsuper OR role.rolbypassrls
    INTO privileged_session
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = session_user;
  IF COALESCE(privileged_session, false) THEN
    RETURN NEW;
  END IF;
  IF session_user NOT IN ('combo_agent_broker', 'combo_agent_reconciler') THEN
    RAISE EXCEPTION 'reconciliation root Event requires Broker or Reconciler session authority'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.creator_id IS DISTINCT FROM
       NULLIF(current_setting('app.creator_id', true), '')::uuid
     OR NEW.consumer_subject_id IS DISTINCT FROM
       NULLIF(current_setting('app.consumer_id', true), '')::uuid THEN
    RAISE EXCEPTION 'reconciliation root Event tenant context mismatch'
      USING ERRCODE = '42501';
  END IF;

  SELECT invocation.state,
         invocation.reconciliation_reason,
         invocation.reconciliation_started_at
    INTO invocation_row
    FROM public.agent_invocations AS invocation
   WHERE invocation.id = NEW.invocation_id
     AND invocation.creator_id = NEW.creator_id
     AND invocation.consumer_subject_id = NEW.consumer_subject_id
   FOR UPDATE;
  IF NOT FOUND
     OR invocation_row.state <> 'RECONCILING'
     OR NEW.source <> 'RECONCILER'
     OR NEW.payload IS DISTINCT FROM pg_catalog.jsonb_build_object(
          'state', 'RECONCILING',
          'reason', invocation_row.reconciliation_reason
        )
     OR NEW.occurred_at IS DISTINCT FROM invocation_row.reconciliation_started_at
     OR NEW.source_fact_digest IS NOT NULL
     OR NEW.broker_command_id IS NOT NULL THEN
    RAISE EXCEPTION 'reconciliation root Event binding is not exact'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.source_event_id ~
     '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    SELECT role.rolname
      INTO admission_owner
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_roles AS role ON role.oid = procedure.proowner
     WHERE procedure.oid =
       'public.creator_agent_begin_reconciliation_v2(uuid,uuid,uuid,uuid,uuid,text)'::regprocedure;
    IF session_user <> 'combo_agent_reconciler'
       OR current_user = session_user
       OR current_user IS DISTINCT FROM admission_owner THEN
      RAISE EXCEPTION 'explicit reconciliation root requires v2 admission authority'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF session_user <> 'combo_agent_broker' THEN
    RAISE EXCEPTION 'Reconciler may not insert prefixed reconciliation roots'
      USING ERRCODE = '42501';
  END IF;
  SELECT EXISTS (
           SELECT 1
             FROM public.agent_invocation_events AS fact
            WHERE fact.invocation_id = NEW.invocation_id
              AND fact.creator_id = NEW.creator_id
              AND fact.consumer_subject_id = NEW.consumer_subject_id
              AND fact.source = 'WORKER'
              AND fact.event_type = 'invocation.persisted'
              AND fact.payload = '{"state":"PERSISTED"}'::jsonb
              AND NEW.source_event_id = 'late-prepared:' || fact.source_event_id
              AND NEW.journal_seq = fact.journal_seq + 1
              AND invocation_row.reconciliation_reason = 'START_DISPATCH_UNKNOWN'
         )
         OR EXISTS (
           SELECT 1
             FROM public.agent_invocation_events AS fact
            WHERE fact.invocation_id = NEW.invocation_id
              AND fact.creator_id = NEW.creator_id
              AND fact.consumer_subject_id = NEW.consumer_subject_id
              AND fact.source = 'WORKER'
              AND fact.event_type = 'invocation.started'
              AND fact.payload = '{"state":"RECONCILING"}'::jsonb
              AND NEW.source_event_id = 'late-started:' || fact.source_event_id
              AND NEW.journal_seq = fact.journal_seq + 1
              AND invocation_row.reconciliation_reason = 'CANCEL_NOT_CONFIRMED'
         )
    INTO exact_internal_fact;
  IF exact_internal_fact IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Broker reconciliation root requires exact late Worker fact identity'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$reconciling_root_authority$ LANGUAGE plpgsql
  SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_reconciling_root_event() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_creator_agent_reconciling_root_event()
  TO combo_agent_broker, combo_agent_reconciler;
