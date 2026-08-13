-- 0013 · Expand-only groundwork for the invite-only Consumer create surface.
--
-- 0012 may already be present in a persistent Test/Preview ledger and is immutable. This
-- migration adds authorization and idempotency without enabling the public HTTP surface; the
-- Runtime feature flag remains fail-closed until Conversation open/ready, revoke and send gates
-- are implemented and verified end to end.

-- ===================== invite-only Agent access =====================

-- Align the published AgentView contract (maximum 64 characters). 0012's unnamed check used a
-- 63-character quantifier; change it only through this append-only migration.
ALTER TABLE agents
  DROP CONSTRAINT agents_public_slug_check,
  ADD CONSTRAINT ck_agents_public_slug
    CHECK (public_slug ~ '^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$');

CREATE TABLE agent_access_grants (
  id                   uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  agent_id             uuid        NOT NULL,
  creator_id           uuid        NOT NULL,
  consumer_subject_id  uuid        NOT NULL REFERENCES users(id),
  state                text        NOT NULL DEFAULT 'ACTIVE'
                       CONSTRAINT ck_agent_access_grants_state CHECK (
                         state IN ('ACTIVE', 'REVOKED')
                       ),
  created_at           timestamptz NOT NULL DEFAULT now(),
  revoked_at           timestamptz,
  CONSTRAINT fk_agent_access_grants_agent_creator
    FOREIGN KEY (agent_id, creator_id) REFERENCES agents (id, creator_id),
  CONSTRAINT uq_agent_access_grants_agent_consumer
    UNIQUE (agent_id, consumer_subject_id),
  CONSTRAINT uq_agent_access_grants_id_creator_consumer
    UNIQUE (id, creator_id, consumer_subject_id),
  CONSTRAINT ck_agent_access_grants_revoked CHECK (
    (state = 'ACTIVE' AND revoked_at IS NULL)
    OR (state = 'REVOKED' AND revoked_at >= created_at)
  )
);

CREATE INDEX idx_agent_access_grants_consumer_active
  ON agent_access_grants (consumer_subject_id, agent_id)
  WHERE state = 'ACTIVE';

CREATE OR REPLACE FUNCTION enforce_creator_agent_access_grant_transition()
RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.creator_id IS DISTINCT FROM OLD.creator_id
     OR NEW.consumer_subject_id IS DISTINCT FROM OLD.consumer_subject_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'agent access grant binding is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'REVOKED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'revoked agent access grant is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
     AND NOT (OLD.state = 'ACTIVE' AND NEW.state = 'REVOKED') THEN
    RAISE EXCEPTION 'invalid agent access grant transition % -> %', OLD.state, NEW.state
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION enforce_creator_agent_access_grant_transition() FROM PUBLIC;

CREATE TRIGGER agent_access_grants_transition
BEFORE UPDATE ON agent_access_grants
FOR EACH ROW EXECUTE FUNCTION enforce_creator_agent_access_grant_transition();

-- ===================== append-only Conversation idempotency =====================

ALTER TABLE agent_conversations
  ADD COLUMN idempotency_key uuid,
  ADD COLUMN request_digest text;

-- 0012's transition trigger quite correctly freezes terminal rows. Backfilling the two new
-- immutable compatibility fields would therefore fail as soon as a persistent database contains
-- a CLOSED/FAILED/EXPIRED Conversation. Remove only this trigger inside the migration transaction,
-- backfill every historical row, then install the expanded trigger below before commit.
DROP TRIGGER agent_conversations_transition ON agent_conversations;

-- Existing internal Conversations predate the public create protocol. Give each one a stable,
-- unique compatibility identity rather than pretending it came from a Consumer request.
UPDATE agent_conversations
   SET idempotency_key = id,
       request_digest = encode(
         digest('combo.creator-agent-pre-0013-conversation/1:' || id::text, 'sha256'),
         'hex'
       );

ALTER TABLE agent_conversations
  ALTER COLUMN idempotency_key SET NOT NULL,
  ALTER COLUMN request_digest SET NOT NULL,
  ADD CONSTRAINT ck_agent_conversations_request_digest
    CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT uq_agent_conversations_consumer_idempotency
    UNIQUE (consumer_subject_id, idempotency_key);

