-- 0018 · Agent Package Session freeze and immutable knowledge usage receipts.
--
-- This is an expand-only migration for rolling deployment. Existing Session and usage rows remain
-- legacy by default. A knowledge Session must be born with one exact controlled-Test Release,
-- Package digest, and the fixed inventoried Knowledge Bundle resource. The resource digest is an
-- audit snapshot of that fixed Package file; it is never an independent object selector.

ALTER TABLE sessions
  ADD COLUMN product_kind text NOT NULL DEFAULT 'legacy_capability',
  ADD COLUMN capability_protocol text,
  ADD COLUMN release_id text,
  ADD COLUMN package_digest text,
  ADD COLUMN release_scope text,
  ADD COLUMN knowledge_resource_path text,
  ADD COLUMN knowledge_resource_digest text;

ALTER TABLE sessions
  ADD CONSTRAINT ck_sessions_product_kind
  CHECK (product_kind IN ('legacy_capability', 'knowledge_agent_test')) NOT VALID,
  ADD CONSTRAINT ck_sessions_agent_package_binding
  CHECK (
    (
      product_kind = 'legacy_capability'
      AND capability_protocol IS NULL
      AND release_id IS NULL
      AND package_digest IS NULL
      AND release_scope IS NULL
      AND knowledge_resource_path IS NULL
      AND knowledge_resource_digest IS NULL
    )
    OR (
      product_kind = 'knowledge_agent_test'
      AND capability_protocol IS NOT NULL
      AND release_id IS NOT NULL
      AND package_digest IS NOT NULL
      AND release_scope IS NOT NULL
      AND knowledge_resource_path IS NOT NULL
      AND knowledge_resource_digest IS NOT NULL
      AND agent_project_id IS NULL
      AND agent_revision_id IS NULL
      AND agent_release_id IS NULL
      AND mode = 'consume'
      AND capability_protocol = 'combo.agent-package-capability/2'
      AND release_id ~ '^release[.]agent-package[.][0-9a-f]{32}$'
      AND package_digest ~ '^sha256:[a-f0-9]{64}$'
      AND release_scope = 'controlled_test'
      AND knowledge_resource_path =
        'skills/knowledge/references/knowledge-bundle.json'
      AND knowledge_resource_digest ~ '^sha256:[a-f0-9]{64}$'
    )
  ) NOT VALID,
  ADD CONSTRAINT fk_sessions_agent_package_release
  FOREIGN KEY (release_id, package_digest)
  REFERENCES agent_package_releases (release_id, package_digest)
  MATCH FULL NOT VALID;

ALTER TABLE sessions VALIDATE CONSTRAINT ck_sessions_product_kind;
ALTER TABLE sessions VALIDATE CONSTRAINT ck_sessions_agent_package_binding;
ALTER TABLE sessions VALIDATE CONSTRAINT fk_sessions_agent_package_release;

CREATE INDEX idx_sessions_knowledge_release
  ON sessions (release_id, package_digest, created_at DESC)
  WHERE product_kind = 'knowledge_agent_test';

-- Old Runtime nodes omit all new columns and therefore continue creating legacy charges. Knowledge
-- charges repeat the Session freeze and policy snapshots so a terminal receipt never depends on
-- mutable configuration or a latest Release lookup.
ALTER TABLE usage_charges
  ADD COLUMN product_kind text NOT NULL DEFAULT 'legacy_capability',
  ADD COLUMN capability_protocol text,
  ADD COLUMN release_id text,
  ADD COLUMN package_digest text,
  ADD COLUMN release_scope text,
  ADD COLUMN knowledge_resource_path text,
  ADD COLUMN knowledge_resource_digest text,
  ADD COLUMN billing_policy_version text,
  ADD COLUMN validator_policy_version text,
  ADD COLUMN execution_outcome text;

