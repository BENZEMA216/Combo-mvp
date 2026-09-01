-- 0019 · server-authoritative recovery for a paid knowledge-Agent usage.
--
-- A 402 is returned before Runtime creates a Turn or usage charge. This table keeps the exact
-- request, Session/Package binding, and price snapshot on the server so another browser tab or a
-- later login can recover the original usageId. Authoring may only compare-and-swap the active
-- recharge intent; it never reads the request text. Runtime accepts or abandons the pending usage
-- atomically and clears the retained text in the same terminal UPDATE.

CREATE TABLE pending_usage_recoveries (
  owner_user_id             uuid        NOT NULL REFERENCES users(id),
  usage_id                  uuid        NOT NULL,
  session_id                uuid        NOT NULL,
  capability_id             uuid        NOT NULL,
  request_text              text,
  request_fingerprint       char(64)    NOT NULL,
  product_kind              text        NOT NULL,
  capability_protocol       text        NOT NULL,
  release_id                text        NOT NULL,
  package_digest            text        NOT NULL,
  release_scope             text        NOT NULL,
  knowledge_resource_path   text        NOT NULL,
  knowledge_resource_digest text        NOT NULL,
  billing_policy_version    text        NOT NULL,
  validator_policy_version  text        NOT NULL,
  unit_price_cents          bigint      NOT NULL,
  free_limit_snapshot       int         NOT NULL,
  active_recharge_intent_id uuid        NOT NULL,
  recovery_status           text        NOT NULL DEFAULT 'active',
  terminal_turn_id          uuid,
  expires_at                timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_at               timestamptz,
  abandoned_at              timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_pending_usage_recoveries PRIMARY KEY (owner_user_id, usage_id),
  CONSTRAINT fk_pending_usage_recovery_session_scope
    FOREIGN KEY (session_id, capability_id, owner_user_id)
    REFERENCES sessions (id, capability_id, owner_user_id),
  CONSTRAINT fk_pending_usage_recovery_release
    FOREIGN KEY (release_id, package_digest)
    REFERENCES agent_package_releases (release_id, package_digest),
  CONSTRAINT fk_pending_usage_recovery_terminal_turn
    FOREIGN KEY (terminal_turn_id, session_id)
    REFERENCES turns (id, session_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ck_pending_usage_recovery_binding CHECK (
    product_kind = 'knowledge_agent_test'
    AND capability_protocol = 'combo.agent-package-capability/2'
    AND release_id ~ '^release[.]agent-package[.][0-9a-f]{32}$'
    AND package_digest ~ '^sha256:[a-f0-9]{64}$'
    AND release_scope = 'controlled_test'
    AND knowledge_resource_path =
      'skills/knowledge/references/knowledge-bundle.json'
    AND knowledge_resource_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  CONSTRAINT ck_pending_usage_recovery_policies CHECK (
    billing_policy_version ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
    AND validator_policy_version ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
    AND request_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT ck_pending_usage_recovery_price CHECK (
    unit_price_cents > 0
    AND free_limit_snapshot >= 0
  ),
  CONSTRAINT ck_pending_usage_recovery_lifetime CHECK (
    expires_at > created_at
    AND expires_at <= created_at + interval '7 days'
    AND updated_at >= created_at
  ),
  CONSTRAINT ck_pending_usage_recovery_state CHECK (
    (
      recovery_status = 'active'
      AND request_text IS NOT NULL
      AND char_length(request_text) BETWEEN 1 AND 20000
      AND btrim(request_text) = request_text
      AND terminal_turn_id IS NULL
      AND accepted_at IS NULL
      AND abandoned_at IS NULL
    )
    OR (
      recovery_status = 'accepted'
      AND request_text IS NULL
      AND terminal_turn_id IS NOT NULL
      AND accepted_at IS NOT NULL
      AND accepted_at >= created_at
      AND accepted_at <= updated_at
      AND abandoned_at IS NULL
    )
    OR (
      recovery_status = 'abandoned'
      AND request_text IS NULL
      AND accepted_at IS NULL
      AND abandoned_at IS NOT NULL
      AND abandoned_at >= created_at
      AND abandoned_at <= updated_at
    )
  )
);

CREATE INDEX idx_pending_usage_recoveries_owner_active
  ON pending_usage_recoveries (owner_user_id, updated_at DESC, usage_id)
  WHERE recovery_status = 'active';
CREATE INDEX idx_pending_usage_recoveries_expiry
  ON pending_usage_recoveries (expires_at, owner_user_id, usage_id)
  WHERE recovery_status = 'active';
CREATE UNIQUE INDEX uq_pending_usage_recoveries_session_active
  ON pending_usage_recoveries (session_id)
  WHERE recovery_status = 'active';

-- The trigger performs no SELECT FOR UPDATE and never reads recharge_orders. Runtime and Authoring
-- must acquire the same owner+usage advisory lock before locking this row. Keeping these checks
-- read-only avoids introducing a reverse pending->order lock edge in either service.
CREATE FUNCTION guard_pending_usage_recovery_write() RETURNS trigger AS $$
DECLARE
  session_row record;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'pending_usage_recoveries cannot be truncated' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pending usage recovery is append-only' USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT
        status,
        owner_user_id,
        capability_id,
        product_kind,
        capability_protocol,
        release_id,
        package_digest,
        release_scope,
        knowledge_resource_path,
        knowledge_resource_digest
      INTO session_row
      FROM public.sessions
     WHERE id = NEW.session_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pending usage recovery Session is missing' USING ERRCODE = '23503';
    END IF;
    IF session_row.status IS DISTINCT FROM 'active'
       OR ROW(
         session_row.owner_user_id,
         session_row.capability_id,
         session_row.product_kind,
         session_row.capability_protocol,
         session_row.release_id,
         session_row.package_digest,
         session_row.release_scope,
         session_row.knowledge_resource_path,
         session_row.knowledge_resource_digest
       ) IS DISTINCT FROM ROW(
         NEW.owner_user_id,
         NEW.capability_id,
         NEW.product_kind,
         NEW.capability_protocol,
         NEW.release_id,
         NEW.package_digest,
         NEW.release_scope,
         NEW.knowledge_resource_path,
         NEW.knowledge_resource_digest
       ) THEN
      RAISE EXCEPTION 'pending usage recovery and Session binding diverged'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.active_recharge_intent_id IS DISTINCT FROM NEW.usage_id THEN
      RAISE EXCEPTION 'initial recharge intent must equal the recovery usageId'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM public.usage_charges
       WHERE owner_user_id = NEW.owner_user_id
         AND usage_id = NEW.usage_id
    ) THEN
      RAISE EXCEPTION 'pending usage recovery cannot replace an admitted usage'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    OLD.owner_user_id,
    OLD.usage_id,
    OLD.session_id,
    OLD.capability_id,
    OLD.request_fingerprint,
    OLD.product_kind,
    OLD.capability_protocol,
    OLD.release_id,
    OLD.package_digest,
    OLD.release_scope,
    OLD.knowledge_resource_path,
    OLD.knowledge_resource_digest,
    OLD.billing_policy_version,
    OLD.validator_policy_version,
    OLD.unit_price_cents,
    OLD.free_limit_snapshot,
    OLD.expires_at,
    OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.owner_user_id,
    NEW.usage_id,
    NEW.session_id,
    NEW.capability_id,
    NEW.request_fingerprint,
    NEW.product_kind,
    NEW.capability_protocol,
    NEW.release_id,
    NEW.package_digest,
    NEW.release_scope,
    NEW.knowledge_resource_path,
    NEW.knowledge_resource_digest,
    NEW.billing_policy_version,
    NEW.validator_policy_version,
    NEW.unit_price_cents,
    NEW.free_limit_snapshot,
    NEW.expires_at,
    NEW.created_at
  ) THEN
    RAISE EXCEPTION 'pending usage recovery binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.recovery_status <> 'active' THEN
    RAISE EXCEPTION 'terminal pending usage recovery is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.updated_at < OLD.updated_at OR NEW.updated_at > statement_timestamp() THEN
    RAISE EXCEPTION 'pending usage recovery update timestamp is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.recovery_status IN ('active', 'accepted') THEN
    SELECT status INTO session_row
      FROM public.sessions
     WHERE id = NEW.session_id;
    IF NOT FOUND OR session_row.status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'closed Session cannot retain or accept a pending usage'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.recovery_status = 'active' THEN
    IF NEW.request_text IS DISTINCT FROM OLD.request_text
       OR NEW.terminal_turn_id IS NOT NULL
       OR NEW.accepted_at IS NOT NULL
       OR NEW.abandoned_at IS NOT NULL THEN
      RAISE EXCEPTION 'active pending usage may only replace its recharge intent'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.expires_at <= statement_timestamp() THEN
      RAISE EXCEPTION 'expired pending usage cannot replace its recharge intent'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM public.usage_charges
       WHERE owner_user_id = NEW.owner_user_id
         AND usage_id = NEW.usage_id
    ) THEN
      RAISE EXCEPTION 'admitted usage cannot retain an active recovery'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.active_recharge_intent_id IS DISTINCT FROM OLD.active_recharge_intent_id THEN
    RAISE EXCEPTION 'terminal transition cannot replace the recharge intent'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.recovery_status = 'accepted' THEN
    IF NEW.accepted_at > statement_timestamp() THEN
      RAISE EXCEPTION 'pending usage acceptance timestamp is invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.recovery_status = 'abandoned' THEN
    IF NEW.abandoned_at > statement_timestamp() THEN
      RAISE EXCEPTION 'pending usage abandonment timestamp is invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'pending usage recovery transition is invalid' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = pg_catalog, public;

