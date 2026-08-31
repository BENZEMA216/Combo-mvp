-- 0014 · Agent Test 的不可变人工质量复核与 Release 证据冻结。
--
-- Runtime Test 继续只证明固定 Revision 的技术执行成功。Authoring 在其上追加一次
-- owner-scoped 质量复核；新 Release 必须同时冻结 Test 与 Review。迁移前的 Release
-- 保留 NULL Review 指针，仍可读取和运行。

CREATE TABLE agent_test_reviews (
  id                    uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  project_id            uuid        NOT NULL REFERENCES agent_projects(id),
  test_id               uuid        NOT NULL,
  agent_revision_id     uuid        NOT NULL,
  runtime_bundle_sha256 char(64)    NOT NULL
                        CONSTRAINT ck_agent_test_review_bundle_sha
                        CHECK (runtime_bundle_sha256 ~ '^[a-f0-9]{64}$'),
  ui_sha256             char(64)    NOT NULL
                        CONSTRAINT ck_agent_test_review_ui_sha
                        CHECK (ui_sha256 ~ '^[a-f0-9]{64}$'),
  quality_status        text        NOT NULL
                        CONSTRAINT ck_agent_test_review_quality_status
                        CHECK (quality_status IN ('passed', 'failed', 'accepted_exception')),
  cases                 jsonb       NOT NULL
                        CONSTRAINT ck_agent_test_review_cases_array
                        CHECK (jsonb_typeof(cases) = 'array' AND jsonb_array_length(cases) BETWEEN 3 AND 50),
  summary               text        NOT NULL DEFAULT '',
  review_sha256         char(64)    NOT NULL
                        CONSTRAINT ck_agent_test_review_sha
                        CHECK (review_sha256 ~ '^[a-f0-9]{64}$'),
  idempotency_key       text        NOT NULL,
  idempotency_sha256    char(64)    NOT NULL
                        CONSTRAINT ck_agent_test_review_idempotency_sha
                        CHECK (idempotency_sha256 ~ '^[a-f0-9]{64}$'),
  created_by_user_id    uuid        NOT NULL REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_agent_test_reviews_project_test UNIQUE (project_id, test_id),
  CONSTRAINT uq_agent_test_reviews_project_idempotency UNIQUE (project_id, idempotency_key),
  CONSTRAINT uq_agent_test_reviews_release_identity
    UNIQUE (id, project_id, test_id, agent_revision_id, runtime_bundle_sha256, ui_sha256, review_sha256),
  CONSTRAINT fk_agent_test_review_test
    FOREIGN KEY (test_id, project_id, agent_revision_id, runtime_bundle_sha256, ui_sha256)
    REFERENCES agent_tests (id, project_id, agent_revision_id, runtime_bundle_sha256, ui_sha256),
  CONSTRAINT fk_agent_test_review_owner
    FOREIGN KEY (project_id, created_by_user_id)
    REFERENCES agent_projects (id, owner_user_id)
);
CREATE INDEX idx_agent_test_reviews_revision_created
  ON agent_test_reviews (agent_revision_id, created_at DESC);

CREATE OR REPLACE FUNCTION validate_agent_test_review() RETURNS trigger AS $$
DECLARE
  test_status text;
  derived_status text;
