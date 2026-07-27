-- 0007 · 第一方邮箱认证是停机式 clean-slate 切换。users.id 继续作为全库业务主体，
-- 但旧外部身份列不做回填或兼容读取。迁移期间锁住 users，避免空表检查后出现并发写入。
LOCK TABLE users IN ACCESS EXCLUSIVE MODE;

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM users) THEN
    RAISE EXCEPTION 'first-party email auth migration requires an empty users table'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

ALTER TABLE users
  DROP COLUMN logto_user_id,
  DROP COLUMN email,
  ADD COLUMN disabled_at timestamptz,
  ALTER COLUMN roles SET DEFAULT ARRAY['creator']::text[];

ALTER TABLE users
  ADD CONSTRAINT ck_users_account_mvp CHECK (
    account ~ '^creator-[a-z2-7]{8}$'
  ),
  ADD CONSTRAINT ck_users_roles_mvp CHECK (
    roles = ARRAY['creator']::text[]
  );

-- 已验证邮箱是本期唯一身份。subject 保存服务端完成 IDNA 处理后的规范邮箱；
-- local-part 保留大小写，域名必须是小写 ASCII 标签。
CREATE TABLE auth_identities (
  id          uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    text        NOT NULL,
  issuer      text        NOT NULL,
  subject     text        NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_auth_identity_subject UNIQUE (provider, issuer, subject),
  CONSTRAINT uq_auth_identity_user_provider UNIQUE (user_id, provider),
  CONSTRAINT ck_auth_identity_provider_mvp CHECK (provider = 'email'),
  CONSTRAINT ck_auth_identity_issuer_mvp CHECK (issuer = 'local'),
  CONSTRAINT ck_auth_identity_email CHECK (
    char_length(subject) BETWEEN 3 AND 254
    AND subject ~ '^[^@[:space:]]+@[^@[:space:]]+$'
    AND subject !~ '[[:cntrl:]]'
    AND split_part(subject, '@', 2) = lower(split_part(subject, '@', 2))
    AND split_part(subject, '@', 2) ~
      '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'
  ),
  CONSTRAINT ck_auth_identity_timestamps CHECK (
    verified_at >= created_at
    AND updated_at >= created_at
  )
);

