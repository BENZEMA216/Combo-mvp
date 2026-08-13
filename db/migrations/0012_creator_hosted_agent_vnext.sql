-- 0012 · Creator-hosted Agent VNext authority model.
--
-- PostgreSQL owns immutable Snapshot/AgentVersion metadata, Deployment/Lease state,
-- Consumer conversations, the Invocation projection, the append-only Event journal,
-- and the transactional Broker Outbox. Redis and WebSocket state are never authoritative.

-- ===================== constrained service roles =====================

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'combo_agent_api') THEN
    EXECUTE 'CREATE ROLE combo_agent_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'combo_agent_broker') THEN
    EXECUTE 'CREATE ROLE combo_agent_broker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'combo_agent_reconciler') THEN
    EXECUTE 'CREATE ROLE combo_agent_reconciler NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'combo_agent_maintenance') THEN
    EXECUTE 'CREATE ROLE combo_agent_maintenance NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
END
$roles$;

ALTER ROLE combo_agent_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE combo_agent_broker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE combo_agent_reconciler NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE combo_agent_maintenance NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO
  combo_agent_api,
  combo_agent_broker,
  combo_agent_reconciler,
  combo_agent_maintenance;

-- ===================== reusable hard constraints =====================

CREATE OR REPLACE FUNCTION reject_creator_agent_immutable_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'creator-hosted Agent immutable row cannot be changed'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION reject_creator_agent_immutable_mutation() FROM PUBLIC;

-- ===================== Snapshot upload and immutable object index =====================

CREATE TABLE snapshot_uploads (
  id                        uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  creator_id                uuid        NOT NULL REFERENCES users(id),
  idempotency_key           text        NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  request_digest            text        NOT NULL CHECK (request_digest ~ '^hmac-sha256:[a-f0-9]{64}$'),
  expected_snapshot_digest  text        NOT NULL CHECK (expected_snapshot_digest ~ '^[a-f0-9]{64}$'),
  expected_archive_digest   text        NOT NULL CHECK (expected_archive_digest ~ '^[a-f0-9]{64}$'),
  expected_compressed_bytes bigint      NOT NULL CHECK (expected_compressed_bytes BETWEEN 1 AND 52428800),
  temp_object_key           text        NOT NULL UNIQUE CHECK (length(temp_object_key) BETWEEN 1 AND 1024),
  state                     text        NOT NULL DEFAULT 'CREATED'
                            CONSTRAINT ck_snapshot_uploads_state CHECK (
                              state IN ('CREATED', 'UPLOADED', 'VERIFYING', 'VERIFIED', 'REJECTED', 'EXPIRED')
                            ),
  error_code                text,
  expires_at                timestamptz NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  verified_at               timestamptz,
  CONSTRAINT uq_snapshot_uploads_creator_idempotency UNIQUE (creator_id, idempotency_key),
  CONSTRAINT uq_snapshot_uploads_id_creator UNIQUE (id, creator_id),
  CONSTRAINT ck_snapshot_uploads_expiry CHECK (expires_at > created_at),
  CONSTRAINT ck_snapshot_uploads_verified CHECK (
    (state = 'VERIFIED' AND verified_at IS NOT NULL AND error_code IS NULL)
    OR (state <> 'VERIFIED' AND verified_at IS NULL)
  ),
  CONSTRAINT ck_snapshot_uploads_error CHECK (
    (state IN ('REJECTED', 'EXPIRED') AND error_code IS NOT NULL)
    OR (state NOT IN ('REJECTED', 'EXPIRED') AND error_code IS NULL)
  )
);

CREATE INDEX idx_snapshot_uploads_creator_created
  ON snapshot_uploads (creator_id, created_at DESC);
CREATE INDEX idx_snapshot_uploads_expirable
  ON snapshot_uploads (expires_at)
  WHERE state IN ('CREATED', 'UPLOADED', 'VERIFYING');

CREATE OR REPLACE FUNCTION enforce_creator_agent_snapshot_upload_transition()
RETURNS trigger AS $$
DECLARE
  transition_allowed boolean;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.creator_id IS DISTINCT FROM OLD.creator_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
     OR NEW.expected_snapshot_digest IS DISTINCT FROM OLD.expected_snapshot_digest
     OR NEW.expected_archive_digest IS DISTINCT FROM OLD.expected_archive_digest
     OR NEW.expected_compressed_bytes IS DISTINCT FROM OLD.expected_compressed_bytes
     OR NEW.temp_object_key IS DISTINCT FROM OLD.temp_object_key
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'snapshot upload request binding is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state IN ('VERIFIED', 'REJECTED', 'EXPIRED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal snapshot upload is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.state <> OLD.state THEN
    transition_allowed := CASE OLD.state
      WHEN 'CREATED' THEN NEW.state IN ('UPLOADED', 'REJECTED', 'EXPIRED')
      WHEN 'UPLOADED' THEN NEW.state IN ('VERIFYING', 'REJECTED', 'EXPIRED')
      WHEN 'VERIFYING' THEN NEW.state IN ('VERIFIED', 'REJECTED', 'EXPIRED')
      ELSE false
    END;
    IF NOT transition_allowed THEN
      RAISE EXCEPTION 'invalid snapshot upload transition % -> %', OLD.state, NEW.state
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.state = 'EXPIRED' AND OLD.expires_at > now() THEN
    RAISE EXCEPTION 'snapshot upload cannot expire before its Cloud deadline'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION enforce_creator_agent_snapshot_upload_transition() FROM PUBLIC;

CREATE TRIGGER snapshot_uploads_transition
BEFORE UPDATE ON snapshot_uploads
FOR EACH ROW EXECUTE FUNCTION enforce_creator_agent_snapshot_upload_transition();

CREATE TABLE context_snapshots (
  id                   uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  creator_id           uuid        NOT NULL REFERENCES users(id),
  snapshot_digest      text        NOT NULL CHECK (snapshot_digest ~ '^[a-f0-9]{64}$'),
  archive_digest       text        NOT NULL CHECK (archive_digest ~ '^[a-f0-9]{64}$'),
  cipher_digest        text        NOT NULL CHECK (cipher_digest ~ '^[a-f0-9]{64}$'),
  object_key           text        NOT NULL UNIQUE CHECK (length(object_key) BETWEEN 1 AND 1024),
  manifest_object_key  text        NOT NULL UNIQUE CHECK (length(manifest_object_key) BETWEEN 1 AND 1024),
  compressed_bytes     bigint      NOT NULL CHECK (compressed_bytes BETWEEN 1 AND 52428800),
  expanded_bytes       bigint      NOT NULL CHECK (expanded_bytes BETWEEN 0 AND 209715200),
  file_count           integer     NOT NULL CHECK (file_count BETWEEN 1 AND 2000),
  encryption_key_ref   text        NOT NULL CHECK (length(encryption_key_ref) BETWEEN 1 AND 512),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_context_snapshots_creator_digest UNIQUE (creator_id, snapshot_digest),
  CONSTRAINT uq_context_snapshots_id_creator UNIQUE (id, creator_id),
  CONSTRAINT ck_context_snapshots_ratio CHECK (
    compressed_bytes > 0 AND expanded_bytes <= compressed_bytes * 100
  )
);

CREATE TRIGGER context_snapshots_immutable
BEFORE UPDATE OR DELETE ON context_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_creator_agent_immutable_mutation();

-- ===================== Agent, immutable Version, and mutable controls =====================