CREATE TRIGGER trg_pending_usage_recovery_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON pending_usage_recoveries
  FOR EACH ROW EXECUTE FUNCTION guard_pending_usage_recovery_write();

CREATE TRIGGER trg_pending_usage_recovery_no_truncate
  BEFORE TRUNCATE ON pending_usage_recoveries
  FOR EACH STATEMENT EXECUTE FUNCTION guard_pending_usage_recovery_write();

-- A pending recovery closes only after the authoritative Turn, charge, and receipt have reached
-- their final state in the same transaction. This deferred equation intentionally uses plain
-- SELECTs: Runtime already owns the Session + owner/usage lock order, and the constraint must not
-- introduce a second row-lock order. The usage-charge trigger makes the equation bidirectional:
-- a reserved admitted retry may remain active, but a terminal charge cannot commit while its
-- retained recovery is still active.
CREATE FUNCTION enforce_pending_usage_recovery_terminal() RETURNS trigger AS $$
DECLARE
  affected_owner uuid;
  affected_usage uuid;
  pending_row pending_usage_recoveries%ROWTYPE;
  charge_row record;
  receipt_row record;
  charge_found boolean;
  receipt_found boolean;
BEGIN
  IF TG_TABLE_NAME = 'pending_usage_recoveries' THEN
    IF TG_OP = 'DELETE' THEN
      affected_owner := OLD.owner_user_id;
      affected_usage := OLD.usage_id;
    ELSE
      affected_owner := NEW.owner_user_id;
      affected_usage := NEW.usage_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'usage_charges' THEN
    IF TG_OP = 'DELETE' THEN
      affected_owner := OLD.owner_user_id;
      affected_usage := OLD.usage_id;
    ELSE
      affected_owner := NEW.owner_user_id;
      affected_usage := NEW.usage_id;
    END IF;
  ELSE
    RAISE EXCEPTION 'pending usage recovery terminal equation called for unsupported table'
      USING ERRCODE = '55000';
  END IF;

  -- Read the transaction's final row, rather than a queued trigger event's earlier NEW image.
  -- This lets an INSERT(active) event and a later terminal UPDATE in one transaction converge on
  -- the same closure equation. SECURITY DEFINER keeps this read invisible to combo_api callers.
  SELECT * INTO pending_row
    FROM public.pending_usage_recoveries
   WHERE owner_user_id = affected_owner
     AND usage_id = affected_usage;
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT
      charge.id,
      charge.owner_user_id,
      charge.usage_id,
      charge.capability_id,
      charge.session_id,
      charge.turn_id,
      charge.request_fingerprint,
      charge.charge_source,
      charge.status,
      charge.unit_price_cents,
      charge.free_limit_snapshot,
      charge.reserved_cents,
      charge.settled_cents,
      charge.product_kind,
      charge.capability_protocol,
      charge.release_id,
      charge.package_digest,
      charge.release_scope,
      charge.knowledge_resource_path,
      charge.knowledge_resource_digest,
      charge.billing_policy_version,
      charge.validator_policy_version,
      charge.execution_outcome,
      charge.created_at,
      turn.status AS turn_status
    INTO charge_row
    FROM public.usage_charges AS charge
    JOIN public.turns AS turn
      ON turn.id = charge.turn_id AND turn.session_id = charge.session_id
   WHERE charge.owner_user_id = pending_row.owner_user_id
     AND charge.usage_id = pending_row.usage_id;
  charge_found := FOUND;

  IF pending_row.recovery_status = 'active' THEN
    IF charge_found AND (
      charge_row.status IS DISTINCT FROM 'reserved'
      OR charge_row.charge_source IS DISTINCT FROM 'wallet'
      OR charge_row.reserved_cents IS DISTINCT FROM pending_row.unit_price_cents
      OR charge_row.settled_cents IS DISTINCT FROM 0::bigint
      OR charge_row.execution_outcome IS NOT NULL
      OR charge_row.turn_status IS DISTINCT FROM 'running'
      OR charge_row.created_at < pending_row.created_at
      OR charge_row.created_at >= pending_row.expires_at
      OR ROW(
        charge_row.owner_user_id,
        charge_row.usage_id,
        charge_row.capability_id,
        charge_row.session_id,
        charge_row.request_fingerprint,
        charge_row.unit_price_cents,
        charge_row.free_limit_snapshot,
        charge_row.product_kind,
        charge_row.capability_protocol,
        charge_row.release_id,
        charge_row.package_digest,
        charge_row.release_scope,
        charge_row.knowledge_resource_path,
        charge_row.knowledge_resource_digest,
        charge_row.billing_policy_version,
        charge_row.validator_policy_version
      ) IS DISTINCT FROM ROW(
        pending_row.owner_user_id,
        pending_row.usage_id,
        pending_row.capability_id,
        pending_row.session_id,
        pending_row.request_fingerprint,
        pending_row.unit_price_cents,
        pending_row.free_limit_snapshot,
        pending_row.product_kind,
        pending_row.capability_protocol,
        pending_row.release_id,
        pending_row.package_digest,
        pending_row.release_scope,
        pending_row.knowledge_resource_path,
        pending_row.knowledge_resource_digest,
        pending_row.billing_policy_version,
        pending_row.validator_policy_version
      )
    ) THEN
      RAISE EXCEPTION 'active recovery and admitted usage charge diverged'
        USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF pending_row.recovery_status = 'abandoned'
     AND pending_row.terminal_turn_id IS NULL THEN
    IF charge_found THEN
      RAISE EXCEPTION 'charge-free abandonment requires an unadmitted recovery'
        USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF NOT charge_found THEN
    RAISE EXCEPTION 'terminal admitted recovery requires its exact usage charge'
      USING ERRCODE = '23514';
  END IF;

  SELECT
      receipt.protocol,
      receipt.usage_charge_id,
      receipt.owner_user_id,
      receipt.usage_id,
      receipt.capability_id,
      receipt.session_id,
      receipt.turn_id,
      receipt.product_kind,
      receipt.capability_protocol,
      receipt.release_id,
      receipt.package_digest,
      receipt.release_scope,
      receipt.knowledge_resource_path,
      receipt.knowledge_resource_digest,
      receipt.billing_policy_version,
      receipt.validator_policy_version,
      receipt.unit_price_cents,
      receipt.free_limit_snapshot,
      receipt.charge_source,
      receipt.settled_cents,
      receipt.execution_outcome,
      receipt.response_message_id,
      receipt.response_digest
    INTO receipt_row
    FROM public.agent_usage_receipts AS receipt
   WHERE receipt.usage_charge_id = charge_row.id;
  receipt_found := FOUND;

  IF NOT receipt_found
     OR receipt_row.protocol IS DISTINCT FROM 'combo.agent-usage-receipt/1'
     OR ROW(
       charge_row.owner_user_id,
       charge_row.usage_id,
       charge_row.capability_id,
       charge_row.session_id,
       charge_row.turn_id,
       charge_row.request_fingerprint,
       charge_row.unit_price_cents,
       charge_row.free_limit_snapshot,
       charge_row.product_kind,
       charge_row.capability_protocol,
       charge_row.release_id,
       charge_row.package_digest,
       charge_row.release_scope,
       charge_row.knowledge_resource_path,
       charge_row.knowledge_resource_digest,
       charge_row.billing_policy_version,
       charge_row.validator_policy_version
     ) IS DISTINCT FROM ROW(
       pending_row.owner_user_id,
       pending_row.usage_id,
       pending_row.capability_id,
       pending_row.session_id,
       pending_row.terminal_turn_id,
       pending_row.request_fingerprint,
       pending_row.unit_price_cents,
       pending_row.free_limit_snapshot,
       pending_row.product_kind,
       pending_row.capability_protocol,
       pending_row.release_id,
       pending_row.package_digest,
       pending_row.release_scope,
       pending_row.knowledge_resource_path,
       pending_row.knowledge_resource_digest,
       pending_row.billing_policy_version,
       pending_row.validator_policy_version
     )
     OR ROW(
       receipt_row.usage_charge_id,
       receipt_row.owner_user_id,
       receipt_row.usage_id,
       receipt_row.capability_id,
       receipt_row.session_id,
       receipt_row.turn_id,
       receipt_row.product_kind,
       receipt_row.capability_protocol,
       receipt_row.release_id,
       receipt_row.package_digest,
       receipt_row.release_scope,
       receipt_row.knowledge_resource_path,
       receipt_row.knowledge_resource_digest,
       receipt_row.billing_policy_version,
       receipt_row.validator_policy_version,
       receipt_row.unit_price_cents,
       receipt_row.free_limit_snapshot,
       receipt_row.charge_source,
       receipt_row.settled_cents,
       receipt_row.execution_outcome
     ) IS DISTINCT FROM ROW(
       charge_row.id,
       charge_row.owner_user_id,
       charge_row.usage_id,
       charge_row.capability_id,
       charge_row.session_id,
       charge_row.turn_id,
       charge_row.product_kind,
       charge_row.capability_protocol,
       charge_row.release_id,
       charge_row.package_digest,
       charge_row.release_scope,
       charge_row.knowledge_resource_path,
       charge_row.knowledge_resource_digest,
       charge_row.billing_policy_version,
       charge_row.validator_policy_version,
       charge_row.unit_price_cents,
       charge_row.free_limit_snapshot,
       charge_row.charge_source,
       charge_row.settled_cents,
       charge_row.execution_outcome
     ) THEN
    RAISE EXCEPTION 'terminal recovery, charge, and receipt snapshots diverged'
      USING ERRCODE = '23514';
  END IF;

  IF pending_row.recovery_status = 'accepted' THEN
    IF charge_row.charge_source IS DISTINCT FROM 'wallet'
       OR charge_row.status IS DISTINCT FROM 'completed'
       OR charge_row.reserved_cents IS DISTINCT FROM pending_row.unit_price_cents
       OR charge_row.settled_cents IS DISTINCT FROM pending_row.unit_price_cents
       OR charge_row.execution_outcome IS DISTINCT FROM 'answered'
       OR charge_row.turn_status IS DISTINCT FROM 'completed'
       OR receipt_row.response_message_id IS NULL
       OR receipt_row.response_digest IS NULL THEN
      RAISE EXCEPTION 'accepted recovery requires an answered settled wallet usage receipt'
        USING ERRCODE = '23514';
    END IF;
  ELSIF pending_row.recovery_status = 'abandoned' THEN
    IF charge_row.charge_source IS DISTINCT FROM 'wallet'
       OR charge_row.status IS DISTINCT FROM 'released'
       OR charge_row.reserved_cents IS DISTINCT FROM pending_row.unit_price_cents
       OR charge_row.settled_cents IS DISTINCT FROM 0::bigint
       OR charge_row.execution_outcome IS NULL
       OR NOT (charge_row.execution_outcome IN (
         'insufficient_evidence', 'failed', 'interrupted'
       ))
       OR NOT (
         (charge_row.execution_outcome = 'insufficient_evidence'
           AND charge_row.turn_status = 'completed')
         OR (charge_row.execution_outcome = 'failed'
           AND charge_row.turn_status = 'failed')
         OR (charge_row.execution_outcome = 'interrupted'
           AND charge_row.turn_status = 'interrupted')
       ) THEN
      RAISE EXCEPTION 'abandoned admitted recovery requires a released non-answer receipt'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'pending usage recovery status is invalid' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = pg_catalog, public;

