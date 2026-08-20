<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-009: Sandbox TTL rebuilds from visible transcript only

- Status: accepted
- Owner: Runtime/Sandbox
- Decision date: 2026-08-13

## Decision

Sandbox 空闲 10 分钟销毁 VM、thread 和 scratch；下一条消息创建全新 Sandbox，只从固定 AgentVersion、BehaviorContract、只读 Snapshot 与云端消费者可见 transcript 重建。Alpha 不持久化 state volume，不恢复 hidden reasoning，也不声称与旧 thread 内部状态逐字等价。

## Alternatives considered

- Conversation state volume 跨 VM 复用；拒绝，尚未证明隔离、清理和版本绑定。
- 永久在线 Sandbox；拒绝，资源与跨会话攻击面过大。

## Evidence

- SandboxSpec/1 lifecycle schema
- creator-hosted-agent-vnext-architecture.md §7.4

## Privacy and security impact

销毁后不保留消费者 scratch/hidden state；rebuild 仍须新 Attestation 与 active-instance binding。

## Reversal triggers

- 固定 Codex 提供版本化 resume artifact，且 state volume 通过 isolation/retention/backup Gate。

## Affected protocol versions

- combo.sandbox-spec/1
- combo.sandbox-attestation/1
- combo.agent-version-manifest/1
