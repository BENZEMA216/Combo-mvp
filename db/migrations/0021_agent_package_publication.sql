-- Browser-approved private uploads and exact public Package releases.
-- Existing Package bytes, Release rows and controlled-Test ownership remain unchanged.

ALTER TABLE agent_draft_revisions ADD CONSTRAINT uq_agent_draft_exact_package
  UNIQUE (owner_user_id, draft_id, revision, draft_fingerprint, package_digest);

CREATE TABLE agent_package_publisher_claims (
  claim_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  package_digest text NOT NULL REFERENCES agent_packages(package_digest),
  draft_id text NOT NULL,
  draft_revision bigint NOT NULL,
  draft_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (claim_id, owner_user_id, package_digest),
  UNIQUE (owner_user_id, draft_id, draft_revision, draft_fingerprint, package_digest),
  FOREIGN KEY (owner_user_id, draft_id, draft_revision, draft_fingerprint, package_digest)
    REFERENCES agent_draft_revisions
      (owner_user_id, draft_id, revision, draft_fingerprint, package_digest)
);

-- The historical Package owner is retained as first-committer attribution. It is
-- not authority for public publishing; independent claims bind each publisher to
-- their own verified private Draft. No historical row is rewritten or deleted.
ALTER TABLE agent_package_releases
  DROP CONSTRAINT fk_agent_package_release_package_owner,
  DROP CONSTRAINT ck_agent_package_release_scope,
  ADD COLUMN publisher_claim_id uuid,
  ADD CONSTRAINT fk_agent_package_release_package
    FOREIGN KEY (package_digest) REFERENCES agent_packages(package_digest),
  ADD CONSTRAINT fk_agent_package_release_owner
    FOREIGN KEY (owner_user_id) REFERENCES users(id),
  ADD CONSTRAINT uq_agent_package_release_publisher
    UNIQUE (release_id, owner_user_id, package_digest),
  ADD CONSTRAINT ck_agent_package_release_scope
    CHECK ((release_scope = 'controlled_test' AND publisher_claim_id IS NULL)
      OR (release_scope = 'public_link' AND publisher_claim_id IS NOT NULL)),
  ADD CONSTRAINT fk_agent_package_release_claim
    FOREIGN KEY (publisher_claim_id, owner_user_id, package_digest)
      REFERENCES agent_package_publisher_claims(claim_id, owner_user_id, package_digest);

CREATE FUNCTION enforce_controlled_agent_package_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.release_scope = 'controlled_test' AND NOT EXISTS (
    SELECT 1 FROM public.agent_packages
      WHERE package_digest = NEW.package_digest AND owner_user_id = NEW.owner_user_id
  ) THEN
    RAISE EXCEPTION 'Controlled Agent Package owner mismatch'
      USING ERRCODE = '23503', CONSTRAINT = 'fk_agent_package_release_package_owner';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_package_release_controlled_owner
  BEFORE INSERT ON agent_package_releases
  FOR EACH ROW EXECUTE FUNCTION enforce_controlled_agent_package_owner();

