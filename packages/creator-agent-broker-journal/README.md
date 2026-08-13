# @cb/creator-agent-broker-journal

这个包实现 Creator-hosted Agent VNext 的 Broker、Lease/Fence、云端 Invocation Journal、Worker 本地 Journal、Outbox、对账决策和故障注入参考内核。它用于在接入真实服务前冻结可执行语义，并为 Track C 和 Track D 提供同一组确定性测试。

当前存储适配器是明确标注的内存参考实现。`InMemoryCloudJournal` 模拟 PostgreSQL 事务、唯一约束和事务 Outbox，`InMemoryWorkerJournal` 模拟 SQLite 单写者、事务 Journal 和本地 Outbox。它们提供 E1 级状态机与契约证据，不证明真实 PostgreSQL 的隔离级别、SQLite 的 WAL 与 `fsync`、WebSocket 送达、Redis 重建或跨进程崩溃恢复；这些能力仍需后续 E2、E3 和 E6 集成 Gate。

## 协议迁移边界

本包包含一份最小 `combo.creator-broker/1` 临时定义，只覆盖本 Track 执行测试需要的 Envelope、sequence 和 fence 字段。共享 Contract Track 合入正式 schema 后，应把 `src/protocol.ts` 的边界解析迁移到权威协议包；Reducer 和 Journal 不应复制正式 schema。临时定义不会从 `@cb/shared` 导出，避免与协议冻结工作争用同一文件。

## 文件

- `package.json` 定义独立构建、类型检查、普通测试、property 测试和 fault 测试入口。
- `tsconfig.json` 与 `tsconfig.vitest.json` 分别检查生产源码和测试源码。
- `vitest.config.ts` 配置 Node 测试环境。
- `src/` 保存协议、状态机、双 Journal、对账和故障注入实现，具体职责记录在 `src/README.md`。

## 验证

运行 `pnpm -F @cb/creator-agent-broker-journal test` 执行全部测试。运行 `pnpm -F @cb/creator-agent-broker-journal test:property` 单独重放固定 property seeds，运行 `pnpm -F @cb/creator-agent-broker-journal test:fault` 单独执行二十个正式 failpoint 场景。
