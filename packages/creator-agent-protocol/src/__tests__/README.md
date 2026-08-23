# Tests

`host-contract.test.ts` 锁定 canonical fingerprint、完整 Host thread、名义 ID、单一原子
outcome、跨 handle 拒绝、first-sent interrupt lineage、generation/turn binding 和
`CreatorHost` 的结构兼容。

测试只使用内存 fake，证明的是协议合同，不是真实 Codex Host、IPC 写入或并发 adapter
实现的集成证据。

`broker-transport.test.ts` 锁定 65536 UTF-8 byte 上限、exact canonical JSON、四类 body 的
方向与 sequence、语义身份以及完整 wire 身份。它不证明 SQLite、WebSocket 或 Cloud ACK。

`agent-contract.test.ts` 锁定 V1 Definition、Draft、handoff 与 immutable Version 的原有 canonical bytes，
也锁定 V2 Project source ledger、Definition、Draft、handoff 与 Version 的 canonical round-trip 和 protocol
dispatcher。测试会篡改 cited source 的执行可用性以确认 ledger 进入下游 fingerprint，并继续覆盖深冻结、
严格字段和当前本机只读 Runtime profile。它不证明 Project 已被扫描、模型理解了每个字节、Agent 已发布
或 Agent 已执行。