ALTER TABLE usage_charges
  ADD CONSTRAINT ck_usage_charge_product_kind
  CHECK (product_kind IN ('legacy_capability', 'knowledge_agent_test')) NOT VALID,
  ADD CONSTRAINT ck_usage_charge_agent_package_binding
  CHECK (
    (
      product_kind = 'legacy_capability'
      AND capability_protocol IS NULL
      AND release_id IS NULL
      AND package_digest IS NULL
      AND release_scope IS NULL
      AND knowledge_resource_path IS NULL
      AND knowledge_resource_digest IS NULL
      AND billing_policy_version IS NULL
      AND validator_policy_version IS NULL
      AND execution_outcome IS NULL
    )
    OR (
      product_kind = 'knowledge_agent_test'
      AND capability_protocol IS NOT NULL
      AND release_id IS NOT NULL
      AND package_digest IS NOT NULL
      AND release_scope IS NOT NULL
      AND knowledge_resource_path IS NOT NULL
      AND knowledge_resource_digest IS NOT NULL
      AND billing_policy_version IS NOT NULL
      AND validator_policy_version IS NOT NULL
      AND capability_protocol = 'combo.agent-package-capability/2'
      AND release_id ~ '^release[.]agent-package[.][0-9a-f]{32}$'
      AND package_digest ~ '^sha256:[a-f0-9]{64}$'
      AND release_scope = 'controlled_test'
      AND knowledge_resource_path =
        'skills/knowledge/references/knowledge-bundle.json'
      AND knowledge_resource_digest ~ '^sha256:[a-f0-9]{64}$'
      AND billing_policy_version ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
      AND validator_policy_version ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
      AND (
        (status = 'reserved' AND execution_outcome IS NULL)
        OR (
          status = 'completed'
          AND execution_outcome IS NOT NULL
          AND execution_outcome = 'answered'
        )
        OR (
          status = 'released'
          AND execution_outcome IS NOT NULL
          AND execution_outcome IN ('insufficient_evidence', 'failed', 'interrupted')
        )
      )
    )
  ) NOT VALID,
  ADD CONSTRAINT fk_usage_charge_agent_package_release
  FOREIGN KEY (release_id, package_digest)
  REFERENCES agent_package_releases (release_id, package_digest)
  MATCH FULL NOT VALID;

ALTER TABLE usage_charges VALIDATE CONSTRAINT ck_usage_charge_product_kind;
ALTER TABLE usage_charges VALIDATE CONSTRAINT ck_usage_charge_agent_package_binding;
ALTER TABLE usage_charges VALIDATE CONSTRAINT fk_usage_charge_agent_package_release;

CREATE INDEX idx_usage_charges_knowledge_terminal
  ON usage_charges (owner_user_id, finished_at DESC, id)
  WHERE product_kind = 'knowledge_agent_test' AND status IN ('completed', 'released');

-- A terminal receipt names one exact response Message. The redundant scope columns make the FK
-- prove that the selected Message belongs to the same Session and Turn without trusting a caller.
ALTER TABLE messages
  ADD CONSTRAINT uq_messages_id_session_turn UNIQUE (id, session_id, turn_id);

