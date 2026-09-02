# V2 验证数据库迁移

本目录只服务 `combo-v2` 独立验证数据库，不属于 Test、Preview、Production 使用的正式迁移链。

V2 的有效迁移序列由 `db/migrations/0000` 至 `0011` 的稳定公共前缀，加上本目录的 `0012` 至 `0015` 组成。`migrate-v2.ts` 负责组装并校验这条序列；正式 `migrate.ts` 永远只读取 `db/migrations`。`0015` 保留既有金额与业务事实，只在同一事务内把旧充值幂等键迁入独立域，并为计量事件补充幂等键、exact hold scope、安全整数边界、rolling-writer 兼容触发器和并发顺序保护。

`combo_v2` 已使用这些精确文件名记录 `schema_migrations`，因此已经执行的文件不得改名或改写。后续 V2 验证结构只能在本目录继续追加编号。