BEGIN
  SELECT status INTO test_status
    FROM agent_tests
   WHERE id = NEW.test_id
     AND project_id = NEW.project_id
     AND agent_revision_id = NEW.agent_revision_id
     AND runtime_bundle_sha256 = NEW.runtime_bundle_sha256
     AND ui_sha256 = NEW.ui_sha256;
  IF test_status IS DISTINCT FROM 'passed' THEN
    RAISE EXCEPTION 'agent test review requires a passed test for the same revision'
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(NEW.cases) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'agent test review cases must be an array' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(NEW.cases) NOT BETWEEN 3 AND 50 THEN
    RAISE EXCEPTION 'agent test review requires between 3 and 50 cases'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(NEW.cases) AS item(value)
     WHERE jsonb_typeof(value) <> 'object'
        OR NOT (value ?& ARRAY['caseId', 'kind', 'executionStatus', 'qualityVerdict', 'reason'])
        OR value - ARRAY['caseId', 'kind', 'executionStatus', 'qualityVerdict', 'reason', 'impact'] <> '{}'::jsonb
        OR jsonb_typeof(value -> 'caseId') <> 'string'
        OR jsonb_typeof(value -> 'kind') <> 'string'
        OR jsonb_typeof(value -> 'executionStatus') <> 'string'
        OR jsonb_typeof(value -> 'qualityVerdict') <> 'string'
        OR jsonb_typeof(value -> 'reason') <> 'string'
        OR (value ? 'impact' AND jsonb_typeof(value -> 'impact') <> 'string')
        OR btrim(value ->> 'caseId') = ''
        OR btrim(value ->> 'reason') = ''
        OR value ->> 'kind' NOT IN ('normal', 'boundary', 'failure')
        OR value ->> 'executionStatus' NOT IN ('completed', 'failed')
        OR value ->> 'qualityVerdict' NOT IN ('passed', 'failed', 'accepted_exception')
  ) THEN
    RAISE EXCEPTION 'agent test review case shape is invalid' USING ERRCODE = '23514';
  END IF;
  IF (
    SELECT count(*) <> count(DISTINCT value ->> 'caseId')
      FROM jsonb_array_elements(NEW.cases) AS item(value)
  ) THEN
    RAISE EXCEPTION 'agent test review case ids must be unique' USING ERRCODE = '23514';
  END IF;
  IF NOT NEW.cases @> '[{"kind":"normal"}]'::jsonb
     OR NOT NEW.cases @> '[{"kind":"boundary"}]'::jsonb
     OR NOT NEW.cases @> '[{"kind":"failure"}]'::jsonb THEN
    RAISE EXCEPTION 'agent test review requires normal, boundary and failure cases'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(NEW.cases) AS item(value)
     WHERE value ->> 'qualityVerdict' = 'accepted_exception'
       AND (btrim(value ->> 'reason') = '' OR btrim(COALESCE(value ->> 'impact', '')) = '')
  ) THEN
    RAISE EXCEPTION 'accepted exception requires reason and impact' USING ERRCODE = '23514';
  END IF;

  SELECT CASE
           WHEN EXISTS (
             SELECT 1 FROM jsonb_array_elements(NEW.cases) AS item(value)
              WHERE value ->> 'executionStatus' = 'failed'
                 OR value ->> 'qualityVerdict' = 'failed'
           ) THEN 'failed'
           WHEN EXISTS (
             SELECT 1 FROM jsonb_array_elements(NEW.cases) AS item(value)
              WHERE value ->> 'qualityVerdict' = 'accepted_exception'
           ) THEN 'accepted_exception'
           ELSE 'passed'
         END
    INTO derived_status;
  IF NEW.quality_status IS DISTINCT FROM derived_status THEN
    RAISE EXCEPTION 'agent test review quality status must be derived from its cases'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agent_test_reviews_validate
  BEFORE INSERT ON agent_test_reviews
  FOR EACH ROW EXECUTE FUNCTION validate_agent_test_review();

CREATE TRIGGER trg_agent_test_reviews_immutable
  BEFORE UPDATE OR DELETE ON agent_test_reviews
  FOR EACH ROW EXECUTE FUNCTION reject_agent_immutable_mutation();

ALTER TABLE agent_releases
  ADD COLUMN qualifying_review_id uuid,
  ADD COLUMN review_sha256 char(64),
  ADD CONSTRAINT ck_agent_release_review_sha
    CHECK (review_sha256 IS NULL OR review_sha256 ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT ck_agent_release_review_pair
    CHECK ((qualifying_review_id IS NULL) = (review_sha256 IS NULL)),
  ADD CONSTRAINT fk_agent_release_review
    FOREIGN KEY (
      qualifying_review_id, project_id, qualifying_test_id, agent_revision_id,
      runtime_bundle_sha256, ui_sha256, review_sha256
    )
    REFERENCES agent_test_reviews (
      id, project_id, test_id, agent_revision_id,
      runtime_bundle_sha256, ui_sha256, review_sha256
    );

CREATE OR REPLACE FUNCTION require_passed_agent_test() RETURNS trigger AS $$
DECLARE
  test_status text;
  review_status text;
BEGIN
  SELECT t.status, r.quality_status INTO test_status, review_status
    FROM agent_tests t
    LEFT JOIN agent_test_reviews r
      ON r.id = NEW.qualifying_review_id
     AND r.project_id = t.project_id
     AND r.test_id = t.id
     AND r.agent_revision_id = t.agent_revision_id
     AND r.runtime_bundle_sha256 = t.runtime_bundle_sha256
     AND r.ui_sha256 = t.ui_sha256
     AND r.review_sha256 = NEW.review_sha256
   WHERE t.id = NEW.qualifying_test_id
     AND t.project_id = NEW.project_id
     AND t.agent_revision_id = NEW.agent_revision_id
     AND t.runtime_bundle_sha256 = NEW.runtime_bundle_sha256
     AND t.ui_sha256 = NEW.ui_sha256;
  IF test_status IS DISTINCT FROM 'passed' THEN
    RAISE EXCEPTION 'agent release requires a passed test for the same revision'
      USING ERRCODE = '23514';
  END IF;
  IF review_status IS NULL OR review_status NOT IN ('passed', 'accepted_exception') THEN
    RAISE EXCEPTION 'agent release requires a publishable quality review for the same test'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

GRANT SELECT, INSERT ON agent_test_reviews TO combo_api;
GRANT SELECT ON agent_test_reviews TO combo_runtime;

REVOKE ALL PRIVILEGES ON FUNCTION validate_agent_test_review() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION validate_agent_test_review() TO combo_api;
GRANT EXECUTE ON FUNCTION reject_agent_immutable_mutation() TO combo_api, combo_runtime;
GRANT EXECUTE ON FUNCTION require_passed_agent_test() TO combo_api;
