# Tests

`host-contract.test.ts` 锁定 canonical fingerprint、完整 Host thread、名义 ID、单一原子
outcome、跨 handle 拒绝、first-sent interrupt lineage、generation/turn binding 和
`CreatorHost` 的结构兼容。

测试只使用内存 fake，证明的是协议合同，不是真实 Codex Host、IPC 写入或并发 adapter
实现的集成证据。

`creator-authorization-contract.test.ts` 锁定 `combo.creator-authorization/1` 的严格 path-free claims、
最长五分钟、exact thread/turn/item/Project/request/executor 绑定、Draft-only scope、same-UID 隔离披露和
固定错误分类；它也证明公开子路径不导出 mint、handle、consume 或私有 Project authority。该测试只验证
授权卡语义，不证明 Codex Desktop 已显示卡片、用户完成点击、Host ledger 原子消费或 authenticated IPC。

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
并发基线、Creator bootstrap handoff、domain-separated fingerprint、规范往返和篡改拒绝。handoff 测试
会拒绝网页地址、Project 路径、任务标识、额外字段、属性读取器和代理对象。该文件不读取真实智能体包目录，
也锁定 Project request/Draft V1 的 exact request digest 与 fingerprint 不漂移，以及并列
current-conversation request/Draft V2 的 strict path-free 来源、互斥解析、独立 fingerprint 和 revision。
V2 测试拒绝调用方 task/thread/session/item ID、Project 字段、消息数组和 raw transcript；它只证明协议字段
与规范字节，不证明 Desktop active-task 来源、Studio 展示、Package 编译或 Codex 已激活技能。

`agent-package-release-contract.test.ts` 锁定 `combo.agent-package-release/1` 的 exact Release ID、Package
digest、规范 JSON、深冻结、严格字段，以及属性读取器、代理对象和旧版 AgentVersion 混用的拒绝。它不
证明 Registry 已持久化 Package、分享入口已解析或 Receiver 已加载 Release。

`agent-package-capability-contract.test.ts` 锁定 `combo.agent-package-capability/2` 只携带一个 exact
Release、没有复制行为/知识/工具/价格，且 hostile getter/Proxy、V1 和非规范 JSON 都 fail closed。它只
证明迁移合同；不证明 Registry、Runtime 滚动升级、Session 冻结或知识问答已经实现。

`desktop-current-conversation-receipt.test.ts` 锁定真实 UAT 收据的 exact candidate/version、脱敏 task binding、
egress candidate/projection/final Draft fingerprint、事件 hash chain、Host 单权威端到端观测和绑定
protocol/algorithm/issuer/key ID 的 Ed25519 signature message。测试使用临时 Test key，
不证明 Codex Desktop 已签发真实收据，也不能把泛型 Draft 卡片升级为 Host evidence。