CREATE CONSTRAINT TRIGGER trg_pending_usage_recovery_terminal_equation
  AFTER INSERT OR UPDATE OR DELETE ON pending_usage_recoveries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_pending_usage_recovery_terminal();

CREATE CONSTRAINT TRIGGER trg_usage_charge_pending_recovery_equation
  AFTER INSERT OR UPDATE OR DELETE ON usage_charges
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_pending_usage_recovery_terminal();

-- Existing recharge orders remain legacy-compatible with a NULL recovery_usage_id. Every new
-- recovery-aware order points one way to its original usage. There is deliberately no reverse FK
-- from pending_usage_recoveries to an order: Authoring CASes active_recharge_intent_id and inserts
-- the order in one transaction without ever making Runtime lock a payment row.
ALTER TABLE recharge_orders
  ADD COLUMN recovery_usage_id uuid;

ALTER TABLE recharge_orders
  ADD CONSTRAINT fk_recharge_order_pending_usage_recovery
  FOREIGN KEY (owner_user_id, recovery_usage_id)
  REFERENCES pending_usage_recoveries (owner_user_id, usage_id)
  NOT VALID;

ALTER TABLE recharge_orders
  VALIDATE CONSTRAINT fk_recharge_order_pending_usage_recovery;

CREATE INDEX idx_recharge_orders_recovery_usage
  ON recharge_orders (owner_user_id, recovery_usage_id, created_at DESC)
  WHERE recovery_usage_id IS NOT NULL;

