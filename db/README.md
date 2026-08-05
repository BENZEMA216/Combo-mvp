# db PostgreSQL 迁移

这个目录是数据库结构的唯一真源。当前迁移链从 `0000` 连续到 `0010`，已经发布的 `0000` 至 `0006` 保持原样；第一方邮箱认证、应用数据库角色、共享 Agent 计费和 Agent Builder 聚合层只通过后续迁移追加。所有环境都从空业务数据建立当前结构，不提供旧身份或旧 Preview 数据桥接。

## 迁移文件

- `0000_baseline_schema.sql` 创建用户、任务、上传、能力、会话、消息、产物和模型审计基线，并提供 UUID v7 函数。
- `0001_expired_upload_reconciliation.sql` 增加上传过期状态和清理索引。
- `0002_drop_stream_events.sql` 拒绝旧 PostgreSQL 事件表；运行事件与回放只使用 Redis Stream。
- `0003_turns.sql` 创建自治 Turn，并让 Message 与 Artifact 关联同一 Session 内的来源 Turn。
- `0004_studio_sessions.sql` 增加 consume 与 studio 两种 Session 模式，并限制同一 owner 和 Capability 只有一个 active Studio Session。
- `0005_capability_current_ui.sql` 增加 `capabilities.ui_artifact_id`，保存当前 Studio UI Artifact 指针。
- `0006_one_running_turn_per_session.sql` 拒绝历史重复 running Turn，再建立单 Session 单运行 Turn 的部分唯一索引。
- `0007_first_party_email_auth.sql` 只允许空用户库切换到第一方邮箱验证码，删除旧外部身份列，并创建身份、挑战、不透明会话和低敏认证审计表。
- `0008_application_database_roles.sql` 创建 API、worker 与 runtime 三个无登录角色，撤销默认权限并按当前业务职责授予最小权限。
- `0009_billing.sql` 创建全局钱包、按用户与 Agent 隔离的免费额度、使用预留、充值订单、支付尝试、低敏回调事件和不可变资金流水，并补充计费最小权限。
- `0010_agent_builder_v1.sql` 创建 Agent Project、不可变 Revision、真实 Runtime Test 和不可变 Release，给 Session 增加 Revision/Release 固定指针，并用复合外键、带过期租约的 Test 启动状态机和发布 Trigger 保证测试与发布引用同一份 Runtime Bundle 和 UI。它还为 Codex 直接 UI 保存建立 Session 内幂等唯一索引。Test 的 Turn、首条 Message 与 `starting → running` 在同一个事务提交，崩溃遗留的纯启动 claim 可安全接管，不会重复执行模型。

`users` 是业务主体真源。`tasks` 与 `uploads` 保存创作流水线状态。`capabilities` 保存能力索引、定义对象键和当前 UI 指针。`agent_projects` 只保存创作 Head 与当前 Release 两个可变指针，`agent_revisions`、`agent_tests` 与 `agent_releases` 冻结 Runtime Bundle、UI 摘要和验证关系；Test 还冻结输出契约与幂等请求摘要。`sessions` 用 Project/Revision/Release 三个不可变指针区分共享同一 entry Capability 的 Agent，`turns`、`messages` 与 `artifacts` 保存运行和 Studio 状态；大内容仍在 MinIO。认证表只保存规范身份以及验证码、目标和 Cookie 的摘要，不保存验证码、Cookie 或供应商令牌原文。计费表把用户全局钱包与每个 Agent 的免费额度分开，使用记录绑定唯一 Turn，充值订单把外部支付状态与内部入账状态分开，资金流水只允许追加。

## 认证与权限

`0007` 在改变 `users` 前取得排他锁，并在发现任何用户时以 SQLSTATE `55000` 整体失败。它把账号限制为 `creator-` 加八位小写 Base32，把角色限制为唯一的 `creator`，将会话期限固定为七天，并允许显式撤销。该迁移不读取、转换或恢复旧身份。

`combo_api` 可以读写认证表、任务、上传、能力和模型审计，并获得充值订单、支付尝试、回调、钱包可用余额与充值流水所需的最小表级和列级权限。`combo_worker` 只能处理任务、上传、能力和模型审计，不能读取认证或计费表。`combo_runtime` 只读 `users` 与 `auth_sessions`，读写 Session、Turn、Message 与 Artifact；它只获得 `capabilities.ui_artifact_id` 的列级更新权限，以及免费额度、钱包预留、使用记录和使用流水所需的计费权限。`combo_api` 与 `combo_runtime` 都只能查询和追加资金流水，不能修改、删除或清空既有流水；API 只能追加充值入账，Runtime 只能追加使用扣款。

计费约束在事务提交时强制验证 `可用余额 + 预留余额 = 不可变流水净额`、钱包预留与运行中使用记录一致、免费计数与免费使用记录一致，并双向核对成功充值/完成扣费与其唯一流水。应用不能只改余额或终态，也不能只伪造一条外观合法的流水。乐收赢付款时间属于外部秒级时钟，不与数据库订单创建时间硬比较；内部 `credited_at` 仍使用数据库时间。

迁移容器使用数据库所有者连接。`0008` 先用 `NOLOGIN` 建立并收紧角色；全部迁移和账本复验成功后，Runner 才通过绑定参数设置三份独立密码并启用登录。密码不进入 SQL 文件、迁移账本、命令参数或日志。

## Runner 与验证

Runner 要求迁移文件从 `0000` 连续编号，并要求 `schema_migrations` 恰好是源文件序列的前缀。未知文件、重复记录、跳号、旧迁移链、非空 schema 配空 ledger 或发布清单声明的迁移头不一致都会在执行新 SQL 前失败。Runner 使用 PostgreSQL advisory lock；每个迁移和对应记账位于同一事务。

```sh
pnpm -F @cb/db migrate
MIGRATION_RUNS=2 EXPECTED_MIGRATION_HEAD=0010_agent_builder_v1.sql pnpm -F @cb/db migrate
pnpm -F @cb/db migrate:status
node --experimental-strip-types db/scripts/migrate.ts --head
pnpm -F @cb/db test
```

`MIGRATION_RUNS=2` 会在同一连接与 advisory lock 内重新读取并严格验证完整账本。真实 PostgreSQL 集成还必须证明空库执行、第二次幂等、`0007` 非空用户门禁、计费约束和三个应用角色的正负权限。
