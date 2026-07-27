-- 0000 · 基线 schema（2026-07-04 重设计）。
--   设计真源：飞书文档「Combo 数据库表设计」。
--   三层各管一种生命周期：流水线层管「一次上传任务」（tasks/uploads），能力层管「一个能力项」
--   （capabilities），试用层管「一次对话」（sessions/messages/artifacts）。
--   大内容一律不进库：上传原始件、能力项可运行定义、对话产物都存 MinIO，库里只留索引和状态。
--   本基线为全新重建（旧 29 表结构与开发数据不迁移，见 git 历史）；今后变更新增迁移文件。

-- ===================== 扩展与 UUID v7 生成器（主键用 UUID v7，时间有序）=====================
-- gen_uuid_v7()：PG 内置无 v7（PG18 才有 uuidv7()），此处提供 SQL 兜底实现，跨版本可用。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION gen_uuid_v7() RETURNS uuid AS $$
DECLARE
  unix_ts_ms bigint;
  uuid_bytes bytea;
BEGIN
  unix_ts_ms := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  -- 16 随机字节起底，再覆盖前 48 位为毫秒时间戳，写入 version(7) 与 variant(10) 位。
  -- 所有 set_byte 的 byte 值显式 ::int（bigint 位运算结果不转 int 会找不到函数签名）。
  uuid_bytes := gen_random_bytes(16);
  uuid_bytes := set_byte(uuid_bytes, 0, (((unix_ts_ms >> 40) & 255))::int);
  uuid_bytes := set_byte(uuid_bytes, 1, (((unix_ts_ms >> 32) & 255))::int);
  uuid_bytes := set_byte(uuid_bytes, 2, (((unix_ts_ms >> 24) & 255))::int);
  uuid_bytes := set_byte(uuid_bytes, 3, (((unix_ts_ms >> 16) & 255))::int);
  uuid_bytes := set_byte(uuid_bytes, 4, (((unix_ts_ms >> 8) & 255))::int);
  uuid_bytes := set_byte(uuid_bytes, 5, ((unix_ts_ms & 255))::int);
  uuid_bytes := set_byte(uuid_bytes, 6, (((get_byte(uuid_bytes, 6) & 15) | 112))::int);
  uuid_bytes := set_byte(uuid_bytes, 8, (((get_byte(uuid_bytes, 8) & 63) | 128))::int);
  RETURN encode(uuid_bytes, 'hex')::uuid;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- ===================== 身份层：users =====================
-- 认证与权限的唯一真源，全库所有「归属」都指向它。试用会话身份也是它（创作者本人），无匿名身份。