CREATE TABLE agents (
  id           uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  creator_id   uuid        NOT NULL REFERENCES users(id),
  public_slug  text        NOT NULL UNIQUE CHECK (public_slug ~ '^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$'),
  name         text        NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  description  text        NOT NULL DEFAULT '' CHECK (length(description) <= 2048),
  lifecycle    text        NOT NULL DEFAULT 'ACTIVE'
               CONSTRAINT ck_agents_lifecycle CHECK (lifecycle IN ('ACTIVE', 'ARCHIVED')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_agents_id_creator UNIQUE (id, creator_id)
);

CREATE INDEX idx_agents_creator_created ON agents (creator_id, created_at DESC);

CREATE OR REPLACE FUNCTION enforce_creator_agent_agent_transition()
RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.creator_id IS DISTINCT FROM OLD.creator_id
     OR NEW.public_slug IS DISTINCT FROM OLD.public_slug
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'agent identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.lifecycle = 'ARCHIVED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'archived agent is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'agent update time is monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION enforce_creator_agent_agent_transition() FROM PUBLIC;

CREATE TRIGGER agents_transition
BEFORE UPDATE ON agents
FOR EACH ROW EXECUTE FUNCTION enforce_creator_agent_agent_transition();

CREATE TABLE agent_versions (
  id                             uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  agent_id                       uuid        NOT NULL,
  creator_id                     uuid        NOT NULL,
  ordinal                        integer     NOT NULL CHECK (ordinal >= 1),
  schema_version                 integer     NOT NULL CHECK (schema_version = 1),
  version_digest                 text        NOT NULL CHECK (version_digest ~ '^[a-f0-9]{64}$'),
  snapshot_id                    uuid        NOT NULL,
  behavior_contract              jsonb       NOT NULL CHECK (jsonb_typeof(behavior_contract) = 'object'),
  behavior_contract_digest       text        NOT NULL CHECK (behavior_contract_digest ~ '^[a-f0-9]{64}$'),
  runtime_policy                 jsonb       NOT NULL CHECK (jsonb_typeof(runtime_policy) = 'object'),
  runtime_policy_digest          text        NOT NULL CHECK (runtime_policy_digest ~ '^[a-f0-9]{64}$'),
  io_contract                    jsonb       NOT NULL CHECK (jsonb_typeof(io_contract) = 'object'),
  io_contract_digest             text        NOT NULL CHECK (io_contract_digest ~ '^[a-f0-9]{64}$'),
  model_policy                   jsonb       NOT NULL CHECK (jsonb_typeof(model_policy) = 'object'),
  model_policy_digest            text        NOT NULL CHECK (model_policy_digest ~ '^[a-f0-9]{64}$'),
  codex_runtime_version          text        NOT NULL CHECK (length(codex_runtime_version) BETWEEN 1 AND 128),
  codex_runtime_artifact_digest  text        NOT NULL CHECK (codex_runtime_artifact_digest ~ '^sha256:[a-f0-9]{64}$'),
  codex_protocol_schema_digest   text        NOT NULL CHECK (codex_protocol_schema_digest ~ '^sha256:[a-f0-9]{64}$'),
  created_at                     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_agent_versions_agent_creator
    FOREIGN KEY (agent_id, creator_id) REFERENCES agents (id, creator_id),
  CONSTRAINT fk_agent_versions_snapshot_creator
    FOREIGN KEY (snapshot_id, creator_id) REFERENCES context_snapshots (id, creator_id),
  CONSTRAINT uq_agent_versions_agent_ordinal UNIQUE (agent_id, ordinal),
  CONSTRAINT uq_agent_versions_agent_digest UNIQUE (agent_id, version_digest),
  CONSTRAINT uq_agent_versions_id_creator UNIQUE (id, creator_id),
  CONSTRAINT uq_agent_versions_id_agent_creator UNIQUE (id, agent_id, creator_id),
  CONSTRAINT uq_agent_versions_execution_binding
    UNIQUE (id, agent_id, creator_id, version_digest)
);

CREATE TRIGGER agent_versions_immutable
BEFORE UPDATE OR DELETE ON agent_versions
FOR EACH ROW EXECUTE FUNCTION reject_creator_agent_immutable_mutation();

CREATE TABLE agent_version_controls (
  version_id     uuid        PRIMARY KEY,
  creator_id     uuid        NOT NULL,
  availability   text        NOT NULL DEFAULT 'ACTIVE'
                 CONSTRAINT ck_agent_version_controls_availability CHECK (
                   availability IN ('ACTIVE', 'DEPRECATED', 'REVOKED')
                 ),
  severity       text        NOT NULL DEFAULT 'NORMAL'
                 CONSTRAINT ck_agent_version_controls_severity CHECK (
                   severity IN ('NORMAL', 'SECURITY')
                 ),
  reason_code    text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_agent_version_controls_version_creator
    FOREIGN KEY (version_id, creator_id) REFERENCES agent_versions (id, creator_id),
  CONSTRAINT uq_agent_version_controls_id_creator UNIQUE (version_id, creator_id)
);

CREATE OR REPLACE FUNCTION enforce_creator_agent_version_control_transition()
RETURNS trigger AS $$
BEGIN
  IF NEW.version_id IS DISTINCT FROM OLD.version_id
     OR NEW.creator_id IS DISTINCT FROM OLD.creator_id THEN
    RAISE EXCEPTION 'agent version control identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.availability = 'REVOKED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'revoked agent version is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.availability = 'DEPRECATED' AND NEW.availability = 'ACTIVE' THEN
    RAISE EXCEPTION 'deprecated agent version cannot be reactivated'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.severity = 'SECURITY' AND NEW.severity <> 'SECURITY' THEN
    RAISE EXCEPTION 'security severity cannot be downgraded'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'agent version control time is monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION enforce_creator_agent_version_control_transition() FROM PUBLIC;

CREATE TRIGGER agent_version_controls_transition
BEFORE UPDATE ON agent_version_controls
FOR EACH ROW EXECUTE FUNCTION enforce_creator_agent_version_control_transition();

-- ===================== Deployment, installation, and fenced Lease =====================

CREATE TABLE deployments (
  id                  uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  agent_id            uuid        NOT NULL,
  creator_id          uuid        NOT NULL,
  environment         text        NOT NULL
                      CONSTRAINT ck_deployments_environment CHECK (environment IN ('TEST', 'PREVIEW', 'PROD')),
  desired_state       text        NOT NULL DEFAULT 'OFFLINE'
                      CONSTRAINT ck_deployments_desired_state CHECK (desired_state IN ('ONLINE', 'OFFLINE')),
  desired_version_id  uuid        NOT NULL,
  serving_version_id  uuid,
  observed_state      text        NOT NULL DEFAULT 'OFFLINE'
                      CONSTRAINT ck_deployments_observed_state CHECK (
                        observed_state IN ('OFFLINE', 'PREPARING', 'ONLINE', 'UPDATING', 'DRAINING', 'DEGRADED', 'BLOCKED')
                      ),
  generation          bigint      NOT NULL DEFAULT 0 CHECK (generation BETWEEN 0 AND 9223372036854775807),
  lease_fence         bigint      NOT NULL DEFAULT 0 CHECK (lease_fence BETWEEN 0 AND 9223372036854775807),
  observed_worker_id  uuid,
  observed_generation bigint      CHECK (observed_generation BETWEEN 0 AND 9223372036854775807),
  last_error_code     text,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_deployments_agent_creator
    FOREIGN KEY (agent_id, creator_id) REFERENCES agents (id, creator_id),
  CONSTRAINT fk_deployments_desired_version
    FOREIGN KEY (desired_version_id, agent_id, creator_id)
    REFERENCES agent_versions (id, agent_id, creator_id),
  CONSTRAINT fk_deployments_serving_version
    FOREIGN KEY (serving_version_id, agent_id, creator_id)
    REFERENCES agent_versions (id, agent_id, creator_id),
  CONSTRAINT uq_deployments_agent_environment UNIQUE (agent_id, environment),
  CONSTRAINT uq_deployments_id_creator UNIQUE (id, creator_id),
  CONSTRAINT uq_deployments_id_agent_creator UNIQUE (id, agent_id, creator_id)
);

CREATE TABLE worker_installations (
  id                       uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  creator_id               uuid        NOT NULL REFERENCES users(id),
  installation_key_id      text        NOT NULL UNIQUE CHECK (length(installation_key_id) BETWEEN 1 AND 256),
  device_public_key        bytea       NOT NULL CHECK (octet_length(device_public_key) = 65),
  worker_version           text        NOT NULL CHECK (length(worker_version) BETWEEN 1 AND 128),
  protocol_versions        jsonb       NOT NULL CHECK (jsonb_typeof(protocol_versions) = 'array'),
  capabilities             jsonb       NOT NULL CHECK (jsonb_typeof(capabilities) = 'object'),
  last_seen_at             timestamptz NOT NULL DEFAULT now(),
  revoked_at               timestamptz,
  CONSTRAINT uq_worker_installations_id_creator UNIQUE (id, creator_id)
);

CREATE OR REPLACE FUNCTION enforce_creator_agent_worker_installation_transition()
RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.creator_id IS DISTINCT FROM OLD.creator_id
     OR NEW.installation_key_id IS DISTINCT FROM OLD.installation_key_id
     OR NEW.device_public_key IS DISTINCT FROM OLD.device_public_key THEN
    RAISE EXCEPTION 'worker installation identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'revoked worker installation is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.last_seen_at < OLD.last_seen_at THEN
    RAISE EXCEPTION 'worker last-seen time is monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION enforce_creator_agent_worker_installation_transition() FROM PUBLIC;

CREATE TRIGGER worker_installations_transition
BEFORE UPDATE ON worker_installations
FOR EACH ROW EXECUTE FUNCTION enforce_creator_agent_worker_installation_transition();

ALTER TABLE deployments
  ADD CONSTRAINT fk_deployments_observed_worker_creator
  FOREIGN KEY (observed_worker_id, creator_id)
  REFERENCES worker_installations (id, creator_id);

CREATE OR REPLACE FUNCTION enforce_creator_agent_deployment_transition()
RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.creator_id IS DISTINCT FROM OLD.creator_id
     OR NEW.environment IS DISTINCT FROM OLD.environment THEN
    RAISE EXCEPTION 'deployment identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.generation < OLD.generation OR NEW.lease_fence < OLD.lease_fence THEN
    RAISE EXCEPTION 'deployment generation and lease fence are monotonic'
      USING ERRCODE = '23514';
  END IF;
  IF (NEW.desired_state IS DISTINCT FROM OLD.desired_state
      OR NEW.desired_version_id IS DISTINCT FROM OLD.desired_version_id)
     AND NEW.generation <= OLD.generation THEN
    RAISE EXCEPTION 'desired deployment changes require a new generation'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.observed_generation IS NOT NULL AND (
       NEW.observed_generation IS NULL
       OR NEW.observed_generation < OLD.observed_generation
     ) THEN
    RAISE EXCEPTION 'observed deployment generation is monotonic'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.observed_generation IS NOT NULL AND NEW.observed_generation > NEW.generation THEN
    RAISE EXCEPTION 'observed deployment generation cannot exceed desired generation'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'deployment update time is monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION enforce_creator_agent_deployment_transition() FROM PUBLIC;

CREATE TRIGGER deployments_transition
BEFORE UPDATE ON deployments
FOR EACH ROW EXECUTE FUNCTION enforce_creator_agent_deployment_transition();

CREATE TABLE worker_leases (
  id             uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  deployment_id  uuid        NOT NULL,
  creator_id     uuid        NOT NULL,
  worker_id      uuid        NOT NULL,
  connection_id  uuid        NOT NULL,
  fence          bigint      NOT NULL CHECK (fence BETWEEN 1 AND 9223372036854775807),
  state          text        NOT NULL DEFAULT 'ACTIVE'
                 CONSTRAINT ck_worker_leases_state CHECK (state IN ('ACTIVE', 'EXPIRED', 'RELEASED', 'REVOKED')),
  acquired_at    timestamptz NOT NULL DEFAULT now(),
  renewed_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  CONSTRAINT fk_worker_leases_deployment_creator
    FOREIGN KEY (deployment_id, creator_id) REFERENCES deployments (id, creator_id),
  CONSTRAINT fk_worker_leases_worker_creator
    FOREIGN KEY (worker_id, creator_id) REFERENCES worker_installations (id, creator_id),
  CONSTRAINT uq_worker_leases_id_creator UNIQUE (id, creator_id),
  CONSTRAINT uq_worker_leases_binding UNIQUE (id, creator_id, worker_id, fence),
  CONSTRAINT ck_worker_leases_times CHECK (
    renewed_at >= acquired_at AND expires_at > renewed_at
  )
);

CREATE UNIQUE INDEX uq_worker_leases_deployment_active
  ON worker_leases (deployment_id)
  WHERE state = 'ACTIVE';
CREATE UNIQUE INDEX uq_worker_leases_deployment_fence
  ON worker_leases (deployment_id, fence);
CREATE INDEX idx_worker_leases_expirable
  ON worker_leases (expires_at)
  WHERE state = 'ACTIVE';

CREATE OR REPLACE FUNCTION enforce_creator_agent_lease_transition()
RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.deployment_id IS DISTINCT FROM OLD.deployment_id
     OR NEW.creator_id IS DISTINCT FROM OLD.creator_id
     OR NEW.worker_id IS DISTINCT FROM OLD.worker_id
     OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.fence IS DISTINCT FROM OLD.fence
     OR NEW.acquired_at IS DISTINCT FROM OLD.acquired_at THEN
    RAISE EXCEPTION 'worker lease binding is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state <> 'ACTIVE' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal worker lease is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'ACTIVE'
     AND NEW.state NOT IN ('ACTIVE', 'EXPIRED', 'RELEASED', 'REVOKED') THEN
    RAISE EXCEPTION 'invalid worker lease transition'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.renewed_at < OLD.renewed_at OR NEW.expires_at < OLD.expires_at THEN
    RAISE EXCEPTION 'worker lease renewal and expiry are monotonic'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'EXPIRED' AND OLD.expires_at > now() THEN
    RAISE EXCEPTION 'worker lease cannot expire before its Cloud deadline'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION enforce_creator_agent_lease_transition() FROM PUBLIC;

CREATE TRIGGER worker_leases_transition
BEFORE UPDATE ON worker_leases
FOR EACH ROW EXECUTE FUNCTION enforce_creator_agent_lease_transition();

-- ===================== Version-pinned Consumer conversation and encrypted messages =====================

CREATE TABLE agent_conversations (
  id                   uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  agent_id             uuid        NOT NULL,
  deployment_id        uuid        NOT NULL,
  agent_version_id     uuid        NOT NULL,
  creator_id           uuid        NOT NULL,
  consumer_subject_id  uuid        NOT NULL REFERENCES users(id),
  version_digest       text        NOT NULL CHECK (version_digest ~ '^[a-f0-9]{64}$'),
  state                text        NOT NULL DEFAULT 'OPENING'
                       CONSTRAINT ck_agent_conversations_state CHECK (
                         state IN ('OPENING', 'IDLE', 'BUSY', 'SUSPENDED', 'CLOSING', 'CLOSED', 'FAILED', 'EXPIRED')
                       ),
  assigned_worker_id   uuid,
  next_turn_no         integer     NOT NULL DEFAULT 1 CHECK (next_turn_no BETWEEN 1 AND 21),
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_activity_at     timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  closed_at            timestamptz,
  CONSTRAINT fk_agent_conversations_agent_creator
    FOREIGN KEY (agent_id, creator_id) REFERENCES agents (id, creator_id),
  CONSTRAINT fk_agent_conversations_deployment_agent_creator
    FOREIGN KEY (deployment_id, agent_id, creator_id)
    REFERENCES deployments (id, agent_id, creator_id),
  CONSTRAINT fk_agent_conversations_version_agent_creator
    FOREIGN KEY (agent_version_id, agent_id, creator_id, version_digest)
    REFERENCES agent_versions (id, agent_id, creator_id, version_digest),
  CONSTRAINT fk_agent_conversations_worker_creator
    FOREIGN KEY (assigned_worker_id, creator_id)
    REFERENCES worker_installations (id, creator_id),
  CONSTRAINT uq_agent_conversations_id_creator_consumer
    UNIQUE (id, creator_id, consumer_subject_id),
  CONSTRAINT uq_agent_conversations_invocation_binding
    UNIQUE (id, agent_version_id, creator_id, consumer_subject_id),
  CONSTRAINT ck_agent_conversations_expiry CHECK (expires_at > created_at),
  CONSTRAINT ck_agent_conversations_closed CHECK (
    (state IN ('CLOSED', 'FAILED', 'EXPIRED') AND closed_at IS NOT NULL)
    OR (state NOT IN ('CLOSED', 'FAILED', 'EXPIRED') AND closed_at IS NULL)
  )
);

CREATE INDEX idx_agent_conversations_consumer_activity
  ON agent_conversations (consumer_subject_id, last_activity_at DESC);
CREATE INDEX idx_agent_conversations_creator_activity
  ON agent_conversations (creator_id, last_activity_at DESC);

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

CREATE TABLE agent_messages (
  id                    uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  conversation_id       uuid        NOT NULL,
  creator_id            uuid        NOT NULL,
  consumer_subject_id   uuid        NOT NULL,
  turn_no               integer     NOT NULL CHECK (turn_no BETWEEN 1 AND 20),
  role                  text        NOT NULL
                        CONSTRAINT ck_agent_messages_role CHECK (role IN ('USER', 'ASSISTANT')),
  client_message_id     text        CHECK (client_message_id IS NULL OR length(client_message_id) BETWEEN 1 AND 256),
  content_algorithm     text        NOT NULL CHECK (content_algorithm = 'aes-256-gcm/v1'),
  content_key_id        text        NOT NULL CHECK (length(content_key_id) BETWEEN 1 AND 256),
  content_nonce         bytea       NOT NULL CHECK (octet_length(content_nonce) = 12),
  content_ciphertext    bytea       NOT NULL CHECK (octet_length(content_ciphertext) BETWEEN 1 AND 65536),
  content_auth_tag      bytea       NOT NULL CHECK (octet_length(content_auth_tag) = 16),
  content_cipher_digest text        NOT NULL CHECK (content_cipher_digest ~ '^[a-f0-9]{64}$'),
  content_digest        text        NOT NULL CHECK (content_digest ~ '^hmac-sha256:[a-f0-9]{64}$'),
  content_aad_version   integer     NOT NULL CHECK (content_aad_version = 1),
  invocation_id         uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_agent_messages_conversation_tenant
    FOREIGN KEY (conversation_id, creator_id, consumer_subject_id)
    REFERENCES agent_conversations (id, creator_id, consumer_subject_id),
  CONSTRAINT uq_agent_messages_conversation_turn_role UNIQUE (conversation_id, turn_no, role),
  CONSTRAINT uq_agent_messages_conversation_client UNIQUE (conversation_id, client_message_id),
  CONSTRAINT uq_agent_messages_aead_nonce UNIQUE (content_key_id, content_nonce),
  CONSTRAINT uq_agent_messages_invocation_role UNIQUE (invocation_id, role),
  CONSTRAINT uq_agent_messages_id_conversation_tenant
    UNIQUE (id, conversation_id, creator_id, consumer_subject_id),
  CONSTRAINT ck_agent_messages_client_role CHECK (
    (role = 'USER' AND client_message_id IS NOT NULL)
    OR (role = 'ASSISTANT' AND client_message_id IS NULL)
  )
);

CREATE TRIGGER agent_messages_immutable
BEFORE UPDATE OR DELETE ON agent_messages
FOR EACH ROW EXECUTE FUNCTION reject_creator_agent_immutable_mutation();

-- ===================== Invocation projection, append-only Event journal, and Outbox =====================

CREATE TABLE agent_invocations (
  id                       uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  conversation_id          uuid        NOT NULL,
  creator_id               uuid        NOT NULL,
  consumer_subject_id      uuid        NOT NULL,
  agent_version_id         uuid        NOT NULL,
  user_message_id          uuid        NOT NULL,
  client_message_id        text        NOT NULL CHECK (length(client_message_id) BETWEEN 1 AND 256),
  request_digest           text        NOT NULL CHECK (request_digest ~ '^hmac-sha256:[a-f0-9]{64}$'),
  state                    text        NOT NULL DEFAULT 'ACCEPTED'
                           CONSTRAINT ck_agent_invocations_state CHECK (
                             state IN (
                               'ACCEPTED', 'QUEUED', 'DISPATCH_PENDING', 'PERSISTED', 'STARTING',
                               'RUNNING', 'CANCEL_REQUESTED', 'RECONCILING', 'SUCCEEDED', 'FAILED',
                               'CANCELLED', 'UNCERTAIN', 'EXPIRED'
                             )
                           ),
  assigned_worker_id       uuid,
  assignment_lease_id      uuid,
  assignment_fence         bigint      CHECK (assignment_fence BETWEEN 1 AND 9223372036854775807),
  execution_capability_id  uuid,
  deadline_at              timestamptz NOT NULL,
  cancel_requested_at      timestamptz,
  runtime_thread_id        text        CHECK (runtime_thread_id IS NULL OR length(runtime_thread_id) BETWEEN 1 AND 256),
  runtime_turn_id          text        CHECK (runtime_turn_id IS NULL OR length(runtime_turn_id) BETWEEN 1 AND 256),
  result_message_id        uuid,
  result_digest            text        CHECK (result_digest IS NULL OR result_digest ~ '^hmac-sha256:[a-f0-9]{64}$'),
  error_code               text,
  uncertainty_reason       text,
  retry_of_invocation_id   uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  started_at               timestamptz,
  terminal_at              timestamptz,
  CONSTRAINT fk_agent_invocations_conversation_tenant
    FOREIGN KEY (conversation_id, creator_id, consumer_subject_id)
    REFERENCES agent_conversations (id, creator_id, consumer_subject_id),
  CONSTRAINT fk_agent_invocations_conversation_version
    FOREIGN KEY (conversation_id, agent_version_id, creator_id, consumer_subject_id)
    REFERENCES agent_conversations (id, agent_version_id, creator_id, consumer_subject_id),
  CONSTRAINT fk_agent_invocations_version_creator
    FOREIGN KEY (agent_version_id, creator_id)
    REFERENCES agent_versions (id, creator_id),
  CONSTRAINT fk_agent_invocations_user_message
    FOREIGN KEY (user_message_id, conversation_id, creator_id, consumer_subject_id)
    REFERENCES agent_messages (id, conversation_id, creator_id, consumer_subject_id),
  CONSTRAINT fk_agent_invocations_lease_binding
    FOREIGN KEY (assignment_lease_id, creator_id, assigned_worker_id, assignment_fence)
    REFERENCES worker_leases (id, creator_id, worker_id, fence),
  CONSTRAINT fk_agent_invocations_retry_tenant
    FOREIGN KEY (retry_of_invocation_id, creator_id, consumer_subject_id)
    REFERENCES agent_invocations (id, creator_id, consumer_subject_id),
  CONSTRAINT uq_agent_invocations_conversation_client UNIQUE (conversation_id, client_message_id),
  CONSTRAINT uq_agent_invocations_user_message UNIQUE (user_message_id),
  CONSTRAINT uq_agent_invocations_id_creator_consumer UNIQUE (id, creator_id, consumer_subject_id),
  CONSTRAINT uq_agent_invocations_id_conversation_tenant
    UNIQUE (id, conversation_id, creator_id, consumer_subject_id),
  CONSTRAINT uq_agent_invocations_id_conversation_consumer
    UNIQUE (id, conversation_id, consumer_subject_id),
  CONSTRAINT ck_agent_invocations_assignment CHECK (
    (assigned_worker_id IS NULL AND assignment_lease_id IS NULL AND assignment_fence IS NULL)
    OR (assigned_worker_id IS NOT NULL AND assignment_lease_id IS NOT NULL AND assignment_fence IS NOT NULL)
  ),
  CONSTRAINT ck_agent_invocations_terminal CHECK (
    (state IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN', 'EXPIRED') AND terminal_at IS NOT NULL)
    OR (state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN', 'EXPIRED') AND terminal_at IS NULL)
  ),
  CONSTRAINT ck_agent_invocations_success CHECK (
    (
      state = 'SUCCEEDED'
      AND result_message_id IS NOT NULL
      AND result_digest IS NOT NULL
      AND error_code IS NULL
      AND uncertainty_reason IS NULL
    )
    OR (
      state <> 'SUCCEEDED'
      AND result_message_id IS NULL
      AND result_digest IS NULL
    )
  ),
  CONSTRAINT ck_agent_invocations_failure CHECK (
    state <> 'FAILED' OR error_code IS NOT NULL
  ),
  CONSTRAINT ck_agent_invocations_uncertain CHECK (
    state <> 'UNCERTAIN' OR uncertainty_reason IS NOT NULL
  )
);

CREATE OR REPLACE FUNCTION enforce_creator_agent_invocation_transition()
RETURNS trigger AS $$
DECLARE
  transition_allowed boolean;
BEGIN
  IF OLD.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN', 'EXPIRED') THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'terminal invocation is immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.state <> OLD.state THEN
    transition_allowed := CASE OLD.state
      WHEN 'ACCEPTED' THEN NEW.state IN ('QUEUED', 'CANCELLED')
      WHEN 'QUEUED' THEN NEW.state IN ('DISPATCH_PENDING', 'CANCELLED', 'EXPIRED')
      WHEN 'DISPATCH_PENDING' THEN NEW.state IN ('PERSISTED', 'QUEUED')
      WHEN 'PERSISTED' THEN NEW.state IN ('STARTING', 'CANCEL_REQUESTED', 'RECONCILING')
      WHEN 'STARTING' THEN NEW.state IN ('RUNNING', 'RECONCILING')
      WHEN 'RUNNING' THEN NEW.state IN (
        'SUCCEEDED', 'FAILED', 'CANCEL_REQUESTED', 'RECONCILING'
      )
      WHEN 'CANCEL_REQUESTED' THEN NEW.state IN (
        'CANCELLED', 'SUCCEEDED', 'FAILED', 'RECONCILING'
      )
      WHEN 'RECONCILING' THEN NEW.state IN (
        'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN'
      )
      ELSE false
    END;
    IF NOT transition_allowed THEN
      RAISE EXCEPTION 'invalid invocation transition % -> %', OLD.state, NEW.state
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD.assigned_worker_id IS NOT NULL AND (
    NEW.assigned_worker_id IS DISTINCT FROM OLD.assigned_worker_id
    OR NEW.assignment_lease_id IS DISTINCT FROM OLD.assignment_lease_id
    OR NEW.assignment_fence IS DISTINCT FROM OLD.assignment_fence
  ) THEN
    RAISE EXCEPTION 'invocation assignment binding is immutable once set'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.execution_capability_id IS NOT NULL
     AND NEW.execution_capability_id IS DISTINCT FROM OLD.execution_capability_id THEN
    RAISE EXCEPTION 'invocation execution capability binding is immutable once set'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.runtime_thread_id IS NOT NULL
     AND NEW.runtime_thread_id IS DISTINCT FROM OLD.runtime_thread_id THEN
    RAISE EXCEPTION 'invocation runtime thread binding is immutable once set'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.runtime_turn_id IS NOT NULL
     AND NEW.runtime_turn_id IS DISTINCT FROM OLD.runtime_turn_id THEN
    RAISE EXCEPTION 'invocation runtime turn binding is immutable once set'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.state = 'CANCEL_REQUESTED' AND NEW.cancel_requested_at IS NULL THEN
    RAISE EXCEPTION 'cancel request requires a durable timestamp'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'EXPIRED' AND OLD.state = 'QUEUED' AND OLD.deadline_at > now() THEN
    RAISE EXCEPTION 'queued invocation cannot expire before its Cloud deadline'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION enforce_creator_agent_invocation_transition() FROM PUBLIC;

CREATE TRIGGER agent_invocations_transition
BEFORE UPDATE ON agent_invocations
FOR EACH ROW EXECUTE FUNCTION enforce_creator_agent_invocation_transition();

CREATE UNIQUE INDEX uq_agent_invocations_conversation_wip
  ON agent_invocations (conversation_id)
  WHERE state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN', 'EXPIRED');
CREATE UNIQUE INDEX uq_agent_invocations_execution_capability
  ON agent_invocations (execution_capability_id)
  WHERE execution_capability_id IS NOT NULL;

ALTER TABLE agent_messages
  ADD CONSTRAINT fk_agent_messages_invocation_tenant
  FOREIGN KEY (invocation_id, conversation_id, creator_id, consumer_subject_id)
  REFERENCES agent_invocations (id, conversation_id, creator_id, consumer_subject_id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE agent_invocations
  ADD CONSTRAINT fk_agent_invocations_result_message
  FOREIGN KEY (result_message_id, conversation_id, creator_id, consumer_subject_id)
  REFERENCES agent_messages (id, conversation_id, creator_id, consumer_subject_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION creator_agent_event_payload_is_allowed(
  input_event_type text,
  input_payload jsonb
)
RETURNS boolean AS $$
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
      input_payload = '{"state":"RUNNING"}'::jsonb
    WHEN 'invocation.cancel_requested' THEN
      input_payload = '{"state":"CANCEL_REQUESTED"}'::jsonb
    WHEN 'invocation.cancelled' THEN
      input_payload = '{"state":"CANCELLED"}'::jsonb
    WHEN 'invocation.succeeded' THEN
      (SELECT count(*) FROM jsonb_object_keys(input_payload)) = 3
      AND input_payload->>'state' = 'SUCCEEDED'
      AND input_payload->>'messageId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND input_payload->>'resultDigest' ~ '^hmac-sha256:[a-f0-9]{64}$'
    WHEN 'invocation.failed' THEN
      (SELECT count(*) FROM jsonb_object_keys(input_payload)) = 2
      AND input_payload->>'state' = 'FAILED'
      AND input_payload->>'errorCode' ~ '^[A-Z][A-Z0-9_]{1,127}$'
    WHEN 'invocation.uncertain' THEN
      (SELECT count(*) FROM jsonb_object_keys(input_payload)) = 2
      AND input_payload->>'state' = 'UNCERTAIN'
      AND input_payload->>'errorCode' ~ '^[A-Z][A-Z0-9_]{1,127}$'
    ELSE false
  END;
$$ LANGUAGE sql IMMUTABLE STRICT;

REVOKE ALL ON FUNCTION creator_agent_event_payload_is_allowed(text, jsonb) FROM PUBLIC;

CREATE TABLE agent_invocation_events (
  id                   bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invocation_id        uuid        NOT NULL,
  creator_id           uuid        NOT NULL,
  consumer_subject_id  uuid        NOT NULL,
  journal_seq          bigint      NOT NULL CHECK (journal_seq >= 1),
  source               text        NOT NULL
                       CONSTRAINT ck_agent_invocation_events_source CHECK (
                         source IN ('API', 'BROKER', 'WORKER', 'RUNTIME', 'RECONCILER')
                       ),
  source_event_id      text        NOT NULL CHECK (length(source_event_id) BETWEEN 1 AND 256),
  event_type           text        NOT NULL
                       CONSTRAINT ck_agent_invocation_events_type CHECK (
                         event_type IN (
                           'invocation.accepted', 'invocation.queued', 'invocation.leased',
                           'invocation.persisted', 'invocation.started',
                           'invocation.cancel_requested', 'invocation.succeeded',
                           'invocation.failed', 'invocation.cancelled', 'invocation.uncertain'
                         )
                       ),
  payload              jsonb       NOT NULL DEFAULT '{}'::jsonb
                       CHECK (jsonb_typeof(payload) = 'object')
                       CHECK (octet_length(payload::text) <= 16384)
                       CHECK (creator_agent_event_payload_is_allowed(event_type, payload)),
  occurred_at          timestamptz NOT NULL,
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_agent_invocation_events_invocation_tenant
    FOREIGN KEY (invocation_id, creator_id, consumer_subject_id)
    REFERENCES agent_invocations (id, creator_id, consumer_subject_id),
  CONSTRAINT uq_agent_invocation_events_invocation_seq UNIQUE (invocation_id, journal_seq),
  CONSTRAINT uq_agent_invocation_events_source_id UNIQUE (source, source_event_id),
  CONSTRAINT uq_agent_invocation_events_terminal_binding
    UNIQUE (id, invocation_id, source_event_id, event_type)
);

CREATE OR REPLACE FUNCTION enforce_creator_agent_event_sequence()
RETURNS trigger AS $$
DECLARE
  expected_seq bigint;
  invocation_state text;
BEGIN
  SELECT state
    INTO invocation_state
    FROM agent_invocations
   WHERE id = NEW.invocation_id
     AND creator_id = NEW.creator_id
     AND consumer_subject_id = NEW.consumer_subject_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invocation tenant binding missing for event'
      USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM agent_invocation_events
     WHERE invocation_id = NEW.invocation_id
       AND event_type IN (
         'invocation.succeeded', 'invocation.failed', 'invocation.cancelled',
         'invocation.uncertain', 'invocation.expired'
       )
  ) THEN
    RAISE EXCEPTION 'invocation journal is terminal'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.payload->>'state' IS DISTINCT FROM invocation_state THEN
    RAISE EXCEPTION 'event state % does not match invocation projection %',
      NEW.payload->>'state', invocation_state
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(max(journal_seq), 0) + 1
    INTO expected_seq
    FROM agent_invocation_events
   WHERE invocation_id = NEW.invocation_id;
  IF NEW.journal_seq <> expected_seq THEN
    RAISE EXCEPTION 'invocation journal sequence must be %', expected_seq
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION enforce_creator_agent_event_sequence() FROM PUBLIC;

CREATE TRIGGER agent_invocation_events_sequence
BEFORE INSERT ON agent_invocation_events
FOR EACH ROW EXECUTE FUNCTION enforce_creator_agent_event_sequence();

CREATE TRIGGER agent_invocation_events_immutable
BEFORE UPDATE OR DELETE ON agent_invocation_events
FOR EACH ROW EXECUTE FUNCTION reject_creator_agent_immutable_mutation();

CREATE TABLE broker_outbox (
  command_id          uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  creator_id          uuid        NOT NULL REFERENCES users(id),
  target_worker_id    uuid        NOT NULL,
  invocation_id       uuid,
  consumer_subject_id uuid,
  command_type        text        NOT NULL
                      CONSTRAINT ck_broker_outbox_command_type CHECK (
                        command_type IN (
                          'invocation.prepare', 'invocation.start', 'invocation.cancel',
                          'deployment.prepare', 'deployment.drain', 'lease.revoke'
                        )
                      ),
  dedupe_key          text        NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 256),
  state               text        NOT NULL DEFAULT 'PENDING'
                      CONSTRAINT ck_broker_outbox_state CHECK (
                        state IN ('PENDING', 'SENT', 'ACKED', 'EXPIRED')
                      ),
  attempt_count       integer     NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 100),
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  acked_at            timestamptz,
  CONSTRAINT fk_broker_outbox_worker_creator
    FOREIGN KEY (target_worker_id, creator_id)
    REFERENCES worker_installations (id, creator_id),
  CONSTRAINT fk_broker_outbox_invocation_tenant
    FOREIGN KEY (invocation_id, creator_id, consumer_subject_id)
    REFERENCES agent_invocations (id, creator_id, consumer_subject_id),
  CONSTRAINT ck_broker_outbox_invocation_tenant CHECK (
    (invocation_id IS NULL AND consumer_subject_id IS NULL)
    OR (invocation_id IS NOT NULL AND consumer_subject_id IS NOT NULL)
  ),
  CONSTRAINT uq_broker_outbox_dedupe UNIQUE (dedupe_key),
  CONSTRAINT ck_broker_outbox_times CHECK (expires_at > created_at),
  CONSTRAINT ck_broker_outbox_ack CHECK (
    (state = 'ACKED' AND acked_at IS NOT NULL)
    OR (state <> 'ACKED' AND acked_at IS NULL)
  )
);

CREATE INDEX idx_broker_outbox_dispatch
  ON broker_outbox (target_worker_id, next_attempt_at, command_id)
  WHERE state IN ('PENDING', 'SENT');

CREATE OR REPLACE FUNCTION enforce_creator_agent_broker_outbox_transition()
RETURNS trigger AS $$
DECLARE
  transition_allowed boolean;
BEGIN
  IF NEW.command_id IS DISTINCT FROM OLD.command_id
     OR NEW.creator_id IS DISTINCT FROM OLD.creator_id
     OR NEW.target_worker_id IS DISTINCT FROM OLD.target_worker_id
     OR NEW.invocation_id IS DISTINCT FROM OLD.invocation_id
     OR NEW.consumer_subject_id IS DISTINCT FROM OLD.consumer_subject_id
     OR NEW.command_type IS DISTINCT FROM OLD.command_type
     OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'broker outbox command binding is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state IN ('ACKED', 'EXPIRED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal broker outbox command is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION 'broker outbox attempt count is monotonic'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state <> OLD.state THEN
    transition_allowed := CASE OLD.state
      WHEN 'PENDING' THEN NEW.state IN ('SENT', 'ACKED', 'EXPIRED')
      WHEN 'SENT' THEN NEW.state IN ('ACKED', 'EXPIRED')
      ELSE false
    END;
    IF NOT transition_allowed THEN
      RAISE EXCEPTION 'invalid broker outbox transition % -> %', OLD.state, NEW.state
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION enforce_creator_agent_broker_outbox_transition() FROM PUBLIC;

CREATE TRIGGER broker_outbox_transition
BEFORE UPDATE ON broker_outbox
FOR EACH ROW EXECUTE FUNCTION enforce_creator_agent_broker_outbox_transition();

-- Durable Consumer replay is separate from Broker command delivery. Redis/SSE only
-- project these rows after commit; cursor and dedupe survive reconnects and restarts.
ALTER TABLE agent_conversations
  ADD CONSTRAINT uq_agent_conversations_id_consumer
  UNIQUE (id, consumer_subject_id);

CREATE TABLE consumer_event_streams (
  owner_id               uuid        NOT NULL REFERENCES users(id),
  conversation_id        uuid        NOT NULL,
  latest_cursor          bigint      NOT NULL DEFAULT 0 CHECK (latest_cursor >= 0),
  expired_through_cursor bigint      NOT NULL DEFAULT 0 CHECK (expired_through_cursor >= 0),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, conversation_id),
  CONSTRAINT fk_consumer_event_streams_conversation_owner
    FOREIGN KEY (conversation_id, owner_id)
    REFERENCES agent_conversations (id, consumer_subject_id),
  CONSTRAINT ck_consumer_event_streams_cursor_order CHECK (
    expired_through_cursor <= latest_cursor
  )
);

CREATE TABLE consumer_event_outbox (
  cursor           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id         uuid        NOT NULL REFERENCES users(id),
  conversation_id  uuid        NOT NULL,
  invocation_id    uuid        NOT NULL,
  source_event_id  text        NOT NULL CHECK (length(source_event_id) BETWEEN 1 AND 256),
  event_type       text        NOT NULL
                   CONSTRAINT ck_consumer_event_outbox_type CHECK (
                     event_type IN (
                       'invocation.succeeded', 'invocation.failed',
                       'invocation.cancelled', 'invocation.uncertain'
                     )
                   ),
  payload          jsonb       NOT NULL
                   CHECK (jsonb_typeof(payload) = 'object')
                   CHECK (octet_length(payload::text) <= 16384)
                   CHECK (creator_agent_event_payload_is_allowed(event_type, payload)),
  payload_digest   text        NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  dedupe_key       text        NOT NULL CHECK (dedupe_key ~ '^[a-f0-9]{64}$'),
  terminal_event_id bigint     NOT NULL,
  state            text        NOT NULL DEFAULT 'PENDING'
                   CONSTRAINT ck_consumer_event_outbox_state CHECK (
                     state IN ('PENDING', 'PUBLISHED')
                   ),
  attempt_count    integer     NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 100),
  next_attempt_at  timestamptz DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  published_at     timestamptz,
  retained_until   timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  CONSTRAINT fk_consumer_event_outbox_conversation_owner
    FOREIGN KEY (conversation_id, owner_id)
    REFERENCES agent_conversations (id, consumer_subject_id),
  CONSTRAINT fk_consumer_event_outbox_invocation_owner
    FOREIGN KEY (invocation_id, conversation_id, owner_id)
    REFERENCES agent_invocations (id, conversation_id, consumer_subject_id),
  CONSTRAINT fk_consumer_event_outbox_terminal_event
    FOREIGN KEY (terminal_event_id, invocation_id, source_event_id, event_type)
    REFERENCES agent_invocation_events (id, invocation_id, source_event_id, event_type),
  CONSTRAINT uq_consumer_event_outbox_owner_source UNIQUE (owner_id, source_event_id),
  CONSTRAINT uq_consumer_event_outbox_owner_dedupe UNIQUE (owner_id, dedupe_key),
  CONSTRAINT uq_consumer_event_outbox_invocation_type UNIQUE (invocation_id, event_type),
  CONSTRAINT ck_consumer_event_outbox_publish CHECK (
    (state = 'PUBLISHED' AND published_at IS NOT NULL AND next_attempt_at IS NULL)
    OR (state = 'PENDING' AND published_at IS NULL AND next_attempt_at IS NOT NULL)
  ),
  CONSTRAINT ck_consumer_event_outbox_retention CHECK (
    retained_until = created_at + interval '7 days'
  )
);

