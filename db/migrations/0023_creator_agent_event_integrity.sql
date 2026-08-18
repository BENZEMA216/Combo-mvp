-- 0023 · Additive Event-integrity building block.
--
-- This migration closes two concrete reconciliation holes without claiming a complete Event
-- reducer: a late started fact that first moves an Invocation into RECONCILING now has one root
-- Event, and the single supported root -> RUNNING -> RECONCILING re-entry has its own durable
-- Event. The existing one-started-fact and one-root invariants remain unchanged.
--
-- The alert table is deliberately low-sensitivity and append-only. No payload, free-form error,
-- Prompt, answer, token, path, ciphertext, or raw sourceEventId can be stored. Conflict-path
-- application wiring and projection-digest replay remain future work.

LOCK TABLE public.agent_invocations, public.agent_invocation_events
  IN SHARE ROW EXCLUSIVE MODE;

-- The old code could create these two ambiguous shapes but cannot safely invent their missing
-- Event identity during an upgrade. Fail closed after locking writers instead of backfilling from
-- the mutable projection.
DO $event_integrity_zero_legacy$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.agent_invocations AS invocation
     WHERE invocation.state = 'RECONCILING'
       AND NOT EXISTS (
         SELECT 1
           FROM public.agent_invocation_events AS root
          WHERE root.invocation_id = invocation.id
            AND root.creator_id = invocation.creator_id
            AND root.consumer_subject_id = invocation.consumer_subject_id
            AND root.source = 'RECONCILER'
            AND root.event_type = 'invocation.reconciling'
            AND root.payload = jsonb_build_object(
              'state', 'RECONCILING',
              'reason', invocation.reconciliation_reason
            )
            AND root.occurred_at = invocation.reconciliation_started_at
       )
  ) THEN
    RAISE EXCEPTION
      '0023 requires zero RECONCILING projections without an exact root Event'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.agent_invocation_events AS started
     WHERE started.source = 'WORKER'
       AND started.event_type = 'invocation.started'
       AND started.payload = '{"state":"RECONCILING"}'::jsonb
       AND NOT EXISTS (
         SELECT 1
           FROM public.agent_invocation_events AS root
          WHERE root.invocation_id = started.invocation_id
            AND root.creator_id = started.creator_id
            AND root.consumer_subject_id = started.consumer_subject_id
            AND root.source = 'RECONCILER'
            AND root.event_type = 'invocation.reconciling'
       )
  ) THEN
    RAISE EXCEPTION
      '0023 cannot infer a missing late-started reconciliation root Event'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.agent_invocations AS invocation
      JOIN public.agent_invocation_events AS root
        ON root.invocation_id = invocation.id
       AND root.creator_id = invocation.creator_id
       AND root.consumer_subject_id = invocation.consumer_subject_id
       AND root.source = 'RECONCILER'
       AND root.event_type = 'invocation.reconciling'
      JOIN public.agent_invocation_events AS started
        ON started.invocation_id = invocation.id
       AND started.source = 'WORKER'
       AND started.event_type = 'invocation.started'
       AND started.payload = '{"state":"RUNNING"}'::jsonb
       AND started.journal_seq > root.journal_seq
     WHERE invocation.state = 'RECONCILING'
        OR (
          invocation.state = 'UNCERTAIN'
          AND EXISTS (
            SELECT 1
              FROM public.agent_invocation_events AS uncertain
             WHERE uncertain.invocation_id = invocation.id
               AND uncertain.source = 'RECONCILER'
               AND uncertain.event_type = 'invocation.uncertain'
               AND uncertain.payload =
                   '{"state":"UNCERTAIN","errorCode":"EXECUTION_STATE_UNKNOWN"}'::jsonb
               AND uncertain.journal_seq > started.journal_seq
          )
        )
  ) THEN
    RAISE EXCEPTION
      '0023 cannot infer a missing reconciliation re-entry Event'
      USING ERRCODE = '55000';
  END IF;
END;
$event_integrity_zero_legacy$;

ALTER TABLE public.agent_invocation_events
  DROP CONSTRAINT ck_agent_invocation_events_type;

ALTER TABLE public.agent_invocation_events
  ADD CONSTRAINT ck_agent_invocation_events_type CHECK (
    event_type IN (
      'invocation.accepted',
      'invocation.queued',
      'invocation.leased',
      'invocation.persisted',
      'invocation.started',
      'invocation.cancel_requested',
      'invocation.reconciling',
      'invocation.reconciling_resumed',
      'invocation.succeeded',
      'invocation.failed',
      'invocation.cancelled',
      'invocation.uncertain',
      'invocation.expired'
    )
  );

