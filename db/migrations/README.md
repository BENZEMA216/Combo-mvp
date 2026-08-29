# 数据库迁移

本目录按文件名字典序保存 PostgreSQL 迁移。已应用的迁移不可修改，新增结构必须通过新的迁移文件演进。

`0000_baseline_schema.sql` 建立当前基线。`0001_expired_upload_reconciliation.sql` 增加上传超时查询索引，`0002_drop_stream_events.sql` 拒绝旧 PostgreSQL 事件表，`0003_turns.sql` 增加自治轮次与轮内消息顺序。`0004_studio_sessions.sql`、`0005_capability_current_ui.sql` 和 `0006_one_running_turn_per_session.sql` 保存 Goal B 已发布的 Studio、current UI 与 Turn fencing 结构。

`0007_first_party_email_auth.sql` 至 `0011_recharge_qr_only.sql` 建立第一方认证、应用角色、计费与二维码充值当前结构。`0012_agent_builder_v1.sql`、`0013_external_mcp_oauth.sql`、`0014_agent_test_reviews.sql` 与 `0015_project_agent_shares.sql` 是 Test 已应用的逐字节兼容前缀；它们保留旧 Agent Builder、外部 MCP OAuth、Test Review 与 Project Agent Share schema，但不表示当前应用激活这些旧协议。已经执行的迁移不可修改，新结构从 `0016` 连续追加编号；四个兼容文件的 SHA-256 由 `live_migration_prefix.test.ts` 固定。

`0012` 中的 `agent_releases` 属于旧 Revision 与 Runtime Bundle 模型，不是当前 Agent Package 的 `AgentPackageRelease` 真源。新的 Agent Package、知识 Agent、分享或计费实现不得复用这些旧表作为产品真相。

`0016_agent_package_registry.sql` 独立创建 canonical `agent_packages` 与 `agent_package_releases`。Package 行本身是对象提交成功后的不可变数据库 marker，`package_digest` 是唯一身份和读取选择器；该行不保存对象键、Manifest、知识 Bundle 摘要或 latest 指针。Release 使用严格协议和 `controlled_test` 范围，只通过 exact digest 与 owner 组合外键指向 canonical Package，并保留供后续 Session 锁定的 Release 与 Package 唯一组合。

`0017_agent_session_usage_receipts.sql` 是 expand-only 的 Session/usage 审计切片。旧行与旧 writer 继续得到 `legacy_capability`；新的 `knowledge_agent_test` Session 必须在 INSERT 时冻结 canonical `(release_id, package_digest)`、`controlled_test` 范围与固定 `skills/knowledge/references/knowledge-bundle.json` 的 digest，且不能同时使用 `0012` 的旧 Agent pins。resource digest 仅是 exact Package 内固定文件的审计快照，不能独立用于 fetch。

知识 usage charge 重复相同冻结绑定，并保存规范化 billing/validator policy 与 terminal outcome。终态 charge 在提交时必须和对应 Turn 及唯一 append-only `agent_usage_receipts` 同步：answered 才能 completed；insufficient evidence、failed 与 interrupted 都必须 released，failed/interrupted 结算为零；reserved 没有 outcome 或 receipt。receipt 固定 Test execution environment、与 source SHA 严格相等的 Runtime Release ID，以及最多 32 个唯一、canonical 排序的 Knowledge Bundle chunk IDs。chunk ID 依赖 frozen Package + fixed resource 才间接绑定内容，不能作为独立跨 Package selector。本层保存不可变数据库行与响应/Package/resource/Runtime 快照，不定义尚无共享 canonical serializer 的 receipt digest。

Registry 当前仅支持单一可信、固定 controlled-Test publisher 的 first-writer 模型；digest 不是 publisher 身份或授权证明。Session/receipt 不接收独立 publisher 字段，Runtime/consumers 对 Registry 保持只读，未来多 publisher 必须先建立显式 owner claim/authorization 合同。