CREATE INDEX idx_consumer_event_outbox_publish
  ON consumer_event_outbox (next_attempt_at, cursor)
  WHERE state = 'PENDING';
CREATE INDEX idx_consumer_event_outbox_replay
  ON consumer_event_outbox (owner_id, conversation_id, cursor);

CREATE OR REPLACE FUNCTION enforce_creator_agent_consumer_stream_transition()
RETURNS trigger AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id THEN
    RAISE EXCEPTION 'consumer event stream identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.latest_cursor < OLD.latest_cursor
     OR NEW.expired_through_cursor < OLD.expired_through_cursor
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'consumer event stream cursors are monotonic'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION enforce_creator_agent_consumer_stream_transition() FROM PUBLIC;

CREATE TRIGGER consumer_event_streams_transition
BEFORE UPDATE ON consumer_event_streams
FOR EACH ROW EXECUTE FUNCTION enforce_creator_agent_consumer_stream_transition();

CREATE OR REPLACE FUNCTION enforce_creator_agent_consumer_outbox_transition()
RETURNS trigger AS $$
BEGIN
  IF NEW.cursor IS DISTINCT FROM OLD.cursor
     OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.invocation_id IS DISTINCT FROM OLD.invocation_id
     OR NEW.source_event_id IS DISTINCT FROM OLD.source_event_id
     OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.payload_digest IS DISTINCT FROM OLD.payload_digest
     OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
     OR NEW.terminal_event_id IS DISTINCT FROM OLD.terminal_event_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.retained_until IS DISTINCT FROM OLD.retained_until THEN
    RAISE EXCEPTION 'consumer event outbox binding is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'PUBLISHED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'published consumer event is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION 'consumer event attempt count is monotonic'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state <> OLD.state AND NOT (OLD.state = 'PENDING' AND NEW.state = 'PUBLISHED') THEN
    RAISE EXCEPTION 'invalid consumer event outbox transition % -> %', OLD.state, NEW.state
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION enforce_creator_agent_consumer_outbox_transition() FROM PUBLIC;

