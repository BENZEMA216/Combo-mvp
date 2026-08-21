# Tests

`host-contract.test.ts` 锁定 canonical fingerprint、完整 Host thread、名义 ID、单一原子
outcome、跨 handle 拒绝、first-sent interrupt lineage、generation/turn binding 和
`CreatorHost` 的结构兼容。

测试只使用内存 fake，证明的是协议合同，不是真实 Codex Host、IPC 写入或并发 adapter
实现的集成证据。
