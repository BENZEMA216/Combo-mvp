-- 0012 · Agent Builder V1 聚合层。
--
-- Agent Project 只保存可变的创作 Head 与当前 Release 指针。Revision、Release 不可变；
-- Test 先以可过期租约占用请求键，再从 running 单向进入终态。Session 显式钉住
-- Revision/Release，旧会话不随 Head 漂移。

CREATE TABLE agent_projects (
  id                  uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  owner_user_id       uuid        NOT NULL REFERENCES users(id),
  name                text        NOT NULL,
  summary             text        NOT NULL DEFAULT '',
  source_task_id      uuid        REFERENCES tasks(id),
  status              text        NOT NULL DEFAULT 'active'
                      CONSTRAINT ck_agent_projects_status CHECK (status IN ('active', 'archived')),
  head_revision_id    uuid,
  current_release_id  uuid,
  idempotency_key     text        NOT NULL,
  idempotency_sha256  char(64)    NOT NULL
                      CONSTRAINT ck_agent_project_idempotency_sha CHECK (idempotency_sha256 ~ '^[a-f0-9]{64}$'),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_agent_projects_owner_idempotency UNIQUE (owner_user_id, idempotency_key),
  CONSTRAINT uq_agent_projects_id_owner UNIQUE (id, owner_user_id)
);
CREATE INDEX idx_agent_projects_owner_updated
  ON agent_projects (owner_user_id, updated_at DESC, id DESC)
  WHERE status = 'active';