CREATE TRIGGER consumer_event_outbox_transition
BEFORE UPDATE ON consumer_event_outbox
FOR EACH ROW EXECUTE FUNCTION enforce_creator_agent_consumer_outbox_transition();

-- ===================== forced tenant isolation =====================

ALTER TABLE snapshot_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE snapshot_uploads FORCE ROW LEVEL SECURITY;
ALTER TABLE context_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_version_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_version_controls FORCE ROW LEVEL SECURITY;
ALTER TABLE deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployments FORCE ROW LEVEL SECURITY;
ALTER TABLE worker_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_installations FORCE ROW LEVEL SECURITY;
ALTER TABLE worker_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_leases FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_invocations FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_invocation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_invocation_events FORCE ROW LEVEL SECURITY;
ALTER TABLE broker_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE broker_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE consumer_event_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumer_event_streams FORCE ROW LEVEL SECURITY;
ALTER TABLE consumer_event_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumer_event_outbox FORCE ROW LEVEL SECURITY;

-- Creator-owned control-plane rows only accept a transaction-scoped creator context.
CREATE POLICY snapshot_uploads_tenant ON snapshot_uploads
  USING (creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid)
  WITH CHECK (creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid);
CREATE POLICY context_snapshots_tenant ON context_snapshots
  USING (creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid)
  WITH CHECK (creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid);
