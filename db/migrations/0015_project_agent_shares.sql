-- 0015 · 不可变 Git Project Agent 分享。
--
-- Combo 只保存 owner-scoped 创建事实、不可变 manifest 和随机公开定位符。
-- 这张表不保存 Project 文件、Codex 会话、凭据、环境变量值或 Runtime 状态。

CREATE TABLE project_agent_shares (
  id                 uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  owner_user_id      uuid        NOT NULL REFERENCES users(id),
  share_token        text        NOT NULL UNIQUE
                     CONSTRAINT ck_project_agent_share_token
                     CHECK (share_token ~ '^[A-Za-z0-9_-]{43}$'),
  manifest           jsonb       NOT NULL
                     CONSTRAINT ck_project_agent_share_manifest_object
                     CHECK (jsonb_typeof(manifest) = 'object'),
  manifest_sha256    char(64)    NOT NULL
                     CONSTRAINT ck_project_agent_share_manifest_sha
                     CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  idempotency_key    uuid        NOT NULL,
  idempotency_sha256 char(64)    NOT NULL
                     CONSTRAINT ck_project_agent_share_idempotency_sha
                     CHECK (idempotency_sha256 ~ '^[a-f0-9]{64}$'),
  created_at         timestamptz NOT NULL,
  CONSTRAINT uq_project_agent_share_owner_idempotency
    UNIQUE (owner_user_id, idempotency_key)
);

CREATE INDEX idx_project_agent_shares_owner_created
  ON project_agent_shares (owner_user_id, created_at DESC, id DESC);

CREATE TRIGGER trg_project_agent_shares_immutable
  BEFORE UPDATE OR DELETE ON project_agent_shares
  FOR EACH ROW EXECUTE FUNCTION reject_agent_immutable_mutation();

GRANT SELECT, INSERT ON project_agent_shares TO combo_api;
