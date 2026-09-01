# 数据库契约测试

本目录验证迁移文件与数据库级不变量。

- `migrations.test.ts` 验证迁移编号顺序、基线业务表、任务状态、对象存储键、轮次结构、UUID v7 函数和 Test 兼容前缀的完整表集合。它将 `0012` 至 `0016` 的旧 Agent、OAuth 与 Project-history 表视为迁移兼容结构，不把它们当成当前 Agent Package 产品模型。
- `gen_uuid_v7.test.ts` 复刻 UUID v7 的字节打包逻辑，验证数据库函数使用正确的字节写入类型、版本位、变体位和时间顺序。
- `first_party_email_auth_migration.test.ts` 静态核对第一方邮件认证迁移的空库门禁、旧字段删除、角色限制、摘要约束、挑战索引、固定会话期限与审计约束。
- `application_database_roles.test.ts` 静态核对迁移所有者、authoring API、worker 与 runtime 的角色隔离，并确认认证写权限只授予 authoring API。
- `application-database-roles.pg.test.ts` 在显式启用并提供专用 PostgreSQL 与三份应用密码时，以三个真实角色分别登录，核对表级、列级与受控函数权限，并实际执行充值、预留、结算、错误角色流水、失衡写入、账本防改和跨商户平台单号场景。
- `billing_migration.test.ts` 静态核对全局钱包、按 Agent 免费额度、usageId 与 Turn 幂等、充值双状态、查单调度、低敏回调、不可变资金流水和计费角色隔离。
- `provision-app-roles.test.ts` 核对角色密码必须完整成组提供，并确认密码只作为绑定值传给 PostgreSQL，不出现在 SQL 模板或错误中。
- `project_history_agent_flow_migration.test.ts` 核对旧 Project-history Draft、digest-only 一次性 confirmation、不可变 share、owner-scoped 幂等和 API 最小权限。
- `live_migration_prefix.test.ts` 固定 Test 已应用的 `0012` 至 `0016` 文件名、顺序与逐字节 SHA-256，防止部署镜像与常驻 ledger 失配，同时允许新迁移从 `0017` 继续追加。
- `agent-package-registry-migration.test.ts` 静态锁定 canonical Package digest、严格 Release、owner 组合外键、不可变触发器和最小角色权限，并拒绝旧 `agent_releases` 依赖或第二 Package 身份。
- `agent-package-registry.pg.test.ts` 在显式 PostgreSQL 16 集成中真实执行 Package 与 Release 插入、约束失败、owner 绑定、幂等冲突、所有者防改和 Runtime/worker/PUBLIC 权限边界；全部数据位于回滚事务中。
- `agent-session-receipts-migration.test.ts` 静态锁定 0018 的 rolling-safe legacy 默认、knowledge 全字段冻结、旧 Agent pin 排他、canonical policies、终态映射、authoritative charge 解析、Session→Turn→charge 显式锁序、append-only receipt 和列级 Runtime 权限。
- `agent-session-receipts.pg.test.ts` 在真实 PostgreSQL 16 上验证 legacy 兼容、绑定排他、四种终态、validator 失败码、SQL NULL fail-closed、Runtime Release/source SHA 等式与 citation 上限/唯一/排序。
- `agent-session-response-message.pg.test.ts` 在真实 PostgreSQL 16 上验证 receipt 必须绑定同 Turn 唯一 completed assistant Message、无消息/wrong role/status/Turn/多 assistant 拒绝、response FK 引用索引、引用后 Message 防改、authoritative charge scope 与并发 replay。
- `agent-session-receipts-roles.pg.test.ts` 以真实 API/worker/Runtime 登录角色核对 receipt 表级与列级权限、DB-generated `id/created_at`、trigger function 禁止直接执行及 Registry 写入边界。
- `agent-session-receipts-upgrade.pg.test.ts` 创建并安全销毁独立 PostgreSQL 16 数据库，先执行到 exact Registry 0017、写入已提交的 completed/reserved legacy 行，再应用 receipts 0018，验证默认兼容、约束已 VALIDATE、空 receipt 集合和 ledger 幂等计划。
- `pending-usage-recovery-migration.test.ts` 静态锁定 0019 的 expand-only 表、最长七天活动期限、终态清正文、单向订单外键、无跨服务锁触发器与 Runtime/API 窄权限。
- `pending-usage-recovery.pg.test.ts` 在真实 PostgreSQL 16 上验证 exact Session/Package/价格快照、初始 intent、每 Session 单 active、终态后释放新 pending 槽位、过期拒绝、terminal 不可复活、accepted 的 completed/answered/settled receipt、abandoned 的无 admission 或 released/nonanswered receipt，以及订单恢复金额必须匹配价格快照且绑定不可改写。
- `pending-usage-recovery-roles.pg.test.ts` 以真实 API/worker/Runtime 角色核对 Runtime insert/终态、正文隔离、Runtime 与订单隔离、`PUBLIC` ACL，并让两个 API 连接按相同 owner+usage advisory lock、pending row lock、CAS、订单 INSERT 的完整顺序竞争同一 active intent，证明只有胜者能提交恢复订单。
- `pending-usage-recovery-upgrade.pg.test.ts` 创建并安全销毁独立 PostgreSQL 16 数据库，先执行到 exact receipts 0018 并写入旧充值订单，再只应用 0019，验证旧订单 `recovery_usage_id` 保持 `NULL`、新表为空、约束已验证和 ledger 幂等计划。

真实 PostgreSQL 的迁移执行、重复运行和非空门禁由 `scripts/integration/db-migrate.sh` 负责。该脚本显式运行 Registry、0018 receipt、0019 pending recovery、Registry 0017→receipts 0018 与 receipts 0018→pending recovery 0019 upgrade 测试。应用角色测试还会核对充值与使用计费隔离和资金流水只追加；它只有在 `APPLICATION_ROLE_PG_TEST=1`、`DATABASE_URL` 和三项 `POSTGRES_*_PASSWORD` 都存在时运行。
