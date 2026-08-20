# 数据库契约测试

本目录验证迁移文件与数据库级不变量。

- `migrations.test.ts` 验证迁移编号顺序、基线业务表、任务状态、对象存储键、轮次结构和 UUID v7 函数。它汇总读取全部迁移，防止旧业务表重新出现。
- `gen_uuid_v7.test.ts` 复刻 UUID v7 的字节打包逻辑，验证数据库函数使用正确的字节写入类型、版本位、变体位和时间顺序。
- `first_party_email_auth_migration.test.ts` 静态核对第一方邮件认证迁移的空库门禁、旧字段删除、角色限制、摘要约束、挑战索引、固定会话期限与审计约束。
- `application_database_roles.test.ts` 静态核对迁移所有者、authoring API、worker 与 runtime 的角色隔离，并确认认证写权限只授予 authoring API。
- `application-database-roles.pg.test.ts` 在显式启用并提供专用 PostgreSQL 与三份应用密码时，以三个真实角色分别登录，核对表级与列级权限，并实际执行充值、预留、结算、错误角色流水、失衡写入、账本防改和跨商户平台单号场景。
- `billing_migration.test.ts` 静态核对全局钱包、按 Agent 免费额度、usageId 与 Turn 幂等、充值双状态、查单调度、低敏回调、不可变资金流水和计费角色隔离。
- `creator-hosted-agent-vnext-migration.test.ts` 静态核对 VNext 的 13 张权威表、不可变 Snapshot/Version、租户复合外键、单 Lease/WIP、消息 AEAD、Event 顺序、Outbox、强制 RLS 和三个专用服务角色。
- `creator-agent-consumer-open-ready-migration.test.ts` 静态核对 `0014` 的 Consumer-only role、OPENING + normalized open command、immutable ready receipt、窄 definer 和 application-role bypass fence。
- `creator-agent-consumer-message-accept-migration.test.ts` 静态核对 `0022` 的 Consumer-only full-accept wrapper、数据库生成 Invocation/Event/Outbox ID 与 deadline、private admission core、exact caller guards 和零直接 DML。
- `creator-agent-consumer-message-accept.pg.test.ts` 是迁移头精确停在 `0022` 时的历史 direct-login `combo_agent_consumer_api` 证据，证明旧 full-accept 原子链、并发 replay/conflict、最小 ACL 和 failpoint 回滚；它不得在最终迁移头上运行。PR 的 R3 门禁会在一次性集群的专用子库运行它，Main 最终态 CI 只保留静态 `0022` 合同与下述 `0030` 撤权实证。
- `creator-agent-consumer-message-v1-decommission.pg.test.ts` 在最终 `0030` 真实 PostgreSQL 上证明 Consumer 的旧 v1 full-accept 已撤权、v2 preflight/finalize 仍可执行且角色保持零直接 DML；PR/Main CI 运行这一最终态门禁。
- `creator-agent-event-integrity-migration.test.ts` 静态核对 `0023` 的迁移锁与 zero-legacy fail-closed 门、单次 `invocation.reconciling_resumed` 事件、低敏 append-only/FORCE-RLS integrity alert 表，以及只向 exact Reconciler session 开放的 tenant-bound definer。它不证明完整 Event fold、projection digest parity 或冲突路径已经接线。
- `creator-agent-reconciliation-source-admission-migration.test.ts` 静态核对 `0024` 的global logical-source锁与归一化唯一索引、跨RLS full-field classifier、fresh/exact/security-blocked固定outcome、DB-owned canonical digest、alert definer复用及旧explicit-root writer cutover。真实并发、跨tenant、rollback与commit-after-alert语义仍由CloudJournal PostgreSQL suite证明。
- `creator-agent-prepared-fact-admission-migration.test.ts` 静态核对`0025`的Broker-only prepared fact authority、数据库JCS digest parity、global source与Invocation phase classifier、fresh PERSISTED/Event/prepare ACK、低敏alert及旧Broker direct writer cutover。Gateway receipt/revoke纵向语义由Gateway真实PostgreSQL suite证明。
- `creator-agent-started-fact-admission-migration.test.ts` 静态核对`0026`的started专属component列与zero-legacy门、DB JCS digest、global source/phase classifier、RUNNING/RECONCILING/Event/root/ACK原子authority及旧Broker started writer cutover。
- `creator-agent-failed-fact-admission-migration.test.ts` 静态核对`0027`的confirmed failed zero-legacy门、三组DB JCS recipe、global source/terminal classifier、FAILED/Event/Consumer Outbox/stream/永久receipt/Conversation原子链、retention proof、generic succeeded binding及旧failed writer cutover。真实角色、并发、prune replay、failpoint和Gateway security isolation仍由对应PostgreSQL suite证明。
- `creator-agent-success-fact-admission-migration.test.ts` 静态核对`0028`的success zero-legacy门、三组DB JCS recipe、18参preflight/14参finalize、same-transaction seal intent、full terminal chain、per-owner writer cutover、deferred companions与failed v2升级。真实KMS、Cloud时钟、跨Consumer、并发、retention replay、rollback及ACK-loss仍由Cloud/Gateway PostgreSQL suite证明。
- `creator-agent-gateway-migration.test.ts` 静态核对 `0015` 的 Challenge/Session/sequence/receipt、安全事件、Lease grant correlation、RLS 与最窄 Gateway authority。
- `creator-agent-broker-delivery-contract-migration.test.ts` 静态核对 `0018` 的事务锁与 zero-live `55000` 门、Broker payload v1、原始 assignment/current delivery 双 authority、跨 Session 稳定 business `messageId`、create-open-v2 与 KMS HMAC metadata 边界。
- `creator-agent-broker-delivery-contract.pg.test.ts` 在 child PostgreSQL 逐类证明 PENDING/SENT Outbox、非终态 business delivery、ACTIVE Session、ACTIVE Lease 任一存在都会整事务回滚；清空四类 live authority 后验证 0017→0018 upgrade、v0 business 不可 claim、Broker exact v0 `lease.revoke` control 的持久化/全局 messageId/immutable 边界、v2/RLS role 与 reconnect delivery 约束。
- `creator-hosted-agent-vnext.pg.test.ts` 只在显式独立 PostgreSQL 门开启时，以三份真实 VNext 服务角色登录，验证 transaction-local RLS 不泄漏、跨租户外键、不可变 Version/Event、精确 Lease fence、单 WIP 和 Event 序号。
- `provision-app-roles.test.ts` 核对旧服务与 VNext 服务的角色密码必须分别完整成组提供，并确认密码只作为绑定值传给 PostgreSQL，不出现在 SQL 模板或错误中。
- `creator-agent-consumer-upgrade.pg.test.ts` 在 child database 真实执行 0012→0013→0014→0015，验证历史 active/terminal Conversation 不被改写，并建立 open/ready 与 Gateway authority。

真实 PostgreSQL 的迁移执行、重复运行和非空门禁由 `scripts/integration/db-migrate.sh` 负责。应用角色测试还会核对充值与使用计费隔离和资金流水只追加；Consumer authority gate 使用独立 `POSTGRES_AGENT_CONSUMER_API_PASSWORD`。Gateway authority gate 只有在 CI 显式置位 `CREATOR_AGENT_GATEWAY_PG_TEST=1` 并提供 API/Broker 角色密码时才运行真实 PostgreSQL；两者都由 workflow contract 防止退化为 skip。