-- This ordinary SELECT is only a static last-line binding check. It is not a cross-transaction
-- lock and must not be treated as the concurrency contract. Before CAS + order INSERT, Authoring
-- must acquire pg_advisory_xact_lock(hashtextextended(owner_user_id::text || ':' ||
-- recovery_usage_id::text, 0)), then SELECT the pending row FOR UPDATE in that order.
CREATE FUNCTION guard_recharge_order_recovery_binding() RETURNS trigger AS $$
DECLARE
  pending_row record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.recovery_usage_id IS NOT NULL THEN
      SELECT recovery_status, active_recharge_intent_id, expires_at
        INTO pending_row
        FROM public.pending_usage_recoveries
       WHERE owner_user_id = NEW.owner_user_id
         AND usage_id = NEW.recovery_usage_id;
      IF NOT FOUND
         OR pending_row.recovery_status IS DISTINCT FROM 'active'
         OR pending_row.expires_at <= statement_timestamp()
         OR pending_row.active_recharge_intent_id::text IS DISTINCT FROM
            NEW.client_idempotency_key THEN
        RAISE EXCEPTION 'recharge order does not match the active pending usage intent'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.recovery_usage_id IS NOT NULL OR NEW.recovery_usage_id IS NOT NULL)
     AND ROW(
       OLD.owner_user_id,
       OLD.client_idempotency_key,
       OLD.recovery_usage_id
     ) IS DISTINCT FROM ROW(
       NEW.owner_user_id,
       NEW.client_idempotency_key,
       NEW.recovery_usage_id
     ) THEN
    RAISE EXCEPTION 'recharge order recovery binding is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
   SECURITY INVOKER
   SET search_path = pg_catalog, public;

