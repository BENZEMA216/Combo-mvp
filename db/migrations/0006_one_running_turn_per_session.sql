-- 同一会话最多一个 running 轮次。迁移先显式拒绝历史重复，不猜测应终止哪一轮，
-- 随后由迁移 runner 在同一事务中创建部分唯一索引。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM turns
     WHERE status = 'running'
     GROUP BY session_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'cannot create uq_turns_session_running: duplicate running turns exist'
      USING ERRCODE = 'P0001';
  END IF;
END
$$;

CREATE UNIQUE INDEX uq_turns_session_running
  ON turns (session_id)
  WHERE status = 'running';
