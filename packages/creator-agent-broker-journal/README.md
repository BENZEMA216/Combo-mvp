# @cb/creator-agent-broker-journal

这个包实现 Creator-hosted Agent VNext 的 Broker、Lease/Fence、云端 Invocation Journal、Worker 本地 Journal、Outbox、对账决策和 fault model 参考内核。它用于在接入真实服务前冻结可执行语义，并为 Track C 和 Track D 提供同一组确定性 E1 测试。

Cloud/Worker Journal 和 side-effect recording adapters 都是明确标注的 Mock/内存参考实现。`InMemoryCloudJournal` 模拟 PostgreSQL 事务、唯一约束和事务 Outbox，`InMemoryWorkerJournal` 模拟 SQLite 单写者、事务 Journal 和本地 Outbox。它们提供 E1 级状态机与事务接口证据，不证明真实 PostgreSQL 的隔离级别、Worker SQLite 的 WAL 与 `fsync`、WebSocket 送达、Redis 重建、Provider 调用或跨进程崩溃恢复；这些能力仍需后续 E2、E3 和 E6 集成 Gate。

Cloud 与 Worker 都使用 `@cb/creator-agent-protocol` 的正式 P-256/ES256 Execution Capability verifier；one-use reducer 只位于 Provider dispatch Gate。Journal 不接收 caller 提供的 `executionCapabilityValid` 布尔值，也不信任 caller 提供的 capability digest；它们从已签名 full-wire capability 重新计算 digest，并精确绑定 Invocation、Conversation、Deployment、AgentVersion、Worker Installation、Lease/Fence、Provider Request、request digest、model、reasoning effort、budget、有效期和 nonce。Provider dispatch 对外只暴露组合后的 `SqliteVerifiedExecutionCapabilityGate`：它先验签并核对完整绑定，再用 `BEGIN IMMEDIATE`、WAL 和 `synchronous=FULL` 在返回 `DISPATCH_ONCE` 前原子提交 one-use row。底层 verifier/CAS half 不从 package entrypoint 暴露；这是真实 SQLite 持久化证据，但尚不是 Provider/WSS 的 E2 集成证据。

## 协议迁移边界

`src/protocol.ts` 直接调用 `@cb/creator-agent-protocol` 的 `parseBrokerFrame` 作为唯一 Envelope parser；本包只保留 sequence cursor、ACK fact、Lease/Fence 等执行语义。真实 WSS ingress 必须沿用同一权威 parser，不能复制或放宽 wire contract。

## 文件

- `package.json` 定义独立构建、类型检查、普通测试、property 测试和 fault 测试入口。
- `tsconfig.json` 与 `tsconfig.vitest.json` 分别检查生产源码和测试源码。
- `vitest.config.ts` 配置 Node 测试环境。
- `src/` 保存协议、状态机、双 Journal、对账和 fault model，具体职责记录在 `src/README.md`。

## 验证

运行 `pnpm -F @cb/creator-agent-broker-journal test` 执行全部测试。运行 `pnpm -F @cb/creator-agent-broker-journal test:property` 单独重放固定 property seeds；运行 `pnpm -F @cb/creator-agent-broker-journal test:fault-model` 只执行 E1 fault model。Cloud、Worker 与 ACK ledger 的容量针对 active backlog；终态 durable ACK/outbox 使用云端时间归档并精确保留 7 天，期内 exact replay 可查，水位到期后才由 `pruneExpiredArchive` 删除并回到 Cloud terminal/Worker terminal 权威投影。测试连续完成、归档、重放并到期清理 1,001 个 Invocation；这证明 active outbox 不被历史终态假性占满，不代表其余 Journal 实体已经实现完整 retention。

二十个正式 failpoint 在 registry 中完整分类，但当前只有九个执行了真实的内存状态序列化、实例丢弃与重建；八个只有 reducer/model 证据，Redis、Gateway rolling restart 和 VM cleanup 三项明确 `BLOCKED_E2_E6`。因此本包不能声称 Gate 4 或“二十个 crash recovery 已通过”。
