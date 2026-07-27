-- 0005 · capability 当前 Miniapp UI 指针。
--
-- Studio 产出的主 HTML 仍按 session artifact 保存；capabilities 只保留当前指针。
-- 新建普通运行会话时，Runtime 会把指针所指内容复制成会话内快照：新会话拿最新 UI，
-- 已经开始的旧会话不随之后的设计修改漂移。Studio 被归档后，新 Studio 也可由此恢复页面。

ALTER TABLE capabilities
  ADD COLUMN ui_artifact_id uuid REFERENCES artifacts(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX uq_capabilities_ui_artifact
  ON capabilities (ui_artifact_id)
  WHERE ui_artifact_id IS NOT NULL;