CREATE TABLE agent_package_release_revocations (
  release_id text PRIMARY KEY,
  owner_user_id uuid NOT NULL,
  package_digest text NOT NULL,
  reason text NOT NULL CHECK (reason = 'publisher_request'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (release_id, owner_user_id, package_digest)
    REFERENCES agent_package_releases(release_id, owner_user_id, package_digest)
);

CREATE TRIGGER agent_package_publisher_claims_immutable
  BEFORE UPDATE OR DELETE ON agent_package_publisher_claims
  FOR EACH ROW EXECUTE FUNCTION reject_agent_package_registry_mutation();
CREATE TRIGGER agent_package_publisher_claims_no_truncate
  BEFORE TRUNCATE ON agent_package_publisher_claims
  FOR EACH STATEMENT EXECUTE FUNCTION reject_agent_package_registry_mutation();
CREATE TRIGGER agent_package_release_revocations_immutable
  BEFORE UPDATE OR DELETE ON agent_package_release_revocations
  FOR EACH ROW EXECUTE FUNCTION reject_agent_package_registry_mutation();
CREATE TRIGGER agent_package_release_revocations_no_truncate
  BEFORE TRUNCATE ON agent_package_release_revocations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_agent_package_registry_mutation();

CREATE TABLE agent_package_transfers (
  transfer_id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  draft_fingerprint text NOT NULL CHECK (draft_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  package_digest text NOT NULL CHECK (package_digest ~ '^sha256:[a-f0-9]{64}$'),
  secret_sha256 char(64) NOT NULL CHECK (secret_sha256 ~ '^[a-f0-9]{64}$'),
  verification_code char(8) NOT NULL CHECK (verification_code ~ '^[A-Z0-9]{8}$'),
  phase text NOT NULL DEFAULT 'pending_approval'
    CHECK (phase IN ('pending_approval', 'approved', 'uploaded', 'published', 'rejected')),
  owner_user_id uuid REFERENCES users(id),
  draft_id text,
  draft_revision bigint,
  release_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  uploaded_at timestamptz,
  published_at timestamptz,
  rejected_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  CHECK ((phase = 'pending_approval') = (owner_user_id IS NULL)),
  CHECK ((phase IN ('approved', 'uploaded', 'published')) = (approved_at IS NOT NULL)
    OR (phase = 'rejected' AND owner_user_id IS NOT NULL)),
  CHECK ((phase IN ('uploaded', 'published')) =
    (draft_id IS NOT NULL AND draft_revision IS NOT NULL AND uploaded_at IS NOT NULL)),
  CHECK (phase IN ('uploaded', 'published') OR
    (draft_id IS NULL AND draft_revision IS NULL AND uploaded_at IS NULL)),
  CHECK ((phase = 'published') = (release_id IS NOT NULL AND published_at IS NOT NULL)),
  CHECK (phase = 'published' OR (release_id IS NULL AND published_at IS NULL)),
  CHECK ((phase = 'rejected') = (rejected_at IS NOT NULL)),
  FOREIGN KEY (owner_user_id, draft_id, draft_revision, draft_fingerprint, package_digest)
    REFERENCES agent_draft_revisions
      (owner_user_id, draft_id, revision, draft_fingerprint, package_digest),
  FOREIGN KEY (release_id, owner_user_id, package_digest)
    REFERENCES agent_package_releases(release_id, owner_user_id, package_digest)
);

CREATE INDEX agent_package_transfers_owner_created
  ON agent_package_transfers (owner_user_id, created_at DESC, transfer_id)
  WHERE owner_user_id IS NOT NULL;
CREATE INDEX agent_package_transfers_pending_expiry
  ON agent_package_transfers (expires_at, transfer_id)
  WHERE phase IN ('pending_approval', 'approved');

CREATE FUNCTION guard_agent_package_transfer() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Agent Package transfer audit is retained' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.phase <> 'pending_approval' OR NEW.owner_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'Agent Package transfer must start pending' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.expires_at := NEW.created_at + interval '10 minutes';
    RETURN NEW;
  END IF;
  IF ROW(NEW.transfer_id, NEW.name, NEW.draft_fingerprint, NEW.package_digest,
      NEW.secret_sha256, NEW.verification_code, NEW.created_at, NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.transfer_id, OLD.name, OLD.draft_fingerprint, OLD.package_digest,
      OLD.secret_sha256, OLD.verification_code, OLD.created_at, OLD.expires_at)
    OR (OLD.owner_user_id IS NOT NULL AND NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id)
    OR (NEW.approved_at IS DISTINCT FROM OLD.approved_at)
    OR (OLD.uploaded_at IS NOT NULL AND
      ROW(NEW.draft_id, NEW.draft_revision, NEW.uploaded_at)
        IS DISTINCT FROM ROW(OLD.draft_id, OLD.draft_revision, OLD.uploaded_at)) THEN
    RAISE EXCEPTION 'Agent Package transfer identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD.phase = 'pending_approval' AND NEW.phase IN ('approved', 'rejected'))
    OR (OLD.phase = 'approved' AND NEW.phase IN ('uploaded', 'rejected'))
    OR (OLD.phase = 'uploaded' AND NEW.phase = 'published')
  ) THEN
    RAISE EXCEPTION 'Agent Package transfer transition is invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW.phase IN ('approved', 'uploaded') AND clock_timestamp() >= OLD.expires_at THEN
    RAISE EXCEPTION 'Agent Package upload authorization expired' USING ERRCODE = '23514';
  END IF;
  IF NEW.phase = 'approved' THEN
    NEW.approved_at := clock_timestamp();
  ELSIF NEW.phase = 'uploaded' THEN
    NEW.uploaded_at := clock_timestamp();
  ELSIF NEW.phase = 'published' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.agent_package_releases AS release
      JOIN public.agent_package_publisher_claims AS claim
        ON claim.claim_id = release.publisher_claim_id
      WHERE release.release_id = NEW.release_id AND release.release_scope = 'public_link'
        AND ROW(claim.owner_user_id, claim.draft_id, claim.draft_revision,
          claim.draft_fingerprint, claim.package_digest)
          = ROW(NEW.owner_user_id, NEW.draft_id, NEW.draft_revision,
            NEW.draft_fingerprint, NEW.package_digest)
    ) THEN
      RAISE EXCEPTION 'Agent Package publication must match the exact approved Draft'
        USING ERRCODE = '23514';
    END IF;
    NEW.published_at := clock_timestamp();
  ELSIF NEW.phase = 'rejected' THEN
    NEW.rejected_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_package_transfer_guard
  BEFORE INSERT OR UPDATE OR DELETE ON agent_package_transfers
  FOR EACH ROW EXECUTE FUNCTION guard_agent_package_transfer();
CREATE TRIGGER agent_package_transfer_no_truncate
  BEFORE TRUNCATE ON agent_package_transfers
  FOR EACH STATEMENT EXECUTE FUNCTION guard_agent_package_transfer();

REVOKE ALL ON agent_package_publisher_claims, agent_package_release_revocations,
  agent_package_transfers FROM PUBLIC, combo_api, combo_worker, combo_runtime;
GRANT SELECT, INSERT ON agent_package_publisher_claims,
  agent_package_release_revocations, agent_package_transfers TO combo_api;
GRANT UPDATE (phase, owner_user_id, draft_id, draft_revision, release_id)
  ON agent_package_transfers TO combo_api;
REVOKE ALL ON FUNCTION enforce_controlled_agent_package_owner(),
  guard_agent_package_transfer() FROM PUBLIC, combo_api, combo_worker, combo_runtime;
