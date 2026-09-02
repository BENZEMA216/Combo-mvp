# db PostgreSQL 迁移

这个目录是数据库结构的唯一真源。当前迁移链从 `0000` 连续到 `0019`，共 20 个 SQL；已经发布的 `0000` 至 `0019` 文件名与字节保持原样，新结构只通过后续迁移追加。所有环境都从空业务数据建立当前结构，不提供旧身份或旧 Preview 数据桥接。

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
- `0010_recharge_qr_channel.sql` 把扫码充值通道从聚合码 `aggregate_qr` 重命名为 C扫B 单渠道 `qr`（`/v3/prepay`），并把历史 `aggregate_qr` 订单一并迁移到 `qr`。
- `0011_recharge_qr_only.sql` 移除 H5「手机收银台」渠道，把历史 `h5` 订单迁到 `qr`，并把支付方式约束收窄为只允许 `qr`。
- `0012_agent_builder_v1.sql` 创建 Agent Project、不可变 Revision、真实 Runtime Test 和不可变 Release，给 Session 增加 Revision/Release 固定指针，并用复合外键、带过期租约的 Test 启动状态机和发布 Trigger 保证测试与发布引用同一份 Runtime Bundle 和 UI。它还为 Codex 直接 UI 保存建立 Session 内幂等唯一索引。Test 的 Turn、首条 Message 与 `starting → running` 在同一个事务提交，崩溃遗留的纯启动 claim 可安全接管，不会重复执行模型。
- `0013_external_mcp_oauth.sql` 保存公开动态客户端元数据、短期授权事务、一次性 PKCE 授权码以及摘要化的访问令牌和轮换刷新令牌。授权页只用现有 `auth_sessions` 确认浏览器身份，任何 OAuth 表都不保存 Cookie 或令牌原文。
- `0014_agent_test_reviews.sql` 创建不可变 Agent Test 质量复核，要求 normal、boundary 与 failure 三类案例分别保存执行终态和质量结论。例外接受必须保存理由、影响、复核用户和时间；新 Release 必须冻结同一 Test 的可发布复核 ID 与摘要，迁移前 Release 的复核字段保持为空并继续可读。
- `0015_project_agent_shares.sql` 创建不可变 Project Agent 分享。每行冻结一份 Git Project manifest、owner 和创建幂等事实，并通过三十二字节随机的公开定位符读取；它不保存仓库文件、会话、凭据或环境变量值。
- `0016_project_history_agent_flow.sql` 追加 strict typed Project-history Draft、由数据库 wall clock 原子签发且只存
  摘要的五分钟单次确认、带完整 canonical JSON 摘要的不可变/不过期/不可撤回 public-by-link Agent Package
  share，以及仅能有界清理已消费或已过期 confirmation 的受控函数。
- `0017_agent_package_registry.sql` 创建 canonical `agent_packages` commit marker 与 immutable `agent_package_releases`，以 exact Package digest 作为唯一内容身份。
- `0018_agent_session_usage_receipts.sql` 为受控 Test Agent Session 冻结 exact Release/Package 和 Knowledge resource 快照，并追加 immutable terminal usage receipt。
- `0019_pending_usage_recovery.sql` 为 402 尚未 admission 的请求追加 server-authoritative pending recovery、price snapshot、recharge intent 和单调 terminal closure。

`0012` 至 `0019` 是 live Test 已发布的 forward-only 兼容链。Test 若需回退应用，后续回退提交仍必须保留这些迁移源、账本前缀和 `0019_pending_usage_recovery.sql` expected head；不得部署不识别 live `0019` ledger 的旧镜像，也不得删除或改写已应用的表。本 79f 系页面候选携带 `0017`–`0019` 是 deployment compatibility 修复，不表示它激活了后续 Registry、receipt 或 recovery 业务 API。

`project_agent_shares` 独立冻结可公开读取的 Git Project manifest，不进入 Agent Runtime 模型。

`users` 是业务主体真源。`tasks` 与 `uploads` 保存创作流水线状态。`capabilities` 保存能力索引、定义对象键和当前 UI 指针。`agent_projects` 只保存创作 Head 与当前 Release 两个可变指针，`agent_revisions`、`agent_tests`、`agent_test_reviews` 与 `agent_releases` 冻结 Runtime Bundle、UI 摘要、技术执行和人工质量结论；Test 还冻结输出契约与幂等请求摘要。`sessions` 用 Project/Revision/Release 三个不可变指针区分共享同一 entry Capability 的 Agent，`turns`、`messages` 与 `artifacts` 保存运行和 Studio 状态；大内容仍在 MinIO。认证表只保存规范身份以及验证码、目标和 Cookie 的摘要，不保存验证码、Cookie 或供应商令牌原文。计费表把用户全局钱包与每个 entry Capability 的免费额度分开，使用记录绑定唯一 Turn；Project/Revision/Release 的归因由该 Turn 关联的不可变 Session 指针提供。V1 中复用同一 entry Capability 的多个 Project 共享免费额度；若要按 Project 独立计费，必须追加新迁移扩展账本主体。充值订单把外部支付状态与内部入账状态分开，资金流水只允许追加。

