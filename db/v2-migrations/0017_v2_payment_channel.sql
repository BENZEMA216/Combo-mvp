-- Channel facts are independent of business requests and of the old Hosted wallet.
ALTER TABLE v2_payment_requests ADD CONSTRAINT uq_v2_payment_channel_scope UNIQUE (id, user_id, amount);
CREATE TABLE v2_payment_channel_orders (
  payment_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  amount bigint NOT NULL,
  gateway_environment text NOT NULL CHECK (gateway_environment IN ('test', 'production')),
  institution_no text NOT NULL CHECK (char_length(institution_no) BETWEEN 1 AND 32 AND institution_no !~ '[[:cntrl:]]'),
  merchant_no text NOT NULL CHECK (char_length(merchant_no) BETWEEN 1 AND 64 AND merchant_no !~ '[[:cntrl:]]'),
  pay_trace_no text NOT NULL CHECK (pay_trace_no ~ '^cbp[0-9a-f]{32}$'),
  pay_time text NOT NULL CHECK (pay_time ~ '^[0-9]{14}$'),
  pay_type text NOT NULL CHECK (pay_type IN ('wechat', 'alipay')),
  submission_state text NOT NULL DEFAULT 'submitting' CHECK (submission_state IN ('submitting', 'pending', 'unknown', 'failed')),
  platform_trade_no text CHECK (char_length(platform_trade_no) BETWEEN 1 AND 64 AND platform_trade_no !~ '[[:cntrl:]]'),
  qr_content text CHECK (char_length(qr_content) BETWEEN 1 AND 2048 AND qr_content !~ '[[:cntrl:]]'),
  action_expires_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  query_attempts integer NOT NULL DEFAULT 0 CHECK (query_attempts BETWEEN 0 AND 120),
  next_query_at timestamptz NOT NULL DEFAULT (now() + interval '15 seconds'),
  query_lease_owner uuid,
  query_lease_until timestamptz,
  FOREIGN KEY (payment_id, user_id, amount) REFERENCES v2_payment_requests(id, user_id, amount),
  UNIQUE (gateway_environment, institution_no, merchant_no, pay_trace_no),
  UNIQUE (gateway_environment, institution_no, merchant_no, platform_trade_no),
  CHECK ((qr_content IS NULL) = (action_expires_at IS NULL)),
  CHECK (action_expires_at IS NULL OR (action_expires_at > created_at AND action_expires_at <= expires_at)),
  CHECK (expires_at > created_at)
);
CREATE INDEX idx_v2_channel_query_due ON v2_payment_channel_orders(next_query_at) WHERE query_attempts < 120;
CREATE TABLE v2_payment_channel_events (
  event_fingerprint text PRIMARY KEY CHECK (event_fingerprint ~ '^[0-9a-f]{64}$'),
  payment_id uuid NOT NULL REFERENCES v2_payment_channel_orders(payment_id),
  source text NOT NULL CHECK (source IN ('callback', 'query')),
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'pending', 'failed', 'unknown')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION enforce_v2_channel_identity() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.payment_id,NEW.user_id,NEW.amount,NEW.gateway_environment,NEW.institution_no,NEW.merchant_no,NEW.pay_trace_no,NEW.pay_time,NEW.pay_type,NEW.expires_at,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.payment_id,OLD.user_id,OLD.amount,OLD.gateway_environment,OLD.institution_no,OLD.merchant_no,OLD.pay_trace_no,OLD.pay_time,OLD.pay_type,OLD.expires_at,OLD.created_at)
     OR (OLD.platform_trade_no IS NOT NULL AND NEW.platform_trade_no IS DISTINCT FROM OLD.platform_trade_no)
     OR (OLD.submission_state <> 'submitting' AND NEW.submission_state = 'submitting')
     OR NEW.query_attempts < OLD.query_attempts THEN
    RAISE EXCEPTION 'channel order identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;
CREATE TRIGGER trg_v2_channel_identity BEFORE UPDATE ON v2_payment_channel_orders FOR EACH ROW EXECUTE FUNCTION enforce_v2_channel_identity();
CREATE TRIGGER trg_v2_channel_events_immutable BEFORE UPDATE OR DELETE ON v2_payment_channel_events FOR EACH ROW EXECUTE FUNCTION reject_v2_append_only_mutation();
REVOKE ALL ON v2_payment_channel_orders,v2_payment_channel_events FROM PUBLIC,combo_api,combo_runtime,combo_worker,combo_authz,combo_billing;
GRANT SELECT,INSERT ON v2_payment_channel_orders,v2_payment_channel_events TO combo_billing;
GRANT UPDATE (submission_state,platform_trade_no,qr_content,action_expires_at,query_attempts,next_query_at,query_lease_owner,query_lease_until) ON v2_payment_channel_orders TO combo_billing;
REVOKE ALL ON FUNCTION enforce_v2_channel_identity() FROM PUBLIC;
