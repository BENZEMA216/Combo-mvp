-- 0017 · canonical Agent Package Registry。
--
-- agent_packages 的不可变行是对象提交成功后的数据库 commit marker。对象键只由 exact
-- Package digest 与协议固定的 manifest path 推导，owner 不参与 key；数据库不复制 Package
-- manifest、知识 Bundle 摘要或 latest 指针。
-- Agent Package Release 只把一个稳定 Release ID 绑定到同一 owner 的 exact Package。

CREATE TABLE agent_packages (
  package_digest   text        PRIMARY KEY
                   CONSTRAINT ck_agent_package_digest
                   CHECK (package_digest ~ '^sha256:[a-f0-9]{64}$'),
  protocol         text        NOT NULL
                   CONSTRAINT ck_agent_package_protocol
                   CHECK (protocol = 'combo.agent-package/1'),
  owner_user_id    uuid        NOT NULL REFERENCES users(id),
  committed_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_agent_packages_digest_owner
    UNIQUE (package_digest, owner_user_id)
);

CREATE INDEX idx_agent_packages_owner_committed
  ON agent_packages (owner_user_id, committed_at DESC, package_digest DESC);

CREATE TABLE agent_package_releases (
  release_id       text        PRIMARY KEY
                   CONSTRAINT ck_agent_package_release_id
                   CHECK (release_id ~ '^release[.]agent-package[.][0-9a-f]{32}$'),
  package_digest   text        NOT NULL
                   CONSTRAINT ck_agent_package_release_digest
                   CHECK (package_digest ~ '^sha256:[a-f0-9]{64}$'),
  owner_user_id    uuid        NOT NULL,
  protocol         text        NOT NULL
                   CONSTRAINT ck_agent_package_release_protocol
                   CHECK (protocol = 'combo.agent-package-release/1'),
  release_scope    text        NOT NULL
                   CONSTRAINT ck_agent_package_release_scope
                   CHECK (release_scope = 'controlled_test'),
  idempotency_key  uuid        NOT NULL,
  request_sha256   char(64)    NOT NULL
                   CONSTRAINT ck_agent_package_release_request_sha
                   CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_agent_package_releases_exact_pair
    UNIQUE (release_id, package_digest),
  CONSTRAINT uq_agent_package_releases_owner_idempotency
    UNIQUE (owner_user_id, idempotency_key),
  CONSTRAINT fk_agent_package_release_package_owner
    FOREIGN KEY (package_digest, owner_user_id)
    REFERENCES agent_packages (package_digest, owner_user_id)
);

CREATE INDEX idx_agent_package_releases_owner_created
  ON agent_package_releases (owner_user_id, created_at DESC, release_id DESC);

CREATE FUNCTION reject_agent_package_registry_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql
   SECURITY INVOKER
   SET search_path = pg_catalog, public;

CREATE TRIGGER trg_agent_packages_immutable
  BEFORE UPDATE OR DELETE ON agent_packages
  FOR EACH ROW EXECUTE FUNCTION reject_agent_package_registry_mutation();

CREATE TRIGGER trg_agent_packages_no_truncate
  BEFORE TRUNCATE ON agent_packages
  FOR EACH STATEMENT EXECUTE FUNCTION reject_agent_package_registry_mutation();

CREATE TRIGGER trg_agent_package_releases_immutable
  BEFORE UPDATE OR DELETE ON agent_package_releases
  FOR EACH ROW EXECUTE FUNCTION reject_agent_package_registry_mutation();

CREATE TRIGGER trg_agent_package_releases_no_truncate
  BEFORE TRUNCATE ON agent_package_releases
  FOR EACH STATEMENT EXECUTE FUNCTION reject_agent_package_registry_mutation();

REVOKE ALL PRIVILEGES ON agent_packages, agent_package_releases
  FROM PUBLIC, combo_api, combo_worker, combo_runtime;
REVOKE ALL PRIVILEGES ON FUNCTION reject_agent_package_registry_mutation()
  FROM PUBLIC, combo_api, combo_worker, combo_runtime;

-- Authoring API 在对象字节提交后追加 marker，并创建只绑定 exact Package 的 Release。
GRANT SELECT, INSERT ON agent_packages, agent_package_releases TO combo_api;

-- Runtime 只解析运行所需的 owner、digest 与协议，不读取创建请求的幂等材料。
GRANT SELECT (package_digest, protocol)
  ON agent_packages TO combo_runtime;
GRANT SELECT (release_id, owner_user_id, package_digest, protocol, release_scope)
  ON agent_package_releases TO combo_runtime;

-- combo_worker 与 PUBLIC 保留零权限。
