# db PostgreSQL 迁移

这个目录是数据库结构的唯一真源。当前迁移链从 `0000` 连续到 `0018`。Test 常驻数据库已经记录 `0012` 至 `0016`，因此这五个文件按原文件名和精确字节恢复为不可变兼容前缀；canonical Agent Package Registry 只由后置的 `0017` 定义，受控 Test 的知识 Agent Session 与用量收据由 `0018` 追加。

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
- `0012_agent_builder_v1.sql` 至 `0016_project_history_agent_flow.sql` 恢复 Test 已应用的旧 Agent Builder、外部 MCP OAuth、Test Review、Project Agent Share 与 Project-history Agent flow 结构。
- `0017_agent_package_registry.sql` 创建 canonical `agent_packages` commit marker 与 `agent_package_releases`。Package digest 是唯一 Package 身份和读取选择器；Release 只绑定 exact Package、同一 owner 与当前 `controlled_test` 范围。
- `0018_agent_session_usage_receipts.sql` 为知识 Agent Session 冻结 exact `release_id + package_digest` 与固定 Knowledge Bundle 资源快照，把同一绑定和规范政策 ID 复制到 usage charge，并为每个终态知识 charge 创建一条不可变 receipt。旧 Session 与 charge 保持 `legacy_capability` 默认值，滚动期间的旧 Runtime 写入无需提供新字段。

这五个迁移只用于保持源码迁移前缀与 Test 的 `schema_migrations` 账本兼容，不表示当前应用已经激活对应旧业务协议。尤其是 `0012` 创建的 `agent_releases` 属于旧 Revision 与 Runtime Bundle 模型，`0016` 创建的 Project-history Draft、confirmation 与 share 也属于旧流程；它们都不是 [PROJECT.md](../PROJECT.md) 定义的 `AgentPackageRelease` 真源。新的 Agent Package、知识 Agent、分享或计费能力不得把这些旧表复用为产品真相；所需新结构必须从 `0017` 追加，并显式绑定 exact Package digest 与 Release 合同。

`0018` 的 `knowledge_agent_test` Session 只能是 `consume + combo.agent-package-capability/2 + controlled_test`，必须在 INSERT 时一次性绑定 canonical `agent_package_releases` 的 exact Release/Package 组合，并拒绝同时携带 `0012` 的旧 Project/Revision/Release pins。资源路径固定为 `skills/knowledge/references/knowledge-bundle.json`；`knowledge_resource_digest` 只是该 exact Package 内固定文件的审计快照，不能脱离 Release/Package 作为独立 fetch selector。绑定创建后，普通 DML 即使由迁移 owner 发起也不能改写。

当前 Registry 是单一可信、固定 controlled-Test publisher 的 first-writer 模型：Package digest 证明内容身份，不证明发布者身份或授权；publisher 只能从不可变 Release 关系推导，Session/receipt 不接受调用方独立声明 publisher。Runtime 与 consumers 对 Registry 只有解析所需的只读权限，不能注册 Package 或 Release；多 publisher 授权不在本迁移范围。

终态知识 charge 与 Turn、权威 response Message、receipt 必须在同一事务闭合：`answered` 对应 completed Turn/charge，`insufficient_evidence` 对应 completed Turn + released charge，两者都必须绑定同 Session/Turn 唯一的 completed assistant Message；`failed`/`interrupted` 对应同名 Turn + released charge且不绑定 response，失败与中断结算恒为零；reserved charge 没有 completed assistant response、outcome 或 receipt。insufficient receipt 不带 citations，interrupted 的 validator code 只能是 `not_run`；failed 可记录平台拒绝、不可用或协议错误但不能产生扣费。receipt 还固定 `execution_environment=test`、`runtime_release_id=release-<runtime_source_sha>` 与非全零 40 位 source SHA，不额外声明没有共享 canonical serializer 支持的“密码学 receipt digest”。

`response_message_id` 通过 `(id, session_id, turn_id)` exact FK 绑定现有 Message，并在 receipt 产生后禁止该 Message 更新或删除。`response_digest` 是 Runtime 对该 Message 中最终 answer exact UTF-8 文本计算的 SHA-256；Runtime/API 读取时必须复验。数据库不把可变的 JSON block 表示擅自当作 canonical response serializer。

回答最多暴露 32 个 `chunk.knowledge.<id>` 引用，必须唯一并按 canonical 顺序保存。chunk ID 只有和 receipt 中冻结的 exact Package、固定 resource path 及 resource digest 一起解释，才间接绑定到实际内容；它本身不是跨 Package 的内容选择器。

