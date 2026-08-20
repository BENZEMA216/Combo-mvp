# Creator-hosted Agent VNext

本目录冻结 Creator-hosted Agent VNext 的技术方案和测试方案，供实现、代码审查和验收共同引用。

接管期间的来源边界、已证明/未证明状态、阻断项与恢复 tranche 记录在 `recovery-ledger-2026-08-20.md`。该账本是工程取证记录，不替代下列权威文档、机器 registry 或正式 Evidence Bundle。

## 权威文档

- `creator-hosted-agent-vnext-architecture.md`
  - 来源 SHA-256：`523b4637733b505570d091633f5aecca979c6ca3b344f1dcaec2c0f6487c09b8`
  - 状态：Proposed Architecture（待评审）
- `creator-hosted-agent-vnext-test-plan.md`
  - 来源 SHA-256：`b548c9d9d05fa912de19e4cde053222ea08fdb04f326f368bf12ade614be9404`
  - 状态：Reviewed Test Architecture（实现待落地）

两份文件从 2026-08-12 的本地设计产物逐字复制，并作为不可原地改写的冻结镜像。后续实现细化必须进入 `adr/`、machine-readable registry 或组件文档，不得直接改写镜像；只有权威设计产物经明确评审替换时，才同步更新镜像与本页 SHA-256。实现 PR 必须引用受影响的不变量、测试 ID 和发布 Gate。

## 实施顺序

1. Iteration 0：冻结 ADR、六份共享协议、错误码、状态机、fixtures、不变量 registry 和 Evidence Bundle schema。
2. 并行实现 Snapshot/AgentVersion、隔离 Runtime、Cloud Broker、Worker Journal、产品 UX 与 SRE/Security Harness。
3. 按 Fake 对端、真实 Linux Codex、真实 Sandbox、Test Broker、Creator/Consumer E2E、Fault/Isolation/DR 的顺序集成。
4. 只有 Gate 0 至 Gate 8 全部通过且没有 P0/P1 blocker，才可声明邀请制 Test Alpha 完成。

## 证据边界

云端 CI 可以证明 Schema、单元、属性、集成和部分 Cloud Broker 行为，但不能替代以下真实环境证据：

- Apple Silicon/macOS 26 上的 Apple Container 或 Lima 隔离实验；
- exact Linux arm64 Codex 和真实模型；
- 家庭 NAT 后的 Creator Worker 与第二网络消费者；
- 24 小时 Soak、告警和异机 PostgreSQL/MinIO/KEK 恢复。

缺少必需环境时，相关 Gate 状态必须是 `BLOCKED`，不能写成 `PASS`。
