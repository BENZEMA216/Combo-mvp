-- 0016 · Project history -> immutable Agent Package Release/share V2.
--
-- Draft JSON contains only the strict typed, model-derived candidate and bounded source counters.
-- Raw Project history, task/thread/session IDs, paths, messages, transcripts and clear confirmation
-- tokens are not columns in this data model. Confirmation tokens are stored as SHA-256 digests.

CREATE TABLE project_history_agent_drafts (
  draft_id             text        NOT NULL
                                  CONSTRAINT ck_project_history_draft_id
                                  CHECK (draft_id ~ '^draft[.]agent-package[.][0-9a-f]{32}$'),
  revision             bigint      NOT NULL CHECK (revision = 1),
  owner_user_id        uuid        NOT NULL REFERENCES users(id),
  draft_fingerprint    char(71)    NOT NULL
                                  CONSTRAINT ck_project_history_draft_fingerprint
                                  CHECK (draft_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  candidate_commitment char(71)    NOT NULL
                                  CONSTRAINT ck_project_history_candidate_commitment
                                  CHECK (candidate_commitment ~ '^sha256:[a-f0-9]{64}$'),
  draft_json           text        NOT NULL CHECK (octet_length(draft_json) <= 65536),
  idempotency_key      uuid        NOT NULL,
  request_fingerprint  char(71)    NOT NULL
                                  CONSTRAINT ck_project_history_draft_request_fingerprint
                                  CHECK (request_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (draft_id, revision),
  UNIQUE (owner_user_id, idempotency_key),
  UNIQUE (owner_user_id, draft_id, revision, draft_fingerprint),
  UNIQUE (owner_user_id, draft_id)
);

CREATE TABLE project_history_agent_confirmations (
  id                        uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  owner_user_id             uuid        NOT NULL REFERENCES users(id),
  draft_id                  text        NOT NULL,
  revision                  bigint      NOT NULL,
  draft_fingerprint         char(71)    NOT NULL,
  confirmation_token_sha256 char(64)    NOT NULL UNIQUE
                                      CONSTRAINT ck_project_history_confirmation_sha
                                      CHECK (confirmation_token_sha256 ~ '^[a-f0-9]{64}$'),
  expires_at                timestamptz NOT NULL,
  consumed_at               timestamptz,
  consumed_share_token      char(43),
  created_at                timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_user_id, draft_id, revision, draft_fingerprint)
    REFERENCES project_history_agent_drafts
      (owner_user_id, draft_id, revision, draft_fingerprint),
  CHECK ((consumed_at IS NULL) = (consumed_share_token IS NULL)),
  CHECK (consumed_share_token IS NULL OR consumed_share_token ~ '^[A-Za-z0-9_-]{43}$'),
  CHECK (expires_at = created_at + interval '5 minutes')
);
CREATE INDEX idx_project_history_agent_confirmations_expiry
  ON project_history_agent_confirmations (expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE project_history_agent_shares (
  share_token               char(43)    PRIMARY KEY
                                      CONSTRAINT ck_project_history_share_token
                                      CHECK (share_token ~ '^[A-Za-z0-9_-]{43}$'),
  owner_user_id             uuid        NOT NULL REFERENCES users(id),
  draft_id                  text        NOT NULL,
  draft_revision            bigint      NOT NULL,
  source_draft_fingerprint  char(71)    NOT NULL
                                      CONSTRAINT ck_project_history_share_draft_fingerprint
                                      CHECK (source_draft_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  confirmation_token_sha256 char(64)    NOT NULL UNIQUE
                                      CONSTRAINT ck_project_history_share_confirmation_sha
                                      CHECK (confirmation_token_sha256 ~ '^[a-f0-9]{64}$'),
  package_digest            char(71)    NOT NULL
                                      CONSTRAINT ck_project_history_share_package_digest
                                      CHECK (package_digest ~ '^sha256:[a-f0-9]{64}$'),
  share_url                 text        NOT NULL UNIQUE CHECK (octet_length(share_url) <= 2048),
  share_json                text        NOT NULL CHECK (octet_length(share_json) <= 262144),
  share_json_sha256         char(64)    NOT NULL
                                      CONSTRAINT ck_project_history_share_json_sha
                                      CHECK (share_json_sha256 ~ '^[a-f0-9]{64}$'),
  copy_prompt               text        NOT NULL CHECK (octet_length(copy_prompt) <= 4096),
  idempotency_key           uuid        NOT NULL,
  request_fingerprint       char(64)    NOT NULL
                                      CONSTRAINT ck_project_history_share_request_fingerprint
                                      CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, idempotency_key),
  UNIQUE (owner_user_id, source_draft_fingerprint),
  FOREIGN KEY (owner_user_id, draft_id, draft_revision, source_draft_fingerprint)
    REFERENCES project_history_agent_drafts
      (owner_user_id, draft_id, revision, draft_fingerprint)
);

CREATE OR REPLACE FUNCTION reject_project_history_agent_immutable_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_project_history_agent_drafts_immutable
  BEFORE UPDATE OR DELETE ON project_history_agent_drafts
  FOR EACH ROW EXECUTE FUNCTION reject_project_history_agent_immutable_mutation();

CREATE TRIGGER trg_project_history_agent_shares_immutable
  BEFORE UPDATE OR DELETE ON project_history_agent_shares
  FOR EACH ROW EXECUTE FUNCTION reject_project_history_agent_immutable_mutation();

CREATE OR REPLACE FUNCTION enforce_project_history_share_insert_integrity() RETURNS trigger AS $$
BEGIN
  IF NEW.share_json_sha256 <> encode(public.digest(NEW.share_json, 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'project history share JSON digest mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_project_history_agent_share_insert_integrity
  BEFORE INSERT ON project_history_agent_shares
  FOR EACH ROW EXECUTE FUNCTION enforce_project_history_share_insert_integrity();

CREATE OR REPLACE FUNCTION enforce_project_history_confirmation_consumption() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.consumed_at IS NOT NULL OR OLD.expires_at <= clock_timestamp() THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'active project history confirmations cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
     OR OLD.draft_id IS DISTINCT FROM NEW.draft_id
     OR OLD.revision IS DISTINCT FROM NEW.revision
     OR OLD.draft_fingerprint IS DISTINCT FROM NEW.draft_fingerprint
     OR OLD.confirmation_token_sha256 IS DISTINCT FROM NEW.confirmation_token_sha256
     OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'project history confirmation identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.expires_at <= clock_timestamp() THEN
    -- A token can cross its expiry between the repository predicate and this trigger. Treat that
    -- as a zero-row consume so the transaction rolls back the provisional share and the service
    -- returns confirmation_invalid instead of surfacing an internal database error.
    RETURN NULL;
  END IF;
  IF OLD.consumed_at IS NOT NULL
     OR NEW.consumed_at IS NULL
     OR NEW.consumed_share_token IS NULL THEN
    RAISE EXCEPTION 'project history confirmation can be consumed exactly once' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.project_history_agent_shares s
     WHERE s.share_token = NEW.consumed_share_token
       AND s.confirmation_token_sha256 = OLD.confirmation_token_sha256
       AND s.owner_user_id = OLD.owner_user_id
       AND s.draft_id = OLD.draft_id
       AND s.source_draft_fingerprint = OLD.draft_fingerprint
  ) THEN
    RAISE EXCEPTION 'project history confirmation must bind its exact immutable share' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_project_history_agent_confirmation_consumption
  BEFORE UPDATE OR DELETE ON project_history_agent_confirmations
  FOR EACH ROW EXECUTE FUNCTION enforce_project_history_confirmation_consumption();

CREATE FUNCTION issue_project_history_agent_confirmation(
  input_owner_user_id uuid,
  input_draft_id text,
  input_revision bigint,
  input_draft_fingerprint text,
  input_confirmation_token_sha256 text
)
RETURNS TABLE (
  confirmation_token_sha256 char(64),
  created_at timestamptz,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  database_clock timestamptz := clock_timestamp();
BEGIN
  RETURN QUERY
  INSERT INTO public.project_history_agent_confirmations AS confirmation (
    owner_user_id, draft_id, revision, draft_fingerprint, confirmation_token_sha256,
    created_at, expires_at, consumed_at, consumed_share_token
  ) VALUES (
    input_owner_user_id, input_draft_id, input_revision, input_draft_fingerprint,
    input_confirmation_token_sha256, database_clock, database_clock + interval '5 minutes',
    NULL, NULL
  )
  RETURNING confirmation.confirmation_token_sha256,
            confirmation.created_at,
            confirmation.expires_at;
END
$$;

CREATE FUNCTION cleanup_retired_project_history_confirmations(batch_size integer)
RETURNS TABLE (confirmations_deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  bounded_limit integer := LEAST(GREATEST(COALESCE(batch_size, 1), 1), 100);
BEGIN
  WITH database_clock AS (
    SELECT clock_timestamp() AS checked_at
  ), doomed AS (
    SELECT confirmation.id
      FROM public.project_history_agent_confirmations AS confirmation
      CROSS JOIN database_clock
     WHERE confirmation.consumed_at IS NOT NULL
        OR confirmation.expires_at <= database_clock.checked_at
     ORDER BY confirmation.expires_at, confirmation.id
     LIMIT bounded_limit
     FOR UPDATE OF confirmation SKIP LOCKED
  )
  DELETE FROM public.project_history_agent_confirmations AS confirmation
   USING doomed
   WHERE confirmation.id = doomed.id;
  GET DIAGNOSTICS confirmations_deleted = ROW_COUNT;
  RETURN NEXT;
END
$$;

REVOKE ALL PRIVILEGES ON
  project_history_agent_drafts,
  project_history_agent_confirmations,
  project_history_agent_shares
FROM PUBLIC, combo_api, combo_worker, combo_runtime;

GRANT SELECT, INSERT ON project_history_agent_drafts TO combo_api;
GRANT SELECT ON project_history_agent_confirmations TO combo_api;
GRANT UPDATE (consumed_at, consumed_share_token) ON project_history_agent_confirmations TO combo_api;
GRANT SELECT, INSERT ON project_history_agent_shares TO combo_api;

REVOKE ALL PRIVILEGES ON FUNCTION
  reject_project_history_agent_immutable_mutation(),
  enforce_project_history_share_insert_integrity(),
  enforce_project_history_confirmation_consumption(),
  issue_project_history_agent_confirmation(uuid, text, bigint, text, text),
  cleanup_retired_project_history_confirmations(integer)
FROM PUBLIC, combo_api, combo_worker, combo_runtime;
GRANT EXECUTE ON FUNCTION issue_project_history_agent_confirmation(uuid, text, bigint, text, text) TO combo_api;
GRANT EXECUTE ON FUNCTION cleanup_retired_project_history_confirmations(integer) TO combo_api;