CREATE POLICY agents_tenant ON agents
  USING (creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid)
  WITH CHECK (creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid);
CREATE POLICY agent_versions_tenant ON agent_versions
  USING (creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid)
  WITH CHECK (creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid);
CREATE POLICY agent_version_controls_tenant ON agent_version_controls
  USING (creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid)
  WITH CHECK (creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid);
CREATE POLICY deployments_tenant ON deployments
  USING (creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid)
  WITH CHECK (creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid);
CREATE POLICY worker_installations_tenant ON worker_installations
  USING (creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid)
  WITH CHECK (creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid);
CREATE POLICY worker_leases_tenant ON worker_leases
  USING (creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid)
  WITH CHECK (creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid);
CREATE POLICY broker_outbox_tenant ON broker_outbox
  USING (creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid)
  WITH CHECK (creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid);

CREATE POLICY consumer_event_streams_select ON consumer_event_streams
  FOR SELECT
  USING (
    owner_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM agent_conversations AS conversation
       WHERE conversation.id = conversation_id
         AND conversation.creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
         AND conversation.consumer_subject_id = owner_id
    )
  );
CREATE POLICY consumer_event_streams_insert ON consumer_event_streams
  FOR INSERT
  WITH CHECK (
    owner_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM agent_conversations AS conversation
       WHERE conversation.id = conversation_id
         AND conversation.creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
         AND conversation.consumer_subject_id = owner_id
    )
  );
