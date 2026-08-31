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

真实 PostgreSQL 的迁移执行、重复运行和非空门禁由 `scripts/integration/db-migrate.sh` 负责。Registry 测试由该脚本在 PostgreSQL 16 上以 `AGENT_PACKAGE_REGISTRY_PG_TEST=1` 显式运行。应用角色测试还会核对充值与使用计费隔离和资金流水只追加；它只有在 `APPLICATION_ROLE_PG_TEST=1`、`DATABASE_URL` 和三项 `POSTGRES_*_PASSWORD` 都存在时运行。