## 认证与权限

`0007` 在改变 `users` 前取得排他锁，并在发现任何用户时以 SQLSTATE `55000` 整体失败。它把账号限制为 `creator-` 加八位小写 Base32，把角色限制为唯一的 `creator`，将会话期限固定为七天，并允许显式撤销。该迁移不读取、转换或恢复旧身份。

`combo_api` 可以读写认证表、任务、上传、能力和模型审计，并获得充值订单、支付尝试、回调、钱包可用余额与充值流水所需的最小表级和列级权限。`combo_worker` 只能处理任务、上传、能力和模型审计，不能读取认证或计费表。`combo_runtime` 只读 `users` 与 `auth_sessions`，读写 Session、Turn、Message 与 Artifact；它只获得 `capabilities.ui_artifact_id` 的列级更新权限，以及免费额度、钱包预留、使用记录和使用流水所需的计费权限。`combo_api` 与 `combo_runtime` 都只能查询和追加资金流水，不能修改、删除或清空既有流水；API 只能追加充值入账，Runtime 只能追加使用扣款。

`0012` 让 `combo_api` 管理 Agent Project、追加 Revision 与 Release，并只读 Runtime Test 证据；`combo_runtime` 只读 Project、Revision 与 Release，并创建和收口 Runtime Test。`combo_worker` 不获得 Agent Builder 聚合表权限。

`0013` 让 `combo_api` SELECT OAuth 五表并 INSERT 四类授权/令牌状态；client 只能经 `register_oauth_client` 注册函数写入，API 没有直接 INSERT/DELETE 权限，只能更新 client 的 `last_used_at`、授权请求的 `consumed_at`、授权码/refresh token 的 `used_at` 和 access/refresh token 的 `revoked_at`。注册函数在数据库锁内执行 canonical digest 去重、4096 硬容量、十分钟安全淘汰宽限与无引用检查；清理函数对每类状态最多删除 100 行，并只清理超过三十天且无引用的 client。`combo_runtime` 只能读取 access-token 摘要，用于验证 Authoring 在内存中转发到集群内 Studio/Test 委托路由的同一凭据，不能读取客户端、授权请求、授权码或 refresh token，也不能修改 access token；`combo_worker` 不获得任何 OAuth 权限。

`0014` 让 `combo_api` 只读技术 Test 并追加质量复核，让 `combo_runtime` 只读复核以在 Test 读取和恢复列表中计算 `qualityStatus` 与 `canPublish`。两个角色都不能更新或删除复核，worker 不获得复核表权限。Authoring 创建 Release 时还会在同一事务内重新检查技术 Test、质量复核和当前 Head，数据库 Trigger 再独立复验同一组不可变身份。

计费约束在事务提交时强制验证 `可用余额 + 预留余额 = 不可变流水净额`、钱包预留与运行中使用记录一致、免费计数与免费使用记录一致，并双向核对成功充值/完成扣费与其唯一流水。应用不能只改余额或终态，也不能只伪造一条外观合法的流水。乐收赢付款时间属于外部秒级时钟，不与数据库订单创建时间硬比较；内部 `credited_at` 仍使用数据库时间。

迁移容器使用数据库所有者连接。`0008` 先用 `NOLOGIN` 建立并收紧角色；全部迁移和账本复验成功后，Runner 才通过绑定参数设置三份独立密码并启用登录。密码不进入 SQL 文件、迁移账本、命令参数或日志。

## Runner 与验证

Runner 要求迁移文件从 `0000` 连续编号，并要求 `schema_migrations` 恰好是源文件序列的前缀。未知文件、重复记录、跳号、旧迁移链、非空 schema 配空 ledger 或发布清单声明的迁移头不一致都会在执行新 SQL 前失败。Runner 使用 PostgreSQL advisory lock；每个迁移和对应记账位于同一事务。

```sh
pnpm -F @cb/db migrate
MIGRATION_RUNS=2 EXPECTED_MIGRATION_HEAD=0019_pending_usage_recovery.sql pnpm -F @cb/db migrate
pnpm -F @cb/db migrate:status
node --experimental-strip-types db/scripts/migrate.ts --head
pnpm -F @cb/db test
```

`MIGRATION_RUNS=2` 会在同一连接与 advisory lock 内重新读取并严格验证完整账本。真实 PostgreSQL 集成还必须证明同一 production image 能从空库执行至 `0019`、对已到 `0019` 的账本再次幂等执行、`0007` 非空用户门禁、计费约束和三个应用角色的正负权限。