CREATE OR REPLACE FUNCTION public.creator_agent_event_payload_is_allowed(
  input_event_type text,
  input_payload jsonb
)
RETURNS boolean AS $event_payload$
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
    WHEN 'invocation.reconciling_resumed' THEN
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
      AND input_payload->>'messageId' ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
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
      AND input_payload->>'conversationId' ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND input_payload->>'invocationId' ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND input_payload->>'terminalState' IN (
        'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN', 'EXPIRED'
      )
      AND input_payload->>'occurredAt' ~
        '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$'
      AND CASE input_payload->>'terminalState'
        WHEN 'SUCCEEDED' THEN
          input_payload->>'assistantMessageId' ~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
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
$event_payload$ LANGUAGE sql IMMUTABLE STRICT;

REVOKE ALL ON FUNCTION public.creator_agent_event_payload_is_allowed(text, jsonb) FROM PUBLIC;

-- Root authority has three exact producers: an explicit UUIDv7 from Reconciler, or a Broker
-- projection immediately following the matching late-prepared/late-started Worker fact.
CREATE OR REPLACE FUNCTION public.enforce_creator_agent_reconciling_root_event()
RETURNS trigger AS $reconciling_root_authority$
DECLARE
  privileged_session boolean;
  invocation_row record;
  exact_internal_fact boolean;
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
     OR NEW.payload IS DISTINCT FROM jsonb_build_object(
          'state', 'RECONCILING',
          'reason', invocation_row.reconciliation_reason
        )
     OR NEW.occurred_at IS DISTINCT FROM invocation_row.reconciliation_started_at
     OR NEW.source_fact_digest IS NOT NULL
     OR NEW.broker_command_id IS NOT NULL THEN
    RAISE EXCEPTION 'reconciliation root Event binding is not exact'
      USING ERRCODE = '23514';
  END IF;

  IF session_user = 'combo_agent_reconciler' THEN
    IF NEW.source_event_id !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'explicit reconciliation root requires canonical UUIDv7 identity'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
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

CREATE TRIGGER agent_invocation_events_reconciling_root_authority
BEFORE INSERT ON public.agent_invocation_events
FOR EACH ROW EXECUTE FUNCTION public.enforce_creator_agent_reconciling_root_event();

-- The allowlist is not write authority. A resumed episode is accepted only from the exact
-- direct-login Reconciler and must bind the durable root and the single RUNNING started fact.
CREATE OR REPLACE FUNCTION public.enforce_creator_agent_reconciling_resumed_event()
RETURNS trigger AS $reconciling_resumed_authority$
DECLARE
  privileged_session boolean;
  invocation_row record;
  root_event record;
  running_started_event record;
  expected_source_event_id text;
BEGIN
  IF NEW.event_type <> 'invocation.reconciling_resumed' THEN
    RETURN NEW;
  END IF;

  SELECT role.rolsuper OR role.rolbypassrls
    INTO privileged_session
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = session_user;
  IF session_user <> 'combo_agent_reconciler'
     OR COALESCE(privileged_session, true) THEN
    RAISE EXCEPTION 'reconciliation resumed Event requires exact Reconciler session authority'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.creator_id IS DISTINCT FROM
       NULLIF(current_setting('app.creator_id', true), '')::uuid
     OR NEW.consumer_subject_id IS DISTINCT FROM
       NULLIF(current_setting('app.consumer_id', true), '')::uuid THEN
    RAISE EXCEPTION 'reconciliation resumed Event tenant context mismatch'
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
  IF NOT FOUND OR invocation_row.state <> 'RECONCILING' THEN
    RAISE EXCEPTION 'reconciliation resumed Event requires RECONCILING projection'
      USING ERRCODE = '23514';
  END IF;

  SELECT root.source_event_id, root.payload, root.occurred_at, root.journal_seq
    INTO root_event
    FROM public.agent_invocation_events AS root
   WHERE root.invocation_id = NEW.invocation_id
     AND root.creator_id = NEW.creator_id
     AND root.consumer_subject_id = NEW.consumer_subject_id
     AND root.source = 'RECONCILER'
     AND root.event_type = 'invocation.reconciling';
  IF NOT FOUND
     OR root_event.payload IS DISTINCT FROM jsonb_build_object(
          'state', 'RECONCILING',
          'reason', invocation_row.reconciliation_reason
        )
     OR root_event.occurred_at IS DISTINCT FROM invocation_row.reconciliation_started_at THEN
    RAISE EXCEPTION 'reconciliation resumed Event requires exact durable root'
      USING ERRCODE = '23514';
  END IF;

  SELECT started.source_event_id, started.journal_seq
    INTO running_started_event
    FROM public.agent_invocation_events AS started
   WHERE started.invocation_id = NEW.invocation_id
     AND started.creator_id = NEW.creator_id
     AND started.consumer_subject_id = NEW.consumer_subject_id
     AND started.source = 'WORKER'
     AND started.event_type = 'invocation.started'
     AND started.payload = '{"state":"RUNNING"}'::jsonb
     AND started.journal_seq > root_event.journal_seq
   ORDER BY started.journal_seq DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reconciliation resumed Event requires root then RUNNING started fact'
      USING ERRCODE = '23514';
  END IF;

  expected_source_event_id :=
    'resume-reconciliation:' || root_event.source_event_id || ':' ||
    running_started_event.source_event_id;
  IF NEW.source <> 'RECONCILER'
     OR NEW.source_event_id IS DISTINCT FROM expected_source_event_id
     OR NEW.payload IS DISTINCT FROM root_event.payload
     OR NEW.source_fact_digest IS NOT NULL
     OR NEW.broker_command_id IS NOT NULL
     OR NEW.journal_seq IS DISTINCT FROM running_started_event.journal_seq + 1 THEN
    RAISE EXCEPTION 'reconciliation resumed Event binding is not exact'
      USING ERRCODE = '23514';
  END IF;

  NEW.occurred_at := date_trunc('milliseconds', clock_timestamp());
  RETURN NEW;