CREATE POLICY consumer_event_streams_update ON consumer_event_streams
  FOR UPDATE
  USING (
    current_user IN ('combo_agent_broker', 'combo_agent_reconciler')
    AND owner_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
  )
  WITH CHECK (
    current_user IN ('combo_agent_broker', 'combo_agent_reconciler')
    AND owner_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
  );

CREATE POLICY consumer_event_outbox_select ON consumer_event_outbox
  FOR SELECT
  USING (
    owner_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM agent_conversations AS conversation
       WHERE conversation.id = conversation_id
         AND conversation.creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
         AND conversation.consumer_subject_id = owner_id
    )
  );
CREATE POLICY consumer_event_outbox_insert ON consumer_event_outbox
  FOR INSERT
  WITH CHECK (
    owner_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM agent_conversations AS conversation
       WHERE conversation.id = conversation_id
         AND conversation.creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
         AND conversation.consumer_subject_id = owner_id
    )
  );
CREATE POLICY consumer_event_outbox_update ON consumer_event_outbox
  FOR UPDATE
  USING (
    current_user IN ('combo_agent_broker', 'combo_agent_reconciler')
    AND owner_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM agent_conversations AS conversation
       WHERE conversation.id = conversation_id
         AND conversation.creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
         AND conversation.consumer_subject_id = owner_id
    )
  )
  WITH CHECK (
    current_user IN ('combo_agent_broker', 'combo_agent_reconciler')
    AND owner_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM agent_conversations AS conversation
       WHERE conversation.id = conversation_id
         AND conversation.creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
         AND conversation.consumer_subject_id = owner_id
    )
  );