-- challenge 只保存目标与验证码的域分离 HMAC 摘要。activated_at 为空表示邮件尚未被供应商受理；
-- consumed_at 与 invalidated_at 是互斥终态。过期行仍由查询时钟判无效，并可稍后清理。
CREATE TABLE auth_otp_challenges (
  id                   uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  channel              text        NOT NULL,
  purpose              text        NOT NULL,
  initiated_by_user_id uuid        REFERENCES users(id) ON DELETE CASCADE,
  target_digest        bytea       NOT NULL,
  code_digest          bytea       NOT NULL,
  attempt_count        smallint    NOT NULL DEFAULT 0,
  max_attempts         smallint    NOT NULL DEFAULT 5,
  created_at           timestamptz NOT NULL DEFAULT now(),
  activated_at         timestamptz,
  expires_at           timestamptz NOT NULL,
  consumed_at          timestamptz,
  invalidated_at       timestamptz,
  CONSTRAINT ck_auth_otp_channel_mvp CHECK (channel = 'email'),
  CONSTRAINT ck_auth_otp_purpose_mvp CHECK (purpose = 'login'),
  CONSTRAINT ck_auth_otp_actor_mvp CHECK (initiated_by_user_id IS NULL),
  CONSTRAINT ck_auth_otp_digest_length CHECK (
    octet_length(target_digest) = 32
    AND octet_length(code_digest) = 32
  ),
  CONSTRAINT ck_auth_otp_attempts CHECK (
    max_attempts = 5
    AND attempt_count BETWEEN 0 AND max_attempts
  ),
  CONSTRAINT ck_auth_otp_ttl CHECK (
    expires_at > created_at
    AND expires_at <= created_at + interval '5 minutes'
  ),
  CONSTRAINT ck_auth_otp_activation CHECK (
    activated_at IS NULL
    OR (activated_at >= created_at AND activated_at < expires_at)
  ),
  CONSTRAINT ck_auth_otp_consumption CHECK (
    consumed_at IS NULL
    OR (
      activated_at IS NOT NULL
      AND consumed_at >= activated_at
      AND consumed_at < expires_at
    )
  ),
  CONSTRAINT ck_auth_otp_invalidation CHECK (
    invalidated_at IS NULL OR invalidated_at >= created_at
  ),
  CONSTRAINT ck_auth_otp_terminal CHECK (
    NOT (consumed_at IS NOT NULL AND invalidated_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_auth_otp_unfinished_target
  ON auth_otp_challenges (channel, purpose, target_digest)
  WHERE activated_at IS NOT NULL
    AND consumed_at IS NULL
    AND invalidated_at IS NULL;
CREATE INDEX idx_auth_otp_target_recent
  ON auth_otp_challenges (channel, purpose, target_digest, created_at DESC);
CREATE INDEX idx_auth_otp_global_recent
  ON auth_otp_challenges (channel, created_at DESC);
CREATE INDEX idx_auth_otp_gc
  ON auth_otp_challenges (COALESCE(consumed_at, invalidated_at, expires_at));

-- 浏览器保存 s1. 前缀的随机会话原文；本表只保存完整 Cookie 值的 SHA-256 摘要。
CREATE TABLE auth_sessions (
  id               uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  user_id          uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_digest     bytea       NOT NULL UNIQUE,
  auth_method      text        NOT NULL,
  authenticated_at timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL DEFAULT now() + interval '7 days',
  revoked_at       timestamptz,
  CONSTRAINT ck_auth_session_method_mvp CHECK (auth_method = 'email_otp'),
  CONSTRAINT ck_auth_session_digest CHECK (octet_length(token_digest) = 32),
  CONSTRAINT ck_auth_session_ttl CHECK (
    expires_at = created_at + interval '7 days'
  ),
  CONSTRAINT ck_auth_session_revocation CHECK (
    revoked_at IS NULL OR revoked_at >= created_at
  )
);

CREATE INDEX idx_auth_sessions_user_live
  ON auth_sessions (user_id, expires_at DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_auth_sessions_gc
  ON auth_sessions (COALESCE(revoked_at, expires_at));

-- 认证审计只保存固定事件、固定结果、摘要和低敏枚举。details 只能为空，
-- 或只含一个 result 枚举；邮箱、验证码、Cookie、供应商标识和原始错误都没有存放位置。
CREATE TABLE auth_audit_events (
  id            uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  user_id       uuid        REFERENCES users(id) ON DELETE SET NULL,
  event_type    text        NOT NULL,
  outcome       text        NOT NULL,
  auth_method   text,
  target_digest bytea,
  session_id    uuid,
  trace_id      text        NOT NULL,
  details       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_auth_audit_event_mvp CHECK (event_type IN (
    'otp_requested', 'login_succeeded', 'login_failed', 'logout'
  )),
  CONSTRAINT ck_auth_audit_outcome CHECK (outcome IN ('success', 'failure', 'blocked')),
  CONSTRAINT ck_auth_audit_method_mvp CHECK (
    auth_method IS NULL OR auth_method = 'email_otp'
  ),
  CONSTRAINT ck_auth_audit_target_digest CHECK (
    target_digest IS NULL OR octet_length(target_digest) = 32
  ),
  CONSTRAINT ck_auth_audit_trace CHECK (
    char_length(trace_id) BETWEEN 1 AND 128
    AND trace_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT ck_auth_audit_details_mvp CHECK (
    CASE
      WHEN jsonb_typeof(details) = 'object' THEN
        (details - 'result') = '{}'::jsonb
        AND (
          NOT (details ? 'result')
          OR (
            jsonb_typeof(details -> 'result') = 'string'
            AND details ->> 'result' IN (
              'accepted',
              'permanent_rejection',
              'transient_failure',
              'configuration_failure',
              'invalid_or_expired',
              'attempts_exhausted',
              'account_disabled'
            )
          )
        )
      ELSE false
    END
  )
);

CREATE INDEX idx_auth_audit_user_recent
  ON auth_audit_events (user_id, created_at DESC);
CREATE INDEX idx_auth_audit_type_recent
  ON auth_audit_events (event_type, created_at DESC);
CREATE INDEX idx_auth_audit_target_recent
  ON auth_audit_events (target_digest, created_at DESC)
  WHERE target_digest IS NOT NULL;
