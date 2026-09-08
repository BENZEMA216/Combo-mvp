-- Private authoring snapshots are not public Package Releases.
CREATE TABLE agent_draft_revisions (
  owner_user_id uuid NOT NULL REFERENCES users(id),
  draft_id text NOT NULL CHECK (draft_id ~ '^draft\.agent-package\.[0-9a-f]{32}$'),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  draft_fingerprint text NOT NULL CHECK (draft_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  parent_fingerprint text CHECK (parent_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  parent_revision bigint GENERATED ALWAYS AS (CASE WHEN revision = 1 THEN NULL ELSE revision - 1 END) STORED,
  package_digest text NOT NULL CHECK (package_digest ~ '^sha256:[0-9a-f]{64}$'),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  snapshot_bytes integer NOT NULL CHECK (snapshot_bytes BETWEEN 1 AND 524288),
  request_id uuid NOT NULL,
  view_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, draft_id, revision),
  UNIQUE (owner_user_id, request_id),
  UNIQUE (owner_user_id, draft_id, revision, draft_fingerprint),
  CHECK ((revision = 1) = (parent_fingerprint IS NULL)),
  FOREIGN KEY (owner_user_id, draft_id, parent_revision, parent_fingerprint)
    REFERENCES agent_draft_revisions(owner_user_id, draft_id, revision, draft_fingerprint)
);

CREATE FUNCTION reject_agent_draft_revision_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Agent Draft revisions are append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER agent_draft_revisions_no_mutation
  BEFORE UPDATE OR DELETE OR TRUNCATE ON agent_draft_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_agent_draft_revision_mutation();

REVOKE ALL ON agent_draft_revisions FROM PUBLIC, combo_worker, combo_runtime;
GRANT SELECT, INSERT ON agent_draft_revisions TO combo_api;
REVOKE ALL ON FUNCTION reject_agent_draft_revision_mutation() FROM PUBLIC, combo_api, combo_worker, combo_runtime;
