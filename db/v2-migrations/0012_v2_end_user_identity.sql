-- 0012 · V2 终端用户体系（中台一·用户体系）的持久层。V1 的 auth_* 表属于创作者身份域，
-- 本迁移的 v2_* 表属于终端用户身份域，两套表互不引用、互不授权。
-- 与 V1 相同的纪律：验证码挑战与不透明会话只存摘要，不存验证码、手机号以外的凭据或 Cookie 原文；
-- 会话固定七天期限并允许显式撤销。

-- 终端用户主表。全平台跨 Agent 一套账号；业务归属（钱包、计量）都指向这里的主键。
CREATE TABLE v2_users (
  id         uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 登录身份。identifier 是按类型规范化后的原文（手机号是认证标识，不属于口令类敏感数据）；
-- union_id 第一天就保留，微信授权接入时回填，当前只允许为空。
CREATE TABLE v2_identities (
  id         uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  user_id    uuid        NOT NULL REFERENCES v2_users(id) ON DELETE CASCADE,
  type       text        NOT NULL,
  identifier text        NOT NULL,
  union_id   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_v2_identity UNIQUE (type, identifier),
  CONSTRAINT ck_v2_identity_type CHECK (type IN ('phone', 'wechat_openid')),
  CONSTRAINT ck_v2_identity_identifier CHECK (
    char_length(identifier) BETWEEN 5 AND 128
    AND identifier !~ '[[:cntrl:]]'
  ),
  -- 手机号只保存去掉加号的数字规范形（E.164 去前缀）。
  CONSTRAINT ck_v2_identity_phone CHECK (
    type <> 'phone' OR identifier ~ '^[1-9][0-9]{4,14}$'
  ),
  CONSTRAINT ck_v2_identity_union_id CHECK (
    union_id IS NULL
    OR (char_length(union_id) BETWEEN 1 AND 128 AND union_id !~ '[[:cntrl:]]')
  )
);

CREATE INDEX idx_v2_identities_user ON v2_identities (user_id);

-- 验证码挑战只保存目标与验证码的域分离 HMAC 摘要。consumed_at 与 invalidated_at 是互斥终态；
-- 同一目标同一时间最多一个未完成挑战，重新请求会把旧挑战作废。
CREATE TABLE v2_auth_challenges (
  id             uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  channel        text        NOT NULL,
  purpose        text        NOT NULL,
  target_digest  bytea       NOT NULL,
  code_digest    bytea       NOT NULL,
  attempt_count  smallint    NOT NULL DEFAULT 0,
  max_attempts   smallint    NOT NULL DEFAULT 5,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  invalidated_at timestamptz,
  CONSTRAINT ck_v2_challenge_channel CHECK (channel = 'phone'),
  CONSTRAINT ck_v2_challenge_purpose CHECK (purpose = 'login'),
  CONSTRAINT ck_v2_challenge_digest_length CHECK (
    octet_length(target_digest) = 32
    AND octet_length(code_digest) = 32
  ),
  CONSTRAINT ck_v2_challenge_attempts CHECK (
    max_attempts = 5
    AND attempt_count BETWEEN 0 AND max_attempts
  ),
  CONSTRAINT ck_v2_challenge_ttl CHECK (
    expires_at > created_at
    AND expires_at <= created_at + interval '5 minutes'
  ),
  CONSTRAINT ck_v2_challenge_consumption CHECK (
    consumed_at IS NULL
    OR (consumed_at >= created_at AND consumed_at < expires_at)
  ),
  CONSTRAINT ck_v2_challenge_invalidation CHECK (
    invalidated_at IS NULL OR invalidated_at >= created_at
  ),
  CONSTRAINT ck_v2_challenge_terminal CHECK (
    NOT (consumed_at IS NOT NULL AND invalidated_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_v2_challenge_unfinished_target
  ON v2_auth_challenges (channel, purpose, target_digest)
  WHERE consumed_at IS NULL
    AND invalidated_at IS NULL;
CREATE INDEX idx_v2_challenges_gc
  ON v2_auth_challenges (COALESCE(consumed_at, invalidated_at, expires_at));

-- 浏览器保存 v2s1. 前缀的随机会话原文；本表只保存完整 Cookie 值的 SHA-256 摘要。
CREATE TABLE v2_sessions (
  id           uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  user_id      uuid        NOT NULL REFERENCES v2_users(id) ON DELETE CASCADE,
  token_digest bytea       NOT NULL UNIQUE,
  auth_method  text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '7 days',
  revoked_at   timestamptz,
  CONSTRAINT ck_v2_session_method CHECK (auth_method = 'dev_phone_otp'),
  CONSTRAINT ck_v2_session_digest CHECK (octet_length(token_digest) = 32),
  CONSTRAINT ck_v2_session_ttl CHECK (
    expires_at = created_at + interval '7 days'
  ),
  CONSTRAINT ck_v2_session_revocation CHECK (
    revoked_at IS NULL OR revoked_at >= created_at
  )
);

CREATE INDEX idx_v2_sessions_user_live
  ON v2_sessions (user_id, expires_at DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_v2_sessions_gc
  ON v2_sessions (COALESCE(revoked_at, expires_at));

-- authz 进程使用独立登录角色。迁移所有权账号只负责建表和授权；
-- 密码由迁移 runner 通过环境变量 POSTGRES_AUTHZ_PASSWORD 在全部迁移成功后设置并启用登录。
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'combo_authz') THEN
    EXECUTE 'CREATE ROLE combo_authz NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
END
$roles$;

ALTER ROLE combo_authz NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO combo_authz;

-- 终端用户身份域只对 combo_authz 开放；创作者域角色与 PUBLIC 对 v2_* 表零权限。
REVOKE ALL PRIVILEGES ON v2_users, v2_identities, v2_auth_challenges, v2_sessions
  FROM PUBLIC, combo_api, combo_worker, combo_runtime, combo_authz;

-- authz 只在登录链路写用户与身份，从不修改或删除既有行。
GRANT SELECT, INSERT ON v2_users TO combo_authz;
GRANT SELECT, INSERT ON v2_identities TO combo_authz;
-- 挑战需要累加失败次数和落定终态；会话需要显式撤销。
GRANT SELECT, INSERT, UPDATE ON v2_auth_challenges TO combo_authz;
GRANT SELECT, INSERT, UPDATE ON v2_sessions TO combo_authz;

GRANT EXECUTE ON FUNCTION gen_uuid_v7() TO combo_authz;
