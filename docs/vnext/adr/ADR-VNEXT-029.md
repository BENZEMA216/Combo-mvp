<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->

# ADR-VNEXT-029: Model 和 reasoning effort 固定在 AgentVersion

- Status: accepted
- Owner: Snapshot/Version
- Decision date: 2026-08-13
- Architecture decision: D009 — Model 和 reasoning effort 固定在 AgentVersion

## Decision

ModelPolicy 是 AgentVersion 的不可变组成，model 和 reasoning effort 均 pinned-by-version，并与 RuntimePolicy 的 resolvedModel/reasoningEffort 一致。模型或 effort 任一变化都会改变 versionDigest 并创建新 AgentVersion；Deployment 更新只影响新 Conversation。

## Alternatives considered

- 在不创建新 Version 的情况下动态切换 model 或 effort；拒绝，因为会改变费用和推理语义却保留旧执行身份。

## Evidence

- creator-hosted-agent-vnext-architecture.md §0.3
- creator-hosted-agent-vnext-architecture.md §4.1-4.3
- creator-hosted-agent-vnext-architecture.md §15.3

## Privacy and security impact

固定 model/effort 防止静默模型替换、费用漂移和同一 Version 下不可审计的语义变化；Capability 仍须绑定同一模型与预算。

## Reversal triggers

- 若产品引入动态模型路由，必须定义新的版本身份、消费者披露、费用和可复现性契约。

## Affected protocol versions

- combo.agent-version-manifest/1
- combo.execution-capability/1
