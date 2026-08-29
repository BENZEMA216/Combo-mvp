# 数据库迁移

本目录按文件名字典序保存 PostgreSQL 迁移。已应用的迁移不可修改，新增结构必须通过新的迁移文件演进。

`0000_baseline_schema.sql` 建立当前基线。`0001_expired_upload_reconciliation.sql` 增加上传超时查询索引，`0002_drop_stream_events.sql` 拒绝旧 PostgreSQL 事件表，`0003_turns.sql` 增加自治轮次与轮内消息顺序。`0004_studio_sessions.sql`、`0005_capability_current_ui.sql` 和 `0006_one_running_turn_per_session.sql` 保存 Goal B 已发布的 Studio、current UI 与 Turn fencing 结构。

`0007_first_party_email_auth.sql` 至 `0011_recharge_qr_only.sql` 建立第一方认证、应用角色、计费与二维码充值当前结构。`0012_agent_builder_v1.sql`、`0013_external_mcp_oauth.sql`、`0014_agent_test_reviews.sql` 与 `0015_project_agent_shares.sql` 是 Test 已应用的逐字节兼容前缀；它们保留旧 Agent Builder、外部 MCP OAuth、Test Review 与 Project Agent Share schema，但不表示当前应用激活这些旧协议。已经执行的迁移不可修改，新结构必须从 `0016` 继续追加编号；四个兼容文件的 SHA-256 由 `live_migration_prefix.test.ts` 固定。

`0012` 中的 `agent_releases` 属于旧 Revision 与 Runtime Bundle 模型，不是当前 Agent Package 的 `AgentPackageRelease` 真源。新的 Agent Package、知识 Agent、分享或计费实现不得复用这些旧表作为产品真相。

`0016_agent_package_registry.sql` 独立创建 canonical `agent_packages` 与 `agent_package_releases`。Package 行本身是对象提交成功后的不可变数据库 marker，`package_digest` 是唯一身份和读取选择器；该行不保存对象键、Manifest、知识 Bundle 摘要或 latest 指针。Release 使用严格协议和 `controlled_test` 范围，只通过 exact digest 与 owner 组合外键指向 canonical Package，并保留供后续 Session 锁定的 Release 与 Package 唯一组合。
