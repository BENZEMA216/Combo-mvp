-- 事件日志只允许存在于 Redis Stream。当前链从空库建立；若发现旧 PostgreSQL
-- stream_events，必须清空测试数据后重建，不能由本迁移静默桥接或删除旧模型。
DO $$
BEGIN
  IF to_regclass('public.stream_events') IS NOT NULL THEN
    RAISE EXCEPTION
      'legacy PostgreSQL stream_events table detected; rebuild from an empty database';
  END IF;
END
$$;