CREATE POLICY consumer_event_outbox_delete ON consumer_event_outbox
  FOR DELETE
  USING (
    current_user = 'combo_agent_reconciler'
    AND owner_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM agent_conversations AS conversation
       WHERE conversation.id = conversation_id
         AND conversation.creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
         AND conversation.consumer_subject_id = owner_id
    )
  );

-- Conversation reads allow the exact Creator or Consumer. Every write requires both
-- transaction-local identities, so a leaked single-tenant context cannot mutate the other side.
CREATE POLICY agent_conversations_select ON agent_conversations
  FOR SELECT
  USING (
    creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
    AND (
      NULLIF(current_setting('app.consumer_id', true), '') IS NULL
      OR consumer_subject_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
    )
  );
CREATE POLICY agent_conversations_insert ON agent_conversations
  FOR INSERT
  WITH CHECK (
    creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
    AND consumer_subject_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
  );
CREATE POLICY agent_conversations_update ON agent_conversations
  FOR UPDATE
  USING (
    creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
    AND consumer_subject_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
  )
  WITH CHECK (
    creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
    AND consumer_subject_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
  );

CREATE POLICY agent_messages_select ON agent_messages
  FOR SELECT
  USING (
    creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
    AND (
      NULLIF(current_setting('app.consumer_id', true), '') IS NULL
      OR consumer_subject_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
    )
  );