CREATE TABLE users (
  id            uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  logto_user_id text        NOT NULL UNIQUE,          -- 外部认证服务里的用户 id，登录时对应过来
  account       text        NOT NULL,                 -- 登录账号名，忽略大小写全局唯一（下方部分索引）
  email         text,                                 -- 邮箱，可空
  roles         text[]      NOT NULL DEFAULT '{creator}', -- 角色数组，权限模型扩展时加值
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX uq_users_account_lower ON users (lower(account));

-- ===================== 流水线层：tasks / uploads =====================
-- tasks：一次上传任务的聚合根 + 异步流水线台账。两轴状态（current_step + status）正交，
--   提取成功即终态；「发布」不在这个轴上（是能力项上的标记）。所有状态变更收归统一 transition 入口。
-- uploads：与 task 一对一的源数据明细。上传唯一路径是「配对上传」（本机助手凭配对码分片传输），
--   分片凑齐自动流转提取。脱敏是合规硬要求，原始件处理完按期清除并留档。

CREATE TABLE tasks (
  id               uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  owner_user_id    uuid        NOT NULL REFERENCES users(id),  -- 任务归属人
  current_step     text        NOT NULL DEFAULT 'upload'
                   CONSTRAINT ck_tasks_step CHECK (current_step IN ('upload', 'extract')),
  status           text        NOT NULL DEFAULT 'running'
                   CONSTRAINT ck_tasks_status CHECK (status IN ('running', 'succeeded', 'failed')),
  description      text,                              -- 用户可见的任务描述
  meta             jsonb       NOT NULL DEFAULT '{}'::jsonb, -- 任务级元信息（来源/统计），结构随需要演进
  retry_count      int         NOT NULL DEFAULT 0,    -- 当前步骤已重试次数，成功后清零
  last_error       jsonb,                             -- 最后一次失败的错误信息（内部码 + 人话）
  lease_owner      text,                              -- 当前认领的 worker 标识（配合分布式锁防双跑）
  lease_expires_at timestamptz,                       -- 租约到期时间，过期即可被接管
  idempotency_key  text        NOT NULL UNIQUE,       -- 建任务幂等键：双击/网络重试不建出第二个任务
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_tasks_owner ON tasks (owner_user_id, created_at DESC);
-- worker 取活：未终态且无有效租约的任务。
CREATE INDEX idx_tasks_claimable ON tasks (lease_expires_at) WHERE status = 'running';

CREATE TABLE uploads (
  task_id           uuid        PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, -- 一任务一行
  storage_key       text,                             -- 收齐后的原始件在 MinIO 里的对象键（收齐前为空）
  status            text        NOT NULL DEFAULT 'pending'
                    CONSTRAINT ck_uploads_status CHECK (status IN ('pending', 'raw', 'processed')),
                    -- pending 等待助手分片上传；raw 分片收齐未处理；processed 已脱敏切分完成
  pairing_code_hash text        NOT NULL,             -- 配对码哈希（不存明文），助手凭码上传
  pairing_expires_at timestamptz NOT NULL,            -- 配对码过期时间
  parts             jsonb       NOT NULL DEFAULT '{}'::jsonb, -- 分片登记表：声明清单与已落地分片对账，凑齐才流转
  raw_purged_at     timestamptz,                      -- 原始件清除时间（合规留档：非空表示源文件已删）
  meta              jsonb       NOT NULL DEFAULT '{}'::jsonb, -- 上传元信息（大小/格式/消息条数等统计）
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ===================== 能力层：capabilities =====================
-- 提取产出的、可直接试用的可运行体，一次任务产出多个，是全库枢纽：发布标记在它身上，试用会话引用它。
-- 库里只存轻量索引，完整可运行定义在 MinIO（storage_key）。发布是针对单项的标记动作，与 Task 状态无关。

CREATE TABLE capabilities (
  id            uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  task_id       uuid        NOT NULL REFERENCES tasks(id),   -- 提取自哪次任务（来源可追溯到任务级）
  owner_user_id uuid        NOT NULL REFERENCES users(id),   -- 冗余自 task 归属人，权限查询不回联
  name          text        NOT NULL,                        -- 能力项名称，展示用
  summary       text        NOT NULL DEFAULT '',             -- 一句话简介，展示用
  kind          text        NOT NULL DEFAULT '',             -- 能力类型（写作/结构化文档等），展示与筛选用
  storage_key   text        NOT NULL,                        -- 完整可运行定义在 MinIO 里的对象键，试用时加载注入 agent
  published     boolean     NOT NULL DEFAULT false,          -- 发布标记，用户对单项执行发布动作时置 true
  published_at  timestamptz,                                 -- 发布时间
  share_token   text        UNIQUE,                          -- 分享令牌，发布时生成，对外访问用
  meta          jsonb       NOT NULL DEFAULT '{}'::jsonb,    -- 能力项元信息（提取置信度/统计等）
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_capabilities_task  ON capabilities (task_id);
CREATE INDEX idx_capabilities_owner ON capabilities (owner_user_id, created_at DESC);

-- ===================== 试用层：sessions / messages / artifacts =====================
-- messages 是对话定稿（Agent 原生格式，渲染与重建 agent 状态共用一份），
-- 流式事件只保存在 Redis；artifacts 是交互产物（内容在 MinIO）。

CREATE TABLE sessions (
  id            uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  capability_id uuid        NOT NULL REFERENCES capabilities(id), -- 试用的是哪个能力项
  owner_user_id uuid        NOT NULL REFERENCES users(id),        -- 会话属于哪个用户（创作者本人）
  title         text,                                             -- 会话标题，可由首轮对话自动生成
  status        text        NOT NULL DEFAULT 'active'
                CONSTRAINT ck_sessions_status CHECK (status IN ('active', 'closed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_owner ON sessions (owner_user_id, updated_at DESC);
CREATE INDEX idx_sessions_capability ON sessions (capability_id);

CREATE TABLE messages (
  id         uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  session_id uuid        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq        int         NOT NULL,                    -- 会话内序号，决定消息顺序
  role       text        NOT NULL
             CONSTRAINT ck_messages_role CHECK (role IN ('user', 'assistant', 'tool')),
  content    jsonb       NOT NULL,                    -- 分块内容（Agent 原生格式：文本/工具调用/工具结果块数组），写入必须过 schema 校验
  status     text        NOT NULL DEFAULT 'completed'
             CONSTRAINT ck_messages_status CHECK (status IN ('completed', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_messages_session_seq UNIQUE (session_id, seq)
);

CREATE TABLE artifacts (
  id         uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  session_id uuid        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id uuid        REFERENCES messages(id),     -- 产出它的那条消息，可空
  kind       text        NOT NULL,                    -- 产物类型（html/markdown/代码等）
  title      text,                                    -- 产物标题，展示用
  storage_key text       NOT NULL,                    -- 产物内容在 MinIO 里的对象键（大内容不进库）
  meta       jsonb       NOT NULL DEFAULT '{}'::jsonb, -- 轻量元信息（语言/尺寸等）
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_artifacts_session ON artifacts (session_id);

-- ===================== LLM 成本审计：audit_llm_calls（保留项）=====================
-- 每次调用大模型记一行，统计 token 与费用；只做审计不是计费真源。job_id 改为 task_id（松引用，不设 FK）。

CREATE TABLE audit_llm_calls (
  id                uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  owner_user_id     uuid        REFERENCES users(id),
  task_id           uuid,                             -- 归属任务，松引用（任务删除不影响审计留存）
  task_class        text        NOT NULL,             -- 哪个环节调的模型（extract / trial 等）
  model             text,
  prompt_tokens     int         NOT NULL DEFAULT 0,
  completion_tokens int         NOT NULL DEFAULT 0,
  cost_micros       bigint      NOT NULL DEFAULT 0,
  degraded          boolean     NOT NULL DEFAULT false, -- 是否发生了降级
  retries           int         NOT NULL DEFAULT 0,
  trace_id          text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_llm_owner_day ON audit_llm_calls (owner_user_id, created_at);
