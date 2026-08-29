-- 0013 · 远程 MCP OAuth 2.1 授权边界。
--
-- 动态客户端元数据可以公开读取；授权请求、授权码、访问令牌和刷新令牌只保存摘要或
-- 完成授权所需的低敏元数据。浏览器会话仍由 auth_sessions 管理，MCP 永不保存或转发 Cookie。

CREATE TABLE oauth_clients (
  client_id                  text        PRIMARY KEY
                             CONSTRAINT ck_oauth_clients_id
                             CHECK (client_id ~ '^mcp_client_[A-Za-z0-9_-]{43}$'),
  registration_digest        bytea       NOT NULL UNIQUE
                             CONSTRAINT ck_oauth_clients_registration_digest
                             CHECK (octet_length(registration_digest) = 32),
  client_name                text        NOT NULL
                             CONSTRAINT ck_oauth_clients_name_length
                             CHECK (length(client_name) BETWEEN 1 AND 120),
  redirect_uris              text[]      NOT NULL
                             CONSTRAINT ck_oauth_clients_redirect_count
                             CHECK (cardinality(redirect_uris) BETWEEN 1 AND 8),
  grant_types                text[]      NOT NULL DEFAULT ARRAY['authorization_code', 'refresh_token']::text[]
                             CONSTRAINT ck_oauth_clients_grants
                             CHECK (grant_types = ARRAY['authorization_code', 'refresh_token']::text[]),
  response_types             text[]      NOT NULL DEFAULT ARRAY['code']::text[]
                             CONSTRAINT ck_oauth_clients_responses
                             CHECK (response_types = ARRAY['code']::text[]),
  token_endpoint_auth_method text        NOT NULL DEFAULT 'none'
                             CONSTRAINT ck_oauth_clients_public
                             CHECK (token_endpoint_auth_method = 'none'),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  last_used_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_oauth_clients_last_used CHECK (last_used_at >= created_at)
);
CREATE INDEX idx_oauth_clients_last_used ON oauth_clients (last_used_at, client_id);

CREATE TABLE oauth_authorization_requests (
  request_digest  bytea       PRIMARY KEY
                  CONSTRAINT ck_oauth_authorization_request_digest
                  CHECK (octet_length(request_digest) = 32),
  client_id       text        NOT NULL REFERENCES oauth_clients(client_id),
  redirect_uri    text        NOT NULL,
  state           text        NOT NULL
                  CONSTRAINT ck_oauth_authorization_request_state
                  CHECK (length(state) BETWEEN 1 AND 1024),
  scope           text        NOT NULL
                  CONSTRAINT ck_oauth_authorization_request_scope
                  CHECK (scope IN ('combo.agent:read', 'combo.agent:read combo.agent:write')),
  resource_uri    text        NOT NULL,
  code_challenge  char(43)    NOT NULL
                  CONSTRAINT ck_oauth_authorization_request_challenge
                  CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  CONSTRAINT ck_oauth_authorization_request_expiry CHECK (expires_at > created_at)
);
CREATE INDEX idx_oauth_authorization_requests_expiry
  ON oauth_authorization_requests (expires_at)
  WHERE consumed_at IS NULL;
CREATE INDEX idx_oauth_authorization_requests_client
  ON oauth_authorization_requests (client_id);

CREATE TABLE oauth_authorization_codes (
  code_digest     bytea       PRIMARY KEY
                  CONSTRAINT ck_oauth_authorization_code_digest
                  CHECK (octet_length(code_digest) = 32),
  client_id       text        NOT NULL REFERENCES oauth_clients(client_id),
  owner_user_id   uuid        NOT NULL REFERENCES users(id),
  redirect_uri    text        NOT NULL,
  scope           text        NOT NULL
                  CONSTRAINT ck_oauth_authorization_code_scope
                  CHECK (scope IN ('combo.agent:read', 'combo.agent:read combo.agent:write')),
  resource_uri    text        NOT NULL,
  code_challenge  char(43)    NOT NULL
                  CONSTRAINT ck_oauth_authorization_code_challenge
                  CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  CONSTRAINT ck_oauth_authorization_code_expiry CHECK (expires_at > created_at)
);
CREATE INDEX idx_oauth_authorization_codes_expiry
  ON oauth_authorization_codes (expires_at)
  WHERE used_at IS NULL;