CREATE POLICY agent_messages_insert ON agent_messages
  FOR INSERT
  WITH CHECK (
    creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
    AND consumer_subject_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
  );
CREATE POLICY agent_invocations_select ON agent_invocations
  FOR SELECT
  USING (
    creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
    AND (
      NULLIF(current_setting('app.consumer_id', true), '') IS NULL
      OR consumer_subject_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
    )
  );
CREATE POLICY agent_invocations_insert ON agent_invocations
  FOR INSERT
  WITH CHECK (
    creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
    AND consumer_subject_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
  );
CREATE POLICY agent_invocations_update ON agent_invocations
  FOR UPDATE
  USING (
    creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
    AND consumer_subject_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
  )
  WITH CHECK (
    creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
    AND consumer_subject_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
  );

CREATE POLICY agent_invocation_events_select ON agent_invocation_events
  FOR SELECT
  USING (
    creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
    AND (
      NULLIF(current_setting('app.consumer_id', true), '') IS NULL
      OR consumer_subject_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
    )
  );
CREATE POLICY agent_invocation_events_insert ON agent_invocation_events
  FOR INSERT
  WITH CHECK (
    creator_id = NULLIF(current_setting('app.creator_id', true), '')::uuid
    AND consumer_subject_id = NULLIF(current_setting('app.consumer_id', true), '')::uuid
  );

-- ===================== least-privilege grants =====================

REVOKE ALL PRIVILEGES ON
  snapshot_uploads,
  context_snapshots,
  agents,
  agent_versions,
  agent_version_controls,
  deployments,
  worker_installations,
  worker_leases,
  agent_conversations,
  agent_messages,
  agent_invocations,
  agent_invocation_events,
  broker_outbox,
  consumer_event_streams,
  consumer_event_outbox
FROM PUBLIC, combo_api, combo_worker, combo_runtime,
  combo_agent_api, combo_agent_broker, combo_agent_reconciler, combo_agent_maintenance;

GRANT SELECT, INSERT ON
  snapshot_uploads,
  agents,
  agent_version_controls,
  deployments,
  agent_conversations,
  agent_invocations,
  broker_outbox
TO combo_agent_api;
GRANT SELECT ON consumer_event_streams, consumer_event_outbox TO combo_agent_api;
GRANT UPDATE (state, error_code, verified_at) ON snapshot_uploads TO combo_agent_api;
GRANT UPDATE (name, description, lifecycle, updated_at) ON agents TO combo_agent_api;
GRANT UPDATE (availability, severity, reason_code, updated_at)
  ON agent_version_controls TO combo_agent_api;
GRANT UPDATE (desired_state, desired_version_id, generation, updated_at)
  ON deployments TO combo_agent_api;
GRANT UPDATE (state, next_turn_no, last_activity_at, closed_at)
  ON agent_conversations TO combo_agent_api;
GRANT UPDATE (state, cancel_requested_at, terminal_at, error_code)
  ON agent_invocations TO combo_agent_api;
GRANT SELECT, INSERT ON
  context_snapshots,
  agent_versions,
  agent_messages,
  agent_invocation_events
TO combo_agent_api;
GRANT SELECT ON worker_installations, worker_leases TO combo_agent_api;

GRANT SELECT, INSERT ON
  worker_installations,
  worker_leases,
  broker_outbox
TO combo_agent_broker;
GRANT SELECT ON deployments, agent_conversations, agent_invocations
TO combo_agent_broker;
GRANT UPDATE (worker_version, protocol_versions, capabilities, last_seen_at, revoked_at)
  ON worker_installations TO combo_agent_broker;
GRANT UPDATE (state, renewed_at, expires_at) ON worker_leases TO combo_agent_broker;
GRANT UPDATE (
  serving_version_id, observed_state, lease_fence, observed_worker_id,
  observed_generation, last_error_code, updated_at
) ON deployments TO combo_agent_broker;
GRANT UPDATE (state, assigned_worker_id, last_activity_at, closed_at)
  ON agent_conversations TO combo_agent_broker;
GRANT UPDATE (
  state, assigned_worker_id, assignment_lease_id, assignment_fence,
  execution_capability_id, cancel_requested_at, runtime_thread_id, runtime_turn_id,
  result_message_id, result_digest, error_code, uncertainty_reason, started_at, terminal_at
) ON agent_invocations TO combo_agent_broker;
GRANT UPDATE (state, attempt_count, next_attempt_at, acked_at)
  ON broker_outbox TO combo_agent_broker;
GRANT SELECT, INSERT ON agent_messages, agent_invocation_events TO combo_agent_broker;
GRANT SELECT, INSERT ON consumer_event_streams, consumer_event_outbox TO combo_agent_broker;
GRANT UPDATE (latest_cursor, expired_through_cursor, updated_at)
  ON consumer_event_streams TO combo_agent_broker;
GRANT UPDATE (state, attempt_count, next_attempt_at, published_at)
  ON consumer_event_outbox TO combo_agent_broker;
GRANT SELECT ON agents, agent_versions, agent_version_controls, context_snapshots
TO combo_agent_broker;

GRANT SELECT ON
  worker_leases,
  deployments,
  agent_conversations,
  agent_invocations,
  broker_outbox,
  consumer_event_streams,
  consumer_event_outbox
TO combo_agent_reconciler;
GRANT UPDATE (state, renewed_at, expires_at) ON worker_leases TO combo_agent_reconciler;
GRANT UPDATE (
  serving_version_id, observed_state, lease_fence, observed_worker_id,
  observed_generation, last_error_code, updated_at
) ON deployments TO combo_agent_reconciler;
GRANT UPDATE (state, assigned_worker_id, last_activity_at, closed_at)
  ON agent_conversations TO combo_agent_reconciler;
GRANT UPDATE (
  state, assigned_worker_id, assignment_lease_id, assignment_fence,
  execution_capability_id, cancel_requested_at, runtime_thread_id, runtime_turn_id,
  result_message_id, result_digest, error_code, uncertainty_reason, started_at, terminal_at
) ON agent_invocations TO combo_agent_reconciler;
GRANT UPDATE (state, attempt_count, next_attempt_at, acked_at)
  ON broker_outbox TO combo_agent_reconciler;
GRANT SELECT, INSERT ON agent_messages, agent_invocation_events TO combo_agent_reconciler;
GRANT SELECT, INSERT ON consumer_event_streams, consumer_event_outbox
  TO combo_agent_reconciler;
GRANT UPDATE (latest_cursor, expired_through_cursor, updated_at)
  ON consumer_event_streams TO combo_agent_reconciler;
GRANT UPDATE (state, attempt_count, next_attempt_at, published_at)
  ON consumer_event_outbox TO combo_agent_reconciler;
GRANT DELETE ON consumer_event_outbox TO combo_agent_reconciler;
GRANT SELECT ON agents, agent_versions, agent_version_controls, worker_installations
TO combo_agent_reconciler;

GRANT USAGE, SELECT ON SEQUENCE agent_invocation_events_id_seq TO
  combo_agent_api,
  combo_agent_broker,
  combo_agent_reconciler;
GRANT USAGE, SELECT ON SEQUENCE consumer_event_outbox_cursor_seq TO
  combo_agent_broker,
  combo_agent_reconciler;
GRANT EXECUTE ON FUNCTION gen_uuid_v7() TO
  combo_agent_api,
  combo_agent_broker,
  combo_agent_reconciler;
GRANT EXECUTE ON FUNCTION reject_creator_agent_immutable_mutation() TO
  combo_agent_api,
  combo_agent_broker,
  combo_agent_reconciler;
GRANT EXECUTE ON FUNCTION enforce_creator_agent_event_sequence() TO
  combo_agent_api,
  combo_agent_broker,
  combo_agent_reconciler;
GRANT EXECUTE ON FUNCTION enforce_creator_agent_invocation_transition() TO
  combo_agent_api,
  combo_agent_broker,
  combo_agent_reconciler;
GRANT EXECUTE ON FUNCTION creator_agent_event_payload_is_allowed(text, jsonb) TO
  combo_agent_api,
  combo_agent_broker,
  combo_agent_reconciler;
