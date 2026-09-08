-- A stable billable call can have multiple attempts only after an explicit zero-charge failure.
-- The original payment, call identity and every historical hold remain immutable.
CREATE TABLE v2_call_attempts (
  call_ref uuid NOT NULL REFERENCES v2_billable_calls(id),
  attempt_no integer NOT NULL CHECK (attempt_no BETWEEN 1 AND 20),
  hold_id uuid NOT NULL UNIQUE REFERENCES v2_holds(id),
  execution_id text NOT NULL CHECK (execution_id ~ '^[A-Za-z0-9]([A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$'),
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'succeeded', 'failed_no_charge', 'unknown')),
  failure_reason text CHECK (failure_reason IN ('invalid_response', 'provider_rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (call_ref, attempt_no),
  CHECK (finished_at IS NULL OR finished_at >= created_at),
  CHECK ((state = 'running') = (finished_at IS NULL)),
  CHECK ((state = 'failed_no_charge') = (failure_reason IS NOT NULL))
);

CREATE FUNCTION enforce_v2_call_attempt() RETURNS trigger AS $$
DECLARE c v2_billable_calls%ROWTYPE; h v2_holds%ROWTYPE; previous v2_call_attempts%ROWTYPE;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN RAISE EXCEPTION 'call attempt facts cannot be removed'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.call_ref,NEW.attempt_no,NEW.hold_id,NEW.execution_id,NEW.created_at)
       IS DISTINCT FROM ROW(OLD.call_ref,OLD.attempt_no,OLD.hold_id,OLD.execution_id,OLD.created_at)
       OR (OLD.state <> 'running' AND NEW IS DISTINCT FROM OLD) THEN
      RAISE EXCEPTION 'call attempt identity and terminal facts are immutable';
    END IF;
  END IF;
  SELECT * INTO STRICT c FROM v2_billable_calls WHERE id=NEW.call_ref;
  SELECT * INTO STRICT h FROM v2_holds WHERE id=NEW.hold_id;
  IF ROW(h.user_id,h.agent_id,h.turn_id,h.estimated_amount)
     IS DISTINCT FROM ROW(c.user_id,c.agent_id,NEW.execution_id,c.estimated_amount) THEN
    RAISE EXCEPTION 'call attempt hold scope mismatch';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.attempt_no = 1 THEN
      IF NEW.hold_id IS DISTINCT FROM c.hold_id OR NEW.execution_id IS DISTINCT FROM c.call_id THEN
        RAISE EXCEPTION 'first attempt must use original hold';
      END IF;
    ELSE
      SELECT * INTO STRICT previous FROM v2_call_attempts
        WHERE call_ref=NEW.call_ref AND attempt_no=NEW.attempt_no-1;
      IF previous.state <> 'failed_no_charge' OR NEW.state <> 'running' THEN
        RAISE EXCEPTION 'only an explicit failed attempt can be retried';
      END IF;
    END IF;
  END IF;
  IF NEW.state = 'succeeded' AND h.status <> 'settled' THEN
    RAISE EXCEPTION 'success requires settled accounting';
  END IF;
  IF NEW.state = 'failed_no_charge' AND (
    h.status <> 'settled' OR h.actual_amount <> 0
    OR EXISTS (SELECT 1 FROM v2_metering_events WHERE hold_id=h.id)
    OR EXISTS (SELECT 1 FROM v2_ledger WHERE ref_id=h.id::text AND kind='consume')
  ) THEN RAISE EXCEPTION 'retry requires confirmed zero-charge failure'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_v2_call_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON v2_call_attempts
  FOR EACH ROW EXECUTE FUNCTION enforce_v2_call_attempt();
CREATE TRIGGER trg_v2_call_attempt_no_truncate BEFORE TRUNCATE ON v2_call_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION enforce_v2_call_attempt();
REVOKE ALL ON v2_call_attempts FROM PUBLIC, combo_api, combo_worker, combo_runtime, combo_authz, combo_billing;
GRANT SELECT, INSERT ON v2_call_attempts TO combo_billing;
GRANT UPDATE (state, failure_reason, finished_at) ON v2_call_attempts TO combo_billing;
REVOKE EXECUTE ON FUNCTION enforce_v2_call_attempt() FROM PUBLIC, combo_api, combo_worker, combo_runtime, combo_authz, combo_billing;