CREATE INDEX idx_oauth_authorization_codes_client
  ON oauth_authorization_codes (client_id);

CREATE TABLE oauth_access_tokens (
  token_digest    bytea       PRIMARY KEY
                  CONSTRAINT ck_oauth_access_token_digest
                  CHECK (octet_length(token_digest) = 32),
  client_id       text        NOT NULL REFERENCES oauth_clients(client_id),
  owner_user_id   uuid        NOT NULL REFERENCES users(id),
  family_id       uuid        NOT NULL,
  scope           text        NOT NULL
                  CONSTRAINT ck_oauth_access_token_scope
                  CHECK (scope IN ('combo.agent:read', 'combo.agent:read combo.agent:write')),
  resource_uri    text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  CONSTRAINT ck_oauth_access_token_expiry CHECK (expires_at > created_at)
);
CREATE INDEX idx_oauth_access_tokens_expiry
  ON oauth_access_tokens (expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_oauth_access_tokens_client ON oauth_access_tokens (client_id);

CREATE TABLE oauth_refresh_tokens (
  token_digest    bytea       PRIMARY KEY
                  CONSTRAINT ck_oauth_refresh_token_digest
                  CHECK (octet_length(token_digest) = 32),
  client_id       text        NOT NULL REFERENCES oauth_clients(client_id),
  owner_user_id   uuid        NOT NULL REFERENCES users(id),
  family_id       uuid        NOT NULL,
  parent_digest   bytea
                  CONSTRAINT ck_oauth_refresh_parent_digest
                  CHECK (parent_digest IS NULL OR octet_length(parent_digest) = 32),
  scope           text        NOT NULL
                  CONSTRAINT ck_oauth_refresh_token_scope
                  CHECK (scope IN ('combo.agent:read', 'combo.agent:read combo.agent:write')),
  resource_uri    text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  revoked_at      timestamptz,
  CONSTRAINT ck_oauth_refresh_token_expiry CHECK (expires_at > created_at)
);
CREATE INDEX idx_oauth_refresh_tokens_expiry
  ON oauth_refresh_tokens (expires_at)
  WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX idx_oauth_refresh_tokens_client ON oauth_refresh_tokens (client_id);
CREATE INDEX idx_oauth_refresh_tokens_family
  ON oauth_refresh_tokens (family_id, created_at DESC);
CREATE INDEX idx_oauth_access_tokens_family
  ON oauth_access_tokens (family_id, created_at DESC);

-- 公网 DCR 只能经此入口写 oauth_clients。canonical digest 让 Codex 重启或本机回调端口
-- 变化时复用同一个 public client；全局 advisory lock 把“复用 / 容量恢复 / 计数 / 插入”
-- 串成一个数据库临界区，因此多副本并发也绝不会越过 4096 行。
--
-- 满额时只回收超过 10 分钟、最近也未被使用、且对四类 OAuth 状态均无引用的最旧 client。
-- 新注册宽限期和仍在授权/令牌链上的 client 都受保护；没有安全候选时 fail closed。
CREATE FUNCTION register_oauth_client(
  requested_client_id text,
  requested_registration_digest bytea,
  requested_client_name text,
  requested_redirect_uris text[],
  requested_grant_types text[],
  requested_response_types text[],
  requested_token_endpoint_auth_method text
)
RETURNS TABLE (
  registration_status text,
  client_id text,
  client_name text,
  redirect_uris text[],
  grant_types text[],
  response_types text[],
  token_endpoint_auth_method text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  client_row public.oauth_clients%ROWTYPE;
  client_count bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('combo.oauth.dcr.capacity.v1', 0));

  UPDATE public.oauth_clients AS c
     SET redirect_uris = requested_redirect_uris,
         last_used_at = now()
   WHERE c.registration_digest = requested_registration_digest
  RETURNING c.* INTO client_row;
  IF FOUND THEN
    registration_status := 'registered';
    client_id := client_row.client_id;
    client_name := client_row.client_name;
    redirect_uris := client_row.redirect_uris;
    grant_types := client_row.grant_types;
    response_types := client_row.response_types;
    token_endpoint_auth_method := client_row.token_endpoint_auth_method;
    created_at := client_row.created_at;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT count(*) INTO client_count FROM public.oauth_clients;
  IF client_count >= 4096 THEN
    WITH victim AS (
      SELECT candidate.client_id
        FROM public.oauth_clients AS candidate
       WHERE candidate.created_at <= now() - interval '10 minutes'
         AND candidate.last_used_at <= now() - interval '10 minutes'
         AND NOT EXISTS (
           SELECT 1 FROM public.oauth_authorization_requests AS request
            WHERE request.client_id = candidate.client_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM public.oauth_authorization_codes AS code
            WHERE code.client_id = candidate.client_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM public.oauth_access_tokens AS access
            WHERE access.client_id = candidate.client_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM public.oauth_refresh_tokens AS refresh
            WHERE refresh.client_id = candidate.client_id
         )
       ORDER BY candidate.last_used_at, candidate.created_at, candidate.client_id
       LIMIT 1
       FOR UPDATE OF candidate SKIP LOCKED
    )
    DELETE FROM public.oauth_clients AS target
     USING victim
     WHERE target.client_id = victim.client_id
       AND target.created_at <= now() - interval '10 minutes'
       AND target.last_used_at <= now() - interval '10 minutes'
       AND NOT EXISTS (
         SELECT 1 FROM public.oauth_authorization_requests AS request
          WHERE request.client_id = target.client_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.oauth_authorization_codes AS code
          WHERE code.client_id = target.client_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.oauth_access_tokens AS access
          WHERE access.client_id = target.client_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.oauth_refresh_tokens AS refresh
          WHERE refresh.client_id = target.client_id
       );
    IF NOT FOUND THEN
      registration_status := 'capacity_exceeded';
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.oauth_clients
    (client_id, registration_digest, client_name, redirect_uris, grant_types,
     response_types, token_endpoint_auth_method)
  VALUES
    (requested_client_id, requested_registration_digest, requested_client_name,
     requested_redirect_uris, requested_grant_types, requested_response_types,
     requested_token_endpoint_auth_method)
  RETURNING oauth_clients.* INTO client_row;

  registration_status := 'registered';
  client_id := client_row.client_id;
  client_name := client_row.client_name;
  redirect_uris := client_row.redirect_uris;
  grant_types := client_row.grant_types;
  response_types := client_row.response_types;
  token_endpoint_auth_method := client_row.token_endpoint_auth_method;
  created_at := client_row.created_at;
  RETURN NEXT;
END
$$;

-- API 没有表级 DELETE。这个 SECURITY DEFINER 入口只允许删除已经终止的 OAuth 临时记录，
-- 且每张表每次最多 100 行；未过期的 used refresh token 必须保留以检测重放。
CREATE FUNCTION cleanup_expired_oauth_artifacts(batch_size integer)
RETURNS TABLE (
  authorization_requests_deleted integer,
  authorization_codes_deleted integer,
  access_tokens_deleted integer,
  refresh_tokens_deleted integer,
  clients_deleted integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  bounded_limit integer := LEAST(GREATEST(COALESCE(batch_size, 1), 1), 100);
BEGIN
  WITH doomed AS (
    SELECT request_digest
      FROM public.oauth_authorization_requests
     WHERE expires_at <= now() OR consumed_at IS NOT NULL
     ORDER BY expires_at, request_digest
     LIMIT bounded_limit
  )
  DELETE FROM public.oauth_authorization_requests target
   USING doomed
   WHERE target.request_digest = doomed.request_digest;
  GET DIAGNOSTICS authorization_requests_deleted = ROW_COUNT;

  WITH doomed AS (
    SELECT code_digest
      FROM public.oauth_authorization_codes
     WHERE expires_at <= now() OR used_at IS NOT NULL
     ORDER BY expires_at, code_digest
     LIMIT bounded_limit
  )
  DELETE FROM public.oauth_authorization_codes target
   USING doomed
   WHERE target.code_digest = doomed.code_digest;
  GET DIAGNOSTICS authorization_codes_deleted = ROW_COUNT;

  WITH doomed AS (
    SELECT token_digest
      FROM public.oauth_access_tokens
     WHERE expires_at <= now() OR revoked_at IS NOT NULL
     ORDER BY expires_at, token_digest
     LIMIT bounded_limit
  )
  DELETE FROM public.oauth_access_tokens target
   USING doomed
   WHERE target.token_digest = doomed.token_digest;
  GET DIAGNOSTICS access_tokens_deleted = ROW_COUNT;

  WITH doomed AS (
    SELECT token_digest
      FROM public.oauth_refresh_tokens
     WHERE expires_at <= now() OR revoked_at IS NOT NULL
     ORDER BY expires_at, token_digest
     LIMIT bounded_limit
  )
  DELETE FROM public.oauth_refresh_tokens target
   USING doomed
   WHERE target.token_digest = doomed.token_digest;
  GET DIAGNOSTICS refresh_tokens_deleted = ROW_COUNT;

  -- 长期不活跃且已无任何状态引用的动态 client 才能被正常生命周期清理。
  WITH doomed AS (
    SELECT client.client_id
      FROM public.oauth_clients AS client
     WHERE client.last_used_at <= now() - interval '30 days'
       AND NOT EXISTS (
         SELECT 1 FROM public.oauth_authorization_requests AS request
          WHERE request.client_id = client.client_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.oauth_authorization_codes AS code
          WHERE code.client_id = client.client_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.oauth_access_tokens AS access
          WHERE access.client_id = client.client_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.oauth_refresh_tokens AS refresh
          WHERE refresh.client_id = client.client_id
       )
     ORDER BY client.last_used_at, client.client_id
     LIMIT bounded_limit
     FOR UPDATE OF client SKIP LOCKED
  )
  DELETE FROM public.oauth_clients target
   USING doomed
   WHERE target.client_id = doomed.client_id
     AND target.last_used_at <= now() - interval '30 days';
  GET DIAGNOSTICS clients_deleted = ROW_COUNT;

  RETURN NEXT;
END
$$;

REVOKE ALL PRIVILEGES ON
  oauth_clients,
  oauth_authorization_requests,
  oauth_authorization_codes,
  oauth_access_tokens,
  oauth_refresh_tokens
FROM PUBLIC, combo_api, combo_worker, combo_runtime;

GRANT SELECT ON oauth_clients TO combo_api;
GRANT UPDATE (last_used_at) ON oauth_clients TO combo_api;

GRANT SELECT, INSERT ON
  oauth_authorization_requests,
  oauth_authorization_codes,
  oauth_access_tokens,
  oauth_refresh_tokens
TO combo_api;
GRANT UPDATE (consumed_at) ON oauth_authorization_requests TO combo_api;
GRANT UPDATE (used_at) ON oauth_authorization_codes TO combo_api;
GRANT UPDATE (revoked_at) ON oauth_access_tokens TO combo_api;
GRANT UPDATE (used_at, revoked_at) ON oauth_refresh_tokens TO combo_api;

REVOKE ALL PRIVILEGES ON FUNCTION cleanup_expired_oauth_artifacts(integer)
FROM PUBLIC, combo_api, combo_worker, combo_runtime;
GRANT EXECUTE ON FUNCTION cleanup_expired_oauth_artifacts(integer) TO combo_api;

REVOKE ALL PRIVILEGES ON FUNCTION register_oauth_client(text, bytea, text, text[], text[], text[], text)
FROM PUBLIC, combo_api, combo_worker, combo_runtime;
GRANT EXECUTE ON FUNCTION register_oauth_client(text, bytea, text, text[], text[], text[], text)
TO combo_api;

-- Runtime 只验证 Authoring 经集群内 HTTP 头转发的 MCP access token；不能读取客户端、授权请求、
-- 授权码或 refresh token，也不能修改 access token。
GRANT SELECT ON oauth_access_tokens TO combo_runtime;
