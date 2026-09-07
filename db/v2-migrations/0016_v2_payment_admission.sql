-- Separate business call identity from payment and hold identity. No request bodies are stored.
CREATE TABLE v2_billable_calls (
  id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
  user_id uuid NOT NULL REFERENCES v2_users(id),
  agent_id text NOT NULL CHECK (agent_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9]([A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$'),
  call_id text NOT NULL CHECK (call_id ~ '^[A-Za-z0-9]([A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  pricing_policy_id text NOT NULL CHECK (pricing_policy_id ~ '^[A-Za-z0-9]([A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$'),
  estimated_amount bigint NOT NULL CHECK (estimated_amount BETWEEN 1 AND 999999999999999),
  hold_id uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, call_id),
  UNIQUE (id, user_id, estimated_amount),
  FOREIGN KEY (hold_id, user_id, agent_id, call_id) REFERENCES v2_holds(id, user_id, agent_id, turn_id)
);

CREATE TABLE v2_payment_requests (
  id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
  call_ref uuid NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  amount bigint NOT NULL CHECK (amount BETWEEN 1 AND 999999999999999),
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'required' CHECK (state IN ('required', 'waiting', 'completed')),
  channel_transaction_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (id, user_id),
  UNIQUE (id, call_ref, user_id, amount),
  FOREIGN KEY (call_ref, user_id, amount) REFERENCES v2_billable_calls(id, user_id, estimated_amount),
  CHECK (updated_at >= created_at AND expires_at > created_at),
  CHECK ((state = 'completed' AND completed_at IS NOT NULL AND channel_transaction_id IS NOT NULL AND completed_at BETWEEN created_at AND updated_at)
      OR (state <> 'completed' AND completed_at IS NULL AND channel_transaction_id IS NULL)),
  CHECK (channel_transaction_id IS NULL OR (char_length(channel_transaction_id) BETWEEN 1 AND 128 AND channel_transaction_id !~ '[[:cntrl:]]'))
);

CREATE TABLE v2_payment_request_keys (
  user_id uuid NOT NULL,
  request_key text NOT NULL CHECK (char_length(request_key) BETWEEN 8 AND 128 AND request_key ~ '^[A-Za-z0-9]([A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$'),
  payment_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, request_key),
  FOREIGN KEY (payment_id, user_id) REFERENCES v2_payment_requests(id, user_id)
);

CREATE TABLE v2_payment_fund_reservations (
  payment_id uuid PRIMARY KEY,
  call_ref uuid NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  amount bigint NOT NULL,
  state text NOT NULL DEFAULT 'available' CHECK (state IN ('available', 'claimed', 'released')),
  hold_id uuid UNIQUE REFERENCES v2_holds(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (payment_id, call_ref, user_id, amount) REFERENCES v2_payment_requests(id, call_ref, user_id, amount),
  CHECK (expires_at > created_at),
  CHECK ((state = 'claimed' AND hold_id IS NOT NULL) OR (state <> 'claimed' AND hold_id IS NULL))
);
CREATE INDEX idx_v2_payment_funds_expiry ON v2_payment_fund_reservations(expires_at) WHERE state = 'available';

CREATE FUNCTION enforce_v2_billable_call_identity() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.id, NEW.user_id, NEW.agent_id, NEW.operation_id, NEW.call_id, NEW.request_fingerprint, NEW.pricing_policy_id, NEW.estimated_amount, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.user_id, OLD.agent_id, OLD.operation_id, OLD.call_id, OLD.request_fingerprint, OLD.pricing_policy_id, OLD.estimated_amount, OLD.created_at)
     OR OLD.hold_id IS NOT NULL OR NEW.hold_id IS NULL THEN
    RAISE EXCEPTION 'billable call identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;
CREATE TRIGGER trg_v2_billable_call_identity BEFORE UPDATE ON v2_billable_calls FOR EACH ROW EXECUTE FUNCTION enforce_v2_billable_call_identity();

CREATE FUNCTION enforce_v2_payment_identity() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.id, NEW.call_ref, NEW.user_id, NEW.amount, NEW.token_digest, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.call_ref, OLD.user_id, OLD.amount, OLD.token_digest, OLD.created_at, OLD.expires_at)
     OR OLD.state = 'completed'
     OR NOT ((OLD.state = 'required' AND NEW.state = 'waiting') OR (OLD.state = 'waiting' AND NEW.state = 'completed')) THEN
    RAISE EXCEPTION 'illegal payment transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;
CREATE TRIGGER trg_v2_payment_identity BEFORE UPDATE ON v2_payment_requests FOR EACH ROW EXECUTE FUNCTION enforce_v2_payment_identity();

CREATE FUNCTION enforce_v2_payment_funds_identity() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.payment_id, NEW.call_ref, NEW.user_id, NEW.amount, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM ROW(OLD.payment_id, OLD.call_ref, OLD.user_id, OLD.amount, OLD.created_at, OLD.expires_at)
     OR OLD.state <> 'available' OR NEW.state NOT IN ('claimed', 'released') THEN
    RAISE EXCEPTION 'illegal payment funds transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;
CREATE TRIGGER trg_v2_payment_funds_identity BEFORE UPDATE ON v2_payment_fund_reservations FOR EACH ROW EXECUTE FUNCTION enforce_v2_payment_funds_identity();
CREATE TRIGGER trg_v2_payment_keys_immutable BEFORE UPDATE OR DELETE ON v2_payment_request_keys FOR EACH ROW EXECUTE FUNCTION reject_v2_append_only_mutation();

REVOKE ALL ON v2_billable_calls, v2_payment_requests, v2_payment_request_keys, v2_payment_fund_reservations FROM PUBLIC, combo_api, combo_runtime, combo_worker, combo_authz, combo_billing;
GRANT SELECT, INSERT ON v2_billable_calls, v2_payment_requests, v2_payment_request_keys, v2_payment_fund_reservations TO combo_billing;
GRANT UPDATE (hold_id) ON v2_billable_calls TO combo_billing;
GRANT UPDATE (state, updated_at, completed_at, channel_transaction_id) ON v2_payment_requests TO combo_billing;
GRANT UPDATE (state, hold_id) ON v2_payment_fund_reservations TO combo_billing;
REVOKE ALL ON FUNCTION enforce_v2_billable_call_identity(), enforce_v2_payment_identity(), enforce_v2_payment_funds_identity() FROM PUBLIC;

-- A completed payment and its unique credit/funds record must commit together.
CREATE FUNCTION check_v2_payment_accounting() RETURNS trigger AS $$
DECLARE
  payment_ref uuid;
  p v2_payment_requests%ROWTYPE;
  f v2_payment_fund_reservations%ROWTYPE;
  credit_count bigint;
BEGIN
  IF TG_TABLE_NAME = 'v2_payment_requests' THEN payment_ref := NEW.id;
  ELSE payment_ref := NEW.payment_id;
  END IF;
  SELECT * INTO p FROM v2_payment_requests WHERE id = payment_ref;
  SELECT * INTO f FROM v2_payment_fund_reservations WHERE payment_id = payment_ref;
  IF p.state = 'completed' THEN
    IF f.payment_id IS NULL THEN RAISE EXCEPTION 'completed payment requires funds reservation' USING ERRCODE = '23514'; END IF;
    SELECT count(*) INTO credit_count FROM v2_ledger
      WHERE user_id = p.user_id AND kind = 'recharge' AND bucket = 'principal'
        AND amount = p.amount AND ref_id = p.id::text
        AND idempotency_key = 'recharge:v1:' || encode(digest(convert_to('payment-credit:' || p.id::text, 'UTF8'), 'sha256'), 'hex');
    IF credit_count <> 1 THEN RAISE EXCEPTION 'completed payment requires unique credit' USING ERRCODE = '23514'; END IF;
    IF f.state = 'claimed' AND NOT EXISTS (SELECT 1 FROM v2_billable_calls WHERE id = f.call_ref AND hold_id = f.hold_id) THEN
      RAISE EXCEPTION 'claimed funds require the original call hold' USING ERRCODE = '23514';
    END IF;
  ELSIF f.payment_id IS NOT NULL THEN
    RAISE EXCEPTION 'unpaid payment cannot reserve funds' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;
CREATE CONSTRAINT TRIGGER trg_v2_payment_accounting AFTER INSERT OR UPDATE ON v2_payment_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_v2_payment_accounting();
CREATE CONSTRAINT TRIGGER trg_v2_payment_funds_accounting AFTER INSERT OR UPDATE ON v2_payment_fund_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_v2_payment_accounting();
REVOKE ALL ON FUNCTION check_v2_payment_accounting() FROM PUBLIC;
