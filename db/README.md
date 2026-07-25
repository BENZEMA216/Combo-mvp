# db PostgreSQL 迁移

这个目录是数据库结构的唯一真源。当前发布只接受这里固定的 `0000` 至 `0006` 完整迁移链，并从空数据库建立结构。大内容仍放在 MinIO，数据库只保存索引、状态、消息和对象键。

## 迁移文件

- `0000_baseline_schema.sql` 创建用户、上传任务、能力、试用会话、消息、产物和模型审计等基线结构，并提供 UUID v7 函数。
- `0001_expired_upload_reconciliation.sql` 增加过期上传状态，并为待过期和待清理记录建立部分索引。
- `0002_drop_stream_events.sql` 断言 PostgreSQL 中不存在旧事件表；事件回放只使用 Redis Stream，发现旧表时要求清空数据重建。
- `0003_turns.sql` 创建自治 Turn，让新 Message 使用 Turn 编号和轮内位置归组，并让 Artifact 可选关联同一 Session 中产生它的 Turn。
- `0004_studio_sessions.sql` 给 Session 增加普通运行与界面设计两种模式，并限制同一创作者和能力只有一个 active Studio Session。
- `0005_capability_current_ui.sql` 让 Capability 保存当前 Studio HTML Artifact 指针，新建普通 Session 可以复制当时的界面隔离副本。
- `0006_one_running_turn_per_session.sql` 先检查历史上是否存在同一 Session 的重复 running Turn。发现重复时迁移显式失败且不修改旧数据；没有重复时创建部分唯一索引 `uq_turns_session_running`，保证每个 Session 同时最多一个 running Turn。

迁移 Runner 要求文件从 `0000` 连续编号，并要求 `schema_migrations` 恰好是当前文件序列的前缀。未知文件、重复记录、跳号、旧迁移链、非空 schema 配空 ledger 或发布清单声明的迁移头不一致都会在执行新 SQL 前失败。执行器使用 PostgreSQL advisory lock 串行化迁移；每个文件仍使用独立数据库事务。因此 `0006` 的历史检查和索引创建处于同一个迁移事务中。

旧 Preview 的 `0000_extensions_and_helpers.sql` 至 `0018_studio_revisions_and_tests.sql` 属于另一条迁移链，Runner 会直接拒绝。当前发布不提供旧数据桥接、账本伪造或就地升级；环境必须清空业务数据后用本目录从 `0000` 重建。

## 主要表

- `users` 保存外部身份与角色映射。
- `tasks` 与 `uploads` 保存创作端上传和提取状态。
- `capabilities` 保存能力轻量索引、定义对象键和当前 Studio UI Artifact 指针。
- `sessions` 保存试用与 Studio 会话、owner 和模式。
- `turns` 保存一轮模型运行的状态、错误和时间。部分唯一索引限制单 Session 单运行轮次。
- `messages` 保存 Pi 原生分块消息。存量消息保留会话序号，新消息使用同一 Session 的 Turn 和轮内位置。
- `artifacts` 保存产物索引、可选来源 Turn，正文仍在 MinIO。来源 Turn 必须属于同一 Session；种子副本和既有 consume UI 允许没有来源 Turn。
- `audit_llm_calls` 保存模型调用审计信息。
- `schema_migrations` 记录已应用迁移。

沙箱工具不新增数据库表。临时 Pod 和 `/workspace` 不是持久化真源；Session、Turn、Message、Redis SSE 和 Artifact 继续使用现有存储。

## 读写关系

`users` 由 authoring 登录流程写入，Runtime 鉴权只读。`tasks`、`uploads` 和 `capabilities` 由 authoring 负责写入，其中 Runtime 只读取 Capability 索引和定义对象键。`sessions`、`turns`、`messages` 和 `artifacts` 由 Runtime 读写。`audit_llm_calls` 由 authoring 写入。

## 命令与测试

```sh
pnpm -F @cb/db migrate
MIGRATION_RUNS=2 EXPECTED_MIGRATION_HEAD=0006_one_running_turn_per_session.sql pnpm -F @cb/db migrate
pnpm -F @cb/db migrate:status
node --experimental-strip-types db/scripts/migrate.ts --head
pnpm -F @cb/db test
```

`scripts/integration/db-migrate.sh` 会在真实 PostgreSQL 中执行全部迁移，核对终态表、命名约束、用户唯一索引和 `uq_turns_session_running`。它还会在回滚事务中构造历史重复 running Turn，确认 `0006` 由显式检查失败且不遗留数据，最后再次执行迁移验证幂等。

`MIGRATION_RUNS` 缺省为 `1`，只接受精确值 `1` 或 `2`。Test 使用 `2` 时，Runner 在同一连接和 advisory lock 内重新读取并严格校验完整账本两次；第二遍不是跳过校验的成功捷径。