CREATE TRIGGER trg_recharge_order_recovery_binding_immutable
  BEFORE INSERT OR UPDATE ON recharge_orders
  FOR EACH ROW EXECUTE FUNCTION guard_recharge_order_recovery_binding();

REVOKE ALL PRIVILEGES ON pending_usage_recoveries
  FROM PUBLIC, combo_api, combo_worker, combo_runtime;
REVOKE ALL PRIVILEGES ON FUNCTION guard_pending_usage_recovery_write()
  FROM PUBLIC, combo_api, combo_worker, combo_runtime;
REVOKE ALL PRIVILEGES ON FUNCTION enforce_pending_usage_recovery_terminal()
  FROM PUBLIC, combo_api, combo_worker, combo_runtime;
REVOKE ALL PRIVILEGES ON FUNCTION guard_recharge_order_recovery_binding()
  FROM PUBLIC, combo_api, combo_worker, combo_runtime;

-- Runtime owns the retained request and is the only process that can accept or abandon it. The
-- initial row must use the request usageId as its first recharge intent; accepted/abandoned fields
-- are supplied only by one atomic terminal UPDATE.
GRANT SELECT ON pending_usage_recoveries TO combo_runtime;
GRANT INSERT (
  owner_user_id,
  usage_id,
  session_id,
  capability_id,
  request_text,
  request_fingerprint,
  product_kind,
  capability_protocol,
  release_id,
  package_digest,
  release_scope,
  knowledge_resource_path,
  knowledge_resource_digest,
  billing_policy_version,
  validator_policy_version,
  unit_price_cents,
  free_limit_snapshot,
  active_recharge_intent_id,
  expires_at
) ON pending_usage_recoveries TO combo_runtime;
GRANT UPDATE (
  request_text,
  recovery_status,
  terminal_turn_id,
  accepted_at,
  abandoned_at,
  updated_at
) ON pending_usage_recoveries TO combo_runtime;

-- Authoring can owner-scope and CAS the active intent before inserting recharge_orders in the same
-- transaction. It cannot select request_text, binding details, policy IDs, or terminal Turn data.
GRANT SELECT (
  owner_user_id,
  usage_id,
  recovery_status,
  active_recharge_intent_id,
  unit_price_cents,
  expires_at,
  updated_at
) ON pending_usage_recoveries TO combo_api;
GRANT UPDATE (active_recharge_intent_id, updated_at)
  ON pending_usage_recoveries TO combo_api;

-- combo_worker and PUBLIC retain zero access. Runtime receives no recharge_orders privilege here.
