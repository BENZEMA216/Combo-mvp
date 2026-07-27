-- 0004 · 将普通 Agent 试用与 Miniapp 设计会话分流。
--
-- 已有会话全部视为 consume；Studio 对同一 owner + capability 只保留一个 active 会话，
-- 这样“编辑 UI”可以幂等回到原来的对话、产物与修改上下文，而不会每次点击都建空会话。

ALTER TABLE sessions
  ADD COLUMN mode text NOT NULL DEFAULT 'consume'
  CONSTRAINT ck_sessions_mode CHECK (mode IN ('consume', 'studio'));

CREATE UNIQUE INDEX uq_sessions_active_studio_owner_capability
  ON sessions (owner_user_id, capability_id)
  WHERE status = 'active' AND mode = 'studio';

CREATE INDEX idx_sessions_owner_mode
  ON sessions (owner_user_id, mode, updated_at DESC)
  WHERE status = 'active';
