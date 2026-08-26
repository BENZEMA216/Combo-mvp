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

`agent-package-contract.test.ts` 锁定独立 `combo.agent-package/1` 的规范 `agent.json`、原始文件摘要、
内容寻址智能体包摘要、完整排序文件清单、技能路径、深度冻结，以及属性读取器、代理对象、非规范 JSON
和旧版版本对象混用的拒绝。该文件也锁定一句制作要求、无绝对路径的 Package Draft、revision 父链、乐观
并发基线、domain-separated fingerprint、规范往返和篡改拒绝。它不读取真实智能体包目录，也不证明
Studio 已展示、Package 已编译或 Codex 已激活技能。

`agent-package-release-contract.test.ts` 锁定 `combo.agent-package-release/1` 的 exact Release ID、Package
digest、规范 JSON、深冻结、严格字段，以及属性读取器、代理对象和旧版 AgentVersion 混用的拒绝。它不
证明 Registry 已持久化 Package、分享入口已解析或 Receiver 已加载 Release。