-- One terminal knowledge charge has exactly one append-only receipt. Citation references are exact
-- Knowledge Bundle chunk IDs, not mutable labels, paths, URLs, or independent retrieval selectors.
CREATE TABLE agent_usage_receipts (
  id                         uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  protocol                   text        NOT NULL
                             CONSTRAINT ck_agent_usage_receipt_protocol
                             CHECK (protocol = 'combo.agent-usage-receipt/1'),
  usage_charge_id            uuid        NOT NULL UNIQUE,
  owner_user_id              uuid        NOT NULL,
  usage_id                   uuid        NOT NULL,
  capability_id              uuid        NOT NULL,
  session_id                 uuid        NOT NULL,
  turn_id                    uuid        NOT NULL UNIQUE,
  product_kind               text        NOT NULL
                             CONSTRAINT ck_agent_usage_receipt_product_kind
                             CHECK (product_kind = 'knowledge_agent_test'),
  capability_protocol        text        NOT NULL
                             CONSTRAINT ck_agent_usage_receipt_capability_protocol
                             CHECK (capability_protocol = 'combo.agent-package-capability/2'),
  release_id                 text        NOT NULL
                             CONSTRAINT ck_agent_usage_receipt_release_id
                             CHECK (release_id ~ '^release[.]agent-package[.][0-9a-f]{32}$'),
  package_digest             text        NOT NULL
                             CONSTRAINT ck_agent_usage_receipt_package_digest
                             CHECK (package_digest ~ '^sha256:[a-f0-9]{64}$'),
  release_scope              text        NOT NULL
                             CONSTRAINT ck_agent_usage_receipt_release_scope
                             CHECK (release_scope = 'controlled_test'),
  knowledge_resource_path    text        NOT NULL
                             CONSTRAINT ck_agent_usage_receipt_resource_path
                             CHECK (
                               knowledge_resource_path =
                                 'skills/knowledge/references/knowledge-bundle.json'
                             ),
  knowledge_resource_digest  text        NOT NULL
                             CONSTRAINT ck_agent_usage_receipt_resource_digest
                             CHECK (knowledge_resource_digest ~ '^sha256:[a-f0-9]{64}$'),
  billing_policy_version     text        NOT NULL,
  validator_policy_version   text        NOT NULL,
  unit_price_cents           bigint      NOT NULL,
  free_limit_snapshot        int         NOT NULL,
  charge_source              text        NOT NULL,
  settled_cents              bigint      NOT NULL,
  execution_outcome          text        NOT NULL,
  validation_code            text        NOT NULL,
  response_message_id        uuid,
  response_digest            text,
  citation_chunk_ids         text[]      NOT NULL DEFAULT '{}'::text[],
  execution_environment      text        NOT NULL
                             CONSTRAINT ck_agent_usage_receipt_environment
                             CHECK (execution_environment = 'test'),
  runtime_release_id         text        NOT NULL,
  runtime_source_sha         char(40)    NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_agent_usage_receipt_owner_usage UNIQUE (owner_user_id, usage_id),
  CONSTRAINT fk_agent_usage_receipt_charge_owner
    FOREIGN KEY (usage_charge_id, owner_user_id)
    REFERENCES usage_charges (id, owner_user_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_agent_usage_receipt_session_scope
    FOREIGN KEY (session_id, capability_id, owner_user_id)
    REFERENCES sessions (id, capability_id, owner_user_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_agent_usage_receipt_turn_scope
    FOREIGN KEY (turn_id, session_id)
    REFERENCES turns (id, session_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_agent_usage_receipt_response_scope
    FOREIGN KEY (response_message_id, session_id, turn_id)
    REFERENCES messages (id, session_id, turn_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_agent_usage_receipt_release
    FOREIGN KEY (release_id, package_digest)
    REFERENCES agent_package_releases (release_id, package_digest)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ck_agent_usage_receipt_policy_versions CHECK (
    billing_policy_version ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
    AND validator_policy_version ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
  ),
  CONSTRAINT ck_agent_usage_receipt_billing CHECK (
    unit_price_cents >= 0
    AND free_limit_snapshot >= 0
    AND settled_cents >= 0
    AND charge_source IN ('owner', 'free', 'wallet')
    AND (
      (charge_source IN ('owner', 'free') AND settled_cents = 0)
      OR (
        charge_source = 'wallet'
        AND unit_price_cents > 0
        AND (
          (execution_outcome = 'answered' AND settled_cents > 0)
          OR (execution_outcome <> 'answered' AND settled_cents = 0)
        )
      )
    )
  ),
  CONSTRAINT ck_agent_usage_receipt_citations CHECK (
    cardinality(citation_chunk_ids) BETWEEN 0 AND 32
    AND array_position(citation_chunk_ids, NULL) IS NULL
  ),
  CONSTRAINT ck_agent_usage_receipt_runtime_release CHECK (
    runtime_release_id ~ '^release-[0-9a-f]{40}$'
    AND runtime_release_id = 'release-' || runtime_source_sha
  ),
  CONSTRAINT ck_agent_usage_receipt_runtime_sha CHECK (
    runtime_source_sha ~ '^[0-9a-f]{40}$'
  ),
  CONSTRAINT ck_agent_usage_receipt_outcome CHECK (
    (
      execution_outcome = 'answered'
      AND validation_code = 'accepted'
      AND response_message_id IS NOT NULL
      AND response_digest IS NOT NULL
      AND response_digest ~ '^sha256:[a-f0-9]{64}$'
      AND cardinality(citation_chunk_ids) BETWEEN 1 AND 32
    )
    OR (
      execution_outcome = 'insufficient_evidence'
      AND validation_code = 'insufficient_evidence'
      AND response_message_id IS NOT NULL
      AND response_digest IS NOT NULL
      AND response_digest ~ '^sha256:[a-f0-9]{64}$'
      AND cardinality(citation_chunk_ids) = 0
      AND settled_cents = 0
    )
    OR (
      execution_outcome = 'failed'
      AND validation_code IN ('not_run', 'rejected', 'unavailable', 'protocol_invalid')
      AND response_message_id IS NULL
      AND response_digest IS NULL
      AND cardinality(citation_chunk_ids) = 0
      AND settled_cents = 0
    )
    OR (
      execution_outcome = 'interrupted'
      AND validation_code = 'not_run'
      AND response_message_id IS NULL
      AND response_digest IS NULL
      AND cardinality(citation_chunk_ids) = 0
      AND settled_cents = 0
    )
  )
);

CREATE INDEX idx_agent_usage_receipts_owner_recent
  ON agent_usage_receipts (owner_user_id, created_at DESC, id);
CREATE INDEX idx_agent_usage_receipts_session_recent
  ON agent_usage_receipts (session_id, created_at DESC, id);
CREATE INDEX idx_agent_usage_receipts_response_message
  ON agent_usage_receipts (response_message_id)
  WHERE response_message_id IS NOT NULL;

-- Session and knowledge-charge identity snapshots can only be supplied on INSERT. This protects the
-- frozen tuple even from ordinary DML by the migration owner while retaining legacy Session updates.
CREATE FUNCTION reject_agent_session_binding_mutation() RETURNS trigger AS $$
BEGIN
  IF OLD.product_kind = 'knowledge_agent_test'
     OR NEW.product_kind = 'knowledge_agent_test' THEN
    IF ROW(
      OLD.owner_user_id,
      OLD.capability_id,
      OLD.mode,
      OLD.product_kind,
      OLD.capability_protocol,
      OLD.release_id,
      OLD.package_digest,
      OLD.release_scope,
      OLD.knowledge_resource_path,
      OLD.knowledge_resource_digest
    ) IS DISTINCT FROM ROW(
      NEW.owner_user_id,
      NEW.capability_id,
      NEW.mode,
      NEW.product_kind,
      NEW.capability_protocol,
      NEW.release_id,
      NEW.package_digest,
      NEW.release_scope,
      NEW.knowledge_resource_path,
      NEW.knowledge_resource_digest
    ) THEN
      RAISE EXCEPTION 'knowledge Session binding is immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
   SECURITY INVOKER
   SET search_path = pg_catalog, public;

CREATE TRIGGER trg_agent_session_binding_immutable
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION reject_agent_session_binding_mutation();

CREATE FUNCTION reject_knowledge_usage_binding_mutation() RETURNS trigger AS $$
BEGIN
  IF OLD.product_kind = 'knowledge_agent_test'
     OR NEW.product_kind = 'knowledge_agent_test' THEN
    IF ROW(
      OLD.owner_user_id,
      OLD.usage_id,
      OLD.capability_id,
      OLD.session_id,
      OLD.turn_id,
      OLD.request_fingerprint,
      OLD.charge_source,
      OLD.unit_price_cents,
      OLD.free_limit_snapshot,
      OLD.reserved_cents,
      OLD.created_at,
      OLD.product_kind,
      OLD.capability_protocol,
      OLD.release_id,
      OLD.package_digest,
      OLD.release_scope,
      OLD.knowledge_resource_path,
      OLD.knowledge_resource_digest,
      OLD.billing_policy_version,
      OLD.validator_policy_version
    ) IS DISTINCT FROM ROW(
      NEW.owner_user_id,
      NEW.usage_id,
      NEW.capability_id,
      NEW.session_id,
      NEW.turn_id,
      NEW.request_fingerprint,
      NEW.charge_source,
      NEW.unit_price_cents,
      NEW.free_limit_snapshot,
      NEW.reserved_cents,
      NEW.created_at,
      NEW.product_kind,
      NEW.capability_protocol,
      NEW.release_id,
      NEW.package_digest,
      NEW.release_scope,
      NEW.knowledge_resource_path,
      NEW.knowledge_resource_digest,
      NEW.billing_policy_version,
      NEW.validator_policy_version
    ) THEN
      RAISE EXCEPTION 'knowledge usage binding is immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
   SECURITY INVOKER
   SET search_path = pg_catalog, public;

CREATE TRIGGER trg_knowledge_usage_binding_immutable
  BEFORE UPDATE ON usage_charges
  FOR EACH ROW EXECUTE FUNCTION reject_knowledge_usage_binding_mutation();

-- Once a receipt names the authoritative response, that exact Message cannot be rewritten or
-- removed. The application re-verifies response_digest against the exact answer-text bytes; the
-- database deliberately does not invent a canonical serializer for the existing JSON blocks.
CREATE FUNCTION reject_receipted_response_message_mutation() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.agent_usage_receipts
     WHERE response_message_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'receipted response Message is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
   SECURITY INVOKER
   SET search_path = pg_catalog, public;

CREATE TRIGGER trg_receipted_response_message_immutable
  BEFORE UPDATE OR DELETE ON messages
  FOR EACH ROW EXECUTE FUNCTION reject_receipted_response_message_mutation();

CREATE FUNCTION guard_agent_usage_receipt_write() RETURNS trigger AS $$
DECLARE
  charge_session uuid;
  charge_turn uuid;
  charge_product_kind text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT session_id, turn_id INTO charge_session, charge_turn
      FROM public.usage_charges
     WHERE id = NEW.usage_charge_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'agent usage receipt charge is missing' USING ERRCODE = '23503';
    END IF;
    PERFORM 1 FROM public.sessions WHERE id = charge_session FOR UPDATE;
    PERFORM 1 FROM public.turns WHERE id = charge_turn FOR UPDATE;
    SELECT product_kind INTO charge_product_kind
      FROM public.usage_charges
     WHERE id = NEW.usage_charge_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'agent usage receipt charge is missing' USING ERRCODE = '23503';
    END IF;
    IF charge_product_kind <> 'knowledge_agent_test' THEN
      RAISE EXCEPTION 'agent usage receipt requires a knowledge charge'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.response_message_id IS NOT NULL THEN
      -- The response row is last in the fixed lock order: Session, Turn, charge, Message.
      PERFORM 1
        FROM public.messages
       WHERE id = NEW.response_message_id
       FOR UPDATE;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'agent_usage_receipts is append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql
   SECURITY INVOKER
   SET search_path = pg_catalog, public;

CREATE TRIGGER trg_agent_usage_receipts_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON agent_usage_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_agent_usage_receipt_write();

CREATE TRIGGER trg_agent_usage_receipts_no_truncate
  BEFORE TRUNCATE ON agent_usage_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION guard_agent_usage_receipt_write();

-- At commit, every knowledge Turn is one of two coherent states: running with one reserved charge
-- and no completed response or receipt, or terminal with the mapped charge outcome, one exact
-- response when applicable, and exactly one receipt. All mirrors are compared after explicitly
-- locking the Session, Turn, charge, and bound response rows, so concurrent replays serialize.
CREATE FUNCTION enforce_knowledge_usage_receipt_equation() RETURNS trigger AS $$
DECLARE
  affected_turn uuid;
  affected_session uuid;
  session_row record;
  turn_status text;
  charge_row record;
  receipt_row record;
  response_message_row record;
  receipt_count bigint;
  completed_assistant_count bigint;
  invalid_citation_count bigint;
  distinct_citation_count bigint;
  canonical_citation_ids text[];
BEGIN
  IF TG_TABLE_NAME = 'turns' THEN
    affected_turn := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSIF TG_TABLE_NAME = 'usage_charges' THEN
    affected_turn := CASE WHEN TG_OP = 'DELETE' THEN OLD.turn_id ELSE NEW.turn_id END;
  ELSIF TG_TABLE_NAME = 'agent_usage_receipts' THEN
    -- A receipt's charge is authoritative. Never let a caller select a different Turn for the
    -- deferred equation by supplying internally consistent but unrelated receipt scope columns.
    SELECT turn_id INTO affected_turn
      FROM usage_charges
     WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.usage_charge_id ELSE NEW.usage_charge_id END;
    IF NOT FOUND THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END IF;
  ELSE
    affected_turn := CASE WHEN TG_OP = 'DELETE' THEN OLD.turn_id ELSE NEW.turn_id END;
    IF affected_turn IS NULL THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END IF;
  END IF;

  SELECT session_id INTO affected_session
    FROM turns
   WHERE id = affected_turn;

  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  -- Keep the lock order independent of planner join order: Session, then Turn, then charge.
  SELECT
      id,
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
    FROM sessions
   WHERE id = affected_session
   FOR UPDATE;
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT status INTO turn_status
    FROM turns
   WHERE id = affected_turn AND session_id = affected_session
   FOR UPDATE;
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT *
    INTO charge_row
    FROM usage_charges
   WHERE turn_id = affected_turn
   FOR UPDATE;

  IF session_row.product_kind = 'legacy_capability' THEN
    IF FOUND AND charge_row.product_kind <> 'legacy_capability' THEN
      RAISE EXCEPTION 'knowledge usage cannot bind a legacy Session'
        USING ERRCODE = '23514';
    END IF;
    IF FOUND AND EXISTS (
      SELECT 1
        FROM agent_usage_receipts
       WHERE usage_charge_id = charge_row.id OR turn_id = affected_turn
    ) THEN
      RAISE EXCEPTION 'legacy usage cannot have an agent usage receipt'
        USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'knowledge Turn requires exactly one usage charge'
      USING ERRCODE = '23514';
  END IF;

  IF ROW(
    charge_row.owner_user_id,
    charge_row.capability_id,
    charge_row.session_id,
    charge_row.product_kind,
    charge_row.capability_protocol,
    charge_row.release_id,
    charge_row.package_digest,
    charge_row.release_scope,
    charge_row.knowledge_resource_path,
    charge_row.knowledge_resource_digest
  ) IS DISTINCT FROM ROW(
    session_row.owner_user_id,
    session_row.capability_id,
    session_row.id,
    session_row.product_kind,
    session_row.capability_protocol,
    session_row.release_id,
    session_row.package_digest,
    session_row.release_scope,
    session_row.knowledge_resource_path,
    session_row.knowledge_resource_digest
  ) THEN
    RAISE EXCEPTION 'knowledge usage and Session binding diverged'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO receipt_count
    FROM agent_usage_receipts
   WHERE usage_charge_id = charge_row.id;

  SELECT count(*) INTO completed_assistant_count
    FROM messages
   WHERE turn_id = affected_turn
     AND role = 'assistant'
     AND status = 'completed';

  IF charge_row.status = 'reserved' THEN
    IF turn_status <> 'running'
       OR charge_row.execution_outcome IS NOT NULL
       OR receipt_count <> 0
       OR completed_assistant_count <> 0 THEN
      RAISE EXCEPTION 'reserved knowledge usage must have a running Turn and no response or receipt'
        USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF receipt_count <> 1 THEN
    RAISE EXCEPTION 'terminal knowledge usage requires exactly one receipt'
      USING ERRCODE = '23514';
  END IF;

  IF charge_row.execution_outcome IS NULL OR NOT (
    (charge_row.execution_outcome = 'answered'
      AND charge_row.status = 'completed'
      AND turn_status = 'completed')
    OR (charge_row.execution_outcome = 'insufficient_evidence'
      AND charge_row.status = 'released'
      AND turn_status = 'completed')
    OR (charge_row.execution_outcome = 'failed'
      AND charge_row.status = 'released'
      AND turn_status = 'failed')
    OR (charge_row.execution_outcome = 'interrupted'
      AND charge_row.status = 'released'
      AND turn_status = 'interrupted')
  ) THEN
    RAISE EXCEPTION 'knowledge Turn, charge status, and execution outcome diverged'
      USING ERRCODE = '23514';
  END IF;

  -- Receipt rows are append-only. A plain SELECT preserves the fixed lock order above without
  -- requiring Runtime UPDATE privilege on the receipt table.
  SELECT * INTO receipt_row
    FROM agent_usage_receipts
   WHERE usage_charge_id = charge_row.id;

  IF charge_row.execution_outcome IN ('answered', 'insufficient_evidence') THEN
    IF receipt_row.response_message_id IS NULL OR completed_assistant_count <> 1 THEN
      RAISE EXCEPTION 'answered knowledge usage requires one authoritative response Message'
        USING ERRCODE = '23514';
    END IF;
    SELECT id, session_id, turn_id, role, status
      INTO response_message_row
      FROM messages
     WHERE id = receipt_row.response_message_id
     FOR UPDATE;
    IF NOT FOUND
       OR response_message_row.session_id IS DISTINCT FROM charge_row.session_id
       OR response_message_row.turn_id IS DISTINCT FROM charge_row.turn_id
       OR response_message_row.role IS DISTINCT FROM 'assistant'
       OR response_message_row.status IS DISTINCT FROM 'completed' THEN
      RAISE EXCEPTION 'knowledge receipt response Message is invalid'
        USING ERRCODE = '23514';
    END IF;
  ELSIF receipt_row.response_message_id IS NOT NULL OR completed_assistant_count <> 0 THEN
    RAISE EXCEPTION 'failed knowledge usage cannot bind a completed response Message'
      USING ERRCODE = '23514';
  END IF;

  IF ROW(
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
  ) OR receipt_row.created_at < charge_row.created_at THEN
    RAISE EXCEPTION 'knowledge receipt and usage charge snapshots diverged'
      USING ERRCODE = '23514';
  END IF;

  SELECT
      count(*) FILTER (
        WHERE citation_id !~ '^chunk[.]knowledge[.][0-9a-f]{32}$'
      ),
      count(DISTINCT citation_id),
      COALESCE(array_agg(citation_id ORDER BY citation_id), '{}'::text[])
    INTO invalid_citation_count, distinct_citation_count, canonical_citation_ids
    FROM unnest(receipt_row.citation_chunk_ids) AS citation_id;

  IF invalid_citation_count <> 0
     OR distinct_citation_count <> cardinality(receipt_row.citation_chunk_ids)
     OR canonical_citation_ids <> receipt_row.citation_chunk_ids THEN
    RAISE EXCEPTION 'knowledge receipt citation references are invalid'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
   SECURITY INVOKER
   SET search_path = pg_catalog, public;

CREATE CONSTRAINT TRIGGER trg_turn_knowledge_usage_receipt_equation
  AFTER INSERT OR UPDATE OR DELETE ON turns
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_usage_receipt_equation();

CREATE CONSTRAINT TRIGGER trg_usage_charge_knowledge_receipt_equation
  AFTER INSERT OR UPDATE OR DELETE ON usage_charges
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_usage_receipt_equation();

CREATE CONSTRAINT TRIGGER trg_agent_usage_receipt_equation
  AFTER INSERT OR UPDATE OR DELETE ON agent_usage_receipts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_usage_receipt_equation();

CREATE CONSTRAINT TRIGGER trg_message_knowledge_receipt_equation
  AFTER INSERT OR UPDATE OR DELETE ON messages
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_usage_receipt_equation();

REVOKE ALL PRIVILEGES ON agent_usage_receipts
  FROM PUBLIC, combo_api, combo_worker, combo_runtime;
REVOKE ALL PRIVILEGES ON FUNCTION reject_agent_session_binding_mutation()
  FROM PUBLIC, combo_api, combo_worker, combo_runtime;
REVOKE ALL PRIVILEGES ON FUNCTION reject_knowledge_usage_binding_mutation()
  FROM PUBLIC, combo_api, combo_worker, combo_runtime;
REVOKE ALL PRIVILEGES ON FUNCTION reject_receipted_response_message_mutation()
  FROM PUBLIC, combo_api, combo_worker, combo_runtime;
REVOKE ALL PRIVILEGES ON FUNCTION guard_agent_usage_receipt_write()
  FROM PUBLIC, combo_api, combo_worker, combo_runtime;
REVOKE ALL PRIVILEGES ON FUNCTION enforce_knowledge_usage_receipt_equation()
  FROM PUBLIC, combo_api, combo_worker, combo_runtime;

-- Runtime owns Session execution and therefore appends and reads its user-visible receipts. IDs and
-- the transaction-time created_at are database generated. The API, worker, consumers, and PUBLIC
-- cannot write Registry or receipt truth.
GRANT SELECT ON agent_usage_receipts TO combo_runtime;
GRANT INSERT (
  protocol,
  usage_charge_id,
  owner_user_id,
  usage_id,
  capability_id,
  session_id,
  turn_id,
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
  charge_source,
  settled_cents,
  execution_outcome,
  validation_code,
  response_message_id,
  response_digest,
  citation_chunk_ids,
  execution_environment,
  runtime_release_id,
  runtime_source_sha
) ON agent_usage_receipts TO combo_runtime;
GRANT UPDATE (execution_outcome) ON usage_charges TO combo_runtime;
