<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-021: 推理运行在 Creator Codex，Combo 不运行 Creator Runtime

- Status: accepted
- Owner: Runtime/Sandbox
- Decision date: 2026-08-13
- Architecture decision: D001 — 推理运行在 Creator Codex，Combo 不运行 Creator Runtime

## Decision

消费者消息由 Combo Broker 转发到 Creator Mac；Creator Worker 在每个 Conversation 独占的隔离环境中运行固定 Codex app-server，真正的模型推理由 OpenAI 模型服务完成。Combo 云负责身份、AgentVersion、Snapshot、Broker、Journal 和聊天记录，不运行 Creator 的 Codex Runtime。

## Alternatives considered

- Combo 自建云端 Creator Runtime；拒绝，因为本版本产品定义是 Creator-hosted，Cloud K3s Sandbox 明确不采用。
- 把 Creator Worker 绑定在某个 Codex 对话内；拒绝，因为 Worker 是独立本地守护进程。

## Evidence

- creator-hosted-agent-vnext-architecture.md §0.1-0.4
- creator-hosted-agent-vnext-architecture.md §3

## Privacy and security impact

Creator Mac 不开放公网入站；Combo 云不能被描述成 Creator Runtime，Creator-hosted 也不等于 24×7 托管服务。

## Reversal triggers

- 产品明确转向 managed runtime 时，重新评审运行位置、凭据、隔离、费用和 SLA，不能沿用本 ADR 宣称等价。

## Affected protocol versions

- combo.agent-version-manifest/1
- combo.creator-broker/1
- combo.sandbox-spec/1