END;
$reconciling_resumed_authority$ LANGUAGE plpgsql
  SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_reconciling_resumed_event() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_creator_agent_reconciling_resumed_event()
  TO combo_agent_reconciler;

CREATE TRIGGER agent_invocation_events_reconciling_resumed_authority
BEFORE INSERT ON public.agent_invocation_events
FOR EACH ROW EXECUTE FUNCTION public.enforce_creator_agent_reconciling_resumed_event();

-- Close the write window for old binaries too. This is deferred because CloudJournal updates the
-- projection before appending its companion Event in the same transaction.
CREATE OR REPLACE FUNCTION public.enforce_creator_agent_reconciliation_event_companion()
RETURNS trigger AS $reconciliation_event_companion$
DECLARE
  root_event record;
  running_started_event record;
  expected_resumed_source_event_id text;
BEGIN
  -- A deferred row trigger preserves this transition's NEW image. Do not re-read only the final
  -- projection here: RUNNING -> RECONCILING -> terminal in one transaction must still prove the
  -- intermediate reconciliation companion.
  IF NEW.state <> 'RECONCILING' THEN
    RETURN NEW;
  END IF;

  SELECT root.source_event_id, root.payload, root.occurred_at, root.journal_seq
    INTO root_event
    FROM public.agent_invocation_events AS root
   WHERE root.invocation_id = NEW.id
     AND root.creator_id = NEW.creator_id
     AND root.consumer_subject_id = NEW.consumer_subject_id
     AND root.source = 'RECONCILER'
     AND root.event_type = 'invocation.reconciling';
  IF NOT FOUND
     OR root_event.payload IS DISTINCT FROM jsonb_build_object(
          'state', 'RECONCILING',
          'reason', NEW.reconciliation_reason
        )
     OR root_event.occurred_at IS DISTINCT FROM NEW.reconciliation_started_at THEN
    RAISE EXCEPTION 'RECONCILING projection requires exact durable root Event'
      USING ERRCODE = '23514';
  END IF;

  SELECT started.source_event_id, started.journal_seq
    INTO running_started_event
    FROM public.agent_invocation_events AS started
   WHERE started.invocation_id = NEW.id
     AND started.source = 'WORKER'
     AND started.event_type = 'invocation.started'
     AND started.payload = '{"state":"RUNNING"}'::jsonb
     AND started.journal_seq > root_event.journal_seq
   ORDER BY started.journal_seq DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  expected_resumed_source_event_id :=
    'resume-reconciliation:' || root_event.source_event_id || ':' ||
    running_started_event.source_event_id;
  IF NOT EXISTS (
    SELECT 1
     FROM public.agent_invocation_events AS resumed
     WHERE resumed.invocation_id = NEW.id
       AND resumed.creator_id = NEW.creator_id
       AND resumed.consumer_subject_id = NEW.consumer_subject_id
       AND resumed.source = 'RECONCILER'
       AND resumed.event_type = 'invocation.reconciling_resumed'
       AND resumed.source_event_id = expected_resumed_source_event_id
       AND resumed.payload = root_event.payload
       AND resumed.journal_seq = running_started_event.journal_seq + 1
       AND resumed.source_fact_digest IS NULL
       AND resumed.broker_command_id IS NULL
  ) THEN
    RAISE EXCEPTION 'RECONCILING re-entry requires exact durable resumed Event'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$reconciliation_event_companion$ LANGUAGE plpgsql
  SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_reconciliation_event_companion() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_creator_agent_reconciliation_event_companion()
  TO combo_agent_broker, combo_agent_reconciler;

