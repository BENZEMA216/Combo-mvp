-- 轮次表：轮次是自治任务且从头到尾只有一个写者；协调只用 status='running' 的 CAS 守卫。
-- 与 tasks 表的受保护写入纪律一致。消息按轮归组，历史只读 completed 轮，半截轮不可见。
CREATE TABLE turns (
  id          uuid        PRIMARY KEY,
  session_id  uuid        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status      text        NOT NULL
              CONSTRAINT ck_turns_status CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
  last_error  jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT uq_turns_id_session UNIQUE (id, session_id)
);
CREATE INDEX idx_turns_session ON turns (session_id, created_at);
CREATE INDEX idx_turns_running ON turns (created_at) WHERE status = 'running';

-- 工具产物关联产生它的 Turn；种子快照和旧数据允许为空。删除 Turn 必须同时清除其
-- Artifact，不能把失败轮产物置空后伪装成种子快照。复合外键同时禁止把其他 Session
-- 的 Turn 伪装成当前 Session 的产物来源。
ALTER TABLE artifacts ADD COLUMN turn_id uuid;
ALTER TABLE artifacts
  ADD CONSTRAINT fk_artifacts_turn_session
  FOREIGN KEY (turn_id, session_id)
  REFERENCES turns (id, session_id)
  ON DELETE CASCADE;
CREATE INDEX idx_artifacts_turn ON artifacts (turn_id) WHERE turn_id IS NOT NULL;

ALTER TABLE messages ADD COLUMN turn_id uuid;
ALTER TABLE messages
  ADD CONSTRAINT fk_messages_turn_session
  FOREIGN KEY (turn_id, session_id)
  REFERENCES turns (id, session_id);
ALTER TABLE messages ADD COLUMN idx int;
ALTER TABLE messages ALTER COLUMN seq DROP NOT NULL;
CREATE UNIQUE INDEX uq_messages_turn_idx ON messages (turn_id, idx) WHERE turn_id IS NOT NULL;
CREATE INDEX idx_messages_turn ON messages (turn_id) WHERE turn_id IS NOT NULL;
