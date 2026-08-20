<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-024: External Alpha 要求每 Conversation OS/VM 隔离

- Status: accepted
- Owner: Runtime/Sandbox
- Decision date: 2026-08-13
- Architecture decision: D004 — External Alpha 要求每 Conversation OS/VM 隔离

## Decision

每个 AgentVersion 共享不可变 Context image；每个 Conversation 独占 Sandbox、Codex thread、scratch 和 tmp，实例只在活跃期存在。Sandbox 不得挂载 Creator HOME、活 Project、其他 Project、长期凭据或其他 Conversation state；External Alpha 禁止 Native macOS 运行路径。

## Alternatives considered

- 每 Agent 共享 VM；拒绝，因为不同消费者会共享进程、scratch 和潜在残留。
- 每 Turn 新 VM；拒绝，因为会破坏多轮并增加冷启动和恢复复杂度。

## Evidence

- creator-hosted-agent-vnext-architecture.md §2.2
- creator-hosted-agent-vnext-architecture.md §7.1-7.5
- creator-hosted-agent-vnext-architecture.md §22.2

## Privacy and security impact

OS/VM 边界强制阻断 Prompt 读取 Snapshot 外的 Creator 文件、长期凭据和其他会话；软件 Attestation 不能被描述成硬件远程证明。

## Reversal triggers

- 替换 Sandbox adapter 前必须通过同一真实 Isolation Gate；安全 Gate 失败不得回退 Native unisolated Runtime。

## Affected protocol versions

- combo.sandbox-spec/1
- combo.sandbox-attestation/1
