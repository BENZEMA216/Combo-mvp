# 数据库契约测试

本目录验证迁移文件与数据库级不变量。

- `migrations.test.ts` 验证迁移编号顺序、基线业务表、任务状态、对象存储键、轮次结构、不可变 Agent Test Review、Release 复核绑定和 UUID v7 函数。它汇总读取全部迁移，防止旧业务表重新出现。
- `gen_uuid_v7.test.ts` 复刻 UUID v7 的字节打包逻辑，验证数据库函数使用正确的字节写入类型、版本位、变体位和时间顺序。
- `first_party_email_auth_migration.test.ts` 静态核对第一方邮件认证迁移的空库门禁、旧字段删除、角色限制、摘要约束、挑战索引、固定会话期限与审计约束。
- `application_database_roles.test.ts` 静态核对迁移所有者、authoring API、worker 与 runtime 的角色隔离，并确认认证写权限只授予 authoring API。
- `application-database-roles.pg.test.ts` 在显式启用并提供专用 PostgreSQL 与三份应用密码时，以三个真实角色分别登录，核对表级与列级权限，并实际执行充值、预留、结算、错误角色流水、失衡写入、账本防改和跨商户平台单号场景。
- `billing_migration.test.ts` 静态核对全局钱包、按 Agent 免费额度、usageId 与 Turn 幂等、充值双状态、查单调度、低敏回调、不可变资金流水和计费角色隔离。
- `provision-app-roles.test.ts` 核对角色密码必须完整成组提供，并确认密码只作为绑定值传给 PostgreSQL，不出现在 SQL 模板或错误中。
- `v2-migrate-runner.test.ts` 核对 V2 runner 只复用 canonical `0000` 至 `0011`，随后执行独立 `0012` 至 `0015`，兼容已部署账本，并在数据库迁移锁内快照 cluster-global 角色。
- `v2_billing_idempotency.test.ts` 锁定 `0015` 的充值/计量幂等域迁移与 rolling-writer 触发器、safe-number 约束、exact hold 复合外键、hold 不可变与 meter/settle 行锁顺序。
- `v2-role-restoration.pg.test.ts` 在真实 PostgreSQL 中故障注入，证明 V2 runner 的 NOLOGIN 与恢复处于同一 transaction，失败会回滚、其他连接看不到禁用状态，且既有角色密码哈希不变。
- `v2-billing-idempotency-upgrade.pg.test.ts` 从真实 `0014` 账本升级到 `0015`，验证旧充值/计量 writer 兼容、append-only 恢复、unsafe 钱包和错 scope 历史数据整笔回滚。
- `provision-v2-app-roles.test.ts` 核对 V2 的五角色密码必须完整成组提供，且密码只作为绑定值进入 PostgreSQL。
- `application-database-v2-roles.pg.test.ts` 在显式启用的独立 V2 PostgreSQL 数据库中，以五个真实角色登录并验证 V2 身份、钱包、hold 终态、流水与计量的表级/列级最小权限。
- `project_agent_shares_migration.test.ts` 核对不可变 Git Project manifest、三十二字节公开定位符、owner-scoped 幂等约束和 Authoring 只读取/追加的最小权限。
- `project_history_agent_flow_migration.test.ts` 核对 typed Draft、digest-only 一次性确认、不可变 share、owner-scoped 幂等和 API 最小权限。

真实 PostgreSQL 的迁移执行、重复运行和非空门禁由 `scripts/integration/db-migrate.sh` 负责。该脚本还会执行会清理 OAuth 测试表的 DCR 契约，因此只接受无 query/fragment 的 loopback 临时数据库：GitHub Actions 自动获准，本地必须额外设置 `COMBO_ALLOW_DESTRUCTIVE_INTEGRATION_DB=1`，共享、Test 与生产数据库一律拒绝。应用角色测试还会核对充值与使用计费隔离和资金流水只追加；它只有在 `APPLICATION_ROLE_PG_TEST=1`、`DATABASE_URL` 和三项 `POSTGRES_*_PASSWORD` 都存在时运行。独立 V2 链由 `scripts/integration/db-migrate-v2.sh` 验证，不复用正式数据库。
