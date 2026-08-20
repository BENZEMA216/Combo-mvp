-- Expand the durable Worker Invocation fact contract for one confirmed FAILED terminal.
-- This migration does not enable invocation dispatch, does not project CANCELLED, and does not
-- reinterpret legacy unbound failure rows. A historical WORKER failed Event has no canonical
-- fact authority, so tightening is allowed only when that legacy population is empty.

LOCK TABLE public.agent_invocation_events IN SHARE ROW EXCLUSIVE MODE;

DO $confirmed_failure_zero_legacy_gate$
DECLARE
  legacy_worker_failure_count bigint;
BEGIN
  SELECT count(*)
    INTO legacy_worker_failure_count
    FROM public.agent_invocation_events
   WHERE source = 'WORKER'
     AND event_type = 'invocation.failed';

  IF legacy_worker_failure_count <> 0 THEN
    RAISE EXCEPTION
      '0020 confirmed failure migration requires zero legacy Worker failed facts; found %',
      legacy_worker_failure_count
      USING ERRCODE = '55000';
  END IF;
END
$confirmed_failure_zero_legacy_gate$;

CREATE OR REPLACE FUNCTION public.enforce_creator_agent_worker_invocation_fact()
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
           'SNAPSHOT_DIGEST_MISMATCH',
           'PROTOCOL_INCOMPATIBLE',
           'SANDBOX_ATTESTATION_FAILED',
           'RUNTIME_START_FAILED',
           'MODEL_QUOTA_EXHAUSTED',
           'TURN_TIMEOUT',
           'TURN_FAILED'
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
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION public.enforce_creator_agent_worker_invocation_fact() FROM PUBLIC;

COMMENT ON FUNCTION public.enforce_creator_agent_worker_invocation_fact() IS
  'Binds Worker persisted/started facts to exact commands and succeeded/confirmed-failed facts to immutable source digests. CANCELLED remains unavailable without a verified interrupt receipt authority.';