CREATE CONSTRAINT TRIGGER agent_invocations_reconciliation_event_companion
AFTER INSERT OR UPDATE OF state, reconciliation_reason, reconciliation_started_at
ON public.agent_invocations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_creator_agent_reconciliation_event_companion();

CREATE UNIQUE INDEX uq_agent_invocation_events_reconciling_resumed
  ON public.agent_invocation_events (invocation_id, event_type)
  WHERE event_type = 'invocation.reconciling_resumed';

CREATE TABLE public.creator_agent_journal_integrity_alerts (
  id                           uuid        PRIMARY KEY DEFAULT public.gen_uuid_v7(),
  invocation_id                uuid        NOT NULL,
  creator_id                   uuid        NOT NULL,
  consumer_subject_id          uuid        NOT NULL,
  reason                       text        NOT NULL
                               CONSTRAINT ck_creator_agent_journal_alert_reason CHECK (
                                 reason IN (
                                   'SOURCE_EVENT_CONFLICT',
                                   'JOURNAL_ORDER_CONFLICT',
                                   'PROJECTION_DIGEST_MISMATCH'
                                 )
                               ),
  source                       text        NOT NULL
                               CONSTRAINT ck_creator_agent_journal_alert_source CHECK (
                                 source IN (
                                   'API', 'BROKER', 'WORKER', 'RUNTIME', 'RECONCILER'
                                 )
                               ),
  source_event_id_digest       text        NOT NULL
                               CHECK (source_event_id_digest ~ '^[a-f0-9]{64}$'),
  existing_canonical_digest    text        NOT NULL
                               CHECK (existing_canonical_digest ~ '^[a-f0-9]{64}$'),
  received_canonical_digest    text        NOT NULL
                               CHECK (received_canonical_digest ~ '^[a-f0-9]{64}$'),
  expected_journal_seq         bigint      CHECK (expected_journal_seq >= 1),
  received_journal_seq         bigint      CHECK (received_journal_seq >= 1),
  recorded_at                  timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_creator_agent_journal_alert_invocation_tenant
    FOREIGN KEY (invocation_id, creator_id, consumer_subject_id)
    REFERENCES public.agent_invocations (id, creator_id, consumer_subject_id),
  CONSTRAINT ck_creator_agent_journal_alert_reason_evidence CHECK (
    CASE reason
      WHEN 'JOURNAL_ORDER_CONFLICT' THEN
        expected_journal_seq IS NOT NULL
        AND received_journal_seq IS NOT NULL
        AND expected_journal_seq <> received_journal_seq
      ELSE
        expected_journal_seq IS NULL
        AND received_journal_seq IS NULL
        AND existing_canonical_digest <> received_canonical_digest
    END
  ),
  CONSTRAINT uq_creator_agent_journal_integrity_alert_dedupe UNIQUE NULLS NOT DISTINCT (
    invocation_id,
    reason,
    source,
    source_event_id_digest,
    existing_canonical_digest,
    received_canonical_digest,
    expected_journal_seq,
    received_journal_seq
  )
);

CREATE TRIGGER creator_agent_journal_integrity_alerts_immutable
BEFORE UPDATE OR DELETE ON public.creator_agent_journal_integrity_alerts
FOR EACH ROW EXECUTE FUNCTION public.reject_creator_agent_immutable_mutation();

CREATE TRIGGER creator_agent_journal_integrity_alerts_no_truncate
BEFORE TRUNCATE ON public.creator_agent_journal_integrity_alerts
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_creator_agent_immutable_mutation();

ALTER TABLE public.creator_agent_journal_integrity_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creator_agent_journal_integrity_alerts FORCE ROW LEVEL SECURITY;

CREATE POLICY creator_agent_journal_integrity_alerts_insert
  ON public.creator_agent_journal_integrity_alerts
  FOR INSERT
  TO combo_agent_reconciler
  WITH CHECK (
    creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
    AND consumer_subject_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
  );