`users` 是业务主体真源。`tasks` 与 `uploads` 保存创作流水线状态。`capabilities` 保存能力索引、定义对象键和当前 UI 指针。`sessions`、`turns`、`messages` 与 `artifacts` 保存试用和 Studio 状态；大内容仍在 MinIO。认证表只保存规范身份以及验证码、目标和 Cookie 的摘要，不保存验证码、Cookie 或供应商令牌原文。计费表把用户全局钱包与每个 Agent 的免费额度分开，使用记录绑定唯一 Turn，充值订单把外部支付状态与内部入账状态分开，资金流水只允许追加。

## 认证与权限

`0007` 在改变 `users` 前取得排他锁，并在发现任何用户时以 SQLSTATE `55000` 整体失败。它把账号限制为 `creator-` 加八位小写 Base32，把角色限制为唯一的 `creator`，将会话期限固定为七天，并允许显式撤销。该迁移不读取、转换或恢复旧身份。

`combo_api` 可以读写认证表、任务、上传、能力和模型审计，并获得充值订单、支付尝试、回调、钱包可用余额与充值流水所需的最小表级和列级权限。`combo_worker` 只能处理任务、上传、能力和模型审计，不能读取认证或计费表。`combo_runtime` 只读 `users` 与 `auth_sessions`，读写 Session、Turn、Message 与 Artifact；它只获得 `capabilities.ui_artifact_id` 的列级更新权限，以及免费额度、钱包预留、使用记录和使用流水所需的计费权限。`combo_api` 与 `combo_runtime` 都只能查询和追加资金流水，不能修改、删除或清空既有流水；API 只能追加充值入账，Runtime 只能追加使用扣款。

`0012` 至 `0016` 还保留这些迁移发布时授予应用角色的历史权限，以保证已部署 schema 可复现。当前服务不得据此推断旧 Agent、OAuth 或 Project-history 路径处于活动状态。

`0017` 只允许 `combo_api` 查询和追加 canonical Package marker 与 Release。`combo_runtime` 只能按列读取解析 Release 和校验 Package 所需的 owner、digest、协议与受控 Test 范围，看不到幂等键、请求摘要或时间字段；`combo_worker` 与 `PUBLIC` 没有权限。两张表对迁移所有者也拒绝更新、删除和清空。

`0018` 只让 `combo_runtime` 读取 receipt，并按列追加业务快照；receipt `id` 和 `created_at` 只能由数据库生成，Runtime 没有 receipt UPDATE/DELETE/TRUNCATE 权限。当前用户会话详情由 Runtime 服务提供，因此 `combo_api` 不需要 receipt SELECT；`combo_worker` 与 `PUBLIC` 保持零权限。所有 0018 trigger function 都撤销直接 EXECUTE，触发器仍以调用者权限执行约束。

计费约束在事务提交时强制验证 `可用余额 + 预留余额 = 不可变流水净额`、钱包预留与运行中使用记录一致、免费计数与免费使用记录一致，并双向核对成功充值/完成扣费与其唯一流水。应用不能只改余额或终态，也不能只伪造一条外观合法的流水。乐收赢付款时间属于外部秒级时钟，不与数据库订单创建时间硬比较；内部 `credited_at` 仍使用数据库时间。

迁移容器使用数据库所有者连接。`0008` 先用 `NOLOGIN` 建立并收紧角色；全部迁移和账本复验成功后，Runner 才通过绑定参数设置三份独立密码并启用登录。密码不进入 SQL 文件、迁移账本、命令参数或日志。

## Runner 与验证

Runner 要求迁移文件从 `0000` 连续编号，并要求 `schema_migrations` 恰好是源文件序列的前缀。未知文件、重复记录、跳号、旧迁移链、非空 schema 配空 ledger 或发布清单声明的迁移头不一致都会在执行新 SQL 前失败。Runner 使用 PostgreSQL advisory lock；每个迁移和对应记账位于同一事务。

```sh
pnpm -F @cb/db migrate
MIGRATION_RUNS=2 EXPECTED_MIGRATION_HEAD=0018_agent_session_usage_receipts.sql pnpm -F @cb/db migrate
pnpm -F @cb/db migrate:status
node --experimental-strip-types db/scripts/migrate.ts --head
pnpm -F @cb/db test
```

`MIGRATION_RUNS=2` 会在同一连接与 advisory lock 内重新读取并严格验证完整账本。真实 PostgreSQL 集成还必须证明空库执行至 `0018`、从 live `0016` 账本先有 Registry `0017` 后只追加 receipts `0018`、第二次幂等、`0007` 非空用户门禁、计费约束和三个应用角色的正负权限。