CREATE OR REPLACE FUNCTION enforce_creator_agent_conversation_transition()
RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION enforce_creator_agent_conversation_transition() FROM PUBLIC;

CREATE TRIGGER agent_conversations_transition
BEFORE UPDATE ON agent_conversations
FOR EACH ROW EXECUTE FUNCTION enforce_creator_agent_conversation_transition();

-- ===================== race-free grant and exact Lease/Fence checks =====================

CREATE OR REPLACE FUNCTION creator_agent_lock_live_worker(
  input_deployment_id uuid,
  input_creator_id uuid,
  input_worker_id uuid,
  input_fence bigint
)
RETURNS boolean
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
BEGIN
  IF input_creator_id IS DISTINCT FROM
       NULLIF(current_setting('app.creator_id', true), '')::uuid THEN
    RETURN false;
  END IF;

  PERFORM 1
    FROM public.worker_leases AS lease
    JOIN public.worker_installations AS worker
      ON worker.id = lease.worker_id
     AND worker.creator_id = lease.creator_id
   WHERE lease.deployment_id = input_deployment_id
     AND lease.creator_id = input_creator_id
     AND lease.worker_id = input_worker_id
     AND lease.fence = input_fence
     AND lease.state = 'ACTIVE'
     AND lease.expires_at > clock_timestamp() + interval '3 seconds'
     AND worker.revoked_at IS NULL
   FOR SHARE OF lease, worker;
  RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION creator_agent_lock_live_worker(uuid, uuid, uuid, bigint) FROM PUBLIC;

CREATE OR REPLACE FUNCTION creator_agent_lock_consumer_access(
  input_agent_id uuid,
  input_creator_id uuid,
  input_consumer_id uuid
)
RETURNS boolean
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
BEGIN
  IF input_creator_id IS DISTINCT FROM
       NULLIF(current_setting('app.creator_id', true), '')::uuid
     OR input_consumer_id IS DISTINCT FROM
       NULLIF(current_setting('app.consumer_id', true), '')::uuid THEN
    RETURN false;
  END IF;

  PERFORM 1
    FROM public.agents AS agent
    JOIN public.agent_access_grants AS access_grant
      ON access_grant.agent_id = agent.id
     AND access_grant.creator_id = agent.creator_id
     AND access_grant.consumer_subject_id = input_consumer_id
     AND access_grant.state = 'ACTIVE'
   WHERE agent.id = input_agent_id
     AND agent.creator_id = input_creator_id
     AND agent.lifecycle = 'ACTIVE'
   FOR SHARE OF agent, access_grant;
  RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION creator_agent_lock_consumer_access(uuid, uuid, uuid) FROM PUBLIC;

-- ===================== forced tenant isolation and least privilege =====================

ALTER TABLE agent_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_access_grants FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_access_grants_creator ON agent_access_grants
  USING (creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid)
  WITH CHECK (creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid);
CREATE POLICY agent_access_grants_consumer_select ON agent_access_grants
  FOR SELECT
  USING (
    consumer_subject_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
  );
CREATE POLICY agents_consumer_select ON agents
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
        FROM agent_access_grants AS access_grant
       WHERE access_grant.agent_id = agents.id
         AND access_grant.creator_id = agents.creator_id
         AND access_grant.consumer_subject_id =
             NULLIF(current_setting('app.consumer_id', true), '')::uuid
         AND access_grant.state = 'ACTIVE'
    )
  );
CREATE POLICY agent_conversations_consumer_select ON agent_conversations
  FOR SELECT
  USING (
    consumer_subject_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
  );

REVOKE ALL PRIVILEGES ON agent_access_grants
FROM PUBLIC, combo_api, combo_worker, combo_runtime,
  combo_agent_api, combo_agent_broker, combo_agent_reconciler, combo_agent_maintenance;

GRANT SELECT, INSERT ON agent_access_grants TO combo_agent_api;
GRANT EXECUTE ON FUNCTION creator_agent_lock_live_worker(uuid, uuid, uuid, bigint)
  TO combo_agent_api;
GRANT EXECUTE ON FUNCTION creator_agent_lock_consumer_access(uuid, uuid, uuid)
  TO combo_agent_api;