CREATE TABLE agent_revisions (
  id                         uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  project_id                 uuid        NOT NULL REFERENCES agent_projects(id),
  revision_number            bigint      NOT NULL CHECK (revision_number > 0),
  parent_revision_id         uuid,
  entry_capability_id        uuid        NOT NULL REFERENCES capabilities(id),
  definition_storage_key     text        NOT NULL,
  definition_sha256          char(64)    NOT NULL
                             CONSTRAINT ck_agent_revision_definition_sha CHECK (definition_sha256 ~ '^[a-f0-9]{64}$'),
  runtime_bundle_storage_key text        NOT NULL,
  runtime_bundle_sha256      char(64)    NOT NULL
                             CONSTRAINT ck_agent_revision_bundle_sha CHECK (runtime_bundle_sha256 ~ '^[a-f0-9]{64}$'),
  ui_artifact_id             uuid        NOT NULL REFERENCES artifacts(id),
  ui_storage_key             text        NOT NULL,
  ui_sha256                  char(64)    NOT NULL
                             CONSTRAINT ck_agent_revision_ui_sha CHECK (ui_sha256 ~ '^[a-f0-9]{64}$'),
  compiler_version           text        NOT NULL,
  change_summary             text        NOT NULL DEFAULT '',
  mutation_id                text        NOT NULL,
  mutation_sha256            char(64)    NOT NULL
                             CONSTRAINT ck_agent_revision_mutation_sha CHECK (mutation_sha256 ~ '^[a-f0-9]{64}$'),
  created_by_user_id         uuid        NOT NULL REFERENCES users(id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_agent_revisions_project_number UNIQUE (project_id, revision_number),
  CONSTRAINT uq_agent_revisions_project_mutation UNIQUE (project_id, mutation_id),
  CONSTRAINT uq_agent_revisions_project_id UNIQUE (project_id, id),
  CONSTRAINT uq_agent_revisions_project_hashes
    UNIQUE (project_id, id, runtime_bundle_sha256, ui_sha256),
  CONSTRAINT uq_agent_revisions_id_capability UNIQUE (id, entry_capability_id),
  CONSTRAINT fk_agent_revision_owner
    FOREIGN KEY (project_id, created_by_user_id)
    REFERENCES agent_projects (id, owner_user_id),
  CONSTRAINT fk_agent_revision_parent
    FOREIGN KEY (project_id, parent_revision_id)
    REFERENCES agent_revisions (project_id, id),
  CONSTRAINT ck_agent_revision_not_own_parent CHECK (parent_revision_id IS NULL OR parent_revision_id <> id)
);
CREATE INDEX idx_agent_revisions_project_created
  ON agent_revisions (project_id, revision_number DESC);

ALTER TABLE agent_projects
  ADD CONSTRAINT fk_agent_projects_head
  FOREIGN KEY (id, head_revision_id)
  REFERENCES agent_revisions (project_id, id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE sessions
  ADD COLUMN agent_project_id uuid,
  ADD COLUMN agent_revision_id uuid,
  ADD COLUMN agent_release_id uuid,
  ADD CONSTRAINT fk_sessions_agent_project_revision
    FOREIGN KEY (agent_project_id, agent_revision_id)
    REFERENCES agent_revisions (project_id, id),
  ADD CONSTRAINT fk_sessions_agent_revision_capability
    FOREIGN KEY (agent_revision_id, capability_id)
    REFERENCES agent_revisions (id, entry_capability_id),
  ADD CONSTRAINT ck_sessions_agent_project_revision_pair
    CHECK ((agent_project_id IS NULL) = (agent_revision_id IS NULL)),
  ADD CONSTRAINT ck_sessions_agent_release_requires_revision
    CHECK (agent_release_id IS NULL OR (agent_revision_id IS NOT NULL AND agent_project_id IS NOT NULL));
ALTER TABLE sessions
  ADD CONSTRAINT uq_sessions_id_agent_revision UNIQUE (id, agent_revision_id);
CREATE INDEX idx_sessions_agent_revision
  ON sessions (agent_revision_id, created_at DESC)
  WHERE agent_revision_id IS NOT NULL;
CREATE INDEX idx_sessions_agent_project
  ON sessions (agent_project_id, updated_at DESC)
  WHERE agent_project_id IS NOT NULL;

CREATE UNIQUE INDEX uq_artifacts_direct_agent_ui_request
  ON artifacts (session_id, (meta ->> 'idempotencyKey'))
  WHERE turn_id IS NULL
    AND kind = 'html'
    AND meta ->> 'authoringSurface' = 'codex'
    AND meta ? 'idempotencyKey';

CREATE TABLE agent_tests (
  id                    uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  project_id            uuid        NOT NULL REFERENCES agent_projects(id),
  agent_revision_id     uuid        NOT NULL,
  runtime_bundle_sha256 char(64)    NOT NULL
                        CONSTRAINT ck_agent_test_bundle_sha CHECK (runtime_bundle_sha256 ~ '^[a-f0-9]{64}$'),
  ui_sha256             char(64)    NOT NULL
                        CONSTRAINT ck_agent_test_ui_sha CHECK (ui_sha256 ~ '^[a-f0-9]{64}$'),
  output_contract       jsonb       NOT NULL
                        CONSTRAINT ck_agent_test_output_contract_object
                        CHECK (jsonb_typeof(output_contract) = 'object'),
  request_key           text        NOT NULL,
  request_sha256        char(64)    NOT NULL
                        CONSTRAINT ck_agent_test_request_sha CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  lease_token           uuid,
  lease_expires_at      timestamptz,
  session_id            uuid        REFERENCES sessions(id),
  turn_id               uuid,
  status                text        NOT NULL DEFAULT 'starting'
                        CONSTRAINT ck_agent_tests_status CHECK (status IN ('starting', 'running', 'passed', 'failed')),
  error_code            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  CONSTRAINT uq_agent_tests_identity
    UNIQUE (id, project_id, agent_revision_id, runtime_bundle_sha256, ui_sha256),
  CONSTRAINT uq_agent_tests_project_request UNIQUE (project_id, request_key),
  CONSTRAINT fk_agent_test_revision
    FOREIGN KEY (project_id, agent_revision_id, runtime_bundle_sha256, ui_sha256)
    REFERENCES agent_revisions (project_id, id, runtime_bundle_sha256, ui_sha256),
  CONSTRAINT fk_agent_test_turn
    FOREIGN KEY (turn_id, session_id)
    REFERENCES turns (id, session_id),
  CONSTRAINT fk_agent_test_session_revision
    FOREIGN KEY (session_id, agent_revision_id)
    REFERENCES sessions (id, agent_revision_id),
  CONSTRAINT ck_agent_test_terminal_shape CHECK (
    (status = 'starting' AND session_id IS NULL AND turn_id IS NULL
      AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
      AND completed_at IS NULL AND error_code IS NULL)
    OR (status = 'running' AND session_id IS NOT NULL AND turn_id IS NOT NULL
      AND lease_token IS NULL AND lease_expires_at IS NULL
      AND completed_at IS NULL AND error_code IS NULL)
    OR (status = 'passed' AND session_id IS NOT NULL AND turn_id IS NOT NULL
      AND lease_token IS NULL AND lease_expires_at IS NULL
      AND completed_at IS NOT NULL AND error_code IS NULL)
    OR (status = 'failed' AND session_id IS NOT NULL AND turn_id IS NOT NULL
      AND lease_token IS NULL AND lease_expires_at IS NULL
      AND completed_at IS NOT NULL)
  )
);
CREATE INDEX idx_agent_tests_revision_created
  ON agent_tests (agent_revision_id, created_at DESC);
CREATE INDEX idx_agent_tests_project_created
  ON agent_tests (project_id, created_at DESC, id DESC);

CREATE TABLE agent_releases (
  id                    uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  project_id            uuid        NOT NULL REFERENCES agent_projects(id),
  version_number        bigint      NOT NULL CHECK (version_number > 0),
  agent_revision_id     uuid        NOT NULL,
  qualifying_test_id    uuid        NOT NULL,
  runtime_bundle_sha256 char(64)    NOT NULL
                        CONSTRAINT ck_agent_release_bundle_sha CHECK (runtime_bundle_sha256 ~ '^[a-f0-9]{64}$'),
  ui_sha256             char(64)    NOT NULL
                        CONSTRAINT ck_agent_release_ui_sha CHECK (ui_sha256 ~ '^[a-f0-9]{64}$'),
  release_sha256        char(64)    NOT NULL
                        CONSTRAINT ck_agent_release_sha CHECK (release_sha256 ~ '^[a-f0-9]{64}$'),
  notes                 text        NOT NULL DEFAULT '',
  idempotency_key       text        NOT NULL,
  idempotency_sha256    char(64)    NOT NULL
                        CONSTRAINT ck_agent_release_idempotency_sha CHECK (idempotency_sha256 ~ '^[a-f0-9]{64}$'),
  created_by_user_id    uuid        NOT NULL REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_agent_releases_project_version UNIQUE (project_id, version_number),
  CONSTRAINT uq_agent_releases_project_idempotency UNIQUE (project_id, idempotency_key),
  CONSTRAINT uq_agent_releases_project_id UNIQUE (project_id, id),
  CONSTRAINT uq_agent_releases_id_revision UNIQUE (id, agent_revision_id),
  CONSTRAINT fk_agent_release_revision
    FOREIGN KEY (project_id, agent_revision_id, runtime_bundle_sha256, ui_sha256)
    REFERENCES agent_revisions (project_id, id, runtime_bundle_sha256, ui_sha256),
  CONSTRAINT fk_agent_release_test
    FOREIGN KEY (qualifying_test_id, project_id, agent_revision_id, runtime_bundle_sha256, ui_sha256)
    REFERENCES agent_tests (id, project_id, agent_revision_id, runtime_bundle_sha256, ui_sha256),
  CONSTRAINT fk_agent_release_owner
    FOREIGN KEY (project_id, created_by_user_id)
    REFERENCES agent_projects (id, owner_user_id)
);
CREATE INDEX idx_agent_releases_project_created
  ON agent_releases (project_id, version_number DESC);

ALTER TABLE agent_projects
  ADD CONSTRAINT fk_agent_projects_current_release
  FOREIGN KEY (id, current_release_id)
  REFERENCES agent_releases (project_id, id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE sessions
  ADD CONSTRAINT fk_sessions_agent_release_revision
  FOREIGN KEY (agent_release_id, agent_revision_id)
  REFERENCES agent_releases (id, agent_revision_id);

CREATE OR REPLACE FUNCTION protect_session_agent_pins() RETURNS trigger AS $$
BEGIN
  IF NEW.capability_id IS DISTINCT FROM OLD.capability_id
     OR NEW.agent_project_id IS DISTINCT FROM OLD.agent_project_id
     OR NEW.agent_revision_id IS DISTINCT FROM OLD.agent_revision_id
     OR NEW.agent_release_id IS DISTINCT FROM OLD.agent_release_id THEN
    RAISE EXCEPTION 'session runtime identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sessions_agent_pins_immutable
  BEFORE UPDATE OF capability_id, agent_project_id, agent_revision_id, agent_release_id ON sessions
  FOR EACH ROW EXECUTE FUNCTION protect_session_agent_pins();

CREATE OR REPLACE FUNCTION reject_agent_immutable_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agent_revisions_immutable
  BEFORE UPDATE OR DELETE ON agent_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_agent_immutable_mutation();

CREATE TRIGGER trg_agent_releases_immutable
  BEFORE UPDATE OR DELETE ON agent_releases
  FOR EACH ROW EXECUTE FUNCTION reject_agent_immutable_mutation();

CREATE OR REPLACE FUNCTION enforce_agent_test_transition() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'starting' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'agent_tests rows cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'starting' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.agent_revision_id IS DISTINCT FROM OLD.agent_revision_id
       OR NEW.runtime_bundle_sha256 IS DISTINCT FROM OLD.runtime_bundle_sha256
       OR NEW.ui_sha256 IS DISTINCT FROM OLD.ui_sha256
       OR NEW.output_contract IS DISTINCT FROM OLD.output_contract
       OR NEW.request_key IS DISTINCT FROM OLD.request_key
       OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'starting agent_tests identity is immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW.status = 'starting' THEN
      IF NEW.session_id IS NOT NULL OR NEW.turn_id IS NOT NULL
         OR NEW.completed_at IS NOT NULL OR NEW.error_code IS NOT NULL
         OR NEW.lease_token IS NULL OR NEW.lease_expires_at IS NULL THEN
        RAISE EXCEPTION 'starting agent_tests can only renew their lease' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.status <> 'running'
       OR NEW.session_id IS NULL
       OR NEW.turn_id IS NULL
       OR NEW.lease_token IS NOT NULL
       OR NEW.lease_expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'starting agent_tests can only bind one Session and Turn' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'running' THEN
    RAISE EXCEPTION 'terminal agent_tests rows are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.project_id <> OLD.project_id
     OR NEW.agent_revision_id <> OLD.agent_revision_id
     OR NEW.runtime_bundle_sha256 <> OLD.runtime_bundle_sha256
     OR NEW.ui_sha256 <> OLD.ui_sha256
     OR NEW.output_contract <> OLD.output_contract
     OR NEW.request_key <> OLD.request_key
     OR NEW.request_sha256 <> OLD.request_sha256
     OR NEW.lease_token IS DISTINCT FROM OLD.lease_token
     OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
     OR NEW.session_id <> OLD.session_id
     OR NEW.turn_id <> OLD.turn_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'agent_tests identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.status NOT IN ('passed', 'failed') THEN
    RAISE EXCEPTION 'agent_tests can only move from running to a terminal state' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agent_tests_transition
  BEFORE UPDATE OR DELETE ON agent_tests
  FOR EACH ROW EXECUTE FUNCTION enforce_agent_test_transition();

CREATE OR REPLACE FUNCTION require_passed_agent_test() RETURNS trigger AS $$
DECLARE
  test_status text;
BEGIN
  SELECT status INTO test_status
    FROM agent_tests
   WHERE id = NEW.qualifying_test_id
     AND project_id = NEW.project_id
     AND agent_revision_id = NEW.agent_revision_id
     AND runtime_bundle_sha256 = NEW.runtime_bundle_sha256
     AND ui_sha256 = NEW.ui_sha256;
  IF test_status IS DISTINCT FROM 'passed' THEN
    RAISE EXCEPTION 'agent release requires a passed test for the same revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agent_release_requires_passed_test
  BEFORE INSERT ON agent_releases
  FOR EACH ROW EXECUTE FUNCTION require_passed_agent_test();

-- Authoring 管理 Project、Revision 与 Release，并只读 Runtime 的 UI/Test 证据。
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_projects TO combo_api;
GRANT SELECT, INSERT ON agent_revisions, agent_releases TO combo_api;
GRANT SELECT ON agent_tests, sessions, turns, artifacts TO combo_api;

-- Runtime 只读已编译 Revision/Release，创建并收口真实 Test；既有 Session 权限沿用 0008。
GRANT SELECT ON agent_projects, agent_revisions, agent_releases TO combo_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_tests TO combo_runtime;

GRANT EXECUTE ON FUNCTION reject_agent_immutable_mutation() TO combo_api, combo_runtime;
GRANT EXECUTE ON FUNCTION enforce_agent_test_transition() TO combo_runtime;
GRANT EXECUTE ON FUNCTION require_passed_agent_test() TO combo_api;
GRANT EXECUTE ON FUNCTION protect_session_agent_pins() TO combo_runtime;