REVOKE ALL PRIVILEGES ON public.creator_agent_journal_integrity_alerts FROM PUBLIC;
REVOKE ALL PRIVILEGES ON public.creator_agent_journal_integrity_alerts FROM
  combo_agent_api,
  combo_agent_broker,
  combo_agent_reconciler,
  combo_agent_maintenance,
  combo_agent_consumer_api;

CREATE OR REPLACE FUNCTION public.creator_agent_record_journal_integrity_alert_v1(
  input_creator_id uuid,
  input_consumer_subject_id uuid,
  input_invocation_id uuid,
  input_reason text,
  input_source text,
  input_source_event_id_digest text,
  input_existing_canonical_digest text,
  input_received_canonical_digest text,
  input_expected_journal_seq bigint DEFAULT NULL,
  input_received_journal_seq bigint DEFAULT NULL
)
RETURNS TABLE (alert_id uuid, replayed boolean)
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $record_journal_alert$
DECLARE
  session_is_untrusted boolean;
  durable_alert_id uuid;
BEGIN
  SELECT role.rolsuper OR role.rolbypassrls
    INTO session_is_untrusted
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = session_user;

  IF session_user <> 'combo_agent_reconciler'
     OR COALESCE(session_is_untrusted, true) THEN
    RAISE EXCEPTION 'Journal integrity alert requires exact Reconciler session authority'
      USING ERRCODE = '42501';
  END IF;
  IF input_creator_id IS DISTINCT FROM
       NULLIF(current_setting('app.creator_id', true), '')::uuid
     OR input_consumer_subject_id IS DISTINCT FROM
       NULLIF(current_setting('app.consumer_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Journal integrity alert tenant context mismatch'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.creator_agent_journal_integrity_alerts (
    invocation_id,
    creator_id,
    consumer_subject_id,
    reason,
    source,
    source_event_id_digest,
    existing_canonical_digest,
    received_canonical_digest,
    expected_journal_seq,
    received_journal_seq
  ) VALUES (
    input_invocation_id,
    input_creator_id,
    input_consumer_subject_id,
    input_reason,
    input_source,
    input_source_event_id_digest,
    input_existing_canonical_digest,
    input_received_canonical_digest,
    input_expected_journal_seq,
    input_received_journal_seq
  )
  ON CONFLICT ON CONSTRAINT uq_creator_agent_journal_integrity_alert_dedupe DO NOTHING
  RETURNING id INTO durable_alert_id;

  IF durable_alert_id IS NOT NULL THEN
    RETURN QUERY SELECT durable_alert_id, false;
    RETURN;
  END IF;

  SELECT alert.id
    INTO durable_alert_id
    FROM public.creator_agent_journal_integrity_alerts AS alert
   WHERE alert.invocation_id = input_invocation_id
     AND alert.reason = input_reason
     AND alert.source = input_source
     AND alert.source_event_id_digest = input_source_event_id_digest
     AND alert.existing_canonical_digest = input_existing_canonical_digest
     AND alert.received_canonical_digest = input_received_canonical_digest
     AND alert.expected_journal_seq IS NOT DISTINCT FROM input_expected_journal_seq
     AND alert.received_journal_seq IS NOT DISTINCT FROM input_received_journal_seq;
  IF durable_alert_id IS NULL THEN
    RAISE EXCEPTION 'Journal integrity alert dedupe invariant failed'
      USING ERRCODE = '55000';
  END IF;
  RETURN QUERY SELECT durable_alert_id, true;
END;
$record_journal_alert$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.creator_agent_record_journal_integrity_alert_v1(
  uuid, uuid, uuid, text, text, text, text, text, bigint, bigint
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.creator_agent_record_journal_integrity_alert_v1(
  uuid, uuid, uuid, text, text, text, text, text, bigint, bigint
) TO combo_agent_reconciler;

DO $journal_alert_owner_gate$
DECLARE
  trusted_owner boolean;
BEGIN
  SELECT role.rolsuper OR role.rolbypassrls
    INTO trusted_owner
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS role ON role.oid = procedure.proowner
   WHERE procedure.oid =
     'public.creator_agent_record_journal_integrity_alert_v1(uuid,uuid,uuid,text,text,text,text,text,bigint,bigint)'::regprocedure;
  IF trusted_owner IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Journal integrity alert definer requires SUPERUSER or BYPASSRLS owner'
      USING ERRCODE = '42501';
  END IF;
END;
$journal_alert_owner_gate$;
